import React, { useState, useMemo } from 'react';

import { Tooltip } from '../ui';
import styles from './ModernToolCall.module.css';
import { AppIcon } from '../ui/icons/index';

export interface ModernJsonToolCallProps {
  id?: string;
  name?: string;
  actionText?: string;
  paramPill?: string;
  request?: unknown;
  result?: string | React.ReactNode;
  status?: 'running' | 'success' | 'error' | string;
  defaultOpen?: boolean;
  isOpen?: boolean;
  onToggle?: (open: boolean) => void;
  className?: string;
}

/**
 * 格式化 Request 为标准的 JSON 等宽代码展示
 */
function formatRequest(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') {
    return '{}';
  }
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }
  const s = String(raw).trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return s;
    }
  }
  return s;
}

/**
 * 结构化 JSON 工具调用卡片（对齐设计截图 1）
 * 包含：Chevron 折叠指示器 + 单色动作描述 + 参数胶囊 Pill + 必要完成态绿勾 ✓
 * 展开呈现：Request JSON 格式化区块 + 微细横线 + Result 结果摘要
 */
export const ModernJsonToolCall: React.FC<ModernJsonToolCallProps> = ({
  id,
  name = 'tool',
  actionText,
  paramPill,
  request,
  result,
  status = 'success',
  defaultOpen = false,
  isOpen: controlledOpen,
  onToggle,
  className = '',
}) => {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isExpanded = controlledOpen !== undefined ? controlledOpen : internalOpen;

  const handleToggle = () => {
    const next = !isExpanded;
    if (controlledOpen === undefined) {
      setInternalOpen(next);
    }
    onToggle?.(next);
  };

  // 动作文案：纯正中性文字，若未传则生成简洁人话
  const displayActionText = useMemo(() => {
    if (actionText) return actionText;
    const lower = name.toLowerCase();
    if (lower.includes('search') || lower.includes('grep')) return 'Searched the docs';
    if (lower.includes('read') || lower.includes('view')) return 'Read file';
    if (lower.includes('write') || lower.includes('edit')) return 'Edited file';
    if (lower.includes('list') || lower.includes('dir')) return 'Listed directory';
    return name;
  }, [actionText, name]);

  const formattedRequest = useMemo(() => formatRequest(request), [request]);

  const isSuccess = status === 'success' || status === 'completed' || status === 'done';
  const isError = status === 'error' || status === 'failed';
  const isRunning = status === 'running';

  return (
    <div
      className={`${styles.jsonToolCall} ${className}`}
      data-tool-id={id}
      data-tool-status={status}
    >
      {/* 头部：可点击折叠/展开行 */}
      <button
        type="button"
        className={styles.jsonToolHead}
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-label={`${displayActionText} ${paramPill ? paramPill : ''}`}
      >
        <span className={`${styles.chevron} ${isExpanded ? styles.isOpen : ''}`}>
          <AppIcon name="chevron-right" size={14} aria-hidden="true" />
        </span>

        <span className={styles.actionText}>{displayActionText}</span>

        {paramPill ? (
          <Tooltip content={paramPill}>
            <span className={styles.paramPill}>
              {paramPill}
            </span>
          </Tooltip>
        ) : null}

        <span className={styles.statusIcon} aria-hidden="true">
          {isSuccess ? (
            <AppIcon name="check" size={13} className={styles.statusIconSuccess} />
          ) : isError ? (
            <AppIcon name="x" size={13} className={styles.statusIconError} />
          ) : isRunning ? (
            <span className={styles.pulseDot} />
          ) : null}
        </span>
      </button>

      {/* 展开卡片主体 */}
      {isExpanded ? (
        <div className={styles.jsonToolCard}>
          {/* Request 区域 */}
          <div className={styles.cardSection}>
            <div className={styles.sectionLabel}>Request</div>
            <pre className={styles.jsonCode}>{formattedRequest}</pre>
          </div>

          <div className={styles.divider} />

          {/* Result 区域 */}
          <div className={styles.cardSection}>
            <div className={styles.sectionLabel}>Result</div>
            <div className={styles.resultText}>
              {result !== undefined && result !== null && result !== ''
                ? result
                : '(no output)'}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
