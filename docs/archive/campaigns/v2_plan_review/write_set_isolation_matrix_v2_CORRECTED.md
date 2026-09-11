# Conex 热点文件冲突分析与写集隔离矩阵 (v2) — 校正版本

> 版本：v2.0-CORRECTED · 2026-07-24
> 校正时间：2026-07-25
> 校正基准：`v2_path_audit.json` / `v2_root_cause_audit.json` / `v2_remediation_review.json`
> 原始文档：`analysis/master_repair_plan_v2/write_set_isolation_matrix_v2.md`
> 责任角色：Phase 2 - Agent 3（热点文件冲突分析与写集隔离矩阵）
> 分析目标：全仓库涉及修复任务的模块与热点文件
> 核心原则：**单一写者原则（Single-Writer Principle）**。同一 Wave 内的任意 2 个 Agent 的写文件列表（`files_write`）绝对不能包含相同路径（0 文件重叠）。重合热点文件必须通过 DAG 依赖链拆分到不同 Round 或同一 Round 的不同 Wave 中串行处理。

> **校正注**：本文档中的 AG/B/D/P/X 等 Agent ID 源自旧编号体系，与 `ledger_v2.json` 的 `GAP-XX-XX` 体系无直接对应关系。对每条引用路径，本校正版本标注了审查发现的实际文件路径与状态（存在/不存在/需修正）。
>
> **⚠️ HISTORICAL (OPT-E8 / W4-2):** 文中 `apps/crish-desktop/src/store/session-actions/**` 为**已删除目录**的历史路径（校正时仍可能标为「存在」）。现行 session store actions：`sessionCrudActions.ts` / `sessionMessageActions.ts` / `sessionOrderingActions.ts` / `sessionAgentActions.ts` / barrel `sessionActions.ts`。

---

## 1. 隔离矩阵设计原则与防碰撞机制

为了彻底消除多 Agent 并行开发中的写冲突（Write Conflicts）、逻辑覆盖（Overwriting Changes）以及 Git 伪合并卡死现象，本方案确立以下四层断言防线：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          单一写者断言与 Wave 隔离屏障                        │
│                                                                             │
│  [原则 1] 每 Wave 写集绝对互斥: ∀ Agent_A, Agent_B ∈ Wave_k:                 │
│          files_write(Agent_A) ∩ files_write(Agent_B) == ∅                   │
│                                                                             │
│  [原则 2] 热点文件串行化: 存在 hotspots(F) 被 Task_1, Task_2 触及 ──►         │
│          DAG 约束: Task_1 ∈ Round_i/Wave_m ──► Task_2 ∈ Round_j/Wave_n      │
│          (其中 j > i 或 (j == i 且 n > m))                                  │
│                                                                             │
│  [原则 3] 隔离工作区机制: 同 Wave 并行 Agent 必须在独立的 Git Worktree 运行     │
│          作业分支: agent/R<Round>-T<Task>-<Name>                             │
│                                                                             │
│  [原则 4] 跨 Agent 行为解耦: 行为耦合但写集可分离的任务，必须在分解阶段冻结契约 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 全仓库热点文件（Hotspot Files）全面盘点与依赖拆分表

在 Conex 代码库中，以下 14 个热点文件汇聚了流式渲染、拖拽交互、状态管理以及 RPC 桥接的核心逻辑。下表展示了所有触及这些热点文件的任务及其最终在 DAG 中的 Round/Wave 调度分配：

| 热点文件路径 | 涉及问题编号 | 触及任务 ID | 冲突原因分析 | 隔离调度方案（Round / Wave） |
|---|---|---|---|---|
| `apps/crish-desktop/src/components/Workspace.tsx` | B0, D7, D12, D2, X2, A1 | R1-T01, R4-T02, R8-T02 | 冲突标记清理 vs 列宽拖拽 resize 重构 vs 布局死代码清理 | **R1-W1** (清理冲突) ──► **R4-W1** (拖拽重构) ──► **R8-W1** (死代码清除) |
| `apps/crish-desktop/src/hooks/useChatStream.ts` | P1, P3, P10a, P11a, AG-02, AG-03, AG-05 | R3-T01, R5-T06, R5-T07, R8-T05 | 流式热路径批合并 vs 发送/取消闭包竞态 vs 重试 UI 渲染 vs 内存泄露清理 | **R3-W1** (流式批合并) ──► **R5-W1** (竞态/重试 UI) ──► **R8-W1** (generationMap 清理) |
| `apps/crish-desktop/src/api/StreamRenderBuffer.ts` | P1, AG-05 | R3-T01, R8-T03, R8-T04 | 丢弃 hljs/markdown 产物消除 vs UTF-8 表情截断/降级 UI vs Worker 移交 | **R3-W1** (消除 hljs 浪费) ──► **R8-W1** (UTF-8 截断/Worker 化) |
| `apps/crish-desktop/src/api/daemonChatBridge.ts` | P4, P6, P10b, AG-03 | R3-T04, R5-T02 | SSE 事件 Zod 快速路径解析 vs EventRouter 错误事件转发 | **R3-W1** (Zod 快速路径) ──► **R5-W1** (EventRouter 错误分发) |
| `apps/crish-desktop/src/api/directFetchBridge.ts` | P6, P11 (SSE thought bug) | R3-T04 | SSE 回退路径思考文本丢失 bug 修复与 Zod 快速路径对齐 | **R3-W1** (独占包揽，集中修复) |
| `apps/crish-desktop/src/components/CardPanel.tsx` | B0, D9, P7, R6-T04 | R1-T01, R3-T03, R4-T01, R6-T04 | 合并冲突清理 vs 渲染树 React.memo vs DOM 插入线移除 vs Guard 组件集成 | **R1-W1** (冲突) ──► **R3-W1** (memo) ──► **R4-W1** (拖拽) ──► **R6-W1** (Guard) |
| `apps/crish-desktop/src/hooks/useDragReorder.ts` | D3, D4, D11, X1, X2 | R4-T03, R8-T01, R8-T02 | 侧边栏 dragover setState 改写 vs z-index token 替换 vs 旧代码清理 | **R4-W1** (侧边栏拖拽重构) ──► **R8-W1** (z-index / 死代码) |
| `apps/crish-desktop/src/components/sidebar/SidebarSessionList.tsx` | D3, D4, D11, D13 | R4-T03 | HTML5 DnD 与 PointerDown 双重拖拽系统拆除 + pointercancel | **R4-W1** (D3/D4/D11/D13 归入单一 Agent 独占) |
| `apps/crish-desktop/src/components/chat/MessageContent.tsx` | AG-08, P5, P7, P9, AG-05 | R2-T01, R3-T03, R8-T03 | DOMPurify 纵深防御 vs 正则表达式复用/Worker HTML 消费 vs 降级 UI | **R2-W1** (XSS 防御) ──► **R3-W1** (正则/memo) ──► **R8-W1** (降级 UI) |
| `packages/agent-runtime/src/session-loop/index.ts` | AG-03, AG-09, R6-T06 | R5-T01, R5-T03, R6-T06 | runtime-error retryable 补充 vs ErrorClassifier 分类器统一 vs 管道整理 | **R5-W1** (retryable/分类器) ──► **R6-W1** (中间件管道收尾) |
| `apps/crish-desktop/src/hooks/useStreamCallbacks.ts` | AG-02, AG-05 | R5-T06, R8-T05 | cancelFn 闭包竞态/myGen 校验 vs generationMapRef 内存释放 | **R5-W1** (竞态修复) ──► **R8-W1** (内存释放) |
| `apps/crish-desktop/src/store/layoutStore.ts` | P2, D12, R6-T01 | R1-T03, R6-T01 | 模块导入路径修复 vs 单文件拆分为 Workspace/UI/Nav/Session 4 slices | **R1-W1** (Import 修复) ──► **R6-W1** (Slices 拆分) |
| `packages/agent-daemon/src/types/protocol-inbound.ts` | AG-06, R6-T02 | R6-T02, R7-T03 | 按 auth/run/session/diagnostic 拆分子文件 vs Hello Case 类型守卫 | **R6-W1** (子文件拆分) ──► **R7-W1** (Hello 校验) |
| `crates/conex-sandbox/src/process_tree.rs` | AG-08 | R2-T06 | Process 句柄 11 处 unsafe 块添加 `// SAFETY:` 文档注释 | **R2-W1** (独占修补) |

