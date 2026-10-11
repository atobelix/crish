/**
 * backdropThemeSync — 把应用当前明暗告诉 Rust，让 Mica/Acrylic 跟随应用主题，而不是系统明暗。
 *
 * Rust 侧：window_backdrop::THEME_EVENT（"crish://backdrop-theme"）；payload 为 JSON bool，true 表示深色。
 * 收到后会重设材质（apply_tabbed/apply_mica(Some(is_dark))，Acrylic 换浅/深底色），
 * 并重新写 data-backdrop（同时解决整页刷新或首个文档晚于 setup 时属性丢失的问题）。
 * 非 Tauri 环境（浏览器、测试）不做任何事。
 */
const EVENT = 'crish://backdrop-theme';

export function isDarkTheme(el: Element): boolean {
  return el.getAttribute('data-theme') === 'dark' || el.classList.contains('theme-dark');
}

export function startBackdropThemeSync(
  el: HTMLElement,
  send: (isDark: boolean) => Promise<void> | void,
): () => void {
  let last: boolean | null = null;
  const sync = (): void => {
    const dark = isDarkTheme(el);
    if (dark === last) return;
    last = dark;
    void Promise.resolve(send(dark)).catch(() => {
      last = null; // 发送失败时下次变化重发
    });
  };
  sync();
  const mo = new MutationObserver(sync);
  mo.observe(el, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  return () => mo.disconnect();
}

if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  startBackdropThemeSync(document.documentElement, async (dark) => {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(EVENT, dark);
  });
}
