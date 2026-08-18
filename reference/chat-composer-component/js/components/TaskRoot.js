/**
 * TaskRoot / PlanRoot — Conex Organic Plan & Step Milestones Component.
 * Renders execution steps as clean milestone headers without duplicate card framing.
 * Zero blue tints, fully aligned with Crish warm ink design system.
 */
(function () {
  'use strict';

  var FC = (window.FlowComponents = window.FlowComponents || {});
  var dom = FC.dom || {};

  function stepStatusLabel(status) {
    switch (status) {
      case 'running':
      case 'active':
      case 'in_progress':
        return '执行中';
      case 'completed':
      case 'done':
      case 'success':
        return '已完成';
      case 'pending':
        return '待开始';
      case 'failed':
      case 'error':
        return '失败';
      default:
        return status || '';
    }
  }

  /**
   * Render clean plan step milestones in the stream.
   * @param {Object} node
   * @param {Object} [opts]
   * @returns {HTMLElement}
   */
  function render(node, opts) {
    opts = opts || {};
    node = node || {};
    var el = dom.el || function (tag, cls, attrs) {
      var elem = document.createElement(tag);
      if (cls) elem.className = cls;
      if (attrs) {
        Object.keys(attrs).forEach(function (k) {
          if (k === 'textContent') elem.textContent = attrs[k];
          else elem.setAttribute(k, attrs[k]);
        });
      }
      return elem;
    };

    var status = node.status || 'running';
    var steps = node.steps || [];
    var currentStepIndex = typeof node.currentStepIndex === 'number' ? node.currentStepIndex : 0;

    var root = el('div', 'flow-plan-root', {
      'data-kind': 'plan',
      'data-status': status,
      'data-id': node.id || ''
    });

    // Render Steps in the conversation stream
    steps.forEach(function (step, idx) {
      // Only render completed or currently running steps into the stream (pending stay in bottom drawer)
      var stepStatus = step.status || (idx < currentStepIndex ? 'done' : idx === currentStepIndex ? 'running' : 'pending');
      
      // If a step is pending and has no children, we don't bloat the stream with it
      if (stepStatus === 'pending' && (!step.children || !step.children.length)) {
        return;
      }

      var stepEl = el('div', 'flow-plan-step is-' + stepStatus + (step.collapsed ? ' is-collapsed' : ''), {
        'data-step-id': step.id || String(idx + 1),
        'data-status': stepStatus
      });

      // Step Header Line (Icon/Num + Title + Chevron)
      var stepHead = el('div', 'flow-plan-step__head');

      var stepNum = el('div', 'flow-plan-step__num');
      if (stepStatus === 'done') {
        stepNum.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      } else {
        stepNum.textContent = String(idx + 1);
      }
      stepHead.appendChild(stepNum);

      var stepTitle = el('span', 'flow-plan-step__title', { textContent: step.title || ('阶段 ' + (idx + 1)) });
      stepHead.appendChild(stepTitle);

      var hasChildren = Boolean(step.children && step.children.length);
      if (hasChildren) {
        var chevron = el('span', 'flow-plan-step__chevron');
        chevron.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
        stepHead.appendChild(chevron);

        stepHead.addEventListener('click', function (e) {
          e.stopPropagation();
          stepEl.classList.toggle('is-collapsed');
          if (FC.FlowTimelineRail && typeof FC.FlowTimelineRail.updateAll === 'function') {
            FC.FlowTimelineRail.updateAll(document.body);
            setTimeout(function () {
              FC.FlowTimelineRail.updateAll(document.body);
            }, 180);
          }
        });
      }

      stepEl.appendChild(stepHead);

      // Render step child actions / purposes if present
      if (hasChildren && typeof opts.renderChildren === 'function') {
        var stepBody = el('div', 'flow-plan-step__body');
        var res = opts.renderChildren(step.children);
        if (res) {
          if (res.nodeType) stepBody.appendChild(res);
          else if (Array.isArray(res)) {
            res.forEach(function (c) {
              if (c && c.nodeType) stepBody.appendChild(c);
            });
          }
        }
        stepEl.appendChild(stepBody);
      }

      root.appendChild(stepEl);
    });

    return root;
  }

  FC.TaskRoot = {
    render: render
  };
  FC.PlanRoot = FC.TaskRoot;
})();
