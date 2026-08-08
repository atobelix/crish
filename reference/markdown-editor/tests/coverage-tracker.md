# 断言点覆盖追踪表（防凑数机制）

> 依据：`docs/analysis/03-测试门禁体系.md` 各类别断言点清单；
> 修正项已并入 09 修订（§3）：G2-I5 改为参考模型重放、G3 补 ResizeObserver
> polyfill 并 stub 容器 rect、G8 由 `VITEST_PERF_TIER` 显式降档、
> G5 spec 源走仓库内 `test/cmspec/spec.txt` + sha256 校验。
>
> 机制：新增严格用例总量口径 120-140（CommonMark 652 例另计）。
> 每行断言点落地即勾选 ✅ 并标注文件；禁止无断言点空壳文件入库。

## 分类断言点清单

### G1 · core 不变量 unit（U1）——现有 126 例加固

| # | 断言点 | 状态 | 落地文件 |
|---|---|---|---|
| 1 | `helpers.ts`：`tokenCoverage(doc)`——inlineTokens 递增不重叠、覆盖 `[0,line.length)`、raw 拼接 == lineText（table 递归） | ⬜ | `tests/unit/helpers.ts` |
| 2 | `parser-cache.test.ts`：LRU 命中/未命中结构一致（除 id/localOffset）；`astCache.size <= 50000`；缓存态与冷态 token 序列等价 | ⬜ | `tests/unit/parser-cache.test.ts` |
| 3 | `parser-bailout.test.ts`：嵌套深度 >20 返回 text 回退；`parseLine` 对 fence/math_block 各状态线型正确 | ⬜ | `tests/unit/parser-bailout.test.ts` |
| 4 | `code-state-cross-check.test.ts`：编辑后 `store.codeBlockState` == `computeLineOffsets(getText()).codeBlockState`（收敛终态） | ⬜ | `tests/unit/code-state-cross-check.test.ts` |
| 5 | 白箱改造：`undo.test.ts:32`、`chunk.test.ts:13` 标 `@白箱-结构敏感`，黑箱契约补齐后评审迁移 | ⬜ | `tests/unit/` |
| 6 | 门槛：不新增失败；新用例必须走不变量断言器 | ⬜ | — |

### G2 · 属性测试（U2）——不变量集设计

| # | 不变量 | 断言实现 | 状态 |
|---|---|---|---|
| 1 | I1 token 覆盖守恒 | 每行递增不重叠、覆盖、raw 拼接（table 递归） | ⬜ |
| 2 | I2 offset 一致 | `verifyConsistency()`；getOffset/findLineIndex 往返；toArray 与 lines 同步 | ⬜ |
| 3 | I3 textLength 一致 | `textLength == lines.join('\n').length`；cursor/selection 界内 | ⬜ |
| 4 | I4 fence 与独立重扫一致 | `store.codeBlockState` == 独立重扫（含 fenceLines 单调性） | ⬜ |
| 5 | I5 undo 恒等（09 修正） | **参考模型重放**：独立朴素实现模拟同一操作序列逐步对比（不再断言"undo 得回上步"） | ⬜ |
| 6 | I6 图素往返 | findNext∘findPrev 幂等；deleteText 移除一个图素 | ⬜ |
| 7 | I7 parse 确定性/不崩溃 | 任意文档不抛异常；两次 parse 结构相等；fence 成对 | ⬜ |
| 8 | I8 缓存语义透明 | 预热后与冷缓存 token 序列等价 | ⬜ |
| 9 | I9 长行不变量 | >10_000 字符截断指示出现且前后 raw 拼接还原 | ⬜ |
| 10 | 失败可诊断 | 断言失败打印步号+种子+最小化路径（bisect 首败步） | ⬜ |
| 11 | 用例形态 | `fuzz-editor-state` / `fuzz-parser-ast` / `fuzz-table` / `fuzz-fence-convergence`，CI 固定 10 组种子，单组 <30s | ⬜ |

### G3 · 渲染层 RTL（R1）——4 组件（jsdom）

