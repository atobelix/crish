/**
 * AI 多步进度板：
 * - 进度百分比 / 计数 **仅**来自 goalMode.tasks 或助手 markdown checklist
 * - 每个 shell/读文件工具 **不算** 进度项，只作「当前步骤」一行提示
 * - 本机备忘独立，不计入整体进度
 * - Agent 入口一律 openAgentInSidePanel / openAgentPanelBrowse
 * - 解析规则只读委托 goalModeController，保证 /goal 与任务板同源
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import styles from './TasksCard.module.css';
import * as Lucide from 'lucide-react';
import { Tooltip } from './settings/SettingsUI';
import { useLayoutStore } from '../store/layoutStore';
import {
  selectActiveSession,
  selectActiveSessionId,
  useSessionField,
} from '../store/sessionStore';
import { isDemoMode } from '../api/appMode';
import { toolHumanLabel } from '../api/toolPresentation';
import { openAgentInSidePanel, openAgentPanelBrowse } from '../api/openAgentPanel';
import { emitUiEvent } from '../api/uiEvents';
import type { MessageToolCall, SessionMessage, SessionState } from '../store/layoutStore';
import {
  computeGoalTaskProgress,
  parseChecklistTasks,
} from '../api/goalModeController';

type MemoTask = { id: string; text: string; done: boolean };

export type ChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

/** 进度来源：goal 优先于助手 markdown；工具/备忘永不成为 source */
export type ProgressSource = 'goal' | 'checklist' | 'none';

export type SessionProgressResolved = {
  items: ChecklistItem[];
  source: ProgressSource;
  /** goalMode 是否仍在自动续写 */
  goalActive: boolean;
  /** 有 goal 文案时（含达上限后 inactive）供横幅展示 */
  goalText: string | null;
  goalIteration: number;
  goalMaxIterations: number | null;
};

/** 进度条数据：只吃 checklist/goal items，绝不吃 toolCalls 长度（委托 goal 同源算法） */
export function computeChecklistProgress(items: ChecklistItem[] | undefined | null): {
  total: number;
  done: number;
  open: number;
  pct: number;
} {
  const base = computeGoalTaskProgress(items ?? []);
  const open = Math.max(0, base.total - base.done);
  return { total: base.total, done: base.done, open, pct: base.pct };
}

/** 未完成项数量（清单区「待完成」）；与 computeChecklistProgress.open 对齐 */
export function countOpenChecklistItems(items: ChecklistItem[] | undefined | null): number {
  if (!items?.length) return 0;
  return items.reduce((n, t) => n + (t.done ? 0 : 1), 0);
}

/**
 * 卡片头计数文案。total≤0 时返回 null（由调用方决定「目标中」等兜底）。
 * 仅反映 checklist/goal，不含工具与备忘。
 */
export function formatTasksHeadCountLabel(opts: {
  done: number;
  total: number;
  open: number;
  pct: number;
}): string | null {
  const total = Math.max(0, opts.total | 0);
  if (total <= 0) return null;
  const done = Math.max(0, Math.min(opts.done | 0, total));
  const open = Math.max(0, opts.open | 0);
  const pct = Math.max(0, Math.min(100, opts.pct | 0));
  if (open === 0 && done >= total) return `已完成 · ${done}/${total}`;
  return `${done}/${total}${pct > 0 ? ` · ${pct}%` : ''}${
    open > 0 ? ` · 待完成 ${open}` : ''
  }`;
}

/** 清单 section 右侧计数（与头栏同源 done/total/open） */
export function formatChecklistSectionCount(opts: {
  done: number;
  total: number;
  open: number;
}): string {
  const total = Math.max(0, opts.total | 0);
  const done = Math.max(0, Math.min(opts.done | 0, total));
  const open = Math.max(0, opts.open | 0);
  if (total > 0 && open === 0) return `${done}/${total} · 完成`;
  return `${done}/${total}${open > 0 ? ` · 待 ${open}` : ''}`;
}

/** 无 goal 横幅时的独立进度条 meta（左标签 + 右分数） */
export function formatStandaloneProgressMeta(opts: {
  done: number;
  total: number;
  open: number;
  pct: number;
}): { left: string; right: string } {
  const total = Math.max(0, opts.total | 0);
  const done = Math.max(0, Math.min(opts.done | 0, total));
  const open = Math.max(0, opts.open | 0);
  const pct = Math.max(0, Math.min(100, opts.pct | 0));
  const allDone = total > 0 && open === 0;
  return {
    left: allDone ? '已完成' : '进度',
    right: `${done}/${total} · ${pct}%${open > 0 ? ` · 待 ${open}` : ''}`,
  };
}

