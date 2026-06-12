import { useState, useEffect } from 'preact/hooks';
import { tauriBridge } from '../core/tauri-bridge';
import {
  IconFolder,
  IconFile,
  IconChevronDown,
  IconX,
  IconFilePlus,
  IconFolderPlus,
  IconEdit,
  IconTrash,
  IconCopy,
  IconMoreVertical,
} from './icons';

// ==================== Types ====================

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FileTreeProps {
  roots: string[];
  activeFile: string | null;
  onFileClick: (path: string) => void;
  onCloseFolder?: (path: string) => void;
  onFolderContextMenu?: (e: MouseEvent, folder: string) => void;
  /** Git 状态映射：path -> status */
  gitStatusMap?: Map<string, 'created' | 'modified' | 'deleted'>;
  /** 刷新键，变化时重新加载 */
  refreshKey?: number;
  /** 搜索过滤关键词 */
  searchQuery?: string;
}

interface FileContextMenu {
  x: number;
  y: number;
  path: string;
  name: string;
  isDir: boolean;
}

// ==================== Component ====================

const normalizePath = (p: string) => p.replace(/\\/g, '/');

export default function FileTree({
  roots,
  activeFile,
  onFileClick,
  onCloseFolder,
  onFolderContextMenu,
  gitStatusMap,
  refreshKey,
  searchQuery,
}: FileTreeProps) {
  const normalizedRoots = roots.map(normalizePath);
  const normalizedActiveFile = activeFile ? normalizePath(activeFile) : null;

  const [dirContents, setDirContents] = useState<Map<string, FileNode[]>>(new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenu | null>(null);
  const [folderMenuOpen, setFolderMenuOpen] = useState<{ root: string; x: number; y: number } | null>(null);

  // 点击任意位置关闭菜单
  useEffect(() => {
    if (!fileContextMenu && !folderMenuOpen) return;
    const close = () => { setFileContextMenu(null); setFolderMenuOpen(null); };
    document.addEventListener('click', close);
    document.addEventListener('contextmenu', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
    };
  }, [fileContextMenu, folderMenuOpen]);

  useEffect(() => {
    normalizedRoots.forEach(root => {
      if (root && !dirContents.has(root)) {
        loadDirectory(root);
      }
    });
    setExpandedDirs(prev => {
      const next = new Set(prev);
      normalizedRoots.forEach(r => { if (r) next.add(r); });
      return next;
    });
  }, [normalizedRoots.join('|')]);

  useEffect(() => {
    if (refreshKey === undefined) return;
    normalizedRoots.forEach(root => {
      if (root) loadDirectory(root);
    });
  }, [refreshKey]);

  const loadDirectory = async (dirPath: string) => {
    const normalizedDirPath = normalizePath(dirPath);
    if (dirContents.has(normalizedDirPath)) return;
    try {
      const result = await tauriBridge.listDirectory(normalizedDirPath);
      const nodes = result.items
        .filter(item => !item.name.startsWith('.') && item.name !== 'node_modules' && item.name !== 'target' && item.name !== 'dist')
        .sort((a, b) => {
          if (a.isDir && !b.isDir) return -1;
          if (!a.isDir && b.isDir) return 1;
          return a.name.localeCompare(b.name);
        })
        .map(item => ({
          name: item.name,
          path: normalizedDirPath.replace(/\/+$/, '') + '/' + item.name,
          isDir: item.isDir,
        }));
      setDirContents(prev => new Map([...prev, [normalizedDirPath, nodes]]));
    } catch (e) {
      console.error('Failed to load directory:', e);
    }
  };

  const toggleDir = (dirPath: string) => {
    const normalizedDirPath = normalizePath(dirPath);
    const next = new Set(expandedDirs);
    if (next.has(normalizedDirPath)) {
      next.delete(normalizedDirPath);
    } else {
      next.add(normalizedDirPath);
      loadDirectory(normalizedDirPath);
    }
    setExpandedDirs(next);
  };

  const getGitStatus = (path: string): 'created' | 'modified' | 'deleted' | null => {
    if (!gitStatusMap) return null;
    // Try exact match first, then relative path
    if (gitStatusMap.has(path)) return gitStatusMap.get(path)!;
    // Try matching by filename for simplicity
    for (const [gitPath, status] of gitStatusMap) {
      if (path.endsWith(gitPath) || gitPath.endsWith(path.split('/').pop() || '')) {
        return status;
      }
    }
    return null;
  };

  const renderNodes = (dirPath: string, level: number) => {
    const normalizedDirPath = normalizePath(dirPath);
    const nodes = dirContents.get(normalizedDirPath) || [];
    return nodes.map(node => {
      const isExpanded = expandedDirs.has(node.path);
      const isActive = normalizedActiveFile === node.path;
      const gitStatus = getGitStatus(node.path);

      return (
        <div key={node.path}>
          <div
            class={`repl-ft-row ${isActive ? 'active' : ''}`}
            style={`padding-left: ${8 + level * 12}px`}
            onClick={() => node.isDir ? toggleDir(node.path) : onFileClick(node.path)}
            onContextMenu={(e: any) => {
              e.preventDefault();
              setFileContextMenu({ x: e.clientX, y: e.clientY, path: node.path, name: node.name, isDir: node.isDir });
            }}
            title={node.path}
          >
            {node.isDir ? (
              <span class={`repl-ft-arrow ${isExpanded ? '' : 'collapsed'}`}>
                <IconChevronDown />
              </span>
            ) : (
              <span class="repl-ft-indent" />
            )}
            <span class="repl-ft-icon">
              {node.isDir ? <IconFolder /> : <IconFile />}
            </span>
            <span class="repl-ft-name">{node.name}</span>
            {!node.isDir && gitStatus && (
              <span class={`repl-ft-git-status ${gitStatus}`} title={
                gitStatus === 'created' ? '新增' : gitStatus === 'modified' ? '修改' : '删除'
              }>
                {gitStatus === 'created' ? 'A' : gitStatus === 'modified' ? 'M' : 'D'}
              </span>
            )}
          </div>
          {node.isDir && isExpanded && renderNodes(node.path, level + 1)}
        </div>
      );
    });
  };

  // 搜索过滤：收集所有匹配的文件节点
  const allFileNodes: { path: string; name: string }[] = [];
  const collectFiles = (dirPath: string) => {
    const nodes = dirContents.get(normalizePath(dirPath)) || [];
    nodes.forEach(node => {
      if (node.isDir) {
        collectFiles(node.path);
      } else {
        allFileNodes.push({ path: node.path, name: node.name });
      }
    });
  };
  if (searchQuery) {
    normalizedRoots.forEach(root => collectFiles(root));
  }
  const filteredFiles = searchQuery
    ? allFileNodes.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : [];

  if (normalizedRoots.length === 0) return null;

  return (
    <div class="repl-sidebar-file-tree">
      {searchQuery ? (
        <div class="repl-ft-search-results">
          {filteredFiles.length > 0 ? (
            filteredFiles.map(f => (
              <div
                key={f.path}
                class={`repl-ft-row ${normalizedActiveFile === f.path ? 'active' : ''}`}
                style="padding-left: 8px"
                onClick={() => onFileClick(f.path)}
                title={f.path}
              >
                <span class="repl-ft-indent" />
                <span class="repl-ft-icon"><IconFile /></span>
                <span class="repl-ft-name">{f.name}</span>
                <span class="repl-ft-search-path">{f.path.split('/').slice(0, -1).join('/')}</span>
              </div>
            ))
          ) : (
            <div class="repl-ft-search-empty">无匹配文件</div>
          )}
        </div>
      ) : (
        normalizedRoots.map(root => {
          const isExpanded = expandedDirs.has(root);
          const folderName = root.split('/').pop() || root;
          return (
            <div key={root} class="repl-sidebar-folder">
              <div
                class="repl-ft-row repl-sidebar-folder-header"
                onClick={() => toggleDir(root)}
              >
                <span class="repl-ft-icon"><IconFolder /></span>
                <span class="repl-ft-name">{folderName}</span>
                <div class="repl-ft-more-wrap">
                  <button
                    class="repl-ft-more-btn"
                    onClick={(e) => { e.stopPropagation(); const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); setFolderMenuOpen(folderMenuOpen?.root === root ? null : { root, x: rect.right - 170, y: rect.bottom + 4 }); }}
                  >
                    <IconMoreVertical />
                  </button>
                  {folderMenuOpen?.root === root && (
                    <div class="repl-context-menu" style={{ position: 'fixed', left: `${folderMenuOpen.x}px`, top: `${folderMenuOpen.y}px` }} onClick={(e) => e.stopPropagation()}>
                      <div class="repl-context-menu-item" onClick={() => { setFolderMenuOpen(null); onCloseFolder?.(root); }}>
                        <IconX /> 从工作区移除
                      </div>
                      <div class="repl-context-menu-item" onClick={() => { setFolderMenuOpen(null); loadDirectory(root); }}>
                        <IconCopy /> 刷新文件列表
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {isExpanded && renderNodes(root, 0)}
            </div>
          );
        })
      )}

      {/* File Context Menu */}
      {fileContextMenu && (
        <div
          class="repl-context-menu"
          style={`position:fixed;left:${fileContextMenu.x}px;top:${fileContextMenu.y}px`}
          onClick={(e) => e.stopPropagation()}
        >
          {fileContextMenu.isDir && (
            <>
              <div class="repl-context-menu-item" onClick={() => { setFileContextMenu(null); }}>
                <IconFilePlus /> 新建文件
              </div>
              <div class="repl-context-menu-item" onClick={() => { setFileContextMenu(null); }}>
                <IconFolderPlus /> 新建文件夹
              </div>
              <div class="repl-context-menu-divider" />
            </>
          )}
          <div class="repl-context-menu-item" onClick={() => { setFileContextMenu(null); }}>
            <IconEdit /> 重命名
          </div>
          <div class="repl-context-menu-item" onClick={() => { navigator.clipboard?.writeText(fileContextMenu.path); setFileContextMenu(null); }}>
            <IconCopy /> 复制路径
          </div>
          {!fileContextMenu.isDir && (
            <>
              <div class="repl-context-menu-divider" />
              <div class="repl-context-menu-item danger" onClick={() => { setFileContextMenu(null); }}>
                <IconTrash /> 删除
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
