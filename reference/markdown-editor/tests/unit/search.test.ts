/**
 * B2 查找替换·搜索本体（src/core/search.ts）单元测试
 *
 * 覆盖：
 * 1. 词类判定（wordClassAt / isWordChar）：字母数字段/中文段/符号段/空白；
 * 2. 词边界（wordBoundary）：Ctrl+Arrow 词步长语义（段跳过/空白越过/
 *    行首行尾原地）——搜索全词判定与导航共用该模型的单源验证；
 * 3. 单行搜索（searchLine）：基础命中/大小写/全词/中文/符号/行首尾
 *    边界/空 query/含换行 query/全局偏移；
 * 4. 同步全文（searchAllSync）：跨行全局偏移累计（行长 + 1 口径）；
 * 5. 分批搜索（searchAll）：与同步结果一致、进度回调单调、batchSize
 *    切分、取消信号（AbortError）、batchSize=1 极端、同步调度器驱动。
 */
import { describe, it, expect } from 'vitest';
import {
  wordClassAt,
  isWordChar,
  wordBoundary,
  searchLine,
  searchAllSync,
  searchAll,
  type SearchProgress,
} from '../../src/core/search';

describe('词类判定（wordClassAt / isWordChar）', () => {
  it('字母数字与下划线 → word；中文区 → cjk；标点 → symbol；空白 → space', () => {
    expect(wordClassAt('a')).toBe('word');
    expect(wordClassAt('Z')).toBe('word');
    expect(wordClassAt('0')).toBe('word');
    expect(wordClassAt('_')).toBe('word');
    expect(wordClassAt('引')).toBe('cjk');
    expect(wordClassAt('擎')).toBe('cjk');
    expect(wordClassAt('日')).toBe('cjk'); // 假名区（兼容表意同族）
    expect(wordClassAt('+')).toBe('symbol');
    expect(wordClassAt('（')).toBe('cjk'); // 全角标点在 CJK 宽字符区 → cjk
    expect(wordClassAt(' ')).toBe('space');
    expect(wordClassAt('\t')).toBe('space');
    expect(wordClassAt('　')).toBe('space'); // 全角空格
    expect(wordClassAt('')).toBe('space'); // 空串 = 边界
  });

  it('词字符仅限字母数字下划线（CJK/符号/空白不阻挡全词边界）', () => {
    expect(isWordChar('a')).toBe(true);
    expect(isWordChar('9')).toBe(true);
    expect(isWordChar('_')).toBe(true);
    expect(isWordChar('引')).toBe(false);
    expect(isWordChar('+')).toBe(false);
    expect(isWordChar(' ')).toBe(false);
  });
});

describe('词边界 wordBoundary（Ctrl+Arrow 词步长）', () => {
  it('词中向左 → 段首；词首向左 → 原地不动', () => {
    expect(wordBoundary('hello world', 7, 'left')).toBe(6);
    // pos 5 = 'hello| world'（o 后空格前）→ 'hello' 段首；
    // pos 6 = 'hello |world'（空格后）→ 越过空白到前词段首
    expect(wordBoundary('hello world', 5, 'left')).toBe(0);
    expect(wordBoundary('hello world', 6, 'left')).toBe(0);
    expect(wordBoundary('hello', 3, 'left')).toBe(0);
    expect(wordBoundary('hello', 0, 'left')).toBe(0);
  });

  it('词中向右 → 段尾；段尾向右 → 原地不动（跨空白由调用方处理）', () => {
    expect(wordBoundary('hello world', 3, 'right')).toBe(5);
    expect(wordBoundary('hello world', 5, 'right')).toBe(11); // 段尾 → 越过空白到文末
    expect(wordBoundary('hello', 5, 'right')).toBe(5);
  });

  it('中文连续段整体跳过（无空格分词）', () => {
    // '高性能渲染引擎' 7 字：段 [0,7)
    expect(wordBoundary('高性能渲染引擎', 4, 'left')).toBe(0);
    expect(wordBoundary('高性能渲染引擎', 0, 'right')).toBe(7);
    // '渲染x引擎'：渲[0]染[1]x[2]引[3]擎[4]
    // 光标在 x 前（pos 2 = '染' 与 'x' 之间）→ 中文段整体跳过
    expect(wordBoundary('渲染x引擎', 2, 'left')).toBe(0);
    // 光标在 x 后（pos 3 = 'x' 与 '引' 之间）→ 越过 x 到中文段尾
    expect(wordBoundary('渲染x引擎', 3, 'right')).toBe(5);
    // 光标在 '引' 前 → x 段首；光标在 x 前 → x 段尾（中文字母异段）
    expect(wordBoundary('渲染x引擎', 3, 'left')).toBe(2);
    expect(wordBoundary('渲染x引擎', 2, 'right')).toBe(3);
  });

  it('符号段独立成段（标点/运算符）', () => {
    expect(wordBoundary('a+b', 3, 'left')).toBe(2); // 'b' 段首
    expect(wordBoundary('a+b', 2, 'left')).toBe(1); // '+' 段首
    expect(wordBoundary('a+b', 1, 'right')).toBe(2); // '+' 段尾
    expect(wordBoundary('a+b', 2, 'right')).toBe(3); // 'b' 段尾
  });

  it('空白越过与连续空白', () => {
    // 'ab   cd'：a0 b1 ' '2 ' '3 ' '4 c5 d6
    expect(wordBoundary('ab   cd', 6, 'left')).toBe(5); // 'cd' 段首
    expect(wordBoundary('ab   cd', 5, 'left')).toBe(0); // 越过空白到 'ab' 段首
    expect(wordBoundary('ab   cd', 2, 'right')).toBe(7); // 越过空白 + 'cd' 到文末
  });

  it('pos 越界钳制到行边界', () => {
    expect(wordBoundary('hi', 99, 'right')).toBe(2);
    expect(wordBoundary('hi', -5, 'left')).toBe(0);
  });
});

