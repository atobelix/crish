/**
 * 设置 · 用量：本会话统计、本机历史与模型单价；成功静默，仅错误提示。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import styles from './SettingsUsageTab.module.css';
import {
  loadPrices,
  upsertPrice,
  savePrices,
  type ModelPrice,
} from '../api/pricingStore';
import {
  clearUsageHistory,
  loadUsageSnapshot,
  usageDaysForChart,
  type UsageSnapshot,
} from '../api/usageStore';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
} from './settings/SettingsUI';
import { Tooltip } from './Tooltip';

type Props = {
  onShowToast: (msg: string) => void;
};

function formatTokenCount(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return v.toLocaleString('zh-CN');
}

function formatUsd(n: number, digits = 4): string {
  const v = Number.isFinite(n) ? n : 0;
  return `$${v.toFixed(digits)}`;
}



function safeLoadPrices(): { list: ModelPrice[]; error: string | null } {
  try {
    return { list: loadPrices(), error: null };
  } catch (err) {
    return { list: [], error: String(err) };
  }
}



const EditablePriceRow: React.FC<{
  row: ModelPrice;
  onSave: (input: number, output: number) => void;
  onDelete: () => void;
}> = ({ row, onSave, onDelete }) => {
  const [inputVal, setInputVal] = useState(String(row.inputPerMTok));
  const [outputVal, setOutputVal] = useState(String(row.outputPerMTok));
  const hasChanged =
    Number(inputVal) !== row.inputPerMTok || Number(outputVal) !== row.outputPerMTok;

  return (
    <div className={styles.priceRow}>
      <Tooltip content={row.model}>
        <span className={styles.priceRowModel}>
          {row.model}
        </span>
      </Tooltip>
      <input
        value={inputVal}
        onChange={(e) => setInputVal(e.target.value)}
        className={`settings-field-input ${styles.priceRowInput}`}
        placeholder="入"
      />
      <input
        value={outputVal}
        onChange={(e) => setOutputVal(e.target.value)}
        className={`settings-field-input ${styles.priceRowInput}`}
        placeholder="出"
      />
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-sm"
        disabled={!hasChanged || Number.isNaN(Number(inputVal)) || Number.isNaN(Number(outputVal))}
        onClick={() => {
          onSave(Number(inputVal), Number(outputVal));
        }}
      >
        保存
      </button>
      <button
        type="button"
        className="ui-btn ui-btn-ghost ui-btn-sm danger"
        onClick={onDelete}
      >
        删除
      </button>
    </div>
  );
};

export const SettingsUsageTab: React.FC<Props> = ({ onShowToast }) => {
  const [pricesModalOpen, setPricesModalOpen] = useState(false);
  const [priceList, setPriceList] = useState<ModelPrice[]>(() => safeLoadPrices().list);
  const [_pricesError, setPricesError] = useState<string | null>(null);
  const [priceDraft, setPriceDraft] = useState({ model: '', input: '', output: '' });
  const [priceFilter, setPriceFilter] = useState('');
  const [history, setHistory] = useState<UsageSnapshot | null>(null);
  const [chartDays, setChartDays] = useState<7 | 14>(7);

  const reloadPrices = useCallback(
    (announceToast: boolean) => {
      const { list, error } = safeLoadPrices();
      setPriceList(list);
      if (error) {
        setPricesError('定价表读取失败');
        if (announceToast) onShowToast('定价表读取失败');
      } else {
        setPricesError(null);
      }
    },
    [onShowToast],
  );

  useEffect(() => {
    reloadPrices(true);
  }, [reloadPrices]);

  useEffect(() => {
    setHistory(loadUsageSnapshot());
  }, []);

  useEffect(() => {
    if (!pricesModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPricesModalOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pricesModalOpen]);



  const dayBars = useMemo(
    () => history ? usageDaysForChart(chartDays, history) : [],
    [chartDays, history],
  );
  const dayMax = useMemo(() => {
    let m = 0;
    for (const d of dayBars) m = Math.max(m, d.input + d.output);
    return m || 1;
  }, [dayBars]);

  const filteredPrices = useMemo(() => {
    const q = priceFilter.trim().toLowerCase();
    if (!q) return priceList;
    return priceList.filter((row) => row.model.toLowerCase().includes(q));
  }, [priceList, priceFilter]);

  const draftModel = priceDraft.model.trim();
  const draftInputRaw = priceDraft.input.trim();
  const draftOutputRaw = priceDraft.output.trim();
  const canAttemptSave = Boolean(draftModel && draftInputRaw && draftOutputRaw);

  const handleSavePrice = () => {
    const m = draftModel;
    const inputPerMTok = Number(priceDraft.input);
    const outputPerMTok = Number(priceDraft.output);
    if (!m && !draftInputRaw && !draftOutputRaw) return;
    if (!m) {
      onShowToast('请填写模型 ID');
      return;
    }
    if (
      Number.isNaN(inputPerMTok) ||
      Number.isNaN(outputPerMTok) ||
      draftInputRaw === '' ||
      draftOutputRaw === ''
    ) {
      onShowToast('请填写完整的定价');
      return;
    }
    if (inputPerMTok < 0 || outputPerMTok < 0) {
      onShowToast('定价不能为负数');
      return;
    }
    try {
      setPriceList(upsertPrice({ model: m, inputPerMTok, outputPerMTok }));
      setPriceDraft({ model: '', input: '', output: '' });
      setPricesError(null);
    } catch (err) {
      onShowToast('保存失败：' + String(err));
    }
  };

  const headerMeta = (
    <button
      type="button"
      className={`ui-btn ui-btn-secondary ui-btn-sm ${styles.configBtn}`}
      onClick={() => setPricesModalOpen(true)}
    >
      <Lucide.DollarSign size={14} />
      配置单价
    </button>
  );

  const pricingModal = pricesModalOpen
    ? createPortal(
        <div
          className={styles.modalOverlay}
          onClick={() => setPricesModalOpen(false)}
        >
          <div
            className={styles.modalBox}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <span className={styles.modalTitle}>
                模型价格配置 (USD / 1M Tokens)
              </span>
              <input
                type="text"
                placeholder="搜索模型..."
                value={priceFilter}
                onChange={(e) => setPriceFilter(e.target.value)}
                className={`settings-field-input ${styles.modalFilterInput}`}
                spellCheck={false}
              />
            </div>

            <div className={styles.modalList}>
              {filteredPrices.map((row) => (
                <EditablePriceRow
                  key={row.model}
                  row={row}
                  onSave={(input, output) => {
                    const next = upsertPrice({
                      model: row.model,
                      inputPerMTok: input,
                      outputPerMTok: output,
                    });
                    setPriceList(next);
                    onShowToast(`已保存 ${row.model} 的定价`);
                  }}
                  onDelete={() => {
                    const next = priceList.filter((p) => p.model !== row.model);
                    setPriceList(next);
                    savePrices(next);
                    onShowToast(`已删除 ${row.model} 的定价`);
                  }}
                />
              ))}
              {filteredPrices.length === 0 && (
                <div className={styles.modalEmptyState}>
                  无匹配的模型价格
                </div>
              )}
            </div>

            <div className={styles.modalAddRow}>
              <input
                placeholder="添加模型 ID..."
                value={priceDraft.model}
                onChange={(e) => setPriceDraft((d) => ({ ...d, model: e.target.value }))}
                className={`settings-field-input ${styles.modalAddInputFlex2}`}
                spellCheck={false}
              />
              <input
                placeholder="入 $/1M"
                value={priceDraft.input}
                onChange={(e) => setPriceDraft((d) => ({ ...d, input: e.target.value }))}
                className={`settings-field-input ${styles.modalAddInputFlex1}`}
              />
              <input
                placeholder="出 $/1M"
                value={priceDraft.output}
                onChange={(e) => setPriceDraft((d) => ({ ...d, output: e.target.value }))}
                className={`settings-field-input ${styles.modalAddInputFlex1}`}
              />
              <button
                type="button"
                className={`ui-btn ui-btn-secondary ui-btn-sm ${styles.modalAddBtn}`}
                disabled={!canAttemptSave}
                onClick={handleSavePrice}
              >
                添加
              </button>
            </div>

            <div className={styles.modalFooter}>
              <button
                type="button"
                className={`ui-btn ui-btn-ghost ui-btn-sm ${styles.modalCloseBtn}`}
                onClick={() => setPricesModalOpen(false)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <SettingsPage title="用量" meta={headerMeta}>
      <SettingsSection title="历史统计">
        <SettingsCard>
          {history === null ? (
            <div className={styles.skeletonSection}>
              <div className={styles.skeletonBar} />
              <div className={styles.skeletonBar} />
              <div className={styles.skeletonBar} />
            </div>
          ) : (
            <>
              {/* Summary Cards */}
              <div className={styles.statsGrid}>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>累计输入</span>
                  <span className={styles.statValue}>
                    {formatTokenCount(history.totalInput)}{' '}
                    <span className={styles.statUnit}>tokens</span>
                  </span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>累计输出</span>
                  <span className={styles.statValue}>
                    {formatTokenCount(history.totalOutput)}{' '}
                    <span className={styles.statUnit}>tokens</span>
                  </span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>累计费用</span>
                  <span className={styles.statValueCost}>
                    {formatUsd(history.totalCost)}
                  </span>
                </div>
              </div>

              {/* Daily Trend Chart */}
              <div className={styles.chartSection}>
                <div className={styles.chartHeader}>
                  <span className={styles.chartTitle}>每日使用趋势</span>
                  <div className={styles.chartSegment}>
                    <button
                      type="button"
                      className={`ui-segment-item ${styles.chartSegmentBtn}${chartDays === 7 ? ` ${styles.active}` : ''}`}
                      onClick={() => setChartDays(7)}
                    >
                      近 7 日
                    </button>
                    <button
                      type="button"
                      className={`ui-segment-item ${styles.chartSegmentBtn}${chartDays === 14 ? ` ${styles.active}` : ''}`}
                      onClick={() => setChartDays(14)}
                    >
                      近 14 日
                    </button>
                  </div>
                </div>

                <div className={styles.chartBars}>
                  {dayBars.map((d) => {
                    const total = d.input + d.output;
                    const heightPct = dayMax > 0 ? (total / dayMax) * 100 : 0;
                    const inPct = total > 0 ? (d.input / total) * 100 : 0;
                    const outPct = total > 0 ? (d.output / total) * 100 : 0;
                    const dateLabel = d.day.slice(5);

                    return (
                      <Tooltip
                        key={d.day}
                        content={`${d.day}\n输入: ${formatTokenCount(d.input)}\n输出: ${formatTokenCount(d.output)}`}
                      >
                        <div
                          className={styles.chartBarCol}
                        >
                        <div className={styles.chartBarInner}>
                          {total > 0 ? (
                            <div
                              className={styles.chartBarStack}
                              style={{ height: `${Math.max(4, heightPct)}%` }}
                            >
                              <div
                                className={styles.chartBarOut}
                                style={{ height: `${outPct}%` }}
                              />
                              <div
                                className={styles.chartBarIn}
                                style={{ height: `${inPct}%` }}
                              />
                            </div>
                          ) : (
                            <div className={styles.chartBarEmpty} />
                          )}
                        </div>
                        <span className={styles.chartBarLabel}>{dateLabel}</span>
                      </div>
                    </Tooltip>
                  );
                  })}
                </div>

                <div className={styles.chartLegend}>
                  <div className={styles.chartLegendItem}>
                    <div className={styles.chartLegendDotIn} />
                    <span>输入 Token</span>
                  </div>
                  <div className={styles.chartLegendItem}>
                    <div className={styles.chartLegendDotOut} />
                    <span>输出 Token</span>
                  </div>
                </div>
              </div>

              {/* Model Breakdown */}
              {history.models.length > 0 && (
                <div className={styles.modelsSection}>
                  <span className={styles.modelsSectionTitle}>模型使用分布</span>
                  <div className={styles.modelsList}>
                    {history.models.map((m) => {
                      const t = m.input + m.output;
                      const maxM = history.models[0]
                        ? history.models[0].input + history.models[0].output || 1
                        : 1;
                      const barWidth = Math.max(4, Math.round((t / maxM) * 100));
                      return (
                        <div key={m.model} className={styles.modelRow}>
                          <Tooltip content={m.model}>
                            <span className={styles.modelName}>
                              {m.model}
                            </span>
                          </Tooltip>
                          <div className={styles.modelBarTrack}>
                            <div
                              className={styles.modelBarFill}
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                          <span className={styles.modelTokens}>
                            {formatTokenCount(t)}{' '}
                            <span className={styles.modelTokensUnit}>tokens</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Bottom Actions */}
              <div className={styles.actionsBar}>
                <button
                  type="button"
                  className={`ui-btn ui-btn-ghost ui-btn-sm ${styles.actionBtn}`}
                  onClick={() => setHistory(loadUsageSnapshot())}
                >
                  <Lucide.RefreshCw size={12} /> 刷新数据
                </button>
                {(history.totalInput > 0 || history.totalOutput > 0) && (
                  <button
                    type="button"
                    className={`ui-btn ui-btn-ghost ui-btn-sm danger ${styles.actionBtn}`}
                    onClick={() => {
                      if (
                        typeof window !== 'undefined' &&
                        window.confirm &&
                        !window.confirm('确定清空本机用量历史？不可撤销。')
                      ) {
                        return;
                      }
                      setHistory(clearUsageHistory());
                    }}
                  >
                    <Lucide.Trash2 size={12} /> 清空历史
                  </button>
                )}
              </div>
            </>
          )}
        </SettingsCard>
      </SettingsSection>
      {pricingModal}
    </SettingsPage>
  );
};
