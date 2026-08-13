// useStreamingText 单测（R2UX-05-02 渲染节流接线）：
// - 渐进渲染：流式期帧合并（窗口内多帧合并为一次渲染，只显示最新值）；
// - 终值替换：streaming=false 立即渲染最新全文（不等待窗口、无残留调度）；
// - 强制刷新：连续帧流保证 maxWaitMs 内渲染一次；
// - 条目键变化：新条目立即渲染并清空旧 pending；
// - 卸载清理：unmount 后定时器不回调。
// 注：RNTL v14 renderHook 返回 Promise（须 await）；act 亦为异步 API（须 await）。
import { act, renderHook } from '@testing-library/react-native';
import { useStreamingText } from './useStreamingText';

async function useHarness() {
  return await renderHook(
    ({
      identity,
      text,
      streaming,
    }: {
      identity: string;
      text: string;
      streaming: boolean;
    }) => useStreamingText(identity, text, streaming),
    {
      initialProps: { identity: 'seq:1', text: '首帧', streaming: true },
    }
  );
}

describe('渐进渲染（preview 帧窗口合并，R2UX-05-02）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('首帧立即显示（挂载不延迟，避免空白闪烁）', async () => {
    const { result } = await useHarness();
    expect(result.current).toBe('首帧');
  });

  it('窗口内多帧合并：渲染值保持旧帧，窗口到期后跳到最新值（不逐帧跳动）', async () => {
    const { result, rerender } = await useHarness();
    await rerender({ identity: 'seq:1', text: '帧2', streaming: true });
    await rerender({ identity: 'seq:1', text: '帧3', streaming: true });
    await rerender({ identity: 'seq:1', text: '帧4', streaming: true });
    // 窗口未到期：渲染值仍为首帧（多帧合并为一次渲染）
    expect(result.current).toBe('首帧');
    await act(async () => {
      jest.advanceTimersByTime(18);
    });
    expect(result.current).toBe('帧4'); // 只跳到最后一次值
  });

  it('同值重渲染不推进度（无变化不调度）', async () => {
    const { result, rerender } = await useHarness();
    await rerender({ identity: 'seq:1', text: '首帧', streaming: true });
    await rerender({ identity: 'seq:1', text: '首帧', streaming: true });
    await act(async () => {
      jest.advanceTimersByTime(18);
    });
    expect(result.current).toBe('首帧');
  });

  it('连续帧流：maxWaitMs 内强制渲染一次（滚动窗口不饿死渲染）', async () => {
    const { result, rerender } = await useHarness();
    // 每 10ms 一帧，持续 12 帧：滚动窗口永不自然到期，由强制刷新边界兜底
    for (let i = 0; i < 12; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(10);
      });
      await rerender({ identity: 'seq:1', text: `帧${i}`, streaming: true });
    }
    // 本波首帧 +100ms（t=110）强制刷新交付当时最新值（帧9）——长流渲染不饿死
    expect(result.current).toBe('帧9');
    // 帧流暂停后按滚动窗口 flush 最新值
    await act(async () => {
      jest.advanceTimersByTime(18);
    });
    expect(result.current).toBe('帧11');
  });
});

describe('终值替换（streaming=false：立即渲染，不闪烁不跳动）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('流式结束：最新全文立即渲染，无需等待窗口', async () => {
    const { result, rerender } = await useHarness();
    await rerender({ identity: 'seq:1', text: '最终全文', streaming: false });
    expect(result.current).toBe('最终全文'); // 同步立即
    await act(async () => {
      jest.advanceTimersByTime(18);
    });
    expect(result.current).toBe('最终全文'); // 窗口残留不影响
  });

  it('终值替换清空残留 pending：旧帧延迟回调不覆盖终值', async () => {
    const { result, rerender } = await useHarness();
    await rerender({ identity: 'seq:1', text: '流式帧', streaming: true }); // 推进度（窗口挂起）
    await rerender({ identity: 'seq:1', text: '终值', streaming: false }); // 终值到达
    expect(result.current).toBe('终值');
    // 若旧 pending 未被清空，窗口到期会回调旧帧——此处应无回调
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current).toBe('终值');
  });

  it('终值替换保留同节点：同 identity 渲染路径不重挂载（无闪烁）', async () => {
    const { result, rerender } = await useHarness();
    await rerender({ identity: 'seq:1', text: '流式帧', streaming: true });
    await rerender({ identity: 'seq:1', text: '终值', streaming: false });
    expect(result.current).toBe('终值');
    // 键未变化：继续流式期也不重建（状态连续）
    await rerender({ identity: 'seq:1', text: '新一轮', streaming: true });
    expect(result.current).toBe('终值'); // 新流式帧仍在窗口内
    await act(async () => {
      jest.advanceTimersByTime(18);
    });
    expect(result.current).toBe('新一轮');
  });
});

describe('条目键变化（同 seq 覆盖漂移 / 新条目）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('键变化：立即渲染新文本并清空旧 pending（不闪烁）', async () => {
    const { result, rerender } = await useHarness();
    await rerender({ identity: 'seq:1', text: '旧帧', streaming: true }); // 旧 pending 挂起
    await rerender({ identity: 'seq:2', text: '新条目', streaming: true });
    expect(result.current).toBe('新条目'); // 立即渲染
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current).toBe('新条目'); // 旧 pending 已清空，无旧帧回调
  });
});

describe('卸载清理（组件退场即退订，M4 §8.2）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('unmount 退订：无残留回调（状态冻结）', async () => {
    const { result, rerender, unmount } = await useHarness();
    await rerender({ identity: 'seq:1', text: '流式帧', streaming: true }); // pending 挂起
    // 退订清理（调度器 reset 清空定时器与 pending——纯逻辑侧已由
    // previewFlushScheduler.test 覆盖；此处验证组件面行为：unmount 后
    // 推进时间不产生任何回调，值保持退订前最后已提交值）
    await unmount();
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(result.current).toBe('首帧'); // 挂起帧未在退订后应用
  });
});
