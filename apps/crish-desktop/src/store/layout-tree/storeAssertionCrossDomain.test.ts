import { describe, expect, it } from 'vitest';
import {
  assertIsSessionLevelTab,
  assertIsSessionTab,
  createSessionTab,
  createTerminalTab,
  createBrowserTab,
  type SessionTab,
} from './sessionTabModel';
import { createToolTab } from './dockLayoutModel';
import { insertTab, splitTab } from './layoutTreeInsert';
import { moveTab } from './layoutTreeMoveRemove';
import { useLayoutTreeStore } from './layoutTreeStore';

describe('Phase 3 门禁：storeAssertionCrossDomain 顶层布局树底层鉴权守卫测试', () => {
  describe('assertIsSessionLevelTab 类型守卫纯断言', () => {
    it('合法 ChatTab、StandaloneTerminalTab 与 StandaloneBrowserTab 正常放行', () => {
      const chatTab = createSessionTab({
        tabId: 'tab_chat_1',
        title: '会话 1',
        sessionId: 'sess_123',
      });
      expect(() => assertIsSessionLevelTab(chatTab)).not.toThrow();
      expect(() => assertIsSessionTab(chatTab)).not.toThrow();

      const termTab = createTerminalTab({
        tabId: 'tab_term_1',
        title: '终端 1',
        cwd: 'C:/Users/orange',
      });
      expect(() => assertIsSessionLevelTab(termTab)).not.toThrow();
      expect(() => assertIsSessionTab(termTab)).not.toThrow();

      const browserTab = createBrowserTab({
        tabId: 'tab_browser_1',
        title: '浏览器 1',
        url: 'https://example.com',
      });
      expect(() => assertIsSessionLevelTab(browserTab)).not.toThrow();
      expect(() => assertIsSessionTab(browserTab)).not.toThrow();
    });

    it('非法对象或右坞 ToolTab 抛出 [SECURITY_VIOLATION] 异常', () => {
      const toolTab = createToolTab({
        viewId: 'terminal',
        tabId: 'dtab_tool_1',
      });

      expect(() => assertIsSessionLevelTab(toolTab)).toThrowError(
        /\[SECURITY_VIOLATION\] 右坞工具面板严禁进入顶层大窗口布局树/
      );

      const invalidCandidate = {
        tabId: 'fake_tab',
        kind: 'other',
      };
      expect(() => assertIsSessionLevelTab(invalidCandidate)).toThrowError(
        /\[SECURITY_VIOLATION\]/
      );
    });

    it('字符串 ID 若带有 dtab_ / tool_ / panel_ 等工具前缀直接拦截抛错', () => {
      expect(() => assertIsSessionLevelTab('tool_preview_1')).toThrowError(
        /\[SECURITY_VIOLATION\] 右坞工具面板严禁进入顶层大窗口布局树: tabId=tool_preview_1/
      );
      expect(() => assertIsSessionLevelTab('dtab_terminal_abc')).toThrowError(
        /\[SECURITY_VIOLATION\]/
      );
    });
  });

  describe('算子入口刚性拦截断言（insertTab / splitTab / moveTab / store）', () => {
    it('insertTab 塞入右坞 ToolTab 时抛出 [SECURITY_VIOLATION] 异常', () => {
      const store = useLayoutTreeStore.getState();
      const leafId = store.activeLeafId;
      const toolTab = createToolTab({
        viewId: 'terminal',
      }) as unknown as SessionTab;

      expect(() => {
        insertTab(store.tree, leafId, toolTab);
      }).toThrowError(/\[SECURITY_VIOLATION\]/);
    });

    it('RED-09 / 门禁 3: 绕过前端直接调用 layoutTreeStore.moveTab 塞入右坞 ToolTab ID 时被刚性抛错拦截，顶层树完整无损', () => {
      const store = useLayoutTreeStore.getState();
      const initialTree = store.tree;
      const leafId = store.activeLeafId;

      expect(() => {
        store.moveTab(leafId, 'tool_preview_1', leafId, 0);
      }).toThrowError(/\[SECURITY_VIOLATION\]/);

      // 刚性断言：状态机拒绝执行，顶层树状态 100% 保持一致无损
      expect(useLayoutTreeStore.getState().tree).toBe(initialTree);
    });

    it('调用 splitTab 尝试切分右坞 ToolTab ID 时同样被刚性抛错拦截', () => {
      const store = useLayoutTreeStore.getState();
      const initialTree = store.tree;
      const leafId = store.activeLeafId;

      expect(() => {
        store.splitTab(leafId, 'tool_preview_1', leafId, 'right');
      }).toThrowError(/\[SECURITY_VIOLATION\]/);

      expect(useLayoutTreeStore.getState().tree).toBe(initialTree);
    });
  });
});
