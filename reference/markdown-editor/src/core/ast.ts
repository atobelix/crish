export type LineType = 
    | 'body'
    | 'heading'
    | 'code'
    | 'empty'
    | 'hr'
    | 'blockquote';

export type InlineType = 
    | 'text' 
    | 'bold' 
    | 'italic' 
    | 'bold_italic'
    | 'strike' 
    | 'code' 
    | 'link' 
    | 'image' 
    | 'math' 
    | 'mark'
    | 'kbd'
    | 'sub'
    | 'sup'
    | 'checkbox'
    | 'spoiler'
    | 'footnote'
    | 'heading_prefix'
    | 'list_bullet'
    | 'list_number'
    | 'list_task'
    | 'comment'
    | 'string'
    | 'keyword';

export interface InlineNode {
    type: InlineType;
    raw: string;
    content: string;
    url?: string;
    isChecked?: boolean;
    children?: InlineNode[];
    localOffset: number;
    length: number;
}

export interface LineNode {
    id: string;
    type: LineType;
    raw: string;
    headingLevel?: number;
    inlineTokens: InlineNode[];
    length: number;
}

export interface MarkdownDocument {
    lines: LineNode[];
}
