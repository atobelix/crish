/**
 * 设置 · 用量：本会话统计、本机历史与模型单价；成功静默，仅错误提示。
 */
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { fetchEngineStatus, type EngineStatus } from '../api/engineConfig';
import { getActiveModelId } from '../api/providerProfiles';
import { estimateCostUsd, loadPrices, upsertPrice, type ModelPrice } from '../api/pricingStore';
import {
  clearUsageHistory,
  loadUsageSnapshot,
  usageDaysForChart,
  type UsageSnapshot,
} from '../api/usageStore';
import { useLayoutStore } from '../store/layoutStore';

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

function formatPriceMeta(inputPerMTok: number, outputPerMTok: number): string {
  return `入 $${inputPerMTok} / 出 $${outputPerMTok}`;
}

function safeLoadPrices(): { list: ModelPrice[]; error: string | null } {
  try {
    return { list: loadPrices(), error: null };
  } catch (err) {
    return { list: [], error: String(err) };
  }
}

function modelDisplayLabel(
  engineStatus: EngineStatus | null,
  engineLoading: boolean,
  fallbackModel: string,
): string {
  if (engineLoading) return fallbackModel || '…';
  const raw = engineStatus?.model?.trim();
  if (raw && raw !== 'unknown') return raw;
  if (fallbackModel) return fallbackModel;
  return '未选择';
}

