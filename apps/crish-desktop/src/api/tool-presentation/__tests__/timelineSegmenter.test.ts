/**
 * apps/crish-desktop/src/api/tool-presentation/__tests__/timelineSegmenter.test.ts
 *
 * 分段状态机与四铁律的纯逻辑穷举验证。
 *
 * 覆盖：四铁律全部分支 + 优先级短路 + 负向断言（subagent 权威性）。
 */

import { describe, expect, it } from 'vitest';
import { partitionTimelineSegments } from '../timelineSegmenter';
import type {
  AssistantTimelineItem,
  TimelineInjectionItem,
  TimelineTextItem,
  TimelineThoughtItem,
  TimelineToolsItem,
} from '../toolPresentationTypes';

/* ────────────────────────── 构造器 ────────────────────────── */

function thought(key: string, durationMs = 0, isStreaming = false): TimelineThoughtItem {
  return { kind: 'thought', key, content: `思考 ${key}`, durationMs, isStreaming };
}

function text(key: string, content = '正文内容'): TimelineTextItem {
  return { kind: 'text', key, content };
}

function tools(key: string, names: string[]): TimelineToolsItem {
  return {
    kind: 'tools',
    key,
    items: names.map((n, i) => ({
      kind: 'single' as const,
      tc: {
        id: `${key}-${i}`,
        name: n,
        status: 'success' as const,
      },
    })),
  };
}

function injection(key: string): TimelineInjectionItem {
  return {
    kind: 'injection',
    key,
    injection: { id: key, kind: 'context_state' } as never,
  };
}

/* ────────────────────────── 测试 ────────────────────────── */

