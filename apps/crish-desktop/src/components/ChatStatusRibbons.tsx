/**
 * 对话页脚顶部状态条：引擎软提示、计划/目标模式、回到底部 FAB、
 * 系统 run 提示、审批 sticky 条。
 * 从 ChatCard 抽出以降低巨石组件变更风险；不含输入区（ChatComposer）。
 *
 * 引导态（密钥 / 手填模型）只用页内 soft-hint，禁止 toast 刷屏。
 * FirstRun 盖层打开时让位给向导（见 isFirstRunOverlayOpen）。
 */
import React, { useEffect, useState, useMemo } from 'react';
import styles from './ChatStatusRibbons.module.css';
import * as Lucide from 'lucide-react';
import type { EngineStatus } from '../api/engineConfig';
import type { RunNotice } from '../hooks/useChatStream';
import { openAgentInSidePanel } from '../api/openAgentPanel';
import { getSessionById } from '../store/sessionStore';
import {
  listBackgroundTasks,
  isBackgroundTaskActive,
  type BackgroundTaskInfo,
} from '../api/backgroundTasksApi';
import {
  resolveSessionProgressItems,
  computeChecklistProgress,
} from '../api/sessionProgressApi';
import {
  resolveNeedsKeySoftHintText,
  resolveNeedsModelSoftHintText,
  shouldShowNeedsKeySoftHint,
  shouldShowNeedsModelSoftHint,
} from '../api/chatEmptyState';
import { isFirstRunOverlayOpen } from './FirstRunWizard';

export type ChatStatusRibbonsProps = {
  onOpenTerminal?: () => void;
  onOpenDiff?: () => void;
  diffCount?: number;
  /** 引擎状态（软提示三条分支） */
  engineHint: EngineStatus | null;
  /** 本地未配密钥且引擎也无密钥 */
  needsKeySetup: boolean;
  /** 已有密钥但本机无可用模型（可手填） */
  needsModelSetup?: boolean;
  /**
   * 主列是否处于空态：true 时 soft-hint 用更短文案，避免与欢迎面叠两段引导。
   * 未传时按「非空」长文案。
   */
  onEmptySurface?: boolean;
  /** 本地任一 profile 已有密钥（用于「同步到引擎」提示） */
  localHasKey: boolean;
  onOpenModelSettings: () => void;
  onOpenModelDropdown: () => void;

  /** 计划模式条 */
  inPlanMode: boolean;
  planApproved: boolean;
  onApprovePlan: () => void;

  /** 目标模式条 */
  goalModeActive: boolean;
  goalText: string;
  goalIteration: number;
  /** 与 TasksCard 同源：done/total；无清单时不展示分数 */
  goalTasksDone?: number;
  goalTasksTotal?: number;
  onStopGoal: () => void;

  /** 回到最新 FAB */
  showScrollToBottom: boolean;
  onScrollToBottom: () => void;

  /** 系统 run 提示（错误/空回复等） */
  runNotice: RunNotice | null;
  onDismissRunNotice: () => void;

  /** 审批 sticky 条（队列/子任务跳转；单条主时间线内联卡时不展示，避免重复） */
  pendingApprovalCount: number;
  /**
   * 是否显示 dock。默认 false（安全：漏传时不双渲染；ChatCard 须显式传入 shouldShowApprovalDock）。
   */
  showApprovalDock?: boolean;
  /**
   * dock 完整文案（含「N 待审批 · 队列/协作…」）。
   * 由 chatApprovalUi.approvalDockLabel 生成；勿再拼前缀。
   */
  pendingApprovalSummary: string;
  pendingApprovalToolId: string;
  pendingApprovalMsgId: string;
  activeSessionId: string | null | undefined;
  /** 仅错误级提示（如找不到审批目标）；成功路径禁止 toast */
  onShowToast: (message: string) => void;

  /**
   * 插在 FAB 与 run 提示之间的内容（如 DemoChrome），
   * 用于保持抽出前 DOM 顺序。
   */
  between?: React.ReactNode;
};

/** setup soft-hint 互斥种类（data-setup-hint）；null = 不展示任何 setup 条。 */
export type SetupHintKind =
  | 'engine-down'
  | 'needs-key'
  | 'needs-model'
  | 'sync-engine';

