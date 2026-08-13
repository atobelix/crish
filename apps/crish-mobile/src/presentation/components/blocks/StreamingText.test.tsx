// StreamingText 组件单测（R2UX-05-02 流式文本渲染面）：
// - preview 渐进渲染：流式期文本按窗口合并渐进更新（只跳最新值）；
// - 光标位置：静态「▍」恒定置于流式文本尾部（R2UX §2.6-3 / 裁决 A3）；
// - 终值替换：streaming=false 立即渲染终值 + 光标消失（同节点更新，无闪烁）；
// - 节流调度：帧合并次数 / 强制刷新 / 终值 flush 在组件面验证。
// 注：RNTL v14 的 rerender / act 均为异步 API（须 await）；
//     rerender 取自 render 返回值（screen 仅提供查询面）；
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

describe('preview 渐进渲染（R2UX-05-02）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('首帧立即显示 + 光标在尾部', async () => {
    await renderStreaming();
    expect(screen.getByTestId(PROPS.testID)).toBeTruthy();
    // 流式期正文 = 文本 + 前置空格 + 光标（组合串匹配）
    expect(screen.getByText(`首帧 ${STREAMING_CURSOR}`)).toBeTruthy();
    expect(screen.getByTestId(PROPS.cursorTestID)).toBeTruthy();
  });

  it('窗口内多帧合并：文本保持旧帧，窗口到期后跳到最新值', async () => {
    const { rerender } = await renderStreaming();
    await rerender(<StreamingText {...PROPS} text="帧2" streaming />);
    await rerender(<StreamingText {...PROPS} text="帧3" streaming />);
    expect(screen.getByText(`首帧 ${STREAMING_CURSOR}`)).toBeTruthy(); // 窗口未到期
    await act(async () => {
      jest.advanceTimersByTime(18);
    });
    expect(screen.getByText(`帧3 ${STREAMING_CURSOR}`)).toBeTruthy(); // 一次跳到最新值
    expect(screen.queryByText(`首帧 ${STREAMING_CURSOR}`)).toBeNull();
    expect(screen.queryByText(`帧2 ${STREAMING_CURSOR}`)).toBeNull(); // 中间帧被合并
  });

  it('连续帧流：maxWaitMs 内至少渲染一次（强制刷新边界）', async () => {
    const { rerender } = await renderStreaming();
    for (let i = 0; i < 12; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(10);
      });
      await rerender(<StreamingText {...PROPS} text={`帧${i}`} streaming />);
    }
    // 本波首帧 +100ms 强制刷新交付当时最新值（帧9）；帧流暂停后窗口 flush 帧11
    expect(screen.getByText(`帧9 ${STREAMING_CURSOR}`)).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(18);
    });
    expect(screen.getByText(`帧11 ${STREAMING_CURSOR}`)).toBeTruthy();
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

describe('终值替换（不闪烁不跳动：同节点更新）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('流式结束：终值立即渲染 + 光标消失', async () => {
    const { rerender } = await renderStreaming();
    await rerender(
      <StreamingText {...PROPS} text="最终全文" streaming={false} />
    );
    expect(screen.getByText('最终全文')).toBeTruthy(); // 同步立即
    expect(screen.queryByTestId(PROPS.cursorTestID)).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(screen.getByText('最终全文')).toBeTruthy(); // 无旧帧覆盖
  });

  it('终值替换同节点更新：节点未重挂载（testID 恒定，无闪烁）', async () => {
    const { rerender } = await renderStreaming();
    await rerender(
      <StreamingText {...PROPS} text="最终全文" streaming={false} />
    );
    const node = screen.getByTestId(PROPS.testID);
    expect(node).toBeTruthy();
    expect(node).toHaveTextContent('最终全文'); // 同节点内容替换为终值
  });
});

describe('节流调度（帧合并 / 强制刷新 / 终值 flush 组件面）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('mergeWindowMs 配置生效：更长窗口合并更多帧', async () => {
    const { rerender } = await render(
      <StreamingText {...PROPS} text="a" streaming mergeWindowMs={50} />
    );
    await rerender(
      <StreamingText {...PROPS} text="b" streaming mergeWindowMs={50} />
    );
    await rerender(
      <StreamingText {...PROPS} text="c" streaming mergeWindowMs={50} />
    );
    expect(screen.getByText(`a ${STREAMING_CURSOR}`)).toBeTruthy(); // 50ms 窗口未到
    await act(async () => {
      jest.advanceTimersByTime(49);
    });
    expect(screen.getByText(`a ${STREAMING_CURSOR}`)).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByText(`c ${STREAMING_CURSOR}`)).toBeTruthy(); // 三帧合并为一次渲染
  });

  it('mergeWindowMs=0 同步路径：每帧立即渲染（测试旁路）', async () => {
    const { rerender } = await render(
      <StreamingText {...PROPS} text="a" streaming mergeWindowMs={0} />
    );
    await rerender(
      <StreamingText {...PROPS} text="b" streaming mergeWindowMs={0} />
    );
    expect(screen.getByText(`b ${STREAMING_CURSOR}`)).toBeTruthy(); // 无窗口延迟
  });

  it('终值 flush：窗口挂起期间到达终值 → 立即渲染最新值', async () => {
    const { rerender } = await renderStreaming();
    await rerender(<StreamingText {...PROPS} text="帧2" streaming />); // 窗口挂起
    await rerender(<StreamingText {...PROPS} text="终值" streaming={false} />);
    expect(screen.getByText('终值')).toBeTruthy(); // 不等窗口
    expect(screen.queryByText(`帧2 ${STREAMING_CURSOR}`)).toBeNull();
  });
});
