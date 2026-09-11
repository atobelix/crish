# 04 — Session Fork / Rewind / Checkpoint Restore UI 系统补全方案

**日期**: 2026-07
**维度**: Session Fork / Checkpoint / Conversation Rewind
**证据源**: `audits/00-master-findings.md` §2.6；daemon `session-handlers` / `capabilities`；desktop `branchSession`；orchestrator `session-tree`
**原则**: 禁止本地数组冒充 durable 会话事实；未接线能力必须诚实禁用或下架；危险操作必须有 boundary / checkpoint facts + 回执

---

## 0. 问题一句话

| 表面能力                                | 真实状态                                                                                                                               | 用户风险                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Desktop「分叉 / Branch」                | **本地深拷贝** `branchSession`，无 daemon session id / event log / workspace version                                                   | 刷新丢失、与 daemon 会话列表分叉、误以为有安全回退点 |
| Daemon / Workbench `fork` SessionAction | **明确 unsupported**（有文案、有 receipt rejected）                                                                                    | 产品诚实；Desktop 绕开了这层                         |
| Conversation Rewind                     | daemon **preview/apply 已实现**                                                                                                        | Workbench/Desktop **几乎零入口**（有魂无壳）         |
| Checkpoint restore                      | list/diff 实验可用；**product restore 半截**（adapter 门控、`workbench_restore_checkpoint` 标 unsupported / 不进 capability 产品表面） | 列表像可用，恢复点了没效果或半成功                   |

P0 不是「立刻做完整 fork 树可视化」，而是：**先拆掉假 fork，把已有 rewind 接上 UI，对 restore 做实现或下架二选一**。

---

## 1. 硬证据（路径级）

### 1.1 本地 branch 假 fork（Desktop）

`apps/crish-desktop/src/store/sessionActions.ts` — `branchSession`：

- 生成本地 id：`sess-branch-${Date.now()}`
- `messages`：`JSON.parse(JSON.stringify(original.messages))` 深拷贝
- 仅写 `branchParentId` 到本地 store
- **不**调用 `apply-session-action` / 任何 daemon 协议
- 调用点：`App.tsx` 快捷键、`ChatCard.tsx`、`Sidebar.tsx` / `useAppKeyboard.ts`、`storeAccess.branchSession`

这与架构原则冲突：

- `docs/architecture/workbench-session-actions-and-split-view.md`：`fork` 必须产生真实会话分支或新 session id；无 branch facts 时 **rejected**
- `docs/plans/2026-07-product-trust-topdown.md`：ALLOWED 隐藏 fork / checkpoint restore 入口（未接线时）

### 1.2 Daemon fork unsupported（诚实侧）

`packages/agent-daemon/src/handlers/session-handlers.ts`：

```text
action.kind === "fork"
  → rejectedSessionActionReceipt(..., "unsupported",
    "SessionAction fork requires a durable orchestrator/session-tree cloning contract;
     daemon metadata store does not fake forked history.")
```

`packages/agent-daemon/src/capabilities.ts`：

- `session.actions` = experimental
  reason 明示：pin/rename/archive/delete 已持久化；**fork remains unsupported until durable session-tree cloning is defined**

Workbench contract 侧：`fork` availability = `unsupported`，effect = `branch`（测试锁定）。

### 1.3 Session-tree 库能力 vs 产品接线

`packages/agent-orchestrator/src/session-tree.ts` **已有**：

- `forkBranch(fromId, …)` / `moveLeaf` / `abandonBranchWithSummary` / `restoreLeaf` / `readBranchPath`
- append-only entries + `currentLeafId`

Conversation rewind **已依赖** session-tree leaf facts：

- `packages/agent-orchestrator/src/conversation-rewind.ts`
- daemon boundary：`session-tree-target-leaf` / `session-tree-entries` 缺失时有 typed diagnostic