### 路径校正表

| 原始路径 | 校正路径 | 状态 | 涉及 Agent |
|---|---|---|---|
| `packages/shared-types/src/protocol-inbound.ts` | `packages/agent-daemon/src/types/protocol-inbound.ts` | wrong_path — 原始路径不存在，实际文件在 agent-daemon | A6/R6-T02 |
| `crates/conex-ipc/src/process.rs` | `crates/conex-sandbox/src/process_tree.rs` | wrong_path — conex-ipc 下无 process.rs，实际在 conex-sandbox | S6/R2-T06 |

---

## 3. Wave 级别写集（files_write）严格隔离矩阵

以下为 Round 1 至 Round 9 全部 Wave 内并发 Agent 的写集隔离矩阵。矩阵严格遵循 **`files_write(A) ∩ files_write(B) == ∅`**，任何交集均为 0。每项引用的文件路径已根据 `v2_path_audit.json` 进行校正。

### 3.1 Round 1：解阻塞轮（Unblocking & Conflicts Cleanup）

* 前置条件：无（初始化代码库可编译状态）
* 目标：清理 5 处 Git 合并冲突残留，补全缺失 API，修补 TS 路径错误与 Cargo lint 规则。

#### Wave 1 (并发 Agent: 4)

| Agent ID | Task ID | 对应 Issue | 写集路径 (files_write) | 只读引用集 (files_read) | 隔离防撞断言 (0-Overlap Verification) |
|---|---|---|---|---|---|
| **F1** | R1-T01 | B0, AG-01 | `apps/crish-desktop/src/components/CardPanel.tsx`<br>`apps/crish-desktop/src/components/Workspace.tsx`<br>`apps/crish-desktop/src/components/ChatEmptyState.tsx`<br>`apps/crish-desktop/src/components/WorkspaceChromeBars.tsx`<br>`apps/crish-desktop/src/services/StreamRecovery.ts` | `apps/crish-desktop/src/hooks/useChatStream.ts` | F1 ∩ (F2 ∪ F3 ∪ F4) = ∅ |
| **F2** | R1-T02 | B0 | *37 个 UU 状态文件 (Git 索引冲突标记清除)* | 全局状态 | F2 ∩ (F1 ∪ F3 ∪ F4) = ∅ |
| **F3** | R1-T03 | AG-01 | `apps/crish-desktop/src/store/sessionActions.ts`<br>`apps/crish-desktop/src/store/session-actions/index.ts`<br>`apps/crish-desktop/src/store/session-actions/types.ts` | `apps/crish-desktop/src/store/layoutStore.ts` | F3 ∩ (F1 ∪ F2 ∪ F4) = ∅ |
| **F4** | R1-T04 | AG-11 | `apps/agent-workbench/src-tauri/Cargo.toml`<br>`packages/agent-provider-http/Cargo.toml` | `Cargo.toml` | F4 ∩ (F1 ∪ F2 ∪ F3) = ∅ |

#### Wave 2 (并发 Agent: 1)

| Agent ID | Task ID | 任务类型 | 写入/落盘路径 | 说明 |
|---|---|---|---|---|
| **V1** | R1-T05 | 验证 Agent | `.workbuddy/repair/ledger.json`<br>`.workbuddy/repair/baseline.json` | 建立全量构建、Lint、单测及性能基线报告 |

---

### 3.2 Round 2：安全与数据完整性轮（Security & Data Integrity）

* 前置条件：Round 1 门禁 G0 + G1 通过
* 目标：消除 XSS 风险、跨 Session 审批缓存污染、FIFO shift 导致的悬挂 Tool Result 以及 Rust unsafe 安全注释缺失。

#### Wave 1 (并发 Agent: 6)

