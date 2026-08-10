# A5 分析：CPU→GPU→Canvas 渲染分层策略（横切·方向一打磨轮 1）

> 纯分析文档，不实现。目标：明确当前渲染成本在 CPU/layout/paint/GPU 的归属；给出不动架构的 GPU 合成优化多方案对比与推荐；给 Canvas 只读层「预留接口设计」（架构接缝，非实现）；核对 CPU 层剩余优化空间；给出三层衔接顺序与可量化验收指标。
>
> 输入文档：round-R6-report.md / round-R2-report.md / 01-性能帧率路线.md / 06-扩展功能-技术维度.md / review-02-技术正确性.md / 09-方案修订终版.md
> 输入代码：MarkdownEngine.tsx / HeightMap.ts / BlockRenderer.tsx / InlineRenderer.tsx / renderTheme.ts / measure.ts / index.css / node_modules@tanstack react-virtual 3.14.9

## 0. 结论速览

- **现状层定位**：JS（CPU）已高度优化——R6 实测 500tps 全场景帧内 JS <4ms、滚动长任务 ~0；剩余预算大头是 **layout/paint**（01 预算表口径 layout+paint 3-5ms/帧，见 01-性能帧率路线.md:517；R6 滚动最坏 P95 21.8ms 未压线）。layout/paint 的主驱动不是滚动本身（原生滚动已是合成器 blit），而是**窗口变化/行高回填级联帧**的整视口重绘。
- **GPU 层推荐**：方案 **B（transform 绝对定位）为核心** + 方案 **C（行级 contain: paint）** + 方案 **D 微调（直刷 dirty 行独立层）**；方案 A（全员 will-change 提升）作为可选的激进档，默认关闭。改动面收敛在「一行配置 + 行级 style 两属性」，可整体回退。
- **Canvas 层**：本轮明确不实现。预留接口 = 在窗口渲染入口处抽象 `RowSurface`（DOM 实现 = 现 LineItem 通道），注册 `renderMode: 'dom' | 'canvas'` 开关 + 能力检测 + 行粒度 DOM 回退。触发条件 = `readOnly && 行数 > 阈值`（非默认）。
- **CPU 层**：行渲染/测量/解析三条路径核对完毕，均已缓存化/增量化，**无结构性剩余优化**；仅登记 2 项非渲染侧遗留（getText join、materializeViews）。
- **三层衔接**：CPU（已达成）→ GPU（本轮可做，独立可回退）→ Canvas（预留，与 GPU 层正交）。验收指标逐层量化见 §5.2。

## 1. 现状层定位

### 1.1 三层成本归属

| 层 | 归属 | 成本构成 | 现状证据 |
|---|---|---|---|
| **CPU（JS）** | 数据层（COW / 尾段零拷贝 / fence 前缀 O(1) / LineOffsetTree）、`parseLine` 行级缓存、React 协调（LineItem 行级 memo + 行级装饰版本）、光标测量（索引二分 + 缓存）、命令式位置写 | 帧内 <4ms（R6 实测口径） | MarkdownEngine.tsx:578-614；parser.ts:1630-1696；measure.ts:604-627；round-R6-report.md:10-18 |
| **Layout** | 行 `style.top` 写入（仅位置变化帧）、新行挂载布局、**行高回填级联**（一行高度修正 → 其后全部行位移） | 位移帧 O(窗口行数) 布局 + 样式重算 | react-virtual/dist/esm/index.js:41-54（position 模式写 style.top）；MarkdownEngine.tsx:996-1004（回填 + resizeItem） |
| **Paint** | 整视口文本重绘（行位移时旧/新区域并集 ≈ 视口）、新行文本光栅化 | 预算表最大单段 3-5ms | 01-性能帧率路线.md:517；R6 滚动 P95 21.8ms（round-R6-report.md:18） |
| **GPU（合成）** | 原生滚动 blit（滚动容器已层化）、transform 层位移 | 已零成本（滚动帧零写入零提交） | react-virtual/dist/esm/index.js:73-83（range/isScrolling 不变即跳过提交）；R6 长任务 ~0 |

