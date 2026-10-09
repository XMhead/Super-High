import type { ThemeTokens } from '@/types'
import type { ITheme } from '@xterm/xterm'

export interface MonacoThemeDefinition {
  base: 'vs' | 'vs-dark'
  inherit: boolean
  rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }>
  colors: Record<string, string>
}

export const THEMES: Record<string, ThemeTokens> = {
  dark: {
    id: 'dark',
    name: 'GitHub Dark',
    type: 'dark',
    colors: {
      bg: { primary: '#0D1117', secondary: '#161B22', tertiary: '#21262D', hover: '#30363D' },
      text: { primary: '#E6EDF3', secondary: '#8B949E', muted: '#484F58' },
      accent: { blue: '#58A6FF', green: '#3FB950', yellow: '#D29922', red: '#F85149', purple: '#BC8CFF' },
      border: '#30363D',
      inputBg: '#161B22',
    },
    terminal: {
      background: '#0D1117', foreground: '#E6EDF3', cursor: '#58A6FF',
      black: '#484F58', red: '#FF7B72', green: '#3FB950', yellow: '#D29922',
      blue: '#58A6FF', magenta: '#BC8CFF', cyan: '#39C5CF', white: '#B1BAC4',
      brightBlack: '#6E7681', brightRed: '#FFA198', brightGreen: '#56D364', brightYellow: '#E3B341',
      brightBlue: '#79C0FF', brightMagenta: '#D2A8FF', brightCyan: '#56D4DD', brightWhite: '#F0F6FC',
    },
  },
  light: {
    id: 'light',
    name: 'GitHub Light',
    type: 'light',
    colors: {
      bg: { primary: '#FFFFFF', secondary: '#F6F8FA', tertiary: '#F0F2F5', hover: '#E8EAED' },
      text: { primary: '#1F2328', secondary: '#57606A', muted: '#8C959F' },
      accent: { blue: '#0969DA', green: '#1A7F37', yellow: '#BF8700', red: '#D1242F', purple: '#8250DF' },
      border: '#D0D7DE',
      inputBg: '#FFFFFF',
    },
    terminal: {
      background: '#FFFFFF', foreground: '#1F2328', cursor: '#0969DA',
      black: '#24292F', red: '#D1242F', green: '#1A7F37', yellow: '#BF8700',
      blue: '#0969DA', magenta: '#8250DF', cyan: '#1B7C83', white: '#6E7781',
      brightBlack: '#57606A', brightRed: '#E4523F', brightGreen: '#2DA44E', brightYellow: '#D4A72C',
      brightBlue: '#218BFF', brightMagenta: '#A475F9', brightCyan: '#3192AA', brightWhite: '#8C959F',
    },
  },
  'tokyo-night': {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    type: 'dark',
    colors: {
      bg: { primary: '#1A1B26', secondary: '#16161E', tertiary: '#13131A', hover: '#292E42' },
      text: { primary: '#C0CAF5', secondary: '#787C99', muted: '#3B3D57' },
      accent: { blue: '#7AA2F7', green: '#9ECE6A', yellow: '#E0AF68', red: '#F7768E', purple: '#BB9AF7' },
      border: '#292E42',
      inputBg: '#16161E',
    },
    terminal: {
      background: '#1A1B26', foreground: '#A9B1D6', cursor: '#C0CAF5',
      black: '#32344A', red: '#F7768E', green: '#9ECE6A', yellow: '#E0AF68',
      blue: '#7AA2F7', magenta: '#AD8EE6', cyan: '#449DAB', white: '#787C99',
      brightBlack: '#444B6A', brightRed: '#FF7A93', brightGreen: '#B9F27C', brightYellow: '#FF9E64',
      brightBlue: '#7DA6FF', brightMagenta: '#BB9AF7', brightCyan: '#0DB9D7', brightWhite: '#ACB0D0',
    },
  },
  catppuccin: {
    id: 'catppuccin',
    name: 'Catppuccin Mocha',
    type: 'dark',
    colors: {
      bg: { primary: '#1E1E2E', secondary: '#181825', tertiary: '#11111B', hover: '#313244' },
      text: { primary: '#CDD6F4', secondary: '#A6ADC8', muted: '#6C7086' },
      accent: { blue: '#89B4FA', green: '#A6E3A1', yellow: '#F9E2AF', red: '#F38BA8', purple: '#CBA6F7' },
      border: '#45475A',
      inputBg: '#181825',
    },
    terminal: {
      background: '#1E1E2E', foreground: '#CDD6F4', cursor: '#F5E0DC',
      black: '#45475A', red: '#F38BA8', green: '#A6E3A1', yellow: '#F9E2AF',
      blue: '#89B4FA', magenta: '#F5C2E7', cyan: '#94E2D5', white: '#BAC2DE',
      brightBlack: '#585B70', brightRed: '#F38BA8', brightGreen: '#A6E3A1', brightYellow: '#F9E2AF',
      brightBlue: '#89B4FA', brightMagenta: '#F5C2E7', brightCyan: '#94E2D5', brightWhite: '#A6ADC8',
    },
  },
  'opencode-ayu': {
    id: 'opencode-ayu',
    name: 'Ayu Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#0B0E14", secondary: "#0F131A", tertiary: "#0D1017", hover: "#383d46" },
      text: { primary: "#BFBDB6", secondary: "#565B66", muted: "#626874" },
      accent: { blue: "#E6B450", green: "#7FD962", yellow: "#E6B673", red: "#D95757", purple: "#39BAE6" },
      border: "#6C7380",
      inputBg: "#0F131A",
    },
    terminal: {
      background: "#0B0E14", foreground: "#BFBDB6", cursor: "#E6B450",
      black: "#0F131A", red: "#D95757", green: "#7FD962", yellow: "#E6B673",
      blue: "#E6B450", magenta: "#39BAE6", cyan: "#b3c759", white: "#BFBDB6",
      brightBlack: "#626874", brightRed: "#d17674", brightGreen: "#92d17b", brightYellow: "#dab887",
      brightBlue: "#dab76f", brightMagenta: "#61bbd8", brightCyan: "#b3c759", brightWhite: "#BFBDB6",
    },
  },
  'opencode-catppuccin-light': {
    id: 'opencode-catppuccin-light',
    name: 'Catppuccin Light',
    type: 'light',
    colors: {
      bg: { primary: "#eff1f5", secondary: "#e6e9ef", tertiary: "#dce0e8", hover: "#d5d9e2" },
      text: { primary: "#4c4f69", secondary: "#7c7f93", muted: "#a8acba" },
      accent: { blue: "#ea76cb", green: "#40a02b", yellow: "#df8e1d", red: "#d20f39", purple: "#179299" },
      border: "#ccd0da",
      inputBg: "#e6e9ef",
    },
    terminal: {
      background: "#eff1f5", foreground: "#4c4f69", cursor: "#ea76cb",
      black: "#e6e9ef", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d",
      blue: "#ea76cb", magenta: "#179299", cyan: "#958b7b", white: "#4c4f69",
      brightBlack: "#a8acba", brightRed: "#aa2247", brightGreen: "#44883e", brightYellow: "#b37b34",
      brightBlue: "#bb6aae", brightMagenta: "#277e8b", brightCyan: "#958b7b", brightWhite: "#4c4f69",
    },
  },
  'opencode-cursor-light': {
    id: 'opencode-cursor-light',
    name: 'Cursor Light',
    type: 'light',
    colors: {
      bg: { primary: "#fcfcfc", secondary: "#f3f3f3", tertiary: "#ededed", hover: "#8b8b8b" },
      text: { primary: "#141414", secondary: "#141414ad", muted: "#141414" },
      accent: { blue: "#6f9ba6", green: "#1f8a65", yellow: "#db704b", red: "#cf2d56", purple: "#3c7cab" },
      border: "#14141413",
      inputBg: "#f3f3f3",
    },
    terminal: {
      background: "#fcfcfc", foreground: "#141414", cursor: "#6f9ba6",
      black: "#f3f3f3", red: "#cf2d56", green: "#1f8a65", yellow: "#db704b",
      blue: "#6f9ba6", magenta: "#3c7cab", cyan: "#479386", white: "#141414",
      brightBlack: "#141414", brightRed: "#972642", brightGreen: "#1c674d", brightYellow: "#9f543b",
      brightBlue: "#54737a", brightMagenta: "#305d7e", brightCyan: "#479386", brightWhite: "#141414",
    },
  },
  'opencode-github-dark': {
    id: 'opencode-github-dark',
    name: 'GitHub Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#0d1117", secondary: "#010409", tertiary: "#161b22", hover: "#22272e" },
      text: { primary: "#c9d1d9", secondary: "#8b949e", muted: "#596069" },
      accent: { blue: "#39c5cf", green: "#3fb950", yellow: "#e3b341", red: "#f85149", purple: "#d29922" },
      border: "#30363d",
      inputBg: "#010409",
    },
    terminal: {
      background: "#0d1117", foreground: "#c9d1d9", cursor: "#39c5cf",
      black: "#010409", red: "#f85149", green: "#3fb950", yellow: "#e3b341",
      blue: "#39c5cf", magenta: "#d29922", cyan: "#3cbf90", white: "#c9d1d9",
      brightBlack: "#596069", brightRed: "#ea7774", brightGreen: "#68c079", brightYellow: "#dbbc6f",
      brightBlue: "#64c9d2", brightMagenta: "#cfaa59", brightCyan: "#3cbf90", brightWhite: "#c9d1d9",
    },
  },
  'opencode-github-light': {
    id: 'opencode-github-light',
    name: 'GitHub Light',
    type: 'light',
    colors: {
      bg: { primary: "#ffffff", secondary: "#f6f8fa", tertiary: "#f0f3f6", hover: "#e2e6eb" },
      text: { primary: "#24292f", secondary: "#57606a", muted: "#9aa1aa" },
      accent: { blue: "#1b7c83", green: "#1a7f37", yellow: "#9a6700", red: "#cf222e", purple: "#bc4c00" },
      border: "#d0d7de",
      inputBg: "#f6f8fa",
    },
    terminal: {
      background: "#ffffff", foreground: "#24292f", cursor: "#1b7c83",
      black: "#f6f8fa", red: "#cf222e", green: "#1a7f37", yellow: "#9a6700",
      blue: "#1b7c83", magenta: "#bc4c00", cyan: "#1b7e5d", white: "#24292f",
      brightBlack: "#9aa1aa", brightRed: "#9c242e", brightGreen: "#1d6535", brightYellow: "#77540e",
      brightBlue: "#1e636a", brightMagenta: "#8e420e", brightCyan: "#1b7e5d", brightWhite: "#24292f",
    },
  },
  'opencode-mercury-dark': {
    id: 'opencode-mercury-dark',
    name: 'Mercury Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#171721", secondary: "#10101a", tertiary: "#272735", hover: "#666877" },
      text: { primary: "#dddde5", secondary: "#9d9da8", muted: "#aaabba" },
      accent: { blue: "#8da4f5", green: "#77c599", yellow: "#fc9b6f", red: "#fc92b4", purple: "#77becf" },
      border: "#b4b7c81f",
      inputBg: "#10101a",
    },
    terminal: {
      background: "#171721", foreground: "#dddde5", cursor: "#8da4f5",
      black: "#10101a", red: "#fc92b4", green: "#77c599", yellow: "#fc9b6f",
      blue: "#8da4f5", magenta: "#77becf", cyan: "#82b5c7", white: "#dddde5",
      brightBlack: "#aaabba", brightRed: "#f3a9c3", brightGreen: "#96ccb0", brightYellow: "#f3af92",
      brightBlue: "#a5b5f0", brightMagenta: "#96c7d6", brightCyan: "#82b5c7", brightWhite: "#dddde5",
    },
  },
  'opencode-mercury-light': {
    id: 'opencode-mercury-light',
    name: 'Mercury Light',
    type: 'light',
    colors: {
      bg: { primary: "#ffffff", secondary: "#fbfcfd", tertiary: "#f4f5f9", hover: "#b9bbcb" },
      text: { primary: "#363644", secondary: "#70707d", muted: "#707289" },
      accent: { blue: "#8da4f5", green: "#036e43", yellow: "#a44200", red: "#b0175f", purple: "#007f95" },
      border: "#7073931a",
      inputBg: "#fbfcfd",
    },
    terminal: {
      background: "#ffffff", foreground: "#363644", cursor: "#8da4f5",
      black: "#fbfcfd", red: "#b0175f", green: "#036e43", yellow: "#a44200",
      blue: "#8da4f5", magenta: "#007f95", cyan: "#48899c", white: "#363644",
      brightBlack: "#707289", brightRed: "#8b2057", brightGreen: "#125d43", brightYellow: "#833e14",
      brightBlue: "#7383c0", brightMagenta: "#10697d", brightCyan: "#48899c", brightWhite: "#363644",
    },
  },
  'opencode-nord-light': {
    id: 'opencode-nord-light',
    name: 'Nord Light',
    type: 'light',
    colors: {
      bg: { primary: "#ECEFF4", secondary: "#E5E9F0", tertiary: "#D8DEE9", hover: "#99a1b0" },
      text: { primary: "#2E3440", secondary: "#3B4252", muted: "#444d5f" },
      accent: { blue: "#8FBCBB", green: "#A3BE8C", yellow: "#D08770", red: "#BF616A", purple: "#5E81AC" },
      border: "#4C566A",
      inputBg: "#E5E9F0",
    },
    terminal: {
      background: "#ECEFF4", foreground: "#2E3440", cursor: "#8FBCBB",
      black: "#E5E9F0", red: "#BF616A", green: "#A3BE8C", yellow: "#D08770",
      blue: "#8FBCBB", magenta: "#5E81AC", cyan: "#99bda4", white: "#2E3440",
      brightBlack: "#444d5f", brightRed: "#94545d", brightGreen: "#809575", brightYellow: "#9f6e62",
      brightBlue: "#729396", brightMagenta: "#506a8c", brightCyan: "#99bda4", brightWhite: "#2E3440",
    },
  },
  'opencode-opencode-light': {
    id: 'opencode-opencode-light',
    name: 'OpenCode Light',
    type: 'light',
    colors: {
      bg: { primary: "#ffffff", secondary: "#fafafa", tertiary: "#f5f5f5", hover: "#dadada" },
      text: { primary: "#1a1a1a", secondary: "#8a8a8a", muted: "#a3a3a3" },
      accent: { blue: "#d68c27", green: "#3d9a57", yellow: "#d68c27", red: "#d1383d", purple: "#318795" },
      border: "#b8b8b8",
      inputBg: "#fafafa",
    },
    terminal: {
      background: "#ffffff", foreground: "#1a1a1a", cursor: "#d68c27",
      black: "#fafafa", red: "#d1383d", green: "#3d9a57", yellow: "#d68c27",
      blue: "#d68c27", magenta: "#318795", cyan: "#8a933f", white: "#1a1a1a",
      brightBlack: "#a3a3a3", brightRed: "#9a2f33", brightGreen: "#337445", brightYellow: "#9e6a23",
      brightBlue: "#9e6a23", brightMagenta: "#2a6670", brightCyan: "#8a933f", brightWhite: "#1a1a1a",
    },
  },
  'opencode-osaka-jade-light': {
    id: 'opencode-osaka-jade-light',
    name: 'Osaka Jade Light',
    type: 'light',
    colors: {
      bg: { primary: "#F6F5DD", secondary: "#E8E7CC", tertiary: "#D5D4B8", hover: "#c1c0a4" },
      text: { primary: "#111c18", secondary: "#53685B", muted: "#828b76" },
      accent: { blue: "#3d7a52", green: "#3d7a52", yellow: "#b5a020", red: "#c7392d", purple: "#1faa90" },
      border: "#A8A78C",
      inputBg: "#E8E7CC",
    },
    terminal: {
      background: "#F6F5DD", foreground: "#111c18", cursor: "#3d7a52",
      black: "#E8E7CC", red: "#c7392d", green: "#3d7a52", yellow: "#b5a020",
      blue: "#3d7a52", magenta: "#1faa90", cyan: "#3d7a52", white: "#111c18",
      brightBlack: "#828b76", brightRed: "#903027", brightGreen: "#305e41", brightYellow: "#84781e",
      brightBlue: "#305e41", brightMagenta: "#1b7f6c", brightCyan: "#3d7a52", brightWhite: "#111c18",
    },
  },
  'opencode-palenight-dark': {
    id: 'opencode-palenight-dark',
    name: 'Palenight Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#292d3e", secondary: "#1e2132", tertiary: "#32364a", hover: "#32364a" },
      text: { primary: "#a6accd", secondary: "#676e95", muted: "#4a4f6c" },
      accent: { blue: "#89ddff", green: "#c3e88d", yellow: "#ffcb6b", red: "#f07178", purple: "#f78c6c" },
      border: "#32364a",
      inputBg: "#1e2132",
    },
    terminal: {
      background: "#292d3e", foreground: "#a6accd", cursor: "#89ddff",
      black: "#1e2132", red: "#f07178", green: "#c3e88d", yellow: "#ffcb6b",
      blue: "#89ddff", magenta: "#f78c6c", cyan: "#a6e3c6", white: "#a6accd",
      brightBlack: "#4a4f6c", brightRed: "#da8392", brightGreen: "#bad6a0", brightYellow: "#e4c288",
      brightBlue: "#92cef0", brightMagenta: "#df9689", brightCyan: "#a6e3c6", brightWhite: "#a6accd",
    },
  },
  'opencode-rosepine-dark': {
    id: 'opencode-rosepine-dark',
    name: 'Rosé Pine Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#191724", secondary: "#1f1d2e", tertiary: "#26233a", hover: "#322f45" },
      text: { primary: "#e0def4", secondary: "#6e6a86", muted: "#555169" },
      accent: { blue: "#ebbcba", green: "#31748f", yellow: "#f6c177", red: "#eb6f92", purple: "#9ccfd8" },
      border: "#403d52",
      inputBg: "#1f1d2e",
    },
    terminal: {
      background: "#191724", foreground: "#e0def4", cursor: "#ebbcba",
      black: "#1f1d2e", red: "#eb6f92", green: "#31748f", yellow: "#f6c177",
      blue: "#ebbcba", magenta: "#9ccfd8", cyan: "#8e98a5", white: "#e0def4",
      brightBlack: "#555169", brightRed: "#e890af", brightGreen: "#6694ad", brightYellow: "#efca9d",
      brightBlue: "#e8c6cb", brightMagenta: "#b0d4e0", brightCyan: "#8e98a5", brightWhite: "#e0def4",
    },
  },
  'opencode-rosepine-light': {
    id: 'opencode-rosepine-light',
    name: 'Rosé Pine Light',
    type: 'light',
    colors: {
      bg: { primary: "#faf4ed", secondary: "#fffaf3", tertiary: "#f2e9e1", hover: "#e9e2dd" },
      text: { primary: "#575279", secondary: "#9893a5", muted: "#bfbac2" },
      accent: { blue: "#d7827e", green: "#286983", yellow: "#ea9d34", red: "#b4637a", purple: "#56949f" },
      border: "#dfdad9",
      inputBg: "#fffaf3",
    },
    terminal: {
      background: "#faf4ed", foreground: "#575279", cursor: "#d7827e",
      black: "#fffaf3", red: "#b4637a", green: "#286983", yellow: "#ea9d34",
      blue: "#d7827e", magenta: "#56949f", cyan: "#807681", white: "#575279",
      brightBlack: "#bfbac2", brightRed: "#985e7a", brightGreen: "#366280", brightYellow: "#be8749",
      brightBlue: "#b1747d", brightMagenta: "#568094", brightCyan: "#807681", brightWhite: "#575279",
    },
  },
  'opencode-synthwave84-dark': {
    id: 'opencode-synthwave84-dark',
    name: 'Synthwave \'84 Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#262335", secondary: "#1e1a29", tertiary: "#2a2139", hover: "#383862" },
      text: { primary: "#ffffff", secondary: "#848bbd", muted: "#646da7" },
      accent: { blue: "#b084eb", green: "#72f1b8", yellow: "#fede5d", red: "#fe4450", purple: "#ff8b39" },
      border: "#495495",
      inputBg: "#1e1a29",
    },
    terminal: {
      background: "#262335", foreground: "#ffffff", cursor: "#b084eb",
      black: "#1e1a29", red: "#fe4450", green: "#72f1b8", yellow: "#fede5d",
      blue: "#b084eb", magenta: "#ff8b39", cyan: "#91bbd2", white: "#ffffff",
      brightBlack: "#646da7", brightRed: "#fe7c85", brightGreen: "#9cf5cd", brightYellow: "#fee88e",
      brightBlue: "#c8a9f1", brightMagenta: "#ffae74", brightCyan: "#91bbd2", brightWhite: "#ffffff",
    },
  },
  'opencode-synthwave84-light': {
    id: 'opencode-synthwave84-light',
    name: 'Synthwave \'84 Light',
    type: 'light',
    colors: {
      bg: { primary: "#fafafa", secondary: "#f5f5f5", tertiary: "#eeeeee", hover: "#e8e8e8" },
      text: { primary: "#262335", secondary: "#5c5c8a", muted: "#a5a5b9" },
      accent: { blue: "#9c27b0", green: "#4caf50", yellow: "#ff9800", red: "#f44336", purple: "#ff5722" },
      border: "#e0e0e0",
      inputBg: "#f5f5f5",
    },
    terminal: {
      background: "#fafafa", foreground: "#262335", cursor: "#9c27b0",
      black: "#f5f5f5", red: "#f44336", green: "#4caf50", yellow: "#ff9800",
      blue: "#9c27b0", magenta: "#ff5722", cyan: "#746b80", white: "#262335",
      brightBlack: "#a5a5b9", brightRed: "#b63936", brightGreen: "#418548", brightYellow: "#be7510",
      brightBlue: "#79268b", brightMagenta: "#be4728", brightCyan: "#746b80", brightWhite: "#262335",
    },
  },
  'opencode-tokyonight-dark': {
    id: 'opencode-tokyonight-dark',
    name: 'Tokyo Night Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#1a1b26", secondary: "#1e2030", tertiary: "#222436", hover: "#464b67" },
      text: { primary: "#c8d3f5", secondary: "#828bb8", muted: "#7a82ac" },
      accent: { blue: "#ff966c", green: "#c3e88d", yellow: "#ff966c", red: "#ff757f", purple: "#82aaff" },
      border: "#737aa2",
      inputBg: "#1e2030",
    },
    terminal: {
      background: "#1a1b26", foreground: "#c8d3f5", cursor: "#ff966c",
      black: "#1e2030", red: "#ff757f", green: "#c3e88d", yellow: "#ff966c",
      blue: "#ff966c", magenta: "#82aaff", cyan: "#e1bf7d", white: "#c8d3f5",
      brightBlack: "#7a82ac", brightRed: "#ef91a2", brightGreen: "#c5e2ac", brightYellow: "#efa895",
      brightBlue: "#efa895", brightMagenta: "#97b6fc", brightCyan: "#e1bf7d", brightWhite: "#c8d3f5",
    },
  },
}

