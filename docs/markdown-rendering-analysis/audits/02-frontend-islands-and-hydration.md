# 前端 Islands 架构与交互水合体系深度审计报告

> **审查基准**：基于最近重构提交（`BATCH-MD-PHASE0` 至 `PHASE7`：commit `65c2c4c90`, `bf3d60fa3` 等）的代码事实、架构拓扑与自动化测试套件。严禁空谈概念，拒绝文档宣传口径，以物理代码与运行期交付事实为唯一依据。  
> **审计范围**：前端 Islands 架构与交互水合体系（KaTeX 数学公式 / Mermaid 图表 / 代码块 UX / 悬停提示 / 统一交互委托 / Vite 依赖与打包门禁）。  
> **目标文件**：`docs/markdown-rendering-analysis/audits/02-frontend-islands-and-hydration.md`  

---

## 一、审查概览与架构定性

### 1.1 本次重构的核心变革背景

在 `BATCH-MD-PHASE0` 之前，Conex / Crish 桌面端在 Markdown 交互与富媒体渲染上面临着典型的**「架构分裂与功能失明」**困境：
1. **KaTeX 与 Mermaid 完全失明**：主端生产包未引入任何数学公式与图表引擎，代码块仅能以纯文本或残缺高亮显示；
2. **渲染管线五头分裂**：Rust 原生渲染、TS 正则回退、Worker 线程 `marked`、手写增量分块、表格逐单元格会话并存，产生了超过 14,000 行冗余代码；
3. **交互与排版割裂**：代码块无行号、无行高亮、无折叠；复制功能依赖 `pre.textContent` 直接刮取 DOM，与行号注入形成死结；
4. **流式性能雪崩**：流式打字期间 `isStreaming` 全局广播，导致已封口历史块全量重渲染。

在本次 `PHASE0 ~ PHASE7` 实施波次中，工程团队彻底推翻了旧有的前端 JS 解释器与正则流水线，转向了 **「Rust 单一权威渲染内核产出静态语义 HTML + 前端轻量 Islands 动态注水」** 的全新架构。

### 1.2 总体审计裁决结论

| 评估维度 | 权重 | 评分 (0-5) | 架构定性与核心裁决 |
| :--- | :---: | :---: | :--- |
| **Islands 架构宿主注水** | 25% | **4.3** | **优秀（重大工程突破）**：通过静态插桩 + React Portal 注水，优雅化解了 Rust 纯 HTML 管道下宿主 JS/React 组件挂载难题，封口与流式隔离明确。 |
| **按需加载与打包隔离** | 15% | **4.2** | **良好**：Mermaid 与 KaTeX 均实现 `import()` 动态加载与独立 Chunk 拆分，未污染首屏启动依赖图；但启动门禁存在配置挂空漏洞。 |
| **代码块交互与行号体系** | 20% | **4.4** | **优秀（正向架构跃迁）**：明智否决了早期提案中冗余的 `data-raw-code` 属性复制，改用 CSS Counter + 行级 DOM 结构，彻底解开行号与复制死结。 |
| **生命周期与 DOM 稳定性** | 20% | **3.0** | **存在隐患**：`useLayoutEffect` 命令式 `innerHTML` 与 Portal 容器管理存在一次二次渲染（Double-Render）开销，特定重渲时存在幽灵节点与状态丢失。 |
| **图表与公式容错边界** | 20% | **2.8** | **存在硬伤**：Mermaid 语法错误导致源码双重回显且吞没报错信息；SVG 全局 ID 碰撞隐患未解；`htmlLabels: false` 牺牲了图表富文本与排版。 |
| **综合加权得分** | 100% | **3.77** | **第二梯队中上游（质的飞跃，但留存多处边缘硬伤）** |

---

## 二、改动效果评估（正面突破）

### 2.1 Islands 架构的工程突破：静态插桩与 React Portal 动态注水

#### 架构实现事实
- **插桩端（Rust 内核）**：
  - 数学公式：`crates/conex-markdown/src/renderer/math.rs:12-37` 将行内与块级数学分别输出为带 `data-md-island="math"` 和 `data-tex="..."` 的静态占位容器：
    ```html
    <span class="md-math md-math-inline" data-md-island="math" data-tex="E=mc^2">$E=mc^2$</span>
    <div class="md-math md-math-block" data-md-island="math" data-tex="x^2">$$x^2$$</div>
    ```
  - 图表：`crates/conex-markdown/src/renderer/code.rs:157-234` 当检测到 `lang == "mermaid"` 时，外层包裹 `data-md-island="mermaid"`，并在 `<pre>` 源码区下方开辟 `<div class="md-island-slot" data-island-slot="mermaid"></div>` 独立槽位。
