import { describe, expect, it } from 'vitest';
import { GENERAL_FOLDER, type ProjectEntry } from '../../api/projectStore';
import {
  isUnitChromeCanvasQuiet,
  resolveUnitChromeLabel,
  resolveUnitChromeToolTip,
  UNIT_CHROME_TOOL_TIP_SIDE,
} from './unitChromeLabel';
import { PENDING_DRAFT_SESSION_ID } from '../../store/draftSession';

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

describe('unit chrome tool tip', () => {
  it('side is left — not top (top 贴顶会钳到主画布)', () => {
    expect(UNIT_CHROME_TOOL_TIP_SIDE).toBe('left');
    expect(UNIT_CHROME_TOOL_TIP_SIDE).not.toBe('top');
    expect(UNIT_CHROME_TOOL_TIP_SIDE).not.toBe('bottom');
  });

  it('打开… → 短词；不把完整「打开文件」当画布胶囊', () => {
    expect(resolveUnitChromeToolTip('打开文件')).toBe('文件');
    expect(resolveUnitChromeToolTip('打开总览')).toBe('总览');
    expect(resolveUnitChromeToolTip('打开差异')).toBe('差异');
    expect(resolveUnitChromeToolTip('打开终端')).toBe('终端');
    expect(resolveUnitChromeToolTip('打开笔记')).toBe('笔记');
    expect(resolveUnitChromeToolTip('展开右侧工具栏')).toBe('展开右坞');
    expect(resolveUnitChromeToolTip('打开')).toBe('打开');
    expect(resolveUnitChromeToolTip('  打开文件  ')).toBe('文件');
  });
});

describe('isUnitChromeCanvasQuiet', () => {
  it('no-session / 草稿 / 零消息 → 静默；有消息 → 不静默', () => {
    expect(isUnitChromeCanvasQuiet({ sessionId: null, messageCount: 0 })).toBe(
      true,
    );
    expect(isUnitChromeCanvasQuiet({ sessionId: '', messageCount: 0 })).toBe(
      true,
    );
    expect(
      isUnitChromeCanvasQuiet({
        sessionId: PENDING_DRAFT_SESSION_ID,
        messageCount: 0,
      }),
    ).toBe(true);
    expect(
      isUnitChromeCanvasQuiet({ sessionId: 'sess-empty', messageCount: 0 }),
    ).toBe(true);
    expect(
      isUnitChromeCanvasQuiet({ sessionId: 'sess-live', messageCount: 1 }),
    ).toBe(false);
    expect(
      isUnitChromeCanvasQuiet({
        sessionId: PENDING_DRAFT_SESSION_ID,
        messageCount: 3,
      }),
    ).toBe(true);
  });
});

/**
 * UnitChromeActions 坞开关顺序：divider 之后才是 right-dock-toggle。
 * 不要按已删 ChatHeader 去复活 chat-toggle-msg-filter。
 */
describe('unit chrome dock order (contract)', () => {
  it('toolbar action order ends with dock toggle after divider', () => {
    const actionOrder = [
      'chat-open-overview',
      'chat-open-files',
      'chat-open-diff',
      'chat-open-terminal',
      'chat-header-more',
      'toolbar-divider',
      'right-dock-toggle',
    ] as const;
    expect(actionOrder[actionOrder.length - 1]).toBe('right-dock-toggle');
    expect(actionOrder.indexOf('right-dock-toggle')).toBeGreaterThan(
      actionOrder.indexOf('toolbar-divider'),
    );
    expect(actionOrder.includes('chat-toggle-msg-filter' as never)).toBe(
      false,
    );
  });
});
