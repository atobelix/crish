# 12-Webview 运行时审查报告：CSS 合成、滚动层与 Worker 利用

> **战役**：全面性能审查（performance-audit），方向 12 / 共 16 方向  
> **总纲**：`docs/performance-audit/00-性能审查总纲.md`  
> **日期**：2026-09-12  
> **检查对象**：`apps/crish-desktop/src/` 全部 CSS（151 文件 / ~955 KiB）、滚动容器（chat / sidebar / diff / terminal / table）、`src/workers/` 全量、rIC/rAF 调度面、DOM 几何读写交错（与 01 M1 交叉补 CSS 侧）、字体加载与合成动画  
> **方法**：全仓静态扫描（will-change / contain / backdrop-filter / box-shadow / animation / overflow）+ Worker 池与消费面走读 + 滚动锚点 / 虚拟化 Geometry 读写走读；运行时未实测项在 §8 单列，不冒充已验证结论。  
> **素材**：`materials/12-CSS合成与动画热点.md`、`materials/12-Worker调度与DOM读写.md`  
> **交叉**：01（流式重渲染）、02（xterm/tiptap 重型组件）、07（启动体积与字体）

---

## 0. 阅读指南

- 每条问题按统一模板：**位置 → 现象 → 代码现场 → 调用链与触发时机 → 根因 → 影响量化 → 修复方案 → 回归风险与测试锚点**。  
- 严重度：  
  - **高**：流式/滚动热路径或大列表/大 Diff 场景下用户可感知掉帧、合成层膨胀或主线程阻塞；  
  - **中**：固定场景可测额外开销，规模化后恶化，或持续 GPU/布局税；  
  - **低**：局部小开销或潜在隐患，记录防回潮。  
- 正面发现（§4）禁止回潮；运行时验证（§8）与修复路线图（§7）分离。

---

## 1. 执行摘要

**一句话结论：Webview 运行时「策略层」明显优于平均水平——聊天唯一滚动容器、行级 `contain: layout paint`、禁止 cv-auto、冷启零 Worker + Rust-first markdown、Gesture Epoch 冻结几何都真实存在；但流式热路径上的「逐词 will-change 合成层膨胀」、Diff 大文件「主线程同步 highlight.js 而 worker 高亮通道空转」、以及多处布局属性动画 / 常驻 backdrop-filter 构成运行时三大税源。**

- **健康面**：CSS 合成隔离（contain / 唯一滚动容器 / overflow-anchor:none）与 Worker 生命周期（lazyInit + FCP 门闩 + 15s 闲置回收）架构正确；系统字体栈零 webfont 阻塞；`StaggeredIdleQueue` 质量高且正确用于启动分片。  
- **退化面**：① 流式单词动画对每个 span 常驻 `will-change: opacity, transform`，长输出高 TPS 时合成层与 GPU 内存线性膨胀；② Diff / WidgetDiff / ToolCallDiffPreview 全走主线程同步 `highlightCode`，而 `render-worker` 的 `highlight.batch` / `highlight.stream` 生产零消费；③ Toast/Tabs/Sidebar/表格脉冲等布局或 paint-only 属性动画持续制造主线程 layout/paint。  
- **发现计数**：**3 高（W1 / D1 / T1）· 8 中 · 8 低**，另 9 项正面发现。  
- **修复性价比最高**：W1（流式 animate span 的 will-change 生命周期收敛）+ D1（Diff 高亮改 worker batch / 一次预计算）——改动局部、直击长会话与大 diff 的运行时卡顿。

### 1.1 发现索引

| ID | 严重度 | 标题 | 域 |
| -- | ------ | ---- | -- |
| W1 | 高 | 流式逐词 will-change 合成层膨胀 | 合成 |
| D1 | 高 | Diff 路径主线程同步 hljs，worker 高亮通道空转 | Worker |
| T1 | 高 | 表格流式无限脉冲动画绑定 outline/box-shadow/background | 动画 |
| W2 | 中 | 侧栏会话行常驻 will-change: transform | 合成 |
| W3 | 中 | 布局属性 will-change 反模式群（Toast/Tabs/Switch/PaneHeader/Tree） | 合成 |
| B1 | 中 | ChatComposer 常驻 backdrop-filter 与消息滚动同屏 | GPU |
| A1 | 中 | Toast 卡 height 过渡 + will-change height | 布局动画 |
| A2 | 中 | Tabs 指示器 width/height 弹簧动画非合成友好 | 布局动画 |
| S1 | 中 | FlowScrubber top 过渡与主滚动几何双重布局 | 滚动 |
| S2 | 中 | Diff 多层嵌套滚动容器 + sticky 表头叠加 | 滚动 |
| G1 | 低 | scrubber / 锚点路径几何读写交错（补 01 M1） | DOM 读写 |
| B2 | 低 | Dialog backdrop blur(16–20px)+saturate 峰值成本 | GPU |
| B3 | 低 | box-shadow 面量 389 处与 hover transition 叠加 | 绘制 |
| A3 | 低 | Sidebar 宽度 spring 过渡触发整栏 reflow | 布局动画 |
| A4 | 低 | Diff max-height 过渡强制内容重排 | 布局动画 |
| C1 | 低 | 全局几乎禁用 content-visibility（策略记录） | 策略 |
| F1 | 低 | rIC 仅覆盖启动，运行期空闲分片未复用 | 调度 |
| H1 | 低 | 流式光标无限 opacity 动画（eco 已降级） | 动画 |

---

## 2. 检查范围与方法

### 2.1 覆盖面

| # | 对象 | 动作 |
| - | ---- | ---- |
| 1 | `src/**/*.css` 151 文件 | will-change / contain / content-visibility / backdrop-filter / box-shadow / animation / 布局属性 transition 全量 rg + 重点文件走读 |
| 2 | 滚动容器 | ChatMessageList / SidebarSessionList / DiffCard 多 scroller / TerminalCard / StreamingTableContainer / NotePaper / narrative |
| 3 | `src/workers/` | 全部 8 个生产文件 + 消费面 `markdownRenderAsync` / Diff* / codeHighlight |
| 4 | 调度 | requestIdleCallback / rAF / ResizeObserver / MutationObserver 消费面 |
| 5 | DOM 读写 | getBoundingClientRect / scrollHeight / offset* 在滚动、composer、pane 拖拽路径（与 01 交叉） |
| 6 | 字体 | @font-face / woff / document.fonts / tokens 字体栈 |

