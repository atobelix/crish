// @vitest-environment jsdom
import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ChatUserMessageRow } from '../ChatUserMessageRow';
import type { SessionMessage } from '../../../store/types';
import styles from '../ChatMessageRow.module.css';

// Mock 全局 Toast 上下文
vi.mock('../../../services/toast/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

// Mock 工作区打开器
vi.mock('../../../api/filePanelOpener', () => ({
  openFileInPanel: vi.fn(),
}));

// Mock 路径安全校验
vi.mock('../../../api/workspaceFsApi', () => ({
  assertWorkspacePath: (p: string) => p,
  resolveWorkspacePath: (p: string) => p,
  isAbsoluteFsPath: (p: string) => p.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(p),
}));

// Mock Tauri convertFileSrc
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

function createMockUserMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
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
    vi.restoreAllMocks();
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

  it('[NEG-06] 纯附件模式：必须渲染 userAttachmentStrip 与 58x58 卡片，且空气泡 userBubble 必须从 DOM 中彻底销毁为 null', () => {
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

    // 1) 验证卡片横排流已挂载
    const strip = container.querySelector('[data-testid="user-attachment-strip"]');
    expect(strip).not.toBeNull();

    // 2) 验证渲染了 2 张 58x58 原子卡片
    const cards = container.querySelectorAll('[data-testid="attachment-card-58"]');
    expect(cards.length).toBe(2);

    // 3) 核心负向断言：空气泡彻底为 null（零渲染，绝无空背景壳）
    expect(container.querySelector(`.${styles.userBubble}`)).toBeNull();
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
    expect(container.querySelector('[data-testid="user-attachment-strip"]')).toBeNull();
  });

  it('图文混排模式：上方必须渲染独立卡片流，下方必须渲染独立文本气泡，且二者为平级兄弟节点', () => {
    const msg = createMockUserMessage({
      text: '请看附件中的配置',
      attachments: [{ name: 'config.json', path: 'c:/Software/conex/config.json' }],
    });

    const { container } = render(
      <ChatUserMessageRow {...defaultProps} msg={msg} />
    );

    const strip = container.querySelector('[data-testid="user-attachment-strip"]');
    const bubble = container.querySelector(`.${styles.userBubble}`);

    expect(strip).not.toBeNull();
    expect(bubble).not.toBeNull();

    // 验证兄弟层级：卡片流必须在文本气泡上方
    const stack = container.querySelector(`.${styles.userStack}`);
    expect(stack).not.toBeNull();
    const children = Array.from(stack?.children || []);
    const stripIndex = children.indexOf(strip as Element);
    const bubbleIndex = children.indexOf(bubble as Element);

    expect(stripIndex).toBeGreaterThanOrEqual(0);
    expect(bubbleIndex).toBeGreaterThan(stripIndex);
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
});
