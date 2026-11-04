import { getTransport } from '../transport';
import { parseErr, parseOk, type ParseResult } from '../engineEventSchema';

export type ApprovalResolvedFields = {
  toolCallId: string;
  denied: boolean;
  decision: 'allow' | 'deny';
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * approval-resolved：单一 ParseResult 路径，ok === false 判别。
 * 决策映射（P1 权限归一 D4：旧 PermissionDecision{behavior} 对象解析已删）：
 * - 字符串 approved/allow → 放行；denied/expired/deny → 拒绝；
 * - 非字符串 / 未知 / 缺失决策一律拒绝（绝不伪造放行）；
 * - 空 toolCallId 判失败。
 */
export function parseApprovalResolvedFields(
  event: unknown
): ParseResult<ApprovalResolvedFields> {
  if (!isRecord(event)) {
    return parseErr('approval-resolved payload is not an object');
  }
  const toolCallId = String(
    event.toolCallId ?? event.requestId ?? event.id ?? ''
  ).trim();
  if (!toolCallId) {
    return parseErr('approval-resolved missing toolCallId');
  }
  const decision = event.decision;
  let allowed = false;
  let denied = false;
  if (typeof decision === 'string') {
    const d = decision.trim().toLowerCase();
    if (d === 'approved' || d === 'allow') {
      allowed = true;
    } else if (d === 'denied' || d === 'expired' || d === 'deny') {
      denied = true;
    }
  }
  // Unknown / missing / object-shaped decision → treat as deny (never forge allow)
  if (!allowed && !denied) denied = true;
  return parseOk({
    toolCallId,
    denied,
    decision: allowed ? ('allow' as const) : ('deny' as const),
  });
}

/**
 * 批准工具：乐观 fire-and-forget，不阻塞 UI 8s。
 * IPC 通道：transport.send('core_approve_tool') 命令名直发（T18 后无 WS type 翻译）。
 *
 * 契约（2026-11-03 批 C 第 0 件钉死）：Rust 命令
 * `core_approve_tool(state, run_id: String, tool_call_id: String, decision)`
 * （apps/agent-workbench/src-tauri/src/run_ipc.rs）的 `run_id` 为**必填**
 * 参数——Tauri 在参数反序列化层就会拒绝缺 `runId` 的 invoke，命令体
 * 根本不执行。此前本函数只发 `{ toolCallId, scope }`（WS 时代残留：
 * scope 对现行命令无意义、已被删除），导致一切用户批准/拒绝在到达
 * 引擎前即失败、审批只能等 120s 超时过期。runId 由调用方经
 * `api/chat-approval/approvalRunId.ts` 的 resolveApprovalRunId 解析
 * （申请人 run → 会话活动 run → 会话最近 run）；为空时在此显式抛错，
 * 由调用方既有 catch 走回滚 + 失败 toast，绝不静默发出必死请求。
 * 引擎侧状态仍以 approval-resolved / tool-end 为准。
 */
export async function engineApproveTool(
  toolCallId: string,
  runId: string
): Promise<void> {
  const rid = String(runId ?? '').trim();
  if (!rid) {
    throw new Error(
      `core_approve_tool: runId 缺失（toolCallId=${toolCallId}），裁决未发出`
    );
  }
  await getTransport().send('core_approve_tool', {
    runId: rid,
    toolCallId,
  });
}

/** 拒绝工具：同样不阻塞 UI（transport.send('core_deny_tool') 命令名直发） */
export async function engineDenyTool(
  toolCallId: string,
  runId: string
): Promise<void> {
  const rid = String(runId ?? '').trim();
  if (!rid) {
    throw new Error(
      `core_deny_tool: runId 缺失（toolCallId=${toolCallId}），裁决未发出`
    );
  }
  await getTransport().send('core_deny_tool', {
    runId: rid,
    toolCallId,
  });
}
