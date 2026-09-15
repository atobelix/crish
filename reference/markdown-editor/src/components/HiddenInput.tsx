import React, { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import {
  useEditorStore,
  type EditorStore,
  type EditorState,
} from '../core/EditorStore';
import {
  getCoordinatesFromIndex,
  getGlobalIndexFromDOMNode,
  toContainerCoords,
  getSourceIndexFromPoint,
  syncDOMSelection,
  domSelectionMatchesModel,
} from '../core/measure';
import { useTableStore } from '../core/TableStore';
import {
  navigateTable,
  findTableRange,
  clearCell,
  setCellContent,
  parseRowCells,
  type TableRange,
} from '../core/TableOperations';
// T5b（ADR-6 / I7）：单元格选区身份 = 表内相对坐标（row 含表头行、分隔行不占行号）；
// 换算 / 归一化一律经 tableSelection 纯函数（唯一入口），不得自行推 min/max。
import { lineToRow, normalizeSelection, isSingleCell, selectionToLines } from '../core/tableSelection';
import { getTableIdentity } from '../core/tableIdentity';
import { boundaryNavigationTarget, normalizeSelectionEndpoints } from '../core/editing/selectionNavigation';
import { ViewportNavigation } from '../core/editing/viewportNavigation';
import { textIndentCommand } from '../core/editing/textIndentCommand';
import { getEditorViewport, indexFromClientPoint, revealEditorLine } from '../core/editorViewport';
import { useGeometryVersion } from './useGeometryVersion';
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
  /** 与光标层共享的挂载窗口及几何版本。 */
  layoutDeps?: string;
}

// 拖选的锚点来自按下时的原生命中，活动端始终由同一源码投影更新。
// 挂载缺口只保存目标行及行内坐标，布局就绪后再完成，绝不猜字符位置。
// 视口边缘滚动期间持续保留当前手势；释放后也结算最后一次真实命中。
// 合成 click 由本容器的一次性标志消费，新的鼠标手势立即恢复正常点击。

/** 拖选激活移动阈值（px）：mousedown 后 mousemove 超过该距离才进入拖选态，
 *  区分「点击定位」（click 由 MarkdownEngine handleContainerClick 处理）与
 *  「拖选」（引擎状态机接管）——纯点击场景 mousedown/mousemove 零副作用。 */
export const DRAG_THRESHOLD_PX = 3;
/** 视口边缘滚动触发带（px）：鼠标距容器可见区边缘小于该值即开始滚动 */
const EDGE_SCROLL_MARGIN = 16;
/** 单次 mousemove 最大滚动步长（px）：随距离线性增减（CM6 dragScrollSpeed） */
const EDGE_SCROLL_MAX_STEP = 12;
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

/**
 * T5b：`TableRange`（**绝对**行区间）+ 文档绝对行号 → 表内相对行号。
 * 换算经 `tableSelection.lineToRow`（唯一入口）；分隔行 / 区间外返回 `null`。
 * 用「本次新解析的区间」而非 `getTableIdentity`：此路径文本已改、渲染未发生，
 * 身份注册表里的区间可能滞后，会算错行号。
 */
function tableRowOfAbsLine(range: TableRange, absLine: number): number | null {
  const start = range.startLineIndex ?? 0;
  const sep = range.separatorLineIndex >= 0 ? start + range.separatorLineIndex : null;
  return lineToRow(absLine, start, start + range.lines.length - 1, sep);
}

