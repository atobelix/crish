# plan-A3 选区保护：流式直刷（R3-B2）期间的选区保护——极致版分析

- 轮次：方向一打磨·轮 1 · 分析 A3（纯分析，只读产出）
- 日期：2026-08-10
- 范围：markdown-editor 引擎流式末行直刷 DOM 与用户选区（引擎选区 + 原生 DOM 选区）的并发交互；目标 = 直刷不打断选择、写入后恢复、正在选中的区域降级保守更新、体验极致、避免跳动。
- 结论先行：**推荐方案 D（方案 B 为主 + 方案 A 兜底）**——B 的「选区感知直刷」保证用户选中/编辑处永不被打断（判定 O(1)，无选区帧零开销）；A 的「flush 后选区钳制」兜底原生选区双轨写坏边界。方案 C（冻结高亮）与拖选实时性冲突，不采纳。

---

## 1. 现状盘点（证据）

### 1.1 直刷机制（R3-B2）与选区的关系

- 直刷入口 `streamAppend`（`src/components/MarkdownEngine.tsx:660-708`）：chunk 落在「当前纯文本末行」时 `tokenEl.textContent += chunk` 直写 DOM（`MarkdownEngine.tsx:690-693`），store 延迟提交（`pendingStreamRef` + `dirtyRefs`，`MarkdownEngine.tsx:622-624`）。
- 直刷前置条件 `canDirect`（`MarkdownEngine.tsx:680-688`）：末行已挂载、chunk 无换行、合并后纯文本（`isPlainTextLine`，`MarkdownEngine.tsx:107-115`）、CodeState 为 none、token span 存在。**条件里没有光标/选区相关判定**。
- flush 时机（提交点）：`flushStreamInternal`（`MarkdownEngine.tsx:630-640`）→ `store.appendText(pending)`；触发源 = 用户事件 capture 监听（keydown/compositionstart/pointerdown/mousedown，`MarkdownEngine.tsx:882-896`）、滚动触达 dirty 行（`MarkdownEngine.tsx:903-925`）、dirty 行 DOM 断开（`MarkdownEngine.tsx:964-974`）、`streamEnd`（`MarkdownEngine.tsx:713-717`）、非直刷 chunk 回落（`MarkdownEngine.tsx:706-707`）。
- **直刷恒只作用于末行**（`lastIdx`，`MarkdownEngine.tsx:663`）——「选区与直刷区域重叠」=「选区与末行字符区间相交」，判定维度极小。

### 1.2 直刷期间用户选区的实际行为（问题清单，逐条证据）

1. **引擎选区 head 被钳制，拖选到达不了直刷文本（选中断裂/滞后）**：拖选 head 经 `store.moveHead` 更新（`HiddenInput.tsx:1019`），`moveHead` 将 head 钳制到 `textLength`（`EditorStore.ts:1889`）——直刷期间 store 滞后于 DOM（差 = pending 长度），用户拖选跨越直刷字符时 head 卡在 store 末端。flush 后 `appendText` 按 `shiftGE` 平移选区（`EditorStore.ts:2437-2439`、`2486-2487`）→ 高亮右端瞬时伸长，用户「选中了没点过的东西」。
2. **高亮 rect 滞后（视觉跳动）**：SelectionHighlight 的 rect 计算依赖行的 `data-line-length`（`SelectionHighlight.tsx:114-117`）与 `getCoordinatesFromIndex`（`SelectionHighlight.tsx:103-104`）——`data-line-length` 是 LineItem 由 store 视图渲染的属性（`MarkdownEngine.tsx:297`），直刷行滞后 → 选区矩形右缘停在 store 边界，直刷文本视觉上「未被选中」，flush 后突跳到覆盖。
3. **拖选进行中的 flush（mousemove 中直刷提交）**：拖选激活后边缘滚动触发 `onScroll → handleScrollFlush`（`MarkdownEngine.tsx:903-925` 由 `HiddenInput.tsx:999-1009` 的边缘滚动引发）→ flush 提交 → 选区平移 → 高亮与鼠标位置错位（下一帧 mousemove 以 `indexFromClientPoint` 重算 head 会纠正，但存在瞬时错位；且重算后的 head 又被钳制回 store 边界，见问题 1）。
4. **双击词选（B2）与直刷并发**：dblclick 设引擎选区（`HiddenInput.tsx:1058-1081`，`setSelection` 1080）→ 直刷 flush 后若选区在末行会被平移，词区间「膨胀」。
5. **原生选区双轨写坏 store（边界，无钳制）**：编辑态外部路径的原生 DOM 选区经 `handleSelectionChange → getGlobalIndexFromDOMNode` 写入 store（`HiddenInput.tsx:836-885`，`setState` 878-882）**无钳制**——选区延伸到直刷字符（DOM 长度 > store 长度）时 `selectionEnd > textLength` 落库；flush 后 `shiftGE` 再把越界值平移得更远，`getCoordinatesFromIndex` 查不到对应 token → `SelectionHighlight` 空 rect（`SelectionHighlight.tsx:106-108` 的 `setRects([])`）→ **高亮消失**。
6. **光标在末行「行中」时的 flush 跳变（R3-B2 遗留隐藏成本，同源）**：canDirect 不含光标判定（`MarkdownEngine.tsx:680-688`）；用户光标在末行中间（活跃编辑）时直刷把 chunk 写行尾 → flush 时 `appendText` 追加点前移到光标处（`EditorStore.ts:2168-2182` 的 `shiftAnchorToCursor`）→ 直刷文本从「行尾」跳到「光标处」，DOM 与 store 分叉后收敛（review-02 已登记该边界：`docs/analysis/review-02-技术正确性.md:201`）。

