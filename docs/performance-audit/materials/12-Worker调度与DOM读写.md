# 12 · Web Worker / 调度 / DOM 读写扫描素材

> 日期：2026-09-12  
> 范围：`apps/crish-desktop/src/workers/`、idle 调度、DOM 几何读写热点（CSS/合成侧交叉）

## 1. Worker 池架构现状

### 1.1 配置（Stream E 改造后）

`workers/worker-pool-options.ts:1-12` 注释明确：
- compute / io / network **默认 0 实例**——任务下沉 Rust 命令，JS 仅主线程 fallback。
- 保留 render worker 文件用于轻量回退（markdown / highlight）。
- `DEFAULT_OPTIONS`：renderWorkers: 2；`MINIMAL`：1。
- `getWorkerPool()`：`lazyInit: true` + idleTimeoutMs 15s（`workers/index.ts:11-15`）。
- ACT-302：FCP 前禁止 createWorker，`markFirstScreenRendered` 后 JIT（`worker-pool.ts:38-91`）。

### 1.2 任务面

`render-worker.ts` 支持：
- `markdown.render` / `highlight.code` / `highlight.batch` / `highlight.code.stream` / ping

**生产消费面**：
- 唯一 schedule 入口：`api/markdownRenderAsync.ts:45` —— 仅在 **Rust md_render 失败/缺失** 时回退 worker。
- Diff 路径（`DiffCardUnifiedView.tsx:35/89`、`DiffCardSplitView`、`WidgetDiff`、`ToolCallDiffPreview`）**全部同步主线程** `highlightCode` / `highlightCodeSafe`，**不经 worker、不经 Rust core_highlight**。
- `api/codeHighlight.ts`：21 个语言静态 import + LRU + ReDoS 盾；同步在渲染 commit 期执行。

### 1.3 负面 / 正面

| 项 | 判定 |
| -- | ---- |
| FCP 门闩 + lazyInit + 15s 回收 | 正面（冷启零 Worker） |
| Rust-first markdown | 正面（主线程零 parse） |
| compute/io 池关闭 | 正面（减少线程抢占） |
| Diff 主线程同步 hljs | **负面（高）**：大 diff 首次展开多行高亮可阻塞主线程 |
| highlight.batch / stream 已实现但 Diff 未接 | 架构闲置（与 01 L1 同类） |

## 2. requestIdleCallback / 调度

- `services/idle/StaggeredIdleQueue.ts`：rIC + 8ms 预算守卫 + maxWait 保底 + 无 rIC 降级 setTimeout16ms——**质量高**。
- 消费面：启动链路 `hydrateWorkspaceShell` / `entry-core` 冷启 full 装配；**运行期热路径未见 rIC**。
- 全仓无 `scheduler.postTask`。
- rAF 大量：StreamRenderBuffer、流节流、Composer resize、xterm fit、Tabs 拖拽——符合预期。

## 3. DOM 读写交错（CSS/合成侧交叉 01 M1）

| 站点 | 模式 | 评估 |
| ---- | ---- | ---- |
| `useVirtualScroll.ts:167-174` | scrollHeight/clientHeight/scrollTop 连续读 + 写 scrollTop | 在 applyPendingGeometry（rAF 后 flush）内，可接受；Gesture Epoch 冻结期跳过 |
| `useScrollAnchor.ts:51-80` | 连续 getBoundingClientRect + clientHeight + 写 scrollTop | 跳转锚点一次性；非每帧 |
| `flowScrubberModel.ts:209-234` | clientHeight/offsetHeight + 写 scrollTop | scrubber 拖动期可能每 move 一次 |
| `useAutoGrowTextarea.ts:51-60` | style.height=auto → scrollHeight → 写回 | 输入每帧风险；有 RAF 包裹 |
| `PaneHeader.tsx:355-374` | 拖拽路径 getBoundingClientRect | tabDragGhost 有缓存注释，部分仍读 |
| `useComposerMultiline.ts:98-107` | 多 offsetWidth + getComputedStyle | RO 回调内，RAF 批 |

## 4. 字体

- `tokens.css`：`--font-sans` / `--md-font-family` 均为**系统字体栈**（Segoe UI / PingFang / Microsoft YaHei）；**无 @font-face、无 woff2 资产**（public/assets 扫描零字体文件）。
- `document.fonts.ready` 仅在 fontStoreCatalog（用户自选字体）等待。
- 正面：无 webfont 阻塞文本渲染；负面：无自托管可变字体优化需求，可记正面免检。

## 5. 滚动容器合成策略要点

| 容器 | CSS | 合成备注 |
| ---- | ---- | -------- |
| Chat 消息列表 | 唯一 overflow-y auto + overflow-anchor none | 虚拟化正确；无 overscroll-behavior contain（可选） |
| Sidebar 会话列表 | 窗口化 + contain strict 行 | will-change 常驻层膨胀 |
| Diff 列表 | 多层 overflow-y auto（DiffCard 23/183/203…） | 多滚动嵌套；行虚拟化经 useVirtualScroll |
| Terminal | xterm + overscroll contain | 02 已覆盖 WebGL；本向关注 CSS scroll |
| Streaming 表 | 双轴 auto + contain layout paint | 嵌套滚动 + sticky thead |

## 6. 交叉引用锚点

- 01 H1/H2（每帧全文切分）→ 本向 W 补充：切分后 DOM 动画 will-change 加重流式帧成本。
- 01 L1（增量代码高亮器死代码）→ 本向确认 worker `highlight.stream` 仍闲置。
- 02 X1（隐藏终端全存活）→ 终端 CSS 滚动侧本向不重复。
- 07 A1（catalog 体积）→ 字体面无问题；bundle 内 hljs 语言集属 11 资产向。
