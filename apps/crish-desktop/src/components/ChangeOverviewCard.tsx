/**
 * 助手回合完成后的改动总览：克制、中性灰，可展开文件列表，一点打开变更面板。
 * 不做成彩色胶囊堆叠，避免喧宾夺主。
 */
import React, { useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import type { FileDiff, SessionMessage } from '../store/layoutStore';
import { resolveToolDiffs } from '../api/toolFeedback';

export type ChangeOverviewCardProps = {
  message: SessionMessage;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenDiffPanel?: () => void;
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
}) => {
  const [open, setOpen] = useState(false);
  const files = useMemo(() => collectMessageDiffs(message), [message]);

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
      {open ? (
        <ul className="change-overview-list">
          {files.map((f) => (
            <li key={f.filePath}>
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
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
