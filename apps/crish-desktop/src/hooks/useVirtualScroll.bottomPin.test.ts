// @vitest-environment jsdom
/**
* 底部钉底修复回归装置（调研2 · S-A / S-B / S-C）。
*
* 折叠同钟批的 jsdom 装置把假容器的 scrollHeight
* 直接取裸模型总高（见 useVirtualScroll.test.ts 的 S折叠同钟套件），等于
* 在测试里把渲染层衬距（48+16）与尾部缓冲一并抹掉——钉底目标漏掉的
* 64px（+尾部缓冲）在该装置下原理上不可见，缺陷因此穿过全绿套件落到
* 实机（终态恒距底 ≈64px，且被纯.click() 活测再次掩盖）。
*
* 本文件立约：聊天列表的 scrollHeight mock 必须由 chatSpacerHeight(模型
* 总高, 尾部缓冲) 派生（与生产.listInner 占位高同一公式、同一帧缓冲值），
* 钉底恒等式为 scrollTop ≡ chatSpacerHeight(模型总高, 尾部缓冲) − 视口高，
* 任一帧不符即红。无衬距几何的通用消费方口径（恒等换算）仍由
* useVirtualScroll.test.ts 的既有套件覆盖。
*/
import { act, renderHook} from '@testing-library/react';
import { describe, expect, it, vi} from 'vitest';
import { useVirtualScroll} from './useVirtualScroll';
import { isContainerAtBottom} from './useAccordionViewportGuard';
import { BOTTOM_STICK_EPSILON_PX} from './virtualScrollConstants';
import {
CHAT_SCROLL_PAD_BOTTOM,
CHAT_SCROLL_PAD_TOP,
chatSpacerHeight,
} from '../components/chat-message-list/chatScrollGeometry';

const CLIENT_HEIGHT = 600;
const IDS = ['g', 't1', 't2'];

/** 带可写几何的假容器（与既有套件同模式，几何口径见文件头） */
function makeContainer(scrollHeight: number, scrollTop: number) {
const el = document.createElement('div');
Object.defineProperties(el, {
scrollTop: { value: scrollTop, writable: true, configurable: true},
scrollHeight: {
value: scrollHeight,
writable: true,
configurable: true,
},
clientHeight: {
value: CLIENT_HEIGHT,
writable: true,
configurable: true,
},
});
return el;
}

/**
* 聊天口径装置：宿主注入 chatSpacerHeight 换算（尾部缓冲经 ref 取当前值，
* 与 MessageVirtualizer 的 tailBufferRef 同纪律）；假容器初始 scrollHeight
* = chatSpacerHeight(模型总高, 尾部缓冲)，初始 scrollTop 在其文档底边。
*/
function setupChatPin(opts: {
tailBuffer: number;
heights: [number, number, number];
}) {
const tailRef = { current: opts.tailBuffer};
const { result} = renderHook(() =>
useVirtualScroll({
ids: IDS,
itemCount: 3,
fallbackHeight: 100,
spacerHeightForContent: (h) => chatSpacerHeight(h, tailRef.current),
})
);
act(() => {
result.current.manager.setActual('g', opts.heights[0]);
result.current.manager.setActual('t1', opts.heights[1]);
result.current.manager.setActual('t2', opts.heights[2]);
});
const modelTotal = result.current.manager.getTotalHeight(3);
const docTotal = chatSpacerHeight(modelTotal, tailRef.current);
const container = makeContainer(
docTotal,
Math.max(0, docTotal - CLIENT_HEIGHT)
);
// @ts-expect-error test container injection
result.current.containerRef.current = container;
return { result, container, tailRef};
}

type Setup = ReturnType<typeof setupChatPin>;

/** 派发 scroll 事件（钉底写入后由测试模拟浏览器派发，属程序滚动豁免） */
function fireScroll(setup: Setup) {
act(() => {
setup.result.current.onScroll({
currentTarget: setup.container,
} as unknown as React.UIEvent<HTMLDivElement>);
});
}

