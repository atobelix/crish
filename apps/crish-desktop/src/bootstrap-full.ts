export async function bootstrapFull(): Promise<void> {
  const start = performance.now();

  await Promise.all([
    // 1. 核心就绪探测（C3.5：transport「核心已初始化」语义；WS 回退路径内部含 keep-alive）
    (async () => {
      const { ensureEngineConnected } = await import('./api/chatBridge');
      await ensureEngineConnected().catch(() => {
        /* swallow-ok: 核心连接失败不阻塞 bootstrap；失败语义由连接状态面
           （errorStore.connectionStatus / 重连逻辑）接管，此处只放行首屏 */
      });
    })(),

    // 2. 同步引擎配置
    (async () => {
      const { clientApi } = await import('./api/clientApi');
      try {
        const settings = await clientApi.getSettings();
        if (settings?.theme) {
          const { applyTheme, normalizeTheme } =
            await import('./api/themeStore');
          applyTheme(normalizeTheme(settings.theme));
        }
      } catch {
        /* 主题读取失败时保持默认主题 */
      }
    })(),

    // 3. 运行时模型目录快照（DEEPCHECK-02 P0：catalog_get 接线；Rust 目录真源
    //    → 前端四指标定价 + 思考档位单源（T5.2b 描述接口 offered）；invoke 失败
    //    内部降级静态表 / 提供方默认，恒不抛）
    (async () => {
      const { fetchCatalogSnapshot } = await import('./api/modelCatalog');
      await fetchCatalogSnapshot();
      const { fetchDescribeEffortsSnapshot } =
        await import('./api/thinkingGear');
      await fetchDescribeEffortsSnapshot();
    })(),
  ]);

  // 扩容 Worker 池至完整数量
  const { scaleUpPool } = await import('./workers/index');
  scaleUpPool();

  window.__crish_perf = {
    ...window.__crish_perf,
    fullReady: performance.now(),
  };
  console.debug(`[perf] bootstrapFull: ${performance.now() - start}ms`);
}
