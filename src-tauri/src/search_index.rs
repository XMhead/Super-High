use std::{borrow::Cow, collections::{BTreeMap, BTreeSet, HashMap, VecDeque}, path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicUsize, Ordering}}};
use anyhow::Context;
use rusqlite::{Connection, params};
use crate::models::ProjectFileMatch;

pub(super) const CACHE_BUDGET: usize = 256 * 1024 * 1024;
static RESIDENT_BYTES: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
struct Lease(usize);

impl Lease {
    fn grow(&mut self, bytes: usize, limit: usize) -> bool {
        let mut used = RESIDENT_BYTES.load(Ordering::Acquire);
        loop {
            let Some(next) = used.checked_add(bytes).filter(|next| *next <= limit) else { return false; };
            match RESIDENT_BYTES.compare_exchange_weak(used, next, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => break,
                Err(current) => used = current,
            }
        }
        self.0 += bytes;
        true
    }

    fn shrink(&mut self, bytes: usize) {
        self.0 -= bytes;
        RESIDENT_BYTES.fetch_sub(bytes, Ordering::AcqRel);
    }
}

impl Drop for Lease {
    fn drop(&mut self) { RESIDENT_BYTES.fetch_sub(self.0, Ordering::AcqRel); }
}

pub(super) fn resident_bytes() -> usize { RESIDENT_BYTES.load(Ordering::Acquire) }

struct Directory {
    original: Box<str>,
    folded: Option<Box<str>>,
}

#[derive(Clone, Copy)]
pub(super) struct Record {
    modified: u64,
    directory: u32,
    start: u32,
    len: u32,
    folded_start: u32,
    folded_len: u32,
}

pub(super) struct PackedFiles {
    root: String,
    text: String,
    records: Vec<Record>,
    directories: Vec<Directory>,
    lease: Lease,
}

impl PackedFiles {
    fn name(&self, row: &Record, folded: bool) -> &str {
        let (start, len) = if folded { (row.folded_start, row.folded_len) } else { (row.start, row.len) };
        &self.text[start as usize..(start + len) as usize]
    }

    fn directory(&self, row: &Record, folded: bool) -> &str {
        let dir = &self.directories[row.directory as usize];
        if folded { dir.folded.as_deref().unwrap_or(&dir.original) } else { &dir.original }
    }

    fn key_bytes<'a>(&'a self, row: &'a Record) -> impl Iterator<Item = u8> + 'a {
        let folded = cfg!(windows);
        let directory = self.directory(row, folded);
        directory.bytes().chain((!directory.is_empty()).then_some(b'/')).chain(self.name(row, folded).bytes())
    }

    fn relative(&self, row: &Record, folded: bool) -> String {
        let dir = self.directory(row, folded);
        if dir.is_empty() { self.name(row, folded).to_owned() } else { format!("{dir}/{}", self.name(row, folded)) }
    }

    fn result(&self, row: &Record) -> ProjectFileMatch {
        let relative_path = self.relative(row, false);
        ProjectFileMatch {
            path: format!("{}{relative_path}", self.root), relative_path,
            name: self.name(row, false).to_owned(), modified: (row.modified != u64::MAX).then_some(row.modified),
        }
    }

    fn find(&self, key: &str) -> Option<&Record> {
        self.records.binary_search_by(|row| self.key_bytes(row).cmp(key.bytes())).ok().map(|at| &self.records[at])
    }
}

struct PackedBuilder {
    files: PackedFiles,
    directories: HashMap<String, u32>,
    lookup_bytes: usize,
    limit: usize,
}

impl PackedBuilder {
    fn new(root: &Path, limit: usize) -> Self {
        let mut root = super::normalize_path(root);
        if !root.ends_with('/') { root.push('/'); }
        Self { files: PackedFiles { root, text: String::new(), records: Vec::new(), directories: Vec::new(), lease: Lease::default() }, directories: HashMap::new(), lookup_bytes: 0, limit }
    }