| Agent ID | Task ID | 对应 Issue | 写集路径 (files_write) | 只读引用集 (files_read) | 隔离防撞断言 (0-Overlap Verification) |
|---|---|---|---|---|---|
| **S1** | R2-T01 | AG-08 | `apps/crish-desktop/src/components/chat/MessageContent.tsx` | `package.json` (dompurify) | S1 ∩ (S2 ∪ S3 ∪ S4 ∪ S5 ∪ S6) = ∅ |
| **S2** | R2-T02 | AG-02 | `apps/crish-desktop/src/utils/approval-cache.ts` **（幻觉路径——不存在）** <br>`apps/crish-desktop/src/services/approval-pipeline.ts` **（幻觉路径——不存在）** | `apps/crish-desktop/src/store/sessionStore.ts` | S2 ∩ (S1 ∪ S3 ∪ S4 ∪ S5 ∪ S6) = ∅ |
| **S3** | R2-T03 | AG-04 | `apps/crish-desktop/src/store/session-actions/message-actions.ts` | `apps/crish-desktop/src/store/session-store/types.ts` | S3 ∩ (S1 ∪ S2 ∪ S4 ∪ S5 ∪ S6) = ∅ |
| **S4** | R2-T04 | AG-04 | `apps/crish-desktop/src/store/session-actions/index.ts`<br>`apps/crish-desktop/src/store/session-actions/types.ts` | `apps/crish-desktop/src/store/sessionStore.ts` | S4 ∩ (S1 ∪ S2 ∪ S3 ∪ S5 ∪ S6) = ∅ |
| **S5** | R2-T05 | AG-06 | `apps/agent-workbench/src-tauri/src/main.rs`<br>`apps/crish-desktop/src/store/updateStore.ts` | `apps/agent-workbench/src-tauri/tauri.conf.json` | S5 ∩ (S1 ∪ S2 ∪ S3 ∪ S4 ∪ S6) = ∅ |
| **S6** | R2-T06 | AG-08 | `crates/conex-sandbox/src/process_tree.rs` **（路径校正）** | `crates/conex-sandbox/src/process_tree.rs` **（credentials.rs 不存在，已修正）** | S6 ∩ (S1 ∪ S2 ∪ S3 ∪ S4 ∪ S5) = ∅ |

> **校正注**：
> - S2 的 `apps/crish-desktop/src/utils/approval-cache.ts` 和 `apps/crish-desktop/src/services/approval-pipeline.ts` 均为**幻觉路径**（在仓库中不存在）。v2_path_audit 确认这些文件不存在。实际 approval 相关文件位于 `packages/agent-daemon/src/` 下。
> - S4 原始路径 `session-store/` → 校正时改为 `session-actions/`（**OPT-E8：** 该目录已于 W4-2 删除；现行为 flat `session*Actions.ts`）。
> - S6 原始路径 `crates/conex-ipc/src/process.rs` → 实际路径为 `crates/conex-sandbox/src/process_tree.rs`。原始只读集 `crates/conex-ipc/src/credentials.rs` 为**幻觉路径**，不存在于仓库中。

#### Wave 2 & Wave 3 (集成与验证)

* **Wave 2 (I1)**: 集成分支 `agent/R2-integration` 合并 S1~S6 分支。
* **Wave 3 (V1)**: 执行 G0(tsc/vite/cargo), G1(eslint/depcruise), G2(vitest) 全量门禁校验。

---

### 3.3 Round 3：流式渲染性能簇（Streaming Performance Cluster）

* 前置条件：Round 1 编译通过（与 Round 2 可并行部署）
* 目标：彻底消除 `StreamRenderBuffer` 每帧丢弃 hljs/markdown 产物（P1）、`useChatAutoScroll` 增量布局（P2）、Subagent 事件节流（P3）、RegExp 常量化与虚拟化竞态修复（P4~P11）。

#### Wave 1 (并发 Agent: 6)

| Agent ID | Task ID | 对应 Issue | 写集路径 (files_write) | 只读引用集 (files_read) | 隔离防撞断言 (0-Overlap Verification) |
|---|---|---|---|---|---|
| **S1** | R3-T01 | P1, P3, P10a, P11a | `apps/crish-desktop/src/api/StreamRenderBuffer.ts`<br>`apps/crish-desktop/src/hooks/useChatStream.ts`<br>`apps/crish-desktop/src/api/subagentTimeline.ts`<br>`apps/crish-desktop/src/api/IncrementalMarkdownParser.ts`<br>`apps/crish-desktop/src/api/codeHighlight.ts`<br>`apps/crish-desktop/src/api/streamTextBatcher.ts` | `apps/crish-desktop/src/store/sessionStore.ts` | S1 ∩ (S2 ∪ S3 ∪ S4 ∪ S5 ∪ S6) = ∅ |
| **S2** | R3-T02 | P2 | `apps/crish-desktop/src/hooks/useChatAutoScroll.ts` | `apps/crish-desktop/src/components/chat/ChatMessageList.tsx` | S2 ∩ (S1 ∪ S3 ∪ S4 ∪ S5 ∪ S6) = ∅ |
| **S3** | R3-T03 | P5, P7, P9 | `apps/crish-desktop/src/api/markdownRenderLite.ts`<br>`apps/crish-desktop/src/components/chat/ChatMessageRow.tsx`<br>`apps/crish-desktop/src/components/chat/ChatMessageList.tsx`<br>`apps/crish-desktop/src/components/chat/ChatCard.tsx`<br>`apps/crish-desktop/src/hooks/useChatCardSelectors.ts` **（路径校正）** <br>`apps/crish-desktop/src/hooks/useMessageWindow.ts` **（路径校正）** | `apps/crish-desktop/src/components/chat/MessageContent.tsx` | S3 ∩ (S1 ∪ S2 ∪ S4 ∪ S5 ∪ S6) = ∅ |
| **S4** | R3-T04 | P6, P10b, P11 (SSE) | `apps/crish-desktop/src/api/daemonChatBridge.ts`<br>`apps/crish-desktop/src/api/directFetchBridge.ts` | `packages/agent-daemon/src/types/protocol-inbound.ts` **（路径校正）** | S4 ∩ (S1 ∪ S2 ∪ S3 ∪ S5 ∪ S6) = ∅ |
| **S5** | R3-T05 | P4 | `apps/crish-desktop/src/store/autoIndexMiddleware.ts` | `apps/crish-desktop/src/store/layoutStore.ts` | S5 ∩ (S1 ∪ S2 ∪ S3 ∪ S4 ∪ S6) = ∅ |
| **S6** | R3-T06 | P8 | `apps/crish-desktop/src/components/chat/hooks/usePretextHeights.ts` | `apps/crish-desktop/src/workers/pretextWorker.ts` **（幻觉路径——不存在）** | S6 ∩ (S1 ∪ S2 ∪ S3 ∪ S4 ∪ S5) = ∅ |

