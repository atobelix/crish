// @vitest-environment jsdom
/**
 * 设置弹窗（ui/Dialog 居中模态）行为与结构契约：
 * - 打开 / 关闭：关闭先播退场（exiting），动画结束才卸载；主界面全程保持挂载
 * - Esc 层级：嵌套弹窗打开时 Esc / 点遮罩只关最上层；设置层先清搜索再关
 * - 入口：openSettings(tab) 打开到对应分类，标题行显示「设置 / 分类」
 * - 设置内不再渲染窗口按钮（WindowControls），也没有窗口拖拽区
 * - 三层底色 token 与无边框总开关、共用遮罩 token
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  waitFor,
} from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const stubs = await vi.hoisted(async () => {
  const ReactMod = await import('react');
  const { Dialog: RealDialog } = await import('../ui/Dialog/Dialog');
  const make = (id: string) =>
    function TabStub() {
      return ReactMod.createElement(
        'div',
        { 'data-testid': `tab-body-${id}` },
        id
      );
    };
  /** 模型页替身：可打开一个嵌套弹窗（模拟 ModelConfigDialog） */
  function ModelsStub() {
    const [open, setOpen] = ReactMod.useState(false);
    return ReactMod.createElement(
      'div',
      { 'data-testid': 'tab-body-models' },
      ReactMod.createElement(
        'button',
        { type: 'button', onClick: () => setOpen(true) },
        '添加模型'
      ),
      ReactMod.createElement(
        RealDialog,
        { open, onClose: () => setOpen(false), title: '模型配置', size: 'lg' },
        ReactMod.createElement('input', { 'aria-label': '模型名' })
      )
    );
  }
  return { make, ModelsStub };
});

vi.mock('../../api/capabilitiesStore', () => ({
  getCachedCapabilities: () => null,
  refreshProductCapabilities: () => Promise.resolve(),
}));
vi.mock('./SettingsProfileTab', () => ({
  SettingsProfileTab: stubs.make('profile'),
}));
vi.mock('./SettingsUsageTab', () => ({
  SettingsUsageTab: stubs.make('usage'),
}));
vi.mock('./SettingsShortcutsTab', () => ({
  SettingsShortcutsTab: stubs.make('shortcuts'),
}));
vi.mock('../settings-extensions/SettingsExtensionsTab', () => ({
  SettingsExtensionsTab: stubs.make('plugins'),
}));
vi.mock('../settings-models/ModelsSettingsTab', () => ({
  ModelsSettingsTab: stubs.ModelsStub,
}));

import { AppGlobalDialogs } from '../../app/AppGlobalDialogs';
import {
  useSettingsUiStore,
  openSettings,
  DEFAULT_SETTINGS_TAB,
} from '../../store/settingsUiStore';
import { layerStackService } from '../ui/internal/layer-stack/LayerStackService';

function Harness() {
  const show = useSettingsUiStore((s) => s.showSettingsOverlay);
  const setShow = useSettingsUiStore((s) => s.setShowSettingsOverlay);
  const tab = useSettingsUiStore((s) => s.settingsActiveTab);
  const [mainRenders] = useState(() => ({ count: 0 }));
  mainRenders.count += 1;
  return (
    <>
      <main data-testid="main-shell">主界面</main>
      <AppGlobalDialogs
        showFirstRun={false}
        setShowFirstRun={() => undefined}
        showTelemetry={false}
        setShowTelemetry={() => undefined}
        showSettingsOverlay={show}
        setShowSettingsOverlay={setShow}
        activeWorkspaceId="ws-1"
        settingsActiveTab={tab}
      />
    </>
  );
}

const isOpen = () => useSettingsUiStore.getState().showSettingsOverlay;
// 嵌套弹窗打开时设置弹窗会被 FocusTrap 旁路 aria-hidden，故按属性而非可访问树查
const settingsDialog = () =>
  document.querySelector<HTMLElement>('[role="dialog"][aria-label="设置"]');
const settingsOverlay = () =>
  settingsDialog()?.closest('[data-dialog-overlay]') as HTMLElement | null;

async function openAt(tab?: Parameters<typeof openSettings>[0]) {
  act(() => openSettings(tab));
  return screen.findByRole('dialog', { name: '设置' });
}

beforeEach(() => {
  layerStackService.dispose();
  useSettingsUiStore.setState({
    showSettingsOverlay: false,
    settingsActiveTab: DEFAULT_SETTINGS_TAB,
  });
});

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  vi.useRealTimers();
});

