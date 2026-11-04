import { useSyncExternalStore } from 'react';
import { useReducedMotion } from 'motion/react';

/** 空监听器（静态快照无需订阅原生变更，专为水合边界设计） */
const emptySubscribe = () => () => {};

/**
 * React 19 安全水合防闪无障碍 Hook
 *
 * 核心机制：
 * 1. 客户端首帧 / SSR 环境：useSyncExternalStore 返回 false（hydrated = false）；
 * 2. 客户端完成挂载（Hydrated）：返回 true，此时安全读取系统的 useReducedMotion()；
 * 3. 根除 Hydration Mismatch 警告，保证首帧渲染树的 100% 字节级一致。
 */
export function useReducedFlag(): boolean {
  const hydrated = useSyncExternalStore(
    emptySubscribe,
    () => true, // 客户端快照（挂载后）
    () => false // 服务端 / 首帧快照
  );

  const reduced = useReducedMotion();
  return Boolean(reduced && hydrated);
}

/**
 * 监听 document.documentElement 上的 data-perf-tier 属性变动
 */
function subscribePerfTier(callback: () => void): () => void {
  if (
    typeof MutationObserver === 'undefined' ||
    typeof document === 'undefined'
  ) {
    return () => {};
  }
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'data-perf-tier') {
        callback();
        break;
      }
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-perf-tier'],
  });
  return () => observer.disconnect();
}

function getPerfTierSnapshot(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-perf-tier') === 'eco';
}

/**
 * 综合动效裁决 Hook：只认 OS 无障碍偏好
 *
 * isReduced 只由系统级 prefers-reduced-motion 决定（X1 解耦口径：
 * 减动效只响应系统设置）。isEcoTier 仅作信息位，供高成本效果的
 * 降级决策参考，绝不汇入 isReduced——性能档不是减动效通道。
 */
export function useEffectiveReducedMotion(): {
  isReduced: boolean;
  isHydrated: boolean;
  isEcoTier: boolean;
} {
  const isReducedMotion = useReducedFlag();
  const isEcoTier = useSyncExternalStore(
    subscribePerfTier,
    getPerfTierSnapshot,
    () => false
  );

  return {
    isReduced: isReducedMotion,
    isHydrated: true,
    isEcoTier,
  };
}
