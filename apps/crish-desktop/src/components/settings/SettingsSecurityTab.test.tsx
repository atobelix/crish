// @vitest-environment jsdom
/**
 * SettingsSecurityTab 用户视角测试：权限模式切换、工作区路径列表（折叠/展开）、
 * 信任命令（批准记忆）的添加 / 预设 / 去重 / 移除 / 二次确认清空，以及失败提示。
 * 使用真实 permissionStore（持久化落 jsdom localStorage）与真实 ToastProvider，
 * 不 mock 被测组件及其子组件。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { SettingsSecurityTab } from './SettingsSecurityTab';
import { ToastProvider, ToastStore } from '../../services/toast';
import { usePermissionStore } from '../../store/permissionStore';
import { COMMAND_PERMISSIONS_STORAGE_KEY } from '../../api/commandPermissions';
import { PERMISSION_MODE_STORAGE_KEY } from '../../api/permissionModes';

function renderTab() {
  return render(
    <ToastProvider>
      <SettingsSecurityTab />
    </ToastProvider>
  );
}

/** 模块加载时的真实 actions；个别用例会替换成抛错版本，每个用例前还原 */
const REAL_ACTIONS = (() => {
  const s = usePermissionStore.getState();
  return {
    setPermissionMode: s.setPermissionMode,
    addCommandPermission: s.addCommandPermission,
    removeCommandPermission: s.removeCommandPermission,
    setCommandPermissions: s.setCommandPermissions,
  };
})();

function resetStore(commands: string[] = [], mode: 'ask' | 'full' = 'ask') {
  usePermissionStore.setState({
    ...REAL_ACTIONS,
    permissionMode: mode,
    planModeEnabled: false,
    planApproved: false,
    commandPermissions: commands,
  });
}

function seedProjects(paths: string[]) {
  localStorage.setItem(
    'crish_projects_v1',
    JSON.stringify(
      paths.map((p, i) => ({
        id: `p${i}`,
        name: p,
        path: p,
        addedAt: i,
        // listProjects 按 lastOpenedAt 降序：让数组顺序即展示顺序
        lastOpenedAt: 1000 - i,
      }))
    )
  );
}

function cmdInput(): HTMLInputElement {
  return screen.getByRole('textbox', {
    name: '要信任的命令',
  }) as HTMLInputElement;
}

function addButton(): HTMLElement {
  return screen.getByRole('button', { name: '添加命令' });
}

function trustedListHeading(count: number) {
  return screen.getByText(`已信任命令 (${count})`);
}

function storedCommands(): string[] {
  return JSON.parse(
    localStorage.getItem(COMMAND_PERMISSIONS_STORAGE_KEY) ?? '[]'
  );
}

function errorToasts(): string[] {
  return ToastStore.getToasts()
    .filter((t) => t.type === 'error')
    .map((t) => String(t.message));
}

beforeEach(() => {
  localStorage.clear();
  resetStore();
});

afterEach(() => {
  cleanup();
  for (const toast of ToastStore.getToasts()) ToastStore.dismiss(toast.id);
  localStorage.clear();
});

describe('SettingsSecurityTab 权限模式', () => {
  it('选择器展示当前模式，切换后写入 store 与本地持久化', async () => {
    renderTab();
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('需确认');

    fireEvent.click(trigger);
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: /完全访问/ }));

    expect(usePermissionStore.getState().permissionMode).toBe('full');
    expect(localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)).toBe('full');
    expect(screen.getByRole('combobox')).toHaveTextContent('完全访问');
  });

  it('store 中的非法模式值在界面上回落为「需确认」', () => {
    usePermissionStore.setState({
      permissionMode: 'garbage' as unknown as 'ask',
    });
    renderTab();
    expect(screen.getByRole('combobox')).toHaveTextContent('需确认');
  });

  it('选择与当前相同的模式不触发写入', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: /需确认/ }));
    expect(localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)).toBeNull();
    expect(usePermissionStore.getState().permissionMode).toBe('ask');
  });
});

