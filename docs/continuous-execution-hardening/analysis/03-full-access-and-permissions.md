# 03 权限与完全访问深度审查报告：完全访问模式全链路贯通、子代理权限继承与红线安全底线

> **战役主题**：全天候自主 Agent 连续运行与健壮性改造战役 (Continuous Execution Hardening)  
> **审查维度**：03 - 权限与完全访问 (Full-Access Mode, Permission Propagation & Security Redline)  
> **责任模块**：
> - `crates/agent-tools/src/permission.rs`
> - `crates/agent-tools/src/context.rs`
> - `crates/conex-run/src/run/run_launch.rs`
> - `crates/conex-run/src/subagent_spawner/spawn.rs`
> - `crates/conex-run/src/workflow/launcher.rs`
> - `crates/conex-run/src/run/run_idle.rs`
> - `crates/session-loop/src/exec_verdict.rs`
> - `crates/session-loop/src/exec_single/pre_exec.rs`
> - `crates/agent-tools/src/tools/` (shell, fs, delete, note, subagent)  
> **产出路径**：`docs/continuous-execution-hardening/analysis/03-full-access-and-permissions.md`  
> **版本与安全属性**：Strictly Read-Only Analysis / UTF-8 无 BOM / 包含完整代码路径与行号证据

---

## 摘要与审查结论 (Executive Summary)

实现全天候自主连续运行（Unattended 24/7 Continuous Execution）的核心前提是：**用户赋予 Agent 的执行信任（如 Full-Access / 完全访问模式）能够在多 Agent 协同、自动化定时工作流、跨轮次状态机唤醒等整个生命周期中无缝透传并持续生效，同时系统必须对确定性毁灭级操作保有绝对不可逾越的红线（Redline）刚性防御**。

然而，对 Conex / Crish 现有权限系统与运行时派发全链路的深度代码审查揭示：**完全访问模式在系统多层调度枢纽处存在严重的断裂与硬编码遗漏，导致权限模式无法向下游传导，反而全盘跌入比常规 Ask 模式更严苛的假死阻塞陷阱；与此同时，红线拦截虽然坚挺，但其报错与反馈机制粗糙反常，对自主 Agent 构成了潜在的死循环干扰**。

核心审查发现总结如下：

1. **三处核心派发点硬编码 `permission_mode: None`，形成全链路权限“断崖”**：
   - **子代理派发（`subagent_spawner/spawn.rs:143`）**：主 Agent 派发子代理时，入参结构体未携带权限模式，启动选项硬编码 `permission_mode: None`。
   - **定时工作流（`workflow/launcher.rs:196`）**：后台定时任务（Scheduled Tasks / Crons）设计初衷是无人值守执行，但启动选项硬编码 `permission_mode: None`。
   - **空闲与事件唤醒（`run_idle.rs:1237`）**：在长程会话中，当一轮执行完成进入休眠，后续由子代理完成通知、定时器到期、跨 run 转向队列（Steering Queue）或看门狗唤醒并拉起续 run（`spawn_idle_resume_run`）时，启动选项硬编码 `permission_mode: None`。主 Agent 原本拥有的 `full-access` 模式在此瞬间被永久抹除！
2. **`None` 模式的级联放大机制：全面倒退为“全批刚性审批”并引发 120s 超时瘫痪**：
   - 在 `run_launch.rs:931` 中，`permission_mode: None` 导致审批门被启用（`approval_enabled = true`）。
   - 在 `exec_verdict.rs:141-143` 与 `167` 中，当 `options.permission_mode.is_none()` 且 `approval_enabled == true` 时，**系统并未回退到安全的 Ask 三态矩阵，而是执行了旧版 legacy 的“全量审批（Approval Required）”**：任何命令（包括只读的 `ls`、`git status`）以及任何工具调用，一律返回 `PermissionVerdict::NeedsApproval`！
   - 子代理、定时任务与自主续 run 往往运行在无人值守环境。请求被抛向 `approval_wait`，经历 120 秒无人应答后强制超时退化为 `ApprovalDecision::Expired` 并返回 `tool.approval_expired`，导致自主任务彻底挂起或终止。
3. **前端/引擎别名匹配存在单点失步脆弱性**：
   - `permission.rs` 维护了丰富的别名转换矩阵（支持 `full-access`、`full`、`yolo`、`danger` 等），但在 `run_launch.rs:931` 中却采用了死板的原始字面量浅比较：`let approval_enabled = permission_mode.as_deref() != Some("full-access");`。如果外部通过 `full` 或 `yolo` 传入，引擎内部的审批门仍会被错误启用！
4. **FullAccess 下各内置工具表现不一，存在潜在隐患**：
   - `shell` 工具在 FullAccess 下正常放行常规危险命令，且安全地保留了删除重定向（WAL 回收站）与绝对路径保护；但大面积 git 回退（C3 Revert Guard）在 FullAccess 下依然强制拒绝（由于审批门未启用，直接返回结构化阻断）。
   - `delete` 工具正确放行并走回收站，无弹窗阻断。
   - `note` 写入工具内部通过 `maybe_ask_note_write` 消费 `ctx.ask`（在 FullAccess 下绑定为 `NoopAskChannel`），可免审批通行；但暴露出在 Ask 模式下存在外层 `call_verdict` 与内层 `ask.ask` 双重审批的冗余架构缺陷。
   - `subagent` 工具自身可免审批派发，但派生出的子 Agent 却无法免审批运行，形成自相矛盾的体验。
