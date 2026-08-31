// @vitest-environment jsdom
/**
 * ui/Select 测试：受控选中、listbox 语义、键盘漫游、a11y
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import { Select } from './Select';

const OPTIONS = [
  { id: 'gpt4', label: 'GPT-4' },
  { id: 'claude', label: 'Claude' },
  { id: 'local', label: '本地模型', disabled: true },
];

/** 受控包装：模拟业务侧受控选中状态 */
function ControlledSelect(props: React.ComponentProps<typeof Select>) {
  const [value, setValue] = useState<string | null>(null);
  return <Select value={value} onChange={(v) => setValue(v)} {...props} />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ui/Select', () => {
  it('未选择时显示占位文案', () => {
    render(<ControlledSelect options={OPTIONS} placeholder="选择模型" />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('选择模型');
  });

  it('combobox 语义：aria-haspopup=listbox + aria-controls 指向 listbox', async () => {
    render(<ControlledSelect options={OPTIONS} />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    const controlsId = trigger.getAttribute('aria-controls');
    fireEvent.click(trigger);
    const listbox = await screen.findByRole('listbox');
    expect(listbox.id).toBe(controlsId);
  });

  it('点击触发器展开 listbox，选中项带 aria-selected 与勾选', async () => {
    render(<ControlledSelect options={OPTIONS} />);
    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPT-4' })).toHaveAttribute(
      'aria-selected',
      'false'
    );
    fireEvent.click(screen.getByRole('option', { name: 'GPT-4' }));
    expect(screen.getByRole('combobox')).toHaveTextContent('GPT-4');
    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    );
  });

  it('受控 value 驱动选中态与 aria-selected', async () => {
    render(<Select value="claude" options={OPTIONS} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Claude');
    fireEvent.click(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', { name: 'Claude' });
    expect(option).toHaveAttribute('aria-selected', 'true');
  });

  it('onChange 上报选中 id', async () => {
    const onChange = vi.fn();
    render(<Select options={OPTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Claude' }));
    expect(onChange).toHaveBeenCalledWith('claude');
  });

  it('键盘漫游：ArrowDown 选中 + Enter 提交（走 Menu 基座）', async () => {
    const onChange = vi.fn();
    render(<Select options={OPTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    // F7-F2 契约：ARIA menu/listbox 模式打开即聚焦首项（GPT-4）
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'GPT-4' })).toHaveFocus()
    );
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Claude' })).toHaveFocus();
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('claude');
  });

  it('禁用项不可选中', async () => {
    const onChange = vi.fn();
    render(<Select options={OPTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    const disabled = await screen.findByRole('option', { name: '本地模型' });
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Esc 关闭面板（走 Menu 基座）', async () => {
    render(<ControlledSelect options={OPTIONS} />);
    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    );
  });

  it('error 文案触发 aria-invalid 与错误描边类', () => {
    render(<Select options={OPTIONS} error="必须选择模型" />);
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(screen.getByText('必须选择模型')).toBeInTheDocument();
  });

  it('label 关联触发器', () => {
    render(<Select label="模型" options={OPTIONS} />);
    const label = screen.getByText('模型');
    expect(label.tagName).toBe('LABEL');
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'id',
      label.getAttribute('for')
    );
  });

  it('disabled 触发器不可交互', () => {
    render(<Select disabled options={OPTIONS} />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('hint 选项：行内展示辅助说明，选择不受影响', async () => {
    const onChange = vi.fn();
    render(
      <Select
        options={[{ id: 'a', label: '选项甲', hint: '仅作说明' }]}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', { name: /选项甲/ });
    expect(screen.getByText('仅作说明')).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('外点关闭：真实外点（pointerdown+click）后面板消失', async () => {
    render(<ControlledSelect options={OPTIONS} />);
    fireEvent.click(screen.getByRole('combobox'));
    await screen.findByRole('listbox');
    const outside = document.createElement('button');
    outside.textContent = '外部';
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    fireEvent.click(outside);
    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    );
    outside.remove();
  });

  it('触发器事件流：点击触发器正常冒泡并展开列表', async () => {
    const onOuterClick = vi.fn();
    render(
      <div onClick={onOuterClick}>
        <ControlledSelect options={OPTIONS} />
      </div>
    );
    fireEvent.click(screen.getByRole('combobox'));
    expect(onOuterClick).toHaveBeenCalledTimes(1);
    await screen.findByRole('listbox');
  });

  it('size="sm" 下发 triggerSm 类名', () => {
    render(<Select size="sm" options={OPTIONS} />);
    const trigger = screen.getByRole('combobox');
    expect(trigger.className).toContain('triggerSm');
  });
});
