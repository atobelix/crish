import type { MarkdownUnit } from './unitSplitter';

function isCompatible(node: Node, unit: MarkdownUnit): boolean {
  if (node.nodeType !== unit.sourceNode.nodeType) return false;
  if (node.nodeType !== Node.ELEMENT_NODE) return true;
  return (node as Element).tagName === unit.tagName;
}

function syncAttributes(target: Element, source: Element): void {
  const sourceNames = new Set(
    Array.from(source.attributes, (attribute) => attribute.name)
  );

  for (const attribute of Array.from(target.attributes)) {
    if (!sourceNames.has(attribute.name)) {
      target.removeAttribute(attribute.name);
    }
  }

  for (const attribute of Array.from(source.attributes)) {
    if (target.getAttribute(attribute.name) !== attribute.value) {
      target.setAttribute(attribute.name, attribute.value);
    }
  }
}

function patchNode(target: Node, unit: MarkdownUnit): void {
  if (target.nodeType === Node.TEXT_NODE) {
    const nextText = unit.sourceNode.textContent ?? '';
    if (target.textContent !== nextText) target.textContent = nextText;
    return;
  }

  if (target.nodeType !== Node.ELEMENT_NODE) return;

  const targetElement = target as Element;
  const sourceElement = unit.sourceNode as Element;
  syncAttributes(targetElement, sourceElement);
  reconcileUnits(targetElement, unit.children);

  applyLayoutIsolation(targetElement);
}

export const TABLE_LAYOUT_ISOLATION_SELECTOR =
  '.md-table-wrap, [data-md-table="true"], [role="region"][aria-label="表格"]';

function applyLayoutIsolation(element: Element): void {
  if (element.matches(TABLE_LAYOUT_ISOLATION_SELECTOR)) {
    (element as HTMLElement).style.contain = 'layout';
  }
}

function isWhitespaceTextNode(node: Node): boolean {
  return (
    node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === ''
  );
}

function isWhitespaceTextUnit(unit: MarkdownUnit): boolean {
  return (
    unit.sourceNode.nodeType === Node.TEXT_NODE &&
    (unit.sourceNode.textContent ?? '').trim() === ''
  );
}

function createUnitNode(unit: MarkdownUnit): Node {
  const clone = unit.sourceNode.cloneNode(true);
  if (clone.nodeType === Node.ELEMENT_NODE) {
    const element = clone as Element;
    applyLayoutIsolation(element);
    for (const nested of Array.from(
      element.querySelectorAll(TABLE_LAYOUT_ISOLATION_SELECTOR)
    )) {
      applyLayoutIsolation(nested);
    }
  }
  return clone;
}

/**
 * Patch one already mounted root unit in place. The caller owns the unit id
 * and may replace the returned node when the root tag changes. Parsing is kept
 * outside this helper so the incremental caller can parse only the changed
 * unit rather than the cumulative HTML snapshot.
 */
export function reconcileUnitNode(
  target: Node | null,
  unit: MarkdownUnit
): Node {
  if (target && isCompatible(target, unit)) {
    patchNode(target, unit);
    return target;
  }
  return createUnitNode(unit);
}

/**
 * Reconcile renderer-produced units in place. Same-tag elements are patched in
 * place across incremental-to-authoritative handovers even when authoritative
 * HTML introduces inter-block whitespace text nodes or header elements (e.g.
 * `.md-code-header` before `<pre>`). Input must come from splitHtmlIntoUnits.
 */
export function reconcileUnits(
  container: Node,
  units: readonly MarkdownUnit[]
): void {
  let cursor: ChildNode | null = container.firstChild;

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]!;

    while (
      cursor &&
      isWhitespaceTextNode(cursor) &&
      unit.sourceNode.nodeType === Node.ELEMENT_NODE &&
      cursor.nextSibling &&
      ((cursor.textContent ?? '').includes('\n') ||
        isCompatible(cursor.nextSibling, unit))
    ) {
      const next = cursor.nextSibling;
      container.removeChild(cursor);
      cursor = next;
    }

    if (!cursor) {
      container.appendChild(createUnitNode(unit));
      continue;
    }

    if (isCompatible(cursor, unit)) {
      patchNode(cursor, unit);
      cursor = cursor.nextSibling;
      continue;
    }

    const nextUnit = index + 1 < units.length ? units[index + 1] : undefined;
    if (
      isWhitespaceTextUnit(unit) &&
      cursor.nodeType === Node.ELEMENT_NODE &&
      ((unit.sourceNode.textContent ?? '').includes('\n') ||
        Boolean(nextUnit && isCompatible(cursor, nextUnit)))
    ) {
      container.insertBefore(createUnitNode(unit), cursor);
      continue;
    }

    if (
      nextUnit &&
      isCompatible(cursor, nextUnit) &&
      !(cursor.nextSibling && isCompatible(cursor.nextSibling, nextUnit))
    ) {
      container.insertBefore(createUnitNode(unit), cursor);
      continue;
    }

    if (
      cursor.nextSibling &&
      isCompatible(cursor.nextSibling, unit) &&
      !(nextUnit && isCompatible(cursor, nextUnit))
    ) {
      const next = cursor.nextSibling;
      container.removeChild(cursor);
      patchNode(next, unit);
      cursor = next.nextSibling;
      continue;
    }

    const next = cursor.nextSibling;
    container.replaceChild(createUnitNode(unit), cursor);
    cursor = next;
  }

  while (cursor) {
    const next = cursor.nextSibling;
    container.removeChild(cursor);
    cursor = next;
  }
}