Object.assign(THEMES, {
  'glass-tokyo': { ...THEMES['tokyo-night'], id: 'glass-tokyo', name: 'Tokyo Night Glass', surfaceOpacity: 0.72 },
  'glass-catppuccin': { ...THEMES.catppuccin, id: 'glass-catppuccin', name: 'Catppuccin Mocha Glass', surfaceOpacity: 0.74 },
  'glass-dracula': { ...THEMES.dark, id: 'glass-dracula', name: 'Dracula Glass', surfaceOpacity: 0.7, colors: { ...THEMES.dark.colors, bg: { primary: '#171824', secondary: '#202231', tertiary: '#2a2d42', hover: '#3c405b' }, accent: { ...THEMES.dark.colors.accent, blue: '#8BE9FD', purple: '#BD93F9' } } },
  'glass-nord': { ...THEMES.dark, id: 'glass-nord', name: 'Nord Frosted Glass', surfaceOpacity: 0.76, colors: { ...THEMES.dark.colors, bg: { primary: '#17212B', secondary: '#1D2A36', tertiary: '#263747', hover: '#344B5F' }, accent: { blue: '#88C0D0', green: '#A3BE8C', yellow: '#EBCB8B', red: '#BF616A', purple: '#B48EAD' } } },
})

export const THEME_IDS = Object.keys(THEMES)
export const DEFAULT_THEME_ID = 'dark'
export const defaultTheme = THEMES[DEFAULT_THEME_ID]

