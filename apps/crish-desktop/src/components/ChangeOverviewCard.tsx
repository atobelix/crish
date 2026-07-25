/**
 * 助手回合完成后的改动总览：克制、中性灰，可展开文件列表，一点打开变更面板。
 * 支持「接受」落盘 / 「拒绝」从列表移除（与 Diff 面板闭环一致）。
 * 反馈：成功静默（条目消失）；失败行内 + toast；无成功 toast。
 * 不做成彩色胶囊堆叠，避免喧宾夺主。
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import styles from './ChangeOverviewCard.module.css';
import * as Lucide from 'lucide-react';
import type { FileDiff, SessionMessage } from '../store/layoutStore';
import { useLayoutStore } from '../store/layoutStore';
import {
  applyFileDiffToDisk,
  applyFileDiffsToDisk,
  classifyFileDiff,
  formatApplyFailureToast,
} from '../api/applyFileDiff';
import { filterPublishableDiffs, publishToolDiffs } from '../api/publishToolDiffs';
import { resolveToolDiffs } from '../api/toolFeedback';
import { Tooltip } from './Tooltip';

export type ChangeOverviewCardProps = {
  message: SessionMessage;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenDiffPanel?: (() => void) | undefined;
  onShowToast?: ((message: string) => void) | undefined;
};

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

/** 父路径（展示用，密度：窄栏 CSS 会藏长路径） */
function parentPath(p: string): string {
  const n = (p || '').replace(/\\/g, '/');
  const i = n.lastIndexOf('/');
  if (i <= 0) return '';
  return n.slice(0, i);
}

function mergeDiff(map: Map<string, FileDiff>, d: FileDiff) {
  if (!d?.filePath) return;
  const prev = map.get(d.filePath);
  if (!prev) {
    map.set(d.filePath, d);
    return;
  }
  map.set(d.filePath, {
    ...d,
    additions: (prev.additions || 0) + (d.additions || 0),
    deletions: (prev.deletions || 0) + (d.deletions || 0),
    changes: [...(prev.changes || []), ...(d.changes || [])].slice(0, 400),
  });
}

/** 从助手消息工具调用中汇总 FileDiff（去重 path；丢弃不可发布垃圾） */
export function collectMessageDiffs(message: SessionMessage): FileDiff[] {
  const map = new Map<string, FileDiff>();
  for (const tc of message.toolCalls || []) {
    for (const d of tc.diffs || []) mergeDiff(map, d);
    // 结构化 diffs 为空时，从输出/参数再解析编辑类 diff
    if (!(tc.diffs && tc.diffs.length)) {
      for (const d of resolveToolDiffs({
        name: tc.name || '',
        args: tc.arguments,
        output: tc.output,
      })) {
        mergeDiff(map, d);
      }
    }
  }
  // 总览与右侧变更列表共用发布门槛，避免占位/越界路径刷屏
  return filterPublishableDiffs([...map.values()]);
}

/** 行级空改动：无可视 +/- 统计且无有效 change 行 */
function isEmptyLineDiff(f: FileDiff): boolean {
  const add = f.additions || 0;
  const del = f.deletions || 0;
  if (add > 0 || del > 0) return false;
  const ch = f.changes || [];
  if (!ch.length) return true;
  return !ch.some((c) => c && (c.type === 'addition' || c.type === 'deletion'));
}

