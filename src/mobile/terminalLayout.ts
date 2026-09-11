// Keep CLI layouts at a useful width while respecting the user's font-size ceiling.
export function fittedTerminalFontSize(preferred: number, availableColumns: number): number {
  return Math.max(6, Math.floor(Math.min(preferred, preferred * availableColumns / 80) * 10) / 10)
}
