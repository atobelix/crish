# Markdown 表格渲染与交互行为统一架构方案

> **文件标识**：`docs/markdown-unified-architecture/independent-plans/04-table-and-interaction-plan.md`  
> **所属战役**：`markdown-unified-architecture` 独立详案篇章 04  
> **设计定位**：端到端解决 Markdown 表格排版溃散、列宽粘连、跨容器断层、交互事件散落与按钮伪连通问题，确立全桌面端统一的表格物理排版与交互总线标准。  
> **架构纪律**：纯逻辑规划、问题同权（无业务优先级削减）、全 Token 驱动（杜绝硬编码）、原生高效、无退避设计。

---

## 一、 执行摘要与根因穿透分析

### 1.1 表格溃散与粘连的真实源码根因

在实际业务场景中，用户截图中展示的“表格完全溃散，列与列紧贴成一团生文本，完全失去表格形态”是典型的 **CSS 样式真理源断层（Styling SSOT Fragmentation）** 导致的灾难性回退。通过全面穿透前后端源码，其确切机制如下：

1. **解析层与输出契约的完备性**：
   - 无论底层采用 Rust 引擎（`crates/conex-markdown/src/renderer.rs:547-640`）还是前端 TypeScript 解析器（`apps/crish-desktop/src/api/markdown-render/markdownTable.ts:132-188`），GFM 表格均被编译为标准的语义化 HTML 结构：
     ```html
     <div class="md-table-wrap" role="region" aria-label="表格">
       <table class="md-table">
         <thead>
           <tr class="md-tr">
             <th class="md-th" scope="col">...</th>
           </tr>
         </thead>
         <tbody>
           <tr class="md-tr">
             <td class="md-td">...</td>
           </tr>
         </tbody>
       </table>
     </div>
     ```
   - 此契约输出了明确的 CSS 类名：`.md-table-wrap`、`.md-table`、`.md-tr`、`.md-th`、`.md-td` 以及斑马纹行 `.md-tr-alt`。

2. **样式绑定的孤岛隔离与真空断层**：
   - 全仓库中，对 `.md-table`、`.md-th`、`.md-td` 具有完整边框、Padding、吸顶背景的唯一定义全部封闭在 `apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css` 中；
   - 然而，该文件是 CSS Module，所有核心规则均强依赖于父选择器 `.tableScrollViewport :global(.md-table)` 和 `.tableContainerRoot`；
   - 在真实的消息流组件 `MarkdownBlockItem.tsx:144` 中，HTML 是通过 `el.innerHTML = html` 直接注入的，其外部仅有 `className={`${styles.assistantText} md-rendered md-block-sealed`}`。**DOM 树中根本不存在 `.tableContainerRoot` 或 `.tableScrollViewport` 节点**！
   - 在 `ChatMessageRow.module.css:667-671` 中，针对会话流助手文本仅存在如下一段规则：
     ```css
     .assistantText :global(.md-table-wrap) {
       margin: 0.35em 0;
       overflow-x: auto;
       max-width: 100%;
     }
     ```
     对 `.md-table`、`th`、`td` 样式定义为 **0**！
   - 在全局样式库（`design-system.css`、`tokens.css`）中，虽然 `tokens.css:582-601` 声明了完备的 `--md-table-*` 设计变量，但 `design-system.css` 中关于表格的类名选择器定义为 **0**！
   - **崩溃推导链**：
     由于缺少对 `.md-table` 的任何有效声明，浏览器使用默认的 User-Agent 样式或基础全局重置 `table { border-collapse: collapse; }`。在此状态下：
     - `th` 与 `td` 的 `padding` 回退为 0（或仅 1px）；
     - 单元格无水平边框与垂直发丝线；
     - 单元格无独立背景；
     - 结果：第 1 列的尾字符与第 2 列的首字符在像素上直接连缀重叠，整张数据表在视觉上瞬间坍缩为一段难以辨识的生文本团块！

3. **文档阅读面（FilePreview / SkillDetailPreview）的全然失守**：
   - 在文件预览面 `FilePreview.tsx:219` 中：
     ```tsx
     <div className={`${styles.filesMdBody} md-rendered msg-assistant-text`} dangerouslySetInnerHTML={{ __html: mdHtmlIndented }} />
     ```
   - 在技能文档预览 `SkillDetailPreview.tsx:156` 中：
     ```tsx
     <div className={`${styles.skillsPreview} ... md-rendered msg-assistant-text`} dangerouslySetInnerHTML={{ __html: previewHtmlIndented }} />
     ```
   - 经全局搜索，`msg-assistant-text` 是一段从未在任何 CSS 文件中声明过的**幽灵类名（Phantom Class）**！这导致不仅会话流表格受损，在所有独立文档阅读面中，表格样式完全是一片空白荒漠。

---

### 1.2 交互事件伪连通（Pseudo-Connectivity）根因穿透

“有样式、有光标，但点击无反应或交互静默”，是严重削弱用户信心的工程隐患。其源码根因如下：