    fn push(&mut self, file: &ProjectFileMatch) -> bool {
        let (directory, name) = file.relative_path.rsplit_once('/').unwrap_or(("", &file.relative_path));
        let folded_directory = directory.to_lowercase();
        let key = if cfg!(windows) { folded_directory.as_str() } else { directory };
        let directory_id = if let Some(id) = self.directories.get(key) { *id } else {
            let bytes = directory.len() + folded_directory.len() + key.len() + 128;
            if !self.files.lease.grow(bytes, self.limit) { return false; }
            self.lookup_bytes += key.len() + 64;
            let id = self.files.directories.len() as u32;
            self.files.directories.push(Directory { original: directory.into(), folded: (folded_directory != directory).then(|| folded_directory.clone().into_boxed_str()) });
            self.directories.insert(key.to_owned(), id);
            id
        };
        let folded = name.to_lowercase();
        let added = name.len() + if folded != name { folded.len() } else { 0 };
        if self.files.text.len().checked_add(added).is_none_or(|len| len > u32::MAX as usize) { return false; }
        let text_capacity = self.files.text.capacity();
        let text_growth = if text_capacity - self.files.text.len() < added { added.max(1024 * 1024) } else { 0 };
        let row_growth = if self.files.records.len() == self.files.records.capacity() { 4096 * std::mem::size_of::<Record>() } else { 0 };
        if !self.files.lease.grow(text_growth + row_growth, self.limit) { return false; }
        if text_growth > 0 { self.files.text.reserve_exact(text_capacity + text_growth - self.files.text.len()); }
        if row_growth > 0 { self.files.records.reserve_exact(4096); }
        let start = self.files.text.len() as u32;
        self.files.text.push_str(name);
        let folded_start = if folded == name { start } else {
            let offset = self.files.text.len() as u32;
            self.files.text.push_str(&folded);
            offset
        };
        self.files.records.push(Record { directory: directory_id, start, len: name.len() as u32, folded_start, folded_len: folded.len() as u32, modified: file.modified.unwrap_or(u64::MAX) });
        true
    }

    fn finish(mut self) -> Arc<PackedFiles> {
        self.files.records.sort_unstable_by(|left, right| {
            let directories = &self.files.directories;
            let text = &self.files.text;
            let bytes = |row: &Record| {
                let dir = &directories[row.directory as usize];
                let dir = if cfg!(windows) { dir.folded.as_deref().unwrap_or(&dir.original) } else { &dir.original };
                let (start, len) = if cfg!(windows) { (row.folded_start, row.folded_len) } else { (row.start, row.len) };
                dir.bytes().chain((!dir.is_empty()).then_some(b'/')).chain(text[start as usize..(start + len) as usize].bytes())
            };
            bytes(left).cmp(bytes(right))
        });
        self.files.lease.shrink(self.lookup_bytes);
        Arc::new(self.files)
    }
}

struct DiskFiles {
    file: tempfile::NamedTempFile,
    root: String,
}

fn disk_connection(path: &Path) -> anyhow::Result<Connection> {
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    connection.execute_batch("PRAGMA cache_size=-512; PRAGMA temp_store=FILE;")?;
    Ok(connection)
}

struct DiskBuilder {
    connection: Connection,
    files: DiskFiles,
}

