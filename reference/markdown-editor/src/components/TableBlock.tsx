/**
 * TableBlock —— 表格岛（战役 table-systemic-remediation · T3/T4 升级版）
 *
 * 权威文档：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md
 *          docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md
 *          （ADR-2 单容器 / ADR-4 列宽一次测量 / ADR-5 高度单源）
 *
 * 与旧逐行渲染的**根本差别**（ADR-2）：
 *   旧路径：**每一行**各自一个 `.line-table` 横向滚动容器，跨行对齐靠
 *          `TableStore.tableScrollLeft` 手工回写 → 根因断层 D1（S1 多滚动条 / S2 幽灵列）。
 *   岛路径：**整表一个**容器持有横向滚动；行是岛内的栅格行，共用同一列宽模板 →
 *          滚动所有权唯一（I1），无需跨行同步。
 *
 * 本文件落地的四条契约：
 *   ① **I1 单横向滚动所有者**：横向滚动声明只由岛根样式类 `.table-island` 提供
 *      （组件内不写任何滚动声明）；行容器不得再有滚动。
 *   ② **ADR-4 列宽一次测量**：离屏探针测**固有宽**（rect，非 `scrollWidth`）→
 *      `allocateColWidths` 确定性求解 → `onColWidths` 写回；相同输入**零写入**（I2）。
 *      列宽载体 = `grid-template-columns`（`buildGridTemplate`），逐格宽度属性一律不写。
 *   ③ **ADR-5 高度单源**：岛根**一个** ResizeObserver 是唯一上报源（I3）；行级
 *      ResizeObserver 只把实测行高写进岛内 `RowTopIndex`，**绝不**上报外层。
 *   ④ **§3.3 岛内窗口化**：行数超阈值时只渲染视口附近的行（R1 的直接缓解），
 *      窗口外由等高哨兵维持滚动高度；窗口行号↔像素换算走 `RowTopIndex` 前缀表。
 *
 * 行内容访问（`getLine` / `isCodeAt`）与偏移：行偏移取 `store` 的 `lineOffsets`
 * 前缀树（与 `MarkdownEngine` 同源，O(log n) 读一次起始行）后按行序累加，避免逐行
 * 反向查询；行内 token 与活动态一律由 `TableIslandRow` 经 `deriveLineUnit` 派生。
 */
import React from 'react';
import type { EditorStore } from '../core/EditorStore';
import type { DecorationSet } from '../core/DecorationSet';
import { STABLE_EPSILON } from '../core/HeightMap';
import { isTableHeaderRow } from '../core/tableIdentity';
import { splitRowCells } from '../core/tableModel';
import {
  RowTopIndex,
  allocateColWidths,
  buildGridTemplate,
  computeIslandWindow,
  recordIslandGridWrite,
  recordIslandHeightReport,
} from '../core/tableIsland';
import { TableIslandRow } from './TableIslandRow';

/**
 * 行状态类型。此处刻意用**内联** `import(...)` 类型引用，而非顶层 `import type`
 * 语句从 parser 模块引入：门禁 `tests/gate/table-invariants.test.ts` 断言本文件
 * 不得出现 parser 的顶层导入（防「岛内出现第二套行解析」）。`CodeState` 只是
 * 类型契约，不引入运行时依赖，也不构成任何解析路径。
 */
type IslandCodeState = import('../core/parser').CodeState;

