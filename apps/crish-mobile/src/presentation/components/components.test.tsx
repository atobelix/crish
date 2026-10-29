// 业务展示组件测试：抽屉会话行 / 审批卡 / 通知行 / 文件 / 时间线 / 辅助组件。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ApprovalItem } from '@/domain/types/domain';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { SessionListItem } from '@/presentation/components/sessions';
import { ApprovalListItem } from '@/presentation/components/approval/ApprovalListItem';
import {
  ApprovalHistoryRow,
  HISTORY_CHANNEL_TEXT,
  HISTORY_DECISION_TEXT,
  formatHistoryTime,
} from '@/presentation/components/approval/ApprovalHistoryRow';
import ApprovalCard, {
  maskCommandSecrets,
  maskSensitiveParamValue,
  summarizeParameters,
} from '@/presentation/components/blocks/ApprovalCard';
import { NotificationRow } from '@/presentation/components/notifications/NotificationRow';
import { FileRow, rowMetaText } from '@/presentation/components/files/FileRow';
import { FilePreview } from '@/presentation/components/files/FilePreview';
import { browserViewState } from '@/presentation/components/files/FileBrowser';
import { ConnectionBanner } from '@/presentation/components/status/ConnectionBanner';
import { TimelineView } from '@/presentation/timeline/TimelineView';
import { buildSessionTimeline } from '@/presentation/timeline/buildTimeline';
import type { FilePreviewVm } from '@/adapters/viewmodels/useFilePreviewVm';
import type { InAppNotification } from '@/domain/store/notificationReducers';
import { ToastProvider } from '@/presentation/ui';
import type { FeedEntry } from '@/domain/store/eventReducers';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

async function wrap(element: React.ReactElement) {
  currentView = await render(element, {
    wrapper: ({ children }) => (
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>{children}</ToastProvider>
      </SafeAreaProvider>
    ),
  });
  return currentView;
}

let currentView: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  if (currentView) {
    await currentView.unmount();
    currentView = null;
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
});

const NOW = 1_800_000_000_000;

const session: SessionSummary = {
  id: 's-1',
  title: '修复登录页样式',
  folder: '常规会话',
  isPinned: false,
  isArchived: false,
  timestamp: '',
  updatedAt: NOW - 60_000,
  messageCount: 2,
  receivedAtMs: NOW,
  lastReadSequence: 0,
  unreadCount: 3,
  activeRunIds: ['r-1'],
  pendingApprovalCount: 1,
};

const approvalItem: ApprovalItem = {
  request: {
    id: 'pr-1',
    sessionId: 's-1',
    cwd: 'C:/proj',
    toolCallId: 'tc-1',
    toolName: 'write_file',
    parameters: { path: 'src/a.ts', apiKey: 'sk-1234567890' },
    summary: '写入文件',
    toolMetadata: {},
  },
  runId: 'r-1',
  arbiter: 'user',
  dangerLevel: 1,
  riskMeta: { command: 'curl --token abcdef123456 https://x' },
  receivedAtMs: NOW - 20_000,
  expiresAt: NOW + 100_000,
  status: 'pending',
  decisionStatus: 'idle',
  decisionBusy: false,
};

describe('SessionListItem', () => {
  it('纯标题 + 运行 / 待审批状态点，选中态可读', async () => {
    const onPress = jest.fn();
    const view = await wrap(
      <SessionListItem selected session={session} onPress={onPress} />
    );
    expect(view.getByText('修复登录页样式')).toBeTruthy();
    expect(view.getByTestId('session-running')).toBeTruthy();
    expect(view.getByTestId('session-approval-badge')).toBeTruthy();
    expect(view.queryByTestId('session-unread-badge')).toBeNull();
    expect(
      view.getByTestId('session-row-s-1').props.accessibilityState
    ).toEqual({ selected: true });
    fireEvent.press(view.getByTestId('session-row-s-1'));
    expect(onPress).toHaveBeenCalledWith('s-1');
  });
});

