import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_IDS,
  PERMISSION_MODE_STORAGE_KEY,
  coercePermissionMode,
  isPermissionMode,
  loadStoredPermissionMode,
  nextPermissionMode,
  permissionModeMeta,
  persistPermissionMode,
  previousPermissionMode,
} from './permissionModes';
import {
  permissionModeLabel,
  permissionModeShortLabel,
} from '../i18n/permissionModeText';

describe('permissionModes — 纯三态单一真理单测', () => {
  it('默认模式必须严格为 smart (推荐默认)', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('smart');
  });

  it('模式 ID 列表仅包含 ask, smart, full', () => {
    expect(PERMISSION_MODE_IDS).toEqual(['ask', 'smart', 'full']);
  });

  it('isPermissionMode 仅对合法三态返回 true，对任何历史废弃值返回 false', () => {
    expect(isPermissionMode('ask')).toBe(true);
    expect(isPermissionMode('smart')).toBe(true);
    expect(isPermissionMode('full')).toBe(true);

    // 严厉断言：历史别名与伪模式一律不再被认可
    expect(isPermissionMode('deep')).toBe(false);
    expect(isPermissionMode('plan')).toBe(false);
    expect(isPermissionMode('full-access')).toBe(false);
    expect(isPermissionMode('yolo')).toBe(false);
    expect(isPermissionMode('auto')).toBe(false);
    expect(isPermissionMode('每次询问')).toBe(false);
    expect(isPermissionMode(null)).toBe(false);
    expect(isPermissionMode('')).toBe(false);
  });

  it('coercePermissionMode 合法三态直通；历史只读语义回落 ask，未知值回落 smart', () => {
    expect(coercePermissionMode('ask')).toBe('ask');
    expect(coercePermissionMode('smart')).toBe('smart');
    expect(coercePermissionMode('full')).toBe('full');

    // 安全迁移：只读/分析类历史值绝不升级为可写的 smart
    expect(coercePermissionMode('deep')).toBe('ask');
    expect(coercePermissionMode('plan')).toBe('ask');
    expect(coercePermissionMode('readonly')).toBe('ask');
    // 历史完全访问别名归一到 full
    expect(coercePermissionMode('full-access')).toBe('full');
    expect(coercePermissionMode('yolo')).toBe('full');
    // 未知 / 缺省 → 推荐默认 smart
    expect(coercePermissionMode('garbage')).toBe('smart');
    expect(coercePermissionMode(undefined)).toBe('smart');
    expect(coercePermissionMode(null)).toBe('smart');
  });

  it('模式循环切换闭环正确', () => {
    // 顺时针：ask -> smart -> full -> ask
    expect(nextPermissionMode('ask')).toBe('smart');
    expect(nextPermissionMode('smart')).toBe('full');
    expect(nextPermissionMode('full')).toBe('ask');

    // 逆时针：ask -> full -> smart -> ask
    expect(previousPermissionMode('ask')).toBe('full');
    expect(previousPermissionMode('full')).toBe('smart');
    expect(previousPermissionMode('smart')).toBe('ask');
  });

  it('元数据只持有 i18n 键，文案经渲染层解析正确', () => {
    const askMeta = permissionModeMeta('ask');
    expect(askMeta.labelKey).toBe('settings.security.modeAskLabel');
    expect(permissionModeLabel('ask')).toBe('每次询问');
    expect(permissionModeShortLabel('ask')).toBe('每次询问');

    const smartMeta = permissionModeMeta('smart');
    expect(smartMeta.labelKey).toBe('settings.security.modeSmartLabel');
    expect(smartMeta.isRecommended).toBe(true);

    const fullMeta = permissionModeMeta('full');
    expect(fullMeta.labelKey).toBe('settings.security.modeFullLabel');
    expect(fullMeta.shortLabelKey).toBe('settings.security.modeFullShortLabel');
    expect(permissionModeLabel('full')).toBe('完全允许');
    expect(permissionModeShortLabel('full')).toBe('完全放行');
  });

  it('持久化读写与自动清理旧白名单脏数据', () => {
    localStorage.clear();
    // 模拟历史残留的旧白名单键
    localStorage.setItem('crish_command_permissions_v1', '["git status"]');

    expect(loadStoredPermissionMode()).toBe('smart');
    // 断言读取时已顺手擦除旧白名单键
    expect(localStorage.getItem('crish_command_permissions_v1')).toBeNull();

    persistPermissionMode('full');
    expect(localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)).toBe('full');
    expect(loadStoredPermissionMode()).toBe('full');

    // 遇到旧存储值如 plan，读取时按安全语义回落 ask（绝不升级为可写 smart）
    localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, 'plan');
    expect(loadStoredPermissionMode()).toBe('ask');
  });
});