### 1.3 readOnly 与编辑态差异

- readOnly：不渲染 HiddenInput/CursorLayer/SelectionHighlight（`MarkdownEngine.tsx:1492-1520`），引擎选区不活跃（`scrollToMatch` 跳过 setSelection，`MarkdownEngine.tsx:748-753`）——**唯一选区轨 = 原生 DOM 选区**；复制经 `selectionToMarkdown` 映射（`renderToHtml.ts:886-898`）。
- 直刷对原生选区的行为 = DOM 文本节点插入语义：`textContent +=` 是在节点尾部插入文本，Range 端点按 DOM 突变规则自动调整（插入点之前的端点不动、插入点之后/重合的端点平移）→ **readOnly 下原生选区自动跟随流增长，天然不打断、零跳动，无需任何保护**。
- 结论：**选区保护只对编辑态（引擎选区轨）生效**；readOnly 跳过判定（原生轨交给浏览器）。

### 1.4 原生选区与引擎选区双轨交互

- 编辑态双轨并存：引擎自绘高亮（SelectionHighlight，消费 DecorationSet 的 selection 装饰，`DecorationSet.ts:250-265`、`SelectionHighlight.tsx:91-98`）为主轨；原生 DOM 选区为辅轨（外部选择、`CursorLayer` 以 `hasSelection` 隐藏自绘光标，`CursorLayer.tsx:39-47`；`handleContainerClick` 遇非折叠原生选区提前返回，`MarkdownEngine.tsx:1137-1140`）。
- 拖选状态机（R4-G）激活后**抑制原生选区**（`userSelect none` + `removeAllRanges`，`HiddenInput.tsx:993-994`、`1042-1046`）→ 拖选期间只有引擎轨；双击选词同样 preventDefault 原生（`HiddenInput.tsx:1072`）。
- 双轨的脏数据风险集中在 §1.2 问题 5（原生轨越界写坏 store）；其余路径双轨互斥良好。

---

## 2. 多方案设计

### 2.1 方案 A：记录-恢复（直刷前 record → 写入后 restore）

- 机制（两段式，按轨道分）：
  - **store 轨**：flush 前快照选区（selectionStart/End/anchor/head），`appendText` 后显式恢复/校正——但 appendText 的 `shiftGE/GT`（`EditorStore.ts:2437-2439`）本身就是「记录-恢复」的 store 版，A 的增量 = **flush 后一次 O(1) 钳制**：`selectionEnd > textLength` 时 clamp 到 textLength（越界值语义上恰是「用户选中了直刷文本」的最终位置，flush 后文本已提交，clamp 即正确的恢复目标；`shiftGE` 平移越界值后再 clamp 结果一致）。
  - **DOM 轨**：直刷前 `getSelection().getRangeAt(0)` 快照 Range，写入后 `selection.addRange` 恢复。**编辑态无必要**（引擎自绘高亮为主轨，原生 Range 被拖选抑制；外部原生选区在直刷行 = 节点尾部插入，DOM 规则自动调整，恢复反而画蛇添足）；readOnly 同样由 DOM 规则自愈。
