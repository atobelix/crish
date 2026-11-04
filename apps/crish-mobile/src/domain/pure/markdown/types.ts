// 移动端 markdown 自有 AST（MD1)：解析器（markdown-it）的 token 只在本层被
// 映射为 MdBlock / MdSpan，presentation 层永不接触解析器类型——将来换解析器
// 只动 domain/pure/markdown 一层，渲染组件与样式口径不变。

/** 行内片段：段落 / 标题 / 表格单元格 / 列表项正文的最小呈现单位 */
export type MdSpan =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: MdSpan[] }
  | { type: 'em'; children: MdSpan[] }
  | { type: 'del'; children: MdSpan[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: MdSpan[] }
  /** 行内图片：v1 不加载远程图，呈现层出占位（图片标 + alt，审计 C.6) */
  | { type: 'image'; src: string; alt: string }
  /** 断行（breaks 口径：单个 \n 即断行，与聊天文本习惯一致） */
  | { type: 'break' };

export interface MdListItem {
  /** 任务列表勾选态：null = 普通列表项；true / false = - [x] / - [ ] */
  checked: boolean | null;
  blocks: MdBlock[];
}

export type MdTableAlign = 'left' | 'center' | 'right' | null;

/** 块级节点 */
export type MdBlock =
  | { type: 'paragraph'; spans: MdSpan[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; spans: MdSpan[] }
  /** 代码块：lang = 围栏语言标注（无标注 / 缩进代码块为 null)，text = 原文（已剥尾换行） */
  | { type: 'code'; lang: string | null; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { type: 'quote'; blocks: MdBlock[] }
  | {
      type: 'table';
      header: MdSpan[][];
      align: MdTableAlign[];
      rows: MdSpan[][][];
    }
  | { type: 'hr' }
  /** 块级图片占位（独立成段的图片语法；v1 只占位不加载，审计 C.6) */
  | { type: 'image'; src: string; alt: string };