### 2.2 与其它方向的边界

- **01**：store 订阅与每帧派生计算（H1/H2）；本向补「这些帧写入 DOM 后」的 CSS 合成成本。  
- **02**：xterm WebGL 存活 / tiptap 挂载；本向不重复终端上下文问题，只审 CSS 滚动与合成。  
- **07**：字体与首屏资产；本向确认零 webfont，不重复 catalog 体积。

---

## 3. 运行时链路速览（CSS / Worker 视角）

### 3.1 流式帧的 CSS 成本链

```text
token → StreamRenderBuffer(rAF) → streamingStore
  → useStreamingBlocks / MarkdownBlockItem
  → 活跃尾块：span + [data-conex-animate="true"]
       → streaming-animation.css: will-change: opacity,transform + animation conex-fade-in
  → 封口：Rust md_render → innerHTML
  → 表格活跃格：md-table-pulse 1.6s infinite（outline/box-shadow/background）
```

### 3.2 Diff 打开成本链

```text
FileDiff 渲染项 → DiffCardUnifiedView/SplitView/WidgetDiff
  → 每行 renderTokens → highlightCode（主线程 hljs，cache ≤500 字符）
  → dangerouslySetInnerHTML
  → 多层 overflow-y:auto 容器 + sticky thead（CSS）
未走：render-worker highlight.batch / core_highlight（Rust）
```

### 3.3 Worker 生命周期

```text
entry-core rAF FCP → getWorkerPool().markFirstScreenRendered()
  → JIT createWorker(render ×≤2)
  → markdownRenderAsync：cache → Rust md_render → 失败才 schedule markdown.render
  → idle 15s 回收额外实例
compute/io/network：默认 0 实例（Rust 下沉）
```

---

## 4. 正面发现（禁止回潮）

### P1 · 聊天唯一垂直滚动容器 + overflow-anchor:none

- **位置**：`ChatMessageList.module.css:13-28`  
- **证据**：DIM-02 契约注释；`[data-chat-scroll-container]` 唯一 `overflow-y: auto`；`overflow-anchor: none` 防浏览器滚动锚定与虚拟化打架。  
- **价值**：避免嵌套 scroller 滚动链污染；合成层归属清晰。

### P2 · 行级 contain: layout paint，禁止 content-visibility: auto

- **位置**：`ChatMessageRow.module.css:9-10`；`streaming-animation.css:126-128`  
- **证据**：DEF-14 明确剔除 cv / contain-intrinsic-size；封口块注释记录「cv-auto 导致数千像素假高坍塌」事故。  
- **价值**：与 JS 虚拟化单轨一致；杜绝 CV 导致的滚动条长度抖动。

### P3 · 侧栏行 contain: strict（固定行高前提）

- **位置**：`SidebarSessionList.module.css:294-305`（`height/min/max: 28px` + `contain: strict`）  
- **价值**：布局/绘制/尺寸完全隔离，虚拟窗口外样式不泄漏。

### P4 · Worker 冷启零实例 + FCP 门闩 + 闲置回收

- **位置**：`workers/index.ts:11-15`；`worker-pool.ts:21-42, 79-91`；`entry-core.tsx:181-193`  
- **价值**：不与首屏抢线程；JIT 后 render 池 ≤2 且 15s 回收；与 07 启动方向一致。

### P5 · Markdown Rust-first，Worker 仅 fallback

- **位置**：`markdownRenderAsync.ts:37-52`  
- **价值**：常规路径零 JS parse；主线程不承担 pulldown/syntect/ammonia。

### P6 · VirtualScroll Gesture Epoch

- **位置**：`useVirtualScroll.ts:192-272`  
- **价值**：滚动手势冻结测高写入，杜绝 scrollHeight 抢占导致的滚动条抖动；`scrollend` / idle 定时收口。

### P7 · highlightCodeSafe ReDoS 盾 + 禁 highlightAuto

- **位置**：`codeHighlight.ts:144-150, 158-186`  
- **价值**：>4000 字符转义短路；无语言时转义而非 auto（避免 CPU 灾难）。

### P8 · reduced-motion + data-perf-tier=eco 全局静止

- **位置**：`streaming-animation.css:100-122`；`StreamingTableContainer.module.css:110-122`；`tokens.css` eco 段 `--stream-anim-*: 0ms`  
- **价值**：动画税可一键关闭；接入无障碍与性能分档。

### P9 · 系统字体栈，零 @font-face

- **位置**：`tokens.css:485, 1088`；全仓无 woff/woff2 资产  
- **价值**：无 FOIT/FOUT、无字体下载阻塞；07 启动方向确认无字体网段。

---

## 5. 问题详单（八要素）

---

### W1 · 【高】流式逐词 will-change 合成层膨胀

#### 位置

`apps/crish-desktop/src/components/chat-message-row/streaming-animation.css:28-37`

#### 现象

流式输出期间，每个被标记为动画的词/段 span 都声明 `will-change: opacity, transform`。高 TPS + 长尾块场景下，浏览器为每个 span 预留合成层，GPU 内存与合成 pass 成本随「视口内动画 span 数」增长；封口后若 class 未及时卸除，层可能残留。

#### 代码现场

```css
[data-conex-animate="true"],
[data-sd-animate="true"] {
  display: inline;
  will-change: opacity, transform;
  animation-name: conex-fade-in;
  animation-duration: var(--stream-anim-word-fade);
  /* ... */
}
```

#### 调用链与触发时机

1. 流式帧写入尾块文本 → 增量切分给 span 打 `data-conex-animate`（01 链路下游）。  
2. 每个新 span 进入样式匹配 → 合成器提升层。  
3. 高 TPS（数十 token/s）时，一帧内可新增数十个带 will-change 的 inline 元素。

#### 根因

将「动画期间临时提升」写成了「选择器命中即常驻」；Chromium 对 `will-change` 的层预留是显式提示，inline 文本节点级滥用会触发层爆炸（layer explosion）与 raster 预算耗尽。opacity+transform 的 `animation` 本身已可自动提升，无需每个 span 预声明 will-change。

#### 影响量化（静态推算，待 V1 验证）

- 假设视口内活跃尾块 2–8 KB 文本、平均 6 字符/词 → 数百～上千 animate span。  
- 每层即使 1–2 KiB 元数据 → 数 MB～十 MB 级额外 GPU/合成开销（与 01 H1 叠加：每帧切分越多，层越多）。  
- 与 eco 档对比：eco 下动画关闭但仍保留 will-change 规则（未在 eco 分支清除）——**eco 仍可能付层税**（见修复）。

