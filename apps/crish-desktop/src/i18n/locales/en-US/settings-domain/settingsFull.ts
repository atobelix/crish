/**
 * 设置域全量词典（懒加载）：由 i18n/settingsDomain.ts 在设置中心打开时动态 import，
 * 不进首屏静态 import 图（check-startup-budget）。汇入口径与拆分前的 settings.ts
 * 完全一致：核心（../settings）+ settingsPartMain + settingsPartRest +
 * settingsPartModels + settingsPartAccount，键与值逐项等同。
 */
import type { SettingsTranslations } from '../../../types';
import { settings as settingsCore } from '../settings';
import { settingsPartMain } from './settingsMain';
import { settingsPartRest } from '../settingsParts';
import { settingsPartModels } from '../settingsModels';
import { settingsPartAccount } from '../settingsAccount';

export const settingsFull: SettingsTranslations = {
  ...settingsCore,
  ...settingsPartMain,
  ...settingsPartRest,
  ...settingsPartModels,
  ...settingsPartAccount,
};
export default settingsFull;
