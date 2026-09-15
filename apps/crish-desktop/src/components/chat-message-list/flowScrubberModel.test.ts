// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { VirtualScrollManager } from '../../api/VirtualScrollManager';
import {
  buildScrubberSegments,
  capScrubberSegments,
  countScrubberTicks,
  formatTickTooltip,
  isConversationFlowOn,
  readPurposeLabel,
  scrollToScrubberTarget,
  snippetFromUserText,
  wheelDeltaY,
} from './flowScrubberModel';

function msg(
  id: string,
  sender: 'user' | 'assistant',
  text = id,
  timestamp = 1
) {
  return { id, sender, text, timestamp };
}

describe('flowScrubberModel', () => {
  it('无消息 / 无用户气泡返回空（不画空柱）', () => {
    expect(buildScrubberSegments([], () => 100)).toEqual([]);
    expect(
      buildScrubberSegments([msg('a1', 'assistant')], () => 100)
    ).toEqual([]);
  });

  it('tick 数 = 用户气泡数，高度比按 VSM 像素而不是等高校', () => {
    const heights: Record<string, number> = {
      u1: 100,
      a1: 300,
      u2: 200,
    };
    const segs = buildScrubberSegments(
      [msg('u1', 'user', '问一'), msg('a1', 'assistant'), msg('u2', 'user', '问二')],
      (id) => heights[id] ?? 0
    );
    expect(countScrubberTicks(segs)).toBe(2);
    const ticks = segs.filter((s) => s.type === 'tick');
    expect(ticks[0]?.type === 'tick' && ticks[0].tick.heightPercent).toBeCloseTo(
      100 / 600
    );
    expect(ticks[1]?.type === 'tick' && ticks[1].tick.heightPercent).toBeCloseTo(
      200 / 600
    );
    expect(ticks[0]?.type === 'tick' && ticks[0].tick.flex).toBe(100);
    expect(ticks[1]?.type === 'tick' && ticks[1].tick.flex).toBe(200);
    const gaps = segs.filter((s) => s.type === 'gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.type === 'gap' && gaps[0].flex).toBe(300);
  });

  it('关插件 tooltip 只用 snippet；开插件拼 purpose/时间', () => {
    expect(
      formatTickTooltip({ snippet: '你好世界', flowOn: false, timeLabel: '14:00' })
    ).toBe('你好世界');
    expect(
      formatTickTooltip({
        snippet: '你好世界',
        flowOn: true,
        timeLabel: '14:00',
        purpose: '梳理 IPC',
      })
    ).toBe('梳理 IPC · 你好世界');
    expect(
      formatTickTooltip({ snippet: '你好世界', flowOn: true, timeLabel: '14:00' })
    ).toBe('14:00 · 你好世界');
  });

  it('snippet 折叠空白且截断', () => {
    expect(snippetFromUserText('  a   b  ')).toBe('a b');
    expect(snippetFromUserText('x'.repeat(120)).endsWith('…')).toBe(true);
  });

  it('wheel 行模式换算 36px', () => {
    expect(wheelDeltaY({ deltaY: 40, deltaMode: 0 })).toBe(40);
    expect(wheelDeltaY({ deltaY: 2, deltaMode: 1 })).toBe(72);
  });

  it('点 tick：DOM 在则 scrollIntoView，否则 VSM scrollTo', () => {
    const intoView = vi.fn();
    const row = document.createElement('article');
    row.setAttribute('data-msg-id', 'u1');
    row.scrollIntoView = intoView;
    const scroller = document.createElement('div');
    scroller.appendChild(row);
    const manager = new VirtualScrollManager(100);
    manager.syncOrder(['u1', 'u2']);
    scrollToScrubberTarget(scroller, 'u1', manager);
    expect(intoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });

    const scrollTo = vi.fn();
    const empty = {
      querySelector: () => null,
      clientHeight: 400,
      scrollTo,
    } as unknown as HTMLElement;
    manager.setActual('u1', 200);
    manager.setActual('u2', 200);
    scrollToScrubberTarget(empty, 'u2', manager);
    expect(scrollTo).toHaveBeenCalledWith({
      top: 148,
      behavior: 'smooth',
    });

    // 针对高度超过视口 50% 的长消息，断言采用 block: 'start' 顶部对齐，彻底防止开头被顶出视口遭裁切
    const tallRow = document.createElement('article');
    tallRow.setAttribute('data-msg-id', 'a_tall');
    const tallIntoView = vi.fn();
    tallRow.scrollIntoView = tallIntoView;
    Object.defineProperty(tallRow, 'offsetHeight', { value: 350, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true });
    scroller.appendChild(tallRow);
    scrollToScrubberTarget(scroller, 'a_tall', manager);
    expect(tallIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    });
  });

  it('conversation-flow 祖先与 purpose 节点读取', () => {
    const host = document.createElement('div');
    host.setAttribute('data-conversation-flow', 'on');
    const scroller = document.createElement('div');
    scroller.innerHTML =
      '<article data-msg-id="a1"><div data-flow-purpose aria-label="梳理 IPC">x</div></article>';
    host.appendChild(scroller);
    expect(isConversationFlowOn(scroller)).toBe(true);
    expect(readPurposeLabel(scroller, 'a1')).toBe('梳理 IPC');
    expect(readPurposeLabel(scroller, 'missing')).toBeUndefined();
  });

  it('buildScrubberSegments 提取随后的 assistantSnippet 并清洗 markdown', () => {
    const segs = buildScrubberSegments(
      [
        msg('u1', 'user', '### 如何实现无轨刻度？'),
        msg('a1', 'assistant', '**方案如下**：\n```ts\nconst a = 1;\n```\n非常简单。'),
      ],
      () => 100
    );
    const tickSeg = segs.find((s) => s.type === 'tick');
    expect(tickSeg).toBeDefined();
    if (tickSeg?.type === 'tick') {
      expect(tickSeg.tick.snippet).toBe('如何实现无轨刻度？');
      expect(tickSeg.tick.nextAssistantId).toBe('a1');
      expect(tickSeg.tick.assistantSnippet).toContain('方案如下');
      expect(tickSeg.tick.assistantSnippet).not.toContain('**');
    }
  });
});

