import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Streaming Animation, Caret & Performance Tier Tokens Contract', () => {
  const tokenComponentsCssPath = path.resolve(
    __dirname,
    '../../../styles/tokens-components.css'
  );
  const animCssPath = path.resolve(__dirname, '../streaming-animation.css');
  const rowCssPath = path.resolve(__dirname, '../ChatMessageRow.module.css');

  const tokensComponentsCss = fs.readFileSync(tokenComponentsCssPath, 'utf-8');
  const animCss = fs.readFileSync(animCssPath, 'utf-8');
  const rowCss = fs.readFileSync(rowCssPath, 'utf-8');

  it('Zero-Blue 铁律：打字光标与动效表严禁出现 #94a3b8 或冷蓝 HSL 色值', () => {
    expect(animCss).not.toContain('#94a3b8');
    expect(animCss).not.toContain('hsl(215');
    expect(animCss).not.toContain('hsl(220');
    expect(animCss).not.toContain('#64748b');
    expect(animCss).not.toContain('#cbd5e1');
  });

  it('单源光标：ChatMessageRow.module.css 中彻底拔除 ::after 伪元素光标与 @keyframes caret', () => {
    expect(rowCss).not.toContain('assistantText.isStreaming::after');
    expect(rowCss).not.toContain('@keyframes caret');
    expect(rowCss).not.toContain('.streamingCaret');
  });

  it('单源光标 SSOT：streaming-animation.css 确立 .conex-streaming-caret 并绑定 --stream-caret-*', () => {
    expect(animCss).toContain('.conex-streaming-caret');
    expect(animCss).toContain('var(--stream-caret-width');
    expect(animCss).toContain('var(--stream-caret-height');
    expect(animCss).toContain('var(--stream-caret-color');
    expect(animCss).toContain('var(--stream-caret-blink-dur');
    expect(animCss).toContain('@keyframes conex-caret-blink');
  });

  it('动画声明去重：streaming-animation.css 中彻底拔除 @keyframes sd-fade-in', () => {
    expect(animCss).not.toContain('@keyframes sd-fade-in');
  });

  it('Token 完整度：tokens-components.css 完整声明 --stream-caret-* 与 --stream-anim-*', () => {
    expect(tokensComponentsCss).toContain('--stream-caret-color');
    expect(tokensComponentsCss).toContain('--stream-caret-blink-dur');
    expect(tokensComponentsCss).toContain('--stream-caret-width');
    expect(tokensComponentsCss).toContain('--stream-caret-height');
    expect(tokensComponentsCss).toContain('--stream-caret-radius');
    expect(tokensComponentsCss).toContain('--stream-anim-word-fade');
    expect(tokensComponentsCss).toContain('--stream-anim-word-offset-y');
    expect(tokensComponentsCss).toContain('--stream-anim-marker-fade');
    expect(tokensComponentsCss).toContain('--stream-anim-easing');
    expect(tokensComponentsCss).toContain('--stream-pulse-glow');
    expect(tokensComponentsCss).toContain('--stream-pulse-bg');
    expect(tokensComponentsCss).toContain('--stream-pulse-duration');
  });

  it('Light 模式高对比度：--stream-caret-color 必须锁定 --brand-deep (4.88:1)', () => {
    const lightSection = tokensComponentsCss.slice(
      tokensComponentsCss.indexOf("html[data-theme='light']")
    );
    expect(lightSection).toContain('--stream-caret-color: var(--brand-deep);');
  });

  it('Dark 模式高对比度：--stream-caret-color 必须锁定 --brand (8.92:1)', () => {
    const darkSection = tokensComponentsCss.slice(
      tokensComponentsCss.indexOf("html[data-theme='dark']")
    );
    expect(darkSection).toContain('--stream-caret-color: var(--brand);');
  });

  it('性能分档折叠：data-perf-tier="eco" 必须将流式动画折叠为 0ms', () => {
    const ecoSection = tokensComponentsCss.slice(
      tokensComponentsCss.indexOf("html[data-perf-tier='eco']")
    );
    expect(ecoSection).toContain('--stream-anim-word-fade: 0ms;');
    expect(ecoSection).toContain('--stream-caret-blink-dur: 0ms;');
    expect(ecoSection).toContain('--stream-pulse-duration: 0ms;');
    expect(ecoSection).toContain('--stream-pulse-glow: none;');
    expect(ecoSection).toContain('--stream-pulse-bg: transparent;');
  });

  it('性能分档深度绑定：streaming-animation.css 对 Eco 与 Reduced Motion 提供 0 损耗静止兜底', () => {
    expect(animCss).toContain(
      "html[data-perf-tier='eco'] .conex-streaming-caret"
    );
    expect(animCss).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('合成层收敛（12-W1 / U-TERM-DIFF 反转）：streaming-animation.css 禁止常驻 will-change', () => {
    expect(animCss).not.toMatch(/will-change\s*:/);
  });

  it('智能上下文光标抑制：表格与 suppressCaret 修饰符严格隐藏光标', () => {
    expect(animCss).toContain('.suppressCaret .conex-streaming-caret');
    expect(animCss).toContain(
      '[data-contains-table="true"] .conex-streaming-caret'
    );
    expect(animCss).toContain('display: none');
    expect(animCss).toContain('visibility: hidden');
  });

  it('自适应视口围限：封口块剔除 48px 脆弱高度并声明 contain 属性', () => {
    expect(animCss).not.toContain('contain-intrinsic-size: auto 48px');
    expect(animCss).toContain('.md-block-sealed');
    expect(animCss).toContain('contain: layout style paint;');
    expect(animCss).toContain(
      'contain-intrinsic-size: auto var(--stream-table-intrinsic-h, 320px);'
    );
  });
});
