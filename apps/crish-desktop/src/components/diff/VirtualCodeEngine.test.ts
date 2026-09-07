// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { LineBuffer } from './LineBuffer';
import { VirtualCodeEngine } from './VirtualCodeEngine';
describe('VirtualCodeEngine 双模解耦排版调度引擎契约测试', () => {
  it('非换行模式 (wordWrap = false)：自动判定为 isFixedRowMode = true，纯 O(1) 定位', () => {
    const text = 'line 1\nline 2\nline 3\nline 4\nline 5';
    const buffer = new LineBuffer(text);
    const engine = new VirtualCodeEngine(buffer, false, 800, 7.2);

    expect(engine.isFixedRowMode).toBe(true);
    expect(engine.totalVisualLines).toBe(5);

    // 行高 20px，总高 100px
    const vp = engine.computeViewport(0, 40, 20, 0);
    expect(vp.totalHeight).toBe(100);
    expect(vp.startIndex).toBe(0);
    expect(vp.endIndex).toBe(2);
    expect(vp.offsetTop).toBe(0);
  });

  it('短行文件无折行发生：自动判定为 isFixedRowMode = true', () => {
    // 容器宽 800px，字宽 7.2px -> charsPerLine ~ 111
    // 所有行长度 < 100
    const text = 'short line 1\nshort line 2\nshort line 3';
    const buffer = new LineBuffer(text);
    const engine = new VirtualCodeEngine(buffer, true, 800, 7.2);

    expect(engine.isFixedRowMode).toBe(true);
    expect(engine.totalVisualLines).toBe(3);
  });

  it('长行发生折行：正确累加视觉折行数并二分定位视口', () => {
    // charsPerLine ~ 10 (可用宽度 80px，字宽 8px)
    // 第 0 行 50 字符 -> ~5 视觉行
    // 第 1 行 5 字符 -> 1 视觉行
    const longLine = 'a'.repeat(50);
    const text = `${longLine}\nshort`;
    const buffer = new LineBuffer(text);
    const engine = new VirtualCodeEngine(buffer, true, 80, 8);

    expect(engine.isFixedRowMode).toBe(false);
    expect(engine.totalVisualLines).toBe(6); // 5 + 1

    // rowHeight = 20px -> totalHeight = 120px
    const vp = engine.computeViewport(0, 40, 20, 0);
    expect(vp.totalHeight).toBe(120);
    expect(vp.startIndex).toBe(0);
    expect(vp.endIndex).toBe(1); // 第 0 行占了 100px 高度，覆盖视口 40px
  });

  it('行高与视觉折行数完全解耦：不同 rowHeight 计算下无需重建引擎', () => {
    const text = 'a\nb\nc\nd';
    const buffer = new LineBuffer(text);
    const engine = new VirtualCodeEngine(buffer, false, 800, 7.2);

    // 默认 22px
    const vp22 = engine.computeViewport(0, 100, 22, 0);
    expect(vp22.totalHeight).toBe(4 * 22);

    // 动态实测为 34px (ui-size 放大)，直接传参即更新
    const vp34 = engine.computeViewport(0, 100, 34, 0);
    expect(vp34.totalHeight).toBe(4 * 34);
  });

  it('超大行数快速滚动二分定位性能测试 (30,000 行)', () => {
    const lines: string[] = [];
    for (let i = 0; i < 30000; i++) {
      lines.push(`const x_${i} = ${i};`);
    }
    const buffer = new LineBuffer(lines.join('\n'));

    const start = performance.now();
    const engine = new VirtualCodeEngine(buffer, true, 800, 7.2);
    // 模拟滚动到底部
    const vp = engine.computeViewport(30000 * 22 - 600, 600, 22, 20);
    const duration = performance.now() - start;

    expect(vp.endIndex).toBe(30000);
    expect(vp.totalHeight).toBe(30000 * 22);
    // 引擎初始化 + 视口定位总耗时 < 20ms
    expect(duration).toBeLessThan(20.0);
  });

  it('宽字符短行：字符数未超容量但显示宽度超容量 → 不得误判为等高模式', () => {
    // 容器宽 80px、字宽 8px → charsPerLine = 10
    // 行 0：6 个汉字（字符数 6 <= 10，但显示宽度 12 > 10 → 折成 2 视觉行）
    const text = '一二三四五六\nb';
    const buffer = new LineBuffer(text);
    const engine = new VirtualCodeEngine(buffer, true, 80, 8);

    // 若按字符数判定会误入 isFixedRowMode（totalVisualLines = 2）
    expect(engine.isFixedRowMode).toBe(false);
    expect(engine.totalVisualLines).toBe(3); // 2 + 1
  });

  it('稀疏模式下含宽字符短行按显示宽度累计视觉行数', () => {
    // cpl = 10；长行 15 字符 → 2 视觉行；'中文' 显示宽度 4 → 1 视觉行
    const text = 'a'.repeat(15) + '\n中文';
    const buffer = new LineBuffer(text);
    const engine = new VirtualCodeEngine(buffer, true, 80, 8);

    expect(engine.isFixedRowMode).toBe(false);
    expect(engine.totalVisualLines).toBe(3);
  });

  it('展开行按 MAX_EXPANDED_LINE_CHARS 切片估算视觉行数（折叠 3000 / 展开 20000）', () => {
    // cpl = 10；行 0 为 8000 字符超长行
    const longLine = 'a'.repeat(8000);
    const buffer = new LineBuffer(longLine + '\nb');

    // 折叠：仅按前 3000 字符估算 → ceil(3000/10)=300 + 1
    const collapsed = new VirtualCodeEngine(buffer, true, 80, 8);
    expect(collapsed.totalVisualLines).toBe(301);

    // 展开：8000 < 20000 → 按全量估算 → ceil(8000/10)=800 + 1
    const expanded = new VirtualCodeEngine(buffer, true, 80, 8, new Set([0]));
    expect(expanded.totalVisualLines).toBe(801);
  });
});
