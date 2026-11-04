// 本地线程消息 → 统一时间线块投影（移动界面统一方案 §2.1）：
// 与 buildSessionTimeline 同一套 TimelineBlock 语义，ConversationScreen
// 对本地/远端零分叉渲染。纯函数（输出值只取决于输入值），不依赖 React / store。
//
// 映射口径（方案 §2.1 + 旧本地视图呈现纪律平移）：
// - system 消息不呈现（仅作上下文，与 wire 纪律一致）；
// - user / assistant → message 块（streaming 透传）；
// - 正文为空的消息不占行（与 buildSessionTimeline 的空消息过滤同
//   口径：流式占位在首个增量到达前不呈现，忙态由 Composer 区承载）；
// - assistant 的 stopped → 其后补一条 muted notice「已停止生成」；
// - assistant 的 toolCallCount > 0 → 其后补一条 muted notice（沿用
//   旧诚实文案：本地不执行工具，如实告知已忽略）；
// - 上述两类标注即使正文为空也照常发出——诚实信号不被空正文吞掉
//   （如模型只返回 tool_calls、无正文时，工具提示是唯一可见证据）。
// atMs：本地消息数据模型没有逐条时间戳（LocalChatMessage 无时间
// 字段），且 TimelineBlock.atMs 在当前呈现面无消费方（TimelineView
// 不渲染时钟、groupToolRuns 仅工具组取用、本地无工具块）——置 0 表
// 「无时间信息」，顺序由消息数组序承载，不伪造时间。
//
// 身份纪律（结构共享，与 buildSessionTimeline 同口径）：每条消息的
// 投影块只取决于该消息自身字段，故按消息对象引用缓存（WeakMap）：
// 消息对象不变 → 其块逐个复用同一引用；store 以 immer 换新被改动的
// 消息对象（流式追加 / 收尾），换新即重投影该条、邻条零重建。取用
// 缓存时逐字段核对快照（防原地变异绕过引用变化），不一致即重建。
import type { LocalChatMessage } from '@/domain/types/localChat';
import type { TimelineBlock } from './buildTimeline';

declare module '@/domain/types/localChat' {
  interface LocalChatMessage {
    reasoning?: string;
    isThinking?: boolean;
    thought?: string;
    reasoningContent?: string;
  }
}

interface LocalMessageBlocks {
  id: string;
  role: LocalChatMessage['role'];
  content: string;
  streaming: boolean;
  stopped: boolean;
  toolCallCount: number | undefined;
  reasoning: string;
  isThinking: boolean;
  blocks: TimelineBlock[];
}

const localBlocksCache = new WeakMap<LocalChatMessage, LocalMessageBlocks>();
export const _localBlocksCacheForTest = localBlocksCache;

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
  const cached = localBlocksCache.get(message);
  if (
    cached &&
    cached.id === message.id &&
    cached.role === message.role &&
    cached.content === message.content &&
    cached.streaming === streaming &&
    cached.stopped === stopped &&
    cached.toolCallCount === message.toolCallCount &&
    cached.reasoning === reasoning &&
    cached.isThinking === isThinking
  ) {
    return cached.blocks;
  }
  const blocks: TimelineBlock[] = [];
  if (message.role === 'user' || message.role === 'assistant') {
    // 思考内容映射为专属 ReasoningBlock（位于正文之前，支持 isThinking 占位与正文解封）
    if (reasoning.trim() !== '' || isThinking) {
      blocks.push({
        kind: 'reasoning',
        id: `${message.id}:reasoning`,
        text: reasoning,
        streaming: isThinking || (streaming && message.content.trim() === ''),
        isThinking,
        atMs: 0,
      });
    }
    if (message.content.trim() !== '') {
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
      if (message.toolCallCount !== undefined && message.toolCallCount > 0) {
        blocks.push({
          kind: 'notice',
          id: `${message.id}:tools`,
          text: '本地对话暂不支持工具调用',
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
    toolCallCount: message.toolCallCount,
    reasoning,
    isThinking,
    blocks,
  });
  return blocks;
}

export function buildLocalTimeline(
  messages: readonly LocalChatMessage[]
): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  for (const message of messages) {
    for (const block of blocksForLocalMessage(message)) {
      blocks.push(block);
    }
  }
  return blocks;
}

export default buildLocalTimeline;
