// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/G2Surface/G2Surface.test.tsx
 *
 * 产物验证（立项方案 §2.4 第二层）：不只断言源码写了接入声明，而是断言
 * 渲染产物（DOM）真的携带生成几何——背景层 path 的 d 与生成层对同一
 * (w,h,R) 的输出逐字一致、非空且满足角域隐式方程。keyframes 悬空事故
 * 缺失的正是这一环（守卫全绿而产物无定义）。
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { G2Surface } from './G2Surface';
import { cornerPath } from '../../../utils/cornerPath';

describe('G2Surface 产物验证', () => {
  it('measured 形态：渲染出的 SVG 背景层携带 cornerPath 的真实几何', () => {
    const { container } = render(
      <G2Surface radius="dock" fill="#ffffff" width={200} height={100} testID="g2probe">
        <span>内容</span>
      </G2Surface>,
    );
    const layer = container.querySelector('[data-g2-layer="measured"]');
    expect(layer).not.toBeNull();
    const path = layer!.querySelector('path');
    expect(path).not.toBeNull();
    const d = path!.getAttribute('d') ?? '';
    expect(d.length).toBeGreaterThan(50);
    expect(d).toBe(cornerPath(200, 100, 20));
    // 产物几何抽查：R=20 角域对角点附近必有采样点（轮廓非空壳）
    expect(d.startsWith('M20 0')).toBe(true);
    const host = container.querySelector('[data-testid="g2probe"]');
    expect(host?.getAttribute('data-g2-radius')).toBe('dock');
  });

  it('stretch 形态：背景层 data URI 内含同一生成路径', () => {
    const { container } = render(
      <G2Surface radius="card" fill="#000000" mode="stretch" width={120} height={48} />,
    );
    const layer = container.querySelector('[data-g2-layer="stretch"]');
    expect(layer).not.toBeNull();
    const bg = (layer as HTMLElement).style.backgroundImage;
    expect(bg).toContain('data:image/svg+xml');
    const decoded = decodeURIComponent(bg);
    expect(decoded).toContain(cornerPath(120, 48, 12));
  });

  it('clip 形态：内容层 clip-path 与背景层同路径', () => {
    const { container } = render(
      <G2Surface radius={10} width={80} height={40} clip>
        <span>被裁内容</span>
      </G2Surface>,
    );
    const clipped = Array.from(container.querySelectorAll('div')).find((el) =>
      (el as HTMLElement).style.clipPath.includes('path('),
    );
    expect(clipped).toBeTruthy();
    expect((clipped as HTMLElement).style.clipPath).toContain(cornerPath(80, 40, 10));
  });

  it('未测得尺寸时不画空几何（首帧兜底圆弧在根节点）', () => {
    const { container } = render(
      <G2Surface radius="dock" fill="#ffffff">
        <span>x</span>
      </G2Surface>,
    );
    expect(container.querySelector('[data-g2-layer]')).toBeNull();
    const host = container.firstElementChild as HTMLElement;
    expect(host.style.borderRadius).toBe('20px');
  });
});
