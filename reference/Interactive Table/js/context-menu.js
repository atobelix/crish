/**
 * context-menu.js - 高级 Notion 展开操作面板
 * 包含搜索过滤、标题列/行 Switch 开关、文本/背景颜色级联菜单与快捷操作
 */

window.InteractiveTable = window.InteractiveTable || {};

window.InteractiveTable.ContextMenuManager = class ContextMenuManager {
  constructor(state) {
    this.state = state;
    this.activeMenu = null;
    this.activeSubmenu = null;
    this.anchorElement = null;

    this.handleDocumentClick = this.handleDocumentClick.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    document.addEventListener('pointerdown', this.handleDocumentClick);
    document.addEventListener('mousedown', this.handleDocumentClick);
    document.addEventListener('keydown', this.handleKeyDown);
  }

  handleDocumentClick(e) {
    if (this.activeMenu && !this.activeMenu.contains(e.target)) {
      this.close();
    }
  }

  handleKeyDown(e) {
    if (e.key === 'Escape') {
      this.close();
    }
  }

  close() {
    if (this.activeSubmenu) {
      this.activeSubmenu.remove();
      this.activeSubmenu = null;
    }
    if (this.activeMenu) {
      this.activeMenu.remove();
      this.activeMenu = null;
    }
    if (this.anchorElement) {
      this.anchorElement.classList.remove('active');
      this.anchorElement = null;
    }
  }

  /**
   * 打开列操作菜单 (点击顶部 - 列柄触发)
   */
  openColumnMenu(anchorEl, colIndex) {
    this.close();
    this.anchorElement = anchorEl;
    anchorEl.classList.add('active');

    const menu = document.createElement('div');
    menu.className = 'notion-popover';

    const hasHeaderCol = this.state.get().hasHeaderColumn;

    const Icons = window.InteractiveTable.Icons;

    menu.innerHTML = `
      <div class="menu-search-wrapper">
        <span class="menu-search-icon">${Icons ? Icons.get('Search01Icon', 14) : ''}</span>
        <input type="text" class="menu-search-input" placeholder="搜索操作..." spellcheck="false" autocomplete="off">
      </div>
      <div class="menu-items-container">
        <div class="menu-item" data-action="toggle-header-col">
          <span class="menu-item-icon">${Icons ? Icons.get('Table01Icon', 16) : ''}</span>
          <span class="menu-item-text">标题列</span>
          <div class="switch-toggle ${hasHeaderCol ? 'active' : ''}">
            <div class="switch-thumb"></div>
          </div>
        </div>
        <div class="menu-item has-submenu" data-action="color">
          <span class="menu-item-icon">${Icons ? Icons.get('PaintBoardIcon', 16) : ''}</span>
          <span class="menu-item-text">颜色</span>
          <span class="menu-item-arrow">${Icons ? Icons.get('ArrowRight01Icon', 12) : '›'}</span>
        </div>
        <div class="menu-item" data-action="insert-left">
          <span class="menu-item-icon">${Icons ? Icons.get('ArrowLeft02Icon', 16) : '←'}</span>
          <span class="menu-item-text">在左侧插入</span>
        </div>
        <div class="menu-item" data-action="insert-right">
          <span class="menu-item-icon">${Icons ? Icons.get('ArrowRight02Icon', 16) : '→'}</span>
          <span class="menu-item-text">在右侧插入</span>
        </div>
        <div class="menu-item" data-action="duplicate">
          <span class="menu-item-icon">${Icons ? Icons.get('Copy01Icon', 16) : ''}</span>
          <span class="menu-item-text">创建副本</span>
          <span class="menu-item-shortcut">Ctrl+D</span>
        </div>
        <div class="menu-item" data-action="clear">
          <span class="menu-item-icon">${Icons ? Icons.get('Eraser01Icon', 16) : ''}</span>
          <span class="menu-item-text">清除内容</span>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-item danger" data-action="delete">
          <span class="menu-item-icon danger-icon">${Icons ? Icons.get('Delete02Icon', 16) : ''}</span>
          <span class="menu-item-text">删除</span>
        </div>
      </div>
    `;

    document.body.appendChild(menu);
    this.positionMenu(menu, anchorEl, 'column');
    this.activeMenu = menu;

    this.bindMenuInteractions(menu, 'column', colIndex);
  }

  /**
   * 打开行操作菜单 (点击左侧 | 行柄触发)
   */
  openRowMenu(anchorEl, rowIndex, isHeader = false) {
    this.close();
    this.anchorElement = anchorEl;
    anchorEl.classList.add('active');

    const menu = document.createElement('div');
    menu.className = 'notion-popover';

    const hasHeaderRow = this.state.get().hasHeaderRow;
    const Icons = window.InteractiveTable.Icons;

    menu.innerHTML = `
      <div class="menu-search-wrapper">
        <span class="menu-search-icon">${Icons ? Icons.get('Search01Icon', 14) : ''}</span>
        <input type="text" class="menu-search-input" placeholder="搜索操作..." spellcheck="false" autocomplete="off">
      </div>
      <div class="menu-items-container">
        ${isHeader ? `
          <div class="menu-item" data-action="toggle-header-row">
            <span class="menu-item-icon">${Icons ? Icons.get('Table01Icon', 16) : ''}</span>
            <span class="menu-item-text">标题行</span>
            <div class="switch-toggle ${hasHeaderRow ? 'active' : ''}">
              <div class="switch-thumb"></div>
            </div>
          </div>
          <div class="menu-item" data-action="insert-below">
            <span class="menu-item-icon">${Icons ? Icons.get('ArrowDown02Icon', 16) : '↓'}</span>
            <span class="menu-item-text">在下方插入</span>
          </div>
          <div class="menu-item" data-action="clear-header">
            <span class="menu-item-icon">${Icons ? Icons.get('Eraser01Icon', 16) : ''}</span>
            <span class="menu-item-text">清除内容</span>
          </div>
        ` : `
          <div class="menu-item has-submenu" data-action="color">
            <span class="menu-item-icon">${Icons ? Icons.get('PaintBoardIcon', 16) : ''}</span>
            <span class="menu-item-text">颜色</span>
            <span class="menu-item-arrow">${Icons ? Icons.get('ArrowRight01Icon', 12) : '›'}</span>
          </div>
          <div class="menu-item" data-action="insert-above">
            <span class="menu-item-icon">${Icons ? Icons.get('ArrowUp02Icon', 16) : '↑'}</span>
            <span class="menu-item-text">在上方插入</span>
          </div>
          <div class="menu-item" data-action="insert-below">
            <span class="menu-item-icon">${Icons ? Icons.get('ArrowDown02Icon', 16) : '↓'}</span>
            <span class="menu-item-text">在下方插入</span>
          </div>
          <div class="menu-item" data-action="duplicate">
            <span class="menu-item-icon">${Icons ? Icons.get('Copy01Icon', 16) : ''}</span>
            <span class="menu-item-text">创建副本</span>
            <span class="menu-item-shortcut">Ctrl+D</span>
          </div>
          <div class="menu-item" data-action="clear">
            <span class="menu-item-icon">${Icons ? Icons.get('Eraser01Icon', 16) : ''}</span>
            <span class="menu-item-text">清除内容</span>
          </div>
          <div class="menu-divider"></div>
          <div class="menu-item danger" data-action="delete">
            <span class="menu-item-icon danger-icon">${Icons ? Icons.get('Delete02Icon', 16) : ''}</span>
            <span class="menu-item-text">删除</span>
          </div>
        `}
      </div>
    `;

    document.body.appendChild(menu);
    this.positionMenu(menu, anchorEl, 'row');
    this.activeMenu = menu;

    this.bindMenuInteractions(menu, 'row', rowIndex, isHeader);
  }

  bindMenuInteractions(menu, type, targetIndex, isHeader = false) {
    // 搜索输入过滤
    const searchInput = menu.querySelector('.menu-search-input');
    searchInput?.focus();
    searchInput?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const items = menu.querySelectorAll('.menu-item');
      items.forEach(item => {
        const text = item.querySelector('.menu-item-text')?.innerText.toLowerCase() || '';
        item.style.display = text.includes(q) ? 'flex' : 'none';
      });
    });

    // 颜色二级菜单悬停展示
    const colorMenuItem = menu.querySelector('[data-action="color"]');
    if (colorMenuItem) {
      colorMenuItem.addEventListener('mouseenter', () => {
        this.openColorSubmenu(colorMenuItem, type, targetIndex);
      });
    }

    // 各按钮事件处理
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item) return;

      const action = item.dataset.action;
      if (action === 'color') {
        this.openColorSubmenu(item, type, targetIndex);
        return;
      }

      e.stopPropagation();
      this.close();

      if (type === 'column') {
        switch (action) {
          case 'toggle-header-col':
            this.state.toggleHeaderColumn();
            break;
          case 'insert-left':
            this.state.insertColumn(targetIndex);
            break;
          case 'insert-right':
            this.state.insertColumn(targetIndex + 1);
            break;
          case 'duplicate':
            this.state.duplicateColumn(targetIndex);
            break;
          case 'clear':
            this.state.clearColumn(targetIndex);
            break;
          case 'delete':
            this.state.deleteColumn(targetIndex);
            break;
        }
      } else {
        switch (action) {
          case 'toggle-header-row':
            this.state.toggleHeaderRow();
            break;
          case 'insert-above':
            this.state.insertRow(targetIndex);
            break;
          case 'insert-below':
            this.state.insertRow(isHeader ? 0 : targetIndex + 1);
            break;
          case 'duplicate':
            this.state.duplicateRow(targetIndex);
            break;
          case 'clear-header':
            for (let c = 0; c < this.state.get().columns.length; c++) {
              this.state.updateCell(-1, c, '', true);
            }
            break;
          case 'clear':
            this.state.clearRow(targetIndex);
            break;
          case 'delete':
            this.state.deleteRow(targetIndex);
            break;
        }
      }
    });
  }

  /**
   * 打开二级颜色选择菜单 (文本颜色与背景颜色)
   */
  openColorSubmenu(anchorEl, type, targetIndex) {
    if (this.activeSubmenu) {
      this.activeSubmenu.remove();
      this.activeSubmenu = null;
    }

    const submenu = document.createElement('div');
    submenu.className = 'color-submenu';
    submenu.style.display = 'block';

    const textColors = [
      { name: '默认文本', color: '#37352f' },
      { name: '灰色文本', color: '#787774' },
      { name: '棕色文本', color: '#9f6b53' },
      { name: '橙色文本', color: '#d9730d' },
      { name: '黄色文本', color: '#cb912f' },
      { name: '绿色文本', color: '#448361' },
      { name: '蓝色文本', color: '#2383e2' },
      { name: '紫色文本', color: '#9065b0' },
      { name: '粉色文本', color: '#c14c8a' },
      { name: '红色文本', color: '#d44c47' }
    ];

    const bgColors = [
      { name: '默认背景', bg: '#ffffff' },
      { name: '灰色背景', bg: '#f1f1ef' },
      { name: '棕色背景', bg: '#f4eeee' },
      { name: '橙色背景', bg: '#faece3' },
      { name: '黄色背景', bg: '#fbf3db' },
      { name: '绿色背景', bg: '#edf3ec' },
      { name: '蓝色背景', bg: '#e7f3f8' },
      { name: '紫色背景', bg: '#f4f0f7' },
      { name: '粉色背景', bg: '#faf1f5' },
      { name: '红色背景', bg: '#fdebec' }
    ];

    submenu.innerHTML = `
      <div class="color-section-title">文本颜色</div>
      ${textColors.map(c => `
        <div class="color-item" data-color-type="text" data-color-val="${c.color}">
          <span class="color-swatch-badge" style="color: ${c.color}">A</span>
          <span>${c.name}</span>
        </div>
      `).join('')}

      <div class="color-section-title" style="margin-top: 6px;">背景颜色</div>
      ${bgColors.map(c => `
        <div class="color-item" data-color-type="bg" data-color-val="${c.bg}">
          <span class="color-swatch-badge" style="background-color: ${c.bg}"></span>
          <span>${c.name}</span>
        </div>
      `).join('')}
    `;

    document.body.appendChild(submenu);

    // 智能定位：靠右展开，若屏幕右侧空间不足则向左展开
    const parentRect = anchorEl.getBoundingClientRect();
    const subWidth = 180;
    let left = parentRect.right + 4;
    if (left + subWidth > window.innerWidth - 10) {
      left = parentRect.left - subWidth - 4;
    }
    submenu.style.left = `${left}px`;
    submenu.style.top = `${parentRect.top - 6}px`;

    this.activeSubmenu = submenu;

    submenu.addEventListener('click', (e) => {
      const item = e.target.closest('.color-item');
      if (!item) return;

      e.stopPropagation();
      const colorType = item.dataset.colorType;
      const colorVal = item.dataset.colorVal;

      this.applyColor(type, targetIndex, colorType, colorVal);
      this.close();
    });
  }

  applyColor(type, targetIndex, colorType, colorVal) {
    if (type === 'column') {
      const cells = document.querySelectorAll(`[data-col="${targetIndex}"]`);
      cells.forEach(cell => {
        if (colorType === 'text') cell.style.color = colorVal;
        else cell.style.backgroundColor = colorVal;
      });
    } else {
      const tr = targetIndex === -1
        ? document.querySelector('thead tr, tr.header-row')
        : document.querySelectorAll('tbody tr')[targetIndex];
      if (tr) {
        tr.querySelectorAll('td, th').forEach(cell => {
          if (colorType === 'text') cell.style.color = colorVal;
          else cell.style.backgroundColor = colorVal;
        });
      }
    }
  }

  positionMenu(menuEl, anchorEl, type) {
    const anchorRect = anchorEl.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();

    let top = 0;
    let left = 0;

    if (type === 'column') {
      top = anchorRect.bottom + 6;
      left = anchorRect.left + anchorRect.width / 2 - menuRect.width / 2;
    } else {
      top = anchorRect.top + anchorRect.height / 2 - 20;
      left = anchorRect.right + 10;
    }

    const padding = 10;
    if (left < padding) left = padding;
    if (left + menuRect.width > window.innerWidth - padding) {
      left = window.innerWidth - menuRect.width - padding;
    }
    if (top + menuRect.height > window.innerHeight - padding) {
      top = window.innerHeight - menuRect.height - padding;
    }

    menuEl.style.top = `${Math.round(top)}px`;
    menuEl.style.left = `${Math.round(left)}px`;
  }

  // ------------------------- Excel 风格双层单元格右键菜单 -------------------------

  openCellContextMenu(clientX, clientY, cellInfo, range) {
    this.close();

    const Icons = window.InteractiveTable.Icons;
    const state = this.state;
    const { row, col } = cellInfo;
    const targetRange = range || { minR: row, maxR: row, minC: col, maxC: col };

    const cellCount = (targetRange.maxR - targetRange.minR + 1) * (targetRange.maxC - targetRange.minC + 1);
    const canMerge = cellCount >= 2;

    const allMerges = state.getMerges ? state.getMerges() : [];
    const hasMergeInside = allMerges.some(m => {
      const overlapR = !(m.maxR < targetRange.minR || m.minR > targetRange.maxR);
      const overlapC = !(m.maxC < targetRange.minC || m.minC > targetRange.maxC);
      return overlapR && overlapC;
    });

    const sampleStyle = state.getCellStyle ? state.getCellStyle(row, col) : {};

    const menu = document.createElement('div');
    menu.className = 'notion-popover cell-excel-popover';

    menu.innerHTML = `
      <!-- 1. 顶部快捷格式微型工具条 (Mini Formatting Bar) -->
      <div class="mini-format-toolbar">
        <div class="format-btn-group">
          <button type="button" class="format-btn ${sampleStyle.bold ? 'active' : ''}" data-format="bold" title="加粗 (Bold)">
            ${Icons ? Icons.get('TextBoldIcon', 15) : 'B'}
          </button>
          <button type="button" class="format-btn ${sampleStyle.italic ? 'active' : ''}" data-format="italic" title="斜体 (Italic)">
            ${Icons ? Icons.get('TextItalicIcon', 15) : 'I'}
          </button>
          <button type="button" class="format-btn ${sampleStyle.underline ? 'active' : ''}" data-format="underline" title="下划线 (Underline)">
            ${Icons ? Icons.get('TextUnderlineIcon', 15) : 'U'}
          </button>
          <button type="button" class="format-btn ${sampleStyle.strike ? 'active' : ''}" data-format="strike" title="删除线 (Strikethrough)">
            ${Icons ? Icons.get('TextStrikethroughIcon', 15) : 'S'}
          </button>
        </div>

        <div class="toolbar-divider"></div>

        <div class="format-btn-group">
          <button type="button" class="format-btn color-dropdown-btn" data-color-target="color" title="文字颜色">
            ${Icons ? Icons.get('TextColorIcon', 15) : 'A'}
            <span class="color-indicator-bar" style="background-color: ${sampleStyle.color || '#37352f'};"></span>
          </button>
          <button type="button" class="format-btn color-dropdown-btn" data-color-target="bg" title="背景填充色">
            ${Icons ? Icons.get('PaintBucketIcon', 15) : 'Fill'}
            <span class="color-indicator-bar" style="background-color: ${sampleStyle.bg || 'transparent'};"></span>
          </button>
        </div>

        <div class="toolbar-divider"></div>

        <div class="format-btn-group">
          <button type="button" class="format-btn ${sampleStyle.align === 'left' || !sampleStyle.align ? 'active' : ''}" data-format="align" data-val="left" title="左对齐">
            ${Icons ? Icons.get('TextAlignLeftIcon', 15) : 'L'}
          </button>
          <button type="button" class="format-btn ${sampleStyle.align === 'center' ? 'active' : ''}" data-format="align" data-val="center" title="居中对齐">
            ${Icons ? Icons.get('TextAlignCenterIcon', 15) : 'C'}
          </button>
          <button type="button" class="format-btn ${sampleStyle.align === 'right' ? 'active' : ''}" data-format="align" data-val="right" title="右对齐">
            ${Icons ? Icons.get('TextAlignRightIcon', 15) : 'R'}
          </button>
        </div>

        <div class="toolbar-divider"></div>

        <div class="format-btn-group">
          <button type="button" class="format-btn ${sampleStyle.vAlign === 'top' ? 'active' : ''}" data-format="vAlign" data-val="top" title="顶端对齐">
            ${Icons ? Icons.get('AlignTopIcon', 15) : 'T'}
          </button>
          <button type="button" class="format-btn ${sampleStyle.vAlign === 'middle' || !sampleStyle.vAlign ? 'active' : ''}" data-format="vAlign" data-val="middle" title="垂直居中">
            ${Icons ? Icons.get('AlignVerticalCenterIcon', 15) : 'M'}
          </button>
          <button type="button" class="format-btn ${sampleStyle.vAlign === 'bottom' ? 'active' : ''}" data-format="vAlign" data-val="bottom" title="底端对齐">
            ${Icons ? Icons.get('AlignBottomIcon', 15) : 'B'}
          </button>
        </div>

        ${canMerge || hasMergeInside ? `
          <div class="toolbar-divider"></div>
          <div class="format-btn-group">
            ${canMerge ? `
              <button type="button" class="format-btn" data-action="merge" title="合并单元格">
                ${Icons ? Icons.get('TableCellsMergeIcon', 15) : 'M'}
              </button>
            ` : ''}
            ${hasMergeInside ? `
              <button type="button" class="format-btn" data-action="split" title="取消合并单元格">
                ${Icons ? Icons.get('TableCellsSplitIcon', 15) : 'S'}
              </button>
            ` : ''}
          </div>
        ` : ''}
      </div>

      <div class="menu-tier-divider"></div>

      <!-- 2. 下部操作菜单清单 (Context Menu List) -->
      <div class="menu-items-container">
        <div class="menu-item" data-action="cut">
          <span class="menu-item-icon">${Icons ? Icons.get('ScissorsIcon', 16) : ''}</span>
          <span class="menu-item-text">剪切</span>
          <span class="menu-item-shortcut">Ctrl+X</span>
        </div>
        <div class="menu-item" data-action="copy">
          <span class="menu-item-icon">${Icons ? Icons.get('Copy01Icon', 16) : ''}</span>
          <span class="menu-item-text">复制</span>
          <span class="menu-item-shortcut">Ctrl+C</span>
        </div>
        <div class="menu-item" data-action="paste">
          <span class="menu-item-icon">${Icons ? Icons.get('ClipboardPasteIcon', 16) : ''}</span>
          <span class="menu-item-text">粘贴</span>
          <span class="menu-item-shortcut">Ctrl+V</span>
        </div>

        <div class="menu-divider"></div>

        <div class="menu-item" data-action="insert-row-above">
          <span class="menu-item-icon">${Icons ? Icons.get('ArrowUp02Icon', 16) : '↑'}</span>
          <span class="menu-item-text">在上方插入行</span>
        </div>
        <div class="menu-item" data-action="insert-row-below">
          <span class="menu-item-icon">${Icons ? Icons.get('ArrowDown02Icon', 16) : '↓'}</span>
          <span class="menu-item-text">在下方插入行</span>
        </div>
        <div class="menu-item" data-action="insert-col-left">
          <span class="menu-item-icon">${Icons ? Icons.get('ArrowLeft02Icon', 16) : '←'}</span>
          <span class="menu-item-text">在左侧插入列</span>
        </div>
        <div class="menu-item" data-action="insert-col-right">
          <span class="menu-item-icon">${Icons ? Icons.get('ArrowRight02Icon', 16) : '→'}</span>
          <span class="menu-item-text">在右侧插入列</span>
        </div>

        ${canMerge || hasMergeInside ? `
          <div class="menu-divider"></div>
          ${canMerge ? `
            <div class="menu-item" data-action="merge">
              <span class="menu-item-icon">${Icons ? Icons.get('TableCellsMergeIcon', 16) : ''}</span>
              <span class="menu-item-text">合并单元格</span>
            </div>
          ` : ''}
          ${hasMergeInside ? `
            <div class="menu-item" data-action="split">
              <span class="menu-item-icon">${Icons ? Icons.get('TableCellsSplitIcon', 16) : ''}</span>
              <span class="menu-item-text">取消合并单元格</span>
            </div>
          ` : ''}
        ` : ''}

        <div class="menu-divider"></div>

        <div class="menu-item" data-action="clear-contents">
          <span class="menu-item-icon">${Icons ? Icons.get('Eraser01Icon', 16) : ''}</span>
          <span class="menu-item-text">清空内容</span>
          <span class="menu-item-shortcut">Delete</span>
        </div>
        <div class="menu-item" data-action="clear-format">
          <span class="menu-item-icon">${Icons ? Icons.get('CleanIcon', 16) : ''}</span>
          <span class="menu-item-text">清除格式</span>
        </div>

        <div class="menu-divider"></div>

        <div class="menu-item danger" data-action="delete-row">
          <span class="menu-item-icon danger-icon">${Icons ? Icons.get('Delete02Icon', 16) : ''}</span>
          <span class="menu-item-text">删除所选行</span>
        </div>
        <div class="menu-item danger" data-action="delete-col">
          <span class="menu-item-icon danger-icon">${Icons ? Icons.get('Delete02Icon', 16) : ''}</span>
          <span class="menu-item-text">删除所选列</span>
        </div>
      </div>
    `;

    document.body.appendChild(menu);
    this.positionPointMenu(menu, clientX, clientY);
    this.activeMenu = menu;

    this.bindCellMenuInteractions(menu, targetRange, cellInfo);
  }

  positionPointMenu(menuEl, x, y) {
    const menuRect = menuEl.getBoundingClientRect();
    let left = x + 2;
    let top = y + 2;
    const padding = 12;

    if (left + menuRect.width > window.innerWidth - padding) {
      left = window.innerWidth - menuRect.width - padding;
    }
    if (top + menuRect.height > window.innerHeight - padding) {
      top = window.innerHeight - menuRect.height - padding;
    }
    if (left < padding) left = padding;
    if (top < padding) top = padding;

    menuEl.style.top = `${Math.round(top)}px`;
    menuEl.style.left = `${Math.round(left)}px`;
  }

  bindCellMenuInteractions(menu, targetRange, cellInfo) {
    // 1. 顶部工具栏交互
    menu.querySelector('.mini-format-toolbar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.format-btn');
      if (!btn) return;
      e.stopPropagation();

      const format = btn.dataset.format;
      const colorTarget = btn.dataset.colorTarget;
      const action = btn.dataset.action;

      if (colorTarget) {
        this.openColorPalette(btn, colorTarget, targetRange);
        return;
      }

      if (format === 'bold') {
        const current = btn.classList.contains('active');
        this.state.applyCellStyle(targetRange, { bold: !current });
        btn.classList.toggle('active');
      } else if (format === 'italic') {
        const current = btn.classList.contains('active');
        this.state.applyCellStyle(targetRange, { italic: !current });
        btn.classList.toggle('active');
      } else if (format === 'underline') {
        const current = btn.classList.contains('active');
        this.state.applyCellStyle(targetRange, { underline: !current });
        btn.classList.toggle('active');
      } else if (format === 'strike') {
        const current = btn.classList.contains('active');
        this.state.applyCellStyle(targetRange, { strike: !current });
        btn.classList.toggle('active');
      } else if (format === 'align') {
        const val = btn.dataset.val;
        this.state.applyCellStyle(targetRange, { align: val });
        btn.parentElement.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      } else if (format === 'vAlign') {
        const val = btn.dataset.val;
        this.state.applyCellStyle(targetRange, { vAlign: val });
        btn.parentElement.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      } else if (action === 'merge') {
        this.state.mergeRange(targetRange);
        this.close();
      } else if (action === 'split') {
        this.state.splitMerge(targetRange);
        this.close();
      }
    });

    // 2. 下部操作列表交互
    menu.querySelector('.menu-items-container')?.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item) return;
      e.stopPropagation();

      const action = item.dataset.action;
      const app = window.__interactiveTableApp;
      const clipMgr = app?.clipboardManager;

      if (action === 'cut') {
        if (clipMgr) {
          const matrix = clipMgr.getSelectedMatrix();
          if (matrix && matrix.length > 0) {
            clipMgr.writeToClipboard(clipMgr.serializeTSV(matrix));
            clipMgr.flashCopyFeedback();
            this.state.clearCellsRange(targetRange.minR, targetRange.maxR, targetRange.minC, targetRange.maxC);
          }
        }
        this.close();
      } else if (action === 'copy') {
        if (clipMgr) {
          const matrix = clipMgr.getSelectedMatrix();
          if (matrix && matrix.length > 0) {
            clipMgr.writeToClipboard(clipMgr.serializeTSV(matrix));
            clipMgr.flashCopyFeedback();
          }
        }
        this.close();
      } else if (action === 'paste') {
        this.close();
        if (navigator.clipboard?.readText) {
          navigator.clipboard.readText().then(text => {
            if (text && clipMgr) {
              const matrix = clipMgr.parseTSV(text);
              if (matrix && matrix.length > 0) {
                this.state.batchUpdateMatrix(targetRange.minR, targetRange.minC, matrix);
              }
            }
          }).catch(() => {});
        }
      } else if (action === 'insert-row-above') {
        const insertIdx = targetRange.minR === -1 ? 0 : targetRange.minR;
        this.state.insertRow(insertIdx);
        this.close();
      } else if (action === 'insert-row-below') {
        const insertIdx = targetRange.maxR === -1 ? 0 : targetRange.maxR + 1;
        this.state.insertRow(insertIdx);
        this.close();
      } else if (action === 'insert-col-left') {
        this.state.insertColumn(targetRange.minC);
        this.close();
      } else if (action === 'insert-col-right') {
        this.state.insertColumn(targetRange.maxC + 1);
        this.close();
      } else if (action === 'merge') {
        this.state.mergeRange(targetRange);
        this.close();
      } else if (action === 'split') {
        this.state.splitMerge(targetRange);
        this.close();
      } else if (action === 'clear-contents') {
        this.state.clearCellsRange(targetRange.minR, targetRange.maxR, targetRange.minC, targetRange.maxC);
        this.close();
      } else if (action === 'clear-format') {
        this.state.clearCellStyle(targetRange);
        this.close();
      } else if (action === 'delete-row') {
        for (let r = targetRange.maxR; r >= targetRange.minR; r--) {
          if (r >= 0) this.state.deleteRow(r);
        }
        this.close();
      } else if (action === 'delete-col') {
        for (let c = targetRange.maxC; c >= targetRange.minC; c--) {
          this.state.deleteColumn(c);
        }
        this.close();
      }
    });
  }

  openColorPalette(anchorBtn, colorTarget, targetRange) {
    if (this.activeSubmenu) {
      this.activeSubmenu.remove();
      this.activeSubmenu = null;
    }

    const pop = document.createElement('div');
    pop.className = 'notion-popover color-picker-popover';

    const colors = [
      { name: '默认', hex: '', bgHex: '' },
      { name: '墨灰', hex: '#787774', bgHex: '#f1f1ef' },
      { name: '暖棕', hex: '#976d57', bgHex: '#f4eeee' },
      { name: '落日橙', hex: '#cc7722', bgHex: '#faece3' },
      { name: '麦黄', hex: '#c29210', bgHex: '#fbf3db' },
      { name: '苔绿', hex: '#448361', bgHex: '#edf3ec' },
      { name: '海蓝', hex: '#2383e2', bgHex: '#e7f3f8' },
      { name: '紫罗兰', hex: '#9065b0', bgHex: '#f4f0f7' },
      { name: '浅粉', hex: '#c14c8a', bgHex: '#f9f0f5' },
      { name: '绯红', hex: '#d44c47', bgHex: '#fbe4e4' }
    ];

    pop.innerHTML = `
      <div class="color-palette-title">${colorTarget === 'color' ? '文字颜色' : '背景填充色'}</div>
      <div class="color-swatches-grid">
        ${colors.map(c => {
          const val = colorTarget === 'color' ? c.hex : c.bgHex;
          const displayStyle = val
            ? (colorTarget === 'color' ? `background-color: ${val};` : `background-color: ${val}; border: 1px solid rgba(0,0,0,0.1);`)
            : 'background: repeating-linear-gradient(45deg, #eee, #eee 2px, #fff 2px, #fff 6px); border: 1px solid rgba(0,0,0,0.15);';
          return `
            <div class="color-swatch-item" data-val="${val}" title="${c.name}">
              <div class="color-swatch-circle" style="${displayStyle}"></div>
              <span class="color-swatch-name">${c.name}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;

    document.body.appendChild(pop);
    this.activeSubmenu = pop;

    const btnRect = anchorBtn.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let top = btnRect.bottom + 6;
    let left = btnRect.left;
    if (left + popRect.width > window.innerWidth - 10) {
      left = window.innerWidth - popRect.width - 10;
    }
    if (top + popRect.height > window.innerHeight - 10) {
      top = btnRect.top - popRect.height - 6;
    }

    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(left)}px`;

    pop.addEventListener('click', (e) => {
      const item = e.target.closest('.color-swatch-item');
      if (!item) return;
      e.stopPropagation();
      const val = item.dataset.val;
      this.state.applyCellStyle(targetRange, { [colorTarget]: val });
      this.close();
    });
  }
};

