// 密码强度策略（与账号中心 `src/modules/auth/password-policy.ts` 同源；
// 移动端不共享包，规则保持逐条一致，改动需同步两端）。
//
// 硬性规则：去首尾空白后按 Unicode 码点计长度，8–128 位；
// 明显弱密码（短片段重复、整串连续、与邮箱前缀相同、常见弱口令）直接拒绝。
// 通过硬性规则后再按长度与字符类别给出 weak / medium / strong 提示，仅供展示。

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordStrength = 'weak' | 'medium' | 'strong';
export type PasswordRejectReason = 'too_short' | 'too_long' | 'too_weak';

export interface PasswordEvaluation {
  acceptable: boolean;
  strength: PasswordStrength;
  reason?: PasswordRejectReason;
}

const COMMON_WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'p@ssw0rd',
  'p@ssword',
  'qwertyui',
  'qwerty123',
  'qwer1234',
  'qwerasdf',
  '1qaz2wsx',
  'qazwsxedc',
  '1q2w3e4r',
  '1q2w3e4r5t',
  'asdfghjk',
  'asdf1234',
  'zxcvbnm1',
  'zxcvbnm123',
  'abc12345',
  'abcd1234',
  'a1234567',
  'aa123456',
  'a123456789',
  'iloveyou',
  'woaini1314',
  'woaini520',
  '5201314520',
  'admin123',
  'admin888',
  'administrator',
  'root1234',
  'test1234',
  'welcome1',
  'letmein1',
  '147258369',
  '159357456',
  '11223344',
  '123123123',
  '123qweasd',
  'qweasdzxc',
]);

const SEQUENCE_ALPHABETS = ['0123456789', 'abcdefghijklmnopqrstuvwxyz'];

export function normalizePassword(password: string): string {
  return password.trim();
}

export function evaluatePassword(
  rawPassword: string,
  context: { email?: string | null } = {}
): PasswordEvaluation {
  const password = normalizePassword(rawPassword);
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return reject('too_short');
  if (length > PASSWORD_MAX_LENGTH) return reject('too_long');
  if (isObviouslyWeak(password, context.email)) return reject('too_weak');
  return { acceptable: true, strength: strengthOf(password, length) };
}

function reject(reason: PasswordRejectReason): PasswordEvaluation {
  return { acceptable: false, strength: 'weak', reason };
}

function isObviouslyWeak(password: string, email?: string | null): boolean {
  const lower = password.toLowerCase();
  if (/^(.{1,4})\1+$/su.test(lower)) return true;
  if (isFullSequence(lower)) return true;
  if (COMMON_WEAK_PASSWORDS.has(lower)) return true;
  const normalizedEmail = (email ?? '').trim().toLowerCase();
  const localPart = normalizedEmail.split('@')[0] ?? '';
  return Boolean(
    localPart && (lower === localPart || lower === normalizedEmail)
  );
}

function isFullSequence(lower: string): boolean {
  return SEQUENCE_ALPHABETS.some((alphabet) => {
    const reversed = [...alphabet].reverse().join('');
    return alphabet.includes(lower) || reversed.includes(lower);
  });
}

function strengthOf(password: string, length: number): PasswordStrength {
  const classes = characterClassCount(password);
  if ((length >= 12 && classes >= 3) || (length >= 16 && classes >= 2)) {
    return 'strong';
  }
  if (classes >= 2 || length >= 12) return 'medium';
  return 'weak';
}

function characterClassCount(password: string): number {
  let lower = 0;
  let upper = 0;
  let digit = 0;
  let other = 0;
  for (const char of password) {
    if (/[a-z]/.test(char)) lower = 1;
    else if (/[A-Z]/.test(char)) upper = 1;
    else if (/[0-9]/.test(char)) digit = 1;
    else other = 1;
  }
  return lower + upper + digit + other;
}
