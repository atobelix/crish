/**
 * 极薄人话 fallback（工具名 → 中文动词 / 路径抽取）。
 * 禁止复制 desktop `tool-presentation` 整份规则；权威人话由 desktop 日后注入。
 */

import type { ActionKind, HumanizeHooks, ProjectToolCallInput } from './types';

export function clip(text: string, max: number): string {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function basename(p: string): string {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  const parts = s.split('/');
  return parts[parts.length - 1] || s;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 浅解 JSON 参数；失败则当原文 */
export function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (raw == null) return {};
  const s = String(raw).trim();
  if (!s) return {};
  try {
    const parsed: unknown = JSON.parse(s);
    const obj = asRecord(parsed);
    if (obj) {
      const inner =
        asRecord(obj['parameters']) ??
        asRecord(obj['input']) ??
        asRecord(obj['Arguments']);
      return inner ?? obj;
    }
    if (typeof parsed === 'string') return { _raw: parsed };
  } catch {
    return { _raw: s };
  }
  return { _raw: s };
}

function pickString(props: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = props[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

export function extractPath(args: string | undefined): string {
  const props = parseArgs(args);
  return pickString(props, [
    'path',
    'file_path',
    'filePath',
    'target_file',
    'targetFile',
    'file',
    'target',
  ]);
}

export function extractCommand(args: string | undefined): string {
  const props = parseArgs(args);
  return pickString(props, ['command', 'cmd', 'script']);
}

export function isShellName(name: string): boolean {
  const n = (name || '').toLowerCase();
  return (
    n === 'shell' ||
    n === 'bash' ||
    n === 'run_terminal_command' ||
    n === 'run_terminal_cmd' ||
    n.includes('shell') ||
    n.includes('terminal')
  );
}

function isEditName(name: string): boolean {
  const n = (name || '').toLowerCase();
  return (
    n.includes('edit') ||
    n.includes('write') ||
    n.includes('replace') ||
    n === 'search_replace'
  );
}

function isReadName(name: string): boolean {
  const n = (name || '').toLowerCase();
  return n.includes('read') || n.includes('view') || n === 'open_file';
}

export function isSearchName(name: string): boolean {
  const n = (name || '').toLowerCase();
  if (isEditName(n)) return false;
  return n.includes('grep') || n.includes('search') || n === 'rg';
}

function isListName(name: string): boolean {
  const n = (name || '').toLowerCase();
  return n.includes('list') || n.includes('glob') || n.includes('dir');
}

function inferVerbFromName(name: string): string {
  const n = (name || '').toLowerCase();
  if (isEditName(n)) {
    if (/\bwrite\b/.test(n) || n.includes('create') || n === 'write_file') {
      return '写入';
    }
    return '修改';
  }
  if (isReadName(n)) return '查看';
  if (isListName(n)) return '浏览';
  if (isSearchName(n)) return '搜索';
  if (isShellName(n)) return '运行';
  if (n.includes('web') || n.includes('fetch')) return '访问';
  if (n.includes('subagent')) return '协作';
  return '处理';
}

/** 前端派生：合并用动词族 */
export function verbFamily(verb: string): string {
  const v = String(verb || '');
  if (/查看|读取|read|浏览|list/.test(v)) return 'inspect';
  if (/修改|写入|edit|write|替换/.test(v)) return 'edit';
  if (/搜索|grep|search/.test(v)) return 'search';
  if (/运行|执行|shell|test|类型/.test(v)) return 'shell';
  if (/访问|网络|fetch/.test(v)) return 'web';
  if (/协作|subagent/.test(v)) return 'subagent';
  return v || 'other';
}

export function actionKind(name: string): ActionKind {
  const n = (name || '').toLowerCase();
  if (n.includes('skill')) return 'skill';
  if (n.includes('mcp')) return 'mcp';
  if (isEditName(name)) return 'edit';
  if (isShellName(name)) return 'shell';
  if (isSearchName(name)) return 'search';
  if (isReadName(name) || isListName(name)) return 'file';
  return 'other';
}

function pastVerb(base: string): string {
  const b = String(base || '').replace(/^正在/, '');
  const map: Record<string, string> = {
    查看: '已查看',
    运行: '已运行',
    修改: '已修改',
    搜索: '已搜索',
    浏览: '已浏览',
    写入: '已写入',
    访问: '已访问',
    协作: '已协作',
    处理: '已处理',
    读取: '已查看',
    执行: '已运行',
  };
  if (map[b]) return map[b];
  if (b.startsWith('已')) return b;
  return `已${b}`;
}

export function tensedVerb(
  baseVerb: string,
  status: ProjectToolCallInput['status']
): string {
  const base = baseVerb || '处理';
  if (status === 'running') {
    return base.startsWith('正在') ? base : `正在${base}`;
  }
  return pastVerb(base);
}

/** 模板噪声：归一时丢掉，避免「查看文件」各自成 Purpose */
function isGenericExplanationSpam(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return true;
  if (
    /^(正在)?(查看|浏览|修改|搜索|访问|读取|写入|列出|创建|运行)(文件|目录|代码|网络|内容|命令|工具)?$/.test(
      t
    )
  ) {
    return true;
  }
  if (/^正在?(查看|浏览|修改|搜索|访问|读取|写入|运行)\s+\S{1,80}$/.test(t)) {
    return true;
  }
  if (
    /^(创建目录|列出目录|列出目录内容|运行命令|运行终端命令|查看文件内容|查看文件|修改文件|写入文件|切换工作目录)(\s+\S+)?$/.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/** 前端派生：去「正在」、丢 spam、截断 80 字 */
export function normalizePurpose(raw: string | undefined): string {
  let t = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  t = t.replace(/^正在/, '');
  if (isGenericExplanationSpam(t) || isGenericExplanationSpam(`正在${t}`)) {
    return '';
  }
  if (t.length < 2) return '';
  return clip(t, 80);
}

export function toolVerbBase(
  tc: ProjectToolCallInput,
  hooks?: HumanizeHooks
): string {
  const injected = hooks?.verb?.(tc.name);
  if (injected) return injected;
  return inferVerbFromName(tc.name);
}

export function fallbackLabel(
  tc: ProjectToolCallInput,
  hooks?: HumanizeHooks
): string {
  const injected = hooks?.label?.(tc);
  if (injected && injected.trim()) return injected.trim();
  const verb = toolVerbBase(tc, hooks);
  const path = extractPath(tc.arguments);
  if (path) return `${verb} ${basename(path)}`;
  const cmd = extractCommand(tc.arguments);
  if (cmd) return `${verb} ${clip(cmd, 40)}`;
  return verb;
}

export function toolObjectLabel(tc: ProjectToolCallInput): string {
  const path = extractPath(tc.arguments);
  if (path) return basename(path);
  const cmd = extractCommand(tc.arguments);
  if (cmd) return clip(cmd, 48);
  return '';
}