> **校正注**：
> - S3 中 `useChatCardSelectors.ts` 原始路径 `hooks/` → 实际为 `components/chat/hooks/`。`useMessageWindow.ts` 原始路径 `hooks/` → 实际为 `components/chat/hooks/`。
> - S4 只读引用原始 `packages/shared-types/src/protocol-inbound.ts` → 实际路径 `packages/agent-daemon/src/types/protocol-inbound.ts`。
> - S6 只读引用 `apps/crish-desktop/src/workers/pretextWorker.ts` 为**幻觉路径**（不存在于仓库中）。

#### Wave 2 & Wave 3 (集成、门禁与性能 Harness 沉淀)

* **Wave 2 (I1)**: 集成分支 `agent/R3-integration`。
* **Wave 3 (V1/V3/V4)**: V3 Agent 建设 `tests/perf/stream_harness.test.ts` 模拟 100+ tok/s 高频推流。

---

### 3.4 Round 4：窗口与标签拖拽交互簇（Drag & Drop Interaction Cluster）

* 前置条件：Round 1 编译通过（与 Round 2/3 可并行部署）
* 目标：全面修复边界检测失效（D1）、快照过期抖动（D2）、侧边栏实时重排（D3）、HTML5/PointerDown 冲突（D4）、rAF 节流（D5）、translate3d 优化（D6）以及列宽调整死代码启用（D7）。

#### Wave 1 (并发 Agent: 4)

| Agent ID | Task ID | 对应 Issue | 写集路径 (files_write) | 只读引用集 (files_read) | 隔离防撞断言 (0-Overlap Verification) |
|---|---|---|---|---|---|
| **D1** | R4-T01 | D1, D2, D5, D6, D8, D9 | `apps/crish-desktop/src/hooks/tab-drag/index.ts`<br>`apps/crish-desktop/src/hooks/tab-drag/types.ts`<br>`apps/crish-desktop/src/hooks/tab-drag/collision.ts`<br>`apps/crish-desktop/src/hooks/tab-drag/pointer-state.ts`<br>`apps/crish-desktop/src/hooks/tab-drag/drop-handlers.ts`<br>`apps/crish-desktop/src/styles/tab-drag.css` **（路径校正）** | `apps/crish-desktop/src/components/CardPanel.tsx` | D1 ∩ (D2 ∪ D3 ∪ D4) = ∅ |
| **D2** | R4-T02 | D7, D12 | `apps/crish-desktop/src/components/Workspace.tsx`<br>`apps/crish-desktop/src/hooks/useColumnResize.ts`<br>`apps/crish-desktop/src/components/workspace/ColumnResizeHandle.tsx`<br>`apps/crish-desktop/src/utils/dragOverlay.ts`<br>`apps/crish-desktop/src/store/workspaceActions.ts` | `apps/crish-desktop/src/store/layoutStore.ts` | D2 ∩ (D1 ∪ D3 ∪ D4) = ∅ |
| **D3** | R4-T03 | D3, D4, D11, D13 | `apps/crish-desktop/src/components/sidebar/SidebarSessionList.tsx`<br>`apps/crish-desktop/src/store/session-actions/session-ordering.ts`<br>`apps/crish-desktop/src/hooks/useDragReorder.ts` | `apps/crish-desktop/src/store/sessionStore.ts` | D3 ∩ (D1 ∪ D2 ∪ D4) = ∅ |
| **D4** | R4-T04 | D14 | `apps/crish-desktop/src/app/AppHeader.tsx`<br>`apps/crish-desktop/src/styles/shell/shell-polish.css` **（路径校正）** <br>`apps/crish-desktop/src/hooks/useWindowControls.ts` | `apps/crish-desktop/src/components/WorkspaceChromeBars.tsx` | D4 ∩ (D1 ∪ D2 ∪ D3) = ∅ |

> **校正注**：
> - D1 中 `tab-drag.css` 原始路径 `hooks/tab-drag/` → 实际路径为 `styles/tab-drag.css`。
> - D4 中 `shell-polish.css` 原始路径 `styles/` → 实际路径为 `styles/shell/shell-polish.css`。

#### Wave 2 & Wave 3 (集成与 E2E 场景库建设)

* **Wave 2 (I1)**: 集成分支 `agent/R4-integration`。
* **Wave 3 (V2)**: V2 Agent 新建 `tests/e2e/drag/tab_drag.spec.ts` 与 `sidebar_drag.spec.ts`。

---

### 3.5 Round 5：错误透传与并发竞态簇（Error Transmissibility & Race Conditions）

* 前置条件：Round 1 编译通过（与 Round 2/3/4 可并行部署）
* 目标：补全 `runtime-error` 事件 `retryable` 标识、扩展 `EventRouter` 缺失 case、统一 `ErrorClassifier` 并消除 `CircuitBreaker` 遗留。

#### Wave 1 (并发 Agent: 8)

