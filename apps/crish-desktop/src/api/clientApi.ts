/**
 * clientApi — localStorage-backed client preferences + demo-gated stubs.
 *
 * 正式路径（保留实现）：
 * - Settings：getSettings / updateSettings / getSettingsEx / saveSettingsEx
 *   → SettingsPanel / SettingsRulesTab / SkillsSettingsTab / App / ChatCard
 * - subscribeTelemetry：正式安静 no-op；demo 转发 clientApi.demo
 *
 * 正式勿走（DEAD / HONEST-HIDE，实现在 clientApi.demo.ts）：
 * - getProviders / updateProvider* / fetchLatestModels → 用 providerProfiles + ModelsSettingsTab
 * - getMcpServers* / saveMcpServer / deleteMcpServer → 正式用 mcpApi；demo 用 localStorage
 * - getScheduledTasks / saveScheduledTask / deleteScheduledTask → 正式无假定时；demo localStorage
 *
 * 转发约定：
 *   if (isDemoMode()) return clientApiDemo.xxx(...)
 *   else return [] | no-op  // HONEST-HIDE
 *
 * 兼容：`export const piClientApi = clientApi`（勿再新建 piClientApi.ts）
 */
import { isDemoMode } from './appMode';
import { clientApiDemo } from './clientApi.demo';

export interface CompactionSettings {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

export interface BranchSummarySettings {
  reserveTokens?: number;
  skipPrompt?: boolean;
}

export interface ProviderRetrySettings {
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
}

export interface RetrySettings {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  provider?: ProviderRetrySettings;
}

export interface TerminalSettings {
  showImages?: boolean;
  imageWidthCells?: number;
  clearOnShrink?: boolean;
  showTerminalProgress?: boolean;
}

export interface ImageSettings {
  autoResize?: boolean;
  blockImages?: boolean;
}

export interface ThinkingBudgetsSettings {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export interface MarkdownSettings {
  codeBlockIndent?: string;
}

export interface WarningSettings {
  anthropicExtraUsage?: boolean;
}

export interface PackageSource {
  source: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

export interface Settings {
  customRules?: string[];
  lastChangelogVersion?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  theme?: string;
  /** UI / mono font preferences (mirrored in crish_fonts) */
  fonts?: {
    uiFont?: string;
    monoFont?: string;
    monoLigatures?: boolean;
    v?: number;
  };
  compaction?: CompactionSettings;
  branchSummary?: BranchSummarySettings;
  retry?: RetrySettings;
  hideThinkingBlock?: boolean;
  shellPath?: string;
  quietStartup?: boolean;
  shellCommandPrefix?: string;
  npmCommand?: string[];
  collapseChangelog?: boolean;
  enableInstallTelemetry?: boolean;
  enableAnalytics?: boolean;
  packages?: (string | PackageSource)[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  enableSkillCommands?: boolean;
  terminal?: TerminalSettings;
  images?: ImageSettings;
  enabledModels?: string[];
  thinkingBudgets?: ThinkingBudgetsSettings;
  markdown?: MarkdownSettings;
  warnings?: WarningSettings;
  sessionDir?: string;
  httpProxy?: string;
  httpIdleTimeoutMs?: number;
  /** 回答风格（本机偏好；不强制进引擎协议） */
  responseStyle?: 'minimal' | 'low' | 'medium' | 'high';
}

/** Demo / layoutStore shape; formal models use providerProfiles. */
export interface ProviderInfo {
  id: string;
  name: string;
  apiKey: string;
  models: string[];
}

/** Demo / RuntimePanel shape; formal has no invented cron list. */
export interface CronJob {
  id: string;
  cronExpression: string;
  prompt: string;
  targetSession: 'current-session' | 'new-session';
  status: 'active' | 'paused';
  nextRun: string;
}

/** Demo / McpSettingsTab mock shape; formal MCP uses mcpApi.McpServerInfo. */
export interface McpServer {
  id: string;
  name: string;
  type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  status: 'connected' | 'disconnected' | 'connecting';
  tools: string[];
}

// LocalStorage Keys (settings only — providers/cron/mcp live in clientApi.demo)
const SETTINGS_KEY = 'crish_settings';
const SETTINGS_KEY_LEGACY = 'conex_pi_settings';

const DEFAULT_SETTINGS: Settings = {
  customRules: [],
  defaultProvider: '',
  defaultModel: '',
  defaultThinkingLevel: 'medium',
  theme: 'default',
  fonts: { uiFont: 'auto', monoFont: 'auto', monoLigatures: false, v: 1 },
  hideThinkingBlock: false,
  quietStartup: true,
  enableSkillCommands: true,
  enableAnalytics: false,
  compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  branchSummary: { reserveTokens: 16384, skipPrompt: false },
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
  terminal: { showImages: true, imageWidthCells: 60, clearOnShrink: false, showTerminalProgress: false },
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
};

function lsGet(key: string, legacy?: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (v != null) return v;
    if (legacy) {
      const old = localStorage.getItem(legacy);
      if (old != null) {
        localStorage.setItem(key, old);
        return old;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

const initSettingsDb = () => {
  if (!lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY)) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS));
  }
};

// Recursive deep merge helper
export function deepMergeSettings(target: any, source: any): any {
  if (!source) return target;
  if (!target) return source;
  const output = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      output[key] = deepMergeSettings(target[key], source[key]);
    } else {
      output[key] = source[key];
    }
  }
  return output;
}

// Exclusive file write lock implementation
let isWritingSettings = false;
async function acquireWriteLock(): Promise<void> {
  while (isWritingSettings) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  isWritingSettings = true;
}
function releaseWriteLock(): void {
  isWritingSettings = false;
}

/**
 * Project-scoped settings key. Opening a project means the user chose that
 * directory — no separate "trust this folder" gate.
 */
function projectSettingsKey(cwd: string): string {
  const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase();
  return `crish_project_settings_${normalizedCwd}`;
}

export const clientApi = {
  // ── Settings（正式路径）────────────────────────────────────────────────

  getSettings: async (): Promise<Settings> => {
    let cwd = '';
    try {
      cwd = localStorage.getItem('crish_workspace') || '';
    } catch {
      cwd = '';
    }
    return clientApi.getSettingsEx(cwd || '__global__');
  },

  updateSettings: async (updates: Partial<Settings>): Promise<Settings> => {
    return clientApi.saveSettingsEx('__global__', 'global', updates);
  },

  getSettingsEx: async (cwd: string): Promise<Settings> => {
    initSettingsDb();
    await new Promise(resolve => setTimeout(resolve, 100));
    const globalSettings = JSON.parse(lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY)!);

    if (!cwd || cwd === '__global__') {
      return globalSettings;
    }

    const projectSettingsStr = localStorage.getItem(projectSettingsKey(cwd));
    if (!projectSettingsStr) {
      return globalSettings;
    }

    try {
      const projectSettings = JSON.parse(projectSettingsStr);
      return deepMergeSettings(globalSettings, projectSettings);
    } catch {
      return globalSettings;
    }
  },

