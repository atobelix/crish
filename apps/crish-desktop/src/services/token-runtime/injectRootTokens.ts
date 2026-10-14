/**
 * apps/crish-desktop/src/services/token-runtime/injectRootTokens.ts
 *
 * 根元素 Token 注入与主题属性/类名切换。
 * 拆分来源：services/TokenRuntimeController.ts 的 applyTokens（行数门禁收口，行为不变）。
 */

import type { UiTheme } from '../../api/themeTypes';

export function injectRootTokens(args: {
  tokens: Record<string, string>;
  resolvedTheme: UiTheme;
  isDark: boolean;
  injectedKeys: Set<string>;
}): void {
  const { tokens, resolvedTheme, isDark, injectedKeys } = args;
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  root.setAttribute('data-theme', resolvedTheme);
  if (document.body) {
    document.body.setAttribute('data-theme', resolvedTheme);
  }

  root.classList.toggle('theme-dark', isDark);
  root.classList.toggle('theme-light', !isDark);
  if (document.body) {
    document.body.classList.toggle('theme-dark', isDark);
    document.body.classList.toggle('theme-light', !isDark);
  }

  for (const oldKey of injectedKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(tokens, oldKey) &&
      oldKey !== '--ui-scale'
    ) {
      root.style.removeProperty(oldKey);
      injectedKeys.delete(oldKey);
    }
  }

  // 全仓唯一合法注入点：显式受控注入，满足 style-contract 静态同源契约与精准应用
  // （T7 别名收敛后只写独立侧：surface-* / text-* / border-* / control-* / composer-bg /
  //   accent-* / bg-tertiary / shell-chrome-bg / font-size-adjust；
  //   bg-primary/secondary/card/elevated/paper/workspace、shell-inset-bg、terminal-*
  //   由 tokens.css 静态链从 surface-* 派生，不再注入）
  if (tokens['--font-size-adjust'])
    root.style.setProperty('--font-size-adjust', tokens['--font-size-adjust']);
  if (tokens['--surface-outer'])
    root.style.setProperty('--surface-outer', tokens['--surface-outer']);
  if (tokens['--surface-main'])
    root.style.setProperty('--surface-main', tokens['--surface-main']);
  if (tokens['--surface-input'])
    root.style.setProperty('--surface-input', tokens['--surface-input']);
  if (tokens['--text-primary'])
    root.style.setProperty('--text-primary', tokens['--text-primary']);
  if (tokens['--text-secondary'])
    root.style.setProperty('--text-secondary', tokens['--text-secondary']);
  if (tokens['--text-tertiary'])
    root.style.setProperty('--text-tertiary', tokens['--text-tertiary']);
  if (tokens['--text-muted'])
    root.style.setProperty('--text-muted', tokens['--text-muted']);
  if (tokens['--text-faint'])
    root.style.setProperty('--text-faint', tokens['--text-faint']);
  if (tokens['--border-color'])
    root.style.setProperty('--border-color', tokens['--border-color']);
  if (tokens['--border-subtle'])
    root.style.setProperty('--border-subtle', tokens['--border-subtle']);
  if (tokens['--control-mix-color'])
    root.style.setProperty(
      '--control-mix-color',
      tokens['--control-mix-color']
    );
  if (tokens['--accent-green-light-adaptive'])
    root.style.setProperty(
      '--accent-green-light-adaptive',
      tokens['--accent-green-light-adaptive']
    );
  if (tokens['--accent-red-light-adaptive'])
    root.style.setProperty(
      '--accent-red-light-adaptive',
      tokens['--accent-red-light-adaptive']
    );
  if (tokens['--scrollbar-thumb-bg'])
    root.style.setProperty(
      '--scrollbar-thumb-bg',
      tokens['--scrollbar-thumb-bg']
    );
  if (tokens['--scrollbar-thumb-active'])
    root.style.setProperty(
      '--scrollbar-thumb-active',
      tokens['--scrollbar-thumb-active']
    );
  if (tokens['--scrollbar-button-up'])
    root.style.setProperty(
      '--scrollbar-button-up',
      tokens['--scrollbar-button-up']
    );
  if (tokens['--scrollbar-button-down'])
    root.style.setProperty(
      '--scrollbar-button-down',
      tokens['--scrollbar-button-down']
    );
  if (tokens['--scrollbar-button-left'])
    root.style.setProperty(
      '--scrollbar-button-left',
      tokens['--scrollbar-button-left']
    );
  if (tokens['--scrollbar-button-right'])
    root.style.setProperty(
      '--scrollbar-button-right',
      tokens['--scrollbar-button-right']
    );
  if (tokens['--scrollbar-button-up-active'])
    root.style.setProperty(
      '--scrollbar-button-up-active',
      tokens['--scrollbar-button-up-active']
    );
  if (tokens['--scrollbar-button-down-active'])
    root.style.setProperty(
      '--scrollbar-button-down-active',
      tokens['--scrollbar-button-down-active']
    );
  if (tokens['--scrollbar-button-left-active'])
    root.style.setProperty(
      '--scrollbar-button-left-active',
      tokens['--scrollbar-button-left-active']
    );
  if (tokens['--scrollbar-button-right-active'])
    root.style.setProperty(
      '--scrollbar-button-right-active',
      tokens['--scrollbar-button-right-active']
    );

  for (const key of Object.keys(tokens)) {
    injectedKeys.add(key);
  }
}
