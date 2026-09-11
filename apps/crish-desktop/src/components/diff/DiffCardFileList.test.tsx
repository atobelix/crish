// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DiffCardFileList } from './DiffCardFileList';
import type { FileDiff } from '../../store/types';
import { classifyFileDiff } from '../../api/applyFileDiff';
import { ToastStore } from '../../services/toast/ToastStore';

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

  it('三大正交子域验证：暂存旁边紧邻包含复制差异 Patch 按钮，点击触发剪贴板复制与 Toast 提示', async () => {
    const handleSetActive = vi.fn();
    const handleOpenFileViewer = vi.fn();
    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextSpy,
      },
    });

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
        renderInlineDiffContent={() => null}
        onOpenFileViewer={handleOpenFileViewer}
      />
    );

    // 1. 查找复制差异 Patch 按钮
    const copyBtn = screen.getByRole('button', { name: '复制此文件差异 Patch' });
    expect(copyBtn).toBeInTheDocument();
    expect(copyBtn).toHaveAttribute('data-size', 'xs');
    expect(copyBtn).toHaveAttribute('data-variant', 'ghost');

    const showSpy = vi.spyOn(ToastStore, 'show');

    // 2. 点击复制按钮
    fireEvent.click(copyBtn);

    // 断言：触发了剪贴板写入与 Toast 提示，且阻止事件冒泡
    //（T24：写入经 await 后才提示，断言须等微任务完成）
    expect(writeTextSpy).toHaveBeenCalledTimes(1);
    expect(writeTextSpy.mock.calls[0][0]).toContain('diff --git a/src/components/Button.tsx');
    expect(handleSetActive).not.toHaveBeenCalled();
    expect(handleOpenFileViewer).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(showSpy).toHaveBeenCalledWith('已复制 Button.tsx 差异 Patch', undefined, undefined);
    });
    showSpy.mockRestore();
  });

  it('已暂存文件条目同样具备复制差异 Patch 按钮与取消暂存按钮', () => {
    const stagedDiff: FileDiff = {
      ...mockFileDiff,
      staged: true,
    };

    render(
      <DiffCardFileList
        files={[stagedDiff]}
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

    expect(screen.getByRole('button', { name: '复制此文件差异 Patch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消暂存此文件' })).toBeInTheDocument();
  });

  it('行操作区全面换装原子组件 <IconButton size="xs" variant="ghost">，常态中性且无私有黑混色', () => {
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

    const rowActions = container.querySelector('[class*="rowActions"]');
    expect(rowActions).toBeInTheDocument();

    const buttons = rowActions!.querySelectorAll('button');
    expect(buttons.length).toBe(3); // Stage, Copy, Discard

    for (const btn of Array.from(buttons)) {
      expect(btn.className).toContain('iconButton');
      expect(btn).toHaveAttribute('data-size', 'xs');
      expect(btn).toHaveAttribute('data-variant', 'ghost');
    }
  });

  it('子域 A 折叠与状态字母融合为单一 fileNodeToggle 槽位，彻底切除双元素并排与字母背景色（正向与负向物证）', () => {
    const handleSetActive = vi.fn();
    const { container } = render(
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
        renderInlineDiffContent={() => null}
      />
    );

    // 1. 查找合并后的单槽位按钮
    const toggleBtn = container.querySelector('[class*="fileNodeToggle"]');
    expect(toggleBtn).toBeInTheDocument();
    expect(toggleBtn?.tagName).toBe('BUTTON');

    // 2. 验证单槽位内部同时嵌合了字母徽标与 Chevron 图标
    const badge = toggleBtn?.querySelector('[class*="statusBadge"]');
    const chevron = toggleBtn?.querySelector('[class*="chevronIcon"]');
    expect(badge).toBeInTheDocument();
    expect(badge?.textContent).toBe('M');
    expect(chevron).toBeInTheDocument();

    // 3. 负向断言：整行内绝无第二个并排的独立折叠按钮（原先独立的 chevronBtn 与 statusBadge 并排模式被物理切除）
    const fileRow = container.querySelector('[class*="fileRow"]');
    const allRowButtons = fileRow?.querySelectorAll(':scope > button');
    // 子域 A 只有 1 个 button，路径链接是第 2 个 button（在 pathWrap 内）
    expect(allRowButtons?.length).toBe(1);

    // 4. 点击单槽位按钮准确触发折叠展开切换
    fireEvent.click(toggleBtn!);
    expect(handleSetActive).toHaveBeenCalledTimes(1);
    expect(handleSetActive).toHaveBeenCalledWith(mockFileDiff);
  });
});
