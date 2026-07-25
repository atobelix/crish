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
  defaultThinkingLevel?:
    'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  theme?: string;
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
  responseStyle?: ResponseStyle;
  sendShortcut?: string;
  shortcuts?: Record<string, string>;
  tabModeEnabled?: boolean;
  mcpDisabledTools?: Record<string, string[]>;
}

export type ResponseStyle = 'minimal' | 'low' | 'medium' | 'high';

export type ThinkingLevel = NonNullable<Settings['defaultThinkingLevel']>;

export const RESPONSE_STYLE_IDS: readonly ResponseStyle[] = [
  'minimal',
  'low',
  'medium',
  'high',
] as const;

export const THINKING_LEVEL_IDS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export const RESPONSE_STYLE_OPTIONS: ReadonlyArray<{
  value: ResponseStyle;
  label: string;
}> = [
  { value: 'minimal', label: '简洁' },
  { value: 'low', label: '标准' },
  { value: 'medium', label: '详细' },
  { value: 'high', label: '深入' },
];

const RESPONSE_STYLE_LABEL_MAP: Readonly<Record<string, ResponseStyle>> = {
  简洁: 'minimal',
  标准: 'low',
  详细: 'medium',
  深入: 'high',
};

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

export function normalizeSettingsText(raw: unknown): string {
  if (raw == null) return '';
  if (
    typeof raw !== 'string' &&
    typeof raw !== 'number' &&
    typeof raw !== 'boolean'
  ) {
    return '';
  }
  let s = String(raw);
  try {
    s = s.normalize('NFC');
  } catch {
    /* ignore */
  }
  return s.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
}

export function normalizeResponseStyle(raw: unknown): ResponseStyle {
  if (raw === 'minimal' || raw === 'low' || raw === 'medium' || raw === 'high')
    return raw;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const t = normalizeSettingsText(raw);
    const lower = t.toLowerCase();
    if (
      lower === 'minimal' ||
      lower === 'low' ||
      lower === 'medium' ||
      lower === 'high'
    ) {
      return lower;
    }
    const fromLabel = RESPONSE_STYLE_LABEL_MAP[t];
    if (fromLabel) return fromLabel;
  }
  return 'medium';
}

export function normalizeThinkingLevel(raw: unknown): ThinkingLevel {
  if (
    raw === 'off' ||
    raw === 'minimal' ||
    raw === 'low' ||
    raw === 'medium' ||
    raw === 'high' ||
    raw === 'xhigh'
  ) {
    return raw;
  }
  if (typeof raw === 'string' || typeof raw === 'number') {
    const t = normalizeSettingsText(raw).toLowerCase();
    if (
      t === 'off' ||
      t === 'minimal' ||
      t === 'low' ||
      t === 'medium' ||
      t === 'high' ||
      t === 'xhigh'
    ) {
      return t;
    }
  }
  return 'medium';
}

export function normalizeSettingsBool(
  raw: unknown,
  fallback: boolean
): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return fallback;
  }
  if (typeof raw === 'string') {
    const t = normalizeSettingsText(raw).toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes' || t === 'on' || t === '是')
      return true;
    if (t === 'false' || t === '0' || t === 'no' || t === 'off' || t === '否')
      return false;
  }
  return fallback;
}

export function normalizeCustomRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (
      typeof item !== 'string' &&
      typeof item !== 'number' &&
      typeof item !== 'boolean'
    ) {
      continue;
    }
    const t = normalizeSettingsText(item);
    if (t) out.push(t);
  }
  return out;
}

