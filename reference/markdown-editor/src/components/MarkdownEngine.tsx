import React, {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BlockRenderer } from './BlockRenderer';
import { HiddenInput, indexFromClientPoint } from './HiddenInput';
import { CursorLayer } from './CursorLayer';
import { SelectionHighlight } from './SelectionHighlight';
import {
  useEditorStore,
  type EditorState,
  type EditorStore,
} from '../core/EditorStore';
import { useTableStore } from '../core/TableStore';
import { MarkdownParser } from '../core/parser';
import { HeightMap, HeightOracle, classifyLine } from '../core/HeightMap';
// W1-1（D-4）：不可直刷 chunk 的 rAF 帧批缓冲（500 token/s → ≤60 提交/s）
import { StreamBuffer } from '../core/StreamBuffer';
// R5-D 装饰层统一（06 §2）：active/选区/搜索统一进 DecorationSet——
// 行级 query 派生 activeState，不再经 props 链逐层传裸选区数据
import {
  DecorationSet,
  applyCursorSelectionDecorations,
} from '../core/DecorationSet';

import { type CodeState } from '../core/parser';
// P3 B1 scroll factor：逻辑↔物理滚动高度分段映射（超长文档防浏览器高度触顶）
import { ScrollMap } from '../core/scrollMap';
// B4 N9：只读复制为 Markdown——DOM 选区 → 源码偏移映射 + getText 切片
// W3-1（D-8）：导出聚合（exportHtml）复用 renderToHtml 纯函数
import { renderToHtml, selectionToMarkdown } from '../core/renderToHtml';
// W3-4（S-EL-10）：流式专项指标接线（append 耗时/提交计数/直刷占比）
import { metrics } from '../core/metrics';
// W3-3（S-EL-11）：M6 表格列宽定型登记点（perf suite 表格流式场景读判）
import { recordTableWidthSettle } from '../core/tableSettle';
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
import { FoldState, FOLD_PLACEHOLDER_HEIGHT } from '../core/foldState';
// P3 B5（A5 渲染分层 L3 接缝）：Canvas 只读层预留——渲染模式判定
// （触发条件登记：readOnly && 行数阈值 && 注册表存在），本轮不实现
import { resolveRenderMode, type RenderMode } from '../core/rowSurface';
// B3 双段行视图 diff（大纲索引/折叠平移的编辑定位）：共享原语
import { lineAt, lineCountOf } from '../core/EditorStore';
// P3 B2（plan-A2 方案 B 样式预演）：流式末行未闭合行内标记检测纯函数
// （只读派生、数据层零篡改）+ 预演提示上下文（LineItem 注入、
// InlineRenderer 的 text token 消费——零新 DOM 节点）
import { decorateIncompleteInline } from '../core/decorateIncompleteInline';
import { InlinePreviewContext } from './InlineRenderer';

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
  return i < boundary
    ? s.mainCodeState[i]
    : s.streamTailCodeState[i - boundary];
}

// ── C3 流式直刷 DOM（08 方案优化补充 §1 招 1 限定版 / 09 方案修订终版 §4 C3）──
// 直刷仅限「纯文本末行」：行内无任何可构成 CommonMark 语法的字符，
// 渲染结果必然是单个 text token 的正文行。W2-2（02 分析 §1.2 P2 结构改法，
// S-T-2-02/S-T-2-05）把判定从「全字符黑名单」拆为三段——
// 1) 行首模式黑名单（LINE_START_SYNTAX_RE）：行首形态本身不含禁入字符，
//    但 parseLine 会把整行改形（有序/无序列表、分隔线、Setext 下划线候选），
//    直刷写字面文本将与 flush 后渲染形态分叉，必须拒绝；
// 2) 行中白名单扫描（DIRECT_STREAM_FORBIDDEN_CHARS）：仅禁真正会触发
//    行内解析的成对语法字符（`$ * _ ~ ` [ ] < > \ # & |`），数字/`.`/
//    `=`/`+`/`(`/`)`/`!`/`^`/`-`/`{`/`}` 等纯文本安全字符放开（逐字符
//    经 parseLine 语义验证，矩阵见 stream-direct-consistency.test.ts）；
// 3) 配对模式检查（SUP_PAIR_RE/MARK_PAIR_RE）：`^`/`=` 单字符本身安全
//    （`a^2`/`x=1` 不触发行内解析），但成对形态会触发 sup/mark 规则，
//    按 parseLine 实际语义拒绝；
// 4) 行尾硬换行后缀拒绝（HARD_BREAK_SUFFIX_RE）：行尾 2+ 空格/tab 在
//    parseLine 产出 hard_break token（S-EL-01 红线补洞）。
// `&` 必禁（W0-1 红线，禁止放开）：text token 的 content 会做 CommonMark
// 实体解码（parser.ts:3115-3119），含 `&amp;`/`&quot;`/`&nbsp;` 的行若直刷
// 会写入字面文本、flush 后跳变为解码值（直刷/解析分叉，S-EL-01 红线修复）。
const DIRECT_STREAM_FORBIDDEN_CHARS = new Set('*#`[$|>_~<\\]&');

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

// W1-2（D-3）滚动跟随边缘阈值（px）：scroll 事件判定「用户是否在尾部」——
// 距底部 ≤ FOLLOW_EDGE_PX 视为贴底（follow），超过即离开（paused）。
// 提交后评估复用同一阈值：视口距底部超过该值且为 follow 态 → 贴底跟随
// （新内容把尾部推出视口即滚回，增量 ≤ 阈值的小提交不滚，计数受控）。
const FOLLOW_EDGE_PX = 20;

// P3 B5（A5 渲染分层 L2 GPU 合成）：档位常量——GPU 层（方案 B+C+D）
// 的单点回退开关（A5 §5.3 整体回退：改动收敛于本常量 + directDomUpdatesMode
// 一行 + 行级两属性）。改此处为 false 即整档回退：virtualizer 回 position
// 定位模式（style.top 通道）、行级 contain: paint 与 dirty 行 will-change
// 独立层类全部移除，行为回到纯 DOM 定位基线。回退语义为「配置级（启动前
// 确定）」：运行中热切（prop 变化不 remount 行）时 tanstack lastPositions
// 弱表以行节点为键、同值跳过写入，行保留原定位属性（视觉同值一致），
// 详见 directDomUpdatesMode 处注释。宿主亦可一行传 useGpuLayer={false}
// 覆盖本常量（显式 prop 优先）。
const RENDER_LAYER_GPU_OPTS = {
  /** 是否启用 GPU 合成层（方案 B transform 绝对定位 + C 行级 contain:
   *  paint + D 直刷 dirty 行 will-change 独立合成层） */
  useGpuLayer: true,
} as const;

// B3 空标题共享引用（不可变约定：只在 set 时整体替换，绝不就地修改）
const EMPTY_HEADINGS: readonly HeadingEntry[] = [];

// W2-2 行首模式黑名单（02 分析 §1.2 P2 结构改法第 1 段）：行首形态不含
// 禁入字符但 parseLine 会改变整行形态（parser.ts:2185-2291 块级判定）：
// - `^\d+[.)](\s|$)`：有序列表（`^(\s*)(\d+\.)\s+`，parser.ts:2273）——
//   `1. 文本`/`123. 文本` 渲染为列表项（marker 前移、形态改形）；`(\s|$)`
//   覆盖流式边界 `1.`（chunk 尚未带空格时若直刷，下一 chunk 成列表形态
//   后 flush 即分叉）；`1)` 为 CommonMark 兼容的有序列表另式，一并拒绝；
// - `^[-+]\s`：无序列表（`^(\s*)([-*+])\s+`，parser.ts:2256）——`- 文本`/
//   `+ 文本` 渲染为 `•` 项目符号，直刷显示字面连字符（分叉）；
// - `^[-+]{3,}\s*$`：分隔线（`^(\s*[-*+_]){3,}\s*$`，parser.ts:2185）——
//   `---`/`+++` 渲染为 <hr/> 零文本（分叉）；
// - `^=+\s*$`：Setext 下划线候选（全量 parse 的 computeSetextContexts 把
//   上一段落升格为标题，parser.ts:1123）——直刷与文档终态分叉。
// 行首空白行已在下方拒绝（缩进代码块/列表缩进），故此处正则均以 `^` 锚定。
const LINE_START_SYNTAX_RE: ReadonlyArray<RegExp> = [
  /^\d+[.)](\s|$)/,
  /^[-+]\s/,
  /^[-+]{3,}\s*$/,
  /^=+\s*$/,
];

// W2-2 行中配对语法检查（第 3 段）：`^`/`=` 单字符本身是纯文本（`a^2`/
// `x=1` 经 parseLine 验证不触发行内解析），但成对形态会触发行内规则，
// 必须按 parseLine 实际语义拒绝：
// - sup 上标（parser.ts:2953 `^([^\s^]{1,500})^`）：`x^2^` 渲染为
//   <sup>2</sup>，content 不含定界符——直刷显示字面 `^2^`（分叉）；
//   上限 500 与解析规则一致（超长形态 parseLine 按文本渲染，放行安全）；
// - mark 高亮（parser.ts:2916 `==...==`）：`a==b==c`/`x == y == z` 渲染
//   为 mark token，直刷显示字面（分叉）。`==[\s\S]*?==` 覆盖「两处 `==`」
//   的配对形态；单处 `==`（`a==b`）parseLine 无闭合即按文本渲染，可直刷。
const SUP_PAIR_RE = /\^[^\s^]{1,500}\^/;
const MARK_PAIR_RE = /==[\s\S]*?==/;

