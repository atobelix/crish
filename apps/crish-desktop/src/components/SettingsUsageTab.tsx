/**
 * 设置 · 用量（现代化列表：token 样本总览与定价表）
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchEngineStatus, type EngineStatus } from '../api/engineConfig';
import { estimateCostUsd, loadPrices, upsertPrice, type ModelPrice } from '../api/pricingStore';
import { useLayoutStore } from '../store/layoutStore';

type Props = {
  onShowToast: (msg: string) => void;
};

export const SettingsUsageTab: React.FC<Props> = ({ onShowToast }) => {
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [priceList, setPriceList] = useState<ModelPrice[]>(() => loadPrices());
  const [priceDraft, setPriceDraft] = useState({ model: '', input: '', output: '' });
  const [priceFilter, setPriceFilter] = useState('');

  useEffect(() => {
    void fetchEngineStatus().then(setEngineStatus);
    setPriceList(loadPrices());
  }, []);

  const tokenUsage = useLayoutStore((s) => s.tokenUsage);
  const model = engineStatus?.model || 'unknown';
  const cost =
    tokenUsage.cost > 0
      ? tokenUsage.cost
      : estimateCostUsd(model, tokenUsage.input, tokenUsage.output);

  const totalTokens = tokenUsage.input + tokenUsage.output;
  const avgCostPer1k = cost > 0 && totalTokens > 0 ? (cost / totalTokens) * 1000 : 0;

  const filteredPrices = useMemo(() => {
    const q = priceFilter.trim().toLowerCase();
    if (!q) return priceList;
    return priceList.filter((row) => row.model.toLowerCase().includes(q));
  }, [priceList, priceFilter]);

  const handleSavePrice = () => {
    const m = priceDraft.model.trim();
    const inputPerMTok = Number(priceDraft.input);
    const outputPerMTok = Number(priceDraft.output);
    if (!m || Number.isNaN(inputPerMTok) || Number.isNaN(outputPerMTok)) {
      onShowToast('请填写完整的定价');
      return;
    }
    setPriceList(upsertPrice({ model: m, inputPerMTok, outputPerMTok }));
    setPriceDraft({ model: '', input: '', output: '' });
    onShowToast(`已保存定价：${m}`);
  };

  const prefillPrice = (row: ModelPrice) => {
    setPriceDraft({
      model: row.model,
      input: String(row.inputPerMTok),
      output: String(row.outputPerMTok),
    });
    onShowToast(`已填入 ${row.model}，可修改后保存`);
  };

  return (
    <div className="settings-pane settings-pane--modern">
      <header className="settings-page-head">
        <h2 className="settings-page-title">用量</h2>
        <p className="settings-page-desc">
          优先使用引擎 run snapshot 的 token 样本；无样本时回退字数估算。费用按下方定价表计算。
        </p>
      </header>

      <section className="settings-group" aria-label="用量总览">
        <div className="settings-group-label">用量总览</div>
        <div className="settings-list">
          <div className="settings-list-row">
            <div className="settings-list-copy">
              <div className="settings-list-title">输入 tokens</div>
              <div className="settings-list-sub">当前会话累计输入</div>
            </div>
            <div className="settings-list-control">
              <span className="settings-list-title">{tokenUsage.input.toLocaleString()}</span>
            </div>
          </div>
          <div className="settings-list-row">
            <div className="settings-list-copy">
              <div className="settings-list-title">输出 tokens</div>
              <div className="settings-list-sub">当前会话累计输出</div>
            </div>
            <div className="settings-list-control">
              <span className="settings-list-title">{tokenUsage.output.toLocaleString()}</span>
            </div>
          </div>
          <div className="settings-list-row">
            <div className="settings-list-copy">
              <div className="settings-list-title">估算费用 (USD)</div>
              <div className="settings-list-sub">有引擎费用时优先用样本，否则按定价表估算</div>
            </div>
            <div className="settings-list-control">
              <span className="settings-list-title">${cost.toFixed(4)}</span>
            </div>
          </div>
          <div className="settings-list-row">
            <div className="settings-list-copy">
              <div className="settings-list-title">计价模型</div>
              <div className="settings-list-sub">用于匹配下方定价表的模型 ID</div>
            </div>
            <div className="settings-list-control">
              <span className="settings-list-sub settings-list-sub--mono">{model}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-label="汇总指标">
        <div className="settings-group-label">汇总指标</div>
        <div className="settings-list settings-list--spaced">
          <div className="settings-list-row">
            <div className="settings-list-copy">
              <div className="settings-list-title">总 tokens</div>
              <div className="settings-list-sub">输入 + 输出</div>
            </div>
            <div className="settings-list-control">
              <span className="settings-list-title">{totalTokens.toLocaleString()}</span>
            </div>
          </div>
          {cost > 0 && totalTokens > 0 ? (
            <div className="settings-list-row">
              <div className="settings-list-copy">
                <div className="settings-list-title">平均费用 / 1k tokens</div>
                <div className="settings-list-sub">按当前估算费用与总量折算</div>
              </div>
              <div className="settings-list-control">
                <span className="settings-list-title">${avgCostPer1k.toFixed(6)}</span>
              </div>
            </div>
          ) : null}
          <div className="settings-list-row">
            <div className="settings-list-copy">
              <div className="settings-list-title">会话累计</div>
              <div className="settings-list-sub">
                Token 用量随当前会话累计，暂不支持在设置中重置显示。
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-label="定价表">
        <div className="settings-group-label">定价表（每百万 tokens）</div>
        <div className="settings-list">
          <div className="settings-list-row settings-list-row--stack">
            <div className="settings-list-copy">
              <div className="settings-list-title">筛选模型</div>
              <div className="settings-list-sub">按模型 ID 过滤下方列表</div>
            </div>
            <div className="settings-list-stack-controls">
              <input
                className="settings-field-input"
                placeholder="搜索模型 ID…"
                value={priceFilter}
                onChange={(e) => setPriceFilter(e.target.value)}
                spellCheck={false}
                style={{ maxWidth: 320 }}
              />
            </div>
          </div>

          {filteredPrices.length === 0 ? (
            <div className="settings-list-row">
              <div className="settings-list-copy">
                <div className="settings-list-sub">
                  {priceList.length === 0 ? '暂无定价条目' : '无匹配的模型'}
                </div>
              </div>
            </div>
          ) : (
            filteredPrices.map((row) => (
              <div
                key={row.model}
                className="settings-list-row settings-list-row--clickable"
                role="button"
                tabIndex={0}
                onClick={() => prefillPrice(row)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    prefillPrice(row);
                  }
                }}
                title="点击填入编辑区"
              >
                <div className="settings-list-copy">
                  <div className="settings-list-title settings-list-sub--mono">{row.model}</div>
                  <div className="settings-list-sub">
                    入 ${row.inputPerMTok} · 出 ${row.outputPerMTok}
                  </div>
                </div>
                <div className="settings-list-control">
                  <span className="settings-list-sub">编辑</span>
                </div>
              </div>
            ))
          )}

          <div className="settings-list-row settings-list-row--stack">
            <div className="settings-list-copy">
              <div className="settings-list-title">添加或更新定价</div>
              <div className="settings-list-sub">
                点击上方行可填入；默认参考公开标价，可按你的渠道自行修改。
              </div>
            </div>
            <div className="settings-list-stack-controls">
              <div className="settings-list-stack-actions">
                <input
                  className="settings-field-input"
                  placeholder="模型 ID"
                  style={{ flex: 1, minWidth: 120 }}
                  value={priceDraft.model}
                  onChange={(e) => setPriceDraft((d) => ({ ...d, model: e.target.value }))}
                  spellCheck={false}
                />
                <input
                  className="settings-field-input"
                  placeholder="输入 $/M"
                  style={{ width: 90 }}
                  value={priceDraft.input}
                  onChange={(e) => setPriceDraft((d) => ({ ...d, input: e.target.value }))}
                />
                <input
                  className="settings-field-input"
                  placeholder="输出 $/M"
                  style={{ width: 90 }}
                  value={priceDraft.output}
                  onChange={(e) => setPriceDraft((d) => ({ ...d, output: e.target.value }))}
                />
                <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={handleSavePrice}>
                  保存定价
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
