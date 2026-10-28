# 运行时任务装配、远程限制与全系统散落点排查分析报告

> **文档标识**：`docs/permission-system-consolidation/analysis/05-runtime-assembly-and-scattered-points-inventory.md`  
> **报告类型**：架构深度排查与系统整合重构分析报告  
> **排查对象**：
> - 任务启动装配面（`crates/conex-run/src/run/run_launch.rs`、`apps/agent-workbench/src-tauri/src/run_ipc.rs`）
> - 远程网络接口与隐式降级（`apps/agent-workbench/src-tauri/src/server/core_backend/`、`mod.rs`、`state.rs`）
> - 叶子工具与子系统私有判定（`note_permission.rs`、`note_action_matrix.rs`、`delete.rs`、`shell.rs`、`readonly.rs`、`write_paths.rs`、`explore_quota.rs`、`revert.rs`）
> - 执行上下文与执行器（`agent-tools::context::ToolContext`、`session-loop::exec_verdict.rs`、`session-loop::pre_exec.rs`）
> - 子代理派发装配（`crates/conex-run/src/subagent_spawner/spawn.rs`、`crates/agent-tools/src/subagent_inject.rs`、`subagent/defs.rs`）
> - 跨端类型协议与前端残留（`conex-types`、`permissionModes.ts`、`commandPermissions.ts`、`permissionStore.ts`）  
> **对齐目标**：全面摸清系统散落各处的私有权限逻辑与自作主张的拦截点，设计集中化单一真源架构，将全系统收敛为用户直观可选的 3 种模式：
> 1. **每次询问（Ask Every Time）**
> 2. **智能命令放行（Smart Safe Approval）**
> 3. **完全允许模式（Full Access / All Permitted）** —— 系统不会因为命令而不允许执行，所有执行的命令都是可以运行的。

---

## 一、战役背景与用户痛点穿透

### 1.1 用户核心诉求与根本痛点
用户明确提出：
> “用户希望将整个软件的权限模式统一重构成集中的可选形式，倾向于三个选项：1. 每次询问；2. 智能命令放行；3. 完全允许模式（系统不会因为命令而不允许执行，所有执行的命令都是可以运行的）。而不是让它在我们软件的各方面都有一部分，意思还是集中管理一下。”

在系统演进过程中，权限控制逻辑被多批次战役以不同“局部安全防护”或“边界隔离”的理由，逐步侵入到各个子系统内部：
1. **启动装配面的粗暴二分**：`run_launch.rs` 中仅以 `permission_mode != "full-access"` 作为是否开启审批门（`approval_enabled`）的开关，对“智能放行”完全无原生装配通道；子代理派发时更直接将 `permission_mode` 硬编码为 `None`，导致子代理永远陷入强制审批或被拦截。
2. **远程接口的隐式篡改与双标安全**：`apply_remote_mode` 自作主张地将远程请求的 `FullAccess` 强制降级为 `Ask` 并向事件流发射 `remote-mode-downgrade` 审计。用户即使在手机或远程端明确配置全权运行，系统仍在底层偷偷篡改。
3. **叶子工具内部自设私刑（Private Gatekeeping）**：
   - `shell.rs` 内部同时叠加了任务类型白名单、`SHARED_GATEKEEPER` 门禁、Plan 模式硬阻断、`DeleteShape` 强行重定向到回收站 WAL（注释自称“彻底拔除 FullAccess 特权分支”）、绝对路径安全围栏（`CommandPathInspector`）、以及二次 `decide_analysis_with_revert`；
   - `delete.rs` 强行拦截文件物理删除，强制重定向到应用回收站；
   - `note_permission.rs` 与 `note_action_matrix.rs` 独立设立一套 safeActions / ActionEffects 表驱动权限矩阵；
   - `revert.rs` 在 `gate_verdict` 中强行规定“`full-access` 不豁免大面积回退”，且因为在 `full-access` 下审批通道 `approval` 为 `None`，导致大面积回退在完全允许模式下直接报错失败且根本无法通过审批解决！
4. **状态与配置的多头割裂**：前端维护了一套白名单 `commandPermissions`，但在历史重构中被剥夺了放行效力（降级为纯“记忆”）；前端定义了 4 种模式（`ask`、`deep`、`plan`、`full`），后端协议定义了 3 种，而实际执行各模块又各自解析，缺乏全局单一真源（Single Source of Truth, SSOT）。

---

## 二、全系统权限散落点全景盘点矩阵（Master Inventory Matrix）

下表为对全系统代码进行地毯式排查后建立的权限逻辑与私有判定全景盘点：

