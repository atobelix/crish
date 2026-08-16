import React, { useState } from 'react';
import {
  Copy,
  Check,
  Download,
  AlertTriangle,
  Terminal,
  CheckCircle2,
} from 'lucide-react';
import styles from './ChatToolCallBlock.module.css';
import { Button, Tooltip } from '../ui';
import type { FileDiff } from '../../store/types';
import { ToolCallDiffPreview } from './ToolCallDiffPreview';

export interface ToolCallOutputPaneProps {
  toolId?: string;
  output?: string;
  rawOutput?: string;
  status?: string;
  durationStr?: string | null;
  diffs?: FileDiff[];
  images?: string[];
  isTruncated?: boolean;
  totalLines?: number;
  totalBytes?: number;
  onOpenDiff?: (diff: FileDiff) => void;
  onOpenTerminal?: () => void;
}

export const ToolCallOutputPane: React.FC<ToolCallOutputPaneProps> = ({
  toolId,
  output = '',
  rawOutput,
  status = 'success',
  durationStr,
  diffs,
  images = [],
  isTruncated = false,
  totalLines = 0,
  totalBytes = 0,
  onOpenDiff,
  onOpenTerminal,
}) => {
  const [copied, setCopied] = useState(false);
  const isError = status === 'error';
  const isRunning = status === 'running';
  const hasDiffs = Boolean(diffs && diffs.length > 0);
  const hasImages = Boolean(images && images.length > 0);
  const emptyBody = !output && !hasDiffs && !hasImages;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (output) {
      void navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownloadLog = (e: React.MouseEvent) => {
    e.stopPropagation();
    const content = rawOutput || output;
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
      <header className={styles.toolSectionHeader}>
        <div className={styles.toolSectionTitleGroup}>
          <span
            className={`${styles.toolSectionBadge} ${styles.toolSectionBadgeOutput}`}
          >
            📤 输出
          </span>
          <span className={styles.toolSectionMeta}>
            {isRunning ? (
              <span className={styles.runningTag}>⏳ 执行中…</span>
            ) : isError ? (
              <span className={styles.errorTag}>✕ 执行失败</span>
            ) : (
              <span className={styles.successTag}>✓ 执行成功</span>
            )}
            {durationStr ? ` · ${durationStr}` : ''}
            {totalLines > 0 ? ` · ${totalLines} 行` : ''}
            {totalBytes > 0 ? ` · ${(totalBytes / 1024).toFixed(1)} KB` : ''}
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
                icon={<Download size={12} />}
              >
                下载日志
              </Button>
            </Tooltip>
          ) : null}
          {!emptyBody && output ? (
            <Tooltip content={copied ? '已复制！' : '复制完整输出'}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.toolSectionActionBtn}
                onClick={handleCopy}
                icon={
                  copied ? (
                    <Check size={12} className={styles.copiedIcon} />
                  ) : (
                    <Copy size={12} />
                  )
                }
              >
                {copied ? '已复制' : '复制'}
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </header>

      {isError ? (
        <div className={styles.diagnosticBanner}>
          <AlertTriangle size={14} className={styles.diagIcon} aria-hidden />
          <span className={styles.diagText}>
            执行遇到异常中断，详情见下方 Stderr / 输出日志
          </span>
        </div>
      ) : null}

      <div className={styles.toolSectionContent}>
        {hasDiffs
          ? diffs!.map((d) => (
              <ToolCallDiffPreview
                key={d.filePath}
                diff={d}
                onOpenDiff={onOpenDiff}
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

        {emptyBody ? (
          <div className={styles.emptyOutputBlock}>
            <CheckCircle2 size={13} className={styles.emptySuccessIcon} />
            <span>执行成功，无返回内容</span>
          </div>
        ) : null}

        {!emptyBody && output ? (
          <pre className={styles.toolOutputCode}>{output}</pre>
        ) : null}

        {isTruncated ? (
          <div className={styles.outputTruncatedBar}>
            <span className={styles.truncNotice}>
              ⚠️ 输出已超过 2000 行 / 256KB 保护门限，行内仅保留轻量视口
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
                icon={<Terminal size={12} />}
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
