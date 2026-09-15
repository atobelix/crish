/**
 * 出厂字典快照解析器与运行时快照状态（从 pricingStore.ts 拆出，T4-11 SR-06-R1；
 * 阶段 3 静态定价表物理清零）。
 *
 * 唯一价格源 = **出厂能力字典**（Rust `crates/agent-provider/src/models/catalog.json`，
 * 编译期打包）经 `workbench_read_capability_dictionary` 下发的运行时快照。
 * 前端**零本地副本**：`pricingCatalogData*.ts` 六份静态表已物理删除，
 * `CATALOG_CACHE_RATES` / `resolveCatalogEntry` 一并消亡（裁决 ①）。
 *
 * 身份口径：**配置树侧**的模型身份 = `(providerId, modelId)` 二元组
 * （`modelsCatalogTypes.ts` 的 [modelRefKey]，本仓唯一身份格式，禁止自造第三种
 * 连接格式）；**出厂字典侧**的查找键 = `model id`（字典内唯一，见下）。
 * 两侧口径不同源是**事实**（树的 `providerId` 与字典厂商是两个命名空间，
 * 且 `ProviderSpec` 无 vendor 字段），故字典查找不假装二元组、也不猜厂商。
 * **禁止** substring 与模糊回退参与价格决议（裁决 ③）。
 *
 * 快照未注入 / 未命中 = 「未收录」态：本模块一律返回 `null`，
 * 消费面（`pricingStore.ts` 的估算函数）据此返回 `null` 而非 0
 * ——「未收录 ≠ 0 成本」。
 */

import type { ModelRef } from './modelsCatalogTypes';
import type {
  CatalogCacheSnapshot,
  CatalogSnapshotPrice,
} from './pricingTypes';

let catalogSnapshot: CatalogCacheSnapshot | null = null;

/**
 * 注入运行时出厂字典快照（数据源 = `workbench_read_capability_dictionary`；
 * 前端只读快照缓存，零本地副本）。
 *
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

/** 测试辅助：清空运行时快照（清空后一切查表 = 「未收录」） */
export function clearCatalogCacheSnapshot(): void {
  catalogSnapshot = null;
}

/** 当前快照版本（未注入 = null；消费面据此判定「未收录」） */
export function catalogSnapshotVersion(): number | null {
  return catalogSnapshot?.version ?? null;
}

/**
 * 出厂字典条目查找：**按模型 id 精确查表**。
 *
 * 为什么 id 可作唯一键：出厂字典是厂商维度的**出厂目录**，其 `model id` 在字典内
 * 实测唯一（156 个 id / 0 个跨厂商重复，见 `catalog.json` 全量统计），
 * 而配置树的 `providerId` 与字典厂商是**两个命名空间**（树没有 vendor 字段）。
 * 因此按 id 查找不含猜测；同 id 不同价的异常条目由
 * `toCatalogCacheSnapshot` 直接作废（fail-closed）。
 *
 * 无 substring / 前缀后缀 / 模糊回退：未命中即「未收录」（返回 null）。
 */
export function resolveSnapshotPrice(
  ref: ModelRef
): CatalogSnapshotPrice | null {
  if (!catalogSnapshot) return null;
  return catalogSnapshot.prices[ref.modelId] ?? null;
}

/**
 * 三级费率第 1 级：per-model 出厂字典缓存价（绝对值，模型自身币种）。
 * 未收录 / 快照未注入 → null（回退下级）。写免费条目 write = 0。
 */
export function resolveCatalogCachePrices(
  ref: ModelRef
): { readPerMTok?: number; writePerMTok?: number } | null {
  const snap = resolveSnapshotPrice(ref);
  if (!snap) return null;
  const writePerMTok =
    snap.writeFree === true
      ? 0
      : (snap.writePerMTok5m ?? snap.writePerMTok);
  if (snap.readPerMTok == null && writePerMTok == null) return null;
  return {
    readPerMTok: snap.readPerMTok ?? undefined,
    writePerMTok: writePerMTok ?? undefined,
  };
}