#### 修复方案

1. **首选**：从 `.md` 选择器删除 `will-change`，仅保留 `animation-name/duration`；Chromium 对进行中的 animation 自动创建合成层，结束后回收。  
2. **若必须显式提升**：动画结束（`animationend`）后由封口/DOM 写路径移除 `data-conex-animate`，保证 will-change 生命周期 ≤ 单次 fade 时长。  
3. **eco 分支**（`html[data-perf-tier='eco']`）显式 `will-change: auto`（当前仅 `animation: none`）。  
4. 回归锚点：视觉快照（流式 fade 观感）+ `performance.getEventListeners` 不适用；用 DevTools Layers 截图对比层计数（V1）。

#### 回归风险与测试锚点

- 风险：极低端 GPU 上 fade 首帧可能不再严格合成（微卡）。  
- 测试：`streaming-animation` 相关单测/快照若存在则跑；新增「eco 下 will-change: auto」CSS 断言。

---

### D1 · 【高】Diff 路径主线程同步 highlight.js，worker 高亮通道空转

#### 位置

- 消费：`DiffCardUnifiedView.tsx:7, 35, 89`；`DiffCardSplitView.tsx:10, 39, 93, 248, 276`；`WidgetDiff.tsx:7, 166, 207, 227`；`ToolCallDiffPreview.tsx:4, 160`；`VirtualPlainCodeViewer.tsx:11, 284`  
- 实现：`codeHighlight.ts:131-186`  
- 闲置通道：`render-worker.ts:20-46`（`highlight.code` / `highlight.batch` / `highlight.code.stream`）；`worker-pool-options.ts` render 池默认存在但仅 markdown fallback 调度。

#### 现象

大 diff 首次展开时，每个可见变更行在 React 渲染 commit 期同步执行 `hljs.highlight`（cache 仅 `raw.length <= 500` 写入，`codeHighlight.ts:152-154`）。长行 500–4000 字符走 slice 混合着色仍同步；worker 已实现的 batch/stream 高亮生产零调用。

#### 代码现场

```tsx
// DiffCardUnifiedView.tsx:34-36
dangerouslySetInnerHTML={{
  __html: highlightCode(fallbackText, lang),
}}
```

```ts
// codeHighlight.ts:152-154 —— 仅短代码进 LRU
if (raw.length <= 500) {
  highlightCache.set(cacheKey, html);
}
```

```ts
// markdownRenderAsync.ts:44-50 —— worker 仅 markdown.render 回退
const workerHtml = await getWorkerPool().schedule<string>(
  'render', 'markdown.render', { raw }, priority
);
```

#### 调用链与触发时机

展开 diff 卡 / 打开工具 Diff 预览 / 文件对比视图 → 每个虚拟窗口内 `ChangeRenderItem` 映射 `renderTokens` → 同步 hljs → innerHTML。虚拟化限制了行数，但单行长字符串（minified、长 JSON）仍可单次 >10ms。

#### 根因

1. 高亮 API 以「markdown 封口」为中心设计，Diff 行未纳入 Rust `core_highlight` 或 worker batch。  
2. LRU 阈值 500 字符使「最值得缓存的长 diff 行」恰好不进缓存（只缓存短行，长行每次都算或每次只算一次且不复用——大文件多视图切换会重复算）。  
3. 与 01 L1 同构：增量/流式高亮基建存在，消费面未接线。

#### 影响量化（静态推算，待 V2 验证）

- 虚拟窗口 ~30–60 变更行 × 未命中 cache × 单行 0.1–2ms hljs → 首次展开 **3–100ms** 主线程尖刺。  
- 同一文件反复 expand/collapse：>500 字符行不进 LRU → 每次重算。

#### 修复方案

1. **短期**：Diff 列表在虚拟窗口可见集变化时，`getWorkerPool().schedule('render', 'highlight.batch', { items })` 预取 HTML，写入专用 Diff LRU（不进 React state 高频），行渲染只读缓存。  
2. **中期**：对齐 markdown 路径，大块 highlight 走 Rust `core_highlight`（spawn_blocking），worker 仅无 Rust 时 fallback。  
3. **缓存**：上调或按「估算渲染成本」决定是否入 LRU（长行更该缓存）；预算由 memoryManager 管（已有 register）。  
4. 非语言 / 超长行维持 escape 短路（防回潮）。

#### 回归风险与测试锚点

- 异步高亮导致行内容闪变 → 先渲染 escape 文本，batch 回来再原子替换（与封口块模式一致）。  
- 测试：`codeHighlight` 单测扩展 batch 一致性；Diff 视觉回归（token span 结构与 syntect 差异已 fixtures 记录）。

---

### T1 · 【高】表格流式无限脉冲动画绑定 outline / box-shadow / background

#### 位置

`StreamingTableContainer.module.css:83-108`

#### 现象

表格流式期间，末行末格挂 `md-table-pulse` **1.6s infinite**，同时插值 `outline-color`、`box-shadow`、`background-color`，并对该格设置 `will-change: outline-color, box-shadow, background-color`。这些属性均不可在合成器上完成——每帧强制主线程 paint（或至少破坏层复用），并与消息流 rAF 预算（01：6ms/帧）争夺时间片。

#### 代码现场

```css
@keyframes md-table-pulse {
  0%, 100% {
    outline-color: ...;
    box-shadow: 0 0 0 1px ...;
    background-color: ...;
  }
  50% { /* 同族属性 */ }
}
/* ... */
animation: md-table-pulse 1.6s var(--stream-anim-easing) infinite;
will-change: outline-color, box-shadow, background-color;
```

eco / reduced-motion 已关闭动画（110-122）——正面，但默认档全开。

#### 调用链与触发时机

GFM/流式表格容器 `data-table-streaming='true'` → 活跃格持续重绘 → 与同屏 markdown 流式、滚动重叠。

#### 根因

注释写「GPU 硬件加速」（83 行）但 keyframes 属性选错：outline/box-shadow/background 是 paint 属性；`will-change` 列表同样不能提升为动画层，反而常驻脏标记。

#### 影响量化（静态推算，待 V3 验证）

- 表格流式时，活跃格每帧 ~（box-shadow 扩散 + color-mix）重绘；叠加消息列表滚动时，易出现表格卡顿。  
- `color-mix` 计算在低端机有额外成本。  
- 量级估计：表格流式 30–60s 会话内持续 +1–3ms paint/帧（待 Performance 面板证实）。

