import { memo } from 'react';
import katex from 'katex';
import type { LineNode, InlineNode } from '../core/ast';
import type { CodeState } from '../core/parser';
import { checkIsActive, type ActiveState } from '../core/measure';
import { InlineRenderer } from './InlineRenderer';
import { useEditorStore } from '../core/EditorStore';

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

interface BlockRendererProps {
  block: LineNode;
  index: number;
  lineOffset: number;
  activeState?: ActiveState | null;
  tableId?: string;
}

function renderMathToHtml(
  formula: string,
  displayMode: boolean = false
): string {
  if (!formula) return '';
  try {
    return katex.renderToString(formula, {
      throwOnError: false,
      displayMode,
    });
  } catch {
    return formula;
  }
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
function isInUnclosedFence(
  lineIndex: number,
  codeBlockState: CodeState[],
  fenceLines: number[]
): boolean {
  const st = codeBlockState[lineIndex];
  if (st !== 'code' && st !== 'math_block') return false;
  const n = fenceLines.length;
  if (n === 0) return false;
  // 最后一个围栏边界的行状态：起始围栏 → 未闭合区间（从该行起至文档尾）
  const lastFenceState = codeBlockState[fenceLines[n - 1]];
  if (lastFenceState !== 'fence_start' && lastFenceState !== 'math_fence_start') {
    return false;
  }
  // 本行位于未闭合区间起点之后 → 属于未闭合区间（已闭合块内的行在此
  // 起点之前，不受影响——05 分析「fence_start 后无 fence_end 的区间」）
  return lineIndex > fenceLines[n - 1];
}

export const BlockRenderer = memo(
  ({ block, index, lineOffset, activeState, tableId }: BlockRendererProps) => {
    // 流式软渲染判定（R3-C）：订阅「本行是否位于未闭合围栏区间」。选择器
    // 返回布尔值——codeBlockState/fenceLines 引用变化但判定结果不变时，
    // zustand 按 Object.is 比较跳过重渲染，仅在软/硬渲染翻转时更新本行。
    const softRender = useEditorStore(state =>
      isInUnclosedFence(index, state.codeBlockState, state.fenceLines)
    );

    const content = (() => {
    switch (block.type) {
      case 'empty':
        return (
          <div className="line-block">
            <br />
          </div>
        );

      case 'code_fence_start': {
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

      case 'code_fence_end':
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

      case 'math_fence_start':
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

      case 'math_fence_end':
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

      case 'math_block': {
        // R3-C 流式软渲染：math fence 未闭合期间不调用 KaTeX renderToString
        //（CPU 重，流式每帧重渲染会积压开销），显示源文本 + 等宽样式；
        // 闭合后 codeBlockState 尾部出现 math_fence_end，本分支自然切回
        // KaTeX 硬渲染（同一 AST 软/硬开关，05 分析「同一 AST 软/硬渲染」）。
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

      case 'code':
        // R3-C 流式软渲染：fence 未闭合期间代码行不跑启发式 token 高亮
        //（parseCodeLine 的 keyword/comment/string），渲染等宽原文 + 轻
        // 高亮（line-code 等宽样式），避免「半块突然变色」的视觉跳变；
        // 闭合后 fence_end 出现，本分支自然走常规路径（无需显式切换，
        // 状态由 codeBlockState 驱动）。
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

      case 'heading': {
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

      case 'hr':
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

      case 'blockquote': {
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

      case 'table_separator':
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

      case 'table_row': {
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

      case 'body':
      default: {
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
      }
    }
    })();

    const isListItem = block.listPrefix !== undefined;
    const indentStyle = {
      '--logical-indent': block.listIndent ? `${block.listIndent * 1}ch` : '0ch',
      ...(isListItem ? {
        '--hanging-indent': block.listPrefix?.includes('[') ? '3.5ch' : '2.5ch'
      } : {})
    } as React.CSSProperties;

    const wrapperClass = `typography-wrapper ${isListItem ? 'is-list-item' : ''}`;

    if (block.blockquoteLevel && block.blockquoteLevel > 0) {
      return (
        <div className={`${wrapperClass} blockquote-wrapper`} style={indentStyle}>
          {Array.from({ length: block.blockquoteLevel }).map((_, i) => (
            <div key={i} className="blockquote-guide"></div>
          ))}
          <div className="blockquote-content">
            {content}
          </div>
        </div>
      );
    }

    return (
      <div className={wrapperClass} style={indentStyle}>
        {content}
      </div>
    );
  }
);
