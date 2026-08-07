import { memo } from 'react';
import katex from 'katex';
import type { LineNode } from '../core/ast';
import { InlineRenderer } from './InlineRenderer';

interface BlockRendererProps {
  block: LineNode;
  index: number;
  lineOffset: number;
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
  ({ block, lineOffset }: BlockRendererProps) => {
    switch (block.type) {
      case 'empty':
        return (
          <div className="line-block">
            <br />
          </div>
        );

      case 'code_fence_start': {
        const lang = block.raw.trim().replace(/^```+/, '').trim() || 'code';
        return (
          <div className="line-block line-code-fence line-code-fence-start">
            <span
              className="code-fence-rendered"
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
              className="code-fence-rendered"
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
              className="code-lang-pill code-fence-rendered"
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
              className="code-fence-rendered"
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
        const formula = block.raw.trim();
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
              />
            )}
          </div>
        );
      }

      case 'hr':
        return (
          <div className="line-block line-hr">
            <hr
              className="hr-rendered"
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
            style={{ opacity: 0.5 }}
          >
            <span
              data-token-start={lineOffset}
              data-token-length={block.length}
            >
              {block.raw}
            </span>
          </div>
        );

      case 'table_row':
        return (
          <div
            className="line-block line-table-row"
            style={{
              display: 'flex',
              borderBottom: '1px solid var(--border-color)',
            }}
          >
            {block.inlineTokens && block.inlineTokens.length > 0 ? (
              <InlineRenderer
                tokens={block.inlineTokens}
                lineOffset={lineOffset}
              />
            ) : (
              <br />
            )}
          </div>
        );

      case 'body':
      default: {
        // 列表缩进接线：listIndent 以 padding-left 语义渲染（wrap 续行正确对齐）
        const indentStyle: React.CSSProperties | undefined = block.listIndent
          ? { paddingLeft: `${Math.min(block.listIndent, 8) * 6}px` }
          : undefined;
        return (
          <div className="line-block" style={indentStyle}>
            {block.inlineTokens && block.inlineTokens.length > 0 ? (
              <InlineRenderer
                tokens={block.inlineTokens}
                lineOffset={lineOffset}
              />
            ) : (
              <br />
            )}
          </div>
        );
      }
    }
  }
);
