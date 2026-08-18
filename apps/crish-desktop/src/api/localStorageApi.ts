/**
 * 统一 localStorage 访问层（维度 2 收敛产物）。
 *
 * 职责边界（反过度设计约束）：
 *   - key 注册表：集中登记所有 localStorage key 的归属与生命周期标注
 *   - safe* 守卫：统一 try/catch + JSON 序列化/反序列化守卫，消除散落的 try/catch 样板
 *   - migrateLegacyKeys：遗留 key 迁移钩子（仅框架，不做自动迁移流水线）
 *
 * 不做的事：
 *   - 不引入 schema 版本管理 / 自动迁移流水线 / 加密层
 *   - 不替换 zustand persist 的内部存储（persist 自行管理其 JSON 封装）
 *   - 不强制所有 localStorage 调用经本层（渐进收敛，存量调用不阻断）
 */

// ── key 注册表 ──────────────────────────────────────────────────────────────

/** key 生命周期类型 */
export type StorageKeyType =
  | 'persist' // zustand persist 持久化面
  | 'standalone' // 独立 key（theme/fonts 等）
  | 'index' // 会话索引
  | 'legacy'; // 遗留/废弃 key

/** key 注册条目 */
export interface RegisteredKey {
  /** 归属模块 */
  owner: string;
  /** 生命周期类型 */
  type: StorageKeyType;
  /** 是否已废弃（只读回退 / 已无写入方） */
  deprecated?: boolean;
  /** 计划删除日期（YYYY-MM-DD） */
  removeDate?: string;
}

/**
 * localStorage key 注册表。
 * 新增 key 时在此登记，保持全局可见性。
 */
export const registeredKeys: Readonly<Record<string, RegisteredKey>> = {
  // zustand persist 持久化面（唯一持久化路径）
  'crish-layout-v1': {
    owner: 'layoutStore',
    type: 'persist',
  },
  'crish_session_store_v1': {
    owner: 'sessionStore',
    type: 'persist',
  },

  // 独立 key（theme/fonts 唯一写面）
  crish_theme: {
    owner: 'themeStore',
    type: 'standalone',
  },
  crish_fonts: {
    owner: 'fontStore',
    type: 'standalone',
  },

  // 遗留/废弃 key（只读回退，不再有写入方）
  crish_settings: {
    owner: 'themeStore/fontStore (历史合并写入面)',
    type: 'legacy',
    deprecated: true,
    removeDate: '2027-01-01',
  },
  conex_pi_settings: {
    owner: 'legacy (conex_pi → crish 迁移前键名)',
    type: 'legacy',
    deprecated: true,
    removeDate: '2027-01-01',
  },
};

// ── safe* 守卫 ──────────────────────────────────────────────────────────────

/**
 * 安全读取 localStorage 值（原始字符串）。
 * 统一 try/catch：隐私模式 / quota 异常 / SSR 环境返回 null 而非抛错。
 */
export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * 安全写入 localStorage 值（原始字符串）。
 * 统一 try/catch：quota 超限 / 隐私模式静默失败，不阻断主流程。
 */
export function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* swallow-ok: quota/隐私模式写失败回退内存态 */
  }
}

/**
 * 安全删除 localStorage key。
 * 统一 try/catch。
 */
export function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* swallow-ok: 删除失败残留无害键 */
  }
}

// ── JSON 守卫变体 ────────────────────────────────────────────────────────────

/**
 * 安全读取并 JSON.parse localStorage 值。
 * 解析失败或键不存在时返回 fallback。
 */
export function safeGetJson<T>(key: string, fallback: T): T {
  const raw = safeGetItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * 安全 JSON.stringify 并写入 localStorage。
 */
export function safeSetJson(key: string, value: unknown): void {
  try {
    safeSetItem(key, JSON.stringify(value));
  } catch {
    /* swallow-ok: 序列化或写入失败静默处理 */
  }
}

// ── 遗留 key 迁移钩子 ────────────────────────────────────────────────────────

/**
 * 遗留 key 迁移钩子。
 *
 * 当前仅提供框架，不执行自动迁移：
 *   - conex_pi_settings → crish_settings：读取方已在 readStoredTheme/readStoredFonts
 *     中做了双键回退读取，无需在此复制数据
 *   - crish_settings 中的 theme/fonts 字段：读取方已做只读回退（@deprecated 2027-01-01）
 *
 * 如未来需要主动迁移（如键名变更 + 数据格式不兼容），在此函数内追加迁移逻辑。
 * 迁移应幂等：已迁移的 key 不重复处理。
 *
 * @returns 迁移的 key 数量（当前始终为 0，框架预留）
 */
export function migrateLegacyKeys(): number {
  // 当前无主动迁移需求：所有遗留键的读取方已做兼容回退。
  // 新增迁移逻辑时在此追加，保持幂等。
  return 0;
}
