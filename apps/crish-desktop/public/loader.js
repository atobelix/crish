(function () {
  try {
    var root = document.documentElement;

    // 1. 精细骨架局部门闩（ACT-203：禁全局通配）；preload 仅为兼容既有解闩调用保留
    root.classList.add('skeleton-latched');
    root.classList.add('preload');

    // 2. 只写镜像读取（Commit Ack 写端见 themeStore；镜像 key 与 THEME_KEY 一致）
    //    镜像缺失/非法一律回落 default（浅色）。未产品确认前禁止 matchMedia 跟随系统暗色。
    var t = null;
    try {
      t = localStorage.getItem('crish_theme');
    } catch (_) {}

    if (t !== 'dark' && t !== 'default') {
      t = 'default';
    }

    // 3. 同步写入 data-theme 与基础 class（0ms CSSOM 级联生效）
    root.setAttribute('data-theme', t);
    root.classList.add(t === 'dark' ? 'theme-dark' : 'theme-light');

    // 4. 首绘唤醒握手（CON-01）：rAF 确认图元提交后 invoke；显式 catch 防未捕获 rejection
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        try {
          if (
            window.__TAURI_INTERNALS__ &&
            typeof window.__TAURI_INTERNALS__.invoke === 'function'
          ) {
            window.__TAURI_INTERNALS__
              .invoke('workbench_window_ready')
              .catch(function () {
                /* swallow-ok: 握手失败不中断前端渲染，由原生看门狗兜底 */
              });
          }
        } catch (_) {}
      });
    }
  } catch (err) {
    // 异常安全降级：至少具备可用浅色主题（零裸 Hex，与 default 策略一致）
    try {
      var r = document.documentElement;
      r.setAttribute('data-theme', 'default');
      r.classList.add('theme-light');
      r.classList.add('skeleton-latched');
      r.classList.add('preload');
    } catch (_) {}
  }
})();
