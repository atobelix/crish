import type { ListMarkerOccurrence } from './layout/IndentModel';

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
    // 原始 HTML 标签行内 token：自闭合 / 孤立 / 闭合标签（CommonMark raw HTML
    // 逐字节透传语义，parser matchRawHtmlTag 单源判定产出）——渲染层原样输出，
    // <br> 形态由渲染层特判为真实换行。
    | 'html_tag'
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
    /** 内容在原始 token 中的起点和源码长度，由解析器提供，不由渲染器搜索。 */
    contentOffset?: number;
    contentSourceLength?: number;
    /** 每个显示边界对应的内容源码偏移；null 表示原子实体内部没有插入点。 */
    sourceBoundaries?: readonly (number | null)[];
    indent?: string;
    /**
     * 列表标记所在的**容器嵌套深度**（0 起，由 `ListContext` 容器栈产出）。
     * 渲染层缩进阶梯 = `depth * var(--indent-unit)` 的唯一输入——
     * 深度相同必得同宽，与源码缩进字符数、与邻行内容均无关（ADR-3）。
     */
    depth?: number;
    marker?: string;
    url?: string;
    isChecked?: boolean;
    children?: InlineNode[];
    localOffset: number;
    length: number;
    tagName?: string;
    attributes?: Record<string, string>;
    style?: Record<string, any>;
    colSpan?: number;
    rowSpan?: number;
    isMergedMaster?: boolean;
    isMergedSlave?: boolean;
    mergeType?: 'horizontal' | 'vertical';
}

export type CalloutType = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export interface LineNode {
    id: string;
    type: LineType;
    raw: string;
    content?: string;
    headingLevel?: number;
    blockquoteLevel?: number;
    calloutType?: CalloutType;
    calloutTitle?: string;
    isCalloutHeader?: boolean;
    // ── 列表归属（战役 wysiwyg-layout-remediation T3 / ADR-1 / ADR-2）──
    // 唯一缩进语义是**列宽**（tab 按停靠 4 展开，CommonMark §Tabs）——
    // 旧实现的 `listIndent`（字符数）已物理删除：以字符数表达缩进会让
    // 渲染层无法还原真实缩进量（实测 `\t- b` 渲染缩进 0px）。
    /** 列表标记本身（不含标记后空白），如 `-` / `1.` / `- [x]` */
    listPrefix?: string;
    /** 列表标记行的前导缩进列宽（仅 marker 行携带） */
    indentColumns?: number;
    /**
     * 本行所属列表容器的**内容缩进列**（CommonMark §5.2 content indent）——
     * marker 行与延续行都携带，供缩进代码块判定与投影层归属判定使用。
     */
    contentIndentColumns?: number;
    /**
     * 整数嵌套层级（0 起）——由 `ListContext` 容器栈产出，是渲染层缩进阶梯的
     * **唯一输入**。渲染层不再做任何缩进数值比较（旧实现 `listIndent > indent`
     * 会把 1 空格缩进的同级项误判为子列表）。
     */
    listDepth?: number;
    /** 本行实际打开的列表容器轨迹；紧凑列表可以包含多个层级。 */
    listMarkers?: readonly ListMarkerOccurrence[];
    /**
     * 列表项延续行：非标记行但归属列表项内容（spec 例 256/258/262/277）——
     * 投影器据此并入同一 `<li>` 的后续块（普通 body 行为 undefined）。
     */
    listContinuation?: boolean;
    inlineTokens: InlineNode[];
    length: number;
    localOffset: number;
}

export interface MarkdownDocument {
    lines: LineNode[];
}
