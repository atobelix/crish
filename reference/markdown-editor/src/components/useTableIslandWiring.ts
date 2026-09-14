/**
 * useTableIslandWiring —— 表格岛与引擎虚拟化的**接线单元**（战役 table-systemic-remediation · T4）
 *
 * 权威文档：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md
 *          （§3.3 岛内窗口化 / §3.6 高度上报 / §3.7 测量时序契约）
 *          docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2 / ADR-5）
 *
 * 本模块把 T4 的三件事从 `MarkdownEngine.tsx` 里隔离出来（该文件在行数门禁的
 * 例外名单内、ceiling 冻结，接线只允许留下极薄的一层）：
 *
 *   ① **整表作为单一虚拟项**（ADR-2）：`rangeExtractor` 把表格区间折叠为
 *      `[startLine]` 一个索引；窗口落在表内部时**注入**宿主行索引
 *      （否则视口内将没有任何虚拟项，整表消失）。
 *   ② **高度单源**（ADR-5 / I3）：岛宿主行承载整表高度；区间**内部行一律 0**
 *      （HeightMap 与 tanstack 测量缓存两侧同步置 0），批量测量循环跳过表格行
 *      ——表格高度的唯一写者只有岛根的 `onIslandHeight`。
 *   ③ **行高估算**（ADR-4/ADR-5）：内部行与岛高初值由 `HeightOracle.predict`
 *      按**真实列宽**估算（T4a 已落地），岛实测后由 `onIslandHeight` 覆盖。
 *
 * 开关纪律（`00-总方案` §9.2 规则 2）：本模块的所有行为都以
 * `isTableIslandEnabled()` 为门——开关关闭时 `rangeExtractor` 直接返回默认窗口、
 * `hostAt` 恒 `null`、高度协议整体短路，旧逐行路径**零变化**。
 *
 * 已知边界（登记，归 T5/T6）：
 *   - 岛内行不提供 `data-index`（I8 要求该属性全局唯一，岛宿主行已占用），
 *     故 `measure.ts` 中依赖 `data-index` 的上下方向键跨行导航在岛内退化为
 *     「目标行未挂载」路径；光标坐标测量依赖的 `data-line-start` 已补齐。
 *   - 与折叠区间相交的表**不参与岛渲染**（回落旧路径），避免折叠占位行与
 *     岛内窗口化互相遮蔽。
 */
import React from 'react';
import {
  defaultRangeExtractor,
  type Range,
} from '@tanstack/react-virtual';
import { classifyLine, type HeightMap, type HeightOracle } from '../core/HeightMap';
import { getLineState } from '../core/lineUnit';
import type { EditorStore } from '../core/EditorStore';
import type { FoldState } from '../core/foldState';
import { tableColWidthsAtLine } from '../core/TableStore';
import { isTableIslandEnabled } from '../core/tableIsland';
import {
  TableRangeIndex,
  type TableRangeInfo,
} from '../core/tableIslandRanges';

/** 虚拟化最小结构面（避免把 tanstack 的泛型签名带进本模块的类型面）。 */
export interface IslandVirtualizer {
  getVirtualItems(): readonly { index: number; start: number }[];
  resizeItem(index: number, size: number): void;
}

export interface TableIslandWiringParams {
  store: EditorStore;
  virtualizer: IslandVirtualizer;
  heightMapRef: React.RefObject<HeightMap | null>;
  scrollElRef: React.RefObject<HTMLElement | null>;
  followStateRef: React.RefObject<'follow' | 'paused'>;
  foldStateRef: React.RefObject<FoldState | null>;
  oracleRef: React.RefObject<HeightOracle | null>;
}

