// 手感基建静态守卫（手感基建批自带）：
// 1. 触觉单门面：expo-haptics 只许 adapters/platform/haptics.ts 直引，业务代码
//    禁止散调用（交互审计 D2 / 工程审计 M-2 的收口纪律，防再分散）；
// 2. 减动效单信号：reanimated 的 useReducedMotion 只许共享实现
//    adapters/platform/useReducedMotion.ts 消费；AccessibilityInfo 的
//    isReduceMotionEnabled 只许触觉门面（静默门）与共享实现的历史口径之外——
//    实际只许门面一处；任何文件禁止再定义本地 useReduceMotion 函数
//    （Composer / SlideToConfirm 的两份手写重复即本批合并对象）；
// 3. 空间动画降级覆盖面：Sheet / Dialog / 抽屉 / Toast 必须消费共享信号
//    （新增空间动画组件应同步加入本名单并消费信号——静态可行的范围内钉死）。
// 读法与 workletSafety.guard 同：只读源码文本，注释行剔除后判定。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { sheetDragCloseDecision } from '../presentation/ui/Sheet';

const SRC_ROOT = join(__dirname, '..');
const APP_ROOT = join(SRC_ROOT, '..', 'app');

function collectSources(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSources(full));
    } else if (
      /\.tsx?$/.test(entry) &&
      !/\.test\.tsx?$/.test(entry) &&
      !entry.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const files = [...collectSources(SRC_ROOT), ...collectSources(APP_ROOT)].map(
  (full) => ({
    rel: relative(SRC_ROOT, full).split('\\').join('/'),
    code: stripComments(readFileSync(full, 'utf8')),
  })
);

describe('feelInfra guard · 触觉单门面', () => {
  it('expo-haptics 只许触觉门面 haptics.ts 导入', () => {
    const offenders = files
      .filter((f) => f.rel !== 'adapters/platform/haptics.ts')
      .filter((f) => /from\s+['"]expo-haptics['"]/.test(f.code))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('门面文件自身确实直引 expo-haptics（防守卫空转）', () => {
    const facade = files.find((f) => f.rel === 'adapters/platform/haptics.ts');
    expect(facade).toBeDefined();
    expect(/from\s+['"]expo-haptics['"]/.test(facade!.code)).toBe(true);
  });
});

describe('feelInfra guard · 触觉原生桥单门面 + 设置门（2026-11-03 裁决）', () => {
  it('crish-haptics 只许触觉门面 haptics.ts 导入', () => {
    const offenders = files
      .filter((f) => f.rel !== 'adapters/platform/haptics.ts')
      .filter((f) => /from\s+['"]crish-haptics['"]/.test(f.code))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('门面必须咨询设置组 haptics（震感设置控制、默认关的静态钉）', () => {
    const facade = files.find((f) => f.rel === 'adapters/platform/haptics.ts');
    expect(facade).toBeDefined();
    expect(facade!.code).toContain('settingsStore');
    expect(facade!.code).toContain('groups.haptics');
  });
});

describe('feelInfra guard · 减动效单信号', () => {
  it('isReduceMotionEnabled 只许触觉门面（静默门）读取', () => {
    const offenders = files
      .filter((f) => f.rel !== 'adapters/platform/haptics.ts')
      .filter((f) => f.code.includes('isReduceMotionEnabled'))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('reanimated 的 useReducedMotion 只许共享实现消费', () => {
    const offenders = files
      .filter((f) => f.rel !== 'adapters/platform/useReducedMotion.ts')
      .filter((f) =>
        /import\s*\{[^}]*\buseReducedMotion\b[^}]*\}\s*from\s+['"]react-native-reanimated['"]/.test(
          f.code
        )
      )
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('任何文件不得再定义本地 useReduceMotion 函数', () => {
    const offenders = files
      .filter((f) => f.rel !== 'adapters/platform/useReducedMotion.ts')
      .filter((f) => /function\s+useReduceMotion\b/.test(f.code))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

describe('feelInfra guard · 空间动画降级覆盖面', () => {
  const SPATIAL_FILES = [
    'presentation/ui/Sheet.tsx',
    'presentation/ui/Dialog.tsx',
    'presentation/ui/Toast.tsx',
    'presentation/components/drawer/CrishDrawerLayout.tsx',
  ];
  it.each(SPATIAL_FILES)('%s 消费共享减动效信号', (rel) => {
    const file = files.find((f) => f.rel === rel);
    expect(file).toBeDefined();
    expect(
      /from\s+['"]@\/adapters\/platform\/useReducedMotion['"]/.test(file!.code)
    ).toBe(true);
    expect(/\buseReducedMotion\s*\(/.test(file!.code)).toBe(true);
  });
});

describe('feelInfra guard · 分割线发丝口径（2026-11-02 裁决：更浅更细）', () => {
  // 行间分隔一律 hairline 色 + StyleSheet.hairlineWidth 发丝宽。下列点名面
  // 曾以 1dp 实宽绘制（同色下约为发丝的 3 倍视觉存在感、用户点名太明显），
  // 逐个钉住：必须消费 hairlineWidth 且不得回潮 1dp 底边宽。
  const HAIRLINE_DIVIDER_FILES = [
    'presentation/account/ui/NavRow.tsx',
    'presentation/components/sessions/ChatFlatItem.tsx',
    'presentation/components/sessions/LocalChatHubRow.tsx',
    'presentation/ui/ListRow.tsx',
    'presentation/ui/DropdownMenu.tsx',
    'presentation/account/accountSessionsScreen.tsx',
  ];
  it.each(HAIRLINE_DIVIDER_FILES)('%s 分隔线走发丝宽', (rel) => {
    const file = files.find((f) => f.rel === rel);
    expect(file).toBeDefined();
    expect(file!.code).toContain('StyleSheet.hairlineWidth');
    expect(file!.code).not.toMatch(/borderBottomWidth: 1\b/);
  });

  it('Markdown hr 走 hairline 色（不再用 borderStrong 重灰整行线）', () => {
    const file = files.find(
      (f) => f.rel === 'presentation/components/blocks/MarkdownText.tsx'
    );
    expect(file).toBeDefined();
    expect(file!.code).toMatch(
      /case 'hr':[\s\S]{0,240}backgroundColor: theme\.colors\.hairline/
    );
  });
});

describe('Sheet 手势关闭判定 sheetDragCloseDecision', () => {
  it('距离过阈（≥30%）→ 关闭', () => {
    expect(sheetDragCloseDecision(0.3, 0)).toBe(true);
    expect(sheetDragCloseDecision(0.55, 0)).toBe(true);
  });

  it('速度过阈（≥800dp/s）→ 关闭（距离不足亦关）', () => {
    expect(sheetDragCloseDecision(0.05, 800)).toBe(true);
    expect(sheetDragCloseDecision(0.05, 1400)).toBe(true);
  });

  it('距离与速度均不足 → 回弹', () => {
    expect(sheetDragCloseDecision(0.29, 799)).toBe(false);
    expect(sheetDragCloseDecision(0, 0)).toBe(false);
    expect(sheetDragCloseDecision(0.1, -300)).toBe(false);
  });
});
