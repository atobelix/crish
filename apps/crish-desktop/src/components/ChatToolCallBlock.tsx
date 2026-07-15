/**
 * 工具行 / 工具组渲染：从 ChatCard 剪切粘贴，保持 className 与交互不变。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import type { FileDiff, MessageToolCall, SessionAgent } from '../store/layoutStore';
import { ApprovalAskCard } from './ApprovalAskCard';
import { InlineAgentPanel } from './InlineAgentPanel';
import { isEditToolName, isShellToolName } from '../api/toolFeedback';
import {
  extractImageRefs,
  extractToolCommand,
  fullToolOutput,
  toolCommandPreview,
  toolHasDisplayableResult,
  toolHumanLabel,
  toolPathDisplayName,
  type ToolRenderItem,
} from '../api/toolPresentation';
import { extractFilePathFromToolArgs } from '../api/workspaceFsApi';

export interface ChatToolStackProps {
  items: ToolRenderItem[];
  msgId?: string;
  /** 本轮折叠态 key（通常 msgId）；缺省则不启用轮次折叠 */
  roundKey?: string;
  agents: SessionAgent[];
  activeSessionId: string;
  expandedTools: Record<string, boolean>;
  onToggleTool: (toolId: string, currentlyOpen: boolean) => void;
  /** 本轮工具组展开态（true=展开全部）；按 session 在 ChatMessageList 持久化 */
  expandedRounds?: Record<string, boolean>;
  onToggleRound?: (roundKey: string, currentlyOpen: boolean) => void;
  approvalBusy: boolean;
  pendingApprovalMsgId: string;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenPath: (filePath: string) => void;
  onOpenTerminal: () => void;
  onApprovalAllow: (toolId: string, msgId: string, remember?: boolean) => void;
  onApprovalDeny: (toolId: string, msgId: string) => void;
  onShowToast: (message: string) => void;
}

/** 展平 single / group 得到本轮全部工具调用 */
function flattenToolItems(items: ToolRenderItem[]): MessageToolCall[] {
  const out: MessageToolCall[] = [];
  for (const item of items) {
    if (item.kind === 'single') out.push(item.tc);
    else out.push(...item.tools);
  }
  return out;
}

/** 折叠时仅保留 running / pending_approval，避免藏审批与进行中 */
function filterLiveToolItems(items: ToolRenderItem[]): ToolRenderItem[] {
  const out: ToolRenderItem[] = [];
  for (const item of items) {
    if (item.kind === 'single') {
      if (item.tc.status === 'running' || item.tc.status === 'pending_approval') {
        out.push(item);
      }
      continue;
    }
    const live = item.tools.filter(
      (t) => t.status === 'running' || t.status === 'pending_approval',
    );
    if (live.length === 0) continue;
    if (live.length === 1) out.push({ kind: 'single', tc: live[0] });
    else out.push({ ...item, tools: live });
  }
  return out;
}

function buildRoundSummary(tools: MessageToolCall[]): string {
  const n = tools.length;
  let done = 0;
  let fail = 0;
  let pending = 0;
  let running = 0;
  for (const t of tools) {
    if (t.status === 'success') done += 1;
    else if (t.status === 'error') fail += 1;
    else if (t.status === 'pending_approval') pending += 1;
    else if (t.status === 'running') running += 1;
  }
  const parts = [`本轮 ${n} 个工具`, `完成 ${done}`, `失败 ${fail}`, `待批 ${pending}`];
  if (running > 0) parts.push(`进行中 ${running}`);
  return parts.join(' · ');
}

/** 默认折叠长输出，避免主对话刷屏；错误可默认展开；长结果永不默认撑开 */
function shouldDefaultOpenTool(tc: {
  status?: string;
  output?: string;
  diffs?: FileDiff[];
}) {
  if (tc.status === 'running') return false;
  if (tc.status === 'pending_approval') return false;
  if (tc.status === 'error') {
    const o = (tc.output || '').trim();
    return o.length > 0 && o.length < 200;
  }
  if (tc.diffs && tc.diffs.length > 0) return false; // diff 摘要行即可，完整看右侧
  const raw = (tc.output || '').trim();
  if (!raw || /^(执行中|运行中)…?$/.test(raw)) return false;
  const lines = raw.split('\n').filter((l) => l.trim());
  // 更克制：只有极短结果才默认展开
  return lines.length <= 3 && raw.length <= 240;
}

