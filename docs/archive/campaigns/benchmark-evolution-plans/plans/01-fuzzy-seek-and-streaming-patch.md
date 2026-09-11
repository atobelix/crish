# 01 — Fuzzy Seek + Streaming Patch Progressive UI

**Directions**: A（4-pass 模糊 Hunk Seek）+ D（流式 Patch 渐进 UI）
**来源审计**: `docs/benchmark-evolution-plans/audits/00-master-findings.md`
**日期**: 2026-07-22
**约束**: 自然融入 Conex；禁止照抄 opencode/codex；无 TUI；不重做沙箱；默认确定性 4-pass seek，**不上** Levenshtein 静默改文件；Myers `DiffEngine` **仅展示**

---

## 0. 问题一句话 + 硬证据

**一句话**：Agent 编辑与桌面 Accept 都只会「精确命中 / 行号」定位变更，流式工具参数从不进 UI，行号漂移或空白差异即失败，且用户只能在工具成功后才看到 Diff。

### 硬证据（Conex 现码）

| 点 | 位置 | 现状 |
|----|------|------|
| Myers 展示、无 locator | `crates/conex-diff/src/diff_engine.rs` `DiffEngine::diff` | `similar` Myers 行 diff，IPC `compute_diff`；**无** seek / apply |
| 流式 parser 未接线 | `crates/conex-diff/src/stream_parser.rs`、`handlers/stream_parse_handler.rs`；TS `packages/shared-utils/src/file/streaming-diff-parser.ts` | 有 bench/单测，产品路径 **不消费** |
| Agent 行号编辑 | `packages/agent-runtime/src/local-tools/fs-edit-tools.ts` `applyLineEditOperations` / `createEditTool` | 仅 `startLine`/`endLine`/`line`；**无**内容 seek；行漂移 → hard fail |
| 桌面 Accept 精确匹配 | `apps/crish-desktop/src/api/applyFileDiff.ts` `analyzeSearchReplace` / `countOccurrences` | EOL 规范化后 **exact** `indexOf`；`hits > 1` / 有 context normal hunk → 拒 |
| Diff 仅终态 | `apps/crish-desktop/src/hooks/useChatStream.ts` `onToolSuccess` → `resolveToolDiffs` → `publishToolDiffsLazy` | 成功后才合成/发布 `FileDiff` |
| Provider 攒 delta、对外只 end | `packages/agent-runtime/src/anthropic-stream-parse.ts`（`input_json_delta` 累加 `argumentsText`，`content_block_stop` 才 yield `tool-call`）；`ProviderResponseConsumer` **只** `phase === "end"` 收集 tool-call | 无 args-delta 出站事件 |
| UI 合成 | `apps/crish-desktop/src/api/toolFeedback.ts` `fileDiffFromEditArgs` / `resolveToolDiffs` | 终态 args 可合成 old/new；流式阶段无调用方 |
| 接受/总览 | `ChangeOverviewCard.tsx` → `applyFileDiffToDisk` / `classifyFileDiff` | Accept 依赖可分类的终态 diff |

### 标杆语义（仅借鉴，不照搬路径/API 名）

- 4-pass locator：exact → rstrip → trim → unicode 标点/空白 normalize（确定性；**默认不做** Levenshtein）
- 流式：工具 args 增量 → 节流 partial FileDiff → 「生成中」展示；**Accept 仅终态**

---

## 1. 目标架构

