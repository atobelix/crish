// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { SelectAdapter } from '../adapters/SelectAdapter';

const OPTIONS = [
  { id: 'opt1', label: '选项一' },
  { id: 'opt2', label: '选项二' },
  { id: 'opt3', label: '禁用项', disabled: true },
];

function ControlledSelectAdapter() {
  const [value, setValue] = useState<string | null>(null);
  return (
    <SelectAdapter
      value={value}
      onChange={(v) => setValue(v)}
      options={OPTIONS}
      placeholder="请选择选项"
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SelectAdapter 树形拓扑与 WAI-ARIA 契约测试', () => {
  it('保持 combobox -> listbox -> option 树形拓扑与 aria 契约 (DEVIL-04)', async () => {
    render(<SelectAdapter options={OPTIONS} value="opt1" />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    const listboxId = trigger.getAttribute('aria-controls');

    fireEvent.click(trigger);
    const listbox = await screen.findByRole('listbox');
    expect(listbox.id).toBe(listboxId);

    const option1 = screen.getByRole('option', { name: /选项一/ });
    expect(option1).toHaveAttribute('aria-selected', 'true');

    const option2 = screen.getByRole('option', { name: /选项二/ });
    expect(option2).toHaveAttribute('aria-selected', 'false');
  });

  it('受控与非受控选择交互触发 onChange 并更新 trigger 文本', async () => {
    render(<ControlledSelectAdapter />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('请选择选项');

    fireEvent.click(trigger);
    const option2 = await screen.findByRole('option', { name: /选项二/ });
    fireEvent.click(option2);

    expect(screen.getByRole('combobox')).toHaveTextContent('选项二');
    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    );
  });

  it('禁用项不可点击', async () => {
    const onChange = vi.fn();
    render(<SelectAdapter options={OPTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    const disabledOpt = await screen.findByRole('option', { name: /禁用项/ });
    expect(disabledOpt).toBeDisabled();
    fireEvent.click(disabledOpt);
    expect(onChange).not.toHaveBeenCalled();
  });
});
