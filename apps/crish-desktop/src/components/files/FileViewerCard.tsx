import React, { useMemo, useState, useEffect, useCallback } from 'react';
import * as Lucide from 'lucide-react';
import type { ViewRenderContext } from '../../services/view-registry/ViewTypes';
import type { FileDiff } from '../../store/types';
import {
  openToolInSession,
  useTerminalField,
  selectDiffFiles,
  consumeFileViewerModeOverride,
} from '../../store/storeAccess';
import { getCompositionRoot } from '../../app/compositionRoot';
import {
  openPathDefault,
  openWithHostOpener,
  listOpenOptionsForFile,
  type HostOpener,
} from '../../api/hostOpenersApi';
import { logInternalError } from '../../api/userFacingErrors';
import {
  readTextFile,
  getWorkspacePath,
  pathRelativeToRoot,
  revealInOs,
  isAbsoluteFsPath,
  resolveWorkspacePath,
} from '../../api/workspaceFsApi';
import { readLocalTextBestEffort } from '../../api/localFileReader';
import { VirtualPlainCodeViewer } from '../diff/VirtualPlainCodeViewer';
import { DiffCardUnifiedView } from '../diff/DiffCardUnifiedView';
import { getComputedChanges } from '../diff/useDiffData';
import { useToast } from '../../services/toast/ToastContext';
import { Button, Tooltip, Menu } from '../ui';
import type { SelectOptionItem } from '../ui/Menu/types';
import { FileViewerHistoryDrawer } from './FileViewerHistoryDrawer';
import styles from './FileViewerCard.module.css';

export interface FileViewerCardProps {
  filePath: string;
  initialMode?: 'plain' | 'diff';
}

// 按钮文案与 Tooltip 同源常量
const COPY_ALL_LABEL = '复制全部内容';
const HISTORY_LABEL = '查看历史编辑情况';
const MORE_ACTIONS_LABEL = '更多操作';
const WORD_WRAP_LABEL = '自动换行';