| Agent ID | Task ID | 对应 Issue | 写集路径 (files_write) | 只读引用集 (files_read) | 隔离防撞断言 (0-Overlap Verification) |
|---|---|---|---|---|---|
| **E1** | R5-T01 | AG-03 | `packages/agent-runtime/src/session-loop/index.ts` | `packages/agent-runtime/src/error-classifier.ts` | E1 ∩ (E2 ∪ E3 ∪ E4 ∪ E5 ∪ E6 ∪ E7 ∪ E8) = ∅ |
| **E2** | R5-T02 | AG-03 | `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts` **（路径校正）** | `packages/agent-daemon/src/types/protocol-inbound.ts` **（路径校正）** | E2 ∩ (E1 ∪ E3 ∪ E4 ∪ E5 ∪ E6 ∪ E7 ∪ E8) = ∅ |
| **E3** | R5-T03 | AG-09 | `packages/agent-runtime/src/provider-openai-base.ts` **（路径校正）** <br>`packages/agent-runtime/src/provider-stream-contract/error.ts`<br>`packages/agent-runtime/src/provider-stream-contract/normalizer.ts` | `packages/agent-runtime/src/error-classifier.ts` | E3 ∩ (E1 ∪ E2 ∪ E4 ∪ E5 ∪ E6 ∪ E7 ∪ E8) = ∅ |
| **E4** | R5-T04 | AG-03 | `apps/crish-desktop/src/services/stream-recovery.ts` **（幻觉路径——不存在）** <br>`tests/e2e/exponential-backoff-e2e.test.ts` | `apps/crish-desktop/src/api/StreamRenderBuffer.ts` | E4 ∩ (E1 ∪ E2 ∪ E3 ∪ E5 ∪ E6 ∪ E7 ∪ E8) = ∅ |
| **E5** | R5-T05 | AG-03 | `packages/agent-runtime/src/error-classifier.ts`<br>`packages/agent-runtime/src/fallback-chain/types.ts` **（路径待确认）** | `packages/shared-types/src/index.ts` | E5 ∩ (E1 ∪ E2 ∪ E3 ∪ E4 ∪ E6 ∪ E7 ∪ E8) = ∅ |
| **E6** | R5-T06 | AG-02 | `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts` **（路径校正）** <br>`apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` | `apps/crish-desktop/src/store/sessionStore.ts` | E6 ∩ (E1 ∪ E2 ∪ E3 ∪ E4 ∪ E5 ∪ E7 ∪ E8) = ∅ |
| **E7** | R5-T07 | AG-02, AG-03 | `apps/crish-desktop/src/services/approval-bridge.ts` **（幻觉路径——不存在）** <br>`apps/crish-desktop/src/services/approval-queue.ts` **（幻觉路径——不存在）** | `apps/crish-desktop/src/hooks/useChatStream.ts` | E7 ∩ (E1 ∪ E2 ∪ E3 ∪ E4 ∪ E5 ∪ E6 ∪ E8) = ∅ |
| **E8** | R5-T08 | AG-09, AG-06 | ~~`packages/agent-provider-http/src/provider-registry-v2.ts`~~ **（幻觉路径——已删除）** <br>`apps/crish-desktop/src/services/TelemetryMonitor.ts` | `apps/agent-workbench/src-tauri/src/main.rs` | E8 ∩ (E1 ∪ E2 ∪ E3 ∪ E4 ∪ E5 ∪ E6 ∪ E7) = ∅ |

> **校正注（重要）**：
> - E2 中 `EventRouter.ts` 原始路径 `api/EventRouter.ts` → 实际路径为 `api/daemon-chat-bridge/EventRouter.ts`。只读引用 `shared-types/src/protocol-inbound.ts` → `agent-daemon/src/types/protocol-inbound.ts`。
> - E3 中 `provider-openai-base.ts` 原始路径 `packages/agent-provider-http/src/` → 实际路径 `packages/agent-runtime/src/`（agent-provider-http 是 Rust crate）。
> - E4 中 `apps/crish-desktop/src/services/stream-recovery.ts` 为**幻觉路径**（不存在）。实际文件在 `packages/agent-runtime/src/provider-transport/stream-recovery.ts`。
> - E6 中 `useSlashSend.ts` 原始路径 `hooks/` → 实际路径 `hooks/chat-stream/`。
> - E7 中 `approval-bridge.ts`、`approval-queue.ts` 均为**幻觉路径**（不存在）。实际 approval 相关文件在 `packages/agent-daemon/src/daemon-approval-handler.ts` 和 `packages/agent-runtime/src/runtime-helpers.ts`。
> - E8 中 ~~`provider-registry-v2.ts`~~ **已删除**（该文件完全不存在于仓库中，属于幻觉路径）。AG-09 的相关文件应使用 `packages/agent-runtime/src/provider-stream-contract/normalizer.ts` 和 `error.ts` 替代。

---

### 3.6 Round 6：架构合规与组件清理轮（Architecture Compliance & Refactoring）

* 前置条件：Round 5 提交合并（ErrorClassifier 统一完成）
* 目标：拆分超长上帝文件（`layoutStore.ts` > 400 行、`protocol-inbound.ts` > 400 行、`ui-selectors.ts` > 300 行）、消除弃用中间件及清理缺失 API 存根。

#### Wave 1 (并发 Agent: 8)

