// @vitest-environment node
/**
 * 增量思考占位剥离器对拍测试（08-detail T1.6，2.3 等价性保障）。
 *
 * 单实现原则：finalFlush 直接复用全量版 stripThoughtPlaceholders；
 * 增量版只是「区域化分批应用同一正则」的调度层。本套件锁定：
 * - 收敛不变量：full strip(逐帧 concat(appended)) === full strip(全文)
 *   （D1 未换行尾行 / D2 区域边界空行折叠 / 跨区域占位行全部被收敛吸收）；
 * - 终态恒等：finalFlush() === stripThoughtPlaceholders(全文)（无偏差）；
 * - 幂等：同值帧 / StrictMode 双渲染场景不重复产出；
 * - 复位：文本收缩 / 等长替换 → resynced；
 * - doc-start 前缀 / BOM 头仅在首区域剥离。
 */
import { describe, expect, it } from 'vitest';
import {
  IncrementalThoughtStripper,
  stripThoughtPlaceholders,
} from './markdownRenderLite';

/** 占位/总结标题 fixture 片段（中文 + 英文 + 装饰变体） */
const PLACEHOLDER_FRAGMENTS = [
  '正在思考中…\n',
  '正在处理…\n',
  '## 本轮总结\n',
  '## 本轮工作总结 ·\n',
  '## 本回合小结：\n',
  '**本轮总结：**\n',
  '**本轮小结：**\n',
  '【本回合回顾】\n',
  '[本轮小结]\n',
  '本轮总结\n',
  'Round summary\n',
  '## Session summary\n',
  '**Turn summary**\n',
];

const BODY_FRAGMENTS = [
  '完成了第一阶段的实现。\n',
  '- 修复了流式渲染的帧预算问题\n',
  '- 补充了对拍测试\n',
  '```ts\nconst budget = 8192;\n```\n',
  '跨帧边界的占位行与总结标题需要被剥离。\n',
  '性能指标：吞吐 2.4x，延迟 -38%。\n',
  '正在思考中… 前缀行与正文同段时不应误剥。\n',
];

/** 空行边界（2/3/4 连换行）+ BOM 头 + doc-start 前缀长变体 */
const EDGE_FRAGMENTS = [
  '\n',
  '\n\n',
  '\n\n\n',
  '\n\n\n\n',
  '正在思考中……\n',
  '正在处理…\n',
];

function buildFixtureText(seed: number): string {
  // 固定 seed 的伪随机串接（LCG），保证测试可复现
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const parts: string[] = [];
  const count = 6 + Math.floor(rnd() * 10);
  for (let i = 0; i < count; i++) {
    const pool =
      rnd() < 0.5 ? PLACEHOLDER_FRAGMENTS : BODY_FRAGMENTS;
    parts.push(pool[Math.floor(rnd() * pool.length)]!);
    if (rnd() < 0.3) {
      parts.push(EDGE_FRAGMENTS[Math.floor(rnd() * EDGE_FRAGMENTS.length)]!);
    }
  }
  const text = parts.join('');
  return rnd() < 0.2 ? `\uFEFF${text}` : text;
}

/** 定长切分（模拟 rAF 帧），逐帧喂入 stripper 并拼接 appended */
function runStripperOver(text: string, frameSize: number, seed = 7): {
  appended: string;
  stripper: IncrementalThoughtStripper;
} {
  const stripper = new IncrementalThoughtStripper();
  const frames: string[] = [];
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s;
  };
  let pos = 0;
  while (pos < text.length) {
    const size = frameSize + (rnd() % 7);
    const end = Math.min(text.length, pos + size);
    const frame = stripper.next(text.slice(0, end));
    expect(frame.resynced).toBe(false);
    frames.push(frame.appended);
    pos = end;
  }
  return { appended: frames.join(''), stripper };
}

