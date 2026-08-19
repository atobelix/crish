/**
 * 调用目的：默认合上，不挂 Action DOM；展开才按需挂载。
 * 人话主文案为前端派生（explanation 归一 / humanize）。
 */
import { useState, type ReactElement } from 'react';
import type { PurposeNode } from '@crish/conversation-flow';
import { findAgentForTool } from '../../components/chat-tool-call/chatToolCallUtils';
import type { MessageToolCall, SessionAgent } from '../../store/types';
import { ActionRow } from './ActionRow';
import { SubagentBlock } from './SubagentBlock';
import styles from './narrative.module.css';

export interface PurposeBlockProps {
  purpose: PurposeNode;
  toolsById: Map<string, MessageToolCall>;
  agents?: SessionAgent[];
  parentSessionId?: string;
  onOpenPath?: (filePath: string) => void;
  onOpenNote?: (docId: string) => void;
  defaultOpen?: boolean;
}

function purposeMeta(status: PurposeNode['status'], n: number): string {
  const count = n > 1 ? `${n} 步` : '';
  if (status === 'running') return [count, '进行中'].filter(Boolean).join(' · ');
  if (status === 'error') return [count, '未完全成功'].filter(Boolean).join(' · ');
  if (status === 'partial') return [count, '部分完成'].filter(Boolean).join(' · ');
  return count;
}

export function PurposeBlock({
  purpose,
  toolsById,
  agents,
  parentSessionId,
  onOpenPath,
  onOpenNote,
  defaultOpen = false,
}: PurposeBlockProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const n = purpose.actions.length;
  const meta = purposeMeta(purpose.status, n);

  return (
    <div
      className={styles.purpose}
      data-flow-purpose={purpose.id}
      data-purpose-count={n}
      data-derived="frontend"
      data-flow-expanded={open ? 'true' : 'false'}
      role="group"
      aria-label={purpose.primary}
    >
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {purpose.status === 'running' ? (
          <span className={styles.pulse} aria-hidden />
        ) : null}
        <span className={styles.primary}>{purpose.primary}</span>
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </button>
      {open
        ? purpose.actions.map((action) => {
            const tool = toolsById.get(action.id);
            const agent = tool ? findAgentForTool(tool, agents) : null;
            if (agent && parentSessionId) {
              return (
                <div key={action.id} className={styles.actions}>
                  <SubagentBlock
                    agent={agent}
                    parentSessionId={parentSessionId}
                    action={action}
                  />
                </div>
              );
            }
            return (
              <div key={action.id} className={styles.actions}>
                <ActionRow
                  action={action}
                  tool={tool}
                  onOpenPath={onOpenPath}
                  onOpenNote={onOpenNote}
                />
              </div>
            );
          })
        : null}
    </div>
  );
}
