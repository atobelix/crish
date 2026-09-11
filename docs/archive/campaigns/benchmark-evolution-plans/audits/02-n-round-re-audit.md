# 02 — N-Round Re-Audit (Strict)

**日期**: 2026-07-22
**对照**: [`01-post-execution-strict-audit.md`](./01-post-execution-strict-audit.md)
**方法**: 只读复审（除本文件外不改产品代码）；以 file:line 真值为准，不信进度文档、不信「旁路单测绿」
**范围**: 用户指定 7 项 N-round 修复目标

**总判**: N-round 修好了 **5/7 的硬核缺口**（maxTokens 真阶梯、搜索重建+诚实空态、Rust 1600+safe drop、4D 折叠定价、seek 双语 fixture）。**args-delta 端到端仍断在桌面桥**：runtime 真 emit + session-loop 真出站，但 `daemonChatBridge` **不消费** session-loop 实际发出的 `tool-update` 形态 → 产品 UI 仍可能永远看不到「参数生成中」。**不得宣称流式 Diff / progressive args 产品完成**。

---

## 0. 七项总表

| # | 目标 | 裁定 | 相对 01 |
|---|------|------|---------|
| 1 | maxTokens real escalate（非仅 continue-nudge） | **FIXED** | P0-5 关闭 |
| 2 | Anthropic args-delta emit + session-loop tool-update | **FIXED（层内）/ STILL OPEN（到桌面）** | P0-4 半关 |
| 3 | Progressive partialArgs UI（Accept disabled） | **FIXED（UI 壳）/ STILL OPEN（无生产数据面）** | P0-4 UI 半关 |
| 4 | Search rebuild + honest empty states | **FIXED**（有残留） | P0-1 / P0-2 关闭 |
| 5 | Rust `IMAGE_TOKEN` 1600 + safe drop | **FIXED**（测试偏弱） | P0-3 关闭 |
| 6 | 4D advanced pricing collapsed UI | **FIXED** | P1-5 UI 主缺口关闭 |
| 7 | Seek fixture Rust/TS parity | **FIXED** | P1-1 关闭 |

**完成度（严格）**: 功能闸门 **5 全绿 + 2 假半绿**。假半绿 = 层内代码存在 + 跨层契约未闭合。

---

## 1. FIXED — 有证据

### 1.1 maxTokens real escalate — **FIXED**

**01 指控**: session-loop 仅 synthesis continue；无 maxTokens 阶梯；测试把 “escalate” 语义降级为 continue-only。

**现证**

| 证据 | 路径:行 |
|------|---------|
| 阶梯状态字段 + 常量 | `packages/agent-runtime/src/agent-session-loop.ts:306-325` — `lengthMaxTokensEscalationCount`、`maxTokensOverride`、`LENGTH_MAX_TOKENS_CAP=32768`、`MAX_LENGTH_MAX_TOKENS_ESCALATIONS=2`、`MAX_LENGTH_CONTINUE_NUDGES=1` |
| length 优先 escalate，再 continue-nudge，再 stop | 同文件 `:812-842` |
| 真翻倍逻辑 | 同文件 `:1858-1878` — `tryEscalateMaxTokensForLengthRecovery` → `current * 2` 封顶 cap |
| 请求真带 maxTokens | 同文件 `:1912-1921` — `resolveRequestMaxTokens()` 写入 `providerRequest.maxTokens` |
| 测试断言调用参数 | `packages/agent-runtime/src/agent-session-loop.test.ts:689-725` — base → `*2`；`:750-782` — base → `*2` → `*4` 再 continue 保持 cap；`:797-825` — 已在 cap 只 nudge 不抬 |

**判定**: 名副其实的 maxTokens 阶梯 + 有限 continue 回落。**关闭 P0-5**。

**残留（非阻断）**: length + tool-call 同帧仍故意不 escalate（`:854-858`）——与注释一致；01 P1-8 边界测仍可补，不升 P0。

---

### 1.2 Search rebuild + honest empty states — **FIXED**

