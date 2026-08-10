# Review：P3 执行方案评审（方向一打磨·轮 1 总方案）

- 审查对象：`docs/analysis/plan-P3-执行方案.md`（主审，85 行）
- 支撑文档：`plan-A1-scrollfactor.md` / `plan-A2-显示层补全.md` / `plan-A3-选区保护.md` / `plan-A4-表格流式.md` / `plan-A5-渲染分层.md` / `plan-A6-基准固化.md`
- 引擎代码抽查（白箱核验批次任务与真实代码的匹配度）：
  - `src/components/MarkdownEngine.tsx`（canDirect :680-688、streamAppend :660-708、flushStreamInternal :630-640、dirtyRefs :622-624、isPlainTextLine :107-115、isRowInVisibleViewport :649、resolveScrollLine :772-775、点击映射 :1157、批量测量 effect :956-1008、useVirtualizer :578-614、LineItem :166-306、readOnly 分支 :1492-1520、滚动 flush :903-925）
  - `src/core/scrollMap.ts`（不存在——B1 新建，与计划一致）
  - `src/core/TableStore.ts`（setColumnWidth :32-43 / setTableWidths :44-50，与 A6 引用吻合）
  - `src/core/metrics.ts`（1-226，五类计数，无跳动/选区/重建/定型/帧相位五组——与 A6 缺口分析吻合）
  - `src/core/parser.ts`（表格行独立判定 :2128-2140，pipeCount≥2 或行首| 即 table_row，无上下文——A4 核对点成立）
  - `src/core/EditorStore.ts`（moveHead 钳制 :1889、shiftGE :2438、选区平移 :2486-2491、shiftAnchorToCursor :2179）
  - `src/core/measure.ts`（:467-470/:475-482/:608/:657-661/:855/:864-865 与 A1 引用吻合）
  - `src/components/HiddenInput.tsx`（:216/:245/:248/:269-270/:322/:732/:742-744/:1003-1008/:1614 与 A1 引用吻合）、`SelectionHighlight.tsx:143`、`OutlinePanel.tsx:163`
  - `src/components/FindReplacePanel.tsx`（document capture keydown :277 先于容器 capture flush——A3 竞态成立）
  - `playwright.config.ts:4-8`（`<<<<<<< Updated upstream` 冲突标记实测仍在，且为 TS 语法错误，配置加载即崩——A6 发现属实）
  - `node_modules/@tanstack/react-virtual@3.14.9`（esm index.js 全文核对：applyContainerSize :26-35、applyDirectStyles :36-57、containerRef :90-101、layout effects :104-113、useVirtualizer 默认覆盖点 :116-122）与 `virtual-core`（observeElementOffset :118-121、elementScroll :144-163、getScrollOffset :530、getTotalSize :1055）
  - `src/index.css`（.editor-container :127、.editor-scroll-container :468-470，无 virtual-row 规则、无 transform/will-change——A1/A5 核对成立）
  - `tests/perf/`（四脚本 + 三数据产物原样在场，无 suite/ 目录——B6 新建）、`tests/e2e`、主仓库 `tests/e2e` 5 个 markdown-editor 专项 spec（实测在场）
- 审查方式：纯只读静态审查，未改动任何源码，不 commit
- 审查日期：2026-08-10
- 审查人：总调度派发的评审 Agent（轮 1 P3 方案评审）

---

## 总体结论：**需修订**（1 阻断 + 4 一般 + 7 轻微；含 2 个 B1 技术缺陷，无架构级否决项）

批次划分整体成立：B1-B6 覆盖 A1-A6 全部推荐方案，无遗漏推荐项；代码抽查与批次描述逐点吻合（A1 的消费方清单 13 处读侧/3 处写侧、A3 的直刷路径与钳制点、A5 的 transform 绝对值写、A6 的 playwright 冲突标记，全部实测属实）；波 1（B1+B4+B6）文件域互斥成立。

需修订集中于四点：

