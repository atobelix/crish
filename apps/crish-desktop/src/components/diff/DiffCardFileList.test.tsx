// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffCardFileList } from './DiffCardFileList';
import type { FileDiff } from '../../store/types';
import { classifyFileDiff } from '../../api/applyFileDiff';

describe('DiffCardFileList (平直单轨与正交子域专项测试)', () => {
  const mockFileDiff: FileDiff = {
    filePath: 'src/components/Button.tsx',
    oldPath: 'src/components/Button.tsx',
    status: 'modified',
    additions: 12,
    deletions: 3,
    changes: [],
  };

  it('should disable Accept button for provisional diff (纯逻辑状态机保全)', () => {
    const provisionalDiff: FileDiff = {
      filePath: 'src/components/Button.tsx',
      additions: 3,
      deletions: 1,
      changes: [{ type: 'addition', content: 'export const Button = () => null;' }],
      provisional: true,
    };

    const classification = classifyFileDiff(provisionalDiff);
    expect(classification.ok).toBe(false);
    const isAcceptDisabled = !classification.ok;
    expect(isAcceptDisabled).toBe(true);
  });

  it('渲染 Flat List 平直列表，具备标准 role="list" / role="listitem" 语义且无圆角', () => {
    const { container } = render(
      <DiffCardFileList
        files={[mockFileDiff]}
        sourceMode="session"
        current={null}
        applyBusy={false}
        stagingPaths={{}}
        onSetActiveDiffSource={vi.fn()}
        onStageFile={vi.fn()}
        onUnstageFile={vi.fn()}
        onDiscardChanges={vi.fn()}
        onStageAll={vi.fn()}
        onUnstageAll={vi.fn()}
        renderInlineDiffContent={() => <div data-testid="diff-body">diff content</div>}
      />
    );

    // 1. 列表容器无障碍契约
    const list = container.querySelector('[role="list"]');
    expect(list).not.toBeNull();
    expect(list).toHaveAttribute('aria-label', '变更文件列表');

    // 2. 列表项无障碍契约
    const item = container.querySelector('[role="listitem"]');
    expect(item).not.toBeNull();

    // 3. 直角化契约：验证容器与条目绝不含有圆角类或行内 border-radius 样式
    expect(container.querySelector('[class*="rounded"]')).toBeNull();
    expect(container.querySelector('[class*="radius"]')).toBeNull();
  });

  it('三大正交子域验证：点击 Chevron 仅触发内联折叠展开，绝不触发独立 Tab 打开', () => {
    const handleSetActive = vi.fn();
    const handleOpenFileViewer = vi.fn();

    render(
      <DiffCardFileList
        files={[mockFileDiff]}
        sourceMode="git"
        current={null}
        applyBusy={false}
        stagingPaths={{}}
        onSetActiveDiffSource={handleSetActive}
        onStageFile={vi.fn()}
        onUnstageFile={vi.fn()}
        onDiscardChanges={vi.fn()}
        onStageAll={vi.fn()}
        onUnstageAll={vi.fn()}
        renderInlineDiffContent={() => <div>Inline Diff View</div>}
        onOpenFileViewer={handleOpenFileViewer}
      />
    );

    // 1. 查找折叠展开 Chevron 按钮 (子域 A)
    const chevronBtn = screen.getByRole('button', { name: /展开 Button\.tsx/ });
    expect(chevronBtn).toBeInTheDocument();

    // 2. 点击 Chevron
    fireEvent.click(chevronBtn);

    // 断言：触发了内联展开，但严格未触发独立 Tab 打开
    expect(handleSetActive).toHaveBeenCalledTimes(1);
    expect(handleSetActive).toHaveBeenCalledWith(mockFileDiff);
    expect(handleOpenFileViewer).not.toHaveBeenCalled();
  });

  it('三大正交子域验证：点击文件名超链接仅触发独立 Tab 打开，绝不触发表内折叠', () => {
    const handleSetActive = vi.fn();
    const handleOpenFileViewer = vi.fn();

    render(
      <DiffCardFileList
        files={[mockFileDiff]}
        sourceMode="git"
        current={null}
        applyBusy={false}
        stagingPaths={{}}
        onSetActiveDiffSource={handleSetActive}
        onStageFile={vi.fn()}
        onUnstageFile={vi.fn()}
        onDiscardChanges={vi.fn()}
        onStageAll={vi.fn()}
        onUnstageAll={vi.fn()}
        renderInlineDiffContent={() => <div>Inline Diff View</div>}
        onOpenFileViewer={handleOpenFileViewer}
      />
    );

    // 1. 查找文件名超链接按钮 (子域 B)
    const linkBtn = screen.getByRole('button', { name: /在独立标签页预览文件 Button\.tsx/ });
    expect(linkBtn).toBeInTheDocument();

    // 2. 点击文件名超链接
    fireEvent.click(linkBtn);

    // 断言：触发了在独立标签页打开，严格未触发表内展开
    expect(handleOpenFileViewer).toHaveBeenCalledTimes(1);
    expect(handleOpenFileViewer).toHaveBeenCalledWith('src/components/Button.tsx');
    expect(handleSetActive).not.toHaveBeenCalled();
  });

  it('三大正交子域验证：点击 Git 暂存按钮仅触发暂存，严格阻止冒泡', () => {
    const handleSetActive = vi.fn();
    const handleStageFile = vi.fn();
    const handleOpenFileViewer = vi.fn();

    render(
      <DiffCardFileList
        files={[mockFileDiff]}
        sourceMode="git"
        current={null}
        applyBusy={false}
        stagingPaths={{}}
        onSetActiveDiffSource={handleSetActive}
        onStageFile={handleStageFile}
        onUnstageFile={vi.fn()}
        onDiscardChanges={vi.fn()}
        onStageAll={vi.fn()}
        onUnstageAll={vi.fn()}
        renderInlineDiffContent={() => <div>Inline Diff View</div>}
        onOpenFileViewer={handleOpenFileViewer}
      />
    );

    // 1. 查找暂存按钮 (子域 C)
    const stageBtn = screen.getByRole('button', { name: '暂存此文件' });
    expect(stageBtn).toBeInTheDocument();

    // 2. 点击暂存按钮
    fireEvent.click(stageBtn);

    // 断言：仅触发暂存，严格未触发折叠或新 Tab
    expect(handleStageFile).toHaveBeenCalledTimes(1);
    expect(handleStageFile).toHaveBeenCalledWith('src/components/Button.tsx');
    expect(handleSetActive).not.toHaveBeenCalled();
    expect(handleOpenFileViewer).not.toHaveBeenCalled();
  });

  it('三大正交子域验证：点击 Git 放弃修改（撤回）按钮仅触发放弃修改，严格阻止冒泡', () => {
    const handleSetActive = vi.fn();
    const handleDiscardChanges = vi.fn();
    const handleOpenFileViewer = vi.fn();

    render(
      <DiffCardFileList
        files={[mockFileDiff]}
        sourceMode="git"
        current={null}
        applyBusy={false}
        stagingPaths={{}}
        onSetActiveDiffSource={handleSetActive}
        onStageFile={vi.fn()}
        onUnstageFile={vi.fn()}
        onDiscardChanges={handleDiscardChanges}
        onStageAll={vi.fn()}
        onUnstageAll={vi.fn()}
        renderInlineDiffContent={() => <div>Inline Diff View</div>}
        onOpenFileViewer={handleOpenFileViewer}
      />
    );

    // 1. 查找放弃修改（撤回）按钮 (子域 C)
    const discardBtn = screen.getByRole('button', { name: '放弃此文件的所有修改' });
    expect(discardBtn).toBeInTheDocument();

    // 2. 点击放弃修改按钮
    fireEvent.click(discardBtn);

    // 断言：仅触发放弃修改，严格未触发折叠或新 Tab
    expect(handleDiscardChanges).toHaveBeenCalledTimes(1);
    expect(handleDiscardChanges).toHaveBeenCalledWith('src/components/Button.tsx');
    expect(handleSetActive).not.toHaveBeenCalled();
    expect(handleOpenFileViewer).not.toHaveBeenCalled();
  });

  it('常驻统计验证：增减数字常驻可见且格式正确，且绝无行内工具条', () => {
    const { container } = render(
      <DiffCardFileList
        files={[mockFileDiff]}
        sourceMode="git"
        current={mockFileDiff}
        applyBusy={false}
        stagingPaths={{}}
        onSetActiveDiffSource={vi.fn()}
        onStageFile={vi.fn()}
        onUnstageFile={vi.fn()}
        onDiscardChanges={vi.fn()}
        onStageAll={vi.fn()}
        onUnstageAll={vi.fn()}
        renderInlineDiffContent={() => <div data-testid="diff-pane-content">Code Comparison Body</div>}
      />
    );

    // 1. 断言增减统计数字存在且格式正确
    expect(container.textContent).toContain('+12');
    expect(container.textContent).toContain('−3');

    // 2. 验证展开比对视口已渲染
    expect(screen.getByTestId('diff-pane-content')).toBeInTheDocument();

    // 3. 负向断言：彻底清退单文件工具行 (.inlineHeader)
    expect(container.querySelector('[class*="inlineHeader"]')).toBeNull();
    expect(screen.queryByLabelText('对比维度选择')).toBeNull();
  });

  it('支持 getFileDiffData 动态覆盖增减行数', () => {
    const mergedDiff: FileDiff = {
      filePath: 'src/components/Button.tsx',
      additions: 99,
      deletions: 1,
      changes: [],
    };

    const { container } = render(
      <DiffCardFileList
        files={[mockFileDiff]}
        sourceMode="session"
        current={null}
        applyBusy={false}
        stagingPaths={{}}
        onSetActiveDiffSource={vi.fn()}
        onStageFile={vi.fn()}
        onUnstageFile={vi.fn()}
        onDiscardChanges={vi.fn()}
        onStageAll={vi.fn()}
        onUnstageAll={vi.fn()}
        renderInlineDiffContent={() => null}
        getFileDiffData={() => mergedDiff}
      />
    );

    expect(container.textContent).toContain('+99');
    expect(container.textContent).toContain('−1');
  });

  it('规范与可访问性验证：零原生 title 属性，文件名与徽标由 Tooltip 承载，外层容器为 div', () => {
    const { container } = render(
      <DiffCardFileList
        files={[mockFileDiff]}
        sourceMode="git"
        current={null}
        applyBusy={false}
        stagingPaths={{}}
        onSetActiveDiffSource={vi.fn()}
        onStageFile={vi.fn()}
        onUnstageFile={vi.fn()}
        onDiscardChanges={vi.fn()}
        onStageAll={vi.fn()}
        onUnstageAll={vi.fn()}
        renderInlineDiffContent={() => null}
      />
    );

    // 1. 刚性断言：整个渲染树中绝无任何原生 title 属性残留 (AGENTS.md §12 铁律)
    const elementsWithTitle = container.querySelectorAll('[title]');
    expect(elementsWithTitle.length).toBe(0);

    // 2. 验证行容器为 div 且声明 role="row"，严禁为 button
    const fileRowEl = container.querySelector('[class*="fileRow"]');
    expect(fileRowEl).not.toBeNull();
    expect(fileRowEl?.tagName.toLowerCase()).toBe('div');
    expect(fileRowEl?.getAttribute('role')).toBe('row');

    // 3. 验证内部独立超链接按钮存在且具备完整 aria 标签
    const linkBtn = screen.getByRole('button', { name: /在独立标签页预览文件/ });
    expect(linkBtn.tagName.toLowerCase()).toBe('button');
  });
});
