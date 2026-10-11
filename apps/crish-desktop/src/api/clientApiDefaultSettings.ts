/**
 * 默认 settings 常量（拆自 clientApiNormalize，纯数据，无副作用）。
 * 供 getDefaultSettings / normalizeSettingsPayload 引用。
 */
import type { Settings } from './clientApi.types';

export const DEFAULT_SETTINGS: Settings = {
  customRules: [],
  defaultProvider: '',
  defaultModel: '',
  defaultThinkingLevel: 'default',
  theme: 'default',
  fonts: { uiFont: 'auto', monoFont: 'auto', monoLigatures: false, v: 1 },
  hideThinkingBlock: false,
  quietStartup: true,
  enableSkillCommands: true,
  enableAnalytics: false,
  enableCrashTelemetry: true,
  compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  branchSummary: { reserveTokens: 16384, skipPrompt: false },
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
  maxRetryAttempts: 10,
  terminal: {
    showImages: true,
    imageWidthCells: 60,
    clearOnShrink: false,
    showTerminalProgress: false,
  },
  images: { autoResize: true, blockImages: false },
  markdown: { codeBlockIndent: '  ' },
  warnings: { anthropicExtraUsage: true },
  packages: [],
  skills: [],
  extensions: [],
  prompts: [],
  themes: [],
  sessionDir: '',
  responseStyle: 'medium',
  sendShortcut: 'enter',
  tabModeEnabled: true,
};
