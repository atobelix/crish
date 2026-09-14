/**
 * clipboard-manager.js - TSV 剪贴板无缝互通管理器 (Excel / Word / Google Sheets / Notion 100% 互通)
 * 1. 复制 (Copy, Ctrl+C / Cmd+C):
 *    - 处于多单元格框选态 (RANGE_SELECTED): 将选区范围序列化为标准 TSV (Tab 分隔列，CRLF 分隔行)
 *    - 处于单单元格聚焦态 (CELL_SELECTED): 将当前单元格内容格式化写入剪贴板
 *    - 处于整表选中态: 将全表表头与数据行完整序列化导出
 *    - 处于文字编辑态 (CELL_EDITING): 若有划选文字则原生放行；若无划选文字则完整复制该单元格
 * 2. 剪切 (Cut, Ctrl+X / Cmd+X):
 *    - 复制 TSV 内容，并同时批量清空选中范围单元格
 * 3. 粘贴 (Paste, Ctrl+V / Cmd+V):
 *    - 深度解析 TSV 数据 (遵循 RFC 4180 双引号转义规范、\t 列分界、\r\n 行分界)
 *    - 动态判定粘贴基准起点 (选区左上角单元格)
 *    - 自动容量扩展 (Auto Expansion): 自动探测粘贴矩阵规模，按需无感扩增行列数
 *    - 原子批处理写入: 启动历史快照 (pushHistory)，原子更新矩阵并触发重绘
 *    - 粘贴完成后自动选中被覆盖的数据矩形框，交互手感与 Excel / Notion 完全一致
 */

window.InteractiveTable = window.InteractiveTable || {};

window.InteractiveTable.ClipboardManager = class ClipboardManager {
  constructor(state, rootElement, selectionManager) {
    this.state = state;
    this.root = rootElement;
    this.selectionManager = selectionManager;

    this.onCopy = this.onCopy.bind(this);
    this.onCut = this.onCut.bind(this);
    this.onPaste = this.onPaste.bind(this);

    this.bindEvents();
  }

  bindEvents() {
    document.addEventListener('copy', this.onCopy);
    document.addEventListener('cut', this.onCut);
    document.addEventListener('paste', this.onPaste);
  }

  // ------------------------- TSV 序列化与反序列化 -------------------------

  /**
   * 将二维数组矩阵序列化为符合 Excel / Sheets 规范的 TSV 纯文本
   */
  serializeTSV(matrix) {
    if (!matrix || matrix.length === 0) return '';
    return matrix.map(row => {
      return row.map(cell => {
        const val = (cell !== null && cell !== undefined) ? String(cell) : '';
        // 包含 Tab、换行符或双引号时，使用 RFC 4180 标准双引号包裹并转义
        if (val.includes('\t') || val.includes('\n') || val.includes('\r') || val.includes('"')) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      }).join('\t');
    }).join('\r\n');
  }

  /**
   * 解析由 Excel、Word、Sheets 或本表格复制的 TSV 格式文本
   * 严谨解析包含内部换行与引号转义的复合复杂单元格
   */
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
          i++; // 跳过转义双引号
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

    // 剔除由剪贴板末尾换行符可能引发的伪空行
    if (rows.length > 1) {
      const lastRow = rows[rows.length - 1];
      if (lastRow.length === 1 && lastRow[0] === '') {
        rows.pop();
      }
    }

    return rows;
  }

  // ------------------------- 复制 (Copy) -------------------------

  onCopy(e) {
    const activeEl = document.activeElement;
    const isInsideTable = this.root.contains(activeEl) || (this.selectionManager.mode !== 'NONE' && this.selectionManager.mode !== undefined);
    if (!isInsideTable) return;

    const selMgr = this.selectionManager;

    // 1. 如果处于文字输入编辑态：若用户划选了部分文本，放行原生文本复制
    if (selMgr.mode === 'CELL_EDITING') {
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return; // 原生划选文字复制
      }
    }

    // 2. 提取当前选区数据矩阵
    let matrix = null;
    const stateData = this.state.get();

    if (selMgr.mode === 'RANGE_SELECTED' && selMgr.selectedRange) {
      const { minR, maxR, minC, maxC } = selMgr.selectedRange;
      matrix = [];
      for (let r = minR; r <= maxR; r++) {
        const rowData = [];
        for (let c = minC; c <= maxC; c++) {
          if (r === -1) {
            rowData.push(stateData.headers[c] || '');
          } else if (stateData.rows[r]) {
            rowData.push(stateData.rows[r].cells[c] || '');
          } else {
            rowData.push('');
          }
        }
        matrix.push(rowData);
      }
    } else if (selMgr.activeCell) {
      const { row, col, isHeader } = selMgr.activeCell;
      const val = isHeader ? (stateData.headers[col] || '') : (stateData.rows[row]?.cells[col] || '');
      matrix = [[val]];
    }

    if (!matrix || matrix.length === 0) return;

    const tsvData = this.serializeTSV(matrix);
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', tsvData);
      e.preventDefault();
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(tsvData);
      e.preventDefault();
    }
  }

  // ------------------------- 剪切 (Cut) -------------------------

  onCut(e) {
    const selMgr = this.selectionManager;
    if (selMgr.mode === 'CELL_EDITING') {
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return; // 原生编辑态剪切
      }
    }

    // 执行复制
    this.onCopy(e);

    // 清空对应单元格
    if (selMgr.mode === 'RANGE_SELECTED' && selMgr.selectedRange) {
      const { minR, maxR, minC, maxC } = selMgr.selectedRange;
      this.state.clearCellsRange(minR, maxR, minC, maxC);
    } else if (selMgr.activeCell) {
      const { row, col, isHeader } = selMgr.activeCell;
      this.state.updateCell(row, col, '', isHeader);
    }
  }

  // ------------------------- 粘贴 (Paste) -------------------------

  onPaste(e) {
    const clipboardText = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!clipboardText) return;

    const selMgr = this.selectionManager;
    if (!selMgr) return;

    // 如果处于文字编辑模式
    if (selMgr.mode === 'CELL_EDITING') {
      // 若粘贴文本不包含制表符且不包含换行，属于普通纯文本插入，放行原生输入
      if (!clipboardText.includes('\t') && !clipboardText.includes('\n') && !clipboardText.includes('\r')) {
        return;
      }
      // 否则说明用户将 Excel 的表格块贴入了单元格内，退出编辑态并无缝转为矩阵扩展粘贴
      selMgr.exitEditing();
    }

    // 确定粘贴起始位置 (基准左上角单元格)
    let startRow = 0;
    let startCol = 0;

    if (selMgr.mode === 'RANGE_SELECTED' && selMgr.selectedRange) {
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

    // 解析 TSV 矩阵并执行原子批量填充
    const matrix = this.parseTSV(clipboardText);
    if (!matrix || matrix.length === 0) return;

    const { endRow, endCol } = this.state.batchUpdateMatrix(startRow, startCol, matrix);

    // 粘贴完成后，智能选中被覆盖的矩形数据区域
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
