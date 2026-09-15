/**
 * pricingStore hub — Token pricing 装配层（T4-11 SR-06-R1 拆分后；
 * 战役 docs/provider-single-track-convergence/ 阶段 3 静态表清零 + 价格轨合流）。
 *
 * 本文件为拆分后的 hub（re-export + 装配），保持所有消费方 import 路径不变。
 * 子模块职责：
 * - pricingTypes.ts：类型契约 + 常量（**无任何出厂价副本**）
 * - pricingResolver.ts：出厂字典快照状态 + 按模型 id 精确查表（字典内 id 唯一）
 * - modelPricingSource.ts：**用户声明价唯一读口**（统一树 `ModelSpec.pricing`）
 *   + 价格页名单投影 + 旧 LS 价表一次性迁移
 * - pricingStore.ts（本文件）：4D 解析/估算 + 缓存选项/TTL
 *
 * 定价唯一源（裁决：用户声明覆盖 + 出厂字典预估兜底）：
 *   树 `ModelSpec.pricing`（用户声明，权威）→ 出厂字典快照（**预估**，只读参考）
 *   → `null`（未收录）。
 * 旧 localStorage 扁平价表 `crish_model_prices_v1` **退役**（`loadPrices` /
 * `savePrices` / `upsertPrice` / `hasUserSavedPrices` 已删除，键常量保留供
 * `modelPricingSource.migrateLegacyLsPrices` 一次性迁移使用）。
 *
 * 真源唯一性（裁决 ①）：出厂数据唯一来源 = 出厂能力字典（Rust `catalog.json`，
 * 编译期打包），经 `workbench_read_capability_dictionary` 注入运行时快照。
 * 前端**零本地副本**：`pricingCatalogData*.ts` 六份静态表与 `DEFAULT_PRICES`
 * 已物理删除。
 *
 * 身份与「未收录」（裁决 ③ + 阶段 3 关键不变量）：模型身份 =
 * `(providerId, modelId)` 二元组；树未声明且快照未注入/未命中 = 「未收录」，
 * 估算函数返回 **`null`**（`0` 只表示「已知且确实为 0 成本」，如写免费条目）。
 *
 * 顶部注释（v2/v3/v4/v5 裁决全文）见 pricingTypes.ts。
 */

// ── re-export：类型契约与常量 ──────────────────────────────────────────────
export type {
  ModelPrice,
  Currency,
  CacheTtlMode,
  CachePriceOpts,
  CatalogTier,
  CatalogSnapshotPrice,
  CatalogCacheSnapshot,
  Resolved4dPrices,
} from './pricingTypes';

// ── re-export：常量 ────────────────────────────────────────────────────────
export {
  PRICES_KEY,
  CACHE_OPTS_KEY,
  CACHE_TTL_MODE_KEY,
  DEFAULT_CACHE_READ_MULTIPLIER,
  DEFAULT_CACHE_WRITE_MULTIPLIER,
  DEFAULT_CACHE_TTL_MODE,
} from './pricingTypes';

// ── re-export：出厂字典快照解析器与快照状态 ────────────────────────────────
export { resolveSnapshotPrice } from './pricingResolver';
export { applyCatalogCacheSnapshot } from './pricingResolver';
export { clearCatalogCacheSnapshot } from './pricingResolver';
export { catalogSnapshotVersion } from './pricingResolver';
export { resolveCatalogCachePrices } from './pricingResolver';

// ── 本 hub 实现：树用户声明价消费 + 估算 + 缓存选项 ────────────────────────
import type { ModelRef } from './modelsCatalogTypes';
import {
  CACHE_OPTS_KEY,
  CACHE_TTL_MODE_KEY,
  DEFAULT_CACHE_READ_MULTIPLIER,
  DEFAULT_CACHE_WRITE_MULTIPLIER,
  DEFAULT_CACHE_TTL_MODE,
  type ModelPrice,
  type CachePriceOpts,
  type CacheTtlMode,
  type Currency,
  type CatalogTier,
  type Resolved4dPrices,
} from './pricingTypes';
import { resolveSnapshotPrice } from './pricingResolver';
import { resolveUserPricing } from './modelPricingSource';

