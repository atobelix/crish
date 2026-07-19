/**
 * 代码高亮（highlight.js）
 * 现代化、VS Code 风格主题兼容；用于对话 fenced code 与文件预览。
 */

import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import { LruCache, HIGHLIGHT_CACHE_ENTRIES, HIGHLIGHT_CACHE_BUDGET_BYTES, memoryManager } from '@crish/shared-utils/browser';

let registered = false;

function ensureLangs() {
  if (registered) return;
  registered = true;
  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('js', javascript);
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('ts', typescript);
  hljs.registerLanguage('tsx', typescript);
  hljs.registerLanguage('jsx', javascript);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('html', xml);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('py', python);
  hljs.registerLanguage('rust', rust);
  hljs.registerLanguage('rs', rust);
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('shell', bash);
  hljs.registerLanguage('sh', bash);
  hljs.registerLanguage('powershell', bash);
  hljs.registerLanguage('markdown', markdown);
  hljs.registerLanguage('md', markdown);
  hljs.registerLanguage('sql', sql);
  hljs.registerLanguage('yaml', yaml);
  hljs.registerLanguage('yml', yaml);
  hljs.registerLanguage('go', go);
  hljs.registerLanguage('java', java);
  hljs.registerLanguage('c', c);
  hljs.registerLanguage('cpp', cpp);
}

const EXT_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  ps1: 'bash',
  sql: 'sql',
  toml: 'yaml',
};

export function langFromFilename(name: string): string {
  const base = name.replace(/^.*[\\/]/, '');
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return EXT_LANG[ext] || '';
}

const estimateSize = (key: string, value: string): number =>
  (key.length + value.length) * 2;

const highlightCache = new LruCache<string, string>(
  HIGHLIGHT_CACHE_ENTRIES,
  HIGHLIGHT_CACHE_BUDGET_BYTES,
  estimateSize,
);

memoryManager.register(highlightCache);

export function highlightCode(code: string, langHint?: string): string {
  ensureLangs();
  const raw = code.replace(/\r\n/g, '\n');
  const lang = (langHint || '').toLowerCase().replace(/^\./, '').trim();
  
  const cacheKey = `${lang}:${raw}`;
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let html = '';
  try {
    if (lang && hljs.getLanguage(lang)) {
      html = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
    } else {
      // 避免 hljs.highlightAuto 带来的严重 CPU 卡顿，直接进行 Plain Text 的转义渲染
      html = escapeHtml(raw);
    }
  } catch {
    html = escapeHtml(raw);
  }

  highlightCache.set(cacheKey, html);
  return html;
}


function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 扩展名 → 柔和色点（文件树用） */
export function fileExtColor(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').toLowerCase();
  if (base === 'package.json' || base.endsWith('.lock')) return '#ca8a04';
  const ext = base.includes('.') ? base.split('.').pop()! : '';
  const map: Record<string, string> = {
    ts: '#3b82f6',
    tsx: '#3b82f6',
    js: '#eab308',
    jsx: '#eab308',
    css: '#a855f7',
    scss: '#c084fc',
    html: '#f97316',
    json: '#ca8a04',
    md: '#64748b',
    py: '#22c55e',
    rs: '#f97316',
    go: '#06b6d4',
    java: '#ef4444',
    yml: '#84cc16',
    yaml: '#84cc16',
    sh: '#22c55e',
    ps1: '#0ea5e9',
    svg: '#ec4899',
    png: '#ec4899',
    jpg: '#ec4899',
    toml: '#94a3b8',
  };
  return map[ext] || 'var(--text-tertiary)';
}
