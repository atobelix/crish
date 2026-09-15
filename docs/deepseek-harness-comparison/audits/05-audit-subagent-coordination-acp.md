# Conex (Crish) vs DeepSeek Harness (DSH) 代码级深度审计报告
## 主题：多 Agent 协同体系、死锁防范与协议生态 (ACP/LSP)

> **审计基准**：严禁参考任何设计文档、说明文本或宣称口径，纯基于 Rust 与 TypeScript 底层源码进行静态架构逆向与运行时时序分析。
> **代码版本锚点**：
> - Conex 侧：`crates/session-loop/src/approval_router.rs`、`crates/session-loop/src/approval.rs`、`crates/agent-tools/src/write_paths.rs`（含 `write_paths_state.rs`, `write_paths_validate.rs`）、`crates/orchestrator/src/lib.rs`（含 `flow_graph_model.rs`, `flow_graph_scheduler.rs`, `flow_graph_advance.rs`, `lifecycle.rs`, `session.rs`）及根目录 `AGENTS.md` 调度铁律。
> - DSH 侧：`packages/subagent/subagent/src/index.ts`、`packages/subagent/subagent/src/child-agent.ts`、`packages/subagent/subagent/src/continuation.ts`、`packages/subagent/subagent/src/continuation-messages.ts`、`packages/subagent/subagent-acp/src/index.ts`、`packages/experimental/agent-team/src/`（含 `index.ts`, `roster.ts`, `mailbox.ts`, `task-board.ts`, `task-graph.ts`）、`packages/acp/acp/src/index.ts`、`packages/acp/acp/src/session.ts`、`packages/lsp/lsp/src/index.ts`、`packages/lsp/lsp-stdio/src/instance.ts`、`packages/lsp/tool-lsp/src/index.ts`、`packages/lsp/tool-lsp/src/render.ts`。

---

## 一、审计综述与裁决总表

在多智能体系统（Multi-Agent Systems）、并发安全、死锁防御以及开发者协议生态四个核心维度上，Conex 与 DeepSeek Harness (DSH) 分别展现出了截然不同的架构侧重点与工程权衡：

1. **Conex 展现出「操作系统级内核（OS Kernel-like）」的强控制与抗踩踏哲学**：
   - 其多 Agent 协作由底层**确定性有向无环图（DAG）调度器**统一驱动，具备 Staged-Clone DFS 环检测、波次串行约束与确定性失败流转（Skip/Block/Report）；
   - 在并发互斥上，创造性地建立了**引擎级写路径注册表（`WritePathRegistry`）**，具备前缀级 Overlaps 原子互斥锁、RAII 作用域自动析构、TTL 防悬挂扫除与 Run 级硬白名单沙箱；
   - 在死锁预防上，针对经典的“父 Agent 等待子 Agent 终态、子 Agent 触发工具权限审批等待裁决”的死锁环，设计了**动态守卫路由（`route_approval_guarded`）**，在检测到父 Agent 处于等待阻塞时，自动将裁决权由父 Agent 分流跃迁至用户 UI 侧，配合 120s 非致命超时机制，以精确的动态破圈化解死锁；
   - 配合严格的调度铁律（单层深度 `max_depth=1`、主 Agent 排他性 Git 提交权、探索类文档配额硬控制），确保多 Agent 并行运行时工作区不会被破坏。

2. **DSH 展现出「现代微内核服务总线（Cordis Seam & Open Protocols）」的高生态互操作性**：
   - 依托 Cordis 插件架构，在标准化协议上展现出碾压性优势：拥有完整的 **Agent Client Protocol (ACP)** 服务端与可挂载异构进程的 ACP 子代理 Provider，并实现了业界一流的 **Language Server Protocol (LSP)** 三层瞬态代码智能客户端，使 LLM 具备精准的跨文件符号跳转、引用查找与悬停解析能力；
   - 在协同交互上，构建了 One-shot 与 Continuable 双轨子代理体系，并实验性探索了包含团队花名册（Roster）、成员邮箱通信（Mailbox）与任务看板（TaskBoard）的分布式 Agent 协作机制；
   - **但在核心并发安全与死锁治理上存在严重的工程退避**：面对父子等待审批死锁，DSH 采取了“一刀切”的懒惰方案——**硬编码将子代理权限直接写死为 `approvalPolicy: 'never'`**，并向模型注入“审批类操作直接自动拒绝”的禁令，彻底阉割了子代理的动态提权能力；其主干多 Agent 并发写入完全缺乏文件互斥锁（实验性看板中的 writeScopes 仅为无强制力的 Advisory 文本警告），在并行写场景下存在直接的数据竞态（Race Condition）风险。

### 综合架构对标评分表 (满分 10 分)

