/**
 * toolFeedback 输出清洗 / 结果分类 / 反馈组装辅助。
 * 从 toolFeedbackLogic.ts 拆出，保持消费方 import 路径不变（hub 仍 re-export）。
 * Diff 解析域与 sanitizeToolDisplayOutput 见 ./toolFeedbackDiff（单向依赖：diff → 无，logic → diff）。
 */

import type { FileDiff } from '../store/layoutStore';
import {
  CANCEL_SIGNAL_RE,
  PARTIAL_SIGNAL_RE,
  type ClassifyToolOutcomeInput,
  type ToolFeedbackKind,
} from './toolFeedbackTypes';
import {
  filterPublishableFileDiffs,
  isEditToolName,
  isShellToolName,
  sanitizeToolDisplayOutput,
} from './toolFeedbackDiff';

// 重新导出 sanitizeToolDisplayOutput，保持 toolFeedbackLogic 作为消费方的兼容入口
export { sanitizeToolDisplayOutput } from './toolFeedbackDiff';

/** 空白 / 仅换行的流视为空（空 stderr 不改分类） */
export function isEmptyToolStream(text: string | null | undefined): boolean {
  return !text || !String(text).trim();
}

/** 输出或标志是否表示用户取消 / 会话中断 */
export function isCancelledToolSignal(
  input: Pick<ClassifyToolOutcomeInput, 'cancelled' | 'output' | 'stderr' | 'status'>,
): boolean {
  if (input.cancelled === true) return true;
  const blob = `${input.output || ''}\n${input.stderr || ''}`;
  if (CANCEL_SIGNAL_RE.test(blob)) return true;
  const st = (input.status || '').toLowerCase();
  if (st === 'cancelled' || st === 'canceled' || st === 'aborted') return true;
  return false;
}

/**
 * 从原始工具输出解析 Exit code（sanitize 会剥掉该行，须在清洗前调用）。
 */