  saveSettingsEx: async (cwd: string, scope: 'global' | 'project', updates: Partial<Settings>): Promise<Settings> => {
    initSettingsDb();
    await acquireWriteLock();
    try {
      await new Promise(resolve => setTimeout(resolve, 150));

      if (scope === 'global') {
        const current = JSON.parse(lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY)!);
        const merged = deepMergeSettings(current, updates);
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
        return merged;
      } else {
        const projKey = projectSettingsKey(cwd);
        const currentStr = localStorage.getItem(projKey);
        const current = currentStr ? JSON.parse(currentStr) : {};
        const merged = deepMergeSettings(current, updates);
        localStorage.setItem(projKey, JSON.stringify(merged));

        const globalSettings = JSON.parse(lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY)!);
        return deepMergeSettings(globalSettings, merged);
      }
    } finally {
      releaseWriteLock();
    }
  },

  // ── Telemetry：正式 no-op；demo → clientApi.demo ───────────────────────

  subscribeTelemetry: (onData: (data: any) => void): (() => void) => {
    if (!isDemoMode()) return () => undefined;
    return clientApiDemo.subscribeTelemetry(onData);
  },

  // ── Providers — DEAD formal（providerProfiles）；demo mock ──────────────

  /** @deprecated DEAD formal — use providerProfiles. HONEST-HIDE: formal returns []. */
  getProviders: async (): Promise<ProviderInfo[]> => {
    if (!isDemoMode()) return [];
    return clientApiDemo.getProviders();
  },

  /** @deprecated DEAD formal — use providerProfiles. HONEST-HIDE: formal returns []. */
  updateProviderKey: async (id: string, apiKey: string): Promise<ProviderInfo[]> => {
    if (!isDemoMode()) return [];
    return clientApiDemo.updateProviderKey(id, apiKey);
  },

  /** @deprecated DEAD formal — use providerProfiles. HONEST-HIDE: formal returns []. */
  updateProviderModels: async (id: string, models: string[]): Promise<ProviderInfo[]> => {
    if (!isDemoMode()) return [];
    return clientApiDemo.updateProviderModels(id, models);
  },

  /** @deprecated DEAD formal — use providerProfiles / ModelsSettingsTab. HONEST-HIDE: formal returns []. */
  fetchLatestModels: async (id: string): Promise<string[]> => {
    if (!isDemoMode()) return [];
    return clientApiDemo.fetchLatestModels(id);
  },

  // ── Cron — formal 无假定时；demo localStorage ──────────────────────────

  /** HONEST-HIDE formal: returns []. Demo only reads localStorage mock. */
  getScheduledTasks: async (): Promise<CronJob[]> => {
    if (!isDemoMode()) return [];
    return clientApiDemo.getScheduledTasks();
  },

  /** HONEST-HIDE formal: returns []. */
  saveScheduledTask: async (task: CronJob): Promise<CronJob[]> => {
    if (!isDemoMode()) return [];
    return clientApiDemo.saveScheduledTask(task);
  },

  /** HONEST-HIDE formal: returns []. */
  deleteScheduledTask: async (id: string): Promise<CronJob[]> => {
    if (!isDemoMode()) return [];
    return clientApiDemo.deleteScheduledTask(id);
  },

  // ── MCP localStorage — formal 用 mcpApi；demo mock ─────────────────────

  /** HONEST-HIDE formal: returns []. Demo: localStorage. Formal MCP → mcpApi. */
  getMcpServers: async (): Promise<McpServer[]> => {
    if (!isDemoMode()) return [];
    return clientApiDemo.getMcpServers();
  },

  /** HONEST-HIDE formal: returns []. */
  saveMcpServer: async (server: McpServer): Promise<McpServer[]> => {
    if (!isDemoMode()) return [];
    return clientApiDemo.saveMcpServer(server);
  },

  /** HONEST-HIDE formal: returns []. */
  deleteMcpServer: async (id: string): Promise<McpServer[]> => {
    if (!isDemoMode()) return [];
    return clientApiDemo.deleteMcpServer(id);
  },
};

/** @deprecated use clientApi */
export const piClientApi = clientApi;
