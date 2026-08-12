/**
 * W5-B · Strict 轨包标识（plans/09 Wave 5）
 *
 * - **轨**：Strict —— 真数据 / hydrate 投影路径（可注入 transport）
 * - **≠** W5-B-S Skeleton（假数据 / 半 transport 预览壳；常量见 w5bSkeleton.ts）
 * - **可演示 ≠ EL-01 / EL-08 关闭**（挂载冒充交付 = S5 · 08 §0.2）
 * - **≠ W5-C 隔离全关**（A-SURF 真扫主责在 W5-C）
 * - **≠「打开完成」**：产品 Strict 默认 hydrate 经 `createProductStrictHydrateTransport`
 *   （可检测 Tauri → tauri-ipc；无 Tauri → fixture）；后端默认
 *   `hydrate_path=doc-session`；产品关账仍依赖 **G-HYD 全条件**；**≠ EL-04/01**
 * - **禁止** 把 Skeleton 常量改成 `W5-B` 冒充；**禁止** 假数据 chrome 关 EL-01
 *
 * 本常量仅作会计与 DOM 可观测锚点；不构成产品交付 / EL 关闭声明。
 */

/** 包 ID（Strict，无 -S） */
export const W5B_STRICT_PACKAGE_ID = 'W5-B' as const;

/** 轨名（会计用语；DOM data-track） */
export const W5B_STRICT_TRACK = 'strict' as const;

/**
 * 产品空态默认倾向轨（W5-B 产品默认入口）。
 * - 值固定 `strict`：空态主 CTA 打开 `NotePaperStrictPanel` +
 *   `createProductStrictHydrateTransport`（Tauri→tauri-ipc / 无 Tauri→fixture）
 * - **可演示 ≠ EL**；**≠ 打开完成**；fixture ≠ 生产权威
 * - Skeleton（W5-B-S）入口仍保留，见 `W5B_SKELETON_*`
 */
export const W5B_PRODUCT_DEFAULT_EMPTY_TRACK = W5B_STRICT_TRACK;

/**
 * 人类可读边界句（UI footer / 文档）
 * 钉死：可演示 ≠ EL；挂载冒充交付 = S5
 */
export const W5B_STRICT_BOUNDARY =
  'W5-B Strict · 真数据/hydrate 投影 · 可演示≠EL-01/EL-08 · ≠W5-C 隔离全关 · 挂载冒充交付=S5' as const;

export type W5bStrictPackageId = typeof W5B_STRICT_PACKAGE_ID;
export type W5bStrictTrack = typeof W5B_STRICT_TRACK;