5. **红线拦截（Redline）具备刚性但报错体验异常**：
   - 毁灭性操作（`rm -rf /`、磁盘格式化、设备写入、关机、Windows 核心目录抹除、反射执行等）在 `permission.rs`、`conex-sandbox` 与 `shell.rs` 中均实现了 100% 拦截，即便在 FullAccess 模式下也绝对 Deny。
   - 然而，当命中红线被拒时，`exec_verdict.rs:236` 生成的拒绝文案居然是：`"permission denied by full-access mode: shell"`！这种荒谬的错误文案极具误导性，未向 Agent 解释红线违规本质与替代方案，容易引发模型重试死循环。

---
## 一、全链路权限模式硬编码断层深度审查 (Hardcoded Permission Mode Disconnects)

### 1.1 全链路权限传递流程与断裂图谱

在正常会话发起路径中，前端通过 IPC 发起任务，携带 `permissionMode: "full-access"`。该参数应在整个生命周期内向所有衍生流程（子 Agent、定时任务、连续空闲唤醒）纵深传递。然而，审查发现系统在三个关键枢纽处硬编码了 `permission_mode: None`，导致下游执行环境发生断崖式降级：

```text
[用户发起任务] (permissionMode = "full-access")
       │
       ▼
[core_run_task / run_task_impl] (crates/conex-run/src/run/run_launch.rs:750)
       │ permission_mode = Some("full-access")
       │ approval_enabled = false
       │
       ├───────────────────────────────┬───────────────────────────────┐
       ▼                               ▼                               ▼
[分支 1: 子 Agent 派发]          [分支 2: 定时任务调度]          [分支 3: 空闲/事件续 run]
run_subagent 工具调用             workflow/launcher.rs            run_idle.rs: spawn_idle_resume_run
       │                               │                               │
       │ SubagentSpawnRequest          │ launch_scheduled_task         │ PendingQueue / Timer 到期
       │ 缺少 permission_mode 字段      │ 构造 RunTaskOptions           │ 构造 RunTaskOptions
       ▼                               ▼                               ▼
spawn.rs:143                    launcher.rs:196                 run_idle.rs:1237
permission_mode: None (硬编码!)   permission_mode: None (硬编码!)   permission_mode: None (硬编码!)
       │                               │                               │
       └───────────────────────────────┴───────────────────────────────┘
                                       │
                                       ▼
                       [新 run 启动: run_task_impl]
                       permission_mode = None
                                       │
                                       ▼
                       [run_launch.rs:931]
                       approval_enabled = true (非 "full-access" 均启用审批!)
                       approval_gate 挂载
                                       │
                                       ▼
                       [session-loop: exec_verdict.rs:141-143, 167]
                       options.permission_mode.is_none() 命中!
                       触发 legacy 全量审批逻辑 -> PermissionVerdict::NeedsApproval!
                                       │
                                       ▼
                       [pre_exec.rs:56-58]
                       handle_gated_needs_approval -> approval_wait(120s)
                                       │
                                       ▼ (无人值守，无人工响应)
                       120s 超时 -> ApprovalDecision::Expired
                       返回 tool.approval_expired -> 连续运行被迫中断!
```

---

### 1.2 源码证据与根因逐项剖析

#### 断裂点 1：子 Agent 派发管道（`subagent_spawner/spawn.rs`）

在主 Agent 运行在 `full-access` 模式下时，其派发的子 Agent 必须承载相应的任务并执行工具。然而：

1. **接口定义缺失**：
   在 `crates/agent-tools/src/tools/subagent/contract.rs` 与 `defs.rs` 中，`SubagentSpawnRequest` 定义了 `agent_id`、`prompt`、`role`、`capability_mode`、`task_type` 等字段，但**根本没有定义 `permission_mode` 字段**！
2. **工具层丢弃**：
   在 `crates/agent-tools/src/tools/subagent/tool.rs:307-420`（`RunSubagentTool::execute` 与 `execute_many`）中，执行环境持有的 `ctx: &ToolContext` 明确包含 `ctx.permission_mode`，但在组装 `SubagentSpawnRequest` 时无法传递，导致上下文在工具层直接截断。
3. **启动层硬编码 `None`**：
   在 `crates/conex-run/src/subagent_spawner/spawn.rs:137-145` 中：
   ```rust
   // crates/conex-run/src/subagent_spawner/spawn.rs:137-145
   let launch_options = RunTaskOptions {
       run_id: subagent_run_id.clone(),
       session_id: session_id.clone(),
       prompt: Some(req.prompt.clone()),
       mode: req.mode.clone().or_else(|| Some("research".to_string())),
       cwd: None,
       permission_mode: None, // <--- 致命漏洞：硬编码 None，丢失父 Agent 的 full-access
       client_message_id: None,
       assistant_client_message_id: None,
       system_prompt: None,
       history: None,
       context_window: None,
       parent_run_id: parent_run.clone(),
       subagent_config: Some(config),
       ...
   };
   ```
   **历史残留证据**：甚至在 `crates/conex-run/src/run/tests.rs:6549-6552` 的测试注释中都赫然记录着历史妥协代码痕迹：
   ```rust
   // 主 agent run 用 full-access：工具批不弹审批（permission_mode
   // None = 全批审批的既有语义；子代理 run 的权限面由 spawner 装配
   // None——full-access 不传导，测试聚焦子代理侧）
   permission_mode: Some("full-access".to_string()),
   ```
   该注释坐实了在早期重构中，子代理的权限传导被故意置空绕过，留下了这一严重系统缺陷。

#### 断裂点 2：定时工作流启动器（`workflow/launcher.rs`）

定时工作流（Cron / Scheduled Workflows）是无人值守连续运行的典型场景（例如凌晨 2 点自动同步代码并运行测试构建）。然而：

