import React, { useCallback, useEffect, useState } from 'react';

const MAX_ANIMATED_CACHE_SIZE = 500;
const animatedMessageIds = new Set<string>();

function markAnimated(id: string): void {
  if (animatedMessageIds.has(id)) {
    return;
  }
  if (animatedMessageIds.size >= MAX_ANIMATED_CACHE_SIZE) {
    const oldest = animatedMessageIds.values().next().value;
    if (oldest !== undefined) {
      animatedMessageIds.delete(oldest);
    }
  }
  animatedMessageIds.add(id);
}

export interface MessageRowEntranceResult {
  isEntering: boolean;
  handleAnimationEnd: (e?: React.AnimationEvent) => void;
}

/**
 * 消息行入场动画状态机（AN2 单层化：用户行 / 助手行共用同一份「新消息」语义）
 * - 时间窗口守卫：仅对创建时间在 [-500ms, 2000ms] 内的全新消息触发入场动画
 * - FIFO Ring Set 守卫：至多缓存 500 个已动画 ID，防止虚拟滚动复用/回滚时重复触发
 * - 动画结束立即剔除 will-change 与 GPU 合成图层
 * 呈现侧：行根元素挂 data-entering，行级 fade-slide 为唯一入场；
 * 用户首条消息的气泡 54px 上浮为唯一特殊入场（行级让位，见 ChatMessageRow.module.css）。
 */
export function useMessageRowEntrance(
  messageId: string,
  timestamp?: number
): MessageRowEntranceResult {
  const [isEntering, setIsEntering] = useState<boolean>(() => {
    if (!messageId || animatedMessageIds.has(messageId)) {
      return false;
    }
    const ts = typeof timestamp === 'number' ? timestamp : Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) {
      return false;
    }
    const delta = Date.now() - ts;
    const isEligible = delta >= -500 && delta < 2000;
    if (isEligible) {
      markAnimated(messageId);
      return true;
    }
    return false;
  });

  const handleAnimationEnd = useCallback((e?: React.AnimationEvent) => {
    if (e && e.target !== e.currentTarget) {
      return;
    }
    setIsEntering(false);
  }, []);

  // 保底安全定时器：在无 CSS 动画触发或后台标签页休眠时释放 GPU 图层
  useEffect(() => {
    if (!isEntering) return;
    const timer = window.setTimeout(() => {
      setIsEntering(false);
    }, 350);
    return () => {
      window.clearTimeout(timer);
    };
  }, [isEntering]);

  return { isEntering, handleAnimationEnd };
}

/**
 * 单元测试专用重置钩子
 */
export function _resetAnimatedMessageIdsForTesting(): void {
  animatedMessageIds.clear();
}
