// run 详情页组件测试（R2-05 部分 6 验收）：
// - 空态（run 不存在）：占位「该 run 暂无事件」+ 无控制区 + 无终端入口（F1 §4.7）；
// - 状态派生（F1 §5.1 × 事件流）：agent-start → 运行中；run-terminal failed →
//   失败 + reason；completed → 已完成；终态无控制按钮（TerminalImmutable）；
// - 元信息：会话标题（sessionStore 兜底）+ 开始/结束时间 + 用时；
// - 控制区接线：running → 暂停/取消按钮渲染；点取消 → 二次确认弹窗 → 确认
//   后发送（经 VM → 接线上下文仓库）；busy 防双点禁用；
// - 终端入口：点击 → onOpenTerminal（路由注入）；返回 → onBack；
// - 时间线：run 事件经 RunDetailTimeline → EventFeed 渲染。
import { FlatList } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { FeedEntry, EventWindow } from '@/domain/store/eventReducers';
import { eventStore } from '@/domain/store/eventStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { WsGateway } from '@/network/WsGateway';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import type { WsSocket } from '@/network/ReconnectingWsClient';
import { authStore } from '@/domain/store/authStore';
import {
  resetObservationWiringForTest,
  ensureObservationWiring,
} from '@/adapters/wiring/observationWiring';
import { resetRunControlContextForTest } from '@/adapters/runControlWiring';
import RunDetailScreen from './runDetailScreen';

function makeEntry(
  type: string,
  runId: string,
  sequence: number,
  overrides: Record<string, unknown> = {},
  receivedAtMs = 1_000 + sequence
): FeedEntry {
  return {
    type,
    sessionId: 's-1',
    runId,
    sequence,
    receivedAtMs,
    ...overrides,
  } as FeedEntry;
}

function windowOf(entries: FeedEntry[], lastSeq = entries.length): EventWindow {
  return { entries, lastSeq, truncatedCount: 0 };
}

/** mock socket（观测接线工厂注入面，避免 jest 环境真实 WS） */
function mockSocketFactory(): WsSocket {
  return {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => {},
    close: () => {},
  };
}

/** 接线装配（VM 经单例取仓库；gateway 捕获 send，不回帧） */
function installWiring(): { sent: string[] } {
  const sent: string[] = [];
  authStore.setState({ host: '192.168.1.100', pairState: 'paired' });
  resetRunControlContextForTest();
  resetObservationWiringForTest();
  ensureObservationWiring({
    gateway: new WsGateway({ send: (raw) => sent.push(raw) }),
    factory: mockSocketFactory,
  });
  return { sent };
}

beforeEach(() => {
  eventStore.setState({ windows: {}, network: 'live' });
  connectionStore.setState({ phase: 'disconnected' });
  sessionStore.setState({ sessions: [] });
  resetRunControlContextForTest();
  resetObservationWiringForTest();
});

describe('空态（F1 §4.7：run 不存在 / 事件未同步）', () => {
  it('无任何事件 → 占位空态 + 无控制区 + 无终端入口（诚实化不伪造数据）', async () => {
    await render(<RunDetailScreen runId="r-ghost" />);
    expect(screen.getByTestId('run-detail-empty')).toBeTruthy();
    expect(screen.getByText('该 run 暂无事件')).toBeTruthy();
    expect(
      screen.getByText('run 可能不存在或事件尚未同步（F1 §4.7）')
    ).toBeTruthy();
    // 徽标诚实化：无事件 → 状态未知
    expect(screen.getByTestId('run-badge')).toHaveTextContent('状态未知');
    expect(screen.queryByTestId('run-control-pause')).toBeNull();
    expect(screen.queryByTestId('run-control-cancel')).toBeNull();
    expect(screen.queryByTestId('run-detail-open-terminal')).toBeNull();
    expect(screen.queryByTestId('event-feed-list')).toBeNull();
  });
});

