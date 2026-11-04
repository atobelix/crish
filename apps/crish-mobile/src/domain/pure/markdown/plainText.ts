// 列表面纯文本摘取（MD3）：线程标题 / 列表摘要 / hub 实时摘要的共同口径。
// 列表行只呈现纯文本：不渲染 markdown 结构（那是正文渲染层的职责），
// 也不让语法标记（**、围栏、管道符、#）以原文形态泄漏到行里。
// 实现走自有 AST（parseMarkdown）：标记在解析期即被结构吸收，摘取只收
// span / block 的文本内容，构造上保证标记不回流；摘取前先经
// closeInlineDangling 处理悬空构造——流式中的半截内容（如刚长出的
// `**重点`）与超窗切片的尾部都不会把半截符号摘进文本。
// 本函数是「行摘取」而非全文转换：目标量级为标题 24 字 / 摘要 80 字，
// 故源文只取头部窗口解析（封顶成本），代码块只取头部片段；单行折叠与
// 截断由调用方按各自口径处理（deriveThreadTitle / previewOfContent）。
import { parseMarkdown } from './parseMarkdown';
import { closeInlineDangling } from './closeDraft';
import type { MdBlock, MdSpan } from './types';

/** 摘取解析的源文窗口（字符）：远超行摘取所需，封顶解析成本 */
const SOURCE_WINDOW = 2048;
/** 代码块摘取上限（字符）：列表摘取只取代码头部，不收整段代码 */
const CODE_TEXT_WINDOW = 200;

function spanText(spans: readonly MdSpan[]): string {
  let out = '';
  for (const span of spans) {
    switch (span.type) {
      case 'text':
      case 'code':
        out += span.text;
        break;
      case 'image':
        out += span.alt;
        break;
      case 'break':
        out += ' ';
        break;
      default:
        out += spanText(span.children);
    }
  }
  return out;
}

function blockText(block: MdBlock): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return spanText(block.spans);
    case 'code':
      return block.text.slice(0, CODE_TEXT_WINDOW);
    case 'list':
      return block.items
        .map((item) => item.blocks.map(blockText).filter(Boolean).join(' '))
        .filter(Boolean)
        .join(' ');
    case 'quote':
      return block.blocks.map(blockText).filter(Boolean).join(' ');
    case 'table': {
      const cells: string[] = [];
      for (const cell of block.header) cells.push(spanText(cell));
      for (const row of block.rows) {
        for (const cell of row) cells.push(spanText(cell));
      }
      return cells.filter(Boolean).join(' ');
    }
    case 'image':
      return block.alt;
    case 'hr':
      return '';
  }
}

/** markdown 源文 → 列表面纯文本（未做单行折叠 / 截断，调用方处理） */
export function markdownPreviewText(source: string): string {
  if (source.trim() === '') return '';
  const windowed =
    source.length > SOURCE_WINDOW ? source.slice(0, SOURCE_WINDOW) : source;
  const blocks = parseMarkdown(closeInlineDangling(windowed));
  return blocks.map(blockText).filter(Boolean).join(' ');
}
