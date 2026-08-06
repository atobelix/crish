# E1 — Composer-Preview Markdown 引擎深度评审

- 评审对象：`docs/composer-preview`（Vite + React + ProseMirror/Tiptap 编辑器原型，目标 "Obsidian × Notion 结合"）
- 评审范围：`src/core/live-preview/*`（9 文件）、`src/core/serializer/markdown.ts`、`src/core/types/*`、`src/core/plugins/LivePreviewPlugin.ts`、块系统 `src/extensions`/`src/views`/`src/menus`、`src/__tests__/unit/` 与 `_attic/orphaned-tests/`
- 评审方式：只读 + 实跑测试（`vitest run`：7 文件 114 用例全绿）+ 代码走读
- 日期：2026-08-05

---

## 0. 执行摘要（先看结论）

**一句话：行内 live-preview 引擎本身是第一梯队水平，但"引擎强、系统弱"——解析/预览/序列化三件套只覆盖了 Markdown 的一个子集（行内语法全量、块级只有 heading），表格/列表前缀/wikilink/数学公式全部缺席；Notion 侧是"类型完备、视图只做了 1/10、交互壳有而行为缺"。**

核心设计 "Token-in-Document"（语法字符是真字符，mark 是文本的纯函数）是一个**比 tiptap-markdown 高一个量级的架构决策**：

- 行内序列化退化为"取 textContent"，旧引擎整类转义/丢损 bug 从原理上消失（有测试证据）；
- 重解析只改 mark 不改文本 → 光标天然稳定，不需要任何坐标映射；
- 撤销不需要为 mark 单独记步骤（文本回滚自动重算）；
- 性能实测 1000 段落 0.38ms/击键，2000 字符解析 0.235ms/次——增量解析 + signature 比对 + CSS 兜底显隐，性能设计到位。

**但与"Obsidian × Notion"目标的差距是结构性的**，不是打磨问题：

- 表格（GFM）在解析、序列化、渲染三层全部为零——Obsidian 和 Notion 双缺，是最大单点差距；
- 列表/引用/代码围栏仍是"输入规则吃掉前缀"的结构化节点，与 `#` 前缀的"可逆源码编辑"哲学并存但不一致；
- `![alt](url)` 图片语法会被链接解析器误判成 link mark；
- 在列表项里输入 `# ` 会触发 schema 崩溃（resolveBlockRetype 缺父容器守卫，注释与实现不符）；
- 生产编辑器没有注册拖拽扩展，BlockShell 的拖拽手柄是装饰；
- 数据库 10 种视图只有 table 有实现，其余是 "🚧 即将推出" 占位。

评分（个人口径）：行内解析器 8.5/10；实时预览机制 8.5/10；往返序列化 8/10（覆盖范围内），5.5/10（覆盖范围）；块系统 5/10；整体"Obsidian 手感"约 60-70%，"Notion 手感"约 40-50%。

---

## 1. 解析架构

### 1.1 总体思路：Token-in-Document

文档里保存的是**真实 Markdown 源码字符**（`**`、`` ` ``、`[](…)`、`#` 全部是真字符），解析器只负责计算"哪些区间带什么 mark、哪些区间是语法分隔符"，mark 是文本的纯函数（`reconcile.ts:4-6`）。与旧版 InlineDecorationPlugin（装饰层伪造语法字符）的本质区别写得很清楚（`inlineParser.ts:8-12`）：删一个 `*` 真的会让加粗降级。

### 1.2 行内解析器：CommonMark delimiter-stack 的工程化简化

`inlineParser.ts` 是**本引擎质量最高的一块**，不是随手正则：

