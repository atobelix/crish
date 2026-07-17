import { describe, expect, it } from 'vitest';
import {
  checklistSectionTitle,
  computeChecklistProgress,
  countOpenChecklistItems,
  findCurrentLiveTool,
  findLatestAssistantChecklist,
  formatChecklistSectionCount,
  formatGoalBannerStatus,
  formatLiveToolLine,
  formatStandaloneProgressMeta,
  formatTasksHeadCountLabel,
  formatToolStatusLabel,
  parseMarkdownChecklist,
  resolveSessionProgress,
  resolveSessionProgressItems,
  shouldShowGoalBanner,
  type ChecklistItem,
} from './TasksCard';
import {
  computeGoalTaskProgress,
  parseChecklistTasks,
} from '../api/goalModeController';
import type { MessageToolCall, SessionMessage, SessionState } from '../store/layoutStore';

describe('computeChecklistProgress', () => {
  it('returns zero when empty (tools must not invent progress)', () => {
    expect(computeChecklistProgress([])).toEqual({ total: 0, done: 0, open: 0, pct: 0 });
    expect(computeChecklistProgress(null)).toEqual({ total: 0, done: 0, open: 0, pct: 0 });
    expect(computeChecklistProgress(undefined)).toEqual({
      total: 0,
      done: 0,
      open: 0,
      pct: 0,
    });
  });

  it('counts only checklist done flags and exposes open', () => {
    expect(
      computeChecklistProgress([
        { id: '1', text: 'a', done: true },
        { id: '2', text: 'b', done: false },
        { id: '3', text: 'c', done: true },
      ]),
    ).toEqual({ total: 3, done: 2, open: 1, pct: 67 });
  });

  it('stays in lockstep with computeGoalTaskProgress on total/done/pct', () => {
    const items = [
      { id: '1', text: 'a', done: true },
      { id: '2', text: 'b', done: false },
    ];
    const a = computeChecklistProgress(items);
    const b = computeGoalTaskProgress(items);
    expect({ total: a.total, done: a.done, pct: a.pct }).toEqual(b);
    expect(a.open).toBe(b.total - b.done);
  });

  it('ignores tool-call count if mistakenly mixed (only item.done matters)', () => {
    // 进度算法从不读 toolCalls；仅 items 数组长度与 done
    const items: ChecklistItem[] = [{ id: 'x', text: 'only', done: false }];
    expect(computeChecklistProgress(items).total).toBe(1);
    expect(computeChecklistProgress(items).open).toBe(1);
    expect(computeChecklistProgress(items).pct).toBe(0);
  });

  it('open matches countOpenChecklistItems for the same items', () => {
    const items: ChecklistItem[] = [
      { id: '1', text: 'a', done: true },
      { id: '2', text: 'b', done: false },
      { id: '3', text: 'c', done: false },
    ];
    expect(computeChecklistProgress(items).open).toBe(countOpenChecklistItems(items));
  });
});

describe('countOpenChecklistItems', () => {
  it('counts incomplete only', () => {
    expect(countOpenChecklistItems([])).toBe(0);
    expect(countOpenChecklistItems(null)).toBe(0);
    expect(countOpenChecklistItems(undefined)).toBe(0);
    expect(
      countOpenChecklistItems([
        { id: '1', text: 'a', done: true },
        { id: '2', text: 'b', done: false },
        { id: '3', text: 'c', done: false },
      ]),
    ).toBe(2);
  });
});