- **水合端（React 宿主）**：
  - `apps/crish-desktop/src/components/markdown/MarkdownSurface.tsx:109-159` 在 `useLayoutEffect` 中，先由宿主安全写入 `root.innerHTML = html`，随后执行 `enhance(root)` 进行本地化注入；
  - 若 `!isActive`（非流式活跃尾块），利用 `root.querySelectorAll` 精确抓取 `[data-md-island="math"]` 与 `[data-island-slot="mermaid"]`；
  - 核心防崩设计：在把宿主 DOM 节点交给 React Portal 之前，先执行 `element.textContent = ''` 清除 Rust 占位文本，避免 Portal 挂载后 React 内部 Fiber 树与原生文本节点产生 reconciliation 冲突（此问题在真桌面现场排查中被抓出并修复）；
  - `IslandPortal.tsx:17-31` 通过 `createPortal(<Component source={...} />, target)` 实现无头跨层挂载，生命周期严格绑定当前块。

#### 收益评估
成功打破了传统富文本系统「要么全量走 React 渲染器导致流式卡顿，要么纯走 Rust 原生 HTML 导致动态图表与公式无法交互」的二元困境。Rust 负责百倍性能的词法排版与 AST 构建，前端仅作为超薄的「注水胶水层」，实现了职责维度的单一真理源（SSOT）。

---

### 2.2 按需动态加载（Lazy Import）与打包体积物理隔离

#### 依赖隔离事实
1. **运行时动态加载**：
   - KaTeX：`apps/crish-desktop/src/components/markdown/islands/MathIsland.tsx:13-24` 通过 `loadKatex()` 延迟执行 `Promise.all([import('katex'), import('katex/dist/katex.min.css')])`；
   - Mermaid：`apps/crish-desktop/src/components/markdown/islands/MermaidIsland.tsx:22-32` 通过 `loadMermaid()` 延迟执行 `import('mermaid')`；
   - 静态注册表解耦：`apps/crish-desktop/src/components/markdown/islands/registry.tsx:36-51` 仅静态引用薄包装壳 `MathIsland` 与 `MermaidIsland`（单文件仅数十行），核心大体积第三方引擎（`mermaid` 与 `katex`）完全移出主应用静态依赖图。
2. **Vite 打包层 Chunk 拓扑隔离**：
   - 在 `apps/crish-desktop/vite.config.ts:630-644` 中配置了专门针对 Mermaid 依赖家族的 `manualChunks` 收敛规则：
     ```ts
     if (
       n.includes('/node_modules/mermaid/') ||
       n.includes('/node_modules/@mermaid-js/') ||
       n.includes('/node_modules/cytoscape/') ||
       n.includes('/node_modules/dagre') ||
       n.includes('/node_modules/d3/') ||
       n.includes('/node_modules/d3-') ||
       n.includes('/node_modules/khroma/') ||
       n.includes('/node_modules/elkjs/')
     ) {
       return 'vendor-mermaid';
     }
     ```
   - 门禁白名单收敛：`vite.config.ts:48-68` 将 `vendor-mermaid`、`mermaid.core` 和 `cynefin` 显式登记至 `LAZY_CHUNK_SIZE_LIMITS_KB`，赋予 4096KB 的懒加载特许上限，其余所有生产 Chunk 继续受 600KB 严格硬门禁拦截。

#### 收益评估
Mermaid 及庞大的图形算法拓扑库（d3、cytoscape、dagre、elkjs 等共计约 3.8MB 编译产物）以及 KaTeX 引擎，在用户不浏览公式与图表时，首屏网络传输量与 JS 堆内存开销为严格的 **0 字节**。

---

### 2.3 代码块交互重构：超越 `data-raw-code` 的正向演进

