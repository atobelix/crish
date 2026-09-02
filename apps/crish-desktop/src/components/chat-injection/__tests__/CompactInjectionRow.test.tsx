// @vitest-environment jsdom
/**
 * CompactInjectionRow 渲染与交互测试：卡片 Header、Token 徽标、折叠展开、
 * 失败态重试按钮与 aria 完整性。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { CompactInjectionRow } from '../CompactInjectionRow';
import type { MessageContextInjection } from '../../../store/types';

// 同步返回渲染 HTML，避免 Worker/Rust 异步链路进入 jsdom
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
  partial: Partial<MessageContextInjection> = {}
): MessageContextInjection {
  return {
    id: 'inj_test_1',
    kind: 'rule',
    title: '项目规则: Rust 规范',
    summary: '2 条规则',
    status: 'injected',
    source: 'rule_loader',
    content: '# Rust 规则\n1. 必须使用 UTF-8 无 BOM',
    tokenEstimate: 450,
    timestamp: Date.now(),
    ...partial,
  };
}

describe('CompactInjectionRow 渲染与交互', () => {
  it('正确渲染卡片 Header、标题、分类 Badge 与 Token 徽标', () => {
    render(
      <CompactInjectionRow
        injection={makeInjection()}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
      />
    );
    expect(screen.getByText('规则注入')).toBeInTheDocument();
    expect(screen.getByText('项目规则: Rust 规范')).toBeInTheDocument();
    expect(screen.getByText('450 t')).toBeInTheDocument();
    expect(screen.getByText('2 条规则')).toBeInTheDocument();
  });

  it('默认折叠（defaultFolded=true）：Markdown 正文不可见，点击 Header 展开可见', () => {
    const inj = makeInjection({ defaultFolded: true });
    render(
      <CompactInjectionRow
        injection={inj}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
      />
    );
    // 折叠态：正文不可见
    expect(screen.queryByText(/必须使用 UTF-8 无 BOM/i)).not.toBeInTheDocument();

    // 点击整行 Header（role=button）展开
    const head = screen.getByRole('button', {
      name: /项目规则: Rust 规范/i,
    });
    fireEvent.click(head);
    // 正文经 mock html 注入后以纯文本可见
    expect(screen.getByText(/必须使用 UTF-8 无 BOM/i)).toBeInTheDocument();
  });

  it('受控折叠态优先于本地 state（expandedInjections=false 压制展开）', () => {
    const inj = makeInjection({ content: '短内容' });
    render(
      <CompactInjectionRow
        injection={inj}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
        expandedInjections={{ [inj.id]: false }}
      />
    );
    expect(screen.queryByText(/短内容/i)).not.toBeInTheDocument();
  });
  it('失败状态展示错误高亮与重试按钮，点击触发回调', () => {
    const retryFn = vi.fn();
    render(
      <CompactInjectionRow
        injection={makeInjection({ status: 'failed' })}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
        onRetryInjection={retryFn}
      />
    );
    const retryBtn = screen.getByRole('button', { name: /重试注入/i });
    expect(retryBtn).toBeInTheDocument();
    fireEvent.click(retryBtn);
    expect(retryFn).toHaveBeenCalledWith('inj_test_1');
  });

  it('pending 状态展示准备中图标脉冲（不展示失败重试）', () => {
    render(
      <CompactInjectionRow
        injection={makeInjection({ status: 'pending' })}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
        onRetryInjection={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /重试注入/i })).not.toBeInTheDocument();
  });

  it('短内容且未声明 defaultFolded 时默认展开（正文直接可见）', () => {
    render(
      <CompactInjectionRow
        injection={makeInjection({ content: '简短纠偏指令' })}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
      />
    );
    expect(screen.getByText(/简短纠偏指令/i)).toBeInTheDocument();
  });

  it('aria 完整：data 属性承载 id/kind/status，展开态联动 aria-expanded', () => {
    const { container } = render(
      <CompactInjectionRow
        injection={makeInjection({ defaultFolded: true })}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
      />
    );
    const row = container.querySelector('[data-injection-id="inj_test_1"]');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute('data-injection-kind', 'rule');
    expect(row).toHaveAttribute('data-injection-status', 'injected');
    const head = screen.getByRole('button', { name: /项目规则: Rust 规范/i });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(head).toHaveAttribute('aria-controls', 'injection-body-inj_test_1');
  });
});
