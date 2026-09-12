/**
 * T5 存储幽灵读与零调用桩物理清退 — 负向断言（静态 fs 契约）。
 *
 * 断言下列旧物已被「物理切除」（而非注释 / 隐藏 / 兼容 shim 掩盖）：
 *   - localStorageApi.ts 不再存在 migrateLegacyKeys
 *   - themeStore.ts 不再存在 disposeSolarTimer
 *   - themeStore.ts 不再 re-export getDynamicSolarAdjustments（仅 themePersonalization 内部使用）
 *   - store/minimalConfig.ts 已被彻底物理删除（BLK-02 / ACT-305 消亡断言）
 *   - localStorageApi.ts 的 registeredKeys 真源仍然存在且可解析
 *
 * 采用 fs 静态断言（new URL(rel, import.meta.url)，不依赖 process.cwd）。
 * 若任一项被违反，对应 expect(...).not.toContain(...) / toContain(...) / existsSync
 * 将 FAIL，因此本测试不是「恒绿测试」。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_DIR = new URL('../', import.meta.url);

function readSource(rel: string): string {
  // 先赋中间变量再进 new URL——内联模板会被 vitest transform 破坏路径解析
  const target = new URL(rel, API_DIR);
  return readFileSync(target, 'utf8');
}

describe('T5 负向断言：确定的死面已被物理切除', () => {
  it('localStorageApi.ts 已物理删除 migrateLegacyKeys', () => {
    const src = readSource('localStorageApi.ts');
    expect(src).not.toContain('migrateLegacyKeys');
  });

  it('themeStore.ts 已物理删除 disposeSolarTimer', () => {
    const src = readSource('themeStore.ts');
    expect(src).not.toContain('disposeSolarTimer');
  });

  it('themeStore.ts 不再 re-export getDynamicSolarAdjustments', () => {
    const src = readSource('themeStore.ts');
    expect(src).not.toContain('getDynamicSolarAdjustments');
  });

  it('minimalConfig.ts 已被彻底物理切除（文件物理消亡且不可导入）', () => {
    // BLK-02 / ACT-305：升级为消亡物理不存在断言，杜绝 ENOENT 崩溃
    const targetPath = fileURLToPath(new URL('../store/minimalConfig.ts', API_DIR));
    expect(existsSync(targetPath)).toBe(false);
    expect(() => {
      readFileSync(targetPath, 'utf8');
    }).toThrow();
  });

  it('bootstrap-orchestrator.ts 已被彻底物理切除', () => {
    const targetPath = fileURLToPath(new URL('../../bootstrap-orchestrator.ts', API_DIR));
    expect(existsSync(targetPath)).toBe(false);
  });

  it('registeredKeys 真源仍然存在且可解析（未被误删）', () => {
    const src = readSource('localStorageApi.ts');
    expect(src).toContain('registeredKeys');
    expect(src).toContain('crish-layout-v1');
  });

  it('fontStore.ts 已物理清退 crish_fonts, crish_settings, conex_pi_settings', () => {
    const src = readSource('fontStore.ts');
    expect(src).not.toContain('crish_fonts');
    expect(src).not.toContain('crish_settings');
    expect(src).not.toContain('conex_pi_settings');
  });

  it('appMode.ts 已物理删除 crish_app_mode', () => {
    const src = readSource('appMode.ts');
    expect(src).not.toContain('crish_app_mode');
  });

  it('productMode.ts 已物理删除 crish_product_shell 与 crish_show_engine_settings', () => {
    const src = readSource('productMode.ts');
    expect(src).not.toContain('crish_product_shell');
    expect(src).not.toContain('crish_show_engine_settings');
  });

  it('codeBlockIndent.ts 已物理删除 crish_settings', () => {
    const src = readSource('codeBlockIndent.ts');
    expect(src).not.toContain('crish_settings');
  });
});