impl DiskBuilder {
    fn new(root: &Path) -> anyhow::Result<Self> {
        let folder = root.join(".superhigh/cache/file-search");
        std::fs::create_dir_all(&folder).context("无法创建文件搜索缓存目录")?;
        #[cfg(windows)]
        let prefix = {
            let identity = crate::service_console::current_identity()?;
            for entry in std::fs::read_dir(&folder)?.filter_map(Result::ok) {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue; };
                let parts: Vec<_> = name.split('-').collect();
                if parts.len() != 4 || parts[0] != "index" || !name.ends_with(".sqlite") || !entry.file_type()?.is_file() { continue; }
                let (Ok(pid), Ok(created)) = (parts[1].parse(), parts[2].parse()) else { continue; };
                if !crate::service_console::process_matches(crate::service_console::ProcessIdentity { pid, created }) { let _ = std::fs::remove_file(entry.path()); }
            }
            format!("index-{}-{}-", identity.pid, identity.created)
        };
        #[cfg(not(windows))]
        let prefix = format!("index-{}-", std::process::id());
        let file = tempfile::Builder::new().prefix(&prefix).suffix(".sqlite").tempfile_in(&folder)?;
        let connection = Connection::open(file.path())?;
        connection.execute_batch("PRAGMA cache_size=-512; PRAGMA temp_store=FILE; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE files (key TEXT PRIMARY KEY, relative TEXT NOT NULL, modified INTEGER) WITHOUT ROWID; BEGIN;")?;
        let mut root = super::normalize_path(root);
        if !root.ends_with('/') { root.push('/'); }
        Ok(Self { connection, files: DiskFiles { file, root } })
    }

    fn push(&self, file: &ProjectFileMatch) -> anyhow::Result<()> {
        let key = relative_key(&file.relative_path);
        self.connection.prepare_cached("INSERT OR REPLACE INTO files(key, relative, modified) VALUES (?1, ?2, ?3)")?.execute(params![key, file.relative_path, file.modified])?;
        Ok(())
    }

    fn finish(self) -> anyhow::Result<Arc<DiskFiles>> {
        self.connection.execute_batch("COMMIT;")?;
        drop(self.connection);
        Ok(Arc::new(self.files))
    }
}

pub(super) struct IndexBuilder {
    root: PathBuf,
    packed: Option<PackedBuilder>,
    disk: Option<DiskBuilder>,
}

impl IndexBuilder {
    pub(super) fn new(root: &Path) -> Self { Self::with_limit(root, CACHE_BUDGET) }

    fn with_limit(root: &Path, limit: usize) -> Self {
        Self { root: root.to_path_buf(), packed: Some(PackedBuilder::new(root, limit)), disk: None }
    }

    pub(super) fn push(&mut self, file: &ProjectFileMatch) -> anyhow::Result<()> {
        if let Some(packed) = &mut self.packed {
            if packed.push(file) { return Ok(()); }
            let disk = DiskBuilder::new(&self.root)?;
            let packed = self.packed.take().unwrap();
            for row in &packed.files.records { disk.push(&packed.files.result(row))?; }
            self.disk = Some(disk);
        }
        self.disk.as_ref().unwrap().push(file)
    }

    pub(super) fn finish(self) -> anyhow::Result<SearchFileEntries> {
        let storage = if let Some(packed) = self.packed { Storage::Packed(packed.finish()) } else { Storage::Disk(self.disk.unwrap().finish()?) };
        Ok(SearchFileEntries { storage, delta: BTreeMap::new(), removed_branches: BTreeSet::new(), delta_bytes: 0, delta_lease: Arc::new(Lease::default()), snapshot: None })
    }
}

#[derive(Clone)]
enum Storage {
    Packed(Arc<PackedFiles>),
    Disk(Arc<DiskFiles>),
}

impl Storage {
    fn root(&self) -> &str { match self { Self::Packed(files) => &files.root, Self::Disk(files) => &files.root } }
}

pub(super) struct SearchFileEntries {
    storage: Storage,
    delta: BTreeMap<String, Option<ProjectFileMatch>>,
    removed_branches: BTreeSet<String>,
    delta_bytes: usize,
    delta_lease: Arc<Lease>,
    pub(super) snapshot: Option<Arc<SearchSnapshot>>,
}

pub(super) struct SearchSnapshot {
    storage: Storage,
    delta: BTreeMap<String, Option<ProjectFileMatch>>,
    removed_branches: BTreeSet<String>,
    _lease: Arc<Lease>,
}

pub(super) enum SearchFile<'a> {
    Packed(&'a PackedFiles, &'a Record),
    Borrowed(&'a ProjectFileMatch),
    Owned(ProjectFileMatch),
}

pub(super) fn relative_key(relative: &str) -> String {
    if cfg!(windows) { relative.to_lowercase() } else { relative.to_owned() }
}