#### 架构纠偏与方案对比
早期分析报告（`analysis/04-typography-and-visual-fidelity.md:520`）曾建议：*“在 DOM 属性上注入 `data-raw-code` 作为单一真理源”*。然而实施团队在 `01-系统性整改行动方案.md` §1.3 (项 39) 做出重要技术裁决，**明智否定了 `data-raw-code` 方案**，原因如下：
- 若将长达数千行的代码再次以 HTML 属性形式序列化到 `data-raw-code="..."` 中，会导致 HTML 体积与 IPC 传输带宽直接膨胀 2 至 3 倍，并在 WebView 内存中造成双重字符串驻留。

#### 实际交付的更优解（CSS Counter + 行级 DOM）
1. **纯净行号生成**：
   - Rust 输出结构（`crates/conex-markdown/src/renderer/code.rs:212-227`）：
     `<span class="md-code-line" data-line="1">...code...</span>`
   - 样式层通过 CSS 计数器注入（`apps/crish-desktop/src/styles/markdown-typography.css:806-829`）：
     ```css
     .md-code-block { counter-reset: md-code-line; }
     .md-code-line::before {
       counter-increment: md-code-line;
       content: counter(md-code-line);
       user-select: none;
       pointer-events: none;
     }
     ```
   - **核心突破**：CSS 伪元素 `::before` 绝对不会进入 DOM 的选择选区与 `textContent`。用户用鼠标手动选中文本、或者使用全选复制时，拷贝的内容天然不包含行号。
2. **复制逻辑收敛**：
   - `apps/crish-desktop/src/components/markdown/markdownInteractions.ts:157-171`：
     ```ts
     const lineElements = Array.from(block.querySelectorAll<HTMLElement>('.md-code-line'));
     const text = lineElements.length
       ? lineElements.map((line) => line.textContent ?? '').join('\n')
       : (block.querySelector('pre')?.textContent ?? '');
     ```
   - 复制按钮通过提取所有 `.md-code-line` 的纯净 `textContent` 并以换行符拼接，彻底解开了历史代码中“加了行号 DOM 就破坏复制功能”的死结。
3. **行高亮与代码折叠**：
   - 行高亮：Rust 解析围栏参数如 `{1,3-5}`，精确输出 `md-code-line-highlight`，前端结合 `color-mix` 语义调色；
   - 折叠收起：Rust 检测超过 30 行时自动注入 `data-collapsible="true"` 与折叠按钮，CSS 配合渐变遮罩（`markdown-typography.css:853-864`）实现优雅的 24em 折叠限高。

---

### 2.4 流式与封口态的物理隔离：消除打字机重渲染雪崩

#### 运行机制
- `apps/crish-desktop/src/components/chat-message-row/StreamingMarkdownView.tsx:59-71`：
  - 仅将 `isStreaming=true` 传递给处于末尾且尚未封口的活跃块：`blockIsStreaming = isStreaming && isLast && !block.isSealed`；
  - 前序所有已封口历史块的 `MarkdownBlockItem` props 保持严格浅等（`markdownBlockItemPropsEqual` 守卫生效），不再响应每帧打字广播；
- `MarkdownBlockItem.tsx:43-45`：
  - 活跃块（`isActiveTail=true`）走 `useStreamingMarkdownResult`（Rust 轻量流式渲染，跳过繁重的高亮着色与 Island 注水）；
  - 封口瞬间（`isActiveTail` 变为 `false`），利用 `html = staticResult.html || streamResult.html` 平滑垫底，彻底消除静态批处理 IPC 到达前的白屏闪烁；
  - `MarkdownSurface.tsx:119-156` 在 `isActive=true` 期间跳过 Math 和 Mermaid 注水，只有在块封口后才一次性激活 Portal，杜绝了流式期间高频实例化 KaTeX/Mermaid 导致的 CPU 暴走。

---

### 2.5 交互与安全边界收敛

- **统一事件委托**：`apps/crish-desktop/src/components/markdown/markdownInteractions.ts:32-126` 将代码复制、代码折行、代码折叠、本地路径跳转（`md-path-link`）、外链拦截（`isExternalNavigableHref`）、页内锚点平滑滚动（`scrollToAnchor`）全部收拢至单一顶层 Handler。
- **本地可执行路径刚性拦截**：所有本地路径在派发 `onOpenPath` 前，必须通过 `isBlockedExecutablePath` 校验（`markdownInteractions.ts:73-76`），任何 `.exe/.bat/.cmd/.sh/.ps1` 均被刚性阻断并弹出告警，防止 LLM 生成恶意路径诱导用户点击执行。
- **外链逃逸安全**：普通网页超链接统一调用系统级 Rust 命令 `workbench_open_external_url` 交由系统默认浏览器打开，前端彻底废弃直接 `window.open`，杜绝 WebView 内部页面被劫持或提权风险。
- **合规悬停提示**：全面遵守 `AGENTS.md` §12 铁律，彻底废除原生 HTML `title`，代码块按钮统一通过 CSS 伪元素 `[data-tooltip]:hover::after` 配合 `enhance()` 动态注入本地化文本（`MarkdownSurface.tsx:81-90`）。