```
                    ┌─────────────────────────────────────────────┐
                    │  Provider stream (Anthropic/OpenAI/…)       │
                    │  input_json_delta / tool args fragments     │
                    └──────────────────┬──────────────────────────┘
                                       │ already accumulates
                                       ▼
                    ┌─────────────────────────────────────────────┐
                    │  agent-runtime                              │
                    │  • emit tool-args-delta (NEW, opt-in sink)  │
                    │  • tool-call end (existing)                 │
                    │  • createEditTool / apply_workspace_edits   │
                    │       └─► seekSequence (TS pure)  ◄──┐      │
                    └──────────────────┬───────────────────┼──────┘
                                       │                   │
          Core events / bridge         │                   │ same pure rules
                                       ▼                   │
                    ┌──────────────────────────────────────┼──────┐
                    │  crish-desktop                         │    │
                    │  daemonChatBridge / chatApi callbacks  │    │
                    │  onToolArgsDelta (NEW) ──┐             │    │
                    │  onToolSuccess (exist) ──┤             │    │
                    │                          ▼             │    │
                    │  partialDiffAggregator (throttle)      │    │
                    │  toolFeedback.fileDiffFromEditArgs     │    │
                    │  Diff panel / ChangeOverview           │    │
                    │     status: generating | ready         │    │
                    │  applyFileDiff.analyzeSearchReplace ───┘    │
                    │     └─► seekSequence (TS) + 诊断码          │
                    └─────────────────────────────────────────────┘

                    ┌─────────────────────────────────────────────┐
                    │  crates/conex-diff                          │
                    │  DiffEngine (Myers) ── DISPLAY ONLY ──┐     │
                    │  seek_sequence (NEW) ── MUTATION LOCATOR    │
                    │  stream_parser ── optional IPC, not required│
                    │     for D UI path (TS StreamingDiffParser   │
                    │     remains available for unified-diff text)│
                    └─────────────────────────────────────────────┘

Invariant:
  Mutation locator ⟂ Myers DiffEngine
  Accept / disk write 禁止依赖 Levenshtein
  Progressive UI 不得在 generating 状态启用 Accept
```

### 模块职责（自然挂载）

| 模块 | 职责 | 非职责 |
|------|------|--------|
| `seek_sequence`（Rust + 镜像 TS 或单一 TS 权威） | 在 `lines[]` 中定位 pattern 起始下标；4-pass | 不写盘、不算 Myers |
| `apply_hunk` / `applySearchReplace*` | 用 seek 结果做唯一替换；歧义/缺失显式失败 | 不静默挑「最像」的一处 |
| `fs-edit-tools` | 可选 `old_string`/`new_string` 或 content-seek 回退；保留行号 op | 不改变 TrustZone / lease |
| `applyFileDiff.ts` | Accept 路径改用 seek；保留 path 安全与截断拒绝 | 不解析 Codex patch 文法（P1 另波） |
| streaming UI | args-delta → 节流 FileDiff → 状态徽章 | 不提前 open Accept；不重做沙箱 |

### 4-pass 契约（默认）

对 haystack 行序列 `lines` 与 pattern 行序列 `pattern`，从 `start`（可选 EOF 锚定）起：

1. **Exact** — 行字节级相等（已统一 EOL 后）
2. **Rstrip** — `trim_end` 后相等
3. **Trim** — `trim` 后相等
4. **Unicode normalize** — trim + 常见 dash/quote/nbsp → ASCII 后相等

返回：`{ index, pass }` 或 `None`。
**禁止**默认第五关 Levenshtein / 编辑距离静默命中。
多命中：返回 ambiguous（与今日 `hits > 1` 一致），不自动选第一处（除非调用方显式 `replace_all` 且产品确认——本计划默认 **不** 加 replace_all）。

---

## 2. 非目标

| 非目标 | 原因 |
|--------|------|
| TUI / React Ink | 用户硬约束 |
| 沙箱 / TrustZone / softDeny 重设计 | 现状可接受 |
| 默认 Levenshtein 静默 apply | 误改风险（审计 P2 明确禁止） |
| Myers `DiffEngine` 兼做 locator | 展示与 mutation 解耦 |
| 完整 Codex `*** Begin Patch` 文法工具 | 审计 A 缺口 #4 为 P1 后续；本计划最多预留接口 |
| 用 jcode DP 替换搜索 | 与 E 无关且打爆 SLA |
| 改 daemon 密钥 / OAuth | 另专题 |
| 强制所有编辑走 Rust IPC | TS 热路径可纯函数；Rust 供 daemon/IPC 与单测对称 |
| 流式阶段自动写盘 Accept | 仅 UI 预览 |

