//! Turn-scoped native and workspace evidence. Core never reads workspace files.
use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnChanges {
    pub session_id: String,
    pub provider_kind: String,
    pub native_session_id: Option<String>,
    pub turn_id: Option<String>,
    pub revision: u64,
    pub available: bool,
    pub reason: Option<String>,
    pub completed: bool,
    pub files: Vec<AgentFileChange>,
    pub additions: u32,
    pub deletions: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileChange {
    pub path: String,
    pub absolute_path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiffRow {
    pub kind: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileDiff {
    pub session_id: String,
    pub turn_id: Option<String>,
    pub revision: u64,
    pub available: bool,
    pub reason: Option<String>,
    pub file: Option<AgentFileChange>,
    pub rows: Vec<AgentDiffRow>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedFileChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Content {
    before: Option<String>,
    after: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    view: AgentTurnChanges,
    cwd: PathBuf,
    rows: BTreeMap<String, Vec<AgentDiffRow>>,
    contents: BTreeMap<String, Content>,
    #[serde(default)]
    native_files: BTreeMap<String, AgentFileChange>,
    #[serde(default)]
    native_rows: BTreeMap<String, Vec<AgentDiffRow>>,
    seen_turns: Vec<String>,
}
#[derive(Default)]
struct Store {
    dir: Option<PathBuf>,
    sessions: BTreeMap<String, Record>,
    saved: BTreeMap<String, Record>,
}
static STORE: Lazy<Mutex<Store>> = Lazy::new(|| Mutex::new(Store::default()));
fn key(provider: &str, native: &str) -> String {
    format!("{}:{}", provider, native)
}
fn turn_key(provider: &str, native: &str, turn: &str) -> String {
    serde_json::to_string(&(provider, native, turn)).expect("string tuple serialization")
}
fn fresh_record(id: &str, provider: &str, cwd: &Path, native: Option<&str>) -> Record {
    let mut view = empty(id);
    view.provider_kind = provider.into();
    view.native_session_id = native.map(str::to_owned);
    Record {
        view,
        cwd: cwd.into(),
        rows: BTreeMap::new(),
        contents: BTreeMap::new(),
        native_files: BTreeMap::new(),
        native_rows: BTreeMap::new(),
        seen_turns: vec![],
    }
}
fn empty(id: &str) -> AgentTurnChanges {
    AgentTurnChanges {
        session_id: id.into(),
        provider_kind: String::new(),
        native_session_id: None,
        turn_id: None,
        revision: 0,
        available: false,
        reason: Some("等待原生回合证据".into()),
        completed: false,
        files: vec![],
        additions: 0,
        deletions: 0,
    }
}
fn missing(id: &str) -> AgentTurnChanges {
    let mut view = empty(id);
    view.reason = Some("需新建或恢复会话以启用工具变更".into());
    view
}
fn invalidate(r: &mut Record, reason: &str) {
    r.view.available = false;
    r.view.reason = Some(reason.into());
    r.view.files.clear();
    r.view.additions = 0;
    r.view.deletions = 0;
    r.rows.clear();
    r.contents.clear();
    r.native_files.clear();
    r.native_rows.clear();
}
fn save(s: &mut Store, id: &str) -> AgentTurnChanges {
    let r = s.sessions.get_mut(id).unwrap();
    r.view.revision += 1;
    let result = r.view.clone();
    if let Some(native) = &r.view.native_session_id {
        s.saved
            .insert(key(&r.view.provider_kind, native), r.clone());
        if let Some(turn) = &r.view.turn_id {
            s.saved
                .insert(turn_key(&r.view.provider_kind, native, turn), r.clone());
        }
    }
    if let Some(dir) = &s.dir {
        let write = (|| -> Result<()> {
            let bytes = serde_json::to_vec(&s.saved)?;
            let tmp = dir.join("turns.json.tmp");
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(tmp, dir.join("turns.json"))?;
            Ok(())
        })();
        if let Err(e) = write {
            eprintln!("agent changes persistence: {e}");
        }
    }
    result
}
pub fn configure_data_dir(app_data: &Path) -> Result<()> {
    let dir = app_data.join("agent-turn-changes");
    std::fs::create_dir_all(&dir)?;
    let mut s = STORE.lock().unwrap();
    let file = dir.join("turns.json");
    s.dir = Some(dir);
    s.saved = if file.exists() {
        serde_json::from_slice(
            &std::fs::read(&file)
                .with_context(|| format!("无法读取回合缓存 {}", file.display()))?,
        )
        .with_context(|| format!("回合缓存损坏：{}；原文件保留，本次不恢复", file.display()))?
    } else {
        BTreeMap::new()
    };
    Ok(())
}
pub fn register_session(
    id: &str,
    provider: &str,
    cwd: &Path,
    native: Option<&str>,
) -> AgentTurnChanges {
    let mut s = STORE.lock().unwrap();
    let mut r = native
        .and_then(|n| s.saved.get(&key(provider, n)))
        .cloned()
        .unwrap_or_else(|| fresh_record(id, provider, cwd, native));
    r.view.revision = r
        .view
        .revision
        .max(s.sessions.get(id).map(|r| r.view.revision).unwrap_or(0));
    r.view.session_id = id.into();
    r.view.provider_kind = provider.into();
    r.view.native_session_id = native.map(str::to_owned);
    r.cwd = cwd.into();
    s.sessions.insert(id.into(), r);
    save(&mut s, id)
}
pub fn bind_native_session(id: &str, native: &str) -> AgentTurnChanges {
    let mut s = STORE.lock().unwrap();
    let Some(current) = s.sessions.get(id).cloned() else {
        return empty(id);
    };
    if current.view.native_session_id.as_deref() != Some(native) {
        let mut r = s
            .saved
            .get(&key(&current.view.provider_kind, native))
            .cloned()
            .unwrap_or_else(|| {
                fresh_record(id, &current.view.provider_kind, &current.cwd, Some(native))
            });
        r.view.revision = r.view.revision.max(current.view.revision);
        r.cwd = current.cwd;
        r.view.session_id = id.into();
        r.view.native_session_id = Some(native.into());
        s.sessions.insert(id.into(), r);
    }
    save(&mut s, id)
}
fn accepts(r: &Record, native: &str, turn: &str) -> bool {
    r.view.native_session_id.as_deref() == Some(native) && r.view.turn_id.as_deref() == Some(turn)
}
// Late evidence updates the archived turn, while callers always receive current view.
fn mutate_turn(
    s: &mut Store,
    id: &str,
    native: &str,
    turn: &str,
    apply: impl FnOnce(&mut Record),
) -> AgentTurnChanges {
    let Some(current) = s.sessions.get(id).cloned() else {
        return empty(id);
    };
    let is_current = accepts(&current, native, turn);
    let historical_key = turn_key(&current.view.provider_kind, native, turn);
    let Some(mut target) = (if is_current {
        Some(current.clone())
    } else {
        s.saved.get(&historical_key).cloned()
    }) else {
        return current.view;
    };
    target.view.session_id = id.into();
    target.view.revision = current.view.revision;
    apply(&mut target);
    if is_current {
        s.sessions.insert(id.into(), target);
    } else {
        target.view.revision += 1;
        let native_key = key(&current.view.provider_kind, native);
        if s.saved
            .get(&native_key)
            .and_then(|r| r.view.turn_id.as_deref())
            == Some(turn)
        {
            s.saved.insert(native_key, target.clone());
        }
        s.saved.insert(historical_key, target);
    }
    save(s, id)
}
pub fn begin_turn(id: &str, native: &str, turn: &str) -> AgentTurnChanges {
    let mut s = STORE.lock().unwrap();
    let Some(r) = s.sessions.get_mut(id) else {
        return empty(id);
    };
    if r.view.native_session_id.as_deref() != Some(native) || r.seen_turns.iter().any(|t| t == turn)
    {
        return r.view.clone();
    };
    r.seen_turns.push(turn.into());
    r.view.turn_id = Some(turn.into());
    r.view.completed = false;
    r.view.available = true;
    r.view.reason = None;
    r.view.files.clear();
    r.view.additions = 0;
    r.view.deletions = 0;
    r.rows.clear();
    r.contents.clear();
    r.native_files.clear();
    r.native_rows.clear();
    save(&mut s, id)
}
pub fn get_turn_changes(id: &str) -> AgentTurnChanges {
    STORE
        .lock()
        .unwrap()
        .sessions
        .get(id)
        .map(|r| r.view.clone())
        .unwrap_or_else(|| missing(id))
}
pub fn mark_unavailable(id: &str, turn: Option<&str>, reason: &str) -> AgentTurnChanges {
    let mut s = STORE.lock().unwrap();
    let Some(r) = s.sessions.get(id) else {
        return empty(id);
    };
    let native = r.view.native_session_id.clone();
    let turn = turn.map(str::to_owned).or_else(|| r.view.turn_id.clone());
    if let (Some(native), Some(turn)) = (native, turn) {
        return mutate_turn(&mut s, id, &native, &turn, |r| invalidate(r, reason));
    }
    invalidate(s.sessions.get_mut(id).unwrap(), reason);
    save(&mut s, id)
}
pub fn mark_native_unavailable(
    id: &str,
    native: &str,
    turn: &str,
    reason: &str,
) -> AgentTurnChanges {
    mutate_turn(&mut STORE.lock().unwrap(), id, native, turn, |r| {
        invalidate(r, reason)
    })
}
pub fn complete_turn(id: &str, native: &str, turn: &str) -> AgentTurnChanges {
    let mut s = STORE.lock().unwrap();
    mutate_turn(&mut s, id, native, turn, |r| r.view.completed = true)
}
pub fn finish_session(id: &str) -> AgentTurnChanges {
    let mut s = STORE.lock().unwrap();
    let Some(r) = s.sessions.get_mut(id) else {
        return empty(id);
    };
    r.view.completed = true;
    save(&mut s, id)
}
fn normalize(p: &str) -> String {
    p.replace('\\', "/")
}
fn content_path(r: &Record, p: &str) -> String {
    let p = normalize(p);
    let root = normalize(&r.cwd.to_string_lossy());
    p.strip_prefix(&(root.trim_end_matches('/').to_owned() + "/"))
        .unwrap_or(&p)
        .to_owned()
}
fn file(
    r: &Record,
    path: &str,
    old: Option<String>,
    status: &str,
    rows: &[AgentDiffRow],
) -> AgentFileChange {
    let p = Path::new(path);
    AgentFileChange {
        path: normalize(path),
        absolute_path: normalize(
            &if p.is_absolute() {
                p.to_path_buf()
            } else {
                r.cwd.join(p)
            }
            .to_string_lossy(),
        ),
        old_path: old,
        status: status.into(),
        additions: rows.iter().filter(|x| x.kind == "add").count() as u32,
        deletions: rows.iter().filter(|x| x.kind == "del").count() as u32,
    }
}
fn totals(r: &mut Record) {
    r.view.additions = r.view.files.iter().map(|f| f.additions).sum();
    r.view.deletions = r.view.files.iter().map(|f| f.deletions).sum();
}
fn unquote(p: &str) -> String {
    if p.starts_with('"') {
        serde_json::from_str(p).unwrap_or_else(|_| p.trim_matches('"').to_owned())
    } else {
        p.to_owned()
    }
}
fn header_path(p: &str) -> String {
    let p = unquote(p.split('\t').next().unwrap_or(p));
    p.strip_prefix("a/")
        .or_else(|| p.strip_prefix("b/"))
        .unwrap_or(&p)
        .to_owned()
}
fn parse_diff(diff: &str) -> Result<Vec<(String, Option<String>, String, Vec<AgentDiffRow>)>> {
    let mut out = vec![];
    let mut old = String::new();
    let mut new = String::new();
    let mut status = "modified".to_owned();
    let mut rows = vec![];
    let mut active = false;
    let (mut ol, mut nl) = (0u32, 0u32);
    let mut hunk = false;
    let flush = |out: &mut Vec<_>,
                 old: &str,
                 new: &str,
                 status: &str,
                 rows: &mut Vec<AgentDiffRow>| {
        let path = if new == "/dev/null" { old } else { new };
        if !path.is_empty() {
            // Codex uses differing git/header paths without rename metadata.
            let status =
                if status == "modified" && old != new && old != "/dev/null" && new != "/dev/null" {
                    "renamed"
                } else {
                    status
                };
            out.push((
                path.to_owned(),
                (status == "renamed" && old != new).then(|| old.to_owned()),
                status.to_owned(),
                std::mem::take(rows),
            ));
        }
    };
    for raw in diff.lines() {
        let l = raw.strip_suffix('\r').unwrap_or(raw);
        if l.starts_with("diff --git ") {
            if active {
                flush(&mut out, &old, &new, &status, &mut rows)
            }
            old.clear();
            new.clear();
            status = "modified".into();
            active = true;
            hunk = false;
            let rest = &l[11..];
            if rest.starts_with('"') {
                let mut escaped = false;
                let end = rest.char_indices().skip(1).find_map(|(i, c)| {
                    if escaped {
                        escaped = false;
                        return None;
                    }
                    if c == '\\' {
                        escaped = true;
                        return None;
                    }
                    if c == '"' {
                        Some(i)
                    } else {
                        None
                    }
                });
                if let Some(i) = end {
                    old = header_path(&rest[..=i]);
                    new = header_path(rest[i + 1..].trim_start());
                }
            } else if let Some(i) = rest.rfind(" b/") {
                old = header_path(&rest[..i]);
                new = header_path(&rest[i + 1..]);
            }
            continue;
        }
        if l.starts_with("@@ ") {
            let bits: Vec<_> = l.split_whitespace().collect();
            if bits.len() < 3 {
                bail!("无效 diff hunk")
            };
            ol = bits[1]
                .trim_start_matches('-')
                .split(',')
                .next()
                .unwrap()
                .parse()?;
            nl = bits[2]
                .trim_start_matches('+')
                .split(',')
                .next()
                .unwrap()
                .parse()?;
            if !rows.is_empty() {
                rows.push(AgentDiffRow {
                    kind: "gap".into(),
                    old_line: None,
                    new_line: None,
                    text: String::new(),
                });
            }
            hunk = true;
            continue;
        }
        if hunk {
            let (kind, o, n) = match l.as_bytes().first() {
                Some(b' ') => ("context", Some(ol), Some(nl)),
                Some(b'+') => ("add", None, Some(nl)),
                Some(b'-') => ("del", Some(ol), None),
                Some(b'\\') => continue,
                _ => {
                    hunk = false;
                    continue;
                }
            };
            rows.push(AgentDiffRow {
                kind: kind.into(),
                old_line: o,
                new_line: n,
                text: l[1..].to_owned(),
            });
            if o.is_some() {
                ol += 1
            }
            if n.is_some() {
                nl += 1
            }
            continue;
        }
        if let Some(p) = l.strip_prefix("--- ") {
            old = header_path(p);
            active = true;
            if old == "/dev/null" {
                status = "added".into()
            }
        } else if let Some(p) = l.strip_prefix("+++ ") {
            new = header_path(p);
            if new == "/dev/null" {
                status = "deleted".into()
            }
        } else if l.starts_with("new file mode ") {
            status = "added".into()
        } else if l.starts_with("deleted file mode ") {
            status = "deleted".into()
        } else if let Some(p) = l.strip_prefix("rename from ") {
            old = unquote(p);
            status = "renamed".into()
        } else if let Some(p) = l.strip_prefix("rename to ") {
            new = unquote(p);
            status = "renamed".into()
        } else if l.starts_with("Binary files ") || l.starts_with("GIT binary patch") {
            bail!("原生 diff 包含二进制内容")
        }
    }
    if active {
        flush(&mut out, &old, &new, &status, &mut rows)
    }
    if !diff.trim().is_empty() && out.is_empty() {
        bail!("无法解析原生 diff")
    };
    Ok(out)
}
pub fn set_native_diff(id: &str, native: &str, turn: &str, diff: &str) -> AgentTurnChanges {
    let mut s = STORE.lock().unwrap();
    mutate_turn(&mut s, id, native, turn, |r| {
        if !r.view.available {
            return;
        }
        r.view.completed = false;
        match parse_diff(diff) {
            Ok(files) => {
                r.native_files.clear();
                r.native_rows.clear();
                for (p, o, st, rows) in files {
                    let p = content_path(r, &p);
                    r.native_files.insert(p.clone(), file(r, &p, o, &st, &rows));
                    r.native_rows.insert(p, rows);
                }
                rebuild(r)
            }
            Err(e) => invalidate(r, &e.to_string()),
        }
    })
}
pub fn commit_changes(
    id: &str,
    native: &str,
    turn: &str,
    changes: &[CommittedFileChange],
) -> AgentTurnChanges {
    let mut s = STORE.lock().unwrap();
    mutate_turn(&mut s, id, native, turn, |r| {
        if !r.view.available {
            return;
        }
        if !changes.is_empty() {
            r.view.completed = false;
        }
        for c in changes {
            let p = content_path(r, &c.path);
            if let Some(prev) = r.contents.get_mut(&p) {
                if prev.after != c.before {
                    invalidate(r, "已提交内容链断裂");
                    return;
                }
                prev.after = c.after.clone();
            } else {
                r.contents.insert(
                    p,
                    Content {
                        before: c.before.clone(),
                        after: c.after.clone(),
                    },
                );
            }
        }
        rebuild(r);
    })
}
pub fn overwrite_workspace_contents(
    id: &str,
    native: &str,
    turn: &str,
    changes: &[CommittedFileChange],
) -> AgentTurnChanges {
    let mut s = STORE.lock().unwrap();
    mutate_turn(&mut s, id, native, turn, |r| {
        if !r.view.available {
            return;
        }
        r.view.completed = false;
        for c in changes {
            r.contents.insert(
                content_path(r, &c.path),
                Content {
                    before: c.before.clone(),
                    after: c.after.clone(),
                },
            );
        }
        rebuild(r);
    })
}
fn rebuild(r: &mut Record) {
    r.view.files = r.native_files.values().cloned().collect();
    r.rows = r.native_rows.clone();
    for (p, c) in &r.contents {
        r.view.files.retain(|f| f.path != *p);
        r.rows.remove(p);
        if c.before == c.after {
            continue;
        };
        let status = if c.before.is_none() {
            "added"
        } else if c.after.is_none() {
            "deleted"
        } else {
            "modified"
        };
        let old = c.before.as_deref().unwrap_or("");
        let new = c.after.as_deref().unwrap_or("");
        let d = similar::TextDiff::configure()
            .timeout(Duration::from_millis(100))
            .diff_lines(old, new);
        let unified = d
            .unified_diff()
            .context_radius(3)
            .header("a/file", "b/file")
            .to_string();
        let rows = parse_diff(&unified)
            .ok()
            .and_then(|mut x| x.pop())
            .map(|x| x.3)
            .unwrap_or_default();
        r.view.files.push(file(r, p, None, status, &rows));
        r.rows.insert(p.clone(), rows);
    }
    totals(r);
}
pub fn get_file_diff(id: &str, turn: &str, path: &str) -> Result<AgentFileDiff> {
    let s = STORE.lock().unwrap();
    let Some(r) = s.sessions.get(id) else {
        bail!("会话不存在")
    };
    let r = if r.view.turn_id.as_deref() == Some(turn) {
        r
    } else {
        let native = r
            .view
            .native_session_id
            .as_deref()
            .context("原生会话尚未绑定")?;
        s.saved
            .get(&turn_key(&r.view.provider_kind, native, turn))
            .or_else(|| {
                s.saved.values().find(|old| {
                    old.view.provider_kind == r.view.provider_kind
                        && old.view.turn_id.as_deref() == Some(turn)
                })
            })
            .context("回合证据不存在")?
    };
    let path = normalize(path);
    let f = r
        .view
        .files
        .iter()
        .find(|f| f.path == path || f.absolute_path == path)
        .cloned();
    let rows = f
        .as_ref()
        .and_then(|f| r.rows.get(&f.path))
        .cloned()
        .unwrap_or_default();
    Ok(AgentFileDiff {
        session_id: id.into(),
        turn_id: r.view.turn_id.clone(),
        revision: r.view.revision,
        available: r.view.available,
        reason: r.view.reason.clone(),
        file: f,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> String {
        let id = uuid::Uuid::new_v4().to_string();
        register_session(&id, "claude", Path::new("/workspace"), Some(&id));
        begin_turn(&id, &id, "one");
        id
    }
    fn commit(id: &str, b: Option<&str>, a: Option<&str>) {
        commit_changes(
            id,
            id,
            "one",
            &[CommittedFileChange {
                path: "x".into(),
                before: b.map(str::to_owned),
                after: a.map(str::to_owned),
            }],
        );
    }
    #[test]
    fn cancellation_and_recreation() {
        let id = setup();
        commit(&id, None, Some("a\n"));
        commit(&id, Some("a\n"), None);
        assert!(get_turn_changes(&id).files.is_empty());
        commit(&id, None, Some("b\n"));
        assert_eq!(get_turn_changes(&id).files[0].status, "added");
    }
    #[test]
    fn chain_break_stays_unavailable() {
        let id = setup();
        commit(&id, Some("a"), Some("b"));
        commit(&id, Some("wrong"), Some("c"));
        commit(&id, Some("c"), Some("d"));
        assert!(!get_turn_changes(&id).available);
        begin_turn(&id, &id, "two");
        assert!(get_turn_changes(&id).available);
        set_native_diff(&id, &id, "one", "bad");
        assert_eq!(get_turn_changes(&id).turn_id.as_deref(), Some("two"));
    }
    #[test]
    fn native_meta_and_crlf() {
        let files=parse_diff("diff --git a/empty name b/empty name\r\nnew file mode 100644\r\ndiff --git a/old name b/new name\r\nsimilarity index 100%\r\nrename from old name\r\nrename to new name\r\n").unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].2, "added");
        assert_eq!(files[1].1.as_deref(), Some("old name"));
        let f =
            parse_diff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n")
                .unwrap();
        assert_eq!(f[0].3.len(), 2);
    }
    #[test]
    fn baseline_repeated_edits() {
        let id = setup();
        commit(&id, Some("a\nb\n"), Some("a\nc\n"));
        commit(&id, Some("a\nc\n"), Some("a\nd\n"));
        let v = get_turn_changes(&id);
        assert_eq!((v.additions, v.deletions), (1, 1));
        assert_eq!(
            get_file_diff(&id, "one", "x")
                .unwrap()
                .rows
                .last()
                .unwrap()
                .text,
            "d"
        );
        commit(&id, Some("a\nd\n"), None);
        commit(&id, None, Some("a\nb\n"));
        assert!(get_turn_changes(&id).files.is_empty());
    }
    #[test]
    fn quoted_empty_file_and_numbered_hunks() {
        let f = parse_diff("diff --git \"a/a b\" \"b/a b\"\nnew file mode 100644\n").unwrap();
        assert_eq!(f[0].0, "a b");
        assert!(f[0].3.is_empty());
        let f = parse_diff(
            "--- a/x\n+++ b/x\n@@ -10,2 +10,2 @@\n same\n-old\n+new\n@@ -20 +20 @@\n-tail\n+end\n",
        )
        .unwrap();
        assert_eq!(f[0].3[0].old_line, Some(10));
        assert_eq!(f[0].3[2].new_line, Some(11));
        assert_eq!(f[0].3[3].kind, "gap");
        assert_eq!(f[0].3[4].old_line, Some(20));
    }
    #[test]
    fn record_round_trip_keeps_baseline_and_rows() {
        let id = setup();
        commit(&id, Some("old\n"), Some("new\n"));
        let store = STORE.lock().unwrap();
        let r = store.sessions.get(&id).unwrap();
        let restored: Record = serde_json::from_slice(&serde_json::to_vec(r).unwrap()).unwrap();
        assert_eq!(restored.contents["x"].before.as_deref(), Some("old\n"));
        assert_eq!(restored.rows["x"].last().unwrap().text, "new");
        assert_eq!(
            restored.view.native_session_id.as_deref(),
            Some(id.as_str())
        );
    }
    #[test]
    fn committed_continuation_reopens_same_turn() {
        let id = setup();
        commit(&id, None, Some("first\n"));
        assert!(complete_turn(&id, &id, "one").completed);
        commit(&id, Some("first\n"), Some("second\n"));
        let view = get_turn_changes(&id);
        assert!(!view.completed);
        assert_eq!(view.turn_id.as_deref(), Some("one"));
        assert_eq!(view.additions, 1);
        assert!(complete_turn(&id, &id, "one").completed);
    }
    #[test]
    fn native_continuation_and_late_failure() {
        let id = setup();
        complete_turn(&id, &id, "one");
        assert!(
            !set_native_diff(
                &id,
                &id,
                "one",
                "diff --git a/x b/x\nnew file mode 100644\n"
            )
            .completed
        );
        begin_turn(&id, &id, "two");
        let before = get_turn_changes(&id);
        let after = mark_unavailable(&id, Some("one"), "late hook failed");
        assert!(after.available);
        assert!(after.revision > before.revision);
        assert_eq!(after.turn_id.as_deref(), Some("two"));
        assert!(!get_file_diff(&id, "one", "x").unwrap().available);
    }
    #[test]
    fn native_binding_isolated_and_revision_monotonic() {
        let id = setup();
        commit(&id, None, Some("old\n"));
        let before = get_turn_changes(&id);
        let new_native = format!("{id}-other");
        let bound = bind_native_session(&id, &new_native);
        assert!(bound.revision > before.revision);
        assert!(bound.files.is_empty());
        assert!(bound.turn_id.is_none());
        begin_turn(&id, &new_native, "one");
        let newer = get_turn_changes(&id);
        let restored = bind_native_session(&id, &id);
        assert!(restored.revision > newer.revision);
        assert_eq!(restored.files.len(), 1);
    }
    #[test]
    fn late_committed_evidence_updates_history_only() {
        let id = setup();
        commit(&id, None, Some("first\n"));
        complete_turn(&id, &id, "one");
        begin_turn(&id, &id, "two");
        let current = get_turn_changes(&id);
        commit(&id, Some("first\n"), Some("late\n"));
        let after = get_turn_changes(&id);
        assert_eq!(after.turn_id.as_deref(), Some("two"));
        assert!(after.files.is_empty());
        assert!(after.revision > current.revision);
        let archived = get_file_diff(&id, "one", "x").unwrap();
        assert_eq!(archived.rows.last().unwrap().text, "late");
        let store = STORE.lock().unwrap();
        let restored: BTreeMap<String, Record> =
            serde_json::from_slice(&serde_json::to_vec(&store.saved).unwrap()).unwrap();
        assert_eq!(
            restored[&turn_key("claude", &id, "one")].contents["x"]
                .after
                .as_deref(),
            Some("late\n")
        );
    }
    #[test]
    fn changes_workspace_and_native_layers_merge_without_double_count() {
        let id = setup();
        let native="diff --git a/native.txt b/native.txt\n--- a/native.txt\n+++ b/native.txt\n@@ -1 +1 @@\n-old\n+native\n";
        set_native_diff(&id, &id, "one", native);
        overwrite_workspace_contents(
            &id,
            &id,
            "one",
            &[CommittedFileChange {
                path: "shell.txt".into(),
                before: None,
                after: Some("shell\n".into()),
            }],
        );
        let view = get_turn_changes(&id);
        assert_eq!(view.files.len(), 2);
        assert_eq!((view.additions, view.deletions), (2, 1));
        overwrite_workspace_contents(
            &id,
            &id,
            "one",
            &[CommittedFileChange {
                path: "/workspace/native.txt".into(),
                before: Some("old\n".into()),
                after: Some("shell authoritative\n".into()),
            }],
        );
        let view = get_turn_changes(&id);
        assert_eq!(view.files.len(), 2);
        assert_eq!((view.additions, view.deletions), (2, 1));
        assert_eq!(
            get_file_diff(&id, "one", "native.txt")
                .unwrap()
                .rows
                .last()
                .unwrap()
                .text,
            "shell authoritative"
        );
        overwrite_workspace_contents(
            &id,
            &id,
            "one",
            &[CommittedFileChange {
                path: "native.txt".into(),
                before: Some("old\n".into()),
                after: Some("old\n".into()),
            }],
        );
        set_native_diff(&id, &id, "one", native);
        let view = get_turn_changes(&id);
        assert_eq!(view.files.len(), 1);
        assert_eq!(view.files[0].path, "shell.txt");
    }
    #[test]
    fn changes_workspace_refresh_reopens_completed_turn_even_when_restored() {
        let id = setup();
        assert!(complete_turn(&id, &id, "one").completed);
        let reopened = overwrite_workspace_contents(
            &id,
            &id,
            "one",
            &[CommittedFileChange {
                path: "x".into(),
                before: Some("same\n".into()),
                after: Some("same\n".into()),
            }],
        );
        assert!(!reopened.completed);
        assert!(reopened.files.is_empty());
        assert!(complete_turn(&id, &id, "one").completed);
        assert!(!overwrite_workspace_contents(&id, &id, "one", &[]).completed);
    }
}
