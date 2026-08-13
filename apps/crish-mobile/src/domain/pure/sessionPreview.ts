// 会话列表预览纯函数（R2-05 部分 4：最后消息预览数据面）
// - previewText(entry)：事件条目 → 预览文本（消息正文提取 → ANSI 剥离（复用 ansi.ts）→
//   空白收敛 → 单行截断）；非消息类条目（run-terminal / tool-start 等）返回空串，
//   列表行不渲染预览行（诚实化：不猜事件为消息，F1 §4.7 / F5 §2.1 摘要字段语义）；
// - lastPreviewOfWindow(window)：事件窗口尾部条目预览（F3 §3.4.2 窗口尾部 = 最近消息
//   数据面；无窗口/空窗口返回空串）。
// 字段读取走 eventReducers 宽容 read* 助手（缺失/类型错 → 缺省空文案，M6 §10.5）。
import type {
  EventEnvelopeFrame,
  EventWindow,
  FeedEntry,
} from '@/domain/store/eventReducers';
import { readRecord, readString } from '@/domain/store/eventReducers';
import { stripAnsi } from './ansi';

/** 列表预览单行上限（F5 §5.3 索引预览 ≤80 字符 → 收窄 60，与 F3 §3.4.2 折叠预览同量级） */
export const SESSION_PREVIEW_MAX = 60;

/**
 * message-end 消息正文提取（F5 §5.5 终态权威形状 message.blocks）：
 * - blocks 中 type === 'text' 块拼接（空格连接，跳过空块）；
 * - 无 blocks / 无 text 块 → message.content 兜底（AgentMessage.content，message.rs:48-49）；
 * - 两级都缺失 → 空串。
 */
function textOfMessageEnd(frame: EventEnvelopeFrame): string {
  const message = readRecord(frame['message']);
  if (!message) return readString(frame, 'content') ?? '';
  const blocks = message['blocks'];
  if (Array.isArray(blocks)) {
    const parts: string[] = [];
    for (const block of blocks) {
      const b = readRecord(block);
      if (b && b['type'] === 'text') {
        const t = b['text'];
        // 块文本 trim 后再拼接：块自带首尾空格（如 ' src/pages/login.tsx'）与 join
        // 分隔空格叠加会产生双空格（单行预览依赖收敛为单空格）
        if (typeof t === 'string' && t.trim() !== '') parts.push(t.trim());
      }
    }
    if (parts.length > 0) return parts.join(' ');
  }
  return readString(message, 'content') ?? readString(frame, 'content') ?? '';
}

/** 事件条目 → 原始正文（非消息类返回空串；字段缺失宽容兜底空串） */
export function extractPreviewText(frame: EventEnvelopeFrame): string {
  switch (frame.type) {
    case 'message-delta':
      return readString(frame, 'text') ?? '';
    case 'message-end':
      return textOfMessageEnd(frame);
    case 'tool-update': {
      // update.text（S1 协议，tool_events.rs）；宽容两级读取（缺省空文案）
      const update = readRecord(frame['update']);
      return readString(update, 'text') ?? '';
    }
    case 'tool-end': {
      const result = readRecord(frame['result']);
      return readString(result, 'output') ?? '';
    }
    case 'task-output':
      return readString(frame, 'line') ?? readString(frame, 'chunk') ?? '';
    default:
      // 非消息正文类事件（run-terminal / tool-start / approval-* 等）：无预览（不猜）
      return '';
  }
}

/**
 * 事件条目 → 会话列表预览文本：
 * ANSI 剥离（stripAnsi，SGR/光标/清屏白名单 + 非法序列忽略，R2UX-05-07）
 * → 空白收敛（换行/多空格 → 单空格，保证单行渲染）→ 超长截断（SESSION_PREVIEW_MAX 码点 + …）。
 */
export function previewText(entry: FeedEntry): string {
  const raw = extractPreviewText(entry);
  const cleaned = stripAnsi(raw).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= SESSION_PREVIEW_MAX) return cleaned;
  return `${cleaned.slice(0, SESSION_PREVIEW_MAX - 1)}…`;
}

/** 事件窗口尾部条目预览（无窗口 / 空窗口返回空串）；列表行数据面 */
export function lastPreviewOfWindow(window: EventWindow | undefined): string {
  const tail = window?.entries[window.entries.length - 1];
  return tail ? previewText(tail) : '';
}