describe('单行搜索 searchLine', () => {
  it('基础命中：返回全局偏移（lineStart 平移），多命中升序', () => {
    expect(searchLine('abc abc abc', 100, 'abc')).toEqual([100, 104, 108]);
    expect(searchLine('abc', 0, 'abc')).toEqual([0]);
    expect(searchLine('abc', 7, 'b')).toEqual([8]);
  });

  it('大小写：默认不敏感，caseSensitive 时敏感', () => {
    // 原文 'Abc aBC'：lower 'abc abc' → 不敏感命中两处
    expect(searchLine('Abc aBC', 0, 'abc')).toEqual([0, 4]);
    // 敏感匹配逐词面精确（'ABC' 在原文不存在）
    expect(searchLine('Abc aBC', 0, 'Abc', { caseSensitive: true })).toEqual([
      0,
    ]);
    expect(searchLine('Abc aBC', 0, 'aBC', { caseSensitive: true })).toEqual([
      4,
    ]);
    expect(searchLine('Abc aBC', 0, 'ABC', { caseSensitive: true })).toEqual([]);
    expect(searchLine('Abc aBC', 0, 'aBc', { caseSensitive: true })).toEqual([]);
  });

  it('全词匹配：两侧非词字符才命中（行首行尾视为边界）', () => {
    // 'foo foo2 foo-bar'：0 ✓（右侧空格）、4 ✗（'foo2' 连续词）、
    // 9 ✓（右侧 '-'）——全词只命中真边界
    expect(searchLine('foo foo2 foo-bar', 0, 'foo', { wholeWord: true })).toEqual([
      0,
      9,
    ]);
    expect(searchLine('foofoo', 0, 'foo', { wholeWord: true })).toEqual([]);
    // 行尾边界：右侧无字符视为边界
    expect(searchLine('ab foo', 0, 'foo', { wholeWord: true })).toEqual([3]);
    // 行首边界：左侧无字符视为边界
    expect(searchLine('foo ab', 0, 'foo', { wholeWord: true })).toEqual([0]);
  });

  it('全词 + 中文：CJK 不阻挡边界（中文段内任意位置可命中）', () => {
    expect(searchLine('渲染引擎测试', 0, '引擎', { wholeWord: true })).toEqual([
      2,
    ]);
    expect(
      searchLine('渲染引擎引擎', 0, '引擎', { wholeWord: true })
    ).toEqual([2, 4]);
    // 但相邻字母数字阻挡（词字符边界）
    expect(searchLine('引擎x', 0, '引擎', { wholeWord: true })).toEqual([]);
    expect(searchLine('x引擎', 0, '引擎', { wholeWord: true })).toEqual([]);
  });

  it('符号查询在符号段内命中（两侧非词字符）', () => {
    expect(searchLine('a + b', 0, '+', { wholeWord: true })).toEqual([2]);
    // 符号紧邻词字符时全词不命中（'+' 不是词，但边界被词字符占位）
    expect(searchLine('a+b', 0, '+', { wholeWord: true })).toEqual([]);
  });

  it('全词 + 大小写组合', () => {
    // 'Foo foo Bar'：'Foo'（0）全词命中（右侧空格）；'foo'（4）同
    expect(searchLine('Foo foo Bar', 0, 'foo', { wholeWord: true })).toEqual([
      0,
      4,
    ]);
    expect(
      searchLine('Foo foo Bar', 0, 'foo', {
        wholeWord: true,
        caseSensitive: true,
      })
    ).toEqual([4]);
  });

  it('空 query / 含换行 query / 无命中 → 空数组', () => {
    expect(searchLine('abc', 0, '')).toEqual([]);
    expect(searchLine('abc', 0, 'a\nb')).toEqual([]);
    expect(searchLine('abc', 0, 'xyz')).toEqual([]);
  });
});

