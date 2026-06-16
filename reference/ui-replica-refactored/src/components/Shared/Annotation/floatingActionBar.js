/**
 * FloatingActionBar — text selection toolbar.
 * Appears when user selects text in any enabled container.
 * Actions: Copy, Annotate
 *
 * Usage: FloatingActionBar.attach(containerElement)
 */
import { AnnotationStore } from './annotationStore.js';

let bar = null;
let isInitialized = false;

function getBar() {
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'annotation-float-bar';
    bar.style.cssText =
      'position:fixed;display:none;z-index:9999;background:#fff;' +
      'border:1px solid rgba(0,0,0,0.08);border-radius:10px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.08);padding:2px;' +
      'gap:2px;align-items:center;font-family:Inter,sans-serif;';
    bar.innerHTML = `
      <button class="float-bar-btn" data-action="copy" title="复制">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px;height:13px">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span style="font-size:12px;margin-left:4px">复制</span>
      </button>
      <button class="float-bar-btn" data-action="annotate" title="批注">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px;height:13px">
          <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
        </svg>
        <span style="font-size:12px;margin-left:4px">批注</span>
      </button>
    `;
    Object.assign(bar.style, {
      display: 'none', flexDirection: 'row',
      padding: '2px', gap: '2px'
    });
    bar.querySelectorAll('.float-bar-btn').forEach(btn => {
      Object.assign(btn.style, {
        display: 'flex', alignItems: 'center', padding: '4px 8px',
        border: 'none', background: 'none', borderRadius: '6px',
        cursor: 'pointer', color: '#666', fontSize: '12px',
        fontFamily: 'Inter,sans-serif', whiteSpace: 'nowrap'
      });
      btn.addEventListener('mouseenter', () => { btn.style.background = '#f0f0f0'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
    });

    bar.querySelector('[data-action="copy"]').addEventListener('click', () => {
      const sel = window.getSelection().toString();
      navigator.clipboard.writeText(sel).catch(() => {});
      hideBar();
    });

    bar.querySelector('[data-action="annotate"]').addEventListener('click', () => {
      const sel = window.getSelection().toString();
      const target = bar.dataset.target || 'unknown';
      hideBar();
      showAnnotationInput(sel, target);
    });

    document.body.appendChild(bar);
  }
  return bar;
}

let annotationInputOverlay = null;

function showAnnotationInput(text, target) {
  if (annotationInputOverlay) annotationInputOverlay.remove();
  annotationInputOverlay = document.createElement('div');
  Object.assign(annotationInputOverlay.style, {
    position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
    zIndex: '10000', display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: 'rgba(0,0,0,0.15)'
  });
  annotationInputOverlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:16px;width:380px;max-width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.15);display:flex;flex-direction:column;gap:10px;">
      <div style="font-size:11px;color:#999;margin-bottom:2px;word-break:break-all;max-height:40px;overflow:hidden;">${text.length > 100 ? text.slice(0,100)+'...' : text}</div>
      <textarea class="ann-input" placeholder="输入批注内容..." style="width:100%;min-height:60px;border:1px solid #e5e5e5;border-radius:8px;padding:8px;font-size:13px;font-family:Inter,sans-serif;outline:none;resize:vertical;"></textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button class="ann-cancel" style="padding:6px 12px;border:1px solid #e5e5e5;border-radius:8px;background:#fff;cursor:pointer;font-size:12px;color:#666;font-family:Inter,sans-serif;">取消</button>
        <button class="ann-save" style="padding:6px 14px;border:none;border-radius:8px;background:#10b981;color:#fff;cursor:pointer;font-size:12px;font-weight:500;font-family:Inter,sans-serif;">保存批注</button>
      </div>
    </div>
  `;
  const textarea = annotationInputOverlay.querySelector('.ann-input');
  textarea.focus();

  annotationInputOverlay.querySelector('.ann-cancel').addEventListener('click', () => {
    annotationInputOverlay.remove();
    annotationInputOverlay = null;
  });

  annotationInputOverlay.querySelector('.ann-save').addEventListener('click', () => {
    const comment = textarea.value.trim();
    if (comment) {
      AnnotationStore.add({
        type: 'text_selection',
        target: target,
        text: text,
        comment: comment,
        source: 'user'
      });
      // Dispatch custom event for other components to react
      document.dispatchEvent(new CustomEvent('annotation:saved', {
        detail: { text, comment, target }
      }));
    }
    annotationInputOverlay.remove();
    annotationInputOverlay = null;
  });

  annotationInputOverlay.addEventListener('click', (e) => {
    if (e.target === annotationInputOverlay) {
      annotationInputOverlay.remove();
      annotationInputOverlay = null;
    }
  });

  document.body.appendChild(annotationInputOverlay);
}

function hideBar() {
  if (bar) bar.style.display = 'none';
}

export const FloatingActionBar = {
  attach(container, getTargetFn) {
    if (!container) return;

    container.addEventListener('mouseup', (e) => {
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel.toString().trim();
        if (text.length < 3) { hideBar(); return; }
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const b = getBar();
        b.dataset.target = getTargetFn ? getTargetFn(e) : 'unknown';
        b.style.display = 'flex';
        b.style.left = Math.max(4, rect.left) + 'px';
        b.style.top = (rect.bottom + 6) + 'px';
      }, 10);
    });

    container.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.float-bar-btn, .ann-input, .ann-cancel, .ann-save')) {
        setTimeout(hideBar, 150);
      }
    });
  },

  detach() {
    if (bar) bar.remove();
    bar = null;
  }
};
