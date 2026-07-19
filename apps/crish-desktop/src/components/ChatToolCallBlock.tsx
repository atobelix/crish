/**
 * 工具行渲染：每工具独立一行；默认折叠；点击展开仅该工具结果。
 * InlineAgentPanel 懒加载，避免与其互相 import ChatToolStack 形成环。
 */
import React, { Suspense, lazy, useState } from 'react';
import styles from './ChatToolCallBlock.module.css';
import * as Lucide from 'lucide-react';
import type { FileDiff, MessageToolCall, SessionAgent } from '../store/layoutStore';
import { ApprovalAskCard } from './ApprovalAskCard';
import { Tooltip } from './settings/SettingsUI';
import { isEditToolName, isShellToolName } from '../api/toolFeedback';
import {
  extractImageRefs,
  extractToolCommand,
  formatToolDiffStat,
  fullToolOutput,
  isToolRowDefaultOpen,
  normalizeToolDiffStat,
  resolveToolRowOpen,
  toolCommandPreview,
  toolDiffLineStats,
  toolHasExpandableBody,
  toolHumanLabel,
  toolPathDisplayName,
  toolRowTone,
  type ToolRenderItem,
} from '../api/toolPresentation';
import { extractFilePathFromToolArgs } from '../api/workspaceFsApi';
import { TOOL_OUTPUT_DOM_CHAR_CAP, budgetDomText } from '../api/messageWindow';

const InlineAgentPanel = lazy(() =>
  import('./InlineAgentPanel').then((m) => ({ default: m.InlineAgentPanel })),
);

/** 工具行状态中文标签（aria / 行尾 / data 共用，避免英文 status 直出） */
function toolStatusZh(status: MessageToolCall['status'] | undefined): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'success':
      return '完成';
    case 'error':
      return '失败';
    case 'pending_approval':
      return '待确认';
    default:
      return '待命';
  }
}

/** 空输出占位（与 Runtime/后台任务文案一致） */
const TOOL_EMPTY_OUTPUT_ZH = '（无输出）';

/** 展开区 id，供 aria-controls 关联 */
function toolResultBodyId(toolId: string): string {
  return `tool-result-${toolId}`;
}

export interface ChatToolStackProps {
  items: ToolRenderItem[];
  msgId?: string;
  agents: SessionAgent[];
  activeSessionId: string;
  expandedTools: Record<string, boolean>;
  onToggleTool: (toolId: string, currentlyOpen: boolean) => void;
  approvalBusy: boolean;
  pendingApprovalMsgId: string;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenPath: (filePath: string) => void;
  onOpenTerminal: () => void;
  onApprovalAllow: (toolId: string, msgId: string, remember?: boolean) => void;
  onApprovalDeny: (toolId: string, msgId: string) => void;
}

/**
 * 行级共享 props（不含 items/msgId）：由 ChatMessageList 一次组装，
 * 经 ChatAssistantMessageRow 展开进 ChatToolStack，避免双份类型定义漂移。
 */
