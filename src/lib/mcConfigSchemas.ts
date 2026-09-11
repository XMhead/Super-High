/**
 * MC Config Schema Registry
 *
 * Each schema describes one plugin's config.yml structure:
 * sections → fields (name, type, label, description, choices, default)
 *
 * The wizard reads these schemas to generate conversational steps,
 * then produces valid YAML.
 */

export type FieldType = 'string' | 'int' | 'double' | 'boolean' | 'location' | 'entityType' | 'stringList' | 'mobWave' | 'select'

export interface ConfigField {
  key: string
  label: string
  description: string
  type: FieldType
  path: string // dot-separated YAML path, e.g. "settings.min-players"
  default?: unknown
  choices?: string[] // for 'select' type
  min?: number
  max?: number
  condition?: { field: string; value: unknown } // show this field only when condition matches
}

export interface ConfigSection {
  id: string
  label: string
  description: string
  fields: ConfigField[]
}

export interface PluginConfigSchema {
  pluginId: string
  pluginName: string
  description: string
  icon: string // lucide icon name
  sections: ConfigSection[]
}

/** Entity types common in 1.12.2 dungeon/mob configs */
export const MOB_ENTITY_TYPES = [
  'ZOMBIE', 'SKELETON', 'SPIDER', 'CREEPER', 'WITHER_SKELETON',
  'BLAZE', 'CAVE_SPIDER', 'ENDERMAN', 'GHAST', 'HUSK', 'MAGMA_CUBE',
  'PIG_ZOMBIE', 'SILVERFISH', 'SLIME', 'STRAY', 'WITCH',
  'WOLF', 'IRON_GOLEM', 'SNOWMAN', 'ENDERMITE', 'GUARDIAN',
  'ELDER_GUARDIAN', 'SHULKER', 'POLAR_BEAR', 'VEX', 'VINDICATOR',
  'EVOKER', 'ILLUSIONER', 'WITHER', 'ENDER_DRAGON', 'GIANT',
]

// ─── SimpleDungeonDemo ────────────────────────────────────────────

const simpleDungeonSchema: PluginConfigSchema = {
  pluginId: 'SimpleDungeonDemo',
  pluginName: 'SimpleDungeon 副本',
  description: '配置副本波次、怪物、位置和奖励',
  icon: 'Swords',
  sections: [
    {
      id: 'settings',
      label: '基础设置',
      description: '副本的玩家数量、时间和行为设置',
      fields: [
        { key: 'min-players', label: '最少玩家数', description: '开始副本所需的最少玩家数量', type: 'int', path: 'settings.min-players', default: 1, min: 1, max: 100 },
        { key: 'max-players', label: '最多玩家数', description: '副本允许的最大玩家数量', type: 'int', path: 'settings.max-players', default: 4, min: 1, max: 100 },
        { key: 'countdown-seconds', label: '倒计时（秒）', description: '人满后开始倒计时', type: 'int', path: 'settings.countdown-seconds', default: 10, min: 1, max: 300 },
        { key: 'time-limit-seconds', label: '时间限制（秒）', description: '副本总时间限制，0 表示无限制', type: 'int', path: 'settings.time-limit-seconds', default: 300, min: 0, max: 7200 },
        { key: 'between-wave-delay-seconds', label: '波次间隔（秒）', description: '每波怪物之间的等待时间', type: 'int', path: 'settings.between-wave-delay-seconds', default: 5, min: 0, max: 300 },
        { key: 'teleport-to-exit-on-end', label: '结束时传送到出口', description: '副本结束后是否自动将玩家传送到出口位置', type: 'boolean', path: 'settings.teleport-to-exit-on-end', default: true },
      ],
    },
    {
      id: 'locations',
      label: '位置设置',
      description: '副本的各个位置点（在大厅、起点、出口、刷怪点）',
      fields: [
        { key: 'lobby', label: '大厅位置', description: '玩家等待副本开始的位置', type: 'location', path: 'locations.lobby' },
        { key: 'start', label: '起点位置', description: '副本开始的传送位置', type: 'location', path: 'locations.start' },
        { key: 'exit', label: '出口位置', description: '副本结束后的传送位置', type: 'location', path: 'locations.exit' },
      ],
    },
    {
      id: 'waves',
      label: '怪物波次',
      description: '定义每一波出现的怪物类型和数量',
      fields: [
        // Waves are special - handled by the wizard's mob wave editor
        { key: 'waves', label: '波次列表', description: '配置每一波的延迟、怪物类型和数量', type: 'mobWave', path: 'waves' },
      ],
    },
    {
      id: 'rewards',
      label: '奖励设置',
      description: '副本通关后的奖励命令',
      fields: [
        { key: 'commands', label: '奖励命令', description: '通关后执行的命令，%player% 会被替换为玩家名', type: 'stringList', path: 'rewards.commands' },
      ],
    },
  ],
}

// ─── MythicMobs ───────────────────────────────────────────────────

