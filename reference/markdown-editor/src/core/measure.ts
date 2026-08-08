export function getCoordinatesFromIndex(
  index: number,
  container: HTMLElement | null
): { top: number; left: number; height: number; bottom: number } | null {
  if (!container) return null;

  // We look for a token that contains the index.
  // However, if the cursor is at the very end of a token, it might technically be at the start of the next token.
  // For measurement, it's usually better to measure the exact char.

  // Find all tokens and do a basic scan
  // In a real optimized scenario, we would use document.evaluate or binary search on a cached list of elements.
  // For now, querySelectorAll is fast enough if limited to the virtual window.
  const tokenElements = container.querySelectorAll('[data-token-start]');
  let targetElement: Element | null = null;
  let offsetInToken = 0;

  for (let i = 0; i < tokenElements.length; i++) {
    const el = tokenElements[i];
    const start = parseInt(el.getAttribute('data-token-start') || '0', 10);
    const length = parseInt(el.getAttribute('data-token-length') || '0', 10);

    // If index is within this token
    if (index >= start && index < start + length) {
      // Ignore elements that are hidden via CSS (e.g. display: none for rendered blocks when active)
      if (el.getBoundingClientRect().height > 0) {
        targetElement = el;
        offsetInToken = index - start;
        break;
      }
    }

    // If index is exactly at the end of the line/document
    if (index === start + length) {
      if (el.getBoundingClientRect().height > 0) {
        targetElement = el;
        offsetInToken = length;
        // Don't break, if there's a subsequent token starting at this index, we'll prefer it.
      }
    }
  }

  if (!targetElement) {
    // Fallback: look for the line container if the index is on an empty line
    const lineElements = container.hasAttribute('data-line-start')
      ? [container]
      : container.querySelectorAll('[data-line-start]');
    for (let i = 0; i < lineElements.length; i++) {
      const el = lineElements[i] as Element;
      const start = parseInt(el.getAttribute('data-line-start') || '0', 10);
      const length = parseInt(el.getAttribute('data-line-length') || '0', 10);
      if (index >= start && index <= start + length) {
        const rect = el.getBoundingClientRect();

        // For empty lines, use standard font size to avoid giant 28px cursor
        const fontSize = 14;
        const cursorHeight = fontSize * 1.15;
        const topOffset = rect.top + ((rect.height || 28) - cursorHeight) / 2;

        return {
          top: topOffset,
          left: rect.left,
          height: cursorHeight,
          bottom: rect.bottom,
        };
      }
    }
    return null;
  }

  // Now find the exact text node and local offset by traversing all text nodes in order
  const result = findNodeAndOffset(targetElement, offsetInToken);
  if (!result) {
    // Fallback to measuring the element itself
    const rect = targetElement.getBoundingClientRect();
    return {
      top: rect.top,
      left: offsetInToken === 0 ? rect.left : rect.right,
      height: rect.height,
      bottom: rect.bottom,
    };
  }

  const { textNode, localOffset } = result;

  // Measure using Range
  const range = document.createRange();

  try {
    range.setStart(textNode, localOffset);
    range.setEnd(textNode, localOffset);
    let rect = range.getBoundingClientRect();

    if (rect.height === 0 && rect.width === 0) {
      // Sometimes collapsed ranges at the end of a line return 0x0
      rect = targetElement.getBoundingClientRect();
    }

    // Get actual font size to draw a proper thin cursor, instead of full line-height
    const style = window.getComputedStyle(targetElement as Element);
    const fontSize = parseFloat(style.fontSize) || 14;
    const cursorHeight = fontSize * 1.15; // slightly taller than font

    // Vertically center the cursor within the line box
    const topOffset = rect.top + (rect.height - cursorHeight) / 2;

    return {
      top: topOffset,
      left: rect.left,
      height: cursorHeight,
      bottom: rect.bottom,
    };
  } catch (e) {
    console.error('Measurement failed', e);
    return null;
  }
}

