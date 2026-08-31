// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimelineThoughtSection } from './TimelineThoughtSection';

describe('TimelineThoughtSection', () => {
  it('正常展示思考阶段与耗时（不显示字数与放大图标），支持折叠展开', () => {
    render(
      <TimelineThoughtSection
        content="这是简短的思考过程"
        durationMs={2400}
        turnIndex={0}
      />
    );

    expect(screen.getByText('第 1 阶段思考')).toBeDefined();
    expect(screen.getByText(/2.4s/)).toBeDefined();
    expect(screen.queryByText(/共.*字/)).toBeNull();
    expect(screen.queryByRole('button', { name: /查看完整思考链/i })).toBeNull();
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

  it('长文本思考内容直接在折叠面板内完整渲染，不显示截断提示或弹窗放大按钮', () => {
    const longThought = 'A'.repeat(15000);
    const { container } = render(
      <TimelineThoughtSection
        messageId="msg-long-1"
        content={longThought}
        defaultExpanded={true}
      />
    );

    // 不存在截断提示与弹窗按钮
    expect(screen.queryByText(/(行内已截断)/)).toBeNull();
    expect(screen.queryByRole('button', { name: /查看完整思考链/i })).toBeNull();
    expect(container.querySelector('[class*="thoughtScrollBody"]')).not.toBeNull();
  });
});
