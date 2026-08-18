/**
 * useAgentPanel 的纯函数提取（T4-8）。
 *
 * `buildAgentStreamCallbacks` / `finalizeAgentStop` 原为 useAgentPanel 内的
 * useCallback，依赖通过闭包捕获。此处提取为纯工厂函数，所有依赖经参数注入，
 * 消除闭包捕获，使逻辑可独立单测。
 *
 * 设计要点：
 * - 不持有 React ref / state；所有可变状态由调用方传入的回调/ref 操作。
 * - `valid()` 闭包仅捕获入参（capturedEpoch + epochRef + guard），无外部隐藏依赖。
 */
import type { StreamCallbacks } from '../api/chatApi';
import type { StreamCancelFn } from '../api/chatBridge';
import {
  dispatchStreamStopCancel,
  markStreamingActive,
} from '../api/streamStop';
import { publishToolDiffs } from '../api/publishToolDiffs';
import {
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from '../api/toolFeedback';
import type {
  FileDiff,
  MessageToolCall,
  MessageToolApprovalMeta,
  SessionAgentPatch,
  SessionMessage,
} from '../store/types';

/** 流式 patch 回调签名（与 useAgentPanel.buildPatchAsst 一致） */
export type PatchAsstFn = (
  asstId: string
) => (fn: (m: SessionMessage) => void) => void;

/** agent 终态 patch 回调签名（与 useSessionStore.patchSessionAgent 一致） */
export type PatchSessionAgentFn = (
  sessionId: string,
  agentId: string,
  patch: SessionAgentPatch
) => void;

/** finalize in-flight 消息回调签名（与 useSessionStore.finalizeAgentMessages 一致） */
export type FinalizeAgentMessagesFn = (
  sessionId: string,
  agentId: string
) => void;

/** 读取当前 subagent runId 的回调签名 */
export type GetSubagentRunIdFn = () => string | null;

/**
 * buildStreamCallbacks 的依赖注入参数。
 * 所有字段由 useAgentPanel 提供，纯函数自身不持有 React 状态。
 */
export interface BuildAgentStreamCallbacksDeps {
  parentSessionId: string;
  agentId: string;
  /** 当前 epoch（捕获快照，用于 valid 判定） */
  capturedEpoch: number;
  /** 读取最新 epoch（ref.current） */
  getEpoch: () => number;
  /** 挂载守卫（mountedRef.current） */
  guard: () => boolean;
  /** 构建单条 assistant 消息 patch 回调（A1 buildPatchAsst 语义） */
  buildPatchAsst: PatchAsstFn;
  /** 写入 localRunIdRef.current */
  setLocalRunId: (runId: string | null) => void;
  /** 读取 localRunIdRef.current（onComplete 时回填 subagentRunId） */
  getLocalRunId: () => string | null;
  /** 写入 cancelRef.current */
  setCancel: (cancel: StreamCancelFn | null) => void;
  /** agent 终态 patch（patchSessionAgent action） */
  patchSessionAgent: PatchSessionAgentFn;
}

/**
 * 构建子 agent 流式回调对象（纯函数，依赖注入）。
 *
 * 与原 useAgentPanel.buildStreamCallbacks 逐分支等价：
 * - onRunMeta：回填 runId + agent status=running
 * - onThought/onChunk：流式 patch 消息文本
 * - onToolStart/onToolSuccess/onToolError/onToolPendingApproval/onApprovalResolved：
 *   工具卡状态机
 * - onComplete：消息 finalize + agent status=completed
 */
export function buildAgentStreamCallbacks(
  asstId: string,
  onComplete: (() => void) | undefined,
  deps: BuildAgentStreamCallbacksDeps
): StreamCallbacks {
  const {
    parentSessionId,
    agentId,
    capturedEpoch,
    getEpoch,
    guard,
    buildPatchAsst,
    setLocalRunId,
    getLocalRunId,
    setCancel,
    patchSessionAgent,
  } = deps;

  const valid = () => guard() && capturedEpoch === getEpoch();
  const pa = buildPatchAsst(asstId);

  return {
    onRunMeta: ({ runId }: { runId: string }) => {
      if (!valid()) return;
      setLocalRunId(runId);
      patchSessionAgent(parentSessionId, agentId, {
        subagentRunId: runId,
        status: 'running',
      });
    },
    onThought: (t: string) =>
      pa((m) => {
        m.thinking = t;
      }),
    onChunk: (c: string) =>
      pa((m) => {
        m.text = c;
        if (m.thinking === '正在处理…') m.thinking = '';
      }),
    onToolStart: (
      toolId: string,
      name: string,
      args: string,
      explanation?: string
    ) =>
      pa((m) => {
        if (!m.toolCalls) m.toolCalls = [];
        if (!m.blocks) m.blocks = [];
        if (!m.toolCalls.some((t) => t.id === toolId)) {
          m.toolCalls.push({
            id: toolId,
            name,
            arguments: args,
            ...(explanation !== undefined ? { explanation } : {}),
            status: 'running',
          });
          m.blocks.push({ type: 'tool_call', id: toolId });
        }
      }),
    onToolSuccess: (
      toolId: string,
      output?: string | null,
      diffs?: FileDiff[]
    ) => {
      let resolved: FileDiff[] = [];
      pa((m) => {
        const tc = m.toolCalls?.find((t) => t.id === toolId);
        if (!tc) return;
        const displayOut = sanitizeToolDisplayOutput(output || '');
        resolved = resolveToolDiffs({
          name: tc.name || '',
          args: tc.arguments,
          output: displayOut,
          structuredDiffs: diffs,
        });
        tc.status = 'success';
        tc.output = displayOut || output || '完成';
        if (resolved.length) tc.diffs = resolved;
      });
      if (valid()) publishToolDiffs(resolved);
    },
    onToolError: (toolId: string, err?: string | null) =>
      pa((m) => {
        const tc = m.toolCalls?.find((t) => t.id === toolId);
        if (tc) {
          tc.status = 'error';
          tc.output = sanitizeToolDisplayOutput(err || '') || err || '失败';
        }
      }),
    onToolPendingApproval: (
      toolId: string,
      name: string,
      args: string,
      explanation: string,
      approvalMeta?: MessageToolApprovalMeta
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
        } else {
          const entry: MessageToolCall = {
            id: toolId,
            name,
            arguments: args,
            explanation,
            status: 'pending_approval',
          };
          if (approvalMeta) entry.approvalMeta = approvalMeta;
          m.toolCalls.push(entry);
          if (
            !m.blocks.some((b) => b.type === 'tool_call' && b.id === toolId)
          ) {
            m.blocks.push({ type: 'tool_call', id: toolId });
          }
        }
      }),
    onApprovalResolved: (toolId: string, decision: string) =>
      pa((m) => {
        const tc = m.toolCalls?.find((t) => t.id === toolId);
        if (!tc) return;
        if (decision === 'allow') {
          tc.status = 'running';
          tc.output = '执行中…';
        } else {
          tc.status = 'error';
          tc.output = '未获批准';
        }
      }),
    onSubagentEvent: () => {},
    onComplete: () => {
      if (!valid()) {
        setCancel(null);
        onComplete?.();
        return;
      }
      pa((m) => {
        m.status = 'completed';
        if (m.thinking === '正在处理…') m.thinking = '';
      });
      const localRunId = getLocalRunId();
      patchSessionAgent(parentSessionId, agentId, {
        status: 'completed',
        endedAt: Date.now(),
        ...(localRunId ? { subagentRunId: localRunId } : {}),
      });
      setCancel(null);
      onComplete?.();
    },
  } as const;
}

