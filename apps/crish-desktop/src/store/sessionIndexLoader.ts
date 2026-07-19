export async function loadSessionIndexOnly(): Promise<void> {
  const { restoreSessionsFromDiskMirror } = await import('../api/sessionDiskMirror');
  const restored = await restoreSessionsFromDiskMirror();
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
