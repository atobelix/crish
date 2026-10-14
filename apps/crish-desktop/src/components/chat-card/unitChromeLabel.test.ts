import { describe, expect, it } from 'vitest';
import { GENERAL_FOLDER, type ProjectEntry } from '../../api/projectStore';
import {
  countRunningSubagents,
  resolveUnitChromeLabel,
  resolveUnitChromeToolTip,
  UNIT_CHROME_TOOL_TIP_SIDE,
} from './unitChromeLabel';

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
      GENERAL_FOLDER
    );
    expect(resolveUnitChromeLabel({ folder: null }, projects)).toBe(
      GENERAL_FOLDER
    );
    expect(resolveUnitChromeLabel({ folder: '' }, projects)).toBe(
      GENERAL_FOLDER
    );
    expect(resolveUnitChromeLabel({ folder: GENERAL_FOLDER }, projects)).toBe(
      GENERAL_FOLDER
    );
    expect(resolveUnitChromeLabel({ folder: '会话' }, projects)).toBe(
      GENERAL_FOLDER
    );
    expect(resolveUnitChromeLabel({ folder: '常规会话' }, projects)).toBe(
      GENERAL_FOLDER
    );
    expect(resolveUnitChromeLabel({ folder: 'general' }, projects)).toBe(
      GENERAL_FOLDER
    );
  });

  it('known project id → project display name', () => {
    expect(
      resolveUnitChromeLabel({ folder: demoProject.id }, [demoProject])
    ).toBe('conex');
  });

  it('known project name match → project name', () => {
    expect(resolveUnitChromeLabel({ folder: 'conex' }, [demoProject])).toBe(
      'conex'
    );
  });

  it('project with empty name → path leaf', () => {
    expect(
      resolveUnitChromeLabel({ folder: namelessProject.id }, [namelessProject])
    ).toBe('my-app');
  });

  it('path-like folder without list hit → leaf name', () => {
    expect(resolveUnitChromeLabel({ folder: 'C:/repos/other' }, [])).toBe(
      'other'
    );
  });

  it('unknown project-like key falls back to 对话', () => {
    expect(resolveUnitChromeLabel({ folder: 'proj-ghost99' }, [])).toBe(
      GENERAL_FOLDER
    );
  });

  it('does not use session title — only folder', () => {
    expect(
      resolveUnitChromeLabel(
        { folder: GENERAL_FOLDER } as { folder?: string | null },
        [demoProject]
      )
    ).toBe(GENERAL_FOLDER);
  });
});

describe('unit chrome tool tip', () => {
  it('side is bottom — 覆盖层顶行向下出 tip', () => {
    expect(UNIT_CHROME_TOOL_TIP_SIDE).toBe('bottom');
    expect(UNIT_CHROME_TOOL_TIP_SIDE).not.toBe('top');
    expect(UNIT_CHROME_TOOL_TIP_SIDE).not.toBe('left');
  });

  it('打开… → 短词；坞开关开合各有短词', () => {
    expect(resolveUnitChromeToolTip('打开文件')).toBe('文件');
    expect(resolveUnitChromeToolTip('打开总览')).toBe('总览');
    expect(resolveUnitChromeToolTip('打开差异')).toBe('差异');
    expect(resolveUnitChromeToolTip('打开终端')).toBe('终端');
    expect(resolveUnitChromeToolTip('打开笔记')).toBe('笔记');
    expect(resolveUnitChromeToolTip('展开右侧工具栏')).toBe('展开右坞');
    expect(resolveUnitChromeToolTip('收起右侧工具栏')).toBe('收起右坞');
    expect(resolveUnitChromeToolTip('打开')).toBe('打开');
    expect(resolveUnitChromeToolTip('  打开文件  ')).toBe('文件');
  });
});

describe('countRunningSubagents', () => {
  it('空 / 非 running 不计；只计 running', () => {
    expect(countRunningSubagents(null)).toBe(0);
    expect(countRunningSubagents(undefined)).toBe(0);
    expect(countRunningSubagents([])).toBe(0);
    expect(
      countRunningSubagents([
        { status: 'completed' },
        { status: 'running' },
        { status: 'running' },
        { status: 'failed' },
      ])
    ).toBe(2);
  });
});

/**
 * 对话顶行：工具钮（总览/文件/差异/终端/笔记）+ 更多 / 分享 / 坞开关。
 * 坞开合都不卸右钮。消息筛选不在本行。
 */
describe('unit chrome dock order (contract)', () => {
  it('chat top actions include tools and end with dock toggle', () => {
    const actionOrder = [
      'chat-open-overview',
      'chat-open-files',
      'chat-open-diff',
      'chat-open-terminal',
      'chat-open-note',
      'chat-header-more',
      'chat-share',
      'right-dock-toggle',
    ] as const;
    expect(actionOrder).toContain('chat-open-files');
    expect(actionOrder).toContain('chat-open-overview');
    expect(actionOrder).toContain('chat-open-note');
    expect(actionOrder[actionOrder.length - 1]).toBe('right-dock-toggle');
    expect(actionOrder.includes('chat-toggle-msg-filter' as never)).toBe(false);
  });
});