/**
 * 目标横幅轮次/结束态文案（1-based 轮次；结束时附缺口）。
 * 只读 progress 字段，不写 store。
 */
export function formatGoalBannerStatus(opts: {
  goalActive: boolean;
  iteration: number;
  maxIterations: number | null;
  openCount: number;
}): { text: string; title?: string } {
  if (opts.goalActive) {
    const iter = Math.max(0, opts.iteration | 0) + 1;
    const max =
      typeof opts.maxIterations === 'number' && opts.maxIterations > 0
        ? `/${opts.maxIterations}`
        : '';
    return { text: `${iter}${max}` };
  }
  const open = Math.max(0, opts.openCount | 0);
  return {
    text: `已结束${open > 0 ? ` · 缺口 ${open}` : ''}`,
    title: '目标模式已结束，保留未完成清单',
  };
}

class SimpleCache<K, V> {
  private map = new Map<K, V>();
  private keys: K[] = [];
  private limit: number;
  constructor(limit = 100) {
    this.limit = limit;
  }
  get(key: K): V | undefined {
    return this.map.get(key);
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.set(key, value);
      return;
    }
    if (this.keys.length >= this.limit) {
      const oldest = this.keys.shift();
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, value);
    this.keys.push(key);
  }
}

const markdownChecklistCache = new SimpleCache<string, ChecklistItem[]>(200);

/**
 * 解析 markdown 任务列表。
 * 与 goalModeController.parseChecklistTasks 同一规则，保证 /goal 与 TasksCard 进度一致。
 */
export function parseMarkdownChecklist(text: string | undefined | null): ChecklistItem[] {
  if (!text) return [];
  const cached = markdownChecklistCache.get(text);
  if (cached) return cached;
  const parsed = parseChecklistTasks(text).map((t) => ({
    id: t.id,
    text: t.text,
    done: t.done,
  }));
  markdownChecklistCache.set(text, parsed);
  return parsed;
}

/** 自后向前找最近一条含 checklist 的助手消息（流式中取最新正文） */
export function findLatestAssistantChecklist(messages: SessionMessage[] | undefined): {
  messageId: string | null;
  items: ChecklistItem[];
} {
  if (!messages?.length) return { messageId: null, items: [] };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.sender !== 'assistant') continue;
    // 用户消息里的 `- [ ]` 永不计入进度；空正文跳过
    if (!(m.text || '').trim()) continue;
    const items = parseMarkdownChecklist(m.text);
    if (items.length > 0) return { messageId: m.id, items };
  }
  return { messageId: null, items: [] };
}

/**
 * 会话进度完整解析：goalMode.tasks 优先，否则最近助手 markdown checklist。
 * 工具调用 / 备忘永不进入 items，也不改变 source。
 */
export function resolveSessionProgress(
  session: Pick<SessionState, 'messages' | 'goalMode'> | null | undefined,
): SessionProgressResolved {
  const gm = session?.goalMode;
  const goalText = gm?.goal?.trim() ? gm.goal.trim() : null;
  const goalActive = Boolean(gm?.active);
  const goalIteration = gm?.iteration ?? 0;
  const goalMaxIterations =
    typeof gm?.maxIterations === 'number' ? gm.maxIterations : null;

  const goalTasks = gm?.tasks;
  if (goalTasks && goalTasks.length > 0) {
    return {
      items: goalTasks.map((t) => ({
        id: t.id,
        text: t.text,
        done: Boolean(t.done),
      })),
      source: 'goal',
      goalActive,
      goalText,
      goalIteration,
      goalMaxIterations,
    };
  }

  const fromMd = findLatestAssistantChecklist(session?.messages).items;
  return {
    items: fromMd,
    source: fromMd.length > 0 ? 'checklist' : 'none',
    goalActive,
    goalText,
    goalIteration,
    goalMaxIterations,
  };
}

/**
 * 会话进度项唯一解析：goalMode.tasks 优先，否则最近助手 markdown checklist。
 * 工具调用 / 备忘永不进入此列表。Overview / ribbon 兼容入口。
 */
