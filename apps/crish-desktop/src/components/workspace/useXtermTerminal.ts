/**
 * useXtermTerminal：xterm 实例 + PTY 生命周期 + 容器尺寸适配的装配 hook。
 * 从 TerminalCard.xterm.tsx 提取，将 150 行 `start` 与 resize 观察逻辑收敛于此。
 *
 * 职责：
 * - 创建 Terminal / FitAddon / WebglAddon（仅挂载一次）
 * - PTY ensure/reuse/kill + 输入桥接（onData → ptyWrite，subscribePtyOutput → term.write）
 * - ResizeObserver/fit → ptyResize（拖拽分屏降采样）
 *
 * 策略 A（折坞复用）：unmount / 切 sessionKey 不 kill；closeTab/reset/restart 经 registry.take。
 */
import { useEffect, useId, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { ptyResize, ptyWrite } from '../../api/ptySessionApi';
import { parseColorToOklch } from '../../api/oklchColorGuard';
import { ResizeObserverManager } from '../../services/ResizeObserverManager';
import { useLayoutAnimationStore } from '../../store/layoutAnimationStore';
import type { InteractiveXtermStatus } from './TerminalCard.xterm';
import { startPtySession } from './ptyLifecycle';

/** 读取 CSS 变量，缺失或 SSR 时回落 fallback。支持多级 var(--x, fallback) 嵌套解包。 */
function readCssVar(name: string, fallback = ''): string {
  try {
    if (typeof document === 'undefined') return fallback;
    let v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!v) return fallback;
    let depth = 0;
    while (v.startsWith('var(') && depth < 5) {
      depth++;
      const match = v.match(/^var\(\s*(--[\w-]+)(?:\s*,\s*([\s\S]+?))?\s*\)$/);
      if (!match || !match[1]) break;
      const innerName = match[1];
      const innerFallback = match[2]?.trim() || '';
      const resolved = getComputedStyle(document.documentElement).getPropertyValue(innerName).trim();
      v = resolved || innerFallback;
    }
    return v || fallback;
  } catch {
    return fallback;
  }
}

/**
 * 根据当前文档主题及 CSS 变量构建 xterm 调色板。
 * 遵循主题色动态自适应规范：
 * - 浅色模式（light/default/无属性）：纯白底色（#ffffff / --bg-card），深灰/黑前景色（--text-primary）与光标；
 * - 深色模式（dark）：深黑底色（#0c0c0c），亮灰前景色（#cccccc）与白色光标。
 */
