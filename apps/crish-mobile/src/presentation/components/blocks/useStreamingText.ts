// 流式文本渲染节流 hook（R2UX-05-02：preview 帧渐进渲染 + 终值替换 + 渲染节流）：
// - 输入：数据面最新全文（preview 帧覆盖式）+ 流式期标记 + 条目稳定键；
// - 合并窗口内多帧合并为一次渲染（previewFlushScheduler 纯逻辑承载，18ms/100ms/flushNow）；
// - 终值替换（streaming=false）：最新全文立即渲染（不等待窗口、不闪烁不跳动）；
// - 条目键变化（新条目）：立即渲染新文本并清空旧 pending（不闪烁）；
// - 首次挂载直接显示最新文本（首帧不延迟，避免空白闪烁）；
// - 卸载清理：清空定时器与 pending（组件退场即退订，M4 §8.2 后台节能条款）。
import { useEffect, useRef, useState } from 'react';
import { PreviewFlushScheduler } from '@/domain/pure/previewFlushScheduler';

export interface UseStreamingTextOptions {
  /** 合并窗口（ms，缺省 18；≤0 同步渲染旁路） */
  mergeWindowMs?: number;
  /** 强制刷新边界（ms，缺省 100） */
  maxWaitMs?: number;
}

/**
 * 流式文本渲染节流：
 * @param identity 条目稳定键（同 seq 覆盖保持不变；变化 = 新条目，立即渲染）
 * @param latestText 数据面最新全文（preview 帧覆盖式，每次帧更新都会变化）
 * @param streaming 流式期标记（false = 终值已到：最新全文立即渲染 + 清空调度）
 * @param options 调度参数（测试注入；固定于挂载时，后续变更忽略）
 * @returns 渲染用文本（节流后的最新值；未到窗口期时保持上一帧值）
 */
export function useStreamingText(
  identity: string,
  latestText: string,
  streaming: boolean,
  options: UseStreamingTextOptions = {}
): string {
  const [rendered, setRendered] = useState(latestText);
  // 前一渲染条目键（React 文档「存储上一次渲染信息」模式：渲染期对比 → 调整状态）
  const [prevIdentity, setPrevIdentity] = useState(identity);
  const schedulerRef = useRef<PreviewFlushScheduler | null>(null);

  if (schedulerRef.current === null) {
    schedulerRef.current = new PreviewFlushScheduler(
      (_key, value) => setRendered(value),
      options
    );
  }
  const scheduler = schedulerRef.current;

  // 卸载清理：清空定时器与 pending（组件退场即退订，M4 §8.2；不回调）
  useEffect(() => {
    return () => {
      schedulerRef.current?.reset();
    };
  }, []);

  // 新条目（键变化）：立即渲染其文本（不闪烁），清空旧条目的待渲染帧
  if (identity !== prevIdentity) {
    setPrevIdentity(identity);
    scheduler.reset();
    if (latestText !== rendered) {
      setRendered(latestText);
    }
    return latestText;
  }

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