#### 修复方案

1. 改为 **opacity 过渡的 ::after 覆盖层**（伪元素盖 outline 位置），keyframes 只动 opacity/transform。  
2. 删除错误的 `will-change: outline-color, ...`。  
3. 默认档改为「脉冲 2–3 次后停止」而非 infinite，避免长流常驻。  
4. 保留 eco/reduced-motion 分支。

#### 回归风险与测试锚点

- 视觉：脉冲观感略变 → 设计确认；CSS 快照更新。  
- 测试：`StreamingTableContainer` 相关单测/快照。

---

### W2 · 【中】侧栏会话行常驻 will-change: transform

#### 位置

`SidebarSessionList.module.css:294-305`（`.sessionItemWrap`）

#### 现象

每个会话行固定 `will-change: transform`，与 `contain: strict` 叠加。会话数百～数千时（窗口化虽限制挂载数，但可见窗口内每行一层），GPU 层数 ≈ 可见行数；拖拽/动画结束后层不回收。

#### 代码现场

```css
.sessionItemWrap {
  height: 28px; /* ... */
  contain: strict;
  will-change: transform;
}
```

#### 调用链与触发时机

侧栏窗口化渲染任意行；hover/拖拽使用 transform 动画时曾依赖该提示。

#### 根因

「为拖拽动画预提升」写在静态类上；应仅在 drag/session 激活时动态挂。

#### 影响量化

可见 ~20–40 行 → 20–40 持久层；与 chat 列表层叠加。单独可感知度低，与 02 侧栏重渲染叠加时层数更高。

#### 修复方案

1. 删除静态 will-change；在 `useTabDrag` / 行进入动画 class 期间添加。  
2. 保留 `contain: strict`（正面）。

#### 回归风险与测试锚点

拖拽首帧可能闪 → 在 pointerdown 先挂 will-change 再拖（与 tabDragGhost 模式对齐）。

---

### W3 · 【中】布局属性 will-change 反模式群

#### 位置（代表）

- `ToastStackModern.module.css:95`：`will-change: transform, opacity, height`  
- `Tabs.module.css:120`：`transform, width, height, opacity`  
- `Switch.module.css:164`：`transform, width`  
- `PaneHeader.module.css:107`：`flex-basis, width`  
- `BinaryTreeWorkspace.module.css:134`：`left, width, top, height`  
- `SegmentedControl.module.css:127`：含 `width`

#### 现象

对 `width/height/top/left/flex-basis` 声明 will-change：这些是布局属性，合成器无法单独提升；结果是层内存预留 + 浏览器假设「即将频繁动画该元素」而放宽合并，实际动画仍走 layout。

#### 调用链与触发时机

Tabs 切换、Toast 进出、Switch 拨动、分屏拖拽。

#### 根因

「加速动画」的 will-change 教条被套用到非合成属性；缺少 lint/审查清单。

#### 影响量化

单元素层预留小；二叉树工作区拖拽浮层生命周期若过长，`left/top/width/height` 四属性提示在拖拽全程抑制样式合并，拖拽掉帧风险高于必要值。

#### 修复方案

1. 一律改为仅 `will-change: transform, opacity` 或删除。  
2. 二叉树拖拽浮层：拖拽 start 挂、end 移除（生命周期收缩）。  
3. 可选：`check-input-guardrails` 风格脚本增加「禁止 layout 属性 will-change」静态门禁。

#### 回归风险与测试锚点

动画更「掉帧」的假抱怨 → 用 transform 重写过渡（见 A1/A2）后实测。

---

### B1 · 【中】ChatComposer 常驻 backdrop-filter 与消息滚动同屏

#### 位置

`ChatComposer.module.css:823-824, 860-861, 890-891`（及对应组件常驻可见性）

#### 现象

底栏附件进度徽章等元素使用 `backdrop-filter: blur(4–8px)`。Composer 在主布局常驻；消息流滚动时，背板内容变化触发 backdrop 重新采样，GPU 模糊与滚动 raster 竞争。

#### 代码现场

```css
.attachProgressBadgeImage {
  background: var(--surface-overlay);
  backdrop-filter: blur(4px);
}
```

#### 调用链与触发时机

存在附件/进度徽章时全程可见；与 chat 滚动、流式重绘同屏。

#### 根因

视觉层级用毛玻璃表达，未按 `data-perf-tier` 分档降级（对比 Dialog 遮罩可接受短暂成本）。

#### 影响量化（待 V4）

持续模糊 + 滚动时帧预算中 GPU 段拉长；eco 档未见对应 `backdrop-filter: none` 分支（需在修复时补）。

#### 修复方案

1. eco / reduced 档：`backdrop-filter: none` + 不透明近似色。  
2. 评估徽章是否可用不透明 surface + 边框替代 blur（信息密度低，模糊收益小）。

#### 回归风险与测试锚点

视觉微调；CSS 断言 eco 无 blur。

---

### A1 · 【中】Toast 卡 height 过渡 + will-change height

#### 位置

`ToastStackModern.module.css:89-95, 119`

#### 现象

展开时 `height: var(--toast-height)` 过渡 0.18s，且 `will-change` 含 height。高度动画强制 layout，Toast 堆叠 `translateY` 依赖 `--height` 计算时形成「量测 → 改 height → 再量测」链。

#### 代码现场

```css
transition: transform 0.5s ..., height 0.18s ...;
will-change: transform, opacity, height;
```

#### 调用链与触发时机

toast 堆叠展开/收起；多 toast 并发时连带。

#### 根因

内容高度需从折叠态到全高；未使用测量后改 transform/scaleY 或 max-height 假高技巧，直接动画 height。

#### 影响量化

每次展开一次 layout + 可能的级联重排；toast 非高频但流式错误风暴时连发。

#### 修复方案

1. 拍摄高度后 `height: auto` + `transform: scaleY` 从 0→1，或 max-height 阶梯。  
2. 从 will-change 移除 height。  
3. transform 堆叠已较好，保持。

#### 回归风险与测试锚点

展开曲线手感；ToastStack 单测/视觉。

---

### A2 · 【中】Tabs 指示器 width/height 弹簧动画

#### 位置

`Tabs.module.css:113-127`

#### 现象