export function getXtermTheme() {
  const isDark =
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') === 'dark';
  const defaultBg = isDark ? '#0c0c0c' : '#ffffff';
  const defaultFg = isDark ? '#cccccc' : '#111111';
  const defaultCursor = isDark ? '#ffffff' : '#111111';
  const defaultSelection = isDark
    ? 'rgba(255, 255, 255, 0.25)'
    : 'rgba(0, 0, 0, 0.15)';

  const bg = readCssVar('--terminal-bg', defaultBg) || defaultBg;
  let fg = readCssVar('--terminal-fg', defaultFg) || defaultFg;
  const cursor = readCssVar('--terminal-cmd', defaultCursor) || defaultCursor;
  const selection =
    readCssVar('--xterm-selection', defaultSelection) || defaultSelection;

  // 确保背景色与前景色具备足够对比度，防止在浅色/深色主题下前景色隐形
  try {
    const bgOklch = parseColorToOklch(bg, isDark);
    const fgOklch = parseColorToOklch(fg, isDark);
    if (!Number.isNaN(bgOklch.l) && !Number.isNaN(fgOklch.l)) {
      if (Math.abs(bgOklch.l - fgOklch.l) < 0.35) {
        fg = bgOklch.l > 0.52 ? '#111111' : '#cccccc';
      }
    }
  } catch {
    /* swallow-ok: 颜色解析异常时维持原值 */
  }

  return {
    background: bg,
    foreground: fg,
    cursor,
    cursorAccent: bg,
    selectionBackground: selection,
    selectionForeground: fg,
    black: readCssVar('--xterm-black', '#0c0c0c') || '#0c0c0c',
    red: readCssVar('--xterm-red', '#c50f1f') || '#c50f1f',
    green:
      readCssVar('--xterm-green', isDark ? '#4ade80' : '#13a10e') ||
      (isDark ? '#4ade80' : '#13a10e'),
    yellow:
      readCssVar('--xterm-yellow', isDark ? '#fbbf24' : '#b45309') ||
      (isDark ? '#fbbf24' : '#b45309'),
    blue:
      readCssVar('--xterm-blue', isDark ? '#60a5fa' : '#1d4ed8') ||
      (isDark ? '#60a5fa' : '#1d4ed8'),
    magenta:
      readCssVar('--xterm-magenta', isDark ? '#c084fc' : '#86198f') ||
      (isDark ? '#c084fc' : '#86198f'),
    cyan:
      readCssVar('--xterm-cyan', isDark ? '#22d3ee' : '#0e7490') ||
      (isDark ? '#22d3ee' : '#0e7490'),
    white:
      readCssVar('--xterm-white', isDark ? '#e5e5e5' : '#24292f') ||
      (isDark ? '#e5e5e5' : '#24292f'),
    brightBlack:
      readCssVar('--xterm-bright-black', isDark ? '#6b7280' : '#57606a') ||
      (isDark ? '#6b7280' : '#57606a'),
    brightRed:
      readCssVar('--xterm-bright-red', isDark ? '#fca5a5' : '#dc2626') ||
      (isDark ? '#fca5a5' : '#dc2626'),
    brightGreen:
      readCssVar('--xterm-bright-green', isDark ? '#86efac' : '#16a34a') ||
      (isDark ? '#86efac' : '#16a34a'),
    brightYellow:
      readCssVar('--xterm-bright-yellow', isDark ? '#fde68a' : '#ca8a04') ||
      (isDark ? '#fde68a' : '#ca8a04'),
    brightBlue:
      readCssVar('--xterm-bright-blue', isDark ? '#93c5fd' : '#2563eb') ||
      (isDark ? '#93c5fd' : '#2563eb'),
    brightMagenta:
      readCssVar('--xterm-bright-magenta', isDark ? '#d8b4fe' : '#9333ea') ||
      (isDark ? '#d8b4fe' : '#9333ea'),
    brightCyan:
      readCssVar('--xterm-bright-cyan', isDark ? '#67e8f9' : '#0891b2') ||
      (isDark ? '#67e8f9' : '#0891b2'),
    brightWhite:
      readCssVar('--xterm-bright-white', isDark ? '#ffffff' : '#0f1419') ||
      (isDark ? '#ffffff' : '#0f1419'),
  };
}

export interface UseXtermTerminalArgs {
  sessionKey: string;
  cwd?: string;
  restartToken?: number;
  onStatusChange?: (status: InteractiveXtermStatus, detail?: string) => void;
  onPtyMissing?: () => void;
}

export interface UseXtermTerminalResult {
  /** 挂载 xterm 的容器节点 ref */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 稳定 DOM id（用于容器 + reactId 派生） */
  termDomId: string;
  /** 当前 ptyId（渲染层用于 data-* 属性）；每次 start/exit 后刷新 */
  ptyIdRef: React.RefObject<string | null>;
  /** 父级 restartToken 之外的本地强制重建计数；restart 暴露给 imperative handle */
  localRestart: number;
  /** 触发本地强制重建（imperative handle.restart 调用） */
  bumpLocalRestart: () => void;
  /** 终端实例 ref（imperative handle.focus/clear 读取） */
  termRef: React.RefObject<Terminal | null>;
  /** 手动重新测量与适配尺寸 */
  fit: () => void;
}

/**
 * 装配 xterm 实例 + PTY 生命周期 + resize 适配。
 * 返回的 refs 供组件渲染与 imperative handle 共享；hook 自身管理副作用清理。
 */
