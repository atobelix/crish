// @vitest-environment jsdom
import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { ChatUserMessageRow } from '../ChatUserMessageRow';
import type { SessionMessage } from '../../../store/types';
import styles from '../ChatMessageRow.module.css';
import {
  noteBusy,
  resetBusyRetryForTests,
} from '../../../api/sessionStreamManager';
import { DOMAIN_MESSAGES } from '../../../api/userFacingErrors';
import { DEFAULT_DELAY_SHOW_MS } from '../../ui/Tooltip/Tooltip';
import { _resetAnimatedMessageIdsForTesting } from '../useUserBubbleEntrance';

// Mock 全局 Toast 上下文
vi.mock('../../../services/toast/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

// Mock 工作区打开器
vi.mock('../../../api/filePanelOpener', () => ({
  openFileInPanel: vi.fn(),
  registerFileViewerOpener: vi.fn(),
}));

// Mock 路径安全校验
vi.mock('../../../api/workspaceFsApi', () => ({
  assertWorkspacePath: (p: string) => p,
  resolveWorkspacePath: (p: string) => p,
  isAbsoluteFsPath: (p: string) =>
    p.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(p),
  registerFileViewerOpener: vi.fn(),
}));

// Mock Tauri convertFileSrc
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

function createMockUserMessage(
  overrides: Partial<SessionMessage> = {}
): SessionMessage {
  return {
    id: 'user-msg-1',
    clientMessageId: 'client-1',
    sender: 'user',
    text: '你好，请帮我分析这份代码',
    timestamp: Date.now(),
    status: 'completed',
    ...overrides,
  };
}

describe('ChatUserMessageRow 全新解耦与物理删除立体验证套件', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetBusyRetryForTests();
    _resetAnimatedMessageIdsForTesting();
  });

  const defaultProps = {
    isPinned: false,
    isSearchHit: false,
    isExpanded: false,
    onToggleExpand: vi.fn(),
    onTogglePin: vi.fn(),
    isLastUser: false,
    messageIndex: 0,
    virtualScrollManager: null,
    onOpenPath: vi.fn(),
  };

  it('[NEG-06] 纯附件模式：类输入框卡片内必须渲染 userAttachmentStrip 与 58x58 卡片，且正文 userBubbleText 彻底为 null', () => {
    const msg = createMockUserMessage({
      text: '', // 纯附件无文本内容
      attachments: [
        { name: 'schema.sql', path: 'c:/Software/conex/schema.sql' },
        { name: 'diagram.png', dataUrl: 'data:image/png;base64,mock...' },
      ],
    });

    const { container } = render(
      <ChatUserMessageRow {...defaultProps} msg={msg} />
    );

    // 1) 验证类输入框卡片已挂载
    const bubble = container.querySelector(`.${styles.userBubble}`);
    expect(bubble).not.toBeNull();

    // 2) 验证卡片横排流内嵌在卡片内挂载
    const strip = bubble?.querySelector(
      '[data-testid="user-attachment-strip"]'
    );
    expect(strip).not.toBeNull();

    // 3) 验证渲染了 2 张 58x58 原子卡片
    const cards = container.querySelectorAll(
      '[data-testid="attachment-card-58"]'
    );
    expect(cards.length).toBe(2);

    // 4) 核心负向断言：纯附件时正文文本节点为 null
    expect(container.querySelector(`.${styles.userBubbleText}`)).toBeNull();
  });

  it('纯文本模式：必须渲染 userBubble，且 userAttachmentStrip 严禁挂载在 DOM 中', () => {
    const msg = createMockUserMessage({
      text: '这是一个纯文本消息，没有任何附件',
      attachments: [],
      images: [],
    });

    const { container } = render(
      <ChatUserMessageRow {...defaultProps} msg={msg} />
    );

    // 1) 验证文本气泡正常挂载
    const bubble = container.querySelector(`.${styles.userBubble}`);
    expect(bubble).not.toBeNull();
    expect(bubble?.textContent).toContain('这是一个纯文本消息');

    // 2) 验证卡片流完全不挂载
    expect(
      container.querySelector('[data-testid="user-attachment-strip"]')
    ).toBeNull();
  });

  it('图文混排模式：类输入框卡片内部上方必须渲染内嵌卡片流，下方渲染正文文本', () => {
    const msg = createMockUserMessage({
      text: '请看附件中的配置',
      attachments: [
        { name: 'config.json', path: 'c:/Software/conex/config.json' },
      ],
    });

    const { container } = render(
      <ChatUserMessageRow {...defaultProps} msg={msg} />
    );

    const bubble = container.querySelector(`.${styles.userBubble}`);
    expect(bubble).not.toBeNull();

    const strip = bubble?.querySelector(
      '[data-testid="user-attachment-strip"]'
    );
    const text = bubble?.querySelector(`.${styles.userBubbleText}`);

    expect(strip).not.toBeNull();
    expect(text).not.toBeNull();
    expect(text?.textContent).toContain('请看附件中的配置');

    // 验证同构卡片内部层级：卡片流必须在文本正文上方
    const children = Array.from(bubble?.children || []);
    const stripIndex = children.indexOf(strip as Element);
    const textIndex = children.indexOf(text as Element);

    expect(stripIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThan(stripIndex);
  });

  it('[NEG-02 & NEG-03] 死亡 CSS 与旧药丸彻底绝迹断言：DOM 树与源文件中绝对不得残留旧类名', () => {
    const msg = createMockUserMessage({
      text: '测试负向残留',
      attachments: [{ name: 'doc.md', path: 'c:/Software/conex/doc.md' }],
      images: [{ id: 'img-1', source: 'c:/Software/conex/test.png' }],
    });

    const { container } = render(
      <ChatUserMessageRow {...defaultProps} msg={msg} />
    );

    // 负向 DOM 断言：旧选择器必须全部返回 null
    expect(container.querySelector('.userAttachmentChip')).toBeNull();
    expect(container.querySelector('.userImages')).toBeNull();
    expect(container.querySelector('.userImageWrapper')).toBeNull();
    expect(container.querySelector('.userImage')).toBeNull();
    expect(container.querySelector('.userAttachments')).toBeNull();
    expect(container.querySelector('.userAttachmentName')).toBeNull();

    // 负向样式断言：Vite SSR CSS Proxy 靶标中无这些键，且源文件中已被物理切除
    expect('userAttachmentChip' in styles).toBe(false);
    expect('userImages' in styles).toBe(false);
    expect('userImageWrapper' in styles).toBe(false);
    expect('userAttachments' in styles).toBe(false);
    expect('userAttachmentName' in styles).toBe(false);

    // 物理文件切除断言（双重刚性守门，对齐 VirtualScrollGeometryContract）
    const cssPath = path.resolve(__dirname, '../ChatMessageRow.module.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    expect(cssContent).not.toContain('.userAttachmentChip');
    expect(cssContent).not.toContain('.userImages');
    expect(cssContent).not.toContain('.userImageWrapper');
    expect(cssContent).not.toContain('.userImage');
    expect(cssContent).not.toContain('.userAttachments');
    expect(cssContent).not.toContain('.userAttachmentName');
  });

  it('全自定义 Tooltip 守门断言：卡片及其子元素严禁包含原生 title 属性', () => {
    const msg = createMockUserMessage({
      text: '',
      attachments: [{ name: 'test.py', path: 'c:/Software/conex/test.py' }],
    });

    const { container } = render(
      <ChatUserMessageRow {...defaultProps} msg={msg} />
    );

    const card = container.querySelector('[data-testid="attachment-card-58"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('title')).toBeNull();
    const cardChildren = card?.querySelectorAll('*') || [];
    cardChildren.forEach((el) => {
      expect(el.getAttribute('title')).toBeNull();
    });
  });

  it('[MIN-01] 事件隔离断言：点击附件卡片触发 onOpenPath 并严格拦截冒泡，绝不触发长文本展开 toggleExpand', () => {
    const onToggleExpand = vi.fn();
    const onOpenPath = vi.fn();
    const msg = createMockUserMessage({
      text: '这是一段很长的文字'.repeat(50),
      attachments: [{ name: 'test.rs', path: 'c:/Software/conex/test.rs' }],
    });

    const { container } = render(
      <ChatUserMessageRow
        {...defaultProps}
        msg={msg}
        onToggleExpand={onToggleExpand}
        onOpenPath={onOpenPath}
      />
    );

    const card = container.querySelector('[data-testid="attachment-card-58"]');
    expect(card).not.toBeNull();

    // 点击卡片
    fireEvent.click(card!);

    // 断言打开路径被调用，展开回调绝不触发
    expect(onOpenPath).toHaveBeenCalledWith('c:/Software/conex/test.rs');
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it('排队态空文本测试：msg.status === "queued" 且 text 为空时，仅渲染排队占位提示', () => {
    const msg = createMockUserMessage({
      text: '',
      status: 'queued',
      attachments: [],
    });

    const { container } = render(
      <ChatUserMessageRow {...defaultProps} msg={msg} />
    );

    const bubble = container.querySelector(`.${styles.userBubble}`);
    expect(bubble).not.toBeNull();
    expect(bubble?.textContent).toContain('排队中');
  });

  it('就地编辑交互：点击编辑按钮触发 onStartEdit 回调', () => {
    const onStartEdit = vi.fn();
    const msg = createMockUserMessage({
      text: '这是待编辑的原消息内容',
      attachments: [{ name: 'doc.pdf', path: 'c:/Software/conex/doc.pdf' }],
    });

    const { container } = render(
      <ChatUserMessageRow
        {...defaultProps}
        msg={msg}
        onStartEdit={onStartEdit}
      />
    );

    // 默认展示类输入框卡片
    expect(container.querySelector(`.${styles.userBubble}`)).not.toBeNull();
    expect(
      container.querySelector('[data-testid="in-place-user-editor"]')
    ).toBeNull();

    // 点击编辑按钮
    const editBtn = container.querySelector('[data-testid="message-edit"]');
    expect(editBtn).not.toBeNull();
    fireEvent.click(editBtn!);

    expect(onStartEdit).toHaveBeenCalledTimes(1);
  });

  it('就地编辑交互：isEditing 为 true 时直接挂载外部单实例 composerElement', () => {
    const msg = createMockUserMessage({
      text: '这是正在编辑的消息',
    });

    const { container, rerender } = render(
      <ChatUserMessageRow
        {...defaultProps}
        msg={msg}
        isEditing={true}
        composerElement={
          <div data-testid="transferred-composer">100% 复用的 ChatComposer</div>
        }
      />
    );

    // 挂载单实例 composerElement
    const editorHost = container.querySelector(
      '[data-testid="in-place-user-editor"]'
    );
    expect(editorHost).not.toBeNull();
    expect(
      container.querySelector('[data-testid="transferred-composer"]')
    ).not.toBeNull();
    expect(container.querySelector(`.${styles.userBubble}`)).toBeNull();

    // 取消编辑后恢复展示气泡
    rerender(
      <ChatUserMessageRow {...defaultProps} msg={msg} isEditing={false} />
    );

    expect(
      container.querySelector('[data-testid="in-place-user-editor"]')
    ).toBeNull();
    expect(container.querySelector(`.${styles.userBubble}`)).not.toBeNull();
  });

  it('排队徽标：queued 时只显示「排队中」，status 离开 queued 后消失', () => {
    const msg = createMockUserMessage({
      text: '稍后发出',
      status: 'queued',
    });
    const { container, rerender } = render(
      <ChatUserMessageRow {...defaultProps} msg={msg} />
    );

    const badge = container.querySelector(`.${styles.queuedBadge}`);
    expect(badge?.textContent).toBe('排队中');
    expect(container.textContent).not.toContain(DOMAIN_MESSAGES.S7);
    expect(container.querySelector('[title]')).toBeNull();

    rerender(
      <ChatUserMessageRow
        {...defaultProps}
        msg={{ ...msg, status: 'completed' }}
      />
    );
    expect(container.querySelector(`.${styles.queuedBadge}`)).toBeNull();
    expect(container.textContent).toContain('稍后发出');
    expect(container.textContent).not.toContain('排队中');
  });

  it('排队徽标的 S7 Tooltip 只在串行守卫重试中出现', () => {
    vi.useFakeTimers();
    const idle = createMockUserMessage({
      id: 'user-follow-up',
      text: '主动追问',
      status: 'queued',
    });
    const { container, rerender } = render(
      <ChatUserMessageRow {...defaultProps} msg={idle} />
    );
    const idleBadge = container.querySelector(`.${styles.queued}`);
    expect(idleBadge).not.toBeNull();
    fireEvent.mouseEnter(idleBadge!);
    act(() => {
      vi.advanceTimersByTime(DEFAULT_DELAY_SHOW_MS);
    });
    expect(document.body.textContent).not.toContain(DOMAIN_MESSAGES.S7);

    noteBusy('sess-1', 'user-busy');
    rerender(
      <ChatUserMessageRow
        {...defaultProps}
        msg={createMockUserMessage({
          id: 'user-busy',
          text: '被串行守卫拦住',
          status: 'queued',
        })}
      />
    );
    const busyBadge = container.querySelector(`.${styles.queued}`);
    expect(busyBadge).not.toBeNull();
    expect(busyBadge?.getAttribute('title')).toBeNull();
    fireEvent.mouseEnter(busyBadge!);
    act(() => {
      vi.advanceTimersByTime(DEFAULT_DELAY_SHOW_MS);
    });
    expect(document.body.textContent).toContain(DOMAIN_MESSAGES.S7);
  });

  it('定时任务单次唤醒标识：msg.metadata 包含 triggerSource 时，渲染明确的系统定时任务唤醒标识', () => {
    const timerMsg = createMockUserMessage({
      id: 'timer-msg-1',
      text: '请总结今日工作',
      metadata: { triggerSource: 'system_timer' },
    });
    const { container, rerender } = render(
      <ChatUserMessageRow {...defaultProps} msg={timerMsg} />
    );
    const badge = container.querySelector(
      '[data-testid="trigger-source-badge"]'
    );
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('系统定时任务唤醒');

    const cronMsg = createMockUserMessage({
      id: 'cron-msg-1',
      text: '执行定时报告',
      metadata: { triggerSource: 'cron' },
    });
    rerender(<ChatUserMessageRow {...defaultProps} msg={cronMsg} />);
    const cronBadge = container.querySelector(
      '[data-testid="trigger-source-badge"]'
    );
    expect(cronBadge).not.toBeNull();
    expect(cronBadge?.textContent).toContain('定时计划唤醒');
  });

  it('用户消息气泡入场动画：新发送消息挂载 data-entering，并在 animationEnd 后卸载 GPU will-change', () => {
    const freshMsg = createMockUserMessage({
      id: 'fresh-glide-msg',
      text: '新消息滑入测试',
      timestamp: Date.now() - 100,
    });
    const { container } = render(
      <ChatUserMessageRow {...defaultProps} msg={freshMsg} />
    );
    const bubble = container.querySelector(`.${styles.userBubble}`);
    expect(bubble).not.toBeNull();
    expect(bubble?.getAttribute('data-entering')).toBe('true');
    expect(bubble?.classList.contains(styles.userBubbleEntering)).toBe(true);

    // 触发 animationEnd（兼容 jsdom 缺少标准 AnimationEvent 时 React 监听 webkitAnimationEnd），剥离 GPU 图层
    act(() => {
      fireEvent(bubble!, new Event('webkitAnimationEnd', { bubbles: true }));
    });
    expect(bubble?.getAttribute('data-entering')).toBeNull();
    expect(bubble?.classList.contains(styles.userBubbleEntering)).toBe(false);
  });

  it('历史消息不触发入场动画：旧消息不挂载 data-entering', () => {
    const oldMsg = createMockUserMessage({
      id: 'old-glide-msg',
      text: '历史已归档消息',
      timestamp: Date.now() - 10000,
    });
    const { container } = render(
      <ChatUserMessageRow {...defaultProps} msg={oldMsg} />
    );
    const bubble = container.querySelector(`.${styles.userBubble}`);
    expect(bubble).not.toBeNull();
    expect(bubble?.getAttribute('data-entering')).toBeNull();
    expect(bubble?.classList.contains(styles.userBubbleEntering)).toBe(false);
  });

  it('CSS 动效契约守门：.userBubbleEntering 包含 14px glideUp 与 220ms 缓动', () => {
    const cssPath = path.resolve(__dirname, '../ChatMessageRow.module.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    expect(cssContent).toContain('@keyframes userBubbleGlideUp');
    expect(cssContent).toContain('translateY(14px)');
    expect(cssContent).toContain('var(--duration-accordion, 220ms)');
    expect(cssContent).toContain('will-change: transform, opacity');
  });
});