describe('formatTasksHeadCountLabel / formatChecklistSectionCount / formatStandaloneProgressMeta', () => {
  it('head label is null when no trackable items (tool-only sessions stay blank)', () => {
    expect(
      formatTasksHeadCountLabel({ done: 0, total: 0, open: 0, pct: 0 }),
    ).toBeNull();
  });

  it('head label uses goal/checklist fractions only', () => {
    expect(
      formatTasksHeadCountLabel({ done: 1, total: 3, open: 2, pct: 33 }),
    ).toBe('1/3 · 33% · 待完成 2');
    expect(
      formatTasksHeadCountLabel({ done: 3, total: 3, open: 0, pct: 100 }),
    ).toBe('已完成 · 3/3');
  });

  it('section count mirrors open/done without inventing tool steps', () => {
    expect(formatChecklistSectionCount({ done: 2, total: 4, open: 2 })).toBe(
      '2/4 · 待 2',
    );
    expect(formatChecklistSectionCount({ done: 4, total: 4, open: 0 })).toBe(
      '4/4 · 完成',
    );
  });

  it('standalone progress meta left/right stay checklist-sourced', () => {
    expect(
      formatStandaloneProgressMeta({ done: 1, total: 2, open: 1, pct: 50 }),
    ).toEqual({ left: '进度', right: '1/2 · 50% · 待 1' });
    expect(
      formatStandaloneProgressMeta({ done: 2, total: 2, open: 0, pct: 100 }),
    ).toEqual({ left: '已完成', right: '2/2 · 100%' });
  });
});

describe('formatGoalBannerStatus', () => {
  it('shows 1-based iteration and max while goal active', () => {
    expect(
      formatGoalBannerStatus({
        goalActive: true,
        iteration: 0,
        maxIterations: 5,
        openCount: 2,
      }),
    ).toEqual({ text: '1/5' });
    expect(
      formatGoalBannerStatus({
        goalActive: true,
        iteration: 2,
        maxIterations: null,
        openCount: 0,
      }),
    ).toEqual({ text: '3' });
  });

  it('shows ended + open gap when goal inactive (max-iter residual)', () => {
    expect(
      formatGoalBannerStatus({
        goalActive: false,
        iteration: 5,
        maxIterations: 5,
        openCount: 2,
      }),
    ).toEqual({
      text: '已结束 · 缺口 2',
      title: '目标模式已结束，保留未完成清单',
    });
    expect(
      formatGoalBannerStatus({
        goalActive: false,
        iteration: 5,
        maxIterations: 5,
        openCount: 0,
      }).text,
    ).toBe('已结束');
  });
});

describe('parseMarkdownChecklist', () => {
  it('parses task list items', () => {
    const items = parseMarkdownChecklist('- [ ] one\n- [x] two\n* [X] three');
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ text: 'one', done: false });
    expect(items[1]).toMatchObject({ text: 'two', done: true });
    expect(items[2]).toMatchObject({ text: 'three', done: true });
  });

  it('returns empty for null/undefined/blank (no invented progress)', () => {
    expect(parseMarkdownChecklist(null)).toEqual([]);
    expect(parseMarkdownChecklist(undefined)).toEqual([]);
    expect(parseMarkdownChecklist('')).toEqual([]);
    expect(parseMarkdownChecklist('plain prose without boxes')).toEqual([]);
  });

  it('drops 本轮总结 pseudo-tasks from progress source', () => {
    const items = parseMarkdownChecklist(
      '- [ ] 实现工具行\n- [x] 本轮总结：已完成若干命令\n- [ ] 写测试',
    );
    expect(items.map((i) => i.text)).toEqual(['实现工具行', '写测试']);
  });

  it('matches goalModeController.parseChecklistTasks text+done', () => {
    const md = '- [ ] open\n- [x] closed\n* [ ] 本轮回顾：噪';
    const a = parseMarkdownChecklist(md);
    const b = parseChecklistTasks(md);
    expect(a.map((x) => ({ text: x.text, done: x.done }))).toEqual(
      b.map((x) => ({ text: x.text, done: x.done })),
    );
  });
});

