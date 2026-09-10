import type { ThemeTokens } from '@/types'

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
  'shen-dian': {
    id: 'shen-dian',
    name: '像素风圣殿蓝金',
    type: 'dark',
    colors: {
      bg: { primary: '#2B2A5E', secondary: '#3A386B', tertiary: '#1E1D45', hover: '#4040A0' },
      text: { primary: '#F0EDFF', secondary: '#9E9BBF', muted: '#6B688A' },
      accent: { blue: '#D4AF5E', green: '#2E5FCC', yellow: '#E8C86A', red: '#C44A4A', purple: '#7B6FCF' },
      border: '#8B7340',
      inputBg: '#3A386B',
    },
    terminal: {
      background: '#1E1D45', foreground: '#F0EDFF', cursor: '#D4AF5E',
      black: '#2B2A5E', red: '#C44A4A', green: '#2E5FCC', yellow: '#E8C86A',
      blue: '#5B6FD4', magenta: '#7B6FCF', cyan: '#5BA4D4', white: '#B8B4D4',
      brightBlack: '#6B688A', brightRed: '#FF6B6B', brightGreen: '#5B9AFF', brightYellow: '#FFD700',
      brightBlue: '#7B8AFF', brightMagenta: '#B09AFF', brightCyan: '#7BC4FF', brightWhite: '#F0EDFF',
    },
  },
  'solarized-dark': {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    type: 'dark',
    colors: {
      bg: { primary: '#002B36', secondary: '#073642', tertiary: '#0A4050', hover: '#124D5C' },
      text: { primary: '#FDF6E3', secondary: '#93A1A1', muted: '#657B83' },
      accent: { blue: '#268BD2', green: '#859900', yellow: '#B58900', red: '#DC322F', purple: '#6C71C4' },
      border: '#0A4050',
      inputBg: '#073642',
    },
    terminal: {
      background: '#002B36', foreground: '#FDF6E3', cursor: '#268BD2',
      black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900',
      blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
      brightBlack: '#586E75', brightRed: '#CB4B16', brightGreen: '#859900', brightYellow: '#B58900',
      brightBlue: '#268BD2', brightMagenta: '#6C71C4', brightCyan: '#2AA198', brightWhite: '#FDF6E3',
    },
  },
  monokai: {
    id: 'monokai',
    name: 'Monokai',
    type: 'dark',
    colors: {
      bg: { primary: '#272822', secondary: '#1E1F1B', tertiary: '#1A1B18', hover: '#3E3D32' },
      text: { primary: '#F8F8F2', secondary: '#90908A', muted: '#5C5C50' },
      accent: { blue: '#66D9E8', green: '#A6E22E', yellow: '#E6DB74', red: '#F92672', purple: '#AE81FF' },
      border: '#3E3D32',
      inputBg: '#1E1F1B',
    },
    terminal: {
      background: '#272822', foreground: '#F8F8F2', cursor: '#F8F8F0',
      black: '#272822', red: '#F92672', green: '#A6E22E', yellow: '#F4BF75',
      blue: '#66D9E8', magenta: '#AE81FF', cyan: '#A1EFE4', white: '#F8F8F2',
      brightBlack: '#75715E', brightRed: '#F92672', brightGreen: '#A6E22E', brightYellow: '#F4BF75',
      brightBlue: '#66D9E8', brightMagenta: '#AE81FF', brightCyan: '#A1EFE4', brightWhite: '#F9F8F5',
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
  'ayu-light': {
    id: 'ayu-light',
    name: 'Ayu Light',
    type: 'light',
    colors: {
      bg: { primary: '#FAFAFA', secondary: '#F3F4F5', tertiary: '#E7E8E9', hover: '#D9DADB' },
      text: { primary: '#575F66', secondary: '#8A9199', muted: '#ABB0B6' },
      accent: { blue: '#399EE6', green: '#86B300', yellow: '#F2AE49', red: '#F07171', purple: '#A37ACC' },
      border: '#D9DADB',
      inputBg: '#FAFAFA',
    },
    terminal: {
      background: '#FAFAFA', foreground: '#575F66', cursor: '#FF9940',
      black: '#000000', red: '#D32F2F', green: '#388E3C', yellow: '#F57F17',
      blue: '#1565C0', magenta: '#7B1FA2', cyan: '#00838F', white: '#9E9E9E',
      brightBlack: '#757575', brightRed: '#E53935', brightGreen: '#43A047', brightYellow: '#F9A825',
      brightBlue: '#1976D2', brightMagenta: '#8E24AA', brightCyan: '#00ACC1', brightWhite: '#BDBDBD',
    },
  },
  'solarized-light': {
    id: 'solarized-light',
    name: 'Solarized Light',
    type: 'light',
    colors: {
      bg: { primary: '#FDF6E3', secondary: '#EEE8D5', tertiary: '#E4DCCA', hover: '#D8D0BE' },
      text: { primary: '#657B83', secondary: '#839496', muted: '#93A1A1' },
      accent: { blue: '#268BD2', green: '#859900', yellow: '#B58900', red: '#DC322F', purple: '#6C71C4' },
      border: '#D0C9B5',
      inputBg: '#FDF6E3',
    },
    terminal: {
      background: '#FDF6E3', foreground: '#657B83', cursor: '#268BD2',
      black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900',
      blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
      brightBlack: '#002B36', brightRed: '#CB4B16', brightGreen: '#586E75', brightYellow: '#657B83',
      brightBlue: '#839496', brightMagenta: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#FDF6E3',
    },
  },
  gruvbox: {
    id: 'gruvbox',
    name: 'Gruvbox Dark',
    type: 'dark',
    colors: {
      bg: { primary: '#282828', secondary: '#32302F', tertiary: '#3C3836', hover: '#504945' },
      text: { primary: '#EBDBB2', secondary: '#A89984', muted: '#7C6F64' },
      accent: { blue: '#83A598', green: '#B8BB26', yellow: '#FABD2F', red: '#FB4934', purple: '#D3869B' },
      border: '#504945',
      inputBg: '#32302F',
    },
    terminal: {
      background: '#282828', foreground: '#EBDBB2', cursor: '#FABD2F',
      black: '#282828', red: '#CC241D', green: '#98971A', yellow: '#D79921',
      blue: '#458588', magenta: '#B16286', cyan: '#689D6A', white: '#A89984',
      brightBlack: '#928374', brightRed: '#FB4934', brightGreen: '#B8BB26', brightYellow: '#FABD2F',
      brightBlue: '#83A598', brightMagenta: '#D3869B', brightCyan: '#8EC07C', brightWhite: '#EBDBB2',
    },
  },

// OpenCode themes (anomalyco/opencode)
  'opencode-aura': {
    id: 'opencode-aura',
    name: 'Aura Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#0f0f0f", secondary: "#15141b", tertiary: "#15141b", hover: "#201f23" },
      text: { primary: "#edecee", secondary: "#6d6d6d", muted: "#4a4a4a" },
      accent: { blue: "#a277ff", green: "#61ffca", yellow: "#ffca85", red: "#ff6767", purple: "#a277ff" },
      border: "#2d2d2d",
      inputBg: "#15141b",
    },
    terminal: {
      background: "#0f0f0f", foreground: "#edecee", cursor: "#a277ff",
      black: "#15141b", red: "#ff6767", green: "#61ffca", yellow: "#ffca85",
      blue: "#a277ff", magenta: "#a277ff", cyan: "#82bbe5", white: "#edecee",
      brightBlack: "#4a4a4a", brightRed: "#fa8f90", brightGreen: "#8bf9d5", brightYellow: "#fad4a5",
      brightBlue: "#b99afa", brightMagenta: "#b99afa", brightCyan: "#82bbe5", brightWhite: "#edecee",
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
  'opencode-carbonfox-dark': {
    id: 'opencode-carbonfox-dark',
    name: 'Carbonfox Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#161616", secondary: "#1a1a1a", tertiary: "#1e1e1e", hover: "#262626" },
      text: { primary: "#f2f4f8", secondary: "#7d848f", muted: "#53565b" },
      accent: { blue: "#ff7eb6", green: "#25be6a", yellow: "#f1c21b", red: "#ee5396", purple: "#78a9ff" },
      border: "#303030",
      inputBg: "#1a1a1a",
    },
    terminal: {
      background: "#161616", foreground: "#f2f4f8", cursor: "#ff7eb6",
      black: "#1a1a1a", red: "#ee5396", green: "#25be6a", yellow: "#f1c21b",
      blue: "#ff7eb6", magenta: "#78a9ff", cyan: "#929e90", white: "#f2f4f8",
      brightBlack: "#53565b", brightRed: "#ef83b3", brightGreen: "#63ce95", brightYellow: "#f1d15d",
      brightBlue: "#fba1ca", brightMagenta: "#9dc0fd", brightCyan: "#929e90", brightWhite: "#f2f4f8",
    },
  },
  'opencode-carbonfox-light': {
    id: 'opencode-carbonfox-light',
    name: 'Carbonfox Light',
    type: 'light',
    colors: {
      bg: { primary: "#ffffff", secondary: "#f4f4f4", tertiary: "#f4f4f4", hover: "#e9e9e9" },
      text: { primary: "#161616", secondary: "#6f6f6f", muted: "#ababab" },
      accent: { blue: "#9f1853", green: "#198038", yellow: "#007d79", red: "#9f1853", purple: "#0043ce" },
      border: "#dcdcdc",
      inputBg: "#f4f4f4",
    },
    terminal: {
      background: "#ffffff", foreground: "#161616", cursor: "#9f1853",
      black: "#f4f4f4", red: "#9f1853", green: "#198038", yellow: "#007d79",
      blue: "#9f1853", magenta: "#0043ce", cyan: "#5c4c46", white: "#161616",
      brightBlack: "#ababab", brightRed: "#761741", brightGreen: "#18602e", brightYellow: "#075e5b",
      brightBlue: "#761741", brightMagenta: "#073697", brightCyan: "#5c4c46", brightWhite: "#161616",
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
  'opencode-cobalt2-dark': {
    id: 'opencode-cobalt2-dark',
    name: 'Cobalt2 Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#193549", secondary: "#122738", tertiary: "#1f4662", hover: "#1f4662" },
      text: { primary: "#ffffff", secondary: "#adb7c9", muted: "#5f7990" },
      accent: { blue: "#2affdf", green: "#9eff80", yellow: "#ffc600", red: "#ff0088", purple: "#ff9d00" },
      border: "#1f4662",
      inputBg: "#122738",
    },
    terminal: {
      background: "#193549", foreground: "#ffffff", cursor: "#2affdf",
      black: "#122738", red: "#ff0088", green: "#9eff80", yellow: "#ffc600",
      blue: "#2affdf", magenta: "#ff9d00", cyan: "#64ffb0", white: "#ffffff",
      brightBlack: "#5f7990", brightRed: "#ff4dac", brightGreen: "#bbffa6", brightYellow: "#ffd74d",
      brightBlue: "#6affe9", brightMagenta: "#ffba4d", brightCyan: "#64ffb0", brightWhite: "#ffffff",
    },
  },
  'opencode-cobalt2-light': {
    id: 'opencode-cobalt2-light',
    name: 'Cobalt2 Light',
    type: 'light',
    colors: {
      bg: { primary: "#ffffff", secondary: "#f5f7fa", tertiary: "#e8ecf1", hover: "#dfe4eb" },
      text: { primary: "#193549", secondary: "#5c6b7d", muted: "#9da8b5" },
      accent: { blue: "#00acc1", green: "#4caf50", yellow: "#ff9800", red: "#e91e63", purple: "#ff5722" },
      border: "#d3dae3",
      inputBg: "#f5f7fa",
    },
    terminal: {
      background: "#ffffff", foreground: "#193549", cursor: "#00acc1",
      black: "#f5f7fa", red: "#e91e63", green: "#4caf50", yellow: "#ff9800",
      blue: "#00acc1", magenta: "#ff5722", cyan: "#26ae89", white: "#193549",
      brightBlack: "#9da8b5", brightRed: "#ab255b", brightGreen: "#3d8a4e", brightYellow: "#ba7a16",
      brightBlue: "#08889d", brightMagenta: "#ba4d2e", brightCyan: "#26ae89", brightWhite: "#193549",
    },
  },
  'opencode-cursor-dark': {
    id: 'opencode-cursor-dark',
    name: 'Cursor Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#181818", secondary: "#141414", tertiary: "#262626", hover: "#7c7c7c" },
      text: { primary: "#e4e4e4", secondary: "#e4e4e45e", muted: "#e4e4e4" },
      accent: { blue: "#88c0d0", green: "#3fa266", yellow: "#f1b467", red: "#e34671", purple: "#81a1c1" },
      border: "#e4e4e413",
      inputBg: "#141414",
    },
    terminal: {
      background: "#181818", foreground: "#e4e4e4", cursor: "#88c0d0",
      black: "#141414", red: "#e34671", green: "#3fa266", yellow: "#f1b467",
      blue: "#88c0d0", magenta: "#81a1c1", cyan: "#64b19b", white: "#e4e4e4",
      brightBlack: "#e4e4e4", brightRed: "#e37594", brightGreen: "#71b68c", brightYellow: "#edc28d",
      brightBlue: "#a4cbd6", brightMagenta: "#9fb5cc", brightCyan: "#64b19b", brightWhite: "#e4e4e4",
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
  'opencode-dracula-light': {
    id: 'opencode-dracula-light',
    name: 'Dracula Light',
    type: 'light',
    colors: {
      bg: { primary: "#f8f8f2", secondary: "#e8e8e2", tertiary: "#d8d8d2", hover: "#d1d1cb" },
      text: { primary: "#282a36", secondary: "#6272a4", muted: "#9aa1b5" },
      accent: { blue: "#8be9fd", green: "#50fa7b", yellow: "#f1fa8c", red: "#ff5555", purple: "#ffb86c" },
      border: "#c8c8c2",
      inputBg: "#e8e8e2",
    },
    terminal: {
      background: "#f8f8f2", foreground: "#282a36", cursor: "#8be9fd",
      black: "#e8e8e2", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      blue: "#8be9fd", magenta: "#ffb86c", cyan: "#6ef2bc", white: "#282a36",
      brightBlack: "#9aa1b5", brightRed: "#bf484c", brightGreen: "#44bc66", brightYellow: "#b5bc72",
      brightBlue: "#6db0c1", brightMagenta: "#bf8d5c", brightCyan: "#6ef2bc", brightWhite: "#282a36",
    },
  },
  'opencode-everforest-dark': {
    id: 'opencode-everforest-dark',
    name: 'Everforest Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#2d353b", secondary: "#333c43", tertiary: "#343f44", hover: "#586463" },
      text: { primary: "#d3c6aa", secondary: "#7a8478", muted: "#808c81" },
      accent: { blue: "#d699b6", green: "#a7c080", yellow: "#e69875", red: "#e67e80", purple: "#83c092" },
      border: "#859289",
      inputBg: "#333c43",
    },
    terminal: {
      background: "#2d353b", foreground: "#d3c6aa", cursor: "#d699b6",
      black: "#333c43", red: "#e67e80", green: "#a7c080", yellow: "#e69875",
      blue: "#d699b6", magenta: "#83c092", cyan: "#bfad9b", white: "#d3c6aa",
      brightBlack: "#808c81", brightRed: "#e0948d", brightGreen: "#b4c28d", brightYellow: "#e0a685",
      brightBlue: "#d5a7b2", brightMagenta: "#9bc299", brightCyan: "#bfad9b", brightWhite: "#d3c6aa",
    },
  },
  'opencode-everforest-light': {
    id: 'opencode-everforest-light',
    name: 'Everforest Light',
    type: 'light',
    colors: {
      bg: { primary: "#fdf6e3", secondary: "#efebd4", tertiary: "#f4f0d9", hover: "#c8ccb9" },
      text: { primary: "#5c6a72", secondary: "#a6b0a0", muted: "#9ca798" },
      accent: { blue: "#df69ba", green: "#8da101", yellow: "#f57d26", red: "#f85552", purple: "#35a77c" },
      border: "#939f91",
      inputBg: "#efebd4",
    },
    terminal: {
      background: "#fdf6e3", foreground: "#5c6a72", cursor: "#df69ba",
      black: "#efebd4", red: "#f85552", green: "#8da101", yellow: "#f57d26",
      blue: "#df69ba", magenta: "#35a77c", cyan: "#b6855e", white: "#5c6a72",
      brightBlack: "#9ca798", brightRed: "#c95b5c", brightGreen: "#7e9123", brightYellow: "#c7773d",
      brightBlue: "#b869a4", brightMagenta: "#419579", brightCyan: "#b6855e", brightWhite: "#5c6a72",
    },
  },
  'opencode-flexoki-dark': {
    id: 'opencode-flexoki-dark',
    name: 'Flexoki Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#100F0F", secondary: "#1C1B1A", tertiary: "#282726", hover: "#3d3c3a" },
      text: { primary: "#CECDC3", secondary: "#6F6E69", muted: "#62615d" },
      accent: { blue: "#8B7EC8", green: "#879A39", yellow: "#DA702C", red: "#D14D41", purple: "#3AA99F" },
      border: "#575653",
      inputBg: "#1C1B1A",
    },
    terminal: {
      background: "#100F0F", foreground: "#CECDC3", cursor: "#8B7EC8",
      black: "#1C1B1A", red: "#D14D41", green: "#879A39", yellow: "#DA702C",
      blue: "#8B7EC8", magenta: "#3AA99F", cyan: "#898c81", white: "#CECDC3",
      brightBlack: "#62615d", brightRed: "#d07368", brightGreen: "#9ca962", brightYellow: "#d68c59",
      brightBlue: "#9f96c7", brightMagenta: "#66b4aa", brightCyan: "#898c81", brightWhite: "#CECDC3",
    },
  },
  'opencode-flexoki-light': {
    id: 'opencode-flexoki-light',
    name: 'Flexoki Light',
    type: 'light',
    colors: {
      bg: { primary: "#FFFCF0", secondary: "#F2F0E5", tertiary: "#E6E4D9", hover: "#d1cfc5" },
      text: { primary: "#100F0F", secondary: "#6F6E69", muted: "#97958e" },
      accent: { blue: "#BC5215", green: "#66800B", yellow: "#BC5215", red: "#AF3029", purple: "#24837B" },
      border: "#B7B5AC",
      inputBg: "#F2F0E5",
    },
    terminal: {
      background: "#FFFCF0", foreground: "#100F0F", cursor: "#BC5215",
      black: "#F2F0E5", red: "#AF3029", green: "#66800B", yellow: "#BC5215",
      blue: "#BC5215", magenta: "#24837B", cyan: "#916910", white: "#100F0F",
      brightBlack: "#97958e", brightRed: "#7f2621", brightGreen: "#4c5e0c", brightYellow: "#883e13",
      brightBlue: "#883e13", brightMagenta: "#1e605b", brightCyan: "#916910", brightWhite: "#100F0F",
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
  'opencode-gruvbox-dark': {
    id: 'opencode-gruvbox-dark',
    name: 'Gruvbox Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#282828", secondary: "#3c3836", tertiary: "#504945", hover: "#5a524c" },
      text: { primary: "#ebdbb2", secondary: "#928374", muted: "#7a6e62" },
      accent: { blue: "#8ec07c", green: "#b8bb26", yellow: "#fe8019", red: "#fb4934", purple: "#fabd2f" },
      border: "#665c54",
      inputBg: "#3c3836",
    },
    terminal: {
      background: "#282828", foreground: "#ebdbb2", cursor: "#8ec07c",
      black: "#3c3836", red: "#fb4934", green: "#b8bb26", yellow: "#fe8019",
      blue: "#8ec07c", magenta: "#fabd2f", cyan: "#a3be51", white: "#ebdbb2",
      brightBlack: "#7a6e62", brightRed: "#f6755a", brightGreen: "#c7c550", brightYellow: "#f89b47",
      brightBlue: "#aac88c", brightMagenta: "#f6c656", brightCyan: "#a3be51", brightWhite: "#ebdbb2",
    },
  },
  'opencode-gruvbox-light': {
    id: 'opencode-gruvbox-light',
    name: 'Gruvbox Light',
    type: 'light',
    colors: {
      bg: { primary: "#fbf1c7", secondary: "#ebdbb2", tertiary: "#d5c4a1", hover: "#caba9b" },
      text: { primary: "#3c3836", secondary: "#7c6f64", muted: "#a0927e" },
      accent: { blue: "#427b58", green: "#79740e", yellow: "#af3a03", red: "#9d0006", purple: "#b57614" },
      border: "#bdae93",
      inputBg: "#ebdbb2",
    },
    terminal: {
      background: "#fbf1c7", foreground: "#3c3836", cursor: "#427b58",
      black: "#ebdbb2", red: "#9d0006", green: "#79740e", yellow: "#af3a03",
      blue: "#427b58", magenta: "#b57614", cyan: "#5e7833", white: "#3c3836",
      brightBlack: "#a0927e", brightRed: "#801114", brightGreen: "#67621a", brightYellow: "#8d3912",
      brightBlue: "#40674e", brightMagenta: "#91631e", brightCyan: "#5e7833", brightWhite: "#3c3836",
    },
  },
  'opencode-kanagawa-dark': {
    id: 'opencode-kanagawa-dark',
    name: 'Kanagawa Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#1F1F28", secondary: "#2A2A37", tertiary: "#363646", hover: "#444458" },
      text: { primary: "#DCD7BA", secondary: "#727169", muted: "#62616b" },
      accent: { blue: "#D27E99", green: "#98BB6C", yellow: "#D7A657", red: "#E82424", purple: "#76946A" },
      border: "#54546D",
      inputBg: "#2A2A37",
    },
    terminal: {
      background: "#1F1F28", foreground: "#DCD7BA", cursor: "#D27E99",
      black: "#2A2A37", red: "#E82424", green: "#98BB6C", yellow: "#D7A657",
      blue: "#D27E99", magenta: "#76946A", cyan: "#b59d83", white: "#DCD7BA",
      brightBlack: "#62616b", brightRed: "#e45a51", brightGreen: "#acc383", brightYellow: "#d9b575",
      brightBlue: "#d599a3", brightMagenta: "#95a882", brightCyan: "#b59d83", brightWhite: "#DCD7BA",
    },
  },
  'opencode-kanagawa-light': {
    id: 'opencode-kanagawa-light',
    name: 'Kanagawa Light',
    type: 'light',
    colors: {
      bg: { primary: "#F2E9DE", secondary: "#EAE4D7", tertiary: "#E3DCD2", hover: "#dcd4c9" },
      text: { primary: "#54433A", secondary: "#9E9389", muted: "#bcb2a7" },
      accent: { blue: "#D27E99", green: "#98BB6C", yellow: "#D7A657", red: "#E82424", purple: "#76946A" },
      border: "#D4CBBF",
      inputBg: "#EAE4D7",
    },
    terminal: {
      background: "#F2E9DE", foreground: "#54433A", cursor: "#D27E99",
      black: "#EAE4D7", red: "#E82424", green: "#98BB6C", yellow: "#D7A657",
      blue: "#D27E99", magenta: "#76946A", cyan: "#b59d83", white: "#54433A",
      brightBlack: "#bcb2a7", brightRed: "#bc2d2b", brightGreen: "#84975d", brightYellow: "#b0884e",
      brightBlue: "#ac6c7d", brightMagenta: "#6c7c5c", brightCyan: "#b59d83", brightWhite: "#54433A",
    },
  },
  'opencode-material-dark': {
    id: 'opencode-material-dark',
    name: 'Material Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#263238", secondary: "#1e272c", tertiary: "#37474f", hover: "#37474f" },
      text: { primary: "#eeffff", secondary: "#546e7a", muted: "#445962" },
      accent: { blue: "#89ddff", green: "#c3e88d", yellow: "#ffcb6b", red: "#f07178", purple: "#ffcb6b" },
      border: "#37474f",
      inputBg: "#1e272c",
    },
    terminal: {
      background: "#263238", foreground: "#eeffff", cursor: "#89ddff",
      black: "#1e272c", red: "#f07178", green: "#c3e88d", yellow: "#ffcb6b",
      blue: "#89ddff", magenta: "#ffcb6b", cyan: "#a6e3c6", white: "#eeffff",
      brightBlack: "#445962", brightRed: "#ef9ca1", brightGreen: "#d0efaf", brightYellow: "#fadb97",
      brightBlue: "#a7e7ff", brightMagenta: "#fadb97", brightCyan: "#a6e3c6", brightWhite: "#eeffff",
    },
  },
  'opencode-matrix-dark': {
    id: 'opencode-matrix-dark',
    name: 'Matrix Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#0a0e0a", secondary: "#0e130d", tertiary: "#141c12", hover: "#192216" },
      text: { primary: "#62ff94", secondary: "#8ca391", muted: "#506050" },
      accent: { blue: "#c770ff", green: "#62ff94", yellow: "#e6ff57", red: "#ff4b4b", purple: "#30b3ff" },
      border: "#1e2a1b",
      inputBg: "#0e130d",
    },
    terminal: {
      background: "#0a0e0a", foreground: "#62ff94", cursor: "#c770ff",
      black: "#0e130d", red: "#ff4b4b", green: "#62ff94", yellow: "#e6ff57",
      blue: "#c770ff", magenta: "#30b3ff", cyan: "#95b8ca", white: "#62ff94",
      brightBlack: "#506050", brightRed: "#d08161", brightGreen: "#62ff94", brightYellow: "#beff69",
      brightBlue: "#a99bdf", brightMagenta: "#3fcadf", brightCyan: "#95b8ca", brightWhite: "#62ff94",
    },
  },
  'opencode-matrix-light': {
    id: 'opencode-matrix-light',
    name: 'Matrix Light',
    type: 'light',
    colors: {
      bg: { primary: "#eef3ea", secondary: "#e4ebe1", tertiary: "#dae1d7", hover: "#acb7ab" },
      text: { primary: "#203022", secondary: "#748476", muted: "#748476" },
      accent: { blue: "#c770ff", green: "#1cc24b", yellow: "#e6ff57", red: "#ff4b4b", purple: "#30b3ff" },
      border: "#748476",
      inputBg: "#e4ebe1",
    },
    terminal: {
      background: "#eef3ea", foreground: "#203022", cursor: "#c770ff",
      black: "#e4ebe1", red: "#ff4b4b", green: "#1cc24b", yellow: "#e6ff57",
      blue: "#c770ff", magenta: "#30b3ff", cyan: "#7299a5", white: "#203022",
      brightBlack: "#748476", brightRed: "#bc433f", brightGreen: "#1d963f", brightYellow: "#abc147",
      brightBlue: "#955dbd", brightMagenta: "#2b8cbd", brightCyan: "#7299a5", brightWhite: "#203022",
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
  'opencode-monokai-dark': {
    id: 'opencode-monokai-dark',
    name: 'Monokai Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#272822", secondary: "#1e1f1c", tertiary: "#3e3d32", hover: "#3e3d32" },
      text: { primary: "#f8f8f2", secondary: "#75715e", muted: "#575446" },
      accent: { blue: "#a6e22e", green: "#a6e22e", yellow: "#e6db74", red: "#f92672", purple: "#fd971f" },
      border: "#3e3d32",
      inputBg: "#1e1f1c",
    },
    terminal: {
      background: "#272822", foreground: "#f8f8f2", cursor: "#a6e22e",
      black: "#1e1f1c", red: "#f92672", green: "#a6e22e", yellow: "#e6db74",
      blue: "#a6e22e", magenta: "#fd971f", cyan: "#a6e22e", white: "#f8f8f2",
      brightBlack: "#575446", brightRed: "#f96598", brightGreen: "#bfe969", brightYellow: "#ebe49a",
      brightBlue: "#bfe969", brightMagenta: "#fcb45e", brightCyan: "#a6e22e", brightWhite: "#f8f8f2",
    },
  },
  'opencode-monokai-light': {
    id: 'opencode-monokai-light',
    name: 'Monokai Light',
    type: 'light',
    colors: {
      bg: { primary: "#fafafa", secondary: "#f0f0f0", tertiary: "#e0e0e0", hover: "#d9d9d9" },
      text: { primary: "#272822", secondary: "#75715e", muted: "#a7a59d" },
      accent: { blue: "#a6e22e", green: "#a6e22e", yellow: "#fd971f", red: "#f92672", purple: "#fd971f" },
      border: "#d0d0d0",
      inputBg: "#f0f0f0",
    },
    terminal: {
      background: "#fafafa", foreground: "#272822", cursor: "#a6e22e",
      black: "#f0f0f0", red: "#f92672", green: "#a6e22e", yellow: "#fd971f",
      blue: "#a6e22e", magenta: "#fd971f", cyan: "#a6e22e", white: "#272822",
      brightBlack: "#a7a59d", brightRed: "#ba275a", brightGreen: "#80aa2a", brightYellow: "#bd7620",
      brightBlue: "#80aa2a", brightMagenta: "#bd7620", brightCyan: "#a6e22e", brightWhite: "#272822",
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
  'opencode-one-dark-light': {
    id: 'opencode-one-dark-light',
    name: 'One Dark Light',
    type: 'light',
    colors: {
      bg: { primary: "#fafafa", secondary: "#f0f0f1", tertiary: "#eaeaeb", hover: "#dfdfe0" },
      text: { primary: "#383a42", secondary: "#a0a1a7", muted: "#bbbbbf" },
      accent: { blue: "#0184bc", green: "#50a14f", yellow: "#c18401", red: "#e45649", purple: "#986801" },
      border: "#d1d1d2",
      inputBg: "#f0f0f1",
    },
    terminal: {
      background: "#fafafa", foreground: "#383a42", cursor: "#0184bc",
      black: "#f0f0f1", red: "#e45649", green: "#50a14f", yellow: "#c18401",
      blue: "#0184bc", magenta: "#986801", cyan: "#299386", white: "#383a42",
      brightBlack: "#bbbbbf", brightRed: "#b04e47", brightGreen: "#49824b", brightYellow: "#986e15",
      brightBlue: "#126e97", brightMagenta: "#7b5a15", brightCyan: "#299386", brightWhite: "#383a42",
    },
  },
  'opencode-opencode-dark': {
    id: 'opencode-opencode-dark',
    name: 'OpenCode Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#0a0a0a", secondary: "#141414", tertiary: "#1e1e1e", hover: "#313131" },
      text: { primary: "#eeeeee", secondary: "#808080", muted: "#616161" },
      accent: { blue: "#9d7cd8", green: "#7fd88f", yellow: "#f5a742", red: "#e06c75", purple: "#56b6c2" },
      border: "#484848",
      inputBg: "#141414",
    },
    terminal: {
      background: "#0a0a0a", foreground: "#eeeeee", cursor: "#9d7cd8",
      black: "#141414", red: "#e06c75", green: "#7fd88f", yellow: "#f5a742",
      blue: "#9d7cd8", magenta: "#56b6c2", cyan: "#8eaab4", white: "#eeeeee",
      brightBlack: "#616161", brightRed: "#e49399", brightGreen: "#a0dfac", brightYellow: "#f3bc76",
      brightBlue: "#b59edf", brightMagenta: "#84c7cf", brightCyan: "#8eaab4", brightWhite: "#eeeeee",
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
  'opencode-orng-dark': {
    id: 'opencode-orng-dark',
    name: 'ORNG Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#0a0a0a", secondary: "#141414", tertiary: "#1e1e1e", hover: "#7b3924" },
      text: { primary: "#eeeeee", secondary: "#808080", muted: "#bb6c51" },
      accent: { blue: "#FFF7F1", green: "#6ba1e6", yellow: "#EC5B2B", red: "#e06c75", purple: "#56b6c2" },
      border: "#EC5B2B",
      inputBg: "#141414",
    },
    terminal: {
      background: "#0a0a0a", foreground: "#eeeeee", cursor: "#FFF7F1",
      black: "#141414", red: "#e06c75", green: "#6ba1e6", yellow: "#EC5B2B",
      blue: "#FFF7F1", magenta: "#56b6c2", cyan: "#b5ccec", white: "#eeeeee",
      brightBlack: "#bb6c51", brightRed: "#e49399", brightGreen: "#92b8e8", brightYellow: "#ed8766",
      brightBlue: "#faf4f0", brightMagenta: "#84c7cf", brightCyan: "#b5ccec", brightWhite: "#eeeeee",
    },
  },
  'opencode-orng-light': {
    id: 'opencode-orng-light',
    name: 'ORNG Light',
    type: 'light',
    colors: {
      bg: { primary: "#ffffff", secondary: "#FFF7F1", tertiary: "#f5f0eb", hover: "#f1ad95" },
      text: { primary: "#1a1a1a", secondary: "#8a8a8a", muted: "#c07056" },
      accent: { blue: "#c94d24", green: "#0062d1", yellow: "#EC5B2B", red: "#d1383d", purple: "#318795" },
      border: "#EC5B2B",
      inputBg: "#FFF7F1",
    },
    terminal: {
      background: "#ffffff", foreground: "#1a1a1a", cursor: "#c94d24",
      black: "#FFF7F1", red: "#d1383d", green: "#0062d1", yellow: "#EC5B2B",
      blue: "#c94d24", magenta: "#318795", cyan: "#65587b", white: "#1a1a1a",
      brightBlack: "#c07056", brightRed: "#9a2f33", brightGreen: "#084c9a", brightYellow: "#ad4826",
      brightBlue: "#953e21", brightMagenta: "#2a6670", brightCyan: "#65587b", brightWhite: "#1a1a1a",
    },
  },
  'opencode-osaka-jade-dark': {
    id: 'opencode-osaka-jade-dark',
    name: 'Osaka Jade Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#111c18", secondary: "#1a2520", tertiary: "#23372B", hover: "#2f4036" },
      text: { primary: "#C1C497", secondary: "#53685B", muted: "#47584e" },
      accent: { blue: "#549e6a", green: "#549e6a", yellow: "#E5C736", red: "#FF5345", purple: "#2DD5B7" },
      border: "#3d4a44",
      inputBg: "#1a2520",
    },
    terminal: {
      background: "#111c18", foreground: "#C1C497", cursor: "#549e6a",
      black: "#1a2520", red: "#FF5345", green: "#549e6a", yellow: "#E5C736",
      blue: "#549e6a", magenta: "#2DD5B7", cyan: "#549e6a", white: "#C1C497",
      brightBlack: "#47584e", brightRed: "#ec755e", brightGreen: "#75a978", brightYellow: "#dac653",
      brightBlue: "#75a978", brightMagenta: "#59d0ad", brightCyan: "#549e6a", brightWhite: "#C1C497",
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
  'opencode-solarized-dark': {
    id: 'opencode-solarized-dark',
    name: 'Solarized Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#002b36", secondary: "#073642", tertiary: "#073642", hover: "#073642" },
      text: { primary: "#839496", secondary: "#586e75", muted: "#2b4f59" },
      accent: { blue: "#2aa198", green: "#859900", yellow: "#b58900", red: "#dc322f", purple: "#cb4b16" },
      border: "#073642",
      inputBg: "#073642",
    },
    terminal: {
      background: "#002b36", foreground: "#839496", cursor: "#2aa198",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#2aa198", magenta: "#cb4b16", cyan: "#589d4c", white: "#839496",
      brightBlack: "#2b4f59", brightRed: "#c14f4e", brightGreen: "#84982d", brightYellow: "#a68c2d",
      brightBlue: "#459d97", brightMagenta: "#b5613c", brightCyan: "#589d4c", brightWhite: "#839496",
    },
  },
  'opencode-solarized-light': {
    id: 'opencode-solarized-light',
    name: 'Solarized Light',
    type: 'light',
    colors: {
      bg: { primary: "#fdf6e3", secondary: "#eee8d5", tertiary: "#eee8d5", hover: "#eee8d5" },
      text: { primary: "#657b83", secondary: "#93a1a1", muted: "#c5c8be" },
      accent: { blue: "#2aa198", green: "#859900", yellow: "#b58900", red: "#dc322f", purple: "#cb4b16" },
      border: "#eee8d5",
      inputBg: "#eee8d5",
    },
    terminal: {
      background: "#fdf6e3", foreground: "#657b83", cursor: "#2aa198",
      black: "#eee8d5", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#2aa198", magenta: "#cb4b16", cyan: "#589d4c", white: "#657b83",
      brightBlack: "#c5c8be", brightRed: "#b84848", brightGreen: "#7b9027", brightYellow: "#9d8527",
      brightBlue: "#3c9692", brightMagenta: "#ac5937", brightCyan: "#589d4c", brightWhite: "#657b83",
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
  'opencode-tokyonight-light': {
    id: 'opencode-tokyonight-light',
    name: 'Tokyo Night Light',
    type: 'light',
    colors: {
      bg: { primary: "#e1e2e7", secondary: "#d5d6db", tertiary: "#c8c9ce", hover: "#a2a5b0" },
      text: { primary: "#3760bf", secondary: "#8990a3", muted: "#7d8496" },
      accent: { blue: "#b15c00", green: "#587539", yellow: "#b15c00", red: "#f52a65", purple: "#2e7de9" },
      border: "#737a8c",
      inputBg: "#d5d6db",
    },
    terminal: {
      background: "#e1e2e7", foreground: "#3760bf", cursor: "#b15c00",
      black: "#d5d6db", red: "#f52a65", green: "#587539", yellow: "#b15c00",
      blue: "#b15c00", magenta: "#2e7de9", cyan: "#85691d", white: "#3760bf",
      brightBlack: "#7d8496", brightRed: "#bc3a80", brightGreen: "#4e6f61", brightYellow: "#8c5d39",
      brightBlue: "#8c5d39", brightMagenta: "#3174dc", brightCyan: "#85691d", brightWhite: "#3760bf",
    },
  },
  'opencode-vercel-dark': {
    id: 'opencode-vercel-dark',
    name: 'Vercel Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#000000", secondary: "#1A1A1A", tertiary: "#292929", hover: "#252525" },
      text: { primary: "#EDEDED", secondary: "#878787", muted: "#4e4e4e" },
      accent: { blue: "#8E4EC6", green: "#46A758", yellow: "#FFB224", red: "#E5484D", purple: "#52A8FF" },
      border: "#1F1F1F",
      inputBg: "#1A1A1A",
    },
    terminal: {
      background: "#000000", foreground: "#EDEDED", cursor: "#8E4EC6",
      black: "#1A1A1A", red: "#E5484D", green: "#46A758", yellow: "#FFB224",
      blue: "#8E4EC6", magenta: "#52A8FF", cyan: "#6a7b8f", white: "#EDEDED",
      brightBlack: "#4e4e4e", brightRed: "#e77a7d", brightGreen: "#78bc85", brightYellow: "#fac460",
      brightBlue: "#ab7ed2", brightMagenta: "#81bdfa", brightCyan: "#6a7b8f", brightWhite: "#EDEDED",
    },
  },
  'opencode-vercel-light': {
    id: 'opencode-vercel-light',
    name: 'Vercel Light',
    type: 'light',
    colors: {
      bg: { primary: "#FFFFFF", secondary: "#FAFAFA", tertiary: "#EAEAEA", hover: "#eaeaea" },
      text: { primary: "#171717", secondary: "#666666", muted: "#afafaf" },
      accent: { blue: "#8E4EC6", green: "#388E3C", yellow: "#FF9500", red: "#DC3545", purple: "#0070F3" },
      border: "#EAEAEA",
      inputBg: "#FAFAFA",
    },
    terminal: {
      background: "#FFFFFF", foreground: "#171717", cursor: "#8E4EC6",
      black: "#FAFAFA", red: "#DC3545", green: "#388E3C", yellow: "#FF9500",
      blue: "#8E4EC6", magenta: "#0070F3", cyan: "#636e81", white: "#171717",
      brightBlack: "#afafaf", brightRed: "#a12c37", brightGreen: "#2e6a31", brightYellow: "#b96f07",
      brightBlue: "#6a3e92", brightMagenta: "#0755b1", brightCyan: "#636e81", brightWhite: "#171717",
    },
  },
  'opencode-vesper-dark': {
    id: 'opencode-vesper-dark',
    name: 'Vesper Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#101010", secondary: "#101010", tertiary: "#101010", hover: "#1b1b1b" },
      text: { primary: "#FFF", secondary: "#A0A0A0", muted: "#5e5e5e" },
      accent: { blue: "#FFC799", green: "#99FFE4", yellow: "#FFC799", red: "#FF8080", purple: "#FFC799" },
      border: "#282828",
      inputBg: "#101010",
    },
    terminal: {
      background: "#101010", foreground: "#FFF", cursor: "#FFC799",
      black: "#101010", red: "#FF8080", green: "#99FFE4", yellow: "#FFC799",
      blue: "#FFC799", magenta: "#FFC799", cyan: "#cce3bf", white: "#FFF",
      brightBlack: "#5e5e5e", brightRed: "#ffa6a6", brightGreen: "#b8ffec", brightYellow: "#ffd8b8",
      brightBlue: "#ffd8b8", brightMagenta: "#ffd8b8", brightCyan: "#cce3bf", brightWhite: "#FFF",
    },
  },
  'opencode-vesper-light': {
    id: 'opencode-vesper-light',
    name: 'Vesper Light',
    type: 'light',
    colors: {
      bg: { primary: "#FFF", secondary: "#F0F0F0", tertiary: "#E0E0E0", hover: "#d9d9d9" },
      text: { primary: "#101010", secondary: "#A0A0A0", muted: "#bababa" },
      accent: { blue: "#FFC799", green: "#99FFE4", yellow: "#FFC799", red: "#FF8080", purple: "#FFC799" },
      border: "#D0D0D0",
      inputBg: "#F0F0F0",
    },
    terminal: {
      background: "#FFF", foreground: "#101010", cursor: "#FFC799",
      black: "#F0F0F0", red: "#FF8080", green: "#99FFE4", yellow: "#FFC799",
      blue: "#FFC799", magenta: "#FFC799", cyan: "#cce3bf", white: "#101010",
      brightBlack: "#bababa", brightRed: "#b75e5e", brightGreen: "#70b7a4", brightYellow: "#b79070",
      brightBlue: "#b79070", brightMagenta: "#b79070", brightCyan: "#cce3bf", brightWhite: "#101010",
    },
  },
  'opencode-zenburn-dark': {
    id: 'opencode-zenburn-dark',
    name: 'Zenburn Dark',
    type: 'dark',
    colors: {
      bg: { primary: "#3f3f3f", secondary: "#4f4f4f", tertiary: "#5f5f5f", hover: "#5f5f5f" },
      text: { primary: "#dcdccc", secondary: "#9f9f9f", muted: "#7c7c7c" },
      accent: { blue: "#93e0e3", green: "#7f9f7f", yellow: "#f0dfaf", red: "#cc9393", purple: "#dfaf8f" },
      border: "#5f5f5f",
      inputBg: "#4f4f4f",
    },
    terminal: {
      background: "#3f3f3f", foreground: "#dcdccc", cursor: "#93e0e3",
      black: "#4f4f4f", red: "#cc9393", green: "#7f9f7f", yellow: "#f0dfaf",
      blue: "#93e0e3", magenta: "#dfaf8f", cyan: "#89c0b1", white: "#dcdccc",
      brightBlack: "#7c7c7c", brightRed: "#d1a9a4", brightGreen: "#9bb196", brightYellow: "#eadeb8",
      brightBlue: "#a9dfdc", brightMagenta: "#debda1", brightCyan: "#89c0b1", brightWhite: "#dcdccc",
    },
  },
  'opencode-zenburn-light': {
    id: 'opencode-zenburn-light',
    name: 'Zenburn Light',
    type: 'light',
    colors: {
      bg: { primary: "#ffffef", secondary: "#f5f5e5", tertiary: "#ebebdb", hover: "#dfdfcf" },
      text: { primary: "#3f3f3f", secondary: "#6f6f6f", muted: "#a4a49c" },
      accent: { blue: "#5f8f8f", green: "#5f8f5f", yellow: "#8f8f5f", red: "#8f5f5f", purple: "#8f7f5f" },
      border: "#d0d0c0",
      inputBg: "#f5f5e5",
    },
    terminal: {
      background: "#ffffef", foreground: "#3f3f3f", cursor: "#5f8f8f",
      black: "#f5f5e5", red: "#8f5f5f", green: "#5f8f5f", yellow: "#8f8f5f",
      blue: "#5f8f8f", magenta: "#8f7f5f", cyan: "#5f8f77", white: "#3f3f3f",
      brightBlack: "#a4a49c", brightRed: "#775555", brightGreen: "#557755", brightYellow: "#777755",
      brightBlue: "#557777", brightMagenta: "#776c55", brightCyan: "#5f8f77", brightWhite: "#3f3f3f",
    },
  },
}

export const THEME_IDS = Object.keys(THEMES)
export const DEFAULT_THEME_ID = 'dark'
export const defaultTheme = THEMES[DEFAULT_THEME_ID]

export function getTheme(themeId?: string | null): ThemeTokens {
  if (!themeId) return THEMES[DEFAULT_THEME_ID]
  return THEMES[themeId] ?? THEMES[DEFAULT_THEME_ID]
}

export function themeToCssVariables(theme: ThemeTokens): Record<string, string> {
  return {
    '--color-bg-primary': theme.colors.bg.primary,
    '--color-bg-secondary': theme.colors.bg.secondary,
    '--color-bg-tertiary': theme.colors.bg.tertiary,
    '--color-bg-hover': theme.colors.bg.hover,
    '--color-text-primary': theme.colors.text.primary,
    '--color-text-secondary': theme.colors.text.secondary,
    '--color-text-muted': theme.colors.text.muted,
    '--color-accent-blue': theme.colors.accent.blue,
    '--color-accent-green': theme.colors.accent.green,
    '--color-accent-yellow': theme.colors.accent.yellow,
    '--color-accent-red': theme.colors.accent.red,
    '--color-accent-purple': theme.colors.accent.purple,
    '--color-border': theme.colors.border,
    '--color-input-bg': theme.colors.inputBg,
  }
}

export function buildSurfaceVars(themeId?: string | null): Record<string, string> {
  const theme = getTheme(themeId)
  const shadowBase = theme.type === 'dark' ? '#000000' : theme.colors.text.primary
  const shadowRgb = toRgbTriplet(shadowBase)

  return {
    '--surface-app-backdrop': theme.colors.bg.primary,
    '--surface-panel': theme.colors.bg.primary,
    '--surface-panel-strong': theme.colors.bg.secondary,
    '--surface-panel-soft': theme.colors.bg.secondary,
    '--surface-overlay': theme.colors.bg.primary,
    '--surface-dialog': theme.colors.bg.primary,
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

export function buildTerminalTheme(themeId?: string | null): ThemeTokens['terminal'] {
  return getTheme(themeId).terminal
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
  const editorBackground = stripHash(theme.colors.bg.primary)
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
      'editor.background': theme.colors.bg.primary,
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
      'editorGutter.background': theme.colors.bg.primary,
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
