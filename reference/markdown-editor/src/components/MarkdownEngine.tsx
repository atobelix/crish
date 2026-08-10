import React, {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BlockRenderer } from './BlockRenderer';
import { HiddenInput } from './HiddenInput';
import { CursorLayer } from './CursorLayer';
import { SelectionHighlight } from './SelectionHighlight';
import { useEditorStore, type EditorState, type EditorStore } from '../core/EditorStore';
import { useTableStore } from '../core/TableStore';
import { MarkdownParser } from '../core/parser';
import { HeightMap, HeightOracle, classifyLine } from '../core/HeightMap';
// R5-D 装饰层统一（06 §2）：active/选区/搜索统一进 DecorationSet——
// 行级 query 派生 activeState，不再经 props 链逐层传裸选区数据
import { DecorationSet, applyCursorSelectionDecorations } from '../core/DecorationSet';

import { type CodeState } from '../core/parser';
// P3 B1 scroll factor：逻辑↔物理滚动高度分段映射（超长文档防浏览器高度触顶）
import { ScrollMap } from '../core/scrollMap';
// B4 N9：只读复制为 Markdown——DOM 选区 → 源码偏移映射 + getText 切片
import { selectionToMarkdown } from '../core/renderToHtml';
// B2 查找替换（05 高频项 N6）：查找替换面板（搜索/高亮/跳转/替换/
// 计数）挂载于引擎根容器内，快捷键 Ctrl+F/Ctrl+H 自监听
import { FindReplacePanel } from './FindReplacePanel';
// B3 大纲 + 折叠（N2/N3）：大纲面板 + 折叠占位行渲染
import { OutlinePanel } from './OutlinePanel';
import {
  HeadingIndex,
  type HeadingEntry,
  type HeadingExtractor,
  extractHeading,
} from '../core/headingIndex';
import {
  FoldState,
  FOLD_PLACEHOLDER_HEIGHT,
} from '../core/foldState';
// B3 双段行视图 diff（大纲索引/折叠平移的编辑定位）：共享原语
import { lineAt, lineCountOf } from '../core/EditorStore';

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

// ── R5-D 搜索高亮（05 高频项预留）：宿主搜索区间（全局字符偏移对）──
interface SearchRange {
  from: number;
  to: number;
}
// 无搜索区间共享引用（不可变约定：只在 set 时整体替换，绝不就地修改）
const EMPTY_SEARCH_RANGES: readonly SearchRange[] = [];

// B2 搜索命中行内联背景（index.css 为引擎样式域外，is-search-line
// class 已打（宿主可自定义），此处用主题色系内联兜底保证开箱可见；
// 与 --yellow-tint-2 同族淡黄，护眼对比度约束内）
const SEARCH_LINE_BG = 'hsl(45 100% 50% / 0.10)';

// B3 折叠占位行摘要截断长度（占位行文本仅作视觉提示，超长截断防撑行）
const FOLD_SUMMARY_MAX_CHARS = 48;

// B3 空标题共享引用（不可变约定：只在 set 时整体替换，绝不就地修改）
const EMPTY_HEADINGS: readonly HeadingEntry[] = [];

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
 * P3 B3 选区保护判定（plan-A3 方案 B 主——纯函数，O(1)）：
 * 引擎选区与流式末行相交、或光标位于末行行中 → 返回 false（直刷降级
 * 走常规 append 路径——直刷写 DOM 会与用户选区/光标错位，B6 M3 已实测
 * 证实：直刷写后相邻行用户选区被折叠）。无选区且光标在末行行首或之外
 * 时返回 true（直刷照常，零开销）。
 */
