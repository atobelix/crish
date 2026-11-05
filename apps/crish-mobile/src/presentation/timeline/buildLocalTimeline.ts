// 本地线程消息 → 统一时间线块投影（移动界面统一方案 §2.1）：
// 与 buildSessionTimeline 同一套 TimelineBlock 语义，ConversationScreen
// 对本地/远端零分叉渲染。纯函数（输出值只取决于输入值），不依赖 React / store。
//
// 映射口径（方案 §2.1 + 真实工具调用对齐）：
// - system 消息不呈现（仅作上下文，与 wire 纪律一致）；
// - user / assistant → message 块（streaming 透传）；
// - 正文为空的消息不占行（与 buildSessionTimeline 的空消息过滤同
//   口径：流式占位在首个增量到达前不呈现，忙态由 Composer 区承载）；
// - assistant 的思考内容 → 独立 ReasoningBlock 块（排在正文之前）；
// - assistant 的 toolCalls → 真实的 ToolBlock 工具块（排在正文之前）；
//   * web_search: 安全反序列化提取 webSources 挂载于块；
//   * web_fetch: 安全解析提取 fetchResult 挂载于块；
// - assistant 的 stopped → 其后补一条 muted notice「已停止生成」；
// - 工具块即使正文为空也照常发出——工具调用作为可见证据保留。
//
// 身份纪律（结构共享，与 buildSessionTimeline 同口径）：每条消息的
// 投影块只取决于该消息自身字段，故按消息对象引用缓存（WeakMap）：
// 消息对象不变 → 其块逐个复用同一引用；store 以 immer 换新被改动的
// 消息对象（流式追加 / 收尾），换新即重投影该条、邻条零重建。取用
// 缓存时逐字段核对快照（防原地变异绕过引用变化），不一致即重建。
import type { LocalChatMessage } from '@/domain/types/localChat';
import type { LocalToolCall } from '@/db/dao/localThreadsDao';
import type { TimelineBlock, ToolBlock } from './buildTimeline';
import { extractWebSources, extractFetchResult } from './buildTimeline';

declare module '@/domain/types/localChat' {
  interface LocalChatMessage {
    reasoning?: string;
    isThinking?: boolean;
    thought?: string;
    reasoningContent?: string;
    toolCalls?: LocalToolCall[];
  }
}

interface LocalToolCallSnapshot {
  id: string;
  name: string;
  functionName?: string;
  status: string;
  state?: string;
  arguments?: string;
  functionArgs?: string;
  result?: string;
  output?: string;
}

function snapshotToolCalls(
  calls: readonly LocalToolCall[] | undefined
): LocalToolCallSnapshot[] | undefined {
  if (!calls) return undefined;
  return calls.map((c) => ({
    id: c.id,
    name: c.name || '',
    functionName: c.function?.name,
    status: (c.status as string) || '',
    state: c.state,
    arguments: c.arguments,
    functionArgs: c.function?.arguments,
    result: c.result,
    output: (c as unknown as { output?: string }).output,
  }));
}

interface LocalMessageBlocks {
  id: string;
  role: LocalChatMessage['role'];
  content: string;
  streaming: boolean;
  stopped: boolean;
  toolCallsSnapshot: readonly LocalToolCallSnapshot[] | undefined;
  reasoning: string;
  isThinking: boolean;
  blocks: TimelineBlock[];
}

const localBlocksCache = new WeakMap<LocalChatMessage, LocalMessageBlocks>();
export const _localBlocksCacheForTest = localBlocksCache;

function areToolCallsEqual(
  cached: readonly LocalToolCallSnapshot[] | undefined,
  current: readonly LocalToolCall[] | undefined
): boolean {
  if (!cached && !current) return true;
  if (!cached || !current) return false;
  if (cached.length !== current.length) return false;
  for (let i = 0; i < cached.length; i++) {
    const s = cached[i]!;
    const c = current[i]!;
    if (
      s.id !== c.id ||
      s.name !== (c.name || '') ||
      s.functionName !== c.function?.name ||
      s.status !== ((c.status as string) || '') ||
      s.state !== c.state ||
      s.arguments !== c.arguments ||
      s.functionArgs !== c.function?.arguments ||
      s.result !== c.result ||
      s.output !== (c as unknown as { output?: string }).output
    ) {
      return false;
    }
  }
  return true;
}

