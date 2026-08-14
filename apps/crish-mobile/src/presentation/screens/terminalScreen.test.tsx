// 终端只读页组件测试（R2-05 部分 3 验收：ANSI 解析渲染 / 环形裁剪 / 白名单拒绝 + run 状态条）
// - 真实 eventStore 接线：跨会话窗口按 runId 过滤（entriesOfRun）→ 行缓冲（ANSI 白名单剥离
//   在缓冲层，R2UX-05-07）→ TerminalView 渲染；
// - ANSI 解析渲染：tool-update tool-progress 文本的 SGR 序列剥离后按纯文本行渲染；
// - 白名单拒绝非法序列：私有模式 ?xx / 清屏 / 光标序列不残留（防注入：转义不透传到渲染面）；
// - 环形裁剪端到端：11 会话 × 500 行 = 5500 行 → 5000 行环形丢最旧 500 行 + 「已截断」标记；
// - run 状态条（F1 §4.3）：agent-start → 运行中 / run-terminal failed → 失败 + error 摘要；
// - 空态（M4 §5.9）：无终端行 → 主文案 + 副文案。
// 注：@testing-library/react-native v14 render/fireEvent 为异步 API，全部 await
import { FlatList } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import type { FeedEntry, EventWindow } from '@/domain/store/eventReducers';
import { eventStore } from '@/domain/store/eventStore';
import { terminalStore } from '@/domain/store/terminalStore';
import TerminalScreen from './terminalScreen';

function makeEntry(
  type: string,
  runId: string,
  overrides: Record<string, unknown> = {},
  receivedAtMs = 1_000
): FeedEntry {
  return {
    type,
    sessionId: 's-1',
    runId,
    receivedAtMs,
    ...overrides,
  } as FeedEntry;
}

function windowOf(entries: FeedEntry[], lastSeq = entries.length): EventWindow {
  return { entries, lastSeq, truncatedCount: 0 };
}

function toolUpdate(text: string, runId = 'run-1'): FeedEntry {
  return makeEntry('tool-update', runId, {
    update: { text, metadata: { kind: 'tool-progress' } },
  });
}

// 转义字符探测（防注入断言）：RegExp 构造器形态避免 no-control-regex（与 ansi.ts 同款）
const ESC_RE = new RegExp(String.fromCharCode(27));

beforeEach(() => {
  eventStore.setState({ windows: {}, network: 'live' });
  terminalStore.setState({ runs: {} });
});

