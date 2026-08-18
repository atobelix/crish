/**
 * 07 · chat 叶 UnitChrome「打开笔记」源码钉。
 * 读 UnitChrome / TreeLeafPanel / 到达 helper 原文，不 import 叶壳编排。
 *
 * 测头自钉：源码钉 ≠ 真壳到达绿 ≠ 打开完成。
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

const CHROME = join(
  DIR,
  '../../components/chat-card/UnitChromeActions.tsx'
);
const TREE_LEAF = join(
  DIR,
  '../../components/binary-tree/TreeLeafPanel.tsx'
);
const OPEN_TOOL = join(DIR, '../../store/workspace-shell/openTool.ts');
const ARRIVE = join(
  DIR,
  '../../../../../tests/e2e/webview/arrive-note-leaf.ts'
);
const SELF = join(DIR, 'unitChrome-open-note.source.test.ts');

function readUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('07 · UnitChrome chat-open-note 源码钉（≠ 真壳到达绿 · ≠ 打开完成）', () => {
  const chromeSrc = readUtf8(CHROME);
  const treeSrc = readUtf8(TREE_LEAF);
  const openToolSrc = readUtf8(OPEN_TOOL);
  const arriveSrc = readUtf8(ARRIVE);
  const selfSrc = readUtf8(SELF);

  it('测头自钉：源码钉 ≠ 真壳到达绿 ≠ 打开完成', () => {
    expect(NOTE_LEAF_HONESTY_ATTRS['data-open-complete']).toBe('not-claimed');
    expect(selfSrc).toMatch(/源码钉 ≠ 真壳到达绿 ≠ 打开完成/);
    expect(selfSrc).not.toMatch(
      /from\s+['"][^'"]*UnitChromeActions(?:['"]|\.tsx['"])/
    );
    expect(selfSrc).not.toMatch(
      /from\s+['"][^'"]*TreeLeafPanel(?:['"]|\.tsx['"])/
    );
    expect(selfSrc).not.toMatch(/import\s+[^;]*\bUnitChromeActions\b/);
    expect(selfSrc).not.toMatch(/import\s+[^;]*\bTreeLeafPanel\b/);
    expect(selfSrc).not.toMatch(/\brender\s*\(/);
    expect(selfSrc).not.toMatch(
      /getByTestId\(\s*['"]open-note-paper-strict['"]/
    );
  });

  it('清单与 DOM 契约仍是 chat-open-note / 打开笔记 / data-panel=note', () => {
    expect(chromeSrc).toMatch(
      /id:\s*['"]note['"][\s\S]*?label:\s*['"]打开笔记['"][\s\S]*?testId:\s*['"]chat-open-note['"]/
    );
    expect(chromeSrc).toMatch(/data-testid=\{testId\}/);
    expect(chromeSrc).toMatch(/data-panel=\{id\}/);
    expect(chromeSrc).toMatch(/data-unit-chrome-actions=["']true["']/);
    expect(chromeSrc).toMatch(/aria-label=\{label\}/);
    expect(arriveSrc).toMatch(
      /export const OPEN_NOTE\s*=\s*[\s\S]*?data-testid=["']chat-open-note["']/
    );
    expect(arriveSrc).toMatch(
      /OPEN_NOTE\s*=\s*[\s\S]*?data-unit-chrome-actions[\s\S]*?data-panel=["']note["']/
    );
  });

  it('打开走 openToolInSession + note，不点 open-note-paper-strict', () => {
    expect(chromeSrc).toMatch(
      /openToolInSession\(\s*\(activeSessionId\s*\|\|\s*['"]{2}\)\.trim\(\)\s*,\s*panelId\s*\)/
    );
    expect(chromeSrc).toMatch(/onClick=\{\(\)\s*=>\s*handleOpenTool\(id\)\}/);
    expect(openToolSrc).toMatch(
      /export function openToolInSession\(\s*sessionId:\s*string,\s*panelId:\s*string/
    );
    expect(openToolSrc).not.toMatch(/note\s*:\s*['"]/);
    expect(chromeSrc).not.toMatch(/open-note-paper-strict/);
    expect(treeSrc).not.toMatch(/open-note-paper-strict/);
    expect(openToolSrc).not.toMatch(/open-note-paper-strict/);
    expect(arriveSrc).not.toMatch(/open-note-paper-strict/);
    expect(arriveSrc).toMatch(
      /openToolInSession\?[\s\S]*?open\(sid,\s*['"]note['"]\)/
    );
  });

  it('chat 叶仍挂 UnitChromeActions，不是死 CTA 入口', () => {
    expect(treeSrc).toMatch(/import\s+\{\s*UnitChromeActions\s*\}/);
    expect(treeSrc).toMatch(
      /isChat\s*\?\s*\([\s\S]*?<UnitChromeActions[\s\S]*?activeSessionId=\{sessionForPanel\}/
    );
    expect(treeSrc).toMatch(
      /openToolInSession\(\s*targetSessionId,\s*panelId\s*\)/
    );
    expect(chromeSrc).toMatch(/viewRegistry\.getView\(id\)/);
  });
});
