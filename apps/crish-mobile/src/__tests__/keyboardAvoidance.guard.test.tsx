// 键盘避让契约守卫（键盘与输入体验审计 2026-11-02，防再发）：
//
// 故障复盘：edge-to-edge 启用后 Android 的 IME 改以 inset 下发、窗口不再
// resize，而全仓仅有的两处 KeyboardAvoidingView（Screen / Sheet）把 Android
// 的 behavior 写成 undefined —— RN 内置 KAV 就此在 Android 上恒为 no-op，
// 会话页 composer 被键盘整段遮挡（用户投诉本体）。失效全程无任何测试变红，
// 因为旧契约对 KAV 零断言。本文件以「源码黑名单 + 单源断言 + 组件契约」
// 三面钉死：
//   1) KeyboardAvoidingView 只许来自 react-native-keyboard-controller，
//      且使用处必须显式给出字符串 behavior（禁 undefined / 禁平台三元回退）；
//   2) 键盘高度单源：非测试源码中不得再出现 RN Keyboard 事件订阅
//      （Keyboard.addListener）——唯一生产者是根布局的 KeyboardProvider，
//      useKeyboardHeight 只许是它的投影；
//   3) 组件契约：Android 平台 mock 下 Screen / Sheet 的避让容器仍带
//      behavior="padding"（旧实现在此场景恰为 undefined，即故障形态）。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { Platform, View } from 'react-native';
import { render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { Screen } from '../presentation/ui/Screen';
import { Sheet } from '../presentation/ui/Sheet';

// 本文件以哨兵组件覆盖全局 jest.setup 的库 mock：透传 props 到 View，
// 使契约能断言宿主传给避让容器的确切 props（behavior 等）。断言走
// toJSON 树遍历（与 roundButton 守卫同款），在哨兵 mock 与库自带 mock
// （KAV 直替 View、props 同样落到宿主节点）两种情形下都成立。
jest.mock('react-native-keyboard-controller', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View: RNView, ScrollView: RNScrollView } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const pass =
    (Base: React.ElementType) =>
    (props: Record<string, unknown> & { children?: ReactNode }) =>
      React.createElement(Base, props, props.children);
  const state = { height: 0, isVisible: false };
  return {
    KeyboardProvider: (props: { children?: ReactNode }) =>
      React.createElement(React.Fragment, null, props.children),
    KeyboardAvoidingView: pass(RNView),
    KeyboardStickyView: pass(RNView),
    KeyboardAwareScrollView: pass(RNScrollView),
    useKeyboardState: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
    useKeyboardHandler: () => {},
    KeyboardController: {
      state: () => ({ ...state }),
      isVisible: () => false,
      dismiss: jest.fn(async () => {}),
      setInputMode: jest.fn(),
      preload: jest.fn(),
    },
    KeyboardEvents: {
      addListener: jest.fn(() => ({ remove: jest.fn() })),
    },
  };
});

/** 遍历渲染树，收集全部节点的 props（字符串子节点跳过） */
function allProps(
  node: ReactTestRendererJSON | string | null
): Record<string, unknown>[] {
  if (!node || typeof node === 'string') return [];
  const out: Record<string, unknown>[] = [
    (node.props ?? {}) as Record<string, unknown>,
  ];
  for (const child of node.children ?? []) out.push(...allProps(child));
  return out;
}

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['app', 'src'];

function collectFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return collectFiles(full);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) return [];
    return [full];
  });
}

/** 在单份源码里找键盘避让违规，返回违规描述列表（自检与全仓扫描共用） */
export function findKeyboardAvoidanceViolations(src: string): string[] {
  const out: string[] = [];
  // RN 内置 KAV 导入（具名 / 别名均算）：edge-to-edge 下 Android 恒 no-op
  const importRe =
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]react-native['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src))) {
    if (/\bKeyboardAvoidingView\b/.test(m[1]!)) {
      out.push(
        "KeyboardAvoidingView 自 'react-native' 导入（内置版 Android 恒 no-op，必须用 react-native-keyboard-controller）"
      );
    }
  }
  // behavior 表达式里出现 undefined（旧故障的精确形态，含平台三元回退）
  if (/behavior\s*=\s*\{[^}]*\bundefined\b/.test(src)) {
    out.push('KeyboardAvoidingView 的 behavior 表达式含 undefined');
  }
  // 每个 KAV 使用处必须显式给字符串 behavior
  const useRe = /<KeyboardAvoidingView\b/g;
  while ((m = useRe.exec(src))) {
    const tag = src.slice(m.index, m.index + 500);
    if (
      !/behavior\s*=\s*"(padding|height|position|translate-with-padding)"/.test(
        tag
      )
    ) {
      out.push('KeyboardAvoidingView 使用处未显式给出字符串 behavior');
    }
  }
  // 单源：RN 键盘事件订阅 = 第二个键盘高度生产者
  if (/\bKeyboard\s*\.\s*addListener\s*\(/.test(src)) {
    out.push(
      '直接订阅 RN Keyboard 事件（键盘高度单源 = KeyboardProvider，消费走 useKeyboardState / useKeyboardHeight）'
    );
  }
  return out;
}

