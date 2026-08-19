import React, { useMemo, useState, useEffect } from 'react';
import * as Lucide from 'lucide-react';
import type { FileDiff } from '../../store/types';
import { useLayoutTreeStore } from '../../store/storeAccess';
import { useTerminalField, selectDiffFiles } from '../../store/storeAccess';
import {
  openPathDefault,
  openWithHostOpener,
  listOpenOptionsForFile,
  type HostOpener,
} from '../../api/hostOpenersApi';
import { logInternalError } from '../../api/userFacingErrors';
import {
  pathDirname,
  readTextFile,
  getWorkspacePath,
} from '../../api/workspaceFsApi';
import { VirtualPlainCodeViewer } from '../diff/VirtualPlainCodeViewer';
import { useToast } from '../../services/toast/ToastContext';
import { Button, Tooltip, Menu } from '../ui';
import styles from './FileViewerCard.module.css';

export interface FileViewerCardProps {
  filePath: string;
  initialMode?: 'plain' | 'diff';
}

// 无名称图标按钮文案（同源约定）：aria-label 与 Tooltip content 同引用，禁止两处各写
const OPEN_WITH_LABEL = '选择打开方式';
const COPY_SOURCE_LABEL = '复制完整源码';
const MORE_ACTIONS_LABEL = '更多操作';

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

    // 模式切换状态
    const [viewMode, setViewMode] = useState<'plain' | 'diff'>(initialMode);

    // 独立读取完整文件源码
    const [plainCode, setPlainCode] = useState<string>('');
    const [plainLoading, setPlainLoading] = useState<boolean>(false);

    useEffect(() => {
      let active = true;
      async function load() {
        setPlainLoading(true);
        try {
          const res = await readTextFile(filePath);
          if (active) {
            setPlainCode(res.content || '');
          }
        } catch (err) {
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

    // 打开方式（HostOpeners）与“更多操作”下拉状态
    const [openDefaultLabel, setOpenDefaultLabel] =
      useState('在系统默认应用打开');
    const [fileOpeners, setFileOpeners] = useState<HostOpener[]>([]);
    const [openMenuMore, setOpenMenuMore] = useState(false);

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
    // 相对路径接到工作区根下（SessionState 无 workspacePath，统一走 getWorkspacePath）
    const absolutePath = isAbsolute
      ? filePath
      : `${getWorkspacePath() || ''}/${filePath}`;
    const baseName = filePath.replace(/^.*[\\/]/, '') || filePath;

    const handleOpenDefault = () => {
      void openPathDefault(absolutePath).catch((e) =>
        logInternalError('components/files/FileViewerCard/openDefault', e)
      );
    };

    const handleCopyCode = async () => {
      try {
        const res = await readTextFile(filePath);
        if (res.content) {
          await navigator.clipboard.writeText(res.content);
          showToast('文件源码已复制到剪贴板');
        }
      } catch (err) {
        showToast('复制失败：' + String(err));
      }
    };

    const handleLocateInFiles = () => {
      window.dispatchEvent(
        new CustomEvent('crish-open-file', { detail: { path: absolutePath } })
      );
      const treeStore = useLayoutTreeStore.getState();
      const root = treeStore.tree.root;

      type TreeLike = {
        type?: string;
        tabs?: string[];
        id?: string;
        children?: TreeLike[];
      };
      function findAndActivateFiles(node: TreeLike): boolean {
        if (node.type === 'leaf') {
          if (node.tabs && node.tabs.includes('files')) {
            treeStore.setActiveTab(node.id ?? '', 'files');
            return true;
          }
          return false;
        }
        const [first, second] = node.children ?? [];
        return (
          (first ? findAndActivateFiles(first) : false) ||
          (second ? findAndActivateFiles(second) : false)
        );
      }

      const success = findAndActivateFiles(root);
      if (!success) {
        const activeLeafId = treeStore.activeLeafId;
        if (activeLeafId) {
          treeStore.addTabToLeaf(activeLeafId, 'files');
          treeStore.setActiveTab(activeLeafId, 'files');
        }
      }
      showToast('已在本地文件树中定位该文件');
    };

    const handleOpenSystemExplorer = () => {
      const parentDir = pathDirname(absolutePath);
      void openPathDefault(parentDir).catch(() => {
        showToast('打开系统管理器目录失败');
      });
    };

    // 手写简单对比渲染，不污染主 diff 状态机
    const renderSimpleDiff = () => {
      if (!f || !f.changes || f.changes.length === 0) {
        return (
          <div className={styles.diffEmpty}>
            <span>该文件目前没有本地改动</span>
          </div>
        );
      }

      return (
        <div className={styles.diffContainer}>
          {f.changes.map((line, idx) => {
            let typeClass = '';
            let prefix = ' ';
            if (line.type === 'addition') {
              typeClass = styles.diffAddition ?? '';
              prefix = '+';
            } else if (line.type === 'deletion') {
              typeClass = styles.diffDeletion ?? '';
              prefix = '-';
            }

            return (
              <div key={idx} className={`${styles.diffLine} ${typeClass}`}>
                <div className={styles.diffGutter}>{prefix}</div>
                <div className={styles.diffContent}>{line.content}</div>
              </div>
            );
          })}
        </div>
      );
    };

    return (
      <div
        className={styles.card}
        aria-label="单文件代码查看"
        data-file-preview-host="file-viewer"
      >
        <div className={styles.header}>
          <div className={styles.titleArea}>
            <Tooltip content={filePath}>
              <span className={styles.fileName}>{baseName}</span>
            </Tooltip>
          </div>

          <div className={styles.compareToggleRow}>
            <button
              type="button"
              className={`${styles.toggleTab} ${
                viewMode === 'diff' ? styles.toggleTabActive : ''
              }`}
              onClick={() => setViewMode('diff')}
            >
              仅看变更
            </button>
            <button
              type="button"
              className={`${styles.toggleTab} ${
                viewMode === 'plain' ? styles.toggleTabActive : ''
              }`}
              onClick={() => setViewMode('plain')}
            >
              完整代码
            </button>
          </div>

          <div className={styles.rightActions}>
            {/* 打开方式（在...中编辑）胶囊下拉组件 */}
            <div className={styles.filesOpenCapsule}>
              <Tooltip content={`${openDefaultLabel}（系统默认）`}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={styles.filesOpenMain}
                  onClick={handleOpenDefault}
                  icon={<Lucide.AppWindow size={13} aria-hidden />}
                >
                  <span>{openDefaultLabel}</span>
                </Button>
              </Tooltip>

              <Menu
                position={{ align: 'end', side: 'bottom', sideOffset: 4 }}
                trigger={
                  <Tooltip content={OPEN_WITH_LABEL}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={styles.filesOpenChev}
                      aria-label={OPEN_WITH_LABEL}
                      icon={<Lucide.ChevronDown size={14} aria-hidden />}
                    />
                  </Tooltip>
                }
                options={[
                  ...fileOpeners
                    .slice(0, openMenuMore ? fileOpeners.length : 6)
                    .map((op) => ({
                      id: op.id,
                      label: op.displayName,
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
                        void openWithHostOpener(op.id, absolutePath).catch(
                          (e) =>
                            logInternalError(
                              'components/files/FileViewerCard/openWith',
                              e
                            )
                        );
                      },
                    })),
                  ...(fileOpeners.length > 6
                    ? [
                        {
                          id: '__toggle_more__',
                          label: openMenuMore
                            ? '收起'
                            : `更多应用（${fileOpeners.length - 6}）`,
                          icon: <Lucide.ChevronsUpDown size={14} aria-hidden />,
                          onClick: () => setOpenMenuMore((v) => !v),
                        },
                      ]
                    : []),
                ]}
              />
            </div>

            {/* 常驻复制源码按钮 */}
            <Tooltip content={COPY_SOURCE_LABEL}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.actBtn}
                aria-label={COPY_SOURCE_LABEL}
                onClick={handleCopyCode}
                icon={<Lucide.Copy size={14} />}
              />
            </Tooltip>

            {/* 智能 More 面板收纳其余所有辅助动作 */}
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
                options={[
                  {
                    id: 'copy-abs-path',
                    label: '复制绝对路径',
                    icon: <Lucide.FileCode size={14} aria-hidden />,
                    onClick: () => {
                      navigator.clipboard.writeText(absolutePath);
                      showToast('绝对路径已复制到剪贴板');
                    },
                  },
                  {
                    id: 'reveal-explorer',
                    label: '在资源管理器中显示',
                    icon: <Lucide.FolderOpen size={14} aria-hidden />,
                    onClick: handleOpenSystemExplorer,
                  },
                  {
                    id: 'locate-tree',
                    label: '在应用文件树中定位',
                    icon: <Lucide.Locate size={14} aria-hidden />,
                    onClick: handleLocateInFiles,
                  },
                ]}
              />
            </div>
          </div>
        </div>

        <div className={styles.bodyWrap}>
          {viewMode === 'plain' ? (
            plainLoading ? (
              <div className={styles.detailLoading}>
                <Lucide.Loader2 size={16} className="spin" />
                <span>正在加载源码...</span>
              </div>
            ) : (
              <VirtualPlainCodeViewer content={plainCode} filePath={filePath} />
            )
          ) : (
            renderSimpleDiff()
          )}
        </div>
      </div>
    );
  }
);

FileViewerCard.displayName = 'FileViewerCard';