impl SearchFile<'_> {
    pub(super) fn result(&self) -> ProjectFileMatch {
        match self { Self::Packed(files, row) => files.result(row), Self::Borrowed(file) => (*file).clone(), Self::Owned(file) => file.clone() }
    }

    pub(super) fn name(&self) -> &str {
        match self { Self::Packed(files, row) => files.name(row, false), Self::Borrowed(file) => &file.name, Self::Owned(file) => &file.name }
    }

    pub(super) fn folded_name(&self) -> Cow<'_, str> {
        match self { Self::Packed(files, row) => Cow::Borrowed(files.name(row, true)), _ => Cow::Owned(self.name().to_lowercase()) }
    }

    pub(super) fn folded_relative(&self) -> String {
        match self { Self::Packed(files, row) => files.relative(row, true), Self::Borrowed(file) => file.relative_path.to_lowercase(), Self::Owned(file) => file.relative_path.to_lowercase() }
    }

    fn compare_key(&self, key: &str) -> std::cmp::Ordering {
        match self {
            Self::Packed(files, row) => files.key_bytes(row).cmp(key.bytes()),
            Self::Borrowed(file) => relative_key(&file.relative_path).as_str().cmp(key),
            Self::Owned(file) => relative_key(&file.relative_path).as_str().cmp(key),
        }
    }

    fn under_branch(&self, branch: &str) -> bool {
        fn matches(mut bytes: impl Iterator<Item = u8>, branch: &str) -> bool {
            if !branch.bytes().all(|byte| bytes.next() == Some(byte)) { return false; }
            matches!(bytes.next(), None | Some(b'/'))
        }
        match self {
            Self::Packed(files, row) => matches(files.key_bytes(row), branch),
            Self::Borrowed(file) => matches(relative_key(&file.relative_path).bytes(), branch),
            Self::Owned(file) => matches(relative_key(&file.relative_path).bytes(), branch),
        }
    }
}

impl SearchFileEntries {
    pub(super) fn snapshot(&mut self) -> Arc<SearchSnapshot> {
        Arc::clone(self.snapshot.get_or_insert_with(|| Arc::new(SearchSnapshot { storage: self.storage.clone(), delta: self.delta.clone(), removed_branches: self.removed_branches.clone(), _lease: Arc::clone(&self.delta_lease) })))
    }

    pub(super) fn get(&self, key: &str) -> anyhow::Result<Option<ProjectFileMatch>> {
        if let Some(file) = self.delta.get(key) { return Ok(file.clone()); }
        if self.removed_branches.iter().any(|branch| key == branch || key.strip_prefix(branch).is_some_and(|rest| rest.starts_with('/'))) { return Ok(None); }
        match &self.storage {
            Storage::Packed(files) => Ok(files.find(key).map(|row| files.result(row))),
            Storage::Disk(files) => {
                let connection = disk_connection(files.file.path())?;
                let mut statement = connection.prepare("SELECT relative, modified FROM files WHERE key=?1")?;
                let mut rows = statement.query([key])?;
                Ok(rows.next()?.map(|row| disk_result(&files.root, row)).transpose()?)
            }
        }
    }

    fn delta_row_bytes(key: &str, file: &Option<ProjectFileMatch>) -> usize {
        key.len() + 160 + file.as_ref().map_or(0, |file| file.path.len() + file.relative_path.len() + file.name.len())
    }

    fn reserve_delta(&mut self, bytes: usize) -> bool {
        self.snapshot = None;
        if let Some(lease) = Arc::get_mut(&mut self.delta_lease) {
            let next = bytes * 2;
            if next < lease.0 { lease.shrink(lease.0 - next); }
            else if !lease.grow(next - lease.0, CACHE_BUDGET) { return false; }
        } else {
            let mut lease = Lease::default();
            if !lease.grow(bytes * 2, CACHE_BUDGET) { return false; }
            self.delta_lease = Arc::new(lease);
        }
        self.delta_bytes = bytes;
        true
    }

