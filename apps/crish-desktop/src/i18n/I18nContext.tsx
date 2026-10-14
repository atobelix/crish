import { safeSetItem } from '../api/localStorageApi';

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
 * 工业级安全变量插值替换引擎：
 * 1. 严格防御原型污染属性注入 (__proto__, constructor, prototype)；
 * 2. 安全防御 undefined、null、NaN，避免抛出异常或在 UI 裸露 "undefined" / "NaN"；
 * 3. 严格保护数值 0 与空值，未匹配的占位符保持原样不破损。
 */
export function interpolate(
  template: unknown,
  params?: TranslationParams
): string {
  // 1. 模板安全性防护：非字符串强制安全转为空字符串
  if (typeof template !== 'string') {
    return '';
  }

  // 2. 无参数快速返回原模板
  if (!params || typeof params !== 'object') {
    return template;
  }

  // 3. 执行单层安全正则替换
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, paramKey) => {
    // 严格防御原型链属性注入
    if (
      paramKey === '__proto__' ||
      paramKey === 'constructor' ||
      paramKey === 'prototype' ||
      !Object.prototype.hasOwnProperty.call(params, paramKey)
    ) {
      return match;
    }

    const value = (params as Record<string, unknown>)[paramKey];

    // 空值安全消解为可读空串，杜绝渲染 "null" 或 "undefined"
    if (value === null || value === undefined) {
      return '';
    }

    // 数值安全消解 (NaN / Infinity -> "-")
    if (typeof value === 'number') {
      if (Number.isNaN(value) || !Number.isFinite(value)) {
        return '-';
      }
      return String(value);
    }

    // 对象与函数安全防御，避免输出 "[object Object]"
    if (typeof value === 'object' || typeof value === 'function') {
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }

    return String(value);
  });
}

/**
 * 在单一字典对象中安全解析多段 key（支持扁平化、双段命名空间及多层点号递归）
 */
