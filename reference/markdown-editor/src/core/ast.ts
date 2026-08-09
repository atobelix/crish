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
    | 'table_separator'
    // HTML 块（02 §2.5 / R1-D）：CommonMark 7 类 HTML 块（type 1-7）的行——
    // 块内行按 raw 原样透传、不解析 markdown，与代码行同构的跨行块状态。
    | 'html_block';

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
    // HTML 块内容行内 token（R1-D）：raw = 行原文，渲染层原样透传——
    // 与 html_element/html_tag 的行内语义同族，但属于块级早退产物（不解析）。
    | 'html'
    | 'table_pipe'
    | 'table_cell'
    | 'blockquote_prefix';

export interface InlineNode {
    type: InlineType;
    raw: string;
    content: string;
    indent?: string;
    marker?: string;
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
    blockquoteLevel?: number;
    listIndent?: number;
    listPrefix?: string;
    inlineTokens: InlineNode[];
    length: number;
    localOffset: number;
}

export interface MarkdownDocument {
    lines: LineNode[];
}
