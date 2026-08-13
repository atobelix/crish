// EventFeed 单测（R2UX-05-01/05-06 事件流 feed）：
// - deriveFilteredFeed 纯函数：三维过滤组合（错误/当前 run/工具白名单）、
//   错误计数徽标数据面、「只看当前 run 但无 run → 空态」分支；
// - 组件冒烟：过滤条渲染 / 空态文案 / 条目渲染 / 过滤 chip 交互回调。
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { FeedEntry } from '@/domain/store/eventReducers';
import {
  EventFeed,
  deriveFilteredFeed,
  AUTO_FOLLOW_THRESHOLD_DP,
} from './EventFeed';

function makeEntry(
  type: string,
  overrides: Partial<FeedEntry> = {}
): FeedEntry {
  return {
    type,
    sessionId: 's-1',
    sequence: 1,
    receivedAtMs: 1000,
    ...overrides,
  } as FeedEntry;
}

const NO_FILTER = {
  errorsOnly: false,
  runOnly: false,
  toolOnly: false,
  currentRunId: null,
};

describe('deriveFilteredFeed（R2UX-05-06 过滤数据面）', () => {
  it('无过滤：原序返回 + 错误计数', () => {
    const entries = [
      makeEntry('message-end', { sequence: 1 }),
      makeEntry('runtime-error', { sequence: 2 }),
      makeEntry('tool-start', { sequence: 3 }),
    ];
    const { filtered, errorCount } = deriveFilteredFeed(entries, NO_FILTER);
    expect(filtered).toHaveLength(3);
    expect(errorCount).toBe(1);
  });

  it('只看错误：仅错误级条目', () => {
    const entries = [
      makeEntry('message-end', { sequence: 1 }),
      makeEntry('runtime-error', { sequence: 2 }),
      makeEntry('tool-end', { sequence: 3, result: { isError: true } }),
    ];
    const { filtered } = deriveFilteredFeed(entries, {
      ...NO_FILTER,
      errorsOnly: true,
    });
    expect(filtered.map((e) => e.type)).toEqual(['runtime-error', 'tool-end']);
  });

  it('只看当前 run：按 runId 归属过滤（F3 分组规则 4）', () => {
    const entries = [
      makeEntry('message-end', { sequence: 1, runId: 'r-1' }),
      makeEntry('message-end', { sequence: 2, runId: 'r-2' }),
      makeEntry('message-end', { sequence: 3 }),
    ];
    const { filtered } = deriveFilteredFeed(entries, {
      ...NO_FILTER,
      runOnly: true,
      currentRunId: 'r-1',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.sequence).toBe(1);
  });

  it('只看当前 run 但无 run 对象 → 空结果（F3 §5.1 空态）', () => {
    const entries = [makeEntry('message-end', { sequence: 1 })];
    const { filtered, errorCount } = deriveFilteredFeed(entries, {
      ...NO_FILTER,
      runOnly: true,
      currentRunId: null,
    });
    expect(filtered).toEqual([]);
    expect(errorCount).toBe(0);
  });

  it('只看工具：TOOL_KIND_WHITELIST 白名单 kind', () => {
    const entries = [
      makeEntry('tool-start', { sequence: 1 }),
      makeEntry('message-end', { sequence: 2 }),
      makeEntry('security-audit', { sequence: 3 }),
      makeEntry('approval-requested', { sequence: 4 }),
    ];
    const { filtered } = deriveFilteredFeed(entries, {
      ...NO_FILTER,
      toolOnly: true,
    });
    expect(filtered.map((e) => e.type)).toEqual([
      'tool-start',
      'security-audit',
      'approval-requested',
    ]);
  });

  it('三维过滤可组合（错误 + 当前 run + 工具交集）', () => {
    const entries = [
      makeEntry('runtime-error', { sequence: 1, runId: 'r-1' }),
      makeEntry('tool-end', {
        sequence: 2,
        runId: 'r-1',
        result: { isError: true },
      }),
      makeEntry('message-end', { sequence: 3, runId: 'r-1' }),
    ];
    const { filtered } = deriveFilteredFeed(entries, {
      errorsOnly: true,
      runOnly: true,
      toolOnly: true,
      currentRunId: 'r-1',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.type).toBe('tool-end');
  });
});

describe('EventFeed 组件冒烟', () => {
  const baseProps = {
    entries: [],
    errorsOnly: false,
    runOnly: false,
    toolOnly: false,
    currentRunId: null,
    onToggleErrors: jest.fn(),
    onToggleRun: jest.fn(),
    onToggleTool: jest.fn(),
  };

  it('空态渲染（禁「0 误导」诚实化，F1 §4.7）', async () => {
    await render(<EventFeed {...baseProps} />);
    expect(screen.getByTestId('feed-empty')).toBeTruthy();
    expect(screen.getByText('暂无事件')).toBeTruthy();
  });

  it('条目渲染（FlatList data → EventRow）', async () => {
    await render(
      <EventFeed
        {...baseProps}
        entries={[makeEntry('tool-start', { toolName: 'bash' })]}
      />
    );
    expect(screen.getByText('工具 bash 启动')).toBeTruthy();
  });

  it('过滤 chip 交互：点击触发回调；错误计数徽标文案（F3 §3.3.3）', async () => {
    const onToggleErrors = jest.fn();
    await render(
      <EventFeed
        {...baseProps}
        entries={[makeEntry('runtime-error', { sequence: 1 })]}
        onToggleErrors={onToggleErrors}
      />
    );
    expect(screen.getByText('只看错误 (1)')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('feed-filter-errors'));
    expect(onToggleErrors).toHaveBeenCalledTimes(1);
  });

  it('只看当前 run 但无 run → 空态文案「当前无 run」（F3 §5.1）', async () => {
    await render(<EventFeed {...baseProps} runOnly currentRunId={null} />);
    expect(screen.getByText('当前无 run')).toBeTruthy();
  });
});

describe('AUTO_FOLLOW_THRESHOLD_DP（R2UX-05-03 吸底阈值）', () => {
  it('阈值常量 = 40dp（上翻超阈值暂停跟随）', () => {
    expect(AUTO_FOLLOW_THRESHOLD_DP).toBe(40);
  });
});
