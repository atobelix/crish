import type {
  IncrementalMarkdownFragmentKind,
  HtmlPart,
  IncrementalMarkdownTextPart,
} from './IncrementalMarkdownSession';

export interface IncrementalMarkdownInlineToken {
  kind: 'marker' | 'link';
  marker?: string;
  source: string;
  previewPartIds: number[];
  linkStage?: 'label' | 'url';
}

export interface IncrementalMarkdownInlineContext {
  inlineToken: IncrementalMarkdownInlineToken | null;
  pendingInput: string;
  currentLineHasContent: boolean;
  ensureInlineContainer: () => void;
  handleInlineNewline: () => void;
  appendFragment: (
    source: string,
    kind: IncrementalMarkdownFragmentKind
  ) => IncrementalMarkdownTextPart;
  cancelPreviewParts: (ids: readonly number[]) => void;
}

export function cancelIncrementalPreviewParts(
  parts: HtmlPart[],
  ids: readonly number[],
  refreshUnitHtml: (unitId: number) => void
): void {
  if (!ids.length) return;
  const cancelled = new Set(ids);
  const affectedUnits = new Set<number>();
  for (const part of parts) {
    if (part.kind === 'text' && cancelled.has(part.id)) {
      part.cancelled = true;
      part.value = '';
      if (part.unitId !== null) affectedUnits.add(part.unitId);
    }
  }
  for (const unitId of affectedUnits) refreshUnitHtml(unitId);
}

export function consumeIncrementalInlineText(
  context: IncrementalMarkdownInlineContext,
  text: string,
  textParts: IncrementalMarkdownTextPart[],
  fragmentKind: IncrementalMarkdownFragmentKind = 'inline'
): void {
  let index = 0;
  while (index < text.length) {
    if (context.inlineToken) {
      const next = consumeIncrementalInlineToken(context, text, index, textParts, fragmentKind);
      if (next === null) {
        context.pendingInput = text.slice(index);
        return;
      }
      index = next;
      continue;
    }

    const current = text[index]!;
    if (current === '\n') {
      context.handleInlineNewline();
      index += 1;
      continue;
    }
    if (current === '!' && text[index + 1] === '[') {
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
    const marker = markerAt(text, index);
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
    if (isPotentialMarkerAtEnd(text, index)) {
      context.pendingInput = text.slice(index);
      return;
    }

    let end = index + 1;
    while (
      end < text.length &&
      !'\n[`*_'.includes(text[end]!) &&
      !(text[end] === '~' && text[end + 1] === '~') &&
      !(text[end] === '!' && text[end + 1] === '[')
    ) end += 1;
    context.ensureInlineContainer();
    textParts.push(context.appendFragment(text.slice(index, end), fragmentKind));
    context.currentLineHasContent = true;
    index = end;
  }
}

export function consumeIncrementalInlineToken(
  context: IncrementalMarkdownInlineContext,
  input: string,
  index: number,
  textParts: IncrementalMarkdownTextPart[],
  fragmentKind: IncrementalMarkdownFragmentKind = 'inline'
): number | null {
  const token = context.inlineToken;
  if (!token) return index;
  const current = input[index]!;

  if (token.kind === 'link') {
    if (token.linkStage === 'label' && current === ']') {
      token.source += current;
      token.linkStage = 'url';
      return index + 1;
    }
    if (token.linkStage === 'url' && current === '(') {
      token.source += current;
      return index + 1;
    }
    if (token.linkStage === 'url' && current === ')') {
      token.source += current;
      context.cancelPreviewParts(token.previewPartIds);
      textParts.push(context.appendFragment(token.source, fragmentKind));
      context.inlineToken = null;
      context.currentLineHasContent = true;
      return index + 1;
    }
    token.source += current;
    if (token.linkStage === 'label' && current !== ']') {
      const preview = context.appendFragment(current, fragmentKind);
      textParts.push(preview);
      token.previewPartIds.push(preview.id);
    }
    return index + 1;
  }

  const marker = token.marker ?? '';
  if (marker && input.startsWith(marker, index) && token.source.length > marker.length) {
    token.source += marker;
    context.cancelPreviewParts(token.previewPartIds);
    textParts.push(context.appendFragment(token.source, fragmentKind));
    context.inlineToken = null;
    context.currentLineHasContent = true;
    return index + marker.length;
  }
  if (marker.length > 1 && current === marker[0] && input[index + 1] === undefined) {
    return null;
  }
  token.source += current;
  const preview = context.appendFragment(current, fragmentKind);
  textParts.push(preview);
  token.previewPartIds.push(preview.id);
  return index + 1;
}

export function markerAt(input: string, index: number): string | null {
  const current = input[index] ?? '';
  if (current === '`') return '`';
  if ((current === '*' || current === '_') && input[index + 1] === current) {
    return current + current;
  }
  if ((current === '*' || current === '_') && input[index + 1] && !/\s/.test(input[index + 1]!)) {
    return current;
  }
  if (current === '~' && input[index + 1] === '~') return '~~';
  return null;
}

export function isPotentialMarkerAtEnd(input: string, index: number): boolean {
  if (index !== input.length - 1) return false;
  const current = input[index]!;
  return current === '!' || current === '[' || current === '`' ||
    current === '*' || current === '_' || current === '~';
}
