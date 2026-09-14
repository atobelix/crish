import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './index.css';
import './App.css';
// 表格岛样式（战役 table-systemic-remediation T3 / ADR-2）：必须**后于**
// index.css / App.css 导入，才能在同名特异性下覆盖 `.line-table-row` 的 flex。
import './styles/table-island.css';
import App from './App.tsx';
import { RealShell } from './components/shell/RealShell';
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

// 入口分流：真实软件壳为默认界面；?demo=1 进入演示装置
// （流式工具条/文档库/导出/大纲等历史调试 chrome，仅供测试与演示）。
const isDemo = new URLSearchParams(window.location.search).has('demo');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isDemo ? <App /> : <RealShell />}</StrictMode>
);