describe('partitionTimelineSegments · 基础切割', () => {
  it('过程 + 正文 → 产出 1 个过程段 + 1 个正文段', () => {
    const items: AssistantTimelineItem[] = [thought('t1', 1000), text('x1')];
    const segs = partitionTimelineSegments('m1', items, false, false);

    expect(segs).toHaveLength(2);
    expect(segs[0]!.kind).toBe('process_section');
    expect(segs[1]!.kind).toBe('text_narrative');
    expect(segs[0]!.id).toBe('m1-proc-0');
    expect(segs[1]!.id).toBe('m1-text-0');
  });

  it('无过程内容时不产出空过程段', () => {
    const items: AssistantTimelineItem[] = [text('x1')];
    const segs = partitionTimelineSegments('m1', items, false, false);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe('text_narrative');
  });

  it('多段交错：过程1 → 正文1 → 过程2 → 正文2 → 过程3', () => {
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      tools('k1', ['read_file']),
      text('x1'),
      thought('t2'),
      tools('k2', ['grep_search', 'view_file']),
      text('x2'),
      tools('k3', ['run_command']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);

    expect(segs.map((s) => s.kind)).toEqual([
      'process_section',
      'text_narrative',
      'process_section',
      'text_narrative',
      'process_section',
    ]);
    expect(segs.map((s) => s.id)).toEqual([
      'm1-proc-0',
      'm1-text-0',
      'm1-proc-1',
      'm1-text-1',
      'm1-proc-2',
    ]);
  });

  it('空正文不构成物理界标', () => {
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      text('x1', '   '),
      tools('k1', ['read_file']),
      text('x2', '真实正文'),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    // 空正文既不构成界标、也不进入任何段 → 过程段合并为一个，含 2 项（thought + tools）
    expect(segs).toHaveLength(2);
    expect(segs[0]!.kind).toBe('process_section');
    expect((segs[0] as { items: unknown[] }).items).toHaveLength(2);
    // 空正文的 key 不得出现在任何输出段中
    const allKeys = segs.flatMap((s) =>
      s.kind === 'process_section' ? s.items.map((i) => i.key) : [s.item.key]
    );
    expect(allKeys).not.toContain('x1');
  });

  it('isFinalAnswer 仅标记最后一个正文段', () => {
    const items: AssistantTimelineItem[] = [text('x1'), text('x2'), text('x3')];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const texts = segs.filter((s) => s.kind === 'text_narrative');
    expect(texts.map((s) => (s as { isFinalAnswer: boolean }).isFinalAnswer)).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe('partitionTimelineSegments · 铁律一（后继正文必折叠）', () => {
  it('中间过程段（有后继正文）→ foldable=true, defaultExpanded=false', () => {
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      tools('k1', ['read_file']),
      text('x1'),
      tools('k2', ['run_command']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const mid = segs[0] as { foldable: boolean; defaultExpanded: boolean; forceExpanded: boolean };
    expect(mid.foldable).toBe(true);
    expect(mid.defaultExpanded).toBe(false);
    expect(mid.forceExpanded).toBe(false);
  });

  it('流式中但存在后继正文时，铁律一优先于铁律二', () => {
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      tools('k1', ['read_file']),
      text('x1'),
      tools('k2', ['run_command']),
    ];
    const segs = partitionTimelineSegments('m1', items, true, true);
    const mid = segs[0] as { foldable: boolean; defaultExpanded: boolean; isLive: boolean };
    expect(mid.foldable).toBe(true);
    expect(mid.defaultExpanded).toBe(false);
    expect(mid.isLive).toBe(false);
  });
});

describe('partitionTimelineSegments · 铁律二（尾部流式直出）', () => {
  it('尾部无正文 + turn live → foldable=true, defaultExpanded=true, isLive=true', () => {
    const items: AssistantTimelineItem[] = [text('x1'), thought('t2'), tools('k2', ['read_file'])];
    const segs = partitionTimelineSegments('m1', items, true, true);
    const tail = segs[segs.length - 1] as {
      foldable: boolean;
      defaultExpanded: boolean;
      isLive: boolean;
    };
    expect(tail.foldable).toBe(true);
    expect(tail.defaultExpanded).toBe(true);
    expect(tail.isLive).toBe(true);
  });
});

describe('partitionTimelineSegments · 铁律三（纯工具终态自收敛）', () => {
  it('终态纯工具且 toolCount >= 2 → foldable=true, defaultExpanded=false', () => {
    const items: AssistantTimelineItem[] = [tools('k1', ['read_file', 'grep_search'])];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const seg = segs[0] as { foldable: boolean; defaultExpanded: boolean };
    expect(seg.foldable).toBe(true);
    expect(seg.defaultExpanded).toBe(false);
  });

  it('终态纯工具且 toolCount < 2 → foldable=false, defaultExpanded=true', () => {
    const items: AssistantTimelineItem[] = [tools('k1', ['read_file'])];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const seg = segs[0] as { foldable: boolean; defaultExpanded: boolean };
    expect(seg.foldable).toBe(false);
    expect(seg.defaultExpanded).toBe(true);
  });

  it('终态纯思考（无工具）→ 落入 toolCount<2 分支，foldable=false', () => {
    const items: AssistantTimelineItem[] = [thought('t1', 3000)];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const seg = segs[0] as { foldable: boolean; defaultExpanded: boolean };
    expect(seg.foldable).toBe(false);
    expect(seg.defaultExpanded).toBe(true);
  });
});

describe('partitionTimelineSegments · 铁律四（子代理可见性特权）', () => {
  it('subagentCount >= 1 → forceExpanded=true，且优先级高于铁律一', () => {
    const items: AssistantTimelineItem[] = [
      tools('k1', ['invoke_subagent']),
      text('x1'),
      tools('k2', ['run_command']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const seg = segs[0] as {
      foldable: boolean;
      defaultExpanded: boolean;
      forceExpanded: boolean;
      metrics: { subagentCount: number };
    };
    expect(seg.metrics.subagentCount).toBe(1);
    expect(seg.foldable).toBe(true);
    expect(seg.defaultExpanded).toBe(true);
    expect(seg.forceExpanded).toBe(true);
  });

  it('subagentCount >= 1 → 优先级高于铁律三（终态纯工具也强制展开）', () => {
    const items: AssistantTimelineItem[] = [
      tools('k1', ['invoke_subagent', 'run_subagent', 'read_file']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const seg = segs[0] as { foldable: boolean; defaultExpanded: boolean; forceExpanded: boolean };
    expect(seg.foldable).toBe(true);
    expect(seg.defaultExpanded).toBe(true);
    expect(seg.forceExpanded).toBe(true);
  });

  /* ── 负向断言：无 subagent 不得获得特权 ── */
  it('负向断言：无 subagent 的段 forceExpanded 必须为 false', () => {
    const items: AssistantTimelineItem[] = [
      tools('k1', ['read_file', 'grep_search', 'run_command']),
      text('x1'),
      tools('k2', ['read_file', 'view_file']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    for (const seg of segs) {
      if (seg.kind === 'process_section') {
        expect(seg.metrics.subagentCount).toBe(0);
        expect(seg.forceExpanded).toBe(false);
      }
    }
  });

  it('负向断言：子代理名不得被误分类为普通工具', () => {
    const items: AssistantTimelineItem[] = [
      tools('k1', ['invoke_subagent', 'wait_subagents']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const seg = segs[0] as { metrics: { subagentCount: number; toolCount: number } };
    expect(seg.metrics.subagentCount).toBe(2);
    expect(seg.metrics.toolCount).toBe(2); // subagentCount ⊆ toolCount
  });
});

describe('partitionTimelineSegments · 段边界与空输入', () => {
  it('空数组 → 空结果', () => {
    expect(partitionTimelineSegments('m1', [], false, false)).toEqual([]);
  });

  it('仅注入项 → 产出过程段（injectionCount > 0）', () => {
    const segs = partitionTimelineSegments('m1', [injection('i1')], false, false);
    expect(segs).toHaveLength(1);
    expect((segs[0] as { metrics: { injectionCount: number } }).metrics.injectionCount).toBe(1);
  });

  it('相同输入幂等（纯函数）', () => {
    const items: AssistantTimelineItem[] = [thought('t1'), tools('k1', ['read_file']), text('x1')];
    const a = partitionTimelineSegments('m1', items, true, true);
    const b = partitionTimelineSegments('m1', items, true, true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
