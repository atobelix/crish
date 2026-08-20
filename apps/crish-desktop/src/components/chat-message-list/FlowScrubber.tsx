/**
 * 默认壳 FlowScrubber：贴 chat 叶滚动条左侧的无轨刻度。
 * 插件 ON 只丰富 tooltip（purpose / 时间）；DOM 不进插件包。
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Tooltip } from '../ui';
import type { SessionMessage } from '../../store/types';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import styles from './FlowScrubber.module.css';
import {
  USER_BUBBLE_SELECTOR,
  buildScrubberSegments,
  formatTickTooltip,
  isConversationFlowOn,
  readPurposeLabel,
  scrollToScrubberTarget,
  timeLabelFromTimestamp,
  wheelDeltaY,
  type ScrubberTick,
} from './flowScrubberModel';

export interface FlowScrubberProps {
  messages: SessionMessage[];
  manager: VirtualScrollManager;
  /** VSM 总高，实际测量变化时重算 heightPercent */
  totalHeight: number;
  scrollerRef: React.RefObject<HTMLElement | null> | React.RefObject<HTMLDivElement | null>;
}

function tickTooltip(
  tick: ScrubberTick,
  flowOn: boolean,
  scroller: HTMLElement | null
): string {
  const purpose = flowOn
    ? readPurposeLabel(scroller, tick.nextAssistantId)
    : undefined;
  return formatTickTooltip({
    snippet: tick.snippet,
    flowOn,
    timeLabel: timeLabelFromTimestamp(tick.timestamp),
    purpose,
  });
}

const FlowScrubberTick: React.FC<{
  tick: ScrubberTick;
  tooltip: string;
  onJump: (id: string) => void;
}> = React.memo(function FlowScrubberTick({ tick, tooltip, onJump }) {
  return (
    <div className={styles.tickSlot} style={{ flexGrow: tick.flex }}>
      <Tooltip content={tooltip} side="left">
        <button
          type="button"
          className={styles.tick}
          data-flow-scrubber-tick=""
          data-msg-id={tick.id}
          data-height-percent={String(tick.heightPercent)}
          aria-label={tooltip}
          onClick={() => onJump(tick.id)}
        />
      </Tooltip>
    </div>
  );
});

const FlowScrubberInner: React.FC<FlowScrubberProps> = ({
  messages,
  manager,
  totalHeight,
  scrollerRef,
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const activeClass = styles.isActive;

  const segments = useMemo(
    () => buildScrubberSegments(messages, (id) => manager.getHeight(id)),
    // totalHeight 驱动实测回写后重算比例
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, manager, totalHeight]
  );

  const scroller = scrollerRef.current;
  const flowOn = isConversationFlowOn(scroller);

  const onJump = useCallback(
    (id: string) => {
      const el = scrollerRef.current;
      if (!el) return;
      scrollToScrubberTarget(el, id, manager);
    },
    [manager, scrollerRef]
  );

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
    if (!wrap || !scrollEl || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const io = new IntersectionObserver(
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

    let timer: number | null = null;
    const observeUsers = () => {
      io.disconnect();
      scrollEl.querySelectorAll(USER_BUBBLE_SELECTOR).forEach((node) => {
        io.observe(node);
      });
    };
    observeUsers();

    const mo = new MutationObserver(() => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        observeUsers();
      }, 80);
    });
    mo.observe(scrollEl, { childList: true, subtree: true });

    return () => {
      if (timer != null) window.clearTimeout(timer);
      io.disconnect();
      mo.disconnect();
    };
  }, [activeClass, scrollerRef, segments]);

  if (segments.length === 0) return null;

  return (
    <div
      ref={wrapperRef}
      className={styles.wrapper}
      data-flow-scrubber=""
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
            <FlowScrubberTick
              key={seg.tick.id}
              tick={seg.tick}
              tooltip={tickTooltip(seg.tick, flowOn, scroller)}
              onJump={onJump}
            />
          )
        )}
      </div>
    </div>
  );
};

export const FlowScrubber = React.memo(FlowScrubberInner);
FlowScrubber.displayName = 'FlowScrubber';
