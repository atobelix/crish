// apps/crish-mobile/src/presentation/components/blocks/StreamingTailText.test.tsx
// StreamingTailText 时间渐显渲染层测试（波 6 达标步）
// 钉版口径：渐显由 birthTime + 帧时刻决定（时间维度）；透明度经 color 的
// alpha 通道施加——分段样式恰为 { color: rgba(...) }，严禁节点 opacity
// （Android 离屏合成边缘失真）与任何阴影/模糊字段回流。

import { render, screen } from '@testing-library/react-native';
import type { TailFadeFrame } from '@/domain/pure/markdown/temporalFade';
import { StreamingTailText } from './StreamingTailText';

const BIRTH = 10_000;

function freshFrame(atTime: number, count = 64): TailFadeFrame {
  return {
    births: Array.from({ length: count }, () => BIRTH),
    atTime,
  };
}

function alphaOf(style: unknown): number {
  const color = (style as { color: string }).color;
  const m = /rgba\(\d+, \d+, \d+, ([\d.]+)\)/.exec(color);
  if (!m) throw new Error(`not an rgba color: ${color}`);
  return Number(m[1]);
}

describe('StreamingTailText 时间渐显渲染', () => {
  it('流式期 + 新鲜出生登记：尾部分段以 color alpha 渲染（样式恰为单个 color 键）', async () => {
    const longText = '长文本内容流式输出中'.repeat(5);
    await render(
      <StreamingTailText
        text={longText}
        streaming={true}
        tailFade={freshFrame(BIRTH)}
        color="#171717"
        testID="stream-tail"
      />
    );

    const seg0 = screen.getByTestId('stream-tail-fade-0');
    expect(seg0).toBeTruthy();
    // 出生瞬间 alpha = 0.22（量化 0.24）：rgba 派生自基色 #171717 = (23,23,23)
    expect(seg0.props.style).toEqual({ color: 'rgba(23, 23, 23, 0.24)' });
    // 全文守恒：外层 Text 组合文本与原文一致
    expect(screen.getByText(longText)).toBeTruthy();
  });

  it('同一出生登记随帧时刻推进而变实（时间渐显，非位置梯度）', async () => {
    const longText = '长文本内容流式输出中'.repeat(5);
    const { rerender } = await render(
      <StreamingTailText
        text={longText}
        streaming={true}
        tailFade={freshFrame(BIRTH)}
        color="#171717"
        testID="stream-tail"
      />
    );
    const a0 = alphaOf(screen.getByTestId('stream-tail-fade-0').props.style);

    await rerender(
      <StreamingTailText
        text={longText}
        streaming={true}
        tailFade={freshFrame(BIRTH + 300)}
        color="#171717"
        testID="stream-tail"
      />
    );
    const a1 = alphaOf(screen.getByTestId('stream-tail-fade-0').props.style);
    expect(a1).toBeGreaterThan(a0);
    expect(a1).toBeLessThan(1);
  });

  it('出生登记全部过期（> 560ms）：分段销毁，退化为单一纯文本', async () => {
    const longText = '长文本内容流式输出中'.repeat(5);
    await render(
      <StreamingTailText
        text={longText}
        streaming={true}
        tailFade={freshFrame(BIRTH + 1000)}
        color="#171717"
        testID="stream-tail"
      />
    );
    expect(screen.queryByTestId('stream-tail-fade-0')).toBeNull();
    expect(screen.getByText(longText)).toBeTruthy();
  });

  it('终态收口 (streaming=false)：即使有新鲜渐显帧也不分段', async () => {
    const longText = '长文本内容流式输出中'.repeat(5);
    await render(
      <StreamingTailText
        text={longText}
        streaming={false}
        tailFade={freshFrame(BIRTH)}
        color="#171717"
        testID="stream-tail"
      />
    );
    expect(screen.queryByTestId('stream-tail-fade-0')).toBeNull();
    expect(screen.getByText(longText)).toBeTruthy();
  });

  it('无渐显帧 (tailFade=null)：流式期也不分段', async () => {
    const longText = '长文本内容流式输出中'.repeat(5);
    await render(
      <StreamingTailText
        text={longText}
        streaming={true}
        tailFade={null}
        color="#171717"
        testID="stream-tail"
      />
    );
    expect(screen.queryByTestId('stream-tail-fade-0')).toBeNull();
    expect(screen.getByText(longText)).toBeTruthy();
  });

  it('短文本同样按时间渐显（无长度豁免：刚写出的短句也从淡入开始）', async () => {
    await render(
      <StreamingTailText
        text="短文"
        streaming={true}
        tailFade={freshFrame(BIRTH)}
        color="#171717"
        testID="stream-tail"
      />
    );
    expect(screen.getByTestId('stream-tail-fade-0')).toBeTruthy();
  });

  it('未显式传 color 时回落 style 内的 color 派生 alpha', async () => {
    const longText = '长文本内容流式输出中'.repeat(5);
    await render(
      <StreamingTailText
        text={longText}
        streaming={true}
        tailFade={freshFrame(BIRTH)}
        style={{ color: '#ececec' }}
        testID="stream-tail"
      />
    );
    expect(screen.getByTestId('stream-tail-fade-0').props.style).toEqual({
      color: 'rgba(236, 236, 236, 0.24)',
    });
  });
});
