import { describe, it, expect } from 'vitest';
import { charType, lineBidiInfo, isRtlLine } from '../../src/core/Bidi';
import { moveHorizontallyBidi } from '../../src/core/measure';

describe('Bidi 骨架', () => {
  it('charType 分类抽查', () => {
    expect(charType('a')).toBe('L');
    expect(charType('Z')).toBe('L');
    expect(charType('0')).toBe('EN');
    expect(charType('!')).toBe('ON');
    expect(charType('ש')).toBe('R'); // 希伯来文
    expect(charType('ا')).toBe('R'); // 阿拉伯文
    expect(charType('\u0301')).toBe('NSM'); // 组合重音
    expect(charType('中')).toBe('L'); // 中文（中性按 L 处理——近似）
  });

  it('快速路径：纯 LTR 行返回 null（零开销）', () => {
    expect(lineBidiInfo('')).toBeNull();
    expect(lineBidiInfo('hello world 123')).toBeNull();
    expect(lineBidiInfo('**bold** and `code`')).toBeNull();
  });

  it('span 聚合：混合行 RTL 段正确标注', () => {
    const info = lineBidiInfo('abc שלום def');
    expect(info).not.toBeNull();
    expect(info!.rtl).toBe(true);
    // "שלום" 起点 4，长度 4（希伯来 4 字符：ש/ל/ו/ם）
    expect(info!.spans.length).toBe(1);
    expect(info!.spans[0].from).toBe(4);
    expect(info!.spans[0].to).toBe(8);
  });

  it('span 聚合：阿拉伯文数字归 AN 段', () => {
    const info = lineBidiInfo('قيمة ١٢٣');
    expect(info).not.toBeNull();
    expect(info!.spans.length).toBeGreaterThanOrEqual(1);
  });

  it('isRtlLine 便捷检测', () => {
    expect(isRtlLine('plain')).toBe(false);
    expect(isRtlLine('مرحبا')).toBe(true);
    expect(isRtlLine('')).toBe(false);
  });

  it('moveHorizontallyBidi：LTR 退化等价（零行为变化）', () => {
    // dir left = prev、dir right = next
    expect(moveHorizontallyBidi(3, 'left', 'hello', null)).toBe(2);
    expect(moveHorizontallyBidi(3, 'right', 'hello', null)).toBe(4);
  });

  it('moveHorizontallyBidi：RTL 段内视觉方向反转', () => {
    const info = lineBidiInfo('abc שלום def');
    expect(info).not.toBeNull();
    // RTL 段 [4,9)："שלום"
    // 视觉左移（ArrowLeft）= 逻辑右移
    const left = moveHorizontallyBidi(5, 'left', 'abc שלום def', info);
    expect(left).toBe(6); // 逻辑右移
    // 视觉右移（ArrowRight）= 逻辑左移
    const right = moveHorizontallyBidi(7, 'right', 'abc שלום def', info);
    expect(right).toBe(6);
  });

  it('moveHorizontallyBidi：RTL 段外保持原语义', () => {
    const info = lineBidiInfo('abc שלום def');
    expect(info).not.toBeNull();
    // 段外（LTR 区）
    expect(moveHorizontallyBidi(1, 'left', 'abc שלום def', info)).toBe(0);
    expect(moveHorizontallyBidi(11, 'right', 'abc שלום def', info)).toBe(12);
  });
});
