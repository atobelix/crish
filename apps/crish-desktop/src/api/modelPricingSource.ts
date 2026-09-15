/**
 * 模型定价单一真源投影（战役 docs/provider-single-track-convergence/ 阶段 3 价格轨；
 * 方案 `05-价格页与模型配置对齐方案.md`）。
 *
 * 定价唯一源 = **用户声明（统一树 `ModelSpec.pricing`）覆盖 + 出厂字典预估兜底**：
 *
 *   树 `ModelSpec.pricing`（用户声明，权威）
 *     → 出厂字典快照 `resolveSnapshotPrice(ref)`（**预估**，只读参考）
 *     → `null`（未收录；**禁止**渲染为 0）
 *
 * 名单真源 = 统一树 `modelsCatalogStore.modelIndex`（与模型配置界面同源）：
 * 模型删除 ⇒ 名单自动少一条、价格随之消失（价格挂在模型上，删模型即删价）。
 * 出厂字典**只做参考**，实际以用户配置为准。
 *
 * 旧 localStorage 扁平价表 `crish_model_prices_v1`（键 = **裸 modelId**、无 provider
 * 维度）**退役**：由 [migrateLegacyLsPrices] 一次性幂等迁移进树，此后不再读写。
 *
 * 身份：树侧一律 `(providerId, modelId)` 二元组（`modelRefKey`）；字典侧按 **model id
 * 精确查表**（`pricingResolver`，字典内 id 唯一）。**禁止** substring / 模糊回退。
 */

import { modelRefKey } from './modelsCatalogTypes';
import type {
  ModelRef,
  ModelSpec,
  PricingConfig,
} from './modelsCatalogTypes';
import { modelsCatalogStore } from './modelsCatalogStore';
import { resolveSnapshotPrice } from './pricingResolver';
import { PRICES_KEY, type ModelPrice } from './pricingTypes';

/** 价格来源：用户声明 / 字典预估 / 未收录 */
export type PriceSource = 'user' | 'estimate' | 'none';

/**
 * 计费模式（**唯一判据 = 模型能力**，用户不再手选）。
 *
 * - `per_image`：`modalities.output` 含 `image`（生图模型）→ 按张生成计费；
 * - `per_1m_tokens`：其余 → 按百万 token 计费。
 *
 * 用户裁决（2026-09-15）：价格页取消「计费方式」多选，生图模型自动套用按张价。
 * 能力真源在模型配置页的 `modalities`（`ModelModalitiesEditor`），此处只做投影，
 * **不读** `pricing.unit`——避免「同一件事两个真源」。
 */
export type BillingMode = 'per_1m_tokens' | 'per_image';

/**
 * 计费模式派生（纯函数；能力矩阵为唯一输入）。
 *
 * 实现约束：本文件受门禁 ②「定价身份路径零 includes」约束
 * （`pricingCatalogSingleSource.test.ts` —— 裁决 ③ 禁止子串参与模型身份决议）。
 * 该门禁**不剥注释**地一刀切扫描，故此处数组成员判定改用 `some(===)`：
 * 语义等价（`string[]` 的成员判定 ≡ `some(v => v === x)`），且不引入任何子串
 * 匹配语义。**请勿**改回数组原生成员判定方法，也请勿在本文件写出该调用字样
 * （注释同样会被扫到）。
 */
export function deriveBillingMode(model: ModelSpec): BillingMode {
  const outputs = model.modalities?.output;
  return outputs?.some((m) => m === 'image') ? 'per_image' : 'per_1m_tokens';
}

export interface EffectiveModelPrice {
  currency: 'USD' | 'CNY';
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  source: PriceSource;
}

export interface ConfiguredPriceRow {
  ref: ModelRef;
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
  /** 计费模式（能力派生；见 [deriveBillingMode]） */
  billingMode: BillingMode;
  /** 生效价（用户声明 → 字典预估）；两者皆无 = null（未收录） */
  effective: EffectiveModelPrice | null;
  /** 树中用户声明价原文（编辑初值）；无 = undefined */
  userPricing?: PricingConfig;
}

/**
 * 退役价表的一次性迁移备份键（`crish_model_prices_v1` 原值快照）。
 * 迁移前写入，**仅在不存在时写**（幂等）；原键迁移后置 `[]`（不 removeItem，
 * 保持「已迁移」可辨识）。
 */
export const PRICES_BACKUP_KEY = 'crish_model_prices_v1__backup';

/** 缺省 order 视为大值（排在有声明者之后），保证排序确定性。 */
const NO_ORDER = Number.POSITIVE_INFINITY;

/**
 * 树侧用户声明价（原文）。**唯一**读口：定价面一切「用户声明」判据都走此函数，
 * 避免各处自行 `modelIndex.get(...)` 造成口径漂移。
 */
export function resolveUserPricing(ref: ModelRef): PricingConfig | undefined {
  return modelsCatalogStore.getState().modelIndex.get(modelRefKey(ref))?.model
    .pricing;
}

