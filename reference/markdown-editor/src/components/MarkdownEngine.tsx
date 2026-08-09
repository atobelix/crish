import React, {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BlockRenderer } from './BlockRenderer';
import { HiddenInput } from './HiddenInput';
import { CursorLayer } from './CursorLayer';
import { SelectionHighlight } from './SelectionHighlight';
import { useEditorStore, type EditorState } from '../core/EditorStore';
import { useTableStore } from '../core/TableStore';
import { MarkdownParser } from '../core/parser';
import { HeightMap, HeightOracle, classifyLine } from '../core/HeightMap';

import { type CodeState } from '../core/parser';

/**
 * 行状态惰性访问器（R3-B1 访问器切换）：store 目前只暴露了
 * getLine/getLineCount/getLineIndex，未暴露行状态访问器——此处镜像
 * getLine 的「主数组 + 流式尾段」双段边界语义（EditorStore.getLine 的
 * 实现：尾段为空 → 直接读主数组；非空 → 尾段「接管」主数组末行，
 * i ≥ boundary = main.length - 1 时从尾段相对下标 i - boundary 取）：
 * - 尾段为空（常规编辑/加载路径）：直接读主状态数组（全量，零额外开销）；
 * - 尾段非空（append 流式期间）：按边界取尾段状态，全程不触读物化
 *   codeBlockState 视图（尾段非空时物化会执行 concat 过渡成本）。
 * 渲染热路径（LineItem 取行/主组件 estimateSize/批量测量）统一经
 * store.getState().getLine(i) + 本访问器取行内容与状态，绝不读
 * state.lines / state.codeBlockState 物化数组（R3-B1 验收）。
 */
function getLineState(s: EditorState, i: number): CodeState {
  if (s.streamTailCodeState.length === 0) return s.mainCodeState[i];
  const boundary = s.mainLines.length - 1;
  return i < boundary ? s.mainCodeState[i] : s.streamTailCodeState[i - boundary];
}

// ── C3 流式直刷 DOM（08 方案优化补充 §1 招 1 限定版 / 09 方案修订终版 §4 C3）──
// 直刷仅限「纯文本末行」：行内无任何可构成 CommonMark 语法的字符，
// 渲染结果必然是单个 text token 的正文行。判定字符集刻意保守——
// `* # ` [ $ | > - _ ~ < \ = + . 0-9 ! ^ ) ( { }`（外加与 [ 配对的 ]）全部
// 列为禁入字符，宁可少直刷不可误刷：任何禁入字符出现即拒绝直刷，该行走
// store.appendText 常规路径，渲染结果由解析器权威决定（直刷只碰「无论怎么
// 解析都必然是纯文本」的行，从根上杜绝「直刷内容与解析渲染分叉」）。
const DIRECT_STREAM_FORBIDDEN_CHARS = new Set(
  "*#`[$|>-_~<\\=+.0123456789!^)({}]"
);

// 直刷行文本长度上限：镜像 BlockRenderer.MAX_VISIBLE_LINE_CHARS（5000）——
// 渲染层对超长行执行截断折叠（⋯ 已折叠 N 字符），直刷若越过该阈值，DOM
// 展示的文本将多于渲染折叠视图（flush 后视觉跳变）。保守起见直刷绝不越过。
const DIRECT_STREAM_MAX_LINE_CHARS = 5_000;

/**
 * 纯文本行保守判定（C3 限定版：直刷前置条件之一）：
 * - 非空行（空行/纯空白行渲染为 <br/> 结构，无 text token 可直写）；
 * - 不以空白开头（≥4 空格缩进 = 缩进代码块，1-3 空格缩进也一并回避）；
 * - 全文不含 DIRECT_STREAM_FORBIDDEN_CHARS 中任一字符（含行首语法
 *   标记：标题/列表/引用/表格/围栏/数学/分隔线/HTML 块，以及行中
 *   行内语法：强调/链接/脚注/行内代码/转义等）。
 * 判定对象是「末行 + 待追加 chunk」的合并结果（调用方负责拼接）——
 * 直刷过程中 DOM 文本逐 chunk 增长，只有合并后仍为纯文本行才直写。
 */
