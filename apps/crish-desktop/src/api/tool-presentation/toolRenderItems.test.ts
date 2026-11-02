/**
 * R4b 分派提取（投影层）：子 agent 分派调用永不成组、恒为独立 single 项，
 * 使组合根（MessageToolCallsSection）能把它们提取为独立分派卡。
 */
import { describe, expect, it } from 'vitest';
import { buildToolRenderItems } from './toolRenderItems';
import type { MessageToolCall } from '../../store/types';

function tc(
  id: string,
  name: string,
  extra: Partial<MessageToolCall> = {}
): MessageToolCall {
  return {
    id,
    name,
    status: 'success',
    arguments: '{}',
    ...extra,
  } as MessageToolCall;
}

describe('buildToolRenderItems · 分派提取（R4b）', () => {
  it('连续并行分派保持为各自独立的 single（不汇总成组）', () => {
    const items = buildToolRenderItems([
      tc('t1', 'invoke_subagent'),
      tc('t2', 'run_subagent'),
      tc('t3', 'invoke_subagent'),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['single', 'single', 'single']);
    expect(items.map((i) => (i.kind === 'single' ? i.tc.id : null))).toEqual([
      't1',
      't2',
      't3',
    ]);
  });

  it('分派夹在可分组的工具之间时，分派独立且两侧分别成组', () => {
    // 成组条件（canJoinToolGroup）：同轮并行 turnId 相同且 startedAt ≤200ms
    const items = buildToolRenderItems([
      tc('r1', 'run_command', { turnId: 'turn-1', startedAt: 1_000 }),
      tc('r2', 'run_command', { turnId: 'turn-1', startedAt: 1_080 }),
      tc('s1', 'invoke_subagent'),
      tc('r3', 'run_command', { turnId: 'turn-2', startedAt: 2_000 }),
      tc('r4', 'run_command', { turnId: 'turn-2', startedAt: 2_090 }),
    ]);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(['group', 'single', 'group']);
    const single = items[1];
    expect(single?.kind).toBe('single');
    if (single?.kind === 'single') expect(single.tc.id).toBe('s1');
  });

  it('单个分派 + 单个普通工具：两者皆 single，顺序保真', () => {
    const items = buildToolRenderItems([
      tc('s1', 'invoke_subagent'),
      tc('x1', 'run_command'),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['single', 'single']);
  });

  it('普通工具的既有分组行为不变（无分派时，同轮并行仍成组）', () => {
    const items = buildToolRenderItems([
      tc('r1', 'run_command', { turnId: 'turn-1', startedAt: 1_000 }),
      tc('r2', 'run_command', { turnId: 'turn-1', startedAt: 1_050 }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('group');
  });
});
