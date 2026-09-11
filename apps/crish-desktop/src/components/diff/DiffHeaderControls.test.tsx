// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffHeaderControls, type DiffHeaderControlsProps } from './DiffHeaderControls';

const mockProps: DiffHeaderControlsProps = {
  sourceMode: 'session',
  diffViewMode: 'unified',
  searchOpen: false,
  searchActive: false,
  gitLoading: false,
  applyBusy: false,
  busy: false,
  turnKey: '1',
  turnOptions: [{ value: '1', label: 'Turn 1' }],
  branches: ['main', 'feature'],
  currentBranch: 'main',
  commitPanelOpen: false,
  fileListLength: 2,
  current: null,
  onViewModeChange: vi.fn(),
  onSearchOpenChange: vi.fn(),
  onSourceModeChange: vi.fn(),
  onTurnSelect: vi.fn(),
  onBranchChange: vi.fn(),
  onCommitPanelToggle: vi.fn(),
  onCopyPatch: vi.fn(),
  onClear: vi.fn(),
};

describe('DiffHeaderControls Component Alignment & Behavior', () => {
  it('renders toolbar with size="sm" Select and standardized action buttons', () => {
    render(<DiffHeaderControls {...mockProps} sourceMode="session" />);
    
    // 断言下拉框带有 sm 尺寸类
    const selectTrigger = screen.getByRole('combobox');
    expect(selectTrigger.className).toContain('triggerSm');
    
    // 断言操作按钮带有正确 aria-label 与 ghost 变体
    const viewBtn = screen.getByLabelText(/切换至/);
    expect(viewBtn).toBeInTheDocument();
    expect(viewBtn).toHaveAttribute('data-variant', 'ghost');
    expect(viewBtn).toHaveAttribute('data-size', 'sm');
  });

  it('renders standard SegmentedControl with radio roles and accessibility', () => {
    render(<DiffHeaderControls {...mockProps} />);
    const radioGroup = screen.getByRole('radiogroup', { name: '变更来源' });
    expect(radioGroup).toBeDefined();

    const aiRadio = screen.getByRole('radio', { name: /当前对话中 AI 产生的改动|AI/i });
    const gitRadio = screen.getByRole('radio', { name: /工作区 Git 未提交变更|Git/i });

    expect(aiRadio).toBeDefined();
    expect(gitRadio).toBeDefined();
    expect(aiRadio.getAttribute('aria-checked')).toBe('true');
  });

  it('triggers onSourceModeChange when clicking Git segment', () => {
    const onSourceModeChange = vi.fn();
    render(<DiffHeaderControls {...mockProps} onSourceModeChange={onSourceModeChange} />);
    
    const gitRadio = screen.getByRole('radio', { name: /Git/i });
    fireEvent.click(gitRadio);
    expect(onSourceModeChange).toHaveBeenCalledWith('git');
  });

  it('supports keyboard navigation via ArrowRight in SegmentedControl', () => {
    const onSourceModeChange = vi.fn();
    render(<DiffHeaderControls {...mockProps} onSourceModeChange={onSourceModeChange} />);
    
    const radioGroup = screen.getByRole('radiogroup', { name: '变更来源' });
    fireEvent.keyDown(radioGroup, { key: 'ArrowRight' });
    expect(onSourceModeChange).toHaveBeenCalledWith('git');
  });

  it('correctly handles active states via button props rather than class override', () => {
    render(<DiffHeaderControls {...mockProps} searchOpen={true} />);
    const searchBtn = screen.getByLabelText('搜索差异行');
    expect(searchBtn).toHaveAttribute('data-active', 'true');
  });

  it('class="_rightActions" 内部全面换装原子组件 <IconButton size="sm"> 并拔除私有 .actionBtn 覆盖', () => {
    const { container } = render(
      <DiffHeaderControls
        {...mockProps}
        sourceMode="git"
        fileListLength={3}
        current={{ path: 'test.ts', hunks: [] } as any}
        commitPanelOpen={true}
        searchOpen={true}
      />
    );

    const rightActions = container.querySelector(`[class*="rightActions"]`);
    expect(rightActions).toBeInTheDocument();

    // 断言所有按钮均具备 iconButton 原子类，且绝无 actionBtn 私有覆盖
    const buttons = rightActions!.querySelectorAll('button');
    expect(buttons.length).toBeGreaterThanOrEqual(4);

    for (const btn of Array.from(buttons)) {
      expect(btn.className).toContain('iconButton');
      expect(btn.className).not.toContain('actionBtn');
      expect(btn).toHaveAttribute('data-size', 'sm');
      expect(btn).toHaveAttribute('aria-label');
      expect(btn.getAttribute('aria-label')!.length).toBeGreaterThan(0);
    }
  });

  it('清空变更列表 Trash2 按钮常态为 variant="ghost" 且挂载 dangerBtn 类，实现 hover 才带危险红色的交互契约', () => {
    render(<DiffHeaderControls {...mockProps} fileListLength={3} />);
    const clearBtn = screen.getByRole('button', { name: '清空变更列表' });
    expect(clearBtn).toBeInTheDocument();
    expect(clearBtn).toHaveAttribute('data-variant', 'ghost');
    expect(clearBtn.className).toContain('dangerBtn');
  });
});