---

## 三、关键缺陷与深层隐患穿透审计（重点挖掘）

尽管上述正面改动成效显著，但在严苛的代码级推演与极端边界测试下，当前前端水合体系仍暴露出一系列**设计妥协、潜在崩溃与视觉硬伤**。

---

### 3.1 IslandPortal 生命周期与 DOM 同步风险

#### 缺陷 1：`MarkdownSurface` 强制触发二次布局与渲染（Double-Render）
- **代码位置**：`apps/crish-desktop/src/components/markdown/MarkdownSurface.tsx:109-159`
- **机理分析**：
  ```ts
  useLayoutEffect(() => {
    root.innerHTML = html;
    enhance(root);
    const next: IslandDescriptor[] = [];
    // ... 遍历 DOM 构建 next 数组 ...
    setIslands((prev) => (sameIslands(prev, next) ? prev : next));
  }, [html, isActive, enhance, as]);
  ```
  在 React 18 的运行机制中，`useLayoutEffect` 在 DOM 提交后、浏览器 Paint 之前同步执行。
  当 `root.innerHTML = html` 重新解析字符串构建 DOM 树后，新生成的 `target` DOM 对象引用与前一次完全不同（`item.target === other.target` 必然为 `false`）。
  这导致 `setIslands(next)` 必然触发一次状态更新。在 `useLayoutEffect` 内部触发 `setState` 会强制 React **立即中断当前渲染管线，并在 Paint 前同步触发第二轮完整的组件渲染与 Layout 运算**。
- **影响**：
  只要 Markdown 块内包含公式或 Mermaid 图表，每一次 `html` 变化或 `isActive` 状态转换，组件都会固定发生 **2 次连续渲染**。当处于包含大量公式的长文档窗口滚动或快速消息切换时，主线程面临双倍的 JS 调度压力。

#### 缺陷 2：语言切换等副作用导致 DOM 树整树重建与瞬态丢失
- **代码位置**：`apps/crish-desktop/src/components/markdown/MarkdownSurface.tsx:106-109`
- **机理分析**：
  `enhance` 依赖 `t`（`[t]`），而 `useLayoutEffect` 又依赖 `[html, isActive, enhance, as]`。
  当用户在设置中切换语言时，`t` 函数发生变化，直接驱动 `useLayoutEffect` 重新执行。
  然而，该 Effect 内部直接使用了非幂等的命令式赋值：
  `root.innerHTML = html;`
  这不仅更新了 i18n 属性，而是**将整个 Markdown 根节点的 DOM 树完全推倒重来**！
- **影响**：
  1. 用户在代码块上手动展开/收起的折叠状态（`md-code-collapsed`）、折行状态（`md-code-wrapped`）全部被粗暴重置；
  2. 已经渲染好的 KaTeX / Mermaid 容器被彻底销毁并触发重新 Portal 注水，界面产生肉眼可见的闪烁。

#### 缺陷 3：公式列表增删引发的 Key 漂移与状态错位
- **代码位置**：`apps/crish-desktop/src/components/markdown/MarkdownSurface.tsx:129, 149`
- **机理分析**：
  ```ts
  key: `math-${index}-${hash16(source)}`
  key: `mermaid-${index}-${hash16(source)}`
  ```
  Islands 的 Key 强行绑定了 DOM 遍历的顺序索引 `index`。如果用户正在编辑文档，或者流式动态补齐在文档前半部分插入了一个新的公式，后续所有公式的 `index` 都会集体自增 1。
- **影响**：
  React Diff 算法会认为后续所有公式节点的 Key 均已失效，进而对所有下游 Portal 容器执行全量 Unmount / Remount，造成非必要的性能损耗，并丢失局部组件的异步 Promise 取消标记。

---

### 3.2 Mermaid 容错、并发与 SVG ID 碰撞陷阱

