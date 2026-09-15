# 维度二：Agent Loop 状态机与控制流对比

> **战役工作区**：`docs/deepseek-harness-comparison/`  
> **对比范围**：DeepSeek Harness ReactLoopAgent vs Conex AgentSessionMachine + ControlBus + SafePoint

---

## 一、对标核心源码路径

- **DeepSeek Harness (`dsh`)**：
  - `packages/core/agent-loop/src/agent.ts` (`ReactLoopAgent`, `Phase`, `setPhase`)
  - `packages/core/agent-loop/src/inbox.ts` (`ReactLoopInbox`, 消息领取与唤醒)
  - `packages/core/agent-loop/src/tool-calls.ts` (`executeToolCalls`, 工具执行流)
- **Conex (Crish)**：
  - `crates/session-loop/src/state.rs` (`AgentSessionMachine`, 状态转移表)
  - `crates/session-loop/src/control.rs` (`ControlBus`, L0-L3 优先级调度)
  - `crates/session-loop/src/safe_point.rs` (`ControlAction`, 安全点平滑收敛)
  - `crates/session-loop/src/loop/loop_exec.rs` (`run` 控制面与收场)

---

## 二、架构设计与机制对比

### 1. 状态机模型
- **DSH**：粗粒度三态（`idle` / `maintenance` / `running`），状态流转主要靠异步步骤边界驱动。
- **Conex**：形式化有限状态机，全状态表逐行穷举，未定义转移返回显式 `TransitionError`。

### 2. 控制总线与中断机制
- **DSH**：依赖 `AbortController` 广播取消。
- **Conex**：L0-L3 控制总线（`force_cancel` > `cooperative_stop` > `soft_inject`）。协作停止时等待当前安全点（SafePoint），保证状态机完整落入终态，不产生断头事件。

### 3. 优劣裁判与高下判定
- **裁判**：**Conex 显著胜出**。Conex 的状态机严谨度、抢占/取消鲁棒性达到了工业内核级水平。
