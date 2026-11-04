/**
 * apps/crish-desktop/src/components/ui/SplitResizer/elasticHandle.test.ts
 *
 * 弹性手柄引擎契约测试：钉住弹簧预设、形态参数空间、橡皮筋与状态机关键行为。
 * 数值来源：`~/workspace/crish-audit/弹性拖柄演示解析.md`（演示实测值，位置类已 px 化）。
 */
import { describe, expect, it } from 'vitest';
import {
  ELASTIC_HANDLE_DEFAULTS as P,
  ELASTIC_SPRING_PRESET,
  ElasticHandleEngine,
  capsuleMorphTargets,
  createSpring,
  deriveActiveRgb,
  dragMorphTargets,
  mixRgbColor,
  rubberBand,
  stepSpring,
} from './elasticHandle';

describe('弹簧预设与积分器', () => {
  it('七个弹簧的 k/c 与演示实测预设逐值一致', () => {
    expect(ELASTIC_SPRING_PRESET.position).toEqual({
      stiffness: 340,
      damping: 32,
    });
    expect(ELASTIC_SPRING_PRESET.offsetX).toEqual({
      stiffness: 320,
      damping: 26,
    });
    expect(ELASTIC_SPRING_PRESET.bend).toEqual({ stiffness: 290, damping: 24 });
    expect(ELASTIC_SPRING_PRESET.strokeWidth).toEqual({
      stiffness: 300,
      damping: 28,
    });
    expect(ELASTIC_SPRING_PRESET.halfLen).toEqual({
      stiffness: 300,
      damping: 28,
    });
    expect(ELASTIC_SPRING_PRESET.opacity).toEqual({
      stiffness: 260,
      damping: 28,
    });
    expect(ELASTIC_SPRING_PRESET.colorMix).toEqual({
      stiffness: 260,
      damping: 26,
    });
  });

  it('欠阻尼弹簧会越过目标（过冲）后收敛吸附', () => {
    const s = createSpring(0, ELASTIC_SPRING_PRESET.bend);
    s.target = 5.6;
    let max = Number.NEGATIVE_INFINITY;
    let settled = false;
    for (let i = 0; i < 600 && !settled; i += 1) {
      settled = stepSpring(s, 1 / 60, false);
      max = Math.max(max, s.value);
    }
    expect(max).toBeGreaterThan(5.6);
    expect(settled).toBe(true);
    expect(s.value).toBe(5.6);
  });

  it('reducedMotion 时弹簧直达目标、无过冲', () => {
    const s = createSpring(0, ELASTIC_SPRING_PRESET.bend);
    s.target = 5.6;
    const settled = stepSpring(s, 1 / 60, true);
    expect(settled).toBe(true);
    expect(s.value).toBe(5.6);
    expect(s.velocity).toBe(0);
  });
});