1. **【阻断】波 2 三批次（B2/B3/B5）全部触及 `MarkdownEngine.tsx`，且计划未声明波内串行顺序**——B2 的 LineItem 就定义在该文件内（:166-306），与 B5 的 rowStyle/virtualizer 改动在**同一组件内**重叠；B3 的 shouldDirectStream 在 streamAppend 区。波内并行子 Agent 执行必冲突（见维度 2）。
2. **【一般·高危】B1「不再传 virtualizer.containerRef」会禁用行定位**——react-virtual esm `applyDirectStyles` 首行 `if (!state.enabled || !state.container) return`（index.js:38），container 为 null 时行位置完全不写，虚拟滚动整体失效（见维度 3-B1-②）。
3. **【一般·高危】B1 scrollMap 数学缺「文末场景」分支**——1:1 区上界 `v+vh+m` 未钳制，视口在文末（流式跟随时常态）时压缩段为空、s 分母 ≤0，端点对齐 f(H)=MAX 与 C 守恒冲突，拖到底出现视口空白（见维度 3-B1-①）。
4. **【一般】B5/B4 方案层细节未钉死**：B5 验收 P95<16.6ms 未分档（headless 不可达）；B4 的「分隔行到达 → 通知前 N 行升级」未指明信号载体；B2「零 DOM 节点变化」口径需修正为行级（见维度 3/5）。

---

## 维度 1：批次完整性

### 1.1 六份分析推荐方案 → 批次覆盖核对

| 分析 | 推荐方案 | 计划落点 | 覆盖 |
|---|---|---|---|
| A1 | 方案 B 分段映射（scrollMap.ts 新建 + tanstack 3 接线 + 阈值 30M + 红线 + E1-E8） | B1 | ✓ 全要素在场；E1-E8 八条以描述形式涵盖（E4 截图 diff、E5 帧率对照、E6 thumb 单调均有） |
| A2 | 方案 B 样式预演（decorateIncompleteInline + LineItem 消费 + 闭合 class 切换 + $ 等宽 + 0 KaTeX） | B2 | ✓ 全要素在场 |
| A3 | 方案 D（B 选区感知直刷 + A flush 后钳制兜底）+ 顺带修复替换 Enter 末行分支 | B3 | ✓ 判定/兜底/顺带修复三项在场 |
| A4 | 候选态预分类（B）+ 估算/闭合定型（C）组合 | B4 | ✓ 全要素在场 |
| A5 | GPU 层 B(transform)+C(contain:paint)+D(dirty 独立层)，A 激进档默认关；Canvas 只留接缝 | B5 | ✓ 组合与接缝在场 |
| A6 | M1-M6 六组指标 + tests/perf/suite/ + 三档 + 防抖 + 顺带 playwright.config.ts | B6 | ✓ 全要素在场 |

**结论：六份分析的推荐方案全部落入批次，无遗漏推荐项、无该纳入未纳入的登记项主体**（B3 落地 = A6 §4.2「选区跨直刷行纳入 canDirect 禁入条件」的同一件事，已闭环）。

### 1.2 登记项与遗留项去向核对（发现缺口）

| 分析 | 登记/遗留项 | 是否进入 P3 §5 变更登记 |
|---|---|---|
| A1 §八.5 | B2 动态视口锚定增强（消除压缩段快翻）、C 自绘滚动条远期替换、s<1/8 手感警告 | **✗ 三项均未登记**（P3 B1 只写了红线） |
| A2 §2 | 方案 C（复杂形态 `***` 混合）登记 | **✗ 未登记** |
| A3 §6 | ① 替换 Enter 竞态非末行分支（建议宿主替换前显式 flushStream）② readOnly pending 复制漏字（既有宿主协议边界） | **✗ 两项均未登记去向** |
| A5 §4 | ① ArrowLeft getText 全量 join（R6 遗留 #2）② materializeViews 仍在 set 热路径 | **✗ 未登记**（与 B6 的 ArrowLeft 相对阈值 +20% 联动，登记价值高） |
| A6 §6 | playwright.config.ts 冲突标记 | ✓ B6 顺带修复 |

