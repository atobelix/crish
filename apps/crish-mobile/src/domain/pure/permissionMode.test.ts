// permissionMode 纯函数单测（G1）：三档与文案对齐桌面、映射恒等、规范化口径。
import {
  coercePermissionMode,
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  PERMISSION_MODE_OPTIONS,
  permissionModeOption,
  runPermissionMode,
  wirePermissionMode,
} from './permissionMode';

describe('PERMISSION_MODE_OPTIONS（与桌面 PERMISSION_MODES 对齐）', () => {
  it('三档、顺序 ask → smart → full', () => {
    expect(PERMISSION_MODE_OPTIONS.map((o) => o.id)).toEqual([
      'ask',
      'smart',
      'full',
    ]);
  });

  it('文案逐字引桌面 zh-CN 字典（settingsParts mode* 键）', () => {
    expect(permissionModeOption('ask')).toMatchObject({
      label: '每次询问',
      shortLabel: '每次询问',
      description: '改文件、写操作与命令执行前均需确认',
    });
    expect(permissionModeOption('smart')).toMatchObject({
      label: '智能放行',
      shortLabel: '智能放行',
      description: '安全只读命令直接运行，写操作与危险命令需确认',
      recommended: true,
    });
    expect(permissionModeOption('full')).toMatchObject({
      label: '完全允许',
      shortLabel: '完全放行',
      description: '除物理毁灭级命令外全部放行，不再逐条确认',
    });
  });

  it('缺省档与桌面一致（smart）', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('smart');
  });
});

describe('wirePermissionMode（档位 → 协议申报值，照抄桌面恒等映射）', () => {
  it.each([
    ['ask', 'ask'],
    ['smart', 'smart'],
    ['full', 'full'],
  ] as const)('%s → %s', (mode, wire) => {
    expect(wirePermissionMode(mode)).toBe(wire);
  });
});

describe('coercePermissionMode（镜像桌面规范化）', () => {
  it('合法三档原样', () => {
    expect(coercePermissionMode('ask')).toBe('ask');
    expect(coercePermissionMode('smart')).toBe('smart');
    expect(coercePermissionMode('full')).toBe('full');
    expect(isPermissionMode('smart')).toBe(true);
    expect(isPermissionMode('plan')).toBe(false);
  });

  it('历史值迁移：完全访问类 → full；只读/计划类 → ask；auto → smart', () => {
    expect(coercePermissionMode('full-access')).toBe('full');
    expect(coercePermissionMode('yolo')).toBe('full');
    expect(coercePermissionMode('plan')).toBe('ask');
    expect(coercePermissionMode('readonly')).toBe('ask');
    expect(coercePermissionMode('auto')).toBe('smart');
  });

  it('未知/非字符串回落默认 smart', () => {
    expect(coercePermissionMode('bogus')).toBe('smart');
    expect(coercePermissionMode(undefined)).toBe('smart');
    expect(coercePermissionMode(42)).toBe('smart');
    expect(permissionModeOption('bogus').id).toBe('smart');
  });
});

describe('runPermissionMode（存量值 → 最终申报值）', () => {
  it('三档直达；脏值先规范化', () => {
    expect(runPermissionMode('ask')).toBe('ask');
    expect(runPermissionMode('smart')).toBe('smart');
    expect(runPermissionMode('full')).toBe('full');
    expect(runPermissionMode('full-access')).toBe('full');
    expect(runPermissionMode(null)).toBe('smart');
  });
});
