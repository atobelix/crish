import { describe, expect, it } from 'vitest';
import { resolveExtensionVerb } from './extensionCardModel';

describe('resolveExtensionVerb', () => {
  it('flips catalog cards between install and uninstall', () => {
    expect(
      resolveExtensionVerb({ placement: 'catalog', installed: false }).verb
    ).toBe('install');
    expect(
      resolveExtensionVerb({ placement: 'catalog', installed: true }).verb
    ).toBe('uninstall');
  });

  it('flips import cards between import and uninstall', () => {
    expect(
      resolveExtensionVerb({ placement: 'import', installed: false }).verb
    ).toBe('import');
    expect(
      resolveExtensionVerb({ placement: 'import', installed: true }).verb
    ).toBe('uninstall');
  });

  it('keeps file plugins on delete', () => {
    expect(
      resolveExtensionVerb({ placement: 'custom', installed: true }).verb
    ).toBe('delete');
    expect(
      resolveExtensionVerb({ placement: 'custom', installed: false }).verb
    ).toBe('delete');
  });
});