describe('同步全文 searchAllSync（跨行全局偏移）', () => {
  it('多行偏移累计（行长 + 1 换行符口径）', () => {
    // 行 0 'abc' [0,3) 行 1 'def' [4,7) 行 2 'ghi' [8,11)
    expect(searchAllSync(['abc', 'def', 'ghi'], 'e')).toEqual([5]);
    expect(searchAllSync(['abc', 'def', 'ghi'], 'd')).toEqual([4]);
    expect(searchAllSync(['abc', 'def', 'ghi'], 'gh')).toEqual([8]);
  });

  it('跨行同词：每行独立命中（行边界视为词边界）', () => {
    // 'foo\nfoo'：两行各一处，全局偏移 0 与 4
    expect(searchAllSync(['foo', 'foo'], 'foo', { wholeWord: true })).toEqual([
      0,
      4,
    ]);
  });

  it('空行参与偏移累计（零宽行）', () => {
    // 行 0 '' [0,0) 行 1 'ab' [1,3)
    expect(searchAllSync(['', 'ab'], 'b')).toEqual([2]);
  });

  it('空 query → 空数组（不分批不扫描）', () => {
    expect(searchAllSync(['a', 'b'], '')).toEqual([]);
  });
});

describe('分批搜索 searchAll（不卡帧 + 取消）', () => {
  // 同步调度器：批次内联执行（测试驱动确定性，脱离真实计时器）
  const syncScheduler = (fn: () => void) => fn();

  it('分批结果与同步版一致（batchSize 切分）', async () => {
    const lines = ['foo bar', 'Foo 引擎', 'foo-bar', '引擎引擎', ''];
    const sync = searchAllSync(lines, 'foo');
    for (const batchSize of [1, 2, 3, 10]) {
      const batched = await searchAll(lines, 'foo', {
        batchSize,
        scheduler: syncScheduler,
      });
      expect(batched).toEqual(sync);
    }
    // 全词 + 大小写选项在分批路径同样生效
    const ww = await searchAll(lines, 'foo', {
      wholeWord: true,
      batchSize: 2,
      scheduler: syncScheduler,
    });
    expect(ww).toEqual(searchAllSync(lines, 'foo', { wholeWord: true }));
    const cs = await searchAll(lines, 'Foo', {
      caseSensitive: true,
      batchSize: 2,
      scheduler: syncScheduler,
    });
    expect(cs).toEqual(searchAllSync(lines, 'Foo', { caseSensitive: true }));
  });

  it('进度回调：processedLines 单调递增、末批 done=true', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `行${i} foo`);
    const progress: SearchProgress[] = [];
    await searchAll(lines, 'foo', {
      batchSize: 30,
      scheduler: syncScheduler,
      onProgress: (p) => progress.push(p),
    });
    expect(progress.length).toBe(4); // 100 / 30 → 4 批
    // 单调递增直至总行数
    for (let i = 0; i < progress.length; i++) {
      expect(progress[i].processedLines).toBe(Math.min(30 * (i + 1), 100));
      if (i < progress.length - 1) expect(progress[i].done).toBe(false);
    }
    expect(progress[progress.length - 1].done).toBe(true);
    expect(progress[progress.length - 1].matchCount).toBe(100);
  });

  it('取消信号：abort 后 reject AbortError，不再产生后续批次', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `行${i}`);
    const controller = new AbortController();
    let batched = 0;
    const promise = searchAll(lines, '行', {
      batchSize: 100,
      signal: controller.signal,
      scheduler: (fn) => {
        // 前两批执行后立即取消（取消发生在下一批调度之前）
        batched++;
        if (batched === 2) controller.abort();
        fn();
      },
    });
    // DOMException 的 name 为 AbortError（message 为中文文案）
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    // 取消后不应再执行后续批次（第三批起全部被中止）
    expect(batched).toBeLessThanOrEqual(3);
  });

  it('signal 已 abort 时立即拒绝（不执行任何批次）', async () => {
    const controller = new AbortController();
    controller.abort();
    let executed = false;
    await expect(
      searchAll(['a'], 'a', {
        scheduler: () => {
          executed = true;
        },
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(executed).toBe(false);
  });

  it('空 query 立即 resolve 空数组（不登记取消/不调度）', async () => {
    const result = await searchAll(['a'], '');
    expect(result).toEqual([]);
  });

  it('batchSize=1 极端：逐行让出（每批一行）', async () => {
    const lines = ['a', 'b', 'c'];
    const batches: string[] = [];
    const result = await searchAll(lines, 'a', {
      batchSize: 1,
      scheduler: (fn) => {
        batches.push('yield');
        fn();
      },
    });
    expect(batches).toHaveLength(lines.length - 1); // 末批后不再让出
    expect(result).toEqual([0]);
  });
});
