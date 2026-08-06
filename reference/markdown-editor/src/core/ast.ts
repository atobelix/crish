export type LineType = 
    | 'body'
    | 'heading'
    | 'code'
    | 'code_fence_start'
    | 'code_fence_end'
    | 'math_fence_start'
    | 'math_fence_end'
    | 'math_block'
    | 'hr'
    | 'blockquote'
    | 'table_row'
    | 'table_header'
    | 'table_separator'
    | 'empty';

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
    | 'html_tag';

export interface InlineNode {
    type: InlineType;
    raw: string;
    content: string;
    url?: string;
    isChecked?: boolean;
    children?: InlineNode[];
    startIndex: number;
    length: number;
    tagName?: string;
    attributes?: Record<string, string>;
    style?: React.CSSProperties;
}

export type Alignment = 'left' | 'center' | 'right' | null;

export interface TableCellNode {
    align: Alignment;
    tokens: InlineNode[];
    raw: string;
}

export interface LineNode {
    id: string;
    type: LineType;
    raw: string;
    headingLevel?: number;
    inlineTokens: InlineNode[];
    startIndex: number;
    length: number;
    
    // Block context metadata
    listIndent?: number;
    listPrefix?: string;
    
    // Table context
    tableCells?: TableCellNode[];
    tableAlignments?: Alignment[];
}

export interface MarkdownDocument {
    lines: LineNode[];
}