**结论**：推荐方案零遗漏，但登记项/遗留项共 8 条去向未声明——「盘点 → 方案 → 执行 → 登记」追踪链在登记环节断裂，需在修订时补入 P3 §5（详见修订 R7）。

---

## 维度 2：文件域冲突

### 2.1 波次编排核对（MarkdownEngine.tsx 是冲突焦点）

| 波次 | 批次 | 触及文件 | 波内冲突 |
|---|---|---|---|
| 波 1 | B1 | MarkdownEngine.tsx（滚动域：:649/:772/:1157/:578-614/:956-1008/:1424）+ 新建 scrollMap.ts | 无（B4/B6 均不碰 MarkdownEngine.tsx） |
| 波 1 | B4 | parser.ts 或渲染层 + TableStore.ts + BlockRenderer.tsx | 无 |
| 波 1 | B6 | tests/perf/suite/（新建）+ metrics.ts + playwright.config.ts | 无 |
| 波 2 | B2 | **MarkdownEngine.tsx（LineItem :166-306）** + BlockRenderer/InlineRenderer + 新建 decorateIncompleteInline | **与 B3/B5 同文件** |
| 波 2 | B3 | **MarkdownEngine.tsx（streamAppend/canDirect :660-708、flushStreamInternal :630-640）** + HiddenInput（待确认） | **与 B2/B5 同文件** |
| 波 2 | B5 | **MarkdownEngine.tsx（virtualizer :578-614 + LineItem rowStyle :282-306）** + index.css | **与 B2/B3 同文件** |

- **波 1 互斥成立** ✓：B1 独占 MarkdownEngine 滚动域，B4/B6 为独立文件域。
- **波 2 三批次同文件同组件**：B2 与 B5 都在 LineItem 内改动（B2 加预演消费 props/渲染分支，B5 改 rowStyle/transform/独立层条件属性），B3 在 streamAppend 区——三个改动面在同一 1500 行文件内且 B2/B5 在**同一组件函数体内**。计划 §2 依赖图只声明了「B2 与 B5 同域——串行」，但 §3 执行布局仍把三批放进同一波，未声明波内串行顺序。按 AGENTS.md「同文件串行」规则，若波 2 并行派发三个子 Agent，冲突无法靠「声明互斥区域」消解（LineItem 是单一组件，区域不可切割）。
- **修订方向**：波 2 内部显式串行（如 B3 → B5 → B2），或波 2 三批次合并为一个执行单元串行完成；并在波 2 标注「同文件三批，任何一批完成需提交后下一批再动」。

### 2.2 B3 文件域声明失准

- B3 声明「MarkdownEngine.tsx streamAppend + HiddenInput」，但 A3 机制的全部改动点都在 MarkdownEngine（shouldDirectStream 进 canDirect、兜底钳制进 flush 提交路径）——A3 方案中 **HiddenInput 无必须改动点**（判定只读 store 选区/光标，钳制在引擎侧）。若 HiddenInput 确有改动（如光标在末行行中判定的辅助），应在任务书中写明；否则应从文件域声明中移除，缩小与 B1（HiddenInput 读侧换算 :269/:322/:732/:1614 也在改！）的交叉面——**B1 与 B3 都会碰 HiddenInput.tsx，跨波串行可解，但需声明**。

### 2.3 B6 顺带改 playwright.config.ts 的合理性

- **合理且必要**：实测 `playwright.config.ts:4-8` 的 `<<<<<<< Updated upstream / ======= / >>>>>>> Stashed changes` 标记仍在，属 **TS 语法错误**——任何 Playwright 加载配置即崩，并非 A6 说的「行为不确定」而是硬故障。且 B1 的 e2e（120 万行场景）、B2/B4 的 e2e 全部依赖 Playwright 可跑——**B6 基建（波 1）必须先于波 2/3 的 e2e 修复该文件，依赖链正确**。
- 注意点：修复需确认 5173 vs 5174 哪个与 dev server 实际端口一致（suite/lib 提取 spawnDevServer 时统一端口口径，避免再岔）。

