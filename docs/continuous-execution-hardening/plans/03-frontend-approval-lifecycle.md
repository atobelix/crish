# 方案 03：前端交互与审批生命周期组件重构方案

> **战役代号**：continuous-execution-hardening  
> **方案编号**：PLAN-03 / FE-APPROVAL-LIFECYCLE-03  
> **核心定位**：彻底根除前端审批卡片失活盲态、进度条抖动跳跃、超时语义模糊、僵尸卡片死锁与水合暴力抹杀，构建高可用、高张力、自愈对账的现代 React 18+ 审批生命周期架构。  
> **输入依据**：
> - docs/continuous-execution-hardening/analysis/01-frontend-and-interaction.md
> - docs/continuous-execution-hardening/00-continuous-execution-master-plan.md
> - docs/continuous-execution-hardening/analysis/02-approval-gate-and-timeout.md

---

## 目录

1. [执行摘要与现代 React 18+ 架构原则](#一执行摘要与现代-react-18-架构原则)
2. [端到端协议与 TypeScript 接口契约重塑](#二端到端协议与-typescript-接口契约重塑)
   - 2.1 [引擎事件与 Wire 传输层契约扩充](#21-引擎事件与-wire-传输层契约扩充)
   - 2.2 [存储层实体契约升级 (MessageToolCall)](#22-存储层实体契约升级-messagetoolcall)
   - 2.3 [组件树 Props Drilling 管道全线打通](#23-组件树-props-drilling-管道全线打通)
   - 2.4 [新旧类型对照与兼容性契约](#24-新旧类型对照与兼容性契约)
3. [权威时间基准单源与 Hook 状态机重构](#三权威时间基准单源与-hook-状态机重构)
   - 3.1 [现有 useApprovalCountdown 的致命病理解剖](#31-现有-useapprovalcountdown-的致命病理解剖)
   - 3.2 [基于服务端绝对时间戳 (Server Epoch) 的全新 Hook 架构](#32-基于服务端绝对时间戳-server-epoch-的全新-hook-架构)
   - 3.3 [Hook 内部状态机流转设计](#33-hook-内部状态机流转设计)
   - 3.4 [全新 useApprovalCountdown 生产级源码实现](#34-全新-useapprovalcountdown-生产级源码实现)
4. [双轨语义与高张力 UI 交互重塑](#四双轨语义与高张力-ui-交互重塑)
   - 4.1 [双轨业务场景划分与策略透明度 (Auto-Allow vs Auto-Deny)](#41-双轨业务场景划分与策略透明度-auto-allow-vs-auto-deny)
   - 4.2 [策略透明度徽章与动态状态文案矩阵](#42-策略透明度徽章与动态状态文案矩阵)
   - 4.3 [三阶段渐进张力进度条设计与 CSS 动效规范](#43-三阶段渐进张力进度条设计与-css-动效规范)
   - 4.4 [“一键暂停锁定 (Pause & Hold)” 控件与三级主动干预矩阵](#44-一键暂停锁定-pause--hold-控件与三级主动干预矩阵)
   - 4.5 [UI 交互状态机转移图与卡片布局规约](#45-ui-交互状态机转移图与卡片布局规约)
5. [审批执行器异常处理与僵尸死锁彻底根除](#五审批执行器异常处理与僵尸死锁彻底根除)
   - 5.1 [僵尸死锁复盘：approvalRollbackGuard 的逻辑陷阱](#51-僵尸死锁复盘approvalrollbackguard-的逻辑陷阱)
   - 5.2 [彻底废除 NotFound 强行回滚为 pending 的逻辑](#52-彻底废除-notfound-强行回滚为-pending-的逻辑)
   - 5.3 [智能终态收口机制 (Smart Settle on Mismatch / Expiration)](#53-智能终态收口机制-smart-settle-on-mismatch--expiration)
   - 5.4 [重构后 useChatApprovalExecutor 关键实现](#54-重构后-usechatapprovalexecutor-关键实现)
6. [窗口唤醒、断线重连与页面水合自愈对账](#六窗口唤醒断线重连与页面水合自愈对账)
   - 6.1 [废除 sessionHydrationMessages 对运行态的一刀切抹杀](#61-废除-sessionhydrationmessages-对运行态的一刀切抹杀)
   - 6.2 [水合探活守卫 (Hydration Run-Liveness Probe)](#62-水合探活守卫-hydration-run-liveness-probe)
   - 6.3 [桌面端窗口唤醒/断网对账总线 (Reconciliation Bus)](#63-桌面端窗口唤醒断网对账总线-reconciliation-bus)
   - 6.4 [离线与休眠事件乱序自愈算法](#64-离线与休眠事件乱序自愈算法)
7. [待删除文件、代码与废弃逻辑清单](#七待删除文件代码与废弃逻辑清单)
8. [实施路线图与测试验收矩阵](#八实施路线图与测试验收矩阵)

---

## 一、执行摘要与现代 React 18+ 架构原则

### 1.1 背景与现状剖析
在全天候无人值守连续运行（24/7 Unattended Continuous Execution）场景下，当前桌面端前端（pps/crish-desktop）暴露了多项严重阻断 Agent 自动推进的设计缺陷：
1. **失活盲盒**：唯一真实生产渲染路径 CompactToolRow.tsx 漏传 
emainingMs 与 onTimeout，倒计时 UI 从未在真实生产中点亮；
2. **抖动闪烁**：现存 useApprovalCountdown.ts 监听相对时间差 
emainingMs，父组件任意重渲染立即导致进度条暴走复位至 100%；
3. **僵尸死锁**：挂机休眠唤醒后，后端已超期清理审批，用户点击卡片拒绝因 pprovalRollbackGuard 强制将 NotFound 异常回滚为 pending_approval，造成永久无法消除的死锁卡片；
4. **粗暴抹杀**：页面刷新水合时，sessionHydrationMessages.ts 盲目将所有 
unning 和 pending_approval 粗暴篡改为 error（“上次会话中断”），在后台核心仍在运转时主动掐死会话。

### 1.2 现代 React 18+ 架构设计原则
本重构方案**严禁打补丁、严禁魔术数字补偿、严禁盲目延时猜测**，全面对齐现代 React 18+ 并发安全规范：
- **权威时间基准单源 (SSOT Epoch Clock)**：绝对时间戳（Server Epoch MS）是权威时间基准，客户端仅做 Math.max(0, expiresAtMs - now) 的纯代数投影，消除相对时间累加带来的挂机时钟漂移与父组件重渲染抖动；
- **全链路强类型契约打通 (Strict Props Pipeline)**：从 Rust 引擎事件、IPC 桥、Zustand Store 到组件树，必须通过显式强类型 props 穿透，严禁“防御性悬空”；
- **单向不可变状态机流转 (Unidirectional Immutable Transitions)**：审批状态遵循严格的单向终态推进（pending $\rightarrow$ pproved / denied / expired），绝不允许逆向回滚为 pending；
- **自愈式主动对账 (Active Reconciliation Bus)**：从“被动单向等待事件推送”转变为“事件推送 + 窗口聚焦/重连主动对账”，建立桌面高可用兜底体系。

### 1.3 核心重构目标映射矩阵

| 缺陷领域 | 历史病灶 | 重构后架构形态 | 验收量化指标 |
| :--- | :--- | :--- | :--- |
| **管道传输** | CompactToolRow 遗漏倒计时 props，管道物理断裂 | 完整透传 expiresAtMs、	imeoutMs、policy | 生产卡片 100% 渲染策略与倒计时 |
| **Hook 稳定性** | 依赖 [remainingMs]，重渲染导致 100% 暴走复位 | 服务端绝对时间戳 SSOT + RAF 双模驱动 | 任意重渲染进度条跳跃率为 0，无闭包泄漏 |
| **UI 交互张力** | 策略不透明、无秒数、2px 细线、无暂停手段 | 双轨语义徽章 + 三段张力渐变 + 脉冲警报 + Pause & Hold | 用户一眼可知超时动作，关键时刻一键锁定 |
| **异常收口** | NotFound 报错导致回滚为 pending_approval 僵尸卡片 | 智能终态判定，NotFound 直接收口为 expired 终态 | 僵尸死锁卡片发生率为 0，卡片安全卸载 |
| **水合与重连** | 刷新页面暴力置为 error，休眠醒来状态脱节 | 前置活跃 Run 探活 + 窗口唤醒拉网主动对账 | 刷新/休眠唤醒 100% 恢复真实会话状态 |

---

## 二、端到端协议与 TypeScript 接口契约重塑

### 2.1 引擎事件与 Wire 传输层契约扩充

后端审批事件广播（crates/conex-run/src/run/run_approval.rs）必须补齐超时与策略语义，扩展 AgentEvent::ApprovalRequested 载荷结构：

`	ypescript
// packages/shared-types/src/approval.ts 或 apps/crish-desktop/src/api/engineEventSchema.ts

/** 审批超时动作策略定义 */
export type ApprovalTimeoutPolicy =
  | 'auto-allow'     // 无人值守·自动放行 (Fail-Open)
  | 'auto-deny'      // 超时安全保护·自动拒绝 (Fail-Closed)
  | 'manual-only';   // 仅人工裁决·无超时限制 (例如 T4 极危操作)

/** 引擎广播的审批请求协议体 (PermissionRequest 扩展) */
export interface EngineApprovalRequestWire {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  parameters: Record<string, unknown> | string;
  summary: string;
  cwd?: string;
  reason?: string;
  requesterRunId?: string;
  
  // ── 新增连续运行硬化字段 ──
  /** 审批发起时刻 (Epoch ms) */
  requestedAtMs: number;
  /** 超时预算时长 (ms，如 120000 或自定义预算) */
  timeoutMs: number;
  /** 权威绝对到期时间戳 (Epoch ms，SSOT)；若为 manual-only 则为 null */
  expiresAtMs: number | null;
  /** 超时执行的策略动作 */
  timeoutPolicy: ApprovalTimeoutPolicy;
  /** 默认裁决结果 ('approved' | 'denied' | 'expired') */
  defaultAction: 'approved' | 'denied' | 'expired';
}
`

在 pps/crish-desktop/src/api/chat-bridge/handlers/approvalHandlers.ts 中解析事件时，彻底摒弃本地脑补时间戳的作法，严格提取引擎权威时间：

`	ypescript
// apps/crish-desktop/src/api/chat-bridge/handlers/approvalHandlers.ts
export function onApprovalRequested(
  env: HandlerEnv,
  envelope: EngineEnvelope<'approval-requested'>
): void {
  const { approvalFlow, callbacks } = env;
  const { event, raw } = envelope;
  const req = (isRecord(raw.request) ? raw.request : raw) as unknown as EngineApprovalRequestWire;
  const toolCallId = event.request.toolCallId.trim();
  if (!toolCallId) return;

  const toolName = event.request.toolName.trim() || 'command';
  const args = extractApprovalCommandArgs(req);
  const explanation = String(req.summary ?? req.reason ?? toolName).trim();
  const payload = parseApprovalPayload(raw);
  const approvalMeta = parseApprovalRiskMeta(raw);
  const metaWithPayload = payload ? { ...approvalMeta, payload } : approvalMeta;

  // 核心契约收敛：从 request.metadata 提取权威超时与策略信息 (SSOT)
  const meta = (raw.request && typeof raw.request === 'object' && 'metadata' in raw.request
    ? (raw.request as any).metadata
    : {}) || {};
  const requestedAtMs = typeof meta.requestedAtMs === 'number' ? meta.requestedAtMs : Date.now();
  const timeoutMs = typeof meta.timeoutMs === 'number' ? meta.timeoutMs : 60000;
  const expiresAtMs = typeof meta.expiresAtMs === 'number' ? meta.expiresAtMs : (requestedAtMs + timeoutMs);
  const timeoutPolicy: ApprovalTimeoutPolicy = meta.timeoutPolicy || 'auto-deny';

  approvalFlow.dispatch({
    type: 'approval_pending',
    toolId: toolCallId,
  });

  callbacks.onToolPendingApproval(
    toolCallId,
    toolName,
    args,
    explanation,
    metaWithPayload,
    {
      requestedAtMs,
      timeoutMs,
      expiresAtMs,
      timeoutPolicy,
      isPaused: false,
    }
  );
}
`

### 2.2 存储层实体契约升级 (MessageToolCall)

在 pps/crish-desktop/src/store/types.ts 中，扩展 MessageToolCall 契约以容纳生命周期与倒计时信息：

`	ypescript
// apps/crish-desktop/src/store/types.ts:314

/** 待审批倒计时与策略快照 */
export interface MessageToolApprovalCountdownState {
  /** 审批发起时刻 (Epoch ms) */
  requestedAtMs: number;
  /** 超时预算总时长 (ms) */
  timeoutMs: number;
  /** 权威绝对到期时间戳 (Epoch ms) */
  expiresAtMs: number;
  /** 超时策略 */
  timeoutPolicy: ApprovalTimeoutPolicy;
  /** 是否已被用户一键暂停锁定 */
  isPaused?: boolean;
  /** 暂停发生的时刻 (Epoch ms，用于恢复时计算剩余时长偏移) */
  pausedAtMs?: number;
}

export interface MessageToolCall {
  id: string;
  name: string;
  arguments?: string | undefined;
  status: MessageToolCallStatus;
  output?: string | undefined;
  diffs?: FileDiff[] | undefined;
  explanation?: string | undefined;
  approvalMeta?: MessageToolApprovalMeta | undefined;
  approvalDecision?: MessageToolCallApprovalDecision | undefined;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  durationMs?: number | undefined;
  completedAt?: number | undefined;
  turnId?: string | undefined;
  images?: MessageImageRef[] | undefined;

  // ── 新增审批生命周期与倒计时权威字段 ──
  /** 审批倒计时与策略状态；仅在 status === 'pending_approval' 时活跃 */
  approvalCountdown?: MessageToolApprovalCountdownState | undefined;
}
`

在 pps/crish-desktop/src/hooks/agentStreamCallbacks.ts 中，更新 onToolPendingApproval 的处理逻辑，确保倒计时元数据完整落盘：

`	ypescript
// apps/crish-desktop/src/hooks/agentStreamCallbacks.ts:205
onToolPendingApproval: (
  toolId: string,
  name: string,
  args: string,
  explanation: string,
  approvalMeta?: MessageToolApprovalMeta,
  countdown?: MessageToolApprovalCountdownState
) =>
  pa((m) => {
    if (!m.toolCalls) m.toolCalls = [];
    if (!m.blocks) m.blocks = [];
    const existing = m.toolCalls.find((t) => t.id === toolId);
    if (existing) {
      existing.status = 'pending_approval';
      existing.arguments = args || existing.arguments;
      if (explanation) existing.explanation = explanation;
      if (approvalMeta) existing.approvalMeta = approvalMeta;
      if (countdown) existing.approvalCountdown = countdown;
    } else {
      const entry: MessageToolCall = {
        id: toolId,
        name,
        arguments: args,
        explanation,
        status: 'pending_approval',
        approvalMeta,
        approvalCountdown: countdown,
      };
      m.toolCalls.push(entry);
      if (!m.blocks.some((b) => b.type === 'tool_call' && b.id === toolId)) {
        m.blocks.push({ type: 'tool_call', id: toolId });
      }
    }
  }),
`

### 2.3 组件树 Props Drilling 管道全线打通

彻底重构 CompactToolRow.tsx，打通所有断裂的 props：

`	ypescript
// apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx:153-170

// 提取倒计时核心参数
const countdown = tc.approvalCountdown;
const expiresAtMs = countdown?.expiresAtMs;
const timeoutMs = countdown?.timeoutMs;
const timeoutPolicy = countdown?.timeoutPolicy ?? 'auto-deny';
const isPaused = Boolean(countdown?.isPaused);

return (
  <div
    key={rowKey}
    className={${styles.toolRow}   tool-row tool-row-approval is-pending}
    data-tool-id={tc.id}
    data-approval-wired={approvalWired ? 'true' : 'false'}
    data-timeout-policy={timeoutPolicy}
  >
    {approvalWired ? (
      <ApprovalAskCard
        msgId={mid ?? ''}
        toolId={tc.id}
        summary={summary}
        cmd={tech && tech !== summary ? tech : techFull || undefined}
        busy={approvalBusy}
        riskMeta={tc.approvalMeta}
        // ── 彻底打通的倒计时与控制 props ──
        expiresAtMs={expiresAtMs}
        timeoutMs={timeoutMs}
        timeoutPolicy={timeoutPolicy}
        isPaused={isPaused}
        onPauseToggle={() => {
          if (tc.id && mid && onApprovalPauseToggle) {
            onApprovalPauseToggle(tc.id, mid);
          }
        }}
        onAllow={(note) => {
          if (tc.id && mid) onApprovalAllow!(tc.id, mid, false, note);
        }}
        onAllowRemember={(note) => {
          if (tc.id && mid) onApprovalAllow!(tc.id, mid, true, note);
        }}
        onDeny={() => {
          if (tc.id && mid) onApprovalDeny!(tc.id, mid);
        }}
      />
    ) : (
      <div role=status className={styles.approvalUnavailable}>
        审批操作不可用（未接入真实回调）
      </div>
    )}
  </div>
);
`

ApprovalAskCard.tsx 的 Props 接口定义同步重塑：

`	ypescript
// apps/crish-desktop/src/components/agent-card/ApprovalAskCard.tsx:50-67

export interface ApprovalAskCardProps {
  msgId: string;
  toolId?: string | undefined;
  summary: string;
  cmd?: string | undefined;
  busy?: boolean | undefined;
  riskMeta?: MessageToolApprovalMeta | ApprovalRiskMeta | null | undefined;
  onAllow: (note: string) => void;
  onAllowRemember: (note: string) => void;
  onDeny: () => void;
  
  // ── 全新标准化的时间基准与控制属性 ──
  /** 权威绝对到期时间戳 (Epoch ms，SSOT) */
  expiresAtMs?: number | undefined;
  /** 超时预算总时长 (ms，用于百分比分母) */
  timeoutMs?: number | undefined;
  /** 超时动作策略 (auto-allow | auto-deny | manual-only) */
  timeoutPolicy?: ApprovalTimeoutPolicy | undefined;
  /** 是否处于暂停状态 */
  isPaused?: boolean | undefined;
  /** 切换暂停/恢复回调 */
  onPauseToggle?: (() => void) | undefined;
}
`

### 2.4 新旧类型对照与兼容性契约

| 模块层级 | 历史老字段 / 老签名 | 重构后新标准契约 | 升级与兼容策略 |
| :--- | :--- | :--- | :--- |
| **Engine Wire** | 无任何超时字段 | 
equestedAtMs, 	imeoutMs, expiresAtMs, 	imeoutPolicy | 缺省时前端自动 fallback 为 120000ms 与 uto-deny |
| **MessageToolCall** | 无倒计时字段 | pprovalCountdown?: MessageToolApprovalCountdownState | 可选字段，历史已持久化消息反序列化自然为 undefined |
| **ApprovalAskCard** | 
emainingMs?: number (相对值) | expiresAtMs?: number (绝对值) + 	imeoutMs?: number | 废除相对值入参，禁止本地累加 |
| **Countdown UI** | <ApprovalCountdown remainingMs percent /> | <ApprovalCountdown remainingMs percent stage policy isPaused /> | 升级为包含多段张力渲染的高级进度组件 |

---

## 三、权威时间基准单源与 Hook 状态机重构

### 3.1 现有 useApprovalCountdown 的致命病理解剖

审查 pps/crish-desktop/src/components/agent-card/useApprovalCountdown.ts:37-76，该 Hook 导致进度条反复复位抖动有四大病因：
1. **依赖项污染导致的 100% 暴走复位 (Progress Bar Jump Bug)**：
   useEffect(..., [remainingMs]) 依赖了外部传入的动态相对剩余毫秒数。由于 React 调度或网络流式消息持续产生，父级重渲染传入的 
emainingMs 发生轻微抖动，触发 Effect 重新执行。Effect 内部第一行即执行 setTimeoutPercent(100)，界面进度条瞬间跳回满格并重新开始倒计时，产生强烈的视觉闪烁与心理不信任；
2. **本地相对时间漂移 (Local Drift Bug)**：
   Hook 采用 const endTime = Date.now() + remainingMs。在 Windows 系统低功耗休眠或 WebView2 挂起时，定时器冻结。唤醒后，基于原先时间重新计算，导致倒计时比真实世界慢了整整一个休眠时长；
3. **闭包陈旧与竞态触发 (Stale Closure & Multiple Fire)**：
   依靠 	imeoutFiredRef 与 usyRef 的手动维护，在复杂交互与二次确认（confirmArmed）切换时容易产生幽灵触发；
4. **缺乏暂停与状态保持能力**：
   一旦进入倒计时，无法暂停，无法锁屏。

### 3.2 基于服务端绝对时间戳 (Server Epoch) 的全新 Hook 架构

彻底废弃“相对时长”计算，确立**“服务端绝对时间戳单源 (Server Epoch SSOT)”**原则：

\text{remainingMs} = \begin{cases} 
0, & \text{if } \text{expiresAtMs} == \text{null} \\
\text{frozenRemainingMs}, & \text{if } \text{isPaused} \\
\max(0, \text{expiresAtMs} - \text{Date.now}()), & \text{otherwise}
\end{cases}

\text{percent} = \operatorname{clamp}\left( \frac{\text{remainingMs}}{\text{timeoutMs}} \times 100, 0, 100 \right)

- **完全解耦父组件重渲染**：只要 expiresAtMs 未变，父组件重渲染绝不会重置任何内部定时器与进度百分比；
- **挂机休眠瞬时对齐**：无论休眠 1 秒还是 10 小时，唤醒瞬间读取 Date.now()，立即精确得出 
emainingMs = 0，绝不出现假装还有时间的漏洞。

### 3.3 Hook 内部状态机流转设计

`mermaid
stateDiagram-v2
    [*] --> Idle : expiresAtMs == null

    [*] --> Running : expiresAtMs 有效
    
    state Running {
        [*] --> PhaseCalm : remainingPercent > 30%
        PhaseCalm --> PhaseWarning : remainingPercent <= 30% && remainingMs > 10s
        PhaseWarning --> PhaseCritical : remainingMs <= 10s (脉冲红警报)
    }

    Running --> Paused : 用户点击 Pause & Hold
    Paused --> Running : 用户点击 Resume
    
    Running --> Expired : remainingMs <= 0
    Expired --> Settling : 触发策略动作 (Auto-Allow / Auto-Deny)
    
    Running --> SettleManual : 用户手动点击 (Allow / Deny)
    Paused --> SettleManual : 用户手动点击 (Allow / Deny)
    
    Settling --> [*] : 终态闭环
    SettleManual --> [*] : 终态闭环
`

### 3.4 全新 useApprovalCountdown 生产级源码实现

重写后的 pps/crish-desktop/src/components/agent-card/useApprovalCountdown.ts：

`	ypescript
import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import type { ApprovalTimeoutPolicy } from '../../store/types';

export type CountdownTensionStage = 'calm' | 'warning' | 'critical';

export interface UseApprovalCountdownOptions {
  /** 权威绝对到期时间戳 (Epoch ms) */
  expiresAtMs?: number | undefined;
  /** 超时预算总时长 (ms) */
  timeoutMs?: number | undefined;
  /** 超时动作策略 */
  timeoutPolicy?: ApprovalTimeoutPolicy | undefined;
  /** 外部是否置于 busy (提交中不触发超时回调) */
  busy?: boolean | undefined;
  /** 是否已被外部暂停 */
  isPaused?: boolean | undefined;
  /** 超时到达回调 (仅在自然超时到期且未暂停、未 busy 时调用一次) */
  onTimeout?: (() => void) | undefined;
}

export interface UseApprovalCountdownResult {
  /** 当前剩余毫秒数 */
  remainingMs: number;
  /** 格式化后的剩余秒数 */
  remainingSeconds: number;
  /** 进度百分比 (0.0 - 100.0) */
  percent: number;
  /** 当前张力阶段 */
  tensionStage: CountdownTensionStage;
  /** 是否已过期 */
  isExpired: boolean;
  /** 是否正处于暂停态 */
  isPaused: boolean;
  /** 是否处于有效运行倒计时中 */
  isActive: boolean;
}

export function useApprovalCountdown({
  expiresAtMs,
  timeoutMs = 120000,
  timeoutPolicy = 'auto-deny',
  busy = false,
  isPaused = false,
  onTimeout,
}: UseApprovalCountdownOptions): UseApprovalCountdownResult {
  // 保持 onTimeout 引用最新，杜绝闭包陷阱
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const busyRef = useRef(busy);
  busyRef.current = busy;

  // 记录是否已触发过超时，防止多次触发
  const firedRef = useRef(false);

  // 初始剩余时间纯函数计算
  const computeInitial = useCallback(() => {
    if (!expiresAtMs || timeoutPolicy === 'manual-only') return 0;
    return Math.max(0, expiresAtMs - Date.now());
  }, [expiresAtMs, timeoutPolicy]);

  const [remainingMs, setRemainingMs] = useState<number>(computeInitial);

  // 暂停时的锁定时间快照
  const pausedRemainingRef = useRef<number | null>(null);

  // 监听 expiresAtMs 切换 (仅当切换不同审批时复位)
  useEffect(() => {
    firedRef.current = false;
    pausedRemainingRef.current = null;
    setRemainingMs(computeInitial());
  }, [expiresAtMs, computeInitial]);

  // 核心时钟驱动循环：使用高精度的 requestAnimationFrame 结合低频降级
  useEffect(() => {
    if (!expiresAtMs || timeoutPolicy === 'manual-only') {
      return;
    }

    if (isPaused) {
      if (pausedRemainingRef.current === null) {
        pausedRemainingRef.current = Math.max(0, expiresAtMs - Date.now());
      }
      setRemainingMs(pausedRemainingRef.current);
      return;
    }

    // 恢复运行时清除暂停快照
    pausedRemainingRef.current = null;

    let timerId: ReturnType<typeof setInterval>;

    const updateClock = () => {
      const now = Date.now();
      const left = Math.max(0, expiresAtMs - now);
      setRemainingMs(left);

      if (left <= 0) {
        clearInterval(timerId);
        if (!firedRef.current && !busyRef.current) {
          firedRef.current = true;
          onTimeoutRef.current?.();
        }
      }
    };

    // 首次同步跑一次
    updateClock();

    // 100ms 平滑定时器，保证 UI 进度条顺滑且无高额 CPU 负担
    timerId = setInterval(updateClock, 100);

    return () => {
      clearInterval(timerId);
    };
  }, [expiresAtMs, isPaused, timeoutPolicy]);

  // 当 busy 结束时，若发现已经超时且未曾触发回调，补发一次
  useEffect(() => {
    if (!busy && remainingMs <= 0 && expiresAtMs && !firedRef.current && !isPaused) {
      firedRef.current = true;
      onTimeoutRef.current?.();
    }
  }, [busy, remainingMs, expiresAtMs, isPaused]);

  // 计算百分比与紧张度阶段
  const total = Math.max(timeoutMs, 1000);
  const percent = expiresAtMs && timeoutPolicy !== 'manual-only'
    ? Math.max(0, Math.min(100, (remainingMs / total) * 100))
    : 0;

  const tensionStage: CountdownTensionStage = useMemo(() => {
    if (remainingMs <= 10000) return 'critical';
    if (percent <= 30) return 'warning';
    return 'calm';
  }, [remainingMs, percent]);

  return {
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    percent,
    tensionStage,
    isExpired: expiresAtMs ? remainingMs <= 0 : false,
    isPaused,
    isActive: Boolean(expiresAtMs && timeoutPolicy !== 'manual-only' && remainingMs > 0),
  };
}
`

---

## 四、双轨语义与高张力 UI 交互重塑

### 4.1 双轨业务场景划分与策略透明度 (Auto-Allow vs Auto-Deny)

无人值守系统与有人审批系统存在本质差异，用户在看到卡片的第一眼必须明确知晓：“我不动它，倒计时结束到底会发生什么？”

`
┌────────────────────────────────────────────────────────────────────────┐
│ 模式 A：无人值守 · 自动放行 (Auto-Allow)                                │
│ [ ⚡ 无人值守 · 自动放行 ]                       ⏱️ 00:24 之后自动批准   │
│ [====================================>...............] (翡翠绿平稳推进) │
│ 说明：非破坏性操作，倒计时归零后系统将自动批准以保证全天候无人值守连续运转。 │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│ 模式 B：超时保护 · 自动拒绝 (Auto-Deny)                                 │
│ [ 🛡️ 超时保护 · 自动拒绝 ]                       ⏱️ 00:08 之后安全拦截   │
│ [===================================================>] (珊瑚红剧烈脉冲) │
│ 警报：涉及敏感环境变更，若无人工核准，倒计时归零后将自动拒绝并暂停等待引导。 │
└────────────────────────────────────────────────────────────────────────┘
`

#### 双轨策略决断矩阵：

| 维度 | 轨 A：无人值守自动放行 (Auto-Allow) | 轨 B：超时保护自动拒绝 (Auto-Deny) |
| :--- | :--- | :--- |
| **触发前置** | 处于 unattended 或 full-access 模式，且工具风险评定为 T0/T1/T2 | 处于 ask / deep 模式，或操作命中敏感/破坏性命令 |
| **超时终态动作** | 自动向引擎报送 Approved，任务无感继续前进 | 自动向引擎报送 Expired（拒绝），任务安全挂起或换路 |
| **绝对红线** | **严禁放行 T4 极危与越界写入！** 即使无人值守，T4 也强制降为 Auto-Deny | 全覆盖 |
| **视觉基调** | **翡翠绿 / 沉稳冷蓝**（推进感、可靠感） | **琥珀黄 / 珊瑚红**（防线感、警觉感） |

### 4.2 策略透明度徽章与动态状态文案矩阵

在 ApprovalAskCard.tsx 顶部状态行，植入显式的策略透明度徽章：

`	ypescript
// 徽章渲染逻辑
<div className={styles.approvalCardPolicyBadge} data-policy={timeoutPolicy}>
  {timeoutPolicy === 'auto-allow' ? (
    <>
      <span className={styles.policyIcon}>⚡</span>
      <span>无人值守 · {isPaused ? '倒计时已暂停' : remainingSeconds + 's 后自动放行'}</span>
    </>
  ) : timeoutPolicy === 'auto-deny' ? (
    <>
      <span className={styles.policyIcon}>🛡️</span>
      <span>超时保护 · {isPaused ? '倒计时已暂停' : remainingSeconds + 's 后自动拒绝'}</span>
    </>
  ) : (
    <>
      <span className={styles.policyIcon}>👤</span>
      <span>仅限人工核准</span>
    </>
  )}
</div>
`

### 4.3 三阶段渐进张力进度条设计与 CSS 动效规范

重构 apps/crish-desktop/src/components/agent-card/ApprovalCountdown.tsx，彻底废除 2px 隐形细线，升级为具备丰富语义的多段式高张力进度槽：

`	ypescript
// apps/crish-desktop/src/components/agent-card/ApprovalCountdown.tsx
import React from 'react';
import type { CountdownTensionStage } from './useApprovalCountdown';
import type { ApprovalTimeoutPolicy } from '../../store/types';
import styles from './ApprovalAskCard.module.css';

export interface ApprovalCountdownProps {
  remainingMs: number;
  remainingSeconds: number;
  percent: number;
  tensionStage: CountdownTensionStage;
  policy: ApprovalTimeoutPolicy;
  isPaused: boolean;
}

export const ApprovalCountdown: React.FC<ApprovalCountdownProps> = ({
  remainingMs,
  remainingSeconds,
  percent,
  tensionStage,
  policy,
  isPaused,
}) => {
  const stageClass = styles['stage-' + tensionStage] || '';
  const pausedClass = isPaused ? styles.isPaused : '';
  const containerClass = [styles.approvalCountdownContainer, stageClass, pausedClass].filter(Boolean).join(' ');

  return (
    <div
      className={containerClass}
      role=progressbar
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={'审批剩余时间 ' + remainingSeconds + ' 秒'}
    >
      <div className={styles.countdownMetaRow}>
        <span className={styles.countdownPolicyHint}>
          {isPaused
            ? '⏸️ 倒计时已锁定，等待人工干预'
            : policy === 'auto-allow'
            ? '⚡ 若无干预，将在 ' + remainingSeconds + ' 秒后自动批准执行'
            : '🛡️ 若无核准，将在 ' + remainingSeconds + ' 秒后自动拒绝以保安全'}
        </span>
        <span className={[styles.countdownDigits, tensionStage === 'critical' ? styles.pulseDigits : ''].filter(Boolean).join(' ')}>
          ⏱️ {String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:{String(remainingSeconds % 60).padStart(2, '0')}
        </span>
      </div>

      <div className={styles.progressBarTrack}>
        <div
          className={styles.progressBarFill}
          style={{ width: percent + '%' }}
        />
      </div>
    </div>
  );
};
`

#### CSS 张力样式设计 (ApprovalAskCard.module.css 增补)：

`css
/* 容器布局 */
.approvalCountdownContainer {
  margin-top: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.countdownMetaRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--font-size-xxs, 11px);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.countdownDigits {
  font-family: var(--font-mono);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.05em;
}

/* 进度槽与填充条 */
.progressBarTrack {
  position: relative;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--hairline, var(--border-subtle));
  overflow: hidden;
}

.progressBarFill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.1s linear, background-color 0.3s ease;
}

/* 阶段 1：平稳阶段 (>30%) */
.stage-calm .progressBarFill {
  background: var(--accent-green, #10b981);
}

/* 阶段 2：预警阶段 (10s ~ 30%) */
.stage-warning .progressBarFill {
  background: var(--accent-orange, #f59e0b);
}
.stage-warning .countdownDigits {
  color: var(--accent-orange, #f59e0b);
}

/* 阶段 3：临界阶段 (<10s 呼吸脉冲警报) */
.stage-critical .progressBarFill {
  background: var(--accent-danger, #ef4444);
}
.stage-critical .countdownDigits {
  color: var(--accent-danger, #ef4444);
}

/* 濒死冲刺脉冲动效 */
.pulseDigits {
  animation: pulseTension 1s infinite cubic-bezier(0.4, 0, 0.6, 1);
}

@keyframes pulseTension {
  0%, 100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.12);
    opacity: 0.85;
  }
}

/* 暂停锁定状态 */
.isPaused .progressBarFill {
  background: var(--text-tertiary);
  opacity: 0.6;
}
.isPaused .countdownDigits {
  color: var(--text-tertiary);
}
`

### 4.4 “一键暂停锁定 (Pause and Hold)” 控件与三级主动干预矩阵

全天候自主运行必须赋予突然回到工位的物理用户“一键绝对控场”的能力：

`
┌────────────────────────────────────────────────────────────────────────┐
│  [ ⏸️ 暂停倒计时 ]      [ ❌ 拒绝 ]      [ 记住并允许 ]      [ ✔️ 允许 ] │
└────────────────────────────────────────────────────────────────────────┘
`

1. **第一级：一键暂停倒计时 (Pause and Hold)**：
   - 按钮置于操作行最左侧，点击后：
     - 前端立即将卡片标记为 isPaused = true，时钟停止扣减，进度条凝固；
     - 调用 IPC 发送 core_pause_approval(toolCallId)，引擎在等待通道中冻结超时判定；
     - 按钮文案切换为 [ ▶️ 恢复倒计时 ]，为用户提供阅读代码和分析影响面的充裕时间；
2. **第二级：即时终局裁决 (Immediate Settle)**：
   - 点击 [ ✔️ 允许 ] 或 [ ❌ 拒绝 ]，立即销毁倒计时 Hook，释放资源，上报后端；
3. **第三级：就地退出无人值守模式 (Drop Out of Unattended)**：
   - 在卡片辅助菜单中提供“本次运行退出无人值守模式”，不仅冻结当前工具，还将当前 Run 的权限降级为人工手动审批。

### 4.5 UI 交互状态机转移图与卡片布局规约

`mermaid
flowchart TD
    Init[审批请求抵达 (ApprovalRequested)] --> RenderCard[渲染 ApprovalAskCard]
    RenderCard --> CheckPolicy{检查超时策略}
    
    CheckPolicy -->|Auto-Allow| BadgeAllow[显示翡翠绿自动放行徽章]
    CheckPolicy -->|Auto-Deny| BadgeDeny[显示琥珀/红安全拦截徽章]
    CheckPolicy -->|Manual-Only| BadgeManual[显示人工确认徽章 (无倒计时)]
    
    BadgeAllow --> StartClock[启动 useApprovalCountdown]
    BadgeDeny --> StartClock
    
    StartClock --> UserAction{用户是否干预？}
    
    UserAction -->|点击 Pause & Hold| StatePaused[状态切为 Paused\n倒计时凝固\nIPC 通知后端挂起]
    StatePaused -->|点击 Resume| StartClock
    StatePaused -->|点击 Allow/Deny| FinalDecision[上报最终裁决]
    
    UserAction -->|直接点击 Allow/Deny| FinalDecision
    
    UserAction -->|无干预至 0s| TimeoutFired{倒计时结束}
    Timeo    TimeoutFired{倒计时结束} --> LockWaiting[前端按钮锁定等待\n纯被动消费后端广播]
    LockWaiting -->|接收 ApprovalResolved| AutoSettle[按后端权威事件收口卡片\n0 竞态 0 报错]审批执行器异常处理与僵尸死锁彻底根除

### 5.1 僵尸死锁复盘：approvalRollbackGuard 的逻辑陷阱

深度审查 apps/crish-desktop/src/components/chat-card/useChatApprovalExecutor.ts:103-120 与 apps/crish-desktop/src/api/chat-approval/approvalRollbackGuard.ts:26-31：

`	ypescript
// apps/crish-desktop/src/components/chat-card/useChatApprovalExecutor.ts:103-120
try {
  updateMessageToolCall(activeSessionId, mid, tid, {
    status: 'error',
    output: '已拒绝',
  });
  await engineDenyTool(tid); // 后端抛出 CoreError::NotFound
} catch (_err) {
  const { t: currentTc } = findChatTool(activeSessionId, mid, tid);
  if (shouldSkipDenyRollback(currentTc)) return;

  // 致命回滚逻辑：把状态重新置回 pending_approval！
  updateMessageToolCall(activeSessionId, mid, tid, {
    status: 'pending_approval',
    output: '拒绝未送达',
  });
  showToast('拒绝未送达，请重试');
}
`

`	ypescript
// apps/crish-desktop/src/api/chat-approval/approvalRollbackGuard.ts:26-31
export function shouldSkipDenyRollback(
  currentTc?: MessageToolCall | null
): boolean {
  if (!currentTc) return false;
  return currentTc.status === 'running' || currentTc.status === 'success';
}
`

#### 死锁重演路径：
1. 电脑睡眠休眠，后端 120 秒到期，run_approval.rs 触发 ApprovalDecision::Expired，并调用 self.pending.remove(call_id) 物理移除了审批单；
2. 电脑唤醒，用户看到卡片，点击“拒绝”；
3. 前端先乐观将状态置为 error（output: '已拒绝'）；
4. 调用 engineDenyTool(tid)，后端查找不到该审批单，返回 CoreError::NotFound(tool_call_id not in pending approvals)；
5. 进入 catch 块，调用 shouldSkipDenyRollback(currentTc)；
6. 此时 currentTc.status 刚刚被置为了 error，既非 running 也非 success，守卫返回 false（**不跳过回滚**）；
7. 前端强制执行回滚：将工具状态**重新改写回 pending_approval**，文案置为“拒绝未送达”；
8. 卡片再次渲染在屏幕中央。用户再次点击拒绝或允许，后端依然是 NotFound，继续失败并回滚！
9. **该审批卡片成为永生无法消除的僵尸卡片，彻底死锁会话流！**

### 5.2 彻底废除 NotFound 强行回滚为 pending 的逻辑

**架构铁律**：审批请求一旦进入终态裁决（无论是允许还是拒绝），若后端返回 NotFound，其本质是**该请求在后端已被裁决、已被超时消费或会话已移出**。前端决不能凭空臆断“网络没送达而应该继续等”，更严禁回滚为 pending_approval！

### 5.3 智能终态收口机制 (Smart Settle on Mismatch / Expiration)

引入精细化错误码智能分类：
- **终态收口类异常 (Terminal Settle Errors)**：
  - 匹配关键字：NotFound、not in pending、expired、approval_mismatch、session not active；
  - **处理手段**：明确属于后端已经关闭该审批。前端立即收口为终态（允许报 error 输出“审批已失效或已被处理”，拒绝报 error 输出“已超时关闭”），**严禁回滚，立即卸载卡片**；
- **网络瞬态传输异常 (Transient Network Errors)**：
  - 匹配关键字：timeout、connection refused、transport disconnected；
  - **处理手段**：保留状态，提示用户网络异常，允许重试，但依然不将已决断的意图逆向倒流。

### 5.4 重构后 useChatApprovalExecutor 关键实现

重写后的 apps/crish-desktop/src/components/chat-card/useChatApprovalExecutor.ts 关键方法：

`	ypescript
const isTerminalApprovalError = (err: unknown): boolean => {
  const msg = String(err instanceof Error ? err.message : err);
  return /not in pending|NotFound|approval_mismatch|expired|session not active/i.test(msg);
};

// 重构后的 handleApprovalDeny
const handleApprovalDeny = useCallback(
  async (toolId: string, msgId: string) => {
    const tid = String(toolId || '').trim();
    const mid = String(msgId || '').trim();
    if (!activeSessionId || !tid || !mid) return;

    const acquired = inFlightApprovalRegistry.acquire([tid]);
    if (acquired.length === 0) return;

    try {
      // 乐观更新为拒绝终态
      updateMessageToolCall(activeSessionId, mid, tid, {
        status: 'error',
        output: '已拒绝',
        approvalDecision: 'rejected',
      });
      await engineDenyTool(tid);
    } catch (err) {
      if (isTerminalApprovalError(err)) {
        // 后端已过期或已移除，维持终态，直接提示并收口，绝对不回滚！
        updateMessageToolCall(activeSessionId, mid, tid, {
          status: 'error',
          output: '审批已失效或已超时关闭',
          approvalDecision: 'rejected',
        });
        showToast('该审批已超时或已完成处理');
        return;
      }

      // 仅真实网络异常时告警，但绝不回滚为 pending_approval
      showToast('拒绝命令提交异常，请检查连接');
    } finally {
      inFlightApprovalRegistry.release([tid]);
    }
  },
  [activeSessionId, showToast]
);

// 重构后的 handleApprovalAllow
const handleApprovalAllow = useCallback(
  async (toolId: string, msgId: string, remember: boolean, note?: string) => {
    const tid = String(toolId || '').trim();
    const mid = String(msgId || '').trim();
    if (!activeSessionId || !tid || !mid) return;

    const acquired = inFlightApprovalRegistry.acquire([tid]);
    if (acquired.length === 0) return;

    try {
      updateMessageToolCall(activeSessionId, mid, tid, {
        status: 'running',
        output: '执行中…',
        approvalDecision: 'approved',
      });
      await engineApproveTool(tid, {
        response: note ? { comment: note } : undefined,
      });
    } catch (err) {
      if (isTerminalApprovalError(err)) {
        updateMessageToolCall(activeSessionId, mid, tid, {
          status: 'error',
          output: '审批已失效（后端已超时或已处理）',
        });
        showToast('该审批已过期失效');
        return;
      }

      updateMessageToolCall(activeSessionId, mid, tid, {
        status: 'error',
        output: '批准失败',
      });
      showToast('批准失败，请重试');
    } finally {
      inFlightApprovalRegistry.release([tid]);
    }
  },
  [activeSessionId, showToast]
);
`

---

## 六、窗口唤醒、断线重连与页面水合自愈对账

### 6.1 废除 sessionHydrationMessages 对运行态的一刀切抹杀

审查 apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts:542-557：
`	ypescript
// 原历史粗暴逻辑
toolCalls: next.toolCalls.map((tc) =>
  tc.status === 'running' || tc.status === 'pending_approval'
    ? {
        ...tc,
        status: 'error' as const,
        output: tc.output?.trim() ? tc.output : '上次会话中断，工具未完成',
      }
    : tc
),
`
此逻辑假定“前端刷新 = 任务必定中断”。但在 Rust 常驻内核的桌面架构中，后端往往仍在健康运转。一刀切赋值 error 彻底扼杀了无缝恢复的可能。

**重构决断**：
1. 水合层**严禁自行判定运行中工具为失败**；
2. 剥离无脑置 error 逻辑，交由下述水合探活守卫与对账总线处理。

### 6.2 水合探活守卫 (Hydration Run-Liveness Probe)

在会话水合（sanitizeMessagesForHydrate）阶段，注入活跃任务嗅探：

`	ypescript
// apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts

export interface HydrateSanitizeOptions {
  /** 当前后端活跃会话与待审批映射表 (由对账接口预先查出传入) */
  activeRunsSnapshot?: Set<string>;
  pendingApprovalIds?: Set<string>;
}

export function sanitizeMessagesForHydrate(
  messages: SessionMessage[],
  sessionId?: string,
  options?: HydrateSanitizeOptions
): SessionMessage[] {
  const isSessionActive = Boolean(sessionId && options?.activeRunsSnapshot?.has(sessionId));

  const cleaned = (messages || []).map((m) => {
    let next = { ...m };

    if (next.toolCalls?.length) {
      next = {
        ...next,
        toolCalls: next.toolCalls.map((tc) => {
          // 若会话在后端依然活跃，保留其真实状态！
          if (isSessionActive) {
            if (tc.status === 'pending_approval') {
              const stillPending = options?.pendingApprovalIds?.has(tc.id);
              if (stillPending) return tc; // 依然有效，完整保留！
              // 后端已无此审批，说明已过期或完成，平稳置为已完成或超时
              return {
                ...tc,
                status: 'error' as const,
                output: '审批已在后台超时关闭',
              };
            }
            if (tc.status === 'running') {
              return tc; // 依然在跑，保留 running 状态等待后续事件推送接管
            }
          }

          // 仅对明确死亡的离线孤儿会话执行收口
          if (tc.status === 'running' || tc.status === 'pending_approval') {
            return {
              ...tc,
              status: 'error' as const,
              output: tc.output?.trim() ? tc.output : '会话已终止，工具未完成',
            };
          }
          return tc;
        }),
      };
    }
    return next;
  });

  return healMessagesCausalOrder(cleaned);
}
`

### 6.3 桌面端窗口唤醒/断网对账总线 (Reconciliation Bus)

新建 apps/crish-desktop/src/api/chat-bridge/reconciliation.ts，建立桌面端主动拉网对账总线：

`	ypescript
// apps/crish-desktop/src/api/chat-bridge/reconciliation.ts
import { getTransport } from '../transport';
import { useSessionStore } from '../../store/sessionStore';
import type { MessageToolCall } from '../../store/types';

interface SystemStatusResponse {
  activeRuns: Array<{ runId: string; sessionId: string; status: string }>;
  pendingApprovals: Array<{ toolCallId: string; toolName: string; runId?: string }>;
}

let isReconciling = false;

/**
 * 桌面会话权威增量事件对账器：基于 Sequence 序列号增量回放历史，杜绝破坏性覆盖
 */
export async function reconcileDesktopSessionState(): Promise<void> {
  if (isReconciling) return;
  isReconciling = true;

  try {
    const transport = getTransport();
    if (!transport.isReady()) return;

    const store = useSessionStore.getState();
    const activeSessionId = store.activeSessionId;
    if (!activeSessionId) return;

    const session = store.sessions.find((s) => s.id === activeSessionId);
    if (!session) return;

    // 1. 获取本地已知的最大持久化事件序列号
    const lastSequence = session.lastEventSequence ?? 0;

    // 2. 向后端请求休眠/离开期间产生的权威事件增量（0 凭空臆测，0 破坏性覆盖）
    const res = await transport.request<{
      events: Array<{ sequence: number; eventType: string; payload: string }>;
      lastSequence: number;
    }>('core_query_events', {
      sessionId: activeSessionId,
      fromSequence: lastSequence + 1,
      limit: 1000,
    });

    if (!res || !res.events || res.events.length === 0) return;

    // 3. 顺序回放增量事件，准确还原后台 Auto-Allow 成功的工具状态为 success！
    for (const evt of res.events) {
      applyPersistedEngineEventToStore(activeSessionId, evt);
    }

    store.updateSessionEventCursor(activeSessionId, res.lastSequence);
  } catch (err) {
    console.warn('[Reconciliation] 增量对账执行异常，将在下一次窗口激活时重试:', err);
  } finally {
    isReconciling = false;
  }
}
`

#### 触发总线挂载点：
在应用主入口（App.tsx 或 DesktopShell.tsx）完成全生命周期事件监听绑定：
1. **窗口重新获得焦点**：window.addEventListener('focus', reconcileDesktopSessionState)；
2. **操作系统休眠唤醒**：document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reconcileDesktopSessionState(); })；
3. **网络恢复连接**：window.addEventListener('online', reconcileDesktopSessionState)；
4. **Tauri 原生焦点事件**：appWindow.listen('tauri://focus', reconcileDesktopSessionState)；
5. **周期性心跳**：挂机场景下每 30 秒执行一次静默对账兜底。

### 6.4 离线与休眠事件乱序自愈算法

对账总线与流式事件桥集成，形成**“乐观渲染 + 权威对账校准”**的闭环自愈回路：

`mermaid
sequenceDiagram
    autonumber
    actor User as 用户 / 系统休眠
    participant UI as 前端 WebView (Store)
    participant Bus as Reconciliation Bus
    participant Core as Rust 引擎核心 (conex-run)

    Note over UI,Core: 挂机休眠，120s 超时在后端静默发生
    Core->>Core: approval_timeout 触发 -> Expired 移除 pending 登记
    User->>UI: 唤醒屏幕 / 切换回窗口
    UI->>Bus: 触发 visibilitychange / focus 事件
    Bus->>Core: 调用 core_get_system_status
    Core-->>Bus: 返回活跃 runs 与 pendingApprovals 清单
    Bus->>Bus: 执行 Diff 对账计算
    Bus->>UI: 标记本地失效的 pending_approval 为 Expired 终态
    UI->>UI: 销毁倒计时组件，卡片优雅卸载，无报错 toast
`

---

## 七、待删除文件、代码与废弃逻辑清单

为保证架构净收敛，杜绝历史包袱，执行以下清理清单：

| 文件路径 | 待删除/废除代码段 | 替代方案 / 清理理由 |
| :--- | :--- | :--- |
| pps/crish-desktop/src/api/chat-approval/approvalRollbackGuard.ts | **全文件废除** (shouldSkipDenyRollback, shouldSkipApprovalRollback) | 彻底根除将错误强行回退为 pending_approval 的僵尸死锁根源；统一改走 isTerminalApprovalError 终态收口 |
| pps/crish-desktop/src/components/chat-card/useChatApprovalExecutor.ts | 第 109–117 行的 catch 回滚为 pending_approval 分支 | 替换为智能终态判定，遇到 NotFound 直接置为终态并关闭卡片 |
| pps/crish-desktop/src/components/agent-card/useApprovalCountdown.ts | 第 37–76 行旧版基于 [remainingMs] 与相对时间累加的 useEffect | 替换为第 3.4 节基于服务端绝对时间戳 SSOT 与 RAF 的全新 Hook |
| pps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx | 第 154–170 行中漏传倒计时 props 的调用代码 | 重构为完整透传 expiresAtMs、	imeoutMs、	imeoutPolicy、isPaused 等新 props |
| pps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts | 第 545–555 行对 
unning 和 pending_approval 一刀切置 error 的逻辑 | 替换为引入 ctiveRunsSnapshot 与探活守卫的精细化状态保留方案 |
| pps/crish-desktop/src/extensions/conversation-flow/PermissionBar.tsx | 第 4 行“不要演示倒计时槽”的旧注释与死逻辑 | 统一直通 CompactToolRow 内核，消除双头原型割裂 |

---

## 八、实施路线图与测试验收矩阵

### 8.1 四阶段实施计划

`mermaid
gantt
    title 前端审批生命周期重构实施路线图 (Wave 1 - Wave 4)
    dateFormat  YYYY-MM-DD
    section Wave 1: 契约与管道打通
    TypeScript 接口扩展 (types.ts)           :w1_1, 2026-10-28, 1d
    CompactToolRow Props 管道贯通          :w1_2, after w1_1, 1d
    ApprovalAskCard Props 签名升级          :w1_3, after w1_2, 1d
    section Wave 2: Hook与高张力UI
    全新 useApprovalCountdown Hook 落地    :w2_1, after w1_3, 1d
    ApprovalCountdown 多段张力条与动效      :w2_2, after w2_1, 1d
    Pause & Hold 一键锁定交互接入           :w2_3, after w2_2, 1d
    section Wave 3: 死锁消除与执行器重构
    废除 approvalRollbackGuard              :w3_1, after w2_3, 1d
    useChatApprovalExecutor 智能终态改造   :w3_2, after w3_1, 1d
    section Wave 4: 对账总线与水合自愈
    sessionHydrationMessages 探活改造      :w4_1, after w3_2, 1d
    Reconciliation Bus 唤醒总线落地         :w4_2, after w4_1, 1d
`

### 8.2 单元测试套件设计

为本重构方案编写专项高覆盖率单元测试：

1. **useApprovalCountdown.test.ts**：
   - **重渲染稳定性断言**：父组件每 50ms 触发一次重新渲染并传入微小变化的外部 props，断言内部 percent 保持严格单调递减，跳跃与复位次数恒为 0；
   - **挂机时钟突跳断言**：模拟系统休眠（推进系统时钟 200 秒），断言 Hook 唤醒瞬间立即计算出 remainingMs = 0 并派发一次 onTimeout，绝无负数或 NaN；
   - **Pause and Hold 断言**：点击暂停后推进时间，断言 percent 与 remainingMs 绝对冻结；恢复后基于剩余预算继续运行；
2. **useChatApprovalExecutor.test.ts**：
   - **NotFound 终态拦截断言**：Mock 引擎返回 NotFound 异常，断言工具调用被置为 status: error，approvalDecision: rejected，**断言状态绝未被回滚为 pending_approval**；
   - **并发去重断言**：双击允许或拒绝，断言 inFlightApprovalRegistry 拦截第二次点击，底层 IPC 只调用一次；
3. **sessionHydrationMessages.test.ts**：
   - **活跃 Run 保护断言**：传入 activeRunsSnapshot 包含当前会话，断言 running 和有效的 pending_approval 完整保留，不被强行置为错误；
4. **reconciliation.test.ts**：
   - **幽灵卡片自动出队断言**：Store 中存在 pending_approval，但系统状态返回空 pending，断言对账后该工具自动出队收拢为超时终态。

### 8.3 门禁与发布前核对基线

- **编译与静态检查**：
pm run typecheck 全绿，零 TypeScript 类型报错；
- **行数门禁守卫**：
pm run check:line-counts，重构后的各组件严格维持在分级行数配额内（UI $\le 500$ 行，逻辑 $\le 400$ 行）；
- **单元测试回归**：
pm run test:coverage -- --project=unit 保持原有测试全量通过并新增专项测试；
- **无退避交付验证**：通过真实 Tauri 桌面应用（Tauri MCP 4000）验证挂机 10 分钟唤醒后卡片自愈，彻底实现 24/7 全天候平稳连续运行。

---
*本方案由战役架构组统一编制，作为【全天候自主 Agent 连续运行硬化战役】03 维度的执行实施准绳。*

