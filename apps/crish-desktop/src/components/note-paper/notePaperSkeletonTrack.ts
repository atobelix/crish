/**
 * W5-B-S · Skeleton 轨包标识（plans/09 Wave 5）
 *
 * - **轨**：Skeleton（`-S`）——预览壳 + 假数据 / 半 transport
 * - **≠** W5-B Strict（真数据默认路径依赖 W1-H）
 * - **≠** 任何 EL 关闭（挂载冒充交付 = S5 事故 · 08 §0.2）
 * - **禁止** 去 `-S` 冒充 Strict；**禁止** 假数据 chrome 关 EL-01
 * - **禁止** 无 W1-H 叙事写「打开文档完成」
 *
 * 本常量仅作会计与 DOM 可观测锚点；不构成产品交付声明。
 */

/** 包 ID（必须带 -S） */
export const W5B_SKELETON_PACKAGE_ID = 'W5-B-S' as const;

/** 轨名（会计用语） */
export const W5B_SKELETON_TRACK = 'skeleton' as const;

/** 人类可读边界句（UI footer / 文档） */
export const W5B_SKELETON_BOUNDARY =
  'W5-B-S Skeleton · 预览壳/假数据 · ≠ Strict · 挂载≠EL-01/EL-08 关闭' as const;

export type W5bSkeletonPackageId = typeof W5B_SKELETON_PACKAGE_ID;
export type W5bSkeletonTrack = typeof W5B_SKELETON_TRACK;
