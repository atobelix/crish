import React, { useMemo, useState, useEffect } from 'react';
import * as Lucide from 'lucide-react';
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
  revealInOs,
} from '../../api/workspaceFsApi';
import { VirtualPlainCodeViewer } from '../diff/VirtualPlainCodeViewer';
import { DiffCardUnifiedView } from '../diff/DiffCardUnifiedView';
import { getComputedChanges } from '../diff/useDiffData';
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

    // 模式切换状态：优先消费单轨模式意图，其次使用 initialMode (冷启动)
    const [viewMode, setViewMode] = useState<'plain' | 'diff'>(() => {
      const canonicalTabId = `file-viewer:${filePath}`;
      const override = consumeFileViewerModeOverride(canonicalTabId);
      return override || initialMode;
    });

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

    // 监听 initialMode prop 变动（通道 2：React 组件生命周期更新防死锁，彻底根除 HAL-06）
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
      const sid = getCompositionRoot().session.getActiveSessionId();
      if (sid) openToolInSession(sid, 'files');
      showToast('已在本地文件树中定位该文件');
    };

    const handleOpenSystemExplorer = () => {
      void revealInOs(absolutePath).catch((e) => {
        logInternalError('components/files/FileViewerCard/revealInOs', e);
        showToast('在资源管理器中定位失败');
      });
    };

    // 系统单轨 Unified 比对渲染项计算（复用系统真实高保真对比数据结构）
    const unifiedRenderItems = useMemo(() => {
      if (!f || !f.changes) return [];
      const computed = getComputedChanges(f);
      return computed.map((item, idx) => ({
        isCollapsedPlaceholder: false as const,
        index: idx,
        item,
      }));
    }, [f]);

    return (
      <div
        className={`${styles.card} chat-side-panel`}
        aria-label="单文件代码查看"
        data-file-preview-host="file-viewer"
      >
        <div className={`${styles.header} side-panel-toolbar`} role="toolbar" aria-label="单文件查看工具栏">
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
                  variant="ghost"
                  size="sm"
                  className={styles.filesOpenMain}
                  onClick={handleOpenDefault}
                  icon={<Lucide.AppWindow size={14} aria-hidden />}
                >
                  {openDefaultLabel}
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
                  ...fileOpeners.map((op) => ({
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
          ) : f && f.changes && f.changes.length > 0 ? (
            /* 系统单轨高保真比对视口（彻底替换 30 行手写简陋对比伪实现） */
            <DiffCardUnifiedView
              f={f}
              renderItems={unifiedRenderItems}
              onExpandBlock={() => {}}
            />
          ) : (
            <div className={styles.diffEmpty}>
              <Lucide.FileDiff size={22} style={{ opacity: 0.3 }} aria-hidden />
              <div>该文件目前没有本地改动</div>
              <div className={styles.diffEmptySub}>
                本地工作区与基准版本完全一致。
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
);

FileViewerCard.displayName = 'FileViewerCard';
