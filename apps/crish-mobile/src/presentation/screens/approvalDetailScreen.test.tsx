// 审批详情页组件测试（store 接线：R2-04 任务书第 3 点）
// 真实 approvalStore + 内存 outbox：挂载读选择器 → 决策动作调用（beginDecision → outbox 入队 → markQueued）→
// 决策后状态反馈；busy 防双点由 store decisionBusy 状态位驱动（R2UX-04-03 组件不自行计时）
// 注：@testing-library/react-native v14 render/fireEvent 为异步 API，全部 await
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import type { ApprovalItem } from '@/domain/types/domain';
import type { PermissionRequest } from '../../../../../packages/shared-types/src/generated/engine/types';
import { approvalStore } from '@/domain/store/approvalStore';
import {
  approvalOutboxCount,
  resetApprovalOutboxForTest,
} from '@/adapters/viewmodels/useApprovalDetailVm';
import ApprovalDetailScreen from './approvalDetailScreen';

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

function resetStores() {
  approvalStore.setState({
    pending: [],
    decisionBusy: {},
    outboxCount: 0,
    history: [],
    lastReconcileAt: null,
  });
  resetApprovalOutboxForTest();
}

function seed(item: ApprovalItem) {
  approvalStore.getState().upsertPending(item);
}

beforeEach(() => {
  resetStores();
});

describe('审批详情页 store 接线', () => {
  it('页面挂载读取 approvalStore 选择器并渲染待办卡（F2 §5.1）', async () => {
    seed(
      makeItem({
        request: makeRequest({ toolName: 'delete_file' }),
        dangerLevel: 2,
      })
    );
    await render(<ApprovalDetailScreen toolCallId="call-1" />);

    expect(screen.getByText('delete_file')).toBeTruthy();
    expect(screen.getByText('高风险')).toBeTruthy();
    // 首屏即见决策区（决策按钮存在，R2UX-04-01）
    expect(screen.getByTestId('approval-allow')).toBeTruthy();
    expect(screen.getByTestId('approval-deny')).toBeTruthy();
  });

  it('允许流：点击 → busy（deciding）→ outbox 入队 → 待发送（queued）', async () => {
    seed(makeItem());
    await render(<ApprovalDetailScreen toolCallId="call-1" />);

    await fireEvent.press(screen.getByTestId('approval-allow'));

    const state = approvalStore.getState();
    expect(state.pending[0]?.status).toBe('queued');
    expect(state.decisionBusy['call-1']).toBe(true);
    expect(state.outboxCount).toBe(1);
    expect(approvalOutboxCount()).toBe(1);
    // 决策后状态反馈：待发送（R2UX-04-05）
    expect(screen.getByText('待发送 · 网络恢复后自动发送')).toBeTruthy();
  });

  it('允许流防双点：busy 期间第二次点击不产生第二次决策（R2UX-04-03）', async () => {
    seed(makeItem());
    await render(<ApprovalDetailScreen toolCallId="call-1" />);

    await fireEvent.press(screen.getByTestId('approval-allow'));
    await fireEvent.press(screen.getByTestId('approval-allow'));

    const state = approvalStore.getState();
    expect(state.pending).toHaveLength(1);
    expect(approvalOutboxCount()).toBe(1);
    expect(state.outboxCount).toBe(1);
  });

  it('拒绝流：点击拒绝 → 二次确认 → 确认 → 入队待发送', async () => {
    seed(makeItem());
    await render(<ApprovalDetailScreen toolCallId="call-1" />);

    await fireEvent.press(screen.getByTestId('approval-deny'));
    expect(screen.getByTestId('approval-deny-dialog')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('deny-confirm'));

    const state = approvalStore.getState();
    expect(state.pending[0]?.status).toBe('queued');
    expect(state.decisionBusy['call-1']).toBe(true);
    expect(approvalOutboxCount()).toBe(1);
    expect(screen.getByText('待发送 · 网络恢复后自动发送')).toBeTruthy();
  });

  it('拒绝流取消：弹窗取消不发送，条目保持 pending', async () => {
    seed(makeItem());
    await render(<ApprovalDetailScreen toolCallId="call-1" />);

    await fireEvent.press(screen.getByTestId('approval-deny'));
    await fireEvent.press(screen.getByTestId('deny-cancel'));

    const state = approvalStore.getState();
    expect(state.pending[0]?.status).toBe('pending');
    expect(state.decisionBusy['call-1'] ?? false).toBe(false);
    expect(approvalOutboxCount()).toBe(0);
  });

  it('决策发送回执（模拟仓库 markDecisionSent）：条目移除 + 历史结果态展示（F2 §7）', async () => {
    seed(makeItem());
    approvalStore.getState().beginDecision('call-1');
    approvalStore.getState().markDecisionSent('call-1', 'approved');

    await render(<ApprovalDetailScreen toolCallId="call-1" />);

    expect(screen.getByTestId('approval-result')).toBeTruthy();
    expect(screen.getByText('已允许')).toBeTruthy();
    expect(screen.getByText('该请求已由本机处理，无需再操作')).toBeTruthy();
    // 决策区不再渲染（已处理）
    expect(screen.queryByTestId('approval-allow')).toBeNull();
  });

  it('未知 toolCallId：深链目标不存在空态（M4 §5.9 / F2 §6.2）', async () => {
    await render(<ApprovalDetailScreen toolCallId="no-such-call" />);

    expect(screen.getByTestId('approval-empty')).toBeTruthy();
    expect(screen.getByText('该请求不存在或已过期')).toBeTruthy();
    expect(screen.queryByTestId('approval-allow')).toBeNull();
  });

  it('本地倒计时到期自动置 expired 并展示过期态（F2 §8.3 / E2E-4 数据面）', async () => {
    seed(makeItem({ expiresAt: Date.now() - 1_000 }));
    await render(<ApprovalDetailScreen toolCallId="call-1" />);

    await waitFor(() => {
      expect(approvalStore.getState().pending[0]?.status).toBe('expired');
    });
    expect(screen.getByText('已过期（超过 120 秒），决策未生效')).toBeTruthy();
    // 过期后决策区隐藏（F2 §6.2 不产生决策入口）
    expect(screen.queryByTestId('approval-allow')).toBeNull();
  });

  it('main-agent 只读条目：不渲染决策区（F2 §4.4）', async () => {
    seed(makeItem({ arbiter: 'main-agent' }));
    await render(<ApprovalDetailScreen toolCallId="call-1" />);

    expect(screen.getByText('等待 Agent 裁决')).toBeTruthy();
    expect(screen.queryByTestId('approval-allow')).toBeNull();
    expect(screen.queryByTestId('approval-deny')).toBeNull();
  });
});
