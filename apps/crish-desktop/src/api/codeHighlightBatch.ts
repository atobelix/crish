/**
 * Diff 高亮批通道（D8.3 / CFL-05）：生产主路径接线 render-worker highlight.batch。
 *
 * - 短路径（阈值内）保留 sync highlightCode —— 防 ReDoS / 避免 IPC 往返；
 * - 超阈值强制 worker batch，主线程无同步长 hljs；
 * - worker 失败回退 highlightCodeSafe（ReDoS 盾保留）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  escapeHtml,
  highlightCode,
  highlightCodeSafe,
} from './codeHighlight';
import { getWorkerPool, Priority } from '../workers';

export type DiffHighlightItem = {
  id: string;
  code: string;
  language?: string;
};

export type DiffHighlightResult = {
  id: string;
  html: string;
};

/** 同步短路径上限：总字符与行数均在阈值内才允许 sync */
export const DIFF_HIGHLIGHT_SYNC_MAX_CHARS = 512;
export const DIFF_HIGHLIGHT_SYNC_MAX_ITEMS = 48;

/** 探针：生产 highlight.batch 调用计数（单测可读） */
export const diffHighlightBatchProbe = {
  workerBatchCalls: 0,
  reset() {
    this.workerBatchCalls = 0;
  },
};

export function shouldUseSyncDiffHighlight(items: DiffHighlightItem[]): boolean {
  if (items.length === 0) return true;
  if (items.length > DIFF_HIGHLIGHT_SYNC_MAX_ITEMS) return false;
  let total = 0;
  for (const item of items) {
    total += item.code.length;
    if (total > DIFF_HIGHLIGHT_SYNC_MAX_CHARS) return false;
  }
  return true;
}

/** 一次性批量高亮；超阈值走 worker highlight.batch。 */
export async function highlightBatchAsync(
  items: DiffHighlightItem[],
): Promise<DiffHighlightResult[]> {
  if (!items.length) return [];
  if (shouldUseSyncDiffHighlight(items)) {
    return items.map((i) => ({
      id: i.id,
      html: highlightCode(i.code, i.language),
    }));
  }

  diffHighlightBatchProbe.workerBatchCalls += 1;
  try {
    const res = await getWorkerPool().schedule<{ results?: DiffHighlightResult[] }>(
      'render',
      'highlight.batch',
      { items },
      Priority.Normal,
    );
    const results = res?.results;
    if (Array.isArray(results) && results.length === items.length) {
      return results.map((r) => ({
        id: String(r.id),
        html: typeof r.html === 'string' ? r.html : '',
      }));
    }
    if (Array.isArray(results) && results.length > 0) {
      const byId = new Map(results.map((r) => [String(r.id), r.html]));
      return items.map((i) => ({
        id: i.id,
        html: byId.get(i.id) ?? highlightCodeSafe(i.code, i.language),
      }));
    }
  } catch {
    /* fallthrough -> safe sync */
  }
  return items.map((i) => ({
    id: i.id,
    html: highlightCodeSafe(i.code, i.language),
  }));
}

function buildItemsKey(items: DiffHighlightItem[]): string {
  return items.map((i) => i.id + ':' + i.code.length).join('|');
}

/**
 * React：可见 Diff 行的高亮 id → HTML map。
 * - 短路径：首帧即 sync 高亮（既有单测/短 diff 无闪烁）；
 * - 长路径：首帧 escape 纯文本（便宜布局），batch 回填（02-T5 / D7.4 衔接）。
 */
export function useDiffHighlightMap(
  items: DiffHighlightItem[],
): Map<string, string> {
  const itemsKey = useMemo(() => buildItemsKey(items), [items]);
  const sync = shouldUseSyncDiffHighlight(items);

  const [map, setMap] = useState<Map<string, string>>(() => {
    if (sync) {
      return new Map(items.map((i) => [i.id, highlightCode(i.code, i.language)]));
    }
    return new Map(items.map((i) => [i.id, escapeHtml(i.code)]));
  });

  useEffect(() => {
    if (items.length === 0) {
      setMap(new Map());
      return;
    }
    if (shouldUseSyncDiffHighlight(items)) {
      setMap(new Map(items.map((i) => [i.id, highlightCode(i.code, i.language)])));
      return;
    }
    let cancelled = false;
    setMap(new Map(items.map((i) => [i.id, escapeHtml(i.code)])));
    void highlightBatchAsync(items)
      .then((results) => {
        if (cancelled) return;
        setMap(new Map(results.map((r) => [r.id, r.html])));
      })
      .catch(() => {
        if (cancelled) return;
        setMap(
          new Map(items.map((i) => [i.id, highlightCodeSafe(i.code, i.language)])),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [itemsKey, sync]);

  return map;
}
