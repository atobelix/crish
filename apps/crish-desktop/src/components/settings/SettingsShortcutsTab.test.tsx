// @vitest-environment jsdom
/**
 * SettingsShortcutsTab 用户视角交互测试：筛选 / 空态 / 录制改键 / 冲突提示 / 还原默认 / 键盘导航。
 * 只 mock Tauri 边界（test-setup 默认 invoke=missing，远端保存失败本地仍生效）；
 * 持久化走真实 configService（jsdom localStorage），提示走真实 ToastProvider。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { SettingsShortcutsTab } from './SettingsShortcutsTab';
import { ToastProvider, ToastStore } from '../../services/toast';
import { configService } from '../../services/ConfigService';

function renderTab() {
  return render(
    <ToastProvider>
      <SettingsShortcutsTab />
    </ToastProvider>
  );
}

/** 某快捷键行的录制按钮（aria-label 以「<label>」开头） */
function keyButton(label: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`「${label}」当前`) });
}

function pressKey(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    );
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  for (const toast of ToastStore.getToasts()) ToastStore.dismiss(toast.id);
  localStorage.clear();
});

describe('SettingsShortcutsTab 列表与筛选', () => {
  it('默认按注册表展示所有快捷键及其中文化键位', () => {
    renderTab();
    expect(keyButton('新建对话')).toHaveTextContent('Ctrl + N');
    expect(keyButton('停止生成')).toHaveTextContent('Ctrl + Shift + 退格');
    // 未改键时不显示「已改 N 项」状态，也没有还原按钮
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: /恢复「/ })).toBeNull();
  });

  it('按名称筛选只保留匹配行，并播报结果数；清空按钮恢复全部', () => {
    renderTab();
    const search = screen.getByRole('searchbox', { name: /搜索快捷键/ });
    fireEvent.change(search, { target: { value: '侧栏' } });

    expect(keyButton('切换侧栏')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /「新建对话」当前/ })
    ).toBeNull();
    // 头部状态播报命中数（文案随语言包变化，只锁定数字 1）
    const statusTexts = screen
      .getAllByRole('status')
      .map((el) => el.textContent ?? '');
    expect(statusTexts.some((txt) => /^1\s/.test(txt))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /清/ }));
    expect(search).toHaveValue('');
    expect(keyButton('新建对话')).toBeInTheDocument();
  });

  it('可按中文化键位文本筛选（输入「退格」命中停止生成）', () => {
    renderTab();
    fireEvent.change(screen.getByRole('searchbox', { name: /搜索快捷键/ }), {
      target: { value: '退格' },
    });
    expect(keyButton('停止生成')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /「新建对话」当前/ })
    ).toBeNull();
  });

  it('无匹配时显示空态与「清空筛选」入口，点击后恢复列表', () => {
    renderTab();
    const search = screen.getByRole('searchbox', { name: /搜索快捷键/ });
    fireEvent.change(search, { target: { value: 'zzz-不存在' } });

    expect(screen.getByText(/无匹配/)).toHaveTextContent('zzz-不存在');
    expect(screen.queryByRole('button', { name: /当前/ })).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: '清空筛选并显示全部快捷键' })
    );
    expect(search).toHaveValue('');
    expect(keyButton('新建对话')).toBeInTheDocument();
  });

  it('搜索框内按 Esc 清空查询', () => {
    renderTab();
    const search = screen.getByRole('searchbox', { name: /搜索快捷键/ });
    fireEvent.change(search, { target: { value: '模型' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
  });
});

describe('SettingsShortcutsTab 录制改键', () => {
  it('点击进入录制态，按下新组合后按钮即时显示新键位并持久化，且不弹提示', () => {
    renderTab();
    fireEvent.click(keyButton('新建对话'));

    const recording = screen.getByRole('button', {
      name: /正在录制「新建对话」/,
    });
    expect(recording).toHaveAttribute('aria-pressed', 'true');
    expect(recording).toHaveTextContent('按下快捷键组合');
    expect(screen.getByRole('status')).toHaveTextContent('新建对话');

    // 单独的修饰键不结束录制
    pressKey({ key: 'Control', ctrlKey: true });
    expect(
      screen.getByRole('button', { name: /正在录制「新建对话」/ })
    ).toBeInTheDocument();

    pressKey({ key: 'y', ctrlKey: true, altKey: true });

    const updated = keyButton('新建对话');
    expect(updated).toHaveAttribute('aria-pressed', 'false');
    expect(updated.textContent).toMatch(/Ctrl \+ Alt \+ Y/i);
    expect(
      configService.get<Record<string, string>>('shortcuts.overrides')
        .new_session
    ).toMatch(/Ctrl \+ Alt \+ Y/i);
    expect(ToastStore.getToasts()).toHaveLength(0);
    // 已改 1 项 → 头部状态 + 还原按钮出现
    expect(screen.getByRole('status')).toHaveTextContent(/1/);
    expect(
      screen.getByRole('button', { name: /恢复「新建对话」为默认 Ctrl \+ N/ })
    ).toBeInTheDocument();
  });

  it('录制中按 Esc 取消，键位保持原值', () => {
    renderTab();
    fireEvent.click(keyButton('切换侧栏'));
    pressKey({ key: 'Escape' });
    const btn = keyButton('切换侧栏');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveTextContent('Ctrl + B');
  });

  it('再次点击正在录制的按钮也会退出录制', () => {
    renderTab();
    fireEvent.click(keyButton('切换侧栏'));
    fireEvent.click(
      screen.getByRole('button', { name: /正在录制「切换侧栏」/ })
    );
    expect(keyButton('切换侧栏')).toHaveAttribute('aria-pressed', 'false');
  });

  it('录制到与其他快捷键冲突的组合时拒绝写入并给出错误提示', async () => {
    renderTab();
    fireEvent.click(keyButton('切换侧栏'));
    // Ctrl + N 已被「新建对话」占用
    pressKey({ key: 'n', ctrlKey: true });

    expect(keyButton('切换侧栏')).toHaveTextContent('Ctrl + B');
    const [toast] = ToastStore.getToasts();
    expect(toast?.type).toBe('error');
    expect(String(toast?.message)).toMatch(/新建对话/);
    // 提示对用户可见
    expect(await screen.findByText(/冲突/)).toBeVisible();
  });

  it('「还原」把自定义键位恢复为默认值', () => {
    localStorage.clear();
    configService.set('shortcuts.overrides', { new_session: 'Ctrl + Alt + Y' });
    renderTab();
    expect(keyButton('新建对话')).toHaveTextContent('Ctrl + Alt + Y');

    fireEvent.click(
      screen.getByRole('button', { name: /恢复「新建对话」为默认/ })
    );

    expect(keyButton('新建对话')).toHaveTextContent('Ctrl + N');
    expect(
      screen.queryByRole('button', { name: /恢复「新建对话」为默认/ })
    ).toBeNull();
  });

  it('默认键位已被他人占用时「还原」失败并提示冲突，键位不变', () => {
    // 新建对话 改成别的，切换侧栏 占用 Ctrl + N
    configService.set('shortcuts.overrides', {
      new_session: 'Ctrl + Alt + Y',
      toggle_sidebar: 'Ctrl + N',
    });
    renderTab();
    fireEvent.click(
      screen.getByRole('button', { name: /恢复「新建对话」为默认/ })
    );

    expect(keyButton('新建对话')).toHaveTextContent('Ctrl + Alt + Y');
    const [toast] = ToastStore.getToasts();
    expect(toast?.type).toBe('error');
    expect(String(toast?.message)).toMatch(/切换侧栏/);
  });
});

describe('SettingsShortcutsTab 键盘导航', () => {
  it('列表内 ↓/↑/End/Home 移动 roving tabindex 与焦点', async () => {
    renderTab();
    const buttons = () => screen.getAllByRole('button', { name: /当前/ });
    const first = buttons()[0]!;
    const all = buttons();
    const last = all[all.length - 1]!;
    expect(first).toHaveAttribute('tabindex', '0');
    expect(all.filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(
      1
    );

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    await act(
      () => new Promise((r) => requestAnimationFrame(() => r(undefined)))
    );
    expect(document.activeElement).toBe(buttons()[1]);

    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    await act(
      () => new Promise((r) => requestAnimationFrame(() => r(undefined)))
    );
    expect(document.activeElement).toBe(last);
    expect(last).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(last, { key: 'ArrowDown' }); // 环绕到首项
    await act(
      () => new Promise((r) => requestAnimationFrame(() => r(undefined)))
    );
    expect(document.activeElement).toBe(buttons()[0]);

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' }); // 反向环绕
    await act(
      () => new Promise((r) => requestAnimationFrame(() => r(undefined)))
    );
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(last, { key: 'Home' });
    await act(
      () => new Promise((r) => requestAnimationFrame(() => r(undefined)))
    );
    expect(document.activeElement).toBe(buttons()[0]);
  });

  it('搜索框按 ↓ 把焦点送入列表', async () => {
    renderTab();
    const search = screen.getByRole('searchbox', { name: /搜索快捷键/ });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    await act(
      () => new Promise((r) => requestAnimationFrame(() => r(undefined)))
    );
    expect(document.activeElement).toBe(
      screen.getAllByRole('button', { name: /当前/ })[0]
    );
  });
});
