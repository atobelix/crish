/**
 * 账号界面的前端校验规则与常量（纯函数，无副作用）。
 * 密码规则与账号中心 `src/modules/auth/password-policy.ts` 同源：
 * 8–128 码点、拒绝明显弱口令、按字符类别给出强度提示。
 */

/** 邮件验证码位数 */
export const ACCOUNT_CODE_LENGTH = 6;
/** 新密码最少位数 */
export const ACCOUNT_PASSWORD_MIN_LENGTH = 8;
/** 新密码最多位数（按 Unicode 码点） */
export const ACCOUNT_PASSWORD_MAX_LENGTH = 128;
/** 验证码重新发送冷却秒数 */
export const ACCOUNT_RESEND_SECONDS = 60;
/** 头像文件大小上限（字节） */
export const ACCOUNT_AVATAR_MAX_BYTES = 3 * 1024 * 1024;
/** 头像允许的 MIME 类型 */
export const ACCOUNT_AVATAR_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export type AccountPasswordStrength = 'weak' | 'medium' | 'strong';
export type AccountPasswordRejectReason = 'too_short' | 'too_long' | 'too_weak';

export interface AccountPasswordEvaluation {
  /** 是否满足账号中心硬性规则（不满足时提交会被后端拒绝） */
  acceptable: boolean;
  /** 展示用强度；不满足硬性规则时恒为 weak */
  strength: AccountPasswordStrength;
  /** 不满足硬性规则的原因 */
  reason?: AccountPasswordRejectReason;
}

// 常见弱口令小表（与账号中心 password-policy.ts 同源，统一小写比较，只收录长度 ≥ 8 的条目）
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

/** 与账号中心一致：去首尾空白后按码点计长度并评估强度。 */
export function evaluatePassword(
  rawPassword: string,
  context: { email?: string | null } = {}
): AccountPasswordEvaluation {
  const password = rawPassword.trim();
  const length = [...password].length;
  if (length < ACCOUNT_PASSWORD_MIN_LENGTH)
    return { acceptable: false, strength: 'weak', reason: 'too_short' };
  if (length > ACCOUNT_PASSWORD_MAX_LENGTH)
    return { acceptable: false, strength: 'weak', reason: 'too_long' };
  if (isObviouslyWeak(password, context.email))
    return { acceptable: false, strength: 'weak', reason: 'too_weak' };
  return { acceptable: true, strength: strengthOf(password, length) };
}

export function isValidPassword(value: string, email?: string | null): boolean {
  return evaluatePassword(value, { email }).acceptable;
}

function isObviouslyWeak(password: string, email?: string | null): boolean {
  const lower = password.toLowerCase();
  // 1–4 个字符的片段整串重复：11111111、abababab、12341234
  if (/^(.{1,4})\1+$/su.test(lower)) return true;
  if (isFullSequence(lower)) return true;
  if (COMMON_WEAK_PASSWORDS.has(lower)) return true;
  const normalizedEmail = (email ?? '').trim().toLowerCase();
  const localPart = normalizedEmail.split('@')[0] ?? '';
  if (localPart && (lower === localPart || lower === normalizedEmail))
    return true;
  return false;
}

/** 整串是数字或字母表中的连续正序 / 倒序片段：12345678、87654321、abcdefgh */
function isFullSequence(lower: string): boolean {
  return SEQUENCE_ALPHABETS.some((alphabet) => {
    const reversed = [...alphabet].reverse().join('');
    return alphabet.includes(lower) || reversed.includes(lower);
  });
}

function strengthOf(password: string, length: number): AccountPasswordStrength {
  const classes = characterClassCount(password);
  if ((length >= 12 && classes >= 3) || (length >= 16 && classes >= 2))
    return 'strong';
  if (classes >= 2 || length >= 12) return 'medium';
  return 'weak';
}

/** 字符类别：小写字母、大写字母、数字、其他（符号、空格、中文等） */
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

/** 只保留数字并截断到验证码位数（粘贴整段文本时同样适用） */
export function normalizeCode(value: string): string {
  return value.replace(/\D/g, '').slice(0, ACCOUNT_CODE_LENGTH);
}

/** 倒计时格式 m:ss，例如 42 → 0:42 */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
