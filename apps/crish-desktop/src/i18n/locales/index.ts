import type { SupportedLanguage, I18nDictionary } from '../types';
import { zhCN } from './zh-CN';
import { enUS } from './en-US';

export { zhCN } from './zh-CN';
export { enUS } from './en-US';

export const dictionaries: Record<SupportedLanguage, I18nDictionary> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

export type { I18nDictionary } from '../types';
