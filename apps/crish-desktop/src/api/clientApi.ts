/**
 * clientApi — localStorage-backed client preferences + demo-only mocks.
 *
 * 正式路径约定（勿走死轨）：
 * - 勿用 getProviders / fetchLatestModels / updateProvider*（正式模型用 providerProfiles + ModelsSettingsTab）
 * - 正式 MCP 用 mcpApi（本文件 getMcpServers* 仅为 demo/legacy localStorage）
 * - Settings（getSettings / updateSettings / getSettingsEx / saveSettingsEx）仍为正式路径，SettingsPanel 在用
 * - 正式 telemetry / scheduled tasks 不在此发明假数据；见下方 DEAD / HONEST-HIDE
 *
 * 兼容：`export const piClientApi = clientApi`（勿再新建 piClientApi.ts）
 */
import { isDemoMode } from './appMode';

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

export interface ProviderInfo {
  id: string;
  name: string;
  apiKey: string;
  models: string[];
}

export interface CronJob {
  id: string;
  cronExpression: string;
  prompt: string;
  targetSession: 'current-session' | 'new-session';
  status: 'active' | 'paused';
  nextRun: string;
}

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

// LocalStorage Keys
const SETTINGS_KEY = 'crish_settings';
const SETTINGS_KEY_LEGACY = 'conex_pi_settings';
const PROVIDERS_KEY = 'crish_providers';
const PROVIDERS_KEY_LEGACY = 'conex_pi_providers';
const CRON_KEY = 'crish_cron';
const CRON_KEY_LEGACY = 'conex_pi_cron';
const MCP_KEY = 'crish_mcp';
const MCP_KEY_LEGACY = 'conex_pi_mcp';

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

const DEFAULT_PROVIDERS: ProviderInfo[] = [
  {
    id: 'google',
    name: 'Google Gemini',
    apiKey: '••••••••••••••••••••••••',
    models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash-thinking', 'gemini-2.0-pro-exp']
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    apiKey: '',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229']
  },
  {
    id: 'openai',
    name: 'OpenAI GPT',
    apiKey: '',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1-pro', 'o3-mini']
  },
  {
    id: 'bedrock',
    name: 'Amazon Bedrock',
    apiKey: '',
    models: ['us.anthropic.claude-3-5-sonnet-20241022-v2:0', 'us.meta.llama3-1-70b-instruct-v1:0']
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    apiKey: '',
    models: ['mistral-large-latest', 'codestral-latest']
  }
];

/** 正式版：新用户不 seed 假定时任务 / 假 MCP */
const DEFAULT_CRON: CronJob[] = [];
const DEFAULT_MCP: McpServer[] = [];

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

