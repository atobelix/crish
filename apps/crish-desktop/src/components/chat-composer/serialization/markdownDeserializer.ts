/**
 * apps/crish-desktop/src/components/chat-composer/serialization/markdownDeserializer.ts
 * Parse GFM Markdown string back into ProseMirror AST JSON document tree (CRM-04).
 */

import type { JSONContent } from './markdownSerializer';

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

    // 5. Italic: *text* (must not start with **)
    const italicMatch = remaining.match(/^\*([^*][\s\S]*?)\*/);
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

    // 2. Heading: # Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch && headingMatch[1] && headingMatch[2] !== undefined) {
      const level = headingMatch[1].length;
      content.push({
        type: 'heading',
        attrs: { level },
        content: parseInline(headingMatch[2]),
      });
      i++;
      continue;
    }

    // 3. Horizontal rule: ---
    if (/^(---|[*]{3}|_{3})\s*$/.test(trimmedLine)) {
      content.push({ type: 'horizontalRule' });
      i++;
      continue;
    }

    // 4. Task list: - [ ] Task or - [x] Task (supports multiline indented item content)
    const taskMatch = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)/);
    if (taskMatch) {
      const taskItems: JSONContent[] = [];
      while (i < lines.length) {
        const curLine = lines[i];
        if (!curLine) break;
        const tm = curLine.match(/^\s*-\s*\[([ xX])\]\s*(.*)/);
        if (!tm || tm[1] === undefined || tm[2] === undefined) break;
        const checked = tm[1].toLowerCase() === 'x';
        const itemLines: string[] = [tm[2]];
        i++;
        while (i < lines.length) {
          const nextL = lines[i];
          if (nextL === undefined || !nextL.trim()) break;
          if (/^\s*-\s*\[([ xX])\]/.test(nextL) || /^\s*[-*+]\s+/.test(nextL) || /^\s*\d+\.\s+/.test(nextL) || nextL.trim().startsWith('#')) {
            break;
          }
          if (/^\s{2,}/.test(nextL)) {
            itemLines.push(nextL.trim());
            i++;
          } else {
            break;
          }
        }
        taskItems.push({
          type: 'taskItem',
          attrs: { checked },
          content: [{ type: 'paragraph', content: parseInline(itemLines.join('\n')) }],
        });
      }
      content.push({
        type: 'taskList',
        content: taskItems,
      });
      continue;
    }

    // 5. Bullet list: - Item or * Item
    const bulletMatch = line.match(/^\s*[-*+]\s+(.*)/);
    if (bulletMatch) {
      const listItems: JSONContent[] = [];
      while (i < lines.length) {
        const curLine = lines[i];
        if (!curLine) break;
        const bm = curLine.match(/^\s*[-*+]\s+(.*)/);
        if (!bm || bm[1] === undefined) break;
        const itemLines: string[] = [bm[1]];
        i++;
        while (i < lines.length) {
          const nextL = lines[i];
          if (nextL === undefined || !nextL.trim()) break;
          if (/^\s*[-*+]\s+/.test(nextL) || /^\s*\d+\.\s+/.test(nextL) || nextL.trim().startsWith('#')) {
            break;
          }
          if (/^\s{2,}/.test(nextL)) {
            itemLines.push(nextL.trim());
            i++;
          } else {
            break;
          }
        }
        listItems.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInline(itemLines.join('\n')) }],
        });
      }
      content.push({
        type: 'bulletList',
        content: listItems,
      });
      continue;
    }

    // 6. Ordered list: 1. Item
    const orderedMatch = line.match(/^\s*(\d+)\.\s+(.*)/);
    if (orderedMatch && orderedMatch[1]) {
      const listItems: JSONContent[] = [];
      const startNum = parseInt(orderedMatch[1], 10);
      while (i < lines.length) {
        const curLine = lines[i];
        if (!curLine) break;
        const om = curLine.match(/^\s*\d+\.\s+(.*)/);
        if (!om || om[1] === undefined) break;
        const itemLines: string[] = [om[1]];
        i++;
        while (i < lines.length) {
          const nextL = lines[i];
          if (nextL === undefined || !nextL.trim()) break;
          if (/^\s*\d+\.\s+/.test(nextL) || /^\s*[-*+]\s+/.test(nextL) || nextL.trim().startsWith('#')) {
            break;
          }
          if (/^\s{2,}/.test(nextL)) {
            itemLines.push(nextL.trim());
            i++;
          } else {
            break;
          }
        }
        listItems.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInline(itemLines.join('\n')) }],
        });
      }
      content.push({
        type: 'orderedList',
        attrs: { start: startNum },
        content: listItems,
      });
      continue;
    }

    // 7. Blockquote: > Text
    if (trimmedLine.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const curLine = lines[i];
        if (!curLine || !curLine.trim().startsWith('>')) break;
        quoteLines.push(curLine.replace(/^\s*>\s?/, ''));
        i++;
      }
      const innerDoc = parseFromMarkdown(quoteLines.join('\n'));
      content.push({
        type: 'blockquote',
        content: innerDoc.content,
      });
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
