/**
 * markdown-editor/ui/code-lang-menu.js — 读态语言标签菜单（F-CODE-LANG 最小）
 *
 * 点击 `.mdx-code-card__lang` → 弹出常用语言列表；选中后：
 *   1) 回调 onSelect(lang)
 *   2) 冒泡 CustomEvent `mdx-code-lang` { blockId, lang, source }
 *
 * 动效：opacity + transform（对齐 motion tokens）；prefers-reduced-motion 瞬切。
 * 不进源码态；不挡复制按钮（fixed 定位于标签下方）。
 *
 * Exports window.MdxCodeLangMenu
 */
(function () {
  'use strict';

  /** 常用语言（短 id，与 GH / 工程师习惯一致） */
  var COMMON_LANGS = [
    { id: 'js', label: 'js', title: 'JavaScript' },
    { id: 'ts', label: 'ts', title: 'TypeScript' },
    { id: 'python', label: 'python', title: 'Python' },
    { id: 'rust', label: 'rust', title: 'Rust' },
    { id: 'go', label: 'go', title: 'Go' },
    { id: 'json', label: 'json', title: 'JSON' },
    { id: 'diff', label: 'diff', title: 'Diff' },
    { id: 'md', label: 'md', title: 'Markdown' },
    { id: 'text', label: 'text', title: 'Plain Text' },
    { id: 'html', label: 'html', title: 'HTML' },
    { id: 'css', label: 'css', title: 'CSS' },
    { id: 'shell', label: 'shell', title: 'Shell' },
    { id: 'sql', label: 'sql', title: 'SQL' },
    { id: 'yaml', label: 'yaml', title: 'YAML' },
    { id: 'java', label: 'java', title: 'Java' },
    { id: 'c', label: 'c', title: 'C' },
    { id: 'cpp', label: 'cpp', title: 'C++' },
  ];

  var menuEl = null;
  var menuOnSelect = null;
  var menuAnchor = null;
  var menuBlockId = null;
  var globalBound = false;
  var closeRaf = 0;

  function esc(s) {
    if (window.MdxUtil && typeof window.MdxUtil.esc === 'function') {
      return window.MdxUtil.esc(s);
    }
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function prefersReducedMotion() {
    try {
      return (
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    } catch (e) {
      return false;
    }
  }

  function ensureMenuEl() {
    if (menuEl && menuEl.parentNode) return menuEl;
    menuEl = document.createElement('div');
    menuEl.className = 'mdx-code-lang-menu';
    menuEl.setAttribute('role', 'menu');
    menuEl.setAttribute('aria-label', '选择代码语言');
    menuEl.hidden = true;
    document.body.appendChild(menuEl);
    return menuEl;
  }

  function isOpen() {
    return !!(menuEl && !menuEl.hidden);
  }

  function close(immediate) {
    if (!menuEl) return;
    menuOnSelect = null;
    menuAnchor = null;
    menuBlockId = null;
    if (closeRaf) {
      cancelAnimationFrame(closeRaf);
      closeRaf = 0;
    }
    menuEl.classList.remove('is-open');
    menuEl.removeAttribute('data-open');
    if (immediate || prefersReducedMotion()) {
      menuEl.hidden = true;
      menuEl.innerHTML = '';
      return;
    }
    // 等关场 transition 再 hidden（~120ms）
    var el = menuEl;
    setTimeout(function () {
      if (el && !el.classList.contains('is-open')) {
        el.hidden = true;
        el.innerHTML = '';
      }
    }, 130);
  }

  function normalizeLang(lang) {
    return String(lang == null ? '' : lang)
      .toLowerCase()
      .trim();
  }

  function positionNear(anchor) {
    if (!menuEl || !anchor || !anchor.getBoundingClientRect) return;
    var rect = anchor.getBoundingClientRect();
    var mw = menuEl.offsetWidth || 148;
    var mh = menuEl.offsetHeight || 240;
    var pad = 6;
    var left = rect.left;
    var top = rect.bottom + 4;
    // 不超出视口
    if (left + mw > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - mw - pad);
    }
    if (left < pad) left = pad;
    if (top + mh > window.innerHeight - pad) {
      // 翻到标签上方
      top = Math.max(pad, rect.top - mh - 4);
    }
    menuEl.style.left = Math.round(left) + 'px';
    menuEl.style.top = Math.round(top) + 'px';
  }

  function buildItemsHtml(current) {
    var cur = normalizeLang(current);
    // 空 lang 视作 text
    if (!cur) cur = 'text';
    var html = '';
    for (var i = 0; i < COMMON_LANGS.length; i++) {
      var it = COMMON_LANGS[i];
      var active = cur === it.id || (cur === 'javascript' && it.id === 'js') ||
        (cur === 'typescript' && it.id === 'ts') ||
        (cur === 'markdown' && it.id === 'md') ||
        (cur === 'plaintext' && it.id === 'text') ||
        (cur === 'plain' && it.id === 'text') ||
        (cur === 'bash' && it.id === 'shell') ||
        (cur === 'sh' && it.id === 'shell') ||
        (cur === 'py' && it.id === 'python') ||
        (cur === 'rs' && it.id === 'rust');
      html +=
        '<button type="button" class="mdx-code-lang-menu__item' +
        (active ? ' is-active' : '') +
        '" role="menuitem" data-lang="' +
        esc(it.id) +
        '" title="' +
        esc(it.title || it.label) +
        '"' +
        (active ? ' aria-current="true"' : '') +
        '>' +
        esc(it.label) +
        '</button>';
    }
    return html;
  }

  function onDocPointerDown(e) {
    if (!isOpen()) return;
    if (menuEl && menuEl.contains(e.target)) return;
    if (menuAnchor && menuAnchor.contains && menuAnchor.contains(e.target)) return;
    close();
  }

  function onDocKeydown(e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    var items = menuEl.querySelectorAll('.mdx-code-lang-menu__item');
    if (!items.length) return;
    var active = menuEl.querySelector('.mdx-code-lang-menu__item.is-active, .mdx-code-lang-menu__item:focus');
    var idx = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i] === active) {
        idx = i;
        break;
      }
    }
    if (e.key === 'Enter') {
      if (active) {
        e.preventDefault();
        active.click();
      }
      return;
    }
    e.preventDefault();
    if (e.key === 'Home') idx = 0;
    else if (e.key === 'End') idx = items.length - 1;
    else if (e.key === 'ArrowDown') idx = idx < items.length - 1 ? idx + 1 : 0;
    else idx = idx > 0 ? idx - 1 : items.length - 1;
    for (var j = 0; j < items.length; j++) items[j].classList.remove('is-active');
    items[idx].classList.add('is-active');
    items[idx].focus();
  }

  function onScrollOrResize() {
    if (!isOpen() || !menuAnchor) return;
    positionNear(menuAnchor);
  }

  function bindGlobal() {
    if (globalBound) return;
    globalBound = true;
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeydown, true);
    window.addEventListener('resize', onScrollOrResize, true);
    window.addEventListener('scroll', onScrollOrResize, true);
  }

  /**
   * @param {HTMLElement} anchor 语言标签节点
   * @param {{
   *   current?: string,
   *   blockId?: string,
   *   onSelect?: (lang: string) => void
   * }} [opts]
   */
  function open(anchor, opts) {
    if (!anchor) return;
    opts = opts || {};
    bindGlobal();

    // 同一锚点再点 → 关闭
    if (isOpen() && menuAnchor === anchor) {
      close();
      return;
    }

    var el = ensureMenuEl();
    menuOnSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
    menuAnchor = anchor;
    menuBlockId = opts.blockId != null ? String(opts.blockId) : null;

    el.innerHTML = buildItemsHtml(opts.current);
    el.hidden = false;
    el.classList.remove('is-open');
    el.removeAttribute('data-open');

    // 定位（先显示再量宽）
    positionNear(anchor);

    if (prefersReducedMotion()) {
      el.classList.add('is-open');
      el.setAttribute('data-open', 'true');
    } else {
      // 下一帧开场，触发 transition
      closeRaf = requestAnimationFrame(function () {
        closeRaf = 0;
        el.classList.add('is-open');
        el.setAttribute('data-open', 'true');
      });
    }

    // 聚焦当前项
    var cur = el.querySelector('.mdx-code-lang-menu__item.is-active') || el.querySelector('.mdx-code-lang-menu__item');
    if (cur && typeof cur.focus === 'function') {
      try {
        cur.focus({ preventScroll: true });
      } catch (err) {
        cur.focus();
      }
    }
  }

  function pickLang(lang, sourceEl) {
    lang = normalizeLang(lang);
    if (!lang) lang = 'text';
    var onSel = menuOnSelect;
    var bid = menuBlockId;
    var anchor = menuAnchor;
    close(true);

    if (onSel) {
      try {
        onSel(lang);
      } catch (e) {
        /* ignore callback errors */
      }
    }

    // 冒泡自定义事件（editor 或宿主可监听）
    var target = sourceEl || anchor || document;
    try {
      var ev = new CustomEvent('mdx-code-lang', {
        bubbles: true,
        cancelable: true,
        detail: { lang: lang, blockId: bid, source: 'menu' },
      });
      target.dispatchEvent(ev);
    } catch (err) {
      /* IE / 旧环境忽略 */
    }
  }

  // 菜单内点击委托
  function onMenuClick(e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-lang]');
    if (!btn || !menuEl || !menuEl.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    pickLang(btn.getAttribute('data-lang') || '', btn);
  }

  function ensureMenuClick() {
    var el = ensureMenuEl();
    if (el._mdxLangMenuClick) return;
    el._mdxLangMenuClick = true;
    el.addEventListener('click', onMenuClick);
  }

  // 首次 open 前绑定
  var _origOpen = open;
  open = function (anchor, opts) {
    ensureMenuClick();
    return _origOpen(anchor, opts);
  };

  /**
   * 在 root 上捕获语言标签点击（可选；editor 也可自行处理）
   * @param {ParentNode} [root]
   * @param {(detail: { lang?: string, blockId?: string, anchor: HTMLElement, current: string }) => void} [onOpenRequest]
   *   若提供，仅负责打开请求（由调用方 open）；否则内部 open 并 onSelect 只发事件
   */
  function installDelegate(root, onOpenRequest) {
    var target = root || document;
    target.addEventListener(
      'click',
      function (e) {
        var el = e.target;
        if (!el || !el.closest) return;
        var langEl = el.closest('.mdx-code-card__lang, [data-mdx-code-lang]');
        if (!langEl) return;
        // 源码态无 bar，但双保险
        var card = langEl.closest('[data-mdx-code-card], .mdx-code-card');
        if (card && (card.getAttribute('data-mode') === 'source' || card.classList.contains('is-source'))) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();

        var blockEl = langEl.closest('.mdx-block');
        var blockId = (blockEl && blockEl.dataset && blockEl.dataset.blockId) || null;
        var current =
          (card && card.getAttribute('data-lang')) ||
          (langEl.textContent || '').trim() ||
          '';

        if (typeof onOpenRequest === 'function') {
          onOpenRequest({
            anchor: langEl,
            blockId: blockId,
            current: current,
          });
          return;
        }

        open(langEl, {
          current: current,
          blockId: blockId,
          onSelect: null, // 仅事件
        });
      },
      true
    );
  }

  window.MdxCodeLangMenu = {
    COMMON_LANGS: COMMON_LANGS,
    open: open,
    close: close,
    isOpen: isOpen,
    installDelegate: installDelegate,
    normalizeLang: normalizeLang,
  };
})();
