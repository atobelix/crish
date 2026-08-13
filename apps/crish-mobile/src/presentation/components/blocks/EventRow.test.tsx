// EventRow 单测（F3 §3.3 渲染面 + 纯函数面）：
// - 纯函数：eventKindLabel 全部分组 / clipSummary 截断 / summarizeEventFrame 各事件摘要
//   （含宽容缺省、流式类型、错误态）/ formatFeedTime 本地时间；
// - 组件冒烟：正常行 / 错误高亮行 / 流式光标行（memo 组件渲染路径）。
import { render, screen } from '@testing-library/react-native';
import type { FeedEntry } from '@/domain/store/eventReducers';
import {
  EventRow,
  clipSummary,
  eventKindLabel,
  formatFeedTime,
  summarizeEventFrame,
} from './EventRow';

function makeEntry(
  type: string,
  overrides: Partial<FeedEntry> = {}
): FeedEntry {
  return {
    type,
    sessionId: 's-1',
    sequence: 1,
    receivedAtMs: 1_700_000_000_000,
    ...overrides,
  } as FeedEntry;
}

describe('eventKindLabel（F3 §6.3 短标签）', () => {
  it('各类型分组映射', () => {
    expect(eventKindLabel(makeEntry('agent-start'))).toBe('代理');
    expect(eventKindLabel(makeEntry('run-terminal'))).toBe('结束');
    expect(eventKindLabel(makeEntry('message-delta'))).toBe('消息');
    expect(eventKindLabel(makeEntry('tool-start'))).toBe('工具');
    expect(eventKindLabel(makeEntry('approval-requested'))).toBe('审批');
    expect(eventKindLabel(makeEntry('runtime-error'))).toBe('错误');
    expect(eventKindLabel(makeEntry('task-started'))).toBe('任务');
    expect(eventKindLabel(makeEntry('security-audit'))).toBe('审计');
    expect(eventKindLabel(makeEntry('context-compression-start'))).toBe('压缩');
    expect(eventKindLabel(makeEntry('cache-stats-updated'))).toBe('缓存');
    expect(eventKindLabel(makeEntry('timer-fired'))).toBe('定时');
  });

  it('未知 type 原样展示保真（F1 §4.3 不丢不猜）', () => {
    expect(eventKindLabel(makeEntry('mystery-event'))).toBe('mystery-event');
  });
});

describe('clipSummary（F3 §3.4.2 折叠预览）', () => {
  it('短文本原样返回（空白折叠）', () => {
    expect(clipSummary('  你好    世界  ')).toBe('你好 世界');
  });

  it('超长截断 + 省略号（60 字符上限）', () => {
    const long = 'x'.repeat(80);
    const clipped = clipSummary(long);
    expect(clipped).toHaveLength(60);
    expect(clipped.endsWith('…')).toBe(true);
  });
});