function findAgentForTool(
  tc: { id?: string; name?: string; explanation?: string },
  agents: SessionAgent[],
) {
  if (!agents.length) return null;
  const byTool = agents.find((a) => a.parentToolCallId && a.parentToolCallId === tc.id);
  if (byTool) return byTool;
  const n = (tc.name || '').toLowerCase();
  if (n.includes('subagent') || n === 'run_subagent') {
    const exp = (tc.explanation || '').trim();
    const byDesc = exp
      ? agents.find((a) => a.description && exp.includes(a.description.slice(0, 24)))
      : null;
    if (byDesc) return byDesc;
    return agents[0] || null;
  }
  return null;
}

function renderGitDiff(diff: FileDiff, onOpenDiff: (diff: FileDiff) => void) {
  return (
    <div className="git-diff-card" key={diff.filePath}>
      <div className="git-diff-card-header" onClick={() => onOpenDiff(diff)}>
        <div className="git-diff-file-info">
          <Lucide.FileCode size={16} style={{ color: 'var(--accent-color)' }} />
          <span className="git-diff-filename">{diff.filePath}</span>
          <span className="git-diff-preview-tag">在右侧查看</span>
        </div>
        <div className="git-diff-badge">
          <span className="git-diff-add">+{diff.additions}</span>
          <span className="git-diff-del">-{diff.deletions}</span>
        </div>
      </div>
      <div className="git-diff-lines-container">
        {diff.changes.slice(0, 8).map((change, i) => (
          <div key={i} className={`git-diff-line-row ${change.type}`}>
            <div className="line-num-col">
              {change.type === 'addition' ? '+' : change.type === 'deletion' ? '-' : ' '}
            </div>
            <pre className="line-content">{change.content}</pre>
          </div>
        ))}
        {diff.changes.length > 8 && (
          <div className="git-diff-more-indicator" onClick={() => onOpenDiff(diff)}>
            还有 {diff.changes.length - 8} 行 · 点击在右侧查看完整 diff
          </div>
        )}
      </div>
    </div>
  );
}

function renderToolResultBody(
  tc: {
    output?: string;
    diffs?: FileDiff[];
    name?: string;
    status?: string;
    arguments?: string;
  },
  onOpenDiff: (diff: FileDiff) => void,
  onOpenTerminal: () => void,
) {
  const images = extractImageRefs(tc.output || '');
  const raw = tc.output || '';
  const out = fullToolOutput(raw);
  const hasDiffs = Boolean(tc.diffs && tc.diffs.length);
  const shellTool = isShellToolName(tc.name || '');
  const longShell = shellTool && (raw.length > 2000 || raw.split('\n').length > 80);
  if (!out && images.length === 0 && !hasDiffs) {
    if (tc.status === 'success') {
      return (
        <div className="tool-result-body">
          <pre className="tool-result-pre">完成</pre>
        </div>
      );
    }
    if (tc.status === 'error') {
      return (
        <div className="tool-result-body">
          <pre className="tool-result-pre">失败</pre>
        </div>
      );
    }
    return null;
  }
  return (
    <div className="tool-result-body">
      {out ? <pre className="tool-result-pre">{out}</pre> : null}
      {longShell ? (
        <div className="tool-result-long-hint">
          <button
            type="button"
            className="tool-result-hint-btn"
            onClick={(e) => {
              e.stopPropagation();
              onOpenTerminal();
            }}
          >
            在终端查看
          </button>
        </div>
      ) : null}
      {images.length > 0 && (
        <div className="tool-result-images">
          {images.map((src) => (
            <img key={src} src={src} alt="" className="tool-result-img" loading="lazy" />
          ))}
        </div>
      )}
      {tc.diffs?.map((d) => renderGitDiff(d, onOpenDiff))}
    </div>
  );
}

