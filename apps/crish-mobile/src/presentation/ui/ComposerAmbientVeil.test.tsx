// ComposerAmbientVeil 单元测试：五阶 Hermite 样条停点、深色短路、穿透与无障碍断言。
import { StyleSheet } from 'react-native';
import { act, render } from '@testing-library/react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { resetThemeModeForTest, setThemeMode } from '@/adapters/platform/theme';
import {
  ComposerAmbientVeil,
  DEFAULT_VEIL_HEIGHT,
  VEIL_STOPS,
} from './ComposerAmbientVeil';

function findNodes(
  node: ReactTestRendererJSON | string | null,
  predicate: (n: ReactTestRendererJSON) => boolean
): ReactTestRendererJSON[] {
  const result: ReactTestRendererJSON[] = [];
  function walk(curr: ReactTestRendererJSON | string | null) {
    if (!curr || typeof curr === 'string') return;
    if (predicate(curr)) result.push(curr);
    for (const child of curr.children ?? []) {
      walk(child);
    }
  }
  walk(node);
  return result;
}

describe('ComposerAmbientVeil（方案 24：宏观贯穿环境遮蔽光晕）', () => {
  beforeEach(async () => {
    await act(async () => {
      resetThemeModeForTest();
      setThemeMode('light');
    });
  });

  afterEach(async () => {
    await act(async () => {
      resetThemeModeForTest();
    });
  });

  it('浅色模式下正确渲染全宽容器与 5 阶 Hermite 平滑停点', async () => {
    const view = await render(<ComposerAmbientVeil />);
    const root = view.getByTestId('composer-ambient-veil', {
      includeHiddenElements: true,
    });
    expect(root).toBeTruthy();

    // 几何拓扑断言：绝对定位在浮动容器顶缘向上 28dp，贯穿全宽
    const flatStyle = StyleSheet.flatten(root.props.style);
    expect(flatStyle.position).toBe('absolute');
    expect(flatStyle.left).toBe(0);
    expect(flatStyle.right).toBe(0);
    expect(flatStyle.top).toBe(-DEFAULT_VEIL_HEIGHT);
    expect(flatStyle.height).toBe(DEFAULT_VEIL_HEIGHT);

    // 穿透与无障碍隔离
    expect(root.props.pointerEvents).toBe('none');
    expect(root.props.accessibilityElementsHidden).toBe(true);
    expect(root.props.importantForAccessibility).toBe('no');

    // SVG 结构完整性断言（Svg, Defs, LinearGradient, Rect）
    const json = view.toJSON() as ReactTestRendererJSON;
    expect(findNodes(json, (n) => n.type === 'RNSVGSvgView')).toHaveLength(1);
    expect(findNodes(json, (n) => n.type === 'RNSVGDefs')).toHaveLength(1);
    const gradients = findNodes(json, (n) => n.type === 'RNSVGLinearGradient');
    expect(gradients).toHaveLength(1);
    expect(findNodes(json, (n) => n.type === 'RNSVGRect')).toHaveLength(1);

    // react-native-svg 将 5 个 Stop 编译为底层 [offset0, color0, ... offset4, color4]
    const firstGradient = gradients[0];
    expect(firstGradient).toBeDefined();
    const rawGradient = ((firstGradient?.props as { gradient?: number[] })
      ?.gradient ?? []) as number[];
    expect(rawGradient).toHaveLength(10);

    // 验证 5 个停点的 offset：[0, 0.25, 0.5, 0.75, 1]
    const extractedOffsets = [
      rawGradient[0],
      rawGradient[2],
      rawGradient[4],
      rawGradient[6],
      rawGradient[8],
    ];
    expect(extractedOffsets).toEqual([0, 0.25, 0.5, 0.75, 1]);

    // 验证 5 个停点的 ARGB alpha 通道（>> 24）对应 [0, 0.004, 0.016, 0.038, 0.06]
    // 0 -> 0; 1 -> 1/255 ≈ 0.004; 4 -> 4/255 ≈ 0.016; 10 -> 10/255 ≈ 0.039; 15 -> 15/255 ≈ 0.059
    const rawAlphas = [
      (rawGradient[1] ?? 0) >>> 24,
      (rawGradient[3] ?? 0) >>> 24,
      (rawGradient[5] ?? 0) >>> 24,
      (rawGradient[7] ?? 0) >>> 24,
      (rawGradient[9] ?? 0) >>> 24,
    ];
    expect(rawAlphas).toEqual([0, 1, 4, 10, 15]);

    // 导出的规格停点表双重校验
    expect(VEIL_STOPS.map((s) => s.opacity)).toEqual([
      0, 0.004, 0.016, 0.038, 0.06,
    ]);
    expect(VEIL_STOPS.map((s) => s.offset)).toEqual([
      '0%',
      '25%',
      '50%',
      '75%',
      '100%',
    ]);
  });

  it('支持自定义 height 参数', async () => {
    const customHeight = 32;
    const view = await render(<ComposerAmbientVeil height={customHeight} />);
    const root = view.getByTestId('composer-ambient-veil', {
      includeHiddenElements: true,
    });
    const flatStyle = StyleSheet.flatten(root.props.style);

    expect(flatStyle.top).toBe(-customHeight);
    expect(flatStyle.height).toBe(customHeight);
  });

  it('深色模式下短路输出 null（防止深色发灰脏斑）', async () => {
    await act(async () => {
      setThemeMode('dark');
    });
    const view = await render(<ComposerAmbientVeil />);
    expect(
      view.queryByTestId('composer-ambient-veil', {
        includeHiddenElements: true,
      })
    ).toBeNull();
    expect(view.toJSON()).toBeNull();
  });

  it('退化态保护：高度 <= 0 时短路输出 null', async () => {
    const view = await render(<ComposerAmbientVeil height={0} />);
    expect(
      view.queryByTestId('composer-ambient-veil', {
        includeHiddenElements: true,
      })
    ).toBeNull();
    expect(view.toJSON()).toBeNull();
  });

  it('常量导出表完整性与单调递增性断言', () => {
    expect(DEFAULT_VEIL_HEIGHT).toBe(28);
    expect(VEIL_STOPS).toHaveLength(5);
    for (let i = 1; i < VEIL_STOPS.length; i++) {
      const curr = VEIL_STOPS[i];
      const prev = VEIL_STOPS[i - 1];
      if (curr && prev) {
        expect(curr.opacity).toBeGreaterThan(prev.opacity);
      }
    }
  });
});
