# F2 审批中心（移动端）功能方案

- 文档编号：F2（审批中心域）
- 状态：草案（待评审）
- 日期：2026-08-09
- 读者：多端互通主控、F1 推送域 / 安全域 / 会话域功能设计、引擎侧（session-loop / agent-workbench）、移动端实现组
- 关联功能域：F1 推送（通知触发）、安全域（双因素/危险操作）、会话与 run 域（上下文展示）、F4 设置域（策略配置）
- 依据代码：`crates/agent-tools/src/permission.rs`、`apps/agent-workbench/src-tauri/src/core_run_commands.rs`、`apps/crish-desktop/src/api/chat-bridge/handlers/approvalHandlers.ts`、`apps/crish-desktop/src/hooks/useAgentToolApproval.ts`、`crates/conex-types/src/events.rs`（均为可读代码文件，含注释）；错误码事实经 grep 检索 `crates/conex-types/src/error.rs` 佐证

## 目录

1. 背景与目标
2. 桌面端审批机制盘点（证据）
3. 移动端功能总览与信息模型
4. 待办列表
5. 审批详情与决策
6. 通知触发（与 F1 推送域衔接）
7. 历史记录
8. 离线场景
9. 交互设计：用户旅程、双因素、误触防护
10. 权限对等
11. 状态同步与冲突处理
12. 接口契约
13. 测试点
14. 风险与开放问题
15. 验收标准

---

## 1. 背景与目标

### 1.1 场景价值

审批是移动端**最高价值**场景：桌面端 Agent 执行到危险/越界操作时进入 `awaiting-approval` 状态，**整个 run 被阻塞等待用户裁决**（详见 §2.1）。此时用户若离开桌面（开会、通勤、午休），审批请求会一直等待到 120 秒超时（`ApprovalGateImpl` 的 `APPROVAL_TIMEOUT`，见 §2.6）。手机端审批中心让用户在任何地点即时处理，把「桌面端有审批 → 手机即时放行」的闭环压缩到 3 秒内（§9.1）。

### 1.2 目标

1. 待办列表：完整、实时、与桌面端一致地呈现所有等待用户裁决的审批请求（工具名、参数摘要、危险级别、所属 run 与会话、剩余决策时间）。
2. 决策能力：允许 / 拒绝（含拒绝理由）、可选「记住此命令」（白名单），决策语义与桌面端**完全一致**（权限对等，§10）。
3. 通知触发：审批请求到达即时推送，点击直达对应审批详情（与 F1 推送域衔接，§6）。
4. 历史与离线：已处理记录可查；app 未开、网络断开、审批超时均有明确可解释的状态（§7、§8）。
5. 体验：3 秒内完成决策的交互路径、危险操作二次确认、误触防护、批量处理（§9）。

### 1.3 非目标（本期不做）

- 不改引擎审批判定矩阵与决策类型（无「改参数」决策——桌面端本就没有，见 §2.4）。
- 不新增第三类决策（如「部分允许」）；不替代桌面端，仅与桌面端同权并存。
- 红线（Redline）命令直接 Deny、plan 模式直接 Deny，**不产生审批请求**（§2.2），移动端无需处理这两类——但需在历史/空态中给出可解释文案。
- 不做审批策略编排（如按工具/路径自动允许的复杂规则），只消费引擎既有的白名单语义。

### 1.4 设计原则

1. **服务端（引擎）为唯一事实源**：待办集合的增删以事件流 + 启动对账为准，移动端不发明本地真相（§11.1）。
2. **幂等优先**：`toolCallId` 是全部去重/冲突处理的幂等键（对齐桌面 `approvalHandlers.ts` 的 pending 去重）。
3. **决策即写操作**：允许/拒绝是写操作，冲突处理优先级 = 先到者胜 + 后到者获得明确反馈（§11.2）。
4. **UI 层安全机制不改权限语义**：二次确认、双因素、误触防护全部在展示/提交前校验层，决策经引擎同一入口落地（§10）。

---

## 2. 桌面端审批机制盘点（证据）

### 2.1 审批请求完整生命周期

引擎侧链路（`apps/agent-workbench/src-tauri/src/core_run_commands.rs`）：

1. **请求发起**：工具执行器调用 `ApprovalGate::request_approval(call_id, tool_name, args, requester)`（`core_run_commands.rs:263-343`），仅在权限模式 ≠ full-access 时启用审批门（`core_run_commands.rs:3167-3172`：`approval_enabled = permission_mode != "full-access"`）。
2. **裁决者路由**（T-D-14 权限传递层）：来源分类 + 路由（`core_run_commands.rs:273-278`，`classify_source` / `route_approval` / `route_approval_guarded` / `arbiter_metadata` 来自 `session_loop::approval_router`）：
   - 主 agent run（`parent_run_id = None`）→ 用户裁决；
   - 子代理 run（`parent_run_id = Some(主 run)`）→ 主 agent 裁决（载荷携带 `requester_run_id` / `reason`，`metadata.arbiter = "main-agent"`，见 `core_run_commands.rs:299-306` 与测试 `core_run_commands.rs:4240-4282`）；
   - 死锁检测命中（主 agent 正在 wait 该子代理）→ 转用户兜底（`core_run_commands.rs:217-224` 注入点；引擎侧信号源尚未接线，见 `core_run_commands.rs:3150-3154` 注释，现状退化为纯超时兜底）。
3. **广播事件**：先发后等防死锁（01 §五.8）——`approval-requested` 事件经缓冲事件桥实时广播，信封 `sequence = None`（实时预览）；持久化副本随收口流落库（带序列号）（`core_run_commands.rs:288-312`、`3142-3149`）。
4. **状态机联动**：run 状态 `running → awaiting-approval` 落库（中间态可观测）（`core_run_commands.rs:314-325`）。
5. **注册等待**：`pending` 集合 `tool_call_id → oneshot 通道`（`core_run_commands.rs:327-336`）。
6. **等待决策**：`tokio::time::timeout(120s)`，超时返回 `ApprovalDecision::Expired`（`core_run_commands.rs:338-342`；超时常量 `core_run_commands.rs:88`）。
7. **用户裁决**：前端经 transport 发 `core_approve_tool` / `core_deny_tool`（Tauri 命令，注册于 `main.rs:153-154`）→ `ApprovalGateImpl::resolve`：
   - **I-02 校验**：`tool_call_id` 必须在待审批集合，不匹配返回 `NotFound`（杜绝伪造 approval-resolved 审计事件 / 提前审批）（`core_run_commands.rs:230-245`）；
   - 送决策（oneshot）→ 状态机恢复 `awaiting-approval → running`（`core_run_commands.rs:246-257`）；
   - 落地 `approval-resolved`（持久化 + 实时发射，信封带 runId/sequence）（`emit_approval_resolved`，`core_run_commands.rs:3802-3835`）。
8. **工具继续执行**：`ApprovalDecision` 返回工具侧，Approved 放行执行、Denied 工具报拒绝错误（`core_run_commands.rs:339-342` 返回后由调用方消费）。

生命周期时序图：

