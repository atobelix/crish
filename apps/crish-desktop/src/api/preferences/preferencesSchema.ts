/**
 * 偏好字段唯一权威 Schema（SSOT N6）
 *
 * 契约规范（对齐 docs/design-token-ssot/00-总方案 §6.3 N6）：
 * - 定义全仓偏好字段的唯一权威真源（键名、类型约束、合法值定义、默认值）；
 * - 默认值严格来自设计规范与 Token 契约，禁止散落裸值；
 * - 负向守门：未知 key 强拒绝（而非静默忽略）、值类型不符强拒绝（而非静默回落默认值）。
 */

export interface FontPreferencesValue {
  uiFont: string;
  monoFont: string;
  monoLigatures: boolean;
  v: number;
}

export interface PreferencesMap {
  theme: 'default' | 'dark' | 'light' | 'oled' | 'sepia' | 'cyberpunk' | 'nord';
  theme_skin: string;
  theme_custom_bg: string;
  theme_custom_fg: string;
  font_size_adjust: number;
  theme_brightness_adjust: number;
  theme_brightness_vibrant: boolean;
  theme_brightness_auto_time: boolean;
  ui_size: 'compact' | 'normal' | 'spacious';
  shell_chrome_mode: 'frameless' | 'native' | 'bordered';
  sidebar_collapsed: boolean;
  sidebar_width: number;
  tab_mode_enabled: boolean;
  files_list_ratio: number;
  file_viewer_word_wrap: boolean;
  fonts: FontPreferencesValue;
  app_mode: 'developer' | 'minimal' | 'architect' | 'normal' | 'demo';
  product_shell: boolean;
  show_engine_settings: boolean;
}

export type PreferenceKey = keyof PreferencesMap;

export interface PreferenceSchemaEntry<K extends PreferenceKey = PreferenceKey> {
  key: K;
  type: 'string' | 'number' | 'boolean' | 'object';
  defaultValue: PreferencesMap[K];
  allowedValues?: readonly PreferencesMap[K][];
  validate?: (val: unknown) => boolean;
  description: string;
}

/**
 * 历史键名与旧版孤岛键名兼容映射（归一至权威键名）
 */
export const PREFERENCE_KEY_ALIASES: Readonly<Record<string, PreferenceKey>> = {
  crish_theme: 'theme',
  crish_theme_skin: 'theme_skin',
  crish_theme_custom_bg: 'theme_custom_bg',
  crish_theme_custom_fg: 'theme_custom_fg',
  crish_font_size_adjust: 'font_size_adjust',
  crish_theme_brightness_adjust: 'theme_brightness_adjust',
  crish_theme_brightness_vibrant: 'theme_brightness_vibrant',
  crish_theme_brightness_auto_time: 'theme_brightness_auto_time',
  crish_fonts: 'fonts',
  crish_sidebar_width: 'sidebar_width',
  'crish:files-list-ratio': 'files_list_ratio',
  'crish:file-viewer-word-wrap': 'file_viewer_word_wrap',
  crish_app_mode: 'app_mode',
  crish_product_shell: 'product_shell',
  crish_show_engine_settings: 'show_engine_settings',
};

/**
 * 偏好唯一权威定义字典
 */