export interface TableIslandWiring {
  /** 该 index 是岛宿主行时返回其区间（否则 `null`）；渲染分支与高度协议共用。 */
  hostAt: (index: number) => TableRangeInfo | null;
  /** 虚拟化窗口提取器（折叠表格区间）。 */
  rangeExtractor: (range: Range) => number[];
  /** 岛宿主行的高上报回调（按行号缓存，引用稳定，避免岛内 RO 反复重建）。 */
  onIslandHeight: (startLine: number) => (height: number) => void;
  /** 单行高估算（岛内窗口化的行高来源；与 HeightMap 同源口径）。 */
  estimateRowHeight: (lineIndex: number) => number;
  /** 岛高初值估算（岛实测上报前的占位高度）。 */
  estimateIslandHeight: (range: TableRangeInfo) => number;
  /**
   * 高度协议：`syncTo` **之后**调用——岛宿主行 = 岛高（实测优先 / 否则估算），
   * 区间内部行 = 0（HeightMap 与 tanstack 缓存两侧）。
   */
  applyHeightProtocol: (items: readonly { index: number }[]) => void;
  /** 供 `estimateSize` 使用的单点查询（内部行 → 0；宿主行 → 岛高）。 */
  estimateSizeAt: (index: number) => number | null;
}

/** 岛高初值的兜底下限（一行高；防止估算异常导致表整体塌陷）。 */
const ISLAND_MIN_HEIGHT = 28;

