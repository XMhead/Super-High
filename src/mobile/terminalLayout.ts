// Keep CLI layouts at a useful width while respecting the user's font-size ceiling.
export function fittedTerminalFontSize(preferred: number, availableColumns: number, targetColumns = 80): number {
  return Math.max(6, Math.floor(Math.min(preferred, preferred * availableColumns / targetColumns) * 10) / 10)
}
