// 配对文案：错误码 → 人话；锁定提示。
import type { PairingSnapshot } from '@/adapters/pairing/pairingController';

export const PAIR_LOCKED_TEXT =
  '尝试次数过多，请在桌面端重新开启配对（冷却 5 分钟）';

export const PAIR_ABANDON_DIALOG_TITLE = '放弃配对？';
export const PAIR_ABANDON_DIALOG_DESCRIPTION =
  '当前输入尚未提交，返回后将丢失。';

export const PAIR_ERROR_TEXT: Record<string, string> = {
  'pair.invalid_code': '配对码无效，请检查后重试',
  'pair.expired': '配对码已过期，请在桌面端重新生成',
  'pair.used': '配对码已被使用，请重新获取',
  'pair.too_many_attempts': '尝试次数过多，请稍后再试',
  'pair.challenge_mismatch': '配对验证失败，请重试',
  'pair.no_challenge': '配对验证失败，请重试',
  'pair.registry_full': '桌面端设备数已达上限，请先移除旧设备',
  'pair.key_agreement_failed': '密钥协商失败，请重试',
  'pair.key_material_missing': '密钥材料不完整，请重试',
  'pairing.transport_failed': '无法连接桌面，请确认地址与网络后重试',
  'pairing.persist_failed': '配对信息保存失败，请重试',
  'pairing.stale_credential': '配对信息不完整，请重新配对',
  'pairing.bad_challenge': '配对响应异常，请重试',
  'pairing.bad_ok': '配对响应异常，请重试',
  'pairing.internal': '配对失败，请重试',
};

export function pairErrorText(
  code: string,
  fallback = '配对失败，请重试'
): string {
  return PAIR_ERROR_TEXT[code] ?? fallback;
}

export function pairFailureText(snap: PairingSnapshot): string | null {
  const machine = snap.machine;
  if (machine.state === 'error') {
    return pairErrorText(machine.error?.code ?? snap.error?.code ?? '');
  }
  if (machine.state === 'locked') return PAIR_LOCKED_TEXT;
  return null;
}
