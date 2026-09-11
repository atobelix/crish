// @vitest-environment jsdom
/**
 * 笔记扩展激活 / 注销。jsdom 绿 ≠ 打开完成 ≠ 关 EL。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type React from 'react';
import {
  registerBuiltInViews,
  slotCore,
  viewRegistry,
  type ViewFactoryMap,
} from '../../services/view-registry';
import type { ViewRenderContext } from '../../services/view-registry';
import { activateNotePaper, deactivateNotePaper } from './activate';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const stubComponent: React.FC<ViewRenderContext> = () => null;
const stubFactory = () => stubComponent;
const testFactories: ViewFactoryMap = {
  chat: stubFactory,
  terminal: stubFactory,
  preview: stubFactory,
  overview: stubFactory,
  files: stubFactory,
  diff: stubFactory,
  runtime: stubFactory,
  agent: stubFactory,
  browser: stubFactory,
  'flow-dag': stubFactory,
  'file-viewer': stubFactory,
};

const BUILTIN_IDS = [
  'chat',
  'terminal',
  'preview',
  'overview',
  'files',
  'diff',
  'runtime',
  'agent',
  'flow-dag',
  'file-viewer',
] as const;

function ensureBuiltins(): void {
  if (!viewRegistry.getView('chat')) {
    registerBuiltInViews(testFactories);
  }
}

describe('note-paper activate / deactivate（02 F1–F3 / F5 / F12）', () => {
  beforeEach(() => {
    deactivateNotePaper();
    ensureBuiltins();
  });

  afterEach(() => {
    deactivateNotePaper();
  });

  it('F1 只跑 registerBuiltInViews 后 getView(note) 为空，11 内置仍在', () => {
    deactivateNotePaper();
    expect(viewRegistry.getView('note')).toBeUndefined();
    const ids = viewRegistry.getAllViews().map((v) => v.id);
    for (const id of BUILTIN_IDS) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain('note');
  });

  it('F2 activate 后 note 进表 / keyed 槽 / getToolViews，且非 primary', () => {
    activateNotePaper();
    const def = viewRegistry.getView('note');
    expect(def).toBeDefined();
    expect(def?.id).toBe('note');
    expect(def?.category).toBe('tool');
    expect(viewRegistry.isPrimary('note')).toBe(false);
    expect(slotCore.getKeyed('workspace.leaf.panel', 'note')).toBeTruthy();
    expect(viewRegistry.getToolViews().some((v) => v.id === 'note')).toBe(true);
    expect((def?.component as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for('react.lazy')
    );
  });

  it('F3 deactivate 后 F2 全反；11 内置仍在；二次 deactivate 不抛', () => {
    activateNotePaper();
    deactivateNotePaper();
    expect(viewRegistry.getView('note')).toBeUndefined();
    expect(slotCore.getKeyed('workspace.leaf.panel', 'note')).toBeUndefined();
    expect(viewRegistry.getToolViews().some((v) => v.id === 'note')).toBe(
      false
    );
    const ids = viewRegistry.getAllViews().map((v) => v.id);
    for (const id of BUILTIN_IDS) {
      expect(ids).toContain(id);
    }
    expect(() => deactivateNotePaper()).not.toThrow();
  });

  it('F5 note:abc → params.docId=abc，definition 仍是扩展 note', () => {
    activateNotePaper();
    const resolved = viewRegistry.resolveView('note:abc');
    expect(resolved.definition?.id).toBe('note');
    expect(resolved.params?.docId).toBe('abc');
  });

  it('F12 main 启动路径在 builtins 之后调用 activateNotePaper', () => {
    const mainSrc = readFileSync(join(DIR, '../../main.tsx'), 'utf8');
    const builtinIdx = mainSrc.indexOf(
      'registerBuiltInViews(builtinViewFactories)'
    );
    const activateIdx = mainSrc.indexOf('activateNotePaper()');
    expect(builtinIdx).toBeGreaterThan(-1);
    expect(activateIdx).toBeGreaterThan(builtinIdx);
    expect(mainSrc).not.toMatch(/builtinViewFactories[\s\S]*\bnote\s*:/);
  });

  it('N1 registerBuiltInViews 源码无 id: note，注释仍是 11', () => {
    const src = readFileSync(
      join(DIR, '../../services/view-registry/registerBuiltInViews.tsx'),
      'utf8'
    );
    expect(src).not.toMatch(/id:\s*['"]note['"]/);
    expect(src).toMatch(/全部 11 个/);
  });

  it('ViewRegistry.test 仍断言 11 内置、不含 note', () => {
    const src = readFileSync(
      join(DIR, '../../services/view-registry/ViewRegistry.test.ts'),
      'utf8'
    );
    expect(src).toMatch(/file-viewer/);
    expect(src).not.toMatch(/toContain\(['"]note['"]\)/);
  });

  it('activate.ts 不同步 import NotePaperStrictPanel', () => {
    const src = readFileSync(join(DIR, 'activate.ts'), 'utf8');
    expect(src).not.toMatch(/NotePaperStrictPanel/);
    const factorySrc = readFileSync(join(DIR, 'noteViewFactory.tsx'), 'utf8');
    expect(factorySrc).toMatch(/lazy\s*\(/);
    expect(factorySrc).toMatch(/import\('\.\/NoteLeafHost'\)/);
    expect(factorySrc).not.toMatch(/from\s+['"][^'"]*NotePaperStrictPanel/);
  });

  it('activate.ts 生产源不得静态 import NoteLeafHost（只经 factory 动态 import）', () => {
    const src = readFileSync(join(DIR, 'activate.ts'), 'utf8');
    expect(src).toMatch(/createNotePaperView\s*\(/);
    expect(src).not.toMatch(/\bNoteLeafHost\b/);
    expect(src).not.toMatch(/from\s+['"][^'"]*NoteLeafHost/);
    expect(src).not.toMatch(/import\s*\(\s*['"][^'"]*NoteLeafHost/);
    expect(src).not.toMatch(/@crish\/block-paper(?!-contract)/);
  });

  it('noteViewFactory 保持 lazy + import(NoteLeafHost)，不得静态 from Host / Strict', () => {
    const factorySrc = readFileSync(join(DIR, 'noteViewFactory.tsx'), 'utf8');
    expect(factorySrc).toMatch(
      /lazy\s*\(\s*\(\s*\)\s*=>\s*import\(\s*['"]\.\/NoteLeafHost['"]\s*\)\s*\)/
    );
    expect(factorySrc).not.toMatch(/from\s+['"][^'"]*NoteLeafHost/);
    expect(factorySrc).not.toMatch(/from\s+['"][^'"]*NotePaperStrict/);
    expect(factorySrc).not.toMatch(/@crish\/block-paper(?!-contract)/);
  });
});
