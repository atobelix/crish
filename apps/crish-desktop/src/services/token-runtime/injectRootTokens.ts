/**
 * apps/crish-desktop/src/services/token-runtime/injectRootTokens.ts
 *
 * 根元素 Token 注入与主题属性/类名切换。
 * P1/P2 收口：向根节点写入 --user-surface-base / --user-surface-tint / --user-surface-deep /
 * --elev-direction / --text-base；Wave 1 过渡期同步保留旧参数注入以免破坏未清理的外部集成测试。
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

  // 全仓唯一合法注入点：写入名必须保持字面量（check-token-ssot 门禁按 setProperty 字面名扫描）。
  if (tokens['--font-size-adjust'])
    root.style.setProperty('--font-size-adjust', tokens['--font-size-adjust']);

  // P1 表面阶梯基准参数与 P2 单一文字基准参数（SSOT）
  if (tokens['--user-surface-base'])
    root.style.setProperty(
      '--user-surface-base',
      tokens['--user-surface-base']
    );
  if (tokens['--user-surface-tint'])
    root.style.setProperty(
      '--user-surface-tint',
      tokens['--user-surface-tint']
    );
  if (tokens['--user-surface-deep'])
    root.style.setProperty(
      '--user-surface-deep',
      tokens['--user-surface-deep']
    );
  if (tokens['--elev-direction'])
    root.style.setProperty('--elev-direction', tokens['--elev-direction']);
  if (tokens['--user-elev-direction'])
    root.style.setProperty(
      '--user-elev-direction',
      tokens['--user-elev-direction']
    );
  if (tokens['--text-base'])
    root.style.setProperty('--text-base', tokens['--text-base']);

  // [WAVE2-DEPRECATED] Wave 1 过渡期内同步写入旧参数名，以免破坏尚未清理的外部集成测试
  if (tokens['--user-surface-outer'])
    root.style.setProperty(
      '--user-surface-outer',
      tokens['--user-surface-outer']
    ); // [WAVE2-DEPRECATED]
  if (tokens['--user-surface-main'])
    root.style.setProperty(
      '--user-surface-main',
      tokens['--user-surface-main']
    ); // [WAVE2-DEPRECATED]
  if (tokens['--user-surface-input'])
    root.style.setProperty(
      '--user-surface-input',
      tokens['--user-surface-input']
    ); // [WAVE2-DEPRECATED]
  if (tokens['--user-text-primary'])
    root.style.setProperty(
      '--user-text-primary',
      tokens['--user-text-primary']
    ); // [WAVE2-DEPRECATED]
  if (tokens['--user-text-secondary'])
    root.style.setProperty(
      '--user-text-secondary',
      tokens['--user-text-secondary']
    ); // [WAVE2-DEPRECATED]
  if (tokens['--user-text-tertiary'])
    root.style.setProperty(
      '--user-text-tertiary',
      tokens['--user-text-tertiary']
    ); // [WAVE2-DEPRECATED]
  if (tokens['--user-text-faint'])
    root.style.setProperty('--user-text-faint', tokens['--user-text-faint']); // [WAVE2-DEPRECATED]

  if (tokens['--user-border-color'])
    root.style.setProperty(
      '--user-border-color',
      tokens['--user-border-color']
    );
  if (tokens['--user-border-subtle'])
    root.style.setProperty(
      '--user-border-subtle',
      tokens['--user-border-subtle']
    );
  if (tokens['--user-control-mix-color'])
    root.style.setProperty(
      '--user-control-mix-color',
      tokens['--user-control-mix-color']
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

  if (tokens['--user-scrollbar-fg'])
    root.style.setProperty(
      '--user-scrollbar-fg',
      tokens['--user-scrollbar-fg']
    );
  if (tokens['--user-scrollbar-button-up'])
    root.style.setProperty(
      '--user-scrollbar-button-up',
      tokens['--user-scrollbar-button-up']
    );
  if (tokens['--user-scrollbar-button-down'])
    root.style.setProperty(
      '--user-scrollbar-button-down',
      tokens['--user-scrollbar-button-down']
    );
  if (tokens['--user-scrollbar-button-left'])
    root.style.setProperty(
      '--user-scrollbar-button-left',
      tokens['--user-scrollbar-button-left']
    );
  if (tokens['--user-scrollbar-button-right'])
    root.style.setProperty(
      '--user-scrollbar-button-right',
      tokens['--user-scrollbar-button-right']
    );
  if (tokens['--user-scrollbar-button-up-active'])
    root.style.setProperty(
      '--user-scrollbar-button-up-active',
      tokens['--user-scrollbar-button-up-active']
    );
  if (tokens['--user-scrollbar-button-down-active'])
    root.style.setProperty(
      '--user-scrollbar-button-down-active',
      tokens['--user-scrollbar-button-down-active']
    );
  if (tokens['--user-scrollbar-button-left-active'])
    root.style.setProperty(
      '--user-scrollbar-button-left-active',
      tokens['--user-scrollbar-button-left-active']
    );
  if (tokens['--user-scrollbar-button-right-active'])
    root.style.setProperty(
      '--user-scrollbar-button-right-active',
      tokens['--user-scrollbar-button-right-active']
    );

  // tinted 门控：非 warm-gray 皮肤才启用 CSS tinted 派生规则（thumb 13%/58% 等）
  if (tokens['--user-scrollbar-fg']) {
    root.setAttribute('data-scrollbar-tint', '');
  } else {
    root.removeAttribute('data-scrollbar-tint');
  }

  for (const key of Object.keys(tokens)) {
    injectedKeys.add(key);
  }
}
