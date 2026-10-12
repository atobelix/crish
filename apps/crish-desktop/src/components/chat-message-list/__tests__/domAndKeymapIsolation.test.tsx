// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act, fireEvent } from '@testing-library/react';

// Mock Toast
vi.mock('../../../services/toast/ToastContext', () => ({
  toast: { show: vi.fn() },
  useToast: () => ({ showToast: vi.fn() }),
}));

// Mock layoutStore / workspaceStore to avoid circular dependency in unit tests
vi.mock('../../../store/layoutStore', () => ({
  useLayoutStore: {
    getState: () => ({
      setAppSettings: vi.fn(),
    }),
  },
  DEFAULT_WORKSPACE_ID: 'default',
  seedInitialWorkspaces: vi.fn(() => ({})),
  clampActiveWorkspaceIndex: vi.fn(() => 0),
}));

vi.mock('../../../store/storeAccess', () => ({
  useSessionStore: vi.fn((selector) => {
    const state = {
      sessions: [],
      activeSessionId: 'sess-1',
    };
    return selector ? selector(state) : state;
  }),
  useSessionField: vi.fn((selector) => {
    const state = {
      activeSessionId: 'sess-1',
      sessionsById: {
        'sess-1': { id: 'sess-1', agents: [] },
      },
    };
    return selector ? selector(state) : state;
  }),
  selectActiveSessionId: (s: any) => s.activeSessionId,
  selectSessionsById: (s: any) => s.sessionsById,
  getSessionById: vi.fn(() => undefined),
}));

import { useScrollAnchor } from '../useScrollAnchor';
import { ApprovalDock } from '../../chat-card/ApprovalDock';
import { focusChatComposer } from '../../chat-message-row/chatMessageRowUtils';
import { useApprovalKeyboard } from '../../agent-card/useApprovalKeyboard';
import { usePlanDrawerState } from '../../chat-card/DynamicChipBar';
import { DiffCardGitActions } from '../../diff/DiffCardGitActions';
import { useSlashMenuKeymap } from '../../note-paper/useSlashMenuKeymap';
import { useSettingsNav } from '../../useSettingsNav';
import { LiveTasksSection } from '../../workspace/LiveTasksSection';
import { BgTasksSection } from '../../workspace/BgTasksSection';
import { ApprovalSection } from '../../workspace/ApprovalSection';
import { PlansSection } from '../../workspace/PlansSection';
import { PreviewToolbar } from '../../workspace/PreviewToolbar';
import { PreviewHistoryPanel } from '../../workspace/PreviewHistoryPanel';
import { AgentBrowsePad } from '../../agent-card/AgentBrowsePad';
import { LeafScopeProvider } from '../../../contexts/LeafScopeContext';

