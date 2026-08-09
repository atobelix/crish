/**
 * 对话页脚顶部状态条：引擎软提示、计划/目标模式、回到底部 FAB、
 * 系统 run 提示、审批 sticky 条。
 * 从 ChatCard 抽出以降低巨石组件变更风险；不含输入区（ChatComposer）。
 *
 * 壳组件：保留动态快捷 chip 区、计划抽屉（T05.2.1 接入 Dialog 基座）、
 * 回到底部 FAB 与编排；文案纯函数见 chatStatusRibbonsLib，
 * 各功能条见 SetupHintBanner / PlanGoalRibbons / RunNoticeBar / ApprovalDock。
 *
 * 引导态（密钥 / 手填模型）只用页内 soft-hint，禁止 toast 刷屏。
 * FirstRun 盖层打开时让位给向导（见 isFirstRunOverlayOpen）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import styles from './ChatStatusRibbons.module.css';
import * as Lucide from 'lucide-react';
import { AppErrorBoundary } from '../AppErrorBoundary';
import type { EngineStatus } from '../../api/engineConfig';
import type { RunNotice } from '../../hooks/useChatStream';
import { getSessionById } from '../../api/store-access/componentAccess';
import {
  resolveSessionProgressItems,
  computeChecklistProgress,
} from '../../api/sessionProgressApi';
import {
  resolveNeedsKeySoftHintText,
  resolveNeedsModelSoftHintText,
} from '../../api/chatEmptyState';
import { isFirstRunOverlayOpen } from '../firstRunOverlayFlag';
import { Tooltip } from '../ui';
import { SetupHintBanner, type SetupHintState } from './SetupHintBanner';
import {
  PlanGoalRibbons,
  type GoalRibbonState,
  type PlanRibbonState,
} from './PlanGoalRibbons';
import { RunNoticeBar } from './RunNoticeBar';
import { ApprovalDock } from './ApprovalDock';
import {
  filterActiveBackgroundTasks,
  useBackgroundTaskPolling,
} from './useBackgroundTaskPolling';
import {
  resolveEngineDownSoftHintText,
  resolveSetupHintAction,
  resolveSetupHintKind,
  resolveSyncEngineSoftHintText,
  type SetupHintKind,
} from './chatStatusRibbonsLib';

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

/** setup 动作派发：去模型设置 vs 去模型下拉（与抽出前一致）。 */
function resolveSetupAction(kind: SetupHintKind): 'settings' | 'dropdown' {
  return kind === 'needs-key' || kind === 'engine-down' ? 'settings' : 'dropdown';
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
  const [showPlanDrawer, setShowPlanDrawer] = useState(false);
  const planDrawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showPlanDrawer) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setShowPlanDrawer(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showPlanDrawer]);

  useEffect(() => {
    if (!showPlanDrawer) return;
    requestAnimationFrame(() => {
      const first = planDrawerRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      first?.focus();
    });
  }, [showPlanDrawer]);

  const bgTasks = useBackgroundTaskPolling();
  const activeBgTasks = useMemo(
    () => filterActiveBackgroundTasks(bgTasks),
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

  const setupState: SetupHintState | null = useMemo(() => {
    if (!setupHint) return null;
    const text =
      setupHint === 'engine-down'
        ? engineDownText
        : setupHint === 'needs-key'
          ? keySoftHintText
          : setupHint === 'needs-model'
            ? modelSoftHintText
            : syncEngineText;
    const action = resolveSetupHintAction(setupHint);
    return {
      kind: setupHint,
      text,
      actionLabel: action.label,
      actionAriaLabel: action.ariaLabel,
    };
  }, [setupHint, engineDownText, keySoftHintText, modelSoftHintText, syncEngineText]);

  const handleSetupAction = (kind: SetupHintKind) => {
    const target = resolveSetupAction(kind);
    if (target === 'settings') onOpenModelSettings();
    else onOpenModelDropdown();
  };

  const planState: PlanRibbonState = {
    inPlanMode,
    planApproved,
    onApprovePlan,
  };
  const goalState: GoalRibbonState = {
    goalModeActive,
    goalText,
    goalIteration,
    goalTasksDone,
    goalTasksTotal,
    onStopGoal,
  };

  return (
    <AppErrorBoundary variant="minimal" title="状态栏出错">
      {/* 动态快捷状态浮条：仅在有活跃状态（后台运行/活动计划/差异）时呈现 */}
      {(activeBgTasks.length > 0 || hasActivePlan || (diffCount > 0 && Boolean(onOpenDiff))) ? (
        <div className={styles.dynamicChipBar} role="region" aria-label="快捷状态">
          {activeBgTasks.length > 0 && onOpenTerminal ? (
            <Tooltip content={`点击在终端查看 ${activeBgTasks.length} 个后台运行任务`}>
              <button
                type="button"
                className={`${styles.dynamicChip} ${styles.dynamicChipActive}`}
                aria-label={`后台运行中，${activeBgTasks.length} 个任务`}
                onClick={onOpenTerminal}
              >
                <span className={styles.dynamicChipPulseDot} aria-hidden />
                <span>后台任务 ({activeBgTasks.length})</span>
              </button>
            </Tooltip>
          ) : null}

          {hasActivePlan ? (
            <Tooltip content="点击查看计划与进度详情">
              <button
                type="button"
                className={`${styles.dynamicChip}${showPlanDrawer ? ` ${styles.dynamicChipActive}` : ''}`}
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
            </Tooltip>
          ) : null}

          {diffCount > 0 && onOpenDiff ? (
            <Tooltip content="在右侧查看代码变更">
              <button
                type="button"
                className={styles.dynamicChip}
                aria-label="查看代码变更"
                onClick={onOpenDiff}
              >
                <Lucide.GitBranch size={13} strokeWidth={2} aria-hidden />
                <span>{diffCount} 个文件变更</span>
              </button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}

      {showPlanDrawer && hasActivePlan ? (
        <div ref={planDrawerRef} className={styles.dynamicPlanDrawer} role="dialog" aria-label="计划与进度详情">
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
                    <Lucide.CheckCircle2 size={13} style={{ color: 'var(--accent-green)' }} />
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
      <SetupHintBanner state={setupState} onAction={handleSetupAction} />

      <PlanGoalRibbons plan={planState} goal={goalState} />

      {/* 回到最新：浮在对话区右下角，仅图标 */}
      {showScrollToBottom ? (
        <Tooltip content="回到最新">
          <button
            type="button"
            className={styles.chatScrollFab}
            aria-label="回到最新"
            onClick={onScrollToBottom}
          >
            <Lucide.ChevronDown size={16} strokeWidth={2} aria-hidden />
          </button>
        </Tooltip>
      ) : null}

      {between}

      {/* 系统提示：错误/空回复 — 明确非 AI 输出；空文案不挂载（防幽灵条） */}
      <RunNoticeBar runNotice={runNotice} onDismiss={onDismissRunNotice} />

      {/* 审批 sticky：队列/子 agent 待确认时显示；单条主时间线靠 ApprovalAskCard */}
      <ApprovalDock
        show={showApprovalDock}
        pendingCount={pendingApprovalCount}
        summary={pendingApprovalSummary}
        toolId={pendingApprovalToolId}
        msgId={pendingApprovalMsgId}
        activeSessionId={activeSessionId}
        onShowToast={onShowToast}
      />
    </AppErrorBoundary>
  );
};