describe('设置弹窗：打开 / 关闭与退场动画', () => {
  it('打开：居中弹窗（aria-modal），主界面保持挂载', async () => {
    render(<Harness />);
    expect(settingsDialog()).toBeNull();
    const dialog = await openAt();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.className).toMatch(/settingsModal/);
    expect(dialog.className).toMatch(/dialogEnter/);
    expect(screen.getByTestId('main-shell')).toBeInTheDocument();
    expect(await screen.findByTestId('tab-body-profile')).toBeInTheDocument();
  });

  it('关闭：先进入 exiting（退场动画），结束后才卸载；不是条件渲染硬切', async () => {
    render(<Harness />);
    await openAt();
    fireEvent.click(screen.getByTestId('settings-close-button'));
    expect(isOpen()).toBe(false);
    // 同一帧内仍在 DOM 中，并挂退场类
    expect(settingsDialog()).not.toBeNull();
    expect(settingsOverlay()).toHaveAttribute('data-dialog-state', 'exiting');
    expect(settingsOverlay()!.className).toMatch(/overlayExit/);
    expect(settingsDialog()!.className).toMatch(/dialogExit/);
    await waitFor(() => expect(settingsDialog()).toBeNull(), { timeout: 1000 });
    expect(screen.getByTestId('main-shell')).toBeInTheDocument();
  });

  it('退场期间重新打开：弹窗不卸载，回到打开态', async () => {
    render(<Harness />);
    await openAt();
    fireEvent.click(screen.getByTestId('settings-close-button'));
    act(() => openSettings());
    expect(settingsDialog()).not.toBeNull();
    await waitFor(() =>
      expect(settingsOverlay()).toHaveAttribute('data-dialog-state', 'open')
    );
    await new Promise((r) => setTimeout(r, 250));
    expect(settingsDialog()).not.toBeNull();
  });

  it('点设置自身遮罩关闭', async () => {
    render(<Harness />);
    await openAt();
    const backdrop = settingsOverlay()!.firstElementChild as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(isOpen()).toBe(false);
  });
});

describe('设置弹窗：Esc 与点击的层级顺序（LayerStack）', () => {
  it('有搜索词时 Esc 先清空搜索；再按 Esc 关闭设置', async () => {
    render(<Harness />);
    await openAt();
    const search = screen.getByLabelText('搜索设置分类');
    fireEvent.change(search, { target: { value: '主题' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(isOpen()).toBe(true);
    await new Promise((r) => setTimeout(r, 60)); // LayerStack 50ms 连按防抖
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(isOpen()).toBe(false);
  });

  it('嵌套模型配置弹窗打开时：Esc 只关最上层，设置保持打开；再按 Esc 才关设置', async () => {
    render(<Harness />);
    await openAt('models');
    fireEvent.click(await screen.findByText('添加模型'));
    expect(
      screen.getByRole('dialog', { name: '模型配置' })
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '模型配置' })).toBeNull()
    );
    expect(isOpen()).toBe(true);
    expect(settingsDialog()).not.toBeNull();

    await new Promise((r) => setTimeout(r, 60));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(isOpen()).toBe(false);
  });

  it('嵌套弹窗打开时点它的遮罩：只关嵌套弹窗，不级联关设置', async () => {
    render(<Harness />);
    await openAt('models');
    fireEvent.click(await screen.findByText('添加模型'));
    const nested = screen.getByRole('dialog', { name: '模型配置' });
    const nestedOverlay = nested.closest(
      '[data-dialog-overlay]'
    ) as HTMLElement;
    expect(nestedOverlay).not.toBe(settingsOverlay());
    const nestedBackdrop = nestedOverlay.firstElementChild as HTMLElement;
    fireEvent.pointerDown(nestedBackdrop);
    fireEvent.click(nestedBackdrop);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '模型配置' })).toBeNull()
    );
    expect(isOpen()).toBe(true);
  });

  it('嵌套弹窗与设置弹窗是同一 portal 目标下的兄弟遮罩（只保留最上层遮罩的 CSS 依赖此结构）', async () => {
    render(<Harness />);
    await openAt('models');
    fireEvent.click(await screen.findByText('添加模型'));
    const overlays = Array.from(
      document.querySelectorAll('[data-dialog-overlay]')
    );
    expect(overlays).toHaveLength(2);
    expect(overlays[0]).toBe(settingsOverlay());
    // portal 目标 > [data-focus-trap] > [data-dialog-overlay]；两个 trap 容器是兄弟，后开的在后
    const [lowerTrap, upperTrap] = overlays.map((o) => o.parentElement!);
    expect(lowerTrap).toHaveAttribute('data-focus-trap');
    expect(upperTrap).toHaveAttribute('data-focus-trap');
    expect(lowerTrap!.parentElement).toBe(upperTrap!.parentElement);
    expect(
      lowerTrap!.compareDocumentPosition(upperTrap!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(overlays[1]).toHaveAttribute('data-dialog-state', 'open');
  });
});

