// @vitest-environment jsdom
/**
 * SettingsRulesTab 用户视角测试（壳组件 + 真实 useRulesState）：
 * 全局 / 项目作用域加载、常驻全文编辑器（进页可编辑、显式保存、解析去重、
 * 保存失败保留草稿）、作用域切换换载、读取失败与重试。
 * 持久化走真实 clientApi（jsdom localStorage），只在需要制造 IO 失败时
 * spy 掉 clientApi 单个方法；提示走真实 ToastStore。
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

function renderTab() {
  return render(
    <ToastProvider>
      <SettingsRulesTab />
    </ToastProvider>
  );
}

async function renderLoaded(scopeLabel = '全局') {
  const utils = renderTab();
  await screen.findByRole('textbox', { name: `${scopeLabel}规则正文` });
  return utils;
}

function editor(scopeLabel = '全局'): HTMLTextAreaElement {
  return screen.getByRole('textbox', {
    name: `${scopeLabel}规则正文`,
  }) as HTMLTextAreaElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
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
  it('全局作用域无规则时编辑器预填空模板，保存按钮禁用', async () => {
    await renderLoaded();
    expect(screen.getByText('当前规则 (全局)')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveTextContent('全局');
    expect(editor()).toHaveValue('# 全局规则\n\n');
    expect(saveButton()).toBeDisabled();
  });

  it('展示已保存的全局规则全文（去重、去首尾空白）', async () => {
    seedGlobalRules(['  先写测试  ', '先写测试', '中文回复']);
    await renderLoaded();
    expect(editor()).toHaveValue('先写测试\n中文回复');
  });

  it('当前工作区是已知项目时默认进入项目作用域，只加载项目自己的规则', async () => {
    seedGlobalRules(['全局规则 A']);
    seedProject(['项目规则 B']);
    localStorage.setItem('crish_workspace', 'C:\\work\\demo');
    await renderLoaded('demo');
    expect(screen.getByText('当前规则 (demo)')).toBeInTheDocument();
    expect(editor('demo')).toHaveValue('项目规则 B');
  });

  it('切换作用域后换载对应作用域的全文', async () => {
    seedGlobalRules(['全局规则 A']);
    seedProject(['项目规则 B']);
    await renderLoaded();
    expect(editor()).toHaveValue('全局规则 A');

    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: /demo/ }));

    expect(await screen.findByRole('textbox', { name: 'demo规则正文' })).toBe(
      editor('demo')
    );
    expect(editor('demo')).toHaveValue('项目规则 B');
    expect(screen.getByText('当前规则 (demo)')).toBeInTheDocument();
  });

  it('读取失败显示错误与重试，重试成功后进入编辑器', async () => {
    seedGlobalRules(['重试后可见']);
    const spy = vi
      .spyOn(clientApi, 'getSettingsEx')
      .mockRejectedValueOnce(new Error('disk gone'));
    renderTab();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('读取规则失败：Error: disk gone');
    expect(toastMessages()).toContain('读取规则失败：Error: disk gone');

    fireEvent.click(screen.getByRole('button', { name: '重新加载规则' }));
    await waitFor(() => expect(editor()).toHaveValue('重试后可见'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('SettingsRulesTab 常驻编辑与保存', () => {
  it('进页即可编辑；保存去掉列表符号与 # 标题行、去重后写入并规范化文本', async () => {
    await renderLoaded();
    fireEvent.change(editor(), {
      target: { value: '# 全局规则\n- 先读代码\n* 再动手\n先读代码\n\n' },
    });
    expect(saveButton()).toBeEnabled();

    fireEvent.click(saveButton());
    await waitFor(() => expect(storedRules()).toEqual(['先读代码', '再动手']));
    // 保存成功：编辑器回落为落盘规范化文本，保存按钮回到禁用（无未存修改）
    await waitFor(() => expect(editor()).toHaveValue('先读代码\n再动手'));
    expect(saveButton()).toBeDisabled();
  });

  it('保存失败时提示且保留草稿，存储不变', async () => {
    vi.spyOn(clientApi, 'saveSettingsEx').mockRejectedValue(
      new Error('locked')
    );
    await renderLoaded();
    fireEvent.change(editor(), { target: { value: '一条规则' } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(toastMessages()).toContain('更新设置失败：Error: locked')
    );
    expect(editor()).toHaveValue('一条规则');
    expect(saveButton()).toBeEnabled();
    expect(storedRules()).toEqual([]);
  });

  it('项目作用域保存写入项目设置，不污染全局', async () => {
    seedGlobalRules(['全局规则 A']);
    seedProject([]);
    localStorage.setItem('crish_workspace', PROJECT);
    await renderLoaded('demo');
    fireEvent.change(editor('demo'), {
      target: { value: '只在本项目生效' },
    });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(storedRules(PROJECT_KEY)).toEqual(['只在本项目生效'])
    );
    expect(storedRules()).toEqual(['全局规则 A']);
  });

  it('未保存草稿不跨作用域保留：切换后换载目标作用域的已存全文', async () => {
    seedGlobalRules(['全局规则 A']);
    seedProject(['项目规则 B']);
    await renderLoaded();
    fireEvent.change(editor(), { target: { value: '未保存的草稿' } });
    expect(saveButton()).toBeEnabled();

    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: /demo/ }));
    await waitFor(() => expect(editor('demo')).toHaveValue('项目规则 B'));

    fireEvent.click(screen.getByRole('combobox'));
    const listbox2 = await screen.findByRole('listbox');
    fireEvent.click(within(listbox2).getByRole('option', { name: /全局/ }));
    await waitFor(() => expect(editor()).toHaveValue('全局规则 A'));
  });
});