- **四阶段 masked 扫描**（`inlineParser.ts:128-139`）：转义 → 代码段 → 链接 → 强调。先扫"硬 token"并 mask 掉，硬 token 内部不参与强调配对，这是 CommonMark 的正确做法，也是"代码段里的星号不配对"测试（`inlineParser.test.ts:71-75`）通过的原因。
- **强调配对是真实的 delimiter-stack**（`inlineParser.ts:285-341`）：`collectRuns` 计算每个 run 的 left/right-flanking（`inlineParser.ts:343-388`），opener 从右端消耗、closer 从左端消耗（`usedRight`/`usedLeft`），天然支持 `***x***` 嵌套、`**a *b* c**` 交叉；`_` 有词内抑制，`snake_case_name` 原样保留（`inlineParser.ts:374-382`）——这是 Obsidian 用户最常踩的坑，这里处理了。
- **未闭合不配对**：`*unclosed`、`a ** b` 都安全落为纯文本（有测试，`inlineParser.test.ts:84-92`）。
- **复杂度 O(n) 单块**（`inlineParser.ts:20`），实测 2099 字符 0.235ms/次。
- 链接解析支持嵌套方括号与括号计数（`inlineParser.ts:234-264`），href 落 attrs（`inlineParser.ts:270-271`），URL 内的星号不配对（有测试 `inlineParser.test.ts:119-122`）。

**已覆盖的行内语法**：bold / italic / strike / highlight（`==`，Obsidian 方言）/ code / link（`inlineParser.ts:28-34`）。

**行内覆盖度的缺口**（后面差距清单详列）：

| 语法 | 状态 | 证据 |
|---|---|---|
| 图片 `![alt](url)` | **会误判成 link** | `scanLinks`（`inlineParser.ts:227`）不认识 `!` 前缀，`![alt](img.png)` 会把 `[alt](img.png)` 配对成 link mark、`!` 留作正文 |
| 行内公式 `$…$` | 不解析，纯文本 | parseInline 无 `$` 分支；`MathInlineExtension`（atom 节点 + NodeView）与解析器完全脱钩，round-trip 测试里能过只是因为它不损坏字符（`markdownRoundTrip.test.ts:60-61`） |
| wikilink `[[…]]` | 不解析，纯文本 | 同上，只过 round-trip 不损坏 |
| 标签 `#tag` | 刻意不误判 heading（`blockSyntax.ts:47-51`），但也无标签样式 | 无渲染 |
| 裸 URL autolink | 无 | — |
| @mention | 无（types 里有 MentionAttrs，无注册节点） | `types/blocks.ts:191-198` |
| HTML 行内 | 纯文本 | round-trip 只保证不损坏 |

### 1.3 块级解析：只有 heading 一个前缀

`blockSyntax.ts` 只做一件事：`^(#{1,6})([ \t]+)` 标题前缀识别（`blockSyntax.ts:27`），节点类型由文本推导（paragraph ⇄ heading 双向可逆，`blockSyntax.ts:84-107`）。注释（`blockSyntax.ts:15-21`）诚实承认：列表和引用需要包裹/解包结构，位置偏移风险量大，故意不混进本模块。

**后果**：`- `、`> `、```` ``` ```` 仍是结构化节点，前缀由 StarterKit 输入规则吃掉（只禁用了 bold/italic/strike/code/link/heading 六条规则，`marks.ts:30-37`），转换单向不可逆——与 `#` 的哲学并存但不一致。用户在 Obsidian 里"删掉 `- ` 把列表项还原成段落"的肌肉记忆在这里会失效。

### 1.4 性能特征：真·增量

- `appendTransaction` 用 `getChangedRanges` 把事务步映射到新坐标，只重解析受影响块（`reconcile.ts:47-70`、`index.ts:117-132`）——不是全量重跑；
- 块级 signature 比对（`buildTargetSignature` vs `buildCurrentSignature`，`reconcile.ts:132-165`）让"在纯文本里打字"提前返回（`reconcile.ts:209-210`）；
- 显形装饰只覆盖光标触及的块（`revealPlugin.ts:60-80`），其余靠一条 CSS `display:none`（`live-preview.css:42-43`），Decoration 数量恒定个位数；解析结果按 Node 引用 WeakMap 缓存（`revealPlugin.ts:41-50`，ProseMirror Node 不可变所以安全）；
- 实测：1000 段落长文档 0.38ms/击键（含重解析+装饰），阈值测试 5ms 内通过（`livePreviewInline.test.ts:249-259`）。

**性能结论：达到了直接可用的水平，这块不需要再优化。**

---

## 2. 实时预览机制

### 2.1 reconcile：只改 mark，一个字符不动（`reconcile.ts:183-236`）

这是整个机制的地基，三个设计都成立且有测试背书：

