import type { MessageToolCall, SessionAgent } from '../../store/types';

/**
 * 【R8 状态词表单一来源】工具与子 agent 共用一套状态词：
 * 运行中 / 已完成 / 失败 / 已停止 / 待确认。
 * BG5 增补一条工具专属词：已转后台运行（子 agent 不适用）。
 *
 * 全部呈现面（工具行 / 组头 / 容器头 / 审批 / 分派卡 / 侧栏）只许从
 * 本表取词，禁止再自造同义词（「已就绪」「工作中」「进行中」已下线）。
 * 分工：本表管组头 / 容器头 / 审批 / 状态位；行内行头的动词时态归
 * toolHeaderPresentation（时态管行内）；耗时是独立维度、另行拼装，
 * 永不混入状态词。
 */
export const STATUS_WORD = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  pending: '待确认',
  backgrounded: '已转后台运行',
} as const;

/** 工具行状态中文标签（aria / 行尾 / data 共用，避免英文 status 直出） */
export function toolStatusZh(
  status: MessageToolCall['status'] | undefined
): string {
  switch (status) {
    case 'running':
      return STATUS_WORD.running;
    case 'success':
      return STATUS_WORD.completed;
    case 'error':
      return STATUS_WORD.failed;
    case 'pending_approval':
      return STATUS_WORD.pending;
    default:
      // 未知状态兜底（非词表成员，仅防英文 status 直出）
      return '待命';
  }
}

/**
 * 子 agent 状态中文标签（与工具共用同一词表）。
 * 未知 / 缺省状态返回空串，由调用方按自身语境兜底，不在此臆造词。
 */
export function agentStatusZh(status: string | null | undefined): string {
  switch (status) {
    case 'running':
      return STATUS_WORD.running;
    case 'completed':
      return STATUS_WORD.completed;
    case 'failed':
      return STATUS_WORD.failed;
    case 'stopped':
      return STATUS_WORD.stopped;
    default:
      return '';
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
