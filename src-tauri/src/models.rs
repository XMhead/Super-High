use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub root_path: String,
    pub opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: FileEntryType,
    pub extension: Option<String>,
    pub size: Option<u64>,
    pub modified: Option<u64>,
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileEntryType {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationResult {
    pub source_path: String,
    pub target_path: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileMatch {
    pub path: String,
    pub relative_path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchMatch {
    pub path: String,
    pub relative_path: String,
    pub line_number: usize,
    pub column: usize,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchResult {
    pub files: Vec<ProjectFileMatch>,
    pub text_matches: Vec<TextSearchMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchOptions {
    #[serde(default = "default_project_search_include_text")]
    pub include_text: bool,
    #[serde(default)]
    pub file_name_only: bool,
    #[serde(default = "default_project_search_limit")]
    pub limit: usize,
}

impl Default for ProjectSearchOptions {
    fn default() -> Self {
        Self {
            include_text: default_project_search_include_text(),
            file_name_only: false,
            limit: default_project_search_limit(),
        }
    }
}

fn default_project_search_include_text() -> bool {
    true
}

fn default_project_search_limit() -> usize {
    80
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFilesChangedEvent {
    pub root_path: String,
    pub changed_paths: Vec<String>,
    pub affected_directories: Vec<String>,
    pub kind: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWatchTarget {
    pub root_path: String,
    pub directories: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectInstructionFileKind {
    Agents,
    Claude,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionFileStatus {
    pub kind: ProjectInstructionFileKind,
    pub file_name: String,
    pub file_path: String,
    pub exists: bool,
    pub size_bytes: u64,
    pub line_count: usize,
    pub modified: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionFiles {
    pub project_path: String,
    pub files: Vec<ProjectInstructionFileStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionMigrationResult {
    pub source_kind: ProjectInstructionFileKind,
    pub target_kind: ProjectInstructionFileKind,
    pub source_path: String,
    pub target_path: String,
    pub copied: bool,
    pub skipped: bool,
    pub overwritten: bool,
    pub backup_path: Option<String>,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickPhrase {
    pub id: String,
    pub title: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoRecord {
    pub id: String,
    pub title: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelLayout {
    #[serde(default = "default_conversation_width")]
    pub conversation_width: f64,
    #[serde(default = "default_explorer_width")]
    pub explorer_width: f64,
    #[serde(default = "default_preview_width")]
    pub preview_width: f64,
    #[serde(default = "default_terminal_height")]
    pub terminal_height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoWindowFrame {
    #[serde(default)]
    pub left: Option<f64>,
    #[serde(default)]
    pub top: Option<f64>,
    #[serde(default = "default_memo_window_width")]
    pub width: f64,
    #[serde(default = "default_memo_window_height")]
    pub height: f64,
}

impl Default for MemoWindowFrame {
    fn default() -> Self {
        Self {
            left: None,
            top: None,
            width: default_memo_window_width(),
            height: default_memo_window_height(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelProviderKind {
    Claude,
    Codex,
    Dsh,
    Gemini,
    Grok,
    Opencode,
}

/// 渠道上游 API 格式（参照 cc-switch 的 apiFormat）：
/// - Anthropic：Anthropic Messages（Claude Code 原生），路径 /v1/messages，请求体 messages[]，鉴权 x-api-key
/// - OpenaiResponses：OpenAI Responses（Codex 原生），路径 /v1/responses，请求体 input，鉴权 Bearer
/// - OpenaiChat：OpenAI Chat Completions（兼容格式），路径 /v1/chat/completions，请求体 messages[]，鉴权 Bearer
/// - GeminiNative：Gemini generateContent，路径 /v1beta/models/{model}:generateContent，请求体 contents[]，鉴权 x-goog-api-key
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelApiFormat {
    Anthropic,
    OpenaiResponses,
    OpenaiChat,
    GeminiNative,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConfig {
    pub id: String,
    pub name: String,
    pub provider: ChannelProviderKind,
    #[serde(default)]
    pub website_url: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub api_format: Option<ChannelApiFormat>,
    /// 鉴权头风格（对齐 cc-switch）：claude 的 ANTHROPIC_AUTH_TOKEN 走 Bearer、
    /// ANTHROPIC_API_KEY 走 x-api-key；codex / dsh 走 Bearer。未设置保持旧的 x-api-key 行为。
    #[serde(default)]
    pub api_key_auth: Option<String>,
    /// dsh 渠道绑定的分组（profile）id；模型默认值跟随该分组最新默认模型。
    #[serde(default)]
    pub dsh_profile: Option<String>,
    /// dsh 渠道绑定的供应商（llm-pi-ai.providers 的 id）；供应商切换时接口地址跟随。
    #[serde(default)]
    pub dsh_provider: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelProbeResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub endpoint: String,
    pub reply: String,
    pub error: String,
    pub status: u16,
}

/// 单条 URL 的纯网络延迟检测结果（不发送任何业务请求）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointLatencyResult {
    pub url: String,
    pub label: String,
    pub latency_ms: Option<u64>,
    pub status: Option<u16>,
    pub error: Option<String>,
}

/// 从 OpenAI 兼容的 /v1/models 接口获取到的模型。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
    pub owned_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_theme_id")]
    pub theme_id: String,
    #[serde(default)]
    pub disabled_plugin_ids: Vec<String>,
    #[serde(default)]
    pub hidden_project_paths: Vec<String>,
    #[serde(default)]
    pub project_nicknames: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub project_categories: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub quick_phrases: Vec<QuickPhrase>,
    #[serde(default = "default_preview_mode")]
    pub active_preview_mode: String,
    #[serde(default)]
    pub multi_terminal_mode: bool,
    #[serde(default)]
    pub dialogue_map_mode: bool,
    #[serde(default)]
    pub dialogue_map_by_workspace: std::collections::HashMap<String, DialogueMapWorkspaceState>,
    #[serde(default = "default_project_layout_mode")]
    pub project_layout_mode: String,
    #[serde(default)]
    pub render_color_codes: bool,
    #[serde(default)]
    pub yaml_key_value_panel_enabled: bool,
    #[serde(default = "default_html_preview_enabled")]
    pub html_preview_enabled: bool,
    #[serde(default = "default_auto_save")]
    pub auto_save: String,
    #[serde(default = "default_auto_save_delay")]
    pub auto_save_delay: u64,
    #[serde(default)]
    pub panel_layout: PanelLayout,
    #[serde(default)]
    pub mobile_host: MobileHostConfig,
    #[serde(default)]
    pub memo_window_frame: MemoWindowFrame,
    #[serde(default)]
    pub channels: Vec<ChannelConfig>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme_id: default_theme_id(),
            disabled_plugin_ids: Vec::new(),
            hidden_project_paths: Vec::new(),
            project_nicknames: std::collections::HashMap::new(),
            project_categories: std::collections::HashMap::new(),
            quick_phrases: Vec::new(),
            active_preview_mode: default_preview_mode(),
            multi_terminal_mode: false,
            dialogue_map_mode: false,
            dialogue_map_by_workspace: std::collections::HashMap::new(),
            project_layout_mode: default_project_layout_mode(),
            render_color_codes: false,
            yaml_key_value_panel_enabled: false,
            html_preview_enabled: default_html_preview_enabled(),
            auto_save: default_auto_save(),
            auto_save_delay: default_auto_save_delay(),
            panel_layout: PanelLayout {
                conversation_width: default_conversation_width(),
                explorer_width: default_explorer_width(),
                preview_width: default_preview_width(),
                terminal_height: default_terminal_height(),
            },
            mobile_host: MobileHostConfig::default(),
            memo_window_frame: MemoWindowFrame::default(),
            channels: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogueMapViewport {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default = "default_dialogue_map_zoom")]
    pub zoom: f64,
}

impl Default for DialogueMapViewport {
    fn default() -> Self {
        Self {
            x: 72.0,
            y: 72.0,
            zoom: default_dialogue_map_zoom(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DialogueMapPosition {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DialogueMapWorkspaceState {
    #[serde(default)]
    pub viewport: DialogueMapViewport,
    #[serde(default)]
    pub positions: std::collections::HashMap<String, DialogueMapPosition>,
}

fn default_dialogue_map_zoom() -> f64 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileHostConfig {
    #[serde(default = "default_mobile_host_port")]
    pub port: u16,
    #[serde(default)]
    pub token: String,
}

impl Default for MobileHostConfig {
    fn default() -> Self {
        Self {
            port: default_mobile_host_port(),
            token: String::new(),
        }
    }
}

fn default_mobile_host_port() -> u16 {
    10320
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileHostStatus {
    pub running: bool,
    pub bind: String,
    pub port: u16,
    pub token: String,
    pub urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileHostApiStatus {
    pub status: String,
    pub app_name: String,
    pub server_time: u64,
    pub recent_project_count: usize,
}

impl Default for PanelLayout {
    fn default() -> Self {
        Self {
            conversation_width: default_conversation_width(),
            explorer_width: default_explorer_width(),
            preview_width: default_preview_width(),
            terminal_height: default_terminal_height(),
        }
    }
}

fn default_theme_id() -> String {
    "dark".to_string()
}

fn default_preview_mode() -> String {
    "local_terminal".to_string()
}

fn default_project_layout_mode() -> String {
    "default".to_string()
}

fn default_html_preview_enabled() -> bool {
    true
}

fn default_auto_save() -> String {
    "off".to_string()
}

fn default_auto_save_delay() -> u64 {
    1000
}

fn default_conversation_width() -> f64 {
    520.0
}

fn default_explorer_width() -> f64 {
    240.0
}

fn default_preview_width() -> f64 {
    520.0
}

fn default_terminal_height() -> f64 {
    250.0
}

fn default_memo_window_width() -> f64 {
    760.0
}

fn default_memo_window_height() -> f64 {
    620.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliProviderEnvironment {
    pub provider_kind: String,
    pub name: String,
    pub command: String,
    pub available: bool,
    pub resolved_path: Option<String>,
    pub launcher: String,
    pub source: Option<String>,
    pub issue: Option<String>,
    pub checked_locations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStorageInfo {
    pub data_dir: String,
    pub database_path: String,
    pub database_size_bytes: u64,
    pub super_high_root: String,
    pub global_library_root: String,
    pub global_plugins_dir: String,
    pub plugin_log_path: String,
    pub plugin_disable_flag_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VitePressDocsInfo {
    pub project_path: String,
    pub docs_root: String,
    pub url: String,
    pub port: u16,
    pub running: bool,
    pub started_by_super_high: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionDto {
    pub id: String,
    pub title: String,
    pub provider_kind: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub chunk: String,
    pub start_byte: u64,
    pub end_byte: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBufferSnapshot {
    pub buffer: String,
    pub start_byte: u64,
    pub end_byte: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCliTranscript {
    pub provider: String,
    /// Codex SessionMeta.id: the conversation/thread identity also encoded in normal rollout filenames.
    pub native_thread_id: String,
    pub source_path: String,
    /// A bounded, selected evidence view; never a raw copy of the entire rollout.
    pub transcript: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliNativeConversationSummary {
    pub id: String,
    pub provider_kind: String,
    pub native_session_id: Option<String>,
    pub title: String,
    pub summary: String,
    pub cwd: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: u32,
    pub source_path: String,
    pub resume_supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliNativeConversationMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliNativeConversationDetail {
    #[serde(flatten)]
    pub summary: CliNativeConversationSummary,
    pub messages: Vec<CliNativeConversationMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliHistoryMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliHistoryPath {
    pub path: String,
    pub count: u32,
    pub last_index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliHistorySnapshot {
    pub messages: Vec<CliHistoryMessage>,
    pub paths: Vec<CliHistoryPath>,
    pub scanned_files: u32,
    pub indexed_files: u32,
    pub indexed_messages: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginWorkspaceContext {
    pub name: String,
    pub display_name: String,
    pub root_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEnvironment {
    pub plugin_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_plugin_root: Option<String>,
    pub disable_flag_path: String,
    pub log_path: String,
    pub all_disabled: bool,
    pub disabled_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginRuntimeStatus {
    Matched,
    NotMatched,
    Disabled,
    ManifestError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginSource {
    Global,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
    pub id: String,
    pub name: String,
    pub version: String,
    pub root_path: String,
    pub main: String,
    pub main_path: String,
    pub style: Option<String>,
    pub style_path: Option<String>,
    pub source: PluginSource,
    pub permissions: Vec<String>,
    #[serde(rename = "unsafe")]
    pub unsafe_enabled: bool,
    pub status: PluginRuntimeStatus,
    pub match_reason: Option<String>,
    pub disabled_reason: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListResponse {
    pub environment: PluginEnvironment,
    pub plugins: Vec<PluginDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginShellExecRequest {
    pub command: String,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginShellExecResult {
    pub command: String,
    pub cwd: Option<String>,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub main: String,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub activation: Option<PluginActivationCondition>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default, rename = "unsafe")]
    pub unsafe_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum PluginActivationCondition {
    WorkspaceName {
        #[serde(rename = "workspaceName")]
        workspace_name: String,
    },
    WorkspacePathIncludes {
        #[serde(rename = "workspacePathIncludes")]
        workspace_path_includes: String,
    },
    Exists {
        exists: String,
    },
    All {
        all: Vec<PluginActivationCondition>,
    },
    Any {
        any: Vec<PluginActivationCondition>,
    },
}