```
工具执行侧          ApprovalGateImpl            事件桥/收口流            前端(桌面/移动)
   |    request_approval(call_id, tool_name, args, requester)   |
   |------------------>|                                        |
   |                   | 1. 来源分类 + 裁决者路由                |
   |                   | 2. 广播 approval-requested (sequence=None 实时预览)
   |                   |---------------------------------------->|
   |                   | 3. run 状态机: running → awaiting-approval(落库)
   |                   | 4. pending[call_id] = oneshot           |
   |                   | 5. timeout(120s) 等待决策               |
   |                   |                                        | core_approve_tool/deny
   |                   |<----------------------------------------|
   |                   | 6. resolve: pending 校验(I-02 NotFound) |
   |                   | 7. oneshot.send(decision); → running    |
   |<--- ApprovalDecision(Approved/Denied/Expired)               |
   |                   | 8. emit approval-resolved(落库+实时)     |
   |                   |---------------------------------------->|
```

关键结论（移动端设计输入）：

- **事件对**：`approval-requested`（入队）与 `approval-resolved`（出队）成对出现，`tool_call_id` 是配对与去重的幂等键。
- **实时预览双发**：`approval-requested` 先以 `sequence=None` 实时预览发出，持久化副本随后到达——移动端必须按 `toolCallId` 幂等去重（对齐桌面 `approvalHandlers.ts:56-58`）。
- **超时无事件**：Expired 只返回工具侧，**不发射 `approval-resolved` 事件**（`emit_approval_resolved` 仅在 approve/deny 两个命令路径被调用，`core_run_commands.rs:3767、3793`）——桌面前端靠本地兜底计时（`core_run_commands.rs:88` 注释「前端 ApprovalFlow 亦有兜底」），移动端必须同样本地倒计时（§8.3），并把「引擎补发 expired 事件」列为引擎增强提案（§14）。

### 2.2 权限判定矩阵（谁会产生审批请求）

判定引擎 `crates/agent-tools/src/permission.rs`：

- **权限模式**三态：`Ask`（需确认）/ `FullAccess`（全放行）/ `Plan`（只读拒绝）（`permission.rs:19-27`）。
- **引擎字符串映射**：`ask / deep / unattended / auto / 未知 → ask`（安全默认）；`full-access / full / yolo / allow / danger → full-access`；`plan / readonly → plan`（`permission.rs:32-43`）。
- **三态判定矩阵** `decide(dangerous, requires_approval, mode)`（`permission.rs:78-87`）：

| dangerous | requires_approval | ask | full-access | plan |
|---|---|---|---|---|
| false | false | 放行 | 放行 | 放行 |
| true | false | **NeedsApproval** | 放行 | 拒绝（不弹窗） |
| false | true | **NeedsApproval** | 放行 | 拒绝（不弹窗） |
| true | true | **NeedsApproval** | 放行 | 拒绝（不弹窗） |

- **红线先行** `decide_with_redline`：命令经语义层判定为 Redline（如 `rm -rf /`、mkfs 写设备）→ 一律 `Deny`，**不经三态矩阵，任何模式不弹窗、full-access 不豁免**（`permission.rs:96-106`，测试 `permission.rs:276-330`）。→ **移动端审批中心永远不会看到红线请求**。
- **C3 回退护栏** `decide_command_with_revert`：大面积 git 回退（文件数/行数/跨目录/ref 年龄超阈值）→ `NeedsApproval`，**full-access 也不豁免**（`permission.rs:135-151`、`permission.rs:459-485`）——这是审批请求中唯一「非工具 dangerous 标记」的来源，移动端需展示回退影响面（§5.3）。

**移动端危险级别推导**（UI 展示层，不改引擎语义）：

| 级别 | 来源信号 | 引擎事实 | 移动端展示 |
|---|---|---|---|
| L1 常规 | 工具 `dangerous` 或 `requires_approval` 命中 ask 模式 | `permission.rs:78-87` | 常规确认，单点决策 |
| L2 高风险 | 删除类（payload 删除影响面）、C3 大面积回退（revertGate 面积）、命令门禁越界（`requires_approval`，如 git push --force） | `approvalHandlers.ts:50-54`（S9 宽容解析 revertGate 面积/删除影响面）、`permission.rs:135-151` | 二次确认（滑动），可配双因素（§9.2） |
| 不产生审批 | 红线 / plan 模式写类 | `permission.rs:96-106` | 历史区说明文案，不出现在待办 |

### 2.3 决策类型与命令面

- **决策类型仅三种规范值**：`approved / denied / expired`（`events.rs:225-232` 的 `ApprovalDecision`）。
- **没有「改参数」决策**：`core_approve_tool` 的 `decision` 参数只接受 `approved`，其余一律 `InvalidInput` 拒绝（`core_run_commands.rs:3757-3762`）。→ 移动端不设计改参入口。
- **拒绝可带理由**：`core_deny_tool(run_id, tool_call_id, reason?)`，缺省 `"user denied"`（`core_run_commands.rs:3777-3799`）——移动端拒绝时提供理由选择（§5.2）。
- **返回形状**：`{ok, toolCallId, decision}`（`core_run_commands.rs:122-129`）。
- **冲突信号**：`resolve` 时 `tool_call_id` 不在待审批集合 → `CoreError::NotFound`（`core_run_commands.rs:240-245`）——这是移动端处理「已被处理 / 已过期」冲突的关键判据（§11.2）。

### 2.4 事件协议（移动端消费的载荷）

`crates/conex-types/src/events.rs`：

- `AgentEvent::ApprovalRequested { session_id, request: PermissionRequest, timestamp }`（`events.rs:479-484`）。
- `PermissionRequest` 字段（`events.rs:196-218`）：

| 字段 | 类型 | 说明 | 移动端用途 |
|---|---|---|---|
| id | string | `approval-{call_id}` | 审计标识 |
| sessionId | string | 所属会话 | 列表分组/深链 |
| cwd | string | 工具执行工作目录 | 详情展示 |
| toolCallId | string | 幂等键（前端硬依赖） | 去重/决策/冲突 |
| toolName | string | 工具名（前端硬依赖） | 列表主标题 |
| parameters | JsonValue | 参数包（前端硬依赖） | 详情渲染 |
| summary | string | 引擎侧摘要（`call {toolName}`） | 兜底文案 |
| toolMetadata | object | 工具元数据 | 备用 |
| metadata | object? | 含 `arbiter`（`main-agent` = 主 agent 裁决） | 决策面开关 |
| requesterRunId | string? | 子代理 run id | run 上下文 |
| reason | string? | 子代理申请理由 | 详情展示 |

- `AgentEvent::ApprovalResolved { session_id, tool_call_id, request_id?, decision, timestamp }`（`events.rs:487-495`）。
- 信封（`AgentEventEnvelope`）带 `runId` 与 `sequence`（持久化副本必有序列；实时预览为 None）——移动端详情需展示所属 run。
- 错误码域存在 `approval.timeout` / `approval.rejected`（`crates/conex-types/src/error.rs:150-152`，grep 检索佐证）——移动端错误映射参考。

### 2.5 前端行为（对齐基准）

桌面前端（`apps/crish-desktop/src/api/chat-bridge/handlers/approvalHandlers.ts`）：

