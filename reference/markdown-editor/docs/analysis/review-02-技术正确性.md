# 审查报告 02：技术正确性维度（方案审查 Agent 2）

> 审查对象（只读）：
> - `docs/analysis/01-性能帧率路线.md`（性能方案，重点）
> - `docs/analysis/02-解析器正确性.md`（正确性方案）
> - `docs/analysis/08-方案优化补充.md`（三招）
> - 对照代码：`src/core/SegmentTree.ts`、`src/core/EditorStore.ts`、`src/core/measure.ts`、`src/components/MarkdownEngine.tsx`、`src/core/parser.ts`、`src/core/StreamBuffer.ts`、`src/components/CursorLayer.tsx`、`src/components/HiddenInput.tsx`
> - 技术环境：`@tanstack/react-virtual` ^3.14.9
> - 日期：2026-08-09

---

## 零、总评摘要

**统计**：8 个审查维度中，**完全可行 0 项、需修正 7 项、基本可行（附强制边界条件）1 项**（维度 6）。子项级发现共约 17 处，其中**实质技术错误/缺陷 6 处**、方案级遗漏 8 处、表述/行号级小错 3 处。

两份方案的整体方向（行级状态化、COW、命令式渲染通道、失败记忆）均与代码现状吻合、可落地，但三个"地基级"方案（P1 行高回填、P6 命令式滚动、08 招 1 直刷）各自存在**未闭合的架构级冲突**，直接按文档实现会在合入时返工。

### 最严重的 3 个问题

| # | 问题 | 位置 | 严重度 |
|---|---|---|---|
| 1 | **P6 命令式位置更新与 tanstack 渲染通道的冲突未解**：①"滚动帧零 React 提交"要求不通知 observer，但 `getVirtualItems()` 的 `virtualRow.start` 将永远陈旧，所有消费方（点击 padding 映射 MarkdownEngine.tsx:145-154、行位置写入 :78）错位；②"每行 translateY 增量"与 React 写入的绝对 `style.top` 叠加会造成双倍位移，且窗口变化帧 React 重写 top 后 translateY 无复位协议；③`blockAt(scrollTop)` 未处理容器 28px padding/margin 换算 | 01 §问题 6 | **高（架构级，140fps 地基）** |
| 2 | **P1 行高回填与 tanstack cache 双写冲突**："必须保留 measureElement"（01 §1.2）与"消除 measureElement 抖动"（§1.3）自相矛盾；若移除 measureElement，tanstack 的已测量行 cache 永不回填、`estimateSize` 新值不被消费，行 top 永久错位——文档未给"树回填 → tanstack 刷新"的桥接协议（`virtualizer.measure()` / `setOptions` 调用点） | 01 §问题 1 | **高（架构级）** |
| 3 | **08 招 1 直刷 DOM 会破坏行内渲染结构并可能丢失流文本**：①`ref.current.textContent += chunk` 会整体重建行 DOM，行内 token 结构（bold/表格/强调等 BlockRenderer 产物）全部丢失，仅纯文本行安全；②直刷期间 store 未提交，React 重渲染（窗口变化帧，该行在窗口内）会用旧 `lineText` prop 覆盖直刷文本——`streaming-dirty` 协议覆盖了测量/选区/复制，但**未覆盖渲染路径** | 08 §招 1 | **高（数据丢失）** |

其余实质问题：Setext"回写上一行"与渲染走 `parseLine` 缓存矛盾（维度 7.1）、实体解码"段首 & 条件"漏掉段中 `\&amp;`（维度 7.6）、`_` 围挡校验误加给 `*` 族破坏 `foo*bar*baz`（维度 7.7）、P3 COW 漏掉 `lines`/`codeBlockState` 两个 O(全文) 浅拷贝（维度 4）。

---

## 一、01 行高模型：HeightOracle + 树状 height map 的 tanstack 接入

**结论：需修正**——`estimateSize` 改造面可行，但"测量回填"通道与 tanstack 存在未定义的双写冲突，是方案里最需要先定契约的部分。

**证据**：

