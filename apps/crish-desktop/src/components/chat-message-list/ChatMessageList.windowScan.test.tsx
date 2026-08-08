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
import { collectMustIncludeIndices } from '../../api/messageWindow';
import type { SessionMessage } from '../../store/types';

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

vi.mock('../../api/sessionSearch', () => ({
  subscribeSearchQuery: () => () => {},
  getSearchQuerySnapshot: () => '',
  messageMatchesSearch: () => false,
}));

vi.mock('../../api/messageWindow', { spy: true });

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
  selectPlanModeEnabled: (s: { planModeEnabled?: boolean }) => s.planModeEnabled,
  selectPlanApproved: (s: { planApproved?: boolean }) => s.planApproved,
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
    toolCalls: [{ id: `tc-${id}`, name: 'read_file', arguments: '{}', status: 'pending_approval' }],
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
      onWithdraw={vi.fn()}
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
  vi.restoreAllMocks();
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
    rerender(renderListProps([userMsg('u1', '问题'), pendingApproval('a1', '待审批回复·续写')]));
    expect(vi.mocked(collectMustIncludeIndices).mock.calls.length).toBe(
      callsAtMount
    );
  });

  it('消息身份变化（新增/移除）时重新扫描', () => {
    const base = [userMsg('u1', '问题'), pendingApproval('a1', '待审批回复')];
    const { rerender } = renderList(base);
    const callsAtMount = vi.mocked(collectMustIncludeIndices).mock.calls.length;
    rerender(renderListProps([userMsg('u1', '问题'), pendingApproval('a1', '待审批回复'), userMsg('u2', '新问题')]));
    expect(vi.mocked(collectMustIncludeIndices).mock.calls.length).toBeGreaterThan(
      callsAtMount
    );
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
      onWithdraw={vi.fn()}
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
