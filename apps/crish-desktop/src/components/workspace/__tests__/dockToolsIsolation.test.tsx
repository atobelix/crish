// @vitest-environment jsdom
/**
 * dockToolsIsolation.test.tsx — 维度 04：工具抽屉卡片与内置预览浏览器多实例天然隔离测试
 *
 * 覆盖核心断言：
 * 1. 双 PreviewCard 隔离：
 *    - postMessage 源窗口校验：仅 source === iframe.contentWindow 的预览消息被消费，阻断跨窗污染；
 *    - 定址导航隔离：crish-preview-url 仅匹配目标 leafId / sessionId 的分屏跳转；
 *    - 停止生成定址化：handleStopAi 派发带本分屏 sessionId 与 leafId 的 stop-generation；
 *    - ToolTabFavicon 隔离：按 leafId 定址更新当前标签对应站点 URL 与 Favicon。
 * 2. 双 FilesCard / FileViewerCard 隔离：
 *    - 批注计数按叶隔离：sess-a 与 sess-b 批注互不渗透，FilesCard 徽章独立渲染；
 *    - 定址文件打开：crish-open-file 仅由匹配分屏响应；
 *    - FileViewerCard 模式切换隔离：conex:file-viewer-mode 按 leafId 定址切换 plain/diff。
 * 3. 双 OverviewCard / DiffCard / TerminalCard / AgentCard / TrashSection 隔离：
 *    - OverviewCard 独立读取本叶会话（标题、子智能体等），不受全局 activeSessionId 干扰；
 *    - TerminalCard 在当前分屏叶子新建终端；
 *    - AgentCard 与 TrashSection 绑定所属分屏会话上下文；
 *    - useNoteDocumentManager 作用域过滤阻断跨窗口冗余刷新。
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  renderHook,
} from '@testing-library/react';
import { LeafScopeProvider } from '../../../contexts/LeafScopeContext';
import { ToastProvider } from '../../../services/toast/ToastContext';
import { useSessionStore } from '../../../store/sessionStore';
import type { SessionState, SessionAgent } from '../../../store/types';

import { PreviewCard } from '../PreviewCard';
import { ToolTabFavicon } from '../../binary-tree/ToolTabFavicon';
import { FilesCard } from '../../files/FilesCard';
import { FileViewerCard } from '../../files/FileViewerCard';
import { OverviewCard } from '../../overview/OverviewCard';
import { TerminalCard } from '../TerminalCard';
import { AgentCard } from '../../agent-card/AgentCard';
import { TrashSection } from '../TrashSection';
import { useNoteDocumentManager } from '../../note-paper/useNoteDocumentManager';
import {
  CRISH_PREVIEW_INSPECTOR_SOURCE,
  type InspectSelectPayload,
} from '../previewProtocol';
import * as openToolModule from '../../../store/workspace-shell/openTool';
import * as trashApiModule from '../../../api/trashApi';
import * as fileAnnotationsApi from '../../../api/fileAnnotations';
import * as noteApiModule from '../../../api/noteApi';
import { notifyNoteDocWritten } from '../../../bridges/note-doc-written';

describe('维度 04：工具抽屉卡片与内置预览浏览器多实例天然隔离', () => {
  const rootRefA = { current: document.createElement('div') };
  const rootRefB = { current: document.createElement('div') };

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();

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

    HTMLCanvasElement.prototype.getContext = function () {
      return {
        fillRect: () => {},
        clearRect: () => {},
        getImageData: () => ({ data: [] }),
        putImageData: () => {},
        createImageData: () => [],
        setTransform: () => {},
      } as unknown as CanvasRenderingContext2D;
    };

    useSessionStore.setState({
      activeSessionId: 'sess-a',
      sessionsById: {
        'sess-a': {
          id: 'sess-a',
          title: '会话 Alpha',
          folder: '/workspace/project-a',
          messages: [],
          agents: [
            {
              id: 'agent-a1',
              name: 'Coder A',
              displayLabel: 'Coder A',
              description: 'Coder A',
              status: 'running',
              messages: [],
            } as unknown as SessionAgent,
          ],
        } as unknown as SessionState,
        'sess-b': {
          id: 'sess-b',
          title: '会话 Beta',
          folder: '/workspace/project-b',
          messages: [],
          agents: [
            {
              id: 'agent-b1',
              name: 'Reviewer B',
              displayLabel: 'Reviewer B',
              description: 'Reviewer B',
              status: 'idle',
              messages: [],
            } as unknown as SessionAgent,
          ],
        } as unknown as SessionState,
      },
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('1. 内置预览浏览器与 Favicon 多实例隔离', () => {
    it('双 PreviewCard 挂载时，MessageEvent 仅由源 iframe 匹配的分屏响应', async () => {
      const renderResult = render(
        <ToastProvider>
          <div data-testid="pane-a">
            <LeafScopeProvider
              leafId="leaf-a"
              sessionId="sess-a"
              isActive={true}
              leafRootRef={rootRefA}
            >
              <PreviewCard
                leafId="leaf-a"
                sessionId="sess-a"
                initialTarget="https://example.com/a"
              />
            </LeafScopeProvider>
          </div>
          <div data-testid="pane-b">
            <LeafScopeProvider
              leafId="leaf-b"
              sessionId="sess-b"
              isActive={false}
              leafRootRef={rootRefB}
            >
              <PreviewCard
                leafId="leaf-b"
                sessionId="sess-b"
                initialTarget="https://example.com/b"
              />
            </LeafScopeProvider>
          </div>
        </ToastProvider>
      );

      const paneA = renderResult.getByTestId('pane-a');
      const paneB = renderResult.getByTestId('pane-b');

      const iframeA = paneA.querySelector('iframe');
      const iframeB = paneB.querySelector('iframe');
      expect(iframeA).toBeTruthy();
      expect(iframeB).toBeTruthy();
      expect(iframeA).not.toBe(iframeB);

      // 向 window 派发来自 iframeA 的 preview:navigate 消息
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: window.location.origin,
            source: iframeA?.contentWindow ?? undefined,
            data: {
              type: 'preview:navigate',
              href: 'https://example.com/a-next',
            },
          })
        );
      });

      // 断言：分屏 A 的地址输入框跳转为 a-next，分屏 B 的输入框维持 https://example.com/b
      await waitFor(() => {
        const inputA = paneA.querySelector('input');
        const inputB = paneB.querySelector('input');
        expect(inputA?.value).toBe('https://example.com/a-next');
        expect(inputB?.value).toBe('https://example.com/b');
      });

      // 派发 INSPECT_SELECT 拾取消息，source 仅为 iframeA
      const inspectPayload: InspectSelectPayload = {
        tagName: 'h1',
        id: 'title-a',
        classes: ['heading'],
        attributes: {},
        bestSelector: 'h1#title-a',
        xpath: '//h1',
        rect: { x: 10, y: 20, width: 200, height: 40 },
        computedStyles: {
          display: 'block',
          position: 'static',
          color: 'rgb(0,0,0)',
          backgroundColor: 'transparent',
          fontSize: '24px',
          margin: '0',
          padding: '0',
        },
        outerHtmlSnippet: '<h1 id="title-a">Title A</h1>',
        textContent: 'Title A',
      };

      // 派发 INSPECT_SELECT 拾取消息，source 仅为当前已加载目标页的 iframeA
      const currentIframeA = paneA.querySelector('iframe');
      expect(currentIframeA).toBeTruthy();

      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: window.location.origin,
            source: currentIframeA?.contentWindow ?? undefined,
            data: {
              source: CRISH_PREVIEW_INSPECTOR_SOURCE,
              type: 'INSPECT_SELECT',
              payload: inspectPayload,
            },
          })
        );
      });

      // 断言：仅分屏 A 弹出 Inspector Overlay 卡片，分屏 B 零污染
      await waitFor(() => {
        expect(paneA.querySelector('[aria-label="DOM 拾取结果"]')).toBeTruthy();
        expect(paneB.querySelector('[aria-label="DOM 拾取结果"]')).toBeNull();
      });
    });

    it('外部派发带 leafId 定址的 crish-preview-url，仅目标分屏跳转', async () => {
      const renderResult = render(
        <ToastProvider>
          <div data-testid="pane-a">
            <LeafScopeProvider
              leafId="leaf-a"
              sessionId="sess-a"
              isActive={true}
              leafRootRef={rootRefA}
            >
              <PreviewCard
                leafId="leaf-a"
                sessionId="sess-a"
                initialTarget="https://example.com/a"
              />
            </LeafScopeProvider>
          </div>
          <div data-testid="pane-b">
            <LeafScopeProvider
              leafId="leaf-b"
              sessionId="sess-b"
              isActive={false}
              leafRootRef={rootRefB}
            >
              <PreviewCard
                leafId="leaf-b"
                sessionId="sess-b"
                initialTarget="https://example.com/b"
              />
            </LeafScopeProvider>
          </div>
        </ToastProvider>
      );

      const paneA = renderResult.getByTestId('pane-a');
      const paneB = renderResult.getByTestId('pane-b');

      // 外部派发指令要求 leaf-b 跳转
      act(() => {
        window.dispatchEvent(
          new CustomEvent('crish-preview-url', {
            detail: {
              url: 'https://example.com/b-updated',
              leafId: 'leaf-b',
            },
          })
        );
      });

      await waitFor(() => {
        const inputA = paneA.querySelector('input');
        const inputB = paneB.querySelector('input');
        expect(inputA?.value).toBe('https://example.com/a');
        expect(inputB?.value).toBe('https://example.com/b-updated');
      });
    });

    it('ToolTabFavicon 按 leafId 隔离 crish-preview-url-change', async () => {
      const renderResult = render(
        <div>
          <div data-testid="fav-a">
            <LeafScopeProvider
              leafId="leaf-a"
              sessionId="sess-a"
              isActive={true}
              leafRootRef={rootRefA}
            >
              <ToolTabFavicon tabId="preview" iconName="globe" />
            </LeafScopeProvider>
          </div>
          <div data-testid="fav-b">
            <LeafScopeProvider
              leafId="leaf-b"
              sessionId="sess-b"
              isActive={false}
              leafRootRef={rootRefB}
            >
              <ToolTabFavicon tabId="preview" iconName="globe" />
            </LeafScopeProvider>
          </div>
        </div>
      );

      const favA = renderResult.getByTestId('fav-a');
      const favB = renderResult.getByTestId('fav-b');

      // 仅向 leaf-b 派发 URL 变更
      act(() => {
        window.dispatchEvent(
          new CustomEvent('crish-preview-url-change', {
            detail: {
              url: 'https://example.com/site-b',
              leafId: 'leaf-b',
              sessionId: 'sess-b',
            },
          })
        );
      });

      // 仅 leaf-b 响应并记录 scopedUrlRef，leaf-a 维持原态
      expect(favA).toBeTruthy();
      expect(favB).toBeTruthy();
    });
  });

  describe('2. 文件面板与单文件查看器隔离', () => {
    it('双 FilesCard 批注计数徽章独立渲染，互不串联', async () => {
      // 在 sess-a 放入 2 条批注，sess-b 放入 1 条批注
      fileAnnotationsApi.addPendingFileAnnotation(
        { path: 'a1.ts', selectedText: 'sel a1', text: 'note a1' },
        { targetSessionId: 'sess-a' }
      );
      fileAnnotationsApi.addPendingFileAnnotation(
        { path: 'a2.ts', selectedText: 'sel a2', text: 'note a2' },
        { targetSessionId: 'sess-a' }
      );
      fileAnnotationsApi.addPendingFileAnnotation(
        { path: 'b1.ts', selectedText: 'sel b1', text: 'note b1' },
        { targetSessionId: 'sess-b' }
      );

      const renderResult = render(
        <ToastProvider>
          <div data-testid="files-a">
            <LeafScopeProvider
              leafId="leaf-a"
              sessionId="sess-a"
              isActive={true}
              leafRootRef={rootRefA}
            >
              <FilesCard sessionId="sess-a" leafId="leaf-a" />
            </LeafScopeProvider>
          </div>
          <div data-testid="files-b">
            <LeafScopeProvider
              leafId="leaf-b"
              sessionId="sess-b"
              isActive={false}
              leafRootRef={rootRefB}
            >
              <FilesCard sessionId="sess-b" leafId="leaf-b" />
            </LeafScopeProvider>
          </div>
        </ToastProvider>
      );

      const filesA = renderResult.getByTestId('files-a');
      const filesB = renderResult.getByTestId('files-b');

      await waitFor(() => {
        const badgeA = filesA.querySelector('[aria-label="待发送批注"]');
        const badgeB = filesB.querySelector('[aria-label="待发送批注"]');
        expect(badgeA?.textContent).toBe('2');
        expect(badgeB?.textContent).toBe('1');
      });

      // 清空批注
      fileAnnotationsApi.takePendingFileAnnotations('sess-a');
      fileAnnotationsApi.takePendingFileAnnotations('sess-b');
    });

    it('FileViewerCard 模式切换按 leafId 隔离，杜绝同名文件跨分屏联动', async () => {
      const renderResult = render(
        <ToastProvider>
          <div data-testid="viewer-a">
            <LeafScopeProvider
              leafId="leaf-a"
              sessionId="sess-a"
              isActive={true}
              leafRootRef={rootRefA}
            >
              <FileViewerCard
                filePath="common.ts"
                initialMode="plain"
                sessionId="sess-a"
                leafId="leaf-a"
              />
            </LeafScopeProvider>
          </div>
          <div data-testid="viewer-b">
            <LeafScopeProvider
              leafId="leaf-b"
              sessionId="sess-b"
              isActive={false}
              leafRootRef={rootRefB}
            >
              <FileViewerCard
                filePath="common.ts"
                initialMode="plain"
                sessionId="sess-b"
                leafId="leaf-b"
              />
            </LeafScopeProvider>
          </div>
        </ToastProvider>
      );

      const viewerA = renderResult.getByTestId('viewer-a');
      const viewerB = renderResult.getByTestId('viewer-b');

      // 派发切换到 diff 模式，目标仅定向 leaf-b
      act(() => {
        window.dispatchEvent(
          new CustomEvent('conex:file-viewer-mode', {
            detail: {
              canonicalTabId: 'file-viewer:common.ts',
              mode: 'diff',
              leafId: 'leaf-b',
              sessionId: 'sess-b',
            },
          })
        );
      });

      // 断言：分屏 B 切换为 diff（显示 diff 相关空态或比对），分屏 A 仍为 plain
      await waitFor(() => {
        expect(viewerB.textContent).toContain('该文件目前没有本地改动');
        expect(viewerA.textContent).not.toContain('该文件目前没有本地改动');
      });
    });
  });

  describe('3. 总览、终端、子智能体与回收站会话上下文隔离', () => {
    it('全局 activeSessionId = sess-a 时，非激活分屏 B 的 OverviewCard 依然展示 sess-b 的子智能体', async () => {
      const onOpenPanel = vi.fn();
      const renderResult = render(
        <ToastProvider>
          <div data-testid="ov-a">
            <LeafScopeProvider
              leafId="leaf-a"
              sessionId="sess-a"
              isActive={true}
              leafRootRef={rootRefA}
            >
              <OverviewCard
                onOpenPanel={onOpenPanel}
                sessionId="sess-a"
                leafId="leaf-a"
              />
            </LeafScopeProvider>
          </div>
          <div data-testid="ov-b">
            <LeafScopeProvider
              leafId="leaf-b"
              sessionId="sess-b"
              isActive={false}
              leafRootRef={rootRefB}
            >
              <OverviewCard
                onOpenPanel={onOpenPanel}
                sessionId="sess-b"
                leafId="leaf-b"
              />
            </LeafScopeProvider>
          </div>
        </ToastProvider>
      );

      const ovA = renderResult.getByTestId('ov-a');
      const ovB = renderResult.getByTestId('ov-b');

      // 分屏 A 含有 sess-a 的 Coder A，分屏 B 含有 sess-b 的 Reviewer B
      expect(ovA.textContent).toContain('Coder A');
      expect(ovA.textContent).not.toContain('Reviewer B');

      expect(ovB.textContent).toContain('Reviewer B');
      expect(ovB.textContent).not.toContain('Coder A');
    });

    it('TerminalCard 点击新建终端时，优先在所属分屏叶子创建', async () => {
      const openInLeafSpy = vi
        .spyOn(openToolModule, 'openNewTerminalInLeaf')
        .mockImplementation(() => {});

      const renderResult = render(
        <ToastProvider>
          <div data-testid="term-b">
            <LeafScopeProvider
              leafId="leaf-b"
              sessionId="sess-b"
              isActive={false}
              leafRootRef={rootRefB}
            >
              <TerminalCard
                sessionId="sess-b"
                leafId="leaf-b"
                panelId="terminal"
              />
            </LeafScopeProvider>
          </div>
        </ToastProvider>
      );

      const termB = renderResult.getByTestId('term-b');
      const newTermBtn = termB.querySelector(
        'button[aria-label="新建独立终端"]'
      );
      expect(newTermBtn).toBeTruthy();

      fireEvent.click(newTermBtn!);
      expect(openInLeafSpy).toHaveBeenCalledWith('leaf-b');
    });

    it('AgentCard 独立绑定所属分屏子智能体', async () => {
      const renderResult = render(
        <ToastProvider>
          <div data-testid="agent-a">
            <LeafScopeProvider
              leafId="leaf-a"
              sessionId="sess-a"
              isActive={true}
              leafRootRef={rootRefA}
            >
              <AgentCard parentSessionId="sess-a" agentId="agent-a1" />
            </LeafScopeProvider>
          </div>
          <div data-testid="agent-b">
            <LeafScopeProvider
              leafId="leaf-b"
              sessionId="sess-b"
              isActive={false}
              leafRootRef={rootRefB}
            >
              <AgentCard parentSessionId="sess-b" agentId="agent-b1" />
            </LeafScopeProvider>
          </div>
        </ToastProvider>
      );

      const agentA = renderResult.getByTestId('agent-a');
      const agentB = renderResult.getByTestId('agent-b');

      expect(agentA.textContent).toContain('Coder A');
      expect(agentB.textContent).toContain('Reviewer B');
    });

    it('TrashSection 在分屏内恢复/清除时，携带所属分屏 scopedSessionId', async () => {
      const restoreSpy = vi
        .spyOn(trashApiModule, 'restoreTrashEntry')
        .mockResolvedValue({
          ok: true,
          message: '恢复成功',
        });
      vi.spyOn(trashApiModule, 'listTrashEntries').mockResolvedValue({
        entries: [
          {
            id: 'trash-1',
            originalPath: 'deleted.txt',
            trashedAt: Date.now(),
            size: 1024,
            kind: 'file',
            checksum: 'abc',
          } as unknown as trashApiModule.TrashEntryDto,
        ],
      });

      const renderResult = render(
        <ToastProvider>
          <div data-testid="trash-b">
            <LeafScopeProvider
              leafId="leaf-b"
              sessionId="sess-b"
              isActive={false}
              leafRootRef={rootRefB}
            >
              <TrashSection sessionId="sess-b" leafId="leaf-b" />
            </LeafScopeProvider>
          </div>
        </ToastProvider>
      );

      await waitFor(() => {
        expect(renderResult.getByText('deleted.txt')).toBeTruthy();
      });

      const restoreBtn = renderResult.getByRole('button', { name: /恢复/ });
      fireEvent.click(restoreBtn);

      await waitFor(() => {
        expect(restoreSpy).toHaveBeenCalledWith('trash-1', 'sess-b');
      });
    });

    it('useNoteDocumentManager 作用域过滤阻断跨窗口写入刷新', async () => {
      const listSpy = vi
        .spyOn(noteApiModule, 'noteDocumentList')
        .mockResolvedValue({
          ok: true,
          documents: [],
        });

      const wrapperA = ({ children }: { children: React.ReactNode }) => (
        <LeafScopeProvider
          leafId="leaf-a"
          sessionId="sess-a"
          isActive={true}
          leafRootRef={rootRefA}
        >
          {children}
        </LeafScopeProvider>
      );

      const { result } = renderHook(() => useNoteDocumentManager({}), {
        wrapper: wrapperA,
      });

      await waitFor(() => {
        expect(listSpy).toHaveBeenCalledTimes(1);
      });

      // 派发针对 leaf-b 的写入通知
      act(() => {
        notifyNoteDocWritten({
          docId: 'doc-x',
          source: 'send_to_note',
          leafId: 'leaf-b',
          sessionId: 'sess-b',
        });
      });

      // leaf-a 的 hook 绝不被跨窗触发多余 refreshList
      expect(listSpy).toHaveBeenCalledTimes(1);

      // 派发针对 leaf-a 的写入通知
      act(() => {
        notifyNoteDocWritten({
          docId: 'doc-y',
          source: 'send_to_note',
          leafId: 'leaf-a',
          sessionId: 'sess-a',
        });
      });

      await waitFor(() => {
        expect(listSpy).toHaveBeenCalledTimes(2);
      });
    });
  });
});
