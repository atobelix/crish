// Setup file for Vitest JSDOM environment
import '@testing-library/jest-dom';

// Polyfill ResizeObserver if missing in JSDOM
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Polyfill scrollIntoView if missing in JSDOM
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

// Mock Range getClientRects and getBoundingClientRect for Tiptap popovers
if (typeof window !== 'undefined' && window.Range && !window.Range.prototype.getClientRects) {
  window.Range.prototype.getClientRects = () => [];
  window.Range.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => {},
  });
}
