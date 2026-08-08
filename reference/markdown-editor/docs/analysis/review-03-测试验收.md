# 审查报告 03 · 测试与验收维度——门禁体系与集成前验收门槛可执行性审查

> 审查人：方案审查 Agent 3（测试与验收维度）
> 审查对象：`docs/analysis/03-测试门禁体系.md`（G1-G10）、`docs/analysis/08-方案优化补充.md` §2（集成前验收门槛）
> 证据基线：`tests/unit`（25 文件 126 用例，已实测）、`tests/e2e`（18 spec 28 用例，已实测）、`package.json`、`playwright.config.ts`、`src/main.tsx`、`src/core/*`、`src/components/*`
> 审查方式：纯只读 + 源码/配置/测试逐项核验（行号均在本仓库核实）

---

## 0. 总评

| 维度 | 结论 |
|---|---|
| 总体设计 | **可行类**。九类门禁分层（U/R/C/E/P/M/X）合理，"黑箱/灰箱/白箱"三级断言强度与现有代码（data-* 映射、verifyConsistency、__CRISH_METRICS__）匹配，不破坏现有 126 例的融合策略正确 |
| 必须修正 | ① I5 不变量与 undo 合并/appendText 语义冲突（设计错误）；② CommonMark spec.txt 源不存在（引用失效）；③ R1 虚拟化测试方案有技术漏洞（window.innerHeight 无效、缺 ResizeObserver 方案） |
| 不可测项 | ① 08 §2-3"滚动条准确性 < 1 行"（无独立行高预测器）；② I2 的"行末边界往返"需明确定义 |
| 量级现实性 | G1/G2/G3/G4/G6 现实；G5 的"单例 <50ms 总量 <60s"存疑（652 例 × 全量断言）；G8 帧采样量场景描述不足 |

---

## 1. G1-G10 各类逐项审查

### 1.1 G1 core 不变量 unit（U1）——可行类

**可执行性结论**：断言点具体、与源码逐行对上号（`tokenCoverage` 依据 `ast.ts:54-55` 的 localOffset/length 全位置信息；LRU 门禁依据 `parser.ts:86` 的 50_000；bailout 依据 `parser.ts:720` 的 `depth > 20`；code-state 交叉校验依据 `parser.ts:31-84` 与 `EditorStore.ts:179-319` 双实现并存）。

**问题**：
1. `code-state-cross-check.test.ts` 断言"编辑后收敛终态一致"，但 `updateLinesIncremental` 的收敛是"最终一致"而非"逐步一致"——用例必须等待/强制同步路径完成，否则把"中间态"误判为违例。现有 `codestate-convergence.test.ts` 全是同步断言，说明同步路径可断言，但需在 helpers 中固化"操作后即收敛"的语义假设。
2. 命名规范只写了"维持 `tests/unit/*.test.ts`"，未规定新用例文件命名与 `@白箱-结构敏感` 标记的检索方式（如何保证重构评审时找得到标记）。

**修正建议**：
- helpers.ts 增加 `assertConverged()`（断言 codeBlockState 与 computeLineOffsets 一致 + verifyConsistency）作为统一入口，避免各用例自行断言中间态；
- 明确 `@白箱-结构敏感` 注释格式（如 `// @白箱-结构敏感: undoStack.length`），并在 P7 固化阶段加一个"扫描残留标记"的门禁脚本（标记清空即白箱改造完成）。

### 1.2 G2 属性测试（U2）——需修正类（不变量设计错误）

详见第 3 节（I5 两处设计错误为必须修正项）。生成器/操作库/种子机制本身可执行，超时预算 30s/组在 200 行文档量级下现实。

### 1.3 G3 渲染层 RTL（R1）——需修正类（技术方案有漏洞）

详见第 4 节。断言点清单与 `InlineRenderer.tsx:140-219`、`SelectionHighlight.tsx:64-67`、`MarkdownEngine.tsx:25-41` 等源码逐条核对成立，但 jsdom 环境方案有两个技术漏洞。

### 1.4 G4 行为契约（R2）——可行类

**可执行性结论**：六文件断言点全部黑箱化可行。`undo.test.ts:13`（`undoStack.length`）与 `chunk.test.ts:13`（`lines.length===1000` 中间态）白箱反例已实锤（本审查已读原文件确认）。"移入 unit 白箱专档"方案正确。

