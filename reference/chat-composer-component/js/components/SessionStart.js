/* ==========================================================================
   会话起点 —— logo 在界面里唯一的常驻落点
   --------------------------------------------------------------------------
   插在对话流最前面，随内容一起滚走，因此不占常驻 chrome，
   不破坏「无 header」的简洁构图。
   ========================================================================== */

(function () {
  'use strict';

  // 星号（6 条放射）+ 脱离的绿点 —— 与 app-icon / favicon 同一枚 mark
  var MARK =
    '<svg class="brand-mark" viewBox="0 0 200 200" aria-hidden="true">' +
    '<ellipse class="brand-mark__dot" cx="100" cy="34" rx="16" ry="16"/>' +
    '<g class="brand-mark__rays">' +
    '<path d="M 100 116 L 30 116"/>' +
    '<path d="M 100 116 L 170 116"/>' +
    '<path d="M 100 116 L 60 44"/>' +
    '<path d="M 100 116 L 140 44"/>' +
    '<path d="M 100 116 L 82 164"/>' +
    '<path d="M 100 116 L 118 164"/>' +
    '</g></svg>';

  function build() {
    var el = document.createElement('div');
    el.className = 'flow-session-start';
    el.innerHTML =
      MARK +
      '<span class="flow-session-start__name">Crish</span>' +
      '<span class="flow-session-start__sep"></span>' +
      '<span class="flow-session-start__meta">refactor/architecture</span>' +
      '<span class="flow-session-start__spacer"></span>' +
      '<span class="flow-session-start__status">' +
      '<span class="dot"></span>目标模式 · 运行中' +
      '</span>';
    return el;
  }

  function mount() {
    var host = document.getElementById('streamMount');
    if (!host || host.querySelector('.flow-session-start')) return;
    host.insertBefore(build(), host.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(mount, 0);
    });
  } else {
    setTimeout(mount, 0);
  }
})();
