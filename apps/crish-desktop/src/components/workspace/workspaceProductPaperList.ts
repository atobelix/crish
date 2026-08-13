/**
 * CONN-C2′（C-prod）· Workspace 产品宿主 PaperList 默开策略
 *
 * 产品 Workspace 空态路径写死默传：
 * - `enableProductPaperList = true`（C2′ 产品默开，经 WorkspaceProductEmptyHost 显式传参）
 *
 * EmptyState **组件默认仍 false**（CONN-C2 会计门不回退：
 * `WorkspaceEmptyState.tsx` 默认 `enableProductPaperList = false`；
 * 策略关 → 组件默认关不变，两态并存可测）。
 *
 * ≠ W3-P（满窗 / 真 Diff / awareness）· ≠ EL-01
 * 默开 ≠ PaperList 完成；C2′ 新 ID ≠ C2 整包；
 * 产品默开是策略级决策（同 E2′ 形态），非组件语义变更。
 */
export const WORKSPACE_PRODUCT_ENABLE_PAPER_LIST = true as const;