---

## 3. 多轮执行计划

**闸门通则**：每 Round 结束必须满足该轮 Acceptance；未过闸禁止开下一 Round。每轮 **≥4 并行 Agent**。涉及 UI 的轮次附软件内冒烟。

---

### Round A — 纯函数 Seek 核心 + 契约钉死（P0）

**目标**：可复用的确定性 4-pass locator；与 Myers 零耦合。

| Agent | 角色 | 文件 | 动作 | Acceptance |
|-------|------|------|------|------------|
| **A1** Seek-Rust | `crates/conex-diff` 作者 | 新建 `crates/conex-diff/src/seek_sequence.rs`；改 `lib.rs` 导出；**不**改 `diff_engine.rs` 语义 | 实现 `seek_sequence(lines, pattern, start, eof) -> Option<SeekHit { index, pass }>`：exact → rstrip → trim → unicode_normalize（标点/空白表与审计/codex 语义对齐但命名 Conex 风格）。空 pattern → `Some(start)`；pattern 长于 haystack → `None`。单元测试覆盖 rstrip/trim/unicode/eof | `cargo test -p conex-diff seek` 全绿；`DiffEngine` 既有测试无回归 |
| **A2** Seek-TS | 共享纯函数作者 | 新建 `packages/shared-utils/src/file/seek-sequence.ts` + `seek-sequence.test.ts`；`file/index.ts` 导出 | **镜像** A1 契约（同一组 fixture 向量）；`normalizeEol` 可复用或本地一致。导出 `SeekPass` 枚举与 `seekSequence` | vitest 与 Rust fixture 对齐（共享 JSON fixture 可选：`packages/shared-utils/src/file/fixtures/seek-cases.json` 由 A1/A2 约定） |
| **A3** Fixture/Golden | 测试资产 | `docs/...` 或 `packages/shared-utils/.../fixtures`；可选 `crates/conex-diff/tests/seek_fixtures.rs` | 构造：trailing space、缩进、`—` vs `-`、弯引号、NBSP、多命中、空 pattern、EOF 锚定、跨 CRLF | 至少 12 条黄金用例；两侧同期望 index/pass |
| **A4** API 边界审查 | 架构守门 | `diff_handler.rs`、`stream_parse_handler.rs`、`Cargo.toml` | **禁止**把 seek 塞进 `DiffEngine::diff`。可选草案：未来 IPC `seek_sequence` handler **仅** draft 注释，本轮可不接线。写 10 行 ADR 进本文件附录或 `seek_sequence.rs` 模块头 | PR 说明确认 Myers display-only；无 Levenshtein 依赖入库 |

**Round A 闸门**

- [ ] Rust + TS 4-pass 测试全绿
- [ ] 无 Levenshtein / edit-distance 依赖
- [ ] `DiffEngine` 代码路径未混入 seek
- [ ] Fixture 双语一致

---

### Round B — Mutation 消费：`applyFileDiff` + Agent edit（P0）

**目标**：磁盘 Accept 与运行时编辑从 exact-only / 纯行号 升级为 4-pass seek；失败可诊断。

