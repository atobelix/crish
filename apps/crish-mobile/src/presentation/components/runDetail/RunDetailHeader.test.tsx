// RunDetailHeader 组件测试（R2-05 部分 6）：
// - 状态徽标渲染：色点 + 文案双通道（M4 §6.5），runId 展示；
// - 元信息：会话名 / 开始·结束时钟 / 用时 / 失败原因行（隐藏规则）；
// - memo 隔离（R2UX-05-08：状态条不参与重渲染）：生产导出为 React.memo 包裹 +
//   renderCount 探针验证浅比较 bailout（相同原始值 props 重渲染不触发渲染本体；
//   属性变化才重渲染）——React 19 Profiler 对 bailout 也提交（实测），故用
//   渲染计数探针断言，确定性强。
import { memo } from 'react';
import { render, screen } from '@testing-library/react-native';
import { formatFeedTime } from '@/presentation/components/blocks/EventRow';
import {
  RunDetailHeader,
  RunDetailHeaderView,
  toneColorOf,
} from './RunDetailHeader';
import type { RunDetailHeaderProps } from './RunDetailHeader';

function makeProps(
  overrides: Partial<RunDetailHeaderProps> = {}
): RunDetailHeaderProps {
  return {
    runId: 'r-1',
    sessionTitle: '会话A',
    badge: 'running',
    badgeLabel: '运行中',
    tone: 'info',
    startedAtMs: 1_720_000_000_000,
    endedAtMs: 1_720_000_061_000,
    durationLabel: '1m 1s',
    formatClock: formatFeedTime,
    ...overrides,
  };
}

describe('RunDetailHeader 渲染', () => {
  it('状态徽标：色点 + 文案 + runId（双通道，M4 §6.5）', async () => {
    await render(<RunDetailHeader {...makeProps()} />);
    expect(screen.getByTestId('run-detail-header')).toBeTruthy();
    expect(screen.getByTestId('run-badge-dot')).toBeTruthy();
    expect(screen.getByTestId('run-badge')).toHaveTextContent('运行中');
    expect(screen.getByTestId('run-badge-run-id')).toHaveTextContent('run r-1');
  });

  it('会话名 + 开始/结束时钟 + 用时', async () => {
    await render(<RunDetailHeader {...makeProps()} />);
    expect(screen.getByTestId('run-detail-session')).toHaveTextContent('会话A');
    expect(screen.getByTestId('run-detail-times')).toHaveTextContent(/开始/);
    expect(screen.getByTestId('run-detail-times')).toHaveTextContent(/结束/);
    expect(screen.getByTestId('run-detail-times')).toHaveTextContent(
      /用时 1m 1s/
    );
  });

  it('失败态：错误文案色点 + 原因行展示（F3 §3.3.3）', async () => {
    await render(
      <RunDetailHeader
        {...makeProps({
          badge: 'error',
          badgeLabel: '失败',
          tone: 'error',
          reason: 'exit code 1',
        })}
      />
    );
    expect(screen.getByTestId('run-badge')).toHaveTextContent('失败');
    expect(screen.getByTestId('run-detail-reason')).toHaveTextContent(
      'exit code 1'
    );
  });

  it('无原因 → 原因行隐藏；进行中无结束时间 → 只显示开始', async () => {
    await render(
      <RunDetailHeader
        {...makeProps({ reason: undefined, endedAtMs: undefined })}
      />
    );
    expect(screen.queryByTestId('run-detail-reason')).toBeNull();
    expect(screen.getByTestId('run-detail-times')).toHaveTextContent(/开始/);
    expect(screen.getByTestId('run-detail-times')).not.toHaveTextContent(
      /结束/
    );
  });
});

describe('toneColorOf（色调 → 主题 token）', () => {
  const theme = {
    colorInfo: '#i',
    colorWarning: '#w',
    colorError: '#e',
    colorSuccess: '#s',
    textTertiary: '#t',
  };
  it('五色调映射（info/warning/error/success/muted）', () => {
    expect(toneColorOf('info', theme)).toBe('#i');
    expect(toneColorOf('warning', theme)).toBe('#w');
    expect(toneColorOf('error', theme)).toBe('#e');
    expect(toneColorOf('success', theme)).toBe('#s');
    expect(toneColorOf('muted', theme)).toBe('#t');
  });
});

describe('memo 隔离（R2UX-05-08：状态条不参与重渲染）', () => {
  it('生产导出为 React.memo 包裹（浅比较拦截存在）', () => {
    expect((RunDetailHeader as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo')
    );
  });

  it('相同原始值 props 重渲染 → 渲染本体零次调用（bailout）；属性变化才重渲染', async () => {
    const renderCount = jest.fn();
    function HeaderProbe(props: RunDetailHeaderProps) {
      renderCount();
      return <RunDetailHeaderView {...props} />;
    }
    const Probe = memo(HeaderProbe);
    const props = makeProps();
    const { rerender } = await render(<Probe {...props} />);
    expect(renderCount).toHaveBeenCalledTimes(1);
    // 相同 props 的父级重渲染 → memo 浅比较命中，渲染本体不被调用
    // （等价断言：时间线滚动/过滤等页面内部状态变化不触发状态条重渲染）
    await rerender(<Probe {...props} />);
    expect(renderCount).toHaveBeenCalledTimes(1);
    // 属性变化（新事件到达 → 徽标/时间更新）→ 重新渲染
    await rerender(
      <Probe {...props} badge="terminal" badgeLabel="已完成" tone="success" />
    );
    expect(renderCount).toHaveBeenCalledTimes(2);
  });
});