1. **光标稳定免映射**：重解析只 produce mark step，不产生任何文本插入/删除，`setNodeMarkup` 保持节点尺寸不变（`reconcile.ts:178-179`），因此"光标稳定"是**构造性保证**而非坐标补偿——比 Obsidian 自己（切换 selection 状态时偶发跳动）都稳。
2. **不进 undo 历史**：`addToHistory:false` + `RECONCILE_META` 防自触发（`index.ts:41-45`）；测试证明一次 undo 直接回文本、marks 自动重算（`livePreviewInline.test.ts:226-242`）。
3. **输入法保护**：`view.composing` 期间整体跳过（`index.ts:122`），`compositionend` 后 setTimeout 0 补跑选区范围（`index.ts:99-113`）。中文 IME 组合期间不碰文档、组合结束补解析，方向正确。

细节加分项：`reconcileRanges` 两阶段（先收集目标块再统一应用）避免了"遍历途中替换被遍历文档"（`reconcile.ts:242-283`）；`ATOM_PLACEHOLDER`（U+FFFC）占位保证 atom 节点偏移与 PM 位置 1:1（`reconcile.ts:29-30,115-121`）。

### 2.2 reveal：贴边即显形，不需要任何键盘特判

`isSyntaxRevealed` 的判定是 `from <= scopeTo && to >= scopeFrom`（`inlineParser.ts:404-405`），闭区间边界命中 → 光标**不可能**停在隐藏分隔符的边界上，于是"方向键跳过隐藏区/退格整段删"两段特判代码被证明永不触发后删除（`revealPlugin.ts:14-17`），并且有穷举所有偏移的不变式测试（`livePreviewInline.test.ts:197-212`）。

Obsidian 手感还原度确认：`**粗体**` 收尾光标贴右边界仍可见，再敲一个空格收起（`revealPlugin.ts:19-21`）；heading 前缀作用域是整个块，光标在标题任何位置井号都可见（`blockSyntax.ts:113-118`，与 Obsidian 一致）；CSS 用 `display` 瞬时切换 + 纯 opacity 动画避免逐帧重排（`live-preview.css:12-16,63-76`）。

### 2.3 实时预览机制的问题清单

**P0 — 列表项内输入 `# ` 会 schema 崩溃（注释与实现不符）**

`resolveBlockRetype` 的注释声称"列表项内部的段落、引用内部的段落等嵌套场景一律跳过"（`blockSyntax.ts:90-91`），但守卫只查 `node.type.name`（`blockSyntax.ts:92-93`），**没有检查父容器**——listItem 里的段落 type 也是 `paragraph`。而 Tiptap 的 listItem content 约束是 `paragraph block*`（`node_modules/@tiptap/extension-list/dist/index.js:414`），heading 不在允许集里。于是在列表项内把光标移到行首敲 `# ` → `reconcileBlock` 执行 `tr.setNodeMarkup(blockPos, heading)`（`reconcile.ts:206`）→ dispatch 时 schema 校验抛 ContentError。**这是真实可达的崩溃路径**，无测试覆盖。

**P1 — 无空行时标题与正文被并成一个 heading 块**

`markdownToDoc` 的段落收集循环（`markdown.ts:236-244`）把 `## H` 和紧邻的 `body`（无空行）合并成**一个** paragraph 块（hardBreak 分隔），reconcile 再按行首前缀推导成 heading——于是 `## H\nbody`（CommonMark 语义：标题在行尾结束，正文是独立段落）在这里变成一个含换行的 heading。round-trip 幂等所以测试测不出，但导出到 Obsidian/GitHub 会渲染成"标题 + 段落"，语义不一致。

**P2 — compositionend 补跑基于 selection 范围**：若组合期间一次插入横跨多块，`[{from,to}]` 只覆盖光标附近（`index.ts:106-107`）。实际有 appendTransaction 兜底（组合结束的 DOM 事务会触发 docChanged 路径），属冗余保险，风险低，仅记录。

---

## 3. Markdown 往返质量

### 3.1 架构红利：行内部分零序列化

