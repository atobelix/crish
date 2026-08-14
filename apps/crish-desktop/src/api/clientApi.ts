/**
 * clientApi — localStorage-backed client preferences.
 *
 * 正式路径（保留实现）：
 * - Settings：getSettings / updateSettings / getSettingsEx / saveSettingsEx
 *   → SettingsPanel / SettingsRulesTab / SkillsSettingsTab / App / ChatCard
 * - subscribeTelemetry：正式安静 no-op
 *
 * T03.7：cron / MCP demo 方法（getScheduledTasks / getMcpServers 等）显式不可用——
 * Rust 侧无 list-workflows / cron.* / list|start|stop-mcp-server 命令，直接返回空表。
 */

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
  /**
   * 思考档位偏好（本机设置；单源 = 描述接口，见 THINKING_LEVEL_IDS 移除说明）。
   *
   * 语义（G8-c / R4 T4.1「显式档位/默认档位区分」）：
   * - 缺省 / 'default' → 跟随引擎侧默认档位（描述接口 derived default_effort，省略不注入）；
   * - 其它字符串 → 尽量透传为显式档位，最终有效性由请求面校验
   *   （T4.1：白名单外显式档位在请求面拒绝，前端不代答）。
   *
   * 不再固化为固定档位集常量（消除前端自造档位表与 Rust 静态表双实现漂移）。
   */
  defaultThinkingLevel?: string;
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
  /** 是否允许在检测到异常退出时自动收集并发送诊断日志（默认开启，可关闭） */
  enableCrashTelemetry?: boolean;
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
  /** 回答风格（本机偏好；写入 appSettings，下游可订阅） */
  responseStyle?: ResponseStyle;
  /** 发送消息快捷键：enter | ctrlEnter */
  sendShortcut?: string;
  /** 自定义快捷键（键名 → 键值组合） */
  shortcuts?: Record<string, string>;
  /** 优先合并工具标签页（与 layoutStore.tabModeEnabled 双写） */
  tabModeEnabled?: boolean;
  /** 排队发送模式：AI 回复中时，新消息进入队列而不是直接插入对话 */
  queueMode?: boolean;
  /**
   * MCP 工具禁用表：serverId → toolName[]。
   * 写入本机设置；run-task 时下发给引擎，过滤不注入的 MCP 工具。
   */
  mcpDisabledTools?: Record<string, string[]>;
}

/** 回答风格四档（设置 · 个性化） */
export type ResponseStyle = 'minimal' | 'low' | 'medium' | 'high';

/** 语义档位段（透传）——不为档位面板数据源；描述接口白名单才是单源 */
export type ThinkingLevel = string;

export const RESPONSE_STYLE_IDS: readonly ResponseStyle[] = [
  'minimal',
  'low',
  'medium',
  'high',
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

/** 中文标签 → responseStyle（容错旧/手填配置） */
const RESPONSE_STYLE_LABEL_MAP: Readonly<Record<string, ResponseStyle>> = {
  简洁: 'minimal',
  标准: 'low',
  详细: 'medium',
  深入: 'high',
};

/**
 * Unicode-safe trim for settings strings（中文 / 全角空格 \u3000）。
 * 非 string/number/boolean → ''。
 */
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
    /* ignore environments without String.normalize */
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

/**
 * 规范档位透传（纯）。单源 = 描述接口（THINKING_LEVEL_IDS 已移除，front 不维护
 * 档位面板数据源）；本函数仅做设置持久化的合法值夹取与「提供方默认」归一：
 *
 * - 'default' / 空 / 非法 → 'default'（跟随引擎默认档位，不注入显式思考参数）；
 * - 其余字符串（含 'off' / 'minimal' / 'low' / 'medium' / 'high' / 'xhigh' 等
 *   引擎已知档位）→ 小写透传；最终请求面有效性由 T4.1 校验，此处不代答。
 */
export function normalizeThinkingLevel(raw: unknown): ThinkingLevel {
  if (typeof raw === 'string' || typeof raw === 'number') {
    const t = normalizeSettingsText(raw).toLowerCase();
    if (
      t === 'default' ||
      t === 'off' ||
      t === 'minimal' ||
      t === 'low' ||
      t === 'medium' ||
      t === 'high' ||
      t === 'xhigh'
    ) {
      return t;
    }
    // 未知字符串：不代答成固定默认（避免把自造档位表当真值），回落「提供方默认」
    return 'default';
  }
  return 'default';
}

/** Coerce loose LS / JSON values to boolean; unknown → fallback. */
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

/**
 * customRules：仅保留非空字符串（中文规则原文保留，仅 trim 首尾空白/全角空格）。
 * 非法类型 → []。
 */
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

/**
 * 安全解析 settings JSON。损坏 / 非对象 / 数组根 → null。
 */
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

/**
 * 仅规范化 partial patch 中出现的字段（项目 scope 覆写用，不补默认）。
 */
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
    // 默认合并标签：缺失/非法时 true
    out.tabModeEnabled = normalizeSettingsBool(o.tabModeEnabled, true);
  }
  if ('queueMode' in o) {
    out.queueMode = normalizeSettingsBool(o.queueMode, false);
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
  if ('enableCrashTelemetry' in o) {
    out.enableCrashTelemetry = normalizeSettingsBool(
      o.enableCrashTelemetry,
      true
    );
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
    const _uiFont =
      'uiFont' in f
        ? normalizeSettingsText(f.uiFont) || 'auto'
        : (o.fonts as Settings['fonts'])?.uiFont;
    const _monoFont =
      'monoFont' in f
        ? normalizeSettingsText(f.monoFont) || 'auto'
        : (o.fonts as Settings['fonts'])?.monoFont;
    const _monoLigatures =
      'monoLigatures' in f
        ? normalizeSettingsBool(f.monoLigatures, false)
        : (o.fonts as Settings['fonts'])?.monoLigatures;
    out.fonts = {
      ...(o.fonts as Settings['fonts']),
      ...(_uiFont !== undefined && { uiFont: _uiFont }),
      ...(_monoFont !== undefined && { monoFont: _monoFont }),
      ...(_monoLigatures !== undefined && { monoLigatures: _monoLigatures }),
    };
  }

  return out;
}

