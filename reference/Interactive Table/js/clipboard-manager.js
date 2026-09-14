/**
 * clipboard-manager.js - TSV 剪贴板无缝互通管理器 (Excel / Word / Google Sheets / Notion 100% 互通)
 * 核心架构设计：
 * 1. 键盘直接捕获 (Keydown Gating):
 *    因表格设置了 user-select: none，原生无选中文本时浏览器不会触发 copy 事件。
 *    因此必须在 keydown 阶段主动拦截 Ctrl+C / Cmd+C 与 Ctrl+X / Cmd+X。
 * 2. 双通道无损写入系统剪贴板:
 *    - 通道 A: 动态隐藏只读 Textarea + textarea.select() + document.execCommand('copy')
 *      可在包括 file:/// 本地协议、各大浏览器无安全上下文提示下 100% 同步写入。
 *    - 通道 B: navigator.clipboard.writeText(tsv) 现代并发通道。
 * 3. 复制到 Excel:
 *    - 列以制表符 \t 分隔，行以 \r\n 分隔，符合 RFC 4180 双引号转义标准。
 *    - 粘贴至 Excel / Word / Sheets 时无缝对齐对应单元格矩阵。
 * 4. 从 Excel 粘贴进表格:
 *    - paste 事件提取 clipboardData.getData('text/plain')。
 *    - 自动容量扩展 (Auto Expansion): 按需无感扩增行列。
 *    - 原子事务更新 (pushHistory) 与无损单步 Ctrl+Z 撤销。
 */

window.InteractiveTable = window.InteractiveTable || {};