`docToMarkdown` 对段落/标题直接取 `textContent`（`markdown.ts:64-66`），因为语法字符就在文本里——不需要"根据 bold mark 反推星号"，旧方案那些 `\,`→`, 变、`> [!NOTE]` 被转义成 `> \[!NOTE\]`、表格压成 `ab12`、图片变空串的损坏**从原理上消失**（`markdown.ts:4-16` 自述 + `markdownRoundTrip.test.ts:4-9` 列出旧失败清单）。

`markdownToDoc` 只识别块级结构（`markdown.ts:174-251`）：围栏、分割线、引用（递归）、列表（递归 + 续行缩进，`parseList` `markdown.ts:287-337`）、任务列表（`- [x]`）、其余走段落；heading 由 reconcile 从保留的前缀文本推导。行尾两空格硬换行标记被当作真字符保留、序列化原样吐出（`markdown.ts:269-284`、`markdown.ts:148-151`）——这是把"源码字符留在文档里"哲学贯彻到底的体现，处理得很聪明。

### 3.2 幂等性验证（实跑通过）

- 33 个 round-trip 用例全绿，含行内全覆盖（嵌套强调、转义星号、Windows 路径、正则字面量、`<u>`、裸链接等），块级（标题/代码块/列表/任务/引用/callout 语法/分割线）（`markdownRoundTrip.test.ts:52-105`）；
- 二次往返与一次完全一致（`markdownRoundTrip.test.ts:107-134`）；
- 覆盖率统计 22/22 无损（`markdownRoundTrip.test.ts:136-158`）。

**结论：在"已覆盖的语法范围"内，往返质量是极好的——这一点有测试硬证据。**

### 3.3 _attic 检查：m2 系列的双向序列化问题是否已解决？

**已解决，但不是靠修复，而是靠换地基。** 证据链：

- `markdownSerialization.test.ts` 与 `m2BiDirectionalSerializationRemediation.test.ts` 断言的是 `editor.storage.markdown.getMarkdown()`（`markdownSerialization.test.ts:59,74,83`）——tiptap-markdown 的 storage API，当前架构里这个 storage **根本不存在**（`Editor.tsx:9-12` 明确声明弃用 tiptap-markdown，理由是它"解析吃 `**`、序列化靠 mark 反推分隔符"，正是这些测试当年打的补丁对象：wiki 链接双重转义、代码块语言丢失等，`m2BiDirectionalSerializationRemediation.test.ts:31-81`）；
- 当前实现里同一批用例（`[[wiki]]`、`#tag`、代码块语言、`> [!NOTE]`）全部以**零转义**通过（`markdownRoundTrip.test.ts:62-66,87-94`）。

**这些归档测试说明的是：项目经历了一代"打补丁修 tiptap-markdown"的失败尝试（m2 时代），然后推倒换成了 token-in-document。归档是健康的重构证据，不是质量妥协。**

### 3.4 往返层的问题清单

**P0 — 表格全缺**：`markdown.ts` 全文件无任何 `|` 管道处理；GFM 表格导入变成"普通段落 + 管道符文本"，导出原样吐回——round-trip 自洽但**结构化信息为零**，Obsidian 文件里的表格进来后不可编辑、不可用。测试只覆盖了"行内代码含管道符"（`markdownRoundTrip.test.ts:58`），恰好避开了表格。

**P1 — callout 导入不识别**：`> [!NOTE]` 在 `markdownToDoc` 里走引用分支变成普通 blockquote（文本原样保留），`CalloutExtension.parseHTML` 只认 `div[data-callout-type]` 不认 blockquote 语法——Obsidian 笔记里的 callout 导入后**不会变成 callout 块**。round-trip 测试通过是因为字符没丢，不是结构被识别（`markdownRoundTrip.test.ts:94`）。

**P1 — XSS 防护在新引擎里没有对应测试**：归档的 `performanceAndBoundary.test.ts:42-48` 曾断言 `[Malicious Link](javascript:alert("XSS"))` 不产生 `href="javascript:`。当前 `PlainLink.renderHTML` 把 href 直接放进 `<a>`（`marks.ts:112-120`），`markdownToDoc` 把 `[t](javascript:…)` 原样保留为文本 → 会生成 `javascript:` 链接。旧断言随旧引擎一起被归档，**价值没有迁移**——安全基线（`docs/rust-rewrite/31-security-baseline.md`）在此处是空的。

**P2 — 列表续行缩进硬编码**：`cont.push(lines[i].slice(baseIndent + 2))`（`markdown.ts:319`）假定续行总是比 marker 多缩进 2 空格，4 空格缩进的嵌套结构会被解析错位；有序列表起始数字被规范化为 `start + i`（`markdown.ts:95-96`，丢失原始编号）。

