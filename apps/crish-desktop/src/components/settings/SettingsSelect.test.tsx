/**
 * SettingsSelect（ui/Menu 基座迁移版）交互测试：
 * 打开/选择/Esc/键盘漫游/外点关闭/listbox 语义
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { SettingsSelect } from './SettingsSelect';

const OPTIONS = [
  { value: 'a', label: '选项甲' },
  { value: 'b', label: '选项乙' },
  { value: 'c', label: '选项丙' },
];

function Wrapper({
  onSelect,
  onOpen,
}: {
  onSelect?: (v: string) => void;
  onOpen?: () => void;
}) {
  const [value, setValue] = useState('a');
  return (
    <SettingsSelect
      value={value}
      options={OPTIONS}
      onChange={(v) => {
        setValue(v);
        onSelect?.(v);
      }}
      onOpen={onOpen}
    />
  );
}

// 触发器 aria-label 即当前选中文案
function trigger() {
  return screen.getByRole('button', { name: '选项甲' });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SettingsSelect（ui/Menu 基座）', () => {
  it('点击触发器打开 listbox，选项渲染为 role=option', async () => {
    render(<Wrapper />);
    fireEvent.click(trigger());
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /选项乙/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /选项乙/ })).toHaveAttribute('aria-selected', 'false');
    // 当前选中项带 aria-selected=true
    expect(screen.getByRole('option', { name: /选项甲/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('点击选项触发 onChange 并关闭面板', async () => {
    const onSelect = vi.fn();
    render(<Wrapper onSelect={onSelect} />);
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole('option', { name: /选项乙/ }));
    expect(onSelect).toHaveBeenCalledWith('b');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    // 触发器展示最新选中值
    expect(screen.getByRole('button', { name: '选项乙' })).toBeInTheDocument();
  });

  it('Esc 关闭面板', async () => {
    render(<Wrapper />);
    fireEvent.click(trigger());
    const listbox = await screen.findByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('键盘漫游：ArrowDown 聚焦下一项，Enter 选中并关闭', async () => {
    const onSelect = vi.fn();
    render(<Wrapper onSelect={onSelect} />);
    fireEvent.click(trigger());
    const listbox = await screen.findByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /选项甲/ })).toHaveFocus();
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /选项乙/ })).toHaveFocus();
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('b');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('打开时回调 onOpen', async () => {
    const onOpen = vi.fn();
    render(<Wrapper onOpen={onOpen} />);
    fireEvent.click(trigger());
    await screen.findByRole('listbox');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('外点关闭：真实外点（pointerdown+click）后面板消失', async () => {
    render(<Wrapper />);
    fireEvent.click(trigger());
    await screen.findByRole('listbox');
    const outside = document.createElement('button');
    outside.textContent = '外部';
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    fireEvent.click(outside);
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    outside.remove();
  });

  it('触发器防冒泡：点击触发器不向外部冒泡', async () => {
    const onOuterClick = vi.fn();
    render(
      <div onClick={onOuterClick}>
        <Wrapper />
      </div>
    );
    fireEvent.click(trigger());
    expect(onOuterClick).not.toHaveBeenCalled();
    await screen.findByRole('listbox');
  });
});
