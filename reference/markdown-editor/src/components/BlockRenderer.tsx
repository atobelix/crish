/**
 * 块级渲染器 + 渲染注册表（R5-C：渲染注册表 + 主题注入）
 *
 * 对应 docs/analysis/06-扩展功能-技术维度.md §5：
 * - BlockRendererRegistry: Map<LineType, 渲染器组件>——核心 12 类型
 *   提取为默认注册表（默认注册表 = 原 switch 分支提取，行为零变化）；
 * - BlockRenderer switch 改为查注册表 + 未知类型兜底（fallback 到
 *   默认 body 渲染器——原 switch 的 `case 'body': default:` 同义）；
 * - renderMathToHtml 改走 renderTheme 注入点（KaTeX 默认，可替换）。
 *
 * 扩展语义：宿主（Conex）注册自定义块类型渲染器
 *   registerBlockRenderer('custom_block', MyRenderer)
 * 后，解析层产出的自定义 LineType 行直接命中注册表；移除后恢复兜底。
 */
import { memo, useState } from 'react';
import type { LineNode, InlineNode, LineType } from '../core/ast';
import type { CodeState } from '../core/parser';
import { checkIsActive, type ActiveState } from '../core/measure';
import { InlineRenderer } from './InlineRenderer';
import { useEditorStore, type EditorStore, type EditorState } from '../core/EditorStore';
import { renderMathToHtml } from '../core/renderTheme';
// B4 N5：复制按钮剪贴板工具 + 引用前缀剥离（与导出投影器共享单源）
import { copyTextToClipboard, stripBlockquotePrefix } from '../core/renderToHtml';
// B5 bidi 接线：行级 RTL 检测（isRtlLine——弱类型扫描，LTR 行快速
// 路径返回 false，零开销；渲染时调用，memo 保证行不变不重算）
import { isRtlLine } from '../core/Bidi';

const MAX_VISIBLE_LINE_CHARS = 5_000;

function truncateTokens(tokens: InlineNode[], maxChars: number): InlineNode[] {
  const result: InlineNode[] = [];
  let currentLength = 0;
  for (const token of tokens) {
    if (currentLength + token.length <= maxChars) {
      result.push(token);
      currentLength += token.length;
    } else {
      const remaining = maxChars - currentLength;
      if (remaining > 0) {
        result.push({
          ...token,
          raw: token.raw.substring(0, remaining),
          content: token.content.substring(0, remaining),
          length: remaining,
          children: token.children
            ? truncateTokens(token.children, remaining)
            : undefined,
        });
      }
      break;
    }
  }
  return result;
}

/**
 * 流式软渲染判定（05 分析 §2.1 场景一）：判定第 lineIndex 行是否位于
 * 「未闭合的围栏区间」内——
 * - 已闭合区间：返回 false，走常规硬渲染（代码启发式高亮 / KaTeX 渲染）；
 * - 未闭合区间：返回 true，走软渲染（等宽原文，跳过启发式高亮与 KaTeX，
 *   避免半块突然变色的视觉跳变）。
 * 判定语义（O(1)，利用 fenceLines 严格交替——开闭边界必然成对出现，
 * 见 EditorStore.updateLinesIncremental 前缀状态恢复注释）：
 * 文档最多存在一个未闭合围栏区间，且必然从「最后一个围栏边界」开始——
 * 若最后一个围栏边界是起始围栏（fence_start / math_fence_start，其后
 * 尚无配对闭合行），则它之后的所有 code / math_block 行都属于未闭合
 * 区间；否则全文档围栏均已闭合。只对围栏内行判定：缩进代码块
 * （indent_code）无闭合语义，不参与。
 */

/**
 * 未闭合围栏判定的双段存储版（R6-P1 物化惰性化）：不再读取物化视图
 * codeBlockState/fenceLines（读取会触发惰性物化——流式期间每次 set 的
 * 订阅选择器求值 O(全文) concat），改读双段原始字段（mainCodeState/
 * streamTailCodeState/mainFenceLines/streamTailFenceLines + 主数组行数）
 * 在订阅端组合逻辑视图判定，零物化。
 * 语义与物化视图版 isInUnclosedFence 逐分支等价：行状态经双段访问器
 * （i < boundary 取主数组，否则取尾段——尾段「接管」主数组末行）；
 * 尾段 fence 相对行号平移 boundary 后全局有序，最后一个围栏边界 =
 * 尾段末 fence（若存在）否则主数组末 fence。
 */
