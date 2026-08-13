// 设置域组件 barrel（R2-06 部分 3）：分组 / 开关行 / 主题三选 / 关于卡 / 移除本机
export { default as SettingsScreenView } from './SettingsScreenView';
export type { SettingsScreenViewProps } from './SettingsScreenView';
export { default as SettingsGroup } from './SettingsGroup';
export type { SettingsGroupProps } from './SettingsGroup';
export { default as SettingsSwitchRow } from './SettingsSwitchRow';
export type { SettingsSwitchRowProps } from './SettingsSwitchRow';
export { default as SettingsThemeSelector } from './SettingsThemeSelector';
export type { SettingsThemeSelectorProps } from './SettingsThemeSelector';
export {
  default as SettingsAboutCard,
  shortDesktopId,
} from './SettingsAboutCard';
export type { SettingsAboutCardProps } from './SettingsAboutCard';
export {
  default as SettingsRemoveLocalZone,
  removeLocalDialogActions,
  REMOVE_LOCAL_DIALOG_TITLE,
  REMOVE_LOCAL_DIALOG_DESCRIPTION,
} from './SettingsRemoveLocalZone';
export type { SettingsRemoveLocalZoneProps } from './SettingsRemoveLocalZone';
