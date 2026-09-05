import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  openFileViewerInSession,
  consumeFileViewerModeOverride,
  readLeafDock,
} from './openTool';
import { useLayoutTreeStore } from '../layout-tree/layoutTreeStore';
import * as workspaceFsApi from '../../api/workspaceFsApi';

describe('openFileViewerInSession (DETAIL-PLAN-03 Canonical Tab ID 幂等与去重测试)', () => {
  const mockLeafId = 'leaf-test-canonical';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(workspaceFsApi, 'getWorkspacePath').mockReturnValue('C:/Software/conex');

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
                openPanelIds: ['chat'],
                activePanelId: 'chat',
                collapsed: false,
              },
            },
          ],
          activeTabId: 'tab-1',
          dock: {
            openPanelIds: ['chat'],
            activePanelId: 'chat',
            collapsed: false,
          },
        },
      },
    });
  });

  it('1. Canonical Tab ID 严禁拼接 ?mode=diff，保持纯净路径标识', () => {
    openFileViewerInSession('src/App.tsx', 'diff');

    const state = useLayoutTreeStore.getState();
    const leaf = state.tree.root as any;
    const dock = readLeafDock(leaf);

    const expectedCanonical = 'file-viewer:C:/Software/conex/src/App.tsx';

    // 断言 Tab ID 绝无 ?mode=diff
    expect(dock.activePanelId).toBe(expectedCanonical);
    expect(dock.openPanelIds).toContain(expectedCanonical);
    expect(dock.activePanelId).not.toContain('?mode=');
    expect(dock.collapsed).toBe(false);

    // 断言模式意图被独立登记到通道中
    const override = consumeFileViewerModeOverride(expectedCanonical);
    expect(override).toBe('diff');
  });

  it('2. 异构模式调用相同物理文件时，绝对不产生重复同名 Tab (BUG-A02 根治验证)', () => {
    // 第一次调用：由 Diff 超链接唤起，传入 'diff'
    openFileViewerInSession('src/components/Button.tsx', 'diff');

    // 第二次调用：由文件树或快捷键唤起，传入默认 'plain'
    openFileViewerInSession('src/components/Button.tsx', 'plain');

    const state = useLayoutTreeStore.getState();
    const leaf = state.tree.root as any;
    const dock = readLeafDock(leaf);

    // 统计包含 Button.tsx 的 Tab 数量
    const buttonTabs = dock.openPanelIds.filter((id: string) =>
      id.includes('Button.tsx')
    );

    expect(buttonTabs.length).toBe(1);
    expect(buttonTabs[0]).toBe('file-viewer:C:/Software/conex/src/components/Button.tsx');
  });

  it('3. Windows 小写盘符与大写盘符输入，自动收敛至同一 Tab (BUG-A03 根治验证)', () => {
    // 第一次传入绝对路径，带小写 c:
    openFileViewerInSession('c:/Software/conex/src/main.ts', 'plain');

    // 第二次传入相对路径，解析出大写 C:
    openFileViewerInSession('src/main.ts', 'diff');

    const state = useLayoutTreeStore.getState();
    const leaf = state.tree.root as any;
    const dock = readLeafDock(leaf);

    const mainTabs = dock.openPanelIds.filter((id: string) =>
      id.includes('main.ts')
    );

    expect(mainTabs.length).toBe(1);
    expect(mainTabs[0]).toBe('file-viewer:C:/Software/conex/src/main.ts');
  });

  it('4. 同名 Tab 热激活时触发微任务模式覆盖事件 (HAL-06 根治验证)', async () => {
    let receivedDetail: any = null;
    const listener = (e: Event) => {
      receivedDetail = (e as CustomEvent).detail;
    };
    window.addEventListener('conex:file-viewer-mode', listener);

    try {
      openFileViewerInSession('src/main.ts', 'diff');

      // 调度微任务排队执行
      await Promise.resolve();

      expect(receivedDetail).not.toBeNull();
      expect(receivedDetail.canonicalTabId).toBe(
        'file-viewer:C:/Software/conex/src/main.ts'
      );
      expect(receivedDetail.mode).toBe('diff');
    } finally {
      window.removeEventListener('conex:file-viewer-mode', listener);
    }
  });
});
