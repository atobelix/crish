// @vitest-environment jsdom
/**
 * Stage 4：AppBootstrap 结构分析（收敛后）
 *
 * 变更要点：
 * - hydrateWorkspaceShell / waitLayoutTreeHydration 已上提至 UnifiedAppHydrationCoordinator；
 * - 启动期 getSettings + saveSettingsEx 反写已物理切除（REDLINE-402）；
 * - 双 rAF rebind 铲除，改 microtask 驱动；
 * - data-ui-size 重复属性写入删除（visualThemeController 单点）。
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
const BOOTSTRAP_STORES_PATH = resolve(__dirname, '../../store/bootstrapStores.ts');
const APP_SRC = readFileSync(APP_PATH, 'utf-8');
const ENGINE_SRC = readFileSync(ENGINE_PATH, 'utf-8');
const BOOTSTRAP_STORES_SRC = readFileSync(BOOTSTRAP_STORES_PATH, 'utf-8');

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

describe('AppBootstrap — Stage 4 结构收敛', () => {
  const combined = buildCombinedOrder();
  const app = extractEffects(APP_SRC, 'AppBootstrap.ts');
  const engine = extractEffects(ENGINE_SRC, 'useEngineBootstrap.ts');

  it('useEngineBootstrap 仍为 2 个 useEffect', () => {
    expect(engine).toHaveLength(2);
    expect(engine.every((e) => e.type === 'useEffect')).toBe(true);
  });

  it('AppBootstrap effect 收敛为 14（原 16：hydrate 上提 + data-ui-size 删除）', () => {
    expect(app.length).toBe(14);
  });

  it('combined = engine + app = 16', () => {
    expect(combined).toHaveLength(engine.length + app.length);
    expect(combined).toHaveLength(16);
  });

  it('hydrateWorkspaceShell 已上提至 Coordinator，AppBootstrap 不再持有', () => {
    expect(APP_SRC).not.toContain('hydrateWorkspaceShell');
    expect(APP_SRC).not.toContain('waitLayoutTreeHydration');
  });

  it('启动期禁止 saveSettingsEx 反写（REDLINE-402）；settings 水合由 Coordinator 独占', () => {
    expect(APP_SRC).not.toContain('saveSettingsEx');
    // 双偏好通道收口：AppBootstrap 不再发起 settings 启动水合 effect
    expect(APP_SRC).not.toContain('initApp');
    expect(APP_SRC).not.toMatch(/settings\.theme\s*=\s*localTheme/);
  });

  it('双 rAF 已铲除，rebind 改 microtask 驱动（ACT-405）', () => {
    expect(APP_SRC).not.toMatch(
      /requestAnimationFrame\s*\(\s*\(\)\s*=>\s*\{[\s\S]*requestAnimationFrame/
    );
    expect(APP_SRC).toContain('crish-project-changed');
    expect(APP_SRC).toContain('rebindSessionFolders');
    expect(APP_SRC).toContain('queueMicrotask');
  });

  it('data-ui-size 重复属性写入已删除（visualThemeController 单点）', () => {
    expect(APP_SRC).not.toContain('data-ui-size');
  });

  it('关键 bootstrap 入口仍存在', () => {
    expect(APP_SRC).toContain('initLayoutStorePersistence');
    expect(APP_SRC).toContain('bootstrapServices');
    expect(APP_SRC).toContain('bootstrapStores');
    expect(APP_SRC).toContain('pickWorkspaceFolder');
    expect(APP_SRC).toContain('initThemeProjection');
    expect(APP_SRC).toContain('initCodeIndentProjection');
    expect(APP_SRC).toContain('bootstrapFonts');
  });

  it('useLayoutEffect：仅剩 project folder rebind', () => {
    const layoutEffects = app.filter((e) => e.type === 'useLayoutEffect');
    expect(layoutEffects).toHaveLength(1);
    expect(layoutEffects[0]?.bodyPreview).toMatch(/rebind|projectStore/);
  });

  it('engine bootstrap 仍在 combined 前端', () => {
    expect(combined[0]?.file).toBe('useEngineBootstrap.ts');
    expect(combined[1]?.file).toBe('useEngineBootstrap.ts');
  });

  it('T-A-1：bootstrapStores 装配后快照桥已绑定', () => {
    expect(BOOTSTRAP_STORES_SRC).toContain('bindMessageSnapshotsOps(');
    expect(BOOTSTRAP_STORES_SRC).toContain('new MessageSnapshots()');
    expect(BOOTSTRAP_STORES_SRC).toContain("logger.warn('[Snapshots] bridge bind failed");
  });

  it('D5：AppBootstrap 无 layoutStore 自订阅', () => {
    expect(APP_SRC).not.toContain('useLayoutStore.subscribe');
    expect(APP_SRC).not.toContain('prevSessions');
    expect(APP_SRC).toContain('crish-project-changed');
    expect(APP_SRC).toContain('rebindSessionFolders');
  });
});