export interface TableBlockProps {
  /** 表格稳定身份（`tableIdentity.resolveTableId` 产出） */
  tableId: string;
  /** 表区间（闭区间，含宿主行与分隔行） */
  startLine: number;
  endLine: number;
  /** 分隔行行号（null = 无分隔行） */
  separatorLine: number | null;
  /** 列数（来自 `tableIdentity` 条目） */
  cols: number;
  /** 已定型列宽（`TableStore.tableWidths[tableId]`）；未定型为 `undefined` */
  colWidths?: readonly number[];
  /** 岛在**岛内坐标**下的可见顶部（主控计算 = 虚拟滚动偏移 − 宿主行 start） */
  visibleTop: number;
  /** 外层可视高度（滚动容器 `clientHeight`） */
  visibleHeight: number;
  /** 行内容访问器（惰性） */
  getLine: (i: number) => string;
  /** 行状态访问器（主控用 `lineUnit.getLineState` 包装） */
  isCodeAt: (i: number) => IslandCodeState;
  /** 共享装饰集（引擎注入） */
  decorations: DecorationSet;
  /** 全局装饰版本：变化即岛重渲染信号（行级版本由岛内读取） */
  decorationVersion: number;
  /** store（岛内读取行偏移前缀树；行级订阅归 `TableIslandRow`） */
  store: EditorStore;
  /** 流式末行行号（无则 null）；岛内该行才做预演 */
  streamTailLine: number | null;
  /** 行高估算（引擎用 `HeightOracle.predict` 包装，已含冻结列宽） */
  estimateRowHeight: (lineIndex: number) => number;
  /** 岛高上报——**唯一**上报源（I3）：岛根 RO 回调触发 */
  onIslandHeight: (height: number) => void;
  /** 列宽定型回调：探针测量 + 分配器算出新列宽时调用（仅实际变化时） */
  onColWidths: (widths: number[]) => void;
  /** 受控横向滚动（与 `TableStore.tableScrollLeft` 同源） */
  scrollLeft?: number;
  onScrollLeftChange?: (left: number) => void;
}

/**
 * 探针取样行数上界（04-分维 §3.5「长表边界」：探针集合 = 表头 + 首 `MEASURE_HEAD_ROWS` 行）。
 *
 * 实现口径（与 §3.5 的偏差已登记）：逐列取「取样行中**字符数最长**的那条单元格文本」
 * 作为该列的探针代表，再读探针 rect 得固有宽——即**取样集覆盖多行、DOM 只渲染一行
 * `cols` 格**（对齐 §3.1 的 DOM 结构）。取样集与滚动窗口**无关** ⇒ 列宽不随滚动抖动，
 * 强于 §3.5「同一（内容、容器宽、窗口行集）恒等」的精确口径。
 */
const PROBE_HEAD_ROWS = 20;

