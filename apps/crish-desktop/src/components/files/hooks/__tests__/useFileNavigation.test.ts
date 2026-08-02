// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useFileNavigation } from '../useFileNavigation';

describe('useFileNavigation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('isDirty', () => {
    it('returns false when getIsDirty is not provided', () => {
      const { result } = renderHook(() => useFileNavigation());
      expect(result.current.isDirty()).toBe(false);
    });

    it('returns false when getIsDirty returns false', () => {
      const { result } = renderHook(() => useFileNavigation(() => false));
      expect(result.current.isDirty()).toBe(false);
    });

    it('returns true when getIsDirty returns true', () => {
      const { result } = renderHook(() => useFileNavigation(() => true));
      expect(result.current.isDirty()).toBe(true);
    });

    it('reflects updated getIsDirty value via ref', () => {
      const getIsDirty = vi.fn(() => false);
      const { result } = renderHook(
        ({ dirty }) => useFileNavigation(dirty),
        { initialProps: { dirty: getIsDirty } },
      );
      expect(result.current.isDirty()).toBe(false);

      getIsDirty.mockReturnValue(true);
      expect(result.current.isDirty()).toBe(true);
    });
  });

  describe('confirmNavigation', () => {
    it('returns true without calling confirm when not dirty', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm');
      const { result } = renderHook(() => useFileNavigation(() => false));
      await expect(result.current.confirmNavigation()).resolves.toBe(true);
      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('shows confirm dialog and returns its result when dirty', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { result } = renderHook(() => useFileNavigation(() => true));
      await expect(result.current.confirmNavigation()).resolves.toBe(true);
      expect(confirmSpy).toHaveBeenCalledWith('当前文件未保存，切换将丢失修改，是否继续？');
    });

    it('returns false when user cancels confirm dialog', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const { result } = renderHook(() => useFileNavigation(() => true));
      await expect(result.current.confirmNavigation()).resolves.toBe(false);
      expect(confirmSpy).toHaveBeenCalledTimes(1);
    });
  });
});
