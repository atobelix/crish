// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/G2Surface/SepPanelShell.test.tsx
 *
 * 契约：SEP 族单挂接点（G² 第一波丙 · 槽 B 收敛）——正典油漆只在此处
 * 声明一处：档位 menuOuter（18）/ 填充 surface-overlay / 描边 border-panel /
 * 阴影 --sep-g2-shadow（--shadow-popover 主导层近似）。宿主只留布局类。
 * 注：measured 形态下填充/描边/阴影在形状层 SVG（[data-g2-layer]）上，
 * 不在根节点行内样式里；--sep-g2-shadow 的值由同目录模块 CSS 定义
 * （浅/暗两主题），jsdom 不跑样式表，故此处只断言根节点挂了 shell 类
 * + 形状层 filter 引用了该变量。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SepPanelShell } from './SepPanelShell';
import styles from './SepPanelShell.module.css';

describe('SepPanelShell 单挂接点（G² 第一波丙 · 槽 B）', () => {
  it('正典油漆：档位 menuOuter（18）+ surface-overlay 填充 + border-panel 描边', () => {
    const { container } = render(
      <SepPanelShell width={240} height={120}>
        <span>面板内容</span>
      </SepPanelShell>
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('data-g2-radius')).toBe('menuOuter');
    expect(root.style.borderRadius).toBe('18px');
    const layer = container.querySelector(
      '[data-g2-layer="measured"]'
    ) as SVGSVGElement | null;
    expect(layer, 'measured 形态须渲染形状层 SVG').not.toBeNull();
    const paths = layer!.querySelectorAll('path');
    expect(paths.length).toBeGreaterThanOrEqual(2);
    // 填充路径：G² 轮廓 + surface-overlay
    expect(paths[0].getAttribute('d')).not.toBe('');
    expect(paths[0].style.fill).toBe('var(--surface-overlay)');
    // 描边路径：同路径内缩 + border-panel
    expect(paths[1].getAttribute('d')).not.toBe('');
    expect(paths[1].style.stroke).toBe('var(--border-panel)');
  });

  it('阴影走 --sep-g2-shadow 变量（主导层近似，次层舍去）+ shell 类挂在根节点', () => {
    const { container } = render(
      <SepPanelShell width={240} height={120}>
        <span>面板内容</span>
      </SepPanelShell>
    );
    const root = container.firstElementChild as HTMLElement;
    const layer = container.querySelector(
      '[data-g2-layer="measured"]'
    ) as SVGSVGElement | null;
    expect(layer, 'measured 形态须渲染形状层 SVG').not.toBeNull();
    expect(layer!.style.filter).toContain('drop-shadow(var(--sep-g2-shadow))');
    expect(root.className).toContain(styles.shell);
  });

  it('ref 转发到根节点（可作 Radix asChild / Base UI render 弹层元素）', () => {
    const ref = React.createRef<HTMLDivElement>();
    const { container } = render(
      <SepPanelShell ref={ref} width={240} height={120}>
        <span>面板内容</span>
      </SepPanelShell>
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current).toBe(container.firstElementChild);
  });

  it('宿主 className 与 shell 类合并（不覆盖阴影变量定义点）', () => {
    const { container } = render(
      <SepPanelShell className="host-layout-only" width={240} height={120}>
        <span>面板内容</span>
      </SepPanelShell>
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('host-layout-only');
    expect(root.className).toContain(styles.shell);
  });
});
