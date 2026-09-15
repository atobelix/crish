import React, { useState, useMemo } from 'react';
import type { FileDiff } from '../../store/types';
import styles from './ModernToolCall.module.css';
import { escapeHtml, langFromFilename } from '../../api/codeHighlight';
import {
  useDiffHighlightMap,
  type DiffHighlightItem,
} from '../../api/codeHighlightBatch';
import { Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { useTransientFlag } from '../../hooks/useTransientFlag';

export interface ToolCallDiffPreviewProps {
  diff: FileDiff;
  onOpenDiff?: ((diff: FileDiff) => void) | undefined;
  className?: string;
  /** 嵌入变体标记：写入 data-card-variant，供 ChatToolCallBlock 内嵌样式提升特异性（替代 !important） */
  cardVariant?: string;
}

export const DIFF_FLAT_PREVIEW_LIMIT = 24;
export const DIFF_FLAT_EXPAND_MAX = 200;

/**
 * 专有 Diff 差异比对卡片（简洁平铺视图与单一滚动宿主合规）
 * 包含：文件头 + 行号与符号三列对齐 + 增删统计药丸 + 专属防误触复制 + 平铺展开
 * 绝无内部嵌套第二重纵向滚动条，卡片高度完全自适应融入文档流
 */
export const ToolCallDiffPreview: React.FC<ToolCallDiffPreviewProps> = ({
  diff,
  onOpenDiff,
  className = '',
  cardVariant,
}) => {
  // 复制反馈瞬态位：定时器由 useTransientFlag 统一持有并在卸载时清除
  const { flag: copied, trigger: triggerCopied } = useTransientFlag(1500);
  const [showAll, setShowAll] = useState(false);

  const codeLang = useMemo(() => langFromFilename(diff.filePath), [diff.filePath]);

  const changes = diff.changes || [];
  const hasMore = changes.length > DIFF_FLAT_PREVIEW_LIMIT;
  const isCapped = showAll && changes.length > DIFF_FLAT_EXPAND_MAX;
  const displayedChanges = !hasMore
    ? changes
    : showAll
      ? changes.slice(0, DIFF_FLAT_EXPAND_MAX)
      : changes.slice(0, DIFF_FLAT_PREVIEW_LIMIT);

  // D8.3：平铺可见行走 highlight.batch（短 sync / 长 worker）
  const hlItems = useMemo<DiffHighlightItem[]>(
    () =>
      displayedChanges.map((change, i) => ({
        id: `${diff.filePath}:flat:${i}`,
        code: change.content,
        language: codeLang,
      })),
    [displayedChanges, diff.filePath, codeLang],
  );
  const hlMap = useDiffHighlightMap(hlItems);

  const handleCopyDiff = (e: React.MouseEvent) => {
    e.stopPropagation();
    const unifiedText = changes
      .map((c) => {
        const prefix = c.type === 'addition' ? '+' : c.type === 'deletion' ? '-' : ' ';
        return `${prefix} ${c.content}`;
      })
      .join('\n');
    void navigator.clipboard.writeText(unifiedText);
    triggerCopied();
  };

  const handleOpenDiff = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    onOpenDiff?.(diff);
  };

  return (
    <div
      className={`${styles.diffCard} ${className}`}
      data-card-variant={cardVariant}
      key={diff.filePath}
    >
      {/* 卡片头部 */}
      <div
        className={styles.diffCardHeader}
        onClick={handleOpenDiff}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleOpenDiff();
          }
        }}
        aria-label={`查看差异：${diff.filePath}`}
      >
        <div className={styles.diffFileInfo}>
          <AppIcon name="file-code" size={15} className={styles.diffFileIcon} aria-hidden="true" />
          <Tooltip content={diff.filePath}>
            <span className={styles.diffFilename}>{diff.filePath}</span>
          </Tooltip>
        </div>

        <div className={styles.diffRightSection}>
          {/* +A -R 变动统计 */}
          <div className={styles.diffBadge}>
            <span className={styles.diffStatAdd}>+{diff.additions}</span>
            <span className={styles.diffStatDel}>-{diff.deletions}</span>
          </div>

          <div className={styles.diffActions}>
            {/* 复制纯净 Diff 按钮 */}
            <Tooltip content={copied ? '已复制差异' : '复制差异'}>
              <button
                type="button"
                className={styles.diffCopyBtn}
                onClick={handleCopyDiff}
                aria-label="复制差异内容"
              >
                {copied ? (
                  <AppIcon name="check" size={13} className={styles.copiedCheckIcon} />
                ) : (
                  <AppIcon name="copy" size={13} />
                )}
              </button>
            </Tooltip>

            {/* 在右侧打开 */}
            {onOpenDiff && (
              <Tooltip content="在右侧面板查看完整差异">
                <button
                  type="button"
                  className={styles.diffPreviewTag}
                  onClick={handleOpenDiff}
                  aria-label="在右侧面板查看完整差异"
                >
                  <span>在右侧查看</span>
                  <AppIcon name="external-link" size={11} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      {/* 简洁平铺视图：行号对齐 + 符号列 + 语法高亮代码列 */}
      <div className={styles.diffLinesContainer}>
        {displayedChanges.map((change, i) => {
          const sign =
            change.type === 'addition'
              ? '+'
              : change.type === 'deletion'
                ? '-'
                : ' ';
          const lineNum = change.lineNum ?? i + 1;

          return (
            <div
              key={i}
              className={`${styles.diffLineRow} ${styles[change.type] || change.type}`}
            >
              {/* 行号列 */}
              <div className={styles.diffGutterCol} aria-hidden="true">
                {lineNum}
              </div>
              {/* 符号列 */}
              <div className={styles.diffSignCol} aria-hidden="true">
                {sign}
              </div>
              {/* 代码列 */}
              <pre
                className={styles.diffLineContent}
                dangerouslySetInnerHTML={{
                  __html:
                    hlMap.get(`${diff.filePath}:flat:${i}`) ??
                    escapeHtml(change.content),
                }}
              />
            </div>
          );
        })}

        {/* 超过平铺门限时的平铺控制栏 */}
        {hasMore && (
          <div className={styles.diffMoreIndicator}>
            {!showAll ? (
              <button
                type="button"
                className={styles.diffMoreBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAll(true);
                }}
                aria-label={`平铺展开剩余 ${changes.length - DIFF_FLAT_PREVIEW_LIMIT} 行`}
              >
                平铺展开剩余 {changes.length - DIFF_FLAT_PREVIEW_LIMIT} 行
              </button>
            ) : (
              <button
                type="button"
                className={styles.diffMoreBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAll(false);
                }}
                aria-label="收起部分平铺行"
              >
                收起平铺行
              </button>
            )}

            {isCapped && (
              <span className={styles.diffMoreBtn} style={{ opacity: 0.8 }}>
                已展示前 {DIFF_FLAT_EXPAND_MAX} 行（共 {changes.length} 行）
              </span>
            )}

            {onOpenDiff && (
              <button
                type="button"
                className={styles.diffMoreBtn}
                onClick={handleOpenDiff}
                aria-label="点击在右侧查看完整 diff"
              >
                还有 {changes.length - (showAll ? 0 : DIFF_FLAT_PREVIEW_LIMIT)} 行 · 点击在右侧查看完整 diff
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const DiffCard = ToolCallDiffPreview;
