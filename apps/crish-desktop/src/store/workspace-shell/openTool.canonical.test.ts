import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openFileViewerInSession, readLeafDock } from './openTool';
import { useLayoutTreeStore } from '../layout-tree/layoutTreeStore';
import * as workspaceFsApi from '../../api/workspaceFsApi';
import {
  createDefaultDockTree,
  collectSpatialLeaves,
} from '../layout-tree/dockLayoutModel';

describe('openFileViewerInSession (V2 DockTree 规范化、去重与参数流直通测试)', () => {
  const mockLeafId = 'leaf-test-canonical';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(workspaceFsApi, 'getWorkspacePath').mockReturnValue(
      'C:/Software/conex'
    );

    useLayoutTreeStore.setState({
      activeLeafId: mockLeafId,
      tree: {
        root: {
          id: mockLeafId,
          type: 'leaf',
          tabs: [
            {
              tabId: 'tab-1',
              sessionId: 'sess-1',
              title: '主对话',
              dock: {
                collapsed: false,
                widthRatio: 0.5,
                tree: createDefaultDockTree(),
              },
            },
          ],
          activeTabId: 'tab-1',
          dock: {
            collapsed: false,
            widthRatio: 0.5,
            tree: createDefaultDockTree(),
          },
        },
      },
    });
  });

  it('1. V2 ToolTab 严禁拼接 ?mode=diff，保持纯净不可变 tabId 并直通 initialMode 参数', () => {
    openFileViewerInSession('src/App.tsx', 'diff');

    const state = useLayoutTreeStore.getState();
    const leaf = state.tree.root as any;
    const dock = readLeafDock(leaf);

    const leaves = collectSpatialLeaves(dock.tree.root);
    const tabs = leaves.flatMap((l) => l.tabs);

    expect(tabs.length).toBe(1);
    const tab = tabs[0];

    // 断言 Tab ID 绝无 ?mode=diff 污染，且为规范的前缀
    expect(tab.viewId).toBe('file-viewer');
    expect(tab.tabId).toMatch(/^dtab_file-viewer_/);
    expect(tab.tabId).not.toContain('?mode=');
    expect(dock.collapsed).toBe(false);

    // 断言参数直通在 params 字段中
    expect(tab.params?.filePath).toBe('C:/Software/conex/src/App.tsx');
    expect(tab.params?.initialMode).toBe('diff');
  });

  it('2. 异构模式调用相同物理文件时，绝对不产生重复同名 Tab (BUG-A02 根治验证)', () => {
    // 第一次调用：由 Diff 超链接唤起，传入 'diff'
    openFileViewerInSession('src/components/Button.tsx', 'diff');

    // 第二次调用：由文件树或快捷键唤起，传入默认 'plain'
    openFileViewerInSession('src/components/Button.tsx', 'plain');

    const state = useLayoutTreeStore.getState();
    const leaf = state.tree.root as any;
    const dock = readLeafDock(leaf);

    const leaves = collectSpatialLeaves(dock.tree.root);
    const tabs = leaves.flatMap((l) => l.tabs);

    // 统计包含 Button.tsx 的 Tab 数量
    const buttonTabs = tabs.filter((t) =>
      (t.params?.filePath as string)?.includes('Button.tsx')
    );

    expect(buttonTabs.length).toBe(1);
    expect(buttonTabs[0].params?.filePath).toBe(
      'C:/Software/conex/src/components/Button.tsx'
    );
    // 热更新后模式就地变为 'plain'
    expect(buttonTabs[0].params?.initialMode).toBe('plain');
  });

  it('3. Windows 小写盘符与大写盘符输入，自动收敛至同一 Tab (BUG-A03 根治验证)', () => {
    // 第一次传入绝对路径，带小写 c:
    openFileViewerInSession('c:/Software/conex/src/main.ts', 'plain');

    // 第二次传入相对路径，解析出大写 C:
    openFileViewerInSession('src/main.ts', 'diff');

    const state = useLayoutTreeStore.getState();
    const leaf = state.tree.root as any;
    const dock = readLeafDock(leaf);

    const leaves = collectSpatialLeaves(dock.tree.root);
    const tabs = leaves.flatMap((l) => l.tabs);

    const mainTabs = tabs.filter((t) =>
      (t.params?.filePath as string)?.includes('main.ts')
    );

    expect(mainTabs.length).toBe(1);
    expect(mainTabs[0].params?.filePath).toBe('C:/Software/conex/src/main.ts');
    expect(mainTabs[0].params?.initialMode).toBe('diff');
  });

  it('4. 同名 Tab 热激活时直接通过不可变 params 变迁完成，杜绝全局事件注入', () => {
    // 初次打开 plain
    openFileViewerInSession('src/main.ts', 'plain');
    let state = useLayoutTreeStore.getState();
    let leaf = state.tree.root as any;
    let tabs = collectSpatialLeaves(readLeafDock(leaf).tree.root).flatMap(
      (l) => l.tabs
    );
    const initialTabId = tabs[0].tabId;
    expect(tabs[0].params?.initialMode).toBe('plain');

    // 热激活切为 diff
    openFileViewerInSession('src/main.ts', 'diff');
    state = useLayoutTreeStore.getState();
    leaf = state.tree.root as any;
    tabs = collectSpatialLeaves(readLeafDock(leaf).tree.root).flatMap(
      (l) => l.tabs
    );

    expect(tabs.length).toBe(1);
    expect(tabs[0].tabId).toBe(initialTabId); // tabId 保持恒定
    expect(tabs[0].params?.initialMode).toBe('diff'); // 纯参数流直通热更新
  });
});