---

## 4. 块系统（Notion 侧）

### 4.1 数量与分层

- `types/blocks.ts` 定义 L1 文本块 10 种 + L2 围栏块 6 种 + L3 交互面板 16 种 = 32 种块名（`types/blocks.ts:220-261`），数据库模型 20 种属性类型、10 种视图类型（`types/database.ts:12-22`）——**类型层面的野心是完整的 Notion 级**；
- `extensions/` 24 个扩展文件，`Editor.tsx:99-158` 全部注册，且注册顺序有讲究（先 schema 后依赖 schema 的功能扩展）；
- 渲染分层齐全：`views/panel/` 16 个 NodeView（含 database 子目录）、`views/fenced/` 4 个（CodeBlock 用 lowlight 做了真实语法高亮，`CodeBlockView.tsx:15-39`）、`views/inline/` 1 个、`_shared/` 4 个；
- `BlockShell` 把块交互规范收敛成一套（选中环、右上工具条淡入、拖拽手柄锚点、badge、空状态带主行动按钮、Tab 可达 focus-within 常驻，`BlockShell.tsx:12-18`）——这是"看起来高级"的工程化保证，值得肯定。

### 4.2 完成度盘点

| 组件 | 状态 | 证据 |
|---|---|---|
| Slash 菜单 | **29 项命令、分类、搜索、键盘导航、翻转定位**，完成度高 | `slashCommands.ts`（29 个 id）、`SlashCommandExtension.ts:60-77` |
| BubbleMenu | 块类型切换 + 行内格式 + 链接 + 颜色，全部走 livePreviewCommands（与手打语法同构） | `BubbleMenu.tsx`（320 行） |
| BlockShell/BlockToolbar | 统一壳组件，完成度高 | `BlockShell.tsx`、`BlockToolbar.tsx` |
| 数据库视图 | **只有 table 有实现**，其余 kanban/gallery/calendar/timeline… 是 "🚧 即将推出" 占位 | `DatabaseView.tsx:122-138` |
| 块拖拽 | **未接线**：`tiptap-extension-global-drag-handle` 只挂在测试 harness（`editorHarness.ts:30`），生产 `Editor.tsx` 未注册；`BlockShell` 的 `data-drag-handle`（`BlockShell.tsx:77`）是纯装饰，文本块之间无法拖拽排序 | — |
| 表格块 | **无**（Markdown 表格和 Notion 数据库表格两种都没有） | extensions/ 无 Table 扩展 |
| Callout 编辑 | 斜杠插入可用，导入不识别（见 3.4） | — |
| SyncedBlock/AI | 有节点有视图，AI 服务是 mock（`mockAiService.test.ts`） | — |

---

## 5. 与 Obsidian 对照

**有"editing mode 手感"的部分（这是本引擎最亮眼的地方）：**

- 行内所见即所得：`**x**` 实时变粗体、星号原样保留；删一个 `*` 降级成斜体（`livePreviewInline.test.ts:128-141` 直接验证）——这正是 Obsidian live preview 的核心心智："语法是你文档的一部分，可以键盘编辑"；
- 显形/收起节奏一致：贴边显形、离开收起，两侧分隔符同进同出（`inlineParser.ts:396-399`、`revealPlugin.ts:10-12`）；
- 光标不会停在隐藏分隔符上（不变式 + 穷举测试，`livePreviewInline.test.ts:197-212`）；
- 标题前缀作用域整块，光标在标题任意位置 `#` 可见（`blockSyntax.ts:113-118`）。

**缺的部分（Obsidian 体验完整度约 60-70%）：**

