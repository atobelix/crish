// apps/crish-mobile/src/presentation/components/blocks/StreamingTailText.test.tsx
// StreamingTailText 组件渲染层与状态转移测试

import { render, screen } from '@testing-library/react-native';
import { StreamingTailText } from './StreamingTailText';

describe('StreamingTailText 渲染层测试', () => {
  it('流式期：末端渲染出带有各阶透明度的梯级 Text 节点', async () => {
    const longText = '长文本内容流式输出中'.repeat(5);
    await render(
      <StreamingTailText
        text={longText}
        streaming={true}
        tailGradient={true}
        testID="stream-tail"
      />
    );

    // 验证梯级节点挂载
    const tier0 = screen.getByTestId('stream-tail-tier-0');
    expect(tier0).toBeTruthy();
    expect(tier0.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ opacity: expect.any(Number) }),
      ])
    );

    const tier4 = screen.getByTestId('stream-tail-tier-4');
    expect(tier4).toBeTruthy();
    // 验证末梢梯级发光阴影
    expect(tier4.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ opacity: expect.any(Number) }),
        expect.objectContaining({ textShadowRadius: 2.5 }),
      ])
    );
  });

  it('终态收口 (streaming=false)：所有梯级节点销毁，退化为单一 Text', async () => {
    const longText = '长文本内容流式输出中'.repeat(5);
    await render(
      <StreamingTailText
        text={longText}
        streaming={false}
        tailGradient={true}
        testID="stream-tail"
      />
    );

    expect(screen.queryByTestId('stream-tail-tier-0')).toBeNull();
    expect(screen.getByTestId('stream-tail')).toBeTruthy();
    expect(screen.getByText(longText)).toBeTruthy();
  });

  it('关闭渐变 (tailGradient=false)：即使处于流式期也不产生梯级节点', async () => {
    const longText = '长文本内容流式输出中'.repeat(5);
    await render(
      <StreamingTailText
        text={longText}
        streaming={true}
        tailGradient={false}
        testID="stream-tail"
      />
    );

    expect(screen.queryByTestId('stream-tail-tier-0')).toBeNull();
    expect(screen.getByTestId('stream-tail')).toBeTruthy();
    expect(screen.getByText(longText)).toBeTruthy();
  });

  it('短文本边界：长度 <= 4 字符时流式期直接以单纯文本呈现', async () => {
    await render(
      <StreamingTailText
        text="短文"
        streaming={true}
        tailGradient={true}
        testID="stream-tail"
      />
    );

    expect(screen.queryByTestId('stream-tail-tier-0')).toBeNull();
    expect(screen.getByTestId('stream-tail')).toBeTruthy();
    expect(screen.getByText('短文')).toBeTruthy();
  });
});