**问题**：
1. `store-undo-contract.test.ts` 与 I5 同源：合并策略（`undo-merge.test.ts` 证实存在）下"每次操作产生一步 undo"的直觉不成立——契约必须按"合并后步数"建模，且不能用 `undoStack.length` 断言。
2. `chunk.test.ts:13` 断言"setText 后立即 1000 行"依赖分块加载时序（`chunk.test.ts:15-16` 靠 200ms 定时器）——该中间态是**异步时序耦合**，比 undoStack 更脆弱：CI 慢速下 200ms 不够会 flaky。改造时应把"分块加载"作为黑箱契约（setText 后最终全量 + 中间任意时刻 verifyConsistency），而不是搬走中间态断言就完事。

**修正建议**：chunk 的 200ms 定时器断言建议同步改为轮询等待（vitest `vi.waitFor`），或把分块大小/时序暴露为可注入参数。

### 1.5 G5 CommonMark（C1）——需修正类（源失效）

详见第 2 节。

### 1.6 G6 CSS 契约（C2）——可行类（执行细节需补）

**可执行性结论**：class-inventory 静态扫描可行（`MarkdownEngine.tsx:75` 的 `.trim()` 拼接含静态部分、`InlineRenderer.tsx:184-188` 的 `${className} is-active-token` 静态后缀均可正则提取）；style-contract 注入 `<style>` 后 jsdom `getComputedStyle` 可用。

**问题**：
1. **jsdom 的 flex 简写解析能力有限**：断言 `flex: 1 1 0%` 时 `getComputedStyle(el).flex` 在 jsdom 返回空/未展开，应断言 longhand（`flexGrow/flexShrink/flexBasis`）或直接查 `styleSheets[].cssRules` 文本。
2. class-inventory 是"过弱"检查：正则漏提取的 className 不进集合 B，就不受 A ⊇ B 保护——声明局限即可，但要防止误报把 `data-*` 属性值当 class（`data-token-start` 等含连字符，正则需限定 `className=` 上下文）。
3. 量级 ~30 用例偏高：扫描类断言 1-2 条即够，其余应放行到 style-contract 的关键契约（CSS 变量完整性、syntax-hidden 可见性等）。不是错误，仅量级标注。

### 1.7 G7 运行时 Playwright（E1）——可行类（两个执行缺口）

**可执行性结论**：新增 spec 的断言点均可在真实浏览器实现；`__CRISH_SESSION_STORE__` 注入范式有现成先例（`table-mixed-rendering-matrix.spec.ts:17-19`）；fuzz-thrash 升级有依据（`fuzz-thrash.spec.ts:44` 仅断言无错误）。

**问题**：
1. **CI 上 e2e 的 dev server 接线缺失**：`playwright.config.ts:2-4` 无 `webServer` 配置，e2e 依赖手动启动 `localhost:5174`。03 §12.7 说"CI slow 跑 E1 全量"但未给 webServer 方案——CI 上必须 `webServer: { command: 'npm run dev', port: 5174, reuseExistingServer: true }`（或 build+preview），否则 CI slow 层无法执行。
2. "组合期文本不落入 undo 栈"是白箱断言（读 undoStack）——可黑箱化：组合结束后连续 undo 直到空栈，断言文本回到组合前。建议按黑箱写。
3. golden-structure 序列化比对需规范化（class 排序、忽略 style/事件属性），文档未写明序列化字段白名单——不写明则首次落地必然 flaky。

### 1.8 G8 性能门禁（P1）——需修正类（CI 稳定性方案不完整）

详见第 5 节。

### 1.9 G9 内存门禁（M1）——可行类

`cache-bounds`（50_000 上限，`parser.ts:86` 实锤）、`lru-eviction`、`store-leak`（fenceLines 单调 ≤ lines 数可测）均可执行；heap-growth 划 nightly 正确。注意 `store-leak` 的"undoStack ≤ 500"依赖合并策略步数上限——合并策略在极端序列（每次光标移动打断合并）下步数可能超过 500，断言需按"实际操作步数的合并后上限"计算而非硬编码 500。

### 1.10 X1 交叉矩阵——可行类

LHS 正交表抽样 24 组合理；断言复用 I1-I9 子集 + verifyConsistency 可执行。唯一提醒：`page.evaluate` 调 store 是同步操作，而 React 渲染是异步的——每 20 步 verify 的是 store 而非 DOM，DOM 行数一致性断言需等待 rAF 后采样。

---