| 审计对标维度 | Conex (Crish) | DeepSeek Harness (DSH) | 裁决方与关键源码依据 |
| :--- | :---: | :---: | :--- |
| **多 Agent 编排拓扑** | **9.4** | **7.6** | **Conex 胜出**。Conex 拥有完备的 DAG 调度模型、Staged-Clone DFS 环检测、波次串行约束与增量脏集不动点推进；DSH 主干为单向亲子树，实验性 Agent Team 刚起步且依赖轮询事务。 |
| **死锁防范与权限流转** | **9.6** | **3.5** | **Conex 绝对胜出**。Conex 实现了 `route_approval_guarded` 动态用户分流与非致命超时兜底，真实化解父子等待死锁；DSH 采用退避策略，子代理强制 `approvalPolicy='never'`，直接废弃动态审批机制。 |
| **文件并发互斥与沙箱** | **9.2** | **3.0** | **Conex 绝对胜出**。Conex 具备原子锁、RAII 析构、TTL 扫除的 `WritePathRegistry` 及运行级沙箱；DSH 主干多 Agent 共享 cwd 无任何写互斥锁，实验性 writeScopes 仅为弱提示。 |
| **ACP 协议生态规范** | **0.0** | **9.6** | **DSH 绝对胜出**。DSH 具备完备的 ACP stdio 服务端与跨进程子代理接入能力，支持双向权限桥接；Conex 局限于私有 Tauri/WS 协议，完全缺失 ACP 支持。 |
| **LSP 代码智能与导航** | **0.0** | **9.2** | **DSH 绝对胜出**。DSH 具备三层解耦的 LSP 客户端，支持瞬态 didOpen/didClose 生命周期、进程池与模型防溢出截断；Conex 完全无 LSP 基础设施，依赖纯文本 grep。 |
| **生命周期恢复与容错** | **8.8** | **7.5** | **Conex 胜出**。Conex 拥有 L3 级强制终止（`ForceCancelSink`）、三态上下文继承（Verbatim/Summarized/New）的 Fork 恢复机制与 Episode 预算控制；DSH 依赖冷启动与 Session 抛错。 |

---

## 二、多 Agent 编排模型与调度拓扑对比

### 2.1 Conex：确定性 DAG 依赖图与内核调度器

Conex 的多 Agent 协同体系构建在 `crates/orchestrator` 与 `crates/session-loop` 之上，其核心不是简单的“派发-等待”，而是一个高度结构化的**确定性任务图执行引擎**。

#### 1. 声明式节点与 Staged-Clone 环检测
在 `crates/orchestrator/src/flow_graph_model.rs:52-91` 中，Conex 定义了图声明模型 `FlowDeclaration` 与节点结构 `FlowNode`：
- **节点属性**：包含 `id`、`task`（子代理目标）、`depends_on: Vec<FlowNodeId>`（前置依赖列表）、`parallel: bool`（同级并发开关）、`on_failed: Option<FailStrategy>`（失败策略）与 `is_composite: bool`（合成/门禁节点）。
- **Staged-Clone（暂存克隆）无损环检测**（`flow_graph_model.rs:228-261`）：
  当调用 `add_dependency(node, after)` 动态加边时，Conex 杜绝了直接在运行态图上变异的做法：
  ```rust
  // crates/orchestrator/src/flow_graph_model.rs:239-260
  let mut staged = self.clone(); // 先克隆候选图
  // ... 校验目标存在性并向 staged 插入边 ...
  staged.validate()?; // 执行包含 DFS 环检测的全量校验
  *self = staged;     // 仅在完全合法时原子替换 self，若有环则错误返回且图状态零污染
  ```
- **三色标记深度优先环提取**（`flow_graph_model.rs:265-324`）：
  使用 `color: Vec<u8>`（`0=未访问, 1=当前栈中, 2=已完成`）。一旦遍历命中 `color[j] == 1`（回边），立即从递归追踪栈中精准截取成环路径（例如 `["a", "b", "c", "a"]`），封装为结构化错误 `FlowGraphError::Cycle`，使编排者能够直接定位死锁依赖环。

#### 2. 批次级同级串行约束 (Batch-Level Parallel Constraint)
在实际工程中，同一波次被触发的任务如果不加约束同时启动，极易造成显存或系统资源耗尽。Conex 在 `crates/orchestrator/src/flow_graph_advance.rs:409-450` 实现了精确的串行化门禁：
- 节点就绪判定 `is_ready(node)` 不仅要求所有 `depends_on` 节点全部完成（或被失败策略放行），还必须通过 `serial_predecessor_pending(node)` 检查：
  ```rust
  // crates/orchestrator/src/flow_graph_advance.rs:430-446
  fn serial_predecessor_pending(&self, node: &FlowNode) -> bool {
      if node.parallel {
          return false; // 显式声明 parallel: true 者豁免，直接并发
      }
      let Some(graph) = self.graph.as_ref() else { return false; };
      graph.nodes().iter().take_while(|n| n.id != node.id).any(|n| {
          n.depends_on == node.depends_on // 同一波次（前置依赖集完全相同）
              && !n.parallel              // 同样未开启并发
              && !self.serial_predecessor_satisfied(n) // 且声明序在前的兄弟尚未终态
      })
  }
  ```
  **深度解析**：这一机制确保了即使提示词一次性给出了多个同一波次的任务，只要没有显式标记 `parallel: true`，引擎就会**严格按照声明顺序一个接一个地串行执行**，既保证了时序确定性，又避免了同级节点的隐式资源竞争。

