// MarkdownImage 断言（批 E / FN-3)：加载前回落画幅占位、onLoad 自然尺寸
// 到达后换真实宽高比、封顶 320、加载失败诚实回落占位行。
// 事件驱动口径：直调宿主 props 回调并包在 await 过的 act 里——React 19
// 的 act 返回 thenable，未 await 的 act 作用域会与后续 render 交错污染
// 后续用例；fireEvent 对 RN Image 的合成 load 事件不达 handler 口径
// （2026-11-03 探针实测：直调 + awaited act 才落状态）。
import { act, render, screen } from '@testing-library/react-native';
import { MarkdownImage } from './MarkdownImage';

function imageStyle(): Record<string, unknown> {
  const node = screen.getByTestId('md-image');
  return node.props.style as Record<string, unknown>;
}

async function fireLoad(width: number, height: number): Promise<void> {
  const onLoad = screen.getByTestId('md-image').props.onLoad as (event: {
    nativeEvent: { source: { width: number; height: number } };
  }) => void;
  await act(async () => {
    onLoad({ nativeEvent: { source: { width, height } } });
  });
}

describe('MarkdownImage', () => {
  it('初始：回落 4/3 画幅 + maxHeight 320（theme token）', async () => {
    await render(
      <MarkdownImage
        source="https://example.com/a.png"
        alt="配图"
        testID="md-image"
        placeholderTestID="md-image-placeholder"
      />
    );
    const style = imageStyle();
    expect(style.aspectRatio).toBeCloseTo(4 / 3);
    expect(style.maxHeight).toBe(320);
    expect(style.width).toBe('100%');
  });

  it('onLoad 自然尺寸到达 → 真实宽高比（不再恒定 4/3）', async () => {
    await render(
      <MarkdownImage
        source="https://example.com/wide.png"
        alt="宽图"
        testID="md-image"
      />
    );
    await fireLoad(1600, 900);
    expect(imageStyle().aspectRatio).toBeCloseTo(1600 / 900);
  });

  it('竖图自然尺寸 → 高大于宽的真实画幅', async () => {
    await render(
      <MarkdownImage
        source="https://example.com/tall.png"
        alt="长截图"
        testID="md-image"
      />
    );
    await fireLoad(900, 1800);
    expect(imageStyle().aspectRatio).toBeCloseTo(0.5);
  });

  it('加载失败 → 占位行（alt 文案），不假装成功', async () => {
    await render(
      <MarkdownImage
        source="https://example.com/broken.png"
        alt="坏图说明"
        testID="md-image"
        placeholderTestID="md-image-placeholder"
      />
    );
    const onError = screen.getByTestId('md-image').props.onError as () => void;
    await act(async () => {
      onError();
    });
    expect(screen.queryByTestId('md-image')).toBeNull();
    expect(screen.getByTestId('md-image-placeholder')).toBeTruthy();
    expect(screen.getByText('坏图说明')).toBeTruthy();
  });
});
