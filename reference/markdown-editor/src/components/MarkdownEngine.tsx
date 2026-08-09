import React, { useCallback, useLayoutEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BlockRenderer } from './BlockRenderer';
import { HiddenInput } from './HiddenInput';
import { CursorLayer } from './CursorLayer';
import { useEditorStore } from '../core/EditorStore';
import { useTableStore } from '../core/TableStore';
import { MarkdownParser } from '../core/parser';
import { HeightMap, HeightOracle, classifyLine } from '../core/HeightMap';

import { type CodeState } from '../core/parser';

// 行渲染单元（09 §4 C1 滚动契约）：
// - 位置由命令式通道独占：tanstack directDomUpdates 模式把行 top 直接写 DOM
//   （applyDirectStyles 写 el.style.top），本组件不读 virtualRow.start、
//   不在 style 里写主轴位置——任何 React 重渲染都不会覆盖命令式位置，
//   这是「位置帧零提交」能成立的代码级前提；
// - props 只传 index（数字）+ 内容字段（lineText/offset/isCode）+ 稳定 rowRef，
//   virtualRow 新对象字面量引发的 memo 失效被根治：滚动/光标变化帧行内容不变时
//   全部 memo 命中，React 仅挂载/卸载窗口边界行（01 问题 6 §6.2-C）。
const LineItem = React.memo(({
  index,
  lineText,
  offset,
  isCode,
  rowRef
}: {
  index: number;
  lineText: string;
  offset: number;
  isCode: CodeState;
  rowRef: (el: HTMLElement | null) => void;
}) => {
  const activeStateStr = useEditorStore(state => {
    const { cursorPos, selectionStart, selectionEnd } = state;
    const lineStart = offset;
    const lineEnd = offset + lineText.length;

    const hasRange = selectionStart !== selectionEnd;
    const s = Math.min(selectionStart, selectionEnd);
    const e = Math.max(selectionStart, selectionEnd);

    const isLineActive = hasRange
      ? (lineStart < e && lineEnd >= s)
      : (cursorPos >= lineStart && cursorPos <= lineEnd);

    if (!isLineActive) return null;

    return `${cursorPos},${hasRange ? s : ''},${hasRange ? e : ''}`;
  });

  const activeState = React.useMemo(() => {
    if (!activeStateStr) return null;
    const [cursorStr, selStartStr, selEndStr] = activeStateStr.split(',');
    return {
      cursor: Number(cursorStr),
      selStart: selStartStr ? Number(selStartStr) : undefined,
      selEnd: selEndStr ? Number(selEndStr) : undefined,
    };
  }, [activeStateStr]);

  const tableId = useEditorStore(state => {
    if (!lineText.trim().startsWith('|')) return undefined;
    let firstTableIndex = index;
    while (firstTableIndex > 0) {
       const prevLine = state.lines[firstTableIndex - 1];
       if (prevLine && prevLine.trim().startsWith('|')) {
          firstTableIndex--;
       } else {
          break;
       }
    }
    return `table-${firstTableIndex}`;
  });

  const lineNode = MarkdownParser.parseLine(lineText, offset, isCode);

  return (
    <div
      data-index={index}
      data-line-start={offset}
      data-line-length={lineText.length}
      ref={rowRef}
      className={`virtual-row ${activeState ? 'is-active-line' : ''}`.trim()}
      style={{
        position: 'absolute',
        left: 0,
        width: '100%',
        minHeight: lineNode.type === 'table_separator' ? '0px' : '28px',
      }}
    >
      <BlockRenderer
        block={lineNode}
        index={index}
        lineOffset={offset}
        activeState={activeState}
        tableId={tableId}
      />
    </div>
  );
});

