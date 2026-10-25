import type { TerminalProviderKind } from '@/types'

export type CliProviderKind = Exclude<TerminalProviderKind, 'local'>

export interface CliProviderOption {
  id: CliProviderKind
  name: string
  shortName: string
  command: string
}

export const CLI_PROVIDER_OPTIONS: CliProviderOption[] = [
  { id: 'claude', name: 'Claude Code', shortName: 'Claude', command: 'claude' },
  { id: 'codex', name: 'Codex', shortName: 'Codex', command: 'codex' },
  { id: 'kimi', name: 'Kimi Code', shortName: 'Kimi', command: 'kimi' },
  { id: 'grok', name: 'Grok Build', shortName: 'Grok', command: 'grok' },
  { id: 'gemini', name: 'Gemini', shortName: 'Gemini', command: 'gemini' },
  { id: 'opencode', name: 'OpenCode', shortName: 'OpenCode', command: 'opencode' },
  { id: 'codebuddy', name: 'CodeBuddy Code', shortName: 'CodeBuddy', command: 'codebuddy' },
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

export function isCliProviderKind(value: string): value is CliProviderKind {
  return CLI_PROVIDER_OPTIONS.some((provider) => provider.id === value)
}
