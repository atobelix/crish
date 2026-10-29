// 会话事件窗口读取 + 最近一次运行定位（对话页与工具抽屉共用同一投影来源，不新增 store）。
import { useEventStore } from '@/adapters/hooks/useAppStore';
import type { FeedEntry } from '@/domain/store/eventReducers';

const EMPTY_WINDOW = { entries: [], lastSeq: 0, truncatedCount: 0 } as const;

export function useSessionWindow(sessionId: string) {
  return useEventStore((s) => s.windows[sessionId] ?? EMPTY_WINDOW);
}

/** 从尾部找最近的 agent-start 的 runId；找不到时用会话摘要里的兜底值 */
export function latestRunIdOf(
  entries: readonly FeedEntry[],
  fallback: string | null
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type === 'agent-start') {
      const runId = entry['runId'];
      if (typeof runId === 'string' && runId !== '') return runId;
    }
  }
  return fallback;
}