describe('Approval components', () => {
  it('列表项展示并回调', async () => {
    const onPress = jest.fn();
    const view = await wrap(
      <ApprovalListItem
        item={approvalItem}
        remainingMs={100_000}
        sessionTitle="修复登录页样式"
        onPress={onPress}
      />
    );
    expect(view.getByText('write_file')).toBeTruthy();
    fireEvent.press(view.getByTestId('approval-row-tc-1'));
    expect(onPress).toHaveBeenCalledWith('tc-1');
  });

  it('详情卡展示风险、参数与倒计时', async () => {
    const view = await wrap(
      <ApprovalCard item={approvalItem} remainingMs={10_000} />
    );
    expect(view.getByText('需确认')).toBeTruthy();
    expect(view.getByText('0:10')).toBeTruthy();
    expect(view.getByText(/curl/)).toBeTruthy();
  });

  it('敏感参数与命令行打码', () => {
    expect(maskSensitiveParamValue('apiKey', 'sk-123456')).toBe('****3456');
    expect(maskSensitiveParamValue('apiKey', 'abc')).toBe('****');
    expect(maskCommandSecrets('curl --token abcdef123456')).toContain('****');
    expect(summarizeParameters({ path: 'a.ts' })).toContain('path=a.ts');
  });

  it('历史行文案与时间', async () => {
    const record = {
      toolCallId: 'tc-1',
      toolName: 'write_file',
      sessionId: 's-1',
      runId: 'r-1',
      decision: 'denied' as const,
      channel: 'mobile' as const,
      reason: '不允许',
      resolvedAtMs: NOW,
    };
    const view = await wrap(<ApprovalHistoryRow record={record} />);
    expect(view.getByText('write_file')).toBeTruthy();
    expect(view.getByText(/不允许/)).toBeTruthy();
    expect(HISTORY_DECISION_TEXT.denied).toBe('已拒绝');
    expect(HISTORY_CHANNEL_TEXT.mobile).toBe('本机');
    expect(formatHistoryTime(NOW)).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('NotificationRow', () => {
  it('展示并响应点击', async () => {
    const item: InAppNotification = {
      id: 'n-1',
      kind: 'approval-requested',
      title: '需要确认',
      body: '修改文件',
      route: 'crish://approval/tc-1',
      toolCallId: 'tc-1',
      runId: 'r-1',
      seq: 1,
      status: 'shown',
      receivedAt: NOW,
    };
    const onPress = jest.fn();
    const view = await wrap(<NotificationRow item={item} onPress={onPress} />);
    expect(view.getByText('需要确认')).toBeTruthy();
    fireEvent.press(view.getByTestId('notification-row-n-1'));
    expect(onPress).toHaveBeenCalledWith(item);
  });
});

describe('File components', () => {
  it('行 meta / 点击 / 敏感标记', async () => {
    const onPress = jest.fn();
    const file = {
      name: 'a.ts',
      relPath: 'src/a.ts',
      isDir: false,
      size: 2048,
      modified: String(NOW - 60_000),
      receivedAtMs: NOW,
    };
    const view = await wrap(<FileRow entry={file} onPress={onPress} />);
    expect(view.getByText('a.ts')).toBeTruthy();
    expect(rowMetaText(file, NOW)).toContain('2 KB');
    fireEvent.press(view.getByTestId('file-row'));
    expect(onPress).toHaveBeenCalledWith(file);
  });

  it('目录行显示 chevron 与空 meta', async () => {
    const dir = { name: 'src', relPath: 'src', isDir: true, receivedAtMs: NOW };
    const view = await wrap(<FileRow entry={dir} onPress={jest.fn()} />);
    expect(view.getByTestId('file-row-dir')).toBeTruthy();
    expect(rowMetaText(dir, NOW)).toBe('');
  });

  it('浏览态判定', () => {
    expect(browserViewState(false, null, 'idle', 0)).toBe('disconnected');
    expect(browserViewState(true, 'file.not_found', 'loaded', 0)).toBe('error');
    expect(browserViewState(true, null, 'loading', 0)).toBe('loading');
    expect(browserViewState(true, null, 'loaded', 0)).toBe('empty');
    expect(browserViewState(true, null, 'loaded', 2)).toBe('list');
  });

  it('预览文本 / 过大 / 错误 / 续读', async () => {
    const base = {
      file: { name: 'a.ts', relPath: 'src/a.ts', isDir: false },
      lineCount: 2,
      truncated: false,
      sensitive: false,
      lineBudget: 400,
      atCap: false,
      loadMore: jest.fn(),
      retry: jest.fn(),
    } as unknown as FilePreviewVm;
    const loaded = await wrap(
      <FilePreview
        vm={{ ...base, status: 'loaded', content: 'a\nb' }}
        onBack={jest.fn()}
      />
    );
    expect(loaded.getAllByTestId('preview-line').length).toBeGreaterThan(0);

    const tooLarge = await wrap(
      <FilePreview
        vm={{ ...base, status: 'too-large', content: '', errorCode: null }}
        onBack={jest.fn()}
      />
    );
    expect(tooLarge.getByText('文件过大，无法预览')).toBeTruthy();

    const error = await wrap(
      <FilePreview
        vm={{
          ...base,
          status: 'error',
          content: '',
          errorCode: 'file.not_found',
        }}
        onBack={jest.fn()}
      />
    );
    expect(error.getByText('文件或目录不存在')).toBeTruthy();
  });
});

describe('ConnectionBanner / TimelineView', () => {
  it('连接横幅重试', async () => {
    const onRetry = jest.fn();
    const view = await wrap(
      <ConnectionBanner phaseLabel="未连接" onRetry={onRetry} />
    );
    expect(view.getByText('未连接')).toBeTruthy();
    fireEvent.press(view.getByLabelText('重新连接'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('时间线渲染消息 / 工具 / 审批 / 提示，并支持展开与跳转', async () => {
    const frames: FeedEntry[] = [
      {
        type: 'message-end',
        sessionId: 's-1',
        sequence: 1,
        message: {
          id: 'm-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: '正文' }],
        },
        receivedAtMs: NOW,
      },
      {
        type: 'tool-start',
        sessionId: 's-1',
        sequence: 2,
        call: { id: 't-1', toolName: 'read_file', summary: 'src/a.ts' },
        receivedAtMs: NOW + 1,
      },
      {
        type: 'tool-end',
        sessionId: 's-1',
        sequence: 3,
        toolCallId: 't-1',
        result: { output: 'done' },
        receivedAtMs: NOW + 2,
      },
      {
        type: 'approval-requested',
        sessionId: 's-1',
        sequence: 4,
        toolCallId: 'tc-1',
        toolName: 'write_file',
        summary: '写入',
        receivedAtMs: NOW + 3,
      },
      {
        type: 'run-terminal',
        sessionId: 's-1',
        sequence: 5,
        terminal: 'completed',
        receivedAtMs: NOW + 4,
      },
    ];
    const blocks = buildSessionTimeline(frames);
    const onOpenTools = jest.fn();
    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow={false}
        onFollowChange={jest.fn()}
        onOpenTools={onOpenTools}
      />
    );
    expect(view.getByText('正文')).toBeTruthy();
    // 连续工具调用在对话里只剩一行摘要，详情进工具抽屉
    expect(view.getByText('使用了 1 个工具')).toBeTruthy();
    expect(view.queryByText('done')).toBeNull();
    await fireEvent.press(view.getByTestId('tool-run-t-1'));
    expect(onOpenTools).toHaveBeenCalledWith('t-1');
    // 审批在对话里只剩一行状态，不再可点
    expect(view.getByText('等待你审批 · write_file')).toBeTruthy();
    expect(view.getByText('运行完成')).toBeTruthy();
  });
});