describe('IncrementalThoughtStripper 对拍（T1.6）', () => {
  it('收敛不变量：strip(逐帧 concat(appended)) === strip(全文)，偏差类型化', () => {
    // 偏差归一化：占位片段（D1 跨区域碎片，去装饰符）+ 空白行邻接（D2）
    // + 尾空白（增量不 trim，全量版 softTrim 会吃）
    const norm = (s: string) =>
      stripThoughtPlaceholders(s)
        .replace(/[#*[\]【】]{1,6}\s*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    for (let seed = 1; seed <= 40; seed++) {
      const text = buildFixtureText(seed);
      const { appended, stripper } = runStripperOver(text, 13, seed);
      const a = stripThoughtPlaceholders(appended);
      const b = stripThoughtPlaceholders(text);
      if (a === b) continue;
      // 类型化偏差（08-detail 2.3）：
      // - D1：跨区域占位行/未换行尾行原样展示（complete 前不剥离）；
      // - D2：区域边界空行折叠/前缀 \s 邻接差——仅空白行结构差异；
      // 归一化后正文必须全等；终态恒等（finalFlush === 全量版）恒成立。
      expect(norm(a), `seed ${seed} 偏差超出 D1/D2 类型`).toBe(norm(b));
      expect(stripper.finalFlush(), `seed ${seed} finalFlush 恒等`).toBe(b);
    }
  });

  it('尾行有换行时逐帧拼接 === 全量 strip（无 D1/D2 偏差）', () => {
    // 逐行整帧喂入：每个占位行完整落入完成区域 → 完成当帧即剥离
    const stripper = new IncrementalThoughtStripper();
    const full = '正文第一行\n## 本轮总结\n正文最后\n';
    const frames = [
      stripper.next('正文第一行\n'),
      stripper.next('正文第一行\n## 本轮总结\n'),
      stripper.next(full),
    ];
    const appended = frames.map((f) => f.appended).join('');
    // 增量不 trim 尾空白；收敛不变量 = strip 后全等
    expect(stripThoughtPlaceholders(appended)).toBe(
      stripThoughtPlaceholders(full)
    );
    expect(stripThoughtPlaceholders(appended)).toBe('正文第一行\n\n正文最后');
  });

  it('D1 偏差：末帧未换行尾行原样展示（complete 前不剥离，终态收敛）', () => {
    const stripper = new IncrementalThoughtStripper();
    stripper.next('正在思考中…\n');
    const f2 = stripper.next('正在思考中…\n## 本轮总结\n正文尾行未换行');
    // 前缀占位与总结标题已被剥（占位行被剥后留空行）；尾行原样展示（D1）
    expect(f2.appended).toBe('\n正文尾行未换行');
    expect(stripper.lastDisplay()).toBe('\n正文尾行未换行');
    // 终态收敛：finalFlush 全量版（前导空行被 softTrim 吃掉）
    expect(stripper.finalFlush()).toBe('正文尾行未换行');
  });

  it('跨区域边界的占位行：流式期原样（D1 延伸），收敛不变量成立', () => {
    // 占位行「## 本轮总结」被切分在帧边界（跨区域），增量期不剥离
    const stripper = new IncrementalThoughtStripper();
    stripper.next('A行\n## 本轮总');
    const f2 = stripper.next('A行\n## 本轮总结\nB行\n');
    expect(stripper.lastDisplay()).toContain('## 本轮总结');
    expect(f2.resynced).toBe(false);
    // 终态恒等：finalFlush 复用全量版，无偏差（占位行被剥后留空行；
    // 全量 softTrim 吃掉文档尾换行）
    expect(stripper.finalFlush()).toBe(stripThoughtPlaceholders('A行\n## 本轮总结\nB行\n'));
    expect(stripper.finalFlush()).toBe('A行\n\nB行');
  });

  it('D2 偏差：区域边界 3+ 空行折叠漏折，收敛不变量成立', () => {
    // 帧 1 区域以 \n\n 收尾 + 帧 2 区域以 \n 开头 → 跨区域 \n\n\n 漏折
    const stripper = new IncrementalThoughtStripper();
    const f1 = stripper.next('正文\n\n');
    expect(f1.appended).toBe('正文\n\n');
    const f2 = stripper.next('正文\n\n\n尾');
    expect(f2.appended).toBe('\n尾');
    // 增量拼接为 \n\n\n（漏折），全量收敛为 \n\n
    expect(stripThoughtPlaceholders(stripper.lastDisplay())).toBe('正文\n\n尾');
    expect(stripper.finalFlush()).toBe('正文\n\n尾');
  });

  it('BOM 头：首个区域即剥离（含首帧无完成行场景），不残留展示文本', () => {
    const stripper = new IncrementalThoughtStripper();
    const text = '\uFEFF正文第一行\n第二行\n';
    const frames: string[] = [];
    for (let i = 0; i < text.length; i += 4) {
      frames.push(
        stripper.next(text.slice(0, Math.min(i + 4, text.length))).appended
      );
    }
    // 4 字符小帧：首帧只有尾行（无完成行）→ BOM 仍被即时剥离
    expect(frames.join('')).toBe('正文第一行\n第二行\n');
    expect(stripper.finalFlush()).toBe(stripThoughtPlaceholders(text));
  });

  it('doc-start 前缀长变体：单区域包含头部时完成当帧剥离', () => {
    const stripper = new IncrementalThoughtStripper();
    const text = '\uFEFF正在思考中……\n正在处理…\n\n正文第一行\n';
    const frames: string[] = [];
    for (let i = 0; i < text.length; i += 32) {
      frames.push(
        stripper.next(text.slice(0, Math.min(i + 32, text.length))).appended
      );
    }
    expect(frames.join('')).toBe('正文第一行\n');
    expect(stripper.finalFlush()).toBe(stripThoughtPlaceholders(text));
  });

  it('同值帧幂等（StrictMode 双渲染等价）：返回上次帧、游标不推进', () => {
    const stripper = new IncrementalThoughtStripper();
    const f1 = stripper.next('正文\n');
    // 同值帧 → 幂等返回上次帧（append 去重由 StreamingTextBlock lastDeltaRef 守卫）
    const f1again = stripper.next('正文\n');
    expect(f1again.appended).toBe(f1.appended);
    expect(f1again.display).toBe(f1.display);
    expect(f1again.resynced).toBe(false);
    // 同值后继续推进：增量只含新增部分
    const f2 = stripper.next('正文\n下一行\n');
    expect(f2.appended).toBe('下一行\n');
    expect(stripper.lastDisplay()).toBe('正文\n下一行\n');
  });

  it('复位三路径：文本收缩 / 等长替换 → resynced；reset 后从零开始', () => {
    const stripper = new IncrementalThoughtStripper();
    stripper.next('第一行很长\n第二行\n');
    expect(stripper.getRawLen()).toBeGreaterThan(0);

    // 文本收缩 → resynced + 清空
    const shrink = stripper.next('第一行');
    expect(shrink.resynced).toBe(true);
    expect(shrink.appended).toBe('');
    expect(stripper.getRawLen()).toBe(0);

    // 收缩后重新流 → 正常处理
    const re = stripper.next('第一行\n新的内容\n');
    expect(re.resynced).toBe(false);
    expect(re.appended).toBe('第一行\n新的内容\n');

    // 等长替换（全新实例）→ resynced
    const s2 = new IncrementalThoughtStripper();
    s2.next('aaaaa\n');
    const replace = s2.next('bbbbb\n');
    expect(replace.resynced).toBe(true);

    // 显式 reset → lastDisplay 归零
    stripper.reset();
    expect(stripper.lastDisplay()).toBe('');
    expect(stripper.getRawLen()).toBe(0);
  });

  it('append 严格单调：各帧 appended 拼接与 lastDisplay 恒等（无重放/丢失）', () => {
    const text = buildFixtureText(42);
    const stripper = new IncrementalThoughtStripper();
    let joined = '';
    for (let i = 0; i < text.length; i += 9) {
      const frame = stripper.next(text.slice(0, Math.min(i + 9, text.length)));
      joined += frame.appended;
      expect(stripper.lastDisplay()).toBe(joined);
    }
  });

  it('finalFlush 恒等：=== stripThoughtPlaceholders(全文)（单实现原则）', () => {
    for (const seed of [1, 7, 13, 99]) {
      const text = buildFixtureText(seed);
      const stripper = new IncrementalThoughtStripper();
      for (let i = 0; i < text.length; i += 11) {
        stripper.next(text.slice(0, Math.min(i + 11, text.length)));
      }
      expect(stripper.finalFlush()).toBe(stripThoughtPlaceholders(text));
      // 显式传参版本
      expect(stripper.finalFlush(text)).toBe(stripThoughtPlaceholders(text));
    }
  });

  it('strip 结果缓存：同输入多次调用返回同值（N6 有界缓存）', () => {
    const text = '正在思考中…\n正文缓存测试\n';
    const a = stripThoughtPlaceholders(text);
    const b = stripThoughtPlaceholders(text);
    expect(a).toBe('正文缓存测试');
    expect(b).toBe(a);
    // 与增量 finalFlush 同输入同值
    const stripper = new IncrementalThoughtStripper();
    stripper.next(text);
    expect(stripper.finalFlush()).toBe(a);
  });
});