#### 3. 增量脏集不动点调度与合成唤醒
在 `crates/orchestrator/src/flow_graph_advance.rs:103-294` 中：
- **增量脏集（Incremental Dirty-Set）**：调度推进并不每轮对整图进行 $O(N)$ 扫描，而是由 `dirty_set: HashSet<FlowNodeId>` 跟踪状态变化所波及的后继节点。
- **声明序索引缓存（CachedDeclarationOrder）**（`flow_graph_advance.rs:30-93`）：采用全局静态缓存，同会话在图结构未变时直接复用 `Arc<HashMap<FlowNodeId, usize>>`，消除了高频推进过程中的堆内存分配。
- **有界收敛防死循环**：循环迭代次数被强制限制在 `iteration > graph.len() + 2`，为 Block 传递阻塞与最终收敛留出确定余量。
- **合成节点事件驱动（FlowWakeup）**：标记为 `is_composite: true` 的节点（如质量门禁、审查节点）就绪时，调度器自动产出 `FlowWakeup` 事件，以事件驱动方式合成唤醒主 Agent，**全流程杜绝死轮询（Zero-Polling）**。

#### 4. 并发预算池与单层深度铁律
- **预算记账模型**（`flow_graph_scheduler.rs:29-84`）：`ConcurrencyBudget` 记录 `reserved`（累计分配）与 `released`（累计释放），计算实时在途负载 `in_flight = reserved - released`。
- **递归守卫与单层深度**（`flow_graph_advance.rs:180-190` 及 `AGENTS.md`）：
  启动子节点前必须通过 `check_recursion_guard` 校验快照，强行锁定 `depth: 1`。主 Agent 深度为 0，子 Agent 深度固定为 1。子 Agent 运行环境中直接从工具注册表剔除 `run_subagent`。彻底封死级联派发，从根源上杜绝了无限递归和树形分支爆炸。

---

### 2.2 DSH：亲子延续拓扑与实验性团队协作

DSH 的多 Agent 机制由 `@deepseek-ai/dsh-subagent` 及其扩展包实现，其核心源码位于 `packages/subagent/subagent/src/index.ts`、`child-agent.ts`、`continuation.ts` 以及 `packages/experimental/agent-team/src/`。

#### 1. One-shot 与 Continuable 双轨子代理体系
DSH 将子代理区分为两种生命周期形态（`packages/subagent/subagent/src/index.ts`）：
- **One-shot 单次运行**（`index.ts:551-563`）：通过 `SubagentRuntime.start` 启动，由 Provider（如进程内、Fork、ACP 等）负责创建、运行并等待结算，返回单次的 `SubagentRun` 与结果结构 `SubagentResult`（含 `output`, `stopReason`）。
- **Continuable 持续会话**（`index.ts:225-227` 与 `continuation.ts:101-187`）：
  子代理拥有独立的持久化 Session，由 `SubagentContinuationManager` 与 `ContinuableActivationRegistry` 直接持有 `AgentHandle`。子代理完成一个回合后不销毁，保持驻留状态（Resident Activation），等待后续消息唤醒。

#### 2. 严格邻接点消息路由机制 (Adjacent-Agent Routing)
在 `packages/subagent/subagent/src/continuation.ts:199-229` 的 `sendMessage` 中：
```typescript
// packages/subagent/subagent/src/continuation.ts:205-228
if (this.ctx.agents.get(sender.id) !== sender) {
  throw new SubagentError('message delivery requires the exact live sender agent', 'UNAUTHORIZED')
}
this.activations.assertAdmitting(sender)
const senderActivation = this.activations.get(sender.id)
if (senderActivation !== undefined
  && senderActivation.handle.agent === sender
  && senderActivation.parentSession === targetId) {
  options.signal.throwIfAborted()
  return this.sendToParent(senderActivation, sender, content) // 子 -> 父
}
if (sender.session.header.parentSession === targetId) {
  throw new SubagentError(`agent "${sender.id}" is not a resident continuable child...`, 'UNAUTHORIZED')
}
return this.deliverToChild(sender, targetId, content, { ... }) // 父 -> 子
```
**拓扑约束**：DSH 强制规定消息只能在**直接相邻的亲子节点**之间流动。子代理只被允许向 `parentSession` 发信；父代理只被允许向直接子代理发信。**兄弟子代理之间完全无法直接通信**，若要协作必须由父代理在中间充当中继转述。
- **结案通告（Settlement Message）**（`continuation-messages.ts:135-155`）：当持续子代理退出或由于异常（`completed`, `aborted`, `error`, `refusal`, `max-tokens`）终态退出时，运行时会自动向父代理收件箱合成一条 `subagent-settled` 类型的通知，确保父代理知晓子代理的终止原因。

#### 3. 动态冷启动恢复 (Cold Resume)
当父代理向一个已从内存释放的持续子代理发送消息时，`continuation.ts:399-449` 会触发 `coldResume`：
- 从持久化日志查询会话历史观察值 `SessionObservation`；
- 通过 `foldSubagentDescriptor` 纯函数折叠出历史元数据快照（包括 Provider、模型、Persona 及工具过滤器）；
- 重新调用 `materialize` 还原 AgentHandle，将新消息注入其收件箱重新拉起运行。

