import * as React from 'react';
import type { InlineNode } from '../core/ast';

interface InlineRendererProps {
    tokens: InlineNode[];
}

export const InlineRenderer: React.FC<InlineRendererProps> = React.memo(({ tokens }) => {
    return (
        <>
            {tokens.map((token, index) => {
                const key = `${token.type}-${index}`;
                const start = token.startIndex;
                const len = token.length;
                
                let className = '';
                switch (token.type) {
                    case 'heading_prefix': className = "token-heading-prefix"; break;
                    case 'list_bullet': className = "token-list-bullet"; break;
                    case 'list_number': className = "token-list-number"; break;
                    case 'list_task': className = "interactive-checkbox token-list-task"; break;
                    case 'comment': className = "token-comment"; break;
                    case 'string': className = "token-string"; break;
                    case 'keyword': className = "token-keyword"; break;
                    case 'bold': className = "style-bold"; break;
                    case 'italic': className = "style-italic"; break;
                    case 'bold_italic': className = "style-bold-italic"; break;
                    case 'strike': className = "style-strike"; break;
                    case 'code': className = "style-inline-code"; break;
                    case 'mark': className = "style-mark"; break;
                    case 'sub': className = "style-sub"; break;
                    case 'sup': className = "style-sup"; break;
                    case 'kbd': className = "style-kbd"; break;
                    case 'spoiler': className = "style-spoiler"; break;
                    case 'footnote': className = "style-footnote"; break;
                    case 'math': className = "style-math"; break;
                    case 'link': className = "interactive-link"; break;
                    case 'image': className = "style-image"; break;
                    case 'checkbox': className = "interactive-checkbox style-checkbox"; break;
                    case 'text':
                    default:
                        break;
                }

                // If it's a token with `content` different from `raw`
                if (token.content !== undefined && token.content !== token.raw) {
                    const prefixLen = token.raw.indexOf(token.content);
                    if (prefixLen >= 0 && token.content !== '') {
                        // Substring case (e.g. **bold**)
                        const prefix = token.raw.substring(0, prefixLen);
                        const suffix = token.raw.substring(prefixLen + token.content.length);
                        return (
                            <span key={key} data-token-start={start} data-token-length={len} className={className}>
                                {prefix && <span data-sub-offset={0} className="syntax-hidden">{prefix}</span>}
                                <span data-sub-offset={prefixLen}>
                                    {token.children ? <InlineRenderer tokens={token.children} /> : token.content}
                                </span>
                                {suffix && <span data-sub-offset={prefixLen + token.content.length} className="syntax-hidden">{suffix}</span>}
                            </span>
                        );
                    } else {
                        // Complete replacement case (e.g. list_bullet "- " -> "• ", or heading_prefix "## " -> "")
                        return (
                            <span key={key} data-token-start={start} data-token-length={len} className={className}>
                                <span data-sub-offset={0} className="syntax-hidden">{token.raw}</span>
                                <span className="syntax-content">{token.content}</span>
                            </span>
                        );
                    }
                }

                return (
                    <span key={key} data-token-start={start} data-token-length={len} className={className}>
                        {token.raw}
                    </span>
                );
            })}
        </>
    );
});