1. `estimateSize` 改造本身可行：`useVirtualizer({ estimateSize })`（MarkdownEngine.tsx:106-114）闭包改为查 HeightMap 树（未测量叶子返回 oracle 值）即可；tanstack 在窗口重算时对可见行调用，O(可见行 × log n) 可接受。
2. **矛盾点（实质）**：§1.2 说"必须保留的测量回填：仅 math_block、表格行、图片等不可预测行需要实测"——即保留 `ref={measureElement}`（MarkdownEngine.tsx:74,408）；§1.3 又说"消除 measureElement 引发的测量-渲染抖动（每次滚动少 N 次 resizeItem）"。tanstack 的 `measureElement` 是 ResizeObserver 包装，回调即写 `measurementsCache` 并触发 `resizeItem` → React 提交。**保留则抖动不灭，与收益表矛盾**；移除则出现新问题（见下）。
3. **移除 measureElement 后的桥接缺失（实质）**：tanstack 的 `getVirtualItems()` 的 top/totalSize 由 `measurementsCache`（已测量行用实测值）+ `estimateSize`（未测量行）计算。若不再挂 `measureElement`，cache 永不回填——树里回填过的行，tanstack 侧仍是 estimateSize 初值 → 行位置错位。文档只说"measureBackfill 批量回填"（回填到树），**没有写回填后如何让 tanstack 重新计算**（`virtualizer.measure()` 或 `setOptions` 触发）。这是数据流断点。
4. **双结构职责重叠**：HeightNode 的 `lineAt(pos)`（字符偏移→行几何）与现有 `LineOffsetTree.getOffset/findLineIndex`（SegmentTree.ts:84-125）重复；文档说"在现有 LineOffsetTree 旁新增，或直接扩展它"——未定论。双树并存则每次编辑要同步更新两棵结构（一致性风险与额外成本），且 01 §三 DAG 里 P1 是 P6/P2/P7 的共同地基，双树会让下游全部翻倍。
5. **遗漏**：容器宽度变化（窗口 resize）时 wrap 行高预测全部失效，oracle 的 `containerWidth` 需要失效/重预测机制（CM6 用 measure 阶段刷新），文档未提。

**修正建议**：

