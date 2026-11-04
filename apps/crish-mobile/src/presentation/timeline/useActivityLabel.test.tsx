// 活动文案最短驻留单测（批 B）：驻留期内变更不上屏、到点落最新、
// 驻留已过立即上屏、活动结束直通终态。
// 形态与计时口径从本仓组件测试惯例：Probe 组件承载 hook（同
// useTimelineBottomInset.test 模式）+ 真实计时器小 minMs 驱动——
// 假计时器与 React Scheduler 的 setImmediate 通道在本仓 jest 环境
// 互相不驱动（实测：flush 已执行但渲染不提交），故不用假计时器；
// 正典 1200ms 本身由常量断言钉住，行为以等比小档验证。
import { act, render } from '@testing-library/react-native';
import { Text } from 'react-native';
import {
  MIN_ACTIVITY_LABEL_RESIDENCY_MS,
  useMinResidencyText,
} from './useActivityLabel';

// 档位须显著大于一次 render/rerender 往返在忙碌机器上的耗时
// （往返可达数百毫秒级——驻留从上一文案上屏起算、含往返耗时，
// 过小会让检查点与落位点在负载下交错）
const MIN_MS = 600;

function Probe({ text, active }: { text: string; active: boolean }) {
  const shown = useMinResidencyText(text, active, MIN_MS);
  return <Text testID="shown">{shown}</Text>;
}

async function sleep(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function shownOf(view: Awaited<ReturnType<typeof render>>): string {
  return view.getByTestId('shown').props.children as string;
}

describe('useMinResidencyText', () => {
  it('正典驻留 = 1200ms', () => {
    expect(MIN_ACTIVITY_LABEL_RESIDENCY_MS).toBe(1200);
  });

  it('活动期变更在驻留期内不上屏，到点落位', async () => {
    const startedAt = Date.now();
    const view = await render(<Probe text="正在执行 · A" active />);
    expect(shownOf(view)).toBe('正在执行 · A');
    await view.rerender(<Probe text="正在执行 · B" active />);
    // 驻留期内：变更不得立即上屏
    expect(shownOf(view)).toBe('正在执行 · A');
    // 到点落位：轮询等 B 出现（上限 3s）——本机负载下渲染往返可达
    // 数百毫秒，固定睡眠检查点会与落位点交错，故不押固定点；改断
    // 言驻留不变量：落位时刻 ≥ 上屏时刻 + MIN（容差 = 一次渲染
    // 往返量级，覆盖 startedAt 到首帧提交之间的耗时）
    let landedAt = 0;
    for (let waited = 0; waited < 3000; waited += 50) {
      if (shownOf(view) === '正在执行 · B') {
        landedAt = Date.now();
        break;
      }
      await sleep(50);
    }
    if (landedAt === 0 && shownOf(view) === '正在执行 · B') {
      landedAt = Date.now();
    }
    expect(shownOf(view)).toBe('正在执行 · B');
    expect(landedAt).toBeGreaterThanOrEqual(startedAt + MIN_MS - 250);
    await view.unmount();
  });

  it('驻留期内多次变更只落最新值', async () => {
    const view = await render(<Probe text="A" active />);
    await view.rerender(<Probe text="B" active />);
    await sleep(120);
    await view.rerender(<Probe text="C" active />);
    await sleep(700);
    expect(shownOf(view)).toBe('C');
    await view.unmount();
  });

  it('上一条文案已驻留满 → 变更立即上屏', async () => {
    const view = await render(<Probe text="A" active />);
    await sleep(MIN_MS + 120);
    await view.rerender(<Probe text="B" active />);
    expect(shownOf(view)).toBe('B');
    await view.unmount();
  });

  it('活动结束立即落位终态文案（不等驻留）', async () => {
    const view = await render(<Probe text="正在执行 · A" active />);
    await view.rerender(<Probe text="正在执行 · B" active />);
    expect(shownOf(view)).toBe('正在执行 · A');
    await view.rerender(<Probe text="使用了 2 个工具 · 3 秒" active={false} />);
    expect(shownOf(view)).toBe('使用了 2 个工具 · 3 秒');
    await view.unmount();
  });

  it('非活动期直通无延迟', async () => {
    const view = await render(<Probe text="A" active={false} />);
    await view.rerender(<Probe text="B" active={false} />);
    expect(shownOf(view)).toBe('B');
    await view.unmount();
  });
});
