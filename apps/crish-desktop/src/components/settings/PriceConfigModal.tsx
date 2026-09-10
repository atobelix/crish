import React, { useMemo, useRef, useState, useEffect } from 'react';
import * as Lucide from 'lucide-react';
import {
  upsertPrice,
  savePrices,
  type ModelPrice,
} from '../../api/pricingStore';
import {
  searchCatalogModels,
  ensureModelsCatalogLoaded,
  type CatalogModelSpec,
} from '../../api/modelsCatalogStore';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import { toast } from '../../services/toast/ToastContext';
import { Button, Input, Dialog, SegmentedControl, Select } from '../ui';
import { EditablePriceRow } from './EditablePriceRow';
import styles from './PriceConfigModal.module.css';

const UNIT_OPTIONS = [
  { id: 'token', value: 'token', label: 'Tokens' },
  { id: 'per_image', value: 'per_image', label: '按张' },
];

export const PriceConfigModal: React.FC<{
  open: boolean;
  priceList: ModelPrice[];
  onListChange: (next: ModelPrice[]) => void;
  onClose: () => void;
}> = ({ open, priceList, onListChange, onClose }) => {
  const [currency, setCurrency] = useState<'USD' | 'CNY'>('CNY');
  const [priceDraft, setPriceDraft] = useState({
    model: '',
    input: '',
    output: '',
    cacheRead: '',
    billingUnit: 'token' as 'token' | 'per_image',
  });
  const [priceFilter, setPriceFilter] = useState('');
  const [showAddSuggestions, setShowAddSuggestions] = useState(false);
  const addBoxRef = useRef<HTMLDivElement | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);

  // 过滤模型
  const filteredPrices = useMemo(() => {
    const q = priceFilter.trim().toLowerCase();
    if (!q) return priceList;
    return priceList.filter((row) => row.model.toLowerCase().includes(q));
  }, [priceList, priceFilter]);

  // 挂载即确保字典镜像就绪（真源 = ~/.conex/models.yaml；幂等单飞）
  useEffect(() => {
    void ensureModelsCatalogLoaded();
  }, []);

  // 字典镜像版本变化（重载/重置）驱动联想重算
  const catalogVersion = useModelsCatalogVersion();

  // 新增输入框建议
  const addSuggestions = useMemo(() => {
    return searchCatalogModels(priceDraft.model).slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalogVersion 仅作重算信号
  }, [priceDraft.model, catalogVersion]);

  // 点击外部关闭新增建议浮层
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (addBoxRef.current && !addBoxRef.current.contains(e.target as Node)) {
        setShowAddSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  const handleSelectAddSuggestion = (spec: CatalogModelSpec) => {
    setPriceDraft({
      model: spec.model,
      // CatalogModelSpec.pricing 投影只产出规范字段（input/output/cacheRead）；
      // ModelPrice（价表存储）仍用 *PerMTok 旧名——在边界处映射
      input: String(spec.pricing?.input ?? 0),
      output: String(spec.pricing?.output ?? 0),
      cacheRead:
        spec.pricing?.cacheRead !== undefined
          ? String(spec.pricing.cacheRead)
          : '',
      billingUnit: spec.pricing?.billingUnit || 'token',
    });
    setShowAddSuggestions(false);
  };

  const draftModel = priceDraft.model.trim();
  const draftInputRaw = priceDraft.input.trim();
  const draftOutputRaw = priceDraft.output.trim();
  const canAttemptSave = Boolean(draftModel && draftInputRaw && draftOutputRaw);

  const handleAddPrice = () => {
    if (!draftModel) {
      toast.show('请填写模型 ID');
      return;
    }
    const inputNum = Number(priceDraft.input);
    const outputNum = Number(priceDraft.output);
    const cacheNum =
      priceDraft.cacheRead.trim() !== ''
        ? Number(priceDraft.cacheRead)
        : undefined;

    if (
      Number.isNaN(inputNum) ||
      Number.isNaN(outputNum) ||
      (cacheNum !== undefined && Number.isNaN(cacheNum))
    ) {
      toast.show('请填写合法的数值定价');
      return;
    }

    if (inputNum < 0 || outputNum < 0 || (cacheNum !== undefined && cacheNum < 0)) {
      toast.show('定价不能为负数');
      return;
    }

    try {
      const next = upsertPrice({
        model: draftModel,
        inputPerMTok: inputNum,
        outputPerMTok: outputNum,
        cacheReadPerMTok: cacheNum,
        currency,
        billingUnit: priceDraft.billingUnit,
      });
      onListChange(next);
      setPriceDraft({
        model: '',
        input: '',
        output: '',
        cacheRead: '',
        billingUnit: 'token',
      });
      toast.show(`已添加 ${draftModel} 单价`);
    } catch (err) {
      toast.show('保存失败：' + String(err));
    }
  };

  const currencySymbol = currency === 'CNY' ? '¥' : '$';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="模型单价配置"
      footer={
        <div className={styles.footerBar}>
          <Button type="button" variant="primary" size="sm" onClick={onClose}>
            完成
          </Button>
        </div>
      }
    >
      <div className={styles.dialogContent}>
        {/* 顶部操作区：标准高质感搜索输入框与币种切换并列 */}
        <div className={styles.topBar}>
          <Input
            variant="search"
            size="xs"
            placeholder="搜索模型…"
            value={priceFilter}
            onChange={(e) => setPriceFilter(e.target.value)}
            clearable
            onClear={() => setPriceFilter('')}
            style={{ width: '150px' }}
          />

          <div className={styles.currencySwitch}>
            <SegmentedControl
              size="xs"
              value={currency}
              onChange={(val) => setCurrency(val as 'USD' | 'CNY')}
              options={[
                { value: 'USD', label: 'USD ($)' },
                { value: 'CNY', label: 'CNY (¥)' },
              ]}
            />
          </div>
        </div>

        {/* 表头 */}
        <div className={styles.tableHeader}>
          <div>模型 ID / 名称</div>
          <div>提示输入 ({currencySymbol}/1M)</div>
          <div>生成补全 ({currencySymbol}/1M)</div>
          <div>缓存命中 ({currencySymbol}/1M)</div>
          <div>计费方式</div>
          <div className={styles.headerColAction}>操作</div>
        </div>

        {/* 列表主体 */}
        <div className={styles.tableBody}>
          {filteredPrices.length === 0 ? (
            <div className={styles.emptyTip}>暂无匹配的模型定价</div>
          ) : (
            filteredPrices.map((row) => (
              <EditablePriceRow
                key={row.model}
                row={row}
                currency={currency}
                onSave={(newModel, input, output, cacheRead, billingUnit) => {
                  let nextList: ModelPrice[];
                  // 如果修改了模型名称（仅价格表改名；字典唯一写路径在 YAML 编辑器）
                  if (newModel !== row.model) {
                    nextList = priceList.filter((p) => p.model !== row.model);
                    nextList.push({
                      ...row,
                      model: newModel,
                      inputPerMTok: input,
                      outputPerMTok: output,
                      cacheReadPerMTok: cacheRead,
                      billingUnit,
                      currency,
                    });
                  } else {
                    nextList = priceList.map((p) =>
                      p.model === row.model
                        ? {
                            ...p,
                            inputPerMTok: input,
                            outputPerMTok: output,
                            cacheReadPerMTok: cacheRead,
                            billingUnit,
                            currency,
                          }
                        : p
                    );
                  }
                  onListChange(nextList);
                  savePrices(nextList);
                  toast.show(`已更新 ${newModel} 单价`);
                }}
                onDelete={() => {
                  const next = priceList.filter((p) => p.model !== row.model);
                  onListChange(next);
                  savePrices(next);
                  toast.show(`已移除 ${row.model}`);
                }}
              />
            ))
          )}
        </div>

        {/* 底部新增行：与 tableRow 严格同轨对齐 */}
        <div className={styles.addRow} ref={addBoxRef}>
          {/* 1. 模型 ID 输入框与智能建议 */}
          <div className={`${styles.colCell} ${styles.addModelCell}`}>
            <Input
              ref={addInputRef}
              size="xs"
              placeholder="新模型 ID…"
              value={priceDraft.model}
              onChange={(e) => {
                setPriceDraft((d) => ({ ...d, model: e.target.value }));
                setShowAddSuggestions(true);
              }}
              onFocus={() => {
                setShowAddSuggestions(true);
              }}
              className={styles.cellInput}
              spellCheck={false}
            />
            {showAddSuggestions && addSuggestions.length > 0 && (
              <div
                className={styles.suggestionsDropdown}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {addSuggestions.map((item) => (
                  <div
                    key={item.model}
                    className={styles.suggestionItem}
                    onClick={() => handleSelectAddSuggestion(item)}
                  >
                    <span>{item.model}</span>
                    <span className={styles.suggestionItemMeta}>
                      {item.pricing?.billingUnit === 'per_image'
                        ? '按张'
                        : `${currencySymbol}${item.pricing?.input ?? 0}/${item.pricing?.output ?? 0}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 2. 提示输入 */}
          <div className={styles.colCell}>
            <Input
              size="xs"
              placeholder="0.0"
              value={priceDraft.input}
              onChange={(e) =>
                setPriceDraft((d) => ({ ...d, input: e.target.value }))
              }
              className={styles.cellInput}
            />
          </div>

          {/* 3. 生成补全 */}
          <div className={styles.colCell}>
            <Input
              size="xs"
              placeholder="0.0"
              value={priceDraft.output}
              onChange={(e) =>
                setPriceDraft((d) => ({ ...d, output: e.target.value }))
              }
              className={styles.cellInput}
            />
          </div>

          {/* 4. 缓存命中 */}
          <div className={styles.colCell}>
            <Input
              size="xs"
              placeholder="—"
              value={priceDraft.cacheRead}
              onChange={(e) =>
                setPriceDraft((d) => ({ ...d, cacheRead: e.target.value }))
              }
              className={styles.cellInput}
            />
          </div>

          {/* 5. 计费方式：系统标准 Select 组件 */}
          <div className={styles.colCell}>
            <Select
              size="sm"
              value={priceDraft.billingUnit}
              onChange={(val) =>
                setPriceDraft((d) => ({ ...d, billingUnit: val as 'token' | 'per_image' }))
              }
              options={UNIT_OPTIONS}
            />
          </div>

          {/* 6. 添加动作 */}
          <div className={styles.colCell}>
            <div className={styles.rowActions}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!canAttemptSave}
                onClick={handleAddPrice}
              >
                添加
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
};
