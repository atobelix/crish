import { describe, expect, it } from 'vitest';
import type { SessionState as Session } from '../store/layoutStore';
import {
  computeChecklistProgress,
  findCurrentLiveTool,
  resolveSessionProgressItems,
} from './sessionProgressApi';

/** 只构造被测函数读取的字段的会话夹具。 */
function session(partial: Record<string, unknown>): Session {
  return { id: 's1', messages: [], ...partial } as unknown as Session;
}

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  id: `m-${text.length}`,
  sender: 'assistant',
  text,
  ...extra,
});

describe('resolveSessionProgressItems', () => {
  it('空会话 / 无消息 → []', () => {
    expect(resolveSessionProgressItems(null)).toEqual([]);
    expect(resolveSessionProgressItems(undefined)).toEqual([]);
    expect(resolveSessionProgressItems(session({ messages: [] }))).toEqual([]);
  });

  it('goalMode 激活且有任务时优先使用 goalMode.tasks', () => {
    const tasks = [{ id: 'g1', text: '写测试', done: true }];
    const s = session({
      goalMode: { active: true, tasks },
      messages: [assistant('- [ ] 来自消息')],
    });
    expect(resolveSessionProgressItems(s)).toBe(tasks);
  });

  it('goalMode 未激活或任务为空时回落到最近一条含清单的助手消息', () => {
    const s = session({
      goalMode: { active: false, tasks: [{ id: 'g', text: 'x', done: false }] },
      messages: [
        assistant('- [x] 旧任务'),
        { id: 'u', sender: 'user', text: '- [ ] 用户写的不算' },
        assistant('无清单的回复'),
      ],
    });
    expect(resolveSessionProgressItems(s)).toEqual([
      { id: 'chk-1', text: '旧任务', done: true },
    ]);
  });

  it('解析 -/* 两种列表符、大小写 x、CRLF，并跳过非清单行与空任务文本', () => {
    const text = [
      '计划：',
      '- [ ] 第一步  ',
      '* [X] 第二步',
      '  - [x] 缩进第三步',
      '- [ ]    ',
      '- [y] 非法标记',
      '[ ] 缺列表符',
    ].join('\r\n');
    expect(
      resolveSessionProgressItems(session({ messages: [assistant(text)] }))
    ).toEqual([
      { id: 'chk-1', text: '第一步', done: false },
      { id: 'chk-2', text: '第二步', done: true },
      { id: 'chk-3', text: '缩进第三步', done: true },
    ]);
  });

  it('不含 "[" 的文本直接跳过', () => {
    expect(
      resolveSessionProgressItems(
        session({ messages: [assistant('- 普通列表')] })
      )
    ).toEqual([]);
  });
});

describe('computeChecklistProgress', () => {
  it('空 / null → 全零且 allDone=false', () => {
    const zero = { done: 0, total: 0, pct: 0, open: 0, allDone: false };
    expect(computeChecklistProgress(null)).toEqual(zero);
    expect(computeChecklistProgress([])).toEqual(zero);
  });

  it('部分完成按四舍五入百分比', () => {
    const items = [
      { id: 'a', text: 'a', done: true },
      { id: 'b', text: 'b', done: false },
      { id: 'c', text: 'c', done: false },
    ];
    expect(computeChecklistProgress(items)).toEqual({
      done: 1,
      total: 3,
      pct: 33,
      open: 2,
      allDone: false,
    });
  });

  it('全部完成 → pct=100, allDone=true', () => {
    expect(
      computeChecklistProgress([
        { id: 'a', text: 'a', done: true },
        { id: 'b', text: 'b', done: true },
      ])
    ).toEqual({ done: 2, total: 2, pct: 100, open: 0, allDone: true });
  });
});

describe('findCurrentLiveTool（持久化 toolCalls 路径）', () => {
  it('无消息或最后一条不是助手消息 → null', () => {
    expect(findCurrentLiveTool(null)).toBeNull();
    expect(
      findCurrentLiveTool(
        session({ messages: [{ id: 'u', sender: 'user', text: 'hi' }] })
      )
    ).toBeNull();
  });

  it('取最后一个运行中 / 待审批的工具，并给出中文状态', () => {
    const s = session({
      messages: [
        assistant('', {
          status: 'done',
          toolCalls: [
            { id: 't1', name: 'read_file', status: 'running', arguments: '{}' },
            {
              id: 't2',
              name: 'shell',
              status: 'pending_approval',
              arguments: '{}',
            },
            { id: 't3', name: 'grep', status: 'completed', arguments: '{}' },
          ],
        }),
      ],
    });
    const live = findCurrentLiveTool(s);
    expect(live?.isApproval).toBe(true);
    expect(live?.statusLabel).toBe('待审批');
    expect(typeof live?.label).toBe('string');
    expect(live?.label.length).toBeGreaterThan(0);
  });

  it('仅有运行中工具 → 执行中', () => {
    const s = session({
      messages: [
        assistant('', {
          status: 'done',
          toolCalls: [
            { id: 't1', name: 'read_file', status: 'running', arguments: '{}' },
          ],
        }),
      ],
    });
    expect(findCurrentLiveTool(s)).toMatchObject({
      statusLabel: '执行中',
      isApproval: false,
    });
  });

  it('工具全部结束且消息非 processing → null', () => {
    const s = session({
      messages: [
        assistant('', {
          status: 'done',
          toolCalls: [
            { id: 't1', name: 'grep', status: 'completed', arguments: '{}' },
          ],
        }),
      ],
    });
    expect(findCurrentLiveTool(s)).toBeNull();
  });
});
