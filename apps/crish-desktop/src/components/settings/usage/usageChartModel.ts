/**
 * 用量趋势图表模型与多维系列构建纯逻辑库（Usage Chart Model）
 * 将多维（吞吐总览、模型对比、费用走势）数据计算与 UI 渲染解耦。
 */

import type {
  UsageModelBreakdownItem,
  UsageTimeseriesPoint,
} from '../../../api/usageContracts';
import {
  formatCost,
  formatTokens,
  getAreaSplinePath,
  getModelColor,
  getMonotoneSplinePath,
  type SplinePoint,
} from './usageSpline';

export interface ChartSeriesConfig {
  id: string;
  name: string;
  color: string;
  width: number;
  style: 'solid' | 'dashed';
  dasharray?: string;
  isTotal?: boolean;
  hasArea?: boolean;
  data: number[];
}

export interface ComputedChartSeries extends ChartSeriesConfig {
  points: SplinePoint[];
  lineD: string;
  areaD: string;
}

export interface ChartModelOutput {
  seriesList: ChartSeriesConfig[];
  yTicks: [string, string, string, string];
  yMax: number;
  formatVal: (v: number) => string;
}

export function buildChartSeriesConfig(
  dimension: 'overview' | 'models' | 'cost',
  points: UsageTimeseriesPoint[],
  maxTokens: number,
  maxCost: number,
  models: UsageModelBreakdownItem[]
): ChartModelOutput {
  if (points.length === 0) {
    return {
      seriesList: [],
      yTicks: ['0', '0', '0', '0'],
      yMax: 0,
      formatVal: formatTokens,
    };
  }

  if (dimension === 'cost') {
    const computedYMax = maxCost > 0 ? maxCost * 1.15 : 0;
    const totalCostPoints = points.map((p) => p.cost);

    const series: ChartSeriesConfig[] = [
      {
        id: 'totalCost',
        name: '预估总费用',
        color: 'var(--usage-color-cost-total)',
        width: 1.8,
        style: 'solid',
        isTotal: true,
        hasArea: true,
        data: totalCostPoints,
      },
    ];

    const topModels = models
      .slice(0, 3)
      .filter((m): m is UsageModelBreakdownItem => Boolean(m));
    topModels.forEach((m, idx) => {
      series.push({
        id: `modelCost_${m.model}`,
        name: `${m.model} 费用`,
        color: getModelColor(m.model, idx).stroke,
        width: 1.4,
        style: 'solid',
        data: points.map((p) => p.modelCosts?.[m.model] ?? 0),
      });
    });

    const yTicks: [string, string, string, string] =
      computedYMax > 0
        ? [
            formatCost(computedYMax),
            formatCost(computedYMax * (2.0 / 3.0)),
            formatCost(computedYMax * (1.0 / 3.0)),
            '¥ 0.00',
          ]
        : ['¥ 0.00', '¥ 0.00', '¥ 0.00', '¥ 0.00'];

    return {
      seriesList: series,
      yTicks,
      yMax: computedYMax,
      formatVal: (v: number) => formatCost(v),
    };
  }

  if (dimension === 'models') {
    const topModels = models
      .slice(0, 4)
      .filter((m): m is UsageModelBreakdownItem => Boolean(m));
    let localMax = 0;
    const series: ChartSeriesConfig[] = topModels.map((m, idx) => {
      const data = points.map((p) => p.modelTokens?.[m.model] ?? 0);
      for (const val of data) localMax = Math.max(localMax, val);
      return {
        id: `model_${m.model}`,
        name: m.model,
        color: getModelColor(m.model, idx).stroke,
        width: idx === 0 ? 1.6 : 1.4,
        style: 'solid',
        isTotal: idx === 0,
        data,
      };
    });

    const computedYMax = localMax > 0 ? localMax * 1.15 : 0;
    const yTicks: [string, string, string, string] =
      computedYMax > 0
        ? [
            formatTokens(computedYMax),
            formatTokens(computedYMax * (2.0 / 3.0)),
            formatTokens(computedYMax * (1.0 / 3.0)),
            '0',
          ]
        : ['0', '0', '0', '0'];

    return {
      seriesList: series,
      yTicks,
      yMax: computedYMax,
      formatVal: formatTokens,
    };
  }

  // 默认 overview
  const computedYMax = maxTokens > 0 ? maxTokens * 1.15 : 0;
  const totals = points.map((p) => p.total);

  const series: ChartSeriesConfig[] = [
    {
      id: 'total',
      name: '总用量',
      color: 'var(--usage-color-brand)',
      width: 1.8,
      style: 'solid',
      isTotal: true,
      data: totals,
    },
    {
      id: 'input',
      name: '提示输入',
      color: 'var(--usage-color-input)',
      width: 1.4,
      style: 'solid',
      data: points.map((p) => p.input),
    },
    {
      id: 'output',
      name: '生成输出',
      color: 'var(--usage-color-claude)',
      width: 1.4,
      style: 'solid',
      data: points.map((p) => p.output),
    },
    {
      id: 'cache',
      name: '缓存命中',
      color: 'var(--usage-color-cache)',
      width: 1.3,
      style: 'dashed',
      dasharray: '4 3',
      data: points.map((p) => p.cache),
    },
  ];

  const yTicks: [string, string, string, string] =
    computedYMax > 0
      ? [
          formatTokens(computedYMax),
          formatTokens(computedYMax * (2.0 / 3.0)),
          formatTokens(computedYMax * (1.0 / 3.0)),
          '0',
        ]
      : ['0', '0', '0', '0'];

  return {
    seriesList: series,
    yTicks,
    yMax: computedYMax,
    formatVal: formatTokens,
  };
}

/**
 * 几何投影计算辅助函数
 */
export function computeSeriesGeometry(
  seriesList: ChartSeriesConfig[],
  pointsLength: number,
  yMax: number,
  xStart = 40,
  xEnd = 750,
  yTop = 20,
  yBottom = 140
): ComputedChartSeries[] {
  if (pointsLength <= 1) return [];
  const ySpan = yBottom - yTop;

  return seriesList.map((ser) => {
    const pts: SplinePoint[] = ser.data.map((val, i) => {
      const x = xStart + (i / (pointsLength - 1)) * (xEnd - xStart);
      const ratio = yMax > 0 ? Math.min(1, Math.max(0, val / yMax)) : 0;
      const y = yBottom - ratio * ySpan;
      return { x, y, val };
    });

    const lineD = getMonotoneSplinePath(pts);
    const areaD = ser.hasArea ? getAreaSplinePath(pts, yBottom) : '';

    return {
      ...ser,
      points: pts,
      lineD,
      areaD,
    };
  });
}
