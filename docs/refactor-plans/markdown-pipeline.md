# Markdown 管线单引擎（MD）

> **给执行 AI 的硬性规则**
> 1. 彻底改进：一条 parse、一条块渲染。不留别名、垫片、第二解析器、回退公式。
> 2. 禁止作弊：不加 `eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `allow` / `ignore` / `skip` / `only`；不调基线、不放宽阈值；不用 `--no-verify`；不删断言、不弱化断言。
> 3. 测试只在 MD-P5 集中跑。Node 24。改动阶段不跑 `npm test` / `cargo test`。
> 4. 每阶段一提交：`refactor(MD-P<n>): <中文摘要> [BATCH-MARKDOWN-PIPELINE]`。不 amend 已被引用的提交。
> 5. 只在 worktree 改。不 stash、不 push、不在主仓库 checkout / commit / reset。主仓库未提交文件一律不碰。
> 6. 门控非空即停：`git -C C:\Software\conex status --porcelain -- <路径>`。在写路径整段不做。
> 7. 行号是 2026-10-29 工作区快照（HEAD 仍 `bf3d60fa3`）。开工用下文 `rg` 按符号重定位。

| 项 | 值 |
|---|---|
| 代号 | MD |
| 分支 | `refactor/markdown-pipeline` |
| worktree | `C:\Users\orange\rf-md` |
| 批次标签 | `[BATCH-MARKDOWN-PIPELINE]` |
| 进度 | 同目录 `markdown-pipeline.progress.md`（写在 worktree，不写主仓库） |
| 基点 | W4 集成结果（CF 已合入再开 thinking 阶段）。核实对照主仓库工作区，不是在主仓库上改 |

## a. 范围与门控

### a.1 纳入
- 解析：`crates/conex-markdown`（今天的 HTML 发射）、`crates/conex-md-ast`（笔记 IR 的 parse）。`apps/agent-workbench/src-tauri/src/markdown_commands.rs` 只改调用，不改壳的其它文件。
- 前端渲染：`apps/crish-desktop/src/api/markdown/**`、`api/markdownRenderScheduler.ts`、`api/markdownResultCache.ts`、`components/markdown/**`、`components/chat-message-row/{MarkdownBlockItem,StreamingMarkdownView,ReasoningRow}.tsx`。
- thinking 只处理 CF 删除之后剩下的 3 套：`ReasoningRow`、`FoldableProcessSection`、`InlineAgentThinkingFold`。另两处同样的手写 `calcAccordionDuration`：`FoldableProcessSection.tsx`、`chat-tool-call/FoldableToolGroup.tsx`。

### a.2 不纳入
- SS：`store/`、`hooks/chat-stream/`、`api/sessionStreamManager.ts`、`runControlClient.ts`、取消链、`DeltaWriteBarrier`、`precomputedHtml`、`scheduleFinalMarkdownHtml`、`StreamRenderBuffer` 死字段。
- CF（D1 已决删除）：`extensions/conversation-flow/**`、`packages/conversation-flow/**`、`renderThought` / `renderTools`、两个槽位、`ThinkingBlock`。本方案不规划删除它们。MD-07、MD-08 不做。MD-11 的「正在思考」在 `ThinkingBlock` 上，随 CF 消失。
- ST：不新写 shared-types，不改生成器。
- `src-tauri` 除 `markdown_commands.rs` 外不改。

### a.3 门控（编写时 porcelain）
| 阶段 | 命令必须为空 |
|---|---|
| MD-P1 | `api/markdown` `components/markdown` 两个目录，外加 `markdownRenderScheduler.ts` `markdownResultCache.ts` |
| MD-P2 | `crates/conex-markdown` `crates/conex-md-ast` `markdown_commands.rs` |
| MD-P3 | `components/chat-message-row/ReasoningRow.tsx` `components/chat-message/FoldableProcessSection.tsx` `components/chat-tool-call/FoldableToolGroup.tsx` `components/agent-card/InlineAgentThinkingFold.tsx`；且 CF 已在集成分支 |
| MD-P5 | 以上全部 |

编写时非空：`api/markdown/useMarkdownRender.ts`、`components/markdown/VirtualMarkdownBlockList.tsx`、`crates/conex-markdown/src/url_safety.rs`、`crates/conex-md-ast/src/serialize.rs`。所以 **MD-P1 与 MD-P2 现在不能开工**。`components/ui` 不在本模块。

## b. 核实表

| 编号 | 结论 | 符号与证据 |
|---|---|---|
| g3 双引擎 | 仍存在，两边都在生产上 | `render_markdown` / `render_markdown_stream` / `render_markdown_batch`（`conex-markdown/src/renderer/mod.rs`）被 `markdown_commands.rs` 调用；前端 `useStreamingMarkdownResult` 调 `renderMarkdownStream`，`markdownRenderScheduler` 调 `renderMarkdownBatch`。`parse_document` / `parse_md` / `apply_md_fragment` 被 `conex-note-runtime`、`conex-workspace-store`（`mirror_import.rs` 的 `parse_document_detailed`）使用。pulldown 与 markdown-rs 并存 |
| g3 MD-02 | 仍存在 | `conex-markdown/Cargo.toml` 的 `regex = "1"` 未走 workspace；根 `Cargo.toml` 已有 `regex = "1"` |
| g3 MA-02 | 仍存在 | `ApplyReport::into_ops`（`apply.rs`）全仓 0 调用。`rg into_ops` 只命中定义 |
| g3 MA-03 | 部分 | 常量已在 `conex-md-ast/src/lib.rs`（`ORDERED_LIST_ITEM_NUMBER_ATTR` 等）。测试与 `conex-doc-collab/tests/ordered_list_attrs_patch.rs` 仍写死 `"conex_md_ordered_item_number"`。不单开 collab 重构 |
| ST-03 | 部分仍存在，丢帧已改 | `useStreamingMarkdownResult` 仍 `setTimeout(tick, 33)`，超 32_000 改 120；空文本也继续 tick；effect 依赖只有 `[enabled]`。在途文本变了不再丢弃，先落过渡帧（函数内注释已写明旧缺陷）。轮询时钟还在 |
| keyOf 三份 | 仍存在 | `useMarkdownRender.ts` 的 `keyOf`、`markdownRenderScheduler.ts` 的 `keyOf`、`markdownResultCache.ts` 的 `markdownResultCacheKey`。第三份改了名，没有合并。格式都是 `` `${variant}\u0000${text}` `` |
| MD-01 | 仍存在 | `MarkdownBlockItem`（chat-message-row）与 `components/markdown` 的块列表两套。聊天走 `StreamingMarkdownView` |
| MD-02 | 仍存在 | `MarkdownBlockItem` 的 `isPurged` 生产无传入。`rg` 传参只在 `MessageVirtualizer.domPurge.test.tsx`。真正卸载在 `messageDomPurge.tsx` / `MessageVirtualizer` |
| MD-03 | 仍存在 | `StreamingMarkdownView` 的 `content ?? text`。`MessageContent` 仍传 `text=` |
| MD-04 | 仍存在 | `priority` 在 `MarkdownBlockItem` 与 `MarkdownDocumentView` 的 comparator 里比较，无生产语义 |
| MD-05 | 仍存在 | `VirtualMarkdownBlockList` 局部变量名 `window`，遮蔽全局。文件在写 |
| MD-06 | 仍存在 | `MarkdownSurface` 用 `root.innerHTML = html`；`isActive === false` 才挂 math/mermaid portal。`islands/registry.tsx` 注释写懒加载，实际 `import { MathIsland }` / `MermaidIsland` |
| MD-07/08 | 不做 | D1，归 CF |
| MD-09 | 按 3 套收 | 活的：`ProcessItemRenderer` 与 `MessageToolCallsSection` 渲染 `ReasoningRow`；`MessageContent` 渲染 `FoldableProcessSection`。`InlineAgentThinkingFold` 生产 0 引用（`rg -l` 非测试只命中自身）。`ThinkingBlock` 只在 conversation-flow，归 CF，不算第 4 套 |
| MD-10 | 仍存在，且是 3 份 | `ReasoningRow`、`FoldableProcessSection`、`FoldableToolGroup` 各自 `calcAccordionDuration`，用 `motionTokens as Record` 探测。真函数在 `utils/motionTokens.ts` |
| MD-11 | 不做 | 在 CF 的 `ThinkingBlock` 上 |

## c. 目标架构

笔记 IR 与聊天 HTML 共用 **一个 parse**：`conex-md-ast` 的 markdown-rs（`parse_document` / `parse_md`）。这是今天笔记、镜像导入、`note-runtime` 的生产路径，不删除这个 crate。

聊天 HTML 的生产入口仍是 `conex-markdown` 的三个 `render_markdown*`，经 `markdown_commands.rs` 到前端。这个 crate **留下名字、删掉 pulldown**。`render_markdown*` 改为消费 md-ast 的同一棵树再发射 HTML。禁止解析失败时回退 pulldown。`pulldown-cmark` 从依赖图消失。

不把 HTML 塞进笔记 crate，也不把 BlockTree 塞进聊天组件。前端只保留一个块组件（流式 / 虚拟化用参数，不复制 fallback 与 data 属性）。尾块公式在流式期间是明确的占位，不在 `!isActive` 时才 portal。key 只有 `markdownResultCacheKey` 一份。流式渲染由文本变化驱动，在途只保留最新一份；不再用 33ms 时钟。已封闭块走缓存，IPC 只送尾部。

thinking：CF 之后只剩上面 3 套。删掉 0 引用的 `InlineAgentThinkingFold`。`ReasoningRow` 走同一块组件，不再直接 `MarkdownSurface` 另起一条。折叠时长只调用 `motionTokens.calcAccordionDuration`。

## d. 删除清单

- `conex-markdown` 内全部 `use pulldown_cmark` 与 `table.rs` 的 `from_pulldown`。不删 crate，不删 `render_markdown*` 的 IPC 名字。
- `ApplyReport::into_ops`。
- 两份本地 `keyOf`。保留 `markdownResultCacheKey`。
- `useStreamingMarkdownResult` 里的 `setTimeout` 轮询与空转 tick。
- `MarkdownBlockItem` 整文件（逻辑并入 `components/markdown` 的唯一块组件）及其 `isPurged`、`priority`、手写 comparator。
- `StreamingMarkdownView` 的 `text` 别名。调用方改 `content`。
- `islands/registry.tsx` 的顶层 eager import，改为 `React.lazy`。不留同步再导出兜底。
- `InlineAgentThinkingFold.tsx`。
- 三份本地 `calcAccordionDuration`。
- 字面量 `"conex_md_ordered_item_number"`（测试改为常量）。不改已落库的 attr 字符串值。

## e. 分阶段与探针

**MD-P0** 不改代码。重跑 §b 的 `rg`。若 `renderMarkdownStream` 已无前端调用，停，改记待决，不要按本方案删 IPC。若 CF 尚未合入，MD-P3 不做。

**MD-P1** 门控 a.3。合并 key；`useStreamingMarkdownResult` 改为文本变化才调度，在途结果应用或被最新请求替换，禁止丢弃后空等。封闭块只读缓存。`MarkdownBlockItem` 删除，聊天与文档共用一个块组件。`content` 单名。`priority` 与手写 comparator 删除，`React.memo` 默认比较。`VirtualMarkdownBlockList` 的局部变量改名 `viewport`，依赖只留 signature。registry 改为 lazy；流式尾块 island 用骨架，不靠 `!isActive` 才挂载。探针：

```
rg -n "function keyOf" apps/crish-desktop/src
rg -n "setTimeout\(tick,\s*(33|120)" apps/crish-desktop/src/api/markdown
rg -n "isPurged|content \?\? text" apps/crish-desktop/src/components -g "!**/*test*"
rg -n "from '\./MathIsland'|from '\./MermaidIsland'" apps/crish-desktop/src/components/markdown/islands/registry.tsx
```

预期：`keyOf` 0（`markdownResultCacheKey` 可在）；`setTimeout(tick` 0；`isPurged` / `content ?? text` 生产 0；registry 的直接 import 0。

**MD-P2** 门控 a.3。HTML 改走 md-ast；删 pulldown；`regex = { workspace = true }`（含 dev-dependencies）；删 `into_ops`。探针：`rg -n "pulldown_cmark" crates apps -g "*.rs" -g "Cargo.toml"` → 0；`rg -n "fn into_ops" crates` → 0；`markdown_commands.rs` 仍调用 `conex_markdown::render_markdown_stream`。

**MD-P3** CF 已合入且门控为空。删 `InlineAgentThinkingFold`。`ReasoningRow` 不再直接调用 `MarkdownSurface`。三处手写时长函数删除，改为 import `calcAccordionDuration`。不改 `ThinkingBlock`（应已不存在）。探针：`rg -n "function calcAccordionDuration" apps/crish-desktop/src` → 只命中 `utils/motionTokens.ts`；`rg -n "InlineAgentThinkingFold" apps -g "!**/*test*"` → 0；`rg -n "ThinkingBlock" apps/crish-desktop/src -g "!**/*test*"` → 0（若不为 0，说明 CF 未做完，停）。

**MD-P4** 不改行为，只把 MD-P2 若新增的超长文件拆到 `check:line-counts` 上限内（Rust 模块按仓库 clippy / 行数脚本，不调高）。

**MD-P5** §h。

## f. 禁止捷径

- 不留 pulldown feature、`cfg` 双解析、`render_markdown_legacy`。
- 不把 `keyOf` 改名成第四个函数就算合并。
- 不把 33ms 改成 16ms 或 rAF 空转。SS 的 rAF / 48ms thinking 批时钟不动。
- 不为了门控把脏文件 `checkout` 掉。
- 不删 `render_markdown*` 的测试金样来让新 HTML 通过；金样不一致就改发射器或说明是同一 AST 的确定差异，并更新金样时逐条写原因。断言只许更严。
- 不加 `eslint-disable`、`@ts-expect-error`。`React.lazy` 的类型用现有 ComponentType，不 `as any`。

## g. 规范

TypeScript strict；ESLint 现有配置，不新增豁免。`npm run check:line-counts`：UI tsx ≤ 500，硬阻断 > 650；基线只降。`npx knip` 不得新增未使用导出。Rust：`RUSTUP_TOOLCHAIN=1.99.1`，`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\md`，`-j 3`，clippy `-D warnings`。同一时刻只有一个 cargo。

## h. 测试

只在 MD-P5，于 worktree，Node 24：

```
npm run typecheck
npm run lint
npm run test
npm run check:line-counts
npx knip
cargo test -p conex-markdown -p conex-md-ast -p conex-note-runtime -p conex-workspace-store --offline -j 3
cargo clippy -p conex-markdown -p conex-md-ast --all-targets -- -D warnings
```

开跑 cargo 前确认没有其它 cargo，且 C 盘 ≥ 25 GB。回归：R1 流式尾块持续有 HTML 更新；R2 封闭块不重复 IPC；R3 笔记 roundtrip 测试仍绿；R4 数学占位在流式尾块可见骨架，结束后是公式。

## i. 审计

- [ ] A1 §e 探针达到预期
- [ ] A2 `git diff --name-only <base>` 落在 a.1
- [ ] A3 无新增 `eslint-disable` / `ts-ignore` / `ts-expect-error` / `pulldown`
- [ ] A4 未改 SS/CF 文件（§j）
- [ ] A5 基线文件只减不增
- [ ] A6 R1–R4 有对应用例输出

## j. 与 SS/CF/ST 的文件冲突

- SS 独占 `store/`、`hooks/chat-stream/**`、`api/sessionStreamManager.ts`、`runControlClient.ts`、`sessionDeltaWriteBarrier`。MD 不改。SS 方案把 `api/markdown/**` 列为禁止触碰，与本模块同一批文件：**MD-P1 必须等 SS 合入且 a.3 为空**。
- CF 独占 conversation-flow、`renderThought` / `renderTools`、`ProcessItemRenderer` 的槽位参数。MD-P3 不编辑这些删除，只消费删除后的树。若 CF 未合入，MD-P3 停。
- ST 独占 shared-types 生成。MD 不改 `packages/shared-types`。
- MSG 会改 `MessageContent.tsx`、`FoldableProcessSection` 若被划进消息阶段。本方案 MD-P3 改 `FoldableProcessSection` 的时长函数。MSG 方案不得再改这个函数。`MarkdownBlockItem` / `StreamingMarkdownView` 归 MD，MSG 不改。

## k. 已决

- D1：CF 删除。thinking 从「CF 之后 3 套」收，不按 4 套规划，不删 `ThinkingBlock`。
- 双引擎核实结论：两个 crate 都在生产路径。删的是 pulldown 解析，不是 `conex-md-ast`，也不是聊天 IPC 入口。
- ST-03 的「在途直接丢弃」已被工作区改成过渡帧。禁止把这段改回丢弃。未完成的是去掉 33ms 时钟。
- D11 时间真源是 `conex_shared::time`（TM）。本模块不引入新时钟类型。
- I-02 是误报，且 store 直连 `invoke` 归 SS，本模块不改取消链。
- 执行中若 HTML 无法从 BlockTree 表达现有聊天扩展（且不能加在 md-ast 而不破坏笔记 roundtrip），停，记 D13，不保留双解析。