/**
 * 用户声明价查找（树 `ModelSpec.pricing` 投影为 `ModelPrice` 形状）。
 *
 * **唯一**用户价来源 = 统一树（旧 LS 扁平价表已退役）；无声明 → `null`。
 * 声明未给出输入/输出单价时同样返回 `null` —— `ModelPrice` 的两个必填字段
 * 在树侧缺省即「未配置」，与「0 费率」语义不同，**禁止补零**（补零会被 UI
 * 渲染成免费，比空白更危险）；此场景下回退链自然落到字典预估。
 *
 * 身份：`(providerId, modelId)` 二元组（`modelRefKey`）；**禁止** substring /
 * 模糊回退（裁决 ③）。
 */
export function resolveModelPrice(ref: ModelRef): ModelPrice | null {
  const pricing = resolveUserPricing(ref);
  if (!pricing) return null;
  if (pricing.input === undefined || pricing.output === undefined) return null;
  return {
    model: ref.modelId,
    inputPerMTok: pricing.input,
    outputPerMTok: pricing.output,
    cacheReadPerMTok: pricing.cacheRead,
    cacheWritePerMTok: pricing.cacheWrite,
    currency: pricing.currency,
    billingUnit:
      pricing.unit === undefined
        ? undefined
        : pricing.unit === 'per_image'
          ? 'per_image'
          : 'token',
    perImageCost: pricing.perImage,
  };
}

/**
 * 查询模型币种（v4；供展示层标注，不做汇率换算）。
 * 优先级：树用户声明 currency（用户可覆盖）→ 出厂字典快照 currency
 * → null（未知 / 未收录）。**不得**猜测币种。
 */
export function getModelCurrency(ref: ModelRef): Currency | null {
  const user = resolveUserPricing(ref);
  if (user?.currency) return user.currency;
  return resolveSnapshotPrice(ref)?.currency ?? null;
}

/**
 * 2D 估算：不考虑 cache（向下兼容）。
 * 回退链：树用户声明 → 出厂字典快照（预估）。
 * 返回值 = 模型自身币种金额（CNY 模型为人民币），展示层用 getModelCurrency 标注；
 * **未收录 → `null`**（禁止返回 0 冒充「免费」）。
 */
export function estimateCostUsd(
  ref: ModelRef,
  inputTokens: number,
  outputTokens: number
): number | null {
  const p = resolve4dPricesForTokens(ref, inputTokens);
  if (!p) return null;
  return (
    (inputTokens / 1e6) * p.inputPerMTok +
    (outputTokens / 1e6) * p.outputPerMTok
  );
}

/**
 * 四指标价格解析（v5 回退链 + 价格轨合流）：
 *   输入/输出价：树用户声明（覆盖）→ 出厂字典快照（预估兜底）→ null（未收录）。
 *   缓存读价：树用户声明 → 出厂字典快照 → 全局乘数。
 *   缓存写价：树用户声明 → 出厂字典快照（写免费 → 0；TTL=1h 且有条目 1h 档 →
 *     用 1h 写价）→ 全局乘数。
 * 用户声明**逐字段**覆盖（用户声明权威：已声明字段一律直取，不因字典有值而让位）；
 * 未声明字段才落字典。存储费不入前端（服务端核算）；tieredPricing 档位匹配见
 * [resolve4dPricesForTokens]。**无静态表分支**：快照缺席即未收录。
 */
export function resolve4dPrices(ref: ModelRef): Resolved4dPrices | null {
  const user = resolveUserPricing(ref);
  const snap = resolveSnapshotPrice(ref);
  const opts = loadCachePriceOpts();

  const inputPerMTok = user?.input ?? snap?.inputPerMTok;
  const outputPerMTok = user?.output ?? snap?.outputPerMTok;
  if (inputPerMTok == null || outputPerMTok == null) return null;

  const currency: Currency = user?.currency ?? snap?.currency ?? 'USD';
  const ttlMode = loadCacheTtlMode();

  let source: Resolved4dPrices['source'] = 'multiplier';

  // 缓存读价回退链
  let cacheReadPerMTok: number;
  if (user?.cacheRead != null) {
    cacheReadPerMTok = user.cacheRead;
    source = 'user';
  } else if (snap?.readPerMTok != null) {
    cacheReadPerMTok = snap.readPerMTok;
    source = 'snapshot';
  } else {
    cacheReadPerMTok = inputPerMTok * opts.cacheReadMultiplier;
  }

  // 缓存写价回退链（source 以写价来源为准）
  const hasWrite1hTier = snap?.writePerMTok1h != null;
  let cacheWritePerMTok: number;
  let cacheWriteFree = false;
  if (user?.cacheWrite != null) {
    cacheWritePerMTok = user.cacheWrite;
    source = 'user';
  } else if (snap) {
    const snapWrite = snap.writePerMTok5m ?? snap.writePerMTok;
    if (snap.writeFree === true) {
      cacheWriteFree = true;
      cacheWritePerMTok = 0;
      source = 'snapshot';
    } else if (snapWrite != null) {
      cacheWritePerMTok = snapWrite;
      source = 'snapshot';
    } else {
      cacheWritePerMTok = inputPerMTok * opts.cacheWriteMultiplier;
    }
    if (hasWrite1hTier && ttlMode === '1h') {
      cacheWritePerMTok = snap.writePerMTok1h!;
    }
  } else {
    cacheWritePerMTok = inputPerMTok * opts.cacheWriteMultiplier;
  }

  return {
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok,
    cacheWritePerMTok,
    cacheWriteFree,
    currency,
    source,
    hasWrite1hTier,
  };
}

