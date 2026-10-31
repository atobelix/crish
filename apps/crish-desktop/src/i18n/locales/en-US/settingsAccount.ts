// 设置词典拆分部分：账号（account.*）的登录弹窗、「账户」分区、修改密码与确认弹窗词条，由 settings.ts 通过 spread 聚合。
// 须与 zh-CN/settingsAccount.ts 保持键集合与插值参数一致。

export const settingsPartAccount = {
  // ── 通用 ──
  'account.back': 'Back',
  'account.close': 'Close',
  'account.cancel': 'Cancel',
  'account.save': 'Save',
  'account.signIn': 'Sign in',
  'account.signOut': 'Sign out',
  'account.signedOut': 'Not signed in',
  'account.changePassword': 'Change password',

  // ── 字段与验证码 ──
  'account.field.showPassword': 'Show password',
  'account.field.hidePassword': 'Hide password',
  'account.code.title': 'Enter code',
  'account.code.ariaLabel': '6-digit code',
  'account.code.resendIn': 'Resend · {time}',
  'account.code.resend': 'Resend',
  'account.code.send': 'Send code',
  'account.code.sentTo': 'Code sent to {email}',

  // ── 错误 ──
  'account.error.failed': 'Something went wrong. Please try again later.',
  'account.error.sessionExpired':
    'Your session has expired. Please sign in again.',
  'account.error.network':
    'Network error. Check your connection and try again.',
  'account.error.unavailable': 'This feature is not available yet',

  // ── 登录弹窗 ──
  'account.auth.dialogLabel': 'Sign in to Crish',
  'account.auth.brandName': 'Crish',
  'account.auth.sending': 'Sending…',
  'account.auth.verifying': 'Verifying…',
  'account.auth.loggingIn': 'Signing in…',
  'account.auth.submitting': 'Submitting…',
  'account.auth.emailTitle': 'Sign in or sign up',
  'account.auth.emailPlaceholder': 'Email',
  'account.auth.register': 'Create an account',
  'account.auth.continue': 'Continue',
  'account.auth.usePassword': 'Sign in with password',
  'account.auth.termsPrefix': 'By continuing you agree to the',
  'account.auth.termsUser': 'Terms of Service',
  'account.auth.termsAnd': 'and',
  'account.auth.termsPrivacy': 'Privacy Policy',
  'account.password.title': 'Sign in with password',
  'account.password.placeholder': 'Password',
  'account.password.forgot': 'Forgot password',
  'account.password.submit': 'Sign in',
  'account.password.newLabel': 'New password',
  'account.set.registerTitle': 'Set a password',
  'account.set.resetTitle': 'Reset password',
  'account.set.placeholder': 'At least 8 characters',
  'account.set.submit': 'Done',
  'account.strength.weak': 'Strength: weak',
  'account.strength.medium': 'Strength: medium',
  'account.strength.strong': 'Strength: strong',
  'account.strength.tooShort': 'Use at least 8 characters',
  'account.strength.tooLong': 'Use at most 128 characters',
  'account.strength.tooWeak':
    'Too easy to guess. Avoid repeated or sequential characters and common passwords.',

  // ── 资料 ──
  'account.profile.label': 'Profile',
  'account.profile.namePlaceholder': 'Nickname',
  'account.profile.bioPlaceholder': 'Bio',
  'account.profile.changeAvatar': 'Change avatar',
  'account.profile.avatarType': 'Avatar must be PNG, JPEG, WebP or GIF',
  'account.profile.avatarSize': 'Avatar must be 3 MB or smaller',

  // ── 登录设备 ──
  'account.devices.label': 'Signed-in devices',
  'account.devices.current': 'This device',
  'account.devices.online': 'Online',
  'account.devices.unknown': 'Unknown device',
  'account.devices.revoke': 'Sign out',
  'account.devices.revokeOthers': 'Sign out other devices',
  'account.devices.revokeFailed':
    'Some devices could not be signed out. Please try again later.',
  'account.devices.loading': 'Loading…',
  'account.devices.empty': 'No signed-in devices',

  // ── 确认弹窗 ──
  'account.signOutConfirm.title': 'Sign out?',
  'account.delete.entry': 'Delete account',
  'account.delete.title': 'Delete account',
  'account.delete.desc':
    'Your account, profile and sign-in history will be permanently deleted.',
  'account.delete.inputLabel': 'Type your account email to confirm',
  'account.delete.confirm': 'Delete account',

  // ── 快捷设置菜单 ──
  'account.quick.myAccount': 'My account',
  'account.quick.signIn': 'Sign in',
  'account.quick.manageTip': 'Manage your account in Settings',
  'account.quick.signInTip': 'Sign in or sign up for Crish',
};
