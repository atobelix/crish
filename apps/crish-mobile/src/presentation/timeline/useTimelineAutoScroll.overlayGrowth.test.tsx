// useTimelineAutoScroll 浮层高度变化贴底量测（任务四 D 步）：
// 同一帧几何口径——内容高、底部内衬真值（getTotalBottomPadding）、
// viewport、scrollY、浮层实测高变化，逐场景核对落点：
// D-M1 非流式跟随：浮层变高、正文不变 → 落点同步增加恰好一个 inset 增量；
// D-M2 流式跟随：浮层变高 → 追赶改去新目标、终止帧精确落位；
// D-M3 追赶在飞时浮层变高：新目标折入在飞追赶；
// D-M4 减动效 + 流式：浮层变高必须一次离散落位，严禁滑行追赶；
// D-M5 减动效 + 流式：浮层变矮同理一次落位（负向纠正）；
// D-M6 非跟随：浮层变高不动作（不抢用户阅读位置）；
// D-M7 键盘单次计入：内衬真值 = inset + 键盘高时，JS 落点恰计键盘一份；
//      纯推导 deriveTimelineBottomInset 对 keyboardHeight 恒零计入。
import { act, render } from '@testing-library/react-native';
import { scrollTo } from 'react-native-reanimated';
import { deriveTimelineBottomInset } from '@/domain/pure/timelineBottomInset';
import {
  useTimelineAutoScroll,
  type UseTimelineAutoScrollOptions,
  type UseTimelineAutoScrollReturn,
} from './useTimelineAutoScroll';

let probeResult: UseTimelineAutoScrollReturn | null = null;

function Probe(props: UseTimelineAutoScrollOptions) {
  probeResult = useTimelineAutoScroll(props);
  return null;
}

