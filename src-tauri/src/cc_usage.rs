//! 使用统计（只读，数据源 = cc-switch 的 proxy_request_logs + usage_daily_rollups）。
//!
//! 统计口径沿用 cc-switch 4.0.16 的 `services/usage_stats.rs` 与 `services/sql_helpers.rs`：
//! - 输入 Token 按 `input_token_semantics` 归一成新增输入，codex / gemini / grokbuild
//!   存储的输入含缓存，需扣除；总量 = 新增输入 + 输出 + 缓存写入 + 缓存命中。
//! - 会话日志导入行与成功的代理行在 10 分钟内 Token、模型一致时视为同一请求，只计代理行。
//! - 明细约保留 30 天，更早的已按天汇总进 usage_daily_rollups 并删除明细，两表直接合并。
//! - 模型按「有效计价模型」分组：pricing_model 非空优先，否则回落 model。
//!
//! 这里只按「本地日期 × 模型」分桶，摘要、连续天数和热力图由前端从同一份日序列计算。

use rusqlite::Connection;
use serde::Serialize;

use crate::cc_switch;

/// 存储的 input_tokens 已含缓存读写的应用（cc-switch `CACHE_INCLUSIVE_APP_TYPES`）。
const CACHE_INCLUSIVE_APP_TYPES: &str = "'codex', 'gemini', 'grokbuild'";
/// 参与跨源去重的会话日志来源（cc-switch `DEDUP_SESSION_SOURCES_SQL`）。
const SESSION_SOURCES: &str = "'session_log', 'codex_session', 'gemini_session', 'opencode_session'";
/// 会话行与代理行判定为同一请求的时间窗口（cc-switch `SESSION_PROXY_DEDUP_WINDOW_SECONDS`）。
const DEDUP_WINDOW_SECONDS: i64 = 10 * 60;

/// 某个本地日期下某个模型的用量；输入已归一为新增输入。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageDailyModelRow {
    pub date: String,
    pub model: String,
    pub request_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsResponse {
    /// cc-switch 数据库存在且可读。
    pub available: bool,
    pub daily: Vec<UsageDailyModelRow>,
    /// 会话日志里同一会话首尾请求的最大间隔；只覆盖仍保留明细的约 30 天。
    pub longest_session_ms: i64,
    pub error: Option<String>,
}

pub fn load_usage_stats() -> UsageStatsResponse {
    let Some(conn) = cc_switch::open_readonly() else {
        return UsageStatsResponse::default();
    };
    match query_usage_stats(&conn) {
        Ok(response) => response,
        Err(error) => UsageStatsResponse {
            available: true,
            error: Some(format!("读取 cc-switch 用量失败：{error}")),
            ..UsageStatsResponse::default()
        },
    }
}

/// 单行的新增输入 Token（cc-switch `fresh_input_sql`）。
fn fresh_input_sql(alias: &str) -> String {
    format!(
        "CASE \
           WHEN {a}.input_token_semantics = 2 THEN {a}.input_tokens \
           WHEN {a}.app_type IN ({CACHE_INCLUSIVE_APP_TYPES}) AND {a}.input_token_semantics = 1 \
                AND {a}.input_tokens >= ({a}.cache_read_tokens + {a}.cache_creation_tokens) \
           THEN {a}.input_tokens - {a}.cache_read_tokens - {a}.cache_creation_tokens \
           WHEN {a}.app_type IN ({CACHE_INCLUSIVE_APP_TYPES}) AND {a}.input_token_semantics = 0 \
                AND {a}.input_tokens >= {a}.cache_read_tokens \
           THEN {a}.input_tokens - {a}.cache_read_tokens \
           ELSE {a}.input_tokens END",
        a = alias
    )
}

/// 与成功代理行重复的会话日志行（cc-switch `effective_usage_log_filter_for_range` 的子查询）。
fn duplicate_session_rows_sql() -> String {
    format!(
        "SELECT s.rowid FROM proxy_request_logs p \
         JOIN proxy_request_logs s \
           ON s.app_type IN (p.app_type, CASE WHEN p.app_type = 'claude-desktop' THEN 'claude' ELSE p.app_type END) \
          AND COALESCE(s.data_source, 'proxy') IN ({SESSION_SOURCES}) \
          AND s.input_tokens = p.input_tokens \
          AND s.output_tokens = p.output_tokens \
          AND s.cache_read_tokens = p.cache_read_tokens \
          AND s.created_at BETWEEN p.created_at - {DEDUP_WINDOW_SECONDS} AND p.created_at + {DEDUP_WINDOW_SECONDS} \
          AND ( \
                p.cache_creation_tokens = s.cache_creation_tokens \
                OR (s.cache_creation_tokens = 0 AND COALESCE(s.data_source, 'proxy') IN ('codex_session', 'gemini_session', 'opencode_session')) \
                OR (p.cache_creation_tokens = 0 AND p.input_token_semantics = 0 AND COALESCE(s.data_source, 'proxy') = 'codex_session') \
          ) \
          AND (LOWER(p.model) = LOWER(s.model) OR LOWER(p.model) = 'unknown' OR LOWER(s.model) = 'unknown') \
         WHERE COALESCE(p.data_source, 'proxy') = 'proxy' AND p.status_code >= 200 AND p.status_code < 300"
    )
}

