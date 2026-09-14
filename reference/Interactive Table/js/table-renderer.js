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
          <tr data-row="-1" class="header-row">${data.headers.map((headerText, colIdx) => `<th data-row="-1" data-col="${colIdx}">${headerText}<div class="col-resizer" data-col="${colIdx}" title="按住拖拽调整列宽"></div></th>`).join('')}</tr>
        </thead>
      `;
    }

    tbodyHtml = `
      <tbody>
        ${data.rows.map((row, rowIdx) => `
          <tr data-row="${rowIdx}">${row.cells.map((cellText, colIdx) => `<td data-row="${rowIdx}" data-col="${colIdx}">${cellText}</td>`).join('')}</tr>
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

    const dotsHtml = `
      <div class="handle-dots-grid">
        <div class="handle-dot"></div><div class="handle-dot"></div><div class="handle-dot"></div>
        <div class="handle-dot"></div><div class="handle-dot"></div><div class="handle-dot"></div>
      </div>
    `;

    // 1. 渲染顶部列手柄 (单根横线 -，严格居中骑在表头顶水平边框线和各列几何中心)
    const headerCells = Array.from(table.querySelectorAll('thead th, tbody tr:first-child td'));
    data.columns.forEach((_, colIdx) => {
      const colBtn = document.createElement('button');
      colBtn.className = 'col-handle-btn';
      colBtn.dataset.col = colIdx;
      colBtn.title = '按住拖动排序，点击打开选项';
      colBtn.innerHTML = `
        <div class="col-handle-bar"></div>
        ${dotsHtml}
      `;
      colContainer.appendChild(colBtn);

      const targetCell = headerCells[colIdx];
      if (targetCell) {
        const thRect = targetCell.getBoundingClientRect();
        const centerX = (thRect.left + thRect.right) / 2 - cRect.left;
        colBtn.style.left = `${centerX}px`;
        colBtn.style.top = `${topBorderCenterY}px`;
      }
    });

    // 2. 渲染左侧行手柄 (单根竖线 |，严格居中骑在表格最左侧边框线和各行几何中心)
    const allTrs = Array.from(table.querySelectorAll('tr'));
    allTrs.forEach((tr, trIdx) => {
      const isHeader = tr.classList.contains('header-row') || tr.parentElement.tagName.toLowerCase() === 'thead';
      const rowIndex = isHeader ? -1 : parseInt(tr.dataset.row, 10);

      const rowBtn = document.createElement('button');
      rowBtn.className = 'row-handle-btn';
      rowBtn.dataset.row = rowIndex;
      rowBtn.dataset.isHeader = isHeader ? 'true' : 'false';
      rowBtn.dataset.trIndex = trIdx;
      rowBtn.title = '按住拖动排序，点击打开选项';
      rowBtn.innerHTML = `
        <div class="row-handle-bar"></div>
        ${dotsHtml}
      `;
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

      // 1. 单元格定位与双手柄联动显隐 (用户批注 media_1789394859394.png)
      const cell = targetEl.closest('td, th');
      const isInsideThisTable = cell && this.root.contains(cell);

      if (isInsideThisTable) {
        const isHeader = cell.tagName.toLowerCase() === 'th';
        const row = isHeader ? -1 : parseInt(cell.dataset.row, 10);
        const col = parseInt(cell.dataset.col, 10);

        // 联动显示对应列手柄 (顶部横短线)
        colBtns.forEach(b => {
          if (parseInt(b.dataset.col, 10) === col || b.classList.contains('active')) {
            b.classList.add('visible');
          } else {
            b.classList.remove('visible');
          }
        });

        // 联动显示对应行手柄 (左侧竖短线)
        rowBtns.forEach(b => {
          if (parseInt(b.dataset.row, 10) === row || b.classList.contains('active')) {
            b.classList.add('visible');
          } else {
            b.classList.remove('visible');
          }
        });
      } else {
        // 鼠标不在单元格内部时：若悬停在手柄自身上则保持显示，否则隐藏未激活手柄
        const hoveredColBtn = targetEl.closest('.col-handle-btn');
        const hoveredRowBtn = targetEl.closest('.row-handle-btn');

        colBtns.forEach(b => {
          if (b === hoveredColBtn || b.classList.contains('active')) {
            b.classList.add('visible');
          } else {
            b.classList.remove('visible');
          }
        });

        rowBtns.forEach(b => {
          if (b === hoveredRowBtn || b.classList.contains('active')) {
            b.classList.add('visible');
          } else {
            b.classList.remove('visible');
          }
        });
      }

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
