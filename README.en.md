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

### Mobile UI

Start the Host in Settings > 手机端, then open the displayed address on a phone and enter the token. The updated Android app loads the same desktop-hosted UI.

After editing `src/mobile/`, run `npm run mobile:build` and refresh the phone page. Repository builds read the root `dist-mobile` directory; installed builds read it beside the EXE. Replace that directory in full to update the pages. A new APK is only needed for native permission, plugin, or app-shell changes.

For live previews, run `npm run mobile:dev` and open `http://localhost:1421/` on the desktop or `http://<desktop-LAN-IP>:1421/mobile/` on a phone. The updated Android app can use `http://<desktop-LAN-IP>:1421` as its Host address. Use the desktop Host token. The development proxy defaults to local port `10320`; set `SUPERHIGH_MOBILE_HOST` before starting it to use another address. Keep the development server running.

## Tests and CLI

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run cli -- --help
```

See the [CLI reference](CLI.md) for more commands.

## License

[MIT](LICENSE)
