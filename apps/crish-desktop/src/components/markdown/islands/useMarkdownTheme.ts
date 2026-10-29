/**
 * 读取并订阅应用主题（data-theme 属性）。
 *
 * Island（Mermaid）需要随明暗主题重渲染；这里只观察 DOM 主题属性，
 * 不耦合 themeStore 的内部状态，避免渲染面反向依赖 store 实现。
 */
import { useEffect, useState } from 'react';

export type MarkdownTheme = 'light' | 'dark';

function readTheme(): MarkdownTheme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark'
    ? 'dark'
    : 'light';
}

export function useMarkdownTheme(): MarkdownTheme {
  const [theme, setTheme] = useState<MarkdownTheme>(readTheme);

  useEffect(() => {
    const update = () => setTheme(readTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    window.addEventListener('crish-theme-changed', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('crish-theme-changed', update);
    };
  }, []);

  return theme;
}
