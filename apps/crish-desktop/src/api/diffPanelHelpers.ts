/**
 * 变更面板纯助手：来源模式 / 回合标签（与 DiffCard UI 同源，供单测钉住契约）。
 */
import type { FileDiff, SessionMessage } from '../store/layoutStore';

export type DiffSourceMode = 'session' | 'git' | 'list';

export function isDiffSourceMode(v: string): v is DiffSourceMode {
  return v === 'session' || v === 'git' || v === 'list';
}

/** 回合下拉短标签：回合序号 · 文件数 · 时间 */
export function assistantTurnLabel(
  msg: Pick<SessionMessage, 'timestamp'>,
  index: number,
  fileCount: number,
): string {
  const n = Math.max(0, fileCount);
  const t = new Date(msg.timestamp || Date.now());
  const time = `${t.getHours().toString().padStart(2, '0')}:${t
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
  if (n === 0) return `回合 ${index + 1} · ${time}`;
  return `回合 ${index + 1} · ${n} 个文件 · ${time}`;
}

/** 多回合 AI 改动按路径合并（后写优先内容，计数相加） */
export function mergeSessionDiffFiles(turns: ReadonlyArray<{ files: FileDiff[] }>): FileDiff[] {
  const map = new Map<string, FileDiff>();
  for (const t of turns) {
    for (const f of t.files) {
      const prev = map.get(f.filePath);
      if (!prev) map.set(f.filePath, f);
      else {
        map.set(f.filePath, {
          ...f,
          additions: (prev.additions || 0) + (f.additions || 0),
          deletions: (prev.deletions || 0) + (f.deletions || 0),
          changes: [...(prev.changes || []), ...(f.changes || [])].slice(0, 400),
        });
      }
    }
  }
  return [...map.values()];
}