## 2. G5 CommonMark 套件接入——需修正类（源失效 + 投影器防作弊性）

### 2.1 致命问题：spec.txt 源不存在

**实测证据**：仓库中 `compare/` 目录不存在、`test/cmspec/` 不存在、全仓库（含 node_modules）无任何 `spec.txt`、`node_modules/markdown-it` 不存在。03 文档 §0 声称"`compare/markdown-it/test/fixtures/commonmark/spec.txt` 652 个 example（已用 node 实测计数）"与 §6.1"由 compare 路径拷贝为自包含"——**引用路径全部失效，"实测计数 652"不可复核**。

**影响**：G5 是 08 §2 验收项 1 的判定基础，源失效则整个门禁无从谈起。

**修正建议**：
1. 从 CommonMark 官方仓库（spec.commonmark.org / commonmark/commonmark-spec 0.31.2）下载 `spec.txt` 入库为 `tests/commonmark/spec.txt`，记录来源版本与 sha256；
2. 编译产物 `spec.json` 的生成脚本必须验证 example 数（0.31.2 为 652 例）并断言 section 清单完整性，防止下载错版本；
3. 若坚持离线自包含，编译脚本 `scripts/compile-commonmark.mjs` 需支持"spec.txt 缺失时明确报错并给出获取命令"，不能静默。

### 2.2 astToHtml 投影器"零语义修复"的可执行性

**可执行性结论**：投影器作为独立于引擎的测试工具，把 AST 折叠为近似 HTML，是"语义级比对"的正确思路——直接比 HTML 会产生渲染差异噪音的判断成立（引擎无 HTML 渲染器，`BlockRenderer.tsx:61` switch 是 DOM 渲染而非 HTML 序列化）。"AST raw 拼接 == 原文"的文本保真次级断言（对所有 652 例无条件执行）是优秀的防丢字兜底。

**问题**：投影器本身是语义决策者——"线型→块标签、行内 token→span、content!=raw 只保留 content"这些折叠规则里**隐含了对 CommonMark 语义的解释**（如 emphasis 的 delimiters 折叠、code fence 的信息串处理、HTML block 的直出判定）。投影器写错会导致 PASS/FAIL 判定失真，而"自检：652 例 parse+序列化不崩溃、无缺失段"只保证不崩溃，**不保证投影器语义与 CommonMark 期望一致**——存在"投影器把语义错误折叠成与期望 HTML 恰好一致"的假阳性风险。

**修正建议**：
1. 投影器增加第三层自检：对每个 example，`astToHtml(parse(md))` 的**文本节点拼接（去标签）应等于 md 的纯文本展开**（这能抓折叠丢字，但对语义重组不敏感）；
2. 对"语义折叠决策点"（delimiter 处理、转义、HTML block 直出）用**人工评审过的 20-40 例"黄金判定对"**做投影器级测试（断言投影器输出与人工判定一致），把投影器本身的正确性锚定住——否则 KNOWN_FLAW 归类建立在不可信投影器上；
3. 投影器不得依赖引擎内部结构（只吃公开 AST 类型 `LineNode[]`），并在文件头注释声明"测试工具，非引擎产物"。

### 2.3 KNOWN_FLAW 归类的防作弊性——基本成立，需补三处

**可执行性结论**："首次 baseline 全量归入 KNOWN_FLAW + 此后只允许 PASS 增长 + 核心子集 0.99 硬门槛 + baseline 更新走评审"的机制**防的是"新增缺陷被豁免"**（回归即红），这个防作弊方向正确且可强制。

**问题**：
1. **首次豁免范围过大**：12.5"首次提交 baseline 时把当前失败例全部归入 KNOWN_FLAW"意味着第一版 baseline 可以把任何失败都豁免——防作弊性取决于"成因分类"是否可核验。若成因分类只是字符串（如 `reference-link-unsupported`），无法阻止"把 PASS 能修的问题懒写成 KNOWN_FLAW"。**必须有机器可核验的证据**：baseline 每例记录 `{exampleNo, actual: astToHtml 摘要, expected: 期望 HTML 摘要}`，KNOWN_FLAW 评审时 diff 可见。
2. **核心子集 section 清单未定义**："标题/段落/强调/代码围栏/列表/块引用/转义"是自然语言描述，spec.txt 的 section 名（Thematic breaks / ATX headings / Setext headings / Indented code blocks / ...）需要编译脚本产出**显式 section 白名单**（哪些 section 计入 0.99 硬门槛），否则"核心子集"在评审时无法逐例判定。
3. **PASS 数 ≥ baseline.PASS 的量化口径**：`astToHtml` 归一化空白后比对，"规范化"规则（空白折叠/换行归一）必须写死并随 spec.json 一起入库，否则比对结果不可复现。