| Agent | 角色 | 文件 | 动作 | Acceptance |
|-------|------|------|------|------------|
| **B1** Desktop Apply | 桌面 apply 作者 | `apps/crish-desktop/src/api/applyFileDiff.ts`；`applyFileDiff.test.ts` | 在 `analyzeSearchReplace` / `applySearchReplaceToContent` 中：将 `oldN`/`bodyN` 按行 `split`，调用 `seekSequence`；唯一命中则按 **原始行**（非 normalize 后文本）切片替换并 `preferEolStyle`；0 命中 → `missing_old`；多窗口命中 → `ambiguous`（保持今日人话）。记录 `pass` 于可选 debug 字段（json/test only，UI 可先不展示） | 现有 exact 用例全绿；新增 trailing-ws / unicode 用例 **能 apply**；多命中仍失败 |
| **B2** Agent content replace | runtime 工具作者 | `packages/agent-runtime/src/local-tools/fs-edit-tools.ts`；相关 test | 扩展 edit schema（向后兼容）：支持 `edits[].op: "replace_text"` 或独立字段 `old_string`/`new_string`（与 `toolFeedback` 已识别的 snake/camel 对齐）。实现：`seekSequence` 定位 → 唯一则替换；失败 error 文案含 pass 尝试结果（如 `seek failed after trim+unicode`）。**保留**原行号 ops。`apply_workspace_edits` 同步支持 | 行号用例不回归；whitespace drift 用例通过；歧义抛错不写盘 |
| **B3** toolFeedback 对齐 | 桌面合成 | `apps/crish-desktop/src/api/toolFeedback.ts`；`toolFeedback.test.ts` | 确保 `fileDiffFromEditArgs` 覆盖新 op 字段；`isEditToolName` 已含 `str_replace`/`search_replace`/`edit`；文档化「展示 diff 仍可用 del/add 行，apply 侧用 seek」 | 从 args 合成的 FileDiff 仍可被 `classifyFileDiff` 识别为 `search_replace` |
| **B4** 行号漂移缓解（轻） | runtime 辅助 | `fs-edit-tools.ts` `applyLineEditOperation` 附近 | **可选轻量**：当 `replace` 行号越界或内容与期望 anchor 不符时，若 input 带 `anchor`/`old_string` 则回退 seek，而非直接 throw。无 anchor 则保持今日严格行号错误（不静默乱改） | 有 anchor 的漂移用例恢复；无 anchor 仍 fail-fast |

**Round B 闸门**

- [ ] `applyFileDiff.test.ts` + agent-runtime edit 单测绿
- [ ] 软件内：制造 trailing-space 文件 → AI/手动 search_replace Accept 成功
- [ ] 多匹配仍拒绝并 toast
- [ ] snapshotTag / mutation lease / pre-mutation checkpoint **行为不变**

---

### Round C — 出站 args-delta 事件协议（D 的数据面，P1）

**目标**：把 provider 内部已有的 partial JSON 累积 **有节制地** 暴露给 UI，而不破坏 session-loop 执行语义。

| Agent | 角色 | 文件 | 动作 | Acceptance |
|-------|------|------|------|------------|
| **C1** Provider emit | stream 作者 | `anthropic-stream-parse.ts`；对称检查 `provider-openai` / gemini 若有类似累积 | 在 `input_json_delta` 累加后，**可选** yield 新事件类型，例如 `{ type: 'tool-call', phase: 'delta', id, toolName, argumentsText partial }` 或独立 `tool-args-delta`。必须：不解析半截 JSON 为执行 input；仅透传文本累积 | 现有 `provider-anthropic.test.ts` / stream contract 扩展；end 事件仍完整 |
| **C2** Consumer 旁路 | runtime | `provider-response-consumer.ts`；session-loop 若直接 iterate stream | **执行路径**仍只在 `phase===end` 收集可执行 tool-call（保持现状注释意图）。新增 `onToolArgsDelta?: (p) => void` sink 或并行 channel，**禁止**把 partial 推进 `blocks` 当可执行 tool | 无 delta sink 时零行为变化；有 sink 时单测收到 ≥1 次 partial |
| **C3** 事件投影 / daemon | 协议 | `event-protocol/core-event-types.ts`、`core-event-projector.ts`；daemon 事件映射（若工具事件出站经此） | 映射 `tool-update` / 新 delta → UI 可懂的 `tool` phase `delta`，payload 含 `toolCallId`、`name`、`argumentsText` 或 `partialArgs`。注意反压：payload 可截断（如 64KB 窗口与现有 soft 反压哲学一致） | projector 单测；大 args 截断不炸 |
| **C4** Bridge 回调 | 桌面桥 | `apps/crish-desktop/src/api/daemonChatBridge.ts`；`chatApi.ts` 回调类型 | 新增 `onToolArgsDelta?(toolId, name, partialArgs: string)`；在 tool start 后、success 前转发。与 `onToolSuccess` 并存 | 类型编译过；demo/mock 可选 stub |

