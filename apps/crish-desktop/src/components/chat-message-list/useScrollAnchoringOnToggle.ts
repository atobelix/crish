/**
 * apps/crish-desktop/src/components/chat-message-list/useScrollAnchoringOnToggle.ts
 *
 * 滚动锚定与折叠/展开交互守卫 Hook。
 *
 * 【核心设计意图】
 * 用户点击展开或折叠内容时（思考区、工具调用组、单工具详情、长用户消息、markdown details等）：
 * 无论当前是否处于最新区域（isAtBottom = true），视图必须以用户点击位置为锚点自然向下展开，
 * 严禁在展开/折叠后强行将视口无脑滚动至物理最底部（maxScroll）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { SessionMessage } from '../../store/types';

/** 滚动条手势命中区（右侧像素宽度） */
export const SCROLLBAR_TRACK_HIT_WIDTH_PX = 18;

/** 折叠/展开交互锚定保护锁窗口持续时间（毫秒） */
export const ANCHOR_GUARD_LOCK_WINDOW_MS = 500;

/** 匹配折叠/展开与交互触发器的 DOM 选择器 */
export const TOGGLE_INTERACTIVE_SELECTOR = [
  'summary',
  'details',
  'button',
  '[role="button"]',
  '[aria-expanded]',
  '[aria-controls]',
  '[data-flow-thinking]',
  '[data-process-segment]',
  '[data-testid*="toggle"]',
  '[data-testid*="chevron"]',
  '[data-testid*="expand"]',
  '[data-testid*="tool-group"]',
  '[data-testid*="process-slot"]',
  '[class*="toggle" i]',
  '[class*="chevron" i]',
  '[class*="fold" i]',
  '[class*="expand" i]',
  '[class*="rot" i]',
  '[class*="controlBar" i]',
  '[class*="groupHeader" i]',
  '[class*="toolRowHead" i]',
  '[class*="summary" i]',
  '[class*="Accordion" i]',
  '[class*="accordion" i]',
].join(',');

export function isRecordEqual(
  a: Record<string, boolean> | undefined,
  b: Record<string, boolean> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) {
    const emptyA = !a || Object.keys(a).length === 0;
    const emptyB = !b || Object.keys(b).length === 0;
    return emptyA && emptyB;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length === 0 && keysB.length === 0) return true;
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export interface UseScrollAnchoringOnToggleParams {
  containerRef: React.RefObject<HTMLDivElement | null>;
  isAtBottomRef: React.MutableRefObject<boolean>;
  setIsAtBottom: (atBottom: boolean) => void;
  cancelProgrammaticScroll: () => void;
  expandedUserMsgs?: Record<string, boolean>;
  expandedTools?: Record<string, boolean>;
  messages?: SessionMessage[];
}

export interface UseScrollAnchoringOnToggleReturn {
  handlePointerDownCapture: React.PointerEventHandler<HTMLDivElement>;
  handleKeyDownCapture: React.KeyboardEventHandler<HTMLDivElement>;
  isAnchorLocked: () => boolean;
}

