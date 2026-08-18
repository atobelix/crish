/**
 * file-preview/toolbar/capabilities.js — 能力 → 按钮定义
 */
(function () {
  'use strict';

  var CAP = window.FilePreviewTypes.CAP;

  var ICONS = {
    close:
      '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    download:
      '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    zoomIn:
      '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
    zoomOut:
      '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
    zoomReset:
      '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="3"/></svg>',
    rotateLeft:
      '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
    rotateRight:
      '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>',
    prev:
      '<svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>',
    next:
      '<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>',
    thumbs:
      '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    copy:
      '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    crop:
      '<svg viewBox="0 0 24 24"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
    brush:
      '<svg viewBox="0 0 24 24"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>',
  };

  /**
   * 按 capability 列表生成有序动作项（非勾选能力不出现）
   * @param {string[]} capabilities
   * @returns {Array<{id:string,cap:string,title:string,icon:string,kind?:string}>}
   */
  function buildActions(capabilities) {
    var set = Object.create(null);
    (capabilities || []).forEach(function (c) {
      set[c] = true;
    });

    var items = [];

    if (set[CAP.THUMBNAILS]) {
      items.push({
        id: 'thumbnails',
        cap: CAP.THUMBNAILS,
        title: '缩略图',
        icon: ICONS.thumbs,
        toggle: true,
      });
    }
    if (set[CAP.PAGE]) {
      items.push({
        id: 'pagePrev',
        cap: CAP.PAGE,
        title: '上一页',
        icon: ICONS.prev,
      });
      items.push({
        id: 'pageIndicator',
        cap: CAP.PAGE,
        title: '页码',
        kind: 'label',
      });
      items.push({
        id: 'pageNext',
        cap: CAP.PAGE,
        title: '下一页',
        icon: ICONS.next,
      });
    }
    if (set[CAP.ZOOM]) {
      if (items.length) items.push({ id: 'sep-z', kind: 'sep' });
      items.push({
        id: 'zoomOut',
        cap: CAP.ZOOM,
        title: '缩小',
        icon: ICONS.zoomOut,
      });
      items.push({
        id: 'zoomLabel',
        cap: CAP.ZOOM,
        title: '缩放',
        kind: 'label',
      });
      items.push({
        id: 'zoomIn',
        cap: CAP.ZOOM,
        title: '放大',
        icon: ICONS.zoomIn,
      });
      items.push({
        id: 'zoomReset',
        cap: CAP.ZOOM,
        title: '重置缩放',
        icon: ICONS.zoomReset,
      });
    }
    if (set[CAP.ROTATE]) {
      if (items.length) items.push({ id: 'sep-r', kind: 'sep' });
      items.push({
        id: 'rotateLeft',
        cap: CAP.ROTATE,
        title: '逆时针旋转',
        icon: ICONS.rotateLeft,
      });
      items.push({
        id: 'rotateRight',
        cap: CAP.ROTATE,
        title: '顺时针旋转',
        icon: ICONS.rotateRight,
      });
    }
    if (set[CAP.CROP]) {
      items.push({
        id: 'crop',
        cap: CAP.CROP,
        title: '裁切',
        icon: ICONS.crop,
        toggle: true,
      });
    }
    if (set[CAP.BRUSH]) {
      items.push({
        id: 'brush',
        cap: CAP.BRUSH,
        title: '画笔',
        icon: ICONS.brush,
        toggle: true,
      });
    }
    if (set[CAP.SHEET]) {
      if (items.length) items.push({ id: 'sep-s', kind: 'sep' });
      items.push({
        id: 'sheetSelect',
        cap: CAP.SHEET,
        title: '工作表',
        kind: 'select',
      });
    }
    if (set[CAP.COPY]) {
      if (items.length) items.push({ id: 'sep-c', kind: 'sep' });
      items.push({
        id: 'copy',
        cap: CAP.COPY,
        title: '复制',
        icon: ICONS.copy,
      });
    }
    if (set[CAP.DOWNLOAD]) {
      if (items.length) items.push({ id: 'sep-d', kind: 'sep' });
      items.push({
        id: 'download',
        cap: CAP.DOWNLOAD,
        title: '下载',
        icon: ICONS.download,
      });
    }
    // close 始终在最右
    items.push({
      id: 'close',
      cap: CAP.CLOSE,
      title: '关闭',
      icon: ICONS.close,
    });

    return items;
  }

  window.FilePreviewCapabilities = {
    ICONS: ICONS,
    buildActions: buildActions,
  };
})();