---

## 维度 3：技术可行性

### 3.1 B1 scrollMap 分段映射数学

**结论：主体推导成立（实测复核），但有 1 个分支缺失 + 1 个接线缺陷，必须修订后执行。**

- **成立的部分**：
  - 「f(0)=0 与 1:1 区起点锚定强制上方恒等」的推导（A1 §3.1）正确——f 单调、f(a)=a、f(0)=0 联立确实推出 [0,a] 恒等；
  - 锚点不变式 f(v)=v+C=P、滚动中 C 守恒、H 变化只重算 s——自洽；
  - f⁻¹ 闭式 ≤3 分支 O(1) 反解、无二分循环——成立；
  - 端点对齐 f(0)=0 / f(H)=MAX、s=(MAX−b)/(H−b) 自适应——中部分段成立。

- **【缺陷 1】文末视口分支缺失（数学）**：1:1 区 = [v−m, v+vh+m]，当视口在文末（流式跟随时用户常驻尾部，正是本方案主场景）且 b = v+vh+m+C ≥ H 时，压缩段为空、s 分母 ≤0 无定义。此时若退化为 f(y)=y+C，则 f(H)=H+C≠MAX，端点对齐破坏 → 物理 maxScrollTop = MAX−vh，f⁻¹ 返回超出文档的逻辑坐标 → 视口底部出现空白/内容错位（拖到底 ≠ 文末，正是方案要消灭的症状）。
  - **修订**：1:1 区上界钳制为 min(v+vh+m, H−m)，压缩段保留最小长度 m>0——端点对齐恢复（f(H)=MAX 恒成立），且启用条件 H>30M≫vh+2m 保证钳制不吞视口。此钳制需进 scroll-map 单测（用例：视口在文末 + 流式越过阈值切换 + 拖到底）。
  - 另注意：启用瞬间 C=0、H≈MAX+ε，文末场景 f(H)−MAX 偏差为 ε（流式超出量）——钳制后此偏差归零。

- **【缺陷 2】containerRef 解耦破坏行定位（接线）**：A1 §3.2 建议「不再传 virtualizer.containerRef（内容 div 高度不参与窗口计算，解耦安全）」——观察正确（窗口计算只读 getScrollOffset + itemSizeCache，virtual-core :530/:1055，与容器高度无关），但实现方向错误：react-virtual esm index.js:38 的 `applyDirectStyles` 首行 `if (!state.enabled || !state.container) return`——**container 为 null 时行位置（style.top/transform）完全不被写入**，虚拟滚动整体失效。
  - **修订**：保留 `ref={virtualizer.containerRef}`（行定位通道不动），引擎在批量测量 effect（MarkdownEngine.tsx:956-1008，声明序在 tanstack 的 hook layout effects 之后）同帧覆盖 `contentEl.style.height = f(H) + 'px'`——tanstack 先写逻辑高、引擎后写物理高，同一提交内 layout effect 阶段完成、paint 前收敛，无闪烁；直刷/流式帧零额外开销（H 不变时跳过）。

### 3.2 B1 tanstack 接线可行性（3.14.9 API 核对）

- `useVirtualizer` 的 `observeElementOffset`/`scrollToFn` 为 PartialKeys，options 后置展开可覆盖默认（react-virtual esm index.js:116-122）✓；
- 默认 observer 读 `el.scrollTop`（virtual-core :118-121）、默认 elementScroll 写 `el.scrollTo({top: offset + adjustments})`（:144-163）——自定义 observer/scrollToFn 包一层物理↔逻辑换算可行 ✓；
- 注意：自定义 scrollToFn 必须保留 `adjustments` 参数语义（scrollWithAdjustments 契约，virtualizer 内部滚动补偿用）；
- 内容 div 高度接管后 scrollHeight 读数 = 物理上限（f(H)+padding+marginTop），A1 §3.4「读 scrollHeight 钳制点零改动」的语义自洽 ✓（实测 HiddenInput :216/:245/:1003、measure :864 均为物理钳制语义）。

