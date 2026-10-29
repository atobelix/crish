/**
 * RuntimePanel 数据 hook：liveTasks 跨 sessions+activeRuns 合并、用量数据收拢、
 * 1s 时钟 tick、区段计数标签与会话聚焦动作。
 * 渲染层（RuntimeSection 基座 + 4 个业务 Section）不持有这些派生逻辑。
 */
import { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../store/storeAccess';
import {
  useSettingsField,
  selectScheduledTasks,
  selectTokenUsage,
} from '../../store/storeAccess';
import { clearAgentPanelFocus } from '../../api/openAgentPanel';
import { setActiveSessionId } from '../../api/storeAccess';
import { resolveDisplayModelId } from '../../api/providerProfiles';
import { useEngineState } from '../../hooks/useEngineState';
import { formatSectionCount } from './runtimePanelLib';

export type LiveTask = {
  id: string;
  taskName: string;
  elapsedSeconds: number;
  sessionId?: string | undefined;
  kind: 'session' | 'run';
};

export type UseRuntimePanelDataResult = {
  liveTasks: LiveTask[];
  /** 计划总数 = 引擎 workflow + 本地 cron */
  planCount: number;
  liveCountLabel: string | null;
  bgCountLabel: string | null;
  planCountLabel: string | null;
  approvalCountLabel: string | null;
  tokenPercent: number;
  /** 引擎费用三态展示串（formattedTotal / 「未定价」/「免费」） */
  estimated: string;
  /** 聚焦会话：写 store + 清面板焦点 + 派发切换事件 */
  focusSession: (sessionId: string) => void;
};

export function useRuntimePanelData(): UseRuntimePanelDataResult {
  const cronJobs = useSettingsField(selectScheduledTasks);
  const tokenUsage = useSettingsField(selectTokenUsage);
  const sessions = useSessionStore((state) => state.sessions);
  const ds = useEngineState();

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const liveTasks = useMemo(() => {
    const fromMessages: LiveTask[] = [];
    for (const s of sessions) {
      for (const m of s.messages || []) {
        if (m.status === 'processing') {
          fromMessages.push({
            id: m.id,
            taskName: s.title || '对话进行中',
            elapsedSeconds: Math.max(
              0,
              Math.round((now - (m.timestamp || now)) / 1000)
            ),
            sessionId: s.id,
            kind: 'session',
          });
        }
      }
    }
    // 合并引擎 activeRuns（不用英文 status 作标题）
    for (const r of ds.activeRuns) {
      if (fromMessages.some((t) => t.id === r.runId)) continue;
      const started =
        typeof r.startedAt === 'number'
          ? r.startedAt
          : typeof r.startedAt === 'string'
            ? Date.parse(r.startedAt) || now
            : now;
      const matched = sessions.find(
        (s) => s.engineLastRunId === r.runId || s.id === r.sessionId
      );
      const rawName = (matched?.title || r.prompt || '').trim();
      fromMessages.push({
        id: r.runId,
        taskName: (rawName || '引擎任务').slice(0, 48),
        elapsedSeconds: Math.max(0, Math.round((now - started) / 1000)),
        sessionId: matched?.id || r.sessionId,
        kind: 'run',
      });
    }
    return fromMessages;
  }, [sessions, ds.activeRuns, now]);

  const focusSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    clearAgentPanelFocus();
    try {
      window.dispatchEvent(
        new CustomEvent('crish-focus-chat', { detail: { sessionId } })
      );
    } catch {
      /* ignore */
    }
  };

  const modelId = resolveDisplayModelId() || 'unknown';
  // plans/05 T5.4：费用只渲染引擎三态（formattedTotal / 未定价 / 免费），
  // 禁止 JS 估算与 `$` + toFixed
  const estimated =
    tokenUsage.costStatus === 'priced'
      ? (tokenUsage.formattedCost ?? '')
      : tokenUsage.costStatus === 'free'
        ? '免费'
        : '未定价';
  void modelId;

  const tokenPercent = Math.min(
    100,
    Math.max(
      0,
      Math.round((tokenUsage.input / (tokenUsage.inputMax || 160000)) * 100)
    )
  );

  const planCount = ds.workflows.length + cronJobs.length;

  return {
    liveTasks,
    planCount,
    liveCountLabel: formatSectionCount(liveTasks.length),
    bgCountLabel: formatSectionCount(ds.bgTasks.length),
    planCountLabel: formatSectionCount(planCount),
    approvalCountLabel: formatSectionCount(ds.pendingApprovals.length),
    tokenPercent,
    estimated,
    focusSession,
  };
}
