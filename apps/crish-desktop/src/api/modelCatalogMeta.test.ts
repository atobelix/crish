// @vitest-environment jsdom
/**
 * modelCatalogMeta：**探测结果面**（`lastTest`）。
 *
 * 单轨收敛后的钉死语义：
 * - `crish_model_meta_v1` 只存 `lastTest`；**不是** enabled / contextWindow /
 *   能力 / 协议的声明真源，落盘 JSON 里不得出现这些字段；
 * - 键形 = 身份键 `modelRefKey`（JSON 二元组），禁止第三种拼接；
 * - `enabled` / `contextWindow` 唯一权威 = `modelsCatalogStore`。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { getProbeResult, recordProbeResult } from './modelCatalogMeta';

const META_KEY = 'crish_model_meta_v1';
const SRC_RAW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'modelCatalogMeta.ts'),
  'utf8'
);
/** 剥注释后的源码（形状守卫只看代码，不看文档） */
const SRC = SRC_RAW.replace(/\/\*[\s\S]*?\*\//g, (m) =>
  m.replace(/[^\n]/g, ' ')
).replace(/^\s*\/\/[^\n]*$/gm, '');

function lastTest(seed: number) {
  return { ok: true, latencyMs: seed, at: 1_700_000_000_000 + seed };
}

/** 落盘 JSON（本键唯一合法内容面 = 探测结果字典） */
function storedMap(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(META_KEY) ?? '{}') as Record<
    string,
    unknown
  >;
}

describe('modelCatalogMeta · 探测结果面（modelRefKey 键形）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('源码形状守卫：无 :: 拼接、无配置声明写口、无树写路由', () => {
    expect(SRC).not.toMatch(/\$\{[^}]+\}::\$\{/);
    expect(SRC).not.toMatch(/updateModel|updateTree|modelsCatalogStore/);
    expect(SRC).not.toMatch(/contextWindow\s*[:=]/);
  });

  it('recordProbeResult 写入 modelRefKey 键；getProbeResult 原样读回', () => {
    recordProbeResult('p1', 'm1', lastTest(1));
    const key = JSON.stringify(['p1', 'm1']);
    expect(storedMap()[key]).toEqual({ lastTest: lastTest(1) });
    expect(getProbeResult('p1', 'm1')).toEqual(lastTest(1));
  });

  it('身份含分隔符也不碰撞（JSON 二元组键）', () => {
    recordProbeResult('a::b', 'c', lastTest(1));
    recordProbeResult('a', 'b::c', lastTest(2));
    expect(getProbeResult('a::b', 'c')).toEqual(lastTest(1));
    expect(getProbeResult('a', 'b::c')).toEqual(lastTest(2));
  });

  it('无记录 → null；不同身份互不串扰', () => {
    recordProbeResult('p1', 'm1', lastTest(1));
    expect(getProbeResult('p1', 'm2')).toBeNull();
    expect(getProbeResult('p2', 'm1')).toBeNull();
  });

  it('重复写入覆盖旧值', () => {
    recordProbeResult('p1', 'm1', lastTest(1));
    recordProbeResult('p1', 'm1', lastTest(2));
    expect(getProbeResult('p1', 'm1')).toEqual(lastTest(2));
  });

  it('落盘内容只含 lastTest（探测结果面非配置真源）', () => {
    recordProbeResult('p1', 'm1', lastTest(1));
    const record = storedMap()[JSON.stringify(['p1', 'm1'])] as Record<
      string,
      unknown
    >;
    expect(Object.keys(record)).toEqual(['lastTest']);
  });
});
