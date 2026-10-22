import { describe, expect, it } from 'vitest';
import { validateStatusTransition } from './StatusTransitionGuard';

type Status = 'queued' | 'processing' | 'completed' | 'error' | 'cancelled';
const ALL: readonly Status[] = [
  'queued',
  'processing',
  'completed',
  'error',
  'cancelled',
];

/** 无需 force 即放行的转换（与守卫表逐条对齐）。 */
const NORMAL: ReadonlyArray<[Status, Status]> = [
  ['queued', 'processing'],
  ['queued', 'cancelled'],
  ['processing', 'completed'],
  ['processing', 'error'],
  ['processing', 'cancelled'],
  ['completed', 'processing'],
  ['error', 'processing'],
];

/** 仅 force=true 才放行的额外转换（自愈收束 / 串行守卫排队 / 重试）。 */
const FORCE_ONLY: ReadonlyArray<[Status, Status]> = [
  ['queued', 'completed'],
  ['queued', 'error'],
  ['processing', 'queued'],
  ['error', 'completed'],
  ['cancelled', 'processing'],
];

const key = (from: string, to: string) => `${from}->${to}`;
const normalSet = new Set(NORMAL.map(([f, t]) => key(f, t)));
const forceSet = new Set([
  ...normalSet,
  ...FORCE_ONLY.map(([f, t]) => key(f, t)),
]);

describe('validateStatusTransition', () => {
  it.each(NORMAL)('普通模式放行 %s → %s', (from, to) => {
    expect(() => validateStatusTransition(from, to)).not.toThrow();
    expect(() => validateStatusTransition(from, to, true)).not.toThrow();
  });

  it.each(FORCE_ONLY)('%s → %s 普通模式拒绝、force 放行', (from, to) => {
    expect(() => validateStatusTransition(from, to)).toThrow(
      `消息状态非法转换: ${from} → ${to}`
    );
    expect(() => validateStatusTransition(from, to, true)).not.toThrow();
  });

  it('全矩阵：除表内路径外一律拒绝（含自环），force 也不能越权', () => {
    const rejectedNormal: string[] = [];
    const rejectedForce: string[] = [];
    for (const from of ALL) {
      for (const to of ALL) {
        const k = key(from, to);
        let okNormal = true;
        let okForce = true;
        try {
          validateStatusTransition(from, to);
        } catch {
          okNormal = false;
        }
        try {
          validateStatusTransition(from, to, true);
        } catch {
          okForce = false;
        }
        expect(okNormal).toBe(normalSet.has(k));
        expect(okForce).toBe(forceSet.has(k));
        if (!okNormal) rejectedNormal.push(k);
        if (!okForce) rejectedForce.push(k);
      }
    }
    // 自环在任何模式下都不是合法转换（调用方需自行短路同状态写入）
    for (const s of ALL) {
      expect(rejectedForce).toContain(key(s, s));
    }
    // cancelled 是普通模式下的终态：无任何出边
    expect(ALL.filter((to) => normalSet.has(key('cancelled', to)))).toEqual([]);
  });

  it('force 拒绝时错误信息带 (force) 标注，便于定位强制路径', () => {
    expect(() =>
      validateStatusTransition('cancelled', 'completed', true)
    ).toThrow('消息状态非法转换: cancelled → completed (force)');
  });

  it('未知 / 空的源状态：普通与 force 模式都拒绝', () => {
    expect(() => validateStatusTransition('', 'processing')).toThrow(
      '消息状态非法转换:  → processing'
    );
    expect(() => validateStatusTransition('', 'completed', true)).toThrow(
      '(force)'
    );
    expect(() =>
      validateStatusTransition('streaming', 'completed', true)
    ).toThrow('streaming → completed (force)');
  });

  it('未知目标状态被拒绝', () => {
    expect(() => validateStatusTransition('processing', 'done')).toThrow(
      'processing → done'
    );
  });
});
