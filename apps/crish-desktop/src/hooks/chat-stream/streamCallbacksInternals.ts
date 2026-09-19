/**
 * chat-stream 流回调内部实现：索引 / 工具身份 / onComplete 分发 / goal 选项 / 工具队列。
 *
 * - msgId→message Map 索引（B6 O(1) 化：替代对 messages 的逐次 `.find(`）；
 * - 工具身份解析、onComplete drain 分发、goal stream 选项合并、工具 patch 队列。
 * 事件分发（onRunError / 子 agent）→ streamCallbacksEvents.ts；
 * usage 消费（快照回填 / approx 兜底）→ streamCallbacksUsage.ts；
 * run 收口三步 + 空回复横幅 → streamRunCompletion.ts。
 */
import { getSessionById } from '../../store/sessionStore';
import type { SessionMessage } from '../../store/types';
import type {
  MessageToolApprovalMeta,
  MessageToolCall,
} from '../../store/types';
import { getStreamTool, getStreamThinking } from '../../store/streamingStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { buildGoalRunTaskFields } from '../../api/goalModeController';
import {
  streamToolBatchKey,
  isImmediateToolStatus,
} from '../../api/streamTextBatcher';
import type {
  StreamToolCallPatch,
  StreamValueBatcher,
} from '../../api/streamTextBatcher';
import type { StreamRequestOptions } from '../../api/chatApi';
import type { SessionStreamManager } from '../../api/sessionStreamManager';
import type { MutableRefObject } from 'react';
import {
  snapshotStreamTextToSession,
  snapshotStreamThinkingToSession,
  commitToolPatchToSession,
  isLiveStreamRun,
} from './helpers';
import { markStreamingActive } from '../../api/streamStop';

/** msgId → message 索引（O(1) 查表替代逐次 find）。 */
export type MessageIndex = ReadonlyMap<string, SessionMessage>;

export function buildMessageIndex(
  sess: { messages?: SessionMessage[] | null } | null | undefined
): MessageIndex {
  const msgs = sess?.messages;
  const index = new Map<string, SessionMessage>();
  if (msgs) {
    for (const m of msgs) index.set(m.id, m);
  }
  return index;
}

/** 工具身份解析（onToolSuccess 补全持久行）：三级合并链，全部 O(1) 查表。 */
export function resolveToolIdentity(opts: {
  toolNames: Record<string, string>;
  sid: string;
  assistantMsgId: string;
  toolId: string;
}): { name: string; args: string } {
  const { toolNames, sid, assistantMsgId, toolId } = opts;
  const live = getStreamTool(sid, assistantMsgId, toolId);
  const asst = buildMessageIndex(getSessionById(sid)).get(assistantMsgId);
  const toolIndex = new Map<string, MessageToolCall>();
  for (const t of asst?.toolCalls || []) toolIndex.set(t.id, t);
  const persisted = toolIndex.get(toolId);
  const name = toolNames[toolId] || live?.name || persisted?.name || '';
  const args = live?.arguments || persisted?.arguments || '';
  return { name, args };
}

/** run 生命周期共享状态（run 钩子 + onComplete 分发共用，替代裸 let）。 */
export type StreamRunState = {
  runClosed: boolean;
  draining: boolean;
};

/**
 * onComplete 分发（T2.2 drain 语义 + 预算式收口触发）：
 * - 已被新 run 接管 → 置 runClosed，不碰 streamingActive；
 * - 否则置 draining，同步释放 streamManager entry，flushFinal 后无残余同步收口。
 */
export function createCompleteHandler(opts: {
  sid: string;
  assistantMsgId: string;
  state: StreamRunState;
  refs: {
    streamManagerRef: MutableRefObject<SessionStreamManager | null>;
  };
  flushStreamBatchers: () => void;
  finishComplete: () => void;
  buffer: { bufferedLength: () => number; flushFinal: () => void };
}): () => void {
  const {
    sid,
    assistantMsgId,
    state,
    refs,
    flushStreamBatchers,
    finishComplete,
    buffer,
  } = opts;
  const onComplete = () => {
    if (state.runClosed) return;
    if (
      !isLiveStreamRun(refs.streamManagerRef.current?.get(sid), assistantMsgId)
    ) {
      state.runClosed = true;
      // Replaced by a newer run — that run owns streamingActive; do not clear.
      return;
    }
    // T2.2（08-detail 3.2）：drain 标志放宽——不置 runClosed，分帧 drain
    // 期间中间帧照常 setStreamText（UI 以预算节奏自然流完，无「停一下再出
    // 最终版」跳跃感）；isFinal 帧到达后由 finishComplete 收口。
    state.draining = true;
    markStreamingActive(false);
    // streamManager entry 同步释放：L1 follow_up 拒绝窗口以 streamManager
    // 为门，drain 期间新发送可入队不误拒；generationMap 保留到
    // finishComplete（drain 中间帧需通过 myGen 守卫）。
    const curStream = refs.streamManagerRef.current?.get(sid);
    if (curStream?.assistantMsgId === assistantMsgId) {
      refs.streamManagerRef.current?.delete(sid);
    }
    const hadPending = buffer.bufferedLength() > 0;
    // 预算式收口（T2.1 flushFinal）：≤2 帧同步刷完（isFinal 帧同步到达 →
    // finishComplete 同步执行）；大残余走 rAF 预算循环。
    buffer.flushFinal();
    flushStreamBatchers();
    // 无残余：isFinal 帧不会到达 → 同步收口（finishComplete 幂等）
    if (!hadPending) finishComplete();
  };
  return onComplete;
}