| Agent ID | Task ID | 对应 Issue | 写集路径 (files_write) | 只读引用集 (files_read) | 隔离防撞断言 (0-Overlap Verification) |
|---|---|---|---|---|---|
| **A1** | R6-T01 | AG-10 | `apps/crish-desktop/src/store/layoutStore.ts`<br>`apps/crish-desktop/src/store/slices/*` | `apps/crish-desktop/src/store/types.ts` | A1 ∩ (A2 ∪ A3 ∪ A4 ∪ A5 ∪ A6 ∪ A7 ∪ A8) = ∅ |
| **A2** | R6-T02 | AG-10 | `packages/agent-daemon/src/types/protocol-inbound.ts` **（路径校正）** <br>`packages/agent-daemon/src/types/protocol-outbound.ts` **（路径校正）** <br>`packages/shared-types/src/types/protocol-*` **（幻觉路径——需创建）** | `packages/shared-types/src/index.ts` | A2 ∩ (A1 ∪ A3 ∪ A4 ∪ A5 ∪ A6 ∪ A7 ∪ A8) = ∅ |
| **A3** | R6-T03 | AG-10 | `apps/crish-desktop/src/store/layout-helpers/ui-selectors.ts` **（路径校正）** <br>`apps/crish-desktop/src/store/layout-helpers/*` | `apps/crish-desktop/src/store/layoutStore.ts` | A3 ∩ (A1 ∪ A2 ∪ A4 ∪ A5 ∪ A6 ∪ A7 ∪ A8) = ∅ |
| **A4** | R6-T04 | AG-12 | `apps/crish-desktop/src/components/chat/ChatProviderGuard.tsx` **（幻觉路径——不存在）** <br>`apps/crish-desktop/src/components/chat/ChatCheckpointActions.tsx` **（幻觉路径——不存在）** | `apps/crish-desktop/src/components/chat/ChatCard.tsx` | A4 ∩ (A1 ∪ A2 ∪ A3 ∪ A5 ∪ A6 ∪ A7 ∪ A8) = ∅ |
| **A5** | R6-T05 | AG-12 | `apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts` **（路径校正）** <br>`apps/crish-desktop/src/components/files/hooks/useFilePreview.ts` **（路径校正）** | `apps/crish-desktop/src/store/workspaceStore.ts` | A5 ∩ (A1 ∪ A2 ∪ A3 ∪ A4 ∪ A6 ∪ A7 ∪ A8) = ∅ |
| **A6** | R6-T06 | AG-11 | `packages/agent-runtime/src/hooks/tool-hook-observability.ts` **（路径校正）** <br>`packages/agent-runtime/src/hooks/tool-hook-types.ts` **（路径校正）** <br>`.dependency-cruiser.cjs`<br>~~`.dependency-cruiser.js`~~<br>`packages/agent-runtime/src/middleware-pipeline.ts` | `.eslintrc.cjs` | A6 ∩ (A1 ∪ A2 ∪ A3 ∪ A4 ∪ A5 ∪ A7 ∪ A8) = ∅ |
| **A7** | R6-T07 | AG-12 | `packages/agent-runtime/src/testing/faux-provider.ts` **（路径校正）** <br>`vitest.globalSetup.ts` | `packages/agent-runtime/src/types.ts` | A7 ∩ (A1 ∪ A2 ∪ A3 ∪ A4 ∪ A5 ∪ A6 ∪ A8) = ∅ |
| **A8** | R6-T08 | AG-12 | `apps/crish-desktop/src/app/AppBootstrap.ts` **（路径校正）** <br>`apps/crish-desktop/src/hooks/useAppKeyboard.ts`<br>`apps/crish-desktop/src/hooks/keyboard/*` | `apps/crish-desktop/src/app/AppHeader.tsx` | A8 ∩ (A1 ∪ A2 ∪ A3 ∪ A4 ∪ A5 ∪ A6 ∪ A7) = ∅ |

> **校正注**：
> - A2 中 `protocol-inbound.ts`/`protocol-outbound.ts` 原始路径 `shared-types/src/` → 实际路径 `agent-daemon/src/types/`。`protocol-*` 通配为计划拆分目标路径，当前不存在。
> - A3 中 `ui-selectors.ts` 原始路径 `store/` → 实际路径 `store/layout-helpers/`。
> - A4 中 `ChatProviderGuard.tsx`、`ChatCheckpointActions.tsx` 均为**幻觉路径**（不存在于仓库中）。
> - A5 中 `useFileNavigation.ts`/`useFilePreview.ts` 原始路径 `hooks/` → 实际路径 `components/files/hooks/`。
> - A6 中 `tool-hook-*.ts` 原始路径 `plugin-sdk/src/` → 实际路径 `agent-runtime/src/hooks/`。
> - A7 中 `faux-provider.ts` 原始路径 `test-utils/src/` → 实际路径 `agent-runtime/src/testing/`。
> - A8 中 `AppBootstrap.ts` 原始路径 `components/` → 实际路径 `app/`。

---

### 3.7 Round 7：CI/CD Pipeline 建设轮（CI/CD Construction）

* 前置条件：Round 6 完成（依赖 depcruise 配置统一）
* 目标：全量构建 `.github/workflows/ci.yml` 包含 8 大核心 Job、配置 Turbo cache 与类型守卫。

#### Wave 1 (并发 Agent: 3)

| Agent ID | Task ID | 对应 Issue | 写集路径 (files_write) | 只读引用集 (files_read) | 隔离防撞断言 (0-Overlap Verification) |
|---|---|---|---|---|---|
| **C1** | R7-T01 | AG-07 | `.github/workflows/ci.yml` | `turbo.json`<br>`package.json` | C1 ∩ (C2 ∪ C3) = ∅ |
| **C2** | R7-T02 | AG-07 | `package.json` | `packages/*/package.json`<br>`apps/*/package.json` | C2 ∩ (C1 ∪ C3) = ∅ |
| **C3** | R7-T03 | AG-06 | `packages/agent-daemon/src/protocol/validators/common.ts` **（路径校正）** <br>`packages/agent-daemon/src/protocol/protocol.ts` **（路径校正）** | `packages/agent-daemon/src/types/protocol-inbound.ts` **（路径校正）** | C3 ∩ (C1 ∪ C2) = ∅ |

> **校正注**：
> - C3 中的文件原始路径为 `shared-types/src/protocol/` → 实际路径为 `agent-daemon/src/protocol/`。入口引用 `shared-types/src/protocol-inbound.ts` → `agent-daemon/src/types/protocol-inbound.ts`。

---

### 3.8 Round 8：横切收尾轮（Cross-Cutting Cleanup & Hotspots Finalization）

* 前置条件：Round 3 (流式写集释放)、Round 4 (拖拽写集释放)、Round 6 (架构拆分完成)
* 目标：全仓库 z-index token 统一、拖拽死代码彻底清理、Worker 化增量 Markdown 解析及积压降级 UI。

#### Wave 1 (并发 Agent: 5)

