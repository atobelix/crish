/**
 * 工具调用收口后的后续引导建议（纯函数，不写消息时间线）。
 *
 * 契约（保证流式顺序不被污染）：
 * - 绝不写入 SessionMessage.blocks / text / streamTextOffset / toolCalls
 * - 仅在整轮助手 status=completed 且工具均已终态后由 UI 派生
 * - 渲染位置在时间线 body 之外（完成态 meta 旁），不参与 buildAssistantTimeline
 */

import type { MessageToolCall, SessionMessage } from '../store/layoutStore';
import { isEditToolName, isShellToolName } from './toolFeedback';

export type FollowUpSuggestion = {
  /** 稳定 id，供 React key / 埋点 */
  id: string;
  /** 芯片短标签（≤14 字为宜） */
  label: string;
  /** 填入 composer / 直发的完整正文 */
  prompt: string;
};

const MAX_SUGGESTIONS = 3;

function hasTerminalTool(tc: MessageToolCall): boolean {
  return tc.status === 'success' || tc.status === 'error';
}

function isOpenTool(tc: MessageToolCall): boolean {
  return tc.status === 'running' || tc.status === 'pending_approval';
}

/**
 * 是否应展示引导芯片。
 * 仅最后一条已完成助手消息，且本轮确有工具并全部收口。
 */
export function shouldShowFollowUpSuggestions(opts: {
  isLastAssistant: boolean;
  isThinkingMsg: boolean;
  status?: SessionMessage['status'];
  toolCalls?: readonly MessageToolCall[] | null;
  /** 用户手动关闭后隐藏 */
  dismissed?: boolean;
}): boolean {
  if (opts.dismissed) return false;
  if (!opts.isLastAssistant) return false;
  if (opts.isThinkingMsg) return false;
  if (opts.status === 'processing' || opts.status === 'queued') return false;
  // 未标 completed 的历史消息：有工具终态也允许（兼容旧持久化）
  if (opts.status != null && opts.status !== 'completed') return false;

  const tools = opts.toolCalls || [];
  if (tools.length === 0) return false;
  if (!tools.some(hasTerminalTool)) return false;
  if (tools.some(isOpenTool)) return false;
  return true;
}

function pushUnique(
  out: FollowUpSuggestion[],
  item: FollowUpSuggestion,
): void {
  if (out.length >= MAX_SUGGESTIONS) return;
  if (out.some((x) => x.id === item.id || x.prompt === item.prompt)) return;
  out.push(item);
}

/**
 * 根据已完成助手消息的工具结果派生 2–3 条后续选项。
 * 纯启发式；不依赖模型协议，避免改 streaming 管线。
 */
export function buildFollowUpSuggestions(
  msg: Pick<SessionMessage, 'toolCalls' | 'text' | 'blocks'>,
): FollowUpSuggestion[] {
  const tools = msg.toolCalls || [];
  if (tools.length === 0) return [];

  const out: FollowUpSuggestion[] = [];
  const hasError = tools.some((t) => t.status === 'error');
  const hasEdit = tools.some(
    (t) => t.status === 'success' && isEditToolName(t.name || ''),
  );
  const hasShell = tools.some((t) => isShellToolName(t.name || ''));
  const hasShellError = tools.some(
    (t) => t.status === 'error' && isShellToolName(t.name || ''),
  );
  const hasDiff = tools.some(
    (t) => Array.isArray(t.diffs) && t.diffs.length > 0,
  );
  const inspectish = tools.some((t) => {
    const n = (t.name || '').toLowerCase();
    return (
      n.includes('read') ||
      n.includes('grep') ||
      n.includes('search') ||
      n.includes('list') ||
      n.includes('glob')
    );
  });

  if (hasError || hasShellError) {
    pushUnique(out, {
      id: 'diagnose-error',
      label: '排查失败原因',
      prompt: '请根据刚才失败的工具输出，分析根因并给出可执行的修复步骤',
    });
    pushUnique(out, {
      id: 'retry-safe',
      label: '安全重试',
      prompt: '在不扩大破坏面的前提下，重试刚才失败的操作；先说明你会怎么做',
    });
  }

  if (hasEdit || hasDiff) {
    pushUnique(out, {
      id: 'review-diff',
      label: '审查改动',
      prompt: '请审查刚才的代码改动：风险点、遗漏边界，以及是否需要补测试',
    });
    pushUnique(out, {
      id: 'run-tests',
      label: '跑相关测试',
      prompt: '针对刚才改动的范围运行相关测试或类型检查，并总结结果',
    });
  }

  if (hasShell && !hasShellError) {
    pushUnique(out, {
      id: 'explain-cmd',
      label: '解释命令结果',
      prompt: '用简短中文解释刚才命令的输出含义，以及是否还需要后续操作',
    });
  }

  if (inspectish && !hasEdit) {
    pushUnique(out, {
      id: 'go-deeper',
      label: '继续深入',
      prompt: '基于刚才读到的内容继续深入：标出关键路径与下一步该改哪里',
    });
    pushUnique(out, {
      id: 'summarize-findings',
      label: '总结发现',
      prompt: '把刚才工具查到的要点整理成简短结论（条目化）',
    });
  }

  // 通用兜底：保证至少 2 条（有工具成功推进时）
  if (tools.some((t) => t.status === 'success')) {
    pushUnique(out, {
      id: 'next-step',
      label: '下一步建议',
      prompt: '基于刚才完成的工具操作，给出 2–3 个最合理的下一步，并直接执行最优先的一项',
    });
    pushUnique(out, {
      id: 'what-changed',
      label: '说明做了什么',
      prompt: '用三句话说明刚才调用了哪些工具、改了什么、结果如何',
    });
  }

  // 仍不足时补「继续」
  pushUnique(out, {
    id: 'continue',
    label: '继续',
    prompt: '请继续完成剩余工作',
  });

  return out.slice(0, MAX_SUGGESTIONS);
}
