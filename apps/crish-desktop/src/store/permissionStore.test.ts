/**
 * permissionStore 单测：三态联动 / 命令白名单 / localStorage 持久化行为。
 * 操作全局 singleton 后复位，避免污染其他域 store 测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePermissionStore } from './permissionStore';
import { COMMAND_PERMISSIONS_STORAGE_KEY } from '../api/commandPermissions';
import { PERMISSION_MODE_STORAGE_KEY } from '../api/permissionModes';

/** 与 api/commandPermissions DEFAULT_SEED 对齐（loadCommandPermissions 无键时返回） */
const DEFAULT_SEED_AS_READ = [
  'git status',
  'git diff',
  'git log',
  'npm test',
  'npm run test',
];

beforeEach(() => {
  localStorage.clear();
  usePermissionStore.setState({
    permissionMode: 'ask',
    planModeEnabled: false,
    planApproved: false,
    commandPermissions: [...DEFAULT_SEED_AS_READ],
  });
});

afterEach(() => {
  localStorage.clear();
});

describe('permissionStore — plan linkage', () => {
  it('setPermissionMode derives planModeEnabled and resets planApproved', () => {
    const s = usePermissionStore.getState();
    s.setPlanApproved(true);
    s.setPermissionMode('plan');
    let st = usePermissionStore.getState();
    expect(st.permissionMode).toBe('plan');
    expect(st.planModeEnabled).toBe(true);
    expect(st.planApproved).toBe(false);

    s.setPlanApproved(true);
    s.setPermissionMode('ask');
    st = usePermissionStore.getState();
    expect(st.permissionMode).toBe('ask');
    expect(st.planModeEnabled).toBe(false);
    expect(st.planApproved).toBe(false);
  });

  it('setPlanModeEnabled pairs with permissionMode via plan toggle rule', () => {
    const s = usePermissionStore.getState();
    s.setPlanModeEnabled(true);
    let st = usePermissionStore.getState();
    expect(st.permissionMode).toBe('plan');
    expect(st.planModeEnabled).toBe(true);

    s.setPlanApproved(true);
    s.setPlanModeEnabled(false);
    st = usePermissionStore.getState();
    expect(st.permissionMode).toBe('ask');
    expect(st.planModeEnabled).toBe(false);
    expect(st.planApproved).toBe(false);
  });

  it('setPlanApproved toggles only the approved flag', () => {
    const s = usePermissionStore.getState();
    s.setPlanApproved(true);
    expect(usePermissionStore.getState().planApproved).toBe(true);
    s.setPlanApproved(false);
    expect(usePermissionStore.getState().planApproved).toBe(false);
  });

  it('setPermissionMode persists to crish_permission_mode', () => {
    usePermissionStore.getState().setPermissionMode('full');
    expect(localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)).toBe('full');
  });
});

describe('permissionStore — command whitelist', () => {
  it('addCommandPermission persists and dedupes', () => {
    const s = usePermissionStore.getState();
    s.addCommandPermission('git status');
    s.addCommandPermission('git push');
    const st = usePermissionStore.getState();
    expect(st.commandPermissions).toContain('git push');
    expect(
      st.commandPermissions.filter((c) => c === 'git status')
    ).toHaveLength(1);
    const stored = JSON.parse(
      localStorage.getItem(COMMAND_PERMISSIONS_STORAGE_KEY) ?? '[]'
    ) as string[];
    expect(stored).toContain('git push');
  });

  it('removeCommandPermission persists removal', () => {
    const s = usePermissionStore.getState();
    s.removeCommandPermission('git status');
    const st = usePermissionStore.getState();
    expect(st.commandPermissions).not.toContain('git status');
    const stored = JSON.parse(
      localStorage.getItem(COMMAND_PERMISSIONS_STORAGE_KEY) ?? '[]'
    ) as string[];
    expect(stored).not.toContain('git status');
  });

  it('setCommandPermissions replaces the list and persists', () => {
    const s = usePermissionStore.getState();
    s.setCommandPermissions(['npm test', 'npm run test']);
    const st = usePermissionStore.getState();
    expect(st.commandPermissions).toEqual(['npm test', 'npm run test']);
    const stored = JSON.parse(
      localStorage.getItem(COMMAND_PERMISSIONS_STORAGE_KEY) ?? '[]'
    ) as string[];
    expect(stored).toEqual(['npm test', 'npm run test']);

    // 非数组安全回落
    s.setCommandPermissions('nope' as unknown as string[]);
    expect(usePermissionStore.getState().commandPermissions).toEqual([]);
  });
});

describe('permissionStore — persistence boundary', () => {
  it('rehydrates permissionMode from localStorage on fresh module', async () => {
    usePermissionStore.getState().setPermissionMode('plan');
    vi.resetModules();
    const { usePermissionStore: freshPermission } = await import(
      './permissionStore'
    );
    const st = freshPermission.getState();
    expect(st.permissionMode).toBe('plan');
    expect(st.planModeEnabled).toBe(true);
  });

  it('does not double-persist via zustand persist (no crish-permission-v1 key)', () => {
    usePermissionStore.getState().setPermissionMode('deep');
    const zustandKeys = Object.keys(localStorage).filter((k) =>
      k.startsWith('crish-')
    );
    expect(zustandKeys).not.toContain('crish-permission-v1');
  });
});