export function shouldDirectStream(
  selectionStart: number,
  selectionEnd: number,
  cursorPos: number,
  lastLineIdx: number,
  lineOffsets: { getOffset: (lineIndex: number) => number }
): boolean {
  if (lastLineIdx < 0) return true;
  const lineStart = lineOffsets.getOffset(lastLineIdx);
  const s = Math.min(selectionStart, selectionEnd);
  const e = Math.max(selectionStart, selectionEnd);
  // 有选区且终点 ≥ 末行起点（选区覆盖末行任意部分）→ 降级
  if (s !== e && e >= lineStart) return false;
  // 光标在末行行中（> 行首）——用户正在编辑末尾区域 → 降级
  if (cursorPos > lineStart) return false;
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
  /** 搜索高亮接入点（R5-D，05 高频项）：向统一装饰层添加一个搜索命中
   *  区间 [from, to)（全局字符偏移）——命中行打 is-search-line class，
   *  token 级高亮渲染属后续增强（宿主搜索接入本轮为 API + 行级标记）。 */
  addSearchRange: (from: number, to: number) => void;
  /** 清空全部搜索高亮（宿主搜索词清空/切换场景）。幂等。 */
  clearSearch: () => void;
  /** 批量设置搜索高亮（B2 查找替换）：一次性整体替换搜索区间集合——
   *  大批命中（十万级）场景避免逐条 addSearchRange 的 N 次 setState
   *  重建，单次提交驱动装饰层增量重建。R5-D 单条 API 保留兼容。 */
  setSearchRanges: (ranges: readonly { from: number; to: number }[]) => void;
  /** 跳转到命中（B2 查找替换）：滚动到 from 所在行（virtualizer.
   *  scrollToIndex 定位）并在编辑模式选中命中区间 [from, to)——
   *  替换的落点前提（选中即光标落点，applyChange 直接作用）。 */
  scrollToMatch: (from: number, to: number) => void;
  /** 折叠区间（B3 N3，方案 B：保留行 + 渲染跳过）：折叠 [startLine,
   *  endLine]（闭区间；至少两行；与既有折叠区间重叠拒绝）。折叠即批量
   *  行高更新（区间首行占位 1 行高、其余 0）+ virtualizer 缓存刷新；
   *  折叠行保留在 HeightMap/行号坐标系（展开无损恢复）。返回是否成功。 */
  foldRange: (startLine: number, endLine: number) => boolean;
  /** 展开包含 line 的折叠区间（line 可为区间内任意行，含隐藏行——宿主
   *  消息折叠场景点击占位行/隐藏行展开语义统一）。返回是否命中。 */
  unfold: (line: number) => boolean;
  /** 折叠查询：line 是否处于折叠状态（区间内任意行，含占位行） */
  isFolded: (line: number) => boolean;
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
  streamingDirty,
  store,
  // R5-D：共享装饰集 + 版本号——active/选区/搜索统一数据源（LineItem
  // 不再订阅 cursorPos/selection*，改经装饰集行级 query 派生；光标/
  // 选区/搜索变化 → 行版本递增 → 本行查询刷新；无变化帧（滚动/内容
  // 未变）props 全等 → memo 命中，零重渲染）。
  // R6-C 粒度修正：memo 依赖从「全局 decorationVersion」降为「本行
  // 行版本 rowDecorationVersion」（decorationVersion 每帧递增的回归
  // 根因：append 平移光标 → 全窗口 memo 失效 → 可见 math 块每帧重跑
  // KaTeX）。行版本只在「该行装饰内容变化」时递增（DecorationSet
  // add/remove 影响行 bump）——光标平移只 bump 光标行，其他行版本
  // 不变 → memo 命中。
  decorations,
  rowDecorationVersion,
}: {
  index: number;
  lineText: string;
  offset: number;
  isCode: CodeState;
  rowRef: (el: HTMLElement | null) => void;
  // R5：行渲染单元的 store 绑定（内容/activeState 经实例读取；多实例
  // 场景缺省传全局单例——LineItem 是模块级 memo 组件，store 引用稳定）。
  store: EditorStore;
  // R5-D：共享装饰集（由引擎维护并注入，见 MarkdownEngine 接线）；
  // R6-C：行级装饰版本（引擎渲染时读 decorations.getRowVersion(index)
  // 注入——本行装饰内容变化的单调版本，非全局版本）
  decorations: DecorationSet;
  rowDecorationVersion: number;
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

  // R5-D：行级装饰查询（行范围 = 本行字符区间 [offset, offset + 行长)；
  // 闭区间相交谓词在 DecorationSet.query 内实现——旧 selector 的
  // active/选区判定逐分支等价迁移，行为零变化）
  const lineDecorations = React.useMemo(
    () => decorations.query(offset, offset + lineText.length),
    // R6-C：依赖从全局 decorationVersion 降为本行行版本——本行装饰
    // 内容变化（行版本递增）时重查，其他行装饰变化不触发本行重查；
    // decorations 为可变结构，行内变更不可见，必须经行版本驱动重查
    // （与下方批量测量 effect 的语义依赖注释同款）
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [decorations, rowDecorationVersion, offset, lineText.length]);

  // R5-D：activeState 派生（props 结构兼容旧 selector 输出）：
  // - selection 装饰 → { cursor, selStart, selEnd }——cursor 取选区
  //   末端（占位：有选区分支的消费方 InlineRenderer / checkIsActive
  //   不读 cursor，与旧语义一致，值仅保持结构完整）；
  // - active 装饰（选区折叠的光标）→ { cursor }（selStart/selEnd 缺省）；
  // - 无装饰 → null（非活动行）。
  const activeState = React.useMemo(() => {
    const sel = lineDecorations.find((d) => d.kind === 'selection');
    if (sel) {
      return { cursor: sel.to, selStart: sel.from, selEnd: sel.to };
    }
    const active = lineDecorations.find((d) => d.kind === 'active');
    return active ? { cursor: active.from } : null;
  }, [lineDecorations]);

  // 搜索高亮（05 高频项预留）：命中 search 装饰的行打 is-search-line
  // class——宿主可经 CSS 定制行级标记；token 级高亮渲染属 R5-C 渲染域，
  // 本轮为「API + 简单高亮 class」接入点
  const hasSearchDecoration = lineDecorations.some((d) => d.kind === 'search');

  const tableId = store(state => {
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

  // B2 搜索行内联背景：仅命中行附加淡黄底色（useMemo 保持引用
  // 稳定——依赖只有行类型与搜索标记，变化时才换新对象，不影响
  // React.memo 命中）；class is-search-line 同时保留供宿主自定义
  const rowStyle = React.useMemo(
    () => ({
      position: 'absolute' as const,
      left: 0,
      width: '100%',
      minHeight: lineNode.type === 'table_separator' ? '0px' : '28px',
      ...(hasSearchDecoration ? { backgroundColor: SEARCH_LINE_BG } : null),
    }),
    [lineNode.type, hasSearchDecoration]
  );

  return (
    <div
      data-index={index}
      data-line-start={offset}
      data-line-length={lineText.length}
      data-streaming-dirty={streamingDirty ? 'true' : undefined}
      ref={rowRef}
      className={`virtual-row ${activeState ? 'is-active-line' : ''}${hasSearchDecoration ? ' is-search-line' : ''}`.trim()}
      style={rowStyle}
    >
      {rowContent}
    </div>
  );
});

/**
 * B3 折叠占位行（N3 折叠区间，方案 B：保留行 + 渲染跳过）：
 * 折叠区间首行渲染为本占位行（折叠条 + 展开按钮），区间内其余行跳过渲染。
 * - 行结构（data-index/ref/class virtual-row）与 LineItem 同构——虚拟滚动
 *   测量（registerRowRef）与点击定位（handleContainerClick 的 data-index
 *   解析）零改动复用；行高固定 1 行（28px，overflow hidden 防内容撑行），
 *   与折叠时 HeightMap 批量置高一致，测量回填稳定；
 * - 展开按钮点击 stopPropagation（不触发容器点击定位），折叠/展开经
 *   FoldState 批量行高更新 + virtualizer.resizeItem（引擎接线）；
 * - 样式全内联（主题变量联动），仅复用既有 virtual-row 类（css-contract
 *   豁免清单登记）；占位标记走 data-fold-placeholder 属性（禁新增 className）。
 */
const FoldPlaceholderRow = React.memo(({
  index,
  foldedCount,
  summary,
  rowRef,
  onUnfold,
}: {
  index: number;
  foldedCount: number;
  summary: string;
  rowRef: (el: HTMLElement | null) => void;
  onUnfold: (line: number) => void;
}) => {
  const rowStyle = React.useMemo(
    () => ({
      position: 'absolute' as const,
      left: 0,
      width: '100%',
      height: FOLD_PLACEHOLDER_HEIGHT,
      minHeight: FOLD_PLACEHOLDER_HEIGHT,
      overflow: 'hidden',
    }),
    []
  );
  return (
    <div
      data-index={index}
      data-fold-placeholder="true"
      ref={rowRef}
      className="virtual-row"
      style={rowStyle}
    >
      <button
        type="button"
        title="展开折叠区间"
        aria-label={`展开已折叠的 ${foldedCount} 行`}
        onClick={(e) => {
          // 展开按钮独立命中：阻断容器点击定位（编辑态光标不移动）
          e.stopPropagation();
          onUnfold(index);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          height: FOLD_PLACEHOLDER_HEIGHT,
          border: '1px dashed var(--border-medium)',
          borderRadius: 4,
          padding: '0 8px',
          background: 'var(--yellow-tint-2)',
          color: 'var(--text-primary)',
          fontSize: 12,
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
          textAlign: 'left',
        }}
      >
        <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}>
          ▸ 已折叠 {foldedCount} 行
        </span>
        {summary && (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {summary}
          </span>
        )}
      </button>
    </div>
  );
});