let customThemes: Record<string, ThemeTokens> = {}

export function getThemeIds(): string[] {
  return [...THEME_IDS, ...Object.keys(customThemes)]
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
}

export function normalizeCustomTheme(value: unknown): ThemeTokens | null {
  if (!value || typeof value !== 'object') return null
  const theme = value as ThemeTokens
  if (typeof theme.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,48}$/i.test(theme.id)) return null
  if (THEME_IDS.includes(theme.id) || typeof theme.name !== 'string' || !theme.name.trim() || !['dark', 'light'].includes(theme.type)) return null
  const groups = theme.colors
  if (!groups || !groups.bg || !groups.text || !groups.accent || typeof groups.border !== 'string' || typeof groups.inputBg !== 'string') return null
  const requiredColors = [groups.bg.primary, groups.bg.secondary, groups.bg.tertiary, groups.bg.hover, groups.text.primary, groups.text.secondary, groups.text.muted, groups.accent.blue, groups.accent.green, groups.accent.yellow, groups.accent.red, groups.accent.purple, groups.border, groups.inputBg]
  if (!requiredColors.every(isHexColor)) return null
  if (!theme.terminal || !Object.keys(defaultTheme.terminal).every(key => isHexColor(Reflect.get(theme.terminal, key)))) return null
  const normalizedColors = Object.fromEntries(Object.entries(groups).map(([key, color]) => [key, typeof color === 'string' ? color.trim() : Object.fromEntries(Object.entries(color).map(([name, value]) => [name, (value as string).trim()]))])) as ThemeTokens['colors']
  return {
    id: theme.id.trim(),
    name: theme.name.trim().slice(0, 80),
    type: theme.type,
    colors: normalizedColors,
    terminal: Object.fromEntries(Object.keys(defaultTheme.terminal).map(key => [key, Reflect.get(theme.terminal, key).trim()])) as ThemeTokens['terminal'],
    surfaceOpacity: typeof theme.surfaceOpacity === 'number' ? Math.min(0.95, Math.max(0.35, theme.surfaceOpacity)) : undefined,
  }
}

