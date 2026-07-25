# Layer D/E 实际落地偏差分析

> 审查范围：04_daemon_orchestrator.md（Layer D）& 05_state_api_layer.md（Layer E）
> 审查日期：2026-07-24

---

## D-1：daemon types.ts 拆分

### 子模块文件行数

| 文件 | 实际行数 | 规划要求 (≤400) | 判定 |
|------|---------|-----------------|------|
| `types/config.ts` | 75 | ≤ 400 | ✅ |
| `types/provider-types.ts` | 52 | ≤ 400 | ✅ |
| `types/entities.ts` | 299 | ≤ 400 | ✅ |
| `types/snapshot-types.ts` | 303 | ≤ 400 | ✅ |
| `types/protocol-inbound.ts` | **537** | ≤ 400 | ❌ 超标 137 行 |
| `types/protocol-outbound.ts` | **601** | ≤ 400 | ❌ 超标 201 行 |

### barrel 导出覆盖度

- `types/index.ts` 导出全部 6 个子模块 ✅
- 原始 `types.ts` 已改为 barrel：`export * from "./types/index.js"` ✅
- 文件结构：6/6 子模块按计划创建 ✅

**缺失功能清单：**
- protocol-inbound.ts（537 行）和 protocol-outbound.ts（601 行）仍偏大，可进一步拆分（如将 `DaemonCorrelationFields` 提取到公共类型文件）
- 无独立的 `types/common.ts` 处理交叉类型引用

---

## D-2：DaemonServer 拆分

### server/ 目录文件清单与行数

| 文件 | 实际行数 | 规划要求 |
|------|---------|---------|
| `server/index.ts` | **464** | ≤ 500 ✅ |
| `server/store-registry.ts` | — | ≤ 400 |
| `server/connection-manager.ts` | — | ≤ 400 |
| `server/message-router.ts` | 140 | ≤ 400 ✅ |
| `server/workflow-manager.ts` | — | ≤ 400 |
| `server/approval-bridge.ts` | **93** | 新建 ✅ |
| `server/http-servers.ts` | — | 新增（规划外） |

### approval-bridge 功能完整性

| 功能项 | 状态 | 说明 |
|-------|------|------|
| `PendingApproval` 映射表 (`Map<runId, PendingApproval>`) | ✅ | `pendingApprovals` Map |
| 120s 超时自动 deny | ✅ | `DEFAULT_APPROVAL_TIMEOUT_MS = 120_000` |
| 超时 → `{ approved: false, reason: "Timed out" }` | ✅ | `resolve` 自动调用 |
| WS 断开 → 全部挂起审批 deny | ✅ | `rejectAllForDisconnect()` 在 Shutdown 时调用 |
| 按 `runId` 批量拒绝 | ✅ | `rejectAll(runId, reason)` |

**缺失功能清单：**
- 无

---

## D-8：消息路由注册式

### 注册机制

- `DaemonMessageRouter` 使用 `handlers = new Map<string, MessageHandler>()` ✅
- `register(type, handler)` 方法实现注册 ✅
- `route(msg, ws, client)` 通过 Map 查找并分发 ✅

### Handler 注册数量

| 类型 | 数量 |
|------|------|
| 显式注册（run-task, approve-tool, deny-tool, cancel-run, stream-pause, stream-resume, ping, get-status, list-capabilities, update-config） | 10 |
| fallbackTypes 阵列（list-sessions, list-runs, ... 共 41 条） | 41 |
| **总计** | **51** |

- 要求：≥ 50 消息类型 ✅（刚好达标）
- 采用注册式 handler map（非巨型 switch）✅

**缺失功能清单：**
- 无

---

## E-3：sessionActions 拆分

### session-actions/ 文件清单与行数

| 文件 | 实际行数 | 规划要求 (≤300) | 判定 |
|------|---------|-----------------|------|
| `session-actions/index.ts` | 21 | — | barrel |
| `session-actions/types.ts` | 56 | — | 类型 |
| `session-actions/_shared.ts` | 148 | — | 共享 |
| `session-actions/session-crud.ts` | 221 | ≤ 300 | ✅ |
| `session-actions/message-actions.ts` | 143 | ≤ 300 | ✅ |
| `session-actions/tool-actions.ts` | 124 | ≤ 300 | ✅ |
| `session-actions/agent-actions.ts` | 91 | ≤ 300 | ✅ |
| `session-actions/session-ordering.ts` | 116 | ≤ 300 | ✅ |
| `session-actions/session-patch.ts` | 28 | ≤ 300 | ✅ |

### createSessionActions 注入模式

- ✅ 接收 `set` / `get` 参数，传递给每个子工厂
- ✅ 返回 `{ ...createXxxActions(set, get), ... }` 聚合

### ⚠️ 严重问题：存在两套并行实现

| 对照项 | sessionActions.ts（旧路径） | session-actions/index.ts（新路径） |
|--------|---------------------------|----------------------------------|
| 被谁引用 | layoutStore.ts, sessionStore.ts ✅ 实际被消费 | ❌ 无消费者 |
| 内容 | 103 行代码，import 自 `./actions/chat` 等 | 21 行 barrel，import 自 `./session-crud` 等 |
| `actions/` 目录 | ❌ 目标路径 `./actions/` **不存在**，文件编译失败 | — |
| 子文件分组 | `actions/chat`, `actions/session`, `actions/agent`, `actions/composer`（4 组） | session-crud, message-actions, tool-actions, agent-actions, session-ordering, session-patch（6 组） |

