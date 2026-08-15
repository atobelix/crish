// @vitest-environment jsdom
/**
 * ComposePlusMenu（ui/Menu 基座）样式契约与交互测试：
 * 1. 样式契约：尺寸修饰类 plusMenu、消除 flex-end 交叉轴虚位、死选择器清零
 * 2. 交互测试：打开/渲染全部选项/点击事件/Esc 关闭
 * 3. 锚点机制：P1-F4 真实按钮锚点与浮动定位
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { ComposePlusMenu } from './ComposePlusMenu';
import styles from './ComposePlusMenu.module.css';
import { openSettings } from '../../api/storeAccess';
import { emitUiEvent } from '../../api/uiEvents';

vi.mock('../../api/storeAccess', () => ({
  openSettings: vi.fn(),
}));

vi.mock('../../api/uiEvents', () => ({
  emitUiEvent: vi.fn(),
}));

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here =
  typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

describe('ComposePlusMenu 样式契约与无虚位验证', () => {
  const cssContent = readFileSync(
    join(here, 'ComposePlusMenu.module.css'),
    'utf8'
  );

  it('规范包含尺寸修饰类 .plusMenu 与项级样式', () => {
    expect(cssContent).toContain('.plusMenu');
    expect(cssContent).toContain('min-width: 188px');
    expect(cssContent).toContain('.item');
    expect(cssContent).toContain('width: 100%');
    expect(cssContent).toContain('.icon');
    expect(cssContent).toContain('.text');
    expect(cssContent).toContain('.title');
    expect(cssContent).toContain('.desc');
  });

  it('彻底清除历史废弃的 main / mainExit / 污染属性 (align-items: flex-end, pointer-events: none, position: absolute)', () => {
    const rawCssWithoutComments = cssContent.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rawCssWithoutComments).not.toMatch(/\.main\b/);
    expect(rawCssWithoutComments).not.toMatch(/\.mainExit\b/);
    expect(rawCssWithoutComments).not.toContain('align-items: flex-end');
    expect(rawCssWithoutComments).not.toContain('pointer-events: none');
    expect(rawCssWithoutComments).not.toContain('position: absolute');
  });
});

describe('ComposePlusMenu（ui/Menu 基座交互与渲染）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('受控打开后渲染全部 6 个功能选项且容器带有 plusMenu 修饰类', async () => {
    render(
      <ComposePlusMenu open={true} onClose={() => {}} onAddFiles={() => {}} />
    );
    expect(await screen.findByText('添加文件')).toBeInTheDocument();
    expect(screen.getByText('使用技能')).toBeInTheDocument();
    expect(screen.getByText('插件')).toBeInTheDocument();
    expect(screen.getByText('MCP 工具')).toBeInTheDocument();
    expect(screen.getByText('扩展中心')).toBeInTheDocument();
    expect(screen.getByText('定时任务')).toBeInTheDocument();

    const menu = await screen.findByRole('menu');
    const content = menu.parentElement as HTMLElement;
    expect(content).toBeTruthy();
    expect(content.className).toContain(styles.plusMenu);
    expect(content.className).toContain('no-drag');
  });

  it('点击「添加文件」触发 onAddFiles 并关闭', async () => {
    const onAddFiles = vi.fn();
    const onClose = vi.fn();
    render(
      <ComposePlusMenu open={true} onClose={onClose} onAddFiles={onAddFiles} />
    );
    fireEvent.click(await screen.findByText('添加文件'));
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('点击「使用技能」触发 onInsertSkillSlash、恢复焦点并关闭', async () => {
    const onInsertSkillSlash = vi.fn();
    const onClose = vi.fn();
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const focusSpy = vi.spyOn(btn, 'focus');
    const anchorRef = { current: btn };

    render(
      <ComposePlusMenu
        open={true}
        onClose={onClose}
        onAddFiles={() => {}}
        onInsertSkillSlash={onInsertSkillSlash}
        restoreFocusRef={anchorRef}
      />
    );
    fireEvent.click(await screen.findByText('使用技能'));
    expect(onInsertSkillSlash).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(focusSpy).toHaveBeenCalled());
    document.body.removeChild(btn);
  });

  it('点击「插件」、「MCP 工具」、「扩展中心」调用 openSettings', async () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <ComposePlusMenu open={true} onClose={onClose} onAddFiles={() => {}} />
    );
    fireEvent.click(await screen.findByText('插件'));
    expect(openSettings).toHaveBeenCalledWith('plugins');
    expect(onClose).toHaveBeenCalled();

    unmount();

    render(
      <ComposePlusMenu open={true} onClose={onClose} onAddFiles={() => {}} />
    );
    fireEvent.click(await screen.findByText('MCP 工具'));
    expect(openSettings).toHaveBeenCalledWith('plugins');

    fireEvent.click(await screen.findByText('扩展中心'));
    expect(openSettings).toHaveBeenCalledWith('plugins');
  });

  it('点击「定时任务」触发 emitUiEvent(open-scheduled)', async () => {
    const onClose = vi.fn();
    render(
      <ComposePlusMenu open={true} onClose={onClose} onAddFiles={() => {}} />
    );
    fireEvent.click(await screen.findByText('定时任务'));
    expect(emitUiEvent).toHaveBeenCalledWith('open-scheduled');
    expect(onClose).toHaveBeenCalled();
  });

  it('Esc 关闭（经基座 onOpenChange → onClose）', async () => {
    const onClose = vi.fn();
    render(
      <ComposePlusMenu open={true} onClose={onClose} onAddFiles={() => {}} />
    );
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('open=false 时不渲染任何内容', () => {
    const { container } = render(
      <ComposePlusMenu open={false} onClose={() => {}} onAddFiles={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });
});

/**
 * P1-F4（F7 F1）：ComposePlusMenu 锚点与真实按钮定位测试
 */
describe('ComposePlusMenu P1-F4 锚点修复', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('不再渲染 display:none 空 div 作浮动锚点（真实按钮作锚）', async () => {
    const anchorRef = React.createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={anchorRef} type="button">
          ＋
        </button>
        <ComposePlusMenu
          open={true}
          onClose={() => {}}
          onAddFiles={() => {}}
          restoreFocusRef={anchorRef}
        />
      </>
    );
    await screen.findByRole('menu');
    expect(document.querySelector('[style*="display: none"]')).toBeNull();
  });

  it('打开菜单后菜单以真实按钮为锚定位（floating-ui 基于可见元素 rect）', async () => {
    const anchorRef = React.createRef<HTMLButtonElement>();
    render(
      <button ref={anchorRef} type="button">
        ＋
      </button>
    );
    const btn = anchorRef.current as HTMLButtonElement;
    expect(btn).not.toBeNull();
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 200,
      width: 32,
      height: 32,
      top: 200,
      left: 100,
      right: 132,
      bottom: 232,
      toJSON: () => ({}),
    } as DOMRect);

    render(
      <ComposePlusMenu
        open={true}
        onClose={() => {}}
        onAddFiles={() => {}}
        restoreFocusRef={anchorRef}
      />
    );
    await screen.findByRole('menu');
    await waitFor(() => {
      const wrapper = document.querySelector(
        '[data-radix-popper-content-wrapper]'
      );
      const style = wrapper?.getAttribute('style') ?? '';
      expect(style).toContain('--radix-popper-anchor-width: 32px');
      expect(style).toContain('translate(100px');
    });
    expect(document.body.contains(btn)).toBe(true);
    expect(btn.style.display).not.toBe('none');
  });
});
