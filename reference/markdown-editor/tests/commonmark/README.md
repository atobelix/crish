# CommonMark 合规基线轮（R0-B）：AST 投影器 + 黄金判定对 + 跑分脚本

> 引擎（`reference/markdown-editor`）无 HTML 渲染器，无法直接执行 CommonMark 的
> markdown→HTML 断言。R0-B 的方案：把引擎 AST **忠实投影**为近似 HTML
> （AST→HTML 投影器），与官方期望 HTML 做归一化对比，统计符合度。
> 本目录是 R0 基线轮的测量工具，产出供 `docs/rust-rewrite/` 基线记录引用。

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `astToHtml.ts` | 投影器：`MarkdownDocument` → 近似 HTML 字符串（含 `normalizeHtml` 归一化） |
| `projector.test.ts` | vitest 自测：10 个黄金判定对（人工验证投影输出）+ 补充断言（13 例，含 B8b 三形态）+ 归一化测试 |
| `run-compliance.mjs` | 跑分脚本：用例 → 引擎 parse → 投影 → 归一化对比 → 分章节统计 JSON |
| `spec.txt` | 官方 CommonMark 0.31.2 spec（examples.json 未就绪时的回退数据源） |
| `compliance-report.json` | 跑分报告（脚本生成物，不入库；`--out` 可指定路径） |

## 运行方式

```bash
# 投影器自测（黄金判定对门禁）
npx vitest run tests/commonmark/projector.test.ts

# 跑分（完整 JSON 输出到 stdout + 写入 compliance-report.json）
node tests/commonmark/run-compliance.mjs
node tests/commonmark/run-compliance.mjs --summary   # 仅打印摘要
```

## 防作弊条款（投影器契约）

1. **零语义修复**：投影器不补语法、不改语义，只做结构映射。所有映射均为
   AST 字段 → HTML 的确定性翻译，不参考期望 HTML 调整输出。
2. **不支持语法不补偿**：引擎不支持的 CommonMark 语法——引用链接、
   自动链接、实体引用、HTML 块、下划线强调（`_x_`）、
   `3)` 列表序号等——在 AST 中已退化为普通 text 节点，投影器按文本规则
   原样转义输出。期望 `<h2>` 而投影 `<p>title</p>` 即记 FAIL。
   **这是符合度统计的正确行为**，任何补偿都视为作弊。
   （注：Setext 标题、缩进代码块与 `~~~` 围栏原属该列举，R1 轮起引擎
   已原生支持——缩进代码产出 `code` 类型行，投影器按 CommonMark 块语义
   合并投影；`~~~` 围栏与反引号围栏同规投影，见「投影规则表」与
   「偏差点登记」。）
3. **扩展语法显式暴露**：引擎扩展语法（行内数学 `$x$`、`==mark==`、
   `||spoiler||`、`[^footnote]`、任务复选框）在 CommonMark 中无对应 HTML，
   投影为占位标签（`<span class="math">` / `<mark>` / `<span class="spoiler">`
   / `<span class="footnote">` / `<input type="checkbox">`），与 CommonMark
   的纯文本渲染必然不等（计 FAIL）——**不得折叠为纯文本掩盖差异**。
4. **行内原始 HTML 原样透传**：`html_element` / `html_tag` 节点按 CommonMark
   raw HTML 语义逐字节输出（不转义、不重组），与 Raw HTML 章节期望一致。
5. **文本转义**：text 与 code 内容按 CommonMark 规则转义 `& < > "`
   （commonmark.js 的 escapeXml 对 text/code 统一转义四字符——B8c 配合项：
   `"` → `&quot;`，spec 例 343 的 code 内容与例 619/620/624/632 的非法
   标签行文本均期望 `&quot;`）。
6. **锚定机制**：10 个黄金判定对（`projector.test.ts`）的期望输出经人工
   逐行核对引擎 AST 行为后手工写出，并由真实引擎解析复核；投影器行为
   变更必须先改黄金对，防止测量工具自身悄悄漂移。

## 投影规则表

### 行级（块结构）

