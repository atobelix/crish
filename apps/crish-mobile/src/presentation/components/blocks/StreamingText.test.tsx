// StreamingText 组件单测（波 6 达标步：单一平准路径 + 时间渐显）
// - 平准揭示：流式期文本经平准游标匀速揭示（缓冲池吸收网络抖动），
//   不整段跳变到最新值；
// - 种子化：挂载即呈现已到达全文（不重打），光标恒定置于尾部；
// - 终态：streaming=false 后泄洪收敛（≤ 约 300ms）至全文 + 光标消失；
// - 末端时间渐显默认开启：尾部分段以 color alpha 渲染（无节点 opacity)，
//   终态分段销毁；tailFade=false 回退传统静态光标。
// 注：RNTL v14 的 rerender / act 均为异步 API（须 await）；
//     byText 匹配递归文本内容（外层 Text 含光标子节点 → 断言用组合串）。
import { act, render, screen } from '@testing-library/react-native';
import {
  StreamingText,
  STREAMING_CURSOR,
  type StreamingTextProps,
} from './StreamingText';

const PROPS = {
  identity: 'seq:1',
  testID: 'streaming-text',
  cursorTestID: 'streaming-cursor',
};

async function renderStreaming(overrides: Partial<StreamingTextProps> = {}) {
  return await render(
    <StreamingText text="首帧" streaming {...PROPS} {...overrides} />
  );
}

describe('平准揭示（单一平准路径）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('首帧立即显示（种子化）+ 光标在尾部', async () => {
    await renderStreaming();
    expect(screen.getByTestId(PROPS.testID)).toBeTruthy();
    // 流式期正文 = 文本 + 前置空格 + 光标（组合串匹配）
    expect(screen.getByText(`首帧 ${STREAMING_CURSOR}`)).toBeTruthy();
    expect(screen.getByTestId(PROPS.cursorTestID)).toBeTruthy();
  });

  it('突发长文不整段跳变：游标追完积压后才完整呈现', async () => {
    const burst = '起' + '突发到达的长文本内容'.repeat(20); // 201 字
    const { rerender } = await render(
      <StreamingText identity="seq:burst" text="起" streaming testID="burst" />
    );
    await rerender(
      <StreamingText
        identity="seq:burst"
        text={burst}
        streaming
        testID="burst"
      />
    );

    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    // 100ms 内仅揭示封顶速度内的一小段，全文尚未出现（旧整段替换会立即全显）
    expect(screen.queryByText(burst)).toBeNull();

    // 持续推进：游标匀速追赶，最终完整呈现（呈现恒为全文的忠实渲染）
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      if (screen.queryByText(burst)) break;
    }
    expect(screen.getByText(burst)).toBeTruthy();
  });
});

describe('光标（R2UX §2.6-3 / 裁决 A3：静态 ▍ 置于流式文本尾部）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('光标位于文本尾部（前置空格 + ▍，嵌套于正文 Text 之内恒在末尾）', async () => {
    await renderStreaming();
    const cursor = screen.getByTestId(PROPS.cursorTestID);
    expect(cursor.props.children).toBe(` ${STREAMING_CURSOR}`);
  });

  it('非流式期无光标', async () => {
    await renderStreaming({ streaming: false });
    expect(screen.queryByTestId(PROPS.cursorTestID)).toBeNull();
  });

  it('自定义光标符号（测试注入）', async () => {
    await render(
      <StreamingText
        {...PROPS}
        text="x"
        streaming
        cursorSymbol="|"
        cursorTestID={PROPS.cursorTestID}
      />
    );
    expect(screen.getByTestId(PROPS.cursorTestID).props.children).toBe(' |');
  });
});

describe('终态收敛（泄洪至全文，同节点更新）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('流式结束：泄洪收敛后终值完整渲染 + 光标消失', async () => {
    const { rerender } = await renderStreaming();
    await rerender(
      <StreamingText {...PROPS} text="最终全文" streaming={false} />
    );
    // 泄洪窗口 ≤ 280ms：推进 300ms 后收敛完成
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(screen.getByText('最终全文')).toBeTruthy();
    expect(screen.queryByTestId(PROPS.cursorTestID)).toBeNull();
  });

  it('终值同节点更新：节点未重挂载（testID 恒定，无闪烁）', async () => {
    const { rerender } = await renderStreaming();
    await rerender(
      <StreamingText {...PROPS} text="最终全文" streaming={false} />
    );
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    const node = screen.getByTestId(PROPS.testID);
    expect(node).toBeTruthy();
    expect(node).toHaveTextContent('最终全文');
  });
});

describe('末端时间渐显（2026-11-05 用户题 10 裁决）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('默认开启：尾部分段以 color alpha 渲染（无节点 opacity)，且无机械光标', async () => {
    const longText =
      '回望历史，中华文明是人类历史上唯一绵延不断、从未中断的伟大文明。四大发明的璀璨光芒曾照亮人类文明的暗夜。';
    await render(
      <StreamingText
        identity="seq:fade-test"
        text={longText}
        streaming
        testID="stream-container"
      />
    );

    // 机械打字机光标被淘汰，不出现 ▍
    expect(screen.queryByText(new RegExp(STREAMING_CURSOR))).toBeNull();

    // 时间渐显分段挂载：样式恰为 { color: rgba(...) }——color alpha 通道，
    // 精确形状断言天然禁绝 opacity / 阴影等任何附加键回流
    const seg0 = screen.getByTestId('tail-fade-0');
    expect(seg0).toBeTruthy();
    expect(seg0.props.style).toEqual({
      color: expect.stringMatching(/^rgba\(/),
    });
  });

  it('终态收口（streaming=false）：渐显分段销毁，回归纯净静态文本', async () => {
    const longText =
      '回望历史，中华文明是人类历史上唯一绵延不断、从未中断的伟大文明。四大发明的璀璨光芒曾照亮人类文明的暗夜。';
    const { rerender } = await render(
      <StreamingText
        identity="seq:fade-test"
        text={longText}
        streaming
        testID="stream-container"
      />
    );
    expect(screen.getByTestId('tail-fade-0')).toBeTruthy();

    await rerender(
      <StreamingText
        identity="seq:fade-test"
        text={longText}
        streaming={false}
        testID="stream-container"
      />
    );
    await act(async () => {
      jest.advanceTimersByTime(50);
    });

    expect(screen.queryByTestId('tail-fade-0')).toBeNull();
    expect(screen.getByText(longText)).toBeTruthy();
  });

  it('显式 tailFade=false 时：平滑回退传统打字机光标', async () => {
    await render(
      <StreamingText
        identity="seq:fade-fallback"
        text="回退传统光标"
        streaming
        tailFade={false}
      />
    );

    expect(screen.getByText(`回退传统光标 ${STREAMING_CURSOR}`)).toBeTruthy();
  });
});
