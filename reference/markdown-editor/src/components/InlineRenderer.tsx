import * as React from 'react';
import type { InlineNode } from '../core/ast';
import katex from 'katex';

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

interface InlineRendererProps {
  tokens: InlineNode[];
  lineOffset: number;
}

export const InlineRenderer: React.FC<InlineRendererProps> = React.memo(
  ({ tokens, lineOffset }) => {
    return (
      <>
        {tokens.map((token, index) => {
          const key = `${token.type}-${index}`;
          const start = lineOffset + token.localOffset;
          const len = token.length;

          let className = '';
          switch (token.type) {
            case 'heading_prefix':
              className = 'token-heading-prefix';
              break;
            case 'list_bullet':
              className = 'token-list-bullet';
              break;
            case 'list_number':
              className = 'token-list-number';
              break;
            case 'list_task':
              className = 'interactive-checkbox token-list-task';
              break;
            case 'comment':
              className = 'token-comment';
              break;
            case 'string':
              className = 'token-string';
              break;
            case 'keyword':
              className = 'token-keyword';
              break;
            case 'bold':
              className = 'style-bold';
              break;
            case 'italic':
              className = 'style-italic';
              break;
            case 'bold_italic':
              className = 'style-bold-italic';
              break;
            case 'strike':
              className = 'style-strike';
              break;
            case 'code':
              className = 'style-inline-code';
              break;
            case 'mark':
              className = 'style-mark';
              break;
            case 'sub':
              className = 'style-sub';
              break;
            case 'sup':
              className = 'style-sup';
              break;
            case 'kbd':
              className = 'style-kbd';
              break;
            case 'spoiler':
              className = 'style-spoiler';
              break;
            case 'footnote':
              className = 'style-footnote';
              break;
            case 'math':
              className = 'style-math';
              break;
            case 'link':
              className = 'interactive-link';
              break;
            case 'image':
              className = 'style-image';
              break;
            case 'checkbox':
              className = 'interactive-checkbox style-checkbox';
              break;
            case 'html_element': {
              let tagClass = 'token-html-element';
              const tag = (token.tagName || '').toLowerCase();
              if (tag === 'sub') tagClass += ' style-sub';
              else if (tag === 'sup') tagClass += ' style-sup';
              else if (tag === 'kbd') tagClass += ' style-kbd';
              else if (tag === 'b' || tag === 'strong')
                tagClass += ' style-bold';
              else if (tag === 'i' || tag === 'em') tagClass += ' style-italic';
              else if (tag === 's' || tag === 'del' || tag === 'strike')
                tagClass += ' style-strike';
              else if (tag === 'mark') tagClass += ' style-mark';
              else if (tag === 'code') tagClass += ' style-inline-code';
              className = tagClass;
              break;
            }

            case 'text':
            default:
              break;
          }

          // If a styling token is completely empty of visible content (e.g. **** or ** **),
          // we want to ensure it remains physically clickable/visible so the user can type inside it.
          const isStyleToken = [
            'bold',
            'italic',
            'bold_italic',
            'strike',
            'code',
            'mark',
            'sub',
            'sup',
            'kbd',
            'spoiler',
            'math',
            'link',
            'image',
            'html_element',
          ].includes(token.type);
          const hasNoChildren = !token.children || token.children.length === 0;
          const isEmpty =
            isStyleToken &&
            hasNoChildren &&
            (!token.content || token.content.trim() === '');
          const finalClassName = isEmpty
            ? `${className} is-empty-token`
            : className;

          // Specialized KaTeX rendering for math formulas
          if (token.type === 'math') {
            const isDisplay = token.raw.startsWith('$$');
            const formula = token.content || '';
            const katexHtml = renderMathToHtml(formula, isDisplay);
            const prefix = isDisplay ? '$$' : '$';
            const suffix = isDisplay ? '$$' : '$';

            return (
              <span
                key={key}
                data-token-start={start}
                data-token-length={len}
                className={`${finalClassName} token-math-wrapper`}
                style={token.style}
              >
                <span
                  className="math-preview"
                  dangerouslySetInnerHTML={{ __html: katexHtml }}
                />
                <span data-sub-offset={0} className="math-source syntax-hidden">
                  <span className="syntax-delimiter">{prefix}</span>
                  <span
                    data-sub-offset={prefix.length}
                    className="token-content"
                  >
                    {formula}
                  </span>
                  <span
                    data-sub-offset={prefix.length + formula.length}
                    className="syntax-delimiter"
                  >
                    {suffix}
                  </span>
                </span>
              </span>
            );
          }

          // If it's a token with `content` different from `raw`
          if (token.content !== undefined && token.content !== token.raw) {
            const prefixLen = token.raw.indexOf(token.content);
            if (prefixLen >= 0 && token.content !== '') {
              // Substring case (e.g. **bold**)
              const prefix = token.raw.substring(0, prefixLen);
              const suffix = token.raw.substring(
                prefixLen + token.content.length
              );
              return (
                <span
                  key={key}
                  data-token-start={start}
                  data-token-length={len}
                  className={finalClassName}
                  style={token.style}
                >
                  {prefix && (
                    <span data-sub-offset={0} className="syntax-hidden">
                      {prefix}
                    </span>
                  )}
                  <span data-sub-offset={prefixLen}>
                    {token.children ? (
                      <InlineRenderer
                        tokens={token.children}
                        lineOffset={lineOffset}
                      />
                    ) : (
                      token.content
                    )}
                  </span>
                  {suffix && (
                    <span
                      data-sub-offset={prefixLen + token.content.length}
                      className="syntax-hidden"
                    >
                      {suffix}
                    </span>
                  )}
                </span>
              );
            } else {
              // Complete replacement case (e.g. list_bullet "- " -> "• ", or heading_prefix "## " -> "")
              return (
                <span
                  key={key}
                  data-token-start={start}
                  data-token-length={len}
                  className={finalClassName}
                  style={token.style}
                >
                  <span data-sub-offset={0} className="syntax-hidden">
                    {token.raw}
                  </span>
                  <span className="syntax-content">{token.content}</span>
                </span>
              );
            }
          }

          return (
            <span
              key={key}
              data-token-start={start}
              data-token-length={len}
              className={finalClassName}
              style={token.style}
            >
              {token.raw}
            </span>
          );
        })}
      </>
    );
  }
);
