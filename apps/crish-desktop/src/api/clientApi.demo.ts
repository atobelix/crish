/**
 * clientApi.demo — demo-only localStorage mocks (providers / cron / MCP / telemetry).
 *
 * Production paths stay in clientApi.ts:
 * - Settings: getSettings* / saveSettings* (SettingsPanel / Skills / App)
 * - Formal MCP: mcpApi
 * - Formal models: providerProfiles + ModelsSettingsTab
 *
 * clientApi methods gate with isDemoMode() and forward here when demo.
 */
import type { CronJob, McpServer, ProviderInfo } from './clientApi';
import type { TelemetrySyncPayload } from '../store/layoutStore';

const PROVIDERS_KEY = 'crish_providers';
const PROVIDERS_KEY_LEGACY = 'conex_pi_providers';
const CRON_KEY = 'crish_cron';
const CRON_KEY_LEGACY = 'conex_pi_cron';
const MCP_KEY = 'crish_mcp';
const MCP_KEY_LEGACY = 'conex_pi_mcp';

const DEFAULT_PROVIDERS: ProviderInfo[] = [
  {
    id: 'google',
    name: 'Google Gemini',
    apiKey: '••••••••••••••••••••••••',
    models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash-thinking', 'gemini-2.0-pro-exp'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    apiKey: '',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
  },
  {
    id: 'openai',
    name: 'OpenAI GPT',
    apiKey: '',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1-pro', 'o3-mini'],
  },
  {
    id: 'bedrock',
    name: 'Amazon Bedrock',
    apiKey: '',
    models: [
      'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      'us.meta.llama3-1-70b-instruct-v1:0',
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    apiKey: '',
    models: ['mistral-large-latest', 'codestral-latest'],
  },
];

/** Demo seed: empty lists (no fake cron/MCP on first open). */
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

function initDemoDb(): void {
  if (!lsGet(PROVIDERS_KEY, PROVIDERS_KEY_LEGACY)) {
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(DEFAULT_PROVIDERS));
  }
  if (!lsGet(CRON_KEY, CRON_KEY_LEGACY)) {
    localStorage.setItem(CRON_KEY, JSON.stringify(DEFAULT_CRON));
  }
  if (!lsGet(MCP_KEY, MCP_KEY_LEGACY)) {
    localStorage.setItem(MCP_KEY, JSON.stringify(DEFAULT_MCP));
  }
}

