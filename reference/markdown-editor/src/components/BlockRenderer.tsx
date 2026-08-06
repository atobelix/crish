import { memo } from 'react';
import type { LineNode } from '../core/ast';
import { InlineRenderer } from './InlineRenderer';
import katex from 'katex';

function renderMathToHtml(formula: string, displayMode: boolean = true): string {
    if (!formula) return '';
    try {
        return katex.renderToString(formula, {
            throwOnError: false,
            displayMode
        });
    } catch {
        return formula;
    }
}

interface BlockRendererProps {
    block: LineNode;
    index: number;
}

export const BlockRenderer = memo(({ block }: BlockRendererProps) => {
    switch (block.type) {
        case 'empty':
            return <div className="line-block"><br/></div>;
            
        case 'code_fence_start': {
            const lang = block.raw.trim().replace(/^```+/, '').trim() || 'code';
            return (
                <div className="line-block line-code-fence line-code-fence-start">
                    <span className="code-fence-rendered">
                        <span className="code-lang-pill">{lang}</span>
                    </span>
                    <span className="code-fence-source" data-token-start={block.startIndex} data-token-length={block.length}>
                        {block.raw}
                    </span>
                </div>
            );
        }
            
        case 'code_fence_end':
            return (
                <div className="line-block line-code-fence line-code-fence-end">
                    <span className="code-fence-rendered"></span>
                    <span className="code-fence-source" data-token-start={block.startIndex} data-token-length={block.length}>
                        {block.raw}
                    </span>
                </div>
            );

        case 'math_fence_start':
            return (
                <div className="line-block line-code-fence line-code-fence-start">
                    <span className="code-fence-rendered">
                        <span className="code-lang-pill">MATH</span>
                    </span>
                    <span className="code-fence-source" data-token-start={block.startIndex} data-token-length={block.length}>
                        {block.raw}
                    </span>
                </div>
            );

        case 'math_fence_end':
            return (
                <div className="line-block line-code-fence line-code-fence-end">
                    <span className="code-fence-rendered"></span>
                    <span className="code-fence-source" data-token-start={block.startIndex} data-token-length={block.length}>
                        {block.raw}
                    </span>
                </div>
            );

        case 'math_block': {
            const formula = block.raw.trim();
            const katexHtml = renderMathToHtml(formula, true);
            return (
                <div className="line-block line-math-block">
                    <div className="math-block-rendered" dangerouslySetInnerHTML={{ __html: katexHtml }} />
                    <div className="math-block-source" data-token-start={block.startIndex} data-token-length={block.length}>
                        {block.raw}
                    </div>
                </div>
            );
        }

        case 'code':
            return (
                <div className="line-block line-code">
                    {block.inlineTokens && block.inlineTokens.length > 0 ? (
                        <InlineRenderer tokens={block.inlineTokens} />
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
                    {block.inlineTokens && <InlineRenderer tokens={block.inlineTokens} />}
                </div>
            );
        }
            
        case 'hr':
            return (
                <div className="line-block line-hr">
                    <hr className="hr-rendered" />
                    <span className="hr-source" data-token-start={block.startIndex} data-token-length={block.length}>{block.raw}</span>
                </div>
            );
            
        case 'blockquote': {
            const prefixMatch = block.raw.match(/^(>\s?)+/);
            const prefix = prefixMatch ? prefixMatch[0] : '';
            return (
                <div className="line-block line-blockquote">
                    <span className="blockquote-source" data-token-start={block.startIndex} data-token-length={prefix.length}>{prefix}</span>
                    <span className="blockquote-rendered">
                        {block.inlineTokens && block.inlineTokens.length > 0 ? (
                            <InlineRenderer tokens={block.inlineTokens} />
                        ) : (
                            <br />
                        )}
                    </span>
                </div>
            );
        }
            
        case 'table_separator':
            return (
                <div className="line-block line-table-separator" style={{ opacity: 0.5 }}>
                    <span data-token-start={block.startIndex} data-token-length={block.length}>{block.raw}</span>
                </div>
            );
            
        case 'table_row':
        case 'table_header':
            return (
                <div className="line-block line-table-row" style={{ display: 'flex', borderBottom: '1px solid var(--border-color)' }}>
                    {block.inlineTokens && block.inlineTokens.length > 0 ? (
                        <InlineRenderer tokens={block.inlineTokens} />
                    ) : (
                        <br />
                    )}
                </div>
            );
            
        case 'body':
        default:
            return (
                <div className="line-block line-body">
                    {block.inlineTokens && block.inlineTokens.length > 0 ? (
                        <InlineRenderer tokens={block.inlineTokens} />
                    ) : (
                        <br />
                    )}
                </div>
            );
    }
}, (prev, next) => {
    return prev.block.raw === next.block.raw &&
           prev.block.type === next.block.type &&
           prev.block.startIndex === next.block.startIndex &&
           prev.index === next.index;
});
