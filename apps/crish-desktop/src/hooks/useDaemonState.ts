/**
 * 合并 OverviewCard / RuntimePanel 共享的 daemon 状态逻辑：
 * - onState 订阅 engineOnline
 * - 每 4s 轮询 fetchEngineLiveStatus + listBackgroundTasks
 * - listWorkflows 加载（仅首次）
 * - 组件卸载时 cleanup
 */
import { useState, useEffect } from 'react';
import { getDesktopDaemonClient } from '../api/daemonClient';
import {
  fetchEngineLiveStatus,
  type ActiveRunInfo,
  type PendingApprovalInfo,
} from '../api/engineStatus';
import { listWorkflows, type WorkflowDefinition } from '../api/workflowApi';
import {
  listBackgroundTasks,
  type BackgroundTaskInfo,
} from '../api/backgroundTasksApi';
import { setScheduledTasks } from '../api/storeAccess';

export interface WorkflowRunInfo {
  id: string;
  workflowId: string;
  status: string;
  startedAt: number;
}

export interface DaemonState {
  engineOnline: boolean;
  activeRuns: ActiveRunInfo[];
  pendingApprovals: PendingApprovalInfo[];
  bgTasks: BackgroundTaskInfo[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRunInfo[];
  loading: boolean;
}

export function useDaemonState(): DaemonState {
  const [engineOnline, setEngineOnline] = useState(() => getDesktopDaemonClient().isConnected());
  const [activeRuns, setActiveRuns] = useState<ActiveRunInfo[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApprovalInfo[]>([]);
  const [bgTasks, setBgTasks] = useState<BackgroundTaskInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowRuns] = useState<WorkflowRunInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // 1. Daemon client subscription
  useEffect(() => {
    const client = getDesktopDaemonClient();
    setEngineOnline(client.isConnected());
    const unsub = client.onState((s) => {
      setEngineOnline(s === 'connected');
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  // 2. Polling engine status + background tasks every 4s
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const [live, bgs] = await Promise.all([
        fetchEngineLiveStatus(),
        listBackgroundTasks().catch(() => [] as BackgroundTaskInfo[]),
      ]);
      if (cancelled) return;
      setEngineOnline(live.connected);
      setActiveRuns(live.activeRuns);
      setPendingApprovals(live.pendingApprovals);
      setBgTasks(bgs);
    };
    void tick();
    const t = setInterval(() => void tick(), 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // 3. Load workflows (once, initial)
  useEffect(() => {
    const loadData = async () => {
      try {
        const wfs = await listWorkflows();
        setWorkflows(wfs);
        setScheduledTasks([]);
      } catch {
        /* silently ignored — component can react via loading flag */
      } finally {
        setLoading(false);
      }
    };
    void loadData();
  }, []);

  return {
    engineOnline,
    activeRuns,
    pendingApprovals,
    bgTasks,
    workflows,
    workflowRuns,
    loading,
  };
}
