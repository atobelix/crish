/**
 * i18n 国际化子系统类型契约。
 *
 * 支持语言：zh-CN（默认）与 en-US。
 * 覆盖 common / nav / chat / settings / about / error / action / tool / units / workspace / sidebar 命名空间。
 */

import type React from 'react';

export type SupportedLanguage = 'zh-CN' | 'en-US';

export const DEFAULT_LANGUAGE: SupportedLanguage = 'zh-CN';

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  'zh-CN',
  'en-US',
] as const;

export const STORAGE_KEY_LOCALE = 'crish-locale';

export interface CommonTranslations {
  ok: string;
  cancel: string;
  save: string;
  delete: string;
  confirm: string;
  close: string;
  closeDialog: string;
  copy: string;
  copied: string;
  retry: string;
  loading: string;
  search: string;
  error: string;
  success: string;
  refresh: string;
  back: string;
  next: string;
  [key: string]: string;
}

export interface NavTranslations {
  sessions: string;
  models: string;
  settings: string;
  profile: string;
  extensions: string;
  appearance: string;
  shortcuts: string;
  security: string;
  about: string;
  diagnostics: string;
  [key: string]: string;
}

export interface ChatTranslations {
  newSession: string;
  emptyStateTitle: string;
  emptyStateSubtitle: string;
  placeholder: string;
  send: string;
  stop: string;
  attach: string;
  systemPrompt: string;
  clearHistory: string;
  prompts: string;
  welcome: string;
  quickActions: string;
  importChat: string;
  newProject: string;
  [key: string]: string;
}

export interface WorkspaceTranslations {
  switchWorkspace: string;
  currentWorkspace: string;
  guestUser: string;
  settingsNav: string;
  [key: string]: string;
}

export interface SettingsTranslations {
  title: string;
  general: string;
  language: string;
  theme: string;
  dark: string;
  light: string;
  system: string;
  fontSize: string;
  aboutTitle: string;
  license: string;
  version: string;
  [key: string]: string;
}

export interface AboutTranslations {
  appVersion: string;
  kernelVersion: string;
  openSourceLicense: string;
  viewLicense: string;
  viewThirdParty: string;
  noticeTitle: string;
  copySysInfo: string;
  sysInfoCopied: string;
  [key: string]: string;
}

export interface I18nDictionary {
  common: CommonTranslations;
  nav: NavTranslations;
  chat: ChatTranslations;
  settings: SettingsTranslations;
  about: AboutTranslations;
  workspace: WorkspaceTranslations;
  error?: Record<string, string>;
  action?: Record<string, string>;
  tool?: Record<string, string>;
  units?: Record<string, string>;
  sidebar?: Record<string, string>;
  [namespace: string]:
    | CommonTranslations
    | NavTranslations
    | ChatTranslations
    | SettingsTranslations
    | AboutTranslations
    | WorkspaceTranslations
    | Record<string, string>
    | undefined;
}

export type KnownTranslationKey =
  | `common.${keyof CommonTranslations}`
  | `nav.${keyof NavTranslations}`
  | `chat.${keyof ChatTranslations}`
  | `settings.${keyof SettingsTranslations}`
  | `about.${keyof AboutTranslations}`
  | `workspace.${keyof WorkspaceTranslations}`
  | `error.${string}`
  | `action.${string}`
  | `tool.${string}`
  | `units.${string}`
  | `sidebar.${string}`;

/**
 * 允许使用强类型预定义键，也支持任意动态键（如 error.<code>.title 或 action.*）
 */
export type TranslationKey = KnownTranslationKey | (string & {});

export type TranslationParamValue =
  string | number | boolean | null | undefined | Record<string, unknown>;

export type TranslationParams = Record<string, unknown>;

export type TranslateFunction = (
  key: TranslationKey,
  fallbackOrParams?: string | TranslationParams,
  params?: TranslationParams
) => string;

export interface I18nContextValue {
  language: SupportedLanguage;
  setLanguage: (lang: SupportedLanguage) => void;
  t: TranslateFunction;
  dictionary: I18nDictionary;
  /**
   * 会话语言 Epoch 令牌：每次语言切换时单调自增。
   * 供异步 IPC、长轮询或流式回调比对，若响应到达时的 epoch 与当前 epoch 不一致，忽略旧语言回写。
   */
  sessionEpoch: number;
}

/**
 * SafeIntl 格式化配置类型契约
 */
export interface SafeIntlFormatOptions {
  locale?: SupportedLanguage;
}

export interface SafeIntlNumberOptions
  extends Intl.NumberFormatOptions, SafeIntlFormatOptions {}

export interface SafeIntlDateTimeOptions
  extends Intl.DateTimeFormatOptions, SafeIntlFormatOptions {}

export interface SafeIntlRelativeTimeOptions
  extends Intl.RelativeTimeFormatOptions, SafeIntlFormatOptions {}

export interface SafeIntlPluralOptions
  extends Intl.PluralRulesOptions, SafeIntlFormatOptions {}

/**
 * Trans 富文本插槽与组件类型契约
 */
export type TransInterpolationSlot =
  React.ReactNode | ((content: string) => React.ReactNode);

export type TransSlots =
  Record<string, TransInterpolationSlot> | Array<TransInterpolationSlot>;

export interface TransProps {
  i18nKey: TranslationKey;
  fallback?: string;
  params?: TranslationParams;
  slots?: TransSlots;
  className?: string;
}
