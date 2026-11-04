/**
 * apps/crish-desktop/src/components/chat-message-list/useSessionOpenAnchor.ts
 *
 * 会话开局编排（批 B ⑱/⑳；从 MessageVirtualizer 抽出——行数门禁收敛，
 * 与 messageVirtualizerScrollState 同模式）：
 * - 开局闩锁（渲染期推进）：旧会话 flush 捕获最终阅读位；新会话按保存
 *   记录裁决待恢复锚点（跟随态 / 无记录 → null，直达真底，R12 不回退）；
 * - 阅读锚点捕获接线（几何未稳 / 恢复待决窗口不采样）；
 * - 就绪遮罩状态与退出：测高遍数走完 + 锚点落定后过一帧淡出，
 *   减少动效时直接卸载。遮罩探针只读就绪条件、从不写滚动位置。
 */

import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import type { PagingAnchor } from './PagingAnchor';
import {
  readReadingAnchor,
  resolveRestoreAnchor,
  useReadingAnchorCapture,
} from './readingAnchorStore';
import { isSessionCoverReady } from './SessionReadyCover';
import { prefersReducedMotion } from './messageVirtualizerScrollPlan';

export interface SessionOpenAnchor {
  /** 待恢复锚点（非空 = 恢复窗口未落定；切会话重置 / 首挂载 / 测高三处消费） */
  anchorRestoreTargetRef: React.RefObject<PagingAnchor | null>;
  /** 就绪遮罩状态（null = 不显示） */
  sessionCover: { sessionId: string | null; fading: boolean } | null;
}

export function useSessionOpenAnchor(params: {
  activeSessionId: string | null;
  containerRef: React.RefObject<HTMLElement | null>;
  manager: VirtualScrollManager;
  isAtBottomRef: React.RefObject<boolean>;
  sessionMeasurePassesRef: React.RefObject<number>;
}): SessionOpenAnchor {
  const {
    activeSessionId,
    containerRef,
    manager,
    isAtBottomRef,
    sessionMeasurePassesRef,
  } = params;
  const anchorRestoreTargetRef = useRef<PagingAnchor | null>(null);
  const anchorSessionLatchRef = useRef<string | null | undefined>(undefined);
  const [sessionCover, setSessionCover] = useState<{
    sessionId: string | null;
    fading: boolean;
  } | null>(null);

  const readingAnchorCapture = useReadingAnchorCapture({
    containerRef,
    manager,
    activeSessionId,
    isAtBottomRef,
    isGeometrySettled: () => sessionMeasurePassesRef.current <= 0,
    isRestorePending: () => anchorRestoreTargetRef.current !== null,
  });

  // 开局闩锁（渲染期推进，与 R12b 尾部缓冲同模式）：此刻 DOM 仍是旧会话
  // 几何，flush 捕获到的才是旧会话真实阅读位（每次切换至多一次）
  if (anchorSessionLatchRef.current !== activeSessionId) {
    const prevSessionId = anchorSessionLatchRef.current;
    anchorSessionLatchRef.current = activeSessionId;
    readingAnchorCapture.flushForSession(prevSessionId ?? null);
    anchorRestoreTargetRef.current = resolveRestoreAnchor(
      readReadingAnchor(activeSessionId)
    );
    setSessionCover({ sessionId: activeSessionId, fading: false });
  }

  // 遮罩退出：rAF 探针只读就绪条件，就绪后过一帧绘制再淡出
  useEffect(() => {
    if (!sessionCover || sessionCover.fading) return;
    let rafId: number | null = null;
    const tick = () => {
      rafId = null;
      if (
        !isSessionCoverReady({
          measurePassesRemaining: sessionMeasurePassesRef.current,
          restorePending: anchorRestoreTargetRef.current !== null,
        })
      ) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      if (prefersReducedMotion()) {
        setSessionCover(null);
        return;
      }
      setSessionCover((cur) =>
        cur && !cur.fading ? { ...cur, fading: true } : cur
      );
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [sessionCover, sessionMeasurePassesRef]);

  // 淡出后卸载（240ms > --transition-popover-enter 的 180ms，留合成余量）
  useEffect(() => {
    if (!sessionCover?.fading) return;
    const timer = setTimeout(() => setSessionCover(null), 240);
    return () => clearTimeout(timer);
  }, [sessionCover?.fading]);

  return { anchorRestoreTargetRef, sessionCover };
}