**缺口**：daemon 没有「跨会话克隆 transcript + 新 session id + leaf 对齐 + workspace checkpoint 关联」的 **product-grade fork 合约**；metadata store 故意不假造 history。

### 1.4 Rewind：有魂无入口

| 层           | 状态                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Protocol     | `preview-conversation-rewind` / `apply-conversation-rewind` / boundary resolve                    |
| Tauri        | `workbench_preview_conversation_rewind` / `workbench_apply_conversation_rewind` = **implemented** |
| Capability   | `conversation.rewind` = experimental（plan/boundary 齐；部分 runtime restore 可 deferred）        |
| Desktop      | **无** `previewConversationRewind` / `applyConversationRewind` 引用                               |
| Workbench UI | FRONTEND-DESIGN-PLAN 标 ⬛「后端就绪但前端没接」                                                  |

风险：用户只能在消息上「本地删/撤回」假操作，或完全找不到「回溯到此」。

### 1.5 Checkpoint restore 半截

| 能力                                 | 状态                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| list / get-diff                      | daemon adapter 实验；Tauri `workbench_list_checkpoints` / `workbench_get_checkpoint_diff` experimental                                      |
| restore 协议消息                     | 有 `restore-checkpoint` 路由                                                                                                                |
| 默认 adapter                         | list/diff 可；**restore 未接线** → unsupported / typed error                                                                                |
| Tauri `workbench_restore_checkpoint` | status experimental + **capabilityStatus = unsupported**；不在 checkpoints capability 的 `relatedTauriCommands` 产品列表                    |
| Git restore 路径                     | runtime `git-versioning` + `expectedChangedPaths` guard **已增强**（BE-06）；conversation rewind 的 Git restore 会用 manifest changed paths |
| 产品暴露                             | BE-19 待验收：restore 命令仍未作为主 UI 产品入口点亮                                                                                        |

半截形态 = **能看见检查点，不能安全恢复**；或 UI 按钮门控隐藏但文案仍暗示「可恢复」。

---

## 2. 目标状态（验收画像）

1. **诚实**：任何标为「分叉 / Fork」的入口，要么走 durable daemon 合约并返回 committed receipt，要么禁用并显示「未支持」原因；**禁止**本地 `sess-branch-*` 深拷贝冒充。
2. **Rewind 可发现**：消息 / 会话 More 菜单有「回溯到此」→ preview 面板（边界、将取消的 run、workspace restore 步骤、deferred/unsupported 步骤）→ 用户确认 apply → 会话投影与磁盘事实一致。
3. **Restore 二选一闭环**：
   - **实现**：`workbench_restore_checkpoint` 接 restore adapter + changed-path guard + 失败不留半成功；capability 升为 experimental/implemented 且 related 命令一致；或
   - **下架**：registry unsupported + capability 去掉暗示 + UI 隐藏入口 + 文档同步；list 仅作诊断/rewind boundary 信息源。
4. **软件内测**：Tauri WebView2 + 真 daemon；刷新/重启后 fork（若实现）与 rewind 结果仍在；无仅 Vite 浏览器假绿。

---

## 3. 非目标（本方案不扩）

- 完整 Git 时间机器 UI / 多 root workspace 版本图
- Subagent full-history fork policy 产品化（保持 task-card 默认）
- Withdraw 消息级撤回（独立能力；不得伪装为 rewind）
- Split View 布局（仅要求 pane 绑定 daemon session id，不复制 history）
- 插件 / Goal / Provider 等其他维度（见 `plans/01–03/05`）

---

## 4. 多轮 ≥4 Agent 编排

> 每轮可并行 2–4 个 specialized agent；轮间有闸门。**禁止**跳过 Round A 直接做 fork 可视化。

### Round A — 诚实化（P0，1–2 天）

**Agent A1 · Desktop 假 fork 拆除**

