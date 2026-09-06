/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts
 * Convert ProseMirror AST JSON tree into GFM Markdown string (CRM-04).
 */

export interface JSONContent {
  type?: string;
  attrs?: Record<string, any>;
  content?: JSONContent[];
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
  text?: string;
}

/**
 * Serializes a single inline node (text, mention, hardBreak) into GFM markdown.
 */
function serializeInline(node: JSONContent): string {
  if (!node) return '';

  if (node.type === 'hardBreak') {
    return '\n';
  }

  if (node.type === 'mention') {
    const label = node.attrs?.label || node.attrs?.name || node.attrs?.id || 'mention';
    const id = node.attrs?.id || label;
    const kind = node.attrs?.kind || node.attrs?.mentionType;
    return kind ? `@[${label}](${id}:${kind})` : `@[${label}](${id})`;
  }

  if (node.type === 'text') {
    let text = node.text || '';
    if (!node.marks || node.marks.length === 0) {
      return text;
    }

    for (const mark of node.marks) {
      switch (mark.type) {
        case 'bold':
          text = `**${text}**`;
          break;
        case 'italic':
          text = `*${text}*`;
          break;
        case 'strike':
          text = `~~${text}~~`;
          break;
        case 'code':
          text = `\`${text}\``;
          break;
        case 'link': {
          const href = mark.attrs?.href || '';
          text = `[${text}](${href})`;
          break;
        }
      }
    }
    return text;
  }

  if (node.content && node.content.length > 0) {
    return node.content.map(serializeInline).join('');
  }

  return '';
}

/**
 * 序列化列表项内容为「行数组」：段落（含 hardBreak）与嵌套列表块
 * 逐行展开、不以空行分隔，保证嵌套列表 roundtrip 可逆（T5 保真）。
 */
function serializeItemContent(content: JSONContent[] | undefined): string[] {
  if (!content || content.length === 0) return [];
  const lines: string[] = [];
  for (const child of content) {
    if (child.type === 'paragraph') {
      const text = (child.content || []).map(serializeInline).join('');
      if (text) lines.push(...text.split('\n'));
    } else {
      const block = serializeBlockNodes([child], '');
      if (block) lines.push(...block.split('\n'));
    }
  }
  return lines;
}

/**
 * Serializes block node content or children array.
 */
function serializeBlockNodes(nodes: JSONContent[], indent = ''): string {
  if (!nodes || nodes.length === 0) return '';

  const blocks: string[] = [];

  for (const node of nodes) {
    if (!node || !node.type) continue;

    switch (node.type) {
      case 'heading': {
        const level = Math.min(Math.max(node.attrs?.level || 1, 1), 6);
        const prefix = '#'.repeat(level) + ' ';
        const text = (node.content || []).map(serializeInline).join('');
        blocks.push(`${indent}${prefix}${text}`);
        break;
      }

      case 'paragraph': {
        const text = (node.content || []).map(serializeInline).join('');
        blocks.push(`${indent}${text}`);
        break;
      }

      case 'codeBlock': {
        const lang = node.attrs?.language || '';
        const codeText = (node.content || []).map((n) => n.text || '').join('');
        const fence = codeText.includes('```') ? '````' : '```';
        blocks.push(`${indent}${fence}${lang}\n${codeText}\n${indent}${fence}`);
        break;
      }

      case 'blockquote': {
        const innerText = serializeBlockNodes(node.content || [], '');
        const quoted = innerText
          .split('\n')
          .map((line) => (line ? `${indent}> ${line}` : `${indent}>`))
          .join('\n');
        blocks.push(quoted);
        break;
      }

      case 'taskList': {
        const items: string[] = [];
        for (const item of node.content || []) {
          if (item.type === 'taskItem') {
            const checked = item.attrs?.checked ? 'x' : ' ';
            const itemLines = serializeItemContent(item.content || []);
            const firstLine = itemLines[0] || '';
            const restLines = itemLines
              .slice(1)
              .map((l) => (l ? `      ${l}` : l))
              .join('\n');
            const formattedItem = restLines
              ? `- [${checked}] ${firstLine}\n${restLines}`
              : `- [${checked}] ${firstLine}`;
            items.push(`${indent}${formattedItem}`);
          }
        }
        blocks.push(items.join('\n'));
        break;
      }

      case 'bulletList': {
        const items: string[] = [];
        for (const item of node.content || []) {
          if (item.type === 'listItem') {
            const itemLines = serializeItemContent(item.content || []);
            const firstLine = itemLines[0] || '';
            const restLines = itemLines
              .slice(1)
              .map((l) => (l ? `  ${l}` : l))
              .join('\n');
            const formattedItem = restLines
              ? `- ${firstLine}\n${restLines}`
              : `- ${firstLine}`;
            items.push(`${indent}${formattedItem}`);
          }
        }
        blocks.push(items.join('\n'));
        break;
      }

      case 'orderedList': {
        const items: string[] = [];
        let index = node.attrs?.start || 1;
        for (const item of node.content || []) {
          if (item.type === 'listItem') {
            const prefix = `${index}. `;
            const indentPadding = ' '.repeat(prefix.length);
            const itemLines = serializeItemContent(item.content || []);
            const firstLine = itemLines[0] || '';
            const restLines = itemLines
              .slice(1)
              .map((l) => (l ? `${indentPadding}${l}` : l))
              .join('\n');
            const formattedItem = restLines
              ? `${prefix}${firstLine}\n${restLines}`
              : `${prefix}${firstLine}`;
            items.push(`${indent}${formattedItem}`);
            index++;
          }
        }
        blocks.push(items.join('\n'));
        break;
      }

      case 'horizontalRule': {
        blocks.push(`${indent}---`);
        break;
      }

      default: {
        // Fallback for unknown block nodes
        if (node.content) {
          blocks.push(serializeBlockNodes(node.content, indent));
        }
        break;
      }
    }
  }

  if (blocks.length > 1 && blocks[blocks.length - 1] === '') {
    return blocks.slice(0, -1).join('\n\n') + '\n';
  }

  return blocks.join('\n\n');
}

/**
 * Converts ProseMirror AST JSON tree into a GFM Markdown string.
 */
export function serializeToMarkdown(doc: JSONContent | null | undefined): string {
  if (!doc) return '';

  const raw =
    doc.type === 'doc' && doc.content
      ? serializeBlockNodes(doc.content)
      : Array.isArray(doc.content)
        ? serializeBlockNodes(doc.content)
        : serializeInline(doc);

  if (!raw) return '';
  if (!raw.trim()) return '';

  const leadingTrimmed = raw.replace(/^\s+/, '');
  return leadingTrimmed.replace(/[ \t]+$/, '');
}