#### 缺陷 4：Mermaid 语法错误引发「源码双重回显」视觉灾难且吞没错误诊断
- **代码位置**：
  - `apps/crish-desktop/src/components/markdown/islands/MermaidIsland.tsx:93-111`
  - `apps/crish-desktop/src/styles/markdown-typography.css:866-871, 910-916`
- **机理分析**：
  1. 当用户输入非法 Mermaid 语法时，`mermaid.render()` 抛出异常；
  2. `MermaidIsland` 的 catch 块执行：
     ```ts
     .catch(() => {
       if (!cancelled) {
         setSvg(null);
         setFailed(true);
       }
     });
     ```
     **致命盲区一**：catch 没有接收 error 参数，错误信息（包含具体语法报错行号、Token 位置）被完全吞没丢弃！
     **致命盲区二**：此时 `host.dataset.mermaidState` 被置为 `'error'`。然而查看样式表（`markdown-typography.css:868`）：
     ```css
     .md-code-block[data-md-island='mermaid'][data-mermaid-state='ready'] .md-code-pre {
       display: none;
     }
     ```
     样式表中**仅在状态为 `'ready'` 时才会隐藏 `<pre class="md-code-pre">`**！当状态为 `'error'` 时，原始带有行号的代码块依然完全可见！
     同时，`MermaidIsland` 自身又返回了：
     ```tsx
     <pre className="md-mermaid-error" data-mermaid-failed="true">
       {source}
     </pre>
     ```
- **真实表现**：
  在语法报错时，界面上会**将完全一模一样的 Mermaid 源码连续渲染两遍**——上层是带语法高亮和操作栏的原始代码块，下层是标红的 `.md-mermaid-error` 纯文本框，且没有任何报错信息告知用户错在哪里，体验极度崩塌。

#### 缺陷 5：Mermaid 全局单例并发初始化竞态（Global Singleton Race）
- **代码位置**：`apps/crish-desktop/src/components/markdown/islands/MermaidIsland.tsx:69-78`
- **机理分析**：
  ```ts
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'dark' ? 'dark' : 'default',
    fontFamily: 'inherit',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  });
  ```
  `mermaid.initialize` 并非针对单次渲染的局部配置，而是直接修改 Mermaid 运行时单例的**全局状态**。
  若页面中存在多个图表并行渲染（例如批量打开文档 chunk、或者快速流式返回包含多个图表的长文本），每个 `MermaidIsland` 在各自微任务队列中都会并发调用 `mermaid.initialize`。
- **影响**：
  一旦未来扩展中不同图表需要不同配置（如特定图表需要不同的主题覆盖、方向定义或布局算法），并发调用将直接造成全局配置覆盖与竞态撕裂。

#### 缺陷 6：缓存 SVG 跨组件复用导致的 SVG 内部 ID 碰撞（Arrowhead 箭头丢失/错位）
- **代码位置**：`apps/crish-desktop/src/components/markdown/islands/MermaidIsland.tsx:58-64, 79-90`
- **机理分析**：
  - `MermaidIsland` 使用了基于文本的缓存机制：`key = ${theme}\u0000${source}`。
  - 当命中缓存时，直接读取已清洗的 SVG 字符串并写入 DOM：`setSvg(cached)`。
  - 然而，Mermaid 在渲染 SVG 时，内部的箭头标记（Markers）、渐变（Gradients）、剪裁路径（ClipPath）等元素均带有 `id` 属性，例如：
    `<defs><marker id="flowchart-pointEnd" ...></marker></defs>`，
    路径连线通过属性 `marker-end="url(#flowchart-pointEnd)"` 引用定义。
- **影响**：
  如果在同一个页面（同一 WebView Document）中出现两个内容相同的 Mermaid 图表（例如不同消息中引用了同一个架构图，或者用户分段对比）：
  1. 两个图表的 SVG 内部包含**完全相同**的全局 DOM `id`；
  2. 按照 W3C SVG 规范，`url(#flowchart-pointEnd)` 永远只会解析到整个 HTML 文档中**第一个出现的该 ID 节点**；
  3. 当第一个图表因视口滚动、消息删除或折叠而从 DOM 中卸载时，第二个图表内的所有箭头连线、标记点将瞬间失去引用源，导致**连线箭头完全消失、或者图形着色错乱**！

---

