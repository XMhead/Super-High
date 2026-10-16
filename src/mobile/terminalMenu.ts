export type TerminalScreenLine = { text: string; highlighted: boolean }
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
  type Row = { row: number; number: number; body: string; selected: boolean }
  let group: Row[] = []
  let last: Row[] = []
  for (let row = 0; row < lines.length; row += 1) {
    const match = lines[row]!.text.match(OPTION)
    if (!match) {
      if (group.length && row - group.at(-1)!.row > MAX_GAP) { if (group.length >= 2) last = group; group = [] }
      continue
    }
    const entry = { row, number: Number(match[2]), body: match[3]!, selected: Boolean(match[1]) || lines[row]!.highlighted }
    if (group.length && entry.number === group.at(-1)!.number + 1 && row - group.at(-1)!.row <= MAX_GAP) group.push(entry)
    else { if (group.length >= 2) last = group; group = [entry] }
  }
  if (group.length >= 2) last = group
  if (!last.length) return null
  const selectedIndex = last.findIndex(entry => entry.selected)
  if (selectedIndex < 0 || last.filter(entry => entry.selected).length > 1) return null
  if (!lines.slice(last[0]!.row).some(line => HINT.test(line.text))) return null
  const options = last.map(entry => {
    const checkbox = CHECKBOX.test(entry.body)
    const [label, ...rest] = entry.body.split(/\s{2,}/)
    return { number: entry.number, label: label!, detail: rest.join(' '), checkbox }
  })
  return { options, selectedIndex, multi: options.some(option => option.checkbox) }
}