**01 指控**: `SearchHandler.files: Vec::new()` 恒空；`search_index_ready: true` 硬编码；0 hits 永 `index_not_ready`。

**现证 — 索引接线**

| 证据 | 路径:行 |
|------|---------|
| 共享 `RwLock<Vec<String>>` 常驻列表 | `apps/agent-workbench/src-tauri/src/core_commands.rs:56-59,223-238` |
| Search 读 live files | 同文件 `:64-78` |
| Rebuild: `build_directory_index` 写回 | 同文件 `:105-124` — `RebuildSearchIndexHandler` |
| Status 诚实：`count > 0` | 同文件 `:209-210` — `search_index_ready: count > 0` |
| Tauri 命令 + main 注册 | 同文件 `:252-265`；`main.rs` 注册 `core_rebuild_search_index` |
| 桌面 API | `apps/crish-desktop/src/api/rustCore.ts:54-63,142-162` |

**现证 — 诚实空态**

| 证据 | 路径:行 |
|------|---------|
| `no_match` 可达；仅 `indexReady===false` → `index_not_ready` | `apps/crish-desktop/src/api/quickOpenHelpers.ts:69-90` |
| 测试钉死 ready+0hits → `no_match` | `apps/crish-desktop/src/api/quickOpenHelpers.test.ts:65-114` |
| QuickOpen 打开时 rebuild once + 传 `indexReady` | `apps/crish-desktop/src/components/QuickOpen.tsx:68-89,135-142` |

**判定**: **关闭 P0-1 / P0-2**。Ctrl+P 在有工作区且 rebuild 成功后可非空；真无匹配不再伪装未就绪。

**残留（P2，不阻断本项）**

1. 未用 `conex_search::GlobalIndex` / `ArcSwap`（crate 仍有 `index.rs:29-36`，workbench 自管 `RwLock`）——功能等价，非 plan 字面 BinaryHeap/GlobalIndex。
2. Rebuild **仅** QuickOpen 打开触发，非「开仓即 rebuild」全生命周期。
3. 无 `is_indexing` 中态：rebuild 进行中仍可能短暂 `index_not_ready` / 空 hits。
4. top-K 仍全量 sort（01 P1-12）——索引非空后才有 SLA 意义。

---

### 1.3 Rust IMAGE_TOKEN 1600 + safe drop — **FIXED**

**01 指控**: Rust `* 500` + 盲 `remove(1)` 切断 tool pair。

**现证**

| 证据 | 路径:行 |
|------|---------|
| `IMAGE_TOKEN_COST = 1600` | `crates/conex-compaction/src/compaction.rs:95-96` |
| 计费与剥离统一用常量 | 同文件 `:53,71,89` |
| `safe_drop_end`：assistant 吞后续 tool；lone tool 不 drop | 同文件 `:98-120` |
| emergency/mild 走 `drain(1..end)` 非盲 `remove(1)` | 同文件 `:63-90` |

**判定**: **关闭 P0-3** 功能面。与 TS `IMAGE_TOKEN_COST=1600` 对齐意图成立。

**残留（测试债，P1）**

- 无断言 `IMAGE_TOKEN_COST == 1600` 的单测。
- 无「assistant+tool 成对不被切断」回归测（仅有 `test_emergency_compaction_triggers` 等弱测，`:201-215`）。
- `safe_drop_end` 对孤立 `tool` 返回 `start`（不 drop）——极端序列可能 stall 压缩；未证明与 TS `safeCompactionCutoff` 完全同构。

---

### 1.4 4D advanced pricing collapsed UI — **FIXED**

**01 指控**: Settings 价表仅 2 列；用户无法配 Pcr/Pcw。

**现证**

| 证据 | 路径:行 |
|------|---------|
| 4D 公式 + 默认倍率 | `apps/crish-desktop/src/api/pricingStore.ts:5-9,34-37` |
| 倍率持久化 | 同文件 `:19-20,57-77` + `saveCachePriceOpts` |
| 主表仍 2 列；**高级定价** `<details>` 折叠 | `apps/crish-desktop/src/components/SettingsUsageTab.tsx:335-375` |
| 缓存读/写倍率输入 + 保存 | 同文件 `:343-372` |
| 默认不展开（`<details>` 无 open） | `:336` |

