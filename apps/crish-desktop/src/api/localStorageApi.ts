/**
 * 统一 localStorage 访问层（维度 2 收敛产物）。
 *
 * 职责边界（反过度设计约束）：
 *   - key 注册表：集中登记所有 localStorage key 的归属与生命周期标注
 *   - safe* 守卫：统一 try/catch + JSON 序列化/反序列化守卫，消除散落的 try/catch 样板
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
  | 'cache' // 运行期临时缓存（workflows, mcp, skills, font scan 等）
  | 'draft' // 应急草稿暂存
  | 'state' // 运行期非偏好本地状态（向导标记、插件启停等）
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
  crish_session_store_v1: {
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

  // 运行期临时缓存与非偏好状态（收敛至 runtimeCache）
  crish_local_fonts_cache_v1: {
    owner: 'runtimeCache/fontStoreScan',
    type: 'cache',
  },
  crish_workflows_cache_v1: {
    owner: 'runtimeCache/workflowsSharedLib',
    type: 'cache',
  },
  crish_workflow_runs_cache_v1: {
    owner: 'runtimeCache/workflowsSharedLib',
    type: 'cache',
  },
  crish_mcp_servers_cache_v1: {
    owner: 'runtimeCache/useMcpCache',
    type: 'cache',
  },
  crish_skills_cache_v1: {
    owner: 'runtimeCache/useSkillsCache',
    type: 'cache',
  },
  crish_first_run_done_v1: {
    owner: 'runtimeCache/firstRunWizard',
    type: 'state',
  },
  crish_plugin_enabled_v1: {
    owner: 'runtimeCache/pluginRegistryAdapter',
    type: 'state',
  },
  crish_skill_known_ids_v1: {
    owner: 'runtimeCache/useSkillList',
    type: 'state',
  },
  crish_sidebar_sections_v1: {
    owner: 'runtimeCache/sidebarSections',
    type: 'state',
  },
  crish_sidebar_list_prefs: {
    owner: 'runtimeCache/sidebarListPrefs',
    type: 'state',
  },
  crish_custom_plugins_v1: {
    owner: 'extensions-surface/customPluginStorage',
    type: 'state',
  },
  crish_auto_sync_external_sessions: {
    owner: 'api/import/importRootSettings',
    type: 'state',
  },
  crish_closed_session_tabs_v1: {
    owner: 'workspace-shell/closedSessionTabs',
    type: 'state',
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
