import React, { useMemo } from 'react';
import * as Lucide from 'lucide-react';
import styles from './DiffCard.module.css';
import { Tooltip } from '../ui';
import { SettingsSelect } from '../settings/SettingsSelect';
import { classifyFileDiff } from '../../api/applyFileDiff';
import { openPathDefault } from '../../api/hostOpenersApi';
import { getWorkspacePath } from '../../api/projectStore';
import type { FileDiff } from '../../store/types';
import type { CompareMode } from './diffCardTypes';
import type { DiffSourceMode } from '../../api/diffPanelHelpers';

type SourceMode = DiffSourceMode;

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

function isCompareMode(val: string): val is CompareMode {
  return val === 'git' || val === 'session-merged' || val === 'plain' || val.startsWith('turn-');
}

// 无名称图标按钮文案（同源约定）：aria-label 与 Tooltip content 同引用，禁止两处各写
const UNSTAGE_LABEL = '取消暂存此文件';
const STAGE_LABEL = '暂存此文件';
const DISCARD_LABEL = '放弃此文件的所有本地修改';
const REJECT_LABEL = '从列表拒绝（不回滚磁盘）';

interface DiffCardFileListProps {
  files: FileDiff[];
  sourceMode: SourceMode;
  current: FileDiff | null;
  applyBusy: boolean;
  stagingPaths: Record<string, boolean>;
  aiTurns: Array<{ msg: { id: string; timestamp: number }; index: number; files: FileDiff[] }>;
  getFileCompareMode: (filePath: string) => CompareMode;
  onChangeCompareMode: (filePath: string, mode: CompareMode) => void;
  onSetActiveDiffSource: (diff: FileDiff | null) => void;
  onStageFile: (filePath: string) => void;
  onUnstageFile: (filePath: string) => void;
  onDiscardChanges: (filePath: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onAcceptFile: (f: FileDiff) => void;
  onRejectFile: (f: FileDiff) => void;
  onCopyCode: (filePath: string) => void;
  onShowToast: (message: string) => void;
  renderInlineDiffContent: (f: FileDiff) => React.ReactNode;
}

export type { DiffCardFileListProps };

export const DiffCardFileList: React.FC<DiffCardFileListProps> = ({
  files,
  sourceMode,
  current,
  applyBusy,
  stagingPaths,
  aiTurns,
  getFileCompareMode,
  onChangeCompareMode,
  onSetActiveDiffSource,
  onStageFile,
  onUnstageFile,
  onDiscardChanges,
  onStageAll,
  onUnstageAll,
  onAcceptFile,
  onRejectFile,
  onCopyCode,
  onShowToast,
  renderInlineDiffContent,
}) => {
  const { stagedFiles, unstagedFiles } = useMemo(() => {
    const staged: FileDiff[] = [];
    const unstaged: FileDiff[] = [];
    for (const f of files) {
      if (f.staged) staged.push(f);
      else unstaged.push(f);
    }
    return { stagedFiles: staged, unstagedFiles: unstaged };
  }, [files]);
  const stagedCount = stagedFiles.length;
  const unstagedCount = unstagedFiles.length;

  const renderAccordionItem = (f: FileDiff) => {
    if (!f || !f.filePath) return null;
    const active = current?.filePath === f.filePath;
    const itemId = `diff-file-${f.filePath.replace(/[^\w.-]+/g, '_')}`;

    const cwd = getWorkspacePath();
    const isAbsolute = f.filePath.startsWith('/') || f.filePath.includes(':');
    const absolutePath = isAbsolute ? f.filePath : `${cwd}/${f.filePath}`;
    const fileAiTurns = aiTurns.filter((t) => t.files.some((m) => m.filePath === f.filePath));

    // 接受按钮文案随可应用性动态变化（同源约定：Tooltip content 与 aria-label 同引用）
    const acceptLabel = classifyFileDiff(f).ok ? '接受并写入磁盘' : '此 diff 无法安全自动应用';

    const compareOptions: { value: string; label: string; hint?: string }[] = [];
    if (sourceMode === 'git') {
      compareOptions.push({ value: 'git', label: 'Git 工作区改动' });
    } else {
      if (aiTurns.length > 0) {
        compareOptions.push({ value: 'session-merged', label: 'AI 汇总改动' });
      }
      fileAiTurns.forEach((t) => {
        compareOptions.push({
          value: `turn-${t.msg.id}`,
          label: `第 ${t.index + 1} 轮 AI 修改`,
          hint: `${new Date(t.msg.timestamp).toLocaleTimeString()}`,
        });
      });
    }
    compareOptions.push({ value: 'plain', label: '当前源码全文 (无 Diff)' });

    return (
      <div key={f.filePath} className={`${styles.accordionItem} ${active ? styles.accordionActive : ''}`}>
        <div className={styles.accordionHeaderRow}>
          <Tooltip content={f.filePath}>
            <button
              id={itemId}
              type="button"
              role="option"
              aria-selected={active}
              className={`${styles.fileItem} ${active ? styles.isActive : ''}`}
              onClick={() => onSetActiveDiffSource(active ? null : f)}
              aria-label={`${basename(f.filePath)} +${f.additions} −${f.deletions}`}
            >
              <span
                className={styles.fileNameLink}
                role="link"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onSetActiveDiffSource(active ? null : f);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onSetActiveDiffSource(active ? null : f);
                  }
                }}
              >
                {basename(f.filePath)}
              </span>

              <span className={styles.fileStat} aria-hidden>
                <span className="add">+{f.additions}</span>
                <span className="del">−{f.deletions}</span>
              </span>
            </button>
          </Tooltip>