describe('设置弹窗：入口打开到对应分类', () => {
  it.each([
    ['models', '模型'],
    ['usage', '用量'],
    ['plugins', '扩展'],
    ['shortcuts', '快捷键'],
  ] as const)(
    'openSettings(%s) → 分类 %s，标题行「设置 / %s」',
    async (tab, label) => {
      render(<Harness />);
      await openAt(tab);
      const panel = document.querySelector('[role="tabpanel"]') as HTMLElement;
      expect(panel).toHaveAttribute('data-settings-tab', tab);
      expect(await screen.findByTestId(`tab-body-${tab}`)).toBeInTheDocument();
      const title = screen.getByTestId('settings-title');
      expect(title.textContent?.replace(/\s/g, '')).toBe(`设置/${label}`);
      expect(screen.getByRole('tab', { selected: true })).toHaveAttribute(
        'data-settings-tab-id',
        tab
      );
    }
  );

  it('已打开时再深链：只切分类，不重新挂载弹窗', async () => {
    render(<Harness />);
    const dialog = await openAt('profile');
    act(() => openSettings('models'));
    expect(await screen.findByTestId('tab-body-models')).toBeInTheDocument();
    expect(settingsDialog()).toBe(dialog);
  });
});

describe('设置弹窗：不再渲染窗口按钮 / 拖拽区', () => {
  it('弹窗内没有 WindowControls（最小化 / 最大化 / 关闭应用），关闭按钮只关设置', async () => {
    render(<Harness />);
    const dialog = await openAt();
    expect(dialog.querySelector('[data-window-control]')).toBeNull();
    expect(
      dialog.querySelector('[role="group"][aria-label="窗口控制"]')
    ).toBeNull();
    expect(screen.queryByRole('button', { name: '最小化窗口' })).toBeNull();
    expect(screen.queryByRole('button', { name: '关闭应用' })).toBeNull();
    expect(dialog.querySelector('[data-tauri-drag-region]')).toBeNull();
    expect(screen.getByTestId('settings-close-button')).toHaveAttribute(
      'aria-label',
      '关闭设置'
    );
  });

  it('源码：设置组件不引用 WindowControls / 拖拽区，WindowControls 无「关闭设置」语义', () => {
    const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
    for (const rel of ['./SettingsPanel.tsx', './SettingsSidebar.tsx']) {
      const src = read(rel);
      expect(src, rel).not.toContain('WindowControls');
      expect(src, rel).not.toContain('data-tauri-drag-region');
      expect(src, rel).not.toContain('SidebarFooter');
    }
    const wc = read('../shell/WindowControls.tsx');
    expect(wc).not.toMatch(/onClose/);
    expect(wc).not.toContain('关闭设置');
    expect(wc).not.toContain('settings-close-button');
    const css = read('./SettingsPanel.module.css');
    expect(css).not.toMatch(/app-region/);
  });
});