| 引擎 AST | 投影 |
| --- | --- |
| `body`（无列表标记） | `<p>内联</p>` |
| `heading` | `<h{n}>内联</h{n}>`（n = headingLevel） |
| `hr` | `<hr />` |
| `blockquote`（行级 blockquoteLevel） | 按层级连续行合并开合 `<blockquote>` 容器 |
| `code`（围栏内，B8b 配合项） | `<pre><code>内容\n</code></pre>`；围栏信息串取首个词 → `class="language-…"`（` ``` ` 与 `~~~` 开栏同规——B8c 配合项，spec 例 143/146）；内容行按行原文投影、`\n` 连接并以 `\n` 结尾（空块除外）。B8c 配合项：内容行剥 up to 开栏缩进列（开栏行允许 1-3 空格缩进，spec 例 131-133；开栏缩进在剥离引用前缀后的行上计算）。剥引用前缀仅限「行引用层级与围栏一致」的内容行（围栏内 ` >` 是内容，spec 例 119/120）；遇非 code 行（body/empty 等）即终止交还主循环（spec 例 237/128：引用容器边界/段落打断结束围栏，不吞行）；未闭合围栏剔除引擎文档尾幻影空 code 行（spec 例 126/127/137/237） |
| `code`（缩进代码块，R1-A2d / B8b 配合项） | 连续 `code` 行合并为单个 `<pre><code>内容\n</code></pre>`；每行剥离引用前缀后剥 up to 4 列缩进（tab 按停靠 4 展开），`\n` 连接并以 `\n` 结尾；块尾空白行（trim 后为空）剔除，块内空白行保留（剥缩进后可能残留空白，如 spec 例 112）。**合并仅限同 blockquoteLevel 的连续行**——跨容器/跨引用层级不合并（spec 例 236：引用内与文档级各成一块） |
| `table_row` | `<tr><td>…</td></tr>`（table_separator 跳过；CommonMark 无表格语义，仅为完整映射） |
| `empty` | 无输出 |
| `math_fence_*` / `math_block` | `<span class="math">…</span>`（扩展语法占位） |

### 内联

| 引擎 AST | 投影 |
| --- | --- |
| `text` | 内容转义 `& < > "`（content 字段即显示文本，反斜杠转义已解） |
| `bold` / `italic` / `strike` | `<strong>` / `<em>` / `<del>` |
| `bold_italic` | `<em><strong>…</strong></em>`（按 CommonMark 参考实现嵌套惯例） |
| `code` | `<code>内容转义</code>` |
| `hard_break`（B8c 配合项） | `<br />`——行尾 2+ 空格/tab 或反斜杠后的换行（CommonMark 6.13，spec 例 632/633）；令牌由引擎在行尾拆分，行式模型的段落合并以空格连接相邻行，归一化折叠后与 spec 的软换行形态等价 |
| `link` | `<a href="…" [title="…"]>`；url 字段按 CommonMark 规则拆分 href/title（渲染惯例） |
| `image` | `<img src="…" alt="…" />`；alt 从 raw 提取，title 同 link 拆分 |
| `html_element` / `html_tag` | raw 原样透传 |
| `mark` / `spoiler` / `math` / `footnote` | 占位标签（见防作弊条款 3） |
| `checkbox` | `<input type="checkbox" [checked=""] disabled="" />` |
| `sub` / `sup` / `kbd` | `<sub>` / `<sup>` / `<kbd>` |
| 结构令牌（heading_prefix / list_bullet / list_number / list_task / blockquote_prefix / table_pipe / table_cell） | 不输出，语义由行级结构承担 |

## 偏差点登记

### 偏差点一：列表行启发式分组（`astToHtml.ts` 的 `renderListGroup`）

引擎 AST 无列表容器节点，只有带 `listIndent` / `listPrefix` 的行。投影器把
**连续、同种类（ul/ol）、同 listIndent、同引用层级**的列表行归入一个
`<ul>` / `<ol>` 容器，每行一个 `<li>`。由此产生的与 CommonMark 的结构差异
（如实计 FAIL）：

- 嵌套列表（`- a\n  - b`）投影为两个并列 `<ul>`，而非嵌套容器；
- 松散/紧凑列表语义不承载（blank 行隔开的项拆成两个 `<ul>`，且项内无 `<p>` 包裹）；
- 多行列表项不合并；
- 任务复选框标记 `[x]` 作为结构令牌跳过（GFM 扩展，CommonMark 期望中
  `[x]` 是内容 → 计 FAIL，如实暴露差异）。