          {sourceMode === 'git' && (
            <div className={styles.hoverActions}>
              {stagingPaths[f.filePath] ? (
                <Lucide.Loader2 size={13} className={styles.spinner} />
              ) : f.staged ? (
                <Tooltip content={UNSTAGE_LABEL}>
                  <button
                    type="button"
                    className={styles.hoverActBtn}
                    aria-label={UNSTAGE_LABEL}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onUnstageFile(f.filePath);
                    }}
                  >
                    <Lucide.Minus size={13} />
                  </button>
                </Tooltip>
              ) : (
                <>
                  <Tooltip content={STAGE_LABEL}>
                    <button
                      type="button"
                      className={styles.hoverActBtn}
                      aria-label={STAGE_LABEL}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onStageFile(f.filePath);
                      }}
                    >
                      <Lucide.Plus size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip content={DISCARD_LABEL}>
                    <button
                      type="button"
                      className={`${styles.hoverActBtn} ${styles.danger}`}
                      aria-label={DISCARD_LABEL}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDiscardChanges(f.filePath);
                      }}
                    >
                      <Lucide.Undo2 size={13} />
                    </button>
                  </Tooltip>
                </>
              )}
            </div>
          )}
        </div>

        {active && (
          <div className={styles.inlineBody}>
            {!classifyFileDiff(f).ok && (
              <div className={styles.applyHint} role="status">
                此 diff 无法安全自动应用，请在编辑器确认
              </div>
            )}

            <div className={styles.inlineHeader}>
              <div className={styles.compareSelectorWrap}>
                <span className={styles.selectLabel}>对比维度:</span>
                <SettingsSelect
                  value={getFileCompareMode(f.filePath)}
                  options={compareOptions}
                  onChange={(val) => {
                    if (isCompareMode(val)) {
                      onChangeCompareMode(f.filePath, val);
                    }
                  }}
                  className={styles.inlineCompareSelect ?? ''}
                />
              </div>

              <div className={styles.inlineActions}>
                <Tooltip content="在默认编辑器中打开该文件">
                  <button
                    type="button"
                    className={styles.inlineIconBtn}
                    onClick={() => void openPathDefault(absolutePath)}
                    aria-label="在编辑器打开"
                  >
                    <Lucide.ExternalLink size={13} />
                  </button>
                </Tooltip>

                <Tooltip content="复制最新文件源码">
                  <button
                    type="button"
                    className={styles.inlineIconBtn}
                    onClick={() => void onCopyCode(f.filePath)}
                    aria-label="复制代码"
                  >
                    <Lucide.Copy size={13} />
                  </button>
                </Tooltip>

                <Tooltip content="复制完整绝对路径">
                  <button
                    type="button"
                    className={styles.inlineIconBtn}
                    onClick={() => {
                      navigator.clipboard.writeText(absolutePath);
                      onShowToast('绝对路径已复制到剪贴板');
                    }}
                    aria-label="复制路径"
                  >
                    <Lucide.FileCode size={13} />
                  </button>
                </Tooltip>

                <div className={styles.actionDivider} />

                <Tooltip content={acceptLabel}>
                  <button
                    type="button"
                    className={`${styles.inlineActionBtn} ${styles.inlineActionAccept}`}
                    aria-label={acceptLabel}
                    disabled={applyBusy || !classifyFileDiff(f).ok}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onAcceptFile(f);
                    }}
                  >
                    <Lucide.Check size={14} aria-hidden />
                  </button>
                </Tooltip>

                <Tooltip content={REJECT_LABEL}>
                  <button
                    type="button"
                    className={styles.inlineActionBtn}
                    aria-label={REJECT_LABEL}
                    disabled={applyBusy}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRejectFile(f);
                    }}
                  >
                    <Lucide.X size={14} aria-hidden />
                  </button>
                </Tooltip>
              </div>
            </div>

            {renderInlineDiffContent(f)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`${styles.fileList} ${styles.isFullWidth}`} role="listbox" aria-label="变更文件列表">
      {sourceMode === 'git' ? (
        <div className={styles.gitGroupList}>
          <div className={styles.gitGroupSection}>
            <div className={styles.gitGroupHeader}>
              <span className={styles.groupTitle}>已暂存的更改 ({stagedCount})</span>
              {stagedCount > 0 && (
                <button type="button" className={styles.groupActionBtn} onClick={onUnstageAll}>
                  <Lucide.MinusCircle size={13} style={{ marginRight: 3 }} />
                  全部取消暂存
                </button>
              )}
            </div>
            {stagedCount === 0 ? (
              <div className={styles.groupEmptyHint}>无已暂存的文件</div>
            ) : (
              <div className={styles.groupItemsContainer}>
                {stagedFiles.map(renderAccordionItem)}
              </div>
            )}
          </div>
          <div className={styles.gitGroupSection}>
            <div className={styles.gitGroupHeader}>
              <span className={styles.groupTitle}>未暂存的更改 ({unstagedCount})</span>
              {unstagedCount > 0 && (
                <button type="button" className={styles.groupActionBtn} onClick={onStageAll}>
                  <Lucide.PlusCircle size={13} style={{ marginRight: 3 }} />
                  全部暂存
                </button>
              )}
            </div>
            {unstagedCount === 0 ? (
              <div className={styles.groupEmptyHint}>无未暂存的修改</div>
            ) : (
              <div className={styles.groupItemsContainer}>
                {unstagedFiles.map(renderAccordionItem)}
              </div>
            )}
          </div>
        </div>
      ) : (
        files.map(renderAccordionItem)
      )}
    </div>
  );
};
