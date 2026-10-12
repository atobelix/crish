import { useContext, useCallback } from 'react';
import { I18nContext, getGlobalActiveTranslator } from './I18nContext';
import type {
  I18nContextValue,
  TranslationKey,
  TranslationParams,
} from './types';
import {
  toUserVisibleError,
  type TranslateFn,
  type UserVisibleError,
} from '../utils/error-translation';
import type { CrishErrorPayload } from '@crish/shared-types';

export interface UseI18nResult extends I18nContextValue {
  /**
   * 专门用于对接 error-translation 的 TranslateFn 签名函数
   */
  errorTranslateFn: TranslateFn;
  /**
   * 直接将结构化错误负载翻译为当前语言的用户展示模型
   */
  translateError: (payload: CrishErrorPayload) => UserVisibleError;
}

/**
 * React Hook：访问当前 i18n 语言上下文及翻译方法
 */
export function useI18n(): UseI18nResult {
  const context = useContext(I18nContext);
  const { t } = context;

  const errorTranslateFn = useCallback<TranslateFn>(
    (key: string, fallback?: string) => {
      return t(key, fallback);
    },
    [t]
  );

  const translateError = useCallback(
    (payload: CrishErrorPayload): UserVisibleError => {
      return toUserVisibleError(payload, errorTranslateFn);
    },
    [errorTranslateFn]
  );

  return {
    ...context,
    errorTranslateFn,
    translateError,
  };
}

/**
 * 便捷的全局单例翻译 helper，可直接在组件外、纯函数或服务逻辑中调用
 */
export function t(
  key: TranslationKey,
  fallbackOrParams?: string | TranslationParams,
  params?: TranslationParams
): string {
  const translator = getGlobalActiveTranslator();
  return translator(key, fallbackOrParams, params);
}
