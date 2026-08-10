import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { useEditorStore } from './core/EditorStore';
import { useTableStore } from './core/TableStore';
import { metrics } from './core/metrics';
import { MarkdownFormatChecker } from './core/validator';

declare global {
  interface Window {
    MarkdownFormatChecker: typeof MarkdownFormatChecker;
    __CRISH_SESSION_STORE__: typeof useEditorStore;
    __CRISH_TABLE_STORE__: typeof useTableStore;
    __CRISH_METRICS__: {
      getCacheStats: () => { hits: number; misses: number; size: number };
      getLineCount: () => number;
      layoutThrashCount: number;
    };
  }
}

window.MarkdownFormatChecker = MarkdownFormatChecker;
window.__CRISH_SESSION_STORE__ = useEditorStore;
window.__CRISH_TABLE_STORE__ = useTableStore;
// B6 指标核心化（N10）：__CRISH_METRICS__ 改走引擎 core metrics 模块
// 全局默认实例——现有 3 API（getCacheStats/getLineCount/
// layoutThrashCount）形状保持兼容（宿主调试流式/渲染性能口径不变）。
// 注意：getLineCount 经访问器读取（R6-P1 口径），不再经 lines.length
// 触发惰性物化（旧实现每次读取都物化兼容视图，是伪指标）。
metrics.setLineCountSource(() => useEditorStore.getState().getLineCount());
window.__CRISH_METRICS__ = {
  getCacheStats: () => metrics.getCacheStats(),
  getLineCount: () => metrics.getLineCount(),
  get layoutThrashCount() {
    return metrics.layoutThrashCount;
  },
};

// --- Forced Synchronous Layout Sentinel ---
let frameLayoutCalls = 0;
const reportThrashing = () => {
  if (frameLayoutCalls > 5) {
    console.error(
      `[CRISH METRICS] Layout Thrash Detected! ${frameLayoutCalls} calls this frame.`
    );
  }
  frameLayoutCalls = 0;
  requestAnimationFrame(reportThrashing);
};
requestAnimationFrame(reportThrashing);

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  frameLayoutCalls++;
  metrics.incrementLayoutThrash();
  return originalGetBoundingClientRect.apply(this, arguments as any);
};

const originalRangeGetBoundingClientRect =
  Range.prototype.getBoundingClientRect;
Range.prototype.getBoundingClientRect = function () {
  frameLayoutCalls++;
  metrics.incrementLayoutThrash();
  return originalRangeGetBoundingClientRect.apply(this, arguments as any);
};
// ----------------------------------------

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