    fn rewrite_disk(&mut self, update: Option<(String, Option<ProjectFileMatch>)>, branches: &[String]) -> anyhow::Result<()> {
        let root = PathBuf::from(self.storage.root());
        let snapshot = self.snapshot();
        let builder = DiskBuilder::new(&root)?;
        for file in snapshot.iter()? {
            let file = file?;
            if branches.iter().any(|branch| file.under_branch(branch)) { continue; }
            if update.as_ref().is_some_and(|(key, _)| file.compare_key(key).is_eq()) { continue; }
            builder.push(&file.result())?;
        }
        if let Some((_, Some(file))) = update { builder.push(&file)?; }
        self.storage = Storage::Disk(builder.finish()?);
        self.delta.clear();
        self.removed_branches.clear();
        self.snapshot = None;
        self.delta_bytes = 0;
        self.delta_lease = Arc::new(Lease::default());
        Ok(())
    }

    pub(super) fn update(&mut self, key: String, file: Option<ProjectFileMatch>) -> anyhow::Result<()> {
        let old = self.delta.get(&key).map_or(0, |file| Self::delta_row_bytes(&key, file));
        let next = self.delta_bytes - old + Self::delta_row_bytes(&key, &file);
        if !self.reserve_delta(next) { return self.rewrite_disk(Some((key, file)), &[]); }
        self.delta.insert(key, file);
        Ok(())
    }

    pub(super) fn remove_branches(&mut self, branches: &[String]) -> anyhow::Result<()> {
        if branches.is_empty() { return Ok(()); }
        let mut directories = Vec::new();
        for branch in branches {
            if self.get(branch)?.is_some() { self.update(branch.clone(), None)?; }
            else { directories.push(branch.clone()); }
        }
        let branches = &directories;
        let extra = branches.iter().filter(|branch| !self.removed_branches.contains(*branch)).map(|branch| branch.len() + 80).sum::<usize>();
        if !self.reserve_delta(self.delta_bytes + extra) { return self.rewrite_disk(None, branches); }
        for branch in branches {
            self.delta.retain(|key, file| {
                let keep = key != branch && !key.strip_prefix(branch).is_some_and(|rest| rest.starts_with('/'));
                if !keep { self.delta_bytes -= Self::delta_row_bytes(key, file); }
                keep
            });
            self.removed_branches.insert(branch.clone());
        }
        self.snapshot = None;
        Ok(())
    }

    pub(super) fn compact(&mut self, root: &Path) -> anyhow::Result<()> {
        if self.delta.len() + self.removed_branches.len() < 4096 { return Ok(()); }
        let snapshot = self.snapshot();
        let mut builder = IndexBuilder::new(root);
        for file in snapshot.iter()? { builder.push(&file?.result())?; }
        *self = builder.finish()?;
        Ok(())
    }

    pub(super) fn spill(&mut self, root: &Path) -> anyhow::Result<()> {
        if matches!(self.storage, Storage::Disk(_)) { return Ok(()); }
        let _ = root;
        self.rewrite_disk(None, &[])
    }

    pub(super) fn memory_bytes(&self) -> usize {
        self.delta_lease.0 + match &self.storage { Storage::Packed(files) => files.lease.0, Storage::Disk(_) => 0 }
    }

    #[cfg(test)]
    pub(super) fn shares_storage(&self, snapshot: &SearchSnapshot) -> bool {
        match (&self.storage, &snapshot.storage) {
            (Storage::Packed(left), Storage::Packed(right)) => Arc::ptr_eq(left, right),
            (Storage::Disk(left), Storage::Disk(right)) => Arc::ptr_eq(left, right),
            _ => false,
        }
    }
}

fn disk_result(root: &str, row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectFileMatch> {
    let relative_path: String = row.get(0)?;
    Ok(ProjectFileMatch { name: relative_path.rsplit('/').next().unwrap_or_default().to_owned(), path: format!("{root}{relative_path}"), relative_path, modified: row.get(1)? })
}

struct DiskIterator<'a> {
    connection: Connection,
    files: &'a DiskFiles,
    after: Option<String>,
    batch: VecDeque<ProjectFileMatch>,
    finished: bool,
}

