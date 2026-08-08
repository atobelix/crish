import { memo } from 'react';
import katex from 'katex';
import type { LineNode, InlineNode } from '../core/ast';
import { checkIsActive, type ActiveState } from '../core/measure';
import { InlineRenderer } from './InlineRenderer';

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

export const BlockRenderer = memo(
  ({ block, index, lineOffset, activeState, tableId }: BlockRendererProps) => {
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
          <div
            className="line-block line-table-separator"
          >
            {block.inlineTokens && block.inlineTokens.length > 0 ? (
              <InlineRenderer
                tokens={block.inlineTokens}
                lineOffset={lineOffset}
                activeState={activeState}
                tableId={tableId}
                lineIndex={index}
              />
            ) : (
              <span
                data-token-start={lineOffset}
                data-token-length={block.length}
              >
                {block.raw}
              </span>
            )}
          </div>
        );

      case 'table_row': {
        const isHeaderRow = tableId === `table-${index}`;
        return (
          <div
            className={`line-block line-table-row ${isHeaderRow ? 'table-header-row' : ''}`}
          >
            {block.inlineTokens && block.inlineTokens.length > 0 ? (
              <InlineRenderer
                tokens={block.inlineTokens}
                lineOffset={lineOffset}
                activeState={activeState}
                tableId={tableId}
                lineIndex={index}
              />
            ) : (
              <br />
            )}
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
