/**
 * 合并 OverviewCard / RuntimePanel 共享的引擎状态逻辑。
 *
 * 使用 React 18 官方 `useSyncExternalStore` 范式：
 * - 模块级单例 + refcount 生命周期管理
 * - 零 useState，零 useEffect 级联 bump，绝无 Lanes 级联死循环风险
 * - _setState 内做浅比较拦截，数据未变不通知组件
 * - document.visibilityState === 'hidden' 时跳过轮询
 */
import { useSyncExternalStore } from 'react';
import { getTransport } from '../api/transport';
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

export interface WorkflowRunInfo {
  id: string;
  workflowId: string;
  status: string;
  startedAt: number;
}

export interface EngineState {
  engineOnline: boolean;
  activeRuns: ActiveRunInfo[];
  pendingApprovals: PendingApprovalInfo[];
  bgTasks: BackgroundTaskInfo[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRunInfo[];
  loading: boolean;
}

const EMPTY_BG_TASKS: BackgroundTaskInfo[] = Object.freeze(
  []
) as unknown as BackgroundTaskInfo[];

/**
 * bgTasks 内容级比较（轮询身份抖动防护，A6-M03）。
 *
 * dedupeBackgroundTasksById 恒返回新数组（空列表也返回新 `[]`），
 * 直接入列会让 _setState 的浅等防护（引用比较）被击穿——
 * 每 4s 轮询全订阅者重渲。入列前先做内容级比较：
 * length 相同 + 逐项引用比较，不等退 JSON 序列化相等。
 */
function _sameBgTasksContent(
  a: readonly BackgroundTaskInfo[],
  b: readonly BackgroundTaskInfo[],
): boolean {
  if (a.length !== b.length) return false;
  let refSame = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      refSame = false;
      break;
    }
  }
  if (refSame) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * bgTasks 入列前身份归一：
 * - 空列表复用模块级 EMPTY_BG_TASKS（catch 分支与正常「内容空」分支同源）；
 * - 与当前内容级相等 → 复用当前引用（浅等防护生效，不触发订阅者）；
 * - 内容真实变化 → 放行新引用（通知订阅者）。
 */
function _normalizeBgTasks(next: BackgroundTaskInfo[]): BackgroundTaskInfo[] {
  if (next.length === 0) return EMPTY_BG_TASKS;
  if (_sameBgTasksContent(next, _state.bgTasks)) return _state.bgTasks;
  return next;
}

// ─── 模块级单例 ────────────────────────────────────────────────

let _refCount = 0;
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _unsubState: (() => void) | null = null;
let _workflowsLoaded = false;

type Listener = () => void;
const _listeners = new Set<Listener>();

let _state: EngineState = {
  engineOnline: false,
  activeRuns: [],
  pendingApprovals: [],
  bgTasks: EMPTY_BG_TASKS,
  workflows: [],
  workflowRuns: [],
  loading: true,
};

function _notify(): void {
  for (const l of _listeners) l();
}

function _setState(patch: Partial<EngineState>): void {
  const next = { ..._state, ...patch };

  // 浅等防护：如果核心字段完全一致，直接拦截，避免触发无意义的 React 组件重渲
  if (
    _state.engineOnline === next.engineOnline &&
    _state.loading === next.loading &&
    _state.activeRuns === next.activeRuns &&
    _state.pendingApprovals === next.pendingApprovals &&
    _state.bgTasks === next.bgTasks &&
    _state.workflows === next.workflows &&
    _state.workflowRuns === next.workflowRuns
  ) {
    return;
  }

  _state = next;
  _notify();
}

async function _tick(): Promise<void> {
  // 后台标签页跳过，避免浪费网络和 CPU
  if (
    typeof document !== 'undefined' &&
    document.visibilityState === 'hidden'
  ) {
    return;
  }
  try {
    const [live, bgs] = await Promise.all([
      fetchEngineLiveStatus(),
      listBackgroundTasks().catch(() => EMPTY_BG_TASKS),
    ]);
    _setState({
      engineOnline: live.connected,
      activeRuns: live.activeRuns,
      pendingApprovals: live.pendingApprovals,
      bgTasks: _normalizeBgTasks(bgs),
    });
  } catch {
    // 网络错误保留上次状态，不写新空对象
  }
}

async function _loadWorkflows(): Promise<void> {
  if (_workflowsLoaded) return;
  _workflowsLoaded = true;
  try {
    const wfs = await listWorkflows();
    _setState({ workflows: wfs, loading: false });
  } catch {
    _setState({ loading: false });
  }
}

function _startSingleton(): void {
  const transport = getTransport();
  _setState({ engineOnline: transport.isReady() });
  _unsubState = transport.onStatus((s) =>
    _setState({ engineOnline: s === 'connected' })
  );
  void _tick();
  void _loadWorkflows();
  _intervalId = setInterval(() => void _tick(), 4000);
}

function _stopSingleton(): void {
  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  if (_unsubState !== null) {
    _unsubState();
    _unsubState = null;
  }
  _workflowsLoaded = false;
  _state = { ..._state, loading: true };
}

function _subscribe(listener: Listener): () => void {
  _refCount++;
  if (_refCount === 1) {
    _startSingleton();
  }
  _listeners.add(listener);

  return () => {
    _listeners.delete(listener);
    _refCount = Math.max(0, _refCount - 1);
    if (_refCount === 0) {
      _stopSingleton();
    }
  };
}

function _getSnapshot(): EngineState {
  return _state;
}

// ─── React 18 标准 useSyncExternalStore 接口 ─────────────────

export function useEngineState(): EngineState {
  return useSyncExternalStore(_subscribe, _getSnapshot, _getSnapshot);
}
