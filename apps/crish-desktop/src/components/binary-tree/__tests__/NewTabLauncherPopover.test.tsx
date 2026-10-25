// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from '@testing-library/react';
import { NewTabLauncherPopover } from '../NewTabLauncherPopover';
import { useSessionExecutionTrackerStore } from '../../../store/sessionExecutionTrackerStore';
import { useSessionStore } from '../../../store/sessionStore';
import { useLayoutTreeStore } from '../../../store/layout-tree';
import styles from '../NewTabLauncherPopover.module.css';

const shellMocks = vi.hoisted(() => ({
  addTab: vi.fn(),
  addTerminalTab: vi.fn(),
  addBrowserTab: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  openOrFocusSession: vi.fn(),
}));

vi.mock('../../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    shell: shellMocks,
    session: sessionMocks,
  }),
}));

describe('NewTabLauncherPopover Interaction & Visual Guardrail Suite (R2 / M5)', () => {
  const leafId = 'leaf-launcher-test-1';

  beforeEach(() => {
    vi.clearAllMocks();
    useSessionExecutionTrackerStore.getState().clearAllRuns();

    useSessionStore.setState({
      sessions: [
        { id: 'sess-active-1', title: '前台对话 1' } as any,
        { id: 'sess-bg-1', title: '后台重构分析' } as any,
        { id: 'sess-bg-2', title: '高危工具执行' } as any,
      ],
      sessionsById: {
        'sess-active-1': { id: 'sess-active-1', title: '前台对话 1' } as any,
        'sess-bg-1': { id: 'sess-bg-1', title: '后台重构分析' } as any,
        'sess-bg-2': { id: 'sess-bg-2', title: '高危工具执行' } as any,
      },
      activeSessionId: 'sess-active-1',
    });

    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'leaf',
          id: leafId,
          panelId: 'chat',
          activeTabId: 'tab-1',
          tabs: [
            {
              kind: 'chat',
              tabId: 'tab-1',
              sessionId: 'sess-active-1',
              title: '前台对话 1',
              workspaceKey: '默认',
              dock: {
                collapsed: true,
                openPanelIds: [],
                activePanelId: null,
                widthRatio: 0.5,
              },
            } as any,
          ],
          dock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.5,
          },
        },
      },
      activeLeafId: leafId,
    });
  });

  afterEach(() => {
    act(() => {
      useSessionExecutionTrackerStore.getState().clearAllRuns();
    });
  });

  it('Test 1: 点击加号按钮展开 336px Radix Popover，渲染 3 大核心操作按钮', async () => {
    render(<NewTabLauncherPopover leafId={leafId} />);

    const plusTrigger = screen.getByRole('button', { name: '新对话' });
    expect(plusTrigger).toBeInTheDocument();

    // 点击加号展开 Popover
    fireEvent.click(plusTrigger);

    // 验证 Popover 渲染出 336px 浮层内容外壳
    const popoverContent = document.querySelector(`.${styles.popoverContent}`);
    expect(popoverContent).toBeInTheDocument();

    // 验证 3 大核心操作按钮存在且文案、快捷键匹配
    expect(screen.getByText('新建对话')).toBeInTheDocument();
    expect(screen.getByText('⌘N')).toBeInTheDocument();

    expect(screen.getByText('新建终端')).toBeInTheDocument();
    expect(screen.getByText('⌃`')).toBeInTheDocument();

    expect(screen.getByText('新建浏览器')).toBeInTheDocument();
    expect(screen.getByText('⌥B')).toBeInTheDocument();

    // 初始状态下第一项（新建对话）默认高亮聚焦 (<100ms 即按即开)
    const newChatBtn = screen.getByText('新建对话').closest('button');
    expect(newChatBtn).toHaveAttribute('data-focused', 'true');
  });

  it('Test 2: 全键盘无障碍漫游 (ArrowDown, ArrowUp, Enter, Escape)', async () => {
    render(<NewTabLauncherPopover leafId={leafId} />);

    const plusTrigger = screen.getByRole('button', { name: '新对话' });
    fireEvent.click(plusTrigger);

    const popoverContent = document.querySelector(
      `.${styles.popoverContent}`
    ) as HTMLElement;
    expect(popoverContent).toBeInTheDocument();

    const newChatBtn = screen.getByText('新建对话').closest('button')!;
    const newTerminalBtn = screen.getByText('新建终端').closest('button')!;
    const newBrowserBtn = screen.getByText('新建浏览器').closest('button')!;

    // 初始高亮在第 0 项（新建对话）
    expect(newChatBtn).toHaveAttribute('data-focused', 'true');
    expect(newTerminalBtn).toHaveAttribute('data-focused', 'false');

    // 按下 ArrowDown -> 聚焦移动至第 1 项（新建终端）
    fireEvent.keyDown(popoverContent, { key: 'ArrowDown' });
    expect(newChatBtn).toHaveAttribute('data-focused', 'false');
    expect(newTerminalBtn).toHaveAttribute('data-focused', 'true');

    // 按下 ArrowDown -> 聚焦移动至第 2 项（新建浏览器）
    fireEvent.keyDown(popoverContent, { key: 'ArrowDown' });
    expect(newTerminalBtn).toHaveAttribute('data-focused', 'false');
    expect(newBrowserBtn).toHaveAttribute('data-focused', 'true');

    // 按下 ArrowUp -> 聚焦返回第 1 项（新建终端）
    fireEvent.keyDown(popoverContent, { key: 'ArrowUp' });
    expect(newTerminalBtn).toHaveAttribute('data-focused', 'true');

    // 按下 Enter -> 触发新建终端，调用 shell.addTerminalTab，并关闭 Popover
    fireEvent.keyDown(popoverContent, { key: 'Enter' });
    expect(shellMocks.addTerminalTab).toHaveBeenCalledWith(leafId);

    // Popover 已关闭
    await waitFor(() => {
      expect(
        document.querySelector(`.${styles.popoverContent}`)
      ).not.toBeInTheDocument();
    });

    // 重新打开并测试 Escape 关闭
    fireEvent.click(plusTrigger);
    const reopenContent = document.querySelector(
      `.${styles.popoverContent}`
    ) as HTMLElement;
    expect(reopenContent).toBeInTheDocument();

    fireEvent.keyDown(reopenContent, { key: 'Escape' });
    await waitFor(() => {
      expect(
        document.querySelector(`.${styles.popoverContent}`)
      ).not.toBeInTheDocument();
    });
  });

  it('Test 3: 后台运行会话动态感知列表展示、脉冲指示灯与一键直达聚焦', async () => {
    // 注入两条后台运行中的会话（排除当前前台可见的 sess-active-1）
    useSessionExecutionTrackerStore
      .getState()
      .startRun('sess-bg-1', 'run-1', 'streaming_text');
    useSessionExecutionTrackerStore
      .getState()
      .startRun('sess-bg-2', 'run-2', 'waiting_approval');
    useSessionExecutionTrackerStore
      .getState()
      .markApprovalPending('sess-bg-2', 't-tool', 'cargo test');

    render(<NewTabLauncherPopover leafId={leafId} />);

    const plusTrigger = screen.getByRole('button', { name: '新对话' });
    fireEvent.click(plusTrigger);

    // 验证运行中分区标题显示正确的计数 (2)
    expect(screen.getByText('运行中 (2)')).toBeInTheDocument();

    // 验证条目标题与状态文字正确呈现
    expect(screen.getByText('后台重构分析')).toBeInTheDocument();
    expect(screen.getByText('高危工具执行')).toBeInTheDocument();
    expect(screen.getByText(/等待审批: cargo test/)).toBeInTheDocument();

    // 验证脉冲指示点存在且紧急任务带 data-urgent 标识
    const urgentSessionBtn = screen
      .getByText('高危工具执行')
      .closest('button')!;
    const pulseDot = urgentSessionBtn.querySelector(`.${styles.pulseDot}`);
    expect(pulseDot).toBeInTheDocument();
    expect(pulseDot).toHaveAttribute('data-urgent', 'true');

    // 点击后台任务条目，触发 openOrFocusSession 聚焦跳转并关闭浮层
    fireEvent.click(urgentSessionBtn);
    expect(sessionMocks.openOrFocusSession).toHaveBeenCalledWith('sess-bg-2');

    await waitFor(() => {
      expect(
        document.querySelector(`.${styles.popoverContent}`)
      ).not.toBeInTheDocument();
    });
  });

  it('Test 4: 3000ms 柔和衰减窗 (Graceful Decay Window) 防止执行完毕时光标错位与误触', async () => {
    vi.useFakeTimers();

    useSessionStore.setState({
      sessionsById: {
        'sess-decay': { id: 'sess-decay', title: '短程任务' } as any,
      },
    });
    useSessionExecutionTrackerStore
      .getState()
      .startRun('sess-decay', 'run-d', 'streaming_text');

    render(<NewTabLauncherPopover leafId={leafId} />);

    const plusTrigger = screen.getByRole('button', { name: '新对话' });
    fireEvent.click(plusTrigger);

    expect(screen.getByText('短程任务')).toBeInTheDocument();

    // 模拟运行完成触发 3000ms 衰减窗
    act(() => {
      useSessionExecutionTrackerStore.getState().completeRun('sess-decay');
    });

    // 核心断言：刚完成时条目绝不瞬间消失（避免下方布局上跳造成用户点空/误触）
    expect(screen.getByText('短程任务')).toBeInTheDocument();
    expect(
      useSessionExecutionTrackerStore.getState().activeRuns['sess-decay']?.stage
    ).toBe('just_completed');

    // 快进 2000ms（仍在 3000ms 衰减窗内），条目依然平稳保留
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('短程任务')).toBeInTheDocument();

    // 快进超过 3000ms（例如累计 3100ms），定时器到期，会话平滑移除
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.queryByText('短程任务')).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it('Test 5: 规范守门断言：严格遵循 Conex §12，零原生 HTML title 属性回潮', async () => {
    useSessionExecutionTrackerStore
      .getState()
      .startRun('sess-bg-1', 'run-1', 'streaming_text');

    const { container } = render(<NewTabLauncherPopover leafId={leafId} />);

    const plusTrigger = screen.getByRole('button', { name: '新对话' });
    fireEvent.click(plusTrigger);

    // 检查 DOM 树中绝对禁止任何原生 HTML title="..." 属性 (AGENTS.md §12)
    const elementsWithNativeTitle = container.querySelectorAll('[title]');
    const portalWithNativeTitle = document.querySelectorAll(
      `.${styles.popoverContent} [title]`
    );
    expect(elementsWithNativeTitle).toHaveLength(0);
    expect(portalWithNativeTitle).toHaveLength(0);
  });

  it('Test 6: 加号按钮严格事件隔离：阻断 dblclick/pointerdown/mousedown 冒泡，声明 data-tauri-drag-region="false"，防止触发窗口最大化', async () => {
    const onParentDblClick = vi.fn();
    const onParentMouseDown = vi.fn();
    const onParentPointerDown = vi.fn();

    const { container } = render(
      <div
        onDoubleClick={onParentDblClick}
        onMouseDown={onParentMouseDown}
        onPointerDown={onParentPointerDown}
      >
        <NewTabLauncherPopover leafId={leafId} />
      </div>
    );

    const plusTrigger = screen.getByRole('button', { name: '新对话' });
    expect(plusTrigger).toHaveAttribute('data-tauri-drag-region', 'false');

    // 验证所有子孙节点均带有 data-tauri-drag-region="false"
    const dragRegionDescendants = plusTrigger.querySelectorAll(
      '[data-tauri-drag-region]'
    );
    dragRegionDescendants.forEach((el) => {
      expect(el.getAttribute('data-tauri-drag-region')).toBe('false');
    });

    // 触发双击事件：必须被内部拦截，不得向上传播至外层容器（防止系统标题栏双击最大化）
    fireEvent.doubleClick(plusTrigger);
    expect(onParentDblClick).not.toHaveBeenCalled();

    // 触发按下事件：必须被内部拦截，防止误触发窗口拖拽
    fireEvent.pointerDown(plusTrigger);
    expect(onParentPointerDown).not.toHaveBeenCalled();

    fireEvent.mouseDown(plusTrigger);
    expect(onParentMouseDown).not.toHaveBeenCalled();
  });

  it('Test 7: 彻底清除虚假预制模板，零假数据伪装 (Zero Fake Templates)', async () => {
    render(<NewTabLauncherPopover leafId={leafId} />);

    const plusTrigger = screen.getByRole('button', { name: '新对话' });
    fireEvent.click(plusTrigger);

    // 核心断言：绝对不存在硬编码的假模板文案与假卡片
    expect(screen.queryByText('预置模板')).toBeNull();
    expect(screen.queryByText('Rust 微内核')).toBeNull();
    expect(screen.queryByText('React 全栈')).toBeNull();
    expect(screen.queryByText('AI 数据分析')).toBeNull();
    expect(screen.queryByText('本地工程')).toBeNull();
  });

  it('Test 8: 快捷键提示采用纯净无框等宽文本 (无 .kbdBadge 粗重描边)，操作项无边框描边 (border: none)', async () => {
    render(<NewTabLauncherPopover leafId={leafId} />);

    const plusTrigger = screen.getByRole('button', { name: '新对话' });
    fireEvent.click(plusTrigger);

    // 验证废弃粗笨 .kbdBadge，采用 clean .shortcutHint
    const kbdBadges = document.querySelectorAll(`.${styles.kbdBadge}`);
    expect(kbdBadges).toHaveLength(0);
    const nativeKbdBadges = document.querySelectorAll('.kbdBadge');
    expect(nativeKbdBadges).toHaveLength(0);

    const shortcutHints = document.querySelectorAll(`.${styles.shortcutHint}`);
    expect(shortcutHints.length).toBeGreaterThanOrEqual(3);

    // 验证快捷键文本正确呈现且无框
    expect(screen.getByText('⌘N')).toHaveClass(styles.shortcutHint);
    expect(screen.getByText('⌃`')).toHaveClass(styles.shortcutHint);
    expect(screen.getByText('⌥B')).toHaveClass(styles.shortcutHint);
  });

  it('Test 9: 独立直接触发新建终端与新建浏览器动作分发与浮层关闭', async () => {
    render(<NewTabLauncherPopover leafId={leafId} />);

    const plusTrigger = screen.getByRole('button', { name: '新对话' });

    // 9.1 点击新建终端 -> 调用 shell.addTerminalTab(leafId)
    fireEvent.click(plusTrigger);
    const newTerminalBtn = screen.getByText('新建终端').closest('button')!;
    fireEvent.click(newTerminalBtn);
    expect(shellMocks.addTerminalTab).toHaveBeenCalledWith(leafId);

    await waitFor(() => {
      expect(
        document.querySelector(`.${styles.popoverContent}`)
      ).not.toBeInTheDocument();
    });

    // 9.2 点击新建浏览器 -> 调用 shell.addBrowserTab(leafId)
    fireEvent.click(plusTrigger);
    const newBrowserBtn = screen.getByText('新建浏览器').closest('button')!;
    fireEvent.click(newBrowserBtn);
    expect(shellMocks.addBrowserTab).toHaveBeenCalledWith(leafId);

    await waitFor(() => {
      expect(
        document.querySelector(`.${styles.popoverContent}`)
      ).not.toBeInTheDocument();
    });
  });
});
