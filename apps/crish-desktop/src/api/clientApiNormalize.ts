import type { ResponseStyle, Settings, ThinkingLevel } from './clientApi.types';

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

// 默认 settings 常量拆至 clientApiDefaultSettings（纯数据子文件）
import { DEFAULT_SETTINGS } from './clientApiDefaultSettings';
export { DEFAULT_SETTINGS };

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
  return {
    ...merged,
    responseStyle: normalizeResponseStyle(merged.responseStyle),
    defaultThinkingLevel: normalizeThinkingLevel(merged.defaultThinkingLevel),
    hideThinkingBlock: normalizeSettingsBool(merged.hideThinkingBlock, false),
    tabModeEnabled: normalizeSettingsBool(merged.tabModeEnabled, true),
    queueMode: normalizeSettingsBool(merged.queueMode, false),
    quietStartup: normalizeSettingsBool(merged.quietStartup, true),
    enableSkillCommands: normalizeSettingsBool(
      merged.enableSkillCommands,
      true
    ),
    enableAnalytics: normalizeSettingsBool(merged.enableAnalytics, false),
    enableCrashTelemetry: normalizeSettingsBool(
      merged.enableCrashTelemetry,
      true
    ),
    collapseChangelog: normalizeSettingsBool(merged.collapseChangelog, false),
    enableInstallTelemetry: normalizeSettingsBool(
      merged.enableInstallTelemetry,
      false
    ),
    customRules: normalizeCustomRules(merged.customRules),
    defaultProvider: normalizeSettingsText(merged.defaultProvider),
    defaultModel: normalizeSettingsText(merged.defaultModel),
    theme: normalizeSettingsText(merged.theme) || 'default',
    sessionDir: normalizeSettingsText(merged.sessionDir ?? ''),
  };
}
