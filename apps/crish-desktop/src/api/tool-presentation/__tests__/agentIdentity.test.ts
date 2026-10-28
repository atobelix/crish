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
