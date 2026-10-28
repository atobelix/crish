// 审批中心列表页组件测试（store 接线：R2-04 任务书第 4 点）
// 覆盖：待办列表渲染与排序（store 排序透传，F2 §4.2 剩余时间升序 + A2 次键）、概览条（含
// main-agent 只读计数，F2 §4.3）、空态文案、已处理区（最近 N 条 + decision 徽标 + 渠道，
// F2 §7.2）、点击行导航（onOpenItem）、已处理入口（onOpenHistory）、
// 决策后列表刷新（handleResolved → 行移除 + 历史入档 + 概览计数更新，store 状态驱动）、
// outbox 角标（R2UX §3.5）、formatHistoryTime 纯函数
// 注：@testing-library/react-native v14 render/fireEvent 为异步 API，全部 await
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ApprovalItem } from '@/domain/types/domain';
import type { PermissionRequest } from '@crish/shared-types';
import { approvalStore } from '@/domain/store/approvalStore';
import ApprovalListScreen from './approvalListScreen';
import { formatHistoryTime } from '@/presentation/components/approval/ApprovalHistoryRow';

function makeRequest(
  overrides: Partial<PermissionRequest> = {}
): PermissionRequest {
  return {
    id: 'approval-call-1',
    sessionId: 's-1',
    cwd: 'C:\\work',
    toolCallId: 'call-1',
    toolName: 'write_file',
    parameters: { path: 'a.ts' },
    summary: 'write a.ts',
    toolMetadata: {},
    ...overrides,
  };
}

function makeItem(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  const now = Date.now();
  return {
    request: makeRequest(),
    runId: null,
    arbiter: 'user',
    dangerLevel: 1,
    receivedAtMs: now,
    expiresAt: now + 120_000,
    status: 'pending',
    decisionStatus: 'idle',
    decisionBusy: false,
    ...overrides,
  };
}

function resetStore() {
  approvalStore.setState({
    pending: [],
    decisionBusy: {},
    outboxCount: 0,
    history: [],
    lastReconcileAt: null,
  });
}

function seed(item: ApprovalItem) {
  approvalStore.getState().upsertPending(item);
}

/** 生成已处理记录（经 store 动作，与真实链路一致）：approved/denied 用 handleResolved，expired 用 markExpired */
function seedHistory(
  toolCallId: string,
  decision: 'approved' | 'denied' | 'expired',
  resolvedAtMs: number
) {
  seed(makeItem({ request: makeRequest({ toolCallId }) }));
  if (decision === 'expired') {
    approvalStore.getState().markExpired(toolCallId, resolvedAtMs);
  } else {
    approvalStore.getState().handleResolved(toolCallId, decision, resolvedAtMs);
  }
}

beforeEach(() => {
  resetStore();
});

