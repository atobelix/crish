/**
 * 子代理恢复与控制 API（D4 / D8 连续性恢复控制）。
 *
 * 提供子代理失败后的 resume / kill / kill_all 控制能力：
 * - resumeSubagent: fork 新 run 承接上一目标
 * - killSubagent: 取消指定子代理任务
 * - killAllSubagents: 批量取消主会话下的所有子代理任务
 */
import { invokeResult } from './tauriInvoke';

export type RecoveryAction = 'resume' | 'kill' | 'kill_all';

export function isRecoveryCommandReady(_action: RecoveryAction): boolean {
  return true;
}

export function isAnyRecoveryCommandReady(): boolean {
  return (
    isRecoveryCommandReady('resume') ||
    isRecoveryCommandReady('kill') ||
    isRecoveryCommandReady('kill_all')
  );
}

export async function resumeSubagent(
  parentSessionId: string,
  agentId: string,
  summary?: string
): Promise<{ ok: boolean }> {
  const res = await invokeResult<{ ok?: boolean }>(
    'workbench_resume_subagent',
    {
      parentSessionId,
      agentId,
      summary,
    }
  );
  return { ok: res.status === 'ok' };
}

export async function killSubagent(
  parentSessionId: string,
  agentId: string,
  reason?: string
): Promise<{ ok: boolean }> {
  const res = await invokeResult<{ ok?: boolean }>(
    'workbench_cancel_background_task',
    {
      parentSessionId,
      agentId,
      taskId: agentId,
      reason,
    }
  );
  return { ok: res.status === 'ok' };
}

export async function killAllSubagents(
  parentSessionId: string,
  reason?: string
): Promise<{ ok: boolean }> {
  const res = await invokeResult<{ ok?: boolean }>(
    'workbench_cancel_all_subagents',
    {
      parentSessionId,
      reason,
    }
  );
  return { ok: res.status === 'ok' };
}
