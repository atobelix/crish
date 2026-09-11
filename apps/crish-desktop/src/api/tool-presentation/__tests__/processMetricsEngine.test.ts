/**
 * apps/crish-desktop/src/api/tool-presentation/__tests__/processMetricsEngine.test.ts
 *
 * 度量聚合 / 主导动作仲裁 / 摘要文案 / 路径归一 的纯逻辑验证。
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateProcessMetrics,
  arbitrateLeadAction,
  canonicalizeFsPath,
  formatSegmentSummary,
  hasProcessContent,
} from '../processMetricsEngine';
import { classifyToolAction } from '../toolActionClassifier';
import type {
  AssistantTimelineItem,
  ProcessSegmentMetrics,
  TimelineToolsItem,
} from '../toolPresentationTypes';

/* ────────────────────────── 构造器 ────────────────────────── */

function tools(key: string, names: string[], status: 'success' | 'running' | 'error' = 'success'): TimelineToolsItem {
  return {
    kind: 'tools',
    key,
    items: names.map((n, i) => ({
      kind: 'single' as const,
      tc: { id: `${key}-${i}`, name: n, status },
    })),
  };
}

function emptyMetrics(): ProcessSegmentMetrics {
  return {
    thoughtCount: 0,
    thoughtDurationMs: 0,
    toolCount: 0,
    subagentCount: 0,
    searchCount: 0,
    commandCount: 0,
    readFilesCount: 0,
    editFilesCount: 0,
    readPaths: [],
    editPaths: [],
    injectionCount: 0,
    totalDurationMs: 0,
    hasRunning: false,
    hasError: false,
    isStreaming: false,
    leadAction: 'mixed',
  };
}

/* ────────────────────── canonicalizeFsPath ────────────────────── */

describe('canonicalizeFsPath · 跨平台路径归一', () => {
  it('反斜杠统一为正斜杠', () => {
    expect(canonicalizeFsPath('src\\api\\foo.ts')).toBe('src/api/foo.ts');
  });

  it('Windows 盘符大小写归一', () => {
    expect(canonicalizeFsPath('c:\\Users\\a.ts')).toBe('C:/Users/a.ts');
    expect(canonicalizeFsPath('C:\\Users\\a.ts')).toBe('C:/Users/a.ts');
  });

  it('折叠连续斜杠（保留 UNC 前缀）', () => {
    expect(canonicalizeFsPath('src//api///foo.ts')).toBe('src/api/foo.ts');
  });

  it('空输入安全', () => {
    expect(canonicalizeFsPath('')).toBe('');
    expect(canonicalizeFsPath(null)).toBe('');
    expect(canonicalizeFsPath(undefined)).toBe('');
  });

  it('正反斜杠混排归一到同一结果（去重前提）', () => {
    expect(canonicalizeFsPath('C:\\a\\b.ts')).toBe(canonicalizeFsPath('c:/a/b.ts'));
  });
});

/* ────────────────────── aggregateProcessMetrics ────────────────────── */