`.indicator` 以 spring 贝塞尔同时过渡 `transform`、`width`、`height`、`opacity`，并 will-change 四者。width/height 每帧 layout；标签切换频繁时（工作区多 tab）指示器动画成为固定 layout 税。

#### 修复方案

1. 测量目标 tab 一次 → 仅动画 `transform: translateX` + `scaleX`/`scaleY`（或固定高度只动 translate + width 用 scaleX 近似，标签宽变化大时用 clip-path/transform 组合）。  
2. 常见成熟做法：指示器绝对定位 + `transform: translateX(x); width: w` 但 **width 不进 transition**，切换瞬间更新 width，只动画 translate（接受宽度跳变）或 FLIP。  
3. will-change 仅保留 transform。

#### 回归风险与测试锚点

Tabs 切换视觉回归；`Tabs` 组件测试。

---

### S1 · 【中】FlowScrubber top 过渡与主滚动几何双重布局

#### 位置

`FlowScrubber.module.css:168-180`；`FlowScrubber.tsx:85-190`（几何读）；`flowScrubberModel.ts:209-234`

#### 现象

滚动条 scrubber 指示以 `top` 过渡定位；拖动/跟随时 JS 读 `getBoundingClientRect` / `clientHeight` / `offsetHeight` 并写 `scrollTop`，CSS 再动画 `top`——读布局 → 写滚动 → 动画布局属性，三条路径耦合。

#### 调用链与触发时机

消息列表滚动 / scrubber 拖动。

#### 根因

scrubber 视觉位置用 top 百分比映射，未 transform 化；与主 scroller 几何同步路径未完全批处理。

#### 影响量化

中长会话拖动 scrubber 时可能每 move 一次强制同步布局（与 G1 叠加）。

#### 修复方案

1. scrubber 指示改为 `transform: translateY(px)`，像素在 rAF 缓冲内算。  
2. 拖动期间禁用 CSS transition（与 Gesture Epoch 类似），结束后再平滑。

#### 回归风险与测试锚点

scrubber 手感；flowScrubber 相关单测。

---

### S2 · 【中】Diff 多层嵌套滚动容器 + sticky 表头

#### 位置

`DiffCard.module.css:23, 182-204, 617-691` 等多处 `overflow-y: auto`；`overscroll-behavior: auto`（非 contain）

#### 现象

Diff 面板存在列表 scroller、统一视图 scroller、代码块 scroller 多层嵌套；`overscroll-behavior: auto` 允许滚动链传播。sticky thead（表格容器类似）在嵌套滚动中增加合成层与 clip 成本。

#### 调用链与触发时机

Diff 面板内滚轮；触控板惯性穿透到聊天主列表。

#### 根因

Diff 历史多视图叠加（file list + unified/split + code），未收敛为单滚动宿主（对比 chat DIM-02）。

#### 影响量化

滚动链导致「滚 diff 却带动消息列表」体验问题 + 额外合成；性能上层数量中等。

#### 修复方案

1. 内层 scroller 标记 `overscroll-behavior: contain`（chat markdown 表格已有 contain 先例）。  
2. 中期评估：diff 文件列表与代码区是否可合并为单虚拟滚动画布（与 02 工具卡策略对齐）。

#### 回归风险与测试锚点

滚动嵌套行为变化需 QA 手测；CSS 单测断言 contain。

---

### G1 · 【低】scrubber / 锚点路径几何读写交错（补 01 M1）

#### 位置

`flowScrubberModel.ts:209-234`；`useScrollAnchor.ts:51-80`；`PagingAnchor.ts:44-81`

#### 现象

锚点/scrubber 在同一调用栈内多次 `getBoundingClientRect` + `scrollTop`/`scrollHeight` 读，再写 `scrollTop`。useScrollAnchor 为显式同步修正（注释：绝不 rAF，防多帧共振）——**有意设计**；scrubber 拖动路径若每 pointermove 全量测，存在 thrash 风险。

#### 根因

几何真相源在 DOM；缺少「一次布局读批 + 一次写批」的通用工具（仅部分路径有 Gesture Epoch）。

#### 影响量化

偶发路径影响小；连续拖 scrubber 时可能 1–2ms/事件 强制 layout。

#### 修复方案

1. scrubber 拖动：缓存 rect 快照（pointerdown），move 内只用缓存 + scrollTop 写。  
2. 保持 useScrollAnchor 同步语义（正面，勿改 rAF）。

#### 回归风险与测试锚点

锚点单测 `useScrollAnchor.test` 契约勿动。

---

### B2 · 【低】Dialog backdrop blur(16–20px)+saturate

#### 位置

`Dialog.module.css:18-26`

#### 现象

模态遮罩全屏级模糊+saturate；打开瞬间 GPU 峰值。

#### 影响量化

短暂，可接受；与流式同时打开设置时可能掉 1–2 帧。

#### 修复方案

可选：打开动画结束后降为 blur(8px)；或 eco 档降强度。

---

### B3 · 【低】box-shadow 面量 389 处

#### 位置

全 CSS 统计（素材 §7）；代表：`ChatMessageRow.module.css:28-31` searchHit、`ToastStackModern.module.css:86-87` 双层、大量 Button/Card hover。

#### 现象

静态阴影可接受；`transition: box-shadow` 与 hover 叠加时扩大重绘区域。

#### 修复方案

hover 阴影变化优先改为伪元素 opacity 过渡或 `outline`/`border` 色变；门禁脚本可对「transition 含 box-shadow 且用于长列表行」告警。

---

### A3 · 【低】Sidebar 宽度 spring 过渡

#### 位置

`Sidebar.module.css:9`

#### 现象

`transition: width var(--transition-spring-layout)`；拖拽 resize 时整栏 reflow（子树宽跟随）。

#### 修复方案

拖拽中用 transform/clip 等宽视觉，松手提交 width；或拖拽中 `transition: none`。

---

### A4 · 【低】Diff max-height 过渡

#### 位置

`DiffCard.module.css:681`

#### 现象

`transition: max-height ...` 展开代码块强制重排。

#### 修复方案

同 A1：测高后 transform/FLIP；或 grid-template-rows 0fr→1fr（仍可能 layout 但更可控）。

---

### C1 · 【低】全局几乎禁用 content-visibility（策略记录）

#### 位置

`ChatMessageRow.module.css:9`；`streaming-animation.css:126-128`；仅 `SettingsUI.module.css:59` 使用 cv-auto。

#### 现象

这是**有意策略**（虚拟化单轨），非缺陷。记录防止后续 agent「优化」回潮 cv-auto。

