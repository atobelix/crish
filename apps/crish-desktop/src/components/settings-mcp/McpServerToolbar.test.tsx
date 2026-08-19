// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { McpServerToolbar } from './McpServerToolbar';

afterEach(() => {
  cleanup();
});

describe('McpServerToolbar 死皮拉回', () => {
  it('排序走 SegmentedControl 且有选中态；搜索走 ui/Input；无 ui-segment / 裸 input', () => {
    const onSetSort = vi.fn();
    const onSetFilter = vi.fn();
    const onClearFilter = vi.fn();
    render(
      <McpServerToolbar
        demo={false}
        loading={false}
        filter=""
        sortMode="name"
        showAdd={false}
        onRefresh={() => {}}
        onSetSort={onSetSort}
        onSetFilter={onSetFilter}
        onClearFilter={onClearFilter}
        onSetShowAdd={() => {}}
      />
    );

    expect(document.querySelector('.ui-segment')).toBeNull();
    expect(document.querySelector('.ui-segment-item')).toBeNull();
    expect(document.querySelector('.settings-field-input')).toBeNull();
    expect(document.querySelector('input[type="search"]')).toBeNull();

    const name = screen.getByRole('radio', { name: '名称' });
    const state = screen.getByRole('radio', { name: '状态' });
    expect(name).toHaveAttribute('aria-checked', 'true');
    expect(state).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(state);
    expect(onSetSort).toHaveBeenCalledWith('state');

    const search = screen.getByRole('searchbox', { name: '搜索扩展服务' });
    fireEvent.change(search, { target: { value: 'foo' } });
    expect(onSetFilter).toHaveBeenCalled();
  });
});
