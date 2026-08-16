/**
 * 工具输出清洗与截断辅助函数。
 */

import type { MessageToolCall } from '../../store/layoutStore';
import { sanitizeToolDisplayOutput } from '../toolFeedback';

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
