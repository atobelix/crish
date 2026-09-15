import React, { useEffect, useState } from 'react';
import {
  findTableRange,
  parseRowCells,
  setCellContent,
  insertRow,
  insertColumn,
  deleteRow,
  deleteColumn,
  clearCell,
  mergeSelectedCells,
  unmergeCells,
  setColumnAlign,
  type TableOperationResult,
  type TableRange,
} from '../core/TableOperations';
import { useTableStore } from '../core/TableStore';
import { useEditorStore, type EditorStore } from '../core/EditorStore';
import {
  lineToRow,
  selectionToLines,
  type RemapBounds,
  type TableStructOp,
} from '../core/tableSelection';
import {
  buildAutocompleteReplace,
  type AutocompleteCandidate,
} from '../core/autocomplete';
// Alcove 复刻（Seg C）：补全卡片行图标（wiki 文档 / 标签 / 成员）
import {
  FileText as FileTextIcon,
  Hash as HashIcon,
  AtSign as AtSignIcon,
} from 'lucide-react';

interface ContextMenuState {
  x: number;
  y: number;
  isEditing: boolean;
  tableId: string;
}

/** 自动补全菜单状态（HiddenInput 检测触发后经 open-autocomplete-menu
 *  事件投递；候选选择走 detail.store.applyChange 单步事务 + 精确落点） */
interface AutocompleteMenuState {
  x: number;
  y: number;
  /** 触发字符（如 '@'） */
  trigger: string;
  /** 触发字符后已输入部分（过滤用） */
  query: string;
  /** 触发字符的全局偏移（替换区间起点） */
  start: number;
  /** 光标全局偏移（替换区间终点） */
  cursorPos: number;
  /** 已过滤候选列表 */
  candidates: AutocompleteCandidate[];
  /** 触发时绑定的 store 实例（多实例安全；缺省回退全局单例） */
  store?: EditorStore;
}

/** 表内相对行数（分隔行不占行号）。 */
function rowCountOf(range: TableRange): number {
  return range.lines.length - (range.separatorLineIndex >= 0 ? 1 : 0);
}

/**
 * 表内相对**行下标** → 表内相对**行序**（分隔行不占行号）。
 * 经权威 `lineToRow` 折算，禁止本地 `startLine + row`（§3.1 唯一换算入口）。
 */
function relativeRowOf(range: TableRange, lineIdx: number): number | null {
  const start = range.startLineIndex;
  if (start === undefined) return null;
  const sep = range.separatorLineIndex >= 0 ? start + range.separatorLineIndex : null;
  return lineToRow(start + lineIdx, start, start + range.lines.length - 1, sep);
}

/**
 * 结构操作 → `applyStructOp` 入参（T5b / I7 重映射；坐标一律**表内相对**）。
 *
 * 位置来源（不新建第二套推导，`at` 即操作真正使用的插入位/删除位）：
 *   - 插入类：取操作**之后**的文本 + 操作自身落定的光标位置（`insertRow` 的
 *     `above`/`below` 特判、`insertColumn` 的 `left`/`right` 换算都在操作内部完成）；
 *   - 删除类：取操作**之前**的表区间（`deleteRow`/`deleteColumn` 直接以
 *     `activeLineIndex`/`activeCellIndex` 为删除下标）；
 *   - `bounds` 取操作**之后**的表行/列数（拿不到时不传，`remapSelection` 退化为不钳制）。
 * 非结构操作（对齐 / 清空 / 粘贴）返回 `null`。
 */
function structOpFor(
  action: string,
  table: TableRange,
  res: TableOperationResult
): { op: TableStructOp; bounds?: RemapBounds } | null {
  const afterRange = (): TableRange | null => findTableRange(res.newText, res.newCursorPos);
  switch (action) {
    case 'merge-cells':
      return { op: { kind: 'merge' } };
    case 'unmerge-cells':
      return { op: { kind: 'unmerge' } };
    case 'insert-row-above':
    case 'insert-row-below': {
      const after = afterRange();
      if (!after) return null;
      const at = relativeRowOf(after, after.activeLineIndex);
      if (at === null) return null;
      return {
        op: { kind: 'insertRow', at },
        bounds: { rows: rowCountOf(after), cols: after.columnCount },
      };
    }
    case 'insert-col-left':
    case 'insert-col-right': {
      const after = afterRange();
      if (!after) return null;
      // 新列占据操作落定光标所在的列下标
      return {
        op: { kind: 'insertCol', at: after.activeCellIndex },
        bounds: { rows: rowCountOf(after), cols: after.columnCount },
      };
    }
    case 'delete-row': {
      // 删到只剩 1 行 → TableOperations 整表删除（TableOperations.ts:245-250）
      if (table.lines.length <= 2) return { op: { kind: 'deleteTable' } };
      const at = relativeRowOf(table, table.activeLineIndex);
      if (at === null) return null;
      return {
        op: { kind: 'deleteRow', at },
        bounds: { rows: rowCountOf(table) - 1, cols: table.columnCount },
      };
    }
    case 'delete-col': {
      // 删到只剩 1 列 → TableOperations 整表删除（TableOperations.ts:323-328）
      if (table.columnCount <= 1) return { op: { kind: 'deleteTable' } };
      return {
        op: { kind: 'deleteCol', at: table.activeCellIndex },
        bounds: { rows: rowCountOf(table), cols: table.columnCount - 1 },
      };
    }
    default:
      return null;
  }
}