**Round C 闸门**

- [ ] 无 UI 时 runtime 全量回归绿
- [ ] 契约测试：delta 不触发 tool 执行
- [ ] bridge 能收到 partial 字符串

---

### Round D — 渐进 Diff UI + 节流聚合（D 的体验面，P1）

**目标**：编辑类工具在流式参数阶段显示「生成中」Diff；终态切换 ready；Accept 仅 ready。

| Agent | 角色 | 文件 | 动作 | Acceptance |
|-------|------|------|------|------------|
| **D1** Aggregator | 桌面状态 | 新建 `apps/crish-desktop/src/api/partialToolDiff.ts`（名可调）；测试 | `onToolArgsDelta` → 按 toolId 缓冲 → **rAF 或 50–100ms throttle** → `fileDiffFromEditArgs(partial)` → 若可解析 path+old/new 则产出 `FileDiff & { provisional: true }` | 半截 JSON 不抛；解析失败静默跳过本 tick |
| **D2** Stream hooks | hooks | `useChatStream.ts` / `useAgentStream.ts`；`queueToolCallPatch` | start：标记 tool `status: running` 可带空 diffs；delta：更新 `arguments` 预览 + provisional diffs；success：`resolveToolDiffs` 终态、`provisional: false`，再 `publishToolDiffsLazy` | 成功路径与今日一致；取消/error 清理 provisional |
| **D3** Diff 面板 UI | UI | Diff 相关组件（`ChangeOverviewCard.tsx`、diff panel / DiffCard 所在组件）、`diffPanelHelpers.ts`、`store/types.ts` | FileDiff 或 toolCall 增 `source: 'streaming' \| 'final'` / `provisional`；徽章「生成中」；**Accept / applyFileDiffToDisk 按钮 disabled** 当 provisional。终态启用。可选：StreamingDiffParser 仅当 output 为 unified diff 文本时使用（非主路径） | UI 单测或 RTL：provisional 无 Accept；final 有 |
| **D4** 发布路径 | publish | `publishToolDiffs.ts`；`filterPublishableFileDiffs` | provisional 可进侧栏预览但标记；合并策略：同 path 后写优先；tool end 替换同 toolId 条目。避免目录 listing 误判（沿用 `looksLikeDirectoryListing`） | 不误开垃圾 diff；终态覆盖流式残留 |

**Round D 闸门**

- [ ] 软件内冒烟：触发长 `edit`/`str_replace` 流 → 侧栏先「生成中」再变终态 → Accept 仅终态可点
- [ ] 取消生成后 provisional 消失
- [ ] 非编辑工具（shell）不出现假 diff

---

### Round E — 硬化、可观测、文档与可选 IPC（收尾）

**目标**：跨端一致、可诊断、可维护；为后续 patch 文法留扩展点。

| Agent | 角色 | 文件 | 动作 | Acceptance |
|-------|------|------|------|------------|
| **E1** 诊断码 | UX 文案 | `applyFileDiff.ts`；edit tool errors | 统一 code：`missing` / `ambiguous` / `conflict` / `seek_failed`；message 可含「已尝试 exact/rstrip/trim/unicode」 | toast 人话；测试钉 code |
| **E2** 可选 IPC | Rust 接线 | `handlers/mod.rs` 新增 `SeekSequenceHandler`（可选） | `seek_sequence` command：payload `{ lines, pattern, start, eof }` → hit；供非 TS 宿主。**仍不**调用 DiffEngine | IPC 单测或 handler 单测 |
| **E3** 性能/安全 | 审查 | seek 实现；delta 路径 | 大文件：seek 为 O(n*m) 行级；限制 pattern 行数（如 500）与 haystack 读上限（已有 200_000 apply 读截断）。delta 频率 throttle 已在 D1 | 1000 行文件 fixture < 50ms；无路径穿越回归（`isSafeApplyPath`） |
| **E4** 文档与演进入口 | 文档 | 本 plan 勾选；`00-master-findings` 回链；必要时 `AGENTS.md` 一句「edit 优先 replace_text+seek」 | 标明 Wave 对齐：A∈W1，D∈W3 可分 PR 合并但本 plan 一体验收 | 合并说明含 DoD 勾选表 |