1. 块级前缀只有 heading；`- `、`> `、```` ``` ```` 在 Obsidian 里都是可编辑的 live 前缀，这里被输入规则吃掉，不可逆；
2. GFM 表格：Obsidian 渲染+编辑都支持，这里为零；
3. wikilink `[[ ]]`：Obsidian 的核心交互，这里不渲染、不跳转；
4. 标签、反链、大纲侧栏：无（TOC 只有块级目录）；
5. 图片 `![]()` 不渲染（还误判为链接，见 1.2）；
6. 行内公式 `$ $` 不渲染；
7. 无阅读模式/源码模式切换。

---

## 6. 与 Notion 对照

**有感觉的部分：** slash 菜单（29 项带分类与搜索，比不少成品还全）、BubbleMenu 四段式（块类型/格式/链接/颜色）、BlockShell 统一的块交互规范、数据库模型类型完备、ColumnLayout/Tabs/Toggle/Synced/AI 等块类型都有 NodeView 和空状态。

**完成度问题（Notion 体验约 40-50%）：**

1. 数据库视图 1/10（只有 table，且表格视图自身缺 Notion 的拖列排序/公式/关联渲染等深度交互，目前是"展示型"表格）；
2. 块拖拽完全未接线（见 4.2）——Notion 的灵魂操作，当前只有手柄图标；
3. 无 /table 命令（Notion 表格块缺失）；
4. @mention 无、评论无、协同无、页面嵌入（subPage 节点无 `[[链接]]` 语义钩子）；
5. AI 块是空壳 + mock 服务。

---

## 7. 测试与归档

### 7.1 现有单元测试（实际 7 个文件，任务描述说 8 个，此处以实际为准）

`vitest run` 实测：**7 文件 114 用例全绿**。质量评估——这是**当前仓库里最扎实的测试组之一**：

- 断言具体到字符区间（`m(r.marks)` 输出 `bold[6,15)` 这种），不是"toBeDefined"糊弄（`inlineParser.test.ts:16-24`）；
- 有性能阈值断言且打印实测值（2ms/5ms 阈值，`inlineParser.test.ts:152-159`、`livePreviewInline.test.ts:250-259`）；
- 有不变量穷举测试（遍历所有光标偏移验证"不停在隐藏分隔符上"，`livePreviewInline.test.ts:197-212`）；
- 有撤销一致性测试（mark 不占 undo 步，`livePreviewInline.test.ts:226-242`）；
- round-trip 测试把旧引擎的历史失败清单原样搬来做回归（`markdownRoundTrip.test.ts:4-9`）。

**盲区（犀利指出）：**
1. 无 IME/组合输入测试（jsdom 模拟难，可理解，但这是中文输入场景的核心承诺，应至少有一个 composition 事件的模拟用例）；
2. 无 schema 崩溃路径测试——`listItem 内 # ` 崩溃（见 2.3）正是被这种盲区放过的；
3. 无安全测试：`javascript:` href 防护在新引擎没有任何用例（旧用例被归档了）；
4. 无 React 组件层测试（NodeView 渲染、BlockShell 交互全部裸奔）；
5. `mockAiService` 与 `historyService` 两个测试测的是外围功能，与引擎无关，属于历史遗留文件的移植。

### 7.2 _attic/orphaned-tests（实际 14 个文件，任务描述说 12 个）

抽样三个读断言后的判断：

1. **`markdownSerialization.test.ts`**：断言 `storage.markdown.getMarkdown()`——tiptap-markdown 时代产物。归档原因：整个序列化层被 token-in-document 替代，storage 已不存在。**结论：架构换代，非质量妥协。**
2. **`m2BiDirectionalSerializationRemediation.test.ts`**：给 tiptap-markdown 打"wiki 不双重转义、代码块语言保真"补丁的测试。归档原因：补丁对象已被换掉，同批功能在新架构下以零转义通过。**结论：m2 的双向序列化问题已解决，解决方式是重建而不是修修补补——这批归档是项目最值钱的"失败记录"。**
3. **`performanceAndBoundary.test.ts`**：混合内容——50 节大文档性能（已过时）、Enter 表单提交（边缘）、XSS scheme 过滤（**仍然相关，但断言没有迁移到新引擎**，见 3.4）。**结论：归档时没有做"断言遗产盘点"，有价值的断言随旧引擎一起丢了。**

三代测试谱系清晰：milestone1/2 + m1/m2 stress（旧架构 E2E）→ remediation（补丁时代）→ 当前 7 个（重建后）。归档本身是工程健康信号，唯一的问题是价值迁移不完整。

---

## 8. 总体结论

### 8.1 引擎水平定位

对照第一梯队（Obsidian/Notion/Typora/Joplin 的自研引擎）：