export function parseSettingsJson(raw: unknown): Partial<Settings> | null {
  if (raw == null) return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const t = raw.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
    if (!t) return null;
    try {
      value = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Partial<Settings>;
}

export function normalizeSettingsPartial(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: Partial<Settings> = { ...(raw as Partial<Settings>) };

  if ('responseStyle' in o)
    out.responseStyle = normalizeResponseStyle(o.responseStyle);
  if ('defaultThinkingLevel' in o) {
    out.defaultThinkingLevel = normalizeThinkingLevel(o.defaultThinkingLevel);
  }
  if ('hideThinkingBlock' in o) {
    out.hideThinkingBlock = normalizeSettingsBool(o.hideThinkingBlock, false);
  }
  if ('tabModeEnabled' in o) {
    out.tabModeEnabled = normalizeSettingsBool(o.tabModeEnabled, true);
  }
  if ('quietStartup' in o) {
    out.quietStartup = normalizeSettingsBool(o.quietStartup, true);
  }
  if ('enableSkillCommands' in o) {
    out.enableSkillCommands = normalizeSettingsBool(
      o.enableSkillCommands,
      true
    );
  }
  if ('enableAnalytics' in o) {
    out.enableAnalytics = normalizeSettingsBool(o.enableAnalytics, false);
  }
  if ('collapseChangelog' in o) {
    out.collapseChangelog = normalizeSettingsBool(o.collapseChangelog, false);
  }
  if ('enableInstallTelemetry' in o) {
    out.enableInstallTelemetry = normalizeSettingsBool(
      o.enableInstallTelemetry,
      false
    );
  }
  if ('customRules' in o) out.customRules = normalizeCustomRules(o.customRules);
  if (
    'mcpDisabledTools' in o &&
    o.mcpDisabledTools &&
    typeof o.mcpDisabledTools === 'object' &&
    !Array.isArray(o.mcpDisabledTools)
  ) {
    const map: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(
      o.mcpDisabledTools as Record<string, unknown>
    )) {
      if (!k || !Array.isArray(v)) continue;
      const tools = v
        .map(String)
        .map((t) => t.trim())
        .filter(Boolean);
      if (tools.length) map[k] = tools;
    }
    out.mcpDisabledTools = map;
  }
  if ('sendShortcut' in o) {
    const v = normalizeSettingsText(o.sendShortcut);
    out.sendShortcut = v === 'ctrlEnter' ? 'ctrlEnter' : 'enter';
  }
  if ('defaultProvider' in o)
    out.defaultProvider = normalizeSettingsText(o.defaultProvider);
  if ('defaultModel' in o)
    out.defaultModel = normalizeSettingsText(o.defaultModel);
  if ('theme' in o) {
    const theme = normalizeSettingsText(o.theme);
    out.theme = theme || 'default';
  }
  if ('shellPath' in o) out.shellPath = normalizeSettingsText(o.shellPath);
  if ('shellCommandPrefix' in o) {
    out.shellCommandPrefix = normalizeSettingsText(o.shellCommandPrefix);
  }
  if ('sessionDir' in o) out.sessionDir = normalizeSettingsText(o.sessionDir);
  if ('lastChangelogVersion' in o) {
    out.lastChangelogVersion = normalizeSettingsText(o.lastChangelogVersion);
  }
  if ('httpProxy' in o) out.httpProxy = normalizeSettingsText(o.httpProxy);

  if (
    'fonts' in o &&
    o.fonts &&
    typeof o.fonts === 'object' &&
    !Array.isArray(o.fonts)
  ) {
    const f = o.fonts as Record<string, unknown>;
    out.fonts = {
      ...(o.fonts as Settings['fonts']),
      uiFont:
        'uiFont' in f
          ? normalizeSettingsText(f.uiFont) || 'auto'
          : (o.fonts as Settings['fonts'])?.uiFont,
      monoFont:
        'monoFont' in f
          ? normalizeSettingsText(f.monoFont) || 'auto'
          : (o.fonts as Settings['fonts'])?.monoFont,
      monoLigatures:
        'monoLigatures' in f
          ? normalizeSettingsBool(f.monoLigatures, false)
          : (o.fonts as Settings['fonts'])?.monoLigatures,
    };
  }

  return out;
}

export function getDefaultSettings(): Settings {
  return deepMergeSettings({}, DEFAULT_SETTINGS) as Settings;
}

export function normalizeSettingsPayload(raw: unknown): Settings {
  const partial =
    parseSettingsJson(raw) ??
    (raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Partial<Settings>)
      : null);
  if (!partial) return getDefaultSettings();
  const merged = deepMergeSettings(
    getDefaultSettings(),
    normalizeSettingsPartial(partial)
  ) as Settings;
  return {
    ...merged,
    responseStyle: normalizeResponseStyle(merged.responseStyle),
    defaultThinkingLevel: normalizeThinkingLevel(merged.defaultThinkingLevel),
    hideThinkingBlock: normalizeSettingsBool(merged.hideThinkingBlock, false),
    tabModeEnabled: normalizeSettingsBool(merged.tabModeEnabled, true),
    quietStartup: normalizeSettingsBool(merged.quietStartup, true),
    sendShortcut: merged.sendShortcut === 'ctrlEnter' ? 'ctrlEnter' : 'enter',
    enableSkillCommands: normalizeSettingsBool(
      merged.enableSkillCommands,
      true
    ),
    enableAnalytics: normalizeSettingsBool(merged.enableAnalytics, false),
    customRules: normalizeCustomRules(merged.customRules),
    defaultProvider: normalizeSettingsText(merged.defaultProvider),
    defaultModel: normalizeSettingsText(merged.defaultModel),
    theme: normalizeSettingsText(merged.theme) || 'default',
    sessionDir: normalizeSettingsText(merged.sessionDir ?? ''),
  };
}

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

function initSettingsDb(): void {
  if (!lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY)) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS));
  }
}

export function deepMergeSettings<
  T extends object,
  S extends object = Partial<T>,
>(target: T | null | undefined, source: S | null | undefined): T & S {
  if (!source) return (target ?? ({} as T)) as T & S;
  if (!target) return deepMergeSettings({} as T, source);
  const output: Record<string, unknown> = {
    ...(target as Record<string, unknown>),
  };
  for (const key of Object.keys(source as object)) {
    const srcVal = (source as Record<string, unknown>)[key];
    const tgtVal = output[key];
    if (Array.isArray(srcVal)) {
      output[key] = srcVal.slice();
    } else if (srcVal && typeof srcVal === 'object') {
      const base =
        tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
          ? (tgtVal as object)
          : {};
      output[key] = deepMergeSettings(base, srcVal as object);
    } else {
      output[key] = srcVal;
    }
  }
  return output as T & S;
}