/**
 * finalizeAgentStop 的依赖注入参数。
 */
export interface FinalizeAgentStopDeps {
  parentSessionId: string;
  agentId: string;
  /** 是否已在停止中（stopping state） */
  isStopping: boolean;
  /** 设置 stopping state */
  setStopping: (v: boolean) => void;
  /** 自增 epoch（epochRef.current += 1） */
  incrementEpoch: () => void;
  /** 读取并清空 cancelRef.current */
  takeCancel: () => StreamCancelFn | null;
  /** 读取 subagent runId */
  getSubagentRunId: GetSubagentRunIdFn;
  /** finalize in-flight 消息 */
  finalizeInFlight: FinalizeAgentMessagesFn;
  /** agent 终态 patch */
  patchSessionAgent: PatchSessionAgentFn;
  /** 读取 mountedRef.current（cooldown 后判定是否仍挂载） */
  isMounted: () => boolean;
  /** 读取并清理 cooldownRef */
  clearCooldown: () => void;
  /** 设置 cooldown timer */
  setCooldown: (timer: number) => void;
}

/**
 * 停止子 agent：默认 L2 cooperative；force=true 时 L3。
 *
 * 与原 useAgentPanel.finalizeAgentStop 逐行等价，但所有可变状态经依赖注入。
 */
export function finalizeAgentStop(
  force: boolean,
  summary: string | undefined,
  deps: FinalizeAgentStopDeps
): void {
  const {
    parentSessionId,
    agentId,
    isStopping,
    setStopping,
    incrementEpoch,
    takeCancel,
    getSubagentRunId,
    finalizeInFlight,
    patchSessionAgent,
    isMounted,
    clearCooldown,
    setCooldown,
  } = deps;

  if (isStopping) return;
  setStopping(true);
  incrementEpoch();
  const cancel = takeCancel();
  markStreamingActive(false);
  dispatchStreamStopCancel({
    force,
    cancel,
    // live cancel already wires L2/L3; only pass runId when no cancel handle
    runId: cancel ? null : getSubagentRunId(),
    sessionId: parentSessionId,
    reasonCooperative: 'ui-agent-stop',
    reasonForce: 'ui-agent-force-cancel',
  });
  finalizeInFlight(parentSessionId, agentId);
  patchSessionAgent(parentSessionId, agentId, {
    status: 'stopped',
    summary: summary || (force ? '已强制取消' : '已停止'),
    endedAt: Date.now(),
  });
  clearCooldown();
  setCooldown(
    window.setTimeout(() => {
      if (isMounted()) setStopping(false);
    }, 200)
  );
}