### 3.3 DOMPurify 与 Mermaid SVG 冲突的妥协代价

#### 缺陷 7：`htmlLabels: false` 规避清洗带来的破坏性副作用
- **代码位置**：`apps/crish-desktop/src/components/markdown/islands/MermaidIsland.tsx:74-77`
- **机理分析**：
  Mermaid 官方默认使用 HTML 标签渲染节点文本（外层使用 `<foreignObject>` 包含普通 `div/span`），这样可以在节点内部支持富文本加粗、斜体、代码片段及自动换行。
  但因为当前实现中叠加了 `DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })`：
  - DOMPurify 的 SVG Profile 将 `<foreignObject>` 内部的所有 HTML 元素直接视为不可信内容并彻底清洗剔除，导致节点文本变成完全空白；
  - 团队为了绕过此问题，在配置中强行注入了 `htmlLabels: false` 和 `flowchart: { htmlLabels: false }`，迫使 Mermaid 回退至纯 SVG `<text>` 节点。
- **妥协代价**：
  1. **Markdown 富文本支持彻底失效**：在 Mermaid 节点中写 `A["**加粗服务**"]` 或 `B["`code`"]` 无法解析，加粗与代码标记原样以星号/反引号文本形式显示；
  2. **换行硬伤**：节点文本中的 `<br/>` 换行标签不再作为 HTML 换行解析，而是直接显示为字面量 `"<br/>"` 文本，或者引发文字重叠；
  3. **非 Flowchart 图表的清洗风险**：`htmlLabels: false` 在配置中仅对流程图做显式兜底（`flowchart: { htmlLabels: false }`）。对于 `sequenceDiagram`（时序图）、`classDiagram`（类图）、`mindmap`（思维导图）等图表，若内部依然输出了 HTML 元素，仍会遭遇 DOMPurify 的清洗拦截，导致局部节点文字消失。

---

### 3.4 KaTeX 渲染边界体验与性能瓶颈

#### 缺陷 8：`text-align: center` 导致的超宽公式/大型矩阵左侧截断（Scroll Clipping）
- **代码位置**：`apps/crish-desktop/src/styles/markdown-typography.css:926-935`
- **机理分析**：
  ```css
  :is(.conex-markdown, .md-rendered) .md-math-block {
    display: block;
    margin: 0 0 var(--md-flow-space);
    padding: 0.55em 0.8em;
    overflow-x: auto;
    border: 1px solid var(--md-math-border);
    border-radius: var(--radius-m);
    background: var(--md-math-bg);
    text-align: center;
  }
  ```
- **影响**：
  在 CSS 规范中，当一个容器设置了 `overflow-x: auto` 同时设置了 `text-align: center` 时，若公式内容（如 8×8 复杂矩阵、超长多项式推导、`aligned` 多行公式）的实际渲染宽度超出视口宽度：
  - 内容会以容器中心为基准向两侧溢出；
  - 溢出到容器左侧边界之外的部分，其水平坐标处于负坐标系；
  - **浏览器的水平滚动条只允许向正方向（右侧）滚动，无法向左滚动到负坐标**！
  - 导致超长公式与矩阵的**最左侧列、起始符号被永久性截断**，用户即便把滚动条拉到最左端也无法看清公式开头。

#### 缺陷 9：公式缓存淘汰策略倒退为 FIFO 队列（并非真正 LRU）
- **代码位置**：`apps/crish-desktop/src/components/markdown/islands/MathIsland.tsx:26-27, 68-72`
- **机理分析**：
  ```ts
  const renderCache = new Map<string, string>();
  const RENDER_CACHE_MAX = 256;
  // ...
  if (renderCache.size >= RENDER_CACHE_MAX) {
    const firstKey = renderCache.keys().next().value;
    if (firstKey !== undefined) renderCache.delete(firstKey);
  }
  renderCache.set(key, rendered);
  ```
  在 `renderCache.get(key)` 命中缓存时，代码直接返回了结果，**并没有执行 `delete` + `set` 以刷新该 Key 在 Map 迭代器中的末尾位置**。
- **影响**：
  该缓存本质上退化成了最简陋的 **FIFO（先进先出）队列**而非 LRU。在包含数百个公式的专业技术文档或论文中，文档开头的核心公式会随着后文公式的解析被无情淘汰；当用户向上回滚阅读时，顶部公式将不得不频繁重新触发字符串解析。