- 先定契约二选一：**方案甲（推荐）**——移除 `measureElement`，`estimateSize` 恒返回树查询值（预测或已回填实测），实测回填走自建 RO 写树后调用 `virtualizer.measure()`（O(可见行) 重算，代价可控）；**方案乙**——保留 `measureElement`，其回调写两处（tanstack cache + 树），并放弃"消除 resizeItem 抖动"的宣称，只承诺"抖动收敛到不可预测行"。
- 建议直接扩展 `LineOffsetTree`：每块并行 `lineHeights: number[]`，`getOffset` 顺带输出行 top，`updateLines` 同步更新两数组——避免双树同步；树内再建"块级前缀高"跳表满足 `blockAt(top)` O(log #blocks)。
- 补充窗口 resize 的 oracle 全局度量（charWidth/lineHeight/containerWidth）失效与重预测策略。

---

## 二、01 滚动 rAF 合并 + 命令式位置更新：observeElementOffset 可行性

**结论：需修正**——方向正确（tanstack 默认 observer 确为每次 scroll 事件同步通知、无 rAF），但"零 React 提交"的成立条件与 tanstack 状态模型冲突，且命令式位移与 React 写入的 `style.top` 叠加存在双倍位移缺陷。

**证据**：

1. 现状根因描述准确：`useVirtualizer` 默认 `observeElementOffset` 在每个 scroll 事件内同步 `cb({offset, isScrolling})` → setState → React 提交（MarkdownEngine.tsx:103-116）；`virtualRow` 新对象字面量 → `React.memo` 失效（:12-24, :397-410）；`layoutDeps` 巨型字符串（:417-420）；`style.top` 走 React 属性（:78）。全部与代码吻合。
2. **缺陷 A（实质）："零 React 提交"与 observer 语义冲突**。tanstack 的渲染是数据驱动：只要 `cb` 被调用（offset 变化），内部 state 更新 → React 提交必然发生。要做到"纯位置滚动帧零提交"，只能在 offset 变化但窗口未变时**不调用 cb**——但这使 virtualizer 的 scrollOffset state 永远陈旧，`getVirtualItems()` 返回旧窗口、旧 `virtualRow.start`。而文档 B 的行位置更新只说了"命令式写 `el.style.top`/transform"——**没有交代 React 侧仍在写的 `style.top`（:78）怎么办**：任何窗口变化帧的 React 提交都会把命令式 top 覆盖回陈旧的 `virtualRow.start`（跳变）。
3. **缺陷 B（实质）：translateY 增量与绝对 top 叠加**。方案 B 推荐"每行 `translate3d(0, top, 0)`，position 绝对定位不变"——行同时有 React 写的 `top: virtualRow.start px`（绝对）与命令式 transform（增量）。窗口不变帧内 top 不动、transform 累加 delta → 总位移正确；但窗口变化帧 React 重渲染重写 `style.top`（新窗口的 start），**此时累积的 translateY 必须归零**，文档没有这个复位协议 → 双倍位移/跳变。
4. **缺陷 C：坐标换算遗漏**。容器有 `padding: 14px 1rem`（MarkdownEngine.tsx:385）且 content 有 `marginTop: 14px`（:391）——内容坐标系与 scrollTop 相差 28px。文档伪码 `blockAt(scrollTopRef.current)` 直接用 scrollTop，首行定位偏差一行（28px 行高）。tanstack 默认内部处理了 padding 换算，命令式路径必须自己算。
5. **缺陷 D：isScrolling 语义未定**。cb 第二参控制 tanstack 的滚动态 overscan 扩张；自定义 observer 后建议恒 `false` + 静态 overscan 40（现状值），文档未声明。
6. **遗漏**：`observeElementOffset` 返回 cleanup 函数，需在 useEffect 卸载时执行；文档未提。命令式路径后，`handleContainerClick` 的 padding 点击映射（:145-154 依赖 `item.start`）会成为陈旧坐标的消费者——文档未列这个消费方。

**修正建议**：

- 明确状态协议：**cb 只在窗口变化帧调用一次**（rAF 内 blockAt 计算，窗口不变则完全不通知）；接受 virtualizer 状态陈旧，**把所有位置消费方从 `virtualRow.start` 迁移到"树查询 + 命令式 DOM 坐标"**（点击映射改用 `blockAt(clientY + scrollTop - 28)` 或读行 DOM 的 offsetTop）。
- 位置写入二选一：①完全移除 React 的 `style.top`，行 top 全部命令式（React 渲染只产内容，行用绝对定位 + rAF 写 top）；②保留 React top 但命令式只做"增量 translateY"，且**窗口变化帧强制清空全部 translateY**（渲染后首个 rAF 重算）。推荐 ①。
- `blockAt` 入参统一换算：`contentTop = scrollTop - paddingTop + marginTop`（28px），或首次 mount 用 `getBoundingClientRect` 缓存换算值。
- `isScrolling` 恒 false；补 useEffect 卸载清理；把点击映射改造列入 P6 任务书。

---

## 三、01 测量缓存（token→textNode 二分索引）

**结论：需修正**——方向正确、收益成立，但"失效时机"的声明与 React 组件生命周期不匹配，索引构建规则还需复现现有 ignore 逻辑。

**证据**：

1. 根因描述准确：`getCoordinatesFromIndex` 全扫 `querySelectorAll('[data-token-start]')`（measure.ts:14）+ 每 token 一次 `getBoundingClientRect`（:26,35）+ `findNodeAndOffset` 整树遍历（:72）+ Range（:87-92）+ `getComputedStyle`（:100）；CursorLayer.tsx:46 与 HiddenInput.tsx:50 双重测量；`layoutDeps` 驱动滚动帧全扫（MarkdownEngine.tsx:417-420）。全部吻合。
2. **失效时机缺陷（实质）**：文档说"失效时机：行内容变化（parseLine key 变化）或行卸载"。但 `LineItem` 的 React key 是 `virtualRow.index`（MarkdownEngine.tsx:403）——行内容变化时组件**复用不重挂载**，"行挂载 useLayoutEffect 构建一次"不会重跑，索引陈旧（编辑后光标定位仍按旧 token 布局）。parseLine 的缓存键（parser.ts:117）不是 React key，React 层收不到内容变化信号。
3. **索引构建规则遗漏**：现有 `findNodeAndOffset`/`getRawTextLength` 有严格的 ignore 规则（syntax-content、data-ignore-measure、katex、math-preview，measure.ts:136-146,171-185），且 token 层跳过 `display:none`（:26,35）——行级索引构建必须复现同一套规则，否则文本长度统计与 offset 映射错位。文档未提。
4. **与 DOM 卸载同步**：索引存组件 ref，行卸载即弃 → GC 无泄漏 ✓；行回视口重挂载重建 ✓。此部分可行。

**修正建议**：

- 失效依赖改为 `[lineText, isCode]`（内容版本号更佳）；或用内容 key 替换 index key（但会破坏行的位移复用，不推荐）。
- 索引构建时应用与 `findNodeAndOffset` 完全一致的 ignore/隐藏规则，并抽公共常量。
- "与问题 6 生命周期共用"表述改为"与问题 6 的挂载钩子共用；内容失效由 [lineText, isCode] 依赖单独承担"。

---

## 四、01 clone COW（块级写时复制）

**结论：需修正**——LineOffsetTree 两级块数组**完全支持** COW（改法明确），但方案只覆盖了树本身，漏掉击键路径上另外两个 O(全文) 浅拷贝；undo 相关表述与实现不符。

**证据**：

1. 根因描述准确：`clone()` = `blocks.map(b => b.clone())` 每块 `[...lineLengths]`（SegmentTree.ts:209-213），击键/流式/undo 每次全量（EditorStore.ts:191,533）。
2. **COW 改法核验通过**：`blocks` 是引用数组（SegmentTree.ts:63）——`clone()` 改 `t.blocks = this.blocks.slice()`（浅拷贝 3907 个引用 < 0.1ms ✓）；`updateLines` 的删除循环（:148-162）与插入（:181-187）在操作前对目标块 `this.blocks[bIdx] = this.blocks[bIdx].clone()` 再改——未触及块共享 ✓；分裂路径（insert 返回 newBlock，:184-187）新块是新对象，旧树引用不受影响 ✓。伪码级核验通过，改动量约 10 行。
3. **覆盖缺口（实质）**：P3 只解决 `lineOffsets.clone()`。`updateLinesIncremental` 每次击键还有两处 O(全文) 浅拷贝：`[...lines]`（EditorStore.ts:188，100 万行 = 100 万引用 ≈ 8MB）与 `[...codeBlockState]`（:194）。文档 §3.3 收益表写"击键路径 O(全文)→O(256+触及块)"——**只对树成立**，lines/codeBlockState 仍是 O(全文)，实测 0.5-1ms/键，140fps 预算（8.3ms 分 1ms 给数据层，§4.2）下不可忽略。08 招 2 只覆盖 append 路径，insertText/deleteText/undo 路径同样漏掉。
4. **undo 表述错误（轻）**：§3.2 说"undo/redo 天然免费——旧树保留着编辑前的块引用，内存增量 O(触及块)"。现有 undo 是**重放式**（EditorStore.ts:764-772 用 EditorOperation 逆操作重建新树），不保存树快照——旧树引用在更新后立即被丢弃，"内存增量 O(触及块)"仅在快照式 undo 下成立。正确表述：COW 使 undo/redo 的**每次重放成本**降为 O(局部)，而非"免费"。

**修正建议**：

- 补 lines 与 codeBlockState 的分块 COW（与 LineOffsetTree 同构：共享数组 + 触及区间替换），或直接并入 08 招 2 的"统一访问器"设计，覆盖 insertText/deleteText/undo 全路径。
- 修正 undo 表述为"重放成本 O(局部)"。
- COW 回归测试建议保留：文档 §5.3 的"clone 后旧树独立"断言仍需（COW 后旧树独立是指未触及块共享、触及块不复用——语义测试）。

---

## 五、01 fence 前缀位图（P4）

**结论：需修正**——方案数学正确（toggle 奇偶性 → 前缀位图 O(1)），根因定位准确，但伪码有两处实现细节缺口。

**证据**：

1. 根因描述准确：二分 splitIdx（EditorStore.ts:207-218）+ 线性重放 `for i < splitIdx`（:220-228）恢复 `inCodeBlock/inMathBlock`——O(编辑点前 fence 数) ✓；`codeBlockState` 数组已存在且由收敛逻辑维护（:194-202, :230-291）✓。
2. **正确性核验通过**：重放恢复的状态 = 编辑点前 `fence_start/fence_end`（及 math 同构）toggle 序列的结果；fence 状态是二值奇偶，行级"行开头状态"位图与重放**逐位等价**（数学归纳：位图行 i 的值恒等于从头重放到 i-1 的状态）。收敛扫描逻辑（:230-291）不受影响（oldState 预填 'none' 的机制与位图正交）✓。
3. **回填错位风险（细节）**：位图存"行开头状态"，行 j 的位 = 处理 j-1 行后的状态。收敛扫描停止于行 i，回填区间应为 [startLineIdx, i+1) 且值取自"扫描推进到该行时"的状态；伪码 `blockStatePrefix.fill(..., startLineIdx, i)` 未明确取值时点，1 行错位会导致编辑点下一行的初始状态错一个 fence 的奇偶。
4. **fenceLines 适配遗漏**：方案伪码只写了状态恢复，但 `newFenceLines` 的重建仍然需要——重放循环里 push（:227）+ 收敛后的旧 fence 平移（:293-306）。位图只替代"初始状态恢复"，fenceLines 构建逻辑必须保留，文档未交代。
5. **打包实现细节**：2bit/行 packed 成 Uint8Array（每字节 4 行）后，`blockStatePrefix[startLineIdx]` 不是直接下标读取，需要 `>> (2 * (idx & 3)) & 3`；`fill` 对 packed 位图不适用（需逐行位写）。伪码层可接受，实现需注意。

**修正建议**：

- 明确位图语义（行开头状态）与回填取值时点（处理完 j-1 后的状态写位 j），补 1 行错位回归测试（编辑点恰在 fence_start 前/后各一例）。
- 任务书明确"newFenceLines 重建逻辑保留，仅初始状态恢复换位图"。
- 删掉"FencePrefixIndex 前缀奇偶（COW 更新）"与"行级位图"两个方案并存的冗余表述，推荐只保留行级位图。

---

## 六、02 2^n 修复（失败规则记忆）

**结论：可行（附 2 项强制边界条件）**——核心方案正确、复杂度声明成立，但有两个必须写进实现的边界条件，缺一个即方案失效或产生新 bug。

**证据**：

1. 根因定位完全准确：递归入口 parser.ts:988（`r.start && sub.startsWith(r.start)` → `scanTokens(depth+1)`）；深度剪枝 :720（`depth > 20 return null`）只剪第 21 层以下的调用，2^n 树的节点数在 ≤20 层内爆炸（n=22 时剪枝仅省 C(22,21)+C(22,22)=23 节点）——文档 3.2.3 的描述正确；close 全行扫描 :863-865（`toLowerCase().indexOf`）；失败 run 合并 :1012-1024 仅 `*~=_``、不含 `<` ✓；实证调用数精确 2^n ✓。
2. **记忆正确性核验通过**：规则 X 在位置 p 尝试失败（窗口 (p, EOF) 内无闭包）→ 对任意 q > p，窗口 (q, EOF) ⊂ (p, EOF) 内亦无闭包 → 记忆安全。复杂度：每个规则至多失败一次（记入后不再重试），成功匹配每次推进 ≥1 字符，总代价 O(#rules × n)——文档"O(规则数×行长度)"声明正确。
3. **边界条件 1（强制）：失败集合必须跨递归层共享同一个引用**。递归发生在 :988，内层失败记录若不复用给外层，外层在后续位置会对同规则重新尝试 → 2^n 不降。文档"向 scanTokens 传递 failedRules"未指明共享语义，实现时若每层 new Set 则方案完全失效。
4. **边界条件 2（强制）：深度剪枝产生的 null 不得记忆**。:720 的剪枝返回 null 是"伪失败"——闭包实际可能存在（如 25 层合法嵌套 `<b><b>...`）。若记入失败集合，后续位置同规则被误杀 → 合法输入解析退化。记忆条件必须限定为"循环自然到达 EOF 且 close 存在但未闭合"（:1030-1033 路径）。
5. **备选方案 2（close 预扫描）天然规避边界 2**（只查闭包存在性，与递归结果无关），代价是每行 12 次 indexOf（12 × O(n)）——建议方案 1+2 结合：方案 1 为主 + 记忆条件限定；或直接以方案 2 兜底。

**修正建议**：

- 方案 1 实现规格补两条：集合引用跨层共享；仅"闭包缺失"失败入集合（深度剪枝/其他 null 不入）。
- 回归测试补：`'<b>x'.repeat(30/60/100)` 调用计数线性且 <100ms；**25 层合法嵌套 `<b>` 闭合输入必须仍正确解析**（防误杀）；parser-redos.test.ts 已有三例保留。
- 若实现选用方案 2（预扫描 close），无需记忆集合，但注意 htmlRule 是动态对象（parser.ts:868-875），按 tagName 缓存。

---

## 七、02 六项缺语法：接入点与冲突点核验

### 7.1 Setext 标题：需修正（实质）

**证据**：判定顺序 hr(:408)→ATX(:417)→table(:432)→list(:449) 描述准确；`---` 被 hr 正则吞掉 ✓（parser.ts:409）；`===` 不在 hr 字符集 ✓。**实质缺陷**：方案说"回写上一行为 setext_heading_1/2（AST 是纯函数数组，回写安全）"——但**渲染路径不消费 `parse()` 的 lineNodes 数组**：MarkdownEngine.tsx:67 逐行调 `MarkdownParser.parseLine(lineText, offset, isCode)`（带 LRU 缓存，parser.ts:117 键 = codeState:lineText）。上一行已以 body 形态缓存；回写只改内存数组，缓存中的 body 版仍在 → 渲染该行时缓存命中返回 body，**Setext 方案对渲染无效**；且回写使"同键缓存"与回写结果不一致（缓存污染）。

**修正建议**：Setext 关系决策上移预扫描（`computeLineContexts` 产出"上一行是 setext 目标、当前行是 underline"的显式位），`parseLine` 增加上下文参数，缓存键纳入该上下文（或 Setext 相关行直接跳过缓存）。§2.1 的"回写"表述废弃。

### 7.2 缩进代码块：需修正（EditorStore 侧改造遗漏）

**证据**：进 `computeLineOffsets` 状态机 + CodeState 扩展的路径正确（与 fence 同构，缓存键自动含 codeState ✓，parser.ts:117）。tab 停靠 4 展开、段落打断、列表优先级等冲突分析正确。**实质遗漏**：EditorStore 的 `updateLinesIncremental` 状态机（EditorStore.ts:246-272）与 `appendText` 的尾段状态推断（:548-566）**必须同步实现 indent_code 分支**——否则编辑时 store 的 codeBlockState 与渲染（parseLine 消费 store 的 codeBlockState）不一致，出现"编辑后缩进代码块状态错乱"。文档未提。

**修正建议**：任务书明确三处状态机同步（computeLineOffsets / updateLinesIncremental / appendText 尾段推断），并补对应单测。

### 7.3 引用链接定义：需修正（缓存污染）

**证据**：定义表预扫描 + INLINE_RULES 插入引用规则（footnote 之后 :607、code 之前 :608）的接入点正确；`[^x]`/checkbox 顺序冲突分析正确。**实质遗漏**：引用规则依赖文档级定义表，而 `parseLine` 缓存键（codeState:lineText）不含定义表 → 同一 `[foo]` 文本在不同文档（定义表不同）下缓存互串：先解析含定义文档，再解析无定义文档时命中缓存，错误地把 `[foo]` 解析为链接。§5.4 说"走每文档一次的定义表快照"但未解决缓存键。

**修正建议**：定义表快照 id/版本号进缓存键，或引用解析结果不进缓存（定义相关行单独路径）。

### 7.4 自动链接：可行 ✓

**证据**：接入点（HTML 分支 :847 之前）正确；`<http://x>` 被 htmlMatch 当 tagName=`http` 做 `indexOf('</http>')` 全行扫描（:862-865）的根因分析正确；scheme 2~32 字符、邮件正则边界（`<foo bar@baz>` 等）符合 CommonMark 6.9。与 html_tag 规则（:635）的次序冲突已分析。无需修正。

### 7.5 HTML 块级：可行（含 2 项遗漏）

**证据**：7 类正则 + CodeState `html_block` + 终止条件的方案正确；type 6/7 与行内 html_element（:876-901）的双路径判定次序已分析。**遗漏**：同 7.2——EditorStore 两处状态机（updateLinesIncremental、appendText）需同步 html_block 分支；文档未提。**补充**：type 7（完整开闭标签对单行）与行内 html_element 的判定重合面大，需要块级正则先行的明确次序（文档已提"行首块级判定优先"，但未给实现判定细节）。与 01 行高 oracle 无冲突（raw 行 28px 预测即可）。

### 7.6 实体引用：需修正（实质）

**证据**：接入点（flushText 对 content 解码、code/math/raw HTML 内不解码）方向正确；与投影器转义的联动分析（content 解码 → 投影器转义回 `&amp;`）正确。**实质缺陷**：解码条件"该文本段的 raw 以 & 开头且不以 \ 开头"只覆盖**段首**实体——段中 `abc &amp; def` 的 `&amp;` 不会被解码（条件为假）；更糟的是段中 `\&amp;`（转义 & + 字面 amp;，CommonMark 期望输出 `&amp;`）：转义在扫描期消费（parser.ts:782-795，`\&` 前进 2 字符），flush 时 content 已为 `&amp;`，若按"非段首全段解码"又会把它错解为 `&`——**转义边界在 flush 时不可见**，两种做法各错一边。文档条件既不充分也不完备。

**修正建议**：解码必须在 flush 时**对照 raw 逐字符推进**（raw 中 `\&` 位置跳过不解码，raw 中 `&` 位置尝试实体匹配），或在扫描循环内逐 `&` 判断（前导 `\` 已被转义消费，无法事后判断，故前者更可行）；补充 `\&amp;` 段中形态的回归测试。

### 7.7 下划线强调（补充项）：需修正（`*` 族围挡误加）

**证据**：`_` 族整族缺失的定位正确（INLINE_RULES :609-634 之间无 `_` 规则 ✓）。**实质错误**：文档说"围挡校验同时修正现有 `*` 族的对应偏差"——CommonMark Rule 9/10 的词内限制**仅适用于 `_`**：`foo*bar*baz` 合法解析为 `foo<em>bar</em>baz`，`foo_bar_baz` 保持字面。若把"两侧均为字母数字时禁用"施加给 `*`，会破坏现有合法输入。且"`* hello*` 被列表吞掉"是列表规则（:470）优先的既有偏差，与围挡校验无关，混为一谈。

**修正建议**：围挡校验只加给 `_` 族三规则；`*` 族维持现状；spec Emphasis 的 `*` 用例作为回归基线防误伤。

---

## 八、08 三招：边界协议、访问器改造面、交叠冲突

### 8.1 招 1 末行直刷 DOM：需修正（两处实质错误）

**证据**：

1. **技术错误 A（实质）**：`ref.current.textContent += chunk`——`textContent` 赋值会**清空并重建整行 DOM**，行内 token 结构（BlockRenderer 的 bold/italic/表格/强调等所有子节点）全部丢失，只剩纯文本。仅当末行 AST 是纯 `text` token 链时安全；行内含 `*`/`` ` ``/`|` 等字符即破坏。文档未限定"末行纯文本"条件。
2. **技术错误 B（实质，数据丢失）**：直刷期间 store 未提交。流式期间若发生窗口变化（滚动/其他编辑），React 以旧 `lineText` prop 重渲染该行（LineItem 由 store 驱动）→ **覆盖直刷 DOM，流文本丢失**。`streaming-dirty` 协议覆盖了测量/选区/复制（§招 1 风险修正第 1 条），**未覆盖"React 渲染路径对 dirty 行的处理"**——dirty 行必须阻止渲染（渲染前先 flush，或渲染时跳过 dirty 行）。
3. 与 01 交叠：直刷行不更新 store → LineOffsetTree/textLength 滞后 → 虚拟器 count 不变（无碍）✓；光标节流跟随（每帧一次）已提 ✓；与 P5 冲突策略（光标在末行时 append 前移）共存时，直刷的 chunk 与"光标处插入"的语义边界未定义（光标在末行中间时是否直刷？直刷会污染用户编辑区）。

**修正建议**：直刷限定"末行无行内 token"（或维护末行纯文本渲染模式）；追加用"行尾文本节点 append"而非 textContent 赋值；任务书明确"React 重渲染先 flush dirty 缓冲"协议；P5 与招 1 的交互（光标在末行中间时禁用直刷，走 store 路径）写进边界协议。

### 8.2 招 2 append 尾段零拷贝：需修正（访问器改造面低估）

**证据**：

1. 根因行号小错：`[...state.lines]` 实际在 EditorStore.ts:530（08 写 :558，:558 是 `inCodeBlock = !inCodeBlock`）；`[...state.codeBlockState]` 在 :537、`[...state.fenceLines]` 在 :570——**三处**全量浅拷贝，文档只点名 lines。
2. 方案本身可行：append-only 尾段 + 懒合并，语义正确（编辑触达先合并）。
3. **访问器改造面低估（实质）**：文档只列了行文本查询（getLine）。**偏移侧必须同步跨层**：`LineOffsetTree.findLineIndex(pos)`（pos 可能落在尾段）、`getOffset(i)`（i 落在尾段）、`textLength`（含尾段）、`fenceLines`/`codeBlockState` 的尾段部分——文档说"尾段行数少，偏移计算直接累加不建树"，但没定义 findLineIndex/getOffset/textLength 的统一入口。漏掉偏移侧，虚拟器 count、光标定位（findLineIndex 被 insertText/deleteText/测量全链路消费）全部错位。
4. 与 01 P3 交叠：招 2 解决 lines 数组浅拷贝，P3 解决 LineOffsetTree.clone——正交可共存 ✓；但两套查询路径（mainLines+tail 与树）需统一封装，避免调用方自行换算。

**修正建议**：任务书补偏移侧访问器（`getOffset`/`findLineIndex`/`textLength` 的尾段分支 + 合并触发点）；行号修正为 :530/:537/:570；补"编辑触达尾段先合并"的正确性测试。

### 8.3 招 3 16ms 帧对齐：可行 ✓

**证据**：StreamBuffer.ts:20 已有 `requestAnimationFrame` 批处理 ✓；缺 stop-flush 的判断正确。无需修正。

---

## 九、附：轻量级小错登记（不影响方案，需在任务书修订时顺手修正）

| # | 位置 | 问题 |
|---|---|---|
| 1 | 01 §5.1 | "requestVideoFrameCallback" 是 HTMLVideoElement 的 API，非 window 方法；帧率统计应写 `requestAnimationFrame` 间隔统计 |
| 2 | 08 §招 2 | append 拷贝行号写错（:558 → :530/:537/:570） |
| 3 | 01 §3.2 | "undo/redo 天然免费、内存增量 O(触及块)"与重放式 undo 不符（见维度 4） |

---

## 十、给主 Agent 的结论摘要

- **统计**：完全可行 0 项；需修正 7 项（维度 1/2/3/4/5/7/8）；基本可行附强制边界条件 1 项（维度 6）。子项级：实质错误 6 处、方案级遗漏 8 处、小错 3 处。
- **最严重 3 问题**：① P6 命令式滚动与 tanstack 状态模型的冲突（零提交条件、translateY 叠加双倍位移、28px 换算缺失）；② P1 行高回填与 tanstack cache 的双写断点（无桥接协议）；③ 08 招 1 直刷 DOM 破坏行内结构 + React 重渲染覆盖丢文本。
- **建议动作**：P1/P6 任务书补"与 tanstack 的契约章节"（估计 size 接管 + observer 通知协议 + 消费方迁移清单）；08 招 1 限定纯文本行 + 补渲染路径 flush 协议；02 的 Setext/实体/围栏三项按本报告修正后进入实现；P3 任务书并入 lines/codeBlockState 分块 COW。
