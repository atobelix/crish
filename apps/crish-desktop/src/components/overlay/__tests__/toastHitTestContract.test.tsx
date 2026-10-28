// @vitest-environment jsdom
/**
 * 顶部通知「看得见却点不到」回归契约（2026-10-11 诊断）。
 *
 * 三个独立根因，各锁一条：
 * 1. 原生拖拽区吞点击：WebView2 已开 IsNonClientRegionSupportEnabled（wry webview2/mod.rs），
 *    顶栏 spacer 的 app-region:drag 在 HWND 命中阶段生效、与 z-index 无关。通知原先 top:16px，
 *    卡片 y=16..60 与 36px 顶栏带重叠，叉号上 9px 落在 drag 区 → 点叉号变拖窗口。
 *    契约：顶部锚点落在顶栏带下方；卡片自身声明 no-drag。
 * 2. 模态弹窗把通知打成 inert：FocusTrap 白名单写的是不存在的 'toast-portal'，
 *    真实挂载点 #toast-root 被设 inert + aria-hidden，命中直接落到弹窗遮罩。
 * 3. 单条通知悬停不暂停：仅多条时悬停才「展开」，倒计时只认展开态 → 瞄准叉号途中自行退场。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { AppToast } from '../../../services/toast/types';
import { ToastContainer } from '../../../services/toast/ToastContainer';
import { ToastViewport } from '../ToastViewport';
import { Dialog, layerStackService } from '@/components/ui';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));
const CRISH_DESKTOP_ROOT = join(DIR, '../../../..');
const readRepoFile = (p: string): string =>
  readFileSync(join(CRISH_DESKTOP_ROOT, p), 'utf-8');

const TOAST_CSS = readRepoFile(
  'src/components/overlay/ToastStackModern.module.css'
);

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `缺少规则 ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

const mockToast = (id: string, partial: Partial<AppToast> = {}): AppToast => ({
  id,
  message: `通知 ${id}`,
  type: 'info',
  duration: 2000,
  ariaLive: 'polite',
  timestamp: 0,
  updateKey: 0,
  ...partial,
});

describe('顶部通知命中契约：原生拖拽区', () => {
  it('顶部锚点 = 顶栏高度 + 间距，三种 top-* 位置都不得写回字面量 px', () => {
    expect(ruleBody(TOAST_CSS, '.viewport')).toMatch(
      /--toast-viewport-top:\s*calc\(var\(--header-height[^)]*\)\s*\+/
    );
    for (const sel of [
      '.viewportTopRight',
      '.viewportTopCenter',
      '.viewportTopLeft',
    ]) {
      expect(ruleBody(TOAST_CSS, sel)).toMatch(
        /top:\s*var\(--toast-viewport-top\);/
      );
    }
  });

  it('可交互卡片显式 no-drag（两种前缀都要有）', () => {
    const card = ruleBody(TOAST_CSS, '.toastCard');
    expect(card).toMatch(/-webkit-app-region:\s*no-drag;/);
    expect(card).toMatch(/(^|[^-])app-region:\s*no-drag;/m);
    expect(card).toMatch(/pointer-events:\s*auto;/);
  });

  it('通知挂在 #toast-root（顶栏 / drag 子树之外），且 index.html 提供该挂载点', () => {
    expect(readRepoFile('index.html')).toMatch(/<div id="toast-root"><\/div>/);
    expect(readRepoFile('src/services/toast/ToastContainer.tsx')).toMatch(
      /containerId = 'toast-root'/
    );
  });
});

describe('顶部通知命中契约：模态弹窗下仍可交互', () => {
  beforeEach(() => {
    layerStackService.dispose();
    for (const id of ['modal-root', 'toast-root']) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    }
  });

  afterEach(() => {
    cleanup();
    layerStackService.dispose();
    document.body.innerHTML = '';
  });

  it('Dialog 打开时应用主体被 inert，#toast-root 不被 inert / aria-hidden', () => {
    const { container } = render(
      <>
        <ToastContainer toasts={[mockToast('modal-t')]} onDismiss={vi.fn()} />
        <Dialog open title="设置" onClose={vi.fn()}>
          <input aria-label="弹窗输入" />
        </Dialog>
      </>
    );
    const toastRoot = document.getElementById('toast-root')!;
    expect(toastRoot.querySelector('[aria-label="关闭通知"]')).not.toBeNull();
    expect(container).toHaveAttribute('inert');
    expect(toastRoot).not.toHaveAttribute('inert');
    expect(toastRoot).not.toHaveAttribute('aria-hidden');
  });

  it('ToastViewport 注册至 layerStackService，模态弹窗存在时 Esc 仅关闭 Dialog，不误伤 Toast', () => {
    const onCloseDialog = vi.fn();
    const onDismissToast = vi.fn();

    render(
      <>
        <ToastViewport
          toasts={[mockToast('persist-toast')]}
          onDismiss={onDismissToast}
        />
        <Dialog open title="确认对话框" onClose={onCloseDialog}>
          <button type="button">确定</button>
        </Dialog>
      </>
    );

    expect(layerStackService.hasActiveModal()).toBe(true);
    const layers = layerStackService.getLayers();
    const toastLayer = layers.find((l) => l.id === 'toast-viewport');
    expect(toastLayer).toBeDefined();
    expect(toastLayer?.type).toBe('toast');
    expect(toastLayer?.dismissible).toBe(false);

    // 触发全局 Esc 按键
    fireEvent.keyDown(window, { key: 'Escape' });

    // Dialog 响应 Esc 关闭，Toast 坚挺常驻
    expect(onCloseDialog).toHaveBeenCalled();
    expect(onDismissToast).not.toHaveBeenCalled();
  });

  it('ToastViewport portal 属性可独立将视图挂载至 #toast-root', () => {
    render(
      <ToastViewport
        portal
        toasts={[mockToast('portal-toast')]}
        onDismiss={vi.fn()}
      />
    );
    const toastRoot = document.getElementById('toast-root')!;
    expect(toastRoot.querySelector('section[role="region"]')).not.toBeNull();
  });
});

describe('顶部通知交互契约：悬停暂停', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('只有一条通知时，悬停同样冻结倒计时（不展开扇形），移出后续跑', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <ToastViewport toasts={[mockToast('solo')]} onDismiss={onDismiss} />
    );
    const viewport = container.querySelector('section[role="region"]')!;

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      fireEvent.mouseEnter(viewport);
    });
    expect(viewport).toHaveAttribute('data-paused', 'true');
    expect(viewport).toHaveAttribute('data-expanded', 'false');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      fireEvent.mouseLeave(viewport);
    });
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('悬停中通知被清空后，新通知不继承「暂停」', () => {
    const onDismiss = vi.fn();
    const { container, rerender } = render(
      <ToastViewport toasts={[mockToast('a')]} onDismiss={onDismiss} />
    );
    act(() => {
      fireEvent.mouseEnter(container.querySelector('section[role="region"]')!);
    });
    rerender(<ToastViewport toasts={[]} onDismiss={onDismiss} />);
    rerender(<ToastViewport toasts={[mockToast('b')]} onDismiss={onDismiss} />);
    expect(container.querySelector('section[role="region"]')).toHaveAttribute(
      'data-paused',
      'false'
    );
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(onDismiss).toHaveBeenCalledWith('b');
  });

  it('窗口 blur 失焦事件触发时自动解除悬停暂停', () => {
    const { container } = render(
      <ToastViewport toasts={[mockToast('blur-test')]} onDismiss={vi.fn()} />
    );
    const viewport = container.querySelector('section[role="region"]')!;

    act(() => {
      fireEvent.mouseEnter(viewport);
    });
    expect(viewport).toHaveAttribute('data-paused', 'true');

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(viewport).toHaveAttribute('data-paused', 'false');
  });
});
