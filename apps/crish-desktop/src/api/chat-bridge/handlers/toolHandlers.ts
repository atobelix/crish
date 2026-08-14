/**
 * 工具域 handler（T7 分派表）：tool-start / tool-update / tool-end /
 * tool-batch-start / tool-batch-end / tool-input-repaired。
 *
 * tool-start / tool-end 保留原 toolUtils 的宽容字段抽取（call 嵌套或顶层平铺），
 * 行为与原 16 分支实现完全等价。
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

export function onToolUpdate(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'tool-update'>
): void {
  // tool-update 暂无 UI 落地：显式空实现（原实现无分支、静默放行）
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
