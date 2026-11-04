/**
 * 工具域 handler（T7 分派表）：tool-start / tool-end /
 * tool-batch-start / tool-batch-end + BG3 后台回注两事件
 * （tool-backgrounded / tool-settled，与 onToolEnd 同文件定案——
 * 不挂 taskEventHandlers，那是只触发刷新信号的数据面语义）。
 *
 * tool-start / tool-end 保留原 toolUtils 的宽容字段抽取（call 嵌套或顶层平铺），
 * 行为与原 16 分支实现完全等价。
 *
 * > 统一输入流收敛战役 R1：tool-update 死契约删除（前端零消费空实现随删）。
 */
import { toolCallFieldsFromEvent, toolResultFields } from './toolUtils';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { getSessionStoreState } from '../../../store/sessionStore';
import { updateMessageToolCall } from '../../../store/sessionAccess';
import {
  streamStoreKey,
  useStreamingStore,
} from '../../../store/streamingStoreCore';

export function onToolStart(
  env: HandlerEnv,
  envelope: EngineEnvelope<'tool-start'>
): void {
  const { callbacks, approvalFlow } = env;
  const { id, name, args, explanation } = toolCallFieldsFromEvent(envelope.raw);
  if (id && id.trim()) {
    const toolId = id.trim();
    approvalFlow.dispatch({ type: 'tool_start', toolId });
    callbacks.onToolStart(toolId, name, args, explanation);
  }
}

export function onToolEnd(
  env: HandlerEnv,
  envelope: EngineEnvelope<'tool-end'>
): void {
  const { callbacks, approvalFlow, tryResumeFinish } = env;
  const resultPayload = envelope.raw.result ?? envelope.raw;
  const { id, text, isError, diffs, durationMs } =
    toolResultFields(resultPayload);
  if (!id || !id.trim()) return;
  const toolId = id.trim();
  approvalFlow.dispatch({ type: 'tool_end', toolId });
  if (isError) callbacks.onToolError(toolId, text || 'failed', durationMs);
  else callbacks.onToolSuccess(toolId, text || '', diffs, durationMs);
  tryResumeFinish();
}

/**
 * BG3 消费定位：按 callId 在会话已提交消息中定位承载消息。
 * tool-backgrounded / tool-settled 是 run 归属缺省的实时轨事件
 * （发起 run 可能早已收口），不能绑活跃 stream 的 callbacks
 * （onToolSuccess / onToolError 面向当前流、迟到回填会写错消息），
 * 必须 store 直写——与 onTimelineTruncate 的 store 直达同型。
 * 找不到承载消息（已撤回/未提交）→ 静默跳过，不伪造条目。
 */
function findToolCallMessageId(
  sessionId: string,
  callId: string
): string | null {
  const session = getSessionStoreState().sessionsById[sessionId];
  if (!session?.messages) return null;
  for (const m of session.messages) {
    if (m.toolCalls?.some((tc) => tc.id === callId)) return m.id;
  }
  return null;
}

export function onToolBackgrounded(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'tool-backgrounded'>
): void {
  const event = envelope.event;
  const callId = event.callId?.trim();
  if (!callId || !event.sessionId) return;
  const messageId = findToolCallMessageId(event.sessionId, callId);
  if (!messageId) return;
  // 只落数据（标记 + 已运行时长）；「后台中」呈现归 BG5
  updateMessageToolCall(event.sessionId, messageId, callId, {
    backgrounded: true,
    backgroundedElapsedMs: event.elapsedMs,
  });
}

export function onToolSettled(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'tool-settled'>
): void {
  const event = envelope.event;
  const callId = event.callId?.trim();
  if (!callId || !event.sessionId) return;
  const messageId = findToolCallMessageId(event.sessionId, callId);
  if (!messageId) return;
  // 结果字段与 onToolEnd 同抽取口径（raw.result 原始载荷）：同构
  // 保证——settled 回填后的卡片与当初直执 tool-end 渲染一致；
  // 原位 update 不动消息序与 toolCalls 序，卡片不消失不跳位
  const { text, isError, diffs, durationMs } = toolResultFields(
    envelope.raw.result ?? event.result
  );
  const finishedAt = Date.now();
  const status = isError ? 'error' : 'success';
  updateMessageToolCall(event.sessionId, messageId, callId, {
    status,
    output: text,
    ...(diffs ? { diffs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    finishedAt,
    backgrounded: false,
  });
  // 同步流式 lite 条目（承载消息尚在流式时）：防后续流式收口以
  // 占位结果覆盖已回填的终态。无 lite 条目时跳过——setStreamTool
  // 对缺失条目会新建幽灵条目，必须先查存在性
  const streamState = useStreamingStore.getState();
  const key = streamStoreKey(event.sessionId, messageId);
  if (streamState.byKey[key]?.tools?.[callId]) {
    streamState.setStreamTool(event.sessionId, messageId, callId, {
      id: callId,
      status,
      output: text,
      ...(durationMs !== undefined ? { durationMs } : {}),
      finishedAt,
    });
  }
}

export function onToolBatchStart(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'tool-batch-start'>
): void {
  // tool-batch-start 原实现直接 return：显式空实现
}

export function onToolBatchEnd(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'tool-batch-end'>
): void {
  // tool-batch-end 原实现直接 return：显式空实现
}