#### 4. 实验性团队协作体系 (`@deepseek-ai/dsh-agent-team`)
在 `packages/experimental/agent-team/src/` 中，DSH 正在孵化更高自由度的多 Agent 协作范式：
- **花名册与邮箱（Roster & Mailbox）**（`roster.ts`, `mailbox.ts`）：
  定义了 `TeamLead` 与 `Teammate` 角色。通过 `TeamMailbox.send`，打破了主干子代理必须亲子中继的限制，允许团队成员之间通过消息队列按名称（`targetName`）投递点对点消息。
- **任务看板与依赖图（TaskBoard & TaskGraph）**（`task-board.ts`, `task-graph.ts`）：
  实现了类似 Jira/看板的协作机制。每个任务（`TeamTaskSnapshot`）包含状态（`pending`, `in_progress`, `completed`, `deleted`）、所有者（`ownerId`）与阻塞依赖列表（`blockedBy: TeamTaskId[]`）。
- **任务成环检测**：在 `task-graph.ts:26-69` 的 `assertTaskGraphCandidate` 中，使用 DFS 遍历检测任务依赖环，一旦成环抛出 `TeamTaskGraphError('cycle')`。

---

## 三、权限继承、写互斥与死锁防护机制深度审计

在多 Agent 执行体系中，权限申请阻塞与文件系统写并发是系统崩溃与死锁的两大高发源头。本节对双方的代码级实现进行穿透剖析。

### 3.1 权限申请死锁场景剖析与解决之道

#### 1. 经典死锁时序（Waiting-on-Approval Deadlock）
在父子 Agent 协作中，存在一个经典的确定性死锁闭环：
```text
主 Agent Run (A)                             子 Agent Run (B)
────────────────                             ────────────────
调用 wait_subagents(B) 阻塞等待子代理终态
                                             执行特权工具触发 NeedsApproval
                                             向仲裁者申请裁决并阻塞等待结果
[主 Agent 被 wait 挂起，无法处理裁决请求]    [子 Agent 被审批挂起，无法达到终态]
                          【致命死锁：双方无限空等】
```

#### 2. Conex 的破圈方案：动态守卫分流与非致命超时
Conex 在 `crates/session-loop/src/approval_router.rs` 实现了三层权限传递与破圈机制：
1. **来源分类与默认路由**（`approval_router.rs:88-105`）：
   - `classify_source(run_id, parent_run_id)`：父 run 为空或无父 run 则归类为 `MainAgent`（裁决者路由至用户 `Arbiter::User`）；有父 run 则归类为 `Subagent`（裁决者默认路由为主 Agent `Arbiter::MainAgent`）。
2. **死锁检测与动态越级转用户（破圈核心）**：
   在 `crates/session-loop/src/approval_router.rs:112-118`：
   ```rust
   pub fn route_approval_guarded(source: &ApprovalSource, arbiter_waiting: bool) -> Arbiter {
       match source {
           ApprovalSource::MainAgent => Arbiter::User,
           // 关键断言：裁决者（主 Agent）当前正在 wait 阻塞等待该子 Agent！
           ApprovalSource::Subagent { .. } if arbiter_waiting => Arbiter::User,
           // 主 Agent 未处于 wait 状态，正常由主 Agent 裁决
           ApprovalSource::Subagent { .. } => Arbiter::MainAgent,
       }
   }
   ```
   **时序穿透**：当引擎调度器注入的 `arbiter_waiting` 信号为 `true` 时，路由层立即识破死锁风险，**果断绕过主 Agent，直接将审批请求越级转向用户（`Arbiter::User`）**。由于用户 UI 裁决通道独立于引擎主循环，用户可以直接在界面上点击批准或拒绝，从而瞬间打破 120 秒死等僵局！
3. **通道侧两阶段防死锁与非致命超时**：
   在 `crates/session-loop/src/approval.rs:114-185` 中：
   - **先发后等（Publish-Before-Wait）**：第 1 步先向事件流广播 `ToolEvent::ApprovalRequested`，然后才进入 `gate.request_approval` 等待，防止等待前广播丢失造成事件流不一致。
   - **超时收口与永不致命（Never-Fatal）**：若 120s 超时仍未裁决，通道触发 `ApprovalDecision::Expired`，记录 `ToolEvent::ApprovalResolved { decision: Expired }`。更关键的是，在错误系统定义中，审批超时错误 `ToolErrorKind::ApprovalExpired` 被标注为 `is_never_fatal`，子代理工具调用失败但**会话绝对不崩溃**。
   - **双向拒绝指引**：若主 Agent 显式拒绝，`relay_denied_message`（`approval_router.rs:158-164`）会自动生成双向回报指引文本，引导子 Agent 向主 Agent 报告替代方案并重试。