export function registerCustomThemes(values: unknown[]): ThemeTokens[] {
  const valid = Array.isArray(values)
    ? values.map(normalizeCustomTheme).filter((theme): theme is ThemeTokens => Boolean(theme))
    : []
  customThemes = Object.fromEntries(valid.map(theme => [theme.id, theme]))
  return Object.values(customThemes)
}

export function getTheme(themeId?: string | null): ThemeTokens {
  if (!themeId) return THEMES[DEFAULT_THEME_ID]
  return customThemes[themeId] ?? THEMES[themeId] ?? THEMES[DEFAULT_THEME_ID]
}

export function themeToCssVariables(theme: ThemeTokens): Record<string, string> {
  const surfaceColor = (color: string, alpha = theme.surfaceOpacity) => alpha == null ? color : toRgba(color, alpha)
  const terminalColors = Object.fromEntries(Object.entries(theme.terminal).map(([name, color]) => [`--terminal-ansi-${name}`, color]))
  return {
    '--color-bg-primary': surfaceColor(theme.colors.bg.primary),
    '--color-bg-secondary': surfaceColor(theme.colors.bg.secondary, theme.surfaceOpacity == null ? undefined : Math.min(0.94, theme.surfaceOpacity + 0.12)),
    '--color-bg-tertiary': surfaceColor(theme.colors.bg.tertiary, theme.surfaceOpacity == null ? undefined : Math.min(0.96, theme.surfaceOpacity + 0.16)),
    '--color-bg-hover': surfaceColor(theme.colors.bg.hover, theme.surfaceOpacity == null ? undefined : Math.min(0.98, theme.surfaceOpacity + 0.2)),
    '--color-text-primary': theme.colors.text.primary,
    '--color-text-secondary': theme.colors.text.secondary,
    '--color-text-muted': theme.colors.text.muted,
    '--color-accent-blue': theme.colors.accent.blue,
    '--color-accent-green': theme.colors.accent.green,
    '--color-accent-yellow': theme.colors.accent.yellow,
    '--color-accent-red': theme.colors.accent.red,
    '--color-accent-purple': theme.colors.accent.purple,
    '--color-border': theme.colors.border,
    '--color-input-bg': surfaceColor(theme.colors.inputBg, theme.surfaceOpacity == null ? undefined : Math.min(0.94, theme.surfaceOpacity + 0.12)),
    ...terminalColors,
  }
}

