/**
 * 设置 localStorage 读写。
 * 从 clientApi 拆分而来，专门负责 Settings 的持久化与规范化。
 */

import type { Settings, McpServer } from './clientApi';
import type { TelemetrySyncPayload } from '../store/layoutStore';
import {
  normalizeSettingsText,
  normalizeResponseStyle,
  normalizeThinkingLevel,
  normalizeSettingsBool,
  normalizeCustomRules,
  parseSettingsJson,
  normalizeSettingsPartial,
  getDefaultSettings,
  deepMergeSettings,
  normalizeSettingsPayload,
} from './clientApi';

// ── LocalStorage Keys ──

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
  sendShortcut: 'enter',
  tabModeEnabled: true,
};

// ── Lock ──

const SETTINGS_LOCK_NAME = 'crish-settings-write';
const SETTINGS_LOCK_TIMEOUT_MS = 2_000;
let isWritingSettings = false;

async function withSettingsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return new Promise<T>((resolve, reject) => {
      navigator.locks.request(SETTINGS_LOCK_NAME, { mode: 'exclusive', ifAvailable: false }, async (lock) => {
        if (!lock) { try { return resolve(await fn()); } catch (e) { return reject(e); } }
        try { resolve(await fn()); } catch (e) { reject(e); }
      });
    });
  }
  const deadline = Date.now() + SETTINGS_LOCK_TIMEOUT_MS;
  while (isWritingSettings && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  isWritingSettings = true;
  try { return await fn(); } finally { isWritingSettings = false; }
}

// ── Helpers ──

function lsGet(key: string, legacy?: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (v != null) return v;
    if (legacy) {
      const old = localStorage.getItem(legacy);
      if (old != null) { localStorage.setItem(key, old); return old; }
    }
  } catch { /* ignore */ }
  return null;
}

function initSettingsDb(): void {
  if (!lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY)) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS));
  }
}

function projectSettingsKey(cwd: string): string {
  const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase();
  return `crish_project_settings_${normalizedCwd}`;
}

// ── Public API ──

export const settingsStorage = {
  getSettings: async (): Promise<Settings> => {
    let cwd = '';
    try { cwd = localStorage.getItem('crish_workspace') || ''; } catch { cwd = ''; }
    return settingsStorage.getSettingsEx(cwd || '__global__');
  },

  updateSettings: async (updates: Partial<Settings>): Promise<Settings> => {
    return settingsStorage.saveSettingsEx('__global__', 'global', updates);
  },

  getProjectSettingsPartial: async (cwd: string): Promise<Partial<Settings>> => {
    initSettingsDb();
    if (!cwd || cwd === '__global__') return {};
    const raw = localStorage.getItem(projectSettingsKey(cwd));
    if (!raw) return {};
    const parsed = parseSettingsJson(raw);
    if (!parsed) return {};
    return normalizeSettingsPartial(parsed);
  },

  getSettingsEx: async (cwd: string): Promise<Settings> => {
    initSettingsDb();
    let globalSettings: Settings = getDefaultSettings();
    const raw = lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY);
    if (raw) {
      const parsed = parseSettingsJson(raw);
      if (parsed) globalSettings = normalizeSettingsPayload(parsed);
      else {
        try {
          const rawStr = typeof raw === 'string' ? raw : '';
          if (rawStr) localStorage.setItem(`${SETTINGS_KEY}__corrupt_backup_${Date.now()}`, rawStr);
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(getDefaultSettings()));
        } catch { /* ignore */ }
        globalSettings = getDefaultSettings();
      }
    }
    if (!cwd || cwd === '__global__') return globalSettings;
    const projectSettingsStr = localStorage.getItem(projectSettingsKey(cwd));
    if (!projectSettingsStr) return globalSettings;
    const projectPartial = parseSettingsJson(projectSettingsStr);
    if (!projectPartial) return globalSettings;
    return normalizeSettingsPayload(deepMergeSettings(globalSettings, normalizeSettingsPartial(projectPartial)));
  },

  saveSettingsEx: async (cwd: string, scope: 'global' | 'project', updates: Partial<Settings>): Promise<Settings> => {
    initSettingsDb();
    return withSettingsWriteLock(async () => {
      const safeUpdates = normalizeSettingsPartial(updates);
      if (scope === 'global') {
        let current: Settings = getDefaultSettings();
        const raw = lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY);
        if (raw) { const parsed = parseSettingsJson(raw); if (parsed) current = normalizeSettingsPayload(parsed); }
        const merged = normalizeSettingsPayload(deepMergeSettings(current, safeUpdates));
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
        return merged;
      } else {
        const projKey = projectSettingsKey(cwd);
        const currentStr = localStorage.getItem(projKey);
        let current: Record<string, unknown> = {};
        const parsedProj = parseSettingsJson(currentStr);
        if (parsedProj) current = { ...parsedProj } as Record<string, unknown>;
        const merged = normalizeSettingsPartial(deepMergeSettings(current, safeUpdates));
        localStorage.setItem(projKey, JSON.stringify(merged));
        let globalSettings: Settings = getDefaultSettings();
        const raw = lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY);
        if (raw) { const parsed = parseSettingsJson(raw); if (parsed) globalSettings = normalizeSettingsPayload(parsed); }
        return normalizeSettingsPayload(deepMergeSettings(globalSettings, merged));
      }
    });
  },

  subscribeTelemetry: (_onData: (data: TelemetrySyncPayload) => void): (() => void) => {
    return () => undefined;
  },

  getMcpServers: async (): Promise<McpServer[]> => { return []; },
  saveMcpServer: async (_server: McpServer): Promise<McpServer[]> => { return []; },
  deleteMcpServer: async (_id: string): Promise<McpServer[]> => { return []; },
};