/** 目标模式选项合并：goal run-task 字段 + assistant clientMessageId 覆盖。 */
export function buildGoalStreamOptions(opts: {
  sid: string;
  assistantMsgId: string;
  streamOptions?: StreamRequestOptions;
}): StreamRequestOptions {
  const { sid, assistantMsgId, streamOptions } = opts;
  const liveGm = getSessionById(sid)?.goalMode;
  const goalOpts =
    !liveGm?.active || !(liveGm.goal || '').trim()
      ? undefined
      : buildGoalRunTaskFields({
          goal: liveGm.goal,
          maxIterations: liveGm.maxIterations ?? 5,
        });
  // 助手 placeholder 幂等键始终下发；用户 clientMessageId 由 send 路径注入 options
  return {
    ...(streamOptions ?? {}),
    ...(goalOpts ?? {}),
    assistantClientMessageId:
      streamOptions?.assistantClientMessageId || assistantMsgId,
  };
}

/**
 * 工具 patch 队列工厂：running/pending 走 lite store（budget 节奏 flush），
 * 即时状态（success/error/pending_approval）直通 flushNow；快照写入不丢块。
 */
export function createToolPatchQueue(opts: {
  sid: string;
  assistantMsgId: string;
  toolNames: Record<string, string>;
  assertLive: () => boolean;
  readStreamedFullText: () => string;
  toolBatcher: StreamValueBatcher<StreamToolCallPatch> | null;
}): {
  queueToolCallPatch: (
    toolId: string,
    patch: StreamToolCallPatch,
    immediate?: boolean
  ) => void;
  upsertToolCall: (
    toolId: string,
    name: string,
    args: string | undefined,
    explanation: string | undefined,
    status: 'running' | 'pending_approval',
    approvalMeta?: MessageToolApprovalMeta
  ) => void;
} {
  const {
    sid,
    assistantMsgId,
    toolNames,
    assertLive,
    readStreamedFullText,
    toolBatcher,
  } = opts;
  const queueToolCallPatch = (
    toolId: string,
    patch: StreamToolCallPatch,
    immediate = false
  ) => {
    if (!assertLive()) return;
    const key = streamToolBatchKey(sid, assistantMsgId, toolId);
    toolBatcher?.push(key, patch);
    if (immediate || isImmediateToolStatus(patch.status)) {
      try {
        toolBatcher?.flushNow();
      } catch {
        /* ignore */
      }
    }
  };
  const upsertToolCall = (
    toolId: string,
    name: string,
    args: string | undefined,
    explanation: string | undefined,
    status: 'running' | 'pending_approval',
    approvalMeta?: MessageToolApprovalMeta
  ) => {
    // 物理因果时序保全：在工具启动前，若存在流式思考与正文，立即提交至 sessionStore，
    // 确保思考块与前置正文块必然处于该工具块之前，锁定因果时序
    snapshotStreamThinkingToSession(sid, assistantMsgId);
    snapshotStreamTextToSession(sid, assistantMsgId, readStreamedFullText());
    toolNames[toolId] = name;
    const patch: StreamToolCallPatch = {
      id: toolId,
      name,
      arguments: args,
      explanation,
      status,
      startedAt: Date.now(),
      ...(approvalMeta ? { approvalMeta } : {}),
    };
    // 关键：在工具调用产生的一瞬间，立即持久化落入 sessionStore 消息 blocks，
    // 使得正文切片与工具块按产生先后自然交错，绝不在收口时批量倾倒
    commitToolPatchToSession(sid, assistantMsgId, toolId, patch);
    queueToolCallPatch(toolId, patch, status === 'pending_approval');
  };
  return { queueToolCallPatch, upsertToolCall };
}