impl Iterator for DiskIterator<'_> {
    type Item = anyhow::Result<ProjectFileMatch>;
    fn next(&mut self) -> Option<Self::Item> {
        if let Some(file) = self.batch.pop_front() { return Some(Ok(file)); }
        if self.finished { return None; }
        let mut load = || -> anyhow::Result<VecDeque<ProjectFileMatch>> {
            let mut statement = self.connection.prepare("SELECT relative, modified, key FROM files WHERE key>?1 ORDER BY key LIMIT 512")?;
            let mut rows = statement.query([self.after.as_deref().unwrap_or("")])?;
            let mut batch = VecDeque::new();
            while let Some(row) = rows.next()? {
                self.after = Some(row.get(2)?);
                batch.push_back(disk_result(&self.files.root, row)?);
            }
            Ok(batch)
        };
        match load() {
            Ok(batch) => { self.finished = batch.len() < 512; self.batch = batch; self.batch.pop_front().map(Ok) }
            Err(error) => { self.finished = true; Some(Err(error)) }
        }
    }
}

impl SearchSnapshot {
    pub(super) fn iter(&self) -> anyhow::Result<Box<dyn Iterator<Item = anyhow::Result<SearchFile<'_>>> + '_>> {
        let mut original: Box<dyn Iterator<Item = anyhow::Result<SearchFile<'_>>>> = match &self.storage {
            Storage::Packed(files) => Box::new(files.records.iter().map(|row| Ok(SearchFile::Packed(files, row)))),
            Storage::Disk(files) => Box::new(DiskIterator { connection: disk_connection(files.file.path())?, files, after: None, batch: VecDeque::new(), finished: false }.map(|file| file.map(SearchFile::Owned))),
        };
        original = Box::new(original.filter(|file| file.as_ref().map_or(true, |file| !self.removed_branches.iter().any(|branch| file.under_branch(branch)))));
        if self.delta.is_empty() { return Ok(original); }
        let mut base = original.next();
        let mut changes = self.delta.iter().peekable();
        Ok(Box::new(std::iter::from_fn(move || loop {
            if base.as_ref().is_some_and(Result::is_err) { return base.take(); }
            let compare = changes.peek().map(|(key, _)| base.as_ref().and_then(|file| file.as_ref().ok()).map(|file| file.compare_key(key)).unwrap_or(std::cmp::Ordering::Greater));
            let take_delta = compare.is_some_and(|order| order != std::cmp::Ordering::Less);
            if take_delta {
                let (_, value) = changes.next().unwrap();
                if compare == Some(std::cmp::Ordering::Equal) { base = original.next(); }
                if let Some(file) = value { return Some(Ok(SearchFile::Borrowed(file))); }
            } else {
                let result = base.take()?;
                base = original.next();
                return Some(result);
            }
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(root: &Path, relative: &str, modified: Option<u64>) -> ProjectFileMatch {
        ProjectFileMatch { path: super::super::normalize_path(&root.join(relative)), relative_path: relative.into(), name: relative.rsplit('/').next().unwrap().into(), modified }
    }

    fn results(snapshot: &SearchSnapshot) -> Vec<(String, Option<u64>)> {
        snapshot.iter().unwrap().map(|file| { let file = file.unwrap().result(); (file.relative_path, file.modified) }).collect()
    }

    #[test]
    fn packed_and_disk_keep_identical_unicode_paths_metadata_and_order() {
        let root = tempfile::tempdir().unwrap();
        let mut memory = IndexBuilder::new(root.path());
        let mut disk = IndexBuilder::with_limit(root.path(), 0);
        let mut expected = BTreeMap::new();
        for index in (0..1541).rev() {
            let relative = format!("角色İ/剑士/Body-{index:04}.PNG");
            let file = file(root.path(), &relative, (index % 3 != 0).then_some(index));
            expected.insert(relative_key(&relative), (relative, file.modified));
            memory.push(&file).unwrap();
            disk.push(&file).unwrap();
        }
        let mut memory = memory.finish().unwrap();
        let mut disk = disk.finish().unwrap();
        assert!(memory.memory_bytes() > 0);
        assert_eq!(disk.memory_bytes(), 0);
        let expected: Vec<_> = expected.into_values().collect();
        assert_eq!(results(&memory.snapshot()), expected);
        assert_eq!(results(&disk.snapshot()), expected);
        let snapshot = memory.snapshot();
        let first = snapshot.iter().unwrap().next().unwrap().unwrap();
        assert_eq!(first.folded_relative(), expected[0].0.to_lowercase());
        assert_eq!(first.folded_name(), "body-0000.png");
        assert_eq!(disk.get(&relative_key(&expected[777].0)).unwrap().unwrap().relative_path, expected[777].0);
    }

    #[test]
    fn directory_removal_masks_base_and_new_entries_override_the_mask() {
        let root = tempfile::tempdir().unwrap();
        for limit in [CACHE_BUDGET, 0] {
            let mut builder = IndexBuilder::with_limit(root.path(), limit);
            for name in ["folder/old.txt", "folder/other.txt", "folder-other/keep.txt"] { builder.push(&file(root.path(), name, Some(1))).unwrap(); }
            let mut entries = builder.finish().unwrap();
            let before = entries.snapshot();
            entries.remove_branches(&["folder".into()]).unwrap();
            entries.update("folder/new.txt".into(), Some(file(root.path(), "folder/new.txt", Some(2)))).unwrap();
            let after = entries.snapshot();
            assert_eq!(results(&before).len(), 3);
            assert_eq!(results(&after), vec![("folder-other/keep.txt".into(), Some(1)), ("folder/new.txt".into(), Some(2))]);
            assert!(entries.get("folder/old.txt").unwrap().is_none());
            assert!(entries.get("folder/new.txt").unwrap().is_some());
            assert_eq!(entries.delta.len(), 1);
            assert_eq!(entries.removed_branches.len(), 1);
        }
    }

    #[test]
    fn retained_snapshots_keep_their_memory_reservation_until_released() {
        let root = tempfile::tempdir().unwrap();
        let mut builder = IndexBuilder::new(root.path());
        builder.push(&file(root.path(), "Shared/Body.PNG", Some(5))).unwrap();
        let mut entries = builder.finish().unwrap();
        let snapshot = entries.snapshot();
        let bytes = entries.memory_bytes();
        let reserved = resident_bytes();
        entries.spill(root.path()).unwrap();
        assert_eq!(resident_bytes(), reserved);
        assert_eq!(results(&entries.snapshot()), results(&snapshot));
        drop(snapshot);
        assert_eq!(resident_bytes(), reserved - bytes);
    }

    #[test]
    fn incremental_compaction_preserves_old_snapshot_and_releases_disk_files() {
        let root = tempfile::tempdir().unwrap();
        let mut builder = IndexBuilder::with_limit(root.path(), 0);
        builder.push(&file(root.path(), "old.txt", Some(7))).unwrap();
        let mut entries = builder.finish().unwrap();
        let before = entries.snapshot();
        for index in 0..4100 {
            let relative = format!("new-{index:04}.txt");
            entries.update(relative.clone(), Some(file(root.path(), &relative, Some(index)))).unwrap();
        }
        entries.update("old.txt".into(), None).unwrap();
        entries.compact(root.path()).unwrap();
        assert!(entries.delta.is_empty());
        assert_eq!(results(&before), vec![("old.txt".into(), Some(7))]);
        assert_eq!(results(&entries.snapshot()).len(), 4100);
        let folder = root.path().join(".superhigh/cache/file-search");
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 1);
        drop(before);
        assert_eq!(std::fs::read_dir(folder).unwrap().count(), 0);
    }

    #[test]
    fn directory_and_case_sharing_keep_large_indices_compact() {
        let root = tempfile::tempdir().unwrap();
        let mut builder = IndexBuilder::new(root.path());
        for index in 0..100_000 {
            builder.push(&file(root.path(), &format!("Shared/Very/Long/Model/Resource/Directory/body-{index:06}.png"), None)).unwrap();
        }
        let entries = builder.finish().unwrap();
        assert!(entries.memory_bytes() < 8 * 1024 * 1024);
        let Storage::Packed(files) = &entries.storage else { panic!("unexpected disk storage"); };
        assert_eq!(files.directories.len(), 1);
        assert_eq!(files.records.len(), 100_000);
    }
}