function blocksForLocalMessage(message: LocalChatMessage): TimelineBlock[] {
  const streaming = message.streaming === true;
  const stopped = message.stopped === true;
  const reasoning =
    typeof message.reasoning === 'string'
      ? message.reasoning
      : typeof message.thought === 'string'
        ? message.thought
        : typeof message.reasoningContent === 'string'
          ? message.reasoningContent
          : '';
  const isThinking = message.isThinking === true;
  const toolCalls = message.toolCalls;

  const cached = localBlocksCache.get(message);
  if (
    cached &&
    cached.id === message.id &&
    cached.role === message.role &&
    cached.content === message.content &&
    cached.streaming === streaming &&
    cached.stopped === stopped &&
    areToolCallsEqual(cached.toolCallsSnapshot, toolCalls) &&
    cached.reasoning === reasoning &&
    cached.isThinking === isThinking
  ) {
    return cached.blocks;
  }
  const blocks: TimelineBlock[] = [];
  if (message.role === 'user' || message.role === 'assistant') {
    const cleanReasoning = (reasoning ?? '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();
    const cleanContent = (message.content ?? '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();

    // 思考内容映射为专属 ReasoningBlock（位于正文之前，支持 isThinking 占位与正文解封；非空把关）
    if (cleanReasoning !== '' || isThinking) {
      blocks.push({
        kind: 'reasoning',
        id: `${message.id}:reasoning`,
        text: reasoning,
        streaming: isThinking || (streaming && cleanContent === ''),
        isThinking,
        atMs: 0,
      });
    }

    // 从 message.toolCalls 中提炼真实的 ToolBlock
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      for (const call of toolCalls) {
        const toolName = call.name || call.function?.name || 'tool';
        const status: ToolBlock['status'] =
          call.state === 'executing' || (call.status as string) === 'running'
            ? 'running'
            : call.state === 'failed' || (call.status as string) === 'error'
              ? 'error'
              : 'done';
        const input =
          call.arguments ||
          call.function?.arguments ||
          (call.parsedArgs ? JSON.stringify(call.parsedArgs) : undefined);
        const output =
          call.result || (call as unknown as { output?: string }).output || '';
        const webSources =
          toolName === 'web_search' || toolName === 'search_web'
            ? extractWebSources(output)
            : undefined;
        const fetchResult =
          toolName === 'web_fetch' ||
          toolName === 'fetch_url' ||
          toolName === 'read_url_content'
            ? extractFetchResult(output, input)
            : undefined;

        blocks.push({
          kind: 'tool',
          id: call.id,
          toolName,
          summary: '',
          status,
          ...(input !== undefined ? { input } : {}),
          output,
          atMs: call.startedAt || 0,
          ...(call.completedAt ? { endedAtMs: call.completedAt } : {}),
          ...(webSources ? { webSources } : {}),
          ...(fetchResult ? { fetchResult } : {}),
        });
      }
    }

    // 严格非空守门：纯空白/零宽字符幽灵消息绝对不入时间线
    if (cleanContent !== '') {
      blocks.push({
        kind: 'message',
        id: message.id,
        role: message.role,
        text: message.content,
        streaming,
        atMs: 0,
      });
    }

    if (message.role === 'assistant') {
      if (message.stopped) {
        blocks.push({
          kind: 'notice',
          id: `${message.id}:stopped`,
          text: '已停止生成',
          tone: 'muted',
          atMs: 0,
        });
      }
    }
  }

  localBlocksCache.set(message, {
    id: message.id,
    role: message.role,
    content: message.content,
    streaming,
    stopped,
    toolCallsSnapshot: snapshotToolCalls(toolCalls),
    reasoning,
    isThinking,
    blocks,
  });
  return blocks;
}

/**
 * 本地时间线折叠状态：已封口前缀消息的引用列表 + 投影出的 blocks 扁平数组。
 * 以会话首条消息对象为键存入 WeakMap（foldStates）——不同线程首消息各异，独立延续；
 * 线程销毁或首消息 GC 时自动回收。
 */
interface LocalTimelineFoldState {
  /** 已封口前缀消息的引用列表 */
  sealedMessages: LocalChatMessage[];
  /** 已封口前缀消息投影出的 blocks 扁平数组 */
  sealedBlocks: TimelineBlock[];
  /** 上轮输入的完整 messages 引用快照（用于快速等价复用） */
  lastMessages?: readonly LocalChatMessage[];
  /** 上轮输出的 blocks 数组引用 */
  lastOutput?: TimelineBlock[];
}

let foldStates = new WeakMap<LocalChatMessage, LocalTimelineFoldState>();
export const _foldStatesForTest = () => foldStates;

export function resetLocalTimelineFoldStatesForTest(): void {
  foldStates = new WeakMap<LocalChatMessage, LocalTimelineFoldState>();
}

function isMessageDirty(message: LocalChatMessage): boolean {
  const cached = localBlocksCache.get(message);
  if (!cached) return true;
  const streaming = message.streaming === true;
  const stopped = message.stopped === true;
  const reasoning =
    typeof message.reasoning === 'string'
      ? message.reasoning
      : typeof message.thought === 'string'
        ? message.thought
        : typeof message.reasoningContent === 'string'
          ? message.reasoningContent
          : '';
  const isThinking = message.isThinking === true;
  const toolCalls = message.toolCalls;
  return !(
    cached.id === message.id &&
    cached.role === message.role &&
    cached.content === message.content &&
    cached.streaming === streaming &&
    cached.stopped === stopped &&
    areToolCallsEqual(cached.toolCallsSnapshot, toolCalls) &&
    cached.reasoning === reasoning &&
    cached.isThinking === isThinking
  );
}

export function buildLocalTimeline(
  messages: readonly LocalChatMessage[]
): TimelineBlock[] {
  if (messages.length === 0) {
    return [];
  }

  const anchor = messages[0]!;
  let state = foldStates.get(anchor);

  const lastIndex = messages.length - 1;
  const lastMessage = messages[lastIndex]!;
  const isLastGrowing =
    lastMessage.role === 'assistant' && lastMessage.streaming === true;

  // 检查已缓存的前缀消息是否仍然完全匹配当前 messages 的前缀
  if (state) {
    const sealed = state.sealedMessages;
    let prefixValid = messages.length >= sealed.length;
    if (prefixValid) {
      for (let i = 0; i < sealed.length; i++) {
        if (messages[i] !== sealed[i]) {
          prefixValid = false;
          break;
        }
        // 非流式生长阶段（如重渲染或单元测试模拟）：核对就地变异快照
        if (!isLastGrowing && isMessageDirty(sealed[i]!)) {
          prefixValid = false;
          break;
        }
      }
    }
    if (!prefixValid) {
      // 历史前缀发生分歧或就地变异：废弃该状态，重新折叠
      foldStates.delete(anchor);
      state = undefined;
    }
  }

  if (!state) {
    state = {
      sealedMessages: [],
      sealedBlocks: [],
    };
    foldStates.set(anchor, state);
  }

  // 推进已封口的历史消息前缀：
  // 规则：除最后一条正在生长的 Assistant 消息外，其余未封口消息逐一进入 sealedBlocks；
  // 若最后一条消息不是正在流式的 Assistant，则整条时间线的所有消息均已封口。
  const sealUntil = isLastGrowing ? lastIndex : messages.length;

  for (let i = state.sealedMessages.length; i < sealUntil; i++) {
    const msg = messages[i]!;
    state.sealedMessages.push(msg);
    const msgBlocks = blocksForLocalMessage(msg);
    for (let b = 0; b < msgBlocks.length; b++) {
      state.sealedBlocks.push(msgBlocks[b]!);
    }
  }

  let result: TimelineBlock[];
  if (isLastGrowing) {
    // 仅对最后一条正在生长的 Assistant 消息构造新 block，与已封口前缀拼接
    const growingBlocks = blocksForLocalMessage(lastMessage);
    result = state.sealedBlocks.concat(growingBlocks);
  } else {
    // 全量已封口：直接使用 sealedBlocks 的切片（浅拷贝保障外层不可变）
    result = state.sealedBlocks.slice();
  }

  state.lastMessages = messages;
  state.lastOutput = result;
  return result;
}

export default buildLocalTimeline;
