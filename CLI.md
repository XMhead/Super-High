# Super High CLI

`superhigh-cli` is a small native command-line entry for AI and scripts. It
wraps existing Rust backend logic instead of duplicating GUI behavior.

Run it from the repository root with npm:

```powershell
npm run cli -- --help
npm run cli -- cards list --project .
npm run cli -- cards create "终端多标签" --label ui,terminal --project .
npm run cli -- cards show card-12345678 --project . --json
npm run cli -- cards claim --assigned-cli codex --project . --json
npm run cli -- cards update card-12345678 --status done --project . --json
npm run cli -- cards set-status card-12345678 dispatched --assigned-cli codex --project . --json
npm run cli -- docs graph --project . --json
npm run cli -- docs check --project . --json
npm run cli -- files ls "src-tauri\src" --json
npm run cli -- files read "AGENTS.md"
npm run cli -- skills project list --project . --json
npm run cli -- skills instructions list --project . --json
npm run cli -- skills global workspace --project . --json
npm run cli -- env cli --json
npm run cli -- remote status --json
npm run cli -- search "技能" --project . --limit 20 --json
```

Every command accepts `--project <path>`. If omitted, the current directory is
used. Add `--json` when another AI or script needs machine-readable output.

Destructive commands require an explicit flag:

```powershell
npm run cli -- cards delete card-12345678 --project . --force
npm run cli -- files delete "tmp\old.txt" --force
```

Remote workspace creation is available through `remote ensure`, but use a
reviewed config file before running it because it writes the generated control
workspace:

```powershell
npm run cli -- remote config --json
npm run cli -- remote ensure --config-file ".\remote-config.json" --source-project . --json
```
