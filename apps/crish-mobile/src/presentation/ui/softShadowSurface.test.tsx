// 容器软阴影面渲染结构测试（容器外阴影批的验证资产）：
// 断言 SoftShadowSurface 的**渲染契约**——填充单点（圆角/底色/fillStyle
// 透传）、children 可见、外层不裁剪（阴影出血的架构约束：host 若被
// overflow hidden 剪掉，投影将不可见且无任何报错——必须结构级钉住）。
// SVG 投影层的行为（预设规格/短路口径）由 noShadow.guard 源码钉版 +
// 真机像素采样验证（2026-11-02 四档采样记录），本文件不重复 mock SVG。
import { StyleSheet, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { lightTheme } from '@/adapters/platform/theme';
import { SoftShadowSurface } from './SoftShadowSurface';

const theme = lightTheme;

function flat(node: { props: { style?: unknown } }): Record<string, unknown> {
  return StyleSheet.flatten(node.props.style as never) ?? {};
}

describe('SoftShadowSurface：渲染契约', () => {
  it('填充层落位：圆角/底色/fillStyle 透传，children 可见', async () => {
    const view = await render(
      <SoftShadowSurface
        testID="surface"
        preset="menu"
        borderRadius={theme.radius.menu}
        fill={theme.colors.surfaceRaised}
        fillStyle={{ paddingHorizontal: theme.space.md }}
      >
        <Text>内容</Text>
      </SoftShadowSurface>
    );
    const style = flat(view.getByTestId('surface-fill'));
    expect(style.borderRadius).toBe(theme.radius.menu);
    expect(style.backgroundColor).toBe(theme.colors.surfaceRaised);
    expect(style.overflow).toBe('hidden');
    expect(style.paddingHorizontal).toBe(theme.space.md);
    expect(view.getByText('内容')).toBeTruthy();
  });

  it('外层不裁剪（overflow visible）：阴影出血区不被剪掉的架构约束', async () => {
    const view = await render(
      <SoftShadowSurface
        testID="surface"
        preset="button"
        borderRadius={8}
        fill={theme.colors.surfaceRaised}
      />
    );
    // host 自身不得含 overflow: hidden（RN 默认 visible 不落样式——出现即回归）
    expect(flat(view.getByTestId('surface')).overflow).not.toBe('hidden');
    // 外层不得染底：填充单点在内层（浅层染底会在出血区露出一块实色）
    expect(flat(view.getByTestId('surface')).backgroundColor).toBeUndefined();
  });

  it('填充单点结构：内层为 View 承载（RNTL 树 type 为字符串名）', async () => {
    const view = await render(
      <SoftShadowSurface
        testID="surface"
        preset="menu"
        borderRadius={8}
        fill={theme.colors.surfaceRaised}
      />
    );
    expect(view.getByTestId('surface-fill').type).toBe('View');
  });

  it('button 预设落位：支持正圆圆角与纯白填充', async () => {
    const view = await render(
      <SoftShadowSurface
        testID="surface-button"
        preset="button"
        borderRadius={theme.radius.composer}
        fill={theme.colors.surface}
      >
        <Text>按钮</Text>
      </SoftShadowSurface>
    );
    const fillStyle = flat(view.getByTestId('surface-button-fill'));
    expect(fillStyle.borderRadius).toBe(26);
    expect(fillStyle.backgroundColor).toBe('#ffffff');
    expect(view.getByText('按钮')).toBeTruthy();
  });
});
