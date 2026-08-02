import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_MODE,
  DESKTOP_PERMISSION_MODE_IDS,
  DESKTOP_TO_ENGINE,
  coercePermissionMode,
  desktopEngineRoundTrip,
  fromEnginePermissionMode,
  isAllowPathMode,
  isAskFamilyMode,
  isAutoAliasToAsk,
  isDefaultPermissionMode,
  isPermissionMode,
  isPlanPathMode,
  loadStoredPermissionMode,
  nextPermissionMode,
  normalizePermissionMode,
  permissionModeAfterPlanToggle,
  permissionModeLabel,
  permissionModeMeta,
  permissionModeShortLabel,
  PERMISSION_MODE_STORAGE_KEY,
  PERMISSION_MODES,
  persistPermissionMode,
  planModeEnabledFor,
  previousPermissionMode,
  resolveEnginePermissionMode,
  toEnginePermissionMode,
  transitionPermissionMode,
  modeShowsApprovalUi,
} from './permissionModes';

describe('permissionModes sync', () => {
  it('DEFAULT is ask and isPermissionMode covers only desktop ids', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('ask');
    expect(isPermissionMode('ask')).toBe(true);
    expect(isPermissionMode('deep')).toBe(true);
    expect(isPermissionMode('full')).toBe(true);
    expect(isPermissionMode('plan')).toBe(true);
    expect(isPermissionMode('auto')).toBe(false);
    expect(isPermissionMode('full-access')).toBe(false);
    expect(isPermissionMode('unattended')).toBe(false);
    expect(isPermissionMode('')).toBe(false);
    expect(isPermissionMode(null)).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
    expect(isPermissionMode(42)).toBe(false);
    for (const id of DESKTOP_PERMISSION_MODE_IDS) {
      expect(isPermissionMode(id)).toBe(true);
    }
  });

  it('normalizes engine aliases to desktop modes', () => {
    expect(normalizePermissionMode('full-access')).toBe('full');
    expect(normalizePermissionMode('full_access')).toBe('full');
    expect(normalizePermissionMode('FULL_ACCESS')).toBe('full');
    expect(normalizePermissionMode('full access')).toBe('full');
    expect(normalizePermissionMode('yolo')).toBe('full');
    expect(normalizePermissionMode('danger')).toBe('full');
    expect(normalizePermissionMode('allow')).toBe('full');
    expect(normalizePermissionMode('auto')).toBe('ask');
    expect(normalizePermissionMode('autopilot')).toBe('ask');
    expect(normalizePermissionMode('project')).toBe('ask');
    expect(normalizePermissionMode('confirm')).toBe('ask');
    expect(normalizePermissionMode('default')).toBe('ask');
    expect(normalizePermissionMode('interactive')).toBe('ask');
    expect(normalizePermissionMode('readonly')).toBe('plan');
    expect(normalizePermissionMode('read_only')).toBe('plan');
    expect(normalizePermissionMode('read only')).toBe('plan');
    expect(normalizePermissionMode('safe')).toBe('plan');
    expect(normalizePermissionMode('cautious')).toBe('plan');
    expect(normalizePermissionMode('仅分析')).toBe('plan');
    expect(normalizePermissionMode('nope')).toBe('ask');
    expect(normalizePermissionMode(null)).toBe('ask');
    expect(normalizePermissionMode(undefined)).toBe('ask');
    expect(normalizePermissionMode(42)).toBe('ask');
    expect(normalizePermissionMode('')).toBe(DEFAULT_PERMISSION_MODE);
    expect(normalizePermissionMode('   ')).toBe(DEFAULT_PERMISSION_MODE);
    expect(normalizePermissionMode('\t\n')).toBe(DEFAULT_PERMISSION_MODE);
  });

  it('normalizes Chinese UX labels to desktop modes', () => {
    expect(normalizePermissionMode('需确认')).toBe('ask');
    expect(normalizePermissionMode('确认')).toBe('ask');
    expect(normalizePermissionMode('深入分析')).toBe('deep');
    expect(normalizePermissionMode('完全访问')).toBe('full');
    expect(normalizePermissionMode('全部允许')).toBe('full');
    expect(normalizePermissionMode('计划')).toBe('plan');
    expect(normalizePermissionMode('只读')).toBe('plan');
    expect(normalizePermissionMode('自动')).toBe('ask');
    expect(normalizePermissionMode('无人值守')).toBe('ask');
    // coerce 与 normalize 对合法 id 一致
    expect(coercePermissionMode('full')).toBe('full');
    expect(coercePermissionMode('完全访问')).toBe('full');
    expect(coercePermissionMode('garbage')).toBe(DEFAULT_PERMISSION_MODE);
  });

  it('maps desktop → daemon for run-task', () => {
    expect(toEnginePermissionMode('ask')).toBe('ask');
    expect(toEnginePermissionMode('deep')).toBe('ask');
    expect(toEnginePermissionMode('full')).toBe('full-access');
    expect(toEnginePermissionMode('plan')).toBe('plan');
    // unknown-mode guard
    expect(toEnginePermissionMode('nope')).toBe('ask');
    expect(toEnginePermissionMode(null)).toBe('ask');
    expect(toEnginePermissionMode('yolo')).toBe('full-access');
  });

  it('maps daemon → desktop for settings hydrate', () => {
    expect(fromEnginePermissionMode('full-access')).toBe('full');
    expect(fromEnginePermissionMode('full_access')).toBe('full');
    expect(fromEnginePermissionMode('yolo')).toBe('full');
    expect(fromEnginePermissionMode('plan')).toBe('plan');
    expect(fromEnginePermissionMode('safe')).toBe('plan');
    expect(fromEnginePermissionMode('auto')).toBe('ask');
    expect(fromEnginePermissionMode('unattended')).toBe('ask');
    expect(fromEnginePermissionMode('ci')).toBe('ask');
    expect(fromEnginePermissionMode('deep')).toBe('deep');
    expect(fromEnginePermissionMode('HEADLESS')).toBe('ask');
    expect(fromEnginePermissionMode('深入分析')).toBe('deep');
    expect(fromEnginePermissionMode('')).toBe(DEFAULT_PERMISSION_MODE);
  });

  it('keeps engineMode on meta consistent with toEnginePermissionMode', () => {
    for (const id of DESKTOP_PERMISSION_MODE_IDS) {
      expect(permissionModeMeta(id).engineMode).toBe(toEnginePermissionMode(id));
      expect(DESKTOP_TO_ENGINE[id]).toBe(toEnginePermissionMode(id));
      expect(resolveEnginePermissionMode(id)).toBe(toEnginePermissionMode(id));
    }
    // PERMISSION_MODES 顺序与 id 表覆盖一致
    expect(PERMISSION_MODES.map((m) => m.id).sort()).toEqual(
      [...DESKTOP_PERMISSION_MODE_IDS].sort(),
    );
    // unknown → DEFAULT meta
    expect(permissionModeMeta('nope').id).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolveEnginePermissionMode('garbage')).toBe('ask');
  });

  it('exposes Chinese labels for every desktop mode', () => {
    const expected: Record<(typeof DESKTOP_PERMISSION_MODE_IDS)[number], string> = {
      ask: '需确认',
      deep: '深入分析',
      plan: '计划',
      full: '完全访问',
    };
    for (const id of DESKTOP_PERMISSION_MODE_IDS) {
      const meta = permissionModeMeta(id);
      expect(meta.label).toBe(expected[id]);
      expect(meta.shortLabel).toBe(expected[id]);
      expect(permissionModeLabel(id)).toBe(expected[id]);
      expect(permissionModeShortLabel(id)).toBe(expected[id]);
      // 非空中文 UX
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
      expect(meta.matrixHint.length).toBeGreaterThan(0);
    }
    expect(permissionModeLabel('unknown-mode')).toBe('需确认');
    expect(permissionModeShortLabel(null)).toBe('需确认');
    expect(permissionModeLabel('完全访问')).toBe('完全访问');
  });

  it('classifies default / auto / ask / allow / plan paths', () => {
    expect(isDefaultPermissionMode('ask')).toBe(true);
    expect(isDefaultPermissionMode(DEFAULT_PERMISSION_MODE)).toBe(true);
    expect(isDefaultPermissionMode('deep')).toBe(false);
    expect(isDefaultPermissionMode('full')).toBe(false);
    expect(isDefaultPermissionMode('nope')).toBe(true); // coerce → ask

    expect(isAskFamilyMode('ask')).toBe(true);
    expect(isAskFamilyMode('deep')).toBe(true);
    expect(isAskFamilyMode('full')).toBe(false);
    expect(isAskFamilyMode('plan')).toBe(false);
    expect(isAskFamilyMode('confirm')).toBe(true); // → ask

    expect(isAllowPathMode('full')).toBe(true);
    expect(isAllowPathMode('yolo')).toBe(true);
    expect(isAllowPathMode('allow')).toBe(true);
    expect(isAllowPathMode('ask')).toBe(false);
    expect(isAllowPathMode('plan')).toBe(false);

    expect(isPlanPathMode('plan')).toBe(true);
    expect(isPlanPathMode('readonly')).toBe(true);
    expect(isPlanPathMode('ask')).toBe(false);

    expect(isAutoAliasToAsk('auto')).toBe(true);
    expect(isAutoAliasToAsk('autopilot')).toBe(true);
    expect(isAutoAliasToAsk('自动')).toBe(true);
    expect(isAutoAliasToAsk('ask')).toBe(false);
    expect(isAutoAliasToAsk('full')).toBe(false);
    expect(isAutoAliasToAsk(null)).toBe(false);
  });

  it('planModeEnabledFor stays in sync with plan mode', () => {
    expect(planModeEnabledFor('plan')).toBe(true);
    expect(planModeEnabledFor('ask')).toBe(false);
    expect(planModeEnabledFor('full')).toBe(false);
    expect(planModeEnabledFor('deep')).toBe(false);
    expect(planModeEnabledFor('只读')).toBe(true);
    expect(planModeEnabledFor(null)).toBe(false);
  });

  it('permissionModeAfterPlanToggle keeps ribbon ↔ mode paired', () => {
    expect(permissionModeAfterPlanToggle('ask', true)).toBe('plan');
    expect(permissionModeAfterPlanToggle('full', true)).toBe('plan');
    expect(permissionModeAfterPlanToggle('deep', true)).toBe('plan');
    expect(permissionModeAfterPlanToggle('plan', false)).toBe('ask');
    // 退出计划时若本来就不是 plan，保持（避免误踢 full）
    expect(permissionModeAfterPlanToggle('full', false)).toBe('full');
    expect(permissionModeAfterPlanToggle('deep', false)).toBe('deep');
    expect(permissionModeAfterPlanToggle('ask', false)).toBe('ask');
    // 未知当前态 + 关 plan → DEFAULT
    expect(permissionModeAfterPlanToggle('nope', false)).toBe(DEFAULT_PERMISSION_MODE);
    expect(permissionModeAfterPlanToggle(null, true)).toBe('plan');
  });

  it('cycles and transitions modes with unknown guards', () => {
    expect(nextPermissionMode('ask')).toBe('deep');
    expect(nextPermissionMode('deep')).toBe('plan');
    expect(nextPermissionMode('plan')).toBe('full');
    expect(nextPermissionMode('full')).toBe('ask');
    expect(previousPermissionMode('ask')).toBe('full');
    expect(previousPermissionMode('full')).toBe('plan');
    expect(previousPermissionMode('plan')).toBe('deep');
    expect(previousPermissionMode('deep')).toBe('ask');
    // 未知 → 从 DEFAULT(ask) 起算
    expect(nextPermissionMode('garbage')).toBe('deep');
    expect(previousPermissionMode(null)).toBe('full');

    expect(transitionPermissionMode('ask', 'full')).toBe('full');
    expect(transitionPermissionMode('plan', 'yolo')).toBe('full');
    expect(transitionPermissionMode('full', '需确认')).toBe('ask');
    expect(transitionPermissionMode('deep', '???')).toBe(DEFAULT_PERMISSION_MODE);
  });

  it('modeShowsApprovalUi excludes plan', () => {
    expect(modeShowsApprovalUi('plan')).toBe(false);
    expect(modeShowsApprovalUi('ask')).toBe(true);
    expect(modeShowsApprovalUi('full')).toBe(true);
    expect(modeShowsApprovalUi('deep')).toBe(true);
    expect(modeShowsApprovalUi('只读')).toBe(false);
    expect(modeShowsApprovalUi('nope')).toBe(true); // → ask
  });

  it('load/persistPermissionMode round-trip storage key', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
    };
    persistPermissionMode('full', storage);
    expect(mem.get(PERMISSION_MODE_STORAGE_KEY)).toBe('full');
    expect(loadStoredPermissionMode(storage)).toBe('full');
    mem.set(PERMISSION_MODE_STORAGE_KEY, 'full-access');
    expect(loadStoredPermissionMode(storage)).toBe('full');
    mem.set(PERMISSION_MODE_STORAGE_KEY, 'yolo');
    expect(loadStoredPermissionMode(storage)).toBe('full');
    mem.set(PERMISSION_MODE_STORAGE_KEY, 'unattended');
    expect(loadStoredPermissionMode(storage)).toBe('ask');
    mem.set(PERMISSION_MODE_STORAGE_KEY, '完全访问');
    expect(loadStoredPermissionMode(storage)).toBe('full');
    // 非法值 persist 时 coerce 为合法 id
    persistPermissionMode('allow', storage);
    expect(mem.get(PERMISSION_MODE_STORAGE_KEY)).toBe('full');
    persistPermissionMode('???', storage);
    expect(mem.get(PERMISSION_MODE_STORAGE_KEY)).toBe(DEFAULT_PERMISSION_MODE);
    // null storage 不抛
    expect(loadStoredPermissionMode(null)).toBe(DEFAULT_PERMISSION_MODE);
    expect(() => persistPermissionMode('ask', null)).not.toThrow();
    // getItem 抛错 → DEFAULT
    expect(
      loadStoredPermissionMode({
        getItem: () => {
          throw new Error('quota');
        },
      }),
    ).toBe(DEFAULT_PERMISSION_MODE);
    // setItem 抛错静默
    expect(() =>
      persistPermissionMode('full', {
        setItem: () => {
          throw new Error('quota');
        },
      }),
    ).not.toThrow();
  });

  it('desktop ↔ daemon round-trip is stable (deep collapses to ask)', () => {
    for (const id of DESKTOP_PERMISSION_MODE_IDS) {
      const r = desktopEngineRoundTrip(id);
      expect(r.stable).toBe(true);
      if (id === 'deep') {
        expect(r.deepCollapses).toBe(true);
        expect(r.engine).toBe('ask');
        expect(r.back).toBe('ask');
      } else {
        expect(r.back).toBe(id);
        expect(r.deepCollapses).toBe(false);
      }
    }
    const bad = desktopEngineRoundTrip('not-a-mode');
    expect(bad.stable).toBe(true);
    expect(bad.engine).toBe('ask');
    expect(bad.back).toBe('ask');
  });

  it('aligns product aliases with daemon-permission-policy matrix', () => {
    // 与 packages/agent-daemon/src/daemon-permission-policy.ts 保持契约镜像
    const daemonAliasExpectations: Array<[string, string]> = [
      ['deep', 'ask'],
      ['project', 'ask'],
      ['confirm', 'ask'],
      ['default', 'ask'],
      ['interactive', 'ask'],
      ['full', 'full-access'],
      ['full_access', 'full-access'],
      ['full-access', 'full-access'],
      ['yolo', 'full-access'],
      ['danger', 'full-access'],
      ['headless', 'unattended'],
      ['unattended', 'unattended'],
      ['batch', 'unattended'],
      ['ci', 'unattended'],
      ['readonly', 'plan'],
      ['read-only', 'plan'],
      ['analysis', 'plan'],
      ['safe', 'plan'],
      ['cautious', 'plan'],
      ['plan', 'plan'],
      ['ask', 'ask'],
      ['auto', 'auto'],
      ['autopilot', 'auto'],
    ];
    for (const [alias, daemonMode] of daemonAliasExpectations) {
      const desktop = fromEnginePermissionMode(alias);
      // unattended 族在桌面收成 ask（不暴露批处理）
      if (daemonMode === 'unattended') {
        expect(desktop).toBe('ask');
        expect(toEnginePermissionMode(desktop)).toBe('ask');
        continue;
      }
      if (daemonMode === 'auto') {
        expect(desktop).toBe('ask');
        expect(isAutoAliasToAsk(alias)).toBe(true);
        continue;
      }
      // deep 桌面可保留 deep，但引擎仍是 ask
      if (alias === 'deep') {
        expect(desktop).toBe('deep');
        expect(toEnginePermissionMode('deep')).toBe('ask');
        continue;
      }
      const engine = toEnginePermissionMode(desktop);
      if (daemonMode === 'full-access') {
        expect(desktop).toBe('full');
        expect(engine).toBe('full-access');
        expect(isAllowPathMode(desktop)).toBe(true);
      }
      if (daemonMode === 'plan') {
        expect(desktop).toBe('plan');
        expect(engine).toBe('plan');
        expect(isPlanPathMode(desktop)).toBe(true);
      }
      if (daemonMode === 'ask') {
        expect(desktop).toBe('ask');
        expect(engine).toBe('ask');
        expect(isAskFamilyMode(desktop)).toBe(true);
      }
    }
  });
});
