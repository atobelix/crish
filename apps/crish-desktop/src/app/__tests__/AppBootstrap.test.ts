// @vitest-environment jsdom
/**
 * R9-T10：AppBootstrap useEffect 顺序测试（结构分析）
 *
 * Shell redesign 后：额外增加
 * - useLayoutEffect：waitLayoutTreeHydration + hydrateWorkspaceShell
 * - useEffect：layout-tree migration 等
 *
 * 本测试断言当前源码中 effect 数量与关键入口存在，避免回归丢 bootstrap。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface EffectEntry {
  type: 'useEffect' | 'useLayoutEffect';
  file: 'AppBootstrap.ts' | 'useEngineBootstrap.ts';
  line: number;
  bodyPreview: string;
}

const APP_PATH = resolve(__dirname, '../AppBootstrap.ts');
const ENGINE_PATH = resolve(__dirname, '../useEngineBootstrap.ts');
const APP_SRC = readFileSync(APP_PATH, 'utf-8');
const ENGINE_SRC = readFileSync(ENGINE_PATH, 'utf-8');

function extractEffects(src: string, file: EffectEntry['file']): EffectEntry[] {
  const results: EffectEntry[] = [];
  const re = /\b(useEffect|useLayoutEffect)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const type = m[1] as EffectEntry['type'];
    const line = src.slice(0, m.index).split('\n').length;
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth > 0 && i < src.length) {
      if (src[i] === '(') depth++;
      if (src[i] === ')') depth--;
      i++;
    }
    const body = src
      .slice(m.index + m[0].length, i - 1)
      .replace(/\s+/g, ' ')
      .slice(0, 120)
      .trim();
    results.push({ type, file, line, bodyPreview: body });
  }
  return results;
}

function buildCombinedOrder(): EffectEntry[] {
  const engine = extractEffects(ENGINE_SRC, 'useEngineBootstrap.ts');
  const app = extractEffects(APP_SRC, 'AppBootstrap.ts');
  return [...engine, ...app];
}

describe('AppBootstrap — 结构分析 (R9-T10 + shell hydrate)', () => {
  const combined = buildCombinedOrder();
  const app = extractEffects(APP_SRC, 'AppBootstrap.ts');
  const engine = extractEffects(ENGINE_SRC, 'useEngineBootstrap.ts');

  it('useEngineBootstrap 仍为 2 个 useEffect', () => {
    expect(engine).toHaveLength(2);
    expect(engine.every((e) => e.type === 'useEffect')).toBe(true);
  });

  it('AppBootstrap effect 数量（含 shell hydrate layout effect）', () => {
    // 2026-07 shell redesign：hydrateWorkspaceShell useLayoutEffect + migration useEffect
    // T06.10：E13 手动 resize class 双写已删除（WindowResizeBridge 接管）
    // PE-07 T07.4-B：+1（7b 旧明文密钥迁移 migrateLegacyProfiles）→ 18
    expect(app.length).toBeGreaterThanOrEqual(17);
    expect(app.length).toBe(18);
  });

  it('combined = engine + app', () => {
    expect(combined).toHaveLength(engine.length + app.length);
    expect(combined).toHaveLength(20);
  });

  it('useLayoutEffect：shell hydrate + project folder rebind', () => {
    const layoutEffects = app.filter((e) => e.type === 'useLayoutEffect');
    expect(layoutEffects).toHaveLength(2);
    const previews = layoutEffects.map((e) => e.bodyPreview).join(' | ');
    expect(previews).toMatch(/hydrateWorkspaceShell|waitLayoutTreeHydration/);
    expect(previews).toMatch(/rebind|projectStore/);
  });

  it('关键 bootstrap 入口仍存在', () => {
    const body = APP_SRC;
    expect(body).toContain('initLayoutStorePersistence');
    expect(body).toContain('bootstrapServices');
    expect(body).toContain('bootstrapStores');
    expect(body).toContain('hydrateWorkspaceShell');
    expect(body).toContain('waitLayoutTreeHydration');
    expect(body).toContain('pickWorkspaceFolder');
  });

  it('T06.10：E13 手动 window-resizing class 双写已删除（WindowResizeBridge 单一接管）', () => {
    const body = APP_SRC;
    expect(body).not.toContain('window-resizing');
    expect(body).not.toContain("classList.add('window-resizing')");
  });

  it('engine bootstrap 仍在 combined 前端', () => {
    expect(combined[0]?.file).toBe('useEngineBootstrap.ts');
    expect(combined[1]?.file).toBe('useEngineBootstrap.ts');
  });
});
