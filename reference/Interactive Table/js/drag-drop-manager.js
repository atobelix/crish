/**
 * drag-drop-manager.js - 行列手柄所见即所得 (WYSIWYG) 拖拽排序管理器
 * 严格按照用户需求打磨：
 * 1. 移除卡片阴影，保持纯净 1:1 质感。
 * 2. 槽位贯穿落点指示线 (.drag-slot-line-vertical / .drag-slot-line-horizontal)：
 *    精准标识落在哪两列或哪两行之间，上下/左右带锚点圆帽。
 * 3. 动态物理避让 (Column/Row Displacement)：
 *    拖拽时光标悬停的缝隙两侧元素产生向外轻微避让位移，空间感与落点清晰明了。
 * 4. 释放鼠标：完成数据重排与重绘。
 */

window.InteractiveTable = window.InteractiveTable || {};

window.InteractiveTable.DragDropManager = class DragDropManager {
  constructor(state, rootElement, contextMenu) {
    this.state = state;
    this.root = rootElement;
    this.contextMenu = contextMenu;

    this.dragType = null; // 'COLUMN' | 'ROW'
    this.fromIndex = null;
    this.targetSlot = null; // 目标缝隙索引 0 .. N
    this.activeHandle = null;

    this.isDragging = false;
    this.justDragged = false;
    this.startX = 0;
    this.startY = 0;
    this.grabOffsetX = 0;
    this.grabOffsetY = 0;

    this.floatingProxy = null;
    this.slotLine = null;

    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);

    this.bindEvents();
  }

  bindEvents() {
    this.root.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', this.onMouseUp);
  }

  getHeaderCells(table) {
    const ths = table.querySelectorAll('thead th');
    if (ths.length > 0) return Array.from(ths);
    return Array.from(table.querySelectorAll('tbody tr:first-child td'));
  }

  getSlotLine() {
    const container = this.root.querySelector('.table-content-area');
    if (!container) return null;

    if (!this.slotLine || !container.contains(this.slotLine)) {
      this.slotLine = document.createElement('div');
      container.appendChild(this.slotLine);
    }
    return this.slotLine;
  }

  onMouseDown(e) {
    const colBtn = e.target.closest('.col-handle-btn');
    const rowBtn = e.target.closest('.row-handle-btn');

    if (!colBtn && !rowBtn) return;

    // 表头行 (row = -1) 不支持拖拽重排
    if (rowBtn && parseInt(rowBtn.dataset.row, 10) < 0) return;

    e.preventDefault();

    this.startX = e.clientX;
    this.startY = e.clientY;
    this.isDragging = false;

    if (colBtn) {
      this.dragType = 'COLUMN';
      this.fromIndex = parseInt(colBtn.dataset.col, 10);
      this.targetSlot = this.fromIndex;
      this.activeHandle = colBtn;
    } else if (rowBtn) {
      this.dragType = 'ROW';
      this.fromIndex = parseInt(rowBtn.dataset.row, 10);
      this.targetSlot = this.fromIndex;
      this.activeHandle = rowBtn;
    }
  }

  onMouseMove(e) {
    if (!this.dragType || !this.activeHandle) return;

    const deltaX = Math.abs(e.clientX - this.startX);
    const deltaY = Math.abs(e.clientY - this.startY);

    // 位移阈值 3px：判定为真实拖拽行为
    if (!this.isDragging && (deltaX > 3 || deltaY > 3)) {
      this.startDrag(e);
    }

    if (!this.isDragging) return;

    // 1. 同步更新跟随鼠标的浮动镜像坐标
    if (this.floatingProxy) {
      this.floatingProxy.style.left = `${Math.round(e.clientX - this.grabOffsetX)}px`;
      this.floatingProxy.style.top = `${Math.round(e.clientY - this.grabOffsetY)}px`;
    }

    // 2. 实时探测目标缝隙 (Slot) 并渲染贯穿落点指示线与物理避让
    const table = this.root.querySelector('.notion-table');
    if (!table) return;

    const slotLine = this.getSlotLine();
    if (!slotLine) return;

    if (this.dragType === 'COLUMN') {
      this.updateColumnSlot(e, table, slotLine);
    } else if (this.dragType === 'ROW') {
      this.updateRowSlot(e, table, slotLine);
    }
  }

  startDrag(e) {
    this.isDragging = true;
    this.contextMenu?.close();
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    document.body.classList.add('is-dragging-table');

    // 拖拽激活时：原手柄完全隐去，视觉焦点聚焦在跟随鼠标的虚拟 DOM 上
    if (this.activeHandle) {
      this.activeHandle.style.opacity = '0';
      this.activeHandle.style.pointerEvents = 'none';
    }
    this.applyGhost(true);

    const table = this.root.querySelector('.notion-table');
    if (!table) return;

    this.createFloatingProxy(e, table);
  }

  createFloatingProxy(e, table) {
    if (this.floatingProxy) {
      this.floatingProxy.remove();
      this.floatingProxy = null;
    }

    const data = this.state.get();
    const tableRect = table.getBoundingClientRect();
    const proxy = document.createElement('div');
    proxy.className = 'drag-floating-proxy';

    const TableState = window.InteractiveTable.TableState;

    if (this.dragType === 'COLUMN') {
      const headerCells = this.getHeaderCells(table);
      const sourceTh = headerCells[this.fromIndex];
      if (!sourceTh) return;

      const thRect = sourceTh.getBoundingClientRect();
      const colWidth = thRect.width;

      this.grabOffsetX = this.startX - thRect.left;
      this.grabOffsetY = this.startY - thRect.top;

      const rawHeader = data.headers[this.fromIndex];
      const headerVal = TableState ? TableState.getCellValue(rawHeader) : String(rawHeader || '');

      let theadHtml = '';
      if (data.hasHeaderRow) {
        theadHtml = `
          <thead>
            <tr style="height: ${sourceTh.offsetHeight}px;">
              <th style="width: ${colWidth}px; height: ${sourceTh.offsetHeight}px;">
                ${headerVal}
              </th>
            </tr>
          </thead>
        `;
      }

      const tbodyHtml = `
        <tbody>
          ${data.rows.map((row, rIdx) => {
            const td = table.querySelector(`tbody tr[data-row="${rIdx}"] td[data-col="${this.fromIndex}"]`);
            const h = td ? td.offsetHeight : 52;
            const rawCell = row.cells[this.fromIndex];
            const cellVal = TableState ? TableState.getCellValue(rawCell) : String(rawCell || '');
            return `
              <tr style="height: ${h}px;">
                <td style="width: ${colWidth}px; height: ${h}px;">
                  ${cellVal}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      `;

      proxy.innerHTML = `
        <div class="proxy-capsule-handle proxy-capsule-col">
          <div class="handle-capsule dragging">
            <div class="handle-dots">
              <span class="dot"></span>
              <span class="dot"></span>
              <span class="dot"></span>
            </div>
          </div>
        </div>
        <table>
          <colgroup><col style="width: ${colWidth}px;"></colgroup>
          ${theadHtml}
          ${tbodyHtml}
        </table>
      `;

      proxy.style.width = `${Math.round(colWidth)}px`;
      proxy.style.height = `${Math.round(tableRect.height)}px`;
      proxy.style.left = `${Math.round(e.clientX - this.grabOffsetX)}px`;
      proxy.style.top = `${Math.round(e.clientY - this.grabOffsetY)}px`;

    } else if (this.dragType === 'ROW') {
      const tr = table.querySelector(`tbody tr[data-row="${this.fromIndex}"]`);
      if (!tr) return;

      const trRect = tr.getBoundingClientRect();
      const rowHeight = trRect.height;
      const colWidths = Array.from(tr.children).map(td => td.getBoundingClientRect().width);

      this.grabOffsetX = this.startX - trRect.left;
      this.grabOffsetY = this.startY - trRect.top;

      proxy.innerHTML = `
        <div class="proxy-capsule-handle proxy-capsule-row">
          <div class="handle-capsule dragging">
            <div class="handle-dots">
              <span class="dot"></span>
              <span class="dot"></span>
              <span class="dot"></span>
            </div>
          </div>
        </div>
        <table>
          <colgroup>
            ${colWidths.map(w => `<col style="width: ${w}px;">`).join('')}
          </colgroup>
          <tbody>
            <tr style="height: ${rowHeight}px;">
              ${data.rows[this.fromIndex].cells.map((rawCell, cIdx) => {
                const cellVal = TableState ? TableState.getCellValue(rawCell) : String(rawCell || '');
                return `<td style="width: ${colWidths[cIdx]}px; height: ${rowHeight}px;">${cellVal}</td>`;
              }).join('')}
            </tr>
          </tbody>
        </table>
      `;

      proxy.style.width = `${Math.round(tableRect.width)}px`;
      proxy.style.height = `${Math.round(rowHeight)}px`;
      proxy.style.left = `${Math.round(e.clientX - this.grabOffsetX)}px`;
      proxy.style.top = `${Math.round(e.clientY - this.grabOffsetY)}px`;
    }

    document.body.appendChild(proxy);
    this.floatingProxy = proxy;
  }

  updateColumnSlot(e, table, slotLine) {
    const headerCells = this.getHeaderCells(table);
    const tableRect = table.getBoundingClientRect();
    const mouseX = e.clientX;
    const n = headerCells.length;

    // 计算各列的中心点与边缘边界
    const midPoints = headerCells.map(th => {
      const r = th.getBoundingClientRect();
      return r.left + r.width / 2;
    });

    // 智能判定落在哪两列缝隙之间 (Slot 0 .. N)
    let slot = 0;
    if (mouseX < midPoints[0]) {
      slot = 0;
    } else if (mouseX >= midPoints[n - 1]) {
      slot = n;
    } else {
      for (let i = 1; i < n; i++) {
        if (mouseX >= midPoints[i - 1] && mouseX < midPoints[i]) {
          slot = i;
          break;
        }
      }
    }

    this.targetSlot = slot;

    // 计算槽位垂直缝线的精确 X 坐标 (严格居中对齐两列缝隙中线)
    let slotX = 0;
    if (slot === 0) {
      slotX = 0;
    } else if (slot === n) {
      slotX = tableRect.width;
    } else {
      const leftCell = headerCells[slot - 1];
      const rightCell = headerCells[slot];
      slotX = (leftCell.getBoundingClientRect().right + rightCell.getBoundingClientRect().left) / 2 - tableRect.left;
    }

    // 绘制 3px 贯穿纯蓝落点指示线 (用户批注 media_1789395668453.png：纯靠引导线指示，不挤压多余空隙)
    slotLine.className = 'drag-slot-line-vertical';
    slotLine.style.display = 'block';
    slotLine.style.left = `${slotX}px`;
    slotLine.style.top = '0px';
    slotLine.style.height = `${tableRect.height}px`;
  }

  updateRowSlot(e, table, slotLine) {
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const tableRect = table.getBoundingClientRect();
    const mouseY = e.clientY;
    const m = rows.length;

    const midPoints = rows.map(tr => {
      const r = tr.getBoundingClientRect();
      return r.top + r.height / 2;
    });

    let slot = 0;
    if (mouseY < midPoints[0]) {
      slot = 0;
    } else if (mouseY >= midPoints[m - 1]) {
      slot = m;
    } else {
      for (let i = 1; i < m; i++) {
        if (mouseY >= midPoints[i - 1] && mouseY < midPoints[i]) {
          slot = i;
          break;
        }
      }
    }

    this.targetSlot = slot;

    // 计算槽位水平缝线的精确 Y 坐标 (严格居中对齐两行缝隙中线)
    let slotY = 0;
    if (slot === 0) {
      slotY = rows[0].getBoundingClientRect().top - tableRect.top;
    } else if (slot === m) {
      slotY = rows[m - 1].getBoundingClientRect().bottom - tableRect.top;
    } else {
      const topRow = rows[slot - 1];
      const bottomRow = rows[slot];
      slotY = (topRow.getBoundingClientRect().bottom + bottomRow.getBoundingClientRect().top) / 2 - tableRect.top;
    }

    // 绘制 3px 贯穿纯蓝落点指示线 (用户批注 media_1789395668453.png：纯靠引导线指示，不挤压多余空隙)
    slotLine.className = 'drag-slot-line-horizontal';
    slotLine.style.display = 'block';
    slotLine.style.left = '0px';
    slotLine.style.top = `${slotY}px`;
    slotLine.style.width = `${tableRect.width}px`;
  }

  clearDisplacements() {
    this.root.querySelectorAll('td, th, tr').forEach(el => {
      el.style.transform = '';
      el.style.transition = '';
    });
  }

  applyGhost(apply) {
    if (this.dragType === 'COLUMN') {
      const cells = this.root.querySelectorAll(`[data-col="${this.fromIndex}"]`);
      cells.forEach(c => {
        if (apply) c.classList.add('col-ghost');
        else c.classList.remove('col-ghost');
      });
    } else if (this.dragType === 'ROW') {
      const tr = this.root.querySelectorAll('tbody tr')[this.fromIndex];
      if (tr) {
        if (apply) tr.classList.add('row-ghost');
        else tr.classList.remove('row-ghost');
      }
    }
  }

  onMouseUp() {
    if (!this.dragType) return;

    if (this.isDragging) {
      this.clearDisplacements();
      this.applyGhost(false);
      this.justDragged = true;
      setTimeout(() => { this.justDragged = false; }, 200);

      const from = this.fromIndex;
      const slot = this.targetSlot;

      if (this.dragType === 'COLUMN' && from !== null && slot !== null) {
        let toIndex = from;
        if (slot < from) {
          toIndex = slot;
        } else if (slot > from + 1) {
          toIndex = slot - 1;
        }
        if (toIndex !== from) {
          this.state.reorderColumn(from, toIndex);
        }
      } else if (this.dragType === 'ROW' && from !== null && slot !== null) {
        let toIndex = from;
        if (slot < from) {
          toIndex = slot;
        } else if (slot > from + 1) {
          toIndex = slot - 1;
        }
        if (toIndex !== from && from >= 0 && toIndex >= 0) {
          this.state.reorderRow(from, toIndex);
        }
      }
    }

    if (this.activeHandle) {
      this.activeHandle.style.opacity = '';
      this.activeHandle.style.pointerEvents = '';
      this.activeHandle.classList.remove('active', 'dragging');
      this.activeHandle = null;
    }

    if (this.floatingProxy) {
      this.floatingProxy.remove();
      this.floatingProxy = null;
    }

    if (this.slotLine) {
      this.slotLine.style.display = 'none';
    }

    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.body.classList.remove('is-dragging-table');

    this.dragType = null;
    this.fromIndex = null;
    this.targetSlot = null;
    this.isDragging = false;
  }
};
