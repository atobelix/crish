// @vitest-environment jsdom
/**
 * TerminalCard 单元测试
 * 验证终端面板真实接入、样式类名注入、xterm 渲染与 PTY 交互生命周期。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

  it('getXtermTheme 保证浅色与深色模式下的 ANSI 白/亮白/黑色契约', async () => {
    const { getXtermTheme } = await import('./useXtermTerminal');
    // 浅色模式
    document.documentElement.removeAttribute('data-theme');
    const light = getXtermTheme();
    expect(light.black).toBe('#0c0c0c');
    expect(light.white).toBe('#24292f');
    expect(light.brightWhite).toBe('#0f1419');

    // 深色模式
    document.documentElement.setAttribute('data-theme', 'dark');
    const dark = getXtermTheme();
    expect(dark.black).toBe('#0c0c0c');
    expect(dark.white).toBe('#e5e5e5');
    expect(dark.brightWhite).toBe('#ffffff');
    document.documentElement.removeAttribute('data-theme');
  });

  it('getXtermTheme 对比度守卫防前景色在浅色/深色底上隐形', async () => {
    const { getXtermTheme } = await import('./useXtermTerminal');
    const root = document.documentElement;

    // 当背景与前景同为浅色（如都为白色），前景色应自动提升对比度至深灰黑
    root.style.setProperty('--terminal-bg', '#ffffff');
    root.style.setProperty('--terminal-fg', '#ffffff');
    const guardedLight = getXtermTheme();
    expect(guardedLight.foreground).toBe('#111111');

    // 当背景与前景同为深色（如都为黑色），前景色应自动提升对比度至浅灰白
    root.style.setProperty('--terminal-bg', '#000000');
    root.style.setProperty('--terminal-fg', '#000000');
    const guardedDark = getXtermTheme();
    expect(guardedDark.foreground).toBe('#cccccc');

    root.style.removeProperty('--terminal-bg');
    root.style.removeProperty('--terminal-fg');
  });

  it('applyPersonalization 注入 surface/text 独立侧；--terminal-* 由 tokens.css 派生（不再 JS 注入）', async () => {
    const { applyPersonalization } = await import('../../api/themePersonalization');
    const root = document.documentElement;

    // 1. 应用 warm-gray 浅色皮肤
    applyPersonalization(
      {
        fontSizeAdjust: 0,
        skin: 'warm-gray',
        themeBrightnessAdjust: 0,
        themeAutoTimeTransition: false,
        themeBrightnessVibrant: false,
        customBg: '#ffffff',
        customFg: '#111111',
      },
      'default'
    );
    // T7 别名收敛（2026-09-12）：JS 只写「独立侧」surface-* / text-* / border-*，
    // --bg-* / --shell-inset-bg / --terminal-* 一律由 tokens.css 静态链从
    // surface-* 派生（TokenRuntimeController.ts:437-455 与 :484-487 注释明写）。
    expect(root.style.getPropertyValue('--surface-paper')).toBeTruthy();
    expect(root.style.getPropertyValue('--surface-card')).toBeTruthy();
    expect(root.style.getPropertyValue('--text-primary')).toBeTruthy();
    // 反向锁定：JS 不得再写 --terminal-*（单点真源在 tokens.css）
    expect(root.style.getPropertyValue('--terminal-bg')).toBe('');
    expect(root.style.getPropertyValue('--terminal-fg')).toBe('');
    expect(root.style.getPropertyValue('--terminal-cmd')).toBe('');

    // 2. 应用 dark-cozy 深色皮肤
    applyPersonalization(
      {
        fontSizeAdjust: 0,
        skin: 'dark-cozy',
        themeBrightnessAdjust: 0,
        themeAutoTimeTransition: false,
        themeBrightnessVibrant: false,
        customBg: '#18181b',
        customFg: '#f4f4f5',
      },
      'dark'
    );
    expect(root.style.getPropertyValue('--surface-paper')).toBeTruthy();
    expect(root.style.getPropertyValue('--text-primary')).toBeTruthy();
    expect(root.style.getPropertyValue('--terminal-bg')).toBe('');

    // 3. 未知皮肤 → 回落 warm-gray 预设（TokenRuntimeController.ts:222
    //    `SKIN_PRESETS[skinKey] || SKIN_PRESETS['warm-gray']`），仍写独立侧
    applyPersonalization(
      {
        fontSizeAdjust: 0,
        skin: 'non-existent-skin' as any,
        themeBrightnessAdjust: 0,
        themeAutoTimeTransition: false,
        themeBrightnessVibrant: false,
        customBg: '#ffffff',
        customFg: '#111111',
      },
      'default'
    );
    expect(root.style.getPropertyValue('--surface-card')).toBeTruthy();
    expect(root.style.getPropertyValue('--terminal-bg')).toBe('');

    // 4. --terminal-* 单点真源 = tokens.css（浅/深各一套派生链）
    const tokensCss = fs.readFileSync(
      path.resolve(__dirname, '../../styles/tokens.css'),
      'utf-8'
    );
    expect(tokensCss).toContain('--terminal-bg: var(--bg-card');
    expect(tokensCss).toContain('--terminal-fg: var(--text-primary');
    expect(tokensCss).toContain('--terminal-cmd: var(--text-primary');
    expect(tokensCss.match(/--terminal-bg:\s*var\(--bg-card/g)).toHaveLength(2);
    expect(tokensCss.match(/--terminal-fg:\s*var\(--text-primary/g)).toHaveLength(2);
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

  it('document style 变化时通过 MutationObserver 触发 xterm 实例主题色刷新', async () => {
    const { InteractiveXtermTerminal } = await import('./TerminalCard.xterm');
    const ref = React.createRef<import('./TerminalCard.xterm').InteractiveXtermHandle>();

    render(<InteractiveXtermTerminal ref={ref} sessionKey="style-switch-session" />);

    // 修改 style 属性（如用户切换个性化皮肤调色）
    document.documentElement.style.setProperty('--terminal-bg', '#fafafa');

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--terminal-bg')).toBe('#fafafa');
    });

    document.documentElement.style.removeProperty('--terminal-bg');
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

  it('复用已有 PTY 时从环形缓冲自动重放历史输出并刷新', async () => {
    const { Terminal } = await import('@xterm/xterm');
    const writeSpy = vi.spyOn(Terminal.prototype, 'write');

    const { recordPtyOutputHistory } = await import('../../api/ptySessionApi');
    const { registerPtyBinding } = await import('../../api/ptyRegistry');

    // 预置已有 sessionKey ↔ ptyId 绑定（模拟折坞重开或跨会话重连）
    registerPtyBinding('session-reuse-replay', 'reused-pty-test-1');
    recordPtyOutputHistory('reused-pty-test-1', 'PowerShell 7.4.5\r\n');
    recordPtyOutputHistory('reused-pty-test-1', 'PS C:\\repo> npm test\r\n');

    // D8.1「隐藏终端 write=0」门闩（ptyWriteGate.ts）：隐藏期 chunk 只进
    // pending 缓冲、不直写 term。jsdom 下 `isTerminalHostHidden` 因
    // offsetParent 恒为 null 会判定为「隐藏」，故必须以产品同源标记
    // `data-active-panel="true"`（TreeLeafPanel 真源）声明宿主可见，
    // 否则重放被缓冲、断言恒 0 次（假红）。
    const { container } = render(
      <div data-active-panel="true">
        <TerminalCard sessionId="session-reuse-replay" />
      </div>
    );

    await waitFor(() => {
      const panel = container.querySelector(`.${styles.panel}`);
      expect(panel).toHaveAttribute('data-pty-status', 'ready');
    });

    // 验证历史 chunks 被依次写入 terminal（复用 PTY → 从环形缓冲重放）
    await waitFor(() => {
      expect(writeSpy).toHaveBeenCalledWith('PowerShell 7.4.5\r\n');
    });
    expect(writeSpy).toHaveBeenCalledWith('PS C:\\repo> npm test\r\n');

    writeSpy.mockRestore();
  });
});
