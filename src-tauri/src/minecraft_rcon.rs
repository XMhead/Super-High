use std::{
    fs,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

const SUPERHIGH_RCON_CONFIG: &str = "minecraft-rcon.json";
const BLACKBOXPRO_ENV_CONFIG: &str = "blackboxpro-env.json";
const DEFAULT_RCON_HOST: &str = "127.0.0.1";
const DEFAULT_ITEM_GIVE_TEMPLATE: &str = "ni give {player} {itemKey} {amount}";
const RCON_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MinecraftItemGiveConfig {
    pub host: String,
    pub port: u16,
    pub password: String,
    pub default_player: String,
    pub command_template: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftItemGiveResponse {
    pub player_name: String,
    pub item_key: String,
    pub amount: u32,
    pub command: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftOnlinePlayersResponse {
    pub players: Vec<String>,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftRconCommandResponse {
    pub command: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DragonCoreOpenGuiResponse {
    pub player_name: String,
    pub gui_name: String,
    pub file_path: String,
    pub command: String,
    pub output: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuperHighRconConfigFile {
    version: u32,
    #[serde(default = "default_enabled")]
    enabled: bool,
    host: Option<String>,
    port: Option<u16>,
    password: Option<String>,
    default_player: Option<String>,
    item_give: Option<SuperHighItemGiveConfigFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuperHighItemGiveConfigFile {
    command_template: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BlackBoxProEnvFile {
    rcon: Option<BlackBoxProRconConfig>,
    client: Option<BlackBoxProClientConfig>,
}

#[derive(Debug, Deserialize)]
struct BlackBoxProRconConfig {
    host: Option<String>,
    port: Option<u16>,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlackBoxProClientConfig {
    player_name: Option<String>,
}

fn default_enabled() -> bool {
    true
}

pub fn load_item_give_config(workspace: &Path) -> anyhow::Result<MinecraftItemGiveConfig> {
    let superhigh_config = workspace.join(".superhigh").join(SUPERHIGH_RCON_CONFIG);
    if superhigh_config.is_file() {
        return load_superhigh_rcon_config(&superhigh_config);
    }

    for candidate in blackboxpro_env_candidates(workspace) {
        if candidate.is_file() {
            return load_blackboxpro_env_config(&candidate);
        }
    }

    bail!(
        "未找到 RCON 配置。请在工作区 .superhigh/{} 配置 host、port、password 和 defaultPlayer",
        SUPERHIGH_RCON_CONFIG
    );
}

pub fn build_item_give_command(
    config: &MinecraftItemGiveConfig,
    item_key: &str,
    amount: u32,
) -> anyhow::Result<String> {
    build_item_give_command_for_player(config, &config.default_player, item_key, amount)
}

pub fn build_item_give_command_for_player(
    config: &MinecraftItemGiveConfig,
    player_name: &str,
    item_key: &str,
    amount: u32,
) -> anyhow::Result<String> {
    let item_key = clean_command_token(item_key, "item key")?;
    let player = clean_command_token(player_name, "player name")?;
    if amount == 0 {
        bail!("amount must be at least 1");
    }
    let template = config.command_template.trim();
    if template.is_empty() {
        bail!("item give command template is empty");
    }
    if !template.contains("{player}")
        || !template.contains("{itemKey}")
        || !template.contains("{amount}")
    {
        bail!("item give command template must contain {{player}}, {{itemKey}} and {{amount}}");
    }
    Ok(template
        .replace("{player}", player)
        .replace("{itemKey}", item_key)
        .replace("{amount}", &amount.to_string()))
}

pub fn send_item_to_default_player(
    workspace: &Path,
    item_key: &str,
    amount: u32,
) -> anyhow::Result<MinecraftItemGiveResponse> {
    let config = load_item_give_config(workspace)?;
    let command = build_item_give_command(&config, item_key, amount)?;
    let output = execute_rcon_command(&config.host, config.port, &config.password, &command)?;
    Ok(MinecraftItemGiveResponse {
        player_name: config.default_player,
        item_key: item_key.trim().to_string(),
        amount,
        command,
        output,
    })
}

pub fn send_item_to_named_player(
    workspace: &Path,
    player_name: &str,
    item_key: &str,
    amount: u32,
) -> anyhow::Result<MinecraftItemGiveResponse> {
    let config = load_item_give_config(workspace)?;
    let player_name = clean_command_token(player_name, "player name")?.to_string();
    let command = build_item_give_command_for_player(&config, &player_name, item_key, amount)?;
    let output = execute_rcon_command(&config.host, config.port, &config.password, &command)?;
    Ok(MinecraftItemGiveResponse {
        player_name,
        item_key: item_key.trim().to_string(),
        amount,
        command,
        output,
    })
}

pub fn online_players(workspace: &Path) -> anyhow::Result<MinecraftOnlinePlayersResponse> {
    let config = load_item_give_config(workspace)?;
    let output = execute_rcon_command(&config.host, config.port, &config.password, "list")?;
    Ok(MinecraftOnlinePlayersResponse {
        players: parse_online_players(&output),
        output,
    })
}

pub fn execute_project_rcon_command(
    workspace: &Path,
    command: &str,
) -> anyhow::Result<MinecraftRconCommandResponse> {
    let command = clean_rcon_command(command)?;
    let config = load_item_give_config(workspace)?;
    let output = execute_rcon_command(&config.host, config.port, &config.password, command)?;
    Ok(MinecraftRconCommandResponse {
        command: command.to_string(),
        output,
    })
}

pub fn build_dragoncore_gui_name(workspace: &Path, file_path: &Path) -> anyhow::Result<String> {
    let file_name = file_path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .unwrap_or("")
        .trim();
    if file_name.eq_ignore_ascii_case(".yml") || file_name.eq_ignore_ascii_case(".yaml") {
        bail!("GUI name is empty");
    }

    let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension != "yml" && extension != "yaml" {
        bail!("DragonCore GUI file must be yml or yaml");
    }

    let gui_root = workspace.join("DragonCore").join("Gui");
    let root_text = normalized_path_text(&gui_root);
    let file_text = normalized_path_text(file_path);
    let root_key = root_text.to_ascii_lowercase();
    let file_key = file_text.to_ascii_lowercase();
    let root_prefix = format!("{root_key}/");
    if !file_key.starts_with(&root_prefix) {
        bail!("DragonCore GUI file must be under DragonCore/Gui");
    }

    let mut gui_name = file_text[root_text.len() + 1..].to_string();
    let extension_suffix = format!(".{extension}");
    let gui_name_len = gui_name.len().saturating_sub(extension_suffix.len());
    gui_name.truncate(gui_name_len);
    let gui_name = clean_command_token(&gui_name, "GUI name")?;
    Ok(gui_name.to_string())
}

pub fn build_dragoncore_open_gui_command(
    config: &MinecraftItemGiveConfig,
    gui_name: &str,
) -> anyhow::Result<String> {
    let player = clean_command_token(&config.default_player, "player name")?;
    let gui_name = clean_command_token(gui_name, "GUI name")?;
    Ok(format!("core opengui {player} {gui_name}"))
}

pub fn open_dragoncore_gui(
    workspace: &Path,
    file_path: &Path,
) -> anyhow::Result<DragonCoreOpenGuiResponse> {
    let config = load_item_give_config(workspace)?;
    let gui_name = build_dragoncore_gui_name(workspace, file_path)?;
    let command = build_dragoncore_open_gui_command(&config, &gui_name)?;
    let output = execute_rcon_command(&config.host, config.port, &config.password, &command)?;
    Ok(DragonCoreOpenGuiResponse {
        player_name: config.default_player,
        gui_name,
        file_path: normalized_path_text(file_path),
        command,
        output,
    })
}

fn load_superhigh_rcon_config(path: &Path) -> anyhow::Result<MinecraftItemGiveConfig> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("read SuperHigh RCON config {}", path.display()))?;
    let parsed: SuperHighRconConfigFile = serde_json::from_str(&raw)
        .with_context(|| format!("parse SuperHigh RCON config {}", path.display()))?;
    if parsed.version != 1 {
        bail!(
            "unsupported minecraft-rcon config version {}",
            parsed.version
        );
    }
    if !parsed.enabled {
        bail!("minecraft-rcon config is disabled");
    }
    let port = parsed
        .port
        .ok_or_else(|| anyhow::anyhow!("minecraft-rcon config missing port"))?;
    Ok(MinecraftItemGiveConfig {
        host: clean_config_string(parsed.host.as_deref(), DEFAULT_RCON_HOST),
        port,
        password: required_config_string(parsed.password.as_deref(), "password")?,
        default_player: required_config_string(parsed.default_player.as_deref(), "defaultPlayer")?,
        command_template: parsed
            .item_give
            .and_then(|item_give| item_give.command_template)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_ITEM_GIVE_TEMPLATE.to_string()),
    })
}

fn load_blackboxpro_env_config(path: &Path) -> anyhow::Result<MinecraftItemGiveConfig> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("read BlackBoxPro env config {}", path.display()))?;
    let parsed: BlackBoxProEnvFile = serde_json::from_str(&raw)
        .with_context(|| format!("parse BlackBoxPro env config {}", path.display()))?;
    let rcon = parsed
        .rcon
        .ok_or_else(|| anyhow::anyhow!("BlackBoxPro env config missing rcon"))?;
    let client = parsed
        .client
        .ok_or_else(|| anyhow::anyhow!("BlackBoxPro env config missing client"))?;
    Ok(MinecraftItemGiveConfig {
        host: clean_config_string(rcon.host.as_deref(), DEFAULT_RCON_HOST),
        port: rcon
            .port
            .ok_or_else(|| anyhow::anyhow!("BlackBoxPro env config missing rcon.port"))?,
        password: required_config_string(rcon.password.as_deref(), "rcon.password")?,
        default_player: required_config_string(client.player_name.as_deref(), "client.playerName")?,
        command_template: DEFAULT_ITEM_GIVE_TEMPLATE.to_string(),
    })
}

fn blackboxpro_env_candidates(workspace: &Path) -> Vec<PathBuf> {
    vec![
        workspace
            .join(".codex")
            .join("config")
            .join(BLACKBOXPRO_ENV_CONFIG),
        workspace
            .join("plugins")
            .join(".codex")
            .join("config")
            .join(BLACKBOXPRO_ENV_CONFIG),
    ]
}

fn clean_config_string(value: Option<&str>, fallback: &str) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn required_config_string(value: Option<&str>, field: &str) -> anyhow::Result<String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        bail!("RCON config missing {field}");
    };
    Ok(value.to_string())
}

fn clean_command_token<'a>(value: &'a str, field: &str) -> anyhow::Result<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        bail!("{field} is empty");
    }
    if value.contains('\n') || value.contains('\r') {
        bail!("{field} must stay on one line");
    }
    Ok(value)
}

