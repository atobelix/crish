import type { SessionState as Session, SessionGoalTask } from '../store/layoutStore';
import { toolHumanLabel } from './toolPresentation';

export interface ProgressSummary {
  done: number;
  total: number;
  pct: number;
  open: number;
  allDone: boolean;
}

export interface LiveToolInfo {
  label: string;
  statusLabel: string;
  isApproval: boolean;
}

/** 匹配行级 `- [ ]` / `- [x]` / `* [ ]` 清算 */
const CHECKLIST_REGEX = /^\s*[-*]\s*\[([ xX])\]\s+(.+)$/;

/**
 * 从文本中提取 Markdown checklist 任务项
 */
export function parseMarkdownChecklist(text: string): SessionGoalTask[] {
  if (!text || !text.includes('[')) return [];
  const lines = text.split(/\r?\n/);
  const tasks: SessionGoalTask[] = [];
  let idx = 0;
  for (const line of lines) {
    const m = CHECKLIST_REGEX.exec(line);
    if (m) {
      const isDone = m[1].toLowerCase() === 'x';
      const taskText = m[2].trim();
      if (taskText) {
        idx += 1;
        tasks.push({
          id: `chk-${idx}`,
          text: taskText,
          done: isDone,
        });
      }
    }
  }
  return tasks;
}

/**
 * 确定当前会话的有效进度清单项：
 * goalMode.tasks 优先，否则使用最近一条包含 checklist 的助手消息
 */
export function resolveSessionProgressItems(session: Session | null | undefined): SessionGoalTask[] {
  if (!session) return [];
  if (session.goalMode?.active && (session.goalMode.tasks?.length ?? 0) > 0) {
    return session.goalMode.tasks || [];
  }
  if (!session.messages?.length) return [];
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.sender === 'assistant' && msg.text) {
      const items = parseMarkdownChecklist(msg.text);
      if (items.length > 0) {
        return items;
      }
    }
  }
  return [];
}

/**
 * 计算进度分布与完成百分比
 */
export function computeChecklistProgress(items: SessionGoalTask[] | null | undefined): ProgressSummary {
  if (!items || items.length === 0) {
    return { done: 0, total: 0, pct: 0, open: 0, allDone: false };
  }
  const total = items.length;
  const done = items.filter((x) => x.done).length;
  const open = total - done;
  const pct = Math.round((done / total) * 100);
  const allDone = done === total && total > 0;
  return { done, total, pct, open, allDone };
}

/**
 * 查找最新的活动工具状态（用于步骤感知）
 */
export function findCurrentLiveTool(session: Session | null | undefined): LiveToolInfo | null {
  if (!session?.messages?.length) return null;
  const lastMsg = session.messages[session.messages.length - 1];
  if (!lastMsg || lastMsg.sender !== 'assistant' || !lastMsg.toolCalls?.length) return null;

  for (let i = lastMsg.toolCalls.length - 1; i >= 0; i--) {
    const tc = lastMsg.toolCalls[i];
    if (tc.status === 'running' || tc.status === 'pending_approval') {
      const label = toolHumanLabel(tc);
      const isApproval = tc.status === 'pending_approval';
      const statusLabel = isApproval ? '待审批' : '执行中';
      return { label, statusLabel, isApproval };
    }
  }
  return null;
}
