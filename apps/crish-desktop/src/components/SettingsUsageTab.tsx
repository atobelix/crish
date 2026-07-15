/**
 * 设置 · 用量：token 样本总览与定价表
 */
import React, { useEffect, useState } from 'react';
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

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>用量总览</h4>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
          优先使用引擎 run snapshot 的 token 样本；无样本时回退字数估算。费用按下方定价表计算。
        </p>
      </div>
      <div className="settings-card-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div className="settings-field-label">输入 tokens</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{tokenUsage.input.toLocaleString()}</div>
        </div>
        <div>
          <div className="settings-field-label">输出 tokens</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{tokenUsage.output.toLocaleString()}</div>
        </div>
        <div>
          <div className="settings-field-label">估算费用 (USD)</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>${cost.toFixed(4)}</div>
        </div>
        <div>
          <div className="settings-field-label">计价模型</div>
          <div style={{ fontSize: 13 }}>{model}</div>
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <h4 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>定价表（每百万 tokens）</h4>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--text-tertiary)' }}>
          默认参考公开标价，可按你的渠道自行修改
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {priceList.map((row) => (
            <div
              key={row.model}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.2fr 1fr 1fr',
                gap: 8,
                fontSize: 12,
                padding: '6px 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono)' }}>{row.model}</span>
              <span>入 ${row.inputPerMTok}</span>
              <span>出 ${row.outputPerMTok}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          <input
            className="settings-field-input"
            placeholder="模型 ID"
            style={{ flex: 1, minWidth: 120 }}
            value={priceDraft.model}
            onChange={(e) => setPriceDraft((d) => ({ ...d, model: e.target.value }))}
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
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            onClick={() => {
              const m = priceDraft.model.trim();
              const inputPerMTok = Number(priceDraft.input);
              const outputPerMTok = Number(priceDraft.output);
              if (!m || Number.isNaN(inputPerMTok) || Number.isNaN(outputPerMTok)) {
                onShowToast('请填写完整的定价');
                return;
              }
              setPriceList(upsertPrice({ model: m, inputPerMTok, outputPerMTok }));
              setPriceDraft({ model: '', input: '', output: '' });
            }}
          >
            保存定价
          </button>
        </div>
      </div>
    </>
  );
};
