// 设置词典拆分部分：账号（account.*）的登录弹窗、「账户」分区、修改密码与确认弹窗词条，由 settings.ts 通过 spread 聚合。
// 须与 en-US/settingsAccount.ts 保持键集合与插值参数一致。

export const settingsPartAccount = {
  // ── 通用 ──
  'account.back': '返回',
  'account.close': '关闭',
  'account.cancel': '取消',
  'account.save': '保存',
  'account.signIn': '登录',
  'account.signOut': '退出登录',
  'account.signedOut': '未登录',
  'account.changePassword': '修改密码',

  // ── 字段与验证码 ──
  'account.field.showPassword': '显示密码',
  'account.field.hidePassword': '隐藏密码',
  'account.code.title': '输入验证码',
  'account.code.ariaLabel': '6 位验证码',
  'account.code.resendIn': '重新发送 · {time}',
  'account.code.resend': '重新发送',
  'account.code.send': '发送验证码',
  'account.code.sentTo': '发送到 {email} 的验证码',

  // ── 错误 ──
  'account.error.failed': '操作失败，请稍后重试',
  'account.error.sessionExpired': '登录已失效，请重新登录',
  'account.error.network': '网络连接失败，请检查网络后重试',
  'account.error.unavailable': '该功能暂未开放',

  // ── 登录弹窗 ──
  'account.auth.dialogLabel': '登录 Crish',
  'account.auth.brandName': 'Crish',
  'account.auth.sending': '正在发送…',
  'account.auth.verifying': '正在验证…',
  'account.auth.loggingIn': '正在登录…',
  'account.auth.submitting': '正在提交…',
  'account.auth.emailTitle': '登录或注册',
  'account.auth.emailPlaceholder': '邮箱',
  'account.auth.register': '注册新账号',
  'account.auth.continue': '继续',
  'account.auth.usePassword': '使用密码登录',
  'account.auth.termsPrefix': '继续即表示同意',
  'account.auth.termsUser': '用户协议',
  'account.auth.termsAnd': '与',
  'account.auth.termsPrivacy': '隐私政策',
  'account.password.title': '密码登录',
  'account.password.placeholder': '密码',
  'account.password.forgot': '忘记密码',
  'account.password.submit': '登录',
  'account.password.newLabel': '新密码',
  'account.set.registerTitle': '设置密码',
  'account.set.resetTitle': '重设密码',
  'account.set.placeholder': '至少 8 位',
  'account.set.submit': '完成',
  'account.strength.weak': '强度：弱',
  'account.strength.medium': '强度：中',
  'account.strength.strong': '强度：强',
  'account.strength.tooShort': '密码至少 8 位',
  'account.strength.tooLong': '密码最多 128 位',
  'account.strength.tooWeak': '密码过于简单，请避免连续、重复字符或常见密码',

  // ── 资料 ──
  'account.profile.label': '资料',
  'account.profile.namePlaceholder': '昵称',
  'account.profile.bioPlaceholder': '简介',
  'account.profile.changeAvatar': '更换头像',
  'account.profile.avatarType': '头像仅支持 PNG、JPEG、WebP 或 GIF',
  'account.profile.avatarSize': '头像不能超过 3 MB',

  // ── 登录设备 ──
  'account.devices.label': '登录设备',
  'account.devices.current': '本机',
  'account.devices.online': '在线',
  'account.devices.unknown': '未知设备',
  'account.devices.revoke': '退出',
  'account.devices.revokeOthers': '退出其他设备',
  'account.devices.revokeFailed': '部分设备退出失败，请稍后重试',
  'account.devices.loading': '正在加载…',
  'account.devices.empty': '暂无登录设备',

  // ── 确认弹窗 ──
  'account.signOutConfirm.title': '退出登录？',
  'account.delete.entry': '注销账号',
  'account.delete.title': '注销账号',
  'account.delete.desc': '账号、资料与登录记录将被永久删除。',
  'account.delete.inputLabel': '输入账号邮箱以确认注销',
  'account.delete.confirm': '注销账号',

  // ── 快捷设置菜单 ──
  'account.quick.myAccount': '我的账号',
  'account.quick.signIn': '登录账号',
  'account.quick.manageTip': '在设置中管理账号',
  'account.quick.signInTip': '登录或注册 Crish 账号',
};
