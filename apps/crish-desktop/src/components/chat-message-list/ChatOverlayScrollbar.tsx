/**
 * 主聊天列表自研悬浮滚动条（S3 · 路线 B，按 ui/ScrollArea 先例同构）。
 *
 * 挂载点：MessageVirtualizer 的 .streamHost 内、与 scroller 并列的兄弟位。
 * 原生条由 overlay-scrollbar.css 的隐藏范式对 [data-chat-scroll-container]
 * 关停（display:none）+ .list 的 scrollbar-width:none 双保险，内容列从此
 * 不再为滚动条让出布局：有无溢出，正文列几何恒定。
 *
 * 纪律：
 * - 几何只读 scroller 本体（scrollTop/scrollHeight/clientWidth/Height），
 *   绝不反写滚动位置；唯一写回通道是拖拽（复用 ScrollArea 的
 *   useThumbDrag 换算，与先例单轨，不另造拖拽实现）；
 * - 同步由 scroll 事件 + ResizeObserver（scroller 与高度占位 spacer）
 *   驱动，只读已提交状态，绝不改动虚拟器的同步提交时序；
 * - 平滑门控由 chatOverlayScrollbarGeometry.decideThumbSync 逐帧裁决，
 *   经 thumb 的 data-smooth 属性落到 CSS 过渡上：总高阶跃才平滑，
 *   用户手势窗 / 拖拽 / 布局尺寸变化一律直写跟手；
 * - 显隐与 ScrollArea 同一三元组：入场 150ms decelerate + 100ms 延迟、
 *   退场 200ms emphasized，另加从右滑入（track 的 translateX，列自身
 *   overflow:hidden 自裁剪，不依赖祖先裁剪）；全部时长只消费 token，
 *   prefers-reduced-motion 下由 token 体系统一归零。
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import styles from './ChatOverlayScrollbar.module.css';
import { useThumbDrag } from '../ui/ScrollArea/useThumbDrag';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';
import {
  computeThumbGeometry,
  decideThumbSync,
  readScrollSnapshot,
  smoothModeOf,
  type ScrollGeometrySnapshot,
} from './chatOverlayScrollbarGeometry';

/** wheel / touch / 滚动键手势窗：窗内同步一律直写（跟手优先） */
const GESTURE_WINDOW_MS = 200;

const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

export interface ChatOverlayScrollbarProps {
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}

export const ChatOverlayScrollbar: React.FC<ChatOverlayScrollbarProps> = ({
  scrollerRef,
}) => {
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const thumbRefX = useRef<HTMLDivElement | null>(null);
  const prevSnapRef = useRef<ScrollGeometrySnapshot | null>(null);
  const lastWrittenRef = useRef<{ height: number; offset: number } | null>(
    null
  );
  const gestureUntilRef = useRef(0);
  const draggingRef = useRef(false);
  const visibleRef = useRef(false);
  const maxTravelRef = useRef(0);

  const [visible, setVisible] = useState(false);
  const [maxTravelPx, setMaxTravelPx] = useState(0);

  const sync = useCallback(() => {
    const el = scrollerRef.current;
    const thumb = thumbRef.current;
    if (!el || !thumb) return;
    const next = readScrollSnapshot(el);
    const geometry = computeThumbGeometry(next);
    const last = lastWrittenRef.current;
    // 几何无变化时不触碰 DOM：尤其不许改写 data-smooth——那会腰斩
    // 正在运行的总高过渡。prevSnap 仍须推进，供下一帧做增量裁决。
    if (
      !last ||
      last.height !== geometry.thumbHeightPx ||
      last.offset !== geometry.thumbOffsetPx
    ) {
      const decision = decideThumbSync(prevSnapRef.current, next, {
        gestureActive: performance.now() < gestureUntilRef.current,
        dragging: draggingRef.current,
      });
      const mode = smoothModeOf(decision);
      if (thumb.dataset.smooth !== mode) thumb.dataset.smooth = mode;
      thumb.style.height = `${geometry.thumbHeightPx}px`;
      thumb.style.transform = `translate3d(0, ${geometry.thumbOffsetPx}px, 0)`;
      lastWrittenRef.current = {
        height: geometry.thumbHeightPx,
        offset: geometry.thumbOffsetPx,
      };
    }
    prevSnapRef.current = next;
    if (geometry.maxTravelPx !== maxTravelRef.current) {
      maxTravelRef.current = geometry.maxTravelPx;
      setMaxTravelPx(geometry.maxTravelPx);
    }
    if (geometry.hasOverflow !== visibleRef.current) {
      visibleRef.current = geometry.hasOverflow;
      setVisible(geometry.hasOverflow);
    }
  }, [scrollerRef]);

  const {
    isDraggingY,
    handleThumbPointerDownY,
    handleThumbPointerMoveY,
    handleThumbPointerUpY,
  } = useThumbDrag({
    viewportRef: scrollerRef,
    thumbRefY: thumbRef,
    thumbRefX,
    maxTravelPxY: maxTravelPx,
    maxTravelPxX: 0,
  });

  useEffect(() => {
    draggingRef.current = isDraggingY;
    if (isDraggingY) sync();
  }, [isDraggingY, sync]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    sync();
    const markGesture = () => {
      gestureUntilRef.current = performance.now() + GESTURE_WINDOW_MS;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) markGesture();
    };
    el.addEventListener('scroll', sync, { passive: true });
    el.addEventListener('wheel', markGesture, { passive: true });
    el.addEventListener('touchstart', markGesture, { passive: true });
    el.addEventListener('touchmove', markGesture, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    const roManager = ResizeObserverManager.getInstance();
    roManager.observe(el, sync);
    const inner = el.querySelector<HTMLElement>('[data-chat-list-inner]');
    if (inner) roManager.observe(inner, sync);
    return () => {
      el.removeEventListener('scroll', sync);
      el.removeEventListener('wheel', markGesture);
      el.removeEventListener('touchstart', markGesture);
      el.removeEventListener('touchmove', markGesture);
      el.removeEventListener('keydown', onKeyDown);
      roManager.unobserve(el, sync);
      if (inner) roManager.unobserve(inner, sync);
    };
  }, [scrollerRef, sync]);

  const barVisible = visible || isDraggingY;

  return (
    <div
      className={
        barVisible ? `${styles.bar} ${styles.barVisible}` : styles.bar
      }
      data-chat-overlay-scrollbar=""
      data-visible={barVisible ? 'true' : 'false'}
      aria-hidden="true"
    >
      <div className={styles.track}>
        <div
          ref={thumbRef}
          className={
            isDraggingY ? `${styles.thumb} ${styles.dragging}` : styles.thumb
          }
          data-smooth="none"
          data-testid="chat-overlay-scrollbar-thumb"
          onPointerDown={handleThumbPointerDownY}
          onPointerMove={handleThumbPointerMoveY}
          onPointerUp={handleThumbPointerUpY}
          onPointerCancel={handleThumbPointerUpY}
        />
      </div>
    </div>
  );
};