其余投影均为确定性结构映射，无第二处偏差点。ordered 列表 `listPrefix`
序号 > 1 时投影 `start="N"` 属性（AST 存储的序号，非补造）。

### 偏差点二：缩进代码块合并投影（`astToHtml.ts` 的 `renderIndentCodeBlock`，R1-A2d / B8b）

引擎 R1-A2b 起缩进代码产出 `type === 'code'` 行（`codeBlockState='indent_code'`，
raw 保留完整原文含缩进），但 **AST 的 LineNode 不携带 codeBlockState 字段**，
围栏内内容行与缩进代码行在 AST 中不可区分。投影器采用如下启发式：

- 围栏内 `code` 行已被 `renderFencedBlock` 从 `code_fence_start` 消费到
  `code_fence_end`（含），**主循环遇到的连续 `type === 'code'` 行必然来自
  缩进代码块**——以此区分，不误合并围栏代码；
- 块内空白行（trim 后为空）属于代码块（引擎 `inIndentCode` 状态机保持语义，
  CommonMark：块中空行仍是代码块一部分），随块合并；
- 每行剥离 blockquote 前缀后按列剥 up to 4 列缩进（tab 停靠 4，与引擎
  `leadingIndentColumns` 一致），不足 4 列或超过部分原样保留（spec 例 112：
  6 空格空白行剥 4 列后残留 2 空格进入内容）；
- 块尾空白行（trim 后为空）不属于块内容，剔除（spec 例 117）——块首不会
  出现空白行（引擎仅在 ≥4 空格非空行处进入代码块）；
- **B8b 配合项：合并仅限同 blockquoteLevel 的连续行**（`collectIndentCode`
  以起始行引用层级分组）——引用内缩进代码与引用外的文档级缩进代码是
  两个块，容器在两组之间闭合重开（spec 例 236）。

投影器把 R1-A2b 语义层已确定的 code 行按 CommonMark 块语义**忠实合并**为
单个 `<pre><code>`（合并 + 剥缩进是 CommonMark 期望输出的结构映射，非
语义修复——引擎 AST 层已正确识别缩进代码，投影器不补语法、不改内容）。
由此产生的与 CommonMark 的结构差异（如实计 FAIL，属引擎偏差非投影器缺陷）：

- 列表内缩进代码（`- foo\n\n    bar`）：引擎按列表延续解析为 body 行，
  投影 `<p>` 而非列表项内 `<pre><code>`；
- 段落打断（`Foo\n    bar`）：引擎按段落延续解析为 body 行，投影两个
  `<p>` 而非段落内折行；
- 块外空白行：引擎解析为 body 行（含缩进），投影 `<p>    </p>` 而非忽略。

### 偏差点三：围栏投影的容器边界与引擎层级误判处理（`renderFencedBlock`，B8b 配合项）

B8b 起 `renderFencedBlock` 按 CommonMark 围栏语义投影，三处行为登记：

1. **非 code 行终止围栏**：扫描中遇 body / empty / heading 等非 code 行即
   终止并交还主循环（引用容器边界或段落打断会结束围栏，spec 例 237 的
   `foo`、例 128 的空行），不再吞并后续行——同时保证 blockquote 容器在
   syncQuotes 处按行级 blockquoteLevel 正确闭合重开。
2. **引用前缀剥离仅限层级一致行**：引擎前缀正则 `{0,3}` 版本仍会把
   围栏内的 ` >` 文本行误判为引用层级（spec 例 119/120），投影器仅在
   「行引用层级与围栏一致」时剥离前缀，误判行按内容原样保留（引擎
   AST 语义层的识别偏差，如实投影）。
3. **未闭合围栏的幻影尾行**：围栏扫到文档尾仍无 `code_fence_end` 时，
   引擎会在末行输出一条幻影空 code 行（最终换行符的切分产物，不属于
   内容），投影器剔除该行（spec 例 126/127/137/237 形态）。

连带修复（同属 B8b 变更的自然结果）：spec 例 119/120/126/127/128/137
从 FAIL 转 PASS；Fenced code 章节 15/29 → 21/29（B8c + 本任务后 → 28/29，
剩余 1 fail 为例 121：`` 2 反引号按围栏解析的引擎域登记项）。

