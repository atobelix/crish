/**
 * divider-inserter.js - 边框扩展像素选取与加号插入线 (严格还原图三与图四)
 * - 鼠标在单元格边线 16px 扩展感应区内：显示灰色圆底加号 (图三)
 * - 鼠标在细线临近 4px 以内：灰色变为亮蓝色实心加号，并贯穿 2px 亮蓝线 (图四)
 * - 点击直接在精确位置插入全新一列或一行 (精准修正表头与首行之间的插入索引)
 */

window.InteractiveTable = window.InteractiveTable || {};

window.InteractiveTable.DividerInserter = class DividerInserter {
  constructor(state, rootElement) {
    this.state = state;
    this.root = rootElement;

    this.activeColDivider = null; // { index, x, dist }
    this.activeRowDivider = null; // { index, y, dist }

    // 速度感知与微停顿防飞线机制 (用户明确要求：快速移动时做响应抑制，避免灰蓝横线满天飞)
    this.lastX = null;
    this.lastY = null;
    this.lastTime = null;
    this.dwellTimer = null;
    this.isFastMoving = false;

    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseLeave = this.onMouseLeave.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onClick = this.onClick.bind(this);

    this.bindEvents();
  }

  bindEvents() {
    this.root.addEventListener('mousemove', this.onMouseMove);
    this.root.addEventListener('mouseleave', this.onMouseLeave);
    this.root.addEventListener('mousedown', this.onMouseDown, true);
    this.root.addEventListener('click', this.onClick, true);
  }

  getHeaderCells(table) {
    const ths = table.querySelectorAll('thead th');
    if (ths.length > 0) return Array.from(ths);
    return Array.from(table.querySelectorAll('tbody tr:first-child td'));
  }

  getElements() {
    const container = this.root.querySelector('.table-content-area');
    if (!container) return null;

    let colLine = container.querySelector('.col-divider-line');
    let colBadge = container.querySelector('.col-divider-badge');
    let rowLine = container.querySelector('.row-divider-line');
    let rowBadge = container.querySelector('.row-divider-badge');

    const plusSvg = window.InteractiveTable.Icons ? window.InteractiveTable.Icons.get('PlusSignIcon', 11) : '+';

    if (!colLine) {
      colLine = document.createElement('div');
      colLine.className = 'col-divider-line';
      container.appendChild(colLine);
    }
    if (!colBadge) {
      colBadge = document.createElement('div');
      colBadge.className = 'col-divider-badge';
      colBadge.innerHTML = `<span class="badge-icon">${plusSvg}</span>`;
      container.appendChild(colBadge);
    }
    if (!rowLine) {
      rowLine = document.createElement('div');
      rowLine.className = 'row-divider-line';
      container.appendChild(rowLine);
    }
    if (!rowBadge) {
      rowBadge = document.createElement('div');
      rowBadge.className = 'row-divider-badge';
      rowBadge.innerHTML = `<span class="badge-icon">${plusSvg}</span>`;
      container.appendChild(rowBadge);
    }

    return { container, colLine, colBadge, rowLine, rowBadge };
  }

  onMouseMove(e) {
    const els = this.getElements();
    if (!els) return;

    // 1. 拖拽排序中，或者处于单元格多选/鼠标框选中时，严格禁用加号分割线
    if (document.querySelector('.col-handle-btn.dragging, .row-handle-btn.dragging')) {
      this.hideAll(els);
      return;
    }

    const selectionMgr = window.__interactiveTableApp?.selectionManager;
    if (selectionMgr && (selectionMgr.mode === 'RANGE_SELECTED' || selectionMgr.isMouseDown)) {
      this.hideAll(els);
      return;
    }

    // 2. 实时瞬时移动速度计算 (px/ms)
    const now = performance.now();
    let speed = 0;
    if (this.lastTime !== null && this.lastX !== null && this.lastY !== null) {
      const dt = now - this.lastTime;
      if (dt > 0) {
        const dist = Math.hypot(e.clientX - this.lastX, e.clientY - this.lastY);
        speed = dist / dt;
      }
    }
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastTime = now;

    // 3. 速度感知抑制门限：当鼠标快速掠过 (speed > 0.75 px/ms) 时，
    // 立即隐藏并压制计算，防止灰蓝分割线瞬时满天飞
    if (speed > 0.75) {
      this.isFastMoving = true;
      this.hideAll(els);
      clearTimeout(this.dwellTimer);
      this.dwellTimer = setTimeout(() => {
        this.isFastMoving = false;
        this.evaluateDivider(e, els);
      }, 50);
      return;
    }

    if (this.isFastMoving) {
      clearTimeout(this.dwellTimer);
      this.dwellTimer = setTimeout(() => {
        this.isFastMoving = false;
        this.evaluateDivider(e, els);
      }, 50);
      return;
    }

    this.evaluateDivider(e, els);
  }

  evaluateDivider(e, els) {
    const table = this.root.querySelector('.notion-table');
    if (!table) return;

    const container = els.container;
    const cRect = container.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const mouseX = e.clientX;
    const mouseY = e.clientY;

    const padding = 20;
    if (
      mouseX < tableRect.left - padding ||
      mouseX > tableRect.right + padding ||
      mouseY < tableRect.top - padding ||
      mouseY > tableRect.bottom + padding
    ) {
      this.hideAll(els);
      return;
    }

    const topBorderCenterY = (tableRect.top + 0.5) - cRect.top;
    const leftBorderCenterX = (tableRect.left + 0.5) - cRect.left;

    // 探测列垂直分割线 (严格测量两列之间的几何中线，无舍入误差)
    const headerCells = this.getHeaderCells(table);
    let nearestCol = null;
    let minColDist = Infinity;

    headerCells.forEach((th, idx) => {
      if (idx < headerCells.length - 1) {
        const nextTh = headerCells[idx + 1];
        const r1 = th.getBoundingClientRect();
        const r2 = nextTh.getBoundingClientRect();
        const dividerX = (r1.right + r2.left) / 2;
        const dist = Math.abs(mouseX - dividerX);

        if (dist < minColDist) {
          minColDist = dist;
          nearestCol = {
            index: idx + 1,
            x: dividerX - cRect.left,
            dist
          };
        }
      }
    });

    // 探测行水平分割线 (严格测量两行之间的几何中线，无舍入误差)
    const rows = Array.from(table.querySelectorAll('tr'));
    let nearestRow = null;
    let minRowDist = Infinity;
    const hasHeaderRow = this.state.get().hasHeaderRow;

    rows.forEach((tr, idx) => {
      if (idx < rows.length - 1) {
        const nextTr = rows[idx + 1];
        const r1 = tr.getBoundingClientRect();
        const r2 = nextTr.getBoundingClientRect();
        const dividerY = (r1.bottom + r2.top) / 2;
        const dist = Math.abs(mouseY - dividerY);

        if (dist < minRowDist) {
          minRowDist = dist;
          const targetIndex = hasHeaderRow ? idx : idx + 1;
          nearestRow = {
            index: targetIndex,
            y: dividerY - cRect.top,
            dist
          };
        }
      }
    });

    if (nearestCol && minColDist <= 16 && minColDist <= minRowDist) {
      this.activeColDivider = nearestCol;
      this.activeRowDivider = null;

      els.rowLine.className = 'row-divider-line';
      els.rowBadge.className = 'row-divider-badge';

      els.colBadge.style.left = `${nearestCol.x}px`;
      els.colBadge.style.top = `${topBorderCenterY}px`;
      els.colLine.style.left = `${nearestCol.x}px`;

      if (nearestCol.dist <= 4) {
        els.colBadge.className = 'col-divider-badge blue';
        els.colLine.className = 'col-divider-line blue';
      } else {
        els.colBadge.className = 'col-divider-badge gray';
        els.colLine.className = 'col-divider-line gray';
      }
      return;
    }

    if (nearestRow && minRowDist <= 16) {
      this.activeRowDivider = nearestRow;
      this.activeColDivider = null;

      els.colLine.className = 'col-divider-line';
      els.colBadge.className = 'col-divider-badge';

      els.rowBadge.style.top = `${nearestRow.y}px`;
      els.rowBadge.style.left = `${leftBorderCenterX}px`;
      els.rowLine.style.top = `${nearestRow.y}px`;

      if (nearestRow.dist <= 4) {
        els.rowBadge.className = 'row-divider-badge blue';
        els.rowLine.className = 'row-divider-line blue';
      } else {
        els.rowBadge.className = 'row-divider-badge gray';
        els.rowLine.className = 'row-divider-line gray';
      }
      return;
    }

    this.hideAll(els);
  }

  onMouseDown(e) {
    const isColHit = e.target.closest('.col-divider-badge, .col-divider-line') || (this.activeColDivider && this.activeColDivider.dist <= 4);
    const isRowHit = e.target.closest('.row-divider-badge, .row-divider-line') || (this.activeRowDivider && this.activeRowDivider.dist <= 4);

    if (isColHit || isRowHit) {
      // 阻止单元格获得焦点或选区拦截
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }

  onClick(e) {
    const isColHit = e.target.closest('.col-divider-badge, .col-divider-line') || (this.activeColDivider && this.activeColDivider.dist <= 4);
    const isRowHit = e.target.closest('.row-divider-badge, .row-divider-line') || (this.activeRowDivider && this.activeRowDivider.dist <= 4);

    if (isColHit && this.activeColDivider) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const insertIdx = this.activeColDivider.index;
      this.hideAll(this.getElements());
      this.state.insertColumn(insertIdx);
      return;
    }

    if (isRowHit && this.activeRowDivider) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const insertIdx = this.activeRowDivider.index;
      this.hideAll(this.getElements());
      this.state.insertRow(insertIdx);
      return;
    }
  }

  onMouseLeave() {
    clearTimeout(this.dwellTimer);
    this.isFastMoving = false;
    this.lastTime = null;
    this.hideAll(this.getElements());
  }

  hideAll(els) {
    if (!els) return;
    this.activeColDivider = null;
    this.activeRowDivider = null;
    if (els.colLine) els.colLine.className = 'col-divider-line';
    if (els.colBadge) els.colBadge.className = 'col-divider-badge';
    if (els.rowLine) els.rowLine.className = 'row-divider-line';
    if (els.rowBadge) els.rowBadge.className = 'row-divider-badge';
  }
};
