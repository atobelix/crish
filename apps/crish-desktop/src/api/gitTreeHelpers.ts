/**
 * Git 变动文件状态数据契约与增删微条纯函数算法
 * 文件路径：apps/crish-desktop/src/api/gitTreeHelpers.ts
 */

/**
 * Git 状态单字符标准代码
 */
export type GitStatusCode = 'M' | 'A' | 'D' | 'U' | 'C' | 'R' | '?';

/**
 * Git 文件状态数据契约
 */
export interface GitStatusFile {
  path: string;
  status: GitStatusCode;
  additions?: number;
  deletions?: number;
  conflicted?: boolean;
  staged?: boolean;
}

/**
 * 增删统计微条度量契约
 */
export interface DiffStatMetric {
  additions: number;
  deletions: number;
  maxBars?: number; // 默认 5 格
}

export interface DiffStatBarsResult {
  addBars: number;
  delBars: number;
  emptyBars: number;
}

/**
 * 计算增删比例微条格数
 */
export function calculateDiffStatBars(
  additions: number,
  deletions: number,
  maxBars: number = 5
): DiffStatBarsResult {
  const safeAdd = Math.max(0, additions || 0);
  const safeDel = Math.max(0, deletions || 0);
  const total = safeAdd + safeDel;
  if (total === 0 || maxBars <= 0) {
    return { addBars: 0, delBars: 0, emptyBars: maxBars > 0 ? maxBars : 0 };
  }

  const addBars = Math.min(maxBars, Math.round((safeAdd / total) * maxBars));
  const delBars = Math.min(
    maxBars - addBars,
    Math.round((safeDel / total) * maxBars)
  );
  const emptyBars = Math.max(0, maxBars - addBars - delBars);

  return { addBars, delBars, emptyBars };
}

// ============================================================================
// 以下为已废弃的多叉树算法类型与函数，仅为向前兼容保留，新代码严禁调用
// ============================================================================

/** @deprecated 概览面板已重构为扁平列表 OverviewChangesList，多叉树结构已废弃 */
export interface GitTreeBaseNode {
  id: string;
  name: string;
  fullPath: string;
  depth: number;
}

/** @deprecated */
export interface GitTreeFolderNode extends GitTreeBaseNode {
  isFolder: true;
  children: GitTreeNode[];
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
}

/** @deprecated */
export interface GitTreeFileNode extends GitTreeBaseNode {
  isFolder: false;
  file: GitStatusFile;
}

/** @deprecated */
export type GitTreeNode = GitTreeFolderNode | GitTreeFileNode;

/** @deprecated */
export interface GitTreeBuildOptions {
  compactSingleChild?: boolean;
}

/** @deprecated 概览面板改动呈现已改为线性列表，严禁在新组件中构建多叉树 */
export function buildGitTree(
  files: GitStatusFile[],
  options: GitTreeBuildOptions = { compactSingleChild: true }
): GitTreeNode[] {
  if (!files || !Array.isArray(files) || files.length === 0) {
    return [];
  }

  const root: GitTreeFolderNode = {
    id: '__root__',
    name: '',
    fullPath: '',
    depth: -1,
    isFolder: true,
    children: [],
    totalFiles: 0,
    totalAdditions: 0,
    totalDeletions: 0,
  };

  for (const file of files) {
    if (!file || typeof file.path !== 'string') continue;
    const normalizedPath = file.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalizedPath) continue;

    const segments = normalizedPath.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    let current = root;
    let currentPath = '';

    const additions = typeof file.additions === 'number' && Number.isFinite(file.additions) ? file.additions : 0;
    const deletions = typeof file.deletions === 'number' && Number.isFinite(file.deletions) ? file.deletions : 0;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isFile = i === segments.length - 1;

      current.totalFiles += 1;
      current.totalAdditions += additions;
      current.totalDeletions += deletions;

      if (isFile) {
        current.children.push({
          id: currentPath,
          name: segment,
          fullPath: currentPath,
          depth: current.depth + 1,
          isFolder: false,
          file,
        });
      } else {
        let folder = current.children.find(
          (c): c is GitTreeFolderNode => c.isFolder && c.name === segment
        );
        if (!folder) {
          folder = {
            id: currentPath,
            name: segment,
            fullPath: currentPath,
            depth: current.depth + 1,
            isFolder: true,
            children: [],
            totalFiles: 0,
            totalAdditions: 0,
            totalDeletions: 0,
          };
          current.children.push(folder);
        }
        current = folder;
      }
    }
  }

  const sortNodesRecursively = (nodes: GitTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    for (const node of nodes) {
      if (node.isFolder) {
        sortNodesRecursively(node.children);
      }
    }
  };
  sortNodesRecursively(root.children);

  if (options.compactSingleChild !== false) {
    return compactTreeFolders(root.children, 0);
  }

  return normalizeDepth(root.children, 0);
}

/** @deprecated */
export function compactTreeFolders(
  nodes: GitTreeNode[],
  targetDepth: number = 0
): GitTreeNode[] {
  return nodes.map((node) => {
    if (!node.isFolder) {
      return { ...node, depth: targetDepth };
    }

    let current: GitTreeFolderNode = node;
    let combinedName = current.name;
    let combinedPath = current.fullPath;

    while (current.children.length === 1 && current.children[0]!.isFolder) {
      const singleChild = current.children[0] as GitTreeFolderNode;
      combinedName = `${combinedName}/${singleChild.name}`;
      combinedPath = singleChild.fullPath;
      current = singleChild;
    }

    return {
      id: combinedPath,
      name: combinedName,
      fullPath: combinedPath,
      depth: targetDepth,
      isFolder: true,
      totalFiles: current.totalFiles,
      totalAdditions: current.totalAdditions,
      totalDeletions: current.totalDeletions,
      children: compactTreeFolders(current.children, targetDepth + 1),
    };
  });
}

/** @deprecated */
export function normalizeDepth(
  nodes: GitTreeNode[],
  targetDepth: number = 0
): GitTreeNode[] {
  return nodes.map((node) => {
    if (!node.isFolder) {
      return { ...node, depth: targetDepth };
    }
    return {
      ...node,
      depth: targetDepth,
      children: normalizeDepth(node.children, targetDepth + 1),
    };
  });
}
