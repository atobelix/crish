/**
 * backdropPersistence — 系统窗口材质标记（data-backdrop）跨整页刷新保持。
 *
 * 背景：Rust 侧 window_backdrop::sync_backdrop_to_webview 只在 setup() 时 eval 一次
 * `document.documentElement.setAttribute('data-backdrop', 'mica' | 'acrylic' | 'none')`。
 * 原生 Mica/Acrylic 材质挂在窗口上，整页刷新（Vite full reload、Ctrl+R）后依然在，
 * 但新文档丢了 data-backdrop 属性 → html[data-backdrop='mica'] 规则全部失效 →
 * body / 侧栏回落为不透明外层色，云母被盖住（2026-10-11 heson 报告的回归即此）。
 *
 * 做法：观察该属性，写入 sessionStorage（同一 webview 会话内跨刷新存活，关窗即清）；
 * 启动时若属性缺失则按记录恢复。只在 Rust 已经至少同步过一次后才会生效，不会凭空开启透明。
 */
const KEY = 'crish:backdrop';
const VALID = new Set(['mica', 'acrylic', 'none']);

try {
  const el = document.documentElement;
  const saved = window.sessionStorage.getItem(KEY);
  if (!el.hasAttribute('data-backdrop') && saved && VALID.has(saved)) {
    el.setAttribute('data-backdrop', saved);
  }
  const remember = (): void => {
    const v = el.getAttribute('data-backdrop');
    if (v && VALID.has(v)) window.sessionStorage.setItem(KEY, v);
  };
  remember();
  new MutationObserver(remember).observe(el, { attributes: true, attributeFilter: ['data-backdrop'] });
} catch {
  /* sessionStorage 不可用时静默：退化为原行为（仅 Rust 首次同步） */
}

export {};