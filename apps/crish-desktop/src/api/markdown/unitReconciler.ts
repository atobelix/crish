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

function applyLayoutIsolation(element: Element): void {
  if (element.matches('.md-table-wrap, [role="region"][aria-label="表格"]')) {
    (element as HTMLElement).style.contain = 'layout';
  }
}

function appendUnit(container: Node, unit: MarkdownUnit): void {
  const clone = unit.sourceNode.cloneNode(true);
  if (clone.nodeType === Node.ELEMENT_NODE) {
    const element = clone as Element;
    applyLayoutIsolation(element);
    for (const nested of Array.from(
      element.querySelectorAll('.md-table-wrap, [role="region"][aria-label="表格"]')
    )) {
      applyLayoutIsolation(nested);
    }
  }
  container.appendChild(clone);
}

/**
 * Patch one already mounted root unit in place. The caller owns the unit id
 * and may replace the returned node when the root tag changes. Parsing is kept
 * outside this helper so the incremental caller can parse only the changed
 * unit rather than the cumulative HTML snapshot.
 */
export function reconcileUnitNode(target: Node | null, unit: MarkdownUnit): Node {
  if (target && isCompatible(target, unit)) {
    patchNode(target, unit);
    return target;
  }
  const holder = document.createElement('div');
  appendUnit(holder, unit);
  return holder.firstChild ?? unit.sourceNode.cloneNode(true);
}

/**
 * Reconcile renderer-produced units in place. The common prefix keeps its DOM
 * references; only an incompatible suffix is replaced, while same-tag leaf or
 * container nodes are patched in place. Input must come from splitHtmlIntoUnits.
 */
export function reconcileUnits(
  container: Node,
  units: readonly MarkdownUnit[]
): void {
  const current = Array.from(container.childNodes);
  const sharedLength = Math.min(current.length, units.length);
  let index = 0;

  while (index < sharedLength) {
    const node = current[index];
    const unit = units[index];
    if (!node || !unit || !isCompatible(node, unit)) break;
    patchNode(node, unit);
    index += 1;
  }

  if (index < current.length) {
    while (container.childNodes.length > index) {
      container.removeChild(container.childNodes[index]!);
    }
  }

  for (; index < units.length; index += 1) {
    const unit = units[index];
    if (unit) appendUnit(container, unit);
  }
}
