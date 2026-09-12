import { useSettingsStore } from '../store/settingsStore';

export interface UsePreferencesHydrationResult {
  isHydrated: boolean;
  error: Error | null;
}

/**
 * 偏好水合只读门面（SSOT · ACT-402 / 详案 §4.3）。
 *
 * 水合唯一真源 = UnifiedAppHydrationCoordinator.applyAtomicCommit
 * （entry-core 在 createRoot 前完成 setState → settingsStore.appSettings）。
 * 本 Hook 不再独立发起 getAllPreferences IPC，仅订阅 Store 就绪门闩。
 */
export function usePreferencesHydration(): UsePreferencesHydrationResult {
  const isHydrated = useSettingsStore(
    (s) => s.appSettings !== null && s.appSettings !== undefined
  );
  return {
    isHydrated: Boolean(isHydrated),
    error: null,
  };
}