// Helper to initialize LocalStorage if empty
const initDb = () => {
  if (!lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY)) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS));
  }
  if (!lsGet(PROVIDERS_KEY, PROVIDERS_KEY_LEGACY)) {
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(DEFAULT_PROVIDERS));
  }
  if (!lsGet(CRON_KEY, CRON_KEY_LEGACY)) {
    localStorage.setItem(CRON_KEY, JSON.stringify(DEFAULT_CRON));
  }
  if (!lsGet(MCP_KEY, MCP_KEY_LEGACY)) {
    localStorage.setItem(MCP_KEY, JSON.stringify(DEFAULT_MCP));
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
  // Settings Management
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

  // Scoped Settings (Global vs Project)
  getSettingsEx: async (cwd: string): Promise<Settings> => {
    initDb();
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
    initDb();
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

  // Telemetry: demo uses mock stream; formal edition stays quiet
  subscribeTelemetry: (onData: (data: any) => void): (() => void) => {
    // Formal product: do not invent token counters or fake workers
    if (!isDemoMode()) {
      return () => undefined;
    }

    let ws: WebSocket | null = null;
    let mockInterval: any = null;
    let isClosed = false;

    let inputTokens = 115482;
    let outputTokens = 24930;
    let cost = 0.345;

    const connect = () => {
      if (isClosed) return;
      try {
        ws = new WebSocket('ws://localhost:3011/telemetry');
        ws.onmessage = (event) => {
          try {
            const parsed = JSON.parse(event.data);
            if (parsed.type === 'telemetry') {
              onData(parsed.data);
            }
          } catch (e) {
            console.error('Telemetry parse error:', e);
          }
        };
        ws.onerror = () => {};
        ws.onclose = () => {
          ws = null;
          if (!isClosed && !mockInterval) {
            startMockTelemetry();
          }
        };
      } catch {
        if (!isClosed && !mockInterval) {
          startMockTelemetry();
        }
      }
    };

    const startMockTelemetry = () => {
      mockInterval = setInterval(() => {
        inputTokens += Math.floor(Math.random() * 250);
        outputTokens += Math.floor(Math.random() * 50);
        cost = parseFloat((cost + Math.random() * 0.005).toFixed(4));

        onData({
          tokenUsage: {
            input: inputTokens,
            inputMax: 160000,
            output: outputTokens,
            outputMax: 40000,
            cost: cost,
          },
          activeWorkers: [
            { id: 'worker-1', taskName: 'Git diff analysis', elapsedSeconds: Math.floor(Math.random() * 20) + 5 },
            { id: 'worker-2', taskName: 'indexing codebase', elapsedSeconds: Math.floor(Math.random() * 60) + 120 },
          ],
          mcpServers: JSON.parse(lsGet(MCP_KEY, MCP_KEY_LEGACY) || '[]'),
          cronJobs: JSON.parse(lsGet(CRON_KEY, CRON_KEY_LEGACY) || '[]'),
        });
      }, 2000);
    };

    connect();
    startMockTelemetry();

    return () => {
      isClosed = true;
      if (ws) ws.close();
      if (mockInterval) clearInterval(mockInterval);
    };
  },

  // Providers & Keys — DEAD for formal path (use providerProfiles). Demo-only mock below.
  /** @deprecated DEAD formal — use providerProfiles. HONEST-HIDE: formal returns []. */
  getProviders: async (): Promise<ProviderInfo[]> => {
    if (!isDemoMode()) return []; // HONEST-HIDE formal
    initDb();
    await new Promise(resolve => setTimeout(resolve, 100));
    return JSON.parse(lsGet(PROVIDERS_KEY, PROVIDERS_KEY_LEGACY)!);
  },

  /** @deprecated DEAD formal — use providerProfiles. HONEST-HIDE: formal returns []. */
  updateProviderKey: async (id: string, apiKey: string): Promise<ProviderInfo[]> => {
    if (!isDemoMode()) return []; // HONEST-HIDE formal
    initDb();
    await new Promise(resolve => setTimeout(resolve, 150));
    const list: ProviderInfo[] = JSON.parse(lsGet(PROVIDERS_KEY, PROVIDERS_KEY_LEGACY)!);
    const updated = list.map(p => p.id === id ? { ...p, apiKey } : p);
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(updated));
    return updated;
  },

  /** @deprecated DEAD formal — use providerProfiles. HONEST-HIDE: formal returns []. */
  updateProviderModels: async (id: string, models: string[]): Promise<ProviderInfo[]> => {
    if (!isDemoMode()) return []; // HONEST-HIDE formal
    initDb();
    await new Promise(resolve => setTimeout(resolve, 150));
    const list: ProviderInfo[] = JSON.parse(lsGet(PROVIDERS_KEY, PROVIDERS_KEY_LEGACY)!);
    const updated = list.map(p => p.id === id ? { ...p, models } : p);
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(updated));
    return updated;
  },

  /** @deprecated DEAD formal — use providerProfiles / ModelsSettingsTab. HONEST-HIDE: formal returns []. */
  fetchLatestModels: async (id: string): Promise<string[]> => {
    if (!isDemoMode()) return []; // HONEST-HIDE formal — no fake model catalog
    await new Promise(resolve => setTimeout(resolve, 800)); // 模拟网络延迟
    if (id === 'google') {
      return ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash-thinking', 'gemini-2.0-pro-exp', 'gemini-2.5-flash', 'gemini-2.5-pro'];
    } else if (id === 'anthropic') {
      return ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229', 'claude-3-7-sonnet', 'claude-3-7-opus'];
    } else if (id === 'openai') {
      return ['gpt-4o', 'gpt-4o-mini', 'o1-pro', 'o3-mini', 'o1-preview', 'gpt-4.5-preview'];
    } else if (id === 'bedrock') {
      return ['us.anthropic.claude-3-5-sonnet-20241022-v2:0', 'us.meta.llama3-1-70b-instruct-v1:0', 'us.amazon.nova-pro-v1:0'];
    } else if (id === 'mistral') {
      return ['mistral-large-latest', 'codestral-latest', 'mistral-saba-latest'];
    }
    return ['custom-model-v1', 'custom-model-v2'];
  },

  // Cron / Scheduled Tasks — formal: no invented cron list (demo may use localStorage)
  /** HONEST-HIDE formal: returns []. Demo only reads localStorage mock. */
  getScheduledTasks: async (): Promise<CronJob[]> => {
    if (!isDemoMode()) return []; // HONEST-HIDE formal
    initDb();
    await new Promise(resolve => setTimeout(resolve, 120));
    return JSON.parse(lsGet(CRON_KEY, CRON_KEY_LEGACY)!);
  },

  saveScheduledTask: async (task: CronJob): Promise<CronJob[]> => {
    initDb();
    await new Promise(resolve => setTimeout(resolve, 200));
    const list: CronJob[] = JSON.parse(lsGet(CRON_KEY, CRON_KEY_LEGACY)!);
    const existsIdx = list.findIndex(c => c.id === task.id);
    if (existsIdx !== -1) {
      list[existsIdx] = task;
    } else {
      list.push(task);
    }
    localStorage.setItem(CRON_KEY, JSON.stringify(list));
    return list;
  },

  deleteScheduledTask: async (id: string): Promise<CronJob[]> => {
    initDb();
    await new Promise(resolve => setTimeout(resolve, 150));
    const list: CronJob[] = JSON.parse(lsGet(CRON_KEY, CRON_KEY_LEGACY)!);
    const filtered = list.filter(c => c.id !== id);
    localStorage.setItem(CRON_KEY, JSON.stringify(filtered));
    return filtered;
  },

  // MCP Servers Management
  getMcpServers: async (): Promise<McpServer[]> => {
    initDb();
    await new Promise(resolve => setTimeout(resolve, 120));
    return JSON.parse(lsGet(MCP_KEY, MCP_KEY_LEGACY)!);
  },

  saveMcpServer: async (server: McpServer): Promise<McpServer[]> => {
    initDb();
    await new Promise(resolve => setTimeout(resolve, 200));
    const list: McpServer[] = JSON.parse(lsGet(MCP_KEY, MCP_KEY_LEGACY)!);
    const existsIdx = list.findIndex(m => m.id === server.id);
    if (existsIdx !== -1) {
      list[existsIdx] = server;
    } else {
      list.push(server);
    }
    localStorage.setItem(MCP_KEY, JSON.stringify(list));
    return list;
  },

  deleteMcpServer: async (id: string): Promise<McpServer[]> => {
    initDb();
    await new Promise(resolve => setTimeout(resolve, 150));
    const list: McpServer[] = JSON.parse(lsGet(MCP_KEY, MCP_KEY_LEGACY)!);
    const filtered = list.filter(m => m.id !== id);
    localStorage.setItem(MCP_KEY, JSON.stringify(filtered));
    return filtered;
  }
};


/** @deprecated use clientApi */
export const piClientApi = clientApi;