const SETTINGS_LOCK_NAME = 'crish-settings-write';
const SETTINGS_LOCK_TIMEOUT_MS = 2_000;
let isWritingSettings = false;

async function withSettingsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return new Promise<T>((resolve, reject) => {
      navigator.locks.request(
        SETTINGS_LOCK_NAME,
        { mode: 'exclusive', ifAvailable: false },
        async (lock) => {
          if (!lock) {
            try {
              return resolve(await fn());
            } catch (e) {
              return reject(e);
            }
          }
          try {
            resolve(await fn());
          } catch (e) {
            reject(e);
          }
        }
      );
    });
  }
  const deadline = Date.now() + SETTINGS_LOCK_TIMEOUT_MS;
  while (isWritingSettings && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  isWritingSettings = true;
  try {
    return await fn();
  } finally {
    isWritingSettings = false;
  }
}

function projectSettingsKey(cwd: string): string {
  const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase();
  return `crish_project_settings_${normalizedCwd}`;
}

export const settingsApi = {
  getSettings: async (): Promise<Settings> => {
    let cwd = '';
    try {
      cwd = localStorage.getItem('crish_workspace') || '';
    } catch {
      cwd = '';
    }
    return settingsApi.getSettingsEx(cwd || '__global__');
  },

  updateSettings: async (updates: Partial<Settings>): Promise<Settings> => {
    return settingsApi.saveSettingsEx('__global__', 'global', updates);
  },

  getProjectSettingsPartial: async (
    cwd: string
  ): Promise<Partial<Settings>> => {
    initSettingsDb();
    if (!cwd || cwd === '__global__') return {};
    const projectSettingsStr = localStorage.getItem(projectSettingsKey(cwd));
    if (!projectSettingsStr) return {};
    const parsed = parseSettingsJson(projectSettingsStr);
    if (!parsed) return {};
    return normalizeSettingsPartial(parsed);
  },

  getSettingsEx: async (cwd: string): Promise<Settings> => {
    initSettingsDb();
    let globalSettings: Settings = getDefaultSettings();
    const raw = lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY);
    if (raw) {
      const parsed = parseSettingsJson(raw);
      if (parsed) {
        globalSettings = normalizeSettingsPayload(parsed);
      } else {
        try {
          const rawStr = typeof raw === 'string' ? raw : '';
          if (rawStr) {
            localStorage.setItem(
              `${SETTINGS_KEY}__corrupt_backup_${Date.now()}`,
              rawStr
            );
          }
          localStorage.setItem(
            SETTINGS_KEY,
            JSON.stringify(getDefaultSettings())
          );
        } catch {
          /* ignore */
        }
        globalSettings = getDefaultSettings();
      }
    }

    if (!cwd || cwd === '__global__') {
      return globalSettings;
    }

    const projectSettingsStr = localStorage.getItem(projectSettingsKey(cwd));
    if (!projectSettingsStr) {
      return globalSettings;
    }

    const projectPartial = parseSettingsJson(projectSettingsStr);
    if (!projectPartial) {
      return globalSettings;
    }
    return normalizeSettingsPayload(
      deepMergeSettings(
        globalSettings,
        normalizeSettingsPartial(projectPartial)
      )
    );
  },

  saveSettingsEx: async (
    cwd: string,
    scope: 'global' | 'project',
    updates: Partial<Settings>
  ): Promise<Settings> => {
    initSettingsDb();
    return withSettingsWriteLock(async () => {
      const safeUpdates = normalizeSettingsPartial(updates);

      if (scope === 'global') {
        let current: Settings = getDefaultSettings();
        const raw = lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY);
        if (raw) {
          const parsed = parseSettingsJson(raw);
          if (parsed) {
            current = normalizeSettingsPayload(parsed);
          }
        }
        const merged = normalizeSettingsPayload(
          deepMergeSettings(current, safeUpdates)
        );
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
        return merged;
      } else {
        const projKey = projectSettingsKey(cwd);
        const currentStr = localStorage.getItem(projKey);
        let current: Record<string, unknown> = {};
        const parsedProj = parseSettingsJson(currentStr);
        if (parsedProj) {
          current = { ...parsedProj } as Record<string, unknown>;
        }
        const merged = normalizeSettingsPartial(
          deepMergeSettings(current, safeUpdates)
        );
        localStorage.setItem(projKey, JSON.stringify(merged));

        let globalSettings: Settings = getDefaultSettings();
        const raw = lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY);
        if (raw) {
          const parsed = parseSettingsJson(raw);
          if (parsed) {
            globalSettings = normalizeSettingsPayload(parsed);
          }
        }
        return normalizeSettingsPayload(
          deepMergeSettings(globalSettings, merged)
        );
      }
    });
  },
};