**判定**: plan「4 价体验」以 **2 列主编辑 + 折叠倍率** 落地，可勾本项。**关闭 P1-5 Settings 主缺口**。

**残留**

- Overview `cost===0` 时回落 **2D** `estimateCostUsd`（`OverviewCard.tsx:344-347`）——有 cache 时 stream 路径写 4D cost（`useChatStream.ts:1289-1340`），回落合理但未在 UI 标注「2D 估算」。
- 非 per-model 独立 Pcr/Pcw 列（全局倍率）——与 plan「4 列」字面略异，产品可接受。

---

### 1.5 Seek fixture Rust/TS parity — **FIXED**

**01 指控**: 仅 TS 消费 `seek-cases.json`；Rust ad-hoc；无双语机械锁定。

**现证**

| 证据 | 路径:行 |
|------|---------|
| 模块文档声明共享 golden | `crates/conex-diff/src/seek_sequence.rs:11` |
| `include_str!` 同一 JSON | 同文件 `:328-332` |
| ≥12 cases；hit/ambiguous/missing 断言 index+pass | 同文件 `:335-383` |
| TS 仍 `import golden from "./fixtures/seek-cases.json"` | `packages/shared-utils/src/file/seek-sequence.test.ts:11` |

**判定**: **关闭 P1-1**。两侧锁定同一向量；漂移会在 `cargo test` / vitest 暴露。

**残留**: fixture 路径靠相对 `include_str!`（`../../../packages/...`），monorepo 搬迁会断；可接受。

---

## 2. STILL OPEN / 假半绿 — 苛评

### 2.1 Anthropic args-delta emit + session-loop tool-update

#### 层内：**FIXED**（相对 01「不 emit / normalize 仅 end」）

| 层 | 证据 |
|----|------|
| Anthropic 累加后 **yield** `tool-args-delta` | `packages/agent-runtime/src/anthropic-stream-parse.ts:123-144`（01 的 `continue // 无 yield` 已消失） |
| normalize：`tool-args-delta` → `tool-call` `phase:"delta"`，无 executable input | `packages/agent-runtime/src/provider-stream-contract.ts:596-608` |
| consumer 旁路 `onToolArgsDelta`，禁止推进 blocks | `packages/agent-runtime/src/runtime-components/provider-response-consumer.ts:95-106` |
| session-loop sink → **AgentEvent `tool-update`** + `metadata.kind: 'tool-args-delta'` | `packages/agent-runtime/src/agent-session-loop.ts:594-612` |
| Anthropic 单测真实 partial_json 路径 | `packages/agent-runtime/src/provider-anthropic.test.ts:429-464` |

#### 跨层到桌面：**STILL OPEN（P0 残留）**

生产出站形状是：

```text
{ type: "tool-update", toolCallId, update: { text, metadata: { kind: "tool-args-delta", argumentsText, toolName } } }
```

桌面桥 **只** 认：

```text
tool-args-delta | tool_args_delta | tool-call-delta | tool_call_delta | (tool-call && phase=delta)
```

证据：`apps/crish-desktop/src/api/daemonChatBridge.ts:652-676`。

**全文件无 `tool-update` 分支**（grep `handleAgentEvent` 类型列表：message / tool-start / tool-args-delta… / tool-end / approval / run… — **无 tool-update**）。

`parseToolArgsDeltaEvent` 对裸 `tool-update` + progress 明确返回 null，且测试钉死：

- `apps/crish-desktop/src/api/partialToolArgs.test.ts:105-112` — `type: 'tool-update'` **ignores**。

桥测试只注入 **假** `type: 'tool-args-delta'` / `tool-call phase=delta`（`daemonChatBridge.test.ts:340-367`），**从不**注入 session-loop 真形状。

