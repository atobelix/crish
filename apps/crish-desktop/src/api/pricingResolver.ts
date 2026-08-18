/**
 * 目录快照解析器与运行时快照状态（从 pricingStore.ts 拆出，T4-11 SR-06-R1）。
 *
 * 组合各厂商分表的 CATALOG_CACHE_RATES，提供目录条目查找与运行时快照管理。
 * 三级费率第 1 级（per-model 目录缓存价）的解析入口。
 */

import type {
  CatalogCacheSnapshot,
  CatalogModelEntry4d,
  CatalogSnapshotPrice,
} from './pricingTypes';
import {
  CATALOG_RATES_OPENAI,
  CATALOG_RATES_ANTHROPIC,
} from './pricingCatalogDataA';
import {
  CATALOG_RATES_KIMI,
  CATALOG_RATES_GLM,
  CATALOG_RATES_QWEN,
} from './pricingCatalogDataB';
import {
  CATALOG_RATES_GROK,
  CATALOG_RATES_MINIMAX,
  CATALOG_RATES_GEMINI,
  CATALOG_RATES_DEEPSEEK,
} from './pricingCatalogDataC';

/**
 * 御十家全量四指标目录（v4 取代 v3 的 28 模型乘数表）。
 *
 * 数据源：docs/cache-optimization/10-model-catalog-v2/04-master-model-list.md
 * （R2 汇总 2026-08-03，唯一数据源；R3 不得越过本表）。数据日期 2026-08-03。
 * 转录范围：四指标完整且非「明确不转录」（§13.4：已下线/非对话/未获取）条目；
 * 双币种厂商每模型单条（v1 catalog.json 默认直连口径），CNY/USD 双条目归服务端。
 * 基础四价 = 首档；tieredPricing 档位 P1B 起随条目收录（估算按 input 长度落档，
 * 见 resolve4dPricesForTokens）。
 * 别名/旧键条目（v1 catalog.json 或旧费率表形态）与官方 ID 同价，注释标注。
 * 键名规则：官方 API ID 直抄；GLM/MiniMax/Qwen 等点号异形按 schema §1.4
 * 保留目录横线形态的旧键作为别名。
 */
export const CATALOG_CACHE_RATES: Record<string, CatalogModelEntry4d> = {
  ...CATALOG_RATES_OPENAI,
  ...CATALOG_RATES_ANTHROPIC,
  ...CATALOG_RATES_KIMI,
  ...CATALOG_RATES_GLM,
  ...CATALOG_RATES_QWEN,
  ...CATALOG_RATES_GROK,
  ...CATALOG_RATES_MINIMAX,
  ...CATALOG_RATES_GEMINI,
  ...CATALOG_RATES_DEEPSEEK,
};

/**
 * 目录条目查找：精确 + 模糊匹配（与 resolveModelPrice 同规则）。
 * 精确优先；模糊支持「带版本后缀」（deepseek-v4-flash-0731 含目录键）与
 * 「旧键/别名前缀」（gemini-3-1-pro 命中 gemini-3.1-pro-preview）。
 */
export function resolveCatalogEntry(model: string): CatalogModelEntry4d | null {
  const exact = CATALOG_CACHE_RATES[model];
  if (exact) return exact;
  for (const key of Object.keys(CATALOG_CACHE_RATES)) {
    if (model.includes(key) || key.includes(model)) {
      const entry = CATALOG_CACHE_RATES[key];
      if (entry) return entry;
    }
  }
  return null;
}

let catalogSnapshot: CatalogCacheSnapshot | null = null;

/**
 * 注入运行时目录快照（数据源 = Rust catalog_get；前端只读快照缓存）。
 * 版本号不递增（旧于当前快照）时忽略——「版本号失效」语义：
 * 新版本覆盖旧版本，同版本幂等。
 */
export function applyCatalogCacheSnapshot(
  snapshot: CatalogCacheSnapshot | null
): void {
  if (!snapshot) {
    catalogSnapshot = null;
    return;
  }
  if (catalogSnapshot && snapshot.version <= catalogSnapshot.version) {
    return;
  }
  catalogSnapshot = snapshot;
}

/** 测试辅助：清空运行时快照（回退静态表） */
export function clearCatalogCacheSnapshot(): void {
  catalogSnapshot = null;
}

/**
 * 快照条目查找：精确 + 模糊匹配（与 resolveCatalogEntry 同规则，
 * 兼容版本后缀与 apiModel 点号异形）。命中键 → 条目，否则 null。
 */
export function resolveSnapshotPrice(model: string): CatalogSnapshotPrice | null {
  if (!catalogSnapshot) return null;
  const exact = catalogSnapshot.prices[model];
  if (exact) return exact;
  for (const key of Object.keys(catalogSnapshot.prices)) {
    if (model.includes(key) || key.includes(model)) {
      const entry = catalogSnapshot.prices[key];
      if (entry) return entry;
    }
  }
  return null;
}

/**
 * 三级费率第 1 级：per-model 目录缓存价（绝对价，模型自身币种）。
 * 优先运行时快照（catalog_get 下发绝对值），否则静态表绝对价；
 * 两者都取不到 → null（回退下级）。写免费条目 write = 0。
 */
export function resolveCatalogCachePrices(
  model: string
): { readPerMTok?: number; writePerMTok?: number } | null {
  const snap = resolveSnapshotPrice(model);
  if (snap && (snap.readPerMTok != null || snap.writePerMTok != null)) {
    return {
      readPerMTok: snap.readPerMTok ?? undefined,
      writePerMTok: snap.writePerMTok ?? undefined,
    };
  }
  const entry = resolveCatalogEntry(model);
  if (!entry) return null;
  return {
    readPerMTok: entry.cacheReadPerMTok ?? undefined,
    writePerMTok: entry.cacheWriteFree ? 0 : entry.cacheWritePerMTok,
  };
}
