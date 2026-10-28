import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ConfiguredPriceRow } from '../../api/modelPricingSource';
import type { PricingConfig } from '../../api/modelsCatalogTypes';
import { IconButton, Tooltip, Input } from '@/components/ui';
import styles from './PriceConfigModal.module.css';
import { AppIcon } from '@/components/ui/icons';

/** 编辑即保存的防抖窗口（毫秒）。导出供用例以假定时器对齐。 */
export const AUTO_SAVE_DEBOUNCE_MS = 500;

/** 计费模式只读文案（模式由模型能力派生，用户不选）。 */
const BILLING_LABEL: Record<ConfiguredPriceRow['billingMode'], string> = {
  per_1m_tokens: '按 Token',
  per_image: '按张生成',
};

export interface EditablePriceRowProps {
  row: ConfiguredPriceRow;
  /** 编辑币种（由弹窗币种开关决定；写入时落此币种） */
  currency: 'USD' | 'CNY';
  /** 编辑即保存：防抖后落树，**无保存按钮** */
  onSave: (
    pricing: PricingConfig
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 清除用户声明价 → 回落字典预估（仅在有用户声明价时可用） */
  onClear: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

/** 数字文本 → 有限非负数；空串 / 非法 / 负数一律 `undefined`（未声明 ≠ 0）。 */
function toNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function toText(value: number | undefined): string {
  return value !== undefined ? String(value) : '';
}

/**
 * 以树中既有声明为基线组装待写价：**未在本页编辑的字段原样保留**
 * （`cacheWrite` / `tiers` / 另一计费模式的价），避免编辑一个字段就抹掉其余声明。
 */
function buildPricing(
  base: PricingConfig | undefined,
  currency: 'USD' | 'CNY',
  mode: ConfiguredPriceRow['billingMode'],
  draft: {
    input: string;
    output: string;
    cacheRead: string;
    perImage: string;
  }
): PricingConfig {
  const next: PricingConfig = { ...(base ?? {}), currency, unit: mode };
  if (mode === 'per_image') {
    const perImage = toNumber(draft.perImage);
    if (perImage === undefined) delete next.perImage;
    else next.perImage = perImage;
    return next;
  }
  const input = toNumber(draft.input);
  const output = toNumber(draft.output);
  const cacheRead = toNumber(draft.cacheRead);
  if (input === undefined) delete next.input;
  else next.input = input;
  if (output === undefined) delete next.output;
  else next.output = output;
  if (cacheRead === undefined) delete next.cacheRead;
  else next.cacheRead = cacheRead;
  return next;
}

/**
 * 单行价格编辑（价格页名单由统一树派生，模型身份**不可改**——改身份即改配置，
 * 属模型配置页职责）。
 *
 * ## 编辑即保存（用户裁决 2026-09-15）
 *
 * 本行**没有保存按钮**：输入变化 → 防抖 [AUTO_SAVE_DEBOUNCE_MS] → 落树；
 * 失焦立即落树（覆盖「输入后马上点别处 / 关弹窗」）。
 *
 * ## 计费模式只读
 *
 * 计费模式 = 模型能力派生（`modalities.output` 含 `image` ⇒ 按张生成），
 * 见 `modelPricingSource.deriveBillingMode`。用户**不再手选**；生图模型自动
 * 套用按张价（只呈现 `perImage` 一个输入），Token 单价列呈现为「不适用」。
 *
 * ## 初值口径
 *
 * 用户声明价优先；无声明但有字典预估价时**预填预估**（需求「先根据字典生成一个
 * 预估价格」）。预填不等于落树——用户不改动即不写盘（字典只做参考）。
 */
export const EditablePriceRow: React.FC<EditablePriceRowProps> = ({
  row,
  currency,
  onSave,
  onClear,
}) => {
  const isPerImage = row.billingMode === 'per_image';

  const initialInput = row.userPricing?.input ?? row.effective?.inputPerMTok;
  const initialOutput = row.userPricing?.output ?? row.effective?.outputPerMTok;
  const initialCacheRead =
    row.userPricing?.cacheRead ?? row.effective?.cacheReadPerMTok;
  const initialPerImage = row.userPricing?.perImage;

  const [inputVal, setInputVal] = useState(toText(initialInput));
  const [outputVal, setOutputVal] = useState(toText(initialOutput));
  const [cacheReadVal, setCacheReadVal] = useState(toText(initialCacheRead));
  const [perImageVal, setPerImageVal] = useState(toText(initialPerImage));

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 外部数据源（树版本 / 快照版本）变更时同步初值。
  // 用户正在编辑（dirty）时**不得**覆盖其输入——树版本会因其他行保存而抖动。
  useEffect(() => {
    if (dirty) return;
    setInputVal(toText(initialInput));
    setOutputVal(toText(initialOutput));
    setCacheReadVal(toText(initialCacheRead));
    setPerImageVal(toText(initialPerImage));
  }, [dirty, initialInput, initialOutput, initialCacheRead, initialPerImage]);

  // 回调与行数据放入 ref：防抖 effect 的依赖只保留草稿值，
  // 避免父级重渲染 / 树版本抖动反复重置定时器导致永不落盘。
  const onSaveRef = useRef(onSave);
  const onClearRef = useRef(onClear);
  const rowRef = useRef(row);
  useEffect(() => {
    onSaveRef.current = onSave;
    onClearRef.current = onClear;
    rowRef.current = row;
  });

  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    },
    []
  );

  const draft = useMemo(
    () => ({
      input: inputVal,
      output: outputVal,
      cacheRead: cacheReadVal,
      perImage: perImageVal,
    }),
    [inputVal, outputVal, cacheReadVal, perImageVal]
  );