/**
 * 工具行分层：
 * - 摘要（灰）：人读意图
 * - 命令（等宽更浅）：真实命令/路径
 * - 展开体：仅清洗后的结果输出
 * - 待确认：行内可批，不依赖底部 sticky
 */
function CompactToolRow({
  tc,
  rowKey,
  msgId,
  props,
}: {
  tc: MessageToolCall;
  rowKey: string | number;
  msgId?: string;
  props: ChatToolStackProps;
}) {
  const {
    agents,
    activeSessionId,
    expandedTools,
    onToggleTool,
    approvalBusy,
    pendingApprovalMsgId,
    onOpenDiff,
    onOpenPath,
    onOpenTerminal,
    onApprovalAllow,
    onApprovalDeny,
    onShowToast,
  } = props;

  // 审批优先：勿被 linked agent 分支吞掉 pending_approval
  if (tc.status === 'pending_approval') {
    const summary = toolHumanLabel(tc);
    const techFull = extractToolCommand(tc.arguments || '');
    const tech = techFull && techFull !== summary ? techFull : toolCommandPreview(tc, 72);
    const mid = msgId || pendingApprovalMsgId;
    return (
      <ApprovalAskCard
        key={rowKey}
        msgId={mid}
        toolId={tc.id}
        summary={summary}
        cmd={tech && tech !== summary ? tech : techFull || undefined}
        busy={approvalBusy}
        onAllow={(note) => {
          if (note.trim()) {
            onShowToast(`备注：${note.trim().slice(0, 80)}`);
          }
          onApprovalAllow(tc.id, mid, false);
        }}
        onAllowRemember={(note) => {
          if (note.trim()) onShowToast(`备注：${note.trim().slice(0, 80)}`);
          onApprovalAllow(tc.id, mid, true);
        }}
        onDeny={() => onApprovalDeny(tc.id, mid)}
      />
    );
  }
  const linkedAgent = findAgentForTool(tc, agents);
  if (linkedAgent && activeSessionId) {
    return (
      <InlineAgentPanel
        key={String(rowKey)}
        agent={linkedAgent}
        parentSessionId={activeSessionId}
        defaultOpen={tc.status === 'running' || linkedAgent.status === 'running'}
      />
    );
  }
  const body = renderToolResultBody(tc, onOpenDiff, onOpenTerminal);
  const hasResult = toolHasDisplayableResult(tc);
  const defaultOpen = shouldDefaultOpenTool(tc);
  const isOpen = Object.prototype.hasOwnProperty.call(expandedTools, tc.id)
    ? expandedTools[tc.id]
    : defaultOpen;
  const human = toolHumanLabel(tc);
  const techFull = extractToolCommand(tc.arguments || '');
  const cmd = toolCommandPreview(tc, 72);
  const running = tc.status === 'running';
  const canToggle = Boolean(body) || hasResult;
  const filePath = extractFilePathFromToolArgs(tc.arguments || '');
  const n = (tc.name || '').toLowerCase();
  const pathClickable =
    Boolean(filePath) &&
    (isEditToolName(n) ||
      n.includes('read') ||
      n.includes('write') ||
      n.includes('edit') ||
      n.includes('glob'));
  const pathLabel = filePath ? toolPathDisplayName(filePath) : '';
  const pathActions =
    pathClickable && filePath ? (
      <span className="tool-path-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="tool-path-action"
          title="在文件面板打开"
          onClick={() => onOpenPath(filePath)}
        >
          <Lucide.PanelRightOpen size={14} />
        </button>
        <button
          type="button"
          className="tool-path-action"
          title="复制路径"
          onClick={() => {
            void navigator.clipboard.writeText(filePath).then(
              () => onShowToast('路径已复制'),
              () => onShowToast(filePath),
            );
          }}
        >
          <Lucide.Copy size={14} />
        </button>
      </span>
    ) : null;

  /** 主行：人话说明；路径名可点 */
  const renderSummary = () => {
    if (!pathClickable || !filePath || !pathLabel || !human.includes(pathLabel)) {
      return (
        <span className="tool-row-summary" title={human}>
          {human}
          {pathClickable && filePath && pathActions ? (
            <span className="tool-path-wrap" style={{ marginLeft: 6 }}>
              {pathActions}
            </span>
          ) : null}
        </span>
      );
    }
    const idx = human.lastIndexOf(pathLabel);
    const link = (
      <span className="tool-path-wrap">
        <button
          type="button"
          className="tool-path-link"
          title={filePath}
          onClick={(e) => {
            e.stopPropagation();
            onOpenPath(filePath);
          }}
        >
          {pathLabel}
        </button>
        {pathActions}
      </span>
    );
    if (idx < 0) {
      return (
        <span className="tool-row-summary" title={filePath}>
          {human} {link}
        </span>
      );
    }
    return (
      <span className="tool-row-summary" title={filePath}>
        {human.slice(0, idx)}
        {link}
        {human.slice(idx + pathLabel.length)}
      </span>
    );
  };
  const toolIcon = (() => {
    const name = (tc.name || '').toLowerCase();
    const cls = 'tool-row-type-ico';
    const sz = 15;
    if (running) {
      return (
        <span className="tool-row-live" aria-hidden>
          <span className="loading-spinner" style={{ width: 8, height: 8, borderWidth: 1.5 }} />
        </span>
      );
    }
    if (isShellToolName(name) || name.includes('bash') || name.includes('shell') || name.includes('exec')) {
      return <Lucide.Terminal className={`${cls} ico-shell`} size={sz} strokeWidth={1.75} />;
    }
    if (name.includes('grep') || name.includes('search') || name.includes('find')) {
      return <Lucide.Search className={`${cls} ico-search`} size={sz} strokeWidth={1.75} />;
    }
    if (name.includes('read') || name.includes('cat') || name.includes('view')) {
      return <Lucide.FileText className={`${cls} ico-read`} size={sz} strokeWidth={1.75} />;
    }
    if (isEditToolName(name) || name.includes('write') || name.includes('edit') || name.includes('patch')) {
      return <Lucide.Pencil className={`${cls} ico-edit`} size={sz} strokeWidth={1.75} />;
    }
    if (name.includes('list') || name.includes('glob') || name.includes('dir')) {
      return <Lucide.FolderTree className={`${cls} ico-list`} size={sz} strokeWidth={1.75} />;
    }
    if (name.includes('web') || name.includes('fetch') || name.includes('http')) {
      return <Lucide.Globe className={`${cls} ico-web`} size={sz} strokeWidth={1.75} />;
    }
    return <Lucide.CircleDot className={`${cls} ico-default`} size={sz} strokeWidth={1.75} />;
  })();

  return (
    <div
      className={`tool-row ${isOpen ? 'is-open' : ''} ${tc.status === 'error' ? 'is-error' : ''}`}
      key={rowKey}
    >
      {/* 用 div 而非 button，避免路径操作按钮嵌套 button 报错 */}
      <div
        className="tool-row-head"
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
        onClick={() => canToggle && onToggleTool(tc.id, isOpen)}
        onKeyDown={(e) => {
          if (!canToggle) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleTool(tc.id, isOpen);
          }
        }}
      >
        <span className="tool-row-head-main">
          {toolIcon}
          <span className="tool-row-text">
            {renderSummary()}
            {cmd ? (
              <code className="tool-row-cmd" title={techFull || cmd}>
                {cmd}
              </code>
            ) : null}
          </span>
        </span>
        <span className={`tool-row-chevron-slot ${canToggle ? 'is-toggle' : ''}`}>
          {canToggle ? (
            <Lucide.ChevronRight size={14} className={`tool-row-chevron ${isOpen ? 'rot' : ''}`} />
          ) : null}
        </span>
      </div>
      {isOpen && body}
    </div>
  );
}