#### 3. DSH 的退避策略：硬编码锁死与自动拒绝
相比之下，DSH 在代码实现层面采取了**近乎粗暴的彻底退避**：
在 `packages/subagent/subagent/src/child-agent.ts:242-247`：
```typescript
// packages/subagent/subagent/src/child-agent.ts:242-247
export function captureDelegatedPolicyOverrides(parent: Agent): DelegatedPolicyOverrides {
  return {
    sandboxMode: parent.ctx.get('sandboxPolicy')?.overrideOf(parent.session),
    approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'never',
  }
}
```
并且在 `child-agent.ts:171-176` 中无条件向所有子代理硬编码注入系统提示：
```typescript
export const SUBAGENT_DELEGATION_CONTEXT
  = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be '
    + 'widened from inside this session — operations that require approval are rejected automatically. '
    + 'When the task needs access beyond that scope, do not retry the denied operation; state the '
    + 'limitation in your reply so the delegating agent can handle it.'
```
而在其 ACP 子代理后端 `packages/subagent/subagent-acp/src/index.ts:43-47` 中：
```typescript
/**
 * How to auto-answer the child's `session/request_permission` prompts:
 * `reject` (default — decline every prompt) or `allow` (approve via the first
 * `allow_once` or `allow_always` option). No prompt is surfaced to a human.
 */
permission: PermissionPolicy
```
**严重缺陷批判**：
- DSH 只要装配了 `approval` 服务，就会在子代理启动阶段**将 `approvalPolicy` 无条件钉死为 `'never'`**！
- 子代理在运行过程中一旦调用任何需要审批的敏感工具，底层权限拦截器**直接机械式拒绝（rejected automatically）**。
- 在 `subagent-acp` 中，子代理面临审批时默认全自动拒绝，配置为 `allow` 时则全自动放行，**明确注释“绝不上报给人类（No prompt is surfaced to a human）”**。
- **结论**：DSH 根本没有去解决“等待-审批死锁”这一分布式难题，而是通过**剥夺子代理的一切动态提权与人工审批交互权利**来消极避开死锁。这导致 DSH 的子代理在遇到任何权限边界时，无法向父代理或人类求助，任务直接受阻失败。

---

### 3.2 文件写互斥与运行级沙箱

当多个子 Agent 在同一个项目工作区并发读写代码时，缺乏写互斥必然引发文件内容覆盖与损坏。

#### 1. Conex：WritePathRegistry 原子互斥与白名单沙箱
Conex 在 `crates/agent-tools/src/write_paths.rs`（及 `write_paths_state.rs`、`write_paths_validate.rs`）构建了工业级的写路径并发控制：
1. **运行级硬沙箱（WritePathPolicy）**：
   在 `write_paths_validate.rs:26-33` 与 `108-124`：
   子代理在派发时被装配 `WritePathPolicy::Allowed(Vec<PathBuf>)` 白名单策略。工具在执行物理写入前，首先经 `check_write_allowance` 校验目标路径是否落在允许的前缀集合内。一旦越界，直接拦截并抛出确定性不可重试错误 `codes::TOOL_WRITE_NOT_ALLOWED`。
2. **原子化路径重叠互斥（Atomic Overlap Claiming）**：
   在 `write_paths_state.rs:177-228` 的 `registry.claim` 中：
   - 写入前调用 `registry.claim(holder, paths, mode)`。
   - **锁区间原子性**：在互斥锁保护下（`let mut inner = lock_inner(&self.inner);`），同时完成冲突检测与声明插入，从根源杜绝了检查后至插入前被其他 Agent 抢占的 **TOCTOU（Time-of-Check to Time-of-Use）竞争漏洞**。
   - **组件级前缀比较（Overlaps）**：基于 `paths_overlap_normalized`，不仅比较全等路径，还检测目录与子文件重叠（`a/b/c.txt` 与 `a/b/` 判定为冲突，但 `a/b` 与 `a/bc` 判定为不冲突）。
   - **同持有者豁免与续期**：同一 holder 重复声明相同路径或扩展子路径不会引发自身冲突，而是自动去重并刷新过期时间。
   - **结构化冲突报错**：若被其他 Agent 占用，立即返回 `WritePathConflict`，详细载明冲突路径、当前占用者、所属会话及占用有效期。
3. **RAII 守卫自动释放与 TTL 清扫**：
   - `WriteClaimGuard`（`write_paths_state.rs:106-115`）实现了 `Drop` trait。当工具执行完毕、发生错误或遇到 panic 时，守卫析构自动调用 `self.registry.release_holder(&self.holder)`，释放名下全部路径。
   - 兜底保底机制：设置 `DEFAULT_CLAIM_TTL_MS = 60_000`（60秒），每次新声明前自动调用 `expire_stale()`，清扫因异常进程崩溃导致的悬挂锁。

#### 2. DSH：主干写锁完全缺失与实验性弱提示
- **主干子代理体系的写并发真空**：
  查阅 DSH 主干的 `packages/subagent/` 及其底层工具实现，**完全不存在任何类似文件写锁或路径占用注册表的机制**。DSH 仅依赖静态的 `ToolRestriction`（禁用某些写工具）和只读的 `SandboxMode`。如果主 Agent 同时唤醒 5 个子 Agent 编辑同一源码目录，只要工具列表允许写入，多个子 Agent 可以肆无忌惮地同时覆写同一个文件，引发严重的数据竞争。