/**
* 驱动一帧高度变化并断言钉底恒等式：flush 落账后 scrollTop 必须先行等于
* chatSpacerHeight(新模型总高, 尾部缓冲) − 视口高（占位 scrollHeight 尚
* 未同步时即成立，不滞后一帧、不少衬距/尾部缓冲一分）；随后把占位同步
* 到同一公式（模拟 React 重渲染.listInner），断言逐帧距底 ≤ 1px。
*/
function drivePinFrame(setup: Setup, nextGHeight: number) {
const { result, container, tailRef} = setup;
act(() => {
result.current.setActual('g', nextGHeight);
});
act(() => {
vi.advanceTimersByTime(16);
});
const modelTotal = result.current.manager.getTotalHeight(3);
const docTotal = chatSpacerHeight(modelTotal, tailRef.current);
expect(container.scrollTop).toBe(Math.max(0, docTotal - CLIENT_HEIGHT));
fireScroll(setup);
container.scrollHeight = docTotal;
expect(
container.scrollHeight - container.scrollTop - CLIENT_HEIGHT
).toBeLessThanOrEqual(1);
return modelTotal;
}

describe('S-A · 钉底与渲染同源（衬距 + 尾部缓冲口径）', () => {
it('衬距恒等：chatSpacerHeight 相对模型总高的开销恰为上下衬距之和', () => {
expect(chatSpacerHeight(1000, 0) - 1000).toBe(
CHAT_SCROLL_PAD_TOP + CHAT_SCROLL_PAD_BOTTOM
);
});

it('判底折叠（尾部缓冲 0）：逐帧钉底 = 文档总高 − 视口高，终态距底 ≤ 1px', () => {
vi.useFakeTimers();
try {
const setup = setupChatPin({
tailBuffer: 0,
heights: [700, 300, 300],
});
const { result, container} = setup;
let releaseLock!: () => void;
act(() => {
releaseLock = result.current.manager.acquireAccordionMotionLock(300);
});
const totals = [580, 460, 340, 220, 100].map((h) =>
drivePinFrame(setup, h)
);
expect(totals).toEqual([1180, 1060, 940, 820, 700]);
expect(result.current.manager.isAccordionBottomPinned()).toBe(true);
act(() => {
releaseLock();
});
// S-B 解锁再钉后仍在文档底边
const docTotal = chatSpacerHeight(
result.current.manager.getTotalHeight(3),
0
);
expect(container.scrollTop).toBe(docTotal - CLIENT_HEIGHT);
expect(
container.scrollHeight - container.scrollTop - CLIENT_HEIGHT
).toBeLessThanOrEqual(1);
} finally {
vi.useRealTimers();
}
});

it('判底展开（尾部缓冲 252，进行中回合口径）：钉底含尾部缓冲，终态距底 ≤ 1px', () => {
vi.useFakeTimers();
try {
const setup = setupChatPin({
tailBuffer: 252,
heights: [100, 300, 300],
});
const { result, container} = setup;
let releaseLock!: () => void;
act(() => {
releaseLock = result.current.manager.acquireAccordionMotionLock(300);
});
const totals = [220, 340, 460, 580, 700].map((h) =>
drivePinFrame(setup, h)
);
expect(totals).toEqual([820, 940, 1060, 1180, 1300]);
expect(result.current.manager.isAccordionBottomPinned()).toBe(true);
act(() => {
releaseLock();
});
const docTotal = chatSpacerHeight(
result.current.manager.getTotalHeight(3),
252
);
expect(container.scrollTop).toBe(docTotal - CLIENT_HEIGHT);
expect(
container.scrollHeight - container.scrollTop - CLIENT_HEIGHT
).toBeLessThanOrEqual(1);
} finally {
vi.useRealTimers();
}
});
});

