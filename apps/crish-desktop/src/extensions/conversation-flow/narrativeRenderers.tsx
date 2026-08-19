/**
 * renderTools / renderThought 汇合：投影节点驱动 Purpose / Thinking。
 * 人话注入 desktop tool-presentation；pending 仍走扁平行审批卡。
 */
import { lazy, Suspense, type ReactNode } from 'react';
import {
  projectMessage,
  type HumanizeHooks,
  type PurposeNode,
} from '@crish/conversation-flow';
import { toolHumanLabel } from '../../api/tool-presentation/toolHumanDescriptions';
import type {
  ChatNarrativeRenderThought,
  ChatNarrativeRenderThoughtArgs,
  ChatNarrativeRenderTools,
  ChatNarrativeRenderToolsArgs,
} from '../../components/chat-message-list/chatMessageListProps';
import type { SessionMessage } from '../../store/types';
import { PurposeBlock } from './PurposeBlock';
import { ThinkingBlock } from './ThinkingBlock';
import {
  collectToolIds,
  extractPendingItems,
  purposesForSlice,
  toolsByIdFromCalls,
} from './narrativeModel';
import styles from './narrative.module.css';

const MessageToolCallsSection = lazy(async () => {
  const m = await import(
    '../../components/chat-message-row/MessageToolCallsSection'
  );
  return { default: m.MessageToolCallsSection };
});

/** 权威人话：调用现 tool-presentation，禁止再抄一份规则 */
const DESKTOP_HUMANIZE: HumanizeHooks = {
  label: (tc) =>
    toolHumanLabel({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      status: tc.status,
      output: tc.output,
      explanation: tc.explanation,
    }),
};

function purposesOf(msg: SessionMessage): PurposeNode[] {
  if (msg.sender !== 'assistant') return [];
  const { nodes } = projectMessage(msg, { humanize: DESKTOP_HUMANIZE });
  return nodes.filter((n): n is PurposeNode => n.kind === 'purpose');
}

export function renderNarrativeThought(
  args: ChatNarrativeRenderThoughtArgs
): ReactNode {
  return (
    <ThinkingBlock
      content={args.content}
      isLive={args.isLive}
      durationMs={args.durationMs}
      messageId={args.messageId}
      turnIndex={args.turnIndex}
    />
  );
}

export function renderNarrativeTools(
  args: ChatNarrativeRenderToolsArgs & { messages: SessionMessage[] }
): ReactNode {
  const { items, msgId, toolStackProps, messages } = args;
  const msg = messages.find((m) => m.id === msgId);
  const pending = extractPendingItems(items);
  const sliceIds = collectToolIds(items);
  const visible =
    msg && msg.sender === 'assistant'
      ? purposesForSlice(purposesOf(msg), sliceIds)
      : [];
  const toolsById = toolsByIdFromCalls(msg?.toolCalls);
  const onOpenPath = toolStackProps.actions?.onOpenPath;

  if (visible.length === 0 && pending.length === 0) return null;

  return (
    <div className={styles.stack} data-flow-tools="">
      {visible.map((purpose) => (
        <PurposeBlock
          key={purpose.id}
          purpose={purpose}
          toolsById={toolsById}
          agents={toolStackProps.agents}
          parentSessionId={toolStackProps.activeSessionId}
          onOpenPath={onOpenPath}
        />
      ))}
      {pending.length > 0 ? (
        <Suspense fallback={null}>
          <MessageToolCallsSection
            items={pending}
            msgId={msgId}
            toolStackProps={toolStackProps}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

export function createNarrativeRenderers(messages: SessionMessage[]): {
  renderTools: ChatNarrativeRenderTools;
  renderThought: ChatNarrativeRenderThought;
} {
  return {
    renderTools: (args) => renderNarrativeTools({ ...args, messages }),
    renderThought: renderNarrativeThought,
  };
}