#### 修复方案

无代码修复；在 review findings 防回潮条目留档。

---

### F1 · 【低】rIC 仅覆盖启动，运行期空闲分片未复用

#### 位置

`StaggeredIdleQueue.ts`；消费 `hydrateWorkspaceShell.ts:23`、`entry-core.tsx:119,232`

#### 现象

运行期大量可降优先级工作（预热 markdown 批、字体 catalog 扫描、非可见 diff 高亮）未走 idle 队列；D1 修复后可把 highlight.batch 接入 idle。

#### 修复方案

热修复完成后将「预取类」工作统一 `staggeredIdleQueue.enqueue`；避免滥用（生产热路径仍用 rAF/48ms 批——01 契约）。

---

### H1 · 【低】流式光标无限 opacity 动画

#### 位置

`streaming-animation.css:72-90`

#### 现象

`.conex-streaming-caret` 800ms 无限 opacity；单元素成本极低，eco/reduced-motion 已关闭。

#### 修复方案

可选：默认档改为 steps(2) 或 `caret-color` 原生；非必须。

---

## 6. 主题汇总表

| 主题 | 结论 |
| ---- | ---- |
| 合成层 | will-change 19 处中约半数不当；聊天 contain 策略正确 |
| 重排 | 布局属性动画集中在 Toast/Tabs/Sidebar/Diff；流式主路径重排受控（无 cv-auto 事故） |
| 重绘 | 表格脉冲 paint 动画为流式期最重 paint 税 |
| Worker | 生命周期优秀；**任务面严重偏科**（markdown-only fallback） |
| 调度 | rIC 质量高但覆盖面窄；rAF 体系与 01 一致 |
| 滚动 | chat 合同最佳；diff 需 overscroll contain 收敛 |
| 字体 | 系统栈，零 webfont 风险 |
| 动画 | eco/reduced-motion 分档健全；默认档若干反模式 |

---

## 7. 修复路线图（逻辑依赖，不谈工期）

### 批次 W · 合成层卫生（优先）

| 序 | 项 | 依赖 |
| -- | -- | ---- |
| W-a | 删除流式逐词 will-change；eco 显式 auto（W1） | 无 |
| W-b | 侧栏行 will-change 改动态挂载（W2） | 无 |
| W-c | 布局属性 will-change 清单清理（W3） | 无 |
| W-d | will-change 静态门禁（可选脚本） | W-a/b/c |

### 批次 D · Diff 高亮卸载

| 序 | 项 | 依赖 |
| -- | -- | -- |
| D-a | highlight.batch 可见集预取 + Diff LRU（D1） | 可与 W 并行 |
| D-b | Rust core_highlight 接入 Diff（可选） | D-a 或独立 |
| D-c | 缓存策略按成本入 LRU | D-a |

### 批次 A · 动画属性重写

| 序 | 项 | 依赖 |
| -- | -- | -- |
| A-a | 表格脉冲改 opacity 伪元素（T1） | 无 |
| A-b | Toast 高度动画改 transform（A1+W3） | W3 |
| A-c | Tabs 指示器 FLIP/transform（A2+W3） | W3 |
| A-d | Scrubber transform 化（S1） | 无 |

### 批次 B · GPU 常驻税

| 序 | 项 | 依赖 |
| -- | -- | -- |
| B-a | Composer blur eco 降级（B1） | 无 |
| B-b | Dialog blur 可选降级（B2） | 无 |

### 批次 S · 滚动契约收紧

| 序 | 项 | 依赖 |
| -- | -- | -- |
| S-a | Diff 内层 scroller overscroll contain（S2） | 无 |
| S-b | scrubber 拖动 rect 快照（G1） | 无 |

**性价比最高**：批次 W（一行级 CSS 删除/收敛，流式 GPU 直接受益）+ 批次 D-a（解除大 diff 首次展开主线程尖刺）。

---

## 8. 运行时验证建议（未实测，待回填）

| ID | 项 | 方法 | 通过标准（建议） |
| -- | -- | ---- | ---------------- |
| V1 | 流式期 Layers 面板层计数 | Tauri MCP + Performance/Layers；100KB 流式输出 | 修复前后 animate span 层峰值对比；eco 下 will-change: auto |
| V2 | 大 diff 展开主线程尖刺 | Performance 录制 expand diff | 首次展开 scripting < 8ms 目标 |
| V3 | 表格流式 paint 火焰 | Performance；GFM 长表格流 | paint 频率与脉冲属性剥离后下降 |
| V4 | Composer blur 与滚动同屏 GPU | Frame Rendering / GPU 段 | eco 降级后 GPU 时间下降 |
| V5 | 侧栏 will-change 层数 | Layers；500 会话窗口 | 可见行层数下降 |
| V6 | Diff overscroll | 触控板滚到底 | 不再带动聊天列表 |
| V7 | Worker 池实际存活 | 调试日志 / Task Manager | markdown 回退时 render=1–2；Diff 修复后 batch 有调度 |

验证通道遵守仓库纪律：**仅 4000 Tauri MCP**（禁止 9222 CDP）；勿在 mock 会话上宣称通过。

---

## 9. 交叉引用

| 对象 | 关系 |
| ---- | ---- |
| 01 H1/H2 | 块切分/哈希修复后，DOM 侧 W1 will-change 才能吃到干净帧；建议同迭代 |
| 01 L1 | 与 D1 同构：高亮基建闲置；L1 死代码结论在本向对 worker stream 通道再次确认 |
| 01 M1 | 几何读写交错；本向 G1 补 scrubber/锚点 |
| 02 X1/X2 | 终端 WebGL/PTY 不在本向重复；TerminalCard CSS scroll 侧无重大新发现 |
| 02 C1/T1 | 侧栏 memo 与 will-change 是不同层问题，可同批修侧栏时处理 W2 |
| 07 A1/字体 | 零 webfont 确认；hljs 语言全量 import 属 11 bundle 向，本向仅记录与 Diff 冷路径相关 |
| 11 资产 | 若 D1 改 Rust highlight，syntect 与 hljs 体积权衡归 11 |

---

## 10. 附录 · 扫描命令备忘

```text
# CSS 属性
rg -n "will-change|contain:|content-visibility|backdrop-filter|box-shadow:" apps/crish-desktop/src --glob "*.css"

# 布局动画
rg -n "transition:.*(width|height|top|left|flex)" apps/crish-desktop/src --glob "*.css"

# Worker 消费
rg -n "getWorkerPool|highlightCode" apps/crish-desktop/src -g "*.ts" -g "*.tsx"

# 调度
rg -n "requestIdleCallback|requestAnimationFrame|ResizeObserver" apps/crish-desktop/src
```

