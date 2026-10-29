// 会话时间线投影：把原始引擎事件折叠为对话 / 工具 / 审批 / 错误 / 系统提示块。
// 纯函数，不依赖 React / store，便于单测与桌面端展示语义复用。
import type { FeedEntry } from '@/domain/store/eventReducers';
import {
  readBool,
  readNumber,
  readRecord,
  readString,
} from '@/domain/store/eventReducers';
import { stripAnsi } from '@/domain/pure/ansi';

export type TimelineTone = 'muted' | 'info' | 'success' | 'warning' | 'danger';

export interface AssistantMessageBlock {
  kind: 'message';
  id: string;
  role: 'assistant' | 'user';
  text: string;
  streaming: boolean;
  atMs: number;
}

export interface ToolBlock {
  kind: 'tool';
  id: string;
  toolName: string;
  summary: string;
  status: 'running' | 'done' | 'error';
  output: string;
  atMs: number;
}

export interface ApprovalBlock {
  kind: 'approval';
  id: string;
  toolName: string;
  summary: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  atMs: number;
}

export interface NoticeBlock {
  kind: 'notice';
  id: string;
  text: string;
  tone: TimelineTone;
  atMs: number;
}

export type TimelineBlock =
  AssistantMessageBlock | ToolBlock | ApprovalBlock | NoticeBlock;

const MAX_TOOL_OUTPUT = 4000;

function textOfMessage(frame: FeedEntry): string {
  const message = readRecord(frame['message']);
  if (!message) {
    return stripAnsi(readString(frame, 'content') ?? '');
  }
  const blocks = message['blocks'];
  if (Array.isArray(blocks)) {
    const parts: string[] = [];
    for (const block of blocks) {
      const record = readRecord(block);
      if (!record) continue;
      if (record['type'] === 'text') {
        const text = record['text'];
        if (typeof text === 'string' && text.trim() !== '') {
          parts.push(text);
        }
      }
    }
    if (parts.length > 0) return stripAnsi(parts.join('\n\n'));
  }
  return stripAnsi(
    (typeof message['content'] === 'string' ? message['content'] : '') ||
      readString(frame, 'content') ||
      ''
  );
}

function messageMeta(frame: FeedEntry): {
  id: string;
  role: 'assistant' | 'user';
  atMs: number;
} {
  const message = readRecord(frame['message']);
  const id =
    (message && typeof message['id'] === 'string' ? message['id'] : null) ??
    readString(frame, 'messageId') ??
    `message-${readNumber(frame, 'sequence') ?? frame.receivedAtMs}`;
  const role = message?.['role'] === 'user' ? 'user' : 'assistant';
  return { id, role, atMs: frame.receivedAtMs };
}

function deltaText(frame: FeedEntry): string {
  const block = readRecord(frame['block']);
  if (!block) return stripAnsi(readString(frame, 'text') ?? '');
  if (block['type'] === 'thought') return '';
  const text =
    (typeof block['text'] === 'string' ? block['text'] : null) ??
    readString(frame, 'text') ??
    '';
  return stripAnsi(text);
}

function toolIdOf(frame: FeedEntry, fallback: string): string {
  const call = readRecord(frame['call']);
  const update = readRecord(frame['update']);
  return (
    readString(frame, 'toolCallId') ??
    readString(frame, 'callId') ??
    (call && typeof call['id'] === 'string' ? call['id'] : null) ??
    (call && typeof call['toolCallId'] === 'string'
      ? call['toolCallId']
      : null) ??
    (update && typeof update['toolCallId'] === 'string'
      ? update['toolCallId']
      : null) ??
    fallback
  );
}

function toolNameOf(frame: FeedEntry): string {
  const call = readRecord(frame['call']);
  const update = readRecord(frame['update']);
  return (
    readString(frame, 'toolName') ??
    (call && typeof call['toolName'] === 'string' ? call['toolName'] : null) ??
    (update && typeof update['toolName'] === 'string'
      ? update['toolName']
      : null) ??
    '工具'
  );
}

function approvalStatusOf(
  decision: string | undefined
): ApprovalBlock['status'] {
  if (decision === 'approved') return 'approved';
  if (decision === 'denied') return 'denied';
  if (decision === 'expired') return 'expired';
  return 'pending';
}

