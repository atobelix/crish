// 全局审批悬浮卡：隐藏路由、L1 直接决策、L2 跳滑动确认、多条入队列、收起成胶囊、点空白回会话。
// 形态断言口径（M-B 2026-11-02）：卡 / 胶囊双形态常驻以做高度+淡化过渡，
// 「当前形态」改以壳的触摸 / 无障碍接管断言（pointerEvents +
// accessibilityElementsHidden），不再断言非当前形态从树上消失——功能
// 时点（谁可点、谁对读屏可见）在切换提交瞬间即交接，动画只管观感。
import { act, fireEvent, render } from '@testing-library/react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ApprovalItem } from '@/domain/types/domain';
import { approvalStore } from '@/domain/store/approvalStore';
import { resetApprovalOutboxForTest } from '@/adapters/viewmodels/useApprovalDetailVm';
import { ApprovalFloat } from './ApprovalFloat';

let mockPathname = '/';
const mockPush = jest.fn();
const mockNavigate = jest.fn();

jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  router: {
    push: (href: string) => mockPush(href),
    navigate: (href: string) => mockNavigate(href),
  },
}));

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function makeItem(
  toolCallId: string,
  overrides: Partial<ApprovalItem> = {}
): ApprovalItem {
  const now = Date.now();
  return {
    request: {
      id: `approval-${toolCallId}`,
      sessionId: 's-1',
      cwd: 'C:/proj',
      toolCallId,
      toolName: 'write_file',
      parameters: { path: 'src/login.tsx' },
      intent: '修改登录页',
      toolMetadata: {},
    },
    runId: 'r-1',
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

function seed(pending: ApprovalItem[]) {
  approvalStore.setState({
    pending,
    decisionBusy: {},
    outboxCount: 0,
    lastReconcileAt: null,
    history: [],
  });
}

/** 在 toJSON 树里按 testID 取宿主节点 props（停靠壳对无障碍隐藏，
 *  RNTL 默认查询会过滤它，故走树遍历直查，与键盘守卫的 allProps 同款） */
function shellPropsOf(
  root: ReactTestRendererJSON | ReactTestRendererJSON[] | null,
  testID: string
): Record<string, unknown> {
  const visit = (
    node: ReactTestRendererJSON | string | null
  ): Record<string, unknown> | null => {
    if (!node || typeof node === 'string') return null;
    if (node.props?.testID === testID) {
      return node.props as Record<string, unknown>;
    }
    for (const child of node.children ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  for (const node of Array.isArray(root) ? root : [root]) {
    const found = visit(node);
    if (found) return found;
  }
  throw new Error(`未找到壳节点：${testID}`);
}

function renderFloat() {
  return render(<ApprovalFloat />, {
    wrapper: ({ children }) => (
      <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
    ),
  });
}

beforeEach(() => {
  mockPathname = '/';
  mockPush.mockReset();
  mockNavigate.mockReset();
  resetApprovalOutboxForTest();
  seed([]);
});

describe('ApprovalFloat', () => {
  it('无待审批时不渲染', async () => {
    const view = await renderFloat();
    expect(view.queryByTestId('approval-float-card')).toBeNull();
  });

  it('隐藏路由下不渲染', async () => {
    seed([makeItem('tc-1')]);
    mockPathname = '/settings';
    const view = await renderFloat();
    expect(view.queryByTestId('approval-float-card')).toBeNull();
    expect(view.queryByTestId('approval-float-pill')).toBeNull();
  });

  it('从 /settings 返回 / 时，等待 InteractionManager 转场落定后挂载浮层（方案 08 流畅度门）', async () => {
    seed([makeItem('tc-1')]);
    mockPathname = '/settings';
    const view = await renderFloat();
    expect(view.queryByTestId('approval-float-card')).toBeNull();

    // 路由从设置返回主屏
    mockPathname = '/';
    await act(async () => {
      view.rerender(<ApprovalFloat />);
    });

    // 交互队列排队完成后水合卡片
    expect(view.getByTestId('approval-float-card')).toBeTruthy();
  });

  it('L1：卡内直接允许，条目进入待发送', async () => {
    seed([makeItem('tc-1')]);
    const view = await renderFloat();
    // 工具名标签保持原始大小写（M3 裁决：标签不大写、字距 0.02em）
    expect(view.getByText('write_file')).toBeTruthy();
    expect(view.queryByTestId('approval-float-review')).toBeNull();
    await fireEvent.press(view.getByTestId('approval-float-allow'));
    expect(approvalStore.getState().pending[0]?.status).toBe('queued');
  });

  it('L2：只给查看并滑动确认，跳审批弹窗', async () => {
    seed([makeItem('tc-2', { dangerLevel: 2 })]);
    const view = await renderFloat();
    expect(view.queryByTestId('approval-float-allow')).toBeNull();
    await fireEvent.press(view.getByTestId('approval-float-review'));
    expect(mockPush).toHaveBeenCalledWith('/approval/tc-2');
  });

  it('多条：「还有 N 个」打开队列 sheet', async () => {
    seed([makeItem('a'), makeItem('b'), makeItem('c')]);
    const view = await renderFloat();
    expect(view.getByText('还有 2 个')).toBeTruthy();
    await fireEvent.press(view.getByTestId('approval-float-more'));
    expect(mockPush).toHaveBeenCalledWith('/approvals');
  });

  it('收起成胶囊，点胶囊再展开', async () => {
    seed([makeItem('a'), makeItem('b')]);
    const view = await renderFloat();
    // 展开态：卡壳接管触摸与无障碍，胶囊壳停靠（不可点、读屏隐藏）
    const cardShell = () =>
      shellPropsOf(view.toJSON(), 'approval-float-card-shell');
    const pillShell = () =>
      shellPropsOf(view.toJSON(), 'approval-float-pill-shell');
    expect(cardShell().pointerEvents).toBe('auto');
    expect(cardShell().accessibilityElementsHidden).toBe(false);
    expect(pillShell().pointerEvents).toBe('none');
    expect(pillShell().accessibilityElementsHidden).toBe(true);
    await fireEvent.press(view.getByTestId('approval-float-collapse'));
    // 收起提交瞬间即交接：胶囊可点、卡退出触摸与读屏（视觉淡化在动画层）
    expect(cardShell().pointerEvents).toBe('none');
    expect(cardShell().accessibilityElementsHidden).toBe(true);
    expect(pillShell().pointerEvents).toBe('auto');
    expect(pillShell().accessibilityElementsHidden).toBe(false);
    expect(view.getByText(/^2 个待审批 · \d+:\d{2}$/)).toBeTruthy();
    await fireEvent.press(view.getByTestId('approval-float-pill'));
    // 再展开：卡即刻恢复可达（不等任何动画）
    expect(cardShell().pointerEvents).toBe('auto');
    expect(cardShell().accessibilityElementsHidden).toBe(false);
    expect(view.getByTestId('approval-float-card')).toBeTruthy();
  });

  it('点卡片空白处回到所属会话', async () => {
    seed([makeItem('tc-1')]);
    const view = await renderFloat();
    await fireEvent.press(view.getByTestId('approval-float-card'));
    expect(mockNavigate).toHaveBeenCalledWith('/session/s-1');
  });
});
