/**
 * 安全审计域 handler（I3-S9 任务 4）：security-audit → securityAuditStore。
 *
 * I2-S8 先在 dispatch 注册显式空实现（宽容静默），本任务替换为真实消费：
 * 审计事件（删除/恢复/清除/回退/命令执行处置）写入 store，供
 * SecurityAuditSection（RuntimePanel 区段）展示。
 */
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { useSecurityAuditStore } from './securityAuditStore';

export function onSecurityAudit(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'security-audit'>
): void {
  const e = envelope.event;
  useSecurityAuditStore.getState().push({
    sessionId: e.sessionId,
    timestamp: e.timestamp,
    operation: e.operation,
    decision: e.decision,
    targets: e.targets ?? [],
    impact: e.impact,
    ...(e.permissionMode !== undefined && { permissionMode: e.permissionMode }),
    ...(e.toolCallId !== undefined && { toolCallId: e.toolCallId }),
  });
}