function renderToolStackItems(
  items: ToolRenderItem[],
  msgId: string | undefined,
  props: ChatToolStackProps,
) {
  const { expandedTools, onToggleTool } = props;
  return items.map((item) => {
    if (item.kind === 'single') {
      return (
        <CompactToolRow
          key={item.tc.id}
          tc={item.tc}
          rowKey={item.tc.id}
          msgId={msgId}
          props={props}
        />
      );
    }
    const gid = item.id;
    const running = item.tools.some((t) => t.status === 'running');
    const anyError = item.tools.some((t) => t.status === 'error');
    const groupDefaultOpen = running || anyError;
    const isOpen = Object.prototype.hasOwnProperty.call(expandedTools, gid)
      ? expandedTools[gid]
      : groupDefaultOpen;
    return (
      <div
        className={`tool-row tool-row-group ${isOpen ? 'is-open' : ''} ${anyError ? 'is-error' : ''}`}
        key={gid}
      >
        <div
          className="tool-row-head"
          role="button"
          tabIndex={0}
          onClick={() => onToggleTool(gid, isOpen)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleTool(gid, isOpen);
            }
          }}
        >
          <span className="tool-row-head-main">
            {running ? (
              <span className="tool-row-live" aria-hidden>
                <span className="loading-spinner" style={{ width: 8, height: 8, borderWidth: 1.5 }} />
              </span>
            ) : null}
            <span className="tool-row-summary">{item.label}</span>
          </span>
          <span className="tool-row-chevron-slot is-toggle">
            <Lucide.ChevronRight size={14} className={`tool-row-chevron ${isOpen ? 'rot' : ''}`} />
          </span>
        </div>
        {isOpen && (
          <div className="tool-group-body">
            {item.tools.map((tc) => (
              <CompactToolRow key={tc.id} tc={tc} rowKey={tc.id} msgId={msgId} props={props} />
            ))}
          </div>
        )}
      </div>
    );
  });
}

