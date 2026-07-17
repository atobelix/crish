/**
 * 设置 · 用量：本会话统计、本机历史与模型单价；成功静默，仅错误提示。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
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
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <span
        style={{
          flex: 2,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: '13px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-secondary)',
        }}
        title={row.model}
      >
        {row.model}
      </span>
      <input
        value={inputVal}
        onChange={(e) => setInputVal(e.target.value)}
        className="settings-field-input"
        style={{ flex: 1, height: '26px', fontSize: '12px', padding: '0 6px', width: '60px' }}
        placeholder="入"
      />
      <input
        value={outputVal}
        onChange={(e) => setOutputVal(e.target.value)}
        className="settings-field-input"
        style={{ flex: 1, height: '26px', fontSize: '12px', padding: '0 6px', width: '60px' }}
        placeholder="出"
      />
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-sm"
        disabled={!hasChanged || Number.isNaN(Number(inputVal)) || Number.isNaN(Number(outputVal))}
        onClick={() => {
          onSave(Number(inputVal), Number(outputVal));
        }}
        style={{ height: '26px', padding: '0 8px', fontSize: '11px' }}
      >
        保存
      </button>
      <button
        type="button"
        className="ui-btn ui-btn-ghost ui-btn-sm danger"
        onClick={onDelete}
        style={{ height: '26px', padding: '0 8px', fontSize: '11px' }}
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
  const [history, setHistory] = useState<UsageSnapshot>(() => loadUsageSnapshot());
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

  const headerMeta = (
    <button
      type="button"
      className="ui-btn ui-btn-secondary ui-btn-sm"
      style={{ display: 'flex', alignItems: 'center', gap: '6px', borderRadius: '6px' }}
      onClick={() => setPricesModalOpen(true)}
    >
      <Lucide.DollarSign size={14} />
      配置单价
    </button>
  );

  const pricingModal = pricesModalOpen
    ? createPortal(
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 30000,
          }}
          onClick={() => setPricesModalOpen(false)}
        >
          <div
            style={{
              width: '520px',
              maxHeight: '80vh',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg-primary, #ffffff)',
              border: '1px solid var(--border-subtle, #e5e7eb)',
              borderRadius: '12px',
              padding: '20px',
              boxShadow: 'var(--shadow-lg, 0 10px 25px rgba(0,0,0,0.15))',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '16px',
                gap: '16px',
              }}
            >
              <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
                模型价格配置 (USD / 1M Tokens)
              </span>
              <input
                type="text"
                placeholder="搜索模型..."
                value={priceFilter}
                onChange={(e) => setPriceFilter(e.target.value)}
                className="settings-field-input"
                style={{ width: '160px', height: '28px', fontSize: '12px' }}
                spellCheck={false}
              />
            </div>

            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                marginBottom: '16px',
                paddingRight: '4px',
              }}
            >
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
                <div
                  style={{
                    padding: '24px 0',
                    color: 'var(--text-tertiary)',
                    fontSize: '13px',
                    textAlign: 'center',
                  }}
                >
                  无匹配的模型价格
                </div>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                gap: '8px',
                borderTop: '1px solid var(--border-subtle)',
                paddingTop: '16px',
                alignItems: 'center',
              }}
            >
              <input
                placeholder="添加模型 ID..."
                value={priceDraft.model}
                onChange={(e) => setPriceDraft((d) => ({ ...d, model: e.target.value }))}
                className="settings-field-input"
                style={{ flex: 2, height: '28px', fontSize: '12px' }}
                spellCheck={false}
              />
              <input
                placeholder="入 $/1M"
                value={priceDraft.input}
                onChange={(e) => setPriceDraft((d) => ({ ...d, input: e.target.value }))}
                className="settings-field-input"
                style={{ flex: 1, height: '28px', fontSize: '12px' }}
              />
              <input
                placeholder="出 $/1M"
                value={priceDraft.output}
                onChange={(e) => setPriceDraft((d) => ({ ...d, output: e.target.value }))}
                className="settings-field-input"
                style={{ flex: 1, height: '28px', fontSize: '12px' }}
              />
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                disabled={!canAttemptSave}
                onClick={handleSavePrice}
                style={{ height: '28px', padding: '0 12px', borderRadius: '6px' }}
              >
                添加
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => setPricesModalOpen(false)}
                style={{ borderRadius: '6px' }}
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
          {/* Summary Cards */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '16px',
              padding: '16px 20px',
              borderBottom: '1px solid var(--border-subtle)',
              background: 'var(--bg-subtle)',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>累计输入</span>
              <span style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)' }}>
                {formatTokenCount(history.totalInput)}{' '}
                <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--text-secondary)' }}>
                  tokens
                </span>
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>累计输出</span>
              <span style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)' }}>
                {formatTokenCount(history.totalOutput)}{' '}
                <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--text-secondary)' }}>
                  tokens
                </span>
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>累计费用</span>
              <span style={{ fontSize: '20px', fontWeight: 600, color: '#16a34a' }}>
                {formatUsd(history.totalCost)}
              </span>
            </div>
          </div>

          {/* Daily Trend Chart */}
          <div
            style={{
              padding: '24px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)' }}>
                每日使用趋势
              </span>
              <div
                className="ui-segment ui-segment--inline"
                style={{
                  display: 'flex',
                  gap: '2px',
                  padding: '2px',
                  background: 'var(--bg-tertiary)',
                  borderRadius: '6px',
                }}
              >
                <button
                  type="button"
                  className={`ui-segment-item ${chartDays === 7 ? 'active' : ''}`}
                  style={{
                    padding: '4px 10px',
                    fontSize: '11px',
                    borderRadius: '4px',
                    border: 'none',
                    background: chartDays === 7 ? 'var(--bg-primary)' : 'transparent',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                  }}
                  onClick={() => setChartDays(7)}
                >
                  近 7 日
                </button>
                <button
                  type="button"
                  className={`ui-segment-item ${chartDays === 14 ? 'active' : ''}`}
                  style={{
                    padding: '4px 10px',
                    fontSize: '11px',
                    borderRadius: '4px',
                    border: 'none',
                    background: chartDays === 14 ? 'var(--bg-primary)' : 'transparent',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                  }}
                  onClick={() => setChartDays(14)}
                >
                  近 14 日
                </button>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                height: '140px',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                gap: '12px',
                padding: '10px 0',
                borderBottom: '1px dashed var(--border-subtle)',
              }}
            >
              {dayBars.map((d) => {
                const total = d.input + d.output;
                const heightPct = dayMax > 0 ? (total / dayMax) * 100 : 0;
                const inPct = total > 0 ? (d.input / total) * 100 : 0;
                const outPct = total > 0 ? (d.output / total) * 100 : 0;
                const dateLabel = d.day.slice(5);

                return (
                  <div
                    key={d.day}
                    style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      height: '100%',
                      justifyContent: 'flex-end',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                    title={`${d.day}\n输入: ${formatTokenCount(d.input)}\n输出: ${formatTokenCount(d.output)}`}
                  >
                    <div
                      style={{
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'flex-end',
                        alignItems: 'center',
                      }}
                    >
                      {total > 0 ? (
                        <div
                          style={{
                            width: '14px',
                            height: `${Math.max(4, heightPct)}%`,
                            display: 'flex',
                            flexDirection: 'column',
                            borderRadius: '4px',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: '100%',
                              height: `${outPct}%`,
                              background: 'var(--accent-chart-out, var(--accent-primary))',
                              opacity: 0.85,
                            }}
                          />
                          <div
                            style={{
                              width: '100%',
                              height: `${inPct}%`,
                              background: 'var(--accent-chart-in, var(--accent-secondary))',
                            }}
                          />
                        </div>
                      ) : (
                        <div
                          style={{
                            width: '14px',
                            height: '4px',
                            background: 'var(--border-subtle)',
                            borderRadius: '2px',
                          }}
                        />
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: '10px',
                        color: 'var(--text-tertiary)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {dateLabel}
                    </span>
                  </div>
                );
              })}
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '16px',
                fontSize: '11px',
                color: 'var(--text-tertiary)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <div
                  style={{
                    width: '8px',
                    height: '8px',
                    background: 'var(--accent-chart-in, var(--accent-secondary))',
                    borderRadius: '2px',
                  }}
                />
                <span>输入 Token</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <div
                  style={{
                    width: '8px',
                    height: '8px',
                    background: 'var(--accent-chart-out, var(--accent-primary))',
                    opacity: 0.85,
                    borderRadius: '2px',
                  }}
                />
                <span>输出 Token</span>
              </div>
            </div>
          </div>

          {/* Model Breakdown */}
          {history.models.length > 0 && (
            <div
              style={{
                borderTop: '1px solid var(--border-subtle)',
                padding: '16px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)' }}>
                模型使用分布
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {history.models.map((m) => {
                  const t = m.input + m.output;
                  const maxM = history.models[0]
                    ? history.models[0].input + history.models[0].output || 1
                    : 1;
                  const barWidth = Math.max(4, Math.round((t / maxM) * 100));
                  return (
                    <div
                      key={m.model}
                      style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '13px' }}
                    >
                      <span
                        style={{
                          flex: '0 0 160px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: 'var(--text-secondary)',
                          fontFamily: 'var(--font-mono)',
                        }}
                        title={m.model}
                      >
                        {m.model}
                      </span>
                      <div
                        style={{
                          flex: 1,
                          height: '6px',
                          background: 'var(--bg-tertiary)',
                          borderRadius: '3px',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${barWidth}%`,
                            background: 'var(--accent-primary, #4f46e5)',
                            borderRadius: '3px',
                          }}
                        />
                      </div>
                      <span
                        style={{
                          flex: '0 0 100px',
                          textAlign: 'right',
                          color: 'var(--text-primary)',
                          fontWeight: 500,
                        }}
                      >
                        {formatTokenCount(t)}{' '}
                        <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--text-secondary)' }}>
                          tokens
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Bottom Actions */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '12px 20px',
              borderTop: '1px solid var(--border-subtle)',
              background: 'var(--bg-subtle)',
            }}
          >
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              style={{
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                borderRadius: '6px',
              }}
              onClick={() => setHistory(loadUsageSnapshot())}
            >
              <Lucide.RefreshCw size={12} /> 刷新数据
            </button>
            {(history.totalInput > 0 || history.totalOutput > 0) && (
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm danger"
                style={{
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  borderRadius: '6px',
                }}
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
        </SettingsCard>
      </SettingsSection>
      {pricingModal}
    </SettingsPage>
  );
};