1. **复制按钮（`.md-code-copy`）状态机死锁与静默反馈**：
   - 检查唯一挂载了复制逻辑的 `useChatMessageState.ts:188-204`：
     ```typescript
     const copyBtn = target.closest('.md-code-copy');
     if (copyBtn instanceof HTMLElement) {
       e.preventDefault();
       e.stopPropagation();
       const text = copyBtn.closest('.md-code-block')?.querySelector('pre')?.textContent ?? '';
       if (!text) return;
       void navigator.clipboard.writeText(text).then(
         () => {},
         () => toast.show('复制失败')
       );
       return;
     }
     ```
   - **严重缺陷 1（零视觉反馈）**：虽然 `design-system.css:157` 与 `ChatMessageRow.module.css:651` 定义了 `.md-code-copy.is-copied`，但 JS 逻辑**从未向 `copyBtn` 添加或移除该类名**！按钮文案始终停留在“复制”，没有任何对勾图标、没有背景变色、没有“已复制”提示。用户点击后毫无物理反馈，直觉判定为“功能损坏”；
   - **严重缺陷 2（剪贴板脆弱性）**：仅依赖异步 `navigator.clipboard.writeText`。在 WebView2 窗口失去焦点或特定权限受限场景下，Promise 失败仅触发 `toast.show('复制失败')`，缺失基于隐藏 `textarea` + `document.execCommand('copy')` 的成熟降级链路；
   - **严重缺陷 3（阅读面完全遗漏）**：该事件监听通过 `handleMarkdownClick` 仅挂载在 `MessageVirtualizer.tsx:305`（会话流）；在 `FilePreview.tsx` 和 `SkillDetailPreview.tsx` 中，**根本未绑定任何点击处理函数**。文档阅读面中的所有代码块复制按钮均为纯摆设！

2. **路径跳转（`.md-path-link`）的单向孤岛与脆弱解析**：
   - 路径链接由解析器生成为 `<button type="button" class="md-path-link" data-path="...">`；
   - `useChatMessageState.ts:205-214` 仅将其派发给 `onOpenPathRef.current?.(path.trim())`；
   - **断裂点 1**：当路径携带行列定位（如 `apps/crish-desktop/src/main.ts:42` 或 `lib.rs#L10-L20`）时，直接送入 `openFileInPanel` / `resolveWorkspacePath` 会因 Windows 文件系统非法字符（`:`）而被全盘拒绝返回空串，导致点击静默无效；
   - **断裂点 2**：在阅读面、时间线（`InlineAgentTimeline.tsx`）、自定义确认卡片中，没有统一事件委托，路径按钮退化为不可交互标签。

3. **外部链接（`<a class="md-a">`）的安全隐患与行为失控**：
   - 当前在 `useChatMessageState.ts` 中**完全没有拦截 `<a>` 标签**；
   - 在桌面客户端（Tauri WebView2）环境下，直接点击 `<a href="https://..." target="_blank">` 会导致不可控的行为（例如打开未经修饰的内置新窗口，甚至在没有 `target="_blank"` 时将整个桌面工作台页面重定向至外部网站并丢失所有会话状态）；
   - 缺乏运行时的白名单二次验证与拦截机制，对不合规的 XSS 攻击 Scheme（如绕过静态阶段的动态走私）缺乏动态阻断。

---

## 二、 核心架构原则与设计标准

本方案遵循以下不妥协的工程红线：

```
                    ┌──────────────────────────────────────────────────────────┐
                    │          Markdown 统一架构设计红线 (SSOT & Hard Rules)     │
                    └─────────────────────────────┬────────────────────────────┘
                                                  │
         ┌────────────────────────┬───────────────┴───────────────┬────────────────────────┐
         ▼                        ▼                               ▼                        ▼
┌──────────────────┐    ┌──────────────────┐            ┌──────────────────┐    ┌──────────────────┐
│   全 Token 驱动   │    │  容器隔离与容器查询 │            │  统一交互事件总线  │    │ 纯逻辑零退避规划 │
│ 杜绝一切魔术数字  │    │ @container 精准响应 │            │ O(1) 委托无散落   │    │ 问题同权立体守门 │
└──────────────────┘    └──────────────────┘            └──────────────────┘    └──────────────────┘
```

1. **绝对真理源（Global Design Token SSOT）**：
   所有尺寸、边框、颜色、阴影与过渡，必须 100% 消费 `tokens.css` 中声明的变量（如 `--md-table-border`、`--md-table-cell-padding`、`--md-path-link-bg` 等），严禁在组件模块中硬编码像素或十六进制色彩。
2. **逻辑同权与反退避原则**：
   排版美观性、响应式滚动平滑度、交互反馈准确性与安全拦截同等重要。禁止以“流式状态下做表格太复杂”为由降级为纯文本，禁止以“阅读面优先级低”为由放弃事件代理。
3. **架构净收敛（Zero Duplicate & Dead Code Elimination）**：
   消除散落在 `ChatMessageRow.module.css`、`StreamingTableContainer.module.css` 和各预览组件中的私有碎片，建立共享的 Markdown 排版与交互分层。

---

## 三、 模块详案一：表格物理排版与容器隔离架构

### 3.1 边框折叠与外壳圆角防溢出解法

