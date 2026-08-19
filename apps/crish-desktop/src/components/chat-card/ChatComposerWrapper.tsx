import React, { useMemo, useSyncExternalStore } from 'react';
import styles from './ChatCard.module.css';
import {
  ChatStatusRibbons,
  type StreamingRibbonProps,
  type GoalRibbonProps,
  type ApprovalRibbonProps,
} from './ChatStatusRibbons';
import type { } from '../../hooks/useToastQueue';
import type { RunNotice } from '../../hooks/useChatStream';
import { SlotOutlet } from '../../services/view-registry';
import { slotCore } from '../../services/view-registry/SlotCore';
import type { ChatComposerAboveProps } from './chatComposerAboveProps';
import './workspaceChatComposerAbove.slot';
import { ApprovalDock } from './ApprovalDock';
import { PlanGoalRibbons } from './PlanGoalRibbons';

/**
 * R2-5 B3（P1-12 聚合）：ChatStatusRibbons 专属字段分组（ribbons 对象由调用方
 * 构造稳定引用，案甲：ChatCard 层 useMemo）——消除 20+ 字段平铺 drilling。
 * streaming/goal 子对象由 ribbons 传入；approval/runNotice/activeSessionId
 * 仍平铺（它们同时被 ChatComposerWrapper 其他消费面引用）。
 */
export interface RibbonsGroup {
  streaming: Omit<StreamingRibbonProps, 'runNotice' | 'onDismissRunNotice'>;
  goal: GoalRibbonProps;
}

export interface ChatComposerWrapperProps {
  mainSurface: string;
  emptyKind: string | null;
  composerElement: React.ReactNode;
  /** R2-5 B3：ribbons 专属字段分组（调用方构造稳定引用） */
  ribbons: RibbonsGroup;
  runNotice: RunNotice | null;
  onDismissRunNotice: () => void;
  pendingApprovalCount: number;
  showApprovalDock: boolean;
  pendingApprovalSummary: string;
  pendingApprovalToolId: string;
  pendingApprovalMsgId: string;
  approvalBusy?: boolean;
  onApprovalAllow?: (toolId: string, msgId: string, remember?: boolean) => void;
  onApprovalDeny?: (toolId: string, msgId: string) => void;
  activeSessionId: string | null;
  openSidePanel: (panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files') => void;
  handleGlobalTabClick: (cardId: string) => void;
}

export const ChatComposerWrapper: React.FC<ChatComposerWrapperProps> = React.memo(({
  mainSurface,
  composerElement,
  ribbons,
  runNotice,
  onDismissRunNotice,
  pendingApprovalCount,
  showApprovalDock,
  pendingApprovalSummary,
  pendingApprovalToolId,
  pendingApprovalMsgId,
  approvalBusy = false,
  onApprovalAllow,
  onApprovalDeny,
  activeSessionId,
}) => {
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

  const composerAbove: ChatComposerAboveProps = useMemo(
    () => ({
      pendingCount: pendingApprovalCount,
      firstToolId: pendingApprovalToolId,
      firstMsgId: pendingApprovalMsgId,
      firstSummary: pendingApprovalSummary,
      approvalBusy,
      onApprovalAllow: onApprovalAllow ?? noopApproval,
      onApprovalDeny: onApprovalDeny ?? noopApproval,
    }),
    [
      pendingApprovalCount,
      pendingApprovalToolId,
      pendingApprovalMsgId,
      pendingApprovalSummary,
      approvalBusy,
      onApprovalAllow,
      onApprovalDeny,
    ]
  );

  const floatHasContent =
    pendingApprovalCount > 0 ||
    ribbons.goal.inPlanMode ||
    ribbons.goal.goalModeActive;

  return (
    <div
      className={styles.chatFooter}
      data-testid="chat-footer"
      style={{
        display: mainSurface === 'scheduled' ? 'none' : undefined,
      }}
    >
      {/* chatCol 与消息 listInner 同 max-width / 水平 padding，对齐 stream + composer */}
      <div className={styles.chatCol}>
        <ChatStatusRibbons
          streaming={{ ...ribbons.streaming, runNotice, onDismissRunNotice }}
          goal={ribbons.goal}
          approval={approval}
          omitPlanRibbons
          omitApprovalDock
        />

        <div className={styles.composerDock} data-composer-wrapper="">
          <div
            className={styles.floatZone}
            data-composer-float-zone=""
            hidden={!floatHasContent && !liftApproval}
          >
            <SlotOutlet
              slotKey="workspace.chat.composerAbove"
              context={composerAbove}
              fallback={null}
            />
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
            <PlanGoalRibbons
              docked
              plan={{
                inPlanMode: ribbons.goal.inPlanMode,
                planApproved: ribbons.goal.planApproved,
                onApprovePlan: ribbons.goal.onApprovePlan,
              }}
              goal={{
                goalModeActive: ribbons.goal.goalModeActive,
                goalText: ribbons.goal.goalText,
                goalIteration: ribbons.goal.goalIteration,
                goalTasksDone: ribbons.goal.goalTasksDone ?? 0,
                goalTasksTotal: ribbons.goal.goalTasksTotal ?? 0,
                onStopGoal: ribbons.goal.onStopGoal,
              }}
            />
          </div>

          {/* composer 始终在 .chatFooter 渲染（不再注入到 ChatEmptyState 内）。 */}
          {composerElement}
        </div>
      </div>
    </div>
  );
});

function noopApproval(_toolId: string, _msgId: string, _remember?: boolean): void {
  /* 关插件路径不消费 composerAbove；缺回调时按钮无操作 */
}
