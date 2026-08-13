// 密钥原语接口单测（R2-03 密钥协商域）：接口契约与长度校验
// primitives.ts 只定义接口 + 常量 + 校验函数（不触碰第三方库），
// 本测试断言：X25519 材料长度常量、assertKeyBytes 合法/非法分支；
// 具体实现（noblePrimitives）的密码学行为由 keyAgreement 域测试覆盖。
import { assertKeyBytes, X25519_KEY_BYTES } from './primitives';

describe('primitives 常量与校验（R2-03 密钥协商域接口面）', () => {
  it('X25519 密钥材料长度 = 32 字节（RFC 7748）', () => {
    expect(X25519_KEY_BYTES).toBe(32);
  });

  it('assertKeyBytes：32 字节合法通过', () => {
    expect(() =>
      assertKeyBytes('publicKey', new Uint8Array(X25519_KEY_BYTES))
    ).not.toThrow();
  });

  it('assertKeyBytes：过短（31 字节）拒绝', () => {
    expect(() => assertKeyBytes('publicKey', new Uint8Array(31))).toThrow(
      '长度必须为 32 字节'
    );
  });

  it('assertKeyBytes：过长（33 字节）拒绝', () => {
    expect(() => assertKeyBytes('privateKey', new Uint8Array(33))).toThrow(
      '长度必须为 32 字节'
    );
  });

  it('assertKeyBytes：错误信息携带字段名与实际长度（调试可读）', () => {
    expect(() => assertKeyBytes('sessionKey', new Uint8Array(16))).toThrow(
      'sessionKey 长度必须为 32 字节（实际 16）'
    );
  });
});
