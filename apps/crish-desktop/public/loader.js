(function () {
  try {
    var root = document.documentElement;

    // 1. 立即挂上冷启动全局动画门闩，冻结全量组件 transition 与 animation
    root.classList.add('preload');

    // 2. 读取主题模式（dark / default）
    var t = localStorage.getItem('crish_theme');
    if (t !== 'dark' && t !== 'default' && t !== 'light') {
      var raw = localStorage.getItem('crish_settings') || localStorage.getItem('conex_pi_settings');
      if (raw) {
        try {
          var s = JSON.parse(raw);
          t = s && s.theme;
        } catch (e) {}
      }
    }
    if (t === 'light' || !t) t = 'default';
    if (t !== 'dark') t = 'default';

    // 3. 同步写入 data-theme 与基础 class
    root.setAttribute('data-theme', t);
    root.classList.add(t === 'dark' ? 'theme-dark' : 'theme-light');

    // 4. 读取皮肤预设并极速注入核心色，确保首帧骨架屏 0ms 精确命中
    var skin = localStorage.getItem('crish_theme_skin');
    var skinMap = {
      'paper': '#f5f5f5',
      'classic-gray': '#f1f3f5',
      'cream': '#fcf8f2',
      'sand': '#f9f6f0',
      'warm-gray': 'hsl(35 8% 95.2%)'
    };

    if (t === 'dark') {
      root.style.setProperty('--loader-bg', '#1b1b1b');
    } else {
      root.style.setProperty('--loader-bg', (skin && skinMap[skin]) || 'hsl(35 8% 95.2%)');
    }

    // 5. 读取并注入字体配置
    var fr = localStorage.getItem('crish_fonts');
    if (!fr) {
      var raw2 = localStorage.getItem('crish_settings') || localStorage.getItem('conex_pi_settings');
      if (raw2) {
        try {
          var s2 = JSON.parse(raw2);
          if (s2 && s2.fonts) fr = JSON.stringify(s2.fonts);
        } catch (e2) {}
      }
    }
    if (fr) {
      var f = JSON.parse(fr);
      if (f && f.uiFont) root.setAttribute('data-ui-font', String(f.uiFont).indexOf('local:') === 0 ? 'local' : f.uiFont);
      if (f && f.monoFont) root.setAttribute('data-mono-font', String(f.monoFont).indexOf('local:') === 0 ? 'local' : f.monoFont);
    }

    // 6. 首屏加载全屏拖拽兜底（窗口尚未挂载 React 前，允许鼠标按住任意位置拖拽无边框窗口）
    window.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var skel = document.getElementById('skel-app');
      if (!skel) return;
      if (e.target === skel || skel.contains(e.target)) {
        try {
          if (
            window.__TAURI_INTERNALS__ &&
            typeof window.__TAURI_INTERNALS__.invoke === 'function'
          ) {
            var label =
              (window.__TAURI_INTERNALS__.metadata &&
                window.__TAURI_INTERNALS__.metadata.currentWindow &&
                window.__TAURI_INTERNALS__.metadata.currentWindow.label) ||
              'main';
            window.__TAURI_INTERNALS__.invoke('plugin:window|start_dragging', {
              label: label,
            });
          }
        } catch (_) {}
      }
    });
  } catch (err) {
    document.documentElement.setAttribute('data-theme', 'default');
    document.documentElement.classList.add('theme-light');
  }
})();