describe('键盘避让守卫 · 扫描器自检', () => {
  it('肇事样本：RN 导入 + Android behavior undefined 被拦', () => {
    const bad = `
      import { KeyboardAvoidingView, Platform } from 'react-native';
      export const Demo = () => (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} />
      );
    `;
    expect(findKeyboardAvoidanceViolations(bad).length).toBeGreaterThanOrEqual(
      2
    );
  });

  it('第二生产者样本：Keyboard.addListener 被拦', () => {
    const bad = `
      import { Keyboard } from 'react-native';
      Keyboard.addListener('keyboardDidShow', () => {});
    `;
    expect(findKeyboardAvoidanceViolations(bad).length).toBeGreaterThan(0);
  });

  it('合法样本：库版 KAV + 显式 behavior 放行', () => {
    const good = `
      import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
      export const Demo = () => (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" />
      );
    `;
    expect(findKeyboardAvoidanceViolations(good)).toEqual([]);
  });
});

describe('键盘避让守卫 · 全仓扫描', () => {
  it('app/ 与 src/ 无 RN 版 KAV、无 undefined behavior、无第二键盘源', () => {
    const problems: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of collectFiles(join(ROOT, dir))) {
        const src = readFileSync(file, 'utf8');
        for (const v of findKeyboardAvoidanceViolations(src)) {
          problems.push(`${relative(ROOT, file).split(sep).join('/')}: ${v}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('单源落点：useKeyboardHeight 是 KeyboardProvider 的投影而非事件订阅', () => {
    const src = readFileSync(
      join(ROOT, 'src/adapters/platform/useKeyboardHeight.ts'),
      'utf8'
    );
    expect(src).toContain("from 'react-native-keyboard-controller'");
    expect(src).toContain('useKeyboardState');
    expect(src).not.toContain('addListener');
  });

  it('根布局挂 KeyboardProvider 且 app.json 显式 resize', () => {
    const layout = readFileSync(join(ROOT, 'app/_layout.tsx'), 'utf8');
    expect(layout).toContain('KeyboardProvider');
    const appJson = JSON.parse(
      readFileSync(join(ROOT, 'app.json'), 'utf8')
    ) as {
      expo: { android: { softwareKeyboardLayoutMode?: string } };
    };
    expect(appJson.expo.android.softwareKeyboardLayoutMode).toBe('resize');
  });

  it('使用点各就其位：StickyView 承载会话 composer、AwareScrollView 承载表单', () => {
    const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
    const session = read('src/presentation/screens/sessionDetailScreen.tsx');
    expect(session).toContain('KeyboardStickyView');
    expect(session).toContain("from 'react-native-keyboard-controller'");
    for (const rel of [
      'src/presentation/components/localChat/LocalProviderEditView.tsx',
      'src/presentation/account/accountProfileScreen.tsx',
    ]) {
      expect(read(rel)).toContain('KeyboardAwareScrollView');
    }
    const home = read('src/presentation/screens/homeScreen.tsx');
    expect(home).toContain('keyboardDismissMode="on-drag"');
    // 本地对话已并入统一会话屏（sessionDetailScreen），其键盘纪律
    // 由上方会话断言（KeyboardStickyView）覆盖（U5 删除旧本地视图）。
  });
});

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

describe('键盘避让守卫 · 组件契约（Android 平台 mock）', () => {
  const originalOS = Platform.OS;
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
  });
  afterEach(() => {
    jest.replaceProperty(Platform, 'OS', originalOS);
  });

  it('Screen avoidKeyboard：Android 下避让容器 behavior 仍为 padding（旧实现此处为 undefined）', async () => {
    const view = await render(
      <Screen avoidKeyboard>
        <View />
      </Screen>,
      { wrapper: Providers }
    );
    const behaviors = allProps(view.toJSON()).map((p) => p.behavior);
    expect(behaviors).toContain('padding');
  });

  it('Screen 未开 avoidKeyboard 时不渲染避让容器', async () => {
    const view = await render(
      <Screen>
        <View />
      </Screen>,
      { wrapper: Providers }
    );
    const behaviors = allProps(view.toJSON()).map((p) => p.behavior);
    expect(behaviors).not.toContain('padding');
  });

  it('Sheet：Android 下 Modal 内避让容器 behavior 为 padding', async () => {
    const view = await render(
      <Sheet visible title="标题" onClose={() => {}}>
        <View />
      </Sheet>,
      { wrapper: Providers }
    );
    const behaviors = allProps(view.toJSON()).map((p) => p.behavior);
    expect(behaviors).toContain('padding');
  });
});