export const ChatToolStack: React.FC<ChatToolStackProps> = (props) => {
  const { items, msgId, roundKey, expandedRounds, onToggleRound } = props;
  const allTools = flattenToolItems(items);
  const n = allTools.length;
  /** ≥2 才显示本轮汇总行；单工具保持原样避免噪音 */
  const useRoundGroup = Boolean(roundKey && onToggleRound && n >= 2);

  if (!useRoundGroup || !roundKey) {
    return <div className="tool-stack">{renderToolStackItems(items, msgId, props)}</div>;
  }

  const defaultExpanded = n < 4;
  const isRoundOpen = Object.prototype.hasOwnProperty.call(expandedRounds || {}, roundKey)
    ? Boolean(expandedRounds![roundKey])
    : defaultExpanded;
  const visibleItems = isRoundOpen ? items : filterLiveToolItems(items);
  const summary = buildRoundSummary(allTools);
  const hasLive = allTools.some(
    (t) => t.status === 'running' || t.status === 'pending_approval',
  );

  return (
    <div className={`tool-round-group ${isRoundOpen ? 'is-open' : 'is-collapsed'}`}>
      <div
        className="tool-round-group-head"
        role="button"
        tabIndex={0}
        aria-expanded={isRoundOpen}
        onClick={() => onToggleRound?.(roundKey, isRoundOpen)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleRound?.(roundKey, isRoundOpen);
          }
        }}
      >
        <span className="tool-round-group-label" title={summary}>
          {hasLive && !isRoundOpen ? (
            <span className="tool-row-live" aria-hidden>
              <span className="loading-spinner" style={{ width: 8, height: 8, borderWidth: 1.5 }} />
            </span>
          ) : null}
          {summary}
        </span>
        <span className="tool-row-chevron-slot is-toggle">
          <Lucide.ChevronRight
            size={14}
            className={`tool-row-chevron ${isRoundOpen ? 'rot' : ''}`}
          />
        </span>
      </div>
      {visibleItems.length > 0 ? (
        <div className="tool-stack tool-round-group-body">
          {renderToolStackItems(visibleItems, msgId, props)}
        </div>
      ) : null}
    </div>
  );
};
