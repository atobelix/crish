import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  upsertPrice,
  savePrices,
  type ModelPrice,
} from '../../api/pricingStore';
import { Button, Tooltip } from '../ui';
import styles from './SettingsUsageTab.module.css';

const EditablePriceRow: React.FC<{
  row: ModelPrice;
  onSave: (input: number, output: number) => void;
  onDelete: () => void;
}> = ({ row, onSave, onDelete }) => {
  const [inputVal, setInputVal] = useState(String(row.inputPerMTok));
  const [outputVal, setOutputVal] = useState(String(row.outputPerMTok));
  const hasChanged =
    Number(inputVal) !== row.inputPerMTok ||
    Number(outputVal) !== row.outputPerMTok;

  return (
    <div className={styles.priceRow}>
      <Tooltip content={row.model}>
        <span className={styles.priceRowModel}>{row.model}</span>
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
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={
          !hasChanged ||
          Number.isNaN(Number(inputVal)) ||
          Number.isNaN(Number(outputVal))
        }
        onClick={() => {
          onSave(Number(inputVal), Number(outputVal));
        }}
      >
        保存
      </Button>
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={onDelete}
      >
        删除
      </Button>
    </div>
  );
};

/** 模型价格配置弹窗（UsageConfigSection：单价表 + 编辑行 + 新增行） */
export const PriceConfigModal: React.FC<{
  open: boolean;
  priceList: ModelPrice[];
  onListChange: (next: ModelPrice[]) => void;
  onClose: () => void;
  onToast: (msg: string) => void;
}> = ({ open, priceList, onListChange, onClose, onToast }) => {
  const [priceDraft, setPriceDraft] = useState({
    model: '',
    input: '',
    output: '',
  });
  const [priceFilter, setPriceFilter] = useState('');

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
      onToast('请填写模型 ID');
      return;
    }
    if (
      Number.isNaN(inputPerMTok) ||
      Number.isNaN(outputPerMTok) ||
      draftInputRaw === '' ||
      draftOutputRaw === ''
    ) {
      onToast('请填写完整的定价');
      return;
    }
    if (inputPerMTok < 0 || outputPerMTok < 0) {
      onToast('定价不能为负数');
      return;
    }
    try {
      onListChange(upsertPrice({ model: m, inputPerMTok, outputPerMTok }));
      setPriceDraft({ model: '', input: '', output: '' });
    } catch (err) {
      onToast('保存失败：' + String(err));
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className={styles.modalOverlay}
      onClick={onClose}
    >
      <div className={styles.modalBox} onClick={(e) => e.stopPropagation()}>
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
                onListChange(next);
                onToast(`已保存 ${row.model} 的定价`);
              }}
              onDelete={() => {
                const next = priceList.filter((p) => p.model !== row.model);
                onListChange(next);
                savePrices(next);
                onToast(`已删除 ${row.model} 的定价`);
              }}
            />
          ))}
          {filteredPrices.length === 0 && (
            <div className={styles.modalEmptyState}>无匹配的模型价格</div>
          )}
        </div>

        <div className={styles.modalAddRow}>
          <input
            placeholder="添加模型 ID..."
            value={priceDraft.model}
            onChange={(e) =>
              setPriceDraft((d) => ({ ...d, model: e.target.value }))
            }
            className={`settings-field-input ${styles.modalAddInputFlex2}`}
            spellCheck={false}
          />
          <input
            placeholder="入 $/1M"
            value={priceDraft.input}
            onChange={(e) =>
              setPriceDraft((d) => ({ ...d, input: e.target.value }))
            }
            className={`settings-field-input ${styles.modalAddInputFlex1}`}
          />
          <input
            placeholder="出 $/1M"
            value={priceDraft.output}
            onChange={(e) =>
              setPriceDraft((d) => ({ ...d, output: e.target.value }))
            }
            className={`settings-field-input ${styles.modalAddInputFlex1}`}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={styles.modalAddBtn}
            disabled={!canAttemptSave}
            onClick={handleSavePrice}
          >
            添加
          </Button>
        </div>

        <div className={styles.modalFooter}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.modalCloseBtn}
            onClick={onClose}
          >
            关闭
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
};
