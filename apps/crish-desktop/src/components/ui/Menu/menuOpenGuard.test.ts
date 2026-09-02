// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { shouldSuppressMenuReopen, toggleExclusiveMenu } from './menuOpenGuard';
import { layerStackService } from '../internal/layer-stack/LayerStackService';

describe('menuOpenGuard', () => {
  beforeEach(() => {
    layerStackService.dispose();
  });

  afterEach(() => {
    layerStackService.dispose();
  });

  it('toggleExclusiveMenu 开着写死 false，关着写 true', () => {
    let open = true;
    toggleExclusiveMenu(
      open,
      (next) => {
        open = next;
      },
      null
    );
    expect(open).toBe(false);
    toggleExclusiveMenu(
      open,
      (next) => {
        open = next;
      },
      null
    );
    expect(open).toBe(true);
  });

  it('外点关后同一 trigger 抑制重开', () => {
    const btn = document.createElement('button');
    const content = document.createElement('div');
    const outside = document.createElement('div');
    document.body.append(content, btn, outside);
    layerStackService.register({
      id: 'm1',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: () => undefined,
      elementRef: { current: content },
      anchorRef: { current: btn },
    });
    outside.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    );
    expect(shouldSuppressMenuReopen(btn)).toBe(true);
    let open = false;
    toggleExclusiveMenu(
      open,
      (next) => {
        open = next;
      },
      btn
    );
    expect(open).toBe(false);
    content.remove();
    btn.remove();
    outside.remove();
  });

  it('关 A 的外点落在 B 的 trigger 上时，不抑制 B 打开', () => {
    const btnA = document.createElement('button');
    const btnB = document.createElement('button');
    const contentA = document.createElement('div');
    document.body.append(contentA, btnA, btnB);
    layerStackService.register({
      id: 'menu-a',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: () => undefined,
      elementRef: { current: contentA },
      anchorRef: { current: btnA },
    });
    btnB.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    );
    expect(shouldSuppressMenuReopen(btnA)).toBe(true);
    expect(shouldSuppressMenuReopen(btnB)).toBe(false);
    let openB = false;
    toggleExclusiveMenu(
      openB,
      (next) => {
        openB = next;
      },
      btnB
    );
    expect(openB).toBe(true);
    contentA.remove();
    btnA.remove();
    btnB.remove();
  });
});
