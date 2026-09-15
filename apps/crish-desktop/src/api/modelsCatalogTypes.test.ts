import { describe, expect, it } from 'vitest';
import {
  modelRefKey,
  normalizeModelRef,
  sameModelRef,
} from './modelsCatalogTypes';

describe('完整模型身份', () => {
  it('只去除两端空白，保留大小写和 Unicode', () => {
    expect(
      normalizeModelRef({ providerId: '  Acme ', modelId: ' 模型A ' })
    ).toEqual({ providerId: 'Acme', modelId: '模型A' });
  });
  it.each([
    [
      { providerId: 'Acme', modelId: 'Shared' },
      { providerId: 'acme', modelId: 'Shared' },
    ],
    [
      { providerId: 'Acme', modelId: 'Shared' },
      { providerId: 'Acme', modelId: 'SHARED' },
    ],
    [
      { providerId: 'a::b', modelId: 'c' },
      { providerId: 'a', modelId: 'b::c' },
    ],
    [
      { providerId: 'a","b', modelId: 'c' },
      { providerId: 'a', modelId: 'b","c' },
    ],
  ])('不同身份不能撞键：%j', (a, b) => {
    expect(modelRefKey(a)).not.toBe(modelRefKey(b));
    expect(sameModelRef(a, b)).toBe(false);
  });
  it('序列化保留完整二元组，允许无歧义解码', () => {
    expect(
      JSON.parse(modelRefKey({ providerId: ' A ', modelId: 'M::1' }))
    ).toEqual(['A', 'M::1']);
    expect(
      sameModelRef(
        { providerId: ' A ', modelId: 'M' },
        { providerId: 'A', modelId: ' M ' }
      )
    ).toBe(true);
  });
  it.each([
    { providerId: '', modelId: 'x' },
    { providerId: 'x', modelId: '　' },
  ])('空身份明确失败', (ref) => {
    expect(() => modelRefKey(ref)).toThrow('不能为空');
  });
});
