import React, { useMemo, useState, useEffect } from 'react';

import {
  listConfiguredPrices,
  setModelPrice,
  type ConfiguredPriceRow,
} from '../../api/modelPricingSource';
import { ensureModelsCatalogLoaded } from '../../api/modelsCatalogStore';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import { toast } from '../../services/toast/ToastContext';
import { Button, Input, Dialog, SegmentedControl } from '../ui';
import { EditablePriceRow } from './EditablePriceRow';
import styles from './PriceConfigModal.module.css';

/**
 * 模型单价配置弹窗。
 *
 * **名单真源 = 统一树**（`listConfiguredPrices()` → `modelsCatalogStore.modelIndex`），
 * 与模型配置界面同源 ⇒ 配置页加了模型，这里立刻多一行；模型被删除，这一行随之消失
 * （价格挂在模型上，删模型即删价）。
 *
 * 每行价格来源三分（见 `modelPricingSource.resolveEffectivePrice`）：
 * - `user`：树 `ModelSpec.pricing` 里的**用户声明**（权威）；
 * - `estimate`：出厂字典快照的**预估价**（只读参考，保存后才成为用户声明）；
 * - `none`：未收录（空值呈现，**禁止**渲染为 0）。
 *
 * 旧 localStorage 扁平价表 `crish_model_prices_v1` 已退役（迁移见
 * `modelPricingSource.migrateLegacyLsPrices`，由用量页挂载时触发）。
 */
export const PriceConfigModal: React.FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => {
  const [currency, setCurrency] = useState<'USD' | 'CNY'>('CNY');
  const [priceFilter, setPriceFilter] = useState('');
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // 树版本变化（配置页增删模型 / 本次保存成功）驱动名单重算
  const catalogVersion = useModelsCatalogVersion();

  // 挂载即确保树镜像就绪（真源 = ~/.conex/models.yaml；幂等单飞）
  useEffect(() => {
    void ensureModelsCatalogLoaded();
  }, []);

  const rows = useMemo<ConfiguredPriceRow[]>(
    () => listConfiguredPrices(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalogVersion 仅作重算信号
    [catalogVersion, open]
  );

  const filteredRows = useMemo(() => {
    const q = priceFilter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (row) =>
        row.modelId.toLowerCase().includes(q) ||
        row.providerId.toLowerCase().includes(q) ||
        row.displayName.toLowerCase().includes(q)
    );
  }, [rows, priceFilter]);

  const handleSave = async (
    row: ConfiguredPriceRow,
    input: number,
    output: number,
    cacheRead: number | undefined,
    billingUnit: 'token' | 'per_image'
  ) => {
    const key = `${row.providerId}/${row.modelId}`;
    setSavingKey(key);
    const result = await setModelPrice(row.ref, {
      currency,
      unit: billingUnit === 'per_image' ? 'per_image' : 'per_1m_tokens',
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
    });
    setSavingKey(null);
    if (result.ok) {
      toast.show(`已保存 ${key} 单价`);
    } else {
      toast.show(`保存失败：${result.error}`);
    }
  };

  const handleClear = async (row: ConfiguredPriceRow) => {
    const key = `${row.providerId}/${row.modelId}`;
    setSavingKey(key);
    const result = await setModelPrice(row.ref, undefined);
    setSavingKey(null);
    if (result.ok) {
      toast.show(`已清除 ${key} 自定义价（恢复为字典预估）`);
    } else {
      toast.show(`清除失败：${result.error}`);
    }
  };

  const currencySymbol = currency === 'CNY' ? '¥' : '$';
  const treeEmpty = rows.length === 0;

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
        {/* 顶部操作区：搜索输入框与编辑币种切换并列 */}
        <div className={styles.topBar}>
          <Input
            variant="search"
            size="xs"
            placeholder="搜索模型…"
            value={priceFilter}
            onChange={(e) => setPriceFilter(e.target.value)}
            clearable
            onClear={() => setPriceFilter('')}
            className={styles.searchInputWrapper}
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
          <div>模型（服务商 / 模型 ID）</div>
          <div>提示输入 ({currencySymbol}/1M)</div>
          <div>生成补全 ({currencySymbol}/1M)</div>
          <div>缓存命中 ({currencySymbol}/1M)</div>
          <div>计费方式</div>
          <div className={styles.headerColAction}>操作</div>
        </div>

        {/* 列表主体：名单 = 统一树 */}
        <div className={styles.tableBody}>
          {filteredRows.length === 0 ? (
            <div className={styles.emptyTip}>
              {treeEmpty
                ? '模型配置里还没有模型。请先到「模型配置」添加服务商与模型，价格会随配置自动出现。'
                : '暂无匹配的模型'}
            </div>
          ) : (
            filteredRows.map((row) => (
              <EditablePriceRow
                key={`${row.providerId}/${row.modelId}`}
                row={row}
                currency={currency}
                onSave={(input, output, cacheRead, billingUnit) =>
                  void handleSave(row, input, output, cacheRead, billingUnit)
                }
                onClear={() => void handleClear(row)}
              />
            ))
          )}
        </div>

        {savingKey && <div className={styles.emptyTip}>正在保存…</div>}
      </div>
    </Dialog>
  );
};
