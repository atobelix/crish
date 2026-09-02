// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Select } from '../Select';
import { Dialog } from '../../Dialog/Dialog';
import { DialogOverlayContext } from '../../Dialog/dialogOverlayContext';

describe('Select: DialogOverlayContext Integration Suite (Plan 09)', () => {
  it('在 DialogOverlayContext 下自动 portal 到 overlay 容器中', () => {
    const mockOverlay = document.createElement('div');
    mockOverlay.setAttribute('data-dialog-overlay', '');
    document.body.appendChild(mockOverlay);

    render(
      <DialogOverlayContext.Provider value={mockOverlay}>
        <Select
          defaultOpen={true}
          options={[
            { id: 'opt1', label: '选项一' },
            { id: 'opt2', label: '选项二' },
          ]}
        />
      </DialogOverlayContext.Provider>
    );

    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();
    // 断言 listbox 挂载在 mockOverlay 内部，而不是 document.body 直接子节点
    expect(mockOverlay.contains(listbox)).toBe(true);

    document.body.removeChild(mockOverlay);
  });

  it('在真实 Dialog 弹窗内打开 Select 时，选项能被正常点击选中', () => {
    function TestDialogSelect() {
      const [val, setVal] = useState('none');
      return (
        <Dialog open={true} title="测试弹窗">
          <div data-testid="selected-display">{val}</div>
          <Select
            value={val}
            onChange={(v) => setVal(v)}
            options={[
              { id: 'apple', label: '苹果' },
              { id: 'banana', label: '香蕉' },
            ]}
          />
        </Dialog>
      );
    }

    render(<TestDialogSelect />);

    // 点击触发器
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);

    // 下拉列表可见
    const option = screen.getByRole('option', { name: '香蕉' });
    expect(option).toBeInTheDocument();

    // 点击选项
    fireEvent.click(option);

    // 状态成功更新
    expect(screen.getByTestId('selected-display')).toHaveTextContent('banana');
  });

  it('在非 Dialog 常规环境下，Select 自动优雅 fallback 挂载至 document.body', () => {
    render(
      <Select
        defaultOpen={true}
        options={[{ id: 'plain', label: '普通环境' }]}
      />
    );

    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();
    expect(document.body.contains(listbox)).toBe(true);
  });
});