describe('状态派生与元信息头（F1 §5.1 × 事件流）', () => {
  it('agent-start → 徽标「运行中」+ 会话标题 + 开始时间 + 控制区（暂停/取消）', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      sessionStore.setState({
        sessions: [
          {
            id: 's-1',
            title: '检查 package.json',
            updatedAt: 1000,
            pendingApprovalCount: 0,
            activeRunIds: ['r-1'],
            lastReadSequence: 0,
            unreadCount: 0,
            receivedAtMs: 1000,
          },
        ],
      });
      eventStore.setState({
        windows: {
          's-1': windowOf([
            makeEntry('agent-start', 'r-1', 1),
            makeEntry('tool-start', 'r-1', 2, { toolName: 'bash' }),
          ]),
        },
      });
      await render(<RunDetailScreen runId="r-1" onOpenTerminal={jest.fn()} />);
      expect(screen.getByTestId('run-badge')).toHaveTextContent('运行中');
      expect(screen.getByTestId('run-detail-session')).toHaveTextContent(
        '检查 package.json'
      );
      expect(screen.getByTestId('run-detail-times')).toHaveTextContent(/开始/);
      expect(screen.getByTestId('run-control-pause')).toBeTruthy();
      expect(screen.getByTestId('run-control-cancel')).toBeTruthy();
      expect(screen.getByTestId('run-detail-open-terminal')).toBeTruthy();
      // 时间线经 EventFeed 渲染（EventRow 摘要）
      expect(screen.getByText('工具 bash 启动（run r-1）')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('会话标题缺省 → id 兜底', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      eventStore.setState({
        windows: { 's-1': windowOf([makeEntry('agent-start', 'r-1', 1)]) },
      });
      await render(<RunDetailScreen runId="r-1" />);
      expect(screen.getByTestId('run-detail-session')).toHaveTextContent('s-1');
    } finally {
      spy.mockRestore();
    }
  });

  it('run-terminal failed → 徽标「失败」+ reason 红色行 + 终态无控制按钮', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      eventStore.setState({
        windows: {
          's-1': windowOf([
            makeEntry('agent-start', 'r-1', 1),
            makeEntry('run-terminal', 'r-1', 2, {
              terminal: 'failed',
              error: 'exit code 1',
            }),
          ]),
        },
      });
      await render(<RunDetailScreen runId="r-1" />);
      expect(screen.getByTestId('run-badge')).toHaveTextContent('失败');
      expect(screen.getByTestId('run-detail-reason')).toHaveTextContent(
        'exit code 1'
      );
      // 终态拒绝（TerminalImmutable）：无控制按钮
      expect(screen.queryByTestId('run-control-pause')).toBeNull();
      expect(screen.queryByTestId('run-control-cancel')).toBeNull();
      // 终态时间线：结束时间 + 用时
      expect(screen.getByTestId('run-detail-times')).toHaveTextContent(/结束/);
    } finally {
      spy.mockRestore();
    }
  });

  it('run-terminal completed → 徽标「已完成」（取消态由单测覆盖）', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      eventStore.setState({
        windows: {
          's-1': windowOf([
            makeEntry('agent-start', 'r-1', 1),
            makeEntry('run-terminal', 'r-1', 2, { terminal: 'completed' }),
          ]),
        },
      });
      await render(<RunDetailScreen runId="r-1" />);
      expect(screen.getByTestId('run-badge')).toHaveTextContent('已完成');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('控制区接线（发送 / 二次确认 / 防双点）', () => {
  it('点取消 → 二次确认弹窗 → 确认后发送 force_cancel（经接线仓库）', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      const { sent } = installWiring();
      connectionStore.setState({ phase: 'ready' });
      eventStore.setState({
        windows: {
          's-1': windowOf([
            makeEntry('agent-start', 'r-1', 1),
            makeEntry('tool-start', 'r-1', 2, { toolName: 'bash' }),
          ]),
        },
      });
      await render(<RunDetailScreen runId="r-1" />);
      await fireEvent.press(screen.getByTestId('run-control-cancel'));
      expect(screen.getByTestId('run-control-confirm-dialog')).toBeTruthy();
      expect(sent).toHaveLength(0);
      await fireEvent.press(screen.getByTestId('run-control-confirm-ok'));
      // 发送帧在微任务面（WsGateway.invoke 异步），tick 后断言
      await new Promise((r) => setTimeout(r, 0));
      expect(sent).toHaveLength(1);
      const frame = JSON.parse(sent[0]!) as {
        kind: string;
        body: { command: string; params: Record<string, unknown> };
      };
      expect(frame.kind).toBe('remote.runControl');
      expect(frame.body.command).toBe('runControl');
      expect(frame.body.params).toEqual({
        level: 'force_cancel',
        runId: 'r-1',
        sessionId: 's-1',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('未连接 → 控制区禁用提示（诚实化）', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      eventStore.setState({
        windows: {
          's-1': windowOf([
            makeEntry('agent-start', 'r-1', 1),
            makeEntry('tool-start', 'r-1', 2, { toolName: 'bash' }),
          ]),
        },
      });
      await render(<RunDetailScreen runId="r-1" />);
      expect(screen.getByTestId('run-control-disconnected')).toBeTruthy();
      expect(screen.getByText('未连接，无法控制 run')).toBeTruthy();
      expect(screen.getByTestId('run-control-pause')).toBeDisabled();
      expect(screen.getByTestId('run-control-cancel')).toBeDisabled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('导航回调（路由注入）', () => {
  it('返回 → onBack；终端入口 → onOpenTerminal', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      const onBack = jest.fn();
      const onOpenTerminal = jest.fn();
      eventStore.setState({
        windows: {
          's-1': windowOf([
            makeEntry('agent-start', 'r-1', 1),
            makeEntry('tool-start', 'r-1', 2, { toolName: 'bash' }),
          ]),
        },
      });
      await render(
        <RunDetailScreen
          runId="r-1"
          onBack={onBack}
          onOpenTerminal={onOpenTerminal}
        />
      );
      await fireEvent.press(screen.getByTestId('run-detail-back'));
      expect(onBack).toHaveBeenCalledTimes(1);
      await fireEvent.press(screen.getByTestId('run-detail-open-terminal'));
      expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('空 run 错误码反馈（M6 §11.3 映射透传）', () => {
  it('暂停失败（cmd.not_found）→ 反馈行展示映射文案', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      const { sent } = installWiring();
      connectionStore.setState({ phase: 'ready' });
      eventStore.setState({
        windows: {
          's-1': windowOf([
            makeEntry('agent-start', 'r-1', 1),
            makeEntry('tool-start', 'r-1', 2, { toolName: 'bash' }),
          ]),
        },
      });
      await render(<RunDetailScreen runId="r-1" />);
      await fireEvent.press(screen.getByTestId('run-control-pause'));
      // 发送帧在微任务面（WsGateway.invoke 异步），tick 后取帧
      await new Promise((r) => setTimeout(r, 0));
      // 回错误帧：cmd.not_found（run 已结束/不存在）
      const req = JSON.parse(sent[0]!) as { msgId: string };
      const gateway = (
        ensureObservationWiring() as {
          client: { gateway: WsGateway };
        }
      ).client.gateway;
      gateway.dispatchFrame({
        v: 1,
        kind: 'error',
        msgId: 'err-1',
        ts: 1_800_000_000_000,
        from: 'desktop',
        to: 'mobile',
        body: {
          reqMsgId: req.msgId,
          code: 'cmd.not_found',
          message: 'nf',
          retryable: false,
        },
      } as InboundEnvelope);
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByTestId('run-control-feedback')).toHaveTextContent(
        'run 不存在或已结束'
      );
    } finally {
      spy.mockRestore();
    }
  });
});
