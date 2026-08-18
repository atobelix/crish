/**
 * stream-renderer.js  V7
 *
 * Thin bootstrap over FlowProjector + FlowComponents (SPEC CONVERSATION_FLOW_SPEC).
 * Legacy HTML-string tool rows / stream approval cards / dual-mode notebook removed.
 */
(function () {
  'use strict';

  function render(data, mountEl) {
    var FM = window.FlowMount || (window.FlowComponents && window.FlowComponents.FlowMount);
    if (!FM) {
      console.error('[StreamRenderer] FlowMount missing');
      return null;
    }
    return FM.renderConversation(data || window.DemoData, mountEl || document.getElementById('streamMount'), {
      onOpenPath: function (path) {
        if (FM.toast) FM.toast('将在右侧文件面板打开：' + path);
        else console.info('[openPath]', path);
      },
    });
  }

  function autoInit() {
    var FM = window.FlowMount || (window.FlowComponents && window.FlowComponents.FlowMount);
    if (!FM || typeof FM.mount !== 'function') {
      console.error('[StreamRenderer] FlowMount.mount missing — check script order');
      return;
    }
    if (!window.DemoData) {
      console.error('[StreamRenderer] DemoData missing');
      return;
    }
    if (!window.FlowProjector) {
      console.warn('[StreamRenderer] FlowProjector missing — narrative tree will be empty');
    }

    var api = FM.mount({
      data: window.DemoData,
      onOpenPath: function (path) {
        FM.toast('将在右侧文件面板打开：' + path);
      },
      permission: {
        onAllow: function (id) {
          FM.toast('已批准 ' + id);
        },
        onDeny: function (id) {
          FM.toast('已拒绝 ' + id);
        },
        onAlways: function (id) {
          FM.toast('始终允许 ' + id);
        },
      },
    });

    window.StreamRendererApi = api;
    return api;
  }

  window.StreamRenderer = {
    render: render,
    autoInit: autoInit,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})();