/**
 * 输入长度分档命中（P1B / DEEPCHECK-05 #8 前端消费面）：
 * 档位来自出厂字典快照（唯一来源）；半开区间 [minTokens, maxTokens)，
 * maxTokens 缺省 = 无上界。无档 / 不落档 / 未收录 → null（沿用基础四价）。
 */
export function resolveTierForTokens(
  ref: ModelRef,
  inputTokens: number
): CatalogTier | null {
  const tiers = resolveSnapshotPrice(ref)?.tiered;
  if (!tiers || tiers.length === 0) return null;
  return (
    tiers.find(
      (t) =>
        inputTokens >= t.minTokens &&
        (t.maxTokens === undefined || inputTokens < t.maxTokens)
    ) ?? null
  );
}

/**
 * 分档四价解析：基础 [resolve4dPrices] 结果上按估算 input 长度落档，
 * 档内覆盖价替换（未覆盖字段沿用基础价）。
 *
 * 判据**按模型**：该模型在树里有 `pricing` 声明 ⇒ 整条不落档（用户显式定价
 * 覆盖目录全部语义，含分档）；无声明（含仅有字典预估）⇒ 字典档位照常生效。
 * 旧实现的全局判据「LS 价表键存在性」已随价表退役删除——那会让任一模型的
 * 价格编辑影响**所有**模型的分档语义。
 */
export function resolve4dPricesForTokens(
  ref: ModelRef,
  inputTokens: number
): Resolved4dPrices | null {
  const base = resolve4dPrices(ref);
  if (!base) return null;
  // 树用户声明命中 → 用户覆盖，跳过档位匹配
  if (resolveUserPricing(ref)) return base;
  const tier = resolveTierForTokens(ref, inputTokens);
  if (!tier) return base;
  return {
    ...base,
    inputPerMTok: tier.inputPerMTok ?? base.inputPerMTok,
    outputPerMTok: tier.outputPerMTok ?? base.outputPerMTok,
    cacheReadPerMTok: tier.cacheReadPerMTok ?? base.cacheReadPerMTok,
    cacheWritePerMTok: tier.cacheWritePerMTok ?? base.cacheWritePerMTok,
  };
}

/**
 * 4D 估算：区分 cache hit/write 与普通 input 的不同费率。
 *
 * 公式（v4 四指标，任务书 §3）：
 *   nonCached = max(0, prompt - cacheRead - cacheWrite)
 *   cost = nonCached * Pin + completion * Pout
 *        + cacheWrite * Pcw + cacheRead * Pcr
 *
 * Pcr/Pcw 由 resolve4dPrices 按回退链解析：
 *   树用户声明（覆盖）→ 出厂字典快照（写免费 → 0；TTL=1h 时用 Anthropic 1h 档）
 *   → 全局乘数兜底（× Pin）。
 * **未收录 → `null`**（阶段 3 关键不变量：不得返回 0 —— 0 会被 UI 渲染成
 * 「免费」，比空白更危险；0 仅表示已知且确实为 0 成本）。
 * P1B：按估算 input 长度（promptTokens）落 tieredPricing 档，超档用高档价
 * （DEEPCHECK-05 #8：长上下文成本低估 ≈45% 修复）。
 * 返回值 = 模型自身币种金额（CNY 模型为人民币；函数名 Usd 为历史遗留，
 * 展示层用 getModelCurrency() 标注币种）。
 */