describe('summarizeEventFrame（F3 §6.3 人话摘要）', () => {
  it('run 归属附注：agent-start / run-terminal 携带 runId', () => {
    expect(
      summarizeEventFrame(makeEntry('agent-start', { runId: 'r-1' }))
    ).toBe('Agent 开始执行（run r-1）');
    expect(
      summarizeEventFrame(makeEntry('run-terminal', { terminal: 'ok' }))
    ).toBe('run 结束（ok）');
    expect(summarizeEventFrame(makeEntry('run-terminal', {}))).toBe(
      'run 结束（unknown）'
    );
  });

  it('工具类：tool-start / tool-update（两级读取）/ tool-end 成败', () => {
    expect(
      summarizeEventFrame(makeEntry('tool-start', { toolName: 'bash' }))
    ).toBe('工具 bash 启动');
    expect(
      summarizeEventFrame(
        makeEntry('tool-update', { update: { text: '输出中…' } })
      )
    ).toBe('工具输出：输出中…');
    expect(
      summarizeEventFrame(
        makeEntry('tool-end', { toolName: 'bash', result: { isError: true } })
      )
    ).toBe('工具 bash 失败');
    expect(
      summarizeEventFrame(makeEntry('tool-end', { toolName: 'bash' }))
    ).toBe('工具 bash 完成');
  });

  it('审批类：approval-requested 带摘要/缺省 + approval-resolved 决策', () => {
    expect(
      summarizeEventFrame(
        makeEntry('approval-requested', {
          toolName: 'write_file',
          summary: '写 a.ts',
        })
      )
    ).toBe('需要确认：write_file（写 a.ts）');
    expect(
      summarizeEventFrame(makeEntry('approval-requested', { toolName: 'bash' }))
    ).toBe('需要确认：bash');
    expect(
      summarizeEventFrame(
        makeEntry('approval-resolved', { decision: 'approved' })
      )
    ).toBe('审批已处理（approved）');
    expect(summarizeEventFrame(makeEntry('approval-resolved', {}))).toBe(
      '审批已处理（unknown）'
    );
  });

  it('错误/介入/任务类', () => {
    expect(
      summarizeEventFrame(makeEntry('runtime-error', { error: 'EACCES' }))
    ).toBe('运行错误：EACCES');
    expect(
      summarizeEventFrame(
        makeEntry('runtime-intervention-required', { reason: '危险命令' })
      )
    ).toBe('需要人工介入：危险命令');
    expect(summarizeEventFrame(makeEntry('task-failed', { exitCode: 2 }))).toBe(
      '任务失败（exit 2）'
    );
    expect(summarizeEventFrame(makeEntry('task-failed', {}))).toBe(
      '任务失败（exit ?）'
    );
    expect(
      summarizeEventFrame(makeEntry('task-killed', { viaForce: true }))
    ).toBe('任务已终止（强制）');
  });

  it('缓存/压缩/定时/cron 与上下文类', () => {
    expect(
      summarizeEventFrame(
        makeEntry('context-compression-end', { status: 'error' })
      )
    ).toBe('上下文压缩失败');
    expect(summarizeEventFrame(makeEntry('context-compression-end', {}))).toBe(
      '上下文压缩完成'
    );
    expect(
      summarizeEventFrame(makeEntry('cache-stats-updated', { hitRatio: 0.85 }))
    ).toBe('缓存统计更新（命中 85%）');
    expect(summarizeEventFrame(makeEntry('cache-stats-updated', {}))).toBe(
      '缓存统计更新'
    );
    expect(
      summarizeEventFrame(makeEntry('timer-fired', { prompt: '检查状态' }))
    ).toBe('定时器到期：检查状态');
    expect(
      summarizeEventFrame(
        makeEntry('cron-fired', { fireCount: 3, prompt: '备份' })
      )
    ).toBe('cron 第 3 次触发：备份');
  });

  it('turn / subagent / 消息流 / 未知兜底', () => {
    expect(summarizeEventFrame(makeEntry('turn-start', { turnIndex: 2 }))).toBe(
      '第 2 轮开始'
    );
    expect(
      summarizeEventFrame(
        makeEntry('turn-end', { turnIndex: 1, toolCallCount: 3 })
      )
    ).toBe('第 1 轮结束（3 次工具调用）');
    expect(
      summarizeEventFrame(
        makeEntry('subagent-started', { description: '审计' })
      )
    ).toBe('协作子任务启动：审计');
    expect(summarizeEventFrame(makeEntry('message-end', {}))).toBe('消息完成');
    expect(summarizeEventFrame(makeEntry('unknown-thing', {}))).toBe(
      '事件 unknown-thing'
    );
  });
});

describe('formatFeedTime（F1 §4.3 时间线行形态）', () => {
  it('格式化为 HH:mm:ss 补零', () => {
    const d = new Date(1_700_000_000_000);
    const expectStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    expect(formatFeedTime(1_700_000_000_000)).toBe(expectStr);
  });
});

describe('EventRow 组件冒烟', () => {
  it('渲染正常事件行（时间/标签/摘要）', async () => {
    await render(
      <EventRow entry={makeEntry('tool-start', { toolName: 'bash' })} />
    );
    expect(screen.getByTestId('event-row')).toBeTruthy();
    expect(screen.getByText('工具')).toBeTruthy();
    expect(screen.getByText('工具 bash 启动')).toBeTruthy();
  });

  it('错误事件行高亮（deriveErrorLevel：runtime-error → event-row-error）', async () => {
    await render(<EventRow entry={makeEntry('runtime-error')} />);
    expect(screen.getByTestId('event-row-error')).toBeTruthy();
  });

  it('流式增量类型行尾静态光标（message-delta → ▍）', async () => {
    await render(
      <EventRow entry={makeEntry('message-delta', { text: '增量' })} />
    );
    expect(screen.getByTestId('event-row-streaming')).toBeTruthy();
  });

  it('非流式类型无光标', async () => {
    await render(<EventRow entry={makeEntry('message-end')} />);
    expect(screen.queryByTestId('event-row-streaming')).toBeNull();
  });
});
