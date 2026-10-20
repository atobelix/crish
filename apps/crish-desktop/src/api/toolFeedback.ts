/**
 * 将工具输出解析为 Diff / 终端可用的结构化反馈（正式版）。
 *
 * 本文件为 hub：类型契约见 ./toolFeedbackTypes，纯函数逻辑见 ./toolFeedbackLogic。
 * 此处保留顶层装配 buildToolFeedback 与全量 re-export，消费方 import 路径不变。
 */

import type { FileDiff } from '../store/layoutStore';
import type {
  ClassifyToolOutcomeInput,
  ToolFeedback,
} from './toolFeedbackTypes';
import {
  buildToolDiffHint,
  buildToolUndoHint,
  classifyToolOutcome,
  formatToolFeedbackMessage,
  isCancelledToolSignal,
  isEmptyToolStream,
  truncateToolFeedbackOutput,
} from './toolFeedbackLogic';

// ─── re-export：保持消费方 import 路径不变 ────────────────────────────────
export type {
  ToolFeedbackKind,
  ClassifyToolOutcomeInput,
  ToolFeedback,
} from './toolFeedbackTypes';
export { CANCEL_SIGNAL_RE, PARTIAL_SIGNAL_RE } from './toolFeedbackTypes';
// diff 解析域（工具名识别 / 目录列表拦截 / unified diff / 编辑参数合成 / resolveToolDiffs / 输出清洗）
export {
  isShellToolName,
  looksLikeDirectoryListing,
  isEditToolName,
  parseUnifiedDiffs,
  pathFromToolArgs,
  fileDiffFromEditArgs,
  filterPublishableFileDiffs,
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from './toolFeedbackDiff';
// 分类 / 截断 / 反馈组装辅助
export {
  isEmptyToolStream,
  isCancelledToolSignal,
  parseExitCodeFromToolOutput,
  safeTruncateChars,
  classifyToolOutcome,
  truncateToolFeedbackOutput,
  buildToolDiffHint,
  buildToolUndoHint,
  formatToolFeedbackMessage,
} from './toolFeedbackLogic';

/**
 * 组装结构化工具反馈。
 * toastable 仅 error 为 true——调用方不得据此弹成功 toast。
 */
export function buildToolFeedback(
  input: ClassifyToolOutcomeInput & {
    maxDetailChars?: number;
    maxDetailLines?: number;
  }
): ToolFeedback {
  const kind = classifyToolOutcome(input);
  // detail 优先 stdout；stderr 非空时附在后（空 stderr 不拼接）
  let rawDetail = input.output || '';
  if (!isEmptyToolStream(input.stderr)) {
    rawDetail = rawDetail
      ? `${rawDetail}\n${String(input.stderr).trim()}`
      : String(input.stderr).trim();
  }
  const { text, truncated: detailTrunc } = truncateToolFeedbackOutput(
    rawDetail,
    {
      ...(input.maxDetailChars !== undefined && {
        maxChars: input.maxDetailChars,
      }),
      ...(input.maxDetailLines !== undefined && {
        maxLines: input.maxDetailLines,
      }),
    }
  );
  const truncated = Boolean(input.truncated) || detailTrunc;
  // 若仅因 detail 截断且原 kind 为 success，与 classify 的 truncated 标志对齐
  const effectiveKind =
    kind === 'success' && truncated && !isCancelledToolSignal(input)
      ? 'partial'
      : kind;

  const diffs = input.diffs;
  const diffHint = buildToolDiffHint(diffs);
  const undoHint = buildToolUndoHint({
    kind: effectiveKind,
    ...(input.name !== undefined && { name: input.name }),
    ...(diffs !== undefined && { diffs }),
  });
  const message = formatToolFeedbackMessage(effectiveKind, {
    ...input,
    ...(truncated !== undefined && { truncated: truncated || input.truncated }),
  });

  return {
    kind: effectiveKind,
    message,
    detail: text,
    truncated,
    diffHint,
    undoHint,
    toastable: effectiveKind === 'error',
  };
}

// 防止未使用类型导入在严格模式下报错（FileDiff 被 ToolFeedback 间接引用）
export type { FileDiff };
