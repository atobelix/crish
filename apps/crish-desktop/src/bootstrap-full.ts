export async function bootstrapFull(): Promise<void> {
  const start = performance.now();

  await Promise.all([
    // 1. 核心就绪探测（C3.5：transport「核心已初始化」语义；WS 回退路径内部含 keep-alive）
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
  ]);

  // 扩容 Worker 池至完整数量
  const { scaleUpPool } = await import('./workers/index');
  scaleUpPool();

  window.__crish_perf = { ...window.__crish_perf, fullReady: performance.now() };
  console.debug(`[perf] bootstrapFull: ${performance.now() - start}ms`);
}