- **实验性看板中微弱的 Advisory 提示**：
  即使在实验性的 `@deepseek-ai/dsh-agent-team` 的 `task-board.ts:20-23` 与 `277-284` 中定义了 `scopesOverlap`：
  ```typescript
  // packages/experimental/agent-team/src/task-board.ts:277-284
  const warnings = new Set<string>()
  for (const other of state.tasks) {
    if (other.id === task.id || other.status !== 'in_progress') continue
    if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) {
      warnings.add(`write scopes overlap with ${other.id}`)
    }
  }
  return { ...taskView, writeScopeWarnings: [...warnings] }
  ```
  **深度揭露**：这一重叠检测**仅仅在任务视图对象中拼装了一个字符串警告数组（`writeScopeWarnings`）**！它纯粹是**建议性（Advisory）**的，根本没有联动到任何文件系统的实际拦截器上。任何 Teammate Agent 依然可以直接调用工具写入重叠文件，防护形同虚设。

---

### 3.3 多 Agent Git 提交纪律与版本控制

在复杂多 Agent 项目中，多个 Agent 并行执行 `git commit` 会迅速导致 Git Index 锁竞争与不可逆的历史混乱。

- **Conex 的主控排他性 Git 提交铁律（`AGENTS.md` §3）**：
  Conex 在协作纪律中明文规定了极度严密的 Git 操作规范：
  1. **提交权仅归主 Agent**：子 Agent 完成任务后只能把代码修改保留在工作区，由主 Agent 负责统一检查并调用 `git commit --only <paths>` 限定本次收口路径，严禁任何子 Agent 执行 commit、revert、reset 或 checkout；
  2. **绝对禁止回撤他人代码**：严禁执行 `reset --hard`，被他人提交吞并的改动仅通过 `git show HEAD:<path>` 做内容完整性比对，缺则追加，严禁回退重做；
  3. **产出隔离**：临时产出目录 `.agent-outputs/` 走专属垃圾回收（conex-fs trash），完全被 `.gitignore` 排除，与代码提交彻底解耦。
- **DSH 侧的状态**：
  DSH 的 Git 能力散落在常规工具实现中，缺乏多 Agent 维度的协作纪律控制与引擎级提交收口。

---

## 四、外部协议生态与标准化接口对比 (ACP 与 LSP)

如果在多 Agent 调度和并发互斥上 Conex 占据绝对技术优势，那么在标准化协议（ACP 与 LSP）与生态互通性上，DSH 则展现出了压倒性的领先地位。

### 4.1 ACP (Agent Client Protocol) 协议实现深度对比

ACP 正在成为智能体客户端通信的开放标准。DSH 在这方面投入了完整的工业级实现，而 Conex 目前在此领域完全为空白。

#### 1. DSH 的标准化 ACP 服务端 (`@deepseek-ai/dsh-acp`)
源码位于 `packages/acp/acp/src/index.ts` 与 `session.ts`，基于 `@agentclientprotocol/sdk` 构建：
- **JSON-RPC / NDJSON 规范传输**（`index.ts:373-393`）：
  默认挂载在 `process.stdin` / `process.stdout` 之上，通过 `ndJsonStream` 进行异步流式序列化，完全符合 ACP 传输标准。
- **标准化方法全量覆盖**：
  - `initialize`（`index.ts:176-190`）：协商版本号 `PROTOCOL_VERSION`，声明 `mcpCapabilities: { http: true }` 与 `sessionCapabilities: { close: {}, list: {}, resume: {} }`。
  - `session/new`（`index.ts:196-237`）：分配 UUID SessionId，挂载工作区路径（`params.cwd`），加载客户端指定的 MCP Servers，建立全新的独立代理。
  - `session/list`（`index.ts:292-331`）：实现了标准的分页查询，自研了基于 Base64URL 的安全不透明游标（`decodeSessionListCursor` 与 `encodeSessionListCursor`），支持跨物理目录的多会话检索。
  - `session/resume`（`index.ts:239-290`）：严格比对 `sameDirectory(header.cwd, params.cwd)`，确保工作区一致性，杜绝恢复错乱。
  - `session/prompt` 与 `cancel`（`index.ts:361-370`）：支持图文多模态输入注入与异步通知式取消。
- **双向权限映射桥梁 (Bidirectional Approval Bridging)**：
  在 `packages/acp/acp/src/index.ts:155-173` 中，DSH 实现了内部事件与 ACP 协议的完美融合：
  ```typescript
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    const callId = request.callId
    return record.drainUpdates().then(() => {
      const params: RequestPermissionRequest = {
        sessionId: record.agent.session.id,
        toolCall: { toolCallId: callId },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      }
      return conn.request(methods.client.session.requestPermission, params)
    }).then(({ outcome }) => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })
  ```
  当内部 Agent 触发敏感工具审批时，ACP 服务端将其拦截并封装为标准的 `session/requestPermission` 请求投递给对端客户端，待对端人类或网关决策后，将 `allow_once` 或 `reject_once` 还原为内部决策，实现了真正的跨宿主权限代理。