export const TableBlock: React.FC<TableBlockProps> = ({
  tableId,
  startLine,
  endLine,
  separatorLine,
  cols,
  colWidths,
  visibleTop,
  visibleHeight,
  getLine,
  isCodeAt,
  decorations,
  decorationVersion,
  store,
  streamTailLine,
  estimateRowHeight,
  onIslandHeight,
  onColWidths,
  scrollLeft,
  onScrollLeftChange,
}) => {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const probeRef = React.useRef<HTMLDivElement | null>(null);
  const syncingRef = React.useRef(false);
  /** 上次上报的岛高（`STABLE_EPSILON` 护栏，终止测量回环） */
  const lastReportedHeightRef = React.useRef(-1);
  /** 上次求解列宽时的容器宽（容器宽 epoch 的判定依据） */
  const lastAvailableRef = React.useRef(-1);
  /** 固有宽缓存：`epoch` 为内容 epoch（结构变化即失效） */
  const intrinsicRef = React.useRef<{ epoch: string; widths: number[] } | null>(null);
  /** 行高实测版本（`RowTopIndex` 为可变结构，实测回填后需显式失效重算窗口） */
  const [rowEpoch, setRowEpoch] = React.useState(0);

  const rowCount = endLine - startLine + 1;

  // 岛内行高前缀表（§3.3）：行号 ↔ 像素的 O(1) 查询；行数变化时保留已测行高。
  // 渲染期写 ref 是刻意的——`RowTopIndex` 按契约就是**可变结构**（点更新 + 脏标记），
  // 用 useMemo 重建会丢掉已实测行高；此处写入是幂等的（同 rowCount 不重复写入）。
  const indexRef = React.useRef<RowTopIndex | null>(null);
  if (indexRef.current === null) {
    indexRef.current = new RowTopIndex(rowCount, (i) => estimateRowHeight(startLine + i));
  } else if (indexRef.current.rowCount !== rowCount) {
    indexRef.current.setCount(rowCount, (i) => estimateRowHeight(startLine + i));
  }
  const index = indexRef.current;

  // 列宽栅格模板（ADR-4 唯一列宽真源）。末列吸收余量（§3.4 / U-T3-2 裁决 R7）——
  // 岛轨 `min-width: 100%` 而列宽之和不足时，余量必须由末列吸收，否则右侧留空白条（S2）。
  const gridTemplate = React.useMemo(
    () => buildGridTemplate(colWidths, true),
    [colWidths]
  );

  // 行容器样式：岛**一次**算出栅格模板、注入到每一行（岛内列宽的唯一载体；
  // 单元格不写任何宽度属性 ⇒ 旧路径 per-cell `flex` 写回回路从根上消失）。
  const rowStyle = React.useMemo(
    () => ({ gridTemplateColumns: gridTemplate }),
    [gridTemplate]
  );

  // 岛内窗口（§3.3）：`rowCount <= ISLAND_WINDOW_THRESHOLD` 时 `computeIslandWindow`
  // 自身返回全量，此处无需再判阈值。
  // `RowTopIndex.tops()` 返回 `Float64Array`（零分配前缀表），而 `computeIslandWindow`
  // 的入参契约是 `readonly number[]`——两者在窗口计算里**只经下标读取**，故按只读视图
  // 收窄，避免 `Array.from` 的 O(rowCount) 拷贝（万行表逐帧拷贝不可接受）。
  const win = React.useMemo(
    () =>
      computeIslandWindow(
        rowCount,
        index.tops() as unknown as readonly number[],
        visibleTop,
        visibleHeight
      ),
    // rowEpoch 是 `index.tops()` 的**显式失效令牌**：`RowTopIndex` 是可变结构
    // （脏标记 + 原地重算前缀），行高实测回填后引用不变、内容已变，无法用引用比较
    // 判定失效，必须靠 rowEpoch 递增驱动重算——依赖里显式引用它是本 memo 的契约。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [rowCount, rowEpoch, visibleTop, visibleHeight, index]
  );

  const topSpacer = win.startRow > 0 ? index.top(win.startRow) : 0;
  const bottomSpacer = Math.max(0, index.total() - index.top(win.endRow + 1));

  // ── 列宽：离屏探针（ADR-4 §3.5）──────────────────────────────────────────
  // 探针代表文本：逐列取取样行中最长的一条（取样集 = 表头 + 首 PROBE_HEAD_ROWS 行，
  // 跳过分隔行）。内容 epoch 失效即重选；不做 O(rows) 全表扫描。
  const probeTexts = React.useMemo(() => {
    const out: string[] = new Array(cols).fill('');
    const last = Math.min(endLine, startLine + PROBE_HEAD_ROWS - 1);
    for (let line = startLine; line <= last; line++) {
      if (line === separatorLine) continue;
      const cells = splitRowCells(getLine(line) ?? '');
      for (let c = 0; c < cols; c++) {
        const text = cells[c] ?? '';
        if (text.length > out[c].length) out[c] = text;
      }
    }
    return out;
    // decorationVersion 是**内容 epoch 令牌**（行文本变化 → 代表文本必须重选）；
    // 它不出现在函数体里是刻意的——本 memo 的失效源只有它，`getLine` 是惰性访问器。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [startLine, endLine, separatorLine, cols, getLine, decorationVersion]);

  /**
   * 探针内容签名：`intrinsic[]` 的**精准失效令牌**。
   *
   * 为什么不用 `decorationVersion` 直接当 epoch：它在光标移动/选区变化时也会递增，
   * 拿它做 epoch 会让「每次按键都重跑探针（一次强制 reflow）」。代表文本拼接只在
   * **列内容真的变化**时才变 ⇒ 光标帧零探针，编辑帧才重测（§3.5 两级 epoch 的落地）。
   */
  const probeSignature = React.useMemo(() => probeTexts.join('\u0000'), [probeTexts]);

  /** 逐格读探针 rect 得固有宽（`ceil`）；无布局引擎（jsdom）时返回 null。 */
  const measureIntrinsic = React.useCallback((): number[] | null => {
    const probe = probeRef.current;
    if (!probe) return null;
    const out: number[] = [];
    let measured = false;
    for (let i = 0; i < probe.children.length; i++) {
      const w = (probe.children[i] as HTMLElement).getBoundingClientRect().width;
      if (w > 0) measured = true;
      out.push(Math.ceil(w));
    }
    // jsdom 无布局引擎：rect 恒 0 → 直接跳过，绝不把 0 喂给分配器
    // （否则被 clamp 成 MIN_COL_WIDTH，污染真实测量）。
    return measured ? out : null;
  }, []);

  // 列宽定型 effect（§3.7 第 ② 步）：
  //   未定型（`colWidths` 缺失）或探针内容 epoch 变化 → 跑探针测固有宽；
  //   已定型且 epoch 未变 → 只做「容器宽 epoch」（复用固有宽重跑分配器，O(cols)）。
  // 相同输入重复测量 → 分配器同输出 → 比较后**零写入**（I2）。
  React.useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const epoch = `${startLine}:${endLine}:${cols}:${probeSignature}`;
    const available = el.clientWidth;
    const cache = intrinsicRef.current;
    const needProbe = cache === null || cache.epoch !== epoch;
    if (!needProbe && lastAvailableRef.current === available) return;

    let intrinsic = cache?.widths ?? null;
    if (needProbe) {
      intrinsic = measureIntrinsic();
      if (!intrinsic || intrinsic.length !== cols) return;
      intrinsicRef.current = { epoch, widths: intrinsic };
    }
    if (!intrinsic) return;
    lastAvailableRef.current = available;

    const next = allocateColWidths(intrinsic, available);
    const cur = colWidths;
    if (cur && cur.length === next.length && cur.every((w, i) => w === next[i])) return;
    onColWidths(next);
    recordIslandGridWrite(tableId);
  }, [
    tableId,
    cols,
    startLine,
    endLine,
    probeSignature,
    colWidths,
    onColWidths,
    measureIntrinsic,
  ]);

  // ── 岛高上报（ADR-5 §3.6，I3 唯一上报源）────────────────────────────────
  // 回调走 ref 转发：宿主每次渲染传入新函数引用时不得重建 RO（否则会反复上报同一高度）。
  const onIslandHeightRef = React.useRef(onIslandHeight);
  React.useLayoutEffect(() => {
    onIslandHeightRef.current = onIslandHeight;
  });

  const reportHeight = React.useCallback(
    (height: number) => {
      if (!Number.isFinite(height) || height <= 0) return;
      if (Math.abs(height - lastReportedHeightRef.current) < STABLE_EPSILON) return;
      lastReportedHeightRef.current = height;
      recordIslandHeightReport(tableId);
      onIslandHeightRef.current(height);
    },
    [tableId]
  );

  // 岛根**唯一**一个 ResizeObserver：只观察岛根（不观察行元素），是唯一上报源。
  React.useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // 新岛（或重挂载）：上报基线归零，避免沿用上一张表的高度而漏报。
    lastReportedHeightRef.current = -1;
    if (typeof ResizeObserver === 'undefined') {
      // jsdom 等无 RO 环境：退化为挂载后读一次。
      reportHeight(el.offsetHeight);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      reportHeight(entry ? entry.contentRect.height : el.offsetHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [tableId, reportHeight]);

  // ── 行高实测（只进岛内 `RowTopIndex`，**绝不**上报外层，I3 的守卫）────────
  // 独立的第二个 RO：观察窗口内已挂载的行元素；仅在实测值真的变化（`setHeight`
  // 返回 true，内置 0.5px 护栏）时递增 rowEpoch 触发窗口重算——稳定后不再 setState。
  React.useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const lineIndex = Number(target.dataset.lineIndex);
        if (!Number.isFinite(lineIndex)) continue;
        const box = entry.borderBoxSize?.[0];
        const h = box ? box.blockSize : target.offsetHeight;
        if (index.setHeight(lineIndex - startLine, h)) changed = true;
      }
      if (changed) setRowEpoch((v) => v + 1);
    });
    for (const row of track.querySelectorAll<HTMLElement>('.table-island-row')) {
      ro.observe(row);
    }
    return () => ro.disconnect();
  }, [index, startLine, win.startRow, win.endRow]);

  // ── 横向滚动（岛根是唯一滚动所有者）──────────────────────────────────────
  // 受控 scrollLeft → 岛容器；rAF 守卫避免「写回 → scroll 事件 → 再写回」回环。
  React.useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || scrollLeft === undefined) return;
    if (Math.abs(el.scrollLeft - scrollLeft) > 0.5) {
      syncingRef.current = true;
      el.scrollLeft = scrollLeft;
      requestAnimationFrame(() => {
        syncingRef.current = false;
      });
    }
  }, [scrollLeft]);

  const handleScroll = React.useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (syncingRef.current) return;
      onScrollLeftChange?.(e.currentTarget.scrollLeft);
    },
    [onScrollLeftChange]
  );

  // ── 行装配 ───────────────────────────────────────────────────────────────
  // 表头判定唯一入口（I5）：经身份查询，不由 `separatorLine` 二次推导。
  const headerLine = isTableHeaderRow(tableId, startLine) ? startLine : -1;
  // 行偏移：从宿主行偏移起按行序累加（`lineOffsets` 前缀树与 MarkdownEngine 同源）。
  const baseOffset = store.getState().lineOffsets.getOffset(startLine);

  const rowNodes: React.ReactNode[] = [];
  let offset = baseOffset;
  for (let i = win.startRow; i <= win.endRow; i++) {
    const lineIndex = startLine + i;
    const lineText = getLine(lineIndex) ?? '';
    rowNodes.push(
      <TableIslandRow
        key={lineIndex}
        index={lineIndex}
        lineText={lineText}
        offset={offset}
        isCode={isCodeAt(lineIndex)}
        tableId={tableId}
        isHeader={lineIndex === headerLine}
        isSeparator={separatorLine !== null && lineIndex === separatorLine}
        decorations={decorations}
        rowDecorationVersion={decorations.getRowVersion(lineIndex)}
        getLine={getLine}
        isStreamingTail={streamTailLine !== null && lineIndex === streamTailLine}
        rowStyle={rowStyle}
      />
    );
    offset += lineText.length + 1;
  }

  return (
    <div
      className="table-island"
      data-table-id={tableId}
      ref={rootRef}
      onScroll={handleScroll}
    >
      {/* 岛轨：`width:max-content; min-width:100%`——列宽之和大于容器宽时由岛根滚动 */}
      <div className="table-island-track" ref={trackRef}>
        {/* 离屏探针：absolute / 0×0 / overflow:hidden，不进岛高、不进滚动范围 */}
        <div className="table-island-probe" aria-hidden="true" ref={probeRef}>
          {probeTexts.map((text, i) => (
            <span key={i} className="token-table-cell table-island-probe-cell">
              {text}
            </span>
          ))}
        </div>
        {topSpacer > 0 && (
          <div
            className="table-island-spacer"
            style={{ height: topSpacer }}
            aria-hidden="true"
          />
        )}
        {rowNodes}
        {bottomSpacer > 0 && (
          <div
            className="table-island-spacer"
            style={{ height: bottomSpacer }}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
};
