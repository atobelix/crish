// 按压过渡守卫（按压过渡统一批，2026-11-02 防回潮）：
//
// 纪律：全 App 按压引起的亮度 / 透明度 / 缩放变化必须带 120ms
// （duration.snappy）过渡——唯一合法实现 = ui/pressFeedback 的 usePressFade
// （overlayStyle / fadeStyle / pressScaleStyle）+ IconButton/ListRow 既有
// pressProgress 先例。瞬时反馈写法（pressed 三目换色、pressed 短路透明度、
// 瞬时 scale 跳变）在 presentation 全树（非测试）禁绝——本守卫源码扫描钉住，
// 命中即红。
//
// 口径同 noShadow / roundButton 守卫：整行注释剔除后扫描（行内尾注不剔除，
// 代码里的模式仍会命中）；`({ pressed })` 解构本身不禁止（可作事件态读），
// 但其在样式函数中的任何取用都落在下方两条禁型内。
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
// 扫描面 = presentation 全树 + expo-router 路由层 app/（路由层同样可能有交互面）
const SCAN_DIRS = ['src/presentation', 'app'];

/** 递归收集 presentation 下全部非测试 tsx */
function collectTsx(relDir: string): string[] {
  const abs = join(ROOT, relDir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const rel = `${relDir}/${name}`;
    if (name.endsWith('.test.tsx')) continue;
    if (name.endsWith('.tsx')) {
      out.push(rel);
      continue;
    }
    try {
      out.push(...collectTsx(rel));
    } catch {
      // 非目录（readdirSync 抛错）跳过
    }
  }
  return out;
}

/** 只看代码行（整行注释剔除），与 noShadow / roundButton 守卫同口径 */
function codeOf(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

const BANNED: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  {
    // pressed 三目取色（含跨行三目：pressed 换行后跟 ?）
    pattern: /pressed\s*\?/,
    label: 'pressed 三目（瞬时换色/换透明）',
  },
  {
    // pressed 短路（pressed && { opacity/scale/bg }）
    pattern: /pressed\s*&&/,
    label: 'pressed 短路（瞬时样式叠加）',
  },
];

describe('按压过渡守卫：presentation + app 全树零瞬时按压反馈', () => {
  const files = SCAN_DIRS.flatMap((dir) => collectTsx(dir));

  it('扫描面非空（目录约定不漂移）', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('src/presentation/ui/pressFeedback.tsx');
  });

  for (const rel of files) {
    it(`${rel} 无瞬时按压反馈`, () => {
      const code = codeOf(rel);
      for (const { pattern, label } of BANNED) {
        expect({ rel, label, hit: pattern.test(code) }).toEqual({
          rel,
          label,
          hit: false,
        });
      }
    });
  }

  it('共享原语在位：usePressFade 提供三种过渡形态 + 120ms 单源', () => {
    const code = codeOf('src/presentation/ui/pressFeedback.tsx');
    expect(code).toMatch(/overlayStyle/);
    expect(code).toMatch(/fadeStyle/);
    expect(code).toMatch(/pressScaleStyle/);
    expect(code).toMatch(/duration\.snappy/);
    // 模块级组件标识（运行时重建会丢动画节点）
    expect(code).toMatch(/createAnimatedComponent\(Pressable\)/);
  });
});