function findNodeAndOffset(
  node: Node,
  targetOffset: number
): { textNode: Node; localOffset: number } | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const len = node.nodeValue?.length || 0;
    if (targetOffset <= len) {
      return { textNode: node, localOffset: targetOffset };
    }
    return null; // Target is beyond this node
  }

  let currentOffset = targetOffset;
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];

    // CRITICAL: Ignore rendered content fallback or math previews (they are NOT part of the raw text offset length!)
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (
        el.classList.contains('syntax-content') ||
        el.hasAttribute('data-ignore-measure') ||
        el.classList.contains('katex') ||
        el.classList.contains('math-preview')
      ) {
        continue;
      }
    }

    if (child.nodeType === Node.TEXT_NODE) {
      const len = child.nodeValue?.length || 0;
      if (currentOffset <= len) {
        return { textNode: child, localOffset: currentOffset };
      }
      currentOffset -= len;
    } else {
      // Recursively search child elements
      const result = findNodeAndOffset(child, currentOffset);
      if (result) {
        return result;
      }
      // If child didn't contain the target, subtract the text length of the entire child subtree
      // (ignoring .syntax-content elements!)
      currentOffset -= getRawTextLength(child);
    }
  }

  // If we reach here and it's the very end of the tree, sometimes we want to snap to the last text node
  // but the recursive logic usually catches targetOffset == len.
  return null;
}

function getRawTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue?.length || 0;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    if (
      el.classList.contains('syntax-content') ||
      el.hasAttribute('data-ignore-measure') ||
      el.classList.contains('katex') ||
      el.classList.contains('math-preview')
    ) {
      return 0;
    }
  }
  let len = 0;
  for (let i = 0; i < node.childNodes.length; i++) {
    len += getRawTextLength(node.childNodes[i]);
  }
  return len;
}

export function getGlobalIndexFromDOMNode(
  node: Node,
  offset: number,
  container: HTMLElement
): number | null {
  let targetNode = node;
  let isText = node.nodeType === Node.TEXT_NODE;

  // If it's an element node, offset is the child index.
  // We should point to the child node to correctly resolve its data-sub-offset.
  if (!isText && offset >= 0 && offset < node.childNodes.length) {
    targetNode = node.childNodes[offset];
  }

  let el: HTMLElement | null =
    targetNode.nodeType === Node.TEXT_NODE
      ? targetNode.parentElement
      : (targetNode as HTMLElement);
  let foundTokenStart = -1;
  let lineStart = -1;

  while (el && el !== container) {
    if (el.hasAttribute('data-token-start') && foundTokenStart === -1) {
      foundTokenStart = parseInt(
        el.getAttribute('data-token-start') || '-1',
        10
      );
    }
    if (el.hasAttribute('data-line-start') && lineStart === -1) {
      lineStart = parseInt(el.getAttribute('data-line-start') || '-1', 10);
    }
    el = el.parentElement;
  }

  if (foundTokenStart !== -1) {
    let subOffset = 0;
    let currentEl: HTMLElement | null =
      targetNode.nodeType === Node.TEXT_NODE
        ? targetNode.parentElement
        : (targetNode as HTMLElement);

    while (currentEl && currentEl !== container) {
      if (currentEl.hasAttribute('data-sub-offset')) {
        subOffset = parseInt(
          currentEl.getAttribute('data-sub-offset') || '0',
          10
        );
        break;
      }
      if (currentEl.hasAttribute('data-token-start')) {
        break;
      }
      currentEl = currentEl.parentElement;
    }

    return foundTokenStart + subOffset + (isText ? offset : 0);
  }

  if (lineStart !== -1) {
    return lineStart + (isText ? offset : 0);
  }

  return null;
}

export interface ActiveState {
  cursor: number;
  selStart?: number;
  selEnd?: number;
}

