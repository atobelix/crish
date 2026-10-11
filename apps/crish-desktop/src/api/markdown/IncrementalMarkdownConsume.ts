import {
  decideIncrementalMarkdownLine,
  type IncrementalMarkdownLineDecision,
} from './IncrementalMarkdownLine';
import {
  isPotentialMarkerAtEnd,
  markerAt,
  type IncrementalMarkdownInlineToken,
} from './IncrementalMarkdownInline';
import type {
  IncrementalMarkdownFragmentKind,
  IncrementalMarkdownTextPart,
} from './IncrementalMarkdownSession';
import type { IncrementalMarkdownUnitProjection } from './IncrementalMarkdownUnits';

export interface IncrementalMarkdownConsumeContext {
  lineProbe: string;
  lineStart: boolean;
  fenceChar: '`' | '~' | null;
  setextHeadingLine: boolean;
  pendingInput: string;
  pendingNewline: boolean;
  previousLineEligibleForSetext: boolean;
  currentLineHasContent: boolean;
  inlineToken: IncrementalMarkdownInlineToken | null;
  paragraphOpen: boolean;
  headingLevel: number | null;
  blockquoteOpen: boolean;
  listTag: 'ul' | 'ol' | null;
  listItemOpen: boolean;
  listBreakPending: boolean;
  projection: IncrementalMarkdownUnitProjection;
  consumeFence: (input: string, start: number) => number | null;
  consumeInlineToken: (
    input: string,
    index: number,
    textParts: IncrementalMarkdownTextPart[],
    fragmentKind?: IncrementalMarkdownFragmentKind
  ) => number | null;
  consumeInlineText: (
    text: string,
    textParts: IncrementalMarkdownTextPart[],
    fragmentKind?: IncrementalMarkdownFragmentKind
  ) => void;
  handleInlineNewline: () => void;
  ensureInlineContainer: () => void;
  flushPendingNewline: () => void;
  closeHeading: () => void;
  closeParagraph: () => void;
  closeList: () => void;
  closeBlockquote: () => void;
  openCode: (char: '`' | '~', info: string) => void;
  openHeading: (level: number) => void;
  openList: (tag: 'ul' | 'ol', start?: number) => void;
  closeListItem: () => void;
  openListItem: (itemClass: string, taskPrefix?: string) => void;
  openBlockquote: () => void;
  convertParagraphToSetext: (level: number) => void;
}

export function consumeIncrementalMarkdown(
  context: IncrementalMarkdownConsumeContext,
  delta: string
): IncrementalMarkdownTextPart[] {
  const input = context.pendingInput + delta;
  context.pendingInput = '';
  const textParts: IncrementalMarkdownTextPart[] = [];
  let index = 0;

  while (index < input.length) {
    if (context.fenceChar) {
      const next = context.consumeFence(input, index);
      if (next === null) break;
      index = next;
      continue;
    }

    if (context.setextHeadingLine) {
      const current = input[index]!;
      if (current === '\n') {
        context.closeHeading();
        context.setextHeadingLine = false;
        context.lineStart = true;
        index += 1;
      } else if (current === ' ' || current === '\t') {
        index += 1;
      } else {
        context.closeHeading();
        context.setextHeadingLine = false;
        context.lineStart = true;
      }
      continue;
    }

    if (context.lineStart) {
      const next = consumeLineStart(context, input, index, textParts);
      if (next === null) break;
      index = next;
      continue;
    }

    if (context.inlineToken) {
      const next = context.consumeInlineToken(
        input,
        index,
        textParts,
        context.listItemOpen ? 'list-item' : 'inline'
      );
      if (next === null) break;
      index = next;
      continue;
    }

    const current = input[index]!;
    if (current === '\n') {
      context.handleInlineNewline();
      index += 1;
      continue;
    }
    if (current === '!' && input[index + 1] === '[') {
      context.ensureInlineContainer();
      context.inlineToken = {
        kind: 'link',
        source: '![',
        previewPartIds: [],
        linkStage: 'label',
      };
      context.currentLineHasContent = true;
      index += 2;
      continue;
    }
    if (current === '[') {
      context.ensureInlineContainer();
      context.inlineToken = {
        kind: 'link',
        source: '[',
        previewPartIds: [],
        linkStage: 'label',
      };
      context.currentLineHasContent = true;
      index += 1;
      continue;
    }

    const marker = markerAt(input, index);
    if (marker) {
      context.ensureInlineContainer();
      context.inlineToken = {
        kind: 'marker',
        marker,
        source: marker,
        previewPartIds: [],
      };
      context.currentLineHasContent = true;
      index += marker.length;
      continue;
    }
    if (isPotentialMarkerAtEnd(input, index)) {
      context.pendingInput = input.slice(index);
      break;
    }

    let end = index + 1;
    while (
      end < input.length &&
      input[end] !== '\n' &&
      input[end] !== '[' &&
      input[end] !== '`' &&
      input[end] !== '*' &&
      input[end] !== '_' &&
      !(input[end] === '~' && input[end + 1] === '~') &&
      !(input[end] === '!' && input[end + 1] === '[')
    ) end += 1;
    context.ensureInlineContainer();
    textParts.push(context.projection.appendFragment(
      input.slice(index, end),
      context.listItemOpen ? 'list-item' : 'inline'
    ));
    context.currentLineHasContent = true;
    index = end;
  }

  return textParts;
}