describe('S-C · 判底区制（退化底部）', () => {
function makeGeomContainer(
scrollHeight: number,
clientHeight: number,
scrollTop: number
) {
const el = document.createElement('div');
Object.defineProperties(el, {
scrollHeight: { value: scrollHeight, configurable: true},
clientHeight: { value: clientHeight, configurable: true},
scrollTop: { value: scrollTop, configurable: true},
});
return el;
}

it('isContainerAtBottom：内容装得下即判底；距底 > ε 不判底', () => {
// 退化区制（调研2 T2 几何：内容 ≤ 视口）——旧口径对 maxScroll ≤ 1 硬判 false
expect(isContainerAtBottom(makeGeomContainer(464, 600, 0))).toBe(true);
expect(isContainerAtBottom(makeGeomContainer(600, 600, 0))).toBe(true);
// ε 边界：距底恰为 ε 判底、ε+1 不判底
expect(
isContainerAtBottom(makeGeomContainer(1000, 600, 400 - BOTTOM_STICK_EPSILON_PX))
).toBe(true);
expect(
isContainerAtBottom(
makeGeomContainer(1000, 600, 400 - BOTTOM_STICK_EPSILON_PX - 1)
)
).toBe(false);
expect(isContainerAtBottom(makeGeomContainer(1000, 600, 0))).toBe(false);
});

it('退化底部展开：判底成立，展开后钉底跟随到新文档底边（尾部不落折线下）', () => {
vi.useFakeTimers();
try {
const { result} = renderHook(() =>
useVirtualScroll({
ids: ['a', 'b'],
itemCount: 2,
fallbackHeight: 100,
spacerHeightForContent: (h) => chatSpacerHeight(h, 0),
})
);
act(() => {
result.current.manager.setActual('a', 250);
result.current.manager.setActual('b', 150);
});
// 模型 400 → 文档 464 < 视口 600：maxScroll = 0 的退化区制
const container = makeContainer(chatSpacerHeight(400, 0), 0);
// @ts-expect-error test container injection
result.current.containerRef.current = container;

let releaseLock!: () => void;
act(() => {
releaseLock = result.current.manager.acquireAccordionMotionLock(300);
});
act(() => {
result.current.setActual('a', 700);
});
act(() => {
vi.advanceTimersByTime(16);
});
// 旧口径下此处判底结论为 false、scrollTop 恒 0、展开尾部落在折线以下
expect(result.current.manager.isAccordionBottomPinned()).toBe(true);
expect(container.scrollTop).toBe(
chatSpacerHeight(850, 0) - CLIENT_HEIGHT
);
container.scrollHeight = chatSpacerHeight(850, 0);
expect(
container.scrollHeight - container.scrollTop - CLIENT_HEIGHT
).toBeLessThanOrEqual(1);
act(() => {
releaseLock();
});
} finally {
vi.useRealTimers();
}
});
});