describe('useTimelineAutoScroll 浮层变高贴底量测（任务四 D）', () => {
  let scrollToOffsetSpy: jest.Mock;
  let scrollToEndSpy: jest.Mock;
  // 原生底部内衬真值（与宿主推导同步变化：浮层实测高 + gap [+ 键盘活跃高]）
  const paddingRef = { current: 152 };

  beforeEach(() => {
    probeResult = null;
    paddingRef.current = 152;
    scrollToOffsetSpy = jest.fn();
    scrollToEndSpy = jest.fn();
    (scrollTo as jest.Mock).mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const stepRaf = () => {
    const step = (
      globalThis as {
        __CRISH_STEP_FRAME_CALLBACKS__?: (times?: number) => void;
      }
    ).__CRISH_STEP_FRAME_CALLBACKS__;
    if (!step) throw new Error('缺少帧回调桩');
    step(1);
  };

  const createMockRefs = () => {
    const listMock = {
      scrollToOffset: scrollToOffsetSpy,
      scrollToEnd: scrollToEndSpy,
    };
    return {
      targetRef: {
        current: listMock,
      } as unknown as UseTimelineAutoScrollOptions['targetRef'],
      animatedRef: {
        current: listMock,
      } as unknown as UseTimelineAutoScrollOptions['animatedRef'],
      viewportHeightRef: { current: 600 },
      scrollYRef: { current: 552 },
      isDraggingRef: { current: false },
      isMomentumRef: { current: false },
      isProgrammaticScrollingRef: { current: false },
      anchorPhaseRef: {
        current: 'done' as 'loading' | 'restoring' | 'done',
      },
      getTotalBottomPadding: () => paddingRef.current,
    };
  };

  it('D-M1：非流式跟随、浮层变高（152→220）正文不变，落点同步 +68 到新真底', async () => {
    const refs = createMockRefs();
    const view = await render(
      <Probe
        {...refs}
        follow={true}
        busy={false}
        effectiveBottomInset={152}
        hasBlocks={true}
        forceSmoothScroll={true}
      />
    );

    // 落位旧底：1000 + 152 - 600 = 552（与 scrollY 一致，已在底）
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 1000);
    });
    expect(scrollToOffsetSpy).toHaveBeenLastCalledWith({
      offset: 552,
      animated: false,
    });
    scrollToOffsetSpy.mockClear();

    // 浮层变高（附件条量级 +68）：正文高度不变、无新 contentSizeChange
    paddingRef.current = 220;
    await act(async () => {
      await view.rerender(
        <Probe
          {...refs}
          follow={true}
          busy={false}
          effectiveBottomInset={220}
          hasBlocks={true}
          forceSmoothScroll={true}
        />
      );
    });

    // 新真底 1000 + 220 - 600 = 620，恰好增加一个 inset 增量
    expect(scrollToOffsetSpy).toHaveBeenCalledWith({
      offset: 620,
      animated: false,
    });

    await view.unmount();
  });

  it('D-M2：流式跟随、浮层变高、正文不变，追赶改去新目标并精确落位', async () => {
    const refs = createMockRefs();
    const view = await render(
      <Probe
        {...refs}
        follow={true}
        busy={true}
        effectiveBottomInset={152}
        hasBlocks={true}
        forceSmoothScroll={true}
      />
    );

    // 已在旧底（目标 552 == scrollY 552）：流式守卫不启动追赶
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 1000);
    });
    expect(probeResult?.isStreamingChaseActive()).toBe(false);
    expect(scrollToOffsetSpy).not.toHaveBeenCalled();

    // 浮层变高 +68，正文不变：跟随态必须改滚动目标
    paddingRef.current = 220;
    await act(async () => {
      await view.rerender(
        <Probe
          {...refs}
          follow={true}
          busy={true}
          effectiveBottomInset={220}
          hasBlocks={true}
          forceSmoothScroll={true}
        />
      );
    });
    expect(probeResult?.isStreamingChaseActive()).toBe(true);

    for (let i = 0; i < 40; i++) {
      await act(async () => {
        stepRaf();
      });
    }
    // 终止帧精确落到新真底 620，全程不走离散落位
    expect(scrollTo).toHaveBeenLastCalledWith(refs.animatedRef, 0, 620, false);
    expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    expect(probeResult?.isStreamingChaseActive()).toBe(false);

    await view.unmount();
  });

  it('D-M3：追赶在飞时浮层变高，新目标折入在飞追赶、终止帧落到合并新底', async () => {
    const refs = createMockRefs();
    refs.scrollYRef.current = 400;
    const view = await render(
      <Probe
        {...refs}
        follow={true}
        busy={true}
        effectiveBottomInset={152}
        hasBlocks={true}
        forceSmoothScroll={true}
      />
    );

    await act(async () => {
      probeResult?.handleContentSizeChange(390, 800);
    });
    // 内容撑高到 900：目标 452 > scrollY 400，追赶启动
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 900);
    });
    expect(probeResult?.isStreamingChaseActive()).toBe(true);
    await act(async () => {
      stepRaf();
      stepRaf();
    });

    // 追赶途中浮层变高 +68：目标应折入为 900 + 220 - 600 = 520
    paddingRef.current = 220;
    await act(async () => {
      await view.rerender(
        <Probe
          {...refs}
          follow={true}
          busy={true}
          effectiveBottomInset={220}
          hasBlocks={true}
          forceSmoothScroll={true}
        />
      );
    });
    expect(probeResult?.isStreamingChaseActive()).toBe(true);

    for (let i = 0; i < 40; i++) {
      await act(async () => {
        stepRaf();
      });
    }
    expect(scrollTo).toHaveBeenLastCalledWith(refs.animatedRef, 0, 520, false);
    expect(probeResult?.isStreamingChaseActive()).toBe(false);

    await view.unmount();
  });

  it('D-M4：减动效 + 流式、浮层变高，必须一次离散落位到新真底（不滑行）', async () => {
    const refs = createMockRefs();
    const view = await render(
      <Probe
        {...refs}
        follow={true}
        busy={true}
        effectiveBottomInset={152}
        hasBlocks={true}
        forceSmoothScroll={true}
        reducedMotion={true}
      />
    );

    // 减动效下内容落位走一次离散贴底 552
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 1000);
    });
    expect(scrollToOffsetSpy).toHaveBeenLastCalledWith({
      offset: 552,
      animated: false,
    });
    scrollToOffsetSpy.mockClear();
    (scrollTo as jest.Mock).mockClear();

    // 浮层变高 +68：减动效口径——一次落位，不启动追赶滑行
    paddingRef.current = 220;
    await act(async () => {
      await view.rerender(
        <Probe
          {...refs}
          follow={true}
          busy={true}
          effectiveBottomInset={220}
          hasBlocks={true}
          forceSmoothScroll={true}
          reducedMotion={true}
        />
      );
    });

    expect(probeResult?.isStreamingChaseActive()).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollToOffsetSpy).toHaveBeenCalledTimes(1);
    expect(scrollToOffsetSpy).toHaveBeenCalledWith({
      offset: 620,
      animated: false,
    });

    await view.unmount();
  });

  it('D-M5：减动效 + 流式、浮层变矮（220→152），一次离散落位负向纠正', async () => {
    const refs = createMockRefs();
    paddingRef.current = 220;
    refs.scrollYRef.current = 620;
    const view = await render(
      <Probe
        {...refs}
        follow={true}
        busy={true}
        effectiveBottomInset={220}
        hasBlocks={true}
        forceSmoothScroll={true}
        reducedMotion={true}
      />
    );

    await act(async () => {
      probeResult?.handleContentSizeChange(390, 1000);
    });
    expect(scrollToOffsetSpy).toHaveBeenLastCalledWith({
      offset: 620,
      animated: false,
    });
    scrollToOffsetSpy.mockClear();
    (scrollTo as jest.Mock).mockClear();

    // 浮层变矮 -68：减动效口径——一次落位回到 552，不滑行下追
    paddingRef.current = 152;
    await act(async () => {
      await view.rerender(
        <Probe
          {...refs}
          follow={true}
          busy={true}
          effectiveBottomInset={152}
          hasBlocks={true}
          forceSmoothScroll={true}
          reducedMotion={true}
        />
      );
    });

    expect(probeResult?.isStreamingChaseActive()).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollToOffsetSpy).toHaveBeenCalledTimes(1);
    expect(scrollToOffsetSpy).toHaveBeenCalledWith({
      offset: 552,
      animated: false,
    });

    await view.unmount();
  });

  it('D-M6：非跟随态浮层变高，正文不变，不滚动（不抢阅读位置）', async () => {
    const refs = createMockRefs();
    const view = await render(
      <Probe
        {...refs}
        follow={false}
        busy={false}
        effectiveBottomInset={152}
        hasBlocks={true}
        forceSmoothScroll={true}
      />
    );

    await act(async () => {
      probeResult?.handleContentSizeChange(390, 1000);
    });
    expect(scrollToOffsetSpy).not.toHaveBeenCalled();

    paddingRef.current = 220;
    await act(async () => {
      await view.rerender(
        <Probe
          {...refs}
          follow={false}
          busy={false}
          effectiveBottomInset={220}
          hasBlocks={true}
          forceSmoothScroll={true}
        />
      );
    });

    expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(probeResult?.isStreamingChaseActive()).toBe(false);

    await view.unmount();
  });

  it('D-M7：键盘单次计入——真值含键盘高时落点恰计一份；纯推导对键盘恒零计入', async () => {
    // 纯推导：deriveTimelineBottomInset 永不叠加 keyboardHeight
    expect(
      deriveTimelineBottomInset({
        overlayHeight: 132,
        gap: 20,
        keyboardHeight: 317,
      })
    ).toBe(152);
    expect(
      deriveTimelineBottomInset({ overlayHeight: 132, gap: 20 })
    ).toBe(152);

    const refs = createMockRefs();
    // 键盘弹起：原生内衬真值 = 物理 inset 152 + 键盘活跃高 317
    paddingRef.current = 469;
    const view = await render(
      <Probe
        {...refs}
        follow={true}
        busy={false}
        effectiveBottomInset={152}
        hasBlocks={true}
        forceSmoothScroll={true}
      />
    );

    // 落点 = 1000 + (152 + 317) - 600 = 869：键盘恰好计入一次，
    // 不是 869 + 317（双计），也不是 552（漏计）
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 1000);
    });
    expect(scrollToOffsetSpy).toHaveBeenLastCalledWith({
      offset: 869,
      animated: false,
    });

    await view.unmount();
  });
});
