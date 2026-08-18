/**
 * ComposingHint.js — 整理中提示（圆点 pulse + 文案）
 * node: { text } | string
 * opts: {}
 */
(function () {
  'use strict';

  window.FlowComponents = window.FlowComponents || {};

  function render(node, opts) {
    opts = opts || {};
    var dom = window.FlowComponents.dom;
    var el = dom.el;

    var text = '正在整理结果…';
    if (typeof node === 'string') {
      text = node || text;
    } else if (node && node.text) {
      text = node.text;
    }

    var root = el('div', 'flow-composing flow-ephemeral-hint', {
      'data-kind': 'composing',
      'data-id': (node && node.id) || '',
    });

    var dot = el('span', 'flow-composing__dot', { 'aria-hidden': 'true' });
    dot.innerHTML = dom.pulseDotHtml ? dom.pulseDotHtml() : '<span class="flow-pulse-dot"></span>';
    root.appendChild(dot);

    var textEl = el('span', 'flow-composing__text flow-shimmer-text', { textContent: text });
    root.appendChild(textEl);

    /**
     * Update text in place with smooth fade
     */
    root.updateText = function (newText) {
      textEl.textContent = newText;
    };

    /**
     * Smoothly fade out and remove this ephemeral node from DOM
     */
    root.dismiss = function (onComplete) {
      root.style.transition = 'opacity 140ms ease, max-height 180ms ease, margin 140ms ease';
      root.style.opacity = '0';
      root.style.maxHeight = '0px';
      root.style.marginBottom = '0px';
      setTimeout(function () {
        if (root.parentNode) root.parentNode.removeChild(root);
        if (typeof onComplete === 'function') onComplete();
      }, 180);
    };

    return root;
  }

  window.FlowComponents.ComposingHint = { render: render };
})();
