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
// Release bodies are extracted from this section by GitHub Actions.
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const versionHeading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\][^\\r\\n]*\\r?$`, 'm').exec(changelog);
if (!versionHeading) fail('The release version is missing from CHANGELOG.md.');
const remainder = changelog.slice(versionHeading.index + versionHeading[0].length);
const nextVersion = remainder.search(/^## |^\[\d[^\n]*\]:/m);
const notes = nextVersion < 0 ? remainder : remainder.slice(0, nextVersion);
const categories = [
  ['新增功能', 'New Features'], ['体验优化', 'Improvements'], ['问题修复', 'Bug Fixes'],
  ['不兼容变更', 'Breaking Changes'], ['升级说明', 'Upgrade Notes'], ['其他变更', 'Other Changes'],
];
const titles = [...categories.map(pair => pair[0]), ...categories.map(pair => pair[1])];
const headings = [...notes.matchAll(/^### ([^\r\n]+)\r?$/gm)];
const sections = headings.map((heading, index) => ({
  title: heading[1], order: titles.indexOf(heading[1]),
  body: notes.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? notes.length),
}));
if (!sections.length || sections.some((section, index) => section.order < 0 || (index > 0 && section.order <= sections[index - 1].order))) {
  fail('Release notes must use the fixed categories in order: Chinese first, then English.');
}
const chinese = sections.filter(section => section.order < categories.length);
const english = sections.filter(section => section.order >= categories.length);
if (!chinese.length || chinese.length !== english.length || !/^---\s*$/m.test(chinese.at(-1).body)) {
  fail('Release notes require matching Chinese and English sections separated by ---.');
}
for (let index = 0; index < chinese.length; index++) {
  const count = (chinese[index].body.match(/^- /gm) ?? []).length;
  if (!count || english[index].order !== chinese[index].order + categories.length || count !== (english[index].body.match(/^- /gm) ?? []).length) {
    fail(`Release category ${chinese[index].title} needs nonempty, matching bilingual bullet points.`);
  }
}
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