/**
 * B3 双段行视图 diff：定位编辑区间（大纲索引增量 / 折叠平移的前置）。
 * 经共享原语 lineAt/lineCountOf 以逻辑行语义比对前后两帧「主数组 + 尾段」，
 * 输出与 updateLinesIncremental 同构的 (startLineIdx, deleteCount, newLines)。
 * 实现：前缀扫描找第一个不同行、后缀扫描找最后一个不同行，中间段即编辑
 * 区间（插入/删除/替换/追加/截断统一表达）。行内容比较为字符串 === 引用
 * 比较（未变更行共享字符串对象，O(1) 指针比较），每帧成本 O(编辑位置)。
 * 返回 null 仅表示「无前一帧」（首挂载，调用方走全量重建）。
 */
function computeEditSpan(
  prevMain: readonly string[],
  prevTail: readonly string[],
  nextMain: readonly string[],
  nextTail: readonly string[],
  prevCount: number,
  nextCount: number
): { startLineIdx: number; deleteCount: number; newLines: string[] } | null {
  if (prevCount === 0) return null;
  const minLen = Math.min(prevCount, nextCount);
  // 前缀扫描：第一个不同行
  let i = 0;
  while (
    i < minLen &&
    lineAt(prevMain, prevTail, i) === lineAt(nextMain, nextTail, i)
  ) {
    i++;
  }
  // 后缀扫描：最后一个不同行（从两端倒数）
  let s = 0;
  while (
    s < prevCount - i &&
    s < nextCount - i &&
    lineAt(prevMain, prevTail, prevCount - 1 - s) ===
      lineAt(nextMain, nextTail, nextCount - 1 - s)
  ) {
    s++;
  }
  const startLineIdx = i;
  const deleteCount = prevCount - i - s;
  const newSpan = nextCount - i - s;
  const newLines: string[] = [];
  for (let k = 0; k < newSpan; k++) {
    newLines.push(lineAt(nextMain, nextTail, i + k));
  }
  return { startLineIdx, deleteCount, newLines };
}

/**
 * MarkdownEngine props（R5 实例工厂 + readOnly 只读模式，06 §8 宿主集成接口）：
 * - store：显式编辑器 store 实例（createEditorStore() 工厂产出），缺省 =
 *   全局默认单例 useEditorStore（向后兼容，App.tsx 等既有消费方零改动）；
 * - readOnly：只读渲染模式（05 §2.2 消息历史渲染器定位）——隐藏输入层
 *   （HiddenInput/CursorLayer/SelectionHighlight）、点击不移动光标、输入
 *   捕获（键盘/拖选/粘贴）零生效；滚动/虚拟化/行高模型/token 映射全保留；
 *   原生 DOM 选区可用（选择复制走浏览器默认通道）；流式追加仍可用——
 *   streamAppend/appendText 经 store 驱动，readOnly 渲染 + 流式增量更新兼容。
 */
export interface MarkdownEngineProps {
  store?: EditorStore;
  readOnly?: boolean;
  /** 查找替换面板（B2）：缺省 true——引擎自带交互组件；宿主可
   *  显式关闭（只读消息历史场景由宿主自备搜索 UI）。 */
  findReplace?: boolean;
  /** 大纲面板（B3 N2）：缺省 true——引擎自带交互组件（嵌套大纲 +
   *  点击跳转 + 当前章节高亮）；宿主可显式关闭（自备导航 UI）。 */
  outline?: boolean;
}