export function useTableIslandWiring(
  params: TableIslandWiringParams
): TableIslandWiring {
  const { store, virtualizer, heightMapRef, scrollElRef, followStateRef, foldStateRef, oracleRef } =
    params;

  // ── 区间索引（实例随 store 切换重建；epoch 由 store 读取）─────────────────
  const rangeIndexRef = React.useRef<TableRangeIndex | null>(null);
  const storeRef = React.useRef<EditorStore | null>(null);
  if (storeRef.current !== store || rangeIndexRef.current === null) {
    storeRef.current = store;
    rangeIndexRef.current = new TableRangeIndex(
      (i) => store.getState().getLine(i),
      () => {
        const s = store.getState();
        return { main: s.mainLines, tail: s.streamTail, count: s.getLineCount() };
      }
    );
  }
  const rangeIndex = rangeIndexRef.current;

  // 岛实测高度缓存（tableId → 高度）：岛上报前的初值由估算提供，
  // 上报后由实测值覆盖；岛重挂载会重新上报，故无需主动失效。
  const islandHeightsRef = React.useRef(new Map<string, number>());

  /** 该表是否可走岛渲染（与折叠区间相交的表回落旧路径）。 */
  const isEligible = React.useCallback(
    (range: TableRangeInfo): boolean => {
      const fold = foldStateRef.current;
      if (!fold) return true;
      for (const r of fold.getRanges()) {
        if (r.startLine <= range.endLine && r.endLine >= range.startLine) return false;
      }
      return true;
    },
    [foldStateRef]
  );

  const hostAt = React.useCallback(
    (index: number): TableRangeInfo | null => {
      if (!isTableIslandEnabled()) return null;
      const r = rangeIndex.rangeAt(index);
      if (!r || r.startLine !== index) return null;
      return isEligible(r) ? r : null;
    },
    [rangeIndex, isEligible]
  );

  // ── ① 虚拟化窗口提取器：表格区间折叠为单一虚拟项（ADR-2）─────────────────
  const rangeExtractor = React.useCallback(
    (range: Range): number[] => {
      const items = defaultRangeExtractor(range);
      if (!isTableIslandEnabled()) return items;
      return rangeIndex.collapse(items).filter((i) => {
        const r = rangeIndex.rangeAt(i);
        // 与折叠区间相交的表：不折叠（宿主行与内部行都按旧路径逐行渲染）
        return !r || r.startLine !== i || isEligible(r);
      });
    },
    [rangeIndex, isEligible]
  );

  // ── ③ 行高估算（与 HeightMap/oracle 同源口径：按真实列宽逐列 wrap）────────
  const estimateRowHeight = React.useCallback(
    (lineIndex: number): number => {
      const s = store.getState();
      const raw = s.getLine(lineIndex) ?? '';
      const st = getLineState(s, lineIndex);
      const kind = classifyLine(raw, st);
      if (kind === 'table_separator') return 0;
      const oracle = oracleRef.current;
      if (!oracle) return 28;
      return oracle.predict(kind, raw, st, tableColWidthsAtLine(s.getLine, lineIndex));
    },
    [store, oracleRef]
  );

  const estimateIslandHeight = React.useCallback(
    (range: TableRangeInfo): number => {
      let h = 0;
      for (let i = range.startLine; i <= range.endLine; i++) h += estimateRowHeight(i);
      return Math.max(ISLAND_MIN_HEIGHT, h);
    },
    [estimateRowHeight]
  );

  // ── ② 高度单源：岛宿主行承载整表高度，内部行一律 0（I3）──────────────────
  /** 内部行置 0（HeightMap + tanstack 测量缓存两侧；已为 0 时零写入）。 */
  const zeroInternalRows = React.useCallback(
    (range: TableRangeInfo) => {
      const hm = heightMapRef.current;
      if (!hm) return;
      rangeIndex.forEachInternalRow(range, (line) => {
        // setHeight 内置 0.5px 稳定点护栏：已为 0 时返回 false，不触碰 virtualizer
        if (hm.setHeight(line, 0)) virtualizer.resizeItem(line, 0);
      });
    },
    [heightMapRef, rangeIndex, virtualizer]
  );

  const applyHeightProtocol = React.useCallback(
    (items: readonly { index: number }[]) => {
      if (!isTableIslandEnabled()) return;
      const hm = heightMapRef.current;
      if (!hm) return;
      for (const item of items) {
        const r = hostAt(item.index);
        if (!r) continue;
        const measured = islandHeightsRef.current.get(r.id);
        const h = measured ?? estimateIslandHeight(r);
        if (hm.setHeight(r.startLine, h)) virtualizer.resizeItem(r.startLine, h);
        zeroInternalRows(r);
      }
    },
    [heightMapRef, hostAt, estimateIslandHeight, virtualizer, zeroInternalRows]
  );

  /** `estimateSize` 的单点查询：内部行 → 0；宿主行 → 已落库高度 / 初值估算。 */
  const estimateSizeAt = React.useCallback(
    (index: number): number | null => {
      if (!isTableIslandEnabled()) return null;
      const r = rangeIndex.rangeAt(index);
      if (!r) return null;
      if (r.startLine !== index) return 0;
      const h = heightMapRef.current?.getHeight(index);
      return Math.round(h !== undefined ? h : estimateIslandHeight(r));
    },
    [rangeIndex, heightMapRef, estimateIslandHeight]
  );

  // ── 岛高上报回调（唯一上报源；按行号缓存保持引用稳定）────────────────────
  const reportCallbacksRef = React.useRef(new Map<number, (h: number) => void>());
  const onIslandHeight = React.useCallback(
    (startLine: number): ((height: number) => void) => {
      const cached = reportCallbacksRef.current.get(startLine);
      if (cached) return cached;
      const cb = (height: number) => {
        const hm = heightMapRef.current;
        if (!hm || !Number.isFinite(height) || height <= 0) return;
        const range = rangeIndex.rangeAt(startLine);
        if (!range || range.startLine !== startLine) return;
        const oldH = hm.getHeight(startLine) ?? 0;
        // setHeight 内置稳定点护栏：|Δ| < 0.5px 不写（终止测量-上报-重排回环）
        if (!hm.setHeight(startLine, height)) return;
        islandHeightsRef.current.set(range.id, height);
        virtualizer.resizeItem(startLine, height);
        zeroInternalRows(range);
        hm.flush();
        // 滚动锚定：岛高变化发生在视口顶线之上时原子补偿 scrollTop，
        // 使阅读视口内内容绝对静止（与批量测量 effect 同源语义）。
        const el = scrollElRef.current;
        const item = virtualizer
          .getVirtualItems()
          .find((v) => v.index === startLine);
        if (
          el &&
          item &&
          item.start + oldH <= el.scrollTop &&
          followStateRef.current !== 'follow'
        ) {
          el.scrollTop += height - oldH;
        }
      };
      reportCallbacksRef.current.set(startLine, cb);
      return cb;
    },
    [
      heightMapRef,
      rangeIndex,
      virtualizer,
      zeroInternalRows,
      scrollElRef,
      followStateRef,
    ]
  );

  return {
    hostAt,
    rangeExtractor,
    onIslandHeight,
    estimateRowHeight,
    estimateIslandHeight,
    applyHeightProtocol,
    estimateSizeAt,
  };
}
