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
import {
  createPtyWriteGate,
  MAX_PENDING_BYTES,
  CHUNK_FLUSH_BYTES,
  OVERFLOW_WARNING,
} from './ptyWriteGate';
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
    const ref =
      React.createRef<import('./TerminalCard.xterm').InteractiveXtermHandle>();

    render(
      <InteractiveXtermTerminal ref={ref} sessionKey="ref-test-session" />
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
    const { applyPersonalization } =
      await import('../../api/themePersonalization');
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
    expect(root.style.getPropertyValue('--surface-main')).toBeTruthy();
    expect(root.style.getPropertyValue('--surface-input')).toBeTruthy();
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
    expect(root.style.getPropertyValue('--surface-main')).toBeTruthy();
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
    expect(root.style.getPropertyValue('--surface-input')).toBeTruthy();
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
    expect(
      tokensCss.match(/--terminal-fg:\s*var\(--text-primary/g)
    ).toHaveLength(2);
  });

  it('document data-theme 切换时动态触发 xterm 实例主题色刷新', async () => {
    const { InteractiveXtermTerminal } = await import('./TerminalCard.xterm');
    const ref =
      React.createRef<import('./TerminalCard.xterm').InteractiveXtermHandle>();

    document.documentElement.setAttribute('data-theme', 'light');
    render(
      <InteractiveXtermTerminal ref={ref} sessionKey="theme-switch-session" />
    );

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
    const ref =
      React.createRef<import('./TerminalCard.xterm').InteractiveXtermHandle>();

    render(
      <InteractiveXtermTerminal ref={ref} sessionKey="style-switch-session" />
    );

    // 修改 style 属性（如用户切换个性化皮肤调色）
    document.documentElement.style.setProperty('--terminal-bg', '#fafafa');

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue('--terminal-bg')
      ).toBe('#fafafa');
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

describe('ptyWriteGate PTY 流控门闩与异常自愈状态机', () => {
  it('隐藏态遵循 write=0 门闩，仅进入缓冲并在显现后排空', () => {
    const written: string[] = [];
    const gate = createPtyWriteGate({ write: (d) => written.push(d) }, true);

    expect(gate.isHidden()).toBe(true);
    gate.write('chunk-1\n');
    gate.write('chunk-2\n');

    // 隐藏期 strict write=0
    expect(written).toEqual([]);
    expect(gate.pendingCount()).toBe(2);
    expect(gate.pendingLength()).toBe('chunk-1\nchunk-2\n'.length);

    // 显现后排空
    gate.setHidden(false);
    gate.flushAllPending();

    expect(written).toEqual(['chunk-1\n', 'chunk-2\n']);
    expect(gate.pendingCount()).toBe(0);
    expect(gate.pendingLength()).toBe(0);
  });

  it('512KB 有界上限拦截与最旧数据截断', () => {
    const written: string[] = [];
    const gate = createPtyWriteGate({ write: (d) => written.push(d) }, true);

    // 写入 600KB 单块数据（超过 512KB 上限）
    const largePayload = 'A'.repeat(600 * 1024);
    gate.write(largePayload);

    // 必须被有界门闩拦截在 512KB 之内
    expect(gate.pendingLength()).toBeLessThanOrEqual(MAX_PENDING_BYTES);
    expect(gate.pendingLength()).toBe(MAX_PENDING_BYTES);
    expect(gate.hasOverflowWarning()).toBe(true);

    gate.setHidden(false);
    gate.flushAllPending();

    // 合并写入总长度正好等于 512KB
    const totalFlushed = written.join('');
    expect(totalFlushed.length).toBe(MAX_PENDING_BYTES);
    // 头部为 ANSI 警告，尾部为最新的 A 字符
    expect(totalFlushed.startsWith(OVERFLOW_WARNING)).toBe(true);
    expect(totalFlushed.endsWith('A'.repeat(100))).toBe(true);
  });

  it('多块数据累加超过 512KB 时截断最旧块并注入 ANSI 警示', () => {
    const written: string[] = [];
    const gate = createPtyWriteGate({ write: (d) => written.push(d) }, true);

    const chunk1 = '1'.repeat(300 * 1024);
    const chunk2 = '2'.repeat(300 * 1024);
    gate.write(chunk1);
    expect(gate.hasOverflowWarning()).toBe(false);

    gate.write(chunk2);
    expect(gate.hasOverflowWarning()).toBe(true);
    expect(gate.pendingLength()).toBeLessThanOrEqual(MAX_PENDING_BYTES);

    gate.setHidden(false);
    gate.flushAllPending();

    const output = written.join('');
    expect(output.startsWith(OVERFLOW_WARNING)).toBe(true);
    // 最旧的 1 被部分截断，而最新的 2 完整保留在尾部
    expect(output.endsWith(chunk2)).toBe(true);
    expect(output.includes(OVERFLOW_WARNING)).toBe(true);
  });

  it('分片排空：单帧 rAF 写入上限限制在 32KB', () => {
    const written: string[] = [];
    const gate = createPtyWriteGate({ write: (d) => written.push(d) }, true);

    // 写入 100KB 数据
    const payload = 'B'.repeat(100 * 1024);
    gate.write(payload);
    gate.setHidden(false);

    // 帧 1：应精准写入 32KB
    const frame1 = gate.flushFrame();
    expect(frame1.bytesWritten).toBe(CHUNK_FLUSH_BYTES);
    expect(written.length).toBe(1);
    expect(written[0].length).toBe(CHUNK_FLUSH_BYTES);
    expect(frame1.remaining).toBe(100 * 1024 - CHUNK_FLUSH_BYTES);

    // 帧 2：再次写入 32KB
    const frame2 = gate.flushFrame();
    expect(frame2.bytesWritten).toBe(CHUNK_FLUSH_BYTES);
    expect(written.length).toBe(2);
    expect(written[1].length).toBe(CHUNK_FLUSH_BYTES);
    expect(frame2.remaining).toBe(100 * 1024 - 2 * CHUNK_FLUSH_BYTES);

    // 帧 3：再次写入 32KB
    const frame3 = gate.flushFrame();
    expect(frame3.bytesWritten).toBe(CHUNK_FLUSH_BYTES);
    expect(written.length).toBe(3);
    expect(frame3.remaining).toBe(100 * 1024 - 3 * CHUNK_FLUSH_BYTES);

    // 帧 4：剩余 4KB 写入完毕
    const frame4 = gate.flushFrame();
    expect(frame4.bytesWritten).toBe(100 * 1024 - 3 * CHUNK_FLUSH_BYTES);
    expect(frame4.remaining).toBe(0);
    expect(gate.pendingLength()).toBe(0);

    // 验证全部重组后的数据一致性
    expect(written.join('')).toBe(payload);
  });

  it('try/catch 异常捕获与自愈排空状态机，防止白屏', () => {
    let shouldThrow = true;
    const target = {
      write: (data: string) => {
        if (shouldThrow) {
          throw new Error('xterm instance disposed or reset in progress');
        }
      },
    };

    const gate = createPtyWriteGate(target, true);
    gate.write('test-data-before-crash\n');

    gate.setHidden(false);

    // 执行排空，内部应当捕获错误并触发自愈重置，不向上抛出异常
    expect(() => {
      gate.flushFrame();
    }).not.toThrow();

    // 队列应当被清空，避免无效死循环抛错
    expect(gate.pendingCount()).toBe(0);
    expect(gate.pendingLength()).toBe(0);

    // 验证自愈恢复：当底层终端恢复健康后，后续写入与排空正常运作
    shouldThrow = false;
    const healthyWritten: string[] = [];
    const healthyGate = createPtyWriteGate(
      { write: (d) => healthyWritten.push(d) },
      false
    );

    healthyGate.write('recovered-command-output\n');
    healthyGate.flushAllPending();
    expect(healthyWritten).toEqual(['recovered-command-output\n']);
  });

  it('连续多次溢出时不重复堆叠 ANSI 警告，被消费后再次溢出可重新注入', () => {
    const written: string[] = [];
    const gate = createPtyWriteGate({ write: (d) => written.push(d) }, true);

    // 第一次溢出
    gate.write('X'.repeat(400 * 1024));
    gate.write('Y'.repeat(300 * 1024));
    expect(gate.hasOverflowWarning()).toBe(true);

    // 再次写入大块数据造成二次溢出，警告应保持在头部而不重复堆叠
    gate.write('Z'.repeat(200 * 1024));
    expect(gate.pendingLength()).toBeLessThanOrEqual(MAX_PENDING_BYTES);

    gate.setHidden(false);
    gate.flushAllPending();

    const output = written.join('');
    // 头部有且仅出现一次 ANSI 警告
    const matches = output.match(
      /\[Conex Stream Gate: High output rate capped at 512KB\]/g
    );
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(1);

    // 此时队列已排空，警告已被消费
    expect(gate.hasOverflowWarning()).toBe(false);

    // 再次涌入超过 512KB 数据，应当能重新注入新的警告
    gate.setHidden(true);
    gate.write('W'.repeat(600 * 1024));
    expect(gate.hasOverflowWarning()).toBe(true);
  });
});
