// 配对文案映射测试：错误码 → 人话、锁定态、未知码回落。
import {
  PAIR_LOCKED_TEXT,
  PAIR_ERROR_TEXT,
  pairErrorText,
  pairFailureText,
} from './pairingCopy';
import type { PairingSnapshot } from '@/adapters/pairing/pairingController';

function snap(overrides: Partial<PairingSnapshot> = {}): PairingSnapshot {
  return {
    machine: { state: 'idle' } as PairingSnapshot['machine'],
    error: null,
    sessionPhase: 'idle',
    ...overrides,
  } as PairingSnapshot;
}

describe('pairErrorText', () => {
  it('已知错误码返回对应人话', () => {
    expect(pairErrorText('pair.invalid_code')).toBe('配对码无效，请检查后重试');
    expect(pairErrorText('pair.expired')).toBe(
      '配对码已过期，请在桌面端重新生成'
    );
  });

  it('未知错误码返回缺省回落文案', () => {
    expect(pairErrorText('unknown.code')).toBe('配对失败，请重试');
  });

  it('支持自定义回落文案', () => {
    expect(pairErrorText('unknown.code', '自定义提示')).toBe('自定义提示');
  });

  it('映射表内每条都有非空文案（防漏译）', () => {
    for (const [code, text] of Object.entries(PAIR_ERROR_TEXT)) {
      if (text.length === 0) {
        throw new Error(`错误码 ${code} 缺少人话文案`);
      }
    }
  });
});

describe('pairFailureText', () => {
  it('machine 为 error 时优先取 machine.error.code', () => {
    const result = pairFailureText(
      snap({
        machine: {
          state: 'error',
          error: { code: 'pair.expired', message: '', retryable: true },
        } as PairingSnapshot['machine'],
        error: { code: 'pair.used', message: '', retryable: true },
      })
    );
    expect(result).toBe('配对码已过期，请在桌面端重新生成');
  });

  it('machine.error 缺失时回落到 snap.error.code', () => {
    const result = pairFailureText(
      snap({
        machine: { state: 'error' } as PairingSnapshot['machine'],
        error: { code: 'pair.used', message: '', retryable: true },
      })
    );
    expect(result).toBe('配对码已被使用，请重新获取');
  });

  it('两者都缺失时返回缺省文案', () => {
    const result = pairFailureText(
      snap({ machine: { state: 'error' } as PairingSnapshot['machine'] })
    );
    expect(result).toBe('配对失败，请重试');
  });

  it('locked 态返回锁定提示', () => {
    const result = pairFailureText(
      snap({ machine: { state: 'locked' } as PairingSnapshot['machine'] })
    );
    expect(result).toBe(PAIR_LOCKED_TEXT);
  });

  it('正常态返回 null（无失败提示）', () => {
    expect(pairFailureText(snap())).toBeNull();
  });
});