### 1.2 关键机制事实（决定优化方向的代码级证据）

1. **滚动帧已是最优**：`directDomUpdates` + `directDomUpdatesMode: 'position'` 下，tanstack 对**已写过相同位置的行直接跳过写入**（`lastPositions` WeakMap 去重），且 range/isScrolling 不变时零 React 提交（react-virtual/dist/esm/index.js:46-49, 73-83）。原生滚动 = 合成器 blit，滚动帧内**没有任何 layout/paint 触发点**。
2. **位置写入只发生在两类帧**：① 窗口变化帧（新行挂载首写）；② **高度回填级联帧**——批量测量协议回填 HeightMap 后 `resizeItem` → 其后所有行 start 变化 → `style.top` 批量重写（MarkdownEngine.tsx:996-1004）。第 ② 类帧在「预测不准 + 快速滚动」叠加时产生**整视口重绘**，这就是 R6 滚动最坏 P95 21.8ms 的构成（round-R6-report.md:18 口径：layoutThrash -34% 后仍持平）。
3. **行位置是纯命令式通道**：LineItem 不读 `virtualRow.start`、不在 style 写主轴位置（MarkdownEngine.tsx:159-165 注释 + :282-291 rowStyle 只写 left/width/minHeight）——任何 React 重渲染都不会覆盖命令式位置。**这为「位置通道整体切换为 transform」提供契约前提**（无双写风险）。
4. **行高模型已精确**：HeightMap 块式前缀和，`getOffset`/`indexAt` 二分（HeightMap.ts:285-337），回填稳定点 0.5px 护栏（:17, :352）——Canvas 层定位与滚动换算的数据底座已就绪。
5. **全引擎等宽字体**（index.css:35-40, :146 `font-family: var(--font-mono)` + `white-space: pre-wrap`）——Canvas 字符纹理方案的字符定位与 oracle wrap 长度模型（HeightOracle perRow/step）在两种渲染面下**同口径**，是混合渲染可行性的关键前提。

## 2. GPU 合成层优化点（不动架构、多方案对比）

四个方案均不动渲染架构（虚拟化/行高模型/测量协议/装饰层全保留），只改「行位置通道」与「行盒 CSS 属性」。

### 2.1 方案 A：行容器 will-change: transform（窗口内行提升）

| 维度 | 内容 |
|---|---|
| **做法** | 行级 style 增加 `willChange: 'transform'`（或 `contain: 'paint'` 触发自动提升），把窗口内已挂载行（窗口 + overscan 40 ≈ 百行量级）提升为独立合成层 |
| **收益** | 行内容变化（直刷行逐 chunk 文本、装饰刷新）的重绘**局限在本行层纹理**，不再光栅化到滚动容器内容层；配合方案 B 时位置位移为纯合成 |
| **风险（跳动/内存）** | ① **层数受控但纹理内存非零**：~100 层 × (行宽×行高×dpr²) ≈ 9-36MB GPU 内存量级，可接受但需监控；② 层数=挂载行数，虚拟化天然保证「只提升窗口内行」——**不存在提升全文档百万行的层爆炸**；③ 亚像素：transform 值若非整数，合成器按 dpr 取整可能产生 1px 视觉抖动（详见 B 风险 ①） |
| **实现面** | LineItem rowStyle 加一属性。**一行改动**，但全员提升的收益需指标验证（若 paint 已由 C 隔离，A 的增量收益趋零） |
| **结论** | **默认不启**（激进档）。仅当指标显示「行内容重绘仍占 paint 大头」时开启；与 B 组合时收益最大，独立使用收益有限 |

### 2.2 方案 B：transform 绝对定位（替换 style.top 位置通道）——**核心推荐**