fn query_usage_stats(conn: &Connection) -> rusqlite::Result<UsageStatsResponse> {
    let detail_input = fresh_input_sql("l");
    let rollup_input = fresh_input_sql("r");
    let duplicates = duplicate_session_rows_sql();
    let sql = format!(
        "SELECT day, model, SUM(requests), SUM(input), SUM(output), SUM(cache_creation), SUM(cache_read) FROM ( \
           SELECT date(l.created_at, 'unixepoch', 'localtime') AS day, \
                  COALESCE(NULLIF(l.pricing_model, ''), l.model) AS model, \
                  COUNT(*) AS requests, SUM({detail_input}) AS input, SUM(l.output_tokens) AS output, \
                  SUM(l.cache_creation_tokens) AS cache_creation, SUM(l.cache_read_tokens) AS cache_read \
           FROM proxy_request_logs l WHERE l.rowid NOT IN ({duplicates}) GROUP BY day, model \
           UNION ALL \
           SELECT r.date, COALESCE(NULLIF(r.pricing_model, ''), r.model), \
                  SUM(r.request_count), SUM({rollup_input}), SUM(r.output_tokens), \
                  SUM(r.cache_creation_tokens), SUM(r.cache_read_tokens) \
           FROM usage_daily_rollups r GROUP BY r.date, 2 \
         ) GROUP BY day, model ORDER BY day, model"
    );
    let mut stmt = conn.prepare(&sql)?;
    let daily = stmt
        .query_map([], |row| {
            Ok(UsageDailyModelRow {
                date: row.get(0)?,
                model: row.get(1)?,
                request_count: row.get(2)?,
                input_tokens: row.get(3)?,
                output_tokens: row.get(4)?,
                cache_creation_tokens: row.get(5)?,
                cache_read_tokens: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let longest_session_seconds: i64 = conn.query_row(
        &format!(
            "SELECT COALESCE(MAX(span), 0) FROM ( \
               SELECT MAX(created_at) - MIN(created_at) AS span FROM proxy_request_logs \
               WHERE COALESCE(data_source, 'proxy') IN ({SESSION_SOURCES}) \
                 AND session_id IS NOT NULL AND session_id <> '' \
               GROUP BY app_type, session_id)"
        ),
        [],
        |row| row.get(0),
    )?;

    Ok(UsageStatsResponse {
        available: true,
        daily,
        longest_session_ms: longest_session_seconds.saturating_mul(1000),
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE proxy_request_logs (
                request_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL, model TEXT NOT NULL,
                pricing_model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                input_token_semantics INTEGER NOT NULL DEFAULT 0, status_code INTEGER NOT NULL, session_id TEXT,
                created_at INTEGER NOT NULL, data_source TEXT NOT NULL DEFAULT 'proxy'
            );
            CREATE TABLE usage_daily_rollups (
                date TEXT NOT NULL, app_type TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
                pricing_model TEXT NOT NULL DEFAULT '', request_count INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                input_token_semantics INTEGER NOT NULL DEFAULT 0
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn merges_details_and_rollups_with_cc_switch_rules() {
        let conn = test_conn();
        let t = 1_780_000_000_i64;
        conn.execute_batch(&format!(
            "INSERT INTO proxy_request_logs VALUES
               ('p1', 'x', 'codex', 'gpt-x', NULL, 1000, 100, 400, 0, 1, 200, NULL, {t}, 'proxy'),
               ('s-dup', 'x', 'codex', 'gpt-x', NULL, 1000, 100, 400, 0, 1, 200, 'c1', {t1}, 'codex_session'),
               ('s1', 'x', 'claude', 'claude-raw', 'claude-y', 50, 10, 200, 30, 0, 200, 's1', {t}, 'session_log'),
               ('s2', 'x', 'claude', 'claude-raw', 'claude-y', 50, 10, 200, 30, 0, 200, 's1', {t2}, 'session_log');
             INSERT INTO usage_daily_rollups VALUES ('2020-01-01', 'claude', 'x', 'old', '', 5, 10, 5, 0, 0, 2);",
            t1 = t + 60,
            t2 = t + 3600,
        ))
        .unwrap();

        let stats = query_usage_stats(&conn).unwrap();
        assert!(stats.available);
        assert_eq!(stats.longest_session_ms, 3_600_000);

        let find = |model: &str| stats.daily.iter().filter(|row| row.model == model).collect::<Vec<_>>();
        let codex = find("gpt-x");
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].request_count, 1, "重复的会话日志行不计入");
        assert_eq!(codex[0].input_tokens, 600, "codex 输入扣除缓存命中");
        assert_eq!(codex[0].cache_read_tokens, 400);

        let claude = find("claude-y");
        assert_eq!(claude.iter().map(|row| row.request_count).sum::<i64>(), 2);
        assert_eq!(claude.iter().map(|row| row.input_tokens).sum::<i64>(), 100);
        assert_eq!(claude.iter().map(|row| row.cache_creation_tokens).sum::<i64>(), 60);

        let old = find("old");
        assert_eq!(old.len(), 1);
        assert_eq!(old[0].date, "2020-01-01");
        assert_eq!(old[0].request_count, 5);
        assert_eq!(stats.daily.first().map(|row| row.date.as_str()), Some("2020-01-01"));
    }
}