### 3.3 B2 预演 class 与 LineItem memo/装饰层交互

- LineItem 是 React.memo（MarkdownEngine.tsx:166），props 含 lineText——流式末行每 chunk lineText 变化本就重渲染（`**text` 行非纯文本、不直刷、走常规 append 路径，streamingDirty=false 不进 frozen 冻结渲染）→ 预演 class 在渲染体内由 `decorateIncompleteInline(lineText, isStreamingTail)` 派生，**不新增 props（除 isStreamingTail 布尔，每新行变化一次）→ 不破坏 memo 语义** ✓；
- 冻结路径无冲突：dirty 行（直刷纯文本行）不含 `**` 等标记，无需预演 ✓；
- **口径修正**：闭合切换时 row div（key=index）节点身份不变（oldEl===newEl，M4 ✓），但**内部 token 结构会变**（text 节点 + preview class → bold span + syntax-hidden）——A2「零 DOM 节点变化」在行级成立、token 级不成立。验收断言应表述为「行节点身份不变（M4）+ 视觉样式一致（像素级）」而非字面零 DOM 变化（若实现上预演用 span 包裹子范围，DOM 变化在流式期间就存在，闭合只换 class——这是可接受的，但与 A2 表述有出入）。
- **isStreamingTail 信号来源需明确**：dirtyRefs 只覆盖直刷行，`**text` 预演行不在 dirty 集——建议用 store.streamOp/streamTail 派生（EditorStore :2179 的 cursorInLastLine 判定同源思路），任务书需钉死。
- 测量零影响成立：预演只加 class/样式，不产生 data-token 映射变化、不改变 offsetHeight ✓。

### 3.4 B4 候选态确认/回退驱动（上下文传播机制）

- parser 行独立判定已实测确认（parser.ts:2128-2140，pipeCount≥2 或行首| 即 table_row，无上下文）→ A4 §1 的核对点成立：流式首行已判 table_row，「候选态」= 同一类型上的视觉候选 class，无类型跳变 ✓；
- **机制缺口**：行渲染自底向上、每行独立，前 N 行**无法感知其后新到的分隔行**——「分隔行到达 → 通知前 N 行升级」需要一个显式信号，A4/P3 均未指定载体与放置层（B4 写「parser 或渲染层候选判定」二义性）。建议钉死：引擎维护候选行集合 + 升级版本信号，仿 R6-C 行版本 bump 模式——分隔行/空行 append 时 bump 前 N 连续 pipe 行的行版本 → LineItem 重渲染 → 候选 class→正式 class（或回退 body）。升级必须只改 class，行节点身份不变（保 M4）；
- 与 TableStore 定型时机（每行更新 → 闭合一次）无冲突 ✓（TableStore.ts:32-50 现状为逐行 setColumnWidth，改造为闭合时 setTableWidths 一次——现状 API 已支持，工作量可控）。

### 3.5 B5 transform 绝对定位与 directDomUpdates 共存

- 实测核对：tanstack 3.14.9 `directDomUpdatesMode: 'transform'` 写 `el.style.transform = translate3d(0, ${item.start − scrollMargin}px, 0)`（**绝对值**，react-virtual esm index.js:51-52）；R2-D 现状是 `'position'` 写 style.top（index.js:54 + MarkdownEngine.tsx:612）——A5「绝对值写」描述准确 ✓；
- lastPositions WeakMap 去重（index.js:49）、range/isScrolling 不变零提交（:64-76）——A5 §1.2-1 依据成立 ✓；
- position-exclusive 契约成立（LineItem 不读 virtualRow.start、不写主轴，MarkdownEngine.tsx:159-165）——review-02 缺陷 B（top+translateY 双写）被双重排除 ✓；
- **取整点需钉死**：transform 值 = item.start（前缀和，oracle 预测未回填时可能小数）→ 取整应在 estimateSize 返回值（HeightMap 实测整数 / oracle.predict 输出 Math.round），B5 需显式引用 A5 防跳动清单（取整、禁 top+translateY 双写、禁 contain:size、stacking context/z-index 覆盖核对）；
- B5 与 B1 交互兼容：行 top 保持逻辑绝对、滚动读物理、内容 div 高物理——B1 后 transform 仍写逻辑 start，视觉位移 = 逻辑 − 物理 P，正确 ✓。