在 `crates/conex-run/src/workflow/launcher.rs:190-211` 中：
```rust
// crates/conex-run/src/workflow/launcher.rs:190-211
let options = crate::run::RunTaskOptions {
    run_id: ctx.run_id.clone(),
    session_id: effective_session_id.clone(),
    prompt: Some(ctx.prompt.clone()),
    mode: Some("scheduled".to_string()),
    cwd: effective_cwd,
    permission_mode: None, // <--- 致命漏洞：硬编码 None
    client_message_id: None,
    assistant_client_message_id: None,
    system_prompt: None,
    history: None,
    context_window: None,
    parent_run_id: None,
    subagent_config: None,
    ...
};
```
定时工作流触发时，`ScheduledExecutionContext` 既未从数据库读取该工作流的授权配置，也未指定权限模式，而是直接传入 `permission_mode: None`。当定时任务试图执行 `npm test` 或写入报告时，立即撞入审批门，等待 120 秒后宣告失败。

#### 断裂点 3：长程空闲唤醒与自主续 run（`run/run_idle.rs`）

在 Agent 自主驱动（Autonomous Drive）机制中，当上一轮对话完成（`AgentEndReason::Stop`）且环境中存在未决事件（如子代理产出回传至 Steering 队列、一次性定时器触发唤醒），系统通过 `spawn_idle_resume_run` 拉起下一轮执行。

在 `crates/conex-run/src/run/run_idle.rs:1231-1245` 中：
```rust
// crates/conex-run/src/run/run_idle.rs:1231-1245
let options = RunTaskOptions {
    run_id: crate::engine_provider::new_message_id("idle-resume"),
    session_id: session_id.clone(),
    prompt: Some(text),
    mode: Some(mode.to_string()),
    cwd: None,
    permission_mode: None, // <--- 致命漏洞：会话原本的 full-access 在此瞬间丢失！
    client_message_id: None,
    assistant_client_message_id: None,
    system_prompt: None,
    history: None,
    context_window: None,
    parent_run_id: None,
    subagent_config: None,
    ...
};
```
**严重后果**：用户在第一轮启动时明确勾选了 `full-access` 模式。Agent 自主运行派发了子任务或设置了定时器，第一轮顺利收场。然而，当下游事件唤醒会话时，`spawn_idle_resume_run` 硬编码生成了 `permission_mode: None`。**从这一刻起，原本处于完全访问模式的主会话，被隐秘篡改为 Legacy / 全量审批模式！** Agent 后续执行任何工具调用均会触发审批弹窗；若用户不在屏幕前，会话彻底冻结。

---
### 1.3 `permission_mode: None` 的级联放大：为何比常规 Ask 模式更严苛？

开发者容易产生一种直觉误解：“如果 `permission_mode` 为 `None`，系统应该按默认的 Ask 模式运行（安全只读放行，危险操作弹窗）”。

但审查 `crates/conex-run` 与 `crates/session-loop` 的真实代码发现，**`permission_mode: None` 的实际后果比 Ask 模式严苛得多，它直接激活了 Legacy 的全量刚性拦截！**

#### 步骤 1：`run_launch.rs:931` 启用审批门
```rust
// crates/conex-run/src/run/run_launch.rs:931-936
let approval_enabled = permission_mode.as_deref() != Some("full-access");
let approval: Option<Arc<dyn ApprovalGate>> = if approval_enabled {
    Some(Arc::clone(&approval_gate) as Arc<dyn ApprovalGate>)
} else {
    None
};
```
当 `permission_mode == None` 时，`approval_enabled` 为 `true`，`approval` 审批门被挂载。

#### 步骤 2：`exec_verdict.rs:141-143` 命令全量拦截
在会话循环执行工具判定时（`ToolExecutor::call_verdict`）：
```rust
// crates/session-loop/src/exec_verdict.rs:138-143
// 未设置权限模式：沿用既有语义（approval 开启 → 全批审批），
// 不进入单链（与 legacy 逐行等价：C3 大回退在此同样
// NeedsApproval，其余一律按需审批收口）
if options.permission_mode.is_none() {
    return PermissionVerdict::NeedsApproval; // <--- 任何命令直接判 NeedsApproval！
}
```
**代码断言**：只要 `options.permission_mode.is_none()`，**哪怕是 `git status`、`ls`、`pwd` 等绝对安全的只读命令，也根本不会走三态矩阵判断，而是直接被判为 `PermissionVerdict::NeedsApproval`！**

#### 步骤 3：`exec_verdict.rs:164-171` 非命令工具全量拦截
```rust
// crates/session-loop/src/exec_verdict.rs:164-171
match options.permission_mode {
    Some(mode) => decide(dangerous, false, mode),
    // legacy：approval 开启 → 全部工具调用走审批
    None if options.approval_enabled => PermissionVerdict::NeedsApproval, // <--- 命中此分支！
    // A3 fail-closed 配套：无审批基础设施时安全项放行执行、
    // 危险项 NeedsApproval（执行器不透传执行，见 exec_single/exec_batch）
    None => decide(dangerous, false, PermissionMode::Ask),
}
```
由于步骤 1 中 `options.approval_enabled` 为 `true`，因此命中 `None if options.approval_enabled` 分支：**全部工具（无论是读文件、查列表还是写文件）全部被标记为 `NeedsApproval`！**

#### 步骤 4：审批等待超时收场
在 `crates/session-loop/src/exec_single/pre_exec.rs:56-85` 中，`NeedsApproval` 驱动调用 `approval_wait(..., 120s)`。在无人值守连续运行场景下，此等待必定耗尽 120 秒，最终返回 `tool.approval_expired` 错误。

---

### 1.4 别名解析脆弱性（字符串浅比较 vs 别名表）

