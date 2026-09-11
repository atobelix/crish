/**
 * apps/crish-desktop/src/components/chat-composer/serialization/markdownDeserializer.ts
 * Parse GFM Markdown string back into a ProseMirror JSON document tree (CRM-04).
 *
 * 输出契约（composer schema 收敛，SSOT）：本文件唯一消费方是 TiptapEditorField
 * 的草稿水合，composer 编辑器 schema 刻意禁用块级排版节点（heading / bulletList /
 * orderedList / listItem / taskList / taskItem / blockquote / horizontalRule，
 * 见 TiptapEditorExtensions 的 StarterKit 配置——对话输入框保持纯净行内修饰流）。
 * 因此 parseFromMarkdown 输出恒为行内 schema 形状：块级结构降维为段落并原样
 * 保留标记文本（# / - / - [ ] / 1. /> / ---），codeBlock 与行内 mark 全保真。
 * 否则 setContent 会因未知节点抛错并触发水合静默丢失（历史事故：列表模板水合为空）。
 */

import type { JSONContent } from './markdownSerializer';

/** 列表项标记（任务 / 无序 / 有序），用于嵌套列表识别 */
const ANY_LIST_MARKER_RE = /^\s*-\s*\[[ xX]\]\s+|^\s*[-*+]\s+|^\s*\d+\.\s+/;

const TASK_ITEM_RE = /^\s*-\s*\[([ xX])\]\s+(.*)$/;
const BULLET_ITEM_RE = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM_RE = /^\s*(\d+)\.\s+(.*)$/;

/** 去除多行公共缩进（嵌套块递归解析前调用） */
function stripCommonIndent(lines: string[]): string[] {
  const indents = lines
    .filter((l) => l && l.trim().length > 0)
    .map((l) => (l.match(/^\s*/) ?? [''])[0].length);
  if (indents.length === 0) return lines;
  const common = Math.min(...indents);
  return lines.map((l) => l.slice(common));
}

/**
 * 收集一个列表项的后继行（从 start 开始）：
 * - 缩进普通行 → 续行文本（itemLines）
 * - 缩进列表标记行 → 收集连续嵌套块（subBlocks，交给 parseFromMarkdown 递归解析）
 * - 无缩进 / 空行 → 终止（后续由外层循环解析为新项或段落）
 */
function collectListItemTail(
  lines: string[],
  start: number
): { textLines: string[]; subBlocks: string[][]; next: number } {
  const textLines: string[] = [];
  const subBlocks: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || !line.trim()) break;
    if (!/^\s/.test(line)) break;
    if (ANY_LIST_MARKER_RE.test(line)) {
      const indent = (line.match(/^\s*/) ?? [''])[0].length;
      const block: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (!l || !l.trim()) break;
        if ((l.match(/^\s*/) ?? [''])[0].length < indent) break;
        block.push(l);
        i++;
      }
      subBlocks.push(block);
      continue;
    }
    textLines.push(line.trim());
    i++;
  }
  return { textLines, subBlocks, next: i };
}

/** 嵌套块去公共缩进后递归解析为子节点序列 */
function parseSubBlocks(blocks: string[][]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const block of blocks) {
    const stripped = stripCommonIndent(block);
    const inner = parseFromMarkdown(stripped.join('\n'));
    if (inner.content) out.push(...inner.content);
  }
  return out;
}

/**
 * Parses inline GFM markdown string into an array of ProseMirror inline JSONContent nodes.
 * Supports mention metadata (id:kind), nested inline marks (bold + code, link + bold), and hardBreaks (\n).
 */