describe('维度 05：容器级 DOM 查询、拖拽边界、按键捕获与 ARIA ID 隔离测试', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('1. useScrollAnchor 容器级 DOM 查询与隔离 (D-02)', () => {
    it('jumpToPinned 传入 scrollContainerRef 时仅滚动本分屏容器，不跨窗污染其他分屏', () => {
      // 模拟左分屏
      const leftContainer = document.createElement('div');
      leftContainer.setAttribute('data-chat-scroll-container', 'true');
      leftContainer.scrollTop = 0;
      const leftMsg = document.createElement('div');
      leftMsg.setAttribute('data-msg-id', 'msg-left-1');
      leftContainer.appendChild(leftMsg);

      // 模拟右分屏
      const rightContainer = document.createElement('div');
      rightContainer.setAttribute('data-chat-scroll-container', 'true');
      rightContainer.scrollTop = 0;
      const rightMsg = document.createElement('div');
      rightMsg.setAttribute('data-msg-id', 'msg-right-1');
      rightContainer.appendChild(rightMsg);

      document.body.appendChild(leftContainer);
      document.body.appendChild(rightContainer);

      const leftRef = { current: leftContainer };
      const rightRef = { current: rightContainer };

      const { result: leftAnchor } = renderHook(() =>
        useScrollAnchor({
          messages: [{ id: 'msg-left-1' } as any],
          sessionAllMessages: [{ id: 'msg-left-1' } as any],
          showAllMessages: true,
          scrollContainerRef: leftRef,
        })
      );

      const { result: rightAnchor } = renderHook(() =>
        useScrollAnchor({
          messages: [{ id: 'msg-right-1' } as any],
          sessionAllMessages: [{ id: 'msg-right-1' } as any],
          showAllMessages: true,
          scrollContainerRef: rightRef,
        })
      );

      // 右分屏查找右分屏的消息
      act(() => {
        rightAnchor.current.jumpToPinned('msg-right-1');
      });
      // 左分屏容器未被触碰
      expect(leftContainer.scrollTop).toBe(0);

      // 左分屏尝试查找只存在于右分屏的消息 -> 严格未找到，不跨窗污染
      const res = leftAnchor.current.scrollToMessage(
        'msg-right-1',
        leftContainer
      );
      expect(res).toBe(false);
      expect(leftContainer.scrollTop).toBe(0);
      expect(rightContainer.scrollTop).toBe(0);
    });
  });

  describe('2. ApprovalDock 局部寻址与滚动 (D-02)', () => {
    it('点击 ApprovalDock 时仅在其所属 leaf/container 内部寻找审批卡，不跨分屏跳转', () => {
      // 分屏 A
      const leafA = document.createElement('div');
      leafA.setAttribute('data-leaf-id', 'leaf-a');
      const cardA = document.createElement('div');
      cardA.className = 'approval-card';
      cardA.setAttribute('data-tool-id', 'tool-1');
      cardA.scrollIntoView = vi.fn();
      leafA.appendChild(cardA);

      // 分屏 B
      const leafB = document.createElement('div');
      leafB.setAttribute('data-leaf-id', 'leaf-b');
      const cardB = document.createElement('div');
      cardB.className = 'approval-card';
      cardB.setAttribute('data-tool-id', 'tool-1'); // 同名 toolId
      cardB.scrollIntoView = vi.fn();

      document.body.appendChild(leafA);
      document.body.appendChild(leafB);

      // 在分屏 B 内渲染 ApprovalDock
      const { getByRole } = render(
        <ApprovalDock
          show={true}
          pendingCount={1}
          summary="1 项待审批"
          toolId="tool-1"
          msgId="msg-1"
          activeSessionId="sess-b"
        />,
        { container: leafB }
      );

      // React 18 createRoot 会清空挂载容器初始子节点，渲染后将分屏 B 审批卡加入该分屏
      leafB.appendChild(cardB);

      const btn = getByRole('button');
      fireEvent.click(btn);

      // 断言：仅分屏 B 的卡片被调用 scrollIntoView，分屏 A 纹丝不动！
      expect(cardB.scrollIntoView).toHaveBeenCalled();
      expect(cardA.scrollIntoView).not.toHaveBeenCalled();
    });
  });

  describe('3. focusChatComposer 容器限定与 Tiptap 富文本支持 (D-02)', () => {
    it('传入 rootElement 时仅聚焦该容器内的编辑器，优先支持 Tiptap contenteditable', () => {
      const paneA = document.createElement('div');
      paneA.className = 'chat-body';
      const taA = document.createElement('textarea');
      taA.className = 'chat-input';
      paneA.appendChild(taA);

      const paneB = document.createElement('div');
      paneB.className = 'chat-body';
      const tiptapB = document.createElement('div');
      tiptapB.className = 'tiptap';
      tiptapB.setAttribute('contenteditable', 'true');
      paneB.appendChild(tiptapB);

      document.body.appendChild(paneA);
      document.body.appendChild(paneB);

      const focusSpyB = vi.spyOn(tiptapB, 'focus');
      const focusSpyA = vi.spyOn(taA, 'focus');

      // 聚焦 paneB
      focusChatComposer(paneB);
      expect(focusSpyB).toHaveBeenCalled();
      expect(focusSpyA).not.toHaveBeenCalled();
    });
  });

  describe('4. useApprovalKeyboard 焦点防抢与按键守卫 (D-03)', () => {
    it('后台非激活分屏挂载审批卡时，严禁抢夺前台打字用户的焦点', () => {
      vi.useFakeTimers();

      const foregroundInput = document.createElement('textarea');
      document.body.appendChild(foregroundInput);
      foregroundInput.focus();
      expect(document.activeElement).toBe(foregroundInput);

      const cardRef = { current: document.createElement('div') };
      const allowBtnRef = { current: document.createElement('button') };

      // 在非激活状态下渲染 useApprovalKeyboard (isActive = false)
      renderHook(
        () =>
          useApprovalKeyboard({
            rootRef: cardRef,
            allowBtnRef,
            confirmArmed: false,
            busy: false,
            msgId: 'msg-bg',
            onDisarm: vi.fn(),
            onEnterAllow: vi.fn(),
          }),
        {
          wrapper: ({ children }) => (
            <LeafScopeProvider
              leafId="leaf-bg"
              sessionId="sess-bg"
              isActive={false} // 后台非激活
              leafRootRef={{ current: null }}
            >
              {children}
            </LeafScopeProvider>
          ),
        }
      );

      // 快进异步宏任务
      act(() => {
        vi.runAllTimers();
      });

      // 断言：打字焦点仍在 foregroundInput，绝未被后台卡片抢走！
      expect(document.activeElement).toBe(foregroundInput);

      vi.useRealTimers();
    });

    it('Esc 按键守卫：用户在外部输入框打字时，绝不拦截 Esc 解除审批卡', () => {
      const onDisarm = vi.fn();
      const cardEl = document.createElement('div');
      document.body.appendChild(cardEl);
      const cardRef = { current: cardEl };

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      renderHook(
        () =>
          useApprovalKeyboard({
            rootRef: cardRef,
            allowBtnRef: { current: null },
            confirmArmed: true,
            busy: false,
            msgId: 'msg-1',
            onDisarm,
            onEnterAllow: vi.fn(),
          }),
        {
          wrapper: ({ children }) => (
            <LeafScopeProvider
              leafId="leaf-1"
              sessionId="sess-1"
              isActive={true}
              leafRootRef={{ current: null }}
            >
              {children}
            </LeafScopeProvider>
          ),
        }
      );

      // 在外部输入框按 Esc
      const escEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(escEvent);

      // 断言：由于焦点在外部 input，未被误解构 disarm！
      expect(onDisarm).not.toHaveBeenCalled();
    });
  });

  describe('5. 浮层与工具卡按键守卫 (D-04)', () => {
    it('usePlanDrawerState: 用户在外部文本框打字时，不吞咽 Esc 按键', () => {
      const { result } = renderHook(() => usePlanDrawerState());

      act(() => {
        result.current.togglePlanDrawer();
      });
      expect(result.current.showPlanDrawer).toBe(true);

      const activeTextarea = document.createElement('textarea');
      document.body.appendChild(activeTextarea);
      activeTextarea.focus();

      // 在文本框按 Esc
      const escEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(escEvent);

      // 断言：抽屉保持打开，Esc 留给文本框或外部处理
      expect(result.current.showPlanDrawer).toBe(true);
    });

    it('DiffCardGitActions: 焦点在外部输入框时，不拦截 Esc 关闭面板', () => {
      const onToggle = vi.fn();
      render(
        <DiffCardGitActions
          open={true}
          commitMsg=""
          commitLoading={false}
          pushLoading={false}
          stagedCount={0}
          unstagedCount={1}
          onToggle={onToggle}
          onCommitMsgChange={vi.fn()}
          onCommit={vi.fn()}
          onPush={vi.fn()}
        />
      );

      const outsideInput = document.createElement('input');
      document.body.appendChild(outsideInput);
      outsideInput.focus();

      const escEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(escEvent);

      expect(onToggle).not.toHaveBeenCalled();
    });

    it('useSlashMenuKeymap: 所属分屏未激活时，绝不截获 Arrow / Enter / Escape 按键', () => {
      const moveActive = vi.fn();
      const mockMenu: any = {
        moveActive,
        close: vi.fn(),
      };
      const runSelectActive = vi.fn();
      const finishClose = vi.fn();

      renderHook(
        () =>
          useSlashMenuKeymap({
            open: true,
            menu: mockMenu,
            runSelectActive,
            finishClose,
          }),
        {
          wrapper: ({ children }) => (
            <LeafScopeProvider
              leafId="leaf-inactive"
              sessionId="sess-inactive"
              isActive={false} // 后台分屏
              leafRootRef={{ current: null }}
            >
              {children}
            </LeafScopeProvider>
          ),
        }
      );

      const arrowDownEvent = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
      });
      window.dispatchEvent(arrowDownEvent);

      expect(moveActive).not.toHaveBeenCalled();
    });

    it('useSettingsNav: searchInputRef 不可见时不劫持全局热键 / 与 Ctrl+F', () => {
      const input = document.createElement('input');
      // 模拟不可见 (offsetWidth = 0, offsetHeight = 0)
      Object.defineProperty(input, 'offsetWidth', { value: 0 });
      Object.defineProperty(input, 'offsetHeight', { value: 0 });
      const selectSpy = vi.spyOn(input, 'select');

      renderHook(() =>
        useSettingsNav({
          initialTab: 'general' as any,
          rulesModalOpen: false,
          mcpAvailable: true,
        })
      );

      const slashEvent = new KeyboardEvent('keydown', {
        key: '/',
        bubbles: true,
      });
      window.dispatchEvent(slashEvent);

      expect(selectSpy).not.toHaveBeenCalled();
    });
  });

  describe('6. 静态 DOM ID 替换为 useId() 实例级唯一化 (D-05)', () => {
    it('双实例挂载时不产生任何重复 DOM ID 与 ARIA 属性冲突', () => {
      const { container: c1 } = render(
        <div>
          <LiveTasksSection
            liveTasks={[]}
            countLabel={null}
            onFocusSession={vi.fn()}
          />
          <BgTasksSection bgTasks={[]} countLabel={null} />
          <ApprovalSection
            approvals={[]}
            countLabel={null}
            onFocusSession={vi.fn()}
          />
          <PlansSection
            workflows={[]}
            cronJobs={[]}
            planCount={0}
            countLabel={null}
          />
          <PreviewToolbar
            preview={{
              canBack: false,
              canForward: false,
              blank: true,
              frameSrc: null,
              loading: false,
              urlInput: '',
              canBookmark: false,
              bookmarked: false,
              showHist: false,
              canExternal: false,
            }}
            navigation={{
              onBack: vi.fn(),
              onForward: vi.fn(),
              onHome: vi.fn(),
              onReload: vi.fn(),
              onUrlSubmit: vi.fn(),
              onUrlChange: vi.fn(),
            }}
            actions={{
              onBookmark: vi.fn(),
              onToggleHist: vi.fn(),
              onOpenExternal: vi.fn(),
            }}
          />
          <PreviewHistoryPanel
            history={[]}
            bookmarks={[]}
            activeUrl=""
            blank={true}
            histRef={{ current: null }}
            onPickUrl={vi.fn()}
            onRemoveBookmark={vi.fn()}
            onClearHistory={vi.fn()}
            onRemoveHistory={vi.fn()}
          />
          <AgentBrowsePad parentSessionId="sess-1" />
        </div>
      );

      const { container: c2 } = render(
        <div>
          <LiveTasksSection
            liveTasks={[]}
            countLabel={null}
            onFocusSession={vi.fn()}
          />
          <BgTasksSection bgTasks={[]} countLabel={null} />
          <ApprovalSection
            approvals={[]}
            countLabel={null}
            onFocusSession={vi.fn()}
          />
          <PlansSection
            workflows={[]}
            cronJobs={[]}
            planCount={0}
            countLabel={null}
          />
          <PreviewToolbar
            preview={{
              canBack: false,
              canForward: false,
              blank: true,
              frameSrc: null,
              loading: false,
              urlInput: '',
              canBookmark: false,
              bookmarked: false,
              showHist: false,
              canExternal: false,
            }}
            navigation={{
              onBack: vi.fn(),
              onForward: vi.fn(),
              onHome: vi.fn(),
              onReload: vi.fn(),
              onUrlSubmit: vi.fn(),
              onUrlChange: vi.fn(),
            }}
            actions={{
              onBookmark: vi.fn(),
              onToggleHist: vi.fn(),
              onOpenExternal: vi.fn(),
            }}
          />
          <PreviewHistoryPanel
            history={[]}
            bookmarks={[]}
            activeUrl=""
            blank={true}
            histRef={{ current: null }}
            onPickUrl={vi.fn()}
            onRemoveBookmark={vi.fn()}
            onClearHistory={vi.fn()}
            onRemoveHistory={vi.fn()}
          />
          <AgentBrowsePad parentSessionId="sess-2" />
        </div>
      );

      // 提取 c1 和 c2 中所有的 id
      const ids1 = Array.from(c1.querySelectorAll('[id]')).map((el) => el.id);
      const ids2 = Array.from(c2.querySelectorAll('[id]')).map((el) => el.id);

      // 验证没有硬编码旧 ID
      const forbiddenLegacyIds = [
        'rt-sec-live',
        'rt-sec-bg',
        'rt-sec-approve',
        'rt-sec-plan',
        'preview-hist-panel',
        'agent-launch-list-heading',
      ];
      for (const legacyId of forbiddenLegacyIds) {
        expect(ids1).not.toContain(legacyId);
        expect(ids2).not.toContain(legacyId);
      }

      // 验证两套实例之间 100% 互斥（交集为空）
      const intersection = ids1.filter((id) => ids2.includes(id));
      expect(intersection).toEqual([]);
    });
  });
});
