import { describe, expect, it } from 'vitest';
import {
  CHAT_OVERLAY_MIN_THUMB_PX,
  computeThumbGeometry,
  decideThumbSync,
  smoothModeOf,
  type ScrollGeometrySnapshot,
} from './chatOverlayScrollbarGeometry';

const snap = (
  over: Partial<ScrollGeometrySnapshot> = {}
): ScrollGeometrySnapshot => ({
  scrollTop: 0,
  scrollHeight: 2400,
  clientHeight: 600,
  clientWidth: 800,
  ...over,
});

describe('computeThumbGeometry', () => {
  it('未溢出时无滑块（短内容整条不出现）', () => {
    const g = computeThumbGeometry(snap({ scrollHeight: 600 }));
    expect(g.hasOverflow).toBe(false);
    expect(g.thumbHeightPx).toBe(0);
    expect(g.maxTravelPx).toBe(0);
  });

  it('scrollHeight 等于 clientHeight 亦判未溢出', () => {
    expect(
      computeThumbGeometry(snap({ scrollHeight: 599 })).hasOverflow
    ).toBe(false);
  });

  it('按视口/总高比例映射尺寸与位移', () => {
    // 600 / 2400 → 轨道 600 的 1/4 = 150；maxScroll 1800
    const top = computeThumbGeometry(snap({ scrollTop: 0 }));
    expect(top.thumbHeightPx).toBe(150);
    expect(top.maxTravelPx).toBe(450);
    expect(top.thumbOffsetPx).toBe(0);

    const mid = computeThumbGeometry(snap({ scrollTop: 900 }));
    expect(mid.progress).toBe(0.5);
    expect(mid.thumbOffsetPx).toBe(225);

    const bottom = computeThumbGeometry(snap({ scrollTop: 1800 }));
    expect(bottom.progress).toBe(1);
    expect(bottom.thumbOffsetPx).toBe(450);
  });

  it('滑块下限 18px（与 ScrollArea minThumbSize 同值）', () => {
    const g = computeThumbGeometry(
      snap({ scrollHeight: 600 * 100, scrollTop: 0 })
    );
    expect(g.thumbHeightPx).toBe(CHAT_OVERLAY_MIN_THUMB_PX);
    expect(g.maxTravelPx).toBe(600 - CHAT_OVERLAY_MIN_THUMB_PX);
  });

  it('progress 钳制在 [0,1]（过冲/回弹不溢出轨道）', () => {
    expect(
      computeThumbGeometry(snap({ scrollTop: 99999 })).thumbOffsetPx
    ).toBe(450);
    expect(computeThumbGeometry(snap({ scrollTop: -50 })).progress).toBe(0);
  });

  it('视口高为 0（未布局）时不产出滑块', () => {
    const g = computeThumbGeometry(snap({ clientHeight: 0 }));
    expect(g.hasOverflow).toBe(false);
  });
});

describe('decideThumbSync', () => {
  const calm = { gestureActive: false, dragging: false };

  it('首帧恒直写', () => {
    expect(decideThumbSync(null, snap(), calm)).toEqual({
      sizeSmooth: false,
      offsetSmooth: false,
    });
  });

  it('纯总高阶跃：尺寸与位移同平滑（展开/折叠落点帧）', () => {
    const d = decideThumbSync(snap(), snap({ scrollHeight: 1800 }), calm);
    expect(d).toEqual({ sizeSmooth: true, offsetSmooth: true });
    expect(smoothModeOf(d)).toBe('both');
  });

  it('总高与位置同帧变化：只尺寸平滑，位置直写（流式贴底增长）', () => {
    const d = decideThumbSync(
      snap(),
      snap({ scrollHeight: 2600, scrollTop: 200 }),
      calm
    );
    expect(d).toEqual({ sizeSmooth: true, offsetSmooth: false });
    expect(smoothModeOf(d)).toBe('size');
  });

  it('纯滚动位置变化：全直写（滑块不许撒谎）', () => {
    expect(decideThumbSync(snap(), snap({ scrollTop: 300 }), calm)).toEqual({
      sizeSmooth: false,
      offsetSmooth: false,
    });
  });

  it('用户手势窗内：总高阶跃也全直写', () => {
    expect(
      decideThumbSync(snap(), snap({ scrollHeight: 1800 }), {
        gestureActive: true,
        dragging: false,
      })
    ).toEqual({ sizeSmooth: false, offsetSmooth: false });
  });

  it('拖拽中：全直写', () => {
    expect(
      decideThumbSync(snap(), snap({ scrollHeight: 1800 }), {
        gestureActive: false,
        dragging: true,
      })
    ).toEqual({ sizeSmooth: false, offsetSmooth: false });
  });

  it('视口宽度变化（侧栏布局动画）：直接跟随，禁双重平滑（S2 交叉口径）', () => {
    expect(
      decideThumbSync(
        snap(),
        snap({ clientWidth: 640, scrollHeight: 2000 }),
        calm
      )
    ).toEqual({ sizeSmooth: false, offsetSmooth: false });
  });

  it('视口高度变化：直接跟随', () => {
    expect(
      decideThumbSync(
        snap(),
        snap({ clientHeight: 500, scrollHeight: 2000 }),
        calm
      )
    ).toEqual({ sizeSmooth: false, offsetSmooth: false });
  });

  it('无任何变化：不平滑（且宿主据此不触碰 DOM，不腰斩在途过渡）', () => {
    const d = decideThumbSync(snap(), snap(), calm);
    expect(d).toEqual({ sizeSmooth: false, offsetSmooth: false });
    expect(smoothModeOf(d)).toBe('none');
  });
});