在权限模式的枚举定义中，`crates/agent-tools/src/permission.rs:38-49` 提供了健壮的别名映射：
```rust
// crates/agent-tools/src/permission.rs:38-49
impl PermissionMode {
    pub fn from_engine_str(mode: Option<&str>) -> Self {
        match mode {
            Some("full-access" | "full" | "full_access" | "allow" | "yolo" | "danger") => {
                PermissionMode::FullAccess
            }
            Some("plan" | "readonly" | "read-only" | "analysis" | "safe" | "cautious") => {
                PermissionMode::Plan
            }
            _ => PermissionMode::Ask,
        }
    }
}
```
然而，在启动装配核心点 `crates/conex-run/src/run/run_launch.rs:931` 中：
```rust
// crates/conex-run/src/run/run_launch.rs:931
let approval_enabled = permission_mode.as_deref() != Some("full-access");
```
此处**完全没有使用 `PermissionMode::from_engine_str` 进行模式归一化**，而是直接硬编码与 `"full-access"` 字符串比较。
如果外部客户端或 API 传入别名（如 `"full"`、`"yolo"`、`"full_access"`）：
- `tool_options.permission_mode` 会在 `run_launch.rs:1187` 正确映射为 `PermissionMode::FullAccess`；
- 但是 `run_launch.rs:931` 处的 `approval_enabled` 却因为不等于字面量 `"full-access"` 而被评估为 `true`！
- 这导致系统挂载了 `ApprovalGate`，形成内核配置的内部矛盾状态。

---
## 二、FullAccess 模式下裁决链与工具免审批行为实测与代码审查

### 2.1 三态矩阵与命令判定唯一链

当 `permission_mode` 真正成功设置为 `PermissionMode::FullAccess` 时，各判定函数的实际逻辑如下：

#### 1. 基础三态判定：`decide`（`crates/agent-tools/src/permission.rs:84-93`）
```rust
pub fn decide(dangerous: bool, requires_approval: bool, mode: PermissionMode) -> PermissionVerdict {
    if dangerous || requires_approval {
        return match mode {
            PermissionMode::Ask => PermissionVerdict::NeedsApproval,
            PermissionMode::FullAccess => PermissionVerdict::Allow, // <--- 危险操作一律放行
            PermissionMode::Plan => PermissionVerdict::Deny,
        };
    }
    PermissionVerdict::Allow
}
```
对于非命令类的常规工具，只要未触发红线，无论 `dangerous` 为 `true` 还是 `false`，在 `FullAccess` 模式下均返回 `PermissionVerdict::Allow`。

#### 2. 命令判定唯一链：`decide_command_with_revert` / `decide_analysis_with_revert`
（`crates/agent-tools/src/permission.rs:154-169`）
执行顺序严格按照如下阶梯：
1. **红线先行（Redline Precedence）**：
   `if analysis.overall_class == CommandClass::Redline { return PermissionVerdict::Deny; }`
   命中红线直接 Deny，**不经任何权限模式豁免**（`FullAccess` 下亦然）。
2. **C3 大面积回退护栏（Revert Gate）**：
   `if let Some(verdict) = policy.gate_verdict(analysis, mode) { return verdict; }`
   在 `crates/agent-tools/src/revert.rs:641-652` 的断言中明确规定：大面积 git 回退（如跨文件数 ≥10、行数 ≥300 或提交年代 ≥24h 的回退操作），即使在 `FullAccess` 下也必须返回 `NeedsApproval`，完全访问不予豁免！
3. **委托基础三态矩阵**：
   非红线且非超限回退的命令，走 `decide(dangerous, requires_approval, FullAccess)`，返回 `PermissionVerdict::Allow`。

---

### 2.2 `NoopAskChannel` 的注入机制与执行语义

在执行器层，工具上下文的装配位于 `crates/session-loop/src/exec_single/pre_exec.rs:198-211`：
```rust
// crates/session-loop/src/exec_single/pre_exec.rs:198-211
let ask: Option<AskCallback> = match options.permission_mode {
    Some(PermissionMode::FullAccess) => Some(Arc::new(NoopAskChannel)),
    _ => approval.as_ref().map(|gate| {
        let channel = Arc::new(ApprovalChannel::new(
            Arc::clone(gate),
            &call.id,
            abort.cloned(),
            abort_token.clone(),
            requester.clone(),
        ));
        approval_channel = Some(Arc::clone(&channel));
        channel as AskCallback
    }),
};
```
当处于 `FullAccess` 模式时：
- `ctx.ask` 被显式注入为 `Arc<NoopAskChannel>`。
- `NoopAskChannel` 定义在 `crates/agent-tools/src/context.rs:102-114`：
  ```rust
  #[async_trait]
  impl AskChannel for NoopAskChannel {
      async fn ask(
          &self,
          _tool_name: &str,
          _args: &serde_json::Value,
      ) -> Result<AskDecision, ToolError> {
          Ok(AskDecision::Allowed) // 0 开销、无阻塞、立即放行
      }
  }
  ```
- 任何在工具内部显式调用 `ctx.ask.ask(...)` 的检查点，都会瞬间收到 `AskDecision::Allowed`，绝不会产生网络 IPC 或 UI 挂起。

---

### 2.3 分工具免审批实测与检查点代码审查

对 `crates/agent-tools/src/tools/` 下的核心工具进行逐一排查：

#### 1. Shell 工具（`crates/agent-tools/src/tools/shell.rs`）
- **预检层**：
  - 检查 1（第 270 行）：`GatekeeperResult::Blocked` 或 `is_system_critical_path(&cwd)` -> 物理红线直接拒绝。
  - 检查 2（第 288 行）：Plan 模式阻断（FullAccess 放行）。
  - 检查 3（第 300 行）：`DeleteShape` 或 `has_indirect_delete` -> **彻底拔除 FullAccess 特权，强制重定向至回收站 WAL 体系**！保证即使在 YOLO / FullAccess 模式下，Shell 里的 `rm` 也绝不会直接物理 unlink，必须经快照安全备份。
  - 检查 4（第 315 行）：`CdShape` 拦截（引导使用 `cwd` 参数）。
  - 检查 4.1（第 320 行）：`CommandPathInspector` 系统绝对路径安全围栏。