export function buildSurfaceVars(themeId?: string | null): Record<string, string> {
  const theme = getTheme(themeId)
  const shadowBase = theme.type === 'dark' ? '#000000' : theme.colors.text.primary
  const shadowRgb = toRgbTriplet(shadowBase)
  const opacity = theme.surfaceOpacity
  const surface = (color: string) => opacity == null ? color : toRgba(color, opacity)
  const softSurface = (color: string) => opacity == null ? color : toRgba(color, Math.min(0.96, opacity * 0.88))

  return {
    '--surface-app-backdrop': surface(theme.colors.bg.primary),
    '--surface-panel': surface(theme.colors.bg.primary),
    '--surface-panel-strong': surface(theme.colors.bg.secondary),
    '--surface-panel-soft': softSurface(theme.colors.bg.secondary),
    '--surface-overlay': surface(theme.colors.bg.primary),
    '--surface-dialog': surface(theme.colors.bg.primary),
    '--surface-shadow-rgb': shadowRgb,
    '--surface-accent-blue-soft': toRgba(theme.colors.accent.blue, theme.type === 'dark' ? 0.16 : 0.12),
    '--surface-accent-blue-border': toRgba(theme.colors.accent.blue, theme.type === 'dark' ? 0.4 : 0.28),
    '--surface-accent-blue-strong': toRgba(theme.colors.accent.blue, theme.type === 'dark' ? 0.34 : 0.28),
    '--surface-accent-blue-fade': toRgba(theme.colors.accent.blue, theme.type === 'dark' ? 0.18 : 0.16),
    '--surface-accent-purple-soft': toRgba(theme.colors.accent.purple, theme.type === 'dark' ? 0.16 : 0.12),
    '--surface-accent-purple-border': toRgba(theme.colors.accent.purple, theme.type === 'dark' ? 0.42 : 0.28),
    '--surface-success-soft': toRgba(theme.colors.accent.green, theme.type === 'dark' ? 0.14 : 0.1),
    '--surface-success-border': toRgba(theme.colors.accent.green, theme.type === 'dark' ? 0.4 : 0.24),
    '--surface-danger-soft': toRgba(theme.colors.accent.red, theme.type === 'dark' ? 0.14 : 0.1),
    '--surface-danger-border': toRgba(theme.colors.accent.red, theme.type === 'dark' ? 0.4 : 0.24),
    '--surface-card-border': toRgba(theme.colors.border, 0.7),
    '--surface-divider-soft': toRgba(theme.colors.border, 0.58),
    '--surface-divider-muted': toRgba(theme.colors.border, 0.5),
  }
}