**修正建议**：baseline.json schema 增加 `{exampleNo, section, category, expectedSummary, actualSummary}` 五字段；核心子集白名单在编译脚本中显式列出；规范化函数入库并单测。

### 2.4 量级估算存疑

"单例 <50ms，总计 <60s"：652 例 ×（parse + 投影 + 规范化 + 比对），parse 含 LRU 缓存预热，投影器若为 O(行内 token) 纯函数，50ms/例是乐观值。**建议 P3 阶段先实测 20 例取均值再定预算**，预算写入 `budgets.ts` 而非文档。

---

## 3. 属性测试（G2）不变量 I1-I9——需修正类（I5 设计错误，必须改）

### 3.1 逐条可断言性结论

| 不变量 | 断言性 | 问题 |
|---|---|---|
| I1 token 覆盖守恒 | ✅ 可断言 | 依赖 `helpers.ts` 的 tokenCoverage 实现，table 递归是难点（table_row 的 raw 含分隔符，需按 table_cell 子结构累加）——可测但实现成本高，列为 P0 交付物合理 |
| I2 offset 一致 | ✅ 可断言（注意行末） | `findLineIndex(getOffset(i))==i` 在**行末边界**可能歧义：offset 恰好等于某行末+1（即下行星首）时 findLineIndex 返回哪一行取决于实现（`SegmentTree.ts:104`）。断言方向（getOffset→findLineIndex）正确，但**建议跳过行首/行末 ±1 边界处**或显式定义"取行首"语义 |
| I3 textLength 一致 | ✅ 可断言 | `lines.join('\n').length` 与 textLength 双轨比对正确；注意空文档（1 行空行）时 join 为 `''`，语义需注释 |
| I4 fence 与独立重扫一致 | ✅ 可断言但**成本最高** | 每步全量 `computeLineOffsets`（parser.ts:31 是 O(全文) 重扫），200 步 × 200 行在属性测试里是最大耗时项。文档把 I4 列进"每步全量"（I1-I5 每步）——建议降为"每 10 步 + insertText/deleteText 后必查"，与 I6-I9 同频 |
| I5 undo 恒等 | ❌ **设计错误，必须改** | 见 3.2 |
| I6 图素往返 | ✅ 可断言 | `findNextGraphemeBoundary/findPrevGraphemeBoundary`（`EditorStore.ts:11-120`）在滑动窗口 50 起步、倍增扩窗——**窗口边界图素**（组合字符跨窗口）正是随机序列要抓的，I6 价值高。注意：程序化越界位置（半代理字中间）上"删除一个图素"的语义是"先 snap 再删"，断言需按 snap 后位置计算期望，不能直接按原位置算 |
| I7 parse 确定性/不崩溃 | ✅ 可断言 | "fence_start/end 成对出现"注意悬空 fence 场景（DocGen 设计 fence 闭合概率 50% 是故意的）——**悬空 fence 下"成对"断言必须定义为"fence_start 数 ≥ fence_end 数且差额 ≤1"**，否则与生成器设计自相矛盾。这是文档内两处（3.1 与 I7）的隐含冲突，需显式对齐 |
| I8 缓存语义透明 | ✅ 可断言 | 注意 LRU 命中返回的节点是**同一引用还是深拷贝**——若返回同一对象，断言需冻结后比对而非再入缓存读（否则永远"相等"）。实现细节需 P0 时确认 |
| I9 长行不变量 | ✅ 可断言 | `MAX_PARSE_CHARS=10_000`（parser.ts:511）与 `truncation-indicator`（`BlockRenderer.tsx:334`）实锤存在；"截断点前后 raw 拼接 == 原文本"需定义截断点位置（parser 输出 `unparsed` token 的 localOffset，`parser.ts:521-526`） |

### 3.2 I5 设计错误详析（必须修正）

**错误 1：与连续输入合并策略冲突**。`undo-merge.test.ts` 与 `undo.test.ts:23-36` 实锤：连续 insertText 合并为单步 undo。I5 断言"任一步后 `undo()` 得回上步文本与选区"——在合并窗口内第 2、3 步后 undo 回到的是"合并前"而非"上一步"，**必然失败**。

