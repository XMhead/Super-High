import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const exeIndex = process.argv.indexOf('--exe')
const releaseCli = path.join(root, 'src-tauri', 'target', 'release', 'superhigh-cli.exe')
const debugCli = path.join(root, 'src-tauri', 'target', 'debug', 'superhigh-cli.exe')
const supportsSpacing = candidate => existsSync(candidate) && spawnSync(candidate, ['--help'], { encoding: 'utf8' }).stdout.includes('prompt spacing')
const cli = exeIndex >= 0 ? path.resolve(process.argv[exeIndex + 1]) : supportsSpacing(releaseCli) ? releaseCli : debugCli

if (!existsSync(cli)) {
  console.error(`Missing ${cli}. Build it first with: cargo build --manifest-path src-tauri/Cargo.toml --bin superhigh-cli --release`)
  process.exit(1)
}

const result = spawnSync(cli, ['prompt', 'spacing', 'setup', '--json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
process.stdout.write(result.stdout)