describe('aggregateProcessMetrics · 聚合正确性', () => {
  it('子代理计入 subagentCount 且同时计入 toolCount（子集关系）', () => {
    const items: AssistantTimelineItem[] = [tools('k1', ['invoke_subagent', 'read_file'])];
    const m = aggregateProcessMetrics(items);
    expect(m.subagentCount).toBe(1);
    expect(m.toolCount).toBe(2);
    // 负向：toolCount 不得等于各分类之和（否则会漏掉 subagent）
    expect(m.toolCount).not.toBe(m.readFilesCount + m.searchCount + m.commandCount + m.editFilesCount);
  });

  it('思考耗时累加进 thoughtDurationMs 与 totalDurationMs', () => {
    const items: AssistantTimelineItem[] = [
      { kind: 'thought', key: 't1', content: 'a', durationMs: 1200 },
      { kind: 'thought', key: 't2', content: 'b', durationMs: 800 },
    ];
    const m = aggregateProcessMetrics(items);
    expect(m.thoughtCount).toBe(2);
    expect(m.thoughtDurationMs).toBe(2000);
    expect(m.totalDurationMs).toBe(2000);
  });

  it('路径去重：同一文件多次读取只计 1', () => {
    const items: AssistantTimelineItem[] = [
      {
        kind: 'tools',
        key: 'k1',
        items: [
          { kind: 'single', tc: { id: '1', name: 'read_file', status: 'success', arguments: 'C:\\a\\b.ts' } },
          { kind: 'single', tc: { id: '2', name: 'view_file', status: 'success', arguments: 'c:/a/b.ts' } },
        ],
      },
    ];
    const m = aggregateProcessMetrics(items);
    expect(m.readFilesCount).toBe(1);
    expect(m.readPaths).toEqual(['C:/a/b.ts']);
  });

  it('状态标印：running / error 被捕获', () => {
    const items: AssistantTimelineItem[] = [
      tools('k1', ['read_file'], 'running'),
      tools('k2', ['run_command'], 'error'),
    ];
    const m = aggregateProcessMetrics(items);
    expect(m.hasRunning).toBe(true);
    expect(m.hasError).toBe(true);
  });

  it('注入计数', () => {
    const items: AssistantTimelineItem[] = [
      { kind: 'injection', key: 'i1', injection: {} as never },
      { kind: 'injection', key: 'i2', injection: {} as never },
    ];
    expect(aggregateProcessMetrics(items).injectionCount).toBe(2);
  });

  it('空输入产出零值', () => {
    const m = aggregateProcessMetrics([]);
    expect(m.toolCount).toBe(0);
    expect(m.thoughtCount).toBe(0);
    expect(m.leadAction).toBe('mixed');
  });
});

/* ────────────────────── arbitrateLeadAction ────────────────────── */

describe('arbitrateLeadAction · 主导动作仲裁优先级', () => {
  const order = ['subagent', 'edit', 'search', 'read', 'command', 'thought'] as const;

  it('完整优先级链：subagent > edit > search > read > command > thought > mixed', () => {
    const cases: Array<[Partial<ProcessSegmentMetrics>, string]> = [
      [{ subagentCount: 1, editFilesCount: 1, searchCount: 1, readFilesCount: 1, commandCount: 1, thoughtCount: 1 }, 'subagent'],
      [{ editFilesCount: 1, searchCount: 1, readFilesCount: 1, commandCount: 1, thoughtCount: 1 }, 'edit'],
      [{ searchCount: 1, readFilesCount: 1, commandCount: 1, thoughtCount: 1 }, 'search'],
      [{ readFilesCount: 1, commandCount: 1, thoughtCount: 1 }, 'read'],
      [{ commandCount: 1, thoughtCount: 1 }, 'command'],
      [{ thoughtCount: 1 }, 'thought'],
      [{}, 'mixed'],
    ];
    for (const [patch, expected] of cases) {
      expect(arbitrateLeadAction({ ...emptyMetrics(), ...patch })).toBe(expected);
    }
  });

  it('负向断言：command 优先级低于 read（防止历史反序回归）', () => {
    const m = { ...emptyMetrics(), commandCount: 5, readFilesCount: 1 };
    expect(arbitrateLeadAction(m)).toBe('read');
  });

  it('负向断言：order 数组与实现一致', () => {
    expect(order).toEqual(['subagent', 'edit', 'search', 'read', 'command', 'thought']);
  });
});

/* ────────────────────── formatSegmentSummary ────────────────────── */

