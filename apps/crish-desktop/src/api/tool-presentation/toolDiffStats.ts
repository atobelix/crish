/**
 * 编辑与差异统计（Diff / Git Stats）纯函数。
 */

import type { MessageToolCall } from '../../store/layoutStore';
import { isEditToolName } from '../toolFeedbackDiff';

/** git shortstat 摘要行 */
export function parseGitShortstat(
  text: string
): { add: number; del: number } | null {
  if (!text) return null;
  const re =
    /(\d+)\s+files?\s+changed(?:\s*,\s*(\d+)\s+insertions?\(\+\))?(?:\s*,\s*(\d+)\s+deletions?\(-\))?/gi;
  let m: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(text)) != null) last = m;
  if (!last) {
    const loose = text.match(
      /(?:^|[\s,])(\d+)\s+insertions?\(\+\)(?:\s*,\s*(\d+)\s+deletions?\(-\))?/i
    );
    const onlyDel = !loose
      ? text.match(/(?:^|[\s,])(\d+)\s+deletions?\(-\)/i)
      : null;
    if (loose) {
      const a = Number(loose[1]) || 0;
      const d = Number(loose[2]) || 0;
      return a === 0 && d === 0 ? null : { add: a, del: d };
    }
    if (onlyDel) {
      const d = Number(onlyDel[1]) || 0;
      return d === 0 ? null : { add: 0, del: d };
    }
    return null;
  }
  const add = Number(last[2]) || 0;
  const del = Number(last[3]) || 0;
  return add === 0 && del === 0 ? null : { add, del };
}

const PATCH_HEAD_RE =
  /^(diff --git |@@\s|\+\+\+ |--- |\*{3}\s+(Begin Patch|Update File|Add File|Delete File|End Patch)|\*\*\* (Begin Patch|Update File|Add File))/i;

export function looksLikeUnifiedOrPatchText(lines: string[]): boolean {
  return lines.some((l) => PATCH_HEAD_RE.test(l));
}

export function isDiffMetaPlusMinusLine(line: string): boolean {
  return (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    /^\+\+\+ \//.test(line) ||
    /^--- \//.test(line)
  );
}

/** 编辑类工具行内 +N / −M */
export function toolDiffLineStats(
  tc: MessageToolCall
): { add: number; del: number } | null {
  // 只有在实际编辑/修改文件时才需要显示差异变化，只读查看命令绝不显示差异
  if (!isEditToolName(tc.name)) {
    return null;
  }
  let add = 0;
  let del = 0;
  if (tc.diffs?.length) {
    for (const d of tc.diffs) {
      let dAdd = Number.isFinite(d.additions) ? Math.max(0, d.additions) : 0;
      let dDel = Number.isFinite(d.deletions) ? Math.max(0, d.deletions) : 0;
      if (d.changes?.length) {
        let cAdd = 0,
          cDel = 0;
        for (const c of d.changes) {
          if (c.type === 'addition') cAdd += 1;
          else if (c.type === 'deletion') cDel += 1;
        }
        if (dAdd === 0 && dDel === 0) {
          dAdd = cAdd;
          dDel = cDel;
        } else {
          if (dAdd === 0 && cAdd > 0) dAdd = cAdd;
          if (dDel === 0 && cDel > 0) dDel = cDel;
        }
      }
      add += dAdd;
      del += dDel;
    }
    return add === 0 && del === 0 ? null : { add, del };
  }
  const out = tc.output || '';
  if (!out.trim()) return null;
  const gs = parseGitShortstat(out);
  if (gs) return gs;
  const lines = out.split('\n');
  if (looksLikeUnifiedOrPatchText(lines)) {
    for (const rawL of lines) {
      const l = rawL.trimEnd();
      if (isDiffMetaPlusMinusLine(l)) continue;
      if (l.startsWith('+') && !l.startsWith('+++')) add += 1;
      else if (l.startsWith('-') && !l.startsWith('---')) del += 1;
    }
    return add === 0 && del === 0 ? null : { add, del };
  }
  return null;
}
