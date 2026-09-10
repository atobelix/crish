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

    // 2. 运行时模型目录快照（DEEPCHECK-02 P0：catalog_get 接线；Rust 目录真源
    //    → 前端四指标定价 + 思考档位单源（T5.2b 描述接口 offered）；invoke 失败
    //    内部降级静态表 / 提供方默认，恒不抛）
    // 本维可不删；生产思考 UI 不得等它们、不得读它们（独立分支，不挡 yaml 水合）
    (async () => {
      const { fetchCatalogSnapshot } = await import('./api/modelCatalog');
      await fetchCatalogSnapshot();
      const { fetchDescribeEffortsSnapshot } =
        await import('./api/thinkingGear');
      await fetchDescribeEffortsSnapshot();
    })(),

    // 3. yaml 镜像水合（plans/03 §3.5 / §3.6#15）：主界面不打开设置也能列出 yaml 模型
    (async () => {
      const { ensureModelsCatalogLoaded } = await import(
        './api/modelsCatalogStore'
      );
      await ensureModelsCatalogLoaded().catch(() => {
        /* 失败：store 空树 + lastError + catalog-changed；Picker 空列表，不得回落 LS 种子。 */
      });
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
