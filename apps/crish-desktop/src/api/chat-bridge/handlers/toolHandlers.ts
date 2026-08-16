/**
 * 工具域 handler（T7 分派表）：tool-start / tool-end /
 * tool-batch-start / tool-batch-end。
 *
 * tool-start / tool-end 保留原 toolUtils 的宽容字段抽取（call 嵌套或顶层平铺），
 * 行为与原 16 分支实现完全等价。
 *
 * > 统一输入流收敛战役 R1：tool-update 死契约删除（前端零消费空实现随删）。
 */
import { toolCallFieldsFromEvent, toolResultFields } from './toolUtils';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

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
  const { id, text, isError, diffs } = toolResultFields(resultPayload);
  if (!id || !id.trim()) return;
  const toolId = id.trim();
  approvalFlow.dispatch({ type: 'tool_end', toolId });
  if (isError) callbacks.onToolError(toolId, text || 'failed');
  else callbacks.onToolSuccess(toolId, text || '', diffs);
  tryResumeFinish();
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