| 维度 | 内容 |
|---|---|
| **做法** | `directDomUpdatesMode: 'position'` → `'transform'`。tanstack 对每行写 `translate3d(0, ${start}px, 0)`（**绝对值**，非增量 delta，react-virtual/dist/esm/index.js:41-54） |
| **关键洞察** | 滚动帧本来就零写入（见 §1.2-1），**transform 的收益不在滚动**，而在**高度回填级联帧**：`style.top` 变化是布局属性 → 触发布局重算 + 旧/新区域并集 ≈ 整视口重绘；transform 变化是合成属性 → **跳过 layout**（绝对定位行 layout 本就 O(1) 独立，真正贵的是随之而来的 paint）。改 transform 后级联位移帧从「layout+paint」降为「合成器位移」，paint 只剩行自身内容变化的增量 |
| **为什么不会踩 review-02 缺陷 B** | 缺陷 B 的成因是「React 写绝对 top + 命令式增量 translateY 叠加」（review-02-技术正确性.md:59）。本方案：① tanstack 写的是**绝对值** transform；② LineItem 的 position-exclusive 契约保证 React 永不写 top（§1.2-3）——不存在任何双写叠加 |
| **风险清单** | ① **小数像素**：`start` 来自 HeightMap 前缀和，未回填的预测行（oracle 输出 `rows × 28 × 倍率 × correction` 可能非整数）会产生亚像素 transform → 合成取整抖动。**对策：transform 模式下位置取整**（oracle 预测输出 Math.round，或行高回填后全部整数——实测 offsetHeight 恒整数）；② **测量兼容**：`offsetHeight` 不受 transform 影响（行高测量协议不变）；`getBoundingClientRect` 含 transform（视觉坐标），measure.ts 的 viewportToContent 换算仍一致（measure.ts:464-483）；③ **stacking context**：transform 行形成独立层序上下文，需确认 CursorLayer/SelectionHighlight 以 z-index 覆盖行层（现为兄弟节点，挂载于 editor-container 下，视觉覆盖不受影响）；④ **containing block**：行内 absolute 元素（CopyButton 等）以行盒为包含块——现状行盒本就是 absolute（含 transform 后含 absolute 包含块语义等价）；⑤ **hit-test / caretRangeFromPoint / 原生 DOM 选区**均按视觉坐标工作，兼容 |
| **收益量化** | 高度回填级联帧：layout 段归零 + paint 段从「视口整幅」降为「内容增量」；滚动最坏 P95 目标 21.8ms → <16.6ms（60fps 压线）；500tps 帧 P95 预计 11.5-14.3ms → 主要受益窗口变化帧 |
| **实现面** | 一行配置 + 风险 ① 的取整点（oracle predict 输出取整）。**可一行回退** |
| **结论** | **推荐为 GPU 层核心**。改动最小、收益最大、风险有明确对策 |

### 2.3 方案 C：行级 contain: layout/paint（隔离行重绘）

| 维度 | 内容 |
|---|---|
| **做法** | 行级 style 增加 `contain: 'paint'`（或 `'layout paint'`） |
| **收益** | `contain: paint` 使行重绘不外溢（行盒裁剪），行内容变化（流式文本、搜索高亮底色、active 行样式）不使兄弟行像素失效；`contain: layout` 对绝对定位行布局收益≈0（行布局本就独立），但可防止行内极端内容撑破行盒影响容器度量 |
| **风险** | **禁止 `contain: size`**——size containment 使行盒尺寸脱离内容，直接破坏行高测量协议（MarkdownEngine.tsx:996 读 `offsetHeight`）与 oracle 校准；`contain: paint` 在部分引擎触发自动层化（与 A 部分重合，注意纹理内存口径） |
| **实现面** | LineItem rowStyle 加一属性 |
| **结论** | **推荐作为 B 的配套**：paint 隔离让「行自身内容重绘」也局部化；与 B 组合后 paint 只剩内容增量，无整幅重绘 |

### 2.4 方案 D：合成层分组（稳定行 / pending 行分离）

