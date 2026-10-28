/**
 * apps/crish-desktop/src/components/workspace/nativeBrowserTabId.ts
 *
 * 原生浏览器与工作区预览 Tab ID 规范化单一真理来源（SSOT 叶子纯工具模块）。
 *
 * 架构规范（V2 多实例与 HWND 视口隔离）：
 * 1. 严格叶子节点：零 React Hook 依赖、零 DOM 依赖、零副作用；
 * 2. 统一命名与单一真理源契约：
 *    - 优先且必须使用显式指定的 tabId（严格对齐 ToolTab.tabId / ViewRenderContext.panelId）；
 *    - 缺省 tabId 时（仅作为单叶片历史单测或外部极简调用兜底），基于分栏叶子节点 leafId 生成 `browser-${leafId}`；
 *    - 两者皆缺省时回退兜底为 `browser-default`；
 * 3. 彻底杜绝位置（leafId）与身份（tabId）的错误耦合，保证 Native WebView2 视口唯一标识与 ToolTab.tabId 严格等价，
 *    杜绝同一叶片内多开预览时的 HWND 视口抢占与覆盖；
 * 4. 彻底根除 useNativeBrowserInstance 与 usePreviewNavigation 之间的双向循环依赖。
 */

export function resolveBrowserTabId(
  tabId?: string | null,
  leafId?: string | null
): string {
  const trimmedTab = tabId?.trim();
  if (trimmedTab) return trimmedTab;
  const trimmedLeaf = leafId?.trim();
  if (trimmedLeaf) return `browser-${trimmedLeaf}`;
  return 'browser-default';
}