**错误 2：与 appendText 语义冲突**。`appendText` 显式不进 undo 栈（`EditorStore.ts:520` 注释"不进 undo 栈"）。OpGen 操作库含 `appendText(7)` 权重——appendText 步后 `undo()` 回到的是"append 前状态"，是两步前的快照，且若序列是 `insertText→appendText`，undo 后文本与"上一步"（append 后）必然不同。

**修正建议（黑箱化）**：I5 改为**参考模型对比**——测试维护一个朴素参考 store（或记录操作前缀快照序列）：
- 对每步操作 `op`：记录 `pre = getText()+选区`；
- `undo()` 后断言：`getText() == 最近一次进入 undo 栈的操作的 pre`（合并/append 语义由**参考模型同步重放**得到，而非直觉"上一步"）；
- 简单可行版：把 I5 拆为两条——(a) `undo()` 不抛异常且文本属于历史快照集（集合成员断言，弱）；(b) **参考模型重放版**（强，推荐）：参考 store 用同一套 API 但朴素实现（无合并），每步在两边同步执行，undo 语义逐层对齐。参考模型本身独立实现，正是属性测试的标准做法。

### 3.3 其余执行性

- "断言失败打印步号+种子+最小化路径"：需在 invariants.ts 中内置记录器（操作前缀数组 + bisect），vitest 单测里可用 `expect(state).toSatisfy(...)` 配合自定义 message——可执行，建议失败时输出**可复现的最小序列**（种子 + 前缀长度）而非全序列；
- 超时预算 30s/组：在 I4 降频、文档 ≤200 行前提下现实，但 CI fast 同时跑 U1+U2 的 10 组种子，建议 CI 上 U2 用 6-8 组种子、nightly 100 组，CI 总时长控制在 3-5 分钟内。

---

## 4. 渲染层 RTL（G3）——需修正类（两个技术漏洞）

### 4.1 可执行性结论

断言点清单与源码逐条核对成立（`InlineRenderer.tsx:184-219` 的 is-empty-token/三件套/math data-sub-offset、`SelectionHighlight.tsx:64-67` 的 5px 兜底、`MarkdownEngine.tsx:157-164` 的 table separator 重定向、`MarkdownEngine.tsx:181-194` 的 caretRangeFromPoint 兜底分支均实锤）。"测量函数不进 RTL 契约、坐标语义交给 G7"的边界划分正确——`getCoordinatesFromIndex`（measure.ts:1-40）依赖布局且 querySelectorAll 全扫，进 RTL 必然假绿/假红。

### 4.2 漏洞 1：`window.innerHeight` 无法控制 virtualizer 视口

`useVirtualizer`（MarkdownEngine.tsx:103-116）读取的是 **scrollElement（`.editor-container`）的矩形**，不是 `window.innerHeight`。jsdom 中容器 `height:100%` 解析为 0，`getVirtualItems()` 只会渲染 0 行或极少行。文档方案"设 window.innerHeight 覆盖所有行"**无效**。

**修正**：helpers 中 stub `Element.prototype.getBoundingClientRect` 按选择器返回确定性尺寸——`.editor-container` 返回 `{height: N×28px}`（N=测试行数），其他元素返回 28px 行高。配合 scrollTop=0，首屏行即可覆盖全部目标行。同时 `ResizeObserver` 在 jsdom 未实现，@tanstack/react-virtual v3 的 `observeElementRect` 依赖它——**必须 polyfill**（空实现 + 手动触发一次初始回调即可），文档未提。

### 4.3 漏洞 2：`measureElement` 在 jsdom 的行为

`LineItem` 的 `ref={measureElement}`（MarkdownEngine.tsx:74）在 jsdom 下会真实调用（stub 后 rect 固定），但行高永远等于 stub 值——**R1 断言"data-index/data-line-start/data-line-length 与 store 一致"**不受影响（这些来自数据而非测量），但**任何依赖行高差异的断言（如 heading 46px 与普通行 28px 的排列）在 RTL 中无区分度**。文档断言点里恰好没有这类断言（grep 全文未见 heading 行高断言）——确认无此依赖即可，但要写注释防止后人添加"布局依赖断言"。

### 4.4 其余问题

