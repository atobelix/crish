/**
 * R4b/R7：待审批计数口径——只计 arbiter !== 'main-agent' 的待批
 * （主 agent 自行裁决的不进用户待办）。注：子 agent 路径暂未写 approvalMeta，
 * 字段缺省按「计入」处理，与 R7 定版规则一致。
 */
import { describe, expect, it } from 'vitest';
import { countPendingApprovals } from './agentCardUtils';
import type { SessionAgent, SessionMessage } from '../../store/types';

function agentWithTools(
  tools: Array<{
    status: string;
    arbiter?: 'main-agent' | 'user';
  }>
): SessionAgent {
  const messages = [
    {
      id: 'm1',
      role: 'assistant',
      toolCalls: tools.map((t, i) => ({
        id: `tc-${i}`,
        name: 'read_file',
        status: t.status,
        ...(t.arbiter !== undefined
          ? { approvalMeta: { arbiter: t.arbiter } }
          : {}),
      })),
    },
  ] as unknown as SessionMessage[];
  return { id: 'ag-1', messages } as SessionAgent;
}

describe('countPendingApprovals（R7 arbiter 口径）', () => {
  it('无 approvalMeta 的待批计入（字段缺省）', () => {
    expect(
      countPendingApprovals(agentWithTools([{ status: 'pending_approval' }]))
    ).toBe(1);
  });

  it('arbiter=user 的待批计入', () => {
    expect(
      countPendingApprovals(
        agentWithTools([{ status: 'pending_approval', arbiter: 'user' }])
      )
    ).toBe(1);
  });

  it('arbiter=main-agent 的待批不计入用户待办', () => {
    expect(
      countPendingApprovals(
        agentWithTools([{ status: 'pending_approval', arbiter: 'main-agent' }])
      )
    ).toBe(0);
  });

  it('混合：仅 user/缺省计入；非 pending 状态一律不计', () => {
    expect(
      countPendingApprovals(
        agentWithTools([
          { status: 'pending_approval', arbiter: 'main-agent' },
          { status: 'pending_approval', arbiter: 'user' },
          { status: 'pending_approval' },
          { status: 'success', arbiter: 'user' },
          { status: 'running' },
        ])
      )
    ).toBe(2);
  });

  it('无消息/无工具 → 0', () => {
    expect(
      countPendingApprovals({ id: 'x', messages: [] } as SessionAgent)
    ).toBe(0);
    expect(countPendingApprovals(agentWithTools([]))).toBe(0);
  });
});
