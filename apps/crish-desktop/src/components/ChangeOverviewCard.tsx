/**
 * 助手回合完成后的改动总览：克制、中性灰，可展开文件列表，一点打开变更面板。
 * 支持「接受」落盘 / 「拒绝」从列表移除（与 Diff 面板闭环一致）。
 * 不做成彩色胶囊堆叠，避免喧宾夺主。
 */
import React, { useCallback, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import type { FileDiff, SessionMessage } from '../store/layoutStore';
import { useLayoutStore } from '../store/layoutStore';
import {
  applyFileDiffToDisk,
  applyFileDiffsToDisk,
  classifyFileDiff,
} from '../api/applyFileDiff';
import { publishToolDiffs } from '../api/publishToolDiffs';
import { resolveToolDiffs } from '../api/toolFeedback';

export type ChangeOverviewCardProps = {
  message: SessionMessage;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenDiffPanel?: () => void;
  onShowToast?: (message: string) => void;
};

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
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

/** 从助手消息工具调用中汇总 FileDiff（去重 path） */
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
  return [...map.values()];
}

export const ChangeOverviewCard: React.FC<ChangeOverviewCardProps> = ({
  message,
  onOpenDiff,
  onOpenDiffPanel,
  onShowToast,
}) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const removeDiffFile = useLayoutStore((s) => s.removeDiffFile);
  const files = useMemo(() => collectMessageDiffs(message), [message]);

  const toast = useCallback(
    (m: string) => {
      onShowToast?.(m);
    },
    [onShowToast],
  );

  const acceptOne = useCallback(
    async (f: FileDiff, e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();
      if (busy) return;
      if (!classifyFileDiff(f).ok) {
        toast('此 diff 无法安全自动应用，请在编辑器确认');
        return;
      }
      setBusy(true);
      try {
        publishToolDiffs([f]);
        const result = await applyFileDiffToDisk(f);
        if (result.ok === true) {
          removeDiffFile(f.filePath);
          toast(
            result.alreadyApplied
              ? `已是目标内容 · ${basename(f.filePath)}`
              : `已应用 · ${basename(f.filePath)}`,
          );
        } else {
          toast(result.message || '此 diff 无法安全自动应用，请在编辑器确认');
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, removeDiffFile, toast],
  );

  const acceptAll = useCallback(
    async (e?: React.MouseEvent) => {
      e?.stopPropagation();
      if (busy || !files.length) return;
      const safe = files.filter((f) => classifyFileDiff(f).ok);
      if (!safe.length) {
        toast('此 diff 无法安全自动应用，请在编辑器确认');
        return;
      }
      setBusy(true);
      try {
        publishToolDiffs(safe);
        const { applied, skipped, failed, results } = await applyFileDiffsToDisk(safe);
        for (const r of results) {
          if (r.result.ok) removeDiffFile(r.filePath);
        }
        const parts: string[] = [];
        if (applied) parts.push(`应用 ${applied}`);
        if (skipped) parts.push(`已同步 ${skipped}`);
        if (failed) parts.push(`失败 ${failed}`);
        const unsafe = files.length - safe.length;
        if (unsafe > 0) parts.push(`跳过 ${unsafe}`);
        toast(parts.length ? `全部接受 · ${parts.join(' · ')}` : '全部接受完成');
      } finally {
        setBusy(false);
      }
    },
    [busy, files, removeDiffFile, toast],
  );

  if (files.length === 0) return null;

  const additions = files.reduce((n, f) => n + (f.additions || 0), 0);
  const deletions = files.reduce((n, f) => n + (f.deletions || 0), 0);

  return (
    <div className="change-overview">
      <div className="change-overview-bar">
        <button
          type="button"
          className="change-overview-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <Lucide.FileDiff size={15} strokeWidth={1.75} className="change-overview-ico" />
          <span className="change-overview-title">
            改动 · {files.length} 个文件
          </span>
          <span className="change-overview-stat">
            <span className="add">+{additions}</span>
            <span className="del">−{deletions}</span>
          </span>
          <Lucide.ChevronDown
            size={14}
            className={`change-overview-chev ${open ? 'open' : ''}`}
          />
        </button>
        <div className="change-overview-actions">
          <button
            type="button"
            className="change-overview-review"
            disabled={busy}
            title="全部接受可安全应用的文件"
            onClick={(e) => void acceptAll(e)}
          >
            全部接受
          </button>
          <button
            type="button"
            className="change-overview-review"
            onClick={() => {
              if (files[0]) onOpenDiff(files[0]);
              onOpenDiffPanel?.();
            }}
          >
            查看变更
          </button>
        </div>
      </div>
      {open ? (
        <ul className="change-overview-list">
          {files.map((f) => {
            const canApply = classifyFileDiff(f).ok;
            return (
              <li key={f.filePath} className="change-overview-row">
                <button
                  type="button"
                  className="change-overview-file"
                  title={f.filePath}
                  onClick={() => onOpenDiff(f)}
                >
                  <Lucide.FileCode2 size={14} strokeWidth={1.75} />
                  <span className="change-overview-name">{basename(f.filePath)}</span>
                  <span className="change-overview-path">{f.filePath}</span>
                  <span className="change-overview-stat sm">
                    <span className="add">+{f.additions || 0}</span>
                    <span className="del">−{f.deletions || 0}</span>
                  </span>
                </button>
                <div className="change-overview-file-actions">
                  <button
                    type="button"
                    className="change-overview-mini-btn accept"
                    title={canApply ? '接受并写入磁盘' : '无法安全自动应用'}
                    disabled={busy || !canApply}
                    onClick={(e) => void acceptOne(f, e)}
                  >
                    接受
                  </button>
                  <button
                    type="button"
                    className="change-overview-mini-btn"
                    title="从变更列表移除"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeDiffFile(f.filePath);
                      toast(`已拒绝 · ${basename(f.filePath)}`);
                    }}
                  >
                    拒绝
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
};
