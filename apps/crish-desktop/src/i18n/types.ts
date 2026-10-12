/**
 * i18n 国际化子系统类型契约。
 *
 * 支持语言：zh-CN（默认）与 en-US。
 * 覆盖 common / nav / chat / settings / about / error / action 命名空间。
 */

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
}

export interface WorkspaceTranslations {
  switchWorkspace: string;
  currentWorkspace: string;
  guestUser: string;
  settingsNav: string;
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
  | `workspace.${keyof WorkspaceTranslations}`;

/**
 * 允许使用强类型预定义键，也支持任意动态键（如 error.<code>.title 或 action.*）
 */
export type TranslationKey = KnownTranslationKey | (string & {});

export type TranslationParams = Record<string, string | number>;

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
}