describe('橡皮筋与形态参数空间', () => {
  it('rubberBand 单调递增、渐近封顶、零点为零', () => {
    expect(rubberBand(0, 24, 56)).toBe(0);
    const mid = rubberBand(56, 24, 56);
    expect(mid).toBeCloseTo(24 * (1 - Math.exp(-1)), 5);
    // 4τ 处仍严格小于封顶；极远处因浮点下溢恰达封顶，但永不越过
    expect(rubberBand(224, 24, 56)).toBeLessThan(24);
    expect(rubberBand(224, 24, 56)).toBeGreaterThan(mid);
    expect(rubberBand(10000, 24, 56)).toBeLessThanOrEqual(24);
  });

  it('胶囊形态 = 演示悬停参数', () => {
    expect(capsuleMorphTargets(P)).toEqual({
      offsetX: 0,
      bend: 0,
      strokeWidth: 9.5,
      halfLen: 19.5,
      colorMix: 0,
    });
  });

  it('区间内满拉力：弧向随拖向、变细变长变深', () => {
    const r = dragMorphTargets(324, 300, 100, 400, P);
    expect(r.dir).toBe(1);
    expect(r.over).toBe(0);
    expect(r.displayTarget).toBe(324);
    expect(r.morph.offsetX).toBeCloseTo(11, 5);
    expect(r.morph.bend).toBeCloseTo(5.6, 5);
    expect(r.morph.strokeWidth).toBeCloseTo(2.5, 5);
    expect(r.morph.halfLen).toBeCloseTo(30.5, 5);
    expect(r.morph.colorMix).toBeCloseTo(0.85, 5);
  });

  it('死区内位移不产生弧向，但起步拉力保证粗细已开始形变', () => {
    const r = dragMorphTargets(302, 300, 100, 400, P);
    expect(r.dir).toBe(0);
    expect(r.morph.bend).toBe(0);
    expect(r.morph.offsetX).toBe(0);
    expect(r.morph.strokeWidth).toBeLessThan(9.5);
    expect(r.morph.strokeWidth).toBeGreaterThan(2.5);
  });

  it('触限远端：绷直、贴靠拉拽侧、更细（→1.15）、更淡（colorMix→0.35）', () => {
    const r = dragMorphTargets(400 + 160, 300, 100, 400, P);
    expect(r.over).toBe(160);
    expect(r.morph.bend).toBe(0);
    expect(r.morph.offsetX).toBeCloseTo(5.5, 5);
    expect(r.morph.halfLen).toBeCloseTo(33.5, 5);
    expect(r.morph.strokeWidth).toBeCloseTo(1.15, 5);
    expect(r.morph.colorMix).toBeCloseTo(0.35, 5);
    // 位置走橡皮筋：越过 max 但被衰减在 overscrollMax 之内
    expect(r.displayTarget).toBeGreaterThan(400);
    expect(r.displayTarget).toBeLessThan(400 + 24);
  });

  it('下限触限方向镜像', () => {
    const r = dragMorphTargets(100 - 160, 300, 100, 400, P);
    expect(r.over).toBe(160);
    expect(r.morph.offsetX).toBeCloseTo(-5.5, 5);
    expect(r.displayTarget).toBeLessThan(100);
    expect(r.displayTarget).toBeGreaterThan(100 - 24);
  });

  it('折叠区：位置目标归 0、沿下限触限形态（绷直/贴靠收起侧/随深度更细更淡）', () => {
    // raw=60 < min=100：over=40，far=40/160=0.25 → stroke=1.8−0.65×0.25、colorMix=1−0.65×0.25
    const r = dragMorphTargets(60, 300, 100, 400, P, true);
    expect(r.displayTarget).toBe(0);
    expect(r.dir).toBe(-1);
    expect(r.over).toBe(40);
    expect(r.morph.bend).toBe(0);
    expect(r.morph.offsetX).toBeCloseTo(-5.5, 5);
    expect(r.morph.halfLen).toBeCloseTo(33.5, 5);
    expect(r.morph.strokeWidth).toBeCloseTo(1.6375, 5);
    expect(r.morph.colorMix).toBeCloseTo(0.8375, 5);
  });

  it('折叠区迟滞带（raw 已回到 min 之上）仍归 0，over 钳为 0', () => {
    const r = dragMorphTargets(130, 300, 100, 400, P, true);
    expect(r.displayTarget).toBe(0);
    expect(r.over).toBe(0);
    expect(r.morph.strokeWidth).toBeCloseTo(1.8, 5);
    expect(r.morph.colorMix).toBeCloseTo(1, 5);
  });
});