| 项   | 内容                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 范围 | `sessionActions.branchSession`、Sidebar/ChatCard/快捷键、`storeAccess.branchSession`、相关测试                                                         |
| 动作 | ① 入口改为 disabled + toast/诊断「会话分叉尚未由 daemon 持久化支持」；或 ② 改名为「本地副本（实验/丢失风险）」并默认隐藏于 product 表面（仅 dev flag） |
| 禁止 | 继续展示为「Fork / 安全分叉 / 可回退」                                                                                                                 |
| 验收 | 主路径无 `sess-branch-*` 成功路径；测试从「创建子会话」改为「拒绝或 dev-only」                                                                         |

**Agent A2 · Capability / Registry / 文案对齐**

| 项   | 内容                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| 范围 | daemon `capabilities`、Workbench contract fork availability、desktop 文案、checkpoint restore registry     |
| 动作 | 统一：`fork` = unsupported；`restore_checkpoint` 不在 product usable 列表；list/diff 标明 experimental     |
| 验收 | contract/capability 测试：available 能力不引用 unsupported 产品命令；UI `isCommandUsable` 与 registry 一致 |

**Agent A3 · 审计清单固化**

| 项   | 内容                                                                                     |
| ---- | ---------------------------------------------------------------------------------------- |
| 产出 | 本维度「假成功路径」检查表：本地 branch、假 withdraw、假删消息当 rewind、空 restore 按钮 |
| 验收 | CI 或脚本可扫关键入口字符串（可选，不阻塞 A1）                                           |

**Round A 闸门**：Desktop 主路径不再冒充 durable fork；capability 文案与 UI 一致。才可进入设计/实现轮。

---

### Round B — Durable Fork 设计（P1 设计，2–3 天；实现可后置）

**Agent B1 · 合约设计师（协议 + 数据模型）**

Durable fork 最低合约（草案，实现前冻结）：

```text
ApplySessionAction { kind: "fork", fromEventSeq? | fromLeafId?, title?, idempotencyKey }
  → SessionActionReceipt
       committed: {
         newSessionId,
         parentSessionId,
         forkLeafId / branchRootLeafId,
         copiedEventRange | sharedEventLogCursor,
         workspaceCheckpointId? | "workspace-not-forked",
         createdAt
       }
       rejected: unsupported | missing-facts | active-run-conflict | ...
```

硬约束：

1. **单一事实源**：新 session 与 leaf 写在 orchestrator event store / session tree；Workbench 只消费 receipt。
2. **禁止半成功**：metadata 写了但 event log 未克隆 → 必须 rollback 或根本不写。
3. **Workspace 策略显式**：
   - v1 推荐：`workspacePolicy: "share-cwd"`（共享工作区，不复制文件；fork 只分会话历史）
   - 可选后续：`snapshot-at-fork`（创建 checkpoint 并关联）
   - 禁止静默假设「分叉了磁盘」。
4. **活跃 run**：源会话有 active run 时默认 `rejected` 或要求先 cancel；不得复制半截 tool 状态当成功。
5. **与 rewind 关系**：fork 从 leaf/event 切开；rewind 在**同一 session** 内 `moveLeaf`；两者共享 session-tree，不共享 UI 入口语义。

**Agent B2 · Session-tree 产品化差距分析**

| 已有                              | 缺                                                               |
| --------------------------------- | ---------------------------------------------------------------- |
| 进程内 `SessionTree.forkBranch`   | daemon 持久化 session 克隆 API                                   |
| leaf-aware context reconstruction | 跨 session id 的 history 投影 API                                |
| rewind boundary facts             | fork 后 parent/child 索引与 list-sessions 字段（`branchedFrom`） |

产出：`design-notes` 级别 ADR 段落（可落本文件附录或 `docs/architecture/` 后续 PR）；**本轮只设计不写大实现**，除非 A 已闸、资源允许做 spike。

**Agent B3 · 参考实现调研（可选并行）**

- 开源：OpenCode / Cline / Aider 等会话 branch 行为（clone 到 `reference/` 时只读）
- 结论写入：采用「新 session id + 共享 cwd」还是「同 session 多 leaf」产品叙事（推荐：**新 session id 面向用户，底层仍可共享 event 前缀**）

