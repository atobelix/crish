// useTimelineAutoScroll 单元测试：
// 1. 流式输出阶段单字追加（高度不变或增量 <= 0.5px）不触发任何滚动；
// 2. 新行换行撑高时启动连续阻尼平滑插值（rAF 驱动 scrollToOffset）；
// 3. 运行中新内容持续到达时就地更新 targetOffset，绝不打断或重启循环；
// 4. 用户手势拖拽（isDraggingRef）介入时瞬间终止循环并释放控制权；
// 5. 脱离跟随（follow = false）时立即停止追赶；
// 6. reducedMotion 开启或非流式（busy = false）时回退到常规快速贴底；
// 7. 记账隔离（波 5）：chase 只推进自有镜像，scrollYRef 绝不被本 hook 写入；
// 8. 流式收口 settle（波 5）：busy true→false 同步落位，编程式锁占用也不被吞；
// 9. inset 变化纠正（波 5）：跟随态按新 inset 同步纠正、非跟随态不动作；
//    滑行在飞时内容撑高把新目标折入滑行、终止帧落到新目标。
import { act, render } from '@testing-library/react-native';
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

describe('useTimelineAutoScroll 流式平滑上推与消除段落感专项测试', () => {
  let rafCallbacks: Array<(time: number) => void> = [];
  let rafIdCounter = 1;
  let scrollToOffsetSpy: jest.Mock;
  let scrollToEndSpy: jest.Mock;
  // 原生底部内衬真值（可变：场景 8 模拟停止胶囊出入改变 inset 真值）
  const paddingRef = { current: 152 };

  beforeEach(() => {
    probeResult = null;
    rafCallbacks = [];
    rafIdCounter = 1;
    paddingRef.current = 152;
    scrollToOffsetSpy = jest.fn();
    scrollToEndSpy = jest.fn();

    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = rafIdCounter++;
      rafCallbacks.push(cb);
      return id;
    });

    jest.spyOn(global, 'cancelAnimationFrame').mockImplementation(() => {
      rafCallbacks = [];
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const stepRaf = (time = 16) => {
    const cbs = [...rafCallbacks];
    rafCallbacks = [];
    cbs.forEach((cb) => cb(time));
  };

  const createMockRefs = () => {
    const listMock = {
      scrollToOffset: scrollToOffsetSpy,
      scrollToEnd: scrollToEndSpy,
    };
    return {
      targetRef: { current: listMock as any },
      viewportHeightRef: { current: 600 },
      scrollYRef: { current: 400 },
      isDraggingRef: { current: false },
      isMomentumRef: { current: false },
      isProgrammaticScrollingRef: { current: false },
      anchorPhaseRef: { current: 'done' as const },
      // B4 SSOT：原生底部内衬真值（默认与 effectiveBottomInset 同值 152）
      getTotalBottomPadding: () => paddingRef.current,
    };
  };

  it('场景 1：流式期间单字追加（内容高度不变或增量 <= 0.5px）完全不触发滚动', async () => {
    const refs = createMockRefs();
    refs.scrollYRef.current = 552;
    refs.viewportHeightRef.current = 600;

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

    // 初始高度 1000 (targetOffset = 1000 + 152 - 600 = 552 == current 552，无溢出)
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 1000);
    });
    expect(probeResult?.isStreamingChaseActive()).toBe(false);

    // 单字追加，高度只微增 0.2px (增量 <= 0.5px)
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 1000.2);
    });

    expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    expect(scrollToEndSpy).not.toHaveBeenCalled();
    expect(probeResult?.isStreamingChaseActive()).toBe(false);

    await view.unmount();
  });

  it('场景 2：流式新行到达引起撑高时，启动单实例 rAF 阻尼平滑插值推升视口', async () => {
    const refs = createMockRefs();
    refs.scrollYRef.current = 400;
    refs.viewportHeightRef.current = 600;

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

    // 初始高度 800 (targetOffset = 800 + 152 - 600 = 352 <= current 400, 不需要推升)
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 800);
    });
    expect(probeResult?.isStreamingChaseActive()).toBe(false);

    // 新行产生，内容高度突增到 900 (targetOffset = 900 + 152 - 600 = 452 > current 400)
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 900);
    });

    // rAF 追赶循环激活
    expect(probeResult?.isStreamingChaseActive()).toBe(true);

    // 步进第 1 帧：distance = 452 - 400 = 52, step = 52 * 0.22 = 11.44, nextOffset = 411.44
    await act(async () => {
      stepRaf(16);
    });
    expect(scrollToOffsetSpy).toHaveBeenCalledWith({
      offset: 400 + 52 * 0.22,
      animated: false,
    });
    // 记账隔离（波 5）：chase 推进的是自有镜像，scrollYRef（onScroll
    // 账本）纹丝不动——旧断言在此期望 411.44，钉的正是 E-R3 的混合账目
    expect(refs.scrollYRef.current).toBe(400);
    expect(probeResult?.isStreamingChaseActive()).toBe(true);

    // 连续推进若干帧直至平滑收敛到 target (452)
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        stepRaf(16);
      });
    }

    // 最终以显式落位精确到达 452 并优雅终止循环；scrollYRef 仍未被写
    expect(scrollToOffsetSpy).toHaveBeenLastCalledWith({
      offset: 452,
      animated: false,
    });
    expect(refs.scrollYRef.current).toBe(400);
    expect(probeResult?.isStreamingChaseActive()).toBe(false);

    await view.unmount();
  });

  it('场景 3：追赶动画进行中新 token 又引起高度增长，仅更新目标偏移，绝不重启打断', async () => {
    const refs = createMockRefs();
    refs.scrollYRef.current = 400;
    refs.viewportHeightRef.current = 600;

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

    // 第一次撑高到 900 (target = 452)
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 900);
    });
    expect(probeResult?.isStreamingChaseActive()).toBe(true);

    // 推进 2 帧
    await act(async () => {
      stepRaf(16);
      stepRaf(32);
    });

    // 在动画中途，又产生新行撑高到 950 (target 变为 950 + 152 - 600 = 502)
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 950);
    });

    // 循环依旧持续，零打断
    expect(probeResult?.isStreamingChaseActive()).toBe(true);

    // 推进至落定
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        stepRaf(16);
      });
    }

    // 终止帧精确落到新目标 502；全程 scrollYRef 未被 chase 写入
    expect(scrollToOffsetSpy).toHaveBeenLastCalledWith({
      offset: 502,
      animated: false,
    });
    expect(refs.scrollYRef.current).toBe(400);
    expect(probeResult?.isStreamingChaseActive()).toBe(false);

    await view.unmount();
  });

  it('场景 4：用户手指拖拽介入（isDraggingRef）或调用 cancelStreamingChase 时瞬间释放控制权', async () => {
    const refs = createMockRefs();
    refs.scrollYRef.current = 400;
    refs.viewportHeightRef.current = 600;

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
      probeResult?.handleContentSizeChange(390, 900);
    });
    expect(probeResult?.isStreamingChaseActive()).toBe(true);

    // 用户介入拖拽
    refs.isDraggingRef.current = true;
    await act(async () => {
      probeResult?.cancelStreamingChase();
    });

    expect(probeResult?.isStreamingChaseActive()).toBe(false);

    // 之后触发 rAF 不会有任何位移产生
    scrollToOffsetSpy.mockClear();
    await act(async () => {
      stepRaf(16);
    });
    expect(scrollToOffsetSpy).not.toHaveBeenCalled();

    await view.unmount();
  });

  it('场景 5：脱离跟随（follow = false）时立即中止平滑推升', async () => {
    const refs = createMockRefs();
    refs.scrollYRef.current = 400;
    refs.viewportHeightRef.current = 600;

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
      probeResult?.handleContentSizeChange(390, 900);
    });
    expect(probeResult?.isStreamingChaseActive()).toBe(true);

    // 外部通知脱离跟随
    await act(async () => {
      await view.rerender(
        <Probe
          {...refs}
          follow={false}
          busy={true}
          effectiveBottomInset={152}
          hasBlocks={true}
          forceSmoothScroll={true}
        />
      );
    });

    expect(probeResult?.isStreamingChaseActive()).toBe(false);

    await view.unmount();
  });

  it('场景 6：reducedMotion = true 时平滑回退到快速贴底', async () => {
    const refs = createMockRefs();
    const view = await render(
      <Probe
        {...refs}
        follow={true}
        busy={true}
        effectiveBottomInset={152}
        hasBlocks={true}
        reducedMotion={true}
        forceSmoothScroll={true}
      />
    );

    await act(async () => {
      probeResult?.handleContentSizeChange(390, 800);
      probeResult?.handleContentSizeChange(390, 900);
    });

    // 不启用 rAF 连续阻尼，经落点单入口同步精确落位——无需推进 rAF，
    // 调用返回即已落位（旧形态经 scheduleScrollToEnd 的 rAF 延迟一帧，
    // 波 5 已退役该调度形态）
    //（B4：目标 = contentH + 原生内衬真值(152) - 视口(600)：800→352、900→452）
    expect(probeResult?.isStreamingChaseActive()).toBe(false);
    expect(scrollToOffsetSpy).toHaveBeenCalledWith({
      offset: 352,
      animated: false,
    });
    expect(scrollToOffsetSpy).toHaveBeenLastCalledWith({
      offset: 452,
      animated: false,
    });

    await view.unmount();
  });

  it('场景 7：流式收口（busy true→false）时同步 settle 纠正，编程式锁被占用也不被吞', async () => {
    const refs = createMockRefs();
    refs.scrollYRef.current = 400;
    refs.viewportHeightRef.current = 600;

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

    // 内容撑高到 1000（target = 1000 + 152 - 600 = 552），追赶循环运行中
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 1000);
    });
    expect(probeResult?.isStreamingChaseActive()).toBe(true);

    // 模拟编程式锁被占用：旧 settle 通道（scheduleScrollToEnd）在此
    // 会被互斥锁静默吞掉、落点永不纠正（E-R3）
    refs.isProgrammaticScrollingRef.current = true;
    scrollToOffsetSpy.mockClear();

    // 流式收口
    await act(async () => {
      await view.rerender(
        <Probe
          {...refs}
          follow={true}
          busy={false}
          effectiveBottomInset={152}
          hasBlocks={true}
          forceSmoothScroll={true}
        />
      );
    });

    // 同步落位：无需推进任何 rAF 已直达目标；锁被接管释放、追赶终止
    expect(scrollToOffsetSpy).toHaveBeenCalledWith({
      offset: 552,
      animated: false,
    });
    expect(refs.isProgrammaticScrollingRef.current).toBe(false);
    expect(probeResult?.isStreamingChaseActive()).toBe(false);

    await view.unmount();
  });

  it('场景 8：inset 变化（停止胶囊消失 152→112）时跟随态同步纠正落点；非跟随态不动作', async () => {
    const refs = createMockRefs();
    refs.scrollYRef.current = 552;
    refs.viewportHeightRef.current = 600;

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

    // 非流式内容落位：1000 + 152 - 600 = 552
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 1000);
    });
    expect(scrollToOffsetSpy).toHaveBeenLastCalledWith({
      offset: 552,
      animated: false,
    });
    scrollToOffsetSpy.mockClear();

    // 停止胶囊消失：inset 152 → 112（宿主推导值与原生内衬真值同步变化），
    // 内容高不变——旧实现无任何纠正运行，落点恒差一个胶囊高（E-R2）
    paddingRef.current = 112;
    await act(async () => {
      await view.rerender(
        <Probe
          {...refs}
          follow={true}
          busy={false}
          effectiveBottomInset={112}
          hasBlocks={true}
          forceSmoothScroll={true}
        />
      );
    });

    // 同步纠正到新真底 1000 + 112 - 600 = 512，无需 rAF
    expect(scrollToOffsetSpy).toHaveBeenCalledWith({
      offset: 512,
      animated: false,
    });

    // 非跟随态：inset 再变也不动作（不扰动用户阅读位置）
    scrollToOffsetSpy.mockClear();
    paddingRef.current = 160;
    await act(async () => {
      await view.rerender(
        <Probe
          {...refs}
          follow={false}
          busy={false}
          effectiveBottomInset={160}
          hasBlocks={true}
          forceSmoothScroll={true}
        />
      );
    });
    expect(scrollToOffsetSpy).not.toHaveBeenCalled();

    await view.unmount();
  });

  it('场景 9：滑行（编程式锁）在飞时内容撑高，新目标折入滑行、终止帧落到新目标', async () => {
    const refs = createMockRefs();
    refs.scrollYRef.current = 100;
    refs.viewportHeightRef.current = 600;

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

    // 非跟随态仅登记内容高 800（不触发任何落点）
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 800);
    });
    expect(scrollToOffsetSpy).not.toHaveBeenCalled();

    await act(async () => {
      await view.rerender(
        <Probe
          {...refs}
          follow={true}
          busy={false}
          effectiveBottomInset={152}
          hasBlocks={true}
          forceSmoothScroll={true}
        />
      );
    });

    // 门面平滑滑行启动（目标 = 800 + 152 - 600 = 352），编程式锁占用
    await act(async () => {
      probeResult?.scrollTimelineToBottom();
    });
    expect(refs.isProgrammaticScrollingRef.current).toBe(true);
    expect(probeResult?.isStreamingChaseActive()).toBe(true);

    // 滑行途中内容撑高到 1000：旧实现在此被互斥锁吞掉、滑行仍落到
    // 旧目标 352；新实现把新目标折入滑行
    await act(async () => {
      probeResult?.handleContentSizeChange(390, 1000);
    });

    // 推进至落定：终止帧精确落到新目标 1000 + 152 - 600 = 552
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        stepRaf(16);
      });
    }
    expect(scrollToOffsetSpy).toHaveBeenLastCalledWith({
      offset: 552,
      animated: false,
    });
    expect(refs.isProgrammaticScrollingRef.current).toBe(false);
    expect(probeResult?.isStreamingChaseActive()).toBe(false);

    await view.unmount();
  });
});