在 CSS 规范中，当 `table` 处于 `border-collapse: collapse` 模式时，根据 W3C 规范，表格自身的 `border-radius` 将失效且不可裁剪边框。为了兼顾**圆角容器外壳**与**单元格精密发丝线折叠**，本架构确立“双层物理隔离模型”：

```
┌── .md-table-wrap (外壳容器) ────────────────────────────────────────────────────────┐
│  • border-radius: var(--md-table-radius, 8px)                                      │
│  • border: var(--md-table-border-width, 1px) solid var(--md-table-border)          │
│  • overflow-x: auto; background: var(--md-table-bg)                                │
│  • container-type: inline-size; container-name: mdTableWrap                        │
│                                                                                    │
│  ┌── table.md-table (内部表格) ──────────────────────────────────────────────────┐  │
│  │  • border-collapse: collapse; border: none; min-width: 100%                   │  │
│  │  • table-layout: auto (宽表自然展开)                                          │  │
│  │                                                                               │  │
│  │  ┌── thead th.md-th (吸顶表头) ─────────────────────────────────────────────┐  │  │
│  │  │  • position: sticky; top: 0; z-index: 2                                   │  │  │
│  │  │  • background: var(--md-table-header-bg)                                  │  │  │
│  │  │  • box-shadow: inset 0 -1px 0 var(--md-table-header-border)               │  │  │
│  │  └──────────────────────────────────────────────────────────────────────────┘  │  │
│  │  ┌── tbody td.md-td (单元格数据层) ──────────────────────────────────────────┐  │  │
│  │  │  • padding: var(--md-table-cell-padding)                                  │  │  │
│  │  │  • border-bottom: 1px solid var(--md-table-row-border)                     │  │  │
│  │  │  • tr:last-child td { border-bottom: none; } 彻底避免底边双线重叠          │  │  │
│  │  └──────────────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

#### 规范 CSS 规则落地规范

```css
/* ==========================================================================
   1. 表格宿主外壳 (.md-table-wrap)
   ========================================================================== */
.md-table-wrap {
  position: relative;
  width: 100%;
  max-width: 100%;
  margin: var(--space-3, 12px) 0;
  border-radius: var(--md-table-radius, var(--radius-lg, 8px));
  border: var(--md-table-border-width, var(--hairline-width, 1px)) solid var(--md-table-border, var(--border-color));
  background: var(--md-table-bg, var(--bg-secondary));
  box-sizing: border-box;
  overflow-x: auto;
  overflow-y: hidden;
  /* 现代容器查询锚点：不依赖 Window 视口，根据卡片宿主实际可用宽度计算 */
  container-type: inline-size;
  container-name: mdTableWrap;
  /* 滚动隔离：防止局部滚动链式传导 */
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
}

/* ==========================================================================
   2. 内部表格本体 (.md-table)
   ========================================================================== */
.md-table {
  width: 100%;
  min-width: 100%;
  margin: 0;
  border-collapse: collapse;
  border-spacing: 0;
  border: none; /* 外边框全由 .md-table-wrap 承载，消除双重线 */
  font-size: var(--md-table-font-size, var(--font-size-sm, 13px));
  line-height: var(--md-table-line-height, 1.55);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums; /* 数字等宽对齐 */
}

/* ==========================================================================
   3. 单元格通用布局与断词防溢出 (.md-th, .md-td)
   ========================================================================== */
.md-table th,
.md-table td,
.md-table .md-th,
.md-table .md-td {
  padding: var(--md-table-cell-padding, var(--space-2, 8px) var(--space-3, 12px));
  vertical-align: top;
  border-bottom: var(--md-table-border-width, var(--hairline-width, 1px)) solid var(--md-table-row-border, var(--border-subtle));
  box-sizing: border-box;
  /* 防溢出与智能断词 */
  word-break: break-word;
  overflow-wrap: break-word;
}

/* 末行去底边：避免与外壳底部 border 发生 2px 堆叠硬边 */
.md-table tbody tr:last-child th,
.md-table tbody tr:last-child td,
.md-table tbody tr:last-child .md-td {
  border-bottom: none;
}
```

---

### 3.2 吸顶表头（Sticky Header）与多层级毛玻璃穿透防漏

在包含大量数据的表格中，局部纵向滚动或外层滚动时，保持表头常驻视口是核心体验。但在 `border-collapse: collapse` 环境下，Chromium 存在著名的 **Sticky 单元格 border-bottom 脱落** 渲染缺陷。

#### 架构解法：内阴影（Inset Box-Shadow）发丝线替代法
不使用物理 `border-bottom` 作为表头分割线，改用 `box-shadow: inset 0 -1px 0 ...`。由于内阴影属于图层绘制像素而非网格边框计算，能够在 `position: sticky` 偏移时始终锁定在表头下边缘。

```css
/* ==========================================================================
   4. 吸顶表头 (Sticky Header)
   ========================================================================== */
