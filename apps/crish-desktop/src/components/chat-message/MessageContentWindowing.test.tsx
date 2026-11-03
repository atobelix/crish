// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { MessageContent } from './MessageContent';
import { expandMessageProcess } from './searchExpandBridge';
import type { SessionMessage } from '../../store/types';

/**
 * R9 组级窗口化：巨型回合收敛为一个过程组（组内条目 ≥16 且估算节点 ≥2400）
 * 时，已封口的历史组采用二段式占位——组头常驻、组体等高占位；组体占位
 * 进入 IntersectionObserver 预热区后真实挂载（单向闩）；检索展开命令
 * （searchExpandBridge）可全量挂载已占位组体。
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

const ROUNDS = 20;

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

describe('MessageContent R9 组级窗口化', () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      FakeIntersectionObserver;
  });

  afterEach(() => {
    // 逐用例卸载渲染树：searchExpandBridge 是模块级单例且多用例共用同一
    // msgId，残留实例的订阅会互相干扰（与兄弟套件的手动 cleanup 口径一致）
    cleanup();
    delete (globalThis as { IntersectionObserver?: unknown })
      .IntersectionObserver;
  });

  it('巨型回合：整轮收敛为一个过程组，组头常驻 + 组体占位，答复段真实渲染', () => {
    const { container } = render(
      <MessageContent
        msg={giantMessage()}
        isThinkingMsg={false}
        toolStackProps={{ activeSessionId: 'sess-win' }}
      />
    );

    // R9 单组形态：一轮只有一个过程组
    const groups = container.querySelectorAll('[data-process-segment]');
    expect(groups.length).toBe(1);
    expect(groups[0]!.getAttribute('data-process-segment')).toBe(
      'msg-giant-1-proc-0'
    );

    // 二段式占位：组头（控制栏）常驻
    expect(
      container.querySelector(
        '[data-testid="process-toggle-msg-giant-1-proc-0"]'
      )
    ).not.toBeNull();
    // 组体以等高占位替代挂载
    const placeholders = container.querySelectorAll(
      '[data-testid="process-group-body-placeholder"]'
    );
    expect(placeholders.length).toBe(1);
    expect((placeholders[0] as HTMLElement).style.height).not.toBe('');

    // 组体内容不在 DOM 中：工具行与组内叙述行均不可见
    // （工具行探针改用行的人话标签属性：HC1 · D-2 动词统一后回退标签为「读取文件」，
    // 且 D-1 起入参派生标签不再行内渲染，textContent 探针失效）
    expect(container.querySelector('[data-tool-label="读取文件"]')).toBeNull();
    expect(container.textContent).not.toContain('第 3 轮阶段结论');
    // 答复段（最后一轮正文）在组外真实渲染，不受窗口化影响
    expect(container.textContent).toContain('第 19 轮阶段结论');
  });

  it('占位态文档节点数远低于全量挂载（R10 并入验收）', () => {
    const { container: placeholderRender } = render(
      <MessageContent
        msg={giantMessage()}
        isThinkingMsg={false}
        toolStackProps={{ activeSessionId: 'sess-win' }}
      />
    );
    const placeholderNodes = placeholderRender.querySelectorAll('*').length;

    delete (globalThis as { IntersectionObserver?: unknown })
      .IntersectionObserver;
    const { container: fullRender } = render(
      <MessageContent
        msg={giantMessage()}
        isThinkingMsg={false}
        toolStackProps={{ activeSessionId: 'sess-win' }}
      />
    );
    const fullNodes = fullRender.querySelectorAll('*').length;

    expect(fullNodes).toBeGreaterThan(1000);
    expect(placeholderNodes).toBeLessThan(fullNodes / 3);
  });

  it('组体占位进入预热区后真实挂载且单向闩不回退', () => {
    const { container } = render(
      <MessageContent
        msg={giantMessage()}
        isThinkingMsg={false}
        toolStackProps={{ activeSessionId: 'sess-win' }}
      />
    );
    const target = container.querySelector(
      '[data-section-id="msg-giant-1-proc-0"]'
    ) as HTMLElement;
    expect(target).not.toBeNull();
    expect(target.dataset.testid).toBe('process-group-body-placeholder');

    const observer = FakeIntersectionObserver.instances.find((o) =>
      o.elements.has(target)
    );
    expect(observer).toBeDefined();

    act(() => {
      observer!.fire(target);
    });

    // 占位消失，组体真实挂载（含组内叙述行与工具行）
    expect(
      container.querySelectorAll(
        '[data-testid="process-group-body-placeholder"]'
      ).length
    ).toBe(0);
    expect(
      container.querySelector('[data-testid="process-slot-msg-giant-1-proc-0"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-tool-label="读取文件"]')
    ).not.toBeNull();
    expect(container.textContent).toContain('第 3 轮阶段结论');
  });

  it('检索展开命令可全量挂载已占位组体（bridge 契约不变）', () => {
    const { container } = render(
      <MessageContent
        msg={giantMessage()}
        isThinkingMsg={false}
        toolStackProps={{ activeSessionId: 'sess-win' }}
      />
    );
    expect(
      container.querySelectorAll(
        '[data-testid="process-group-body-placeholder"]'
      ).length
    ).toBe(1);

    act(() => {
      expandMessageProcess('msg-giant-1');
    });

    expect(
      container.querySelectorAll(
        '[data-testid="process-group-body-placeholder"]'
      ).length
    ).toBe(0);
    expect(container.textContent).toContain('第 3 轮阶段结论');
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
      container.querySelectorAll(
        '[data-testid="process-group-body-placeholder"]'
      ).length
    ).toBe(0);
    expect(
      container.querySelector('[data-testid="process-slot-msg-giant-1-proc-0"]')
    ).not.toBeNull();
    expect(container.textContent).toContain('第 3 轮阶段结论');
  });
});
