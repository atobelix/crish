// useStreamingText 单测（波 6 达标步：单一平准路径 + 呈现帧契约）
// - 生产默认即平准路径：无任何模式开关，突发全文按平准游标匀速揭示、
//   不整段跳变（生产装配可达性断言：默认接线必须命中平准器，而非仅在
//   某个开关打开时）；
// - 挂载 / 条目切换种子化：已在屏全文立即呈现（不重打），其后增量才平准；
// - 呈现帧同源同钟：text 与 tailFade（出生登记 + 帧时刻）同次提交产出，
//   出生登记随揭示增长、单调不减；
// - 终态泄洪：streaming=false 后 ≤ 约 300ms 收敛至 100% 全文；
// - 卸载清理：unmount 后无残留回调。
// 注：RNTL v14 renderHook 返回 Promise（须 await）；act 亦为异步 API（须 await）。
import { act, renderHook } from '@testing-library/react-native';
import { useStreamingText, type StreamingTextFrame } from './useStreamingText';

interface HarnessProps {
  identity: string;
  text: string;
  streaming: boolean;
}

async function useHarness(initial: HarnessProps) {
  return await renderHook(
    ({ identity, text, streaming }: HarnessProps) =>
      useStreamingText(identity, text, streaming),
    { initialProps: initial }
  );
}

function expectPrefixOf(frame: StreamingTextFrame, full: string) {
  expect(full.startsWith(frame.text)).toBe(true);
}

describe('种子化（挂载 / 条目切换不重打）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('挂载立即呈现全文（种子化），不从首字重打', async () => {
    const { result } = await useHarness({
      identity: 'seq:1',
      text: '已经生成了一大半的回答内容',
      streaming: true,
    });
    expect(result.current.text).toBe('已经生成了一大半的回答内容');
  });

  it('挂载帧携带尾部出生登记（种子窗口合成，渐显可运行）', async () => {
    const { result } = await useHarness({
      identity: 'seq:1',
      text: '种子窗口内的文本会获得出生登记用于挂载渐显',
      streaming: true,
    });
    const { births, atTime } = result.current.tailFade;
    expect(births.length).toBeGreaterThan(0);
    expect(births.some((b) => b !== null)).toBe(true);
    for (const b of births) {
      if (b !== null) {
        expect(b).toBeLessThanOrEqual(atTime);
        expect(atTime - b).toBeLessThanOrEqual(560);
      }
    }
  });

  it('非流式挂载：全文静态呈现且无出生登记（终态纯文本）', async () => {
    const { result } = await useHarness({
      identity: 'seq:1',
      text: '静态历史消息',
      streaming: false,
    });
    expect(result.current.text).toBe('静态历史消息');
    expect(result.current.tailFade.births.every((b) => b === null)).toBe(
      true
    );
  });

  it('条目键变化：立即种子化新条目全文，旧状态不残留', async () => {
    const { result, rerender } = await useHarness({
      identity: 'seq:1',
      text: '旧条目内容',
      streaming: true,
    });
    await rerender({
      identity: 'seq:2',
      text: '新条目的完整首帧',
      streaming: true,
    });
    expect(result.current.text).toBe('新条目的完整首帧');
  });
});

describe('平准揭示（生产默认路径，无开关）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('突发全文不整段跳变：按游标匀速揭示，呈现恒为目标前缀', async () => {
    const { result, rerender } = await useHarness({
      identity: 'seq:1',
      text: '起',
      streaming: true,
    });
    const burst = '起' + '突发到达的长文本内容'.repeat(20); // 201 字
    await rerender({ identity: 'seq:1', text: burst, streaming: true });

    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    // 100ms 内揭示量受封顶速度约束（70 字/秒 → ≤ 7 字 + 种子 1 字），
    // 绝不一次跳到全文（整段替换的旧行为）
    expect(result.current.text.length).toBeLessThanOrEqual(1 + 7 + 1);
    expect(result.current.text.length).toBeGreaterThan(1);
    expectPrefixOf(result.current, burst);

    // 持续推进最终收敛到全文（仍在流式中，游标追完积压）
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expectPrefixOf(result.current, burst);
      if (result.current.text === burst) break;
    }
    expect(result.current.text).toBe(burst);
  });

  it('出生登记随揭示增长且单调不减，与帧时刻同钟', async () => {
    const { result, rerender } = await useHarness({
      identity: 'seq:1',
      text: '起',
      streaming: true,
    });
    const burst = '起' + '逐字登记出生时刻的文本'.repeat(10);
    await rerender({ identity: 'seq:1', text: burst, streaming: true });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    const { births, atTime } = result.current.tailFade;
    const stamped = births.filter((b): b is number => b !== null);
    expect(stamped.length).toBeGreaterThan(1);
    for (let i = 1; i < stamped.length; i++) {
      expect(stamped[i]!).toBeGreaterThanOrEqual(stamped[i - 1]!);
    }
    for (const b of stamped) {
      expect(b).toBeLessThanOrEqual(atTime);
    }
  });

  it('同值重渲染不推进度（无变化不调度）', async () => {
    const { result, rerender } = await useHarness({
      identity: 'seq:1',
      text: '稳定文本',
      streaming: true,
    });
    const before = result.current;
    await rerender({ identity: 'seq:1', text: '稳定文本', streaming: true });
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current.text).toBe(before.text);
  });
});

describe('终态泄洪收敛（streaming=false）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('流式结束：泄洪期内收敛至 100% 全文，无字符丢失', async () => {
    const { result, rerender } = await useHarness({
      identity: 'seq:1',
      text: '首',
      streaming: true,
    });
    const fullText = '这是一段完整的流式回答内容，测试终态收敛与完整交付。';
    await rerender({ identity: 'seq:1', text: fullText, streaming: true });
    await rerender({ identity: 'seq:1', text: fullText, streaming: false });

    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current.text).toBe(fullText);
  });

  it('泄洪完成后旧帧不回潮：继续推進时间呈现恒为全文', async () => {
    const { result, rerender } = await useHarness({
      identity: 'seq:1',
      text: '首',
      streaming: true,
    });
    const fullText = '终值收敛后保持稳定。';
    await rerender({ identity: 'seq:1', text: fullText, streaming: true });
    await rerender({ identity: 'seq:1', text: fullText, streaming: false });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current.text).toBe(fullText);
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(result.current.text).toBe(fullText);
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
    const { result, rerender, unmount } = await useHarness({
      identity: 'seq:1',
      text: '首',
      streaming: true,
    });
    await rerender({
      identity: 'seq:1',
      text: '首' + '待揭示的后续内容'.repeat(10),
      streaming: true,
    });
    const frozen = result.current.text;
    await unmount();
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(result.current.text).toBe(frozen);
  });
});