export function parseInline(text: string): JSONContent[] {
  if (!text) return [];

  const nodes: JSONContent[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // 1. HardBreak: \n
    if (remaining.startsWith('\n')) {
      nodes.push({ type: 'hardBreak' });
      remaining = remaining.slice(1);
      continue;
    }

    // 2. Mention: @[label](id:kind) or @[label](id)
    const mentionMatch = remaining.match(/^@\[([^\]]+)\]\(([^):]+)(?::([^)]+))?\)/);
    if (mentionMatch) {
      nodes.push({
        type: 'mention',
        attrs: {
          label: mentionMatch[1] ?? '',
          id: mentionMatch[2] ?? '',
          kind: mentionMatch[3] || 'file',
        },
      });
      remaining = remaining.slice(mentionMatch[0].length);
      continue;
    }

    // 3. Inline Code: `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      nodes.push({
        type: 'text',
        text: codeMatch[1] ?? '',
        marks: [{ type: 'code' }],
      });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // 4. Bold: **text**
    const boldMatch = remaining.match(/^\*\*([\s\S]+?)\*\*/);
    if (boldMatch) {
      const inner = boldMatch[1] ?? '';
      const children = parseInline(inner);
      for (const child of children) {
        if (child.type === 'text') {
          const marks = child.marks ? [...child.marks] : [];
          if (!marks.some((m) => m.type === 'bold')) {
            marks.push({ type: 'bold' });
          }
          nodes.push({ ...child, marks });
        } else {
          nodes.push(child);
        }
      }
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // 5. Italic: *text*（须遵守 CommonMark 左侧翼规则：开标记 '*' 后不得紧跟
    //    空白，否则视为字面星号——否则 cron 表达式「0 9 * * *」等裸星号序列
    //    会被误判为斜体并丢失星号文本；闭标记侧同理要求内文以非空白收尾）
    const italicMatch = remaining.match(/^\*(?=\S)(\S(?:[\s\S]*?\S)?)\*/);
    if (italicMatch) {
      const inner = italicMatch[1] ?? '';
      const children = parseInline(inner);
      for (const child of children) {
        if (child.type === 'text') {
          const marks = child.marks ? [...child.marks] : [];
          if (!marks.some((m) => m.type === 'italic')) {
            marks.push({ type: 'italic' });
          }
          nodes.push({ ...child, marks });
        } else {
          nodes.push(child);
        }
      }
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // 6. Strike: ~~text~~
    const strikeMatch = remaining.match(/^~~([\s\S]+?)~~/);
    if (strikeMatch) {
      const inner = strikeMatch[1] ?? '';
      const children = parseInline(inner);
      for (const child of children) {
        if (child.type === 'text') {
          const marks = child.marks ? [...child.marks] : [];
          if (!marks.some((m) => m.type === 'strike')) {
            marks.push({ type: 'strike' });
          }
          nodes.push({ ...child, marks });
        } else {
          nodes.push(child);
        }
      }
      remaining = remaining.slice(strikeMatch[0].length);
      continue;
    }

    // 7. Link: [text](href)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const inner = linkMatch[1] ?? '';
      const href = linkMatch[2] ?? '';
      const children = parseInline(inner);
      for (const child of children) {
        if (child.type === 'text') {
          const marks = child.marks ? [...child.marks] : [];
          if (!marks.some((m) => m.type === 'link')) {
            marks.push({ type: 'link', attrs: { href } });
          }
          nodes.push({ ...child, marks });
        } else {
          nodes.push(child);
        }
      }
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Plain text character or chunk until next special character
    const nextSpecialIndex = remaining.slice(1).search(/[\n@`*_~[]/);
    if (nextSpecialIndex === -1) {
      nodes.push({ type: 'text', text: remaining });
      break;
    } else {
      const plainChunk = remaining.slice(0, nextSpecialIndex + 1);
      nodes.push({ type: 'text', text: plainChunk });
      remaining = remaining.slice(nextSpecialIndex + 1);
    }
  }

  return nodes;
}

/**
 * Parses GFM Markdown string back into a ProseMirror JSON document tree.
 */
export function parseFromMarkdown(markdown: string): JSONContent {
  if (!markdown || !markdown.trim()) {
    return {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    };
  }

  const lines = markdown.split(/\r?\n/);
  const content: JSONContent[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line === undefined || !line.trim()) {
      i++;
      continue;
    }

    const trimmedLine = line.trim();

    // 1. Code block: ```lang or ````lang ... ```
    if (trimmedLine.startsWith('```')) {
      const fenceMatch = trimmedLine.match(/^(`{3,})/);
      const fenceStr: string = fenceMatch && fenceMatch[1] ? fenceMatch[1] : '```';
      const lang = trimmedLine.slice(fenceStr.length).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (cur !== undefined && cur.trim().startsWith(fenceStr)) {
          break;
        }
        if (cur !== undefined) {
          codeLines.push(cur);
        }
        i++;
      }
      const checkLine = lines[i];
      if (i < lines.length && checkLine !== undefined && checkLine.trim().startsWith(fenceStr)) {
        i++; // skip closing fence
      }
      content.push({
        type: 'codeBlock',
        attrs: { language: lang },
        content: [{ type: 'text', text: codeLines.join('\n') }],
      });
      continue;
    }

    // 2. Heading → composer schema 无 heading 节点，降维为段落并保留 # 标记文本
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch && headingMatch[1] && headingMatch[2] !== undefined) {
      const level = headingMatch[1].length;
      content.push({
        type: 'paragraph',
        content: [
          { type: 'text', text: `${'#'.repeat(level)} ` },
          ...parseInline(headingMatch[2]),
        ],
      });
      i++;
      continue;
    }

    // 3. Horizontal rule → composer schema 无 horizontalRule，降维为原样文本段落
    if (/^(---|[*]{3}|_{3})\s*$/.test(trimmedLine)) {
      content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: trimmedLine }],
      });
      i++;
      continue;
    }

    // 4. Task list → composer schema 无 taskList/taskItem，降维为段落，
    //    复选框以原样标记文本保留（- [ ] / - [x]），嵌套子块递归降维
    const taskMatch = line.match(TASK_ITEM_RE);
    if (taskMatch) {
      while (i < lines.length) {
        const curLine = lines[i];
        if (!curLine) break;
        const tm = curLine.match(TASK_ITEM_RE);
        if (!tm || tm[1] === undefined || tm[2] === undefined) break;
        const checked = tm[1].toLowerCase() === 'x';
        const itemLines: string[] = [tm[2]];
        i++;
        const tail = collectListItemTail(lines, i);
        itemLines.push(...tail.textLines);
        i = tail.next;
        content.push({
          type: 'paragraph',
          content: [
            { type: 'text', text: `- [${checked ? 'x' : ' '}] ` },
            ...parseInline(itemLines.join('\n')),
          ],
        });
        content.push(...parseSubBlocks(tail.subBlocks));
      }
      continue;
    }

    // 5. Bullet list → composer schema 无 bulletList/listItem，降维为段落，
    //    项目符号以原样标记文本保留（- / * / +）
    const bulletMatch = line.match(BULLET_ITEM_RE);
    if (bulletMatch) {
      const bulletMark = bulletMatch[0].slice(
        0,
        bulletMatch[0].length - (bulletMatch[1]?.length ?? 0)
      );
      while (i < lines.length) {
        const curLine = lines[i];
        if (!curLine) break;
        const bm = curLine.match(BULLET_ITEM_RE);
        if (!bm || bm[1] === undefined) break;
        const itemLines: string[] = [bm[1]];
        i++;
        const tail = collectListItemTail(lines, i);
        itemLines.push(...tail.textLines);
        i = tail.next;
        content.push({
          type: 'paragraph',
          content: [
            { type: 'text', text: bulletMark },
            ...parseInline(itemLines.join('\n')),
          ],
        });
        content.push(...parseSubBlocks(tail.subBlocks));
      }
      continue;
    }

    // 6. Ordered list → composer schema 无 orderedList，降维为段落，
    //    序号以原样标记文本保留（起始序号延续）
    const orderedMatch = line.match(ORDERED_ITEM_RE);
    if (orderedMatch && orderedMatch[1]) {
      const startNum = parseInt(orderedMatch[1], 10);
      let itemIndex = 0;
      while (i < lines.length) {
        const curLine = lines[i];
        if (!curLine) break;
        const om = curLine.match(ORDERED_ITEM_RE);
        if (!om || om[1] === undefined || om[2] === undefined) break;
        const itemLines: string[] = [om[2]];
        i++;
        const tail = collectListItemTail(lines, i);
        itemLines.push(...tail.textLines);
        i = tail.next;
        content.push({
          type: 'paragraph',
          content: [
            { type: 'text', text: `${startNum + itemIndex}. ` },
            ...parseInline(itemLines.join('\n')),
          ],
        });
        content.push(...parseSubBlocks(tail.subBlocks));
        itemIndex++;
      }
      continue;
    }

    // 7. Blockquote → composer schema 无 blockquote，内层块递归降维后逐段加 '> ' 前缀
    if (trimmedLine.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const curLine = lines[i];
        if (!curLine || !curLine.trim().startsWith('>')) break;
        quoteLines.push(curLine.replace(/^\s*>\s?/, ''));
        i++;
      }
      const innerDoc = parseFromMarkdown(quoteLines.join('\n'));
      for (const node of innerDoc.content ?? []) {
        if (node.type === 'paragraph') {
          content.push({
            type: 'paragraph',
            content: [{ type: 'text', text: '> ' }, ...(node.content ?? [])],
          });
        } else {
          content.push(node);
        }
      }
      continue;
    }

    // 8. Regular paragraph: group consecutive non-empty lines
    const paraLines: string[] = [];
    while (i < lines.length) {
      const curL = lines[i];
      if (curL === undefined || !curL.trim()) break;
      const trimmed = curL.trim();
      if (
        trimmed.startsWith('```') ||
        trimmed.match(/^#{1,6}\s+/) ||
        /^(---|[*]{3}|_{3})\s*$/.test(trimmed) ||
        trimmed.match(/^\s*-\s*[[ xX]\]/) ||
        trimmed.match(/^\s*[-*+]\s+/) ||
        trimmed.match(/^\s*\d+\.\s+/) ||
        trimmed.startsWith('>')
      ) {
        break;
      }
      paraLines.push(curL);
      i++;
    }

    if (paraLines.length > 0) {
      content.push({
        type: 'paragraph',
        content: parseInline(paraLines.join('\n')),
      });
    }
  }

  return {
    type: 'doc',
    content: content.length > 0 ? content : [{ type: 'paragraph' }],
  };
}
