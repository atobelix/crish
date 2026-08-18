/**
 * markdown-editor/demo/v2-boot.js
 * AGEN-R1-10 — fused showcase boot only.
 *
 * Loads real fixture MD + mounts @conex/mdx (no island editor.js).
 * Does NOT inject ai.complete (AI chrome must stay hidden).
 * Does NOT wrap legacy island as v2.
 */
(function () {
  'use strict';

  var STATUS_ID = 'v2-boot-status';
  var FIXTURE_CANDIDATES = [
    // From reference/chat-composer-component/ (static server at monorepo root)
    '../../packages/conex-mdx/tests/fixtures/showcase-sample.md',
    // From monorepo root path variants
    '/packages/conex-mdx/tests/fixtures/showcase-sample.md',
    // Vite root = packages/conex-mdx
    '/tests/fixtures/showcase-sample.md',
    '../tests/fixtures/showcase-sample.md',
  ];

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, kind) {
    var el = $(STATUS_ID);
    if (!el) return;
    el.textContent = msg || '';
    el.dataset.kind = kind || 'info';
    el.hidden = !msg;
  }

  function toast(msg) {
    var toastEl = $('toast');
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('is-show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      toastEl.classList.remove('is-show');
    }, 1600);
  }

  async function fetchFirstMarkdown(urls) {
    var errors = [];
    for (var i = 0; i < urls.length; i++) {
      var url = urls[i];
      try {
        var res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
          errors.push(url + ' → HTTP ' + res.status);
          continue;
        }
        var text = await res.text();
        if (!text || !String(text).trim()) {
          errors.push(url + ' → empty body');
          continue;
        }
        // Guard against HTML 404 pages mistaken as MD
        if (/^\s*<!DOCTYPE/i.test(text) || /^\s*<html/i.test(text)) {
          errors.push(url + ' → HTML, not markdown');
          continue;
        }
        return { markdown: text, url: url };
      } catch (e) {
        errors.push(url + ' → ' + (e && e.message ? e.message : String(e)));
      }
    }
    var err = new Error(
      'Failed to load showcase-sample.md from real fixture paths.\n' + errors.join('\n'),
    );
    err.details = errors;
    throw err;
  }

  async function importMdx() {
    // Prefer import map alias; fall back to relative browser bundle.
    var candidates = [
      '@conex/mdx',
      '../../packages/conex-mdx/dist/mdx.js',
      '/packages/conex-mdx/dist/mdx.js',
      '/dist/mdx.js',
    ];
    var last;
    for (var i = 0; i < candidates.length; i++) {
      try {
        var mod = await import(/* @vite-ignore */ candidates[i]);
        if (mod && typeof mod.mount === 'function') {
          return { mod: mod, from: candidates[i] };
        }
        last = new Error(candidates[i] + ' has no mount()');
      } catch (e) {
        last = e;
      }
    }
    throw last || new Error('Unable to import @conex/mdx');
  }

  function rebuildSideToc(host, sampleMd) {
    var list = $('sideTocList');
    if (!list) return;
    list.innerHTML = '';

    var heads = host.querySelectorAll(
      '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .mdx-editor h1, .mdx-editor h2, .mdx-editor h3',
    );
    if (heads && heads.length) {
      for (var i = 0; i < heads.length; i++) {
        var h = heads[i];
        var level = h.tagName === 'H1' ? 1 : h.tagName === 'H2' ? 2 : 3;
        var text = (h.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (!h.id) h.id = 'toc-h-' + i;
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = '#' + h.id;
        a.textContent = text.slice(0, 48);
        if (level >= 3) a.className = 'is-h3';
        (function (anchorId) {
          a.addEventListener('click', function (ev) {
            ev.preventDefault();
            var target = document.getElementById(anchorId);
            if (target && target.scrollIntoView) {
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          });
        })(h.id);
        li.appendChild(a);
        list.appendChild(li);
      }
      return;
    }

    // Fallback: headings from fixture MD text
    var lines = String(sampleMd || '').split('\n');
    for (var j = 0; j < lines.length; j++) {
      var m = lines[j].match(/^(#{1,3})\s+(.+)$/);
      if (!m) continue;
      var li2 = document.createElement('li');
      var a2 = document.createElement('a');
      a2.href = '#';
      a2.textContent = m[2].slice(0, 48);
      if (m[1].length >= 3) a2.className = 'is-h3';
      li2.appendChild(a2);
      list.appendChild(li2);
    }
  }

  async function main() {
    var host = $('editorHost');
    var paper = $('paper');
    var sourceView = $('sourceView');
    var btnMore = $('btnMore');
    var debugMenu = $('debugMenu');
    var btnToggleSource = $('btnToggleSource');
    var badge = $('engineBadge');

    if (!host) {
      console.error('[v2-boot] #editorHost missing');
      return;
    }

    if (badge) {
      badge.textContent = 'Fused engine · no enterEdit · no mock AI';
    }

    setStatus('Loading fixture + @conex/mdx…', 'info');

    var fixture;
    var mdxPack;
    try {
      fixture = await fetchFirstMarkdown(FIXTURE_CANDIDATES);
      mdxPack = await importMdx();
    } catch (e) {
      var msg =
        (e && e.message) ||
        String(e) ||
        'boot failed';
      setStatus(msg, 'error');
      host.innerHTML =
        '<div class="me-boot-error" role="alert">' +
        '<strong>v2 boot failed</strong>' +
        '<pre>' +
        String(msg).replace(/[<>&]/g, function (c) {
          return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c];
        }) +
        '</pre>' +
        '<p>See packages/conex-mdx/README.md · 本地 demo. Build dist first if needed.</p>' +
        '</div>';
      console.error('[v2-boot]', e);
      return;
    }

    var SAMPLE = fixture.markdown;
    var mount = mdxPack.mod.mount;
    var api = null;
    var sourceMode = false;
    var fixtureUrl = fixture.url;

    // success: hide status bar (only errors should show)
    setStatus('', 'ok');
    console.info('[v2-boot] fixture', fixtureUrl, 'bytes', SAMPLE.length);
    console.info('[v2-boot] mdx from', mdxPack.from, 'VERSION', mdxPack.mod.VERSION);

    function setMenuOpen(open) {
      if (!debugMenu || !btnMore) return;
      debugMenu.classList.toggle('is-open', open);
      debugMenu.hidden = !open;
      btnMore.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function closeMenu() {
      setMenuOpen(false);
    }

    function getMarkdown() {
      return api && typeof api.getMarkdown === 'function' ? api.getMarkdown() : SAMPLE;
    }

    function mountEditor(md) {
      if (api && typeof api.destroy === 'function') {
        try {
          api.destroy();
        } catch (_) {
          /* ignore */
        }
        api = null;
      }
      host.innerHTML = '';

      // Host ports only. NO ai.complete → package must not show AI entry.
      // uploadImage → real blob: preview (not mock CDN URL).
      api = mount(host, {
        markdown: md,
        engine: 'fused',
        autosaveMs: 280,
        // Explicit: no AI port
        ai: false,
        onChange: function () {
          /* host may persist; demo no-op */
        },
        onOpenPath: function (path, meta) {
          toast('打开路径：' + path + (meta && meta.kind ? ' · ' + meta.kind : ''));
        },
        onOpenDoc: function (title) {
          toast('打开文档：' + title);
        },
        uploadImage: function (file) {
          return Promise.resolve({
            url: URL.createObjectURL(file),
            alt: (file && file.name) || 'image',
          });
        },
      });

      setTimeout(function () {
        rebuildSideToc(host, SAMPLE);
      }, 0);
      // KaTeX deferred CDN: remount once so math NodeView can paint
      if (!window.katex) {
        var tries = 0;
        var t = setInterval(function () {
          tries += 1;
          if (window.katex || tries > 40) {
            clearInterval(t);
            if (window.katex && api) {
              try {
                var cur = api.getMarkdown();
                api.setMarkdown(cur);
              } catch (_) { /* ignore */ }
            }
          }
        }, 100);
      }
    }

    var sourceSnapshot = '';

    function setSourceMode(on, opts) {
      opts = opts || {};
      sourceMode = !!on;
      if (paper) paper.classList.toggle('is-source', sourceMode);
      var btnNav = $('btnNavSource');
      if (btnToggleSource) {
        btnToggleSource.textContent = sourceMode ? '返回编辑' : '查看源码';
      }
      if (btnNav) {
        btnNav.classList.toggle('is-active', sourceMode);
        btnNav.textContent = sourceMode ? '返回编辑' : '源码';
      }
      if (sourceMode && sourceView) {
        sourceSnapshot = getMarkdown();
        sourceView.value = sourceSnapshot;
        sourceView.removeAttribute('readonly');
        sourceView.readOnly = false;
        sourceView.focus();
      } else if (sourceView) {
        if (opts.cancel) {
          mountEditor(sourceSnapshot || SAMPLE);
        } else {
          // 可编辑源码写回
          mountEditor(sourceView.value || SAMPLE);
        }
      }
    }

    function copyMarkdown() {
      var text = sourceMode && sourceView ? sourceView.value : getMarkdown();
      function ok() {
        toast('已复制 Markdown');
      }
      function fail() {
        toast('复制失败');
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, fail);
      } else if (sourceView) {
        sourceView.value = text;
        sourceView.removeAttribute('readonly');
        sourceView.select();
        try {
          document.execCommand('copy');
          ok();
        } catch (_) {
          fail();
        }
        sourceView.setAttribute('readonly', '');
      } else {
        fail();
      }
    }

    if (btnMore) {
      btnMore.addEventListener('click', function (e) {
        e.stopPropagation();
        setMenuOpen(debugMenu.hidden);
      });
    }

    var btnPalette = $('btnPalette');
    if (btnPalette) {
      btnPalette.addEventListener('click', function () {
        closeMenu();
        if (api && typeof api.openCommandPalette === 'function') {
          api.openCommandPalette();
        } else {
          toast('命令面板不可用');
        }
      });
    }

    var btnCopy = $('btnCopy');
    if (btnCopy) {
      btnCopy.addEventListener('click', function () {
        closeMenu();
        copyMarkdown();
      });
    }

    var btnReset = $('btnReset');
    if (btnReset) {
      btnReset.addEventListener('click', function () {
        closeMenu();
        sourceMode = false;
        if (paper) paper.classList.remove('is-source');
        if (btnToggleSource) btnToggleSource.textContent = '查看源码';
        mountEditor(SAMPLE);
        toast('已重置示例（真实 fixture）');
      });
    }

    if (btnToggleSource) {
      btnToggleSource.addEventListener('click', function () {
        closeMenu();
        setSourceMode(!sourceMode);
      });
    }

    var btnNavSource = $('btnNavSource');
    if (btnNavSource) {
      btnNavSource.addEventListener('click', function () {
        setSourceMode(!sourceMode);
      });
    }

    var btnApplySource = $('btnApplySource');
    if (btnApplySource) {
      btnApplySource.addEventListener('click', function () {
        setSourceMode(false);
        toast('已写回编辑器');
      });
    }

    var btnCancelSource = $('btnCancelSource');
    if (btnCancelSource) {
      btnCancelSource.addEventListener('click', function () {
        setSourceMode(false, { cancel: true });
        toast('已取消源码修改');
      });
    }

    var btnToggleToc = $('btnToggleToc');
    if (btnToggleToc) {
      btnToggleToc.addEventListener('click', function () {
        var toc = $('sideToc');
        if (!toc) return;
        if (window.matchMedia && window.matchMedia('(max-width: 1099px)').matches) {
          toc.style.display = toc.style.display === 'block' ? 'none' : 'block';
        } else {
          var on = toc.style.display === 'none';
          toc.style.display = on ? 'block' : 'none';
        }
      });
    }

    document.addEventListener('click', function (e) {
      if (debugMenu && !debugMenu.hidden && !e.target.closest('.me-fab')) {
        closeMenu();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeMenu();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '\\' || e.code === 'Backslash')) {
        e.preventDefault();
        setSourceMode(!sourceMode);
      }
    });

    mountEditor(SAMPLE);

    // Expose for manual QA (S01/S04/S05)
    window.__CONEX_MDX_V2__ = {
      get api() {
        return api;
      },
      getMarkdown: getMarkdown,
      fixtureUrl: fixtureUrl,
      sample: SAMPLE,
      remount: function () {
        mountEditor(SAMPLE);
      },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      main().catch(function (e) {
        console.error('[v2-boot] fatal', e);
        setStatus(String(e && e.message ? e.message : e), 'error');
      });
    });
  } else {
    main().catch(function (e) {
      console.error('[v2-boot] fatal', e);
      setStatus(String(e && e.message ? e.message : e), 'error');
    });
  }
})();