describe('formatSegmentSummary · 图五中圆点拼接', () => {
  it('完整语序拼接（编辑 → 搜索 → 读取 → 命令 → 子任务）', () => {
    const m = {
      ...emptyMetrics(),
      editFilesCount: 2,
      searchCount: 3,
      readFilesCount: 1,
      commandCount: 4,
      subagentCount: 1,
    };
    expect(formatSegmentSummary(m)).toBe(
      '已编辑 2 个文件 \u00b7 已搜索 3 次 \u00b7 已读取 1 个文件 \u00b7 已运行 4 条命令 \u00b7 已调度 1 个子任务'
    );
  });

  it('空项自动裁剪', () => {
    const m = { ...emptyMetrics(), searchCount: 2, readFilesCount: 3 };
    expect(formatSegmentSummary(m)).toBe('已搜索 2 次 \u00b7 已读取 3 个文件');
  });

  it('无工具时回退思考文案（带耗时）', () => {
    const m = { ...emptyMetrics(), thoughtCount: 1, thoughtDurationMs: 3200 };
    expect(formatSegmentSummary(m)).toBe('已深度思考 (3.2s)');
  });

  it('无工具时回退思考文案（无耗时）', () => {
    const m = { ...emptyMetrics(), thoughtCount: 2 };
    expect(formatSegmentSummary(m)).toBe('已深度思考');
  });

  it('仅工具无分类（如未知名）→ 已完成 N 项操作', () => {
    const m = { ...emptyMetrics(), toolCount: 3 };
    expect(formatSegmentSummary(m)).toBe('已完成 3 项操作');
  });

  it('全空兜底', () => {
    expect(formatSegmentSummary(emptyMetrics())).toBe('中间处理过程');
  });

  it('负向断言：分隔符必须是中圆点，不得是其他符号', () => {
    const m = { ...emptyMetrics(), searchCount: 1, readFilesCount: 1 };
    const out = formatSegmentSummary(m);
    expect(out).toContain(' \u00b7 ');
    expect(out).not.toContain(' · · ');
  });
});

/* ────────────────────── hasProcessContent ────────────────────── */

describe('hasProcessContent', () => {
  it('有工具 → true', () => {
    expect(hasProcessContent({ ...emptyMetrics(), toolCount: 1 })).toBe(true);
  });
  it('有思考 → true', () => {
    expect(hasProcessContent({ ...emptyMetrics(), thoughtCount: 1 })).toBe(true);
  });
  it('有注入 → true', () => {
    expect(hasProcessContent({ ...emptyMetrics(), injectionCount: 1 })).toBe(true);
  });
  it('全空 → false', () => {
    expect(hasProcessContent(emptyMetrics())).toBe(false);
  });
});

/* ────────────────────── classifyToolAction ────────────────────── */

describe('classifyToolAction · 两阶段分类', () => {
  it('精确表：已知工具名 O(1) 命中', () => {
    expect(classifyToolAction('read_file')).toBe('read');
    expect(classifyToolAction('grep_search')).toBe('search');
    expect(classifyToolAction('write_file')).toBe('edit');
    expect(classifyToolAction('run_command')).toBe('command');
    expect(classifyToolAction('invoke_subagent')).toBe('subagent');
  });

  it('大小写与连字符归一', () => {
    expect(classifyToolAction('Read-File')).toBe('read');
    expect(classifyToolAction('GREP_SEARCH')).toBe('search');
  });

  it('契约断言：list_dir → search（不是 read）', () => {
    expect(classifyToolAction('list_dir')).toBe('search');
  });

  it('契约断言：delete_file → edit（不是 read，即使含 "elete" 亦不误判）', () => {
    expect(classifyToolAction('delete_file')).toBe('edit');
  });

  it('契约断言：read_url_content → read（网络抓取，不被 read 域漏掉）', () => {
    expect(classifyToolAction('read_url_content')).toBe('read');
  });

  it('回退规则：未知 read_* 归 read', () => {
    expect(classifyToolAction('read_something_new')).toBe('read');
  });

  it('回退规则：未知 *_search 归 search', () => {
    expect(classifyToolAction('deep_search')).toBe('search');
  });

  it('负向断言：delete_file 不得被 view 子串误判为 read', () => {
    expect(classifyToolAction('delete_file')).not.toBe('read');
  });

  it('空名兜底为 command', () => {
    expect(classifyToolAction('')).toBe('command');
    expect(classifyToolAction(undefined)).toBe('command');
  });
});