describe('findLatestAssistantChecklist', () => {
  it('returns empty for no messages', () => {
    expect(findLatestAssistantChecklist(undefined)).toEqual({
      messageId: null,
      items: [],
    });
    expect(findLatestAssistantChecklist([])).toEqual({ messageId: null, items: [] });
  });

  it('picks the latest assistant message that has a checklist', () => {
    const messages = [
      { id: 'u1', sender: 'user', text: 'go' },
      { id: 'a1', sender: 'assistant', text: '- [ ] old\n- [x] done-old' },
      { id: 'u2', sender: 'user', text: 'more' },
      { id: 'a2', sender: 'assistant', text: 'no list here' },
      { id: 'a3', sender: 'assistant', text: '- [ ] new-open\n- [x] new-done' },
    ] as SessionMessage[];
    const r = findLatestAssistantChecklist(messages);
    expect(r.messageId).toBe('a3');
    expect(r.items.map((i) => i.text)).toEqual(['new-open', 'new-done']);
    expect(r.items[1].done).toBe(true);
  });

  it('never treats user-authored markdown checklists as progress', () => {
    const messages = [
      {
        id: 'u1',
        sender: 'user',
        text: '- [ ] user-fake-progress\n- [x] should-not-count',
      },
      { id: 'a1', sender: 'assistant', text: 'ack without list' },
    ] as SessionMessage[];
    expect(findLatestAssistantChecklist(messages)).toEqual({
      messageId: null,
      items: [],
    });
  });

  it('skips empty assistant bodies and pure pseudo-task noise', () => {
    const messages = [
      { id: 'a0', sender: 'assistant', text: '- [ ] real-older' },
      { id: 'a1', sender: 'assistant', text: '   ' },
      { id: 'a2', sender: 'assistant', text: '- [x] 本轮总结：噪音' },
    ] as SessionMessage[];
    const r = findLatestAssistantChecklist(messages);
    expect(r.messageId).toBe('a0');
    expect(r.items.map((i) => i.text)).toEqual(['real-older']);
  });
});

describe('resolveSessionProgress / resolveSessionProgressItems', () => {
  it('prefers goalMode.tasks over assistant markdown and marks source=goal', () => {
    const session = {
      messages: [
        {
          id: 'a1',
          sender: 'assistant',
          text: '- [ ] from-message',
        },
      ],
      goalMode: {
        active: true,
        goal: 'ship',
        iteration: 0,
        maxIterations: 5,
        tasks: [
          { id: 'g1', text: 'from-goal', done: true },
          { id: 'g2', text: 'from-goal-2', done: false },
        ],
      },
    } as Pick<SessionState, 'messages' | 'goalMode'>;
    const full = resolveSessionProgress(session);
    expect(full.source).toBe('goal');
    expect(full.goalActive).toBe(true);
    expect(full.goalText).toBe('ship');
    expect(full.goalMaxIterations).toBe(5);
    expect(full.items.map((i) => i.text)).toEqual(['from-goal', 'from-goal-2']);
    expect(resolveSessionProgressItems(session)).toEqual(full.items);
    expect(computeChecklistProgress(full.items)).toEqual({
      total: 2,
      done: 1,
      open: 1,
      pct: 50,
    });
  });

  it('falls back to assistant checklist when goal tasks empty', () => {
    const session = {
      messages: [
        { id: 'a1', sender: 'assistant', text: '- [x] only-msg' },
      ],
      goalMode: { active: true, goal: 'g', iteration: 0, tasks: [] },
    } as Pick<SessionState, 'messages' | 'goalMode'>;
    const full = resolveSessionProgress(session);
    expect(full.source).toBe('checklist');
    expect(full.items).toHaveLength(1);
    expect(full.items[0]).toMatchObject({ text: 'only-msg', done: true });
  });

  it('returns empty/none when neither goal tasks nor checklist present', () => {
    expect(resolveSessionProgressItems(null)).toEqual([]);
    expect(resolveSessionProgress(null).source).toBe('none');
    expect(
      resolveSessionProgress({
        messages: [{ id: 'a', sender: 'assistant', text: 'plain' } as SessionMessage],
        goalMode: undefined,
      }).source,
    ).toBe('none');
  });

  it('never invents progress from toolCalls alone', () => {
    const session = {
      messages: [
        {
          id: 'a',
          sender: 'assistant',
          text: 'running tools…',
          toolCalls: [
            { id: 't1', name: 'shell', status: 'running', arguments: 'npm test' },
            { id: 't2', name: 'read', status: 'success', arguments: 'a.ts' },
          ],
        } as SessionMessage,
      ],
      goalMode: undefined,
    } as Pick<SessionState, 'messages' | 'goalMode'>;
    const full = resolveSessionProgress(session);
    expect(full.items).toEqual([]);
    expect(full.source).toBe('none');
    expect(computeChecklistProgress(full.items)).toEqual({
      total: 0,
      done: 0,
      open: 0,
      pct: 0,
    });
  });

  it('trims goal text and keeps source=goal when all goal tasks done', () => {
    const full = resolveSessionProgress({
      messages: [
        { id: 'a1', sender: 'assistant', text: '- [ ] md-fallback' } as SessionMessage,
      ],
      goalMode: {
        active: false,
        goal: '  ship feature  ',
        iteration: 3,
        maxIterations: 5,
        tasks: [
          { id: 'g1', text: 'a', done: true },
          { id: 'g2', text: 'b', done: true },
        ],
      },
    } as Pick<SessionState, 'messages' | 'goalMode'>);
    expect(full.source).toBe('goal');
    expect(full.goalText).toBe('ship feature');
    expect(full.goalActive).toBe(false);
    expect(full.items.every((i) => i.done)).toBe(true);
    expect(computeChecklistProgress(full.items).open).toBe(0);
  });

  it('progress items never include live tools even when both exist', () => {
    const session = {
      messages: [
        {
          id: 'a',
          sender: 'assistant',
          text: '- [ ] real-task\n- [x] done-task',
          toolCalls: [
            { id: 't1', name: 'shell', status: 'running', arguments: 'npm test' },
          ],
        } as SessionMessage,
      ],
      goalMode: undefined,
    } as Pick<SessionState, 'messages' | 'goalMode'>;
    const full = resolveSessionProgress(session);
    expect(full.source).toBe('checklist');
    expect(full.items.map((i) => i.text)).toEqual(['real-task', 'done-task']);
    expect(full.items.some((i) => /npm|shell|t1/i.test(i.text))).toBe(false);
    expect(computeChecklistProgress(full.items)).toEqual({
      total: 2,
      done: 1,
      open: 1,
      pct: 50,
    });
  });
});

