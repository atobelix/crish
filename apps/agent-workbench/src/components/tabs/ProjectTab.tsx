import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import { appState, type ChangedFile, type CheckpointRecord } from '../../core/app-state';
import { tauriBridge, type GitStatusFile } from '../../core/tauri-bridge';
import { isBackendDiagnosticResult } from '../../core/tauri-command-registry';
import { eventBus } from '../../core/event-bus';
import hljs from 'highlight.js';
import FileTree from '../FileTree';
import { formatFileSize } from '../utils';
import { normalizePath, warnBridgeDiagnostic, StatusBadge, escapeHtml } from './shared';
import { showToast } from '../ToastContainer';
import {
  IconFolder, IconFolderPlus, IconFilePlus, IconFileCode,
  IconChevronDown, IconChevronRight, IconX, IconPlus,
  IconSpinner, IconRefresh, IconTrash,
  IconGitBranch, IconGitCommit,
  IconChat, IconFolderOpen, IconSearch,
} from '../icons';

export default function ProjectTab() {
  const [changedFiles, setChangedFiles] = useState(appState.getState().changedFiles);
  const [checkpoints, setCheckpoints] = useState(appState.getState().checkpoints);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [expandedCpId, setExpandedCpId] = useState<string | null>(null);
  const [diffFiles, setDiffFiles] = useState<Record<string, ChangedFile[]>>({});
  const [loadingDiff, setLoadingDiff] = useState<Record<string, boolean>>({});
  const [restoring, setRestoring] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<'files' | 'changes' | 'checkpoints' | 'tasks' | 'skills'>('files');
  const [treeWidth, setTreeWidth] = useState(200);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [workingDirectory, setWorkingDirectory] = useState(appState.getState().workingDirectory);
  const [openedFolders, setOpenedFolders] = useState(appState.getState().openedFolders);
  const [gitFiles, setGitFiles] = useState<GitStatusFile[]>([]);

  const [selectedText, setSelectedText] = useState<string>('');
  const [commentText, setCommentText] = useState<string>('');
  const [showCommentBox, setShowCommentBox] = useState(false);
  const fileContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const u1 = appState.subscribe('changedFiles', setChangedFiles);
    const u2 = appState.subscribe('checkpoints', setCheckpoints);
    const u3 = appState.subscribe('workingDirectory', setWorkingDirectory);
    const u4 = appState.subscribe('openedFolders', setOpenedFolders);
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  useEffect(() => {
    const unsub = eventBus.on('explorer:open-file', (path: string) => {
      setActiveFile(path);
      loadFileContent(path);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (subTab !== 'changes' || !workingDirectory) return;
    let cancelled = false;
    tauriBridge.gitStatus(workingDirectory)
      .then(res => { if (!cancelled) setGitFiles(res.found ? res.files : []); })
      .catch(() => { if (!cancelled) setGitFiles([]); });
    return () => { cancelled = true; };
  }, [subTab, workingDirectory, treeRefreshKey]);

  async function loadFileContent(path: string) {
    setFileLoading(true);
    setFileContent(null);
    try {
      const result = await tauriBridge.readFileContent(path, 2000);
      setFileContent(result.content);
    } catch (error) {
      warnBridgeDiagnostic(error);
      setFileContent(null);
    } finally {
      setFileLoading(false);
    }
  }

  async function handleChangedFileClick(path: string) {
    setActiveFile(path);
    setFileLoading(true);
    setFileContent(null);
    try {
      const diff = await tauriBridge.gitDiff({ cwd: workingDirectory || undefined, path });
      if (diff.unified && diff.unified.trim()) {
        setFileContent(diff.unified);
      } else {
        await loadFileContent(path);
      }
    } catch {
      await loadFileContent(path);
    } finally {
      setFileLoading(false);
    }
  }

  function handleFileClick(path: string) {
    setActiveFile(path);
    loadFileContent(path);
  }

  function handleCloseFile() {
    setActiveFile(null);
    setFileContent(null);
    setSelectedText('');
    setCommentText('');
    setShowCommentBox(false);
  }

  function handleTextSelection() {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0 && fileContentRef.current?.contains(selection.anchorNode)) {
      setSelectedText(selection.toString().trim());
      setShowCommentBox(true);
    }
  }

  function handleSubmitComment() {
    if (!selectedText || !commentText.trim()) return;
    const contextMessage = `[文件: ${activeFile}]\n选中内容: "${selectedText}"\n评论: ${commentText}`;
    eventBus.emit('message:send-with-context', { text: contextMessage, selectedText, comment: commentText, filePath: activeFile });
    setCommentText('');
    setSelectedText('');
    setShowCommentBox(false);
  }

  async function handleOpenInFolder(filePath: string) {
    try {
      await tauriBridge.openFileInFolder(filePath);
    } catch (error) {
      warnBridgeDiagnostic(error);
    }
  }

  async function handleViewDiff(cpId: string) {
    if (diffFiles[cpId]) {
      setExpandedCpId(expandedCpId === cpId ? null : cpId);
      return;
    }
    setLoadingDiff(prev => ({ ...prev, [cpId]: true }));
    try {
      const files = await tauriBridge.getCheckpointDiff(cpId);
      if (isBackendDiagnosticResult(files)) {
        warnBridgeDiagnostic(files.diagnostic);
        return;
      }
      setDiffFiles(prev => ({ ...prev, [cpId]: files }));
      setExpandedCpId(cpId);
    } catch (error) {
      showToast('获取 Checkpoint Diff 失败', 'error', 4500);
    } finally {
      setLoadingDiff(prev => ({ ...prev, [cpId]: false }));
    }
  }

  async function handleRestore(cpId: string) {
    if (restoring) return;
    setRestoring(cpId);
    try {
      const ok = await tauriBridge.restoreCheckpoint(cpId);
      if (isBackendDiagnosticResult(ok)) {
        warnBridgeDiagnostic(ok.diagnostic);
        return;
      }
      if (ok) {
        appState.markCheckpointRestored(cpId);
      }
    } catch (error) {
      showToast('恢复 Checkpoint 失败', 'error', 4500);
    } finally {
      setRestoring(null);
    }
  }

  async function handleOpenFolder() {
    try {
      const folder = await tauriBridge.selectFolder();
      if (folder) {
        appState.setState('workingDirectory', folder);
        const folders = appState.getState().openedFolders;
        if (!folders.includes(folder)) {
          appState.setState('openedFolders', [...folders, folder]);
        }
      }
    } catch (error) {
      showToast('选择文件夹失败', 'error', 4500);
    }
  }

  function handleCloseFolder(path: string) {
    const folders = openedFolders.filter(f => f !== path);
    appState.setState('openedFolders', folders);
    if (workingDirectory === path) {
      appState.setState('workingDirectory', folders.length > 0 ? folders[0] : '');
    }
  }

  const highlightedContent = useMemo(() => {
    if (!fileContent || !activeFile) return null;
    const ext = activeFile.split('.').pop()?.toLowerCase() ?? '';
    const langMap: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', rs: 'rust', go: 'go', java: 'java', json: 'json',
      html: 'html', css: 'css', scss: 'scss', md: 'markdown', yaml: 'yaml',
      yml: 'yaml', toml: 'toml', sql: 'sql', sh: 'bash', bash: 'bash',
    };
    const lang = langMap[ext];
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(fileContent, { language: lang }).value;
      }
      return hljs.highlightAuto(fileContent).value;
    } catch {
      return escapeHtml(fileContent);
    }
  }, [fileContent, activeFile]);

  return (
    <div class="repl-rs-tab-content-inner">
      <div class="repl-rs-sub-tabs">
        <button class={`repl-rs-sub-tab ${subTab === 'files' ? 'active' : ''}`} onClick={() => setSubTab('files')}>
          <IconFolder /> 文件
        </button>
        <button class={`repl-rs-sub-tab ${subTab === 'changes' ? 'active' : ''}`} onClick={() => setSubTab('changes')}>
          <IconGitBranch /> 变更
          {changedFiles.length > 0 && <span class="repl-rs-badge">{changedFiles.length}</span>}
        </button>
        <button class={`repl-rs-sub-tab ${subTab === 'checkpoints' ? 'active' : ''}`} onClick={() => setSubTab('checkpoints')}>
          <IconGitCommit /> 检查点
          {checkpoints.length > 0 && <span class="repl-rs-badge">{checkpoints.length}</span>}
        </button>
      </div>

      {subTab === 'files' && (
        <div class="repl-rs-files-split">
          <div class="repl-rs-code-panel">
            {activeFile ? (
              <>
                <div class="repl-rs-code-header">
                  <span class="repl-rs-code-filename">{normalizePath(activeFile).split('/').pop()}</span>
                  <div class="repl-rs-code-actions">
                    <button class="repl-rs-file-preview-action-btn" onClick={() => handleOpenInFolder(activeFile)} title="在文件管理器中打开">
                      <IconFolderOpen />
                    </button>
                    <button class="repl-rs-file-preview-action-btn" onClick={handleCloseFile} title="关闭">
                      <IconX />
                    </button>
                  </div>
                </div>
                <div class="repl-rs-code-content" ref={fileContentRef} onMouseUp={handleTextSelection}>
                  {fileLoading ? (
                    <div class="repl-rs-loading"><IconSpinner /> 加载中...</div>
                  ) : highlightedContent ? (
                    <pre class="repl-rs-code-preview"><code dangerouslySetInnerHTML={{ __html: highlightedContent }} /></pre>
                  ) : (
                    <div class="repl-rs-empty-inline">无法加载文件内容</div>
                  )}
                </div>
                {showCommentBox && selectedText && (
                  <div class="repl-rs-comment-overlay">
                    <div class="repl-rs-comment-box">
                      <div class="repl-comment-icon"><IconChat /></div>
                      <span class="repl-comment-title">本地评论</span>
                      <span class="repl-comment-hint">对选中内容发布评论</span>
                      <textarea
                        class="repl-rs-comment-input"
                        placeholder="请求更改..."
                        value={commentText}
                        onInput={(e) => setCommentText((e.target as HTMLTextAreaElement).value)}
                        rows={2}
                      />
                      <div class="repl-rs-comment-actions">
                        <button class="repl-rs-btn-sm repl-rs-btn-cancel-sm" onClick={() => setShowCommentBox(false)}>取消</button>
                        <button class="repl-rs-btn-sm primary" onClick={handleSubmitComment} disabled={!commentText.trim()}>注释</button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div class="repl-rs-code-empty">
                <span class="repl-rs-item-icon"><IconFileCode /></span>
                <span class="repl-rs-item-meta">选择文件以查看代码</span>
              </div>
            )}
          </div>

          <div
            class="repl-rs-split-divider"
            onMouseDown={(e: MouseEvent) => {
              e.preventDefault();
              const startX = e.clientX;
              const startWidth = treeWidth;
              const container = (e.currentTarget as HTMLElement).closest('.repl-rs-files-split') as HTMLElement | null;
              const maxW = container ? Math.max(180, container.clientWidth * 0.6) : 480;
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
              const onMove = (ev: MouseEvent) => {
                const next = Math.max(140, Math.min(maxW, startWidth + (startX - ev.clientX)));
                setTreeWidth(next);
              };
              const onUp = () => {
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
              };
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            }}
          />

          <div class="repl-rs-tree-panel repl-rs-tree-panel-fluid" style={{ width: `${treeWidth}px` }}>
            <div class="repl-rs-tree-header">
              {fileSearchQuery ? (
                <input
                  class="repl-rs-search-input"
                  type="text"
                  value={fileSearchQuery}
                  placeholder="筛选文件..."
                  onInput={(e: Event) => setFileSearchQuery((e.target as HTMLInputElement).value)}
                  onBlur={() => { if (!fileSearchQuery) setFileSearchQuery(''); }}
                  autoFocus
                />
              ) : (
                <div class="repl-rs-tree-search-placeholder">
                  <IconSearch />
                  <span>筛选文件...</span>
                </div>
              )}
              <button class="repl-rs-btn-icon" title="刷新" onClick={() => setTreeRefreshKey(k => k + 1)}>
                <IconRefresh />
              </button>
            </div>
            {openedFolders.length > 0 ? (
              <div class="repl-rs-file-tree-container">
                <FileTree
                  roots={openedFolders}
                  activeFile={activeFile}
                  onFileClick={handleFileClick}
                  gitStatusMap={new Map(changedFiles.map(f => [f.path, f.status]))}
                  refreshKey={treeRefreshKey}
                  searchQuery={fileSearchQuery.trim()}
                />
              </div>
            ) : (
              <div class="repl-rs-empty-center">
                <span class="repl-rs-item-icon"><IconFolder /></span>
                <span class="repl-rs-item-meta">未绑定项目文件夹</span>
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === 'changes' && (
        <div class="repl-rs-section">
          <div class="repl-rs-section-header">
            <span class="repl-rs-section-title">变更文件</span>
            {changedFiles.length > 0 && <span class="repl-rs-badge">{changedFiles.length}</span>}
          </div>
          {changedFiles.length === 0 ? (
            gitFiles.length > 0 ? (
              <div class="repl-rs-changed-files">
                {gitFiles.map(g => (
                  <div key={g.path} class="repl-rs-changed-file modified" onClick={() => handleChangedFileClick(g.path)}>
                    <span class="repl-rs-status-badge modified">{g.status}</span>
                    <span class="repl-rs-changed-file-path">{normalizePath(g.path)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div class="repl-rs-empty-inline">
                <span class="repl-rs-item-meta">暂无变更文件</span>
              </div>
            )
          ) : (
            <div class="repl-rs-changed-files">
              {changedFiles.map(f => (
                <div
                  key={f.path}
                  class={`repl-rs-changed-file ${f.status === 'created' ? 'added' : f.status === 'deleted' ? 'removed' : 'modified'}`}
                  onClick={() => handleChangedFileClick(f.path)}
                >
                  <StatusBadge status={f.status} />
                  <span class="repl-rs-changed-file-path">{normalizePath(f.path)}</span>
                  <span class="repl-rs-changed-file-lines">
                    {f.addedLines > 0 && <span class="added">+{f.addedLines}</span>}
                    {f.removedLines > 0 && <span class="removed">-{f.removedLines}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {subTab === 'checkpoints' && (
        <div class="repl-rs-section">
          <div class="repl-rs-section-header">
            <span class="repl-rs-section-title">检查点</span>
            {checkpoints.length > 0 && <span class="repl-rs-badge">{checkpoints.length}</span>}
          </div>
          {checkpoints.length === 0 ? (
            <div class="repl-rs-empty-inline">
              <span class="repl-rs-item-meta">暂无检查点</span>
            </div>
          ) : (
            <div class="repl-rs-checkpoint-list">
              {checkpoints.map(cp => {
                const isExpanded = expandedCpId === cp.id;
                const files = diffFiles[cp.id] ?? [];
                const isLoading = loadingDiff[cp.id] ?? false;
                const isRestored = cp.restoredAt != null;
                return (
                  <div key={cp.id} class={`repl-rs-checkpoint-item ${isRestored ? 'restored' : ''}`}>
                    <div class="repl-rs-checkpoint-header" onClick={() => void handleViewDiff(cp.id)}>
                      <span class={`repl-rs-checkpoint-dot ${isRestored ? 'restored' : 'active'}`} />
                      <span class="repl-rs-checkpoint-label">{cp.label || cp.id.slice(0, 12)}</span>
                      <span class="repl-rs-checkpoint-time">{new Date(cp.createdAt).toLocaleTimeString()}</span>
                      <span class="repl-rs-checkpoint-expand">{isExpanded ? <IconChevronDown /> : <IconChevronRight />}</span>
                    </div>
                    {cp.filePaths.length > 0 && (
                      <div class="repl-rs-checkpoint-files-preview">
                        {cp.filePaths.slice(0, 3).map(f => (
                          <span key={f} class="repl-rs-checkpoint-file-tag">{f.split(/[\\/]/).pop()}</span>
                        ))}
                        {cp.filePaths.length > 3 && (
                          <span class="repl-rs-checkpoint-file-more">+{cp.filePaths.length - 3}</span>
                        )}
                      </div>
                    )}
                    {isExpanded && (
                      <div class="repl-rs-checkpoint-detail">
                        {isLoading ? (
                          <div class="repl-rs-checkpoint-loading">加载 Diff...</div>
                        ) : files.length > 0 ? (
                          <div class="repl-rs-checkpoint-diff">
                            {files.map(f => (
                              <div key={f.path} class={`repl-rs-checkpoint-diff-file ${f.status === 'created' ? 'added' : f.status === 'deleted' ? 'removed' : 'modified'}`}>
                                <span class="repl-rs-checkpoint-diff-status">
                                  {f.status === 'created' ? 'A' : f.status === 'deleted' ? 'D' : 'M'}
                                </span>
                                <span class="repl-rs-checkpoint-diff-path">{f.path}</span>
                                <span class="repl-rs-checkpoint-diff-lines">
                                  {f.addedLines > 0 && <span class="added">+{f.addedLines}</span>}
                                  {f.removedLines > 0 && <span class="removed">-{f.removedLines}</span>}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div class="repl-rs-checkpoint-no-diff">无变更文件</div>
                        )}
                        {!isRestored && (
                          <div class="repl-rs-checkpoint-restore">
                            <button
                              class="repl-rs-btn-sm"
                              disabled={restoring === cp.id}
                              onClick={() => void handleRestore(cp.id)}
                            >
                              {restoring === cp.id ? <IconSpinner /> : '恢复到此检查点'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}