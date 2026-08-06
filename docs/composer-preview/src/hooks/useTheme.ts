/**
 * useTheme — 主题切换 Hook
 *
 * 职责：
 * 1. 从 localStorage 读取用户偏好（如果有）
 * 2. 否则检测系统偏好（prefers-color-scheme）
 * 3. 切换时同步写入 data-theme 属性和 localStorage
 *
 * 使用方式：
 * ```tsx
 * const { theme, toggle } = useTheme();
 * <button onClick={toggle}>{theme === 'dark' ? '☀️' : '🌙'}</button>
 * ```
 */

import { useState, useEffect, useCallback } from 'react';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'conex-composer-theme';

function getInitialTheme(): Theme {
  // 优先读 localStorage
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;

  // 检测系统偏好
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }

  return 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  /* 初始化 + 同步 DOM */
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  /* 监听系统主题变化（仅在用户未手动设置时跟随） */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      // 如果用户已手动设置过，不跟随系统
      if (localStorage.getItem(STORAGE_KEY)) return;
      setTheme(e.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  const set = useCallback((t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t);
    setTheme(t);
  }, []);

  return { theme, toggle, set } as const;
}