---

## 11. 附录 A · will-change 全量清单（与素材同步）

| 文件 | 行 | 声明摘要 | 判定 |
| ---- | -- | -------- | ---- |
| streaming-animation.css | 31 | opacity, transform（逐词） | **高危 W1** |
| streaming-animation.css | 65 | transform（TURBO 容器） | 可接受 |
| StreamingTableContainer.module.css | 107 | outline-color, box-shadow, background-color | **高危 T1 关联** |
| ChatToolCallBlock.module.css | 151 | transform, opacity | 需确认动画期 |
| SidebarSessionList.module.css | 302 | transform（每行常驻） | **中 W2** |
| SidebarSessionList.module.css | 625 | transform（拖拽幽灵） | 可接受 |
| ToastStackModern.module.css | 95 | transform, opacity, height | **中 W3/A1** |
| Tabs.module.css | 120 | transform, width, height, opacity | **中 W3/A2** |
| Switch.module.css | 164 | transform, width | **中 W3** |
| ui/PreviewCard.module.css | 9 | transform, opacity | 可接受 |
| PaneHeader.module.css | 107 | flex-basis, width | **中 W3** |
| BinaryTreeWorkspace.module.css | 134 | left, width, top, height | **中 W3** |
| sessionTabDrag.module.css | 86 | transform, opacity | 可接受（拖拽期） |
| SegmentedControl.module.css | 127 | transform, width, opacity | **中 W3** |
| ScrollArea.module.css | 173, 224 | transform | 可接受 |

## 12. 附录 B · 主要滚动容器 CSS 契约

| 容器 | overflow | 其它合成相关 | 评估 |
| ---- | -------- | ------------ | ---- |
| Chat 消息列表 `ChatMessageList.module.css:14-28` | 唯一 overflow-y:auto | overflow-anchor:none；无 contain 于列表根（行内 contain） | 契约正确 P1 |
| 消息行 `ChatMessageRow.module.css:1-19` | 无自身滚动 | contain:layout paint | P2 |
| 侧栏会话 `SidebarSessionList.module.css` | 列表级 | 行 contain:strict；行 will-change 常驻 | P3 + W2 |
| Diff 文件列表 `DiffCard.module.css:182-204` | overflow-y:auto ×2 | overscroll-behavior:auto；container-type:inline-size | S2 |
| 表格视口 `StreamingTableContainer.module.css:20-26` | x/y auto | contain:layout paint；sticky thead | 嵌套滚动需 contain overscroll |
| Markdown pre `markdown-typography.css:52-53, 688-689` | overflow-x:auto | overscroll-behavior-x:contain | 正面范例 |
| 终端 `TerminalCard.module.css:307-309` | x hidden / y auto | overscroll-behavior:contain | 正面；WebGL 另见 02 |
| Composer 尾块 `ChatComposer.module.css:618-620` | x auto | overscroll-behavior-x:contain | 正面 |

## 13. 附录 C · Worker 任务矩阵

| 任务类型 | 实现文件 | 默认实例数 | 生产消费者 | 备注 |
| -------- | -------- | ---------- | ---------- | ---- |
| render/markdown.render | render-worker.ts:13-17 | 2（JIT） | markdownRenderAsync 仅 Rust 失败回退 | 正常冷路径不进 worker |
| render/highlight.* | render-worker.ts:20-46 | 同上 | **无生产调用** | 与 D1 直接相关 |
| compute/* | compute-worker.ts | 0 | 主线程 api-adapters fallback | 设计如此（Rust 下沉） |
| io/* | io-worker.ts | 0 | 同上 | 同上 |
| network | 映射 compute-worker | 0 | 废弃 | worker-pool-options 注释 |

## 14. 附录 D · 与 01–07 报告发现对照

| 本向 ID | 对应外部 ID | 关系说明 |
| ------- | ----------- | -------- |
| W1 | 01 流式帧预算 H1/H2 | 切分修复后 DOM 层数下降；建议同迭代验证 Layers |
| D1 | 01 L1 | 增量/流高亮死代码在 worker 侧再次确认 |
| G1 | 01 M1 | 几何读写；scrubber 为补充站点 |
| W2 | 02 C1 | 侧栏 SessionRow：memo 与 will-change 可同 PR 处理 |
| （无新增） | 02 X1 | 终端 CSS 滚动无重大新发现；WebGL 不重复 |
| P9 | 07 字体 | 确认零 webfont；07 可引用本向为证据 |
| D-b 预留 | 11 / 10 | Rust highlight 若下沉，体积与命令面归 11/10 追踪 |

## 15. 附录 E · 修复伪代码（关键项）

### E1 · W1 流式 will-change 收敛

```css
/* 删除常驻 will-change */
[data-conex-animate="true"],
[data-sd-animate="true"] {
  display: inline;
  animation-name: conex-fade-in;
  animation-duration: var(--stream-anim-word-fade);
  animation-timing-function: var(--stream-anim-easing, cubic-bezier(0.16, 1, 0.3, 1));
  animation-fill-mode: both;
}

html[data-perf-tier='eco'] [data-conex-animate="true"],
html[data-perf-tier='eco'] [data-sd-animate="true"] {
  animation: none;
  opacity: 1;
  transform: none;
  will-change: auto;
}
```

### E2 · T1 表格脉冲 opacity 化

```css
.tableCellPulseHost { position: relative; }
.tableCellPulseHost::after {
  content: "";
  position: absolute; inset: -1px;
  border: 1px solid var(--accent-color);
  border-radius: inherit;
  opacity: 0;
  animation: md-table-pulse-opacity 1.6s ease-in-out 3; /* 有限次 */
  pointer-events: none;
}
@keyframes md-table-pulse-opacity {
  0%, 100% { opacity: 0.15; }
  50% { opacity: 0.45; }
}
```

### E3 · A2 Tabs 指示器 FLIP 思路

```text
1. 渲染指示器 position:absolute; transform:translateX(x); width:w; height:h （width 不进 transition）
2. 切换：读取目标 tab rect（一次）→ 同步设置 width/height → 对 transform 只动画 translateX
3. will-change: transform 仅在 animation 期间由 JS 挂卸
```

### E4 · D1 Diff 高亮预取

```text
onVisibleRangeChange(range):
  items = range.filter(isChange).map(line => ({ id, code: line, language }))
  worker.schedule('render', 'highlight.batch', { items }, Priority.Low)
  .then(results => results.forEach(r => diffHtmlCache.set(r.id, r.html)))