export function checkIsActive(start: number, len: number, activeState: ActiveState | null): boolean {
  if (!activeState) return false;
  const end = start + len;
  if (activeState.selStart !== undefined && activeState.selEnd !== undefined) {
    return start < activeState.selEnd && end > activeState.selStart;
  } else {
    return activeState.cursor >= start && activeState.cursor <= end;
  }
}

export function getArrowNavigationIndex(
  cursorPos: number,
  direction: 'up' | 'down',
  container: HTMLElement
): number | null {
  const currentRect = getCoordinatesFromIndex(cursorPos, container);
  if (!currentRect) return null;

  let currentLineEl = null;
  let currentLineIdx = -1;
  const lines = container.querySelectorAll('[data-line-start]');

  for (let i = 0; i < lines.length; i++) {
    const start = parseInt(lines[i].getAttribute('data-line-start') || '0', 10);
    const len = parseInt(lines[i].getAttribute('data-line-length') || '0', 10);
    if (cursorPos >= start && cursorPos <= start + len) {
      currentLineEl = lines[i];
      currentLineIdx = parseInt(
        lines[i].getAttribute('data-index') || '-1',
        10
      );
      break;
    }
  }

  if (!currentLineEl || currentLineIdx === -1) return null;

  const targetIdx = direction === 'up' ? currentLineIdx - 1 : currentLineIdx + 1;
  const targetLineEl = container.querySelector(`[data-index="${targetIdx}"]`);

  if (!targetLineEl) {
    if (direction === 'up') {
      return parseInt(currentLineEl.getAttribute('data-line-start') || '0', 10);
    } else {
      const start = parseInt(currentLineEl.getAttribute('data-line-start') || '0', 10);
      const len = parseInt(currentLineEl.getAttribute('data-line-length') || '0', 10);
      return start + len;
    }
  }

  const targetRect = targetLineEl.getBoundingClientRect();

  // Requirement 2: Use document.caretRangeFromPoint if available and within viewport
  const targetY = direction === 'up'
    ? targetRect.bottom - targetRect.height / 2
    : targetRect.top + targetRect.height / 2;

  if (typeof document.caretRangeFromPoint === 'function') {
    // Check if the target Y is within viewport
    if (targetY >= 0 && targetY <= window.innerHeight) {
      const range = document.caretRangeFromPoint(currentRect.left, targetY);
      if (range) {
        const index = getGlobalIndexFromDOMNode(range.startContainer, range.startOffset, container);
        if (index !== null) {
          return index;
        }
      }
    }
  }

  // Fallback geometric search for out of viewport or if caretRangeFromPoint fails
  const targetStart = parseInt(targetLineEl.getAttribute('data-line-start') || '0', 10);
  const targetLen = parseInt(targetLineEl.getAttribute('data-line-length') || '0', 10);

  let bestDist = Infinity;
  let bestIndex = targetStart;

  // Fast O(log N) binary search for the closest X coordinate
  let low = 0;
  let high = targetLen;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const globalIdx = targetStart + mid;
    const r = getCoordinatesFromIndex(globalIdx, targetLineEl as HTMLElement);

    if (!r) break;

    const dist = Math.abs(r.left - currentRect.left);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = globalIdx;
    }

    if (r.left === currentRect.left) {
      break; // Exact match
    } else if (r.left < currentRect.left) {
      low = mid + 1; // Need to move right
    } else {
      high = mid - 1; // Need to move left
    }
  }

  // Ensure we check immediate neighbors (because fonts can have non-monotonic local kerning/width variance)
  for (let offset = -2; offset <= 2; offset++) {
    const checkIdx = bestIndex + offset;
    if (checkIdx >= targetStart && checkIdx <= targetStart + targetLen) {
      const r = getCoordinatesFromIndex(checkIdx, targetLineEl as HTMLElement);
      if (r) {
        const dist = Math.abs(r.left - currentRect.left);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = checkIdx;
        }
      }
    }
  }

  return bestIndex;
}

// Removed updateActiveElements per Requirement 4
