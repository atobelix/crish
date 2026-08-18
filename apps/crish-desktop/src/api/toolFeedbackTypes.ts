/**
 * toolFeedback 类型契约与分类常量。
 * 从 toolFeedback.ts 拆出，保持消费方 import 路径不变（hub 仍 re-export）。
 */

import type { FileDiff } from '../store/layoutStore';

/** 成功 / 失败 / 部分完成 / 取消 / 进行中 / 待确认 */
export type ToolFeedbackKind =
  | 'success'
  | 'error'
  | 'partial'
  | 'cancelled'
  | 'running'
  | 'pending';

export interface ClassifyToolOutcomeInput {
  name?: string;
  status?: string | null;
  output?: string | null;
  /** 独立 stderr；空白不得把 success 打成 partial/error */
  stderr?: string | null;
  exitCode?: number | null;
  cancelled?: boolean;
  /** 上游已标记截断 */
  truncated?: boolean;
  diffs?: FileDiff[] | null;
  args?: string;
}

export interface ToolFeedback {
  kind: ToolFeedbackKind;
  /** 短中文主文案（行内 / 结构化反馈） */
  message: string;
  /** 清洗后详情（可截断） */
  detail: string;
  truncated: boolean;
  /** 如「+3 −1 · src/a.ts」 */
  diffHint: string | null;
  /**
   * 编辑类且有可发布 diff 时的撤销友好提示。
   * 仅文案结构，不触发 toast；成功无撤销场景应静默。
   */
  undoHint: string | null;
  /**
   * 是否适合 toast。策略：仅 error 为 true；
   * success / partial / cancelled / running / pending 均为 false（不发明成功 toast）。
   */
  toastable: boolean;
}

/** 取消信号正则（用户取消 / 会话中断等文案） */
export const CANCEL_SIGNAL_RE =
  /已取消|用户取消|cancelled by user|canceled by user|user\s*(?:cancel|abort)|aborted by user|interrupted by user|上次会话中断|会话中断/i;

/** 部分完成信号正则（部分成功 / 完成但有警告等文案） */
export const PARTIAL_SIGNAL_RE =
  /部分成功|部分失败|部分完成|完成但有警告|partial(?:ly)?\s+(?:succeeded|failed|complete|done)|completed with warnings?/i;
