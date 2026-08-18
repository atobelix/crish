/**
 * FlowScrubber.js
 * Minimap scrubber for fast navigation of user messages.
 */
(function () {
  'use strict';

  var dom = window.FlowComponents.dom;

  var state = {
    initialized: false,
    wrapper: null,
    container: null,
    tooltip: null,
    tooltipTitle: null,
    tooltipSnippet: null,
    ticks: [],
    blockTickMap: new WeakMap(),
    intersectionObserver: null,
    debounceTimer: null,
  };

  function init() {
    if (state.initialized) return;
    
    var layout = document.querySelector('.chat-main-pane') || document.querySelector('.chat-app-layout');
    if (!layout) return;

    state.initialized = true;

    // Create DOM structure
    var wrapper = dom.el('div', 'flow-scrubber-wrapper');
    var root = dom.el('div', 'flow-scrubber');
    wrapper.appendChild(root);
    
    // Tooltip
    var tooltip = dom.el('div', 'flow-scrubber__tooltip');
    var tooltipTitle = dom.el('p', 'flow-scrubber__tooltip-title');
    var tooltipSnippet = dom.el('p', 'flow-scrubber__tooltip-snippet');
    tooltip.appendChild(tooltipTitle);
    tooltip.appendChild(tooltipSnippet);
    
    // Append wrapper to chat-main-pane so it automatically anchors to the chat scrollbar
    layout.appendChild(wrapper);
    document.body.appendChild(tooltip);

    state.wrapper = wrapper;
    state.container = root;
    state.tooltip = tooltip;
    state.tooltipTitle = tooltipTitle;
    state.tooltipSnippet = tooltipSnippet;

    // Wheel forwarding backup (guarantees zero dead-zone even if hovered directly)
    wrapper.addEventListener('wheel', function (e) {
      var scroller = document.querySelector('.chat-main-pane') || document.querySelector('.chat-app-layout');
      if (scroller) {
        var dy = e.deltaMode === 1 ? e.deltaY * 36 : e.deltaY;
        scroller.scrollTop += dy;
      }
    }, { passive: true });

    // Setup IntersectionObserver for active state detection (O(1) WeakMap lookup)
    state.intersectionObserver = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        var tickEl = state.blockTickMap.get(entry.target);
        if (tickEl) {
          tickEl.classList.toggle('is-active', entry.isIntersecting);
        }
      });
    }, {
      root: layout, // use actual scroll layout container
      threshold: 0, // as soon as 1px is visible
    });

    // Event listeners
    window.addEventListener('resize', requestRefresh);
    
    // MutationObserver to watch for new user messages
    var streamContainer = document.querySelector('.chat-stream-inner') || document.querySelector('.chat-stream-container') || document.body;
    var mo = new MutationObserver(requestRefresh);
    mo.observe(streamContainer, { childList: true, subtree: false });

    // Initial render
    requestRefresh();
  }

  function requestRefresh() {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(refreshTicks, 300);
  }

  function refreshTicks() {
    // Stop observing old blocks
    if (state.intersectionObserver) {
      state.intersectionObserver.disconnect();
    }
    
    // Clear old ticks
    state.ticks.forEach(function(t) {
      if (t.el.parentNode) t.el.parentNode.removeChild(t.el);
    });
    state.ticks = [];

    // Find all user messages
    var userBlocks = document.querySelectorAll('.flow-msg--user, .chat-message.user');
    
    userBlocks.forEach(function(block) {
      // Get text snippet
      var textContent = block.innerText || block.textContent || '';
      var lines = textContent.trim().split('\n').filter(Boolean);
      var snippet = lines.length > 0 ? lines.join(' ').substring(0, 100) : '用户消息';

      // Look up time
      var id = block.getAttribute('data-id');
      var time = '';
      if (id && window.DemoData && window.DemoData.conversation) {
        var msg = window.DemoData.conversation.find(function(m) { return m.id === id; });
        if (msg && msg.time) time = msg.time;
      }

      // Create tick
      var tickEl = dom.el('div', 'flow-scrubber__tick');
      
      tickEl.addEventListener('mouseenter', function() {
        showTooltip(tickEl, time, snippet);
      });
      tickEl.addEventListener('mouseleave', function() {
        hideTooltip();
      });
      tickEl.addEventListener('click', function(e) {
        e.stopPropagation();
        // Native scrollIntoView works perfectly across all scroll containers
        block.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });

      state.container.appendChild(tickEl);
      
      // Observe the block for intersection
      if (state.intersectionObserver) {
        state.intersectionObserver.observe(block);
      }
      
      state.blockTickMap.set(block, tickEl);
      state.ticks.push({
        el: tickEl,
        block: block
      });
    });
  }

  var tooltipHideTimer = null;

  function showTooltip(anchorEl, time, snippet) {
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }
    if (time) {
      state.tooltipTitle.textContent = time;
      state.tooltipTitle.style.display = 'block';
    } else {
      state.tooltipTitle.style.display = 'none';
    }
    state.tooltipSnippet.textContent = snippet;
    
    // Position tooltip vertically next to the tick
    var tickRect = anchorEl.getBoundingClientRect();
    var tickCenterY = tickRect.top + (tickRect.height / 2);
    
    state.tooltip.style.top = tickCenterY + 'px';
    state.tooltip.style.left = 'auto';
    state.tooltip.style.right = (window.innerWidth - tickRect.left + 12) + 'px';
    state.tooltip.classList.add('is-visible');
  }

  function hideTooltip() {
    if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
    tooltipHideTimer = setTimeout(function () {
      state.tooltip.classList.remove('is-visible');
    }, 60);
  }

  window.FlowComponents = window.FlowComponents || {};
  window.FlowComponents.FlowScrubber = {
    init: init,
    refresh: requestRefresh
  };

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
