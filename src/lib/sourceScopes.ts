/** SuperHigh 来源按提供方式划分，与功能名称、运行目录和落地缓存位置无关。 */
export type SourceScope = 'system' | 'global' | 'project'

export const SOURCE_SCOPE_LABELS: Record<SourceScope, string> = {
  system: '系统',
  global: '全局',
  project: '项目',
}

export const SOURCE_SCOPE_DESCRIPTIONS: Record<SourceScope, string> = {
  system: 'SuperHigh 源码自带，随应用提供',
  global: '用户使用 SuperHigh 后自行注册，供各工作区使用',
  project: '项目中登记的内容；跨工作区使用需显式引用',
}
