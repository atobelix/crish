/**
 * §6 写必可读回：生产路径必须调用 loadEmergencyDraftSync（防假绿）
 *
 * 单测里「能 load」≠ 产品挂载会 load。本文件用源码契约锁住对称读回。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PERSIST = path.resolve(__dirname, './useNoteTextPersistence.ts');
const PANEL = path.resolve(__dirname, './NotePaperStrictPanel.tsx');

describe('§6 emergency draft write⇔read production wiring', () => {
  it('useNoteTextPersistence 生产 effect 调用 loadEmergencyDraftSync（非仅 export）', () => {
    const src = fs.readFileSync(PERSIST, 'utf8');
    // 定义 + 至少一处生产调用
    expect(src).toMatch(/export function loadEmergencyDraftSync/);
    // 挂载读回：赋值给 drafts 的调用（排除 export function 行）
    const callMatches = [
      ...src.matchAll(/const drafts = loadEmergencyDraftSync\(docId\)/g),
    ];
    expect(callMatches.length).toBeGreaterThanOrEqual(1);
    // 与 beforeunload 写入对称：同文件仍有 saveEmergencyDraftSync
    expect(src).toMatch(/saveEmergencyDraftSync\(docId,\s*emergencyDrafts\)/);
    // hydrateReady 门闩，避免 loading 假读回
    expect(src).toMatch(/hydrateReady/);
    expect(src).toMatch(/if \(!hydrateReady\) return/);
  });

  it('NotePaperStrictPanel 生产挂载接线：hydrateReady + overlayEmergencyDraftTexts + displayBlocks', () => {
    const src = fs.readFileSync(PANEL, 'utf8');
    expect(src).toMatch(/overlayEmergencyDraftTexts/);
    expect(src).toMatch(/hydrateReady/);
    expect(src).toMatch(/emergencyDrafts/);
    expect(src).toMatch(/displayBlocks/);
    // 权威 blocks 仍传入 persistence；展示走 displayBlocks
    expect(src).toMatch(/useNoteTextPersistence\(\{[\s\S]*?blocks,/);
    expect(src).toMatch(/blocks=\{displayBlocks\}/);
  });
});
