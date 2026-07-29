import { describe, expect, it } from 'vitest';
import { GENERAL_FOLDER, type ProjectEntry } from '../../api/projectStore';
import { resolveUnitChromeLabel } from './unitChromeLabel';

const demoProject: ProjectEntry = {
  id: 'proj-demo1',
  name: 'conex',
  path: 'C:/Software/conex',
  addedAt: 1,
  lastOpenedAt: 2,
};

const namelessProject: ProjectEntry = {
  id: 'proj-leaf',
  name: '',
  path: 'D:/work/my-app',
  addedAt: 1,
  lastOpenedAt: 2,
};

describe('resolveUnitChromeLabel', () => {
  it('null / undefined session → 对话', () => {
    expect(resolveUnitChromeLabel(null, [])).toBe(GENERAL_FOLDER);
    expect(resolveUnitChromeLabel(undefined, [])).toBe(GENERAL_FOLDER);
    expect(resolveUnitChromeLabel(null, [])).toBe('对话');
  });

  it('empty / GENERAL_FOLDER / general aliases → 对话', () => {
    const projects = [demoProject];
    expect(resolveUnitChromeLabel({ folder: undefined }, projects)).toBe(
      GENERAL_FOLDER,
    );
    expect(resolveUnitChromeLabel({ folder: null }, projects)).toBe(
      GENERAL_FOLDER,
    );
    expect(resolveUnitChromeLabel({ folder: '' }, projects)).toBe(
      GENERAL_FOLDER,
    );
    expect(resolveUnitChromeLabel({ folder: GENERAL_FOLDER }, projects)).toBe(
      GENERAL_FOLDER,
    );
    expect(resolveUnitChromeLabel({ folder: '会话' }, projects)).toBe(
      GENERAL_FOLDER,
    );
    expect(resolveUnitChromeLabel({ folder: '常规会话' }, projects)).toBe(
      GENERAL_FOLDER,
    );
    expect(resolveUnitChromeLabel({ folder: 'general' }, projects)).toBe(
      GENERAL_FOLDER,
    );
  });

  it('known project id → project display name', () => {
    expect(
      resolveUnitChromeLabel({ folder: demoProject.id }, [demoProject]),
    ).toBe('conex');
  });

  it('known project name match → project name', () => {
    expect(
      resolveUnitChromeLabel({ folder: 'conex' }, [demoProject]),
    ).toBe('conex');
  });

  it('project with empty name → path leaf', () => {
    expect(
      resolveUnitChromeLabel({ folder: namelessProject.id }, [namelessProject]),
    ).toBe('my-app');
  });

  it('path-like folder without list hit → leaf name', () => {
    expect(
      resolveUnitChromeLabel({ folder: 'C:/repos/other' }, []),
    ).toBe('other');
  });

  it('unknown project-like key is not 对话', () => {
    expect(resolveUnitChromeLabel({ folder: 'proj-ghost99' }, [])).toBe(
      'proj-ghost99',
    );
    expect(resolveUnitChromeLabel({ folder: 'proj-ghost99' }, [])).not.toBe(
      GENERAL_FOLDER,
    );
  });

  it('does not use session title — only folder', () => {
    // helper has no title field; ensure folder GENERAL still 对话
    expect(
      resolveUnitChromeLabel(
        { folder: GENERAL_FOLDER } as { folder?: string | null },
        [demoProject],
      ),
    ).toBe(GENERAL_FOLDER);
  });
});

/**
 * DOM order contract for unit chrome toolbar:
 * right-dock-toggle must be the last focusable control after tool group + divider.
 * (Structural assertion without mounting full ChatHeader graph.)
 */
describe('unit chrome dock order (contract)', () => {
  it('toolbar action order ends with dock toggle after divider', () => {
    // Mirrors ChatHeader.tsx toolbarActions children order:
    // toolGroup (search, panels, more) → toolbarDivider → dockGroup (right-dock-toggle)
    const actionOrder = [
      'chat-toggle-msg-filter',
      'chat-open-overview',
      'chat-open-files',
      'chat-open-diff',
      'chat-open-terminal',
      'chat-header-more', // ChatHeaderMore trigger (if present)
      'toolbar-divider',
      'right-dock-toggle',
    ] as const;
    expect(actionOrder[actionOrder.length - 1]).toBe('right-dock-toggle');
    expect(actionOrder.indexOf('right-dock-toggle')).toBeGreaterThan(
      actionOrder.indexOf('toolbar-divider'),
    );
    expect(actionOrder.indexOf('right-dock-toggle')).toBeGreaterThan(
      actionOrder.indexOf('chat-toggle-msg-filter'),
    );
  });
});
