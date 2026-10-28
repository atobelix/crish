import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePermissionStore } from './permissionStore';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_STORAGE_KEY,
} from '../api/permissionModes';

beforeEach(() => {
  localStorage.clear();
  usePermissionStore.setState({
    permissionMode: DEFAULT_PERMISSION_MODE,
  });
});

afterEach(() => {
  localStorage.clear();
});

describe('permissionStore — 架构重构后单一状态契约', () => {
  it('初始状态为 DEFAULT_PERMISSION_MODE (smart)', () => {
    expect(usePermissionStore.getState().permissionMode).toBe('smart');
  });

  it('setPermissionMode 正常更新状态并同步持久化落盘', () => {
    const s = usePermissionStore.getState();

    s.setPermissionMode('full');
    expect(usePermissionStore.getState().permissionMode).toBe('full');
    expect(localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)).toBe('full');

    s.setPermissionMode('ask');
    expect(usePermissionStore.getState().permissionMode).toBe('ask');
    expect(localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)).toBe('ask');

    s.setPermissionMode('smart');
    expect(usePermissionStore.getState().permissionMode).toBe('smart');
    expect(localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)).toBe('smart');
  });

  it('模块重载时从 LocalStorage 正确恢复状态', async () => {
    localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, 'full');
    vi.resetModules();
    const { usePermissionStore: freshStore } =
      await import('./permissionStore');
    expect(freshStore.getState().permissionMode).toBe('full');
  });

  it('LocalStorage 历史旧值按安全语义迁移（deep → ask），未知值回落 smart', async () => {
    localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, 'deep'); // 历史伪模式
    vi.resetModules();
    const { usePermissionStore: freshStore } =
      await import('./permissionStore');
    expect(freshStore.getState().permissionMode).toBe('ask');

    localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, 'not-a-mode');
    vi.resetModules();
    const { usePermissionStore: fallbackStore } =
      await import('./permissionStore');
    expect(fallbackStore.getState().permissionMode).toBe('smart');
  });

  it('绝不产生双写键，严禁向已剥离字段存取', () => {
    usePermissionStore.getState().setPermissionMode('full');
    const allKeys = Object.keys(localStorage);
    expect(allKeys).not.toContain('crish-permission-v1');
    expect(allKeys).not.toContain('crish_command_permissions_v1');

    // 强类型断言：Store 内部绝对不存在 planModeEnabled 或 commandPermissions
    const rawState = usePermissionStore.getState() as any;
    expect(rawState.planModeEnabled).toBeUndefined();
    expect(rawState.planApproved).toBeUndefined();
    expect(rawState.commandPermissions).toBeUndefined();
  });
});
