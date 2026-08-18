/**
 * 列表块解析：松散列表、缩进续行、一级嵌套列表收进同一结构。
 *
 * 从 markdownPlugins.ts 拆出（T4-11 SR-06-R3）：列表项匹配、
 * 行级列表块解析与 HTML 渲染。
 */

import { visualIndent } from './markdownInlineFormat';

/**
 * 无序列表 / 任务列表行（- * +；任务列表 [ ] / [x]）。
 * 允许 `- ` / `-` 空项（内容可空），避免 trim 后空 li 丢失。
 */
const RE_UL_ITEM = /^(\s*)([-*+])(?:\s+(?:\[([ xX])\]\s+)?(.*))?$/;
/** 有序列表行（捕获起始序号，供 start= 使用；允许 `1.` 空项） */
const RE_OL_ITEM = /^(\s*)(\d+)\.(?:\s+(.*))?$/;

export type ListKind = 'ul' | 'ol' | 'task';

export type MatchedListItem = {
  indent: number;
  kind: ListKind;
  taskChecked?: boolean;
  content: string;
  /** 有序列表原始序号（用于 start 属性） */
  olStart?: number;
};

export function matchListItem(line: string): MatchedListItem | null {
  const ul = line.match(RE_UL_ITEM);
  if (ul) {
    const indent = visualIndent(ul[1]!);
    const content = ul[4] ?? '';
    if (ul[3] !== undefined) {
      return {
        indent,
        kind: 'task',
        taskChecked: ul[3].toLowerCase() === 'x',
        content,
      };
    }
    return { indent, kind: 'ul', content };
  }
  const ol = line.match(RE_OL_ITEM);
  if (ol) {
    const n = parseInt(ol[2]!, 10);
    return {
      indent: visualIndent(ol[1]!),
      kind: 'ol',
      content: ol[3] ?? '',
      olStart: Number.isFinite(n) && n > 0 ? n : 1,
    };
  }
  return null;
}

export function isIndentedContinuation(line: string, baseIndent: number): boolean {
  if (!line.trim()) return false;
  // 续行：视觉缩进严格大于列表基线（Tab 按 4 列展开）
  const m = line.match(/^(\s+)/);
  if (!m) return false;
  return visualIndent(m[1] ?? '') > baseIndent;
}

export function renderListItemHtml(
  kind: ListKind,
  content: string,
  taskChecked?: boolean
): string {
  if (kind === 'task') {
    const done = taskChecked ? ' done' : '';
    const box = taskChecked ? ' checked' : '';
    return `<li class="md-li md-task-item${done}"><span class="md-task-box${box}"></span>${content}</li>`;
  }
  if (kind === 'ol') {
    return `<li class="md-li md-ol-item">${content}</li>`;
  }
  return `<li class="md-li">${content}</li>`;
}

/**
 * 行级列表块解析：松散列表、缩进续行、一级嵌套列表收进同一结构
 */
