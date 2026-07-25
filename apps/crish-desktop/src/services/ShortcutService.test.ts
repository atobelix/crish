// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ConfigService', () => ({
  configService: {
    get: vi.fn(() => ({})),
    set: vi.fn(),
  },
}));

import { ShortcutService } from './ShortcutService';
import { BUILTIN_SHORTCUTS } from './ShortcutRegistry';

describe('ShortcutService', () => {
  let shortcutService: ShortcutService;

  beforeEach(() => {
    localStorage.clear();
    shortcutService = ShortcutService.getInstance();
    shortcutService.destroy();
    shortcutService.init(document);
  });

  describe('Built-in Shortcuts Registration', () => {
    it('registers all builtin shortcuts by default', () => {
      const actions = shortcutService.getAllActions();
      expect(actions.length).toBeGreaterThanOrEqual(BUILTIN_SHORTCUTS.length);

      const navActions = shortcutService.getByCategory('navigation');
      expect(navActions.length).toBeGreaterThan(0);

      expect(shortcutService.getBinding('toggle_settings')).toBe('Ctrl + ,');
      expect(shortcutService.getBinding('new_session')).toBe('Ctrl + N');
    });
  });

  describe('Global Keydown Matching & Callbacks', () => {
    it('matches Ctrl+, for toggle_settings', () => {
      const onMatchCb = vi.fn();
      const unsubscribe = shortcutService.onMatch(onMatchCb);

      const event = new KeyboardEvent('keydown', {
        key: ',',
        ctrlKey: true,
        bubbles: true,
      });
      document.dispatchEvent(event);

      expect(onMatchCb).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'toggle_settings',
        })
      );

      unsubscribe();
    });

    it('matches Ctrl+N for new_session', () => {
      const onMatchCb = vi.fn();
      const unsubscribe = shortcutService.onMatch(onMatchCb);

      const event = new KeyboardEvent('keydown', {
        key: 'n',
        ctrlKey: true,
        bubbles: true,
      });
      document.dispatchEvent(event);

      expect(onMatchCb).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'new_session',
        })
      );

      unsubscribe();
    });

    it('matches sequence Escape Escape for branch_session', () => {
      const onMatchCb = vi.fn();
      shortcutService.onMatch(onMatchCb);

      const esc1 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(esc1);

      const esc2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(esc2);

      expect(onMatchCb).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'branch_session',
        })
      );
    });
  });

  describe('Custom Overrides & Conflict Detection', () => {
    it('allows overriding shortcut binding and resetting to default', () => {
      shortcutService.setCustomOverride('new_session', 'Ctrl + Shift + N');
      expect(shortcutService.getBinding('new_session')).toBe('Ctrl + Shift + N');

      shortcutService.resetCustomOverride('new_session');
      expect(shortcutService.getBinding('new_session')).toBe('Ctrl + N');
    });

    it('detects shortcut binding conflicts', () => {
      shortcutService.setCustomOverride('new_session', 'Ctrl + ,');
      const conflicts = shortcutService.detectConflicts();
      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts[0].binding).toBe('Ctrl + ,');
    });
  });

  describe('Lifecycle Cleanup', () => {
    it('removes event listeners on destroy', () => {
      const onMatchCb = vi.fn();
      shortcutService.onMatch(onMatchCb);
      shortcutService.destroy();

      const event = new KeyboardEvent('keydown', {
        key: 'n',
        ctrlKey: true,
        bubbles: true,
      });
      document.dispatchEvent(event);

      expect(onMatchCb).not.toHaveBeenCalled();
    });
  });
});
