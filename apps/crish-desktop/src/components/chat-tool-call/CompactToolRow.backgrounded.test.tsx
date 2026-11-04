// @vitest-environment jsdom
/**
 * BG5：CompactToolRow 后台态呈现——
 * output 为 BG2 占位信封时呈「已转后台运行 · 已运行 Xs」+ 取消钮；
 * 取消调注册表 kill；settled 回注替换 output 后原位回常规呈现。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { MessageToolCall } from '../../store/types';
import { CompactToolRow } from './CompactToolRow';
import type { ChatToolStackProps } from './ChatToolCallBlock';

vi.mock('../../api/toolBackgroundApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/toolBackgroundApi')>();
  return { ...actual, cancelToolBackgroundTask: vi.fn() };
});

import { cancelToolBackgroundTask } from '../../api/toolBackgroundApi';

const mockedCancel = vi.mocked(cancelToolBackgroundTask);

const PLACEHOLDER = JSON.stringify({
  mode: 'background',
  callId: 'bg1',
  toolName: 'web_search',
  elapsedMs: 20000,
  note: '该工具已转入后台继续执行，尚未完成。不要假设其结果；完成时结果会自动送达，或用 tool_task 查询。',
});

function backgroundedTc(): MessageToolCall {
  const now = Date.now();
  return {
    id: 'bg1',
    name: 'web_search',
    status: 'success',
    arguments: JSON.stringify({ query: 'crish' }),
    output: PLACEHOLDER,
    startedAt: now - 25000,
    completedAt: now - 5000,
  };
}

function stubProps(tc: MessageToolCall): ChatToolStackProps {
  return {
    items: [{ kind: 'single', tc }],
    agents: [],
    activeSessionId: 'sess-1',
    expandedTools: {},
    onToggleTool: () => {},
    approvalBusy: false,
    actions: {},
  };
}

describe('CompactToolRow 后台态（BG5）', () => {
  beforeEach(() => {
    mockedCancel.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('占位信封 → 后台条：状态词 + 已运行时长 + 取消钮', () => {
    const tc = backgroundedTc();
    const { container, getByTestId } = render(
      <CompactToolRow tc={tc} rowKey="bg1" msgId="m1" props={stubProps(tc)} />
    );
    const row = container.querySelector('[data-tool-id="bg1"]');
    expect(row?.getAttribute('data-tool-backgrounded')).toBe('true');
    expect(row?.getAttribute('data-tool-status')).toBe('已转后台运行');
    const bar = getByTestId('tool-background-bar-bg1');
    expect(bar.textContent).toContain('已转后台运行 · 已运行');
    // 信封 20s + 落盘后约 5s → 约 25 秒（容忍计时抖动，只断言量级）
    expect(bar.textContent).toMatch(/已运行 2[4-6](\.\d)? 秒/);
    expect(bar.querySelector('button')?.textContent).toBe('取消');
  });

  it('后台行无展开体（E1 决策序 2）：入参/输出非空也不渲染 chevron / 详情区，行头非 button', () => {
    const tc = backgroundedTc();
    const { container } = render(
      <CompactToolRow tc={tc} rowKey="bg1" msgId="m1" props={stubProps(tc)} />
    );
    // 旧谓词按「入参长度 > 2」会判可展开并露出占位信封原始 JSON；
    // 政策强制 none：无 chevron、无 ToolCallOutput 的 region、无行头按钮语义
    expect(
      container.querySelector('[data-testid="tool-chevron-bg1"]')
    ).toBeNull();
    expect(container.querySelector('[role="region"]')).toBeNull();
    expect(container.querySelector('div[role="button"]')).toBeNull();
    expect(container.textContent).not.toContain('"mode"');
  });

  it('点取消 → 调注册表 kill(callId)，成功后本地收口为「已停止」', async () => {
    mockedCancel.mockResolvedValue(true);
    const tc = backgroundedTc();
    const { getByTestId } = render(
      <CompactToolRow tc={tc} rowKey="bg1" msgId="m1" props={stubProps(tc)} />
    );
    const bar = getByTestId('tool-background-bar-bg1');
    fireEvent.click(bar.querySelector('button')!);
    await waitFor(() => expect(bar.textContent).toContain('已停止'));
    expect(mockedCancel).toHaveBeenCalledWith('bg1');
    expect(bar.querySelector('button')).toBeNull();
    expect(bar.getAttribute('data-background-state')).toBe('cancelled');
  });

  it('取消未生效（已终态）→ 不伪造状态，仍呈后台运行', async () => {
    mockedCancel.mockResolvedValue(false);
    const tc = backgroundedTc();
    const { getByTestId } = render(
      <CompactToolRow tc={tc} rowKey="bg1" msgId="m1" props={stubProps(tc)} />
    );
    const bar = getByTestId('tool-background-bar-bg1');
    fireEvent.click(bar.querySelector('button')!);
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledWith('bg1'));
    await waitFor(() =>
      expect(bar.getAttribute('data-background-state')).toBe('idle')
    );
    expect(bar.textContent).toContain('已转后台运行');
  });

  it('settled 回注替换 output → 后台条消失、原位回常规呈现', () => {
    const tc = backgroundedTc();
    const { container, rerender } = render(
      <CompactToolRow tc={tc} rowKey="bg1" msgId="m1" props={stubProps(tc)} />
    );
    expect(
      container.querySelector('[data-testid="tool-background-bar-bg1"]')
    ).not.toBeNull();
    const settled: MessageToolCall = {
      ...tc,
      output: '真实搜索结果',
      completedAt: Date.now(),
    };
    rerender(
      <CompactToolRow
        tc={settled}
        rowKey="bg1"
        msgId="m1"
        props={stubProps(settled)}
      />
    );
    expect(
      container.querySelector('[data-testid="tool-background-bar-bg1"]')
    ).toBeNull();
    const row = container.querySelector('[data-tool-id="bg1"]');
    expect(row?.getAttribute('data-tool-backgrounded')).toBeNull();
    expect(row?.getAttribute('data-tool-status')).toBe('已完成');
  });

  it('普通输出 / 信封 callId 不一致 → 无后台条', () => {
    const plain: MessageToolCall = {
      ...backgroundedTc(),
      id: 'x1',
      output: '普通结果',
    };
    const { container, rerender } = render(
      <CompactToolRow
        tc={plain}
        rowKey="x1"
        msgId="m1"
        props={stubProps(plain)}
      />
    );
    expect(
      container.querySelector('[data-testid^="tool-background-bar"]')
    ).toBeNull();

    const mismatched: MessageToolCall = { ...backgroundedTc(), id: 'other' };
    rerender(
      <CompactToolRow
        tc={mismatched}
        rowKey="other"
        msgId="m1"
        props={stubProps(mismatched)}
      />
    );
    expect(
      container.querySelector('[data-testid^="tool-background-bar"]')
    ).toBeNull();
  });
});