/**
 * 单一出口：setup soft-hint 优先级（最多一条）。
 * FirstRun 盖层 → 全让位；密钥 → 模型 → 本地密钥待同步。
 *
 * 产品策略：默认引擎 keep-alive，**不因短暂断连展示 engine-down**
 *（fetchEngineStatus 在 keep-alive 下会报 ok:true + reconnecting）。
 * engine-down 仅在 ok 明确 false（显式断开 / 未启动 keep-alive）时出现。
 */
export function resolveSetupHintKind(opts: {
  needsKeySetup: boolean;
  needsModelSetup?: boolean;
  /** engineHint.ok；null = 尚未探测（不当离线） */
  engineOk?: boolean | null;
  /** engineHint.hasApiKey；仅 ok===true 时有意义 */
  engineHasApiKey?: boolean | null;
  localHasKey?: boolean;
  firstRunOpen?: boolean;
}): SetupHintKind | null {
  if (opts.firstRunOpen) return null;
  // null = 探测中：不展示离线条（避免启动闪一下「引擎离线」）
  if (opts.engineOk === false) return 'engine-down';
  if (
    shouldShowNeedsKeySoftHint({
      needsKeySetup: opts.needsKeySetup,
      firstRunOpen: false,
      engineOk: opts.engineOk,
    })
  ) {
    return 'needs-key';
  }
  if (
    shouldShowNeedsModelSoftHint({
      needsModelSetup: Boolean(opts.needsModelSetup),
      needsKeySetup: opts.needsKeySetup,
      firstRunOpen: false,
      engineOk: opts.engineOk,
    })
  ) {
    return 'needs-model';
  }
  // 引擎已通、引擎侧无密钥、本地已有密钥 → 引导同步（不与 key/model 叠）
  if (
    opts.engineOk === true &&
    opts.engineHasApiKey === false &&
    Boolean(opts.localHasKey)
  ) {
    return 'sync-engine';
  }
  return null;
}

/** 计划模式 ribbon 主行（slim）。 */
export function formatPlanModeRibbonLabel(planApproved: boolean): string {
  return planApproved ? '计划模式 · 已批准' : '计划模式 · 只规划';
}

/** 计划模式 aria-label（比主行稍完整）。 */
export function resolvePlanModeAriaLabel(planApproved: boolean): string {
  return planApproved ? '计划模式，已批准' : '计划模式，只规划不改文件';
}

/** 计划条 title：与批准态一致，避免已批准仍写「不改文件」。 */
export function resolvePlanModeTitle(planApproved: boolean): string {
  return planApproved
    ? '计划模式：已批准，可执行改动'
    : '计划模式：只规划不改文件';
}

/**
 * 已批准后隐藏「批准」动作，避免幽灵按钮再次把权限切回 ask。
 * 未批准时才展示。
 */
export function shouldShowPlanApproveAction(planApproved: boolean): boolean {
  return !planApproved;
}

/** slim 条默认截断长度（密度优先；完整 goal 走 title / aria）。 */
export const GOAL_RIBBON_PREVIEW_MAX_LEN = 28;

/** 目标文案截断：ellipsis 仅用于 ribbon 主行，完整 goal 走 title。 */
export function formatGoalRibbonPreview(
  goalText: string,
  maxLen = GOAL_RIBBON_PREVIEW_MAX_LEN,
): string {
  const t = (goalText || '').trim();
  if (!t) return '';
  const cap = Math.max(4, maxLen | 0);
  if (t.length <= cap) return t;
  return `${t.slice(0, cap)}…`;
}

/**
 * 目标 ribbon 主行文案（与 TasksCard 同源分数）。
 * 轮次 1-based；无清单时不拼 done/total。
 */
export function formatGoalRibbonLabel(opts: {
  goalText: string;
  goalIteration: number;
  goalTasksDone?: number;
  goalTasksTotal?: number;
}): string {
  const rawIter = Number(opts.goalIteration);
  const iteration = Math.max(0, Number.isFinite(rawIter) ? rawIter | 0 : 0);
  const rawDone = Number(opts.goalTasksDone ?? 0);
  const rawTotal = Number(opts.goalTasksTotal ?? 0);
  const done = Math.max(0, Number.isFinite(rawDone) ? rawDone | 0 : 0);
  const total = Math.max(0, Number.isFinite(rawTotal) ? rawTotal | 0 : 0);
  const preview = formatGoalRibbonPreview(opts.goalText);
  const parts = [`目标 · 第 ${iteration + 1} 轮`];
  if (total > 0) {
    parts.push(`${Math.min(done, total)}/${total}`);
  }
  if (preview) parts.push(preview);
  return parts.join(' · ');
}

