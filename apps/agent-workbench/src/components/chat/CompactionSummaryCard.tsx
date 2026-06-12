/**
 * CompactionSummaryCard - 上下文压缩摘要卡片
 *
 * 当上下文压缩完成后，渲染一个可折叠的摘要卡片，包含：
 * - 摘要文本
 * - Token 节省信息
 * - 可展开的用户意图时间线
 * - 可展开的 AI 行动时间线
 * - "加载更多历史"按钮
 *
 * 参考建议 L6.8：层级化消息渲染
 */

import { useState, useMemo } from 'preact/hooks';
import { IconChevronRight, IconFileCode, IconTerminal, IconAlertTriangle, IconBot, IconUser } from '../icons';

/** 压缩摘要数据（来自 runtime ContextCompressionRecord） */
export interface CompactionSummaryData {
  compactionId: string;
  trigger: string;
  reason: string;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  compressedMessageCount: number;
  keptMessageCount: number;
  createdAt: string;
  /** 结构化摘要中的目标（用户意图） */
  goal?: string;
  /** 结构化摘要中的进展 */
  progress?: string[];
  /** 结构化摘要中的下一步 */
  nextSteps?: string[];
  /** 结构化摘要中的读取文件 */
  readFiles?: string[];
  /** 结构化摘要中的修改文件 */
  modifiedFiles?: string[];
  /** 结构化摘要中的风险 */
  risks?: string[];
  /** 压缩策略 */
  policy?: {
    tier?: string;
    action?: string;
    forced?: boolean;
    thresholdExceeded?: boolean;
    providerRetry?: boolean;
  };
  /** 递交信息 */
  handoff?: {
    trigger?: string;
    reason?: string;
    action?: string;
    summary?: string;
    pendingTasks?: string[];
    completedTaskSummaries?: string[];
    sessionEvents?: string[];
    fileSnapshotHints?: string[];
    providerRetry?: boolean;
  };
}

interface CompactionSummaryCardProps {
  data: CompactionSummaryData;
  /** 加载更多历史记录的回调 */
  onLoadHistory?: () => void;
}

/** 格式化 token 数 */
function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
}

/** 计算节省百分比 */
function savingsPercent(before: number, after: number): number {
  if (before <= 0) return 0;
  return Math.round(((before - after) / before) * 100);
}

/** 触发原因的可读标签 */
function triggerLabel(trigger: string): string {
  const labels: Record<string, string> = {
    threshold: '自动（超过阈值）',
    manual: '手动',
    handoff: '子任务递交',
    overflow: '溢出恢复',
    auto: '自动',
  };
  return labels[trigger] ?? trigger;
}

/** 策略层级的可读标签 */
function tierLabel(tier?: string): string {
  const labels: Record<string, string> = {
    proactive: '主动预防',
    recovery: '溢出恢复',
    handoff: '任务递交',
  };
  return tier ? (labels[tier] ?? tier) : '';
}

