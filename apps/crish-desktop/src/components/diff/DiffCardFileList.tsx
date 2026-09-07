import React, { useMemo, useCallback } from 'react';
import * as Lucide from 'lucide-react';
import styles from './DiffCard.module.css';
import { Button, IconButton, Tooltip } from '../ui';
import type { FileDiff } from '../../store/types';
import type { DiffSourceMode } from '../../api/diffPanelHelpers';
import type { CompareMode } from './diffCardTypes';
import { formatGitPatch } from './GitPatchFormatter';
import { useToast } from '../../services/toast/ToastContext';

/**
 * 差异面板文件列表组件属性契约
 * 遵循单轨解耦规范，拔除单文件行内工具栏专用死属性，保留正交交互通道
 */
export interface DiffCardFileListProps {
  /** 变更文件列表数据 */
  files: FileDiff[];
  /** 差异来源模式：'git' 或 'session' */
  sourceMode: DiffSourceMode;
  /** 当前处于内联激活展开状态的文件对象 */
  current: FileDiff | null;
  /** 是否处于文件暂存/应用异步执行中 */
  applyBusy: boolean;
  /** 文件暂存状态字典 (filePath -> boolean) */
  stagingPaths: Record<string, boolean>;
  /** AI 会话回合历史数据 (用于关联计算) */
  aiTurns?: Array<{
    msg: { id: string; timestamp: number };
    index: number;
    files: FileDiff[];
  }>;
  /** 点击折叠箭头切换当前内联展开文件 */
  onSetActiveDiffSource: (diff: FileDiff | null) => void;
  /** Git 单文件暂存回调 */
  onStageFile: (filePath: string) => void;
  /** Git 单文件取消暂存回调 */
  onUnstageFile: (filePath: string) => void;
  /** Git 单文件放弃本地修改回调 */
  onDiscardChanges: (filePath: string) => void;
  /** 全部暂存回调 */
  onStageAll: () => void;
  /** 全部取消暂存回调 */
  onUnstageAll: () => void;
  /** 内联代码比对区渲染函数 */
  renderInlineDiffContent: (f: FileDiff) => React.ReactNode;
  /** 获取最新合并/派生差异数据回调 */
  getFileDiffData?: (f: FileDiff) => FileDiff | null;
  /** 点击文件名超链接在右侧独立 Tab 打开 FileViewer 预览回调 (正交子域 B) */
  onOpenFileViewer?: (filePath: string) => void;

  /* =========================================================================
   * 兼容性保留契约：标记为可选，确保上层 DiffCard.tsx 无损平滑演进过渡
   * ========================================================================= */
  getFileCompareMode?: (filePath: string) => CompareMode;
  onChangeCompareMode?: (filePath: string, mode: CompareMode) => void;
  onAcceptFile?: (f: FileDiff) => void;
  onRejectFile?: (f: FileDiff) => void;
  onCopyCode?: (filePath: string) => void;
}

/**
 * 拆分物理路径为文件名与所在目录
 * @param filePath 原始文件路径
 */
function splitFilePath(filePath: string): { name: string; dir: string } {
  if (!filePath) return { name: '', dir: '' };
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlashIndex = normalized.lastIndexOf('/');
  if (lastSlashIndex === -1) {
    return { name: normalized, dir: '' };
  }
  return {
    name: normalized.slice(lastSlashIndex + 1),
    dir: normalized.slice(0, lastSlashIndex + 1),
  };
}

/**
 * 解析文件 Git 语义状态徽标属性
 * 区分 Modified(M), Added(A), Deleted(D), Renamed(R)
 * 契约收敛：tooltip 字段专供原子 Tooltip 组件消费，严禁暴露原生 title
 */
function resolveStatusBadge(f: FileDiff): {
  char: 'M' | 'A' | 'D' | 'R';
  key: 'mod' | 'add' | 'del' | 'ren';
  tooltip: string;
} {
  const rawStatus = (f as { status?: string }).status;
  const rawNewPath = (f as { newPath?: string }).newPath;
  const gitStatus = (f.gitStatus || (f.untracked ? 'untracked' : undefined) || '').toUpperCase();

  if (
    rawStatus === 'added' ||
    rawStatus === 'untracked' ||
    gitStatus === 'A' ||
    gitStatus === '??' ||
    gitStatus === 'UNTRACKED' ||
    (Boolean(f.additions) && !f.deletions && !f.oldPath)
  ) {
    return { char: 'A', key: 'add', tooltip: '新增文件' };
  }
  if (
    rawStatus === 'deleted' ||
    gitStatus === 'D' ||
    (!f.additions && Boolean(f.deletions) && !rawNewPath)
  ) {
    return { char: 'D', key: 'del', tooltip: '已删除文件' };
  }
  if (
    rawStatus === 'renamed' ||
    gitStatus === 'R' ||
    (Boolean(f.oldPath) && Boolean(rawNewPath || f.filePath) && f.oldPath !== (rawNewPath || f.filePath))
  ) {
    return { char: 'R', key: 'ren', tooltip: '重命名文件' };
  }
  return { char: 'M', key: 'mod', tooltip: '已修改文件' };
}

