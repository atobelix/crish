// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScanResultsModal } from './ScanResultsModal';

describe('ScanResultsModal (扫描模型多选/单选同步弹窗)', () => {
  const scanned = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-deprecated-legacy'];
  const existing = ['gpt-5.6-sol'];

  it('渲染扫描出的可用模型并标识已存在项', () => {
    render(
      <ScanResultsModal
        open={true}
        onClose={vi.fn()}
        providerName="OpenAI 官方"
        scannedModels={scanned}
        existingModels={existing}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByText('模型列表 · OpenAI 官方')).toBeTruthy();
    expect(screen.getByText('gpt-5.6-sol')).toBeTruthy();
    expect(screen.getByText('gpt-5.6-terra')).toBeTruthy();
    expect(screen.getByLabelText('已存在')).toBeTruthy();
  });

  it('默认优先选中新增模型，支持快捷动作（清空 / 全选）', () => {
    const onConfirm = vi.fn();
    render(
      <ScanResultsModal
        open={true}
        onClose={vi.fn()}
        providerName="OpenAI 官方"
        scannedModels={scanned}
        existingModels={existing}
        onConfirm={onConfirm}
      />
    );

    const clearBtn = screen.getByText('清空');
    fireEvent.click(clearBtn);

    const confirmBtn = screen.getByRole('button', { name: /同步所选/ });
    expect(confirmBtn.hasAttribute('disabled')).toBe(true);

    const selectAllBtn = screen.getByText('全选');
    fireEvent.click(selectAllBtn);
    expect(confirmBtn.hasAttribute('disabled')).toBe(false);

    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledWith(scanned);
  });

  it('支持 Shift 键范围多选与鼠标滑动多选', () => {
    const onConfirm = vi.fn();
    render(
      <ScanResultsModal
        open={true}
        onClose={vi.fn()}
        providerName="OpenAI 官方"
        scannedModels={scanned}
        existingModels={existing}
        onConfirm={onConfirm}
      />
    );

    const clearBtn = screen.getByText('清空');
    fireEvent.click(clearBtn);

    // 点击第 1 项
    const row0 = screen.getByText('gpt-5.6-sol');
    fireEvent.mouseDown(row0, { button: 0 });

    // 按住 Shift 点击第 3 项 (gpt-deprecated-legacy)
    const row2 = screen.getByText('gpt-deprecated-legacy');
    fireEvent.mouseDown(row2, { button: 0, shiftKey: true });

    // 此时三项全部选中
    const confirmBtn = screen.getByRole('button', { name: /同步所选 \(3\)/ });
    expect(confirmBtn).toBeTruthy();

    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledWith(scanned);
  });
});
