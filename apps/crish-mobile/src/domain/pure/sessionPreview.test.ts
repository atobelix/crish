// 会话列表预览纯函数单测（R2-05 部分 4）：
// - extractPreviewText：message-delta / message-end（blocks 拼接 / content 兜底）/ tool-update /
//   tool-end / task-output / 非消息类空串；
// - previewText：ANSI 剥离（复用 stripAnsi）、空白收敛、单行截断（SESSION_PREVIEW_MAX + …）；
// - lastPreviewOfWindow：无窗口 / 空窗口 / 尾部条目三种数据面。
import { createWindow } from '@/domain/store/eventReducers';
import type { FeedEntry } from '@/domain/store/eventReducers';
import {
  extractPreviewText,
  lastPreviewOfWindow,
  previewText,
  SESSION_PREVIEW_MAX,
  tailIsStreamingOfWindow,
} from './sessionPreview';

function makeEntry(
  type: string,
  fields: Record<string, unknown> = {}
): FeedEntry {
  return { type, sessionId: 's-1', receivedAtMs: 0, ...fields } as FeedEntry;
}

describe('extractPreviewText 消息正文提取', () => {
  it('message-delta 取 frame.text', () => {
    expect(
      extractPreviewText(makeEntry('message-delta', { text: '问题定位在' }))
    ).toBe('问题定位在');
  });

  it('message-delta 缺 text → 空串', () => {
    expect(extractPreviewText(makeEntry('message-delta'))).toBe('');
  });

  it('message-end 拼接 blocks 中 text 块（跳过空块与非 text 块）', () => {
    const frame = makeEntry('message-end', {
      message: {
        id: 'asst-1',
        role: 'assistant',
        blocks: [
          { type: 'thought', text: '先分析……' },
          { type: 'text', text: '问题定位在' },
          { type: 'tool-call', id: 'tc-1', toolName: 'grep_search' },
          { type: 'text', text: ' src/pages/login.tsx' },
          { type: 'text', text: '   ' },
        ],
      },
    });
    expect(extractPreviewText(frame)).toBe('问题定位在 src/pages/login.tsx');
  });

  it('message-end 无 blocks → message.content 兜底', () => {
    const frame = makeEntry('message-end', {
      message: { id: 'asst-1', role: 'assistant', content: '正文兜底' },
    });
    expect(extractPreviewText(frame)).toBe('正文兜底');
  });

  it('message-end 无 message → frame.content 兜底', () => {
    const frame = makeEntry('message-end', { content: '顶层正文' });
    expect(extractPreviewText(frame)).toBe('顶层正文');
  });

  it('message-end 无任何正文 → 空串', () => {
    expect(extractPreviewText(makeEntry('message-end'))).toBe('');
  });

  it('tool-update 取 update.text（宽容两级读取）', () => {
    const frame = makeEntry('tool-update', {
      update: { id: 'tc-1', text: '已更新文件…' },
    });
    expect(extractPreviewText(frame)).toBe('已更新文件…');
  });

  it('tool-end 取 result.output', () => {
    const frame = makeEntry('tool-end', {
      result: { id: 'tc-1', output: '12 处匹配', isError: false },
    });
    expect(extractPreviewText(frame)).toBe('12 处匹配');
  });

  it('task-output 取 line / chunk', () => {
    expect(
      extractPreviewText(makeEntry('task-output', { line: '构建成功' }))
    ).toBe('构建成功');
    expect(
      extractPreviewText(makeEntry('task-output', { chunk: 'tail 输出' }))
    ).toBe('tail 输出');
  });

  it('非消息类事件（run-terminal / tool-start / approval）→ 空串（不猜）', () => {
    expect(
      extractPreviewText(makeEntry('run-terminal', { terminal: 'completed' }))
    ).toBe('');
    expect(
      extractPreviewText(makeEntry('tool-start', { toolName: 'grep_search' }))
    ).toBe('');
    expect(extractPreviewText(makeEntry('approval-requested'))).toBe('');
  });
});

