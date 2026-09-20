import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { SessionMessage } from '../../store/types';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import { ResizeObserverManager } from '../../services/ResizeObserverManager';
import styles from './FlowScrubber.module.css';
import {
  USER_BUBBLE_SELECTOR,
  SCRUBBER_TICK_PITCH_PX,
  buildScrubberSegments,
  capScrubberSegments,
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

/** 轨道容量下限：极矮轨道也至少给用户几枚可点刻度 */
const MIN_SCRUBBER_TICKS = 6;
/** 轨道容量上限：防御异常超高轨道导致 DOM 再次无界 */
const MAX_SCRUBBER_TICKS = 200;
/** 首帧未测得轨道高度前的保守缺省（jsdom 下 clientHeight 恒 0） */
const DEFAULT_SCRUBBER_RAIL_HEIGHT_PX = 600;

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

  // 轨道可用高度：刻度数上限由**像素容量**决定，与消息数无关（见
  // capScrubberSegments 注释）。首帧未测得前用保守缺省值（jsdom 下
  // clientHeight 恒 0，测试环境亦走该分支）。
  const [railHeight, setRailHeight] = useState(0);
  useLayoutEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const measure = () => setRailHeight(wrap.clientHeight);
    measure();
    const ro = ResizeObserverManager.getInstance();
    ro.observe(wrap, measure);
    return () => {
      ro.unobserve(wrap, measure);
    };
  }, []);

  const maxTicks = Math.max(
    MIN_SCRUBBER_TICKS,
    Math.min(
      MAX_SCRUBBER_TICKS,
      Math.floor(
        (railHeight > 0 ? railHeight : DEFAULT_SCRUBBER_RAIL_HEIGHT_PX) /
          SCRUBBER_TICK_PITCH_PX
      )
    )
  );

  // 有界刻度渲染：超出轨道容量的刻度既不可见又使每次提交的协调成本随消息
  // 数线性增长。带固定标记（pinned）的刻度无条件保留。
  const renderedSegments = useMemo(
    () =>
      capScrubberSegments(segments, maxTicks, (id) =>
        Boolean(pinnedIdSet?.has(id))
      ),
    [segments, maxTicks, pinnedIdSet]
  );

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
    (tick: ScrubberTick, el: HTMLElement) => {
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

      // purpose 按需读取（悬停时单次），绝不在渲染期为每个刻度读取：
      // readPurposeLabel 内部是 root.querySelector('[data-msg-id="…"] [data-flow-purpose]')
      // —— 全子树 DOM 查询。历史实现在 render 里对每个刻度调用一次 ⇒ 每次提交
      // 成本 = 用户消息数 × 子树节点数（N=6000 时约 2700 万次节点访问，
      // 单次提交渲染 49ms），而 purpose 仅被下方悬浮卡片消费。
      const scrollerEl = scrollerRef.current;
      const purpose = isConversationFlowOn(scrollerEl)
        ? readPurposeLabel(scrollerEl, tick.nextAssistantId)
        : undefined;

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
    [activeHover, scrollerRef]
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
  }, [activeClass, manager, scrollerRef, renderedSegments]);

  if (renderedSegments.length === 0) return null;

  const hasPinned = Boolean(pinnedIdSet && pinnedIdSet.size > 0);
  return (
    <div
      ref={wrapperRef}
      className={styles.wrapper}
      data-flow-scrubber=""
      data-has-pinned={hasPinned ? 'true' : undefined}
      aria-label="对话定位刻度"
      role="navigation"
    >
      <div className={styles.root} data-flow-scrubber-track="">
        {renderedSegments.map((seg) =>
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
                      handleTickPointerEnter(seg.tick, e.currentTarget)
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
