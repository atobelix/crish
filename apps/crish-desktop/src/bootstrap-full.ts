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
      const { fetchCatalogSnapshot } = await import('./api/modelCatalogIpc');
      await fetchCatalogSnapshot();
      const { fetchDescribeEffortsSnapshot } =
        await import('./api/thinkingGear');
      await fetchDescribeEffortsSnapshot();
    })(),

    // 3. yaml 镜像水合（plans/03 §3.5 / §3.6#15）：主界面不打开设置也能列出 yaml 模型
    (async () => {
      const { ensureModelsCatalogLoaded } =
        await import('./api/modelsCatalogStore');
      await ensureModelsCatalogLoaded().catch(() => {
        /* 失败：store 空树 + lastError + catalog-changed；Picker 空列表，不得回落 LS 种子。 */
      });

      // 3b. 退役价表 `crish_model_prices_v1` 一次性迁移（价格轨收敛，见
      //     docs/provider-single-track-convergence/05-…§4 期 2）。
      //     必须在树加载**之后**：迁移需要按二元组身份解析「唯一持有者」；
      //     树未加载时该函数自身返回 skipped 且不动 LS（幂等，可重复调用）。
      //     放在启动期而非仅价格页挂载——否则用户不开该页面时旧价永不迁移，
      //     价格页会把用户的既有单价呈现成「字典预估」（等同丢价）。
      try {
        const { migrateLegacyLsPrices } =
          await import('./api/modelPricingSource');
        await migrateLegacyLsPrices();
      } catch (e) {
        // 迁移失败不阻塞启动：原 LS 键保持不动，由价格页挂载时重试并显式提示
        console.warn('[pricing] 旧价表迁移失败（原值已保留）：', e);
      }
    })(),

    // 4. OAuth token 调度器（自 bootstrap-core 闲时迁移；Stage 3 首屏不拉起）
    (async () => {
      const { initOAuthTokenScheduler } =
        await import('./api/oauthTokenManager');
      initOAuthTokenScheduler();
    })(),
  ]);

  // ACT-604：删除无条件 scaleUpPool()——冷启维持 MINIMAL（lazyInit 1 render）；
  // 任务积压由 WorkerPool.maybeJitSpawn / markFirstScreenRendered 按需扩容，
  // 排空后 idleMonitor 收缩，杜绝启动期盲目 scaleUp。

  window.__crish_perf = {
    ...window.__crish_perf,
    fullReady: performance.now(),
  };
  void import('./services/startup/startupMetrics').then((m) =>
    m.markStartupPhase('bootstrapFullDone')
  );
  console.debug(`[perf] bootstrapFull: ${performance.now() - start}ms`);
}
