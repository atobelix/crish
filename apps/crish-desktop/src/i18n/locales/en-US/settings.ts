/**
 * 设置域「核心」词典（随首屏静态打包）：仅含设置中心之外也会引用的 settings.* 词条
 * （权限模式文案、模型厂商展示名、侧栏账号态、统一模型树写入失败提示等）
 * 与最初的 11 个兼容键。设置域全量词典在 ./settings-domain/settingsFull.ts，
 * 由 i18n/settingsDomain.ts 在设置中心打开时按需动态加载（check-startup-budget 守此边界）；
 * 新增 settings.* 词条默认进全量域，只有被设置中心之外引用时才放进本文件。
 */
import type { SettingsTranslations } from '../../types';

export const settings: SettingsTranslations = {
  title: 'Settings',
  general: 'General',
  language: 'Language',
  theme: 'Theme',
  dark: 'Dark',
  light: 'Light',
  system: 'System',
  fontSize: 'Font Size',
  aboutTitle: 'About',
  license: 'License',
  version: 'Version',
  'security.modeAskLabel': 'Ask every time',
  'security.modeAskShortLabel': 'Ask every time',
  'security.modeAskDesc':
    'Confirm before file changes, write operations and command execution',
  'security.modeSmartLabel': 'Smart allow',
  'security.modeSmartShortLabel': 'Smart allow',
  'security.modeSmartDesc':
    'Safe read-only commands run directly; write operations and dangerous commands require confirmation',
  'security.modeFullLabel': 'Full access',
  'security.modeFullShortLabel': 'Full allow',
  'security.modeFullDesc':
    'Allow everything except physically destructive commands, with no per-action confirmation',
  'account.signedOut': 'Not signed in',
  'account.quick.signInTip': 'Sign in or sign up for Crish',
  'models.vendor.deepseek': 'DeepSeek',
  'models.vendor.qwen': 'Qwen (Tongyi Qianwen)',
  'models.vendor.moonshot': 'Moonshot AI (Kimi)',
  'models.vendor.zhipu': 'Zhipu AI (GLM)',
  'models.vendor.minimax': 'MiniMax (Hailuo)',
  'models.vendor.bytedance': 'ByteDance (Doubao)',
  'models.vendor.stepfun': 'StepFun',
  'models.vendor.baichuan': 'Baichuan AI',
  'models.vendor.zeroone': '01.AI',
  'models.vendor.baidu': 'Baidu (ERNIE Bot)',
  'models.vendor.tencent': 'Tencent (Hunyuan)',
  'models.vendor.iflytek': 'iFlytek (Spark)',
  'models.vendor.sensetime': 'SenseTime (SenseNova)',
  'models.vendor.kling': 'Kuaishou (Kling)',
  'models.vendor.siliconflow': 'SiliconFlow',
  'models.probe.contextWindowWriteFailed':
    'Failed to merge scanned context windows into the unified tree: {error}',
  'account.quick.myAccount': 'My account',
  'account.quick.signIn': 'Sign in',
  'account.quick.manageTip': 'Manage your account in Settings',
};
export default settings;