/** 深拷贝默认 settings（嵌套对象独立）。 */
export function getDefaultSettings(): Settings {
  return deepMergeSettings({}, DEFAULT_SETTINGS) as Settings;
}

/**
 * 以 DEFAULT 为底合并并规范化完整 settings 载荷。
 * 非对象 / 损坏输入 → 纯默认。
 */
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
  // 始终再夹一次关键枚举 / 布尔，避免 DEFAULT 缺键或 merge 漏网
  return {
    ...merged,
    responseStyle: normalizeResponseStyle(merged.responseStyle),
    defaultThinkingLevel: normalizeThinkingLevel(merged.defaultThinkingLevel),
    hideThinkingBlock: normalizeSettingsBool(merged.hideThinkingBlock, false),
    tabModeEnabled: normalizeSettingsBool(merged.tabModeEnabled, true),
    queueMode: normalizeSettingsBool(merged.queueMode, false),
    quietStartup: normalizeSettingsBool(merged.quietStartup, true),
    sendShortcut: merged.sendShortcut === 'ctrlEnter' ? 'ctrlEnter' : 'enter',
    enableSkillCommands: normalizeSettingsBool(
      merged.enableSkillCommands,
      true
    ),
    enableAnalytics: normalizeSettingsBool(merged.enableAnalytics, false),
    enableCrashTelemetry: normalizeSettingsBool(
      merged.enableCrashTelemetry,
      true
    ),
    customRules: normalizeCustomRules(merged.customRules),
    defaultProvider: normalizeSettingsText(merged.defaultProvider),
    defaultModel: normalizeSettingsText(merged.defaultModel),
    theme: normalizeSettingsText(merged.theme) || 'default',
    sessionDir: normalizeSettingsText(merged.sessionDir ?? ''),
  };
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

// LocalStorage Keys (settings only)
const SETTINGS_KEY = 'crish_settings';
const SETTINGS_KEY_LEGACY = 'conex_pi_settings';

