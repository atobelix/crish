import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// 全局样式与设计系统 Tokens 注入（零 Rust 依赖纯前端环境）
import '@/styles/tokens.css';
import '@/styles/tokens-surface.css';
import '@/styles/z-index.css';
import '@/styles/design-system.css';
import '@/styles/focus-visible.css';
import '@/styles/overlay-scrollbar.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Playground root element not found');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