describe('颜色插值与端点推导', () => {
  it('mixRgbColor 端点精确、越界钳制', () => {
    expect(mixRgbColor([198, 198, 198], [122, 122, 122], 0)).toBe(
      'rgb(198, 198, 198)'
    );
    expect(mixRgbColor([198, 198, 198], [122, 122, 122], 1)).toBe(
      'rgb(122, 122, 122)'
    );
    expect(mixRgbColor([198, 198, 198], [122, 122, 122], 2)).toBe(
      'rgb(122, 122, 122)'
    );
  });

  it('触限回淡点恰为同一色带 colorMix=0.35 处', () => {
    // 演示：触限远端 colorMix 1→0.35，即回到色带 35% 处变淡
    expect(mixRgbColor([236, 236, 236], [165, 165, 165], 0.35)).toBe(
      'rgb(211, 211, 211)'
    );
  });

  it('deriveActiveRgb：浅色端点向黑走 30%，深色端点向白走 30%', () => {
    expect(deriveActiveRgb([236, 236, 236])).toEqual([165, 165, 165]);
    expect(deriveActiveRgb([58, 58, 58])).toEqual([117, 117, 117]);
  });
});

describe('引擎状态机', () => {
  function stepMany(engine: ElasticHandleEngine, ms: number) {
    const frames = Math.ceil(ms / 16);
    for (let i = 0; i < frames; i += 1) engine.step(16);
  }

  it('初始静止：opacity 0、isAtRest、胶囊路径', () => {
    const engine = new ElasticHandleEngine({ initialValue: 260 });
    expect(engine.getMode()).toBe('idle');
    expect(engine.isAtRest()).toBe(true);
    expect(engine.opacityValue).toBe(0);
    expect(engine.pathD('vertical')).toBe('M 0 -19.5 Q 0 0 0 19.5');
    expect(engine.pathD('horizontal')).toBe('M -19.5 0 Q 0 0 19.5 0');
  });

  it('hover → 胶囊浮现（opacity 弹簧至 1）', () => {
    const engine = new ElasticHandleEngine({ initialValue: 260 });
    engine.setHover(true);
    expect(engine.getMode()).toBe('hover');
    stepMany(engine, 1200);
    expect(engine.opacityValue).toBeCloseTo(1, 2);
    expect(engine.isAtRest()).toBe(true);
    engine.setHover(false);
    stepMany(engine, 1200);
    expect(engine.getMode()).toBe('idle');
    expect(engine.opacityValue).toBeCloseTo(0, 2);
  });

  it('拖拽区间内：位置弹簧跟随呈现值，路径出现弧度', () => {
    const engine = new ElasticHandleEngine({ initialValue: 300 });
    engine.beginDrag(300, 100, 400);
    engine.updateDrag(324);
    stepMany(engine, 1200);
    expect(engine.displayValue).toBeCloseTo(324, 1);
    const d = engine.pathD('vertical');
    // 满拉力 bend=5.6 → 控制点 x = 11 + 5.6*2 = 22.2
    expect(d).toContain('Q 22.2 0');
    expect(engine.strokeWidthValue).toBeCloseTo(2.5, 1);
  });

  it('折叠区：位置弹簧收至 0（拖拽流中当场收起）；退出折叠区恢复跟随', () => {
    const engine = new ElasticHandleEngine({ initialValue: 300 });
    engine.beginDrag(300, 100, 400);
    engine.updateDrag(60, true);
    stepMany(engine, 1200);
    expect(engine.displayValue).toBeCloseTo(0, 1);
    engine.updateDrag(324, false);
    stepMany(engine, 1200);
    expect(engine.displayValue).toBeCloseTo(324, 1);
  });

  it('释放收尾：指针已远时停留 650ms 后淡出至 idle', () => {
    const engine = new ElasticHandleEngine({ initialValue: 300 });
    engine.beginDrag(300, 100, 400);
    engine.updateDrag(560);
    stepMany(engine, 300);
    engine.endDrag(false);
    expect(engine.getMode()).toBe('settle');
    // 停留期内胶囊仍可见
    stepMany(engine, 300);
    expect(engine.opacityValue).toBeGreaterThan(0.5);
    // 越过 650ms 并给足淡出时间
    stepMany(engine, 2500);
    expect(engine.getMode()).toBe('idle');
    expect(engine.opacityValue).toBeCloseTo(0, 2);
    expect(engine.isAtRest()).toBe(true);
  });

  it('释放时指针仍近：停留为胶囊，指针离开后淡出', () => {
    const engine = new ElasticHandleEngine({ initialValue: 300 });
    engine.beginDrag(300, 100, 400);
    engine.updateDrag(320);
    stepMany(engine, 300);
    engine.endDrag(true);
    stepMany(engine, 1500);
    expect(engine.opacityValue).toBeCloseTo(1, 2);
    engine.setHover(false);
    stepMany(engine, 1500);
    expect(engine.getMode()).toBe('idle');
    expect(engine.opacityValue).toBeCloseTo(0, 2);
  });

  it('拖拽尺寸即时 1:1 跟随（无阻尼追赶延迟），同时手柄保持弹簧平滑过渡', () => {
    const engine = new ElasticHandleEngine({ initialValue: 300 });
    engine.beginDrag(300, 100, 400);
    engine.updateDrag(360);
    // 尺寸在第 0 帧即刻等于 360，零延迟跟手
    expect(engine.displayValue).toBe(360);
    // 单帧步进后尺寸依然精确为 360，而形态弹簧在逐步演进
    engine.step(16);
    expect(engine.displayValue).toBe(360);
    expect(engine.isAtRest()).toBe(false); // 手柄仍在过渡
  });

  it('reducedMotion 引擎：一步直达，无弹簧过程', () => {
    const engine = new ElasticHandleEngine({
      initialValue: 300,
      reducedMotion: true,
    });
    engine.setHover(true);
    engine.step(16);
    expect(engine.opacityValue).toBe(1);
    engine.beginDrag(300, 100, 400);
    engine.updateDrag(350);
    engine.step(16);
    expect(engine.displayValue).toBe(350);
    expect(engine.isAtRest()).toBe(true);
  });

  it('圆弧朝向随鼠标瞬时移动方向动态翻转，不记忆最初位置', () => {
    const engine = new ElasticHandleEngine({ initialValue: 300 });
    engine.beginDrag(300, 100, 500);

    // 1. 鼠标向右拖拽：300 -> 350 (+50px)，弧向朝右 (bend > 0)
    engine.updateDrag(350);
    stepMany(engine, 1200);
    expect(engine.pathD('vertical')).toContain('Q 22.2 0');

    // 2. 鼠标折返向左移：350 -> 340 (-10px)。
    // 关键断言：此时 340 仍然大于起始值 300，但由于鼠标是向左移动，弧向必须立刻朝左 (bend < 0)！
    engine.updateDrag(340);
    stepMany(engine, 1200);
    expect(engine.pathD('vertical')).toContain('Q -22.2 0');

    // 3. 鼠标再次向右移：340 -> 345 (+5px)，弧向立即再次朝右
    engine.updateDrag(345);
    stepMany(engine, 1200);
    expect(engine.pathD('vertical')).toContain('Q 22.2 0');
  });

  it('axisSign = -1（如右侧面板）时，圆弧朝向依然保持与物理指针位移严格同向', () => {
    // 对于右侧面板：左移增大宽度（axisSign = -1）
    const engine = new ElasticHandleEngine({ initialValue: 300, axisSign: -1 });
    engine.beginDrag(300, 100, 500);

    // 指针向左移动 20px → 坞宽增加至 320px
    // 关键断言：由于指针向左移动，圆弧必须朝左弯曲 (Q -22.2 0)
    engine.updateDrag(320);
    stepMany(engine, 1200);
    expect(engine.pathD('vertical')).toContain('Q -22.2 0');

    // 指针向右移动 10px → 坞宽减小至 310px
    // 关键断言：由于指针向右移动，圆弧必须朝右弯曲 (Q 22.2 0)
    engine.updateDrag(310);
    stepMany(engine, 1200);
    expect(engine.pathD('vertical')).toContain('Q 22.2 0');
  });
});
