// 会话时间线投影：把原始引擎事件折叠为对话 / 工具 / 审批 / 错误 / 系统提示块。
// 纯函数（输出值只取决于输入值），不依赖 React / store，便于单测与桌面端展示语义复用。
//
// 身份纪律（结构共享，PERF 时间线抖动专项）：
// - 折叠是顺序确定的：同一批 entry 对象引用、仅在尾部追加新条目时，
//   折叠状态可增量延续——本轮未被任何新条目触碰的块，其构成条目集未变，
//   发射时复用上轮的块对象（同一引用），memo(TimelineBlockView) 浅比较
//   才能真正跳过已封口行；被触碰的块（流式尾、迟到更新、审批落定）以
//   草稿的浅拷贝换新对象，照常重渲染。
// - 合并语义靠折叠本身承载：一块由多条 entry 累积（消息 = start +
//   deltas + end；工具 = start + updates + end），缓存的是整段折叠
//   状态而非单条 entry 的产物，故累积内容永不丢失、永不重算错位。
// - 输入分歧即失效：已折叠前缀中任一条目引用变化（同 seq 覆盖替换了
//   条目对象）、输入缩短、或环形窗口裁掉头部（首条目更换）时，整段
//   状态作废、全量重折——正确性优先于共享，绝不发射过期内容。
// - 草稿对象永不外泄：折叠只改草稿，对外发射的是草稿快照；快照被
//   消费方只读使用（TimelineView / 工具抽屉均不回写块对象）。
import type { FeedEntry } from '@/domain/store/eventReducers';
import {
  readBool,
  readNumber,
  readRecord,
  readString,
} from '@/domain/store/eventReducers';
import { stripAnsi } from '@/domain/pure/ansi';
import { presentRemoteFailure } from '@/domain/pure/remoteFailure';
import type { WebSearchSource, WebFetchResult } from '@crish/shared-types';

export type TimelineTone = 'muted' | 'info' | 'success' | 'warning' | 'danger';

export interface AssistantMessageBlock {
  kind: 'message';
  id: string;
  role: 'assistant' | 'user';
  text: string;
  streaming: boolean;
  atMs: number;
}

/**
 * 消息级图片块（message.blocks 的 image 变体）：此前投影层只取 text 块、
 * image 块被静默丢弃——含图片的助手消息在手机上会少内容（审计关联缺口）。
 * 本批起如实入时间线：有可用来源（url / data）呈现图片，无来源呈现占位行。
 */
export interface MessageImageBlock {
  kind: 'image';
  id: string;
  /** 可用图片来源（远端 url 或 data URI）；null = 无可用来源，呈现占位行 */
  source: string | null;
  alt: string;
  atMs: number;
}

/**
 * 思考链（Reasoning / DeepSeek R1 / Claude Extended Thinking 等）专用块：
 * 解封被过滤的 thought 增量，包含思考正文、思考中状态 isThinking、耗时等。
 */
export interface ReasoningBlock {
  kind: 'reasoning';
  id: string;
  text: string;
  streaming: boolean;
  isThinking: boolean;
  durationMs?: number;
  atMs: number;
}

export interface ToolBlock {
  kind: 'tool';
  id: string;
  toolName: string;
  intent?: string;
  group?: string;
  groupId?: string;
  isInternal?: boolean;
  summary: string;
  status: 'running' | 'done' | 'error';
  input?: Record<string, unknown> | string;
  output: string;
  isDiff?: boolean;
  diffStats?: { added: number; removed: number };
  atMs: number;
  /** 工具结束事件的接收时刻（tool-end 落点；运行中未定）。工具组总时长的
   * 数据面（批 B：过程组收尾组头带总时长）；本地线程无工具块，不涉及。 */
  endedAtMs?: number;
  /** 当 toolName === 'web_search' 时，解析出的结构化网页来源 */
  webSources?: readonly WebSearchSource[];
  /** 当 toolName === 'web_fetch' 或 'read_url_content' 时的抓取元数据 */
  fetchResult?: WebFetchResult;
}

export interface ApprovalBlock {
  kind: 'approval';
  id: string;
  toolName: string;
  intent?: string;
  summary: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  atMs: number;
}

export interface NoticeBlock {
  kind: 'notice';
  id: string;
  text: string;
  /** 原始诊断串（仅失败 notice：用户点开才呈现，主文案走分类映射） */
  detail?: string;
  tone: TimelineTone;
  atMs: number;
}

export type TimelineBlock =
  | AssistantMessageBlock
  | MessageImageBlock
  | ReasoningBlock
  | ToolBlock
  | ApprovalBlock
  | NoticeBlock;

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

/**
 * message.blocks 中的 image 块 → 图片来源列表（保持块序）。
 * 来源优先级：url 直用；data 为完整 data URI 直用，裸 base64 数据拼
 * `data:<mimeType>;base64,`（mimeType 是注册表必填字段，缺失则无可用来源）。
 */