| 维度 | 本引擎 | 第一梯队 | 差距 |
|---|---|---|---|
| 行内解析 | CommonMark 式 delimiter-stack，O(n)，flanking/词内抑制全对 | 同级别（Typora 同思路） | 覆盖度（缺 $、[[ ]]、@） |
| 实时预览 | 增量解析 + 光标构造性稳定 + IME 保护 | Obsidian 同等甚至更稳 | 只限行内 + heading |
| 往返质量 | 覆盖范围内无损、幂等（有测试） | 同样依赖"源码即文档" | 表格/结构块导入识别 |
| 块系统 | 32 种块类型全注册、视图 1/10 | Notion 全视图 | 拖拽/视图/表格 |

**定位：行内引擎是"产品级"的，整体是"引擎核心值得保留、外围完成度低"的原型。** 如果只保留一个东西进主仓库，就是 `src/core/live-preview/` 这 9 个文件 + `serializer/markdown.ts` 的架构。

### 8.2 是否达到"Obsidian × Notion 结合"的感觉

**部分达到**：行内编辑是真正的 Obsidian editing-mode 手感（语法可键盘编辑、贴边显形、光标稳定），这是所有"类 Obsidian"编辑器最容易做成"像但不好用"的地方，本引擎做对了；slash/Bubble/BlockShell 让编辑器有 Notion 的"骨架感"。

**未达到的部分是结构性的**：表格缺失（两种意义下都缺）、拖拽未接线、数据库视图 1/10、wikilink/标签/公式不渲染。当前体验是"**Obsidian 的编辑器内核 + Notion 的 UI 壳，中间层（块级 markdown 结构、表格、拖拽、数据库交互）是空的**"。

### 8.3 差距清单（按优先级，可直接开工）

| # | 差距 | 位置/现状 | 优先级 | 工作量估计 |
|---|---|---|---|---|
| 1 | **GFM 表格**：解析+序列化+渲染+编辑 | `markdown.ts` 无 pipe 处理；无 Table 节点 | **P0** | 大（独立切片） |
| 2 | **listItem 内 `# ` 的 schema 崩溃** | `blockSyntax.ts:92-93` 守卫只查 type.name，不查父节点；注释承诺"跳过嵌套"但未实现 | **P0** | 小（改守卫 + 补测试） |
| 3 | **href scheme 过滤**（javascript: 等） | `marks.ts:112-120` 直通 href；旧断言被归档 | **P0**（安全基线） | 小 |
| 4 | **图片 `![]()`**：渲染 + 修 scanLinks 的 `!` 分支 | `inlineParser.ts:219-279` 误判 link | **P1** | 小 |
| 5 | **无空行标题合并块的语义错误** | `markdown.ts:236-244` + reconcile 推导 | **P1** | 小 |
| 6 | **列表前缀 token-in-document 化**（`- ` 可逆）或至少列表内不 retype 的一致性 | `blockSyntax.ts:15-21` 承认未做 | **P1** | 大 |
| 7 | **行内公式 `$ $` 接入 parseInline**（masked 机制可复用） | MathInline 与解析器脱钩 | **P1** | 中 |
| 8 | **wikilink `[[ ]]` 渲染 + 点击跳转** | 现为纯文本 | **P1** | 中 |
| 9 | **callout/围栏导入识别**（`> [!NOTE]` → callout 块） | 见 3.4 | **P2** | 中 |
| 10 | **拖拽排序接线**（注册 GlobalDragHandle 或自研） | `editorHarness.ts:30` 只有测试在用 | **P2** | 中 |
| 11 | **数据库 kanban/gallery 视图** | `DatabaseView.tsx:122-138` 占位 | **P2** | 大 |
| 12 | **autolink + @mention** | 无 | **P2** | 中 |
| 13 | **IME 组合的自动化测试** | 无 | **P2** | 小 |
| 14 | 归档测试的"断言遗产"盘点（XSS、性能阈值迁入新引擎） | `_attic` 14 个文件 | **P3** | 小 |

### 8.4 一句话收尾

**这是一个"决策正确、执行局部"的引擎：Token-in-Document 的架构判断比大多数商业编辑器都清醒，行内层已经可以进产品；但 Markdown 的块级语义（表格、列表、callout）和 Notion 的交互（拖拽、视图）还是空的——补上差距清单 1/2/3/4，它就从一个"有亮点的原型"变成"能用的编辑器内核"。**