---

## 维度 4：跳动风险可测性

| 断言 | 采集方法 | CI headless 可行性 | 结论/建议 |
|---|---|---|---|
| B1 阈值切换截图 diff 零跳动（A1 E4） | Playwright 截图 + pixelmatch | 可行 | 需固定 pixelmatch 阈值与字体一致性（同机同字体）；ci 档可跑 |
| B1 视口 1:1 零偏差（E3） | 程序化滚动 100px → 首行位移 ±1px | 可行（确定性断言） | ✓ 无风险 |
| B1 拖到底=文末（E2） | scrollTop=max 时首行可见 | 可行 | ✓ 无风险 |
| B1 200 万行帧率对照 R6 21.8ms（E5） | rAF 帧间隔 | 可行但 headless 软件渲染有惩罚 | ci 档只做「相对不劣化」（A6 §5.2 已有 +15% 口径）；达标断言移 nightly GPU |
| B1 thumb 单调无回弹（E6） | page.mouse 拖 thumb | **headless 不可行**（默认 overlay 滚动条宽 0，无可拖 thumb） | 移 nightly GPU 档；ci 用程序化滚动采样 scrollTop 单调替代 |
| M2a 帧间位移突变（B6 探针，波 3 全量验证） | 页面内 rAF ramp 探针 | 可行但有误报风险 | 0 容忍 jumpCount=0 在丢帧/负载抖动下会误报（双峰分布 120/240，median 120，240 判跳实为掉帧）；判定主指标建议改为 anchorDelta vs actualDelta 的**相对脱节**（内容与滚动条不一致 = 跳动定义本体），绝对突变/freeze 序列作报告项——既抗 headless 抖动又贴合 A6 自己的「内容停顿后补偿性突进」定义 |
| M4 补全闪烁（oldEl===newEl） | evaluate 内同步快照 + MutationObserver | 可行（确定性，无帧时序依赖） | ✓ |
| M3 选区丢失（0 容忍） | 页面探针 / 引擎登记点 | 可行 | ✓ |
| M2c 直刷期间滚动 0 | M2a 探针叠加场景 D2 | 同 M2a 误报风险 | 同上修订 |

**结论**：M3/M4 类确定性断言 headless 可测；M2a/M2c 的 0 容忍需要判定口径修订（相对脱节主指标）；E6 thumb 拖拽必须分档。整体「跳动 0 容忍」在 CI 是可达的，但需按上表分档与改口径。

---

## 维度 5：验收可测性

| 批次 | 验收项 | 可测性 | 结论/建议 |
|---|---|---|---|
| B1 | 编译 0 错误 + test:gate 全绿 + 编码干净 | 可测（test:gate = vitest run tests/gate tests/unit，package.json 实测存在）✓ | 需补引用 A1 §6.2 八条 e2e 全量 |
| B1 | 120 万行滚动全场景无跳动（M2a 0） | 依赖 B6 探针——波 1 基建 → 波 3 全量验证，依赖链成立 ✓ | 结合维度 4 的 M2a 口径修订 |
| B2 | M4（存量行重建 0）+ 各形态预演 | 可测（vitest jsdom + e2e class 断言 + oldEl===newEl）✓ | 验收口径改「行节点身份 + 像素一致」（见 3.3） |
| B3 | M3（选区丢失 0）| 可测 ✓ | 引擎登记点（metrics.recordSelectionLost）与探针双通道已在 A6 |
| B4 | M6（定型 ≤2 次）+ 500tps P95 <16.6ms | 可测，但 **M6「≤2」是设计推定值，与 B6 的「首次采集定档」口径冲突** | B4 验收应引用「首采定档值（设计目标 ≤2）」而非预设断言；500tps P95 达标断言需 nightly GPU |
| B5 | 滚动最坏 P95 <16.6ms + Layout 归零 + Canvas 接缝 | Layout 归零可测（CDP counters）；**P95<16.6ms headless 不可达**（A5 §5.3 诚实边界） | 验收分档：ci=相对不劣化 + Layout 归零；nightly=达标断言。Canvas 接缝存在性 = 类型检查 + 单测断言 ✓ |
| B6 | 基准套件可跑 + 首跑定档 | 可测 ✓ | **首跑定档的诚实标注已在 A6 三处明确**（§2.6/§5.2/§6：首跑快照入库、回写 budgets 附理由、禁止静默放宽）✓——P3 层面建议引用该定档协议，避免「首跑定档」被理解为「随意放行」 |