export const ChangeOverviewCard: React.FC<ChangeOverviewCardProps> = ({
  message,
  onOpenDiff,
  onOpenDiffPanel,
  onShowToast,
}) => {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 本卡已接受/拒绝的路径：消息 toolCalls 不会变，须本地剔除才「条目消失」 */
  const [resolved, setResolved] = useState<Set<string>>(() => new Set());
  /** 硬失败行内条；成功不写 */
  const [inlineErr, setInlineErr] = useState('');
  const errTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const removeDiffFile = useLayoutStore((s) => s.removeDiffFile);

  const allFiles = useMemo(() => collectMessageDiffs(message), [message]);
  const files = useMemo(
    () => allFiles.filter((f) => f.filePath && !resolved.has(f.filePath)),
    [allFiles, resolved],
  );

  const clearErrTimer = useCallback(() => {
    if (errTimerRef.current) {
      clearTimeout(errTimerRef.current);
      errTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearErrTimer(), [clearErrTimer]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open]);

  // 全部处理完后收起，避免空列表占位
  useEffect(() => {
    if (files.length === 0 && open) setOpen(false);
  }, [files.length, open]);

  const dismissErr = useCallback(() => {
    clearErrTimer();
    setInlineErr('');
  }, [clearErrTimer]);

  /** 仅失败：行内 + 可选 toast；空串 / 成功绝不触发 */
  const fail = useCallback(
    (m: string) => {
      const t = (m || '').trim();
      if (!t) return;
      clearErrTimer();
      setInlineErr(t);
      onShowToast?.(t);
      errTimerRef.current = setTimeout(() => {
        setInlineErr('');
        errTimerRef.current = null;
      }, 6000);
    },
    [clearErrTimer, onShowToast],
  );

  const markResolved = useCallback((filePath: string) => {
    if (!filePath) return;
    setResolved((prev) => {
      if (prev.has(filePath)) return prev;
      const next = new Set(prev);
      next.add(filePath);
      return next;
    });
  }, []);

  const markResolvedMany = useCallback((paths: string[]) => {
    if (!paths.length) return;
    setResolved((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const p of paths) {
        if (p && !next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const acceptOne = useCallback(
    async (f: FileDiff, e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();
      if (busy) return;
      const name = basename(f.filePath);
      if (!classifyFileDiff(f).ok) {
        fail(`无法安全自动应用 · ${name}，请在编辑器确认`);
        return;
      }
      setBusy(true);
      dismissErr();
      try {
        publishToolDiffs([f]);
        const result = await applyFileDiffToDisk(f);
        if (result.ok === true) {
          removeDiffFile(f.filePath);
          markResolved(f.filePath);
          // 条目消失即反馈，无成功 toast
        } else {
          fail(
            formatApplyFailureToast(1, [{ filePath: f.filePath, result }]) ||
              result.message ||
              `无法安全自动应用 · ${name}`,
          );
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        fail(detail ? `应用失败 · ${name}：${detail}` : `应用失败 · ${name}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, dismissErr, fail, markResolved, removeDiffFile],
  );

  const acceptAll = useCallback(
    async (e?: React.MouseEvent) => {
      e?.stopPropagation();
      if (busy || !files.length) return;
      const safe = files.filter((f) => classifyFileDiff(f).ok);
      if (!safe.length) {
        fail('无法安全自动应用，请在编辑器确认');
        return;
      }
      setBusy(true);
      dismissErr();
      try {
        publishToolDiffs(safe);
        const { failed, results } = await applyFileDiffsToDisk(safe);
        const okPaths: string[] = [];
        for (const r of results) {
          if (r.result.ok) {
            removeDiffFile(r.filePath);
            okPaths.push(r.filePath);
          }
        }
        markResolvedMany(okPaths);
        // 成功静默；仅失败 toast（含首个失败文件名）
        if (failed > 0) fail(formatApplyFailureToast(failed, results));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        fail(detail ? `应用失败：${detail}` : '应用失败');
      } finally {
        setBusy(false);
      }
    },
    [busy, dismissErr, fail, files, markResolvedMany, removeDiffFile],
  );

  const rejectOne = useCallback(
    (f: FileDiff, e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();
      if (busy) return;
      removeDiffFile(f.filePath);
      markResolved(f.filePath);
      // 列表移除即反馈，不 toast
    },
    [busy, markResolved, removeDiffFile],
  );

  const rejectAll = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      if (busy || !files.length) return;
      const paths = files.map((f) => f.filePath).filter(Boolean);
      for (const p of paths) removeDiffFile(p);
      markResolvedMany(paths);
    },
    [busy, files, markResolvedMany, removeDiffFile],
  );

  // 无改动 / 已全部处理：不占位（空态由父级消息流承担，不刷 toast）
  if (files.length === 0) return null;

  const additions = files.reduce((n, f) => n + (f.additions || 0), 0);
  const deletions = files.reduce((n, f) => n + (f.deletions || 0), 0);
  const safeCount = files.reduce((n, f) => n + (classifyFileDiff(f).ok ? 1 : 0), 0);
  const titleAria = `改动总览，${files.length} 个文件，+${additions} −${deletions}${
    busy ? '，应用中' : ''
  }`;

  return (
    <div
      className={styles.changeOverview}
      role="region"
      aria-label="改动总览"
      aria-busy={busy || undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <div className={styles.changeOverviewBar}>
        <button
          type="button"
          className={styles.changeOverviewToggle}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={listId}
          aria-label={titleAria}
        >
          <Lucide.FileDiff
            size={15}
            strokeWidth={1.75}
            className={styles.changeOverviewIco}
            aria-hidden
          />
          <span className={styles.changeOverviewTitle}>
            改动 · {files.length} 文件
          </span>
          <span className={styles.changeOverviewStat} aria-hidden>
            <span className="add">+{additions}</span>
            <span className="del">−{deletions}</span>
          </span>
          {busy ? (
            <span className={styles.changeOverviewTitle} role="status" aria-live="polite">
              应用中…
            </span>
          ) : null}
          <Lucide.ChevronDown
            size={14}
            className={`${styles.changeOverviewChev} ${open ? styles.open : ''}`}
            aria-hidden
          />
        </button>
        <div className={styles.changeOverviewActions} role="toolbar" aria-label="改动操作">
          <Tooltip content={
            safeCount === 0
              ? '无可安全自动应用的文件'
              : safeCount < files.length
                ? `全部接受（${safeCount}/${files.length} 可应用）`
                : '全部接受可安全应用的文件'
          }>
            <button
              type="button"
              className={styles.changeOverviewReview}
              disabled={busy || safeCount === 0}
              aria-label={
                safeCount === 0
                  ? '全部接受，当前无可安全应用的文件'
                  : `全部接受 ${safeCount} 个可安全应用的文件`
              }
              onClick={(e) => void acceptAll(e)}
            >
              全部接受
            </button>
          </Tooltip>
          {files.length > 1 ? (
            <Tooltip content="拒绝全部并从列表移除">
              <button
                type="button"
                className={styles.changeOverviewReview}
                disabled={busy}
                aria-label={`拒绝全部 ${files.length} 个文件`}
                onClick={(e) => rejectAll(e)}
              >
                全部拒绝
              </button>
            </Tooltip>
          ) : null}
          <Tooltip content="打开变更面板">
            <button
              type="button"
              className={styles.changeOverviewReview}
              disabled={busy}
              aria-label="查看变更"
              onClick={() => {
                if (files[0]) onOpenDiff(files[0]);
                onOpenDiffPanel?.();
              }}
            >
              查看变更
            </button>
          </Tooltip>
        </div>
      </div>

      {inlineErr ? (
        <div className={styles.filesActionHint} role="alert" aria-live="assertive">
          <span className={styles.filesActionHintText}>
            {inlineErr}
          </span>
          <Tooltip content="关闭">
            <button
              type="button"
              className={styles.filesActionHintDismiss}
              aria-label="关闭错误"
              onClick={dismissErr}
            >
              <Lucide.X size={12} aria-hidden />
            </button>
          </Tooltip>
        </div>
      ) : null}

      {open ? (
        <ul
          id={listId}
          className={styles.changeOverviewList}
          aria-label={`改动文件 ${files.length} 个`}
        >
          {files.map((f) => {
            const canApply = classifyFileDiff(f).ok;
            const emptyLine = isEmptyLineDiff(f);
            const name = basename(f.filePath);
            const parent = parentPath(f.filePath);
            const add = f.additions || 0;
            const del = f.deletions || 0;
            return (
              <li key={f.filePath} className={styles.changeOverviewRow}>
                <Tooltip content={f.filePath}>
                  <button
                    type="button"
                    className={styles.changeOverviewFile}
                    aria-label={
                      emptyLine
                        ? `打开变更 ${name}，无行级 diff`
                        : `打开变更 ${name}，+${add} −${del}`
                    }
                    onClick={() => onOpenDiff(f)}
                  >
                    <Lucide.FileCode2 size={14} strokeWidth={1.75} aria-hidden />
                    <span className={styles.changeOverviewName}>{name}</span>
                    {parent ? (
                      <span className={styles.changeOverviewPath}>{parent}</span>
                    ) : null}
                    <span className={`${styles.changeOverviewStat} ${styles.changeOverviewStatGlobalSm}`} aria-hidden>
                      {emptyLine ? (
                        <span className="del">无行级</span>
                      ) : (
                        <>
                          <span className="add">+{add}</span>
                          <span className="del">−{del}</span>
                        </>
                      )}
                    </span>
                  </button>
                </Tooltip>
                <div className={styles.changeOverviewFileActions}>
                  <Tooltip content={canApply ? '接受并写入磁盘' : '无法安全自动应用'}>
                    <button
                      type="button"
                      className={`${styles.changeOverviewMiniBtn} ${styles.accept}`}
                      aria-label={
                        canApply ? `接受 ${name}` : `无法自动应用 ${name}`
                      }
                      disabled={busy || !canApply}
                      onClick={(e) => void acceptOne(f, e)}
                    >
                      接受
                    </button>
                  </Tooltip>
                  <Tooltip content="从变更列表移除">
                    <button
                      type="button"
                      className={styles.changeOverviewMiniBtn}
                      aria-label={`拒绝 ${name}`}
                      disabled={busy}
                      onClick={(e) => rejectOne(f, e)}
                    >
                      拒绝
                    </button>
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
};
