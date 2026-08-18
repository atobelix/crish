/**
 * AgentCard 运行中 daemon 状态轮询 hook（兜底 UI 纠正 status）。
 * 从 AgentCard.tsx 拆出以收敛单文件行数。
 */
import { useEffect, useRef } from 'react';
import type { SessionAgent } from '../../store/types';
import { getSubagentStatus } from '../../api/subagentApi';
import { getSessionAgent } from '../../store/storeAccess';
import type { useSessionStore } from '../../store/sessionStore';

type PatchSessionAgent = ReturnType<typeof useSessionStore.getState>['patchSessionAgent'];

/**
 * 运行中轮询 daemon 状态（兜底 UI 纠正 status）。
 * 仅当本地仍显示 running 且 daemon 已终态时纠正为 completed/failed/stopped。
 */
export function useAgentCardStatusPoll(
  agent: SessionAgent | undefined,
  sessId: string | undefined,
  patchSessionAgent: PatchSessionAgent,
): React.MutableRefObject<ReturnType<typeof setInterval> | null> {
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!agent || agent.status !== 'running' || !agent.subagentRunId) return;
    const poll = async () => {
      const st = await getSubagentStatus(agent.subagentRunId);
      if (!st || !sessId) return;
      if (st.status && st.status !== 'running' && st.status !== 'unknown') {
        // 仅当仍显示 running 时纠正
        const live = getSessionAgent(sessId, agent.id);
        if (
          live?.status === 'running' &&
          /complete|success|failed|cancel|error|stopp?ed|abort/i.test(st.status)
        ) {
          const raw = String(st.status);
          const nextStatus: 'completed' | 'failed' | 'stopped' =
            /cancel|stopp?ed|abort/i.test(raw)
              ? 'stopped'
              : /fail|error/i.test(raw)
                ? 'failed'
                : 'completed';
          const agentSummary =
            live.summary ||
            st.latestError ||
            st.progress ||
            (nextStatus === 'stopped' ? '已停止' : undefined);
          patchSessionAgent(sessId, agent.id, {
            status: nextStatus,
            endedAt: Date.now(),
            ...(agentSummary !== undefined ? { summary: agentSummary } : {}),
          });
        }
      }
    };
    void poll();
    statusPollRef.current = setInterval(() => void poll(), 4000);
    return () => {
      if (statusPollRef.current) clearInterval(statusPollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 轮询只依赖已列出的字段，纳入整个对象会因无关变更重启轮询
  }, [
    agent?.id,
    agent?.status,
    agent?.subagentRunId,
    sessId,
    patchSessionAgent,
  ]);

  return statusPollRef;
}