export type ChatToolStackSharedProps = Omit<ChatToolStackProps, 'items' | 'msgId'>;

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
    <div className={styles.gitDiffCard} key={diff.filePath}>
      <div className={styles.gitDiffCardHeader} onClick={() => onOpenDiff(diff)}>
        <div className={styles.gitDiffFileInfo}>
          <Lucide.FileCode size={16} style={{ color: 'var(--accent-color)' }} />
          <span className={styles.gitDiffFilename}>{diff.filePath}</span>
          <span className={styles.gitDiffPreviewTag}>在右侧查看</span>
        </div>
        <div className={styles.gitDiffBadge}>
          <span className={styles.gitDiffAdd}>+{diff.additions}</span>
          <span className={styles.gitDiffDel}>-{diff.deletions}</span>
        </div>
      </div>
      <div className={styles.gitDiffLinesContainer}>
        {diff.changes.slice(0, 8).map((change, i) => (
          <div key={i} className={`${styles.gitDiffLineRow} ${styles[change.type] || change.type}`}>
            <div className={styles.lineNumCol}>
              {change.type === 'addition' ? '+' : change.type === 'deletion' ? '-' : ' '}
            </div>
            <pre className={styles.lineContent}>{change.content}</pre>
          </div>
        ))}
        {diff.changes.length > 8 && (
          <div className={styles.gitDiffMoreIndicator} onClick={() => onOpenDiff(diff)}>
            还有 {diff.changes.length - 8} 行 · 点击在右侧查看完整 diff
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 展开体：默认折叠时整段不挂载；展开后仍做字符预算，
 * 超长需二次「显示全部」，避免单工具输出撑爆 DOM。
 * 空正文 →「（无输出）」中文占位（不复用「完成/失败」伪输出）。
 */
function ToolResultBody({
  tc,
  bodyId,
  onOpenDiff,
  onOpenTerminal,
}: {
  tc: {
    id?: string;
    output?: string;
    diffs?: FileDiff[];
    name?: string;
    status?: string;
    arguments?: string;
  };
  bodyId: string;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenTerminal: () => void;
}) {
  const [showFullOutput, setShowFullOutput] = useState(false);
  const images = extractImageRefs(tc.output || '');
  const raw = tc.output || '';
  const full = fullToolOutput(raw);
  const budget = showFullOutput
    ? { text: full, truncated: false, originalLength: full.length }
    : budgetDomText(full, TOOL_OUTPUT_DOM_CHAR_CAP);
  const out = budget.text;
  const hasDiffs = Boolean(tc.diffs && tc.diffs.length);
  const shellTool = isShellToolName(tc.name || '');
  const longShell = shellTool && (raw.length > 2000 || raw.split('\n').length > 80);
  const statusZh = toolStatusZh(tc.status as MessageToolCall['status'] | undefined);
  const emptyBody = !full && images.length === 0 && !hasDiffs;
  // 展开体顶部：只展示命令本身（清洗后），不混系统元数据
  const cmdLine = shellTool
    ? toolCommandPreview(
        {
          id: tc.id || 'x',
          name: tc.name || 'shell',
          arguments: tc.arguments || '',
          status: (tc.status as MessageToolCall['status']) || 'success',
        },
        200,
      )
    : '';

  return (
    <div
      id={bodyId}
      className={styles.toolResultBody}
      role="region"
      aria-label={`${statusZh}的工具输出`}
      data-empty={emptyBody ? 'true' : undefined}
    >
      {cmdLine ? (
        <pre className={`${styles.toolResultPre} ${styles.toolResultPreCmd}`} aria-label="命令">
          {cmdLine}
        </pre>
      ) : null}
      {emptyBody ? (
        <pre className={styles.toolResultPre} aria-label="无输出">
          {TOOL_EMPTY_OUTPUT_ZH}
        </pre>
      ) : null}
      {!emptyBody && out ? <pre className={styles.toolResultPre}>{out}</pre> : null}
      {budget.truncated ? (
        <div className={styles.toolResultLongHint}>
          <button
            type="button"
            className={styles.toolResultHintBtn}
            onClick={(e) => {
              e.stopPropagation();
              setShowFullOutput(true);
            }}
          >
            显示全部输出（{budget.originalLength.toLocaleString()} 字符）
          </button>
        </div>
      ) : null}
      {longShell ? (
        <div className={styles.toolResultLongHint}>
          <button
            type="button"
            className={styles.toolResultHintBtn}
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
        <div className={styles.toolResultImages}>
          {images.map((src, i) => (
            <img
              key={src}
              src={src}
              alt={`工具输出图片 ${i + 1}`}
              className={styles.toolResultImg}
              loading="lazy"
            />
          ))}
        </div>
      )}
      {tc.diffs?.map((d) => renderGitDiff(d, onOpenDiff))}
    </div>
  );
}

/**
 * 工具行分层：
 * - 摘要（灰）：人读意图 · 单行
 * - 命令（等宽更浅）：同排截断
 * - 展开体：仅该工具结果；透明底 + 边缘淡化
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
  } = props;

  // 审批优先：勿被 linked agent 分支吞掉 pending_approval
  // 外层 tool-row--approval 与工具行同宽对齐
  if (tc.status === 'pending_approval') {
    const summary = toolHumanLabel(tc);
    const techFull = extractToolCommand(tc.arguments || '');
    const tech = techFull && techFull !== summary ? techFull : toolCommandPreview(tc, 72);
    const mid = msgId || pendingApprovalMsgId;
    return (
      <div
        key={rowKey}
        className={`${styles.toolRow} ${styles.toolRowApproval} ${styles.isPending} tool-row tool-row-approval is-pending`}
        data-tool-id={tc.id}
      >
        <ApprovalAskCard
          msgId={mid}
          toolId={tc.id}
          summary={summary}
          cmd={tech && tech !== summary ? tech : techFull || undefined}
          busy={approvalBusy}
          riskMeta={tc.approvalMeta}
          onAllow={() => {
            onApprovalAllow(tc.id, mid, false);
          }}
          onAllowRemember={() => {
            onApprovalAllow(tc.id, mid, true);
          }}
          onDeny={() => onApprovalDeny(tc.id, mid)}
        />
      </div>
    );
  }
  const linkedAgent = findAgentForTool(tc, agents);
  if (linkedAgent && activeSessionId) {
    return (
      <Suspense
        key={String(rowKey)}
        fallback={
          <div className={`${styles.toolRow} ${styles.isRunning} tool-row is-running`}>
            <div className={`${styles.toolRowHead} ${styles.toolRowHeadStatic}`}>
              <span className={styles.toolRowIcoSlot} aria-hidden>
                <span className={styles.toolRowLive}>
                  <span className="loading-spinner" style={{ width: 8, height: 8, borderWidth: 1.5 }} />
                </span>
              </span>
              <span className={styles.toolRowSummary}>协作子任务…</span>
            </div>
          </div>
        }
      >
        <InlineAgentPanel
          agent={linkedAgent}
          parentSessionId={activeSessionId}
          defaultOpen={tc.status === 'running' || linkedAgent.status === 'running'}
        />
      </Suspense>
    );
  }
  const expandable = toolHasExpandableBody(tc);
  // 默认折叠契约：resolveToolRowOpen（用户显式态优先，否则 isToolRowDefaultOpen≡false）
  const defaultOpen = isToolRowDefaultOpen(tc);
  const isOpen = resolveToolRowOpen(expandedTools, tc.id, tc);
  const human = toolHumanLabel(tc);
  const running = tc.status === 'running';
  const tone = toolRowTone(tc.status);
  const statusZh = toolStatusZh(tc.status);
  // 仅有实质结果时可展开；终态无正文只靠 tone/中文状态（与 isOpen 解耦）
  const canToggle = expandable;
  const bodyId = toolResultBodyId(tc.id);
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
  // ± 仅进 aria，不在摘要行展示
  const diffStatsRaw = toolDiffLineStats(tc);
  const diffStats = diffStatsRaw ? normalizeToolDiffStat(diffStatsRaw) : null;
  const diffStatLabel = diffStats ? formatToolDiffStat(diffStats) : '';
  /** 读屏：意图 · 状态 · ± · 展开态 */
  const rowAriaLabel = [
    human,
    statusZh,
    diffStatLabel || null,
    canToggle ? (isOpen ? '已展开' : '已折叠') : null,
    canToggle ? (isOpen ? '按 Enter 或空格折叠' : '按 Enter 或空格展开') : null,
  ]
    .filter(Boolean)
    .join('，');
  const pathActions =
    pathClickable && filePath ? (
      <span className={styles.toolPathActions} onClick={(e) => e.stopPropagation()}>
        <Tooltip content="在文件面板打开">
          <button
            type="button"
            className={styles.toolPathAction}
            onClick={() => onOpenPath(filePath)}
          >
            <Lucide.PanelRightOpen size={14} />
          </button>
        </Tooltip>
        <Tooltip content="复制路径">
          <button
            type="button"
            className={styles.toolPathAction}
            onClick={() => {
              void navigator.clipboard.writeText(filePath);
            }}
          >
            <Lucide.Copy size={14} />
          </button>
        </Tooltip>
      </span>
    ) : null;

  /** 主行：人话说明；路径名可点 */
  const renderSummary = () => {
    if (!pathClickable || !filePath || !pathLabel || !human.includes(pathLabel)) {
      return (
        <Tooltip content={human}>
          <span className={styles.toolRowSummary}>
            {human}
            {pathClickable && filePath && pathActions ? (
              <span className={styles.toolPathWrap} style={{ marginLeft: 6 }}>
                {pathActions}
              </span>
            ) : null}
          </span>
        </Tooltip>
      );
    }
    const idx = human.lastIndexOf(pathLabel);
    const link = (
      <span className={styles.toolPathWrap}>
        <Tooltip content={filePath}>
          <button
            type="button"
            className={styles.toolPathLink}
            onClick={(e) => {
              e.stopPropagation();
              onOpenPath(filePath);
            }}
          >
            {pathLabel}
          </button>
        </Tooltip>
        {pathActions}
      </span>
    );
    if (idx < 0) {
      return (
        <Tooltip content={filePath}>
          <span className={styles.toolRowSummary}>
            {human} {link}
          </span>
        </Tooltip>
      );
    }
    return (
      <Tooltip content={filePath}>
        <span className={styles.toolRowSummary}>
          {human.slice(0, idx)}
          {link}
          {human.slice(idx + pathLabel.length)}
        </span>
      </Tooltip>
    );
  };

  /**
   * 工具图标：统一圆润线稿（round cap/join + 同尺寸线宽），
   * 不用圆描边框；选型偏软、少棱角。
   */
  const toolIcon = (() => {
    const name = (tc.name || '').toLowerCase();
    const cls = 'tool-row-type-ico';
    const sz = 14;
    const sw = 1.6;
    let inner: React.ReactNode;
    if (running) {
      inner = (
        <span className={styles.toolRowLive} aria-hidden>
          <span className="loading-spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
        </span>
      );
    } else if (
      isShellToolName(name) ||
      name.includes('bash') ||
      name.includes('shell') ||
      name.includes('exec')
    ) {
      // 终端图标（勿用 Lucide.Command=⌘，Windows 上像奇怪光标符号）
      inner = <Lucide.Terminal className={cls} size={sz} strokeWidth={sw} />;
    } else if (name.includes('grep') || name.includes('search') || name.includes('find')) {
      inner = <Lucide.Search className={cls} size={sz} strokeWidth={sw} />;
    } else if (name.includes('read') || name.includes('cat') || name.includes('view')) {
      // File 比 FileText 更简、外轮廓更圆
      inner = <Lucide.File className={cls} size={sz} strokeWidth={sw} />;
    } else if (
      isEditToolName(name) ||
      name.includes('write') ||
      name.includes('edit') ||
      name.includes('patch')
    ) {
      inner = <Lucide.PenLine className={cls} size={sz} strokeWidth={sw} />;
    } else if (name.includes('list') || name.includes('glob') || name.includes('dir')) {
      inner = <Lucide.FolderOpen className={cls} size={sz} strokeWidth={sw} />;
    } else if (name.includes('web') || name.includes('fetch') || name.includes('http')) {
      inner = <Lucide.Globe className={cls} size={sz} strokeWidth={sw} />;
    } else if (name.includes('git')) {
      inner = <Lucide.GitBranch className={cls} size={sz} strokeWidth={sw} />;
    } else {
      inner = <Lucide.CircleDot className={cls} size={sz} strokeWidth={sw} />;
    }
    return (
      <span className={styles.toolRowIcoSlot} aria-hidden>
        {inner}
      </span>
    );
  })();

  return (
    <div
      className={`${styles.toolRow} ${
        tone === 'running'
          ? `${styles.isRunning} is-running`
          : tone === 'error'
          ? `${styles.isError} is-error`
          : tone === 'pending'
          ? `${styles.isPending} is-pending`
          : ''
      } ${isOpen ? `${styles.isOpen} is-open` : `${styles.isCollapsed} is-collapsed`} tool-row`}
      key={rowKey}
      data-tool-id={tc.id}
      data-tool-label={human}
      data-tool-status={statusZh}
      data-default-collapsed={defaultOpen ? 'false' : 'true'}
      data-diff-stat={diffStatLabel || undefined}
      aria-busy={running || undefined}
    >
      {/* 用 div 而非 button，避免路径操作按钮嵌套 button 报错 */}
      <div
        className={`${styles.toolRowHead}${canToggle ? '' : ' ' + styles.toolRowHeadStatic} tool-row-head${canToggle ? '' : ' tool-row-head-static'}`}
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
        aria-expanded={canToggle ? isOpen : undefined}
        aria-controls={canToggle ? bodyId : undefined}
        aria-label={rowAriaLabel}
        style={canToggle ? undefined : { cursor: 'default' }}
        onClick={() => canToggle && onToggleTool(tc.id, isOpen)}
        onKeyDown={(e) => {
          if (!canToggle) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleTool(tc.id, isOpen);
            return;
          }
          // Escape：已展开时折叠，焦点留在行头
          if (e.key === 'Escape' && isOpen) {
            e.preventDefault();
            e.stopPropagation();
            onToggleTool(tc.id, true);
          }
        }}
      >
        <span className={styles.toolRowHeadMain}>
          {toolIcon}
          <span className={styles.toolRowText}>
            {/* 摘要行只保留人话意图；命令/±/状态放到展开体或 aria，避免一行堆太多标识 */}
            {renderSummary()}
          </span>
        </span>
        <span className={`${styles.toolRowChevronSlot} ${canToggle ? styles.isToggle : ''}`}>
          {canToggle ? (
            <Lucide.ChevronRight
              size={12}
              className={`${styles.toolRowChevron} ${isOpen ? styles.rot : ''}`}
              aria-hidden
            />
          ) : null}
        </span>
      </div>
      {/* 默认折叠：未展开时整段结果不挂载，防流式高度抖动 */}
      {isOpen && canToggle ? (
        <ToolResultBody
          tc={tc}
          bodyId={bodyId}
          onOpenDiff={onOpenDiff}
          onOpenTerminal={onOpenTerminal}
        />
      ) : null}
    </div>
  );
}

/** 组也展平为独立行，避免「N 步」汇总头 */
function flattenRenderTools(items: ToolRenderItem[]): MessageToolCall[] {
  const out: MessageToolCall[] = [];
  for (const item of items) {
    if (item.kind === 'single') out.push(item.tc);
    else out.push(...item.tools);
  }
  return out;
}

function renderToolStackItems(
  items: ToolRenderItem[],
  msgId: string | undefined,
  props: ChatToolStackProps,
) {
  const tools = flattenRenderTools(items);
  return tools.map((tc) => (
    <CompactToolRow key={tc.id} tc={tc} rowKey={tc.id} msgId={msgId} props={props} />
  ));
}

export const ChatToolStack: React.FC<ChatToolStackProps> = (props) => {
  const { items, msgId } = props;
  return <div className={`${styles.toolStack} tool-stack`}>{renderToolStackItems(items, msgId, props)}</div>;
};
