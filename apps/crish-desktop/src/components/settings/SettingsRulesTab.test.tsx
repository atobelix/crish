// @vitest-environment jsdom
/**
 * SettingsRulesTab 用户视角测试（壳组件 + 真实 useRulesState）：
 * 全局 / 项目作用域加载、快速添加（输入 / 预设 / 去重 / 空输入）、删除、全文编辑保存、
 * 读取失败与重试、写入失败提示。持久化走真实 clientApi（jsdom localStorage），
 * 只在需要制造 IO 失败时 spy 掉 clientApi 单个方法；提示走真实 ToastStore。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { SettingsRulesTab } from './SettingsRulesTab';
import { ToastProvider, ToastStore } from '../../services/toast';
import { clientApi } from '../../api/clientApi';

const PROJECT = 'C:/work/demo';
const PROJECT_KEY = `crish_project_settings_${PROJECT.toLowerCase()}`;

function seedGlobalRules(rules: string[]) {
  localStorage.setItem(
    'crish_settings',
    JSON.stringify({ customRules: rules })
  );
}

function seedProject(rules: string[]) {
  localStorage.setItem(
    'crish_projects_v1',
    JSON.stringify([
      { id: 'p1', name: 'demo', path: PROJECT, addedAt: 1, lastOpenedAt: 1 },
    ])
  );
  localStorage.setItem(PROJECT_KEY, JSON.stringify({ customRules: rules }));
}

function storedRules(key = 'crish_settings'): string[] {
  const raw = localStorage.getItem(key);
  return raw ? (JSON.parse(raw).customRules ?? []) : [];
}

function toastMessages(): string[] {
  return ToastStore.getToasts().map((t) => String(t.message));
}

function renderTab(onBlockingOverlayChange?: (open: boolean) => void) {
  return render(
    <ToastProvider>
      <SettingsRulesTab onBlockingOverlayChange={onBlockingOverlayChange} />
    </ToastProvider>
  );
}

async function renderLoaded(onBlocking?: (open: boolean) => void) {
  const utils = renderTab(onBlocking);
  await screen.findByRole('textbox', { name: '自定义规则' });
  return utils;
}

function ruleInput(): HTMLInputElement {
  return screen.getByRole('textbox', {
    name: '自定义规则',
  }) as HTMLInputElement;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const toast of ToastStore.getToasts()) ToastStore.dismiss(toast.id);
  localStorage.clear();
});

describe('SettingsRulesTab 加载', () => {
  it('全局作用域无规则时显示空态与作用域标题', async () => {
    await renderLoaded();
    expect(screen.getByText('当前规则 (全局)')).toBeInTheDocument();
    expect(screen.getByText('还没有规则')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveTextContent('全局');
  });

  it('展示已保存的全局规则（去重、去首尾空白）', async () => {
    seedGlobalRules(['  先写测试  ', '先写测试', '中文回复']);
    await renderLoaded();
    expect(screen.getByText('先写测试')).toBeInTheDocument();
    expect(screen.getByText('中文回复')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^删除规则：/ })).toHaveLength(
      2
    );
  });

  it('当前工作区是已知项目时默认进入项目作用域，只显示项目自己的规则', async () => {
    seedGlobalRules(['全局规则 A']);
    seedProject(['项目规则 B']);
    localStorage.setItem('crish_workspace', 'C:\\work\\demo');
    await renderLoaded();
    expect(screen.getByText('当前规则 (demo)')).toBeInTheDocument();
    expect(screen.getByText('项目规则 B')).toBeInTheDocument();
    expect(screen.queryByText('全局规则 A')).toBeNull();
  });

  it('切换作用域后重新加载对应规则', async () => {
    seedGlobalRules(['全局规则 A']);
    seedProject(['项目规则 B']);
    await renderLoaded();
    expect(screen.getByText('全局规则 A')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: /demo/ }));

    expect(await screen.findByText('项目规则 B')).toBeInTheDocument();
    expect(screen.queryByText('全局规则 A')).toBeNull();
    expect(screen.getByText('当前规则 (demo)')).toBeInTheDocument();
  });

  it('读取失败显示错误与重试，重试成功后进入正常列表', async () => {
    seedGlobalRules(['重试后可见']);
    const spy = vi
      .spyOn(clientApi, 'getSettingsEx')
      .mockRejectedValueOnce(new Error('disk gone'));
    renderTab();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('读取规则失败：Error: disk gone');
    expect(toastMessages()).toContain('读取规则失败：Error: disk gone');

    fireEvent.click(screen.getByRole('button', { name: '重新加载规则' }));
    expect(await screen.findByText('重试后可见')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('SettingsRulesTab 快速添加与删除', () => {
  it('输入规则后点击添加：写入全局设置、列表增长并清空输入框', async () => {
    await renderLoaded();
    const addBtn = screen.getByRole('button', { name: '添加规则' });
    expect(addBtn).toBeDisabled();

    fireEvent.change(ruleInput(), { target: { value: '  回答保持简洁  ' } });
    expect(addBtn).toBeEnabled();
    fireEvent.click(addBtn);

    expect(await screen.findByText('回答保持简洁')).toBeInTheDocument();
    await waitFor(() => expect(ruleInput()).toHaveValue(''));
    expect(storedRules()).toEqual(['回答保持简洁']);
    expect(screen.queryByText('还没有规则')).toBeNull();
  });

  it('回车同样添加规则', async () => {
    await renderLoaded();
    fireEvent.change(ruleInput(), { target: { value: '用中文注释' } });
    fireEvent.keyDown(ruleInput(), { key: 'Enter' });
    expect(await screen.findByText('用中文注释')).toBeInTheDocument();
    expect(storedRules()).toEqual(['用中文注释']);
  });

  it('重复规则提示已存在且不写入，输入框保留草稿', async () => {
    seedGlobalRules(['先写测试']);
    await renderLoaded();
    fireEvent.change(ruleInput(), { target: { value: ' 先写测试 ' } });
    fireEvent.click(screen.getByRole('button', { name: '添加规则' }));
    await waitFor(() => expect(toastMessages()).toContain('该规则已存在'));
    expect(storedRules()).toEqual(['先写测试']);
    expect(ruleInput()).toHaveValue(' 先写测试 ');
  });

  it('点击预设加入规则，已存在的预设显示为已添加并禁用', async () => {
    const preset = '修改前先说明方案并等待确认';
    await renderLoaded();
    fireEvent.click(
      screen.getByRole('button', { name: `添加预设：${preset}` })
    );

    const added = await screen.findByRole('button', {
      name: `已添加：${preset}`,
    });
    expect(added).toBeDisabled();
    expect(storedRules()).toEqual([preset]);
  });

  it('项目作用域添加的规则写入项目设置，不污染全局', async () => {
    seedGlobalRules(['全局规则 A']);
    seedProject([]);
    localStorage.setItem('crish_workspace', PROJECT);
    await renderLoaded();
    fireEvent.change(ruleInput(), { target: { value: '只在本项目生效' } });
    fireEvent.click(screen.getByRole('button', { name: '添加规则' }));

    expect(await screen.findByText('只在本项目生效')).toBeInTheDocument();
    expect(storedRules(PROJECT_KEY)).toEqual(['只在本项目生效']);
    expect(storedRules()).toEqual(['全局规则 A']);
  });

  it('删除规则后列表与存储同步移除', async () => {
    seedGlobalRules(['规则一', '规则二']);
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '删除规则：规则一' }));
    await waitFor(() => expect(screen.queryByText('规则一')).toBeNull());
    expect(screen.getByText('规则二')).toBeInTheDocument();
    expect(storedRules()).toEqual(['规则二']);
  });

  it('写入失败时提示更新设置失败，列表保持原样', async () => {
    seedGlobalRules(['规则一']);
    vi.spyOn(clientApi, 'saveSettingsEx').mockRejectedValue(
      new Error('quota exceeded')
    );
    await renderLoaded();
    fireEvent.change(ruleInput(), { target: { value: '新规则' } });
    fireEvent.click(screen.getByRole('button', { name: '添加规则' }));

    await waitFor(() =>
      expect(toastMessages()).toContain('更新设置失败：Error: quota exceeded')
    );
    expect(screen.queryByText('新规则')).toBeNull();
    expect(ruleInput()).toHaveValue('新规则');
    expect(storedRules()).toEqual(['规则一']);
  });
});

describe('SettingsRulesTab 全文编辑', () => {
  it('打开全文编辑：正文预填现有规则，并通知父级进入阻塞弹层', async () => {
    seedGlobalRules(['规则一', '规则二']);
    const onBlocking = vi.fn();
    await renderLoaded(onBlocking);
    expect(onBlocking).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: '编辑全局全文' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('编辑全局规则')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('textbox', { name: '全局规则正文' })
    ).toHaveValue('规则一\n规则二');
    expect(onBlocking).toHaveBeenLastCalledWith(true);

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onBlocking).toHaveBeenLastCalledWith(false);
    expect(storedRules()).toEqual(['规则一', '规则二']);
  });

  it('保存全文：去掉列表符号与 # 标题行、去重后写入并关闭弹层', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '编辑全局全文' }));
    const dialog = await screen.findByRole('dialog');
    const textarea = within(dialog).getByRole('textbox', {
      name: '全局规则正文',
    });
    fireEvent.change(textarea, {
      target: { value: '# 全局规则\n- 先读代码\n* 再动手\n先读代码\n\n' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(storedRules()).toEqual(['先读代码', '再动手']);
    expect(screen.getByText('先读代码')).toBeInTheDocument();
    expect(screen.getByText('再动手')).toBeInTheDocument();
  });

  it('全文保存失败时保持弹层打开并提示', async () => {
    vi.spyOn(clientApi, 'saveSettingsEx').mockRejectedValue(
      new Error('locked')
    );
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '编辑全局全文' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: '全局规则正文' }),
      {
        target: { value: '一条规则' },
      }
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(toastMessages()).toContain('更新设置失败：Error: locked')
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(storedRules()).toEqual([]);
  });
});