export function CompactionSummaryCard({ data, onLoadHistory }: CompactionSummaryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const savings = savingsPercent(data.tokensBefore, data.tokensAfter);
  const hasTimeline = Boolean(data.goal || (data.progress && data.progress.length > 0));
  const hasActions = Boolean(
    (data.readFiles && data.readFiles.length > 0) ||
    (data.modifiedFiles && data.modifiedFiles.length > 0)
  );
  const hasRisks = data.risks && data.risks.length > 0;
  const hasHandoff = Boolean(data.handoff?.summary || data.handoff?.pendingTasks?.length);

  const handleLoadHistory = async () => {
    if (!onLoadHistory || loadingHistory) return;
    setLoadingHistory(true);
    try {
      await onLoadHistory();
    } finally {
      setLoadingHistory(false);
    }
  };

  return (
    <div class="repl-compaction-card">
      {/* 卡片头部 */}
      <div class="repl-compaction-header" onClick={() => setExpanded(!expanded)}>
        <div class="repl-compaction-title">
          <span class={`repl-compaction-arrow ${expanded ? 'expanded' : ''}`}>
            <IconChevronRight />
          </span>
          <span class="repl-compaction-icon">
            {/* 根据 tier 显示不同图标 */}
            {data.policy?.tier === 'recovery' ? <IconAlertTriangle /> :
             data.policy?.tier === 'handoff' ? <IconBot /> :
             <IconFileCode />}
          </span>
          <span class="repl-compaction-label">上下文压缩</span>
          <span class="repl-compaction-trigger-tag">{triggerLabel(data.trigger)}</span>
        </div>
        <div class="repl-compaction-meta">
          <span class="repl-compaction-tokens">
            <span class="repl-token-before">{formatTokens(data.tokensBefore)}</span>
            <span class="repl-token-arrow">&rarr;</span>
            <span class="repl-token-after">{formatTokens(data.tokensAfter)}</span>
          </span>
          <span class={`repl-compaction-savings ${savings > 30 ? 'good' : savings > 15 ? 'ok' : 'small'}`}>
            -{savings}%
          </span>
        </div>
      </div>

      {/* 展开的内容 */}
      {expanded && (
        <div class="repl-compaction-body">
          {/* 摘要文本 */}
          {data.summary && (
            <div class="repl-compaction-summary">
              <div class="repl-compaction-section-title">摘要</div>
              <p class="repl-compaction-summary-text">{data.summary}</p>
            </div>
          )}

          {/* 压缩统计 */}
          <div class="repl-compaction-stats">
            <div class="repl-compaction-stat">
              <span class="repl-compaction-stat-label">策略</span>
              <span class="repl-compaction-stat-value">{tierLabel(data.policy?.tier) || data.reason || '-'}</span>
            </div>
            <div class="repl-compaction-stat">
              <span class="repl-compaction-stat-label">压缩消息</span>
              <span class="repl-compaction-stat-value">{data.compressedMessageCount} 条</span>
            </div>
            <div class="repl-compaction-stat">
              <span class="repl-compaction-stat-label">保留消息</span>
              <span class="repl-compaction-stat-value">{data.keptMessageCount} 条</span>
            </div>
            <div class="repl-compaction-stat">
              <span class="repl-compaction-stat-label">操作</span>
              <span class="repl-compaction-stat-value">{data.policy?.action || data.handoff?.action || '-'}</span>
            </div>
          </div>

          {/* 时间线 - 用户意图 */}
          {hasTimeline && (
            <div class="repl-compaction-section">
              <div
                class="repl-compaction-section-header"
                onClick={() => setShowTimeline(!showTimeline)}
              >
                <span class={`repl-compaction-section-arrow ${showTimeline ? 'expanded' : ''}`}>
                  <IconChevronRight />
                </span>
                <IconUser />
                <span class="repl-compaction-section-title">用户意图时间线</span>
              </div>
              {showTimeline && (
                <div class="repl-compaction-section-body">
                  {data.goal && (
                    <div class="repl-compaction-timeline-item">
                      <span class="repl-compaction-timeline-dot goal"></span>
                      <span class="repl-compaction-timeline-text">
                        <strong>目标：</strong>{data.goal}
                      </span>
                    </div>
                  )}
                  {data.progress?.map((item, idx) => (
                    <div class="repl-compaction-timeline-item" key={idx}>
                      <span class="repl-compaction-timeline-dot progress"></span>
                      <span class="repl-compaction-timeline-text">{item}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 行动时间线 - 文件和工具调用 */}
          {hasActions && (
            <div class="repl-compaction-section">
              <div
                class="repl-compaction-section-header"
                onClick={() => setShowActions(!showActions)}
              >
                <span class={`repl-compaction-section-arrow ${showActions ? 'expanded' : ''}`}>
                  <IconChevronRight />
                </span>
                <IconTerminal />
                <span class="repl-compaction-section-title">AI 行动时间线</span>
              </div>
              {showActions && (
                <div class="repl-compaction-section-body">
                  {data.readFiles?.map((file, idx) => (
                    <div class="repl-compaction-timeline-item" key={`read-${idx}`}>
                      <span class="repl-compaction-timeline-dot read"></span>
                      <span class="repl-compaction-timeline-text">
                        读取 <code class="repl-compaction-file-path">{file}</code>
                      </span>
                    </div>
                  ))}
                  {data.modifiedFiles?.map((file, idx) => (
                    <div class="repl-compaction-timeline-item" key={`mod-${idx}`}>
                      <span class="repl-compaction-timeline-dot modify"></span>
                      <span class="repl-compaction-timeline-text">
                        修改 <code class="repl-compaction-file-path">{file}</code>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 风险提示 */}
          {hasRisks && (
            <div class="repl-compaction-risks">
              <div class="repl-compaction-section-title">
                <span class="repl-compaction-risk-icon"><IconAlertTriangle /></span>
                注意
              </div>
              {data.risks!.map((risk, idx) => (
                <div class="repl-compaction-risk-item" key={idx}>
                  {risk}
                </div>
              ))}
            </div>
          )}

          {/* 递交信息 */}
          {hasHandoff && (
            <div class="repl-compaction-handoff">
              <div class="repl-compaction-section-title">
                <IconBot />
                子任务递交
              </div>
              {data.handoff!.summary && (
                <p class="repl-compaction-handoff-summary">{data.handoff!.summary}</p>
              )}
              {data.handoff!.pendingTasks?.map((task, idx) => (
                <div class="repl-compaction-handoff-task" key={idx}>
                  <span class="repl-compaction-timeline-dot pending"></span>
                  {task}
                </div>
              ))}
            </div>
          )}

          {/* 加载更多历史按钮 */}
          {onLoadHistory && (
            <div class="repl-compaction-actions">
              <button
                class="repl-compaction-load-btn"
                onClick={handleLoadHistory}
                disabled={loadingHistory}
              >
                {loadingHistory ? '加载中...' : '加载更多历史记录'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}