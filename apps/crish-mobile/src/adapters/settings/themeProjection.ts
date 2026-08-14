// 深色模式三选投影——R2-05j 双轨收敛后的薄兼容层（themeProjection.ts）：
// - 存储/投影/消费入口均已下沉 platform/theme.ts 单一真源（theme.ts 单源，M4 §7.4，
//   存储位于 settings 与 platform 消费入口共同的下层，避免 settings → platform 反向依赖）；
// - 本文件仅为兼容层：全部符号从 platform/theme re-export——useAppTheme 与 useTheme
//   同一引用（函数恒等，由 themeProjection.test.ts:76 锁定），主屏 20+ 组件（仅 useTheme）
//   与设置/配对页（useAppTheme）全部跟随外观三选；
// - 消费面（SettingsThemeSelector / useSettingsVm / 配对页）与测试 import 面保持
//   './themeProjection' 不变，即验证兼容层完整（R2-05）；
// - token 完整性（darkTokens/lightTokens 键集合一致，R2UX-06-05 验收）断言见
//   themeProjection.test.ts，投影纯函数 projectThemeTokens 亦由 platform 层提供。
export {
  type ThemeMode,
  THEME_MODES,
  THEME_MODE_LABELS,
  themeModeStore,
  useThemeMode,
  projectThemeTokens,
  useTheme as useAppTheme,
  resetThemeModeForTest,
} from '@/adapters/platform/theme';