- 跳动风险：钳制走既有装饰链路（一次 `decorationVersion++` → 一次 rect 重测，`MarkdownEngine.tsx:512-524` + `SelectionHighlight.tsx:152`，useLayoutEffect 链 commit 后同步跑，无中间帧）→ 无闪烁；但 A **只能事后校正，治不了拖选钳制滞后**（§1.2 问题 1/3 依旧：head 卡在 store 边界、flush 瞬间高亮伸长）。
- 复杂度：低（~10 行 + 单测）。**单独使用不解决「选中处被打断/滞后」的主问题**。

### 2.2 方案 B：选区感知直刷（重叠 → 降级常规路径）——主方案

- 机制：`canDirect`（`MarkdownEngine.tsx:680-688`）增加一个纯函数判定 `shouldDirectStream(selection, cursorPos, lastLineStart, lastLineLen, readOnly)`：
  - `readOnly` → true（原生轨自愈，不干预）；
  - **非折叠选区与末行区间相交**（含跨行选区尾部探入末行）→ **false（降级）**——降级路径 = 既有回落分支 `flushStreamInternal() + appendText(chunk)`（`MarkdownEngine.tsx:706-707`，非纯文本/含换行/超长共用的同一条路），dirty 协议零改动；
  - **折叠光标在末行行中（`cursorPos` 落在末行字符区间内部，非行尾）** → false（降级）——修复 §1.2 问题 6 的 flush 跳变（用户正编辑末行时行尾直刷会在提交时「跳到光标处」）；光标在末行行尾/全文末尾（跟随流场景）→ true（直刷保留——「用户盯着流输出」是直刷存在的意义，此场景 flush 的 `wasAtEnd` 平移语义正确）；
  - 其余（无选区、光标/选区在末行之前）→ true（照常直刷，flush 时 `shiftGE` 对 < anchor 的选区不移动，`EditorStore.ts:2438`，天然安全）。
- 效果：**用户选中/编辑处永不被打断**——选区在末行时每 chunk 走常规提交（store 同步、选区按 appendText 契约平移、DOM 与 data-line-length 一致），高亮 rect 无滞后、无跳变；拖选 head 无钳制（store 已同步，`moveHead` 钳制形同虚设）；末行之外照常直刷，性能不受损。
- 判定与拖选的衔接：拖选激活时 store 选区 = [anchor, head]（`moveHead` 维护，`EditorStore.ts:1887-1912`）——head 被钳制到 store 边界时恰好落在末行行尾（`textLength` ≥ 末行起点）→ 相交判定命中 → 下一 chunk 自动降级，**无需跨组件暴露 `dragSelectRef`**；鼠标在末行上方拖选 → 不相交 → 直刷照常，用户拖进末行的第一帧即切换降级。
- 跳动风险：**无新增跳动**——降级路径就是编辑器日常路径（每 chunk 一次常规提交 + 渲染，与「非纯文本行流式」现况同构），选区平移语义与手动编辑一致；无中间态、无清空再设置的闪烁。
- 代价（诚实边界）：**用户选中末行期间失去直刷性能**（每 chunk = store 提交 + 末行渲染 + rect 重测）——这是「选中处保守更新」的预期取舍，且该场景本就要求交互跟手性优先。
- 复杂度：低（一个纯函数 + `canDirect` 加条件，约 15 行 + 单测）。

### 2.3 方案 C：直刷期间挂起选区更新（SelectionHighlight 冻结 + flush 后一次校正）

- 机制：pending 非空时冻结 SelectionHighlight 的 rect 重测（跳过 effect 或缓存 decorationVersion），flush 后解冻一次校正。
- 致命冲突：**冻结 = 拖选期间高亮不动**——拖选跟手性依赖每帧 store 选区 → 版本 → rect 重测（`HiddenInput.tsx:1019` + `SelectionHighlight.tsx:152`），冻结直接毁掉 R4-G 状态机；而「mousemove 中直刷」恰恰是本任务的核心场景。
- 且 SelectionHighlight 是整组 rect 全量重算（`SelectionHighlight.tsx:111-149`），无行粒度局部冻结的接口，想「只冻直刷行」也要动组件结构。
- 跳动风险：解冻瞬间一次性跳变；冻结期间高亮与选区语义脱节。
- 复杂度：中（冻结协议 + 与 R5-D 版本链路协调）。**判定：不采纳**（与拖选实时性冲突，方案 B 已用更简单的机制消除跳动根因）。

