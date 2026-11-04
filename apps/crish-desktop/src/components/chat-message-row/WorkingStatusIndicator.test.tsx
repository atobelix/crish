/**
 * @vitest-environment jsdom
 * 批 B ⑲ 钉住：等待占位已有定高形态；无前置工作时只出「正在处理 · 计时」，
 * 不编造原因文案；原因通道（statusText）只呈现调用方给出的真实原因。
 * 桌面在该等待点唯一真实的前置信号是引擎重试，由同屏 InFlowStatusLine
 * 呈现（见 inFlowStatusLineLib.test 与 MessageContent 源码契约测试）。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { WorkingStatusIndicator } from './WorkingStatusIndicator';

describe('WorkingStatusIndicator（批 B ⑲）', () => {
  it('无 statusText：只有等待文案与计时，无编造原因', () => {
    const { getByTestId } = render(
      <WorkingStatusIndicator startTime={Date.now()} mode="initial" />
    );
    const el = getByTestId('working-status-indicator');
    expect(el.textContent).toContain('正在处理');
    expect(el.textContent).not.toMatch(/重试|转写|连接中|排队/);
  });

  it('有真实 statusText：原样呈现', () => {
    const { getByTestId } = render(
      <WorkingStatusIndicator mode="initial" statusText="正在重试 1/3" />
    );
    expect(getByTestId('working-status-indicator').textContent).toContain(
      '正在重试 1/3'
    );
  });
});
