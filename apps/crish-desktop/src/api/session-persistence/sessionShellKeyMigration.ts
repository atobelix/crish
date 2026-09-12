/**
 * sessionStore persist 壳键一次性迁移（U-PERSIST-A · D4 票 A）。
 *
 * 职责（零兼容读，非 onRehydrateStorage 回灌）：
 *   - 旧 `crish_session_store` 若仍含 `sessions[]`（含全量 messages），
 *     在 create 前剥离为轻量 meta 壳 `{activeSessionId,folderOrder,composerDrafts}`；
 *   - 迁移失败（JSON 损坏等）→ removeItem，不阻塞 boot；
 *   - **禁止**把剥离出的 sessions/messages 回灌 store——正文唯一来源 = SQLite hydrate。
 *
 * 迁移后生产路径对该键 sessions 字段 0 读 0 写（由 check-store-islands 门禁守护）。
 */

export const SESSION_STORE_PERSIST_KEY = 'crish_session_store';

/**
 * 将旧 persist 键从「全量 sessions 镜像」降为「轻量 meta 壳」。
 * 幂等：键已无 sessions 字段时 no-op。
 * 在 useSessionStore create 之前同步调用一次（启动窗口）。
 */
export function migrateSessionStoreShellKey(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SESSION_STORE_PERSIST_KEY);
  } catch {
    return; // localStorage 不可用 → 无事可做
  }
  if (!raw) return;

  // 损坏 JSON → removeItem（A-2：迁移失败不阻塞 boot，下次 persist 写轻量壳）
  let parsed: { state?: Record<string, unknown>; version?: number } | null;
  try {
    parsed = JSON.parse(raw) as {
      state?: Record<string, unknown>;
      version?: number;
    };
  } catch {
    try {
      localStorage.removeItem(SESSION_STORE_PERSIST_KEY);
    } catch {
      /* swallow-ok */
    }
    return;
  }
  const state = parsed?.state;

  // 无 sessions 字段 → 已是壳或非本键形状 → no-op
  if (!state || typeof state !== 'object' || !('sessions' in state)) return;

  // 剥离：只保留合法 meta 三元组；绝不读取/回灌 sessions 内容
  const nextShell = {
    state: {
      activeSessionId:
        typeof state.activeSessionId === 'string' ? state.activeSessionId : '',
      folderOrder: Array.isArray(state.folderOrder)
        ? state.folderOrder
        : [],
      composerDrafts:
        state.composerDrafts && typeof state.composerDrafts === 'object'
          ? state.composerDrafts
          : {},
    },
    version: typeof parsed?.version === 'number' ? parsed.version : 1,
  };

  try {
    localStorage.setItem(
      SESSION_STORE_PERSIST_KEY,
      JSON.stringify(nextShell)
    );
  } catch {
    // 写壳失败（quota 等）→ 直接 remove，下次 persist 会再写轻量壳
    try {
      localStorage.removeItem(SESSION_STORE_PERSIST_KEY);
    } catch {
      /* swallow-ok: 环境不允许写 LS，boot 不阻塞 */
    }
  }
}

/**
 * 迁移入口（损坏 JSON 也 removeItem）。
 * migrateSessionStoreShellKey 已处理损坏路径；本别名保留给测试与 boot 编排。
 */
export function ensureSessionStoreShellKeyMigrated(): void {
  try {
    migrateSessionStoreShellKey();
  } catch {
    try {
      localStorage.removeItem(SESSION_STORE_PERSIST_KEY);
    } catch {
      /* swallow-ok */
    }
  }
}
