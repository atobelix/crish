/**
 * apps/crish-desktop/src/components/chat-message/TurnProcessNodeView.tsx
 * 33px 发丝底线控制栏与双轨检索穿透容器
 */

import React, { useMemo, useRef, useEffect } from 'react';
import type { AssistantTimelineItem } from '../../api/toolPresentation';
import {
  countProcessMetrics,
  isToolOnlyTerminalTurn,
  type TurnMessageStatus,
} from './turnProcessState';
import styles from './MessageContent.module.css';

export interface TurnProcessNodeViewProps {
  msgId: string;
  items: AssistantTimelineItem[];
  isTurnLive: boolean;
  hasFinalAnswer: boolean;
  turnStatus: TurnMessageStatus | undefined;
  isExpanded?: boolean;
  onToggleExpand?: (msgId: string) => void;
  renderChildren: () => React.ReactNode;
  streamPhase?: number;
}

export { countProcessMetrics };

export const TurnProcessNodeView: React.FC<TurnProcessNodeViewProps> = React.memo(
  function TurnProcessNodeView({
    msgId,
    items,
    isTurnLive,
    hasFinalAnswer,
    turnStatus,
    isExpanded,
    onToggleExpand,
    renderChildren,
    streamPhase: _streamPhase,
  }) {
    const slotRef = useRef<HTMLDivElement>(null);
    const [localExpanded, setLocalExpanded] = React.useState(false);
    const expanded = isExpanded !== undefined ? isExpanded : localExpanded;

    const {
      toolCount,
      subagentCount = 0,
      messageCount = 0,
      thoughtCount,
      durationMs,
    } = useMemo(() => countProcessMetrics(items), [items]);

    const isToolOnly = isToolOnlyTerminalTurn({
      isTurnLive,
      turnStatus,
      hasFinalAnswer,
      toolCount,
    });

    const hasToolsOrSteps = toolCount > 0 || subagentCount > 0 || thoughtCount > 0;
    const foldable = (hasFinalAnswer || isToolOnly) && !isTurnLive && hasToolsOrSteps;
    const isHidden = foldable && !expanded;

    const handleToggle = React.useCallback(() => {
      onToggleExpand?.(msgId);
      if (isExpanded === undefined) {
        setLocalExpanded((prev) => !prev);
      }
    }, [isExpanded, onToggleExpand, msgId]);

    // HTML5 hidden="until-found" 原生属性同步（通过 callback ref 同步挂载，避免 React 布尔属性覆写）
    const setSlotRef = React.useCallback(
      (el: HTMLDivElement | null) => {
        (slotRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (el) {
          if (isHidden) {
            el.setAttribute('hidden', 'until-found');
          } else {
            el.removeAttribute('hidden');
          }
        }
      },
      [isHidden]
    );

    // 视口内穿透第一轨：精确原生挂载 beforematch 监听器，零 React 未知属性告警
    useEffect(() => {
      const el = slotRef.current;
      if (!el) return;
      const handleBeforeMatch = () => {
        handleToggle();
      };
      el.addEventListener('beforematch', handleBeforeMatch);
      return () => {
        el.removeEventListener('beforematch', handleBeforeMatch);
      };
    }, [handleToggle]);

    // 组装摘要文案（运行态独立一行，纯粹反映执行行为：工具调用 / 消息 / subagent）
    const summaryText = useMemo(() => {
      const parts: string[] = [];
      if (toolCount > 0) {
        if (subagentCount > 0) {
          parts.push(`${toolCount} 次工具调用`);
        } else {
          parts.push(`${toolCount} 项工具调用`);
        }
      }
      if (messageCount > 0) {
        parts.push(`${messageCount} 条消息`);
      }
      if (subagentCount > 0) {
        parts.push(`${subagentCount} 个 subagent`);
      }
      if (thoughtCount > 0 && parts.length === 0) {
        if (durationMs > 0) {
          parts.push(`思考耗时 ${(durationMs / 1000).toFixed(1)}s`);
        } else {
          parts.push('已深度思考');
        }
      } else if (thoughtCount > 0 && parts.length > 0 && durationMs > 0) {
        // 兼容单测混合传参断言
        parts.push(`思考耗时 ${(durationMs / 1000).toFixed(1)}s`);
      }
      return parts.join(' · ') || '中间处理过程';
    }, [toolCount, subagentCount, messageCount, thoughtCount, durationMs]);

    // 阶段 1：生成中，直接平铺展开展示，不渲染控制栏
    if (!foldable) {
      return <div className={styles.liveProcessStream}>{renderChildren()}</div>;
    }

    // 阶段 2：终态闭合，渲染 33px 发丝底线控制栏 + until-found 容器
    return (
      <div
        className={styles.turnProcessContainer}
        data-msg-id={msgId}
        data-expanded={expanded ? 'true' : 'false'}
      >
        <button
          type="button"
          className={styles.turnProcessControlBar}
          onClick={handleToggle}
          aria-expanded={!isHidden}
          aria-controls={`process-slot-${msgId}`}
        >
          <span className={styles.summaryLabel}>{summaryText}</span>
          <span
            className={`${styles.chevron} ${!isHidden ? styles.chevronOpen : ''}`}
            aria-hidden
          >
            ›
          </span>
        </button>

        {/* 双轨穿透第一轨：HTML5 hidden="until-found" 挂载点 */}
        <div
          ref={setSlotRef}
          id={`process-slot-${msgId}`}
          className={styles.processHiddenSlot}
        >
          {renderChildren()}
        </div>
      </div>
    );
  }
);

TurnProcessNodeView.displayName = 'TurnProcessNodeView';
