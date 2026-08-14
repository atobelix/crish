// 证书指纹一致性验证（pairingWiring 子模块）

import {
  checkHostFingerprint as protoCheckHostFingerprint,
  isValidTlsFingerprint,
  type FingerprintCheck,
} from '@/pairing/pairProtocol';

export { isValidTlsFingerprint, type FingerprintCheck };

/**
 * 纯粹的双信道下发指纹一致性判断（O(1) 纯函数，解决原代码将 challenge 下发值当做 stored 传入的语义错位）。
 * challengeFp: pair.challenge 权威载体下发的指纹
 * okFp: pair.ok 扩展下发的指纹
 * 返回：若两信道均有值但内容不一致返回 false；其余情况（单信道下发或两信道一致）返回 true。
 */
export function fingerprintsAgree(
  challengeFp: string | null | undefined,
  okFp: string | null | undefined
): boolean {
  if (!challengeFp || !okFp) return true;
  return challengeFp.trim().toLowerCase() === okFp.trim().toLowerCase();
}

/**
 * 封装底层的存储指纹比对逻辑，用于 finalizePairing 阶段
 */
export function verifyStoredFingerprint(
  stored: string | undefined,
  delivered: string | undefined
): FingerprintCheck {
  return protoCheckHostFingerprint(stored, delivered);
}