- `onApprovalRequested`（`approvalHandlers.ts:25-114`）：
  - 宽容解析嵌套 `request` 或平铺 daemon WS 形状（`approvalHandlers.ts:31`）；
  - `toolCallId` 必填，缺失记内部错误（`approvalHandlers.ts:33-39`）；
  - `explanation = summary ?? reason ?? message ?? toolName`（`approvalHandlers.ts:47-49`）——移动端文案抽取对齐此逻辑；
  - **plan 模式直接放行不弹窗**（`approvalHandlers.ts:60-64`）；
  - **白名单自动放行**：`shouldAutoApproveCommand` 命中 → 直接 `core_approve_tool({toolCallId, scope:'project'})`，且**极危/破坏性命令（rm/format/git push 等）即使白名单命中也不静默放行**（硬拒绝门禁，`approvalHandlers.ts:66-97`）——移动端「记住此命令」必须继承同一硬拒绝门禁（§10.2）；
  - 未自动放行 → `approval_pending` + `onToolPendingApproval`（`approvalHandlers.ts:99-113`）；
  - 同 `toolCallId` 重复事件去重（`approvalHandlers.ts:56-58`）。
- `onApprovalResolved`（`approvalHandlers.ts:116-146`）：`decision !== 'approved'` → 视为拒绝（含 expired 兜底语义）；拒绝且无剩余 pending → run 以失败收场（`finish(false)`）。

桌面端决策落地（`apps/crish-desktop/src/hooks/useAgentToolApproval.ts`，子 agent 裁决路径，主对话同构）：

- **乐观更新**：allow → 立即标 `running`「执行中…」；deny → 立即标 `error`「已拒绝」（`useAgentToolApproval.ts:77-80、102-105`）。
- **失败回滚**：allow 失败 → 标 `error`「批准失败」；deny 失败 → 回滚 `pending_approval`「拒绝未送达」（`useAgentToolApproval.ts:82-88、107-113`）。
- **busy 防双点**：决策发送期间锁定，200ms 后释放（`useAgentToolApproval.ts:64、90、99、115`）——移动端对齐此防重机制（§9.3）。
- **remember 白名单**：allow 时可选 remember → `addCommandPermission(prefix)`（`useAgentToolApproval.ts:66-74`）——移动端「记住」走同一白名单（§10.2）。

### 2.6 对移动端的约束清单（盘点结论）

1. 移动端可见请求 = ask 模式下 dangerous / requires_approval / C3 大面积回退；红线与 plan 拒绝不出现。
2. 决策只有 allow / deny（deny 可带理由）；无改参；决策命令必须携带 `run_id` + `tool_call_id`。
3. 超时 120 秒且引擎不广播 expired 事件 → 移动端本地倒计时 + 超时后决策必然 NotFound。
4. `toolCallId` 是唯一幂等键；`approval-requested` 可能双发（实时预览 + 收口流）。
5. 子代理请求默认由主 agent 裁决（`arbiter=main-agent`），移动端只读展示，不提供用户决策按钮。
6. 白名单自动放行与「记住」必须继承 `shouldAutoApproveCommand` 的极危硬拒绝门禁。
7. 决策发送是写操作，先到者胜；`NotFound` 是「已被处理/已过期」的标准信号。

---

## 3. 移动端功能总览与信息模型

### 3.1 功能清单与优先级

| 编号 | 功能 | 优先级 | 章节 |
|---|---|---|---|
| F2-01 | 待办列表（含危险级别、倒计时、run/会话上下文） | P0 | §4 |
| F2-02 | 审批详情（参数渲染、风险提示、cwd/会话/run） | P0 | §5.1 |
| F2-03 | 决策：允许 / 拒绝（理由）/ 记住 | P0 | §5.2 |
| F2-04 | 危险操作二次确认（滑动） | P0 | §5.3 |
| F2-05 | 推送触发 + 深链直达 | P0 | §6 |
| F2-06 | 历史记录（已处理/已过期） | P0 | §7 |
| F2-07 | 离线：本地缓存、决策队列、超时状态 | P0 | §8 |
| F2-08 | 批量处理（多选允许/拒绝） | P1 | §5.4 |
| F2-09 | 双因素：危险操作桌面在场确认（可选配置） | P1 | §9.2 |
| F2-10 | 主 agent 裁决请求只读卡片 | P1 | §4.3 |

### 3.2 架构定位

```
桌面端(agent-workbench + React)
   │ 事件桥广播 approval-requested / approval-resolved（信封 runId/sequence）
   │ core_approve_tool / core_deny_tool（Tauri 命令，唯一写入口）
   ▼
推送桥（F1 推送域，新增适配器）
   │ 组合消息（notification 即时显示 + data 载荷深链）
   ▼
移动端（crish-mobile）
   ├─ 推送接收 → 本地通知 + 深链（conex://approval?toolCallId=…）
   ├─ 事件总线（app 前台时经长连接收实时事件；与推送去重）
   ├─ 审批中心 Store（本地缓存 + 乐观更新 + 冲突态）
   └─ 决策网关 → 桌面端桥（复用 core_approve_tool/core_deny_tool）
```

衔接约定：推送域提供「注册设备 token / 下发消息 / 深链路由」能力，本域只定义审批消息的载荷与语义（§6）；安全域提供「桌面在场状态」查询语义，本域只消费展示（§9.2）；会话域提供会话标题映射，本域展示归属。

### 3.3 移动端信息模型

```
PendingApproval {
  toolCallId: string          // 幂等键（唯一，来源 PermissionRequest.toolCallId）
  runId: string               // 信封 runId
  sessionId: string
  toolName: string            // 列表主标题
  summary: string             // explanation（summary ?? reason ?? message ?? toolName）
  parameters: JsonValue       // 详情渲染原始参数
  cwd: string                 // 工作目录
  requesterRunId?: string     // 子代理归属
  reason?: string             // 子代理申请理由
  arbiter: 'user' | 'main-agent'   // metadata.arbiter
  dangerLevel: 1 | 2          // 本地推导（§2.2 表）
  riskMeta?: {                // 对齐桌面 parseApprovalPayload（approvalHandlers.ts:50-54）
    revertArea?: { fileCount?: number; lineCount?: number; crossDirectory?: boolean; refAgeSeconds?: number }
    deleteImpact?: { pathCount?: number; sizeBytes?: number }
    command?: string          // 抽取后的命令行（extractApprovalCommandArgs 对齐）
  }
  requestedAt: number         // 移动端收达时间（对账时为引擎时间戳）
  expiresAt: number           // requestedAt + 120_000（引擎 APPROVAL_TIMEOUT 对齐）
  status: 'pending' | 'deciding' | 'approved' | 'denied' | 'expired' | 'conflict'
}
```

状态迁移（本地状态机）：

```
           收到 approval-requested（去重后）
   ───────────────────────────────────────────────► pending
   pending ──用户决策发送──► deciding ──approval-resolved 匹配──► approved / denied
   pending ──本地倒计时到期──► expired
   deciding ──服务端 NotFound / 超时无回执──► conflict（提示后转 expired 或刷新）
```

---

## 4. 待办列表

### 4.1 数据来源与刷新策略

