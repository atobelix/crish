/**
 * 工具卡片展示与终端指令格式化门面模块。
 */

import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import {
  isEditToolName,
  isShellToolName,
  looksLikeDirectoryListing,
  sanitizeToolDisplayOutput,
} from '../toolFeedback';
import type { ToolRowTone } from './toolPresentationTypes';
import { extractToolCommand } from './toolArgsNormalizer';
import { unwrapPowerShellCommand } from './toolCommandExtractor';
import { toolHumanLabel } from './toolHumanDescriptions';

// 重导出子模块所有能力（保持 100% 向后兼容）
export * from './toolLabelSanitizer';
export * from './toolArgsNormalizer';
export * from './toolCommandExtractor';
export * from './toolHumanDescriptions';
export * from './toolPresentationTypes';
export { isShellToolName } from '../toolFeedback';

const HIDE_TOOL_RE = /上次会话中断|会话中断|interrupted|cancelled by user/i;

/** 仅真正会话中断才隐藏（timelineNormalizer 过滤用） */
export function isInterruptedTool(tc: MessageToolCall): boolean {
  return tc.status === 'error' && HIDE_TOOL_RE.test(tc.output || '');
}

/** 运行中 / 空占位输出（不进预览、不撑开行高） */
export function isPlaceholderToolOutput(
  output: string | undefined | null
): boolean {
  if (!output) return true;
  const t = output.trim();
  return !t || /^(执行中|运行中)…?$/.test(t);
}

/** 纯终态词，无实质内容（完成态行上用勾/叉表达，不占展开体） */
export function isTrivialToolOutput(
  output: string | undefined | null
): boolean {
  if (!output) return true;
  const t = output.trim();
  if (!t || isPlaceholderToolOutput(t)) return true;
  return /^(完成|OK|ok|Done|done|失败|failed|已拒绝|已取消|cancelled|canceled)$/i.test(
    t
  );
}

