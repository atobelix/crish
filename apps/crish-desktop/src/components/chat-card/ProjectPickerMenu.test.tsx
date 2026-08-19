// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ProjectPickerMenu } from './ProjectPickerMenu';
import * as projectStore from '../../api/projectStore';
import { openDirectoryDialogSafe } from '../../api/openDirectoryDialog';
import { layerStackService } from '../ui/internal/layer-stack/LayerStackService';
import menuStyles from '../ui/Menu/Menu.module.css';
import styles from './ProjectPickerMenu.module.css';

const here =
  typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

const PROJECTS_KEY = 'crish_projects_v1';
const ACTIVE_PROJECT_KEY = 'crish_active_project_id';

function seedProjects(): void {
  localStorage.setItem(
    PROJECTS_KEY,
    JSON.stringify([
      {
        id: 'proj-a',
        name: 'Alpha',
        path: 'C:/alpha',
        addedAt: 1,
        lastOpenedAt: 3,
      },
      {
        id: 'proj-b',
        name: 'Beta',
        path: 'C:/beta',
        addedAt: 1,
        lastOpenedAt: 2,
      },
    ])
  );
  localStorage.setItem(ACTIVE_PROJECT_KEY, 'proj-a');
}

function renderPicker(open = true) {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  render(
    <ProjectPickerMenu
      open={open}
      onOpenChange={onOpenChange}
      onChanged={onChanged}
    >
      <button type="button">选择项目</button>
    </ProjectPickerMenu>
  );
  return { onOpenChange, onChanged };
}

describe('ProjectPickerMenu / openDirectoryDialog', () => {
  it('should resolve via plugin-dialog helper without Function()/eval', async () => {
    const result = await openDirectoryDialogSafe('Test Title');
    expect(result).toBeNull();
  });
});

describe('ProjectPickerMenu（ui/Menu menuItem 皮）', () => {
  beforeEach(() => {
    localStorage.clear();
    seedProjects();
  });

  afterEach(() => {
    cleanup();
    layerStackService.dispose();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('源码不再引用已删的 sort-filter-* 全局类', () => {
    const tsx = readFileSync(join(here, 'ProjectPickerMenu.tsx'), 'utf8');
    const css = readFileSync(join(here, 'ProjectPickerMenu.module.css'), 'utf8');
    expect(tsx).not.toMatch(/sort-filter-/);
    expect(css).not.toMatch(/sort-filter-/);
    expect(css).toContain('--button-radius');
    expect(css).toContain('appearance: none');
  });

  it('面板走 Menu 壳 + menuItem，不带 sort-filter / no-drag', async () => {
    renderPicker(true);
    const menu = await screen.findByRole('menu', { name: '选择项目' });
    const panel = menu.parentElement as HTMLElement;
    expect(panel.className).toContain(styles.pickerPanel);
    expect(panel.className).toContain(menuStyles.menuContent);
    expect(panel.className).not.toContain('sort-filter-menu');
    expect(panel.className).not.toMatch(/\bno-drag\b/);
    expect(panel.className).not.toMatch(/(?:^|\s)open(?:\s|$)/);

    const alpha = screen.getByRole('menuitem', { name: 'Alpha' });
    expect(alpha.className).toContain(menuStyles.menuItem);
    expect(alpha.className).not.toContain('sort-filter-option');

    const trigger = screen.getByRole('button', { name: '选择项目' });
    expect(trigger.className).not.toMatch(/\bno-drag\b/);
  });

  it('能选项目并关闭', async () => {
    const openSpy = vi.spyOn(projectStore, 'openProject');
    const { onChanged, onOpenChange } = renderPicker(true);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Beta' }));
    expect(openSpy).toHaveBeenCalledWith('proj-b');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('能选通用项目', async () => {
    const noneSpy = vi.spyOn(projectStore, 'setNoProject');
    const { onChanged } = renderPicker(true);
    fireEvent.click(await screen.findByRole('menuitem', { name: '通用项目' }));
    expect(noneSpy).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('搜索过滤项目列表', async () => {
    renderPicker(true);
    await screen.findByRole('menuitem', { name: 'Alpha' });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索项目' }), {
      target: { value: 'Bet' },
    });
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Alpha' })).toBeNull();
  });

  it('添加项目级联项也走 menuItem', async () => {
    renderPicker(true);
    fireEvent.mouseEnter(
      await screen.findByRole('menuitem', { name: '添加项目' })
    );
    const openLocal = await screen.findByRole('menuitem', {
      name: '打开本地项目...',
    });
    expect(openLocal.className).toContain(menuStyles.menuItem);
    expect(openLocal.className).not.toContain('sort-filter-option');
    const cascade = screen.getByRole('menu', { name: '添加项目' });
    expect(cascade.className).toContain(menuStyles.menuContent);
  });

  it('受控关闭后面板卸掉', async () => {
    const { rerender } = render(
      <ProjectPickerMenu open={true} onOpenChange={vi.fn()}>
        <button type="button">选择项目</button>
      </ProjectPickerMenu>
    );
    expect(await screen.findByRole('menu', { name: '选择项目' })).toBeTruthy();
    rerender(
      <ProjectPickerMenu open={false} onOpenChange={vi.fn()}>
        <button type="button">选择项目</button>
      </ProjectPickerMenu>
    );
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: '选择项目' })).toBeNull();
    });
  });
});
