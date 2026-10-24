export const SETTINGS_SECTION_IDS = ['account', 'general', 'appearance', 'config', 'editors', 'shortcuts', 'mobile', 'cli', 'storage', 'usage', 'updates', 'plugins', 'channels'] as const
export type SettingsSection = typeof SETTINGS_SECTION_IDS[number]
