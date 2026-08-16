/**
 * 工具卡片展示与终端指令格式化门面模块。
 */

import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import {
  isEditToolName,
  isShellToolName,
  sanitizeToolDisplayOutput,
} from '../toolFeedback';
import type { ToolRowTone } from './toolPresentationTypes';
import { extractToolCommand } from './toolArgsNormalizer';
import { unwrapPowerShellCommand } from './toolCommandExtractor';
import { toolHumanLabel } from './toolHumanDescriptions';
import {
  isPlaceholderToolOutput,
  isTrivialToolOutput,
  truncateToolOutput,
} from './toolOutputSanitizer';
import { toolDiffLineStats } from './toolDiffStats';

// 重导出子模块所有能力（保持 100% 向后兼容，严格单文件 ≤ 250 行）
export * from './toolLabelSanitizer';
export * from './toolArgsNormalizer';
export * from './toolCommandExtractor';
export * from './toolHumanDescriptions';
export * from './toolPresentationTypes';
export * from './toolOutputSanitizer';
export * from './toolDiffStats';
export { isShellToolName } from '../toolFeedback';

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
