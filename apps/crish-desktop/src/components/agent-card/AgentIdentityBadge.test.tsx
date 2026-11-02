// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AgentIdentityBadge } from './AgentIdentityBadge';
import {
  agentIdentity,
  resolveAgentIdentities,
} from '../../api/tool-presentation/agentIdentity';

describe('AgentIdentityBadge（R4a 共享身份标）', () => {
  it('渲染色点 + 几何标号，色值走 --agent-hue-N 变量而非写死', () => {
    const identity = agentIdentity('sa-1');
    const { container } = render(<AgentIdentityBadge identity={identity} />);
    const badge = container.querySelector('[data-agent-identity-badge]');
    expect(badge).toBeTruthy();
    expect(badge!.getAttribute('data-hue-index')).toBe(
      String(identity.hueIndex)
    );
    expect(badge!.textContent).toContain(identity.glyph);
    const dot = badge!.querySelector('span') as HTMLElement;
    expect(dot.style.backgroundColor).toBe(identity.hueVar);
    const glyph = badge!.querySelectorAll('span')[1] as HTMLElement;
    expect(glyph.style.color).toBe(identity.hueVar);
  });

  it('与 resolveAgentIdentities 的顺延结果一致（撞色时标号随顺延槽）', () => {
    // 找两个哈希同槽的 id（哈希确定性，构造稳定）
    const bySlot = new Map<number, string>();
    let pair: [string, string] | null = null;
    for (let i = 0; i < 64 && !pair; i++) {
      const id = `badge-agent-${i}`;
      const slot = agentIdentity(id).hueIndex;
      const prev = bySlot.get(slot);
      if (prev) pair = [prev, id];
      else bySlot.set(slot, id);
    }
    expect(pair).toBeTruthy();
    const resolved = resolveAgentIdentities([
      { id: pair![0] },
      { id: pair![1] },
    ]);
    const second = resolved.get(pair![1])!;
    expect(second.hueIndex).not.toBe(agentIdentity(pair![1]).hueIndex);
    const { container } = render(<AgentIdentityBadge identity={second} />);
    const badge = container.querySelector('[data-agent-identity-badge]');
    expect(badge!.getAttribute('data-hue-index')).toBe(String(second.hueIndex));
    expect(badge!.textContent).toContain(second.glyph);
  });

  it('size 透传为基准字号，色点直径约为其 0.6 倍', () => {
    const identity = agentIdentity('sa-2');
    const { container } = render(
      <AgentIdentityBadge identity={identity} size={20} />
    );
    const badge = container.querySelector(
      '[data-agent-identity-badge]'
    ) as HTMLElement;
    expect(badge.style.fontSize).toBe('20px');
    const dot = badge.querySelector('span') as HTMLElement;
    expect(dot.style.width).toBe('12px');
    expect(dot.style.height).toBe('12px');
  });
});
