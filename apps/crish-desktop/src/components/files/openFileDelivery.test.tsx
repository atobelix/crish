// @vitest-environment jsdom
/**
 * openFileDelivery.test.tsx — S1a 链接定位修复的真实拓扑回归
 *
 * 拓扑（与线上一致）：对话在会话叶（leaf-conv-*），文件面板活在该会话
 * 工具坞叶（dleaf-*）——两者 leafId 永不相等。旧实现把发送方会话叶的
 * leafId 盖进 crish-open-file 事件，FilesCard 守卫按 leafId 短路丢弃，
 * 点击只剩「面板打开在根目录」。本套件钉死新契约：
 * - 投递经 dispatchOpenFileRequest 定址目标会话（sessionId），坞叶
 *   FilesCard 消费、同拓扑另一会话的 FilesCard 不消费；
 * - 面板未挂载时 pending 暂存兜底，且定址暂存只被目标会话面板消费；
 * - 目录目标只展开父链 + 选中目录行，绝不按文件读内容；
 * - FileViewerCard「在应用文件树中定位」跨叶（查看器叶 ≠ 文件坞叶）
 *   真实送达，且不再弹无条件「已定位」假成功提示。
 */
import React from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { LeafScopeProvider } from '../../contexts/LeafScopeContext';
import { ToastProvider } from '../../services/toast/ToastContext';
import { useSessionStore } from '../../store/sessionStore';
import * as workspaceFsApi from '../../api/workspaceFsApi';
import * as projectStore from '../../api/projectStore';
import * as hostOpenersApi from '../../api/hostOpenersApi';
import * as gitApi from '../../api/gitApi';
import {
  dispatchOpenFileRequest,
  peekPendingOpenFileRequest,
  takePendingOpenFileRequest,
} from '../../api/filePanelOpener';
import { FilesCard } from './FilesCard';
import { FileViewerCard } from './FileViewerCard';

vi.mock('./FileAnnotationPopover', () => ({
  FileAnnotationPopover: () => null,
}));
vi.mock('../diff/VirtualPlainCodeViewer', () => ({
  VirtualPlainCodeViewer: ({
    content,
    filePath,
  }: {
    content: string;
    filePath: string;
  }) => (
    <div data-testid="code-viewer">
      {filePath}: {content}
    </div>
  ),
}));

const LISTINGS: Record<string, workspaceFsApi.FsDirEntry[]> = {
  'c:/ws': [
    { name: 'src', path: 'C:/ws/src', isDir: true },
    { name: 'root.txt', path: 'C:/ws/root.txt', isDir: false },
  ],
  'c:/ws/src': [
    { name: 'app.ts', path: 'C:/ws/src/app.ts', isDir: false },
    { name: 'sub', path: 'C:/ws/src/sub', isDir: true },
  ],
  'c:/ws/src/sub': [
    { name: 'deep.ts', path: 'C:/ws/src/sub/deep.ts', isDir: false },
  ],
};

let readTextFileSpy: ReturnType<typeof vi.spyOn>;