fn parse_online_players(output: &str) -> Vec<String> {
    let Some((_, players)) = output.trim().rsplit_once(':') else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for player in players.split(',').map(strip_minecraft_format_codes) {
        let player = player.trim();
        if player.is_empty() {
            continue;
        }
        if !result.iter().any(|current| current == player) {
            result.push(player.to_string());
        }
    }
    result
}

fn strip_minecraft_format_codes(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        if character == '§' {
            characters.next();
            continue;
        }
        output.push(character);
    }
    output
}

fn clean_rcon_command(command: &str) -> anyhow::Result<&str> {
    let command = command.trim();
    if command.is_empty() {
        bail!("RCON command is empty");
    }
    if command.contains('\r') || command.contains('\n') {
        bail!("RCON command must stay on one line");
    }
    Ok(command)
}

fn normalized_path_text(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let normalized = normalized
        .strip_prefix("//?/")
        .unwrap_or(&normalized)
        .trim_end_matches('/')
        .to_string();
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if parts.last().is_some_and(|last| *last != "..") {
                parts.pop();
            } else {
                parts.push(part);
            }
            continue;
        }
        parts.push(part);
    }
    parts.join("/")
}

fn execute_rcon_command(
    host: &str,
    port: u16,
    password: &str,
    command: &str,
) -> anyhow::Result<String> {
    let address = (host, port)
        .to_socket_addrs()
        .with_context(|| format!("resolve RCON address {host}:{port}"))?
        .next()
        .ok_or_else(|| anyhow::anyhow!("RCON address did not resolve: {host}:{port}"))?;
    let mut stream = TcpStream::connect_timeout(&address, RCON_TIMEOUT)
        .with_context(|| format!("connect RCON {host}:{port}"))?;
    stream.set_read_timeout(Some(RCON_TIMEOUT))?;
    stream.set_write_timeout(Some(RCON_TIMEOUT))?;

    write_packet(&mut stream, 1, 3, password)?;
    let auth = read_packet(&mut stream).context("read RCON auth response")?;
    if auth.request_id == -1 {
        bail!("RCON authentication failed");
    }

    write_packet(&mut stream, 2, 2, command)?;
    let response = read_packet(&mut stream).context("read RCON command response")?;
    Ok(response.payload)
}

