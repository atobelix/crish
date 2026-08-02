/**
 * 审批域 handler（T7 分派表）：approval-requested / approval-resolved。
 *
 * approval-requested 保留宽容形态（嵌套 request 或平铺 daemon WS 形状），
 * 参数抽取与白名单自动放行逻辑与原 16 分支实现完全等价。
 */
import {
  commandMatchesWhitelist,
  extractCommandForMatch,
} from '../../commandPermissions';
import { getCommandPermissions, getPermissionMode } from '../../storeAccess';
import { logInternalError } from '../../userFacingErrors';
import { extractApprovalCommandArgs } from '../../engineEventSchema';
import { parseApprovalRiskMeta } from '../../approvalMeta';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function onApprovalRequested(
  env: HandlerEnv,
  envelope: EngineEnvelope<'approval-requested'>
): void {
  const { approvalFlow, callbacks, client } = env;
  const { event, raw } = envelope;
  const req = isRecord(raw.request) ? raw.request : raw;
  const toolCallId = event.request.toolCallId.trim();
  if (!toolCallId) {
    logInternalError('engine-protocol', 'approval-requested missing toolCallId');
    return;
  }
  const toolName = event.request.toolName.trim() || 'command';
  const hasParameters =
    isRecord(event.request.parameters) &&
    Object.keys(event.request.parameters).length > 0;
  const args = extractApprovalCommandArgs(
    hasParameters ? { ...req, parameters: event.request.parameters } : req
  );
  const explanation = String(
    req.summary ?? req.reason ?? req.message ?? toolName
  ).trim();
  const approvalMeta = parseApprovalRiskMeta(raw);

  if (approvalFlow.debugSets().pending.includes(toolCallId)) {
    return;
  }

  const perm = getPermissionMode();
  if (perm === 'plan') {
    callbacks.onToolStart(toolCallId, toolName, args, explanation);
    return;
  }

  {
    const line = extractCommandForMatch(toolName, args);
    if (commandMatchesWhitelist(line, getCommandPermissions())) {
      callbacks.onToolStart(
        toolCallId,
        toolName,
        args,
        explanation ? `${explanation}（白名单自动允许）` : '白名单自动允许'
      );
      // 白名单自动放行：经 transport 直发 core_approve_tool（命令名直传，T18）
      void client
        ?.send('core_approve_tool', { toolCallId, scope: 'project' })
        .catch(() => {
          approvalFlow.dispatch({
            type: 'approval_pending',
            toolId: toolCallId,
          });
          if (callbacks.onToolPendingApproval) {
            callbacks.onToolPendingApproval(
              toolCallId,
              toolName,
              args,
              explanation,
              approvalMeta
            );
          }
        });
      return;
    }
  }

  approvalFlow.dispatch({
    type: 'approval_pending',
    toolId: toolCallId,
  });
  if (callbacks.onToolPendingApproval) {
    callbacks.onToolPendingApproval(
      toolCallId,
      toolName,
      args,
      explanation,
      approvalMeta
    );
  } else {
    callbacks.onToolStart(toolCallId, toolName, args, explanation);
  }
}

export function onApprovalResolved(
  env: HandlerEnv,
  envelope: EngineEnvelope<'approval-resolved'>
): void {
  const { state, approvalFlow, callbacks, finish, tryResumeFinish } = env;
  if (state.cancelled || state.finished) return;
  const event = envelope.event;
  const toolCallId = event.toolCallId.trim();
  if (!toolCallId) {
    logInternalError('engine-protocol', 'approval-resolved missing toolCallId');
    return;
  }
  const denied = event.decision !== 'approved';
  approvalFlow.dispatch({
    type: 'approval_resolved',
    toolId: toolCallId,
    denied,
  });
  if (callbacks.onApprovalResolved) {
    callbacks.onApprovalResolved(toolCallId, denied ? 'deny' : 'allow');
  }
  if (
    denied &&
    approvalFlow.isDeferredTerminal() &&
    !approvalFlow.hasPending()
  ) {
    finish(false);
  } else if (approvalFlow.snapshot().sawRunTerminal) {
    tryResumeFinish();
  }
}