export const clientApiDemo = {
  // ── Providers (localStorage mock) ──────────────────────────────────────

  getProviders: async (): Promise<ProviderInfo[]> => {
    initDemoDb();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return JSON.parse(lsGet(PROVIDERS_KEY, PROVIDERS_KEY_LEGACY)!);
  },

  updateProviderKey: async (id: string, apiKey: string): Promise<ProviderInfo[]> => {
    initDemoDb();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const list: ProviderInfo[] = JSON.parse(lsGet(PROVIDERS_KEY, PROVIDERS_KEY_LEGACY)!);
    const updated = list.map((p) => (p.id === id ? { ...p, apiKey } : p));
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(updated));
    return updated;
  },

  updateProviderModels: async (id: string, models: string[]): Promise<ProviderInfo[]> => {
    initDemoDb();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const list: ProviderInfo[] = JSON.parse(lsGet(PROVIDERS_KEY, PROVIDERS_KEY_LEGACY)!);
    const updated = list.map((p) => (p.id === id ? { ...p, models } : p));
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(updated));
    return updated;
  },

  fetchLatestModels: async (id: string): Promise<string[]> => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (id === 'google') {
      return [
        'gemini-1.5-pro',
        'gemini-1.5-flash',
        'gemini-2.0-flash-thinking',
        'gemini-2.0-pro-exp',
        'gemini-2.5-flash',
        'gemini-2.5-pro',
      ];
    }
    if (id === 'anthropic') {
      return [
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-3-opus-20240229',
        'claude-3-7-sonnet',
        'claude-3-7-opus',
      ];
    }
    if (id === 'openai') {
      return ['gpt-4o', 'gpt-4o-mini', 'o1-pro', 'o3-mini', 'o1-preview', 'gpt-4.5-preview'];
    }
    if (id === 'bedrock') {
      return [
        'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        'us.meta.llama3-1-70b-instruct-v1:0',
        'us.amazon.nova-pro-v1:0',
      ];
    }
    if (id === 'mistral') {
      return ['mistral-large-latest', 'codestral-latest', 'mistral-saba-latest'];
    }
    return ['custom-model-v1', 'custom-model-v2'];
  },

  // ── Cron / scheduled tasks (localStorage mock) ─────────────────────────

  getScheduledTasks: async (): Promise<CronJob[]> => {
    initDemoDb();
    await new Promise((resolve) => setTimeout(resolve, 120));
    return JSON.parse(lsGet(CRON_KEY, CRON_KEY_LEGACY)!);
  },

  saveScheduledTask: async (task: CronJob): Promise<CronJob[]> => {
    initDemoDb();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const list: CronJob[] = JSON.parse(lsGet(CRON_KEY, CRON_KEY_LEGACY)!);
    const existsIdx = list.findIndex((c) => c.id === task.id);
    if (existsIdx !== -1) {
      list[existsIdx] = task;
    } else {
      list.push(task);
    }
    localStorage.setItem(CRON_KEY, JSON.stringify(list));
    return list;
  },

  deleteScheduledTask: async (id: string): Promise<CronJob[]> => {
    initDemoDb();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const list: CronJob[] = JSON.parse(lsGet(CRON_KEY, CRON_KEY_LEGACY)!);
    const filtered = list.filter((c) => c.id !== id);
    localStorage.setItem(CRON_KEY, JSON.stringify(filtered));
    return filtered;
  },

  // ── MCP servers (localStorage mock; formal uses mcpApi) ────────────────

  getMcpServers: async (): Promise<McpServer[]> => {
    initDemoDb();
    await new Promise((resolve) => setTimeout(resolve, 120));
    return JSON.parse(lsGet(MCP_KEY, MCP_KEY_LEGACY)!);
  },

  saveMcpServer: async (server: McpServer): Promise<McpServer[]> => {
    initDemoDb();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const list: McpServer[] = JSON.parse(lsGet(MCP_KEY, MCP_KEY_LEGACY)!);
    const existsIdx = list.findIndex((m) => m.id === server.id);
    if (existsIdx !== -1) {
      list[existsIdx] = server;
    } else {
      list.push(server);
    }
    localStorage.setItem(MCP_KEY, JSON.stringify(list));
    return list;
  },

  deleteMcpServer: async (id: string): Promise<McpServer[]> => {
    initDemoDb();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const list: McpServer[] = JSON.parse(lsGet(MCP_KEY, MCP_KEY_LEGACY)!);
    const filtered = list.filter((m) => m.id !== id);
    localStorage.setItem(MCP_KEY, JSON.stringify(filtered));
    return filtered;
  },

  // ── Telemetry mock stream ──────────────────────────────────────────────

  subscribeTelemetry: (onData: (data: TelemetrySyncPayload) => void): (() => void) => {
    let ws: WebSocket | null = null;
    let mockInterval: ReturnType<typeof setInterval> | null = null;
    let isClosed = false;

    let inputTokens = 115482;
    let outputTokens = 24930;
    let cost = 0.345;

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
            {
              id: 'worker-1',
              taskName: 'Git diff analysis',
              elapsedSeconds: Math.floor(Math.random() * 20) + 5,
            },
            {
              id: 'worker-2',
              taskName: 'indexing codebase',
              elapsedSeconds: Math.floor(Math.random() * 60) + 120,
            },
          ],
          mcpServers: JSON.parse(lsGet(MCP_KEY, MCP_KEY_LEGACY) || '[]'),
          cronJobs: JSON.parse(lsGet(CRON_KEY, CRON_KEY_LEGACY) || '[]'),
        });
      }, 2000);
    };

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

    connect();
    startMockTelemetry();

    return () => {
      isClosed = true;
      if (ws) ws.close();
      if (mockInterval) clearInterval(mockInterval);
    };
  },
};