function isInUnclosedFenceParts(
  lineIndex: number,
  mainCodeState: CodeState[],
  tailCodeState: CodeState[],
  mainFenceLines: number[],
  tailFenceLines: number[],
  mainLineCount: number
): boolean {
  const boundary = mainLineCount - 1;
  // 双段访问器与 EditorStore.lineAt 逐点一致（P2-A1 回修 2 登记）：
  // 尾段为空（常规编辑/加载路径）→ 直接读主数组；非空 → 尾段「接管」
  // 主数组末行（i ≥ boundary 从尾段相对下标取）。缺省短路会令末行
  // 状态读到 undefined——流式 flush 后文档以未闭合围栏结尾时软渲染
  // 判定失效（B4 修复，与 computeFenceContext 同步对齐）。
  const getState = (i: number): CodeState =>
    tailCodeState.length === 0
      ? mainCodeState[i]
      : i < boundary
        ? mainCodeState[i]
        : tailCodeState[i - boundary];
  const st = getState(lineIndex);
  if (st !== 'code' && st !== 'math_block') return false;
  const tailFenceCount = tailFenceLines.length;
  const n = mainFenceLines.length + tailFenceCount;
  if (n === 0) return false;
  const lastFence =
    tailFenceCount > 0
      ? boundary + tailFenceLines[tailFenceCount - 1]
      : mainFenceLines[mainFenceLines.length - 1];
  const lastFenceState = getState(lastFence);
  if (lastFenceState !== 'fence_start' && lastFenceState !== 'math_fence_start') {
    return false;
  }
  return lineIndex > lastFence;
}

// ============================================================
// 渲染注册表
// ============================================================

/** 块渲染器组件 props（注册表组件与 BlockRenderer 同签名） */
export interface BlockRendererComponentProps {
  block: LineNode;
  index: number;
  lineOffset: number;
  activeState?: ActiveState | null;
  tableId?: string;
  /** B5 bidi：本行是否 RTL（isRtlLine 检测结果，BlockRenderer 顶层
   *   memo 内计算一次，随 props 传入——行不变不重算，memo 友好）。
   *   LTR 行 = false；渲染器自行决定 dir 落点（整行容器/blockquote
   *   内容），未消费的渲染器忽略（行为零变化）。 */
  rtl?: boolean;
  /** 显式 store 实例（R6-P1 软渲染订阅实例化接线点）：缺省 = 全局单例。
   *  仅软渲染判定订阅消费（流式围栏未闭合判定），渲染本身零依赖。 */
  store?: EditorStore;
}

/** 块渲染器组件类型：Map 值（06 §5：自定义块渲染 + 渲染注册） */
export type BlockRendererComponent = React.ComponentType<BlockRendererComponentProps>;

/** 渲染注册表：LineType → 渲染器组件（核心 12 类型默认注册） */
export const BlockRendererRegistry = new Map<LineType, BlockRendererComponent>();

/**
 * 默认注册项快照：核心 12 类型的出厂渲染器。unregisterBlockRenderer
 * 移除「自定义覆盖」时据此恢复出厂渲染器（与 InlineRuler.unregister
 * 恢复内置规则语义对齐）；自定义类型的 unregister 直接删除条目。
 */
const defaultRenderers = new Map<LineType, BlockRendererComponent>();

/**
 * 注册自定义块渲染器。同名注册直接替换（markdown-it at 语义，与
 * InlineRuler.register 对齐）；注册核心类型会覆盖默认渲染器。
 */
export function registerBlockRenderer(
  type: LineType,
  renderer: BlockRendererComponent
): void {
  BlockRendererRegistry.set(type, renderer);
}

/**
 * 移除注册：
 * - 核心 12 类型：恢复出厂默认渲染器（覆盖被取消，引擎行为复原）；
 * - 自定义类型：删除条目，回落到兜底默认渲染器。
 * 未注册类型返回 false。
 */
export function unregisterBlockRenderer(type: LineType): boolean {
  const def = defaultRenderers.get(type);
  if (def) {
    BlockRendererRegistry.set(type, def);
    return true;
  }
  return BlockRendererRegistry.delete(type);
}

/**
 * 解析渲染器：注册表命中 → 该渲染器；未命中（未知/未注册类型）→
 * 兜底默认渲染器（即原 switch 的 default 分支：body 行语义，
 * 对 html_block 等未显式分支类型保持行为零变化）。
 */
export function resolveBlockRenderer(
  type: LineType
): BlockRendererComponent {
  return BlockRendererRegistry.get(type) ?? DefaultBlockRenderer;
}

// ============================================================
// 默认注册表：核心 12 类型渲染器（原 switch 分支逐字提取）
// ============================================================

/** 订阅「本行是否位于未闭合围栏区间」（R3-C 流式软渲染判定）。
 * R6-P1：选择器改读双段原始字段（isInUnclosedFenceParts）——返回布尔，
 * 引用变化但判定结果不变时 zustand 按 Object.is 比较跳过重渲染，仅在
 * 软/硬渲染翻转时更新本行。store 缺省 = 全局单例（向后兼容）；宿主
 * 多实例场景可经 props.store 传入实例 store（R5 实例化接线点）。
 * 注意：R5-A 登记「softRender 仍订阅全局单例」——MarkdownEngine 的
 * LineItem 尚未透传 store prop（MarkdownEngine.tsx 禁碰登记），实例化
 * 接线待宿主侧接入。 */