export function buildTerminalTheme(themeId?: string | null): ITheme {
  const theme = getTheme(themeId)
  const background = theme.surfaceOpacity == null ? theme.terminal.background : '#00000000'
  if (theme.type === 'dark') return { ...theme.terminal, background }
  // Some light themes use pastel accents; mix in text color so selection stays visible.
  const foreground = toRgb(theme.terminal.foreground)
  const selection = toRgb(theme.colors.accent.blue)
    .map((channel, index) => Math.round((channel + foreground[index]) / 2)).join(', ')
  return {
    ...theme.terminal,
    background,
    selectionBackground: `rgba(${selection}, 0.45)`,
    selectionInactiveBackground: `rgba(${selection}, 0.3)`,
    selectionForeground: theme.terminal.foreground,
  }
}

/**
 * Monaco YAML tokens use the `.yaml` suffix.
 * Light: classic IDEA-style — navy keys, green comments, near-black string values on white.
 * Dark: same structure — blue keys, green comments, body-text string values.
 */
function buildYamlMonacoTokenRules(theme: ThemeTokens): MonacoThemeDefinition['rules'] {
  const h = (hex: string) => stripHash(hex)
  const c = theme.colors
  const isLight = theme.type === 'light'
  const keyYaml = isLight ? '003366' : h(c.accent.blue)
  const commentYaml = h(c.accent.green)
  const stringYaml = h(c.text.primary)
  const numberYaml = h(c.accent.yellow)
  const keywordYaml = h(c.accent.purple)
  const opYaml = h(c.text.secondary)
  const metaYaml = h(c.accent.yellow)
  const tagYaml = h(c.accent.purple)
  const nsYaml = h(c.accent.blue)

  return [
    { token: 'type.yaml', foreground: keyYaml },
    { token: 'comment.yaml', foreground: commentYaml, fontStyle: 'italic' },
    { token: 'string.yaml', foreground: stringYaml },
    { token: 'string.escape.yaml', foreground: h(c.accent.blue) },
    { token: 'string.invalid.yaml', foreground: h(c.accent.red) },
    { token: 'string.escape.invalid.yaml', foreground: h(c.accent.yellow) },
    { token: 'keyword.yaml', foreground: keywordYaml },
    { token: 'number.yaml', foreground: numberYaml },
    { token: 'number.float.yaml', foreground: numberYaml },
    { token: 'number.hex.yaml', foreground: numberYaml },
    { token: 'number.octal.yaml', foreground: numberYaml },
    { token: 'number.date.yaml', foreground: numberYaml },
    { token: 'number.infinity.yaml', foreground: numberYaml },
    { token: 'number.nan.yaml', foreground: numberYaml },
    { token: 'operators.yaml', foreground: opYaml },
    { token: 'operators.directivesEnd.yaml', foreground: nsYaml },
    { token: 'operators.documentEnd.yaml', foreground: nsYaml },
    { token: 'meta.directive.yaml', foreground: metaYaml },
    { token: 'tag.yaml', foreground: tagYaml },
    { token: 'namespace.yaml', foreground: nsYaml },
    { token: 'delimiter.comma.yaml', foreground: h(c.text.muted) },
    { token: 'delimiter.bracket.yaml', foreground: opYaml },
    { token: 'delimiter.square.yaml', foreground: opYaml },
  ]
}

