/**
 * 07 余量：未知 note 叶文案源码钉。
 * 读 TreeLeafPanel / activate 原文，不 import 叶壳（避开整棵编排）。
 *
 * 测头自钉：源码钉 ≠ 真壳到达 ≠ 打开完成。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOTE_LEAF_HONESTY_ATTRS } from './honesty';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const TREE_LEAF = join(
  DIR,
  '../../components/binary-tree/TreeLeafPanel.tsx'
);
const ACTIVATE = join(DIR, 'activate.ts');
const SELF = join(DIR, 'unknown-note-leaf.source.test.ts');

function readUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('07 · 未知 note 叶文案源码钉（≠ 真壳到达 · ≠ 打开完成）', () => {
  const treeSrc = readUtf8(TREE_LEAF);
  const activateSrc = readUtf8(ACTIVATE);
  const selfSrc = readUtf8(SELF);

  it('测头自钉：源码钉 ≠ 真壳到达 ≠ 打开完成', () => {
    expect(NOTE_LEAF_HONESTY_ATTRS['data-open-complete']).toBe('not-claimed');
    expect(selfSrc).toMatch(/源码钉 ≠ 真壳到达 ≠ 打开完成/);
    expect(selfSrc).not.toMatch(
      /from\s+['"][^'"]*TreeLeafPanel(?:['"]|\.tsx['"])/
    );
    expect(selfSrc).not.toMatch(/import\s+[^;]*\bTreeLeafPanel\b/);
  });

  it('未知 / 未注册 view 分支存在（未知面板类型）', () => {
    expect(treeSrc).toMatch(/未知面板类型/);
    expect(treeSrc).toMatch(/viewRegistry\.resolveView/);
    expect(treeSrc).toMatch(/<SlotOutlet[\s\S]*?fallback=\{/);
    expect(treeSrc).toMatch(/未知面板类型：\{panelId\}/);
  });

  it('文案钉扩展未激活 / 未知，而非 note 内置名单兜底', () => {
    expect(treeSrc).toMatch(/笔记扩展未激活|扩展未激活/);
    expect(treeSrc).toMatch(
      /note\s*\?\s*['"]（笔记扩展未激活）['"]/
    );
    expect(treeSrc).toMatch(
      /panelId\s*===\s*['"]note['"]\s*\|\|\s*panelId\.startsWith\(\s*['"]note:['"]\s*\)/
    );
    expect(treeSrc).not.toMatch(/registerBuiltInViews/);
    expect(treeSrc).not.toMatch(/NotePaperStrictPanel|NoteLeafHost/);
    expect(treeSrc).not.toMatch(/case\s+['"]note['"]/);
    expect(treeSrc).toMatch(/剥离 switch\(panelId\)/);
    const treeWithoutComments = treeSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(treeWithoutComments).not.toMatch(/\bswitch\s*\(/);
  });

  it('TreeLeafPanel 无 registerView(note) / 无 id === note 内置渲染', () => {
    expect(treeSrc).not.toMatch(/registerView\s*\(\s*['"]note['"]/);
    expect(treeSrc).not.toMatch(
      /registerView\s*\(\s*\{[\s\S]*?id:\s*['"]note['"]/
    );
    expect(treeSrc).not.toMatch(/\bregisterView\s*\(/);
    expect(treeSrc).not.toMatch(/\bid\s*===?\s*['"]note['"]/);
  });

  it('activate.ts 仍有 unregister / deactivateNotePaper', () => {
    expect(activateSrc).toMatch(/unregister/);
    expect(activateSrc).toMatch(/unregisterView/);
    expect(activateSrc).toMatch(/export function deactivateNotePaper/);
    expect(activateSrc).toMatch(/unregisterView\s*\(\s*\)/);
    expect(activateSrc).toMatch(/unregisterUri\s*\(\s*\)/);
  });
});