describe('shouldShowGoalBanner / checklistSectionTitle', () => {
  it('shows banner while goal active (even without goal text)', () => {
    expect(
      shouldShowGoalBanner({
        goalActive: true,
        goalText: 'ship it',
        items: [],
        source: 'none',
      }),
    ).toBe(true);
    expect(
      shouldShowGoalBanner({
        goalActive: true,
        goalText: null,
        items: [],
        source: 'none',
      }),
    ).toBe(true);
  });

  it('shows residual banner after goal ends with open goal tasks', () => {
    expect(
      shouldShowGoalBanner({
        goalActive: false,
        goalText: 'ship it',
        source: 'goal',
        items: [
          { id: '1', text: 'a', done: true },
          { id: '2', text: 'b', done: false },
        ],
      }),
    ).toBe(true);
  });

  it('hides residual when all goal tasks done, checklist-only, or no goal text', () => {
    expect(
      shouldShowGoalBanner({
        goalActive: false,
        goalText: 'ship',
        source: 'goal',
        items: [{ id: '1', text: 'a', done: true }],
      }),
    ).toBe(false);
    expect(
      shouldShowGoalBanner({
        goalActive: false,
        goalText: null,
        source: 'goal',
        items: [{ id: '1', text: 'a', done: false }],
      }),
    ).toBe(false);
    expect(
      shouldShowGoalBanner({
        goalActive: false,
        goalText: 'from-md only',
        source: 'checklist',
        items: [{ id: '1', text: 'a', done: false }],
      }),
    ).toBe(false);
  });

  it('labels sections by progress source', () => {
    expect(checklistSectionTitle('goal')).toBe('目标清单');
    expect(checklistSectionTitle('checklist')).toBe('清单');
    expect(checklistSectionTitle('none')).toBe('清单');
  });
});