.md-table thead th,
.md-table .md-th {
  position: sticky;
  top: 0;
  z-index: 2;
  background-color: var(--md-table-header-bg, var(--bg-card));
  color: var(--md-table-header-fg, var(--text-primary));
  font-weight: var(--md-table-header-font-weight, 600);
  text-align: left;
  user-select: none;
  border-bottom: none;
  /* 解决 Blink 引擎下 sticky cell 边框位移脱落缺陷 */
  box-shadow: inset 0 calc(-1 * var(--md-table-border-width, 1px)) 0 var(--md-table-header-border, var(--border-color));
}

/* 顶部首尾角对齐 */
.md-table thead tr:first-child th:first-child {
  border-top-left-radius: calc(var(--md-table-radius, var(--radius-lg, 8px)) - 1px);
}
.md-table thead tr:first-child th:last-child {
  border-top-right-radius: calc(var(--md-table-radius, var(--radius-lg, 8px)) - 1px);
}
```

---

### 3.3 斑马纹与悬停高亮双重通道

为防止大表阅读时视线串行，提供高可辨识度且克制的行背景：

```css
/* ==========================================================================
   5. 斑马纹 (Zebra Striping) 与悬停反馈 (Row Hover)
   ========================================================================== */
/* 偶数行轻微灰度增强：同时兼容 AST 生成的 .md-tr-alt 与原生 CSS 选择器 */
.md-table tbody tr:nth-child(even),
.md-table tbody tr.md-tr-alt {
  background-color: var(--md-table-row-even-bg, color-mix(in srgb, var(--text-primary) 1.5%, transparent));
}

/* 行悬停高亮 */
.md-table tbody tr:hover {
  background-color: var(--md-table-row-hover-bg, color-mix(in srgb, var(--text-primary) 3%, var(--bg-card)));
  transition: background-color var(--transition-fast, 120ms ease);
}
```

---

## 四、 模块详案二：响应式排版、超宽横向滚动与防抽搐机制

### 4.1 流式抽搐（Layout Jitter）深度剖析与双轨平滑布局

#### 抽搐根因
在 AI 逐字输出阶段，若表格采用纯 `table-layout: auto`：
- 第 1 行仅收到 2 个短词，列宽分配为 `50% : 50%`；
- 第 2 行吐出一段 60 字符的代码路径或长句子，导致第 1 列瞬间被推挤至 `80%`，第 2 列缩窄为 `20%`；
- 每个 Token 到达都会引发整张表格重排，产生严重的横向抖动。

#### 反过度设计与真理方案
`StreamingTableContainer.module.css` 曾试图通过 `table-layout: fixed; width: 100%` 解决抖动，但其致命缺陷是：**在未显式定义 `<col>` 宽度时，浏览器将空间均分给所有列**。在 400px 视口下渲染 6 列表格，每列被锁死在约 66px，长文本发生灾难性挤压！

**本方案确立“弹性自适应双轨约束法”**：
1. **最小内容保护与弹性自然扩展**：
   ```css
   .md-table {
     /* 宽表策略：当内容超出时，宽度由单元格撑开；内容不足时拉满 100% */
     width: max-content;
     min-width: 100%;
   }
   ```
2. **单元格弹性宽度与流式抑制**：
   - 表头（Header）强制 `white-space: nowrap`，确保列名不被挤压成纵向竖排文字；
   - 单元格设置弹性最小与最大宽度（Min/Max Clamp）：
     ```css
     .md-table th,
     .md-table td {
       min-width: 64px;
       max-width: 480px;
     }
     ```
   - 在活跃流式状态下（`[data-table-streaming="true"]`），对最后一行最后一个单元格挂载品牌色呼吸脉冲反馈，明确告知用户当前渲染处于动态生长阶段。

---

### 4.2 容器查询（Container Queries）多级断点

通过 CSS `@container` 实现真正组件级的响应式适配（无论表格放置在侧边栏、对话流主屏、还是弹窗中，均根据其所在容器宽度动态缩放）：

```css
/* ==========================================================================
   6. 容器查询响应式适配 (Container Queries)
   ========================================================================== */
/* 窄屏紧凑模式 (容器宽度 <= 540px) */
@container mdTableWrap (max-width: 540px) {
  .md-table {
    font-size: var(--font-size-xs, 12px);
    line-height: 1.45;
  }
  .md-table th,
  .md-table td,
  .md-table .md-th,
  .md-table .md-td {
    padding: var(--md-table-cell-padding-compact, var(--space-1_5, 6px) var(--space-2, 8px));
    min-width: 52px;
  }
}

/* 超窄屏模式 (容器宽度 <= 360px) */
@container mdTableWrap (max-width: 360px) {
  .md-table th,
  .md-table td {
    padding: 4px 6px;
    font-size: 11px;
  }
}
```

---

### 4.3 独立滚动条与边缘内容阴影指示器（Scroll Boundary Shadows）

为了让用户直观察觉“该表格超出边界，支持横向滚动”，采用原生 CSS 驱动的滚动阴影指示，零额外 DOM 开销：

```css
/* ==========================================================================
   7. 局部独立滚动条与边缘滚动吸附阴影
   ========================================================================== */
