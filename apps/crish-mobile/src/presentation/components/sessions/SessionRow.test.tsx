// 会话列表行组件测试（R2-05 部分 4：完整行形态）
// 覆盖：标题 + 预览 + 相对时间（nowMs 注入）、运行中指示（activeRunIds）、
// 未读角标（unreadCount > 0 显示 / =0 隐藏 / 99+ 收敛）、审批角标透传与点击、
// 行点击导航（onOpen 携带 sessionId）、空预览不渲染预览行、
// 流式预览（R2UX-05-02：previewStreaming 光标 + 节流渐进渲染 + 终值立即）
// 注：@testing-library/react-native v14 render/fireEvent 为异步 API，全部 await
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { SessionRow, unreadLabel } from './SessionRow';

const NOW = 1_800_000_000_000;

function makeSession(
  overrides: Partial<SessionSummary> & { id: string }
): SessionSummary {
  return {
    title: `会话 ${overrides.id}`,
    updatedAt: NOW - 5 * 60_000,
    messageCount: 0,
    engineCursor: 0,
    receivedAtMs: NOW,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    ...overrides,
  };
}

describe('SessionRow 行渲染', () => {
  it('渲染标题 / 预览 / 相对时间（nowMs 注入）', async () => {
    await render(
      <SessionRow
        session={makeSession({ id: 's-1', updatedAt: NOW - 5 * 60_000 })}
        preview="已定位问题：登录接口超时"
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );

    expect(screen.getByTestId('session-row-s-1')).toBeTruthy();
    expect(screen.getByText('会话 s-1')).toBeTruthy();
    expect(screen.getByTestId('session-row-preview')).toHaveTextContent(
      '已定位问题：登录接口超时'
    );
    expect(screen.getByTestId('session-row-time')).toHaveTextContent(
      '5 分钟前'
    );
  });

  it('空预览不渲染预览行', async () => {
    await render(
      <SessionRow
        session={makeSession({ id: 's-1' })}
        preview=""
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );

    expect(screen.queryByTestId('session-row-preview')).toBeNull();
  });

  it('updatedAt 缺失兜底 0 毫秒时间戳（不崩溃）', async () => {
    await render(
      <SessionRow
        session={makeSession({ id: 's-1', updatedAt: 0 })}
        preview=""
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );

    expect(screen.getByTestId('session-row-time')).toBeTruthy();
  });

  it('activeRunIds 非空 → 显示「运行中」指示（agent-start 后，F1 §5.2）', async () => {
    await render(
      <SessionRow
        session={makeSession({ id: 's-1', activeRunIds: ['run-1'] })}
        preview=""
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );

    expect(screen.getByTestId('session-row-running')).toBeTruthy();
    expect(screen.getByText('运行中')).toBeTruthy();
  });

  it('无活动 run → 不显示「运行中」指示', async () => {
    await render(
      <SessionRow
        session={makeSession({ id: 's-1' })}
        preview=""
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );

    expect(screen.queryByTestId('session-row-running')).toBeNull();
  });
});

describe('SessionRow 角标', () => {
  it('unreadCount > 0 → 未读数字角标（F5 §6.3 红点数字）', async () => {
    await render(
      <SessionRow
        session={makeSession({ id: 's-1', unreadCount: 3 })}
        preview=""
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );

    expect(screen.getByTestId('session-unread-badge')).toHaveTextContent('3');
  });

  it('unreadCount = 0 → 未读角标隐藏（诚实化，F1 §4.7）', async () => {
    await render(
      <SessionRow
        session={makeSession({ id: 's-1', unreadCount: 0 })}
        preview=""
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );

    expect(screen.queryByTestId('session-unread-badge')).toBeNull();
  });

  it('unreadLabel 99+ 收敛（F1 §5.3 角标上限）', () => {
    expect(unreadLabel(1)).toBe('1');
    expect(unreadLabel(99)).toBe('99');
    expect(unreadLabel(100)).toBe('99+');
    expect(unreadLabel(150)).toBe('99+');
  });

  it('pendingApprovalCount > 0 → 审批角标透传（F2 口径）', async () => {
    await render(
      <SessionRow
        session={makeSession({ id: 's-1', pendingApprovalCount: 2 })}
        preview=""
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );

    expect(screen.getByTestId('approval-badge')).toHaveTextContent('2 待审批');
  });

  it('角标点击 → onOpenApprovals', async () => {
    const onOpenApprovals = jest.fn();
    await render(
      <SessionRow
        session={makeSession({ id: 's-1', pendingApprovalCount: 1 })}
        preview=""
        nowMs={NOW}
        onOpen={jest.fn()}
        onOpenApprovals={onOpenApprovals}
      />
    );

    await fireEvent.press(screen.getByTestId('approval-badge'));
    expect(onOpenApprovals).toHaveBeenCalledTimes(1);
  });
});

