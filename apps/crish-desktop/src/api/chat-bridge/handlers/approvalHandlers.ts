/**
 * 审批域 handler（T7 分派表）：approval-requested / approval-resolved。
 *
 * approval-requested 保留宽容形态（嵌套 request 或平铺 daemon WS 形状），
 * 参数抽取逻辑与原 16 分支实现完全等价。
 *
 * P1 权限归一（B1/D1，前端二次决策 1→0）：**前端不再替用户决定「引擎已判
 * NeedsApproval 的操作」**——白名单命中即直发引擎批准命令的自动放行分支
 * 已下线；本 handler 只承担两种职责：展示审批卡片（approval_pending +
 * onToolPendingApproval / onToolStart）+ 转呈用户裁决（approve/deny 按钮 →
 * engineApproveTool / engineDenyTool）。审批权威 = 引擎
 * ApprovalGateImpl::resolve 单一 pending 校验（竞态红线测试锁定）。
 */
import { logInternalError } from '../../userFacingErrors';
import { getPermissionMode } from '../../storeAccess';
import { extractApprovalCommandArgs } from '../../engineEventSchema';
import { parseApprovalRiskMeta } from '../../approvalMeta';
import { parseApprovalPayload } from '../../approvalPayload';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function onApprovalRequested(
  env: HandlerEnv,
  envelope: EngineEnvelope<'approval-requested'>
): void {
  const { approvalFlow, callbacks } = env;
  const { event, raw } = envelope;
  const req = isRecord(raw.request) ? raw.request : raw;
  const toolCallId = event.request.toolCallId.trim();
  if (!toolCallId) {
    logInternalError(
      'engine-protocol',
      'approval-requested missing toolCallId'
    );
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
  // S9：宽容解析审批载荷（revertGate 面积 / 删除影响面）；无载荷 → null，
  // approvalMeta 不带 payload（卡渲染走既有行为，不新增噪音）
  const payload = parseApprovalPayload(raw);
  const approvalMeta = parseApprovalRiskMeta(raw);
  const metaWithPayload = payload ? { ...approvalMeta, payload } : approvalMeta;

  if (approvalFlow.debugSets().pending.includes(toolCallId)) {
    return;
  }

  const perm = getPermissionMode();
  if (perm === 'plan') {
    callbacks.onToolStart(toolCallId, toolName, args, explanation);
    return;
  }

  // P1 权限归一（D1）：默认展示审批卡片，让用户在 UI 明确批准——不再有
  // 白名单命中即直发引擎批准命令的自动放行分支；裁决唯一入口 =
  // 用户 approve/deny 按钮（engineApproveTool / engineDenyTool）
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
      metaWithPayload
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