> 环境修正（09 §3）：stub 容器 rect（`window.innerHeight` 控制不了 virtualizer 视口）；
> 补 ResizeObserver polyfill；测量函数不进 RTL 契约（坐标语义归 G7）。

| # | 组件 | 断言点 | 状态 |
|---|---|---|---|
| 1 | BlockRenderer | heading 1..6 → `line-h1..h6`；hr → `.hr-rendered` + data-* + `is-active-token` 翻转 | ⬜ |
| 2 | BlockRenderer | code_fence_start → `.code-lang-pill` 文本、`.code-fence-source` 保留 raw；math_block → `.katex` + `data-ignore-measure` | ⬜ |
| 3 | BlockRenderer | table_row → `isHeaderRow` 判定 + `.token-table-cell` 序列；blockquote → `.blockquote-guide` 个数 == level | ⬜ |
| 4 | BlockRenderer | 列表缩进 CSS 变量 `--logical-indent`/`--hanging-indent`（task 3.5ch）；长行截断 `.truncation-indicator`；empty → `.line-block` + `<br>` | ⬜ |
| 5 | BlockRenderer | activeState 矩阵：cursor 起/中/尾、跨 token、选区重叠 × 各块类型 → `is-active-token` 精确集合 | ⬜ |
| 6 | InlineRenderer | 样式 token 三件套（prefix/content/suffix）+ `syntax-hidden` 仅包定界符；`****` → `is-empty-token` | ⬜ |
| 7 | InlineRenderer | math 行内/块式 → `math-preview`+`.katex`+`data-sub-offset`；table_cell → `data-col-index` 递增 + flex 契约 + 选中 boxShadow 四边 | ⬜ |
| 8 | InlineRenderer | 位置映射：全 token `data-token-start+length` 无重叠覆盖 == 行区间；html_element tag→class 映射全表 | ⬜ |
| 9 | InlineRenderer | 交互回调：task 点击 `[ ]`→`[x]` 翻转；cell mousedown → enterCellSelection | ⬜ |
| 10 | MarkdownEngine | `.virtual-row` data-* 与 store 一致；`.is-active-line` 集合；点击 padding/token/table separator 光标落点；copy/cut 内容 == 选区原文 | ⬜ |
| 11 | SelectionHighlight | 空选区不渲染；跨行 `.selection-rect` 个数 == 相交行数；首末行坐标；空行 5px 兜底 | ⬜ |

### G4 · 行为契约（R2）——store/parser 黑箱语义

| # | 文件 | 断言点 | 状态 |
|---|---|---|---|
| 1 | `store-edit-contract.test.ts` | 插入/删除/选择文本终态（`getText()` 黑箱）；insertText 覆写选区；deleteText 图素语义；appendText 仅尾部推进；跨行删除合并行 | ⬜ |
| 2 | `store-undo-contract.test.ts` | undo/redo 恢复文本与选区契约矩阵（只断黑箱结果，不断言 `undoStack.length`） | ⬜ |
| 3 | `store-selection-contract.test.ts` | 越界 clamp、反向选区归一、setCursorPos 边界、选择与光标联动 | ⬜ |
| 4 | `parser-contract.test.ts` | 语义级 parse 契约：表格驱动"期望 token 序列"（手写语义表 + CommonMark 核心子集） | ⬜ |
| 5 | `table-contract.test.ts` | `formatTable` 幂等；行列操作后列宽一致；`findTableRange` 边界 | ⬜ |
| 6 | `validator-contract.test.ts` | 好/坏文档 error/warning 集合契约；token-bounds-integrity 与 I1 联动 | ⬜ |

### G5 · CommonMark 符合度（C1）

