/**
 * noteMetrics.ts — 笔记内容指标分析与 Markdown 序列化纯函数
 *
 * 100% 纯逻辑与无副作用纯函数，解耦自 React 渲染周期，具备单测可复核性。
 */

export interface NoteContentMetrics {
  /** 总字符数（包含所有空格与换行） */
  totalChars: number;
  /** 可见字符数（剔除空格、制表符与换行） */
  visibleChars: number;
  /** CJK 汉字字符及全角标点数量 */
  chineseChars: number;
  /** 英文独立单词数量 */
  englishWords: number;
  /** 有效内容段落/块总数 */
  paragraphCount: number;
}

export interface SerializableBlock {
  id: string;
  flavour?: string;
  text?: string;
  props?: {
    level?: number;
    checked?: boolean;
    language?: string;
  };
}

export interface NoteDocumentMeta {
  docId: string;
  title: string;
  updatedAt?: number;
}

/**
 * 纯逻辑计算笔记统计指标
 */
export function computeNoteMetrics(
  blocks: readonly { text?: string; flavour?: string }[]
): NoteContentMetrics {
  let totalChars = 0;
  let visibleChars = 0;
  let chineseChars = 0;
  let englishWords = 0;
  let paragraphCount = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const text = block?.text || '';
    if (!text.trim()) continue;

    paragraphCount++;
    totalChars += text.length;

    // 匹配汉字、全角标点符号及 CJK 统一表意文字
    const cjkMatches = text.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    chineseChars += cjkCount;

    // 剔除 CJK 字符后，按连续空白字符切割统计英文单词
    const nonCjkText = text.replace(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g, ' ').trim();
    if (nonCjkText.length > 0) {
      const words = nonCjkText.split(/\s+/).filter((w) => w.length > 0);
      englishWords += words.length;
    }

    visibleChars += text.replace(/\s/g, '').length;
  }

  return {
    totalChars,
    visibleChars,
    chineseChars,
    englishWords,
    paragraphCount,
  };
}

/**
 * 将已 hydrate 的块数据纯序列化为符合 CommonMark 规范的纯 Markdown 文本
 */
export function exportBlocksToMarkdown(
  blocks: readonly SerializableBlock[],
  title?: string
): string {
  const lines: string[] = [];

  // 若存在外部标题，且正文首行并非相同的一级大标题，则自动注入 Markdown 顶层大标题
  if (title && title.trim()) {
    const trimmedTitle = title.trim();
    const firstBlock = blocks[0];
    const hasHeading1 =
      firstBlock?.flavour === 'heading' &&
      firstBlock?.props?.level === 1 &&
      firstBlock?.text?.trim() === trimmedTitle;

    if (!hasHeading1) {
      lines.push(`# ${trimmedTitle}\n`);
    }
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const text = block?.text || '';
    const flavour = (block?.flavour || 'paragraph').toLowerCase();

    switch (flavour) {
      case 'heading': {
        const level = Math.min(Math.max(block?.props?.level ?? 1, 1), 6);
        lines.push(`${'#'.repeat(level)} ${text}`);
        break;
      }
      case 'bullet':
      case 'list': {
        lines.push(`- ${text}`);
        break;
      }
      case 'numbered': {
        lines.push(`1. ${text}`);
        break;
      }
      case 'todo': {
        const check = block?.props?.checked ? 'x' : ' ';
        lines.push(`- [${check}] ${text}`);
        break;
      }
      case 'code': {
        const lang = block?.props?.language || '';
        lines.push(`\`\`\`${lang}\n${text}\n\`\`\``);
        break;
      }
      case 'quote':
      case 'blockquote': {
        lines.push(`> ${text}`);
        break;
      }
      case 'paragraph':
      default: {
        lines.push(text);
        break;
      }
    }
  }

  return lines.join('\n\n');
}
