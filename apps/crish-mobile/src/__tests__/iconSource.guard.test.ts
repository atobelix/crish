/**
 * 图标出处守卫（2026-11-02 图标对齐批）：钉住「移动端图标全集同源
 * Hugeicons」不被后续批次悄悄破坏——
 * 1. 名称表规模与 ICON_NAME_LIMIT 一致（增删图标必须同步改限额）。
 * 2. 每个图标名恰属一类：Hugeicons 出处登记（HUGEICONS_SOURCED_ICONS）
 *    或已知例外集合（裁决符号 SHARP_ICONS + 原型无对应 glyph 的 App
 *    功能图标）。新增摘录漏登记出处、或自创 glyph 混入，一律红。
 * 3. 选型修正不回退：Composer 语音钮必须用 audio-wave（原型
 *    AudioWave01 声波条纹）而非 mic glyph；设置字体行必须用 text-font
 *    而非 sort 充数。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  HUGEICONS_SOURCED_ICONS,
  ICON_NAME_LIMIT,
  ICON_PATHS,
  SHARP_ICONS,
} from '../presentation/ui/iconPaths';

/** 未登记 Hugeicons 出处的合法例外（与 iconPaths.ts 文件头口径一致）。 */
const NON_HUGEICONS_EXCEPTIONS: ReadonlySet<string> = new Set<string>([
  ...SHARP_ICONS,
  'send',
  'eye',
  'eye-off',
  'refresh',
  'alert-circle',
  'terminal',
  'folder-open',
  'sparkles',
]);

const readSource = (rel: string): string =>
  readFileSync(join(__dirname, '..', ...rel.split('/')), 'utf8');

describe('icon source guard (Hugeicons 同源)', () => {
  it('名称表规模与 ICON_NAME_LIMIT 一致', () => {
    expect(Object.keys(ICON_PATHS)).toHaveLength(ICON_NAME_LIMIT);
  });

  it('每个图标恰有 Hugeicons 出处登记或属已知例外，且两类不重叠、无悬空登记', () => {
    const names = Object.keys(ICON_PATHS);
    for (const name of names) {
      const sourced = Object.prototype.hasOwnProperty.call(
        HUGEICONS_SOURCED_ICONS,
        name
      );
      const excepted = NON_HUGEICONS_EXCEPTIONS.has(name);
      expect(sourced !== excepted).toBe(true);
    }
    for (const name of Object.keys(HUGEICONS_SOURCED_ICONS)) {
      expect(names).toContain(name);
    }
    for (const name of NON_HUGEICONS_EXCEPTIONS) {
      expect(names).toContain(name);
    }
  });

  it('出处登记值与全部 path 数据非空', () => {
    for (const glyph of Object.values(HUGEICONS_SOURCED_ICONS)) {
      expect(typeof glyph).toBe('string');
      expect((glyph as string).length).toBeGreaterThan(0);
    }
    for (const d of Object.values(ICON_PATHS)) {
      expect(d.length).toBeGreaterThan(0);
    }
    expect(ICON_PATHS['audio-wave']).toContain('M9 3v18');
    expect(ICON_PATHS['qr-code']).toContain('M2 12h20');
  });

  it('Composer 无语音钮（2026-11-03 用户裁决删除）：audio-wave 与 mic glyph 均不在场，长按输入为唯一语音入口', () => {
    const composer = readSource('presentation/ui/Composer.tsx');
    expect(composer).not.toContain('name="audio-wave"');
    expect(composer).not.toContain('name="mic"');
  });

  it('设置字体行用 text-font，不再拿 sort 充数', () => {
    const settings = readSource(
      'presentation/components/settings/SettingsScreenView.tsx'
    );
    expect(settings).toContain('name="text-font"');
    expect(settings).not.toContain('name="sort"');
  });
});
