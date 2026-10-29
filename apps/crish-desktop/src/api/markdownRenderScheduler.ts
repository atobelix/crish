/**
 * Markdown 渲染调度器（面 A 前端唯一 IPC 入口）。
 *
 * 设计目标：
 * - 同一 tick 内的多个块请求合并为一次 `core_md_render_batch`，消除历史
 *   首屏“每块一次 IPC”的风暴；
 * - 结果写入 `markdownResultCache`，同文本/variant 后续同步命中；
 * - 同一文本在途请求去重；
 * - 失败返回 null，由 Hook 决定纯文本兜底；不在这里静默吞错。
 */
import {
  renderMarkdownBatch,
  type MarkdownRenderResult,
  type MarkdownVariant,
} from './rustCore';
import { getMarkdownResult, setMarkdownResult } from './markdownResultCache';
import { logInternalError } from './userFacingErrors';

const MAX_BATCH_ITEMS = 64;
const MAX_BATCH_BYTES = 256 * 1024;

interface QueueItem {
  text: string;
  variant: MarkdownVariant;
  priority: number;
  resolve: (result: MarkdownRenderResult | null) => void;
}

const queue: QueueItem[] = [];
const pendingByKey = new Map<string, Promise<MarkdownRenderResult | null>>();
let flushScheduled = false;

const stats = {
  requests: 0,
  cacheHits: 0,
  batches: 0,
  ipcCalls: 0,
  failures: 0,
};

function keyOf(variant: MarkdownVariant, text: string): string {
  return `${variant}\u0000${text}`;
}

export function requestMarkdownResult(
  text: string,
  variant: MarkdownVariant,
  priority = 2
): Promise<MarkdownRenderResult | null> {
  stats.requests += 1;

  if (!text || !text.trim()) {
    return Promise.resolve({ html: '', truncated: false });
  }

  const cached = getMarkdownResult(variant, text);
  if (cached) {
    stats.cacheHits += 1;
    return Promise.resolve(cached);
  }

  const key = keyOf(variant, text);
  const pending = pendingByKey.get(key);
  if (pending) return pending;

  const promise = new Promise<MarkdownRenderResult | null>((resolve) => {
    queue.push({ text, variant, priority, resolve });
  });
  pendingByKey.set(key, promise);
  scheduleFlush();
  return promise;
}

/** 预取：不等待结果，命中缓存后由后续组件同步读取。 */
export function prewarmMarkdownResults(
  texts: string[],
  variant: MarkdownVariant,
  priority = 3
): void {
  for (const text of texts) {
    if (!text || !text.trim()) continue;
    void requestMarkdownResult(text, variant, priority).catch(() => {
      /* request 内部已 resolve(null)，此处只防未处理 rejection */
    });
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    void flushQueue();
  });
}

async function flushQueue(): Promise<void> {
  if (queue.length === 0) return;

  queue.sort((a, b) => a.priority - b.priority);

  const batch: QueueItem[] = [];
  let bytes = 0;
  while (queue.length > 0 && batch.length < MAX_BATCH_ITEMS) {
    const next = queue[0]!;
    if (batch.length > 0 && bytes + next.text.length > MAX_BATCH_BYTES) break;
    queue.shift();
    batch.push(next);
    bytes += next.text.length;
  }

  // 按 variant 分组，一次 batch 只携带一个 variant。
  const groups = new Map<MarkdownVariant, QueueItem[]>();
  for (const item of batch) {
    const group = groups.get(item.variant);
    if (group) group.push(item);
    else groups.set(item.variant, [item]);
  }

  for (const [variant, items] of groups) {
    stats.batches += 1;
    stats.ipcCalls += 1;
    try {
      const results = await renderMarkdownBatch(
        items.map((item) => item.text),
        variant
      );
      items.forEach((item, index) => {
        const result = results[index] ?? null;
        if (result) setMarkdownResult(variant, item.text, result);
        else stats.failures += 1;
        pendingByKey.delete(keyOf(variant, item.text));
        item.resolve(result);
      });
    } catch (error) {
      stats.failures += items.length;
      logInternalError(
        'markdownRenderScheduler',
        `core_md_render_batch failed: ${String(error)}`
      );
      for (const item of items) {
        pendingByKey.delete(keyOf(variant, item.text));
        item.resolve(null);
      }
    }
  }

  if (queue.length > 0) scheduleFlush();
}

export function getMarkdownRenderSchedulerStats(): Readonly<typeof stats> {
  return { ...stats };
}

export function resetMarkdownRenderSchedulerForTests(): void {
  queue.length = 0;
  pendingByKey.clear();
  flushScheduled = false;
  stats.requests = 0;
  stats.cacheHits = 0;
  stats.batches = 0;
  stats.ipcCalls = 0;
  stats.failures = 0;
}
