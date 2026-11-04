// 圆形按钮结构契约（圆形按钮缺陷审计 2026-11-02，防回潮）：
// 缺陷 = 正方形圆盘 + borderRadius 9999 + elevation 同节点 → Android 填充/阴影
// 轮廓分裂出「外圆内八角」。定案结构：圆盘圆角恒为 直径/2 实值；floating 底层
// 为填充节点（填充单绘），阴影只许经 SoftShadow 在 Android 浅色下以独立 SVG
// 层渲染（SVG 软阴影收编定案 2026-11-02），原生阴影零容忍（渲染树零
// elevation / shadow*），深色区分走亮度台阶；按压走 120ms 叠层过渡。
// 本文件以渲染断言（真实样式值）+ 源码纪律（pill 仅剩胶囊/角标合法用途）
// 双面钉住，禁再回潮。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { Platform, StyleSheet } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import {
  darkTheme,
  resetThemeModeForTest,
  setThemeMode,
} from '../adapters/platform/theme';
// SVG 滤镜原语以探针宿主替身：真实 react-native-svg 的滤镜原语不把
// stdDeviation / floodOpacity 等规格 props 透出到渲染树 JSON（原生侧映射），
// 本守卫的渲染断言核的是 SoftShadow 的 authored 规格，故只替身滤镜原语
// 六件 + Filter/Defs 容器，其余（Svg / Rect / Path 等）保持真实模块。
jest.mock('react-native-svg', () => {
  const actual = jest.requireActual('react-native-svg');
  const React = jest.requireActual<typeof import('react')>('react');
  const probe = (tag: string) => (props: Record<string, unknown>) =>
    React.createElement(tag, props, props.children as React.ReactNode);
  return {
    __esModule: true,
    ...actual,
    Defs: probe('Defs'),
    Filter: probe('Filter'),
    FeGaussianBlur: probe('FeGaussianBlur'),
    FeFlood: probe('FeFlood'),
    FeOffset: probe('FeOffset'),
    FeComposite: probe('FeComposite'),
    FeMerge: probe('FeMerge'),
    FeMergeNode: probe('FeMergeNode'),
  };
});

import { AppHeader } from '../presentation/ui/AppHeader';
import { IconButton } from '../presentation/ui/IconButton';
import { Sheet } from '../presentation/ui/Sheet';
import { SoftShadow } from '../presentation/ui/SoftShadow';
import { SettingsSwitch } from '../presentation/components/settings/SettingsSwitch';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

type FlatStyle = Record<string, unknown>;

/** 解析节点 style（数组 / 函数式 Pressable style 均摊平为单对象） */
function flatStyle(node: ReactTestRendererJSON): FlatStyle {
  const raw = node.props?.style as unknown;
  const resolved =
    typeof raw === 'function'
      ? (raw as (s: { pressed: boolean }) => unknown)({ pressed: false })
      : raw;
  return (StyleSheet.flatten(resolved as never) ?? {}) as FlatStyle;
}

function walk(
  node: ReactTestRendererJSON | string | null,
  out: ReactTestRendererJSON[]
): void {
  if (!node || typeof node === 'string') return;
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
}

function allStyles(json: ReactTestRendererJSON | null): FlatStyle[] {
  const nodes: ReactTestRendererJSON[] = [];
  walk(json, nodes);
  return nodes.map(flatStyle);
}

type AnyProps = Record<string, unknown>;

/** 收集整棵渲染树的 props（SVG 滤镜断言用：按 prop 名识别滤镜节点，
 * 不依赖宿主组件类型名，与 keyboardAvoidance 守卫的 allProps 同范式） */
function allProps(json: ReactTestRendererJSON | null): AnyProps[] {
  const nodes: ReactTestRendererJSON[] = [];
  walk(json, nodes);
  return nodes.map((n) => (n.props ?? {}) as AnyProps);
}

/** 取某数值 prop 的全部取值（升序）：滤镜规格常量断言用 */
function numericProp(props: AnyProps[], key: string): number[] {
  return props
    .map((p) => p[key])
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
}