**Round E 闸门**

- [ ] 全量相关 vitest + `cargo test -p conex-diff`
- [ ] 软件内：seek apply + streaming UI 联合冒烟
- [ ] 无 Levenshtein；Myers 仅展示

---

### 并行关系示意

```
Round A (seek core) ──► Round B (mutation consumers) ──► Round E
                ╲                              ╱
                 ╲── Round C (args-delta) ── Round D (UI) ──╱

允许：A 完成后 B∥C；B 与 C 无强依赖。
D 依赖 C（数据）+ 弱依赖 B（终态 apply 体验一致）。
E 依赖 B+D 主路径合并后。
```

---

## 4. 测试计划

### 4.1 单元

| 层 | 用例重点 | 命令/位置 |
|----|----------|-----------|
| Rust seek | exact/rstrip/trim/unicode/eof/empty/too-long/ambiguous helper | `cargo test -p conex-diff` |
| TS seek | 同 fixture | `packages/shared-utils` vitest `seek-sequence.test.ts` |
| applyFileDiff | 精确成功；rstrip 成功；unicode 成功；ambiguous；missing；already_applied；truncated read 仍拒；context normal 仍拒 classify | `apps/crish-desktop/.../applyFileDiff.test.ts` |
| fs-edit | 行号 replace；replace_text seek；歧义不写盘；snapshotTag stale | agent-runtime local-tools tests |
| toolFeedback | old_string 合成；新 op 字段；shell 不合成 | `toolFeedback.test.ts` |
| stream contract | delta 不进入 executable blocks；end 完整 | `provider-anthropic.test.ts`、`provider-response-consumer` tests |
| projector/bridge | tool delta 映射 | `core-event-projector.test.ts` |
| partialToolDiff | 半截 JSON；throttle；provisional flag | 新 test 文件 |
| StreamingDiffParser | **保持**既有测试；不强制产品主路径依赖 | `streaming-diff-parser.test.ts` |

### 4.2 软件内（crish-desktop）

1. **Seek Accept**：工作区文件末尾加空格，构造 del 行为无空格的 FileDiff → 点接受 → 落盘正确且 already_applied 幂等。
2. **歧义**：两处相同 old → Accept 失败 toast，文件不变。
3. **Streaming**：选 Anthropic（或 mock delta）长 edit → 侧栏/总览出现「生成中」→ 完成后可接受 → 写盘。
4. **取消**：流中 Abort → provisional 清理，无残留 Accept。
5. **非编辑工具**：`run_terminal` 等不出现 diff 面板。
6. **回归**：纯行号 `edit` 小文件仍成功；`write` full_write Accept 仍成功。

### 4.3 明确不测

- Levenshtein 命中率
- TUI
- 完整 patch 文法 corpus（留给后续 plan）

---

## 5. Definition of Done

