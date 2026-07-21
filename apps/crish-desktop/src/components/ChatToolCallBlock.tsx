/**
 * 工具行渲染：每工具独立一行；默认折叠；点击展开仅该工具结果。
 * InlineAgentPanel 懒加载，避免与其互相 import ChatToolStack 形成环。
 */
import React, { Suspense, lazy, useState, useMemo, useRef, useLayoutEffect, useEffect } from 'react';
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
import { TOOL_OUTPUT_PIXEL_CAP } from '../api/messageWindow';
import { usePreparedText } from '../hooks/useTextMeasure';
import { buildPretextFont, getResolvedFontSizePx } from '../utils/pretextFontBridge';
import { prepareWithSegments, walkLineRanges, materializeLineRange, layout } from '@chenglou/pretext';
import type { LayoutLineRange } from '@chenglou/pretext';

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
  onRetryTool?: (toolId: string) => void;
  onBatchApprove?: (msgIds: string[]) => void;
  onBatchDeny?: (msgIds: string[]) => void;
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
  const raw = tc.output || '';
  const images = useMemo(() => extractImageRefs(raw), [raw]);
  const full = useMemo(() => fullToolOutput(raw), [raw]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth - 24);
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fontConfig = useMemo(() => {
    const fontSizePx = getResolvedFontSizePx('--font-size-xs');
    const fontStr = buildPretextFont('mono', 'normal', fontSizePx);
    const lineHeightPx = Math.round(fontSizePx * 1.45);
    return { fontStr, lineHeightPx };
  }, []);

  const { prepared } = usePreparedText({
    text: full || '',
    font: fontConfig.fontStr,
    whiteSpace: 'pre-wrap',
  });

  const budget = useMemo(() => {
    if (showFullOutput) {
      return { text: full, truncated: false, originalLength: full.length };
    }
    if (!full || !containerWidth || containerWidth <= 16) {
      return { text: full, truncated: false, originalLength: full.length };
    }
    try {
      const totalHeight = layout(prepared!, containerWidth, fontConfig.lineHeightPx).height;
      if (totalHeight <= TOOL_OUTPUT_PIXEL_CAP) {
        return { text: full, truncated: false, originalLength: full.length };
      }
      const pws = prepareWithSegments(full, fontConfig.fontStr, { whiteSpace: 'pre-wrap' });
      const lineRanges: LayoutLineRange[] = [];
      walkLineRanges(pws, containerWidth, (line) => {
        lineRanges.push(line);
      });
      let accumulated = 0;
      const parts: string[] = [];
      for (const lr of lineRanges) {
        if (accumulated + fontConfig.lineHeightPx > TOOL_OUTPUT_PIXEL_CAP) break;
        parts.push(materializeLineRange(pws, lr).text);
        accumulated += fontConfig.lineHeightPx;
      }
      return {
        text: parts.join('\n') + '\n…（已截断）',
        truncated: true,
        originalLength: full.length,
      };
    } catch {
      return { text: full, truncated: false, originalLength: full.length };
    }
  }, [showFullOutput, full, containerWidth, fontConfig, prepared]);

  const out = budget.text;
  const hasDiffs = Boolean(tc.diffs && tc.diffs.length);
  const shellTool = isShellToolName(tc.name || '');
  const longShell = shellTool && (raw.length > 2000 || raw.split('\n').length > 80);
  const statusZh = toolStatusZh(tc.status as MessageToolCall['status'] | undefined);
  const emptyBody = !full && images.length === 0 && !hasDiffs;
  const cmdLine = useMemo(
    () =>
      shellTool
        ? toolCommandPreview(
            {
              id: tc.id || 'x',
              name: tc.name || 'shell',
              arguments: tc.arguments || '',
              status: (tc.status as MessageToolCall['status']) || 'success',
            },
            200,
          )
        : '',
    [shellTool, tc.id, tc.name, tc.arguments, tc.status],
  );

  const truncatedStyle: React.CSSProperties | undefined = budget.truncated
    ? { maxHeight: TOOL_OUTPUT_PIXEL_CAP, overflowY: 'hidden' }
    : undefined;

  return (
    <div
      id={bodyId}
      ref={bodyRef}
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
      {!emptyBody && out ? <pre className={styles.toolResultPre} style={truncatedStyle}>{out}</pre> : null}
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
  // ± 在折叠行展示
  const diffStatsRaw = toolDiffLineStats(tc);
  const diffStats = diffStatsRaw ? normalizeToolDiffStat(diffStatsRaw) : null;
  const diffStatLabel = diffStats ? formatToolDiffStat(diffStats) : '';

  // Duration display
  const [liveNow, setLiveNow] = useState(Date.now());
  useEffect(() => {
    if (tc.status !== 'running' || !tc.startedAt) return;
    const id = setInterval(() => setLiveNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [tc.status, tc.startedAt]);
  const durationStr = useMemo(() => {
    if (tc.startedAt && tc.completedAt) {
      const sec = (tc.completedAt - tc.startedAt) / 1000;
      return sec >= 0.1 ? `${sec.toFixed(1)}s` : null;
    }
    if (tc.status === 'running' && tc.startedAt) {
      const sec = (liveNow - tc.startedAt) / 1000;
      return `${sec.toFixed(1)}s`;
    }
    return null;
  }, [tc.startedAt, tc.completedAt, tc.status, liveNow]);

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
            aria-label="在文件面板打开"
            onClick={() => onOpenPath(filePath)}
          >
            <Lucide.PanelRightOpen size={14} />
          </button>
        </Tooltip>
        <Tooltip content="复制路径">
          <button
            type="button"
            className={styles.toolPathAction}
            aria-label="复制路径"
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
   * 状态图标：根据工具状态显示对应图标，不再按工具名称区分。
   */
  const toolIcon = (() => {
    const sz = 14;
    const sw = 1.6;
    let inner: React.ReactNode;
    if (running) {
      inner = (
        <span className={styles.toolRowLive} aria-hidden>
          <span className="loading-spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
        </span>
      );
    } else if (tc.status === 'success') {
      inner = <Lucide.CheckCircle2 size={sz} strokeWidth={sw} color="var(--accent-green, #22c55e)" />;
    } else if (tc.status === 'error') {
      inner = <Lucide.XCircle size={sz} strokeWidth={sw} color="var(--accent-red, #ef4444)" />;
    } else if (tc.status === 'pending_approval') {
      inner = <Lucide.Clock size={sz} strokeWidth={sw} color="#f59e0b" />;
    } else {
      inner = <Lucide.CircleDot size={sz} strokeWidth={sw} color="var(--text-tertiary)" />;
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
            {/* 摘要行只保留人话意图 */}
            {renderSummary()}
          </span>
          {diffStats ? (
            <span className={styles.diffStats}>
              <span className={styles.diffStatsAdd}>+{diffStats.add}</span>
              <span className={styles.diffStatsDel}>-{diffStats.del}</span>
            </span>
          ) : null}
          {durationStr ? (
            <span className={styles.duration}>{durationStr}</span>
          ) : null}
        </span>
        <span className={`${styles.toolRowChevronSlot} ${canToggle ? styles.isToggle : ''}`}>
          {tc.status === 'error' && props.onRetryTool ? (
            <button
              type="button"
              className={styles.retryBtn}
              onClick={(e) => {
                e.stopPropagation();
                props.onRetryTool!(tc.id);
              }}
              aria-label="重试"
            >
              <Lucide.RotateCcw size={12} />
            </button>
          ) : null}
          {canToggle ? (
            <Lucide.ChevronRight
              size={12}
              className={`${styles.toolRowChevron} ${isOpen ? styles.rot : ''}`}
              aria-hidden
            />
          ) : null}
        </span>
      </div>
      {canToggle ? (
        <div className={`${styles.toolBody}${isOpen ? ' ' + styles.expanded : ''}`}>
          <div className={styles.toolBodyInner}>
            <ToolResultBody
              tc={tc}
              bodyId={bodyId}
              onOpenDiff={onOpenDiff}
              onOpenTerminal={onOpenTerminal}
            />
          </div>
        </div>
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

/** 批量审批栏：2+ 相邻待确认工具时渲染 */
function BatchApprovalBar({
  toolIds,
  msgIds,
  onApprove,
  onDeny,
}: {
  toolIds: string[];
  msgIds: string[];
  onApprove?: (msgIds: string[]) => void;
  onDeny?: (msgIds: string[]) => void;
}) {
  return (
    <div className={styles.batchBar} role="group" aria-label={`批量审批 ${toolIds.length} 个工具`}>
      <span className={styles.batchBarLabel}>
        待确认工具（{toolIds.length}）
      </span>
      {onApprove ? (
        <button
          type="button"
          className={`${styles.batchBarBtn} ${styles.batchBarApprove}`}
          onClick={() => onApprove(msgIds)}
        >
          <Lucide.Check size={12} />
          全部批准
        </button>
      ) : null}
      {onDeny ? (
        <button
          type="button"
          className={`${styles.batchBarBtn} ${styles.batchBarDeny}`}
          onClick={() => onDeny(msgIds)}
        >
          <Lucide.X size={12} />
          全部拒绝
        </button>
      ) : null}
    </div>
  );
}

/** 对一组工具渲染行，在相邻 pending_approval 间插入批量审批栏 */
function renderToolsWithBatchBars(
  tools: MessageToolCall[],
  msgId: string | undefined,
  props: ChatToolStackProps,
): JSX.Element[] {
  const elements: JSX.Element[] = [];
  let i = 0;
  while (i < tools.length) {
    if (tools[i].status === 'pending_approval' && msgId) {
      const pendingGroup: MessageToolCall[] = [tools[i]];
      let j = i + 1;
      while (j < tools.length && tools[j].status === 'pending_approval') {
        pendingGroup.push(tools[j]);
        j++;
      }
      if (pendingGroup.length >= 2) {
        const ids = pendingGroup.map((t) => t.id);
        const mIds = pendingGroup.map(() => msgId);
        elements.push(
          <BatchApprovalBar
            key={`batch-${ids[0]}`}
            toolIds={ids}
            msgIds={mIds}
            onApprove={props.onBatchApprove}
            onDeny={props.onBatchDeny}
          />,
        );
      }
      for (const tc of pendingGroup) {
        elements.push(
          <CompactToolRow key={tc.id} tc={tc} rowKey={tc.id} msgId={msgId} props={props} />,
        );
      }
      i = j;
    } else {
      elements.push(
        <CompactToolRow key={tools[i].id} tc={tools[i]} rowKey={tools[i].id} msgId={msgId} props={props} />,
      );
      i++;
    }
  }
  return elements;
}

function renderToolStackItems(
  items: ToolRenderItem[],
  msgId: string | undefined,
  props: ChatToolStackProps,
) {
  const tools = flattenRenderTools(items);
  // Build parallel groups first, then render with batch bars inside each group
  const segments: JSX.Element[] = [];
  let i = 0;
  while (i < tools.length) {
    const cur = tools[i];
    if (cur.turnId && cur.startedAt) {
      const group: MessageToolCall[] = [cur];
      let j = i + 1;
      while (
        j < tools.length &&
        tools[j].turnId === cur.turnId &&
        tools[j].startedAt != null &&
        Math.abs(tools[j].startedAt! - cur.startedAt) <= 200
      ) {
        group.push(tools[j]);
        j++;
      }
      if (group.length >= 2) {
        segments.push(
          <div key={`pg-${cur.id}`} className={styles.parallelGroup}>
            <div className={styles.parallelHeader}>Parallel（{group.length}）</div>
            {renderToolsWithBatchBars(group, msgId, props)}
          </div>,
        );
        i = j;
        continue;
      }
    }
    segments.push(...renderToolsWithBatchBars([cur], msgId, props));
    i++;
  }
  return segments;
}

export const ChatToolStack: React.FC<ChatToolStackProps> = (props) => {
  const { items, msgId } = props;
  return <div className={`${styles.toolStack} tool-stack`}>{renderToolStackItems(items, msgId, props)}</div>;
};