describe('R6 · 滞后程序滚动事件不得误杀钉住（让行判据 = 物理输入计数）', () => {
  it('滞后钉底事件（与最新令牌目标不匹配、距底 > ε）→ 钉住存活并继续逐帧钉底；真实滚轮输入后滚离 → 立即让行', () => {
    vi.useFakeTimers();
    try {
      const setup = setupChatPin({
        tailBuffer: 0,
        heights: [700, 300, 300],
      });
      const { result, container } = setup;
      let releaseLock!: () => void;
      act(() => {
        releaseLock = result.current.manager.acquireAccordionMotionLock(600);
      });
      drivePinFrame(setup, 580);
      drivePinFrame(setup, 460);
      expect(result.current.manager.isAccordionBottomPinned()).toBe(true);
      const pinTarget = container.scrollTop;

      // 模拟滞后事件：占位已长高（距底 180 > ε），scrollTop 却是早先钉底的
      // 旧位置——与最新令牌目标不匹配而落入原生分支。旧判据仅凭事件位置
      // 即取消钉住（实测 dist 终态 74 的成因）；R6 以物理输入计数判据：
      // 无新物理输入 → 判为滞后程序事件，钉住存活。
      container.scrollHeight =
        chatSpacerHeight(result.current.manager.getTotalHeight(3), 0) + 120;
      container.scrollTop = pinTarget - 60;
      act(() => {
        result.current.onScroll({
          currentTarget: container,
        } as unknown as React.UIEvent<HTMLDivElement>);
      });
      expect(result.current.manager.isAccordionBottomPinned()).toBe(true);

      // 钉住存活：下一帧继续钉底回到文档底边
      container.scrollTop = pinTarget;
      drivePinFrame(setup, 340);
      expect(result.current.manager.isAccordionBottomPinned()).toBe(true);

      // 真实物理输入（滚轮捕获计数变化）后滚离 → 让行取消，与既有手势
      // 让行口径一致（useVirtualScroll.test.ts 的 S折叠同钟套件同场景）。
      act(() => {
        container.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -40, bubbles: true })
        );
      });
      container.scrollTop = 100;
      act(() => {
        result.current.onScroll({
          currentTarget: container,
        } as unknown as React.UIEvent<HTMLDivElement>);
      });
      expect(result.current.manager.isAccordionBottomPinned()).toBe(false);

      act(() => {
        releaseLock();
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('S-B · 解锁残差回填与 DOM 真底终检', () => {
it('解锁后 DOM 底边比模型多出包络内残差 → 终检一帧内收口到真底', () => {
vi.useFakeTimers();
try {
const setup = setupChatPin({
tailBuffer: 0,
heights: [700, 300, 300],
});
const { result, container} = setup;
let releaseLock!: () => void;
act(() => {
releaseLock = result.current.manager.acquireAccordionMotionLock(300);
});
drivePinFrame(setup, 580);
drivePinFrame(setup, 460);
act(() => {
releaseLock();
});
// 模拟渲染与模型差出 5px 残差（舍入 / 阈值门迟交的末帧）：DOM 底边更深
const docTotal = chatSpacerHeight(
result.current.manager.getTotalHeight(3),
0
);
container.scrollHeight = docTotal + 5;
act(() => {
vi.advanceTimersByTime(16);
});
expect(
container.scrollHeight - container.scrollTop - CLIENT_HEIGHT
).toBeLessThanOrEqual(1);
} finally {
vi.useRealTimers();
}
});

it('解锁后偏差超出包络（用户已滚离量级）→ 终检不夺回滚动', () => {
vi.useFakeTimers();
try {
const setup = setupChatPin({
tailBuffer: 0,
heights: [700, 300, 300],
});
const { result, container} = setup;
let releaseLock!: () => void;
act(() => {
releaseLock = result.current.manager.acquireAccordionMotionLock(300);
});
drivePinFrame(setup, 580);
act(() => {
releaseLock();
});
const docTotal = chatSpacerHeight(
result.current.manager.getTotalHeight(3),
0
);
const pinTarget = docTotal - CLIENT_HEIGHT;
expect(container.scrollTop).toBe(pinTarget);
// DOM 底边突然深 500px（远超缺陷包络）：终检必须让行
container.scrollHeight = docTotal + 500;
act(() => {
vi.advanceTimersByTime(16);
});
expect(container.scrollTop).toBe(pinTarget);
} finally {
vi.useRealTimers();
}
});

it('解锁后迟到的残差落账在宽限窗内仍逐帧钉底', () => {
vi.useFakeTimers();
try {
const setup = setupChatPin({
tailBuffer: 0,
heights: [700, 300, 300],
});
const { result, container} = setup;
let releaseLock!: () => void;
act(() => {
releaseLock = result.current.manager.acquireAccordionMotionLock(300);
});
drivePinFrame(setup, 580);
act(() => {
releaseLock();
});
// 解锁后迟到一帧残差落账（Δ=8 超过显著阈值门，可入账）
act(() => {
result.current.setActual('g', 572);
});
act(() => {
vi.advanceTimersByTime(16);
});
const docTotal = chatSpacerHeight(
result.current.manager.getTotalHeight(3),
0
);
expect(container.scrollTop).toBe(docTotal - CLIENT_HEIGHT);
container.scrollHeight = docTotal;
expect(
container.scrollHeight - container.scrollTop - CLIENT_HEIGHT
).toBeLessThanOrEqual(1);
} finally {
vi.useRealTimers();
}
});
});
