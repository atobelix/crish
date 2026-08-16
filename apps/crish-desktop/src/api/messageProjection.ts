/**
 * 事件 → SessionMessage 投影纯函数（T3：前端消息类型单源化 · S3）。
 *
 * 类型权威：generated `AgentMessage` / `AgentMessageBlock` 是唯一事件块来源；
 * 前端 `SessionMessage` / `MessageTimelineBlock` 是「从 generated 派生的投影装饰」。
 * 本模块提供两端（live `onMessageEnd` 与 replay `projectEventsToMessages`）
 * 共用的投影原语，杜绝各写一套：
 *
 * - `projectAgentMessageContent`   —— AgentMessage → { text, thought }（text/thought 块归一）；
 * - `agentBlockToTimelineBlock`    —— AgentMessageBlock → MessageTimelineBlock（text/thought/tool_call 投影装饰）；
 * - `timelineBlockToAgentBlock`    —— MessageTimelineBlock → AgentMessageBlock（可逆映射；image/step_* 前端块返回 null）；
 * - `projectAgentMessageToSessionMessage` —— 单条 AgentMessage → SessionMessage 投影入口。
 *
 * 语义约定：
 * - image / step_start / step_end 是前端专有块，不冒充事件块；generated 四块
 *   （text/thought/tool-call/tool-result）是唯一事件块权威；
 * - 前端展示层继续消费既有 `content` 字段（保持 50 文件引用面不变），
 *   generated 的 `text` 一并归一，不强行改展示层字段名。
 */
import type {
  AgentMessage,
  AgentMessageBlock,
} from '../../../../packages/shared-types/src/generated/engine';
import type {
  MessageTimelineBlock,
  MessageSender,
  SessionMessage,
} from '../store/types';
import { blockText } from './chat-bridge/handlers/eventUtils';

/**
 * AgentMessage → { text, thought }。
 * - text：从 text 块拼接；无 text 块时回退 `content`。
 * - thought：从 thought 块拼接。
 */
export function projectAgentMessageContent(agent: {
  blocks?: AgentMessageBlock[];
  content?: string;
}): { text: string; thought: string } {
  const blocks = Array.isArray(agent.blocks) ? agent.blocks : [];
  let text = '';
  let thought = '';
  for (const bl of blocks) {
    const b = bl as unknown as Record<string, unknown>;
    if (b.type === 'thought' || b.kind === 'thought') thought += blockText(b);
    else if (b.type === 'text') text += blockText(b);
  }
  text = text.trim();
  thought = thought.trim();
  if (!text && typeof agent.content === 'string' && agent.content) {
    text = agent.content.trim();
  }
  return { text, thought };
}

/**
 * generated 事件块 → 前端时间线投影装饰块（text/thought/tool_call 子集）。
 * image / step_start / step_end 无事件块等价物，不由本函数合成。
 */
export function agentBlockToTimelineBlock(
  block: AgentMessageBlock
): MessageTimelineBlock {
  switch (block.type) {
    case 'thought':
      return {
        type: 'thought',
        content: block.text,
        ...(block.redacted === true ? { redacted: true } : {}),
      };
    case 'tool-call':
      return { type: 'tool_call', id: block.id };
    case 'tool-result':
      // 事件块 tool-result 没有独立前端展示块；投影为 tool_call 锚点（无 id 不生成）
      return { type: 'tool_call', id: block.toolCallId };
    case 'text':
    default:
      return { type: 'text', content: block.text };
  }
}

/**
 * 前端时间线块 → generated 事件块（可逆映射，单点）。
 * image / step_start / step_end 是前端投影装饰、无事件块等价物 → 返回 null。
 */
export function timelineBlockToAgentBlock(
  block: MessageTimelineBlock
): AgentMessageBlock | null {
  switch (block.type) {
    case 'thought':
      return { type: 'thought', text: block.content ?? '' };
    case 'tool_call': {
      if (!block.id) return null;
      return {
        type: 'tool-call',
        id: block.id,
        toolName: '',
        input: {},
      };
    }
    case 'text':
      return { type: 'text', text: block.content ?? '' };
    case 'image':
    case 'step_start':
    case 'step_end':
      // 前端专有块，无事件块等价物
      return null;
  }
}

function parseTimestamp(ts: number | string | undefined): number {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string') {
    const t = Date.parse(ts);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

/**
 * 单条 generated AgentMessage → SessionMessage 投影入口。
 * 仅投影 id/sender/text/thinking/blocks/timestamp 等「事件派生」字段；
 * 生命周期/审批/工具行等前端专有超集字段由更高层初始化。
 *
 * @param agent  generated AgentMessage（engine message-end 载荷 / 其它事件投影共享）
 * @param opts   timestamp 覆盖（replay 用事件 timestamp；缺席时回退 createdAt）
 */
export function projectAgentMessageToSessionMessage(
  agent: AgentMessage,
  opts?: { timestamp?: number; id?: string; sender?: MessageSender }
): SessionMessage {
  const { text, thought } = projectAgentMessageContent(agent);
  const sender: MessageSender =
    opts?.sender ??
    (agent.role === 'user' || agent.role === 'assistant'
      ? agent.role
      : 'assistant');
  const blocks: MessageTimelineBlock[] = (
    Array.isArray(agent.blocks) ? agent.blocks : []
  ).map(agentBlockToTimelineBlock);
  const result: SessionMessage = {
    id: opts?.id ?? agent.id,
    sender,
    ...(text ? { text } : {}),
    ...(thought ? { thinking: thought } : {}),
    timestamp: parseTimestamp(opts?.timestamp ?? agent.createdAt),
    status: 'completed',
  };
  if (blocks.length > 0) result.blocks = blocks;
  if (agent.clientMessageId) result.clientMessageId = agent.clientMessageId;
  if (agent.metadata) result.metadata = agent.metadata;
  return result;
}
