use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::Context;
use rusqlite::{params, Connection, OptionalExtension, Row};
use tauri::Manager;
use uuid::Uuid;

use crate::models::{AppSettings, MemoRecord, RecentProject};

pub struct AppDb {
    connection: Mutex<Connection>,
}

impl AppDb {
    pub fn new(base_dir: &Path) -> anyhow::Result<Self> {
        fs::create_dir_all(base_dir).context("failed to create app data directory")?;
        let db_path = base_dir.join("super-high.db");
        let connection = Connection::open(db_path).context("failed to open sqlite database")?;
        let db = Self {
            connection: Mutex::new(connection),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> anyhow::Result<()> {
        let connection = self.connection.lock().unwrap();
        connection.execute_batch(
            r#"
      CREATE TABLE IF NOT EXISTS recent_projects (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mobile_host_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS memos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memos_created_at ON memos(created_at DESC);

      CREATE TABLE IF NOT EXISTS cli_history_files (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cli_history_file_cursors (
        path TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        cwd TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS cli_history_messages (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_cli_history_messages_ts ON cli_history_messages(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_cli_history_messages_file ON cli_history_messages(file_path);

      CREATE TABLE IF NOT EXISTS cli_history_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      "#,
        )?;
        Ok(())
    }

    pub fn with_connection<T>(
        &self,
        f: impl FnOnce(&Connection) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let connection = self.connection.lock().unwrap();
        f(&connection)
    }

    pub fn list_recent_projects(&self) -> anyhow::Result<Vec<RecentProject>> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare(
      "SELECT path, name, last_opened_at FROM recent_projects ORDER BY last_opened_at DESC LIMIT 12",
    )?;
        let rows = statement.query_map([], |row| {
            Ok(RecentProject {
                path: row.get(0)?,
                name: row.get(1)?,
                last_opened_at: row.get(2)?,
            })
        })?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        Ok(items)
    }

    pub fn upsert_recent_project(&self, project: &RecentProject) -> anyhow::Result<()> {
        let connection = self.connection.lock().unwrap();
        connection.execute(
            r#"
      INSERT INTO recent_projects (path, name, last_opened_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(path) DO UPDATE SET
        name = excluded.name,
        last_opened_at = excluded.last_opened_at
      "#,
            params![project.path, project.name, project.last_opened_at],
        )?;
        Ok(())
    }

    pub fn remove_recent_project(&self, path: &str) -> anyhow::Result<()> {
        let connection = self.connection.lock().unwrap();
        connection.execute("DELETE FROM recent_projects WHERE path = ?1", params![path])?;
        Ok(())
    }

    pub fn mobile_host_enabled(&self) -> anyhow::Result<bool> {
        self.with_connection(|connection| {
            Ok(connection
                .query_row("SELECT enabled FROM mobile_host_state WHERE id = 1", [], |row| {
                    row.get(0)
                })
                .optional()?
                .unwrap_or(false))
        })
    }

    pub fn set_mobile_host_enabled(&self, enabled: bool) -> anyhow::Result<()> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO mobile_host_state (id, enabled) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled",
                params![enabled],
            )?;
            Ok(())
        })
    }

    pub fn load_settings(&self) -> anyhow::Result<AppSettings> {
        let connection = self.connection.lock().unwrap();
        let json: Option<String> = connection
            .query_row("SELECT json FROM app_settings WHERE id = 1", [], |row| {
                row.get(0)
            })
            .ok();
        if let Some(value) = json {
            Ok(serde_json::from_str(&value).context("failed to deserialize settings")?)
        } else {
            Ok(AppSettings::default())
        }
    }

    pub fn patch_mobile_preferences(&self, theme_id: Option<String>, hidden_cli_provider_ids: Option<Vec<String>>) -> anyhow::Result<AppSettings> {
        let connection = self.connection.lock().unwrap();
        let json: Option<String> = connection.query_row("SELECT json FROM app_settings WHERE id = 1", [], |row| row.get(0)).optional()?;
        let mut value = match json {
            Some(json) => serde_json::from_str::<serde_json::Value>(&json)?,
            None => serde_json::to_value(AppSettings::default())?,
        };
        let object = value.as_object_mut().context("settings must be an object")?;
        if let Some(theme_id) = theme_id { object.insert("themeId".into(), serde_json::json!(theme_id)); }
        if let Some(ids) = hidden_cli_provider_ids { object.insert("hiddenCliProviderIds".into(), serde_json::json!(ids)); }
        let settings: AppSettings = serde_json::from_value(value.clone())?;
        connection.execute("INSERT INTO app_settings (id, json) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET json = excluded.json", params![serde_json::to_string(&value)?])?;
        Ok(settings)
    }

    pub fn save_settings(&self, settings: &AppSettings) -> anyhow::Result<AppSettings> {
        let connection = self.connection.lock().unwrap();
        let json = serde_json::to_string(settings)?;
        connection.execute(
            r#"
      INSERT INTO app_settings (id, json) VALUES (1, ?1)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json
      "#,
            params![json],
        )?;
        Ok(settings.clone())
    }

    pub fn list_memos(
        &self,
        query: Option<&str>,
        created_from: Option<&str>,
        created_before: Option<&str>,
    ) -> anyhow::Result<Vec<MemoRecord>> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare(
            r#"
            SELECT id, title, content, created_at, updated_at
            FROM memos
            WHERE (
                ?1 IS NULL
                OR instr(title, ?1) > 0
                OR instr(content, ?1) > 0
                OR instr(created_at, ?1) > 0
            )
            AND (?2 IS NULL OR created_at >= ?2)
            AND (?3 IS NULL OR created_at < ?3)
            ORDER BY created_at DESC, id DESC
            "#,
        )?;
        let rows =
            statement.query_map(params![query, created_from, created_before], memo_from_row)?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        Ok(items)
    }

    pub fn create_memo(&self) -> anyhow::Result<MemoRecord> {
        let now = memo_now();
        let memo = MemoRecord {
            id: Uuid::new_v4().to_string(),
            title: String::new(),
            content: String::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        let connection = self.connection.lock().unwrap();
        connection.execute(
            r#"
            INSERT INTO memos (id, title, content, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![
                memo.id,
                memo.title,
                memo.content,
                memo.created_at,
                memo.updated_at,
            ],
        )?;
        Ok(memo)
    }

    pub fn update_memo(&self, id: &str, title: &str, content: &str) -> anyhow::Result<MemoRecord> {
        let updated_at = memo_now();
        let connection = self.connection.lock().unwrap();
        let changed = connection.execute(
            "UPDATE memos SET title = ?2, content = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, title, content, updated_at],
        )?;
        if changed == 0 {
            anyhow::bail!("memo not found: {id}");
        }
        Ok(connection.query_row(
            "SELECT id, title, content, created_at, updated_at FROM memos WHERE id = ?1",
            params![id],
            memo_from_row,
        )?)
    }

    pub fn delete_memo(&self, id: &str) -> anyhow::Result<()> {
        let connection = self.connection.lock().unwrap();
        connection.execute("DELETE FROM memos WHERE id = ?1", params![id])?;
        Ok(())
    }
}

fn memo_from_row(row: &Row<'_>) -> rusqlite::Result<MemoRecord> {
    Ok(MemoRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn memo_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn app_data_dir(app_handle: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let base = app_handle
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory")?;
    Ok(base)
}

#[cfg(test)]
mod tests {
    use super::AppDb;
    use rusqlite::params;

    #[test]
    fn mobile_host_enabled_survives_restart_and_settings_save() {
        let directory = tempfile::tempdir().unwrap();
        let db = AppDb::new(directory.path()).unwrap();
        assert!(!db.mobile_host_enabled().unwrap());
        let mut settings = db.load_settings().unwrap();
        settings.mobile_host.port = 10321;
        settings.mobile_host.token = "paired-token".into();
        db.save_settings(&settings).unwrap();
        db.set_mobile_host_enabled(true).unwrap();
        db.save_settings(&settings).unwrap();
        drop(db);

        let db = AppDb::new(directory.path()).unwrap();
        assert!(db.mobile_host_enabled().unwrap());
        assert_eq!(db.load_settings().unwrap().mobile_host, settings.mobile_host);
        db.set_mobile_host_enabled(false).unwrap();
        drop(db);

        let db = AppDb::new(directory.path()).unwrap();
        assert!(!db.mobile_host_enabled().unwrap());
        assert_eq!(db.load_settings().unwrap().mobile_host, settings.mobile_host);
    }

    #[test]
    fn mobile_host_migration_keeps_old_installations_disabled() {
        let directory = tempfile::tempdir().unwrap();
        let connection = rusqlite::Connection::open(directory.path().join("super-high.db")).unwrap();
        connection.execute_batch("CREATE TABLE app_settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL); INSERT INTO app_settings (id, json) VALUES (1, '{}');").unwrap();
        drop(connection);

        let db = AppDb::new(directory.path()).unwrap();
        assert!(!db.mobile_host_enabled().unwrap());
        assert!(db.load_settings().is_ok());
    }

    fn insert_memo(db: &AppDb, id: &str, title: &str, content: &str, created_at: &str) {
        let connection = db.connection.lock().unwrap();
        connection
            .execute(
                "INSERT INTO memos (id, title, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                params![id, title, content, created_at],
            )
            .unwrap();
    }

    #[test]
    fn memo_crud_preserves_created_at_when_updating_title() {
        let directory = tempfile::tempdir().unwrap();
        let db = AppDb::new(directory.path()).unwrap();

        let created = db.create_memo().unwrap();
        assert!(created.title.is_empty());
        assert!(created.content.is_empty());
        assert_eq!(created.updated_at, created.created_at);

        let updated = db
            .update_memo(&created.id, "整理后的标题", "备忘正文")
            .unwrap();
        assert_eq!(updated.title, "整理后的标题");
        assert_eq!(updated.content, "备忘正文");
        assert_eq!(updated.created_at, created.created_at);

        let matches = db.list_memos(Some("整理后的标题"), None, None).unwrap();
        assert_eq!(matches, vec![updated]);

        db.delete_memo(&created.id).unwrap();
        assert!(db.list_memos(None, None, None).unwrap().is_empty());
    }

    #[test]
    fn memo_filters_use_literal_query_and_half_open_time_range() {
        let directory = tempfile::tempdir().unwrap();
        let db = AppDb::new(directory.path()).unwrap();
        insert_memo(&db, "before", "旧记录", "", "2026-07-09T23:59:59Z");
        insert_memo(
            &db,
            "start",
            "含百分号 100%",
            "起始日",
            "2026-07-10T00:00:00Z",
        );
        insert_memo(&db, "inside", "已改标题", "范围内", "2026-07-20T23:59:59Z");
        insert_memo(&db, "boundary", "下一日", "", "2026-07-21T00:00:00Z");

        let range = db
            .list_memos(
                None,
                Some("2026-07-10T00:00:00Z"),
                Some("2026-07-21T00:00:00Z"),
            )
            .unwrap();
        assert_eq!(
            range
                .iter()
                .map(|memo| memo.id.as_str())
                .collect::<Vec<_>>(),
            vec!["inside", "start"]
        );

        let literal_percent = db.list_memos(Some("%"), None, None).unwrap();
        assert_eq!(literal_percent.len(), 1);
        assert_eq!(literal_percent[0].id, "start");

        let created_at_match = db.list_memos(Some("2026-07-20"), None, None).unwrap();
        assert_eq!(created_at_match.len(), 1);
        assert_eq!(created_at_match[0].id, "inside");
    }

    #[test]
    fn mobile_preferences_patch_preserves_other_and_unknown_fields() {
        let directory = tempfile::tempdir().unwrap();
        let db = AppDb::new(directory.path()).unwrap();
        db.connection.lock().unwrap().execute("INSERT INTO app_settings (id, json) VALUES (1, ?1)", params![r#"{"themeId":"old","hiddenCliProviderIds":["gemini"],"futureSetting":{"keep":true}}"#]).unwrap();
        let settings = db.patch_mobile_preferences(Some("new".into()), None).unwrap();
        assert_eq!(settings.theme_id, "new");
        assert_eq!(settings.hidden_cli_provider_ids, vec!["gemini"]);
        let settings = db.patch_mobile_preferences(None, Some(vec![])).unwrap();
        assert_eq!(settings.theme_id, "new");
        assert!(settings.hidden_cli_provider_ids.is_empty());
        let json: String = db.connection.lock().unwrap().query_row("SELECT json FROM app_settings WHERE id = 1", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&json).unwrap()["futureSetting"]["keep"], true);
    }

    #[test]
    fn old_settings_without_memo_frame_use_default_geometry() {
        let directory = tempfile::tempdir().unwrap();
        let db = AppDb::new(directory.path()).unwrap();
        {
            let connection = db.connection.lock().unwrap();
            connection
                .execute("INSERT INTO app_settings (id, json) VALUES (1, '{}')", [])
                .unwrap();
        }

        let settings = db.load_settings().unwrap();
        assert_eq!(settings.memo_window_frame.left, None);
        assert_eq!(settings.memo_window_frame.top, None);
        assert_eq!(settings.memo_window_frame.width, 760.0);
        assert_eq!(settings.memo_window_frame.height, 620.0);
    }
}