.md-table-wrap {
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb, color-mix(in srgb, var(--text-primary) 20%, transparent)) transparent;
  /* 利用双层渐变背景实现纯 CSS 滚动边界提示阴影 */
  background:
    /* 遮盖层：跟随内容滚动 */
    linear-gradient(to right, var(--md-table-bg, var(--bg-secondary)), var(--md-table-bg, var(--bg-secondary))) left center,
    linear-gradient(to right, var(--md-table-bg, var(--bg-secondary)), var(--md-table-bg, var(--bg-secondary))) right center,
    /* 阴影层：固定在两侧外壳 */
    linear-gradient(to right, rgba(0, 0, 0, 0.08), transparent 12px) left center,
    linear-gradient(to left, rgba(0, 0, 0, 0.08), transparent 12px) right center;
  background-repeat: no-repeat;
  background-size: 20px 100%, 20px 100%, 12px 100%, 12px 100%;
  background-attachment: local, local, scroll, scroll;
}

.md-table-wrap::-webkit-scrollbar {
  height: 6px;
}
.md-table-wrap::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb, color-mix(in srgb, var(--text-primary) 20%, transparent));
  border-radius: 3px;
}
.md-table-wrap::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover, color-mix(in srgb, var(--text-primary) 35%, transparent));
}
```

---

## 五、 模块详案三：统一交互事件总线代理（Unified Event Bus）

### 5.1 架构设计：集中式 Markdown 交互调度器

为了彻底解决“不同页面事件监听散落、部分页面完全遗漏”的乱象，架构上建立单一真理源：`apps/crish-desktop/src/api/markdown-render/markdownInteractionDispatcher.ts`。

该模块对外提供纯函数与 React 绑定接口，**以 O(1) 事件委托方式接管任何 Markdown 容器内部的所有点击行为**。

```
                     [ DOM 点击事件 (MouseEvent) ]
                                   │
                                   ▼
          ┌─────────────────────────────────────────────────┐
          │      MarkdownInteractionDispatcher.dispatch     │
          └────────────────────────┬────────────────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         ▼                         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  .md-code-copy   │      │  .md-path-link   │      │   a.md-a / a     │
│   代码一键复制   │      │   本地路径跳转   │      │   外部/内部链接  │
└────────┬─────────┘      └────────┬─────────┘      └────────┬─────────┘
         │                         │                         │
         ▼                         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ • 状态机驱动动画 │      │ • 智能拆解行列号 │      │ • isSafeHref 拦截 │
│ • 剪贴板双轨降级 │      │ • openFileInPanel│      │ • 调系统默认浏览器│
│ • 自动复位定时器 │      │ • 广播事件自愈   │      │ • XSS Scheme 阻断│
└──────────────────┘      └──────────────────┘      └──────────────────┘
```

---

### 5.2 代码复制（`.md-code-copy`）闭环状态机

#### 状态机与双重降级实现机制

1. **三态生命周期**：
   - `IDLE`：默认态，文案为“复制”，无额外附加类；
   - `COPIED`：成功态，添加类名 `.is-copied`，文案变更为“已复制”，前置对勾反馈；
   - `REVERT`：挂载 1500ms 自动回退定时器。若用户在 1500ms 内重复点击，重置定时器并刷新反馈。
2. **剪贴板双轨容错**：
   - 优先通道：`navigator.clipboard.writeText(text)`；
   - 降级通道：动态创建隐藏 `textarea`，设为只读并选中文本，执行 `document.execCommand('copy')`；
   - 失败告警：若双通道均受系统策略拦截，触发 Toast“复制失败，请手动选取”。

#### 调度器逻辑核心实现

```typescript
// 模块内部状态：防内存泄漏的 WeakMap 定时器映射
const copyFeedbackTimers = new WeakMap<HTMLElement, number>();

export async function handleCodeCopyClick(btn: HTMLElement): Promise<boolean> {
  // 向上寻找所属代码块及其 pre 容器
  const codeBlock = btn.closest('.md-code-block');
  const pre = codeBlock?.querySelector('pre') ?? btn.parentElement?.querySelector('pre');
  const text = pre?.textContent ?? '';
  if (!text) return false;

  let success = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      success = true;
    }
  } catch {
    // 降级至 execCommand
    success = fallbackCopyText(text);
  }

  if (!success) {
    success = fallbackCopyText(text);
  }

  if (success) {
    // 1. 挂载视觉反馈类
    btn.classList.add('is-copied');
    const originalText = btn.getAttribute('data-original-text') || btn.textContent || '复制';
    if (!btn.hasAttribute('data-original-text')) {
      btn.setAttribute('data-original-text', originalText);
    }
    btn.textContent = '已复制';
    btn.setAttribute('aria-label', '复制成功');

    // 2. 清理旧定时器并启动回退
    const existingTimer = copyFeedbackTimers.get(btn);
    if (existingTimer) window.clearTimeout(existingTimer);

    const timer = window.setTimeout(() => {
      btn.classList.remove('is-copied');
      btn.textContent = btn.getAttribute('data-original-text') || '复制';
      btn.setAttribute('aria-label', '复制代码');
      copyFeedbackTimers.delete(btn);
    }, 1500);

    copyFeedbackTimers.set(btn, timer);
    return true;
  }

  return false;
}

