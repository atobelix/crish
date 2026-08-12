// ANSI 白名单单测（R2UX-05-07 验收：ansi.ts 白名单单测 + 注入防护）
// 覆盖：白名单分类（SGR/光标/清屏）、剥离收敛、非法序列忽略（白名单拒绝）、
// OSC/独立 ESC/截断序列防残留、统计计数、长文本性能冒烟（无灾难性回溯）。
import {
  classifyCsiFinal,
  stripAnsi,
  stripAnsiDetailed,
  type AnsiCategory,
} from './ansi';

describe('白名单分类 classifyCsiFinal（R2UX-05-07：SGR/光标/清屏）', () => {
  it('SGR（m）入白名单', () => {
    expect(classifyCsiFinal('m')).toBe('sgr');
  });

  it('光标移动 final 入白名单（A/B/C/D/E/F/G/H/f）', () => {
    for (const final of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'f']) {
      expect(classifyCsiFinal(final)).toBe('cursor');
    }
  });

  it('清屏 final 入白名单（J/K）', () => {
    expect(classifyCsiFinal('J')).toBe('clear');
    expect(classifyCsiFinal('K')).toBe('clear');
  });

  it('非白名单 final（私有模式 h/l、滚动 r、未知 X/z 等）返回 null（忽略）', () => {
    for (const final of ['h', 'l', 'r', 'X', 'z', 'n', 'c', 'p', 'q']) {
      expect(classifyCsiFinal(final)).toBeNull();
    }
  });
});

describe('stripAnsi 剥离（SGR/光标/清屏 → 纯文本）', () => {
  it('SGR 颜色序列剥离：前后缀保留纯文本', () => {
    expect(stripAnsi('\x1b[31m红色\x1b[0m')).toBe('红色');
  });

  it('多参数 SGR（\x1b[1;32;44m）整体剥离', () => {
    expect(stripAnsi('\x1b[1;32;44mbold green\x1b[0m')).toBe('bold green');
  });

  it('光标移动序列剥离（\x1b[2A / \x1b[1;5H / \x1b[3B）', () => {
    expect(stripAnsi('上移\x1b[2A后')).toBe('上移后');
    expect(stripAnsi('\x1b[1;5H定位')).toBe('定位');
    expect(stripAnsi('\x1b[3B下移')).toBe('下移');
  });

  it('清屏序列剥离（\x1b[2J / \x1b[0K / \x1b[K）', () => {
    expect(stripAnsi('\x1b[2J清屏')).toBe('清屏');
    expect(stripAnsi('\x1b[0K清行')).toBe('清行');
    expect(stripAnsi('\x1b[K尾')).toBe('尾');
  });

  it('无转义文本原样返回', () => {
    expect(stripAnsi('普通文本 build 123')).toBe('普通文本 build 123');
  });
});

describe('stripAnsi 非法序列忽略（白名单拒绝，R2UX-05-07 防注入）', () => {
  it('私有模式序列（\x1b[?25l 隐藏光标）剥离不残留', () => {
    expect(stripAnsi('a\x1b[?25lb')).toBe('ab');
  });

  it('未知 final（\x1b[9999X）剥离不残留', () => {
    expect(stripAnsi('x\x1b[9999Xy')).toBe('xy');
  });

  it('滚动区序列（\x1b[3;5r）剥离', () => {
    expect(stripAnsi('\x1b[3;5r文本')).toBe('文本');
  });

  it('OSC 序列（ESC ] … BEL，如标题/超链接）剥离', () => {
    expect(stripAnsi('链接\x1b]8;;https://x\x07文案\x1b]8;;\x07')).toBe(
      '链接文案'
    );
  });

  it('独立 ESC（非 CSI/OSC）剥离', () => {
    expect(stripAnsi('a\x1bb')).toBe('ab');
  });

  it('截断序列（无 final，如流式半段 \x1b[31）剥离防残留', () => {
    expect(stripAnsi('半段\x1b[31')).toBe('半段');
  });

  it('多序列连续出现全部剥离（颜色 + 光标 + 清屏混合）', () => {
    const input = '\x1b[2J\x1b[H\x1b[32m就绪\x1b[0m\x1b[?25l';
    expect(stripAnsi(input)).toBe('就绪');
  });
});

describe('stripAnsiDetailed 统计', () => {
  it('stripped 计数含白名单内与非法序列', () => {
    const { text, stats } = stripAnsiDetailed(
      '\x1b[31m红\x1b[0m\x1b[2A\x1b[?25l'
    );
    expect(text).toBe('红');
    expect(stats.stripped).toBe(4);
  });

  it('白名单分类计数（sgr/cursor/clear）', () => {
    const { stats } = stripAnsiDetailed('\x1b[1m\x1b[2J\x1b[3B\x1b[0m');
    expect(stats.categories).toEqual({ sgr: 2, cursor: 1, clear: 1 });
  });

  it('纯文本零剥离', () => {
    const { text, stats } = stripAnsiDetailed('hello 世界');
    expect(text).toBe('hello 世界');
    expect(stats.stripped).toBe(0);
  });
});

describe('性能冒烟（无灾难性回溯，F3 §4.0 长行 JSON 日志安全）', () => {
  it('万字符长行 + 密集转义线性处理', () => {
    const longLine = `${'\x1b[32m'.repeat(200)}${'x'.repeat(9000)}${'\x1b[0m'.repeat(200)}`;
    const start = Date.now();
    const result = stripAnsi(longLine);
    const elapsed = Date.now() - start;
    expect(result).toBe('x'.repeat(9000));
    // 线性扫描冒烟：万字符量级应在数十毫秒内完成（宽松断言防慢机器误报）
    expect(elapsed).toBeLessThan(2000);
  });

  it('分类枚举与 AnsiCategory 类型键一致（防统计表漂移）', () => {
    const categories: AnsiCategory[] = ['sgr', 'cursor', 'clear'];
    const { stats } = stripAnsiDetailed('\x1b[1m\x1b[2A\x1b[2J');
    for (const key of categories) {
      expect(stats.categories[key]).toBeGreaterThanOrEqual(0);
    }
    expect(stats.categories).toEqual({ sgr: 1, cursor: 1, clear: 1 });
  });
});
