// 跨端 motion 对齐钉版（2026-11-02 漂移比对产物）：
// theme.ts 注释宣称 motion「与桌面 motionTokens.ts 同值」但长期无验证——
// 本次比对发现 decelerate 漂移（移动 [0,0,0.2,1] 慢起变体 vs 桌面
// [0.2,0,0,1] 快出减速）并已修正。本文件把共语义档位以桌面真源字面量
// 钉住防回潮；桌面真源：apps/crish-desktop/src/utils/motionTokens.ts
// （跨 workspace 不 import，以字面量钉 + 注释锚点，改值须两处同改）。
// 体系性差异（非缺陷，不钉）：桌面 spring = Motion v13 visualDuration/bounce
// 体系；移动 = reanimated stiffness/damping/mass 体系（触摸屏偏好回弹）——
// 手感参数各自调优，不做数值对齐。
import { lightTheme } from '@/adapters/platform/theme';

describe('跨端 motion 对齐：与桌面 motionTokens 共语义档位同值', () => {
  it('时长四档与桌面 DURATION_* 同值（真源：桌面 motionTokens.ts）', () => {
    // 桌面：DURATION_MICRO_MS=100 / SNAPPY=120 / FAST=150 / NORMAL=200
    expect(lightTheme.motion.duration.micro).toBe(100);
    expect(lightTheme.motion.duration.snappy).toBe(120);
    expect(lightTheme.motion.duration.fast).toBe(150);
    expect(lightTheme.motion.duration.normal).toBe(200);
  });

  it('缓动曲线：standard / emphasized / decelerate 与桌面 EASE_* 同值', () => {
    // 桌面：EASE_STANDARD = cubic-bezier(0.4, 0, 0.2, 1)
    expect(lightTheme.motion.easing.standard).toEqual([0.4, 0, 0.2, 1]);
    // 桌面：EASE_EMPHASIZED = cubic-bezier(0.16, 1, 0.3, 1)
    expect(lightTheme.motion.easing.emphasized).toEqual([0.16, 1, 0.3, 1]);
    // 桌面：EASE_DECELERATE = cubic-bezier(0.2, 0, 0, 1)——漂移修正钉版
    expect(lightTheme.motion.easing.decelerate).toEqual([0.2, 0, 0, 1]);
  });
});