function imagesOfMessage(
  frame: FeedEntry
): { source: string | null; alt: string }[] {
  const message = readRecord(frame['message']);
  const blocks = message?.['blocks'];
  if (!Array.isArray(blocks)) return [];
  const images: { source: string | null; alt: string }[] = [];
  for (const block of blocks) {
    const record = readRecord(block);
    if (!record || record['type'] !== 'image') continue;
    const url =
      typeof record['url'] === 'string' && record['url'] !== ''
        ? record['url']
        : null;
    const data =
      typeof record['data'] === 'string' && record['data'] !== ''
        ? record['data']
        : null;
    const mimeType =
      typeof record['mimeType'] === 'string' ? record['mimeType'] : null;
    let source = url;
    if (!source && data) {
      source = data.startsWith('data:')
        ? data
        : mimeType
          ? `data:${mimeType};base64,${data}`
          : null;
    }
    images.push({
      source,
      alt: typeof record['alt'] === 'string' ? record['alt'] : '',
    });
  }
  return images;
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

function isThoughtDelta(frame: FeedEntry): boolean {
  const block = readRecord(frame['block']);
  if (block && (block['type'] === 'thought' || block['type'] === 'reasoning')) {
    return true;
  }
  return Boolean(
    readString(frame, 'thought') ||
    readString(frame, 'thoughtDelta') ||
    readString(frame, 'reasoning') ||
    readString(frame, 'reasoningDelta')
  );
}

function deltaThought(frame: FeedEntry): string {
  const block = readRecord(frame['block']);
  if (block && (block['type'] === 'thought' || block['type'] === 'reasoning')) {
    const text =
      (typeof block['text'] === 'string' ? block['text'] : null) ??
      (typeof block['thought'] === 'string' ? block['thought'] : null) ??
      readString(frame, 'text') ??
      '';
    return stripAnsi(text);
  }
  const direct =
    readString(frame, 'thought') ??
    readString(frame, 'thoughtDelta') ??
    readString(frame, 'reasoning') ??
    readString(frame, 'reasoningDelta');
  return direct ? stripAnsi(direct) : '';
}

function deltaText(frame: FeedEntry): string {
  const block = readRecord(frame['block']);
  if (!block) return stripAnsi(readString(frame, 'text') ?? '');
  if (block['type'] === 'thought' || block['type'] === 'reasoning') return '';
  const text =
    (typeof block['text'] === 'string' ? block['text'] : null) ??
    readString(frame, 'text') ??
    '';
  return stripAnsi(text);
}

function thoughtOfMessage(frame: FeedEntry): string {
  const message = readRecord(frame['message']);
  if (!message) {
    return stripAnsi(
      readString(frame, 'thought') ?? readString(frame, 'reasoning') ?? ''
    );
  }
  const blocks = message['blocks'];
  if (Array.isArray(blocks)) {
    const parts: string[] = [];
    for (const block of blocks) {
      const record = readRecord(block);
      if (!record) continue;
      if (record['type'] === 'thought' || record['type'] === 'reasoning') {
        const text =
          typeof record['text'] === 'string'
            ? record['text']
            : typeof record['thought'] === 'string'
              ? record['thought']
              : '';
        if (text.trim() !== '') {
          parts.push(text);
        }
      }
    }
    if (parts.length > 0) return stripAnsi(parts.join('\n\n'));
  }
  const metadata = readRecord(message['metadata']);
  const metaThought =
    metadata && typeof metadata['thought'] === 'string'
      ? metadata['thought']
      : metadata && typeof metadata['reasoning'] === 'string'
        ? metadata['reasoning']
        : null;
  const msgThought =
    typeof message['thought'] === 'string'
      ? message['thought']
      : typeof message['reasoning'] === 'string'
        ? message['reasoning']
        : null;
  return stripAnsi(
    metaThought ?? msgThought ?? readString(frame, 'thought') ?? ''
  );
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
  // 核心体验降噪：运行正常完成属于静默状态机终态，严禁在时间线生成占位行
  if (terminal === 'completed') {
    return null;
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
  // 批 C ⑮：原始 reason 串不直接内联——先映射本地封闭分类再呈现
  // （标题 + 一句话），原始串只进 detail（点开才见）；映射不中归
  // 「未分类」诚实呈现（presentRemoteFailure 口径）。
  const presentation = presentRemoteFailure(reason);
  return {
    kind: 'notice',
    id: `run-terminal-${readNumber(frame, 'sequence') ?? frame.receivedAtMs}`,
    text: presentation.text,
    ...(presentation.detail !== undefined
      ? { detail: presentation.detail }
      : {}),
    tone: 'danger',
    atMs: frame.receivedAtMs,
  };
}

// ── 增量折叠状态（身份纪律的载体，见文件头注） ──

/**
 * 一段事件流的折叠状态：草稿块 + 索引 + 已折叠前缀的条目引用快照。
 * 以流的首条目对象为键存入 WeakMap——不同会话 / 窗口的首条目互不
 * 相同，各自独立延续；条目对象被回收时状态随之回收，无显式清理。
 */
interface TimelineFoldState {
  /** 草稿块（折叠在此累积变异，永不外泄） */
  blocks: TimelineBlock[];
  /** 与草稿同序的上轮发射快照；null = 上轮被空消息过滤（或尚未发射） */
  emitted: (TimelineBlock | null)[];
  /** 本轮折叠中被条目触碰（变异）过的草稿下标，发射后清空 */
  touched: Set<number>;
  pendingMeta: Map<
    string,
    { id: string; role: 'assistant' | 'user'; atMs: number }
  >;
  messageIndex: Map<string, number>;
  imageIndex: Map<string, number>;
  reasoningIndex: Map<string, number>;
  toolIndex: Map<string, number>;
  approvalIndex: Map<string, number>;
  ignoredToolIds: Set<string>;
  lastToolId: string | null;
  /** 已折叠前缀的条目引用快照（与下轮输入逐个比对，判增量 / 分歧） */
  foldedRefs: readonly FeedEntry[];
  /** 上轮返回的数组（元素全同时复用同一数组引用） */
  lastOut: TimelineBlock[] | null;
}

function createFoldState(): TimelineFoldState {
  return {
    blocks: [],
    emitted: [],
    touched: new Set(),
    pendingMeta: new Map(),
    messageIndex: new Map(),
    imageIndex: new Map(),
    reasoningIndex: new Map(),
    toolIndex: new Map(),
    approvalIndex: new Map(),
    ignoredToolIds: new Set(),
    lastToolId: null,
    foldedRefs: [],
    lastOut: null,
  };
}

function pushDraft(state: TimelineFoldState, block: TimelineBlock): number {
  const index = state.blocks.length;
  state.blocks.push(block);
  state.emitted.push(null);
  return index;
}

function draftAt<T extends TimelineBlock>(
  state: TimelineFoldState,
  map: Map<string, number>,
  id: string,
  kind: T['kind']
): { index: number; block: T } | null {
  const index = map.get(id);
  if (index === undefined) return null;
  const block = state.blocks[index];
  return block && block.kind === kind ? { index, block: block as T } : null;
}

/** 把 entries[from..] 折叠进 state（语义与全量折叠逐字一致）。 */
function foldEntries(
  state: TimelineFoldState,
  entries: readonly FeedEntry[],
  from: number
): void {
  for (let entryIndex = from; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    const type = entry.type;
    const fallbackId = `entry-${readNumber(entry, 'sequence') ?? entryIndex}`;

    switch (type) {
      case 'message-start': {
        const meta = messageMeta(entry);
        state.pendingMeta.set(meta.id, meta);
        const initThought = thoughtOfMessage(entry);
        if (initThought !== '' && !state.reasoningIndex.has(meta.id)) {
          const rIndex = pushDraft(state, {
            kind: 'reasoning',
            id: `${meta.id}:reasoning`,
            text: initThought,
            streaming: true,
            isThinking: true,
            atMs: meta.atMs,
          });
          state.reasoningIndex.set(meta.id, rIndex);
        }
        break;
      }
      case 'message-delta': {
        const msgId =
          readString(entry, 'messageId') ??
          (readRecord(entry['message'])?.['id'] as string | undefined);
        const meta =
          (msgId ? state.pendingMeta.get(msgId) : null) ?? messageMeta(entry);

        if (isThoughtDelta(entry)) {
          const thought = deltaThought(entry);
          const existingReasoning = draftAt<ReasoningBlock>(
            state,
            state.reasoningIndex,
            meta.id,
            'reasoning'
          );
          if (existingReasoning) {
            if (thought !== '') {
              existingReasoning.block.text += thought;
            }
            existingReasoning.block.streaming = true;
            existingReasoning.block.isThinking = true;
            state.touched.add(existingReasoning.index);
          } else {
            const rIndex = pushDraft(state, {
              kind: 'reasoning',
              id: `${meta.id}:reasoning`,
              text: thought,
              streaming: true,
              isThinking: true,
              atMs: meta.atMs,
            });
            state.reasoningIndex.set(meta.id, rIndex);
          }
          break;
        }

        const text = deltaText(entry);
        // 非思考正文到来，说明当前消息的思考阶段已完成
        const activeReasoning = draftAt<ReasoningBlock>(
          state,
          state.reasoningIndex,
          meta.id,
          'reasoning'
        );
        if (
          activeReasoning &&
          (activeReasoning.block.streaming || activeReasoning.block.isThinking)
        ) {
          activeReasoning.block.streaming = false;
          activeReasoning.block.isThinking = false;
          if (activeReasoning.block.durationMs === undefined) {
            activeReasoning.block.durationMs = Math.max(
              0,
              entry.receivedAtMs - activeReasoning.block.atMs
            );
          }
          state.touched.add(activeReasoning.index);
        }

        if (text === '') {
          break;
        }

        const existing = draftAt<AssistantMessageBlock>(
          state,
          state.messageIndex,
          meta.id,
          'message'
        );
        if (existing) {
          existing.block.text += text;
          existing.block.streaming = true;
          state.touched.add(existing.index);
        } else {
          const index = pushDraft(state, {
            kind: 'message',
            id: meta.id,
            role: meta.role,
            text,
            streaming: true,
            atMs: meta.atMs,
          });
          state.messageIndex.set(meta.id, index);
        }
        break;
      }
      case 'message-end': {
        const rawMeta = messageMeta(entry);
        const meta = state.pendingMeta.get(rawMeta.id) ?? rawMeta;
        const text = textOfMessage(entry);
        const thought = thoughtOfMessage(entry);

        // 1. 思考链收口
        const existingReasoning = draftAt<ReasoningBlock>(
          state,
          state.reasoningIndex,
          meta.id,
          'reasoning'
        );
        if (existingReasoning) {
          if (thought !== '') existingReasoning.block.text = thought;
          existingReasoning.block.streaming = false;
          existingReasoning.block.isThinking = false;
          if (existingReasoning.block.durationMs === undefined) {
            existingReasoning.block.durationMs = Math.max(
              0,
              entry.receivedAtMs - existingReasoning.block.atMs
            );
          }
          state.touched.add(existingReasoning.index);
        } else if (thought !== '') {
          const rIndex = pushDraft(state, {
            kind: 'reasoning',
            id: `${meta.id}:reasoning`,
            text: thought,
            streaming: false,
            isThinking: false,
            durationMs: 0,
            atMs: meta.atMs,
          });
          state.reasoningIndex.set(meta.id, rIndex);
        }

        // 2. 正文收口
        const existing = draftAt<AssistantMessageBlock>(
          state,
          state.messageIndex,
          meta.id,
          'message'
        );
        if (existing) {
          if (text !== '') existing.block.text = text;
          existing.block.streaming = false;
          state.touched.add(existing.index);
        } else if (text !== '') {
          const index = pushDraft(state, {
            kind: 'message',
            id: meta.id,
            role: meta.role,
            text,
            streaming: false,
            atMs: meta.atMs,
          });
          state.messageIndex.set(meta.id, index);
        }

        // 3. image 块如实入线（落本消息块之后；同 id 只入一次，防重放重复）
        imagesOfMessage(entry).forEach((image, imageOrder) => {
          const imageId = `${meta.id}:image:${imageOrder}`;
          if (state.imageIndex.has(imageId)) return;
          const index = pushDraft(state, {
            kind: 'image',
            id: imageId,
            source: image.source,
            alt: image.alt,
            atMs: meta.atMs,
          });
          state.imageIndex.set(imageId, index);
        });
        break;
      }
      case 'tool-start': {
        const id = toolIdOf(entry, fallbackId);
        const call = readRecord(entry['call']);
        const isInternal = Boolean(
          readBool(entry, 'isInternal') ||
          readBool(entry, 'is_internal') ||
          (call &&
            (call['isInternal'] === true || call['is_internal'] === true))
        );
        if (isInternal) {
          state.ignoredToolIds.add(id);
          break;
        }
        state.lastToolId = id;
        const intent = stripAnsi(
          readString(entry, 'intent') ??
            (call && typeof call['intent'] === 'string'
              ? call['intent']
              : null) ??
            readString(entry, 'explanation') ??
            (call && typeof call['explanation'] === 'string'
              ? call['explanation']
              : null) ??
            readString(entry, 'summary') ??
            (call && typeof call['summary'] === 'string' ? call['summary'] : '')
        );
        const group =
          readString(entry, 'group') ??
          (call && typeof call['group'] === 'string'
            ? call['group']
            : undefined);
        const groupId =
          readString(entry, 'groupId') ??
          readString(entry, 'group_id') ??
          (call && typeof (call['groupId'] ?? call['group_id']) === 'string'
            ? String(call['groupId'] ?? call['group_id'])
            : undefined);
        const rawInput =
          entry['input'] ??
          (call && call['input'] ? call['input'] : undefined) ??
          entry['args'] ??
          (call && call['args'] ? call['args'] : undefined);
        const input =
          typeof rawInput === 'object' && rawInput !== null
            ? (rawInput as Record<string, unknown>)
            : typeof rawInput === 'string'
              ? rawInput
              : undefined;
        const index = pushDraft(state, {
          kind: 'tool',
          id,
          toolName: toolNameOf(entry),
          intent: intent || undefined,
          group,
          groupId,
          isInternal: false,
          summary: intent,
          status: 'running',
          input,
          output: '',
          atMs: entry.receivedAtMs,
        });
        state.toolIndex.set(id, index);
        break;
      }
      case 'tool-update': {
        const id = toolIdOf(entry, state.lastToolId ?? fallbackId);
        if (state.ignoredToolIds.has(id)) {
          break;
        }
        const update = readRecord(entry['update']);
        const text = stripAnsi(
          readString(entry, 'text') ??
            (update && typeof update['text'] === 'string' ? update['text'] : '')
        );
        const existing = draftAt<ToolBlock>(state, state.toolIndex, id, 'tool');
        if (existing) {
          if (text) {
            existing.block.output = `${existing.block.output}${text}`.slice(
              -MAX_TOOL_OUTPUT
            );
            state.touched.add(existing.index);
          }
        } else if (state.lastToolId) {
          const last = draftAt<ToolBlock>(
            state,
            state.toolIndex,
            state.lastToolId,
            'tool'
          );
          if (last && text) {
            last.block.output = `${last.block.output}${text}`.slice(
              -MAX_TOOL_OUTPUT
            );
            state.touched.add(last.index);
          }
        }
        break;
      }
      case 'tool-end': {
        const id = toolIdOf(entry, state.lastToolId ?? fallbackId);
        if (state.ignoredToolIds.has(id)) {
          state.ignoredToolIds.delete(id);
          if (state.lastToolId === id) {
            state.lastToolId = null;
          }
          break;
        }
        const result = readRecord(entry['result']);
        const isInternal = Boolean(
          readBool(entry, 'isInternal') ||
          readBool(entry, 'is_internal') ||
          (result &&
            (result['isInternal'] === true || result['is_internal'] === true))
        );
        if (isInternal) {
          if (state.lastToolId === id) {
            state.lastToolId = null;
          }
          break;
        }
        const isError =
          readBool(entry, 'result', 'isError') || result?.['isError'] === true;
        const output = stripAnsi(
          readString(entry, 'output') ??
            (result && typeof result['output'] === 'string'
              ? result['output']
              : '')
        );
        const isDiff =
          readBool(entry, 'result', 'isDiff') ||
          result?.['isDiff'] === true ||
          output.includes('@@ -') ||
          output.includes('diff --git');
        const existing = draftAt<ToolBlock>(state, state.toolIndex, id, 'tool');
        const toolName = existing ? existing.block.toolName : toolNameOf(entry);
        const webSources =
          toolName === 'web_search' || toolName === 'search_web'
            ? extractWebSources(output)
            : undefined;
        const fetchResult =
          toolName === 'web_fetch' ||
          toolName === 'fetch_url' ||
          toolName === 'read_url_content'
            ? extractFetchResult(output, existing?.block.input)
            : undefined;

        if (existing) {
          existing.block.status = isError ? 'error' : 'done';
          existing.block.endedAtMs = entry.receivedAtMs;
          if (isDiff) existing.block.isDiff = true;
          if (output) {
            existing.block.output = `${existing.block.output}${output}`.slice(
              -MAX_TOOL_OUTPUT
            );
          }
          if (webSources) existing.block.webSources = webSources;
          if (fetchResult) existing.block.fetchResult = fetchResult;
          state.touched.add(existing.index);
        } else {
          const index = pushDraft(state, {
            kind: 'tool',
            id,
            toolName,
            summary: '',
            status: isError ? 'error' : 'done',
            isDiff,
            output,
            atMs: entry.receivedAtMs,
            endedAtMs: entry.receivedAtMs,
            ...(webSources ? { webSources } : {}),
            ...(fetchResult ? { fetchResult } : {}),
          });
          state.toolIndex.set(id, index);
        }
        state.lastToolId = null;
        break;
      }
      case 'approval-requested': {
        const id =
          readString(entry, 'toolCallId') ??
          readString(entry, 'tool_call_id') ??
          fallbackId;
        const req = readRecord(entry['request']);
        const intent = stripAnsi(
          readString(entry, 'intent') ??
            (req && typeof req['intent'] === 'string' ? req['intent'] : '') ??
            readString(entry, 'summary') ??
            (req && typeof req['summary'] === 'string' ? req['summary'] : '') ??
            readString(entry, 'explanation') ??
            (req && typeof req['explanation'] === 'string'
              ? req['explanation']
              : '')
        );
        if (!state.approvalIndex.has(id)) {
          const index = pushDraft(state, {
            kind: 'approval',
            id,
            toolName:
              readString(entry, 'toolName') ??
              (req && typeof req['toolName'] === 'string'
                ? req['toolName']
                : '工具'),
            intent: intent || undefined,
            summary: intent,
            status: 'pending',
            atMs: entry.receivedAtMs,
          });
          state.approvalIndex.set(id, index);
        }
        break;
      }
      case 'approval-resolved': {
        const id =
          readString(entry, 'toolCallId') ??
          readString(entry, 'tool_call_id') ??
          fallbackId;
        const existing = draftAt<ApprovalBlock>(
          state,
          state.approvalIndex,
          id,
          'approval'
        );
        if (existing) {
          existing.block.status = approvalStatusOf(
            readString(entry, 'decision')
          );
          state.touched.add(existing.index);
        }
        break;
      }
      case 'runtime-error':
      case 'runtime-intervention-required': {
        const text =
          readString(entry, 'error') ??
          readString(entry, 'reason') ??
          '运行出现异常';
        pushDraft(state, {
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
        if (notice) pushDraft(state, notice);
        break;
      }
      case 'task-failed': {
        pushDraft(state, {
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
  }
}

/**
 * 语义文本清洗：剔除不可见字符（零宽字符、BOM等）及两端空白
 */
export function cleanSemanticText(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

/**
 * 发射：草稿 → 对外块数组。未被触碰的草稿复用上轮快照（同一引用）；
 * 被触碰 / 新生草稿发浅拷贝新快照；空消息（只有 start 没有正文）不
 * 占位（与历史口径一致，过滤在发射面做、草稿保留待后续增量续写）。
 * 元素与上轮全同时复用上轮数组本身。
 */
function emitTimeline(state: TimelineFoldState): TimelineBlock[] {
  const prev = state.lastOut;
  const out: TimelineBlock[] = [];
  let sameAsPrev = prev !== null;
  for (let index = 0; index < state.blocks.length; index += 1) {
    const draft = state.blocks[index]!;
    // 1. 消息非空铁门：剔除全为空白字符或零宽字符的幽灵消息块
    if (draft.kind === 'message' && cleanSemanticText(draft.text) === '') {
      state.emitted[index] = null;
      continue;
    }
    // 2. 思考链非空铁门：收口后如果文本为空，绝不发射空思考壳
    if (
      draft.kind === 'reasoning' &&
      cleanSemanticText(draft.text) === '' &&
      !draft.streaming &&
      !draft.isThinking
    ) {
      state.emitted[index] = null;
      continue;
    }
    let snapshot = state.emitted[index] ?? null;
    if (snapshot === null || state.touched.has(index)) {
      snapshot = { ...draft };
      state.emitted[index] = snapshot;
    }
    if (sameAsPrev && prev![out.length] !== snapshot) sameAsPrev = false;
    out.push(snapshot);
  }
  state.touched.clear();
  if (sameAsPrev && prev !== null && prev.length === out.length) return prev;
  state.lastOut = out;
  return out;
}

/** 下轮输入是否同一段流的尾部延续（已折叠前缀逐个引用相等）。 */
function isFoldExtension(
  state: TimelineFoldState,
  entries: readonly FeedEntry[]
): boolean {
  const prev = state.foldedRefs;
  if (entries.length < prev.length) return false;
  for (let index = 0; index < prev.length; index += 1) {
    if (entries[index] !== prev[index]) return false;
  }
  return true;
}

const foldStates = new WeakMap<FeedEntry, TimelineFoldState>();
const EMPTY_TIMELINE: TimelineBlock[] = [];

/**
 * 事件窗口 → 时间线块（顺序 = 首次出现顺序）。
 * 只保留有阅读价值的内容：助手正文、工具调用、审批、错误、运行终态。
 * 输出值与全量折叠恒等；对象身份按文件头注的身份纪律共享。
 */
export function buildSessionTimeline(
  entries: readonly FeedEntry[]
): TimelineBlock[] {
  if (entries.length === 0) return EMPTY_TIMELINE;
  const anchor = entries[0]!;
  let state = foldStates.get(anchor);
  if (state && !isFoldExtension(state, entries)) {
    // 分歧（条目被替换 / 输入缩短 / 换流）：整段作废，全量重折
    foldStates.delete(anchor);
    state = undefined;
  }
  if (!state) {
    state = createFoldState();
    foldStates.set(anchor, state);
  }
  foldEntries(state, entries, state.foldedRefs.length);
  state.foldedRefs = entries.slice();
  return emitTimeline(state);
}

export const buildTimeline = buildSessionTimeline;

function unescapeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * 安全反序列化提取 webSources（支持 JSON、XML 与 Markdown 链接多格式）
 */
export function extractWebSources(
  output: unknown
): readonly WebSearchSource[] | undefined {
  if (!output) return undefined;
  let parsed: unknown = output;
  if (typeof output === 'string') {
    const trimmed = output.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = null;
      }
    } else {
      // 1. 尝试从 XML 标签 <result ...> 中提取 (searchWaterfall / 端侧标准产出)
      if (trimmed.includes('<result')) {
        const sources: WebSearchSource[] = [];
        const resultRegex = /<result\s+([^>]*?)>([\s\S]*?)<\/result>/gi;
        let match: RegExpExecArray | null;
        let idx = 1;
        while ((match = resultRegex.exec(trimmed)) !== null) {
          const attrsStr = match[1] || '';
          const bodyStr = match[2] || '';

          const urlAttrMatch = attrsStr.match(/url="([^"]+)"/i);
          const urlTagMatch = bodyStr.match(/<url>([\s\S]*?)<\/url>/i);
          const idMatch =
            attrsStr.match(/id="([^"]+)"/i) ||
            bodyStr.match(/<id>([\s\S]*?)<\/id>/i);
          const sourceMatch =
            attrsStr.match(/source="([^"]+)"/i) ||
            bodyStr.match(/<source>([\s\S]*?)<\/source>/i);

          const titleMatch = bodyStr.match(/<title>([\s\S]*?)<\/title>/i);
          const snippetMatch = bodyStr.match(/<snippet>([\s\S]*?)<\/snippet>/i);

          const rawUrl = urlAttrMatch
            ? unescapeXml(urlAttrMatch[1] || '')
            : urlTagMatch
              ? unescapeXml(urlTagMatch[1] || '').trim()
              : '';
          if (rawUrl) {
            let domain = '';
            try {
              domain = new URL(rawUrl).hostname;
            } catch {
              const m = rawUrl.match(/^(?:https?:\/\/)?([^/?#:]+)/i);
              domain = m ? m[1] || '' : '';
            }
            sources.push({
              id: idMatch ? idMatch[1] || String(idx) : String(idx),
              title: titleMatch
                ? unescapeXml(titleMatch[1] || '').trim()
                : '无标题网页',
              url: rawUrl,
              snippet: snippetMatch
                ? unescapeXml(snippetMatch[1] || '').trim()
                : '',
              domain,
              provider: (sourceMatch
                ? sourceMatch[1]
                : 'model_native') as WebSearchSource['provider'],
            });
            idx++;
          }
        }
        if (sources.length > 0) return sources;
      }

      // 2. 尝试从 Markdown 格式 [title](url) 列表中提取
      const mdRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
      const mdSources: WebSearchSource[] = [];
      let mdMatch: RegExpExecArray | null;
      let mdIdx = 1;
      while ((mdMatch = mdRegex.exec(trimmed)) !== null) {
        const title = mdMatch[1] || '无标题网页';
        const rawUrl = mdMatch[2] || '';
        let domain = '';
        try {
          domain = new URL(rawUrl).hostname;
        } catch {
          const m = rawUrl.match(/^(?:https?:\/\/)?([^/?#:]+)/i);
          domain = m ? m[1] || '' : '';
        }
        mdSources.push({
          id: String(mdIdx),
          title,
          url: rawUrl,
          snippet: '',
          domain,
          provider: 'model_native',
        });
        mdIdx++;
      }
      if (mdSources.length > 0) return mdSources;
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object') return undefined;

  let rawList: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    rawList = parsed;
  } else {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.results)) {
      rawList = record.results;
    } else if (Array.isArray(record.sources)) {
      rawList = record.sources;
    }
  }

  if (!rawList || rawList.length === 0) return undefined;

  const sources: WebSearchSource[] = [];
  for (let idx = 0; idx < rawList.length; idx++) {
    const item = rawList[idx];
    if (item && typeof item === 'object') {
      const r = item as Record<string, unknown>;
      const url = String(r.url || '');
      let domain = String(r.domain || '');
      if (!domain && url) {
        try {
          domain = new URL(url).hostname;
        } catch {
          const m = url.match(/^(?:https?:\/\/)?([^/?#:]+)/i);
          domain = m ? m[1] || '' : '';
        }
      }
      sources.push({
        id: String(r.id || idx + 1),
        title: String(r.title || '无标题网页'),
        url,
        snippet: String(r.snippet || r.content || ''),
        domain,
        provider: (r.provider || 'model_native') as WebSearchSource['provider'],
        publishedDate:
          typeof r.publishedDate === 'string' ? r.publishedDate : undefined,
        score: typeof r.score === 'number' ? r.score : undefined,
        faviconUrl: typeof r.faviconUrl === 'string' ? r.faviconUrl : undefined,
        fullContent:
          typeof r.fullContent === 'string' ? r.fullContent : undefined,
      });
    }
  }
  return sources.length > 0 ? sources : undefined;
}

/**
 * 安全反序列化提取 fetchResult（支持 JSON 与纯 Markdown 正文）
 */
export function extractFetchResult(
  output: unknown,
  input?: unknown
): WebFetchResult | undefined {
  if (!output) return undefined;
  let parsed: unknown = output;
  let title = '';
  let markdownContent = '';

  if (typeof output === 'string') {
    const trimmed = output.trim();
    if (trimmed.startsWith('{')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = null;
      }
    } else {
      // output 是直接的 Markdown 正文文本（web_fetch 标准产出）
      markdownContent = trimmed;
      const titleMatch = trimmed.match(/^#\s+(.+)$/m);
      if (titleMatch) {
        title = titleMatch[1]?.trim() || '';
      }
    }
  }

  let rawUrl = '';
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    rawUrl = typeof obj.url === 'string' ? obj.url : '';
    if (!title) title = String(obj.title || '');
    if (!markdownContent) {
      markdownContent = String(obj.markdownContent || obj.content || '');
    }
  }

  if (!rawUrl && input) {
    if (typeof input === 'string') {
      try {
        const parsedInput = JSON.parse(input);
        if (typeof parsedInput.url === 'string') rawUrl = parsedInput.url;
      } catch {
        const m = input.match(/https?:\/\/[^\s"'`<>]+/i);
        if (m) rawUrl = m[0] || '';
      }
    } else if (typeof input === 'object' && input !== null) {
      const objInput = input as Record<string, unknown>;
      if (typeof objInput.url === 'string') rawUrl = String(objInput.url || '');
    }
  }

  if (!rawUrl) return undefined;

  const obj =
    parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;

  return {
    url: rawUrl,
    title,
    markdownContent,
    rawHtmlLength: Number(obj?.rawHtmlLength || 0),
    cleanedLength:
      typeof obj?.cleanedLength === 'number'
        ? obj.cleanedLength
        : markdownContent.length,
    truncated: Boolean(obj?.truncated),
    discoveredLinks: Array.isArray(obj?.discoveredLinks)
      ? obj.discoveredLinks.filter((x): x is string => typeof x === 'string')
      : undefined,
  };
}

/** 工具入参提取助手 */
function extractToolInputRecord(
  input?: Record<string, unknown> | string
): Record<string, unknown> | null {
  if (!input) return null;
  if (typeof input === 'object' && input !== null) return input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 工具名称精炼呈现 */
export function formatToolDisplayName(toolName: string): string {
  if (toolName === 'web_search' || toolName === 'search_web') {
    return '网页搜索';
  }
  if (
    toolName === 'web_fetch' ||
    toolName === 'fetch_url' ||
    toolName === 'read_url_content'
  ) {
    return '网页抓取';
  }
  if (
    toolName === 'run_js_sandbox' ||
    toolName === 'quickjs_sandbox' ||
    toolName === 'run_javascript'
  ) {
    return '执行端侧脚本';
  }
  return toolName;
}

/** 工具块一行摘要（折叠态）。 */
export function toolBlockSummary(block: ToolBlock): string {
  const toolName = block.toolName;
  const inputRecord = extractToolInputRecord(block.input);

  // 1. web_search / search_web
  if (toolName === 'web_search' || toolName === 'search_web') {
    if (block.status === 'done' && Array.isArray(block.webSources)) {
      return `已搜索 ${block.webSources.length} 个网页`;
    }
    const query =
      (inputRecord &&
        (typeof inputRecord.query === 'string'
          ? inputRecord.query
          : typeof inputRecord.q === 'string'
            ? inputRecord.q
            : null)) ??
      (typeof block.input === 'string' && !block.input.trim().startsWith('{')
        ? block.input.trim()
        : null);
    if (query) {
      return `搜索 · "${query}"`;
    }
    const text = block.intent || block.summary;
    if (text) {
      return text.length > 80 ? `${text.slice(0, 79)}…` : text;
    }
    return '搜索';
  }

  // 2. web_fetch / fetch_url / read_url_content
  if (
    toolName === 'web_fetch' ||
    toolName === 'fetch_url' ||
    toolName === 'read_url_content'
  ) {
    const rawUrl =
      (inputRecord && typeof inputRecord.url === 'string'
        ? inputRecord.url
        : null) ??
      (typeof block.input === 'string' && !block.input.trim().startsWith('{')
        ? block.input.trim()
        : null) ??
      block.fetchResult?.url;
    if (rawUrl) {
      let hostname = '';
      try {
        hostname = new URL(rawUrl).hostname;
      } catch {
        const match = rawUrl.match(/^(?:https?:\/\/)?([^/?#:]+)/i);
        hostname = match ? match[1] || '' : rawUrl;
      }
      if (hostname) {
        return `抓取 · ${hostname}`;
      }
    }
    const text = block.intent || block.summary;
    if (text) {
      return text.length > 80 ? `${text.slice(0, 79)}…` : text;
    }
    return '抓取';
  }

  // 3. run_js_sandbox / quickjs_sandbox / run_javascript
  if (
    toolName === 'run_js_sandbox' ||
    toolName === 'quickjs_sandbox' ||
    toolName === 'run_javascript'
  ) {
    if (block.intent) {
      return block.intent.length > 80
        ? `${block.intent.slice(0, 79)}…`
        : block.intent;
    }
    return '执行端侧脚本';
  }

  if (block.intent) {
    return block.intent.length > 80
      ? `${block.intent.slice(0, 79)}…`
      : block.intent;
  }

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