export function resolveSessionProgressItems(
  session: Pick<SessionState, 'messages' | 'goalMode'> | null | undefined,
): ChecklistItem[] {
  return resolveSessionProgress(session).items;
}

/** 工具状态短标签（当前工具一行右侧） */
export function formatToolStatusLabel(status: MessageToolCall['status']): string {
  if (status === 'running') return '进行中';
  if (status === 'pending_approval') return '待确认';
  if (status === 'error') return '失败';
  if (status === 'success') return '完成';
  return '步骤';
}

/**
 * 当前工具单行展示：label + 状态；null 表示无 live 工具。
 * 不计进度；不列历史命令。
 */
export function formatLiveToolLine(
  tool: MessageToolCall | null | undefined,
): { label: string; statusLabel: string; isApproval: boolean } | null {
  if (!tool?.id) return null;
  if (tool.status !== 'running' && tool.status !== 'pending_approval') return null;
  return {
    label: toolHumanLabel(tool),
    statusLabel: formatToolStatusLabel(tool.status),
    isApproval: tool.status === 'pending_approval',
  };
}

/**
 * 仅取当前正在执行 / 待确认的单个工具。
 * 优先 pending_approval（用户需动作），否则最近 running；不列历史、不计进度。
 * 主会话与协作 agent 工具一并扫描。
 */
export function findCurrentLiveTool(
  session: Pick<SessionState, 'messages' | 'agents'> | null | undefined,
): MessageToolCall | null {
  if (!session) return null;
  const tools: MessageToolCall[] = [
    ...(session.messages?.flatMap((m) => m.toolCalls || []) || []),
    ...(session.agents || []).flatMap((a) =>
      (a.messages || []).flatMap((m) => m.toolCalls || []),
    ),
  ];
  let latestApproval: MessageToolCall | null = null;
  let latestRunning: MessageToolCall | null = null;
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i];
    if (!t?.id) continue;
    if (t.status === 'pending_approval' && !latestApproval) {
      latestApproval = t;
    } else if (t.status === 'running' && !latestRunning) {
      latestRunning = t;
    }
    if (latestApproval && latestRunning) break;
  }
  return latestApproval || latestRunning;
}

/**
 * 是否展示目标横幅：active 始终展示；inactive 但有未完成 goal 任务时保留文案（达上限缺口）。
 * checklist 源或无文案的收口态不展示横幅。只读，不写 store。
 */
export function shouldShowGoalBanner(
  progress: Pick<SessionProgressResolved, 'goalActive' | 'goalText' | 'items' | 'source'>,
): boolean {
  if (progress.goalActive) return true;
  // 达上限 / 结束后仍有 goal 清单缺口：保留横幅，避免只剩无上下文的勾选
  if (progress.source !== 'goal') return false;
  if (!progress.goalText) return false;
  return countOpenChecklistItems(progress.items) > 0;
}

/** 清单区标题：goal 源用「目标清单」，助手 checklist / none 用「清单」 */
export function checklistSectionTitle(source: ProgressSource): string {
  return source === 'goal' ? '目标清单' : '清单';
}

/**
 * progressbar 中文 aria-valuetext（与计数同源，不读工具/备忘）。
 * 供目标横幅与独立进度条共用，避免只报百分比无分数。
 */
export function formatProgressAriaText(opts: {
  done: number;
  total: number;
  open: number;
  pct: number;
}): string {
  const total = Math.max(0, opts.total | 0);
  const done = Math.max(0, Math.min(opts.done | 0, total));
  const open = Math.max(0, opts.open | 0);
  const pct = Math.max(0, Math.min(100, opts.pct | 0));
  if (total <= 0) return '暂无进度';
  if (open === 0 && done >= total) return `已完成 ${done}/${total}`;
  return `进度 ${done}/${total}，${pct}%${open > 0 ? `，待完成 ${open}` : ''}`;
}

/**
 * 目标横幅右侧分数：完成态「完成」；进行中带 %（密度紧凑，不含「待」以免与缺口文案重复）。
 */