| 维度 | 内容 |
|---|---|
| **做法** | 稳定行一组、流式直刷（dirty）行独立层：`streamingDirty` 为 true 时行加 `willChange: 'transform'`（MarkdownEngine.tsx:203 已有 dirty 标记通道） |
| **收益** | 直刷行逐 chunk `textContent +=` 触发本行重绘（C3 直刷协议，MarkdownEngine.tsx:693）——独立层使该重绘**不触内容层/兄弟行**，流式与滚动/编辑并发时互不污染；同时最多 1 行（dirtyRefs 恒 ≤1 元素，:622-624），**成本≈零** |
| **风险** | 无实质风险（单行、短生命周期、flush 后清除） |
| **实现面** | LineItem 的 dirty 分支加条件属性（已有 `data-streaming-dirty` 标记位可复用） |
| **结论** | **推荐采纳（微调档）**。比「稳定行全体分组」更精准——稳定行分组在非重叠绝对定位行下的增量收益有限（浏览器局部重绘已隔离），不值得为此引入分组结构 |

### 2.5 方案对比总表

| 方案 | 收益 | 风险 | 实现面 | 采纳 |
|---|---|---|---|---|
| A 全员 will-change | 行内容重绘局部化（与 C 重合） | 内存 ~9-36MB / 亚像素 | 1 属性 | **激进档（默认关）** |
| B transform 定位 | 级联位移帧 layout 归零 + paint 降为内容增量 | 亚像素取整 / stacking context（有对策） | 1 行配置 + 取整点 | **核心（开）** |
| C contain: paint | 行重绘不外溢，内容变化局部化 | contain: size 禁用（护栏） | 1 属性 | **配套（开）** |
| D dirty 行独立层 | 直刷行重绘零污染，成本≈0 | 无 | 条件属性 | **微调（开）** |

**推荐组合 = B + C + D（A 默认关）**。三者互不冲突，改动收敛在：`directDomUpdatesMode` 一行 + LineItem rowStyle 两属性 + oracle 输出取整；全部可一行回退。**防跳动要点**：transform 值取整（整数像素）、与现有 top 定位视觉等价（同像素值，无跳变窗口）、不停顿任何既有渲染契约。

## 3. Canvas 只读层（预留接口设计——本轮不实现）

### 3.1 定位重申（承接 06 §6 与 09:83 既有结论）

- **触发条件**：`readOnly === true && 行数 > 阈值`（阈值建议 ≥5 万行，或 行数 × 平均行高 > 视口高 × 100——可配置常量）；**非默认**，编辑器模式永不启用。
- **混合渲染按行粒度**（此前「混合渲染」结论的深化）：**纯文本行 → Canvas 纹理**（离屏行 canvas + fillText，滚动 = blit）；**复杂行（math/table 强样式/含交互 token 行）→ DOM 覆盖层**。判定粒度 = 行（用 `classifyLine` + 行内 token 扫描，复杂度 O(行)，与 HeightOracle 同源）。
- **与 HeightMap 衔接（已就绪）**：Canvas 行定位 = `heightMap.getOffset(i)`（HeightMap.ts:290 前缀和 O(1) 块内读）；滚动换算复用 `indexAt`（:310）；行高来源 = oracle 预测 + DOM 模式历史样本。**注意代价**：canvas 模式下无 DOM 可实测 → 无测量回环。对策：会话切换时**沿用 DOM 模式的 EMA 校准样本**（oracle.correction 保留），另可留 1-2 行隐藏 DOM 探针行维持校准（不新增测量协议）。
- **能力检测 + DOM 回退（普适性，承接此前结论）**：`canvas.getContext('2d')` 失败 / 字体未就绪 / 行含不支持类型 → **行粒度回退**（该行走 DOM 覆盖层，其余行仍 canvas）——混合渲染使回退粒度天然是「行」，不是全文档二值开关。
- **交互损失清单（此前评估的代价，本轮明确边界）**：原生 DOM 选区/复制（readOnly 现复用浏览器默认通道，MarkdownEngine.tsx:1094-1106）在 canvas 上行不通 → 需自绘选区矩形 + 几何命中（矩形→行内偏移）；点击命中需自行实现（现走 `caretRangeFromPoint`/data-* 上溯，:1195-1311，全 DOM 依赖）。因此 Canvas 层**只服务纯阅读**（滚动 + 视口稳定），不做编辑交互。

### 3.2 预留接口设计（架构接缝：渲染器注册位）

复用 **BlockRendererRegistry 同构的注册表模式**（BlockRenderer.tsx:143-187 先例），在窗口渲染入口（MarkdownEngine.tsx:1439 的 `virtualizer.getVirtualItems().map(...)`）处抽象行表面：

