// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '@crish/shared-utils';
import { invokeResult } from '../../api/tauriInvoke';
import {
  handleMarkdownEvent,
  parsePathAndLocation,
} from './markdownInteractions';
import type { MarkdownInteractionContext } from './markdownInteractions';

vi.mock('@crish/shared-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@crish/shared-utils')>();
  return { ...actual, copyTextToClipboard: vi.fn() };
});

vi.mock('../../api/tauriInvoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/tauriInvoke')>();
  return { ...actual, invokeResult: vi.fn() };
});

const mockedCopy = vi.mocked(copyTextToClipboard);
const mockedInvoke = vi.mocked(invokeResult);

function ctx(
  overrides: Partial<MarkdownInteractionContext> = {}
): MarkdownInteractionContext {
  return {
    t: ((key: string) => `T:${key}`) as MarkdownInteractionContext['t'],
    ...overrides,
  };
}

function event(
  target: Element,
  currentTarget: Element | null = target.parentElement
): React.MouseEvent<Element> {
  return {
    target,
    currentTarget,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<Element>;
}

beforeEach(() => {
  mockedCopy.mockReset();
  mockedCopy.mockResolvedValue(true);
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue({ status: 'ok', data: null });
  document.body.innerHTML = '';
  Element.prototype.scrollIntoView = vi.fn();
});

describe('parsePathAndLocation', () => {
  it('解析 :line:col 与 #L 区间', () => {
    expect(parsePathAndLocation('src/a.ts:12:3')).toEqual({
      cleanPath: 'src/a.ts',
      line: 12,
      col: 3,
    });
    expect(parsePathAndLocation('src/a.ts#L20-L30')).toEqual({
      cleanPath: 'src/a.ts',
      line: 20,
    });
    expect(parsePathAndLocation('C:\\work\\a.ts:7')).toEqual({
      cleanPath: 'C:\\work\\a.ts',
      line: 7,
    });
  });
});

describe('handleMarkdownEvent', () => {
  it('代码复制按行拼接 .md-code-line 文本', async () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="md-code-block">
        <button class="md-code-copy" data-tooltip-key="markdown.code.copy">copy</button>
        <span class="md-code-line">a</span>
        <span class="md-code-line">b</span>
      </div>`;
    document.body.appendChild(root);
    const button = root.querySelector<HTMLElement>('.md-code-copy')!;
    const onCopyFeedback = vi.fn();

    handleMarkdownEvent(event(button, root), ctx({ onCopyFeedback }));

    await vi.waitFor(() => expect(mockedCopy).toHaveBeenCalledWith('a\nb'));
    expect(button.dataset.copied).toBe('true');
    expect(button.getAttribute('data-tooltip')).toBe('T:common.markdownCopied');
    expect(onCopyFeedback).toHaveBeenCalledWith('success', 'a\nb');
  });

  it('折行 / 折叠按钮切换容器状态', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="md-code-block">
        <button class="md-code-wrap"></button>
        <button class="md-code-fold"></button>
      </div>`;
    document.body.appendChild(root);
    const wrap = root.querySelector<HTMLElement>('.md-code-wrap')!;
    const fold = root.querySelector<HTMLElement>('.md-code-fold')!;
    const block = root.querySelector<HTMLElement>('.md-code-block')!;

    handleMarkdownEvent(event(wrap, root), ctx());
    expect(block.classList.contains('md-code-wrapped')).toBe(true);
    expect(wrap.getAttribute('aria-pressed')).toBe('true');

    handleMarkdownEvent(event(fold, root), ctx());
    expect(block.classList.contains('md-code-collapsed')).toBe(true);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
  });

  it('路径按钮解析行号并拦截可执行后缀', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <button class="md-path-link" data-path="src/a.ts:12:3">a.ts</button>
      <button class="md-path-link" data-path="C:\\tools\\bad.exe">bad</button>`;
    document.body.appendChild(root);
    const [okButton, blockedButton] =
      root.querySelectorAll<HTMLElement>('.md-path-link');

    const onOpenPath = vi.fn();
    const onBlockedPath = vi.fn();
    handleMarkdownEvent(
      event(okButton!, root),
      ctx({ onOpenPath, onBlockedPath })
    );
    expect(onOpenPath).toHaveBeenCalledWith('src/a.ts', { line: 12, col: 3 });

    handleMarkdownEvent(
      event(blockedButton!, root),
      ctx({ onOpenPath, onBlockedPath })
    );
    expect(onBlockedPath).toHaveBeenCalledWith('C:\\tools\\bad.exe');
    expect(onOpenPath).toHaveBeenCalledTimes(1);
  });

  it('外链走 openExternal；javascript: 被拦截且不导航', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <a id="external" href="https://example.test/x">x</a>
      <a id="danger" href="javascript:alert(1)">bad</a>`;
    document.body.appendChild(root);
    const external = root.querySelector<HTMLElement>('#external')!;
    const danger = root.querySelector<HTMLElement>('#danger')!;

    const openExternal = vi.fn();
    const externalEvent = event(external, root);
    handleMarkdownEvent(externalEvent, ctx({ openExternal }));
    expect(openExternal).toHaveBeenCalledWith('https://example.test/x');
    expect(externalEvent.preventDefault).toHaveBeenCalled();

    const dangerEvent = event(danger, root);
    handleMarkdownEvent(
      dangerEvent,
      ctx({ openExternal, onOpenPath: vi.fn() })
    );
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(dangerEvent.preventDefault).toHaveBeenCalled();
  });

  it('页内锚点滚动到目标元素', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <a href="#sec">jump</a>
      <h2 id="sec">section</h2>`;
    document.body.appendChild(root);
    const anchor = root.querySelector<HTMLElement>('a')!;
    const heading = root.querySelector<HTMLElement>('#sec')!;
    const spy = vi.spyOn(heading, 'scrollIntoView');

    handleMarkdownEvent(event(anchor, root), ctx());
    expect(spy).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
  });

  it('相对路径链接走本地路径打开，不触发 WebView 导航', () => {
    const root = document.createElement('div');
    root.innerHTML = `<a href="./src/a.ts:5">file</a>`;
    document.body.appendChild(root);
    const anchor = root.querySelector<HTMLElement>('a')!;
    const onOpenPath = vi.fn();
    const mouseEvent = event(anchor, root);

    handleMarkdownEvent(mouseEvent, ctx({ onOpenPath }));
    expect(onOpenPath).toHaveBeenCalledWith('./src/a.ts', { line: 5 });
    expect(mouseEvent.preventDefault).toHaveBeenCalled();
  });
});
