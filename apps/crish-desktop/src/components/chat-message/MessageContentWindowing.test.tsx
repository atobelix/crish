// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import React from 'react';
import { MessageContent } from './MessageContent';
import type { SessionMessage } from '../../store/types';

/**
 * R3 行内尾部窗口化：巨型回合（段数 ≥16 且估算节点 ≥2400）中，已封口的
 * 历史过程段先以骨架占位，进入 IntersectionObserver 预热区后真实挂载。
 */

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  elements = new Set<Element>();
  private cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.elements.add(el);
  }
  unobserve(el: Element) {
    this.elements.delete(el);
  }
  disconnect() {
    this.elements.clear();
  }
  fire(el: Element) {
    this.cb(
      [{ isIntersecting: true, target: el } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
}

const ROUNDS = 16;

function giantMessage(): SessionMessage {
  const blocks: unknown[] = [];
  const toolCalls: unknown[] = [];
  for (let r = 0; r < ROUNDS; r += 1) {
    blocks.push({
      type: 'thought',
      content: `第 ${r} 轮思考：` + '思'.repeat(220),
      turnIndex: r,
    });
    for (let k = 0; k < 3; k += 1) {
      const id = `t-${r}-${k}`;
      blocks.push({ type: 'tool_call', id });
      toolCalls.push({
        id,
        name: 'read_file',
        status: 'success',
        arguments: '',
        output: `UNIQUE-OUTPUT-${r}-${k}-` + 'x'.repeat(1500),
        startedAt: 1700000000000 + (r * 3 + k) * 1000,
      });
    }
    blocks.push({
      type: 'text',
      content: `第 ${r} 轮阶段结论。` + '文'.repeat(100),
    });
  }
  return {
    id: 'msg-giant-1',
    sender: 'assistant',
    text: '最终结论',
    status: 'completed',
    timestamp: 1700000000000,
    blocks,
    toolCalls,
  } as unknown as SessionMessage;
}

describe('MessageContent R3 行内尾部窗口化', () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      FakeIntersectionObserver;
  });

  afterEach(() => {
    delete (globalThis as { IntersectionObserver?: unknown })
      .IntersectionObserver;
  });

  it('巨型回合：历史过程段占位，末段与正文段真实渲染', () => {
    const { container } = render(
      <MessageContent
        msg={giantMessage()}
        isThinkingMsg={false}
        toolStackProps={{ activeSessionId: 'sess-win' }}
      />
    );
    const placeholders = container.querySelectorAll(
      '[data-testid="process-section-placeholder"]'
    );
    // 16 个过程段全部符合占位条件（已封口、非末段——末段是正文段）
    expect(placeholders.length).toBe(ROUNDS);
    // 占位段内容不在 DOM 中（原生查找不可见，占位高度已预留）
    expect(container.textContent).not.toContain('UNIQUE-OUTPUT-5-0');
    expect((placeholders[0] as HTMLElement).style.height).not.toBe('');
    // 正文段不受窗口化影响
    expect(container.textContent).toContain('第 15 轮阶段结论');
  });

  it('占位段进入预热区后真实挂载且单向闩不回退', () => {
    const { container } = render(
      <MessageContent
        msg={giantMessage()}
        isThinkingMsg={false}
        toolStackProps={{ activeSessionId: 'sess-win' }}
      />
    );
    const target = container.querySelector(
      '[data-section-id="msg-giant-1-proc-5"]'
    ) as HTMLElement;
    expect(target).not.toBeNull();
    expect(target.dataset.testid).toBe('process-section-placeholder');

    const observer = FakeIntersectionObserver.instances.find((o) =>
      o.elements.has(target)
    );
    expect(observer).toBeDefined();

    act(() => {
      observer!.fire(target);
    });

    const placeholdersAfter = container.querySelectorAll(
      '[data-testid="process-section-placeholder"]'
    );
    expect(placeholdersAfter.length).toBe(ROUNDS - 1);
    // 目标段已真实挂载（过程段内容槽出现），其余段仍为占位
    expect(
      container.querySelector('[data-testid="process-slot-msg-giant-1-proc-5"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="process-slot-msg-giant-1-proc-6"]')
    ).toBeNull();
    expect(container.textContent).not.toContain('UNIQUE-OUTPUT-6-0');
  });

  it('IntersectionObserver 不可用时整体禁用窗口化（与旧行为一致）', () => {
    delete (globalThis as { IntersectionObserver?: unknown })
      .IntersectionObserver;
    const { container } = render(
      <MessageContent
        msg={giantMessage()}
        isThinkingMsg={false}
        toolStackProps={{ activeSessionId: 'sess-win' }}
      />
    );
    expect(
      container.querySelectorAll('[data-testid="process-section-placeholder"]')
        .length
    ).toBe(0);
    expect(
      container.querySelector('[data-testid="process-slot-msg-giant-1-proc-5"]')
    ).not.toBeNull();
  });
});