```
// 预留签名（本轮只设计不实现，不落代码）
type RenderMode = 'dom' | 'canvas';              // 引擎 prop，缺省 'dom'
interface RowSurface {
  mode: RenderMode;
  mountRows(items: VirtualItem[]): void;          // 窗口变化：挂载行
  updateRows(changed: number[]): void;            // 行内容/装饰变化（dirty/版本 bump）
  unmountRows(indices: number[]): void;           // 行离开窗口
  locateRow(pixelY: number): number | null;       // 像素→行（走 HeightMap.indexAt）
}
// 注册位（与 BlockRendererRegistry 同款语义）：
registerRowSurface(mode: 'canvas', factory: (container) => RowSurface);
// 能力检测：factory 内自检 getContext/字体就绪，失败返回 null → 引擎回落 DOM
```

要点：
1. **DOM 实现 = 现 LineItem 通道原样封装**（mount/update/unmount 三方法对应现有渲染/装饰/卸载三处调用点），抽象只加接缝不改行为；
2. **Canvas 实现**：离屏行纹理 canvas 缓存（key = 行号+行版本），`fillText` 绘制（等宽字体全引擎同口径，§1.2-5），滚动帧只 blit 纹理不重绘；纹理缓存受窗口约束随卸载释放（复用虚拟化窗口语义）；
3. **renderMode 判定**：引擎读 `readOnly + 行数阈值 + 注册表存在` 三者与运算，任一不满足走 DOM——**普适性由 DOM 回退兜底**；
4. **不实现的明确清单**：Canvas 层选区/复制、Canvas 层编辑、离屏 worker 光栅化、跨行复杂块的 canvas 化——全部列为后续轮次（若 Canvas 层立项）。

## 4. CPU 层剩余优化核对

| 路径 | 核对结论 | 证据 |
|---|---|---|
| **行渲染开销** | 已到位：LineItem/BlockRenderer/InlineRenderer 三级 memo；KaTeX LRU 500（renderTheme.ts:136-179）；parseLine astCache 含上下文键（parser.ts:1630-1696）；装饰消费降为行级版本（R6-C）。剩余仅为「新行挂载时的 token map + JSX 构建」常数成本，无结构性空间 | MarkdownEngine.tsx:166-306；BlockRenderer.tsx:1040-1058 |
| **测量路径** | 已到位：token→textNode 二分索引 + MutationObserver 增量维护（measure.ts:109-270）；单例 Range + 同帧 posCache + token measCache（内容坐标系）+ 字体/字宽缓存（measure.ts:485-493, 604-627, 747-812）。无全扫、无逐帧 DOM 读 | measure.ts 全文核对 |
| **解析路径** | 已到位：行级缓存 + 编辑区间 computeEditSpan 前缀/后缀 diff（MarkdownEngine.tsx:400-436）+ fence 前缀 O(1) + 流式软渲染（未闭合围栏不跑高亮/KaTeX）+ 直刷通道（纯文本末行零解析） | parser.ts；MarkdownEngine.tsx:61-115, 660-708 |
| **登记遗留（非渲染侧）** | ① ArrowLeft `getText` 全量 join（round-R6-report.md:45 登记 #2，数据层）；② materializeViews 仍在 set 热路径（#4，append@1M 物化 3.6ms，store 侧惰性化可选）——均不影响本分层策略，按既有轮次节奏处理 | round-R6-report.md:44-50 |

**结论：CPU 层无剩余结构性优化**，符合「CPU（现状已优）」的用户预期；GPU 层是剩余预算（layout/paint）唯一有效作用面。

## 5. 三层策略总览

### 5.1 衔接顺序与依赖

```
L1 CPU/DOM（现状已优：帧内 JS <4ms）
   │  保持；无改动
L2 GPU 合成（本轮可做：B transform 定位 + C contain: paint + D dirty 行独立层）
   │  独立可启停（directDomUpdatesMode 一行回退）；不依赖 L3
L3 Canvas 只读层（预留接口：RowSurface 抽象 + renderMode 注册位）
   │  与 L2 正交——RowSurface 的 DOM 实现即「L2 之后的现 LineItem 通道」
   ▼
（后续轮次如立项 Canvas，L2 的 transform/contain 契约原样继承到 DOM 覆盖行）
```