function fallbackCopyText(text: string): boolean {
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    el.style.top = '-9999px';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
```

---

### 5.3 路径跳转（`.md-path-link`）智能拆解与派发

#### 行列号智能剥离
开发者经常输出包含行号的引用，例如：
- `apps/crish-desktop/src/main.ts:42`
- `crates/conex-markdown/src/lib.rs:18:5`
- `src/index.ts#L30-L45`

若原样将 `apps/crish-desktop/src/main.ts:42` 送往 `openFileInPanel`，路径解析器会因为 Windows 非法冒号而直接返回失败。

#### 路径清洗与行列提取算法

```typescript
export interface ParsedPathTarget {
  cleanPath: string;
  line?: number;
  col?: number;
}

export function parsePathAndLocation(rawPath: string): ParsedPathTarget {
  let s = String(rawPath ?? '').trim();
  let line: number | undefined;
  let col: number | undefined;

  // 1. 匹配 #L12 或 #L12-L24 锚点语法
  const hashMatch = s.match(/#L(\d+)(?:-L(\d+))?$/i);
  if (hashMatch) {
    line = parseInt(hashMatch[1]!, 10);
    s = s.slice(0, hashMatch.index);
  } else {
    // 2. 匹配 :line:col 或 :line 语法
    const colonMatch = s.match(/:(\d+)(?::(\d+))?$/);
    if (colonMatch) {
      line = parseInt(colonMatch[1]!, 10);
      if (colonMatch[2]) col = parseInt(colonMatch[2], 10);
      s = s.slice(0, colonMatch.index);
    }
  }

  return { cleanPath: s, line, col };
}
```

#### 派发执行链路
1. 解析路径与定位；
2. 优先调用系统的 `openFileInPanel(cleanPath)`；
3. 如果携带了 `line`，在打开文件后派发携带行列定位参数的 `crish-editor-goto` 事件，使编辑器视图无缝滚至对应行并高亮；
4. 全局广播 `window.dispatchEvent(new CustomEvent('crish-open-file', { detail: { path: cleanPath, line, col } }))`。

---

### 5.4 外部链接安全拦截与 XSS 防护

在桌面端环境（Tauri WebView2）中，链接必须通过统一门禁过滤：

```typescript
import { isSafeHref, sanitizeUrlCandidate } from './markdownSanitizer';

export async function handleLinkClick(
  linkEl: HTMLAnchorElement,
  e: MouseEvent
): Promise<void> {
  const rawHref = linkEl.getAttribute('href') || '';
  if (!rawHref) return;

  // 1. 页面内锚点导航 (#heading-id)
  if (rawHref.startsWith('#')) {
    e.preventDefault();
    const targetId = decodeURIComponent(rawHref.slice(1));
    const targetEl = document.getElementById(targetId);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }

  // 2. 运行时 XSS 白名单强制校验 (阻止 javascript:, data: 等恶意走私)
  if (!isSafeHref(rawHref)) {
    e.preventDefault();
    console.warn(`[Security] 拦截到不安全外部链接访问尝试: ${rawHref}`);
    return;
  }

  // 3. 外部合法链接 (http, https, mailto)
  e.preventDefault();
  const safeUrl = sanitizeUrlCandidate(rawHref);

  try {
    // 优先调用系统默认浏览器打开 (通过 Tauri opener 插件)
    const opener = await import('@tauri-apps/plugin-opener').catch(() => null);
    if (opener && typeof (opener as any).openUrl === 'function') {
      await (opener as any).openUrl(safeUrl);
      return;
    }
    // 降级至 plugin-shell
    const shell = await import('@tauri-apps/plugin-shell').catch(() => null);
    if (shell && typeof shell.open === 'function') {
      await shell.open(safeUrl);
      return;
    }
  } catch {
    // 浏览器调试降级
    window.open(safeUrl, '_blank', 'noopener,noreferrer');
  }
}
```

---

## 六、 模块详案四：全场景消除“功能伪连通”落地蓝图

### 6.1 交互总线统一接入规范：`useMarkdownInteraction`

为了确保无论是**对话流、文件预览面、技能详情、还是 Agent 时间线**，都能以一行代码接入完整的交互能力，封装轻量标准 Hook：

```typescript
// apps/crish-desktop/src/hooks/useMarkdownInteraction.ts
import { useCallback } from 'react';
import {
  handleCodeCopyClick,
  handlePathLinkClick,
  handleLinkClick,
} from '../api/markdown-render/markdownInteractionDispatcher';

export function useMarkdownInteraction(onOpenPathCustom?: (path: string) => void) {
  const onMarkdownClick = useCallback((e: React.MouseEvent) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    // 1. 命中代码块复制按钮
    const copyBtn = target.closest('.md-code-copy');
    if (copyBtn instanceof HTMLElement) {
      e.preventDefault();
      e.stopPropagation();
      void handleCodeCopyClick(copyBtn);
      return;
    }

    // 2. 命中本地路径胶囊按钮
    const pathBtn = target.closest('.md-path-link');
    if (pathBtn instanceof HTMLElement) {
      e.preventDefault();
      e.stopPropagation();
      handlePathLinkClick(pathBtn, onOpenPathCustom);
      return;
    }

    // 3. 命中普通超链接
    const linkEl = target.closest('a');
    if (linkEl instanceof HTMLAnchorElement) {
      void handleLinkClick(linkEl, e.nativeEvent);
      return;
    }
  }, [onOpenPathCustom]);

  return { onMarkdownClick };
}
```

---

### 6.2 各消费端装配清单

| 消费端文件域 | 现状缺陷 | 接入改造方案 | 收益与断言 |
| :--- | :--- | :--- | :--- |
| `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx` | 注入 `innerHTML` 后无类名样式继承，复制无反馈 | 挂载 `onMarkdownClick`，外层类名绑定全局 `.md-rendered` | 会话流代码复制反馈即时可见，表格排版端正 |
| `apps/crish-desktop/src/components/files/FilePreview.tsx` | 使用幽灵类 `msg-assistant-text`，零事件绑定 | 移除幽灵类，绑定 `onMarkdownClick`，引入全局排版 CSS | 文档阅读面表格彻底恢复，代码一键复制与文件跳转生效 |
| `apps/crish-desktop/src/components/settings-skills/SkillDetailPreview.tsx` | 同样使用幽灵类，表格散乱，复制按钮不可交互 | 移除幽灵类，绑定 `onMarkdownClick` | 技能文档具备完整的 GFM 渲染与全部交互能力 |
| `apps/crish-desktop/src/components/agent-card/InlineAgentTimeline.tsx` | 对话流外部时间线，表格断层 | 统一绑定交互委托与全局 Markdown CSS | 子 Agent 历史产物中的表格与代码无损呈现 |

---

### 6.3 样式真理源收敛架构：`markdown-typography.css`

废弃碎片化定义，在 `apps/crish-desktop/src/styles/markdown-typography.css` 中建立单一真理源，并在 `main.tsx` 或 `index.css` 统一引入。

#### 核心作用域契约
所有规则作用于：
- 显式容器类名 `.md-rendered`；
- 兼容旧容器类名 `.assistantText`。

```css
/* apps/crish-desktop/src/styles/markdown-typography.css */

/* 1. 表格体系 */
.md-rendered .md-table-wrap,
.assistantText :global(.md-table-wrap) {
  /* 外壳盒模型，见第三节完整规则 */
}
.md-rendered .md-table,
.assistantText :global(.md-table) {
  /* 表格本体与单元格规则，见第三节完整规则 */
}

/* 2. 路径微胶囊交互体系 */
.md-rendered .md-path-link,
.assistantText :global(.md-path-link) {
  appearance: none;
  -webkit-appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  font-family: var(--font-mono, monospace);
  font-size: 0.88em;
  line-height: 1.4;
  border-radius: var(--md-path-link-radius, 4px);
  border: 1px solid var(--md-path-link-border, var(--border-subtle));
  background: var(--md-path-link-bg, color-mix(in srgb, var(--text-primary) 4%, transparent));
  color: var(--md-path-link-fg, var(--brand-deep, #059669));
  cursor: pointer;
  user-select: text;
  transition: all var(--transition-fast, 120ms ease);
}
.md-rendered .md-path-link:hover,
.assistantText :global(.md-path-link:hover) {
  background: var(--md-path-link-hover-bg, color-mix(in srgb, var(--brand) 10%, transparent));
  border-color: var(--brand, #10b981);
}
.md-rendered .md-path-link:active,
.assistantText :global(.md-path-link:active) {
  background: var(--md-path-link-active-bg, color-mix(in srgb, var(--brand) 16%, transparent));
}

/* 3. 代码复制按钮体系 */
.md-rendered .md-code-copy,
.assistantText :global(.md-code-copy) {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 2px 8px;
  font-size: 11px;
  line-height: 1.4;
  border-radius: var(--radius-sm, 4px);
  border: 1px solid var(--border-subtle);
  background: var(--md-code-copy-bg, color-mix(in srgb, var(--bg-card) 85%, transparent));
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease, color 120ms ease, background-color 120ms ease;
  z-index: 3;
}
.md-rendered .md-code-block:hover .md-code-copy,
.assistantText :global(.md-code-block:hover .md-code-copy),
.md-rendered .md-code-copy:focus-visible,
.assistantText :global(.md-code-copy:focus-visible) {
  opacity: 1;
}
.md-rendered .md-code-copy.is-copied,
.assistantText :global(.md-code-copy.is-copied) {
  opacity: 1;
  color: var(--brand, #10b981);
  border-color: color-mix(in srgb, var(--brand) 40%, transparent);
  background: color-mix(in srgb, var(--brand) 8%, var(--bg-card));
  font-weight: 500;
}
```

---

## 七、 严谨的逻辑执行顺序（Logical Execution Flow）

根据“纯逻辑规划”铁律，以下任务单元按其**内在逻辑依赖与前置约束**进行因果拓扑排序，问题同权，不包含任何人天与工期估算：

```
[任务单元 1: CSS Token 与排版单一真理源]
  ├─ 建立 `apps/crish-desktop/src/styles/markdown-typography.css`
  ├─ 固化 `.md-table-wrap`、`.md-table`、`.md-th`、`.md-td` 发丝线与容器查询
  └─ 固化 `.md-code-copy.is-copied` 与 `.md-path-link` 交互视觉规范
        │ (样式就绪)
        ▼
[任务单元 2: 交互调度器核心实现]
  ├─ 新建 `apps/crish-desktop/src/api/markdown-render/markdownInteractionDispatcher.ts`
  ├─ 实现 `handleCodeCopyClick`（剪贴板双轨降级 + 1500ms 状态机）
  ├─ 实现 `parsePathAndLocation` 与 `handlePathLinkClick`（行列定位拆解）
  └─ 实现 `handleLinkClick`（运行时 XSS 拦截 + Tauri 系统浏览器拉起）
        │ (逻辑就绪)
        ▼
[任务单元 3: 封装通用 React 交互 Hook]
  └─ 新建 `apps/crish-desktop/src/hooks/useMarkdownInteraction.ts`
        │ (消费端装配就绪)
        ▼
[任务单元 4: 消费端全面装配与幽灵类清除]
  ├─ `FilePreview.tsx`：清除 `msg-assistant-text`，装配 `useMarkdownInteraction`
  ├─ `SkillDetailPreview.tsx`：清除幽灵类，装配 `useMarkdownInteraction`
  ├─ `InlineAgentTimeline.tsx`：挂载交互委托
  └─ `useChatMessageState.ts`：逻辑重构，底层调用交互调度器，清除私有重复代码
        │ (端到端打通)
        ▼
[任务单元 5: StreamingTableContainer 契约对齐与兼容固化]
  └─ 升级 `StreamingTableContainer.module.css` 直接复用 `markdown-typography.css` 变量
        │ (功能完全收敛)
        ▼
[任务单元 6: 立体验证与防护断言回归]
  ├─ 单元测试：`markdownInteractionDispatcher.test.ts`
  ├─ 样式测试：`StreamingTable.test.tsx` 更新断言
  └─ 集成测试：各预览组件点击与排版回归
```

---

## 八、 立体验证契约与自动化测试用例清单

### 8.1 单元测试契约（Unit Tests）

1. **表格语法与类名一致性断言**：
   - 验证 Rust `conex-markdown` 与 JS `markdownTable.ts` 输出一致的 `.md-table-wrap`、`.md-table`、`.md-th`、`.md-td` 结构；
   - 验证空表体、单行表、包含转义管道（`\|`）的复杂表格解析完整性。
2. **剪贴板双轨降级与反馈状态机断言**：
   - Mock `navigator.clipboard.writeText` 成功，断言 `button` 注入 `.is-copied` 类名，文本变为“已复制”；
   - 1500ms 后断言自动恢复为“复制”且移除 `.is-copied`；
   - Mock `navigator.clipboard` 抛出异常，断言顺利触发 `document.execCommand('copy')` 降级通路。
3. **路径与行列定位解析断言**：
   - 输入 `src/test.ts:120:5` -> 解析出 `{ cleanPath: 'src/test.ts', line: 120, col: 5 }`；
   - 输入 `crates/core/lib.rs#L40-L50` -> 解析出 `{ cleanPath: 'crates/core/lib.rs', line: 40 }`；
   - 输入带空格的干净路径 -> 解析出干净路径且 `line` 为 `undefined`。
4. **外部链接安全门禁断言**：
   - 输入 `javascript:alert(1)` 或 `javascript%3A...` -> 断言被拦截，严禁调起系统 opener；
   - 输入 `https://github.com/conex` -> 断言通过校验并调用 `opener.openUrl`。

---

### 8.2 集成测试契约（Integration Tests）

1. **`FilePreview.tsx` 交互现场验证**：
   - 渲染包含 GFM 表格与代码块的真实 Markdown 文本；
   - 断言 DOM 树中正确呈现 `.md-table-wrap` 与 `.md-table`；
   - 模拟点击 `.md-code-copy`，断言剪贴板被写入且按钮展示反馈；
   - 模拟点击 `.md-path-link`，断言触发工作区路径导航事件。
2. **`SkillDetailPreview.tsx` 一致性验证**：
   - 验证技能详情中表格边框折叠、吸顶表头与代码复制功能端到端畅通。

---

### 8.3 视觉与物理盒模型断言（DOM & Layout Invariants）

1. **盒模型防粘连断言**：
   - 单元格计算样式（Computed Style）中断言 `padding` 大于等于 6px；
   - 连续单元格之间的文字距离大于 12px，彻底阻断字符连缀。
2. **Sticky Header 物理断言**：
   - `thead th` 计算样式必须包含 `position: sticky`，且 `z-index >= 2`；
   - `box-shadow` 发丝线在纵向滚动时不发生断裂。
3. **横向滚动容器断言**：
   - `.md-table-wrap` 的 `overflow-x` 属性必须为 `auto`；
   - 表格在窄容器中具备独立水平滚动条，不破坏外层宿主宽度。
