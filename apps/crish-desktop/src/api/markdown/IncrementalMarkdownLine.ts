export type IncrementalMarkdownLineDecision =
  | { kind: 'wait' }
  | { kind: 'blank' }
  | { kind: 'thematic-break' }
  | { kind: 'plain'; body: string }
  | { kind: 'heading'; level: number; body: string; ended: boolean }
  | {
    kind: 'list';
    tag: 'ul' | 'ol';
    body: string;
    ended: boolean;
    itemClass: string;
    taskPrefix?: string;
  }
  | { kind: 'fence'; char: '`' | '~'; info: string }
  | { kind: 'blockquote'; body: string; ended: boolean };

/** 只负责行首结构识别；正文仍由增量 session 逐片推进。 */
export function decideIncrementalMarkdownLine(
  probe: string
): IncrementalMarkdownLineDecision {
  const ended = probe.endsWith('\n');
  const line = ended ? probe.slice(0, -1) : probe;
  const leading = line.match(/^ {0,3}/)?.[0] ?? '';
  const rest = line.slice(leading.length);

  if (ended && line.trim() === '') return { kind: 'blank' };
  if (!ended && /^[ \t]*$/.test(line)) return { kind: 'wait' };

  // A thematic break is a complete block only once its line is complete.
  // Keep a marker-only prefix pending so `-`/`--`/`- -` can still become a
  // real `<hr>` when the next chunk arrives. Setext `Title\n---\n` is handled
  // earlier by consumeLineStart and therefore retains heading precedence.
  const thematicBreak = rest.match(/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/);
  if (ended && thematicBreak) return { kind: 'thematic-break' };

  const headingWithBody = rest.match(/^(#{1,6})[ \t]+(.*)$/);
  const headingOnly = ended ? rest.match(/^(#{1,6})[ \t]*$/) : null;
  if (headingWithBody || headingOnly) {
    return {
      kind: 'heading',
      level: (headingWithBody ?? headingOnly)![1]!.length,
      body: headingWithBody?.[2] ?? '',
      ended,
    };
  }
  if (rest.startsWith('#') && /^#+$/.test(rest) && rest.length <= 6) {
    return { kind: 'wait' };
  }

  // A second marker can still complete a thematic break. Preserve the
  // existing `- ` / `* ` / `+ ` list marker behavior while waiting for
  // longer marker-only prefixes such as `--` and `- -`.
  if (
    !ended &&
    /^([-*_])(?:[ \t]*\1)+[ \t]*$/.test(rest) &&
    !/^[-+*][ \t]+$/.test(rest)
  ) {
    return { kind: 'wait' };
  }

  const unorderedWithBody = rest.match(/^([-+*])[ \t]+(.*)$/);
  const unorderedOnly = ended ? rest.match(/^([-+*])[ \t]*$/) : null;
  const unordered = unorderedWithBody ?? unorderedOnly;
  if (unordered) {
    const rawBody = unorderedWithBody?.[2] ?? '';
    const task = rawBody.match(/^\[([ xX])\][ \t]+(.*)$/);
    return {
      kind: 'list',
      tag: 'ul',
      body: task?.[2] ?? rawBody,
      ended,
      itemClass: task
        ? `md-li md-task-item${task[1]!.toLowerCase() === 'x' ? ' done' : ''}`
        : 'md-li',
      taskPrefix: task
        ? `<span class="md-task-box${task[1]!.toLowerCase() === 'x' ? ' checked' : ''}"></span>`
        : undefined,
    };
  }

  const orderedWithBody = rest.match(/^(\d+)[.)][ \t]+(.*)$/);
  const orderedOnly = ended ? rest.match(/^(\d+)[.)][ \t]*$/) : null;
  const ordered = orderedWithBody ?? orderedOnly;
  if (ordered) {
    const rawBody = orderedWithBody?.[2] ?? '';
    return {
      kind: 'list',
      tag: 'ol',
      body: rawBody,
      ended,
      itemClass: 'md-li md-ol-item',
    };
  }
  if (/^\d+[.)]?$/.test(rest) || /^[-+*]$/.test(rest)) {
    return { kind: 'wait' };
  }

  const fence = ended ? rest.match(/^(`{3,}|~{3,})([^\n]*)$/) : null;
  if (fence) {
    return { kind: 'fence', char: fence[1]![0] as '`' | '~', info: fence[2] ?? '' };
  }
  if (/^(`{1,}|~{1,})[^\n]*$/.test(rest) && !ended) {
    return { kind: 'wait' };
  }

  const quoteWithBody = rest.match(/^>[ \t]+(.*)$/);
  const quoteOnly = ended ? rest.match(/^>[ \t]*$/) : null;
  const quote = quoteWithBody ?? quoteOnly;
  if (quote) {
    return { kind: 'blockquote', body: quoteWithBody?.[1] ?? '', ended };
  }

  if (!ended && (rest === '!' || rest === '[')) return { kind: 'wait' };
  if (!ended && rest === '_') return { kind: 'wait' };

  const maybeStructural = /^[#>0-9`~+*_\- \t]/.test(rest);
  if (!ended && maybeStructural) {
    if (/^(?:#{1,6}|[-+*]|\d+[.)]?|>|`{1,2}|~{1,2}|[ \t]*)$/.test(rest)) {
      return { kind: 'wait' };
    }
  }

  return { kind: 'plain', body: probe };
}