export const MarkdownEngine = React.forwardRef<MarkdownEngineHandle, MarkdownEngineProps>(
  function MarkdownEngine({ store, readOnly, findReplace = true, outline = true }, ref) {
  const parentRef = useRef<HTMLDivElement>(null);
  // R5 实例绑定：所有订阅/命令式读取统一经 engineStore（缺省回退全局
  // 单例）；zustand 的 useStore 在 store 引用变化时自动切换订阅。
  const engineStore = store ?? useEditorStore;
  // —— R3-B1 访问器切换：触发信号订阅（不订阅物化视图 state.lines /
  // state.codeBlockState——尾段非空时物化会执行 O(全文) concat 过渡成本，
  // 渲染热路径已完全移除该依赖）——
  // 双段存储引用（main* + streamTail*）：任何内容变更（编辑/append/undo/
  // flush 等）都至少换其一新引用，作为主组件重渲染的触发信号；
  // 行内容/行状态在渲染时经 store.getState().getLine(i)/getLineState 惰性读取。
  const mainLines = engineStore(state => state.mainLines);
  const streamTail = engineStore(state => state.streamTail);
  const mainCodeState = engineStore(state => state.mainCodeState);
  const streamTailCodeState = engineStore(state => state.streamTailCodeState);
  // 行数信号：count 变化触发重渲染是必要行为（virtualizer count 同步）；
  // 选择器每次 set 都执行（O(1)，纯 length 读取），返回值按值比较。
  const lineCount = engineStore(state => state.getLineCount());
  const setCursorPos = engineStore(state => state.setCursorPos);

  // ── R5-D 装饰层统一（06 §2）：active/选区/搜索统一进 DecorationSet ──
  // 共享装饰集实例：行边界经权威 LineOffsetTree 解析（store 实例切换时
  // 随 useMemo 重建——多实例场景装饰与内容同实例隔离）。装饰集为可变
  // 结构，本组件是唯一维护方（下述派生 effect），LineItem/SelectionHighlight
  // 只经 query/getKind 消费。
  const decorations = React.useMemo(
    () =>
      new DecorationSet({
        findLineIndex: (pos) => engineStore.getState().lineOffsets.findLineIndex(pos),
      }),
    [engineStore]
  );
  // 全局版本号：光标/选区/搜索维护后递增（R6-C 语义保留）——两个作用：
  // 1) 装饰集是可变结构，apply 发生在 commit 后（useLayoutEffect），
  //    本版本 state 变化驱动「apply 后的第二轮渲染」，使 LineItem 按
  //    最新行版本重查（光标行 class 跟随光标）；
  // 2) SelectionHighlight 以 props 消费，驱动选区矩形重测。
  // LineItem 的 memo 粒度已降为行级（rowDecorationVersion，见渲染
  // 处注入）——全局版本递增只触发主组件重渲染 + 各行浅比较，不再
  // 全窗口失效（R6-C 回归修复）。
  const [decorationVersion, setDecorationVersion] = React.useState(0);
  // 宿主搜索区间（addSearchRange 接入）：与光标/选区同一维护链路
  // （B2：批量版 setSearchRanges 整体替换——大批命中一次提交）
  const [searchRanges, setSearchRangesState] = React.useState<
    readonly SearchRange[]
  >(EMPTY_SEARCH_RANGES);
  // 光标/选区订阅：触发信号（LineItem 不再各自订阅——消费方改经
  // decorationVersion 驱动，派生收敛到本组件单一维护点）
  const cursorPos = engineStore(state => state.cursorPos);
  const selectionStart = engineStore(state => state.selectionStart);
  const selectionEnd = engineStore(state => state.selectionEnd);

  useLayoutEffect(() => {
    // 增量维护：remove 只清受影响行 bucket、add 只写新区间跨行 bucket
    // ——光标/选区/搜索变化 O(受影响行)，不触碰全文（06 §2）。
    // 行级版本同步：apply 内部对受影响行 bump（DecorationSet.add/
    // remove）——append 平移光标只 bump 光标行，其他行版本不变，
    // LineItem memo 命中（R6-C 回归修复的核心）。
    // 行结构变化不直接触发本 effect：store 全编辑路径必伴随光标/选区
    // 落点变化；append 例外（只追加文末，既有装饰字符区间保持有效）。
    applyCursorSelectionDecorations(decorations, cursorPos, selectionStart, selectionEnd);
    decorations.remove('search');
    for (const r of searchRanges) decorations.add(r.from, r.to, 'search');
    setDecorationVersion(v => v + 1);
  }, [decorations, cursorPos, selectionStart, selectionEnd, searchRanges]);

  // ── 行高模型（R2-B 定位层）：HeightOracle 预测 + HeightMap 回填（01 问题 1/8，09 §4 C2）──
  const rowRefs = useRef(new Map<number, HTMLElement>());
  const heightMapRef = useRef<HeightMap | null>(null);
  // P3 B1 scroll factor：分段映射实例（恒等短路——总高 ≤ 30M px 时零开销直通）
  const scrollMapRef = useRef<ScrollMap | null>(null);
  // 内容容器 div（tanstack containerRef 是回调——物理总高覆盖经此）
  const contentDivRef = useRef<HTMLDivElement | null>(null);
  const oracleRef = useRef<HeightOracle | null>(null);
  if (heightMapRef.current === null) heightMapRef.current = new HeightMap();
  if (oracleRef.current === null) oracleRef.current = new HeightOracle();
  // P3 B1：ScrollMap 实例（逻辑总高 + 视口高——恒等短路自动处理低文档）
  if (scrollMapRef.current === null) {
    scrollMapRef.current = new ScrollMap(
      () => heightMapRef.current?.totalHeight ?? 0,
      () => parentRef.current?.clientHeight ?? 0
    );
  }

  // ── B3 大纲索引（N2）：HeadingIndex 增量维护 ──
  // 前一帧双段行视图引用（不拷贝——store 数组只整体替换，引用持有即快照）；
  // 编辑区间经 computeEditSpan diff 定位（前缀/后缀内容比对，fenceLines
  // 同款「平移 + 局部重建」范式），增量路径零拷贝快速路径复用旧数组引用。
  const headingIndexRef = useRef<HeadingIndex | null>(null);
  const prevDualRef = useRef<{
    main: readonly string[];
    tail: readonly string[];
    count: number;
  } | null>(null);
  if (headingIndexRef.current === null) headingIndexRef.current = new HeadingIndex();
  // 条目数组 state（增量维护后整体替换引用；快速路径同引用 → setState 跳过渲染）
  const [headings, setHeadings] = useState<readonly HeadingEntry[]>(EMPTY_HEADINGS);

  // ── B3 折叠状态（N3）：FoldState（区间 + 行高备份 + HeightMap 批量联动）──
  // 实例切换（宿主换 store）：随 decorations 同款重建（foldStoreRef 记录
  // 绑定实例，引用变化即视为切换——与下方 reconciliation effect 联动复位）
  const foldStateRef = useRef<FoldState | null>(null);
  const foldStoreRef = useRef<EditorStore | null>(null);
  // 折叠/展开动作触发重渲染的信号（内容变更走既有订阅信号，不重复 bump；
  // 值本身无消费方——状态只需「变化即重渲染」，故省略解构）
  const [, setFoldVersion] = useState(0);
  if (foldStateRef.current === null) {
    foldStateRef.current = new FoldState({
      predictHeight: (line) => {
        // 行高重预测（折叠行展开/泄漏恢复的备份缺失回退）：
        // 经访问器读当前行内容 + oracle 预测（与批量测量同源口径）
        const s = engineStore.getState();
        const raw = s.getLine(line) ?? '';
        const st = getLineState(s, line);
        return (
          oracleRef.current?.predict(classifyLine(raw, st), raw, st) ??
          FOLD_PLACEHOLDER_HEIGHT
        );
      },
    });
  }

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
      const s = engineStore.getState();
      const raw = s.getLine(i) ?? '';
      const st = getLineState(s, i);
      const oracle = oracleRef.current;
      if (oracle) return oracle.predict(classifyLine(raw, st), raw, st);
      return 28;
    },
    overscan: 40, // Buffer for smooth scrolling
    // P3 B1 scroll factor 接线（review-P3 高危修订已内化）：
    // - observeElementOffset 自定义：scroll 事件 rAF 合并后喂「逻辑值」
    //   （物理 el.scrollTop → ScrollMap.inverse）——tanstack 内部 offset
    //   全程逻辑坐标，窗口计算/行 top（directDomUpdates 写 el.style.top）
    //   与 HeightMap 逻辑坐标系一致，零改动；
    // - scrollToFn 自定义：逻辑目标 → ScrollMap.apply → 写物理 scrollTop
    //   （scrollToIndex/大纲跳转/查找跳转全部经此）；
    // - 内容容器高度（applyContainerSize 写逻辑总高）由批量测量 effect
    //   同帧覆盖为物理总高 ScrollMap.physicalTotalHeight（评审修订：
    //   保留 containerRef——tanstack applyDirectStyles 在 container null
    //   时 return 会禁用行定位）。
    observeElementOffset: (instance, cb) => {
      const el = instance.scrollElement;
      if (!el) return;
      let rafId = 0;
      let latest = 0;
      let isUpdating = false;
      const onScroll = () => {
        latest = el.scrollTop;
        if (!isUpdating) {
          isUpdating = true;
          rafId = requestAnimationFrame(() => {
            cb(scrollMapRef.current ? scrollMapRef.current.inverse(latest) : latest, false);
            isUpdating = false;
          });
        }
      };
      cb(scrollMapRef.current ? scrollMapRef.current.inverse(el.scrollTop) : el.scrollTop, false);
      el.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        el.removeEventListener('scroll', onScroll);
        if (rafId) cancelAnimationFrame(rafId);
      };
    },
    scrollToFn: (offset, opts, instance) => {
      const el = instance.scrollElement;
      if (!el) return;
      const physical = scrollMapRef.current ? scrollMapRef.current.apply(offset) : offset;
      if (opts.behavior === 'smooth') {
        el.scrollTo({ top: physical, behavior: 'smooth' });
      } else {
        el.scrollTop = physical;
      }
    },
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
    engineStore.getState().appendText(pending);
  }, []);

  // 直刷行可见性判定（O(1)：HeightMap.indexAt 二分像素→行）：
  // 用于「滚动到尾部触达 dirty 行 → flush」与直刷会话起点初值。
  const isRowInVisibleViewport = useCallback((rowIdx: number): boolean => {
    const el = parentRef.current;
    const hm = heightMapRef.current;
    // 容器/行高模型未就绪时保守视为可见（不误触发触达 flush）
    if (!el || !hm) return true;
    // P3 B1：物理 scrollTop → 逻辑（超长文档压缩区换算；恒等短路零开销）
    const physTop = el.scrollTop;
    const logicTop = scrollMapRef.current ? scrollMapRef.current.inverse(physTop) : physTop;
    const first = hm.indexAt(logicTop, 0);
    const last = hm.indexAt(logicTop + el.clientHeight, 0);
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
    const s = engineStore.getState();
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
      // 「LineNode �?text token」的块级保证：围栏内/缩进代码/数学�?
      // HTML 块内�?看似纯文�?行不算纯文本行（CodeState 权威判定�?
      getLineState(s, lastIdx) === 'none' &&
      tokenEl !== null &&
      // P3 B3 选区保护（plan-A3 方案 B 主）：引擎选区与末行相交、或
      // 光标位于末行行中（用户正在编辑/选中末尾区域）→ 降级走常规
      // append 路径——直刷写 DOM 会与用户选区/光标错位（B6 M3 已实测
      // 证实真实缺陷：直刷写后相邻行用户选区被折叠）。无选区/光标在
      // 行尾时判定 O(1) 数字比较，零开销。
      shouldDirectStream(s.selectionStart, s.selectionEnd, s.cursorPos, lastIdx, s.lineOffsets);

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
    engineStore.getState().appendText(chunk);
  }, [flushStreamInternal, isRowInVisibleViewport]);

  // 流式结束（宿主调用）：flush 直刷累积（appendText 一次提交），并
  // stop-flush 尾段——R3-A 将本次流式会话合并为单个 meta:'stream'
  // undo 步（09 归一表 §5「append 不进 undo 栈；流式结束后合并单步」）。
  const streamEnd = useCallback(() => {
    flushStreamInternal();
    const s = engineStore.getState();
    if (s.streamTail.length > 0 || s.streamOp) s.flushStreamTail();
  }, [flushStreamInternal]);

  // 搜索高亮接入（R5-D）：宿主经 handle.addSearchRange/clearSearch
  // 维护 searchRanges 状态 → 派生 effect 增量重建 search 装饰 → 版本
  // 递增驱动行级 is-search-line 刷新（见上方装饰维护 effect）。
  // B2 批量版 setSearchRanges：单次整体替换（大批命中场景的 N 次
  // setState → 1 次），保留单条 API 向后兼容。
  const addSearchRange = useCallback((from: number, to: number) => {
    setSearchRangesState((rs) => [...rs, { from, to }]);
  }, []);
  const clearSearch = useCallback(() => {
    setSearchRangesState(EMPTY_SEARCH_RANGES);
  }, []);
  const setSearchRanges = useCallback(
    (ranges: readonly SearchRange[]) => {
      setSearchRangesState(ranges.length ? [...ranges] : EMPTY_SEARCH_RANGES);
    },
    []
  );

  // 跳转到命中（B2）：滚动到 from 所在行 + 编辑模式选中命中区间。
  // 滚动走 virtualizer.scrollToIndex（既有定位设施，行高模型回填后
  // 精确对齐）；选中命中 = 替换的落点前提 + 当前命中的视觉呈现
  // （readOnly 下不动 store 选区——原生 DOM 选区不受干扰，只滚动）。
  const scrollToMatch = useCallback(
    (from: number, to: number) => {
      const s = engineStore.getState();
      const lineIdx = s.lineOffsets.findLineIndex(
        Math.max(0, Math.min(from, Math.max(0, s.textLength - 1)))
      );
      if (lineIdx >= 0) virtualizer.scrollToIndex(lineIdx, { align: 'center' });
      if (!readOnly) {
        engineStore.getState().setSelection(
          Math.min(from, to),
          Math.max(from, to)
        );
      }
    },
    [virtualizer, readOnly]
  );

  // ── B3 大纲跳转 + 视口行解析（OutlinePanel 接线）──

  // 大纲条目跳转：virtualizer.scrollToIndex 定位行（与 scrollToMatch
  // 同一设施；折叠区间内的标题落在占位行偏移，跳转即折叠条位置）
  const jumpToLine = useCallback(
    (line: number) => {
      virtualizer.scrollToIndex(line, { align: 'start' });
    },
    [virtualizer]
  );

  // 滚动位置 → 视口首行（OutlinePanel 当前章节高亮用）：
  // HeightMap.indexAt 二分（像素 → 行），topOffset 28 = 容器 padding-top
  // 14px + 内容 div margin-top 14px（09 §4 C1 换算口径）
  const resolveScrollLine = useCallback((scrollTop: number) => {
    const hm = heightMapRef.current;
    // P3 B1：OutlinePanel 传入的是物理 scrollTop——先逆映射为逻辑
    const logicTop = scrollMapRef.current ? scrollMapRef.current.inverse(scrollTop) : scrollTop;
    return hm ? hm.indexAt(logicTop, 28) : 0;
  }, []);

  // ── B3 大纲标题提取（HeadingIndex extract 回调注入）──
  // 块级代码状态过滤：围栏/缩进代码/数学块/HTML 块内形似标题的行不索引
  // （与 parser 的「fence 内行走代码解析路径」语义对齐——同一行文本在不
  // 同块级上下文下的标题身份不同，纯文本无法判定，必须经 CodeState）
  const headingExtract = useCallback<HeadingExtractor>(
    (line, raw) => {
      if (getLineState(engineStore.getState(), line) !== 'none') return null;
      const h = extractHeading(raw);
      return h ? { line, level: h.level, text: h.text } : null;
    },
    [engineStore]
  );

  // ── B3 折叠/展开动作（行高批量更新 + virtualizer 缓存同步）──
  // 批量路径：FoldState 内单次 setHeight 循环 + 单次 flush；此处逐行
  // resizeItem 同步 tanstack itemSizeCache（折叠行保留在 HeightMap 槽位，
  // 行号零漂移——resizeItem 是 0/占位高落库的最后一公里）
  const syncVirtualizerSizes = useCallback(
    (changed: readonly number[]) => {
      const hm = heightMapRef.current;
      if (!hm) return;
      for (const i of changed) {
        const h = hm.getHeight(i);
        if (h !== undefined) virtualizer.resizeItem(i, h);
      }
    },
    [virtualizer]
  );

  // 折叠（宿主 handle.foldRange）：越界钳制 + 至少两行 + 重叠拒绝在
  // FoldState 内完成；成功后批量行高更新 + 缓存同步 + 重渲染
  const foldRange = useCallback(
    (startLine: number, endLine: number) => {
      const s = engineStore.getState();
      const maxLine = s.getLineCount() - 1;
      const lo = Math.max(0, startLine);
      const hi = Math.min(maxLine, endLine);
      if (hi <= lo) return false;
      const fs = foldStateRef.current;
      const hm = heightMapRef.current;
      if (!fs || !hm) return false;
      const changed = fs.foldRange(hm, lo, hi);
      if (!changed) return false;
      syncVirtualizerSizes(changed);
      setFoldVersion((v) => v + 1);
      return true;
    },
    [syncVirtualizerSizes, engineStore]
  );

  // 展开（宿主 handle.unfold / 占位行按钮）：行高按备份原值批量恢复
  const unfold = useCallback(
    (line: number) => {
      const fs = foldStateRef.current;
      const hm = heightMapRef.current;
      if (!fs || !hm) return false;
      const changed = fs.unfold(hm, line);
      if (!changed) return false;
      syncVirtualizerSizes(changed);
      setFoldVersion((v) => v + 1);
      return true;
    },
    [syncVirtualizerSizes]
  );

  const isFolded = useCallback(
    (line: number) => foldStateRef.current?.isFolded(line) ?? false,
    []
  );

  // 命令式接口暴露（R5 宿主：engineRef.current.streamAppend / streamEnd）
  useImperativeHandle(
    ref,
    () => ({
      streamAppend,
      streamEnd,
      flushStream: flushStreamInternal,
      addSearchRange,
      clearSearch,
      setSearchRanges,
      scrollToMatch,
      foldRange,
      unfold,
      isFolded,
    }),
    [
      streamAppend,
      streamEnd,
      flushStreamInternal,
      addSearchRange,
      clearSearch,
      setSearchRanges,
      scrollToMatch,
      foldRange,
      unfold,
      isFolded,
    ]
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
    const s = engineStore.getState();
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
    // P3 B1（review-P3 修订）：内容容器高度同帧覆盖为物理总高——
    // tanstack applyContainerSize（directDomUpdates 内）写逻辑总高，
    // 本 effect 声明序在其后（渲染后），同帧覆盖 f(H)，避免浏览器
    // 滚动高度触顶；containerRef 保留（applyDirectStyles 依赖它）。
    const containerEl = contentDivRef.current;
    if (containerEl) {
      const phys = scrollMapRef.current?.physicalTotalHeight();
      if (typeof phys === 'number') {
        containerEl.style.height = `${phys}px`;
      }
    }
    // P3 B4 列宽定型（表格闭合后一次性，避免流式中跳动）：可见行中定位
    // 最后一个 table_separator → 表头行 + 连续 table_row 段 → 段后紧邻行
    // 非 table_row（表格已闭合）且该表未定型 → 测量 cell 内容宽
    // （scrollWidth 逐列 max）→ setTableWidths 一次（M6 计数随页面探针）。
    // 流式中（表格未闭合）不触发——无跳动。行类型经 parseLine（AST 缓存
    // 命中，O(可见) 可忽略）。核实修正（plan-A4）：parser 独立判定
    // table_row，表头高亮（isHeaderRow）流式中即时生效——无需候选态/回溯。
    try {
      const st = engineStore.getState();
      const items = virtualizer.getVirtualItems();
      let sepIdx = -1;
      for (const item of items) {
        const rawL = st.getLine(item.index);
        if (rawL === undefined) continue;
        const ln = MarkdownParser.parseLine(rawL, item.index, getLineState(st, item.index));
        if (ln.type === 'table_separator') sepIdx = item.index;
      }
      if (sepIdx !== -1) {
        let headerIdx = sepIdx - 1;
        while (headerIdx >= 0) {
          const rawH = st.getLine(headerIdx);
          if (rawH === undefined) break;
          const lnH = MarkdownParser.parseLine(rawH, headerIdx, getLineState(st, headerIdx));
          if (lnH.type !== 'table_row') break;
          headerIdx--;
        }
        headerIdx++;
        let segEnd = sepIdx + 1;
        while (segEnd < st.getLineCount()) {
          const rawE = st.getLine(segEnd);
          if (rawE === undefined) break;
          const lnE = MarkdownParser.parseLine(rawE, segEnd, getLineState(st, segEnd));
          if (lnE.type !== 'table_row') break;
          segEnd++;
        }
        const nextLn = segEnd < st.getLineCount() ? (() => {
          const rawN = st.getLine(segEnd);
          if (rawN === undefined) return null;
          return MarkdownParser.parseLine(rawN, segEnd, getLineState(st, segEnd));
        })() : null;
        const tableId = `table-${headerIdx}`;
        const tableStore = useTableStore.getState();
        if ((nextLn === null || nextLn.type !== 'table_row') && !tableStore.tableWidths[tableId]) {
          const colWidths: number[] = [];
          for (let r = headerIdx; r < segEnd; r++) {
            const rowEl = rowRefs.current.get(r);
            if (!rowEl || !rowEl.isConnected) continue;
            rowEl.querySelectorAll<HTMLElement>('.token-table-cell').forEach((cell, ci) => {
              const w = cell.scrollWidth;
              if (w > 0) colWidths[ci] = Math.max(colWidths[ci] ?? 0, w);
            });
          }
          if (colWidths.length > 0) {
            useTableStore.getState().setTableWidths(tableId, colWidths);
          }
        }
      }
    } catch {
      // 定型失败静默（渲染路径不因测量异常中断）
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainLines, streamTail, mainCodeState, streamTailCodeState, lineCount, windowKey, flushStreamInternal]);

  // ── B3 内容变更增量维护：大纲索引平移/重建 + 折叠区间平移/行高批量修正 ──
  // 声明序在批量测量 effect 之后（foldState 的行高修正依赖 syncTo 已把新增
  // 行预测高落库——隐藏行置 0 必须发生在预测落库之后）。
  // 编辑区间经 computeEditSpan diff 定位（双段行视图前后帧比对），大纲索引
  // 走 fenceLines 同款「平移 + 局部重建」（快速路径零拷贝复用旧引用 →
  // setHeadings 同引用跳过渲染）；折叠状态走 applyLineChange（区间平移 +
  // 备份平移 + 受影响行高批量修正，无折叠态时全部零开销）。
  useLayoutEffect(() => {
    const s = engineStore.getState();
    // 实例切换（宿主换 store）：双段基线/大纲索引/折叠状态全部随实例复位。
    // 注意：hi/fs 必须在复位之后取——此前实现先取后复位导致复位创建的新
    // 实例被弃用、后续增量全部落在空实例上（分块加载丢失首块标题的实测
    // bug）。foldStoreRef 记录绑定实例，与渲染体内的惰性初始化共用判定。
    if (foldStoreRef.current !== engineStore) {
      foldStoreRef.current = engineStore;
      prevDualRef.current = null;
      headingIndexRef.current = new HeadingIndex();
      foldStateRef.current = new FoldState({
        predictHeight: (line) => {
          const st = engineStore.getState();
          const raw = st.getLine(line) ?? '';
          const code = getLineState(st, line);
          return (
            oracleRef.current?.predict(classifyLine(raw, code), raw, code) ??
            FOLD_PLACEHOLDER_HEIGHT
          );
        },
      });
    }
    const hi = headingIndexRef.current;
    const fs = foldStateRef.current;
    const hm = heightMapRef.current;
    if (!hi || !fs || !hm) return;
    const nextMain = s.mainLines;
    const nextTail = s.streamTail;
    const nextCount = lineCountOf(nextMain.length, nextTail.length);
    const prev = prevDualRef.current;
    const span = prev
      ? computeEditSpan(
          prev.main,
          prev.tail,
          nextMain,
          nextTail,
          prev.count,
          nextCount
        )
      : null;
    if (span) {
      // 1) 大纲索引增量（fenceLines 同款：平移 + 局部重建）
      hi.applyLines(
        span.startLineIdx,
        span.deleteCount,
        span.newLines,
        headingExtract
      );
      // 2) 折叠区间平移 + 行高批量修正（批量路径：单次 setHeight 循环 +
      //    单次 flush；无折叠态零开销）
      const changed = fs.applyLineChange(
        hm,
        span.startLineIdx,
        span.deleteCount,
        span.newLines.length,
        nextCount
      );
      syncVirtualizerSizes(changed);
    } else {
      // 全量重建路径（首挂载 / setText 整文档替换 / 切换实例）：
      // 标题索引全量重扫；折叠区间越界裁剪 + 行高重应用
      hi.rebuild(nextCount, headingExtract, (i) => s.getLine(i));
      const changed = fs.clamp(hm, nextCount);
      syncVirtualizerSizes(changed);
    }
    prevDualRef.current = { main: nextMain, tail: nextTail, count: nextCount };
    setHeadings(hi.getEntries());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainLines, streamTail, engineStore]);

  // B4 N9：复制处理器统一入口（编辑态/只读态分支）。
  // - 编辑态：既有语义不变——store 选区 → getText 切片（源码复制）；
  // - readOnly：原生 DOM 选区复制的是渲染文本——拦截默认通道，经
  //   DOM 选区 → 源码偏移无损映射（data-token-start/data-sub-offset，
  //   与光标定位 handleContainerClick 同源）→ getText 切片，剪贴板
  //   写入 Markdown 源码；映射失败（null，如折叠选区/容器外选区）
  //   放行浏览器默认复制（渲染文本兜底）。
  const handleCopy = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      if (readOnly) {
        const md = selectionToMarkdown(
          selection,
          engineStore.getState().getText
        );
        if (md !== null) {
          e.clipboardData.setData('text/plain', md);
          e.preventDefault();
        }
        return;
      }
      const state = engineStore.getState();
      const start = Math.min(state.selectionStart, state.selectionEnd);
      const end = Math.max(state.selectionStart, state.selectionEnd);
      if (start !== end) {
        e.clipboardData.setData('text/plain', state.getText().substring(start, end));
        e.preventDefault();
      }
    },
    [readOnly, engineStore]
  );

  const handleContainerClick = (e: React.MouseEvent) => {    // R5 readOnly：只读模式点击不移动光标（光标定位链路整体短路）——
    // 原生 DOM 文本选区/选择复制不受影响（浏览器默认行为，不 preventDefault）。
    if (readOnly) return;
    // R3-B1：事件处理器统一取一次最新 store 快照，行内容/偏移经访问器
    // （getLine / getLineCount / lineOffsets）读取——同一快照下与物化
    // 视图语义完全一致，且不依赖闭包捕获的旧数组引用。
    const st = engineStore.getState();

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
      // P3 B1：物理 scrollTop → 逻辑（点击定位在逻辑坐标系——HeightMap 行 top）
      const physTop = parentRef.current.scrollTop;
      const logicTop = scrollMapRef.current ? scrollMapRef.current.inverse(physTop) : physTop;
      const contentY = e.clientY - containerRect.top + logicTop;

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
      {/* B3 大纲面板：挂载于根容器内、滚动容器外（不干扰虚拟滚动/行高
          测量/点击定位）；条目经 HeadingIndex 增量维护，跳转/章节高亮
          接 handle 链路。宿主可用 outline prop 显式关闭 */}
      {outline && (
        <OutlinePanel
          headings={headings}
          scrollRef={parentRef}
          resolveScrollLine={resolveScrollLine}
          onJump={jumpToLine}
        />
      )}
      {/* B2 查找替换面板：挂载于根容器内、滚动容器外（不干扰虚拟
          滚动/行高测量）；store 绑定本实例、跳转/高亮接 handle 链路。
          宿主可用 findReplace prop 显式关闭（只读消息历史场景） */}
      {findReplace && (
        <FindReplacePanel
          store={engineStore}
          onGoToMatch={scrollToMatch}
          onSetHighlights={setSearchRanges}
          readOnly={readOnly}
        />
      )}
      <div
        ref={parentRef}
        className="editor-container editor-scroll-container"
        onClick={handleContainerClick}
        onScroll={handleScrollFlush}
        onCopy={handleCopy}
        onCut={
          // R5 readOnly：只读模式无剪切（禁用删除语义）——不绑定处理器，
          // 交给浏览器默认（只读容器下用户无可编辑内容，无副作用）。
          readOnly
            ? undefined
            : (e) => {
                const selection = window.getSelection();
                if (!selection || selection.isCollapsed) return;

                const state = engineStore.getState();
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
              }
        }
        data-readonly={readOnly ? 'true' : undefined}
        style={{
          height: '100%',
          overflow: 'auto',
          padding: '14px 1rem',
          position: 'relative',
        }}
      >
        {/* C1 契约：内容容器主轴高度由 virtualizer.containerRef 命令式管理
            （applyContainerSize 写总高，免 React 提交），style 不写 height；
            marginTop 14px 为横向装饰属性，保留。P3 B1：contentDivRef 双挂
            （tanstack 回调 ref 无 .current——物理总高覆盖经本 ref） */}
        <div
          ref={(node) => {
            virtualizer.containerRef(node);
            contentDivRef.current = node;
          }}
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
            const s = engineStore.getState();
            return virtualizer.getVirtualItems().map((virtualRow) => {
              const index = virtualRow.index;
              // B3 折叠渲染接线（方案 B：保留行 + 渲染跳过）：折叠区间内
              // 行保留在 HeightMap 槽位（行号/令牌映射零漂移），隐藏行
              // 跳过渲染（0 高行不物化 DOM——展开时无结构变更、无损恢复）；
              // 区间首行渲染为折叠占位行（折叠条 + 展开按钮）。
              const activeFold = foldStateRef.current?.getRangeAt(index);
              if (activeFold) {
                if (index !== activeFold.startLine) return null;
                const raw = s.getLine(index) ?? '';
                const summary = raw.trim()
                  ? raw.trim().slice(0, FOLD_SUMMARY_MAX_CHARS)
                  : '';
                return (
                  <FoldPlaceholderRow
                    key={index}
                    index={index}
                    foldedCount={activeFold.endLine - index + 1}
                    summary={summary}
                    rowRef={registerRowRef}
                    onUnfold={unfold}
                  />
                );
              }
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
                  store={engineStore}
                  decorations={decorations}
                  // R6-C：行级装饰版本（非全局版本）——渲染时从装饰集
                  // 即时读取本行版本；append 平移光标只 bump 光标行，
                  // 其他行版本不变 → memo 命中（不重跑 BlockRenderer/
                  // InlineRenderer/KaTeX）
                  rowDecorationVersion={decorations.getRowVersion(index)}
                />
              );
            });
          })()}
        </div>


        {/* R5 readOnly：只读渲染模式不渲染输入层（光标/选区高亮/隐藏
            输入框）——原生 DOM 选区替代引擎自绘选区，点击/键盘/拖选/
            粘贴全部不生效；滚动/虚拟化/token 映射不受影响 */}
        {!readOnly && (
          <>
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
              store={engineStore}
            />
            <HiddenInput containerRef={parentRef} store={engineStore} />
            {/* R5-D：选区高亮消费统一装饰集（selection 装饰 + 版本号），
                不再直读 store 选区字段 */}
            <SelectionHighlight
              store={engineStore}
              decorations={decorations}
              decorationVersion={decorationVersion}
            />
          </>
        )}
      </div>
    </div>
  );
});
