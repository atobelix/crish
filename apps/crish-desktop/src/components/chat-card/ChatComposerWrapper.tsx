import React, {
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import styles from './ChatCard.module.css';
import {
  ChatStatusRibbons,
  type StreamingRibbonProps,
  type GoalRibbonProps,
  type ApprovalRibbonProps,
} from './ChatStatusRibbons';
import { SlotOutlet } from '../../services/view-registry';
import { slotCore } from '../../services/view-registry/SlotCore';
import type { ChatComposerAboveProps } from './chatComposerAboveProps';
import './workspaceChatComposerAbove.slot';
import { ApprovalDock } from './ApprovalDock';
import { useSessionStore } from '../../store/storeAccess';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';
import { resolveSessionProgressItems } from '../../api/sessionProgressApi';
import {
  ComposerPlanProgressBar,
  type PlanStepItem,
} from '../chat-composer/ComposerPlanProgressBar';

/**
 * R2-5 B3（P1-12 聚合）：ChatStatusRibbons 专属字段分组（ribbons 对象由调用方
 * 构造稳定引用，案甲：ChatCard 层 useMemo）——消除 20+ 字段平铺 drilling。
 * streaming/goal 子对象由 ribbons 传入；approval/activeSessionId 仍平铺。
 */
export interface RibbonsGroup {
  streaming: StreamingRibbonProps;
  goal: GoalRibbonProps;
}

export interface ChatComposerWrapperProps {
  mainSurface: string;
  /** 空态类型。无空态时传入 null，视同已有消息的常规对话态 */
  emptyKind: string | null;
  composerElement: React.ReactNode;
  /** R2-5 B3：ribbons 专属字段分组（调用方构造稳定引用） */
  ribbons: RibbonsGroup;
  pendingApprovalCount: number;
  showApprovalDock: boolean;
  pendingApprovalSummary: string;
  pendingApprovalToolId: string;
  pendingApprovalMsgId: string;
  approvalBusy?: boolean;
  onApprovalAllow?: (toolId: string, msgId: string, remember?: boolean) => void;
  onApprovalDeny?: (toolId: string, msgId: string) => void;
  activeSessionId: string | null;
  openSidePanel: (
    panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files'
  ) => void;
  handleGlobalTabClick: (cardId: string) => void;
  isProcessing?: boolean;
  onStopGeneration?: () => void;
  /** composer 卡片上方区域（空界面品牌 + 项目选择） */
  composerLead?: React.ReactNode;
  /** 首次发送过渡状态：输入框平滑落底 */
  isSettling?: boolean;
}

export const ChatComposerWrapper: React.FC<ChatComposerWrapperProps> =
  React.memo(
    ({
      mainSurface,
      emptyKind,
      composerElement,
      ribbons,
      pendingApprovalCount,
      showApprovalDock,
      pendingApprovalSummary,
      pendingApprovalToolId,
      pendingApprovalMsgId,
      approvalBusy = false,
      onApprovalAllow,
      onApprovalDeny,
      activeSessionId,
      isProcessing = false,
      onStopGeneration,
      composerLead,
      isSettling = false,
    }) => {
      // §5.2：订阅 session store，禁止一次性会话快照轨冒充实时进度
      const currentSession = useSessionStore((s) =>
        activeSessionId ? s.sessionsById[activeSessionId] : undefined
      );
      const progressItems = useMemo(
        () => resolveSessionProgressItems(currentSession),
        [currentSession]
      );

      const planSteps: PlanStepItem[] = useMemo(() => {
        if (!progressItems || progressItems.length === 0) return [];
        const firstIncompleteIdx = progressItems.findIndex((t) => !t.done);
        return progressItems.map((item, idx) => ({
          id: item.id || `step-${idx + 1}`,
          text: item.text,
          status: item.done
            ? 'completed'
            : idx === firstIncompleteIdx
              ? 'active'
              : 'pending',
        }));
      }, [progressItems]);

      const isGoalActive = Boolean(ribbons.goal?.goalModeActive);
      const hasActiveTasks = planSteps.length > 0;
      const showPlanBar = isGoalActive || hasActiveTasks;

      const activeStepText = useMemo(() => {
        if (isGoalActive && ribbons.goal?.goalText) {
          return ribbons.goal.goalText;
        }
        const activeStep = planSteps.find((s) => s.status === 'active');
        return activeStep?.text || planSteps[0]?.text || '';
      }, [isGoalActive, ribbons.goal?.goalText, planSteps]);

      const activeStepIndex = useMemo(() => {
        const idx = planSteps.findIndex((s) => s.status === 'active');
        return idx >= 0 ? idx + 1 : planSteps.length > 0 ? planSteps.length : 1;
      }, [planSteps]);

      const liftApproval = useSyncExternalStore(
        (cb) => slotCore.subscribe('workspace.chat.composerAbove', cb),
        () => Boolean(slotCore.getSingle('workspace.chat.composerAbove'))
      );

      // 组装审批域子对象（平铺字段 → ApprovalRibbonProps）
      const approval: ApprovalRibbonProps = {
        pendingApprovalCount,
        showApprovalDock: liftApproval ? false : showApprovalDock,
        pendingApprovalSummary,
        pendingApprovalToolId,
        pendingApprovalMsgId,
        activeSessionId,
      };

      // §5.2：审批必有真实 props；缺回调时不塞空实现（Slot 侧显式不可用）
      const composerAbove: ChatComposerAboveProps | null = useMemo(() => {
        if (!onApprovalAllow || !onApprovalDeny) return null;
        return {
          pendingCount: pendingApprovalCount,
          firstToolId: pendingApprovalToolId,
          firstMsgId: pendingApprovalMsgId,
          firstSummary: pendingApprovalSummary,
          approvalBusy,
          onApprovalAllow,
          onApprovalDeny,
        };
      }, [
        pendingApprovalCount,
        pendingApprovalToolId,
        pendingApprovalMsgId,
        pendingApprovalSummary,
        approvalBusy,
        onApprovalAllow,
        onApprovalDeny,
      ]);
      const floatHasContent = pendingApprovalCount > 0 || showPlanBar;
      const isLanding = emptyKind === 'session-empty';
      const motionRef = useRef<HTMLDivElement>(null);

      // 停靠高度只在对话态写回。空界面和落地过渡期间冻结，滚动视口不跟着输入框变形。
      useLayoutEffect(() => {
        const motion = motionRef.current;
        if (!motion) return;
        const publish = () => {
          const body = motion.closest(
            '[data-testid="chat-body"]'
          ) as HTMLElement | null;
          if (!body) return;
          if (body.getAttribute('data-empty-kind') === 'session-empty') return;
          if (body.getAttribute('data-settling') === 'true') return;
          const height = motion.offsetHeight;
          if (height > 0) {
            body.style.setProperty(
              '--composer-dock-block',
              `${Math.round(height)}px`
            );
          }
        };
        publish();
        const observer = ResizeObserverManager.getInstance();
        observer.observe(motion, publish);
        return () => observer.unobserve(motion, publish);
      }, [isLanding, isSettling]);

      const ribbonsNode = (
        <ChatStatusRibbons
          streaming={ribbons.streaming}
          goal={ribbons.goal}
          approval={approval}
          omitPlanRibbons
          omitApprovalDock
        />
      );

      return (
        <div
          className={styles.chatFooter}
          data-testid="chat-footer"
          style={{
            display:
              mainSurface === 'scheduled' || mainSurface === 'extensions'
                ? 'none'
                : undefined,
          }}
        >
          <div ref={motionRef} className={styles.footerMotion}>
            {/* chatCol 与消息 listInner 同 max-width / 水平 padding，对齐 stream + composer */}
            <div className={styles.chatCol}>
              {!isLanding ? ribbonsNode : null}

              <div className={styles.composerDock} data-composer-wrapper="">
                <div
                  className={styles.floatZone}
                  data-composer-float-zone=""
                  hidden={!floatHasContent && !liftApproval}
                >
                  {composerAbove ? (
                    <SlotOutlet
                      slotKey="workspace.chat.composerAbove"
                      context={composerAbove}
                      fallback={null}
                    />
                  ) : liftApproval && pendingApprovalCount > 0 ? (
                    <div
                      role="status"
                      aria-live="polite"
                      data-testid="composer-above-approval-unavailable"
                      style={{
                        padding: '6px 10px',
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      审批操作不可用（未接入真实回调）
                    </div>
                  ) : null}
                  {liftApproval ? null : (
                    <ApprovalDock
                      show={showApprovalDock}
                      pendingCount={pendingApprovalCount}
                      summary={pendingApprovalSummary}
                      toolId={pendingApprovalToolId}
                      msgId={pendingApprovalMsgId}
                      activeSessionId={activeSessionId}
                    />
                  )}
                  {showPlanBar ? (
                    <ComposerPlanProgressBar
                      active={true}
                      mode={isGoalActive ? 'goal' : 'plan'}
                      modeLabel={isGoalActive ? '目标模式' : '计划模式'}
                      currentStep={activeStepIndex}
                      totalSteps={planSteps.length}
                      steps={planSteps}
                      activeStepText={activeStepText}
                      isRunning={isProcessing}
                      onApprovePlan={
                        ribbons.goal?.planApproved
                          ? undefined
                          : ribbons.goal?.onApprovePlan
                      }
                      onStop={
                        isGoalActive
                          ? ribbons.goal?.onStopGoal
                          : onStopGeneration
                      }
                    />
                  ) : null}
                </div>

                {/* composer 始终在 .chatFooter 渲染（不再注入到 ChatEmptyState 内）。 */}
                {composerLead ? (
                  <div
                    className={styles.composerLead}
                    data-composer-lead=""
                    data-settling={isSettling ? 'true' : undefined}
                  >
                    {composerLead}
                  </div>
                ) : null}
                {composerElement}
              </div>

              {isLanding ? (
                <div className={styles.landingRibbons}>{ribbonsNode}</div>
              ) : null}
            </div>
          </div>
        </div>
      );
    }
  );
