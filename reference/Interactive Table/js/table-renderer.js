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

    if (style.color) parts.push(`color: ${style.color};`);
    if (style.bg) parts.push(`background-color: ${style.bg};`);
    if (style.align) parts.push(`text-align: ${style.align};`);
    if (style.vAlign) parts.push(`vertical-align: ${style.vAlign};`);

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

    // 1. 渲染顶部列手柄 (单根横线 -，未触摸细横条，触摸变椭圆胶囊+3点，拖动变蓝底白点)
    const headerCells = Array.from(table.querySelectorAll('thead th, tbody tr:first-child td'));
    data.columns.forEach((_, colIdx) => {
      const colBtn = document.createElement('button');
      colBtn.className = 'col-handle-btn';
      colBtn.dataset.col = colIdx;
      colBtn.title = '点击选中列，按住拖动排序';
      colBtn.innerHTML = buildColHandleHtml();
      colContainer.appendChild(colBtn);

      const targetCell = headerCells[colIdx];
      if (targetCell) {
        const thRect = targetCell.getBoundingClientRect();
        const centerX = (thRect.left + thRect.right) / 2 - cRect.left;
        colBtn.style.left = `${centerX}px`;
        colBtn.style.top = `${topBorderCenterY}px`;
      }
    });

    // 2. 渲染左侧行手柄 (单根竖线 |，未触摸细条，触摸变椭圆胶囊+3点，拖动变蓝底白点)
    const allTrs = Array.from(table.querySelectorAll('tr'));
    allTrs.forEach((tr, trIdx) => {
      const isHeader = tr.classList.contains('header-row') || tr.parentElement.tagName.toLowerCase() === 'thead';
      const rowIndex = isHeader ? -1 : parseInt(tr.dataset.row, 10);

      const rowBtn = document.createElement('button');
      rowBtn.className = 'row-handle-btn';
      rowBtn.dataset.row = rowIndex;
      rowBtn.dataset.isHeader = isHeader ? 'true' : 'false';
      rowBtn.dataset.trIndex = trIdx;
      rowBtn.title = '点击选中行，按住拖动排序';
      rowBtn.innerHTML = buildRowHandleHtml();
      rowGutter.appendChild(rowBtn);

      const trRect = tr.getBoundingClientRect();
      const centerY = (trRect.top + trRect.bottom) / 2 - cRect.top;
      rowBtn.style.top = `${centerY}px`;
      rowBtn.style.left = `${leftBorderCenterX}px`;
    });
  }

  bindHoverEvents() {
    document.addEventListener('mousemove', (e) => {
      const data = this.state.get();
      const table = this.root.querySelector('.notion-table');
      if (!table) return;

      const colBtns = this.root.querySelectorAll('.col-handle-btn');
      const rowBtns = this.root.querySelectorAll('.row-handle-btn');
      const addColBtn = this.root.querySelector('#add-column-btn');
      const addRowBtn = this.root.querySelector('#add-row-btn');

      const maxCol = data.columns.length - 1;
      const maxRow = data.rows.length - 1;
      const tableRect = table.getBoundingClientRect();
      const mouseX = e.clientX;
      const mouseY = e.clientY;

      const targetEl = (e.target && e.target instanceof Element) ? e.target : document.body;

      // 1. 单元格定位与双手柄联动显隐 (消除手柄与单元格之间的悬停盲区)
      const cell = targetEl.closest('td, th');
      const isInsideThisTable = cell && this.root.contains(cell);

      // 左侧感应带判定：光标处于表格左侧边框及向外延伸 35px 范围内
      const isInLeftGutterZone = mouseX >= tableRect.left - 35 && mouseX <= tableRect.left + 15 &&
                                 mouseY >= tableRect.top - 5 && mouseY <= tableRect.bottom + 5;

      // 顶部感应带判定：光标处于表格顶部边框及向上延伸 25px 范围内
      const isInTopGutterZone = mouseY >= tableRect.top - 25 && mouseY <= tableRect.top + 15 &&
                                mouseX >= tableRect.left - 5 && mouseX <= tableRect.right + 5;

      let activeRowIdx = null;
      let activeColIdx = null;

      if (isInsideThisTable) {
        const isHeader = cell.tagName.toLowerCase() === 'th';
        activeRowIdx = isHeader ? -1 : parseInt(cell.dataset.row, 10);
        activeColIdx = parseInt(cell.dataset.col, 10);
      } else if (isInLeftGutterZone) {
        // 在左侧手柄感应区内：计算光标纵向落在哪个 tr 范围内
        const allTrs = Array.from(table.querySelectorAll('tr'));
        allTrs.forEach(tr => {
          const r = tr.getBoundingClientRect();
          if (mouseY >= r.top && mouseY <= r.bottom) {
            const isHeader = tr.classList.contains('header-row') || tr.parentElement.tagName.toLowerCase() === 'thead';
            activeRowIdx = isHeader ? -1 : parseInt(tr.dataset.row, 10);
          }
        });
      } else if (isInTopGutterZone) {
        // 在顶部手柄感应区内：计算光标横向落在哪个 th 范围内
        const allThs = Array.from(table.querySelectorAll('thead th, tbody tr:first-child td'));
        allThs.forEach((th, cIdx) => {
          const r = th.getBoundingClientRect();
          if (mouseX >= r.left && mouseX <= r.right) {
            activeColIdx = cIdx;
          }
        });
      }

      // 如果悬停在手柄自身上，则保持激活
      const hoveredColBtn = targetEl.closest('.col-handle-btn');
      const hoveredRowBtn = targetEl.closest('.row-handle-btn');

      colBtns.forEach(b => {
        const colIdx = parseInt(b.dataset.col, 10);
        if (colIdx === activeColIdx || b === hoveredColBtn || b.classList.contains('active')) {
          b.classList.add('visible');
        } else {
          b.classList.remove('visible');
        }
      });

      rowBtns.forEach(b => {
        const rowIdx = parseInt(b.dataset.row, 10);
        if (rowIdx === activeRowIdx || b === hoveredRowBtn || b.classList.contains('active')) {
          b.classList.add('visible');
        } else {
          b.classList.remove('visible');
        }
      });

      // 2. 右侧加列条 (#add-column-btn) 显隐逻辑 (用户批注 media_1789395718900.png 鼠标停在右侧空白区域也可以显示)：
      // 满足以下任一条件均平滑保持显示：
      // - 鼠标直接 hover 在 #add-column-btn 上
      // - 鼠标在最右列单元格内
      // - 鼠标在表格右侧空白感应扩展区 (tableRect.right - 10 <= mouseX <= tableRect.right + 70，且纵向处于表格高度范围内)
      const isOverAddCol = !!targetEl.closest('#add-column-btn');
      const isOverLastColCell = isInsideThisTable && parseInt(cell.dataset.col, 10) === maxCol;
      const isInRightZone = mouseX >= tableRect.right - 10 && mouseX <= tableRect.right + 70 &&
                            mouseY >= tableRect.top - 10 && mouseY <= tableRect.bottom + 10;

      if (isOverAddCol || isOverLastColCell || isInRightZone) {
        addColBtn?.classList.add('visible');
      } else {
        addColBtn?.classList.remove('visible');
      }

      // 3. 底部加行条 (#add-row-btn) 显隐逻辑 (用户批注 media_1789395718900.png 鼠标停在底部空白区域也可以显示)：
      // 满足以下任一条件均平滑保持显示：
      // - 鼠标直接 hover 在 #add-row-btn 上
      // - 鼠标在最底行单元格内
      // - 鼠标在表格底部空白感应扩展区 (tableRect.bottom - 10 <= mouseY <= tableRect.bottom + 70，且横向处于表格宽度范围内)
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
      const colBtns = this.root.querySelectorAll('.col-handle-btn');
      const rowBtns = this.root.querySelectorAll('.row-handle-btn');
      colBtns.forEach(b => { if (!b.classList.contains('active')) b.classList.remove('visible'); });
      rowBtns.forEach(b => { if (!b.classList.contains('active')) b.classList.remove('visible'); });

      this.root.querySelector('#add-column-btn')?.classList.remove('visible');
      this.root.querySelector('#add-row-btn')?.classList.remove('visible');
    });

    window.addEventListener('resize', () => {
      this.mountHandles();
    });
  }
};
