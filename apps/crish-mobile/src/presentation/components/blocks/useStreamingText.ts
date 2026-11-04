// 流式文本渲染节流与平准 hook（R2UX-05-02 渲染节流 + 方案 04 自适应打字平准器）：
// - 双模架构兼顾：
//   1. 自适应打字平准模式（smooth=true 或配置平准参数）：接入 AdaptiveStreamingSmoother，
//      基于 Token 缓冲池、人体黄金阅读速度（25~45 chars/s，上限 70 chars/s）、惯性低通加减速滤波器
//      与 Unicode 字符簇保护，由 requestAnimationFrame 物理时钟驱动丝滑推进；
//   2. 经典窗口合并模式（smooth=false 缺省）：由 PreviewFlushScheduler 承载 18ms 滚动窗口与 100ms
//      强制刷新边界，保持完全向后兼容；
// - 终态收口（streaming=false）：平滑泄洪或立即交付，确保 100% 文本完整呈现，无残留旧帧覆盖；
// - 条目键变化（identity 切换）：同步复位重显新文本，清空旧帧；
// - 首次挂载立即渲染（首帧不延迟，避免空白闪烁）；
// - 卸载清理：组件退场即退订，重置平准器与调度器，清除动画帧与定时器句柄。

import { useEffect, useRef, useState } from 'react';
import { PreviewFlushScheduler } from '@/domain/pure/previewFlushScheduler';
import {
  AdaptiveStreamingSmoother,
  type SmootherOptions,
} from './AdaptiveStreamingSmoother';

export interface UseStreamingTextOptions extends SmootherOptions {
  /** 合并窗口（ms，缺省 18；≤0 同步渲染旁路，非 smooth 模式生效） */
  mergeWindowMs?: number;
  /** 强制刷新边界（ms，缺省 100，非 smooth 模式生效） */
  maxWaitMs?: number;
  /** 是否启用自适应匀速平准器（为保持历史单测与调用无缝兼容，显式指定 smooth=true 或平准参数时激活） */
  smooth?: boolean;
}

/**
 * 流式文本渲染 Hook：
 * @param identity 条目稳定键（同 seq 覆盖保持不变；变化 = 新条目，立即渲染）
 * @param latestText 数据面最新全文（preview 帧覆盖式，每次帧更新都会变化）
 * @param streaming 流式期标记（false = 终态已到：终值收敛交付 + 清空调度）
 * @param options 调度与平准参数（支持 smooth / 窗口合并双模式配置）
 * @returns 渲染用文本
 */
export function useStreamingText(
  identity: string,
  latestText: string,
  streaming: boolean,
  options: UseStreamingTextOptions = {}
): string {
  const isSmooth = Boolean(
    options.smooth ||
    options.minCharsPerSec !== undefined ||
    options.baseCharsPerSec !== undefined ||
    options.fastCharsPerSec !== undefined ||
    options.maxCharsPerSec !== undefined ||
    options.commitThrottleMs !== undefined
  );

  const [rendered, setRendered] = useState(latestText);
  // 前一渲染条目键（React 官方「存储上一次渲染信息」模式：渲染期对比 → 同步调整状态）
  const [prevIdentity, setPrevIdentity] = useState(identity);

  const schedulerRef = useRef<PreviewFlushScheduler | null>(null);
  const smootherRef = useRef<AdaptiveStreamingSmoother | null>(null);

  if (isSmooth) {
    if (smootherRef.current === null) {
      smootherRef.current = new AdaptiveStreamingSmoother(
        (text) => setRendered(text),
        options
      );
    }
  } else {
    if (schedulerRef.current === null) {
      schedulerRef.current = new PreviewFlushScheduler(
        (_key, value) => setRendered(value),
        options
      );
    }
  }

  // 卸载清理：清空定时器与 pending / rAF（组件退场即退订，M4 §8.2 后台节能条款）
  useEffect(() => {
    return () => {
      schedulerRef.current?.reset();
      smootherRef.current?.reset();
    };
  }, []);

  // 平准器流态推入（仅在 isSmooth 模式生效，严格保证 Hook 顶层无条件调用）
  useEffect(() => {
    if (!isSmooth) return;
    smootherRef.current?.updateTarget(latestText, streaming);
  }, [isSmooth, latestText, streaming]);

  // 新条目（键变化）：立即渲染其文本（不闪烁），清空旧条目的待渲染帧/平准器状态
  if (identity !== prevIdentity) {
    setPrevIdentity(identity);
    schedulerRef.current?.reset();
    smootherRef.current?.reset();
    if (latestText !== rendered) {
      setRendered(latestText);
    }
    return latestText;
  }

  // ===== 平准器模式（smooth=true）=====
  if (isSmooth) {
    return rendered;
  }

  // ===== 经典窗口合并模式（PreviewFlushScheduler 兼容路径）=====
  const scheduler = schedulerRef.current!;

  if (!streaming) {
    // 终值替换（流式结束 / 终态覆盖）：最新全文立即渲染，清空调度——
    // 残留 pending 也必须清掉（防止旧帧延迟回调覆盖终值，不闪烁不跳动）
    if (latestText !== rendered) {
      setRendered(latestText);
    }
    if (scheduler.pendingCount() > 0 || scheduler.isScheduled()) {
      scheduler.reset();
    }
    return rendered;
  }

  // 流式期：最新文本变化 → 推进度给调度器（窗口内合并；首帧 rendered=latest 不推）
  if (latestText !== rendered) {
    scheduler.push(identity, latestText);
  }
  return rendered;
}

/**
 * 自适应打字平准 Hook（便捷快捷入口，默认开启 smooth=true）
 */
export function useAdaptiveStreamingText(
  identity: string,
  latestText: string,
  streaming: boolean,
  options: Omit<UseStreamingTextOptions, 'smooth'> = {}
): string {
  return useStreamingText(identity, latestText, streaming, {
    ...options,
    smooth: true,
  });
}