/**
 * 目标 ribbon 可访问名：完整 goal（不截断），口语化进度。
 * 与主行截断预览解耦，避免 SR 读到省略号残句。
 */
export function resolveGoalRibbonAriaLabel(opts: {
  goalText: string;
  goalIteration: number;
  goalTasksDone?: number;
  goalTasksTotal?: number;
}): string {
  const rawIter = Number(opts.goalIteration);
  const iteration = Math.max(0, Number.isFinite(rawIter) ? rawIter | 0 : 0);
  const rawDone = Number(opts.goalTasksDone ?? 0);
  const rawTotal = Number(opts.goalTasksTotal ?? 0);
  const done = Math.max(0, Number.isFinite(rawDone) ? rawDone | 0 : 0);
  const total = Math.max(0, Number.isFinite(rawTotal) ? rawTotal | 0 : 0);
  const full = (opts.goalText || '').trim();
  const parts = [`目标模式，第 ${iteration + 1} 轮`];
  if (total > 0) {
    parts.push(`进度 ${Math.min(done, total)} 之 ${total}`);
  }
  if (full) parts.push(full);
  return parts.join('，');
}

/** 目标清单进度 0–1；无清单 / 非法 total 返回 null（不画进度条）。 */
export function goalRibbonProgressRatio(
  done: number,
  total: number,
): number | null {
  const rawT = Number(total);
  const t = Math.max(0, Number.isFinite(rawT) ? rawT | 0 : 0);
  if (t <= 0) return null;
  const rawD = Number(done);
  const d = Math.max(0, Number.isFinite(rawD) ? rawD | 0 : 0);
  return Math.min(1, d / t);
}

/** 进度条 width %；无清单返回 null。 */
export function goalRibbonProgressPercent(
  done: number,
  total: number,
): number | null {
  const ratio = goalRibbonProgressRatio(done, total);
  if (ratio == null) return null;
  return Math.round(ratio * 100);
}

/**
 * 引擎 soft-hint 文案（与 needs-key 语义分离：说引擎，不提密钥）。
 * 正式版 keep-alive 下极少展示；若仍出现，用「恢复中」而非恐吓「离线」。
 */
export function resolveEngineDownSoftHintText(opts: {
  onEmptySurface?: boolean;
}): string {
  if (opts.onEmptySurface) return '引擎连接恢复中…';
  return '引擎连接恢复中，请稍候';
}

/**
 * 本地密钥待同步 soft-hint 文案。
 * 空态短句；非空态点明「点模型名」操作路径。
 */
export function resolveSyncEngineSoftHintText(opts: {
  onEmptySurface?: boolean;
}): string {
  if (opts.onEmptySurface) return '本地密钥待同步到引擎';
  return '本地已有密钥，点击下方模型名称同步到引擎';
}

