/**
 * 按需补全会话索引（Stream D 改造后）。
 *
 * 原职责：从磁盘镜像回灌 store 缺失的会话。
 * Stream D 后：磁盘镜像已删除，改用 SQLite（hydrateSessionsFromRust）回灌。
 *
 * 触发场景：用户切回主界面时，若 store 中会话为空（如刚启动未完成 hydrate），
 * 此函数从 SQLite 拉取会话补全 store。正常启动时由 store-persistence 的
 * ensureMigrated + hydrateSessionsFromRust 已完成回灌，此函数为补保险。
 */
export async function loadSessionIndexOnly(): Promise<void> {
  const { hydrateSessionsFromRust } = await import('../api/sessionPersistence');
  const restored = await hydrateSessionsFromRust();
  if (!restored?.sessions?.length) return;

  const { useLayoutStore } = await import('../store/layoutStore');

  // 只填充尚未存在于 store 的会话（完整 SessionState），不覆盖已有数据
  useLayoutStore.setState((state) => {
    for (const session of restored.sessions) {
      if (!state.sessionsById[session.id]) {
        state.sessions.push(session);
      }
    }
  });
}
