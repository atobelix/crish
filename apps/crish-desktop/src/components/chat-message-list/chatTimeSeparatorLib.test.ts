/**
 * 批 B ㉑ 时间分隔行口径：间隔 ≥5 分钟才挂行；基准只随已挂行推进；
 * 上下文载体不挂行也不入链；非法时间戳跳过。
 */
import { describe, expect, it } from 'vitest';
import {
  computeTimeSeparatorHosts,
  TIME_SEPARATOR_GAP_MS,
} from './chatTimeSeparatorLib';
import type { SessionMessage } from '../../store/types';

const MIN = 60 * 1000;
const T0 = 1_700_000_000_000;

function msg(id: string, ts: number): SessionMessage {
  return { id, sender: 'user', timestamp: ts, text: 'x' } as SessionMessage;
}

function carrier(id: string, ts: number): SessionMessage {
  // 真实载体形态（对齐 store/sessionInjectionMount 的判定）：assistant、
  // 空正文、仅携带 context-state 注入
  return {
    id,
    sender: 'assistant',
    timestamp: ts,
    text: '',
    injections: [{ id: `${id}-inj`, metadata: { mode: 'context-state' } }],
  } as unknown as SessionMessage;
}

describe('computeTimeSeparatorHosts（批 B ㉑）', () => {
  it('阈值常量 = 5 分钟', () => {
    expect(TIME_SEPARATOR_GAP_MS).toBe(5 * MIN);
  });

  it('首条带时间戳消息挂行（会话起点）', () => {
    const hosts = computeTimeSeparatorHosts([msg('a', T0), msg('b', T0 + MIN)]);
    expect([...hosts.keys()]).toEqual(['a']);
    expect(hosts.get('a')).toBe(T0);
  });

  it('间隔 < 5 分钟不挂；恰满 5 分钟挂', () => {
    const hosts = computeTimeSeparatorHosts([
      msg('a', T0),
      msg('b', T0 + 5 * MIN - 1),
      msg('c', T0 + 5 * MIN),
    ]);
    expect([...hosts.keys()]).toEqual(['a', 'c']);
  });

  it('基准只随已挂行推进：0 / 4 / 8 分钟 → 挂 0 与 8', () => {
    const hosts = computeTimeSeparatorHosts([
      msg('a', T0),
      msg('b', T0 + 4 * MIN),
      msg('c', T0 + 8 * MIN),
    ]);
    expect([...hosts.keys()]).toEqual(['a', 'c']);
  });

  it('连续长间隔逐段挂行，尾部短间隔不挂', () => {
    const hosts = computeTimeSeparatorHosts([
      msg('a', T0),
      msg('b', T0 + 6 * MIN),
      msg('c', T0 + 12 * MIN),
      msg('d', T0 + 13 * MIN),
    ]);
    expect([...hosts.keys()]).toEqual(['a', 'b', 'c']);
  });

  it('上下文载体不挂行也不入链（不更新基准）', () => {
    const hosts = computeTimeSeparatorHosts([
      msg('a', T0),
      carrier('x', T0 + 30 * MIN),
      msg('b', T0 + 34 * MIN),
    ]);
    expect([...hosts.keys()]).toEqual(['a', 'b']);
  });

  it('非法 / 缺失 / 不递增时间戳跳过且不更新基准', () => {
    const hosts = computeTimeSeparatorHosts([
      msg('a', T0),
      msg('nan', Number.NaN),
      msg('zero', 0),
      msg('back', T0 - 1000),
      msg('b', T0 + 5 * MIN),
    ]);
    expect([...hosts.keys()]).toEqual(['a', 'b']);
  });

  it('空列表 → 空集', () => {
    expect(computeTimeSeparatorHosts([]).size).toBe(0);
  });
});
