#!/usr/bin/env node
// patch-full-access.mjs -- Keep local DSH execution unrestricted without
// exposing sandbox escalation or file-observation gates. The base sandbox
// executors are disabled and equivalent local executors are inserted with
// stable ids; sandbox-policy remains as a compatibility service for presets.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dshHome = join(homedir(), '.dsh')
const profilesDir = join(dshHome, 'profiles')
const profiles = ['dsh-tui', 'headless', 'tui', 'web']
const marker = 'SUPERHIGH_PERMISSION_GATES_DISABLED_V1'
const markerLine = `# ${marker}: keep local execution unrestricted; disable permission gates.`
const legacyMarkerPattern = /^#\s+SUPERHIGH_[A-Z_]+_V\d+\s*:/
const legacyPolicyMarkerPattern = /^#\s+Local DSH policy: unrestricted execution with no approval or permission-preset layer\.\s*$/
const generatedIds = new Set([
  'sandbox-policy',
  'fs-sandbox',
  'bash-sandbox',
  'pwsh-sandbox',
  'fs-local',
  'bash-local',
  'pwsh-local',
  'approval',
  'permission',
  'fs-observation-policy',
  'fs-policy',
  'insert',
])

function buildLayer(includeLocalExecutors = true) {
  const rows = [
    markerLine,
    '- id: sandbox-policy',
    '  config:',
    '    mode: danger-full-access',
    '    workspaceRoot: !!js process.cwd()',
    '- id: fs-sandbox',
    '  disabled: true',
    '- id: bash-sandbox',
    '  disabled: true',
    '- id: pwsh-sandbox',
    '  disabled: true',
    '- id: approval',
    '  disabled: true',
    '- id: permission',
    '  disabled: true',
    '- id: fs-observation-policy',
    '  disabled: true',
  ]
  if (includeLocalExecutors) {
    rows.push(
      '- insert:',
      '    - id: subagent-model-selection-settings',
      "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
      '    - id: code-runtime',
      "      name: '@deepseek-ai/dsh-code-runtime-worker-thread'",
      '    - id: fs-local',
      "      name: '@deepseek-ai/dsh-fs-local'",
      '      config:',
      '        cwd: !!js process.cwd()',
      '    - id: bash-local',
      "      name: '@deepseek-ai/dsh-bash-local'",
      '      disabled: !!js process.platform === \'win32\'',
      '      config:',
      '        cwd: !!js process.cwd()',
      '        timeoutMs: 60000',
      '    - id: pwsh-local',
      "      name: '@deepseek-ai/dsh-pwsh-local'",
      '      disabled: !!js process.platform !== \'win32\'',
      '      config:',
      '        cwd: !!js process.cwd()',
    )
  }
  return `${rows.join('\n')}\n`
}

function log(message) {
  console.log(`[patch-dsh-policy] ${message}`)
}

function normalize(value) {
  return value.replace(/\r\n?/g, '\n')
}

function withLineEndings(value, source) {
  return source.includes('\r\n') ? value.replaceAll('\n', '\r\n') : value
}

function isTopLevelEntry(line) {
  return /^-\s+(?:id|insert):/.test(line)
}

