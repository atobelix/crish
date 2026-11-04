// @vitest-environment jsdom
/**
 * ScrollFadeRegion 组件契约（F1 · 渐隐组件化）：
 * - 结构：宿主 div + .scroll-fade-inner 内层（组件是全仓唯一手写
 *   该类名的声明式入口，宿主不得绕开组件自拼内层）；
 * - innerClassName 合并、innerAs='pre' 语义内层、ref 转发到宿主、
 *   data-* 与 aria-* 属性经 rest 落宿主；
 * - active 透传 useScrollFade 状态机：active=true 时 data-fade 随
 *   滚动四态维护，active=false 时状态机不挂载、data-fade 永不写。
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { ScrollFadeRegion } from './ScrollFadeRegion';

const flushRaf = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );

describe('ScrollFadeRegion · 结构契约', () => {
  it('宿主 + 内层两层结构，内层必带 scroll-fade-inner 并合并 innerClassName', () => {
    const { container } = render(
      <ScrollFadeRegion className="host-cls" innerClassName="inner-cls">
        <span>正文</span>
      </ScrollFadeRegion>
    );
    const host = container.firstElementChild as HTMLElement;
    expect(host.tagName).toBe('DIV');
    expect(host.classList.contains('host-cls')).toBe(true);
    expect(host.dataset.slot).toBe('scroll-fade-region');
    const inner = host.firstElementChild as HTMLElement;
    expect(inner.tagName).toBe('DIV');
    expect(inner.classList.contains('scroll-fade-inner')).toBe(true);
    expect(inner.classList.contains('inner-cls')).toBe(true);
    expect(inner.textContent).toBe('正文');
  });

  it("innerAs='pre' 时内层为语义 pre 元素（shell 命令视口形态）", () => {
    const { container } = render(
      <ScrollFadeRegion innerAs="pre" innerClassName="cmd-cls">
        ls -la
      </ScrollFadeRegion>
    );
    const host = container.firstElementChild as HTMLElement;
    const inner = host.firstElementChild as HTMLElement;
    expect(inner.tagName).toBe('PRE');
    expect(inner.classList.contains('scroll-fade-inner')).toBe(true);
    expect(inner.classList.contains('cmd-cls')).toBe(true);
    expect(inner.textContent).toBe('ls -la');
  });

  it('ref 转发到宿主元素；data-*/aria-* 经 rest 落宿主而非内层', () => {
    const ref = React.createRef<HTMLDivElement>();
    const { container } = render(
      <ScrollFadeRegion ref={ref} data-testid="fade-host" aria-label="输出区">
        x
      </ScrollFadeRegion>
    );
    const host = container.firstElementChild as HTMLElement;
    expect(ref.current).toBe(host);
    expect(host.dataset.testid).toBe('fade-host');
    expect(host.getAttribute('aria-label')).toBe('输出区');
    const inner = host.firstElementChild as HTMLElement;
    expect(inner.dataset.testid).toBeUndefined();
  });

  it('fadeSize 档位注入 --tool-fade-size 变量与 data-fade-size', () => {
    const { container: cSm } = render(
      <ScrollFadeRegion fadeSize="sm">内容</ScrollFadeRegion>
    );
    const hostSm = cSm.firstElementChild as HTMLElement;
    expect(hostSm.dataset.fadeSize).toBe('sm');
    expect(hostSm.style.getPropertyValue('--tool-fade-size')).toContain(
      'var(--tool-fade-size-sm'
    );

    const { container: cLg } = render(
      <ScrollFadeRegion fadeSize="lg">内容</ScrollFadeRegion>
    );
    const hostLg = cLg.firstElementChild as HTMLElement;
    expect(hostLg.dataset.fadeSize).toBe('lg');
    expect(hostLg.style.getPropertyValue('--tool-fade-size')).toContain(
      'var(--tool-fade-size-lg'
    );

    const { container: cDef } = render(
      <ScrollFadeRegion fadeSize="default">内容</ScrollFadeRegion>
    );
    const hostDef = cDef.firstElementChild as HTMLElement;
    expect(hostDef.dataset.fadeSize).toBeUndefined();
  });

  it('safePadding={true} 注入 safe-padding 类名与 data-safe-padding 属性', () => {
    const { container } = render(
      <ScrollFadeRegion safePadding>内容</ScrollFadeRegion>
    );
    const host = container.firstElementChild as HTMLElement;
    expect(host.dataset.safePadding).toBe('true');
    const inner = host.firstElementChild as HTMLElement;
    expect(inner.classList.contains('scroll-fade-safe-padding')).toBe(true);
  });
});

describe('ScrollFadeRegion · 状态机接线', () => {
  const makeScrollable = (host: HTMLElement) => {
    Object.defineProperty(host, 'scrollHeight', {
      configurable: true,
      get: () => 400,
    });
    Object.defineProperty(host, 'clientHeight', {
      configurable: true,
      get: () => 100,
    });
  };

  it('active=true：状态机挂载，在顶为 bottom，滚动后切 both 与 top', async () => {
    const { container } = render(
      <ScrollFadeRegion style={{ overflowY: 'auto' }}>x</ScrollFadeRegion>
    );
    const host = container.firstElementChild as HTMLElement;
    makeScrollable(host);
    host.scrollTop = 0;
    host.dispatchEvent(new Event('scroll'));
    await flushRaf();
    expect(host.dataset.fade).toBe('bottom');

    host.scrollTop = 150;
    host.dispatchEvent(new Event('scroll'));
    await flushRaf();
    expect(host.dataset.fade).toBe('both');

    host.scrollTop = 300;
    host.dispatchEvent(new Event('scroll'));
    await flushRaf();
    expect(host.dataset.fade).toBe('top');
  });

  it('active=false：状态机不挂载，data-fade 永不写（折叠态口径）', async () => {
    const { container } = render(
      <ScrollFadeRegion active={false} style={{ overflowY: 'auto' }}>
        x
      </ScrollFadeRegion>
    );
    const host = container.firstElementChild as HTMLElement;
    makeScrollable(host);
    host.dispatchEvent(new Event('scroll'));
    await flushRaf();
    expect(host.dataset.fade).toBeUndefined();
  });
});
