/**
 * 把一条 SessionMessage 结构编成叙事树。
 * 只吃产品已有字段（text / thinking / toolCalls）；不解析演示仓预整形 purpose/plan 块。
 */

import { clip } from './humanize';
import { extractPendingApprovals } from './extractPendingApprovals';
import { projectPurposes } from './projectPurposes';
import type {
  FlowNode,
  ProjectMessageInput,
  ProjectMessageResult,
  ProjectOptions,
  TextNode,
  ThinkingNode,
} from './types';

function hasText(text: string | undefined): text is string {
  return Boolean(text && text.trim());
}

function userBubble(msg: ProjectMessageInput): TextNode {
  return {
    kind: 'text',
    id: msg.id,
    content: msg.text ?? '',
    tone: 'primary',
  };
}

/**
 * 助手侧：thinking → Purpose* → text。
 * 用户侧：显式单气泡 text，绝不投影 toolCalls / Purpose。
 */
export function projectMessage(
  msg: ProjectMessageInput | null | undefined,
  options?: ProjectOptions,
): ProjectMessageResult {
  if (!msg) return { nodes: [], pendingApprovals: [] };

  if (msg.sender === 'user') {
    return {
      nodes: [userBubble(msg)],
      pendingApprovals: [],
    };
  }

  const pendingApprovals = extractPendingApprovals(
    msg.toolCalls,
    options?.humanize,
  );
  const nodes: FlowNode[] = [];

  if (hasText(msg.thinking)) {
    const thinking: ThinkingNode = {
      kind: 'thinking',
      id: `${msg.id}-think`,
      preview: clip(msg.thinking, 48),
      content: msg.thinking,
    };
    nodes.push(thinking);
  }

  const purposes = projectPurposes(msg.toolCalls, options);
  for (const p of purposes) nodes.push(p);

  if (hasText(msg.text)) {
    const text: TextNode = {
      kind: 'text',
      id: `${msg.id}-text`,
      content: msg.text,
      tone: 'primary',
    };
    nodes.push(text);
  }

  return { nodes, pendingApprovals };
}
