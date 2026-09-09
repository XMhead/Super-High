import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const fail = (message) => { throw new Error(message); };
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const config = json('src-tauri/tauri.conf.json');
const version = config.version;
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
const cargoVersion = cargo?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('Stable releases require a numeric major.minor.patch version.');
if (json('package.json').version !== version || cargoVersion !== version) fail('package.json, Cargo.toml and tauri.conf.json versions must match.');
const cargoLockVersion = readFileSync('src-tauri/Cargo.lock', 'utf8').match(/\[\[package\]\]\s+name = "super-high"\s+version = "([^"]+)"/)?.[1];
if (cargoLockVersion !== version) fail('Cargo.lock application version must match.');
const lock = json('package-lock.json');
if (lock.version !== version || lock.packages?.['']?.version !== version) fail('package-lock.json version must match.');
const tag = process.argv[2];
if (tag && tag !== `v${version}`) fail(`Expected tag v${version}.`);
if (config.bundle?.createUpdaterArtifacts !== true) fail('Signed updater artifacts must be enabled.');
const updater = config.plugins?.updater;
if (!updater?.pubkey || Buffer.from(updater.pubkey, 'base64').toString().indexOf('untrusted comment:') !== 0) fail('A valid updater public key is required.');
const endpoint = 'https://github.com/XMhead/Super-High/releases/latest/download/latest.json';
if (!updater.endpoints?.includes(endpoint)) fail('The stable GitHub updater endpoint is missing.');

const artifactDirectory = process.argv[3];
if (artifactDirectory) {
  const manifest = json(resolve(artifactDirectory, 'latest.json'));
  if (manifest.version.replace(/^v/, '') !== version) fail('latest.json version does not match the application.');
  const platform = manifest.platforms?.['windows-x86_64'] ?? manifest.platforms?.['windows-x86_64-nsis'];
  if (!platform?.signature?.trim()) fail('latest.json must contain a signed Windows x64 update.');
  const url = new URL(platform.url);
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith(`/XMhead/Super-High/releases/download/v${version}/`) || !url.pathname.endsWith('-setup.exe')) fail('Update must reference this release NSIS installer.');
  const installer = resolve(artifactDirectory, basename(decodeURIComponent(url.pathname)));
  if (!existsSync(installer) || !existsSync(`${installer}.sig`)) fail('The installer and signature must both be present.');
  if (readFileSync(`${installer}.sig`, 'utf8').trim() !== platform.signature.trim()) fail('Manifest signature differs from the installer signature.');
}
console.log(`Update release v${version}: configuration${artifactDirectory ? ' and artifacts' : ''} valid.`);