行渲染:
  html = diffHtmlCache.get(id) ?? escapeHtml(line)
  // 命中后可选 requestIdleCallback 热更新 dangerouslySetInnerHTML
```

## 16. 附录 F · 验证操作清单（Tauri MCP）

1. 启动 `npm run dev:workbench`（debug 构建，4000 MCP 默认开）。  
2. 用真实会话（非 mock A/B/C）注入或等待 ≥50KB 流式输出。  
3. Performance 面板录制 5s：记录 Scripting / Rendering / GPU 段与 Long Task。  
4. Layers 截图：统计 `data-conex-animate` 节点层数。  
5. 打开含 >200 行变更的 diff：录制 expand 瞬间。  
6. 表格流式：观察 `md-table-pulse` 节点 paint 频率。  
7. 将 `html[data-perf-tier=eco]` 打开重复 3–5，对比。  
8. 回填本报告 §8 表格，禁止用浏览器独立窗口 5174 冒充验收。

## 17. 附录 G · 术语

| 术语 | 含义 |
| ---- | ---- |
| 合成层提升 | 浏览器为独立 transform/opacity 动画分配 layer；will-change 强制提示 |
| paint-only 属性动画 | outline/box-shadow/background 等无法在 compositor 完成的动画 |
| Gesture Epoch | 本仓 VirtualScroll 手势冻结测高的机制名 |
| 封口块 | 流式 markdown 不可变段，走 Rust 编译一次（01 术语） |
| cv-auto | content-visibility:auto，本仓聊天行策略性禁用 |

---

## 18. 附录 H · 严重度判定细则（本向口径）

| 级别 | 本向判定标准 | 适用示例 |
| ---- | ------------ | -------- |
| 高 | 位于流式/滚动每帧路径或首次打开大内容的同步主线程尖刺；层膨胀随数据线性恶化；默认档（非 eco）用户无感即中招 | W1/D1/T1 |
| 中 | 常驻 GPU/布局税或可测布局动画；固定场景可感知，规模化后加重 | W2/W3/B1/A1/A2/S1/S2 |
| 低 | 局部、短暂、已有 eco 降级、或策略记录类 | B2/B3/A3/A4/C1/F1/H1 |

## 19. 附录 I · 修复批次依赖图

```text
[W 批 · 合成卫生]          [D 批 · Diff 高亮]         [A 批 · 动画重写]
 W-a will-change 词级        D-a batch 预取+LRU          A-a 表格 pulse
 W-b 侧栏动态 will-change    D-b Rust highlight(可选)    A-b Toast transform
 W-d 静态门禁 ← W-a/b/c      D-c 成本入缓存 ← D-a        A-c Tabs FLIP ← W3
                                                       A-d Scrubber transform

[B 批 GPU]                 [S 批 滚动]
 B-a Composer blur eco       S-a Diff overscroll contain
 B-b Dialog blur 降强        S-b scrubber rect 快照

跨批：W3 清理是 A-b/A-c 前置；D-a 可与 W 并行；F1 在 D-a 后接 idle。
```

## 20. 附录 J · 关键文件行号速查（修复时锚点）

| 主题 | 锚点 |
| ---- | ---- |
| 流式词动画 CSS | `streaming-animation.css:28-37, 100-122` |
| 表格脉冲 | `StreamingTableContainer.module.css:83-123` |
| 行 contain | `ChatMessageRow.module.css:9-10` |
| 唯一滚动容器 | `ChatMessageList.module.css:13-28` |
| Worker 选项 | `worker-pool-options.ts:40-56` |
| Worker JIT | `worker-pool.ts:38-91` |
| Worker 门面 | `workers/index.ts:11-15` |
| Markdown 回退 | `markdownRenderAsync.ts:37-52` |
| Diff 统一视图高亮 | `DiffCardUnifiedView.tsx:21-94` |
| 高亮 LRU 阈值 | `codeHighlight.ts:152-154` |
| 高亮安全盾 | `codeHighlight.ts:158-186` |
| 侧栏行 will-change | `SidebarSessionList.module.css:294-305` |
| Toast height | `ToastStackModern.module.css:89-95` |
| Tabs 指示器 | `Tabs.module.css:113-127` |
| Composer blur | `ChatComposer.module.css:821-891` |
| Gesture Epoch | `useVirtualScroll.ts:192-272` |
| ScrollAnchor 同步 | `useScrollAnchor.ts:50-81` |
| Idle 队列 | `StaggeredIdleQueue.ts:81-98` |
| FCP 解锁 Worker | `entry-core.tsx:181-193` |
| 字体栈 | `tokens.css:485, 1088-1093` |

## 21. 附录 K · 方法局限与免责

1. 本报告全部结论基于 2026-09-12 工作区静态快照；行号在后续重构后需按符号名重定位。  
2. 未在真实 WebView2 中抓取 Layers / Performance 轨迹；层膨胀与 paint 税的绝对毫秒数均为静态推算，已在正文标注「待 Vx 验证」。  
3. 未修改任何应用代码；修复方案为建议，不构成已落地变更。  
4. Git 提交权归主 Agent；本子任务零 commit。  
5. 与 02 终端、01 每帧派生重叠处已显式交叉引用，避免双计「高危」。

## 22. 结论回执

| 项 | 值 |
| -- | -- |
| 路径 | `docs/performance-audit/12-Webview运行时审查报告.md` |
| 素材 | `materials/12-CSS合成与动画热点.md`、`materials/12-Worker调度与DOM读写.md` |
| 发现 | 19 项问题（3 高 / 8 中 / 8 低）+ 9 正面 |
| TOP3 高危 | ① W1 流式逐词 will-change 层膨胀 ② D1 Diff 主线程 hljs + worker 高亮空转 ③ T1 表格无限 paint 脉冲 |
| 修复批次 | W（合成卫生）→ D（Diff 高亮）→ A（动画重写）→ B（GPU 常驻）→ S（滚动收紧） |
| 一句话 | 合成与 Worker 生命周期策略健康，但流式逐词合成层、Diff 主线程高亮与布局/paint 动画三大税源仍需按批次 W/D/A 收敛。 |
