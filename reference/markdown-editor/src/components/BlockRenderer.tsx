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
import { memo } from 'react';
import type { LineNode, InlineNode, LineType } from '../core/ast';
import type { CodeState } from '../core/parser';
import { checkIsActive, type ActiveState } from '../core/measure';
import { InlineRenderer } from './InlineRenderer';
import { useEditorStore, type EditorStore } from '../core/EditorStore';
import { renderMathToHtml } from '../core/renderTheme';

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
  const getState = (i: number): CodeState =>
    i < boundary ? mainCodeState[i] : tailCodeState[i - boundary];
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

function EmptyBlock(_: BlockRendererComponentProps) {
  return (
    <div className="line-block">
      <br />
    </div>
  );
}

function CodeFenceStartBlock({
  block,
  lineOffset,
  activeState,
}: BlockRendererComponentProps) {
  let rawCodeText = block.raw.trim();
  let bMatch;
  while ((bMatch = rawCodeText.match(/^\s*>\s?/))) {
    rawCodeText = rawCodeText.substring(bMatch[0].length);
  }
  rawCodeText = rawCodeText.trim();
  const lang = rawCodeText.replace(/^```+/, '').trim() || 'code';
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
    </div>
  );
}

function HeadingBlock({
  block,
  lineOffset,
  activeState,
}: BlockRendererComponentProps) {
  const level = block.headingLevel || 1;
  const className = `line-block line-h${level}`;
  return (
    <div className={className}>
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
      <span className="blockquote-rendered">
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
    <div className="line-block" style={indentStyle}>
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
    return (
      <Renderer
        block={block}
        index={index}
        lineOffset={lineOffset}
        activeState={activeState}
        tableId={tableId}
        store={store}
      />
    );
  }
);