export function parseExitCodeFromToolOutput(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = String(raw).match(/^\s*Exit code:\s*(-?\d+)\s*$/im);
  if (!m) {
    const loose = String(raw).match(/\bExit code:\s*(-?\d+)\b/i);
    if (!loose) return null;
    const n = Number(loose[1]);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** 按 Unicode 码点截断，避免切断代理对 / 中文 */
export function safeTruncateChars(text: string, maxChars: number): string {
  if (!text || maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, maxChars).join('');
}

function resolveExitCode(input: ClassifyToolOutcomeInput): number | null {
  if (input.exitCode != null && Number.isFinite(Number(input.exitCode))) {
    return Number(input.exitCode);
  }
  return parseExitCodeFromToolOutput(input.output);
}

function hasPartialSignal(input: ClassifyToolOutcomeInput): boolean {
  if (input.truncated) return true;
  if (!isEmptyToolStream(input.stderr)) return true;
  const blob = `${input.output || ''}\n${input.stderr || ''}`;
  if (PARTIAL_SIGNAL_RE.test(blob)) return true;
  // 展示层截断标记
  if (/…（(?:已截断|共 \d+ 行)/.test(blob) || /\btruncated\b/i.test(blob)) return true;
  return false;
}

/**
 * 分类工具结果。
 * 优先级：cancelled → running/pending → 非零 exit → status error → partial → success。
 * 空 stderr 不得把 success 打成 partial。
 */
export function classifyToolOutcome(input: ClassifyToolOutcomeInput): ToolFeedbackKind {
  if (isCancelledToolSignal(input)) return 'cancelled';

  const st = (input.status || '').toLowerCase().trim();
  if (st === 'running' || st === 'in_progress' || st === 'in-progress') return 'running';
  if (st === 'pending_approval' || st === 'pending' || st === 'awaiting_approval') {
    return 'pending';
  }

  const exit = resolveExitCode(input);
  if (exit != null && exit !== 0) return 'error';

  if (st === 'error' || st === 'failed' || st === 'failure') return 'error';

  // 成功态但有警告 stderr / 截断 / 部分完成文案
  if (hasPartialSignal(input)) {
    // 明确失败 status 已在上面处理；此处覆盖 success 或缺 status
    if (!st || st === 'success' || st === 'ok' || st === 'completed' || st === 'done') {
      return 'partial';
    }
  }

  if (st === 'success' || st === 'ok' || st === 'completed' || st === 'done') return 'success';
  if (exit === 0) return 'success';

  // 无 status：有输出按成功（调用方未标失败）；全空也归 success 占位由 message 表达
  if (!st) return 'success';
  return 'success';
}

/**
 * 大输出截断（中文省略号、行数/字符双重上限）。
 * 供结构化反馈 detail 使用；不抛异常。
 */
export function truncateToolFeedbackOutput(
  raw: string | null | undefined,
  opts?: { maxChars?: number; maxLines?: number },
): { text: string; truncated: boolean } {
  const maxChars = opts?.maxChars ?? 2000;
  const maxLines = opts?.maxLines ?? 40;
  if (!raw) return { text: '', truncated: false };
  let text = sanitizeToolDisplayOutput(raw);
  if (!text) return { text: '', truncated: false };

  let truncated = false;
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    text = `${lines.slice(0, maxLines).join('\n')}\n…（共 ${lines.length} 行，已截断）`;
    truncated = true;
  }
  const charCount = Array.from(text).length;
  if (charCount > maxChars) {
    text = `${safeTruncateChars(text, Math.max(1, maxChars - 1))}…（已截断）`;
    truncated = true;
  }
  return { text, truncated };
}

function basenamePath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

/** 可发布 diff 的 ± 摘要；无可发布项返回 null */
export function buildToolDiffHint(files: FileDiff[] | null | undefined): string | null {
  const list = filterPublishableFileDiffs(files);
  if (!list.length) return null;
  let add = 0;
  let del = 0;
  for (const f of list) {
    add += f.additions || 0;
    del += f.deletions || 0;
  }
  const parts: string[] = [];
  if (add > 0) parts.push(`+${add}`);
  if (del > 0) parts.push(`−${del}`);
  const stat = parts.length ? parts.join(' ') : '有变更';
  if (list.length === 1) {
    return `${stat} · ${basenamePath(list![0]!.filePath)}`;
  }
  return `${stat} · ${list.length} 个文件`;
}

/**
 * 撤销友好提示：仅编辑类 + 可发布 diff + success/partial。
 * 不表示已 toast；shell 仅 diff 预览不给 undo。
 */
export function buildToolUndoHint(opts: {
  kind: ToolFeedbackKind;
  name?: string;
  diffs?: FileDiff[] | null;
}): string | null {
  if (opts.kind !== 'success' && opts.kind !== 'partial') return null;
  const list = filterPublishableFileDiffs(opts.diffs);
  if (!list.length) return null;
  const name = opts.name || '';
  // shell 输出 git diff 不代表本端已写入，不可暗示撤销
  if (name && isShellToolName(name) && !isEditToolName(name)) return null;
  if (name && !isEditToolName(name) && !isShellToolName(name)) {
    // 非编辑工具但有引擎结构化 diffs：仍给查看提示
    return '可在变更面板查看详情。';
  }
  if (!name || isEditToolName(name)) {
    return '可在变更面板查看；不需要时可用撤销还原。';
  }
  return null;
}

/** 短中文主文案（不夹带 stack / 不发明「成功」营销语） */
export function formatToolFeedbackMessage(
  kind: ToolFeedbackKind,
  input: ClassifyToolOutcomeInput = {},
): string {
  switch (kind) {
    case 'running':
      return '执行中…';
    case 'pending':
      return '待确认';
    case 'cancelled':
      return '已取消';
    case 'success': {
      const name = input.name || '';
      if (name && isEditToolName(name) && !isShellToolName(name)) {
        const n = filterPublishableFileDiffs(input.diffs).length;
        return n > 0 ? '文件已更新' : '完成';
      }
      if (name && isShellToolName(name)) return '命令已完成';
      return '完成';
    }
    case 'partial': {
      if (input.truncated || /…（(?:已截断|共 \d+ 行)/.test(input.output || '')) {
        return '结果已截断（部分输出）';
      }
      if (!isEmptyToolStream(input.stderr)) return '完成，但有警告输出';
      return '部分完成';
    }
    case 'error': {
      const clean = sanitizeToolDisplayOutput(input.output || input.stderr || '').trim();
      if (clean) {
        const first = (clean.split('\n').find((l) => l.trim()) || clean).trim();
        const sliced = safeTruncateChars(first, 80);
        return sliced.length < Array.from(first).length ? `${sliced}…` : sliced;
      }
      const exit = resolveExitCode(input);
      if (exit != null && exit !== 0) return `执行失败（退出码 ${exit}）`;
      return '执行失败';
    }
    default:
      return '完成';
  }
}
