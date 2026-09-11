import type { TerminalProviderKind } from '@/types'

export type CliProviderKind = Exclude<TerminalProviderKind, 'local'>

export type CliProviderIconKind = 'terminal' | 'cpu'

export interface CliProviderOption {
  id: CliProviderKind
  name: string
  shortName: string
  command: string
  icon: CliProviderIconKind
}

export const CLI_PROVIDER_OPTIONS: CliProviderOption[] = [
  { id: 'claude', name: 'Claude Code', shortName: 'Claude', command: 'claude', icon: 'terminal' },
  { id: 'codex', name: 'Codex CLI', shortName: 'Codex', command: 'codex', icon: 'cpu' },
  { id: 'kimi', name: 'Kimi Code CLI', shortName: 'Kimi', command: 'kimi', icon: 'terminal' },
  { id: 'grok', name: 'Grok Build CLI', shortName: 'Grok', command: 'grok', icon: 'cpu' },
  { id: 'gemini', name: 'Gemini CLI', shortName: 'Gemini', command: 'gemini', icon: 'cpu' },
  { id: 'opencode', name: 'OpenCode', shortName: 'OpenCode', command: 'opencode', icon: 'terminal' },
]

export function cliProviderVisible(providerKind: string, hiddenProviderIds: readonly string[]): boolean {
  return !hiddenProviderIds.includes(providerKind)
}

export function cliProviderLabel(providerKind: TerminalProviderKind | string): string {
  if (providerKind === 'local') return 'PowerShell'
  return CLI_PROVIDER_OPTIONS.find((provider) => provider.id === providerKind)?.name ?? String(providerKind)
}

export function cliProviderShortLabel(providerKind: TerminalProviderKind | string): string {
  if (providerKind === 'local') return 'PowerShell'
  return CLI_PROVIDER_OPTIONS.find((provider) => provider.id === providerKind)?.shortName ?? String(providerKind)
}

export function cliProviderIconKind(providerKind: TerminalProviderKind | string): CliProviderIconKind {
  return CLI_PROVIDER_OPTIONS.find((provider) => provider.id === providerKind)?.icon ?? 'terminal'
}

export function isCliProviderKind(value: string): value is CliProviderKind {
  return CLI_PROVIDER_OPTIONS.some((provider) => provider.id === value)
}