describe('ApprovalListScreen 待办列表渲染与排序', () => {
  it('按剩余时间升序渲染待办卡（store 排序透传，F2 §4.2 主键）', async () => {
    const now = Date.now();
    seed(
      makeItem({
        request: makeRequest({ toolCallId: 'call-a', toolName: 'delete_file' }),
        expiresAt: now + 30_000,
      })
    );
    seed(
      makeItem({
        request: makeRequest({ toolCallId: 'call-b', toolName: 'git push' }),
        expiresAt: now + 90_000,
      })
    );
    seed(
      makeItem({
        request: makeRequest({ toolCallId: 'call-c', toolName: 'write_file' }),
        expiresAt: now + 10_000,
      })
    );

    await render(
      <ApprovalListScreen onOpenItem={jest.fn()} onOpenHistory={jest.fn()} />
    );

    // 文档序 = 渲染序：最紧急（剩余 10s）在顶部（F2 §4.2 剩余时间升序）
    const rows = screen
      .getAllByTestId(/^approval-row-/)
      .map((el) => el.props.testID as string);
    expect(rows).toEqual([
      'approval-row-call-c',
      'approval-row-call-a',
      'approval-row-call-b',
    ]);
    // 概览条计数
    expect(screen.getByText('3 项待处理')).toBeTruthy();
  });

  it('概览条含 main-agent 只读项计数（F2 §4.3）', async () => {
    seed(
      makeItem({
        arbiter: 'main-agent',
        request: makeRequest({ toolCallId: 'call-1' }),
      })
    );
    seed(makeItem({ request: makeRequest({ toolCallId: 'call-2' }) }));

    await render(
      <ApprovalListScreen onOpenItem={jest.fn()} onOpenHistory={jest.fn()} />
    );

    expect(screen.getByText('2 项待处理 · 1 项等待 Agent 裁决')).toBeTruthy();
  });

  it('空态：无待办显示「暂无待审批」与说明文案（F2 §4.3）', async () => {
    await render(
      <ApprovalListScreen onOpenItem={jest.fn()} onOpenHistory={jest.fn()} />
    );

    expect(screen.getByTestId('approval-empty')).toBeTruthy();
    expect(screen.getByText('暂无待审批')).toBeTruthy();
    expect(
      screen.getByText('当桌面端 Agent 需要确认时，会第一时间推送到这里')
    ).toBeTruthy();
  });

  it('点击待办卡 → onOpenItem(toolCallId)（进审批详情，F2 §5.1）', async () => {
    const onOpenItem = jest.fn();
    seed(makeItem({ request: makeRequest({ toolCallId: 'call-1' }) }));

    await render(
      <ApprovalListScreen onOpenItem={onOpenItem} onOpenHistory={jest.fn()} />
    );

    await fireEvent.press(screen.getByTestId('approval-row-call-1'));
    expect(onOpenItem).toHaveBeenCalledWith('call-1');
  });

  it('点击已处理入口 → onOpenHistory（历史页）', async () => {
    const onOpenHistory = jest.fn();
    await render(
      <ApprovalListScreen
        onOpenItem={jest.fn()}
        onOpenHistory={onOpenHistory}
      />
    );

    await fireEvent.press(screen.getByTestId('history-entry'));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });
});

describe('ApprovalListScreen 已处理区（F2 §7.2）', () => {
  it('渲染最近已处理记录：decision 徽标 + 工具名 + 渠道（本机/桌面端/自动过期）', async () => {
    const now = Date.now();
    // 本机处理：beginDecision 置 decisionSentAtMs → 渠道 mobile
    seed(
      makeItem({
        request: makeRequest({ toolCallId: 'call-a', toolName: 'rm -rf tmp' }),
      })
    );
    approvalStore.getState().beginDecision('call-a', now - 1000);
    approvalStore.getState().markDecisionSent('call-a', 'approved', now);
    // 其他设备处理：直接 resolved（无本机发送标记）→ 渠道 desktop
    seed(
      makeItem({
        request: makeRequest({ toolCallId: 'call-b', toolName: 'git push' }),
      })
    );
    approvalStore.getState().handleResolved('call-b', 'denied', now);
    // 自动过期
    seed(
      makeItem({
        request: makeRequest({ toolCallId: 'call-c', toolName: 'write_file' }),
      })
    );
    approvalStore.getState().markExpired('call-c', now);

    await render(
      <ApprovalListScreen onOpenItem={jest.fn()} onOpenHistory={jest.fn()} />
    );

    expect(screen.getByTestId('approval-history')).toBeTruthy();
    expect(screen.getByText('已允许')).toBeTruthy();
    expect(screen.getByText('已拒绝')).toBeTruthy();
    expect(screen.getByText('已过期')).toBeTruthy();
    expect(screen.getByText('rm -rf tmp')).toBeTruthy();
    expect(screen.getByText('git push')).toBeTruthy();
    expect(screen.getByText('本机')).toBeTruthy();
    expect(screen.getByText('桌面端')).toBeTruthy();
    expect(screen.getByText('自动过期')).toBeTruthy();
    // 过期条目按 F2 §4.2-4 在待办列表置灰保留 24h（不构成空态）
    expect(screen.getByTestId('approval-row-call-c')).toBeTruthy();
  });

  it('只展示最近 5 条（时间倒序：最新在顶，F2 §7.1）', async () => {
    const now = Date.now();
    for (let i = 0; i < 6; i += 1) {
      seedHistory(`call-${i}`, 'approved', now + i * 1000);
    }

    await render(
      <ApprovalListScreen onOpenItem={jest.fn()} onOpenHistory={jest.fn()} />
    );

    const rows = screen
      .getAllByTestId(/^history-row-/)
      .map((el) => el.props.testID as string);
    expect(rows).toHaveLength(5);
    // 时间倒序：最新（call-5）在顶部，最旧（call-0）被截断
    expect(rows[0]).toBe('history-row-call-5');
    expect(rows[4]).toBe('history-row-call-1');
    expect(screen.queryByTestId('history-row-call-0')).toBeNull();
  });
});