// oxlint-disable-next-line react/only-export-components -- 任务规定导出纯函数供 R5/测试复用
export function isPlainTextLine(lineText: string): boolean {
  if (lineText.length === 0) return false;
  const first = lineText[0];
  if (first === ' ' || first === '\t') return false;
  for (let i = 0; i < lineText.length; i++) {
    if (DIRECT_STREAM_FORBIDDEN_CHARS.has(lineText[i])) return false;
  }
  return true;
}

/**
 * MarkdownEngine 命令式流式接口（R5 集成轮宿主接线）：
 * 宿主流式路径 = streamAppend(chunk)（直刷优先）→ streamEnd()（flush 收口）。
 * 直刷的 flush 提交走 store.appendText（R3-A stop-flush 语义自动生效：
 * 光标平移/流式合并 undo meta:'stream' 均由 store 统一处理）。
 */
export interface MarkdownEngineHandle {
  /** 流式追加：纯文本末行且 chunk 无换行 → 命令式直写 DOM（store 延迟提交）；
   *  否则（含换行/末行非纯文本/超长/行未挂载）→ 先 flush 累积再走 appendText。 */
  streamAppend: (chunk: string) => void;
  /** 流式结束：flush 直刷累积（appendText 一次提交）并 stop-flush 尾段
   *  （合并为单个 meta:'stream' undo 步）。幂等。 */
  streamEnd: () => void;
  /** 主动 flush（宿主可提前提交直刷累积；无累积时为空操作，幂等）。 */
  flushStream: () => void;
}

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
  rowRef,
  streamingDirty
}: {
  index: number;
  lineText: string;
  offset: number;
  isCode: CodeState;
  rowRef: (el: HTMLElement | null) => void;
  // C3 dirty 协议：直刷期间本行 props 行文本滞后于 DOM（直刷文本尚未
  // 提交 store）。为 true 时本行进入冻结渲染（见 frozenContentRef），
  // 并打上 data-streaming-dirty 标记（调试/巡检可见）。
  streamingDirty?: boolean;
}) => {
  // C3 直刷冻结快照（dirty 覆盖渲染路径，09 §4 C3 代码级落实）：
  // 干净渲染时把「本次 BlockRenderer 元素」存入 ref；dirty 渲染时返回
  // 该同引用元素——React 对同一元素引用（props 对象 Object.is 相等）
  // 直接跳过子树协调，BlockRenderer/InlineRenderer 不再重跑，DOM 上
  // 已直刷的文本原样保留，杜绝「React 用旧 lineText 覆盖直刷文本」。
  // flush 后 dirty 清除 → 按最新 lineText 全新渲染，DOM 与 store 收敛。
  const frozenContentRef = useRef<React.ReactElement | null>(null);

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
      // 经访问器读上一行（R3-B1：不读物化 state.lines——尾段非空时
      // 物化会执行 concat；getLine 是双段惰性视图，语义与物化视图一致）
      const prevLine = state.getLine(firstTableIndex - 1);
      if (prevLine && prevLine.trim().startsWith('|')) {
        firstTableIndex--;
      } else {
        break;
      }
    }
    return `table-${firstTableIndex}`;
  });

  const lineNode = MarkdownParser.parseLine(lineText, offset, isCode);

  const freshContent = (
    <BlockRenderer
      block={lineNode}
      index={index}
      lineOffset={offset}
      activeState={activeState}
      tableId={tableId}
    />
  );
  if (!streamingDirty) {
    frozenContentRef.current = freshContent;
  }
  const rowContent = streamingDirty
    ? (frozenContentRef.current ?? freshContent)
    : freshContent;

  return (
    <div
      data-index={index}
      data-line-start={offset}
      data-line-length={lineText.length}
      data-streaming-dirty={streamingDirty ? 'true' : undefined}
      ref={rowRef}
      className={`virtual-row ${activeState ? 'is-active-line' : ''}`.trim()}
      style={{
        position: 'absolute',
        left: 0,
        width: '100%',
        minHeight: lineNode.type === 'table_separator' ? '0px' : '28px',
      }}
    >
      {rowContent}
    </div>
  );
});

