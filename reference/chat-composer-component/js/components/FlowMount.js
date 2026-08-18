/**
 * FlowMount.js — assemble FlowProjector nodes → FlowComponents tree.
 * Single entry for rendering the conversation stream (SPEC §6 FlowMount).
 */
(function () {
  'use strict';

  window.FlowComponents = window.FlowComponents || {};

  function toast(msg) {
    try {
      console.info('[FlowMount]', msg);
    } catch (e) { /* ignore */ }
    var el = document.getElementById('flow-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'flow-toast';
      el.setAttribute('role', 'status');
      el.style.cssText =
        'position:fixed;bottom:88px;left:50%;transform:translateX(-50%);' +
        'z-index:9999;padding:8px 14px;border-radius:10px;font-size:13px;' +
        'background:rgba(10,10,10,0.88);color:#fff;pointer-events:none;' +
        'opacity:0;transition:opacity 180ms ease;max-width:min(90vw,420px);' +
        'text-align:center;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(function () {
      el.style.opacity = '0';
    }, 2200);
  }

  function defaultOnOpenPath(path) {
    toast('将在右侧文件面板打开：' + path);
  }

  function FC() {
    return window.FlowComponents || {};
  }

  function renderNode(node, opts) {
    opts = opts || {};
    if (!node) return document.createDocumentFragment();
    var C = FC();
    var kind = node.kind || node.type || '';
    var onOpenPath = opts.onOpenPath || defaultOnOpenPath;

    function childOpts() {
      return {
        onOpenPath: onOpenPath,
        renderChildren: function (kids) {
          return renderNodes(kids, opts);
        },
      };
    }

    switch (kind) {
      case 'thinking':
        if (C.ThinkingBlock) return C.ThinkingBlock.render(node, opts);
        break;
      case 'text':
        if (C.TextBlock) return C.TextBlock.render(node, opts);
        break;
      case 'purpose':
        if (C.PurposeBlock) {
          return C.PurposeBlock.render(node, {
            onOpenPath: onOpenPath,
            initiallyOpen: opts.initiallyOpenPurpose,
            renderAction: opts.renderAction,
          });
        }
        break;
      case 'subagent':
        if (C.SubagentRoot) {
          return C.SubagentRoot.render(node, {
            initiallyOpen: opts.initiallyOpenSubagent,
            renderChildren: function (kids) {
              return renderNodes(kids || node.children || [], opts);
            },
          });
        }
        break;
      case 'artifact':
      case 'document':
        if (C.ArtifactChip) {
          return C.ArtifactChip.render(
            {
              kind: 'artifact',
              id: node.id,
              title: node.title || node.name || '文档',
              mime: node.mime,
              content: node.content || node.markdown || '',
            },
            { notebook: C.NotebookPanel }
          );
        }
        break;
      case 'composing':
        if (C.ComposingHint) return C.ComposingHint.render(node, opts);
        break;
      case 'plan':
      case 'task':
        if (C.PlanRoot || C.TaskRoot) {
          var RootComp = C.PlanRoot || C.TaskRoot;
          return RootComp.render(node, {
            renderChildren: function (kids) {
              return renderNodes(kids || node.children || [], opts);
            },
            onApprove: opts.onApprovePlan,
          });
        }
        break;
      case 'action':
        if (C.ActionRow) {
          return C.ActionRow.render(node, { onOpenPath: onOpenPath });
        }
        break;
      default:
        break;
    }

    // Fallback: silent empty for unknown kinds
    var unknown = document.createElement('div');
    unknown.className = 'flow-unknown';
    unknown.dataset.kind = kind;
    unknown.hidden = true;
    return unknown;
  }

  function renderNodes(nodes, opts) {
    var frag = document.createDocumentFragment();
    (nodes || []).forEach(function (n, i) {
      var el = renderNode(n, opts);
      if (!el) return;
      if (el.nodeType === 11) {
        // DocumentFragment
        frag.appendChild(el);
      } else {
        // Slot-machine nodes own their entrance; don't stack generic enter
        if (
          el.classList &&
          !el.classList.contains('flow-enter') &&
          !el.classList.contains('flow-enter-slot')
        ) {
          el.classList.add('flow-enter');
          el.style.animationDelay = Math.min(i * 28, 120) + 'ms';
        }
        frag.appendChild(el);
      }
    });
    return frag;
  }

  function renderUserMessage(msg) {
    var root = document.createElement('div');
    root.className = 'flow-msg flow-msg--user';
    root.dataset.id = msg.id || '';

    var bubble = document.createElement('div');
    bubble.className = 'flow-user-bubble';
    bubble.textContent = msg.text || msg.content || '';
    root.appendChild(bubble);
    return root;
  }

  function renderAssistantMessage(msg, projected, opts) {
    opts = opts || {};
    var root = document.createElement('div');
    root.className = 'flow-msg flow-msg--assistant';
    if (msg.status === 'processing') root.classList.add('is-processing');
    root.dataset.id = msg.id || '';

    var body = document.createElement('div');
    body.className = 'flow-msg-body';
    var nodes = (projected && projected.nodes) || [];
    body.appendChild(renderNodes(nodes, opts));
    root.appendChild(body);
    return root;
  }

  /**
   * Render full conversation into mountEl.
   * @returns {{ pendingApprovals: Array, messages: Array }}
   */
  function renderConversation(data, mountEl, opts) {
    opts = opts || {};
    if (!mountEl) return { pendingApprovals: [], messages: [] };

    var FP = window.FlowProjector;
    var conversation = Array.isArray(data)
      ? data
      : data && data.conversation
        ? data.conversation
        : (window.DemoData && window.DemoData.conversation) || [];

    var projected;
    if (FP && typeof FP.projectConversation === 'function') {
      projected = FP.projectConversation(
        Array.isArray(data) ? { conversation: conversation } : data || window.DemoData
      );
    } else {
      projected = { messages: [], pendingApprovals: [] };
      console.error('[FlowMount] FlowProjector missing');
    }

    // Prefer projector-extracted approvals; merge DemoData.pendingApprovals if empty
    var pending = (projected.pendingApprovals || []).slice();
    if (
      !pending.length &&
      window.DemoData &&
      Array.isArray(window.DemoData.pendingApprovals)
    ) {
      pending = window.DemoData.pendingApprovals.slice();
    }

    mountEl.innerHTML = '';
    mountEl.classList.add('flow-stream-inner');

    var streamParent = mountEl.parentElement;
    if (streamParent && streamParent.classList) {
      streamParent.classList.add('flow-stream');
    }

    var msgList = projected.messages || [];

    if (!msgList.length && conversation.length && FP && FP.projectMessage) {
      conversation.forEach(function (msg) {
        var role = msg.role || msg.sender;
        if (role === 'user') {
          mountEl.appendChild(renderUserMessage(msg));
          return;
        }
        var one = FP.projectMessage(msg);
        (one.pendingApprovals || []).forEach(function (a) {
          pending.push(a);
        });
        mountEl.appendChild(
          renderAssistantMessage(msg, { nodes: one.nodes }, opts)
        );
      });
    } else {
      msgList.forEach(function (entry) {
        var role = entry.role || entry.sender;
        if (role === 'user') {
          mountEl.appendChild(
            renderUserMessage({
              id: entry.id,
              text: entry.text || entry.content || '',
            })
          );
          return;
        }
        // Assistant: use projected nodes only (do not re-project user text nodes)
        mountEl.appendChild(
          renderAssistantMessage(
            {
              id: entry.id,
              status: entry.status,
              role: 'assistant',
            },
            { nodes: entry.nodes || [] },
            opts
          )
        );
      });
    }

    // Deduplicate pending by id
    var seen = Object.create(null);
    pending = pending.filter(function (a) {
      if (!a || !a.id || seen[a.id]) return false;
      seen[a.id] = true;
      return true;
    });

    if (window.FlowComponents && window.FlowComponents.FlowTimelineRail) {
      setTimeout(function () {
        window.FlowComponents.FlowTimelineRail.updateAll(mountEl);
      }, 60);
    }

    return {
      pendingApprovals: pending,
      messages: msgList,
    };
  }

  /**
   * Mount permission bar into composer host.
   */
  function mountPermissionBar(hostEl, items, callbacks) {
    var C = FC();
    if (!C.PermissionBar || !hostEl) return null;
    callbacks = callbacks || {};
    return C.PermissionBar.mount(hostEl, {
      items: items || [],
      onAllow: callbacks.onAllow || function (id) {
        toast('已批准：' + id);
      },
      onDeny: callbacks.onDeny || function (id) {
        toast('已拒绝：' + id);
      },
      onAlways: callbacks.onAlways || function (id) {
        toast('始终允许：' + id);
      },
      onResolved: callbacks.onResolved,
    });
  }

  /**
   * Full page bootstrap: stream + permission bar.
   */
  function mount(options) {
    options = options || {};
    var streamMount =
      options.streamEl ||
      document.getElementById('streamMount') ||
      document.querySelector('.chat-stream-inner');
    var permHost =
      options.permissionHost ||
      document.getElementById('permissionBarHost') ||
      null;

    // Ensure permission host exists above plan bar inside composer-wrapper
    if (!permHost) {
      var wrap = document.querySelector('.composer-wrapper');
      if (wrap) {
        permHost = document.createElement('div');
        permHost.id = 'permissionBarHost';
        permHost.className = 'flow-permission-host';
        var plan = wrap.querySelector('.plan-progress-bar') || wrap.firstChild;
        wrap.insertBefore(permHost, plan);
      }
    }

    var data = options.data || window.DemoData;
    var result = renderConversation(data, streamMount, {
      onOpenPath: options.onOpenPath || defaultOnOpenPath,
    });

    var permApi = null;
    if (permHost) {
      permApi = mountPermissionBar(permHost, result.pendingApprovals, options.permission);
    }

    var container =
      options.scrollEl ||
      document.querySelector('.chat-app-layout') ||
      document.getElementById('chatStreamContainer');
    if (container) {
      // Nested panel wheel → bubble to stream when at edge
      var dom = FC().dom;
      if (dom && typeof dom.bindScrollChain === 'function') {
        dom.bindScrollChain(container);
      }
      requestAnimationFrame(function () {
        container.scrollTop = container.scrollHeight;
      });
    }

    // Ensure notebook singleton is ready
    var C = FC();
    if (C.NotebookPanel && typeof C.NotebookPanel.ensure === 'function') {
      C.NotebookPanel.ensure();
    }

    return {
      pendingApprovals: result.pendingApprovals,
      permissionBar: permApi,
      remount: function (nextData) {
        return mount(
          Object.assign({}, options, { data: nextData || data })
        );
      },
    };
  }

  window.FlowComponents.FlowMount = {
    renderNode: renderNode,
    renderNodes: renderNodes,
    renderConversation: renderConversation,
    mountPermissionBar: mountPermissionBar,
    mount: mount,
    toast: toast,
  };

  // Back-compat namespace
  window.FlowMount = window.FlowComponents.FlowMount;
})();
