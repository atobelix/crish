// settingsStore 单测（R2-14 第三波 · R4 批次2 收敛）：默认值装配 / get 读 / set 整组替换 /
// update 局部合并（含嵌套组单字段补丁）/ 类型安全（编译期断言：分组名与字段越界拒绝）/
// hydrate 回填合并 / 持久化接口注入（写 kv 键与 JSON 编码 / 失败静默）
import {
  settingsStore,
  configureSettingsPersistence,
  type SettingsPersist,
} from './settingsStore';
import {
  defaultSettingsGroups,
  mergeSettingsGroup,
  settingsGroupKey,
  encodeSettingsGroup,
} from './settingsReducers';

function resetStore(): void {
  settingsStore.setState({
    groups: defaultSettingsGroups(),
    hydrated: false,
  });
}

/** 可注入 fake 持久化（kv 形状：内存 Map + jest.fn 断言调用面） */
function makePersist(initial?: Record<string, string>): SettingsPersist & {
  get: jest.Mock;
  set: jest.Mock;
  getAll: jest.Mock;
} {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    get: jest.fn(async (key: string) => map.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      map.set(key, value);
    }),
    getAll: jest.fn(async () =>
      [...map.entries()].map(([key, value]) => ({ key, value }))
    ),
  };
}

beforeEach(() => {
  resetStore();
  configureSettingsPersistence(null); // 隔离默认持久化注入
});

describe('默认值装配（F6 §9 / §10.2）', () => {
  it('两组缺省值就位（通知默认开关表 / 外观 system）', () => {
    const groups = settingsStore.getState().groups;
    expect(groups.notification.masterOn).toBe(true);
    expect(groups.notification.sceneFlags).toEqual({
      message: true,
      taskDone: true,
      approval: true,
      error: true,
      deviceOffline: false,
    });
    expect(groups.appearance).toEqual({ theme: 'system' });
  });
});

describe('get / set / update（读写与合并）', () => {
  it('get 返回分组快照（类型随分组映射）', () => {
    const st = settingsStore.getState();
    expect(st.get('appearance').theme).toBe('system');
    expect(st.get('notification').masterOn).toBe(true);
  });

  it('set 整组替换，其它分组不受影响', () => {
    const st = settingsStore.getState();
    st.set('appearance', { theme: 'dark' });
    expect(settingsStore.getState().get('appearance')).toEqual({
      theme: 'dark',
    });
    expect(settingsStore.getState().get('notification').masterOn).toBe(true);
  });

  it('update 局部合并：未提及字段保留', () => {
    const st = settingsStore.getState();
    st.update('appearance', { theme: 'dark' });
    expect(settingsStore.getState().get('appearance').theme).toBe('dark');
  });

  it('update 嵌套组单字段补丁（sceneFlags 递归合并）', () => {
    const st = settingsStore.getState();
    st.update('notification', { sceneFlags: { deviceOffline: true } });
    st.update('notification', { masterOn: false });
    const notify = settingsStore.getState().get('notification');
    expect(notify.sceneFlags.deviceOffline).toBe(true);
    expect(notify.sceneFlags.message).toBe(true); // 未提及保留
    expect(notify.masterOn).toBe(false);
  });

  it('mergeSettingsGroup 纯函数：嵌套对象递归、标量覆盖、undefined 跳过', () => {
    const merged = mergeSettingsGroup(
      { a: 1, nested: { x: 1, y: 2 }, flag: true },
      { nested: { y: 9 }, flag: false }
    );
    expect(merged).toEqual({ a: 1, nested: { x: 1, y: 9 }, flag: false });
    // undefined 补丁跳过（不覆盖既有值）
    const withUndefined = mergeSettingsGroup({ a: 1, b: 2 }, { a: undefined });
    expect(withUndefined).toEqual({ a: 1, b: 2 });
  });
});

describe('类型安全（编译期断言：分组名 / 字段越界拒绝）', () => {
  it('tsc 编译期拒绝不存在的分组名与字段（函数不执行，仅类型层验证）', () => {
    // 以下断言由 npx tsc --noEmit 验证；运行时函数不调用。
    // 注：@ts-expect-error 只压掉紧随其后的下一行错误，故断言单行书写。
    function compileTimeOnly(): void {
      // @ts-expect-error 不存在的分组名编译期拒绝
      settingsStore.getState().set('nope', {});
      // @ts-expect-error 不存在的分组名编译期拒绝
      settingsStore.getState().get('nope');
      // prettier-ignore
      // @ts-expect-error notification 组没有 responseStyle 字段（字段越界拒绝）
      settingsStore.getState().update('notification', { responseStyle: 'high' });
      // @ts-expect-error theme 取值越界（非 system/light/dark）
      settingsStore.getState().update('appearance', { theme: 'blue' });
      // @ts-expect-error 整组替换类型不匹配（appearance 不接受 notification 形状）
      settingsStore.getState().set('appearance', { masterOn: true });
      // prettier-ignore
      // @ts-expect-error sceneFlags 键越界（无 unknown 场景）
      settingsStore.getState().update('notification', { sceneFlags: { unknown: true } });
    }
    expect(typeof compileTimeOnly).toBe('function');
  });
});

