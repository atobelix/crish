import { describe, expect, it } from 'vitest';
import {
  splitFloatingProps,
  splitModalProps,
  FLOATING_POSITIONER_KEYS,
  FLOATING_PORTAL_KEYS,
  MODAL_PORTAL_KEYS,
  FLOATING_CSS_VARIABLES,
  BASE_UI_DATA_ATTRS,
  BASE_UI_MOTION_TOKENS,
} from '../index';

describe('Base UI Orthogonal Physical Layering Foundation', () => {
  describe('Modal Layering Model (模式 A: 模态遮罩型)', () => {
    it('splits modal portal and popup props correctly', () => {
      const { portal, popup } = splitModalProps({
        container: null,
        keepMounted: true,
        title: 'Settings',
        size: 'lg',
      });

      expect(portal).toEqual({ container: null, keepMounted: true });
      expect(popup).toEqual({ title: 'Settings', size: 'lg' });
    });

    it('merges portalProps escape hatch with flat portal props', () => {
      const customNode = {} as HTMLElement;
      const { portal } = splitModalProps({
        container: customNode,
        portalProps: { keepMounted: true },
      });

      expect(portal).toEqual({ container: customNode, keepMounted: true });
    });
  });

  describe('Floating Layering Model (模式 B: 浮动锚定型)', () => {
    it('routes positioner, portal, and popup props to correct targets', () => {
      const { positioner, portal, popup } = splitFloatingProps({
        side: 'top',
        align: 'center',
        sideOffset: 6,
        collisionPadding: 8,
        sticky: true,
        container: null,
        keepMounted: true,
        id: 'tooltip-popup',
        className: 'custom-popup',
      });

      expect(positioner).toEqual({
        side: 'top',
        align: 'center',
        sideOffset: 6,
        collisionPadding: 8,
        sticky: true,
      });
      expect(portal).toEqual({ container: null, keepMounted: true });
      expect(popup).toEqual({ id: 'tooltip-popup', className: 'custom-popup' });
    });

    it('merges escape hatches with flat props taking precedence', () => {
      const { positioner, portal } = splitFloatingProps({
        side: 'bottom',
        positionerProps: { side: 'top', style: { zIndex: 1200 } },
        portalProps: { container: null },
        keepMounted: true,
      });

      expect(positioner).toEqual({ side: 'bottom', style: { zIndex: 1200 } });
      expect(portal).toEqual({ container: null, keepMounted: true });
    });

    it('drops undefined flat props so predefined defaults survive', () => {
      const { positioner } = splitFloatingProps({
        side: undefined,
        align: 'start',
      });

      expect('side' in positioner).toBe(false);
      expect(positioner).toEqual({ align: 'start' });
    });
  });

  describe('Design Tokens and Contracts', () => {
    it('defines standard CSS variables for positioning', () => {
      expect(FLOATING_CSS_VARIABLES.anchorWidth).toBe('--anchor-width');
      expect(FLOATING_CSS_VARIABLES.availableHeight).toBe('--available-height');
      expect(FLOATING_CSS_VARIABLES.transformOrigin).toBe('--transform-origin');
    });

    it('defines data attributes for state and animation', () => {
      expect(BASE_UI_DATA_ATTRS.nestedDialogOpen).toBe(
        'data-nested-dialog-open'
      );
      expect(BASE_UI_DATA_ATTRS.startingStyle).toBe('data-starting-style');
      expect(BASE_UI_DATA_ATTRS.endingStyle).toBe('data-ending-style');
    });

    it('maintains zero-drift motion tokens', () => {
      expect(BASE_UI_MOTION_TOKENS.enterDurationMs).toBe(150);
      expect(BASE_UI_MOTION_TOKENS.exitDurationMs).toBe(100);
      expect(BASE_UI_MOTION_TOKENS.tooltipDelayShowMs).toBe(350);
    });
  });
});
