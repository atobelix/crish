/**
 * ModelsSettingsTab「添加服务商」菜单（ui/Menu 基座迁移版）交互测试：
 * 打开/选择/Esc/键盘漫游/全局类依赖已清除（module 类渲染）
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { AddProviderMenu } from './ModelsSettingsTab';

function Wrapper({
  onAddTemplate,
  onAddPreset,
}: {
  onAddTemplate?: (format: 'openai' | 'anthropic') => void;
  onAddPreset?: (preset: { id: string; name: string }) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  return (
    <AddProviderMenu
      addOpen={addOpen}
      setAddOpen={setAddOpen}
      onAddTemplate={(f) => {
        // 模拟 useModelProfilesState：选中模板后由内部 setAddOpen(false) 关闭
        onAddTemplate?.(f);
        setAddOpen(false);
      }}
      onAddPreset={(p) => {
        onAddPreset?.(p);
        setAddOpen(false);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AddProviderMenu（ui/Menu 基座）', () => {
  it('点击「添加服务商」打开菜单并渲染模板与常用服务', async () => {
    render(<Wrapper />);
    fireEvent.click(screen.getByRole('button', { name: '添加服务商' }));
    expect(await screen.findByText('接口类型')).toBeInTheDocument();
    expect(screen.getByText('OpenAI 格式')).toBeInTheDocument();
    expect(screen.getByText('Anthropic 格式')).toBeInTheDocument();
    // 常用服务（PRESETS）渲染为 menuitem
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(2);
  });

  it('点击模板项触发 onAddTemplate 并关闭', async () => {
    const onAddTemplate = vi.fn();
    render(<Wrapper onAddTemplate={onAddTemplate} />);
    fireEvent.click(screen.getByRole('button', { name: '添加服务商' }));
    fireEvent.click(await screen.findByText('OpenAI 格式'));
    expect(onAddTemplate).toHaveBeenCalledWith('openai');
    await waitFor(() => expect(screen.queryByText('接口类型')).not.toBeInTheDocument());
  });

  it('Esc 关闭菜单', async () => {
    render(<Wrapper />);
    fireEvent.click(screen.getByRole('button', { name: '添加服务商' }));
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('键盘漫游：ArrowDown 聚焦首项并可用 Enter 触发', async () => {
    const onAddTemplate = vi.fn();
    render(<Wrapper onAddTemplate={onAddTemplate} />);
    fireEvent.click(screen.getByRole('button', { name: '添加服务商' }));
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getAllByRole('menuitem')[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onAddTemplate).toHaveBeenCalled();
  });

  it('不再使用全局 sort-filter-menu / settings-select-trigger 类', async () => {
    render(<Wrapper />);
    fireEvent.click(screen.getByRole('button', { name: '添加服务商' }));
    // Radix 浮层内容（role=dialog）承载面板形态类
    const dialog = (await screen.findByRole('dialog')).parentElement;
    expect(dialog?.className ?? '').not.toContain('sort-filter-menu');
    expect(screen.getByRole('button', { name: '添加服务商' }).className).not.toContain(
      'settings-select-trigger'
    );
  });
});