- **实时入队**：app 前台时经事件通道接收 `approval-requested`（含推送 data 兜底）；按 `toolCallId` 幂等去重（对齐 `approvalHandlers.ts:56-58`），新请求顶部插入 + 触发本地通知（§6.3）。
- **启动对账**：冷启动/回前台时调用新增查询命令 `mobile_list_pending_approvals`（§12）拉取引擎侧未决清单（events 表 approval-requested 且无配对 approval-resolved），与本地缓存合并：
  - 引擎有、本地无 → 入队（含离线期间的遗漏）；
  - 本地有、引擎无 → 已被处理或过期 → 转历史并标记状态（resolved 事件可能已错过）。
- **出队**：收到 `approval-resolved`（或对账确认）→ 从待办移除，写入历史（§7）。
- **刷新触发**：下拉刷新（对账）、事件到达、决策完成后自动对账一次。

### 4.2 列表项设计

每条待办展示（自上而下）：

1. **工具名 + 危险级别徽标**：`toolName`（主标题）；L2 显示红色「高风险」角标，L1 不显示或灰色「需确认」。
2. **参数摘要**：命令类工具展示抽取后的命令行（`extractCommandForMatch` 对齐，`approvalHandlers.ts:67`）；普通工具展示参数键值摘要（最多 2 行，超长截断，细节进详情页）。
3. **归属上下文**：会话标题（会话域映射）+ run 标识（子代理请求显示「子 Agent · {requesterRunId}」）。
4. **剩余决策时间**：`expiresAt` 倒计时环/进度条（120 秒），最后 15 秒变红 + 文案「即将过期」；过期后条目置灰标「已过期」但仍保留 24 小时（供用户知晓），可手动清理。
5. **状态徽标**：`pending` 正常；`deciding` 显示菊花；`conflict` 显示「状态可能已变化，点击查看」。

排序：剩余时间升序（最紧急在顶部）；分组视图按会话聚合（可切换为扁平列表）。

### 4.3 待办列表线框图

```
┌────────────────────────────────────────────┐
│  ◀  审批中心            已处理(12)  ⚙︎  ☰     │   ← 顶部栏：历史入口、设置
│────────────────────────────────────────────│
│  🔔 3 项待处理 · 桌面端 2 项 Agent 自动裁决    │   ← 概览条（含 main-agent 只读项计数）
│────────────────────────────────────────────│
│ ┌────────────────────────────────────────┐ │
│ │ [高风险] 删除文件           剩余 1:42    │ │   ← L2：红徽标 + 倒计时
│ │ delete_file /src/deprecated/*.ts        │ │   ← 命令行摘要（等宽）
│ │ 会话「后端重构」 · run #42              │ │
│ │ ───────────────────────────  [查看]     │ │
│ └────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────┐ │
│ │ 需确认  git push --force                │ │   ← L1：命令门禁越界
│ │ 会话「发布准备」 · run #40   剩余 0:58   │ │
│ │ ───────────────────────────  [查看]     │ │
│ └────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────┐ │
│ │ ⏳ 等待 Agent 裁决（子任务）             │ │   ← arbiter=main-agent：只读
│ │ 写入文件 src/x.md                       │ │
│ │ 子 Agent sub-3 · 理由：需要扩展写入范围  │ │
│ └────────────────────────────────────────┘ │
│────────────────────────────────────────────│
│  [☑ 批量处理]                    [长按多选] │   ← 底部操作区
└────────────────────────────────────────────┘
```

空态：`无待处理审批。当桌面端 Agent 需要确认时，会第一时间推送到这里。` + 关联「权限模式」提示（full-access 会话不会产生审批；plan 模式写类直接拒绝）。

### 4.4 主 agent 裁决请求（只读卡片）

`metadata.arbiter = "main-agent"` 的请求（子代理发起，`core_run_commands.rs:299-306`）：移动端展示为只读卡片（如上图第三项），提供查看详情（含 `reason`），**不渲染决策按钮**；文案「该请求由桌面端主 Agent 自动裁决，无需你操作」；若用户恰好想介入，卡片提供「在桌面端查看」提示（当前引擎未接线死锁转用户路径，`core_run_commands.rs:3150-3154`，介入能力列为后续）。

---

## 5. 审批详情与决策

### 5.1 详情页（参数要能看懂）

结构（自上而下）：

1. **风险横幅**（仅 L2）：红底白字，列出具体风险点——删除影响面（文件数/大小）、C3 回退面积（文件数/行数/跨目录/回退年龄，`permission.rs:135-151`）、命令越界类型（git push --force 等）。来源：`riskMeta`（对齐桌面 `parseApprovalPayload` 的 S9 解析，`approvalHandlers.ts:50-54`）。
2. **请求说明**：`summary` / 子代理 `reason`（`events.rs:213-217`）。
3. **参数详情**：
   - 命令类工具（command/shell 系）：命令行全文等宽显示 + 关键参数高亮（如 `--force`、`-rf` 红色高亮）；
   - 普通工具：键值表（参数名 + 值，长值可展开复制）；
   - `cwd` 单独一行显示（工作目录，`events.rs:199`）。
4. **上下文区**：会话标题、run id、请求发起时间、子代理请求方（`requesterRunId`）、剩余决策时间。
5. **决策区**（固定底部，拇指区）：详见 §5.2。

线框图：

```
┌────────────────────────────────────────────┐
│  ◀  审批详情                          ⚙︎     │
│────────────────────────────────────────────│
│  ⚠ 高风险                                   │
│  · 删除 3 个文件（约 48 KB）                 │   ← 风险横幅（deleteImpact）
│  · 目标路径含 src/deprecated/                │
│────────────────────────────────────────────│
│  删除文件  delete_file                       │
│  ────────────────────────────────────────── │
│  📄 参数（命令）                              │
│  ┌────────────────────────────────────────┐ │
│  │ delete_file(path="/src/deprecated/     │ │
│  │   a.ts", recursive=true)               │ │   ← 等宽 + 危险参数高亮
│  └────────────────────────────────────────┘ │
│  工作目录  C:\Software\conex\src           │
│────────────────────────────────────────────│
│  所属会话  后端重构                          │
│  Run       #42 · 12:03:05 发起              │
│  剩余时间  ⏳ 0:58（倒计时条）               │
│────────────────────────────────────────────│
│  [记住此命令，下次自动允许] ☐                │   ← remember（含门禁说明）
│  ┌────────────────────────────────────────┐ │
│  │           拒绝（附理由）                  │ │
│  ├────────────────────────────────────────┤ │
│  │  ⟶ 滑动以允许（高风险需滑动）             │ │   ← L2 滑动确认
│  └────────────────────────────────────────┘ │
└────────────────────────────────────────────┘
```

### 5.2 决策动作

