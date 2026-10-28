// 审批历史全量页测试（F2 §7 · R4 批次3）：倒序投影 / 全量行渲染 / 拒绝理由副行 /
// 空态 / 返回回调
import { fireEvent, render, screen } from '@testing-library/react-native';
import { approvalStore } from '@/domain/store/approvalStore';
import ApprovalHistoryScreen, { historyDesc } from './approvalHistoryScreen';
import type { ApprovalRecord } from '@/domain/types/domain';

/** 直种历史记录（绕过 pending 流程，注入 store 审计面） */
function seedRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const record: ApprovalRecord = {
    toolCallId: 'tc-1',
    toolName: 'write_file',
    sessionId: 's-1',
    runId: null,
    decision: 'approved',
    channel: 'mobile',
    resolvedAtMs: 1_700_000_000_000,
    ...overrides,
  };
  approvalStore.setState((s) => ({ history: [...s.history, record] }));
  return record;
}

beforeEach(() => {
  approvalStore.setState({
    pending: [],
    decisionBusy: {},
    outboxCount: 0,
    lastReconcileAt: null,
    history: [],
  });
});

describe('historyDesc（倒序投影）', () => {
  it('追加序 → 最新在前', () => {
    seedRecord({ toolCallId: 'a', resolvedAtMs: 1 });
    seedRecord({ toolCallId: 'b', resolvedAtMs: 2 });
    expect(
      historyDesc(approvalStore.getState().history).map((r) => r.toolCallId)
    ).toEqual(['b', 'a']);
  });
});

describe('ApprovalHistoryScreen', () => {
  it('空态：主文案 + 副文案（无历史时不渲染列表）', async () => {
    await render(<ApprovalHistoryScreen onBack={jest.fn()} />);
    expect(screen.getByTestId('approval-history-empty')).toBeTruthy();
    expect(screen.getByText('暂无已处理记录')).toBeTruthy();
  });

  it('全量渲染：决策徽标 + 工具名 + 行键倒序（最新在前）', async () => {
    seedRecord({ toolCallId: 'tc-1', toolName: 'bash', decision: 'approved' });
    seedRecord({ toolCallId: 'tc-2', toolName: 'rm', decision: 'denied' });

    await render(<ApprovalHistoryScreen onBack={jest.fn()} />);
    const rows = screen
      .getAllByTestId(/^history-row-/)
      .map((el) => el.props.testID as string);
    expect(rows).toEqual(['history-row-tc-2', 'history-row-tc-1']);
    expect(screen.getByText('已允许')).toBeTruthy();
    expect(screen.getByText('已拒绝')).toBeTruthy();
    expect(screen.getByText('bash')).toBeTruthy();
    expect(screen.getByText('rm')).toBeTruthy();
  });

  it('拒绝理由副行展示（审计留痕）', async () => {
    seedRecord({
      toolCallId: 'tc-9',
      decision: 'denied',
      reason: '涉及生产库，需人工确认',
    });
    await render(<ApprovalHistoryScreen onBack={jest.fn()} />);
    expect(screen.getByText(/涉及生产库/)).toBeTruthy();
  });

  it('返回回调上抛', async () => {
    const onBack = jest.fn();
    seedRecord({ toolCallId: 'tc-1' });
    await render(<ApprovalHistoryScreen onBack={onBack} />);
    await fireEvent.press(screen.getByTestId('header-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
