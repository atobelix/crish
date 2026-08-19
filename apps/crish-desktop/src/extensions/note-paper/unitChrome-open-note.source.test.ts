/**
 * 07 · 坞头「打开笔记」源码钉。
 * 读 unitChromeTools / LeafToolTabStrip / TreeLeafPanel / 到达 helper 原文。
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

const TOOLS = join(DIR, '../../components/chat-card/unitChromeTools.ts');
const CHROME = join(
  DIR,
  '../../components/chat-card/UnitChromeActions.tsx'
);
const STRIP = join(
  DIR,
  '../../components/binary-tree/LeafToolTabStrip.tsx'
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

describe('07 · 坞头 chat-open-note 源码钉（≠ 真壳到达绿 · ≠ 打开完成）', () => {
  const toolsSrc = readUtf8(TOOLS);
  const chromeSrc = readUtf8(CHROME);
  const stripSrc = readUtf8(STRIP);
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

  it('清单在 unitChromeTools；DOM 契约在坞头 LeafToolTabStrip', () => {
    expect(toolsSrc).toMatch(
      /id:\s*['"]note['"][\s\S]*?label:\s*['"]打开笔记['"][\s\S]*?testId:\s*['"]chat-open-note['"]/
    );
    expect(stripSrc).toMatch(/UNIT_TOOL_PANELS/);
    expect(stripSrc).toMatch(/data-testid=\{testId\}/);
    expect(stripSrc).toMatch(/data-panel=\{id\}/);
    expect(stripSrc).toMatch(/data-leaf-tool-tab-strip=["']true["']/);
    expect(stripSrc).toMatch(/aria-label=\{label\}/);
    expect(chromeSrc).not.toMatch(/chat-open-note/);
    expect(chromeSrc).not.toMatch(/UNIT_TOOL_PANELS/);
    expect(arriveSrc).toMatch(
      /export const OPEN_NOTE\s*=\s*[\s\S]*?data-testid=["']chat-open-note["']/
    );
  });

  it('打开走 openToolInSession + note，不点 open-note-paper-strict', () => {
    expect(stripSrc).toMatch(/openToolInSession\(leaf\.sessionId,\s*pid\)/);
    expect(stripSrc).toMatch(/onClick=\{\(\)\s*=>\s*openPanel\(id\)\}/);
    expect(openToolSrc).toMatch(
      /export function openToolInSession\(\s*sessionId:\s*string,\s*panelId:\s*string/
    );
    expect(openToolSrc).not.toMatch(/note\s*:\s*['"]/);
    expect(chromeSrc).not.toMatch(/open-note-paper-strict/);
    expect(stripSrc).not.toMatch(/open-note-paper-strict/);
    expect(treeSrc).not.toMatch(/open-note-paper-strict/);
    expect(openToolSrc).not.toMatch(/open-note-paper-strict/);
    expect(arriveSrc).not.toMatch(/open-note-paper-strict/);
    expect(arriveSrc).toMatch(
      /openToolInSession\?[\s\S]*?open\(sid,\s*['"]note['"]\)/
    );
  });

  it('chat 叶仍挂 UnitChromeActions 覆盖层；工具钮在坞头', () => {
    expect(treeSrc).toMatch(/import\s+\{\s*UnitChromeActions\s*\}/);
    expect(treeSrc).toMatch(
      /isChat\s*\?\s*\([\s\S]*?<UnitChromeActions[\s\S]*?activeSessionId=\{sessionForPanel\}/
    );
    expect(treeSrc).toMatch(
      /openToolInSession\(\s*targetSessionId,\s*panelId\s*\)/
    );
    expect(stripSrc).toMatch(/viewRegistry\.getView\(id\)/);
  });
});