export const FileViewerCard: React.FC<FileViewerCardProps> = React.memo(
  ({ filePath, initialMode = 'plain' }) => {
    const { showToast } = useToast();

    const diffFiles = useTerminalField(selectDiffFiles) as FileDiff[];

    // 匹配当前文件的 git 变更（如果有）
    const f = useMemo(() => {
      return (
        diffFiles.find(
          (x) => x.filePath === filePath || filePath.endsWith(x.filePath)
        ) || null
      );
    }, [diffFiles, filePath]);

    // 模式切换状态：优先消费单轨模式意图，其次使用 initialMode (冷启动)
    const [viewMode, setViewMode] = useState<'plain' | 'diff'>(() => {
      const canonicalTabId = `file-viewer:${filePath}`;
      const override = consumeFileViewerModeOverride(canonicalTabId);
      return override || initialMode;
    });

    // 自动换行状态（默认开启，持久化到 localStorage）
    const [wordWrap, setWordWrap] = useState<boolean>(() => {
      try {
        const saved = localStorage.getItem('crish:file-viewer-word-wrap');
        if (saved !== null) {
          return saved === 'true';
        }
      } catch {
        /* swallow */
      }
      return true;
    });

    const toggleWordWrap = useCallback(() => {
      setWordWrap((prev) => {
        const next = !prev;
        try {
          localStorage.setItem('crish:file-viewer-word-wrap', String(next));
        } catch {
          /* swallow */
        }
        return next;
      });
    }, []);

    // 历史编辑记录抽屉打开状态
    const [historyOpen, setHistoryOpen] = useState(false);

    // 监听同名 Tab 热激活微任务事件（通道 1：解决已存在 Tab 热聚焦切模问题）
    useEffect(() => {
      const handleModeSwitch = (e: Event) => {
        const customEvent = e as CustomEvent<{
          canonicalTabId: string;
          mode: 'plain' | 'diff';
        }>;
        if (!customEvent.detail) return;
        const currentCanonical = `file-viewer:${filePath}`;
        if (customEvent.detail.canonicalTabId === currentCanonical) {
          setViewMode(customEvent.detail.mode);
        }
      };
      window.addEventListener('conex:file-viewer-mode', handleModeSwitch);
      return () => {
        window.removeEventListener('conex:file-viewer-mode', handleModeSwitch);
      };
    }, [filePath]);

    // 监听 initialMode prop 变动（通道 2：React 组件生命周期更新防死锁）
    useEffect(() => {
      if (initialMode) {
        setViewMode(initialMode);
      }
    }, [initialMode]);

    // 独立读取完整文件源码
    const [plainCode, setPlainCode] = useState<string>('');
    const [plainLoading, setPlainLoading] = useState<boolean>(false);

    useEffect(() => {
      let active = true;
      async function load() {
        setPlainLoading(true);
        try {
          const isAbsolute = isAbsoluteFsPath(filePath);
          const inWorkspace = Boolean(resolveWorkspacePath(filePath));

          if (isAbsolute && !inWorkspace) {
            const localText = await readLocalTextBestEffort(filePath);
            if (active && typeof localText === 'string') {
              setPlainCode(localText);
              return;
            }
          }

          const res = await readTextFile(filePath);
          if (active) {
            setPlainCode(res.content || '');
          }
        } catch (err) {
          try {
            const localText = await readLocalTextBestEffort(filePath);
            if (active && typeof localText === 'string') {
              setPlainCode(localText);
              return;
            }
          } catch {
            /* swallow */
          }
          if (active) {
            setPlainCode(`读取源码失败：${String(err)}`);
          }
        } finally {
          if (active) {
            setPlainLoading(false);
          }
        }
      }
      void load();
      return () => {
        active = false;
      };
    }, [filePath]);

    // 打开方式（HostOpeners）
    const [openDefaultLabel, setOpenDefaultLabel] =
      useState('在系统默认应用打开');
    const [fileOpeners, setFileOpeners] = useState<HostOpener[]>([]);

    useEffect(() => {
      let active = true;
      async function loadOpeners() {
        try {
          const { defaultLabel, openers } =
            await listOpenOptionsForFile(filePath);
          if (active) {
            setOpenDefaultLabel(defaultLabel || '在系统默认应用打开');
            setFileOpeners(openers || []);
          }
        } catch {
          /* 打开方式列表失败时静默降级 */
        }
      }
      void loadOpeners();
      return () => {
        active = false;
      };
    }, [filePath]);

    const isAbsolute = filePath.startsWith('/') || filePath.includes(':');
    const workspaceRoot = getWorkspacePath() || '';
    const absolutePath = isAbsolute
      ? filePath
      : `${workspaceRoot}/${filePath}`.replace(/\/+/g, '/');
    const relativePath = isAbsolute
      ? pathRelativeToRoot(filePath, workspaceRoot) || filePath
      : filePath;
    const baseName = filePath.replace(/^.*[\\/]/, '') || filePath;

    const handleOpenDefault = useCallback(() => {
      void openPathDefault(absolutePath).catch((e) =>
        logInternalError('components/files/FileViewerCard/openDefault', e)
      );
    }, [absolutePath]);

    const handleCopyAll = useCallback(async () => {
      try {
        let text = plainCode;
        if (!text) {
          const res = await readTextFile(filePath);
          text = res.content || '';
        }
        await navigator.clipboard.writeText(text);
        showToast('文件源码已复制到剪贴板');
      } catch (err) {
        showToast('复制失败：' + String(err));
      }
    }, [filePath, plainCode, showToast]);

    const handleOpenSystemExplorer = useCallback(() => {
      void revealInOs(absolutePath).catch((e) => {
        logInternalError('components/files/FileViewerCard/revealInOs', e);
        showToast('在资源管理器中定位失败');
      });
    }, [absolutePath, showToast]);

    const handleCopyRelativePath = useCallback(async () => {
      try {
        await navigator.clipboard.writeText(relativePath);
        showToast('相对路径已复制到剪贴板');
      } catch (err) {
        showToast('复制失败：' + String(err));
      }
    }, [relativePath, showToast]);

    const handleCopyAbsolutePath = useCallback(async () => {
      try {
        await navigator.clipboard.writeText(absolutePath);
        showToast('绝对路径已复制到剪贴板');
      } catch (err) {
        showToast('复制失败：' + String(err));
      }
    }, [absolutePath, showToast]);

    const handleLocateInFiles = useCallback(() => {
      window.dispatchEvent(
        new CustomEvent('crish-open-file', { detail: { path: absolutePath } })
      );
      const sid = getCompositionRoot().session.getActiveSessionId();
      if (sid) openToolInSession(sid, 'files');
      showToast('已在本地文件树中定位该文件');
    }, [absolutePath, showToast]);

    // 系统单轨 Unified 比对渲染项计算
    const unifiedRenderItems = useMemo(() => {
      if (!f || !f.changes) return [];
      const computed = getComputedChanges(f);
      return computed.map((item, idx) => ({
        isCollapsedPlaceholder: false as const,
        index: idx,
        item,
      }));
    }, [f]);

    // “更多操作”下拉菜单选项（收纳路径与打开方式相关动作）
    const moreMenuOptions = useMemo<SelectOptionItem[]>(() => {
      const items: SelectOptionItem[] = [
        {
          id: 'open-file-path',
          label: '打开文件路径',
          icon: <Lucide.FolderOpen size={14} aria-hidden />,
          onClick: handleOpenSystemExplorer,
        },
        {
          id: 'copy-rel-path',
          label: '复制相对路径',
          icon: <Lucide.Copy size={14} aria-hidden />,
          onClick: handleCopyRelativePath,
        },
        {
          id: 'copy-abs-path',
          label: '复制绝对路径',
          icon: <Lucide.FileCode size={14} aria-hidden />,
          onClick: handleCopyAbsolutePath,
        },
        {
          id: 'open-with-default',
          label: '选择打开方式',
          hint: openDefaultLabel,
          icon: <Lucide.ExternalLink size={14} aria-hidden />,
          onClick: handleOpenDefault,
        },
      ];

      for (const op of fileOpeners) {
        items.push({
          id: `open-with-${op.id}`,
          label: `用 ${op.displayName} 打开`,
          icon: op.iconDataUrl ? (
            <img
              src={op.iconDataUrl}
              width={14}
              height={14}
              alt=""
              style={{ flexShrink: 0, objectFit: 'contain' }}
            />
          ) : (
            <Lucide.AppWindow
              size={14}
              style={{
                flexShrink: 0,
                color: 'var(--text-secondary)',
              }}
            />
          ),
          onClick: () => {
            void openWithHostOpener(op.id, absolutePath).catch((e) =>
              logInternalError('components/files/FileViewerCard/openWith', e)
            );
          },
        });
      }

      items.push({
        id: 'locate-tree',
        label: '在应用文件树中定位',
        icon: <Lucide.Locate size={14} aria-hidden />,
        onClick: handleLocateInFiles,
      });

      return items;
    }, [
      absolutePath,
      fileOpeners,
      handleCopyAbsolutePath,
      handleCopyRelativePath,
      handleLocateInFiles,
      handleOpenDefault,
      handleOpenSystemExplorer,
      openDefaultLabel,
    ]);

    return (
      <div
        className={`${styles.card} chat-side-panel`}
        aria-label="单文件代码查看"
        data-file-preview-host="file-viewer"
      >
        <div
          className={`${styles.header} side-panel-toolbar`}
          role="toolbar"
          aria-label="单文件查看工具栏"
        >
          <div className={styles.titleArea}>
            <Tooltip content={absolutePath || filePath}>
              <span className={styles.fileName}>{baseName}</span>
            </Tooltip>
          </div>

          <div
            className={styles.compareToggleRow}
            role="tablist"
            aria-label="视图模式切换"
          >
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'diff'}
              className={`${styles.toggleTab} ${
                viewMode === 'diff' ? styles.toggleTabActive : ''
              }`}
              onClick={() => setViewMode('diff')}
            >
              仅看变更
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'plain'}
              className={`${styles.toggleTab} ${
                viewMode === 'plain' ? styles.toggleTabActive : ''
              }`}
              onClick={() => setViewMode('plain')}
            >
              完整代码
            </button>
          </div>

          <div className={styles.rightActions}>
            {/* ① 切换自动换行 */}
            <Tooltip content={wordWrap ? '关闭自动换行' : '开启自动换行'}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={`${styles.actBtn} ${wordWrap ? styles.actBtnActive : ''}`}
                aria-label={wordWrap ? '关闭自动换行' : '开启自动换行'}
                aria-pressed={wordWrap}
                onClick={toggleWordWrap}
                icon={<Lucide.WrapText size={14} />}
              />
            </Tooltip>

            {/* ② 核心常用快捷操作：【复制全部内容】 */}
            <Tooltip content={COPY_ALL_LABEL}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.actBtn}
                aria-label={COPY_ALL_LABEL}
                onClick={handleCopyAll}
                icon={<Lucide.Copy size={14} />}
              />
            </Tooltip>

            {/* ③ 核心常用快捷操作：【查看历史编辑情况】 */}
            <Tooltip content={HISTORY_LABEL}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={`${styles.actBtn} ${historyOpen ? styles.actBtnActive : ''}`}
                aria-label={HISTORY_LABEL}
                aria-pressed={historyOpen}
                onClick={() => setHistoryOpen((v) => !v)}
                icon={<Lucide.History size={14} />}
              />
            </Tooltip>

            {/* “更多操作”下拉菜单（收纳路径相关与外部打开方式） */}
            <div className={styles.filesMoreWrap}>
              <Menu
                position={{ align: 'end', side: 'bottom', sideOffset: 4 }}
                trigger={
                  <Tooltip content={MORE_ACTIONS_LABEL}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={styles.actBtn}
                      aria-label={MORE_ACTIONS_LABEL}
                      icon={<Lucide.MoreHorizontal size={14} />}
                    />
                  </Tooltip>
                }
                options={moreMenuOptions}
              />
            </div>
          </div>
        </div>

        <div className={styles.bodyWrap}>
          <div className={styles.contentPane}>
            {viewMode === 'plain' ? (
              plainLoading ? (
                <div className={styles.detailLoading}>
                  <Lucide.Loader2 size={16} className="spin" />
                  <span>正在加载源码...</span>
                </div>
              ) : (
                <VirtualPlainCodeViewer
                  content={plainCode}
                  filePath={filePath}
                  wordWrap={wordWrap}
                />
              )
            ) : f && f.changes && f.changes.length > 0 ? (
              <DiffCardUnifiedView
                f={f}
                renderItems={unifiedRenderItems}
                onExpandBlock={() => {}}
              />
            ) : (
              <div className={styles.diffEmpty}>
                <Lucide.FileDiff
                  size={22}
                  className={styles.diffEmptyIcon}
                  aria-hidden
                />
                <div>该文件目前没有本地改动</div>
                <div className={styles.diffEmptySub}>
                  本地工作区与基准版本完全一致。
                </div>
              </div>
            )}
          </div>

          {historyOpen && (
            <FileViewerHistoryDrawer
              filePath={filePath}
              hasWorkingChanges={Boolean(f && f.changes && f.changes.length > 0)}
              onSelectDiffView={() => setViewMode('diff')}
              onClose={() => setHistoryOpen(false)}
            />
          )}
        </div>
      </div>
    );
  }
);

FileViewerCard.displayName = 'FileViewerCard';

export const FileViewerCardView: React.FC<ViewRenderContext> = (ctx) => {
  const filePath = (ctx.params?.filePath as string) || '';
  const initialMode = (ctx.params?.initialMode as 'plain' | 'diff') || 'plain';
  return (
    <FileViewerCard
      key={filePath}
      filePath={filePath}
      initialMode={initialMode}
    />
  );
};

FileViewerCardView.displayName = 'FileViewerCardView';