| # | 断言点 | 状态 |
|---|---|---|
| 1 | `tests/commonmark/spec.json`：652 例编译产物（section/exampleNo/markdown/html/line）；spec 源 = 仓库内 `test/cmspec/spec.txt` + sha256 校验（09 §3 修正，禁止依赖 compare/ 目录） | ⬜ |
| 2 | `astToHtml.ts` 语义序列化器 + 自检：652 例 parse+序列化不崩溃、无缺失段 | ⬜ |
| 3 | 三级判定：PASS（规范化空白后等价）/ KNOWN_FLAW（语义可达但细节偏差，按 section 分类）/ FAIL | ⬜ |
| 4 | 文本保真次级断言（全部 652 例无条件）：raw 拼接 == 输入原文 | ⬜ |
| 5 | `baseline.json` 通过率门槛：禁止回归（PASS→FLAW/FAIL 报错）；PASS 数 ≥ baseline；核心子集阈值 0.99 硬门槛 | ⬜ |
| 6 | 首次接入基线预计 40-55%（reference link/autolink/HTML block 未实现），三个月内目标 ≥60% | ⬜ |
| 7 | 执行：CI mid 全量 652（单例 <50ms，总计 <60s）；nightly 浏览器真实渲染比对（G7 金样抽样 40 例） | ⬜ |

### G6 · CSS 契约（C2）

| # | 断言点 | 状态 |
|---|---|---|
| 1 | `class-inventory.test.ts`（静态）：CSS 选择器集合 A ⊇ 组件 className 字面量集合 B；B − A 为空（删除 class 先炸测试） | ⬜ |
| 2 | 动态 class（`is-active-token` 拼接产物）入集合 B | ⬜ |
| 3 | `style-contract.test.ts`（动态 jsdom）：`is-active-token` 非 display:none；`syntax-hidden` 可见性契约；table flex 契约 | ⬜ |
| 4 | `:root` 变量表完整性（`--text-primary/--text-muted/--border-focus/--blue-selection` 等逐一存在性） | ⬜ |
| 5 | color-gate 扩展：CSS 文件内禁用 rgb()/hsl() 字面量扫描 | ⬜ |

### G7 · 运行时 Playwright（E1）——现有 18 spec 保留

| # | spec | 断言要点 | 状态 |
|---|---|---|---|
| 1 | `ime-composition.spec.ts` | composition 事件序列；`isComposing` 状态机；组合期文本不进 undo 栈；HiddenInput 值同步 | ⬜ |
| 2 | `scroll-matrix.spec.ts` | 万行滚动往返；虚拟窗口行数有界（≤ viewport/28+2×overscan）；滚动后点击映射正确 | ⬜ |
| 3 | `cursor-matrix.spec.ts` | 方向键/Home/End/PageUp/Down；跨行 X 保持；点击 token 落点 == `data-token-start+data-sub-offset` | ⬜ |
| 4 | `table-interaction-matrix.spec.ts` | 1 击选 cell/2 击编辑/Tab 环绕/拖拽跨行选区/Escape/右键 ContextMenu 事件 | ⬜ |
| 5 | `golden-structure.spec.ts` | 40 例核心文档 `.virtual-row` DOM 序列化与 `tests/e2e/goldens/*.json` 精确比对；`UPDATE_GOLDENS=1` 重写 | ⬜ |
| 6 | `golden-pixel.spec.ts` | `toHaveScreenshot` 1366×768 + 固定字体；仅 nightly | ⬜ |
| 7 | `random-interaction-fuzz.spec.ts` | 真实页面 OpGen 序列（API 注入/真实输入 50/50）；每 10 步 verifyConsistency + METRICS 健康 + 无 pageerror | ⬜ |
| 8 | `clipboard-roundtrip.spec.ts` | 复制 → text/plain 原文；剪切 → 删除+剪贴板；粘贴回 → 还原 | ⬜ |

### G8 · 性能门禁（P1）

