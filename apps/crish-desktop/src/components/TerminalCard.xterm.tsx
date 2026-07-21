/**
 * xterm.js 终端渲染适配器。
 * 替换 parseAnsi 的 DOM 逐行渲染，提供完整 ANSI 转义序列支持、GPU 加速（WebGL）与自适应宽度。
 *
 * 使用方式：
 *   <XtermAdapter lines={lines} searchQuery={query} />
 *
 * 依赖（需在 package.json 中声明）：
 *   @xterm/xterm @xterm/addon-webgl @xterm/addon-fit
 */
import React, { useEffect, useId, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';

export interface XtermAdapterProps {
  /** 输出行数组（每行一条 string，可含 ANSI 转义序列） */
  lines: readonly string[];
  /** 当前搜索过滤关键词（用于高亮匹配行） */
  searchQuery?: string;
}

export const XtermAdapter: React.FC<XtermAdapterProps> = ({ lines, searchQuery }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const prevLinesLenRef = useRef(0);
  const reactId = useId();
  const termId = `${reactId}-xterm`;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'underline',
      disableStdin: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
      lineHeight: 1.35,
      theme: {
        background: 'transparent',
        foreground: '#d4d4d4',
        cursor: 'transparent',
      },
      allowTransparency: true,
      convertEol: true,
      cols: 80,
      rows: 20,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    term.open(container);

    try {
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
    } catch {
      // WebGL 不可用时静默降级（canvas 2d fallback）
    }

    // 初次自适应
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });

    termRef.current = term;

    return () => {
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // 写行数据到终端
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const prevLen = prevLinesLenRef.current;
    if (lines.length < prevLen) {
      term.reset();
      prevLinesLenRef.current = 0;
    }

    const newLines = lines.slice(prevLinesLenRef.current);
    if (newLines.length === 0) return;

    const text = newLines.join('\r\n') + '\r\n';
    term.write(text);
    prevLinesLenRef.current = lines.length;
  }, [lines]);

  // 搜索滚动：跳到第一个匹配行
  useEffect(() => {
    if (!searchQuery || !termRef.current) return;
    const term = termRef.current;
    const q = searchQuery.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(q)) {
        term.scrollToLine(i);
        break;
      }
    }
  }, [searchQuery, lines]);

  // 窗口 resize 时自适应
  useEffect(() => {
    const fitAddon = fitAddonRef.current;
    if (!fitAddon) return;
    const ro = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });
    const el = containerRef.current;
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      id={termId}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
      role="log"
      aria-label="终端输出（xterm.js）"
      aria-live="polite"
      aria-relevant="additions"
    />
  );
};