export function processListBlocks(html: string): string {
  const lines = html.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const head = matchListItem(lines[i]!);
    if (!head) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }

    type Item = {
      kind: ListKind;
      content: string;
      taskChecked?: boolean;
      indent: number;
      children: Item[];
      olStart?: number;
    };
    const items: Item[] = [];
    let cur: Item = {
      kind: head.kind,
      content: head.content,
      indent: head.indent,
      children: [],
      ...(head.taskChecked !== undefined && { taskChecked: head.taskChecked }),
      ...(head.olStart !== undefined && { olStart: head.olStart }),
    };
    const baseIndent = head.indent;
    i += 1;

    while (i < lines.length) {
      const line = lines[i]!;
      const trimmed = line.trim();

      if (!trimmed) {
        let j = i + 1;
        while (j < lines.length && !lines[j]!.trim()) j += 1;
        if (j >= lines.length) break;
        const nextItem = matchListItem(lines[j]!);
        if (nextItem && nextItem.indent <= baseIndent + 8) {
          i = j;
          continue;
        }
        if (isIndentedContinuation(lines[j]!, baseIndent)) {
          cur.content += `<br />${lines[j]!.trim()}`;
          i = j + 1;
          continue;
        }
        break;
      }

      const item = matchListItem(line);
      if (item) {
        if (item.indent <= baseIndent + 1) {
          items.push(cur);
          cur = {
            kind: item.kind,
            content: item.content,
            indent: item.indent,
            children: [],
            ...(item.taskChecked !== undefined && { taskChecked: item.taskChecked }),
            ...(item.olStart !== undefined && { olStart: item.olStart }),
          };
          i += 1;
          continue;
        }
        if (item.indent >= baseIndent + 2) {
          const node: Item = {
            kind: item.kind,
            content: item.content,
            indent: item.indent,
            children: [],
            ...(item.taskChecked !== undefined && { taskChecked: item.taskChecked }),
            ...(item.olStart !== undefined && { olStart: item.olStart }),
          };
          let parent: Item = cur;
          while (parent.children.length) {
            const last = parent.children[parent.children.length - 1]!;
            if (item.indent >= last.indent + 2) {
              parent = last;
            } else {
              break;
            }
          }
          parent.children.push(node);
          i += 1;
          continue;
        }
      }

      if (isIndentedContinuation(line, baseIndent)) {
        cur.content += `<br />${line.trim()}`;
        i += 1;
        continue;
      }
      break;
    }
    items.push(cur);

    const renderNested = (kids: Item[]): string => {
      if (!kids.length) return '';
      let segKind: 'ul' | 'ol' | null = null;
      let seg: string[] = [];
      let segStart: number | undefined;
      let htmlNest = '';
      const flushNest = () => {
        if (!seg.length || !segKind) return;
        const tag = segKind;
        const cls = tag === 'ol' ? 'md-ol md-ol-nested' : 'md-ul md-ul-nested';
        const startAttr =
          tag === 'ol' && segStart != null && segStart > 1
            ? ` start="${segStart}"`
            : '';
        htmlNest += `<${tag} class="${cls}"${startAttr}>${seg.join('')}</${tag}>`;
        seg = [];
        segKind = null;
        segStart = undefined;
      };
      for (const k of kids) {
        const group: 'ul' | 'ol' = k.kind === 'ol' ? 'ol' : 'ul';
        if (segKind && segKind !== group) flushNest();
        if (!segKind) {
          segKind = group;
          segStart = k.olStart;
        }
        const childHtml = renderNested(k.children);
        const open =
          k.kind === 'task'
            ? `<li class="md-li md-task-item${k.taskChecked ? ' done' : ''}"><span class="md-task-box${k.taskChecked ? ' checked' : ''}"></span>${k.content}`
            : k.kind === 'ol'
              ? `<li class="md-li md-ol-item">${k.content}`
              : `<li class="md-li">${k.content}`;
        seg.push(`${open}${childHtml}</li>`);
      }
      flushNest();
      return htmlNest;
    };

    let segKind: 'ul' | 'ol' | null = null;
    let seg: string[] = [];
    let segStart: number | undefined;
    const flush = () => {
      if (!seg.length || !segKind) return;
      const tag = segKind;
      const cls = tag === 'ol' ? 'md-ol' : 'md-ul';
      const startAttr =
        tag === 'ol' && segStart != null && segStart > 1
          ? ` start="${segStart}"`
          : '';
      out.push('');
      out.push(`<${tag} class="${cls}"${startAttr}>${seg.join('')}</${tag}>`);
      out.push('');
      seg = [];
      segKind = null;
      segStart = undefined;
    };
    for (const it of items) {
      const group: 'ul' | 'ol' = it.kind === 'ol' ? 'ol' : 'ul';
      if (segKind && segKind !== group) flush();
      if (!segKind) {
        segKind = group;
        segStart = it.olStart;
      }
      const nested = renderNested(it.children);
      if (nested) {
        if (it.kind === 'task') {
          const done = it.taskChecked ? ' done' : '';
          const box = it.taskChecked ? ' checked' : '';
          seg.push(
            `<li class="md-li md-task-item${done}"><span class="md-task-box${box}"></span>${it.content}${nested}</li>`
          );
        } else if (it.kind === 'ol') {
          seg.push(`<li class="md-li md-ol-item">${it.content}${nested}</li>`);
        } else {
          seg.push(`<li class="md-li">${it.content}${nested}</li>`);
        }
      } else {
        seg.push(renderListItemHtml(it.kind, it.content, it.taskChecked));
      }
    }
    flush();
  }

  return out.join('\n');
}
