# Super High

> **简体中文**：[README.md](README.md) ｜ **功能讲解**：[FEATURES.md](FEATURES.md)

[![Release](https://img.shields.io/github/v/release/XMhead/Super-High?display_name=release&label=Release)](https://github.com/XMhead/Super-High/releases/latest)


Super High is a Windows desktop workspace built with Vue 3, Vite, Tauri 2, and Rust.

It combines a code editor, embedded terminals, project service control, a local
JavaScript plugin runtime, script tools, file management, and a native CLI into a
single always-running desktop app.

## Requirements

- Windows 11
- Node.js 22 or newer
- Rust stable
- Tauri prerequisites for Windows

## Setup

```powershell
npm install
```

## Development

```powershell
npm run dev
npm run tauri:dev
```

## Mobile UI

Start the Host in Settings > 手机端, then open its mobile web address on a phone and enter the token. The updated Android app loads the same desktop-hosted UI. Desktop settings also offer a preview.

After editing `src/mobile/`, run `npm run mobile:build` and refresh the phone page; no APK reinstall is needed. Repository builds read the root `dist-mobile` directory. Installed builds read `dist-mobile` beside the EXE, which can be replaced in full to update the pages. Desktop release builds include these files automatically. Native permissions, plugins, or app-shell changes still require a new APK.

For live development, run `npm run mobile:dev` and open `http://localhost:1421/` for a phone-sized preview of the real UI. Saving changes under `src/mobile/` triggers hot updates. A phone browser can open `http://<desktop-LAN-IP>:1421/mobile/`, or the updated Android app can connect to `http://<desktop-LAN-IP>:1421`, using the same desktop Host token. Keep the development server running; rebuilding is not required.

The development proxy defaults to the local Host on port `10320`; set `SUPERHIGH_MOBILE_HOST` before starting it to use another address. The preview entry is excluded from installation packages.

## Plugins

SuperHigh loads trusted local JavaScript plugins from:

- Global: `%APPDATA%\SuperHigh\plugins\`
- Project: `<workspace>\.superhigh\plugins\`

Each project can keep its own plugins. When a workspace is opened, SuperHigh
loads that workspace's project plugins automatically. If the same plugin id
exists in both places, the project plugin wins.

To test:

1. Open SuperHigh.
2. Open Settings > 插件 and copy the global / project plugin paths.
3. Create a plugin folder in the target directory. Folder name must match the
   `id` field in its `plugin.json`.
4. Open the target workspace and refresh Settings > 插件.

Recovery:

- Start SuperHigh with `--disable-plugins` to skip plugin loading for that process.
- Create `disable-plugins.flag` in the app data directory shown in Settings > 插件
  to skip plugins until the file is removed.

## Project Script Tools

The top bar's 脚本工具 button reads script tools from the currently opened
workspace. Add a `.superhigh/script-tools.json` file, register allowed
workspace-relative directories, and list the scripts that should appear as tools:

```json
{
  "version": 1,
  "directories": [{ "path": "scripts" }],
  "tools": [{
    "version": 1,
    "id": "report",
    "title": "查看报告",
    "script": "scripts/report.py",
    "runtime": "python",
    "kind": "query"
  }]
}
```

Each tool declares the real script path, runtime (`python`, `powershell`, `node`,
or `cmd`), input fields, and whether it is a read-only `query` or a
confirmation-required `maintenance` tool. The script must stay inside a
registered directory outside `.superhigh`; `.superhigh` is registry and
project-state storage only.

## Build

```powershell
npm run build
npm run tauri:build
```

## Tests

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

## CLI

```powershell
npm run cli -- --help
```

More CLI examples are in [CLI.md](CLI.md).

## Project Layout

- `src/` - Vue renderer source
- `src-tauri/` - Rust/Tauri backend and native CLI
- `scripts/` - project utility scripts

## License

MIT

## Download

Prebuilt Windows installers are published as GitHub Releases. Grab the latest
`*-setup.exe` from the [Releases page](https://github.com/XMhead/Super-High/releases/latest).