| 环节 | 状态 |
|------|------|
| Anthropic parse emit | ✅ |
| contract normalize phase=delta | ✅ |
| consumer sink | ✅ |
| session-loop → tool-update | ✅ 出站 |
| daemon 透传 AgentEvent | ✅（域事件含 tool-update，`shared-types/events.ts:20`） |
| desktop bridge 消费 | ❌ **丢弃** |
| UI partialArgs | ⚠️ 仅人造事件可达 |

**苛评**: 01 警告的「旁路 API + 孤立单测」**部分重演**——发射侧修好了，**最后一公里形状错配**。session-loop 注释写「Reuses tool-update」与桌面注释写「No-op until daemon/provider emits delta」**互相矛盾**：runtime 已 emit，桥在等另一个 type 名。

**OpenAI 对称**: runtime 侧 **无** openai `tool-args-delta` grep 命中——仅 Anthropic 路径出站。非本项字面阻断，记 P2。

---

### 2.2 Progressive partialArgs UI（Accept disabled）

#### UI 壳：**FIXED（结构）**

| 证据 | 路径:行 |
|------|---------|
| store `partialArgs?` | `apps/crish-desktop/src/store/types.ts:201-204` |
| stream patch 写 partialArgs，终态清掉 | `apps/crish-desktop/src/hooks/useChatStream.ts:890-900,1052-1088` |
| running + partialArgs →「参数生成中…」预览；注释 **无 Accept / 不落盘** | `apps/crish-desktop/src/components/ChatToolCallBlock.tsx:446-448,775-808` |
| SizeValidator 剥离 partialArgs（不持久化） | `apps/crish-desktop/src/utils/SizeValidator.ts:99-100` |
| 真·Accept 仅出现在 **已完成** FileDiff 列表 | `ChangeOverviewCard.tsx:444-455`；`DiffCardFileList.tsx:258-259` — `disabled={busy \|\| !canApply}` 与 partial 无关 |

**「Accept disabled」语义**: 实现是 **provisional 阶段根本不渲染 Accept**（比 disabled 更强），Accept 仅绑定终态 diff。符合「不落盘 / 不执行 partial」意图。

#### 数据面：**STILL OPEN**

无 `partialToolDiff` 模块（全仓仅 bridge/partialToolArgs 注释提及 progressive）。无流式 hunk Diff UI——仅 **args 文本预览**。若 plan D 要求 provisional Diff 卡片，**仍未做**（args preview 是降级交付）。

因 §2.1 桥断裂，生产 Anthropic 流 **大概率永不点亮** `partialArgs` 行。UI 测试/组件存在 ≠ 用户可见。

**判定**: **不得勾** plan「渐进 Diff UI 完成」；可勾「preview 骨架 + Accept 不在 provisional 路径」。

---

## 3. 对照 01 P0 状态刷新

| 01 ID | 主题 | 本轮 |
|-------|------|------|
| P0-1 | 搜索恒空 | **FIXED** |
| P0-2 | no_match 不可达 | **FIXED** |
| P0-3 | Rust 500 + remove(1) | **FIXED** |
| P0-4 | args-delta 闭环 | **仍 OPEN（桥形状）** |
| P0-5 | maxTokens escalate | **FIXED** |

**新 P0（本轮）**

- **P0-N1**: `tool-update` + `metadata.kind=tool-args-delta` ↔ 桌面只认 `tool-args-delta` / `tool-call phase=delta` —— **契约断链**。

---

## 4. 假绿清单（更新）

| # | 信号 | 状态 |
|---|------|------|
| 1 | consumer delta sink 绿但生产不发 | **部分解除**（Anthropic 已发） |
| 2 | QuickOpen 0 hits ⇒ 恒 index_not_ready | **解除** |
| 3 | search_index_ready 硬 true | **解除** |
| 4 | length 测试用 escalate 词不测 maxTokens | **解除** |
| 5 | **新** bridge 测 `tool-args-delta` 绿，session-loop 发 `tool-update` | **命中** |
| 6 | partialArgs UI 组件在、事件永远不到 | **命中** |
| 7 | Rust compact 有 safe_drop、无 pair 单测 | **弱绿** |

