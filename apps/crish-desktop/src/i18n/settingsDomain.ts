/**
 * 设置域词典懒加载：设置域全量词典（locales/<lang>/settings-domain/settingsFull）
 * 不进首屏静态 import 图（check-startup-budget 守此边界），由设置中心等入口在
 * 打开时经本模块动态 import 按需加载；加载完成后通过订阅通知 I18nProvider 合并
 * 进生效词典（核心词典 locales/<lang>/settings 始终静态可用，覆盖设置中心之外
 * 的引用面：权限模式文案、厂商展示名、侧栏账号快捷菜单等）。
 *
 * 加载失败时保持核心词典降级呈现，下一次触发会重试，不缓存失败结果。
 */
import { useEffect, useState } from 'react';
import type { SettingsTranslations, SupportedLanguage } from './types';

const loadedByLanguage = new Map<SupportedLanguage, SettingsTranslations>();
const inflightByLanguage = new Map<
  SupportedLanguage,
  Promise<SettingsTranslations>
>();
const listeners = new Set<() => void>();

function notifyLoaded(): void {
  for (const listener of [...listeners]) listener();
}

/** 订阅设置域加载完成事件（I18nProvider 用它刷新生效词典）；返回退订函数。 */
export function subscribeSettingsDomain(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 已加载的设置域全量词典（未加载返回 undefined，不触发加载）。 */
export function getLoadedSettingsDomain(
  language: SupportedLanguage
): SettingsTranslations | undefined {
  return loadedByLanguage.get(language);
}

/** 加载指定语言的设置域全量词典（幂等：并发共享同一请求，成功后缓存）。 */
export function loadSettingsDomain(
  language: SupportedLanguage
): Promise<SettingsTranslations> {
  const cached = loadedByLanguage.get(language);
  if (cached) return Promise.resolve(cached);
  const inflight = inflightByLanguage.get(language);
  if (inflight) return inflight;
  const request = (async () => {
    const mod =
      language === 'en-US'
        ? await import('./locales/en-US/settings-domain/settingsFull')
        : await import('./locales/zh-CN/settings-domain/settingsFull');
    const full = mod.settingsFull;
    loadedByLanguage.set(language, full);
    notifyLoaded();
    return full;
  })();
  inflightByLanguage.set(language, request);
  // 无论成败都清掉在途记录：成功后走缓存，失败后允许下次重试
  void request.then(
    () => {
      inflightByLanguage.delete(language);
    },
    () => {
      inflightByLanguage.delete(language);
    }
  );
  return request;
}

/**
 * 入口触发钩子：enabled 为真时确保当前语言的设置域词典已加载。
 * 返回是否已加载（供入口决定渲染时机；常规入口可忽略返回值，
 * 词条会在加载完成时经 Provider 刷新自动补齐）。
 */
export function useSettingsDomain(
  language: SupportedLanguage,
  enabled = true
): boolean {
  const [loaded, setLoaded] = useState<boolean>(() =>
    loadedByLanguage.has(language)
  );
  useEffect(() => {
    if (!enabled) return;
    if (loadedByLanguage.has(language)) {
      setLoaded(true);
      return;
    }
    setLoaded(false);
    let alive = true;
    const unsubscribe = subscribeSettingsDomain(() => {
      if (loadedByLanguage.has(language)) setLoaded(true);
    });
    loadSettingsDomain(language)
      .then(() => {
        if (alive) setLoaded(true);
      })
      .catch(() => {
        // 加载失败保持核心词典降级；卸载/下次打开时重试
      });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [language, enabled]);
  return loaded;
}
