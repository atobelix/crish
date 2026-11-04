// @vitest-environment jsdom
/**
 * useScrollFade 状态机单测（HC1）：四态判定（纯函数）+ jsdom 挂载行为
 * （注入 scrollHeight/clientHeight/scrollTop，scroll 事件 + rAF 合帧后断言）。
 * 验收口径对齐《工具容器高度与内容重复分析》§6.3 的渐变状态机用例。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { attachScrollFade, computeScrollFadeState } from './useScrollFade';

describe('computeScrollFadeState · 四态判定', () => {
  it('不可滚（内容未超出，含 1px 容差）→ none', () => {
    expect(
      computeScrollFadeState({
        scrollTop: 0,
        scrollHeight: 100,
        clientHeight: 100,
      })
    ).toBe('none');
    expect(
      computeScrollFadeState({
        scrollTop: 0,
        scrollHeight: 101,
        clientHeight: 100,
      })
    ).toBe('none');
  });

  it('在顶 → bottom（仅底部渐隐）', () => {
    expect(
      computeScrollFadeState({
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 100,
      })
    ).toBe('bottom');
  });

  it('中间 → both（双端渐隐）', () => {
    expect(
      computeScrollFadeState({
        scrollTop: 150,
        scrollHeight: 400,
        clientHeight: 100,
      })
    ).toBe('both');
  });

  it('在底 → top（仅顶部渐隐）', () => {
    expect(
      computeScrollFadeState({
        scrollTop: 300,
        scrollHeight: 400,
        clientHeight: 100,
      })
    ).toBe('top');
  });
});

describe('attachScrollFade · 挂载行为', () => {
  const hosts: HTMLElement[] = [];

  const makeHost = () => {
    const el = document.createElement('div');
    el.style.overflowY = 'auto';
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get: () => 400,
    });
    Object.defineProperty(el, 'clientHeight', {
      configurable: true,
      get: () => 100,
    });
    document.body.appendChild(el);
    hosts.push(el);
    return el;
  };

  const flushRaf = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );

  afterEach(() => {
    hosts.splice(0).forEach((el) => el.remove());
  });

  it('初始在顶写 bottom，滚动到底写 top，detach 后冻结', async () => {
    const el = makeHost();
    const detach = attachScrollFade(el);
    await flushRaf();
    expect(el.dataset.fade).toBe('bottom');

    el.scrollTop = 300;
    el.dispatchEvent(new Event('scroll'));
    await flushRaf();
    expect(el.dataset.fade).toBe('top');

    detach();
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
    await flushRaf();
    expect(el.dataset.fade).toBe('top');
  });

  it('计算溢出非 auto/scroll 的宿主被强制 none（组内降级视口天然失效）', async () => {
    const el = makeHost();
    el.style.overflowY = 'visible';
    const detach = attachScrollFade(el);
    await flushRaf();
    expect(el.dataset.fade).toBe('none');
    detach();
  });
});
