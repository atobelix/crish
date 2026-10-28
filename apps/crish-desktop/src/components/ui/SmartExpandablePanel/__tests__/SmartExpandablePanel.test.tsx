// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SmartExpandablePanel } from '../SmartExpandablePanel';
import { MenuAdapter } from '../adapters/MenuAdapter';
import { SelectAdapter } from '../adapters/SelectAdapter';
import { Dialog } from '../../Dialog/Dialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SmartExpandablePanel 工业级架构魔鬼用例与核心交互', () => {
  // DEVIL-01: 触发器挂载与坐标测试
  it('DEVIL-01 [Trigger Mount]: 触发器克隆与挂载正常工作，浮层正常弹出', async () => {
    render(
      <MenuAdapter
        trigger={<button type="button">独立触发器</button>}
        options={[{ id: '1', label: '项一' }]}
      />
    );
    const btn = screen.getByText('独立触发器');
    fireEvent.click(btn);
    const item = await screen.findByRole('menuitem', { name: /项一/ });
    expect(item).toBeInTheDocument();
  });

  // DEVIL-02: Dialog 模态层叠上下文穿透测试
  it('DEVIL-02 [Dialog Overlay Containment]: 在 Dialog 内部展开时，浮层必须 Portal 进 DialogOverlay 容器', async () => {
    render(
      <Dialog open onClose={() => {}} title="测试弹窗">
        <SmartExpandablePanel open items={[{ id: '1', label: '测试项' }]} />
      </Dialog>
    );
    const item = await screen.findByText('测试项');
    const overlay = document.querySelector('[data-dialog-overlay]');
    expect(overlay).toBeTruthy();
    expect(overlay!.contains(item)).toBe(true);
  });

  // DEVIL-03: children 模式下的 WAI-ARIA 容器契约完整性测试
  it('DEVIL-03 [A11y Role Integrity]: 无论使用 items 还是 children，浮层容器必须具备标准 role="menu"', async () => {
    const { rerender } = render(
      <SmartExpandablePanel open items={[{ id: '1', label: '项' }]} />
    );
    expect(screen.getByRole('menu')).toBeInTheDocument();

    rerender(
      <SmartExpandablePanel open items={[]}>
        <div role="menuitem">自定义子项</div>
      </SmartExpandablePanel>
    );
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  // DEVIL-04: SelectAdapter 的 combobox / listbox / option 语义一致性
  it('DEVIL-04 [SelectAdapter A11y]: SelectAdapter 必须严格维持 listbox 语义，绝不能篡改为 menu', async () => {
    render(
      <SelectAdapter options={[{ id: 'opt1', label: '选项一' }]} value="opt1" />
    );
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    const option = await screen.findByRole('option', { name: /选项一/ });
    expect(option).toHaveAttribute('aria-selected', 'true');
  });

  // DEVIL-05: 顶置输入框与键盘漫游回车键冲突判定
  it('DEVIL-05 [Search Input Enter Immunity]: 在搜索/自定义输入框按 Enter 时，严禁误触发列表项选中', async () => {
    const onSelect = vi.fn();
    render(
      <SmartExpandablePanel
        open
        enableSearch
        items={[{ id: 'item1', label: '默认高亮项' }]}
        onSelect={onSelect}
      />
    );
    const searchInput = screen.getByPlaceholderText(/搜索/);
    fireEvent.change(searchInput, { target: { value: '自定义内容' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'item1' })
    );
  });

  // DEVIL-06: 列表尾部操作按钮点击冒泡隔离测试
  it('DEVIL-06 [Trailing Action Bubble Isolation]: 点击条目尾部删除按钮，绝不能触发父级 onSelect', async () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(
      <SmartExpandablePanel
        open
        items={[
          {
            id: 'proj1',
            label: '项目一',
            onSelect,
            trailingAction: (
              <button type="button" onClick={onDelete}>
                删除
              </button>
            ),
          },
        ]}
      />
    );
    const deleteBtn = screen.getByText('删除');
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('支持搜索实时过滤列表项', () => {
    render(
      <SmartExpandablePanel
        open
        enableSearch
        items={[
          { id: '1', label: 'Claude 3.5 Sonnet' },
          { id: '2', label: 'GPT-4o' },
        ]}
      />
    );
    expect(screen.getByText('Claude 3.5 Sonnet')).toBeInTheDocument();
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText(/搜索/);
    fireEvent.change(searchInput, { target: { value: 'gpt' } });

    expect(screen.queryByText('Claude 3.5 Sonnet')).not.toBeInTheDocument();
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
  });

  it('支持手风琴折叠展开与 onToggle 回调', () => {
    const onToggle = vi.fn();
    render(
      <SmartExpandablePanel
        open
        items={[
          {
            id: 'folder1',
            type: 'collapsible',
            label: '高级设置',
            onToggle,
            children: [{ id: 'sub1', label: '子配置项' }],
          },
        ]}
      />
    );
    const trigger = screen.getByText('高级设置');
    fireEvent.click(trigger);
    expect(screen.getByText('子配置项')).toBeInTheDocument();
    expect(onToggle).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: 'folder1' })
    );
  });
});
