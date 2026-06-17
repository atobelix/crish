document.addEventListener('DOMContentLoaded', () => {
  // Initialize Lucide Icons
  lucide.createIcons();

  // Reference elements
  const workspaceContainer = document.getElementById('workspace');
  const panelDropdown = document.getElementById('panel-dropdown');
  const dropdownCloseBtn = document.getElementById('dropdown-close-btn');
  const realPanelMenuBtn = document.getElementById('real-panel-menu-btn');
  const sessionContextMenu = document.getElementById('session-context-menu');

  // Sidebar drag reference elements
  const pinnedSessionList = document.getElementById('pinned-session-list');
  const pinnedPlaceholder = document.getElementById('pinned-placeholder');

  // Active dropdown anchor state
  let activeDropdownWorkspaceIndex = 0;
  let activeWorkspaceIndex = 0;
  let activeCardIdInWorkspace = 'card-chat';

  // Global user desired layout preferences
  let userPanelStates = {
    sidebarCollapsed: false,
    preview: true,
    diff: true,
    terminal: false,
    tasks: true,
    plan: true
  };

  // Global layouts configuration for workspaces
  // Every workspace contains its own column matrices, column ratios, card heights weights
  let workspaceData = [
    {
      index: 0,
      dom: document.getElementById('workspace-section-0'),
      canvas: document.getElementById('workspace-canvas-0'),
      columns: [
        [document.getElementById('card-chat'), document.getElementById('card-plan')],
        [document.getElementById('card-preview'), document.getElementById('card-diff')],
        [document.getElementById('card-tasks')]
      ],
      colWidthRatios: [0.38, 0.34, 0.28],
      cardWeights: {
        'card-chat': 1.5,
        'card-plan': 1.0,
        'card-preview': 1.0,
        'card-diff': 1.1,
        'card-tasks': 1.0,
        'card-terminal': 1.0
      }
    }
  ];

  // Expose for debugging
  window.workspaceData = workspaceData;

  const GAP = -1;
  const EDGE_ZONE_WIDTH = 30;

  // Initially hidden cards
  document.getElementById('card-terminal').style.display = 'none';
  workspaceData[0].columns = workspaceData[0].columns.map(col => 
    col.filter(card => card !== document.getElementById('card-terminal'))
  );

  // Re-layout a single workspace canvas
  function layoutWorkspace(ws, overrideWidth, overrideHeight) {
    const W = overrideWidth !== undefined ? overrideWidth : ws.canvas.clientWidth;
    const H = overrideHeight !== undefined ? overrideHeight : ws.canvas.clientHeight;
    
    // Find active columns in this workspace
    const activeCols = ws.columns.map((col, idx) => ({
      index: idx,
      cards: col.filter(c => c && c.style.display !== 'none')
    })).filter(c => c.cards.length > 0);

    const activeCount = activeCols.length;
    if (activeCount === 0) return;

    // Normalize ratios for visible columns
    let currentRatios = activeCols.map(c => ws.colWidthRatios[c.index] || 0.3);
    const ratioSum = currentRatios.reduce((a, b) => a + b, 0);
    if (ratioSum > 0) {
      currentRatios = currentRatios.map(r => r / ratioSum);
    } else {
      currentRatios = activeCols.map(() => 1 / activeCount);
    }

    const availableWidth = W - (GAP * (activeCount - 1));
    let leftOffset = 0;
    const colLayouts = {};

    activeCols.forEach((colData, idx) => {
      const colWidth = availableWidth * currentRatios[idx];
      colLayouts[colData.index] = {
        left: leftOffset,
        width: colWidth
      };

      const cards = colData.cards;
      const cardCount = cards.length;

      // Compute total height weight
      const isSmallScreen = window.innerWidth < 650 || window.innerHeight < 550;
      const isOnlyCol0 = activeCols.length === 1 && activeCols[0].index === 0;
      
      const getCardWeight = (cardEl) => {
        if (isOnlyCol0 && isSmallScreen && cards.length > 1) {
          const cardId = cardEl.id;
          const isActive = cardId.indexOf(activeCardIdInWorkspace) !== -1;
          return isActive ? 4.0 : 1.0;
        }
        if (cardEl.classList.contains('card-placeholder')) {
          return ws.cardWeights[draggedCard.id] || 1.0;
        } else {
          return ws.cardWeights[cardEl.id] || 1.0;
        }
      };

      let totalWeight = 0;
      cards.forEach(card => {
        totalWeight += getCardWeight(card);
      });

      const availableHeight = H - (GAP * (cardCount - 1));
      let currentTop = 0;

      cards.forEach((card, rIndex) => {
        const weight = getCardWeight(card);
        const cardHeight = availableHeight * (weight / totalWeight);

        // Position docked card
        if (!card.classList.contains('dragging')) {
          card.style.left = leftOffset + 'px';
          card.style.top = currentTop + 'px';
          card.style.width = colWidth + 'px';
          card.style.height = cardHeight + 'px';

          // Apply Flat Layout styles to main Chat card when docked and has 1 or fewer tabs
          if (card.id.indexOf('card-chat') !== -1) {
            const tabsCount = card.querySelectorAll('.card-tab').length;
            if (tabsCount <= 1) {
              card.classList.add('flat-layout');
            } else {
              card.classList.remove('flat-layout');
            }
          }
        } else {
          // If being dragged, ensure it gets card styling
          card.classList.remove('flat-layout');
        }

        currentTop += cardHeight + GAP;
      });

      leftOffset += colWidth + GAP;
    });

    // Update or draw column splitters dynamically to avoid DOM thrashing
    const existingColSplitters = new Set();
    activeCols.forEach((colData, idx) => {
      if (idx < activeCount - 1) {
        const colIndex = colData.index;
        let splitter = ws.canvas.querySelector(`.col-splitter[data-col="${colIndex}"]`);
        if (!splitter) {
          splitter = document.createElement('div');
          splitter.className = 'col-splitter';
          splitter.setAttribute('data-ws', ws.index);
          splitter.setAttribute('data-col', colIndex);
          ws.canvas.appendChild(splitter);
          setupColumnSplitterEvents(splitter, ws);
        }
        const colLayout = colLayouts[colIndex];
        splitter.style.left = (colLayout.left + colLayout.width + GAP / 2) + 'px';
        existingColSplitters.add(splitter);
      }
    });
    // Remove obsolete column splitters
    ws.canvas.querySelectorAll('.col-splitter').forEach(s => {
      if (!existingColSplitters.has(s)) {
        s.remove();
      }
    });

    // Update or draw card height row splitters dynamically to avoid DOM thrashing
    const existingRowSplitters = new Set();
    activeCols.forEach(colData => {
      const cards = colData.cards;
      if (cards.length > 1) {
        let accumulatedTop = 0;
        const availableHeight = H - (GAP * (cards.length - 1));
        
        let totalWeight = 0;
        cards.forEach(card => {
          totalWeight += ws.cardWeights[card.id] || 1.0;
        });

        for (let r = 0; r < cards.length - 1; r++) {
          const weight = cards[r].classList.contains('card-placeholder')
            ? (ws.cardWeights[draggedCard.id] || 1.0)
            : (ws.cardWeights[cards[r].id] || 1.0);
            
          const cardHeight = availableHeight * (weight / totalWeight);
          accumulatedTop += cardHeight;

          let splitter = ws.canvas.querySelector(`.row-splitter[data-col="${colData.index}"][data-row="${r}"]`);
          if (!splitter) {
            splitter = document.createElement('div');
            splitter.className = 'row-splitter';
            splitter.setAttribute('data-ws', ws.index);
            splitter.setAttribute('data-col', colData.index);
            splitter.setAttribute('data-row', r);
            ws.canvas.appendChild(splitter);
            setupRowSplitterEvents(splitter, ws);
          }
          
          // Store references to the cards on the splitter element itself
          splitter.cardAbove = cards[r];
          splitter.cardBelow = cards[r+1];

          splitter.style.left = colLayouts[colData.index].left + 'px';
          splitter.style.width = colLayouts[colData.index].width + 'px';
          splitter.style.top = (accumulatedTop + GAP / 2) + 'px';
          
          existingRowSplitters.add(splitter);
          accumulatedTop += GAP;
        }
      }
    });
    // Remove obsolete row splitters
    ws.canvas.querySelectorAll('.row-splitter').forEach(s => {
      if (!existingRowSplitters.has(s)) {
        s.remove();
      }
    });

    // Move LayoutDropdown Trigger to the Top-Right Card
    mountLayoutDropdownTrigger(ws);
  }

  function layoutWorkspaceSidebarResize(ws, dx) {
    const activeCols = ws.sidebarResizeActiveCols;
    if (!activeCols || activeCols.length === 0) return;

    let col0StartWidth = activeCols[0].startWidth || 300;
    let col0NewWidth = col0StartWidth - dx;
    const minColWidth = 150;
    
    if (col0NewWidth < minColWidth) {
      dx = col0StartWidth - minColWidth;
      col0NewWidth = minColWidth;
    }

    let leftOffset = 0;
    const colLayouts = {};

    activeCols.forEach((colData, idx) => {
      const colWidth = idx === 0 ? col0NewWidth : colData.startWidth;
      colLayouts[colData.index] = {
        left: leftOffset,
        width: colWidth
      };

      const cards = colData.cards;
      cards.forEach((card) => {
        if (!card.classList.contains('dragging')) {
          card.style.left = leftOffset + 'px';
          if (idx === 0) {
            card.style.width = colWidth + 'px';
          }
        }
      });

      leftOffset += colWidth + GAP;
    });

    activeCols.forEach((colData, idx) => {
      if (idx < activeCols.length - 1) {
        const colIndex = colData.index;
        let splitter = ws.canvas.querySelector(`.col-splitter[data-col="${colIndex}"]`);
        if (splitter) {
          const colLayout = colLayouts[colIndex];
          splitter.style.left = (colLayout.left + colLayout.width + GAP / 2) + 'px';
        }
      }
    });

    activeCols.forEach(colData => {
      const colIndex = colData.index;
      const colLayout = colLayouts[colIndex];
      ws.canvas.querySelectorAll(`.row-splitter[data-col="${colIndex}"]`).forEach(splitter => {
        splitter.style.left = colLayout.left + 'px';
        splitter.style.width = colLayout.width + 'px';
      });
    });
  }

  function layoutAll() {
    workspaceData.forEach(ws => layoutWorkspace(ws));
  }

  // Find the top-right card of a workspace and mount the Layout Toggle button on its header
  function mountLayoutDropdownTrigger(ws) {
    const activeCols = ws.columns.map((col, idx) => ({
      index: idx,
      cards: col.filter(c => c && c.style.display !== 'none')
    })).filter(c => c.cards.length > 0);

    // Remove trigger from any placeholders in this workspace
    ws.canvas.querySelectorAll('.panel-menu-placeholder').forEach(ph => {
      ph.innerHTML = '';
    });

    if (activeCols.length === 0) return;

    // Rightmost active column
    const rightmostCol = activeCols[activeCols.length - 1];
    // Top card in that column
    const topRightCard = rightmostCol.cards[0];

    if (topRightCard) {
      const placeholder = topRightCard.querySelector('.panel-menu-placeholder');
      if (placeholder) {
        // Mount trigger
        placeholder.appendChild(realPanelMenuBtn);
        realPanelMenuBtn.setAttribute('data-active-ws', ws.index);
      }
    }
  }

  // Layout dropmenu anchor alignment
  realPanelMenuBtn.addEventListener('click', (e) => {
    activeDropdownWorkspaceIndex = parseInt(realPanelMenuBtn.getAttribute('data-active-ws')) || 0;
    
    // Position dropdown under the clicked button
    const rect = realPanelMenuBtn.getBoundingClientRect();
    panelDropdown.style.left = (rect.left + rect.width - 210) + 'px';
    panelDropdown.style.top = (rect.top + rect.height + 4) + 'px';
    panelDropdown.classList.toggle('open');
    e.stopPropagation();
  });

  dropdownCloseBtn.addEventListener('click', (e) => {
    panelDropdown.classList.remove('open');
    e.stopPropagation();
  });

  document.addEventListener('click', (e) => {
    if (!panelDropdown.contains(e.target) && !realPanelMenuBtn.contains(e.target)) {
      panelDropdown.classList.remove('open');
    }
  });

  // Toggle Panel Visibility inside active workspace
  const panelToggles = {
    'preview': document.getElementById('toggle-preview'),
    'diff': document.getElementById('toggle-diff'),
    'terminal': document.getElementById('toggle-terminal'),
    'tasks': document.getElementById('toggle-tasks'),
    'plan': document.getElementById('toggle-plan')
  };

  Object.keys(panelToggles).forEach(key => {
    const checkbox = panelToggles[key];
    checkbox.addEventListener('change', () => {
      userPanelStates[key] = checkbox.checked;
      applyResponsiveLayout(false);
    });
  });

  function toggleCardInWorkspace(ws, key, isVisible) {
    // Look up card inside this workspace canvas
    let card = ws.canvas.querySelector(`[id^="card-${key}"]`);
    
    if (!card) {
      // If not found (e.g. for cloned workspaces), clone the card template
      const template = document.getElementById(`card-${key}`);
      if (template) {
        card = template.cloneNode(true);
        card.id = `card-${key}-${ws.index}`;
        
        // Reset tabs bar for cloned card
        const headerLeft = card.querySelector('.card-header-left');
        if (headerLeft) {
          headerLeft.innerHTML = '';
          headerLeft.className = 'card-header-left';
        }
        initCardTabs(card);
        
        ws.canvas.appendChild(card);
        
        // Initialize Lucide icons on cloned card
        lucide.createIcons({
          attrs: { 'stroke-width': 2 },
          nameAttr: 'data-lucide',
          node: card
        });
        
        setupCardEvents(card, ws.index);
      }
    }

    if (!card) return;

    if (isVisible) {
      card.style.display = 'flex';
      
      // Determine default column index (0 = Chat/Plan, 1 = Preview/Diff, 2 = Tasks/Terminal)
      let defaultCol = 1;
      if (key === 'plan') defaultCol = 0;
      if (key === 'tasks' || key === 'terminal') defaultCol = 2;

      // Expand columns list if defaultCol is out of bounds
      while (ws.columns.length <= defaultCol) {
        ws.columns.push([]);
        ws.colWidthRatios.push(0.3);
      }

      // Check if it already exists to avoid duplicates
      let exists = false;
      ws.columns.forEach(col => {
        if (col.includes(card)) exists = true;
      });

      if (!exists) {
        ws.columns[defaultCol].push(card);
        ws.cardWeights[card.id] = 1.0;
      }
    } else {
      card.style.display = 'none';
      ws.columns = ws.columns.map(col => col.filter(item => item !== card));
    }

    layoutWorkspace(ws);
    invalidateDOMCache(); // card visibility changed
  }

  // Bind close buttons for statically defined cards
  document.querySelectorAll('.workspace-card .close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = btn.closest('.workspace-card');
      const wsSection = btn.closest('.workspace-section');
      const wsIndex = parseInt(wsSection.id.split('-').pop()) || 0;
      const ws = workspaceData[wsIndex];

      if (card.id.indexOf('card-chat') !== -1) {
        // For cloned workspaces, closing Chat deletes the entire workspace!
        if (wsIndex > 0) {
          destroyWorkspace(wsIndex);
        }
        return;
      }

      let key = null;
      if (card.id.indexOf('card-preview') !== -1) key = 'preview';
      if (card.id.indexOf('card-diff') !== -1) key = 'diff';
      if (card.id.indexOf('card-terminal') !== -1) key = 'terminal';
      if (card.id.indexOf('card-tasks') !== -1) key = 'tasks';
      if (card.id.indexOf('card-plan') !== -1) key = 'plan';

      if (key) {
        userPanelStates[key] = false;
        applyResponsiveLayout(false);
      }
      e.stopPropagation();
    });
  });

  // Setup Cloned card handlers
  function setupClonedCardEvents(card, wsIdx) {
    const ws = workspaceData[wsIdx];
    
    // Close button
    const closeBtn = card.querySelector('.close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        destroyWorkspace(wsIdx);
        e.stopPropagation();
      });
    }

    // Auto-grow textarea
    const textarea = card.querySelector('textarea');
    if (textarea) {
      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      });
    }
  }

  function setupCardEvents(card, wsIdx) {
    const ws = workspaceData[wsIdx];
    const closeBtn = card.querySelector('.close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        let key = null;
        if (card.id.indexOf('card-preview') !== -1) key = 'preview';
        if (card.id.indexOf('card-diff') !== -1) key = 'diff';
        if (card.id.indexOf('card-terminal') !== -1) key = 'terminal';
        if (card.id.indexOf('card-tasks') !== -1) key = 'tasks';
        if (card.id.indexOf('card-plan') !== -1) key = 'plan';

        if (key) {
          userPanelStates[key] = false;
          applyResponsiveLayout(false);
        }
        e.stopPropagation();
      });
    }
  }

  // Row splitter dragging event helper (Horizontal card resize in column)
  function setupRowSplitterEvents(splitter, ws) {
    let startY = 0;
    let weightAbove = 0;
    let weightBelow = 0;
    let heightSum = 0;
    let isResizing = false;

    splitter.addEventListener('mousedown', (e) => {
      const cardAbove = splitter.cardAbove;
      const cardBelow = splitter.cardBelow;
      if (!cardAbove || !cardBelow) return;

      isResizing = true;
      startY = e.clientY;
      weightAbove = ws.cardWeights[cardAbove.id] || 1.0;
      weightBelow = ws.cardWeights[cardBelow.id] || 1.0;
      
      const rectAbove = cardAbove.getBoundingClientRect();
      const rectBelow = cardBelow.getBoundingClientRect();
      heightSum = rectAbove.height + rectBelow.height;

      splitter.classList.add('active');
      document.body.classList.add('resizing-active');

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);

      e.preventDefault();
      e.stopPropagation();
    });

    const onMouseMove = (e) => {
      if (!isResizing) return;
      const cardAbove = splitter.cardAbove;
      const cardBelow = splitter.cardBelow;
      if (!cardAbove || !cardBelow) return;
      
      const dy = e.clientY - startY;
      
      // Calculate pixel to weight ratio
      const totalWeight = weightAbove + weightBelow;
      const dyWeight = (dy / heightSum) * totalWeight;

      let newWeightAbove = weightAbove + dyWeight;
      let newWeightBelow = weightBelow - dyWeight;

      // Bound minimum weight to 0.3 to prevent panel disappearing
      if (newWeightAbove > 0.3 && newWeightBelow > 0.3) {
        ws.cardWeights[cardAbove.id] = newWeightAbove;
        ws.cardWeights[cardBelow.id] = newWeightBelow;
        layoutWorkspace(ws);
      }
    };

    const onMouseUp = () => {
      if (!isResizing) return;
      isResizing = false;
      splitter.classList.remove('active');
      document.body.classList.remove('resizing-active');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }

  // Column splitter dragging event helper (Vertical column width resize)
  function setupColumnSplitterEvents(splitter, ws) {
    let isResizing = false;
    let resizeStartX = 0;
    let resizeStartRatio0 = 0;
    let resizeStartRatio1 = 0;

    splitter.addEventListener('mousedown', (e) => {
      isResizing = true;
      resizeStartX = e.clientX;
      splitter.classList.add('active');
      document.body.classList.add('resizing-active');

      const colIndex = parseInt(splitter.getAttribute('data-col'));
      
      // Find visible columns in this workspace
      const activeCols = ws.columns.map((col, idx) => ({
        index: idx,
        cards: col.filter(c => c && c.style.display !== 'none')
      })).filter(c => c.cards.length > 0);

      resizeStartRatio0 = ws.colWidthRatios[colIndex];

      const activeColIndices = activeCols.map(c => c.index);
      const pos = activeColIndices.indexOf(colIndex);
      const nextColIdx = activeColIndices[pos + 1];

      resizeStartRatio1 = ws.colWidthRatios[nextColIdx];

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);

      e.preventDefault();
      e.stopPropagation();
    });

    const onMouseMove = (e) => {
      if (!isResizing) return;

      const dx = e.clientX - resizeStartX;
      const canvasWidth = ws.canvas.clientWidth;
      const dxPercent = dx / canvasWidth;

      const colIndex = parseInt(splitter.getAttribute('data-col'));
      const activeCols = ws.columns.map((col, idx) => ({
        index: idx,
        cards: col.filter(c => c && c.style.display !== 'none')
      })).filter(c => c.cards.length > 0);

      const activeColIndices = activeCols.map(c => c.index);
      const pos = activeColIndices.indexOf(colIndex);
      const nextColIdx = activeColIndices[pos + 1];

      let newRatio0 = resizeStartRatio0 + dxPercent;
      let newRatio1 = resizeStartRatio1 - dxPercent;

      const minRatio = 0.15;
      if (newRatio0 >= minRatio && newRatio1 >= minRatio) {
        ws.colWidthRatios[colIndex] = newRatio0;
        ws.colWidthRatios[nextColIdx] = newRatio1;

        // Keep sum constant
        const startSum = resizeStartRatio0 + resizeStartRatio1;
        const currentSum = newRatio0 + newRatio1;
        const factor = startSum / currentSum;

        ws.colWidthRatios[colIndex] *= factor;
        ws.colWidthRatios[nextColIdx] *= factor;

        layoutWorkspace(ws);
      }
    };

    const onMouseUp = () => {
      if (!isResizing) return;
      isResizing = false;
      splitter.classList.remove('active');
      document.body.classList.remove('resizing-active');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }

  // Destroy a workspace vertical section
  function destroyWorkspace(idx) {
    if (idx === 0 || idx >= workspaceData.length) return;
    
    const ws = workspaceData[idx];
    
    // Remove Splitter if exists
    const splitter = document.getElementById(`workspace-splitter-${idx}`);
    if (splitter) splitter.remove();
    
    // Remove DOM section
    ws.dom.remove();
    
    // Remove from array
    workspaceData.splice(idx, 1);
    
    // Re-index remaining workspaces
    for (let i = 1; i < workspaceData.length; i++) {
      workspaceData[i].index = i;
      workspaceData[i].dom.id = `workspace-section-${i}`;
      workspaceData[i].canvas.id = `workspace-canvas-${i}`;
      
      const split = document.querySelector(`.workspace-splitter[data-ws="${i+1}"]`);
      if (split) {
        split.id = `workspace-splitter-${i}`;
        split.setAttribute('data-ws', i);
      }
    }
    
    layoutAll();
    invalidateDOMCache(); // workspace destroyed
  }

  // Setup Workspace Splitter resizers (drag to adjust vertical columns widths side-by-side)
  function setupWorkspaceSplitterEvent(splitter) {
    let isResizing = false;
    let startX = 0;
    let wsIndex = 0;
    let ws0StartWidth = 0;
    let ws1StartWidth = 0;

    splitter.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      wsIndex = parseInt(splitter.getAttribute('data-ws'));
      
      ws0StartWidth = workspaceData[wsIndex - 1].dom.getBoundingClientRect().width;
      ws1StartWidth = workspaceData[wsIndex].dom.getBoundingClientRect().width;
      
      splitter.classList.add('active');
      e.preventDefault();
      e.stopPropagation();
    });

    const onMouseMove = (e) => {
      if (!isResizing) return;

      const dx = e.clientX - startX;
      
      const newWidth0 = ws0StartWidth + dx;
      const newWidth1 = ws1StartWidth - dx;

      if (newWidth0 > 200 && newWidth1 > 200) {
        // Distribute flex weights
        const totalWidth = ws0StartWidth + ws1StartWidth;
        const flex0 = (newWidth0 / totalWidth) * 2;
        const flex1 = (newWidth1 / totalWidth) * 2;

        workspaceData[wsIndex - 1].dom.style.flex = flex0;
        workspaceData[wsIndex].dom.style.flex = flex1;

        layoutAll();
      }
    };

    const onMouseUp = () => {
      if (!isResizing) return;
      isResizing = false;
      splitter.classList.remove('active');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    splitter.addEventListener('mousedown', () => {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }


  // Drag & Drop Cards Interaction (Docking / Swapping / Snapping columns)
  let isDragging = false;
  let draggedCard = null;
  let placeholder = null;
  let currentDragWs = null;

  let dragStartX = 0, dragStartY = 0;
  let dragOffsetX = 0, dragOffsetY = 0;
  
  let placeholderCol = 0;
  let placeholderRow = 0;

  const tabDropIndicator = document.createElement('div');
  tabDropIndicator.className = 'tab-drop-indicator';

  // Edge docking indicator DOM
  let edgeDockIndicator = document.createElement('div');
  edgeDockIndicator.className = 'edge-dock-indicator';

  // Tab Dragging state
  let isDraggingTab = false;
  let draggedTabEl = null;
  let tabGhostEl = null;
  let tabSourceCard = null;
  let tabSourceTabBar = null;
  let tabOriginalParent = null;
  let tabOriginalIndex = -1;
  let tabHoveredTabBar = null;
  let tabHoveredCard = null;
  let tabInsertBeforeEl = null;
  let ghostStartX = 0;
  let ghostStartY = 0;

  // Tab Drag Threshold state
  let pendingTab = null;
  let pendingTabClose = null;
  let tabDragStartX = 0;
  let tabDragStartY = 0;

  let dragCanvasRect = null;

  // Tab drag caching variables for avoiding layout thrashing
  let cachedTabRects = [];
  let cachedCardRects = [];
  let lastHoveredTabBar = null;

  function updateTabRectsCache(tabBar) {
    const tabBarRect = tabBar.getBoundingClientRect();
    const tabs = Array.from(tabBar.querySelectorAll('.card-tab:not(.tab-ghost-floating)'));
    cachedTabRects = tabs.map(t => {
      const rect = t.getBoundingClientRect();
      return {
        el: t,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        midX: rect.left + rect.width / 2,
        relLeft: rect.left - tabBarRect.left
      };
    });
  }

  // Sidebar sorting and pinning helpers
  let sessionOriginalParent = null;
  function isOverElement(e, el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right &&
           e.clientY >= r.top && e.clientY <= r.bottom;
  }

  function handleListReordering(e, list, draggedItem) {
    const items = Array.from(list.querySelectorAll('.session-item:not(.ghost-dragging), .folder-group:not(.ghost-dragging)'));
    let targetItem = null;
    for (const item of items) {
      const r = item.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom) { targetItem = item; break; }
    }
    if (targetItem && targetItem !== draggedItem && targetItem.parentNode === list) {
      animateListLayout(() => {
        const tr = targetItem.getBoundingClientRect();
        const next = (e.clientY > tr.top + tr.height / 2) ? targetItem.nextSibling : targetItem;
        list.insertBefore(draggedItem, next);
      });
    } else if (!targetItem && items.length > 0) {
      const last = items[items.length - 1];
      if (last && e.clientY > last.getBoundingClientRect().bottom) {
        animateListLayout(() => list.appendChild(draggedItem));
      }
    }
  }

  // --- DOM QUERY CACHE ---
  // Cached NodeLists updated only when card set changes, not per-frame.
  let cachedWorkspaceCards = [];
  let cachedTabBars = [];

  function invalidateDOMCache() {
    cachedWorkspaceCards = Array.from(document.querySelectorAll('.workspace-card'));
    cachedTabBars = cachedWorkspaceCards
      .map(c => c.querySelector('.tabs-bar'))
      .filter(Boolean);
  }

  // Hovered tab bar and card are tracked dynamically during drag gestures for maximum performance

  // --- TABS SYSTEM FUNCTIONS ---
  function initCardTabs(card) {
    const headerLeft = card.querySelector('.card-header-left');
    if (!headerLeft || headerLeft.classList.contains('tabs-bar')) return;

    // Save title and icon
    const icon = headerLeft.querySelector('i, svg');
    const titleSpan = headerLeft.querySelector('.card-title');
    const chevron = headerLeft.querySelector('.title-chevron');

    // Create tabs bar
    headerLeft.innerHTML = '';
    headerLeft.classList.add('tabs-bar');

    // Create default tab
    const tab = document.createElement('div');
    tab.className = 'card-tab active';
    tab.setAttribute('data-card-id', card.id);

    const iconContainer = document.createElement('div');
    iconContainer.className = 'tab-icon-container';
    if (icon) iconContainer.appendChild(icon);

    const tabClose = document.createElement('button');
    tabClose.className = 'tab-close-btn';
    tabClose.innerHTML = '<i data-lucide="x"></i>';
    iconContainer.appendChild(tabClose);

    if (card.id.indexOf('card-chat') !== -1) {
      tabClose.style.display = 'none';
    }

    tab.appendChild(iconContainer);
    if (titleSpan) tab.appendChild(titleSpan);
    if (chevron) tab.appendChild(chevron);

    headerLeft.appendChild(tab);

    lucide.createIcons({
      attrs: { 'stroke-width': 2 },
      nameAttr: 'data-lucide',
      node: tabClose
    });

    tabClose.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(card, card.id);
    });
  }

  function switchActiveTab(card, cardId) {
    card.querySelectorAll('.card-tab').forEach(t => t.classList.remove('active'));
    const activeTab = card.querySelector(`.card-tab[data-card-id="${cardId}"]`);
    if (activeTab) activeTab.classList.add('active');

    const contentSelectors = [
      '.chat-body', '.chat-footer',
      '.plan-body', '.plan-subheader',
      '.preview-body', '.preview-subheader',
      '.diff-body', '.diff-subheader',
      '.tasks-body', '.tasks-subheader',
      '.terminal-body', '.terminal-subheader'
    ];
    contentSelectors.forEach(sel => {
      card.querySelectorAll(sel).forEach(el => {
        el.style.display = 'none';
      });
    });

    let key = cardId.replace('card-', '');
    if (key.indexOf('-') !== -1) {
      key = key.split('-')[0];
    }

    if (key === 'chat') {
      card.querySelectorAll('.chat-body, .chat-footer').forEach(el => el.style.display = 'flex');
    } else {
      card.querySelectorAll(`.${key}-body, .${key}-subheader`).forEach(el => el.style.display = 'flex');
    }
  }

  function moveBodyBackToOriginal(cardId) {
    const originalCard = document.getElementById(cardId);
    if (!originalCard) return;

    let key = cardId.replace('card-', '');
    if (key.indexOf('-') !== -1) {
      key = key.split('-')[0];
    }

    let bodies;
    if (key === 'chat') {
      bodies = document.querySelectorAll('.chat-body, .chat-footer');
    } else {
      bodies = document.querySelectorAll(`.${key}-body, .${key}-subheader`);
    }

    bodies.forEach(body => {
      if (body.parentNode && body.parentNode !== originalCard) {
        originalCard.appendChild(body);
      }
    });
  }

  function mergeAllTabsIntoChat(ws) {
    const chatCard = ws.canvas.querySelector('[id^="card-chat"]');
    if (!chatCard) return;

    const cards = Array.from(ws.canvas.querySelectorAll('.workspace-card'));
    cards.forEach(card => {
      if (card.id.indexOf('card-chat') !== -1 || card.style.display === 'none') return;
      
      const tabs = Array.from(card.querySelectorAll('.card-tab'));
      tabs.forEach(tab => {
        const cardId = tab.getAttribute('data-card-id');
        let key = cardId.replace('card-', '');
        if (key.indexOf('-') !== -1) {
          key = key.split('-')[0];
        }

        let bodies = document.querySelectorAll(`.${key}-body, .${key}-subheader`);
        bodies.forEach(body => {
          chatCard.appendChild(body);
        });

        let existingTab = chatCard.querySelector(`.card-tab[data-card-id="${cardId}"]`);
        if (!existingTab) {
          const chatTabBar = chatCard.querySelector('.tabs-bar');
          if (chatTabBar) {
            chatTabBar.appendChild(tab);
          }
        }
      });

      card.style.display = 'none';
      ws.columns = ws.columns.map(col => col.filter(item => item !== card));
    });

    const activeTab = chatCard.querySelector('.card-tab.active');
    const activeId = activeTab ? activeTab.getAttribute('data-card-id') : 'card-chat';
    switchActiveTab(chatCard, activeId);
  }

  function restoreAllTabsFromChat(ws) {
    const chatCard = ws.canvas.querySelector('[id^="card-chat"]');
    if (!chatCard) return;

    const chatTabs = Array.from(chatCard.querySelectorAll('.card-tab'));
    chatTabs.forEach(tab => {
      const cardId = tab.getAttribute('data-card-id');
      if (cardId.indexOf('card-chat') !== -1) return; // Keep chat tab in chat card

      let key = cardId.replace('card-', '');
      if (key.indexOf('-') !== -1) {
        key = key.split('-')[0];
      }

      let originalCard = ws.canvas.querySelector(`[id^="card-${key}"]`);
      if (originalCard && userPanelStates[key]) {
        let bodies = document.querySelectorAll(`.${key}-body, .${key}-subheader`);
        bodies.forEach(body => {
          originalCard.appendChild(body);
        });

        const targetTabBar = originalCard.querySelector('.tabs-bar');
        if (targetTabBar) {
          targetTabBar.appendChild(tab);
        }

        originalCard.style.display = 'flex';
        
        let defaultCol = 1;
        if (key === 'plan') defaultCol = 0;
        if (key === 'tasks' || key === 'terminal') defaultCol = 2;

        while (ws.columns.length <= defaultCol) {
          ws.columns.push([]);
          ws.colWidthRatios.push(0.3);
        }

        let exists = false;
        ws.columns.forEach(col => {
          if (col.includes(originalCard)) exists = true;
        });

        if (!exists) {
          ws.columns[defaultCol].push(originalCard);
          ws.cardWeights[originalCard.id] = 1.0;
        }
      }
    });
  }

  function closeTab(card, cardId) {
    let key = cardId.replace('card-', '');
    if (key.indexOf('-') !== -1) {
      key = key.split('-')[0];
    }

    const wsSection = card.closest('.workspace-section');
    const wsIndex = parseInt(wsSection.id.split('-').pop()) || 0;
    const ws = workspaceData[wsIndex];

    if (key === 'chat' && wsIndex === 0) {
      return;
    }

    const tabEl = card.querySelector(`.card-tab[data-card-id="${cardId}"]`);
    if (tabEl) tabEl.remove();

    moveBodyBackToOriginal(cardId);

    // If closing Chat tab in a cloned workspace, delete the workspace
    if (key === 'chat') {
      if (wsIndex > 0) {
        destroyWorkspace(wsIndex);
      }
      return;
    }

    const remainingTabs = card.querySelectorAll('.card-tab');
    if (remainingTabs.length > 0) {
      switchActiveTab(card, remainingTabs[0].getAttribute('data-card-id'));
    } else {
      card.style.display = 'none';
      ws.columns = ws.columns.map(col => col.filter(item => item !== card));
      layoutWorkspace(ws);
      invalidateDOMCache(); // card hidden when last tab closed
    }

    if (wsIndex === activeDropdownWorkspaceIndex && panelToggles[key]) {
      panelToggles[key].checked = false;
    }
  }

  function closeCard(card) {
    const wsSection = card.closest('.workspace-section');
    if (!wsSection) return;
    const wsIndex = parseInt(wsSection.id.split('-').pop()) || 0;
    const ws = workspaceData[wsIndex];
    
    if (card.id.indexOf('card-chat') !== -1) {
      if (wsIndex > 0) {
        destroyWorkspace(wsIndex);
      }
      return;
    }
    
    let key = null;
    if (card.id.indexOf('card-preview') !== -1) key = 'preview';
    if (card.id.indexOf('card-diff') !== -1) key = 'diff';
    if (card.id.indexOf('card-terminal') !== -1) key = 'terminal';
    if (card.id.indexOf('card-tasks') !== -1) key = 'tasks';
    if (card.id.indexOf('card-plan') !== -1) key = 'plan';
    
    card.style.display = 'none';
    ws.columns = ws.columns.map(col => col.filter(item => item !== card));
    layoutWorkspace(ws);
    invalidateDOMCache(); // card explicitly closed
    
    if (wsIndex === activeDropdownWorkspaceIndex && key && panelToggles[key]) {
      panelToggles[key].checked = false;
    }
  }

  function mergeTabIntoCard(sourceCard, targetCard, cardId) {
    const tabEl = sourceCard.querySelector(`.card-tab[data-card-id="${cardId}"]`);
    if (tabEl) {
      tabEl.remove();
    }

    let key = cardId.replace('card-', '');
    if (key.indexOf('-') !== -1) {
      key = key.split('-')[0];
    }

    let bodies;
    if (key === 'chat') {
      bodies = document.querySelectorAll('.chat-body, .chat-footer');
    } else {
      bodies = document.querySelectorAll(`.${key}-body, .${key}-subheader`);
    }

    bodies.forEach(body => {
      targetCard.appendChild(body);
    });

    let existingTab = targetCard.querySelector(`.card-tab[data-card-id="${cardId}"]`);
    if (!existingTab) {
      const targetTabBar = targetCard.querySelector('.tabs-bar');
      if (targetTabBar) {
        const newTab = document.createElement('div');
        newTab.className = 'card-tab';
        newTab.setAttribute('data-card-id', cardId);

        let iconHtml = '';
        let titleText = '';
        if (key === 'chat') { iconHtml = '<i data-lucide="folder"></i>'; titleText = '审计三个项目的代码统一性问题'; }
        if (key === 'plan') { iconHtml = '<i data-lucide="scroll"></i>'; titleText = 'Plan'; }
        if (key === 'preview') { iconHtml = '<i data-lucide="eye"></i>'; titleText = 'Preview'; }
        if (key === 'diff') { iconHtml = '<i data-lucide="git-branch"></i>'; titleText = 'Diff'; }
        if (key === 'tasks') { iconHtml = '<i data-lucide="check-square"></i>'; titleText = 'Tasks'; }
        if (key === 'terminal') { iconHtml = '<i data-lucide="terminal"></i>'; titleText = 'Terminal'; }

        newTab.innerHTML = `<div class="tab-icon-container">${iconHtml}<button class="tab-close-btn"><i data-lucide="x"></i></button></div><span class="tab-title">${titleText}</span>`;

        targetTabBar.appendChild(newTab);

        lucide.createIcons({
          attrs: { 'stroke-width': 2 },
          nameAttr: 'data-lucide',
          node: newTab
        });

        const tabClose = newTab.querySelector('.tab-close-btn');
        tabClose.addEventListener('click', (e) => {
          e.stopPropagation();
          closeTab(targetCard, cardId);
        });
      }
    }

    switchActiveTab(targetCard, cardId);

    const remainingTabs = sourceCard.querySelectorAll('.card-tab');
    if (remainingTabs.length > 0) {
      switchActiveTab(sourceCard, remainingTabs[0].getAttribute('data-card-id'));
    } else {
      sourceCard.style.display = 'none';
      const wsSection = sourceCard.closest('.workspace-section');
      const wsIndex = parseInt(wsSection.id.split('-').pop()) || 0;
      const ws = workspaceData[wsIndex];
      ws.columns = ws.columns.map(col => col.filter(item => item !== sourceCard));
      layoutWorkspace(ws);
      invalidateDOMCache(); // source card hidden after tab merge
    }
  }



  function updateCardDragPlaceholder(e) {
    if (!currentDragWs || !draggedCard) return;
    
    const canvasRect = currentDragWs.canvas.getBoundingClientRect();
    const mouseX = e.clientX - canvasRect.left;
    const mouseY = e.clientY - canvasRect.top;
    
    const W = currentDragWs.canvas.clientWidth;
    const H = currentDragWs.canvas.clientHeight;

    if (mouseX >= W - EDGE_ZONE_WIDTH) {
      edgeDockIndicator.style.display = 'block';
      edgeDockIndicator.style.left = (W - 108) + 'px';
      edgeDockIndicator.style.top = '8px';
      edgeDockIndicator.style.height = (H - 16) + 'px';
      edgeDockIndicator.style.width = '100px';
      return;
    }
    else if (mouseX <= EDGE_ZONE_WIDTH) {
      edgeDockIndicator.style.display = 'block';
      edgeDockIndicator.style.left = '8px';
      edgeDockIndicator.style.top = '8px';
      edgeDockIndicator.style.height = (H - 16) + 'px';
      edgeDockIndicator.style.width = '100px';
      return;
    } else {
      edgeDockIndicator.style.display = 'none';
    }

    const activeCols = currentDragWs.columns.map((col, idx) => ({
      index: idx,
      cards: col.filter(c => c && c.style.display !== 'none')
    })).filter(c => c.cards.length > 0);

    const activeCount = activeCols.length;
    let currentLeft = 0;
    let targetColIdx = placeholderCol;

    let currentRatios = activeCols.map(c => currentDragWs.colWidthRatios[c.index] || 0.3);
    const ratioSum = currentRatios.reduce((a, b) => a + b, 0);
    if (ratioSum > 0) {
      currentRatios = currentRatios.map(r => r / ratioSum);
    }

    const availableWidth = W - (GAP * (activeCount - 1));

    for (let i = 0; i < activeCols.length; i++) {
      const colIndex = activeCols[i].index;
      const colWidth = availableWidth * currentRatios[i];
      const colRight = currentLeft + colWidth;

      if (mouseX >= currentLeft - GAP/2 && mouseX <= colRight + GAP/2) {
        targetColIdx = colIndex;
        break;
      }
      currentLeft += colWidth + GAP;
    }

    const targetColCards = currentDragWs.columns[targetColIdx];
    const cardCount = targetColCards.length;
    let targetRowIdx = placeholderRow;

    if (cardCount > 0) {
      const availableHeight = H - (GAP * (cardCount - 1));
      let totalWeight = 0;
      targetColCards.forEach(card => {
        if (card.classList.contains('card-placeholder')) {
          totalWeight += currentDragWs.cardWeights[draggedCard.id] || 1.0;
        } else {
          totalWeight += currentDragWs.cardWeights[card.id] || 1.0;
        }
      });

      let bestRow = 0;
      let accumulatedTop = 0;
      let minDistance = Infinity;

      for (let r = 0; r <= cardCount; r++) {
        const slotCenter = accumulatedTop + (H / cardCount) / 2;
        const dist = Math.abs(mouseY - slotCenter);
        if (dist < minDistance) {
          minDistance = dist;
          bestRow = r;
        }
        accumulatedTop += (H / cardCount) + GAP;
      }

      targetRowIdx = Math.min(bestRow, cardCount - 1);
    } else {
      targetRowIdx = 0;
    }

    if (targetColIdx !== placeholderCol || targetRowIdx !== placeholderRow) {
      currentDragWs.columns[placeholderCol] = currentDragWs.columns[placeholderCol].filter(item => item !== placeholder);
      currentDragWs.columns[targetColIdx].splice(targetRowIdx, 0, placeholder);

      placeholderCol = targetColIdx;
      placeholderRow = targetRowIdx;

      layoutWorkspace(currentDragWs);
    }
  }

  // Bind tab click events globally
  document.addEventListener('click', (e) => {
    const tabClose = e.target.closest('.tab-close-btn');
    if (tabClose) {
      const tab = tabClose.closest('.card-tab');
      if (tab) {
        const card = tab.closest('.workspace-card');
        const cardId = tab.getAttribute('data-card-id');
        if (card && cardId) {
          closeTab(card, cardId);
          e.stopPropagation();
          e.preventDefault();
        }
      }
      return;
    }

    const tab = e.target.closest('.card-tab');
    if (tab) {
      const card = tab.closest('.workspace-card');
      if (card) {
        const cardId = tab.getAttribute('data-card-id');
        switchActiveTab(card, cardId);
      }
    }
  });

  // Initialize tabs for all static cards including the primary Chat card
  document.querySelectorAll('.workspace-card').forEach(initCardTabs);

  // Mouse Down Event for dragging
  document.addEventListener('mousedown', (e) => {
    const sessionItem = e.target.closest('.draggable-session');
    if (sessionItem) return;

    // Middle click action: close tab or card
    if (e.button === 1) {
      const tab = e.target.closest('.card-tab');
      if (tab) {
        const card = tab.closest('.workspace-card');
        const cardId = tab.getAttribute('data-card-id');
        if (card && cardId) {
          closeTab(card, cardId);
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      
      const handle = e.target.closest('.card-drag-handle');
      if (handle) {
        const card = handle.closest('.workspace-card');
        if (card) {
          closeCard(card);
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
    }

    // Only allow left click for dragging
    if (e.button !== 0) return;

    const tab = e.target.closest('.card-tab');
    const isTabClose = e.target.closest('.tab-close-btn');

    if (tab && !isTabClose) {
      pendingTab = tab;
      pendingTabClose = isTabClose;
      tabDragStartX = e.clientX;
      tabDragStartY = e.clientY;
      
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const handle = e.target.closest('.card-drag-handle');
    if (!handle) return;

    const card = handle.closest('.workspace-card');
    if (!card) return;

    const wsSection = card.closest('.workspace-section');
    if (!wsSection) return;

    const wsIndex = parseInt(wsSection.id.split('-').pop()) || 0;
    currentDragWs = workspaceData[wsIndex];

    isDragging = true;
    draggedCard = card;

    const rect = card.getBoundingClientRect();
    dragCanvasRect = currentDragWs.canvas.getBoundingClientRect();
    
    dragStartX = rect.left - dragCanvasRect.left;
    dragStartY = rect.top - dragCanvasRect.top;

    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;

    card.classList.add('dragging');
    card.classList.remove('flat-layout');
    
    card.style.left = dragStartX + 'px';
    card.style.top = dragStartY + 'px';

    currentDragWs.canvas.appendChild(edgeDockIndicator);

    currentDragWs.columns.forEach((col, colIdx) => {
      const idx = col.indexOf(card);
      if (idx !== -1) {
        placeholderCol = colIdx;
        placeholderRow = idx;
      }
    });

    placeholder = document.createElement('div');
    placeholder.className = 'card-placeholder';
    placeholder.style.left = card.style.left;
    placeholder.style.top = card.style.top;
    placeholder.style.width = card.style.width;
    placeholder.style.height = card.style.height;
    currentDragWs.canvas.appendChild(placeholder);

    currentDragWs.columns[placeholderCol][placeholderRow] = placeholder;

    layoutWorkspace(currentDragWs);
    e.preventDefault();
  });

  // Duplicate mouseup handler removed.


  function cleanupEmptyColumns(ws) {
    let cleanColumns = [];
    let cleanRatios = [];

    ws.columns.forEach((col, idx) => {
      const visibleCards = col.filter(c => c && c.style.display !== 'none');
      
      // Keep column if it is column 0 (Chat stays) or has active cards
      if (idx === 0 || visibleCards.length > 0) {
        cleanColumns.push(col);
        cleanRatios.push(ws.colWidthRatios[idx] || 0.3);
      }
    });

    ws.columns = cleanColumns;
    ws.colWidthRatios = cleanRatios;
  }


  // Sidebar Dialogues Drag and Drop Sorting & Pinning
  // --- SIDEBAR RESIZING & DYNAMIC POP-OUT ---
  const sidebar = document.getElementById('app-sidebar');
  const sidebarResizer = document.getElementById('sidebar-resizer');
  const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
  
  let isResizingSidebar = false;
  let sidebarStartX = 0;
  let sidebarStartWidth = 0;
  let sidebarExpandedWidth = 200;
  let sidebarIsCollapsed = false;

  let canvasStartWidth = 0;
  let canvasStartHeight = 0;

  let transitionTimeout = null;

  if (sidebarToggleBtn && sidebar) {
    sidebarToggleBtn.addEventListener('click', () => {
      // Clear any active hover timeouts
      if (hoverOpenTimeout) { clearTimeout(hoverOpenTimeout); hoverOpenTimeout = null; }
      if (hoverCloseTimeout) { clearTimeout(hoverCloseTimeout); hoverCloseTimeout = null; }
      if (transitionTimeout) { clearTimeout(transitionTimeout); transitionTimeout = null; }

      const willCollapse = !(sidebarIsCollapsed || sidebar.classList.contains('temporary-open'));
      userPanelStates.sidebarCollapsed = willCollapse;
      
      const currentWidth = sidebar.getBoundingClientRect().width;
      const targetW = willCollapse ? 0 : sidebarExpandedWidth;
      const dw = targetW - currentWidth;

      applyResponsiveLayout(false);

      // Sync card sizing immediately to the final target width to prevent blank space gaps
      workspaceData.forEach(ws => {
        const targetCanvasW = ws.canvas.clientWidth - dw;
        layoutWorkspace(ws, targetCanvasW);
      });
    });

    // Trigger layoutAll when the sidebar width transition ends to fix blank space gap
    sidebar.addEventListener('transitionend', (e) => {
      if (e.propertyName === 'width') {
        layoutAll();
      }
    });
  }

  if (sidebarResizer && sidebar) {
    sidebarResizer.addEventListener('mousedown', (e) => {
      isResizingSidebar = true;
      sidebarStartX = e.clientX;
      sidebarStartWidth = sidebar.getBoundingClientRect().width;
      
      document.body.classList.add('resizing-active');
      
      const ws = workspaceData[0];
      canvasStartWidth = ws.canvas.clientWidth;
      canvasStartHeight = ws.canvas.clientHeight;
      
      // Cache starting widths of active columns in workspaceData[0]
      const activeCols = ws.columns.map((col, idx) => ({
        index: idx,
        cards: col.filter(c => c && c.style.display !== 'none')
      })).filter(c => c.cards.length > 0);
      
      ws.sidebarResizeActiveCols = activeCols.map((colData) => {
        const firstCard = colData.cards[0];
        const currentWidth = firstCard ? parseFloat(firstCard.style.width) : 0;
        return {
          index: colData.index,
          cards: colData.cards,
          startWidth: currentWidth
        };
      });
      
      sidebarResizer.classList.add('active');
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });

    // rAF-throttled sidebar resize: read mouse position immediately, but batch DOM
    // writes into the next animation frame so browser can coalesce reflows.
    let _sidebarResizeRafId = null;
    document.addEventListener('mousemove', (e) => {
      if (!isResizingSidebar) return;
      const capturedX = e.clientX;
      if (_sidebarResizeRafId !== null) return; // already queued for this frame
      _sidebarResizeRafId = requestAnimationFrame(() => {
        _sidebarResizeRafId = null;
        if (!isResizingSidebar) return;
        const dx = capturedX - sidebarStartX;
        let newWidth = sidebarStartWidth + dx;

        if (newWidth < 100) {
          sidebar.style.width = '0px';
          sidebar.classList.add('collapsed');
          sidebarIsCollapsed = true;
          layoutWorkspaceSidebarResize(workspaceData[0], -sidebarStartWidth);
        } else {
          newWidth = Math.min(Math.max(newWidth, 100), 400);
          sidebar.style.width = newWidth + 'px';
          sidebar.classList.remove('collapsed');
          sidebarIsCollapsed = false;
          sidebarExpandedWidth = newWidth;
          layoutWorkspaceSidebarResize(workspaceData[0], newWidth - sidebarStartWidth);
        }
      });
    });

    document.addEventListener('mouseup', () => {
      if (isResizingSidebar) {
        isResizingSidebar = false;
        sidebarResizer.classList.remove('active');
        document.body.style.cursor = '';
        document.body.classList.remove('resizing-active');
        
        userPanelStates.sidebarCollapsed = sidebarIsCollapsed;
        
        const ws = workspaceData[0];
        const activeCols = ws.sidebarResizeActiveCols;
        if (activeCols && activeCols.length > 0) {
          const finalWidths = activeCols.map((colData) => {
            const firstCard = colData.cards[0];
            return firstCard ? (parseFloat(firstCard.style.width) || colData.startWidth) : colData.startWidth;
          });
          const totalWidth = finalWidths.reduce((a, b) => a + b, 0);
          
          if (totalWidth > 0) {
            activeCols.forEach((colData, idx) => {
              ws.colWidthRatios[colData.index] = finalWidths[idx] / totalWidth;
            });
          }
        }
        
        ws.sidebarResizeActiveCols = null;
        applyResponsiveLayout(false);
      }
    });
  }

  // Anti-accidental hover popup logic
  let hoverOpenTimeout = null;
  let hoverCloseTimeout = null;
  const TEMP_SIDEBAR_WIDTH = 200;

  // Sidebar hover logic is included in the unified mousemove handler below.

  // Collapsible section headers
  document.querySelectorAll('.collapsible-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.sort-btn-wrapper')) return;
      const targetId = header.getAttribute('data-target');
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        targetEl.classList.toggle('collapsed');
        header.classList.toggle('collapsed');
      }
    });
  });

  // Folder icon swap: purely CSS-driven via .collapsed class on the header.
  // Both folder-open and folder SVGs are pre-rendered in HTML; CSS shows/hides them.
  // This avoids the expensive lucide.createIcons() call on every collapse toggle.
  function updateFolderIcon(_header) {
    // No-op: CSS selector `.folder-header.collapsed .folder-icon-*` handles visibility.
  }

  // Cascading Sort Dropdown toggling
  const sortBtn = document.querySelector('.sort-btn');
  const sortDropdown = document.getElementById('sort-dropdown');
  if (sortBtn && sortDropdown) {
    sortBtn.addEventListener('click', (e) => {
      if (!sortDropdown.classList.contains('open')) {
        const rect = sortBtn.getBoundingClientRect();
        sortDropdown.style.left = (rect.left + rect.width - 140) + 'px';
        sortDropdown.style.top = (rect.top + rect.height + 4) + 'px';
      }
      sortDropdown.classList.toggle('open');
      e.stopPropagation();
    });
    document.addEventListener('click', (e) => {
      if (!sortDropdown.contains(e.target) && e.target !== sortBtn) {
        sortDropdown.classList.remove('open');
      }
    });
  }

  // --- FLIP LIST ANIMATION ENGINE ---
  function animateListLayout(action) {
    const listItems = Array.from(document.querySelectorAll('.session-item'));
    // Single getBoundingClientRect call per item (avoids forced double-read)
    const firstPositions = listItems.map(item => {
      const r = item.getBoundingClientRect();
      return { el: item, top: r.top, left: r.left };
    });

    action();

    requestAnimationFrame(() => {
      listItems.forEach((item, i) => {
        const first = firstPositions[i];
        if (!first) return;
        const lastRect = item.getBoundingClientRect();
        const dy = first.top - lastRect.top;
        const dx = first.left - lastRect.left;
        if (dy !== 0 || dx !== 0) {
          item.style.transition = 'none';
          item.style.transform = `translate(${dx}px, ${dy}px)`;
          item.offsetHeight; // force reflow to commit the 'none' transition
          item.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)';
          item.style.transform = '';
        }
      });
    });
  }

  // --- DIALOGUE DRAG AND DROP ENGINE ---
  let isDraggingSession = false;
  let draggedSession = null;
  let sessionGhost = null;
  let sessionGhostOffsetX = 0;
  let sessionGhostOffsetY = 0;

  let pendingSession = null;
  let sessionDragStartX = 0;
  let sessionDragStartY = 0;

  // --- FOLDER DRAG AND DROP ENGINE ---
  let isDraggingFolder = false;
  let draggedFolderGroup = null;
  let folderGhost = null;
  let folderGhostOffsetX = 0;
  let folderGhostOffsetY = 0;

  let pendingFolderGroup = null;
  let folderDragStartX = 0;
  let folderDragStartY = 0;

  document.addEventListener('mousedown', (e) => {
    // 1. Session item drag
    const item = e.target.closest('.draggable-session');
    if (item && !e.target.closest('.session-actions-btn') && e.button !== 2) {
      pendingSession = item;
      sessionDragStartX = e.clientX;
      sessionDragStartY = e.clientY;
      return;
    }

    // 2. Folder group drag
    const folderHeader = e.target.closest('.folder-header');
    if (folderHeader && e.button !== 2) {
      if (e.target.closest('.folder-collapse-btn')) {
        // Toggle collapse immediately and return
        const folderGroup = folderHeader.closest('.folder-group');
        const list = folderGroup.querySelector('.session-list');
        if (list) {
          list.classList.toggle('collapsed');
          folderHeader.classList.toggle('collapsed');
          updateFolderIcon(folderHeader);
        }
        return;
      }
      const folderGroup = folderHeader.closest('.folder-group');
      if (folderGroup) {
        pendingFolderGroup = folderGroup;
        folderDragStartX = e.clientX;
        folderDragStartY = e.clientY;
        e.preventDefault();
      }
    }
  });

  // ============================================================
  // UNIFIED MOUSEMOVE HANDLER
  // All drag/hover logic in one listener to avoid double-execution per frame.
  // Uses cachedWorkspaceCards / cachedTabBars / cachedTabRects to avoid
  // document.querySelectorAll() calls inside the hot path.
  // ============================================================
  document.addEventListener('mousemove', (e) => {

    // --- 1. Sidebar hotzone hover (lightweight: just reads mouseX + manages timers) ---
    if (!isResizingSidebar && sidebar) {
      const mouseX = e.clientX;
      const isInsideHeaderOrFooter = e.target.closest('.card-header') || e.target.closest('.chat-footer') || e.target.closest('.card-footer') || e.target.closest('.footer-actions');
      if (sidebarIsCollapsed && mouseX <= 15 && !isInsideHeaderOrFooter) {
        if (!hoverOpenTimeout) {
          hoverOpenTimeout = setTimeout(() => {
            if (transitionTimeout) { clearTimeout(transitionTimeout); transitionTimeout = null; }
            sidebar.classList.remove('collapsed');
            sidebar.classList.add('temporary-open');
            sidebar.style.width = TEMP_SIDEBAR_WIDTH + 'px';
          }, 200);
        }
      } else {
        if (hoverOpenTimeout) { clearTimeout(hoverOpenTimeout); hoverOpenTimeout = null; }
      }
      if (sidebar.classList.contains('temporary-open')) {
        if (mouseX > TEMP_SIDEBAR_WIDTH + 15) {
          if (!hoverCloseTimeout) {
            hoverCloseTimeout = setTimeout(() => {
              sidebar.style.width = '0px';
              if (transitionTimeout) clearTimeout(transitionTimeout);
              transitionTimeout = setTimeout(() => {
                sidebar.classList.remove('temporary-open');
                sidebar.classList.add('collapsed');
                transitionTimeout = null;
              }, 250);
              hoverCloseTimeout = null;
            }, 400);
          }
        } else {
          if (hoverCloseTimeout) { clearTimeout(hoverCloseTimeout); hoverCloseTimeout = null; }
          if (transitionTimeout) { clearTimeout(transitionTimeout); transitionTimeout = null; }
          sidebar.classList.remove('collapsed');
          sidebar.classList.add('temporary-open');
          sidebar.style.width = TEMP_SIDEBAR_WIDTH + 'px';
        }
      }
    }

    // --- 2. Session drag active: move ghost + reorder/pin ---
    if (isDraggingSession && sessionGhost && draggedSession) {
      sessionGhost.style.left = (e.clientX - sessionGhostOffsetX) + 'px';
      sessionGhost.style.top  = (e.clientY - sessionGhostOffsetY) + 'px';
      
      const isOverPinned = isOverElement(e, pinnedSessionList) || isOverElement(e, pinnedPlaceholder);
      if (isOverPinned) {
        pinnedPlaceholder.classList.remove('hidden');
        pinnedPlaceholder.classList.add('drag-over');
        if (draggedSession.parentNode !== pinnedSessionList) {
          pinnedSessionList.appendChild(draggedSession);
        }
        handleListReordering(e, pinnedSessionList, draggedSession);
      } else {
        pinnedPlaceholder.classList.remove('drag-over');
        if (pinnedSessionList.children.length > 0) {
          pinnedPlaceholder.classList.add('hidden');
        }
        
        if (draggedSession.parentNode === pinnedSessionList) {
          sessionOriginalParent.appendChild(draggedSession);
        }
        handleListReordering(e, draggedSession.parentNode, draggedSession);
      }
      return;
    }

    // --- 3. Folder drag: move ghost + reorder folders/pin ---
    if (isDraggingFolder && folderGhost && draggedFolderGroup) {
      folderGhost.style.left = (e.clientX - folderGhostOffsetX) + 'px';
      folderGhost.style.top  = (e.clientY - folderGhostOffsetY) + 'px';
      
      const isOverPinned = isOverElement(e, pinnedSessionList) || isOverElement(e, pinnedPlaceholder);
      if (isOverPinned) {
        pinnedPlaceholder.classList.remove('hidden');
        pinnedPlaceholder.classList.add('drag-over');
        if (draggedFolderGroup.parentNode !== pinnedSessionList) {
          pinnedSessionList.appendChild(draggedFolderGroup);
        }
        handleListReordering(e, pinnedSessionList, draggedFolderGroup);
      } else {
        pinnedPlaceholder.classList.remove('drag-over');
        if (pinnedSessionList.children.length > 0) {
          pinnedPlaceholder.classList.add('hidden');
        }
        
        if (draggedFolderGroup.parentNode === pinnedSessionList) {
          document.getElementById('dialogues-wrapper').appendChild(draggedFolderGroup);
        }
        
        const parent = document.getElementById('dialogues-wrapper');
        if (parent) {
          handleListReordering(e, parent, draggedFolderGroup);
        }
      }
      return;
    }

    // --- 4. Folder drag threshold + init (Deep Clone both Header and Sessions) ---
    if (pendingFolderGroup && !isDraggingFolder) {
      const dx = e.clientX - folderDragStartX, dy = e.clientY - folderDragStartY;
      if (Math.sqrt(dx * dx + dy * dy) > 8) {
        isDraggingFolder = true;
        draggedFolderGroup = pendingFolderGroup;
        pendingFolderGroup = null;
        const r = draggedFolderGroup.getBoundingClientRect();
        folderGhostOffsetX = folderDragStartX - r.left;
        folderGhostOffsetY = folderDragStartY - r.top;
        
        // Deep clone the entire folder group (header + session-list)
        folderGhost = draggedFolderGroup.cloneNode(true);
        folderGhost.classList.remove('ghost-dragging');
        folderGhost.classList.add('folder-ghost-floating');
        Object.assign(folderGhost.style, {
          position: 'fixed', width: r.width + 'px', left: r.left + 'px', top: r.top + 'px',
          pointerEvents: 'none', zIndex: '10000', opacity: '0.85',
          boxShadow: 'var(--shadow-md)', backgroundColor: '#ffffff',
          border: '1px solid var(--border-color)', borderRadius: '6px'
        });
        document.body.appendChild(folderGhost);
        draggedFolderGroup.classList.add('ghost-dragging');
      }
    }

    // --- 4b. Session drag threshold + init ---
    if (pendingSession && !isDraggingSession) {
      const dx = e.clientX - sessionDragStartX, dy = e.clientY - sessionDragStartY;
      if (Math.sqrt(dx * dx + dy * dy) > 8) {
        isDraggingSession = true;
        draggedSession = pendingSession;
        sessionOriginalParent = draggedSession.parentNode;
        pendingSession = null;
        const rect = draggedSession.getBoundingClientRect();
        sessionGhostOffsetX = sessionDragStartX - rect.left;
        sessionGhostOffsetY = sessionDragStartY - rect.top;
        
        sessionGhost = draggedSession.cloneNode(true);
        sessionGhost.classList.remove('ghost-dragging');
        sessionGhost.classList.add('session-ghost-floating');
        Object.assign(sessionGhost.style, {
          position: 'fixed', width: rect.width + 'px', left: rect.left + 'px', top: rect.top + 'px',
          pointerEvents: 'none', zIndex: '10000', opacity: '0.85',
          boxShadow: 'var(--shadow-md)', backgroundColor: '#ffffff',
          border: '1px solid var(--border-color)', borderRadius: '6px'
        });
        document.body.appendChild(sessionGhost);
        draggedSession.classList.add('ghost-dragging');
      }
    }

    // --- 5. Tab drag threshold + init (with cache initialisation) ---
    if (pendingTab && !isDraggingTab) {
      const dx = e.clientX - tabDragStartX, dy = e.clientY - tabDragStartY;
      if (Math.sqrt(dx * dx + dy * dy) > 8) {
        tabSourceCard    = pendingTab.closest('.workspace-card');
        tabSourceTabBar  = pendingTab.parentNode;
        tabOriginalParent = tabSourceTabBar;
        tabOriginalIndex  = Array.from(tabOriginalParent.children).indexOf(pendingTab);
        isDraggingTab = true;
        draggedTabEl  = pendingTab;
        const r = pendingTab.getBoundingClientRect();
        ghostStartX = tabDragStartX - r.left;
        ghostStartY = tabDragStartY - r.top;
        tabGhostEl = pendingTab.cloneNode(true);
        tabGhostEl.classList.add('tab-ghost-floating');
        Object.assign(tabGhostEl.style, {
          position: 'fixed', width: r.width + 'px', height: r.height + 'px',
          left: r.left + 'px', top: r.top + 'px',
          pointerEvents: 'none', zIndex: '10000', opacity: '0.85'
        });
        document.body.appendChild(tabGhostEl);
        pendingTab.classList.add('tab-drag-placeholder');
        pendingTab = null;
        lastHoveredTabBar = tabSourceTabBar;

        // Cache card rects to prevent read-write layout thrashing in mousemove loop
        cachedCardRects = cachedWorkspaceCards.map(card => ({
          el: card,
          rect: card.getBoundingClientRect(),
          tabBar: card.querySelector('.tabs-bar')
        }));

        updateTabRectsCache(tabSourceTabBar);
      }
    }

    // --- 6. Tab drag active: ghost follows cursor; hit-test via cached card array ---
    if (isDraggingTab && tabGhostEl && draggedTabEl) {
      tabGhostEl.style.left = (e.clientX - ghostStartX) + 'px';
      tabGhostEl.style.top  = (e.clientY - ghostStartY) + 'px';

      // Find hovered card+tabBar using cached array — zero getBoundingClientRect calls!
      let hoveredTabBar = null;
      let hoveredCard   = null;
      for (const entry of cachedCardRects) {
        if (entry.el.style.display === 'none') continue;
        const r = entry.rect;
        if (e.clientX >= r.left && e.clientX <= r.right &&
            e.clientY >= r.top  && e.clientY <= r.bottom) {
          hoveredCard = entry.el;
          if (e.clientY <= r.top + 45) {
            hoveredTabBar = entry.tabBar;
          }
          break;
        }
      }

      tabHoveredTabBar = hoveredTabBar;
      tabHoveredCard   = hoveredCard;

      if (hoveredTabBar) {
        if (hoveredTabBar !== lastHoveredTabBar) {
          lastHoveredTabBar = hoveredTabBar;
          updateTabRectsCache(hoveredTabBar);
        }
        
        // Find insertBeforeEl and position drop indicator
        let insertBeforeEl = null;
        let dropIndicatorLeft = 0;
        
        for (const entry of cachedTabRects) {
          if (entry.el === draggedTabEl) continue;
          if (e.clientX < entry.midX) {
            insertBeforeEl = entry.el;
            dropIndicatorLeft = entry.relLeft - 1;
            break;
          }
        }
        
        if (!insertBeforeEl) {
          if (cachedTabRects.length > 0) {
            const lastEntry = cachedTabRects[cachedTabRects.length - 1];
            if (lastEntry.el === draggedTabEl && cachedTabRects.length > 1) {
              const prevEntry = cachedTabRects[cachedTabRects.length - 2];
              dropIndicatorLeft = prevEntry.relLeft + prevEntry.width + 1;
            } else {
              dropIndicatorLeft = lastEntry.relLeft + lastEntry.width + 1;
            }
          } else {
            dropIndicatorLeft = 4;
          }
        }
        
        tabInsertBeforeEl = insertBeforeEl;
        
        // Show/move drop indicator line absolutely in target tabs bar
        if (!tabDropIndicator.parentNode || tabDropIndicator.parentNode !== hoveredTabBar) {
          hoveredTabBar.appendChild(tabDropIndicator);
        }
        tabDropIndicator.style.left = dropIndicatorLeft + 'px';
        tabDropIndicator.style.display = 'block';
      } else {
        lastHoveredTabBar = null;
        cachedTabRects = [];
        tabInsertBeforeEl = null;
        if (tabDropIndicator.parentNode) {
          tabDropIndicator.style.display = 'none';
        }
      }
      return;
    }

    // --- 7. Card drag active: move + detect merge target (self excluded to fix disappear bug) ---
    if (isDragging && draggedCard && currentDragWs) {
      const canvasRect = currentDragWs.canvas.getBoundingClientRect();
      draggedCard.style.left = (e.clientX - canvasRect.left - dragOffsetX) + 'px';
      draggedCard.style.top  = (e.clientY - canvasRect.top  - dragOffsetY) + 'px';
      if (placeholder) {
        draggedCard.style.width  = placeholder.style.width;
        draggedCard.style.height = placeholder.style.height;
      }

      // Detect tab bar on another card — explicitly skip draggedCard to prevent self-merge bug
      // (bug: when cursor was over dragged card's own tab bar, tabHoveredCard===draggedCard
      //  which caused mouseup to merge card with itself and set display:none)
      let hoveredTabBar = null;
      let hoveredCard   = null;
      for (const card of cachedWorkspaceCards) {
        if (card === draggedCard || card.style.display === 'none') continue;
        const r = card.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right &&
            e.clientY >= r.top  && e.clientY <= r.bottom) {
          // Only merge if we are specifically hovering over the tabs bar (top 45px) of the target card
          if (e.clientY <= r.top + 45) {
            hoveredCard = card;
            hoveredTabBar = card.querySelector('.tabs-bar');
          }
          break;
        }
      }
      tabHoveredTabBar = hoveredTabBar;
      tabHoveredCard   = hoveredCard;

      for (const tb of cachedTabBars) tb.classList.remove('tab-drag-hover');

      if (hoveredCard && hoveredTabBar) {
        // hoveredCard !== draggedCard is guaranteed by the skip above
        hoveredTabBar.classList.add('tab-drag-hover');
        edgeDockIndicator.style.display = 'none';
        if (placeholder) placeholder.style.display = 'none';
      } else {
        if (placeholder) placeholder.style.display = 'block';
        updateCardDragPlaceholder(e);
      }
    }
  });


  document.addEventListener('mouseup', (e) => {
    // 1. Click on folder group header
    if (pendingFolderGroup) {
      const folderGroup = pendingFolderGroup;
      pendingFolderGroup = null;
      
      const list = folderGroup.querySelector('.session-list');
      const header = folderGroup.querySelector('.folder-header');
      if (list && header) {
        list.classList.toggle('collapsed');
        header.classList.toggle('collapsed');
        updateFolderIcon(header);
      }
      return;
    }

    // 2. Dragging folder group complete
    if (isDraggingFolder && draggedFolderGroup) {
      isDraggingFolder = false;
      draggedFolderGroup.classList.remove('ghost-dragging');
      
      if (folderGhost) {
        folderGhost.remove();
        folderGhost = null;
      }
      
      // Update pinned placeholder visibility
      if (pinnedSessionList.children.length > 0) {
        pinnedPlaceholder.classList.add('hidden');
      } else {
        pinnedPlaceholder.classList.remove('hidden');
      }
      pinnedPlaceholder.classList.remove('drag-over');
      
      draggedFolderGroup = null;
      return;
    }

    // 3. Dialogue session mouseup logic...
    if (pendingSession) {
      const item = pendingSession;
      pendingSession = null;

      // Click action - select active session
      document.querySelectorAll('.draggable-session').forEach(el => el.classList.remove('active'));
      item.classList.add('active');

      const titleText = item.querySelector('.session-text').innerText;
      const mainTitle = document.getElementById('card-chat').querySelector('.card-title');
      if (mainTitle) {
        mainTitle.innerText = `navigation-site / ${titleText}`;
      }
      return;
    }

    if (isDraggingSession && draggedSession) {
      isDraggingSession = false;
      draggedSession.classList.remove('ghost-dragging');

      if (sessionGhost) {
        sessionGhost.remove();
        sessionGhost = null;
      }
      
      // Update pinned placeholder visibility
      if (pinnedSessionList.children.length > 0) {
        pinnedPlaceholder.classList.add('hidden');
      } else {
        pinnedPlaceholder.classList.remove('hidden');
      }
      pinnedPlaceholder.classList.remove('drag-over');
      
      draggedSession = null;
      return;
    }

    if (pendingTab) {
      const tab = pendingTab;
      pendingTab = null;
      const card = tab.closest('.workspace-card');
      const isTabClose = e.target.closest('.tab-close-btn') || pendingTabClose;
      if (card && !isTabClose) {
        const cardId = tab.getAttribute('data-card-id');
        switchActiveTab(card, cardId);
      }
      return;
    }

    if (isDraggingTab && draggedTabEl) {
      isDraggingTab = false;
      draggedTabEl.classList.remove('tab-drag-placeholder');
      
      // Hide and remove drop indicator
      tabDropIndicator.style.display = 'none';
      if (tabDropIndicator.parentNode) {
        tabDropIndicator.parentNode.removeChild(tabDropIndicator);
      }
      
      if (tabHoveredCard) {
        const targetTabBar = tabHoveredCard.querySelector('.tabs-bar');
        const cardId = draggedTabEl.getAttribute('data-card-id');
        
        if (tabHoveredCard !== tabSourceCard && targetTabBar) {
          // Drop on another card - merge tab, body, and subheader!
          let key = cardId.replace('card-', '');
          if (key.indexOf('-') !== -1) {
            key = key.split('-')[0];
          }
          
          let bodies = document.querySelectorAll(`.${key}-body, .${key}-subheader`);
          bodies.forEach(body => {
            tabHoveredCard.appendChild(body);
          });
          
          if (tabInsertBeforeEl && tabHoveredTabBar === targetTabBar) {
            targetTabBar.insertBefore(draggedTabEl, tabInsertBeforeEl);
          } else {
            targetTabBar.appendChild(draggedTabEl);
          }
          
          tabHoveredCard.querySelectorAll('.card-tab').forEach(t => t.classList.remove('active'));
          draggedTabEl.classList.add('active');
          switchActiveTab(tabHoveredCard, cardId);
          
          const remainingTabs = tabSourceCard.querySelectorAll('.card-tab');
          if (remainingTabs.length > 0) {
            switchActiveTab(tabSourceCard, remainingTabs[0].getAttribute('data-card-id'));
          } else {
            tabSourceCard.style.display = 'none';
            const wsSection = tabSourceCard.closest('.workspace-section');
            const wsIndex = parseInt(wsSection.id.split('-').pop()) || 0;
            const ws = workspaceData[wsIndex];
            ws.columns = ws.columns.map(col => col.filter(item => item !== tabSourceCard));
            layoutWorkspace(ws);
          }
        } 
        else if (tabHoveredCard === tabSourceCard && targetTabBar) {
          // Reorder in same card
          if (tabInsertBeforeEl) {
            targetTabBar.insertBefore(draggedTabEl, tabInsertBeforeEl);
          } else {
            targetTabBar.appendChild(draggedTabEl);
          }
          switchActiveTab(tabSourceCard, cardId);
        }
      }
      
      if (tabGhostEl) {
        tabGhostEl.remove();
        tabGhostEl = null;
      }
      
      tabSourceCard = null;
      tabSourceTabBar = null;
      tabOriginalParent = null;
      tabHoveredTabBar = null;
      tabHoveredCard = null;
      tabInsertBeforeEl = null;
      lastHoveredTabBar = null;
      cachedTabRects = [];
      return;
    }

    if (isDragging && draggedCard && currentDragWs) {
      isDragging = false;
      edgeDockIndicator.style.display = 'none';

      document.querySelectorAll('.tabs-bar').forEach(tb => tb.classList.remove('tab-drag-hover'));

      if (tabHoveredCard) {
        // Merge all tabs of draggedCard into tabHoveredCard
        const tabsToMerge = Array.from(draggedCard.querySelectorAll('.card-tab'));
        tabsToMerge.forEach(t => {
          const cardId = t.getAttribute('data-card-id');
          mergeTabIntoCard(draggedCard, tabHoveredCard, cardId);
        });

        draggedCard.style.display = 'none';
        currentDragWs.columns = currentDragWs.columns.map(col => col.filter(item => item !== draggedCard && item !== placeholder));
        
        if (placeholder && placeholder.parentNode) {
          placeholder.parentNode.removeChild(placeholder);
        }
        placeholder = null;
        
        draggedCard.classList.remove('dragging');
        cleanupEmptyColumns(currentDragWs);
        layoutWorkspace(currentDragWs);

        draggedCard = null;
        currentDragWs = null;
        tabHoveredCard = null;
        dragCanvasRect = null;
      } else {
        const canvasRect = currentDragWs.canvas.getBoundingClientRect();
        const mouseX = e.clientX - canvasRect.left;
        const W = currentDragWs.canvas.clientWidth;

        let targetCol = placeholderCol;
        let targetRow = placeholderRow;

        if (mouseX >= W - EDGE_ZONE_WIDTH) {
          currentDragWs.columns[placeholderCol] = currentDragWs.columns[placeholderCol].filter(item => item !== placeholder);
          currentDragWs.columns.push([draggedCard]);
          currentDragWs.colWidthRatios.push(0.25);
          targetCol = currentDragWs.columns.length - 1;
          targetRow = 0;
        } 
        else if (mouseX <= EDGE_ZONE_WIDTH) {
          currentDragWs.columns[placeholderCol] = currentDragWs.columns[placeholderCol].filter(item => item !== placeholder);
          currentDragWs.columns.splice(0, 0, [draggedCard]);
          currentDragWs.colWidthRatios.splice(0, 0, 0.25);
          targetCol = 0;
          targetRow = 0;
        } else {
          currentDragWs.columns[placeholderCol][placeholderRow] = draggedCard;
        }

        if (placeholder && placeholder.parentNode) {
          placeholder.parentNode.removeChild(placeholder);
        }
        placeholder = null;

        draggedCard.classList.remove('dragging');
        cleanupEmptyColumns(currentDragWs);
        layoutWorkspace(currentDragWs);

        draggedCard = null;
        currentDragWs = null;
        dragCanvasRect = null;
      }
    }
  });


  // Right-Click Context Menu Actions on Sidebar Session items
  let rightClickedSessionId = null;
  let rightClickedSessionElement = null;

  document.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.draggable-session');
    if (!item) {
      sessionContextMenu.classList.remove('open');
      return;
    }

    e.preventDefault();
    rightClickedSessionElement = item;
    rightClickedSessionId = item.getAttribute('data-session-id');

    sessionContextMenu.style.left = e.clientX + 'px';
    sessionContextMenu.style.top = e.clientY + 'px';
    sessionContextMenu.classList.add('open');
  });

  document.addEventListener('click', (e) => {
    if (!sessionContextMenu.contains(e.target)) {
      sessionContextMenu.classList.remove('open');
    }
  });

  sessionContextMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('.context-menu-item');
    if (!btn) return;

    const action = btn.getAttribute('data-action');
    const title = rightClickedSessionElement.querySelector('.session-text').innerText;

    if (action === 'open-current') {
      // Just select and highlight
      document.querySelectorAll('.draggable-session').forEach(el => el.classList.remove('active'));
      rightClickedSessionElement.classList.add('active');
      
      // Update primary chat card title
      const mainTitle = document.getElementById('card-chat').querySelector('.card-title');
      mainTitle.innerText = `navigation-site / ${title}`;
    } 
    else if (action === 'open-new-vertical') {
      // Spawn new side-by-side workspace section
      spawnWorkspace(rightClickedSessionId, title);
    } 
    else if (action === 'pin-session') {
      pinnedSessionList.appendChild(rightClickedSessionElement);
      pinnedPlaceholder.classList.add('hidden');
    } 
    else if (action === 'delete-session') {
      rightClickedSessionElement.remove();
      if (pinnedSessionList.children.length === 0) {
        pinnedPlaceholder.classList.remove('hidden');
      }
    }

    sessionContextMenu.classList.remove('open');
  });

  // Dynamic Workspace spawner (Dual View)
  function spawnWorkspace(sessionId, title) {
    const newIdx = workspaceData.length;

    // Create workspace section DOM container
    const newSection = document.createElement('div');
    newSection.className = 'workspace-section';
    newSection.id = `workspace-section-${newIdx}`;

    // Add workspace resizer splitter between sections
    const splitter = document.createElement('div');
    splitter.className = 'workspace-splitter';
    splitter.id = `workspace-splitter-${newIdx}`;
    splitter.setAttribute('data-ws', newIdx);
    workspaceContainer.appendChild(splitter);
    setupWorkspaceSplitterEvent(splitter);

    const newCanvas = document.createElement('div');
    newCanvas.className = 'workspace-canvas';
    newCanvas.id = `workspace-canvas-${newIdx}`;
    newSection.appendChild(newCanvas);
    workspaceContainer.appendChild(newSection);

    // Clone Chat card template
    const chatTemplate = document.getElementById('card-chat');
    const newChatCard = chatTemplate.cloneNode(true);
    newChatCard.id = `card-chat-${newIdx}`;
    newChatCard.classList.remove('flat-layout'); // Make it full card by default in side-by-side!
    
    const mainTitle = newChatCard.querySelector('.card-title');
    if (mainTitle) {
      mainTitle.innerText = `navigation-site / ${title}`;
    }

    newCanvas.appendChild(newChatCard);

    // Add Workspace Data Context
    workspaceData.push({
      index: newIdx,
      dom: newSection,
      canvas: newCanvas,
      columns: [
        [newChatCard]
      ],
      colWidthRatios: [1.0],
      cardWeights: {
        [`card-chat-${newIdx}`]: 1.5
      }
    });

    // Re-initialize Lucide icons on cloned card
    lucide.createIcons({
      attrs: { 'stroke-width': 2 },
      nameAttr: 'data-lucide',
      node: newChatCard
    });

    // Set up cloned card event handlers
    setupClonedCardEvents(newChatCard, newIdx);

    // Adjust flex weights equally
    workspaceData.forEach(ws => {
      ws.dom.style.flex = '1';
    });

    layoutAll();
    invalidateDOMCache(); // new workspace spawned
  }

  // Initial layout on load (apply responsive layout engine)
  applyResponsiveLayout(false);

  // Focus click listener for workspaces and cards
  document.addEventListener('click', (e) => {
    // 1. Workspace index switching
    const wsSection = e.target.closest('.workspace-section');
    if (wsSection) {
      const idx = parseInt(wsSection.id.split('-').pop()) || 0;
      if (idx !== activeWorkspaceIndex) {
        activeWorkspaceIndex = idx;
        applyResponsiveLayout(false);
      }
    }

    // 2. Card switching focus in Column 0
    const card = e.target.closest('.workspace-card');
    if (card) {
      let cardId = card.id;
      if (cardId.indexOf('-') !== -1 && cardId.indexOf('card-') === 0) {
        const parts = cardId.split('-');
        if (parts.length > 2) {
          cardId = parts.slice(0, 2).join('-');
        }
      }
      if (cardId !== activeCardIdInWorkspace) {
        activeCardIdInWorkspace = cardId;
        applyResponsiveLayout(false);
      }
    }
  });

  // Throttled & Debounced resize listener
  let resizeThrottleTimeout = null;
  let resizeCommitTimeout = null;

  function handleWindowResize() {
    if (resizeCommitTimeout) {
      clearTimeout(resizeCommitTimeout);
    }

    if (!resizeThrottleTimeout) {
      resizeThrottleTimeout = setTimeout(() => {
        applyResponsiveLayout(true);
        resizeThrottleTimeout = null;
      }, 80);
    }

    // Commit layout states 400ms after user stops resizing (松手)
    resizeCommitTimeout = setTimeout(() => {
      commitResizeStates();
      applyResponsiveLayout(false);
    }, 400);
  }

  window.addEventListener('resize', handleWindowResize);

  function applyResponsiveLayout(isResizing = false) {
    const w = window.innerWidth;
    const h = window.innerHeight;

    const forceSidebarCollapse = isResizing && (w < 1000);
    const forceCol2Hide = isResizing && (w < 800);
    const forceCol1Hide = isResizing && (w < 650);
    const forcePlanHide = isResizing && (w < 650 && h < 550);
    const forceSingleCardMode = w < 650;

    // 1. Sidebar responsiveness
    const effSidebarCollapse = forceSidebarCollapse || userPanelStates.sidebarCollapsed;
    if (effSidebarCollapse) {
      if (!sidebar.classList.contains('temporary-open')) {
        sidebar.style.width = '0px';
        sidebar.classList.add('collapsed');
      }
      sidebarIsCollapsed = true;
    } else {
      sidebar.style.width = sidebarExpandedWidth + 'px';
      sidebar.classList.remove('collapsed');
      sidebar.classList.remove('temporary-open');
      sidebarIsCollapsed = false;
    }

    // 2. Workspace Column split responsiveness (80/20 active workspace split)
    if (w < 800 && workspaceData.length > 1) {
      workspaceData.forEach((ws, idx) => {
        ws.dom.style.flex = (idx === activeWorkspaceIndex) ? '8' : '2';
      });
    } else {
      workspaceData.forEach(ws => {
        if (!ws.dom.style.flex || ws.dom.style.flex.indexOf('8') !== -1 || ws.dom.style.flex.indexOf('2') !== -1) {
          ws.dom.style.flex = '1';
        }
      });
    }

    // 3. Card responsiveness
    workspaceData.forEach(ws => {
      if (forceSingleCardMode) {
        // Enforce single-card mode: merge everything into card-chat
        restoreAllTabsFromChat(ws);
        mergeAllTabsIntoChat(ws);
      } else {
        // Restore all tabs back to their original cards
        restoreAllTabsFromChat(ws);

        // Apply normal responsive column visibilities
        const keys = ['preview', 'diff', 'terminal', 'tasks', 'plan'];
        keys.forEach(key => {
          let isVisible = userPanelStates[key];
          if (key === 'tasks' || key === 'terminal') {
            if (forceCol2Hide) isVisible = false;
          } else if (key === 'preview' || key === 'diff') {
            if (forceCol1Hide) isVisible = false;
          } else if (key === 'plan') {
            if (forcePlanHide) isVisible = false;
          }

          let card = ws.canvas.querySelector(`[id^="card-${key}"]`);
          if (!card && isVisible) {
            toggleCardInWorkspace(ws, key, true);
            card = ws.canvas.querySelector(`[id^="card-${key}"]`);
          }

          if (card) {
            if (isVisible) {
              card.style.display = 'flex';
              
              let defaultCol = 1;
              if (key === 'plan') defaultCol = 0;
              if (key === 'tasks' || key === 'terminal') defaultCol = 2;

              while (ws.columns.length <= defaultCol) {
                ws.columns.push([]);
                ws.colWidthRatios.push(0.3);
              }

              let exists = false;
              ws.columns.forEach(col => {
                if (col.includes(card)) exists = true;
              });

              if (!exists) {
                ws.columns[defaultCol].push(card);
                ws.cardWeights[card.id] = 1.0;
              }
            } else {
              card.style.display = 'none';
              ws.columns = ws.columns.map(col => col.filter(item => item !== card));
            }
          }
        });
      }

      cleanupEmptyColumns(ws);
      layoutWorkspace(ws);
    });

    invalidateDOMCache();
    
    // Sync checkboxes to userPanelStates
    Object.keys(panelToggles).forEach(key => {
      panelToggles[key].checked = userPanelStates[key];
    });
  }

  function commitResizeStates() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    const forceSidebarCollapse = w < 1000;
    const forceCol2Hide = w < 800;
    const forceCol1Hide = w < 650;
    const forcePlanHide = w < 650 && h < 550;
    const forceSingleCardMode = w < 650;

    if (forceSidebarCollapse) {
      userPanelStates.sidebarCollapsed = true;
    }

    if (forceSingleCardMode) {
      userPanelStates.preview = false;
      userPanelStates.diff = false;
      userPanelStates.terminal = false;
      userPanelStates.tasks = false;
      userPanelStates.plan = false;
    } else {
      if (forceCol2Hide) {
        userPanelStates.terminal = false;
        userPanelStates.tasks = false;
      }
      if (forceCol1Hide) {
        userPanelStates.preview = false;
        userPanelStates.diff = false;
      }
      if (forcePlanHide) {
        userPanelStates.plan = false;
      }
    }
  }

  // Scroll Chat body to bottom on load
  const chatBody = document.querySelector('.chat-body');
  if (chatBody) {
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  // Horizontal scroll for tabs bar using mouse wheel
  document.addEventListener('wheel', (e) => {
    const tabsBar = e.target.closest('.tabs-bar');
    if (tabsBar) {
      if (e.deltaY !== 0) {
        tabsBar.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }
  }, { passive: false });
});
