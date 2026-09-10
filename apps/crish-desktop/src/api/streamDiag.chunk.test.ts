/**
 * streamDiag chunk 样本计数（D2 收敛回归）：
 * - recordChunkSample 累计 count / totalChars / maxChars
 * - largeChunks 在 length > 256 时递增
 * - resetChunkSampleStats 全量清零
 *
 * 状态为模块级单例 → 每个用例前强制 reset，避免跨用例串扰。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getChunkSampleStats,
  recordChunkSample,
  resetChunkSampleStats,
} from './streamDiag';

// LARGE_CHUNK_THRESHOLD 契约锚点（streamDiag.ts）：单 chunk 字符数超过 256 计一次 large。
const LARGE_CHUNK_THRESHOLD = 256;

beforeEach(() => {
  resetChunkSampleStats();
});

describe('recordChunkSample 累计统计', () => {
  it('空样本：count/totalChars/maxChars/avgChars/largeChunks 全为 0', () => {
    expect(getChunkSampleStats()).toEqual({
      count: 0,
      totalChars: 0,
      maxChars: 0,
      avgChars: 0,
      largeChunks: 0,
    });
  });

  it('单样本：count=1，totalChars=maxChars=样本长度，avg=样本长度', () => {
    recordChunkSample(42);
    expect(getChunkSampleStats()).toEqual({
      count: 1,
      totalChars: 42,
      maxChars: 42,
      avgChars: 42,
      largeChunks: 0,
    });
  });

  it('多样本：count/totalChars 累加，maxChars 取峰值，avgChars=total/count', () => {
    recordChunkSample(10);
    recordChunkSample(80);
    recordChunkSample(30);
    expect(getChunkSampleStats()).toEqual({
      count: 3,
      totalChars: 120,
      maxChars: 80,
      avgChars: 40,
      largeChunks: 0,
    });
  });

  it('后续更小样本不压低 maxChars', () => {
    recordChunkSample(500);
    recordChunkSample(5);
    const stats = getChunkSampleStats();
    expect(stats.maxChars).toBe(500);
    expect(stats.count).toBe(2);
  });
});

describe('largeChunks 阈值（>256）', () => {
  it('length === 256 不计入 largeChunks（阈值为严格大于）', () => {
    recordChunkSample(LARGE_CHUNK_THRESHOLD);
    expect(getChunkSampleStats().largeChunks).toBe(0);
  });

  it('length === 257 计入 largeChunks 一次', () => {
    recordChunkSample(LARGE_CHUNK_THRESHOLD + 1);
    expect(getChunkSampleStats().largeChunks).toBe(1);
  });

  it('混合样本：仅超阈值样本递增 largeChunks，count 仍全量累计', () => {
    recordChunkSample(10); // 普通
    recordChunkSample(256); // 边界，不算
    recordChunkSample(300); // large
    recordChunkSample(1024); // large
    const stats = getChunkSampleStats();
    expect(stats.count).toBe(4);
    expect(stats.totalChars).toBe(10 + 256 + 300 + 1024);
    expect(stats.maxChars).toBe(1024);
    expect(stats.largeChunks).toBe(2);
  });
});

describe('resetChunkSampleStats 清零', () => {
  it('累计后 reset → 全字段归零', () => {
    recordChunkSample(10);
    recordChunkSample(400);
    recordChunkSample(50);
    expect(getChunkSampleStats().count).toBe(3);

    resetChunkSampleStats();
    expect(getChunkSampleStats()).toEqual({
      count: 0,
      totalChars: 0,
      maxChars: 0,
      avgChars: 0,
      largeChunks: 0,
    });
  });

  it('reset 后重新累计从零开始（新 run 契约）', () => {
    recordChunkSample(999);
    resetChunkSampleStats();
    recordChunkSample(7);
    expect(getChunkSampleStats()).toEqual({
      count: 1,
      totalChars: 7,
      maxChars: 7,
      avgChars: 7,
      largeChunks: 0,
    });
  });
});