**结论：** `sessionActions.ts` 文件虽已减至 103 行，但并非按规划拆分为 barrel，而是保留了自己的独立实现且引用了不存在的 `./actions/` 子模块，导致编译不可通过。`session-actions/` 目录按规划正确创建了 6 个领域子工厂，但有 2 个子文件命名与计划不同（`message-actions.ts` 对应计划的 `tool-actions.ts`，`tool-actions.ts` 对应计划的额外领域），且无任何消费者引用它。

**缺失功能清单：**
- `sessionActions.ts` 未转为 barrel，实际是破损状态
- `session-actions/index.ts` 未被任何消费者引用，形成死代码
- `session-actions/tool-actions.ts` 和 `message-actions.ts` 的职责边界与规划文档不完全一致

---

## E-5：layoutStore slice 拆分

### slices/ 目录文件清单与行数

| 文件 | 实际行数 | 内容 |
|------|---------|------|
| `slices/ui-slice.ts` | 132 | `UISlice` 接口 + `createInitialUiState()` + `createUiActions()` |
| `slices/terminal-slice.ts` | 44 | `TerminalSlice` 接口 + `createInitialTerminalState()` + `createTerminalActions()` |
| `slices/permission-slice.ts` | 63 | `PermissionSlice` 接口 + `createInitialPermissionState()` + `createPermissionActions()` |
| `slices/diff-slice.ts` | 45 | `DiffSlice` 接口 + `createInitialDiffState()` + `createDiffActions()` |

### layoutStore.ts 行数

| 测量 | 实际行数 | 规划要求 | 判定 |
|------|---------|---------|------|
| layoutStore.ts | **514** | ≤ 400 | ❌ 超标 114 行 |

### ⚠️ Slices 已定义但未接入 Store

- `layoutStore.ts` 中不包含任何 `from './slices/xxx'` 的导入
- `permissionMode`, `commandPermissions`, `uiSize`, `shellChromeMode` 等状态/action 全部在 `layoutStore.ts` 中内联定义
- `slices/*.ts` 中定义的 `createXxxActions()` 工厂函数未被 `layoutStore.ts` 调用
- 唯一引用 slice 的文件是 `storeTelemetryActions.ts`（仅 import 了 `UiSize` 类型）

**缺失功能清单：**
- layoutStore 未使用 slice 工厂函数，违反规划要求
- layoutStore.ts 超标 114 行

---

## E-6/SH-1：useChatCardSelectors useShallow 补全

### 文件信息

- 路径：`apps/crish-desktop/src/components/chat/hooks/useChatCardSelectors.ts`
- 行数：31

### useShallow 包装检查

| Selector | 行号 | 是否 useShallow 包装 | 判定 |
|----------|------|---------------------|------|
| `appSettings` | 19 | `s(useShallow((st) => st.appSettings))` | ✅ |
| `diffFiles` | 20 | `s(useShallow((st) => st.diffFiles))` | ✅ |
| `composerDrafts` | 29 | `s(useShallow((st) => st.composerDrafts))` | ✅ |
| `permissionMode` | 21 | 标量，不需要 | ✅ |
| `planModeEnabled` / `planApproved` | 23-24 | 标量，不需要 | ✅ |
| `withdrawMessage`（函数引用） | 18 | 函数引用稳定，不需要 | ✅ |

**缺失功能清单：**
- 无（useShallow 已正确应用于所有返回对象的 selector）

---

## 附加检查

### layoutHelpers.ts 拆分

| 检测项 | 结果 |
|--------|------|
| `layoutHelpers.ts` 是否为 barrel | ✅ 是（26 行，re-export from `./layout-helpers/index`） |
| `layout-helpers/` 文件数 | 5 个（index, ui-selectors, session-selectors, permission-selectors, diff-selectors） |
| 子文件行数 | index:34, ui-selectors:414, session-selectors:73, permission-selectors:18, diff-selectors:20 |
| 规划要求 (≤300) | ❌ ui-selectors.ts（414 行）超标 114 行 |
| useShallow 使用 | permission-selectors.ts 中 `useCommandPermissions()` 使用了 `useShallow` ✅ |

---

## 汇总：缺失功能清单

| 优先级 | 问题 | 涉及领域 | 详细 |
|--------|------|---------|------|
| 🔴 P0 | `sessionActions.ts` 存在破损实现，`session-actions/` 无人引用 | E-3 | 旧路径文件引用了不存在的 `./actions/*`，新路径 barrel 不被消费 |
| 🟠 P1 | `layoutStore.ts` 未接入 slices | E-5 | 4 个 slice 已定义工厂函数但未被 layoutStore 使用，store 514 行超标 |
| 🟠 P1 | protocol-inbound.ts / outbound.ts 超标 | D-1 | 分别 537/601 行，是 400 行上限的 1.3x/1.5x |
| 🟡 P2 | `layout-helpers/ui-selectors.ts` 超标 | E-4 | 414 行（≤300 规划上限） |
| 🟢 P3 | message-router handler 刚好 51 个，接近阈值 | D-8 | 仅 1 个富余 |
