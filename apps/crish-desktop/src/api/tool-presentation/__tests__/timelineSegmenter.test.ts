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

  it('多阶段过程与中间说明正文统筹并列归入单一过程段，仅尾部正文作为最终答案', () => {
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      tools('k1', ['read_file']),
      text('x1', '中间过渡正文1'),
      thought('t2'),
      tools('k2', ['grep_search', 'view_file']),
      text('x2', '中间过渡正文2'),
      tools('k3', ['run_command']),
      text('x3', '最终总结汇报'),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);

    expect(segs.map((s) => s.kind)).toEqual([
      'process_section',
      'text_narrative',
    ]);
    expect(segs.map((s) => s.id)).toEqual([
      'm1-proc-0',
      'm1-text-0',
    ]);
    // 过程段内包含 7 项：思考、工具、中间正文并列同级（对齐用户标注图二）
    const procSeg = segs[0] as { items: AssistantTimelineItem[] };
    expect(procSeg.items.map((it) => it.key)).toEqual([
      't1',
      'k1',
      'x1',
      't2',
      'k2',
      'x2',
      'k3',
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
      tools('k2', ['run_command']),
      text('x1'),
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

/* ═══════════════════════════════════════════════════════════════════════════
 * 顶部工作工作时间区显示门槛（用户裁决 · 2026-09-11）
 *   只有一个思考 或 只有一个工具调用 → 工作时间区域与分割线一律不显示
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('partitionTimelineSegments · 工作时间区唯一位置（2026-09-11 用户裁决）', () => {
  function capsuleOf(items: AssistantTimelineItem[], isTurnLive = false) {
    const segs = partitionTimelineSegments('m1', items, isTurnLive, false);
    const seg = segs.find((s) => s.kind === 'process_section') as
      | { showWorkTime: boolean; startTime?: number; endTime?: number; isLive: boolean }
      | undefined;
    return seg;
  }

  it('首个过程段（紧跟用户消息下方）→ showWorkTime=true（整轮唯一工作时间）', () => {
    // 无论是单一思考、单一工具、还是混合，首个过程段均承载整轮工作时间
    expect(capsuleOf([thought('t1', 1000)])?.showWorkTime).toBe(true);
    expect(capsuleOf([tools('k1', ['read_file'])])?.showWorkTime).toBe(true);
    expect(capsuleOf([thought('t1'), tools('k1', ['read_file'])])?.showWorkTime).toBe(true);
    expect(capsuleOf([tools('k1', ['read_file', 'grep_search'])])?.showWorkTime).toBe(true);
  });

  it('过程中间正文与后续工具统筹并入同个过程段，showWorkTime 恒为 true', () => {
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      text('x1', '回答中间过渡正文'),
      tools('k1', ['run_command', 'run_command']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const procSections = segs.filter((s) => s.kind === 'process_section') as Array<{
      id: string;
      showWorkTime: boolean;
      items: AssistantTimelineItem[];
    }>;
    expect(procSections).toHaveLength(1);
    expect(procSections[0]?.showWorkTime).toBe(true);
    expect(procSections[0]?.items).toHaveLength(3);
  });

  it('段起止时间戳：终态取段内最早 / 最晚 startTime', () => {
    const t1: TimelineThoughtItem = { ...thought('t1'), startTime: 1_000 };
    const k1: TimelineToolsItem = { ...tools('k1', ['read_file']), startTime: 4_500 };
    const seg = capsuleOf([t1, k1]);
    expect(seg?.startTime).toBe(1_000);
    expect(seg?.endTime).toBe(4_500);
  });

  it('段起止时间戳：活跃态 endTime 必须为 undefined（跳秒）', () => {
    const t1: TimelineThoughtItem = { ...thought('t1'), startTime: 1_000 };
    const k1: TimelineToolsItem = { ...tools('k1', ['read_file']), startTime: 4_500 };
    const seg = capsuleOf([t1, k1], true);
    expect(seg?.isLive).toBe(true);
    expect(seg?.startTime).toBe(1_000);
    expect(seg?.endTime).toBeUndefined();
  });
});

describe('partitionTimelineSegments · 段边界与空输入', () => {
  it('空数组 → 空结果', () => {
    expect(partitionTimelineSegments('m1', [], false, false)).toEqual([]);
  });

  it('仅注入项 → 产出状态通知段（绝不落入可折叠过程段）', () => {
    const segs = partitionTimelineSegments('m1', [injection('i1')], false, false);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe('state_notice');
    expect(segs[0]!.id).toBe('m1-state-0');
    // 负向断言：不得产出 process_section（状态通知被折叠吞掉即为缺陷）
    expect(segs.some((s) => s.kind === 'process_section')).toBe(false);
  });

  it('注入项作为物理界标：先冲掉前置过程段，本体常驻平铺', () => {
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      tools('k1', ['read_file', 'grep_search']),
      injection('i1'),
      tools('k2', ['run_command']),
      text('x1'),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    expect(segs.map((s) => s.kind)).toEqual([
      'process_section',
      'state_notice',
      'process_section',
      'text_narrative',
    ]);
    // 注入前的段仍受铁律一约束（后继存在正文 → 折叠）
    const first = segs[0] as { foldable: boolean; defaultExpanded: boolean };
    expect(first.foldable).toBe(true);
    expect(first.defaultExpanded).toBe(false);
    // 注入后的段同样受铁律一约束
    const third = segs[2] as { foldable: boolean; defaultExpanded: boolean };
    expect(third.foldable).toBe(true);
    expect(third.defaultExpanded).toBe(false);
  });

  it('负向断言：注入项绝不可出现在任何 process_section 的 items 中', () => {
    const items: AssistantTimelineItem[] = [
      injection('i1'),
      thought('t1'),
      injection('i2'),
      tools('k1', ['read_file']),
      text('x1'),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    for (const seg of segs) {
      if (seg.kind === 'process_section') {
        expect(seg.items.some((i) => i.kind === 'injection')).toBe(false);
      }
    }
    expect(segs.filter((s) => s.kind === 'state_notice')).toHaveLength(2);
  });

  it('相同输入幂等（纯函数）', () => {
    const items: AssistantTimelineItem[] = [thought('t1'), tools('k1', ['read_file']), text('x1')];
    const a = partitionTimelineSegments('m1', items, true, true);
    const b = partitionTimelineSegments('m1', items, true, true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 终态段末点锚定（物理终点口径）
 *
 * 历史缺陷：segEnd 取 max(startTime)，等价于把「末项自身执行时长」整体抹掉——
 * 双工具段只显示首工具耗时，单工具段恒为 0。终态定格必须锚定物理终点。
 * ═══════════════════════════════════════════════════════════════════════════ */

function proc(items: AssistantTimelineItem[], isLive = false) {
  const segs = partitionTimelineSegments('m-end', items, isLive, false);
  const seg = segs[0];
  if (seg?.kind !== 'process_section') {
    throw new Error(`期望首个段为 process_section，实际：${seg?.kind}`);
  }
  return seg;
}

describe('partitionTimelineSegments · 终态段末点锚定（max(start + duration)）', () => {
  it('双工具段：endTime 计入末项执行时长（负向：不得退化为 max(startTime)）', () => {
    const t0 = 1_700_000_000_000;
    const seg = proc([
      { ...tools('a', ['read_file']), startTime: t0, durationMs: 3_000 },
      { ...tools('b', ['grep_search']), startTime: t0 + 3_000, durationMs: 5_000 },
    ]);

    expect(seg.startTime).toBe(t0);
    // 物理终点：max(t0+3000, t0+3000+5000) = t0 + 8000
    expect(seg.endTime).toBe(t0 + 8_000);
    // 负向断言：绝不可是历史实现的 max(startTime) = t0 + 3000
    expect(seg.endTime).not.toBe(t0 + 3_000);
  });

  it('单思考 + 单工具：终点 = 工具起点 + 工具耗时（5s + 7s = 12s）', () => {
    const t0 = 1_700_000_000_000;
    const seg = proc([
      { ...thought('t1', 5_000), startTime: t0 },
      { ...tools('k1', ['run_command']), startTime: t0 + 5_000, durationMs: 7_000 },
    ]);

    expect(seg.endTime! - seg.startTime!).toBe(12_000);
  });

  it('末项缺 durationMs：终点退化为该项起点，且恒不小于段起点', () => {
    const t0 = 1_700_000_000_000;
    const seg = proc([
      { ...tools('a', ['read_file']), startTime: t0, durationMs: 2_000 },
      { ...tools('b', ['grep_search']), startTime: t0 + 2_000 },
    ]);

    expect(seg.endTime).toBe(t0 + 2_000);
    expect(seg.endTime!).toBeGreaterThanOrEqual(seg.startTime!);
  });

  it('无 startTime 但聚合有总耗时 → 以 segStart + totalDurationMs 兜底（禁止恒 0 假象）', () => {
    // 段内无绝对时钟，仅携带 durationMs：段起点由分段器置空，
    // 此时「工作 xx 时间」退化为语义标签，但不得产出负时长。
    const seg = proc([thought('t1', 4_000), tools('k1', ['read_file'])]);
    expect(seg.startTime).toBeUndefined();
    expect(seg.metrics.totalDurationMs).toBe(4_000);
  });

  it('活跃段（铁律二）endTime 恒为 undefined —— 跳秒口径不被终态公式污染', () => {
    const t0 = 1_700_000_000_000;
    const seg = proc(
      [
        { ...thought('t1', 1_000), startTime: t0 },
        { ...tools('k1', ['run_command']), startTime: t0 + 1_000, durationMs: 9_000 },
      ],
      true
    );

    expect(seg.isLive).toBe(true);
    expect(seg.endTime).toBeUndefined();
  });
});
