// @vitest-environment jsdom
/**
 * ContextInjectionBlock 容器渲染与无障碍测试：批量堆栈、空集合、aria region。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { ContextInjectionBlock } from '../ContextInjectionBlock';
import type { MessageContextInjection } from '../../../store/types';

vi.mock('../../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: (markdown: string) => ({
    html: markdown ? `<p>${markdown}</p>` : '',
    loading: false,
    failed: false,
  }),
  parseMarkdownToHtmlAsync: vi.fn(async (m: string) => `<p>${m}</p>`),
}));

vi.mock('../../../store/storeAccess', () => ({
  useSettingsField: vi.fn(() => 2),
}));

function makeInjection(
  partial: Partial<MessageContextInjection> & { id: string }
): MessageContextInjection {
  return {
    kind: 'schedule_trigger',
    title: '定时任务编排助手模式',
    status: 'injected',
    source: 'schedule_panel',
    content: '定时任务内容',
    tokenEstimate: 320,
    timestamp: Date.now(),
    ...partial,
  };
}

describe('ContextInjectionBlock 容器渲染', () => {
  it('空集合返回 null（不渲染堆栈）', () => {
    const { container } = render(
      <ContextInjectionBlock
        injections={[]}
        activeSessionId="s1"
        msgId="m1"
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('批量渲染全部注入卡片并声明无障碍 region', () => {
    const { container } = render(
      <ContextInjectionBlock
        injections={[
          makeInjection({ id: 'inj-1', kind: 'rule', title: '规则注入 AGENTS' }),
          makeInjection({
            id: 'inj-2',
            kind: 'git_status',
            title: 'Git 工作区快照',
          }),
          makeInjection({
            id: 'inj-3',
            kind: 'terminal_output',
            title: '终端报错回执',
          }),
        ]}
        activeSessionId="s1"
        msgId="m1"
      />
    );
    expect(container.querySelector('[role="region"]')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="系统上下文注入（共 3 项）"]')
    ).not.toBeNull();
    expect(container.querySelectorAll('[data-injection-id]')).toHaveLength(3);
    expect(screen.getByText('规则注入')).toBeInTheDocument();
    expect(screen.getByText('规则注入 AGENTS')).toBeInTheDocument();
    expect(screen.getByText('Git 工作区快照')).toBeInTheDocument();
    expect(screen.getByText('终端报错回执')).toBeInTheDocument();
  });

  it('className 透传叠加到堆栈容器', () => {
    const { container } = render(
      <ContextInjectionBlock
        injections={[makeInjection({ id: 'inj-x' })]}
        activeSessionId="s1"
        msgId="m1"
        className="custom-ctx-stack"
      />
    );
    const stack = container.querySelector('.custom-ctx-stack');
    expect(stack).not.toBeNull();
  });

  it('空标题 / 异常条目不崩溃（渲染降级不抛错）', () => {
    const { container } = render(
      <ContextInjectionBlock
        injections={[
          makeInjection({ id: 'inj-err', title: '异常注入', content: '' }),
        ]}
        activeSessionId="s1"
        msgId="m1"
      />
    );
    // 无正文仍渲染单行卡片（标题可见），不抛异常
    expect(container.querySelector('[data-injection-id="inj-err"]')).not.toBeNull();
    expect(screen.getByText('异常注入')).toBeInTheDocument();
  });
});
