# 方案 B：浏览器交互重塑、动态 Favicon、Resizer 4px 错位与粘手根治方案

> **文档性质**：独立技术推演方案（方案 B）  
> **设计原则**：源码直推、架构优雅、杜绝补丁、穿透底层根因、像素级精确对齐。  
> **涉及核心领域**：
> 1. 浏览器地址栏样式与交互重塑（对齐侧栏纯净设计规范）
> 2. 浏览器标签页动态网站图标（Favicon）提取、广播与优雅回落
> 3. 右侧拖拽分割线（Resizer）4px 物理视觉偏移与 iframe 事件劫持“粘手”根治
> 4. 浏览器默认打开行为与极简纯文本空状态（Empty State）重构

---

## 目录

- [一、背景与问题概览](#一背景与问题概览)
- [二、问题 1：浏览器地址栏样式与交互重塑](#二问题-1浏览器地址栏样式与交互重塑)
  - [2.1 涉及文件与源码定位](#21-涉及文件与源码定位)
  - [2.2 根因与机理剖析](#22-根因与机理剖析)
  - [2.3 技术设计与代码级实现](#23-技术设计与代码级实现)
  - [2.4 验收标准与验证用例](#24-验收标准与验证用例)
- [三、问题 2：浏览器标签页动态 Favicon 与优雅回落](#三问题-2浏览器标签页动态-favicon-与优雅回落)
  - [3.1 涉及文件与源码定位](#31-涉及文件与源码定位)
  - [3.2 根因与架构链路分析](#32-根因与架构链路分析)
  - [3.3 技术设计与代码级实现](#33-技术设计与代码级实现)
  - [3.4 验收标准与验证用例](#34-验收标准与验证用例)
- [四、问题 3：右侧分割线 4px 视觉偏移与“粘手”根治](#四问题-3右侧分割线-4px-视觉偏移与粘手根治)
  - [4.1 涉及文件与源码定位](#41-涉及文件与源码定位)
  - [4.2 几何排版错位 4px 物理数学证明与根因](#42-几何排版错位-4px-物理数学证明与根因)
  - [4.3 拖拽“粘手”底层机理穿透（Pointer 劫持与 iframe 黑洞）](#43-拖拽粘手底层机理穿透pointer-劫持与-iframe-黑洞)
  - [4.4 像素级重合对齐与三级事件保护设计](#44-像素级重合对齐与三级事件保护设计)
  - [4.5 验收标准与验证用例](#45-验收标准与验证用例)
- [五、问题 4：默认空白页与极简空状态（Empty State）](#五问题-4默认空白页与极简空状态empty-state)
  - [5.1 涉及文件与源码定位](#51-涉及文件与源码定位)
  - [5.2 根因与设计缺陷分析](#52-根因与设计缺陷分析)
  - [5.3 技术设计与代码级实现](#53-技术设计与代码级实现)
  - [5.4 验收标准与验证用例](#54-验收标准与验证用例)
- [六、综合影响面与回归验证矩阵](#六综合影响面与回归验证矩阵)

---

## 一、背景与问题概览

内置原生浏览器（PreviewCard / LeafToolTabStrip）与二叉树工作区分割系统（LeafDockResizer）是桌面工作台承载 Web 开发、页面审查和多任务协同的关键通道。然而，在现有实现中存在多项视觉不协调、交互断裂与底层事件泄漏问题：

1. **地址栏体验粗糙**：圆角采用死板的 4px，hover 效果错误绑定在外部父级工具栏导致大面积误触高亮；叉号清除按钮造成点击歧义与宽度跳动；焦点态缺乏明确的主题绿色微描边与标准光标；
2. **标签页图标静态单一**：所有网页标签页强制渲染写死的 `Globe` 图标，无法识别网站实际给出的 Favicon，失去浏览器基础的多标签辨识度；
3. **右侧分割线 4px 错位与致命“粘手”**：拖拽激活线与面板边框物理错位 4px；在向右拖拽过程中，光标一旦移入右侧面板或其内嵌的 `iframe` 并松开鼠标，释放事件被 `iframe` 跨文档黑洞彻底截留吞噬，导致分割线死锁“粘手”；
4. **空状态繁复沉重**：默认加载逻辑缺乏克制收敛；空状态展示了带有发光绿点、阴影和厚重边框的胶囊按钮，与全仓追求的纯净极简工作台风格背道而驰，且缺乏高频历史访问入口。

本方案针对上述 4 项问题，从几何排版数学模型、W3C Pointer Event 捕获机制、iframe 穿透隔离与多层事件响应、动态 Favicon 跨层通信等维度进行全面重构。

---

## 二、问题 1：浏览器地址栏样式与交互重塑

### 2.1 涉及文件与源码定位

- [PreviewToolbar.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewToolbar.tsx#L143-L169)（第 143–169 行）：地址栏表单及 `<Input>` 原子组件的参数装配。
- [PreviewCard.module.css](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css#L38-L78)（第 38–78 行）：`.urlForm`、`.urlInput`、`.bar:hover .urlInput` 的 CSS 规则。
- [SidebarNav.module.css](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.module.css#L80-L121)（第 80–121 行）：侧边栏“搜索会话与消息”标准设计基线。

### 2.2 根因与机理剖析

1. **父级 Hover 污染（`.bar:hover .urlInput`）**：
   在 `PreviewCard.module.css:64-68` 中，定义了：
   ```css
   .bar:hover .urlInput,
   .urlInput:hover:not(:disabled) {
     background: color-mix(in srgb, var(--bg-primary) 20%, var(--bg-card)) !important;
     border: 1px solid var(--border-subtle) !important;
   }
   ```
   只要光标滑入整个工具栏容器（`.bar`），地址栏就会发生背景与边框突变。这导致用户仅仅想点击后退、前进或刷新按钮时，地址栏都会产生强烈的视觉干扰跳动。
2. **几何圆角偏硬，与侧栏设计语言断裂**：
   地址栏强制设置了 `border-radius: var(--radius-sm, 4px) !important;`，而侧边栏输入框（`SidebarNav.module.css`）使用 `var(--radius-lg)`（6~8px），视觉更柔和、现代。4px 圆角在高度 24px 的微型控件上显得生硬局促。
3. **`clearable` 属性多此一举**：
   `Input` 组件内置的 `clearable` 按钮在受控非空时渲染一个 18px 的 X 图标（`ClearIcon`），在极度紧凑的地址栏中侵占可读空间；用户选中地址栏文字后直接输入即可覆盖，叉号按钮完全是多余冗余。
4. **焦点态缺乏精致的主题色反馈**：
   当前焦点态使用 `border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%)`，没有采用全仓规定的主题品牌绿（`--brand`），且未显式指定 `caret-color`。
5. **占位词喧宾夺主**：
   当前 `placeholder="localhost:5173 或 https://…"` 过长且显眼，需收敛为精炼克制的“请输入网址”，文字颜色设定为 `--text-tertiary`。

### 2.3 技术设计与代码级实现

#### 2.3.1 改造 `PreviewToolbar.tsx`

彻底去除 `clearable` 与 `onClear`，简化占位文本：

```tsx
// apps/crish-desktop/src/components/workspace/PreviewToolbar.tsx
<form
  className={styles.urlForm}
  aria-label="预览地址栏"
  onSubmit={(e) => {
    e.preventDefault();
    onUrlSubmit(urlInput.trim() ? urlInput : 'about:blank');
  }}
>
  <Input
    variant="search"
    size="xs"
    className={styles.urlInput}
    value={urlInput}
    placeholder="请输入网址"
    onChange={(e) => onUrlChange(e.target.value)}
    prefixIcon={
      <Lucide.Globe size={13} strokeWidth={1.5} aria-hidden />
    }
    spellCheck={false}
    aria-label="预览地址"
    autoComplete="off"
    inputMode="url"
    enterKeyHint="go"
  />
</form>
```

#### 2.3.2 改造 `PreviewCard.module.css`

- 移除 `.bar:hover .urlInput`；
- 引入 `border-radius: var(--radius-md, 6px)`（对齐侧边栏）；
- hover 时背景微加深（`var(--sidebar-hover)` 或 `color-mix` 极淡混入）；
- focus 时加上细腻的主题绿高透明度描边（`color-mix(in srgb, var(--brand, #10b981) 40%, transparent)`）与精确光标（`caret-color`）：

```css
/* apps/crish-desktop/src/components/workspace/PreviewCard.module.css */

.urlForm {
  flex: 1;
  min-width: 0;
  margin: 0 4px;
  display: flex;
  align-items: center;
}

.urlForm > div {
  width: 100%;
}

.urlInput {
  height: 24px !important;
  min-height: 24px !important;
  font-size: var(--font-size-xs, 12px) !important;
  background: transparent !important;
  border: 1px solid transparent !important;
  border-radius: var(--radius-md, 6px) !important;
  box-shadow: none !important;
  color: var(--text-primary);
  cursor: text;
  caret-color: var(--brand, hsl(160 84% 39%));
  transition:
    background var(--transition-micro, 120ms) ease,
    border-color var(--transition-micro, 120ms) ease;
}

.urlInput::placeholder {
  color: var(--text-tertiary) !important;
  opacity: 0.85;
}

/* 仅在地址栏自身处于 hover 时才产生微深背景，彻底根除 .bar:hover 联动污染 */
.urlInput:hover:not(:focus):not(:focus-visible):not(:disabled) {
  background: var(--sidebar-hover, color-mix(in srgb, var(--bg-card) 92%, var(--text-primary) 8%)) !important;
  border-color: transparent !important;
}

/* 激活态：细线描边 + 高透明度主题绿 + 恒定背景与纯净无重阴影 */
.urlInput:focus,
.urlInput:focus-visible {
  outline: none !important;
  background: var(--bg-card) !important;
  border-color: color-mix(in srgb, var(--brand, hsl(160 84% 39%)) 40%, transparent) !important;
  box-shadow: none !important;
}
```

### 2.4 验收标准与验证用例

1. **无关联 hover 污染验证**：鼠标在工具栏前进/后退/刷新按钮上移动时，地址栏背景保持 100% 透明，不得有任何变色；
2. **地址栏自身 hover 验证**：鼠标直接悬停在地址栏上时，背景以 `120ms` 平滑淡入微深灰色（`--sidebar-hover`），无突兀硬边框；
3. **点击激活验证**：点击进入编辑态，光标正常闪烁（呈绿色 `--brand`），边框以 1px 细线呈现 40% 透明度的柔和主题绿，无黑边与重阴影；
4. **占位符与清理钮验证**：占位词显示为“请输入网址”，颜色为浅灰（`--text-tertiary`）；输入任意内容后，右侧绝对不出现叉号（ClearIcon）。

---

## 三、问题 2：浏览器标签页动态 Favicon 与优雅回落

### 3.1 涉及文件与源码定位

- [LeafToolTabStrip.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx#L406-L450)（第 406–450 行）：工具标签栏渲染循环，目前使用静态 `viewRegistry.getIcon(tabId)`。
- [previewClientBridge.ts](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/previewClientBridge.ts)：注入到 iframe 内部的运行时客户端桥。
- [previewCardLib.ts](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/previewCardLib.ts#L68-L126)（第 68–126 行）：`injectPreviewBridgeHtml`，负责为代理网页注入 `<base>` 和通信脚本。
- [previewBrowserStore.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/previewBrowserStore.ts)：预览状态持久化与全局跨组件事件总线。

### 3.2 根因与架构链路分析

1. **静态图标绑定机制**：
   在 `LeafToolTabStrip.tsx` 中，Tab 图标完全依赖 `viewRegistry.getIcon(tabId)`。当 `tabId` 为 `preview` 或 `preview:*` 时，注册中心固定返回 Lucide 的 `Globe` 组件。
2. **跨域/沙箱环境下的 Favicon 提取壁垒**：
   - 同源 iframe：宿主可以通过 `iframe.contentDocument.querySelector('link[rel*="icon"]')` 读取；
   - 跨源 iframe：受同源策略（SOP）限制，宿主直接访问 `contentDocument` 会抛出 DOMException；
   - 本地代理网页：通过 `127.0.0.1:8765` 透明代理，已由 `injectPreviewBridgeHtml` 注入了宿主通信脚本；
   - 规范默认路径：万维网标准约定任何站点根路径都有 `/favicon.ico`。

### 3.3 技术设计与代码级实现

#### 3.3.1 第一层：Iframe 内部客户端自动提取与上报（Bridge 扩展）

在 `previewCardLib.ts` 的 `injectPreviewBridgeHtml` 以及 `previewClientBridge.ts` 的 `installPreviewInspectorClient` 中，增加 Favicon 探测逻辑，通过 `postMessage` 向宿主上报：

```javascript
// 在 bridge 脚本中执行
(function detectAndReportFavicon() {
  try {
    var link = document.querySelector("link[rel*='icon']");
    var iconHref = link ? link.href : (window.location.origin + '/favicon.ico');
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        source: 'crish-preview-client',
        type: 'preview:favicon',
        url: window.location.href,
        favicon: iconHref,
        title: document.title || ''
      }, '*');
    }
  } catch (_) {}
})();
```

#### 3.3.2 第二层：状态存储与事件分发（`previewBrowserStore.ts`）

在 `previewBrowserStore.ts` 中维护 `currentFavicon` 响应式状态，支持缓存与全局广播：

```typescript
// apps/crish-desktop/src/api/previewBrowserStore.ts

let currentFaviconUrl: string | null = null;

export function getPreviewFavicon(): string | null {
  return currentFaviconUrl;
}

export function setPreviewFavicon(url: string | null): void {
  if (currentFaviconUrl === url) return;
  currentFaviconUrl = url;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('crish-preview-favicon', { detail: { favicon: url } })
    );
  }
}
```

同时，在 `usePreviewNavigation.ts` 的 `onFrameLoad` 中增加同源与推导兜底：

```typescript
// apps/crish-desktop/src/components/workspace/usePreviewNavigation.ts
const onFrameLoad = () => {
  setLoading(false);
  setLoadError(false);
  // 兜底提取：尝试探测当前 activeUrl 的 favicon
  if (activeUrl && !isAboutBlank(activeUrl)) {
    try {
      const parsed = new URL(activeUrl);
      const defaultIco = `${parsed.origin}/favicon.ico`;
      // 若尚未收到 bridge 详细上报，先设置标准域名 ico
      setPreviewFavicon(defaultIco);
    } catch {
      setPreviewFavicon(null);
    }
  } else {
    setPreviewFavicon(null);
  }
};
```

#### 3.3.3 第三层：`LeafToolTabStrip.tsx` 动态渲染与优雅回落（Graceful Fallback）

在 Tab 渲染层，针对浏览器类型的 Tab 替换静态图标为动态 Favicon 组件：

```tsx
// apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx

interface DynamicTabIconProps {
  tabId: string;
  defaultIcon: React.ComponentType<{ size?: number; className?: string }>;
}

const DynamicTabIcon: React.FC<DynamicTabIconProps> = ({ tabId, defaultIcon: DefaultIcon }) => {
  const isPreview = isNavigableView(tabId);
  const [faviconUrl, setFaviconUrl] = useState<string | null>(() =>
    isPreview ? getPreviewFavicon() : null
  );
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (!isPreview) return;
    const handleFavicon = (e: Event) => {
      const detail = (e as CustomEvent<{ favicon?: string | null }>).detail;
      setFaviconUrl(detail?.favicon ?? null);
      setHasError(false);
    };
    window.addEventListener('crish-preview-favicon', handleFavicon);
    return () => window.removeEventListener('crish-preview-favicon', handleFavicon);
  }, [isPreview]);

  // 重置错误态
  useEffect(() => {
    setHasError(false);
  }, [faviconUrl]);

  if (isPreview && faviconUrl && !hasError) {
    return (
      <img
        src={faviconUrl}
        alt=""
        className={styles.dynamicFavicon}
        onError={() => setHasError(true)}
        aria-hidden="true"
      />
    );
  }

  return <DefaultIcon size={13} aria-hidden />;
};
```

CSS 样式保障（确保 Favicon 尺寸与 Lucide 图标严格 1:1 对齐）：

```css
/* apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css */
.dynamicFavicon {
  width: 13px;
  height: 13px;
  border-radius: 2px;
  object-fit: contain;
  display: block;
  flex-shrink: 0;
}
```

### 3.4 验收标准与验证用例

1. **真实网站 Favicon 展示**：导航到提供标准 Favicon 的站点（如 Vite 开发端口 `localhost:5173`、`github.com` 等），标签栏图标自动平滑替换为该站点的 13px 彩色 Favicon；
2. **加载失败/404 优雅回落**：访问未配置 Favicon 或图标资源失效的网站，`onError` 瞬间静默触发，平滑降级回落为 Lucide `Globe` 图标，无断裂图裂痕迹；
3. **空白页复位**：点击主页或导航到 `about:blank` 时，Tab 图标立即恢复为 `Globe`。

---

## 四、问题 3：右侧分割线 4px 视觉偏移与“粘手”根治

### 4.1 涉及文件与源码定位

- [LeafDockResizer.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafDockResizer.tsx)（全文 79 行）：右侧坞分割线组件。
- [TreeLeafPanel.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx#L464-L480)（第 464–480 行）：叶子容器内 Chat 列、Resizer、Drawer 的排版树。
- [BinaryTreeWorkspace.module.css](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L336-L390)（第 336–390 行）：`.leafBody`、`.leafDockResizer` 与 `.leafDockDrawer` 的 CSS 盒模型。
- [useSidebarResize.ts](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/useSidebarResize.ts)（对比基线）：左侧侧栏无错位、不粘手的标准实现。

### 4.2 几何排版错位 4px 物理数学证明与根因

用户反馈：“右侧拖拽分割线激活时的指示高亮线与右侧面板实际边框视觉上不重合，存在明显像素级错位偏移（约 4px）”。

通过审查 [BinaryTreeWorkspace.module.css](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L351-L390)，我们可以清晰推导出这一**精确 4px 物理错位**的几何根因：

#### 排版盒模型解析：
1. 父容器 `.leafBody[data-dock-open='true']` 采用横向 Flex 布局：`display: flex; flex-direction: row;`；
2. 子元素依次为：
   - 元素 1：`.leafChatColumn`（左侧对话列，`flex: 1 1 0%`）；
   - 元素 2：`.leafDockResizer`（**作为实体 Flex 项目参与排版**：`flex: 0 0 6px; width: 6px;`）；
   - 元素 3：`.leafDockDrawer`（右侧抽屉，`border-left: 1px solid var(--border-subtle)`）。

#### 物理坐标推导：
设 `.leafChatColumn` 右边界位于屏幕 X 坐标 $X_0$：
- **右侧面板实际物理边框位置**：
  由于 `.leafDockResizer` 占用了 `6px` 的实体流宽度，`.leafDockDrawer` 紧排其后，其左边界及 `border-left` 的实际位置为：
  $$X_{\text{border}} = X_0 + 6\text{px}$$
- **拖拽指示高亮线位置**：
  查看 `.leafDockResizer` 的 CSS 规则：
  ```css
  .leafDockResizer {
    width: 6px;
    position: relative;
  }
  .leafDockResizer:hover::after,
  .leafDockResizer[data-dragging='true']::after {
    position: absolute;
    width: 2px;
    left: 2px;
  }
  ```
  高亮线相对于 `.leafDockResizer` 左边缘的偏移量为 `left: 2px`，故高亮线在屏幕上的实际位置为：
  $$X_{\text{highlight}} = X_0 + 2\text{px}$$
- **二者间距偏移量**：
  $$\Delta X = X_{\text{border}} - X_{\text{highlight}} = (X_0 + 6\text{px}) - (X_0 + 2\text{px}) = 4\text{px}$$

**结论**：高亮线（激活绿线）永远落在实际边框的**左侧整整 4 个像素处**！这就是用户反馈“明显存在约 4px 像素级错位偏移”的根本原因。

---

### 4.3 拖拽“粘手”底层机理穿透（Pointer 劫持与 iframe 黑洞）

用户反馈：“右侧分割线在拖拽过程中会‘粘手’（光标移入右侧面板或其内部 iframe 释放鼠标后无法停止拖拽，而左侧侧边栏 resizer 则完全正常不会粘手）”。

对比左侧 `useSidebarResize.ts` 与右侧 `LeafDockResizer.tsx`，定位到三大架构断层：

#### 根因 1：Pointer Capture 机制彻底缺失
在 `useSidebarResize.ts:143` 中，启动时调用了：
```typescript
handleEl.setPointerCapture(e.pointerId);
```
但在 `LeafDockResizer.tsx` 中，**完全没有调用 `setPointerCapture`**！
未锁定指针时，浏览器对移动与释放事件的处理遵循常规的命中测试（Hit Testing）。

#### 根因 2：iframe 跨文档事件黑洞（核心致命点）
右侧面板渲染的正是 `PreviewCard`，其内部包含内嵌网页的 **原生 `<iframe>`**！
- 当用户向右拖动分割线时，鼠标光标瞬间滑过分割线边界，进入右侧面板的 `<iframe>` 区域；
- 由于 `LeafDockResizer` 没有 Pointer Capture，且拖拽期间右侧 `<iframe>` 仍然保持 `pointer-events: auto`；
- **浏览器的事件循环机制规定：一旦指针移入 iframe 视口，随后的所有 `pointermove`、`mousemove`、`pointerup`、`mouseup` 事件将全部派发给 iframe 内部的 Window 上下文，主应用的宿主 Window 将彻底失去所有指针事件！**
- 用户在 iframe 区域松开鼠标，iframe 吸收了 `mouseup`，宿主 Window 上监听的 `window.addEventListener('pointerup', onUp)` **永远不会触发**；
- 此时 `draggingRef.current` 永久维持在 `true`。当鼠标再移回宿主时，分割线依旧死死吸附在鼠标上——即所谓的“**严重粘手**”！

#### 根因 3：Body 全局拖拽状态机未建立
左侧拖拽时会在 `document.body` 增加 `is-resizing` 类，而 `LeafDockResizer.tsx` 仅仅在 `leafBody` 上加了 `.is-dragging`，未通知 `document.body`，导致全局无法联动禁用全局 iframe 的鼠标交互。

---

### 4.4 像素级重合对齐与三级事件保护设计

#### 4.4.1 几何重构：将 Resizer 转换为 0 占位绝对定位悬浮热区

消除 4px 错位的最彻底、最优雅方案：**让 `.leafDockDrawer` 的 `border-left` 成为唯一视觉分界，将 `.leafDockResizer` 移出文档流，作为绝对定位的悬浮触摸层，覆盖在抽屉左边缘上**。

```css
/* apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css */

/* 1. 抽屉自身保持 border-left 作为真实物理分界线 */
.leafDockDrawer {
  flex: 0 0 var(--leaf-dock-width, 50%);
  width: var(--leaf-dock-width, 50%);
  min-width: 200px;
  max-width: 70%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: visible; /* 允许悬浮热区外溢 3px */
  position: relative;
  border-left: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08));
}

/* 2. 将 Resizer 改造为跨界绝对定位（挂在抽屉左边缘） */
.leafDockResizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px; /* 宽度 6px，中心点恰好对齐 border-left (0px 处) */
  width: 6px;
  cursor: col-resize;
  touch-action: none;
  z-index: 100;
  background: transparent;
}

/* 3. 高亮绿线：居中放置在 2px~4px，正中心位于 3px，完美覆盖 0px 处的边框 */
.leafDockResizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
  background: transparent;
  pointer-events: none;
  transition: background var(--transition-fast, 150ms ease-out);
}

.leafDockResizer:hover::after,
.leafDockResizer[data-dragging='true']::after {
  background: var(--accent-green, #10b981);
}
```

> **几何数学验证**：
> - 抽屉左边框 $X_{\text{border}} = 0\text{px}$；
> - Resizer 区域 $[-3\text{px}, +3\text{px}]$，中心 $0\text{px}$；
> - 高亮线从 $X = -3\text{px} + 2\text{px} = -1\text{px}$ 到 $+1\text{px}$，宽度 $2\text{px}$，精确包裹在 $0\text{px}$ 边框正上方；
> - **偏移差值**：$|X_{\text{border}} - X_{\text{highlight-center}}| = 0\text{px}$（**0 误差绝对重合！**）

#### 4.4.2 粘手根治：三级事件防护与 iframe 穿透隔离状态机

在 `LeafDockResizer.tsx` 中落实刚性三级防护：

```tsx
// apps/crish-desktop/src/components/binary-tree/LeafDockResizer.tsx
import React, { useCallback, useRef, useState } from 'react';
import styles from './BinaryTreeWorkspace.module.css';

function clampDockRatio(ratio: number): number {
  return Math.min(0.75, Math.max(0.2, ratio));
}

export function LeafDockResizer({
  leafBodyRef,
  widthRatio,
  onCommitRatio,
}: {
  leafBodyRef: React.RefObject<HTMLDivElement | null>;
  widthRatio: number;
  onCommitRatio: (ratio: number) => void;
}) {
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // 仅响应鼠标主键
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const handleEl = e.currentTarget;
      const body = leafBodyRef.current;
      if (!body) return;

      // 【一级防护】：强制捕获当前 Pointer，锁定所有后续事件至本元素
      try {
        handleEl.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom 或特殊设备降级 */
      }

      draggingRef.current = true;
      setDragging(true);

      // 【二级防护】：全局 Body 注入拖拽状态机，配合 CSS 彻底阻断 iframe 命中
      body.classList.add('is-dragging');
      document.body.classList.add('is-resizing', 'leaf-dock-resizing');

      const startX = e.clientX;
      const bodyWidth = body.clientWidth;
      const startWidth = Math.max(
        200,
        Math.min(bodyWidth * 0.7, widthRatio * bodyWidth)
      );

      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        const next = Math.max(
          200,
          Math.min(bodyWidth * 0.7, startWidth + (startX - ev.clientX))
        );
        body.style.setProperty('--leaf-dock-width', `${next}px`);
      };

      const cleanup = (upEvent?: PointerEvent) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        setDragging(false);

        // 释放 Pointer 捕获
        try {
          if (upEvent && handleEl.hasPointerCapture?.(upEvent.pointerId)) {
            handleEl.releasePointerCapture(upEvent.pointerId);
          }
        } catch {}

        body.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing', 'leaf-dock-resizing');

        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);

        const px = parseFloat(body.style.getPropertyValue('--leaf-dock-width'));
        if (Number.isFinite(px) && bodyWidth > 0) {
          onCommitRatio(clampDockRatio(px / bodyWidth));
        }
      };

      // 【三级防护】：同时监听 pointerup 与 pointercancel，失焦不脱靶
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', cleanup);
      window.addEventListener('pointercancel', cleanup);
    },
    [leafBodyRef, onCommitRatio, widthRatio]
  );

  return (
    <div
      className={`${styles.leafDockResizer} layout-resizer layout-resizer-panel`}
      data-leaf-dock-resizer="true"
      data-dragging={dragging ? 'true' : 'false'}
      onPointerDown={handlePointerDown}
      role="separator"
      aria-orientation="vertical"
    />
  );
}
```

#### 4.4.3 全局 CSS 封锁 iframe 事件劫持

在全局样式中确保在任何调整大小（`is-resizing`）期间，所有内嵌 `iframe` 均关闭事件接收：

```css
/* apps/crish-desktop/src/styles/global.css 或 BinaryTreeWorkspace.module.css */
:global(body.is-resizing) iframe,
:global(body.leaf-dock-resizing) iframe {
  pointer-events: none !important;
  user-select: none !important;
}
```

### 4.5 验收标准与验证用例

1. **4px 像素级重合检验**：
   悬停在右侧拖拽分割线上，绿色指示线必须 100% 严丝合缝地重合在右侧面板的实际边框上；肉眼观察与截屏测量均为 0 像素偏移错位；
2. **iframe 内部释放鼠标防粘手验证（魔鬼用例）**：
   按住右侧分割线向右侧大幅度拖拽，将鼠标直接移入加载了复杂网页的 `iframe` 正中心并松开鼠标左键；
   **断言**：拖拽立即终止，分割线立即释放就地固定，鼠标继续移动时分割线绝不跟随，彻底告别粘手；
3. **窗口外部释放与 Esc 取消验证**：
   拖拽中鼠标移出应用窗口外释放，或触发 `pointercancel`，状态机均能安全复位。

---

## 五、问题 4：默认空白页与极简空状态（Empty State）

### 5.1 涉及文件与源码定位

- [PreviewCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.tsx#L317-L359)（第 317–359 行）：空状态渲染逻辑。
- [PreviewCard.module.css](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css#L330-L448)（第 330–448 行）：`.empty`、`.activeServiceCapsule`、`.activePortsRow` 样式。
- [api/previewBrowserStore.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/previewBrowserStore.ts#L180-L191)（第 180–191 行）：`getPreviewUrl()` 初始 URL 解析逻辑。

### 5.2 根因与设计缺陷分析

1. **默认打开倾向于外链**：
   虽然代码底层以 `about:blank` 作为白名单兜底，但在历史交互中如果存留了访问历史，常容易误恢复历史网页（甚至外部站点如 Google 等）。用户明确要求：**默认不用打开谷歌，应为纯净空界面**。
2. **当前空状态视觉繁琐、侵入感过强**：
   当前空状态渲染了带有脉冲绿点（`activeServicePulse`）、胶囊圆角（`activeServiceCapsule`）、阴影以及长文本“运行中的本地服务: localhost:5173”的复杂卡片，破坏了沉浸式空白界面的高级质感。
3. **缺乏“最近访问”高频入口**：
   用户已有的访问历史（History）沉睡在二级弹窗中，在空界面上未按“宁少勿多”原则以极简方式释放。

### 5.3 技术设计与代码级实现

#### 5.3.1 改造 `PreviewCard.tsx` 空状态结构

- 必须为纯文字形式；
- hover 灰度极低；
- 居中竖排放置；
- 展示最近打开的网页（极简图标 + 简短域名/标题），限制最多 3~4 项，宁少勿多；
- 无信息时保持极致干净空白（双空时彻底无杂质）。

```tsx
// apps/crish-desktop/src/components/workspace/PreviewCard.tsx

{!canEmbed || blank || !frameSrc ? (
  <div className={styles.emptyContainer} data-testid="preview-empty-state">
    <div className={styles.emptyCenterContent}>
      {/* 1. 运行中的本地端口服务（纯文字极简纵向列表） */}
      {activePorts.length > 0 && (
        <div
          className={styles.minimalGroup}
          role="group"
          aria-label="运行中的本地服务"
        >
          <div className={styles.minimalGroupHeader}>运行中的本地服务</div>
          <div className={styles.minimalList}>
            {activePorts.map((port) => (
              <button
                key={port}
                type="button"
                className={styles.minimalTextBtn}
                onClick={() => navigate(`http://localhost:${port}`)}
                aria-label={`打开本地服务 localhost:${port}`}
              >
                <span>http://localhost:{port}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 2. 最近打开的网页（极简图标 + 简短域名，至多 3 条，宁少勿多） */}
      {history.filter((u) => u && !isAboutBlank(u)).length > 0 && (
        <div
          className={styles.minimalGroup}
          role="group"
          aria-label="最近访问"
        >
          <div className={styles.minimalGroupHeader}>最近访问</div>
          <div className={styles.minimalList}>
            {history
              .filter((u) => u && !isAboutBlank(u))
              .slice(0, 3)
              .map((url) => {
                const label = previewDisplayHost(url) || url;
                return (
                  <button
                    key={url}
                    type="button"
                    className={styles.minimalTextBtn}
                    onClick={() => navigate(url)}
                    title={url}
                  >
                    <Lucide.Globe
                      size={12}
                      className={styles.minimalBtnIcon}
                      aria-hidden
                    />
                    <span className={styles.minimalBtnText}>{label}</span>
                  </button>
                );
              })}
          </div>
        </div>
      )}
    </div>
  </div>
) : loadError || !showFrame ? (
...
```

#### 5.3.2 改造 `PreviewCard.module.css`

打造极致轻量、hover 灰度极低（低于 4% 灰度混入）的纯文字竖排视觉样式：

```css
/* apps/crish-desktop/src/components/workspace/PreviewCard.module.css */

.emptyContainer {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
  box-sizing: border-box;
  padding: 24px;
}

.emptyCenterContent {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  max-width: 320px;
  width: 100%;
}

.minimalGroup {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.minimalGroupHeader {
  font-size: 11px;
  color: var(--text-tertiary);
  font-weight: 400;
  letter-spacing: 0.02em;
  margin-bottom: 2px;
}

.minimalList {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 100%;
}

/* 纯文字按钮：无边框、无胶囊高亮、极低灰度 hover */
.minimalTextBtn {
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 4px);
  padding: 4px 10px;
  font-size: var(--font-size-xs, 12px);
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition:
    background var(--transition-micro, 100ms) ease,
    color var(--transition-micro, 100ms) ease;
  outline: none;
  text-decoration: none;
  max-width: 100%;
}

.minimalTextBtn:hover {
  /* hover 灰度极低（微混入 4% 文本色），克制不突兀 */
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
  color: var(--text-primary);
}

.minimalTextBtn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--brand, #10b981) 40%, transparent);
  color: var(--text-primary);
}

.minimalBtnIcon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.minimalBtnText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

### 5.4 验收标准与验证用例

1. **默认纯净空白**：用户首次打开浏览器面板时，地址栏为空或 `about:blank`，绝不加载任何外部主页（如 Google）；
2. **本地端口纯文字展示**：当本地存在 Vite 等服务时，以垂直居中、无发光绿点、无厚重胶囊边框的纯文本链接呈现；鼠标悬停时背景仅出现极其微妙的浅淡灰度；
3. **最近访问收敛展示**：最近打开的网址以简短域名形式排列在本地服务下方，上限 3 条；
4. **无信息时极致纯净**：当既无活跃本地服务也无访问历史时，整个预览区域呈现一片干净素雅的空白，无任何大面积插图与冗余引导文本。

---

## 六、综合影响面与回归验证矩阵

| 模块 | 影响范围 | 回归验证关注点 | 风险等级 |
| :--- | :--- | :--- | :--- |
| **地址栏组件**<br>`PreviewToolbar.tsx` | 浏览器工具栏输入体验 | 1. 回车导航是否依然正常响应<br>2. 输入法（IME）拼音输入回车不被拦截<br>3. 占位文本是否克制一致 | 低 |
| **工具栏样式**<br>`PreviewCard.module.css` | 地址栏视觉样式 | 1. 工具栏整体 hover 不会触发地址栏变色<br>2. 聚焦时主题绿描边细腻且无重阴影 | 低 |
| **Tab 动态 Favicon**<br>`LeafToolTabStrip.tsx` | 所有包含浏览器的工具标签栏 | 1. 跨域/代理网站 Favicon 正常显示<br>2. 失败站点优雅回退到 Globe 图标<br>3. 13px 尺寸与行高对齐 | 低 |
| **右侧分割线几何排版**<br>`BinaryTreeWorkspace.module.css` | 双分屏与工具抽屉 | 1. 指示绿线与面板边框 100% 像素级重合<br>2. 抽屉与主聊天区域间距平滑无多余缝隙 | 低 |
| **拖拽事件机制**<br>`LeafDockResizer.tsx` | 二叉树叶内坞拖拽 | 1. Pointer Capture 正常捕获<br>2. 鼠标移入 iframe 释放绝不粘手<br>3. 拖拽边界比例（20%~75%）保持受限 | 低 |
| **空状态展示**<br>`PreviewCard.tsx` | 预览空白页 | 1. 本地服务端口纯文字点击可直接跳转<br>2. 最近访问点击可跳转<br>3. 双空状态纯净留白 | 低 |

---

## 七、总结

本方案针对用户反馈的 4 项交互与视觉缺陷，实施了精准无损的穿透式根治：
1. 地址栏摒弃冗余的叉号与误触联动，吸纳侧栏输入规范，呈现克制温润的微主题绿焦点态；
2. 标签页打通了 iframe 到工具栏的 Favicon 动态探测网络，同时保持 `onError` 零视觉割裂的优雅回退；
3. 从几何排版上消除 6px 与 2px 的差值，彻底消解 4px 错位；在事件层引入 Pointer Capture 与全局 iframe 遮罩穿透机制，彻底根治拖拽粘手难题；
4. 空状态清退繁琐视觉噪声，以纯文字竖排与宁少勿多原则，重构纯净、高效的开发者空白页。