**结论**：各批验收均可量化；三个修正点：B4 引用首采定档、B5 分档、P3 引用 A6 定档协议。

---

## 维度 6：补充建议

1. **A3 两项遗留的处置建议**（A3 §6 已给出方向，P3 未落地）：
   - 替换 Enter 竞态非末行分支：引擎侧无法一行解决（FindReplacePanel 的 document capture keydown :277 先于容器 capture flush :886-889，实测属实）——按 A3 建议登记为「宿主协议：替换前显式 flushStream()」或后续轮次；**建议登记进 P3 §5**（不纳入本轮）；
   - readOnly pending 复制漏字：既有宿主协议边界（复制前 flushStream，MarkdownEngine.tsx:876-881 注释口径）——登记即可，不纳入本轮。
2. **A1 三项登记 + A2 方案 C + A5 两项 CPU 遗留**应补入 P3 §5（压缩段快翻/自绘滚动条/s<1/8 警告、`***` 混合形态、ArrowLeft getText join 与 B6 相对阈值联动、materializeViews）——补登记成本为零，追踪链完整。
3. **未入库测试资产提示（不上报主 Agent 会漏）**：git status 显示 `tests/unit/_scratch-a2.test.ts`、`tests/unit/_scratch-table-stream.test.ts`、`vitest.probe.config.ts` 为未跟踪状态——按 AGENTS.md 铁律，实现阶段应立即 `git add` 提交；本轮评审不 commit，仅上报调度者。
4. 波 3 全量验证建议显式包含：主仓库 tests/e2e 5 个 markdown-editor 专项 spec（keyboard-navigation 覆盖写侧换算、wysiwyg-interaction 覆盖点击/光标——A1 §6.3 已提，P3 验收行未列全）。

---

## 修订建议清单（采纳 / 拒绝 / 修改）

