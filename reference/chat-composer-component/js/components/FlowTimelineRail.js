/**
 * FlowTimelineRail — Precision Geometric Rail Component.
 * Calculates pixel-perfect, zero-overlap connector lines between icons
 * and alongside expanded code boxes under ANY combination of open/closed states.
 * Fully scoped to immediate action containers, preventing nested container pollution.
 */
(function () {
  'use strict';

  var FC = (window.FlowComponents = window.FlowComponents || {});

  var FlowTimelineRail = {
    /**
     * Recalculate and render timeline connector lines for a container element.
     * @param {HTMLElement} containerEl - Immediate container with .flow-action children
     */
    updateContainer: function (containerEl) {
      if (!containerEl) return;

      // Only query DIRECT child actions to prevent nested container pollution
      var actions = Array.prototype.filter.call(containerEl.children, function (child) {
        return child.classList && child.classList.contains('flow-action');
      });

      var existingSvg = containerEl.querySelector(':scope > .flow-timeline-rail-svg');

      if (actions.length === 0) {
        if (existingSvg) existingSvg.remove();
        return;
      }

      var containerRect = containerEl.getBoundingClientRect();
      if (containerRect.height === 0 || containerRect.width === 0) return;

      var svg = existingSvg;
      if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'flow-timeline-rail-svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        containerEl.insertBefore(svg, containerEl.firstChild);
      }

      // Clear existing lines
      while (svg.firstChild) {
        svg.removeChild(svg.firstChild);
      }

      // Dynamically calculate icon center X relative to containerEl
      var firstHead = actions[0].querySelector('.flow-action__head');
      var iconX = 8;
      if (firstHead) {
        var headRect = firstHead.getBoundingClientRect();
        var iconEl = firstHead.querySelector('.flow-action__icon, .flow-action__marker');
        if (iconEl) {
          var iconRect = iconEl.getBoundingClientRect();
          iconX = (iconRect.left - containerRect.left) + (iconRect.width / 2);
        } else {
          iconX = (headRect.left - containerRect.left) + 8;
        }
      }

      // 1. Render companion rail for EACH expanded action (matches code container height)
      for (var k = 0; k < actions.length; k++) {
        var act = actions[k];
        var isOpen = act.classList.contains('is-open') || act.dataset.open === 'true';
        if (isOpen) {
          var body = act.querySelector('.flow-action__body');
          if (body) {
            var bodyRect = body.getBoundingClientRect();
            if (bodyRect.height > 0) {
              var bodyTop = bodyRect.top - containerRect.top;
              var bodyBottom = bodyRect.bottom - containerRect.top;

              var lineExp = document.createElementNS('http://www.w3.org/2000/svg', 'line');
              lineExp.setAttribute('class', 'flow-timeline-rail-line');
              lineExp.setAttribute('x1', iconX);
              lineExp.setAttribute('y1', bodyTop + 2);
              lineExp.setAttribute('x2', iconX);
              lineExp.setAttribute('y2', Math.max(bodyTop + 2, bodyBottom - 2));
              svg.appendChild(lineExp);
            }
          }
        }
      }

      // 2. Render centered 8px short connector between adjacent CLOSED items
      for (var i = 0; i < actions.length - 1; i++) {
        var act1 = actions[i];
        var act2 = actions[i + 1];

        var isOpen1 = act1.classList.contains('is-open') || act1.dataset.open === 'true';
        if (isOpen1) continue; // If act1 is open, space to act2 is natural whitespace

        var head1 = act1.querySelector('.flow-action__head');
        var head2 = act2.querySelector('.flow-action__head');
        if (!head1 || !head2) continue;

        var head1Rect = head1.getBoundingClientRect();
        var head2Rect = head2.getBoundingClientRect();

        var y1_center = head1Rect.top - containerRect.top + head1Rect.height / 2;
        var y2_center = head2Rect.top - containerRect.top + head2Rect.height / 2;

        var gapMid = (y1_center + y2_center) / 2;
        var segTop = gapMid - 4;
        var segBottom = gapMid + 4;

        var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('class', 'flow-timeline-rail-line');
        line.setAttribute('x1', iconX);
        line.setAttribute('y1', segTop);
        line.setAttribute('x2', iconX);
        line.setAttribute('y2', segBottom);
        svg.appendChild(line);
      }
    },




    /**
     * Update all timeline rail containers across the page.
     * @param {HTMLElement} [root]
     */
    updateAll: function (root) {
      root = root || document.body;
      var containers = Array.prototype.slice.call(
        root.querySelectorAll('.flow-purpose__body')
      );
      containers.forEach(function (c) {
        FlowTimelineRail.updateContainer(c);
      });
    },

    /**
     * Auto-observe DOM changes and expansion clicks to re-render timeline rails automatically.
     * @param {HTMLElement} root
     */
    observe: function (root) {
      root = root || document.body;

      // Event delegation for expansion toggles: update only on user intent and transition completion
      root.addEventListener('click', function (e) {
        var head = e.target.closest('.flow-action.is-expandable > .flow-action__head, .flow-plan-step__head, .flow-subagent__head, .flow-subagent__line1, .flow-purpose__head');
        if (head) {
          requestAnimationFrame(function () {
            FlowTimelineRail.updateAll(root);
          });
          setTimeout(function () {
            FlowTimelineRail.updateAll(root);
          }, 200);
        }
      });
    }
  };

  FC.FlowTimelineRail = FlowTimelineRail;

  // Auto-init on DOMContentLoaded
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        FlowTimelineRail.observe(document.body);
        FlowTimelineRail.updateAll(document.body);
      });
    } else {
      FlowTimelineRail.observe(document.body);
      FlowTimelineRail.updateAll(document.body);
    }
  }
})();