// W2-2 行尾硬换行后缀（S-EL-01 红线补洞）：行尾 2+ 空格/tab 在 parseLine
// 产出 hard_break token（parser.ts:2605 `[ \t]{2,}$`），直刷写字面尾随
// 空白将与渲染分叉（行尾反斜杠同理，但 `\` 已在禁集内）。
const HARD_BREAK_SUFFIX_RE = /[ \t]{2,}$/;

/**
 * 纯文本行判定（C3 限定版 + W2-2 判定精细化：直刷前置条件之一）：
 * - 非空行（空行/纯空白行渲染为 <br/> 结构，无 text token 可直写）；
 * - 不以空白开头（≥4 空格缩进 = 缩进代码块，1-3 空格缩进也一并回避）；
 * - 行首不命中 LINE_START_SYNTAX_RE（列表/分隔线/Setext 候选——parseLine
 *   会改形的行首形态）；
 * - 全文不含 DIRECT_STREAM_FORBIDDEN_CHARS 中任一字符（行内成对语法：
 *   强调/链接/脚注/行内代码/转义/数学/表格/实体解码等）；
 * - 不含 sup/mark 配对形态（`^...^`/`==...==`）；
 * - 行尾无 2+ 空格/tab（hard_break 分叉）。
 * 判定对象是「末行 + 待追加 chunk」的合并结果（调用方负责拼接）——
 * 直刷过程中 DOM 文本逐 chunk 增长，只有合并后仍为纯文本行才直写。
 * 放开项（数字/`.`/`=`/`+`/`(`/`)`/`!`/`^`/`-`/`{`/`}`）逐一经 parseLine
 * 语义验证并以一致性矩阵锁死（stream-direct-consistency.test.ts，S-T-2-05）；
 * `&` 与全部「parseLine 会解码/改形/成 token」的字符保持禁入（S-EL-01）。
 */
