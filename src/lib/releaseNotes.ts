import changelog from '../../CHANGELOG.md?raw'
import { version } from '../../package.json'

export const releaseHistory = [...changelog.matchAll(/^## \[([^\]]+)\](?: - ([^\r\n]+))?\r?\n([\s\S]*?)(?=^## \[|(?![\s\S]))/gm)]
  .map(([, version, date, notes]) => ({ version: version!, date: date ?? '', notes: notes!.replace(/^\[[^\]]+\]:[^\r\n]*$/gm, '').trim() }))

export const currentRelease = releaseHistory.find(release => release.version === version)
  ?? { version, date: '', notes: '' }
