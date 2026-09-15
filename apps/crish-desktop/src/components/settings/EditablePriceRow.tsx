import React, { useState, useEffect } from 'react';
import type { ConfiguredPriceRow } from '../../api/modelPricingSource';
import { Button, IconButton, Tooltip, Select, Input } from '../ui';
import styles from './PriceConfigModal.module.css';
import { AppIcon } from '../ui/icons/index';

const UNIT_OPTIONS = [
  { id: 'token', value: 'token', label: 'Tokens' },
  { id: 'per_image', value: 'per_image', label: '按张' },
];

/** 价格来源徽标文案（用户声明 / 字典预估 / 未收录）。 */
const SOURCE_LABEL: Record<'user' | 'estimate' | 'none', string> = {
  user: '用户',
  estimate: '预估',
  none: '未收录',
};

export interface EditablePriceRowProps {
  row: ConfiguredPriceRow;
  /** 编辑币种（由弹窗币种开关决定；写入时落此币种） */
  currency: 'USD' | 'CNY';
  onSave: (
    input: number,
    output: number,
    cacheRead: number | undefined,
    billingUnit: 'token' | 'per_image'
  ) => void;
  /** 清除用户声明价 → 回落字典预估（仅在有用户声明价时可用） */
  onClear: () => void;
}

/**
 * 单行价格编辑（价格页名单由统一树派生，模型身份**不可改**——改身份即改配置，
 * 属模型配置页职责）。
 *
 * 初值口径：用户声明价优先；无声明但有字典预估价时**预填预估**（需求「先根据
 * 字典生成一个预估价格」），仅在用户点击保存后才落树为用户声明。
 */
export const EditablePriceRow: React.FC<EditablePriceRowProps> = ({
  row,
  currency,
  onSave,
  onClear,
}) => {
  const initialInput =
    row.userPricing?.input ?? row.effective?.inputPerMTok ?? undefined;
  const initialOutput =
    row.userPricing?.output ?? row.effective?.outputPerMTok ?? undefined;
  const initialCacheRead =
    row.userPricing?.cacheRead ?? row.effective?.cacheReadPerMTok ?? undefined;
  const initialUnit = row.userPricing?.unit ?? row.effective?.billingUnit ?? 'token';

  const [inputVal, setInputVal] = useState(
    initialInput !== undefined ? String(initialInput) : ''
  );
  const [outputVal, setOutputVal] = useState(
    initialOutput !== undefined ? String(initialOutput) : ''
  );
  const [cacheReadVal, setCacheReadVal] = useState(
    initialCacheRead !== undefined ? String(initialCacheRead) : ''
  );
  const [unitVal, setUnitVal] = useState<'token' | 'per_image'>(
    initialUnit === 'per_image' ? 'per_image' : 'token'
  );

  // 外部数据源（树版本 / 快照版本）变更时同步初值
  useEffect(() => {
    setInputVal(initialInput !== undefined ? String(initialInput) : '');
    setOutputVal(initialOutput !== undefined ? String(initialOutput) : '');
    setCacheReadVal(
      initialCacheRead !== undefined ? String(initialCacheRead) : ''
    );
    setUnitVal(initialUnit === 'per_image' ? 'per_image' : 'token');
  }, [initialInput, initialOutput, initialCacheRead, initialUnit]);

  const parsedCache = cacheReadVal.trim() !== '' ? Number(cacheReadVal) : undefined;
  const parsedInput = inputVal.trim() !== '' ? Number(inputVal) : undefined;
  const parsedOutput = outputVal.trim() !== '' ? Number(outputVal) : undefined;
  // 空值与「未声明」等价：未收录行不得因空串被误判为「已修改」
  const hasChanged =
    parsedInput !== initialInput ||
    parsedOutput !== initialOutput ||
    parsedCache !== initialCacheRead ||
    unitVal !== (initialUnit === 'per_image' ? 'per_image' : 'token');

  const source: 'user' | 'estimate' | 'none' = row.effective?.source ?? 'none';
  const sourceCurrency = row.effective?.currency ?? currency;
  const currencySymbol = sourceCurrency === 'CNY' ? '¥' : '$';
  const unitLabel = unitVal === 'per_image' ? '张' : '1M Tokens';
  const rowKey = `${row.providerId}/${row.modelId}`;

  return (
    <div className={styles.tableRow} data-testid={`price-row-${rowKey}`}>
      {/* 1. 模型身份（只读：名单真源 = 统一树；改身份请去模型配置） */}
      <div className={styles.colCell}>
        <div className={styles.modelIdentity}>
          <span className={styles.modelName}>{row.displayName}</span>
          <span className={styles.modelMeta}>{`${row.providerName} · ${row.modelId}`}</span>
        </div>
        <Tooltip
          content={
            source === 'user'
              ? '价格来自你在模型配置里的声明（权威）'
              : source === 'estimate'
                ? '价格来自出厂字典预估（参考值，保存后成为你的声明）'
                : '出厂字典未收录该模型价格'
          }
        >
          <span
            className={`${styles.sourceBadge} ${styles[`source_${source}`]}`}
            data-source={source}
          >
            {SOURCE_LABEL[source]} · {sourceCurrency}
          </span>
        </Tooltip>
      </div>

      {/* 2. 提示词输入单价 */}
      <div className={styles.colCell}>
        <Tooltip content={`提示词输入单价 (${currencySymbol}/${unitLabel})`}>
          <Input
            size="xs"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            className={styles.cellInput}
            placeholder="未收录"
            aria-label={`${rowKey} 提示词输入单价`}
          />
        </Tooltip>
      </div>

      {/* 3. 生成补全单价 */}
      <div className={styles.colCell}>
        <Tooltip content={`生成补全单价 (${currencySymbol}/${unitLabel})`}>
          <Input
            size="xs"
            value={outputVal}
            onChange={(e) => setOutputVal(e.target.value)}
            className={styles.cellInput}
            placeholder="未收录"
            aria-label={`${rowKey} 生成补全单价`}
          />
        </Tooltip>
      </div>

      {/* 4. 缓存命中单价 */}
      <div className={styles.colCell}>
        <Tooltip content={`缓存命中单价 (${currencySymbol}/${unitLabel})`}>
          <Input
            size="xs"
            value={cacheReadVal}
            onChange={(e) => setCacheReadVal(e.target.value)}
            className={styles.cellInput}
            placeholder="—"
            aria-label={`${rowKey} 缓存命中单价`}
          />
        </Tooltip>
      </div>

      {/* 5. 计费类型 */}
      <div className={styles.colCell}>
        <Select
          size="sm"
          value={unitVal}
          onChange={(val) => setUnitVal(val as 'token' | 'per_image')}
          options={UNIT_OPTIONS}
        />
      </div>

      {/* 6. 操作区 */}
      <div className={styles.colCell}>
        <div className={styles.rowActions}>
          {hasChanged && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={
                parsedInput === undefined ||
                parsedOutput === undefined ||
                Number.isNaN(parsedInput) ||
                Number.isNaN(parsedOutput)
              }
              onClick={() =>
                onSave(parsedInput!, parsedOutput!, parsedCache, unitVal)
              }
            >
              保存
            </Button>
          )}
          {source === 'user' && (
            <IconButton
              aria-label={`清除 ${rowKey} 自定义单价`}
              variant="ghost"
              size="sm"
              tooltip="清除自定义价（恢复为字典预估）"
              onClick={onClear}
              icon={<AppIcon name="trash" size={14} />}
            />
          )}
        </div>
      </div>
    </div>
  );
};
