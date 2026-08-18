import React, { useState, useMemo, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  List,
  Network,
  File,
  FileCode2,
  FileText,
  Image,
  Table,
} from 'lucide-react';
import { Button, Tooltip } from '../ui';
import type { GitStatusFile, GitTreeNode } from '../../api/gitTreeHelpers';
import { buildGitTree } from '../../api/gitTreeHelpers';
import { GitStatusBadge, DiffStatBar } from './GitStatusBadge';
import { detectFileKind } from '../../api/workspaceFsApi';
import { fileExtColor } from '../../api/codeHighlight';
import styles from './OverviewGitTree.module.css';

function FileIcon({ name }: { name: string }) {
  const k = detectFileKind(name);
  const color = fileExtColor(name);
  const sz = 14;
  if (k === 'image')
    return (
      <Image
        size={sz}
        className={styles.fileTypeIcon}
        style={{ color }}
        aria-hidden
      />
    );
  if (k === 'pdf')
    return (
      <FileText
        size={sz}
        className={styles.fileTypeIcon}
        style={{ color }}
        aria-hidden
      />
    );
  if (k === 'table')
    return (
      <Table
        size={sz}
        className={styles.fileTypeIcon}
        style={{ color }}
        aria-hidden
      />
    );
  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|css|html|json|md|yml|yaml)$/i.test(
      name
    )
  )
    return (
      <FileCode2
        size={sz}
        className={styles.fileTypeIcon}
        style={{ color }}
        aria-hidden
      />
    );
  return (
    <File
      size={sz}
      className={styles.fileTypeIcon}
      style={{ color }}
      aria-hidden
    />
  );
}

export interface OverviewGitTreeProps {
  files: GitStatusFile[];
  openingPath: string | null;
  onOpenFile: (file: GitStatusFile) => void;
  className?: string;
}