1. **selection-highlight 的坐标断言**：`startCoord.left` 来自 `getCoordinatesFromIndex` 的 querySelectorAll 扫描 + stub rect。若 stub 对全元素返回相同 left=0，"首行 left == startCoord.left"恒真无区分度——**stub 必须按元素位置返回不同 left/top**（helpers 里按 `data-index`/`data-line-start` 计算确定性坐标），文档写了"提供确定性坐标"但未写"按元素区分"，需在 helpers 规格中固化。
2. **`caretRangeFromPoint` 的 stub 逻辑**：文档已覆盖"返回 null 走 fallback"（简单），但"点击 token → cursor == token start + subOffset"需要按点击坐标返回**指向特定文本节点**的 Range——stub 复杂度高。建议先实现"stub 返回 null + fallback 路径"（覆盖 90% 逻辑），精确路径放 G7 e2e 覆盖，R1 只做"点击已渲染 token 元素 → cursor 落在该行内"的弱断言。
3. **katex 在 jsdom**：`renderToString` 纯字符串渲染可行，但 katex 的字体/布局 API（`getComputedStyle` 字体度量）在 jsdom 部分缺失——断言只做 `.katex` 存在性 + 公式文本，不做度量（文档已是此口径 ✓）。

---

## 5. 性能门禁（G8）——需修正类（CI 稳定性方案不完整）

### 5.1 可执行性结论

指标基建合理：`__CRISH_METRICS__`（main.tsx:26-30）已实锤接线 layoutThrashCount/getCacheStats/getLineCount + rAF 逐帧哨兵（main.tsx:32-58，5 次报错语义，G8 上浮到 8 有依据）；spec 侧 `addInitScript` 包 rAF/PerformanceObserver 不污染生产代码 ✓；budgets.ts 统一常量 ✓。降档思想正确（无显示器/慢速环境降档执行）。

### 5.2 问题与修正

1. **"降档"的判定条件未定义**：headless 就是无显示器，但本地开发跑 headless 与 CI runner 负载完全不同——"CI 无显示器时降一档"无法自动判定。**修正**：显式以环境变量驱动（`CI=true` 或 `PERF_TIER=ci|nightly|local`），spec 启动时读取并选择档位，档位映射写在 budgets.ts 且 CI 配置文件显式设置。禁止运行时探测"无显示器"（不可靠）。
2. **共享 CI runner 上帧率断言仍不稳**：CPU steal 会造成偶发 >33ms 帧，p95 <33ms 在共享 runner 上仍可能 flaky。**修正建议**：
   - CI 档改为**以长任务计数 + 中位数帧间隔为主**（p50 <16.7ms 在负载下更稳），p95 仅 warn 不 fail；
   - 或 CI 档只跑 `long-task`（>50ms 计数，与帧率解耦）与 `parse-budget`（纯 CPU 耗时，在 Node 单线程下相对稳定），帧率 p95 门槛只 nightly 真机执行——nightly 失败次日修复，不阻塞合并（见 5.3）。
3. **300 帧采样量 vs 场景描述矛盾**："滚动 2000px、输入 100 字符、切换光标行"单轮约 1-2 秒 = 60-120 帧，**不足 300 帧**。**修正**：采样段描述改为"滚动往返 3 轮 + 输入 100 字符 + 光标切换 20 次"（≥5 秒），或把门槛改为"≥120 帧采样"并提高 p99 灵敏度。需在 spec 中固定采样段长度。
4. **layout-thrash 的帧内计数在 CI 慢速下的漂移**：`layoutThrashCount` 是全页面累计计数（main.tsx:48），"滚动连续 1s 内 <3000 次"需在 spec 侧自己起计时窗口采样差分——可执行，但注意 main.tsx 的 `getBoundingClientRect` 包装是**生产代码内的打点**，spec 侧直接读 `__CRISH_METRICS__.layoutThrashCount` 差分即可 ✓（已有设计），无需改动生产。
5. **parse-budget 的 16ms 增量门槛**（输入 1 字符重 parse）："rAF 帧内完成"依赖真实浏览器调度，CI 慢速下 16ms 内完成也不保证帧渲染——建议该条移到 nightly 或放宽为 <32ms（CI 档），否则必 flaky。

### 5.3 nightly 阻塞合并的问题（03 §12.7）

"门禁任何一层失败即阻塞合并"——**nightly 阻塞合并不合理**：nightly 含多种子属性测试（偶发失败）与像素金样（跨平台字体敏感），若阻塞合并则等于把 nightly 当全量 CI，而 nightly 的价值正是"预警 + 次日修复"。**修正**：fast/mid/slow 阻塞合并；nightly 定义为"次日 12 点前必须修复"的预警线；像素金样只在指定 OS（如 ubuntu-latest）跑并固定字体。