### 2.4 方案 D：混合（B 为主 + A 兜底）——推荐

- B 解决主问题（选中/编辑处不打断、无滞后、无钳制）；A 的 flush 后钳制解决 §1.2 问题 5（原生轨越界写坏 store → 高亮消失的边界）。两者独立、互补：B 管「直刷前的判定」，A 管「提交后的校正」。
- 实施要点（避免跳动的关键）：
  1. **校正必须走既有原子链路**：flush 后钳制 = 一次 `setSelection` 式 setState → 装饰维护 effect（`MarkdownEngine.tsx:512-524`）与 SelectionHighlight effect（`SelectionHighlight.tsx:152`）同 commit 链跑完 → 单帧重测，**禁止**「先清空再设置」或额外中间态（`setRects([])` 只在真无选区时出现）。
  2. **降级判定纯函数化**（导出供单测，与 `isPlainTextLine` 同款导出约定，`MarkdownEngine.tsx:107`）。
  3. **B 判定在 readOnly 短路**（原生轨自愈，见 §1.3）。
  4. 不引入 RAF 节流/防抖（每 chunk 一次 O(1) 判定，无需调度）。

### 2.5 多方案对比表

| 维度 | A 记录-恢复 | B 选区感知直刷 | C 挂起选区更新 | D 混合（B + A 兜底）★ |
|---|---|---|---|---|
| 选中处不打断（拖选 head 不钳制） | ✗（治不了滞后） | ✓（相交即降级） | ✗（冻结毁跟手） | ✓ |
| 高亮无滞后/无跳变 | 部分（事后校正） | ✓（降级帧 DOM 与 store 同步） | 冻结期滞后 | ✓ |
| 拖选进行中（mousemove 内 flush） | ✗（错位 1 帧） | ✓（head 入末行即降级） | ✗（冻结） | ✓ |
| 双击词选/查找选中与直刷并发 | ✗（会被平移） | ✓（选中处降级） | 部分 | ✓ |
| 原生轨越界写坏（问题 5） | ✓（钳制） | ✗（不覆盖） | ✗ | ✓ |
| 光标在末行行中 flush 跳变（问题 6） | ✗ | ✓（行中降级） | ✗ | ✓ |
| 无选区帧性能 | 零开销 | 零开销（O(1) 判定） | 挂起检查开销 | 零开销 |
| 视觉跳动风险 | 低（原子链路） | 无新增 | 解冻瞬间跳变 | 无新增 |
| 复杂度 | 低 | 低 | 中 | 低-中 |
| 性能退化场景 | 无 | 仅「选中/编辑末行」帧（预期取舍） | 冻结协议全局 | 同 B |

### 2.6 推荐与实施要点

- **推荐 D**：B 为主（`canDirect` 增加 `shouldDirectStream` 判定，降级走既有回落路径），A 兜底（flush 后 `selectionEnd` 越界钳制 O(1)，只在越界时 setState）。
- 极致体验的三个「禁止」：禁止中间态校正（闪烁）、禁止在拖选激活时干预选区（状态机独占）、禁止 readOnly 干预（原生轨自愈）。

---

## 3. 与既有机制交互