- **允许**：主按钮（绿），L1 单击即决策；L2 必须滑动（§5.3）。决策发送 `core_approve_tool(run_id, toolCallId)`（复用桌面命令面，`core_run_commands.rs:3750-3773`）。
- **拒绝**：次按钮（灰/红），点击弹出理由面板：快捷理由 chips（「重复执行，请重新规划」「风险过高」「误发起」）+ 自定义输入（≤200 字，可跳过留空）→ 发送 `core_deny_tool(run_id, toolCallId, reason)`（`core_run_commands.rs:3777-3799`）。
- **记住此命令**：允许时勾选 → 桌面白名单 `addCommandPermission`（对齐 `useAgentToolApproval.ts:66-74`）；详情页展示白名单生效范围说明「将对同类命令自动放行（极危命令除外）」——极危硬拒绝门禁继承（§10.2）。
- **反馈**：决策成功 → 原位置显示「✓ 已允许 / 已拒绝」，500ms 后返回列表（或停留在历史）；失败 → 按 §11.2 冲突/重试处理，原地出错误态，不丢失上下文。

### 5.3 危险操作二次确认

- **触发条件**：`dangerLevel === 2`（删除影响面 / C3 大面积回退 / 命令门禁越界）。
- **交互**：允许按钮变为「滑动以允许」滑轨（横向滑过阈值 70% 才可抬起触发；中途松开回弹）。拒绝保持单点（拒绝是安全方向，不需二次确认——对齐「拒绝永远比允许容易」的通用安全模式）。
- **原则**：二次确认只防误触，**不改变权限语义**；滑动确认后仍走引擎同一 `resolve` 入口。
- 若配置了双因素（§9.2），L2 允许在滑动后还需通过桌面在场校验。

### 5.4 批量处理

- 入口：列表页「批量处理」/ 长按进入多选模式（顶部显示已选计数）。
- 操作：
  - **批量拒绝**（默认可用）：多选 → 批量拒绝（可附通用理由或「按各自默认理由」）。
  - **批量允许**（受限）：仅允许对 **L1 且剩余时间 > 30 秒** 的条目批量允许（防止批量误放行危险操作与临期失效请求）；L2 条目在批量模式中默认勾选为「跳过」，如需放行必须逐条进入详情滑动确认；批量允许前弹确认层「将允许 N 项工具调用（危险项已排除）」。
  - 混合选择（L1+L2）时，批量按钮显示「允许 L1（N）/ 拒绝全部（M）」。
- **发送策略**：逐条发送（串行 + 小并发 2，失败逐条标记），全部完成后汇总结果 toast「已允许 3 / 失败 1（点击重试）」；部分失败条目标 `conflict` 进入重试队列（§8.2）。
- **安全约束**：批量允许永不包含 L2；白名单「记住」在批量模式不提供（避免无意识扩大放行范围）。

---

## 6. 通知触发（与 F1 推送域衔接）

### 6.1 触发链路

```
引擎广播 approval-requested（事件桥，sequence=None 实时预览）
   ▼
桌面端推送桥适配器（F1 域新增）：监听该事件，按需过滤（仅 arbiter=user 且非白名单自动放行的请求）
   ▼
推送服务（FCM / APNs，F1 域负责 token 注册与发送）
   ▼
移动端：app 前台 → 事件总线处理（不弹系统通知，展示应用内横幅）
         app 后台/被杀 → 系统通知（notification 部分即时展示，data 部分深链）
```

### 6.2 通知内容与深链

- **消息类型**：组合消息（notification + data）——notification 保证系统级即时呈现（含 app 被杀场景，FCM 官方语义：notification 消息由系统展示，data 消息由应用代码处理；payload 上限 4096 字节），data 携带深链上下文。
- **通知标题**：`需要你确认：{toolName}`；**正文**：参数摘要（≤2 行）+ 危险标记前缀（L2：`⚠ 高风险`）+ 会话标题。
- **data 载荷**（全部 ≤4096B，参数超长时摘要化截断）：

```
{ "route": "conex://approval?toolCallId=<id>&runId=<runId>&sessionId=<sid>",
  "toolCallId": "<幂等键>", "toolName": "...", "summary": "...",
  "dangerLevel": 1|2, "sessionTitle": "...", "requestedAt": <ms>, "expiresAt": <ms> }
```

- **深链路由**：点击通知 → 冷启动/热启动 → 路由到审批详情页；若该 `toolCallId` 已过期或被处理（详情页对账判定），展示对应状态页（§8.3）而非空白。
- **前台策略**：app 前台收到同源事件时不弹系统通知（避免双弹），改应用内横幅（可点入详情）。

### 6.3 去重与幂等

- **通知键**：`toolCallId`（Android 通知 `tag`、iOS 自定义合并策略）；同一请求只推一次。
- **决策后撤销**：收到 `approval-resolved`（approved/denied）→ 若通知仍挂起，静默撤销/标记已读（FCM 无法主动收回，采用：data 消息「status=resolved」到达后应用清除本地通知；不依赖服务端撤回）。
- **重复推送**：`approval-requested` 双发（实时预览 + 收口流）在推送桥侧去重（桥内按 `toolCallId` 记忆，TTL 5 分钟）。
- **过期通知**：`expiresAt` 已过但用户才点开 → 详情页展示「已过期」状态页（§8.3），不产生决策入口。

### 6.4 时效保障

- 审批时效 120 秒极短，推送必须即时：推送桥对 approval 消息使用高优先级通道（FCM `AndroidPriority=high` / APNs `apns-priority=10`）；TTL 设为 60 秒（超过 60 秒未送达的消息即使到达也已大概率过期，直接丢弃由对账兜底）。
- 推送服务不可达（桌面端离线/无网络）→ 不阻塞引擎（审批照常等待）；移动端打开后靠对账（§4.1）补齐待办，通知缺失不导致待办丢失。

---

## 7. 历史记录

### 7.1 内容与来源

- **条目来源**：
  1. `approval-resolved` 事件（approved / denied，含被拒绝理由）——实时入历史；
  2. 本地倒计时到期的 `expired` 条目（无服务端事件，§2.6）；
  3. 对账发现「本地有待办、引擎已无」的条目（补记 `denied/approved`，来源标注「已由其他设备处理」或过期）。
- **每条记录字段**：toolName、参数摘要、危险级别、决策、决策时间、决策渠道（本机/桌面端/自动过期）、拒绝理由（如有）、所属会话与 run、关联回执（可跳转 run 结果）。
- **查询**：按会话筛选、按决策类型筛选、按时间倒序；保留策略：本地保留最近 500 条，其余随服务端事件历史（会话域）归档。

### 7.2 历史列表线框图

```
┌────────────────────────────────────────────┐
│  ◀  已处理                        [筛选 ▾]  │
│────────────────────────────────────────────│
│  ✓ 已允许  删除文件 · 12:05:10    （本机）   │
│  ✗ 已拒绝  git push --force · 11:58:02      │
│            理由：风险过高                     │
│  ⏳ 已过期  写入文件 config.toml · 11:40     │
│  ✓ 已允许  npm install -D vitest · 11:02    │
│  ✓ 已允许  删除文件 · 10:47（桌面端处理）    │
└────────────────────────────────────────────┘
```

---

## 8. 离线场景

### 8.1 场景矩阵