export const PREFERENCES_SCHEMA: {
  readonly [K in PreferenceKey]: PreferenceSchemaEntry<K>;
} = {
  theme: {
    key: 'theme',
    type: 'string',
    defaultValue: 'default',
    allowedValues: ['default', 'dark', 'light', 'oled', 'sepia', 'cyberpunk', 'nord'] as const,
    description: '界面外观主色彩模式',
  },
  theme_skin: {
    key: 'theme_skin',
    type: 'string',
    defaultValue: 'warm-gray',
    description: '皮肤色板预设标识符',
  },
  theme_custom_bg: {
    key: 'theme_custom_bg',
    type: 'string',
    defaultValue: '',
    description: '用户自定义背景色值',
  },
  theme_custom_fg: {
    key: 'theme_custom_fg',
    type: 'string',
    defaultValue: '',
    description: '用户自定义前景色值',
  },
  font_size_adjust: {
    key: 'font_size_adjust',
    type: 'number',
    defaultValue: 0,
    validate: (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= -10 && v <= 20,
    description: '界面字体大小微调步长（px）',
  },
  theme_brightness_adjust: {
    key: 'theme_brightness_adjust',
    type: 'number',
    defaultValue: 0,
    validate: (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= -100 && v <= 100,
    description: '界面全局亮度增益',
  },
  theme_brightness_vibrant: {
    key: 'theme_brightness_vibrant',
    type: 'boolean',
    defaultValue: false,
    description: '是否启用色度与鲜艳度增强',
  },
  theme_brightness_auto_time: {
    key: 'theme_brightness_auto_time',
    type: 'boolean',
    defaultValue: false,
    description: '是否启用随日落时间平滑自动微调',
  },
  ui_size: {
    key: 'ui_size',
    type: 'string',
    defaultValue: 'normal',
    allowedValues: ['compact', 'normal', 'spacious'] as const,
    description: '界面紧凑度与排版尺寸',
  },
  shell_chrome_mode: {
    key: 'shell_chrome_mode',
    type: 'string',
    defaultValue: 'frameless',
    allowedValues: ['frameless', 'native', 'bordered'] as const,
    description: '桌面壳层边框与标题栏风格',
  },
  sidebar_collapsed: {
    key: 'sidebar_collapsed',
    type: 'boolean',
    defaultValue: false,
    description: '主侧边栏折叠状态',
  },
  sidebar_width: {
    key: 'sidebar_width',
    type: 'number',
    defaultValue: 260,
    validate: (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 160 && v <= 800,
    description: '主侧边栏展开宽度（px）',
  },
  tab_mode_enabled: {
    key: 'tab_mode_enabled',
    type: 'boolean',
    defaultValue: false,
    description: '多标签栏开启状态',
  },
  files_list_ratio: {
    key: 'files_list_ratio',
    type: 'number',
    defaultValue: 0.35,
    validate: (v: unknown) =>
      typeof v === 'number' &&
      Number.isFinite(v) &&
      ((v >= 0.05 && v <= 0.95) || (v >= 5 && v <= 95)),
    description: '文件列表与文件内容分栏比例',
  },
  file_viewer_word_wrap: {
    key: 'file_viewer_word_wrap',
    type: 'boolean',
    defaultValue: true,
    description: '文件预览区自动换行开关',
  },
  fonts: {
    key: 'fonts',
    type: 'object',
    defaultValue: {
      uiFont: 'auto',
      monoFont: 'auto',
      monoLigatures: false,
      v: 1,
    },
    validate: (v: unknown) => {
      if (typeof v !== 'object' || v === null) return false;
      const f = v as Record<string, unknown>;
      return (
        typeof f.uiFont === 'string' &&
        typeof f.monoFont === 'string' &&
        typeof f.monoLigatures === 'boolean'
      );
    },
    description: '全局字体栈配置项',
  },
  app_mode: {
    key: 'app_mode',
    type: 'string',
    defaultValue: 'developer',
    allowedValues: ['developer', 'minimal', 'architect', 'normal', 'demo'] as const,
    description: '工作台产品工作模式',
  },
  product_shell: {
    key: 'product_shell',
    type: 'boolean',
    defaultValue: false,
    description: '是否强制运行于产品桌面壳模式',
  },
  show_engine_settings: {
    key: 'show_engine_settings',
    type: 'boolean',
    defaultValue: false,
    description: '是否在产品模式下显示开发者引擎设置',
  },
};

/**
 * 判断键名是否为已知偏好键（含别名）
 */
export function isKnownPreferenceKey(key: string): key is PreferenceKey {
  return (
    Object.prototype.hasOwnProperty.call(PREFERENCES_SCHEMA, key) ||
    Object.prototype.hasOwnProperty.call(PREFERENCE_KEY_ALIASES, key)
  );
}

/**
 * 规范化偏好键（解析别名至权威键，未知 key 抛错）
 */
export function normalizePreferenceKey(key: string): PreferenceKey {
  if (Object.prototype.hasOwnProperty.call(PREFERENCES_SCHEMA, key)) {
    return key as PreferenceKey;
  }
  const alias = PREFERENCE_KEY_ALIASES[key];
  if (alias !== undefined) {
    return alias;
  }
  throw new Error(`Unknown preference key: "${key}"`);
}

/**
 * 强校验给定偏好键与其值（未知 key 拒绝、类型不符拒绝、枚举非法拒绝）
 */
export function validatePreferenceValue<K extends PreferenceKey>(
  key: K,
  val: unknown
): asserts val is PreferencesMap[K] {
  if (!Object.prototype.hasOwnProperty.call(PREFERENCES_SCHEMA, key)) {
    throw new Error(`Unknown preference key: "${String(key)}"`);
  }

  const schema = PREFERENCES_SCHEMA[key];

  // 1. 类型约束校验
  if (schema.type === 'object') {
    if (typeof val !== 'object' || val === null || Array.isArray(val)) {
      throw new Error(
        `Invalid value for preference "${key}": expected object, got ${Array.isArray(val) ? 'array' : typeof val}`
      );
    }
  } else if (typeof val !== schema.type) {
    throw new Error(
      `Invalid value for preference "${key}": expected ${schema.type}, got ${typeof val}`
    );
  }

  // 2. 枚举白名单校验
  if (schema.allowedValues && !schema.allowedValues.includes(val as any)) {
    throw new Error(
      `Invalid value for preference "${key}": expected one of ${JSON.stringify(schema.allowedValues)}, got ${JSON.stringify(val)}`
    );
  }

  // 3. 自定义范围校验
  if (schema.validate && !schema.validate(val)) {
    throw new Error(
      `Invalid value for preference "${key}": validation failed for ${JSON.stringify(val)}`
    );
  }
}

/**
 * 获取全量默认偏好对象快照
 */
export function getDefaultPreferences(): PreferencesMap {
  const defaults: Record<string, unknown> = {};
  for (const key of Object.keys(PREFERENCES_SCHEMA) as PreferenceKey[]) {
    defaults[key] = PREFERENCES_SCHEMA[key].defaultValue;
  }
  return defaults as unknown as PreferencesMap;
}