| 既有机制 | 交互结论 |
|---|---|
| dirty 协议（R3-B2，`MarkdownEngine.tsx:622-640`） | 零改动。降级复用既有回落分支（706-707），dirty 语义天然成立；「选区在末行」时根本不产生 pending，dirty/dirtyRowOutOfView/断开 flush 全部空转。 |
| flush 时机（事件 capture、滚动、断开，882-925、964-974） | 降级场景无 dirty → 各 flush 触发源空转；不相交场景直刷照常，flush 语义不变。**发现项**：mousedown/pointerdown capture flush（888-889）保证「拖选开始前 pending 必已提交」——拖选起点永远落在已提交状态上，B 判定在拖选开始时即可信。 |
| SelectionHighlight 重绘（R5-D，`SelectionHighlight.tsx:86-152`） | 降级帧 DOM 与 `data-line-length` 同步（`MarkdownEngine.tsx:297`），rect 右缘不再滞后；rect 重测仍由 decorationVersion 驱动（512-524），原子单帧。**收益**：§1.2 问题 2（rect 滞后）在降级场景根治。 |
| 拖选状态机（R4-G，`HiddenInput.tsx:941-1048`） | 无需跨组件暴露状态：head 钳制位恰好落末行行尾 → 相交判定命中 → 自动降级（§2.2 衔接分析）。拖选中边缘滚动（999-1009）触发的 flush 在降级场景无 pending，空转。 |
| 双击词选（B2，`HiddenInput.tsx:1058-1081`） | 词选区间在末行 → 下一 chunk 降级 → 词区间不再被 flush 平移膨胀（§1.2 问题 4 修复）。 |
| FindReplacePanel（B2，`FindReplacePanel.tsx:324-358`） | 替换命中 = 引擎选区：命中在末行 → 降级 → **顺带消除「替换 Enter 与直刷 pending 竞态」**（发现项：FindReplacePanel 的 document capture keydown 先于容器 capture flush 执行，`FindReplacePanel.tsx:258-281` vs `MarkdownEngine.tsx:882-896`，替换 applyChange 可能作用在滞后 store 上；命中在末行时 B 保证无 pending，竞态消失；命中不在末行时该竞态仍存在，登记为遗留发现项，不在本任务范围）。`scrollToMatch` 选中的命中在末行时同样降级。 |
| CursorLayer（`CursorLayer.tsx:39-47`） | 无交互面（仅消费 DOM 选区存在性隐藏光标）；B 不改变原生选区存在性。 |
| readOnly（`MarkdownEngine.tsx:448-457`、`1492-1520`） | 判定短路（§1.3）：原生选区由 DOM 文本节点插入规则自愈（端点自动调整），直刷不打断；`selectionToMarkdown`（`renderToHtml.ts:886-898`）在 pending 期间复制会漏掉直刷字符——**既有边界**（复制前宿主应先 flushStream；C3 宿主协议本要求复制走 flush 时机，`MarkdownEngine.tsx:876-881` 注释口径），本方案不改变。 |
| 装饰维护链路（R5-D/R6-C，`MarkdownEngine.tsx:512-524`、`DecorationSet.ts:250-265`） | 降级帧的选区平移走既有 appendText 契约 → 装饰增删 → 行版本 bump（R6-C）——与「非纯文本行流式」现况同构，无新交互。 |

---

## 4. 性能

- **B 判定成本**：每 `streamAppend` 一次——`lineOffsets.getOffset(lastIdx)`（O(log n)，`SegmentTree` 二分）或直接复用快照 + 末行区间与选区/光标比较（O(1) 数字比较）。**无选区且光标不在末行 = 一次数字比较，零 DOM/测量/调度新增**；无选区帧（绝大多数流式帧）零额外开销。
- **A 兜底成本**：每次 flush 后两次数字比较（越界检测）；仅在越界时 setState（O(1)）——正常路径零分配。
- **降级帧成本**（预期取舍，诚实登记）：选区/光标在末行的帧从「textContent += 直写」退化为「appendText 常规提交」——每 chunk 一次 store 提交 + 末行渲染 + SelectionHighlight 整组 rect 重测（`SelectionHighlight.tsx:111-149` 对已挂载行全扫）。该成本只发生在「用户正在选中/编辑流式末行」的帧，与「非纯文本末行流式」现况同一量级，属既有性能基线。
- 不引入 RAF/节流/防抖/新测量缓存——方案全程无新增热路径设施。

---

## 5. 测试方案

门禁对齐：`npm test`（vitest run tests/unit）+ 主仓库 tests/e2e 下 5 个 markdown-editor 专项 spec 回归保留（AGENTS.md 铁律）。

### 5.1 单元测试（vitest jsdom，仿 `tests/unit/drag-select.test.ts` 组件挂载模式）

