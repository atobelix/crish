/**
 * renderTools / renderThought 汇合：投影节点驱动 Purpose / Thinking。
 * 人话注入 desktop tool-presentation；pending 上提 composer 冷静条。
 */
import { type ReactNode } from 'react';
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
import { tryOpenExistingNoteForArtifact } from './artifactNoteOpen';
import { PurposeBlock } from './PurposeBlock';
import { ThinkingBlock } from './ThinkingBlock';
import {
  collectToolIds,
  purposesForSlice,
  toolsByIdFromCalls,
} from './narrativeModel';
import styles from './narrative.module.css';

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
  const sliceIds = collectToolIds(items);
  const visible =
    msg && msg.sender === 'assistant'
      ? purposesForSlice(purposesOf(msg), sliceIds)
      : [];
  const toolsById = toolsByIdFromCalls(msg?.toolCalls);
  const onOpenPath = toolStackProps.actions?.onOpenPath;
  const onOpenNote = (docId: string): void => {
    tryOpenExistingNoteForArtifact({
      sessionId: toolStackProps.activeSessionId ?? '',
      docId,
      openTool: (sid, panelId) => {
        void import('../../store/workspace-shell/openTool').then((m) => {
          m.openToolInSession(sid, panelId);
        });
      },
    });
  };

  if (visible.length === 0) return null;

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
          onOpenNote={onOpenNote}
        />
      ))}
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