describe('终端页 ANSI 解析渲染（R2UX-05-07 白名单剥离后渲染）', () => {
  it('SGR 颜色序列剥离：行内只渲染纯文本', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      eventStore.setState({
        windows: {
          's-1': windowOf([
            toolUpdate('\x1b[32mgreen\x1b[0m\n'),
            toolUpdate('\x1b[1;31m红色错误\x1b[0m\n'),
          ]),
        },
      });
      await render(<TerminalScreen runId="run-1" />);

      expect(screen.getByText('green')).toBeTruthy();
      expect(screen.getByText('红色错误')).toBeTruthy();
      // 转义字符不得透传到渲染面（防注入）
      expect(screen.queryByText(ESC_RE)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('白名单拒绝非法序列：私有模式/清屏/光标剥离且文本拼接正确', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      eventStore.setState({
        windows: {
          's-1': windowOf([toolUpdate('a\x1b[?25l\x1b[2J\x1b[Hb\x1b[0mc\n')]),
        },
      });
      await render(<TerminalScreen runId="run-1" />);

      expect(screen.getByText('abc')).toBeTruthy();
      expect(screen.queryByText(ESC_RE)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('终端页环形裁剪（R2UX-05-07：5000 行环形端到端）', () => {
  it('5500 行（11 会话 × 500）→ 丢最旧 500 行 + 「已截断 500 行」标记', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      const windows: Record<string, EventWindow> = {};
      let globalIndex = 0;
      for (let s = 0; s < 11; s += 1) {
        const entries: FeedEntry[] = [];
        for (let j = 0; j < 500; j += 1) {
          // task-output 行必须以 \n 终结才会作为独立行提交（F3 §4.0 行切分语义）；
          // sequence 全量唯一且单调递增：stableSortBySeq 保持插入序（跨会话同 seq
          // 会交错排序，破坏全局行序）
          entries.push({
            type: 'task-output',
            sessionId: `s-${s}`,
            runId: 'run-1',
            sequence: globalIndex + 1,
            line: `行${globalIndex}\n`,
            receivedAtMs: globalIndex,
          });
          globalIndex += 1;
        }
        windows[`s-${s}`] = windowOf(entries);
      }
      eventStore.setState({ windows });

      await render(<TerminalScreen runId="run-1" />);

      // 环形保留的最新 5000 行：首行为 行500（行0..499 被淘汰）
      expect(
        screen.getByText('已截断 500 行早期输出（环形缓冲上限）')
      ).toBeTruthy();
      expect(screen.getByText('行500')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('终端页 run 状态条（F1 §4.3）', () => {
  it('agent-start → 运行中', async () => {
    eventStore.setState({
      windows: {
        's-1': windowOf([makeEntry('agent-start', 'run-1', {}, 5_000)]),
      },
    });
    await render(<TerminalScreen runId="run-1" />);

    expect(screen.getByTestId('terminal-status')).toHaveTextContent('运行中');
    expect(screen.getByText('run run-1')).toBeTruthy();
  });

  it('run-terminal failed → 失败 + error 摘要（F3 §3.3.3）', async () => {
    eventStore.setState({
      windows: {
        's-1': windowOf([
          makeEntry('agent-start', 'run-1', {}, 5_000),
          makeEntry(
            'run-terminal',
            'run-1',
            { terminal: 'failed', error: 'exit code 1' },
            9_000
          ),
        ]),
      },
    });
    await render(<TerminalScreen runId="run-1" />);

    expect(screen.getByTestId('terminal-status')).toHaveTextContent('失败');
    expect(screen.getByText('exit code 1')).toBeTruthy();
  });

  it('无该 run 事件 → 未知态（诚实化，M4 §4.2 规则 3）', async () => {
    eventStore.setState({
      windows: { 's-1': windowOf([makeEntry('agent-start', 'run-other')]) },
    });
    await render(<TerminalScreen runId="run-1" />);

    expect(screen.getByTestId('terminal-status')).toHaveTextContent('未知');
  });
});

describe('终端页空态（M4 §5.9）', () => {
  it('无终端行 → 主文案 + 副文案', async () => {
    eventStore.setState({
      windows: {
        's-1': windowOf([
          makeEntry('message-end', 'run-1', { text: '非终端事件' }),
        ]),
      },
    });
    await render(<TerminalScreen runId="run-1" />);

    expect(screen.getByTestId('terminal-empty')).toBeTruthy();
    expect(screen.getByText('暂无终端输出')).toBeTruthy();
    expect(
      screen.getByText('该 run 的工具流式输出与任务输出会实时显示在这里')
    ).toBeTruthy();
  });
});

describe('终端页数据源：terminalStore 实时镜像优先（R2-14 部分 3 接线消费）', () => {
  it('terminalStore 有该 run 缓冲（活动 run 流式 ingest）→ 优先渲染镜像行', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      terminalStore.getState().ingestLines('run-1', 'live line\n');
      await render(<TerminalScreen runId="run-1" />);
      expect(screen.getByText('live line')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('镜像与事件流并存时镜像优先（接线层 ingest 为权威 live 面）', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      terminalStore.getState().ingestLines('run-1', 'live line\n');
      eventStore.setState({
        windows: { 's-1': windowOf([toolUpdate('from events\n')]) },
      });
      await render(<TerminalScreen runId="run-1" />);
      expect(screen.getByText('live line')).toBeTruthy();
      expect(screen.queryByText('from events')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('terminalStore 无缓冲（历史 run / 收口释放 / 未接线）→ 回落事件流重建', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      eventStore.setState({
        windows: { 's-1': windowOf([toolUpdate('from events\n')]) },
      });
      await render(<TerminalScreen runId="run-1" />);
      expect(screen.getByText('from events')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('run-terminal 收口释放后回落事件流（收口后历史完整面由 eventStore 承载）', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      terminalStore.getState().ingestLines('run-1', 'live line\n');
      terminalStore.getState().resetRun('run-1');
      eventStore.setState({
        windows: {
          's-1': windowOf([toolUpdate('from events\n')]),
        },
      });
      await render(<TerminalScreen runId="run-1" />);
      expect(screen.getByText('from events')).toBeTruthy();
      expect(screen.queryByText('live line')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