export function useScrollAnchoringOnToggle({
  containerRef,
  isAtBottomRef,
  setIsAtBottom,
  cancelProgrammaticScroll,
  expandedUserMsgs,
  expandedTools,
  messages,
}: UseScrollAnchoringOnToggleParams): UseScrollAnchoringOnToggleReturn {
  const anchorLockUntilRef = useRef<number>(0);

  const isAnchorLocked = useCallback(
    () => Date.now() < anchorLockUntilRef.current,
    []
  );

  const activateAnchorLock = useCallback(() => {
    anchorLockUntilRef.current = Date.now() + ANCHOR_GUARD_LOCK_WINDOW_MS;
    isAtBottomRef.current = false;
    setIsAtBottom(false);
    cancelProgrammaticScroll();
  }, [cancelProgrammaticScroll, isAtBottomRef, setIsAtBottom]);

  // 1. 指针捕获：区分滚动条拖拽与折叠/展开交互
  const handlePointerDownCapture = useCallback<
    React.PointerEventHandler<HTMLDivElement>
  >(
    (e) => {
      const target = e.target as Element | null;
      // 豁免：回底浮钮本身即为程序吸底触发器，绝不可解除吸底或锁定折叠展开锚定（避免产生 1 帧显隐闪烁）
      if (
        target?.closest('[data-testid="chat-scroll-floor-slot"]') ||
        target?.closest('[data-testid="chat-scroll-floor-btn"]') ||
        target?.closest('[class*="floorSlot"]') ||
        target?.closest('[class*="chatScrollFab"]')
      ) {
        return;
      }

      cancelProgrammaticScroll();

      // (a) 滚动条轨道命中：用户手动拖拽滚动条，解除吸底
      if (
        e.currentTarget.clientWidth > SCROLLBAR_TRACK_HIT_WIDTH_PX &&
        typeof e.nativeEvent?.offsetX === 'number' &&
        e.nativeEvent.offsetX >=
          e.currentTarget.clientWidth - SCROLLBAR_TRACK_HIT_WIDTH_PX
      ) {
        isAtBottomRef.current = false;
        setIsAtBottom(false);
        return;
      }

      // (b) 展开/折叠控件或交互项点击命中：
      // 用户点击折叠/展开内容时，视口必须以点击位置为锚点向下展开，绝不强行自动滚到底部！
      if (target?.closest(TOGGLE_INTERACTIVE_SELECTOR)) {
        activateAnchorLock();
      }
    },
    [activateAnchorLock, cancelProgrammaticScroll, isAtBottomRef, setIsAtBottom]
  );

  // 2. 键盘交互捕获：Enter 或 Space 激活折叠/展开时同样解除吸底
  const handleKeyDownCapture = useCallback<
    React.KeyboardEventHandler<HTMLDivElement>
  >(
    (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        const target = e.target as Element | null;
        if (
          target?.closest('[data-testid="chat-scroll-floor-slot"]') ||
          target?.closest('[data-testid="chat-scroll-floor-btn"]') ||
          target?.closest('[class*="floorSlot"]') ||
          target?.closest('[class*="chatScrollFab"]')
        ) {
          return;
        }
        if (target?.closest(TOGGLE_INTERACTIVE_SELECTOR)) {
          activateAnchorLock();
        }
      }
    },
    [activateAnchorLock]
  );

  // 3. 原生 <details> toggle 事件监听：支持 markdown 原生折叠展开
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onToggle = () => {
      activateAnchorLock();
    };

    container.addEventListener('toggle', onToggle, true);
    return () => {
      container.removeEventListener('toggle', onToggle, true);
    };
  }, [containerRef, activateAnchorLock]);

  // 4. 外部展开状态（expandedUserMsgs / expandedTools）真实变更时：解除吸底保证自然向下展开
  const prevExpandedUserMsgsRef = useRef(expandedUserMsgs);
  const prevExpandedToolsRef = useRef(expandedTools);

  useLayoutEffect(() => {
    const userMsgsChanged = !isRecordEqual(
      prevExpandedUserMsgsRef.current,
      expandedUserMsgs
    );
    const toolsChanged = !isRecordEqual(
      prevExpandedToolsRef.current,
      expandedTools
    );

    if (userMsgsChanged || toolsChanged) {
      prevExpandedUserMsgsRef.current = expandedUserMsgs;
      prevExpandedToolsRef.current = expandedTools;
      activateAnchorLock();
    }
  }, [expandedUserMsgs, expandedTools, activateAnchorLock]);

  // 5. 用户主动发送新消息时：恢复吸底，确保新一轮提问进入自动跟随
  const prevMsgCountRef = useRef(messages?.length ?? 0);
  useLayoutEffect(() => {
    const count = messages?.length ?? 0;
    if (count > prevMsgCountRef.current) {
      const lastMsg = messages?.[count - 1];
      if (lastMsg && lastMsg.sender === 'user') {
        anchorLockUntilRef.current = 0;
        isAtBottomRef.current = true;
        setIsAtBottom(true);
      }
    }
    prevMsgCountRef.current = count;
  }, [messages, isAtBottomRef, setIsAtBottom]);

  return {
    handlePointerDownCapture,
    handleKeyDownCapture,
    isAnchorLocked,
  };
}