/**
 * 表格动作统一接线（B5 项 3）：
 * 菜单项 → TableOperations 纯函数（以全局 store 的文本/光标为输入）
 * → applyTableChange（表区间单事务替换 + 精确光标落点）→ 订阅自动刷新。
 * 说明：菜单事件由 InlineRenderer 的表格 cell onContextMenu 派发，
 * 未携带 store 实例——多实例场景下表格菜单仍走全局单例（与 B5 之前
 * 的 HiddenInput 表格操作同口径），多实例 + 表格菜单为协调登记点。
 */
function applyTableAction(
  action: string,
  onDone: () => void
): void {
  const state = useEditorStore.getState();
  const text = state.getText();
  const cursorPos = state.cursorPos;
  const finish = () => {
    // 菜单点击使隐藏 textarea 失焦，恢复焦点（现有行为保持）
    const input = document.querySelector('.hidden-input') as HTMLTextAreaElement | null;
    if (input) input.focus();
    onDone();
  };

  // 编辑模式动作（isEditing 菜单）
  if (action === 'copy') {
    const s = window.getSelection();
    if (s && !s.isCollapsed) {
      void navigator.clipboard.writeText(s.toString());
    }
    finish();
    return;
  }
  if (action === 'paste') {
    void navigator.clipboard.readText().then((clipText) => {
      if (!clipText) return;
      const s = useEditorStore.getState();
      s.applyChange(s.selectionStart, s.selectionEnd, clipText, { merge: 'none' });
    });
    finish();
    return;
  }
  if (action === 'copy-cell') {
    // 读源码行需文档绝对行号 → 经 `selectionToLines` 折算；null = 身份未观测过 → 视为无选区
    const lines = selectionToLines(useTableStore.getState().selectedCell);
    if (lines) {
      const editorState = useEditorStore.getState();
      const copiedRows: string[] = [];
      for (let r = lines.startLine; r <= lines.endLine; r++) {
        const lineText = editorState.getLine(r) ?? '';
        if (/^\|?[\s:-]*[-]+[\s:-]*\|/.test(lineText.trim())) continue;
        const { cells } = parseRowCells(lineText);
        const selectedRowCells: string[] = [];
        for (let c = lines.startCol; c <= lines.endCol; c++) {
          selectedRowCells.push((cells[c] || '').trim());
        }
        copiedRows.push(selectedRowCells.join('\t'));
      }
      if (copiedRows.length > 0) {
        void navigator.clipboard.writeText(copiedRows.join('\n'));
      }
    }
    finish();
    return;
  }
  if (action === 'paste-cell') {
    void navigator.clipboard.readText().then((clipText) => {
      if (!clipText) return;
      const curState = useEditorStore.getState();
      const res = setCellContent(curState.getText(), curState.cursorPos, clipText);
      if (res && res.newText !== curState.getText()) {
        curState.applyTableChange(0, curState.getText().length, res.newText, res.newCursorPos);
      }
    });
    finish();
    return;
  }
  if (['bold', 'italic'].includes(action)) {
    finish();
    return;
  }
  if (action === 'edit-cell') {
    const tableStore = useTableStore.getState();
    if (tableStore.selectedCell) tableStore.enterCellEdit();
    finish();
    return;
  }

  // 表格结构动作：定位表区间 → 纯函数变换 → applyTableChange 事务
  const table = findTableRange(text, cursorPos);
  if (!table) {
    finish();
    return;
  }
  let res: TableOperationResult | null = null;
  switch (action) {
    case 'merge-cells': {
      // 合并以绝对行号为输入 → `selectionToLines` 折算；null = 身份未观测过 → 不动作
      const lines = selectionToLines(useTableStore.getState().selectedCell);
      if (lines) {
        res = mergeSelectedCells(text, lines.startLine, lines.startCol, lines.endLine, lines.endCol);
      }
      break;
    }
    case 'unmerge-cells': {
      const lines = selectionToLines(useTableStore.getState().selectedCell);
      if (lines) {
        res = unmergeCells(text, lines.startLine, lines.startCol);
      }
      break;
    }
    case 'align-left':
    case 'align-center':
    case 'align-right': {
      const sel = useTableStore.getState().selectedCell;
      const align = action.replace('align-', '') as 'left' | 'center' | 'right';
      // 列下标与文档行号无关（列坐标系同源）：`anchor.col` 对应旧 `startCol`
      const col = sel?.anchor.col;
      res = setColumnAlign(text, cursorPos, align, col);
      if (sel && col !== undefined) {
        const curAligns = [...(useTableStore.getState().tableAlignments[sel.tableId] || [])];
        curAligns[col] = align;
        useTableStore.getState().setTableAlignments(sel.tableId, curAligns);
      }
      break;
    }
    case 'insert-row-above':
      res = insertRow(text, cursorPos, 'above');
      break;
    case 'insert-row-below':
      res = insertRow(text, cursorPos, 'below');
      break;
    case 'insert-col-left':
      res = insertColumn(text, cursorPos, 'left');
      break;
    case 'insert-col-right':
      res = insertColumn(text, cursorPos, 'right');
      break;
    case 'delete-row':
      res = deleteRow(text, cursorPos);
      break;
    case 'delete-col':
      res = deleteColumn(text, cursorPos);
      break;
    case 'clear-cell':
      res = clearCell(text, cursorPos);
      break;
    default:
      break;
  }
  if (!res || res.newText === text) {
    finish();
    return;
  }
  applyTableResult(text, state, table, res);
  // I7：结构操作**成功后**重映射选区（唯一入口；坐标一律表内相对）
  const remap = structOpFor(action, table, res);
  if (remap) useTableStore.getState().applyStructOp(remap.op, remap.bounds);
  finish();
}