function useSoftRender(
  index: number,
  store?: EditorStore
): boolean {
  const editorStore = store ?? useEditorStore;
  return editorStore((state) =>
    isInUnclosedFenceParts(
      index,
      state.mainCodeState,
      state.streamTailCodeState,
      state.mainFenceLines,
      state.streamTailFenceLines,
      state.mainLines.length
    )
  );
}

/** 空块渲染器（空行） */
function EmptyBlock(_: BlockRendererComponentProps) {
  return (
    <div className="line-block">
      <br />
    </div>
  );
}

// ============================================================
// fence lang 渲染器注册表（B4 N4：工具产物渲染——lang 键分发）
// ============================================================

/**
 * fence lang 渲染器 props：行级渲染契约（引擎是行式渲染架构，围栏内容
 * 逐行渲染）——renderer 拿到整块内容（lines，块级语义渲染器取上下文）
 * 与当前行（lineIndex/lineText/lineOffset，行级语义渲染器直接消费）。
 */
export interface FenceLangRendererProps {
  /** 围栏语言标识（fence_start 行提取；未识别为 'code'） */
  lang: string;
  /** 整块内容行（已剥引用前缀的原始内容行，\n 语义由渲染器自理） */
  lines: string[];
  /** 当前行在块内序号（0 起） */
  lineIndex: number;
  /** 当前行文本（已剥引用前缀的原始内容行） */
  lineText: string;
  /** 当前行全局字符偏移（源码定位） */
  lineOffset: number;
}

/** fence lang 渲染器组件类型（lang 键注册表，区别于 LineType 键的
 *  BlockRendererRegistry——机制先例：R5-C 渲染注册表） */
export type FenceLangRenderer = React.ComponentType<FenceLangRendererProps>;

/** lang 键渲染注册表：lang → 渲染器组件 */
export const FenceLangRendererRegistry = new Map<string, FenceLangRenderer>();

/** 出厂注册项快照（json/diff/log）：unregister 移除「自定义覆盖」时据此
 *  恢复出厂渲染器（与 unregisterBlockRenderer 语义对齐） */
const defaultFenceLangRenderers = new Map<string, FenceLangRenderer>();

/** 注册 fence lang 渲染器。同名注册直接替换（markdown-it at 语义）。
 *  未注册 lang 的围栏由 BlockRenderer 走默认代码渲染（行为零变化）。 */
export function registerFenceLangRenderer(
  lang: string,
  renderer: FenceLangRenderer
): void {
  FenceLangRendererRegistry.set(lang, renderer);
}

/** 移除注册：内置 lang（json/diff/log）恢复出厂渲染器；自定义 lang
 *  删除条目（回到默认代码渲染）。未注册返回 false。 */
export function unregisterFenceLangRenderer(lang: string): boolean {
  const def = defaultFenceLangRenderers.get(lang);
  if (def) {
    FenceLangRendererRegistry.set(lang, def);
    return true;
  }
  return FenceLangRendererRegistry.delete(lang);
}

/** 解析 lang 渲染器：未注册返回 null（BlockRenderer 走默认代码渲染） */
export function resolveFenceLangRenderer(lang: string): FenceLangRenderer | null {
  return FenceLangRendererRegistry.get(lang) ?? null;
}

