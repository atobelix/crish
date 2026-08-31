// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('correctly handles active states via button props rather than class override', () => {
    render(<DiffHeaderControls {...mockProps} searchOpen={true} />);
    const searchBtn = screen.getByLabelText('搜索差异行');
    expect(searchBtn).toHaveAttribute('data-active', 'true');
  });
});