describe('ApprovalListScreen 决策后列表刷新（store 状态驱动）', () => {
  it('handleResolved 后待办行移除、概览计数更新、历史入档', async () => {
    seed(
      makeItem({
        request: makeRequest({ toolCallId: 'call-1', toolName: 'write_file' }),
      })
    );
    seed(
      makeItem({
        request: makeRequest({ toolCallId: 'call-2', toolName: 'delete_file' }),
      })
    );

    await render(
      <ApprovalListScreen onOpenItem={jest.fn()} onOpenHistory={jest.fn()} />
    );
    expect(screen.getByText('2 项待处理')).toBeTruthy();

    // 决策落定（模拟 approval-resolved / 命令回执，先到者）
    await act(async () => {
      approvalStore.getState().handleResolved('call-1', 'approved', Date.now());
    });

    expect(screen.queryByTestId('approval-row-call-1')).toBeNull();
    expect(screen.getByTestId('approval-row-call-2')).toBeTruthy();
    expect(screen.getByText('1 项待处理')).toBeTruthy();
    // 历史入档
    expect(screen.getByText('已允许')).toBeTruthy();
    expect(screen.getByText('write_file')).toBeTruthy();
  });

  it('markExpired（本地倒计时到期）后待办行置灰保留 + 历史入档（F2 §8.3）', async () => {
    const now = Date.now();
    seed(
      makeItem({
        request: makeRequest({ toolCallId: 'call-1', toolName: 'write_file' }),
      })
    );

    await render(
      <ApprovalListScreen onOpenItem={jest.fn()} onOpenHistory={jest.fn()} />
    );

    await act(async () => {
      approvalStore.getState().markExpired('call-1', now + 121_000);
    });

    // 条目仍保留（24h 置灰保留，F2 §4.2-4），但概览只计可处理项？——概览按 rows.length（含 expired）
    // 断言：过期条目仍在列表中，历史出现「已过期」
    expect(screen.getByTestId('approval-row-call-1')).toBeTruthy();
    expect(screen.getByText('已过期（超过 120 秒），决策未生效')).toBeTruthy();
    expect(screen.getByText('已过期')).toBeTruthy();
  });
});

describe('ApprovalListScreen outbox 角标（R2UX §3.5）', () => {
  it('outboxCount > 0 显示「N 待发送」角标，与待批入口并列可区分', async () => {
    approvalStore.setState({ outboxCount: 2 });

    await render(
      <ApprovalListScreen onOpenItem={jest.fn()} onOpenHistory={jest.fn()} />
    );

    expect(screen.getByTestId('outbox-badge')).toBeTruthy();
    expect(screen.getByText('2 待发送')).toBeTruthy();
  });

  it('outboxCount = 0 不显示角标（诚实化，M4 §4.1）', async () => {
    await render(
      <ApprovalListScreen onOpenItem={jest.fn()} onOpenHistory={jest.fn()} />
    );
    expect(screen.queryByTestId('outbox-badge')).toBeNull();
  });
});

describe('formatHistoryTime 纯函数（F2 §7.2 HH:MM:SS 口径）', () => {
  it('按本地时间格式化', () => {
    const d = new Date(2026, 7, 12, 9, 5, 3); // 本地时区 09:05:03
    expect(formatHistoryTime(d.getTime())).toBe('09:05:03');
    const d2 = new Date(2026, 0, 1, 23, 59, 59);
    expect(formatHistoryTime(d2.getTime())).toBe('23:59:59');
  });
});
