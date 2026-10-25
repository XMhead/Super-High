import type { TerminalSlashCommand, TerminalSlashMenu } from './terminalMenu'

export interface NativeSlashCatalogSource {
  current: () => boolean
  write: (key: string) => Promise<unknown>
  waitForSelection: (previous: string) => Promise<TerminalSlashMenu | null>
  update: (commands: TerminalSlashCommand[]) => void
}

/** Read the current CLI's own registry by visiting each native suggestion, without executing it. */
export async function collectNativeSlashCommands(initial: TerminalSlashMenu, source: NativeSlashCatalogSource): Promise<boolean> {
  if (!initial.selectedCommand) return false
  const commands = new Map<string, TerminalSlashCommand>()
  const selected = new Set([initial.selectedCommand])
  const append = (menu: TerminalSlashMenu) => {
    for (const entry of menu.commands) commands.set(entry.command, entry)
    source.update([...commands.values()])
  }
  append(initial)
  let previous = initial.selectedCommand
  // A safety bound is a failed scan, never evidence of a complete registry.
  while (source.current() && selected.size <= 4096) {
    await source.write('\u001b[A')
    if (!source.current()) return false
    const menu = await source.waitForSelection(previous)
    if (!source.current() || !menu?.selectedCommand) return false
    append(menu)
    // Wraparound proves that every option was visited, and restores the original selection.
    if (menu.selectedCommand === initial.selectedCommand) return true
    if (selected.has(menu.selectedCommand)) return false
    previous = menu.selectedCommand
    selected.add(previous)
  }
  return false
}