describe('previewText 收敛（ANSI / 空白 / 截断）', () => {
  it('剥离 ANSI SGR 序列（复用 stripAnsi 白名单）', () => {
    expect(
      previewText(
        makeEntry('message-delta', { text: '\u001b[31m红色\u001b[0m 正文' })
      )
    ).toBe('红色 正文');
  });

  it('换行与多空格收敛为单空格（单行渲染前提）', () => {
    expect(
      previewText(
        makeEntry('message-delta', { text: '第一行\n\n  第二行\t结尾' })
      )
    ).toBe('第一行 第二行 结尾');
  });

  it('空正文 → 空串', () => {
    expect(previewText(makeEntry('run-terminal'))).toBe('');
  });

  it('超长截断：保留 SESSION_PREVIEW_MAX-1 码点 + …', () => {
    const long = 'A'.repeat(SESSION_PREVIEW_MAX + 20);
    const result = previewText(makeEntry('message-delta', { text: long }));
    expect(result.length).toBe(SESSION_PREVIEW_MAX);
    expect(result.endsWith('…')).toBe(true);
    expect(result.startsWith('A'.repeat(SESSION_PREVIEW_MAX - 1))).toBe(true);
  });

  it('恰好等于上限不截断（无尾缀 …）', () => {
    const exact = 'B'.repeat(SESSION_PREVIEW_MAX);
    expect(previewText(makeEntry('message-delta', { text: exact }))).toBe(
      exact
    );
  });
});

describe('lastPreviewOfWindow 窗口尾部数据面', () => {
  it('无窗口 → 空串', () => {
    expect(lastPreviewOfWindow(undefined)).toBe('');
  });

  it('空窗口 → 空串', () => {
    expect(lastPreviewOfWindow(createWindow())).toBe('');
  });

  it('尾部条目为消息 → 预览文本', () => {
    const window = createWindow();
    window.entries.push(
      makeEntry('message-delta', { sequence: 1, text: '旧增量' }),
      makeEntry('message-end', {
        sequence: 2,
        message: { id: 'asst-2', role: 'assistant', blocks: [] },
      }),
      makeEntry('message-delta', { sequence: 3, text: '最近消息文本' })
    );
    expect(lastPreviewOfWindow(window)).toBe('最近消息文本');
  });

  it('尾部条目为非消息事件 → 空串', () => {
    const window = createWindow();
    window.entries.push(makeEntry('run-terminal', { terminal: 'completed' }));
    expect(lastPreviewOfWindow(window)).toBe('');
  });
});

describe('tailIsStreamingOfWindow 尾部流式标记数据面（R2UX-05-02）', () => {
  it('无窗口 / 空窗口 → false', () => {
    expect(tailIsStreamingOfWindow(undefined)).toBe(false);
    expect(tailIsStreamingOfWindow(createWindow())).toBe(false);
  });

  it('尾部为流式增量类型（message-delta / tool-update / task-output）→ true', () => {
    const window = createWindow();
    window.entries.push(
      makeEntry('message-delta', { sequence: 1, text: '增量' })
    );
    expect(tailIsStreamingOfWindow(window)).toBe(true);
    const toolWindow = createWindow();
    toolWindow.entries.push(makeEntry('tool-update', { sequence: 1 }));
    expect(tailIsStreamingOfWindow(toolWindow)).toBe(true);
    const taskWindow = createWindow();
    taskWindow.entries.push(makeEntry('task-output', { sequence: 1 }));
    expect(tailIsStreamingOfWindow(taskWindow)).toBe(true);
  });

  it('尾部为终态类型（message-end / run-terminal 等）→ false', () => {
    const window = createWindow();
    window.entries.push(
      makeEntry('message-delta', { sequence: 1, text: '增量' }),
      makeEntry('message-end', {
        sequence: 2,
        message: { id: 'asst-2', role: 'assistant', blocks: [] },
      })
    );
    expect(tailIsStreamingOfWindow(window)).toBe(false);
  });

  it('未知 type → false（保真兜底，不猜流式）', () => {
    const window = createWindow();
    window.entries.push(makeEntry('mystery-event'));
    expect(tailIsStreamingOfWindow(window)).toBe(false);
  });
});
