/**
 * 变更面板纯助手：来源模式 / 回合标签（与 DiffCard UI 同源，供单测钉住契约）。
 */
import type { FileDiff, SessionMessage } from '../store/layoutStore';
import { resolveToolDiffs } from './toolFeedback';
import { filterPublishableDiffs } from './publishToolDiffs';

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

/** 多回合 AI 改动按路径合并（后写优先内容，计数相加） */
export function mergeSessionDiffFiles(turns: ReadonlyArray<{ files: FileDiff[] }>): FileDiff[] {
  const map = new Map<string, FileDiff>();
  for (const t of turns) {
    for (const f of t.files) {
      mergeDiff(map, f);
    }
  }
  return [...map.values()];
}

