/**
 * NotePaper Strict 单轨边界标识（Stage 05 §7.2 单轨收敛）。
 *
 * 契约不变量：
 * - NotePaper 空态与块编辑面统一收敛至 Strict 单轨（`NotePaperEditorSurface.tsx` + `NotePaperEmptyView.tsx`）；
 * - 全链路固定 `'strict'` 为唯一权威轨道；
 * - 块级渲染与序列化共享 `TwoTierBlockEditorCache`（L1 WeakMap + L2 有界 512 指纹 LRU）。
 */

/** Strict 单轨包标识 */
export const W5B_STRICT_PACKAGE_ID = 'W5-B' as const;
export type W5bStrictPackageId = typeof W5B_STRICT_PACKAGE_ID;

/** Strict 单轨唯一标识 */
export const W5B_STRICT_TRACK = 'strict' as const;
export type W5bStrictTrack = typeof W5B_STRICT_TRACK;

/** 产品空态唯一默认轨道（单轨锁定为 'strict'） */
export const W5B_PRODUCT_DEFAULT_EMPTY_TRACK = 'strict' as const;

/** NotePaper Strict 单轨物理边界声明（会计锚点：可演示≠EL-01/EL-08 终验，S5/W5-C 门禁独立） */
export const W5B_STRICT_BOUNDARY =
  'W5-B Strict 单轨唯一权威实现（可演示≠EL-01/EL-08 真实链终验，S5/W5-C 门禁独立）' as const;