/** 树用户声明 → 生效价（用户声明权威：已声明字段一律直取，**不**补零、不猜） */
function fromUserPricing(pricing: PricingConfig): EffectiveModelPrice {
  return {
    currency: pricing.currency,
    inputPerMTok: pricing.input,
    outputPerMTok: pricing.output,
    cacheReadPerMTok: pricing.cacheRead,
    cacheWritePerMTok: pricing.cacheWrite,
    source: 'user',
  };
}

/**
 * 出厂字典快照 → 预估价。
 *
 * 字典条目是**参考价**：缺输入价或输出价时不足以构成一条可用价 ⇒ `null`
 * （与 `pricingStore.resolve4dPrices` 的「未收录」判据一致，避免两处口径分叉）。
 * 币种缺失时沿用既有解析口径回落 `'USD'`（字典未标注 ≠ 折算）。
 */
function fromSnapshot(ref: ModelRef): EffectiveModelPrice | null {
  const snap = resolveSnapshotPrice(ref);
  if (!snap) return null;
  if (snap.inputPerMTok == null || snap.outputPerMTok == null) return null;
  const cacheWritePerMTok =
    snap.writeFree === true
      ? 0
      : (snap.writePerMTok5m ?? snap.writePerMTok);
  return {
    currency: snap.currency ?? 'USD',
    inputPerMTok: snap.inputPerMTok,
    outputPerMTok: snap.outputPerMTok,
    cacheReadPerMTok: snap.readPerMTok,
    cacheWritePerMTok,
    source: 'estimate',
  };
}

/**
 * 单一回退链：树用户声明 → 出厂字典预估 → null。
 *
 * 用户已声明 `pricing` 即返回 `source: 'user'`（即使个别费率未填 —— 未配置 ≠ 0，
 * 不得补零冒充）；未声明才看字典预估；两者皆无 = 「未收录」。
 */
export function resolveEffectivePrice(
  ref: ModelRef
): EffectiveModelPrice | null {
  const user = resolveUserPricing(ref);
  if (user) return fromUserPricing(user);
  return fromSnapshot(ref);
}

/** 身份排序键：provider.order → providerId → model.order → modelId（确定性） */
function compare(
  aOrder: number,
  bOrder: number,
  aId: string,
  bId: string
): number {
  if (aOrder !== bOrder) return aOrder < bOrder ? -1 : 1;
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
}

/**
 * 名单真源 = 统一树 `modelIndex`（含停用供应商的模型 —— 与模型配置界面一致，
 * 树是唯一权威）。排序确定性：provider `order`（缺省大值）→ `providerId` →
 * model `order`（缺省大值）→ `modelId`；比较用码元序（不用 localeCompare，
 * 避免 ICU 差异导致顺序漂移）。
 */
export function listConfiguredPrices(): ConfiguredPriceRow[] {
  const state = modelsCatalogStore.getState();
  const items: Array<{
    row: ConfiguredPriceRow;
    providerOrder: number;
    modelOrder: number;
  }> = [];
  for (const entry of state.modelIndex.values()) {
    const ref: ModelRef = {
      providerId: entry.providerId,
      modelId: entry.model.id,
    };
    items.push({
      row: {
        ref,
        providerId: entry.providerId,
        providerName: entry.provider.displayName?.trim() || entry.providerId,
        modelId: entry.model.id,
        displayName: entry.model.displayName?.trim() || entry.model.id,
        billingMode: deriveBillingMode(entry.model),
        effective: resolveEffectivePrice(ref),
        userPricing: entry.model.pricing,
      },
      providerOrder: entry.provider.order ?? NO_ORDER,
      modelOrder: entry.model.order ?? NO_ORDER,
    });
  }
  items.sort(
    (a, b) =>
      compare(
        a.providerOrder,
        b.providerOrder,
        a.row.providerId,
        b.row.providerId
      ) ||
      compare(a.modelOrder, b.modelOrder, a.row.modelId, b.row.modelId)
  );
  return items.map((item) => item.row);
}

/**
 * 写入用户声明价（CAS 异步）。
 *
 * `pricing === undefined` = **清除**用户价（该模型回落字典预估）：
 * `updateModel` 的补丁经 `definedClone` 递归剥除 `undefined` 字段，故显式传
 * `undefined` 即从树中删掉 `pricing` 键（见 `modelsCatalogActions.ts` 的
 * `definedClone` 注释「明确的 undefined 补丁意味着删除」）。
 *
 * 失败一律显式回传错误文本（含「目录未加载」「修订冲突」），**禁止**静默降级。
 */