### 偏差点四：spec-231 三方协同项（B8c 引擎域已修 + 本任务投影器同步，完成）

spec 例 231（`    > # Foo`，4 空格缩进的 `>` 行）应为缩进代码块
（`<pre><code>&gt; # Foo…`）。三方协同闭环：

- **引擎域（B8c 完成）**：parser 前缀正则 `^\s*>\s?` 收紧为 `^ {0,3}>\s?`
  （marker 前至多 3 空格缩进），并加围栏开栏缩进 ≤3 列门槛（`    ```` 是
  缩进代码候选，spec 例 134）；
- **投影器域（本任务同步）**：stripBlockquotePrefix 同步 `{0,3}`；围栏
  内容行剥 up to 开栏缩进列（spec 例 131/132/133）；fenceInfo 支持 `~~~`
  开栏（spec 例 143/146）；fuzz-document-typography 断言随新行为更新；
- **EditorStore 域（本任务同步）**：stripBlockquoteContext / 主循环前缀
  正则 / 围栏形态缩进门与 parser 同规（增量与全量重扫一致）。

n231/134/131/132/133/143/146 已转 PASS。仍留引擎域：spec 例 121
（`` 2 反引号按围栏解析，应为行内 code span，B8c 代码 span 重构后
仍未覆盖该形态，登记待后续引擎轮）。

其余投影均为确定性结构映射，无第五处偏差点。

## 归一化说明（对比前的渲染等价化）

`normalizeHtml` 只做「渲染等价」归一化，不改变结构语义：

1. CRLF → LF；
2. `<pre>…</pre>` 整体保护——块内换行与缩进是语义，不做任何折叠；
3. 非 pre 部分：标签规整（属性按名排序、单双引号统一为双引号、空白
   规整、自闭合统一 ` />`）+ 文本段空白折叠（连续空白 → 单空格、文本段
   边缘空格剔除，等价于 HTML 渲染的空白塌陷）；
4. 整体 trim。

归一化不做实体等价（`&amp;` ≠ `&#38;`）、不做标签语义等价
（`<b>` ≠ `<strong>`），避免掩盖真实差异。

## 章节分组说明

用例按官方 spec 章节分组，章节名归一化映射：

| spec.txt 章节 | 报告分组 |
| --- | --- |
| Indented code blocks | Indented code |
| Fenced code blocks | Fenced code |
| 其余章节 | 原名（Tabs / Precedence / Thematic breaks / ATX headings / Setext headings / HTML blocks / Link reference definitions / Paragraphs / Blank lines / Block quotes / List items / Lists / Backslash escapes / Entity and numeric character references / Code spans / Emphasis and strong emphasis / Links / Images / Autolinks / Raw HTML / Hard line breaks / Soft line breaks / Textual content） |

`bySection` 按键按上表顺序输出；examples.json 无 section 字段时，用
`spec.txt` 的例号→章节边界推导补齐（要求例数一致，否则标 `(未分组)`）。

## 跑分输出结构

```jsonc
{
  "total": 652,
  "pass": 178,
  "fail": 474,
  "bySection": { "Tabs": { "pass": 2, "fail": 9 }, /* … */ },
  "baseline": {           // 与用例索引对齐的原始投影（未归一化）与官方期望，供审计
    "actual":   ["…"],
    "expected": ["…"]
  },
  "failIndices": [0, 2, …],   // 失败用例索引（附加，便于定位）
  "source": "…", "format": "examples.json | spec.txt", "generatedAt": "…"
}
```

## 已知局限（如实说明）

- 引擎是**行式**解析器：多行段落不合并（Soft line breaks / 部分 Paragraphs
  用例失败属于引擎真实行为，非投影器缺陷）；
- 每行内联解析独立，跨行结构（如跨行围栏、跨行 HTML 块）不承载；
- 单行 10000 字符上限与内联 2000 字符扫描上限：超长行按引擎截断行为投影。

## 运行环境说明

`run-compliance.mjs` 通过 `typescript` 的 `transpileModule` 在内存中把
`src/core/parser.ts` + `src/core/LRUCache.ts` + `astToHtml.ts` 编译为 ESM
（临时目录），不修改引擎源码、不依赖构建产物。