/** 表格操作结果 → applyTableChange（表区间文本提取 + 单事务替换）：
 *  TableOperations 返回整文档 newText，按「表区间 + 长度差」切出
 *  表区间新文本（delete 整表时区间收敛为空字符串），替换 [startOffset,
 *  endOffset) 并精确落点光标——单步 undo，订阅自动刷新。 */
function applyTableResult(
  text: string,
  state: { applyTableChange: (from: number, to: number, insert: string, cursorAfter: number) => void },
  table: TableRange,
  res: TableOperationResult
): void {
  const delta = res.newText.length - text.length;
  const newTableText = res.newText.substring(table.startOffset, table.endOffset + delta);
  state.applyTableChange(table.startOffset, table.endOffset, newTableText, res.newCursorPos);
}

export const ContextMenu: React.FC = () => {
  const [menuState, setMenuState] = useState<ContextMenuState | null>(null);
  const [autocompleteState, setAutocompleteState] = useState<AutocompleteMenuState | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    const handleContextMenu = (e: Event) => {
      const customEvent = e as CustomEvent<ContextMenuState>;
      setMenuState(customEvent.detail);
      setAutocompleteState(null); // 两种菜单互斥
    };

    const closeMenu = () => {
      setMenuState(null);
    };

    // —— B5 自动补全菜单事件（HiddenInput 触发检测后派发）——
    const handleOpenAutocomplete = (e: Event) => {
      const detail = (e as CustomEvent<AutocompleteMenuState>).detail;
      setMenuState(null); // 两种菜单互斥
      setAutocompleteState(detail);
      setActiveIdx(0);
    };
    const handleCloseAutocomplete = () => {
      setAutocompleteState(null);
    };

    window.addEventListener('open-table-context-menu', handleContextMenu as EventListener);
    window.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu, { capture: true });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
    window.addEventListener('open-autocomplete-menu', handleOpenAutocomplete);
    window.addEventListener('close-autocomplete-menu', handleCloseAutocomplete);

    return () => {
      window.removeEventListener('open-table-context-menu', handleContextMenu as EventListener);
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', closeMenu, { capture: true });
      window.removeEventListener('open-autocomplete-menu', handleOpenAutocomplete);
      window.removeEventListener('close-autocomplete-menu', handleCloseAutocomplete);
    };
  }, []);

  // —— B5 自动补全键盘导航（capture 阶段先于 textarea 目标阶段——
  // 菜单打开时拦截 ArrowUp/Down/Enter/Tab/Escape，防止光标/换行/
  // 缩进被编辑器处理）——
  useEffect(() => {
    if (!autocompleteState) return;
    const len = autocompleteState.candidates.length;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => Math.min(len - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        selectCandidate(activeIdx);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setAutocompleteState(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autocompleteState, activeIdx]);

  /** 选中候选：替换 [start, cursorPos) 为候选插入文本 + 光标落点
   *  （buildAutocompleteReplace）→ 单步事务 → 关闭菜单并恢复焦点 */
  const selectCandidate = (idx: number) => {
    if (!autocompleteState) return;
    const candidate = autocompleteState.candidates[idx];
    setAutocompleteState(null);
    if (!candidate) return;
    const s = (autocompleteState.store ?? useEditorStore).getState();
    const replace = buildAutocompleteReplace(autocompleteState, candidate);
    s.applyChange(replace.from, replace.to, replace.insert, {
      cursorAfter: replace.cursorAfter,
      merge: 'none',
    });
    const input = document.querySelector('.hidden-input') as HTMLTextAreaElement | null;
    if (input) input.focus();
  };

  if (!menuState && !autocompleteState) return null;

  const handleAction = (action: string) => {
    // B5：表格动作接线（插入/删除行列、清空单元格、编辑单元格）。
    // 自动补全入口 = 候选点击（selectCandidate）与键盘导航，独立于
    // 表格动作；二者均收敛到 store 单事务 + 焦点恢复。
    applyTableAction(action, () => setMenuState(null));
  };

  const menuStyle = {
    position: 'fixed',
    zIndex: 'var(--z-menu)',
    backgroundColor: 'var(--white)',
    border: '1px solid var(--border-medium)',
    boxShadow: '0 4px 12px hsl(0 0% 0% / 0.1)',
    borderRadius: '6px',
    padding: '4px 0',
    minWidth: '160px',
    fontSize: '13.5px',
    color: 'var(--text-primary)',
  } as const;

  // —— 自动补全候选菜单（B5 项 2：候选列表 UI，ContextMenu 复用；
  //      Alcove 复刻 Seg C：白卡圆角 + 行图标 + 高亮行圆角药丸）——
  if (autocompleteState) {
    const acard = {
      position: 'fixed',
      zIndex: 'var(--z-menu)',
      top: `${autocompleteState.y}px`,
      left: `${autocompleteState.x}px`,
      backgroundColor: 'var(--white)',
      border: '1px solid var(--menu-border)',
      boxShadow: '0 4px 16px hsl(240 2% 0% / 0.08), 0 1px 3px hsl(240 2% 0% / 0.05)',
      borderRadius: '10px',
      padding: '4px',
      width: 'min(340px, 72vw)',
      maxHeight: '320px',
      overflowY: 'auto',
      fontFamily: 'var(--font-sans)',
    } as const;
    return (
      <div
        className="context-menu"
        data-autocomplete-menu
        style={acard}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {autocompleteState.candidates.map((c, i) => {
          const active = i === activeIdx;
          const icon = (() => {
            if (c.iconKind === 'file')
              return (
                <FileTextIcon
                  size={14}
                  strokeWidth={1.8}
                  style={{ color: 'var(--text-secondary)' }}
                />
              );
            if (c.iconKind === 'tag')
              return (
                <HashIcon
                  size={14}
                  strokeWidth={1.8}
                  style={{ color: 'var(--text-secondary)' }}
                />
              );
            if (c.iconKind === 'mention')
              return (
                <AtSignIcon
                  size={14}
                  strokeWidth={1.8}
                  style={{ color: 'var(--text-secondary)' }}
                />
              );
            return null;
          })();
          return (
            <div
              key={`${c.label}-${i}`}
              data-autocomplete-item
              data-active={active ? 'true' : 'false'}
              className="context-menu-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                height: 34,
                padding: '0 8px',
                margin: '1px 2px',
                borderRadius: 8,
                cursor: 'pointer',
                fontSize: 14.5,
                lineHeight: 1,
                color: 'var(--text-primary)',
                backgroundColor: active ? 'var(--menu-selected-bg)' : 'transparent',
              }}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={(e) => {
                e.stopPropagation();
                selectCandidate(i);
              }}
            >
              {icon && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 20,
                    height: 20,
                    borderRadius: 6,
                    flexShrink: 0,
                    backgroundColor: 'var(--interactive-hover)',
                  }}
                >
                  {icon}
                </span>
              )}
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.label}
              </span>
              {c.detail && (
                <span
                  style={{
                    marginLeft: 'auto',
                    flexShrink: 0,
                    color: 'var(--text-muted)',
                    fontSize: 12,
                  }}
                >
                  {c.detail}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  if (!menuState) return null;

  const { isEditing } = menuState;

  return (
    <div
      className="context-menu"
      style={{
        ...menuStyle,
        top: `${menuState.y}px`,
        left: `${menuState.x}px`,
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <style>{`
        .context-menu-item {
          padding: 6px 12px;
          cursor: pointer;
        }
        .context-menu-item:hover {
          background-color: var(--border-subtle);
        }
      `}</style>
      {isEditing ? (
        // Edit Mode Actions
        <>
          <div className="context-menu-item" onClick={() => handleAction('copy')}>复制文字 <span style={{ float: 'right', color: 'var(--text-muted)' }}>Ctrl+C</span></div>
          <div className="context-menu-item" onClick={() => handleAction('paste')}>粘贴文字 <span style={{ float: 'right', color: 'var(--text-muted)' }}>Ctrl+V</span></div>
          <div className="context-menu-divider" style={{ borderBottom: '1px solid var(--border-subtle)', margin: '4px 0' }} />
          <div className="context-menu-item" onClick={() => handleAction('bold')}>加粗 <span style={{ float: 'right', color: 'var(--text-muted)' }}>Ctrl+B</span></div>
          <div className="context-menu-item" onClick={() => handleAction('italic')}>斜体 <span style={{ float: 'right', color: 'var(--text-muted)' }}>Ctrl+I</span></div>
        </>
      ) : (
        // Cell Mode Actions（B5 项 3 接线：菜单项 → TableOperations → applyTableChange）
        <>
          <div className="context-menu-item" onClick={() => handleAction('copy-cell')}>复制单元格内容 <span style={{ float: 'right', color: 'var(--text-muted)' }}>Ctrl+C</span></div>
          <div className="context-menu-item" onClick={() => handleAction('paste-cell')}>粘贴到单元格 <span style={{ float: 'right', color: 'var(--text-muted)' }}>Ctrl+V</span></div>
          <div className="context-menu-divider" style={{ borderBottom: '1px solid var(--border-subtle)', margin: '4px 0' }} />
          <div className="context-menu-item" onClick={() => handleAction('edit-cell')}>编辑单元格 <span style={{ float: 'right', color: 'var(--text-muted)' }}>F2</span></div>
          <div className="context-menu-item" onClick={() => handleAction('merge-cells')}>合并单元格</div>
          <div className="context-menu-item" onClick={() => handleAction('unmerge-cells')}>拆分单元格</div>
          <div className="context-menu-divider" style={{ borderBottom: '1px solid var(--border-subtle)', margin: '4px 0' }} />
          <div className="context-menu-item" onClick={() => handleAction('align-left')}>文本左对齐</div>
          <div className="context-menu-item" onClick={() => handleAction('align-center')}>文本居中对齐</div>
          <div className="context-menu-item" onClick={() => handleAction('align-right')}>文本右对齐</div>
          <div className="context-menu-divider" style={{ borderBottom: '1px solid var(--border-subtle)', margin: '4px 0' }} />
          <div className="context-menu-item" onClick={() => handleAction('insert-row-above')}>向上插入行</div>
          <div className="context-menu-item" onClick={() => handleAction('insert-row-below')}>向下插入行</div>
          <div className="context-menu-divider" style={{ borderBottom: '1px solid var(--border-subtle)', margin: '4px 0' }} />
          <div className="context-menu-item" onClick={() => handleAction('insert-col-left')}>向左插入列</div>
          <div className="context-menu-item" onClick={() => handleAction('insert-col-right')}>向右插入列</div>
          <div className="context-menu-divider" style={{ borderBottom: '1px solid var(--border-subtle)', margin: '4px 0' }} />
          <div className="context-menu-item" onClick={() => handleAction('clear-cell')} style={{ color: 'var(--danger-color)' }}>清空内容 <span style={{ float: 'right', color: 'var(--danger-color)', opacity: 0.7 }}>Backspace</span></div>
          <div className="context-menu-item" onClick={() => handleAction('delete-row')} style={{ color: 'var(--danger-color)' }}>删除选中行</div>
          <div className="context-menu-item" onClick={() => handleAction('delete-col')} style={{ color: 'var(--danger-color)' }}>删除选中列</div>
        </>
      )}
    </div>
  );
};