const DEFAULT_SETTINGS: Settings = {
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

/** Recursive deep merge for settings-like plain objects (arrays replaced, nested objects cloned). */
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
      // Replace arrays wholesale (customRules etc.); shallow-copy to avoid aliasing
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

/**
 * 设置写入锁：优先用 Web Locks API（navigator.locks）实现真正的跨窗口互斥。
 * Tauri 多窗口各自有独立 JS 上下文，进程内变量不共享——
 * 旧实现两窗口同时 saveSettings 会产生 write-after-write 竞态。
 * navigator.locks 在同源所有 webview 间提供 OS 级互斥，是最干净的方案。
 * 降级：旧环境无 navigator.locks 时退化为进程内标志（仍有竞态，但至少单窗口顺序）。
 */
const SETTINGS_LOCK_NAME = 'crish-settings-write';
const SETTINGS_LOCK_TIMEOUT_MS = 2_000;

async function withSettingsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    // Web Locks API：跨窗口互斥，自动排队，finally 释放
    return new Promise<T>((resolve, reject) => {
      navigator.locks.request(
        SETTINGS_LOCK_NAME,
        { mode: 'exclusive', ifAvailable: false },
        async (lock) => {
          if (!lock) {
            // 未获取锁（不应发生在 ifAvailable:false 模式，但兜底）
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
  // 降级：进程内标志 + 超时
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

let isWritingSettings = false;

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

  /**
   * 仅读项目局部设置（不合并全局）。用于规则/技能等「按具体项目」编辑，
   * 避免 getSettingsEx 合并后把全局 customRules 误显示成项目规则。
   */
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
    // localStorage 是同步 API，无需人为延迟。
    // 旧实现的 20ms 延迟是「模拟异步 IO」遗留，会让设置页每次 tab 切换累计延迟。
    // 始终以 DEFAULT 为底再叠存储 + 字段规范化，避免旧 LS 缺键 / 脏枚举
    let globalSettings: Settings = getDefaultSettings();
    const raw = lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY);
    if (raw) {
      const parsed = parseSettingsJson(raw);
      if (parsed) {
        globalSettings = normalizeSettingsPayload(parsed);
      } else {
        // 损坏 / 非对象 JSON：先备份原值再回退默认，避免静默丢弃用户设置。
        // 旧实现直接覆盖，用户损坏的设置无任何恢复途径。
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

  // ── Telemetry：正式 no-op ───────────────────────

  subscribeTelemetry: (
    _onData: (data: import('../store/layoutStore').TelemetrySyncPayload) => void
  ): (() => void) => {
    return () => undefined;
  },

  // ── Providers — DEAD formal（providerProfiles） ──────────────
  // HONEST: 正式路径永不返回假「已支持 Anthropic/Gemini 原生」列表。
  // 真实配置轨 = providerProfiles + update-config；引擎仅 OpenAI-compatible。

  /** @deprecated DEAD formal — use providerProfiles. HONEST-HIDE: formal returns []. @see providerProfiles */
  getProviders: async (): Promise<ProviderInfo[]> => {
    return [];
  },

  /** @deprecated DEAD formal — use providerProfiles. HONEST-HIDE: formal returns []. @see providerProfiles */
  updateProviderKey: async (
    _id: string,
    _apiKey: string
  ): Promise<ProviderInfo[]> => {
    return [];
  },

  /** @deprecated DEAD formal — use providerProfiles. HONEST-HIDE: formal returns []. @see providerProfiles */
  updateProviderModels: async (
    _id: string,
    _models: string[]
  ): Promise<ProviderInfo[]> => {
    return [];
  },

  /** @deprecated DEAD formal — use providerProfiles / ModelsSettingsTab. HONEST-HIDE: formal returns []. @see providerProfiles */
  fetchLatestModels: async (_id: string): Promise<string[]> => {
    return [];
  },

  // ── Cron / MCP — 显式不可用（T03.7：Rust 侧无 cron.* / mcp daemon 命令）──

  /** @deprecated T03.7 显式不可用：Tauri 下无 cron 引擎，恒返回空表。@removeWhen Rust 侧落地 cron 引擎后移除 */
  getScheduledTasks: async (): Promise<CronJob[]> => {
    return [];
  },

  /** @deprecated T03.7 显式不可用：Tauri 下无 cron 引擎，恒返回空表。@removeWhen Rust 侧落地 cron 引擎后移除 */
  saveScheduledTask: async (_task: CronJob): Promise<CronJob[]> => {
    return [];
  },

  /** @deprecated T03.7 显式不可用：Tauri 下无 cron 引擎，恒返回空表。@removeWhen Rust 侧落地 cron 引擎后移除 */
  deleteScheduledTask: async (_id: string): Promise<CronJob[]> => {
    return [];
  },

  /** @deprecated T03.7 显式不可用：Rust 侧无 list-mcp-servers，恒返回空表。@removeWhen Rust 侧落地 mcp 命令后移除 */
  getMcpServers: async (): Promise<McpServer[]> => {
    return [];
  },

  /** @deprecated T03.7 显式不可用：Rust 侧无 start-mcp-server，恒返回空表。@removeWhen Rust 侧落地 mcp 命令后移除 */
  saveMcpServer: async (_server: McpServer): Promise<McpServer[]> => {
    return [];
  },

  /** @deprecated T03.7 显式不可用：Rust 侧无 stop-mcp-server，恒返回空表。@removeWhen Rust 侧落地 mcp 命令后移除 */
  deleteMcpServer: async (_id: string): Promise<McpServer[]> => {
    return [];
  },
};