const mythicMobsSchema: PluginConfigSchema = {
  pluginId: 'MythicMobs',
  pluginName: 'MythicMobs 自定义怪物',
  description: '创建自定义怪物、技能、掉落和生成规则',
  icon: 'Skull',
  sections: [
    {
      id: 'mob-basics',
      label: '怪物基础',
      description: '怪物的基本属性',
      fields: [
        { key: 'type', label: '怪物类型', description: '基于哪个原版实体', type: 'select', path: 'type', choices: MOB_ENTITY_TYPES, default: 'ZOMBIE' },
        { key: 'display', label: '显示名称', description: '怪物的显示名称，支持颜色代码', type: 'string', path: 'display', default: '&c自定义怪物' },
        { key: 'health', label: '生命值', description: '怪物的生命值', type: 'double', path: 'health', default: 20, min: 0.5, max: 100000 },
        { key: 'damage', label: '攻击力', description: '怪物的基础攻击力', type: 'double', path: 'damage', default: 2, min: 0, max: 10000 },
        { key: 'armor', label: '护甲值', description: '怪物的护甲值', type: 'double', path: 'armor', default: 0, min: 0, max: 100 },
        { key: 'movement-speed', label: '移动速度', description: '怪物的移动速度倍率', type: 'double', path: 'movement-speed', default: 0.25, min: 0.01, max: 2 },
      ],
    },
    {
      id: 'mob-skills',
      label: '怪物技能',
      description: '怪物拥有的技能列表',
      fields: [
        { key: 'skills', label: '技能列表', description: '怪物使用的技能（需要手动输入 MythicMobs 技能语法）', type: 'stringList', path: 'skills' },
      ],
    },
    {
      id: 'mob-drops',
      label: '掉落设置',
      description: '怪物死亡后的掉落物',
      fields: [
        { key: 'drops', label: '掉落表', description: '怪物死亡后的掉落物品列表', type: 'stringList', path: 'drops' },
      ],
    },
  ],
}

// ─── DungeonPlus ──────────────────────────────────────────────────

const dungeonPlusSchema: PluginConfigSchema = {
  pluginId: 'DungeonPlus',
  pluginName: 'DungeonPlus 副本',
  description: '配置副本实例、关卡、怪物和交互',
  icon: 'Dungeon',
  sections: [
    {
      id: 'dp-basics',
      label: '副本基础',
      description: '副本的基本设置',
      fields: [
        { key: 'name', label: '副本名称', description: '副本的显示名称', type: 'string', path: 'name', default: '新副本' },
        { key: 'world', label: '所在世界', description: '副本所在的世界名称', type: 'string', path: 'world', default: 'world' },
        { key: 'min-player', label: '最少玩家', description: '开始副本的最少玩家数', type: 'int', path: 'min-player', default: 1, min: 1, max: 100 },
        { key: 'max-player', label: '最多玩家', description: '副本允许的最大玩家数', type: 'int', path: 'max-player', default: 4, min: 1, max: 100 },
        { key: 'time-limit', label: '时间限制（秒）', description: '副本时间限制', type: 'int', path: 'time-limit', default: 600, min: 0, max: 7200 },
        { key: 'respawn-point', label: '重生点区域', description: '玩家死亡后的重生位置区域名', type: 'string', path: 'respawn-point', default: '' },
      ],
    },
    {
      id: 'dp-stages',
      label: '关卡设置',
      description: '副本的关卡和怪物波次',
      fields: [
        { key: 'stages', label: '关卡列表', description: '副本包含的关卡，每个关卡可包含多波怪物', type: 'stringList', path: 'stages' },
      ],
    },
    {
      id: 'dp-rewards',
      label: '奖励设置',
      description: '副本通关奖励',
      fields: [
        { key: 'reward-commands', label: '奖励命令', description: '通关后执行的命令', type: 'stringList', path: 'reward-commands' },
      ],
    },
  ],
}

// ─── Registry ─────────────────────────────────────────────────────

export const PLUGIN_CONFIG_SCHEMAS: PluginConfigSchema[] = [
  simpleDungeonSchema,
  mythicMobsSchema,
  dungeonPlusSchema,
]

export function getSchemaByPluginId(pluginId: string): PluginConfigSchema | undefined {
  return PLUGIN_CONFIG_SCHEMAS.find((s) => s.pluginId === pluginId)
}

// ─── YAML Generator ───────────────────────────────────────────────

/**
 * Builds a YAML string from a flat key-value record.
 * Supports dot-separated paths like "settings.min-players" → nested YAML.
 */
export function buildYaml(values: Record<string, unknown>): string {
  const root: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue
    const parts = key.split('.')
    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {}
      }
      current = current[parts[i]] as Record<string, unknown>
    }
    current[parts[parts.length - 1]] = value
  }

  return toYamlString(root, 0)
}

function toYamlString(obj: unknown, indent: number): string {
  const pad = '  '.repeat(indent)
  const nextPad = '  '.repeat(indent + 1)

  if (obj === null || obj === undefined) return ''

  if (typeof obj === 'boolean') return obj ? 'true' : 'false'
  if (typeof obj === 'number') return String(obj)
  if (typeof obj === 'string') {
    // Strings with special chars need quoting
    if (/[:\n#&*!|>'"%@`{}[\],?]/.test(obj) || obj.includes(' ') || obj === '') {
      return JSON.stringify(obj)
    }
    return obj
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    // Array of primitives
    if (obj.every((item) => typeof item !== 'object' || item === null)) {
      return obj.map((item) => `${pad}- ${toYamlString(item, 0)}`).join('\n')
    }
    // Array of objects
    return obj.map((item) => {
      const lines = toYamlString(item, indent + 1)
      return `${pad}- ${lines.trimStart()}`
    }).join('\n')
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
    if (entries.length === 0) return '{}'
    return entries.map(([k, v]) => {
      if (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v)) {
        const nested = toYamlString(v, indent + 1)
        return `${pad}${k}:\n${nested}`
      }
      return `${pad}${k}: ${toYamlString(v, 0)}`
    }).join('\n')
  }

  return String(obj)
}

/**
 * Generate a default location map for YAML output
 */
export function locationTemplate(world = 'world'): Record<string, unknown> {
  return { world, x: 0.5, y: 64.0, z: 0.5, yaw: 0.0, pitch: 0.0 }
}
