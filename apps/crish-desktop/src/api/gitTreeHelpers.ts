/**
 * Git 变动文件树状折叠与紧凑单子链纯函数算法
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
 * 树节点基础共有契约
 */
export interface GitTreeBaseNode {
  id: string; // 规范化相对路径，作为 React Key / 唯一标识
  name: string; // 呈现名称 (单级目录名，或紧凑折叠的路径链如 'apps/crish-desktop/src')
  fullPath: string; // 完整相对路径
  depth: number; // 视觉缩进深度 (0-indexed)
}

/**
 * 目录节点契约
 */
export interface GitTreeFolderNode extends GitTreeBaseNode {
  isFolder: true;
  children: GitTreeNode[];
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
}

/**
 * 文件叶子节点契约
 */
export interface GitTreeFileNode extends GitTreeBaseNode {
  isFolder: false;
  file: GitStatusFile;
}

/**
 * 树节点联合类型
 */
export type GitTreeNode = GitTreeFolderNode | GitTreeFileNode;

/**
 * 树构建选项
 */
export interface GitTreeBuildOptions {
  compactSingleChild?: boolean; // 是否启用单子目录紧凑折叠，默认为 true
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
 * 纯函数：将扁平 Git 文件列表转换为带紧凑折叠的多叉树结构
 *
 * @param files 扁平 Git 文件状态数组
 * @param options 树构建参数
 * @returns 构造完成的多叉树顶级节点数组
 *
 * 性能复杂度：
 * - 时间复杂度: O(N * D + N log N)，其中 N 为文件总数，D 为平均目录深度 (D <= 10)
 * - 空间复杂度: O(N)，纯函数不可变输出，零副作用
 */
export function buildGitTree(
  files: GitStatusFile[],
  options: GitTreeBuildOptions = { compactSingleChild: true }
): GitTreeNode[] {
  if (!files || !Array.isArray(files) || files.length === 0) {
    return [];
  }

  // 1. 初始化虚拟根容器
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

  // 2. 将扁平路径按 / 分解并逐级挂载至多叉树
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

  // 3. 递归排序：文件夹优先于文件，同类按字母序升序
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

  // 4. 执行单子目录紧凑折叠 (Compact Single-Child Folders)
  if (options.compactSingleChild !== false) {
    return compactTreeFolders(root.children, 0);
  }

  return normalizeDepth(root.children, 0);
}

/**
 * 递归单子目录紧凑折叠算法
 * 对标 AppFlowy Compact Single-Child Folders：
 * 当目录 A 仅包含唯一子节点 B 且 B 也是目录时，坍缩为 'A/B'
 */
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

    // 只要只有一个子节点且该子节点是文件夹，就执行链式合并坍缩
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

/**
 * 规范化树节点深度标尺
 */
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