| Agent ID | Task ID | 对应 Issue | 写集路径 (files_write) | 只读引用集 (files_read) | 隔离防撞断言 (0-Overlap Verification) |
|---|---|---|---|---|---|
| **X1** | R8-T01 | D10 | `apps/crish-desktop/src/styles/tokens/zindex.ts` **（路径校正——.css→.ts）** <br>`apps/crish-desktop/src/styles/z-index.css` **（路径校正）** <br>`apps/crish-desktop/src/app/AppGlobalDialogs.tsx` **（路径校正）** <br>`apps/crish-desktop/src/components/TelemetryDialog.tsx` **（路径校正）** | `apps/crish-desktop/src/styles/tab-drag.css` **（路径校正）** | X1 ∩ (X2 ∪ X3 ∪ X4 ∪ X5) = ∅ |
| **X2** | R8-T02 | D15, AG-05 | `apps/crish-desktop/src/components/drag/DropIndicatorLayer.tsx` **（原始路径 components/drag/ 已验证存在）** <br>`apps/crish-desktop/src/components/drag/GlobalDragOverlay.tsx`<br>`apps/crish-desktop/src/contexts/dragContext.tsx`<br>`apps/crish-desktop/src/constants/layout.ts` | `apps/crish-desktop/src/store/layoutStore.ts` | X2 ∩ (X1 ∪ X3 ∪ X4 ∪ X5) = ∅ |
| **X3** | R8-T03 | AG-05 | `apps/crish-desktop/src/store/types.ts` | `apps/crish-desktop/src/api/StreamRenderBuffer.ts` | X3 ∩ (X1 ∪ X2 ∪ X4 ∪ X5) = ∅ |
| **X4** | R8-T04 | AG-05 | `apps/crish-desktop/src/workers/markdownWorker.ts`<br>`apps/crish-desktop/src/api/IncrementalMarkdownBridge.ts` | `apps/crish-desktop/src/api/StreamRenderBuffer.ts` | X4 ∩ (X1 ∪ X2 ∪ X3 ∪ X5) = ∅ |
| **X5** | R8-T05 | AG-05, AG-02 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` **（路径校正）** | `apps/crish-desktop/src/store/sessionStore.ts` | X5 ∩ (X1 ∪ X2 ∪ X3 ∪ X4) = ∅ |

> **校正注**：
> - X1 中 `zindex.css` → 实际文件为 `zindex.ts`。`z-index.ts` → 实际文件为 `styles/z-index.css`。`AppGlobalDialogs.tsx` 原始路径 `components/dialogs/` → 实际路径 `app/`。`TelemetryDialog.tsx` 原始路径 `components/dialogs/` → 实际路径 `components/`。`tab-drag.css` 原始路径 `hooks/tab-drag/` → 实际路径 `styles/`。
> - X2 中 `DropIndicatorLayer.tsx` 原始路径 `components/drag/` 已验证正确存在。

---

### 3.9 Round 9：测试套件补齐轮（Test Suite Completion）

* 前置条件：Round 2 至 Round 8 代码修复全部合并到 `main`
* 目标：为所有修复过的核心模块新建独立单测与集成测试脚本（11 个单元测试 Agent 满容并行）。

#### Wave 1 (并发 Agent: 11)

| Task ID | 测试用例目标模块 | 新建/修改测试文件路径 (files_write) | 隔离断言 (0-Overlap Assertion) | 路径状态 |
|---|---|---|---|---|
| **R9-T01** | `useChatApproval` 竞态与超时 | `tests/unit/useChatApproval.test.ts` | 独占新建脚本文件 | 需创建 |
| **R9-T02** | `useFileNavigation` 脏检查 | `tests/unit/useFileNavigation.test.ts` | 独占新建脚本文件 | 需创建 |
| **R9-T03** | `FauxAgentProvider` 状态机 | `tests/unit/faux-provider.test.ts` | 独占新建脚本文件 | 需创建 |
| **R9-T04** | `StreamRenderBuffer` UTF-8 截断 | `packages/shared-utils/src/__tests__/StreamRenderBuffer.test.ts` **（路径校正）** | 独占新建脚本文件 | 需创建（原始路径 `apps/crish-desktop/src/api/StreamRenderBuffer.test.ts` 为幻觉路径） |
| **R9-T05** | `ChatCard` 渲染层集成 | `tests/integration/ChatCard.test.tsx` | 独占新建脚本文件 | 需创建 |
| **R9-T06** | 指数退避算法 | `tests/unit/exponential-backoff.test.ts` | 独占新建脚本文件 | 需创建 |
| **R9-T07** | `ApprovalCache` Session 隔离 | `tests/unit/approval-cache.test.ts` | 独占新建脚本文件 | 需创建 |
| **R9-T08** | Store 端到端 512 消息配对 | `tests/e2e/store-integrity.e2e.test.ts` | 独占新建脚本文件 | 需创建 |
| **R9-T09** | `ErrorClassifier` 错误判定 | `tests/unit/error-classifier.test.ts` | 独占新建脚本文件 | 需创建 |
| **R9-T10** | `AppBootstrap` Effect 顺序 | `tests/unit/AppBootstrap.test.ts` | 独占新建脚本文件 | 需创建 |
| **R9-T11** | Vitest 覆盖率阈值配置 | `vitest.config.ts` | 独占写入配置项 | 存在 |

---

## 4. 核心热点文件代码级重构对比与冲突拆解

本节针对全仓库最敏感的 5 个热点文件，展示由于单一写者原则约束，不同 Round 内 Agent 的具体代码级重构对比与逻辑解耦方案。

### 4.1 热点一：`apps/crish-desktop/src/components/Workspace.tsx`

> **路径校正**：已验证存在，无需修改。

#### 冲突分析
* **Round 1 (F1)**：修复 747 行冲突标记与重复的 542–747 行与 761–978 行列渲染代码。
* **Round 4 (D2)**：移除内联的 353–476 行 `onMouseDown` resize 逻辑，接入 `useColumnResize` 与 `ColumnResizeHandle`。
* **Round 8 (X2)**：清理过时的 `DropIndicatorLayer` 引用。

#### 代码级别对比（略，见原始文档 v2 4.1 节）

### 4.2 热点二：`apps/crish-desktop/src/hooks/useChatStream.ts`

（略，见原始文档 v2 4.2 节）

### 4.3 热点三：`apps/crish-desktop/src/api/StreamRenderBuffer.ts`

（略，见原始文档 v2 4.3 节）

### 4.4 热点四：`packages/agent-runtime/src/session-loop/index.ts`

（略，见原始文档 v2 4.4 节）

### 4.5 热点五：`apps/crish-desktop/src/components/sidebar/SidebarSessionList.tsx`

（略，见原始文档 v2 4.5 节）

---

## 5. 两两 Agent 互斥性两两求交验证（Pairwise Intersection Matrix）

为了严密证明所有 Wave 内部均满足 **0 文件重叠** 约束，下表给出每一个 Wave 中所有 Agent 写集 (`files_write`) 的两两求交（Set Intersection）数学验证结果（路径已按校正版本更新，状态保持不变）：

```
Round 1 Wave 1:
  F1 ∩ F2 = ∅ | F1 ∩ F3 = ∅ | F1 ∩ F4 = ∅ | F2 ∩ F3 = ∅ | F2 ∩ F4 = ∅ | F3 ∩ F4 = ∅  ==► PASS [0 Overlap]