  /**
   * 草稿是否构成一条**可写**的价。
   * 判据与 `modelPricingSource.fromSnapshot` 一致：Token 模式缺输入或输出即
   * 「不足以构成一条可用价」（未配置 ≠ 0，禁止补零冒充）；生图模式只认按张价。
   */
  const writable = isPerImage
    ? toNumber(perImageVal) !== undefined
    : toNumber(inputVal) !== undefined && toNumber(outputVal) !== undefined;

  const commit = useCallback(async () => {
    const current = rowRef.current;
    setSaving(true);
    setError(null);
    const pricing = buildPricing(
      current.userPricing,
      currency,
      current.billingMode,
      draft
    );
    const result = await onSaveRef.current(pricing);
    setSaving(false);
    if (result.ok) {
      setDirty(false);
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 1500);
    } else {
      // 保留用户输入（dirty 不落），错误显式呈现，不静默降级
      setError(result.error);
    }
  }, [currency, draft]);

  // 编辑即保存：草稿变化 → 防抖落树
  useEffect(() => {
    if (!dirty || !writable) return;
    const timer = setTimeout(() => {
      void commit();
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [commit, dirty, writable]);

  const handleClear = async () => {
    setSaving(true);
    setError(null);
    const result = await onClearRef.current();
    setSaving(false);
    if (result.ok) {
      setDirty(false);
      setSaved(false);
    } else {
      setError(result.error);
    }
  };

  const source: 'user' | 'estimate' | 'none' = row.effective?.source ?? 'none';
  const sourceCurrency = row.effective?.currency ?? currency;
  const currencySymbol = sourceCurrency === 'CNY' ? '¥' : '$';
  const rowKey = `${row.providerId}/${row.modelId}`;

  /** 价格输入：任何键入都标记 dirty（是否落盘由 writable + 防抖决定）。 */
  const onEdit = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setDirty(true);
    setSaved(false);
    setError(null);
  };

  return (
    <div className={styles.tableRow} data-testid={`price-row-${rowKey}`}>
      {/* 1. 模型 */}
      <div className={styles.colCell}>
        <Tooltip content={`模型 ID：${row.modelId}`}>
          <span
            className={styles.identityText}
            data-testid={`price-row-model-${rowKey}`}
          >
            {row.displayName}
          </span>
        </Tooltip>
      </div>

      {/* 2. 服务商 */}
      <div className={styles.colCell}>
        <Tooltip content={`服务商 ID：${row.providerId}`}>
          <span
            className={styles.identityText}
            data-testid={`price-row-provider-${rowKey}`}
          >
            {row.providerName}
          </span>
        </Tooltip>
      </div>

      {/* 3. 提示输入单价（Token 模式）／按张单价（生图模式） */}
      <div className={styles.colCell}>
        {isPerImage ? (
          <Tooltip content={`按张生成单价 (${currencySymbol}/张)`}>
            <Input
              size="xs"
              value={perImageVal}
              onChange={(e) => onEdit(setPerImageVal)(e.target.value)}
              className={styles.cellInput}
              aria-label={`${rowKey} 按张生成单价`}
            />
          </Tooltip>
        ) : (
          <Tooltip content={`提示词输入单价 (${currencySymbol}/1M Tokens)`}>
            <Input
              size="xs"
              value={inputVal}
              onChange={(e) => onEdit(setInputVal)(e.target.value)}
              className={styles.cellInput}
              aria-label={`${rowKey} 提示词输入单价`}
            />
          </Tooltip>
        )}
      </div>

      {/* 4. 生成补全单价（生图模式不适用） */}
      <div className={styles.colCell}>
        {isPerImage ? (
          <span className={styles.notApplicable}>—</span>
        ) : (
          <Tooltip content={`生成补全单价 (${currencySymbol}/1M Tokens)`}>
            <Input
              size="xs"
              value={outputVal}
              onChange={(e) => onEdit(setOutputVal)(e.target.value)}
              className={styles.cellInput}
              aria-label={`${rowKey} 生成补全单价`}
            />
          </Tooltip>
        )}
      </div>

      {/* 5. 缓存命中单价（生图模式不适用） */}
      <div className={styles.colCell}>
        {isPerImage ? (
          <span className={styles.notApplicable}>—</span>
        ) : (
          <Tooltip content={`缓存命中单价 (${currencySymbol}/1M Tokens)`}>
            <Input
              size="xs"
              value={cacheReadVal}
              onChange={(e) => onEdit(setCacheReadVal)(e.target.value)}
              className={styles.cellInput}
              aria-label={`${rowKey} 缓存命中单价`}
            />
          </Tooltip>
        )}
      </div>

      {/* 6. 计费方式（只读：由模型能力派生，用户不选） */}
      <div className={styles.colCell}>
        <span
          className={styles.billingMode}
          data-billing={row.billingMode}
          data-testid={`price-row-billing-${rowKey}`}
        >
          {BILLING_LABEL[row.billingMode]}
        </span>
      </div>

      {/* 7. 操作区：无保存按钮（编辑即保存）；仅保留清除与状态 */}
      <div className={styles.colCell}>
        <div className={styles.rowActions}>
          {saving && <span className={styles.rowStatus}>保存中…</span>}
          {!saving && saved && <span className={styles.rowStatus}>已保存</span>}
          {!saving && error && (
            <span
              className={styles.rowStatusError}
              data-testid={`price-row-error-${rowKey}`}
            >
              {error}
            </span>
          )}
          {source === 'user' && (
            <IconButton
              aria-label={`清除 ${rowKey} 自定义单价`}
              variant="ghost"
              size="sm"
              tooltip="清除自定义价（恢复为字典预估）"
              onClick={() => void handleClear()}
              icon={<AppIcon name="trash" size={14} />}
            />
          )}
        </div>
      </div>
    </div>
  );
};
