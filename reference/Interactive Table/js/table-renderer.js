/**
 * table-renderer.js - DOM 渲染引擎
 * 1. 彻底移除顶部多余工具栏，保持大标题 -> 副标题 -> 表格纯净极简文档流
 * 2. 边框骑线精准挂载单线段手柄 (横线 - 与竖线 |)
 * 3. 内置 6 点阵图标容器 (:::) 用于激活与拖拽状态
 * 4. 严格实现仅在 Hover 对应单元格时才在该行/该列线上浮现手柄
 */

window.InteractiveTable = window.InteractiveTable || {};

window.InteractiveTable.TableRenderer = class TableRenderer {
  constructor(state, rootElement) {
    this.state = state;
    this.root = rootElement;
    this.bindHoverEvents();
  }

  formatCellStyle(style = {}) {
    const parts = [];
    if (style.bold) parts.push('font-weight: 600;');
    if (style.italic) parts.push('font-style: italic;');
    
    const decors = [];
    if (style.underline) decors.push('underline');
    if (style.strike) decors.push('line-through');
    if (decors.length > 0) parts.push(`text-decoration: ${decors.join(' ')};`);

    if (style.color) parts.push(`color: ${style.color} !important;`);
    if (style.bg) parts.push(`background-color: ${style.bg} !important;`);
    if (style.align) parts.push(`text-align: ${style.align};`);
    if (style.vAlign) parts.push(`vertical-align: ${style.vAlign};`);
    if (style.fontSize) parts.push(`font-size: ${style.fontSize}px !important;`);

    return parts.length > 0 ? `style="${parts.join(' ')}"` : '';
  }

  renderCell(rowIdx, colIdx, rawData, isHeader = false) {
    const TableState = window.InteractiveTable.TableState;
    const value = TableState ? TableState.getCellValue(rawData) : String(rawData || '');
    const style = TableState ? TableState.getCellStyle(rawData) : {};
    const styleAttr = this.formatCellStyle(style);

    const isHidden = this.state.isMergeHidden(rowIdx, colIdx);
    if (isHidden) {
      return `<td data-row="${rowIdx}" data-col="${colIdx}" class="cell-merged-hidden" style="display: none;"></td>`;
    }

    const merge = this.state.getMergeAt(rowIdx, colIdx);
    let spanAttrs = '';
    let mergeClass = '';
    if (merge && merge.minR === rowIdx && merge.minC === colIdx) {
      const rowspan = merge.maxR - merge.minR + 1;
      const colspan = merge.maxC - merge.minC + 1;
      if (rowspan > 1) spanAttrs += ` rowspan="${rowspan}"`;
      if (colspan > 1) spanAttrs += ` colspan="${colspan}"`;
      mergeClass = ' cell-merged-master';
    }

    if (isHeader) {
      return `<th data-row="-1" data-col="${colIdx}" class="${mergeClass}" ${spanAttrs} ${styleAttr}>${value}<div class="col-resizer" data-col="${colIdx}" title="按住拖拽调整列宽"></div></th>`;
    }

    return `<td data-row="${rowIdx}" data-col="${colIdx}" class="${mergeClass}" ${spanAttrs} ${styleAttr}>${value}</td>`;
  }

  render() {
    const data = this.state.get();

    // 生成 colgroup
    const colgroupHtml = `
      <colgroup>
        ${data.columns.map((col, idx) => `<col data-col="${idx}" style="width: ${col.width || 190}px;">`).join('')}
      </colgroup>
    `;

    // 生成表头行与表体行（单行模板，消除任何额外换行空白）
    let theadHtml = '';
    let tbodyHtml = '';

    if (data.hasHeaderRow) {
      theadHtml = `
        <thead>
          <tr data-row="-1" class="header-row">${data.headers.map((h, colIdx) => this.renderCell(-1, colIdx, h, true)).join('')}</tr>
        </thead>
      `;
    }

    tbodyHtml = `
      <tbody>
        ${data.rows.map((row, rowIdx) => `
          <tr data-row="${rowIdx}">${row.cells.map((c, colIdx) => this.renderCell(rowIdx, colIdx, c, false)).join('')}</tr>
        `).join('')}
      </tbody>
    `;

    // 组装无顶栏的纯净 DOM 结构
    this.root.innerHTML = `
      <div class="table-outer-container">
        <div class="notion-table-wrapper">
          <!-- 1. 左侧行操作手柄区域 (骑在最左侧边框线上，单竖线 |) -->
          <div class="row-handle-gutter" id="row-handle-gutter"></div>

          <!-- 表格主体与顶部列手柄、底部添加条 -->
          <div class="table-content-area">
            <!-- 2. 顶部列操作手柄区域 (骑在表头顶边框线上，单横线 -) -->
            <div class="col-handle-bar-container" id="col-handle-bar-container"></div>

            <!-- 表格本体 -->
            <table class="notion-table ${data.hasHeaderColumn ? 'has-header-col' : ''}">
              ${colgroupHtml}
              ${theadHtml}
              ${tbodyHtml}
            </table>

            <!-- 4. 底部添加行条 -->
            <div class="add-row-strip" id="add-row-btn" title="点击添加行">
              <span class="plus-icon">${window.InteractiveTable.Icons ? window.InteractiveTable.Icons.get('PlusSignIcon', 13) : '+'}</span>
            </div>
          </div>

          <!-- 3. 右侧添加列条 -->
          <div class="add-column-strip" id="add-column-btn" title="点击添加列">
            <span class="plus-icon">${window.InteractiveTable.Icons ? window.InteractiveTable.Icons.get('PlusSignIcon', 13) : '+'}</span>
          </div>
        </div>
      </div>
    `;

    // 精准挂载骑线行列操作手柄
    this.mountHandles();
  }

  mountHandles() {
    const data = this.state.get();
    const rowGutter = this.root.querySelector('#row-handle-gutter');
    const colContainer = this.root.querySelector('#col-handle-bar-container');
    const table = this.root.querySelector('.notion-table');
    const contentArea = this.root.querySelector('.table-content-area');
    if (!rowGutter || !colContainer || !table || !contentArea) return;

    rowGutter.innerHTML = '';
    colContainer.innerHTML = '';

    const cRect = contentArea.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const topBorderCenterY = (tableRect.top + 0.5) - cRect.top;
    const leftBorderCenterX = (tableRect.left + 0.5) - cRect.left;

    const buildColHandleHtml = () => `
      <div class="handle-capsule col-capsule">
        <div class="handle-bar col-bar"></div>
        <div class="handle-dots col-dots">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
      </div>
    `;

    const buildRowHandleHtml = () => `
      <div class="handle-capsule row-capsule">
        <div class="handle-bar row-bar"></div>
        <div class="handle-dots row-dots">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
      </div>
    `;

    // 1. 创建单个高质感丝滑滑动的顶部列手柄 (Sliding Column Handle)
    const colBtn = document.createElement('button');
    colBtn.className = 'col-handle-btn col-slider-handle';
    colBtn.dataset.col = '0';
    colBtn.title = '点击选中列，按住拖动排序';
    colBtn.innerHTML = buildColHandleHtml();
    colBtn.style.top = `${topBorderCenterY}px`;
    colContainer.appendChild(colBtn);
    this.slidingColBtn = colBtn;

    // 2. 创建单个高质感丝滑滑动的左侧行手柄 (Sliding Row Handle)
    const rowBtn = document.createElement('button');
    rowBtn.className = 'row-handle-btn row-slider-handle';
    rowBtn.dataset.row = '0';
    rowBtn.dataset.isHeader = data.hasHeaderRow ? 'true' : 'false';
    rowBtn.title = '点击选中行，按住拖动排序';
    rowBtn.innerHTML = buildRowHandleHtml();
    rowBtn.style.left = `${leftBorderCenterX}px`;
    rowGutter.appendChild(rowBtn);
    this.slidingRowBtn = rowBtn;
  }

  bindHoverEvents() {
    document.addEventListener('mousemove', (e) => {
      const data = this.state.get();
      const table = this.root.querySelector('.notion-table');
      const contentArea = this.root.querySelector('.table-content-area');
      if (!table || !contentArea) return;

      const colBtn = this.slidingColBtn || this.root.querySelector('.col-handle-btn');
      const rowBtn = this.slidingRowBtn || this.root.querySelector('.row-handle-btn');
      if (!colBtn || !rowBtn) return;

      const addColBtn = this.root.querySelector('#add-column-btn');
      const addRowBtn = this.root.querySelector('#add-row-btn');

      const maxCol = data.columns.length - 1;
      const maxRow = data.rows.length - 1;
      const tableRect = table.getBoundingClientRect();
      const cRect = contentArea.getBoundingClientRect();
      const mouseX = e.clientX;
      const mouseY = e.clientY;

      const targetEl = (e.target && e.target instanceof Element) ? e.target : document.body;

      // 如果上下文菜单打开且锚定在手柄上，或者手柄正在拖拽中，锁定当前手柄位置与状态
      const isColLocked = colBtn.classList.contains('active') || colBtn.classList.contains('dragging');
      const isRowLocked = rowBtn.classList.contains('active') || rowBtn.classList.contains('dragging');

      // 悬停在手柄自身判定
      const hoveredColBtn = !!targetEl.closest('.col-handle-btn');
      const hoveredRowBtn = !!targetEl.closest('.row-handle-btn');

      // 单元格与表格范围判定
      const cell = targetEl.closest('td, th');
      const isInsideTableRect = (
        mouseX >= tableRect.left && mouseX <= tableRect.right &&
        mouseY >= tableRect.top && mouseY <= tableRect.bottom
      );
      const isInsideThisTable = (cell && this.root.contains(cell)) || isInsideTableRect;

      // 左侧感应带：光标处于表格左侧边框及向外延伸 35px 范围内
      const isInLeftGutterZone = mouseX >= tableRect.left - 35 && mouseX <= tableRect.left + 15 &&
                                 mouseY >= tableRect.top - 5 && mouseY <= tableRect.bottom + 5;

      // 顶部感应带：光标处于表格顶部边框及向上延伸 25px 范围内
      const isInTopGutterZone = mouseY >= tableRect.top - 25 && mouseY <= tableRect.top + 15 &&
                                mouseX >= tableRect.left - 5 && mouseX <= tableRect.right + 5;

      // 表格整体感应区（消除单元格之间与边框缝隙的盲区）
      const isInTableHoverZone = (
        mouseX >= tableRect.left - 35 && mouseX <= tableRect.right + 20 &&
        mouseY >= tableRect.top - 25 && mouseY <= tableRect.bottom + 20
      );

      // 1. 列手柄位置计算与丝滑滑动 (Horizontal Glide)
      if (!isColLocked) {
        let activeColIdx = null;

        if (hoveredColBtn) {
          activeColIdx = parseInt(colBtn.dataset.col, 10);
        } else if (isInsideThisTable || isInTopGutterZone || (isInLeftGutterZone && mouseY <= tableRect.top + 30)) {
          // 根据光标物理横坐标匹配列（精确且天然兼容合并单元格）
          const headerCells = Array.from(table.querySelectorAll('thead th, tbody tr:first-child td'));
          for (let i = 0; i < headerCells.length; i++) {
            const r = headerCells[i].getBoundingClientRect();
            if (mouseX >= r.left && mouseX <= r.right) {
              activeColIdx = i;
              break;
            }
          }
          if (activeColIdx === null) {
            if (mouseX < tableRect.left + 30) activeColIdx = 0;
            else if (mouseX > tableRect.right - 30) activeColIdx = maxCol;
          }
        }

        if (activeColIdx !== null && activeColIdx >= 0 && activeColIdx <= maxCol && (isInTableHoverZone || hoveredColBtn)) {
          const headerCells = Array.from(table.querySelectorAll('thead th, tbody tr:first-child td'));
          const targetTh = headerCells[activeColIdx];
          if (targetTh) {
            const thRect = targetTh.getBoundingClientRect();
            const targetX = (thRect.left + thRect.right) / 2 - cRect.left;
            const topBorderCenterY = (tableRect.top + 0.5) - cRect.top;

            const wasVisible = colBtn.classList.contains('visible');

            if (!wasVisible) {
              colBtn.classList.add('no-transition');
              colBtn.style.left = `${targetX}px`;
              colBtn.style.top = `${topBorderCenterY}px`;
              colBtn.dataset.col = activeColIdx;
              void colBtn.offsetWidth; // 触发回流
              colBtn.classList.remove('no-transition');
              colBtn.classList.add('visible');
            } else {
              colBtn.style.left = `${targetX}px`;
              colBtn.style.top = `${topBorderCenterY}px`;
              colBtn.dataset.col = activeColIdx;
              colBtn.classList.add('visible');
            }
          }
        } else if (!hoveredColBtn) {
          colBtn.classList.remove('visible');
        }
      }

      // 2. 行手柄位置计算与丝滑滑动 (Vertical Glide)
      if (!isRowLocked) {
        let activeRowIdx = null;
        let isHeaderRow = false;

        if (hoveredRowBtn) {
          activeRowIdx = parseInt(rowBtn.dataset.row, 10);
          isHeaderRow = rowBtn.dataset.isHeader === 'true';
        } else if (isInsideThisTable || isInLeftGutterZone || (isInTopGutterZone && mouseX <= tableRect.left + 30)) {
          // 根据光标物理纵坐标匹配行（精确且天然兼容合并单元格）
          const allTrs = Array.from(table.querySelectorAll('tr'));
          for (let i = 0; i < allTrs.length; i++) {
            const tr = allTrs[i];
            const r = tr.getBoundingClientRect();
            if (mouseY >= r.top && mouseY <= r.bottom) {
              const isH = tr.classList.contains('header-row') || tr.parentElement.tagName.toLowerCase() === 'thead';
              activeRowIdx = isH ? -1 : parseInt(tr.dataset.row, 10);
              isHeaderRow = isH;
              break;
            }
          }
          if (activeRowIdx === null) {
            if (mouseY < tableRect.top + 30) {
              activeRowIdx = data.hasHeaderRow ? -1 : 0;
              isHeaderRow = data.hasHeaderRow;
            } else if (mouseY > tableRect.bottom - 30) {
              activeRowIdx = maxRow;
              isHeaderRow = false;
            }
          }
        }

        if (activeRowIdx !== null && (isInTableHoverZone || hoveredRowBtn)) {
          let targetTr = null;
          if (isHeaderRow || activeRowIdx === -1) {
            targetTr = table.querySelector('thead tr, tr.header-row');
          } else {
            targetTr = table.querySelector(`tbody tr[data-row="${activeRowIdx}"]`);
          }

          if (targetTr) {
            const trRect = targetTr.getBoundingClientRect();
            const targetY = (trRect.top + trRect.bottom) / 2 - cRect.top;
            const leftBorderCenterX = (tableRect.left + 0.5) - cRect.left;

            const wasVisible = rowBtn.classList.contains('visible');

            if (!wasVisible) {
              rowBtn.classList.add('no-transition');
              rowBtn.style.top = `${targetY}px`;
              rowBtn.style.left = `${leftBorderCenterX}px`;
              rowBtn.dataset.row = activeRowIdx;
              rowBtn.dataset.isHeader = isHeaderRow ? 'true' : 'false';
              void rowBtn.offsetWidth; // 触发回流
              rowBtn.classList.remove('no-transition');
              rowBtn.classList.add('visible');
            } else {
              rowBtn.style.top = `${targetY}px`;
              rowBtn.style.left = `${leftBorderCenterX}px`;
              rowBtn.dataset.row = activeRowIdx;
              rowBtn.dataset.isHeader = isHeaderRow ? 'true' : 'false';
              rowBtn.classList.add('visible');
            }
          }
        } else if (!hoveredRowBtn) {
          rowBtn.classList.remove('visible');
        }
      }

      // 3. 右侧加列条 (#add-column-btn) 显隐逻辑
      const isOverAddCol = !!targetEl.closest('#add-column-btn');
      const isOverLastColCell = isInsideThisTable && parseInt(cell.dataset.col, 10) === maxCol;
      const isInRightZone = mouseX >= tableRect.right - 10 && mouseX <= tableRect.right + 70 &&
                            mouseY >= tableRect.top - 10 && mouseY <= tableRect.bottom + 10;

      if (isOverAddCol || isOverLastColCell || isInRightZone) {
        addColBtn?.classList.add('visible');
      } else {
        addColBtn?.classList.remove('visible');
      }

      // 4. 底部加行条 (#add-row-btn) 显隐逻辑
      const isOverAddRow = !!targetEl.closest('#add-row-btn');
      const isOverLastRowCell = isInsideThisTable && cell.tagName.toLowerCase() !== 'th' && parseInt(cell.dataset.row, 10) === maxRow;
      const isInBottomZone = mouseY >= tableRect.bottom - 10 && mouseY <= tableRect.bottom + 70 &&
                             mouseX >= tableRect.left - 10 && mouseX <= tableRect.right + 10;

      if (isOverAddRow || isOverLastRowCell || isInBottomZone) {
        addRowBtn?.classList.add('visible');
      } else {
        addRowBtn?.classList.remove('visible');
      }
    });

    document.addEventListener('mouseleave', () => {
      const colBtn = this.slidingColBtn || this.root.querySelector('.col-handle-btn');
      const rowBtn = this.slidingRowBtn || this.root.querySelector('.row-handle-btn');
      if (colBtn && !colBtn.classList.contains('active')) colBtn.classList.remove('visible');
      if (rowBtn && !rowBtn.classList.contains('active')) rowBtn.classList.remove('visible');

      this.root.querySelector('#add-column-btn')?.classList.remove('visible');
      this.root.querySelector('#add-row-btn')?.classList.remove('visible');
    });

    window.addEventListener('resize', () => {
      this.mountHandles();
    });
  }
};
