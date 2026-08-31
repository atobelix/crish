import React, { useMemo, useState } from 'react';
import {
  File,
  FileCode2,
  FileText,
  Image,
  Table,
} from 'lucide-react';
import { Button, Tooltip } from '../ui';
import type { GitStatusFile } from '../../api/gitTreeHelpers';
import { GitStatusBadge, DiffStatBar } from './GitStatusBadge';
import { detectFileKind } from '../../api/workspaceFsApi';
import { fileExtColor } from '../../api/codeHighlight';
import styles from './OverviewChangesList.module.css';

function FileIcon({ name }: { name: string }) {
  const k = detectFileKind(name);
  const color = fileExtColor(name);
  const sz = 14;
  if (k === 'image') {
    return (
      <Image
        size={sz}
        className={styles.fileTypeIcon}
        style={{ color }}
        aria-hidden
      />
    );
  }
  if (k === 'pdf') {
    return (
      <FileText
        size={sz}
        className={styles.fileTypeIcon}
        style={{ color }}
        aria-hidden
      />
    );
  }
  if (k === 'table') {
    return (
      <Table
        size={sz}
        className={styles.fileTypeIcon}
        style={{ color }}
        aria-hidden
      />
    );
  }
  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|css|html|json|md|yml|yaml)$/i.test(
      name
    )
  ) {
    return (
      <FileCode2
        size={sz}
        className={styles.fileTypeIcon}
        style={{ color }}
        aria-hidden
      />
    );
  }
  return (
    <File
      size={sz}
      className={styles.fileTypeIcon}
      style={{ color }}
      aria-hidden
    />
  );
}

export interface OverviewChangesListProps {
  files: GitStatusFile[];
  openingPath: string | null;
  onOpenFile: (file: GitStatusFile) => void;
  maxInitialFiles?: number;
  className?: string;
}

export const OverviewChangesList: React.FC<OverviewChangesListProps> = React.memo(
  function OverviewChangesList({
    files,
    openingPath,
    onOpenFile,
    maxInitialFiles = 8,
    className,
  }) {
    const [showAll, setShowAll] = useState(false);

    // 解析扁平路径：拆分为文件名与父目录注记
    const parsedFiles = useMemo(() => {
      return files.map((file) => {
        const normalized = file.path.replace(/\\/g, '/');
        const lastSlashIndex = normalized.lastIndexOf('/');
        const fileName =
          lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
        const dirPath =
          lastSlashIndex >= 0 ? normalized.slice(0, lastSlashIndex) : '';
        return {
          file,
          fileName: fileName || file.path,
          dirPath,
        };
      });
    }, [files]);

    const isOverLimit = files.length > maxInitialFiles;
    const displayedFiles =
      isOverLimit && !showAll
        ? parsedFiles.slice(0, maxInitialFiles)
        : parsedFiles;

    return (
      <div
        className={`${styles.changesContainer} ${className || ''}`}
        aria-label="改动文件列表"
      >
        <ul className={styles.changesList} role="list">
          {displayedFiles.map(({ file, fileName, dirPath }) => {
            const isOpening = openingPath === file.path;
            const statusText = file.status;
            const diffAria = `${file.additions ? `+${file.additions}` : ''} ${file.deletions ? `-${file.deletions}` : ''}`.trim();
            const fullAriaLabel = `${fileName}, ${statusText}${diffAria ? `, ${diffAria}` : ''}`;

            return (
              <li key={file.path} className={styles.changesItem}>
                <button
                  type="button"
                  className={`${styles.changesItemBtn} ${isOpening ? styles.isOpening : ''}`}
                  onClick={() => onOpenFile(file)}
                  aria-label={fullAriaLabel}
                >
                  <GitStatusBadge
                    status={file.status}
                    conflicted={file.conflicted}
                    staged={file.staged}
                  />
                  <FileIcon name={fileName} />
                  <Tooltip content={file.path}>
                    <span className={styles.fileName}>{fileName}</span>
                  </Tooltip>
                  {dirPath ? (
                    <span className={styles.dirBreadcrumb}>
                      {dirPath}
                    </span>
                  ) : null}
                  <div className={styles.fileMetrics}>
                    <DiffStatBar
                      additions={file.additions || 0}
                      deletions={file.deletions || 0}
                    />
                  </div>
                </button>
              </li>
            );
          })}
        </ul>

        {isOverLimit ? (
          <div className={styles.moreActionRow}>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={styles.moreBtn}
              onClick={() => setShowAll((prev) => !prev)}
            >
              {showAll ? '收起改动文件' : `显示全部 ${files.length} 个文件`}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
);