function entryKey(line) {
  const id = line.match(/^-\s+id:\s*([^\s#]+)/)?.[1]
  if (id) return id.replace(/^['"]|['"]$/g, '')
  if (/^-\s+insert:\s*$/.test(line)) return 'insert'
  return undefined
}

function isGeneratedEntry(lines, start, key) {
  if (key !== 'insert') return generatedIds.has(key)
  const end = skipEntry(lines, start)
  const block = lines.slice(start, end).join('\n')
  // `insert` is a valid user patch construct too. Only consume the block
  // when it contains the local executor rows emitted by this script.
  return ['fs-local', 'bash-local', 'pwsh-local'].some(id =>
    new RegExp(`^\\s+- id: ${id}\\s*$`, 'm').test(block))
}

function skipEntry(lines, start) {
  let index = start + 1
  while (index < lines.length && !isTopLevelEntry(lines[index])) index++
  return index
}

function isMarkerLine(line) {
  return line.startsWith(`# ${marker}:`) || legacyMarkerPattern.test(line) || legacyPolicyMarkerPattern.test(line)
}

// Remove only blocks previously emitted by this script or its old versions.
// Unknown entries after a generated block remain untouched, so a user patch
// appended below the generated rows is not lost during migration.
function stripMarkedLayers(source, keepCurrent) {
  const lines = normalize(source).split('\n')
  const output = []
  let changed = false
  let index = 0
  let markerActive = false
  while (index < lines.length) {
    const line = lines[index]
    if (isMarkerLine(line)) {
      const current = line.startsWith(`# ${marker}:`)
      markerActive = true
      if (current && keepCurrent) output.push(line)
      else changed = true
      index++
      continue
    }
    if (!markerActive) {
      output.push(line)
      index++
      continue
    }
    const key = entryKey(line)
    if (!keepCurrent && key !== undefined && isGeneratedEntry(lines, index, key)) {
      changed = true
      index = skipEntry(lines, index)
      // Marker-owned separators should not survive removal when another
      // generated row follows, but preserve spacing before user rows.
      while (index < lines.length && lines[index].trim() === '') {
        let next = index + 1
        while (next < lines.length && lines[next].trim() === '') next++
        const nextKey = next < lines.length ? entryKey(lines[next]) : undefined
        if (next < lines.length && (isMarkerLine(lines[next]) || (nextKey !== undefined && isGeneratedEntry(lines, next, nextKey)))) index++
        else break
      }
      continue
    }
    output.push(line)
    index++
  }
  return { source: output.join('\n'), changed }
}

function hasDesiredLayer(source, includeLocalExecutors = true) {
  const text = normalize(source)
  const markerCount = text.split('\n').filter(line => line.startsWith(`# ${marker}:`)).length
  if (markerCount !== 1) return false
  const required = [
    `# ${marker}:`,
    '- id: sandbox-policy\n  config:\n    mode: danger-full-access\n    workspaceRoot: !!js process.cwd()',
    '- id: fs-sandbox\n  disabled: true',
    '- id: bash-sandbox\n  disabled: true',
    '- id: pwsh-sandbox\n  disabled: true',
    '- id: approval\n  disabled: true',
    '- id: permission\n  disabled: true',
    '- id: fs-observation-policy\n  disabled: true',
  ]
  if (!required.every(fragment => text.includes(fragment))) return false
  const gateIds = ['sandbox-policy', 'fs-sandbox', 'bash-sandbox', 'pwsh-sandbox', 'approval', 'permission', 'fs-observation-policy']
  const gateCounts = gateIds.map(id =>
    (text.match(new RegExp(`^- id: ${id}\\s*$`, 'gm')) ?? []).length)
  if (gateCounts.some(count => count !== 1)) return false
  if (!includeLocalExecutors) {
    return !/^\s*- id: (?:fs-policy|fs-local|bash-local|pwsh-local)\s*$/m.test(text)
  }
  const localFragments = [
    '- insert:\n    - id: subagent-model-selection-settings\n      name: \'@deepseek-ai/dsh-tool-subagent/model-selection-settings\'',
    '- id: code-runtime\n      name: \'@deepseek-ai/dsh-code-runtime-worker-thread\'',
    '- id: fs-local\n      name: \'@deepseek-ai/dsh-fs-local\'',
    '- id: bash-local\n      name: \'@deepseek-ai/dsh-bash-local\'',
    '- id: pwsh-local\n      name: \'@deepseek-ai/dsh-pwsh-local\'',
    'cwd: !!js process.cwd()',
    "disabled: !!js process.platform === 'win32'",
    "disabled: !!js process.platform !== 'win32'",
    'timeoutMs: 60000',
  ]
  const localCounts = ['subagent-model-selection-settings', 'code-runtime', 'fs-local', 'bash-local', 'pwsh-local'].map(id =>
    (text.match(new RegExp(`^\\s{4}- id: ${id}\\s*$`, 'gm')) ?? []).length)
  return localFragments.every(fragment => text.includes(fragment)) &&
    localCounts.every(count => count === 1) &&
    !/^\s*- id: fs-policy\s*$/m.test(text)
}

function appendLayer(source, generated) {
  const text = normalize(source)
  if (text.trim() === '' || /^\s*\[\]\s*$/.test(text)) return generated.trimEnd()
  const lines = text.split('\n')
  if (lines.every(line => line.trim() === '' || line.trim().startsWith('#'))) {
    const prefix = text.trimEnd()
    return prefix === '' ? generated.trimEnd() : `${prefix}\n${generated.trimEnd()}`
  }
  if (!/^\s*-\s+/m.test(text)) return null
  const trimmed = text.trimEnd()
  return `${trimmed}\n${generated.trimEnd()}`
}

function applyLayer(source, includeLocalExecutors) {
  const current = stripMarkedLayers(source, true)
  if (hasDesiredLayer(current.source, includeLocalExecutors)) {
    return { source: current.source, changed: current.changed }
  }
  const cleaned = stripMarkedLayers(current.source, false)
  const generated = buildLayer(includeLocalExecutors)
  const appended = appendLayer(cleaned.source, generated)
  if (appended === null) return null
  return { source: appended, changed: true }
}

function patchProfile(profile) {
  const profileDir = join(profilesDir, profile)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(profileDir)) {
    log(`${profile}: skipped because the profile directory is not installed`)
    return true
  }
  if (!existsSync(patchPath)) {
    writeFileSync(patchPath, buildLayer(true), 'utf8')
    log(`${profile}: created permission-gate patch`)
    return true
  }
  const source = readFileSync(patchPath, 'utf8')
  const result = applyLayer(source, true)
  if (result === null) {
    log(`${profile}: skipped because cordis.patch.yml is not a YAML patch array`)
    return false
  }
  if (!result.changed) {
    log(`${profile}: permission gates are disabled`)
    return true
  }
  writeFileSync(patchPath, withLineEndings(result.source, source), 'utf8')
  log(`${profile}: migrated permission-gate patch`)
  return true
}

function patchHomeLayer() {
  const patchPath = join(dshHome, 'cordis.patch.yml')
  mkdirSync(dshHome, { recursive: true })
  if (!existsSync(patchPath)) {
    writeFileSync(patchPath, buildLayer(false), 'utf8')
    log('home layer: created permission-gate patch')
    return true
  }
  const source = readFileSync(patchPath, 'utf8')
  const result = applyLayer(source, false)
  if (result === null) {
    log('home layer: skipped because cordis.patch.yml is not a YAML patch array')
    return false
  }
  if (!result.changed) {
    log('home layer: permission gates are disabled')
    return true
  }
  writeFileSync(patchPath, withLineEndings(result.source, source), 'utf8')
  log('home layer: migrated permission-gate patch')
  return true
}

function main() {
  const ready = [patchHomeLayer(), ...profiles.map(patchProfile)]
  if (ready.every(Boolean)) {
    log('all local DSH profiles use local executors; sandbox escalation, approval, permission, and observation gates are disabled')
    return
  }
  process.exitCode = 1
}

main()