1. **判定纯函数矩阵**（导出 `shouldDirectStream`）：折叠光标在末行行外 / 行尾（=直刷）/ 行中（=降级）；非折叠选区在末行之前 / 跨行尾部探入末行 / 完全在末行内 / 反向选区；readOnly 恒直刷。边界：末行区间为空、末行起点恰为选区终点（不重叠）、选区恰为 [末行尾, 全文尾]。
2. **组件级降级断言**：挂载 MarkdownEngine（ref 取 streamAppend）+ store 设选区与末行相交 → `streamAppend` → 断言 `data-streaming-dirty` 不存在、store 已提交（`getText` 含 chunk）、选区按 appendText 契约平移（= 常规路径行为）。
3. **直刷保留断言**：选区在末行之前 / 光标不在末行 → `streamAppend` → 断言 `data-streaming-dirty` 存在、store 滞后 → `flushStream` 后收敛（DOM 与 store 一致、选区不动）。
4. **A 兜底钳制**：构造 `selectionEnd > textLength`（模拟 `handleSelectionChange` 无钳制写入路径，`HiddenInput.tsx:878-882`）→ `streamAppend` + flush → 断言 `selectionEnd === textLength`，高亮消费不落空。
5. **拖选 + 流式并发**（仿 drag-select.test 序列）：mousedown → mousemove 激活拖选（head 进入末行）→ 期间 streamAppend → 断言每 chunk 降级（store 同步）、`moveHead` 无钳制滞后（head 可达新文本末端）。
6. **光标在末行行中降级**：光标在末行中部（活跃编辑态）→ `streamAppend` → 降级（修复 §1.2 问题 6，断言无行尾直刷）。
7. **无选区零开销形状**：光标在首行 → 直刷路径生效（dirty 标记出现），且 decorationVersion 不因直刷递增（无选区平移 → 无额外版本 bump）。

### 5.2 端到端视觉断言（Playwright，宿主驱动流式）

1. **直刷中拖选不打断**：宿主持续 streamAppend + 用户拖选到末行 → 断言末行无 `data-streaming-dirty`（降级生效）+ 高亮 rect 序列连续（rAF 逐帧采样 `.selection-rect` 数量与位置，无 0 宽/消失中间帧）。
2. **选中区域降级路径**：选区在末行 → 流式继续 → DOM 文本与 store 逐 chunk 同步。
3. **恢复零跳动**：拖选离开末行 → 直刷恢复 → flush → 断言 rect 序列无跳变帧（既有无选区帧零开销反向证明）。
4. **无选区零开销（反向控制组）**：光标在首行 + 流式 → `data-streaming-dirty` 出现（直刷生效）——与用例 1 互为镜像，证明判定选择性生效。

---

## 6. 风险与边界

- **降级性能取舍**是 B 的固有语义（选中/编辑末行期间每 chunk 常规提交）——若后续实测发现该场景吞吐不可接受，可细化降级条件（如仅「选区锚点在末行内」才降级、选区只是尾部探入时只对探入部分保守），列为后续增强，不在本轮范围。
- FindReplacePanel 替换 Enter 与直刷 pending 的竞态（§3 发现项）在「命中不在末行」时仍存在——登记为遗留发现项，建议宿主在替换前显式 `flushStream()`（宿主侧一行），或后续轮次处理。
- readOnly 下 pending 期间的复制漏字（§3）为既有宿主协议边界（复制前 flush），本方案不改变。
- 拖选「head 即将进入末行但尚未」的 1-2 帧仍可能直刷（判定是 chunk 粒度的）——无用户可感知影响（该区域尚未被选中），语义安全。

---

## 7. 回报摘要（给主 Agent）

- **结论**：直刷期间选区的四大破坏路径（head 钳制滞后、rect 滞后跳变、拖选中 flush 错位、原生轨越界写坏）均已在 §1.2 定位到文件:行号；readOnly 原生轨天然自愈，保护只针对编辑态。
- **推荐**：方案 D = B（选区感知直刷，`canDirect` 加 `shouldDirectStream` 纯函数，相交/光标行中降级走既有回落路径）+ A 兜底（flush 后选区越界钳制 O(1)）。C（冻结高亮）因拖选跟手性冲突否决。无选区帧零开销。
- **交互清单**：dirty 协议零改动；拖选状态机无需跨组件暴露（head 钳制位自动命中相交判定）；顺带修复 FindReplacePanel 替换 Enter 竞态的末行分支；发现遗留项两项（替换竞态非末行分支、readOnly pending 复制漏字）。
- **产出**：`reference/markdown-editor/docs/analysis/plan-A3-选区保护.md`（UTF-8 无 BOM）。
