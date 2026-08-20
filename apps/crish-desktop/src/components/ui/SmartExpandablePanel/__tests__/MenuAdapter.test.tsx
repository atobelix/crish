// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
} from '@testing-library/react';
import { MenuAdapter } from '../adapters/MenuAdapter';
import { Dialog } from '../../Dialog/Dialog';
import { layerStackService } from '../../internal/layer-stack/LayerStackService';
import styles from '../../Menu/Menu.module.css';

const TRIGGER_TEXT = 'MenuAdapter 触发器';

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  vi.restoreAllMocks();
});

describe('MenuAdapter 单元与兼容性测试', () => {
  it('点击触发器正常展开面板并渲染选项', async () => {
    render(
      <MenuAdapter
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        options={[{ id: '1', label: '项一' }]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const item = await screen.findByRole('menuitem', { name: /项一/ });
    expect(item).toBeInTheDocument();
  });

  it('菜单项带 disabled 与 danger 语义类', async () => {
    render(
      <MenuAdapter
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        options={[
          { id: '1', label: '正常项' },
          { id: '2', label: '禁用项', disabled: true },
          { id: '3', label: '危险项', danger: true },
        ]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const normal = await screen.findByRole('menuitem', { name: /正常项/ });
    const disabled = screen.getByRole('menuitem', { name: /禁用项/ });
    const danger = screen.getByRole('menuitem', { name: /危险项/ });

    expect(disabled).toBeDisabled();
    expect(disabled).toHaveClass(styles.menuItemDisabled);
    expect(danger).toHaveClass(styles.menuItemDanger);
    expect(normal).not.toHaveClass(styles.menuItemDanger);
  });

  it('点击选项无损触发 (id, option) 双参数签名回调', async () => {
    const onSelect = vi.fn();
    render(
      <MenuAdapter
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        onSelect={onSelect}
        options={[
          { id: 'a', label: '选项甲' },
          { id: 'b', label: '选项乙' },
        ]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const item = await screen.findByRole('menuitem', { name: /选项乙/ });
    fireEvent.click(item);

    expect(onSelect).toHaveBeenCalledWith(
      'b',
      expect.objectContaining({ id: 'b', label: '选项乙' })
    );
  });

  it('DialogOverlayContext 模态层穿透：Dialog 内部展开挂载到 overlay 容器', async () => {
    render(
      <Dialog open onClose={() => {}} title="测试弹窗">
        <MenuAdapter
          trigger={<button type="button">{TRIGGER_TEXT}</button>}
          options={[{ id: '1', label: '弹窗项' }]}
        />
      </Dialog>
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const item = await screen.findByRole('menuitem', { name: /弹窗项/ });
    const overlay = document.querySelector('[data-dialog-overlay]');
    expect(overlay).toBeTruthy();
    expect(overlay?.contains(item)).toBe(true);
    expect(item.parentElement).not.toBe(document.body);
  });

  it('children 模式容器带 role="menu"，并且支持自定义子项', async () => {
    render(
      <MenuAdapter trigger={<button type="button">{TRIGGER_TEXT}</button>}>
        <button type="button" role="menuitem">
          自定义子项
        </button>
      </MenuAdapter>
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const menuContainer = await screen.findByRole('menu');
    expect(menuContainer).toBeInTheDocument();
    const item = screen.getByRole('menuitem', { name: /自定义子项/ });
    expect(item).toBeInTheDocument();
  });
});
