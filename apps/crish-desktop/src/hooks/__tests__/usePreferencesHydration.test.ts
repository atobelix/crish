// @vitest-environment jsdom
/**
 * usePreferencesHydration — SSOT 只读门面（Stage 4 · ACT-402）
 *
 * 水合唯一真源 = UnifiedAppHydrationCoordinator.applyAtomicCommit → settingsStore。
 * 本 Hook 不再独立发起 IPC。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePreferencesHydration } from '../usePreferencesHydration';
import { useSettingsStore } from '../../store/settingsStore';

describe('usePreferencesHydration — 纯查询 SSOT', () => {
  beforeEach(() => {
    useSettingsStore.setState({ appSettings: null });
  });

  it('appSettings 未注入时 isHydrated=false', () => {
    const { result } = renderHook(() => usePreferencesHydration());
    expect(result.current.isHydrated).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('Coordinator setState appSettings 后 isHydrated=true', () => {
    const { result } = renderHook(() => usePreferencesHydration());
    expect(result.current.isHydrated).toBe(false);

    act(() => {
      useSettingsStore.setState({ appSettings: { theme: 'dark' } });
    });

    expect(result.current.isHydrated).toBe(true);
  });
});
