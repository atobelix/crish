import { memo } from 'react';
import type { LineNode } from '../core/ast';
import { InlineRenderer } from './InlineRenderer';

interface BlockRendererProps {
    block: LineNode;
    index: number;
    lineOffset: number;
}

export const BlockRenderer = memo(({ block, lineOffset }: BlockRendererProps) => {
    switch (block.type) {
        case 'empty':
            return <div className="line-block"><br/></div>;
            
        case 'code':
            return (
                <div className="line-block line-code">
                    {block.inlineTokens && block.inlineTokens.length > 0 ? (
                        <InlineRenderer tokens={block.inlineTokens} lineOffset={lineOffset} />
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
                    {block.inlineTokens && <InlineRenderer tokens={block.inlineTokens} lineOffset={lineOffset} />}
                </div>
            );
        }
            
        case 'hr':
            return (
                <div className="line-block line-hr">
                    <hr className="hr-rendered" />
                    <span className="hr-source">{block.raw}</span>
                </div>
            );
            
        case 'blockquote':
            return (
                <div className="line-block line-blockquote">
                    <span className="blockquote-source">{block.raw.match(/^(>\s?)/)?.[0]}</span>
                    <span className="blockquote-rendered">
                        {block.inlineTokens && block.inlineTokens.length > 0 ? (
                            <InlineRenderer tokens={block.inlineTokens} lineOffset={lineOffset} />
                        ) : (
                            <br />
                        )}
                    </span>
                </div>
            );
            
        case 'body':
        default:
            return (
                <div className="line-block line-body">
                    {block.inlineTokens && block.inlineTokens.length > 0 ? (
                        <InlineRenderer tokens={block.inlineTokens} lineOffset={lineOffset} />
                    ) : (
                        <br />
                    )}
                </div>
            );
    }
});