---

## 6. 08 §2 集成前验收门槛——不可测项 1 项，口径冲突 2 处

| # | 验收项 | 可测性 | 结论 |
|---|---|---|---|
| 1 | CommonMark ≥0.99 核心子集 + 全量增长 | 可测（G5 门禁，但依赖第 2 节修正落地） | 可行类 |
| 2 | 解析器健壮性 | 可测（I1/I7/I9 + 时间预算断言）；"失败规则记忆"机制在 03 文档无对应定义，需在 R1 任务书明确 | 可行类（需补定义） |
| 3 | 滚动条准确性 < 1 行 | **不可直接测**：无独立行高预测器。"树预测行号"无实现——LineOffsetTree 是 offset 树非行高树；行高由 estimateSize（MarkdownEngine.tsx:106-115）+ measureElement 实际值共同决定，文档未定义"预测器" | **不可测项，需替代** |
| 4 | 帧率档位（百万行 60fps、500 token/s 流式 60fps） | 可测（G8，见第 5 节修正） | 可行类 |
| 5 | 流式三件套 + 编辑语义 | 可测（unit + e2e：append 尾段访问器、直刷 dirty 行 flush、stop-flush） | 可行类 |
| 6 | 测试网 G1-G5 + 门禁总量 ≥126+120-140 | 部分可测（数用例可行，但**数量不是质量闸门**，可玩"凑数"） | **需修正（见 6.3）** |
| 7 | 稳定回归（全绿/编译/编码/工作区） | 可测 ✓ | 可行类 |

### 6.1 验收项 3 的替代方案（滚动条准确性）

**替代 1（推荐，黑箱可测）**：滚动到 `scrollTop = totalSize/2` 后，取首屏首个 `.virtual-row` 的 `data-line-start`，断言其对应文档 offset 与 `textLength/2` 的偏差 ≤ 2 行（含 virtualizer 的 overscan 缓冲）。这测的是"虚拟窗口内容与滚动位置的映射精度"，即滚动条准确性的可观测代理。
**替代 2（灰箱）**：断言 `virtualizer.getTotalSize()` 与"Σ measureElement 实际高度（页面 evaluate 统计首屏 + 采样行）"的相对误差 <1 行高度。依赖 tanstack 内部状态，标记灰箱。
**替代 3（消除抖动）**："无测量回环抖动"可测：连续 10 次滚动 100px 往返后，同一 `data-line-start` 的位置（getBoundingClientRect().top 差）稳定 ±1px——这是布局稳定性的直接断言，建议独立成 spec。

### 6.2 口径冲突 1：新增用例数（120-140 vs 300+）

08 §2-6 说"门禁总量 ≥ 现有 126 + 新增 120-140"，但 03 §1 分层总表的量级合计：G1+74、G2 40、G3 60、G4 40、G6 30、G7 ~50、G8 15、G9 8、X1 20（G5 的 652 另计）——**非 CommonMark 部分即约 337 个**，远超 120-140。**两文档数字互相矛盾**，必须统一口径。若 08 意图是"新增快速层（G1-G2）120-140"，请改写表述。

### 6.3 口径冲突 2：核心子集 0.99 的时间点

08 §2-1 把 CommonMark 验收标 R1（正确性轮），但 03 §6.3 说首次接入基线预期 40-55%、**三个月内目标 ≥60%**——若 R1 末位就要 0.99 核心子集，与"三个月 60%"的口径冲突。**必须澄清**：核心子集 0.99 是 R1 末位硬门槛（合理，因为核心子集是引擎已实现语义），全量 60% 是三个月成长线。建议在 08 §2-1 注明"核心子集清单以 tests/commonmark 编译脚本的 section 白名单为准"。

### 6.4 验收项 6 的修正（数量门槛 → 能力清单）

"门禁总量"数字门槛可玩"写废用例凑数"。**修正**：验收改为两层——(a) 数量底线（防滑向零测试）：it() 总数 ≥ 目标线；(b) **断言点覆盖清单**（防凑数）：03 §2/§4/§5/§6/§7 表格中的每一行断言点必须有至少 1 个用例映射（P7 固化阶段做一个"断言点清单 → 测试用例"的追踪表入库）。质量由 (b) 保证，数量由 (a) 防退化。