export function toMonacoThemeDefinition(themeId?: string | null): MonacoThemeDefinition {
  const theme = getTheme(themeId)
  const isLight = theme.type === 'light'
  const isTransparent = theme.surfaceOpacity != null
  const editorBackground = isTransparent ? '00000000' : stripHash(theme.colors.bg.primary)
  const stringForeground = stripHash(theme.colors.accent.green)
  const editorSelectionBackground = toHexWithAlpha(theme.colors.accent.blue, isLight ? 0.18 : 0.22)
  const editorInactiveSelectionBackground = toHexWithAlpha(theme.colors.accent.blue, isLight ? 0.1 : 0.14)
  return {
    base: isLight ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: stripHash(theme.colors.accent.green), fontStyle: 'italic' },
      { token: 'keyword', foreground: stripHash(theme.colors.accent.purple) },
      { token: 'string', foreground: stringForeground },
      { token: 'string.invalid', foreground: stringForeground, background: editorBackground },
      { token: 'string.escape.invalid', foreground: stripHash(theme.colors.accent.yellow), background: editorBackground },
      { token: 'invalid', foreground: stripHash(theme.colors.accent.red), background: editorBackground },
      { token: 'number', foreground: stripHash(theme.colors.accent.yellow) },
      { token: 'function', foreground: stripHash(theme.colors.accent.blue) },
      { token: 'type', foreground: stripHash(theme.colors.accent.blue) },
      ...buildYamlMonacoTokenRules(theme),
    ],
    colors: {
      'editor.background': isTransparent ? '#00000000' : theme.colors.bg.primary,
      'editor.foreground': theme.colors.text.primary,
      'editorLineNumber.foreground': theme.colors.text.muted,
      'editorLineNumber.activeForeground': theme.colors.text.secondary,
      'editorCursor.foreground': theme.colors.accent.blue,
      'editor.selectionBackground': editorSelectionBackground,
      'editor.inactiveSelectionBackground': editorInactiveSelectionBackground,
      'selection.background': editorSelectionBackground,
      'editor.lineHighlightBackground': toHexWithAlpha(theme.colors.bg.hover, isLight ? 0.35 : 0.3),
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionHighlightBorder': '#00000000',
      'editor.wordHighlightBorder': '#00000000',
      'editor.wordHighlightStrongBorder': '#00000000',
      'editor.findMatchBorder': '#00000000',
      'editor.findMatchHighlightBorder': '#00000000',
      'editor.rangeHighlightBackground': '#00000000',
      'editor.rangeHighlightBorder': '#00000000',
      'editor.selectionHighlightBackground': '#00000000',
      'editor.wordHighlightBackground': '#00000000',
      'editor.wordHighlightStrongBackground': '#00000000',
      'editor.wordHighlightTextBackground': '#00000000',
      'editorBracketMatch.background': '#00000000',
      'editorBracketMatch.border': '#00000000',
      'editorError.foreground': theme.colors.accent.red,
      'editorError.background': '#00000000',
      'editorError.border': '#00000000',
      'editorWarning.foreground': theme.colors.accent.yellow,
      'editorWarning.background': '#00000000',
      'editorWarning.border': '#00000000',
      ...buildMonacoOverviewRulerColors(),
      'focusBorder': theme.colors.accent.blue,
      'editorGutter.background': isTransparent ? '#00000000' : theme.colors.bg.primary,
      ...buildMonacoGuideColors(theme),
      'editorWhitespace.foreground': toHexWithAlpha(theme.colors.text.muted, 0.7),
      'editorWidget.background': theme.colors.bg.secondary,
      'editorWidget.border': theme.colors.border,
      'editorSuggestWidget.background': theme.colors.bg.secondary,
      'editorSuggestWidget.border': theme.colors.border,
      'editorSuggestWidget.selectedBackground': toHexWithAlpha(theme.colors.bg.hover, 0.9),
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': toHexWithAlpha(theme.colors.bg.hover, 0.8),
      'scrollbarSlider.hoverBackground': theme.colors.bg.hover,
      'scrollbarSlider.activeBackground': theme.colors.border,
      'minimapSlider.background': toHexWithAlpha(theme.colors.bg.hover, 0.5),
      'minimapSlider.hoverBackground': toHexWithAlpha(theme.colors.bg.hover, 0.66),
      'minimapSlider.activeBackground': toHexWithAlpha(theme.colors.border, 0.72),
    },
  }
}

