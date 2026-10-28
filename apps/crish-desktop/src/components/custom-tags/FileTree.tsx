/**
 * FileTree.tsx
 *
 * <file-tree> 工程文件树卡片
 *
 * 核心能力：
 * 1. 层级树形折叠：根据缩进或路径解析生成文件树，支持多级展开与折叠；
 * 2. IPC 文件定位：点击文件节点通过 onAgentAction 调起宿主 IDE 定位；
 * 3. 状态标识：展示文件状态徽标（A 新增 / M 修改 / D 删除）；
 * 4. 变量驱动缩进：通过 --tree-level CSS 变量驱动缩进，零内联魔法数字与零裸色。
 */

import React, { useState, useMemo, type ReactNode } from 'react';
import styles from './custom-tags.module.css';
import { CustomTagErrorBoundary } from './CustomTagErrorBoundary';
import type { ExtraComponentProps } from './CustomTagRegistry';
import { Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';

export interface FileTreeProps extends ExtraComponentProps {
  root?: string;
  expandLevel?: number;
  showStatus?: boolean;
  children?: ReactNode;
  onSelectFile?: (path: string) => void;
}

interface TreeNode {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  level: number;
  status?: 'added' | 'modified' | 'deleted';
  children: TreeNode[];
}

function parseTreeFromText(rawText: string, rootDir: string): TreeNode[] {
  const lines = rawText
    .split('\n')
    .map((l) => l.replace(/\r/g, ''))
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) return [];

  const rootNodes: TreeNode[] = [];
  const stack: { node: TreeNode; indent: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    // 计算前导空格数
    const matchIndent = rawLine.match(/^(\s*)/);
    const indent = matchIndent ? matchIndent[1]!.length : 0;
    const trimmed = rawLine.trim();

    // 提取状态后缀如 (modified), (added), (deleted) 或 [M], [A], [D]
    let status: 'added' | 'modified' | 'deleted' | undefined;
    let cleanName = trimmed;

    if (/\((added|new)\)|\[A\]/i.test(cleanName)) {
      status = 'added';
      cleanName = cleanName.replace(/\((added|new)\)|\[A\]/gi, '').trim();
    } else if (/\((modified|updated)\)|\[M\]/i.test(cleanName)) {
      status = 'modified';
      cleanName = cleanName
        .replace(/\((modified|updated)\)|\[M\]/gi, '')
        .trim();
    } else if (/\((deleted|removed)\)|\[D\]/i.test(cleanName)) {
      status = 'deleted';
      cleanName = cleanName.replace(/\((deleted|removed)\)|\[D\]/gi, '').trim();
    }

    const isFolder =
      cleanName.endsWith('/') ||
      cleanName.includes('/') ||
      (!cleanName.includes('.') && i < lines.length - 1);
    const nodeName = cleanName.replace(/\/$/, '');

    // 构建相对全路径
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop();
    }

    const parentPath =
      stack.length > 0 ? stack[stack.length - 1]!.node.path : rootDir;
    const currentPath =
      parentPath === '.' ? nodeName : `${parentPath}/${nodeName}`;

    const newNode: TreeNode = {
      id: `${currentPath}-${i}`,
      name: nodeName,
      path: currentPath,
      isFolder,
      level: stack.length,
      status,
      children: [],
    };

    if (stack.length > 0) {
      stack[stack.length - 1]!.node.children.push(newNode);
    } else {
      rootNodes.push(newNode);
    }

    if (isFolder) {
      stack.push({ node: newNode, indent });
    }
  }

  return rootNodes;
}

export const FileTreeInner: React.FC<FileTreeProps> = ({
  root = '.',
  expandLevel = 2,
  showStatus = true,
  isStreaming = false,
  children,
  onAgentAction,
  onSelectFile,
}) => {
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});

  const rawText = useMemo(() => {
    if (typeof children === 'string') {
      return children;
    }
    if (Array.isArray(children)) {
      return children.map((c) => (typeof c === 'string' ? c : '')).join('\n');
    }
    return '';
  }, [children]);

  const treeNodes = useMemo(() => {
    return parseTreeFromText(rawText, root);
  }, [rawText, root]);

  const toggleCollapse = (nodeId: string) => {
    setCollapsedMap((prev) => ({
      ...prev,
      [nodeId]: !prev[nodeId],
    }));
  };

  const handleFileClick = (node: TreeNode) => {
    if (node.isFolder) {
      toggleCollapse(node.id);
    } else {
      onSelectFile?.(node.path);
      onAgentAction?.('open_file', { path: node.path });
    }
  };

  const renderNode = (node: TreeNode) => {
    const isCollapsed =
      collapsedMap[node.id] !== undefined
        ? collapsedMap[node.id]
        : node.level >= expandLevel;

    return (
      <div key={node.id} className={styles.fileTreeItem}>
        <div
          className={styles.fileTreeNode}
          style={{ '--tree-level': node.level } as React.CSSProperties}
          onClick={() => handleFileClick(node)}
          data-file-path={node.path}
        >
          <span className={styles.fileTreeNodeIcon}>
            <AppIcon
              name={
                node.isFolder
                  ? isCollapsed
                    ? 'folder'
                    : 'folder-open'
                  : 'file-text'
              }
              size={14}
              aria-hidden
            />
          </span>
          <span className={styles.fileTreeNodeName}>{node.name}</span>

          {showStatus && node.status && (
            <span
              className={
                node.status === 'added'
                  ? styles.statusAdded
                  : node.status === 'modified'
                    ? styles.statusModified
                    : styles.statusDeleted
              }
            >
              {node.status === 'added'
                ? 'A'
                : node.status === 'modified'
                  ? 'M'
                  : 'D'}
            </span>
          )}
        </div>

        {node.isFolder && !isCollapsed && node.children.length > 0 && (
          <div className={styles.fileTreeChildren}>
            {node.children.map((child) => renderNode(child))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={styles.fileTree}
      data-streaming={isStreaming ? 'true' : 'false'}
    >
      <div className={styles.cardHeader}>
        <div className={styles.cardTitleGroup}>
          <AppIcon name="folder-tree" size={14} aria-hidden />
          <span className={styles.cardTitle}>
            {root === '.' ? '工程文件树' : root}
          </span>
        </div>
        {isStreaming && (
          <Tooltip content="正在加载工程树...">
            <div className={styles.statusRunning} aria-label="正在加载工程树" />
          </Tooltip>
        )}
      </div>

      <div className={styles.fileTreeBody}>
        {treeNodes.length > 0 ? (
          treeNodes.map((node) => renderNode(node))
        ) : (
          <div className={styles.fileTreeEmpty}>{rawText || '空文件树'}</div>
        )}
      </div>
    </div>
  );
};

export const FileTree: React.FC<FileTreeProps> = (props) => (
  <CustomTagErrorBoundary tagName="file-tree">
    <FileTreeInner {...props} />
  </CustomTagErrorBoundary>
);