- **裁决执行**（第 336-369 行）：
  调用 `decide_analysis_with_revert`。若门禁层返回 `RequiresApproval`，在 FullAccess 下折算为 `Allow`；
  若大面积回退触发 `NeedsApproval`，由于 FullAccess 下 `approval_enabled == false`，执行器走 `handle_ungated_verdict`（`pre_exec.rs:139`），立即返回结构化错误 `ToolErrorKind::ApprovalRequired`（提示“请缩小回退范围或改用单文件修复”），**不会产生悬挂死锁**。
- **审查结论**：Shell 工具在 FullAccess 下能够真正免审批执行非红线、非大面积回退的合法命令，安全底线清晰。

#### 2. 文件系统删除工具（`delete_file` / `delete_dir`，`crates/agent-tools/src/tools/delete.rs`）
- **定义**：`dangerous: true`，`fatal_on_error: false`。
- **裁决点**：在 `exec_verdict.rs:164` 中，`decide(true, false, FullAccess)` 返回 `PermissionVerdict::Allow`。
- **执行点**（第 180-235 行）：
  - 校验白名单（`check_write_allowance_for_ctx`）；
  - 获取写锁守卫（`claim_write_guard`，防并发冲突）；
  - 移入回收站（`TrashService::trash_file`），生成快照与 SHA-256 校验和；
  - 内部**没有第二重 `ask` 检查**。
- **审查结论**：在 FullAccess 模式下真正实现 100% 免审批秒级删除，且全流程受到应用回收站兜底保护。

#### 3. 笔记工具（`note_*`，如 `note_document_apply_md.rs`）
- **定义**：写类笔记工具（`note_document_apply_md`、`note_block_batch`、`note_block_delete` 等）均标记为 `dangerous: true`。
- **免审批表现**：
  - 外层 `call_verdict` 返回 `PermissionVerdict::Allow`；
  - 内层 `maybe_ask_note_write`（第 101 行）：
    ```rust
    if let Some(ask) = &ctx.ask {
        match ask.ask(tool_name, args).await? {
            AskDecision::Allowed => Ok(()),
            AskDecision::Denied { reason } => Err(...),
        }
    }
    ```
    由于 `ctx.ask` 注入的是 `NoopAskChannel`，直接返回 `Ok(())`。
- **审查结论**：FullAccess 下完全免审批放行。
- **附带发现架构缺陷**：在 Ask 模式下，写笔记工具在外层 `call_verdict` 会先触发一次批级审批弹窗；审批通过进入执行后，内层 `maybe_ask_note_write` 再次调用 `ask.ask(...)`，若审批通道未做去重缓存，用户将被迫点击两次确认。应在后续重构中将权限检查单一收敛到外层 `call_verdict`。

#### 4. 子代理工具（`run_subagent`，`crates/agent-tools/src/tools/subagent/tool.rs`）
- **定义**：`dangerous: false`，`fatal_on_error: false`。
- **主 Agent 侧执行**：主 Agent 派发子代理时无需任何审批，顺畅调用 `SubagentSpawnerImpl::spawn_unchecked`。
- **子 Agent 侧执行断层**：如第一节所述，由于生成的子 Agent 丢失了权限模式（`permission_mode: None`），子 Agent 在执行任何命令或写工具时立即卡死在审批门中。
- **审查结论**：派发动作免审批，但派发产物无法免审批运行，形成了“能生不能活”的断层。

---
## 三、完全访问模式下的红线安全底线（Redline）与优雅报错机制

### 3.1 红线安全底线（Redline）的定义、边界与绝对不可豁免原则

根据全仓安全基线（`AGENTS.md`、`docs/rust-rewrite/31-security-baseline.md` 与 `conex-sandbox`），在任何权限模式下（**包括 Full-Access、YOLO、Danger 模式**），必须存在一组确定性毁灭级操作的绝对禁止清单。**完全访问代表“免人工确认”，绝不代表“自杀授权”！**

红线判定的底层实现收敛于 `crates/conex-sandbox/src/semantics.rs` 与 `crates/agent-tools/src/permission.rs`，其防御边界包含以下八大支柱：