export async function setModelPrice(
  ref: ModelRef,
  pricing: PricingConfig | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const result = await modelsCatalogStore.updateModel(
      ref.providerId,
      ref.modelId,
      { pricing }
    );
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * 旧价表行 → 树 `PricingConfig`（字段一一映射，不发明数据）。
 *
 * - `input/output/cacheRead/cacheWrite → 同名`；`perImageCost → perImage`。
 * - `billingUnit → unit`：`per_image` 原样；其余（含缺省）→ `per_1m_tokens`
 *   （旧表 perMTok 字段本就是「每百万 token」单价）。
 * - `currency`：旧行显式标注优先；未标注时沿用退役前的解析口径
 *   `字典快照 currency ?? 'USD'`（**沿用**既有链，不是新猜测）。
 * - 缺 `inputPerMTok` 或 `outputPerMTok`（或非有限非负）→ `null`（脏行，不迁）。
 */
function pricingFromLegacyRow(
  row: ModelPrice,
  ref: ModelRef
): PricingConfig | null {
  const input = finiteNonNegative(row.inputPerMTok);
  const output = finiteNonNegative(row.outputPerMTok);
  if (input === undefined || output === undefined) return null;
  const cacheRead = finiteNonNegative(row.cacheReadPerMTok);
  const cacheWrite = finiteNonNegative(row.cacheWritePerMTok);
  const perImage = finiteNonNegative(row.perImageCost);
  return {
    currency:
      row.currency === 'USD' || row.currency === 'CNY'
        ? row.currency
        : (resolveSnapshotPrice(ref)?.currency ?? 'USD'),
    unit: row.billingUnit === 'per_image' ? 'per_image' : 'per_1m_tokens',
    input,
    output,
    cacheRead,
    cacheWrite,
    perImage,
  };
}

/**
 * 一次性幂等迁移：旧 LS 价表 `crish_model_prices_v1` → 统一树。
 *
 * 语义（方案 05 §4 期 2）：
 * 1. 树未 loaded → `{0, 0, skipped: true}`，且**绝不改动 LS**（不备份、不置空）。
 * 2. 逐条读旧行（键 = **裸 modelId**），用树解析「**唯一**持有该 modelId 的供应商」：
 *    0 个或 >1 个 → `dropped++`（不猜供应商）；树中该模型**已有用户声明价** → 亦
 *    计入 `dropped`（树是权威源，**不覆盖**用户手写声明）；脏行（缺输入/输出价）
 *    → `dropped++`。唯一命中 → 写树 `pricing`，`migrated++`。
 * 3. 安全：迁移前把原值备份到 `PRICES_BACKUP_KEY`（**仅在备份键不存在时写**，幂等）；
 *    全部写树成功后把原键置 `[]`（**不** `removeItem`，保持「已迁移」可辨识）。
 *    任一步抛错 → 原键保持不动，异常**向上抛出**（不吞；冻结签名无错误字段）。
 * 4. 幂等：原键已置 `[]` → 第二次调用 `{0, 0, skipped: false}`。
 */
export async function migrateLegacyLsPrices(): Promise<{
  migrated: number;
  dropped: number;
  skipped: boolean;
}> {
  const state = modelsCatalogStore.getState();
  if (!state.loaded) return { migrated: 0, dropped: 0, skipped: true };

  const raw = localStorage.getItem(PRICES_KEY);
  if (raw === null) return { migrated: 0, dropped: 0, skipped: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `旧价表 JSON 无法解析，已保留 ${PRICES_KEY} 原值不动：${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `旧价表格式非法（非数组），已保留 ${PRICES_KEY} 原值不动`
    );
  }

  // 备份先于任何写入（幂等：仅在备份键不存在时写）
  if (localStorage.getItem(PRICES_BACKUP_KEY) === null) {
    localStorage.setItem(PRICES_BACKUP_KEY, raw);
  }

  const rows = parsed.filter(
    (row): row is ModelPrice => row !== null && typeof row === 'object'
  );
  let migrated = 0;
  let dropped = 0;
  for (const row of rows) {
    const modelId = typeof row.model === 'string' ? row.model.trim() : '';
    if (!modelId) {
      dropped += 1;
      continue;
    }
    const owners: string[] = [];
    for (const entry of state.modelIndex.values()) {
      if (entry.model.id === modelId) owners.push(entry.providerId);
    }
    if (owners.length !== 1) {
      dropped += 1;
      continue;
    }
    const ref: ModelRef = { providerId: owners[0]!, modelId };
    if (resolveUserPricing(ref)) {
      // 树已有用户声明（手写 YAML / 草稿写入）：权威源优先，不覆盖
      dropped += 1;
      continue;
    }
    const pricing = pricingFromLegacyRow(row, ref);
    if (!pricing) {
      dropped += 1;
      continue;
    }
    const result = await modelsCatalogStore.updateModel(
      ref.providerId,
      ref.modelId,
      { pricing }
    );
    if (!result.ok) {
      throw new Error(
        `旧价表迁移写入失败（${ref.providerId}/${ref.modelId}）：${result.error}`
      );
    }
    migrated += 1;
  }

  localStorage.setItem(PRICES_KEY, '[]');
  return { migrated, dropped, skipped: false };
}