describe('SettingsSecurityTab 工作区', () => {
  it('没有工作区也没有项目时显示空态', () => {
    renderTab();
    expect(screen.getByText('未打开项目')).toBeInTheDocument();
    expect(screen.getByText('打开项目后会显示在这里')).toBeInTheDocument();
  });

  it('设置了当前工作区时只展示它（叶名 + 完整路径）', () => {
    localStorage.setItem('crish_workspace', 'C:\\work\\alpha');
    seedProjects(['/home/me/beta']);
    renderTab();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('C:\\work\\alpha')).toBeInTheDocument();
    expect(screen.queryByText('beta')).toBeNull();
    expect(screen.queryByText('未打开项目')).toBeNull();
  });

  it('超过 5 个项目时折叠，点击「+N 更多」展开、「折叠」收起', () => {
    const paths = Array.from({ length: 7 }, (_, i) => `/repo/proj${i + 1}`);
    seedProjects(paths);
    renderTab();

    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(`proj${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByText('proj6')).toBeNull();
    expect(screen.queryByText('proj7')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+2 更多' }));
    expect(screen.getByText('proj6')).toBeInTheDocument();
    expect(screen.getByText('proj7')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+2 更多' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '折叠' }));
    expect(screen.queryByText('proj6')).toBeNull();
    expect(screen.getByRole('button', { name: '+2 更多' })).toBeInTheDocument();
  });

  it('恰好 5 个项目时全部展示且没有展开按钮', () => {
    seedProjects(Array.from({ length: 5 }, (_, i) => `/repo/p${i + 1}`));
    renderTab();
    expect(screen.getByText('p5')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /更多/ })).toBeNull();
  });
});

describe('SettingsSecurityTab 信任命令', () => {
  it('空白名单显示空态，添加按钮在输入为空（或仅空白）时禁用', () => {
    renderTab();
    expect(trustedListHeading(0)).toBeInTheDocument();
    expect(screen.getByText('还没有信任的命令')).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    fireEvent.change(cmdInput(), { target: { value: '   ' } });
    expect(addButton()).toBeDisabled();
    // 空白名单没有「清空」入口
    expect(screen.queryByRole('button', { name: /清空全部/ })).toBeNull();
  });

  it('点击添加：规范化空白后加入列表、持久化，并清空输入框', () => {
    renderTab();
    fireEvent.change(cmdInput(), { target: { value: '  cargo   build  ' } });
    expect(addButton()).toBeEnabled();
    fireEvent.click(addButton());

    expect(trustedListHeading(1)).toBeInTheDocument();
    expect(screen.getByText('cargo build')).toBeInTheDocument();
    expect(storedCommands()).toEqual(['cargo build']);
    expect(cmdInput()).toHaveValue('');
    expect(screen.queryByText('还没有信任的命令')).toBeNull();
  });

  it('回车添加同样加入列表并清空输入框', () => {
    renderTab();
    fireEvent.change(cmdInput(), { target: { value: 'make test' } });
    fireEvent.keyDown(cmdInput(), { key: 'Enter' });

    expect(screen.getByText('make test')).toBeInTheDocument();
    expect(usePermissionStore.getState().commandPermissions).toEqual([
      'make test',
    ]);
    expect(cmdInput()).toHaveValue('');
  });

  it('Esc 清空草稿但不添加', () => {
    renderTab();
    fireEvent.change(cmdInput(), { target: { value: 'ls -la' } });
    fireEvent.keyDown(cmdInput(), { key: 'Escape' });
    expect(cmdInput()).toHaveValue('');
    expect(usePermissionStore.getState().commandPermissions).toEqual([]);
  });

  it('大小写不同的重复命令不会再次加入', () => {
    resetStore(['git status']);
    renderTab();
    fireEvent.change(cmdInput(), { target: { value: 'GIT  STATUS' } });
    fireEvent.click(addButton());
    expect(usePermissionStore.getState().commandPermissions).toEqual([
      'git status',
    ]);
    expect(trustedListHeading(1)).toBeInTheDocument();
  });

  it('只含提示符的输入视为无效命令并给出错误提示', () => {
    renderTab();
    fireEvent.change(cmdInput(), { target: { value: '$' } });
    fireEvent.click(addButton());
    expect(errorToasts()).toContain('无效命令');
    expect(usePermissionStore.getState().commandPermissions).toEqual([]);
  });

  it('常用预设：点击加入，已加入的预设变为禁用且 aria-pressed', () => {
    resetStore(['git status']);
    renderTab();
    const added = screen.getByRole('button', { name: 'git status 已添加' });
    expect(added).toBeDisabled();
    expect(added).toHaveAttribute('aria-pressed', 'true');

    const preset = screen.getByRole('button', { name: '添加 npm test' });
    expect(preset).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(preset);

    expect(
      screen.getByRole('button', { name: 'npm test 已添加' })
    ).toBeDisabled();
    expect(storedCommands()).toEqual(['git status', 'npm test']);
    // 预设添加不影响输入框里的草稿
    expect(cmdInput()).toHaveValue('');
  });

  it('列表按中文排序去重展示，点击移除删掉对应命令', () => {
    resetStore(['npm test', 'git diff', 'Git Diff']);
    renderTab();
    expect(trustedListHeading(2)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '移除 git diff' }));
    expect(trustedListHeading(1)).toBeInTheDocument();
    expect(usePermissionStore.getState().commandPermissions).toEqual([
      'npm test',
    ]);
    expect(storedCommands()).toEqual(['npm test']);
  });

  it('清空需二次确认：取消保留列表，确认后清空', () => {
    resetStore(['git log', 'npm test']);
    renderTab();

    fireEvent.click(
      screen.getByRole('button', { name: '清空全部 2 条白名单' })
    );
    expect(
      screen.getByText('确定清除所有白名单命令？此操作不可撤销')
    ).toBeInTheDocument();
    // 确认态下隐藏「清空」入口
    expect(screen.queryByRole('button', { name: /清空全部/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(
      screen.queryByText('确定清除所有白名单命令？此操作不可撤销')
    ).toBeNull();
    expect(trustedListHeading(2)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: '清空全部 2 条白名单' })
    );
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(trustedListHeading(0)).toBeInTheDocument();
    expect(usePermissionStore.getState().commandPermissions).toEqual([]);
    expect(storedCommands()).toEqual([]);
    expect(
      screen.queryByText('确定清除所有白名单命令？此操作不可撤销')
    ).toBeNull();
  });

  it('store 写入抛错时分别提示添加 / 移除 / 清空失败', () => {
    resetStore(['git log']);
    usePermissionStore.setState({
      addCommandPermission: () => {
        throw new Error('quota');
      },
      removeCommandPermission: () => {
        throw new Error('locked');
      },
      setCommandPermissions: () => {
        throw new Error('busy');
      },
    });
    renderTab();

    fireEvent.change(cmdInput(), { target: { value: 'pnpm lint' } });
    fireEvent.click(addButton());
    fireEvent.click(screen.getByRole('button', { name: '移除 git log' }));
    fireEvent.click(
      screen.getByRole('button', { name: '清空全部 1 条白名单' })
    );
    fireEvent.click(screen.getByRole('button', { name: '确认' }));

    const msgs = errorToasts();
    expect(msgs.some((m) => m.includes('quota'))).toBe(true);
    expect(msgs.some((m) => m.includes('locked'))).toBe(true);
    expect(msgs.some((m) => m.includes('busy'))).toBe(true);
    // 添加失败时保留草稿，便于用户重试
    expect(cmdInput()).toHaveValue('pnpm lint');
  });
});
