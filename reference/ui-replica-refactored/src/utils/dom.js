/**
 * DOM utility helpers.
 */

export function qs(selector, parent = document) {
  return parent.querySelector(selector);
}

export function qsa(selector, parent = document) {
  return parent.querySelectorAll(selector);
}

export function createElement(tag, attrs = {}, children = '') {
  const el = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (key === 'className') el.className = val;
    else if (key.startsWith('data-')) el.setAttribute(key, val);
    else if (key === 'style' && typeof val === 'object') Object.assign(el.style, val);
    else el.setAttribute(key, val);
  }
  if (typeof children === 'string') el.innerHTML = children;
  else if (children instanceof Node) el.appendChild(children);
  return el;
}

export function on(selector, event, handler, parent = document) {
  parent.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target) handler(e, target);
  });
}

export function delegate(parent, selector, event, handler) {
  parent.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target && parent.contains(target)) handler(e, target);
  });
}
