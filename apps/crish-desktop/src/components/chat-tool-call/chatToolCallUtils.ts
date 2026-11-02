import type { MessageToolCall, SessionAgent } from '../../store/types';

/** 工具行状态中文标签（aria / 行尾 / data 共用，避免英文 status 直出） */
export function toolStatusZh(
  status: MessageToolCall['status'] | undefined
): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'success':
      return '完成';
    case 'error':
      return '失败';
    case 'pending_approval':
      return '待确认';
    default:
      return '待命';
  }
}

/** 空输出占位（与 Runtime/后台任务文案一致） */
export const TOOL_EMPTY_OUTPUT_ZH = '（无输出）';

/** 展开区 id，供 aria-controls 关联 */
export function toolResultBodyId(toolId: string): string {
  return `tool-result-${toolId}`;
}

export function findAgentForTool(
  tc: { id?: string; name?: string; explanation?: string },
  agents?: SessionAgent[]
): SessionAgent | null {
  if (!agents || !agents.length) return null;
  const byTool = agents.find(
    (a) => a.parentToolCallId && a.parentToolCallId === tc.id
  );
  if (byTool) return byTool;
  const n = (tc.name || '').toLowerCase();
  if (n.includes('subagent') || n === 'run_subagent') {
    const exp = (tc.explanation || '').trim();
    const byDesc = exp
      ? agents.find(
          (a) => a.description && exp.includes(a.description.slice(0, 24))
        )
      : null;
    if (byDesc) return byDesc;
    // R4a：删除原 agents[0] 兜底——匹配不到时降级为普通工具行呈现，
    // 不把徽章挂到无关的第一个 agent 上（挂错比不挂更误导）
    return null;
  }
  return null;
}