#### 2. DSH 的异构 ACP 子代理 Provider (`@deepseek-ai/dsh-subagent-acp`)
源码位于 `packages/subagent/subagent-acp/src/index.ts`：
- DSH 实现了 `AcpProvider implements SubagentProvider`。这意味着 DSH **不仅能被外部作为 ACP 智能体调用，还能将任何遵循 ACP 规范的外部第三方 Agent 进程派发为自己的子代理**！
- 通过子进程启动配置的 `command` 与 `args`，将父会话的 cwd 作为工作区传递给子进程，建立 stdio 连接，将其转化为一个完全透明的子代理。

#### 3. Conex 侧的严重生态技术债
- **零 ACP 支持**：在 Conex 的全部 Rust crates 中未发现任何 ACP 协议契约实现。
- Conex 目前完全依赖其私有的 WebSocket 路由（`apps/agent-workbench/src-tauri/src/server/`）与 Tauri IPC 通信，属于典型的“围墙花园”。它既无法被外部开源的 ACP 编排网关直接调用，也无法将外部开发的其他语言/框架编写的 Agent 作为子代理无缝集成进其 `FlowScheduler` 中。

---

### 4.2 LSP (Language Server Protocol) 客户端体系深度对比

代码级重构与代码审查依赖于对程序语法树（AST）和符号关系的精准洞察。DSH 在此领域展现出了专业级编辑器的技术积累。

#### 1. DSH 的三层解耦 LSP 客户端架构
DSH 将语言服务器协议封装为三个相互解耦的模块：
1. **服务注册与扩展名路由中心 (`@deepseek-ai/dsh-lsp`)**：
   - 源码：`packages/lsp/lsp/src/index.ts`。
   - `Lsp.registerProvider(provider)`：提供排他性注册。原子化检查文件扩展名（`.ts`, `.rs`, `.py` 等），若两个 Provider 尝试注册相同的扩展名，直接抛出 `LSP_CONFLICT`，保证路由映射的绝对确定性。
   - 统一接口：暴露 `goToDefinition`、`findReferences`、`goToImplementation` 与 `hover` 四类核心语义操作。
2. **Stdio 进程驱动与瞬态生命周期 (`@deepseek-ai/dsh-lsp-stdio`)**：
   - 源码：`packages/lsp/lsp-stdio/src/instance.ts`。
   - **串行化请求尾（Serialized Query Queue）**：
     在 `instance.ts:49` 与 `93-108`：`private queue: Promise<unknown> = Promise.resolve()`。所有发送给 Language Server 的请求严格按序排队，确保当上一个查询被取消或超时终止时，不会污染后续请求的通信管道。
   - **瞬态文档生命周期（Transient didOpen/didClose Lifecycle）**：
     在 `instance.ts:153-178`：
     ```typescript
     await this.connection.notify('textDocument/didOpen', {
       textDocument: { uri, languageId: request.languageId, version: 1, text: source.text },
     })
     opened = true
     const payload = await this.sendRequest(request.operation, uri, request.position, signal)
     return this.normalize(request.operation, payload)
     // finally 块中：
     if (opened && !this.dead) {
       await this.connection.notify('textDocument/didClose', { textDocument: { uri } })
     }
     ```
     **设计亮点**：DSH 不在内存中维系庞大且容易出 bug 的双向文档同步树，而是采用轻量级的“读源文件 -> didOpen -> 执行查询 -> didClose”瞬态模型。既充分利用了语言服务器在工作区内的索引缓存能力，又避免了编辑器级的状态同步累赘。
   - **连接池化**：按 `(providerId, canonicalWorkspaceUri)` 粒度池化管理长生命周期的 Language Server 子进程。
3. **面向模型的防溢出呈现工具 (`@deepseek-ai/dsh-tool-lsp`)**：
   - 源码：`packages/lsp/tool-lsp/src/index.ts` 与 `render.ts`。
   - 坐标标准化：在 `render.ts:46-59` 中自动将 LLM 常用的一基（1-based）行号/列号与协议标准的零基（0-based）UTF-16 坐标做双向精确映射。
   - **硬性防爆门禁（Result Capping）**：
     在 `render.ts:18-22` 与 `85-128`，强制设置 `DEFAULT_MAX_LOCATIONS = 100` 与 `DEFAULT_MAX_RESULT_CHARS = 16_000`。任何超量的大型符号引用搜索在渲染阶段被安全截断并附加省略提示，彻底防止 Language Server 吐出的数兆文本把 LLM 上下文撑爆。

#### 2. Conex 侧的代码智能缺失
- **零 LSP 资产**：Conex 没有任何语言服务器协议驱动包。
- Conex 的 Agent 在阅读、检索代码时，完全依赖常规的纯文本正则匹配（`grep_search`）和文件遍历（`find_by_name`）。在处理诸如“查找某个接口的全部多态实现”、“精确重命名类方法符号”、“精准跳转跨包定义”等深度编程任务时，无法获得编译器符号表的加持，容易被同名变量或注释文本误导，产生代码幻觉。

---

## 五、架构优劣、技术债务与具体破绽深度剖析

基于纯代码视角的穿透审计，双方各自的技术破绽与架构债务总结如下：

### 5.1 Conex 侧的技术破绽与债务

