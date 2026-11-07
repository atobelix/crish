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
import {
  cornerPath,
  setCornerScheme,
} from '../../../utils/cornerPath';

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

  it('stroke 形态：描边由同路径内缩轮廓生成（待裁决 #5 默认 (a) 同路径描边）', () => {
    const { container } = render(
      <G2Surface
        radius={10}
        fill="#f5f5f5"
        stroke="#dddddd"
        width={120}
        height={60}
      >
        <span>带边框面</span>
      </G2Surface>,
    );
    const layer = container.querySelector('[data-g2-layer="measured"]');
    expect(layer).not.toBeNull();
    const paths = layer!.querySelectorAll('path');
    expect(paths.length).toBe(2);
    // 填充轮廓 = 全尺寸生成路径；描边轮廓 = 内缩 1px + 逐角 R−0.5 的同源路径，
    // 平移 0.5 后居中描画，二者外缘重合
    expect(paths[0]!.getAttribute('d')).toBe(cornerPath(120, 60, 10));
    expect(paths[0]!.style.fill).toBe('rgb(245, 245, 245)');
    expect(paths[1]!.getAttribute('d')).toBe(cornerPath(119, 59, 9.5));
    expect(paths[1]!.getAttribute('transform')).toBe('translate(0.5 0.5)');
    expect(paths[1]!.style.stroke).toBe('rgb(221, 221, 221)');
    expect(paths[1]!.style.fill).toBe('none');
  });

  it('stroke 形态（DPR 1.25）：描边宽对齐设备像素网格，内缩几何同源跟随', () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', {
      value: 1.25,
      configurable: true,
    });
    try {
      const { container } = render(
        <G2Surface
          radius={10}
          fill="#f5f5f5"
          stroke="#dddddd"
          width={120}
          height={60}
        >
          <span>带边框面</span>
        </G2Surface>,
      );
      const layer = container.querySelector('[data-g2-layer="measured"]');
      expect(layer).not.toBeNull();
      const paths = layer!.querySelectorAll('path');
      expect(paths.length).toBe(2);
      // 填充轮廓不受描边对齐影响；描边宽 1 → 0.8（恰 1 设备 px），
      // 内缩轮廓按 (120−0.8, 60−0.8, R−0.4) 生成、平移 0.4 居中
      expect(paths[0]!.getAttribute('d')).toBe(cornerPath(120, 60, 10));
      expect(paths[1]!.getAttribute('d')).toBe(cornerPath(119.2, 59.2, 9.6));
      expect(paths[1]!.getAttribute('transform')).toBe('translate(0.4 0.4)');
      expect(paths[1]!.style.strokeWidth).toBe('0.8');
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        value: original,
        configurable: true,
      });
    }
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

  it('ref 转发（第一波丙）：外部 ref 挂到与量测同一的根节点（可作 asChild/render 弹层元素）', () => {
    const ref = React.createRef<HTMLDivElement>();
    const { container } = render(
      <G2Surface ref={ref} radius="dock" fill="#ffffff" width={200} height={100}>
        <span>内容</span>
      </G2Surface>,
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current).toBe(container.firstElementChild);
    expect(ref.current?.getAttribute('data-g2-radius')).toBe('dock');
    expect(ref.current?.style.borderRadius).toBe('20px');
  });

  it('双方案：真源选择点切到 concentric 时，渲染产物换同心圆弧轮廓', () => {
    setCornerScheme('concentric');
    try {
      const { container } = render(
        <G2Surface radius="dock" fill="#ffffff" width={200} height={100}>
          <span>内容</span>
        </G2Surface>,
      );
      const layer = container.querySelector('[data-g2-layer="measured"]');
      expect(layer).not.toBeNull();
      const d = layer!.querySelector('path')!.getAttribute('d') ?? '';
      // 与生成层同参 concentric 输出逐字一致，且与 G² 产物不同（角点换形、
      // 骨架锚点 M20 0 不变——占位不因方案而变）
      expect(d).toBe(cornerPath(200, 100, 20, undefined, 'concentric'));
      // 对照必须显式钉 'g2'：无方案调用此刻跟随已翻转的选择点，同为 concentric
      expect(d).not.toBe(cornerPath(200, 100, 20, undefined, 'g2'));
      expect(d.startsWith('M20 0')).toBe(true);
    } finally {
      setCornerScheme('g2');
    }
  });
});
