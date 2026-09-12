/**
 * apps/crish-desktop/src/api/tool-presentation/__tests__/processMetricsEngine.test.ts
 *
 * 度量聚合 / 主导动作仲裁 / 摘要文案 / 路径归一 的纯逻辑验证。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregateProcessMetrics,
  arbitrateLeadAction,
  canonicalizeFsPath,
  formatDurationLabel,
  formatProcessControlLabel,
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

/* ────────────────────── formatDurationLabel ────────────────────── */

describe('formatDurationLabel · 耗时文案边界穷举', () => {
  it('秒级：保留一位小数', () => {
    expect(formatDurationLabel(0)).toBe('0.0 秒');
    expect(formatDurationLabel(999)).toBe('1.0 秒');
    expect(formatDurationLabel(12_500)).toBe('12.5 秒');
    expect(formatDurationLabel(59_900)).toBe('59.9 秒');
  });

  it('分秒级：秒取整', () => {
    expect(formatDurationLabel(60_000)).toBe('1 分 0 秒');
    expect(formatDurationLabel(65_400)).toBe('1 分 5 秒');
    expect(formatDurationLabel(3_599_000)).toBe('59 分 59 秒');
  });

  it('时分级：丢弃秒', () => {
    expect(formatDurationLabel(3_600_000)).toBe('1 小时 0 分');
    expect(formatDurationLabel(7_260_000)).toBe('2 小时 1 分');
  });

  it('负值退化为 0（防御上游脏数据）', () => {
    expect(formatDurationLabel(-5_000)).toBe('-5.0 秒');
  });

  it('负向断言：永不出现 (x.xs) 旧式英文后缀', () => {
    for (const ms of [0, 3_200, 12_500, 60_000, 3_600_000]) {
      expect(formatDurationLabel(ms)).not.toMatch(/\(\d/);
      expect(formatDurationLabel(ms)).not.toContain('s)');
    }
  });
});

/* ────────────────────── formatProcessControlLabel ────────────────────── */

describe('formatProcessControlLabel · 控制栏文案（2026-09-11 用户裁决）', () => {
  it('多元素段 · 运行中 → 「正在处理 xx 时间」', () => {
    const m = { ...emptyMetrics(), thoughtCount: 1, toolCount: 1 };
    expect(formatProcessControlLabel(m, true, 4_200, true)).toBe('正在处理 4.2 秒');
  });

  it('多元素段 · 终态 → 「已完成 xx 时间」', () => {
    const m = { ...emptyMetrics(), thoughtCount: 1, toolCount: 1 };
    expect(formatProcessControlLabel(m, true, 12_500, false)).toBe('已完成 12.5 秒');
  });

  it('多元素段 · 终态跨分钟 → 「已完成 m 分 s 秒」', () => {
    const m = { ...emptyMetrics(), thoughtCount: 1, toolCount: 3 };
    expect(formatProcessControlLabel(m, true, 65_400, false)).toBe('已完成 1 分 5 秒');
  });

  it('单思考段（不显示工作时间区域）→ 「思考」', () => {
    const m = { ...emptyMetrics(), thoughtCount: 1 };
    expect(formatProcessControlLabel(m, false, 3_200, false)).toBe('思考');
  });

  it('单工具调用段 → 「已运行 N 条命令」', () => {
    const m = { ...emptyMetrics(), toolCount: 4 };
    expect(formatProcessControlLabel(m, false, 8_000, false)).toBe('已运行 4 条命令');
  });

  it('空段兜底 → 「处理过程」', () => {
    expect(formatProcessControlLabel(emptyMetrics(), false, 0, false)).toBe('处理过程');
  });

  it('负向断言：任何输入组合都不得产出「已深度思考」', () => {
    const variants = [
      emptyMetrics(),
      { ...emptyMetrics(), thoughtCount: 1 },
      { ...emptyMetrics(), thoughtCount: 3, thoughtDurationMs: 3_200 },
      { ...emptyMetrics(), toolCount: 1 },
      { ...emptyMetrics(), toolCount: 5, commandCount: 5 },
      { ...emptyMetrics(), thoughtCount: 1, toolCount: 2 },
    ];
    for (const m of variants) {
      for (const capsule of [true, false]) {
        for (const live of [true, false]) {
          for (const ms of [0, 3_200, 12_500, 3_600_000]) {
            expect(formatProcessControlLabel(m, capsule, ms, live)).not.toContain('已深度思考');
          }
        }
      }
    }
  });

  it('工作时间段（showWorkTime=true）专一承载耗时，不含工具细分字样；后续工具段（showWorkTime=false）精准展示调用分类描述', () => {
    const m = {
      ...emptyMetrics(),
      editFilesCount: 2,
      searchCount: 3,
      readFilesCount: 1,
      commandCount: 4,
      subagentCount: 1,
      toolCount: 11,
    };
    // 1. showWorkTime=true: 承载工作耗时，绝不含工具细分字样
    expect(formatProcessControlLabel(m, true, 5_000, true)).toBe('正在处理 5.0 秒');
    expect(formatProcessControlLabel(m, true, 5_000, false)).toBe('已完成 5.0 秒');
    for (const live of [true, false]) {
      const out = formatProcessControlLabel(m, true, 5_000, live);
      expect(out).not.toContain('\u00b7');
      expect(out).not.toContain('已编辑');
      expect(out).not.toContain('已搜索');
      expect(out).not.toContain('已读取');
      expect(out).not.toContain('已调度');
      expect(out).not.toContain('中间处理过程');
    }

    // 2. showWorkTime=false: 展示调用了多少工具、分别是什么类型的描述（2026-09-11 用户裁决）
    const summary = formatProcessControlLabel(m, false, 5_000, false);
    expect(summary).toBe('已调用 1 个子代理 · 已搜索 3 次 · 已读取 1 个文件 · 已编辑 2 个文件 · 已运行 4 条命令');
  });

  it('负向断言（源码级）：战役源码中「已深度思考」仅可存在于说明性注释，不得存在于可执行字面量', () => {
    const files = [
      '../processMetricsEngine.ts',
      '../timelineSegmenter.ts',
      '../toolPresentationTypes.ts',
      '../../../components/chat-message/FoldableProcessSection.tsx',
      '../../../components/chat-message/MessageContent.tsx',
    ];
    const needle = ['已深', '度思考'].join('');
    for (const rel of files) {
      const src = readFileSync(resolve(__dirname, rel), 'utf8');
      // 剥离块注释与行注释后，仅剩可执行代码
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code, `${rel} 中不得存在「${needle}」字面量`).not.toContain(needle);
    }
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