describe('findCurrentLiveTool', () => {
  it('returns null when no live tools (progress stays checklist-only)', () => {
    expect(findCurrentLiveTool(undefined)).toBeNull();
    expect(
      findCurrentLiveTool({
        messages: [
          {
            id: 'a',
            sender: 'assistant',
            text: '- [ ] x',
            toolCalls: [{ id: 't1', name: 'shell', status: 'success' }],
          } as SessionMessage,
        ],
        agents: [],
      }),
    ).toBeNull();
  });

  it('returns the latest running tool when no approval pending', () => {
    const live = findCurrentLiveTool({
      messages: [
        {
          id: 'a',
          sender: 'assistant',
          text: '',
          toolCalls: [
            { id: 't0', name: 'read', status: 'success' },
            { id: 't1', name: 'shell', status: 'running' },
          ],
        } as SessionMessage,
      ],
      agents: [],
    });
    expect(live?.id).toBe('t1');
    expect(live?.status).toBe('running');
  });

  it('prefers pending_approval over a newer running tool (user action first)', () => {
    const live = findCurrentLiveTool({
      messages: [
        {
          id: 'a',
          sender: 'assistant',
          text: '',
          toolCalls: [
            { id: 't-approve', name: 'write', status: 'pending_approval', arguments: '{}' },
            { id: 't-run', name: 'shell', status: 'running', arguments: 'ls' },
          ],
        } as SessionMessage,
      ],
      agents: [],
    });
    expect(live?.id).toBe('t-approve');
    expect(live?.status).toBe('pending_approval');
  });

  it('scans collaboration agent tools when main timeline is idle', () => {
    const live = findCurrentLiveTool({
      messages: [
        {
          id: 'a',
          sender: 'assistant',
          text: '',
          toolCalls: [{ id: 't-done', name: 'read', status: 'success' }],
        } as SessionMessage,
      ],
      agents: [
        {
          id: 'ag1',
          messages: [
            {
              id: 'am',
              sender: 'assistant',
              text: '',
              toolCalls: [
                {
                  id: 't-agent',
                  name: 'shell',
                  status: 'running',
                  arguments: 'npm test',
                },
              ],
            },
          ],
        },
      ],
    } as Pick<SessionState, 'messages' | 'agents'>);
    expect(live?.id).toBe('t-agent');
  });
});

describe('formatLiveToolLine / formatToolStatusLabel', () => {
  it('builds a single-line live tool view; finished tools yield null', () => {
    expect(formatLiveToolLine(null)).toBeNull();
    expect(
      formatLiveToolLine({
        id: 't',
        name: 'shell',
        status: 'success',
        arguments: 'echo ok',
      }),
    ).toBeNull();

    const line = formatLiveToolLine({
      id: 't',
      name: 'shell',
      status: 'running',
      arguments: JSON.stringify({ command: 'npm test' }),
    });
    expect(line).not.toBeNull();
    expect(line!.statusLabel).toBe('进行中');
    expect(line!.isApproval).toBe(false);
    expect(line!.label.length).toBeGreaterThan(0);
  });

  it('marks approval status for the one-line row', () => {
    const line = formatLiveToolLine({
      id: 't',
      name: 'write',
      status: 'pending_approval',
      arguments: '{}',
    });
    expect(line?.isApproval).toBe(true);
    expect(line?.statusLabel).toBe('待确认');
    expect(formatToolStatusLabel('pending_approval')).toBe('待确认');
    expect(formatToolStatusLabel('error')).toBe('失败');
    expect(formatToolStatusLabel('success')).toBe('完成');
    expect(formatToolStatusLabel('running')).toBe('进行中');
  });

  it('live tool line never feeds checklist progress math', () => {
    const tool: MessageToolCall = {
      id: 't-live',
      name: 'shell',
      status: 'running',
      arguments: JSON.stringify({ command: 'echo hi' }),
    };
    const line = formatLiveToolLine(tool);
    expect(line).not.toBeNull();
    // 进度只看 items；工具行是独立展示
    expect(computeChecklistProgress([])).toEqual({
      total: 0,
      done: 0,
      open: 0,
      pct: 0,
    });
    expect(resolveSessionProgress({ messages: [], goalMode: undefined }).source).toBe(
      'none',
    );
  });
});
