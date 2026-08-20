// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { TimelineThoughtSection } from './TimelineThoughtSection';
import { useThoughtInspectorStore } from '../../store/thoughtInspectorStore';

afterEach(() => {
  cleanup();
  useThoughtInspectorStore.getState().closeThoughtInspector();
});

describe('TimelineThoughtSection', () => {
  it('正常展示思考过程与字数，支持展开折叠', () => {
    render(
      <TimelineThoughtSection
        content="这是简短的思考过程"
        durationMs={2400}
        turnIndex={0}
      />
    );

    expect(screen.getByText('第 1 阶段思考')).toBeDefined();
    expect(screen.getByText(/2.4s/)).toBeDefined();
    expect(screen.getByText(/共 9 字/)).toBeDefined();
  });

  it('实时思考中展示呼吸绿点与流式文案', () => {
    const { container } = render(
      <TimelineThoughtSection content="正在思考下一步工具调用" isLive={true} />
    );

    expect(screen.getByText('思考中')).toBeDefined();
    expect(container.querySelector('[class*="thoughtLiveDot"]')).not.toBeNull();
  });

  it('defaultExpanded 控制新渲染块的初始开合', () => {
    const open = render(
      <TimelineThoughtSection content="推理段落" defaultExpanded />
    );
    expect(
      open.container.querySelector('[data-kind="thought"] [aria-expanded="true"]')
    ).not.toBeNull();
    expect(
      open.container.querySelector('[data-kind="thought"] [data-expanded="true"]')
    ).not.toBeNull();
    open.unmount();

    const closed = render(
      <TimelineThoughtSection content="推理段落" defaultExpanded={false} />
    );
    expect(
      closed.container.querySelector(
        '[data-kind="thought"] [aria-expanded="false"]'
      )
    ).not.toBeNull();
    expect(
      closed.container.querySelector(
        '[data-kind="thought"] [data-expanded="false"]'
      )
    ).not.toBeNull();
  });

  it('超过 10k 预算时渲染截断提示与完整思考链按钮，点击触发 openThoughtInspector', () => {
    const longThought = 'A'.repeat(15000);
    render(
      <TimelineThoughtSection
        messageId="msg-long-1"
        content={longThought}
        defaultExpanded={true}
      />
    );

    // 存在截断提示
    expect(screen.getByText(/(行内已截断)/)).toBeDefined();
    const buttons = screen.getAllByRole('button', { name: /查看完整思考链/i });
    expect(buttons.length).toBeGreaterThan(0);

    // 点击截断底栏按钮
    fireEvent.click(buttons[buttons.length - 1]);

    const storeState = useThoughtInspectorStore.getState();
    expect(storeState.isOpen).toBe(true);
    expect(storeState.activeMessageId).toBe('msg-long-1');
    expect(storeState.content).toBe(longThought);
  });
});
