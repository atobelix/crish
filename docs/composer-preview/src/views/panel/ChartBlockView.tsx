/**
 * ChartBlockView — 数据图表（ECharts）
 *
 * ── 交互清单 ──────────────────────────────────────────
 *   图表类型      → 顶部分段控件即点即换，切换有过渡而非重建
 *   数据编辑      → 右上角「数据」展开表格式编辑器，可增删行列
 *   悬浮块        → 「数据 / 复制配置 / 导出图片」
 *   容器尺寸变化  → ResizeObserver 驱动重排，而不是监听 window.resize
 *   数据为空      → 空状态给出「填入示例数据」一键上手
 *
 * ── 性能 ──────────────────────────────────────────────
 *   ECharts 走动态 import；实例只创建一次，后续更新走 setOption 增量合并；
 *   组件卸载时 dispose，避免长文档反复滚动造成实例泄漏。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NodeViewProps } from '@tiptap/react';
import {
  BarChart3, LineChart as LineIcon, PieChart as PieIcon, ScatterChart,
  Table2, Copy, Check, Download, Plus, Trash2,
} from 'lucide-react';
import { BlockShell, BlockEmpty } from '../_shared/BlockShell';
import { loadECharts } from '../../utils/chartLoader';

type ChartKind = 'bar' | 'line' | 'pie' | 'scatter';

const CHART_KINDS: Array<{ id: ChartKind; label: string; icon: React.FC<{ size?: number }> }> = [
  { id: 'bar', label: '柱状图', icon: BarChart3 },
  { id: 'line', label: '折线图', icon: LineIcon },
  { id: 'pie', label: '饼图', icon: PieIcon },
  { id: 'scatter', label: '散点图', icon: ScatterChart },
];

interface ChartData {
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
}

const SAMPLE: ChartData = {
  categories: ['一月', '二月', '三月', '四月', '五月'],
  series: [{ name: '销量', values: [120, 200, 150, 320, 260] }],
};

function parseData(raw: string): ChartData | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ChartData>;
    if (!Array.isArray(parsed.categories) || !Array.isArray(parsed.series)) return null;
    return { categories: parsed.categories, series: parsed.series } as ChartData;
  } catch {
    return null;
  }
}

/** 由类型与数据生成 ECharts option，颜色取自设计令牌保持全局一致 */
function buildOption(kind: ChartKind, data: ChartData): Record<string, unknown> {
  const palette = ['#337ea9', '#448361', '#d9730d', '#9065b0', '#c14c8a', '#cb912f'];
  const base = {
    color: palette,
    animationDuration: 420,
    animationEasing: 'cubicOut',
    tooltip: { trigger: kind === 'pie' ? 'item' : 'axis' },
    legend: { bottom: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
    grid: { left: 44, right: 20, top: 24, bottom: 44, containLabel: true },
  };

  if (kind === 'pie') {
    return {
      ...base,
      series: [
        {
          type: 'pie',
          radius: ['46%', '70%'],
          itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
          data: data.categories.map((name, i) => ({
            name,
            value: data.series[0]?.values[i] ?? 0,
          })),
        },
      ],
    };
  }

  return {
    ...base,
    xAxis: { type: 'category', data: data.categories, boundaryGap: kind !== 'line' },
    yAxis: { type: 'value' },
    series: data.series.map((s) => ({
      name: s.name,
      type: kind === 'scatter' ? 'scatter' : kind,
      data: s.values,
      smooth: kind === 'line',
      barMaxWidth: 36,
      itemStyle: { borderRadius: kind === 'bar' ? [4, 4, 0, 0] : 0 },
    })),
  };
}

export const ChartBlockView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  selected,
}) => {
  const kind = ((node.attrs.chartType as string) || 'bar') as ChartKind;
  const data = useMemo(() => parseData((node.attrs.config as string) || '{}'), [node.attrs.config]);

  const hostRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<{ setOption: (o: unknown, b?: boolean) => void; resize: () => void; dispose: () => void; getDataURL: (o: unknown) => string } | null>(null);

  const [dataOpen, setDataOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  /* ── 创建 / 更新 / 销毁实例 ── */
  useEffect(() => {
    if (!data || !hostRef.current) return;
    let disposed = false;

    void loadECharts().then((echarts) => {
      if (disposed || !hostRef.current) return;
      if (!instanceRef.current) {
        instanceRef.current = echarts.init(hostRef.current) as never;
      }
      // notMerge = true：切换图表类型时需要丢弃旧的 series 结构
      instanceRef.current?.setOption(buildOption(kind, data), true);
    });

    return () => {
      disposed = true;
    };
  }, [kind, data]);

  useEffect(() => {
    return () => {
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, []);

  /* ── 容器尺寸变化 ── */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => instanceRef.current?.resize());
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  /* ── 数据编辑 ── */
  const writeData = useCallback(
    (next: ChartData) => updateAttributes({ config: JSON.stringify(next) }),
    [updateAttributes],
  );

  const updateCell = useCallback(
    (seriesIndex: number, valueIndex: number, raw: string) => {
      if (!data) return;
      const next: ChartData = {
        categories: [...data.categories],
        series: data.series.map((s) => ({ ...s, values: [...s.values] })),
      };
      next.series[seriesIndex].values[valueIndex] = Number(raw) || 0;
      writeData(next);
    },
    [data, writeData],
  );

  const addCategory = useCallback(() => {
    if (!data) return;
    writeData({
      categories: [...data.categories, `项目 ${data.categories.length + 1}`],
      series: data.series.map((s) => ({ ...s, values: [...s.values, 0] })),
    });
  }, [data, writeData]);

  const removeCategory = useCallback(
    (index: number) => {
      if (!data || data.categories.length <= 1) return;
      writeData({
        categories: data.categories.filter((_, i) => i !== index),
        series: data.series.map((s) => ({
          ...s,
          values: s.values.filter((_, i) => i !== index),
        })),
      });
    },
    [data, writeData],
  );

  const exportImage = useCallback(() => {
    const url = instanceRef.current?.getDataURL({ pixelRatio: 2, backgroundColor: '#fff' });
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chart.png';
    a.click();
  }, []);

  if (!data) {
    return (
      <BlockShell kind="chart" selected={selected}>
        <BlockEmpty
          icon={BarChart3}
          title="数据图表"
          hint="填入分类与数值即可生成图表"
          actionLabel="填入示例数据"
          onAction={() => writeData(SAMPLE)}
        />
      </BlockShell>
    );
  }

  return (
    <BlockShell
      kind="chart"
      selected={selected}
      badge={
        <span className="block-badge">
          <BarChart3 size={12} />
          图表
        </span>
      }
      actions={[
        {
          id: 'data',
          label: '编辑数据',
          icon: Table2,
          active: dataOpen,
          onClick: () => setDataOpen((v) => !v),
        },
        {
          id: 'copy',
          label: copied ? '已复制' : '复制配置',
          icon: copied ? Check : Copy,
          active: copied,
          onClick: async () => {
            await navigator.clipboard.writeText(JSON.stringify(buildOption(kind, data), null, 2));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          },
        },
        { id: 'export', label: '导出图片', icon: Download, onClick: exportImage },
      ]}
    >
      <div className="chart-block" contentEditable={false}>
        <div className="chart-block__kinds segmented">
          {CHART_KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`segmented__item motion-tap ${kind === k.id ? 'is-active' : ''}`}
              onClick={() => updateAttributes({ chartType: k.id })}
            >
              <k.icon size={13} />
              {k.label}
            </button>
          ))}
        </div>

        <div ref={hostRef} className="chart-block__canvas" />

        {dataOpen && (
          <div className="chart-block__data motion-rise-in">
            <table className="chart-data-table">
              <thead>
                <tr>
                  <th>分类</th>
                  {data.series.map((s) => (
                    <th key={s.name}>{s.name}</th>
                  ))}
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {data.categories.map((cat, ci) => (
                  <tr key={ci} className="motion-affordance-host">
                    <td>
                      <input
                        className="chart-data-table__input"
                        value={cat}
                        onChange={(e) => {
                          const next = { ...data, categories: [...data.categories] };
                          next.categories[ci] = e.target.value;
                          writeData(next);
                        }}
                      />
                    </td>
                    {data.series.map((s, si) => (
                      <td key={si}>
                        <input
                          className="chart-data-table__input"
                          type="number"
                          value={s.values[ci] ?? 0}
                          onChange={(e) => updateCell(si, ci, e.target.value)}
                        />
                      </td>
                    ))}
                    <td>
                      <button
                        type="button"
                        className="chart-data-table__remove motion-affordance motion-tap"
                        onClick={() => removeCategory(ci)}
                        aria-label={`删除 ${cat}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <button type="button" className="btn btn--ghost btn--sm motion-tap" onClick={addCategory}>
              <Plus size={13} />
              添加一行
            </button>
          </div>
        )}
      </div>
    </BlockShell>
  );
};
