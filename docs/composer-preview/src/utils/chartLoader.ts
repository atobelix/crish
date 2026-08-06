/**
 * chartLoader — ECharts 的按需加载
 *
 * 只注册实际用到的图表类型与组件（tree-shaking 友好），
 * 完整引入 echarts 会带进来 1MB 以上的地图/3D 模块。
 */

let chartsPromise: Promise<typeof import('echarts/core')> | null = null;

/** 加载 ECharts 核心并注册所需模块，重复调用复用同一个 Promise */
export async function loadECharts() {
  if (!chartsPromise) {
    chartsPromise = (async () => {
      const [core, charts, components, renderers] = await Promise.all([
        import('echarts/core'),
        import('echarts/charts'),
        import('echarts/components'),
        import('echarts/renderers'),
      ]);

      core.use([
        charts.BarChart,
        charts.LineChart,
        charts.PieChart,
        charts.ScatterChart,
        components.GridComponent,
        components.TooltipComponent,
        components.LegendComponent,
        components.TitleComponent,
        components.DatasetComponent,
        renderers.CanvasRenderer,
      ]);

      return core;
    })();
  }
  return chartsPromise;
}

/** 预热：空闲时提前加载 */
export function prefetchECharts(): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => void loadECharts(), { timeout: 4000 });
  }
}