/** 折叠行预览可截断；展开区请用 fullToolOutput */
export function truncateToolOutput(
  output: string,
  maxLines = 16,
  maxChars = 1600
): string {
  if (!output || isPlaceholderToolOutput(output) || isTrivialToolOutput(output))
    return '';
  let text = sanitizeToolDisplayOutput(output);
  if (!text) return '';
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…（已截断）`;
  const lines = text.split('\n');
  return lines.length > maxLines
    ? `${lines.slice(0, maxLines).join('\n')}\n…（共 ${lines.length} 行）`
    : text;
}

/** 展开区完整正文（仅清洗，不截断） */
export function fullToolOutput(output: string): string {
  return !output ||
    isPlaceholderToolOutput(output) ||
    isTrivialToolOutput(output)
    ? ''
    : sanitizeToolDisplayOutput(output) || '';
}

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
function looksLikeUnifiedOrPatchText(lines: string[]): boolean {
  return lines.some((l) => PATCH_HEAD_RE.test(l));
}

function isDiffMetaPlusMinusLine(line: string): boolean {
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
  }
  if (
    add === 0 &&
    del === 0 &&
    tc.output &&
    !isPlaceholderToolOutput(tc.output)
  ) {
    const text = tc.output
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    if (!looksLikeDirectoryListing(text)) {
      const lines = text.split('\n');
      if (looksLikeUnifiedOrPatchText(lines)) {
        for (const line of lines) {
          if (!line || line.startsWith('\\') || line.startsWith('***'))
            continue;
          if (line.startsWith('+') && !isDiffMetaPlusMinusLine(line)) add += 1;
          else if (line.startsWith('-') && !isDiffMetaPlusMinusLine(line))
            del += 1;
        }
        if (add === 0 && del === 0) {
          for (const line of lines) {
            const m = line.match(
              /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s@@/
            );
            if (!m) continue;
            const oldN = m[2] != null ? Number(m[2]) : 1;
            const newN = m[4] != null ? Number(m[4]) : 1;
            if (Number.isFinite(oldN) && Number.isFinite(newN)) {
              if (newN > oldN) add += newN - oldN;
              else if (oldN > newN) del += oldN - newN;
            }
          }
        }
      }
      if (add === 0 && del === 0) {
        const short = parseGitShortstat(text);
        if (short) {
          add = short.add;
          del = short.del;
        }
      }
    }
  }
  return add === 0 && del === 0 ? null : normalizeToolDiffStat({ add, del });
}

export function normalizeToolDiffStat(stats: { add: number; del: number }): {
  add: number;
  del: number;
} {
  const clamp = (n: unknown): number => {
    const v = typeof n === 'number' ? n : Number(n);
    return !Number.isFinite(v) || v < 0 ? 0 : Math.floor(v);
  };
  return { add: clamp(stats?.add), del: clamp(stats?.del) };
}

export function formatToolDiffStat(stats: {
  add: number;
  del: number;
}): string {
  const { add: a, del: d } = normalizeToolDiffStat(stats);
  return `+${a} −${d}`;
}

export function toolHasDiffStat(tc: MessageToolCall): boolean {
  const s = toolDiffLineStats(tc);
  return Boolean(s && (s.add > 0 || s.del > 0));
}

export function isToolRowDefaultOpen(
  _tc?: MessageToolCall | null | undefined
): boolean {
  return false;
}

export function resolveToolRowOpen(
  expandedTools: Record<string, boolean> | null | undefined,
  toolId: string,
  _tc?: { status?: string; output?: string; diffs?: unknown[] } | null
): boolean {
  return expandedTools != null &&
    Object.prototype.hasOwnProperty.call(expandedTools, toolId)
    ? Boolean(expandedTools[toolId])
    : isToolRowDefaultOpen();
}

export function toolRowTone(
  status: MessageToolCall['status'] | undefined
): ToolRowTone {
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  if (status === 'pending_approval') return 'pending';
  if (status === 'success') return 'success';
  return 'idle';
}

export function toolHasExpandableBody(tc: MessageToolCall): boolean {
  if (tc.status === 'pending_approval') return false;
  if (tc.status === 'running') {
    return Boolean(
      (tc.arguments && tc.arguments.trim().length > 2) ||
      (tc.output && tc.output.trim())
    );
  }
  if (tc.diffs && tc.diffs.length > 0) return true;
  if (extractImageRefs(tc.output || '').length > 0) return true;
  if (tc.arguments && tc.arguments.trim().length > 2) return true;
  const raw = tc.output || '';
  if (isPlaceholderToolOutput(raw) || isTrivialToolOutput(raw)) return false;
  return Boolean(sanitizeToolDisplayOutput(raw).trim());
}

export function isInspectTool(tc: MessageToolCall): boolean {
  if (tc.status === 'pending_approval') return false;
  const n = (tc.name || '').toLowerCase();
  if (isEditToolName(n)) return false;
  if (isShellToolName(n)) {
    const cmd = extractToolCommand(tc.arguments || '').toLowerCase();
    if (
      /^(pwd|ls|dir|cat|type|head|tail|git\s+status|git\s+diff|git\s+log|echo|whoami|hostname)\b/.test(
        cmd
      )
    ) {
      return true;
    }
    return !/\b(rm|del|move|copy|set-content|out-file|write|install|npm\s+i|mkdir)\b/i.test(
      cmd
    );
  }
  return (
    n.includes('read') ||
    n.includes('grep') ||
    n.includes('search') ||
    n.includes('list') ||
    n.includes('glob') ||
    n.includes('stat')
  );
}

export function toolHasDisplayableResult(tc: MessageToolCall): boolean {
  if (tc.status === 'running' || tc.status === 'pending_approval') return false;
  return (
    toolHasExpandableBody(tc) ||
    tc.status === 'success' ||
    tc.status === 'error'
  );
}

export function toolCommandPreview(tc: MessageToolCall, max = 72): string {
  const cmd = extractToolCommand(tc.arguments || '');
  if (!cmd) return '';
  const human = toolHumanLabel(tc);
  let one = cmd.replace(/\s+/g, ' ').trim();
  if (/^(?:powershell|pwsh)\b/i.test(one)) {
    const inner = unwrapPowerShellCommand(one);
    if (inner && inner.length < one.length) one = inner;
  }
  if (human === one || human.includes(one)) return '';
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function toolResultPreview(tc: MessageToolCall, max = 72): string {
  if (tc.status === 'running' || tc.status === 'pending_approval') return '';
  const raw = truncateToolOutput(tc.output || '', 2, max + 20);
  if (!raw) return '';
  const line = raw.split('\n').find((l) => l.trim()) || raw;
  const one = line.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function humanizeAgentSummary(
  raw: string | undefined | null,
  status?: string
): string {
  const fallback =
    status === 'running'
      ? '执行中…'
      : status === 'failed'
        ? '未完成'
        : status === 'stopped'
          ? '已停止'
          : status === 'completed'
            ? '已完成'
            : '暂无摘要';
  if (!raw?.trim()) return fallback;
  let t = raw.replace(/\r\n/g, '\n').trim();
  t = t
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (
        /^mode=\w+/i.test(l) ||
        /turns=\d+.*tools=\d+/i.test(l) ||
        /Tools ran; model did not/i.test(l)
      )
        return false;
      return (
        !/^No final text response/i.test(l) &&
        !/upstream may have errored/i.test(l)
      );
    })
    .join('\n');
  t = t
    .replace(/^(.+?)\s+completed(?:\s*\([^)]*\))?\.?\s*/i, '')
    .replace(/^(.+?)\s+failed:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return !t ? fallback : t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

export function assistantCopyText(msg: SessionMessage): string {
  const raw = (msg.text || '').trim();
  if (raw) return raw;
  return (msg.blocks || [])
    .filter((b) => b.type === 'text' && (b.content || '').trim())
    .map((b) => (b.content || '').trim())
    .join('\n\n');
}

export function extractImageRefs(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g))
    if (m[1]) out.push(m[1]);
  for (const m of text.matchAll(
    /(?:^|[\s"'`])((?:[A-Za-z]:)?[\\/][^\s"'`]+\.(?:png|jpe?g|gif|webp|svg)|(?:\.\/|\/)[^\s"'`]+\.(?:png|jpe?g|gif|webp|svg))/gi
  )) {
    if (m[1]) out.push(m[1]);
  }
  return [...new Set(out)].slice(0, 8);
}
