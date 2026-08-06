/**
 * Conex Composer — Application Entry Point (v2)
 *
 * 全新重构的入口文件。
 * styles/index.css 是样式统一入口，已包含所有子层样式导入。
 */

import React from 'react';
import ReactDOM from 'react-dom/client';

// 统一样式入口（已包含 tokens / reset / typography / prosemirror / animations / ui / shell / blocks / menus）
import './styles/index.css';

import { Editor } from './shell/Editor';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Editor />
  </React.StrictMode>,
);
