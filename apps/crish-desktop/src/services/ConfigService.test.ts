import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configService } from './ConfigService';

const SHORTCUTS_KEY = 'crish_config_v2:shortcuts.overrides';
const LAYOUT_KEY = 'crish_config_v2:workspace.layout';

describe('ConfigService built-in parsers', () => {
  beforeEach(() => {
    localStorage.removeItem(SHORTCUTS_KEY);
    localStorage.removeItem(LAYOUT_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(SHORTCUTS_KEY);
    localStorage.removeItem(LAYOUT_KEY);
  });

  it('accepts string shortcut bindings and preserves special record keys', () => {
    const overrides = {
      new_session: 'Ctrl+Shift+N',
      ['__proto__']: 'Alt+Shift+P',
    };

    configService.set('shortcuts.overrides', overrides);

    expect(configService.get('shortcuts.overrides')).toEqual(overrides);
  });

  it.each([null, [], { open_settings: 42 }])(
    'rejects invalid shortcut record %j without persisting it',
    (value) => {
      expect(() =>
        configService.set(
          'shortcuts.overrides',
          value as Record<string, string>
        )
      ).toThrow();
      expect(localStorage.getItem(SHORTCUTS_KEY)).toBeNull();
    }
  );

  it('falls back to the empty record when stored shortcut bindings are invalid', () => {
    localStorage.setItem(SHORTCUTS_KEY, JSON.stringify({ open_settings: 42 }));

    expect(configService.get('shortcuts.overrides')).toEqual({});
  });

  it('accepts an optional numeric sidebar width and preserves passthrough fields', () => {
    const layout = { sidebarWidth: 288, sidebarCollapsed: false };
    configService.set('workspace.layout', layout);

    expect(configService.get('workspace.layout')).toEqual(layout);
    expect(() =>
      configService.set('workspace.layout', { compact: true })
    ).not.toThrow();
  });

  it('rejects invalid sidebar widths and falls back for invalid stored values', () => {
    expect(() =>
      configService.set('workspace.layout', { sidebarWidth: 'wide' })
    ).toThrow();
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();

    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ sidebarWidth: 'wide', sidebarCollapsed: true })
    );
    expect(configService.get('workspace.layout')).toEqual({});
  });
});
