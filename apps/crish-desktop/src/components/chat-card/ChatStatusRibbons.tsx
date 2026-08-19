/**
 * 对话页脚顶部状态条：引擎软提示、计划/目标模式、回到底部 FAB、
 * 系统 run 提示、审批 sticky 条。
 * 从 ChatCard 抽出以降低巨石组件变更风险；不含输入区（ChatComposer）。
 *
 * 壳组件：保留动态快捷 chip 区（DynamicChipBar）、计划抽屉（PlanDrawer）、
 * 回到底部 FAB 与编排；文案纯函数见 chatStatusRibbonsLib，
 * 各功能条见 SetupHintBanner / PlanGoalRibbons / RunNoticeBar / ApprovalDock。
 *
 * 引导态（密钥 / 手填模型）只用页内 soft-hint，禁止 toast 刷屏。
 * FirstRun 盖层打开时让位给向导（见 isFirstRunOverlayOpen）。
 */
import React, { useMemo } from 'react';
import styles from './ChatStatusRibbons.module.css';
import * as Lucide from 'lucide-react';
import { AppErrorBoundary } from '../AppErrorBoundary';
import type { EngineStatus } from '../../api/engineConfig';
import type { RunNotice } from '../../hooks/useChatStream';
import { getSessionById } from '../../store/storeAccess';
import {
  resolveSessionProgressItems,
  computeChecklistProgress,
} from '../../api/sessionProgressApi';
import {
  resolveNeedsKeySoftHintText,
  resolveNeedsModelSoftHintText,
} from '../../api/chatEmptyState';
import { isFirstRunOverlayOpen } from '../firstRunOverlayFlag';
import { Button, Tooltip } from '../ui';
import { SetupHintBanner, type SetupHintState } from './SetupHintBanner';
import {
  PlanGoalRibbons,
  type GoalRibbonState,
  type PlanRibbonState,
} from './PlanGoalRibbons';
import { RunNoticeBar } from './RunNoticeBar';
import { CircuitBreakerBanner } from './CircuitBreakerBanner';
import { RetrySlotNotice } from './RetrySlotNotice';
import { ApprovalDock } from './ApprovalDock';
import { useContinuityUiStore } from '../../api/continuity/continuityUiStore';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { connectionManager } from '../../services/ConnectionManager';
import {
  filterActiveBackgroundTasks,
  useBackgroundTaskPolling,
} from './useBackgroundTaskPolling';
import {
  resolveEngineCrashedText,
  ENGINE_CRASH_RECONNECT_LABEL,
  resolveEngineDownSoftHintText,
  resolveSetupHintAction,
  resolveSetupHintKind,
  resolveSyncEngineSoftHintText,
  type SetupHintKind,
} from './chatStatusRibbonsLib';
import {
  DynamicChipBar,
  PlanDrawer,
  usePlanDrawerState,
} from './DynamicChipBar';

export interface StreamingRibbonProps {
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
  /** 回到最新 FAB */
  showScrollToBottom: boolean;
  onScrollToBottom: () => void;
  /** 系统 run 提示（错误/空回复等） */
  runNotice: RunNotice | null;
  onDismissRunNotice: () => void;
}

export interface GoalRibbonProps {
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
}

export interface ApprovalRibbonProps {
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
}

export type ChatStatusRibbonsProps = {
  streaming: StreamingRibbonProps;
  goal: GoalRibbonProps;
  approval: ApprovalRibbonProps;
  /**
   * 插在 FAB 与 run 提示之间的内容（如 DemoChrome），
   * 用于保持抽出前 DOM 顺序。
   */
  between?: React.ReactNode;
  /** 计划/目标条改挂 composer 上沿时省略，避免双渲染 */
  omitPlanRibbons?: boolean;
  /** 审批 dock 改挂 composer 上沿时省略 */
  omitApprovalDock?: boolean;
};