describe('设置弹窗：两层底色 / 无边框开关 / 遮罩 token 契约', () => {
  const css = readFileSync(
    resolve(__dirname, './SettingsPanel.module.css'),
    'utf8'
  );
  const tokens = readFileSync(
    resolve(__dirname, '../../styles/tokens.css'),
    'utf8'
  );
  const rule = (selector: string) => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (
      css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{[\\s\\S]*?\\n\\}`))?.[0] ?? ''
    );
  };

  it('面板 / 左导航 / 顶部标题行 / 内容区 = 外层 --surface-outer（与内容卡片 --surface-input 形成底卡分离）', () => {
    for (const sel of [
      "[role='dialog'].settingsModal",
      '.settingsNav',
      '.settingsHeader',
      '.coverContent',
    ]) {
      const r = rule(sel);
      expect(r, sel).not.toBe('');
      expect(r, sel).toMatch(/background:\s*var\(--surface-outer\);/);
    }
  });

  it('内容区与左栏/顶栏统一为 --surface-outer；卡片底色经 --cover-card-bg 在内容区作用域定义（T-BLK-07c 改名后）', () => {
    const r = rule('.coverContent');
    expect(r).toMatch(/background:\s*var\(--surface-outer\);/);
    expect(r).toMatch(/--cover-card-bg:\s*var\(--surface-input\);/);
    // 负向守护：本文件不得再定义 --bg-card（唯一真源在 styles/tokens.css）
    expect(r).not.toMatch(/--bg-card\s*:/);
  });

  it('卡片边框与投影：设置面板不得二次定义 A 类 token（--border-subtle / --shadow-sm 直连 tokens.css 单一真源）', () => {
    // 2026-10-20 真源唯一化：原「--settings-card-border/-shadow 旋钮 + 子级壳改接」链路经核算为
    // 恒等重定义（子级壳拿到的计算值与全局值相同），却让 --border-subtle / --shadow-sm 出现
    // 第二个定义文件（token SSOT 门禁 multi_file_defs 违规）。链路已删除，此处改为负向断言守护。
    const modal = rule("[role='dialog'].settingsModal");
    const shell = rule('.settingsShell');
    expect(modal, 'settingsModal').not.toBe('');
    expect(shell, 'settingsShell').not.toBe('');
    for (const [sel, r] of [
      ["[role='dialog'].settingsModal", modal],
      ['.settingsShell', shell],
    ] as const) {
      expect(r, sel).not.toMatch(/--border-subtle\s*:/);
      expect(r, sel).not.toMatch(/--shadow-sm\s*:/);
      expect(r, sel).not.toMatch(/--settings-card-border\s*:/);
      expect(r, sel).not.toMatch(/--settings-card-shadow\s*:/);
    }
    // 表单控件静止描边仍取真实发丝线（组件私有 token，引用全局值，属合法通道）
    expect(modal).toMatch(
      /--settings-control-border:\s*var\(--border-subtle\);/
    );
  });

  it('输入框保留静止描边：取面板层真实发丝线，只补非 hover / focus 态', () => {
    expect(rule("[role='dialog'].settingsModal")).toMatch(
      /--settings-control-border:\s*var\(--border-subtle\);/
    );
    expect(
      rule(
        '.settingsShell :is(input, textarea):where(:not(:hover):not(:focus))'
      )
    ).toMatch(/border-color:\s*var\(--settings-control-border\);/);
  });

  it('弹窗内壳层不画分隔线：顶栏无 border-bottom、侧栏无 border-right、面板无外框线', () => {
    for (const sel of [
      '.settingsNav',
      '.settingsHeader',
      '.settingsMain',
      '.coverContent',
    ]) {
      expect(rule(sel), sel).not.toMatch(
        /border(-right|-bottom)?:\s*(?!none)[^;]*solid/
      );
    }
    expect(rule("[role='dialog'].settingsModal")).toMatch(/border:\s*none;/);
    expect(rule("[role='dialog'].settingsModal")).toMatch(
      /box-shadow:\s*var\(--shadow-[a-z0-9]+\);/
    );
  });

  it('导航项选中态与主侧栏一致：--sidebar-active 叠加、字号 base、文字 --text-primary，无白底边框阴影', () => {
    const base = rule('.sidebarTab');
    expect(base).toMatch(/font-size:\s*var\(--font-size-base\);/);
    expect(base).toMatch(/color:\s*var\(--text-primary\);/);
    const active =
      css.match(
        /\.sidebarTab\.active,\s*\n\.sidebarTab\.active:hover\s*\{[\s\S]*?\n\}/
      )?.[0] ?? '';
    expect(active).toMatch(/background:\s*var\(--sidebar-active\);/);
    expect(active).not.toMatch(/tab-active-bg|border:|box-shadow/);
  });

  it('导航固定宽度走独立 token --settings-nav-width；旧 --settings-sidebar-width 已删除', () => {
    expect(rule('.settingsNav')).toMatch(
      /width:\s*var\(--settings-nav-width\);/
    );
    expect(tokens).toMatch(/--settings-nav-width:\s*\d+px/);
    expect(tokens).not.toContain('--settings-sidebar-width');
    expect(css).not.toContain('--settings-sidebar-width');
  });

  it('设置样式里不残留全屏盖层的旧壳类与 chrome 别名', () => {
    expect(css).not.toMatch(
      /\.settingsCover|\.coverHeader|\.coverBody|\.coverNav|\.settingsDialogBody/
    );
    expect(css).not.toContain('--shell-chrome-bg');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
