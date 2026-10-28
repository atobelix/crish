/**
 * 调用目的：默认合上，不挂 Action DOM；展开才按需挂载。
 * 人话主文案为前端派生（explanation 归一 / humanize）。
 */
import { useState, type ReactElement } from 'react';
import type { PurposeNode } from '@crish/conversation-flow';
import { Button } from '@/components/ui';
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
  if (status === 'running')
    return [count, '进行中'].filter(Boolean).join(' · ');
  if (status === 'error')
    return [count, '未完全成功'].filter(Boolean).join(' · ');
  if (status === 'partial')
    return [count, '部分完成'].filter(Boolean).join(' · ');
  return count;
}

export function PurposeBlock({
  purpose,
  toolsById,
  agents,
  parentSessionId,
  onOpenPath,
  onOpenNote,
  // 运行中的目的需要把正在发生的动作直接露出来；终态仍保持摘要行，
  // 用户可以按需展开历史步骤。这与 DeepSeek harness 的 streaming flow 一致。
  defaultOpen = purpose.status === 'running',
}: PurposeBlockProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const n = purpose.actions.length;
  const meta = purposeMeta(purpose.status, n);

  return (
    <div
      className={styles.purpose}
      data-flow-purpose={purpose.id}
      data-purpose-count={n}
      data-purpose-status={purpose.status}
      data-derived="frontend"
      data-flow-expanded={open ? 'true' : 'false'}
      role="group"
      aria-label={purpose.primary}
    >
      <Button
        variant="ghost"
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
      </Button>
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
