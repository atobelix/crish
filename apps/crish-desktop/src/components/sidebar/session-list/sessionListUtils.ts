import type { SessionState } from '../../../store/layoutStore';

/** 去重：同 id 只保留首次出现，避免 store 抖动产生幽灵双行 */
export function dedupeSessionsById(list: SessionState[]): SessionState[] {
  if (list.length <= 1) return list;
  const seen = new Set<string>();
  const out: SessionState[] = [];
  for (const s of list) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}