window.InteractiveTable.ClipboardManager = class ClipboardManager {
  constructor(state, rootElement, selectionManager) {
    this.state = state;
    this.root = rootElement;
    this.selectionManager = selectionManager;

    this.onKeyDown = this.onKeyDown.bind(this);
    this.onCopy = this.onCopy.bind(this);
    this.onCut = this.onCut.bind(this);
    this.onPaste = this.onPaste.bind(this);

    this.bindEvents();
  }

  bindEvents() {
    // 关键：必须在 keydown 捕获阶段主动拦截 Ctrl+C / Ctrl+X，突破 user-select:none 导致浏览器不派发 copy 的限制
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('copy', this.onCopy);
    document.addEventListener('cut', this.onCut);
    document.addEventListener('paste', this.onPaste);
  }

  // ------------------------- 数据矩阵提取 -------------------------

  getSelectedMatrix() {
    const selMgr = this.selectionManager;
    const stateData = this.state.get();

    // 1. 如果有选区范围 (单单元格或多单元格矩形选区)
    if (selMgr.selectedRange) {
      const { minR, maxR, minC, maxC } = selMgr.selectedRange;
      const matrix = [];
      for (let r = minR; r <= maxR; r++) {
        const rowData = [];
        for (let c = minC; c <= maxC; c++) {
          if (r === -1) {
            rowData.push(stateData.headers[c] !== undefined ? String(stateData.headers[c]) : '');
          } else if (stateData.rows[r]) {
            rowData.push(stateData.rows[r].cells[c] !== undefined ? String(stateData.rows[r].cells[c]) : '');
          } else {
            rowData.push('');
          }
        }
        matrix.push(rowData);
      }
      return matrix;
    }

    // 2. 如果当前聚焦单个单元格
    if (selMgr.activeCell) {
      const { row, col, isHeader } = selMgr.activeCell;
      const val = isHeader
        ? (stateData.headers[col] !== undefined ? String(stateData.headers[col]) : '')
        : (stateData.rows[row]?.cells[col] !== undefined ? String(stateData.rows[row].cells[col]) : '');
      return [[val]];
    }

    // 3. 检查是否有当前聚焦或选中的 DOM 单元格兜底
    const activeCellEl = this.root.querySelector('.cell-focused, .cell-selected');
    if (activeCellEl) {
      const isHeader = activeCellEl.tagName.toLowerCase() === 'th';
      const row = isHeader ? -1 : parseInt(activeCellEl.dataset.row, 10);
      const col = parseInt(activeCellEl.dataset.col, 10);
      const val = isHeader
        ? (stateData.headers[col] !== undefined ? String(stateData.headers[col]) : '')
        : (stateData.rows[row]?.cells[col] !== undefined ? String(stateData.rows[row].cells[col]) : '');
      return [[val]];
    }

    return null;
  }

  // ------------------------- TSV 序列化与反序列化 -------------------------

  serializeTSV(matrix) {
    if (!matrix || matrix.length === 0) return '';
    return matrix.map(row => {
      return row.map(cell => {
        const val = (cell !== null && cell !== undefined) ? String(cell) : '';
        if (val.includes('\t') || val.includes('\n') || val.includes('\r') || val.includes('"')) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      }).join('\t');
    }).join('\r\n');
  }

  parseTSV(text) {
    if (!text || typeof text !== 'string') return [];

    const rows = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const nextCh = text[i + 1];

      if (inQuotes) {
        if (ch === '"' && nextCh === '"') {
          currentField += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          currentField += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === '\t') {
          currentRow.push(currentField);
          currentField = '';
        } else if (ch === '\r') {
          if (nextCh === '\n') i++;
          currentRow.push(currentField);
          rows.push(currentRow);
          currentRow = [];
          currentField = '';
        } else if (ch === '\n') {
          currentRow.push(currentField);
          rows.push(currentRow);
          currentRow = [];
          currentField = '';
        } else {
          currentField += ch;
        }
      }
    }

    if (currentField !== '' || currentRow.length > 0) {
      currentRow.push(currentField);
      rows.push(currentRow);
    }

    if (rows.length > 1) {
      const lastRow = rows[rows.length - 1];
      if (lastRow.length === 1 && lastRow[0] === '') {
        rows.pop();
      }
    }

    return rows;
  }

  // ------------------------- 写入系统剪贴板核心通道 -------------------------

  writeToClipboard(text) {
    if (!text && text !== '') return false;

    let success = false;

    // 通道 1: 隐藏临时文本域 + document.execCommand('copy')
    // 行业标准实践，即使在 file:/// 本地协议也能 100% 同步成功
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    textarea.setAttribute('readonly', '');
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    try {
      success = document.execCommand('copy');
    } catch (err) {
      console.warn('execCommand copy warning:', err);
    }
    document.body.removeChild(textarea);

    // 通道 2: 现代异步 API 并发保障
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }

    return success;
  }

  // ------------------------- 复制视觉反馈 -------------------------

  flashCopyFeedback() {
    const rangeBox = document.querySelector('.selection-range-box');
    if (rangeBox && rangeBox.style.display !== 'none') {
      rangeBox.classList.remove('clipboard-flash');
      void rangeBox.offsetWidth;
      rangeBox.classList.add('clipboard-flash');
    } else {
      const cells = document.querySelectorAll('.cell-focused, .cell-selected');
      cells.forEach(c => {
        c.classList.remove('clipboard-flash');
        void c.offsetWidth;
        c.classList.add('clipboard-flash');
      });
    }
  }

  // ------------------------- 键盘事件拦截 (Keydown) -------------------------

  onKeyDown(e) {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const isCtrl = isMac ? e.metaKey : e.ctrlKey;
    if (!isCtrl) return;

    const key = e.key.toLowerCase();

    // 1. Ctrl+C (复制)
    if (key === 'c' && !e.shiftKey && !e.altKey) {
      // 若处于文字编辑状态且划选了具体文字，放行原生划选复制
      if (this.selectionManager.mode === 'CELL_EDITING') {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
      }

      const matrix = this.getSelectedMatrix();
      if (!matrix || matrix.length === 0) return;

      e.preventDefault();
      e.stopPropagation();

      const tsv = this.serializeTSV(matrix);
      this.writeToClipboard(tsv);
      this.flashCopyFeedback();
      return;
    }

    // 2. Ctrl+X (剪切)
    if (key === 'x' && !e.shiftKey && !e.altKey) {
      if (this.selectionManager.mode === 'CELL_EDITING') {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
      }

      const matrix = this.getSelectedMatrix();
      if (!matrix || matrix.length === 0) return;

      e.preventDefault();
      e.stopPropagation();

      const tsv = this.serializeTSV(matrix);
      this.writeToClipboard(tsv);
      this.flashCopyFeedback();

      if (this.selectionManager.selectedRange) {
        const { minR, maxR, minC, maxC } = this.selectionManager.selectedRange;
        this.state.clearCellsRange(minR, maxR, minC, maxC);
      } else if (this.selectionManager.activeCell) {
        const { row, col, isHeader } = this.selectionManager.activeCell;
        this.state.updateCell(row, col, '', isHeader);
      }
      return;
    }
  }

  // ------------------------- 浏览器原生事件兜底 (Copy & Cut) -------------------------

  onCopy(e) {
    if (this.selectionManager.mode === 'CELL_EDITING') {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
    }

    const matrix = this.getSelectedMatrix();
    if (!matrix || matrix.length === 0) return;

    const tsv = this.serializeTSV(matrix);
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', tsv);
      e.preventDefault();
    }
    this.flashCopyFeedback();
  }

  onCut(e) {
    if (this.selectionManager.mode === 'CELL_EDITING') {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
    }

    const matrix = this.getSelectedMatrix();
    if (!matrix || matrix.length === 0) return;

    const tsv = this.serializeTSV(matrix);
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', tsv);
      e.preventDefault();
    }
    this.flashCopyFeedback();

    if (this.selectionManager.selectedRange) {
      const { minR, maxR, minC, maxC } = this.selectionManager.selectedRange;
      this.state.clearCellsRange(minR, maxR, minC, maxC);
    } else if (this.selectionManager.activeCell) {
      const { row, col, isHeader } = this.selectionManager.activeCell;
      this.state.updateCell(row, col, '', isHeader);
    }
  }

  // ------------------------- 粘贴 (Paste) -------------------------

  onPaste(e) {
    let clipboardText = '';
    if (e.clipboardData) {
      clipboardText = e.clipboardData.getData('text/plain');
    }
    if (!clipboardText) return;

    const selMgr = this.selectionManager;
    if (!selMgr) return;

    // 单元格编辑态处理
    if (selMgr.mode === 'CELL_EDITING') {
      // 普通纯文本放行原生文本录入
      if (!clipboardText.includes('\t') && !clipboardText.includes('\n') && !clipboardText.includes('\r')) {
        return;
      }
      // 包含表格制表符时：退出编辑态，转为表格矩阵扩展粘贴
      selMgr.exitEditing();
    }

    // 确定粘贴基准起始点
    let startRow = 0;
    let startCol = 0;

    if (selMgr.selectedRange) {
      startRow = selMgr.selectedRange.minR;
      startCol = selMgr.selectedRange.minC;
    } else if (selMgr.activeCell) {
      startRow = selMgr.activeCell.row;
      startCol = selMgr.activeCell.col;
    } else {
      const activeCell = document.activeElement?.closest('td, th');
      if (activeCell) {
        const info = selMgr.getCellInfo(activeCell);
        if (info) {
          startRow = info.row;
          startCol = info.col;
        } else {
          return;
        }
      } else {
        return;
      }
    }

    e.preventDefault();

    const matrix = this.parseTSV(clipboardText);
    if (!matrix || matrix.length === 0) return;

    const { endRow, endCol } = this.state.batchUpdateMatrix(startRow, startCol, matrix);

    requestAnimationFrame(() => {
      if (startRow === endRow && startCol === endCol) {
        selMgr.selectSingleCell({ row: startRow, col: startCol, isHeader: startRow === -1 });
      } else {
        selMgr.mode = 'RANGE_SELECTED';
        selMgr.updateRangeSelection(startRow, endRow, startCol, endCol);
      }
    });
  }
};
