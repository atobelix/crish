// AgentTeamBoard / agentCardUtils 的展示名兜底链测试（T-D-05 label 优先）。
//
// 断言链：displayLabel → description → mode → id → 中文兜底「子智能体」。
// displayLabel 是自由文本（2-5 字角色标签），仅展示、不影响调度。
import { describe, expect, it } from 'vitest';
import { agentTitle } from './AgentTeamBoard';
import { agentDisplayName } from './agentCardUtils';
import type { SessionAgent } from '../../store/layoutStore';

/** 最小 SessionAgent 工厂（缺省空展示字段，逐项覆盖断言兜底链） */
function makeAgent(overrides: Partial<SessionAgent> = {}): SessionAgent {
  return {
    id: 'a1',
    subagentRunId: 'run-1',
    parentSessionId: 's1',
    parentRunId: 'p1',
    description: '',
    mode: '',
    status: 'running',
    messages: [],
    startedAt: 100,
    ...overrides,
  };
}

describe('agentTitle（T-D-05 displayLabel 优先）', () => {
  it('displayLabel 优先于 description / mode / id', () => {
    expect(
      agentTitle(
        makeAgent({
          description: '调研模块 A',
          mode: 'explore',
          displayLabel: 'Rust 内核分析师',
        }),
      ),
    ).toBe('Rust 内核分析师');
  });

  it('无 displayLabel 时按 description → mode → id 兜底', () => {
    expect(agentTitle(makeAgent({ description: '调研模块 A' }))).toBe(
      '调研模块 A',
    );
    expect(agentTitle(makeAgent({ mode: 'explore' }))).toBe('explore');
    expect(agentTitle(makeAgent({}))).toBe('a1');
  });

  it('空白 displayLabel 视为缺省（trim 后跳过）', () => {
    expect(agentTitle(makeAgent({ displayLabel: '   ', description: '任务' }))).toBe(
      '任务',
    );
  });

  it('全空回退中文兜底「子智能体」', () => {
    expect(agentTitle(makeAgent({ id: '   ' }))).toBe('子智能体');
  });
});

describe('agentDisplayName（与 agentTitle 同链，label 优先）', () => {
  it('displayLabel 优先于 description', () => {
    expect(
      agentDisplayName(
        makeAgent({ description: '任务描述', displayLabel: '实现工程师' }),
      ),
    ).toBe('实现工程师');
  });

  it('无 displayLabel 回退 description → mode → id', () => {
    expect(agentDisplayName(makeAgent({ description: '任务描述' }))).toBe(
      '任务描述',
    );
    expect(agentDisplayName(makeAgent({ mode: 'solve' }))).toBe('solve');
    expect(agentDisplayName(makeAgent({}))).toBe('a1');
  });
});