export function formatGoalBannerProgressLabel(opts: {
  done: number;
  total: number;
  open: number;
  pct: number;
}): string {
  const total = Math.max(0, opts.total | 0);
  if (total <= 0) return '';
  const done = Math.max(0, Math.min(opts.done | 0, total));
  const open = Math.max(0, opts.open | 0);
  const pct = Math.max(0, Math.min(100, opts.pct | 0));
  if (open === 0) return `${done}/${total} · 完成`;
  return `${done}/${total} · ${pct}%`;
}

/**
 * 目标进行中但清单尚未落地时：展示空清单区（避免只剩横幅无上下文）。
 * 仅备忘/工具时不占位，避免空「清单」块噪音。
 */
export function shouldShowEmptyChecklistSection(opts: {
  itemCount: number;
  goalActive: boolean;
  showGoalBanner: boolean;
  source: ProgressSource;
}): boolean {
  if ((opts.itemCount | 0) > 0) return false;
  if (opts.goalActive || opts.showGoalBanner) return true;
  return opts.source === 'goal';
}

/** 空清单区中文提示（不发明进度项） */
export function formatEmptyChecklistHint(opts: {
  goalActive: boolean;
  showGoalBanner: boolean;
  source: ProgressSource;
}): string {
  if (opts.goalActive) return '清单生成中，完成后将同步进度';
  if (opts.showGoalBanner || opts.source === 'goal') {
    return '目标已结束，暂无保留清单项';
  }
  return '暂无清单项';
}

/** 协作 Agent 入口：中文标签 + title/aria 同源 */
export function formatAgentBoardLinkLabel(agentCount: number): {
  text: string;
  title: string;
  ariaLabel: string;
} {
  const n = Math.max(0, agentCount | 0);
  if (n <= 1) {
    return {
      text: '协作',
      title: '在侧栏打开协作 Agent',
      ariaLabel: '在侧栏打开协作 Agent',
    };
  }
  return {
    text: `协作 · ${n}`,
    title: `浏览 ${n} 个协作 Agent`,
    ariaLabel: `浏览 ${n} 个协作 Agent`,
  };
}

/** 清单项屏幕阅读标签（完成态可感知） */
export function formatChecklistItemAriaLabel(
  item: Pick<ChecklistItem, 'text' | 'done'>,
): string {
  const t = (item.text || '').trim() || '未命名项';
  return item.done ? `已完成：${t}` : `未完成：${t}`;
}

/**
 * 轻量自动打开：会话首次出现 checklist 时派发 open-tasks（只一次）。
 * 须挂在始终挂载处（如 CardPanel），因 TasksCard 仅在任务页激活时渲染。
 */
export function useSuggestOpenTasksOnChecklist(session: SessionState | undefined): void {
  const firedForSession = useRef<string | null>(null);

  useEffect(() => {
    if (!session?.id) return;
    if (firedForSession.current === session.id) return;
    // 仅在本轮有 processing 助手消息时建议打开，避免历史 hydrate 抢面板
    const hasLive = session.messages?.some(
      (m) => m.sender === 'assistant' && m.status === 'processing',
    );
    if (!hasLive) return;
    const { items } = findLatestAssistantChecklist(session.messages);
    if (items.length === 0) return;
    firedForSession.current = session.id;
    // 轻量：只发事件，由 CardPanel 切换；每会话一次，不反复抢焦点
    try {
      emitUiEvent('open-tasks');
    } catch {
      /* ignore */
    }
  }, [session?.id, session?.messages]);
}