function terminalNotice(frame: FeedEntry): NoticeBlock | null {
  const terminal = (readString(frame, 'terminal') ?? '').toLowerCase();
  if (terminal === 'completed') {
    return {
      kind: 'notice',
      id: `run-terminal-${readNumber(frame, 'sequence') ?? frame.receivedAtMs}`,
      text: '运行完成',
      tone: 'success',
      atMs: frame.receivedAtMs,
    };
  }
  if (terminal === 'cancelled' || terminal === 'canceled') {
    return {
      kind: 'notice',
      id: `run-terminal-${readNumber(frame, 'sequence') ?? frame.receivedAtMs}`,
      text: '运行已取消',
      tone: 'muted',
      atMs: frame.receivedAtMs,
    };
  }
  const reason = readString(frame, 'error') ?? readString(frame, 'reason');
  return {
    kind: 'notice',
    id: `run-terminal-${readNumber(frame, 'sequence') ?? frame.receivedAtMs}`,
    text: reason ? `运行失败：${reason}` : '运行失败',
    tone: 'danger',
    atMs: frame.receivedAtMs,
  };
}

/**
 * 事件窗口 → 时间线块（顺序 = 首次出现顺序）。
 * 只保留有阅读价值的内容：助手正文、工具调用、审批、错误、运行终态。
 */
