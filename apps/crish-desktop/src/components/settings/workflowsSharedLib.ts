/**
 * 定时任务共享纯函数层：缓存读写 / 筛选匹配 / 草稿回填 / 会话占位。
 * 供 useWorkflowsState 与两个壳组件共用，零 React 依赖。
 */
import {
  canReplaceSessionTitleWithScheduled,
  emptyWorkflowDraft,
  scheduledSessionTitle,
  type WorkflowDefinition,
  type WorkflowRunEntry,
  type WorkflowScheduleDraft,
} from '../../api/workflowApi';
import {
  createSession,
  getSessionById,
  renameSession,
} from '../../api/storeAccess';

/** 面板读取计划超时（settings 双计时共用） */
export const WORKFLOWS_LOAD_TIMEOUT_MS = 12_000;

export type WorkflowsSurface = 'settings' | 'chat';

/** chat 面 localStorage 缓存（离线可看上次列表） */
const WORKFLOWS_CACHE_KEY = 'crish_workflows_cache_v1';
const WORKFLOW_RUNS_CACHE_KEY = 'crish_workflow_runs_cache_v1';

export function loadWorkflowsCache(): WorkflowDefinition[] {
  try {
    const raw = localStorage.getItem(WORKFLOWS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveWorkflowsCache(list: WorkflowDefinition[]) {
  try {
    localStorage.setItem(WORKFLOWS_CACHE_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

export function loadWorkflowRunsCache(): WorkflowRunEntry[] {
  try {
    const raw = localStorage.getItem(WORKFLOW_RUNS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveWorkflowRunsCache(list: WorkflowRunEntry[]) {
  try {
    localStorage.setItem(WORKFLOW_RUNS_CACHE_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

export type ScheduleFilter = 'all' | 'enabled' | 'paused' | 'manual' | 'timed';

export const FILTER_OPTIONS: { id: ScheduleFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '启用中' },
  { id: 'paused', label: '暂停' },
  { id: 'manual', label: '仅手动' },
  { id: 'timed', label: '按时间' },
];

function scheduleTypeOf(w: WorkflowDefinition): string {
  const s = w.schedule;
  if (!s || typeof s !== 'object') return 'manual';
  return String((s as { type?: string }).type || 'manual');
}

export function matchesFilter(w: WorkflowDefinition, filter: ScheduleFilter): boolean {
  const enabled = w.enabled !== false;
  const st = scheduleTypeOf(w);
  switch (filter) {
    case 'enabled':
      return enabled;
    case 'paused':
      return !enabled;
    case 'manual':
      return st === 'manual';
    case 'timed':
      return st === 'daily' || st === 'intervalMinutes';
    default:
      return true;
  }
}

/** 从 workflow 回填编辑草稿（daily / intervalMinutes / manual 三态） */
export function draftFromWorkflow(w: WorkflowDefinition): WorkflowScheduleDraft {
  const d = emptyWorkflowDraft();
  d.name = w.name;
  d.prompt = w.prompt || '';
  const s = w.schedule;
  if (s && typeof s === 'object') {
    const sch = s as { type?: string; time?: string; minutes?: number };
    if (sch.type === 'daily') {
      d.scheduleType = 'daily';
      d.dailyTime = sch.time || '';
    } else if (sch.type === 'intervalMinutes') {
      d.scheduleType = 'intervalMinutes';
      d.intervalMinutes = String(sch.minutes ?? '');
    } else {
      d.scheduleType = 'manual';
    }
  } else {
    d.scheduleType = 'manual';
  }
  return d;
}

/**
 * 触发后侧栏占位；不抢当前对话焦点（仅 openRunSession 传 activate:true）。
 * 标题「定时 · name」非默认，不进空壳复用，避免污染「新建」。
 */
export function ensureScheduledSession(
  sessionId: string | undefined,
  workflowName: string,
  opts?: { activate?: boolean },
) {
  if (!sessionId) return;
  const title = scheduledSessionTitle(workflowName);
  createSession({
    id: sessionId,
    title,
    activate: opts?.activate === true,
  });
  // createSession 只升级默认标题；系统「定时 ·」占位也允许按工作流名刷新
  const sess = getSessionById(sessionId);
  if (
    sess &&
    canReplaceSessionTitleWithScheduled(sess.title) &&
    sess.title !== title
  ) {
    renameSession(sessionId, title);
  }
}