#### 缺陷 10：CSS 异步加载引发的 FOUT（无样式内容闪烁）
- **代码位置**：`apps/crish-desktop/src/components/markdown/islands/MathIsland.tsx:15-18`
- **机理分析**：
  `katex.min.css` 与 KaTeX 核心代码在 `loadKatex()` 中一起动态加载。当首个公式完成注水瞬间，KaTeX 专用 Web Fonts（`KaTeX_Math`, `KaTeX_Main` 等）才开始向本地或远端发起字体请求。
- **影响**：
  在首次渲染公式的数百毫秒内，公式会先以系统默认等宽字体或衬线字体破碎排版，待字体与 CSS 完全应用后突然发生几何形变与尺寸跳跃（Cumulative Layout Shift），产生强烈的视觉顿挫感。

---

### 3.5 门禁治理盲区：Mermaid 在启动门禁中配置挂空

#### 缺陷 11：`check-startup-budget.mjs` 中的静态图 Deny 拦截名单未实际落地
- **代码事实**：
  - 方案设计承诺（`01-系统性整改行动方案.md:378`）：
    *“Mermaid 需在 Vite chunk 门禁中登记为「懒加载例外」，并加入 startup static-graph deny 名单。”*
  - 物理代码核查：
    查看启动预算门禁脚本 `scripts/check-startup-budget.mjs:67`：
    ```javascript
    const DEFAULT_STATIC_GRAPH_DENY = [];
    ```
- **机理与隐患**：
  脚本内的缺省 deny 拦截名单**完全为空**！
  虽然 `vite.config.ts` 的打包层对 chunk 体积做出了限制，但 `check-startup-budget.mjs` 这一专门用于阻断启动静态依赖图（Entry Static Graph）反向污染的自动化 CI 门禁，根本没有将 `vendor-mermaid` 写入默认黑名单。
  如果后续其他开发者在业务代码（例如某个不经意的 Toolbar 或导出模块）中写了一句静态的 `import mermaid from 'mermaid'`，CI 流水线的 `check-startup-budget` 根本不会报警，庞大的 Mermaid 及其 3.8MB 依赖包将毫无阻拦地被重新打入首屏启动图！

---

## 四、具体代码缺陷清单与位置索引

| 编号 | 缺陷分类 | 文件位置与行号 | 缺陷性质 | 严重度 | 现场触发条件 / 表现 |
| :---: | :--- | :--- | :--- | :---: | :--- |
| **D-01** | 水合生命周期 | `apps/crish-desktop/src/components/markdown/MarkdownSurface.tsx:109-159` | 强制双重渲染 (Double-Render) | 中 | 任意包含公式/图表的块初次加载或封口时，同步触发两次 React 布局与渲染周期 |
| **D-02** | 水合生命周期 | `apps/crish-desktop/src/components/markdown/MarkdownSurface.tsx:115` | DOM 状态丢失与整树重建 | 中 | 切换语言环境（`t` 变化）时，重置所有代码块的手动折叠/折行状态并引发闪烁 |
| **D-03** | 错误降级表现 | `apps/crish-desktop/src/components/markdown/islands/MermaidIsland.tsx:93-111`<br>`apps/crish-desktop/src/styles/markdown-typography.css:868` | 语法错误源码双重回显，报错被吞 | 高 | Mermaid 语法错误时，代码块源码与标红错误源码同时显示两遍，且无报错诊断 |
| **D-04** | 图表并发冲突 | `apps/crish-desktop/src/components/markdown/islands/MermaidIsland.tsx:69-78` | 全局单例配置竞态 | 低 | 多个图表同时并发渲染时，并发覆盖全局 `mermaid.initialize` 配置 |
| **D-05** | 图表渲染边界 | `apps/crish-desktop/src/components/markdown/islands/MermaidIsland.tsx:58-90` | SVG 内部全局 ID 碰撞 | 高 | 页面出现多个相同图表时，首个图表卸载会导致其余图表的箭头 Marker 完全消失 |
| **D-06** | 安全清洗冲突 | `apps/crish-desktop/src/components/markdown/islands/MermaidIsland.tsx:74-77` | 富文本与非 Flowchart 图表清洗失效 | 中 | Mermaid 节点内无法使用加粗/行内代码，时序图/类图可能被 DOMPurify 误杀文字 |
| **D-07** | 排版与视口 | `apps/crish-desktop/src/styles/markdown-typography.css:930-934` | 居中超宽公式左侧永久截断 | 高 | 大型矩阵或超长推导公式水平溢出时，无法滚动回左侧起始区域 |
| **D-08** | 缓存数据结构 | `apps/crish-desktop/src/components/markdown/islands/MathIsland.tsx:26-72` | 伪 LRU（实为 FIFO）淘汰 | 低 | 超过 256 个公式的长文档反复回滚时，顶部高频公式遭遇无差别淘汰 |
| **D-09** | 样式与加载 | `apps/crish-desktop/src/components/markdown/islands/MathIsland.tsx:15-18` | FOUT 字体样式跳变 | 低 | 首次渲染数学公式时发生几何形变与尺寸抖动 |
| **D-10** | 交互防抖状态 | `apps/crish-desktop/src/components/markdown/markdownInteractions.ts:184-190` | 复制按钮状态重置竞态 | 低 | 1.5 秒内高频连点两次复制代码块，前一个计时器提前清除第二次的成功反馈 |
| **D-11** | CI 门禁治理 | `scripts/check-startup-budget.mjs:67` | 静态图 Deny 门禁悬空 | 中 | 启动门禁未默认包含 `vendor-mermaid`，静态依赖泄露无法被 CI 自动阻断 |

