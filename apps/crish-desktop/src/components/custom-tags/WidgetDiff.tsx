import React, { useState, useMemo, type ReactNode } from 'react';
import styles from './custom-tags.module.css';
import { CustomTagErrorBoundary } from './CustomTagErrorBoundary';
import type { ExtraComponentProps } from './CustomTagRegistry';
import { Button, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { escapeHtml, langFromFilename } from '../../api/codeHighlight';
import {
  useDiffHighlightMap,
  type DiffHighlightItem,
} from '../../api/codeHighlightBatch';
import { parseDiffText, buildSplitLinePairs } from '../../api/diffPairMatcher';

export interface WidgetDiffProps extends ExtraComponentProps {
  from?: string;
  to?: string;
  mode?: 'unified' | 'split';
  title?: string;
  children?: ReactNode;
}

export const WidgetDiffInner: React.FC<WidgetDiffProps> = ({
  from,
  to,
  mode: initialMode = 'unified',
  title,
  isStreaming = false,
  children,
  onAgentAction,
  messageId,
}) => {
  const [viewMode, setViewMode] = useState<'unified' | 'split'>(initialMode);
  const [copied, setCopied] = useState(false);

  const rawDiffText = useMemo(() => {
    if (typeof children === 'string') return children;
    if (Array.isArray(children)) {
      return children.map((c) => (typeof c === 'string' ? c : '')).join('');
    }
    return '';
  }, [children]);

  // 消费公共 diffPairMatcher 单真源
  const parsedLines = useMemo(() => parseDiffText(rawDiffText), [rawDiffText]);
  const splitPairs = useMemo(() => buildSplitLinePairs(parsedLines), [parsedLines]);

  const codeLang = useMemo(() => {
    const targetPath = to || from || '';
    return langFromFilename(targetPath);
  }, [to, from]);

  // D8.3：WidgetDiff 行批高亮（主路径 highlight.batch）
  const hlItems = useMemo<DiffHighlightItem[]>(() => {
    const out: DiffHighlightItem[] = [];
    parsedLines.forEach((line, idx) => {
      if (line.type === 'header') return;
      out.push({ id: `u:${idx}`, code: line.text, language: codeLang });
    });
    splitPairs.forEach((pair, idx) => {
      if (pair.isHeader) return;
      if (pair.left) {
        out.push({ id: `s:${idx}:L`, code: pair.left.text, language: codeLang });
      }
      if (pair.right) {
        out.push({ id: `s:${idx}:R`, code: pair.right.text, language: codeLang });
      }
    });
    return out;
  }, [parsedLines, splitPairs, codeLang]);
  const hlMap = useDiffHighlightMap(hlItems);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawDiffText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard fallback
    }
  };

  const handleAccept = () => {
    onAgentAction?.('accept_diff', { from, to, title, messageId });
  };

  const handleReject = () => {
    onAgentAction?.('reject_diff', { from, to, title, messageId });
  };

  const displayTitle = title || from || to || '代码审查比对';

  return (
    <div className={styles.widgetDiff} data-streaming={isStreaming ? 'true' : 'false'}>
      <div className={styles.cardHeader}>
        <div className={styles.cardTitleGroup}>
          {isStreaming ? (
            <Tooltip content="正在流式生成比对...">
              <span className={styles.statusRunning} aria-label="正在流式生成比对" />
            </Tooltip>
          ) : (
            <AppIcon name="file-diff" size={14} aria-hidden />
          )}
          <span className={styles.cardTitle}>{displayTitle}</span>
        </div>

        <div className={styles.cardActions}>
          <div className={styles.diffModeGroup}>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={`${styles.diffModeBtn} ${viewMode === 'unified' ? styles.active : ''}`}
              onClick={() => setViewMode('unified')}
            >
              单栏比对
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={`${styles.diffModeBtn} ${viewMode === 'split' ? styles.active : ''}`}
              onClick={() => setViewMode('split')}
            >
              分栏比对
            </Button>
          </div>

          <Tooltip content="复制 Diff 文本">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={styles.actionBtn}
              onClick={handleCopy}
            >
              {copied ? '已复制' : '复制'}
            </Button>
          </Tooltip>

          {onAgentAction && (
            <>
              <Tooltip content="采纳本次代码变更">
                <Button
                  type="button"
                  variant="primary"
                  size="xs"
                  className={`${styles.actionBtn} ${styles.primary}`}
                  onClick={handleAccept}
                >
                  采纳
                </Button>
              </Tooltip>
              <Tooltip content="拒绝本次代码变更">
                <Button
                  type="button"
                  variant="danger"
                  size="xs"
                  className={`${styles.actionBtn} ${styles.danger}`}
                  onClick={handleReject}
                >
                  拒绝
                </Button>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      <div className={styles.diffContainer}>
        {viewMode === 'unified' ? (
          <div>
            {parsedLines.map((line, idx) => {
              if (line.type === 'header') {
                return (
                  <div key={idx} className={styles.diffLineHeader}>
                    <span className={styles.diffLineContent}>{line.text}</span>
                  </div>
                );
              }

              let lineClass = styles.diffLineContext;
              let prefix = ' ';
              if (line.type === 'add') {
                lineClass = styles.diffLineAdd;
                prefix = '+';
              } else if (line.type === 'delete') {
                lineClass = styles.diffLineDelete;
                prefix = '-';
              }

              return (
                <div key={idx} className={lineClass}>
                  <span className={styles.diffLineNum}>
                    {line.newNum ?? line.oldNum ?? ''}
                  </span>
                  <span className={styles.diffMarker}>{prefix}</span>
                  <span
                    className={styles.diffLineContent}
                    dangerouslySetInnerHTML={{
                      __html: hlMap.get(`u:${idx}`) ?? escapeHtml(line.text),
                    }}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className={styles.diffSplitLayout}>
            <div className={styles.diffSplitHeaderRow}>
              <div className={styles.diffSplitColHeader}>Original ({from || 'Base'})</div>
              <div className={styles.diffSplitColHeader}>Modified ({to || 'Target'})</div>
            </div>
            {splitPairs.map((pair, idx) => {
              const { left, right, isHeader } = pair;

              if (isHeader && left) {
                return (
                  <div key={idx} className={styles.diffSplitHeaderSpanRow}>
                    <span className={styles.diffLineContent}>{left.text}</span>
                  </div>
                );
              }

              return (
                <div key={idx} className={styles.diffSplitLineRow}>
                  {/* 左侧 */}
                  <div
                    className={`${styles.diffSplitColCell} ${
                      !left
                        ? styles.diffLineEmpty
                        : left.type === 'delete'
                          ? styles.diffLineDelete
                          : styles.diffLineContext
                    }`}
                  >
                    <span className={styles.diffLineNum}>{left?.oldNum ?? ''}</span>
                    <span className={styles.diffMarker}>{left ? (left.type === 'delete' ? '-' : ' ') : ''}</span>
                    <span
                      className={styles.diffLineContent}
                      dangerouslySetInnerHTML={{
                        __html: left
                          ? (hlMap.get(`s:${idx}:L`) ?? escapeHtml(left.text))
                          : '',
                      }}
                    />
                  </div>

                  {/* 右侧 */}
                  <div
                    className={`${styles.diffSplitColCell} ${
                      !right
                        ? styles.diffLineEmpty
                        : right.type === 'add'
                          ? styles.diffLineAdd
                          : styles.diffLineContext
                    }`}
                  >
                    <span className={styles.diffLineNum}>{right?.newNum ?? ''}</span>
                    <span className={styles.diffMarker}>{right ? (right.type === 'add' ? '+' : ' ') : ''}</span>
                    <span
                      className={styles.diffLineContent}
                      dangerouslySetInnerHTML={{
                        __html: right
                          ? (hlMap.get(`s:${idx}:R`) ?? escapeHtml(right.text))
                          : '',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export const WidgetDiff: React.FC<WidgetDiffProps> = (props) => (
  <CustomTagErrorBoundary tagName="widget-diff">
    <WidgetDiffInner {...props} />
  </CustomTagErrorBoundary>
);
