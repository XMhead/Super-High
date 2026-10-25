# Super High

[简体中文](README.md) · [Feature guide (Chinese)](FEATURES.md) · [CLI reference](CLI.md)

A Windows 11 desktop workspace for code editing, AI CLI sessions, file management, and project tools. Built with Vue 3, Vite, Tauri 2, and Rust.

[![Release](https://img.shields.io/github/v/release/XMhead/Super-High?display_name=release&label=Release)](https://github.com/XMhead/Super-High/releases/latest)

## Download and updates

Download the latest `*-setup.exe` from [Releases](https://github.com/XMhead/Super-High/releases/latest). After installation, check for and install updates in the app. Update installation is deferred while internal terminal sessions are active.

## Sponsor

Thanks to **Aizzz**, an AI API gateway, for sponsoring the author. You can sign up through the author's referral link below.

<a href="https://api.aizzz.xyz/sign-up?aff=nDR2"><img src="https://api.aizzz.xyz/custom/huiling-newapi-logo.png" alt="Aizzz AI API gateway" width="48" height="48"></a>

[Aizzz · Sign up with referral](https://api.aizzz.xyz/sign-up?aff=nDR2)

## Features

- **Editing and previews**: tabbed code editor, project search, Markdown, YAML, images, and media.
- **Terminals and AI**: embedded terminals, AI CLI sessions, channel connectivity checks, and model discovery.
- **Project tools**: service startup, script tools, local plugins, and custom HTML project interfaces.
- **Workspace utilities**: file management, notes, documentation site previews, and phone access over a local network.

See the [feature guide](FEATURES.md) for details.

## Development and build

Requires Windows 11, Node.js 22+, Rust stable, and the Tauri prerequisites for Windows.

```powershell
npm install
npm run tauri:dev
```

Use `npm run dev` for a frontend-only preview. Build the desktop installer, including the frontend and mobile pages:

```powershell
npm run tauri:build
```

Releases are built locally from the sanitized public checkout, including Windows installers and the matching APK: `node scripts/publish-local-release.mjs --source <public-checkout-path> --tag v<version>`. Use `--resume` to retry uploading verified artifacts without rebuilding. GitHub hosts downloads; cloud builds are an explicitly requested fallback.

### Mobile UI

Start the Host in Settings > 手机端, then open the displayed address on a phone and enter the token. The updated Android app loads the same desktop-hosted UI.

After editing `src/mobile/`, run `npm run mobile:build` and refresh the phone page. Repository builds read the root `dist-mobile` directory; installed builds read it beside the EXE. Replace that directory in full to update the pages. Local page development can reuse the installed shell. Every stable GitHub Release includes a newly built APK from the matching public source version for direct phone updates.

For live previews, run `npm run mobile:dev` and open `http://localhost:1421/` on the desktop or `http://<desktop-LAN-IP>:1421/mobile/` on a phone. The updated Android app can use `http://<desktop-LAN-IP>:1421` as its Host address. Use the desktop Host token. The development proxy defaults to local port `10320`; set `SUPERHIGH_MOBILE_HOST` before starting it to use another address. Keep the development server running.

## Tests and CLI

Use `superhigh-cli agent sessions/tasks` or the stdio MCP entry `superhigh-cli mcp serve` to delegate work to desktop-owned Codex / Claude Code sessions. Both interfaces share task IDs, native completion evidence, bounded waits, answer pagination, and interruption requests. External and embedded agents use the same desktop task registry. See [MCP configuration and examples](CLI.md#agent-调度与-mcp).

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run cli -- --help
```

See the [CLI reference](CLI.md) for more commands.

## Workspaces and sources

Every folder opened in SuperHigh is a workspace, including the SuperHigh source folder. Each workspace uses its own `.superhigh` directory.
“Project” means the current exact workspace, including source development and non-Minecraft projects.

| Source | Meaning | Existing entry points |
| --- | --- | --- |
| System | Built into SuperHigh source and shipped with the app | `/prompt`, Skill Overview editor |
| Global | Registered by the user after using SuperHigh, for use across workspaces | Commands, script tools, editors, and plugins in user app data |
| Project | Registered by the user in the current workspace, belonging to that workspace | Commands, script tools, editors, and plugins in its `.superhigh` directory |

Source depends on how a feature is provided, regardless of its name or execution directory. A system editor materialized in app data remains System.
Editors, commands, script tools, and plugins share these meanings. Each entry point shows only its supported sources.
Native Agent CLI commands remain a separate “Agent CLI” category. Skills retain their provider directory scope.
Workspace `.superhigh/skills` is Project; user-home `.superhigh/skills` is Global.
Skills for maintaining SuperHigh source belong to that workspace; their names do not make them System features.
Caches, logs, attachments, and terminal state are runtime artifacts. Empty registries and unregistered templates are not registered extensions.

## License

[MIT](LICENSE)