| # | 级别 | 判定 | 对象 | 修订内容 |
|---|---|---|---|---|
| R1 | 阻断 | 修改 | §3 波 2 编排 | 波 2 三批次（B2/B3/B5）同文件 MarkdownEngine.tsx 且 B2/B5 同在 LineItem 组件内——声明波内串行顺序（建议 B3 → B5 → B2，每批完成提交后再动下一批），或合并为单一执行单元 |
| R2 | 一般·高危 | 修改 | B1 §3.2 接线 | 保留 `ref={virtualizer.containerRef}`（applyDirectStyles 依赖 state.container，不传则行定位失效）；内容 div 高度在批量测量 effect（:956-1008）同帧覆盖 `style.height=f(H)`，tanstack 先写逻辑高、引擎后写物理高，同提交 paint 前收敛 |
| R3 | 一般·高危 | 修改 | B1 scrollMap 数学 | 1:1 区上界钳制为 min(v+vh+m, H−m)，压缩段最小长度 m 恒存在——修复文末视口场景 s 分母 ≤0 与端点对齐冲突；单测补「视口在文末 + 流式越过阈值切换 + 拖到底」用例 |
| R4 | 一般 | 修改 | B5 验收与任务书 | 验收分档（ci=相对不劣化 + Layout 归零；nightly=滚动最坏 P95<16.6ms）；任务书显式引用 A5 防跳动清单（estimateSize 输出取整、禁 top+translateY 双写、禁 contain:size、z-index 层序核对） |
| R5 | 一般 | 修改 | B4 任务书 | 钉死候选判定落点（parser 或渲染层二选一）；指定「分隔行到达 → 前 N 行升级」信号载体（建议仿 R6-C 行版本 bump：候选行集合 + 版本信号，升级仅换 class 保 M4） |
| R6 | 一般 | 修改 | B2 验收口径 | 「零 DOM 节点变化」修正为「行节点身份不变（M4）+ 视觉样式一致」；isStreamingTail 信号来源钉死（建议 store.streamOp/streamTail 派生，dirtyRefs 不覆盖 `**text` 预演行） |
| R7 | 一般 | 修改 | §5 变更登记 | 补全 8 条登记/遗留：A1 三项（动态锚定/自绘滚动条/s<1/8 警告）、A2 方案 C、A3 两项遗留（替换竞态非末行分支 → 宿主 flushStream 协议；readOnly 复制漏字 → 既有边界）、A5 两项 CPU 遗留 |
| R8 | 一般 | 修改 | B6 任务书 | 引用 A6 定档协议（首跑快照入库、回写 budgets 附理由、禁止静默放宽）；M2a 判定主指标改为 anchorDelta vs actualDelta 相对脱节（防 headless 丢帧误报），绝对突变/freeze 序列作报告项 |
| R9 | 轻微 | 修改 | B1 测试 | E6（thumb 拖拽）与帧率达标断言移 nightly GPU 档；ci 用程序化滚动采样 scrollTop 单调替代；E1-E8 显式引用 A1 §6.2 |
| R10 | 轻微 | 修改 | B6 顺带项 | playwright.config.ts 修复时确认 5173/5174 与 dev server 实际端口口径一致（suite/lib 提取 spawnDevServer 时统一），避免修复引入新岔口 |
| R11 | 轻微 | 修改 | B3/B4 声明 | B3 文件域声明移除或明确 HiddenInput 改动点（A3 机制无需 HiddenInput 改动，且 HiddenInput 是 B1 读侧换算域——跨波串行需声明）；B4 落点二义性钉死 |
| R12 | — | 采纳 | 其余全部 | 批次覆盖完整性（B1-B6 ↔ A1-A6 无遗漏）、B3 顺带修复纳入、B6 顺带 playwright 修复（必要性已实测确认）、scroll/pointer 红线、Canvas 只留接缝、既存四脚本零改动、首跑定档诚实标注、readOnly 短路判定 |
| R13 | — | 拒绝 | — | 无整体否决项；A3 方案 C（冻结高亮）不采纳的结论维持；A1 方案 C（自绘滚动条）不纳入本轮维持（登记远期） |

---

## 评审回报摘要（给主 Agent）

- **结论**：**需修订**（1 阻断 + 4 一般 + 7 轻微，无架构级否决）。
- **阻断项**：波 2 三批次同文件（MarkdownEngine.tsx，B2/B5 同在 LineItem 组件内）未声明波内串行。
- **两个 B1 技术缺陷必须修订**：①「不再传 containerRef」会禁用 applyDirectStyles 行定位（react-virtual esm index.js:38 早退）——改为保留 containerRef + 批量测量 effect 同帧覆盖高度；② scrollMap 数学缺文末视口分支（1:1 区上界钳制 min(v+vh+m, H−m) 补丁）。
- **其余要点**：M2a 0 容忍判定改相对脱节口径防 headless 误报；B5 验收分档；B4 升级信号载体钉死；P3 §5 补 8 条登记；B6 首跑定档协议引用。
- 附报：`tests/unit/_scratch-a2.test.ts`、`_scratch-table-stream.test.ts`、`vitest.probe.config.ts` 未跟踪，按测试资产铁律应随实现提交（评审不 commit）。
