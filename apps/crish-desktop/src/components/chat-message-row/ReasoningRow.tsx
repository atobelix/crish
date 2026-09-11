/**
 * ReasoningRow.tsx
 * 24px 极简单行流式思考行组件（DIM-03 §1.1 规范）。
 *
 * 核心特性：
 * - 严格固定 24px 高度（未展开态 contain: size layout，彻底阻断流式测高风暴）；
 * - 流式运行态：极简状态指示灯 + 扫光微交互（@keyframes sweep-shine）+ 512B 尾窗打字追踪；
 * - 终态闭合态：`已思考 3.2s >`，数字等宽对齐 font-variant-numeric: tabular-nums；
 * - 点击展开态：自然向下融入主文档流，零内部滚动条，无 168px 限制，滚动交由外层唯一滚动宿主；
 * - 独立一键复制纯净思考思维链。
 */
import React, { useState, useMemo, useCallback } from 'react';
import styles from './ReasoningRow.module.css';
import { StreamingMarkdownView } from './StreamingMarkdownView';
import { Priority } from '../../workers';
import { copyTextBestEffort } from './chatMessageRowUtils';

/**
 * ReasoningRowProps 核心渲染契约（对齐 DIM-03 §1.1）
 */
export interface ReasoningRowProps {
  /** 累积思考思维链全文（可达数十KB） */
  content: string;
  /** 是否处于实时流式思考输出中 */
  isLive?: boolean;
  /** 思考完成总耗时（毫秒） */
  durationMs?: number;
  /** 多阶段思考轮次索引（如第 1 阶段思考） */
  turnIndex?: number;
  /** 外部受控开合状态（若提供则由上层状态机受控） */
  isOpen?: boolean;
  /** 点击单行切换开合的回调函数 */
  onToggle?: () => void;
  /** 初始默认开合（非受控容灾兼容，缺省为 false） */
  defaultExpanded?: boolean;
  /** 消息唯一 ID（供定位与锚点追溯） */
  messageId?: string;
  /** 外层容器附加类名 */
  className?: string;
}

/**
 * 512 字节尾窗切片算法：提取流式思考最新行
 * 复杂度严格保证：时间复杂度 O(1)，空间开销 ≤ 512B
 */
export function extractLatestLine(text: string): string {
  if (!text) return '';
  // 1. 仅截取尾部最多 512 个字符，彻底避开全量大文本扫描与 V8 GC 压力
  const tail = text.length > 512 ? text.slice(-512) : text;
  // 2. 清除末尾换行与空白
  const trimmed = tail.trimEnd();
  if (!trimmed) return '';
  // 3. 在至多 512 字符的小缓冲区中逆向寻址最后一个换行符（兼容真实换行与 JSX 字面量 \n）
  const lastReal = Math.max(trimmed.lastIndexOf('\n'), trimmed.lastIndexOf('\r'));
  const lastLit = trimmed.lastIndexOf('\\n');
  let line = trimmed;
  if (lastReal >= 0 && lastLit >= 0) {
    line = lastReal > lastLit ? trimmed.slice(lastReal + 1) : trimmed.slice(lastLit + 2);
  } else if (lastReal >= 0) {
    line = trimmed.slice(lastReal + 1);
  } else if (lastLit >= 0) {
    line = trimmed.slice(lastLit + 2);
  }
  // 4. 返回清洗后的单行文本
  return line.trim();
}

/**
 * 512 字节首窗切片算法：提取终态首行主题
 * 复杂度严格保证：时间复杂度 O(1)，空间开销 ≤ 512B
 */
