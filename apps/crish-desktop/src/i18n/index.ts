export * from './types';
export * from './locales';
export {
  I18nContext,
  I18nProvider,
  interpolate,
  resolveDictionaryKey,
  createTranslateFunction,
  getInitialLanguage,
  persistLanguage,
  getGlobalActiveTranslator,
  getGlobalActiveLanguage,
  type I18nProviderProps,
} from './I18nContext';
export { useI18n, t, type UseI18nResult } from './useI18n';