// 快捷操作 Tooltip 文案常量 (遵循同源铁律：aria-label 与 Tooltip content 同源引用)
const TOOLTIP_STAGE = '暂存此文件';
const TOOLTIP_UNSTAGE = '取消暂存此文件';
const TOOLTIP_DISCARD = '放弃此文件的所有修改';
const TOOLTIP_COPY_PATCH = '复制此文件差异 Patch';

/**
 * 差异面板平直单轨文件列表组件
 * 彻底拔除卡片手风琴外壳、行内工具条，实现 32px 紧凑直角单轨
 */
export const DiffCardFileList: React.FC<DiffCardFileListProps> = ({
  files,
  sourceMode,
  current,
  applyBusy,
  stagingPaths,
  onSetActiveDiffSource,
  onStageFile,
  onUnstageFile,
  onDiscardChanges,
  onStageAll,
  onUnstageAll,
  renderInlineDiffContent,
  getFileDiffData,
  onOpenFileViewer,
  onCopyCode,
}) => {
  const { showToast } = useToast();

  const copySingleFilePatch = useCallback(
    // audit-repair-202609 T24：await 写剪贴板结果后再提示——写失败不得假报「已复制」
    async (f: FileDiff) => {
      const targetDiff = getFileDiffData ? (getFileDiffData(f) ?? f) : f;
      const patch = formatGitPatch(targetDiff);
      const { name } = splitFilePath(f.filePath);
      if (!patch || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        showToast(`复制失败：暂无 ${name} 的差异内容`);
        return;
      }
      try {
        await navigator.clipboard.writeText(patch);
        showToast(`已复制 ${name} 差异 Patch`);
        onCopyCode?.(f.filePath);
      } catch {
        showToast('复制失败：剪贴板不可用');
      }
    },
    [getFileDiffData, showToast, onCopyCode]
  );
  // Git 模式下按已暂存与未暂存正交分组
  const { stagedFiles, unstagedFiles } = useMemo(() => {
    const staged: FileDiff[] = [];
    const unstaged: FileDiff[] = [];
    for (const f of files) {
      if (f.staged) {
        staged.push(f);
      } else {
        unstaged.push(f);
      }
    }
    return { stagedFiles: staged, unstagedFiles: unstaged };
  }, [files]);

  /**
   * 渲染单个平直文件节点（包含三大正交子域与嵌合比对区）
   */
  const renderFlatFileNode = (f: FileDiff) => {
    if (!f || !f.filePath) return null;
    const active = current?.filePath === f.filePath;
    const targetDiff = getFileDiffData ? (getFileDiffData(f) ?? f) : f;
    const additions = targetDiff.additions ?? f.additions ?? 0;
    const deletions = targetDiff.deletions ?? f.deletions ?? 0;
    const { name, dir } = splitFilePath(f.filePath);
    const badge = resolveStatusBadge(f);
    const isStaging = Boolean(stagingPaths[f.filePath]);

    return (
      <div
        key={f.filePath}
        className={styles.fileNode}
        role="listitem"
        data-active={active}
      >
        {/* 平直文件交互行 (32px 纯偶数净高，纯直角贴边容器，div 语义容器彻底杜绝 button 嵌套) */}
        <div
          className={`${styles.fileRow} ${active ? styles.isActive : ''}`}
          data-active={active}
          role="row"
        >
          {/* =================================================================
           * 子域 A：折叠展开控制与语义化状态徽章（原子 Tooltip 包裹）
           * ================================================================= */}
          <button
            type="button"
            className={styles.chevronBtn}
            onClick={() => onSetActiveDiffSource(active ? null : f)}
            aria-label={active ? `折叠 ${name} 差异代码` : `展开 ${name} 差异代码`}
            aria-expanded={active}
          >
            <Lucide.ChevronRight
              size={14}
              className={`${styles.chevronIcon} ${active ? styles.expanded : ''}`}
              aria-hidden
            />
          </button>

          <Tooltip content={badge.tooltip}>
            <span
              className={`${styles.statusBadge} ${styles[badge.key]}`}
              aria-label={badge.tooltip}
            >
              {badge.char}
            </span>
          </Tooltip>

          {/* =================================================================
           * 子域 B：独立超链接与路径分级 (点击在右侧打开独立预览 Tab，原子 Tooltip 包裹)
           * ================================================================= */}
          <div className={styles.pathWrap}>
            <Tooltip content={`在独立标签页打开差异：${f.filePath}`}>
              <button
                type="button"
                className={styles.fileNameLinkBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onOpenFileViewer) {
                    onOpenFileViewer(f.filePath);
                  } else {
                    onSetActiveDiffSource(active ? null : f);
                  }
                }}
                aria-label={`在独立标签页预览文件 ${name}`}
              >
                <span className={styles.fileName}>{name}</span>
              </button>
            </Tooltip>

            {dir ? (
              <Tooltip content={`文件所在目录：${dir}（点击折叠/展开）`}>
                <span
                  className={styles.dirPath}
                  onClick={() => onSetActiveDiffSource(active ? null : f)}
                >
                  {dir}
                </span>
              </Tooltip>
            ) : null}
          </div>

          {/* =================================================================
           * 子域 C：统计与操作共用槽 (数字加减与暂存撤销共用区域，消除右侧空洞)
           * ================================================================= */}
          <div className={`${styles.statActionSlot} ${styles.statActionsGroup} ${styles.actionsContainer}`}>
            {sourceMode === 'git' ? (
              <div
                className={styles.rowActions}
                onClick={(e) => e.stopPropagation()}
              >
                {isStaging ? (
                  <Lucide.Loader2
                    size={13}
                    className={styles.spinner}
                    aria-label="正在处理暂存操作"
                  />
                ) : f.staged ? (
                  <>
                    <IconButton
                      size="xs"
                      variant="ghost"
                      aria-label={TOOLTIP_UNSTAGE}
                      tooltip={TOOLTIP_UNSTAGE}
                      disabled={applyBusy}
                      onClick={() => void onUnstageFile(f.filePath)}
                      icon={<Lucide.Minus size={13} />}
                    />
                    <IconButton
                      size="xs"
                      variant="ghost"
                      aria-label={TOOLTIP_COPY_PATCH}
                      tooltip={TOOLTIP_COPY_PATCH}
                      onClick={(e) => {
                        e.stopPropagation();
                        void copySingleFilePatch(f);
                      }}
                      icon={<Lucide.Copy size={13} />}
                    />
                  </>
                ) : (
                  <>
                    <IconButton
                      size="xs"
                      variant="ghost"
                      aria-label={TOOLTIP_STAGE}
                      tooltip={TOOLTIP_STAGE}
                      disabled={applyBusy}
                      onClick={() => void onStageFile(f.filePath)}
                      icon={<Lucide.Plus size={13} />}
                    />
                    <IconButton
                      size="xs"
                      variant="ghost"
                      aria-label={TOOLTIP_COPY_PATCH}
                      tooltip={TOOLTIP_COPY_PATCH}
                      onClick={(e) => {
                        e.stopPropagation();
                        void copySingleFilePatch(f);
                      }}
                      icon={<Lucide.Copy size={13} />}
                    />
                    <IconButton
                      size="xs"
                      variant="ghost"
                      className={`${styles.dangerBtn} ${styles.danger}`}
                      aria-label={TOOLTIP_DISCARD}
                      tooltip={TOOLTIP_DISCARD}
                      disabled={applyBusy}
                      onClick={() => void onDiscardChanges(f.filePath)}
                      icon={<Lucide.Undo2 size={13} />}
                    />
                  </>
                )}
              </div>
            ) : null}

            <span
              className={styles.fileStat}
              aria-label={`增加 ${additions} 行，删除 ${deletions} 行`}
            >
              {additions > 0 ? (
                <span className={styles.statAdd}>+{additions}</span>
              ) : null}
              {deletions > 0 ? (
                <span className={styles.statDel}>−{deletions}</span>
              ) : null}
              {additions === 0 && deletions === 0 ? (
                <span className={styles.statNeutral}>0</span>
              ) : null}
            </span>
          </div>
        </div>

        {/* 展开的代码比对视口（无缝垂直嵌合，零外框，零工具行） */}
        {active ? (
          <div className={styles.diffPane}>
            {renderInlineDiffContent(f)}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className={styles.flatFileList}
      role="list"
      aria-label="变更文件列表"
    >
      {sourceMode === 'git' ? (
        <>
          {/* 已暂存分组 */}
          <div className={styles.groupSection}>
            <div className={styles.groupHeader}>
              <span className={styles.groupTitle}>
                已暂存的更改 ({stagedFiles.length})
              </span>
              {stagedFiles.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className={styles.groupActionBtn}
                  disabled={applyBusy}
                  onClick={onUnstageAll}
                  icon={<Lucide.MinusCircle size={13} className={styles.btnIcon} />}
                >
                  全部取消暂存
                </Button>
              ) : null}
            </div>

            {stagedFiles.length === 0 ? (
              <div className={styles.emptyGroup}>无已暂存的文件</div>
            ) : (
              <div className={styles.groupBody}>
                {stagedFiles.map(renderFlatFileNode)}
              </div>
            )}
          </div>

          {/* 未暂存分组 */}
          <div className={styles.groupSection}>
            <div className={styles.groupHeader}>
              <span className={styles.groupTitle}>
                未暂存的更改 ({unstagedFiles.length})
              </span>
              {unstagedFiles.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className={styles.groupActionBtn}
                  disabled={applyBusy}
                  onClick={onStageAll}
                  icon={<Lucide.PlusCircle size={13} className={styles.btnIcon} />}
                >
                  全部暂存
                </Button>
              ) : null}
            </div>

            {unstagedFiles.length === 0 ? (
              <div className={styles.emptyGroup}>无未暂存的修改</div>
            ) : (
              <div className={styles.groupBody}>
                {unstagedFiles.map(renderFlatFileNode)}
              </div>
            )}
          </div>
        </>
      ) : (
        files.map(renderFlatFileNode)
      )}
    </div>
  );
};
