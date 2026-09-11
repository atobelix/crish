import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
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
  FILE_PREVIEW_MAX_LINES,
} from '../../api/workspaceFsApi';
import { usePlainCodeLoader } from './hooks/usePlainCodeLoader';
import { VirtualPlainCodeViewer } from '../diff/VirtualPlainCodeViewer';
import { DiffCardUnifiedView } from '../diff/DiffCardUnifiedView';
import { getComputedChanges } from '../diff/useDiffData';
import { useToast } from '../../services/toast/ToastContext';
import { Button, Tooltip, Menu } from '../ui';
import type { SelectOptionItem } from '../ui/Menu/types';
import { FileViewerHistoryDrawer } from './FileViewerHistoryDrawer';
import { useWordWrapPreference } from './hooks/useWordWrapPreference';
import { isJsonFileOrContent, formatJsonSafe } from './jsonFormatUtils';
import { FileAnnotationPopover } from './FileAnnotationPopover';
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

    // 根卡片容器引用（供选区批注几何锚定）
    const cardRef = useRef<HTMLDivElement>(null);

    // 自动换行状态（统一单一真理源 Hook）
    const [wordWrap, toggleWordWrap] = useWordWrapPreference();

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
    const { plainCode, plainLoading, plainTruncated, plainLineCount } =
      usePlainCodeLoader(filePath);

    // JSON 检测与格式化排版状态
    const [isFormatted, setIsFormatted] = useState(false);
    const [formattedCode, setFormattedCode] = useState('');
    const isJson = useMemo(
      () => isJsonFileOrContent(filePath, plainCode),
      [filePath, plainCode]
    );
    const displayCode = isFormatted && formattedCode ? formattedCode : plainCode;

    useEffect(() => {
      setIsFormatted(false);
      setFormattedCode('');
    }, [filePath]);

    const toggleFormatJson = useCallback(() => {
      if (isFormatted) {
        setIsFormatted(false);
        setFormattedCode('');
        return;
      }
      const res = formatJsonSafe(plainCode, 2, filePath);
      if (res.success) {
        setFormattedCode(res.formatted);
        setIsFormatted(true);
      } else {
        showToast(`JSON 格式化失败：${res.error || '语法错误'}`);
      }
    }, [isFormatted, plainCode, showToast]);

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
          const res = await readTextFile(filePath, 20000);
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
          icon: <AppIcon name="folder-open" size={14} aria-hidden />,
          onClick: handleOpenSystemExplorer,
        },
        {
          id: 'copy-rel-path',
          label: '复制相对路径',
          icon: <AppIcon name="copy" size={14} aria-hidden />,
          onClick: handleCopyRelativePath,
        },
        {
          id: 'copy-abs-path',
          label: '复制绝对路径',
          icon: <AppIcon name="file-code" size={14} aria-hidden />,
          onClick: handleCopyAbsolutePath,
        },
        {
          id: 'open-with-default',
          label: '选择打开方式',
          hint: openDefaultLabel,
          icon: <AppIcon name="external-link" size={14} aria-hidden />,
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
            <AppIcon name="app-window" size={14}
              style={{
                flexShrink: 0,
                color: 'var(--text-secondary)',
              }} />
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
        icon: <AppIcon name="locate" size={14} aria-hidden />,
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
        ref={cardRef}
        className={`${styles.card} chat-side-panel`}
        aria-label="单文件代码查看"
        data-file-preview-host="file-viewer"
        style={{ position: 'relative' }}
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
            {/* ① JSON 格式化排版 */}
            {isJson && viewMode === 'plain' ? (
              <Tooltip content={isFormatted ? '还原紧凑格式' : '格式化 JSON 排版'}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`${styles.actBtn} ${isFormatted ? styles.actBtnActive : ''}`}
                  aria-label={isFormatted ? '还原紧凑格式' : '格式化 JSON 排版'}
                  aria-pressed={isFormatted}
                  onClick={toggleFormatJson}
                  icon={<AppIcon name="braces" size={14} />}
                >
                  {isFormatted ? '还原' : '格式化'}
                </Button>
              </Tooltip>
            ) : null}

            {/* ② 切换自动换行 */}
            <Tooltip content={wordWrap ? '关闭自动换行' : '开启自动换行'}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={`${styles.actBtn} ${wordWrap ? styles.actBtnActive : ''}`}
                aria-label={wordWrap ? '关闭自动换行' : '开启自动换行'}
                aria-pressed={wordWrap}
                onClick={() => toggleWordWrap()}
                icon={<AppIcon name="wrap-text" size={14} />}
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
                icon={<AppIcon name="copy" size={14} />}
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
                icon={<AppIcon name="history" size={14} />}
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
                      icon={<AppIcon name="more-horizontal" size={14} />}
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
                  <AppIcon name="loader" size={16} className="spin" />
                  <span>正在加载源码...</span>
                </div>
              ) : (
                <>
                  <VirtualPlainCodeViewer
                    content={displayCode}
                    filePath={filePath}
                    wordWrap={wordWrap}
                  />
                  {plainTruncated && (
                    <div className={styles.truncNotice} role="status">
                      已加载前 {plainLineCount} 行（超出 {FILE_PREVIEW_MAX_LINES} 行上限已截断），如需完整内容请用系统关联程序打开
                    </div>
                  )}
                </>
              )
            ) : f && f.changes && f.changes.length > 0 ? (
              <DiffCardUnifiedView
                f={f}
                renderItems={unifiedRenderItems}
                onExpandBlock={() => {}}
              />
            ) : (
              <div className={styles.diffEmpty}>
                <AppIcon name="file-diff" size={22}
                  className={styles.diffEmptyIcon}
                  aria-hidden />
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

        <FileAnnotationPopover
          filePath={absolutePath}
          containerRef={cardRef}
        />
      </div>
    );
  }
);

FileViewerCard.displayName = 'FileViewerCard';

export { FileViewerCardView } from './FileViewerCardView';
import { AppIcon } from '../ui/icons/index';