| 场景 | 表现 | 处理 |
|---|---|---|
| 收到推送但 app 未开 | 系统通知常驻锁屏/通知栏 | 点击 → 深链冷启动 → 对账拉取详情 → 若未过期未处理，待办完整呈现（§6.2） |
| app 打开但无网络 | 待办列表来自本地缓存（上次对账快照） | 显示「离线模式」横幅 + 数据时间戳；决策进入本地队列（§8.2）；恢复网络自动对账补拉 |
| 决策发送时断网 | 决策挂起 | 本地队列：乐观置 `deciding`，重试（指数退避 2s→4s→8s→30s 封顶），恢复后补发 |
| 推送到达但深链页已过期 | 详情页状态判定 | 展示「已过期」状态页（§8.3） |
| 引擎侧桌面端已关闭 | 审批无人裁决，120s 超时 | 移动端倒计时到期置 expired；引擎超时语义不变（工具非致命处理，`core_run_commands.rs:341`） |

### 8.2 本地决策队列

- 队列条目 = 完整 `PendingApproval` + 目标决策（allow/deny+reason）+ 重试计数；持久化到移动端本地存储。
- 补发成功（收到 `approval-resolved` 或命令回执 ok）→ 出队入历史。
- 补发 `NotFound` → 判定「已被处理/已过期」→ 出队，条目置 `conflict` 并提示用户刷新查看真实结果（§11.2）。
- 网络恢复时按序补发；多次失败（≥5 次）转人工提示「决策未送达，请检查连接后重试」。

### 8.3 审批超时（120 秒）处理

- **本地倒计时**：收到 `approval-requested` 即启动 `expiresAt = 收达时间 + 120_000`（与引擎 `APPROVAL_TIMEOUT` 对齐，`core_run_commands.rs:88`）；到期自动置 `expired` 并从待办移入历史，无需服务端事件（引擎不广播 expired，§2.6）。
- **过期后决策**：用户仍点「允许」→ 发送必然 `NotFound`（`core_run_commands.rs:240-245`）→ 详情页展示冲突态：`该请求已过期（超过 120 秒），决策未生效` + 按钮「重新发起」？——重新发起不在本域（需用户在桌面端让 Agent 重跑该操作）；提供「复制请求信息」便于告知 Agent。
- **过期与 run 的关系**：引擎侧超时按非致命处理，run 继续（`core_run_commands.rs:338-342` 返回 Expired 给工具侧）；若 Agent 重试同操作会生成**新的 toolCallId**（新审批请求），移动端按新条目呈现——用户历史里能看到「过期 → 新请求」的先后关系（可选关联提示）。
- **引擎增强提案**：超时补发 `approval-resolved(expired)` 事件（当前只有 approve/deny 落事件，`core_run_commands.rs:3767、3793`），让多端状态机统一、无需各自本地计时兜底——列为 §14 开放问题，需引擎侧评审。

---

## 9. 交互设计：用户旅程、双因素、误触防护

### 9.1 3 秒决策路径

> 【裁决修正 12】审批中心 = **P0 功能（R2 首批交付）**：本方案全部内容（决策
> 链路/outbox/双因素/防抖）进 R2 首批，推送（R3）只负责通知与深链直达
> （AU3 C-3 已裁决）。【裁决修正】另注：3 秒路径中「生物解锁（0-1s）」的时机
> 口径以 M7 §3.6 解锁时机为准（冷启动 + 深链场景已覆盖，防漂移）。

**标准旅程**（用户已在桌面端发起过任务，手机收到推送）：

```
[0s]  收到推送通知（工具名 + 摘要 + 危险标记）
[0-1s] 点击通知 → 生物识别解锁（若系统已解锁则跳过）
[1-2s] 直达审批详情页（深链；参数、风险、上下文已就绪）
[2-3s] 决策：L1 单击「允许」/ L2 滑动「允许」或单击「拒绝」
[3s]   反馈 ✓ + 自动返回列表（toast「已允许，Agent 将继续」）
```

设计保障：

1. **点按次数 ≤ 3**（点通知 → 点决策 → （L2）滑动）；详情页首屏即见决策区（底部固定），无需滚动。
2. **预加载**：推送 data 载荷已含摘要与危险级别，详情页本地即时渲染；对账（网络）异步补齐参数细节，不阻塞首屏。
3. **解锁无感**：沿用系统生物识别，解锁后直接落在审批页而非首页；若 app 冷启动，深链直接进审批详情。
4. **桌面端不回访**：决策成功后桌面端审批卡片自动关闭（`approval-resolved` 广播，桌面 `approvalHandlers.ts:116-146`），用户无需回桌面二次操作。
5. **失败可解释**：任何一步失败（网络/冲突/过期）都给出可理解的状态页而非静默失败（§8.2/§8.3/§11.2）。

### 9.2 双因素场景（安全域衔接）

**背景**：权限对等（§10）要求移动端默认与桌面同权，但危险操作（L2）的安全敏感度高，用户可能希望「手机不在身边时，危险操作仍要桌面在场」。

**设计**（安全域提供能力，本域消费）：

- **配置项**（F4 设置域，默认**关闭**）：`危险操作需桌面端在场确认`。默认关闭 = 权限对等不增加限制；开启 = 用户显式选择增强保护。
- **桌面在场定义**：桌面端 app 运行中 + 用户最近交互时间戳在 N 分钟内（N 可配，默认 10 分钟；信号源由安全域统一提供——桌面端心跳上报，引擎侧持久化「设备在场状态」）。
- **开启后的行为**（仅影响 L2 允许）：
  - 详情页顶部显示桌面在场状态条：「桌面端在线，可在手机确认」/「桌面端不在场」；
  - 桌面不在场 → 「滑动以允许」置灰，提示「此操作需要桌面端在场确认，请在桌面端处理，或稍后重试」；**拒绝不受限**（拒绝永远是安全的，不应被双因素拦截）；
  - 桌面在场 → 滑动允许后正常提交（与引擎语义无差异）。
- **一致性**：该策略只在移动端提交前校验，引擎侧无感知、无新协议（不引入「需要双签」的引擎状态）——保持引擎单一事实源，安全域策略是纯展示/提交门。

### 9.3 误触防护

1. **按钮布局**：允许（主）与拒绝（次）固定底部，间距 ≥ 48dp（触控标准）；拒绝永远位于左侧远离拇指默认落点一侧（以右手习惯为基准），避免「想拒绝却误点允许」；L1/L2 按钮文案始终一致（「允许」/「拒绝」），不玩花样。
2. **L2 滑动确认**：不允许点按；滑动需越过 70% 阈值才可抬起触发（§5.3）。
3. **防重复提交**：决策发送期间按钮置忙 + 300ms 防抖（对齐桌面 200ms busy，`useAgentToolApproval.ts:64、90`；移动端略放宽以覆盖触屏误点）。
4. **批量模式**：批量允许仅限 L1 且临期（≤30s）排除（§5.4）；批量操作前有确认层。
5. **决策不可撤销提示**：L2 滑动前文案「允许后将立即执行，不可撤销」；拒绝同理轻提示。
6. **返回保护**：决策已发送（deciding）时返回列表，条目显示「处理中」，避免用户误以为未决策而重复操作。

---

## 10. 权限对等

### 10.1 决策语义对等（无额外限制）

