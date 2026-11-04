// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NumericText, splitNumericText } from '../NumericText';

afterEach(cleanup);

describe('splitNumericText（文案切片，纯函数）', () => {
  it('计数文案：数字与文本交替切开', () => {
    expect(splitNumericText('24 项')).toEqual([
      { type: 'number', value: 24, decimals: 0 },
      { type: 'text', text: ' 项' },
    ]);
  });

  it('多数字：已搜索 2 次 · 已运行 10 条命令', () => {
    const segs = splitNumericText('已搜索 2 次 · 已运行 10 条命令');
    expect(segs.filter((s) => s.type === 'number')).toEqual([
      { type: 'number', value: 2, decimals: 0 },
      { type: 'number', value: 10, decimals: 0 },
    ]);
  });

  it('小数保留位数：1.2s / 45.3 秒', () => {
    expect(splitNumericText('1.2s')[0]).toEqual({
      type: 'number',
      value: 1.2,
      decimals: 1,
    });
    expect(splitNumericText('已思考 45.3 秒')[1]).toEqual({
      type: 'number',
      value: 45.3,
      decimals: 1,
    });
  });

  it('带符号前缀：+32 / -0 的符号留在文本段', () => {
    expect(splitNumericText('+32')).toEqual([
      { type: 'text', text: '+' },
      { type: 'number', value: 32, decimals: 0 },
    ]);
    expect(splitNumericText('-0')).toEqual([
      { type: 'text', text: '-' },
      { type: 'number', value: 0, decimals: 0 },
    ]);
  });

  it('前导零数字串不进滚轮（避免丢零改写原文）：11-02 09:05', () => {
    const segs = splitNumericText('11-02 09:05');
    const nums = segs.filter((s) => s.type === 'number');
    expect(nums).toEqual([{ type: 'number', value: 11, decimals: 0 }]);
    const text = segs
      .map((s) => (s.type === 'text' ? s.text : String(s.value)))
      .join('');
    expect(text).toBe('11-02 09:05');
  });

  it('无数字 / 空串：只有文本段或空', () => {
    expect(splitNumericText('空目录')).toEqual([
      { type: 'text', text: '空目录' },
    ]);
    expect(splitNumericText('')).toEqual([]);
  });

  it('超长数字串不进滚轮', () => {
    const segs = splitNumericText('1234567890123456');
    expect(segs).toEqual([{ type: 'text', text: '1234567890123456' }]);
  });

  it('切片还原：数字段按 decimals 回写后与原文逐字一致（不含千分位场景）', () => {
    for (const raw of ['L1–20 / 100 行', '1.5 KB', '3 条', '已读取 7 个文件']) {
      const back = splitNumericText(raw)
        .map((s) => (s.type === 'text' ? s.text : s.value.toFixed(s.decimals)))
        .join('');
      expect(back).toBe(raw);
    }
  });
});

describe('NumericText 组件', () => {
  it('无数字文案直出纯文本', () => {
    const { container } = render(<NumericText text="空目录" />);
    expect(container.textContent).toBe('空目录');
  });

  it('有数字：读屏文本含完整数字，文本段原样保留', () => {
    const { container, getByText } = render(<NumericText text="24 项" />);
    expect(getByText('24')).toBeDefined();
    expect(container.textContent).toContain(' 项');
  });

  it('数值变化时同序数字段原地更新（不重挂载整句）', () => {
    const { container, rerender } = render(<NumericText text="已搜索 2 次" />);
    const root = container.firstElementChild;
    rerender(<NumericText text="已搜索 3 次" />);
    expect(container.firstElementChild).toBe(root);
    expect(container.textContent).toContain('3');
  });
});
