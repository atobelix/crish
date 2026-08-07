import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { useEditorStore } from './core/EditorStore'
import { MarkdownParser } from './core/parser';

declare global {
  interface Window {
    __CRISH_SESSION_STORE__: typeof useEditorStore;
    __CRISH_METRICS__: {
      getCacheStats: () => { hits: number, misses: number, size: number };
      getLineCount: () => number;
      layoutThrashCount: number;
    };
  }
}

window.__CRISH_SESSION_STORE__ = useEditorStore;
window.__CRISH_METRICS__ = {
  getCacheStats: () => MarkdownParser.getCacheStats(),
  getLineCount: () => useEditorStore.getState().lines.length,
  layoutThrashCount: 0
};

// --- Forced Synchronous Layout Sentinel ---
let frameLayoutCalls = 0;
const reportThrashing = () => {
    if (frameLayoutCalls > 5) {
        console.error(`[CRISH METRICS] Layout Thrash Detected! ${frameLayoutCalls} calls this frame.`);
    }
    frameLayoutCalls = 0;
    requestAnimationFrame(reportThrashing);
};
requestAnimationFrame(reportThrashing);

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function() {
    frameLayoutCalls++;
    window.__CRISH_METRICS__.layoutThrashCount++;
    return originalGetBoundingClientRect.apply(this, arguments as any);
};

const originalRangeGetBoundingClientRect = Range.prototype.getBoundingClientRect;
Range.prototype.getBoundingClientRect = function() {
    frameLayoutCalls++;
    window.__CRISH_METRICS__.layoutThrashCount++;
    return originalRangeGetBoundingClientRect.apply(this, arguments as any);
};
// ----------------------------------------

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