function buildMonacoOverviewRulerColors(): Record<string, string> {
  return {
    'editorOverviewRuler.background': '#00000000',
    'editorOverviewRuler.border': '#00000000',
    'editorOverviewRuler.findMatchForeground': '#00000000',
    'editorOverviewRuler.rangeHighlightForeground': '#00000000',
    'editorOverviewRuler.selectionHighlightForeground': '#00000000',
    'editorOverviewRuler.wordHighlightForeground': '#00000000',
    'editorOverviewRuler.wordHighlightStrongForeground': '#00000000',
    'editorOverviewRuler.modifiedForeground': '#00000000',
    'editorOverviewRuler.addedForeground': '#00000000',
    'editorOverviewRuler.deletedForeground': '#00000000',
    'editorOverviewRuler.errorForeground': '#00000000',
    'editorOverviewRuler.warningForeground': '#00000000',
    'editorOverviewRuler.infoForeground': '#00000000',
    'editorOverviewRuler.bracketMatchForeground': '#00000000',
    'editorOverviewRuler.currentContentForeground': '#00000000',
    'editorOverviewRuler.incomingContentForeground': '#00000000',
    'editorOverviewRuler.commonContentForeground': '#00000000',
  }
}

function buildMonacoGuideColors(theme: ThemeTokens): Record<string, string> {
  const guideColor = toHexWithAlpha(theme.colors.border, 0.58)
  const activeGuideColor = toHexWithAlpha(theme.colors.text.muted, 0.78)
  const bracketForeground = theme.colors.text.muted
  const colors: Record<string, string> = {
    'editorBracketHighlight.unexpectedBracket.foreground': theme.colors.accent.red,
  }

  for (let index = 1; index <= 6; index += 1) {
    colors[`editorIndentGuide.background${index}`] = guideColor
    colors[`editorIndentGuide.activeBackground${index}`] = activeGuideColor
    colors[`editorBracketPairGuide.background${index}`] = guideColor
    colors[`editorBracketPairGuide.activeBackground${index}`] = activeGuideColor
    colors[`editorBracketHighlight.foreground${index}`] = bracketForeground
  }

  return colors
}

export function applyTheme(themeInput: ThemeTokens | string): ThemeTokens {
  const theme = typeof themeInput === 'string' ? getTheme(themeInput) : themeInput
  const vars = { ...themeToCssVariables(theme), ...buildSurfaceVars(theme.id) }
  const root = document.documentElement
  Array.from(root.classList).forEach((className) => {
    if (className.startsWith('theme-')) root.classList.remove(className)
  })
  root.classList.add(`theme-${theme.id}`)
  root.classList.toggle('theme-transparent', theme.surfaceOpacity != null)
  Object.entries(vars).forEach(([key, value]) => {
    root.style.setProperty(key, value)
  })
  root.style.colorScheme = theme.type
  root.dataset.themeId = theme.id
  return theme
}

function stripHash(hex: string): string {
  return hex.replace('#', '')
}

function toRgba(hex: string, alpha: number): string {
  const [r, g, b] = toRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Monaco `defineTheme` parses `colors` with `Color.fromHex` only (#RGB / #RGBA / #RRGGBB / #RRGGBBAA). */
function toHexWithAlpha(hex: string, alpha: number): string {
  const [r, g, b] = toRgb(hex)
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
  const h = (n: number) => n.toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}${h(a)}`
}

function toRgbTriplet(hex: string): string {
  const [r, g, b] = toRgb(hex)
  return `${r} ${g} ${b}`
}

function toRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '')
  const safe = normalized.length === 3
    ? normalized.split('').map((part) => `${part}${part}`).join('')
    : normalized
  const value = Number.parseInt(safe, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}
