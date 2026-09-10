/**
 * §5.2：计划条订阅 session store；删除 getSessionById 快照与 noopApproval
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WRAPPER = path.resolve(__dirname, './ChatComposerWrapper.tsx');
const RIBBONS = path.resolve(__dirname, './ChatStatusRibbons.tsx');

describe('§5.2 plan bar / ribbons subscribe session store', () => {
  it('ChatComposerWrapper uses useSessionStore not getSessionById snapshot', () => {
    const src = fs.readFileSync(WRAPPER, 'utf8');
    expect(src).toMatch(/useSessionStore/);
    expect(src).not.toMatch(/getSessionById/);
    expect(src).not.toMatch(/noopApproval/);
    expect(src).toMatch(/composer-above-approval-unavailable|composerAbove \?/);
  });

  it('ChatStatusRibbons uses useSessionStore not getSessionById snapshot', () => {
    const src = fs.readFileSync(RIBBONS, 'utf8');
    expect(src).toMatch(/useSessionStore/);
    expect(src).not.toMatch(/getSessionById/);
  });
});