---

## 5. 文件:行证据索引（本轮）

| 项 | 路径 | 行（约） | 结论 |
|----|------|----------|------|
| maxTokens 状态机 | `agent-session-loop.ts` | 306-325, 812-842, 1858-1921 | FIXED |
| maxTokens 测 | `agent-session-loop.test.ts` | 689-837 | FIXED |
| Anthropic emit | `anthropic-stream-parse.ts` | 123-144 | FIXED |
| normalize delta | `provider-stream-contract.ts` | 596-608 | FIXED |
| consumer sink | `provider-response-consumer.ts` | 95-106 | FIXED |
| session-loop tool-update | `agent-session-loop.ts` | 594-612 | FIXED 出站 |
| bridge 丢 tool-update | `daemonChatBridge.ts` | 652-676 | **OPEN** |
| partialArgs UI | `ChatToolCallBlock.tsx` | 775-808 | 壳 FIXED |
| Search rebuild | `core_commands.rs` | 56-124, 209-210, 223-265 | FIXED |
| Empty honesty | `quickOpenHelpers.ts` | 69-90 | FIXED |
| IMAGE 1600 | `compaction.rs` | 95-96, 63-120 | FIXED |
| 4D 折叠 | `SettingsUsageTab.tsx` | 335-375 | FIXED |
| seek golden | `seek_sequence.rs` | 328-383 | FIXED |

---

## 6. 是否需要下一轮多 Agent？

**需要，但应极窄**——不要再开大而全 N-round。优先 **1 个契约闭环 round**。

### Round N+1 — args-delta 端到端（建议 3 agents，独占文件）

| Agent | 独占 | 交付 | 闸门 |
|-------|------|------|------|
| B1 Bridge | `daemonChatBridge.ts` + test | 识别 `tool-update` 且 `update.metadata.kind === 'tool-args-delta'`（或 `update.json`）→ `onToolArgsDelta`；**不**把普通 progress tool-update 当 args | 单测：注入 **session-loop 真形状** → deltas 非空 |
| B2 Parser | `partialToolArgs.ts` + test | 从 nested `update.metadata` / `update.text` 抽 argumentsText；保留 ignore 纯 progress | 与 B1 同 fixture |
| B3（可选）E2E | session-loop 或 integration test | mock Anthropic partial_json → 录到的 AgentEvent 含 tool-update args → bridge → partialArgs | 一条竖切测禁止假绿 |

**非目标本轮**: 重写 GlobalIndex、Settings 四列、Overview 2D 标注、compaction pair 测（可挂 R+1 债清单，非阻断）。

### 可不排多 agent 的债

- Rust compact：补 `IMAGE_TOKEN_COST` + pair 单测（单 agent 即可）。
- OpenAI args-delta 对称 emit（产品若默认 OpenAI 兼容代理则升优先）。
- QuickOpen 开仓即 rebuild / `is_indexing`。
- Overview 2D 回落显式文案。

---

## 7. 最终裁定

| 问题 | 裁定 |
|------|------|
| 七项是否可对用户说「全部修好」？ | **否** — 2/3 未端到端 |
| 可诚实说什么？ | maxTokens 真阶梯、搜索可 rebuild+诚实空态、Rust 1600+safe drop、4D 折叠定价、seek 双语 golden **已落地** |
| 最危险残留假绿？ | **args-delta：runtime 绿 + bridge 测绿 + UI 空壳** |
| softDeny / 非目标？ | 本轮未复扫；无改动迹象要求重开 |
| 是否再开大规模多 agent？ | **否**；仅 N+1 窄契约闭环 |

**一句话**: N-round 把 01 的五个真 P0/P1 硬洞补上了；流式参数预览仍停在「发射机已开、接收机认错频道」——**在 bridge 认 `tool-update` 真形状之前，严格审计判定 progressive args 产品未完成**。

---

*审计人: Conex STRICT RE-AUDIT agent · 只读 · 不降标准 · 对照 01*