export function extractFirstLine(text: string): string {
  if (!text) return '';
  // 1. 仅截取头部最多 512 个字符
  const head = text.length > 512 ? text.slice(0, 512) : text;
  // 2. 寻找第一个有效换行（兼容真实换行与 JSX 字面量 \n）
  const realIndices = [head.indexOf('\n'), head.indexOf('\r')].filter((i) => i >= 0);
  const firstReal = realIndices.length > 0 ? Math.min(...realIndices) : -1;
  const firstLit = head.indexOf('\\n');
  
  let firstNewline = -1;
  let cutLen = 1;

  if (firstReal >= 0 && firstLit >= 0) {
    if (firstReal < firstLit) {
      firstNewline = firstReal;
      cutLen = 1;
    } else {
      firstNewline = firstLit;
      cutLen = 2;
    }
  } else if (firstReal >= 0) {
    firstNewline = firstReal;
    cutLen = 1;
  } else if (firstLit >= 0) {
    firstNewline = firstLit;
    cutLen = 2;
  }

  const line = firstNewline >= 0 ? head.slice(0, firstNewline) : head;
  const trimmed = line.trim();
  // 若首行为空（例如模型开头换行），向下顺延寻找首个实质文本行
  if (!trimmed && firstNewline >= 0) {
    const remaining = head.slice(firstNewline + cutLen).trimStart();
    return extractFirstLine(remaining);
  }
  return trimmed;
}

/**
 * 独立一键复制思维链按钮
 */
export const CopyThinkingButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      const ok = await copyTextBestEffort(text);
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    },
    [text]
  );

  return (
    <button
      type="button"
      className={styles.copyButton}
      onClick={handleCopy}
      aria-label={copied ? '已复制' : '复制思考过程'}
      data-testid="copy-thinking-button"
    >
      {copied ? '已复制' : '复制'}
    </button>
  );
};

export const ReasoningRow: React.FC<ReasoningRowProps> = ({
  content,
  isLive = false,
  durationMs,
  turnIndex,
  isOpen,
  onToggle,
  defaultExpanded,
  messageId,
  className = '',
}) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(
    defaultExpanded ?? false
  );

  const isExpanded = isOpen !== undefined ? isOpen : uncontrolledOpen;

  const handleToggle = useCallback(() => {
    onToggle?.();
    if (isOpen === undefined) {
      setUncontrolledOpen((prev) => !prev);
    }
  }, [onToggle, isOpen]);

  // 终态耗时格式化（支持已思考 3.2s）
  const durationText = useMemo(() => {
    if (durationMs != null && durationMs > 0) {
      const sec = (durationMs / 1000).toFixed(1);
      return `已思考 ${sec}s`;
    }
    return null;
  }, [durationMs]);

  // 动态摘要计算：流式态 512B 尾窗提取，终态 512B 首行提取
  const displaySummary = useMemo(() => {
    if (isLive) {
      return extractLatestLine(content);
    }
    return extractFirstLine(content);
  }, [content, isLive]);

  return (
    <div
      className={`${styles.reasoningContainer} ${isLive ? styles.isLive : ''} ${className}`}
      data-expanded={isExpanded ? 'true' : 'false'}
      data-live={isLive ? 'true' : undefined}
      data-message-id={messageId}
      data-testid="reasoning-container"
    >
      <button
        type="button"
        className={styles.reasoningRow}
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-label={
          isLive
            ? '思考中'
            : durationText
              ? durationText
              : '思考过程'
        }
      >
        {isLive ? (
          <>
            <span className={styles.statusDot} aria-hidden data-testid="status-dot" />
            <span className={styles.reasoningLabel}>思考中</span>
            <span className={styles.dotSeparator} aria-hidden>·</span>
            <span className={styles.reasoningSummary} data-follow-end="true">
              <span className={`${styles.summaryText} ${styles.sweepShine}`}>
                {displaySummary || '思考中…'}
              </span>
            </span>
          </>
        ) : (
          <>
            <span className={styles.durationBadge}>
              {durationText || '已思考'}
            </span>
            {!isExpanded && displaySummary ? (
              <>
                <span className={styles.dotSeparator} aria-hidden>·</span>
                <span className={styles.reasoningSummary}>
                  <span className={styles.summaryText}>{displaySummary}</span>
                </span>
              </>
            ) : null}
          </>
        )}

        <span
          className={`${styles.chevron} ${isExpanded ? styles.isOpen : ''}`}
          aria-hidden
          data-testid="chevron"
        >
          ›
        </span>
      </button>

      {isExpanded && (
        <div className={styles.reasoningBody} data-testid="reasoning-body">
          <div className={styles.reasoningActions}>
            <CopyThinkingButton text={content} />
          </div>
          <div className={styles.reasoningContent}>
            {isLive ? (
              <div className={styles.liveContent}>{content}</div>
            ) : (
              <StreamingMarkdownView
                text={content}
                isStreaming={false}
                priority={Priority.Low}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
