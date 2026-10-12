import React, {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  DEFAULT_LANGUAGE,
  STORAGE_KEY_LOCALE,
  type I18nContextValue,
  type I18nDictionary,
  type SupportedLanguage,
  type TranslateFunction,
  type TranslationKey,
  type TranslationParams,
} from './types';
import { dictionaries } from './locales';
import { registerErrorTranslateFn } from '../utils/error-translation';

/**
 * 变量插值替换：将 "{name}" 替换为 params.name
 */
export function interpolate(
  template: string,
  params?: TranslationParams
): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, paramKey) => {
    if (Object.prototype.hasOwnProperty.call(params, paramKey)) {
      return String(params[paramKey]);
    }
    return match;
  });
}

/**
 * 从字典中解析多段 key（如 "common.ok", "error.provider.network.title"）
 */
export function resolveDictionaryKey(
  dict: I18nDictionary,
  key: string
): string | undefined {
  if (!key) return undefined;

  const rawDict = dict as unknown as Record<
    string,
    Record<string, string | undefined> | undefined
  >;

  // 1. 尝试直接以整 key 读取（若有扁平配置）
  const direct = (dict as unknown as Record<string, unknown>)[key];
  if (typeof direct === 'string') {
    return direct;
  }

  // 2. 尝试首段作为 namespace，剩余作为子 key（如 error 域：error["provider.network.title"]）
  const firstDot = key.indexOf('.');
  if (firstDot > 0) {
    const ns = key.slice(0, firstDot);
    const subKey = key.slice(firstDot + 1);
    const subDict = rawDict[ns];
    if (subDict && typeof subDict === 'object') {
      const val = subDict[subKey];
      if (typeof val === 'string') {
        return val;
      }
    }
  }

  // 3. 尝试多层点号逐级遍历
  const parts = key.split('.');
  let current: unknown = dict;
  for (const part of parts) {
    if (
      current &&
      typeof current === 'object' &&
      part in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[part];
    } else {
      current = undefined;
      break;
    }
  }

  if (typeof current === 'string') {
    return current;
  }

  return undefined;
}

/**
 * 创建与字典绑定的翻译执行函数
 */
export function createTranslateFunction(
  dictionary: I18nDictionary
): TranslateFunction {
  return (
    key: TranslationKey,
    fallbackOrParams?: string | TranslationParams,
    params?: TranslationParams
  ): string => {
    let fallback: string | undefined;
    let actualParams: TranslationParams | undefined;

    if (typeof fallbackOrParams === 'object' && fallbackOrParams !== null) {
      actualParams = fallbackOrParams;
      fallback = undefined;
    } else {
      fallback = fallbackOrParams;
      actualParams = params;
    }

    const resolved = resolveDictionaryKey(dictionary, key);
    const template = resolved ?? fallback ?? key;
    return interpolate(template, actualParams);
  };
}

/**
 * 读取 localStorage 持久化的语言偏好
 */
export function getInitialLanguage(): SupportedLanguage {
  if (typeof window === 'undefined' || !window.localStorage) {
    return DEFAULT_LANGUAGE;
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY_LOCALE);
    if (stored === 'zh-CN' || stored === 'en-US') {
      return stored;
    }
  } catch {
    /* swallow-ok: 本地存储不可用时降级为默认 */
  }
  return DEFAULT_LANGUAGE;
}

/**
 * 保存语言偏好至 localStorage 并同步 HTML lang 属性
 */
export function persistLanguage(lang: SupportedLanguage): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY_LOCALE, lang);
    } catch {
      /* swallow-ok */
    }
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('lang', lang);
  }
}

// 模块级活动翻译器引用，确保非 React 组件或全局 helper 也可调用
let globalActiveLanguage: SupportedLanguage = DEFAULT_LANGUAGE;
let globalActiveTranslator: TranslateFunction = createTranslateFunction(
  dictionaries[DEFAULT_LANGUAGE]
);

export function getGlobalActiveTranslator(): TranslateFunction {
  return globalActiveTranslator;
}

export function getGlobalActiveLanguage(): SupportedLanguage {
  return globalActiveLanguage;
}

function updateGlobalTranslator(lang: SupportedLanguage): void {
  globalActiveLanguage = lang;
  const dict = dictionaries[lang] ?? dictionaries[DEFAULT_LANGUAGE];
  globalActiveTranslator = createTranslateFunction(dict);
  // 连接到 error-translation.ts
  registerErrorTranslateFn((key: string, fallback?: string) =>
    globalActiveTranslator(key, fallback)
  );
}

// 初始化注册一次
updateGlobalTranslator(DEFAULT_LANGUAGE);

export const I18nContext = createContext<I18nContextValue>({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => {},
  t: globalActiveTranslator,
  dictionary: dictionaries[DEFAULT_LANGUAGE],
});

export interface I18nProviderProps {
  children: React.ReactNode;
  initialLanguage?: SupportedLanguage;
}

export const I18nProvider: React.FC<I18nProviderProps> = ({
  children,
  initialLanguage,
}) => {
  const [language, setLanguageState] = useState<SupportedLanguage>(() => {
    return initialLanguage ?? getInitialLanguage();
  });

  const setLanguage = useCallback((lang: SupportedLanguage) => {
    setLanguageState(lang);
    persistLanguage(lang);
    updateGlobalTranslator(lang);
  }, []);

  useEffect(() => {
    persistLanguage(language);
    updateGlobalTranslator(language);
  }, [language]);

  const dictionary = useMemo(() => {
    return dictionaries[language] ?? dictionaries[DEFAULT_LANGUAGE];
  }, [language]);

  const t = useMemo(() => {
    return createTranslateFunction(dictionary);
  }, [dictionary]);

  const value = useMemo<I18nContextValue>(() => {
    return {
      language,
      setLanguage,
      t,
      dictionary,
    };
  }, [language, setLanguage, t, dictionary]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};