fn write_packet(
    stream: &mut TcpStream,
    request_id: i32,
    packet_type: i32,
    payload: &str,
) -> anyhow::Result<()> {
    let payload_bytes = payload.as_bytes();
    let body_length = 4 + 4 + payload_bytes.len() + 2;
    let mut packet = Vec::with_capacity(4 + body_length);
    packet.extend_from_slice(&(body_length as i32).to_le_bytes());
    packet.extend_from_slice(&request_id.to_le_bytes());
    packet.extend_from_slice(&packet_type.to_le_bytes());
    packet.extend_from_slice(payload_bytes);
    packet.extend_from_slice(&[0, 0]);
    stream.write_all(&packet)?;
    Ok(())
}

struct RconPacket {
    request_id: i32,
    payload: String,
}

fn read_packet(stream: &mut TcpStream) -> anyhow::Result<RconPacket> {
    let mut length_bytes = [0u8; 4];
    stream.read_exact(&mut length_bytes)?;
    let length = i32::from_le_bytes(length_bytes);
    if length < 10 {
        bail!("invalid RCON packet length {length}");
    }
    let mut body = vec![0u8; length as usize];
    stream.read_exact(&mut body)?;
    let request_id = i32::from_le_bytes(body[0..4].try_into()?);
    let payload_end = body.len().saturating_sub(2);
    Ok(RconPacket {
        request_id,
        payload: String::from_utf8_lossy(&body[8..payload_end]).to_string(),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{
        build_dragoncore_gui_name, build_dragoncore_open_gui_command, build_item_give_command,
        build_item_give_command_for_player, clean_rcon_command, load_item_give_config,
        parse_online_players,
    };

    #[test]
    fn loads_project_superhigh_rcon_config_and_builds_default_ni_command() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path();
        fs::create_dir_all(workspace.join(".superhigh")).unwrap();
        fs::write(
            workspace.join(".superhigh").join("minecraft-rcon.json"),
            r#"{
              "version": 1,
              "host": "127.0.0.1",
              "port": 25576,
              "password": "secret",
              "defaultPlayer": "AdminUser"
            }"#,
        )
        .unwrap();

        let config = load_item_give_config(workspace).unwrap();
        let command = build_item_give_command(&config, "goblin_helmet", 1).unwrap();

        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 25576);
        assert_eq!(config.password, "secret");
        assert_eq!(config.default_player, "AdminUser");
        assert_eq!(command, "ni give AdminUser goblin_helmet 1");
    }

    #[test]
    fn loads_tide_blackboxpro_env_config_for_legacy_projects() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path();
        fs::create_dir_all(workspace.join(".codex/config")).unwrap();
        fs::write(
            workspace.join(".codex/config/blackboxpro-env.json"),
            r#"{
              "rcon": {
                "host": "127.0.0.1",
                "port": 25576,
                "password": "superhigh-rcon-tide"
              },
              "client": {
                "playerName": "NO_mc"
              }
            }"#,
        )
        .unwrap();

        let config = load_item_give_config(workspace).unwrap();
        let command = build_item_give_command(&config, "福利随机礼包天灾BOSS斗骨", 1).unwrap();

        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 25576);
        assert_eq!(config.password, "superhigh-rcon-tide");
        assert_eq!(config.default_player, "NO_mc");
        assert_eq!(command, "ni give NO_mc 福利随机礼包天灾BOSS斗骨 1");
    }

    #[test]
    fn rejects_item_keys_that_would_escape_the_rcon_command_line() {
        let config = super::MinecraftItemGiveConfig {
            host: "127.0.0.1".to_string(),
            port: 25576,
            password: "secret".to_string(),
            default_player: "AdminUser".to_string(),
            command_template: "ni give {player} {itemKey} {amount}".to_string(),
        };

        let error = build_item_give_command(&config, "valid_item\nop someone", 1).unwrap_err();

        assert!(error.to_string().contains("item key must stay on one line"));
    }

    #[test]
    fn builds_item_command_for_selected_online_player_and_amount() {
        let config = super::MinecraftItemGiveConfig {
            host: "127.0.0.1".to_string(),
            port: 25576,
            password: "secret".to_string(),
            default_player: "AdminUser".to_string(),
            command_template: "ni give {player} {itemKey} {amount}".to_string(),
        };

        let command =
            build_item_give_command_for_player(&config, "Alice", "goblin_helmet", 12).unwrap();

        assert_eq!(command, "ni give Alice goblin_helmet 12");
    }

    #[test]
    fn parses_vanilla_rcon_online_player_list() {
        assert_eq!(
            parse_online_players(
                "There are 3 of a max of 20 players online: Alice, NO_mc§r§f, Alice"
            ),
            vec!["Alice", "NO_mc"],
        );
        assert!(parse_online_players("There are 0 of a max of 20 players online:").is_empty());
    }

    #[test]
    fn rejects_empty_or_multiline_project_rcon_commands() {
        assert!(clean_rcon_command("   ")
            .unwrap_err()
            .to_string()
            .contains("empty"));
        assert!(clean_rcon_command("plugins\nreload")
            .unwrap_err()
            .to_string()
            .contains("one line"));
        assert_eq!(
            clean_rcon_command("  plugins reload  ").unwrap(),
            "plugins reload"
        );
    }

    #[test]
    fn maps_dragoncore_gui_file_to_forward_slash_gui_name() {
        let workspace = PathBuf::from(r"D:\Project\plugins");
        let file = workspace
            .join("DragonCore")
            .join("Gui")
            .join("d队伍")
            .join("副本列表.yml");

        let gui_name = build_dragoncore_gui_name(&workspace, &file).unwrap();

        assert_eq!(gui_name, "d队伍/副本列表");
    }

    #[test]
    fn maps_dragoncore_yaml_extension_case_insensitively() {
        let workspace = PathBuf::from(r"D:\Project\plugins");
        let file = workspace
            .join("DragonCore")
            .join("Gui")
            .join("menus")
            .join("Main.YAML");

        let gui_name = build_dragoncore_gui_name(&workspace, &file).unwrap();

        assert_eq!(gui_name, "menus/Main");
    }

    #[test]
    fn rejects_files_outside_dragoncore_gui() {
        let workspace = PathBuf::from(r"D:\Project\plugins");
        let file = workspace
            .join("DragonCore")
            .join("Items")
            .join("副本列表.yml");

        let error = build_dragoncore_gui_name(&workspace, &file).unwrap_err();

        assert!(error.to_string().contains("DragonCore/Gui"));
    }

    #[test]
    fn rejects_paths_that_escape_dragoncore_gui_with_parent_segments() {
        let workspace = PathBuf::from(r"D:\Project\plugins");
        let file = workspace
            .join("DragonCore")
            .join("Gui")
            .join("..")
            .join("Items")
            .join("副本列表.yml");

        let error = build_dragoncore_gui_name(&workspace, &file).unwrap_err();

        assert!(error.to_string().contains("DragonCore/Gui"));
    }

    #[test]
    fn rejects_non_yaml_dragoncore_gui_files() {
        let workspace = PathBuf::from(r"D:\Project\plugins");
        let file = workspace
            .join("DragonCore")
            .join("Gui")
            .join("副本列表.txt");

        let error = build_dragoncore_gui_name(&workspace, &file).unwrap_err();

        assert!(error.to_string().contains("yml or yaml"));
    }

    #[test]
    fn rejects_empty_dragoncore_gui_names() {
        let workspace = PathBuf::from(r"D:\Project\plugins");
        let file = workspace.join("DragonCore").join("Gui").join(".yml");

        let error = build_dragoncore_gui_name(&workspace, &file).unwrap_err();

        assert!(error.to_string().contains("GUI name is empty"));
    }

    #[test]
    fn dragoncore_open_gui_command_rejects_newline_in_player_or_gui_name() {
        let config = super::MinecraftItemGiveConfig {
            host: "127.0.0.1".to_string(),
            port: 25576,
            password: "secret".to_string(),
            default_player: "AdminUser\nop someone".to_string(),
            command_template: "ni give {player} {itemKey} {amount}".to_string(),
        };

        let error = build_dragoncore_open_gui_command(&config, "d队伍/副本列表").unwrap_err();

        assert!(error
            .to_string()
            .contains("player name must stay on one line"));

        let config = super::MinecraftItemGiveConfig {
            default_player: "AdminUser".to_string(),
            ..config
        };
        let error = build_dragoncore_open_gui_command(&config, "d队伍\nop someone").unwrap_err();

        assert!(error.to_string().contains("GUI name must stay on one line"));
    }

    #[test]
    fn builds_only_dragoncore_open_gui_command_for_default_player() {
        let config = super::MinecraftItemGiveConfig {
            host: "127.0.0.1".to_string(),
            port: 25576,
            password: "secret".to_string(),
            default_player: "AdminUser".to_string(),
            command_template: "ignored {player} {itemKey} {amount}".to_string(),
        };

        let command = build_dragoncore_open_gui_command(&config, "d队伍/副本列表").unwrap();

        assert_eq!(command, "core opengui AdminUser d队伍/副本列表");
    }
}
