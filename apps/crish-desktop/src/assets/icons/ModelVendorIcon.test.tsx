// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ModelVendorIcon } from './ModelVendorIcon';
import { ModelVendorFallback } from './ModelVendorFallback';

describe('ModelVendorIcon & Fallback 组件测试', () => {
  it('应当为收录的主流厂商正确渲染方形原彩底板与矢量', () => {
    const { container: dsContainer } = render(<ModelVendorIcon modelOrVendor="deepseek" size={24} />);
    const dsDiv = dsContainer.querySelector('.model-vendor-icon') as HTMLElement;
    expect(dsDiv).toBeTruthy();
    expect(dsDiv.style.backgroundColor).toBe('rgb(77, 107, 254)'); // #4D6BFE
    expect(dsDiv.querySelector('svg')).toBeTruthy();

    const { container: oaContainer } = render(<ModelVendorIcon modelOrVendor="openai" size={20} />);
    const oaDiv = oaContainer.querySelector('.model-vendor-icon') as HTMLElement;
    expect(oaDiv).toBeTruthy();
    expect(oaDiv.style.backgroundColor).toBe('rgb(0, 0, 0)'); // #000000
  });

  it('应当能自动解析复合模型路径并渲染对应厂商图标', () => {
    const { container } = render(<ModelVendorIcon modelOrVendor="deepseek-ai/DeepSeek-V3" size={24} />);
    const div = container.querySelector('.model-vendor-icon') as HTMLElement;
    expect(div).toBeTruthy();
    expect(div.style.backgroundColor).toBe('rgb(77, 107, 254)');
  });

  it('当模型未收录或为未知私有模型时，应当平稳降级使用桌面软件自身App图标', () => {
    const { container } = render(<ModelVendorIcon modelOrVendor="my-custom-private-model" size={24} />);
    const fallbackDiv = container.querySelector('.model-vendor-fallback') as HTMLElement;
    expect(fallbackDiv).toBeTruthy();

    // 验证包含桌面 app-icon 的专属特征
    const svg = fallbackDiv.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 200 200');
    expect(svg?.innerHTML).toContain('crish-fallback-grad');
    expect(svg?.innerHTML).toContain('#10B981'); // 桌面 App 图标的翡翠绿点
  });

  it('独立的 ModelVendorFallback 应当支持尺寸自适应与圆角比例缩放', () => {
    const { container } = render(<ModelVendorFallback size={32} />);
    const div = container.querySelector('.model-vendor-fallback') as HTMLElement;
    expect(div).toBeTruthy();
    expect(div.style.width).toBe('32px');
    expect(div.style.height).toBe('32px');
    expect(div.style.borderRadius).toBe('8px'); // 32 * 0.25 = 8
  });
});
