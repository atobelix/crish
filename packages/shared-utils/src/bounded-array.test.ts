import { describe, expect, it } from 'vitest';
import { BoundedArray } from './bounded-array';

describe('BoundedArray', () => {
  it('未满时按插入顺序保存，push 返回入参', () => {
    const a = new BoundedArray<number>(3);
    expect(a.slice()).toEqual([]);
    expect(a.push(1)).toBe(1);
    a.push(2);
    expect(a.length).toBe(2);
    expect(a.slice()).toEqual([1, 2]);
  });

  it('满后淘汰最旧元素（FIFO），长度恒为容量', () => {
    const a = new BoundedArray<string>(3);
    for (const x of ['a', 'b', 'c', 'd', 'e']) a.push(x);
    expect(a.length).toBe(3);
    expect(a.slice()).toEqual(['c', 'd', 'e']);
  });

  it('多轮回绕后顺序仍正确', () => {
    const a = new BoundedArray<number>(4);
    for (let i = 0; i < 23; i++) a.push(i);
    expect(a.slice()).toEqual([19, 20, 21, 22]);
  });

  it('slice 支持 start/end 与负索引（语义同 Array.prototype.slice）', () => {
    const a = new BoundedArray<number>(5);
    for (let i = 1; i <= 7; i++) a.push(i);
    expect(a.slice(1)).toEqual([4, 5, 6, 7]);
    expect(a.slice(1, 3)).toEqual([4, 5]);
    expect(a.slice(-2)).toEqual([6, 7]);
  });

  it('filter 只遍历有效元素且保持逻辑顺序', () => {
    const a = new BoundedArray<number>(3);
    expect(a.filter(() => true)).toEqual([]);
    for (let i = 1; i <= 5; i++) a.push(i);
    expect(a.filter((x) => x % 2 === 1)).toEqual([3, 5]);
    expect(a.filter(() => false)).toEqual([]);
  });

  it('容量 1：始终只保留最后一次 push', () => {
    const a = new BoundedArray<number>(1);
    a.push(1);
    a.push(2);
    expect(a.slice()).toEqual([2]);
    expect(a.length).toBe(1);
  });
});
