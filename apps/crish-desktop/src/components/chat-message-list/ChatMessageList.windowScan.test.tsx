// @vitest-environment jsdom
/**
 * ChatMessageList 窗口扫描 memo 化测试（审计 F7-F20）
 *
 * 缺陷：mustIncludeIndices 的 useMemo 与 resolveExpandedForKeepAlive 的
 * useEffect 依赖 messages 引用——流式期间每 token 换新引用 → O(n) 全量扫描
 * + mustInclude 集合重建每帧执行，长会话打字流卡顿风险。
 *
 * 修复契约：扫描 memo 键 = 消息 id 签名（消息身份未变则不重扫）；
 * 搜索激活时（结果依赖内容）保持全量重扫以保证正确性。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChatMessageList } from './ChatMessageList';
import {
  collectMustIncludeIndices,
  collectMustIncludeIndicesCached,
} from '../../api/messageWindow';
import type { SessionMessage } from '../../store/types';

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

vi.mock('../../api/sessionSearch', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/sessionSearch')
  >('../../api/sessionSearch');
  return {
    subscribeSearchQuery: actual.subscribeSearchQuery,
    getSearchQuerySnapshot: actual.getSearchQuerySnapshot,
    tokenizeSearchQuery: actual.tokenizeSearchQuery,
    normalizeSearchQuery: actual.normalizeSearchQuery,
    messageMatchesSearchTokens: actual.messageMatchesSearchTokens,
    // 保留既有用例语义：搜索未激活（query 空）时 messageMatchesSearch 恒 false
    messageMatchesSearch: () => false,
  };
});

// 不能再用 `{ spy: true }`：根 vitest.setup.ts 的 afterEach 无条件
// restoreAllMocks，会把 spy:true 的模块级 spy 还原为原始函数，第二个用例
// 读取 .mock.calls 即 undefined（原回归根因）。改为显式工厂 mock：
// 全部导出走真实实现（行为不被 mock 掉），仅 collectMustIncludeIndices 包一层
// vi.fn 供调用计数——vi.fn 不受 restoreAllMocks 影响，跨用例稳定。
vi.mock('../../api/messageWindow', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/messageWindow')
  >('../../api/messageWindow');
  return {
    ...actual,
    collectMustIncludeIndices: vi.fn(actual.collectMustIncludeIndices),
    collectMustIncludeIndicesCached: vi.fn(
      actual.collectMustIncludeIndicesCached
    ),
  };
});

vi.mock('../../store/storeAccess', () => ({
  usePermissionField: (sel: (s: unknown) => unknown) =>
    sel({
      permissionMode: 'none',
      planModeEnabled: false,
      planApproved: false,
      setPlanApproved: vi.fn(),
      setPermissionMode: vi.fn(),
    }),
  useSettingsField: (sel: (s: unknown) => unknown) =>
    sel({ appSettings: { hideThinkingBlock: false } }),
  selectPermissionMode: (s: { permissionMode?: string }) => s.permissionMode,
  selectPlanModeEnabled: (s: { planModeEnabled?: boolean }) =>
    s.planModeEnabled,
  selectPlanApproved: (s: { planApproved?: boolean }) => s.planApproved,
  // T4 A4：useChatMessageState 经统一读面取 layoutStore（pin 动作 + 固定 id 列表）
  useLayoutStore: (sel: (s: unknown) => unknown) =>
    sel({
      pinMessage: vi.fn(),
      unpinMessage: vi.fn(),
      sessionsById: {},
    }),
}));

// 渲染链路与扫描逻辑无关（扫描发生在 ChatMessageList 内部），
// 用轻量桩替换行渲染避免 IPC/markdown 链路的连锁依赖
vi.mock('./MessageVirtualizer', () => ({
  MessageVirtualizer: () => <div data-testid="virtualizer" />,
}));

function pendingApproval(id: string, text: string): SessionMessage {
  return {
    id,
    sender: 'assistant',
    timestamp: 1000,
    text,
    toolCalls: [
      {
        id: `tc-${id}`,
        name: 'read_file',
        arguments: '{}',
        status: 'pending_approval',
      },
    ],
  } as SessionMessage;
}

function userMsg(id: string, text: string): SessionMessage {
  return {
    id,
    sender: 'user',
    timestamp: 2000,
    text,
  } as SessionMessage;
}

function renderList(messages: SessionMessage[]) {
  return render(
    <ChatMessageList
      messages={messages}
      allMessages={messages}
      agents={[]}
      activeSessionId="sess-1"
      showAllMessages={false}
      showProjectPicker={false}
      onShowProjectPicker={vi.fn()}
      onProjectChanged={vi.fn()}
      onSetChatInput={vi.fn()}
      onSendFollowUp={vi.fn()}
      onRegenerate={vi.fn()}
      onBranch={vi.fn()}
      onShowToast={vi.fn()}
      approvalBusy={false}
      pendingApprovalMsgId=""
      onOpenDiff={vi.fn()}
      onOpenPath={vi.fn()}
      onOpenTerminal={vi.fn()}
      onApprovalAllow={vi.fn()}
      onApprovalDeny={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
  // 工厂 mock 用 vi.fn 包裹真实实现，restoreAllMocks 不影响其 .mock 结构；
  // 这里只需清空调用计数（根 vitest.setup.ts 的 afterEach 仍会 restoreAllMocks）。
  vi.clearAllMocks();
});

describe('ChatMessageList 窗口扫描 memo 化（F7-F20）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('流式内容变更（同 id 同长度）不触发 mustInclude 全量重扫', () => {
    const base = [userMsg('u1', '问题'), pendingApproval('a1', '待审批回复')];
    const { rerender } = renderList(base);
    const callsAtMount = vi.mocked(collectMustIncludeIndices).mock.calls.length;
    expect(callsAtMount).toBeGreaterThanOrEqual(1);
    // 流式续写：同 id、同长度、内容更新（每 token 新引用）
    rerender(
      renderListProps([
        userMsg('u1', '问题'),
        pendingApproval('a1', '待审批回复·续写'),
      ])
    );
    expect(vi.mocked(collectMustIncludeIndices).mock.calls.length).toBe(
      callsAtMount
    );
  });

  it('消息身份变化（新增/移除）时重新扫描', () => {
    const base = [userMsg('u1', '问题'), pendingApproval('a1', '待审批回复')];
    const { rerender } = renderList(base);
    const callsAtMount = vi.mocked(collectMustIncludeIndices).mock.calls.length;
    rerender(
      renderListProps([
        userMsg('u1', '问题'),
        pendingApproval('a1', '待审批回复'),
        userMsg('u2', '新问题'),
      ])
    );
    expect(
      vi.mocked(collectMustIncludeIndices).mock.calls.length
    ).toBeGreaterThan(callsAtMount);
  });
});

// ──────────────────────────────────────────────
describe('T3.3（S3）：processing 期搜索 keep-alive 重扫节流', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try {
      sessionStorage.removeItem('crish_session_search_query');
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    try {
      sessionStorage.removeItem('crish_session_search_query');
    } catch {
      /* ignore */
    }
  });

  function processingAsst(id: string, text: string): SessionMessage {
    return {
      id,
      sender: 'assistant',
      timestamp: 1000,
      text,
      status: 'processing',
      toolCalls: [],
      blocks: [{ type: 'text', content: text }],
    } as SessionMessage;
  }

  it('搜索激活 + processing 期：流式帧不触发命中扫描（windowScanKey 降级为 id 签名）', () => {
    // 激活搜索（subscribeSearchQuery 读 sessionStorage）
    try {
      sessionStorage.setItem('crish_session_search_query', '命中');
    } catch {
      /* ignore */
    }
    const base = [userMsg('u1', '问题'), processingAsst('a1', '命中第一段')];
    const { rerender } = renderList(base);
    const callsAtMount = vi.mocked(collectMustIncludeIndicesCached).mock.calls
      .length;
    expect(callsAtMount).toBeGreaterThanOrEqual(1);

    // 流式帧：同 id、内容增长（processing 期）→ 扫描次数不增长
    for (let i = 2; i <= 8; i++) {
      rerender(
        renderListProps([
          userMsg('u1', '问题'),
          processingAsst('a1', `命中第一段·续写第 ${i} 段`),
        ])
      );
      expect(vi.mocked(collectMustIncludeIndicesCached).mock.calls.length).toBe(
        callsAtMount
      );
    }
  });

  it('搜索激活 + 非流式期：命中扫描恢复（搜索编辑/审批即时响应）', () => {
    try {
      sessionStorage.setItem('crish_session_search_query', '命中');
    } catch {
      /* ignore */
    }
    const completed = [
      userMsg('u1', '问题'),
      { ...processingAsst('a1', '命中第一段'), status: 'completed' },
    ];
    const { rerender } = renderList(completed);
    const callsAtMount = vi.mocked(collectMustIncludeIndicesCached).mock.calls
      .length;

    // 非流式期：消息引用变化（如审批/编辑）→ 重新扫描
    rerender(
      renderListProps([
        userMsg('u1', '问题'),
        {
          ...processingAsst('a1', '命中第一段（编辑后）'),
          status: 'completed',
          toolCalls: [
            { id: 't1', name: 'read_file', arguments: '{}', status: 'success' },
          ],
        },
      ])
    );
    expect(
      vi.mocked(collectMustIncludeIndicesCached).mock.calls.length
    ).toBeGreaterThan(callsAtMount);
  });
});

function renderListProps(messages: SessionMessage[]) {
  return (
    <ChatMessageList
      messages={messages}
      allMessages={messages}
      agents={[]}
      activeSessionId="sess-1"
      showAllMessages={false}
      showProjectPicker={false}
      onShowProjectPicker={vi.fn()}
      onProjectChanged={vi.fn()}
      onSetChatInput={vi.fn()}
      onSendFollowUp={vi.fn()}
      onRegenerate={vi.fn()}
      onBranch={vi.fn()}
      onShowToast={vi.fn()}
      approvalBusy={false}
      pendingApprovalMsgId=""
      onOpenDiff={vi.fn()}
      onOpenPath={vi.fn()}
      onOpenTerminal={vi.fn()}
      onApprovalAllow={vi.fn()}
      onApprovalDeny={vi.fn()}
    />
  );
}
