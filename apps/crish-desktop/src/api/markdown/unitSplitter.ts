export type MarkdownUnitKind =
  | 'paragraph'
  | 'heading'
  | 'table'
  | 'list'
  | 'blockquote'
  | 'code'
  | 'hr'
  | 'html'
  | 'other'
  | 'text';

/**
 * A renderer-produced DOM unit and its already parsed descendants.
 * `sourceNode` always comes from an inert template populated with trusted HTML
 * returned by the Markdown renderer; callers must never pass Markdown source.
 */
export interface MarkdownUnit {
  kind: MarkdownUnitKind;
  tagName: string | null;
  sourceNode: Node;
  children: MarkdownUnit[];
}

function kindForElement(element: Element): MarkdownUnitKind {
  const tag = element.tagName.toUpperCase();
  if (tag === 'P') return 'paragraph';
  if (/^H[1-6]$/.test(tag)) return 'heading';
  if (tag === 'TABLE') return 'table';
  if (tag === 'UL' || tag === 'OL') return 'list';
  if (tag === 'BLOCKQUOTE') return 'blockquote';
  if (tag === 'PRE') return 'code';
  if (tag === 'HR') return 'hr';
  if (
    tag === 'DIV' || tag === 'SPAN' || tag === 'SECTION' || tag === 'ARTICLE' ||
    tag === 'ASIDE' || tag === 'DETAILS' || tag === 'SUMMARY'
  ) return 'html';
  return 'other';
}

function splitNode(node: Node): MarkdownUnit | null {
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) {
    return null;
  }

  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : null;
  const tagName = element?.tagName.toUpperCase() ?? null;
  const children = element
    ? Array.from(element.childNodes)
        .map((child) => splitNode(child))
        .filter((child): child is MarkdownUnit => child !== null)
    : [];

  return {
    kind: element ? kindForElement(element) : 'text',
    tagName,
    sourceNode: node,
    children,
  };
}

/**
 * Split renderer-produced HTML into a positional unit tree. The browser parses
 * the HTML in an inert template, so links, list nesting, and table structure
 * come from the same canonical Rust/worker renderer used by final messages.
 */
export function splitHtmlIntoUnits(html: string): MarkdownUnit[] {
  if (!html) return [];
  if (typeof document === 'undefined') {
    throw new Error('splitHtmlIntoUnits requires a DOM document');
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  return Array.from(template.content.childNodes)
    .map((node) => splitNode(node))
    .filter((unit): unit is MarkdownUnit => unit !== null);
}