| # | spec | 指标 | 门槛 | 状态 |
|---|---|---|---|---|
| 1 | `frame-rate.spec.ts` | rAF 帧间隔 p95/p99（≥300 帧采样） | 探测刷新率取档：60fps p95<16.7ms；CI 无显示器降档 ≥30fps 硬门槛 p95<33ms（09 §3：`VITEST_PERF_TIER` 显式驱动，中位数+长任务计数为主） | ⬜ |
| 2 | `long-task.spec.ts` | longtask 计数 | 0 长任务软门槛 warn；>2 个 fail | ⬜ |
| 3 | `layout-thrash.spec.ts` | `layoutThrashCount` + 帧内 getBoundingClientRect 次数 | 光标移动帧内 ≤8；滚动 1s <3000；无 `[CRISH METRICS] Layout Thrash Detected!` | ⬜ |
| 4 | `parse-budget.spec.ts` | parse 耗时 | 万行 <500ms；5 万字符单行 <150ms；单字符重 parse <16ms | ⬜ |
| 5 | `render-budget.spec.ts` | keystroke→DOM 更新（含 rAF） | p95 <16.7ms（60fps 档） | ⬜ |
| 6 | `scroll-throughput.spec.ts` | 滚动时 DOM 行数上限 | ≤ ceil(viewport/28)+2×overscan(40) | ⬜ |
| 7 | `budgets.ts` 常量 | 三档 + CI 降档统一导出，spec 只引用常量 | 改档位改一处 | ⬜ |

### G9 · 内存门禁（M1）

| # | spec | 方法 | 断言 | 状态 |
|---|---|---|---|---|
| 1 | `cache-bounds.spec.ts` | 6 万行不同文本（清缓存后） | `getCacheStats().size ≤ 50_000`；hits+misses 单调 | ⬜ |
| 2 | `lru-eviction.spec.ts`（unit） | 直接操作 LRUCache | 容量溢出淘汰最久未用；get 提升次序；并发/大容量 | ⬜ |
| 3 | `heap-growth.spec.ts`（nightly 专属） | 万行加载→滚动→清空 ×10 轮 | 稳态增量 <5% 基线；无单调增长（GC ±10% 允许） | ⬜ |
| 4 | `store-leak.spec.ts` | OpGen 500 步长编辑 | undo/redo 栈长度有界（≤500）；fenceLines 单调且 ≤ lines | ⬜ |
| 5 | `chunk-load.spec.ts` | 10 万行文档 | 分块加载不 OOM；lines 全量；DOM 行数有界 | ⬜ |

### G10 · 交叉矩阵（X1，nightly）

| # | 断言点 | 状态 |
|---|---|---|
| 1 | 文档轴 6 类：中文/CJK、emoji+ZWJ、纯代码、深嵌套块引用、畸形表格、混合全部语法、超长行 | ⬜ |
| 2 | 操作轴 4 类：纯键盘、纯程序化批量、undo/redo 风暴、选区删除风暴 | ⬜ |
| 3 | 模式轴 3 类：正常、光标头/中/尾、选区跨文档尾 | ⬜ |
| 4 | 断言：I1-I9 子集（page.evaluate 调 store，每 20 步 verifyConsistency）；DOM 行数一致；无 console error | ⬜ |
| 5 | 全积 72 组合抽样 24 组（LHS 正交表），每组 <60s | ⬜ |

## 汇总（维护此处进度）

| 类别 | 断言点总数 | 已落地 | 最后更新 |
|---|---|---|---|
| G1 | 6 | 0 | 2026-08-09 |
| G2 | 11 | 0 | 2026-08-09 |
| G3 | 11 | 0 | 2026-08-09 |
| G4 | 6 | 0 | 2026-08-09 |
| G5 | 7 | 0 | 2026-08-09 |
| G6 | 5 | 0 | 2026-08-09 |
| G7 | 8 | 0 | 2026-08-09 |
| G8 | 7 | 0 | 2026-08-09 |
| G9 | 5 | 0 | 2026-08-09 |
| G10 | 5 | 0 | 2026-08-09 |
| **合计** | **71** | **0** | — |

> 口径：上表为断言点计划清单（非用例数）。新增**严格用例**总量目标 120-140
> （09 §3 口径），CommonMark 652 例另计。占位骨架（tests/gate 10 例）不计入断言点。
