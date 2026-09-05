import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  useEditorStore,
  snapToGraphemeBoundary,
  type EditorStore,
  type EditorState,
} from '../core/EditorStore';
import {
  getCoordinatesFromIndex,
  getGlobalIndexFromDOMNode,
  getArrowNavigationIndex,
  toContainerCoords,
  locateRowIndexByPhysicalBisection,
} from '../core/measure';
import { useTableStore } from '../core/TableStore';
import {
  navigateTable,
  findTableRange,
  clearCell,
  setCellContent,
  parseRowCells,
} from '../core/TableOperations';
import { buildPasteText } from '../core/htmlToMarkdown';
import type { LineOffsetTree } from '../core/SegmentTree';
// B2 词级跳选（05 高频项 / P2 项 3）：词边界函数与搜索的全词判定
// 共用同一词类模型（wordClassAt / wordBoundary——字母数字段/中文段/
// 符号段），词边界语义单源（src/core/search.ts 文件头注释）
import { wordBoundary, wordClassAt } from '../core/search';
// B5 自动补全触发（触发检测/候选过滤为纯函数，见 src/core/autocomplete.ts）
import {
  findAutocompleteTriggerInLine,
  filterAutocompleteCandidates,
  getAutocompleteTriggers,
  getAutocompleteCandidates,
} from '../core/autocomplete';

interface HiddenInputProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /**
   * 显式 store 实例（R5 实例工厂）：缺省 = 全局默认单例（向后兼容）。
   * 多实例场景下输入层必须绑定与内容同一实例——本组件全部状态读写
   * （光标/选区/文本/组合/拖选）经 editorStore 闭包路由，实例隔离。
   */
  store?: EditorStore;
  /** 装饰版本号：语法展开/折叠切换时驱动 IME 输入框重新实测物理定位 */
  decorationVersion?: number;
}

// ============================================================
// 拖选坐标驱动（R4-G，04 编辑深度扩展 §3.3 方案 3：CM6 MouseSelection 简化版）
// ============================================================
// 设计：拖选 = 坐标驱动状态机——mousedown 记起点坐标，mousemove 超移动阈值
// （DRAG_THRESHOLD_PX）后进入拖选态：锚点 = 按下位置定位的光标位，head 由
// 「坐标 → 索引」持续更新（store.moveHead，anchor 不动——反向拖选天然正确，
// 04 §3.2 S1 修复），mouseup 结算。
// 「坐标 → 索引」单一真源 indexFromClientPoint：
// - 精确路径：caretRangeFromPoint → getGlobalIndexFromDOMNode（视口内命中，
//   token 级精确——与 MarkdownEngine handleContainerClick 同款链路）；
// - 几何路径（视口空白 / 目标行未挂载 / 无布局环境）：行几何估算——已挂载
//   行区间内定位或边界行 + 行高近似推算行号（虚拟化视口外断选修复，
//   04 §3.2 S2），列用字符宽度 Oracle 累加逼近（R2-F 列保持思路复用，
//   measure.ts predictColumn 同款算法）；
// - 视口外拖选：mousemove 压入/越出容器边缘时按距离步进滚动（CM6
//   dragScrollSpeed 简化版），滚动后目标行挂载即被精确路径接管。
// 拖选期间以引擎自绘高亮（SelectionHighlight）替代原生 DOM 选区：
// userSelect none + removeAllRanges 抑制浏览器原生选区（原生选区依赖 DOM
// 存在，虚拟化视口外必然断选）。纯几何函数（predictColumn /
// estimateLineIndexFromContentY）导出供单测。
// 与点击定位（MarkdownEngine handleContainerClick）的协调：mousedown 无
// 副作用（不移动光标不清选区），mousemove 超阈值才进拖选态——纯点击场景
// 零干预，click 定位独占；拖选结束以 __CRISH_LAST_DRAG_END_TIME 抑制合成
// click（既有机制，MarkdownEngine.tsx:532 检查）。

/** 拖选激活移动阈值（px）：mousedown 后 mousemove 超过该距离才进入拖选态，
 *  区分「点击定位」（click 由 MarkdownEngine handleContainerClick 处理）与
 *  「拖选」（引擎状态机接管）——纯点击场景 mousedown/mousemove 零副作用。 */
export const DRAG_THRESHOLD_PX = 3;
/** 视口边缘滚动触发带（px）：鼠标距容器可见区边缘小于该值即开始滚动 */
const EDGE_SCROLL_MARGIN = 16;
/** 单次 mousemove 最大滚动步长（px）：随距离线性增减（CM6 dragScrollSpeed） */
const EDGE_SCROLL_MAX_STEP = 12;
/** 已挂载行几何快照（视口内 + overscan；按 DOM 序 = 行号升序） */
export interface MountedLineGeom {
  /** 逻辑行号（data-index） */
  index: number;
  /** 行首全局偏移（data-line-start） */
  start: number;
  /** 行文本长度（data-line-length，不含换行符） */
  length: number;
  /** 行左缘（视口坐标，列预测基准） */
  left: number;
  /** 行顶 / 行底（容器内容坐标，与滚动解耦） */
  top: number;
  bottom: number;
  height: number;
  /** 行 DOM 节点（物理二分实测入口） */
  el?: HTMLElement;
}

/** 宽字符判定（全角按 2 倍等宽近似；镜像 measure.ts:753-763 列保持口径） */
function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xff60) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** 单字符预测宽度：Tab 按 4 倍等宽近似（源码中极少见，仅用于列估计） */
function charAdvance(code: number, w: { ascii: number; cjk: number }): number {
  if (code === 9) return w.ascii * 4;
  return isWideChar(code) ? w.cjk : w.ascii;
}

/**
 * 目标行列预测（R2-F 列保持思路复用，镜像 measure.ts:816-830 predictColumn）：
 * 以鼠标 X（相对行左缘）为参照，沿目标行文本按等宽/全角字宽累加，返回与
 * relX 最接近的字符位置——等宽/全角混排行中累加比「relX / 字宽」直接除法
 * 误差更小（全角占 2 倍宽但计 1 列）。relX ≤ 0 回行首；超出行宽回行尾。
 */