export const MarkdownEngine = React.forwardRef<MarkdownEngineHandle, Record<string, never>>(
  function MarkdownEngine(_props, ref) {
  const parentRef = useRef<HTMLDivElement>(null);
  // —— R3-B1 访问器切换：触发信号订阅（不订阅物化视图 state.lines /
  // state.codeBlockState——尾段非空时物化会执行 O(全文) concat 过渡成本，
  // 渲染热路径已完全移除该依赖）——
  // 双段存储引用（main* + streamTail*）：任何内容变更（编辑/append/undo/
  // flush 等）都至少换其一新引用，作为主组件重渲染的触发信号；
  // 行内容/行状态在渲染时经 store.getState().getLine(i)/getLineState 惰性读取。
  const mainLines = useEditorStore(state => state.mainLines);
  const streamTail = useEditorStore(state => state.streamTail);
  const mainCodeState = useEditorStore(state => state.mainCodeState);
  const streamTailCodeState = useEditorStore(state => state.streamTailCodeState);
  // 行数信号：count 变化触发重渲染是必要行为（virtualizer count 同步）；
  // 选择器每次 set 都执行（O(1)，纯 length 读取），返回值按值比较。
  const lineCount = useEditorStore(state => state.getLineCount());
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
    count: lineCount,
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
      // R3-B1：行内容/状态经访问器惰性读取（estimateSize 可能在渲染期间
      // 被库调用，直接 getState() 读最新——同一同步 tick 内与订阅状态一致；
      // 不读物化 lines/codeBlockState 视图）
      const s = useEditorStore.getState();
      const raw = s.getLine(i) ?? '';
      const st = getLineState(s, i);
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

  // ── C3 流式直刷状态（ref 级，不触发渲染）──
  // pendingStreamRef：已直写 DOM、尚未提交 store 的累积文本（直刷会话
  // 的延迟提交缓冲，与 C4 尾段互为镜像——直刷 flush 一次性 appendText）；
  // dirtyRefs：直刷行 index 集合（直刷恒作用于末行，故实际至多一个元素，
  // 用 Set 保持协议约定形态）；dirtyRowOutOfViewRef：直刷行当前是否在
  // 可见视口之外（决定「滚动到尾部触达 dirty 行 → flush」的判定）。
  const dirtyRefs = useRef<Set<number>>(new Set());
  const pendingStreamRef = useRef('');
  const dirtyRowOutOfViewRef = useRef(false);

  // flush 实现（C3）：累积直刷文本经 store.appendText 一次提交 →
  // dirty 清除 → 恢复常规路径。R3-A 语义自动生效：appendText 内部的
  // 追加点锚定/光标平移/流式合并记账（meta:'stream'）统一接管，
  // stop-flush（flushStreamTail）由宿主 streamEnd 收口为单 undo 步。
  const flushStreamInternal = useCallback(() => {
    const pending = pendingStreamRef.current;
    if (!pending) return;
    // 先清 dirty 再提交：appendText 触发的 React 重渲染发生在本次同步
    // 调用栈之外，届时 dirty 已清除 → LineItem 按最新 lineText 全新
    // 渲染（不再使用冻结快照），DOM 与 store 收敛一致。
    pendingStreamRef.current = '';
    dirtyRefs.current.clear();
    dirtyRowOutOfViewRef.current = false;
    useEditorStore.getState().appendText(pending);
  }, []);

  // 直刷行可见性判定（O(1)：HeightMap.indexAt 二分像素→行）：
  // 用于「滚动到尾部触达 dirty 行 → flush」与直刷会话起点初值。
  const isRowInVisibleViewport = useCallback((rowIdx: number): boolean => {
    const el = parentRef.current;
    const hm = heightMapRef.current;
    // 容器/行高模型未就绪时保守视为可见（不误触发触达 flush）
    if (!el || !hm) return true;
    const first = hm.indexAt(el.scrollTop, 0);
    const last = hm.indexAt(el.scrollTop + el.clientHeight, 0);
    if (first < 0 || last < 0) return true;
    return rowIdx >= first && rowIdx <= last;
  }, []);

  // 直刷通道（C3，宿主 streamAppend 优先路径）：chunk 落在「当前纯文本
  // 末行」（末行 DOM 已挂载、合并后仍是纯文本行、无换行、未超截断阈值）
  // 时命令式直写 DOM（textContent += chunk），store 延迟提交；否则先
  // flush 累积直刷文本（保证提交顺序），再走 store.appendText 常规路径
  // （含换行的 chunk 由 store 完成行边界切分）。
  const streamAppend = useCallback((chunk: string) => {
    if (!chunk) return;
    const s = useEditorStore.getState();
    const lastIdx = s.getLineCount() - 1;

    // DOM 视角末行 = store 末行 + 未提交直刷累积（直刷会话中 store 滞后）
    const domLast = lastIdx >= 0 ? (s.getLine(lastIdx) ?? '') + pendingStreamRef.current : '';
    const merged = domLast + chunk;

    // 末行 row 与纯文本 token span：直刷只写「渲染为单个 text token span」
    // 的行——空行/无 token 结构（<br/> 行块）直接 textContent 追加会落到
    // 行块之外形成独立视觉行，绝不允许（宁可少直刷不可误刷）。
    let tokenEl: HTMLElement | null = null;
    if (lastIdx >= 0) {
      const rowEl = rowRefs.current.get(lastIdx);
      tokenEl = rowEl && rowEl.isConnected
        ? rowEl.querySelector<HTMLElement>('[data-token-start]')
        : null;
    }

    const canDirect =
      lastIdx >= 0 &&
      !chunk.includes('\n') &&
      merged.length <= DIRECT_STREAM_MAX_LINE_CHARS &&
      isPlainTextLine(merged) &&
      // 「LineNode 仅 text token」的块级保证：围栏内/缩进代码/数学块/
      // HTML 块内的"看似纯文本"行不算纯文本行（CodeState 权威判定）
      getLineState(s, lastIdx) === 'none' &&
      tokenEl !== null;

    if (canDirect) {
      // 直写 DOM（命令式，绕过 React）：向纯文本 token span 追加；
      // 光标跟随节流（08 §1 招 1 风险修正）属 R5 宿主侧，本层不越权。
      tokenEl!.textContent = (tokenEl!.textContent ?? '') + chunk;
      pendingStreamRef.current += chunk;
      dirtyRefs.current.add(lastIdx);
      // 会话起点记录直刷行可见性：用户本就在尾部（可见）时，滚动事件
      // 不触发「触达 flush」；用户远离尾部（不可见）时，滚动回尾部
      // 即 flush（保证 DOM 直刷文本先行提交，测量/选区/复制语义正确）。
      dirtyRowOutOfViewRef.current = !isRowInVisibleViewport(lastIdx);
      return;
    }

    // 常规路径（含 \n / 合并后非纯文本 / 超长 / 行未挂载 / dirty 行卸载）：
    // 先 flush 累积（"若含 \n 先 flush"推广到一切回落情形——保证直刷文本
    // 永远先于后续内容提交，顺序不颠倒），再 appendText 交给 store。
    flushStreamInternal();
    useEditorStore.getState().appendText(chunk);
  }, [flushStreamInternal, isRowInVisibleViewport]);

  // 流式结束（宿主调用）：flush 直刷累积（appendText 一次提交），并
  // stop-flush 尾段——R3-A 将本次流式会话合并为单个 meta:'stream'
  // undo 步（09 归一表 §5「append 不进 undo 栈；流式结束后合并单步」）。
  const streamEnd = useCallback(() => {
    flushStreamInternal();
    const s = useEditorStore.getState();
    if (s.streamTail.length > 0 || s.streamOp) s.flushStreamTail();
  }, [flushStreamInternal]);

  // 命令式接口暴露（R5 宿主：engineRef.current.streamAppend / streamEnd）
  useImperativeHandle(
    ref,
    () => ({
      streamAppend,
      streamEnd,
      flushStream: flushStreamInternal,
    }),
    [streamAppend, streamEnd, flushStreamInternal]
  );

  // 用户操作监听（C3 flush 时机 2）：keydown/pointerdown/mousedown/
  // compositionstart 到达 → 直刷累积先 flush——08 §1 招 1「测量/选区/复制
  // 操作触达时先 flush」：保证用户编辑/选区/点击测量作用在 store 与 DOM
  // 一致的状态上。关键：capture 相位监听（先于容器内子组件冒泡处理，如
  // HiddenInput 的 keydown→insertText），否则用户击键会先落到滞后 store。
  // flushStreamInternal 空转无开销（无累积即返回），事件期间任意触发安全。
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const flush = () => flushStreamInternal();
    el.addEventListener('keydown', flush, true);
    el.addEventListener('compositionstart', flush, true);
    el.addEventListener('pointerdown', flush, true);
    el.addEventListener('mousedown', flush, true);
    return () => {
      el.removeEventListener('keydown', flush, true);
      el.removeEventListener('compositionstart', flush, true);
      el.removeEventListener('pointerdown', flush, true);
      el.removeEventListener('mousedown', flush, true);
    };
  }, [flushStreamInternal]);

  // 滚动监听（C3 flush 时机 4：滚动到尾部/离开窗口）：
  // - dirty 行离开虚拟窗口范围（超出 overscan，DOM 即将随窗口变化卸载）
  //   → 立即 flush，防直刷文本随 DOM 卸载丢失；
  // - dirty 行从视口外回到可见视口（用户滚动到尾部触达直刷行）→ flush，
  //   保证随后可见行的测量/交互基于已提交状态。
  const handleScrollFlush = useCallback(() => {
    if (dirtyRefs.current.size === 0) {
      dirtyRowOutOfViewRef.current = false;
      return;
    }
    const items = virtualizer.getVirtualItems();
    if (items.length === 0) return;
    const first = items[0].index;
    const last = items[items.length - 1].index;
    for (const idx of dirtyRefs.current) {
      if (idx < first || idx > last) {
        flushStreamInternal();
        return;
      }
    }
    const dirtyIdx = dirtyRefs.current.values().next().value as number;
    const nowVisible = isRowInVisibleViewport(dirtyIdx);
    if (nowVisible && dirtyRowOutOfViewRef.current) {
      flushStreamInternal();
      return;
    }
    dirtyRowOutOfViewRef.current = !nowVisible;
  }, [virtualizer, flushStreamInternal, isRowInVisibleViewport]);


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
    // C3 直刷安全网（dirty 协议兜底）：dirty 行 DOM 已断开（窗口/布局
    // 变化导致卸载，如 resize 触发的窗口重排、异常路径提前卸载）→ 立即
    // flush 提交累积文本，防直刷文本随 DOM 丢失（store 权威，随窗口重挂载
    // 即恢复完整内容）。
    if (dirtyRefs.current.size > 0) {
      let dirtyDisconnected = false;
      for (const idx of dirtyRefs.current) {
        const el = rowRefs.current.get(idx);
        if (!el || !el.isConnected) {
          dirtyDisconnected = true;
          break;
        }
      }
      if (dirtyDisconnected) flushStreamInternal();
    }
    // R3-B1：快照经 store.getState() 取一次，后续行/状态读取走访问器
    // （getLine / getLineState），不读物化视图；effect 由双段引用触发
    // 信号 + lineCount 驱动（见依赖数组——任何内容变更必换其一新引用）
    const s = useEditorStore.getState();
    hm.syncTo(s.getLineCount(), (i) => {
      const raw = s.getLine(i) ?? '';
      const st = getLineState(s, i);
      return oracle.predict(classifyLine(raw, st), raw, st);
    });
    for (const item of virtualizer.getVirtualItems()) {
      const el = rowRefs.current.get(item.index);
      // 已卸载行（DOM 已断开）直接从注册表剔除，防 stale 条目污染批量测量
      if (!el || !el.isConnected) {
        rowRefs.current.delete(item.index);
        continue;
      }
      const raw = s.getLine(item.index);
      if (raw === undefined) continue;
      const st = getLineState(s, item.index);
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
  }, [mainLines, streamTail, mainCodeState, streamTailCodeState, lineCount, windowKey, flushStreamInternal]);

  const handleContainerClick = (e: React.MouseEvent) => {
    // R3-B1：事件处理器统一取一次最新 store 快照，行内容/偏移经访问器
    // （getLine / getLineCount / lineOffsets）读取——同一快照下与物化
    // 视图语义完全一致，且不依赖闭包捕获的旧数组引用。
    const st = useEditorStore.getState();

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
    if (clickedLineIndex !== -1 && st.getLine(clickedLineIndex)?.trim().match(/^\|?[\s:-]*[-]+[\s:-]*\|/)) {
      if (clickedLineIndex > 0) {
        const prevLineStart = st.lineOffsets.getOffset(clickedLineIndex - 1);
        const prevLineLen = st.getLine(clickedLineIndex - 1).length;
        setCursorPos(prevLineStart + prevLineLen);
        return;
      }
    }

    if (clickedPadding && clickedLineIndex !== -1 && parentRef.current) {
       const lineStart = st.lineOffsets.getOffset(clickedLineIndex);
       const lineLen = st.getLine(clickedLineIndex).length;
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
      const lineStart = st.lineOffsets.getOffset(clickedLineIndex);
      const lineLen = st.getLine(clickedLineIndex).length;
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
          const lineStart = st.lineOffsets.getOffset(clickedLineIndex);
          const lineLen = st.getLine(clickedLineIndex).length;
          setCursorPos(Math.min(lineStart + lineLen, rawPos));
        } else {
          // Fallback to line start + offset
          const lineStart = st.lineOffsets.getOffset(clickedLineIndex);
          const lineLen = st.getLine(clickedLineIndex).length;
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
      if (st.getLine(clickedLineIndex)?.trim().match(/^\|?[\s:-]*[-]+[\s:-]*\|/)) {
        if (clickedLineIndex > 0) {
          const prevLineStart = st.lineOffsets.getOffset(clickedLineIndex - 1);
          const prevLineLen = st.getLine(clickedLineIndex - 1).length;
          setCursorPos(prevLineStart + prevLineLen);
          return;
        }
      }
      const lineStart = st.lineOffsets.getOffset(clickedLineIndex);
      const lineLen = st.getLine(clickedLineIndex).length;

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
      const lastLineIdx = st.getLineCount() - 1;
      if (lastLineIdx >= 0) {
        const lineStart = st.lineOffsets.getOffset(lastLineIdx);
        const lineLen = st.getLine(lastLineIdx).length;
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
        onScroll={handleScrollFlush}
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
          {(() => {
            // R3-B1：渲染取行经 store 访问器（方案 A：渲染时经
            // store.getState().getLine(i) 读最新）——双段惰性读取，
            // 尾段非空时零 concat 物化；重渲染触发由主组件订阅的
            // 双段引用信号 + lineCount 驱动（count 变化/行内容变化
            // 均换新引用），与物化视图语义一致。同一渲染帧内 store
            // 不会变更（React 同步渲染），快照取一次即可。
            const s = useEditorStore.getState();
            return virtualizer.getVirtualItems().map((virtualRow) => {
              const index = virtualRow.index;
              const lineText = s.getLine(index);
              const offset = s.lineOffsets.getOffset(index);
              const isCode = getLineState(s, index);
              return (
                <LineItem
                  key={index}
                  index={index}
                  lineText={lineText}
                  offset={offset}
                  isCode={isCode}
                  streamingDirty={dirtyRefs.current.has(index)}
                  rowRef={registerRowRef}
                />
              );
            });
          })()}
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
            return `${first}-${last}-${lineCount}-${totalH}`;
          })()}
        />
        <HiddenInput containerRef={parentRef} />
        <SelectionHighlight />
      </div>
    </div>
  );
});
