/**
 * 外观主题：皮肤预设（调色板纯数据定义）。
 * 本文件仅作为底层基础色板（Palette）的静态预设数据源，严禁包含任何硬编码覆盖语义 token 的运行时逻辑。
 * 所有语义 token（如 surface、background、text、border、control-soft 等）严格由 CSS 规范与
 * TokenRuntimeController 统一规范化派生，确保单真源与设计系统解耦。
 */

/** 单个皮肤预设的色板结构 */
export interface SkinPreset {
  name: string;
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgCard: string;
  bgElevated: string;
  shellChromeBg: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary?: string;
  textFaint?: string;
  borderColor: string;
  borderSubtle: string;
  mixColor?: string;
  composerBg?: string;
}

export const SKIN_PRESETS: Record<string, SkinPreset> = {
  'warm-gray': {
    name: '护眼暖灰',
    // 浅色模式：外层 K5 #f2f1f0 → 主界面纯白 #ffffff → 输入框纯白 #ffffff
    //（运行时 TokenRuntimeController 的 warm-gray 分支按同一组数值计算）
    bgPrimary: '#ffffff',
    bgSecondary: '#f2f1f0',
    bgTertiary: 'hsl(30 8.33% 92.29%)',
    bgCard: '#ffffff',
    bgElevated: '#ffffff',
    shellChromeBg: '#f2f1f0',
    textPrimary: '#1a1a1a',
    textSecondary: '#383838',
    textTertiary: '#666666',
    textFaint: '#969696',
    // 与 tokens.css 浅色线色同值（M0.4/Y0.8，review P2-1）
    borderColor: '#e2e1e0',
    borderSubtle: '#f0efee',
    mixColor: 'hsl(35 40% 30%)',
  },
  cream: {
    name: '杏仁奶油',
    bgPrimary: 'color-mix(in srgb, var(--accent-orange) 4%, #ffffff)',
    bgSecondary: 'color-mix(in srgb, var(--accent-orange) 6%, #ffffff)',
    bgTertiary: 'color-mix(in srgb, var(--accent-orange) 8%, #ffffff)',
    bgCard: 'color-mix(in srgb, var(--accent-orange) 3%, #ffffff)',
    bgElevated: 'color-mix(in srgb, var(--accent-orange) 4%, #ffffff)',
    shellChromeBg: 'color-mix(in srgb, var(--accent-orange) 9%, #ffffff)',
    textPrimary: '#2a2415',
    textSecondary: '#4a3f28',
    borderColor: 'color-mix(in srgb, var(--accent-orange) 8%, #e5dfcf)',
    borderSubtle: 'color-mix(in srgb, var(--accent-orange) 4%, #efeada)',
    mixColor: 'hsl(30, 45%, 32%)',
    composerBg: 'color-mix(in srgb, var(--accent-orange) 3%, #ffffff)',
  },
  paper: {
    // review P2-7（2026-10-11）：三层方向统一为「外层最暗 → 主层 → 输入框最亮」（原外层比主层亮）
    name: '极简纸质',
    bgPrimary: '#fafafa',
    bgSecondary: '#f5f5f5',
    bgTertiary: '#ebebeb',
    bgCard: '#fafafa',
    bgElevated: '#fafafa',
    shellChromeBg: 'color-mix(in srgb, #fafafa 82%, #d0d0d0 18%)',
    textPrimary: '#1a1a1a',
    textSecondary: '#383838',
    textTertiary: '#666666',
    textFaint: '#969696',
    borderColor: '#e0e0e0',
    borderSubtle: '#eeeeee',
    mixColor: 'hsl(0, 0%, 25%)',
  },
  'classic-gray': {
    // review P2-7（2026-10-11）：三层方向统一为「外层最暗 → 主层 → 输入框最亮」（原外层比主层亮）
    name: '经典浅灰',
    bgPrimary: '#f8f9fa',
    bgSecondary: '#f1f3f5',
    bgTertiary: '#e9ecef',
    bgCard: '#f8f9fa',
    bgElevated: '#f8f9fa',
    shellChromeBg: 'color-mix(in srgb, #f8f9fa 82%, #ced4da 18%)',
    textPrimary: '#212529',
    textSecondary: '#373d43',
    textTertiary: '#666d75',
    textFaint: '#949aa0',
    borderColor: '#dee2e6',
    borderSubtle: '#e9ecef',
    mixColor: 'hsl(210, 10%, 30%)',
  },
  sakura: {
    name: '落樱微风',
    bgPrimary:
      'color-mix(in srgb, var(--accent-orange) 1%, color-mix(in srgb, #9d4edd 2%, #ffffff))',
    bgSecondary:
      'color-mix(in srgb, var(--accent-orange) 1.5%, color-mix(in srgb, #9d4edd 4%, #ffffff))',
    bgTertiary:
      'color-mix(in srgb, var(--accent-orange) 2%, color-mix(in srgb, #9d4edd 6%, #ffffff))',
    bgCard: 'color-mix(in srgb, #9d4edd 1.5%, #ffffff)',
    bgElevated: 'color-mix(in srgb, #9d4edd 2.5%, #ffffff)',
    shellChromeBg: 'color-mix(in srgb, #9d4edd 7%, #ffffff)',
    textPrimary: '#3c1642',
    textSecondary: '#592b63',
    borderColor: 'color-mix(in srgb, #9d4edd 7%, #e8e0ec)',
    borderSubtle: 'color-mix(in srgb, #9d4edd 3%, #f4eff8)',
    mixColor: 'hsl(285, 30%, 35%)',
    composerBg: 'color-mix(in srgb, #9d4edd 1%, #ffffff)',
  },
  matcha: {
    name: '抹茶拿铁',
    bgPrimary:
      'color-mix(in srgb, var(--accent-orange) 1.5%, color-mix(in srgb, #2ec4b6 2%, #ffffff))',
    bgSecondary:
      'color-mix(in srgb, var(--accent-orange) 2%, color-mix(in srgb, #2ec4b6 4%, #ffffff))',
    bgTertiary:
      'color-mix(in srgb, var(--accent-orange) 2.5%, color-mix(in srgb, #2ec4b6 6.5%, #ffffff))',
    bgCard: 'color-mix(in srgb, #2ec4b6 1.5%, #ffffff)',
    bgElevated: 'color-mix(in srgb, #2ec4b6 2.5%, #ffffff)',
    shellChromeBg: 'color-mix(in srgb, #2ec4b6 7%, #ffffff)',
    textPrimary: '#1b3022',
    textSecondary: '#314f3b',
    borderColor: 'color-mix(in srgb, #2ec4b6 7%, #dfede2)',
    borderSubtle: 'color-mix(in srgb, var(--accent-orange) 3%, #eff6f1)',
    mixColor: 'hsl(120, 20%, 30%)',
    composerBg: 'color-mix(in srgb, #2ec4b6 1%, #ffffff)',
  },
  glacier: {
    name: '冰川薄荷',
    bgPrimary: 'color-mix(in srgb, #e9fcf9 40%, #ffffff)',
    bgSecondary: '#e9fcf9',
    bgTertiary: 'color-mix(in srgb, #e9fcf9 75%, #d4ede8)',
    bgCard: 'color-mix(in srgb, #e9fcf9 20%, #ffffff)',
    bgElevated: 'color-mix(in srgb, #e9fcf9 35%, #ffffff)',
    shellChromeBg: 'color-mix(in srgb, #e9fcf9 85%, #f4faf9)',
    textPrimary: '#112e2b',
    textSecondary: '#244a46',
    borderColor: 'color-mix(in srgb, #e9fcf9 35%, #d0e5e2)',
    borderSubtle: 'color-mix(in srgb, #e9fcf9 55%, #e6f3f1)',
    mixColor: 'hsl(172, 25%, 32%)',
    composerBg: 'color-mix(in srgb, #e9fcf9 15%, #ffffff)',
  },
  pearl: {
    name: '金沙流光',
    bgPrimary:
      'color-mix(in srgb, var(--accent-orange) 2%, color-mix(in srgb, #ffe5ec 1%, #faf6f0))',
    bgSecondary:
      'color-mix(in srgb, var(--accent-orange) 3.5%, color-mix(in srgb, #ffe5ec 1.5%, #f4eee2))',
    bgTertiary:
      'color-mix(in srgb, var(--accent-orange) 5%, color-mix(in srgb, #ffe5ec 2%, #ebe2d3))',
    bgCard: 'color-mix(in srgb, var(--accent-orange) 2%, #ffffff)',
    bgElevated: 'color-mix(in srgb, var(--accent-orange) 3%, #ffffff)',
    shellChromeBg: 'color-mix(in srgb, var(--accent-orange) 6%, #f6f1e8)',
    textPrimary: '#332516',
    textSecondary: '#523d29',
    borderColor: 'color-mix(in srgb, var(--accent-orange) 5%, #e5dbc9)',
    borderSubtle: 'color-mix(in srgb, var(--accent-orange) 2.5%, #f2ebdf)',
    mixColor: 'hsl(30, 35%, 28%)',
    composerBg: 'color-mix(in srgb, var(--accent-orange) 1.5%, #ffffff)',
  },
  'dark-cozy': {
    name: '护眼暗灰',
    // 深色层级校正：主界面沉底偏黑 #141414 → 外层侧栏深灰浮层 #1e1e1e → 输入框/卡片微亮 #232323
    bgPrimary: '#141414',
    bgSecondary: '#1e1e1e',
    bgTertiary: '#181818',
    bgCard: '#232323',
    bgElevated: '#262626',
    shellChromeBg: '#1e1e1e',
    textPrimary: '#e6e6e6',
    textSecondary: '#cccccc',
    textTertiary: '#8c8c8c',
    textFaint: '#666666',
    borderColor: '#3a3a3a',
    borderSubtle: '#282828',
    mixColor: 'hsl(0, 0%, 75%)',
  },
  'deep-night': {
    name: '深邃夜空',
    bgPrimary: '#0a0e17',
    bgSecondary: '#1c2536',
    bgTertiary: '#111724',
    bgCard: '#222d42',
    bgElevated: '#28354c',
    shellChromeBg: '#1c2536',
    textPrimary: '#f1f5f9',
    textSecondary: '#c4d0de',
    textTertiary: '#8290a4',
    borderColor: '#28354c',
    borderSubtle: '#1a2232',
    mixColor: 'hsl(217, 30%, 75%)',
  },
  'dark-forest': {
    name: '森林绿影',
    bgPrimary: '#0a120e',
    bgSecondary: '#1a2720',
    bgTertiary: '#111b15',
    bgCard: '#213028',
    bgElevated: '#283a30',
    shellChromeBg: '#1a2720',
    textPrimary: '#e2f0e9',
    textSecondary: '#b8cfc3',
    textTertiary: '#7d9188',
    borderColor: '#283a30',
    borderSubtle: '#1a2821',
    mixColor: 'hsl(145, 20%, 75%)',
  },
  aurora: {
    name: '北欧极光',
    bgPrimary: '#071213',
    bgSecondary: '#162728',
    bgTertiary: '#0c191a',
    bgCard: '#1c3133',
    bgElevated: '#223c3e',
    shellChromeBg: '#162728',
    textPrimary: '#e2f4f5',
    textSecondary: '#b2d2d4',
    textTertiary: '#6f9193',
    borderColor: '#223c3e',
    borderSubtle: '#162829',
    mixColor: 'hsl(180, 25%, 70%)',
  },
  cocoa: {
    name: '可可暗香',
    bgPrimary: '#110d0c',
    bgSecondary: '#261f1d',
    bgTertiary: '#181311',
    bgCard: '#2e2623',
    bgElevated: '#3c302c',
    shellChromeBg: '#261f1d',
    textPrimary: '#f4efe9',
    textSecondary: '#d1c5bf',
    textTertiary: '#9a8b85',
    borderColor: '#3c302c',
    borderSubtle: '#261f1c',
    mixColor: 'hsl(25, 25%, 70%)',
  },
  burgundy: {
    name: '暗红丝绒',
    bgPrimary: '#11080a',
    bgSecondary: '#26161b',
    bgTertiary: '#180d10',
    bgCard: '#2e1b21',
    bgElevated: '#3d232b',
    shellChromeBg: '#26161b',
    textPrimary: '#faecf0',
    textSecondary: '#d8c3c8',
    textTertiary: '#a38c91',
    borderColor: '#3d232b',
    borderSubtle: '#26161b',
    mixColor: 'hsl(345, 20%, 72%)',
  },
  cyber: {
    name: '赛博星空',
    bgPrimary: '#0a0812',
    bgSecondary: '#1c172c',
    bgTertiary: '#120e1f',
    bgCard: '#231d37',
    bgElevated: '#31284d',
    shellChromeBg: '#1c172c',
    textPrimary: '#f1effa',
    textSecondary: '#c6c1de',
    textTertiary: '#8a84a6',
    borderColor: '#31284d',
    borderSubtle: '#1e1930',
    mixColor: 'hsl(255, 25%, 72%)',
  },
  obsidian: {
    name: '黑曜石墨',
    bgPrimary: '#0f1011',
    bgSecondary: '#232527',
    bgTertiary: '#161719',
    bgCard: '#2b2d30',
    bgElevated: '#35373a',
    shellChromeBg: '#232527',
    textPrimary: '#f1f2f3',
    textSecondary: '#c6c9cc',
    textTertiary: '#8c8e90',
    borderColor: '#35373a',
    borderSubtle: '#212325',
    mixColor: 'hsl(200, 5%, 75%)',
  },
};
