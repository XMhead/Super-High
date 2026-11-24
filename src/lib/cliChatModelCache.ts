import type { CliChatModelOption } from './tauri'

// Native catalogs survive chat/work mode remounts, but never cross sessions.
const catalogs = new Map<string, CliChatModelOption[]>()
export const cachedChatModels = (sessionId: string) => catalogs.get(sessionId) ?? []
export function rememberChatModels(sessionId: string, models: CliChatModelOption[]) {
  catalogs.delete(sessionId)
  catalogs.set(sessionId, models)
  if (catalogs.size > 64) catalogs.delete(catalogs.keys().next().value!)
}