describe('hydrate（启动回填 + 缺字段合并 + 失败降级）', () => {
  it('kv 已有分组回填并与默认值深合并（缺字段用默认）', async () => {
    const persist = makePersist({
      [settingsGroupKey('appearance')]: encodeSettingsGroup({
        theme: 'dark',
      }),
      [settingsGroupKey('notification')]: encodeSettingsGroup({
        masterOn: false,
      }),
    });
    await settingsStore.getState().hydrate(persist);
    const st = settingsStore.getState();
    expect(st.hydrated).toBe(true);
    expect(st.get('appearance').theme).toBe('dark');
    expect(st.get('notification').masterOn).toBe(false);
    expect(st.get('notification').sceneFlags.message).toBe(true); // 缺字段默认
  });

  it('非法 JSON 分组跳过（保持默认值，不崩溃）', async () => {
    const persist = makePersist({
      [settingsGroupKey('appearance')]: '{broken json',
    });
    await settingsStore.getState().hydrate(persist);
    expect(settingsStore.getState().get('appearance').theme).toBe('system');
    expect(settingsStore.getState().hydrated).toBe(true);
  });

  it('读取失败不阻塞启动（默认值 + hydrated=true）', async () => {
    const persist = makePersist();
    persist.getAll.mockRejectedValueOnce(new Error('kv read error'));
    await settingsStore.getState().hydrate(persist);
    expect(settingsStore.getState().hydrated).toBe(true);
    expect(settingsStore.getState().get('appearance').theme).toBe('system');
  });

  it('无持久化注入时 hydrate 仅置位 hydrated（不读写）', async () => {
    await settingsStore.getState().hydrate();
    expect(settingsStore.getState().hydrated).toBe(true);
  });
});

describe('持久化接口注入（写 kv 键与 JSON 编码）', () => {
  it('set 写 kv：键 = settings.<group>，值 = JSON 编码', async () => {
    const persist = makePersist();
    settingsStore.getState().set('appearance', { theme: 'light' }, persist);
    await Promise.resolve(); // 让异步写 settle（调用面在同步段已断言）
    expect(persist.set).toHaveBeenCalledTimes(1);
    expect(persist.set).toHaveBeenCalledWith(
      'settings.appearance',
      JSON.stringify({ theme: 'light' })
    );
  });

  it('update 写 kv：持久化的是合并后的完整分组', async () => {
    const persist = makePersist();
    settingsStore
      .getState()
      .update('notification', { sceneFlags: { error: false } }, persist);
    await Promise.resolve();
    expect(persist.set).toHaveBeenCalledTimes(1);
    const [key, raw] = persist.set.mock.calls[0] as [string, string];
    expect(key).toBe('settings.notification');
    const written = JSON.parse(raw) as Record<string, unknown>;
    expect((written.sceneFlags as Record<string, boolean>).error).toBe(false);
    expect((written.sceneFlags as Record<string, boolean>).message).toBe(true);
    expect(written.masterOn).toBe(true);
  });

  it('configureSettingsPersistence 注入默认持久化（set/update 缺省参数也落盘）', async () => {
    const persist = makePersist();
    configureSettingsPersistence(persist);
    settingsStore.getState().update('appearance', { theme: 'dark' });
    await Promise.resolve();
    expect(persist.set).toHaveBeenCalledWith(
      'settings.appearance',
      JSON.stringify({ theme: 'dark' })
    );
  });

  it('写入失败静默（不抛到交互路径，内存值已生效）', async () => {
    const persist = makePersist();
    persist.set.mockRejectedValueOnce(new Error('kv write error'));
    expect(() => {
      settingsStore.getState().update('appearance', { theme: 'dark' });
    }).not.toThrow();
    await Promise.resolve();
    expect(settingsStore.getState().get('appearance').theme).toBe('dark');
  });

  it('未注入持久化时 set/update 不落盘（仅内存）', async () => {
    settingsStore.getState().update('appearance', { theme: 'dark' });
    await Promise.resolve();
    expect(settingsStore.getState().get('appearance').theme).toBe('dark');
  });
});