describe('SessionRow 点击导航', () => {
  it('行点击 → onOpen(sessionId)（进入会话详情，F5 §4.1）', async () => {
    const onOpen = jest.fn();
    await render(
      <SessionRow
        session={makeSession({ id: 's-1' })}
        preview=""
        nowMs={NOW}
        onOpen={onOpen}
      />
    );

    await fireEvent.press(screen.getByTestId('session-row-s-1'));
    expect(onOpen).toHaveBeenCalledWith('s-1');
  });

  it('角标点击不触发行导航（事件不冒泡到行 Pressable）', async () => {
    const onOpen = jest.fn();
    const onOpenApprovals = jest.fn();
    await render(
      <SessionRow
        session={makeSession({ id: 's-1', pendingApprovalCount: 1 })}
        preview=""
        nowMs={NOW}
        onOpen={onOpen}
        onOpenApprovals={onOpenApprovals}
      />
    );

    await fireEvent.press(screen.getByTestId('approval-badge'));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('SessionRow 流式预览（R2UX-05-02 最小接入）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('previewStreaming=true：预览行尾静态 ▍ 光标', async () => {
    await render(
      <SessionRow
        session={makeSession({ id: 's-1' })}
        preview="正在生成回答"
        previewStreaming
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );
    expect(screen.getByTestId('session-row-preview')).toBeTruthy();
    expect(screen.getByTestId('session-row-preview-streaming')).toBeTruthy();
    expect(
      screen.getByTestId('session-row-preview-streaming').props.children
    ).toBe(' ▍');
  });

  it('previewStreaming=false（缺省）：无光标（原行为不变）', async () => {
    await render(
      <SessionRow
        session={makeSession({ id: 's-1' })}
        preview="普通预览"
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );
    expect(screen.queryByTestId('session-row-preview-streaming')).toBeNull();
    expect(screen.getByTestId('session-row-preview')).toHaveTextContent(
      '普通预览'
    );
  });

  it('流式预览节流：窗口内多帧合并为一次渲染（只跳最新值）', async () => {
    const { rerender } = await render(
      <SessionRow
        session={makeSession({ id: 's-1' })}
        preview="帧1"
        previewStreaming
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );
    await rerender(
      <SessionRow
        session={makeSession({ id: 's-1' })}
        preview="帧2"
        previewStreaming
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );
    await rerender(
      <SessionRow
        session={makeSession({ id: 's-1' })}
        preview="帧3"
        previewStreaming
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );
    // 窗口未到期：仍显示首帧；到期后一次跳到最新（中间帧被合并）
    expect(screen.getByTestId('session-row-preview')).toHaveTextContent(
      '帧1 ▍'
    );
    await act(async () => {
      jest.advanceTimersByTime(18);
    });
    expect(screen.getByTestId('session-row-preview')).toHaveTextContent(
      '帧3 ▍'
    );
    expect(
      screen.getByTestId('session-row-preview').props.children
    ).not.toContain('帧2');
  });

  it('流式结束（previewStreaming 翻 false）：终值立即渲染 + 光标消失（无闪烁）', async () => {
    const { rerender } = await render(
      <SessionRow
        session={makeSession({ id: 's-1' })}
        preview="增量"
        previewStreaming
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );
    await rerender(
      <SessionRow
        session={makeSession({ id: 's-1' })}
        preview="最终消息"
        previewStreaming={false}
        nowMs={NOW}
        onOpen={jest.fn()}
      />
    );
    expect(screen.getByTestId('session-row-preview')).toHaveTextContent(
      '最终消息'
    ); // 同步立即
    expect(screen.queryByTestId('session-row-preview-streaming')).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(screen.getByTestId('session-row-preview')).toHaveTextContent(
      '最终消息'
    ); // 无旧帧回调覆盖
  });
});
