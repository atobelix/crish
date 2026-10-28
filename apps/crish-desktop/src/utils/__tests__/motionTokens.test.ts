import { describe, expect, it } from 'vitest';
import {
  springPhysical,
  calculateSafeStagger,
  calcAccordionDuration,
  MOTION_SPRING,
  MOTION_STAGGER,
} from '../motionTokens';

describe('motionTokens 动效力学与工具函数', () => {
  it('springPhysical 在 bounce=0 时严格保持临界阻尼力学特征', () => {
    const result = springPhysical(MOTION_SPRING.snappy);
    expect(result.type).toBe('spring');
    expect(result.mass).toBe(1);

    // 理论根：root = 2 * PI / (0.26 * 1.2) = 20.1384
    // stiffness = root^2 = 405.55
    // damping = 2 * (1 - 0) * root = 40.277
    const expectedRoot = (2 * Math.PI) / (0.26 * 1.2);
    const expectedStiffness = expectedRoot * expectedRoot;
    const expectedDamping = 2 * expectedRoot;

    expect(result.stiffness).toBeCloseTo(expectedStiffness, 1);
    expect(result.damping).toBeCloseTo(expectedDamping, 1);

    // 临界阻尼比 zeta = c / (2 * sqrt(k * m)) 必须严格等于 1.0
    const zeta =
      result.damping / (2 * Math.sqrt(result.stiffness * result.mass));
    expect(zeta).toBeCloseTo(1.0, 3);
  });

  it('calculateSafeStagger 正确执行上限熔断与自适应压缩', () => {
    // 1. 少条目时采用偏好值
    const smallCount = calculateSafeStagger(5, 0.04, 0.4);
    expect(smallCount).toBe(0.04);

    // 2. 达到临界时准确平分
    const exactCount = calculateSafeStagger(11, 0.04, 0.4);
    expect(exactCount).toBe(0.04); // 10 * 0.04 = 0.4s

    // 3. 超大列表时触发熔断，压缩步长保证总时长不超过 0.4s
    const largeCount = calculateSafeStagger(41, 0.04, 0.4);
    expect(largeCount).toBe(0.01); // 40 * 0.01 = 0.4s
    expect(largeCount * 40).toBeLessThanOrEqual(0.4001);

    // 4. 单项或空列表返回 0
    expect(calculateSafeStagger(1)).toBe(0);
    expect(calculateSafeStagger(0)).toBe(0);
  });

  it('calcAccordionDuration 对数饱和自适应时长与开闭非对称性', () => {
    // 1. 展开（180ms ~ 480ms）
    const openSmall = calcAccordionDuration(30, true);
    expect(openSmall).toBe(200);

    const openMedium = calcAccordionDuration(120, true);
    expect(openMedium).toBe(242);

    const openLarge = calcAccordionDuration(500, true);
    expect(openLarge).toBe(328);

    const open3000 = calcAccordionDuration(3000, true);
    expect(open3000).toBe(473);

    const openCapped = calcAccordionDuration(5000, true);
    expect(openCapped).toBe(480); // 封顶 480ms

    // 2. 收起（150ms ~ 350ms）
    const closeSmall = calcAccordionDuration(30, false);
    expect(closeSmall).toBe(165);

    const closeMedium = calcAccordionDuration(120, false);
    expect(closeMedium).toBe(195);

    const closeLarge = calcAccordionDuration(500, false);
    expect(closeLarge).toBe(257);

    const closeCapped = calcAccordionDuration(5000, false);
    expect(closeCapped).toBe(350); // 封顶 350ms

    // 3. 非法高度防护
    expect(calcAccordionDuration(-10, true)).toBe(180);
    expect(calcAccordionDuration(Number.NaN, false)).toBe(150);
  });
});