| 编号 | 模块 / 层面 | 所在文件及代码锚点 | 当前实现逻辑与行为 | 核心问题与架构冲突 |
| :--- | :--- | :--- | :--- | :--- |
| **P-01** | **启动装配面** | [`run_launch.rs:930-936`](file:///c:/Software/conex/crates/conex-run/src/run/run_launch.rs#L930-L936) | `let approval_enabled = permission_mode.as_deref() != Some("full-access");`<br>`let approval = if approval_enabled { Some(approval_gate) } else { None };` | 粗暴硬编码。仅识别 `full-access` 字符串，无“智能放行”装配槽位；`approval` 传 `None` 导致后续一旦遇到非 Allow 判决即不可逆崩溃。 |
| **P-02** | **启动装配面** | [`run_launch.rs:1181-1194`](file:///c:/Software/conex/crates/conex-run/src/run/run_launch.rs#L1181-L1194) | `ToolBatchOptions { approval_enabled, permission_mode: permission_mode.as_deref().map(PermissionMode::from_engine_str), ... }` | `approval_enabled`（布尔）与 `permission_mode`（枚举）双通道并行，语义重叠且状态容易脱节。 |
| **P-03** | **子代理派发** | [`subagent_spawner/spawn.rs:137-143`](file:///c:/Software/conex/crates/conex-run/src/subagent_spawner/spawn.rs#L137-L143) | `RunTaskOptions { run_id, session_id, ..., permission_mode: None, ... }` | **硬编码断层**：子代理启动时直接把 `permission_mode` 设为 `None`，完全不继承父会话的权限模式！ |
| **P-04** | **子代理派发** | [`subagent/defs.rs:209-210`](file:///c:/Software/conex/crates/agent-tools/src/tools/subagent/defs.rs#L209-L210) | 注释明确写道：“默认集在会话级 permissionMode 之上叠加：父会话 full-access 不传导给子代理” | 自作主张地切断权限传递，导致用户即便开启“完全允许模式”，子代理依然被死死卡在受限沙箱中。 |
| **P-05** | **提示词注入** | [`run_launch.rs:1098-1106`](file:///c:/Software/conex/crates/conex-run/src/run/run_launch.rs#L1098-L1106)<br>[`subagent_inject.rs:220-236`](file:///c:/Software/conex/crates/agent-tools/src/subagent_inject.rs#L220-L236) | `permission_relay_injection(task_type, boundary)` 向系统提示词强行注入：“你执行任务时使用系统分配的默认权限... 确需超出时发起申请” | 提示词层写死受限行为，与模型心理预期产生强行束缚，破坏了全局一致的命令执行权限。 |
| **P-06** | **远程网络层** | [`server/core_backend/mod.rs:41-48`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/core_backend/mod.rs#L41-L48) | `apply_remote_mode`：`Some(PermissionMode::FullAccess) => (Some(PermissionMode::Ask), true)` | **自作主张隐式降级**：远程接口强制拦截 `FullAccess`，单方面降级为 `Ask`，剥夺用户对外连设备的控制意图。 |
| **P-07** | **远程网络层** | [`server/core_backend/state.rs:226-234`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/core_backend/state.rs#L226-L234) | `if mode_downgraded { emit_remote_mode_downgrade_audit(...); }` | 降级后发出 `remote-mode-downgrade` 事件，但用户端无开关解除此限制，属于不可配置的死规则。 |
| **P-08** | **叶子工具-Shell** | [`shell.rs:247-256`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L247-L256) | `command_allowed_for_task_type` 任务类型白名单硬阻断：非白名单命令直接 `TOOL_COMMAND_BLOCKED` | 工具内部硬编码命令检查，脱离中心裁决引擎，直接阻断命令执行。 |
| **P-09** | **叶子工具-Shell** | [`shell.rs:258-285`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L258-L285) | `gate_result == GatekeeperResult::Blocked \|\| is_system_critical_path(&cwd)` 直接刚性拒绝，任何权限模式不可豁免 | `SHARED_GATEKEEPER` 在工具层硬设“红线”，直接抛出错误阻止执行，完全无视用户的“完全允许模式”诉求。 |
| **P-10** | **叶子工具-Shell** | [`shell.rs:296-312`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L296-L312) | “彻底拔除 FullAccess 特权分支！无论是 Ask 还是 FullAccess 模式，只要判定为 DeleteShape 或间接删除，一律强制走回收站 WAL” | 工具执行器公然违背“完全允许”原则，强制拦截 `rm`、`del` 并重定向为内部回收站挪动。 |
| **P-11** | **叶子工具-Shell** | [`shell.rs:320-328`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L320-L328)<br>[`shell.rs:482-517`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L482-L517) | `CommandPathInspector::inspect`：正则扫描命令行绝对路径，一旦命中系统核心目录或越出工作区写/删，硬性阻断 | 工具层私设“绝对路径围栏”，用脆弱的正则是非判断硬拦截命令，在 `FullAccess` 下依旧生效。 |
| **P-12** | **叶子工具-Shell** | [`shell.rs:330-369`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L330-L369) | 工具内部第二遍跑 `decide_analysis_with_revert`，若命中 `NeedsApproval` 则调用 `ctx.ask`；若 `ctx.ask` 为 `None` 则报错返回 | 与调度层 `call_verdict` 重复判定，判定链双源存在；若未注 channel，则直接失败。 |
| **P-13** | **叶子工具-Delete** | [`delete.rs:186-190`](file:///c:/Software/conex/crates/agent-tools/src/tools/delete.rs#L186-L190)<br>[`delete.rs:226`](file:///c:/Software/conex/crates/agent-tools/src/tools/delete.rs#L226) | `TrashService::trash_file`，移入应用内 `.crish-trash`，绝不物理删除，发射 `Redirected` 审计 | 删除工具自定“只移回收站”策略，绕过上层权限模式，无法实现真实的物理文件清除。 |
| **P-14** | **笔记独立权限** | [`note_permission.rs:34-92`](file:///c:/Software/conex/crates/agent-tools/src/note_permission.rs#L34-L92)<br>[`note_action_matrix.rs:64-105`](file:///c:/Software/conex/crates/agent-tools/src/note_action_matrix.rs#L64-L105) | 独立维护 `NOTE_SAFE_TOOLS`、`NOTE_WRITE_TOOLS`、`ActionEffect` 四维矩阵与 `decide_note_tool` 独立判定函数 | 笔记模块自建一套平行的权限判定系统，与通用工具权限逻辑割裂，增加多套规则并存的维护复杂度。 |
| **P-15** | **回退护栏锁死** | [`revert.rs:348-356`](file:///c:/Software/conex/crates/agent-tools/src/revert.rs#L348-L356)<br>[`exec_verdict.rs:151-157`](file:///c:/Software/conex/crates/session-loop/src/exec_verdict.rs#L151-L157) | `RevertPolicy::gate_verdict`：大面积回退时强制将 `FullAccess` 判定为 `NeedsApproval` | **重大 Bug 级冲突**：`run_launch.rs` 在 `FullAccess` 下将 `approval` 设为 `None`，而 `revert` 又判定为 `NeedsApproval`，导致在调度层直接抛出 `ToolErrorKind::ApprovalRequired` 且无法审批，命令永远无法运行！ |
| **P-16** | **调度层未设模式** | [`exec_verdict.rs:141-143`](file:///c:/Software/conex/crates/session-loop/src/exec_verdict.rs#L141-L143) | `if options.permission_mode.is_none() { return PermissionVerdict::NeedsApproval; }` | 只要传入模式为 `None`（如子代理、部分后端直连），强制判为 `NeedsApproval`，无法享受默认放行。 |
| **P-17** | **未审批通道死局** | [`pre_exec.rs:131-146`](file:///c:/Software/conex/crates/session-loop/src/exec_single/pre_exec.rs#L131-L146) | `handle_ungated_verdict`：若 `verdict == NeedsApproval` 且无 gate，直接返回 `ToolErrorKind::ApprovalRequired` | 导致任何在无审批门状态下被误判为 `NeedsApproval` 的调用变成不可执行死局。 |
| **P-18** | **探索类文档配额** | [`explore_quota.rs:322-338`](file:///c:/Software/conex/crates/agent-tools/src/explore_quota.rs#L322-L338)<br>[`fs.rs:391`](file:///c:/Software/conex/crates/agent-tools/src/tools/fs.rs#L391)<br>[`replace.rs:103`](file:///c:/Software/conex/crates/agent-tools/src/tools/replace.rs#L103) | `guard_explore_docs_write`：探索类子代理写文档受配额强制限制（默认仅 1 份），超额阻断 | 写文件与替换工具中硬编码配额检查，也是私有散落阻断点之一。 |
| **P-19** | **写路径硬沙箱** | [`write_paths.rs:18-29`](file:///c:/Software/conex/crates/agent-tools/src/write_paths.rs#L18-L29)<br>[`readonly.rs:131-147`](file:///c:/Software/conex/crates/agent-tools/src/readonly.rs#L131-L147) | `check_write_allowance_for_ctx` 与 `filter_registry_for_task_type` 强行限制可写前缀与可用工具名单 | 工具注册阶段直接将工具剔除，使某些子代理即使被指示也无法使用相应能力。 |
| **P-20** | **前端白名单失效** | [`commandPermissions.ts:8-9`](file:///c:/Software/conex/apps/crish-desktop/src/api/commandPermissions.ts#L8-L9)<br>[`permissionStore.ts:43`](file:///c:/Software/conex/apps/crish-desktop/src/store/permissionStore.ts#L43) | `commandPermissions` “不再参与自动放行判定”，仅作为批准历史记录存储在本地 | 前端界面和用户配置里显示了命令权限列表，但实际在引擎中完全不起放行作用，造成严重的“假配置”困惑。 |

---

## 三、任务启动装配面（Launch Assembly）深入排查

### 3.1 `RunTaskOptions.permission_mode` 的注入与拆包
在 `crates/conex-run/src/run/run_launch.rs` 中：
- **定义**（[`run_launch.rs:586-640`](file:///c:/Software/conex/crates/conex-run/src/run/run_launch.rs#L586-L640)）：
  ```rust
  #[derive(serde::Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct RunTaskOptions {
      pub run_id: String,
      pub session_id: String,
      ...
      pub permission_mode: Option<String>,
      ...
  }
  ```
- **解包与消费**（[`run_launch.rs:750`](file:///c:/Software/conex/crates/conex-run/src/run/run_launch.rs#L750)）：
  `let permission_mode = options.permission_mode;` 提取后，在此后 600 行的装配逻辑中仅有三处消费：
  1. [`run_launch.rs:931`](file:///c:/Software/conex/crates/conex-run/src/run/run_launch.rs#L931)：计算 `approval_enabled`；
  2. [`run_launch.rs:1185-1187`](file:///c:/Software/conex/crates/conex-run/src/run/run_launch.rs#L1185-L1187)：装配进 `ToolBatchOptions`；
  3. [`run_launch.rs:1358`](file:///c:/Software/conex/crates/conex-run/src/run/run_launch.rs#L1358)：打 tracing 日志。

### 3.2 `approval_enabled` 与 `ApprovalGateImpl` 的矛盾装配逻辑
在 [`run_launch.rs:919-937`](file:///c:/Software/conex/crates/conex-run/src/run/run_launch.rs#L919-L937)：
```rust
let approval_gate = Arc::new(ApprovalGateImpl::new(
    run_id.clone(),
    session_id.clone(),
    parent_run_id.clone(),
    broadcast,
    Arc::clone(&handle_shared),
    state.store.clone(),
    cwd.clone(),
));

// permissionMode：full-access 不启用审批；其余（ask / plan）启用
let approval_enabled = permission_mode.as_deref() != Some("full-access");
let approval: Option<Arc<dyn ApprovalGate>> = if approval_enabled {
    Some(Arc::clone(&approval_gate) as Arc<dyn ApprovalGate>)
} else {
    None
};
```
**严重缺陷分析**：
1. **二元逻辑缺陷**：系统只有“是否为 `full-access`”一种判断，没有任何对“智能放行模式（Smart Safe Approval）”的装配分支。对于智能模式，它必须能够将常规命令放行，而对于危险命令依然能唤起 `approval_gate`，但当前的 `run_launch.rs` 仅有开/关两个极端。
2. **实例化的自相矛盾**：`ApprovalGateImpl` 始终被创建（`approval_gate`），并且在 [`run_launch.rs:1299`](file:///c:/Software/conex/crates/conex-run/src/run/run_launch.rs#L1299) 中无条件挂载到了 `ActiveRun.approval` 上：
   ```rust
   let active = Arc::new(ActiveRun {
       ...
       approval: approval_gate,
       ...
   });
   ```
   然而传给 `SessionLoopProducer` 的 `approval` 参数（[`run_launch.rs:1255`](file:///c:/Software/conex/crates/conex-run/src/run/run_launch.rs#L1255)）在 `full-access` 下却传入了 `None`！
3. **致命死局锁死**：一旦下游由于私有规则（如 `revert.rs` 触发大面积回退拦截，或 `polyglot.rs` 启发式规则）判出了 `NeedsApproval`，执行器在 [`pre_exec.rs:28-32`](file:///c:/Software/conex/crates/session-loop/src/exec_single/pre_exec.rs#L28-L32) 走入 `handle_ungated_verdict`。此时因为 `approval` 为 `None`，系统直接抛出不可重试的 `ToolErrorKind::ApprovalRequired`，并输出拒绝信息，导致用户设置了 `FullAccess` 反而无法执行、且连弹窗批准的机会都被剥夺！

### 3.3 子代理派发面的硬编码降级（`spawn.rs`）
在 [`crates/conex-run/src/subagent_spawner/spawn.rs:137-159`](file:///c:/Software/conex/crates/conex-run/src/subagent_spawner/spawn.rs#L137-L159)：
```rust
let launch_options = RunTaskOptions {
    run_id: subagent_run_id.clone(),
    session_id: session_id.clone(),
    prompt: Some(req.prompt.clone()),
    mode: req.mode.clone().or_else(|| Some("research".to_string())),
    cwd: None,
    permission_mode: None, // <--- 关键断层！硬编码 None！
    ...
};
```
- 主 Agent 运行时如果处于用户设置的“完全允许模式”，在调用 `run_subagent` 派发子任务时，`spawn.rs` 直接将子 Agent 的 `permission_mode` 抹除为 `None`；
- 在进入 `run_launch.rs` 时，`None != Some("full-access")` 恒成立，因此子代理**被迫启用审批门**；
- 紧接着在 [`session-loop/src/exec_verdict.rs:141-143`](file:///c:/Software/conex/crates/session-loop/src/exec_verdict.rs#L141-L143)：
  ```rust
  if options.permission_mode.is_none() {
      return PermissionVerdict::NeedsApproval;
  }
  ```
  子代理执行任何涉及命令或危险工具的操作，立刻被判定为 `NeedsApproval`，并通过 [`ApprovalGateImpl::request_approval`](file:///c:/Software/conex/crates/conex-run/src/run/run_approval.rs#L249-L265) 路由向主 Agent 发起权限申请！
- 加上 [`run_launch.rs:1098-1106`](file:///c:/Software/conex/crates/conex-run/src/run/run_launch.rs#L1098-L1106) 的 `permission_relay_injection`，子代理被强行洗脑为“必须申请权限”，彻底违背了用户设定的全局完全允许模式。

### 3.4 IPC 包装层（`run_ipc.rs`）分析
在 [`apps/agent-workbench/src-tauri/src/run_ipc.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run_ipc.rs)：
- `core_run_task`（[`run_ipc.rs:226-233`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run_ipc.rs#L226-L233)）仅是单纯的转发器，将前端传入的 `RunTaskOptions` 原样送入 `run_task_impl`；
- `core_approve_tool`（[`run_ipc.rs:286-294`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run_ipc.rs#L286-L294)）与 `core_deny_tool`（[`run_ipc.rs:298-305`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run_ipc.rs#L298-L305)）接收 `toolCallId` 并调用底层 `ApprovalGateImpl::resolve`；
- `trash_list`、`trash_restore`、`trash_purge`（[`run_ipc.rs:307-373`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run_ipc.rs#L307-L373)）直接对接 `TrashService`，配合 `emit_trash_audit` 形成独立的回收站维护面。

---

## 四、远程网络接口的隐式降级与安全分叉剖析

### 4.1 `apply_remote_mode` 的隐式篡改实现
在 [`apps/agent-workbench/src-tauri/src/server/core_backend/mod.rs:37-48`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/core_backend/mod.rs#L37-L48)：
```rust
/// 远程权限模式上限装配（R1-10 T-08 / D5 §4.6.1）：min(requested, Ask)——
/// 远程不存在 full-access（TH-12 直接缓解）；ask / plan 原样；None 原样。
/// 返回（生效模式, 是否降级）——降级时调用方必须发 remote-mode-downgrade
/// 审计标记（D5 §8.2 / §9.2 矩阵：approve/operate × full-access → ask 降级）。
pub(crate) fn apply_remote_mode(
    requested: Option<PermissionMode>,
) -> (Option<PermissionMode>, bool) {
    match requested {
        Some(PermissionMode::FullAccess) => (Some(PermissionMode::Ask), true),
        other => (other, false),
    }
}
```
并在 [`apps/agent-workbench/src-tauri/src/server/core_backend/state.rs:226-234`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/core_backend/state.rs#L226-L234) 中装配执行：
```rust
let (mode_clamped, mode_downgraded) = apply_remote_mode(params.permission_mode);
let permission_mode = mode_clamped.map(|mode| match mode {
    PermissionMode::Ask => "ask".to_string(),
    PermissionMode::Plan => "plan".to_string(),
    PermissionMode::FullAccess => "full-access".to_string(),
});
if mode_downgraded {
    emit_remote_mode_downgrade_audit(Some(&self.core.event_bridge()), "", &session_id);
}
```

### 4.2 为什么会存在这种设计？它的架构硬伤是什么？
1. **历史诱因（威胁建模恐慌）**：
   在历史上的 `TH-12` 威胁建模中，设计者认为：“远程移动端设备（如手机通过局域网连接）丢失或被劫持的风险极高，不能允许远程请求拥有 `FullAccess` 特权，否则可能远程一键格式化或毁灭主机”。因此拍脑袋硬编码了 `min(requested, Ask)`。
2. **架构硬伤与违背原则**：
   - **剥夺用户主权**：如果用户是在自己的私有局域网或受信任的手机上管理个人电脑，明确希望自动化全权运行，系统却“假装接受”了用户的配置，而在底层暗中强制修改为 `Ask`，这属于典型的**隐式非透明契约**；
   - **导致远程自动化完全瘫痪**：由于远程客户端通常没有像桌面端那样常驻前台随时点“批准”的便捷交互环境，强行降级为 `Ask` 会导致远程启动的长任务在执行第一条写命令时就直接挂起阻塞（等待 120 秒超时失败）；
   - **发射无用审计打补丁**：虽然代码试图通过发射 `SecurityAuditOperation::RemoteModeDowngrade` 做到所谓的“可审计”，但用户在界面上根本无法知晓为什么任务卡住，这种审计只是掩耳盗铃。

### 4.3 其他远程路由与 REST/WS 中的硬编码拦截
在 [`apps/agent-workbench/src-tauri/src/server/`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/) 中：
1. **指令白名单硬限制**（[`remote_whitelist.rs:15-35`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/remote_whitelist.rs#L15-L35)）：
   仅开放特定 5 条审批命令（`approve`, `deny`, `listPendingApprovals`, `approvalHistory`, `checkCommand`），且与桌面端的命令体系存在分叉；
2. **运行参数裁剪**（[`state.rs:260-265`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/core_backend/state.rs#L260-L265)）：
   远程下发的任务选项中，`visible_goal`、`max_rounds`、`reasoning_effort`、`context_state` 被强制剥夺设为 `None`，导致远程任务无法享受桌面同等的智能决策能力。

---

## 五、叶子工具与模块内部的“私有权限判定”深度剖析

在标准的分层架构中，**叶子工具应当仅负责具体功能的执行，判定逻辑应当全部由中心决策层统筹**。然而在当前代码中，大量叶子工具内部自设关卡、私藏判定。

### 5.1 `shell.rs`：私有规则最严重的“重灾区”
在 [`crates/agent-tools/src/tools/shell.rs`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs) 的 `prepare` 执行阶段，竟然硬编码了 **6 道层层阻断**：
1. **任务类型硬阻断**（[`shell.rs:247-256`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L247-L256)）：
   ```rust
   if let Some(task_type) = &ctx.task_type {
       if !readonly::command_allowed_for_task_type(task_type, &command) {
           return Prepared::Done(Err(ToolError::new(
               TOOL_COMMAND_BLOCKED,
               format!("PermissionDenied: 任务类型 [{task_type}] 严格禁止执行非白名单命令：{command}")
           )));
       }
   }
   ```
2. **物理红线硬阻断**（[`shell.rs:258-285`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L258-L285)）：
   调用 `SHARED_GATEKEEPER`，命中 `Blocked` 或 `is_system_critical_path(&cwd)` 直接返回 `PermissionDenied: Command blocked by safety red-line gatekeeper: {command}`。
3. **Plan 模式硬阻断**（[`shell.rs:288-294`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L288-L294)）：
   直接写死 `if ctx.permission_mode == PermissionMode::Plan` 抛出错误。
4. **Delete 语义重定向（强行剥夺 FullAccess）**（[`shell.rs:296-312`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L296-L312)）：
   代码注释赫然写道：
   > “3. 删除形态重定向（I2-S4 / BC10-7）：彻底拔除 FullAccess 特权分支！无论是 Ask 还是 FullAccess 模式，只要判定为 DeleteShape 或间接删除，一律强制走回收站 WAL 事务体系，计算 SHA-256 校验和并创建快照备份，彻底杜绝物理抹除！”
5. **绝对路径安全围栏**（[`shell.rs:319-328`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L319-L328) 与 [`shell.rs:482-517`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L482-L517)）：
   `CommandPathInspector::inspect(&command, workspace_root)` 用正则去抓命令里的路径，抓到工作区外的写/删目标直接报：`"PermissionDenied: 命令试图向工作区外写入或删除绝对路径：{}，严禁越界！"`。
6. **工具内二次判定与审批调用**（[`shell.rs:330-369`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L330-L369)）：
   工具自己再次调用 `decide_analysis_with_revert`，若得到 `NeedsApproval` 并且 `ctx.ask` 不存在，直接抛出 `TOOL_REQUIRES_APPROVAL` 失败。

### 5.2 `delete.rs`：删除接管与物理抹除的完全屏蔽
在 [`crates/agent-tools/src/tools/delete.rs:173-266`](file:///c:/Software/conex/crates/agent-tools/src/tools/delete.rs#L173-L266)：
- `DeleteFileTool` 与 `DeleteDirTool` 标记 `dangerous: true`；
- 在执行时（[`delete.rs:226`](file:///c:/Software/conex/crates/agent-tools/src/tools/delete.rs#L226)），它们强制调用 `TrashService::trash_file`，仅将文件移动至回收站 `.crish-trash`，绝不提供真正的删除通道；
- 无论用户给出的指令是物理清理还是临时归档，系统完全不给物理删除选项，且其重定向行为与 `FullAccess` 脱节。

### 5.3 `note_permission.rs` 与 `note_action_matrix.rs`：笔记域的私有王国
在 [`crates/agent-tools/src/note_permission.rs`](file:///c:/Software/conex/crates/agent-tools/src/note_permission.rs) 与 [`note_action_matrix.rs`](file:///c:/Software/conex/crates/agent-tools/src/note_action_matrix.rs) 中：
- `NOTE_SAFE_TOOLS`（`query_blocks`, `document_outline`, `document_get_md`）与 `NOTE_WRITE_TOOLS`（`document_apply_md`, `send_to_note`, `block_batch`, ...）定义了一套独立的动作分类；
- `note_action_matrix.rs` 引入了 `ActionEffect`（`LocalRead`, `LocalWrite`, `DataEgress`, `ExternalCost`）与 `ActionSource`（`Builtin`, `ExternalMcp`, `Plugin`）；
- 它提供了一套平行的判定入口 `decide_note_tool` 与 `decide_from_matrix`；
- **现状危害**：虽然 `session-loop` 目前主要通过通用工具的 `dangerous` 标记走 `crate::permission::decide`，但笔记模块保留了一整套影子规则与大量单元测试，形成了私有逻辑孤岛，未来若要支持“智能放行”，双套矩阵将产生严重的行为漂移。

### 5.4 `revert.rs`：回退护栏对完全允许模式的致命破坏
在 [`crates/agent-tools/src/revert.rs:348-356`](file:///c:/Software/conex/crates/agent-tools/src/revert.rs#L348-L356)：
```rust
if self.needs_approval(&area) {
    return Some(match mode {
        PermissionMode::Plan => PermissionVerdict::Deny,
        _ => PermissionVerdict::NeedsApproval, // <--- 关键问题：FullAccess 也返回 NeedsApproval！
    });
}
```
结合 [`session-loop/src/exec_verdict.rs:151`](file:///c:/Software/conex/crates/session-loop/src/exec_verdict.rs#L151) 与 [`session-loop/src/exec_single/pre_exec.rs:28-32, 131-146`](file:///c:/Software/conex/crates/session-loop/src/exec_single/pre_exec.rs#L28-L32)：
1. 用户启动时选择了 `FullAccess`，`run_launch.rs` 把 `approval` 设为 `None`（因为完全允许本不需要审批门）；
2. 用户或 Agent 执行了一个大面积 `git reset` 或 `git checkout`；
3. `revert_policy` 判定超阈值，强制返回 `PermissionVerdict::NeedsApproval`；
4. 执行器收到 `NeedsApproval`，但发现 `approval` 是 `None`（无审批门）；
5. 执行器只能在 `handle_ungated_verdict` 中直接把任务判死为 `ToolErrorKind::ApprovalRequired`，并报错中断！
6. **结论**：**“完全允许模式”在此处被彻底破坏成“完全无法执行模式”**！

---

## 六、前后端状态割裂与历史遗留字段排查

### 6.1 前端模式定义与后端模式定义的错位
- **前端模式**（[`apps/crish-desktop/src/api/permissionModes.ts:27-69`](file:///c:/Software/conex/apps/crish-desktop/src/api/permissionModes.ts#L27-L69)）：
  ```typescript
  export type PermissionMode = 'ask' | 'deep' | 'full' | 'plan';
  ```
  其中 `deep`（深入分析）在映射表 `DESKTOP_TO_ENGINE` 中映射为后端的 `ask`。
- **后端模式**（[`crates/conex-types/src/device/commands/enums.rs:78-85`](file:///c:/Software/conex/crates/conex-types/src/device/commands/enums.rs#L78-L85)）：
  ```rust
  pub enum PermissionMode {
      Ask,
      Plan,
      FullAccess,
  }
  ```
- **核心缺失**：无论是前端还是后端，目前都**根本没有定义“智能命令放行（Smart Safe Approval）”的模式标识**！

### 6.2 前端 `commandPermissions` 的“僵尸化”
在 [`apps/crish-desktop/src/api/commandPermissions.ts:8-9`](file:///c:/Software/conex/apps/crish-desktop/src/api/commandPermissions.ts#L8-L9) 注释明确说明：
> “不伪造工具输出；白名单 = 显示/记忆（记住用户批准过的命令），**不再参与自动放行判定**（P1 权限归一 B3：放行权威 = 引擎 call_verdict / ApprovalGateImpl 单一裁决链）”

在设置页中（[`SettingsSecurityTab.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSecurityTab.tsx)），用户能看到白名单列表，甚至能添加/删除命令，但在引擎底层执行时，这个白名单完全不起任何放行作用！这是极其恶劣的用户体验断层。

---

## 七、全系统权限逻辑集中化重构架构设计

为了彻底解决上述“散落、私货、自作主张、隐式降级”的顽疾，必须对全系统权限控制进行**集中化归一重构**。

```
┌────────────────────────────────────────────────────────────────────────┐
│                        前端 UI / 设置 / 远程调用通道                    │
│      [模式 1: 每次询问]    [模式 2: 智能命令放行]    [模式 3: 完全允许]   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 显式模式透传（绝不隐式降级）
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               中心任务装配面 (Launch Assembly - run_launch.rs)          │
│               - 统一解析 3 态模式 (Ask / Smart / FullAccess)             │
│               - 审批门按需装配（FullAccess 下提供自动放行 Channel）      │
│               - 权限模式 100% 继承传导给子代理 (Subagent Spawner)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│            单一真源裁决内核 (Central Adjudication Core Engine)          │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ 模式 1 (Ask Every Time):                                        │   │
│   │   - 凡涉及文件写入、删除、命令执行一律 NeedsApproval               │   │
│   │   - 只读探测（ls, git status, cat）自动放行                     │   │
│   ├────────────────────────────────────────────────────────────────┤   │
│   │ 模式 2 (Smart Safe Approval - 智能命令放行):                   │   │
│   │   - 结合语义层分析与白名单记忆                                  │   │
│   │   - 开发/构建/测试类命令（npm test, cargo build 等）智能放行   │   │
│   │   - 真正的高危/破坏性/越界外发操作 NeedsApproval                │   │
│   ├────────────────────────────────────────────────────────────────┤   │
│   │ 模式 3 (Full Access - 完全允许模式):                           │   │
│   │   - 贯彻用户铁律：“所有执行的命令都是可以运行的”               │   │
│   │   - 拔除一切 Redline 拦截、拔除回退护栏阻断、拔除路径围栏阻断    │   │
│   │   - 100% 返回 PermissionVerdict::Allow                         │   │
│   └────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 单一裁决结果 (Allow / NeedsApproval / Deny)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 纯净的叶子工具层 (Leaf Tools Execution)                 │
│                 - 拔除 shell.rs 中自设的 6 重私有阻断                  │
│                 - 拔除 delete.rs 中的强制重定向与拦截                  │
│                 - 废弃 note_permission 独立判定孤岛                    │
│                 - 只忠实执行中心裁决放行的操作                         │
└────────────────────────────────────────────────────────────────────────┘
```

### 7.1 核心重构原则
1. **单一真源裁决（SSOT）**：
   - 裁决逻辑只允许存在于 `crates/agent-tools/src/permission.rs`（或统一的 `permission_core` 模块）以及 `session-loop/src/exec_verdict.rs` 中；
   - **严禁任何叶子工具（`shell.rs`、`delete.rs`、`fs.rs`、`replace.rs`）内部私自做权限阻断**！叶子工具只负责执行，检查必须全部上移到调度层统一裁决。
2. **彻底贯彻“完全允许模式”的不可阻断性**：
   - 当模式为 `FullAccess` 时，裁决引擎必须 100% 返回 `Allow`；
   - 废除 `revert_policy` 在 `FullAccess` 下返回 `NeedsApproval` 的恶性行为；
   - 废除 `SHARED_GATEKEEPER` 和 `CommandPathInspector` 在 `FullAccess` 下的硬阻断；
   - 废除删除重定向对 `FullAccess` 的强制剥夺，如果用户在完全允许模式下执行 `rm`，系统必须放行真实命令！
3. **实现真正的“智能命令放行（Smart Safe Approval）”**：
   - 引入三态枚举：`enum UnifiedPermissionMode { Ask, Smart, FullAccess }`；
   - 在 `Smart` 模式下：
     - 普通命令、构建测试命令、只读查询命令、以及用户已持久化白名单（`commandPermissions`）中的命令无感自动放行；
     - 真正高风险的操作（如未知的外部写命令、大面积回退、删除根目录等）才唤起 `ApprovalGate` 弹窗。
4. **废除远程接口隐式降级，改为显式透明授权**：
   - 彻底删除 `apply_remote_mode` 的硬编码降级逻辑；
   - 远程接口请求 `FullAccess` 即代表客户端用户的真实意图，必须得到忠实尊重；
   - 若系统出于跨设备安全考虑需要限制远程端权限，必须在桌面设置中提供清晰的用户可见开关（例如：“允许远程客户端使用完全允许模式”），而不是在代码中搞小动作静默篡改。
5. **打通子代理权限传导链**：
   - `subagent_spawner/spawn.rs` 在启动子代理时，必须显式继承父会话的 `permission_mode`；
   - 移除系统提示词中强制限制子代理权限的固定注入，使其行为与全局权限模式保持高度一致。

---

## 八、排查总结与下一步行动项

### 8.1 核心结论
全系统的权限控制确实已被严重碎片化：
- 启动装配面在 `full-access` 之外只有布尔开关，无扩展性；
- 远程层擅自篡改用户模式；
- 叶子工具层私自设立了多达 6 道私有检查关卡；
- 子代理被硬编码剥夺了继承权限；
- 前端白名单沦为摆设；
- 最严重的架构断层是：**在 FullAccess 下，底层某些私有规则判出了 NeedsApproval，而顶层又没有注入 approval gate，导致系统陷入无法执行也无法审批的死局**。

### 8.2 下一步行动项建议
1. **统一数据模型**：在 `conex-types`、前端 `permissionModes.ts`、后端 `agent-tools/permission.rs` 中统一三态枚举（`ask`, `smart`, `full-access`）；
2. **重塑启动装配面**：重构 `run_launch.rs`，废除单纯的 `permission_mode != "full-access"` 布尔判定，建立三态通道；
3. **修复子代理权限丢失**：修改 `subagent_spawner/spawn.rs`，让子代理无损继承父会话权限模式；
4. **彻底拔除叶子工具私货**：将 `shell.rs`、`delete.rs` 中的路径围栏、删除强行重定向、任务类型白名单阻断全部收敛至统一裁决链，并在 `FullAccess` 模式下予以完全放行；
5. **废除远程隐式降级**：清理 `server/core_backend/mod.rs` 中的 `apply_remote_mode` 及其降级审计。