---

## 五、架构整改与演进建议

为保证架构持续演进，杜绝修补式“打补丁”，针对上述缺陷提出以下系统性修复建议：

### 5.1 解耦 `MarkdownSurface` 的 i18n 属性注入与 innerHTML
- **建议方案**：
  将 `root.innerHTML = html` 与 `enhance(root)` 彻底解耦。
  - 使用 `useRef` 记录上一次成功写入的 `lastHtmlRef.current`；
  - 只有当 `html !== lastHtmlRef.current` 时，才执行 `root.innerHTML = html` 与 Island 扫描；
  - 语言 `t` 变化时，仅单独调用 `enhance(root)` 遍历修改 `data-tooltip` 与文本内容，绝不重新覆写 `innerHTML`，从而持久保留代码块的折叠、折行与 Portal 挂载状态。

### 5.2 根治 Mermaid 语法错误展示与状态同步
- **建议方案**：
  1. 修复样式选择器：当 `[data-mermaid-state='error']` 时，同样隐藏原始 `<pre class="md-code-pre">`；
  2. 捕获真实错误对象：将 `catch((err: Error) => ...)` 中的错误消息暂存到 `errorMsg` 状态中；
  3. 错误卡片呈现：在 `.md-mermaid-error` 内部，上方渲染红色的错误原因提示（如 `Parse error on line 3: ...`），下方以只读代码块形式附带错误源码，杜绝双份代码无意义重叠。

### 5.3 解决 SVG ID 命名空间碰撞（Namespacing）
- **建议方案**：
  不要直接将 Mermaid 输出的全局 ID 存入缓存。在写入缓存或注入 DOM 前，通过正则或 DOM 解析器，对 SVG 内的所有 `id="([^"]+)"` 注入唯一图表实例前缀（如 `id="diagA_flowchart-pointEnd"`），并同步替换所有的 `url(#$1)` 与 `href="#$1"`，确保每个 SVG 的定义域严格自封闭。

### 5.4 修复超宽数学公式的居中与滚动安全
- **建议方案**：
  修改 `markdown-typography.css:934`：
  移除 `.md-math-block` 上的 `text-align: center;`，将其改为基于 Flexbox 或块级内边距的现代安全居中布局：
  ```css
  .md-math-block {
    display: flex;
    justify-content: safe center;
    overflow-x: auto;
  }
  ```
  利用现代 CSS 标准中的 `safe center` 关键字——当内容不溢出时保持居中，一旦内容溢出视口自动对齐到 `start`，从而确保水平滚动条能够完整遍历左侧与右侧全部内容。

### 5.5 补死启动门禁缺口
- **建议方案**：
  在 `scripts/check-startup-budget.mjs:67` 中将 `vendor-mermaid` 正式写入 `DEFAULT_STATIC_GRAPH_DENY`，将方案承诺正式固化为 CI 机器检验项：
  ```javascript
  const DEFAULT_STATIC_GRAPH_DENY = ['vendor-mermaid'];
  ```