**Round B 闸门**：合约字段、失败码、workspacePolicy 枚举冻结；实现排期进 Round D 或独立里程碑。**未冻结前 Workbench/Desktop 不得打开 fork 按钮。**

---

### Round C — Rewind UI 接线（P1，与 B 可部分并行，2–4 天）

**Agent C1 · Workbench / Desktop 入口**

| 入口                 | 行为                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| 消息气泡「回溯到此」 | 取 message/event 关联 target → `preview`                                                |
| 会话 More → Rewind   | 打开边界选择 / 最近 boundary 列表                                                       |
| 不走                 | `apply-session-action` 的 `kind: rewind`（daemon 已拒绝并指向 conversation-rewind API） |

**Agent C2 · Preview 面板**

展示 daemon preview 事实，不得本地编造：

- target leaf / event
- 将取消的 runs / 清理的 approvals
- workspace restore 步骤：supported / deferred / unsupported（typed）
- 危险摘要：将丢弃的消息数、可能触及的文件路径（来自 manifest，非前端猜）

确认后 `apply`；`committed` 后刷新 session 投影；`failed/rejected` 保留原状态 + diagnostics。

**Agent C3 · 软件内 E2E**

场景（真 Tauri + daemon）：

1. 多轮对话后 preview → 取消 apply → 状态不变
2. apply 成功 → 刷新仍停在 rewind 后 leaf
3. 缺 session-tree facts → UI 显示 diagnostic，不假成功
4. 与活跃 run 冲突 → 明确取消 run 或 rejected

**Round C 闸门**：主对话路径用户可完成一次真实 rewind；无「只有后端测过」的 ⬛ 状态。

---

### Round D — Checkpoint Restore：实现或下架（P1，2–5 天）

**决策树（先开会 30 分钟，再派 agent）**

```text
restore 是否要成为产品卖点？
  ├─ 是 → D-Implement
  └─ 否 → D-Sunset（更快，仍算本维度闭环）
```

#### D-Implement

**Agent D1 · Restore adapter 接线**

- 默认 daemon checkpoint adapter 实现 `restoreCheckpoint`
- 复用 `expectedChangedPaths` / dangerous guard（`git-versioning`）
- conversation rewind 与独立 restore 命令共用 failure 类型，禁止前端本地删文件绕过

**Agent D2 · 产品表面**

- `workbench_restore_checkpoint`：capability 与 registry 同步升级；加入 `relatedTauriCommands`
- 项目面板：list → diff → restore 确认（路径清单 + 失败回滚说明）
- 半成功禁止：manifest 与 git diff 不一致 → 触碰文件前失败

**Agent D3 · 测试**

- unit：path mismatch 失败
- 软件内：创建 checkpoint → 改文件 → restore → 磁盘 oracle 比对

#### D-Sunset

**Agent D1s · 下架**

- registry 保持/标死 unsupported；capability reason 改为「restore 未提供；请用 conversation rewind（若 workspace 步骤支持）或外部 git」
- UI 去掉 Restore 按钮；list/diff 可留诊断或一并降为 dev-only
- FRONTEND / AGENT-COORDINATION 同步 BE-06/BE-19 状态为「明确不做产品入口」或「延期」

**Round D 闸门**：不存在「能点 restore 却 noop / 假 true」；实现与下架二选一写进 capability snapshot。

---

## 5. 推荐落地顺序（汇总）

| 序  | 轮                | 优先级    | 产出                          |
| --- | ----------------- | --------- | ----------------------------- |
| 1   | A 诚实化          | P0        | 假 fork 禁用；capability 对齐 |
| 2   | C Rewind UI       | P1        | preview/apply 主路径入口      |
| 3   | D Restore 闭环    | P1        | 实现 **或** 下架              |
| 4   | B 设计 → 后续实现 | P2/里程碑 | durable fork 合约冻结后再开发 |

