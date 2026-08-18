/**
 * markdown-editor/blocks/image.js — 图片块 READ / 源码编辑 / MD 往返
 * 导出 window.MdxBlocksImage
 *
 * 块形状：{ type:'image', src, alt, title?, caption? }
 * MD：![alt](src "title")
 */
(function () {
  'use strict';

  function esc(s) {
    if (window.MdxUtil && window.MdxUtil.esc) return window.MdxUtil.esc(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 协议白名单：https/http/blob/data:image/相对路径/attachment: */
  function isSafeSrc(src) {
    if (src == null || src === '') return true;
    var s = String(src).trim();
    if (!s) return true;
    if (/^javascript:/i.test(s) || /^vbscript:/i.test(s) || /^data:text\//i.test(s)) {
      return false;
    }
    if (/^data:image\//i.test(s)) return true;
    if (/^(https?:|blob:|attachment:)/i.test(s)) return true;
    // 相对 / 工作区路径
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return true;
    return false;
  }

  /**
   * 解析独立行 GFM 图片
   * ![alt](url) 或 ![alt](url "title")
   * @returns {{ type:'image', src:string, alt:string, title?:string, caption?:string }|null}
   */
  function parseMdLine(line) {
    var raw = String(line == null ? '' : line).trim();
    // ![alt](src "title") | ![alt](src 'title') | ![alt](src)
    var m = raw.match(
      /^!\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)$/
    );
    if (!m) return null;
    var alt = m[1] || '';
    var src = (m[2] || '').trim();
    var title = m[3] != null ? m[3] : m[4] != null ? m[4] : '';
    if (!isSafeSrc(src)) return null;
    var block = { type: 'image', src: src, alt: alt, text: alt };
    if (title) {
      block.title = title;
      block.caption = title;
    }
    return block;
  }

  /** 块 → MD 源行 */
  function toMd(block) {
    block = block || {};
    var alt = block.alt != null ? String(block.alt) : block.text != null ? String(block.text) : '';
    var src = block.src != null ? String(block.src) : '';
    var title = block.title || block.caption || '';
    // 转义 ] ( ) 在 alt/src 中的常见破坏
    alt = alt.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    if (title) {
      return '![' + alt + '](' + src + ' "' + String(title).replace(/"/g, '\\"') + '")';
    }
    return '![' + alt + '](' + src + ')';
  }

  /**
   * 读态 HTML：figure + img + caption
   * @param {object} block
   * @param {{ resolveUrl?: function }} [helpers]
   */
  function readHtml(block, helpers) {
    helpers = helpers || {};
    block = block || {};
    var src = block.src != null ? String(block.src) : '';
    var alt = block.alt != null ? String(block.alt) : block.text != null ? String(block.text) : '';
    var caption = block.caption || block.title || '';
    var status = (block.meta && block.meta.status) || (src ? 'ready' : 'empty');
    if (!isSafeSrc(src)) {
      status = 'error';
    }
    var displaySrc = src;
    if (helpers.resolveUrl && src && typeof helpers.resolveUrl === 'function') {
      try {
        var resolved = helpers.resolveUrl(src, 'image');
        if (resolved && typeof resolved === 'string') displaySrc = resolved;
      } catch (e0) {
        /* keep src */
      }
    }

    var frameInner;
    if (!src || status === 'empty') {
      frameInner =
        '<div class="mdx-image__placeholder" data-mdx-image-pick>' +
        '<span class="mdx-image__placeholder-icon" aria-hidden="true">🖼</span>' +
        '<span>添加图片</span>' +
        '<span class="mdx-image__placeholder-hint">粘贴、拖入或编辑源码行</span>' +
        '</div>';
    } else if (status === 'error') {
      frameInner =
        '<div class="mdx-image__error" data-mdx-image-pick>' +
        '<span>无法加载图片</span>' +
        '<span class="mdx-image__error-src">' +
        esc(src) +
        '</span></div>';
    } else if (status === 'loading') {
      frameInner =
        '<div class="mdx-image__loading" aria-busy="true">' +
        (displaySrc
          ? '<img class="mdx-image__img mdx-image__img--preview" src="' +
            esc(displaySrc) +
            '" alt="' +
            esc(alt) +
            '" draggable="false"/>'
          : '') +
        '<span class="mdx-image__loading-label">上传中…</span></div>';
    } else {
      frameInner =
        '<img class="mdx-image__img" src="' +
        esc(displaySrc) +
        '" alt="' +
        esc(alt) +
        '" draggable="false" loading="lazy" title="点击放大" data-mdx-image-zoom/>';
    }

    var capHtml = '';
    if (caption) {
      capHtml =
        '<figcaption class="mdx-image__caption">' + esc(caption) + '</figcaption>';
    }

    var align = block.align && typeof block.align === 'string' ? block.align : 'center';
    return (
      '<figure class="mdx-img mdx-image" data-mdx-image data-align="' +
      esc(align) +
      '" data-status="' +
      esc(status) +
      '">' +
      '<div class="mdx-image__frame">' +
      frameInner +
      '</div>' +
      capHtml +
      '</figure>'
    );
  }

  /**
   * 编辑表面：GFM 源码单行（与 line-source 模型一致）
   */
  function editHtml(block) {
    var srcLine = toMd(block);
    return (
      '<div class="mdx-line-edit mdx-image-edit" data-mdx-line-edit data-block-type="image" data-mdx-image-edit>' +
      '<div class="mdx-src-body mdx-edit mdx-image-edit__src" data-mdx-edit contenteditable="true" ' +
      'spellcheck="false" role="textbox" data-placeholder="![alt](url)">' +
      esc(srcLine) +
      '</div>' +
      '<div class="mdx-image-edit__hint">图片源码行 · 失焦后渲染</div>' +
      '</div>'
    );
  }

  /**
   * 从编辑表面读回 patch
   * @param {HTMLElement} contentEl
   */
  function readFromEdit(contentEl) {
    if (!contentEl) return null;
    var edit =
      contentEl.getAttribute && contentEl.getAttribute('data-mdx-edit') != null
        ? contentEl
        : contentEl.querySelector
          ? contentEl.querySelector('[data-mdx-edit]')
          : null;
    if (!edit) return null;
    var raw = (edit.innerText != null ? edit.innerText : edit.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n/g, '\n')
      .trim();
    var parsed = parseMdLine(raw);
    if (parsed) {
      return {
        type: 'image',
        src: parsed.src,
        alt: parsed.alt,
        text: parsed.alt,
        title: parsed.title || '',
        caption: parsed.caption || parsed.title || '',
      };
    }
    // 未匹配完整语法：若用户清空，保留空图；否则当段落
    if (!raw) {
      return { type: 'image', src: '', alt: '', text: '', title: '', caption: '' };
    }
    // 允许只改部分时尽量保留 — 退化为 paragraph 文本
    return { type: 'paragraph', text: raw };
  }

  function createEmpty() {
    return {
      type: 'image',
      src: '',
      alt: '',
      text: '',
      title: '',
      caption: '',
    };
  }

  /* ---------- 轻量灯箱（overlay + Esc / 点遮罩关；无重库） ---------- */

  var lightboxPortal = null;
  var lightboxKeyHandler = null;
  var lightboxPrevFocus = null;

  function ensureLightboxPortal() {
    if (lightboxPortal && lightboxPortal.parentNode) return lightboxPortal;
    var el = document.createElement('div');
    el.className = 'mdx-lightbox';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', '图片预览');
    el.innerHTML =
      '<div class="mdx-lightbox__backdrop" data-mdx-lightbox-close></div>' +
      '<div class="mdx-lightbox__stage">' +
      '<button type="button" class="mdx-lightbox__close" data-mdx-lightbox-close aria-label="关闭">×</button>' +
      '<img class="mdx-lightbox__img" alt="" draggable="false"/>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      // 遮罩 / 关闭钮：关；点图本体不关
      if (e.target && e.target.closest && e.target.closest('[data-mdx-lightbox-close]')) {
        e.preventDefault();
        closeLightbox();
      }
    });
    lightboxPortal = el;
    return el;
  }

  /**
   * 打开灯箱
   * @param {string} src
   * @param {string} [alt]
   */
  function openLightbox(src, alt) {
    if (!src || !isSafeSrc(src)) return;
    var portal = ensureLightboxPortal();
    var img = portal.querySelector('.mdx-lightbox__img');
    if (img) {
      img.src = src;
      img.alt = alt != null ? String(alt) : '';
    }
    lightboxPrevFocus = document.activeElement;
    portal.hidden = false;
    portal.classList.add('is-open');
    portal.setAttribute('aria-hidden', 'false');
    if (!lightboxKeyHandler) {
      lightboxKeyHandler = function (e) {
        if (e.key === 'Escape' || e.key === 'Esc') {
          e.preventDefault();
          e.stopPropagation();
          closeLightbox();
        }
      };
      document.addEventListener('keydown', lightboxKeyHandler, true);
    }
    // 关按钮可聚焦，便于 a11y
    var closeBtn = portal.querySelector('.mdx-lightbox__close');
    if (closeBtn && typeof closeBtn.focus === 'function') {
      try {
        closeBtn.focus({ preventScroll: true });
      } catch (eF) {
        try {
          closeBtn.focus();
        } catch (eF2) {
          /* ignore */
        }
      }
    }
  }

  function closeLightbox() {
    if (!lightboxPortal) return;
    lightboxPortal.classList.remove('is-open');
    lightboxPortal.hidden = true;
    lightboxPortal.setAttribute('aria-hidden', 'true');
    var img = lightboxPortal.querySelector('.mdx-lightbox__img');
    if (img) {
      img.removeAttribute('src');
      img.alt = '';
    }
    if (lightboxKeyHandler) {
      document.removeEventListener('keydown', lightboxKeyHandler, true);
      lightboxKeyHandler = null;
    }
    var prev = lightboxPrevFocus;
    lightboxPrevFocus = null;
    if (prev && typeof prev.focus === 'function') {
      try {
        prev.focus({ preventScroll: true });
      } catch (e) {
        /* ignore */
      }
    }
  }

  function isLightboxOpen() {
    return !!(lightboxPortal && !lightboxPortal.hidden && lightboxPortal.classList.contains('is-open'));
  }

  // 注册（可选）
  if (window.MdxRegistry && typeof window.MdxRegistry.register === 'function') {
    try {
      window.MdxRegistry.register({
        type: 'image',
        renderRead: readHtml,
        toMarkdown: toMd,
        slash: {
          id: 'image',
          title: '图片',
          aliases: ['image', 'img', '图片', '图'],
          section: '媒体',
        },
      });
    } catch (eReg) {
      /* ignore */
    }
  }

  window.MdxBlocksImage = {
    parseMdLine: parseMdLine,
    toMd: toMd,
    readHtml: readHtml,
    editHtml: editHtml,
    readFromEdit: readFromEdit,
    createEmpty: createEmpty,
    isSafeSrc: isSafeSrc,
    openLightbox: openLightbox,
    closeLightbox: closeLightbox,
    isLightboxOpen: isLightboxOpen,
  };
})();
