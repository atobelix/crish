export type LineType = 
    | 'body'
    | 'heading'
    | 'code'
    | 'empty'
    | 'hr'
    | 'blockquote'
    | 'code_fence_start'
    | 'code_fence_end'
    | 'math_fence_start'
    | 'math_fence_end'
    | 'math_block'
    | 'table_row'
    | 'table_separator';

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
    | 'keyword'
    | 'html_element'
    | 'table_pipe'
    | 'table_cell';

export interface InlineNode {
    type: InlineType;
    raw: string;
    content: string;
    url?: string;
    isChecked?: boolean;
    children?: InlineNode[];
    localOffset: number;
    length: number;
    tagName?: string;
    attributes?: Record<string, string>;
    style?: Record<string, any>;
}

export interface LineNode {
    id: string;
    type: LineType;
    raw: string;
    content?: string;
    headingLevel?: number;
    listIndent?: number;
    listPrefix?: string;
    inlineTokens: InlineNode[];
    length: number;
    localOffset: number;
}

export interface MarkdownDocument {
    lines: LineNode[];
}
