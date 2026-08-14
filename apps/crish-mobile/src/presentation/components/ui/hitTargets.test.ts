// dualHitSlop 工具单测（R2-05k 修正后语义）：iOS 44pt / Android 48dp 双轨补足；
// 宽缺省同高 → 全向补足；全向达标返回 undefined 免设 hitSlop
import { Platform } from 'react-native';
import { dualHitSlop } from './hitTargets';

// jest-expo 默认解析 ios 平台（haste defaultPlatform=ios）；Android 分支用例临时改写 Platform.OS
const ORIGINAL_OS = Platform.OS;

afterEach(() => {
  Platform.OS = ORIGINAL_OS;
});

describe('dualHitSlop（iOS 44pt 下限）', () => {
  it('达到 44 视觉下限 → 返回 undefined 免设 hitSlop', () => {
    expect(dualHitSlop(44)).toBeUndefined();
    expect(dualHitSlop(48)).toBeUndefined();
  });

  it('36×36（返回键/悬浮条）→ 全向补 4', () => {
    expect(dualHitSlop(36)).toEqual({ top: 4, bottom: 4, left: 4, right: 4 });
    expect(dualHitSlop(36, 36)).toEqual({
      top: 4,
      bottom: 4,
      left: 4,
      right: 4,
    });
  });

  it('32×32（排序/密度 chips、关闭钮）→ 全向补 6', () => {
    expect(dualHitSlop(32)).toEqual({ top: 6, bottom: 6, left: 6, right: 6 });
  });

  it('40（四态按钮/重试/终端入口）→ 全向补 2', () => {
    expect(dualHitSlop(40)).toEqual({ top: 2, bottom: 2, left: 2, right: 2 });
  });

  it('28（关于卡重试钮）→ 全向补 8', () => {
    expect(dualHitSlop(28)).toEqual({ top: 8, bottom: 8, left: 8, right: 8 });
  });

  it('宽缺省同高：单参调用按正方形处理', () => {
    expect(dualHitSlop(36)).toEqual(dualHitSlop(36, 36));
  });

  it('宽高不同：仅未达标方向补足（返回对象含 0 边）', () => {
    expect(dualHitSlop(44, 36)).toEqual({
      top: 0,
      bottom: 0,
      left: 4,
      right: 4,
    });
  });
});

describe('dualHitSlop（Android 48dp 热区）', () => {
  beforeEach(() => {
    Platform.OS = 'android';
  });

  it('达到 48 热区目标 → 返回 undefined 免设 hitSlop', () => {
    expect(dualHitSlop(48)).toBeUndefined();
  });

  it('36×36 → 全向补 6', () => {
    expect(dualHitSlop(36)).toEqual({ top: 6, bottom: 6, left: 6, right: 6 });
  });

  it('32 → 全向补 8；40 → 全向补 4', () => {
    expect(dualHitSlop(32)).toEqual({ top: 8, bottom: 8, left: 8, right: 8 });
    expect(dualHitSlop(40)).toEqual({ top: 4, bottom: 4, left: 4, right: 4 });
  });

  it('44 视觉达标但热区未达标 → 各边补 2', () => {
    expect(dualHitSlop(44)).toEqual({ top: 2, bottom: 2, left: 2, right: 2 });
  });
});