/** setup soft-hint 动作按钮：可见文案 + aria（四种互斥）。 */
export function resolveSetupHintAction(kind: SetupHintKind): {
  label: string;
  ariaLabel: string;
} {
  switch (kind) {
    case 'engine-down':
      // 进模型设置可查 endpoint / 连通性；不与「去配置密钥」混用文案
      return {
        label: '模型设置',
        ariaLabel: '打开模型设置检查引擎连接',
      };
    case 'needs-key':
      return { label: '去配置', ariaLabel: '去配置服务商密钥' };
    case 'needs-model':
      return { label: '填写模型', ariaLabel: '填写或选择模型' };
    case 'sync-engine':
      return { label: '选择模型', ariaLabel: '选择模型以同步到引擎' };
    default: {
      // 穷尽守卫：未知 kind 不渲染幽灵动作
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * run-notice 是否挂载：null / 空文案不渲染，防幽灵条。
 */
export function shouldRenderRunNotice(
  notice: RunNotice | null | undefined,
): boolean {
  if (notice == null) return false;
  return Boolean(String(notice.text ?? '').trim());
}

/** run-notice 可访问名：系统提示 + 正文。 */
export function resolveRunNoticeAriaLabel(text: string): string {
  const t = String(text ?? '').trim();
  if (!t) return '系统提示';
  return `系统提示：${t}`;
}

/**
 * run-notice 播报急迫度：错误类 assertive，其余 polite。
 */
export function resolveRunNoticeAriaLive(
  kind?: string | null,
): 'polite' | 'assertive' {
  const k = String(kind ?? '')
    .trim()
    .toLowerCase();
  if (k === 'error' || k === 'fail' || k === 'failed' || k === 'fatal') {
    return 'assertive';
  }
  return 'polite';
}

/**
 * 是否真正挂载 approval dock DOM。
 * 默认 show=false 防双渲染；count≤0 也不挂（空条无意义）。
 */
export function shouldRenderApprovalDock(
  showApprovalDock: boolean,
  pendingCount: number,
): boolean {
  if (!showApprovalDock) return false;
  const n = Math.max(0, Number.isFinite(Number(pendingCount)) ? pendingCount | 0 : 0);
  return n > 0;
}

/** dock 可见文案：优先完整 summary（approvalDockLabel），否则裸计数。 */
export function resolveApprovalDockLabelText(
  count: number,
  summary: string,
): string {
  const s = (summary || '').trim();
  if (s) return s;
  const n = Math.max(0, Number.isFinite(Number(count)) ? count | 0 : 0);
  if (n <= 0) return '待审批';
  return `${n} 待审批`;
}

/** dock 可访问名：优先完整 summary，否则计数（比 label 更口语）。 */
export function resolveApprovalDockAriaLabel(
  count: number,
  summary: string,
): string {
  const s = (summary || '').trim();
  if (s) return s;
  const n = Math.max(0, Number.isFinite(Number(count)) ? count | 0 : 0);
  if (n <= 0) return '待确认项';
  return `${n} 项等待确认`;
}

export const ChatStatusRibbons: React.FC<ChatStatusRibbonsProps> = ({
  onOpenTerminal,
  onOpenDiff,
  diffCount = 0,
  engineHint,
  needsKeySetup,
  needsModelSetup = false,
  onEmptySurface = false,
  localHasKey,
  onOpenModelSettings,
  onOpenModelDropdown,
  inPlanMode,
  planApproved,
  onApprovePlan,
  goalModeActive,
  goalText,
  goalIteration,
  goalTasksDone = 0,
  goalTasksTotal = 0,
  onStopGoal,
  showScrollToBottom,
  onScrollToBottom,
  runNotice,
  onDismissRunNotice,
  pendingApprovalCount,
  showApprovalDock = false,
  pendingApprovalSummary,
  pendingApprovalToolId,
  pendingApprovalMsgId,
  activeSessionId,
  onShowToast,
  between,
}) => {
  const [bgTasks, setBgTasks] = useState<BackgroundTaskInfo[]>([]);
  const [showPlanDrawer, setShowPlanDrawer] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchTasks = async () => {
      try {
        const tasks = await listBackgroundTasks();
        if (!cancelled) setBgTasks(tasks || []);
      } catch {
        /* ignore */
      }
    };
    void fetchTasks();
    const t = setInterval(() => void fetchTasks(), 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const activeBgTasks = useMemo(
    () => bgTasks.filter((t) => isBackgroundTaskActive(t.state)),
    [bgTasks],
  );

  const currentSession = activeSessionId ? getSessionById(activeSessionId) : null;
  const progressItems = useMemo(
    () => resolveSessionProgressItems(currentSession),
    [currentSession],
  );
  const checklistProgress = useMemo(
    () => computeChecklistProgress(progressItems),
    [progressItems],
  );

  const hasActivePlan =
    inPlanMode || goalModeActive || checklistProgress.total > 0;
  // 盖层生命周期优先于 LS gate（密钥步落盘后向导仍可能打开）
  const firstRunOpen = isFirstRunOverlayOpen();
  const engineOk = engineHint == null ? null : engineHint.ok;
  const setupHint = resolveSetupHintKind({
    needsKeySetup,
    needsModelSetup,
    engineOk,
    engineHasApiKey: engineHint?.hasApiKey ?? null,
    localHasKey,
    firstRunOpen,
  });
  const keySoftHintText = resolveNeedsKeySoftHintText({ onEmptySurface });
  const modelSoftHintText = resolveNeedsModelSoftHintText({ onEmptySurface });
  const engineDownText = resolveEngineDownSoftHintText({ onEmptySurface });
  const syncEngineText = resolveSyncEngineSoftHintText({ onEmptySurface });
  const setupAction = setupHint ? resolveSetupHintAction(setupHint) : null;
  const planLabel = formatPlanModeRibbonLabel(planApproved);
  const planAria = resolvePlanModeAriaLabel(planApproved);
  const planTitle = resolvePlanModeTitle(planApproved);
  const showPlanApprove = shouldShowPlanApproveAction(planApproved);

  const goalLabel = formatGoalRibbonLabel({
    goalText,
    goalIteration,
    goalTasksDone,
    goalTasksTotal,
  });
  const goalAria = resolveGoalRibbonAriaLabel({
    goalText,
    goalIteration,
    goalTasksDone,
    goalTasksTotal,
  });
  const goalProgressPct = goalRibbonProgressPercent(
    goalTasksDone,
    goalTasksTotal,
  );
  const approvalAria = resolveApprovalDockAriaLabel(
    pendingApprovalCount,
    pendingApprovalSummary,
  );
  const approvalLabel = resolveApprovalDockLabelText(
    pendingApprovalCount,
    pendingApprovalSummary,
  );
  const renderApprovalDock = shouldRenderApprovalDock(
    showApprovalDock,
    pendingApprovalCount,
  );
  const renderRunNotice = shouldRenderRunNotice(runNotice);
  const runNoticeText = renderRunNotice ? String(runNotice?.text ?? '').trim() : '';
  const runNoticeAria = renderRunNotice
    ? resolveRunNoticeAriaLabel(runNoticeText)
    : '';
  const runNoticeLive = renderRunNotice
    ? resolveRunNoticeAriaLive(runNotice?.kind)
    : 'polite';

  const handleApprovalDockClick = () => {
    const byTool = pendingApprovalToolId
      ? document.querySelector(
          `.approval-card[data-tool-id="${CSS.escape(pendingApprovalToolId)}"], [data-tool-id="${CSS.escape(pendingApprovalToolId)}"]`,
        )
      : null;
    const byMsg = pendingApprovalMsgId
      ? document.querySelector(
          `.approval-card[data-msg="${CSS.escape(pendingApprovalMsgId)}"]`,
        )
      : null;
    const el = byTool || byMsg || document.querySelector('.approval-card');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (el instanceof HTMLElement) {
        try {
          el.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }
      return;
    }
    const sess = activeSessionId ? getSessionById(activeSessionId) : undefined;
    const pendingAgent = (sess?.agents || []).find((ag) =>
      (ag.messages || []).some((m) =>
        (m.toolCalls || []).some((tc) => tc.status === 'pending_approval'),
      ),
    );
    if (pendingAgent) {
      // 打开侧栏即反馈，不 toast「已打开…」
      openAgentInSidePanel(pendingAgent.id, {
        sessionId: activeSessionId || undefined,
      });
      return;
    }
    // 找不到可滚目标：仅错误级短提示
    onShowToast('未找到待确认项');
  };

  return (
    <>
      {/* 动态快捷状态浮条：仅在有活跃状态（后台运行/活动计划/差异）时呈现 */}
      {(activeBgTasks.length > 0 || hasActivePlan || (diffCount > 0 && Boolean(onOpenDiff))) ? (
        <div className={styles.dynamicChipBar} role="region" aria-label="快捷状态">
          {activeBgTasks.length > 0 && onOpenTerminal ? (
            <button
              type="button"
              className={`${styles.dynamicChip} ${styles.dynamicChipActive}`}
              title={`点击在终端查看 ${activeBgTasks.length} 个后台运行任务`}
              aria-label={`后台运行中，${activeBgTasks.length} 个任务`}
              onClick={onOpenTerminal}
            >
              <span className={styles.dynamicChipPulseDot} aria-hidden />
              <span>后台任务 ({activeBgTasks.length})</span>
            </button>
          ) : null}

          {hasActivePlan ? (
            <button
              type="button"
              className={`${styles.dynamicChip}${showPlanDrawer ? ` ${styles.dynamicChipActive}` : ''}`}
              title="点击查看计划与进度详情"
              aria-label="查看计划与进度详情"
              onClick={() => setShowPlanDrawer((v) => !v)}
            >
              <Lucide.Target size={13} strokeWidth={2} aria-hidden />
              <span>
                {goalModeActive
                  ? `目标模式 · 第 ${goalIteration + 1} 轮`
                  : checklistProgress.total > 0
                    ? `计划任务 · ${checklistProgress.done}/${checklistProgress.total}`
                    : '计划模式'}
              </span>
            </button>
          ) : null}

          {diffCount > 0 && onOpenDiff ? (
            <button
              type="button"
              className={styles.dynamicChip}
              title="在右侧查看代码变更"
              aria-label="查看代码变更"
              onClick={onOpenDiff}
            >
              <Lucide.GitBranch size={13} strokeWidth={2} aria-hidden />
              <span>{diffCount} 个文件变更</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {showPlanDrawer && hasActivePlan ? (
        <div className={styles.dynamicPlanDrawer} role="dialog" aria-label="计划与进度详情">
          <div className={styles.dynamicPlanHeader}>
            <span>{goalModeActive ? (goalText || '目标推进中') : '计划清单'}</span>
            <button
              type="button"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}
              aria-label="关闭计划详情"
              onClick={() => setShowPlanDrawer(false)}
            >
              <Lucide.X size={14} />
            </button>
          </div>
          {progressItems.length > 0 ? (
            <ul className={styles.dynamicPlanList}>
              {progressItems.map((item) => (
                <li key={item.id} className={`${styles.dynamicPlanItem}${item.done ? ` ${styles.isDone}` : ''}`}>
                  {item.done ? (
                    <Lucide.CheckCircle2 size={13} style={{ color: 'var(--accent-green, #22c55e)' }} />
                  ) : (
                    <Lucide.Circle size={13} style={{ color: 'var(--text-tertiary)' }} />
                  )}
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {inPlanMode ? '计划模式生效中，AI 将集中思考规划' : '暂无清单步数'}
            </div>
          )}
        </div>
      ) : null}

      {/* 引导态：页内 soft-hint 互斥一条；FirstRun 盖层时 resolveSetupHintKind=null */}
      {setupHint === 'engine-down' && setupAction ? (
        <div
          className={styles.chatSoftHint}
          data-setup-hint="engine-down"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <Lucide.CloudOff
            size={14}
            strokeWidth={1.75}
            className={styles.chatSoftHintIcon}
            aria-hidden
          />
          <span className={styles.chatSoftHintText}>{engineDownText}</span>
          <button
            type="button"
            className={styles.chatSoftHintAction}
            aria-label={setupAction.ariaLabel}
            onClick={onOpenModelSettings}
          >
            {setupAction.label}
          </button>
        </div>
      ) : null}
      {setupHint === 'needs-key' && setupAction ? (
        <div
          className={styles.chatSoftHint}
          data-setup-hint="needs-key"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <Lucide.KeyRound
            size={14}
            strokeWidth={1.75}
            className={styles.chatSoftHintIcon}
            aria-hidden
          />
          <span className={styles.chatSoftHintText}>{keySoftHintText}</span>
          <button
            type="button"
            className={styles.chatSoftHintAction}
            aria-label={setupAction.ariaLabel}
            onClick={onOpenModelSettings}
          >
            {setupAction.label}
          </button>
        </div>
      ) : null}
      {setupHint === 'needs-model' && setupAction ? (
        <div
          className={styles.chatSoftHint}
          data-setup-hint="needs-model"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <Lucide.Cpu
            size={14}
            strokeWidth={1.75}
            className={styles.chatSoftHintIcon}
            aria-hidden
          />
          <span className={styles.chatSoftHintText}>{modelSoftHintText}</span>
          <button
            type="button"
            className={styles.chatSoftHintAction}
            aria-label={setupAction.ariaLabel}
            onClick={onOpenModelDropdown}
          >
            {setupAction.label}
          </button>
        </div>
      ) : null}
      {setupHint === 'sync-engine' && setupAction ? (
        <div
          className={styles.chatSoftHint}
          data-setup-hint="sync-engine"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <Lucide.RefreshCw
            size={14}
            strokeWidth={1.75}
            className={styles.chatSoftHintIcon}
            aria-hidden
          />
          <span className={styles.chatSoftHintText}>{syncEngineText}</span>
          <button
            type="button"
            className={styles.chatSoftHintAction}
            aria-label={setupAction.ariaLabel}
            onClick={onOpenModelDropdown}
          >
            {setupAction.label}
          </button>
        </div>
      ) : null}

      {inPlanMode ? (
        <div
          className={`${styles.planModeRibbon} ${styles.slim}`}
          role="status"
          aria-live="polite"
          aria-label={planAria}
        >
          <Lucide.ListChecks size={14} strokeWidth={1.75} aria-hidden />
          <span className={styles.planModeRibbonText} title={planTitle}>
            {planLabel}
          </span>
          {showPlanApprove ? (
            <button
              type="button"
              className={styles.planModeRibbonIconBtn}
              title="批准执行"
              aria-label="批准计划执行"
              onClick={onApprovePlan}
            >
              <Lucide.Check size={14} strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}

      {goalModeActive ? (
        <div
          className={`${styles.planModeRibbon} ${styles.goalModeRibbon} ${styles.slim}`}
          role="status"
          aria-live="polite"
          aria-label={goalAria}
          data-goal-iteration={goalIteration}
          data-goal-tasks-done={goalTasksDone}
          data-goal-tasks-total={goalTasksTotal}
        >
          <Lucide.Target size={14} strokeWidth={1.75} aria-hidden />
          <span
            className={styles.planModeRibbonText}
            title={(goalText || '').trim() || '目标模式'}
          >
            {goalLabel}
          </span>
          {goalProgressPct != null ? (
            <span
              className={styles.goalModeRibbonMeter}
              aria-hidden
              title={`${goalTasksDone}/${goalTasksTotal}`}
            >
              <span
                className={styles.goalModeRibbonMeterFill}
                style={{ width: `${goalProgressPct}%` }}
              />
            </span>
          ) : null}
          <button
            type="button"
            className={`${styles.planModeRibbonIconBtn} is-danger`}
            title="停止目标"
            aria-label="停止目标"
            onClick={onStopGoal}
          >
            <Lucide.Square size={12} fill="currentColor" aria-hidden />
          </button>
        </div>
      ) : null}

      {/* 回到最新：浮在对话区右下角，仅图标 */}
      {showScrollToBottom ? (
        <button
          type="button"
          className={styles.chatScrollFab}
          title="回到最新"
          aria-label="回到最新"
          onClick={onScrollToBottom}
        >
          <Lucide.ChevronDown size={16} strokeWidth={2} aria-hidden />
        </button>
      ) : null}

      {between}

      {/* 系统提示：错误/空回复 — 明确非 AI 输出；空文案不挂载（防幽灵条） */}
      {renderRunNotice ? (
        <div
          className={styles.runNotice}
          role="status"
          aria-live={runNoticeLive}
          aria-atomic="true"
          aria-label={runNoticeAria}
        >
          <div className={styles.runNoticeMain}>
            <span className={styles.runNoticeKicker}>运行提示</span>
            <span className={styles.runNoticeText}>{runNoticeText}</span>
            {runNotice?.detail ? (
              <span className={styles.runNoticeDetail} title={runNotice.detail}>
                {runNotice.detail}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className={styles.runNoticeDismiss}
            aria-label="关闭提示"
            onClick={onDismissRunNotice}
          >
            <Lucide.X size={14} aria-hidden />
          </button>
        </div>
      ) : null}

      {/* 审批 sticky：队列/子 agent 待确认时显示；单条主时间线靠 ApprovalAskCard */}
      {renderApprovalDock ? (
        <button
          type="button"
          className={`${styles.approvalDock} ${styles.slim}`}
          title={approvalAria}
          aria-label={approvalAria}
          data-pending-count={pendingApprovalCount}
          onClick={handleApprovalDockClick}
        >
          <span className={styles.approvalDockDot} aria-hidden />
          <span className={styles.approvalDockLabel}>{approvalLabel}</span>
          <Lucide.ChevronRight
            size={14}
            className={styles.approvalDockGoIcon}
            aria-hidden
          />
        </button>
      ) : null}
    </>
  );
};