- **同一命令面**：移动端允许/拒绝调用与桌面完全相同的 `core_approve_tool` / `core_deny_tool`（`core_run_commands.rs:3750-3799`），同一 `resolve` 入口、同一 I-02 待审批集合校验、同一 `approval-resolved` 落地与广播。
- **同一判定矩阵**：移动端不重算权限（引擎已判定 NeedsApproval 才产生请求）；不新增决策类型（无改参）；不改变 ask/full-access/plan 语义（full-access 会话引擎不产生请求，plan 拒绝不弹窗——移动端仅展示说明）。
- **同一白名单**：移动端「记住此命令」写入桌面端同源白名单（`addCommandPermission`，`useAgentToolApproval.ts:66-74`），桌面端后续请求同样自动放行——跨端共享生效。
- **同一超时语义**：移动端决策受同一 120 秒窗口约束，不因「移动端更慢」而放宽或收紧。
- **并发裁决**：双端同时决策按引擎先到者胜，不区分设备优先级（§11.2）。

### 10.2 移动端额外安全机制（只增不缩）

| 机制 | 类型 | 是否改变权限语义 |
|---|---|---|
| L2 滑动二次确认 | 误触防护 | 否（提交前 UI 校验） |
| 双因素「桌面在场」（可选配置，默认关） | 用户自选增强 | 否（引擎无感知） |
| 批量允许排除 L2 / 临期 | 批量防误放行 | 否（作用域限制） |
| 「记住」继承极危硬拒绝门禁 | 白名单安全（`shouldAutoApproveCommand`，`approvalHandlers.ts:6-7、66-97`） | 否（与桌面同一门禁） |

### 10.3 对等验证口径

验收时逐项对照：同一审批请求，桌面端与移动端可执行的决策集合、决策效果、事件产物（`approval-resolved` 载荷）完全一致；差异仅限 UI 确认层与展示文案（§15 验收标准 3、4）。

---

## 11. 状态同步与冲突处理

### 11.1 一致性模型

- **服务端为唯一事实源**：待办集合真值 = 引擎事件历史（events 表）+ 活动 run 状态机（`awaiting-approval`）；移动端与桌面端都是事件的消费者与决策的提交者。
- **三通道收敛**：
  1. 实时事件流（`approval-requested` / `approval-resolved`，推送桥 + 前台长连接双通道，本地去重）；
  2. 启动/回前台对账（`mobile_list_pending_approvals`，§4.1）；
  3. 决策命令回执（`{ok, toolCallId, decision}` 或 `NotFound`，§2.3）。
- **写入序**：`approval-resolved` 事件携带持久化 `sequence`（`emit_approval_resolved`，`core_run_commands.rs:3817-3823`），历史同步以 sequence 为水位，事件乱序时按 sequence 重排——移动端历史入档用事件 sequence 而非本地收达序。

### 11.2 冲突场景表（审批是写操作）

| 场景 | 时序 | 移动端表现 | 处理 |
|---|---|---|---|
| 桌面已处理，移动端后决策 | 桌面 approve/deny 后移动端才发送 | 命令回执 `NotFound`（`core_run_commands.rs:240-245`） | 详情页冲突态：「该请求已在其他设备处理」+ 展示真实结果（对账拉取 `approval-resolved`）；本地待办移除 |
| 双端同时决策 | 并发发送 | 引擎 pending 集合原子移除（`core_run_commands.rs:235-240`），先到者胜，后到者 `NotFound` | 同上行；「先到者胜，不区分设备」写入帮助文案 |
| 已过期后决策 | 本地倒计时已过或对账判定过期 | 发送 `NotFound` | 展示「已过期，决策未生效」（§8.3） |
| 网络失败 | 发送未达 | 命令回执失败（非 NotFound） | 乐观状态回滚 `deciding → pending`，入重试队列（§8.2），toast「决策未送达」；对齐桌面失败回滚（`useAgentToolApproval.ts:82-88、107-113`） |
| 事件重复 | 实时预览 + 收口流双发 `approval-requested` | 同 `toolCallId` 第二次到达 | 幂等忽略（对齐 `approvalHandlers.ts:56-58`） |
| 事件迟到 | 决策完成前 `approval-resolved` 尚未到达本地 | 本地仍显示 pending | 收到事件后按 `toolCallId` 匹配移除；对账兜底 |
| 双端「记住」并发 | 同命令前缀同时写白名单 | 白名单写集合语义 | 幂等（集合去重），后写覆盖先写 |
| 会话已删除 | 请求所属会话被清理 | 详情上下文缺失 | 展示「会话已删除」占位，待办仍可决策（引擎侧请求独立于会话 UI） |

### 11.3 乐观更新与回滚

- **决策发送**：本地立即置 `deciding`（灰化按钮 + 菊花），不等待网络；
- **成功**：命令回执 ok + `approval-resolved` 到达（两者先到者）→ `approved/denied` → 入历史；
- **失败分类**：
  - `NotFound` → 冲突/过期分支（上表）；
  - 网络/超时错误 → 回滚 `deciding → pending`（保留用户已选理由），入重试队列；
  - 其它服务端错误 → 回滚 + 错误文案。
- **对账修正**：任何冲突处理后触发一次静默对账（§4.1），保证列表与引擎真值一致。

---

## 12. 接口契约

### 12.1 复用（已有，零改动）

| 接口 | 位置 | 用途 |
|---|---|---|
| `core_approve_tool(runId, toolCallId, decision?)` | `core_run_commands.rs:3750` | 移动端允许 |
| `core_deny_tool(runId, toolCallId, reason?)` | `core_run_commands.rs:3777` | 移动端拒绝 |
| `approval-requested` / `approval-resolved` 事件流 | `events.rs:479-495` | 实时同步 |
| 白名单写入（`addCommandPermission` 等价桥接） | 桌面端 store（`useAgentToolApproval.ts:66-74`） | 记住命令 |

### 12.2 新增（本期提案，需引擎/桥评审）

| 接口 | 方向 | 契约草案 | 用途 |
|---|---|---|---|
| `mobile_list_pending_approvals` | 移动端 → 桌面桥 → 引擎 | 返回：`[{ request: PermissionRequest, runId, requestedAt, expiresAt, runStatus }]`；语义：events 表 `approval-requested` 且无配对 `approval-resolved` 且 run 未终态 | 启动对账（§4.1） |
| `mobile_approval_sync_state`（可并入上者） | 同上 | 返回上次 `sequence` 水位之后的审批事件增量 | 历史补拉/事件错过兜底 |
| 推送桥事件订阅 | 桌面桥 ← 引擎事件桥 | 过滤 `approval-requested`（`arbiter=user` 且非自动放行）与 `approval-resolved` | §6 |
| `device_presence_query`（安全域接口） | 移动端 → 桌面桥 → 引擎 | 返回桌面端在线状态 + 最近交互时间 | 双因素（§9.2） |

### 12.3 错误映射（移动端）

| 服务端信号 | 移动端文案 |
|---|---|
| `NotFound`（toolCallId 不在待审批集合） | 「该请求已被其他设备处理或已过期」 |
| `InvalidInput`（approve 的 decision 非 approved——客户端 bug 防护） | 「请求无效，请更新应用后重试」 |
| 网络错误 / 超时 | 「决策未送达，将自动重试」 |
| 引擎 `approval.timeout` / `approval.rejected` 域（`error.rs:150-152` 佐证） | 按具体码映射「已过期」/「已拒绝」 |

