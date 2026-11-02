import { describe, expect, it } from 'vitest';
import { findAgentForTool } from './chatToolCallUtils';
import type { SessionAgent } from '../../store/types';

function makeAgent(overrides: Partial<SessionAgent> = {}): SessionAgent {
  return {
    id: 'sa-1',
    subagentRunId: 'sr-1',
    parentSessionId: 'sess-1',
    parentRunId: 'run-1',
    description: '调研代码结构',
    mode: 'research',
    status: 'running',
    messages: [],
    startedAt: 0,
    ...overrides,
  };
}

describe('findAgentForTool（R4a：删除 agents[0] 兜底）', () => {
  it('parentToolCallId 精确命中 → 返回该 agent', () => {
    const target = makeAgent({ id: 'sa-2', parentToolCallId: 'tc-9' });
    const agents = [makeAgent({ id: 'sa-1' }), target];
    expect(findAgentForTool({ id: 'tc-9', name: 'read' }, agents)).toBe(target);
  });

  it('subagent 工具 + explanation 含 description 前缀 → 按描述命中', () => {
    const target = makeAgent({ id: 'sa-2' });
    const agents = [
      makeAgent({ id: 'sa-1', description: '无关任务描述' }),
      target,
    ];
    const found = findAgentForTool(
      {
        id: 'tc-x',
        name: 'run_subagent',
        explanation: '分派子任务：调研代码结构并汇总',
      },
      agents
    );
    expect(found).toBe(target);
  });

  it('回归：subagent 工具但无任何匹配 → 返回 null，不再兜底 agents[0]', () => {
    const agents = [makeAgent({ id: 'sa-1' }), makeAgent({ id: 'sa-2' })];
    const found = findAgentForTool(
      {
        id: 'tc-x',
        name: 'run_subagent',
        explanation: '做一件与现有 agent 描述都对不上的事',
      },
      agents
    );
    expect(found).toBeNull();
  });

  it('非 subagent 工具且无 parentToolCallId 命中 → null', () => {
    const agents = [makeAgent({ id: 'sa-1', parentToolCallId: 'tc-other' })];
    expect(
      findAgentForTool({ id: 'tc-1', name: 'read_file' }, agents)
    ).toBeNull();
  });

  it('agents 缺失/为空 → null', () => {
    expect(
      findAgentForTool({ id: 'tc-1', name: 'run_subagent' }, undefined)
    ).toBeNull();
    expect(
      findAgentForTool({ id: 'tc-1', name: 'run_subagent' }, [])
    ).toBeNull();
  });
});
