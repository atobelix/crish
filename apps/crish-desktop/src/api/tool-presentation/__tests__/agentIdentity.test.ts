/**
 * P5 T-P5-10 · agentIdentity / resolveAgentIdentity 子智能体身份色环与 WCAG 对比度测试套件。
 */

import { describe, expect, it } from 'vitest';
import { ICON_NAMES } from '../../../components/ui/icons/iconNames';
import { wcagContrast } from '../../../dev/colorUtils';
import {
  AGENT_GLYPHS,
  AGENT_HUE_PALETTE,
  agentIdentity,
  resolveAgentIdentities,
  resolveAgentIdentity,
} from '../agentIdentity';

describe('agentIdentity 子智能体确定性色彩身份契约', () => {
  const EXPECTED_HUE_TOKENS = [
    '--agent-hue-1',
    '--agent-hue-2',
    '--agent-hue-3',
    '--agent-hue-4',
    '--agent-hue-5',
    '--agent-hue-6',
    '--agent-hue-7',
    '--agent-hue-8',
  ] as const;

  it('8 档色环 Token 字面量具备强类型契约绑定', () => {
    EXPECTED_HUE_TOKENS.forEach((token, idx) => {
      expect(AGENT_HUE_PALETTE[idx].tokenName).toBe(token);
      expect(AGENT_HUE_PALETTE[idx].hueVar).toBe('var(' + token + ')');
    });
  });

  it('同一 Agent ID 映射色相与几何标识绝对幂等', () => {
    const first = resolveAgentIdentity('task-99');
    expect(first.hueIndex).toBeGreaterThanOrEqual(1);
    expect(first.hueIndex).toBeLessThanOrEqual(8);
    expect(first.hueVar).toBe(`var(${first.tokenName})`);
    expect(first.tokenName).toBe(`--agent-hue-${first.hueIndex}`);
    expect(AGENT_GLYPHS).toContain(first.glyph);
    expect(ICON_NAMES).toContain(first.iconName);

    for (let i = 0; i < 50; i++) {
      expect(agentIdentity('task-99')).toEqual(first);
      expect(resolveAgentIdentity('task-99')).toEqual(first);
    }
  });

  it('8 种色相在亮/暗基底均通过 WCAG AA 对比度下限 (>= 4.5:1)', () => {
    expect(AGENT_HUE_PALETTE).toHaveLength(8);

    for (const spec of AGENT_HUE_PALETTE) {
      const darkContrast = wcagContrast(spec.darkHex, '#141414');
      const lightContrast = wcagContrast(spec.lightHex, '#ffffff');

      expect(
        darkContrast,
        `${spec.tokenName} (${spec.name}) dark contrast vs #141414`
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        lightContrast,
        `${spec.tokenName} (${spec.name}) light contrast vs #ffffff`
      ).toBeGreaterThanOrEqual(4.5);
      expect(ICON_NAMES).toContain(spec.iconName);
    }
  });

  it('空串、空白串与异常输入安全退化至合法 1..8 色槽', () => {
    const emptyRes = resolveAgentIdentity('');
    const spaceRes = resolveAgentIdentity('   ');
    const nullRes = resolveAgentIdentity(null);
    const undefRes = resolveAgentIdentity(undefined);

    expect(emptyRes.hueIndex).toBeGreaterThanOrEqual(1);
    expect(emptyRes.hueIndex).toBeLessThanOrEqual(8);
    expect(emptyRes).toEqual(spaceRes);
    expect(emptyRes).toEqual(nullRes);
    expect(emptyRes).toEqual(undefRes);
  });

  it('不同子任务 ID 均匀散列覆盖 1..8 全部色环槽位', () => {
    const hitSlots = new Set<number>();
    for (let i = 1; i <= 64; i++) {
      const id = resolveAgentIdentity(`subagent-worker-${i}`);
      expect(id.hueIndex).toBeGreaterThanOrEqual(1);
      expect(id.hueIndex).toBeLessThanOrEqual(8);
      hitSlots.add(id.hueIndex);
    }
    expect(hitSlots.size).toBe(8);
  });
});

describe('resolveAgentIdentities 会话级撞色顺延（R4a）', () => {
  /** 构造两个哈希同槽的 id（哈希确定性，结果稳定） */
  function collidingPair(): [string, string] {
    const bySlot = new Map<number, string>();
    for (let i = 0; i < 64; i++) {
      const id = `collision-agent-${i}`;
      const slot = agentIdentity(id).hueIndex;
      const prev = bySlot.get(slot);
      if (prev) return [prev, id];
      bySlot.set(slot, id);
    }
    throw new Error('no collision found in 64 ids');
  }

  it('单 agent 时与 agentIdentity 完全一致', () => {
    const m = resolveAgentIdentities([{ id: 'task-99' }]);
    expect(m.size).toBe(1);
    expect(m.get('task-99')).toEqual(agentIdentity('task-99'));
  });

  it('无撞色时全体与逐个 agentIdentity 一致', () => {
    const ids = ['alpha-1', 'beta-2', 'gamma-3'];
    const slots = new Set(ids.map((id) => agentIdentity(id).hueIndex));
    // 若样本自带撞色则本用例前提不成立——哈希确定性下该集合固定
    const m = resolveAgentIdentities(ids.map((id) => ({ id })));
    for (const id of ids) {
      if (slots.size === ids.length) {
        expect(m.get(id)).toEqual(agentIdentity(id));
      } else {
        expect(m.get(id)!.hueIndex).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('撞色时后到者顺延到下一个空槽，glyph/iconName 随槽位', () => {
    const [first, second] = collidingPair();
    const baseSlot = agentIdentity(first).hueIndex;
    expect(agentIdentity(second).hueIndex).toBe(baseSlot);
    const m = resolveAgentIdentities([{ id: first }, { id: second }]);
    expect(m.get(first)).toEqual(agentIdentity(first));
    const shifted = m.get(second)!;
    const expectedSlot = (baseSlot % 8) + 1;
    expect(shifted.hueIndex).toBe(expectedSlot);
    expect(shifted.glyph).toBe(AGENT_HUE_PALETTE[expectedSlot - 1]!.glyph);
    expect(shifted.iconName).toBe(
      AGENT_HUE_PALETTE[expectedSlot - 1]!.iconName
    );
    expect(shifted.tokenName).toBe(`--agent-hue-${expectedSlot}`);
  });

  it('顺序决定占槽：交换顺序则先到者保留哈希槽（确定性）', () => {
    const [a, b] = collidingPair();
    const m1 = resolveAgentIdentities([{ id: a }, { id: b }]);
    const m2 = resolveAgentIdentities([{ id: b }, { id: a }]);
    expect(m1.get(a)!.hueIndex).toBe(agentIdentity(a).hueIndex);
    expect(m2.get(b)!.hueIndex).toBe(agentIdentity(b).hueIndex);
    expect(m1.get(b)!.hueIndex).not.toBe(m2.get(b)!.hueIndex);
    // 同输入重复调用结果一致
    expect(resolveAgentIdentities([{ id: a }, { id: b }])).toEqual(m1);
  });

  it('空白 id 跳过、重复 id 只占一次、空列表返回空 Map', () => {
    expect(resolveAgentIdentities([]).size).toBe(0);
    const m = resolveAgentIdentities([
      { id: '' },
      { id: '   ' },
      { id: null },
      {},
      { id: 'dup-1' },
      { id: 'dup-1' },
    ]);
    expect(m.size).toBe(1);
    expect(m.get('dup-1')).toEqual(agentIdentity('dup-1'));
  });
});