### 6.5 验收项 2 的补充

"2^n 爆炸修复（失败规则记忆）"：03 文档无此机制定义（parser.ts:720 的 depth>20 bailout 是既有防御，不是"失败规则记忆"）。R1 任务书必须定义该机制并配测试（如"重复相同失败输入不重复全量回溯"的性能断言）。

---

## 7. 测试资产入库机制——可行类（现状良好，补 3 处）

### 7.1 现状验证（实测）

- `git ls-files reference/markdown-editor` 154 文件已跟踪，其中 `tests/` 91 文件已入库；`git check-ignore` 对 `tests/unit/undo.test.ts` 与 `docs/analysis/03-测试门禁体系.md` **均无命中**（未被忽略）✓
- reference 目录的 `.gitignore` 只忽略 node_modules/dist 等 ✓
- AGENTS.md 铁律（新增测试立即 git add、禁止未跟踪遗留）已生效且与仓库状态一致 ✓

### 7.2 新增资产入库要点（03 §12.4 补充）

1. **spec.txt / spec.json 入库**：652 例 spec.txt 约 900KB、spec.json（含 markdown+html 全文）约 2-3MB——入库可接受（自包含可复现），但必须记录来源版本 + sha256，并在编译脚本输出头注释来源；若仓库体积敏感，可只入库 spec.txt（raw）让编译脚本生成 spec.json 且产物不入库（但 CI 需可重复编译——建议全入库，简单一致）。
2. **baseline.json 入库是防作弊锚点**：首次提交必须与 spec.json 同 commit，且提交信息注明成因分类统计（防"顺手改 baseline 不改代码"）。
3. **goldens/ 与 budgets.ts 入库**：金样 JSON 与性能常量同入库；`UPDATE_GOLDENS=1` 重写后必须显式 diff 审查再提交（03 §8 已有此规，需写入 AGENTS.md 铁律扩展，与现有"测试是资产"条款并列）。

### 7.3 风险提示

本审查报告自身与 03/08 文档同目录（`docs/analysis/`），按 AGENTS.md 铁律，本报告不 commit（用户指示）；但后续修订 03/08 时，新增的共享模块（helpers/generators/invariants/astToHtml）必须在创建当次会话内 git add，防止"未跟踪遗留"事故重演。

---

## 8. 结论摘要

### 可行类（8）
G1 加固、G4 契约、G6 CSS 契约、G7 e2e 扩展（补 2 执行缺口）、G9 内存、X1 交叉矩阵、08 §2 的项 1/2/4/5/7、测试资产入库机制（现状良好）。

### 需修正类（7）
1. **G2-I5 不变量设计错误**（与 undo 合并/appendText 冲突）——改为参考模型重放；
2. **G5 spec.txt 源失效**（compare/ 不存在，652 计数不可复核）——重新获取官方 spec 入库 + sha256；
3. **G5 投影器防作弊**——补"黄金判定对"投影器级测试 + baseline 记录实际/期望摘要；
4. **G3-RTL 虚拟化方案**——window.innerHeight 无效，改 stub 容器 rect + ResizeObserver polyfill；
5. **G8 CI 稳定性**——降档判定显式化（环境变量）、CI 档以中位数/长任务为主、采样段 ≥300 帧修正、nightly 不阻塞合并；
6. **08 §2 口径冲突**——新增用例数 120-140 与 03 的 300+ 矛盾；核心子集 0.99 时间点需澄清；
7. **验收项 6 数量门槛**——补"断言点覆盖清单"追踪表防凑数。

### 不可测项清单（2）
1. **08 §2-3 滚动条准确性 < 1 行**（无独立行高预测器）——替代：scrollTop 50% 处首屏行 data-line-start 与 textLength/2 偏差 ≤2 行；
2. **I7"fence_start/end 成对出现"在悬空 fence 场景下**——替代："start 数 ≥ end 数且差额 ≤1"（与 DocGen 的 50% 闭合率设计对齐）。

### 必须合并解决的交叉依赖
G5 源失效 → 阻塞 08 验收项 1（CommonMark 0.99）；G2-I5 修正 → 阻塞 G2 全部 fuzz 用例落地；R1 方案修正 → 阻塞 P2 渲染层落地。建议按"源修复 → 不变量修正 → RTL 方案修正"的顺序在 P0 阶段先行解决，再进入 P1-P7。
