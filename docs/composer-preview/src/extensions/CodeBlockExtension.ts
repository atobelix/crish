/**
 * CodeBlockExtension — 带语法高亮的代码块
 *
 * 用 lowlight（highlight.js 内核）做高亮，只注册常用语言，
 * 完整语言包接近 1MB，绝大多数文档用不上。
 *
 * 与 StarterKit 自带 codeBlock 的区别：
 *   1. 高亮 —— 走 CodeBlockLowlight 的 ProseMirror 装饰，
 *      不改文档内容，因此对 undo / 序列化完全透明；
 *   2. NodeView —— 挂上 CodeBlockView，提供语言选择器与复制按钮；
 *   3. 输入规则 —— 保留 ``` 触发（代码块不属于 Token-in-Document 层，
 *      围栏在序列化时生成，用户不需要在正文里编辑它）。
 */

import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { createLowlight } from 'lowlight';

import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';

import { CodeBlockView } from '../views/fenced/CodeBlockView';

const lowlight = createLowlight();

/** 注册的语言集合；`xml` 同时覆盖 HTML */
lowlight.register({
  javascript,
  typescript,
  python,
  rust,
  go,
  java,
  csharp,
  cpp,
  xml,
  css,
  json,
  yaml,
  markdown,
  bash,
  powershell,
  sql,
  diff,
});

export const CodeBlockExtension = CodeBlockLowlight.configure({
  lowlight,
  defaultLanguage: 'plaintext',
  HTMLAttributes: { class: 'code-block' },
}).extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      /** 行号开关，由 NodeView 的工具条切换 */
      showLineNumbers: {
        default: true,
        parseHTML: (el) => el.getAttribute('data-line-numbers') !== 'false',
        renderHTML: (attrs) => ({ 'data-line-numbers': String(Boolean(attrs.showLineNumbers)) }),
      },
      /** 可选的文件名标签，显示在头部左侧 */
      filename: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-filename') || '',
        renderHTML: (attrs) => (attrs.filename ? { 'data-filename': attrs.filename } : {}),
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
});

/** 已注册高亮的语言，供 NodeView 的选择器使用 */
export const SUPPORTED_LANGUAGES: Array<{ id: string; label: string }> = [
  { id: 'plaintext', label: '纯文本' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'rust', label: 'Rust' },
  { id: 'go', label: 'Go' },
  { id: 'java', label: 'Java' },
  { id: 'csharp', label: 'C#' },
  { id: 'cpp', label: 'C++' },
  { id: 'xml', label: 'HTML / XML' },
  { id: 'css', label: 'CSS' },
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'bash', label: 'Bash' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'sql', label: 'SQL' },
  { id: 'diff', label: 'Diff' },
];