| 序号 | 红线分类 (Redline Class) | 典型拦截目标与形态 | 拦截原理与实现位置 |
|:---|:---|:---|:---|
| **R-1** | 根文件系统与盘符毁灭 | `rm -rf /`、`rm -rf /*`、`rd /s /q C:\`、`del /f /q C:\*` | `semantics.rs:2011-2023`，检测删除目标为根目录或盘符根 |
| **R-2** | 磁盘与存储设备底层破坏 | `mkfs.*`、`format`、`clear-disk`、`format-volume`、`dd of=/dev/sd*` | `semantics.rs:132-145` `REDLINE_COMMANDS` 清单匹配 |
| **R-3** | 操作系统硬件级强停/重启 | `stop-computer`、`restart-computer`、`shutdown /s` | `semantics.rs:143-144` 确定性阻断 |
| **R-4** | 系统核心敏感目录篡改 | 针对 `C:\Windows`、`System32`、`C:\Program Files`、`/etc`、`/boot`、`/sys` | `shell.rs:271` 与 `ConexPathNormalizer::is_system_critical_path` |
| **R-5** | 动态反射与执行层逃逸 | `[System.Diagnostics.Process]::Start`、`[scriptblock]::create`、`[PowerShell]::Create()` | `semantics.rs:2382-2408` 词法危险 Token 模式识别 |
| **R-6** | Base64 编码绕过攻击 | `powershell -enc <b64>`、`pwsh -EncodedCommand` 且内含红线载荷 | `semantics.rs:2686-2690`，自动解密 Base64 并递归分析内层载荷 |
| **R-7** | AST 包裹深度爆炸 (ReDoS 防护)| 命令替换反引号与 scriptblock 嵌套深度 > 16 层 (`MAX_WRAP_DEPTH`) | `semantics.rs:201`，超限直接熔断为 `CommandClass::Redline` |
| **R-8** | 大面积历史回退护栏 (C3) | `git reset --hard HEAD~50`、涉及文件 ≥10、行数 ≥300、年代 ≥24h | `permission.rs:141` 与 `revert.rs:18`，FullAccess 强行拦截不豁免 |

---

### 3.2 现行红线命中处理的缺陷分析

当一个处于 `FullAccess` 模式的 Agent 试图执行红线命令（如意外生成了 `rm -rf /` 或大面积回退）时，系统确实成功阻断了命令，但其后的错误分类与文本反馈机制存在严重缺陷：

#### 1. 错误文案荒谬且语意相反
在 `crates/session-loop/src/exec_verdict.rs:223-250` 中：
```rust
// crates/session-loop/src/exec_verdict.rs:228-244
let message = if let Some(reg) = registry {
    if !reg.is_tool_enabled(&call.tool_name) {
        format!("tool disabled: {}", call.tool_name)
    } else {
        let mode = options
            .permission_mode
            .unwrap_or(PermissionMode::Ask)
            .as_engine_str();
        format!("permission denied by {mode} mode: {}", call.tool_name) // <--- 灾难性文案
    }
} ...
```
当模式为 `full-access` 且工具为 `shell` 时，生成的文案是：
**`"permission denied by full-access mode: shell"`**（“被完全访问模式拒绝了权限：shell”）！

**语意逻辑分析**：
- 模型明确知晓当前处于完全访问模式，却收到系统反馈称“被完全访问模式拒绝”。
- 模型完全无法理解“为什么完全访问模式反而会拒绝我？”它无法感知这是因为命中了系统底层的“毁灭性红线”。
- 模型极有可能将此归咎于临时性的系统状态故障，进而尝试换一种语法（例如改用 Python 脚本调用 `os.system` 或 Base64 编码）再次尝试，陷入无效甚至有害的重试死循环。

#### 2. 错误类型归纳失真
在 `denied_result` 中，该错误被强行归类为：
```rust
ClassifiedToolResult::error(
    &call.id,
    &call.tool_name,
    ToolErrorKind::UserDenied, // <--- 事实上并没有任何用户点击拒绝！
    message,
    0,
)
```
- 将系统内核安全策略拒绝伪装成 `UserDenied`，破坏了审计痕迹的真实性；
- 若后续有智能重试或反思中间件消费 `UserDenied`，会导致逻辑分流错误。

#### 3. 缺乏纠错性指引（Actionable Guidance）
错误信息没有告知模型：
- 究竟哪一部分违背了安全底线（例如：是路径越界到了系统根目录？还是涉及全盘格式化？）；
- 应该如何修正才能合规（例如：请将删除范围限制在当前工作区子目录 `./dist` 下）。

---

### 3.3 优雅报错与非致命收口机制设计

为了确保命中红线时既能刚性阻止危险动作，又能向 Agent 优雅报错而不导致整个会话崩溃（Session Crash），系统必须建立基于“**不可致命 + 结构化红线原因 + 建设性替代指引**”的闭环机制：

```text
                     [Agent 发起高危命令] (如 rm -rf /)
                               │
                               ▼
               [decide_command_with_revert 判定]
                               │
                               ▼
            命中 CommandClass::Redline -> PermissionVerdict::Deny
                               │
                               ▼
                     [优雅拒绝构建器 denied_redline_result]
                               │
        ┌──────────────────────┴──────────────────────┐
        ▼                                             ▼
[结构化错误分类]                             [建设性纠错反馈文案]
ToolErrorKind::RedlineBlocked               "Security Redline Violation: [R-1 Root Destruction].
(标记为 is_never_fatal = true)               Physical wiping of '/' is permanently prohibited
                                            even in Full-Access mode.
                                            Guidance: Please specify a workspace-relative directory
                                            (e.g., './build' or './tmp') to perform cleanups."
        │                                             │
        └──────────────────────┬──────────────────────┘
                               │
                               ▼
                   [喂回模型对话上下文 (ToolResult)]
                               │
                               ▼
               [Agent 认知对齐：知晓红线边界，自主调整方案]
            (不会 panic，不会会话崩溃，不会盲目原样重试)