/** setup 动作派发：去模型设置 vs 去模型下拉（与抽出前一致）。 */
function resolveSetupAction(kind: SetupHintKind): 'settings' | 'dropdown' {
  return kind === 'needs-key' || kind === 'engine-down'
    ? 'settings'
    : 'dropdown';
}

export const ChatStatusRibbons: React.FC<ChatStatusRibbonsProps> = ({
  streaming: sp,
  goal: gp,
  approval: ap,
  between,
  omitPlanRibbons = false,
  omitApprovalDock = false,
}) => {
  const {
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
    showScrollToBottom,
    onScrollToBottom,
    runNotice,
    onDismissRunNotice,
  } = sp;
  const {
    inPlanMode,
    planApproved,
    onApprovePlan,
    goalModeActive,
    goalText,
    goalIteration,
    goalTasksDone = 0,
    goalTasksTotal = 0,
    onStopGoal,
  } = gp;
  const {
    pendingApprovalCount,
    showApprovalDock = false,
    pendingApprovalSummary,
    pendingApprovalToolId,
    pendingApprovalMsgId,
    activeSessionId,
  } = ap;
  const { showPlanDrawer, togglePlanDrawer, closePlanDrawer, planDrawerRef } =
    usePlanDrawerState();

  const bgTasks = useBackgroundTaskPolling({
    sessionId: activeSessionId || undefined,
    enabled:
      !onEmptySurface &&
      Boolean(activeSessionId && !activeSessionId.startsWith('__pending')),
  });
  const activeBgTasks = useMemo(
    () => filterActiveBackgroundTasks(bgTasks),
    [bgTasks]
  );

  // T5-1：引擎崩溃域（前端心跳连续失败判死 → errorStore.engine_crashed）。
  // 与 engine-down 离线软提示分离：崩溃是「探活判死」，给独立恢复动作。
  const connectionStatus = useConnectionStatus();
  const engineCrashed = connectionStatus === 'engine_crashed';
  const engineCrashedText = resolveEngineCrashedText({ onEmptySurface });

  // D8 §3.7.4/§3.7.5：临时通知（老虎机滚动重连）+ 熔断横幅（会话级订阅；
  // 不进对话历史，仅 UI 层——事件 handler 写入 continuityUiStore）
  const activeSession = activeSessionId ?? null;
  const retryNotice = useContinuityUiStore((s) =>
    activeSession ? s.retryNotices[activeSession] : null
  );
  const circuitBanner = useContinuityUiStore((s) =>
    activeSession ? s.circuitBanners[activeSession] : null
  );
  const dismissCircuitBanner = useContinuityUiStore(
    (s) => s.dismissCircuitBanner
  );

  const currentSession = activeSessionId
    ? getSessionById(activeSessionId)
    : null;
  const progressItems = useMemo(
    () => resolveSessionProgressItems(currentSession),
    [currentSession]
  );
  const checklistProgress = useMemo(
    () => computeChecklistProgress(progressItems),
    [progressItems]
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
  }, [
    setupHint,
    engineDownText,
    keySoftHintText,
    modelSoftHintText,
    syncEngineText,
  ]);

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

  // ── 核心门闩 1：动态快捷状态浮条受到 !onEmptySurface 刚性拦截 ──
  const shouldRenderDynamicChipBar =
    !onEmptySurface &&
    (activeBgTasks.length > 0 ||
      hasActivePlan ||
      (diffCount > 0 && Boolean(onOpenDiff)));

  // ── 核心门闩 2：计划详情抽屉受到 !onEmptySurface 刚性拦截 ──
  const shouldRenderPlanDrawer =
    !onEmptySurface && showPlanDrawer && hasActivePlan;

  return (
    <AppErrorBoundary variant="minimal" title="状态栏出错">
      {/* 动态快捷状态浮条：空态下 100% 物理不挂载 DOM 节点 */}
      <DynamicChipBar
        shouldRender={shouldRenderDynamicChipBar}
        activeBgTaskCount={activeBgTasks.length}
        onOpenTerminal={onOpenTerminal}
        hasActivePlan={hasActivePlan}
        planDrawerOpen={showPlanDrawer}
        onTogglePlanDrawer={togglePlanDrawer}
        goalModeActive={goalModeActive}
        goalIteration={goalIteration}
        checklistDone={checklistProgress.done}
        checklistTotal={checklistProgress.total}
        diffCount={diffCount}
        onOpenDiff={onOpenDiff}
      />

      <PlanDrawer
        shouldRender={shouldRenderPlanDrawer}
        goalModeActive={goalModeActive}
        goalText={goalText}
        inPlanMode={inPlanMode}
        progressItems={progressItems}
        onClose={closePlanDrawer}
        drawerRef={planDrawerRef}
      />

      {/* 引导态：页内 soft-hint 互斥一条；FirstRun 盖层时 resolveSetupHintKind=null */}
      <SetupHintBanner state={setupState} onAction={handleSetupAction} />

      {/* T5-1：引擎崩溃 ribbon（心跳判死域；「自动重连」入口——不给
          「重启引擎」按钮，进程内架构重启 = 整个 Tauri 重启，产品待决
          明示不做；崩溃现场见 errorStore ENGINE_CRASH_PROBED technical
          = logDir/crash-*.log） */}
      {engineCrashed ? (
        <div
          className={styles.crashRibbon}
          data-crash-ribbon="true"
          role="status"
          aria-live="assertive"
          aria-label={engineCrashedText}
        >
          <Lucide.AlertTriangle
            size={14}
            strokeWidth={1.75}
            aria-hidden
            style={{ flexShrink: 0 }}
          />
          <span className={styles.crashRibbonText}>{engineCrashedText}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.crashRibbonAction}
            onClick={() => void connectionManager.reconnect()}
          >
            {ENGINE_CRASH_RECONNECT_LABEL}
          </Button>
        </div>
      ) : null}

      {omitPlanRibbons ? null : (
        <PlanGoalRibbons plan={planState} goal={goalState} />
      )}

      {/* 回到最新：浮在对话区右下角，仅图标 */}
      {showScrollToBottom ? (
        <Tooltip content="回到最新">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.chatScrollFab}
            aria-label="回到最新"
            onClick={onScrollToBottom}
            icon={<Lucide.ChevronDown size={16} strokeWidth={2} aria-hidden />}
          />
        </Tooltip>
      ) : null}

      {between}

      {/* 临时通知老虎机滚动（D8 §3.7.4）：重连进度单起一行，不进对话历史；
          空态不挂载（retryNotice null）防幽灵条 */}
      {retryNotice ? (
        <RetrySlotNotice
          attempt={retryNotice.attempt}
          maxAttempts={retryNotice.maxAttempts}
        />
      ) : null}

      {/* 熔断横幅（D8 §3.7.1）：Provider 连续失败自动恢复已暂停；可手动关闭 */}
      {activeSession && circuitBanner ? (
        <CircuitBreakerBanner
          banner={circuitBanner}
          onDismiss={() => dismissCircuitBanner(activeSession)}
        />
      ) : null}

      {/* 系统提示：错误/空回复 — 明确非 AI 输出；空文案不挂载（防幽灵条） */}
      <RunNoticeBar runNotice={runNotice} onDismiss={onDismissRunNotice} />

      {/* 审批 sticky：队列/子 agent 待确认时显示；单条主时间线靠 ApprovalAskCard */}
      {omitApprovalDock ? null : (
        <ApprovalDock
          show={showApprovalDock}
          pendingCount={pendingApprovalCount}
          summary={pendingApprovalSummary}
          toolId={pendingApprovalToolId}
          msgId={pendingApprovalMsgId}
          activeSessionId={activeSessionId}
        />
      )}
    </AppErrorBoundary>
  );
};
