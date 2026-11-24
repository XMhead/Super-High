import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

test('Android vectors preserve the shared icons and separate SVG arc flags', () => {
  execFileSync(process.execPath, ['scripts/sync-android-cli-icons.mjs'])
  const codex = readFileSync('android/app/src/main/res/drawable/cli_codex.xml', 'utf8')
  assert.match(codex, /a5\.416 5\.416 0 0 0 -\.478 -4\.501/)
  assert.match(codex, /A5\.59 5\.59 0 0 0 10\.831 1/)
  for (const provider of ['codex', 'claude', 'opencode', 'gemini', 'grok', 'codebuddy', 'kimi']) {
    assert.match(readFileSync(`android/app/src/main/res/drawable/cli_${provider}.xml`, 'utf8'), /<path\b/)
  }
})
