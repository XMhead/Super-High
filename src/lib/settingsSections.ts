export const SETTINGS_SECTION_IDS = ['general', 'appearance', 'config', 'editors', 'shortcuts', 'mobile', 'cli', 'storage', 'updates', 'plugins', 'channels'] as const
export type SettingsSection = typeof SETTINGS_SECTION_IDS[number]
