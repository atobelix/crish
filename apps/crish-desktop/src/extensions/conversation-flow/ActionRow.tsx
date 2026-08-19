/**
 * 折叠动作行：合上只挂摘要；展开才挂命令 / output pre。
 * 人话走 tool-presentation；成功态无绿勾。
 */
import { useState, type ReactElement } from 'react';
import {
  deriveArtifactFromTool,
  type ActionNode,
} from '@crish/conversation-flow';
import { extractToolCommand } from '../../api/tool-presentation/toolArgsNormalizer';
import { toolHumanLabel } from '../../api/tool-presentation/toolHumanDescriptions';
import { fullToolOutput } from '../../api/tool-presentation/toolOutputSanitizer';
import type { MessageToolCall } from '../../store/types';
import { TOOL_OUTPUT_DOM_CHAR_CAP, TOOL_OUTPUT_PIXEL_CAP } from '../../workers';
import { ArtifactChip } from './ArtifactChip';
import { actionPathOf } from './narrativeModel';
import styles from './narrative.module.css';

export interface ActionRowProps {
  action: ActionNode;
  tool?: MessageToolCall;
  onOpenPath?: (filePath: string) => void;
  onOpenNote?: (docId: string) => void;
  defaultOpen?: boolean;
}

function capOutput(raw: string): string {
  if (raw.length <= TOOL_OUTPUT_DOM_CHAR_CAP) return raw;
  return `${raw.slice(0, TOOL_OUTPUT_DOM_CHAR_CAP)}\n…`;
}

function statusMeta(status: ActionNode['status']): string {
  if (status === 'running') return '进行中';
  if (status === 'error') return '失败';
  if (status === 'pending_approval') return '待确认';
  return '';
}

export function ActionRow({
  action,
  tool,
  onOpenPath,
  onOpenNote,
  defaultOpen = false,
}: ActionRowProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const path = actionPathOf(action, tool);
  const artifact = deriveArtifactFromTool({
    id: action.id,
    name: tool?.name || action.toolName,
    arguments:
      tool?.arguments ??
      (action.path ? JSON.stringify({ path: action.path }) : undefined),
    status: action.status,
    output: tool?.output ?? action.output,
  });
  const command =
    action.command ||
    (tool?.arguments ? extractToolCommand(tool.arguments) : '');
  const rawOutput = tool?.output ?? action.output ?? '';
  const output = capOutput(fullToolOutput(rawOutput));
  const expandable =
    action.expandable || Boolean(command) || Boolean(output);
  const human = tool
    ? toolHumanLabel(tool)
    : [action.verb, action.objectLabel].filter(Boolean).join(' · ');
  const kindPrefix =
    action.kind === 'skill' ? 'Skill' : action.kind === 'mcp' ? 'MCP' : '';
  const meta = [
    statusMeta(action.status),
    action.parallelGroupId ? '并行' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const outputMax = {
    ['--flow-output-max' as string]: `${TOOL_OUTPUT_PIXEL_CAP}px`,
    maxHeight: TOOL_OUTPUT_PIXEL_CAP,
  };

  return (
    <div
      className={styles.action}
      data-flow-action={action.id}
      data-flow-action-kind={action.kind}
      data-derived="frontend"
      data-flow-expanded={open ? 'true' : 'false'}
    >
      <div className={styles.actionHeadRow}>
        <button
          type="button"
          className={`${styles.head}${expandable ? '' : ` ${styles.headStatic}`}`}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          onClick={() => {
            if (expandable) setOpen((v) => !v);
          }}
        >
          {action.status === 'running' ? (
            <span className={styles.pulse} aria-hidden />
          ) : null}
          {kindPrefix ? (
            <span className={styles.kindPrefix}>{kindPrefix}</span>
          ) : null}
          <span className={styles.primary}>{human || action.verb}</span>
          {meta ? <span className={styles.meta}>{meta}</span> : null}
        </button>
        {path && !artifact && onOpenPath ? (
          <button
            type="button"
            className={styles.pathBtn}
            data-flow-path="code"
            onClick={(e) => {
              e.stopPropagation();
              onOpenPath(path);
            }}
          >
            {path.split(/[/\\]/).pop() || path}
          </button>
        ) : null}
        {artifact ? (
          <ArtifactChip
            label={artifact.title}
            path={artifact.path}
            content={artifact.content}
            docId={artifact.docId}
            mime={artifact.mime}
            derived={artifact.derived}
            onOpenNote={onOpenNote}
          />
        ) : null}
      </div>
      {open && expandable ? (
        <div className={styles.detail} style={outputMax}>
          {command ? (
            <pre className={styles.pre} data-flow-action-command="">
              {command}
            </pre>
          ) : null}
          {output ? (
            <pre className={styles.pre} data-flow-action-output="">
              {output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
