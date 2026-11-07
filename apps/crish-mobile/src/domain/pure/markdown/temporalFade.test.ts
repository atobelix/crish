// apps/crish-mobile/src/domain/pure/markdown/temporalFade.test.ts
// 流式文本末端时间渐显模型纯逻辑单元测试（波 6 达标步）
// 钉版口径：渐显是时间维度的（birthTime + 幂曲线），不是空间位置梯度——
// 任一字素的透明度只由其出生时刻与当前时刻决定，与它在文本中的位置无关。

import {
  FADE_DURATION_MS,
  FADE_GAMMA,
  FADE_START_ALPHA,
  FADE_WINDOW_GRAPHEMES,
  fadeAlphaAt,
  partitionTemporalFade,
  resetGraphemeSegmenterForTest,
  splitGraphemes,
  withAlpha,
} from './temporalFade';

describe('fadeAlphaAt 幂曲线', () => {
  it('出生瞬间 = 起始透明度 0.22（不从 0 起步）', () => {
    expect(fadeAlphaAt(1000, 1000)).toBe(FADE_START_ALPHA);
    expect(FADE_START_ALPHA).toBe(0.22);
  });

  it('出生之前（时钟未达）钳制为起始透明度', () => {
    expect(fadeAlphaAt(1000, 400)).toBe(FADE_START_ALPHA);
  });

  it('满 FADE_DURATION_MS 后恰为 1，其后恒 1', () => {
    expect(fadeAlphaAt(1000, 1000 + FADE_DURATION_MS)).toBe(1);
    expect(fadeAlphaAt(1000, 1000 + FADE_DURATION_MS * 3)).toBe(1);
    expect(FADE_DURATION_MS).toBe(560);
  });

  it('中点值与幂曲线公式一致（gamma = 1.2）', () => {
    const mid = fadeAlphaAt(0, FADE_DURATION_MS / 2);
    const expected = 0.22 + 0.78 * Math.pow(0.5, FADE_GAMMA);
    expect(mid).toBeCloseTo(expected, 10);
    expect(FADE_GAMMA).toBe(1.2);
  });

  it('随时间单调不减', () => {
    let prev = 0;
    for (let t = 0; t <= FADE_DURATION_MS; t += 40) {
      const a = fadeAlphaAt(0, t);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
    expect(prev).toBe(1);
  });

  it('非有限 birthTime 视为已固化（= 1）', () => {
    expect(fadeAlphaAt(Number.NaN, 1000)).toBe(1);
    expect(fadeAlphaAt(Number.NEGATIVE_INFINITY, 1000)).toBe(1);
  });
});

describe('partitionTemporalFade 时间渐显切分', () => {
  const NOW = 100_000;

  it('空文本安全处理', () => {
    expect(partitionTemporalFade('', [NOW], NOW)).toEqual({
      solidPrefix: '',
      segments: [],
    });
  });

  it('无出生登记（空列表 / 全 null）→ 全量固化，无分段', () => {
    const text = '一段已经定稿的文本内容';
    expect(partitionTemporalFade(text, [], NOW).segments).toEqual([]);
    expect(partitionTemporalFade(text, [], NOW).solidPrefix).toBe(text);
    expect(
      partitionTemporalFade(text, [null, null, null], NOW).segments
    ).toEqual([]);
  });

  it('出生登记全部过期（> 560ms）→ 全量固化', () => {
    const text = '流式早已结束的文本';
    const births = Array.from({ length: 30 }, () => NOW - FADE_DURATION_MS - 1);
    const res = partitionTemporalFade(text, births, NOW);
    expect(res.solidPrefix).toBe(text);
    expect(res.segments).toEqual([]);
  });

  it('刚出生的字素进入分段且透明度在起始值附近（与位置无关，只与时间有关）', () => {
    const text = '前缀已经稳定下来的长文本，末尾是刚写出的字';
    // 全部字素同一时刻出生：整段窗口同透明度 → 合并为一段
    const births = Array.from({ length: 60 }, () => NOW);
    const res = partitionTemporalFade(text, births, NOW);
    expect(res.segments.length).toBe(1);
    expect(res.segments[0]!.alpha).toBeGreaterThanOrEqual(FADE_START_ALPHA);
    expect(res.segments[0]!.alpha).toBeLessThan(FADE_START_ALPHA + 0.04);
    // 字符守恒
    expect(res.solidPrefix + res.segments.map((s) => s.text).join('')).toBe(
      text
    );
  });

  it('出生登记列表长于文本时自末尾对齐配对（时间口径，非空间梯度）', () => {
    // 登记列表（60 条）长于文本（30 字素）：配对恒自末尾起算，
    // 只有出生时刻新鲜的末位字素进入分段，其余按各自时刻固化
    const births = Array.from({ length: 60 }, (_, i) =>
      i === 59 ? NOW : NOW - FADE_DURATION_MS - 100
    );
    const text = '字'.repeat(30);
    const res = partitionTemporalFade(text, births, NOW);
    // 只有最后一个字素未固化
    const segText = res.segments.map((s) => s.text).join('');
    expect(segText).toBe('字');
    expect(res.solidPrefix).toBe('字'.repeat(29));
  });

  it('透明度自分段起点向末尾单调不增（出生越晚越淡）', () => {
    const text = '渐显窗口内的文本内容逐字写出直到末尾';
    // 出生时刻自旧向新线性递增（每字晚 40ms）
    const graphemes = splitGraphemes(text);
    const births = graphemes.map(
      (_, i) => NOW - (graphemes.length - i) * 40
    );
    const res = partitionTemporalFade(text, births, NOW);
    expect(res.segments.length).toBeGreaterThan(1);
    for (let i = 0; i < res.segments.length - 1; i++) {
      expect(res.segments[i]!.alpha).toBeGreaterThan(
        res.segments[i + 1]!.alpha
      );
    }
    expect(res.solidPrefix + res.segments.map((s) => s.text).join('')).toBe(
      text
    );
  });

  it('渐显窗口封顶：窗口外字素即使有新鲜出生登记也已固化', () => {
    const text = '长'.repeat(200);
    const births = Array.from({ length: 200 }, () => NOW); // 全部刚出生
    const res = partitionTemporalFade(text, births, NOW);
    const segGraphemes = splitGraphemes(
      res.segments.map((s) => s.text).join('')
    ).length;
    expect(segGraphemes).toBeLessThanOrEqual(FADE_WINDOW_GRAPHEMES);
    expect(splitGraphemes(res.solidPrefix).length).toBe(
      200 - segGraphemes
    );
  });

  it('出生登记短于窗口时，仅末尾有登记者参与渐显', () => {
    const text = '一二三四五六七八九十';
    const births = [NOW, NOW, NOW]; // 仅末 3 字有登记
    const res = partitionTemporalFade(text, births, NOW);
    expect(res.solidPrefix).toBe('一二三四五六七');
    expect(res.segments.map((s) => s.text).join('')).toBe('八九十');
  });

  it('字符守恒：Emoji 与国旗修饰符不被从中断开', () => {
    const text = '这是测试文本前缀'.repeat(3) + '科技改变未来👩‍💻🇨🇳✨🎉';
    const graphemes = splitGraphemes(text);
    const births = graphemes.map((_, i) =>
      i >= graphemes.length - 6 ? NOW : null
    );
    const res = partitionTemporalFade(text, births, NOW);
    expect(res.solidPrefix + res.segments.map((s) => s.text).join('')).toBe(
      text
    );
    for (const seg of res.segments) {
      expect(seg.text).not.toContain('\uFFFD');
    }
    // 末 6 字素整体在分段内（👩‍💻 等复合字素不被拆开）
    expect(res.segments.map((s) => s.text).join('')).toBe('未来👩‍💻🇨🇳✨🎉');
  });

  it('超长文本 (10 万字） 常数级耗时且字符守恒、分段数有界', () => {
    const longText = '稳定文本前缀'.repeat(16_000) + '末端正在生成的内容';
    const births = Array.from({ length: 64 }, () => NOW);
    const start = Date.now();
    const res = partitionTemporalFade(longText, births, NOW);
    expect(Date.now() - start).toBeLessThan(50);
    expect(res.solidPrefix + res.segments.map((s) => s.text).join('')).toBe(
      longText
    );
    expect(res.segments.length).toBeLessThanOrEqual(25);
  });

  it('时间推进后同一字素并回稳定前缀（渐显完成即固化）', () => {
    const text = '会随时间完全显形的文本';
    const births = Array.from({ length: 30 }, () => 1000);
    const early = partitionTemporalFade(text, births, 1000);
    expect(early.segments.length).toBeGreaterThan(0);
    const late = partitionTemporalFade(
      text,
      births,
      1000 + FADE_DURATION_MS + 1
    );
    expect(late.solidPrefix).toBe(text);
    expect(late.segments).toEqual([]);
  });
});

describe('withAlpha 颜色 alpha 派生', () => {
  it('6 位 hex 派生 rgba', () => {
    expect(withAlpha('#171717', 0.5)).toBe('rgba(23, 23, 23, 0.5)');
    expect(withAlpha('#ececec', 0.22)).toBe('rgba(236, 236, 236, 0.22)');
  });

  it('3 位 hex 展开派生', () => {
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
  });

  it('alpha ≥ 1 原样返回（与定稿完全同色）', () => {
    expect(withAlpha('#171717', 1)).toBe('#171717');
    expect(withAlpha('rgba(1, 2, 3, 0.7)', 1)).toBe('rgba(1, 2, 3, 0.7)');
  });

  it('rgba 输入的既有 alpha 相乘', () => {
    expect(withAlpha('rgba(10, 20, 30, 0.5)', 0.5)).toBe(
      'rgba(10, 20, 30, 0.25)'
    );
  });

  it('8 位 hex 的既有 alpha 相乘', () => {
    // #00000080 自带 alpha ≈ 0.502，乘 0.5 ≈ 0.251
    expect(withAlpha('#00000080', 0.5)).toBe('rgba(0, 0, 0, 0.251)');
  });

  it('无法解析的格式原样返回（不臆造颜色）', () => {
    expect(withAlpha('transparent', 0.5)).toBe('transparent');
    expect(withAlpha('var(--ink)', 0.5)).toBe('var(--ink)');
  });
});

describe('splitGraphemes（自旧模块迁入，行为不变）', () => {
  afterEach(() => {
    resetGraphemeSegmenterForTest();
  });

  it('对 Emoji 复合字符簇保真切分', () => {
    expect(splitGraphemes('A👩‍💻B')).toEqual(['A', '👩‍💻', 'B']);
  });

  it('同一模块内 Intl.Segmenter 只构造一次', () => {
    resetGraphemeSegmenterForTest();
    const Original = Intl.Segmenter;
    const ctor = jest.fn(function (
      this: Intl.Segmenter,
      locales?: ConstructorParameters<typeof Intl.Segmenter>[0],
      options?: ConstructorParameters<typeof Intl.Segmenter>[1]
    ) {
      return new Original(locales, options);
    });
    Object.defineProperty(Intl, 'Segmenter', {
      configurable: true,
      writable: true,
      value: ctor,
    });
    try {
      expect(splitGraphemes('ab')).toEqual(['a', 'b']);
      expect(splitGraphemes('cd')).toEqual(['c', 'd']);
      expect(splitGraphemes('A👩‍💻B')).toEqual(['A', '👩‍💻', 'B']);
      expect(ctor).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(Intl, 'Segmenter', {
        configurable: true,
        writable: true,
        value: Original,
      });
    }
  });

  it('Intl.Segmenter 不可用时回退 Array.from', () => {
    resetGraphemeSegmenterForTest();
    const Original = Intl.Segmenter;
    Object.defineProperty(Intl, 'Segmenter', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    try {
      const text = 'A👩‍💻B';
      expect(splitGraphemes(text)).toEqual(Array.from(text));
    } finally {
      Object.defineProperty(Intl, 'Segmenter', {
        configurable: true,
        writable: true,
        value: Original,
      });
    }
  });
});
