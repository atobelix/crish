import React, { useState, useMemo } from 'react';

import styles from './ChatToolCallBlock.module.css';
import { Button, Tooltip } from '../ui';
import type { FileDiff } from '../../store/types';
import { ToolCallDiffPreview } from './ToolCallDiffPreview';
import {
  parseFileStatOutput,
  parseReadFileOutput,
  parseGrepSearchOutput,
  parseListDirOutput,
  formatJsonIfApplicable,
} from './toolOutputParser';
import { isEditToolName } from '../../api/toolFeedbackDiff';
import { AppIcon } from '../ui/icons/index';

export interface ToolCallOutputPaneProps {
  toolId?: string;
  name?: string;
  output?: string;
  rawOutput?: string;
  status?: string;
  durationStr?: string | null;
  diffs?: FileDiff[];
  images?: string[];
  isTruncated?: boolean;
  totalLines?: number;
  totalBytes?: number;
  isSingleCard?: boolean;
  onOpenDiff?: (diff: FileDiff) => void;
  onOpenTerminal?: () => void;
}

export const ToolCallOutputPane: React.FC<ToolCallOutputPaneProps> = ({
  toolId,
  name,
  output = '',
  rawOutput,
  status = 'success',
  durationStr,
  diffs,
  images = [],
  isTruncated = false,
  totalLines = 0,
  totalBytes = 0,
  isSingleCard = false,
  onOpenDiff,
  onOpenTerminal,
}) => {
  const [copied, setCopied] = useState(false);
  const isError = status === 'error';
  const isRunning = status === 'running';
  const hasDiffs = Boolean(
    diffs && diffs.length > 0 && (!name || isEditToolName(name))
  );
  const hasImages = Boolean(images && images.length > 0);
  const emptyBody = !output && !hasDiffs && !hasImages;

  // 极简结构化解析
  const fileStat = useMemo(() => parseFileStatOutput(output), [output]);
  const readFile = useMemo(
    () => parseReadFileOutput(output, name),
    [output, name]
  );
  const grepSearch = useMemo(
    () => parseGrepSearchOutput(output, name),
    [output, name]
  );
  const listDir = useMemo(
    () => parseListDirOutput(output, name),
    [output, name]
  );

  const metaExtra = useMemo(() => {
    if (fileStat) {
      return `${fileStat.kindZh} · ${fileStat.sizeStr.split(' ')[0]}`;
    }
    if (readFile) {
      const parts: string[] = [];
      if (readFile.startLine !== undefined && readFile.endLine !== undefined) {
        parts.push(`L${readFile.startLine}–${readFile.endLine}`);
      }
      if (readFile.totalLines) {
        parts.push(`共 ${readFile.totalLines} 行`);
      }
      return parts.join(' · ');
    }
    if (grepSearch && !grepSearch.isEmpty) {
      const parts: string[] = [];
      if (grepSearch.matchCount !== undefined) {
        parts.push(`${grepSearch.matchCount} 处匹配`);
      }
      if (grepSearch.visitedFiles !== undefined) {
        parts.push(`扫描 ${grepSearch.visitedFiles} 文件`);
      }
      return parts.join(' · ');
    }
    return '';
  }, [fileStat, readFile, grepSearch]);

  const formattedOutput = useMemo(
    () => formatJsonIfApplicable(output),
    [output]
  );

  // 仅在非单卡模式（有“输出”标签）或存在明确状态标记（执行失败/执行中）时才渲染独立 header 行
  const showHeader = useMemo(() => {
    if (isError || isRunning) return true;
    if (!isSingleCard) return true;
    return false;
  }, [isError, isRunning, isSingleCard]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy = readFile?.code || formattedOutput;
    if (textToCopy) {
      void navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownloadLog = (e: React.MouseEvent) => {
    e.stopPropagation();
    const content = rawOutput || formattedOutput;
    if (!content) return;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tool-output-${toolId || 'log'}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      className={`${styles.toolSection} ${styles.toolSectionOutput} ${isError ? styles.isErrorSection : ''}`}
      aria-label="工具执行输出"
      data-tool-id={toolId}
    >
      {showHeader ? (
        <header className={styles.toolSectionHeader}>
          <div className={styles.toolSectionTitleGroup}>
            {!isSingleCard ? (
              <span
                className={`${styles.toolSectionBadge} ${styles.toolSectionBadgeOutput}`}
              >
                输出
              </span>
            ) : null}
            <span className={styles.toolSectionMeta}>
              {isRunning ? (
                <span className={styles.runningTag}>执行中</span>
              ) : isError ? (
                <span className={styles.errorTag}>执行失败</span>
              ) : null}
              {!isSingleCard && metaExtra ? ` · ${metaExtra}` : ''}
              {!isSingleCard && durationStr ? ` · ${durationStr}` : ''}
            </span>
          </div>
          <div className={styles.toolSectionActions}>
            {isTruncated ? (
              <Tooltip content="下载完整日志文件 (.log)">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.toolSectionActionBtn}
                  onClick={handleDownloadLog}
                  icon={<AppIcon name="download" size={12} />}
                >
                  下载日志
                </Button>
              </Tooltip>
            ) : null}
            {!emptyBody && formattedOutput && !hasDiffs && (!fileStat || !isSingleCard) ? (
              <Tooltip content={copied ? '已复制！' : '复制完整输出'}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.toolSectionActionBtn}
                  onClick={handleCopy}
                  icon={
                    copied ? (
                      <AppIcon name="check" size={12} className={styles.copiedIcon} />
                    ) : (
                      <AppIcon name="copy" size={12} />
                    )
                  }
                >
                  {copied ? '已复制' : '复制'}
                </Button>
              </Tooltip>
            ) : null}
          </div>
        </header>
      ) : isSingleCard && !fileStat && !emptyBody && formattedOutput && !hasDiffs ? (
        <div className={styles.toolFloatingActions}>
          {isTruncated ? (
            <Tooltip content="下载完整日志文件 (.log)">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.toolSectionActionBtn}
                onClick={handleDownloadLog}
                icon={<AppIcon name="download" size={12} />}
              >
                下载日志
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip content={copied ? '已复制！' : '复制完整输出'}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.toolSectionActionBtn}
              onClick={handleCopy}
              icon={
                copied ? (
                  <AppIcon name="check" size={12} className={styles.copiedIcon} />
                ) : (
                  <AppIcon name="copy" size={12} />
                )
              }
            >
              {copied ? '已复制' : '复制'}
            </Button>
          </Tooltip>
        </div>
      ) : null}

      <div className={styles.toolSectionContent}>
        {hasDiffs
          ? diffs!.map((d) => (
              <ToolCallDiffPreview
                key={d.filePath}
                diff={d}
                onOpenDiff={onOpenDiff}
                className={styles.embeddedDiffCard}
                cardVariant="embedded"
              />
            ))
          : null}

        {hasImages ? (
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
        ) : null}

        {emptyBody || (grepSearch && grepSearch.isEmpty) || (listDir && listDir.isEmpty) ? (
          <div className={styles.emptyOutputBlock}>
            <span>
              {grepSearch && grepSearch.isEmpty
                ? '（未找到匹配项）'
                : listDir && listDir.isEmpty
                  ? '（空目录）'
                  : '（无输出）'}
            </span>
          </div>
        ) : null}

        {!emptyBody && !hasDiffs ? (
          fileStat ? (
            <div className={styles.fileStatCard}>
              <div className={styles.fileStatRow}>
                <div className={styles.fileStatTitle}>{fileStat.path}</div>
                {isSingleCard ? (
                  <Tooltip content={copied ? '已复制！' : '复制文件信息'}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={styles.toolSectionActionBtn}
                      onClick={handleCopy}
                      icon={
                        copied ? (
                          <AppIcon name="check" size={12} className={styles.copiedIcon} />
                        ) : (
                          <AppIcon name="copy" size={12} />
                        )
                      }
                    >
                      {copied ? '已复制' : '复制'}
                    </Button>
                  </Tooltip>
                ) : null}
              </div>
              <div className={styles.fileStatMeta}>
                <span>{fileStat.kindZh}</span>
                <span className={styles.fileStatDot}>·</span>
                <span>{fileStat.sizeStr}</span>
                <span className={styles.fileStatDot}>·</span>
                <span>{fileStat.readonly ? '只读' : '可读写'}</span>
                <span className={styles.fileStatDot}>·</span>
                <span>{fileStat.mtimeStr}</span>
              </div>
            </div>
          ) : readFile ? (
            <div className={styles.readFileContainer}>
              <pre className={styles.toolOutputCode}>{readFile.code}</pre>
              {readFile.remainingLines ? (
                <div className={styles.codeMetaNotice}>
                  … 剩余 {readFile.remainingLines} 行未显示
                </div>
              ) : null}
            </div>
          ) : grepSearch && !grepSearch.isEmpty ? (
            <div className={styles.grepMatchList}>
              {grepSearch.matches.map((m, idx) => (
                <div key={idx} className={styles.grepMatchRow}>
                  <span className={styles.grepLineFull}>{m.filePath ? <span className={styles.grepMatchLoc}>{m.filePath}{m.line ? `:${m.line}:` : ':'}</span> : null}<span className={styles.grepMatchText}>{m.text}</span></span>
                </div>
              ))}
            </div>
          ) : listDir && !listDir.isEmpty ? (
            <div className={styles.dirList}>
              {listDir.items.map((item, idx) => (
                <div key={idx} className={styles.dirListItem}>
                  <span className={item.isDir ? styles.dirListIsDir : undefined}>
                    {item.isDir ? `/${item.name}` : item.name}
                  </span>
                </div>
              ))}
            </div>
          ) : formattedOutput ? (
            <pre className={styles.toolOutputCode}>{formattedOutput}</pre>
          ) : null
        ) : null}

        {isTruncated ? (
          <div className={styles.outputTruncatedBar}>
            <span className={styles.truncNotice}>
              输出已超过 2000 行 / 256KB 保护门限，行内仅保留轻量视口
            </span>
            {onOpenTerminal ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className={styles.openInspectorBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenTerminal();
                }}
                icon={<AppIcon name="terminal" size={12} />}
              >
                在命令检查器中查看完整日志
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
};