// oxlint-disable-next-line react/only-export-components
export function predictColumn(
  lineText: string,
  relX: number,
  widths: { ascii: number; cjk: number }
): number {
  if (relX <= 0) return 0;
  let best = 0;
  let bestDist = Infinity;
  let acc = 0;
  for (let p = 0; p <= lineText.length; p++) {
    if (p > 0) acc += charAdvance(lineText.charCodeAt(p - 1), widths);
    const dist = Math.abs(acc - relX);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

/**
 * 内容坐标 Y → 行号（纯函数：视口内命中 + 视口外估算，04 §3.3 方案 3）：
 * - 落在已挂载行覆盖区间内：行内定位（第一个 bottom ≥ Y 的行）；
 * - 视口上方：首行几何向上推算（above = ceil(ΔY / 首行高)）；
 * - 视口下方：末行几何向下推算（below = floor(ΔY / 末行高)）；
 * - 无已挂载行：回退第 0 行。
 * 多行块（代码/表格）行高差异引入的估算误差由「滚动后行挂载 →
 * caretRangeFromPoint 精确命中」接管（R2-F scrollTargetLineIntoView 同款
 * 思路）；行号收敛到 [0, lineCount-1]。mounted 按 top 升序（DOM 序 = 视觉序）。
 */
// oxlint-disable-next-line react/only-export-components
export function estimateLineIndexFromContentY(
  contentY: number,
  lineCount: number,
  mounted: MountedLineGeom[]
): number {
  if (lineCount <= 0) return 0;
  if (mounted.length === 0) return 0;
  const first = mounted[0];
  const last = mounted[mounted.length - 1];
  if (contentY < first.top) {
    const above = Math.ceil((first.top - contentY) / Math.max(1, first.height));
    return Math.max(0, first.index - above);
  }
  if (contentY > last.bottom) {
    const below = Math.floor(
      (contentY - last.bottom) / Math.max(1, last.height)
    );
    return Math.min(lineCount - 1, last.index + below);
  }
  // 已挂载区间内：二分定位「第一个 bottom ≥ contentY」的行
  let lo = 0;
  let hi = mounted.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (mounted[mid].bottom >= contentY) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return mounted[ans].index;
}

/** 拖选坐标 → 索引所需的数据层（store 快照的结构化子集，便于单测注入） */
export interface IndexDataLayer {
  getLine: (i: number) => string;
  getLineCount: () => number;
  lineOffsets: LineOffsetTree;
}

/**
 * 越视口目标 scrollTop 纯计算（几何外推公式，供单测）：
 * - 目标行在视口上方：以首行几何向上外推（留 SCROLL_EDGE_MARGIN 边距）；
 * - 目标行在视口下方：以末行几何向下外推，目标行对齐视口底部；
 * - 目标行已在视口区间内 → null（无需滚动，交由精确测量分支越界滚动）。
 * 返回钳制到 [0, maxScrollTop] 的 scrollTop。
 */
// oxlint-disable-next-line react/only-export-components
export function estimateScrollTopForLine(
  first: MountedLineGeom,
  last: MountedLineGeom,
  lineIdx: number,
  clientHeight: number,
  scrollHeight: number
): number | null {
  if (lineIdx >= first.index && lineIdx <= last.index) return null;
  let targetTop: number;
  if (lineIdx < first.index) {
    // 目标行在视口上方：以首行几何向上外推（留 40px 上边距）
    targetTop = first.top - (first.index - lineIdx) * first.height - 40;
  } else {
    // 目标行在视口下方：以末行几何向下外推，目标行对齐视口底部
    targetTop =
      last.bottom + (lineIdx - last.index) * last.height - clientHeight + 40;
  }
  const maxTop = Math.max(0, scrollHeight - clientHeight);
  return Math.min(maxTop, Math.max(0, targetTop));
}

/**
 * 光标行滚入视口（B2 发现并修复的越视口导航缺陷）：光标测量失败且
 * 目标行未挂载（虚拟化视口外跳转——Ctrl+End/PageDown/搜索跳转到长
 * 文档首尾）时，用已挂载行几何外推目标 scrollTop（O(1)：首/末行
 * 几何 ± 行高 × 行距），滚动后下一帧行挂载即被精确测量接管——与
 * 拖选视口外估算（estimateLineIndexFromContentY）同一「几何近似 →
 * 挂载后精确」架构思路。修复前：测量 10 帧失败 → HiddenInput 卸载
 * textarea → 键盘输入/词级导航整体失效（长文档 Ctrl+End 后无法输入）。
 * 行已在视口内（lineIdx 落在挂载区间）时为空操作（滚动由精确测量
 * 分支的越界滚动接管，避免双写）。
 */
// oxlint-disable-next-line react/only-export-components
export function scrollLineIntoViewByGeometry(
  container: HTMLElement,
  lineIdx: number
): void {
  const mounted = collectMountedLines(
    container,
    container.getBoundingClientRect()
  );
  if (mounted.length === 0) return;
  const first = mounted[0];
  const last = mounted[mounted.length - 1];
  const targetTop = estimateScrollTopForLine(
    first,
    last,
    lineIdx,
    container.clientHeight,
    container.scrollHeight
  );
  if (targetTop === null) return;
  container.scrollTop = targetTop;
}

// 已挂载行几何收集（视口内行元素 → 几何快照；仅几何回退路径调用，
// 视口内正常拖选走 caretRangeFromPoint 精确命中，零额外扫描）
function collectMountedLines(
  container: HTMLElement,
  cr: DOMRect
): MountedLineGeom[] {
  const rows = container.querySelectorAll('[data-line-start]');
  const out: MountedLineGeom[] = [];
  for (let i = 0; i < rows.length; i++) {
    const el = rows[i] as HTMLElement;
    const index = parseInt(el.getAttribute('data-index') || '-1', 10);
    if (index < 0) continue;
    const r = el.getBoundingClientRect();
    out.push({
      index,
      start: parseInt(el.getAttribute('data-line-start') || '0', 10),
      length: parseInt(el.getAttribute('data-line-length') || '0', 10),
      left: r.left,
      top: r.top - cr.top + container.scrollTop,
      bottom: r.bottom - cr.top + container.scrollTop,
      height: r.height,
      el,
    });
  }
  return out;
}

// 容器内容左缘（视口坐标）：目标行未挂载（视口外）时用作列预测基准
function contentLeftOf(container: HTMLElement, cr: DOMRect): number {
  const cs = window.getComputedStyle(container);
  return cr.left + container.scrollLeft + (parseFloat(cs.paddingLeft) || 0);
}

// 字符宽度 Oracle 回退（无布局环境/未挂载时）：0.6 × 字号等宽 + 2 倍全角
// （与 measure.ts:794-796 回退同口径；等宽栈下与实测误差 ≤ 1 字符）
function fallbackCharWidths(container: HTMLElement): {
  ascii: number;
  cjk: number;
} {
  const fs = parseFloat(window.getComputedStyle(container).fontSize) || 14;
  const ascii = fs * 0.6;
  return { ascii, cjk: ascii * 2 };
}

/**
 * 坐标 → 索引（拖选状态机单一真源）：
 * 1. 精确路径：caretRangeFromPoint 浏览器命中测试（视口内 token 级）；
 * 2. 物理二分实测：命中行 DOM 真实 TextNode Range 精确二分定位（零字体猜测误差）；
 * 3. 几何回退：行几何估算（视口空白 / 目标行未挂载 / 无布局环境）。
 * 返回文档索引（几何回退保证非空；行号收敛 [0, lineCount-1]）。
 */
// oxlint-disable-next-line react/only-export-components
export function indexFromClientPoint(
  clientX: number,
  clientY: number,
  container: HTMLElement,
  data: IndexDataLayer,
  hintLineIndex?: number
): number {
  const cr = container.getBoundingClientRect();
  const mounted = collectMountedLines(container, cr);
  let lineIdx = hintLineIndex;
  if (lineIdx === undefined || lineIdx < 0 || lineIdx >= data.getLineCount()) {
    const contentY = clientY - cr.top + container.scrollTop;
    lineIdx = estimateLineIndexFromContentY(
      contentY,
      data.getLineCount(),
      mounted
    );
  }
  const lineText = data.getLine(lineIdx) ?? '';
  const lineStart = data.lineOffsets.getOffset(lineIdx);
  const lineGeom = mounted.find((m) => m.index === lineIdx);

  // 1. 物理二分优先：基于真实挂载 DOM 文本节点的 Range 测量，亚像素级物理贴合 (|ΔX| ≤ 0.5px)
  // 彻底免疫 caretRangeFromPoint 在前缀语法（### / > ）、空隙与行末的飘移问题
  if (lineGeom && lineGeom.el) {
    const bisectIdx = locateRowIndexByPhysicalBisection(
      lineGeom.el,
      clientX,
      lineStart,
      lineText.length
    );
    if (bisectIdx !== null) return bisectIdx;
  }

  // 2. 次级回退：caretRangeFromPoint（若物理二分未命中可见文本）
  if (typeof document.caretRangeFromPoint === 'function') {
    try {
      const range = document.caretRangeFromPoint(clientX, clientY);
      if (range && range.startContainer) {
        const idx = getGlobalIndexFromDOMNode(
          range.startContainer,
          range.startOffset,
          container
        );
        if (idx !== null) return idx;
      }
    } catch {
      // 命中测试失败（无布局环境/异常）→ 几何回退
    }
  }

  // 3. 末级回退：几何列宽推算
  const relX = lineGeom
    ? clientX - lineGeom.left
    : clientX - contentLeftOf(container, cr);
  const col = predictColumn(lineText, relX, fallbackCharWidths(container));
  return lineStart + Math.min(col, lineText.length);
}

/**
 * 视口边缘滚动步长（CM6 dragScrollSpeed 简化版）：鼠标越出容器可见区或压入
 * 边缘 EDGE_SCROLL_MARGIN 内时返回滚动量（越近越大，封顶
 * EDGE_SCROLL_MAX_STEP）；否则 0。正数 = 内容向下滚动（scrollTop 增大）。
 */
function edgeScrollStep(clientY: number, container: HTMLElement): number {
  const cr = container.getBoundingClientRect();
  const above = cr.top - clientY;
  const below = clientY - cr.bottom;
  if (above > 0) return -Math.min(EDGE_SCROLL_MAX_STEP, Math.max(4, above));
  if (below > 0) return Math.min(EDGE_SCROLL_MAX_STEP, Math.max(4, below));
  const fromTop = clientY - cr.top;
  const fromBottom = cr.bottom - clientY;
  if (fromTop < EDGE_SCROLL_MARGIN) return -(EDGE_SCROLL_MARGIN - fromTop);
  if (fromBottom < EDGE_SCROLL_MARGIN) return EDGE_SCROLL_MARGIN - fromBottom;
  return 0;
}

/**
 * 定位 pos 所在行的文本区间 [start, end)（start 为行首偏移、
 * end 为换行符偏移/文档末尾——不含换行符本身）。
 * 与 Enter 列表续写分支的既有行区间扫描同款语义，抽为纯函数便于单测。
 */
// oxlint-disable-next-line react/only-export-components
export function lineRangeAt(
  text: string,
  pos: number
): { start: number; end: number } {
  let start = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (text[i] === '\n') {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = pos; i < text.length; i++) {
    if (text[i] === '\n') {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * 无选区复制整行内容（04 §5.2 C5 linewise copy / CM6 copiedRange 对齐）：
 * 整行文本 + 换行符（VS Code 整行复制语义：粘贴到行尾自动换行）。
 */
// oxlint-disable-next-line react/only-export-components
export function linewiseCopyContent(text: string, pos: number): string {
  const { start, end } = lineRangeAt(text, pos);
  return text.substring(start, end) + '\n';
}

// ============================================================
// a11y 无障碍（R4-H，04 编辑深度扩展 §6.3 短程方案 1）
// ============================================================
// 设计：隐藏 textarea 的 value 恒为 '' 时屏幕阅读器（SR）读不到任何文档
// 内容（A1）。短程三项：
// 1. textarea 语义：aria-label（含占位符/行同步说明）+ role="textbox" +
//    aria-multiline——SR 焦点进入编辑器即听到「Markdown 编辑器」；
// 2. 光标行 value 同步：只把光标所在行文本同步进 value（不做全文同步——
//    大文档性能不可接受，对齐 VS Code 屏幕阅读器思路）。与 R4-C IME
//    value 缓冲的协调（三条门）：合成期（isComposingRef + 活跃组合组 +
//    pending flush 窗口）value 是组合缓冲载体，绝不覆盖；编辑直刷（行
//    视图变化）后保持 handleInput 的「提交后清空」空缓冲不变量——防同步
//    行文本被浏览器当作输入内容二次插入（handleBeforeInput 兜底清空）；
// 3. aria-live 播报：光标/选区变化时以 polite 轻量播报「第 N 行，第 M 列」
//    （有选区附选中字符数）；同位置不重复 + 时间节流双保险防刷屏。
/** aria-live 播报时间节流（ms）：同一窗口内不重复推送（拖选/快速按键） */
export const ANNOUNCE_THROTTLE_MS = 250;

/**
 * 播报文案格式化（纯函数，供单测）：「第 N 行，第 M 列」（1 起）——
 * 有选区（selectedCount > 0）时附加「已选中 X 个字符」。
 */
// oxlint-disable-next-line react/only-export-components
export function formatAnnouncement(
  line: number,
  col: number,
  selectedCount: number | null
): string {
  const base = `第 ${line + 1} 行，第 ${col} 列`;
  return selectedCount !== null && selectedCount > 0
    ? `${base}，已选中 ${selectedCount} 个字符`
    : base;
}

// 组合结束后的提交延迟窗口（对齐 04 §2.3 方案 2 / CM6 input.ts:843-847
// 的 50ms 清理策略）：compositionend 后浏览器可能延迟写入最终文本
// （Safari dead-key）或在窗口内开启新一轮合成（Android 预测、候选替换的
// 中途 flush）——窗口内新一轮 compositionstart 沿用同 compositionGroupId
// 继续累积 value，窗口到期后以 textarea.value 为准一次性提交。
const FLUSH_DELAY_MS = 50;

/**
 * 翻页目标行计算（P2 项 4 键盘增强：PageUp/PageDown）：
 * 以「已挂载行几何」为视口行号来源（HeightMap.indexAt 像素→行的 DOM
 * 等价实现）：视口顶行 = 第一个 bottom > scrollTop 的行，视口底行 =
 * 最后一个 top < scrollTop + clientHeight 的行；页行数 = 顶底行号差
 * （≥1，行高不均匀时近似，与 CM6 页翻语义同量级）：
 * - PageUp 目标行 = 顶行 − 页行数（上翻一屏后位于新视口顶部的行）；
 * - PageDown 目标行 = 底行 + 页行数；
 * 收敛到 [0, lineCount-1]。滚动跟随由 HiddenInput 的光标越界滚动 effect
 * 接管（目标行视口外时自动滚入，与 ArrowUp/Down 同机制）。
 */
// oxlint-disable-next-line react/only-export-components
export function pageNavigationTarget(
  direction: 'up' | 'down',
  scrollTop: number,
  clientHeight: number,
  lineCount: number,
  mounted: MountedLineGeom[]
): number {
  if (lineCount <= 0 || mounted.length === 0) return 0;
  const top = scrollTop;
  const bottom = top + clientHeight;
  // 视口顶行：第一个 bottom > scrollTop 的行（其前所有行都在视口上方）
  let firstIdx = mounted[mounted.length - 1].index;
  for (const m of mounted) {
    if (m.bottom > top) {
      firstIdx = m.index;
      break;
    }
  }
  // 视口底行：最后一个 top < scrollTop + clientHeight 的行
  let lastIdx = mounted[0].index;
  for (const m of mounted) {
    if (m.top < bottom) lastIdx = m.index;
    else break;
  }
  const pageLines = Math.max(1, lastIdx - firstIdx);
  if (direction === 'up') return Math.max(0, firstIdx - pageLines);
  return Math.min(lineCount - 1, lastIdx + pageLines);
}

/**
 * 词级导航目标位置（B2 项 3：Ctrl+Arrow，R6-P1 行文本模式同款架构）：
 * 定位光标所在行（LineOffsetTree O(log n)）+ 行内词边界
 * （wordBoundary——字母数字段/中文段/符号段）+ 行边界显式跨行：
 * - 行首向左 → 上一行行尾（= 本行行首 - 1，跨过换行符）；
 * - 行尾向右 → 下一行行首（= 行尾 + 1）；
 * - 文档首行行首 / 末行行尾 → 原地不动。
 * 与 moveGrapheme（EditorStore）的跨行语义同构——词级粒度版本。
 * 返回新全局位置（恒为词边界）。
 */
// oxlint-disable-next-line react/only-export-components
export function wordNavigation(
  pos: number,
  dir: 'left' | 'right',
  getLine: (i: number) => string,
  lineOffsets: LineOffsetTree,
  textLength: number
): number {
  const p = Math.max(0, Math.min(pos, textLength));
  const lineIdx = lineOffsets.findLineIndex(p);
  const lineStart = lineOffsets.getOffset(lineIdx);
  const lineText = getLine(lineIdx) ?? '';
  const inLine = p - lineStart;
  if (dir === 'left') {
    // 行内向左：词段首（行内词边界；不跨 \n——行文本不含换行符）
    if (inLine > 0) return lineStart + wordBoundary(lineText, inLine, 'left');
    // 行首向左：跨到上一行行尾；文档首行行首原地不动
    return lineIdx > 0 ? lineStart - 1 : 0;
  }
  // 行内向右：词段尾
  if (inLine < lineText.length) {
    return lineStart + wordBoundary(lineText, inLine, 'right');
  }
  // 行尾向右：跨到下一行行首；文档末尾行尾原地不动
  if (p >= textLength) return p;
  return lineStart + lineText.length + 1;
}

/**
 * 双击选词的词区间（B2 项 3：双击词选——独立处理，不并入拖选
 * 状态机——双击是「两次 click 已定位光标后的独立动作」，纯函数
 * 供 HiddenInput dblclick 接线与单测）：
 * - inLine 处字符为词字符（字母数字/中文段）→ 返回该词段
 *   [start, end)（行内偏移；wordBoundary 双向扩展）；
 * - 空白/符号段双击 → null（与主流编辑器一致：双击空白/符号
 *   不选词，保持光标定位语义）。
 */
// oxlint-disable-next-line react/only-export-components
export function doubleClickWordSelection(
  lineText: string,
  inLine: number
): { start: number; end: number } | null {
  if (inLine < 0 || inLine >= lineText.length) return null;
  const cls = wordClassAt(lineText[inLine]);
  if (cls !== 'word' && cls !== 'cjk') return null;
  // 左边界：从 inLine + 1 向左（wordBoundary 的 pos 是「光标位于
  // 字符间」的语义——左侧字符 text[inLine] 必属该词段，段首正确）；
  // 右边界：从 inLine 向右越出词段
  const start = wordBoundary(lineText, inLine + 1, 'left');
  const end = wordBoundary(lineText, inLine, 'right');
  return { start, end };
}

// ============================================================
// 拖放文件/文本（B5 项 4：drop 事件 → FileReader.readAsText → 插入光标处）
// ============================================================
// 设计：
// - 事件层薄壳（组件内注册 dragenter/dragover/dragleave/drop），核心
//   决策与落盘抽为模块级纯函数（planDropInsert / applyDroppedContent），
//   便于单测——jsdom 无法构造真实 DataTransfer，测试以行为级等价
//   的对象字面量 + FileReader mock 注入（限制说明见 dnd.test.ts）；
// - 文件拖入：扩展名白名单（md/txt 等）→ readDroppedFile（UTF-8 文本
//   读取）→ 替换「drop 时刻的选区」（与粘贴语义一致，单步 undo）；
// - 文本拖入（含源内文本移动的落点——引擎自绘拖选 + userSelect none
//   下原生文本拖移不可行，「拖选 → 剪切 → 目标处拖入文本」为等价路径，
//   源内移动本身登记为低优先级不做）：读 text/plain 同步插入；
// - 悬停高亮：fixed 全屏 overlay（内联样式 + data-drag-drop-overlay，
//   css-contract G6 豁免策略一致——不新增未登记 className）；
// - 组合期（IME）不接管（与 paste 同款红线）。

/** 拖入文件扩展名白名单（.md/.markdown/.txt 等；小写匹配） */
// oxlint-disable-next-line react/only-export-components
export const SUPPORTED_DROP_EXTENSIONS = [
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.log',
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
] as const;

/** 拖入文件名是否在白名单内（纯函数，供单测） */
// oxlint-disable-next-line react/only-export-components
export function isSupportedDroppedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_DROP_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** drop 载荷决策（纯函数）：Files 优先（白名单校验）→ text/plain 兜底
 *  → 无内容。types 为空数组视为无（jsdom 测试注入兼容） */
// oxlint-disable-next-line react/only-export-components
export function planDropInsert(
  types: readonly string[],
  files: readonly File[],
  plainText: string
):
  | { kind: 'file'; file: File }
  | { kind: 'text'; text: string }
  | { kind: 'none' } {
  const hasFiles = Array.from(types ?? []).some(
    (t) => t.toLowerCase() === 'files'
  );
  const hasText = Array.from(types ?? []).some(
    (t) => t.toLowerCase() === 'text/plain'
  );
  if (hasFiles && files.length > 0) {
    const file = files[0];
    if (!isSupportedDroppedFile(file.name)) return { kind: 'none' };
    return { kind: 'file', file };
  }
  if (hasText && plainText.length > 0) {
    return { kind: 'text', text: plainText };
  }
  return { kind: 'none' };
}

/**
 * 文件 → UTF-8 文本（Promise 封装，可 mock 注入——jsdom 的 FileReader
 * 行为不可靠，测试经 stubGlobal 替换，见 dnd.test.ts 限制说明）。
 */
// oxlint-disable-next-line react/only-export-components
export function readDroppedFile(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () =>
      reject(reader.error ?? new Error('FileReader 读取失败'));
    reader.readAsText(file);
  });
}

/**
 * 应用拖放内容（纯落盘函数，供单测）：文件 → 异步读取（空内容跳过，
 * 防 applyChange(from, to, '') 误删选区）→ store.applyChange 替换
 * [from, to)（drop 时刻的选区快照，与粘贴语义一致）→ 返回是否落盘。
 * store 参数为 EditorState 子集（applyChange 所在层——组件侧传入
 * getState() 快照，applyChange 为稳定引用，异步回调安全）。
 */
// oxlint-disable-next-line react/only-export-components
export async function applyDroppedContent(
  plan: { kind: 'file'; file: File } | { kind: 'text'; text: string },
  store: Pick<EditorState, 'applyChange'>,
  from: number,
  to: number
): Promise<boolean> {
  const content =
    plan.kind === 'file' ? await readDroppedFile(plan.file) : plan.text;
  if (content.length === 0) return false;
  store.applyChange(from, to, content, { merge: 'none' });
  return true;
}

export const HiddenInput: React.FC<HiddenInputProps> = ({
  containerRef,
  store,
  decorationVersion,
}) => {
  // R5：绑定实例 store（缺省回退全局单例）；组件内所有 store 读写
  // （订阅 / getState / setState）统一经本变量，多实例输入互不串台
  const editorStore = store ?? useEditorStore;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorPos = editorStore((state) => state.cursorPos);
  const insertText = editorStore((state) => state.insertText);
  const deleteText = editorStore((state) => state.deleteText);
  const setCursorPos = editorStore((state) => state.setCursorPos);
  const setSelection = editorStore((state) => state.setSelection);
  // R6-P1 物化惰性化：不再订阅物化视图 state.lines（读取会触发惰性
  // 物化——append@1M 流式期间每次 set 的选择器求值 O(全文) concat），
  // 改为订阅双段存储引用信号 + 行数（与 MarkdownEngine R3-B1 同款）：
  // 任何内容变更（编辑/append/undo/flush）都至少换其一新引用，
  // 覆盖原物化视图引用变化的触发语义；行内容/行数读取经访问器。
  const mainLines = editorStore((state) => state.mainLines);
  const streamTail = editorStore((state) => state.streamTail);
  const lineCount = editorStore((state) => state.getLineCount());
  const selectionStart = editorStore((state) => state.selectionStart);
  const selectionEnd = editorStore((state) => state.selectionEnd);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    height: number;
  } | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  // B5 拖放：文件拖入悬停高亮（全屏 overlay，内联样式 + data 属性）
  const [dragOverlayVisible, setDragOverlayVisible] = useState(false);

  // —— IME 合成状态机（R4-C，04 §2 深水区）——
  // 设计：合成期间文本变更一律缓冲（不清空 value、不逐次提交 store），
  // compositionend 后进入 50ms pending flush 延迟窗口，以 textarea.value
  // 为准一次性提交——value 是浏览器最终承诺文本，不依赖 e.data（Android/
  // Safari 空 data 丢字修复）。同一用户合成被浏览器拆成多轮 composition
  // 会话（候选替换、Android 预测、拼写纠错中途 flush）时，50ms 窗口内的
  // 新一轮 compositionstart 沿用同 compositionGroupId，value 持续累积、
  // 最终一次提交 → 整段组合 = 一个 undo 步（撤销粒度，04 §2.2 I4）。
  // 事件回调（含 setTimeout 闭包）读取 state 可能拿到旧值，组合真值
  // 全部走 ref 同步读写；isComposing state 仅供样式/光标隐藏消费。
  const isComposingRef = useRef(false);
  /** compositionGroupId 自增序列（每次「新组合会话」开组 +1） */
  const compositionGroupSeq = useRef(0);
  /** 活跃组合组：组开始时的替换区间快照（id 供延续判定，from/to 供提交） */
  const activeCompositionGroup = useRef<{
    id: number;
    from: number;
    to: number;
  } | null>(null);
  /** 最近一次 compositionend 时间戳（50ms 窗口内开新组 = 同组合延续） */
  const lastCompositionEndAt = useRef(0);
  /** 50ms pending flush 定时器句柄（null = 无待提交组合） */
  const pendingFlushTimer = useRef<number | null>(null);

  // —— 拖选状态机（R4-G，04 §3.3 方案 3 / CM6 MouseSelection 简化版）——
  // ref 级状态（不触发渲染；拖选期间 store 选区驱动引擎自绘高亮）：
  // startX/Y：mousedown 坐标（阈值判定 + 锚点定位用）；
  // anchor：拖选锚点（激活时 = mousedown 位置定位的光标位，此后固定）；
  // lastIndex：上次 head 索引（同索引跳过 moveHead——mousemove 高频去抖）；
  // active：是否已进入拖选态（mousemove 超阈值）；suppressed：原生选区抑制中。
  const dragSelectRef = useRef<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    anchor: number;
    lastIndex: number;
    active: boolean;
    suppressed: boolean;
    rafId: number | null;
  } | null>(null);

  const prevCursorPosRef = useRef<number>(cursorPos);
  const prevSelectionStartRef = useRef<number | null>(selectionStart);
  const prevSelectionEndRef = useRef<number | null>(selectionEnd);

  // Sync input value with current line text
  useLayoutEffect(() => {
    // Sync physical coordinates whenever cursor or text changes
    if (!containerRef.current) return;

    const cursorMoved =
      prevCursorPosRef.current !== cursorPos ||
      prevSelectionStartRef.current !== selectionStart ||
      prevSelectionEndRef.current !== selectionEnd;
    prevCursorPosRef.current = cursorPos;
    prevSelectionStartRef.current = selectionStart;
    prevSelectionEndRef.current = selectionEnd;

    let rAF: number;
    let retries = 0;
    const updateCoords = () => {
      // W1-2（M2c 根因修复，docs/streaming-render/00 总方案 S-EL-11）：
      // 流式会话（store.streamActive 为 true = 流式追加进行中，W2-1 D-1
      // 换源——旧判定 streamOp !== null；只读快路径 streamOp 恒 null 但
      // 信号照常置位，门禁语义一致）期间短路光标滚动跟随——注入的每帧
      // 提交都触发本 effect 重跑，而光标行（用户未动时停在文档首部/旧
      // 位置）在虚拟视口外 → 越界滚动分支会把用户 scrollTop 抢拉到光标
      // 行（perf M2c 实测 253027→3513 复位锁死，suite README 异常登记③；
      // 随后 tanstack resizeItem 的纠滚又逐帧递减拉到 0）。流式期间光标
      // 移动是 appendText 的记账平移（非用户意图），滚动跟随语义无意义；
      // 编辑路径（streamActive 为 false）行为完全不变。
      if (editorStore.getState().streamActive === true) return;
      const rect = getCoordinatesFromIndex(cursorPos, containerRef.current);
      if (rect) {
        // 视口坐标 → 容器内容坐标（与 CursorLayer 共用换算；测量结果由
        // measure 模块的同帧缓存共享，两组件同帧仅一次全量测量）
        const { top, left, height } = toContainerCoords(
          rect,
          containerRef.current!
        );

        setCoords({ top, left, height });

        const cTop = containerRef.current!.scrollTop;
        const cHeight = containerRef.current!.clientHeight;

        // Fix for "反反复复刷屏" (Repeated bouncing during native mouse drag)
        // If the user is physically dragging the mouse outside the viewport,
        // the browser natively triggers an OS-level drag-scroll loop.
        // We MUST NOT fight the browser by setting scrollTop manually here,
        // otherwise react-virtual and the browser scroll will fight each other causing a bounce loop.
        if (!(window as any).__CRISH_IS_MOUSE_DOWN) {
          if (cursorMoved) {
            if (top < cTop) {
              containerRef.current!.scrollTop = Math.max(0, top - 40);
            } else if (top + height > cTop + cHeight) {
              containerRef.current!.scrollTop = top + height - cHeight + 40;
            }
          }
        }
      } else if (cursorMoved && retries < 10) {
        retries++;
        // 光标行未挂载（越视口跳转——Ctrl+End/PageDown/搜索跳转后行在
        // 虚拟化视口外）：几何外推滚动到光标行，下一帧行挂载后精确
        // 测量接管（scrollLineIntoViewByGeometry 注释见模块级定义；
        // B2 词级跳选实测发现并修复：长文档 Ctrl+End 后测量持续失败 →
        // textarea 卸载 → 输入/词级导航失效）
        // 仅在光标或选区主动变化时才拉动滚动条，避免用户浏览文档时滚动条弹回光标
        const st = editorStore.getState();
        scrollLineIntoViewByGeometry(
          containerRef.current!,
          st.lineOffsets.findLineIndex(cursorPos)
        );
        rAF = requestAnimationFrame(updateCoords);
      } else {
        setCoords(null);
      }
    };
    updateCoords();

    return () => {
      if (rAF) cancelAnimationFrame(rAF);
    };
  }, [
    cursorPos,
    selectionStart,
    selectionEnd,
    containerRef,
    mainLines,
    streamTail,
    lineCount,
    decorationVersion,
  ]);

  // —— a11y 光标行 value 同步 + aria-live 播报（R4-H，04 §6.3 短程）——
  // prevLinesRef：本次渲染「行视图是否变化」判据（导航 = 行未变光标动；
  // 编辑 = 行已变）。行变化（打字/粘贴/撤销等直刷）时同步与播报都跳过：
  // 同步保持「提交后 value 清空」的空缓冲不变量（浏览器在空缓冲上插入
  // 本次输入，input 整体提交）；播报避免逐字轰炸（SR 对字符输入有自身
  // 朗读通道）。
  // R6-P1：判据由「物化 lines 引用」改为「双段引用 + 行数」组合信号
  // （任何内容变更必然换 mainLines/streamTail 引用或改行数——与物化
  // 视图引用变化语义等价，但零物化触发）。
  const prevMainLinesRef = useRef<string[] | null>(null);
  const prevStreamTailRef = useRef<string[] | null>(null);
  const prevLineCountRef = useRef<number | null>(null);
  /** 播报去重键：上一次播报的「行:列」（同位置不重复） */
  const lastAnnouncePosRef = useRef('');
  /** 播报节流：上一次播报时间戳（ANNOUNCE_THROTTLE_MS 窗口内不推送） */
  const lastAnnounceAtRef = useRef(-Infinity);
  /** 播报文案（aria-live polite 节点承载，SR 朗读） */
  const [announcement, setAnnouncement] = useState('');
  /** textarea 挂载态（coords 是否已定位）：首帧 coords null → 无 textarea，
   *  挂载后置 true 补一次同步（见下方依赖注释） */
  const textareaMounted = coords !== null;

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    const linesChanged =
      prevMainLinesRef.current !== null &&
      (prevMainLinesRef.current !== mainLines ||
        prevStreamTailRef.current !== streamTail ||
        prevLineCountRef.current !== lineCount);
    prevMainLinesRef.current = mainLines;
    prevStreamTailRef.current = streamTail;
    prevLineCountRef.current = lineCount;
    if (linesChanged) return;
    // 合成期（含 compositionend 后 50ms pending flush 窗口）：value 是
    // 组合缓冲载体（R4-C 状态机），同步/播报一律跳过，绝不覆盖缓冲
    if (isComposingRef.current || activeCompositionGroup.current) return;
    if (pendingFlushTimer.current !== null) return;
    const s = editorStore.getState();
    const lineIdx = s.getLineIndex(cursorPos);
    const lineText = s.getLine(lineIdx) ?? '';
    // 光标行 value 同步：屏幕阅读器可读当前行内容（getLine 统一行访问器，
    // 与 R4-C 提交后的清空语义无冲突——见 handleBeforeInput 兜底清空）
    if (ta && ta.value !== lineText) {
      ta.value = lineText;
    }
    // 光标位置/选区变化轻量播报（polite）：「第 N 行，第 M 列」+ 选中数
    const lineStart = s.lineOffsets.getOffset(lineIdx);
    const col = Math.min(lineText.length + 1, cursorPos - lineStart + 1);
    const selectedCount =
      s.selectionStart !== s.selectionEnd
        ? s.selectionEnd - s.selectionStart
        : null;
    const posKey = `${lineIdx}:${col}`;
    if (posKey === lastAnnouncePosRef.current) return; // 同位置不重复
    const now = Date.now();
    if (now - lastAnnounceAtRef.current < ANNOUNCE_THROTTLE_MS) return; // 时间节流
    lastAnnouncePosRef.current = posKey;
    lastAnnounceAtRef.current = now;
    setAnnouncement(formatAnnouncement(lineIdx, col, selectedCount));
    // 依赖取布尔 textareaMounted 而非 coords 对象：coords 每次 setCoords 都
    // 是新对象（光标移动重测），若直接依赖会导致本 effect 在坐标重渲染时
    // 重复执行、linesChanged 判据失效（编辑提交后被误同步）；布尔切换只在
    // textarea 挂载/卸载时变化（首帧 coords null → 挂载后补一次同步）
  }, [
    cursorPos,
    selectionStart,
    selectionEnd,
    mainLines,
    streamTail,
    lineCount,
    textareaMounted,
  ]);

  useEffect(() => {
    const handleSelectionChange = () => {
      if (!containerRef.current) return;
      const selection = window.getSelection();
      if (isComposing) {
        setIsComposing(false);
      }
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        console.log('handleSelectionChange: collapsed or no selection');
        return;
      }

      const range = selection.getRangeAt(0);

      // Try to find the start and end DOM nodes
      const startIdx = getGlobalIndexFromDOMNode(
        range.startContainer,
        range.startOffset,
        containerRef.current
      );
      const endIdx = getGlobalIndexFromDOMNode(
        range.endContainer,
        range.endOffset,
        containerRef.current
      );

      console.log('handleSelectionChange: range', {
        startIdx,
        endIdx,
        s: range.startContainer,
        e: range.endContainer,
      });

      if (startIdx !== null && endIdx !== null) {
        const s = Math.min(startIdx, endIdx);
        const e = Math.max(startIdx, endIdx);

        // If it's a drag or double-click selection, update store.
        // If it's a collapsed click (s === e), we IGNORE it here because MarkdownEngine.tsx's onClick
        // will handle it using caretRangeFromPoint, which is more precise.
        // This prevents the "two cursor changes" jitter on mousedown -> click.
        if (s !== e) {
          editorStore.setState({
            cursorPos: e,
            selectionStart: s,
            selectionEnd: e,
          });
        }
      }
    };

    // Keep focus
    const handleGlobalClick = () => {
      // If text is selected on the screen, DO NOT steal focus!
      // Stealing focus will immediately destroy the user's DOM text selection.
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return;
      }
      textareaRef.current?.focus();
    };

    const handleGlobalMouseDown = () => {
      (window as any).__CRISH_IS_MOUSE_DOWN = true;
      // B5 自动补全：点击定位/拖选开始 → 关闭候选菜单（光标将移动）
      window.dispatchEvent(new Event('close-autocomplete-menu'));
    };
    const handleGlobalMouseUp = () => {
      (window as any).__CRISH_IS_MOUSE_DOWN = false;
      (window as any).__CRISH_CELL_TEXT_DRAG = null;
      const tableStore = useTableStore.getState();
      if (tableStore.isDraggingCell) {
        tableStore.setDraggingCell(false);
        (window as any).__CRISH_LAST_DRAG_END_TIME = Date.now();
      }
    };

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (handleTableInteraction(e)) {
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const state = editorStore.getState();
        if (state.selectionStart !== state.selectionEnd) {
          e.preventDefault();
          state.deleteSelection(state.selectionStart, state.selectionEnd);
          window.getSelection()?.removeAllRanges();
          // B5 自动补全：选区删除后光标移动，关闭候选菜单
          window.dispatchEvent(new Event('close-autocomplete-menu'));
          textareaRef.current?.focus();
        }
      }
    };

    // —— R4-G 拖选状态机（坐标驱动，04 §3.3 方案 3 / CM6 MouseSelection 简化版）——
    // mousedown：仅记录起点坐标与跳过条件（不移动光标、不清选区——纯点击
    // 场景零副作用，click 定位由 MarkdownEngine handleContainerClick 独占）；
    // mousemove 超阈值（DRAG_THRESHOLD_PX）后激活：锚点 = 按下位置定位的
    // 光标位（此时 click 尚未触发，故在激活瞬间以 mousedown 坐标定位），
    // 此后 head 由「坐标 → 索引」持续更新（store.moveHead，anchor 不动——
    // 反向拖选天然正确），mouseup 结算。
    // 拖选期间抑制原生 DOM 选区（userSelect none + removeAllRanges）：原生
    // 选区依赖 DOM 存在，虚拟化视口外必断选（04 §3.2 S2），引擎自绘高亮
    // （SelectionHighlight）替代；视口外拖选由边缘滚动 + 行几何估算兜底
    // （目标行未挂载时用边界行几何推算行号，滚动后行挂载即被精确
    // caretRangeFromPoint 命中接管——R2-F 列保持思路复用）。
    const handleDragMouseDown = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container || e.button !== 0) return;
      // 组合中不干预（R4-C IME 状态机：composition 期间鼠标交互一律跳过）
      if (isComposingRef.current) return;
      // 表格 Excel 交互区不接管（单元格拖拽/选区由 TableStore 状态机独占）
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.closest('.line-table-row') ||
          target.closest('.token-table-cell'))
      ) {
        return;
      }
      // 已有 DOM 文本选区（双击选词/外部拖选结果）：不干预——原生选区路径
      // （selectionchange → getGlobalIndexFromDOMNode）继续接管，避免引擎
      // 状态机与浏览器原生选择打架
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) return;

      // 预先在 mousedown 阶段（DOM 尚未激活/展开隐藏语法前）以当前未展开物理状态计算目标字符索引，
      // 保证后续 click 触发时光标锚定在用户视线所点击的文字上，而不是在展开后新插入的前缀/标记位置
      try {
        const clickedLineIndex = parseInt(
          target?.closest('[data-index]')?.getAttribute('data-index') || '-1',
          10
        );
        const preIndex = indexFromClientPoint(
          e.clientX,
          e.clientY,
          container,
          editorStore.getState(),
          clickedLineIndex >= 0 ? clickedLineIndex : undefined
        );
        (window as any).__CRISH_PRE_CLICK_INDEX = {
          x: e.clientX,
          y: e.clientY,
          index: preIndex,
          time: Date.now(),
        };
      } catch {}

      dragSelectRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
        anchor: -1,
        lastIndex: -1,
        active: false,
        suppressed: false,
        rafId: null,
      };
    };

    const handleDragMouseMove = (e: MouseEvent) => {
      // 单元格内划词拖选（当处于单元格就地文本编辑态时）
      const cellDrag = (window as any).__CRISH_CELL_TEXT_DRAG;
      if (cellDrag && cellDrag.cellEl) {
        const headIdx = locateRowIndexByPhysicalBisection(
          cellDrag.cellEl,
          e.clientX,
          cellDrag.start,
          cellDrag.len
        ) ?? cellDrag.start;
        const clampedHead = Math.max(
          cellDrag.start,
          Math.min(cellDrag.start + cellDrag.len, headIdx)
        );
        editorStore.getState().setSelection(cellDrag.anchorIdx, clampedHead);
        editorStore.getState().setCursorPos(clampedHead);
        return;
      }

      const d = dragSelectRef.current;
      const container = containerRef.current;
      if (!d || !container) return;

      d.currentX = e.clientX;
      d.currentY = e.clientY;

      if (!d.active) {
        // 移动阈值：未超阈值视为点击（mouseup 后由 click 定位，本状态机
        // 不干预——「mousedown 后 mousemove 才进拖选态」与点击定位协调）
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (dx * dx + dy * dy <= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
          return;
        }
        // 进入拖选态：锚点 = 按下位置定位的光标位（拖选起点 = 点击后光标位）
        d.anchor = indexFromClientPoint(
          d.startX,
          d.startY,
          container,
          editorStore.getState()
        );
        d.active = true;
        // 抑制原生选区：userSelect none 防止后续 mousemove 创建原生选区
        // （引擎自绘高亮替代），并清空可能残留的 DOM 选区
        d.suppressed = true;
        container.style.userSelect = 'none';
        window.getSelection()?.removeAllRanges();
        editorStore.getState().setCursorPos(d.anchor);
      }

      // 坐标驱动：head 同步更新（anchor 不动；同索引跳过——高频去抖）
      const index = indexFromClientPoint(
        e.clientX,
        e.clientY,
        container,
        editorStore.getState()
      );
      if (index !== d.lastIndex) {
        d.lastIndex = index;
        editorStore.getState().moveHead(index);
      }

      // 边缘自动滚动调度：边缘步进 + 持续 60fps 平滑滚屏（鼠标停在边缘时亦可持续滚动）
      const edgeStep = edgeScrollStep(e.clientY, container);
      if (edgeStep !== 0) {
        const maxTop = Math.max(
          0,
          (container.scrollHeight || 0) - container.clientHeight
        );
        container.scrollTop = Math.min(
          maxTop,
          Math.max(0, container.scrollTop + edgeStep)
        );

        if (d.rafId === null) {
          const tick = () => {
            const cur = dragSelectRef.current;
            const c = containerRef.current;
            if (!cur || !cur.active || !c) {
              if (cur) cur.rafId = null;
              return;
            }

            const step = edgeScrollStep(cur.currentY, c);
            if (step !== 0) {
              const max = Math.max(
                0,
                (c.scrollHeight || 0) - c.clientHeight
              );
              c.scrollTop = Math.min(
                max,
                Math.max(0, c.scrollTop + step)
              );

              const idx = indexFromClientPoint(
                cur.currentX,
                cur.currentY,
                c,
                editorStore.getState()
              );
              if (idx !== cur.lastIndex) {
                cur.lastIndex = idx;
                editorStore.getState().moveHead(idx);
              }
              cur.rafId = requestAnimationFrame(tick);
            } else {
              cur.rafId = null;
            }
          };

          d.rafId = requestAnimationFrame(tick);
        }
      } else if (d.rafId !== null) {
        cancelAnimationFrame(d.rafId);
        d.rafId = null;
      }
    };

    const handleDragMouseUp = (e: MouseEvent) => {
      (window as any).__CRISH_CELL_TEXT_DRAG = null;
      const d = dragSelectRef.current;
      if (!d) return;
      if (d.rafId !== null) {
        cancelAnimationFrame(d.rafId);
        d.rafId = null;
      }
      if (d.active && containerRef.current) {
        // 结算：mouseup 位置可能是最后一次 mousemove 之后的新坐标，
        // 补一次 head 更新（幂等）
        const index = indexFromClientPoint(
          e.clientX,
          e.clientY,
          containerRef.current,
          editorStore.getState()
        );
        if (index !== d.lastIndex) {
          editorStore.getState().moveHead(index);
        }
        // 拖选结束的合成 click 抑制（MarkdownEngine handleContainerClick
        // 检查 __CRISH_LAST_DRAG_END_TIME 跳过，防光标回跳）
        (window as any).__CRISH_LAST_DRAG_END_TIME = Date.now();
      }
      if (d.suppressed) {
        const container = containerRef.current;
        if (container) container.style.userSelect = '';
        window.getSelection()?.removeAllRanges();
      }
      dragSelectRef.current = null;
    };

    // —— B2 双击选词（词级，04 §3.3 状态机独立分支）——
    // 双击 = 两次 click 已定位光标后的独立动作，不并入拖选状态机；
    // 引擎按「源码词段边界」自选（doubleClickWordSelection 纯函数）：
    // - preventDefault 阻止浏览器原生双击选词——token 化 DOM 的词
    //   边界与源码词段可能不一致（行内 span 切分），且原生选区会
    //   触发 selectionchange 同步与引擎选区双写打架；
    // - 双击落在空白/符号段 → 不选词（保持光标定位语义，与主流
    //   编辑器一致——点击定位已由两次 click 完成）。
    const handleContainerDblClick = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container || e.button !== 0) return;
      // 组合中不干预（R4-C IME 状态机：composition 期间鼠标交互跳过）
      if (isComposingRef.current) return;
      // 表格 Excel 交互区不接管（单元格双击有自身语义）
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.closest('.line-table-row') ||
          target.closest('.token-table-cell'))
      ) {
        return;
      }
      e.preventDefault();
      const s = editorStore.getState();
      const pos = indexFromClientPoint(e.clientX, e.clientY, container, s);
      const lineIdx = s.lineOffsets.findLineIndex(pos);
      const lineStart = s.lineOffsets.getOffset(lineIdx);
      const lineText = s.getLine(lineIdx) ?? '';
      const sel = doubleClickWordSelection(lineText, pos - lineStart);
      if (!sel) return;
      s.setSelection(lineStart + sel.start, lineStart + sel.end);
    };

    // —— B5 拖放文件/文本（拖入悬停高亮 + drop 落盘）——
    // dragover 必须 preventDefault 才能接收 drop（浏览器默认阻止）；
    // 仅文件拖入时显示 overlay（文本拖入不干扰编辑视觉）；
    // dragleave 需排除子元素间移动（relatedTarget 仍在容器内不隐藏）。
    const handleDragEnter = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      if (Array.from(dt.types).some((t) => t.toLowerCase() === 'files')) {
        e.preventDefault();
        dt.dropEffect = 'copy';
        setDragOverlayVisible(true);
      }
    };
    const handleDragOver = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      if (Array.from(dt.types).some((t) => t.toLowerCase() === 'files')) {
        e.preventDefault();
        dt.dropEffect = 'copy';
      }
    };
    const handleDragLeave = (e: DragEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rel = e.relatedTarget as Node | null;
      if (rel && container.contains(rel)) return;
      setDragOverlayVisible(false);
    };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOverlayVisible(false);
      // 组合期不接管（与 paste 同款红线：value 缓冲期干预会丢字）
      if (isComposingRef.current || activeCompositionGroup.current) return;
      const dt = e.dataTransfer;
      if (!dt) return;
      const plan = planDropInsert(
        dt.types,
        Array.from(dt.files),
        dt.getData('text/plain')
      );
      if (plan.kind === 'none') return;
      // drop 时刻的选区快照（文件读取异步——回调时若光标已移动仍按
      // 拖入时选区插入，与粘贴语义一致；读取通常 <10ms，冲突窗口登记）
      const s = editorStore.getState();
      const from = s.selectionStart;
      const to = s.selectionEnd;
      void applyDroppedContent(plan, s, from, to);
    };

    const containerEl = containerRef.current;
    if (containerEl) {
      containerEl.addEventListener('mousedown', handleDragMouseDown);
      containerEl.addEventListener('dblclick', handleContainerDblClick);
      containerEl.addEventListener('dragenter', handleDragEnter);
      containerEl.addEventListener('dragover', handleDragOver);
      containerEl.addEventListener('dragleave', handleDragLeave);
      containerEl.addEventListener('drop', handleDrop);
    }
    window.addEventListener('mousemove', handleDragMouseMove);
    window.addEventListener('mouseup', handleDragMouseUp);

    document.addEventListener('selectionchange', handleSelectionChange);
    window.addEventListener('mousedown', handleGlobalMouseDown);
    window.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('click', handleGlobalClick);
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      window.removeEventListener('mousedown', handleGlobalMouseDown);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('click', handleGlobalClick);
      window.removeEventListener('keydown', handleGlobalKeyDown);
      if (containerEl) {
        containerEl.removeEventListener('mousedown', handleDragMouseDown);
        containerEl.removeEventListener('dblclick', handleContainerDblClick);
        containerEl.removeEventListener('dragenter', handleDragEnter);
        containerEl.removeEventListener('dragover', handleDragOver);
        containerEl.removeEventListener('dragleave', handleDragLeave);
        containerEl.removeEventListener('drop', handleDrop);
        // 异常卸载兜底：恢复 userSelect（拖选中卸载时防样式残留）
        containerEl.style.userSelect = '';
      }
      window.removeEventListener('mousemove', handleDragMouseMove);
      window.removeEventListener('mouseup', handleDragMouseUp);
      if (dragSelectRef.current?.rafId !== null && dragSelectRef.current?.rafId !== undefined) {
        cancelAnimationFrame(dragSelectRef.current.rafId);
        dragSelectRef.current.rafId = null;
      }
    };
  }, [containerRef]);

  const handleTableInteraction = (e: KeyboardEvent | React.KeyboardEvent) => {
    const selectedCell = useTableStore.getState().selectedCell;
    if (!selectedCell) return false;
    const text = editorStore.getState().getText();
    const cursorPos = editorStore.getState().cursorPos;

    if (!selectedCell.isEditing) {
      // 1. 单元格多选复制 (Ctrl+C / Cmd+C: 导出 TSV 格式制表符数据)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        const minLine = Math.min(selectedCell.startLine, selectedCell.endLine);
        const maxLine = Math.max(selectedCell.startLine, selectedCell.endLine);
        const minCol = Math.min(selectedCell.startCol, selectedCell.endCol);
        const maxCol = Math.max(selectedCell.startCol, selectedCell.endCol);
        const lines = editorStore.getState().lines;
        const copiedRows: string[] = [];
        for (let r = minLine; r <= maxLine; r++) {
          const lineText = lines[r] || '';
          if (/^\|?[\s:-]*[-]+[\s:-]*\|/.test(lineText.trim())) continue;
          const { cells } = parseRowCells(lineText);
          const selectedRowCells: string[] = [];
          for (let c = minCol; c <= maxCol; c++) {
            selectedRowCells.push((cells[c] || '').trim());
          }
          copiedRows.push(selectedRowCells.join('\t'));
        }
        if (copiedRows.length > 0) {
          e.preventDefault();
          void navigator.clipboard.writeText(copiedRows.join('\n'));
          return true;
        }
      }

      // 2. 单元格模式快捷键 (Cell Selection Mode - 仅限单元格级别操作)
      if (e.key === 'F2') {
        e.preventDefault();
        useTableStore.getState().enterCellEdit();
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        useTableStore.getState().clearCellSelection();
        return true;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const minLine = Math.min(selectedCell.startLine, selectedCell.endLine);
        const maxLine = Math.max(selectedCell.startLine, selectedCell.endLine);
        const minCol = Math.min(selectedCell.startCol, selectedCell.endCol);
        const maxCol = Math.max(selectedCell.startCol, selectedCell.endCol);

        if (minLine === maxLine && minCol === maxCol) {
          const res = clearCell(text, cursorPos);
          if (res.newText !== text) {
            editorStore.setState({ lines: res.newText.split('\n') });
          }
          editorStore.getState().setCursorPos(res.newCursorPos);
        } else {
          // 多单元格批量清空（保留管道符结构）
          const currentLines = [...editorStore.getState().lines];
          let hasChanges = false;
          for (let r = minLine; r <= maxLine; r++) {
            const lineText = currentLines[r] || '';
            if (/^\|?[\s:-]*[-]+[\s:-]*\|/.test(lineText.trim())) continue;
            const { pipePositions } = parseRowCells(lineText);
            if (pipePositions.length <= 1) continue;
            let modifiedLine = lineText;
            for (let c = Math.min(maxCol, pipePositions.length - 2); c >= minCol; c--) {
              const left = pipePositions[c];
              const right = pipePositions[c + 1];
              if (left !== undefined && right !== undefined) {
                modifiedLine =
                  modifiedLine.substring(0, left + 1) +
                  '  ' +
                  modifiedLine.substring(right);
              }
            }
            if (modifiedLine !== lineText) {
              currentLines[r] = modifiedLine;
              hasChanges = true;
            }
          }
          if (hasChanges) {
            editorStore.setState({ lines: currentLines });
          }
        }
        return true;
      }

      // Shift+方向键：扩展单元格多选范围（表格多选，支持跨越分隔行）
      if (
        e.shiftKey &&
        (e.key === 'ArrowRight' ||
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowDown' ||
          e.key === 'ArrowUp')
      ) {
        e.preventDefault();
        const tableStore = useTableStore.getState();
        const currentLines = editorStore.getState().lines;
        if (e.key === 'ArrowRight') {
          tableStore.updateCellSelectionEnd(selectedCell.endLine, selectedCell.endCol + 1);
        } else if (e.key === 'ArrowLeft') {
          tableStore.updateCellSelectionEnd(selectedCell.endLine, Math.max(0, selectedCell.endCol - 1));
        } else if (e.key === 'ArrowDown') {
          let nextLine = selectedCell.endLine + 1;
          const targetText = currentLines[nextLine] || '';
          if (/^\|?[\s:-]*[-]+[\s:-]*\|/.test(targetText.trim())) {
            nextLine++;
          }
          if (nextLine < currentLines.length && (currentLines[nextLine] || '').trim().startsWith('|')) {
            tableStore.updateCellSelectionEnd(nextLine, selectedCell.endCol);
          }
        } else if (e.key === 'ArrowUp') {
          let prevLine = selectedCell.endLine - 1;
          const targetText = currentLines[prevLine] || '';
          if (/^\|?[\s:-]*[-]+[\s:-]*\|/.test(targetText.trim())) {
            prevLine--;
          }
          if (prevLine >= 0 && (currentLines[prevLine] || '').trim().startsWith('|')) {
            tableStore.updateCellSelectionEnd(prevLine, selectedCell.endCol);
          }
        }
        return true;
      }

      // 单元格网格导航键（Tab, Shift+Tab, Enter, Shift+Enter, 方向键）
      let action: 'tab' | 'shift-tab' | 'enter' | 'shift-enter' | null = null;
      if (e.key === 'Tab') {
        action = e.shiftKey ? 'shift-tab' : 'tab';
      } else if (e.key === 'Enter') {
        action = e.shiftKey ? 'shift-enter' : 'enter';
      } else if (e.key === 'ArrowLeft' && !e.shiftKey) {
        action = 'shift-tab';
      } else if (e.key === 'ArrowRight' && !e.shiftKey) {
        action = 'tab';
      } else if (e.key === 'ArrowUp' && !e.shiftKey) {
        action = 'shift-enter';
      } else if (e.key === 'ArrowDown' && !e.shiftKey) {
        action = 'enter';
      }

      if (action) {
        e.preventDefault();
        const res = navigateTable(text, cursorPos, action);
        if (res) {
          if (res.newText !== text) {
            editorStore.setState({ lines: res.newText.split('\n') });
          }
          editorStore.getState().setCursorPos(res.newCursorPos);
          const newTable = findTableRange(res.newText, res.newCursorPos);
          if (newTable) {
            useTableStore
              .getState()
              .enterCellSelection(
                selectedCell.tableId,
                newTable.absoluteLineIndex ?? newTable.activeLineIndex,
                newTable.activeCellIndex
              );
          }
        }
        return true;
      }

      // 如果按普通字符键（单字符输入），清空当前单元格并直接输入该字符并转为编辑态
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        e.preventDefault();
        const res = setCellContent(text, cursorPos, e.key);
        if (res.newText !== text) {
          editorStore.setState({ lines: res.newText.split('\n') });
        }
        editorStore.getState().setCursorPos(res.newCursorPos);
        useTableStore.getState().enterCellEdit();
        return true;
      }
    } else {
      // 2. 单元格就地编辑模式 (Cell In-place Text Edit Mode)
      if (e.key === 'Escape') {
        e.preventDefault();
        useTableStore.getState().exitCellEdit();
        return true;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const res = navigateTable(
          text,
          cursorPos,
          e.shiftKey ? 'shift-tab' : 'tab'
        );
        if (res) {
          if (res.newText !== text) {
            editorStore.setState({ lines: res.newText.split('\n') });
          }
          editorStore.getState().setCursorPos(res.newCursorPos);
          const newTable = findTableRange(res.newText, res.newCursorPos);
          if (newTable) {
            useTableStore
              .getState()
              .enterCellSelection(
                selectedCell.tableId,
                newTable.absoluteLineIndex ?? newTable.activeLineIndex,
                newTable.activeCellIndex
              );
          }
        }
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const res = navigateTable(text, cursorPos, 'enter');
        if (res) {
          if (res.newText !== text) {
            editorStore.setState({ lines: res.newText.split('\n') });
          }
          editorStore.getState().setCursorPos(res.newCursorPos);
          const newTable = findTableRange(res.newText, res.newCursorPos);
          if (newTable) {
            useTableStore
              .getState()
              .enterCellSelection(
                selectedCell.tableId,
                newTable.absoluteLineIndex ?? newTable.activeLineIndex,
                newTable.activeCellIndex
              );
          }
        }
        return true;
      }

      // 单元格内物理边界与键盘导航
      const table = findTableRange(text, cursorPos);
      if (table) {
        const rowText = table.lines[table.activeLineIndex];
        const lineOffset = table.lineOffsets[table.activeLineIndex];
        const { pipePositions } = parseRowCells(rowText);
        const col = table.activeCellIndex;

        if (col >= 0 && col < pipePositions.length - 1) {
          const rawCell = rowText.substring(
            pipePositions[col] + 1,
            pipePositions[col + 1]
          );
          const leadingSpaces = rawCell.match(/^\s*/)?.[0].length || 0;
          const trailingSpaces = rawCell.match(/\s*$/)?.[0].length || 0;
          const cellTextStart = lineOffset + pipePositions[col] + 1 + leadingSpaces;
          const cellTextEnd = Math.max(
            cellTextStart,
            lineOffset + pipePositions[col + 1] - trailingSpaces
          );

          if (
            e.key === 'ArrowLeft' &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey
          ) {
            if (cursorPos > cellTextStart) {
              const newPos = Math.max(cellTextStart, cursorPos - 1);
              fastCursorMove(newPos);
              editorStore.getState().setSelection(newPos, newPos);
              e.preventDefault();
              return true;
            }
            if (col > 0) {
              const prevCol = col - 1;
              const prevRaw = rowText.substring(
                pipePositions[prevCol] + 1,
                pipePositions[prevCol + 1]
              );
              const prevTrailing = prevRaw.match(/\s*$/)?.[0].length || 0;
              const prevLeading = prevRaw.match(/^\s*/)?.[0].length || 0;
              const prevStart =
                lineOffset + pipePositions[prevCol] + 1 + prevLeading;
              const prevEnd = Math.max(
                prevStart,
                lineOffset + pipePositions[prevCol + 1] - prevTrailing
              );
              fastCursorMove(prevEnd);
              editorStore.getState().setSelection(prevEnd, prevEnd);
              useTableStore
                .getState()
                .enterCellEdit(
                  selectedCell.tableId,
                  selectedCell.startLine,
                  prevCol
                );
              e.preventDefault();
              return true;
            }
            fastCursorMove(cellTextStart);
            editorStore.getState().setSelection(cellTextStart, cellTextStart);
            e.preventDefault();
            return true;
          }

          if (
            e.key === 'ArrowRight' &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey
          ) {
            if (cursorPos < cellTextEnd) {
              const newPos = Math.min(cellTextEnd, cursorPos + 1);
              fastCursorMove(newPos);
              editorStore.getState().setSelection(newPos, newPos);
              e.preventDefault();
              return true;
            }
            if (col < pipePositions.length - 2) {
              const nextCol = col + 1;
              const nextRaw = rowText.substring(
                pipePositions[nextCol] + 1,
                pipePositions[nextCol + 1]
              );
              const nextLeading = nextRaw.match(/^\s*/)?.[0].length || 0;
              const nextStart =
                lineOffset + pipePositions[nextCol] + 1 + nextLeading;
              fastCursorMove(nextStart);
              editorStore.getState().setSelection(nextStart, nextStart);
              useTableStore
                .getState()
                .enterCellEdit(
                  selectedCell.tableId,
                  selectedCell.startLine,
                  nextCol
                );
              e.preventDefault();
              return true;
            }
            fastCursorMove(cellTextEnd);
            editorStore.getState().setSelection(cellTextEnd, cellTextEnd);
            e.preventDefault();
            return true;
          }

          if (
            e.key === 'ArrowUp' &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey
          ) {
            let prevLineIdx = table.activeLineIndex - 1;
            if (prevLineIdx === table.separatorLineIndex) prevLineIdx--;
            if (prevLineIdx >= 0) {
              const targetRowText = table.lines[prevLineIdx];
              const targetLineOffset = table.lineOffsets[prevLineIdx];
              const { pipePositions: targetPipes } = parseRowCells(targetRowText);
              const targetCol = Math.min(col, targetPipes.length - 2);
              if (targetCol >= 0) {
                const targetRaw = targetRowText.substring(
                  targetPipes[targetCol] + 1,
                  targetPipes[targetCol + 1]
                );
                const targetLeading = targetRaw.match(/^\s*/)?.[0].length || 0;
                const targetTrailing = targetRaw.match(/\s*$/)?.[0].length || 0;
                const targetStart =
                  targetLineOffset + targetPipes[targetCol] + 1 + targetLeading;
                const targetEnd = Math.max(
                  targetStart,
                  targetLineOffset + targetPipes[targetCol + 1] - targetTrailing
                );
                const relOffset = cursorPos - cellTextStart;
                const newPos = Math.min(targetEnd, targetStart + relOffset);
                fastCursorMove(newPos);
                editorStore.getState().setSelection(newPos, newPos);
                const targetAbsLine = (table.startLineIndex ?? 0) + prevLineIdx;
                useTableStore
                  .getState()
                  .enterCellEdit(
                    selectedCell.tableId,
                    targetAbsLine,
                    targetCol
                  );
                e.preventDefault();
                return true;
              }
            }
            e.preventDefault();
            return true;
          }

          if (
            e.key === 'ArrowDown' &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey
          ) {
            let nextLineIdx = table.activeLineIndex + 1;
            if (nextLineIdx === table.separatorLineIndex) nextLineIdx++;
            if (nextLineIdx < table.lines.length) {
              const targetRowText = table.lines[nextLineIdx];
              const targetLineOffset = table.lineOffsets[nextLineIdx];
              const { pipePositions: targetPipes } = parseRowCells(targetRowText);
              const targetCol = Math.min(col, targetPipes.length - 2);
              if (targetCol >= 0) {
                const targetRaw = targetRowText.substring(
                  targetPipes[targetCol] + 1,
                  targetPipes[targetCol + 1]
                );
                const targetLeading = targetRaw.match(/^\s*/)?.[0].length || 0;
                const targetTrailing = targetRaw.match(/\s*$/)?.[0].length || 0;
                const targetStart =
                  targetLineOffset + targetPipes[targetCol] + 1 + targetLeading;
                const targetEnd = Math.max(
                  targetStart,
                  targetLineOffset + targetPipes[targetCol + 1] - targetTrailing
                );
                const relOffset = cursorPos - cellTextStart;
                const newPos = Math.min(targetEnd, targetStart + relOffset);
                fastCursorMove(newPos);
                editorStore.getState().setSelection(newPos, newPos);
                const targetAbsLine = (table.startLineIndex ?? 0) + nextLineIdx;
                useTableStore
                  .getState()
                  .enterCellEdit(
                    selectedCell.tableId,
                    targetAbsLine,
                    targetCol
                  );
                e.preventDefault();
                return true;
              }
            }
            e.preventDefault();
            return true;
          }

          if (e.key === 'Home') {
            fastCursorMove(cellTextStart);
            editorStore.getState().setSelection(cellTextStart, cellTextStart);
            e.preventDefault();
            return true;
          }

          if (e.key === 'End') {
            fastCursorMove(cellTextEnd);
            editorStore.getState().setSelection(cellTextEnd, cellTextEnd);
            e.preventDefault();
            return true;
          }

          if (e.key === 'Backspace') {
            const { selectionStart, selectionEnd } = editorStore.getState();
            if (selectionStart === selectionEnd && cursorPos <= cellTextStart) {
              e.preventDefault();
              return true;
            }
          }

          if (e.key === 'Delete') {
            const { selectionStart, selectionEnd } = editorStore.getState();
            if (selectionStart === selectionEnd && cursorPos >= cellTextEnd) {
              e.preventDefault();
              return true;
            }
          }
        }
      }
    }
    return false;
  };

  const fastCursorMove = (newPos: number) => {
    // B5 自动补全：任何光标移动（方向键/Home/End/翻页/词级跳选）关闭
    // 候选菜单——候选列表基于原光标语义，移动后由下次输入重新触发
    closeAutocomplete();
    setCursorPos(newPos);
    // We don't need manual dom manipulation here anymore, since useEffect handles it on cursorPos change
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const { selectionStart, selectionEnd } = editorStore.getState();
    const cursorPos = editorStore.getState().cursorPos;
    // R6-P1 ArrowLeft 根治：不再无条件全文 getText()（O(全文) join——
    // 100 万行文档每次按键 14.5ms 的根因之一）。改为各分支按需取文本：
    // - 左右方向键走行文本模式 moveGrapheme（O(行)，不触碰全文）；
    // - Home/End 经 LineOffsetTree 定位（O(log n)）；
    // - 仅真正需要全文的分支（行复制/垂直导航/全选）按需取 getText()。

    // Undo / Redo
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      // B5 自动补全：撤销/重做后光标可能大变，关闭候选菜单
      closeAutocomplete();
      if (e.shiftKey) {
        editorStore.getState().redo();
      } else {
        editorStore.getState().undo();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      closeAutocomplete();
      editorStore.getState().redo();
      return;
    }

    // Ctrl+C 无选区复制整行（R4-E，04 §5.2 C5 linewise copy）：
    // 引擎选区 collapsed 时浏览器默认复制 textarea（value 恒为空）无
    // 内容可复制——这里直接取当前行文本 + 换行写入系统剪贴板；
    // 有选区时不拦截，走 MarkdownEngine 容器 onCopy 的既有源码复制。
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      if (selectionStart === selectionEnd) {
        e.preventDefault();
        // 整行复制需要全文行区间（linewiseCopyContent 全文语义）；
        // 非热路径，按需取全文
        writeClipboardText(
          linewiseCopyContent(editorStore.getState().getText(), cursorPos)
        );
      }
      return;
    }

    // --- 表格单元格交互状态机 (Excel Mode) ---
    if (handleTableInteraction(e)) {
      e.stopPropagation();
      return;
    }

    // —— B2 词级跳选（Ctrl/Cmd+Arrow）——
    // 行文本模式词级导航（wordNavigation：行内词边界 + 行边界显式
    // 跨行，与 ArrowLeft/Right 的 moveGrapheme 同架构——不全文
    // getText() join）；Shift 扩展 = anchor 不动、head 移到词边界
    // （R4-B moveHead 语义，词级粒度版本）。
    if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowLeft') {
      e.preventDefault();
      const s = editorStore.getState();
      const target = wordNavigation(
        s.cursorPos,
        'left',
        (i) => s.getLine(i) ?? '',
        s.lineOffsets,
        s.textLength
      );
      if (e.shiftKey) {
        s.moveHead(target);
      } else {
        fastCursorMove(target);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowRight') {
      e.preventDefault();
      const s = editorStore.getState();
      const target = wordNavigation(
        s.cursorPos,
        'right',
        (i) => s.getLine(i) ?? '',
        s.lineOffsets,
        s.textLength
      );
      if (e.shiftKey) {
        s.moveHead(target);
      } else {
        fastCursorMove(target);
      }
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      // R6-P1 行文本模式 grapheme 移动：store.moveGrapheme 内部定位光标
      // 所在行（getLine + LineOffsetTree）+ 行内 grapheme 边界 + 行边界
      // 显式跨行——不再全文 getText() join（100 万行文档 14.5ms → <1ms）；
      // 语义与全文模式等价（行首向左 = 上一行行尾、行尾向右 = 下一行行首）
      const newPos = editorStore.getState().moveGrapheme(cursorPos, 'left');
      if (e.shiftKey) {
        // R4-B 接线：Shift+Left 扩展 = anchor 不动、head 左移（grapheme 粒度）。
        // 删除旧启发式 selectionStart === cursorPos（光标离开选区端后即失效，
        // 反向扩展第二次方向错误——04 §3.2 S1）；extendSelectionByDirection
        // 以 headPos 为基点，方向由 anchor/head 相对位置判定，天然正确。
        editorStore.getState().extendSelectionByDirection('left');
      } else {
        if (selectionStart !== selectionEnd) fastCursorMove(selectionStart);
        else fastCursorMove(newPos);
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      // R6-P1：同 ArrowLeft——行文本模式 moveGrapheme（见上注释）
      const newPos = editorStore.getState().moveGrapheme(cursorPos, 'right');
      if (e.shiftKey) {
        // R4-B 接线：Shift+Right 扩展（anchor 不动、head 右移），语义同上
        editorStore.getState().extendSelectionByDirection('right');
      } else {
        if (selectionStart !== selectionEnd) fastCursorMove(selectionEnd);
        else fastCursorMove(newPos);
      }
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      // 合成中退格删除的是候选文本（浏览器经 value 缓冲处理），
      // 绝不触达文档——防误删已提交内容（composition 内不重复处理）
      if (isComposingRef.current) return;
      deleteText(true);
      // B5 自动补全：删除后重新检测（触发词可能仍在——@alic → @ali）
      maybeOpenAutocomplete();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      if (isComposingRef.current) return;
      deleteText(false);
      maybeOpenAutocomplete();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isComposing) return;

      if (!e.shiftKey) {
        const state = editorStore.getState();
        const text = state.getText();
        const pos = state.cursorPos;

        let lineStart = 0;
        for (let i = pos - 1; i >= 0; i--) {
          if (text[i] === '\n') {
            lineStart = i + 1;
            break;
          }
        }

        let lineEnd = text.length;
        for (let i = pos; i < text.length; i++) {
          if (text[i] === '\n') {
            lineEnd = i;
            break;
          }
        }

        const textBeforeCursor = text.substring(lineStart, pos);
        const textAfterCursor = text.substring(pos, lineEnd);
        const listMatch = textBeforeCursor.match(
          /^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/
        );

        if (listMatch) {
          if (
            textBeforeCursor === listMatch[0] &&
            textAfterCursor.trim() === ''
          ) {
            // Empty list item: break out of the list
            state.deleteSelection(lineStart, lineEnd);
          } else {
            // Continue the list
            let newPrefix = listMatch[0];
            const numberMatch = newPrefix.match(/(\d+)\./);
            if (numberMatch) {
              const nextNum = parseInt(numberMatch[1], 10) + 1;
              newPrefix = newPrefix.replace(/\d+\./, `${nextNum}.`);
            }
            // Reset task list to unchecked
            newPrefix = newPrefix.replace(/\[[xX]\]/, '[ ]');

            insertText('\n' + newPrefix);
          }
        } else {
          insertText('\n');
        }
      } else {
        // Shift+Enter
        insertText('\n');
      }
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // R6-P1：全选边界用 textLength（O(1)），不再全文 getText()
      setSelection(0, editorStore.getState().textLength);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const state = editorStore.getState();
      const text = state.getText();
      const cursorPos = state.cursorPos;

      const res = navigateTable(
        text,
        cursorPos,
        e.shiftKey ? 'shift-tab' : 'tab'
      );
      if (res) {
        if (res.newText !== text) {
          editorStore.setState({ lines: res.newText.split('\n') });
        }
        editorStore.getState().setCursorPos(res.newCursorPos);
      } else {
        const selStart = state.selectionStart;
        const selEnd = state.selectionEnd;
        const startLineIdx = state.lineOffsets.findLineIndex(
          Math.min(selStart, selEnd)
        );
        const endLineIdx = state.lineOffsets.findLineIndex(
          Math.max(selStart, selEnd)
        );

        const startLineOffset = state.lineOffsets.getOffset(startLineIdx);
        const endLineOffset = state.lineOffsets.getOffset(endLineIdx);
        // R6-P1：行内容经访问器读取（不再读物化视图 state.lines）
        const endLineLength = state.getLine(endLineIdx)?.length ?? 0;

        const blockStart = startLineOffset;
        const blockEnd = endLineOffset + endLineLength;
        const blockText = text.substring(blockStart, blockEnd);

        let cursorDelta = 0;
        let newBlockText = '';

        if (e.shiftKey) {
          newBlockText = blockText
            .split('\n')
            .map((line) => {
              const match = line.match(/^ {1,2}/);
              if (match && selStart === selEnd) cursorDelta = -match[0].length;
              return line.replace(/^ {1,2}/, '');
            })
            .join('\n');
        } else {
          if (selStart !== selEnd) {
            newBlockText = blockText
              .split('\n')
              .map((line) => '  ' + line)
              .join('\n');
          } else {
            // R6-P1：行内容经访问器读取（不再读物化视图 state.lines）
            const currentLine = state.getLine(startLineIdx) ?? '';
            if (/^(\s*)([-*+]|\d+\.)\s+/.test(currentLine)) {
              newBlockText = '  ' + currentLine;
              cursorDelta = 2;
            } else {
              state.insertText('  ');
              return;
            }
          }
        }

        if (newBlockText !== blockText) {
          state.setSelection(blockStart, blockEnd);
          state.insertText(newBlockText);
          if (selStart !== selEnd) {
            editorStore
              .getState()
              .setSelection(blockStart, blockStart + newBlockText.length);
          } else {
            const newPos = Math.max(blockStart, selStart + cursorDelta);
            editorStore.getState().setSelection(newPos, newPos);
          }
        }
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (containerRef.current) {
        const targetIdx = getArrowNavigationIndex(
          cursorPos,
          'up',
          containerRef.current
        );
        if (targetIdx !== null) {
          // 垂直导航列保持的 grapheme 吸附：目标行来自 DOM 测量；
          // 非左右方向键热路径，按需取全文（保持既有语义零变化）
          const text = editorStore.getState().getText();
          const newPos = snapToGraphemeBoundary(text, targetIdx);
          if (e.shiftKey) {
            // R4-B 垂直扩展登记：行级——head 移到目标行（列保持由
            // getArrowNavigationIndex 完成），anchor 保持不动（moveHead）；
            // 删除旧启发式 selectionStart === cursorPos（同 04 §3.2 S1）
            editorStore.getState().moveHead(newPos);
          } else {
            fastCursorMove(newPos);
          }
        }
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (containerRef.current) {
        const targetIdx = getArrowNavigationIndex(
          cursorPos,
          'down',
          containerRef.current
        );
        if (targetIdx !== null) {
          const text = editorStore.getState().getText();
          const newPos = snapToGraphemeBoundary(text, targetIdx);
          if (e.shiftKey) {
            // R4-B 垂直扩展登记：行级——head 移到目标行，anchor 保持不动
            editorStore.getState().moveHead(newPos);
          } else {
            fastCursorMove(newPos);
          }
        }
      }
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      // P2 项 4 键盘增强：翻页导航（浏览器默认在隐藏 textarea 上无效——
      // value 恒空、无内容可翻，显式接管）。
      // 目标行 = 视口顶/底行 ± 页行数（pageNavigationTarget，已挂载行
      // 几何 = HeightMap.indexAt 的 DOM 等价实现）；列保持与 ArrowUp/Down
      // 同款（字符宽度 Oracle 列预测 + grapheme 吸附）；滚动跟随由光标
      // 越界滚动 effect 自动接管（目标行滚入视口）。
      const container = containerRef.current;
      if (!container) return;
      const s = editorStore.getState();
      const lineCount = s.getLineCount();
      const mounted = collectMountedLines(
        container,
        container.getBoundingClientRect()
      );
      if (mounted.length === 0) return;
      const targetIdx = pageNavigationTarget(
        e.key === 'PageUp' ? 'up' : 'down',
        container.scrollTop,
        container.clientHeight,
        lineCount,
        mounted
      );
      const targetStart = s.lineOffsets.getOffset(targetIdx);
      const targetText = s.getLine(targetIdx) ?? '';
      // 列保持：当前光标列 X（相对当前行左缘）→ 目标行内最接近列
      const curRect = getCoordinatesFromIndex(cursorPos, container);
      let newPos = targetStart;
      if (curRect) {
        const curLineIdx = s.lineOffsets.findLineIndex(cursorPos);
        const curLineEl = container.querySelector(
          `[data-index="${curLineIdx}"]`
        );
        const relX = curLineEl
          ? Math.max(0, curRect.left - curLineEl.getBoundingClientRect().left)
          : 0;
        const col = predictColumn(
          targetText,
          relX,
          fallbackCharWidths(container)
        );
        newPos = targetStart + Math.min(col, targetText.length);
      }
      // grapheme 吸附（列预测可能劈开组合序列，与 ArrowUp/Down 同款）
      newPos =
        targetStart + snapToGraphemeBoundary(targetText, newPos - targetStart);
      if (e.shiftKey) {
        // Shift+PageUp/Down：选区扩展——head 移到目标行，anchor 保持不动
        editorStore.getState().moveHead(newPos);
      } else {
        fastCursorMove(newPos);
      }
    } else if (e.key === 'Home' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // P2 项 4 键盘增强：Ctrl+Home 文档首——位置 0 即文档开头（O(1)；
      // 浏览器默认在隐藏 textarea 上无效，显式接管）
      if (e.shiftKey) {
        setSelection(selectionStart === cursorPos ? 0 : selectionStart, 0);
      }
      fastCursorMove(0);
    } else if (e.key === 'End' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // P2 项 4 键盘增强：Ctrl+End 文档尾——textLength O(1)（同 Ctrl+Home）
      const textLength = editorStore.getState().textLength;
      if (e.shiftKey) {
        setSelection(
          selectionStart === cursorPos ? textLength : selectionStart,
          textLength
        );
      }
      fastCursorMove(textLength);
    } else if (e.key === 'Home') {
      e.preventDefault();
      // R6-P1：行首定位经 LineOffsetTree（O(log n)），不再全文扫描 \n
      const s = editorStore.getState();
      const lineIdx = s.lineOffsets.findLineIndex(cursorPos);
      const lineStart = s.lineOffsets.getOffset(lineIdx);
      if (e.shiftKey) {
        setSelection(
          selectionStart === cursorPos ? lineStart : selectionStart,
          lineStart
        );
      }
      fastCursorMove(lineStart);
    } else if (e.key === 'End') {
      e.preventDefault();
      // R6-P1：行尾定位经 LineOffsetTree + getLine（O(log n) + O(行)），
      // 不再全文扫描 \n（行尾 = 行首 + 行文本长度，不含换行符）
      const s = editorStore.getState();
      const lineIdx = s.lineOffsets.findLineIndex(cursorPos);
      const lineStart = s.lineOffsets.getOffset(lineIdx);
      const lineEnd = lineStart + (s.getLine(lineIdx) ?? '').length;
      if (e.shiftKey) {
        setSelection(
          selectionStart === cursorPos ? lineEnd : selectionStart,
          lineEnd
        );
      }
      fastCursorMove(lineEnd);
    }
  };

  /**
   * pending flush：组合结束延迟窗口到期的最终提交。
   * 以 textarea.value 为准（浏览器最终承诺文本）；提交后清空 value
   * 并闭组。窗口内新一轮 compositionstart 会清除定时器取消本次提交，
   * 让 value 继续累积（中途 flush 的同组延续）。
   */
  const flushComposition = () => {
    pendingFlushTimer.current = null;
    const group = activeCompositionGroup.current;
    if (!group) return;
    activeCompositionGroup.current = null;
    const ta = textareaRef.current;
    const value = ta ? ta.value : '';
    if (value) {
      // merge:'typing' 与 insertText 同合并语义：单字符组合并入连续打字
      // 步（连续输入直觉）、多字符组合独立一步（合并条件含单字符约束，
      // 天然满足「整段组合 = 一个 undo 步」的撤销粒度）。
      editorStore.getState().applyChange(group.from, group.to, value, {
        merge: 'typing',
      });
    }
    if (ta) ta.value = '';
  };

  /**
   * 开组合组（compositionGroupId 状态机，04 §2.3 方案 1）：
   * - 无活跃组 → 新组：id 自增，快照组开始时的替换区间 [from, to)，
   *   并清空 textarea.value（组开始前必须为空，防历史残留污染缓冲）；
   * - 有活跃组且距上次 compositionend ≤ 50ms → 同组延续（中途 flush 的
   *   候选替换/预测拆段）：沿用同 id 与区间快照，value 保留不清空；
   * - 有活跃组但已超窗口（异常残留）→ 先强制 flush 旧组再开新组。
   */
  const openCompositionGroup = () => {
    const now = Date.now();
    const prev = activeCompositionGroup.current;
    if (prev && now - lastCompositionEndAt.current <= FLUSH_DELAY_MS) {
      return;
    }
    if (prev) {
      flushComposition();
    }
    const s = editorStore.getState();
    compositionGroupSeq.current += 1;
    activeCompositionGroup.current = {
      id: compositionGroupSeq.current,
      from: s.selectionStart,
      to: s.selectionEnd,
    };
    if (textareaRef.current) textareaRef.current.value = '';
  };

  const handleCompositionStart = () => {
    openCompositionGroup();
    isComposingRef.current = true;
    setIsComposing(true);
    editorStore.getState().setIsComposing(true);
  };

  const handleCompositionEnd = (
    e: React.CompositionEvent<HTMLTextAreaElement>
  ) => {
    isComposingRef.current = false;
    lastCompositionEndAt.current = Date.now();
    setIsComposing(false);
    editorStore.getState().setIsComposing(false);
    const ta = textareaRef.current;

    if (!activeCompositionGroup.current) {
      // 防御：浏览器乱序导致 compositionstart 丢失——直接以 value/e.data
      // 兜底提交，不丢字（正常路径组必已开）。
      const fallback = ta ? ta.value : '';
      if (fallback) {
        editorStore.getState().insertText(fallback);
        if (ta) ta.value = '';
      } else if (e.data) {
        editorStore.getState().insertText(e.data);
      }
      return;
    }

    // 不立即提交：刷新 50ms 延迟窗口，等浏览器把最终文本写入 value
    // （Android 空 data 时 value 已含提交文本；Safari dead-key 需窗口期
    // 后再读一次）。窗口内不提交不清空，供同组延续累积 value。
    if (pendingFlushTimer.current !== null) {
      clearTimeout(pendingFlushTimer.current);
    }
    pendingFlushTimer.current = window.setTimeout(
      flushComposition,
      FLUSH_DELAY_MS
    );
  };

  // beforeinput 接线（04 §2.2 I3 / CM6 input.ts 对齐）：
  // 组合缓冲期（合成中 + end 后延迟窗口）一律不处理——value 由浏览器
  // 维护、组合结束后统一以 value 提交，防止与缓冲重复插入；
  // 合成之外接管浏览器语义缺失的通道：
  // - insertReplacementText：拼写纠错/候选替换 → 替换当前选区（独立步）；
  // - deleteContentBackward/Forward：Android 无可靠 keydown 的退格/删除补丁；
  // - insertParagraph：Android 无 keydown 的换行补丁（列表续写走 keydown）。
  // 处理后清空 value：若 preventDefault 失效（旧浏览器不支持 beforeinput），
  // 后续 input 事件读到空 value 不会重复提交（双写防御）。
  // 注：必须用原生监听器——React 19 的 onBeforeInput 不从原生 beforeinput
  // 事件派生（依赖 compositionend/keypress/textInput/paste），合成转发下
  // insertReplacementText/deleteContentBackward 永远收不到。
  const handleBeforeInput = (native: InputEvent) => {
    if (isComposingRef.current || activeCompositionGroup.current) return;
    const inputType = native.inputType;
    if (!inputType) return;
    const s = editorStore.getState();
    const ta = native.target as HTMLTextAreaElement | null;
    if (inputType === 'insertReplacementText') {
      native.preventDefault();
      if (native.data) {
        s.applyChange(s.selectionStart, s.selectionEnd, native.data, {
          merge: 'none',
        });
      }
      if (ta) ta.value = '';
    } else if (inputType === 'deleteContentBackward') {
      native.preventDefault();
      s.deleteText(true);
      if (ta) ta.value = '';
    } else if (inputType === 'deleteContentForward') {
      native.preventDefault();
      s.deleteText(false);
      if (ta) ta.value = '';
    } else if (inputType === 'insertParagraph') {
      native.preventDefault();
      s.insertText('\n');
      if (ta) ta.value = '';
    } else {
      // R4-H a11y 兜底清空：函数入口已放行（非合成、无活跃组），此时 value
      // 非空只可能是 a11y 光标行同步写入的行文本——在浏览器真正插入前清
      // 空，恢复「空缓冲 → 浏览器插入 → input 整体提交」不变量（普通打字
      // keydown 之后、Android 无 keydown 的 insertText 提交等一律覆盖，
      // 防同步行文本被当作输入内容二次插入）。
      if (ta && ta.value !== '') ta.value = '';
    }
  };

  /**
   * 粘贴处理（R4-E，04 §5 剪贴板语义；原生监听——与 input/beforeinput
   * 同风格，React 19 合成事件对部分剪贴板字段转发不可靠）：
   * - 读 clipboardData：text/plain 优先，含 \t 结构 → markdown 表格；
   *   纯 URL → 选区包 [text](url)（无选区插原文）；HTML → 粗粒度转换；
   * - 统一走 store.applyChange 一次事务 = 一个 undo 步（04 §5.3 方案 4）；
   * - 组合缓冲期不干预（合成中的粘贴由浏览器经 value 缓冲处理）。
   */
  const handlePaste = (native: ClipboardEvent) => {
    if (isComposingRef.current || activeCompositionGroup.current) return;
    const cd = native.clipboardData;
    if (!cd) return;
    const s = editorStore.getState();
    const plain = cd.getData('text/plain') ?? '';
    const html = cd.getData('text/html') ?? '';
    const selectionText = s
      .getText()
      .substring(s.selectionStart, s.selectionEnd);
    const transformed = buildPasteText(plain, html, selectionText);
    // 无内容：放行浏览器默认（空粘贴无操作）
    if (transformed == null) return;
    native.preventDefault();
    s.applyChange(s.selectionStart, s.selectionEnd, transformed, {
      merge: 'none',
    });
    const ta = textareaRef.current;
    if (ta) ta.value = '';
  };

  /**
   * 写入系统剪贴板：优先 navigator.clipboard（异步，权限拒绝/不可用
   * 时回退）；兜底走隐藏 textarea 瞬时选中 + execCommand('copy')
   * （非安全上下文/旧浏览器的传统通道）。jsdom 无 execCommand 能力
   * 时静默放弃（测试经 mock 断言）。
   */
  const execCommandCopy = (content: string) => {
    const ta = textareaRef.current;
    if (!ta || typeof document.execCommand !== 'function') return;
    const prev = ta.value;
    ta.value = content;
    ta.select();
    document.execCommand('copy');
    ta.value = prev;
  };

  const writeClipboardText = (content: string) => {
    const attempt = () => execCommandCopy(content);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(content).catch(attempt);
    } else {
      attempt();
    }
  };

  // —— B5 自动补全触发（候选菜单 UI 由 ContextMenu 承载）——
  // 触发检测：光标所在行内扫触发字符（O(行)，不全文 getText join）；
  // 命中且候选非空且光标可测量 → dispatch open-autocomplete-menu
  // （携带 store 实例 + 替换区间 + 过滤后候选 + 菜单坐标）；
  // 未命中/无候选 → dispatch close（菜单保持关闭或刷新为空）。
  // 组合期（IME）不触发（value 缓冲期光标语义不可靠）。
  const maybeOpenAutocomplete = () => {
    if (isComposingRef.current || activeCompositionGroup.current) return;
    const container = containerRef.current;
    if (!container) return;
    const s = editorStore.getState();
    const triggers = getAutocompleteTriggers();
    if (triggers.length === 0) {
      window.dispatchEvent(new Event('close-autocomplete-menu'));
      return;
    }
    const lineIdx = s.lineOffsets.findLineIndex(s.cursorPos);
    const lineStart = s.lineOffsets.getOffset(lineIdx);
    const lineText = s.getLine(lineIdx) ?? '';
    const q = findAutocompleteTriggerInLine(
      lineText,
      s.cursorPos - lineStart,
      triggers
    );
    if (!q) {
      window.dispatchEvent(new Event('close-autocomplete-menu'));
      return;
    }
    const candidates = filterAutocompleteCandidates(
      q.query,
      getAutocompleteCandidates(q.trigger)
    );
    if (candidates.length === 0) {
      window.dispatchEvent(new Event('close-autocomplete-menu'));
      return;
    }
    const rect = getCoordinatesFromIndex(s.cursorPos, container);
    if (!rect) {
      // 光标行未挂载（虚拟化视口外）：不打开，下次输入重试
      window.dispatchEvent(new Event('close-autocomplete-menu'));
      return;
    }
    window.dispatchEvent(
      new CustomEvent('open-autocomplete-menu', {
        detail: {
          x: rect.left,
          y: rect.top + 24,
          trigger: q.trigger,
          query: q.query,
          start: lineStart + q.start,
          cursorPos: s.cursorPos,
          candidates,
          store: editorStore,
        },
      })
    );
  };

  /** 光标移动/编辑后强制关闭候选菜单（方向键/撤销/选区删除等） */
  const closeAutocomplete = () => {
    window.dispatchEvent(new Event('close-autocomplete-menu'));
  };

  const handleInput = (e: Event) => {
    // 组合缓冲期（合成中 + end 后 flush 延迟窗口）不直接提交：统一由
    // pending flush 以 value 为准提交，防止中途 flush/候选替换丢字、
    // 或与 flush 双写；组内不清空 value（缓冲累积的载体）。
    if (isComposingRef.current || activeCompositionGroup.current) return;
    const ta = e.target as HTMLTextAreaElement;
    const value = ta.value;
    if (value) {
      editorStore.getState().insertText(value);
      // reset textarea so we can catch next input cleanly
      ta.value = '';
      // B5 自动补全：提交后重新检测触发（新 query → 刷新候选菜单；
      // 未命中自动关闭）
      maybeOpenAutocomplete();
    }
  };

  // 原生 input/beforeinput 监听（挂载后一次性注册；textaera 卸载重挂时
  // 随 coords 恢复重新注册——coords 为 null 期间组件返回 null，无监听）。
  // input 走原生监听而非 React onChange：jsdom 中 React 19 的 onChange
  // 值变化提取失效（isInputEventSupported 探测对 jsdom 不适用），且原生
  // 监听与 React 合成行为等价（onChange 语义即原生 input 事件）。
  const mounted = coords !== null;
  useEffect(() => {
    if (!mounted) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.addEventListener('input', handleInput);
    ta.addEventListener('beforeinput', handleBeforeInput);
    ta.addEventListener('paste', handlePaste);
    return () => {
      ta.removeEventListener('input', handleInput);
      ta.removeEventListener('beforeinput', handleBeforeInput);
      ta.removeEventListener('paste', handlePaste);
    };
    // mounted 布尔：coords 在 null ↔ 非 null 间切换（textarea 卸载/重挂）
    // 时重注册；coords 持续更新（光标移动）不重注册
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  if (!coords) return null;

  return (
    <>
      {/* B5 拖放悬停高亮：文件拖入容器期间的全屏 overlay（fixed 覆盖，
          内联样式 + data-drag-drop-overlay 供测试定位；pointerEvents
          none 不拦截鼠标，drop 由容器原生事件接管） */}
      {dragOverlayVisible && (
        <div
          data-drag-drop-overlay
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9000,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            color: 'var(--text-secondary)',
            background: 'var(--selection-bg)',
            border: '2px dashed var(--border-focus)',
          }}
        >
          松开以插入文件内容
        </div>
      )}
      {/* a11y 播报节点（R4-H）：aria-live polite 静默区——光标位置/选区
          变化播报承载，SR 朗读；clip 视觉隐藏（不占布局、不进 Tab 序），
          aria-live 区域须常驻 DOM 才能播报 */}
      <div
        className="a11y-live-region"
        role="status"
        aria-live="polite"
        style={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          margin: '-1px',
          padding: 0,
          border: 0,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          clipPath: 'inset(50%)',
          whiteSpace: 'nowrap',
        }}
      >
        {announcement}
      </div>
      <textarea
        ref={textareaRef}
        defaultValue=""
        aria-label="Markdown 编辑器，输入文本；光标所在行内容会同步到输入框，可用方向键逐行阅读与编辑"
        role="textbox"
        aria-multiline="true"
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onBlur={() => {
          setIsComposing(false);
          isComposingRef.current = false;
          editorStore.getState().setIsComposing(false);
          // 失焦 = 组合被浏览器强制结束：立即 flush 防丢字（组合取消时
          // value 为空，flush 为空操作），并清掉延迟定时器防双写
          if (pendingFlushTimer.current !== null) {
            clearTimeout(pendingFlushTimer.current);
            pendingFlushTimer.current = null;
          }
          if (activeCompositionGroup.current) {
            flushComposition();
          }
        }}
        style={{
          position: 'absolute',
          top: `${coords.top}px`,
          left: `${coords.left}px`,
          width: isComposing ? '300px' : '1px',
          height: `${coords.height + 15}px`,
          opacity: isComposing ? 1 : 0,
          color: 'var(--text-primary)',
          caretColor: 'var(--black)',
          background: 'transparent',
          padding: 0,
          border: 'none',
          overflow: 'hidden',
          resize: 'none',
          outline: 'none',
          pointerEvents: 'none',
          fontFamily: 'inherit',
          fontSize: 'inherit',
          lineHeight: 'inherit',
          whiteSpace: 'nowrap',
          zIndex: 100,
        }}
        spellCheck="false"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
      />
    </>
  );
};