/** 假 FS 键归一：规范化路径会把盘符小写（toCanonicalFsPath），故全小写比对 */
function normKey(dir?: string): string {
  return (dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function renderFilesCard(
  sessionId: string,
  leafId: string,
  isActive: boolean,
  testId: string
) {
  const rootRef = { current: document.createElement('div') };
  return render(
    <ToastProvider>
      <div data-testid={testId}>
        <LeafScopeProvider
          leafId={leafId}
          sessionId={sessionId}
          isActive={isActive}
          leafRootRef={rootRef}
        >
          <FilesCard sessionId={sessionId} leafId={leafId} />
        </LeafScopeProvider>
      </div>
    </ToastProvider>
  );
}

describe('S1a 文件打开投递（真实叶拓扑）', () => {
  beforeEach(() => {
    localStorage.clear();
    takePendingOpenFileRequest();
    useSessionStore.setState({ activeSessionId: 'sess-a' });
    window.matchMedia = function (query: string) {
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    };
    vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('C:/ws');
    vi.spyOn(workspaceFsApi, 'listDirectory').mockImplementation(
      async (dir?: string) => LISTINGS[normKey(dir)] ?? []
    );
    readTextFileSpy = vi
      .spyOn(workspaceFsApi, 'readTextFile')
      .mockImplementation(async (filePath: string) => ({
        content: 'file-body',
        lineCount: 1,
        truncated: false,
        path: filePath,
      }));
    vi.spyOn(hostOpenersApi, 'listOpenOptionsForFile').mockResolvedValue({
      openers: [],
      defaultLabel: '打开',
    });
    vi.spyOn(gitApi, 'fetchGitStatus').mockResolvedValue({
      found: false,
      files: [],
    } as unknown as Awaited<ReturnType<typeof gitApi.fetchGitStatus>>);
  });

  afterEach(() => {
    cleanup();
    takePendingOpenFileRequest();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('面板已挂载：会话定址投递被目标会话坞叶 FilesCard 消费，另一会话不消费', async () => {
    const a = renderFilesCard('sess-a', 'dleaf-a', true, 'files-a');
    const b = renderFilesCard('sess-b', 'dleaf-b', false, 'files-b');
    const paneA = a.getByTestId('files-a');
    const paneB = b.getByTestId('files-b');

    // 模拟对话叶点击路径链接后的投递（定址 sess-a，无发送叶 leafId）
    act(() => {
      dispatchOpenFileRequest({
        path: 'C:/ws/src/app.ts',
        line: 2,
        sessionId: 'sess-a',
      });
    });

    await waitFor(
      () => {
        expect(paneA.querySelector('[data-testid="code-viewer"]')).toBeTruthy();
        expect(
          paneA.querySelector('[data-testid="code-viewer"]')?.textContent
        ).toContain('C:/ws/src/app.ts');
      },
      { timeout: 3000 }
    );
    // 树定位：祖先链展开后 app.ts 行被选中
    await waitFor(
      () => {
        const row = Array.from(
          paneA.querySelectorAll('[role="treeitem"]')
        ).find((el) => el.textContent?.includes('app.ts'));
        expect(row?.getAttribute('aria-selected')).toBe('true');
      },
      { timeout: 3000 }
    );
    expect(paneA.querySelector('[data-mode="detail"]')).toBeTruthy();

    // 另一会话的 FilesCard 零消费
    expect(paneB.querySelector('[data-testid="code-viewer"]')).toBeNull();
    expect(paneB.querySelector('[data-mode="detail"]')).toBeNull();
  });

  it('面板未挂载：pending 暂存兜底，且只被目标会话面板消费', async () => {
    // 面板还不存在时先投递（事件无人消费，只能靠暂存）
    act(() => {
      dispatchOpenFileRequest({
        path: 'C:/ws/root.txt',
        sessionId: 'sess-a',
      });
    });
    expect(peekPendingOpenFileRequest()?.sessionId).toBe('sess-a');

    // 先挂载另一会话的面板：不得误消费 sess-a 的定址暂存
    const b = renderFilesCard('sess-b', 'dleaf-b', false, 'files-b');
    await waitFor(
      () => {
        expect(
          b.getByTestId('files-b').querySelector('[role="tree"]')
        ).toBeTruthy();
      },
      { timeout: 3000 }
    );
    expect(peekPendingOpenFileRequest()?.path).toBe('C:/ws/root.txt');
    expect(
      b.getByTestId('files-b').querySelector('[data-testid="code-viewer"]')
    ).toBeNull();

    // 目标会话面板挂载后消费暂存并打开文件
    const a = renderFilesCard('sess-a', 'dleaf-a', true, 'files-a');
    await waitFor(
      () => {
        expect(
          a
            .getByTestId('files-a')
            .querySelector('[data-testid="code-viewer"]')?.textContent
        ).toContain('C:/ws/root.txt');
      },
      { timeout: 3000 }
    );
    expect(peekPendingOpenFileRequest()).toBeNull();
  });

  it('目录目标：展开父链 + 选中目录行，不读文件内容、不进详情态', async () => {
    const a = renderFilesCard('sess-a', 'dleaf-a', true, 'files-a');
    const paneA = a.getByTestId('files-a');

    act(() => {
      dispatchOpenFileRequest({
        path: 'C:/ws/src/sub',
        sessionId: 'sess-a',
      });
    });

    await waitFor(
      () => {
        const row = Array.from(
          paneA.querySelectorAll('[role="treeitem"]')
        ).find((el) => el.textContent?.includes('sub'));
        expect(row?.getAttribute('aria-selected')).toBe('true');
      },
      { timeout: 3000 }
    );
    expect(paneA.querySelector('[data-mode="detail"]')).toBeNull();
    expect(paneA.querySelector('[data-testid="code-viewer"]')).toBeNull();
    // 目录绝不按文件读内容
    expect(readTextFileSpy).not.toHaveBeenCalled();
  });

  it('FileViewerCard 定位：跨叶真实送达文件面板，且无假成功提示', async () => {
    const openTool = vi.fn();
    const viewerRootRef = { current: document.createElement('div') };
    const viewer = render(
      <ToastProvider>
        <div data-testid="viewer-a">
          <LeafScopeProvider
            leafId="dleaf-viewer"
            sessionId="sess-a"
            isActive={true}
            leafRootRef={viewerRootRef}
            openTool={openTool}
          >
            <FileViewerCard
              filePath="C:/ws/src/app.ts"
              sessionId="sess-a"
              leafId="dleaf-viewer"
            />
          </LeafScopeProvider>
        </div>
      </ToastProvider>
    );
    const a = renderFilesCard('sess-a', 'dleaf-a', true, 'files-a');
    const paneA = a.getByTestId('files-a');

    const moreBtn = viewer
      .getByTestId('viewer-a')
      .querySelector<HTMLButtonElement>('button[aria-label="更多操作"]');
    expect(moreBtn).toBeTruthy();
    fireEvent.click(moreBtn!);
    const locateItem = await screen.findByText('在应用文件树中定位', undefined, {
      timeout: 3000,
    });
    fireEvent.click(locateItem);

    // 查看器叶（dleaf-viewer）≠ 文件坞叶（dleaf-a）：旧实现带查看器叶
    // leafId 必被丢弃；新实现按会话定址，文件面板真实打开并定位
    await waitFor(
      () => {
        expect(
          paneA.querySelector('[data-testid="code-viewer"]')?.textContent
        ).toContain('C:/ws/src/app.ts');
      },
      { timeout: 3000 }
    );
    expect(openTool).toHaveBeenCalledWith('files');
    // 不再弹无条件「已定位」假成功提示
    expect(screen.queryByText('已在本地文件树中定位该文件')).toBeNull();
  });
});