export function buildSessionTimeline(
  entries: readonly FeedEntry[]
): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  const messageIndex = new Map<string, number>();
  const toolIndex = new Map<string, number>();
  const approvalIndex = new Map<string, number>();
  let lastToolId: string | null = null;

  const findBlock = <T extends TimelineBlock>(
    map: Map<string, number>,
    id: string,
    kind: T['kind']
  ): T | null => {
    const index = map.get(id);
    if (index === undefined) return null;
    const block = blocks[index];
    return block && block.kind === kind ? (block as T) : null;
  };

  entries.forEach((entry, entryIndex) => {
    const type = entry.type;
    const fallbackId = `entry-${readNumber(entry, 'sequence') ?? entryIndex}`;

    switch (type) {
      case 'message-start': {
        const meta = messageMeta(entry);
        if (messageIndex.has(meta.id)) break;
        messageIndex.set(meta.id, blocks.length);
        blocks.push({
          kind: 'message',
          id: meta.id,
          role: meta.role,
          text: '',
          streaming: true,
          atMs: meta.atMs,
        });
        break;
      }
      case 'message-delta': {
        const meta = messageMeta(entry);
        const text = deltaText(entry);
        if (text === '') {
          if (!messageIndex.has(meta.id)) {
            messageIndex.set(meta.id, blocks.length);
            blocks.push({
              kind: 'message',
              id: meta.id,
              role: meta.role,
              text: '',
              streaming: true,
              atMs: meta.atMs,
            });
          }
          break;
        }
        const existing = findBlock<AssistantMessageBlock>(
          messageIndex,
          meta.id,
          'message'
        );
        if (existing) {
          existing.text += text;
          existing.streaming = true;
        } else {
          messageIndex.set(meta.id, blocks.length);
          blocks.push({
            kind: 'message',
            id: meta.id,
            role: meta.role,
            text,
            streaming: true,
            atMs: meta.atMs,
          });
        }
        break;
      }
      case 'message-end': {
        const meta = messageMeta(entry);
        const text = textOfMessage(entry);
        const existing = findBlock<AssistantMessageBlock>(
          messageIndex,
          meta.id,
          'message'
        );
        if (existing) {
          if (text !== '') existing.text = text;
          existing.streaming = false;
        } else if (text !== '') {
          messageIndex.set(meta.id, blocks.length);
          blocks.push({
            kind: 'message',
            id: meta.id,
            role: meta.role,
            text,
            streaming: false,
            atMs: meta.atMs,
          });
        }
        break;
      }
      case 'tool-start': {
        const id = toolIdOf(entry, fallbackId);
        lastToolId = id;
        const call = readRecord(entry['call']);
        const summary = stripAnsi(
          readString(entry, 'summary') ??
            (call && typeof call['summary'] === 'string' ? call['summary'] : '')
        );
        toolIndex.set(id, blocks.length);
        blocks.push({
          kind: 'tool',
          id,
          toolName: toolNameOf(entry),
          summary,
          status: 'running',
          output: '',
          atMs: entry.receivedAtMs,
        });
        break;
      }
      case 'tool-update': {
        const id = toolIdOf(entry, lastToolId ?? fallbackId);
        const update = readRecord(entry['update']);
        const text = stripAnsi(
          readString(entry, 'text') ??
            (update && typeof update['text'] === 'string' ? update['text'] : '')
        );
        const existing = findBlock<ToolBlock>(toolIndex, id, 'tool');
        if (existing) {
          if (text) {
            existing.output = `${existing.output}${text}`.slice(
              -MAX_TOOL_OUTPUT
            );
          }
        } else if (lastToolId) {
          const last = findBlock<ToolBlock>(toolIndex, lastToolId, 'tool');
          if (last && text) {
            last.output = `${last.output}${text}`.slice(-MAX_TOOL_OUTPUT);
          }
        }
        break;
      }
      case 'tool-end': {
        const id = toolIdOf(entry, lastToolId ?? fallbackId);
        const result = readRecord(entry['result']);
        const isError =
          readBool(entry, 'result', 'isError') || result?.['isError'] === true;
        const output = stripAnsi(
          readString(entry, 'output') ??
            (result && typeof result['output'] === 'string'
              ? result['output']
              : '')
        );
        const existing = findBlock<ToolBlock>(toolIndex, id, 'tool');
        if (existing) {
          existing.status = isError ? 'error' : 'done';
          if (output) {
            existing.output = `${existing.output}${output}`.slice(
              -MAX_TOOL_OUTPUT
            );
          }
        } else {
          toolIndex.set(id, blocks.length);
          blocks.push({
            kind: 'tool',
            id,
            toolName: toolNameOf(entry),
            summary: '',
            status: isError ? 'error' : 'done',
            output,
            atMs: entry.receivedAtMs,
          });
        }
        lastToolId = null;
        break;
      }
      case 'approval-requested': {
        const id =
          readString(entry, 'toolCallId') ??
          readString(entry, 'tool_call_id') ??
          fallbackId;
        const summary = stripAnsi(readString(entry, 'summary') ?? '');
        if (!approvalIndex.has(id)) {
          approvalIndex.set(id, blocks.length);
          blocks.push({
            kind: 'approval',
            id,
            toolName: readString(entry, 'toolName') ?? '工具',
            summary,
            status: 'pending',
            atMs: entry.receivedAtMs,
          });
        }
        break;
      }
      case 'approval-resolved': {
        const id =
          readString(entry, 'toolCallId') ??
          readString(entry, 'tool_call_id') ??
          fallbackId;
        const existing = findBlock<ApprovalBlock>(
          approvalIndex,
          id,
          'approval'
        );
        if (existing) {
          existing.status = approvalStatusOf(readString(entry, 'decision'));
        }
        break;
      }
      case 'runtime-error':
      case 'runtime-intervention-required': {
        const text =
          readString(entry, 'error') ??
          readString(entry, 'reason') ??
          '运行出现异常';
        blocks.push({
          kind: 'notice',
          id: `error-${readNumber(entry, 'sequence') ?? entryIndex}`,
          text: stripAnsi(text),
          tone: 'danger',
          atMs: entry.receivedAtMs,
        });
        break;
      }
      case 'run-terminal': {
        const notice = terminalNotice(entry);
        if (notice) blocks.push(notice);
        break;
      }
      case 'task-failed': {
        blocks.push({
          kind: 'notice',
          id: `task-failed-${readNumber(entry, 'sequence') ?? entryIndex}`,
          text: stripAnsi(
            readString(entry, 'error') ??
              readString(entry, 'reason') ??
              '后台任务失败'
          ),
          tone: 'danger',
          atMs: entry.receivedAtMs,
        });
        break;
      }
      default:
        break;
    }
  });

  // 空消息（只有 message-start 没有正文）不占位
  return blocks.filter(
    (block) => block.kind !== 'message' || block.text.trim() !== ''
  );
}

/** 工具块一行摘要（折叠态）。 */
export function toolBlockSummary(block: ToolBlock): string {
  const text = `${block.summary} ${block.output}`.replace(/\s+/g, ' ').trim();
  if (text === '') return '';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** 时间线块时钟（HH:mm）。 */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