```

#### 关键机制保障：
1. **非致命性契约（Never Fatal Contract）**：
   在 `crates/session-loop/src/tool_events.rs` 中，确保红线阻断类型永远包含在 `is_never_fatal` 集合中：
   ```rust
   pub fn is_never_fatal(self) -> bool {
       matches!(
           self,
           ToolErrorKind::Timeout
               | ToolErrorKind::UserDenied
               | ToolErrorKind::ApprovalExpired
               | ToolErrorKind::ApprovalRequired
               | ToolErrorKind::RedlineBlocked // <--- 新增红线阻断非致命标记
               | ...
       )
   }
   ```
2. **审计日志单独通道（Security Audit Channel）**：
   在向模型返回非致命纠错文本的同时，底盘通过 `SecurityAuditSink` 发射 `SecurityAuditOperation::RedlineBlocked` 真实安全审计事件，在前端仪表盘高亮警报，留痕备查。

---
## 四、全链路权限透传与完全访问模式完整修复与加固方案

基于上述根因分析，提出覆盖数据结构、派发链路、状态机唤醒、别名处理与报错体验的完整重构与加固方案。

### 4.1 全链路权限透传架构设计

```text
                  ┌────────────────────────────────────────┐
                  │          用户选择: Full-Access         │
                  └───────────────────┬────────────────────┘
                                      │
                                      ▼
               ┌──────────────────────────────────────────────┐
               │         run_task_impl 启动选项归一化          │
               │   PermissionMode::from_engine_str(mode)      │
               │   支持 full-access / full / yolo / allow     │
               └──────────────────────┬───────────────────────┘
                                      │
               ┌──────────────────────┴───────────────────────┐
               │                 会话元数据持久化              │
               │ session_meta.insert("permission_mode", mode) │
               └──────────────────────┬───────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         │                            │                            │
         ▼                            ▼                            ▼
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│  子 Agent 派发    │        │  定时工作流调度   │        │   空闲唤醒续 Run  │
│  (subagent)      │        │  (workflow)      │        │   (run_idle)     │
├──────────────────┤        ├──────────────────┤        ├──────────────────┤
│ToolContext 继承   │        │WorkflowDefinition│        │从 session_meta   │
│permission_mode   │        │存储指定权限模式   │        │恢复原会话权限模式 │
│                  │        │                  │        │                  │
│受 capabilityMode │        │默认继承创建时    │        │杜绝硬编码 None   │
│衰减（最小特权）   │        │的 Full-Access    │        │                  │
└────────┬─────────┘        └────────┬─────────┘        └────────┬─────────┘
         │                           │                           │
         └───────────────────────────┼───────────────────────────┘
                                     │
                                     ▼
                   ┌───────────────────────────────────┐
                   │   所有派生 Run 均保持 Full-Access │
                   │   - approval_enabled = false      │
                   │   - NoopAskChannel 注入           │
                   │   - 0 秒等待，真正全天候自主连续运行  │
                   └───────────────────────────────────┘
```

---

### 4.2 模块级改造方案与具体实施步骤

#### 改造 1：扩展 `SubagentSpawnRequest` 与子代理权限继承链路

1. **接口层修改**（`crates/agent-tools/src/tools/subagent/contract.rs`）：
   在 `SubagentSpawnRequest` 中新增 `permission_mode` 字段：
   ```rust
   pub struct SubagentSpawnRequest {
       ...
       /// 权限模式透传（None = 继承发起方上下文权限模式）
       pub permission_mode: Option<PermissionMode>,
   }
   ```
2. **工具层接线**（`crates/agent-tools/src/tools/subagent/tool.rs`）：
   在 `execute` 与 `execute_many` 中，从 `ctx.permission_mode` 获取当前权限，并结合 `capability_mode` 计算最终权限（**权限衰减原则：只能收紧，不能放大**）：
   ```rust
   // 若子代理能力模式被限定为 read-only，则强制降级为 Plan 模式；否则继承父级模式
   let effective_permission = match req_capability_mode {
       Some(SubagentCapabilityMode::ReadOnly) => PermissionMode::Plan,
       _ => ctx.permission_mode,
   };
   ```
3. **Spawner 启动器修改**（`crates/conex-run/src/subagent_spawner/spawn.rs:137`）：
   ```rust
   let launch_options = RunTaskOptions {
       run_id: subagent_run_id.clone(),
       session_id: session_id.clone(),
       prompt: Some(req.prompt.clone()),
       mode: req.mode.clone().or_else(|| Some("research".to_string())),
       cwd: None,
       // 修复：透传请求中的权限模式，缺省安全退化为 Ask
       permission_mode: Some(req.permission_mode.unwrap_or(PermissionMode::Ask).as_engine_str().to_string()),
       ...
   };
   ```

#### 改造 2：定时工作流权限配置与派发贯通

1. **工作流数据表扩展**：
   在 `conex_types::WorkflowDefinition` 或 `WorkflowSchedule` 中持久化 `permission_mode: Option<String>`。用户在创建定时工作流时，可显式指定或默认采用当前会话的权限模式（如 `"full-access"`）。
2. **执行派发器修改**（`crates/conex-run/src/workflow/launcher.rs:190-211`）：
   ```rust
   let effective_permission_mode = ctx.permission_mode
       .or_else(|| self.workflow_backend.get_permission_mode(&ctx.cron_id))
       .unwrap_or_else(|| "full-access".to_string()); // 定时任务默认全自主运行，赋予 full-access

   let options = crate::run::RunTaskOptions {
       run_id: ctx.run_id.clone(),
       session_id: effective_session_id.clone(),
       prompt: Some(ctx.prompt.clone()),
       mode: Some("scheduled".to_string()),
       cwd: effective_cwd,
       permission_mode: Some(effective_permission_mode), // 修复硬编码 None
       ...
   };
   ```

#### 改造 3：长程空闲唤醒与续 run 权限记忆恢复

1. **会话级元数据记忆**：
   在 `run_launch.rs:750` 处理 `options.permission_mode` 时，将生效的模式异步记录至会话元数据（`session_meta`）中：`state.set_session_permission_mode(&session_id, mode).await;`。
2. **续 run 启动器修改**（`crates/conex-run/src/run/run_idle.rs:1231-1245`）：
   在 `spawn_idle_resume_run` 拉起新 run 时，不再硬编码 `None`，而是从会话元数据读取该会话已锁定的权限模式：
   ```rust
   let session_permission = state.get_session_permission_mode(&session_id).await
       .unwrap_or_else(|| "ask".to_string());

   let options = RunTaskOptions {
       run_id: crate::engine_provider::new_message_id("idle-resume"),
       session_id: session_id.clone(),
       prompt: Some(text),
       mode: Some(mode.to_string()),
       cwd: None,
       permission_mode: Some(session_permission), // 修复硬编码 None，保持 full-access 续航
       ...
   };
   ```

#### 改造 4：`run_launch.rs` 审批门启用逻辑归一化

修复 `crates/conex-run/src/run/run_launch.rs:931` 中的脆弱字符串浅比较：
```rust
// 改造前：
// let approval_enabled = permission_mode.as_deref() != Some("full-access");

