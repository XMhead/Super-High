use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Local, NaiveDateTime, NaiveTime, TimeZone};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub scope: String,
    pub title: String,
    pub enabled: bool,
    pub schedule: Schedule,
    pub action: Action,
    #[serde(default)]
    pub next_run: Option<String>,
    #[serde(default)]
    pub last_run: Option<String>,
    #[serde(default)]
    pub last_status: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Schedule {
    Once { at: String },
    Daily { time: String },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Action {
    Shutdown,
    Restart,
    Command { command: String },
}
#[derive(Default, Serialize, Deserialize)]
struct Registry {
    version: u8,
    tasks: Vec<Task>,
}

fn db(data: &Path) -> Result<Connection> {
    fs::create_dir_all(data)?;
    let conn = Connection::open(data.join("automation-state.db"))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS projects(path TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS runs(task_key TEXT PRIMARY KEY, occurrence TEXT NOT NULL, last_run TEXT NOT NULL, status TEXT NOT NULL, error TEXT);")?;
    Ok(conn)
}
fn root(project: Option<&str>) -> Result<PathBuf> {
    let p = PathBuf::from(project.context("project scope requires a workspace path")?);
    if !p.is_dir() {
        bail!("workspace does not exist: {}", p.display());
    }
    Ok(p.canonicalize()?)
}
fn path(data: &Path, scope: &str, project: Option<&str>) -> Result<PathBuf> {
    match scope {
        "system" => Ok(data.join("automation-system.json")),
        "global" => Ok(data.join("automation.json")),
        "project" => Ok(root(project)?.join(".superhigh/automation.json")),
        _ => bail!("unknown automation scope: {scope}"),
    }
}
fn read(path: &Path) -> Result<Registry> {
    if !path.exists() {
        return Ok(Registry {
            version: 1,
            tasks: vec![],
        });
    }
    let r: Registry = serde_json::from_slice(
        &fs::read(path).with_context(|| format!("cannot read {}", path.display()))?,
    )
    .with_context(|| format!("invalid automation registry {}", path.display()))?;
    if r.version != 1 {
        bail!(
            "unsupported automation registry version in {}",
            path.display()
        );
    }
    Ok(r)
}
fn write(path: &Path, r: &Registry) -> Result<()> {
    fs::create_dir_all(path.parent().unwrap())?;
    // Temporary file in the same directory; persist replaces atomically on supported platforms.
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    serde_json::to_writer_pretty(&mut tmp, r)?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}
fn builtin() -> Task {
    Task {
        id: "power".into(),
        scope: "system".into(),
        title: "定时关闭或重启电脑".into(),
        enabled: false,
        schedule: Schedule::Daily {
            time: "23:00".into(),
        },
        action: Action::Shutdown,
        next_run: None,
        last_run: None,
        last_status: None,
        last_error: None,
    }
}
fn validate(task: &Task) -> Result<()> {
    if task.id.trim().is_empty() || task.id.len() > 128 || task.title.trim().is_empty() {
        bail!("task id and title are required");
    }
    if !matches!(task.scope.as_str(), "system" | "global" | "project") {
        bail!("invalid scope");
    }
    if task.scope == "system"
        && (task.id != "power" || matches!(task.action, Action::Command { .. }))
    {
        bail!("system power template only supports shutdown or restart");
    }
    match &task.schedule {
        Schedule::Once { at } => {
            NaiveDateTime::parse_from_str(at, "%Y-%m-%dT%H:%M")
                .context("once at must be YYYY-MM-DDTHH:mm")?;
        }
        Schedule::Daily { time } => {
            NaiveTime::parse_from_str(time, "%H:%M").context("daily time must be HH:mm")?;
        }
    }
    if let Action::Command { command } = &task.action {
        if command.trim().is_empty() {
            bail!("command cannot be empty");
        }
    }
    Ok(())
}
fn local(naive: NaiveDateTime) -> Option<DateTime<Local>> {
    Local.from_local_datetime(&naive).single()
}
fn next(task: &Task, now: DateTime<Local>) -> Option<DateTime<Local>> {
    if !task.enabled {
        return None;
    }
    match &task.schedule {
        Schedule::Once { at } => {
            local(NaiveDateTime::parse_from_str(at, "%Y-%m-%dT%H:%M").ok()?).filter(|t| *t > now)
        }
        Schedule::Daily { time } => {
            let time = NaiveTime::parse_from_str(time, "%H:%M").ok()?;
            (0..=2)
                .filter_map(|i| {
                    now.date_naive()
                        .checked_add_days(chrono::Days::new(i))
                        .and_then(|d| local(d.and_time(time)))
                })
                .find(|t| *t > now)
        }
    }
}
fn key(task: &Task, project: Option<&str>) -> Result<String> {
    Ok(format!(
        "{}|{}|{}",
        task.scope,
        if task.scope == "project" {
            root(project)?.to_string_lossy().into_owned()
        } else {
            String::new()
        },
        task.id
    ))
}
fn attach(conn: &Connection, task: &mut Task, project: Option<&str>) -> Result<()> {
    task.next_run = next(task, Local::now()).map(|d| d.to_rfc3339());
    let mut stmt = conn.prepare("SELECT last_run,status,error FROM runs WHERE task_key=?1")?;
    let mut rows = stmt.query([key(task, project)?])?;
    if let Some(row) = rows.next()? {
        task.last_run = Some(row.get(0)?);
        task.last_status = Some(row.get(1)?);
        task.last_error = row.get(2)?;
    }
    Ok(())
}
fn scope_tasks(data: &Path, scope: &str, project: Option<&str>) -> Result<Vec<Task>> {
    let p = path(data, scope, project)?;
    let mut tasks = read(&p)?.tasks;
    if scope == "system" && !tasks.iter().any(|t| t.id == "power") {
        tasks.push(builtin());
    }
    for task in &tasks {
        validate(task).with_context(|| format!("invalid task in {}", p.display()))?;
        if task.scope != scope {
            bail!("task scope mismatch in {}", p.display());
        }
    }
    Ok(tasks)
}
pub fn list(data: &Path, project: Option<&str>) -> Result<Vec<Task>> {
    let conn = db(data)?;
    let mut tasks = vec![];
    for scope in ["system", "global"] {
        tasks.extend(scope_tasks(data, scope, None)?);
    }
    if project.is_some() {
        tasks.extend(scope_tasks(data, "project", project)?);
    }
    for task in &mut tasks {
        attach(&conn, task, project)?;
    }
    Ok(tasks)
}
pub fn save(data: &Path, mut task: Task, project: Option<&str>) -> Result<Task> {
    validate(&task)?;
    if task.enabled {
        if let Schedule::Once { at } = &task.schedule {
            let date = NaiveDateTime::parse_from_str(at, "%Y-%m-%dT%H:%M")?;
            if local(date).filter(|when| *when > Local::now()).is_none() {
                bail!("一次性任务时间必须是未来有效的本地时间");
            }
        }
    }
    let conn = db(data)?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let p = path(data, &task.scope, project)?;
    let mut r = read(&p)?;
    task.next_run = None;
    task.last_run = None;
    task.last_status = None;
    task.last_error = None;
    if let Some(old) = r.tasks.iter_mut().find(|t| t.id == task.id) {
        *old = task.clone();
    } else {
        r.tasks.push(task.clone());
    }
    write(&p, &r)?;
    if task.scope == "project" {
        conn.execute(
            "INSERT OR IGNORE INTO projects(path) VALUES (?1)",
            [root(project)?.to_string_lossy().as_ref()],
        )?;
    }
    conn.execute_batch("COMMIT")?;
    attach(&conn, &mut task, project)?;
    Ok(task)
}
pub fn delete(data: &Path, scope: &str, id: &str, project: Option<&str>) -> Result<()> {
    if scope == "system" {
        bail!("system templates cannot be deleted");
    }
    let conn = db(data)?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let p = path(data, scope, project)?;
    let mut r = read(&p)?;
    let n = r.tasks.len();
    r.tasks.retain(|t| t.id != id);
    if n == r.tasks.len() {
        bail!("task not found: {id}");
    }
    write(&p, &r)?;
    conn.execute_batch("COMMIT")?;
    Ok(())
}
#[tauri::command]
pub async fn automation_list_command(
    app: tauri::AppHandle,
    project_path: Option<String>,
) -> Result<Vec<Task>, String> {
    let data = crate::db::app_data_dir(&app).map_err(|e| e.to_string())?;
    list(&data, project_path.as_deref()).map_err(|e| format!("{e:#}"))
}
#[tauri::command]
pub async fn automation_save_command(
    app: tauri::AppHandle,
    task: Task,
    project_path: Option<String>,
) -> Result<Task, String> {
    let data = crate::db::app_data_dir(&app).map_err(|e| e.to_string())?;
    save(&data, task, project_path.as_deref()).map_err(|e| format!("{e:#}"))
}
#[tauri::command]
pub async fn automation_delete_command(
    app: tauri::AppHandle,
    scope: String,
    id: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let data = crate::db::app_data_dir(&app).map_err(|e| e.to_string())?;
    delete(&data, &scope, &id, project_path.as_deref()).map_err(|e| format!("{e:#}"))
}
fn projects(data: &Path, conn: &Connection) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |path: String| {
        let path = PathBuf::from(path);
        if !path.is_dir() {
            return;
        }
        let Ok(path) = path.canonicalize() else {
            return;
        };
        let path = path.to_string_lossy().into_owned();
        #[cfg(windows)]
        let identity = path.to_lowercase();
        #[cfg(not(windows))]
        let identity = path.clone();
        if seen.insert(identity) {
            out.push(path);
        }
    };
    let mut stmt = conn.prepare("SELECT path FROM projects")?;
    for p in stmt.query_map([], |r| r.get::<_, String>(0))? {
        add(p?);
    }
    let history = data.join("super-high.db");
    if history.exists() {
        if let Ok(h) =
            Connection::open_with_flags(history, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        {
            if let Ok(mut stmt) = h.prepare("SELECT path FROM recent_projects") {
                if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                    for p in rows.flatten() {
                        add(p);
                    }
                }
            }
        }
    }
    Ok(out)
}
fn run_action(task: &Task, project: Option<&str>, data: &Path) -> Result<()> {
    let mut cmd = match &task.action {
        Action::Shutdown | Action::Restart => {
            #[cfg(windows)]
            {
                let mut c = Command::new("shutdown.exe");
                c.args([
                    if matches!(task.action, Action::Shutdown) {
                        "/s"
                    } else {
                        "/r"
                    },
                    "/t",
                    "0",
                ]);
                c
            }
            #[cfg(not(windows))]
            {
                bail!("power actions are only supported on Windows");
            }
        }
        Action::Command { command } => {
            #[cfg(windows)]
            let mut c = {
                let mut c = Command::new("powershell.exe");
                c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
                c
            };
            #[cfg(not(windows))]
            let mut c = {
                let mut c = Command::new("sh");
                c.args(["-c", command]);
                c
            };
            if let Some(p) = project {
                c.current_dir(p).env("SUPERHIGH_WORKSPACE", p);
            } else {
                c.current_dir(data);
            }
            c
        }
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().context("failed to start action")?;
    for _ in 0..300 {
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err(anyhow!("action exited with {status}"))
            };
        }
        thread::sleep(Duration::from_secs(1));
    }
    crate::process_tree::kill_std_child_tree(&mut child);
    let _ = child.wait();
    bail!("action timed out after 300 seconds")
}
fn tick(data: &Path, from: DateTime<Local>, now: DateTime<Local>) -> Result<()> {
    let conn = db(data)?;
    let mut groups = vec![("system", None), ("global", None)];
    let ps = projects(data, &conn)?;
    for p in &ps {
        groups.push(("project", Some(p.as_str())));
    }
    for (scope, project) in groups {
        let tasks = match scope_tasks(data, scope, project) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[automation] {e:#}");
                continue;
            }
        };
        for task in tasks {
            let Some(when) = next(&task, from) else {
                continue;
            };
            if when > now {
                continue;
            }
            let k = key(&task, project)?;
            let occurrence = when.to_rfc3339();
            let claimed=conn.execute("INSERT INTO runs(task_key,occurrence,last_run,status,error) VALUES(?1,?2,?3,'running',NULL) ON CONFLICT(task_key) DO UPDATE SET occurrence=excluded.occurrence,last_run=excluded.last_run,status='running',error=NULL WHERE runs.occurrence != excluded.occurrence",params![k,occurrence,now.to_rfc3339()])?;
            if claimed == 0 {
                continue;
            }
            let data = data.to_owned();
            let project = project.map(str::to_owned);
            thread::spawn(move || {
                let result = run_action(&task, project.as_deref(), &data);
                if let Ok(conn) = db(&data) {
                    let (status, error) = match result {
                        Ok(()) => ("success", None),
                        Err(e) => ("failed", Some(format!("{e:#}"))),
                    };
                    let _ = conn.execute(
                        "UPDATE runs SET status=?1,error=?2 WHERE task_key=?3 AND occurrence=?4",
                        params![status, error, k, occurrence],
                    );
                }
            });
        }
    }
    Ok(())
}
pub fn start_scheduler(data: PathBuf) {
    thread::spawn(move || {
        let mut previous = Local::now();
        loop {
            thread::sleep(Duration::from_secs(1));
            let now = Local::now();
            if now >= previous && (now - previous).num_seconds() <= 5 {
                if let Err(e) = tick(&data, previous, now) {
                    eprintln!("[automation] {e:#}");
                }
            }
            previous = now;
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_scopes_and_system_validation() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let project = workspace.path().to_str().unwrap();
        let mut task = builtin();
        assert!(!task.enabled);
        task.scope = "project".into();
        task.id = "test".into();
        task.action = Action::Command {
            command: "echo test".into(),
        };
        save(data.path(), task, Some(project)).unwrap();
        assert_eq!(list(data.path(), Some(project)).unwrap().len(), 2);
        assert_eq!(list(data.path(), None).unwrap().len(), 1);
        assert!(projects(data.path(), &db(data.path()).unwrap())
            .unwrap()
            .iter()
            .any(|p| Path::new(p) == workspace.path().canonicalize().unwrap()));
        assert!(delete(data.path(), "system", "power", None).is_err());
        delete(data.path(), "project", "test", Some(project)).unwrap();
        assert_eq!(list(data.path(), Some(project)).unwrap().len(), 1);
    }
    #[test]
    fn project_index_and_history_filter_missing_and_deduplicate() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let history_only = tempfile::tempdir().unwrap();
        let conn = db(data.path()).unwrap();
        let original = workspace.path().to_string_lossy().into_owned();
        let missing = data.path().join("missing").to_string_lossy().into_owned();
        conn.execute("INSERT INTO projects(path) VALUES (?1)", [&original])
            .unwrap();
        conn.execute("INSERT INTO projects(path) VALUES (?1)", [&missing])
            .unwrap();
        let history = Connection::open(data.path().join("super-high.db")).unwrap();
        // Matches the real recent_projects schema in db.rs.
        history.execute_batch("CREATE TABLE recent_projects (path TEXT PRIMARY KEY, name TEXT NOT NULL, last_opened_at TEXT NOT NULL)").unwrap();
        let alternate = format!("{}/.", original.replace('\\', "/"));
        for path in [
            &alternate,
            &missing,
            &history_only.path().to_string_lossy().into_owned(),
        ] {
            history.execute("INSERT INTO recent_projects(path,name,last_opened_at) VALUES (?1,'test','2026-01-01')", [path]).unwrap();
        }
        #[cfg(windows)]
        {
            let alternate_case = original.to_uppercase();
            if alternate_case != original {
                history.execute("INSERT OR IGNORE INTO recent_projects(path,name,last_opened_at) VALUES (?1,'test','2026-01-01')", [&alternate_case]).unwrap();
            }
        }
        let paths = projects(data.path(), &conn).unwrap();
        assert_eq!(paths.len(), 2);
        assert!(paths
            .iter()
            .any(|p| Path::new(p) == workspace.path().canonicalize().unwrap()));
        assert!(paths
            .iter()
            .any(|p| Path::new(p) == history_only.path().canonicalize().unwrap()));
    }
    #[test]
    fn duplicate_tick_claims_only_one_occurrence() {
        use chrono::Timelike;
        let data = tempfile::tempdir().unwrap();
        let now = Local::now()
            .with_second(1)
            .unwrap()
            .with_nanosecond(0)
            .unwrap();
        let mut task = builtin();
        task.scope = "global".into();
        task.id = "claim-test".into();
        task.enabled = true;
        task.schedule = Schedule::Daily {
            time: now.format("%H:%M").to_string(),
        };
        task.action = Action::Command {
            command: "exit 0".into(),
        };
        save(data.path(), task, None).unwrap();
        let from = now - chrono::Duration::seconds(2);
        tick(data.path(), from, now).unwrap();
        tick(data.path(), from, now).unwrap();
        let conn = db(data.path()).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM runs WHERE task_key LIKE '%claim-test'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        for _ in 0..50 {
            let status: String = conn
                .query_row(
                    "SELECT status FROM runs WHERE task_key LIKE '%claim-test'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            if status != "running" {
                assert_eq!(status, "success");
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        panic!("safe command did not finish");
    }
    #[test]
    fn disabled_once_accepts_past_time_but_enabled_rejects_it() {
        let data = tempfile::tempdir().unwrap();
        let mut task = builtin();
        task.schedule = Schedule::Once {
            at: (Local::now() - chrono::Duration::days(1))
                .format("%Y-%m-%dT%H:%M")
                .to_string(),
        };
        save(data.path(), task.clone(), None).unwrap();
        task.enabled = true;
        assert!(save(data.path(), task, None).is_err());
    }
    #[test]
    fn expired_once_does_not_run_and_daily_is_future() {
        let now = Local::now();
        let mut task = builtin();
        task.enabled = true;
        task.schedule = Schedule::Once {
            at: (now - chrono::Duration::days(1))
                .format("%Y-%m-%dT%H:%M")
                .to_string(),
        };
        assert!(next(&task, now).is_none());
        task.schedule = Schedule::Daily {
            time: "12:00".into(),
        };
        assert!(next(&task, now).unwrap() > now);
        task.action = Action::Command {
            command: "echo test".into(),
        };
        assert!(validate(&task).is_err());
    }
}