export function useXtermTerminal({
  sessionKey,
  cwd,
  restartToken = 0,
  onStatusChange,
  onPtyMissing,
}: UseXtermTerminalArgs): UseXtermTerminalResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const sessionKeyRef = useRef(sessionKey);
  const cwdRef = useRef(cwd);
  const onStatusRef = useRef(onStatusChange);
  const onMissingRef = useRef(onPtyMissing);
  /** 父级 restartToken 之外的本地强制重建计数 */
  const [localRestart, setLocalRestart] = useState(0);
  /** 用于区分「折坞复用」vs「用户 restart 强制重建」 */
  const prevLifecycleRef = useRef({
    sessionKey,
    restartToken,
    localRestart,
  });
  const reactId = useId();
  const termDomId = `${reactId}-xterm-pty`;

  sessionKeyRef.current = sessionKey;
  cwdRef.current = cwd;
  onStatusRef.current = onStatusChange;
  onMissingRef.current = onPtyMissing;

  // ── 创建 xterm 实例（仅挂载一次）────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      disableStdin: false,
      fontSize: 13,
      fontWeight: '500',
      fontWeightBold: '700',
      // 字体 SSOT（audit-repair-202609 T4）：canvas 不解析 CSS 变量，经
      // computed style 读取 --font-mono 的具体字体栈（与全应用等宽字一致，
      // fontStore 个性化后亦自动跟随）；读取失败回落内置兜底栈。
      fontFamily:
        readCssVar(
          '--font-mono',
          "'Cascadia Mono', 'Cascadia Code', 'Consolas', monospace"
        )
          .replace(/\s+/g, ' ')
          .trim() || "'Cascadia Mono', 'Cascadia Code', 'Consolas', monospace",
      lineHeight: 1.35,
      theme: getXtermTheme(),
      allowTransparency: true,
      convertEol: true,
      scrollback: 5000,
      cols: 80,
      rows: 24,
    });

    // 监听 html[data-theme] 与 style 属性变化，当主题在 light/dark 或字体偏好切换时，实时动态同步 xterm 主题色彩与等宽字体
    const updateTerminalStyles = () => {
      try {
        term.options.theme = getXtermTheme();
        const nextMono = readCssVar(
          '--font-mono',
          "'Cascadia Mono', 'Cascadia Code', 'Consolas', monospace"
        )
          .replace(/\s+/g, ' ')
          .trim();
        if (nextMono && term.options.fontFamily !== nextMono) {
          term.options.fontFamily = nextMono;
          fitAddonRef.current?.fit();
        }
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {
        /* swallow-ok: 终端卸载或已被 dispose 时更新静默跳过 */
      }
    };

    let themeObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      themeObserver = new MutationObserver(updateTerminalStyles);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'style'],
      });
    }

    const handleFontChange = () => {
      updateTerminalStyles();
    };
    const handleTokensChange = () => {
      updateTerminalStyles();
    };
    window.addEventListener('crish-fonts-changed', handleFontChange);
    window.addEventListener('crish-tokens-updated', handleTokensChange);
    window.addEventListener('crish-canvas-recolor', handleTokensChange);

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    term.open(container);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try {
          webgl.dispose();
        } catch {
          /* swallow-ok: WebGL 上下文已丢失时 dispose 幂等降级 */
        }
      });
      term.loadAddon(webgl);
    } catch {
      // swallow-ok: WebGL 不可用时静默降级 canvas 2d
    }

    let innerRaf = 0;
    const rafId = requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        /* swallow-ok: 容器尚未布局完成时 fit 失败，下一帧重试 */
      }
      // 延迟一帧再次 fit，确保终端字符网格正常铺开
      innerRaf = requestAnimationFrame(() => {
        try {
          fitAddon.fit();
          const t = termRef.current;
          const id = ptyIdRef.current;
          if (t && id) {
            void ptyResize(id, t.cols, t.rows);
          }
        } catch {
          /* swallow-ok */
        }
      });
    });

    // stdin → PTY（按当前 ptyId 过滤，避免会话切换竞态）
    const dataDisp = term.onData((data) => {
      const id = ptyIdRef.current;
      if (!id) return;
      void ptyWrite(id, data);
    });

    termRef.current = term;

    return () => {
      if (themeObserver) {
        themeObserver.disconnect();
      }
      window.removeEventListener('crish-fonts-changed', handleFontChange);
      window.removeEventListener('crish-tokens-updated', handleTokensChange);
      window.removeEventListener('crish-canvas-recolor', handleTokensChange);
      cancelAnimationFrame(rafId);
      if (innerRaf) cancelAnimationFrame(innerRaf);
      dataDisp.dispose();
      try {
        term.dispose();
      } catch {
        /* swallow-ok: 组件卸载路径 dispose 失败不影响其余清理 */
      }
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // ── PTY 生命周期：sessionKey / restart / cwd 变化 ─────────────────
  //
  // start 函数体已提取为纯函数 startPtySession（见 ptyLifecycle.ts），
  // 本 effect 仅做 ref 读取 + cancellation token + 依赖注入 + 清理。
  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    let cancelled = false;
    let activePtyId: string | null = null;
    const disposables: (() => void)[] = [];

    const key = (sessionKey || '').trim() || '_global';

    void startPtySession({
      term,
      fitAddon,
      key,
      restartToken,
      localRestart,
      cwdRef,
      onStatus: (status, detail) => onStatusRef.current?.(status, detail),
      onMissing: () => onMissingRef.current?.(),
      prevLifecycle: prevLifecycleRef,
      ptyIdRef,
      cancellation: { isCancelled: () => cancelled },
      setActivePtyId: (id) => {
        activePtyId = id;
      },
      addDisposable: (fn) => disposables.push(fn),
    });

    return () => {
      cancelled = true;
      for (const fn of disposables) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      disposables.length = 0;
      // 策略 A：卸载 / 切 session **不** kill PTY；仅 closeTab 经 registry.take 杀
      const id = activePtyId;
      activePtyId = null;
      if (ptyIdRef.current === id) {
        ptyIdRef.current = null;
      }
    };
  }, [sessionKey, restartToken, localRestart, cwd]);

  // ── 容器尺寸变化 → fit + ptyResize ────────────────────────────────
  // 拖拽分屏时 body.tree-resizing / is-resizing 期间降采样，避免 xterm
  // 每帧 fit/WebGL 重绘导致闪烁频率高于右侧其它面板。
  useEffect(() => {
    const fitAddon = fitAddonRef.current;
    const el = containerRef.current;
    if (!fitAddon || !el) return;

    let raf = 0;
    let throttleTimer = 0;
    let lastCols = 0;
    let lastRows = 0;
    let lastFitAt = 0;

    const isLayoutResizing = () => {
      try {
        const b = document.body;
        if (
          b.classList.contains('tree-resizing') ||
          b.classList.contains('is-resizing') ||
          b.classList.contains('resizing-active') ||
          b.classList.contains('workspace-resizing')
        ) {
          return true;
        }
        if (
          typeof document !== 'undefined' &&
          document.documentElement.dataset.layoutFrozen === 'true'
        ) {
          return true;
        }
        if (useLayoutAnimationStore.getState().activeAnimations.size > 0) {
          return true;
        }
        return false;
      } catch {
        return false;
      }
    };

    const doFit = () => {
      if (isLayoutResizing()) return;
      const term = termRef.current;
      if (!term || !fitAddonRef.current) return;
      try {
        fitAddonRef.current.fit();
      } catch {
        return;
      }
      lastFitAt = performance.now();
      const cols = term.cols;
      const rows = term.rows;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      const id = ptyIdRef.current;
      if (id) {
        void ptyResize(id, cols, rows);
      }
    };

    const scheduleFit = () => {
      // 拖拽 / 动画期间彻底挂起（Zero-JS / 0 fit / 0 IPC），等 resize-settled 广播后单次补偿下发
      if (isLayoutResizing()) {
        return;
      }

      const now = performance.now();
      const wait = Math.max(0, 32 - (now - lastFitAt));

      if (wait > 0) {
        if (throttleTimer) return;
        throttleTimer = window.setTimeout(() => {
          throttleTimer = 0;
          if (raf) cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            raf = 0;
            if (!isLayoutResizing()) {
              doFit();
            }
          });
        }, wait);
        return;
      }

      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!isLayoutResizing()) {
          doFit();
        }
      });
    };

    const roManager = ResizeObserverManager.getInstance();
    const handleResize = () => {
      scheduleFit();
    };
    roManager.observe(el, handleResize);

    const onResizeSettled = () => {
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = 0;
      }
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (!isLayoutResizing()) {
        doFit();
      }
    };
    window.addEventListener('app:window-resize-settled', onResizeSettled, {
      passive: true,
    });

    return () => {
      roManager.unobserve(el, handleResize);
      window.removeEventListener('app:window-resize-settled', onResizeSettled);
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = 0;
      }
    };
  }, []);

  const fit = () => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;
    try {
      fitAddon.fit();
      const id = ptyIdRef.current;
      if (id) {
        void ptyResize(id, term.cols, term.rows);
      }
    } catch {
      /* swallow-ok: 容器尚未布局完成时 fit 失败，下一帧重试 */
    }
  };

  return {
    containerRef,
    termDomId,
    ptyIdRef,
    localRestart,
    bumpLocalRestart: () => setLocalRestart((n) => n + 1),
    termRef,
    fit,
  };
}