function resolveInSingleDict(
  dict: I18nDictionary,
  key: string
): string | undefined {
  if (!dict || typeof dict !== 'object' || !key) return undefined;

  const rawDict = dict as unknown as Record<
    string,
    Record<string, string | undefined> | undefined
  >;

  // 1. 尝试直接以整 key 读取（扁平配置）
  if (Object.prototype.hasOwnProperty.call(dict, key)) {
    const direct = (dict as unknown as Record<string, unknown>)[key];
    if (typeof direct === 'string') {
      return direct;
    }
  }

  // 2. 尝试首段作为 namespace，剩余作为子 key（如 error 域：error["provider.network.title"]）
  const firstDot = key.indexOf('.');
  if (firstDot > 0) {
    const ns = key.slice(0, firstDot);
    const subKey = key.slice(firstDot + 1);
    if (Object.prototype.hasOwnProperty.call(rawDict, ns)) {
      const subDict = rawDict[ns];
      if (subDict && typeof subDict === 'object') {
        if (Object.prototype.hasOwnProperty.call(subDict, subKey)) {
          const val = subDict[subKey];
          if (typeof val === 'string') {
            return val;
          }
        }
      }
    }
  }

  // 3. 尝试多层点号逐级安全遍历（防御 __proto__ / prototype 注入）
  const parts = key.split('.');
  let current: unknown = dict;
  for (const part of parts) {
    if (
      part === '__proto__' ||
      part === 'constructor' ||
      part === 'prototype'
    ) {
      return undefined;
    }
    if (
      current &&
      typeof current === 'object' &&
      Object.prototype.hasOwnProperty.call(current, part)
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
 * 语义化降级美化器（Level 4 防御）：
 * 将点分 key 的末段转换为可读的自然语言文本，避免向用户裸露技术键名。
 * 例如：
 * "settings.unknown.item" -> "Item"
 * "settings.appearance.themeTitle" -> "Theme Title"
 * "nav.user_profile" -> "User Profile"
 * "action.retry-all" -> "Retry All"
 */
export function humanizeKeyFallback(key: string): string {
  if (!key || typeof key !== 'string') return '';
  const cleanKey = key.replace(/\.+$/, '').trim();
  if (!cleanKey) return '';
  const lastSegment = cleanKey.includes('.')
    ? cleanKey.slice(cleanKey.lastIndexOf('.') + 1)
    : cleanKey;
  if (!lastSegment) return '';

  return lastSegment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

/**
 * 判断当前是否处于生产环境
 */
export function isProductionMode(): boolean {
  if (
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV === 'production'
  ) {
    return true;
  }
  if (typeof import.meta !== 'undefined' && Boolean(import.meta.env?.PROD)) {
    return true;
  }
  return false;
}

/**
 * 从字典中解析多段 key（如 "common.ok", "error.provider.network.title"）。
 * 支持四级降级漏斗前两级：目标字典未命中时自动尝试回退权威 zh-CN 字典。
 */
export function resolveDictionaryKey(
  dict: I18nDictionary,
  key: string,
  fallbackDict: I18nDictionary | null = dict === dictionaries[DEFAULT_LANGUAGE]
    ? null
    : dictionaries[DEFAULT_LANGUAGE]
): string | undefined {
  if (!key) return undefined;

  // Level 1: 尝试在目标字典中匹配
  const found = resolveInSingleDict(dict, key);
  if (found !== undefined) {
    return found;
  }

  // Level 2: 若未命中且指定了回退字典，尝试在回退字典中检索
  if (fallbackDict && fallbackDict !== dict) {
    const fallbackFound = resolveInSingleDict(fallbackDict, key);
    if (fallbackFound !== undefined) {
      return fallbackFound;
    }
  }

  return undefined;
}

export interface TranslateFunctionOptions {
  /** 兜底语言字典（默认使用权威 zh-CN 字典） */
  fallbackDictionary?: I18nDictionary;
  /** 是否强制消除点分裸 Key 并转换为语义化文本 */
  suppressBareKey?: boolean;
  /** 是否按生产环境行为执行 */
  isProduction?: boolean;
}

/**
 * 创建与字典绑定的翻译执行函数，内建四级平滑降级漏斗 (Disaster Recovery Funnel)：
 * 1. 尝试在当前目标语言字典（如 en-US）中匹配词条；
 * 2. 若未命中，尝试在权威 zh-CN 字典中匹配相同 key（保证中文兜底）；
 * 3. 若仍未命中且调用方传入了 fallback 字符串，使用 fallback；
 * 4. 若全未命中：生产环境或配置了 suppressBareKey 时，绝不向用户裸露点分 key，安全转换为语义化文本；
 *    开发/测试环境下附带告警日志并保留原 key 方便调试。
 */
export function createTranslateFunction(
  dictionary: I18nDictionary,
  optionsOrFallbackDict?: I18nDictionary | TranslateFunctionOptions
): TranslateFunction {
  let fallbackDict: I18nDictionary | undefined;
  let forceSuppressBareKey: boolean | undefined;
  let forceIsProduction: boolean | undefined;

  if (optionsOrFallbackDict) {
    if ('common' in optionsOrFallbackDict || 'nav' in optionsOrFallbackDict) {
      fallbackDict = optionsOrFallbackDict as I18nDictionary;
    } else {
      const opts = optionsOrFallbackDict as TranslateFunctionOptions;
      fallbackDict = opts.fallbackDictionary;
      forceSuppressBareKey = opts.suppressBareKey;
      forceIsProduction = opts.isProduction;
    }
  }

  const authorityFallbackDict =
    fallbackDict ??
    (dictionary === dictionaries[DEFAULT_LANGUAGE]
      ? undefined
      : dictionaries[DEFAULT_LANGUAGE]);

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

    // 四级平滑降级漏斗
    // Level 1: 尝试在当前目标语言字典中匹配
    let template = resolveInSingleDict(dictionary, key);

    // Level 2: 若未命中，尝试在权威 zh-CN 字典中匹配
    if (template === undefined && authorityFallbackDict) {
      template = resolveInSingleDict(authorityFallbackDict, key);
    }

    // Level 3: 若仍未命中且调用方传入了 fallback 字符串，使用 fallback
    if (
      template === undefined &&
      typeof fallback === 'string' &&
      fallback.length > 0
    ) {
      template = fallback;
    }

    // Level 4: 全未命中，实施严谨的容灾降级
    if (template === undefined) {
      const shouldSuppress =
        forceSuppressBareKey ?? forceIsProduction ?? isProductionMode();

      if (shouldSuppress) {
        template = humanizeKeyFallback(key);
      } else {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(
            `[i18n] Missing translation key: "${key}". Fallback to raw key in dev/test environment.`
          );
        }
        template = key;
      }
    }

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
    // 统一存储单轨：safeSetItem 内置 quota/隐私模式容错
    safeSetItem(STORAGE_KEY_LOCALE, lang);
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('lang', lang);
  }
}

// 模块级状态与 Session Language Epoch 令牌
let globalSessionLanguageEpoch = 0;
let globalActiveLanguage: SupportedLanguage = DEFAULT_LANGUAGE;
let globalActiveTranslator: TranslateFunction = createTranslateFunction(
  dictionaries[DEFAULT_LANGUAGE]
);

/**
 * 获取当前全局会话语言 Epoch 令牌。
 * 每次语言切换时单调自增。
 * 供异步 IPC、长轮询或流式回调比对：若响应到达时的 epoch 与当前 epoch 不一致，坚决忽略旧语言回写。
 */
export function getSessionLanguageEpoch(): number {
  return globalSessionLanguageEpoch;
}

/**
 * 内部测试辅助函数：重置全局 Session Epoch 计数
 */
export function __resetSessionLanguageEpochForTest(value = 0): void {
  globalSessionLanguageEpoch = value;
}

export function getGlobalActiveTranslator(): TranslateFunction {
  return globalActiveTranslator;
}

export function getGlobalActiveLanguage(): SupportedLanguage {
  return globalActiveLanguage;
}

function updateGlobalTranslator(lang: SupportedLanguage): void {
  const languageChanged = globalActiveLanguage !== lang;
  globalActiveLanguage = lang;
  if (languageChanged) {
    globalSessionLanguageEpoch += 1;
  }
  const dict = dictionaries[lang] ?? dictionaries[DEFAULT_LANGUAGE];
  globalActiveTranslator = createTranslateFunction(dict);
  // 连接到 error-translation.ts
  registerErrorTranslateFn((key: string, fallback?: string) =>
    globalActiveTranslator(key, fallback)
  );
}

// 模块加载时初始化一次
updateGlobalTranslator(DEFAULT_LANGUAGE);

export const I18nContext = createContext<I18nContextValue>({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => {},
  t: globalActiveTranslator,
  dictionary: dictionaries[DEFAULT_LANGUAGE],
  sessionEpoch: 0,
});

export interface I18nProviderProps {
  children: React.ReactNode;
  initialLanguage?: SupportedLanguage;
  suppressBareKey?: boolean;
}

export const I18nProvider: React.FC<I18nProviderProps> = ({
  children,
  initialLanguage,
  suppressBareKey,
}) => {
  const [language, setLanguageState] = useState<SupportedLanguage>(() => {
    const lang = initialLanguage ?? getInitialLanguage();
    if (lang !== globalActiveLanguage) {
      updateGlobalTranslator(lang);
    }
    return lang;
  });

  const [sessionEpoch, setSessionEpoch] = useState<number>(
    () => globalSessionLanguageEpoch
  );

  const setLanguage = useCallback((lang: SupportedLanguage) => {
    setLanguageState((prevLang) => {
      if (prevLang !== lang) {
        persistLanguage(lang);
        updateGlobalTranslator(lang);
        setSessionEpoch(globalSessionLanguageEpoch);
        return lang;
      }
      return prevLang;
    });
  }, []);

  useEffect(() => {
    persistLanguage(language);
    updateGlobalTranslator(language);
    setSessionEpoch(globalSessionLanguageEpoch);
  }, [language]);

  const dictionary = useMemo(() => {
    return dictionaries[language] ?? dictionaries[DEFAULT_LANGUAGE];
  }, [language]);

  const t = useMemo(() => {
    return createTranslateFunction(dictionary, {
      suppressBareKey: suppressBareKey ?? isProductionMode(),
    });
  }, [dictionary, suppressBareKey]);

  const value = useMemo<I18nContextValue>(() => {
    return {
      language,
      setLanguage,
      t,
      dictionary,
      sessionEpoch,
    };
  }, [language, setLanguage, t, dictionary, sessionEpoch]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};