function discs(styles: FlatStyle[], size: number): FlatStyle[] {
  return styles.filter((s) => s.width === size && s.height === size);
}

describe('圆盘圆角 = 直径/2、填充节点（渲染断言）', () => {
  it('floating 默认 Ø38：填充节点圆角 19、整树零原生阴影无 9999', async () => {
    const view = await render(
      <IconButton
        name="menu"
        variant="floating"
        accessibilityLabel="打开侧栏"
        onPress={() => {}}
      />,
      { wrapper: Providers }
    );
    const styles = allStyles(view.toJSON());
    const d38 = discs(styles, 38);
    // 填充节点：独立底层、圆角 19、带填充底色（surfaceRaised 台阶）
    expect(
      d38.some((s) => s.borderRadius === 19 && s.backgroundColor !== undefined)
    ).toBe(true);
    // 按压叠层：同圆角、初始透明（120ms 过渡的起点）
    expect(d38.some((s) => s.borderRadius === 19 && s.opacity === 0)).toBe(
      true
    );
    // 原生阴影口径：整棵渲染树不得出现 elevation / shadow*
    expect(
      styles.some(
        (s) => s.elevation !== undefined || s.shadowOpacity !== undefined
      )
    ).toBe(false);
    expect(styles.some((s) => s.borderRadius === 9999)).toBe(false);
  });

  it('floating Ø40 变体（抽屉顶钮）：圆角 20', async () => {
    const view = await render(
      <IconButton
        name="bell"
        variant="floating"
        diameter={40}
        accessibilityLabel="通知中心"
        onPress={() => {}}
      />,
      { wrapper: Providers }
    );
    const styles = allStyles(view.toJSON());
    const d40 = discs(styles, 40);
    expect(
      d40.some((s) => s.borderRadius === 20 && s.backgroundColor !== undefined)
    ).toBe(true);
    expect(
      styles.some(
        (s) => s.elevation !== undefined || s.shadowOpacity !== undefined
      )
    ).toBe(false);
    expect(styles.some((s) => s.borderRadius === 9999)).toBe(false);
  });

  it('plain Ø44：圆角 22、无阴影节点、无 9999', async () => {
    const view = await render(
      <IconButton
        name="chevron-left"
        accessibilityLabel="返回"
        onPress={() => {}}
      />,
      { wrapper: Providers }
    );
    const styles = allStyles(view.toJSON());
    expect(
      discs(styles, 44).some((s) => s.borderRadius === 22 && s.opacity === 0)
    ).toBe(true);
    expect(
      styles.some(
        (s) => s.elevation !== undefined || s.shadowOpacity !== undefined
      )
    ).toBe(false);
    expect(styles.some((s) => s.borderRadius === 9999)).toBe(false);
  });

  it('AppHeader floating 返回：圆角软阴影悬浮白盘 Ø38、热区补至 44、按下回调', async () => {
    setThemeMode('light');
    const onBack = jest.fn();
    const view = await render(
      <AppHeader floating title="设置" onBack={onBack} />,
      { wrapper: Providers }
    );
    const back = view.getByTestId('header-back');
    // IconButton 以 hitSlop (44-38)/2 = 3 把 38 悬浮盘热区补至 44
    expect(back.props.hitSlop).toBe(3);
    fireEvent.press(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    const styles = allStyles(view.toJSON());
    // 悬浮盘：Ø38、圆角 19，与主界面一致的微浮雕圆角白钮
    expect(
      discs(styles, 38).some(
        (s) => s.borderRadius === 19 && s.backgroundColor !== undefined
      )
    ).toBe(true);
    resetThemeModeForTest();
    expect(
      styles.some(
        (s) => s.elevation !== undefined || s.shadowOpacity !== undefined
      )
    ).toBe(false);
    expect(styles.some((s) => s.borderRadius === 9999)).toBe(false);
  });

  it('SettingsSwitch 旋钮 Ø20：单层填充碟圆角 10、无阴影层，轨道保持胶囊', async () => {
    const view = await render(
      <SettingsSwitch value={false} onValueChange={() => {}} />,
      { wrapper: Providers }
    );
    const styles = allStyles(view.toJSON());
    // 只看带填充的碟层；20×20 的定位外框无填充无圆角，不计。原底层影碟
    // 已整节点删除（去阴影裁决），成盘的只剩单层填充碟
    const knob = discs(styles, 20).filter(
      (s) => s.backgroundColor !== undefined || s.elevation !== undefined
    );
    expect(knob.length).toBe(1);
    expect(knob.every((s) => s.borderRadius === 10)).toBe(true);
    expect(
      styles.some(
        (s) => s.elevation !== undefined || s.shadowOpacity !== undefined
      )
    ).toBe(false);
    // 轨道是胶囊（宽 > 高），pill 为其本职，不在禁用之列
    expect(
      styles.some(
        (s) => s.width === 44 && s.height === 26 && s.borderRadius === 9999
      )
    ).toBe(true);
  });

  it('Sheet 关闭钮 Ø30：圆角 15、点击关闭', async () => {
    const onClose = jest.fn();
    const view = await render(
      <Sheet visible title="标题" onClose={onClose}>
        <></>
      </Sheet>,
      { wrapper: Providers }
    );
    const close = view.getByTestId('sheet-close');
    const raw = close.props.style as unknown;
    const resolved =
      typeof raw === 'function'
        ? (raw as (s: { pressed: boolean }) => unknown)({ pressed: false })
        : raw;
    const flat = (StyleSheet.flatten(resolved as never) ?? {}) as FlatStyle;
    expect(flat.width).toBe(30);
    expect(flat.height).toBe(30);
    expect(flat.borderRadius).toBe(15);
    fireEvent.press(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SoftShadow 收编契约（Android 平台 mock + 主题切换）', () => {
  const originalOS = Platform.OS;
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
  });
  afterEach(() => {
    jest.replaceProperty(Platform, 'OS', originalOS);
    resetThemeModeForTest();
  });

  it('浅色：floating 圆钮经 SoftShadow 出两层滤镜、合并不含源图形、填充单绘', async () => {
    setThemeMode('light');
    const view = await render(
      <IconButton
        name="menu"
        variant="floating"
        accessibilityLabel="打开侧栏"
        onPress={() => {}}
      />,
      { wrapper: Providers }
    );
    // 两层高斯：σ3（近层 dy0 各向同性）+ σ8（远层 dy2 微下沉），α0.008 / 0.012（严格对标原型 --btn-shadow）
    const props = allProps(view.toJSON());
    expect(numericProp(props, 'stdDeviation')).toEqual([3, 8]);
    expect(numericProp(props, 'floodOpacity')).toEqual([0.008, 0.012]);
    // 投影链：每层投影 s1/s2 各被其内渗切除（operator="out"）消费一次、
    // 切除结果 t1/t2 各被合并消费一次；源图形不入输出——填充归填充碟单绘
    const chainIns = props
      .map((p) => p.in)
      .filter((v) => v === 's1' || v === 's2' || v === 't1' || v === 't2');
    expect(chainIns.sort()).toEqual(['s1', 's2', 't1', 't2']);
    expect(props.filter((p) => p.operator === 'out').length).toBe(2);
    expect(props.some((p) => p.in === 'SourceGraphic')).toBe(false);
    // 填充碟：Android 浅色 glass 面孔 = 半透明白（单一绘制点）
    const styles = allStyles(view.toJSON());
    expect(
      discs(styles, 38).some(
        (s) => s.backgroundColor === 'rgba(255,255,255,0.82)'
      )
    ).toBe(true);
    // 原生阴影仍零容忍
    expect(
      styles.some(
        (s) => s.elevation !== undefined || s.shadowOpacity !== undefined
      )
    ).toBe(false);
  });

  it('深色：SoftShadow 不出阴影层，填充回归 surfaceRaised 亮度台阶', async () => {
    setThemeMode('dark');
    const view = await render(
      <IconButton
        name="menu"
        variant="floating"
        accessibilityLabel="打开侧栏"
        onPress={() => {}}
      />,
      { wrapper: Providers }
    );
    const props = allProps(view.toJSON());
    expect(numericProp(props, 'stdDeviation')).toEqual([]);
    expect(numericProp(props, 'floodOpacity')).toEqual([]);
    const styles = allStyles(view.toJSON());
    expect(
      discs(styles, 38).some(
        (s) => s.backgroundColor === darkTheme.colors.surfaceRaised
      )
    ).toBe(true);
  });

  it('SoftShadow 直测：规格常量在渲染树上可核', async () => {
    setThemeMode('light');
    const view = await render(
      <SoftShadow width={38} height={38} borderRadius={19} />
    );
    const props = allProps(view.toJSON());
    expect(numericProp(props, 'stdDeviation')).toEqual([3, 8]);
    // 投影链同上：s1/s2 经内渗切除 → t1/t2 入合并，各消费恰一次
    const chainIns = props
      .map((p) => p.in)
      .filter((v) => v === 's1' || v === 's2' || v === 't1' || v === 't2');
    expect(chainIns.sort()).toEqual(['s1', 's2', 't1', 't2']);
  });
});

describe('源码纪律：pill 仅剩合法用途', () => {
  const ROOT = join(__dirname, '..', '..');
  /** 只看代码行（整行注释剔除），与 styleTokens 守卫同口径 */
  function codeOf(rel: string): string {
    return readFileSync(join(ROOT, rel), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  }
  const pillUses = (rel: string) =>
    (codeOf(rel).match(/radius\.pill/g) ?? []).length;

  it('theme.ts：pill 定义旁有「正方形圆盘禁用」注释', () => {
    const src = readFileSync(
      join(ROOT, 'src/adapters/platform/theme.ts'),
      'utf8'
    );
    expect(src).toMatch(/正方形圆盘禁用/);
  });

  it('IconButton：pill 仅剩角标胶囊一处，盘面走 diameter / 2', () => {
    const rel = 'src/presentation/ui/IconButton.tsx';
    expect(pillUses(rel)).toBe(1);
    expect(codeOf(rel)).toMatch(/diameter \/ 2/);
  });

  it('AppHeader：手搓返回盘已除，无 pill、无 backCircle', () => {
    const rel = 'src/presentation/ui/AppHeader.tsx';
    expect(pillUses(rel)).toBe(0);
    expect(codeOf(rel)).not.toMatch(/backCircle/);
  });

  it('Sheet：pill 仅剩拖拽把手（胶囊条）一处，关闭钮走 sheetClose / 2', () => {
    const rel = 'src/presentation/ui/Sheet.tsx';
    expect(pillUses(rel)).toBe(1);
    expect(codeOf(rel)).toMatch(/sheetClose \/ 2/);
  });

  it('SettingsSwitch：pill 仅剩轨道胶囊一处，旋钮走 KNOB_SIZE / 2', () => {
    const rel = 'src/presentation/components/settings/SettingsSwitch.tsx';
    expect(pillUses(rel)).toBe(1);
    expect(codeOf(rel)).toMatch(/KNOB_SIZE \/ 2/);
  });

  it('IconButton：step 台阶盘在 tone 级抑制 SoftShadow（A2 无影定案）', () => {
    const rel = 'src/presentation/ui/IconButton.tsx';
    expect(codeOf(rel)).toMatch(/tone !== 'step'/);
    expect(codeOf(rel)).toMatch(/tone === 'step'/);
  });

  it("全域：'surface' tone 已物理删除（tone 字面零命中）", () => {
    // 'surface' 是台阶盘的前身档位（A2 以 'step' 取代并删除），不得以
    // 比较式 / JSX 属性任何形式回潮（注释行剔除口径与 codeOf 同）
    const hits: string[] = [];
    const scan = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          scan(p);
        } else if (/\.tsx?$/.test(name)) {
          const code = readFileSync(p, 'utf8')
            .split(/\r?\n/)
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join('\n');
          if (/tone\s*===\s*'surface'|tone\s*=\s*"surface"/.test(code)) {
            hits.push(p);
          }
        }
      }
    };
    scan(join(ROOT, 'src/presentation'));
    scan(join(ROOT, 'src/adapters'));
    expect(hits).toEqual([]);
  });
});