export const SettingsUsageTab: React.FC<Props> = ({ onShowToast }) => {
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [engineLoading, setEngineLoading] = useState(true);
  const [priceList, setPriceList] = useState<ModelPrice[]>(() => safeLoadPrices().list);
  const [pricesError, setPricesError] = useState<string | null>(null);
  const [pricesTick, setPricesTick] = useState(0);
  const [priceDraft, setPriceDraft] = useState({ model: '', input: '', output: '' });
  const [priceFilter, setPriceFilter] = useState('');
  const [history, setHistory] = useState<UsageSnapshot>(() => loadUsageSnapshot());
  const [chartDays, setChartDays] = useState<7 | 14>(7);

  const titleId = useId();
  const usageLabelId = useId();
  const histLabelId = useId();
  const pricesLabelId = useId();
  const filterId = useId();
  const modelInputId = useId();

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
    let cancelled = false;
    setEngineLoading(true);
    const timer = window.setTimeout(() => {
      if (!cancelled) setEngineLoading(false);
    }, 6_000);
    void fetchEngineStatus()
      .then((st) => {
        if (cancelled) return;
        setEngineStatus(st);
      })
      .catch(() => {
        if (cancelled) return;
        setEngineStatus({ ok: false, error: 'status_failed' });
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (!cancelled) setEngineLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    reloadPrices(pricesTick === 0);
  }, [pricesTick, reloadPrices]);

  useEffect(() => {
    setHistory(loadUsageSnapshot());
  }, []);

  const tokenUsageRaw = useLayoutStore((s) => s.tokenUsage);
  const tokenUsage = {
    input: Number(tokenUsageRaw?.input) || 0,
    output: Number(tokenUsageRaw?.output) || 0,
    cost: Number(tokenUsageRaw?.cost) || 0,
  };
  const localModel = (() => {
    try {
      return getActiveModelId() || '';
    } catch {
      return '';
    }
  })();
  const modelRaw = engineStatus?.model || localModel || 'unknown';
  const modelLabel = modelDisplayLabel(engineStatus, engineLoading, localModel);

  let cost = 0;
  try {
    cost =
      tokenUsage.cost > 0
        ? tokenUsage.cost
        : estimateCostUsd(modelRaw, tokenUsage.input, tokenUsage.output) || 0;
  } catch {
    cost = tokenUsage.cost || 0;
  }

  const totalTokens = tokenUsage.input + tokenUsage.output;
  const avgCostPer1k = cost > 0 && totalTokens > 0 ? (cost / totalTokens) * 1000 : 0;
  const inPct = totalTokens > 0 ? Math.round((tokenUsage.input / totalTokens) * 100) : 50;
  const outPct = totalTokens > 0 ? 100 - inPct : 50;
  const barIn = totalTokens > 0 ? Math.max(6, inPct) : 0;
  const barOut = totalTokens > 0 ? Math.max(6, outPct) : 0;

  const dayBars = useMemo(
    () => usageDaysForChart(chartDays, history),
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

  const prefillPrice = (row: ModelPrice) => {
    setPriceDraft({
      model: row.model,
      input: String(row.inputPerMTok),
      output: String(row.outputPerMTok),
    });
  };

  const emptyPricesLabel = priceList.length === 0 ? '还没有单价' : '无匹配';

  return (
    <div
      className="settings-pane settings-pane--modern settings-pane--usage"
      aria-labelledby={titleId}
    >
      <header className="settings-page-head">
        <div className="settings-head-inline">
          <h2 className="settings-page-title" id={titleId}>
            用量
          </h2>
        </div>
      </header>

      <section className="settings-group" aria-labelledby={usageLabelId}>
        <div className="settings-group-label" id={usageLabelId}>
          本会话
        </div>
        <div className="settings-usage-stats" role="group" aria-label="用量概览">
          <div className="settings-usage-stat-card">
            <span className="settings-usage-stat-label">输入</span>
            <span className="settings-usage-stat-value">
              {formatTokenCount(tokenUsage.input)}
            </span>
            <div className="settings-usage-bar" aria-hidden>
              <div className="settings-usage-bar-fill" style={{ width: `${barIn}%` }} />
            </div>
          </div>
          <div className="settings-usage-stat-card">
            <span className="settings-usage-stat-label">输出</span>
            <span className="settings-usage-stat-value">
              {formatTokenCount(tokenUsage.output)}
            </span>
            <div className="settings-usage-bar" aria-hidden>
              <div
                className="settings-usage-bar-fill is-out"
                style={{ width: `${barOut}%` }}
              />
            </div>
          </div>
          <div className="settings-usage-stat-card">
            <span className="settings-usage-stat-label">费用</span>
            <span className="settings-usage-stat-value">{formatUsd(cost)}</span>
            <div className="settings-usage-bar" aria-hidden>
              <div
                className="settings-usage-bar-fill is-cost"
                style={{ width: cost > 0 ? '100%' : '0%' }}
              />
            </div>
          </div>
        </div>
        <div
          className="settings-usage-ratio"
          title={`输入 ${inPct}% · 输出 ${outPct}%`}
          aria-label={`输入输出占比 输入 ${inPct}% 输出 ${outPct}%`}
        >
          <div className="settings-usage-ratio-in" style={{ width: `${inPct}%` }} />
          <div className="settings-usage-ratio-out" style={{ width: `${outPct}%` }} />
        </div>
        <div className="settings-usage-meta-row">
          <span>
            合计 <strong>{formatTokenCount(totalTokens)}</strong>
          </span>
          <span>
            模型 <strong>{modelLabel}</strong>
          </span>
          {avgCostPer1k > 0 ? (
            <span>
              约 <strong>{formatUsd(avgCostPer1k, 5)}</strong> / 1k token
            </span>
          ) : (
            <span className="settings-list-sub">对话后自动统计</span>
          )}
        </div>
      </section>

      <section className="settings-group" aria-labelledby={histLabelId}>
        <div className="settings-group-label" id={histLabelId}>
          历史
          <span className="settings-group-count" title="累计">
            {formatTokenCount(history.totalInput + history.totalOutput)}
          </span>
        </div>
        <div className="settings-usage-chart-tools" role="group" aria-label="时间范围">
          <button
            type="button"
            className={`settings-choice-btn ${chartDays === 7 ? 'active' : ''}`}
            aria-pressed={chartDays === 7}
            onClick={() => setChartDays(7)}
          >
            近 7 日
          </button>
          <button
            type="button"
            className={`settings-choice-btn ${chartDays === 14 ? 'active' : ''}`}
            aria-pressed={chartDays === 14}
            onClick={() => setChartDays(14)}
          >
            近 14 日
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect"
            onClick={() => setHistory(loadUsageSnapshot())}
          >
            刷新
          </button>
          {(history.totalInput > 0 || history.totalOutput > 0) && (
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm settings-btn-rect"
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
              清空历史
            </button>
          )}
        </div>
        <div className="settings-usage-day-chart" role="img" aria-label="近几日 token 柱状图">
          {dayBars.map((d) => {
            const total = d.input + d.output;
            const h = Math.max(total > 0 ? 8 : 2, Math.round((total / dayMax) * 100));
            const label = d.day.slice(5);
            return (
              <div key={d.day} className="settings-usage-day-col" title={`${d.day} · ${formatTokenCount(total)} tokens`}>
                <div className="settings-usage-day-bar-wrap">
                  <div
                    className={`settings-usage-day-bar${total === 0 ? ' is-empty' : ''}`}
                    style={{ height: `${h}%` }}
                  />
                </div>
                <span className="settings-usage-day-label">{label}</span>
              </div>
            );
          })}
        </div>
        <div className="settings-usage-meta-row">
          <span>
            累计入 <strong>{formatTokenCount(history.totalInput)}</strong>
          </span>
          <span>
            累计出 <strong>{formatTokenCount(history.totalOutput)}</strong>
          </span>
          <span>
            累计费用 <strong>{formatUsd(history.totalCost)}</strong>
          </span>
        </div>
        {history.models.length > 0 ? (
          <div className="settings-usage-model-bars" role="list" aria-label="按模型">
            {history.models.slice(0, 6).map((m) => {
              const t = m.input + m.output;
              const maxM = history.models[0]
                ? history.models[0].input + history.models[0].output || 1
                : 1;
              const w = Math.max(4, Math.round((t / maxM) * 100));
              return (
                <div key={m.model} className="settings-usage-model-bar-row" role="listitem">
                  <span className="settings-usage-model-bar-name" title={m.model}>
                    {m.model}
                  </span>
                  <div className="settings-usage-bar">
                    <div className="settings-usage-bar-fill" style={{ width: `${w}%` }} />
                  </div>
                  <span className="settings-usage-model-bar-val">
                    {formatTokenCount(t)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="settings-list-sub" style={{ margin: '8px 0 0' }}>
            有对话记录后会显示在这里
          </p>
        )}
      </section>

      <details className="settings-group settings-usage-prices" aria-labelledby={pricesLabelId}>
        <summary
          className="settings-group-label settings-usage-prices-summary"
          id={pricesLabelId}
        >
          模型单价
          {priceList.length > 0 ? (
            <span className="settings-group-count">{priceList.length}</span>
          ) : null}
        </summary>
        <div className="settings-list settings-list--usage">
          {pricesError ? (
            <div className="settings-list-row settings-list-row--single settings-list-row--usage">
              <div className="settings-list-copy">
                <div className="settings-list-title settings-list-empty" role="alert">
                  {pricesError}
                </div>
              </div>
              <div className="settings-list-control">
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() => setPricesTick((n) => n + 1)}
                >
                  重试
                </button>
              </div>
            </div>
          ) : null}

          {priceList.length > 0 ? (
            <div className="settings-list-row settings-list-row--single settings-list-row--usage">
              <div className="settings-list-copy">
                <div className="settings-list-title">
                  <label htmlFor={filterId}>筛选</label>
                </div>
              </div>
              <div className="settings-list-control settings-list-control--usage">
                <input
                  id={filterId}
                  className="settings-field-input settings-field-input--sm settings-usage-filter"
                  placeholder="筛选…"
                  value={priceFilter}
                  onChange={(e) => setPriceFilter(e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>
          ) : null}

          {filteredPrices.length === 0 ? (
            <div className="settings-list-row settings-list-row--single settings-list-row--usage">
              <div className="settings-list-copy">
                <div className="settings-list-title settings-list-empty">{emptyPricesLabel}</div>
              </div>
            </div>
          ) : (
            filteredPrices.map((row) => {
              const meta = formatPriceMeta(row.inputPerMTok, row.outputPerMTok);
              return (
                <div
                  key={row.model}
                  className="settings-list-row settings-list-row--single settings-list-row--usage"
                >
                  <div className="settings-list-copy">
                    <div className="settings-list-title settings-usage-model-id">{row.model}</div>
                  </div>
                  <div className="settings-list-control settings-list-control--usage">
                    <span className="settings-list-meta settings-usage-price-meta">{meta}</span>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      onClick={() => prefillPrice(row)}
                    >
                      填入
                    </button>
                  </div>
                </div>
              );
            })
          )}

          <div
            className="settings-list-row settings-list-row--single settings-list-row--usage settings-list-row--usage-form"
            role="form"
            aria-label="保存单价"
          >
            <div className="settings-list-copy">
              <div className="settings-list-title">添加单价</div>
            </div>
            <div className="settings-list-control settings-list-control--usage settings-list-control--inline-form settings-list-control--usage-form">
              <input
                id={modelInputId}
                className="settings-field-input settings-field-input--sm settings-usage-input-model"
                placeholder="模型"
                value={priceDraft.model}
                onChange={(e) => setPriceDraft((d) => ({ ...d, model: e.target.value }))}
                spellCheck={false}
              />
              <input
                className="settings-field-input settings-field-input--sm settings-usage-input-price"
                placeholder="入 $/1M"
                value={priceDraft.input}
                onChange={(e) => setPriceDraft((d) => ({ ...d, input: e.target.value }))}
                inputMode="decimal"
              />
              <input
                className="settings-field-input settings-field-input--sm settings-usage-input-price"
                placeholder="出 $/1M"
                value={priceDraft.output}
                onChange={(e) => setPriceDraft((d) => ({ ...d, output: e.target.value }))}
                inputMode="decimal"
              />
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                disabled={!canAttemptSave}
                onClick={handleSavePrice}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      </details>
    </div>
  );
};