/** fence_start 行提取语言标识（lang pill 与 fence 上下文分发共用单源） */
function extractFenceLang(raw: string): string {
  let s = raw.trim();
  let bMatch;
  while ((bMatch = s.match(/^\s*>\s?/))) {
    s = s.substring(bMatch[0].length);
  }
  s = s.trim();
  return s.replace(/^```+/, '').trim() || 'code';
}

/**
 * JSON 行级着色渲染器：键名/字符串/数值/布尔/null/标点分色
 * （正则单趟扫描；工具产物 JSON 输出逐行可读化）。
 */
function JsonFenceLangRenderer({ lineText }: FenceLangRendererProps) {
  // 令牌顺序：键名（后随冒号）→ 布尔/null → 字符串 → 数值 → 标点
  const TOKEN_RE =
    /"(?:\\.|[^"\\])*"(?=\s*:)|\b(?:true|false|null)\b|"(?:\\.|[^"\\])*"|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[{}[\],:]/g;
  const parts: { text: string; color: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(lineText)) !== null) {
    if (m.index > last) {
      parts.push({ text: lineText.slice(last, m.index), color: '' });
    }
    const tok = m[0];
    let color = '';
    if (/^"[\s\S]*"(?=\s*:)/.test(tok)) {
      color = 'hsl(200 60% 55%)'; // 键名（蓝）
    } else if (tok === '{' || tok === '}' || tok === '[' || tok === ']' || tok === ',' || tok === ':') {
      color = 'hsl(0 0% 55%)'; // 标点（灰）
    } else if (tok.startsWith('"')) {
      color = 'hsl(120 35% 50%)'; // 字符串（绿）
    } else if (tok === 'true' || tok === 'false' || tok === 'null') {
      color = 'hsl(30 80% 55%)'; // 布尔/null（橙）
    } else {
      color = 'hsl(260 50% 60%)'; // 数值（紫）
    }
    parts.push({ text: tok, color });
    last = m.index + tok.length;
  }
  if (last < lineText.length) {
    parts.push({ text: lineText.slice(last), color: '' });
  }
  return (
    <span data-lang-renderer="json" style={{ whiteSpace: 'pre' }}>
      {parts.map((p, i) =>
        p.color ? (
          <span key={i} style={{ color: p.color }}>
            {p.text}
          </span>
        ) : (
          p.text
        )
      )}
    </span>
  );
}

/** diff 渲染器：行首 + / - 红绿着色、@@ 头青色（逐行前缀判定）。
 *  行形态经 data-diff-class 暴露（add/del/hunk/context），宿主可定制。 */
function DiffFenceLangRenderer({ lineText }: FenceLangRendererProps) {
  let color = '';
  let cls = '';
  if (lineText.startsWith('+')) {
    color = 'hsl(120 60% 42%)';
    cls = 'add';
  } else if (lineText.startsWith('-')) {
    color = 'hsl(0 65% 50%)';
    cls = 'del';
  } else if (lineText.startsWith('@@')) {
    color = 'hsl(200 70% 45%)';
    cls = 'hunk';
  }
  return (
    <span
      data-lang-renderer="diff"
      data-diff-class={cls || 'context'}
      style={{ whiteSpace: 'pre', color: color || undefined }}
    >
      {lineText}
    </span>
  );
}

/** log 渲染器：级别着色（ERROR 红 / WARN 黄 / INFO 蓝 / DEBUG 弱化）+
 *  时间戳前缀弱化（YYYY-MM-DD HH:MM:SS(.mmm)）。
 *  级别经 data-log-level 暴露（error/warn/info/debug/other），宿主可定制。 */
function LogFenceLangRenderer({ lineText }: FenceLangRendererProps) {
  let levelColor = '';
  let levelCls = '';
  const levelMatch = /\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/.exec(lineText);
  const level = levelMatch ? levelMatch[1].toUpperCase() : '';
  if (level === 'ERROR') {
    levelColor = 'hsl(0 65% 50%)';
    levelCls = 'error';
  } else if (level === 'WARN') {
    levelColor = 'hsl(40 85% 45%)';
    levelCls = 'warn';
  } else if (level === 'INFO') {
    levelColor = 'hsl(200 70% 45%)';
    levelCls = 'info';
  } else if (level === 'DEBUG' || level === 'TRACE') {
    levelColor = 'hsl(0 0% 55%)';
    levelCls = 'debug';
  }
  const tsMatch =
    /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*/.exec(lineText);
  if (tsMatch) {
    return (
      <span
        data-lang-renderer="log"
        data-log-level={levelCls || 'other'}
        style={{ whiteSpace: 'pre' }}
      >
        <span style={{ color: 'hsl(0 0% 60%)' }}>{tsMatch[1]}</span>
        <span style={{ color: levelColor || undefined }}>
          {lineText.slice(tsMatch[1].length)}
        </span>
      </span>
    );
  }
  return (
    <span
      data-lang-renderer="log"
      data-log-level={levelCls || 'other'}
      style={{ whiteSpace: 'pre', color: levelColor || undefined }}
    >
      {lineText}
    </span>
  );
}

/** 出厂注册：json / diff / log 三个内置工具产物渲染器 */
function registerDefaultFenceLang(lang: string, renderer: FenceLangRenderer): void {
  FenceLangRendererRegistry.set(lang, renderer);
  defaultFenceLangRenderers.set(lang, renderer);
}

registerDefaultFenceLang('json', JsonFenceLangRenderer);
registerDefaultFenceLang('diff', DiffFenceLangRenderer);
registerDefaultFenceLang('log', LogFenceLangRenderer);

// ============================================================
// fence 上下文（B4 N5：内容行定位 → 复制/分发）
// ============================================================

/** 围栏上下文（fence 内容行渲染/复制所需） */
interface FenceContext {
  /** 围栏语言（fence_start 行提取；未识别为 'code'） */
  lang: string;
  /** 内容区间 [contentStart, contentEnd)（contentEnd = fence_end 行号） */
  contentStart: number;
  contentEnd: number;
  /** 本行是否为围栏首条内容行（复制按钮锚点） */
  isFirstContentLine: boolean;
}

/**
 * 计算围栏上下文（双段存储版，零物化——镜像 isInUnclosedFenceParts 的
 * 双段访问器语义）：仅对「位于已闭合围栏区间内」的 code 行返回上下文；
 * 缩进代码（indent_code）/围栏外行/未闭合围栏（软渲染域）返回 null。
 * 围栏边界定位：主数组二分 + 尾段反向扫描（EditorStore:2051-2062 同款
 * 范式）；「最后一个 < index 的围栏边界」为 fence_start 且其后紧跟
 * fence_end 即闭合区间（严格交替不变量保证）。
 */
function computeFenceContext(state: EditorState, index: number): FenceContext | null {
  const { mainCodeState, streamTailCodeState, mainFenceLines, streamTailFenceLines } = state;
  const boundary = state.mainLines.length - 1;
  // 双段访问器与 lineAt 逐点一致：尾段为空 → 直接读主数组（缺省短路会令
  // 文档末行（如 fence_end）状态读到 undefined，围栏上下文判定失效）
  const stateAt = (i: number): CodeState =>
    streamTailCodeState.length === 0
      ? mainCodeState[i]
      : i < boundary
        ? mainCodeState[i]
        : streamTailCodeState[i - boundary];
  if (stateAt(index) !== 'code') return null;

  // 最后一个 < i 的围栏边界（主数组二分）
  let lo = 0;
  let hi = mainFenceLines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (mainFenceLines[mid] < index) lo = mid + 1;
    else hi = mid;
  }
  let start = lo > 0 ? mainFenceLines[lo - 1] : -1;
  // 尾段反向扫描（尾段 fence 相对行号平移 boundary 后全局有序）
  for (let k = streamTailFenceLines.length - 1; k >= 0; k--) {
    const abs = boundary + streamTailFenceLines[k];
    if (abs < index) {
      if (abs > start) start = abs;
      break;
    }
  }
  if (start === -1 || stateAt(start) !== 'fence_start') return null;

  // 下一个围栏边界（闭合判定）
  lo = 0;
  hi = mainFenceLines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (mainFenceLines[mid] > start) hi = mid;
    else lo = mid + 1;
  }
  let end = lo < mainFenceLines.length ? mainFenceLines[lo] : -1;
  for (const rel of streamTailFenceLines) {
    const abs = boundary + rel;
    if (abs > start && (end === -1 || abs < end)) end = abs;
  }
  // 未闭合（end 缺失或非 fence_end）→ 软渲染域，无上下文
  if (end === -1 || stateAt(end) !== 'fence_end') return null;

  return {
    lang: extractFenceLang(state.getLine(start)),
    contentStart: start + 1,
    contentEnd: end,
    isFirstContentLine: index === start + 1,
  };
}

/** 订阅「本行围栏上下文」：选择器返回稳定字符串键——仅上下文变化时
 *  触发重渲染（zustand Object.is 比较；与 useSoftRender 同款订阅模式，
 *  store 缺省 = 全局单例）。渲染期重算最新上下文（同同步 tick 一致）。 */
function useFenceContext(index: number, store?: EditorStore): FenceContext | null {
  const editorStore = store ?? useEditorStore;
  const key = editorStore((state) => {
    const ctx = computeFenceContext(state, index);
    return ctx === null
      ? ''
      : `${ctx.lang}|${ctx.contentStart}|${ctx.contentEnd}|${ctx.isFirstContentLine ? 1 : 0}`;
  });
  if (key === '') return null;
  return computeFenceContext(editorStore.getState(), index);
}

/** 复制按钮（代码块/公式共用）：图标化小按钮 + 点击反馈。
 *  onMouseDown preventDefault 防抢焦点（编辑器隐藏输入框保持聚焦）；
 *  onClick stopPropagation 防冒泡触发容器点击（光标定位）。
 *  注：样式全部内联（index.css 不在 B4 文件域），测试/宿主经 data-* 属性
 *  定位（data-copy-button 区分 code/math），不新增 className（G6.2 CSS
 *  契约护栏：未登记类引用会炸门禁）。 */
function CopyButton({
  dataAttr,
  label,
  onClick,
}: {
  dataAttr: string;
  label: string;
  onClick: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-copy-button={dataAttr}
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      style={{
        position: 'absolute',
        right: 8,
        top: 2,
        zIndex: 5,
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: '16px',
        padding: '1px 6px',
        borderRadius: 4,
        border: '1px solid var(--border-medium)',
        background: 'var(--bg-theme)',
        color: 'var(--text-secondary)',
      }}
    >
      {copied ? '已复制' : '复制'}
    </button>
  );
}

function CodeFenceStartBlock({
  block,
  lineOffset,
  activeState,
}: BlockRendererComponentProps) {
  const lang = extractFenceLang(block.raw);
  return (
    <div className="line-block line-code-fence line-code-fence-start">
      <span
        className={`code-fence-rendered ${checkIsActive(lineOffset, block.length, activeState ?? null) ? 'is-active-token' : ''}`.trim()}
        data-token-start={lineOffset}
        data-token-length={block.length}
      >
        <span className="code-lang-pill">{lang}</span>
      </span>
      <span
        className="code-fence-source"
        data-token-start={lineOffset}
        data-token-length={block.length}
      >
        {block.raw}
      </span>
    </div>
  );
}

function CodeFenceEndBlock({
  block,
  lineOffset,
  activeState,
}: BlockRendererComponentProps) {
  return (
    <div className="line-block line-code-fence line-code-fence-end">
      <span
        className={`code-fence-rendered ${checkIsActive(lineOffset, block.length, activeState ?? null) ? 'is-active-token' : ''}`.trim()}
        data-token-start={lineOffset}
        data-token-length={block.length}
      ></span>
      <span
        className="code-fence-source"
        data-token-start={lineOffset}
        data-token-length={block.length}
      >
        {block.raw}
      </span>
    </div>
  );
}

function MathFenceStartBlock({
  block,
  lineOffset,
  activeState,
}: BlockRendererComponentProps) {
  return (
    <div className="line-block line-code-fence line-code-fence-start">
      <span
        className={`code-lang-pill code-fence-rendered ${checkIsActive(lineOffset, block.length, activeState ?? null) ? 'is-active-token' : ''}`.trim()}
        data-token-start={lineOffset}
        data-token-length={block.length}
      >
        math
      </span>
      <span
        className="code-fence-source"
        data-token-start={lineOffset}
        data-token-length={block.length}
      >
        {block.raw}
      </span>
    </div>
  );
}

function MathFenceEndBlock({
  block,
  lineOffset,
  activeState,
}: BlockRendererComponentProps) {
  return (
    <div className="line-block line-code-fence line-code-fence-end">
      <span
        className={`code-fence-rendered ${checkIsActive(lineOffset, block.length, activeState ?? null) ? 'is-active-token' : ''}`.trim()}
        data-token-start={lineOffset}
        data-token-length={block.length}
      ></span>
      <span
        className="code-fence-source"
        data-token-start={lineOffset}
        data-token-length={block.length}
      >
        {block.raw}
      </span>
    </div>
  );
}

function MathBlock({
  block,
  index,
  lineOffset,
  store,
}: BlockRendererComponentProps) {
  // R3-C 流式软渲染：math fence 未闭合期间不调用 KaTeX renderToString
  //（CPU 重，流式每帧重渲染会积压开销），显示源文本 + 等宽样式；
  // 闭合后 codeBlockState 尾部出现 math_fence_end，本分支自然切回
  // KaTeX 硬渲染（同一 AST 软/硬开关，05 分析「同一 AST 软/硬渲染」）。
  const softRender = useSoftRender(index, store);
  if (softRender) {
    return (
      <div className="line-block line-math-block line-code is-soft-render">
        <span
          className="math-soft-text"
          data-token-start={lineOffset}
          data-token-length={block.length}
        >
          {block.raw}
        </span>
      </div>
    );
  }
  let formula = block.raw.trim();
  let bMatch;
  while ((bMatch = formula.match(/^\s*>\s?/))) {
    formula = formula.substring(bMatch[0].length);
  }
  formula = formula.trim();
  const katexHtml = renderMathToHtml(formula, true);
  return (
    <div className="line-block line-math-block">
      <div
        className="math-block-rendered"
        dangerouslySetInnerHTML={{ __html: katexHtml }}
        data-token-start={lineOffset}
        data-token-length={block.length}
      />
      <div
        className="math-block-source"
        data-token-start={lineOffset}
        data-token-length={block.length}
      >
        {block.raw}
      </div>
      {/* B4 N5：公式复制按钮——LaTeX 源 = math token raw（行原文） */}
      <CopyButton
        dataAttr="math"
        label="复制公式 LaTeX 源"
        onClick={() => {
          void copyTextToClipboard(block.raw);
        }}
      />
    </div>
  );
}

function CodeBlock({
  block,
  index,
  lineOffset,
  activeState,
  store,
}: BlockRendererComponentProps) {
  // R3-C 流式软渲染：fence 未闭合期间代码行不跑启发式 token 高亮
  //（parseCodeLine 的 keyword/comment/string），渲染等宽原文 + 轻
  // 高亮（line-code 等宽样式），避免「半块突然变色」的视觉跳变；
  // 闭合后 fence_end 出现，本分支自然走常规路径（无需显式切换，
  // 状态由 codeBlockState 驱动）。
  const softRender = useSoftRender(index, store);
  // B4：围栏上下文（lang/内容区间/首行锚点）——未闭合或缩进代码为 null
  const fenceCtx = useFenceContext(index, store);
  if (softRender) {
    return (
      <div className="line-block line-code is-soft-render">
        <span
          className="code-soft-text"
          data-token-start={lineOffset}
          data-token-length={block.length}
        >
          {block.raw}
        </span>
      </div>
    );
  }

  // 复制按钮：仅 fence 首条内容行锚点（块顶右上角，整块 raw 内容复制）
  const copyButton =
    fenceCtx && fenceCtx.isFirstContentLine ? (
      <CopyButton
        dataAttr="code"
        label={`复制代码块（${fenceCtx.lang}）`}
        onClick={() => {
          const s = (store ?? useEditorStore).getState();
          const lines: string[] = [];
          for (let i = fenceCtx.contentStart; i < fenceCtx.contentEnd; i++) {
            lines.push(stripBlockquotePrefix(s.getLine(i)));
          }
          void copyTextToClipboard(lines.join('\n'));
        }}
      />
    ) : null;

  // B4 N4：fence lang 分发——注册的 lang 走专用渲染器（工具产物渲染），
  // 未注册 lang 走默认代码渲染（InlineRenderer token 高亮）
  const LangRenderer = fenceCtx ? resolveFenceLangRenderer(fenceCtx.lang) : null;
  if (LangRenderer && fenceCtx) {
    const s = (store ?? useEditorStore).getState();
    const lines: string[] = [];
    for (let i = fenceCtx.contentStart; i < fenceCtx.contentEnd; i++) {
      lines.push(stripBlockquotePrefix(s.getLine(i)));
    }
    return (
      <div
        className="line-block line-code"
        data-fence-lang={fenceCtx.lang}
      >
        <LangRenderer
          lang={fenceCtx.lang}
          lines={lines}
          lineIndex={index - fenceCtx.contentStart}
          lineText={stripBlockquotePrefix(block.raw)}
          lineOffset={lineOffset}
        />
        {copyButton}
      </div>
    );
  }

  return (
    <div className="line-block line-code">
      {block.inlineTokens && block.inlineTokens.length > 0 ? (
        <InlineRenderer
          tokens={block.inlineTokens}
          lineOffset={lineOffset}
          activeState={activeState}
        />
      ) : (
        <br />
      )}
      {copyButton}
    </div>
  );
}

function HeadingBlock({
  block,
  lineOffset,
  activeState,
  rtl,
}: BlockRendererComponentProps) {
  const level = block.headingLevel || 1;
  const className = `line-block line-h${level}`;
  return (
    // B5 bidi：整行 RTL（标题行级 dir——isRtlLine 对含前缀的整行检测，
    // 标题前缀 # 为 ASCII，不影响 RTL 判定；LTR 行无 dir 属性）
    <div className={className} dir={rtl ? 'rtl' : undefined}>
      {block.inlineTokens && (
        <InlineRenderer
          tokens={block.inlineTokens}
          lineOffset={lineOffset}
          activeState={activeState}
        />
      )}
    </div>
  );
}

function HrBlock({ block, lineOffset, activeState }: BlockRendererComponentProps) {
  return (
    <div className="line-block line-hr">
      <hr
        className={`hr-rendered ${checkIsActive(lineOffset, block.length, activeState ?? null) ? 'is-active-token' : ''}`.trim()}
        data-token-start={lineOffset}
        data-token-length={block.length}
      />
      <span
        className="hr-source"
        data-token-start={lineOffset}
        data-token-length={block.length}
      >
        {block.raw}
      </span>
    </div>
  );
}

function BlockquoteBlock({
  block,
  lineOffset,
  activeState,
  rtl,
}: BlockRendererComponentProps) {
  const prefixMatch = block.raw.match(/^(>\s?)+/);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  return (
    <div className="line-block line-blockquote">
      <span
        className="blockquote-source"
        data-token-start={lineOffset}
        data-token-length={prefix.length}
      >
        {prefix}
      </span>
      {/* B5 bidi：blockquote 内容级 RTL——dir 落在渲染体 span（前缀
          语法保持 LTR 排版；整行检测与内容检测等价——前缀为 ASCII，
          内容含 RTL 字符时整行必命中，内容纯 LTR 时整行不命中） */}
      <span className="blockquote-rendered" dir={rtl ? 'rtl' : undefined}>
        {block.inlineTokens && block.inlineTokens.length > 0 ? (
          <InlineRenderer
            tokens={block.inlineTokens}
            lineOffset={lineOffset}
            activeState={activeState}
          />
        ) : (
          <br />
        )}
      </span>
    </div>
  );
}

function TableSeparatorBlock({
  block,
  lineOffset,
  activeState,
}: BlockRendererComponentProps) {
  return (
    <div className="line-table">
      <div
        className="line-table-separator"
        data-token-start={lineOffset}
        data-token-length={block.length}
      >
        {block.inlineTokens && (
          <InlineRenderer
            tokens={block.inlineTokens}
            lineOffset={lineOffset}
            activeState={activeState}
          />
        )}
      </div>
    </div>
  );
}

function TableRowBlock({
  block,
  index,
  lineOffset,
  activeState,
  tableId,
}: BlockRendererComponentProps) {
  const isHeaderRow = tableId === `table-${index}`;
  return (
    <div className="line-table">
      <div
        className={`line-table-row ${isHeaderRow ? 'table-header-row' : ''}`}
      >
        {block.inlineTokens && (
          <InlineRenderer
            tokens={block.inlineTokens}
            lineOffset={lineOffset}
            activeState={activeState}
            tableId={tableId}
            lineIndex={index}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 兜底默认渲染器（body 行语义 + 超长行截断）。原 switch 的
 * `case 'body': default:` 合并分支逐字提取——未知/未注册的
 * LineType（含 html_block）走此分支，行为与迁移前一致。
 */
export const DefaultBlockRenderer = function DefaultBlockRenderer({
  block,
  lineOffset,
  activeState,
  rtl,
}: BlockRendererComponentProps) {
  // 列表缩进接线：统一使用每空格 8px 的缩进率（4空格=32px）。这样既更深，也确保对齐。
  const baseIndentPx = Math.min(block.listIndent || 0, 12) * 8;
  const indentStyle: React.CSSProperties | undefined = block.listIndent
    ? { paddingLeft: `${baseIndentPx}px` }
    : undefined;

  if (block.listIndent && block.listIndent >= 2 && indentStyle) {
    // 符号 min-width 是 16px，因此中心在 8px 处。周期设为 32px (对应4空格缩进)。
    indentStyle.backgroundImage = `repeating-linear-gradient(to right, transparent 0, transparent 7px, hsl(0 0% 70% / 0.3) 7px, hsl(0 0% 70% / 0.3) 9px, transparent 9px, transparent 32px)`;
    indentStyle.backgroundSize = `${baseIndentPx}px 100%`;
    indentStyle.backgroundRepeat = 'no-repeat';
  }

  let tokensToRender = block.inlineTokens || [];
  let isTruncated = false;
  let truncatedLength = 0;

  if (block.raw.length > MAX_VISIBLE_LINE_CHARS) {
    isTruncated = true;
    truncatedLength = block.raw.length - MAX_VISIBLE_LINE_CHARS;
    tokensToRender = truncateTokens(
      tokensToRender,
      MAX_VISIBLE_LINE_CHARS
    );
  }

  return (
    // B5 bidi：整行级 RTL（body/列表/未知类型行统一落点——行级
    // dir 使 InlineRenderer 全部 token 继承 RTL 排版；LTR 行不设
    // dir 属性，行为零变化）
    <div className="line-block" style={indentStyle} dir={rtl ? 'rtl' : undefined}>
      {tokensToRender && tokensToRender.length > 0 ? (
        <>
          <InlineRenderer
            tokens={tokensToRender}
            lineOffset={lineOffset}
            activeState={activeState}
          />
          {isTruncated && (
            <span className="truncation-indicator" data-ignore-measure>
              ⋯ 已折叠 {truncatedLength} 字符
            </span>
          )}
        </>
      ) : (
        <br />
      )}
    </div>
  );
};

// —— 默认注册表：核心 12 类型（原 switch 全部显式分支）——
// 同步写入 defaultRenderers 快照（unregister 恢复出厂依据）
function registerDefault(type: LineType, renderer: BlockRendererComponent): void {
  BlockRendererRegistry.set(type, renderer);
  defaultRenderers.set(type, renderer);
}

registerDefault('empty', EmptyBlock);
registerDefault('code_fence_start', CodeFenceStartBlock);
registerDefault('code_fence_end', CodeFenceEndBlock);
registerDefault('math_fence_start', MathFenceStartBlock);
registerDefault('math_fence_end', MathFenceEndBlock);
registerDefault('math_block', MathBlock);
registerDefault('code', CodeBlock);
registerDefault('heading', HeadingBlock);
registerDefault('hr', HrBlock);
registerDefault('blockquote', BlockquoteBlock);
registerDefault('table_separator', TableSeparatorBlock);
registerDefault('table_row', TableRowBlock);

/** BlockRenderer props（对外签名扩展：新增可选 store，缺省行为零变化） */
interface BlockRendererProps {
  block: LineNode;
  index: number;
  lineOffset: number;
  activeState?: ActiveState | null;
  tableId?: string;
  store?: EditorStore;
}

/**
 * 块渲染入口（R5-C）：注册表查表 + 未知类型兜底。
 * 行为与迁移前 switch 完全一致：12 个核心类型命中默认注册表，
 * 其余（body/html_block/自定义未注册类型）走 DefaultBlockRenderer。
 */
export const BlockRenderer = memo(
  ({ block, index, lineOffset, activeState, tableId, store }: BlockRendererProps) => {
    const Renderer = resolveBlockRenderer(block.type);
    // B5 bidi：memo 顶层计算一次行级 RTL（行文本不变 → memo 命中 →
    // 不重算；结果并入行渲染 props 供各渲染器消费）
    const rtl = isRtlLine(block.raw);
    return (
      <Renderer
        block={block}
        index={index}
        lineOffset={lineOffset}
        activeState={activeState}
        tableId={tableId}
        rtl={rtl}
        store={store}
      />
    );
  }
);