1. **协议生态极其孤立（无 ACP / 无 LSP）**：
   - 无法与外部标准 Agent 网关（如 Claude Code, OpenHands, 其它 ACP 客户端）互通；
   - 缺乏编译器级语义导航工具，对大型代码库的代码审查与协同重构能力受制于纯文本搜索。
2. **多 Agent 扁平化与通信隔绝**：
   - 为避免递归死锁，Conex 机械限制 `max_depth = 1`（主控深度 0，子代理深度 1），子代理工具注册表中硬剔除 `run_subagent`。这导致其无法派生出“架构师 -> 模块主管 -> 研发员”的深层自主层级体系；
   - 并发子代理之间完全缺乏类似 DSH Mailbox 的点对点通信管道，子代理在运行期无法交换中间上下文，只能等待任务结束由主控统一收口。
3. **FlowScheduler 的锁粒度与状态复杂性**：
   - `crates/orchestrator/src/flow_graph_advance.rs` 包含大量的状态维护（`states`, `runtime`, `budget`, `dirty_set`），虽然引入了 `CachedDeclarationOrder`，但状态推进仍涉及多处锁与持久化元数据同步，当任务节点规模急剧上升时，调度状态机的维护成本较高。

### 5.2 DSH 侧的技术破绽与债务

1. **死锁防御的严重退避：彻底阉割子代理提权**：
   - 在 `packages/subagent/subagent/src/child-agent.ts:245` 中将子代理审批策略直接钉死为 `approvalPolicy: 'never'`，并在提示词中要求模型对需要审批的操作“自动放弃，不要重试”。
   - 面对分布式系统中的父子审批死锁，DSH 选择了“消灭需求”而非“解决问题”，导致其子代理的自主权被大幅削弱，无法在受控权限下完成稍微敏感的运维或环境操作。
2. **文件系统写并发的裸奔状态（无硬互斥锁）**：
   - 主干子代理体系完全缺乏文件写锁，多个子代理并发执行写操作必然产生竞态；
   - 实验性看板中的 `scopesOverlap`（`task-board.ts:280`）只是拼装了无实际拦截力的文本告警，未与工具执行底层联动，存在明显的安全假象。
3. **Continuation 状态机的死循环与竞态风险**：
   - `packages/subagent/subagent/src/continuation.ts:293` 中的 `deliverFollowup` 包含了无延时的自旋式 `while(true)` 循环，在处理 `closing` 状态竞态时，一旦遇到复杂持久化延迟或死锁，极易将 Node.js 事件循环的主线程耗尽；
   - 对直接邻接通信的刻意限制（严禁跨节点发信）降低了复杂网状协作的效率。

---

## 六、综合裁决与演进建议

### 6.1 裁决结论

- **在多 Agent 协同鲁棒性、并发安全与死锁治理维度：Conex (Crish) 显著胜出**。
  Conex 拥有操作系统级的严密内省机制。其 DAG 调度器提供的 Staged-Clone 环检测、批次同级串行门禁、以及**破解父子等待死锁的动态用户守卫分流（`route_approval_guarded`）**，体现了极其深厚的分布式状态机掌控力。配合 `WritePathRegistry` 强行阻断文件覆写踩踏，Conex 在高并发执行中的可靠性远高于 DSH。
- **在标准化互联、外部协议生态与代码语义智能维度：DeepSeek Harness (DSH) 压倒性胜出**。
  DSH 深刻理解现代 AI 工程的开放性需求。其完整落地了标准的 ACP 协议双向桥接（可作为服务端被调用，亦可作为宿主挂载外部 ACP 子代理），并打造了极具工程参考价值的 LSP 三层瞬态语言服务器集成，在跨系统互操作性与静态代码语义分析能力上遥遥领先于封闭的 Conex。

### 6.2 针对 Conex 的落地重构建议

1. **引入 LSP 客户端工具栈（高优先级）**：
   - 借鉴 DSH 的 `dsh-lsp-stdio` 瞬态生命周期模式（`textDocument/didOpen` -> query -> `textDocument/didClose`），在 Rust 内核中借助 `lsp-types` crate 实现语言服务器进程池；
   - 封装出面向 Agent 的 `lsp_symbol` / `lsp_definition` 工具，并施加严格的行数与字符截断保护，一举解决 Conex 在代码重构场景下依赖纯文本 grep 的短板。
2. **接入标准 ACP 协议服务端（中优先级）**：
   - 在已有的 Tauri/WebSocket 外部，增设标准的 stdio/NDJSON ACP 服务端适配层，将 Conex 封装为一个开放的 ACP Agent；
   - 扩充 `crates/orchestrator`，允许像派发普通子代理一样，通过标准 ACP 协议派发外部的第三方 Agent 进程进入 DAG 调度网络。
3. **拓展多 Agent 运行期直接通信（中优先级）**：
   - 参考 DSH `agent-team` 的 `Mailbox` 理念，在不破坏 `max_depth=1` 防递归失控铁律的前提下，允许处于同一 DAG 拓扑且正在并发执行的兄弟子代理，通过命名消息信箱直接传递中间诊断数据，提升复杂多角色协同的敏捷度。