说明：C 可与 B 设计并行；**fork 实现不得插队到 A 完成前**。D 不依赖 B；D 与 C 共享 workspace restore 类型时需接口对齐（同一 typed failure）。

---

## 6. Agent 协作协议（本维度）

1. **所有权**：daemon 拥有 session/run/checkpoint/rewind 事实；Desktop/Workbench 只发 action、收 receipt、投影 UI。
2. **状态枚举**：`implemented | experimental | backend-not-wired | unsupported | degraded` — 禁止用空数组表示成功。
3. **回执**：`committed | rejected | failed`；rejected 不改列表事实。
4. **中文文件**：本方案与 UI 用户文案用中文；协议字段保持英文 kind。
5. **测试**：单元测合约；**验收必须在 Tauri 软件内**，含刷新/重启。
6. **禁止**：本地 `branchSession` 当 product fork；前端删消息当 rewind；restore 绕过 manifest。

---

## 7. 关键文件地图

| 区域               | 路径                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ |
| 假 fork            | `apps/crish-desktop/src/store/sessionActions.ts`（`branchSession`）                  |
| 入口               | `ChatCard.tsx` / `Sidebar.tsx` / `App.tsx` / `useAppKeyboard.ts` / `storeAccess.ts`  |
| Daemon fork 拒绝   | `packages/agent-daemon/src/handlers/session-handlers.ts`                             |
| Capability         | `packages/agent-daemon/src/capabilities.ts`                                          |
| Session tree       | `packages/agent-orchestrator/src/session-tree.ts`                                    |
| Rewind 核心        | `packages/agent-orchestrator/src/conversation-rewind.ts`；daemon boundary + handlers |
| Tauri 注册         | `apps/agent-workbench/src/core/tauri-command-registry.ts`                            |
| Checkpoint adapter | `packages/agent-daemon/src/daemon-product-adapters.ts` / `server-runtime-factory.ts` |
| Git restore guard  | `packages/agent-runtime/src/git-versioning.ts`                                       |
| 架构约束           | `docs/architecture/workbench-session-actions-and-split-view.md`                      |
| 审计               | `docs/system-completion-plans/audits/00-master-findings.md` §2.6                     |

---

## 8. 验收清单（DoD）

- [ ] Desktop 主 UI 无 durable 伪装的 `branchSession` 成功路径
- [ ] `apply-session-action` fork 仍为 rejected/unsupported，直至 Round B 合约落地并实现
- [ ] 用户可在软件内对真实会话执行 rewind preview + apply，刷新后一致
- [ ] Checkpoint restore：**要么**端到端可恢复且失败可诊断，**要么**入口与 capability 已下架
- [ ] capability / registry / UI 三处对 fork、rewind、restore 状态一致
- [ ] 无「半成功」：metadata 已变但 workspace/event 未变，或反之

---

## 9. 风险与回滚

| 风险                               | 缓解                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| 用户依赖本地 branch 做「草稿会话」 | A 轮提供「新建空会话」替代；dev flag 保留本地副本并强警告                       |
| Rewind apply 破坏工作区            | preview 强制展示路径；Git restore 走 expectedChangedPaths；无 facts 则 rejected |
| 过早实现 fork 导致双写             | B 闸门；实现前 capability 保持 unsupported                                      |
| Restore 与 rewind 双通道状态分裂   | 共享 adapter 与 failure 类型；同一 checkpointId 语义                            |

回滚：A 轮改动以「禁用入口」为主，回滚成本低；C/D 以 feature flag / registry status 回退。

---

## 10. 附录：四句口号（给执行 agent）

1. **本地深拷贝不是 fork。**
2. **Daemon 已拒绝的 fork，前端不得私自成功。**
3. **Rewind 后端已就绪 —— 缺的是按钮与 preview，不是再写一套假逻辑。**
4. **Restore 要么做完，要么下架；半截产品入口是 P0 信任债务。**