function consumeLineStart(
  context: IncrementalMarkdownConsumeContext,
  input: string,
  start: number,
  textParts: IncrementalMarkdownTextPart[]
): number | null {
  let index = start;
  while (index < input.length) {
    const current = input[index]!;

    if (context.pendingNewline && context.previousLineEligibleForSetext) {
      const setextChar = context.lineProbe[0] ?? current;
      const isSetextChar = setextChar === '=' || setextChar === '-';
      const continuesSetext =
        isSetextChar && (context.lineProbe.length === 0 || current === setextChar);
      if (continuesSetext) {
        context.lineProbe += current;
        index += 1;
        if (context.lineProbe.length < 3) continue;
        if (/^(===+|---+)$/.test(context.lineProbe)) {
          context.convertParagraphToSetext(setextChar === '-' ? 2 : 1);
          context.lineProbe = '';
          context.pendingNewline = false;
          context.previousLineEligibleForSetext = false;
          context.setextHeadingLine = true;
          context.lineStart = false;
          return index;
        }
        context.flushPendingNewline();
      } else if (context.lineProbe.length > 0) {
        context.flushPendingNewline();
      }
    }

    context.lineProbe += current;
    index += 1;
    const decision = decideIncrementalMarkdownLine(context.lineProbe);
    if (decision.kind === 'wait') continue;

    const probe = context.lineProbe;
    context.lineProbe = '';
    applyLineDecision(context, decision, probe, textParts);
    return index;
  }
  return null;
}

function applyLineDecision(
  context: IncrementalMarkdownConsumeContext,
  decision: Exclude<IncrementalMarkdownLineDecision, { kind: 'wait' }>,
  probe: string,
  textParts: IncrementalMarkdownTextPart[]
): void {
  const ended = probe.endsWith('\n');
  if (decision.kind === 'blank') {
    context.pendingNewline = false;
    context.previousLineEligibleForSetext = false;
    context.closeHeading();
    context.closeParagraph();
    context.closeList();
    context.closeBlockquote();
    context.lineStart = true;
    context.currentLineHasContent = false;
    return;
  }

  if (decision.kind === 'thematic-break') {
    context.flushPendingNewline();
    context.closeList();
    context.closeHeading();
    context.closeParagraph();
    context.closeBlockquote();
    context.projection.beginUnit('hr', '<hr class="md-hr" />');
    context.projection.endUnit();
    context.pendingNewline = false;
    context.previousLineEligibleForSetext = false;
    context.currentLineHasContent = false;
    context.lineStart = ended;
    return;
  }

  if (decision.kind === 'fence') {
    context.flushPendingNewline();
    context.closeParagraph();
    context.closeList();
    context.closeHeading();
    context.closeBlockquote();
    context.openCode(decision.char, decision.info);
    context.lineStart = true;
    context.currentLineHasContent = false;
    return;
  }

  if (decision.kind === 'heading') {
    context.flushPendingNewline();
    context.closeParagraph();
    context.closeList();
    context.closeBlockquote();
    context.openHeading(decision.level);
    if (decision.body) context.consumeInlineText(decision.body, textParts);
    context.currentLineHasContent = decision.body.length > 0;
    // Once the heading prefix and its separating space are recognized, the
    // remainder of the open line is heading inline content. Keeping
    // `lineStart` true here would classify the first body chunk as a new
    // Markdown line (for example `## ` followed by `**安全`) and would close
    // the heading into a stray paragraph.
    context.lineStart = false;
    if (ended) context.closeHeading();
    return;
  }

  if (decision.kind === 'list') {
    context.flushPendingNewline();
    context.closeParagraph();
    context.closeHeading();
    context.closeBlockquote();
    if (context.listTag !== decision.tag) {
      context.closeList();
      const orderedStart = probe.match(/^ {0,3}(\d+)[.)]/)?.[1];
      context.openList(decision.tag, orderedStart ? Number(orderedStart) : undefined);
    } else if (context.listBreakPending) {
      context.closeListItem();
    }
    context.listBreakPending = false;
    context.openListItem(decision.itemClass, decision.taskPrefix);
    if (decision.body) context.consumeInlineText(decision.body, textParts, 'list-item');
    context.currentLineHasContent = decision.body.length > 0;
    context.listBreakPending = ended;
    context.lineStart = ended;
    return;
  }

  if (decision.kind === 'blockquote') {
    context.flushPendingNewline();
    context.closeParagraph();
    context.closeList();
    context.closeHeading();
    context.openBlockquote();
    if (decision.body) context.consumeInlineText(decision.body, textParts);
    context.currentLineHasContent = decision.body.length > 0;
    if (ended) {
      context.closeBlockquote();
      context.lineStart = true;
    } else {
      context.lineStart = false;
    }
    return;
  }

  if (context.listItemOpen && context.listBreakPending) {
    context.projection.appendStatic('<br />');
    context.listBreakPending = false;
    context.lineStart = false;
    context.consumeInlineText(decision.body.trimStart(), textParts, 'list-item');
    return;
  }
  context.flushPendingNewline();
  context.closeList();
  context.closeHeading();
  context.closeBlockquote();
  context.lineStart = false;
  context.consumeInlineText(decision.body, textParts);
}