export const HiddenInput: React.FC<HiddenInputProps> = ({
  containerRef,
  store,
  decorationVersion,
  layoutDeps,
}) => {
  // R5：绑定实例 store（缺省回退全局单例）；组件内所有 store 读写
  // （订阅 / getState / setState）统一经本变量，多实例输入互不串台
  const editorStore = store ?? useEditorStore;
  const geometryVersion = useGeometryVersion(containerRef, layoutDeps);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorPos = editorStore((state) => state.cursorPos);
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
  const navigationRef = useRef<{ container: HTMLElement; store: EditorStore; value: ViewportNavigation } | null>(null);
  const resumeDragRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);
  const getNavigation = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;
    const previous = navigationRef.current;
    if (!previous || previous.container !== container || previous.store !== editorStore) {
      previous?.value.cancel();
      navigationRef.current = { container, store: editorStore, value: new ViewportNavigation(container, editorStore) };
    }
    return navigationRef.current!.value;
  }, [containerRef, editorStore]);
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
    anchor: number | null;
    lastIndex: number;
    active: boolean;
    suppressed: boolean;
    rafId: number | null;
    pending: boolean;
    finished: boolean;
    requestedLine: number | null;
    pendingPoint: { line: number; withinLine: number; contentX: number } | null;
  } | null>(null);

  const prevCursorPosRef = useRef<number>(cursorPos);
  const prevSelectionStartRef = useRef<number | null>(selectionStart);
  const prevSelectionEndRef = useRef<number | null>(selectionEnd);

  useLayoutEffect(() => {
    getNavigation()?.resume();
    resumeDragRef.current?.();
  }, [getNavigation, layoutDeps, geometryVersion, decorationVersion, mainLines, streamTail, lineCount]);

  useEffect(() => () => {
    if (navigationRef.current?.store === editorStore) navigationRef.current.value.cancel();
  }, [editorStore]);

  // 坐标只是输入法锚点；输入宿主的生命周期不依赖目标行是否已经挂载。
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      setCoords(null);
      return;
    }
    const cursorMoved =
      prevCursorPosRef.current !== cursorPos ||
      prevSelectionStartRef.current !== selectionStart ||
      prevSelectionEndRef.current !== selectionEnd;
    prevCursorPosRef.current = cursorPos;
    prevSelectionStartRef.current = selectionStart;
    prevSelectionEndRef.current = selectionEnd;

    const rect = getCoordinatesFromIndex(cursorPos, container);
    const next = rect ? toContainerCoords(rect, container) : null;
    setCoords(next);

    // 流式追加与鼠标拖选分别拥有自己的滚动意图，输入锚点不抢占它们。
    const state = editorStore.getState();
    if (!cursorMoved || state.streamActive || (window as any).__CRISH_IS_MOUSE_DOWN) return;
    if (!next) {
      revealEditorLine(container, state.lineOffsets.findLineIndex(cursorPos));
      return;
    }
    if (next.top < container.scrollTop) {
      container.scrollTop = next.top;
    } else if (next.top + next.height > container.scrollTop + container.clientHeight) {
      container.scrollTop = next.top + next.height - container.clientHeight;
    }
  }, [
    cursorPos,
    selectionStart,
    selectionEnd,
    containerRef,
    mainLines,
    streamTail,
    lineCount,
    decorationVersion,
    layoutDeps,
    geometryVersion,
    editorStore,
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
    // 输入框常驻，坐标变化不重写其当前输入缓冲。
  }, [
    cursorPos,
    selectionStart,
    selectionEnd,
    mainLines,
    streamTail,
    lineCount,
    editorStore,
  ]);

  const handleTableKeyboardEvent = useEffectEvent((event: KeyboardEvent) => handleTableInteraction(event));

  useEffect(() => {
    const handleSelectionChange = () => {
      const container = containerRef.current;
      if (!container || isComposingRef.current || activeCompositionGroup.current) return;
      if (dragSelectRef.current && dragSelectRef.current.active) return;

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) {
        return;
      }
      // 选区的两端都属于本实例才接收，不能把另一编辑器的端点映射进来。
      if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return;
      const anchor = getGlobalIndexFromDOMNode(
        selection.anchorNode,
        selection.anchorOffset,
        container
      );
      const head = getGlobalIndexFromDOMNode(
        selection.focusNode,
        selection.focusOffset,
        container
      );
      if (anchor === null || head === null || !Number.isFinite(anchor) || !Number.isFinite(head)) return;
      const state = editorStore.getState();
      // 隐藏源码可投到同一可见边界；原生投影未变时保留模型中的完整源码端点。
      if (domSelectionMatchesModel(container, state.anchorPos, state.headPos, selection)) return;
      const next = normalizeSelectionEndpoints(state, anchor, head);
      // 原生 selectionchange 异步投递；以真实端点判等消除回声，不依赖同步锁。
      if (next.anchor !== state.anchorPos || next.head !== state.headPos) {
        state.setSelection(next.anchor, next.head);
      }
    };

    // Keep focus
    const handleGlobalClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // 1. 如果点击目标在编辑器滚动/内容容器之外（如顶部工具栏、菜单、大纲面板、查找替换、导出弹窗等），严禁抢焦点！
      // 保证各类 native <select> 下拉选项框、按钮、外部表单能够获得并保持原生焦点，不被 textarea 抢焦导致下拉框瞬闭
      const container = containerRef.current;
      if (!container || !container.contains(target)) {
        return;
      }

      // 2. 如果点击目标属于可交互控件（下拉选择框、按钮、输入框、菜单项等），不抢焦
      if (
        target.closest(
          'select, input, textarea:not(.ime-hidden-input), button, [role="button"], [role="menu"], [role="menuitem"], [role="dialog"], [role="listbox"], [role="option"], a, [tabindex]'
        )
      ) {
        return;
      }

      // 3. If text is selected on the screen, DO NOT steal focus!
      // Stealing focus will immediately destroy the user's DOM text selection.
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return;
      }
      textareaRef.current?.focus();
    };

    const handleGlobalMouseDown = () => {
      suppressClickRef.current = false;
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
      }
    };

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || isComposingRef.current) return;

      // 如果当前焦点位于编辑器之外的其他交互控件（例如外部输入框、下拉框、查找面板等），
      // 不在此处劫持 Backspace/Delete 或表格按键
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl &&
        activeEl !== textareaRef.current &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'SELECT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.isContentEditable)
      ) {
        return;
      }

      if (handleTableKeyboardEvent(e)) {
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

    // 鼠标与布局提交共享同一结算函数，未挂载目标只等待宿主的真实挂载信号。
    const finishDrag = () => {
      const d = dragSelectRef.current;
      const container = containerRef.current;
      if (!d?.finished || d.pending || !container) return;
      container.style.userSelect = '';
      const state = editorStore.getState();
      syncDOMSelection(container, state.anchorPos, state.headPos);
      dragSelectRef.current = null;
    };

    const updateDragSelection = (resume = false) => {
      const d = dragSelectRef.current;
      const container = containerRef.current;
      if (!d || !container) return;
      if (!d.active) {
        const dx = d.currentX - d.startX;
        const dy = d.currentY - d.startY;
        if (dx * dx + dy * dy <= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
          finishDrag();
          return;
        }
        d.anchor ??= indexFromClientPoint(d.startX, d.startY, container);
        if (d.anchor === null) {
          d.pending = true;
          const viewport = getEditorViewport(container);
          if (viewport) viewport.revealLine(viewport.lineAtClientY(d.startY));
          return;
        }
        d.active = true;
        d.suppressed = true;
        container.style.userSelect = 'none';
        window.getSelection()?.removeAllRanges();
        editorStore.getState().setCursorPos(d.anchor);
      }
      const rect = container.getBoundingClientRect();
      const top = rect.top + container.clientTop;
      const left = rect.left + container.clientLeft;
      let y = container.clientHeight > 0 ? Math.max(top, Math.min(top + container.clientHeight, d.currentY)) : d.currentY;
      let x = container.clientWidth > 0 ? Math.max(left, Math.min(left + container.clientWidth, d.currentX)) : d.currentX;
      const viewport = getEditorViewport(container);
      if (resume && d.pendingPoint && viewport) {
        const bounds = viewport.lineClientBounds(d.pendingPoint.line);
        if (!bounds) return;
        y = bounds.top + d.pendingPoint.withinLine;
        x = d.pendingPoint.contentX + rect.left - container.scrollLeft;
      }
      const index = indexFromClientPoint(x, y, container);
      d.pending = index === null;
      if (index === null) {
        const line = resume && d.pendingPoint ? d.pendingPoint.line : viewport?.lineAtClientY(y);
        const bounds = line !== undefined ? viewport?.lineClientBounds(line) : null;
        if (line !== undefined && bounds && (!resume || !d.pendingPoint)) {
          d.pendingPoint = { line, withinLine: y - bounds.top, contentX: x - rect.left + container.scrollLeft };
        }
        if (viewport && line !== undefined && line !== d.requestedLine) {
          d.requestedLine = line;
          viewport.revealLine(line);
        }
        return;
      }
      d.requestedLine = null;
      d.pendingPoint = null;
      if (index !== d.lastIndex) {
        d.lastIndex = index;
        editorStore.getState().moveHead(index);
      }
      finishDrag();
    };
    const resumePendingDrag = () => updateDragSelection(true);
    const updateScrolledDrag = () => updateDragSelection();
    resumeDragRef.current = resumePendingDrag;

    const handleDragMouseDown = (e: MouseEvent) => {
      suppressClickRef.current = false;
      const container = containerRef.current;
      if (!container || e.button !== 0 || isComposingRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('.line-table-row, .token-table-cell')) return;
      const state = editorStore.getState();
      const selection = window.getSelection();
      if (state.selectionStart === state.selectionEnd && selection && selection.toString().length > 0) return;
      getNavigation()?.cancel();
      const anchor = indexFromClientPoint(e.clientX, e.clientY, container);
      dragSelectRef.current = {
        startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY,
        anchor, lastIndex: -1, active: false, suppressed: false, rafId: null,
        pending: false, finished: false, requestedLine: null, pendingPoint: null,
      };
    };

    const scrollDrag = () => {
      const d = dragSelectRef.current;
      const container = containerRef.current;
      if (!d?.active || d.finished || !container) return;
      const step = edgeScrollStep(d.currentY, container);
      const old = container.scrollTop;
      const max = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.min(max, Math.max(0, old + step));
      updateDragSelection();
      if (step !== 0 && container.scrollTop !== old) d.rafId = requestAnimationFrame(scrollDrag);
      else d.rafId = null;
    };

    const handleDragMouseMove = (e: MouseEvent) => {
      // 单元格交互仍由表格状态机拥有，只替换其坐标命中入口。
      const cellDrag = (window as any).__CRISH_CELL_TEXT_DRAG;
      if (cellDrag?.cellEl) {
        const index = getSourceIndexFromPoint(e.clientX, e.clientY, cellDrag.cellEl);
        if (index !== null) editorStore.getState().setSelection(cellDrag.anchorIdx, index);
        return;
      }
      const d = dragSelectRef.current;
      if (!d || d.finished) return;
      d.currentX = e.clientX;
      d.currentY = e.clientY;
      updateDragSelection();
      if (d.rafId === null) scrollDrag();
    };

    const handleDragMouseUp = (e: MouseEvent) => {
      (window as any).__CRISH_CELL_TEXT_DRAG = null;
      const d = dragSelectRef.current;
      if (!d) return;
      const samePoint = d.currentX === e.clientX && d.currentY === e.clientY;
      if (d.rafId !== null) cancelAnimationFrame(d.rafId);
      d.rafId = null;
      d.currentX = e.clientX;
      d.currentY = e.clientY;
      d.finished = true;
      if (d.active) suppressClickRef.current = true;
      if (containerRef.current) containerRef.current.style.userSelect = '';
      updateDragSelection(samePoint);
      textareaRef.current?.focus({ preventScroll: true });
    };

    const resetClickSuppression = () => { suppressClickRef.current = false; };
    const handleClickCapture = (event: MouseEvent) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
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
      const pos = indexFromClientPoint(e.clientX, e.clientY, container);
      if (pos === null) return;
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
      containerEl.addEventListener('pointerdown', resetClickSuppression, true);
      containerEl.addEventListener('click', handleClickCapture, true);
      containerEl.addEventListener('dblclick', handleContainerDblClick);
      containerEl.addEventListener('dragenter', handleDragEnter);
      containerEl.addEventListener('dragover', handleDragOver);
      containerEl.addEventListener('dragleave', handleDragLeave);
      containerEl.addEventListener('drop', handleDrop);
      containerEl.addEventListener('scroll', updateScrolledDrag);
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
        if (resumeDragRef.current === resumePendingDrag) resumeDragRef.current = null;
        containerEl.removeEventListener('mousedown', handleDragMouseDown);
        containerEl.removeEventListener('pointerdown', resetClickSuppression, true);
        containerEl.removeEventListener('click', handleClickCapture, true);
        containerEl.removeEventListener('dblclick', handleContainerDblClick);
        containerEl.removeEventListener('dragenter', handleDragEnter);
        containerEl.removeEventListener('dragover', handleDragOver);
        containerEl.removeEventListener('dragleave', handleDragLeave);
        containerEl.removeEventListener('drop', handleDrop);
        containerEl.removeEventListener('scroll', updateScrolledDrag);
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
  }, [containerRef, editorStore, getNavigation]);

  const handleTableInteraction = (e: KeyboardEvent | React.KeyboardEvent) => {
    const selectedCell = useTableStore.getState().selectedCell;
    if (!selectedCell) return false;
    const text = editorStore.getState().getText();
    const cursorPos = editorStore.getState().cursorPos;

    if (!selectedCell.isEditing) {
      // 1. 单元格多选复制 (Ctrl+C / Cmd+C: 导出 TSV 格式制表符数据)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        // 读源码行需文档绝对行号 → selectionToLines 折算；null = 身份未观测过 → 不接管
        const lines = selectionToLines(selectedCell);
        if (!lines) return false;
        const storeState = editorStore.getState();
        const copiedRows: string[] = [];
        for (let r = lines.startLine; r <= lines.endLine; r++) {
          const lineText = storeState.getLine(r) ?? '';
          if (/^\|?[\s:-]*[-]+[\s:-]*\|/.test(lineText.trim())) continue;
          const { cells } = parseRowCells(lineText);
          const selectedRowCells: string[] = [];
          for (let c = lines.startCol; c <= lines.endCol; c++) {
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

      // 单元格粘贴 (Ctrl+V / Cmd+V)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        void navigator.clipboard.readText().then((clipText) => {
          if (!clipText) return;
          const curState = editorStore.getState();
          const res = setCellContent(curState.getText(), curState.cursorPos, clipText);
          if (res && res.newText !== curState.getText()) {
            curState.applyTableChange(0, curState.getText().length, res.newText, res.newCursorPos);
          }
        });
        return true;
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
        // 相对区间由 normalizeSelection 派生；多格清空另经 selectionToLines 折算绝对行
        const b = normalizeSelection(selectedCell);
        const lines = selectionToLines(selectedCell);

        if (isSingleCell(selectedCell)) {
          const res = clearCell(text, cursorPos);
          if (res.newText !== text) {
            editorStore.getState().replaceWholeDoc(res.newText);
          }
          editorStore.getState().setCursorPos(res.newCursorPos);
        } else if (lines) {
          // 多单元格批量清空（保留管道符结构）
          const currentLines = editorStore.getState().getText().split('\n');
          let hasChanges = false;
          for (let r = lines.startLine; r <= lines.endLine; r++) {
            const lineText = currentLines[r] || '';
            if (/^\|?[\s:-]*[-]+[\s:-]*\|/.test(lineText.trim())) continue;
            const { pipePositions } = parseRowCells(lineText);
            if (pipePositions.length <= 1) continue;
            let modifiedLine = lineText;
            for (let c = Math.min(b.c1, pipePositions.length - 2); c >= b.c0; c--) {
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
            editorStore.getState().replaceWholeDoc(currentLines.join('\n'));
          }
        }
        return true;
      }

      // Shift+方向键：扩展单元格多选范围（T5b：焦点在**表内相对行号**上 ±1）
      if (
        e.shiftKey &&
        (e.key === 'ArrowRight' ||
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowDown' ||
          e.key === 'ArrowUp')
      ) {
        e.preventDefault();
        const tableStore = useTableStore.getState();
        // 焦点 = 拖选活动格（相对坐标；单选时 anchor === focus）
        const focus = selectedCell.focus;
        if (e.key === 'ArrowRight') {
          tableStore.updateCellSelectionEnd({ row: focus.row, col: focus.col + 1 });
        } else if (e.key === 'ArrowLeft') {
          tableStore.updateCellSelectionEnd({ row: focus.row, col: Math.max(0, focus.col - 1) });
        } else if (e.key === 'ArrowDown') {
          // 相对行 +1 = 下一表行：分隔行不占行号，天然跳过；上界由身份 endLine 折算
          const entry = getTableIdentity(selectedCell.tableId);
          const maxRow = entry ? lineToRow(entry.endLine, entry.startLine, entry.endLine, entry.separatorLine) : null;
          if (maxRow !== null && focus.row + 1 <= maxRow) tableStore.updateCellSelectionEnd({ row: focus.row + 1, col: focus.col });
        } else if (e.key === 'ArrowUp') {
          // 相对行 -1；row ≥ 0 即仍在表内（表首行 = 0，其上一行必在表外）
          if (focus.row - 1 >= 0) tableStore.updateCellSelectionEnd({ row: focus.row - 1, col: focus.col });
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
            editorStore.getState().applyTableChange(0, text.length, res.newText, res.newCursorPos);
          } else {
            editorStore.getState().setCursorPos(res.newCursorPos);
          }
          const newTable = findTableRange(res.newText, res.newCursorPos);
          if (newTable) {
            // 导航结果只有绝对行号 → 经 lineToRow 折算相对行（唯一入口）
            const row = tableRowOfAbsLine(newTable, newTable.absoluteLineIndex ?? newTable.activeLineIndex);
            if (row !== null) useTableStore.getState().enterCellSelection(selectedCell.tableId, { row, col: newTable.activeCellIndex });
          }
        }
        return true;
      }

      // 如果按普通字符键（单字符输入），清空当前单元格并直接输入该字符并转为编辑态
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        e.preventDefault();
        const res = setCellContent(text, cursorPos, e.key);
        if (res.newText !== text) {
          editorStore.getState().applyTableChange(0, text.length, res.newText, res.newCursorPos);
        } else {
          editorStore.getState().setCursorPos(res.newCursorPos);
        }
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
            editorStore.getState().applyTableChange(0, text.length, res.newText, res.newCursorPos);
          } else {
            editorStore.getState().setCursorPos(res.newCursorPos);
          }
          const newTable = findTableRange(res.newText, res.newCursorPos);
          if (newTable) {
            // 导航结果只有绝对行号 → 经 lineToRow 折算相对行（唯一入口）
            const row = tableRowOfAbsLine(newTable, newTable.absoluteLineIndex ?? newTable.activeLineIndex);
            if (row !== null) useTableStore.getState().enterCellSelection(selectedCell.tableId, { row, col: newTable.activeCellIndex });
          }
        }
        return true;
      }
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        editorStore.getState().applyChange(cursorPos, cursorPos, '<br>', {
          cursorAfter: cursorPos + 4,
          merge: 'none',
        });
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const res = navigateTable(text, cursorPos, 'enter');
        if (res) {
          if (res.newText !== text) {
            editorStore.getState().applyTableChange(0, text.length, res.newText, res.newCursorPos);
          } else {
            editorStore.getState().setCursorPos(res.newCursorPos);
          }
          const newTable = findTableRange(res.newText, res.newCursorPos);
          if (newTable) {
            // 导航结果只有绝对行号 → 经 lineToRow 折算相对行（唯一入口）
            const row = tableRowOfAbsLine(newTable, newTable.absoluteLineIndex ?? newTable.activeLineIndex);
            if (row !== null) useTableStore.getState().enterCellSelection(selectedCell.tableId, { row, col: newTable.activeCellIndex });
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
              // 同格换列：行沿用选区锚点行（对应旧 startLine，相对行号）
              useTableStore.getState().enterCellEdit({ tableId: selectedCell.tableId, row: selectedCell.anchor.row, col: prevCol });
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
              // 同格换列：行沿用选区锚点行（对应旧 startLine，相对行号）
              useTableStore.getState().enterCellEdit({ tableId: selectedCell.tableId, row: selectedCell.anchor.row, col: nextCol });
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
                // 跨行换格：绝对行号 → 相对行（唯一入口 lineToRow）
                const targetRow = tableRowOfAbsLine(table, (table.startLineIndex ?? 0) + prevLineIdx);
                if (targetRow !== null) useTableStore.getState().enterCellEdit({ tableId: selectedCell.tableId, row: targetRow, col: targetCol });
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
                // 跨行换格：绝对行号 → 相对行（唯一入口 lineToRow）
                const targetRow = tableRowOfAbsLine(table, (table.startLineIndex ?? 0) + nextLineIdx);
                if (targetRow !== null) useTableStore.getState().enterCellEdit({ tableId: selectedCell.tableId, row: targetRow, col: targetCol });
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

  /**
   * 智能退格（Smart Backspace）：
   * 在任务列表（`- [ ] `）、有序/无序列表（`1. ` / `- `）、块引用（`> `）等前缀边界处，
   * 一键清除前缀或反缩进，彻底根除敲 6~8 次退格逐字符删除隐藏语法字符的恶劣体验。
   * 处理了前缀返回 true；否则返回 false 交由底层单字符删除。
   */
  const handleSmartBackspace = (): boolean => {
    const s = editorStore.getState();
    if (s.runListCommand('backspace')) return true;
    if (s.selectionStart !== s.selectionEnd) return false;

    const pos = s.cursorPos;
    const lineIdx = s.lineOffsets.findLineIndex(pos);
    if (s.getLineContext(lineIdx).codeState !== 'none') return false;
    const lineStart = s.lineOffsets.getOffset(lineIdx);
    const lineText = s.getLine(lineIdx) ?? '';
    const inLine = pos - lineStart;


    // 3. 块引用 / Callout 智能退格（> ）
    const bqMatch = lineText.match(/^(\s*)(>+)\s*/);
    if (bqMatch) {
      const prefixLen = bqMatch[0].length;
      if (inLine <= prefixLen && inLine > 0) {
        const indent = bqMatch[1];
        const quotes = bqMatch[2];
        const rest = lineText.slice(prefixLen);
        if (quotes.length > 1) {
          // 多级引用：减少一级引用深度
          const newPrefix = `${indent}${'>'.repeat(quotes.length - 1)} `;
          s.applyChange(
            lineStart,
            lineStart + lineText.length,
            newPrefix + rest,
            { cursorAfter: lineStart + newPrefix.length }
          );
          return true;
        }
        // 单级引用：一键清除引用前缀，变为普通正文
        s.applyChange(
          lineStart,
          lineStart + lineText.length,
          indent + rest,
          { cursorAfter: lineStart + indent.length }
        );
        return true;
      }
    }

    return false;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 候选导航属于输入法；组合结束后的首个文档命令先提交待定文本，再读取端点。
    if (isComposingRef.current || e.nativeEvent.isComposing) return;
    if (activeCompositionGroup.current) flushComposition();
    const navigation = getNavigation();
    const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown';
    const directNavigation = vertical || ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.metaKey);
    const ownedCommand = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', 'Tab', 'Backspace', 'Delete'].includes(e.key) ||
      ((e.ctrlKey || e.metaKey) && ['a', 'c', 'z', 'y'].includes(e.key.toLowerCase()));
    if (!directNavigation && navigation?.pending && !navigation.executingAction &&
      ownedCommand) {
      e.preventDefault();
      navigation.afterNavigation(() => handleKeyDown(e));
      return;
    }
    if (!vertical && (!navigation?.pending || navigation.executingAction)) navigation?.resetColumn();
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

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      closeAutocomplete();
      navigation?.request(e.key, e.shiftKey);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      // 合成中退格删除的是候选文本（浏览器经 value 缓冲处理），
      // 绝不触达文档——防误删已提交内容（composition 内不重复处理）
      if (isComposingRef.current) return;
      if (!handleSmartBackspace()) {
        deleteText(true);
      }
      // B5 自动补全：删除后重新检测（触发词可能仍在——@alic → @ali）
      maybeOpenAutocomplete();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      if (isComposingRef.current) return;
      deleteText(false);
      maybeOpenAutocomplete();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isComposingRef.current) return;

      const state = editorStore.getState();
      if (!e.shiftKey && state.runListCommand('enter')) return;
      const pos = state.selectionStart;
      const lineIdx = state.lineOffsets.findLineIndex(pos);
      const lineStart = state.lineOffsets.getOffset(lineIdx);
      const lineText = state.getLine(lineIdx) ?? '';
      const inLine = pos - lineStart;
      const textBeforeCursor = lineText.slice(0, inLine);
      if (state.getLineContext(lineIdx).codeState !== 'none') {
        state.applyChange(state.selectionStart, state.selectionEnd, '\n', { merge: 'none' });
        return;
      }

      // 1. 表格环境（Table Row）判定：优先保障表格结构与单元格多行编辑
      const isTableRow = /^\s*\|/.test(lineText) || /\|\s*$/.test(lineText);
      if (isTableRow) {
        if (e.shiftKey) {
          // 表格单元格内 Shift+Enter：插入 <br> 标签以支持多行编辑（遵循 CommonMark 规范，杜绝破坏行结构）
          state.applyChange(pos, pos, '<br>', { cursorAfter: pos + 4 });
          return;
        }

        // 普通 Enter：检查当前行是否为带格式的纯空行（除了管道符和空白外无任何有效文本）
        const isEmptyRow = lineText.replace(/[|\s]/g, '') === '';
        if (isEmptyRow) {
          // 空表格行二次回车：跳出表格，转为普通正文空行
          state.applyChange(lineStart, lineStart + lineText.length, '', {
            cursorAfter: lineStart,
          });
          return;
        }

        // 分隔行（例如 |:---|:---|）：直接在下方续建新行
        const isSeparatorRow = /^\s*\|?[\s:-]+(?:\|[\s:-]+)+\|?\s*$/.test(lineText);
        if (isSeparatorRow) {
          state.applyChange(pos, pos, '\n', { cursorAfter: pos + 1 });
          return;
        }

        // 格式复用：统计当前表格列数，在下方续建同列数的新行（格式复用：带格式的空行）
        const cellPipes = lineText.match(/\|/g);
        const colCount = Math.max(1, (cellPipes ? cellPipes.length : 2) - 1);
        const emptyCells = Array(colCount).fill('  ').join(' | ');
        const newRowText = `| ${emptyCells} |`;
        
        const insertPos = lineStart + lineText.length;
        const newCursorPos = insertPos + 1 + 2; // 定位到新行第 1 单元格内部
        state.applyChange(insertPos, insertPos, '\n' + newRowText, {
          cursorAfter: newCursorPos,
        });

        // 驱动 TableStore 自动聚焦新行首个单元格编辑
        const tableStore = useTableStore.getState();
        const sel = tableStore.selectedCell;
        // 新行紧跟当前行 → 相对行号 = 当前行 + 1（相对行号连续且不含分隔行）
        const entry = sel ? getTableIdentity(sel.tableId) : undefined;
        const curRow = entry ? lineToRow(lineIdx, entry.startLine, entry.endLine, entry.separatorLine) : null;
        if (sel && curRow !== null) tableStore.enterCellEdit({ tableId: sel.tableId, row: curRow + 1, col: 0 });
        return;
      }

      if (e.shiftKey) {
        // 普通换行以选区为替换范围，正反向选择得到同一文本事务。
        state.applyChange(state.selectionStart, state.selectionEnd, '\n', { merge: 'none' });
        return;
      }

      // 2. 块引用 / Callout（Blockquote）环境判定（> ）
      const bqMatch = textBeforeCursor.match(/^(\s*(?:>\s*)+)/);
      if (bqMatch) {
        const prefix = bqMatch[0];
        if (state.selectionStart !== state.selectionEnd) {
          state.applyChange(state.selectionStart, state.selectionEnd, '\n' + prefix, { merge: 'none' });
          return;
        }
        const contentAfterPrefix = lineText.slice(prefix.length).trim();
        if (contentAfterPrefix === '') {
          // 当前引用行为空行：跳出引用或降级一层引用
          const quoteCount = (prefix.match(/>/g) || []).length;
          if (quoteCount > 1) {
            const newPrefix = prefix.replace(/>\s*$/, '');
            state.applyChange(lineStart, lineStart + lineText.length, newPrefix, {
              cursorAfter: lineStart + newPrefix.length,
            });
          } else {
            // 顶层引用直接退出，变为空行
            state.applyChange(lineStart, lineStart + lineText.length, '', {
              cursorAfter: lineStart,
            });
          }
          return;
        }

        // 非空引用行：格式复用，新行自动延续引用前缀
        const cleanPrefix = prefix.endsWith(' ') ? prefix : prefix + ' ';
        state.applyChange(pos, pos, '\n' + cleanPrefix, {
          cursorAfter: pos + 1 + cleanPrefix.length,
        });
        return;
      }


      // 4. 普通正文回车
      state.applyChange(state.selectionStart, state.selectionEnd, '\n', { merge: 'none' });
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // R6-P1：全选边界用 textLength（O(1)），不再全文 getText()
      setSelection(0, editorStore.getState().textLength);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const state = editorStore.getState();
      if (state.runListCommand(e.shiftKey ? 'outdent' : 'indent')) return;
      const text = state.getText();
      const cursorPos = state.cursorPos;

      const res = navigateTable(
        text,
        cursorPos,
        e.shiftKey ? 'shift-tab' : 'tab'
      );
      if (res) {
        if (res.newText !== text) {
          editorStore.getState().replaceWholeDoc(res.newText);
        }
        editorStore.getState().setCursorPos(res.newCursorPos);
      } else {
        const edit = textIndentCommand(state, e.shiftKey);
        if (edit && (edit.from !== edit.to || edit.insert !== '')) {
          state.applyChange(edit.from, edit.to, edit.insert, { selectionAfter: edit.selectionAfter, merge: 'none' });
        }
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      closeAutocomplete();
      navigation?.request(e.key, e.shiftKey);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const s = editorStore.getState();
      const target = boundaryNavigationTarget(s, e.key, e.ctrlKey || e.metaKey);
      closeAutocomplete();
      if (e.shiftKey) {
        s.moveHead(target);
      } else {
        s.setCursorPos(target);
      }
    }
  };

  /**
   * pending flush：组合结束延迟窗口到期的最终提交。
   * 以 textarea.value 为准（浏览器最终承诺文本）；提交后清空 value
   * 并闭组。窗口内新一轮 compositionstart 会清除定时器取消本次提交，
   * 让 value 继续累积（中途 flush 的同组延续）。
   */
  const flushComposition = () => {
    if (pendingFlushTimer.current !== null) clearTimeout(pendingFlushTimer.current);
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
      const commit = () => editorStore.getState().applyChange(group.from, group.to, value, { merge: 'typing' });
      const navigation = getNavigation();
      if (navigation?.pending) navigation.afterNavigation(commit);
      else commit();
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
    const group = activeCompositionGroup.current;
    const navigation = getNavigation();
    if (navigation?.pending) navigation.afterNavigation(() => {
      const state = editorStore.getState();
      group.from = state.selectionStart;
      group.to = state.selectionEnd;
    });
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
    const navigation = getNavigation();
    if (navigation?.pending && !navigation.executingAction &&
      ['insertReplacementText', 'deleteContentBackward', 'deleteContentForward', 'insertParagraph'].includes(inputType)) {
      native.preventDefault();
      if (textareaRef.current) textareaRef.current.value = '';
      navigation.afterNavigation(() => handleBeforeInput(native));
      return;
    }
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
      if (!handleSmartBackspace()) {
        s.deleteText(true);
      }
      if (ta) ta.value = '';
    } else if (inputType === 'deleteContentForward') {
      native.preventDefault();
      s.deleteText(false);
      if (ta) ta.value = '';
    } else if (inputType === 'insertParagraph') {
      native.preventDefault();
      if (!s.runListCommand('enter')) s.insertText('\n');
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
    // 粘贴单一所有者契约：本监听（textarea 原生）是唯一处理者——处理完
    // stopPropagation，防事件冒泡到容器级 paste 监听（MarkdownEngine）
    // 造成二次插入（双写回归：表格内容被拼接两遍）。
    native.stopPropagation();
    const commit = () => {
      const current = editorStore.getState();
      const selected = current.getText().slice(current.selectionStart, current.selectionEnd);
      const insert = buildPasteText(plain, html, selected);
      if (insert !== null) current.applyChange(current.selectionStart, current.selectionEnd, insert, { merge: 'none' });
    };
    const navigation = getNavigation();
    if (navigation?.pending) navigation.afterNavigation(commit);
    else commit();
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
      const commit = () => {
        editorStore.getState().insertText(value);
        maybeOpenAutocomplete();
      };
      const navigation = getNavigation();
      if (navigation?.pending) navigation.afterNavigation(commit);
      else commit();
      // reset textarea so we can catch next input cleanly
      ta.value = '';
      // B5 自动补全：提交后重新检测触发（新 query → 刷新候选菜单；
      // 未命中自动关闭）
    }
  };

  // 原生输入监听随编辑器实例注册；几何暂不可测时仍保留同一个输入宿主。
  useEffect(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorStore]);

  return (
    <>
      {/* B5 拖放悬停高亮：文件拖入容器期间的全屏 overlay（fixed 覆盖，
          内联样式 + data-drag-drop-overlay 供测试定位；pointerEvents
          none 不拦截鼠标，drop 由容器原生事件接管） */}
      {dragOverlayVisible && (
        <div className="drag-drop-overlay" data-drag-drop-overlay>
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
          top: coords?.top ?? containerRef.current?.scrollTop ?? 0,
          left: coords?.left ?? containerRef.current?.scrollLeft ?? 0,
          width: isComposing ? '300px' : '1px',
          height: coords ? `${coords.height}px` : '1lh',
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
          zIndex: 'var(--z-input)',
        }}
        spellCheck="false"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
      />
    </>
  );
};