export const TasksCard: React.FC = () => {
  const demo = isDemoMode();
  const activeSessionId = useSessionField(selectActiveSessionId);
  const session = useSessionField(selectActiveSession);
  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const planModeEnabled = useLayoutStore((s) => s.planModeEnabled);
  const planApproved = useLayoutStore((s) => s.planApproved);
  const setPlanApproved = useLayoutStore((s) => s.setPlanApproved);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const inPlanMode = permissionMode === 'plan' || planModeEnabled;

  const agents = session?.agents || [];

  /** 进度唯一来源：goalMode.tasks 优先，否则助手 markdown checklist（工具不计） */
  const progressResolved = useMemo(
    () => resolveSessionProgress(session),
    [session?.messages, session?.goalMode],
  );
  const checklist = progressResolved.items;
  const progressSource = progressResolved.source;

  /** 最多一条当前工具，不计入进度百分比 */
  const currentTool = useMemo(
    () => findCurrentLiveTool(session),
    [session?.messages, session?.agents],
  );
  const liveToolLine = useMemo(() => formatLiveToolLine(currentTool), [currentTool]);

  const [memos, setMemos] = useState<MemoTask[]>(() =>
    demo
      ? [
          { id: 't1', text: '读取并锁定 trigger-injector.ts', done: true },
          { id: 't2', text: '重写 acquireInlineBtn 检测逻辑', done: false },
          { id: 't3', text: '执行构建校验', done: false },
        ]
      : [],
  );
  const [newIncomingTask, setNewIncomingTask] = useState('');
  const [isAddingTask, setIsAddingTask] = useState(false);

  useEffect(() => {
    if (!demo) return;
    setMemos((prev) => prev.map((t) => (t.id === 't2' ? { ...t, done: planApproved } : t)));
  }, [planApproved, demo]);

  // 进度仅统计 AI checklist / goal，不含 shell 工具与备忘
  const {
    total: totalTrack,
    done: doneTrack,
    open: openTrack,
    pct,
  } = useMemo(() => computeChecklistProgress(checklist), [checklist]);
  const doneMemo = memos.filter((t) => t.done).length;

  const showGoalBanner = shouldShowGoalBanner(progressResolved);
  const goalActive = progressResolved.goalActive;
  const progressCountOpts = useMemo(
    () => ({
      done: doneTrack,
      total: totalTrack,
      open: openTrack,
      pct,
    }),
    [doneTrack, totalTrack, openTrack, pct],
  );
  const headCountLabel = useMemo(
    () => formatTasksHeadCountLabel(progressCountOpts),
    [progressCountOpts],
  );
  const goalBannerStatus = useMemo(
    () =>
      formatGoalBannerStatus({
        goalActive,
        iteration: progressResolved.goalIteration,
        maxIterations: progressResolved.goalMaxIterations,
        openCount: openTrack,
      }),
    [
      goalActive,
      progressResolved.goalIteration,
      progressResolved.goalMaxIterations,
      openTrack,
    ],
  );
  const sectionCountLabel = useMemo(
    () =>
      formatChecklistSectionCount({
        done: doneTrack,
        total: totalTrack,
        open: openTrack,
      }),
    [doneTrack, totalTrack, openTrack],
  );
  const standaloneProgressMeta = useMemo(
    () => formatStandaloneProgressMeta(progressCountOpts),
    [progressCountOpts],
  );
  const progressAriaText = useMemo(
    () => formatProgressAriaText(progressCountOpts),
    [progressCountOpts],
  );
  const goalBannerProgressLabel = useMemo(
    () => formatGoalBannerProgressLabel(progressCountOpts),
    [progressCountOpts],
  );
  const agentLink = useMemo(
    () => formatAgentBoardLinkLabel(agents.length),
    [agents.length],
  );
  const showEmptyChecklist = shouldShowEmptyChecklistSection({
    itemCount: checklist.length,
    goalActive,
    showGoalBanner,
    source: progressSource,
  });
  const emptyChecklistHint = formatEmptyChecklistHint({
    goalActive,
    showGoalBanner,
    source: progressSource,
  });

  const empty =
    checklist.length === 0 &&
    !currentTool &&
    memos.length === 0 &&
    !isAddingTask &&
    !showGoalBanner;

  const handleAddTask = () => {
    if (!newIncomingTask.trim()) return;
    setMemos((prev) => [
      ...prev,
      { id: `task-${Date.now()}`, text: newIncomingTask.trim(), done: false },
    ]);
    setNewIncomingTask('');
    setIsAddingTask(false);
  };

  const removeMemo = (id: string) => {
    setMemos((prev) => prev.filter((x) => x.id !== id));
  };

  const openAgentBoard = () => {
    // 与侧栏 / Overview 一致：单 agent 直开；多个先浏览列表
    if (agents.length === 1 && agents[0]?.id) {
      openAgentInSidePanel(agents[0].id, { sessionId: activeSessionId || undefined });
    } else {
      openAgentPanelBrowse({ sessionId: activeSessionId || undefined });
    }
  };

  const listTitle = checklistSectionTitle(progressSource);

  return (
    <div className={styles.card}>
      <div className={`card-subheader ${styles.cardHead}`}>
        <div className={styles.cardHeadLeft}>
          <span className={styles.cardTitle} id="tasks-card-title">
            AI 进度
          </span>
          {headCountLabel ? (
            <Tooltip content="仅统计清单/目标，不含工具与备忘">
              <span
                className={styles.cardCount}
                aria-live="polite"
              >
                {headCountLabel}
              </span>
            </Tooltip>
          ) : goalActive ? (
            <span className={styles.cardCount} aria-live="polite">
              目标进行中
            </span>
          ) : null}
        </div>
        <div className={styles.cardHeadActions}>
          {agents.length > 0 ? (
            <Tooltip content={agentLink.title || ''}>
              <button
                type="button"
                className={styles.agentLink}
                aria-label={agentLink.ariaLabel}
                onClick={openAgentBoard}
              >
                {agentLink.text}
              </button>
            </Tooltip>
          ) : null}
          <Tooltip content={isAddingTask ? '取消添加备忘' : '添加备忘'}>
            <button
              type="button"
              className="sub-btn"
              aria-label={isAddingTask ? '取消添加备忘' : '添加备忘'}
              aria-expanded={isAddingTask}
              onClick={() => setIsAddingTask(!isAddingTask)}
            >
              <Lucide.Plus size={16} aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className={styles.cardBody} aria-labelledby="tasks-card-title">
        {showGoalBanner ? (
          <div
            className={`${styles.goalBanner}${goalActive ? '' : ` ${styles.goalBannerEnded}`}`}
            role="region"
            aria-label={goalActive ? '目标进行中' : '目标已结束'}
            aria-busy={goalActive && totalTrack === 0}
          >
            <div className={styles.goalBannerTop}>
              <Lucide.Target size={14} className={styles.goalIcon} aria-hidden />
              <span className={styles.goalLabel}>目标</span>
              <Tooltip
                content={
                  goalBannerStatus.title ||
                  (goalActive ? `当前轮次 ${goalBannerStatus.text}` : '')
                }
              >
                <span
                  className={styles.goalIter}
                  aria-label={
                    goalActive
                      ? `轮次 ${goalBannerStatus.text}`
                      : goalBannerStatus.text
                  }
                >
                  {goalActive ? `轮次 ${goalBannerStatus.text}` : goalBannerStatus.text}
                </span>
              </Tooltip>
            </div>
            <Tooltip content={progressResolved.goalText || '（未设置目标）'}>
              <div className={styles.goalText}>
                {progressResolved.goalText || '（未设置目标）'}
              </div>
            </Tooltip>
            {totalTrack > 0 ? (
              <div className={styles.goalProgress}>
                <div
                  className={styles.progressTrack}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  aria-valuetext={progressAriaText}
                  aria-label="目标进度"
                >
                  <div className={styles.progressFill} style={{ width: `${pct}%` }} />
                </div>
                <Tooltip content={progressAriaText}>
                  <span className={styles.goalPct}>
                    {goalBannerProgressLabel}
                  </span>
                </Tooltip>
              </div>
            ) : null}
          </div>
        ) : null}

        {inPlanMode ? (
          <div className={styles.planBanner} role="region" aria-label="计划模式">
            <div className={styles.planBannerT}>
              计划模式 · 只规划不改文件
              {planApproved ? ' · 已批准' : ''}
            </div>
            <div className={styles.planBannerActions}>
              <button
                type="button"
                className={`overview-chip ${planApproved ? 'active' : ''}`}
                aria-pressed={planApproved}
                aria-label="批准计划并开始执行"
                onClick={() => {
                  setPermissionMode('ask');
                  setPlanApproved(true);
                }}
              >
                批准执行
              </button>
            </div>
          </div>
        ) : planApproved ? (
          <div
            className={`${styles.planStatus} ${styles.planStatusSolo}`}
            role="status"
          >
            <span className={`${styles.planStatusDot} ${styles.isYes}`} aria-hidden />
            <span>计划已批准 · 可执行</span>
          </div>
        ) : null}

        {empty ? (
          <div className={styles.empty} role="status">
            <div className={styles.emptyTitle}>暂无进度</div>
            <div className={styles.emptySub}>
              AI 用 <code>- [ ]</code> 清单或 <code>/goal</code> 同步进度；工具调用与备忘不计进度。
            </div>
          </div>
        ) : null}

        {isAddingTask ? (
          <div className={styles.addRow}>
            <input
              className="settings-field-input"
              style={{ flex: 1 }}
              placeholder="新备忘…"
              aria-label="备忘内容"
              value={newIncomingTask}
              onChange={(e) => setNewIncomingTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddTask();
                if (e.key === 'Escape') {
                  setIsAddingTask(false);
                  setNewIncomingTask('');
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              aria-label="确认添加备忘"
              onClick={handleAddTask}
            >
              添加
            </button>
          </div>
        ) : null}

        {/* 无 goal 条时才单独显示进度条，避免与 goal 区重复 */}
        {!showGoalBanner && totalTrack > 0 ? (
          <div className={styles.progressBlock}>
            <div className={styles.progressMeta}>
              <span>{standaloneProgressMeta.left}</span>
              <span>{standaloneProgressMeta.right}</span>
            </div>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-valuetext={progressAriaText}
              aria-label="清单进度"
            >
              <div className={styles.progressFill} style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : null}

        {checklist.length > 0 ? (
          <section className={styles.section} aria-label={listTitle}>
            <div className={styles.sectionH}>
              <span>{listTitle}</span>
              <span className={styles.sectionCount}>{sectionCountLabel}</span>
            </div>
            <ul className={styles.checklist}>
              {checklist.map((item) => (
                <li
                  key={item.id}
                  className={`${styles.checkItem} ${item.done ? styles.isDone : ''}`}
                  aria-label={formatChecklistItemAriaLabel(item)}
                >
                  <span
                    className={`${styles.checkMark} ${item.done ? styles.checked : ''}`}
                    aria-hidden
                  >
                    {item.done ? <Lucide.Check size={12} strokeWidth={2.5} /> : null}
                  </span>
                  <span className={styles.checkText}>{item.text}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : showEmptyChecklist ? (
          <section className={styles.section} aria-label={listTitle}>
            <div className={styles.sectionH}>
              <span>{listTitle}</span>
              <span className={styles.sectionCount}>0 项</span>
            </div>
            <p className={styles.emptySub} role="status" style={{ margin: '4px 0 0' }}>
              {emptyChecklistHint}
            </p>
          </section>
        ) : null}

        {/* 当前工具仅一行，不计入进度、不列历史命令 */}
        {liveToolLine ? (
          <Tooltip content="工具调用不计进度">
            <div
              className={`${styles.liveTool}${liveToolLine.isApproval ? ` ${styles.isApproval}` : ''}`}
              role="status"
              aria-live="polite"
              aria-label={`当前步骤：${liveToolLine.label}，${liveToolLine.statusLabel}（不计进度）`}
            >
              <span
                className={`${styles.stepDot} ${liveToolLine.isApproval ? styles.err : styles.live}`}
                aria-hidden
              />
              <Tooltip content={liveToolLine.label}>
                <span className={styles.liveToolLabel}>
                  {liveToolLine.label}
                </span>
              </Tooltip>
              <span className={styles.liveToolMeta}>{liveToolLine.statusLabel}</span>
            </div>
          </Tooltip>
        ) : null}

        {/* 仅有备忘时才出区；添加行已在上方，避免空「备忘」块 */}
        {memos.length > 0 ? (
          <section className={`${styles.section} ${styles.sectionMemo}`} aria-label="备忘">
            <div className={styles.sectionH}>
              <span>备忘</span>
              <span className={styles.sectionCount}>
                {doneMemo}/{memos.length} · 不计进度
              </span>
            </div>
            <div className={styles.memoList}>
              {memos.map((t) => (
                <div
                  key={t.id}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 4, minWidth: 0 }}
                >
                  <label className={styles.memoItem} style={{ flex: 1, minWidth: 0 }}>
                    <input
                      type="checkbox"
                      checked={t.done}
                      aria-label={t.done ? `取消完成：${t.text}` : `标为完成：${t.text}`}
                      onChange={() =>
                        setMemos((prev) =>
                          prev.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)),
                        )
                      }
                    />
                    <span className={t.done ? styles.isDone : ''}>{t.text}</span>
                  </label>
                  <Tooltip content="删除备忘">
                    <button
                      type="button"
                      className="sub-btn"
                      aria-label={`删除备忘：${t.text}`}
                      onClick={() => removeMemo(t.id)}
                      style={{ flexShrink: 0, padding: 2, opacity: 0.7 }}
                    >
                      <Lucide.X size={12} strokeWidth={2} aria-hidden />
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
};