export function estimateCostUsd4d(
  ref: ModelRef,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
): number | null {
  const p = resolve4dPricesForTokens(ref, promptTokens);
  if (!p) return null;

  const nonCached = Math.max(
    0,
    promptTokens - cacheReadTokens - cacheWriteTokens
  );
  return (
    (nonCached / 1e6) * p.inputPerMTok +
    (completionTokens / 1e6) * p.outputPerMTok +
    (cacheWriteTokens / 1e6) * p.cacheWritePerMTok +
    (cacheReadTokens / 1e6) * p.cacheReadPerMTok
  );
}

/**
 * 估算缓存节省的费用：max(0, 全量 2D 成本 - 4D 实际成本)。
 * 2D/4D 同币种口径（模型自身币种），差值同币种。
 * **任一侧未收录 → `null`**（不得以 0 表示「省了 0 元」）。
 */
export function estimateSavingsUsd(
  ref: ModelRef,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
): number | null {
  const full = estimateCostUsd(ref, promptTokens, completionTokens);
  const actual = estimateCostUsd4d(
    ref,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens
  );
  if (full == null || actual == null) return null;
  return Math.max(0, full - actual);
}

/** 加载 cache 费率选项，缺失则返回默认值 */
export function loadCachePriceOpts(): CachePriceOpts {
  try {
    const raw = localStorage.getItem(CACHE_OPTS_KEY);
    if (!raw)
      return {
        cacheReadMultiplier: DEFAULT_CACHE_READ_MULTIPLIER,
        cacheWriteMultiplier: DEFAULT_CACHE_WRITE_MULTIPLIER,
      };
    const o = JSON.parse(raw) as Partial<CachePriceOpts>;
    const read =
      typeof o.cacheReadMultiplier === 'number' && o.cacheReadMultiplier > 0
        ? o.cacheReadMultiplier
        : DEFAULT_CACHE_READ_MULTIPLIER;
    const write =
      typeof o.cacheWriteMultiplier === 'number' && o.cacheWriteMultiplier > 0
        ? o.cacheWriteMultiplier
        : DEFAULT_CACHE_WRITE_MULTIPLIER;
    return { cacheReadMultiplier: read, cacheWriteMultiplier: write };
  } catch {
    return {
      cacheReadMultiplier: DEFAULT_CACHE_READ_MULTIPLIER,
      cacheWriteMultiplier: DEFAULT_CACHE_WRITE_MULTIPLIER,
    };
  }
}

/**
 * 保存 cache 费率选项。非正数/NaN 值回落到默认值。
 * @returns 实际保存的选项（用于校验）
 */
export function saveCachePriceOpts(
  opts: Partial<CachePriceOpts>
): CachePriceOpts {
  const read =
    typeof opts.cacheReadMultiplier === 'number' && opts.cacheReadMultiplier > 0
      ? opts.cacheReadMultiplier
      : DEFAULT_CACHE_READ_MULTIPLIER;
  const write =
    typeof opts.cacheWriteMultiplier === 'number' &&
    opts.cacheWriteMultiplier > 0
      ? opts.cacheWriteMultiplier
      : DEFAULT_CACHE_WRITE_MULTIPLIER;
  const normalized: CachePriceOpts = {
    cacheReadMultiplier: read,
    cacheWriteMultiplier: write,
  };
  try {
    localStorage.setItem(CACHE_OPTS_KEY, JSON.stringify(normalized));
  } catch {
    /* ignore */
  }
  return normalized;
}

/**
 * 加载缓存 TTL 档（v4；决定 Anthropic 写价取 5m 还是 1h 档）。
 * 默认 '5m'；非法值回落默认。MiniMax 等无 1h 档字段的模型不受影响。
 */
export function loadCacheTtlMode(): CacheTtlMode {
  try {
    const raw = localStorage.getItem(CACHE_TTL_MODE_KEY);
    if (raw === '5m' || raw === '1h') return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_CACHE_TTL_MODE;
}

/**
 * 保存缓存 TTL 档（'5m' | '1h'；其余值归一为默认）。
 * @returns 实际保存的档位（用于校验）
 */
export function saveCacheTtlMode(mode: CacheTtlMode): CacheTtlMode {
  const normalized: CacheTtlMode = mode === '1h' ? '1h' : '5m';
  try {
    localStorage.setItem(CACHE_TTL_MODE_KEY, normalized);
  } catch {
    /* ignore */
  }
  return normalized;
}
