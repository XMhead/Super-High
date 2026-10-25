import type { Terminal } from '@xterm/xterm'

export type TerminalScreenLine = { text: string; highlighted: boolean }
export type TerminalSlashCommand = { command: string; description: string }
export type TerminalSlashMenu = { commands: TerminalSlashCommand[]; selectedCommand: string | null }
export type TerminalMenuOption = { number: number; label: string; detail: string; checkbox: boolean }
export type TerminalMenu = { options: TerminalMenuOption[]; selectedIndex: number; multi: boolean }

// `› 1. GPT-6.1-Sol (current)   Latest workhorse…` (Codex) / `❯ 1. Yes` (Claude)
const OPTION = /^\s*([›❯>▶▸➤→])?\s*(\d{1,2})[.)]\s+(\S.*?)\s*$/
// Footer or inline key hints prove the list waits for a key, unlike numbered prose.
const HINT = /\b(?:enter|esc|tab)\b|↑|↓|navigate|cancel/i
const CHECKBOX = /^(?:\[[ xX✓✔*]\]|[☐☑☒◯◉○●])\s*/
const MAX_GAP = 3

/** Detect the interactive numbered menu nearest the bottom of the PTY screen. */
export function detectTerminalMenu(lines: TerminalScreenLine[]): TerminalMenu | null {
  type Row = { row: number; number: number; body: string; markerGap: number; selected: boolean }
  let group: Row[] = []
  let last: Row[] = []
  for (let row = 0; row < lines.length; row += 1) {
    const match = lines[row]!.text.match(OPTION)
    if (!match) {
      if (group.length && row - group.at(-1)!.row > MAX_GAP) { if (group.length >= 2) last = group; group = [] }
      continue
    }
    // Incremental CLI repaint can leave an old marker farther left than the live cursor.
    const markerGap = match[1] ? lines[row]!.text.match(/^\s*[›❯>▶▸➤→](\s*)/)![1]!.length : Infinity
    const entry = { row, number: Number(match[2]), body: match[3]!, markerGap, selected: lines[row]!.highlighted }
    if (group.length && entry.number === group.at(-1)!.number + 1 && row - group.at(-1)!.row <= MAX_GAP) group.push(entry)
    else { if (group.length >= 2) last = group; group = [entry] }
  }
  if (group.length >= 2) last = group
  if (!last.length) return null
  const markerGap = Math.min(...last.map(entry => entry.markerGap))
  const selected = last.map(entry => Number.isFinite(markerGap) ? entry.markerGap === markerGap : entry.selected)
  const selectedIndex = selected.indexOf(true)
  if (selectedIndex < 0 || selected.filter(Boolean).length > 1) return null
  if (!lines.slice(last[0]!.row).some(line => HINT.test(line.text))) return null
  const options = last.map(entry => {
    const checkbox = CHECKBOX.test(entry.body)
    const [label, ...rest] = entry.body.split(/\s{2,}/)
    return { number: entry.number, label: label!, detail: rest.join(' '), checkbox }
  })
  return { options, selectedIndex, multi: options.some(option => option.checkbox) }
}

/** Live PTY screen rows, unwrapped, for detecting interactive menus. */
export function terminalScreenLines(terminal: Pick<Terminal, 'buffer' | 'rows'>): TerminalScreenLine[] {
  const buffer = terminal.buffer.active
  const lines: TerminalScreenLine[] = []
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row)
    const text = line?.translateToString(true) ?? ''
    const first = text.search(/\S/)
    const cell = first >= 0 ? line?.getCell(first) : undefined
    const highlighted = Boolean(cell && (cell.isInverse() || !cell.isBgDefault()))
    // Cursor repaints can leave an old wrap flag on a new numbered menu row.
    if (line?.isWrapped && lines.length && !OPTION.test(text)) lines.at(-1)!.text += text
    else lines.push({ text, highlighted })
  }
  return lines
}

// `› /model     choose what model…` (Codex) / `  /model (user)   Set the AI model` (Claude)
const SLASH_ROW = /^\s*[│┃]?\s*[›❯>▶▸➤→]?\s*(?:\*\s+)?(\/[\w:.\-]+)(?:\s+\([^)]*\))?(?:\s+(\S.*?))?\s*[│┃]?\s*$/

/** The CLI's own slash-command suggestions: the contiguous block nearest the bottom of the screen. */
export function detectSlashCommands(lines: TerminalScreenLine[]): TerminalSlashCommand[] {
  return detectSlashCommandMenu(lines)?.commands ?? []
}

/** Keep the native selection so a catalog scan can wait for a real menu repaint. */
export function detectSlashCommandMenu(lines: TerminalScreenLine[]): TerminalSlashMenu | null {
  type Row = TerminalSlashCommand & { highlighted: boolean; marker: boolean }
  let block: Row[] = []
  let last: Row[] = []
  // The echoed draft (`› /mo`) has no description and may sit below the suggestions after a blank row.
  const close = () => { if (block.some(entry => entry.description)) last = block.filter(entry => entry.description); block = [] }
  for (const line of lines) {
    const match = line.text.match(SLASH_ROW)
    if (match) block.push({ command: match[1]!, description: match[2] ?? '', highlighted: line.highlighted,
      marker: /^\s*[│┃]?\s*[›❯>▶▸➤→]/.test(line.text) })
    // Claude wraps descriptions onto indented physical rows. They belong to
    // the same suggestion block, rather than starting a new list.
    else if (block.at(-1)?.description && /^\s{4,}\S/.test(line.text)) {
      block.at(-1)!.description += ` ${line.text.trim()}`
    } else close()
  }
  close()
  if (!last.length) return null
  const highlighted = last.filter(entry => entry.highlighted)
  const marked = last.filter(entry => entry.marker)
  const selected = highlighted.length === 1 ? highlighted[0] : marked.length === 1 ? marked[0] : undefined
  return { commands: last.map(({ command, description }) => ({ command, description })), selectedCommand: selected?.command ?? null }
}

/** Only an editable prompt without a running-task footer proves the CLI is idle. */
export function terminalChatActivity(lines: TerminalScreenLine[]): 'busy' | 'idle' | 'unknown' {
  if (lines.some(({ text }) => /esc(?:ape)? to interrupt|running .+hooks|[✢✳✶✻✽·] .+…/i.test(text))) return 'busy'
  if (detectTerminalMenu(lines) || hasNativeTerminalPanel(lines)) return 'unknown'
  return lines.some(({ text }) => /^\s*[›❯>]\s*\S*/u.test(text)) ? 'idle' : 'unknown'
}

/** Unnumbered native tabs, settings and help must keep their own terminal UI. */
export function hasNativeTerminalPanel(lines: TerminalScreenLine[]): boolean {
  return !detectTerminalMenu(lines) && lines.some(({ text }) => /esc(?:ape)? to (?:cancel|close|exit)|press (?:enter|escape) to (?:continue|close)|(?<![+\w])tab to (?:cycle|navigate)/i.test(text))
}
