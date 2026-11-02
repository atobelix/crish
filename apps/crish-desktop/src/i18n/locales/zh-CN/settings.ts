/**
 * 设置域「核心」词典（随首屏静态打包）：仅含设置中心之外也会引用的 settings.* 词条
 * （权限模式文案、模型厂商展示名、侧栏账号态、统一模型树写入失败提示等）
 * 与最初的 11 个兼容键。设置域全量词典在 ./settings-domain/settingsFull.ts，
 * 由 i18n/settingsDomain.ts 在设置中心打开时按需动态加载（check-startup-budget 守此边界）；
 * 新增 settings.* 词条默认进全量域，只有被设置中心之外引用时才放进本文件。
 */
import type { SettingsTranslations } from '../../types';

export const settings: SettingsTranslations = {
  title: '设置',
  general: '常规',
  language: '语言',
  theme: '主题',
  dark: '深色',
  light: '浅色',
  system: '跟随系统',
  fontSize: '字体大小',
  aboutTitle: '关于',
  license: '开源许可',
  version: '版本',
  'security.modeAskLabel': '每次询问',
  'security.modeAskShortLabel': '每次询问',
  'security.modeAskDesc': '改文件、写操作与命令执行前均需确认',
  'security.modeSmartLabel': '智能放行',
  'security.modeSmartShortLabel': '智能放行',
  'security.modeSmartDesc': '安全只读命令直接运行，写操作与危险命令需确认',
  'security.modeFullLabel': '完全允许',
  'security.modeFullShortLabel': '完全放行',
  'security.modeFullDesc': '除物理毁灭级命令外全部放行，不再逐条确认',
  'account.signedOut': '未登录',
  'account.quick.signInTip': '登录或注册 Crish 账号',
  'models.vendor.deepseek': 'DeepSeek (深度求索)',
  'models.vendor.qwen': '通义千问 (Qwen)',
  'models.vendor.moonshot': '月之暗面 (Kimi)',
  'models.vendor.zhipu': '智谱 AI (GLM)',
  'models.vendor.minimax': 'MiniMax (海螺)',
  'models.vendor.bytedance': '字节跳动 (豆包)',
  'models.vendor.stepfun': '阶跃星辰 (StepFun)',
  'models.vendor.baichuan': '百川智能 (Baichuan)',
  'models.vendor.zeroone': '零一万物 (01.AI)',
  'models.vendor.baidu': '百度 (文心一言)',
  'models.vendor.tencent': '腾讯 (混元)',
  'models.vendor.iflytek': '科大讯飞 (星火)',
  'models.vendor.sensetime': '商汤科技 (日日新)',
  'models.vendor.kling': '快手 (可灵 Kling)',
  'models.vendor.siliconflow': 'SiliconFlow (硅基流动)',
  'models.probe.contextWindowWriteFailed':
    '扫描到的上下文长度写入统一树失败：{error}',
  'account.quick.myAccount': '我的账号',
  'account.quick.signIn': '登录账号',
  'account.quick.manageTip': '在设置中管理账号',
};
export default settings;