依赖关系：L2 不需要 L3；L3 的 DOM 覆盖层自动继承 L2 的全部优化（同一行通道）；L3 的 Canvas 行定位依赖 HeightMap（已就绪，§1.2-4）。**三层的衔接是「接缝先行、逐层开关」，非重构级联**。

### 5.2 验收指标（每层收益可量化）

| 层 | 指标 | 现状基线（R6） | 目标 |
|---|---|---|---|
| L1 CPU | 帧内 JS 段耗时（DevTools Performance 分离 JS/Layout/Paint） | <4ms | 保持（不回归） |
| L2 GPU | 滚动最坏情形 P95（高度回填级联帧） | 21.8ms | <16.6ms（60fps 压线）；级联帧 Layout 段归零、Paint 段降为内容增量 |
| L2 GPU | 500tps 四场景 P95 | 11.5-14.3ms | ≤现状且 Layout/Paint 段占比下降 |
| L2 GPU | 层数 / GPU 内存（DevTools Layer 面板 + 任务管理器） | 0 显式层 | ~100 层、≤36MB（dpr2 上限口径）；A 档开启时复核 |
| L2 GPU | 防跳动：级联帧前后行像素坐标一致性（快照 diff） | — | 逐像素一致（transform 值取整后） |
| L3 Canvas | 接口存在性：`renderMode` prop + `registerRowSurface` 注册位编译通过；触发路径为占位（模式切换返回 DOM） | 无 | 类型检查 + 单测断言「canvas 模式未启用时行为零变化」 |

### 5.3 风险与回退

- **整体回退**：L2 全部改动收敛于 `directDomUpdatesMode` 一行 + LineItem 两属性，配置开关可原子回退；A 档独立于 B/C/D 开关。
- **防跳动清单**：① transform 值取整（oracle 输出 round）；② 禁止任何「top + translateY 增量」双写（review-02 缺陷 B 铁律，靠 LineItem position-exclusive 契约维持）；③ 不叠加 `contain: size`；④ 变更后跑 reference/markdown-editor 门禁（npm test）+ 键盘导航/IME 专项 spec（tests/e2e 5 个 markdown-editor spec 保留回归）。
- **诚实边界**：L2 收益的「滚动最坏 P95」需实测验证（headless 软件渲染有惩罚，真机口径为准，参照 round-R2-report.md:28 既有口径）。

## 6. 回报摘要

- **GPU 层推荐**：方案 **B（tanstack transform 绝对定位）为核心 + C（行级 contain: paint）+ D（直刷 dirty 行 will-change 独立层）**；方案 A（全员 will-change）列为默认关闭的激进档。理由：位置写入只发生在窗口变化/高度回填级联帧（滚动帧已零写入），transform 使级联位移跳过 layout、paint 降为内容增量；改动一行配置 + 行级两属性，可一行回退；review-02 缺陷 B（top+translateY 双写叠加）被「tanstack 绝对值 + position-exclusive 契约」双重排除。
- **Canvas 预留设计**：`renderMode: 'dom' | 'canvas'` + `RowSurface` 抽象（mount/update/unmount/locateRow 四方法）+ 注册位（复用 BlockRendererRegistry 模式）；触发 = readOnly && 行数阈值 && 注册表存在；混合渲染按行粒度（纯文本行 canvas 纹理 / 复杂行 DOM 覆盖）；行定位复用 HeightMap（已就绪）；能力检测失败行粒度回退 DOM。本轮不实现。
- **三层衔接顺序**：L1 CPU（现状已优，保持）→ L2 GPU（本轮可做、独立可回退）→ L3 Canvas（预留接缝，与 L2 正交，DOM 覆盖行自动继承 L2 优化）。验收：L2 滚动最坏 P95 <16.6ms + 级联帧 Layout 归零 + Paint 降为内容增量；L3 接口存在性 + 零行为变化。