export const OverviewGitTree: React.FC<OverviewGitTreeProps> = React.memo(
  function OverviewGitTree({ files, openingPath, onOpenFile, className }) {
    const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
    const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
      () => new Set()
    );

    // 纯函数派生多叉树
    const treeData = useMemo(() => {
      return buildGitTree(files, { compactSingleChild: true });
    }, [files]);

    const toggleFolder = useCallback((folderId: string) => {
      setCollapsedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(folderId)) {
          next.delete(folderId);
        } else {
          next.add(folderId);
        }
        return next;
      });
    }, []);

    const isFolderExpanded = useCallback(
      (folderId: string) => !collapsedFolders.has(folderId),
      [collapsedFolders]
    );

    return (
      <div
        className={`${styles.treeContainer} ${className || ''}`}
        aria-label="工作区 Git 改动列表"
      >
        {/* 工具栏：模式切换与展开/收起 */}
        <div className={styles.treeHeader}>
          <div className={styles.treeStats}>
            <span className={styles.fileCountBadge}>
              {files.length} 个改动文件
            </span>
          </div>
          <div className={styles.treeControls}>
            <Tooltip
              content={
                viewMode === 'tree'
                  ? '切换为扁平扫描视图'
                  : '切换为树状层级视图'
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className={styles.modeToggleBtn}
                aria-label="切换树状/扁平视图"
                onClick={() =>
                  setViewMode(viewMode === 'tree' ? 'flat' : 'tree')
                }
                icon={
                  viewMode === 'tree' ? (
                    <List size={13} />
                  ) : (
                    <Network size={13} />
                  )
                }
              />
            </Tooltip>
          </div>
        </div>

        {/* 树状/扁平渲染视口 */}
        <div className={styles.treeViewport}>
          {viewMode === 'tree' ? (
            <div className={styles.treeList} role="tree">
              {treeData.map((node) => (
                <TreeNodeRenderer
                  key={node.id}
                  node={node}
                  openingPath={openingPath}
                  isFolderExpanded={isFolderExpanded}
                  onToggleFolder={toggleFolder}
                  onOpenFile={onOpenFile}
                />
              ))}
            </div>
          ) : (
            <div className={styles.flatList} role="list">
              {files.map((file) => (
                <FlatItemRenderer
                  key={file.path}
                  file={file}
                  opening={openingPath === file.path}
                  onOpenFile={onOpenFile}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
);

interface TreeNodeRendererProps {
  node: GitTreeNode;
  openingPath: string | null;
  isFolderExpanded: (id: string) => boolean;
  onToggleFolder: (id: string) => void;
  onOpenFile: (file: GitStatusFile) => void;
}

const TreeNodeRenderer: React.FC<TreeNodeRendererProps> = React.memo(
  function TreeNodeRenderer({
    node,
    openingPath,
    isFolderExpanded,
    onToggleFolder,
    onOpenFile,
  }) {
    const indentPx = node.depth * 12 + 4;

    if (node.isFolder) {
      const expanded = isFolderExpanded(node.id);
      return (
        <div
          className={styles.folderGroup}
          role="treeitem"
          aria-expanded={expanded}
        >
          <button
            type="button"
            className={styles.folderRow}
            style={{ paddingLeft: `${indentPx}px` }}
            onClick={() => onToggleFolder(node.id)}
          >
            <span className={styles.chevronIcon} aria-hidden>
              {expanded ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )}
            </span>
            <span className={styles.folderIcon} aria-hidden>
              {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
            </span>
            <Tooltip content={node.fullPath}>
              <span className={styles.folderName}>{node.name}</span>
            </Tooltip>
            <span className={styles.folderBadge}>{node.totalFiles}</span>
          </button>
          {expanded && (
            <div className={styles.folderChildren} role="group">
              {node.children.map((child) => (
                <TreeNodeRenderer
                  key={child.id}
                  node={child}
                  openingPath={openingPath}
                  isFolderExpanded={isFolderExpanded}
                  onToggleFolder={onToggleFolder}
                  onOpenFile={onOpenFile}
                />
              ))}
            </div>
          )}
        </div>
      );
    }

    const isOpening = openingPath === node.file.path;
    return (
      <div
        className={`${styles.fileRow} ${isOpening ? styles.isOpening : ''}`}
        style={{ paddingLeft: `${indentPx + 16}px` }}
        role="treeitem"
        onClick={() => onOpenFile(node.file)}
      >
        <GitStatusBadge
          status={node.file.status}
          conflicted={node.file.conflicted}
          staged={node.file.staged}
        />
        <FileIcon name={node.name} />
        <Tooltip content={node.file.path}>
          <span className={styles.fileName}>{node.name}</span>
        </Tooltip>
        <div className={styles.fileMetrics}>
          <DiffStatBar
            additions={node.file.additions || 0}
            deletions={node.file.deletions || 0}
          />
        </div>
      </div>
    );
  }
);

interface FlatItemRendererProps {
  file: GitStatusFile;
  opening: boolean;
  onOpenFile: (file: GitStatusFile) => void;
}

const FlatItemRenderer: React.FC<FlatItemRendererProps> = React.memo(
  function FlatItemRenderer({ file, opening, onOpenFile }) {
    const parts = file.path.replace(/\\/g, '/').split('/');
    const fileName = parts.pop() || file.path;
    const dirPath = parts.join('/');

    return (
      <div
        className={`${styles.fileRow} ${styles.flatRow} ${opening ? styles.isOpening : ''}`}
        role="listitem"
        onClick={() => onOpenFile(file)}
      >
        <GitStatusBadge
          status={file.status}
          conflicted={file.conflicted}
          staged={file.staged}
        />
        <FileIcon name={fileName} />
        <div className={styles.flatPathWrap}>
          <span className={styles.fileName}>{fileName}</span>
          {dirPath && <span className={styles.dirBreadcrumb}>{dirPath}</span>}
        </div>
        <div className={styles.fileMetrics}>
          <DiffStatBar
            additions={file.additions || 0}
            deletions={file.deletions || 0}
          />
        </div>
      </div>
    );
  }
);
