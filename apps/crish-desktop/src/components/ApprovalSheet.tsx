/**
 * 简洁审批条：无描边卡片感，贴在输入区上方，不抢焦点。
 */

import React from 'react';
import { extractToolCommand, toolSummaryLabel } from '../api/toolPresentation';

export type ApprovalSheetTool = {
  id: string;
  name: string;
  arguments?: string;
  explanation?: string;
};

type Props = {
  tool: ApprovalSheetTool;
  busy?: boolean;
  queueRemaining?: number;
  onAllow: () => void;
  onDeny: () => void;
  /** 允许并加入命令白名单（可选，正式版增强） */
  onAllowAndRemember?: () => void;
  variant?: 'inline' | 'sticky';
};

function formatCommand(tool: ApprovalSheetTool): string {
  const raw = (tool.arguments || '').trim();
  const extracted = extractToolCommand(raw);
  if (extracted && extracted !== '{}' && !extracted.startsWith('{"id"')) return extracted;
  const exp = (tool.explanation || '').trim();
  if (exp && !exp.startsWith('{') && exp !== '需要确认') return exp;
  if (raw && !raw.startsWith('{"id"') && !raw.includes('"sessionId"')) return raw;
  return '';
}

export const ApprovalSheet: React.FC<Props> = ({
  tool,
  busy,
  queueRemaining = 0,
  onAllow,
  onDeny,
  onAllowAndRemember,
  variant = 'inline',
}) => {
  const summary = toolSummaryLabel({
    id: tool.id,
    name: tool.name,
    arguments: tool.arguments || '',
    explanation: tool.explanation,
    status: 'pending_approval',
  });
  const command = formatCommand(tool);
  const showCmd = command && command !== summary && !summary.includes(command);

  return (
    <div
      className={`inline-approval ${variant === 'sticky' ? 'inline-approval--sticky' : ''}`}
      data-tool-id={tool.id}
      role="region"
      aria-label="等待确认"
    >
      <div className="inline-approval-main">
        <span className="inline-approval-kicker">需确认</span>
        <span className="inline-approval-summary">{summary || '申请执行操作'}</span>
        {queueRemaining > 0 && (
          <span className="inline-approval-queue">+{queueRemaining}</span>
        )}
      </div>
      {showCmd ? <div className="inline-approval-cmd">{command}</div> : null}
      <div className="inline-approval-foot">
        <button
          type="button"
          className="inline-approval-btn deny"
          disabled={busy}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDeny();
          }}
        >
          拒绝
        </button>
        {onAllowAndRemember ? (
          <button
            type="button"
            className="inline-approval-btn allow-remember"
            disabled={busy}
            title="允许并将此前缀加入白名单，下次同类命令自动放行"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onAllowAndRemember();
            }}
          >
            {busy ? '…' : '允许并记住'}
          </button>
        ) : null}
        <button
          type="button"
          className="inline-approval-btn allow"
          disabled={busy}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAllow();
          }}
        >
          {busy ? '…' : '允许'}
        </button>
      </div>
    </div>
  );
};
