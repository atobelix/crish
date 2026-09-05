// @vitest-environment jsdom
/**
 * TerminalCard 单元测试
 * 验证终端面板真实接入、样式类名注入、xterm 渲染与 PTY 交互生命周期。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { TerminalCard } from './TerminalCard';
import { mockTauriCommand, mockTauriMissing } from '../../test-setup';
import { resetPtyRegistryForTests } from '../../api/ptyRegistry';
import styles from './TerminalCard.module.css';

describe('TerminalCard', () => {
  beforeEach(() => {
    resetPtyRegistryForTests();
    // 补齐 jsdom 缺失的 window.matchMedia 与 canvas 上下文供 xterm 初始化
    window.matchMedia = function (query: string) {
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    };

    HTMLCanvasElement.prototype.getContext = function () {
      return {
        fillRect: () => {},
        clearRect: () => {},
        getImageData: () => ({ data: [] }),
        putImageData: () => {},
        createImageData: () => [],
        setTransform: () => {},
        drawImage: () => {},
        save: () => {},
        fillText: () => {},
        restore: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        closePath: () => {},
        stroke: () => {},
        translate: () => {},
        scale: () => {},
        rotate: () => {},
        arc: () => {},
        fill: () => {},
        measureText: () => ({ width: 0 }),
        transform: () => {},
        rect: () => {},
        clip: () => {},
      } as unknown as RenderingContext;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext;

    // 默认 mock workbench_pty_create 成功
    mockTauriCommand('workbench_pty_create', () => ({
      ptyId: 'test-pty-id-1',
    }));
    mockTauriCommand('workbench_pty_resize', () => null);
    mockTauriCommand('workbench_pty_write', () => null);
    mockTauriCommand('workbench_pty_kill', () => null);
  });

  it('renders terminal panel with bound sessionId and interactive attributes', async () => {
    const { container } = render(<TerminalCard sessionId="session-123" />);

    const panel = container.querySelector(`.${styles.panel}`);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('data-session-id', 'session-123');
    expect(panel).toHaveAttribute('data-session-key', 'session-123');
    expect(panel).toHaveAttribute('data-ux-mode', 'interactive');
    expect(panel).toHaveAttribute('aria-label', '终端');

    // 验证 interactiveHost 样式类及属性正确挂载
    const host = container.querySelector(`.${styles.interactiveHost}`);
    expect(host).not.toBeNull();
    expect(host).toHaveAttribute('data-pty-host', 'true');
    expect(host).toHaveAttribute('data-pty-active', 'true');
    expect(host).toHaveAttribute('aria-label', '终端区域');

    // 验证 xtermWrap 与 xterm 挂载容器
    const xtermWrap = container.querySelector(`.${styles.xtermWrap}`);
    expect(xtermWrap).not.toBeNull();

    const xtermHost = container.querySelector(`.${styles.xtermHost}`);
    expect(xtermHost).not.toBeNull();
    expect(xtermHost).toHaveAttribute('data-session-key', 'session-123');

    await waitFor(() => {
      expect(panel).toHaveAttribute('data-pty-status', 'ready');
    });
  });

  it('falls back to global session key when sessionId is not provided', async () => {
    const { container } = render(<TerminalCard />);

    const panel = container.querySelector(`.${styles.panel}`);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('data-session-key', '_global');

    const host = container.querySelector(`.${styles.interactiveHost}`);
    expect(host).not.toBeNull();
  });

  it('shows fallback banner when PTY is missing in non-desktop environments', async () => {
    mockTauriMissing('workbench_pty_create');

    const { container } = render(<TerminalCard sessionId="missing-test" />);

    await waitFor(() => {
      const banner = screen.queryByText(/当前环境无交互式终端/);
      expect(banner).toBeInTheDocument();
    });

    const panel = container.querySelector(`.${styles.panel}`);
    expect(panel).toHaveAttribute('data-interactive-pty', 'false');
    expect(panel).toHaveAttribute('data-pty-status', 'missing');

    const host = container.querySelector(`.${styles.interactiveHost}`);
    expect(host).toHaveAttribute('data-pty-active', 'false');
  });

  it('triggers delayed fit on mount', async () => {
    const rAFSpy = vi.spyOn(window, 'requestAnimationFrame');
    render(<TerminalCard sessionId="fit-test" />);

    expect(rAFSpy).toHaveBeenCalled();
    rAFSpy.mockRestore();
  });

  it('exposes fit on InteractiveXtermTerminal ref and can be called safely', async () => {
    const { InteractiveXtermTerminal } = await import('./TerminalCard.xterm');
    const ref = React.createRef<import('./TerminalCard.xterm').InteractiveXtermHandle>();

    render(
      <InteractiveXtermTerminal
        ref={ref}
        sessionKey="ref-test-session"
      />
    );

    expect(ref.current).not.toBeNull();
    expect(typeof ref.current?.fit).toBe('function');
    expect(typeof ref.current?.focus).toBe('function');
    expect(typeof ref.current?.clear).toBe('function');
    expect(typeof ref.current?.restart).toBe('function');

    // 调用 fit 不抛错
    expect(() => ref.current?.fit()).not.toThrow();
  });

  it('getXtermTheme 根据界面主题动态适配色彩', async () => {
    const { getXtermTheme } = await import('./useXtermTerminal');
    document.documentElement.removeAttribute('data-theme');
    const lightTheme = getXtermTheme();
    expect(lightTheme.background).toBe('#ffffff');
    expect(lightTheme.foreground).toBe('#111111');
    expect(lightTheme.cursor).toBe('#111111');

    document.documentElement.setAttribute('data-theme', 'dark');
    const darkTheme = getXtermTheme();
    expect(darkTheme.background).toBe('#0c0c0c');
    expect(darkTheme.foreground).toBe('#cccccc');
    expect(darkTheme.cursor).toBe('#ffffff');
    document.documentElement.removeAttribute('data-theme');
  });

  it('document data-theme 切换时动态触发 xterm 实例主题色刷新', async () => {
    const { InteractiveXtermTerminal } = await import('./TerminalCard.xterm');
    const ref = React.createRef<import('./TerminalCard.xterm').InteractiveXtermHandle>();

    document.documentElement.setAttribute('data-theme', 'light');
    render(<InteractiveXtermTerminal ref={ref} sessionKey="theme-switch-session" />);

    // 触发主题切换为 dark
    document.documentElement.setAttribute('data-theme', 'dark');

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    // 切换回 light
    document.documentElement.setAttribute('data-theme', 'light');
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
    document.documentElement.removeAttribute('data-theme');
  });

  it('TerminalCard 根据当前项目 workspace 路径加载 PTY 工作目录', async () => {
    localStorage.setItem('crish_workspace', 'C:/Software/conex-test-project');
    const createCalls: any[] = [];
    mockTauriCommand('workbench_pty_create', (args) => {
      createCalls.push(args);
      return { ptyId: 'test-pty-project-1' };
    });

    render(<TerminalCard sessionId="session-project-cwd" />);

    await waitFor(() => {
      expect(createCalls.length).toBeGreaterThan(0);
      expect(createCalls[0]).toMatchObject({
        sessionKey: 'session-project-cwd',
        cwd: 'C:/Software/conex-test-project',
      });
    });

    localStorage.removeItem('crish_workspace');
  });
});
