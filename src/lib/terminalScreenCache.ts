export interface TerminalScreenSnapshot {
  data: string
  endByte: number
  cols: number
  rows: number
  themeId: string
}

// Only parsed screens are cached. Raw PTY output remains the source of truth.
const screens = new Map<string, TerminalScreenSnapshot>()
const MAX_CHARACTERS = 8 * 1024 * 1024

export function rememberTerminalScreen(id: string, snapshot: TerminalScreenSnapshot) {
  screens.delete(id)
  screens.set(id, snapshot)
  let characters = [...screens.values()].reduce((total, screen) => total + screen.data.length, 0)
  for (const [key, screen] of screens) {
    if (characters <= MAX_CHARACTERS) break
    screens.delete(key)
    characters -= screen.data.length
  }
}

export function readTerminalScreen(id: string, themeId: string, startByte = 0, endByte = Number.MAX_SAFE_INTEGER) {
  const screen = screens.get(id)
  return screen && screen.themeId === themeId && screen.endByte >= startByte && screen.endByte <= endByte ? screen : undefined
}

export function pruneTerminalScreens(ids: string[]) {
  const retained = new Set(ids)
  for (const id of screens.keys()) if (!retained.has(id)) screens.delete(id)
}
