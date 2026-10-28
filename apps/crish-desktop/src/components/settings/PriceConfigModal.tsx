import React, { useCallback, useMemo, useState, useEffect } from 'react';

import {
  listConfiguredPrices,
  setModelPrice,
  type ConfiguredPriceRow,
} from '../../api/modelPricingSource';
import type { PricingConfig } from '../../api/modelsCatalogTypes';
import { ensureModelsCatalogLoaded } from '../../api/modelsCatalogStore';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import { toast } from '../../services/toast/ToastContext';
import { Button, Input, Dialog, SegmentedControl } from '@/components/ui';
import { EditablePriceRow } from './EditablePriceRow';
import styles from './PriceConfigModal.module.css';

type SaveResult = { ok: true } | { ok: false; error: string };

/**
 * 模型单价配置弹窗。
 *
 * **名单真源 = 统一树**（`listConfiguredPrices()` → `modelsCatalogStore.modelIndex`），
 * 与模型配置界面同源 ⇒ 配置页加了模型，这里立刻多一行；模型被删除，这一行随之消失
 * （价格挂在模型上，删模型即删价）。
 *
 * ## 交互口径（用户裁决 2026-09-15）
 *
 * - **编辑即保存**：行内无保存按钮，输入变化防抖后直接落树（`EditablePriceRow`）。
 * - **不展示价格来源徽标**：不再渲染「用户 / 预估 / 未收录」角标；「有自定义价」
 *   由该行是否出现清除入口隐式表达（无自定义价即无入口）。
 * - **输入框不提示收录状态**：不再用 placeholder 表达「未收录」，空值即空。
 * - **计费方式只读**：由模型能力派生（`modalities.output` 含 `image` ⇒ 按张生成），
 *   生图模型自动套用按张价；用户不再手选。
 * - **模型与服务商分列**：两个独立表头，不再挤在同一个单元格里。
 *
 * 旧 localStorage 扁平价表 `crish_model_prices_v1` 已退役（迁移见
 * `modelPricingSource.migrateLegacyLsPrices`，启动期执行）。
 */
export const PriceConfigModal: React.FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => {
  const [currency, setCurrency] = useState<'USD' | 'CNY'>('CNY');
  const [priceFilter, setPriceFilter] = useState('');

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

  /** 编辑即保存的落盘点（行内防抖后调用；失败显式提示，不静默降级）。 */
  const handleSave = useCallback(
    async (
      row: ConfiguredPriceRow,
      pricing: PricingConfig
    ): Promise<SaveResult> => {
      const result = await setModelPrice(row.ref, pricing);
      if (!result.ok) {
        toast.show(
          `保存失败（${row.providerId}/${row.modelId}）：${result.error}`
        );
        return { ok: false, error: result.error };
      }
      return { ok: true };
    },
    []
  );

  const handleClear = useCallback(
    async (row: ConfiguredPriceRow): Promise<SaveResult> => {
      const result = await setModelPrice(row.ref, undefined);
      if (!result.ok) {
        toast.show(
          `清除失败（${row.providerId}/${row.modelId}）：${result.error}`
        );
        return { ok: false, error: result.error };
      }
      return { ok: true };
    },
    []
  );

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

        {/* 表头：模型与服务商分列 */}
        <div className={styles.tableHeader}>
          <div data-testid="price-header-model">模型</div>
          <div data-testid="price-header-provider">服务商</div>
          <div data-testid="price-header-input">
            提示输入 ({currencySymbol}/1M)
          </div>
          <div data-testid="price-header-output">
            生成补全 ({currencySymbol}/1M)
          </div>
          <div data-testid="price-header-cache">
            缓存命中 ({currencySymbol}/1M)
          </div>
          <div data-testid="price-header-billing">计费方式</div>
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
                onSave={(pricing) => handleSave(row, pricing)}
                onClear={() => handleClear(row)}
              />
            ))
          )}
        </div>

        {/* 底部自动保存说明 */}
        <div className={styles.footHint}>改动实时自动保存。</div>
      </div>
    </Dialog>
  );
};
