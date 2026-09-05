import React, { useState, useEffect } from 'react';
import * as Lucide from 'lucide-react';
import type { ModelPrice } from '../../api/pricingStore';
import { Button, IconButton, Tooltip, Select, Input } from '../ui';
import styles from './PriceConfigModal.module.css';

const UNIT_OPTIONS = [
  { id: 'token', value: 'token', label: 'Tokens' },
  { id: 'per_image', value: 'per_image', label: '按张' },
];

export interface EditablePriceRowProps {
  row: ModelPrice;
  currency: 'USD' | 'CNY';
  onSave: (
    newModel: string,
    input: number,
    output: number,
    cacheRead?: number,
    billingUnit?: 'token' | 'per_image'
  ) => void;
  onDelete: () => void;
}

export const EditablePriceRow: React.FC<EditablePriceRowProps> = ({
  row,
  currency,
  onSave,
  onDelete,
}) => {
  const [modelVal, setModelVal] = useState(row.model);
  const [inputVal, setInputVal] = useState(String(row.inputPerMTok));
  const [outputVal, setOutputVal] = useState(String(row.outputPerMTok));
  const [cacheReadVal, setCacheReadVal] = useState(
    row.cacheReadPerMTok !== undefined ? String(row.cacheReadPerMTok) : ''
  );
  const [unitVal, setUnitVal] = useState<'token' | 'per_image'>(row.billingUnit || 'token');

  // 当外部数据源变更时保持同步
  useEffect(() => {
    setModelVal(row.model);
    setInputVal(String(row.inputPerMTok));
    setOutputVal(String(row.outputPerMTok));
    setCacheReadVal(row.cacheReadPerMTok !== undefined ? String(row.cacheReadPerMTok) : '');
    setUnitVal(row.billingUnit || 'token');
  }, [row]);

  const hasChanged =
    modelVal.trim() !== row.model ||
    Number(inputVal) !== row.inputPerMTok ||
    Number(outputVal) !== row.outputPerMTok ||
    (cacheReadVal !== '' && Number(cacheReadVal) !== row.cacheReadPerMTok) ||
    (cacheReadVal === '' && row.cacheReadPerMTok !== undefined) ||
    unitVal !== (row.billingUnit || 'token');

  const currencySymbol = currency === 'CNY' ? '¥' : '$';
  const unitLabel = unitVal === 'per_image' ? '张' : '1M Tokens';

  return (
    <div className={styles.tableRow}>
      {/* 1. 模型名称（支持修改） */}
      <div className={styles.colCell}>
        <Tooltip content={`修改模型名称（当前: ${row.model}）`}>
          <Input
            size="xs"
            value={modelVal}
            onChange={(e) => setModelVal(e.target.value)}
            className={styles.cellInput}
            placeholder="模型 ID…"
            spellCheck={false}
            aria-label="模型名称"
          />
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
            placeholder="0.0"
            aria-label="提示词输入单价"
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
            placeholder="0.0"
            aria-label="生成补全单价"
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
            aria-label="缓存命中单价"
          />
        </Tooltip>
      </div>

      {/* 5. 计费类型：系统标准 Select 组件 */}
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
                !modelVal.trim() ||
                Number.isNaN(Number(inputVal)) ||
                Number.isNaN(Number(outputVal))
              }
              onClick={() => {
                const parsedCache =
                  cacheReadVal.trim() !== '' ? Number(cacheReadVal) : undefined;
                onSave(modelVal.trim(), Number(inputVal), Number(outputVal), parsedCache, unitVal);
              }}
            >
              保存
            </Button>
          )}
          <IconButton
            variant="ghost"
            size="sm"
            icon={<Lucide.Trash2 size={14} />}
            tooltip="删除该模型单价"
            aria-label={`删除 ${row.model}`}
            onClick={onDelete}
          />
        </div>
      </div>
    </div>
  );
};