describe('capScrubberSegments（有界刻度渲染）', () => {
  /** 构造 n 个「用户 + 助手」交替轮次的分段 */
  function segsOf(n: number) {
    const list = [];
    for (let i = 0; i < n; i++) {
      list.push(msg(`u${i}`, 'user', `问 ${i}`), msg(`a${i}`, 'assistant', `答 ${i}`));
    }
    return buildScrubberSegments(list, () => 100);
  }

  it('刻度数未超容量时原样返回（小会话零行为变化）', () => {
    const segs = segsOf(5);
    expect(countScrubberTicks(segs)).toBe(5);
    const capped = capScrubberSegments(segs, 5);
    expect(capped).toHaveLength(segs.length);
    expect(countScrubberTicks(capped)).toBe(5);
    const capped2 = capScrubberSegments(segs, 50);
    expect(countScrubberTicks(capped2)).toBe(5);
  });

  it('超出容量时按步长聚合，刻度数收敛到容量内', () => {
    const segs = segsOf(1000);
    expect(countScrubberTicks(segs)).toBe(1000);
    const capped = capScrubberSegments(segs, 50);
    const ticks = countScrubberTicks(capped);
    expect(ticks).toBeLessThanOrEqual(50);
    expect(ticks).toBeGreaterThan(0);
    // 聚合后只保留 tick 段（gap 在 DOM 中 display:none，无布局作用）
    expect(capped.every((s) => s.type === 'tick')).toBe(true);
  });

  it('每桶以首个刻度为代表，且保持原有顺序', () => {
    const segs = segsOf(10);
    const capped = capScrubberSegments(segs, 5);
    const ids = capped.map((s) => (s.type === 'tick' ? s.tick.id : ''));
    // stride = ceil(10/5) = 2 ⇒ 代表为 u0,u2,u4,u6,u8
    expect(ids).toEqual(['u0', 'u2', 'u4', 'u6', 'u8']);
  });

  it('带固定标记的刻度一律保留（降采样不得丢用户显式资产）', () => {
    const segs = segsOf(20);
    const pinned = new Set(['u1', 'u17']);
    const capped = capScrubberSegments(segs, 4, (id) => pinned.has(id));
    const ids = capped.map((s) => (s.type === 'tick' ? s.tick.id : ''));
    expect(ids).toContain('u1');
    expect(ids).toContain('u17');
    // 顺序仍为原始顺序
    const order = segsOf(20)
      .filter((s) => s.type === 'tick')
      .map((s) => (s.type === 'tick' ? s.tick.id : ''));
    const expected = order.filter((id) => ids.includes(id));
    expect(ids).toEqual(expected);
  });

  it('容量非法（<1）时视为不需要聚合，原样返回', () => {
    const segs = segsOf(30);
    expect(capScrubberSegments(segs, 0)).toHaveLength(segs.length);
  });
});
