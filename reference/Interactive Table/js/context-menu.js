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
};
