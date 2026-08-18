/**
 * beforeunloadFlush —— 页面关闭/刷新时同步持久化保护。
 *
 * 注册 beforeunload + pagehide 拦截器，在页面卸载前同步刷出所有内存数据：
 * - 流式文本批处理器（StreamTextBatcher）全部 flushNow
 * - 会话数据同步写入 localStorage（不 debounce）
 * - 未发送错误日志写入 localStorage
 *
 * 注意：beforeunload 事件中只能使用同步 API（localStorage 同步，IndexedDB 不行）。
 */

import { getSessionStoreState } from '../store';
import { persistAllSessionsSync } from './sessionPersistence';
import { type StreamTextBatcher, type StreamValueBatcher } from './streamTextBatcher';
import { errorStore } from '../services/ErrorStore';

// ── StreamTextBatcher 全局注册表 ──────────────────────────────────────────────

const activeBatchers = new Set<StreamTextBatcher | StreamValueBatcher<unknown>>();

/**
 * 将 batcher 注册到全局池中，页面卸载时会 flushNow 所有注册的 batcher。
 * 配套使用 unregisterStreamBatcher 在 hook cleanup 中移除。
 */
export function registerStreamBatcher(
  batcher: StreamTextBatcher | StreamValueBatcher<unknown>,
): void {
  activeBatchers.add(batcher);
}

/**
 * 从全局池中移除 batcher（hook 销毁时调用）。
 */
export function unregisterStreamBatcher(
  batcher: StreamTextBatcher | StreamValueBatcher<unknown>,
): void {
  activeBatchers.delete(batcher);
}

// ── Flush 辅助函数 ───────────────────────────────────────────────────────────

/**
 * 遍历所有活跃 stream 的 batcher，调用 flushNow。
 */
function flushAllStreamBatchers(): void {
  for (const batcher of activeBatchers) {
    batcher.flushNow();
  }
}

const ERROR_QUEUE_KEY = 'crish_error_queue_v1';

/**
 * 将 ErrorStore 中未发送的错误队列写入 localStorage。
 */
function flushErrorQueue(): void {
  const errors = errorStore.getActiveErrors();
  if (errors.length === 0) return;
  try {
    localStorage.setItem(ERROR_QUEUE_KEY, JSON.stringify(errors));
  } catch {
    /* quota / private mode */
  }
}

// ── Install ──────────────────────────────────────────────────────────────────

/**
 * 注册 beforeunload/pagehide 处理器。
 * 在关闭/刷新页面时同步持久化所有内存数据。
 *
 * 在 App 启动时（如 initLayoutStorePersistence 之后）调用一次。
 */
export function installBeforeunloadFlush(): void {
  const handler = () => {
    flushAllStreamBatchers();

    const state = getSessionStoreState();
    persistAllSessionsSync(state.sessions, state.activeSessionId, state.folderOrder);

    flushErrorQueue();
  };

  window.addEventListener('beforeunload', handler);
  window.addEventListener('pagehide', handler);
}
