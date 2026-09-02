/**
 * 维 05 点击路径 grep：窗格 UI 不得再写死轨。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const FILES = [
  './PaneHeader.tsx',
  './TreeLeafPanel.tsx',
  './BinaryTreeWorkspace.tsx',
  './LeafToolTabStrip.tsx',
  '../chat-card/UnitChromeActions.tsx',
  '../sidebar/useSidebarContextMenu.ts',
] as const;

const FORBIDDEN = [
  'setLeafSessionId',
  'bindActiveChatLeafSession',
  'tabsForUnit',
  'applyDockToTree',
  'openNewDraftTab',
  'removeSessionUnitFromTree',
];

describe('维 05 窗格 UI 单写 · 源码钉', () => {
  it('点击路径零死轨符号', () => {
    for (const rel of FILES) {
      const src = readFileSync(join(DIR, rel), 'utf8');
      for (const token of FORBIDDEN) {
        expect(src, `${rel} 含 ${token}`).not.toMatch(new RegExp(token));
      }
    }
  });

  it('activateTab 调用带两个实参', () => {
    const pane = readFileSync(join(DIR, './PaneHeader.tsx'), 'utf8');
    const leaf = readFileSync(join(DIR, './TreeLeafPanel.tsx'), 'utf8');
    expect(pane).toMatch(/activateTab\(\s*leaf\.id\s*,\s*tab\.tabId\s*\)/);
    expect(leaf).toMatch(/activateTab\(\s*leaf\.id\s*,/);
  });

  it('侧栏分屏走 openSession，不 splitLeaf', () => {
    const src = readFileSync(
      join(DIR, '../sidebar/useSidebarContextMenu.ts'),
      'utf8'
    );
    expect(src).toMatch(/openSession/);
    expect(src).toMatch(/split:\s*'right'/);
    expect(src).not.toMatch(/splitLeaf/);
    expect(src).not.toMatch(/setLeafSessionId/);
  });
});
