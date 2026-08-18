/**
 * TextBlock.js — 正文 / 过渡文案
 * node: { kind:'text', content|text, tone:'primary'|'interstitial' }
 *
 * interstitial：老虎机式入场（完整滚动弧线，略快）
 * primary：静态正文
 */
(function () {
  'use strict';

  window.FlowComponents = window.FlowComponents || {};

  function renderDocRefs(html) {
    return String(html || '').replace(/\[\[doc:([^\]]+)\]\]/g, function (_, title) {
      var safe = window.FlowComponents.dom
        ? window.FlowComponents.dom.esc(title)
        : String(title)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
      return '<span class="flow-doc-ref" data-doc-title="' + safe + '">' + safe + '</span>';
    });
  }

  function renderPlain(text, esc) {
    return esc(text)
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');
  }

  function prefersReducedMotion() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;
    }
  }

  /**
   * Build 3 reel frames for slot entrance.
   * Intermediate frames stay readable but "in motion" (meta gray), final is body ink.
   */
  function buildSlotFrames(finalText) {
    var t = String(finalText || '').replace(/\s+/g, ' ').trim();
    if (!t) return ['…', t];
    var n = t.length;
    var frames = [];
    // Spin frame 1: leading fragment
    if (n > 4) {
      frames.push(t.slice(0, Math.max(2, Math.floor(n * 0.28))) + '…');
    } else {
      frames.push('·');
    }
    // Spin frame 2: longer fragment
    if (n > 8) {
      frames.push(t.slice(0, Math.max(4, Math.floor(n * 0.55))) + '…');
    } else {
      frames.push(t.slice(0, Math.max(1, n - 1)) + (n > 1 ? '…' : ''));
    }
    frames.push(t);
    return frames;
  }

  function renderPrimary(root, content, esc) {
    var MD = window.MarkdownLite;
    var html;
    if (MD && typeof MD.render === 'function' && /[#*`|\[]/.test(content)) {
      html = MD.render(content);
    } else if (MD && typeof MD.render === 'function' && content.indexOf('\n') >= 0) {
      html = MD.render(content);
    } else {
      html = renderPlain(content, esc);
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    }
    html = renderDocRefs(html);
    root.innerHTML = html;
  }

  /**
   * Slot-machine entrance for interstitial conclusions.
   * Full arc: spin frames → settle on final (complete process, snappy duration).
   */
  function renderInterstitialSlot(root, content, esc, el) {
    var frames = buildSlotFrames(content);
    var reduced = prefersReducedMotion();

    root.classList.add('flow-enter-slot');
    /* Prevent FlowMount from stacking generic .flow-enter */

    var slot = el('div', 'flow-slot');
    var track = el('div', 'flow-slot__track');

    for (var i = 0; i < frames.length; i++) {
      var item = el(
        'div',
        'flow-slot__item' + (i < frames.length - 1 ? ' flow-slot__item--spin' : ' flow-slot__item--final')
      );
      item.textContent = frames[i];
      track.appendChild(item);
    }

    slot.appendChild(track);
    slot.setAttribute('data-index', '0');
    slot.style.setProperty('--flow-slot-index', '0');
    root.appendChild(slot);

    var finalIndex = frames.length - 1;

    function settle() {
      slot.setAttribute('data-index', String(finalIndex));
      slot.style.setProperty('--flow-slot-index', String(finalIndex));
      slot.classList.add('is-settled');
      root.classList.add('is-settled');
    }

    if (reduced) {
      settle();
      return;
    }

    // Double rAF: ensure initial frame paints at index 0 before transition
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        settle();
      });
    });

    // After settle, allow multi-line height if final text wraps (rare for interstitial)
    function onEnd(e) {
      if (e && e.target !== track) return;
      track.removeEventListener('transitionend', onEnd);
      slot.classList.add('is-done');
    }
    track.addEventListener('transitionend', onEnd);
  }

  function render(node, opts) {
    opts = opts || {};
    node = node || {};
    var dom = window.FlowComponents.dom;
    var esc = dom
      ? dom.esc
      : function (s) {
          return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        };
    var el = dom
      ? dom.el
      : function (tag, cls) {
          var n = document.createElement(tag);
          if (cls) n.className = cls;
          return n;
        };

    var tone = node.tone || 'primary';
    if (tone !== 'primary' && tone !== 'interstitial') {
      tone = 'primary';
    }

    var content = node.content != null ? node.content : node.text != null ? node.text : '';
    content = String(content || '');

    var cls = 'flow-text';
    if (tone === 'primary') cls += ' flow-text--primary';
    if (tone === 'interstitial') cls += ' flow-text--interstitial';

    var root = el('div', cls, {
      'data-id': node.id || '',
      'data-kind': 'text',
      'data-tone': tone,
    });

    if (tone === 'interstitial') {
      renderInterstitialSlot(root, content, esc, el);
    } else {
      renderPrimary(root, content, esc);
    }

    return root;
  }

  window.FlowComponents.TextBlock = { render: render };
})();