- [ ] **A**: 4-pass `seekSequence` 在 Rust（`conex-diff`）与 TS（`shared-utils`）可用，黄金 fixture 一致
- [ ] **A**: `DiffEngine` / `compute_diff` 仍为纯展示，无 seek 副作用
- [ ] **B**: `analyzeSearchReplace` / `applySearchReplaceToContent` 使用 seek；trailing-ws 与常见 unicode 标点可 Accept
- [ ] **B**: Agent `edit`（及 workspace edits）支持基于内容的唯一替换；失败显式、不静默多选
- [ ] **C**: 工具 args 流式 delta 可出站；**不可**执行 partial tool
- [ ] **D**: 编辑类工具流式阶段 progressive FileDiff +「生成中」；**Accept 仅终态**
- [ ] **D**: `onToolSuccess` 终态路径保持 `resolveToolDiffs` → `publishToolDiffs`
- [ ] **全域**: 无默认 Levenshtein；无 TUI；无沙箱重做
- [ ] 测试：§4 单测 + 软件内冒烟 1–6 通过
- [ ] 文档：本 plan 闸门勾选；与 `00-master-findings` A/D 条目可追溯

---

## 6. 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| Unicode normalize 过宽 → 错误唯一命中 | 误改文件 | 仅标点/空白类映射；多命中仍 ambiguous；保留 exact 优先 |
| 半截 JSON 频繁 parse | CPU/UI 卡顿 | throttle；try/catch 静默；截断 partial 长度 |
| TS/Rust seek 实现漂移 | 同 diff 两端行为不一致 | 共享 JSON fixture；Round E 对照测试 |
| args-delta 事件膨胀 | 总线/日志爆 | 截断 + 采样；不写 WAL 全量 partial（若事件入库需确认 event-store 策略：**默认 UI-only 不持久化 partial**） |
| 扩展 edit schema 破坏旧客户端 | 工具校验失败 | additionalProperties 已 false：新 op 用 enum 扩展并保证旧行号路径不变；模型 prompt 侧后置 |
| provisional Accept 误开 | 用户写入不完整 patch | UI disabled + `classifyFileDiff` 可对 provisional 短路 |
| 将 seek 误并入 Myers | 架构污染 | A4/E 守门；code review checklist |
| 行号+seek 双路径复杂度 | 维护成本 | 文档写清：行号严格；内容 seek 显式 op；漂移仅 optional anchor |
| StreamingDiffParser 与 args 合成双轨 | 行为分叉 | 主路径 **args 合成**；unified 文本仅 output 含 diff 时 |

---

## 附录 A — 关键符号速查

| 符号 | 路径 |
|------|------|
| `DiffEngine::diff` | `crates/conex-diff/src/diff_engine.rs` |
| `StreamParser` | `crates/conex-diff/src/stream_parser.rs` |
| `DiffHandler` / `StreamParseHandler` | `crates/conex-diff/src/handlers/*` |
| `createEditTool` / `applyLineEditOperations` | `packages/agent-runtime/src/local-tools/fs-edit-tools.ts` |
| `ProviderResponseConsumer` | `packages/agent-runtime/src/runtime-components/provider-response-consumer.ts` |
| Anthropic `partial_json` 累积 | `packages/agent-runtime/src/anthropic-stream-parse.ts` |
| `StreamingDiffParser` | `packages/shared-utils/src/file/streaming-diff-parser.ts` |
| `analyzeSearchReplace` / `applyFileDiffToDisk` | `apps/crish-desktop/src/api/applyFileDiff.ts` |
| `fileDiffFromEditArgs` / `resolveToolDiffs` | `apps/crish-desktop/src/api/toolFeedback.ts` |
| `onToolSuccess` | `apps/crish-desktop/src/hooks/useChatStream.ts` |
| `daemonChatBridge` tool 回调 | `apps/crish-desktop/src/api/daemonChatBridge.ts` |
| `ChangeOverviewCard` / Accept | `apps/crish-desktop/src/components/ChangeOverviewCard.tsx` |

## 附录 B — PR 拆分建议

1. **PR1** Round A（seek 纯函数 + fixture）
2. **PR2** Round B（applyFileDiff + fs-edit）— 可独立上线正确性
3. **PR3** Round C+D（delta 协议 + UI）— 体验
4. **PR4** Round E（IPC 可选、诊断、文档）

PR2 不依赖 PR3；符合 findings Wave：A∈W1 正确性，D∈W3 体验。