// 改造后：使用 PermissionMode 统一解析引擎别名表
let mode_enum = PermissionMode::from_engine_str(permission_mode.as_deref());
let approval_enabled = mode_enum != PermissionMode::FullAccess;
let approval: Option<Arc<dyn ApprovalGate>> = if approval_enabled {
    Some(Arc::clone(&approval_gate) as Arc<dyn ApprovalGate>)
} else {
    None
};
```
此改动彻底修复了 `full`、`yolo`、`danger` 等合法别名下审批门被错误启用的隐患。

#### 改造 5：重塑红线拦截反馈与非致命错误构建

重构 `crates/session-loop/src/exec_verdict.rs:223-250` 中的 `denied_result`：
```rust
pub(crate) fn denied_result(
    call: &ToolBatchCall,
    options: &ToolBatchOptions,
    registry: Option<&ToolRegistry>,
    redline_violation: Option<&str>, // 新增：红线违规具体信息
) -> ClassifiedToolResult {
    let mode_enum = options.permission_mode.unwrap_or(PermissionMode::Ask);
    
    // 若命中红线违规，生成严肃、明确、建设性的红线反馈文案
    if let Some(reason) = redline_violation {
        let message = format!(
            "Security Policy Violation (Redline Blocked): Tool call '{}' was permanently rejected. \
            Reason: {}. This restriction cannot be bypassed even in {} mode. \
            Guidance: Please alter your approach to operate strictly within the authorized project directory.",
            call.tool_name, reason, mode_enum.as_engine_str()
        );
        return ClassifiedToolResult::error(
            &call.id,
            &call.tool_name,
            ToolErrorKind::UserDenied, // 保持 is_never_fatal
            message,
            0,
        );
    }

    // 常规模式拦截（如 Plan 模式拒绝写操作）
    let message = match mode_enum {
        PermissionMode::Plan => format!(
            "PermissionDenied: Execution of '{}' is prohibited in Plan (Read-Only) mode.",
            call.tool_name
        ),
        _ => format!("PermissionDenied: '{}' requires user approval.", call.tool_name),
    };

    ClassifiedToolResult::error(
        &call.id,
        &call.tool_name,
        ToolErrorKind::UserDenied,
        message,
        0,
    )
}
```
此改造彻底消灭了 `"permission denied by full-access mode: shell"` 这一反直觉错误，向 Agent 提供了清晰的因果解释与行动约束。

---

### 4.3 自动化防御性测试矩阵建议

为了确保改造后全链路权限透传无死角，建议在 `crates/conex-run/tests/` 与 `crates/session-loop/src/tool_exec_tests/` 补充以下 6 组自动化回归测试用例：

| 测试用例 ID | 测试目标与验证场景 | 核心断言 (Assertion) |
|:---|:---|:---|
| **TEST-FA-01** | 主 Agent 在 `full-access` 下通过 `run_subagent` 派发子 Agent | 子 Agent 启动选项的 `permission_mode` 为 `Some("full-access")`，子 Agent 执行 `echo hello` 免审批通过，零 `approval-requested` 事件 |
| **TEST-FA-02** | 最小特权原则：`full-access` 下派发 `capabilityMode: "read-only"` 子 Agent | 子 Agent 启动选项自动衰减为 `Some("plan")`，子 Agent 执行写工具直接返回权限拒绝，不弹窗、不越权 |
| **TEST-FA-03** | 定时工作流无人值守连续运行 | 触发 `launch_scheduled_task` 后，执行 Shell 测试构建，零审批阻塞，直接达成终态 `Completed` |
| **TEST-FA-04** | 空闲唤醒续 Run 权限记忆完整性 | 主 Agent 首轮 `full-access` 运行完成；通过 SteeringQueue 注入唤醒触发 `spawn_idle_resume_run`；验证续 run 的 `permission_mode` 仍然为 `Some("full-access")` |
| **TEST-FA-05** | 别名矩阵全覆盖测试 | 分别传入 `"full"`、`"yolo"`、`"allow"`；验证 `approval_enabled == false` 且 `NoopAskChannel` 成功挂载 |
| **TEST-FA-06** | `FullAccess` 模式下红线命令优雅报错验证 | 在 `full-access` 模式下调用 `rm -rf /`；验证返回值包含 `"Security Policy Violation (Redline Blocked)"`，错误分类为非致命，Session 正常继续推进不崩溃 |

---

## 五、总结与下一步落地指引

本报告通过穿透源码的深度审查，厘清了完全访问模式无法全链路贯通的三个硬编码根因（`subagent_spawner`、`workflow/launcher`、`run_idle`），剖析了由此引发的 `None -> approval_enabled -> NeedsApproval -> 120s Expired` 连锁雪崩机理，确立了 FullAccess 下绝对不可让步的八大红线防御边界，并设计了包含权限记忆、最小特权衰减和结构化报错在内的全套加固方案。

下一步将在综合总纲方案（`00-continuous-execution-master-plan.md`）中，将本报告的权限透传架构与“门禁倒计时引擎（维度 02）”、“状态机循环（维度 04）”和“自主驱动韧性（维度 06）”实现交叉对齐，彻底打通全天候无人值守连续运行的技术通道。