// oxlint-disable-next-line react/only-export-components -- 任务规定导出纯函数供 R5/测试复用
export function isPlainTextLine(lineText: string): boolean {
  if (lineText.length === 0) return false;
  const first = lineText[0];
  if (first === ' ' || first === '\t') return false;
  for (let i = 0; i < LINE_START_SYNTAX_RE.length; i++) {
    if (LINE_START_SYNTAX_RE[i].test(lineText)) return false;
  }
  for (let i = 0; i < lineText.length; i++) {
    if (DIRECT_STREAM_FORBIDDEN_CHARS.has(lineText[i])) return false;
  }
  if (SUP_PAIR_RE.test(lineText)) return false;
  if (MARK_PAIR_RE.test(lineText)) return false;
  if (HARD_BREAK_SUFFIX_RE.test(lineText)) return false;
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
 * W3-1（S-EL-09）流式会话状态快照（getStreamState 返回值）：
 * - active：store.streamActive——「流式会话进行中」信号（W2-1 D-1 换源后
 *   的权威判定；直刷仅写 DOM 期间 store 滞后，active 仍为 false，宿主
 *   应结合 directPendingChars 判断「有未提交直刷内容」）；
 * - bufferedChars：帧聚合缓冲（StreamBuffer）内未提交字符数（W1-1：
 *   不可直刷 chunk 在 rAF 帧边界批量提交）；
 * - directPendingChars：已直写 DOM、尚未提交 store 的直刷累积字符数
 *   （pendingStreamRef 长度；flushStream/streamEnd/任何 flush 时机后归零）；
 * - followState：滚动跟随状态（W1-2 D-3 三态）——'follow' = 贴底自动
 *   跟随，'paused' = 用户上滚离开尾部（阅读态，不主动滚）。
 */
export interface StreamState {
  active: boolean;
  bufferedChars: number;
  directPendingChars: number;
  followState: 'follow' | 'paused';
}

/**
 * W3-1（S-EL-09）流式会话结束信号（onStreamEnd 回调入参）：
 * - flushed：会话文本已提交 store（恒 true——正常收口与 discard 都会
 *   flush 直刷累积与帧聚合缓冲后才宣告结束）；
 * - discarded：本次结束是否为「丢弃」（discardStream 触发为 true；
 *   streamEnd 正常收口为 false）。
 */
export interface StreamEndInfo {
  flushed: boolean;
  discarded: boolean;
}

/**
 * MarkdownEngine 命令式流式接口（R5 集成轮宿主接线）：
 * 宿主流式路径 = streamAppend(chunk)（直刷优先）→ streamEnd()（flush 收口）。
 * 直刷的 flush 提交走 store.appendText（R3-A stop-flush 语义自动生效：
 * 光标平移/流式合并 undo meta:'stream' 均由 store 统一处理）。
 * W3-1 扩展（S-EL-09）：状态查询 / 完成信号 / 中断丢弃 / 取文导出聚合。
 */
export interface MarkdownEngineHandle {
  /** 流式追加：纯文本末行且 chunk 无换行 → 命令式直写 DOM（store 延迟提交，
   *  同步零提交，W1-1 后直刷路径不变）；否则（含换行/末行非纯文本/超长/
   *  行未挂载）→ 先 flush 直刷累积，chunk 入 rAF 帧聚合缓冲（W1-1/D-4：
   *  每帧一次 appendText，500 token/s → ≤60 提交/s）。 */
  streamAppend: (chunk: string) => void;
  /** 流式结束：flush 直刷累积与帧聚合缓冲（直刷先、buffer 后，顺序不变量）
   *  并 stop-flush 尾段（合并为单个 meta:'stream' undo 步）。幂等。 */
  streamEnd: () => void;
  /** 主动 flush（宿主可提前提交直刷累积 + 帧聚合缓冲；无累积为空操作，
   *  幂等）。W1-1 语义扩展：帧聚合缓冲同步吐出，不等 rAF。 */
  flushStream: () => void;
  /** 流式会话状态查询（W3-1，S-EL-09）：active/bufferedChars/
   *  directPendingChars/followState 全量 O(1) 读引擎 ref 与 store——
   *  宿主「停止/继续」按钮、状态灯、指标面板的数据源。 */
  getStreamState: () => StreamState;
  /** 流式会话结束信号注册（W3-1，S-EL-09）：streamEnd() 正常收口 →
   *  { flushed: true, discarded: false }；discardStream() 丢弃 →
   *  { flushed: true, discarded: true }。仅在「会话真正结束」触发一次
   *  （streamEnd 幂等重复调用不重复触发；无会话的 streamEnd 不触发）。
   *  支持多次注册；返回解绑函数（幂等，可重复调用）。 */
  onStreamEnd: (cb: (info: StreamEndInfo) => void) => () => void;
  /** 中断并丢弃当前流式会话（W3-1，D-7，S-EL-06）：
   *  1) flush 直刷累积 + 帧聚合缓冲（顺序不变量 R-2：内容先提交再回滚）；
   *  2) 可编辑会话：stop-flush 收口（未 streamEnd 时生成 meta:'stream'
   *     op）后撤销该 op——单步精确回到流式前（undo 组语义覆盖流式期间
   *     的用户编辑；撤销产物留在 redo 栈，redo 可恢复被丢弃内容）；
   *  3) 只读快路径（W2-1：streamOp 恒 null 无记账）：截断到会话起点
   *     （appendText 首次调用前的 textLength 快照，引擎 ref 记录）——
   *     setText 整档重置，不污染 undo/redo/changeLog/lastUserEditTime
   *     （后续会话快路径门禁不被破坏）；
   *  4) 触发 onStreamEnd { flushed: true, discarded: true }（实际丢弃时）。
   *  幂等：无进行中会话时为空操作（不触发回调）。 */
  discardStream: () => void;
  /** 取当前文档全文（W3-1，D-8）：先 flush 直刷累积与帧聚合缓冲（直刷
   *  滞后语义透明化——未 flush 的 getText 不含直刷累积，聚合 API 必须
   *  先收敛），再读 store.getText()。任意时机可调（幂等，无累积空转）。 */
  getContent: () => string;
  /** 导出当前文档 HTML（W3-1，D-8）：先 flush（同 getContent 语义），
   *  再经 MarkdownParser.parse + renderToHtml 聚合（与既有 core 导出
   *  投影器同源，render-export.test.ts 锁定一致性）。完成态权威渲染
   *  （EL-08「发送到笔记」落点）；大文档渲染成本由宿主节流调用。 */
  exportHtml: () => string;
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
const LineItem = React.memo(
  ({
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
    useGpuLayer,
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
    // P3 B5（A5 渲染分层 L2）：GPU 合成开关——true 时行容器附加
    // virtual-row-gpu（contain: paint，方案 C）；dirty 行附加
    // virtual-row-gpu-dirty（will-change: transform 独立层，方案 D）。
    // 布尔 prop 引用稳定，不破坏 React.memo 命中。
    useGpuLayer?: boolean;
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
      [decorations, rowDecorationVersion, offset, lineText.length]
    );

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
    const hasSearchDecoration = lineDecorations.some(
      (d) => d.kind === 'search'
    );

    const tableId = store((state) => {
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

    // P3 B2 流式末行判定（plan-A2 §3 作用范围）：预演仅作用于「流式会话
    // 进行中的文档末行」——编辑态/非末行/代码行一律不预演。
    // - 末行判定 = streamingDirty（直刷协议扩展：直刷行并入，纯文本行
    //   无预演候选标记，decorateIncompleteInline 自然短路）∪ store.
    //   streamActive 为 true（流式会话进行中，stop-flush 前，W2-1 D-1 换源
    //   ——旧判定 streamOp !== null；只读快路径 streamOp 恒 null 但
    //   streamActive 照常置位，预演对只读流式会话同样生效）且本行为
    //   文档末行（append 逐 chunk 增长，末行即流式写入目标行）；
    // - 纯派生：只读行文本与行状态，不写 store、不产新 token——undo/
    //   编辑/序列化/光标测量（data-token 映射）零影响。
    // 流式会话进行中的末行订阅（无条件 hook——与 streamingDirty 的并集
    // 在订阅结果之上合并，不得短路 hook 调用：直刷期间 streamingDirty 为
    // true，若直接 `!!streamingDirty || store(...)` 会跳过订阅 → flush 后
    // hook 数变化 → React 报「rendered fewer hooks」）
    const streamTailFlag = store(
      (s) => s.streamActive === true && index === s.getLineCount() - 1
    );
    const isStreamingTail = !!streamingDirty || streamTailFlag;
    // 单趟 O(行长) 扫描（流式末行才执行；编辑态/代码行短路零开销）
    const previewDecoration = React.useMemo(
      () => decorateIncompleteInline(lineText, isStreamingTail, isCode),
      [lineText, isCode, isStreamingTail]
    );
    // 上下文值稳定化：非预演恒为 null（引用稳定——memo 命中不受影响）；
    // 预演期间逐 chunk 更新（预演段随流式文本增长）
    const previewContextValue =
      previewDecoration.hint !== undefined ? previewDecoration : null;

    const freshContent = (
      // P3 B2：预演提示经 React context 注入（Provider 不产生 DOM 节点，
      // 零 DOM 结构变化；BlockRenderer 各渲染器共享同一提示——text token
      // 命中预演段时追加 is-preview-* 类，闭合切换即同一节点的类微调）
      <InlinePreviewContext.Provider value={previewContextValue}>
        <BlockRenderer
          block={lineNode}
          index={index}
          lineOffset={offset}
          activeState={activeState}
          tableId={tableId}
        />
      </InlinePreviewContext.Provider>
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
        // P3 B5 GPU 类拼接：useGpuLayer=false 时退化为原 virtual-row 单类
        // （contain/will-change 全部移除，一行回退到纯 position 定位通道）
        className={`virtual-row${useGpuLayer ? ' virtual-row-gpu' : ''}${streamingDirty && useGpuLayer ? ' virtual-row-gpu-dirty' : ''}${activeState ? ' is-active-line' : ''}${hasSearchDecoration ? ' is-search-line' : ''}`.trim()}
        style={rowStyle}
      >
        {rowContent}
      </div>
    );
  }
);

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
const FoldPlaceholderRow = React.memo(
  ({
    index,
    foldedCount,
    summary,
    rowRef,
    onUnfold,
    // P3 B5：GPU 合成开关（与 LineItem 同款——占位行同为 transform 定位
    // 的行容器，contain: paint 隔离折叠条重绘不外溢）
    useGpuLayer,
  }: {
    index: number;
    foldedCount: number;
    summary: string;
    rowRef: (el: HTMLElement | null) => void;
    onUnfold: (line: number) => void;
    useGpuLayer?: boolean;
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
        className={`virtual-row${useGpuLayer ? ' virtual-row-gpu' : ''}`.trim()}
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
          <span
            style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}
          >
            ▸ 已折叠 {foldedCount} 行
          </span>
          {summary && (
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {summary}
            </span>
          )}
        </button>
      </div>
    );
  }
);

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
  /** GPU 合成优化开关（P3 B5 / A5 渲染分层 L2，组合 B+C+D）：
   *  - B：tanstack transform 绝对定位（directDomUpdatesMode 一行切换）；
   *  - C：行级 contain: paint（virtual-row-gpu 类，行重绘不外溢）；
   *  - D：直刷 dirty 行 will-change: transform 独立合成层（virtual-row-gpu-dirty）。
   *  缺省 true；宿主一行传 false 整体回退（配置级回退——启动前确定）。
   *  运行中热切（prop 变化不 remount 行）时：tanstack lastPositions 弱表
   *  以行节点为键、同值跳过写入，行保留原定位属性（视觉同值一致），
   *  详见 virtualizer 配置处注释——回退语义以「配置级」为准。 */
  useGpuLayer?: boolean;
  /** 渲染模式（P3 B5 / A5 渲染分层 L3 Canvas 接缝）：'dom' = 现 LineItem
   *  虚拟化行通道（缺省，行为零变化）；'canvas' = Canvas 只读层意图声明
   *  （预留——Canvas 未实现：无 'canvas' 注册、readOnly=false、行数不足
   *  阈值任一不满足即回落 'dom'，普适性由 DOM 回退兜底，A5 §3.1/§3.2）。
   *  触发条件登记 = readOnly && 行数 ≥ 5 万 && registerRowSurface('canvas')
   *  已注册；模式经 data-render-mode 属性暴露（测试可测落点）。 */
  renderMode?: RenderMode;
  /** 流式滚动跟随开关（W1-2 / S-EL-05）：缺省 true——流式会话中
   *  贴底自动跟随、用户上滚暂停、回底部恢复（D-3 三态）；宿主可显式
   *  关闭（自备跟随/无跟随场景）。仅作用于流式会话（store.streamActive
   *  为 true，W2-1 D-1 换源——旧判定 streamOp 非空），编辑路径滚动
   *  语义零影响。 */
  scrollFollow?: boolean;
}

export const MarkdownEngine = React.forwardRef<
  MarkdownEngineHandle,
  MarkdownEngineProps
>(function MarkdownEngine(
  {
    store,
    readOnly,
    findReplace = true,
    outline = true,
    renderMode: requestedRenderMode = 'dom',
    useGpuLayer = RENDER_LAYER_GPU_OPTS.useGpuLayer,
    scrollFollow = true,
  },
  ref
) {
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
  const mainLines = engineStore((state) => state.mainLines);
  const streamTail = engineStore((state) => state.streamTail);
  const mainCodeState = engineStore((state) => state.mainCodeState);
  const streamTailCodeState = engineStore((state) => state.streamTailCodeState);
  // 行数信号：count 变化触发重渲染是必要行为（virtualizer count 同步）；
  // 选择器每次 set 都执行（O(1)，纯 length 读取），返回值按值比较。
  const lineCount = engineStore((state) => state.getLineCount());
  const setCursorPos = engineStore((state) => state.setCursorPos);

  // ── R5-D 装饰层统一（06 §2）：active/选区/搜索统一进 DecorationSet ──
  // 共享装饰集实例：行边界经权威 LineOffsetTree 解析（store 实例切换时
  // 随 useMemo 重建——多实例场景装饰与内容同实例隔离）。装饰集为可变
  // 结构，本组件是唯一维护方（下述派生 effect），LineItem/SelectionHighlight
  // 只经 query/getKind 消费。
  const decorations = React.useMemo(
    () =>
      new DecorationSet({
        findLineIndex: (pos) =>
          engineStore.getState().lineOffsets.findLineIndex(pos),
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
  const [searchRanges, setSearchRangesState] =
    React.useState<readonly SearchRange[]>(EMPTY_SEARCH_RANGES);
  // 光标/选区订阅：触发信号（LineItem 不再各自订阅——消费方改经
  // decorationVersion 驱动，派生收敛到本组件单一维护点）
  const cursorPos = engineStore((state) => state.cursorPos);
  const selectionStart = engineStore((state) => state.selectionStart);
  const selectionEnd = engineStore((state) => state.selectionEnd);

  useLayoutEffect(() => {
    // 增量维护：remove 只清受影响行 bucket、add 只写新区间跨行 bucket
    // ——光标/选区/搜索变化 O(受影响行)，不触碰全文（06 §2）。
    // 行级版本同步：apply 内部对受影响行 bump（DecorationSet.add/
    // remove）——append 平移光标只 bump 光标行，其他行版本不变，
    // LineItem memo 命中（R6-C 回归修复的核心）。
    // 行结构变化不直接触发本 effect：store 全编辑路径必伴随光标/选区
    // 落点变化；append 例外（只追加文末，既有装饰字符区间保持有效）。
    applyCursorSelectionDecorations(
      decorations,
      cursorPos,
      selectionStart,
      selectionEnd
    );
    decorations.remove('search');
    for (const r of searchRanges) decorations.add(r.from, r.to, 'search');
    setDecorationVersion((v) => v + 1);
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
  if (headingIndexRef.current === null)
    headingIndexRef.current = new HeadingIndex();
  // 条目数组 state（增量维护后整体替换引用；快速路径同引用 → setState 跳过渲染）
  const [headings, setHeadings] =
    useState<readonly HeadingEntry[]>(EMPTY_HEADINGS);

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
    if (el && oracleRef.current)
      oracleRef.current.setContainerWidth(el.clientWidth - 40);
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
        // A5 防跳动清单①：位置值取整（transform 模式下小数像素会产生
        // 合成器取整抖动）——HeightMap 实测回填值为整数（offsetHeight
        // 恒整数），此处取整仅兜底预测落库路径的小数
        if (h !== undefined) return Math.round(h);
      }
      // R3-B1：行内容/状态经访问器惰性读取（estimateSize 可能在渲染期间
      // 被库调用，直接 getState() 读最新——同一同步 tick 内与订阅状态一致；
      // 不读物化 lines/codeBlockState 视图）
      const s = engineStore.getState();
      const raw = s.getLine(i) ?? '';
      const st = getLineState(s, i);
      const oracle = oracleRef.current;
      // A5 防跳动清单①（review-P3 §3.5 取整点钉死）：oracle 预测输出
      // Math.round——未回填的预测行（oracle 输出 rows × 28 × 倍率 ×
      // correction 可能非整数）经取整后写 transform，杜绝亚像素抖动
      if (oracle)
        return Math.round(oracle.predict(classifyLine(raw, st), raw, st));
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
            cb(
              scrollMapRef.current
                ? scrollMapRef.current.inverse(latest)
                : latest,
              false
            );
            isUpdating = false;
          });
        }
      };
      cb(
        scrollMapRef.current
          ? scrollMapRef.current.inverse(el.scrollTop)
          : el.scrollTop,
        false
      );
      el.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        el.removeEventListener('scroll', onScroll);
        if (rafId) cancelAnimationFrame(rafId);
      };
    },
    scrollToFn: (offset, opts, instance) => {
      const el = instance.scrollElement;
      if (!el) return;
      const physical = scrollMapRef.current
        ? scrollMapRef.current.apply(offset)
        : offset;
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
    // P3 B5（A5 渲染分层 L2 方案 B，GPU 层核心）：transform 绝对定位——
    // 已核对 tanstack 3.14.9 源码（react-virtual esm applyDirectStyles：
    // position 模式写 el.style.top，transform 模式写
    // el.style.transform = translate3d(0, ${item.start - scrollMargin}px, 0)，
    // 均为「绝对值」非增量 delta；本引擎未设 scrollMargin（缺省 0）→
    // transform 值与 position 模式的 top 同值，视觉逐像素等价）。
    // 双写缺陷排除（review-02 缺陷 B「React 写 top + 增量 translateY 叠加」）：
    // ① tanstack 写绝对值；② LineItem position-exclusive 契约（不读
    // virtualRow.start、不写主轴位置，见 LineItem 注释）——不存在任何
    // top/transform 双写叠加。收益：高度回填级联帧从「layout + 整视口
    // paint」降为「合成器位移」（style.top 是布局属性、transform 是合成
    // 属性，A5 §2.2 收益量化）。useGpuLayer=false 一行回退 position 模式。
    // 诚实边界（运行中热切）：tanstack lastPositions 弱表以行节点为键、
    // 同值跳过写入——运行中翻转 prop 时行保留原定位属性（视觉同值一致），
    // 回退语义以「配置级（启动前确定）」为准；如需运行中热切需行节点
    // 重新挂载（key 变化）触发全量重写，属宿主侧协议。
    directDomUpdatesMode: useGpuLayer ? 'transform' : 'position',
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

  // ── W3-1（S-EL-09）流式会话引擎侧追踪（ref 级，不触发渲染）──
  // streamSessionActiveRef：引擎侧「宿主已开启流式会话」标志——store 的
  // streamActive 在直刷路径下滞后（直刷仅写 DOM，appendText 到 flush 才
  // 置位），引擎以「streamAppend 首次调用」为会话起点探测（streamEnd /
  // discardStream 复位）。仅用于会话起点记录与 discard 截断，渲染零引用。
  // streamSessionStartLenRef：会话起点文本长度快照（= 会话首次 streamAppend
  // 时 store.textLength，此时 store 权威——直刷 pending 尚未产生）。只读
  // 快路径会话的 discardStream 截断目标（W2-1：streamOp 恒 null 无
  // meta:'stream' op 可撤销，只能按长度截断）。
  // streamEndCallbacksRef：onStreamEnd 注册的回调集合（多次注册，解绑 =
  // 从集合移除；回调只在会话真正结束时触发一次）。
  const streamSessionActiveRef = useRef(false);
  const streamSessionStartLenRef = useRef(-1);
  const streamEndCallbacksRef = useRef<Set<(info: StreamEndInfo) => void>>(
    new Set()
  );

  // ── W1-3（D-2）流式表格段追踪（ref 级，不触发渲染）──
  // 结构定型锁宽的增量状态：headerIdx = 表头行、lastRowIdx = 段内最后行
  // （含）、measuredThrough = 已测量行（含，初始为 headerIdx - 1）。
  // 仅流式会话（store.streamActive 为 true，W2-1 D-1 换源——旧判定
  // streamOp !== null）的表格定型分支使用；非流式零引用；
  // streamEnd 时重置（会话边界，防陈旧段跨会话污染）。
  const streamTableTrackRef = useRef<{
    headerIdx: number;
    lastRowIdx: number;
    measuredThrough: number;
  } | null>(null);

  // ── W1-2（D-3）滚动跟随三态（ref 级，不触发渲染）──
  // followStateRef：'follow' = 用户贴底/未滚动（新内容提交后主动贴底）；
  // 'paused' = 用户上滚离开尾部（不主动滚，阅读态）。判据 = scroll 事件
  // 监听（距底部 ≤ FOLLOW_EDGE_PX → follow；超过 → paused，handleScrollFlush
  // 内更新）+ 提交后评估（批量测量 effect 尾部，每帧至多一次，R-13 计数
  // 受控）。初始 'follow'：流式场景默认贴底（首次提交即评估是否需要贴底）。
  // followPendingRef：流式提交（flushStreamBuffer/streamEnd）后置位——
  // 渲染提交 + 行高回填完成后（批量测量 effect）统一评估，避免在 flush
  // 同步栈内以未回填行高计算定位。
  // scrollFollowRef：prop 的 ref 镜像（评估/事件处理闭包引用，避免依赖
  // 展开进 useCallback 依赖链）。
  const followStateRef = useRef<'follow' | 'paused'>('follow');
  const followPendingRef = useRef(false);
  const scrollFollowRef = useRef(scrollFollow);
  scrollFollowRef.current = scrollFollow;

  // P3 B3 选区保护（plan-A3 方案 A 兜底，O(1)）：直刷提交前的越界
  // 钳制——原生 DOM 选区轨（HiddenInput handleSelectionChange 无钳制
  // setState 写入，HiddenInput.tsx:878-882）在直刷期间可越过 store
  // 边界（DOM 长度 > store 长度，plan-A3 §1.2 问题 5：高亮消失的
  // 边界）。越界值语义 = 用户选中了直刷文本，flush 后文本已提交，
  // clamp 即正确的恢复目标。修复走既有原子链路：setSelection → 装饰
  // 维护 effect（applyCursorSelectionDecorations）与 SelectionHighlight
  // 同 commit 链单帧重测，无中间态、无闪烁。仅越界时 setState——正常
  // 路径三次数字比较，零分配零开销。
  const clampSelectionOOB = useCallback(() => {
    const s = engineStore.getState();
    if (
      s.selectionStart > s.textLength ||
      s.selectionEnd > s.textLength ||
      s.cursorPos > s.textLength
    ) {
      s.setSelection(s.selectionStart, s.selectionEnd);
    }
  }, []);

  // 直刷文本提交通道统一出口（flush + 降级路径共用）：appendText 前
  // 恒做一次越界钳制（见 clampSelectionOOB）。钳制放在提交前而非提交后：
  // appendText 内部的 shiftGE/computeAssocForLines 对越界值不平移、
  // 越界光标行号会直接崩溃（EditorStore.computeAssocForLines 不防御）；
  // 先收敛到 textLength 再平移——「提交前钳制 + shiftGE」与「shiftGE
  // + 提交后钳制」结果一致（plan-A3 §2.1），且原生轨越界值语义 = 用户
  // 选中了直刷文本，提交前收敛即正确的恢复目标。钳制幂等，未越界零
  // 副作用（正常路径三次数字比较，零分配零开销）。
  const appendTextWithClamp = useCallback(
    (text: string) => {
      clampSelectionOOB();
      // W3-4（S-EL-10）：append 耗时采样——flush 出口计时（本函数是
      // flushStreamInternal 与帧回调两条提交通道的公共出口，一次
      // performance.now 差值 O(1) 零侵入）。提交通道计数（append/
      // direct 分类）由各调用点登记（见 flushStreamInternal 与帧回调）。
      const t0 = performance.now();
      engineStore.getState().appendText(text);
      metrics.recordAppendTime(performance.now() - t0);
    },
    [clampSelectionOOB]
  );

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
    // P3 B3：提交通道统一走 appendTextWithClamp——flush 是原生轨越界
    // 选区的主要修复点（直刷期间用户选中了 DOM 上的直刷字符）。
    appendTextWithClamp(pending);
    // W3-4（S-EL-10）：直刷通道提交登记——每次「直刷累积经统一出口提交
    // store」计 1（直写点不单独计数，避免与出口重复计量：同一段直刷
    // 文本只算一次提交）。直刷占比 = directCommits / 总提交（metrics
    // 派生，S-T-3-04）。
    metrics.recordDirectCommit();
  }, [appendTextWithClamp]);

  // ── W1-1（D-4）帧聚合缓冲：不可直刷 chunk 的 rAF 批处理──
  // 跨 render 复用的 StreamBuffer 实例（useRef lazy init，组件生命周期
  // 内单实例）。帧回调闭包捕获 flushStreamInternal / appendTextWithClamp
  // ——两 useCallback 的依赖链均收敛于 clampSelectionOOB（空依赖），
  // 引用稳定，捕获即最新，无需 ref 中转。
  const streamBufferRef = useRef<StreamBuffer | null>(null);
  if (streamBufferRef.current === null) {
    const flushPendingFirst = flushStreamInternal;
    const appendWithClamp = appendTextWithClamp;
    streamBufferRef.current = new StreamBuffer((batch) => {
      // 帧回调（D-4 + R-2 顺序不变量）：flushStreamInternal 先行——
      // 防御性保证「直刷累积（先到达）→ buffer 内容（后到达）」的提交
      // 顺序；正常路径下 push 前已提交 P（见 streamAppend 降级分支），
      // 此处为空转（pending 空即 return，零开销）。
      flushPendingFirst();
      appendWithClamp(batch);
      // W3-4（S-EL-10）：常规（append）通道提交登记——帧聚合缓冲批量
      // 提交计 1（与 flushStreamInternal 的直刷通道登记同粒度：一次
      // store 提交 = 一次通道计数，直刷占比 = 直刷提交 / 总提交）。
      metrics.recordAppendCommit();
    });
  }

  // W1-1（D-4）统一 flush 出口（capture/滚动/streamEnd/卸载四类时机共用）：
  // 提交顺序恒为「直刷累积 P（先到达）→ buffer 累积 B（后到达）」——
  // 顺序不变量 R-2（store 文本顺序 = 到达顺序）。任一侧为空即空转，
  // 幂等，事件期间任意触发安全。
  const flushStreamBuffer = useCallback(() => {
    flushStreamInternal();
    streamBufferRef.current?.flush();
    // W1-2（D-3）：流式提交后置位跟随评估（批量测量 effect 尾部消费，
    // 每帧至多一次）。编辑路径的 capture flush 也会经过这里——评估侧
    // 以 streamActive 为门禁（W2-1 D-1 换源——旧判定 streamOp 非空），
    // 编辑提交（streamActive 为 false）零副作用。
    followPendingRef.current = true;
  }, [flushStreamInternal]);

  // 直刷行可见性判定（O(1)：HeightMap.indexAt 二分像素→行）：
  // 用于「滚动到尾部触达 dirty 行 → flush」与直刷会话起点初值。
  const isRowInVisibleViewport = useCallback((rowIdx: number): boolean => {
    const el = parentRef.current;
    const hm = heightMapRef.current;
    // 容器/行高模型未就绪时保守视为可见（不误触发触达 flush）
    if (!el || !hm) return true;
    // P3 B1：物理 scrollTop → 逻辑（超长文档压缩区换算；恒等短路零开销）
    const physTop = el.scrollTop;
    const logicTop = scrollMapRef.current
      ? scrollMapRef.current.inverse(physTop)
      : physTop;
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
  const streamAppend = useCallback(
    (chunk: string) => {
      if (!chunk) return;
      // W3-1（S-EL-09）：会话起点探测（引擎侧）——本 chunk 是会话首次
      // 调用时记录 store.textLength 快照（discardStream 只读截断目标；
      // 此刻 store 权威——直刷 pending 尚未产生）。streamActive 在直刷
      // 路径下滞后（flush 才置位）不可用作起点判定，以引擎自身标志界定
      // 会话边界（streamEnd / discardStream 复位，此后首次 streamAppend
      // 即新会话起点）。
      if (!streamSessionActiveRef.current) {
        streamSessionActiveRef.current = true;
        streamSessionStartLenRef.current = engineStore.getState().textLength;
      }
      const s = engineStore.getState();
      const lastIdx = s.getLineCount() - 1;

      // DOM 视角末行 = store 末行 + 未提交直刷累积（直刷会话中 store 滞后）
      const domLast =
        lastIdx >= 0
          ? (s.getLine(lastIdx) ?? '') + pendingStreamRef.current
          : '';
      const merged = domLast + chunk;

      // 末行 row 与纯文本 token span：直刷只写「渲染为单个 text token span」
      // 的行——空行/无 token 结构（<br/> 行块）直接 textContent 追加会落到
      // 行块之外形成独立视觉行，绝不允许（宁可少直刷不可误刷）。
      let tokenEl: HTMLElement | null = null;
      if (lastIdx >= 0) {
        const rowEl = rowRefs.current.get(lastIdx);
        tokenEl =
          rowEl && rowEl.isConnected
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
        shouldDirectStream(
          s.selectionStart,
          s.selectionEnd,
          s.cursorPos,
          lastIdx,
          s.lineOffsets
        );

      if (canDirect) {
        // W1-1（D-4 顺序不变量，交叉场景）：buffer 非空说明其内容早于
        // 本 chunk 到达（帧回调未到）——先 flushStreamBuffer()（直刷累积
        // P 先提交、buffer 累积 B 后提交）再直写本 chunk（成为新 P），
        // store 提交顺序 = 到达顺序（R-2）。buffer 空时直接直刷，
        // 同步零提交红利完全保留（无 flush 开销）。
        if (streamBufferRef.current!.pending > 0) flushStreamBuffer();
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
      // W1-1（D-4）帧聚合——先 flushStreamInternal 提交直刷累积（顺序不
      // 变量：直刷文本永远先于后续内容提交），chunk 入 StreamBuffer 等
      // rAF 帧边界一次性 appendText（500 token/s → ≤60 提交/s，S-EL-02）。
      // 帧回调 = flushStreamInternal + appendTextWithClamp（含 P3 B3 越界
      // 钳制，与直刷 flush 同通道）。
      flushStreamInternal();
      streamBufferRef.current!.push(chunk);
    },
    [
      flushStreamInternal,
      isRowInVisibleViewport,
      appendTextWithClamp,
      flushStreamBuffer,
    ]
  );

  // ── W3-1（S-EL-09）流式会话结束信号 ──
  // notifyStreamEnd 分发（streamEnd 与 discardStream 收口点调用）——
  // 宿主回调异常用 try/catch 隔离（监听器惯例：单个回调抛错不打断
  // 引擎收口与其余回调）。onStreamEnd 注册/解绑（多次注册分别触发，
  // 解绑函数幂等可重复调用）。
  const notifyStreamEnd = useCallback((info: StreamEndInfo) => {
    const cbs = streamEndCallbacksRef.current;
    if (cbs.size === 0) return;
    for (const cb of cbs) {
      try {
        cb(info);
      } catch {
        // 宿主回调异常不向上传播（引擎流式收口完整性优先）
      }
    }
  }, []);

  const onStreamEnd = useCallback((cb: (info: StreamEndInfo) => void) => {
    streamEndCallbacksRef.current.add(cb);
    return () => {
      streamEndCallbacksRef.current.delete(cb);
    };
  }, []);

  // 流式结束（宿主调用）：flush 直刷累积与帧聚合缓冲（直刷先、buffer
  // 后，顺序不变量 R-2），并 stop-flush 尾段——R3-A 将本次流式会话
  // 合并为单个 meta:'stream' undo 步（09 归一表 §5「append 不进 undo
  // 栈；流式结束后合并单步」）。W1-1：streamEnd 即显式 flush 时机——
  // buffer 内累积同步提交（尾段延迟 ≤1 帧，无残留）。
  const streamEnd = useCallback(() => {
    flushStreamBuffer();
    const s = engineStore.getState();
    // W3-1（S-EL-09）完成信号判定：「会话真正结束」= flush 直刷累积后
    // store 视角存在会话痕迹（streamActive 置位 / streamOp 记账 / 尾段
    // 非空——纯直刷会话在 flush 后才激活 store，必须在此后判定）。无
    // 会话的幂等 streamEnd 不触发回调；重复调用第二次无痕迹 → 不重复触发。
    const hadSession =
      s.streamActive || s.streamOp !== null || s.streamTail.length > 0;
    // W2-1（D-1）换源：会话进行中判定改经 streamActive（只读快路径
    // streamOp 恒 null 但仍需 stop-flush——flushStreamTail 负责合并尾段
    // 并熄灭 streamActive）；可编辑会话语义与旧 `|| s.streamOp` 完全一致
    if (s.streamTail.length > 0 || s.streamActive) s.flushStreamTail();
    // W1-3：会话结束重置流式表格段追踪（下次会话重新探测；文档可能已随
    // 编辑/新会话变化，陈旧段跨会话复用会锁错表头）
    streamTableTrackRef.current = null;
    // W3-1：引擎侧会话标志复位（下次 streamAppend 即新会话起点；
    // streamSessionStartLenRef 保留至下一会话覆盖——discardStream 在
    // 会话结束后仍可按原起点截断，即「后悔键」语义）
    streamSessionActiveRef.current = false;
    if (hadSession) notifyStreamEnd({ flushed: true, discarded: false });
  }, [flushStreamBuffer, notifyStreamEnd]);

  // ── W3-1（D-7）中断丢弃（S-EL-06）：flush → 回滚会话内容 → 清信号 ──
  // 幂等：无进行中会话/无可撤销内容时为空操作（不触发回调）。
  const discardStream = useCallback(() => {
    flushStreamBuffer();
    const st = engineStore.getState();
    // 分支一：只读快路径会话（W2-1：readOnly && 从未用户编辑 &&
    // streamOp 恒 null——与 appendText 的 fastPath 门禁同构）——无
    // meta:'stream' op 可撤销，截断到会话起点文本长度。setText 整档
    // 重置（≤1000 行同步一次提交；超大文档走分块加载，截断在 idle
    // 回调内收敛，DOM 一致性经 React 重渲染保证）：清 streamActive/
    // streamOp/undo/redo/changeLog/lastUserEditTime 全零污染——后续
    // 会话的只读快路径门禁（readOnly && lastUserEditTime === 0）不被
    // 破坏（S-EL-08；若走 applyChange 截断会写记账并置 lastUserEditTime，
    // 永久失去快路径，故不采用）。
    if (st.readOnly && st.lastUserEditTime === 0 && st.streamOp === null) {
      const startLen = streamSessionStartLenRef.current;
      if (startLen >= 0 && startLen < st.textLength) {
        st.setText(st.getText().substring(0, startLen));
        streamSessionStartLenRef.current = -1;
        streamSessionActiveRef.current = false;
        streamTableTrackRef.current = null;
        notifyStreamEnd({ flushed: true, discarded: true });
      }
      return;
    }
    // 分支二：可编辑会话（含只读但有编辑历史/记账的完整路径）——未
    // streamEnd 时先 stop-flush 收口（生成 meta:'stream' op），随后
    // 仅当 undo 栈顶为该 op（会话内容是「最新一步」）时撤销（undo 组
    // 语义覆盖流式期间重叠的用户编辑，一次精确回到流式前）。栈顶为
    // 普通用户编辑（streamEnd 后用户继续编辑）时不撤销——避免误伤
    // 用户工作；撤销产物留在 redo 栈（redo 可恢复被丢弃内容）。
    const s2 = engineStore.getState();
    if (s2.streamActive || s2.streamOp) s2.flushStreamTail();
    const stack = engineStore.getState().undoStack;
    const top = stack[stack.length - 1];
    let discarded = false;
    if (top && top.meta === 'stream') {
      engineStore.getState().undo();
      discarded = true;
    }
    streamSessionActiveRef.current = false;
    streamTableTrackRef.current = null;
    if (discarded) notifyStreamEnd({ flushed: true, discarded: true });
  }, [flushStreamBuffer, notifyStreamEnd]);

  // ── W3-1（S-EL-09）流式会话状态查询：全量 O(1) 读引擎 ref/store ──
  const getStreamState = useCallback((): StreamState => {
    const s = engineStore.getState();
    return {
      active: s.streamActive,
      bufferedChars: streamBufferRef.current?.pending ?? 0,
      directPendingChars: pendingStreamRef.current.length,
      followState: followStateRef.current,
    };
  }, []);

  // ── W3-1（D-8）取文/导出聚合：先 flush 再取数（直刷滞后语义透明化）
  // ——flushStreamBuffer 无累积空转幂等，任意时机调用安全。
  const getContent = useCallback(() => {
    flushStreamBuffer();
    return engineStore.getState().getText();
  }, [flushStreamBuffer]);

  const exportHtml = useCallback(() => {
    flushStreamBuffer();
    const text = engineStore.getState().getText();
    return renderToHtml(MarkdownParser.parse(text));
  }, [flushStreamBuffer]);

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
  const setSearchRanges = useCallback((ranges: readonly SearchRange[]) => {
    setSearchRangesState(ranges.length ? [...ranges] : EMPTY_SEARCH_RANGES);
  }, []);

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
        engineStore
          .getState()
          .setSelection(Math.min(from, to), Math.max(from, to));
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
    const logicTop = scrollMapRef.current
      ? scrollMapRef.current.inverse(scrollTop)
      : scrollTop;
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

  // 命令式接口暴露（R5 宿主：engineRef.current.streamAppend / streamEnd；
  // W3-1 扩展：getStreamState/onStreamEnd/discardStream/getContent/
  // exportHtml 接入宿主驾驶舱）
  useImperativeHandle(
    ref,
    () => ({
      streamAppend,
      streamEnd,
      flushStream: flushStreamBuffer,
      getStreamState,
      onStreamEnd,
      discardStream,
      getContent,
      exportHtml,
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
      flushStreamBuffer,
      getStreamState,
      onStreamEnd,
      discardStream,
      getContent,
      exportHtml,
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
  // compositionstart 到达 → 直刷累积与帧聚合缓冲先 flush（W1-1 扩展：
  // buffer 内累积一并提交）——08 §1 招 1「测量/选区/复制操作触达时先
  // flush」：保证用户编辑/选区/点击测量作用在 store 与 DOM 一致的
  // 状态上。关键：capture 相位监听（先于容器内子组件冒泡处理，如
  // HiddenInput 的 keydown→insertText），否则用户击键会先落到滞后 store。
  // flushStreamBuffer 空转无开销（无累积即返回），事件期间任意触发安全。
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const flush = () => flushStreamBuffer();
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
  }, [flushStreamBuffer]);

  // C3 卸载兜底（W0-4，S-EL-06）：宿主未调 streamEnd 即销毁组件（切换
  // 会话/路由卸载）时，pendingStreamRef 的直刷累积随组件 ref 一起消失、
  // store 缺失该段文本。cleanup 调幂等 flushStreamBuffer——W1-1 扩展：
  // 直刷累积（appendText 一次提交）与帧聚合缓冲（同步吐出，不等 rAF）
  // 一并提交，随后 dispose 取消挂起 rAF 防止卸载后回调再触达（store 的
  // 流式尾段合并/收口是宿主职责；卸载时 streamTail 留待宿主自行处理或
  // 下次 append 合并）。引擎内其余 rAF 在 observeElementOffset 的
  // tanstack 清理函数内，由 virtualizer 卸载时取消，无需额外清理。
  useLayoutEffect(() => {
    return () => {
      flushStreamBuffer();
      streamBufferRef.current?.dispose();
    };
  }, [flushStreamBuffer]);

  // 滚动监听（C3 flush 时机 4：滚动到尾部/离开窗口）：
  // - dirty 行离开虚拟窗口范围（超出 overscan，DOM 即将随窗口变化卸载）
  //   → 立即 flush，防直刷文本随 DOM 卸载丢失；
  // - dirty 行从视口外回到可见视口（用户滚动到尾部触达直刷行）→ flush，
  //   保证随后可见行的测量/交互基于已提交状态。
  const handleScrollFlush = useCallback(() => {
    // W1-2（D-3）：跟随状态随滚动事件更新（引擎自身贴底写触发的滚动
    // 事件同样收敛到 follow，自洽；scrollFollow 关闭时跳过零开销）——
    // 距底部 ≤ FOLLOW_EDGE_PX → follow；离开 → paused（用户阅读）。
    const followEl = parentRef.current;
    if (followEl && scrollFollowRef.current) {
      followStateRef.current =
        followEl.scrollHeight - followEl.scrollTop - followEl.clientHeight <=
        FOLLOW_EDGE_PX
          ? 'follow'
          : 'paused';
    }
    if (dirtyRefs.current.size === 0) {
      dirtyRowOutOfViewRef.current = false;
      // W1-1（滚动为四类 flush 时机之一）：无直刷 dirty 时 buffer 仍可能
      // 有帧聚合累积（rAF 未到）——一并提交，防滚动测量作用在滞后 store。
      flushStreamBuffer();
      return;
    }
    const items = virtualizer.getVirtualItems();
    if (items.length === 0) return;
    const first = items[0].index;
    const last = items[items.length - 1].index;
    for (const idx of dirtyRefs.current) {
      if (idx < first || idx > last) {
        flushStreamBuffer();
        return;
      }
    }
    const dirtyIdx = dirtyRefs.current.values().next().value as number;
    const nowVisible = isRowInVisibleViewport(dirtyIdx);
    if (nowVisible && dirtyRowOutOfViewRef.current) {
      flushStreamBuffer();
      return;
    }
    dirtyRowOutOfViewRef.current = !nowVisible;
  }, [virtualizer, flushStreamBuffer, isRowInVisibleViewport]);

  // 行 ref 注册表（稳定回调，空依赖不破坏 LineItem memo）：
  // 挂载时登记到 rowRefs（index 从 data-index 属性读，不依赖闭包），同时调用
  // virtualizer.measureElement 注册 elementsCache（directDomUpdates 位置写入通道）；
  // 卸载条目不即时清理——批量测量循环按 isConnected 过滤，天然清除已卸载行，
  // 防 stale 条目污染测量（行卸载即 DOM 断开，detached 元素 offsetHeight 不可信）。
  const registerRowRef = useCallback(
    (el: HTMLElement | null) => {
      virtualizer.measureElement(el);
      if (!el) return;
      const idx = parseInt(el.getAttribute('data-index') || '-1', 10);
      if (idx >= 0) rowRefs.current.set(idx, el);
    },
    [virtualizer]
  );

  // 渲染窗口签名（首尾 index）：directDomUpdates 模式下 React 渲染仅发生在
  // 窗口变化帧（range 首尾 index 变化 / isScrolling 翻转），此处读到的窗口
  // 即「将要渲染的窗口」——批量测量协议只在窗口变化帧运行，位置帧零开销
  const virtualItems = virtualizer.getVirtualItems();
  const windowKey = virtualItems.length
    ? virtualItems[0].index + '-' + virtualItems[virtualItems.length - 1].index
    : '';

  // P3 B5（A5 渲染分层 L3 Canvas 接缝——预留消费点，本轮不实际切渲染）：
  // 渲染模式判定（rowSurface.resolveRenderMode，触发条件登记 = readOnly &&
  // 行数 ≥ 阈值 && 'canvas' 注册表存在，见 rowSurface.ts）。当前 Canvas 层
  // 未立项恒得 'dom'；行渲染仍走 LineItem 通道（DOM 实现 = 现通道原样封装，
  // 行为零变化）。后续 Canvas 立项时在此消费 RowSurface：
  //   const surface = createDomRowSurface(contentEl) / 注册表工厂能力检测命中；
  //   mountRows → 窗口变化（现 map 挂载点）、updateRows → dirty/行版本 bump、
  //   unmountRows → 行离开窗口、locateRow → 像素定位（现 HeightMap 二分）；
  // 行粒度 DOM 回退由 RowSurface 工厂能力检测失败兜底（A5 §3.1）。
  // renderMode prop 为宿主意图声明（缺省 'dom' = 零行为变化），
  // resolveRenderMode 门禁内消费：'canvas' 意图在 readOnly/行数阈值/
  // 注册表任一不满足时回落 'dom'（canvas 未实现时登记语义）。
  const renderMode = resolveRenderMode({
    readOnly: !!readOnly,
    lineCount,
    requested: requestedRenderMode,
  });

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
    // W1-2（D-3）滚动跟随评估（声明序在 effect 开头：流式会话中表格
    // 定型门禁（streamActive 为 false → 早退）位于本 effect 中段，评估
    // 必须在此之前执行；贴底写 scrollTop = scrollHeight 为物理直写，
    // 不依赖行高模型回填，故无需等待测量循环）：
    // - 仅流式会话（store.streamActive 为 true，W2-1 D-1 换源——旧判定
    //   streamOp 非空）评估——编辑提交（streamActive 为 false）零影响
    //   （编辑路径滚动语义不变）；
    // - follow 态且视口距底部 > FOLLOW_EDGE_PX（新内容把尾部推出视口，
    //   或初始化时视口未贴底）→ 贴底跟随：el.scrollTop = el.scrollHeight
    //   物理直写（浏览器 clamp 到 maxTop），经既有滚动通道（observer
    //   同步 scrollOffset），零 tanstack scrollState/reconcile 状态污染；
    // - 增量 ≤ 阈值（小提交）不滚 → 主动修改计数受控（R-13：60s 内
    //   ≤2 = 初始化贴底 + 恢复贴底）。
    // 每帧至多一次：本 effect 每帧至多跑一遍，且仅提交后（flush 置位
    // followPendingRef）才评估。
    if (followPendingRef.current) {
      followPendingRef.current = false;
      const followSt = engineStore.getState();
      if (
        scrollFollowRef.current &&
        followSt.streamActive === true &&
        followStateRef.current === 'follow'
      ) {
        const followEl = parentRef.current;
        if (
          followEl &&
          followEl.scrollHeight - followEl.scrollTop - followEl.clientHeight >
            FOLLOW_EDGE_PX
        ) {
          followEl.scrollTop = followEl.scrollHeight;
        }
      }
    }
    // C3 直刷安全网（dirty 协议兜底）：dirty 行 DOM 已断开（窗口/布局
    // 变化导致卸载，如 resize 触发的窗口重排、异常路径提前卸载）→ 立即
    // flush 提交累积文本（W1-1：直刷累积 + 帧聚合缓冲一并提交），防直刷
    // 文本随 DOM 丢失（store 权威，随窗口重挂载即恢复完整内容）。
    if (dirtyRefs.current.size > 0) {
      let dirtyDisconnected = false;
      for (const idx of dirtyRefs.current) {
        const el = rowRefs.current.get(idx);
        if (!el || !el.isConnected) {
          dirtyDisconnected = true;
          break;
        }
      }
      if (dirtyDisconnected) flushStreamBuffer();
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
    // 行类型经 parseLine（AST 缓存命中，O(可见) 可忽略）。核实修正
    // （plan-A4）：parser 独立判定 table_row，表头高亮（isHeaderRow）流式中
    // 即时生效——无需候选态/回溯。
    // W0-2 / W1-3（docs/streaming-render/00 总方案 D-2 三态协议）：
    // 流式会话中（store.streamActive 为 true，W2-1 D-1 换源——旧判定
    // streamOp !== null）→ 结构定型锁宽（分隔行到达即锁 + grow-only
    // 修正，见下方流式分支）；W0-2 修复的「流式尾表提前锁宽」bug 在此
    // 分支以「锁宽时机 = 分隔行落库（结构证据），非表格闭合」替代——
    // 不再把流式尾段 nextLn === null 当闭合信号锁死表头宽。
    // 非流式（streamActive 为 false）→ 既有闭合定型路径（零变化，非流式
    // + 表格为文档尾的 nextLn === null 闭合语义保持）。
    try {
      const st = engineStore.getState();
      // W0-2 / W1-3 门禁分流（W2-1 D-1 换源，streamActive 消费先例同
      // 本文件 356-357 行）：流式会话中（streamActive === true）走 W1-3
      // 结构定型锁宽分支；非流式（streamActive === false）走既有闭合
      // 定型路径（下方，零变化）。
      if (st.streamActive === true) {
        // ── W1-3（D-2）流式结构定型锁宽 ──
        // 表格段定位不依赖虚拟窗口（P2 长表：分隔行滚出窗口仍可锁）：
        // - 段追踪 ref（streamTableTrackRef）：段不存在时从 store 行视图
        //   尾部向上探测「尾部连续表格段」（不穿越非表格行——已闭合段
        //   流式期间不再处理，其锁宽早已在结构定型时完成；整表 + 闭合行
        //   单 chunk 一次到达的极端粒度由 streamEnd 后闭合定型兜底）；
        // - 段存在时从段尾向后逐行增量扩展（O(新增行)，parseLine AST
        //   缓存命中），遇非表格行 = 段闭合 → 本帧修正后停止追踪；
        // - 测宽仍依赖已挂载行（scrollWidth 需 DOM；与既有闭合定型同款
        //   约束）：从 measuredThrough + 1 起测「连续已挂载」的新增行，
        //   未挂载行停住不推进（挂载后下个 effect 帧补测——跟随滚动
        //   场景下新增尾部行始终挂载，进度紧贴段尾，无缺口）；
        // - 应用：未锁宽 → 按已见行测宽锁定一次（结构定型即锁）；
        //   已锁宽 → 逐列 grow-only（新测宽 > 现宽才写入，零变化零写入）。
        // 效率：每帧成本 = 新增行 parseLine + 未挂载行 O(1) 跳行 +
        // 已挂载新增行的 scrollWidth 测量，不整表重扫（已测行不重测）。
        const track = streamTableTrackRef.current;
        if (!track) {
          // 尾部探测：从文档尾向上走连续表格行（table_row/table_separator），
          // 遇非表格行停——找到的段即「尾部活跃表格段」（段内含分隔行
          // 则结构成立，无分隔行 = 孤立表格行，不建段）
          let tailStart = st.getLineCount() - 1;
          let sepIdx = -1;
          while (tailStart >= 0) {
            const rawL = st.getLine(tailStart);
            if (rawL === undefined) break;
            const lnL = MarkdownParser.parseLine(
              rawL,
              tailStart,
              getLineState(st, tailStart)
            );
            if (lnL.type === 'table_separator') sepIdx = tailStart;
            else if (lnL.type !== 'table_row') break;
            tailStart--;
          }
          if (sepIdx !== -1) {
            // 段头回退：分隔行向上走连续 table_row（与下方闭合定型
            // headerIdx 回退同款），tableId 以首个 | 行 index 计
            let headerIdx = sepIdx - 1;
            while (headerIdx >= 0) {
              const rawH = st.getLine(headerIdx);
              if (rawH === undefined) break;
              const lnH = MarkdownParser.parseLine(
                rawH,
                headerIdx,
                getLineState(st, headerIdx)
              );
              if (lnH.type !== 'table_row') break;
              headerIdx--;
            }
            headerIdx++;
            streamTableTrackRef.current = {
              headerIdx,
              lastRowIdx: st.getLineCount() - 1,
              measuredThrough: headerIdx - 1,
            };
          }
        } else {
          // 增量扩展：段尾向后走连续 table_row（O(新增行)）；遇非表格行
          // → 段闭合（下方修正后置空追踪）；段尾即文档尾 → 继续增长
          let idx = track.lastRowIdx + 1;
          while (idx < st.getLineCount()) {
            const rawL = st.getLine(idx);
            if (rawL === undefined) break;
            const lnL = MarkdownParser.parseLine(
              rawL,
              idx,
              getLineState(st, idx)
            );
            if (lnL.type !== 'table_row') break;
            track.lastRowIdx = idx;
            idx++;
          }
        }
        const active = streamTableTrackRef.current;
        if (active) {
          const colMax: number[] = [];
          let measured = active.measuredThrough;
          for (let r = measured + 1; r <= active.lastRowIdx; r++) {
            const rowEl = rowRefs.current.get(r);
            if (!rowEl || !rowEl.isConnected) break; // 未挂载 → 停住，挂载后补测
            rowEl
              .querySelectorAll<HTMLElement>('.token-table-cell')
              .forEach((cell, ci) => {
                const w = cell.scrollWidth;
                if (w > 0) colMax[ci] = Math.max(colMax[ci] ?? 0, w);
              });
            measured = r;
          }
          active.measuredThrough = measured;
          const tableId = `table-${active.headerIdx}`;
          const tableStore = useTableStore.getState();
          const current = tableStore.tableWidths[tableId];
          if (colMax.length > 0) {
            if (!current) {
              // 结构定型锁宽：分隔行已落库（track 建立的先决条件），
              // 按已见行测宽锁定；锁窄风险由 grow-only 兜底
              useTableStore.getState().setTableWidths(tableId, colMax);
              // W3-3（S-EL-11）M6 登记点：每次定型（首次锁宽 / 修正）
              // 经引擎登记点计数（perf suite 表格流式场景读取判定）
              recordTableWidthSettle(tableId);
            } else {
              // grow-only 修正：逐列只增不减；无超宽列零写入
              let changed = false;
              const next = [...current];
              for (let ci = 0; ci < colMax.length; ci++) {
                if (colMax[ci] > (current[ci] ?? 0)) {
                  next[ci] = colMax[ci];
                  changed = true;
                }
              }
              if (changed) {
                useTableStore.getState().setTableWidths(tableId, next);
                // W3-3（S-EL-11）M6 登记点（grow-only 修正同样登记）
                recordTableWidthSettle(tableId);
              }
            }
          }
          // 段闭合：段尾之后已存在非表格行 → 本表不再变化，停止追踪
          // （闭合段锁宽早已完成；后续到达的表格段由尾部探测重新发现）
          if (active.lastRowIdx < st.getLineCount() - 1) {
            streamTableTrackRef.current = null;
          }
        }
        return;
      }
      const items = virtualizer.getVirtualItems();
      let sepIdx = -1;
      for (const item of items) {
        const rawL = st.getLine(item.index);
        if (rawL === undefined) continue;
        const ln = MarkdownParser.parseLine(
          rawL,
          item.index,
          getLineState(st, item.index)
        );
        if (ln.type === 'table_separator') sepIdx = item.index;
      }
      if (sepIdx !== -1) {
        let headerIdx = sepIdx - 1;
        while (headerIdx >= 0) {
          const rawH = st.getLine(headerIdx);
          if (rawH === undefined) break;
          const lnH = MarkdownParser.parseLine(
            rawH,
            headerIdx,
            getLineState(st, headerIdx)
          );
          if (lnH.type !== 'table_row') break;
          headerIdx--;
        }
        headerIdx++;
        let segEnd = sepIdx + 1;
        while (segEnd < st.getLineCount()) {
          const rawE = st.getLine(segEnd);
          if (rawE === undefined) break;
          const lnE = MarkdownParser.parseLine(
            rawE,
            segEnd,
            getLineState(st, segEnd)
          );
          if (lnE.type !== 'table_row') break;
          segEnd++;
        }
        const nextLn =
          segEnd < st.getLineCount()
            ? (() => {
                const rawN = st.getLine(segEnd);
                if (rawN === undefined) return null;
                return MarkdownParser.parseLine(
                  rawN,
                  segEnd,
                  getLineState(st, segEnd)
                );
              })()
            : null;
        const tableId = `table-${headerIdx}`;
        const tableStore = useTableStore.getState();
        if (
          (nextLn === null || nextLn.type !== 'table_row') &&
          !tableStore.tableWidths[tableId]
        ) {
          const colWidths: number[] = [];
          for (let r = headerIdx; r < segEnd; r++) {
            const rowEl = rowRefs.current.get(r);
            if (!rowEl || !rowEl.isConnected) continue;
            rowEl
              .querySelectorAll<HTMLElement>('.token-table-cell')
              .forEach((cell, ci) => {
                const w = cell.scrollWidth;
                if (w > 0) colWidths[ci] = Math.max(colWidths[ci] ?? 0, w);
              });
          }
          if (colWidths.length > 0) {
            useTableStore.getState().setTableWidths(tableId, colWidths);
            // W3-3（S-EL-11）M6 登记点（非流式闭合定型路径同规登记）
            recordTableWidthSettle(tableId);
          }
        }
      }
    } catch {
      // 定型失败静默（渲染路径不因测量异常中断）
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mainLines,
    streamTail,
    mainCodeState,
    streamTailCodeState,
    lineCount,
    windowKey,
    flushStreamBuffer,
  ]);

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
        e.clipboardData.setData(
          'text/plain',
          state.getText().substring(start, end)
        );
        e.preventDefault();
      }
    },
    [readOnly, engineStore]
  );

  const handleContainerClick = (e: React.MouseEvent) => {
    // R5 readOnly：只读模式点击不移动光标（光标定位链路整体短路）——
    // 原生 DOM 文本选区/选择复制不受影响（浏览器默认行为，不 preventDefault）。
    if (readOnly) return;
    const st = engineStore.getState();

    // If we just finished a drag selection, ignore the synthetic click
    if (Date.now() - ((window as any).__CRISH_LAST_DRAG_END_TIME || 0) < 50)
      return;

    const target = e.target as HTMLElement;

    // 表格单元格点击由单元格自身状态机独立处理（单选、双击/二次点击编辑、光标定位）
    if (target.closest('.token-table-cell')) {
      return;
    }

    if (!target.closest('.line-table-row')) {
      useTableStore.getState().clearCellSelection();
    }

    // If the user selected text, do NOT clear the selection and do NOT move the custom cursor
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }

    if (!parentRef.current) return;

    // Prevent table separator from being clicked. Redirect to previous row (table header)
    const clickedLineIndex = parseInt(
      target.closest('[data-index]')?.getAttribute('data-index') || '-1',
      10
    );
    if (
      clickedLineIndex !== -1 &&
      st
        .getLine(clickedLineIndex)
        ?.trim()
        .match(/^\|?[\s:-]*[-]+[\s:-]*\|/)
    ) {
      if (clickedLineIndex > 0) {
        const prevLineStart = st.lineOffsets.getOffset(clickedLineIndex - 1);
        const prevLineLen = st.getLine(clickedLineIndex - 1).length;
        setCursorPos(prevLineStart + prevLineLen);
        return;
      }
    }

    // 优先采用 mousedown 时在未展开 DOM 上计算的预先锚定索引，
    // 杜绝点击后语法展开导致光标吸附到新出现的隐藏语法标记（如 ### 或 **）上
    const preClick = (window as any).__CRISH_PRE_CLICK_INDEX;
    let exactIndex: number;
    if (
      preClick &&
      Math.abs(e.clientX - preClick.x) <= 4 &&
      Math.abs(e.clientY - preClick.y) <= 4 &&
      Date.now() - preClick.time < 800
    ) {
      exactIndex = preClick.index;
      (window as any).__CRISH_PRE_CLICK_INDEX = null;
    } else {
      exactIndex = indexFromClientPoint(
        e.clientX,
        e.clientY,
        parentRef.current,
        st,
        clickedLineIndex >= 0 ? clickedLineIndex : undefined
      );
    }
    setCursorPos(exactIndex);
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
           P3 B3（plan-A3 §3 顺带修复）：onBeforeReplace 接 flush——
           面板在滚动容器外，容器 capture flush 监听不触达面板 keydown，
           替换动作先提交直刷 pending（命中在末行时 B 判定已保证无
           pending，空转零开销）。W1-1 扩展：flushStreamBuffer 同时提交
           帧聚合缓冲——替换作用在最新 store（含帧内未提交文本）。
           宿主可用 findReplace prop 显式关闭（只读消息历史场景） */}
      {findReplace && (
        <FindReplacePanel
          store={engineStore}
          onGoToMatch={scrollToMatch}
          onSetHighlights={setSearchRanges}
          onBeforeReplace={flushStreamBuffer}
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
                const start = Math.min(
                  state.selectionStart,
                  state.selectionEnd
                );
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
        // P3 B5：渲染模式登记（Canvas 接缝触发条件的可测落点——当前恒
        // 'dom'，canvas 注册/阈值/readOnly 任一不满足即回落 dom）
        data-render-mode={renderMode}
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
                    useGpuLayer={useGpuLayer}
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
                  // P3 B5：GPU 合成开关（B+C+D 组合，false 一行回退）
                  useGpuLayer={useGpuLayer}
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
              containerRef={parentRef}
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
