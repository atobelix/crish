export async function bootstrapFull(): Promise<void> {
  const start = performance.now();

  await Promise.all([
    // 1. 后台连接 daemon WebSocket
    (async () => {
      const { ensureDaemonConnected } = await import('./api/daemonChatBridge');
      await ensureDaemonConnected().catch(() => {});
    })(),

    // 2. 同步引擎配置
    (async () => {
      const { clientApi } = await import('./api/clientApi');
      try {
        const settings = await clientApi.getSettings();
        if (settings?.theme) {
          const { applyTheme, normalizeTheme } = await import('./api/themeStore');
          applyTheme(normalizeTheme(settings.theme));
        }
      } catch {}
    })(),

    // 3. 会话元数据加载（不加载消息正文）
    (async () => {
      const { loadSessionIndexOnly } = await import('./store/sessionIndexLoader');
      await loadSessionIndexOnly();
    })(),
  ]);

  // 扩容 Worker 池至完整数量
  const { scaleUpPool } = await import('./workers/index');
  scaleUpPool();

  window.__crish_perf = { ...window.__crish_perf, fullReady: performance.now() };
  console.debug(`[perf] bootstrapFull: ${performance.now() - start}ms`);
}
