// @vitest-environment jsdom
/**
 * 技能发现弹窗（PE-05 T05.2 #4）关键行为测试：
 * 候选勾选列表渲染 / 跳过（按钮 + Esc + 遮罩同一动作）/ 全启 / 启用所选
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SkillEditorModal } from './SkillEditorModal';

const candidates = [
  { id: 's1', name: 'review', description: 'code review' },
  { id: 's2', name: 'test', description: 'run tests' },
];

const baseProps = {
  discover: {
    discoverCandidates: candidates as never,
    discoverPick: {},
    discoverBusy: false,
    setDiscoverPick: vi.fn(),
    applyDiscoverImport: vi.fn(async () => {}),
  },
  create: {
    createMode: 'none' as const,
    setCreateMode: vi.fn(),
    createName: '',
    setCreateName: vi.fn(),
    createDesc: '',
    setCreateDesc: vi.fn(),
    createBusy: false,
    handleCreate: vi.fn(async () => {}),
    handleImportBrowse: vi.fn(async () => {}),
    handleAiCreateSkill: vi.fn(),
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SkillEditorModal 发现弹窗（ui/Dialog 基座迁移后）', () => {
  it('有候选时渲染模态弹窗与勾选列表', () => {
    render(<SkillEditorModal {...baseProps} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('发现新技能 2')).toBeInTheDocument();
    // discoverPick 缺省视为选中（checked），aria-label 为「取消选择」
    expect(screen.getByLabelText('取消选择 review')).toBeInTheDocument();
  });

  it('无候选时不渲染弹窗', () => {
    render(
      <SkillEditorModal
        {...baseProps}
        discover={{ ...baseProps.discover, discoverCandidates: null }}
      />
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('「跳过」触发 applyDiscoverImport("skip")', () => {
    render(<SkillEditorModal {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: '跳过导入' }));
    expect(baseProps.discover.applyDiscoverImport).toHaveBeenCalledWith('skip');
  });

  it('Esc 与「跳过」同一动作（关闭 = 跳过导入）', () => {
    render(<SkillEditorModal {...baseProps} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(baseProps.discover.applyDiscoverImport).toHaveBeenCalledWith('skip');
  });

  it('全启 / 启用所选分别触发对应模式', () => {
    render(<SkillEditorModal {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: '全部启用 2 个新技能' }));
    expect(baseProps.discover.applyDiscoverImport).toHaveBeenCalledWith('all');
    fireEvent.click(screen.getByRole('button', { name: '启用所选新技能' }));
    expect(baseProps.discover.applyDiscoverImport).toHaveBeenCalledWith('selected');
  });
});
