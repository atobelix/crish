import { useState, useEffect } from 'preact/hooks';
import { appState, type TaskSnapshot, type PlanItem, type AcceptanceItem, type EvidenceItem, type ChangeItem, type BackgroundTaskInfo, type TokenBudgetInfo } from '../core/app-state';
import { tauriBridge } from '../core/tauri-bridge';
import { isBackendNotWiredResult } from '../core/tauri-command-registry';
import { showToast } from './ToastContainer';
import {
  IconCheck,
  IconChevronRight,
  IconChevronDown,
  IconSpinner,
  IconFileCode,
  IconFilePlus,
  IconFileMinus,
  IconTerminal,
  IconShield,
} from './icons';

// ==================== 进度条 ====================

function ProgressBar({ percent, label }: { percent: number; label?: string }) {
  return (
    <div class="repl-task-progress-bar-wrap">
      {label && <div class="repl-task-progress-label">{label}</div>}
      <div class="repl-task-progress-track">
        <div
          class={`repl-task-progress-fill ${percent >= 100 ? 'complete' : ''}`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  );
}

// ==================== 计划步骤列表 ====================

function PlanList({ items }: { items: PlanItem[] }) {
  const [expanded, setExpanded] = useState(true);
  if (items.length === 0) return null;

  const doneCount = items.filter(i => i.state === 'done').length;
  return (
    <div class="repl-task-section">
      <div class="repl-task-section-header" onClick={() => setExpanded(!expanded)}>
        <span class="repl-task-section-arrow">{expanded ? <IconChevronDown /> : <IconChevronRight />}</span>
        <span class="repl-task-section-title">计划</span>
        <span class="repl-task-section-badge">{doneCount}/{items.length}</span>
      </div>
      {expanded && (
        <div class="repl-task-section-body">
          {items.map(item => (
            <div key={item.id} class={`repl-task-plan-item ${item.state}`}>
              <span class="repl-task-plan-indicator">
                {item.state === 'done' ? <IconCheck /> :
                 item.state === 'doing' ? <IconSpinner /> :
                 item.state === 'blocked' ? <IconShield /> :
                 <span class="repl-task-plan-dot" />}
              </span>
              <span class="repl-task-plan-title">{item.title}</span>
              {item.note && <span class="repl-task-plan-note">{item.note}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== 验收检查清单 ====================

function AcceptanceList({ items }: { items: AcceptanceItem[] }) {
  const [expanded, setExpanded] = useState(true);
  if (items.length === 0) return null;

  const passedCount = items.filter(i => i.passed).length;
  return (
    <div class="repl-task-section">
      <div class="repl-task-section-header" onClick={() => setExpanded(!expanded)}>
        <span class="repl-task-section-arrow">{expanded ? <IconChevronDown /> : <IconChevronRight />}</span>
        <span class="repl-task-section-title">验收</span>
        <span class="repl-task-section-badge">{passedCount}/{items.length}</span>
      </div>
      {expanded && (
        <div class="repl-task-section-body">
          {items.map(item => (
            <div key={item.id} class={`repl-task-accept-item ${item.passed ? 'passed' : ''}`}>
              <span class="repl-task-accept-indicator">
                {item.passed ? <IconCheck /> : <span class="repl-task-plan-dot" />}
              </span>
              <span class="repl-task-accept-title">{item.title}</span>
              {item.required && !item.passed && <span class="repl-task-accept-required">必填</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== 证据时间线 ====================

function EvidenceList({ items }: { items: EvidenceItem[] }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;

  return (
    <div class="repl-task-section">
      <div class="repl-task-section-header" onClick={() => setExpanded(!expanded)}>
        <span class="repl-task-section-arrow">{expanded ? <IconChevronDown /> : <IconChevronRight />}</span>
        <span class="repl-task-section-title">证据</span>
        <span class="repl-task-section-badge">{items.length}</span>
      </div>
      {expanded && (
        <div class="repl-task-section-body">
          {items.map(item => (
            <div key={item.id} class="repl-task-evidence-item">
              <span class="repl-task-evidence-kind">{item.kind}</span>
              <span class="repl-task-evidence-title">{item.title}</span>
              {item.detail && <span class="repl-task-evidence-detail">{item.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== 变更文件列表 ====================

function ChangesList({ items }: { items: ChangeItem[] }) {
  const [expanded, setExpanded] = useState(true);
  if (items.length === 0) return null;

  return (
    <div class="repl-task-section">
      <div class="repl-task-section-header" onClick={() => setExpanded(!expanded)}>
        <span class="repl-task-section-arrow">{expanded ? <IconChevronDown /> : <IconChevronRight />}</span>
        <span class="repl-task-section-title">变更</span>
        <span class="repl-task-section-badge">{items.length}</span>
      </div>
      {expanded && (
        <div class="repl-task-section-body">
          {items.map((item, i) => (
            <div key={i} class="repl-task-change-item" onClick={() => {
              appState.openRightTab('project');
              appState.setState('rightSidebarVisible', true);
            }}>
              <span class="repl-task-change-icon">
                {item.additions > 0 && item.deletions === 0 ? <IconFilePlus /> :
                 item.deletions > 0 && item.additions === 0 ? <IconFileMinus /> :
                 <IconFileCode />}
              </span>
              <span class="repl-task-change-path">{item.path}</span>
              <span class="repl-task-change-stats">
                {item.additions > 0 && <span class="repl-task-change-add">+{item.additions}</span>}
                {item.deletions > 0 && <span class="repl-task-change-del">-{item.deletions}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== 后台任务 ====================

function BackgroundTasksList({ items }: { items: BackgroundTaskInfo[] }) {
  const [expanded, setExpanded] = useState(false);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [taskOutput, setTaskOutput] = useState<Record<string, string>>({});
  const [cancellingTask, setCancellingTask] = useState<string | null>(null);

  if (items.length === 0) return null;

  async function handleViewOutput(taskId: string) {
    if (expandedTask === taskId) {
      setExpandedTask(null);
      return;
    }
    setExpandedTask(taskId);
    if (!taskOutput[taskId]) {
      const output = await tauriBridge.getBackgroundTaskOutput(taskId);
      setTaskOutput(prev => ({
        ...prev,
        [taskId]: isBackendNotWiredResult(output)
          ? output.diagnostic.message
          : typeof output === 'string'
            ? output
            : String(output),
      }));
    }
  }

  async function handleCancelTask(taskId: string) {
    setCancellingTask(taskId);
    try {
      await tauriBridge.cancelBackgroundTask(taskId);
    } catch (error) {
      showToast('取消后台任务失败', 'error', 4500);
    } finally {
      setCancellingTask(null);
    }
  }

  const stateLabel: Record<string, string> = {
    running: '运行中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    queued: '等待中',
    'timed-out': '超时',
  };

  return (
    <div class="repl-task-section">
      <div class="repl-task-section-header" onClick={() => setExpanded(!expanded)}>
        <span class="repl-task-section-arrow">{expanded ? <IconChevronDown /> : <IconChevronRight />}</span>
        <span class="repl-task-section-title">后台任务</span>
        <span class="repl-task-section-badge">{items.length}</span>
      </div>
      {expanded && (
        <div class="repl-task-section-body">
          {items.map(item => (
            <div key={item.id} class={`repl-task-bg-item ${item.state}`}>
              <div class="repl-task-bg-row">
                <span class="repl-task-bg-icon"><IconTerminal /></span>
                <span class="repl-task-bg-title">{item.title}</span>
                <span class={`repl-task-bg-state ${item.state}`}>{stateLabel[item.state] || item.state}</span>
              </div>
              <div class="repl-task-bg-actions">
                <button class="repl-task-bg-btn" onClick={() => void handleViewOutput(item.id)}>
                  {expandedTask === item.id ? '收起' : '输出'}
                </button>
                {(item.state === 'running' || item.state === 'queued') && (
                  <button
                    class="repl-task-bg-btn danger"
                    onClick={() => void handleCancelTask(item.id)}
                    disabled={cancellingTask === item.id}
                  >
                    {cancellingTask === item.id ? '取消中...' : '取消'}
                  </button>
                )}
              </div>
              {expandedTask === item.id && (
                <div class="repl-task-bg-output">
                  <pre class="repl-task-bg-output-pre">
                    {taskOutput[item.id] || '无输出'}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== Token 预算 ====================

function TokenBudget({ budget }: { budget: TokenBudgetInfo }) {
  if (!budget.enabled) return null;
  const usagePercent = budget.maxTotalTokens > 0 ? (budget.usedTotalTokens / budget.maxTotalTokens) * 100 : 0;

  return (
    <div class="repl-task-section">
      <div class="repl-task-section-header">
        <span class="repl-task-section-title">Token 预算</span>
        {budget.reached && <span class="repl-task-section-badge repl-task-badge-error">已耗尽</span>}
        {budget.warned && !budget.reached && <span class="repl-task-section-badge repl-task-badge-warn">即将耗尽</span>}
      </div>
      <div class="repl-task-section-body">
        <ProgressBar percent={usagePercent} />
        <div class="repl-task-token-row">
          <span>已用 {(budget.usedTotalTokens / 1000).toFixed(1)}k</span>
          <span>上限 {(budget.maxTotalTokens / 1000).toFixed(1)}k</span>
        </div>
        <div class="repl-task-token-detail">
          <span>请求 {budget.requestCount}</span>
          <span>提示 {(budget.promptTokens / 1000).toFixed(1)}k</span>
          <span>补全 {(budget.completionTokens / 1000).toFixed(1)}k</span>
        </div>
      </div>
    </div>
  );
}

// ==================== 主组件 ====================

export default function TaskSnapshotPanel() {
  const [snapshot, setSnapshot] = useState<TaskSnapshot | null>(appState.getState().taskSnapshot);
  const [activeRunId, setActiveRunId] = useState<string | null>(appState.getState().activeRunId);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const u = appState.subscribe('taskSnapshot', setSnapshot);
    return () => u();
  }, []);

  useEffect(() => {
    const u = appState.subscribe('activeRunId', setActiveRunId);
    return () => u();
  }, []);

  // 当有活跃运行时，轮询获取快照
  useEffect(() => {
    if (!activeRunId) return;

    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      if (disposed) return;
      setLoading(true);
      try {
        const response = await tauriBridge.getRunSnapshot({ runId: activeRunId });
        if (!disposed && response?.snapshot) {
          appState.applyDaemonTaskSnapshot(response.snapshot);
        }
      } catch (error) {
        showToast('Refresh daemon task snapshot failed', 'error', 4500);
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    poll();
    timer = setInterval(poll, 3000);
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, [activeRunId]);

  if (!snapshot) {
    return (
      <div class="repl-task-empty">
        <div class="repl-task-empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </div>
        <div class="repl-task-empty-text">运行任务后查看进度</div>
      </div>
    );
  }

  const stateLabel: Record<string, string> = {
    idle: '空闲', planning: '规划中', running: '运行中',
    waiting: '等待中', blocked: '阻塞', done: '已完成',
  };

  return (
    <div class="repl-task-panel">
      {/* 任务头部 */}
      <div class="repl-task-header">
        <div class="repl-task-title">{snapshot.title || '未命名任务'}</div>
        <div class="repl-task-meta">
          <span class={`repl-task-state ${snapshot.state}`}>{stateLabel[snapshot.state] || snapshot.state}</span>
          {loading && <IconSpinner />}
        </div>
      </div>

      {/* 进度 */}
      <div class="repl-task-progress">
        <ProgressBar percent={snapshot.completionPercent} label={snapshot.progressLabel || `完成 ${snapshot.completionPercent}%`} />
      </div>

      {/* 健康状态 */}
      {snapshot.health && snapshot.health.state !== 'good' && (
        <div class={`repl-task-health ${snapshot.health.state}`}>
          {snapshot.health.summary}
        </div>
      )}

      {/* 计划 */}
      <PlanList items={snapshot.plan || []} />

      {/* 验收 */}
      <AcceptanceList items={snapshot.acceptance || []} />

      {/* 变更 */}
      <ChangesList items={snapshot.changes || []} />

      {/* 证据 */}
      <EvidenceList items={snapshot.evidence || []} />

      {/* 后台任务 */}
      <BackgroundTasksList items={snapshot.backgroundTasks || []} />

      {/* Token 预算 */}
      {snapshot.tokenBudget && <TokenBudget budget={snapshot.tokenBudget} />}

      {/* 下一步建议 */}
      {snapshot.nextActions && snapshot.nextActions.length > 0 && (
        <div class="repl-task-section">
          <div class="repl-task-section-header">
            <span class="repl-task-section-title">建议操作</span>
          </div>
          <div class="repl-task-section-body">
            {snapshot.nextActions.map((action, i) => (
              <div key={i} class="repl-task-next-action">{action}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
