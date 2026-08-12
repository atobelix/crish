/**
 * presentationMode — note-paper 内容宿主呈现策略（SD-04 · 反三宿主）
 *
 * ## 问题
 * Strict 曾默认可同时：React 全量 `data-content-row` + PaperList 窗口 DOM + DomHost chrome，
 * 导致布局/测锚歧义与伪完成诱因（审计 05 · B-01）。
 *
 * ## 内容宿主 vs chrome 槽（契约钉死）
 *
 * | 槽 / 宿主 | DOM 锚 | 角色 | 与内容互斥？ |
 * |-----------|--------|------|--------------|
 * | **content · react-rows** | `[data-content-row="1"]` | React 全量块行列表 | 与 paper-list **互斥**（除非 debug-dual） |
 * | **content · paper-list** | `[data-bp-paper-list-mount="1"]` 内 `PaperList` | 仅窗口∪pin DOM | 与 react-rows **互斥**（除非 debug-dual） |
 * | **chrome** | `[data-bp-chrome-mount="1"]` | 把手/落点/slash 宿主皮 | **分槽共存**；不计入内容互斥 |
 *
 * - chrome 槽与 content 槽 **同屏兄弟、生命周期独立**（destroy 一方不删另一方）
 * - 「反三宿主」= 禁止产品默认路径 **双内容宿主**（全量 content-row + paper-list 内容块）同屏
 * - DomHost 自建 `data-bp-block-row` 属 chrome 皮，**不是** 第二内容权威
 *
 * ## 模式
 * | PresentationMode | content-row 全量 | PaperList 内容 | 产品默认？ |
 * |------------------|------------------|----------------|------------|
 * | `react-rows`     | ✓                | ✗              | 未开 paperList 时 |
 * | `paper-list`     | ✗                | ✓              | 点名 paperList 时 |
 * | `debug-dual`     | ✓                | ✓              | **否**；仅调试/对照测 |
 *
 * ## 诚实边界
 * - **≠ EL-01**；**≠** 用 CSS hidden 假虚拟化；**≠** 关 PaperList 结构门
 * - 本模块只解析模式；真正挂载由 StrictPanel / DomMount 执行
 *
 * 测：`presentationMode.test.ts` · Strict / PaperListDomMount 集成测
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 内容宿主呈现模式（命名钉死 · SD-04）。
 * - `react-rows`：仅 React 全量 `data-content-row`
 * - `paper-list`：仅 PaperList 窗口内容（产品大文档 / 结构门路径）
 * - `debug-dual`：双内容宿主同屏（调试对照；**非**产品默认）
 */
export type PresentationMode = 'react-rows' | 'paper-list' | 'debug-dual';

/** 合法模式集合（测试/守卫用） */
export const PRESENTATION_MODES: readonly PresentationMode[] = [
  'react-rows',
  'paper-list',
  'debug-dual',
] as const;

export function isPresentationMode(v: unknown): v is PresentationMode {
  return v === 'react-rows' || v === 'paper-list' || v === 'debug-dual';
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export type ResolvePresentationModeInput = {
  /**
   * 是否点名挂载 PaperList（`paperList === true | object`）。
   * false / 省略 → 产品默认 `react-rows`。
   */
  paperListEnabled: boolean;
  /**
   * 显式模式（最高优先）。
   * - 未开 paperList 时，`paper-list` / `debug-dual` 无列表槽可挂，回落 `react-rows`
   *   （避免「声明了 paper-list 却无 mount」的假状态）
   */
  presentationMode?: PresentationMode;
  /**
   * 兼容旧开关（仅 paperList 启用时有意义）：
   * - `true` → `debug-dual`（旧默认双轨；**已非产品默认**）
   * - `false` → `paper-list`
   * - 与 `presentationMode` 同时传时以 `presentationMode` 为准
   *
   * @deprecated 新代码请用 `presentationMode`
   * @see PresentationMode / `presentationMode` 字段
   * @removeWhen 产品调用方全部迁到 `presentationMode` 后删除本兼容字段
   */
  keepReactRows?: boolean;
};

/**
 * 解析内容呈现模式。
 *
 * 产品默认路径：
 * 1. 未开 paperList → `react-rows`（仅 content-row）
 * 2. 开了 paperList 且未显式 dual → `paper-list`（**互斥**，不再默认同屏 content-row）
 * 3. 仅 `presentationMode: 'debug-dual'` 或兼容 `keepReactRows: true` → 双内容
 */
export function resolvePresentationMode(
  input: ResolvePresentationModeInput
): PresentationMode {
  const { paperListEnabled, presentationMode, keepReactRows } = input;

  if (presentationMode !== undefined && isPresentationMode(presentationMode)) {
    if (!paperListEnabled) {
      // 无列表槽时 paper-list / debug-dual 无意义 → 诚实回落
      return 'react-rows';
    }
    return presentationMode;
  }

  if (!paperListEnabled) {
    return 'react-rows';
  }

  // paperList 已启用、无显式 mode：兼容 keepReactRows，否则产品默认 paper-list
  if (keepReactRows === true) {
    return 'debug-dual';
  }
  return 'paper-list';
}

/** 是否渲染 React 全量 content-row 列表 */
export function showReactContentRows(mode: PresentationMode): boolean {
  return mode === 'react-rows' || mode === 'debug-dual';
}

/** 是否挂载 PaperList 内容槽 */
export function showPaperListContent(mode: PresentationMode): boolean {
  return mode === 'paper-list' || mode === 'debug-dual';
}

/**
 * 产品默认路径是否违反内容互斥（双内容宿主同屏）。
 * `debug-dual` 为显式双轨，**不算**产品违约。
 */
export function isProductContentHostExclusive(mode: PresentationMode): boolean {
  return mode !== 'debug-dual';
}
