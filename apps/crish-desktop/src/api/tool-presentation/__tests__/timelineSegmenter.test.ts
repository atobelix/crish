/**
 * apps/crish-desktop/src/api/tool-presentation/__tests__/timelineSegmenter.test.ts
 *
 * 按轮单组分段状态机与折叠裁决的纯逻辑穷举验证（R9 过程组口径）。
 *
 * 覆盖：单组聚合（中间正文降级组内叙述行、发生序不变）、最终答复收紧
 * 判定（其后无过程项）、纯过程收尾无答复段、状态通知物理界标、默认开合
 * 过渡口径、段级 forceExpanded 物理删除的负向断言（不得回潮）。
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

function thought(
  key: string,
  durationMs = 0,
  isStreaming = false
): TimelineThoughtItem {
  return {
    kind: 'thought',
    key,
    content: `思考 ${key}`,
    durationMs,
    isStreaming,
  };
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

describe('partitionTimelineSegments · 基础切割（R9 单组模型）', () => {
  it('过程 + 正文 → 产出 1 个过程组 + 1 个答复段', () => {
    const items: AssistantTimelineItem[] = [thought('t1', 1000), text('x1')];
    const segs = partitionTimelineSegments('m1', items, false, false);

    expect(segs).toHaveLength(2);
    expect(segs[0]!.kind).toBe('process_section');
    expect(segs[1]!.kind).toBe('text_narrative');
    expect(segs[0]!.id).toBe('m1-proc-0');
    expect(segs[1]!.id).toBe('m1-text-0');
  });

  it('无过程内容时不产出空过程组', () => {
    const items: AssistantTimelineItem[] = [text('x1')];
    const segs = partitionTimelineSegments('m1', items, false, false);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe('text_narrative');
  });

  it('R9 单组聚合：多阶段过程与中间正文全部入一个过程组，组内严格保持发生序，末正文独立为答复段', () => {
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

    // 一轮 = 一个过程组 + 一个答复段（中间正文不再独立成段）
    expect(segs.map((s) => s.kind)).toEqual([
      'process_section',
      'text_narrative',
    ]);
    expect(segs.map((s) => s.id)).toEqual(['m1-proc-0', 'm1-text-0']);

    // 组内条目与发生序逐项一致：思考 / 工具 / 中间正文（叙述行）交错原样保留
    const group = segs[0] as { items: AssistantTimelineItem[] };
    expect(group.items.map((it) => it.key)).toEqual([
      't1',
      'k1',
      'x1',
      't2',
      'k2',
      'x2',
      'k3',
    ]);
    expect(group.items.map((it) => it.kind)).toEqual([
      'thought',
      'tools',
      'text',
      'thought',
      'tools',
      'text',
      'tools',
    ]);

    // 答复段即最后一个正文项，且被标记为最终答复
    const answer = segs[1] as {
      item: TimelineTextItem;
      isFinalAnswer: boolean;
    };
    expect(answer.item.key).toBe('x3');
    expect(answer.isFinalAnswer).toBe(true);
  });

  it('最终答复判定收紧：正文之后仍有过程项时，该正文降级组内叙述行，整轮无答复段', () => {
    const items: AssistantTimelineItem[] = [
      text('x1', '先说结论再动手'),
      thought('t1'),
      tools('k1', ['read_file']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe('process_section');
    const group = segs[0] as { items: AssistantTimelineItem[] };
    expect(group.items.map((it) => it.key)).toEqual(['x1', 't1', 'k1']);
    // 负向断言：不得把被过程项跟随的正文误标为答复段
    expect(segs.some((s) => s.kind === 'text_narrative')).toBe(false);
  });

  it('纯过程收尾（无正文）→ 整轮只有一个过程组、无答复段', () => {
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      tools('k1', ['read_file']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe('process_section');
    expect(segs[0]!.id).toBe('m1-proc-0');
  });

  it('空正文不构成物理界标、也不入组', () => {
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      text('x1', '   '),
      tools('k1', ['read_file']),
      text('x2', '真实正文'),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    // 空正文既不构成界标、也不进入任何段 → 过程组合并为一个，含 2 项（thought + tools）
    expect(segs).toHaveLength(2);
    expect(segs[0]!.kind).toBe('process_section');
    expect((segs[0] as { items: unknown[] }).items).toHaveLength(2);
    // 空正文的 key 不得出现在任何输出段中
    const allKeys = segs.flatMap((s) =>
      s.kind === 'process_section' ? s.items.map((i) => i.key) : [s.item.key]
    );
    expect(allKeys).not.toContain('x1');
  });

  it('isFinalAnswer 仅标记最后一个正文段（纯正文轮次）', () => {
    const items: AssistantTimelineItem[] = [text('x1'), text('x2'), text('x3')];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const texts = segs.filter((s) => s.kind === 'text_narrative');
    expect(
      texts.map((s) => (s as { isFinalAnswer: boolean }).isFinalAnswer)
    ).toEqual([false, false, true]);
  });
});

describe('partitionTimelineSegments · 默认开合（R8 · 〔同组 §3.3〕组级表）', () => {
  it('终态过程组（其后有答复）→ foldable=true, defaultExpanded=false（封口自动折为组头一行）', () => {
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      tools('k1', ['read_file']),
      text('x1'),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const group = segs[0] as {
      foldable: boolean;
      defaultExpanded: boolean;
      isLive: boolean;
    };
    expect(group.foldable).toBe(true);
    expect(group.defaultExpanded).toBe(false);
    expect(group.isLive).toBe(false);
  });

  it('流式期答复前的封口组 → defaultExpanded=false 且 isLive=false（封口即按终态折；live 只属尾部生长组）', () => {
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      tools('k1', ['read_file']),
      tools('k2', ['run_command']),
      text('x1'),
    ];
    const segs = partitionTimelineSegments('m1', items, true, true);
    const group = segs[0] as {
      foldable: boolean;
      defaultExpanded: boolean;
      isLive: boolean;
    };
    expect(group.foldable).toBe(true);
    expect(group.defaultExpanded).toBe(false);
    expect(group.isLive).toBe(false);
  });

  it('尾部无正文 + turn live → foldable=true, defaultExpanded=true, isLive=true', () => {
    const items: AssistantTimelineItem[] = [
      text('x1'),
      thought('t2'),
      tools('k2', ['read_file']),
    ];
    const segs = partitionTimelineSegments('m1', items, true, true);
    const tail = segs[segs.length - 1] as {
      foldable: boolean;
      defaultExpanded: boolean;
      isLive: boolean;
    };
    expect(tail.foldable).toBe(true);
    expect(tail.defaultExpanded).toBe(true);
    expect(tail.isLive).toBe(true);
    // x1 其后有过程项 → 不是答复，已入组为叙述行：整轮只有一个组
    expect(segs).toHaveLength(1);
  });

  it('终态纯工具且 toolCount >= 2 → foldable=true, defaultExpanded=false', () => {
    const items: AssistantTimelineItem[] = [
      tools('k1', ['read_file', 'grep_search']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const seg = segs[0] as { foldable: boolean; defaultExpanded: boolean };
    expect(seg.foldable).toBe(true);
    expect(seg.defaultExpanded).toBe(false);
  });

  it('终态纯工具且 toolCount < 2 → foldable=true, defaultExpanded=false（单工具组有组头，同口径折）', () => {
    const items: AssistantTimelineItem[] = [tools('k1', ['read_file'])];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const seg = segs[0] as { foldable: boolean; defaultExpanded: boolean };
    expect(seg.foldable).toBe(true);
    expect(seg.defaultExpanded).toBe(false);
  });

  it('终态纯思考（单条）→ defaultExpanded=true（单思考特例：无组头、思考行自有终态折叠）', () => {
    const items: AssistantTimelineItem[] = [thought('t1', 3000)];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const seg = segs[0] as { foldable: boolean; defaultExpanded: boolean };
    expect(seg.foldable).toBe(true);
    expect(seg.defaultExpanded).toBe(true);
  });

  it('含失败工具的终态组 → defaultExpanded=false、metrics.errorCount 计数（失败组同口径折，失败数归组头）', () => {
    const items: AssistantTimelineItem[] = [
      {
        kind: 'tools',
        key: 'k1',
        items: [
          {
            kind: 'single' as const,
            tc: { id: 'k1-0', name: 'read_file', status: 'success' as const },
          },
          {
            kind: 'single' as const,
            tc: { id: 'k1-1', name: 'run_command', status: 'error' as const },
          },
          {
            kind: 'single' as const,
            tc: { id: 'k1-2', name: 'grep_search', status: 'error' as const },
          },
        ],
      },
      text('x1'),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const seg = segs[0] as {
      foldable: boolean;
      defaultExpanded: boolean;
      metrics: { hasError: boolean; errorCount: number };
    };
    expect(seg.foldable).toBe(true);
    expect(seg.defaultExpanded).toBe(false);
    expect(seg.metrics.hasError).toBe(true);
    expect(seg.metrics.errorCount).toBe(2);
  });

  it('状态通知切分：首组终态折（false）；通知后第二组补轻量组头、同口径终态折（false）（F1 · R-A）', () => {
    const items: AssistantTimelineItem[] = [
      tools('k1', ['read_file', 'grep_search']),
      injection('n1'),
      tools('k2', ['run_command', 'view_file']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const groups = segs.filter((s) => s.kind === 'process_section') as {
      id: string;
      defaultExpanded: boolean;
      isLive: boolean;
    }[];
    expect(groups).toHaveLength(2);
    expect(groups[0]!.id).toBe('m1-proc-0');
    expect(groups[0]!.defaultExpanded).toBe(false);
    expect(groups[1]!.id).toBe('m1-proc-1');
    expect(groups[1]!.defaultExpanded).toBe(false);
    expect(groups[1]!.isLive).toBe(false);
  });

  it('状态通知切分 + 流式：尾部组 isLive=true 且 defaultExpanded=true（跟随当前动作）', () => {
    const items: AssistantTimelineItem[] = [
      tools('k1', ['read_file', 'grep_search']),
      injection('n1'),
      tools('k2', ['run_command']),
    ];
    const segs = partitionTimelineSegments('m1', items, true, false);
    const groups = segs.filter((s) => s.kind === 'process_section') as {
      defaultExpanded: boolean;
      isLive: boolean;
    }[];
    expect(groups).toHaveLength(2);
    // 首组被注入封口 → 按终态折
    expect(groups[0]!.defaultExpanded).toBe(false);
    expect(groups[0]!.isLive).toBe(false);
    // 尾部生长组 → 展开
    expect(groups[1]!.isLive).toBe(true);
    expect(groups[1]!.defaultExpanded).toBe(true);
  });
});

describe('partitionTimelineSegments · 段级 forceExpanded 已删除（R9，防回潮）', () => {
  it('含 subagent 的组：metrics 整组聚合，段对象上不存在 forceExpanded 字段', () => {
    const items: AssistantTimelineItem[] = [
      tools('k1', ['invoke_subagent']),
      text('x1'),
      tools('k2', ['run_command']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    // x1 其后有过程项 → 入组叙述行；整轮一个组
    expect(segs).toHaveLength(1);
    const seg = segs[0] as {
      foldable: boolean;
      defaultExpanded: boolean;
      metrics: { subagentCount: number };
    };
    expect(seg.metrics.subagentCount).toBe(1);
    expect(seg.foldable).toBe(true);
    // R8：子 agent 不再构成强制展开——终态组按 §3.3 同口径自动折，
    // 分派卡是组内条目（头行恒可见于展开态），不回潮段级强展
    expect(seg.defaultExpanded).toBe(false);
    // 负向断言：段级强制展开字段已物理删除，不得以任何形式残留
    expect('forceExpanded' in seg).toBe(false);
  });

  it('含 subagent 的终态纯工具组 → 同样不存在 forceExpanded 字段', () => {
    const items: AssistantTimelineItem[] = [
      tools('k1', ['invoke_subagent', 'run_subagent', 'read_file']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const seg = segs[0] as { foldable: boolean; defaultExpanded: boolean };
    expect(seg.foldable).toBe(true);
    expect(seg.defaultExpanded).toBe(false);
    expect('forceExpanded' in seg).toBe(false);
  });

  /* ── 负向断言：任何组都不得携带段级强制展开 ── */
  it('负向断言：全部输出段均无 forceExpanded 字段', () => {
    const items: AssistantTimelineItem[] = [
      tools('k1', ['read_file', 'grep_search', 'run_command']),
      text('x1'),
      tools('k2', ['read_file', 'view_file']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    for (const seg of segs) {
      expect('forceExpanded' in seg).toBe(false);
      if (seg.kind === 'process_section') {
        expect(seg.metrics.subagentCount).toBe(0);
      }
    }
  });

  it('负向断言：子代理名不得被误分类为普通工具', () => {
    const items: AssistantTimelineItem[] = [
      tools('k1', ['invoke_subagent', 'wait_subagents']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const seg = segs[0] as {
      metrics: { subagentCount: number; toolCount: number };
    };
    expect(seg.metrics.subagentCount).toBe(2);
    expect(seg.metrics.toolCount).toBe(2); // subagentCount ⊆ toolCount
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 顶部工作时间唯一位置（用户裁决 · 2026-09-11）
 *   ── R9 后由整轮唯一过程组（或注入切分后的首组）承载
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('partitionTimelineSegments · 工作时间唯一位置（2026-09-11 用户裁决）', () => {
  function capsuleOf(items: AssistantTimelineItem[], isTurnLive = false) {
    const segs = partitionTimelineSegments('m1', items, isTurnLive, false);
    const seg = segs.find((s) => s.kind === 'process_section') as
      | {
          showWorkTime: boolean;
          startTime?: number;
          endTime?: number;
          isLive: boolean;
        }
      | undefined;
    return seg;
  }

  it('首个过程组（紧跟用户消息下方）→ showWorkTime=true（整轮唯一工作时间）', () => {
    // 无论是单一思考、单一工具、还是混合，首个过程组均承载整轮工作时间
    expect(capsuleOf([thought('t1', 1000)])?.showWorkTime).toBe(true);
    expect(capsuleOf([tools('k1', ['read_file'])])?.showWorkTime).toBe(true);
    expect(
      capsuleOf([thought('t1'), tools('k1', ['read_file'])])?.showWorkTime
    ).toBe(true);
    expect(
      capsuleOf([tools('k1', ['read_file', 'grep_search'])])?.showWorkTime
    ).toBe(true);
  });

  it('中间正文入组后仍由该唯一过程组承载 showWorkTime（组内含叙述行）', () => {
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      text('x1', '回答中间过渡正文'),
      tools('k1', ['run_command', 'run_command']),
    ];
    const segs = partitionTimelineSegments('m1', items, false, false);
    const procSections = segs.filter(
      (s) => s.kind === 'process_section'
    ) as Array<{
      id: string;
      showWorkTime: boolean;
      items: AssistantTimelineItem[];
    }>;
    // R9：中间正文不再切出第二组——x1 其后有过程项，是组内叙述行
    expect(procSections).toHaveLength(1);
    expect(procSections[0]?.showWorkTime).toBe(true);
    expect(procSections[0]?.items.map((it) => it.key)).toEqual([
      't1',
      'x1',
      'k1',
    ]);
  });

  it('组起止时间戳：终态取组内最早 / 最晚 startTime', () => {
    const t1: TimelineThoughtItem = { ...thought('t1'), startTime: 1_000 };
    const k1: TimelineToolsItem = {
      ...tools('k1', ['read_file']),
      startTime: 4_500,
    };
    const seg = capsuleOf([t1, k1]);
    expect(seg?.startTime).toBe(1_000);
    expect(seg?.endTime).toBe(4_500);
  });

  it('组起止时间戳：活跃态 endTime 必须为 undefined（跳秒）', () => {
    const t1: TimelineThoughtItem = { ...thought('t1'), startTime: 1_000 };
    const k1: TimelineToolsItem = {
      ...tools('k1', ['read_file']),
      startTime: 4_500,
    };
    const seg = capsuleOf([t1, k1], true);
    expect(seg?.isLive).toBe(true);
    expect(seg?.startTime).toBe(1_000);
    expect(seg?.endTime).toBeUndefined();
  });

  it('工作时间与思考时间解耦：工作时间承载整轮吐字完成耗时，思考时间保留内部思考耗时（2026-09-12 用户裁决）', () => {
    // 场景：思考耗时 15 秒（内部思考耗时），整轮从用户发消息到吐字完成总计 54 秒
    const thItem: TimelineThoughtItem = {
      ...thought('t1', 15_000),
      startTime: 10_000,
    };
    const textItem = text('ans', '这是吐字完成的最终回复正文');

    const segs = partitionTimelineSegments(
      'msg-decouple',
      [thItem, textItem],
      false,
      false,
      {
        msgTimestamp: 10_000,
        totalTurnDurationSec: 54,
      }
    );

    const procSeg = segs.find((s) => s.kind === 'process_section') as any;
    expect(procSeg).toBeDefined();
    expect(procSeg.showWorkTime).toBe(true);

    // 1. 外部工作时间：从消息起点到终点跨度为整轮 54 秒（54000ms）
    expect(procSeg.startTime).toBe(10_000);
    expect(procSeg.endTime).toBe(64_000);
    expect(procSeg.endTime - procSeg.startTime).toBe(54_000);
    expect(procSeg.metrics.totalDurationMs).toBe(54_000);

    // 2. 内部思考子项：纯粹保留自身思考耗时 15 秒（15000ms），绝不被整轮 54 秒污染
    const innerThought = procSeg.items.find(
      (it: any) => it.kind === 'thought'
    ) as any;
    expect(innerThought).toBeDefined();
    expect(innerThought.durationMs).toBe(15_000);
  });

  it('活跃态流式执行：startTime 以 msgTimestamp 为物理起点推进全轮工作时间', () => {
    const thItem: TimelineThoughtItem = {
      ...thought('t1'),
      startTime: 12_000,
    };
    const segs = partitionTimelineSegments('msg-live', [thItem], true, false, {
      msgTimestamp: 10_000,
    });
    const procSeg = segs.find((s) => s.kind === 'process_section') as any;
    expect(procSeg.startTime).toBe(10_000);
    expect(procSeg.endTime).toBeUndefined();
    expect(procSeg.isLive).toBe(true);
  });
});

describe('partitionTimelineSegments · 段边界与空输入', () => {
  it('空数组 → 空结果', () => {
    expect(partitionTimelineSegments('m1', [], false, false)).toEqual([]);
  });

  it('仅注入项 → 产出状态通知段（绝不落入可折叠过程组）', () => {
    const segs = partitionTimelineSegments(
      'm1',
      [injection('i1')],
      false,
      false
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe('state_notice');
    expect(segs[0]!.id).toBe('m1-state-0');
    // 负向断言：不得产出 process_section（状态通知被折叠吞掉即为缺陷）
    expect(segs.some((s) => s.kind === 'process_section')).toBe(false);
  });

  it('注入项作为物理界标：先冲掉前置过程组，本体常驻平铺，后续项另起一组', () => {
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
    // R8 §3.3 + F1 · R-A：首组（工作时间控制栏）终态默认折叠；注入
    // 后的组补轻量组头（非工作时间文案分支），同口径参与组级折——
    // 终态默认折叠，重开入口即该轻量组头，不再平铺整段过程内容
    const first = segs[0] as { foldable: boolean; defaultExpanded: boolean };
    expect(first.foldable).toBe(true);
    expect(first.defaultExpanded).toBe(false);
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
    const items: AssistantTimelineItem[] = [
      thought('t1'),
      tools('k1', ['read_file']),
      text('x1'),
    ];
    const a = partitionTimelineSegments('m1', items, true, true);
    const b = partitionTimelineSegments('m1', items, true, true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 终态组末点锚定（物理终点口径）
 *
 * 历史缺陷：segEnd 取 max(startTime)，等价于把「末项自身执行时长」整体抹掉——
 * 双工具组只显示首工具耗时，单工具组恒为 0。终态定格必须锚定物理终点。
 * ═══════════════════════════════════════════════════════════════════════════ */

function proc(items: AssistantTimelineItem[], isLive = false) {
  const segs = partitionTimelineSegments('m-end', items, isLive, false);
  const seg = segs[0];
  if (seg?.kind !== 'process_section') {
    throw new Error(`期望首个段为 process_section，实际：${seg?.kind}`);
  }
  return seg;
}

describe('partitionTimelineSegments · 终态组末点锚定（max(start + duration)）', () => {
  it('双工具组：endTime 计入末项执行时长（负向：不得退化为 max(startTime)）', () => {
    const t0 = 1_700_000_000_000;
    const seg = proc([
      { ...tools('a', ['read_file']), startTime: t0, durationMs: 3_000 },
      {
        ...tools('b', ['grep_search']),
        startTime: t0 + 3_000,
        durationMs: 5_000,
      },
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
      {
        ...tools('k1', ['run_command']),
        startTime: t0 + 5_000,
        durationMs: 7_000,
      },
    ]);

    expect(seg.endTime! - seg.startTime!).toBe(12_000);
  });

  it('末项缺 durationMs：终点退化为该项起点，且恒不小于组起点', () => {
    const t0 = 1_700_000_000_000;
    const seg = proc([
      { ...tools('a', ['read_file']), startTime: t0, durationMs: 2_000 },
      { ...tools('b', ['grep_search']), startTime: t0 + 2_000 },
    ]);

    expect(seg.endTime).toBe(t0 + 2_000);
    expect(seg.endTime!).toBeGreaterThanOrEqual(seg.startTime!);
  });

  it('无 startTime 但聚合有总耗时 → totalDurationMs 如实聚合（禁止恒 0 假象）', () => {
    // 组内无绝对时钟，仅携带 durationMs：组起点由分段器置空，
    // 此时「工作 xx 时间」退化为语义标签，但不得产出负时长。
    const seg = proc([thought('t1', 4_000), tools('k1', ['read_file'])]);
    expect(seg.startTime).toBeUndefined();
    expect(seg.metrics.totalDurationMs).toBe(4_000);
  });

  it('活跃组 endTime 恒为 undefined —— 跳秒口径不被终态公式污染', () => {
    const t0 = 1_700_000_000_000;
    const seg = proc(
      [
        { ...thought('t1', 1_000), startTime: t0 },
        {
          ...tools('k1', ['run_command']),
          startTime: t0 + 1_000,
          durationMs: 9_000,
        },
      ],
      true
    );

    expect(seg.isLive).toBe(true);
    expect(seg.endTime).toBeUndefined();
  });
});
