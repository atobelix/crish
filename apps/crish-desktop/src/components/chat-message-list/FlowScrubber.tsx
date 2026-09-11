import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SessionMessage } from '../../store/types';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import styles from './FlowScrubber.module.css';
import {
  USER_BUBBLE_SELECTOR,
  buildScrubberSegments,
  isConversationFlowOn,
  readPurposeLabel,
  scrollToScrubberTarget,
  timeLabelFromTimestamp,
  wheelDeltaY,
  type ScrubberTick,
} from './flowScrubberModel';
import { DEFAULT_PIN_COLOR } from '../chat-message-row/colorPickerUtils';
import { Tooltip } from '../ui';
import { AppIcon } from '../ui/icons';

export interface FlowScrubberProps {
  messages: SessionMessage[];
  manager: VirtualScrollManager;
  /** VSM 总高，实际测量变化时重算 heightPercent */
  totalHeight: number;
  scrollerRef: React.RefObject<HTMLElement | null> | React.RefObject<HTMLDivElement | null>;
  pinnedIdSet?: Set<string>;
  pinnedColors?: Record<string, string>;
  onTogglePin?: (id: string) => void;
}

interface ActiveHoverState {
  tick: ScrubberTick;
  purpose?: string;
  targetY: number;
}

const FlowScrubberInner: React.FC<FlowScrubberProps> = ({
  messages,
  manager,
  totalHeight,
  scrollerRef,
  pinnedIdSet,
  pinnedColors,
  onTogglePin,
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const tickRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const enterTimerRef = useRef<number | null>(null);
  const leaveTimerRef = useRef<number | null>(null);
  const [activeHover, setActiveHover] = useState<ActiveHoverState | null>(null);
  const activeClass = styles.isActive;

  const segments = useMemo(
    () => buildScrubberSegments(messages, (id) => manager.getHeight(id)),
    // totalHeight 驱动实测回写后重算比例
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, manager, totalHeight]
  );

  const scroller = scrollerRef.current;
  const flowOn = isConversationFlowOn(scroller);
  void Tooltip;

  const onJump = useCallback(
    (id: string) => {
      const el = scrollerRef.current;
      if (!el) return;
      scrollToScrubberTarget(el, id, manager);
    },
    [manager, scrollerRef]
  );

  const handleTickPointerEnter = useCallback(
    (
      tick: ScrubberTick,
      purpose: string | undefined,
      el: HTMLElement
    ) => {
      if (leaveTimerRef.current != null) {
        window.clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      const wrap = wrapperRef.current;
      if (!wrap) return;
      const wrapRect = wrap.getBoundingClientRect();
      const tickRect = el.getBoundingClientRect();
      const rawY = tickRect.top - wrapRect.top + tickRect.height / 2;
      // 边界钳制，确保卡片在顶部和底部不会越界被遮挡
      const clampedY = Math.max(70, Math.min(wrapRect.height - 70, rawY));

      const nextState: ActiveHoverState = {
        tick,
        purpose,
        targetY: clampedY,
      };

      if (activeHover != null) {
        // 已经在轨道上 hover 漫游：立刻无缝更新卡片内容与高度，零延迟，绝不先关后开！
        setActiveHover(nextState);
      } else {
        // 首次进入：60ms 快速响应
        if (enterTimerRef.current != null) {
          window.clearTimeout(enterTimerRef.current);
        }
        enterTimerRef.current = window.setTimeout(() => {
          enterTimerRef.current = null;
          setActiveHover(nextState);
        }, 60);
      }
    },
    [activeHover]
  );

  const handleTickPointerLeave = useCallback(() => {
    if (enterTimerRef.current != null) {
      window.clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
    }
    if (leaveTimerRef.current == null) {
      leaveTimerRef.current = window.setTimeout(() => {
        leaveTimerRef.current = null;
        setActiveHover(null);
      }, 180);
    }
  }, []);

  const handleCardMouseEnter = useCallback(() => {
    if (leaveTimerRef.current != null) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  }, []);

  const handleCardMouseLeave = useCallback(() => {
    if (leaveTimerRef.current == null) {
      leaveTimerRef.current = window.setTimeout(() => {
        leaveTimerRef.current = null;
        setActiveHover(null);
      }, 180);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (enterTimerRef.current != null) window.clearTimeout(enterTimerRef.current);
      if (leaveTimerRef.current != null) window.clearTimeout(leaveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const wrap = wrapperRef.current;
    const scrollEl = scrollerRef.current;
    if (!wrap || !scrollEl) return;
    const onWheel = (e: WheelEvent) => {
      scrollEl.scrollTop += wheelDeltaY(e);
    };
    wrap.addEventListener('wheel', onWheel, { passive: true });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [scrollerRef, segments]);

  useEffect(() => {
    const wrap = wrapperRef.current;
    const scrollEl = scrollerRef.current;
    if (!wrap || !scrollEl) return;

    const updateActiveTicks = () => {
      const activeIds = new Set<string>();

      // 1. 从当前挂载在 DOM 中的用户气泡检查相交状态
      const bubbles = scrollEl.querySelectorAll(USER_BUBBLE_SELECTOR);
      const scrollerRect = scrollEl.getBoundingClientRect();
      bubbles.forEach((node) => {
        if (node instanceof HTMLElement && node.dataset.msgId) {
          const rect = node.getBoundingClientRect();
          if (rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom) {
            activeIds.add(node.dataset.msgId);
          }
        }
      });

      // 2. 结合 VSM 视口偏移量兜底（防止虚拟滚动未完全挂载时失活）
      const scrollTop = scrollEl.scrollTop;
      const viewH = scrollEl.clientHeight;
      if (viewH > 0 && manager) {
        const order = manager.getOrder();
        for (let i = 0; i < order.length; i++) {
          const id = order[i]!;
          const offset = manager.getOffset(i);
          const h = manager.getHeight(id);
          if (offset + h >= scrollTop && offset <= scrollTop + viewH) {
            activeIds.add(id);
          }
        }
      }

      wrap.querySelectorAll<HTMLElement>('[data-flow-scrubber-tick]').forEach((tick) => {
        const id = tick.dataset.msgId;
        if (id && activeClass) {
          tick.classList.toggle(activeClass, activeIds.has(id));
        }
      });
    };

    scrollEl.addEventListener('scroll', updateActiveTicks, { passive: true });

    let io: IntersectionObserver | null = null;
    let timer: number | null = null;
    let mo: MutationObserver | null = null;

    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const target = entry.target;
            if (!(target instanceof HTMLElement)) continue;
            const id = target.dataset.msgId;
            if (!id) continue;
            const tick = wrap.querySelector(
              `[data-flow-scrubber-tick][data-msg-id="${CSS.escape(id)}"]`
            );
            if (tick instanceof HTMLElement && activeClass) {
              tick.classList.toggle(activeClass, entry.isIntersecting);
            }
          }
        },
        { root: scrollEl, threshold: 0 }
      );

      const observeUsers = () => {
        if (!io) return;
        io.disconnect();
        scrollEl.querySelectorAll(USER_BUBBLE_SELECTOR).forEach((node) => {
          io?.observe(node);
        });
      };
      observeUsers();

      if (typeof MutationObserver !== 'undefined') {
        mo = new MutationObserver(() => {
          if (timer != null) window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            timer = null;
            observeUsers();
            updateActiveTicks();
          }, 80);
        });
        mo.observe(scrollEl, { childList: true, subtree: true });
      }
    }

    updateActiveTicks();

    return () => {
      scrollEl.removeEventListener('scroll', updateActiveTicks);
      if (timer != null) window.clearTimeout(timer);
      io?.disconnect();
      mo?.disconnect();
    };
  }, [activeClass, manager, scrollerRef, segments]);

  if (segments.length === 0) return null;

  const hasPinned = Boolean(pinnedIdSet && pinnedIdSet.size > 0);
  const firstPinColor =
    hasPinned && pinnedColors && Object.values(pinnedColors).length > 0
      ? Object.values(pinnedColors)[0] || DEFAULT_PIN_COLOR
      : DEFAULT_PIN_COLOR;

  return (
    <div
      ref={wrapperRef}
      className={styles.wrapper}
      data-flow-scrubber=""
      data-has-pinned={hasPinned ? 'true' : undefined}
      style={
        hasPinned
          ? ({ '--scrubber-pinned-tint': firstPinColor } as React.CSSProperties)
          : undefined
      }
      aria-label="对话定位刻度"
      role="navigation"
    >
      <div className={styles.root} data-flow-scrubber-track="">
        {segments.map((seg) =>
          seg.type === 'gap' ? (
            <div
              key={seg.key}
              className={styles.gap}
              style={{ flexGrow: seg.flex }}
              data-flow-scrubber-gap=""
              aria-hidden
            />
          ) : (
            (() => {
              // 铁律：固定功能仅针对用户消息，AI 助手消息无固定功能
              const isPinned = Boolean(pinnedIdSet?.has(seg.tick.id));
              const pinColor = pinnedColors?.[seg.tick.id] || DEFAULT_PIN_COLOR;

              const tickStyle = isPinned
                ? ({ '--tick-pin-color': pinColor } as React.CSSProperties)
                : undefined;

              const purpose = flowOn
                ? readPurposeLabel(scroller, seg.tick.nextAssistantId)
                : undefined;

              const ariaLabel = seg.tick.assistantSnippet
                ? `${seg.tick.snippet} · 答: ${seg.tick.assistantSnippet}`
                : seg.tick.snippet;

              const isCurrentHovered = activeHover?.tick.id === seg.tick.id;

              return (
                <div className={styles.tickSlot} key={seg.tick.id}>
                  <button
                    ref={(el) => {
                      if (el) tickRefs.current.set(seg.tick.id, el);
                      else tickRefs.current.delete(seg.tick.id);
                    }}
                    type="button"
                    className={`${styles.tick}${isPinned ? ` ${styles.isPinnedTick}` : ''}${isCurrentHovered ? ` ${styles.isHoveredTick}` : ''}`}
                    style={tickStyle}
                    data-flow-scrubber-tick=""
                    data-msg-id={seg.tick.id}
                    data-is-pinned={isPinned ? 'true' : undefined}
                    data-height-percent={String(seg.tick.heightPercent)}
                    aria-label={ariaLabel}
                    aria-expanded={isCurrentHovered}
                    onClick={() => onJump(seg.tick.id)}
                    onMouseEnter={(e) =>
                      handleTickPointerEnter(
                        seg.tick,
                        purpose,
                        e.currentTarget
                      )
                    }
                    onMouseLeave={handleTickPointerLeave}
                  />
                </div>
              );
            })()
          )
        )}
      </div>

      {/* 单一挂载的悬浮卡片：避免不同 tick 间重复销毁与重建动画，切换平滑连贯 */}
      {activeHover ? (
        (() => {
          const hoveredTick = activeHover.tick;
          const isCurrentPinned = Boolean(pinnedIdSet?.has(hoveredTick.id));
          const currentPinColor = pinnedColors?.[hoveredTick.id] || DEFAULT_PIN_COLOR;

          return (
            <div
              className={styles.scrubberFloatingTooltip}
              style={
                {
                  top: `${activeHover.targetY}px`,
                  ...(isCurrentPinned
                    ? {
                        '--tooltip-card-bg': `color-mix(in srgb, ${currentPinColor} 5%, var(--bg-card))`,
                        '--tooltip-card-border': `color-mix(in srgb, ${currentPinColor} 22%, var(--border-subtle))`,
                      }
                    : {}),
                } as React.CSSProperties
              }
              onMouseEnter={handleCardMouseEnter}
              onMouseLeave={handleCardMouseLeave}
            >
              <div className={styles.scrubberTooltipCard}>
                <div className={styles.scrubberTooltipHeader}>
                  <span className={styles.scrubberTooltipTime}>
                    {activeHover.purpose ||
                      timeLabelFromTimestamp(hoveredTick.timestamp)}
                  </span>
                  {onTogglePin && (
                    <button
                      type="button"
                      className={`${styles.scrubberPinBtn}${isCurrentPinned ? ` ${styles.isPinned}` : ''}`}
                      style={
                        isCurrentPinned
                          ? ({ '--tick-pin-color': currentPinColor } as React.CSSProperties)
                          : undefined
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        onTogglePin(hoveredTick.id);
                      }}
                      aria-label={isCurrentPinned ? '取消固定' : '固定'}
                    >
                      {isCurrentPinned ? (
                        <AppIcon name="pin-off" size={12} />
                      ) : (
                        <AppIcon name="pin" size={12} />
                      )}
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  className={styles.scrubberTooltipUserBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    onJump(hoveredTick.id);
                  }}
                  aria-label="跳转到用户提问"
                >
                  <span className={styles.scrubberTooltipUserText}>
                    {hoveredTick.snippet}
                  </span>
                </button>

                {hoveredTick.assistantSnippet ? (
                  <button
                    type="button"
                    className={styles.scrubberTooltipAssistantBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (hoveredTick.nextAssistantId) {
                        onJump(hoveredTick.nextAssistantId);
                      }
                    }}
                    aria-label="跳转到助手回复"
                  >
                    <span className={styles.scrubberTooltipAssistantText}>
                      {hoveredTick.assistantSnippet}
                    </span>
                  </button>
                ) : null}
              </div>
            </div>
          );
        })()
      ) : null}
    </div>
  );
};

export const FlowScrubber = React.memo(FlowScrubberInner);
FlowScrubber.displayName = 'FlowScrubber';