export const MarkdownEngine: React.FC = () => {
  const parentRef = useRef<HTMLDivElement>(null);
  const lines = useEditorStore(state => state.lines);
  const offsets = useEditorStore(state => state.lineOffsets);
  const codeBlockState = useEditorStore(state => state.codeBlockState);
  const setCursorPos = useEditorStore(state => state.setCursorPos);

  // ── 行高模型（R2-B 定位层）：HeightOracle 预测 + HeightMap 回填（01 问题 1/8，09 §4 C2）──
  const rowRefs = useRef(new Map<number, HTMLElement>());
  const heightMapRef = useRef<HeightMap | null>(null);
  const oracleRef = useRef<HeightOracle | null>(null);
  if (heightMapRef.current === null) heightMapRef.current = new HeightMap();
  if (oracleRef.current === null) oracleRef.current = new HeightOracle();

  // 容器可用宽度 → oracle 的 wrap 模型基准（左右 padding 16×2 + 滚动条 8 ≈ 40）
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (el && oracleRef.current) oracleRef.current.setContainerWidth(el.clientWidth - 40);
  }, []);

  // Virtualization setup: fixed size = 28px perfectly aligns with grid paper CSS
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      // 行高来源优先级：HeightMap 存储值（实测回填 / 插入时预测）→ oracle 即时预测。
      // （R2-D 核实结论：tanstack count 变化不会清空 itemSizeCache（virtual-core
      // getMeasurements 仅在 !enabled / lanes 变化时清缓存），estimateSize 只对
      // 缓存 miss 的行求值——每次 count 变化 ≤ 新增行数，存量行全命中；
      // 「1M 次 estimateSize」在 3.14.9 版本下不成立，HeightMap 直查已消除该路径）
      const hm = heightMapRef.current;
      if (hm) {
        const h = hm.getHeight(i);
        if (h !== undefined) return h;
      }
      const raw = lines[i] ?? '';
      const st = codeBlockState[i];
      const oracle = oracleRef.current;
      if (oracle) return oracle.predict(classifyLine(raw, st), raw, st);
      return 28;
    },
    overscan: 40, // Buffer for smooth scrolling
    // C1 滚动管线与 tanstack 契约（09 §4 C1 全落实）：
    // - directDomUpdates（position 模式）：observer 照常通知保持 start 正确，
    //   但滚动位置帧的 React 提交被合并到「窗口变化帧」——行位置由库直接命令式
    //   写 el.style.top（绝对值，无 translateY 增量叠加），窗口 range 不变时
    //   零 React 提交（01 问题 6 §6.2-A/B，120/140fps 目标的决定性优化）；
    // - useCachedMeasurements：RO 回调只返回缓存值（delta=0 时 resizeItem
    //   零成本跳过），逐行 DOM 测量回填仍由引擎的批量协议独占（09 §4 C2，
    //   杜绝「保留 measureElement + 期望消除抖动」的双写状态）。
    directDomUpdates: true,
    directDomUpdatesMode: 'position',
    useCachedMeasurements: true,
  });

  // 行 ref 注册表（稳定回调，空依赖不破坏 LineItem memo）：
  // 挂载时登记到 rowRefs（index 从 data-index 属性读，不依赖闭包），同时调用
  // virtualizer.measureElement 注册 elementsCache（directDomUpdates 位置写入通道）；
  // 卸载条目不即时清理——批量测量循环按 isConnected 过滤，天然清除已卸载行，
  // 防 stale 条目污染测量（行卸载即 DOM 断开，detached 元素 offsetHeight 不可信）。
  const registerRowRef = useCallback((el: HTMLElement | null) => {
    virtualizer.measureElement(el);
    if (!el) return;
    const idx = parseInt(el.getAttribute('data-index') || '-1', 10);
    if (idx >= 0) rowRefs.current.set(idx, el);
  }, [virtualizer]);

  // 渲染窗口签名（首尾 index）：directDomUpdates 模式下 React 渲染仅发生在
  // 窗口变化帧（range 首尾 index 变化 / isScrolling 翻转），此处读到的窗口
  // 即「将要渲染的窗口」——批量测量协议只在窗口变化帧运行，位置帧零开销
  const virtualItems = virtualizer.getVirtualItems();
  const windowKey = virtualItems.length
    ? virtualItems[0].index + '-' + virtualItems[virtualItems.length - 1].index
    : '';

  // 批量测量协议（09 §4 C2：移除逐行 measureElement 双写 → 统一测量 → 树回填 → 显式刷新一次）：
  // 1. 行数同步：新增行（流式/编辑）按 oracle 预测补齐，行数减少时截断；
  // 2. 已挂载行统一实测（单次批量 layout 读 offsetHeight）；
  // 3. oracle 样本校准（全量样本进 EMA）+ 稳定点检测（与已存储高度比，|Δ| < 0.5px 不回写）；
  // 4. 回填 HeightMap 并经 virtualizer.resizeItem 写 tanstack 缓存——directDomUpdates
  //    模式下 resizeItem 的 notify 走命令式位置刷新（窗口不变零 React 提交），
  //    仅实际回填（setHeight 返回 true）才触发（09 §4 C1 窗口变化帧复位协议：
  //    窗口变化 → React 一次完整渲染 + 库 applyDirectStyles 写全量绝对值位置）。
  useLayoutEffect(() => {
    const hm = heightMapRef.current;
    const oracle = oracleRef.current;
    if (!hm || !oracle) return;
    hm.syncTo(lines.length, (i) => {
      const raw = lines[i] ?? '';
      const st = codeBlockState[i];
      return oracle.predict(classifyLine(raw, st), raw, st);
    });
    for (const item of virtualizer.getVirtualItems()) {
      const el = rowRefs.current.get(item.index);
      // 已卸载行（DOM 已断开）直接从注册表剔除，防 stale 条目污染批量测量
      if (!el || !el.isConnected) {
        rowRefs.current.delete(item.index);
        continue;
      }
      const raw = lines[item.index];
      if (raw === undefined) continue;
      const st = codeBlockState[item.index];
      const kind = classifyLine(raw, st);
      const predicted = oracle.predict(kind, raw, st);
      const measured = el.offsetHeight;
      // 样本校准：所有实测样本都进 EMA（不设 0.5px 过滤——一旦预测接近实测，
      // 过滤会把样本全部剔除导致校准停摆；EMA 自身已平均噪声）
      oracle.calibrate(kind, predicted, measured);
      // 稳定点检测内置于 setHeight（与已存储高度比，|Δ| < 0.5px 不回写），
      // 终止测量-回填-重排回环（CM6 Epsilon 同款护栏）；仅实际回填时刷新 tanstack 缓存
      if (hm.setHeight(item.index, measured)) {
        virtualizer.resizeItem(item.index, measured);
      }
    }
    hm.flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, codeBlockState, windowKey]);

  const handleContainerClick = (e: React.MouseEvent) => {
    // If we just finished a drag selection, ignore the synthetic click
    if (Date.now() - ((window as any).__CRISH_LAST_DRAG_END_TIME || 0) < 50) return;

    const target = e.target as HTMLElement;
    if (!target.closest('.line-table-row')) {
      useTableStore.getState().clearCellSelection();
    }

    // If the user selected text, do NOT clear the selection and do NOT move the custom cursor
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }

    // 1. Try to find if we clicked on a rendered line wrapper
    let clickedLineIndex = parseInt(
      target.closest('[data-index]')?.getAttribute('data-index') || '-1',
      10
    );

    // 1.5 If clicked on padding/margins, try to resolve the line using vertical coordinates
    // C1 契约：坐标换算统一走 HeightMap.indexAt（O(log n) 像素 → 行），
    // 不再遍历 virtualRow 线性扫描（01 问题 1 blockAt 同款定位结构）；
    // contentY 已是容器内容坐标（含 scrollTop、不含 padding），topOffset 传 0，
    // 与行 top（内容坐标）同一空间。仅接受落在当前虚拟窗口内的命中，
    // 窗口外的空白点击维持旧语义（回落文末）。
    let clickedPadding = false;
    if (clickedLineIndex === -1 && parentRef.current) {
      const containerRect = parentRef.current.getBoundingClientRect();
      const contentY = e.clientY - containerRect.top + parentRef.current.scrollTop;

      const hm = heightMapRef.current;
      const items = virtualizer.getVirtualItems();
      if (hm && items.length) {
        const idx = hm.indexAt(contentY, 0);
        if (idx >= items[0].index && idx <= items[items.length - 1].index) {
          clickedLineIndex = idx;
          clickedPadding = true;
        }
      }
    }

    // Prevent table separator from being clicked. Redirect to previous row (table header)
    if (clickedLineIndex !== -1 && lines[clickedLineIndex]?.trim().match(/^\|?[\s:-]*[-]+[\s:-]*\|/)) {
      if (clickedLineIndex > 0) {
        const prevLineStart = offsets.getOffset(clickedLineIndex - 1);
        const prevLineLen = lines[clickedLineIndex - 1].length;
        setCursorPos(prevLineStart + prevLineLen);
        return;
      }
    }

    if (clickedPadding && clickedLineIndex !== -1 && parentRef.current) {
       const lineStart = offsets.getOffset(clickedLineIndex);
       const lineLen = lines[clickedLineIndex].length;
       const containerRect = parentRef.current.getBoundingClientRect();
       
       if (e.clientX < containerRect.left + 50) {
         // Clicked left padding/margin
         setCursorPos(lineStart);
       } else {
         // Clicked right padding/margin
         setCursorPos(lineStart + lineLen);
       }
       return;
    }

    let range: Range | null = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
    } else if ((document as any).caretPositionFromPoint) {
      const pos = (document as any).caretPositionFromPoint(
        e.clientX,
        e.clientY
      );
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }

    // Clamp the range to the cell we actually clicked on (to prevent clicking padding and jumping to next cell)
    const clickedCell = target.closest('.token-table-cell') as HTMLElement;
    if (clickedCell && range && range.startContainer) {
      const resolvedNode = range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : (range.startContainer as HTMLElement);
      
      const resolvedCell = resolvedNode?.closest('.token-table-cell');
      if (resolvedCell !== clickedCell) {
        const cellStart = parseInt(clickedCell.getAttribute('data-token-start') || '-1', 10);
        const cellLen = parseInt(clickedCell.getAttribute('data-token-length') || '0', 10);
        if (cellStart !== -1) {
          const rect = clickedCell.getBoundingClientRect();
          // If we clicked left half, go to start of cell. Otherwise go to end.
          if (e.clientX < rect.left + rect.width / 2) {
            setCursorPos(cellStart + 1); // +1 because start is the table_cell token itself? Actually start is localOffset.
          } else {
            setCursorPos(cellStart + cellLen);
          }
          return;
        }
      }
    }

    // 3. Check if we clicked directly on an HR (thematic break)
    if (target.tagName === 'HR' || target.classList.contains('hr-rendered')) {
      const lineStart = offsets.getOffset(clickedLineIndex);
      const lineLen = lines[clickedLineIndex].length;
      const rect = target.getBoundingClientRect();
      if (e.clientX - rect.left < rect.width / 2) {
        setCursorPos(lineStart);
      } else {
        setCursorPos(lineStart + lineLen);
      }
      return;
    }

    // 4. Try to use the exact token offset, BUT ONLY if it belongs to the clicked line!
    if (range && range.startContainer) {
      let el: HTMLElement | null =
        range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : (range.startContainer as HTMLElement);

      let foundTokenStart = -1;
      let foundLineIndex = -1;

      while (el && el !== parentRef.current) {
        if (el.hasAttribute('data-token-start') && foundTokenStart === -1) {
          foundTokenStart = parseInt(
            el.getAttribute('data-token-start') || '-1',
            10
          );
        }
        if (el.hasAttribute('data-index')) {
          foundLineIndex = parseInt(el.getAttribute('data-index') || '-1', 10);
          break;
        }
        el = el.parentElement;
      }

      // Only use the precise offset if the browser snapped to the SAME line we clicked
      if (foundLineIndex === clickedLineIndex) {
        if (foundTokenStart !== -1) {
          // It's inside a specific token (like a word)
          // Find if there's an exact sub-offset element
          let subOffset = 0;
          let currentEl: HTMLElement | null =
            range.startContainer.nodeType === Node.TEXT_NODE
              ? range.startContainer.parentElement
              : (range.startContainer as HTMLElement);

          while (currentEl && currentEl !== parentRef.current) {
            if (currentEl.hasAttribute('data-sub-offset')) {
              subOffset = parseInt(
                currentEl.getAttribute('data-sub-offset') || '0',
                10
              );
              break;
            }
            if (currentEl.hasAttribute('data-token-start')) {
              break; // Stop at token boundary
            }
            currentEl = currentEl.parentElement;
          }

          const rawPos =
            foundTokenStart + subOffset + (range.startOffset || 0);
          const lineStart = offsets.getOffset(clickedLineIndex);
          const lineLen = lines[clickedLineIndex].length;
          setCursorPos(Math.min(lineStart + lineLen, rawPos));
        } else {
          // Fallback to line start + offset
          const lineStart = offsets.getOffset(clickedLineIndex);
          const lineLen = lines[clickedLineIndex].length;
          setCursorPos(
            Math.min(lineStart + lineLen, lineStart + (range.startOffset || 0))
          );
        }
        return;
      }
    }

    // 4. Fallback: User clicked an empty line, or empty space far away from text, or a preview element (HR, Math)
    if (clickedLineIndex !== -1) {
      // If user clicked the table separator empty space, redirect to the header row above it
      if (lines[clickedLineIndex]?.trim().match(/^\|?[\s:-]*[-]+[\s:-]*\|/)) {
        if (clickedLineIndex > 0) {
          const prevLineStart = offsets.getOffset(clickedLineIndex - 1);
          const prevLineLen = lines[clickedLineIndex - 1].length;
          setCursorPos(prevLineStart + prevLineLen);
          return;
        }
      }
      const lineStart = offsets.getOffset(clickedLineIndex);
      const lineLen = lines[clickedLineIndex].length;

      // Use token-mapping from closest rendered element
      const tokenEl = (e.target as HTMLElement).closest('[data-token-start]');
      if (tokenEl) {
        const startStr = tokenEl.getAttribute('data-token-start');
        if (startStr) {
          const start = parseInt(startStr, 10);
          if (!isNaN(start)) {
            setCursorPos(start);
            return; // We found the precise token!
          }
        }
      }

      // Final fallback to end of the line
      console.log('Fallback to end of line:', lineStart + lineLen);
      setCursorPos(lineStart + lineLen);
    } else {
      // Clicked in the container but outside any specific line (e.g. bottom empty space)
      // Put cursor at the very end of the document
      const lastLineIdx = lines.length - 1;
      if (lastLineIdx >= 0) {
        const lineStart = offsets.getOffset(lastLineIdx);
        const lineLen = lines[lastLineIdx].length;
        console.log('Fallback to end of doc:', lineStart + lineLen);
        setCursorPos(lineStart + lineLen);
      }
    }
  };

  return (
    <div
      className="engine-container"
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      <div
        ref={parentRef}
        className="editor-container editor-scroll-container"
        onClick={handleContainerClick}
        onCopy={(e) => {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed) return;

          const state = useEditorStore.getState();
          const start = Math.min(state.selectionStart, state.selectionEnd);
          const end = Math.max(state.selectionStart, state.selectionEnd);
          
          if (start !== end) {
            const rawText = state.getText().substring(start, end);
            e.clipboardData.setData('text/plain', rawText);
            e.preventDefault();
          }
        }}
        onCut={(e) => {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed) return;

          const state = useEditorStore.getState();
          const start = Math.min(state.selectionStart, state.selectionEnd);
          const end = Math.max(state.selectionStart, state.selectionEnd);
          
          if (start !== end) {
            const rawText = state.getText().substring(start, end);
            e.clipboardData.setData('text/plain', rawText);
            state.deleteSelection(start, end);
            window.getSelection()?.removeAllRanges();
            e.preventDefault();
            // Optional: return focus to textarea if possible, though it's hidden
          }
        }}
        style={{
          height: '100%',
          overflow: 'auto',
          padding: '14px 1rem',
          position: 'relative',
        }}
      >
        {/* C1 契约：内容容器主轴高度由 virtualizer.containerRef 命令式管理
            （applyContainerSize 写总高，免 React 提交），style 不写 height；
            marginTop 14px 为横向装饰属性，保留 */}
        <div
          ref={virtualizer.containerRef}
          style={{
            width: '100%',
            position: 'relative',
            marginTop: '14px',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const index = virtualRow.index;
            const lineText = lines[index];
            const offset = offsets.getOffset(index);
            const isCode = codeBlockState[index];
            return (
              <LineItem
                key={index}
                index={index}
                lineText={lineText}
                offset={offset}
                isCode={isCode}
                rowRef={registerRowRef}
              />
            );
          })}
        </div>


        <CursorLayer
          containerRef={parentRef}
          // layoutDeps 紧凑化（01 问题 2 §2.2-C 的布局陷阱消除）：不再每帧生成
          // 「全部虚拟项 start 的巨型字符串」，改为「窗口首尾 index + 行数 + 总高」
          // 稳定签名——纯滚动位置帧该签名不变 → CursorLayer 零重测零全扫；
          // 窗口变化/行高回填（总高变化）时才重测。光标坐标是容器内容坐标
          // （与行 top 同空间），滚动时内容坐标不变，视觉天然跟随，无需逐帧重测。
          layoutDeps={(() => {
            const items = virtualizer.getVirtualItems();
            const hm = heightMapRef.current;
            const first = items.length ? items[0].index : -1;
            const last = items.length ? items[items.length - 1].index : -1;
            const totalH = hm ? Math.round(hm.totalHeight * 10) : 0;
            return `${first}-${last}-${lines.length}-${totalH}`;
          })()}
        />
        <HiddenInput containerRef={parentRef} />
      </div>
    </div>
  );
};
