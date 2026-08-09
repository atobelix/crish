// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('./ConfigService', () => ({
  configService: {
    get: vi.fn(() => ({})),
    set: vi.fn(),
  },
}));

import { ShortcutService } from './ShortcutService';
import { BUILTIN_SHORTCUTS } from './ShortcutRegistry';

/** 读取源码做 fs 契约断言（仿 style-contract.test.ts 模式，不依赖 process.cwd） */
function readSrc(relPath: string): string {
  const target = `../../${relPath}`;
  return readFileSync(new URL(target, import.meta.url), 'utf8');
}

/** 序列绑定判定：不含修饰键 '+' 且含空格（与 ShortcutService.isSequenceBinding 同语义） */
function isSequenceBinding(binding: string): boolean {
  return !binding.includes('+') && binding.trim().includes(' ');
}

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

    it('matches Ctrl+Shift+F for branch_session（Esc Esc 误触分叉已改键，T2-4）', () => {
      const onMatchCb = vi.fn();
      shortcutService.onMatch(onMatchCb);

      const evt = new KeyboardEvent('keydown', {
        key: 'f',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      });
      document.dispatchEvent(evt);

      expect(onMatchCb).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'branch_session',
        })
      );
    });

    it('连按两次 Esc 不触发任何动作（无序列绑定残留，Esc 单键语义唯一 = 关闭/取消）', () => {
      const onMatchCb = vi.fn();
      shortcutService.onMatch(onMatchCb);

      const esc1 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(esc1);

      const esc2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(esc2);

      expect(onMatchCb).not.toHaveBeenCalled();
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

  describe('单源契约（T2-5，注册面 ↔ 消费面 ↔ 展示面）', () => {
    it('注册表无序列绑定残留（branch_session 已改 Ctrl+Shift+F，防 Esc Esc 误触回潮）', () => {
      for (const meta of BUILTIN_SHORTCUTS) {
        expect(
          isSequenceBinding(meta.defaultBinding),
          `注册表 id=${meta.id} 存在序列绑定 ${meta.defaultBinding}，Esc 单键语义将不再唯一`
        ).toBe(false);
      }
    });

    it('注册表每 id 的 defaultBinding 在服务注册后实际生效（含平台解析）', () => {
      for (const meta of BUILTIN_SHORTCUTS) {
        expect(shortcutService.getBinding(meta.id)).not.toBe('');
      }
    });

    it('消费面（AppShortcuts switch case + inEditable 豁免白名单）引用 ⊆ 注册表 id', () => {
      const appShortcutsSrc = readSrc('src/app/AppShortcuts.ts');
      const registeredIds = new Set(BUILTIN_SHORTCUTS.map((m) => m.id));

      const caseIds = new Set(
        [...appShortcutsSrc.matchAll(/case\s+'([\w]+)'\s*:/g)].map((m) => m[1]!)
      );
      const whiteBlock = appShortcutsSrc.match(
        /!\[([\s\S]*?)\]\.includes\(\s*actionId\s*\)/
      );
      const whitelistIds = whiteBlock
        ? [...whiteBlock[1]!.matchAll(/'([\w]+)'/g)].map((m) => m[1]!)
        : [];

      const consumedIds = new Set([...caseIds, ...whitelistIds]);
      const orphans = [...consumedIds].filter((id) => !registeredIds.has(id));
      expect(orphans, `消费面引用了未注册的 id：${orphans.join(', ')}`).toEqual([]);
    });

    it('注册表每 id 都有执行面 handler（switch case 覆盖，防注册无 handler 回潮）', () => {
      const appShortcutsSrc = readSrc('src/app/AppShortcuts.ts');
      const caseIds = new Set(
        [...appShortcutsSrc.matchAll(/case\s+'([\w]+)'\s*:/g)].map((m) => m[1]!)
      );
      const registeredIds = new Set(BUILTIN_SHORTCUTS.map((m) => m.id));

      const unhandled = [...registeredIds].filter((id) => !caseIds.has(id));
      expect(
        unhandled,
        `注册表 id 无执行面 handler：${unhandled.join(', ')}（退役键须从注册表移除而非保留）`
      ).toEqual([]);
    });

    it('注册表无已退役的幽灵 id（toggle_runtime / command_palette / close_tab 不复活）', () => {
      const ids = new Set(BUILTIN_SHORTCUTS.map((m) => m.id));
      for (const retired of ['toggle_runtime', 'command_palette', 'close_tab']) {
        expect(ids.has(retired), `${retired} 已退役，不得重新注册`).toBe(false);
      }
    });
  });
});