---

## 13. 测试点

### 13.1 引擎侧单元（新增，随引擎改动）

| 编号 | 场景 | 断言 |
|---|---|---|
| T1 | `mobile_list_pending_approvals`：双发去重后返回未决清单 | 同 `toolCallId` 只出现一次；已 resolve 的不出现 |
| T2 | 超时后查询接口行为（引擎侧是否标记 expired——取决于 §14 提案取舍） | 明确契约 |
| T3 | 并发 `core_approve_tool` 两次同一 `toolCallId` | 一次 ok、一次 `NotFound` |

### 13.2 移动端集成/端到端（mock 桌面桥）

| 编号 | 场景 | 验收 |
|---|---|---|
| E2E-1 | 全链路：mock 引擎发 `approval-requested` → 推送桥 → 移动端通知 → 深链 → 详情 → 允许 → `approval-resolved` 广播 → 待办移除 + 历史新增 | 每步 ≤ 约定时限（推送→通知 ≤1s；决策→反馈 ≤500ms） |
| E2E-2 | 3 秒决策路径：L1 单击允许全流程计时 | 点按 ≤3 次、总时长 ≤3s（首屏不滚动） |
| E2E-3 | L2 滑动确认：滑 50% 松手回弹、滑 75% 触发 | 半途松开不提交 |
| E2E-4 | 超时：注入 120s 倒计时（测试可加速），到期置 expired；过期后点允许 | 收到 `NotFound` 冲突态文案；不产生 `approval-resolved(approved)` |
| E2E-5 | 冲突：桌面先允许，移动端后发送 | 移动端冲突态 + 对账展示真实结果 |
| E2E-6 | 离线：断网启动 → 本地缓存待办可见；决策入队 → 恢复网络 → 补发成功 | 补发后状态与引擎一致 |
| E2E-7 | 批量：10 条 L1 + 2 条 L2 多选 | 批量允许仅覆盖 L1；L2 逐条滑动；部分失败可重试 |
| E2E-8 | 双因素开启：桌面不在场 → L2 允许置灰、拒绝可用；桌面在场 → 正常 | 策略不误伤拒绝 |
| E2E-9 | 白名单「记住」：允许时勾选 → 桌面端后续同类请求自动放行（且极危命令仍弹审批） | 与 `shouldAutoApproveCommand` 硬拒绝门禁一致 |
| E2E-10 | 事件双发幂等：实时预览 + 收口流各发一次 | 待办只出现一次 |
| E2E-11 | 子代理请求（`arbiter=main-agent`） | 只读卡片，无决策按钮；reason 正确展示 |
| E2E-12 | 深链过期：通知已到但 120s 后才点击 | 打开即「已过期」状态页，不空白 |

### 13.3 手工体验检查

| 检查项 | 方法 |
|---|---|
| 误触防护 | 真机高频连点允许/拒绝区域 20 次，无重复决策；L2 无法点按触发 |
| 锁定到解锁全程 | 推送 → 生物识别 → 直达详情，不得回首页 |
| 断网补发 | 飞行模式决策 → 恢复网络 → 状态收敛 |
| 双设备并发 | 桌面 + 手机同时点允许，服务端只落一次 resolved |
| 空态/异常态文案 | 无待办、会话已删除、run 已结束等 |

### 13.4 性能指标

| 指标 | 目标 |
|---|---|
| 推送到达 → 系统通知展示 | ≤ 1s（高优先级通道） |
| 通知点击 → 详情首屏（含参数摘要） | ≤ 1.5s |
| 决策提交 → 反馈 | ≤ 500ms（乐观更新即时 + 回执异步） |
| 待办列表 100 条滚动 | 60fps |

---

## 14. 风险与开放问题

| 编号 | 风险/问题 | 影响 | 建议 |
|---|---|---|---|
| R1 | 超时（120s）不广播 `approval-resolved(expired)`，多端过期状态靠本地计时（`core_run_commands.rs:339-342`、`3767/3793`） | 双端过期判定可能差几秒；历史事件不全 | 引擎提案：超时统一落 `approval-resolved(expired)` 事件（需评审对 run 收口/审计影响）；落地前移动端本地倒计时兜底（本方案已按此设计） |
| R2 | `mobile_list_pending_approvals` 的对账口径依赖「run 未终态」判定，子代理 run 终态语义复杂 | 对账可能误收已终态请求 | 对账口径与引擎 run 状态机联合定义，纳入引擎评审；移动端以「决策后 NotFound」为最终兜底 |
| R3 | 推送载荷含参数可能泄露敏感命令内容（4096B 上限下参数摘要化） | 隐私/合规 | 推送 data 只带摘要与深链，完整参数在详情页对账后拉取；敏感参数默认脱敏展示 |
| R4 | 双因素「桌面在场」信号源（心跳）尚无引擎侧实现 | 双因素不可用 | 列为安全域 P1；本方案定义接口契约（§12.2），实现前功能置灰 |
| R5 | 120 秒时效与推送到达率（系统省电/免打扰）冲突 | 用户错过审批 | 通知高优先级 + TTL 60s + 待办常驻（对账兜底，过期也有历史）；评估「过期后提醒 Agent 已错过」的桌面端提示（后续迭代） |
| R6 | 批量允许的误放行风险 | 安全 | 已排除 L2 与临期条目（§5.4）；上线后按批量操作审计日志评估是否需要二次确认层 |
| R7 | 移动端与桌面「记住」白名单并发写 | 幂等 | 白名单为集合语义，天然幂等（§11.2）；审计日志记录写入渠道 |

---

## 15. 验收标准

1. **生命周期正确**：任一 ask 模式审批请求在桌面端发起后，移动端待办列表 ≤ 2s 出现（实时通道），决策后 ≤ 1s 移除并写入历史；事件双发、多端并发不产生重复/错乱（§11）。
2. **决策对等**：同一请求在移动端与桌面端的决策集合、引擎产物（`approval-resolved` 载荷、run 状态机转移）完全一致；移动端无任何额外决策限制（§10）。
3. **快**：推送到达即通知，点击到决策 ≤ 3 秒、点按 ≤ 3 次（§9.1 指标通过 13.2/13.4）。
4. **安全**：L2 必须滑动确认；双因素开启后 L2 允许受桌面在场约束；批量允许不覆盖 L2；「记住」继承极危硬拒绝门禁（§5.3/§5.4/§9.2/§10.2）。
5. **离线不丢**：app 被杀、断网、超时三种离线场景下，待办与决策不丢失、不静默失败，均有可解释状态（§8）。
6. **冲突可解释**：桌面已处理/双端并发/过期后决策三类冲突均给出明确文案并收敛到引擎真值（§11.2）。
7. **回归门禁**：移动端实现不触碰桌面端既有 5 个 markdown-editor 专项 spec 与引擎审批测试；引擎侧改动（若有，如 expired 事件）须跑通 `cargo test --workspace` 与桌面端审批相关前端门禁。
