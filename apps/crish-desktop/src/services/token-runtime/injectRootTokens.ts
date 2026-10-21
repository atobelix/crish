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

  // 全仓唯一合法注入点：显式受控注入，满足 style-contract 静态同源契约与精准应用。
  // T-BLK-07b 参数化：A 类设计 token（surface-*/text-*/border-*/control-*）不再由
  // JS 直写——只写 --user-* 运行期参数（token-registry.json B 类登记），A 类视觉值
  // 全部由 tokens.css 的 var(--user-*, 静态兜底) 派生；--font-size-adjust 为既有
  // B 类运行期量；bg-primary/secondary/card/elevated/paper/workspace、
  // shell-inset-bg、terminal-* 仍由 tokens.css 静态链派生，不注入。
  // 注意：写入名必须保持字面量（check-token-ssot 门禁按 setProperty 字面名扫描）。
  if (tokens['--font-size-adjust'])
    root.style.setProperty('--font-size-adjust', tokens['--font-size-adjust']);
  if (tokens['--user-surface-outer'])
    root.style.setProperty(
      '--user-surface-outer',
      tokens['--user-surface-outer']
    );
  if (tokens['--user-surface-main'])
    root.style.setProperty(
      '--user-surface-main',
      tokens['--user-surface-main']
    );
  if (tokens['--user-surface-input'])
    root.style.setProperty(
      '--user-surface-input',
      tokens['--user-surface-input']
    );
  if (tokens['--user-text-primary'])
    root.style.setProperty(
      '--user-text-primary',
      tokens['--user-text-primary']
    );
  if (tokens['--user-text-secondary'])
    root.style.setProperty(
      '--user-text-secondary',
      tokens['--user-text-secondary']
    );
  if (tokens['--user-text-tertiary'])
    root.style.setProperty(
      '--user-text-tertiary',
      tokens['--user-text-tertiary']
    );
  // T-BLK-07b：--text-muted 不再注入 —— tokens.css 静态 `--text-muted:
  // var(--text-tertiary)`（明/暗两块）已单源派生同值，JS 再写即同值多写。
  if (tokens['--user-text-faint'])
    root.style.setProperty('--user-text-faint', tokens['--user-text-faint']);
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
  // T-BLK-07b：--accent-green/red-light-adaptive 不再注入 —— JS 写的是常量
  // var(--success-soft-bg)/var(--danger-soft-bg)，与 tokens.css 静态声明完全
  // 同值（明/暗两块），JS 再写即同值多写。
  // T-BLK-07b 滚动条参数化：JS 只写 --user-* 参数（B 类登记），A 类
  // --scrollbar-thumb-bg/active 与 8 个按钮 token 由 tokens.css 静态兜底 +
  // tinted 门控（data-scrollbar-tint）派生。按钮 SVG 仍由 scrollbarIcons 序列化
  // （纯 finalFg 透传 + 固定 opacity，零颜色计算）——::-webkit-scrollbar-button
  // 伪元素仅支持 background 白名单属性，不支持 mask，无法纯 CSS 换色。
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