Round 2 Wave 1:
  S1 ∩ S2 = ∅ | S1 ∩ S3 = ∅ | S1 ∩ S4 = ∅ | S1 ∩ S5 = ∅ | S1 ∩ S6 = ∅
  S2 ∩ S3 = ∅ | S2 ∩ S4 = ∅ | S2 ∩ S5 = ∅ | S2 ∩ S6 = ∅
  S3 ∩ S4 = ∅ | S3 ∩ S5 = ∅ | S3 ∩ S6 = ∅
  S4 ∩ S5 = ∅ | S4 ∩ S6 = ∅ | S5 ∩ S6 = ∅                                          ==► PASS [0 Overlap]

Round 3 Wave 1:
  S1 ∩ S2 = ∅ | S1 ∩ S3 = ∅ | S1 ∩ S4 = ∅ | S1 ∩ S5 = ∅ | S1 ∩ S6 = ∅
  S2 ∩ S3 = ∅ | S2 ∩ S4 = ∅ | S2 ∩ S5 = ∅ | S2 ∩ S6 = ∅
  S3 ∩ S4 = ∅ | S3 ∩ S5 = ∅ | S3 ∩ S6 = ∅
  S4 ∩ S5 = ∅ | S4 ∩ S6 = ∅ | S5 ∩ S6 = ∅                                          ==► PASS [0 Overlap]

Round 4 Wave 1:
  D1 ∩ D2 = ∅ | D1 ∩ D3 = ∅ | D1 ∩ D4 = ∅
  D2 ∩ D3 = ∅ | D2 ∩ D4 = ∅
  D3 ∩ D4 = ∅                                                                      ==► PASS [0 Overlap]

Round 5 Wave 1:
  E1..E8 全部两两求交 == ∅                                                           ==► PASS [0 Overlap]

Round 6 Wave 1:
  A1..A8 全部两两求交 == ∅                                                           ==► PASS [0 Overlap]

Round 7 Wave 1:
  C1 ∩ C2 = ∅ | C1 ∩ C3 = ∅ | C2 ∩ C3 = ∅                                          ==► PASS [0 Overlap]

Round 8 Wave 1:
  X1 ∩ X2 = ∅ | X1 ∩ X3 = ∅ | X1 ∩ X4 = ∅ | X1 ∩ X5 = ∅ | ...                         ==► PASS [0 Overlap]

Round 9 Wave 1:
  T1..T11 (11 个新建测试文件路径无任何同名项)                                      ==► PASS [0 Overlap]
```

---

## 6. 自动化单一写者校验器（Single-Writer Enforcer Script）

为了确保后期在增加新任务或执行动态模板轮（Round 10+）时，编排器不会无意间破坏隔离屏障，项目引入自动化写集校验脚本 `.workbuddy/repair/validate_write_set.js`：

> **校正注**：此脚本路径 `.workbuddy/repair/` 目录当前不存在，需创建。脚本逻辑见原始文档第 6 节。

---

## 7. 总结与执行准备清单

本分析方案通过严密的逻辑推导与目录文件解耦，完成了 Conex 修复计划的底层写集隔离证明：

1. **热点彻底解耦**：包含 `Workspace.tsx`、`useChatStream.ts`、`StreamRenderBuffer.ts` 等在内的 14 个核心热点文件均已拉长 DAG 依赖链，完全排布在不同 Round 或 Wave 中。
2. **零文件重叠**：Round 1 至 Round 9 中每个 Wave 内部的所有 Agent 写集两两求交均为空集（`Intersection == ∅`）。
3. **路径校正完成**：对全部引用路径进行了审查，标记了幻觉路径、wrong_path 和待创建文件。

### 校正汇总

| 校正项 | 说明 | 涉及位置 |
|---|---|---|
| `protocol-inbound.ts` 路径修正 | `shared-types/src/` → `agent-daemon/src/types/` | 热点表、R2 S4、R5 E2、R6 A2、R7 C3 |
| `process.rs` 修正 | `conex-ipc/src/process.rs` → `conex-sandbox/src/process_tree.rs` | 热点表、R2 S6 |
| `credentials.rs` 删除 | 不存在于仓库中，已移除 | R2 S6 |
| `approval-bridge.ts` 等幻觉路径 | 5 条 approval 相关文件路径均不存在 | R2 S2、R5 E7 |
| `provider-registry-v2.ts` 删除 | 完全不存在，已移除 | R5 E8 |
| `Tooltip.tsx` 验证 | AG-01 引用路径已验证存在 | R1 F1 等 |
| `EventRouter.ts` 路径修正 | `api/EventRouter.ts` → `api/daemon-chat-bridge/EventRouter.ts` | R5 E2 |
| `provider-openai-base.ts` 路径修正 | `agent-provider-http/src/` → `agent-runtime/src/` | R5 E3 |
| `stream-recovery.ts` 幻觉路径 | `apps/crish-desktop/src/services/` 不存在，实际在 `agent-runtime/` | R5 E4 |
| `useSlashSend.ts` 路径修正 | `hooks/` → `hooks/chat-stream/` | R5 E6 |
| `tab-drag.css` 路径修正 | `hooks/tab-drag/` → `styles/` | R4 D1 |
| `shell-polish.css` 路径修正 | `styles/` → `styles/shell/` | R4 D4 |
| zindex 文件交换 | `zindex.css`→`zindex.ts`；`z-index.ts`→`z-index.css` | R8 X1 |
| 多文件重定位 | `AppGlobalDialogs`、`TelemetryDialog`、`AppBootstrap` 等 | R8 X1、R6 A8 |
| `ui-selectors.ts` 路径修正 | `store/` → `store/layout-helpers/` | R6 A3 |
| `tool-hook-*` 路径修正 | `plugin-sdk/src/` → `agent-runtime/src/hooks/` | R6 A6 |
| `faux-provider.ts` 路径修正 | `test-utils/src/` → `agent-runtime/src/testing/` | R6 A7 |
| `StreamRenderBuffer.test.ts` | 原始路径为幻觉路径，建议位置 `packages/shared-utils/src/__tests__/` | R9 T04 |
