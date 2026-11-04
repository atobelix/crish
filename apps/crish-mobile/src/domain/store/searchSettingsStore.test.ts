import {
  configureSearchSettingsPersistence,
  decodeSearchSettingsState,
  defaultSearchSettingsState,
  resetSearchSettingsForTest,
  SEARCH_SETTINGS_KV_KEY,
  type SearchSettingsPersist,
  useSearchSettingsStore,
} from './searchSettingsStore';

class FakeSettingsPersist implements SearchSettingsPersist {
  public data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

describe('searchSettingsStore', () => {
  let fakePersist: FakeSettingsPersist;

  beforeEach(() => {
    resetSearchSettingsForTest();
    fakePersist = new FakeSettingsPersist();
    configureSearchSettingsPersistence(fakePersist);
  });

  afterEach(() => {
    resetSearchSettingsForTest();
  });

  describe('初始默认状态断言', () => {
    it('具备符合业务规范的默认值', () => {
      const state = useSearchSettingsStore.getState();
      expect(state.enabled).toBe(true);
      expect(state.modelToolsPreferred).toBe(true);
      expect(state.selectedByokProvider).toBe('tavily');
      expect(state.enabledFreeEngines).toEqual([
        'wikipedia',
        'duckduckgo',
        'baidu',
      ]);
      expect(state.maxTokensPerFetch).toBe(4000);
      expect(state.threadOverrides).toEqual({});
    });
  });

  describe('状态更新 Actions 测试', () => {
    it('setEnabled 更新全局总开关', () => {
      const store = useSearchSettingsStore.getState();
      store.setEnabled(false);
      expect(useSearchSettingsStore.getState().enabled).toBe(false);
      store.setEnabled(true);
      expect(useSearchSettingsStore.getState().enabled).toBe(true);
    });

    it('setModelToolsPreferred 更新原生搜索优先开关', () => {
      const store = useSearchSettingsStore.getState();
      store.setModelToolsPreferred(false);
      expect(useSearchSettingsStore.getState().modelToolsPreferred).toBe(false);
    });

    it('setSelectedByokProvider 更新选中的 BYOK 提供商', () => {
      const store = useSearchSettingsStore.getState();
      store.setSelectedByokProvider('brave');
      expect(useSearchSettingsStore.getState().selectedByokProvider).toBe(
        'brave'
      );
    });

    it('setEnabledFreeEngines 更新免 Key 引擎列表及其排序', () => {
      const store = useSearchSettingsStore.getState();
      store.setEnabledFreeEngines(['duckduckgo', 'searxng']);
      expect(useSearchSettingsStore.getState().enabledFreeEngines).toEqual([
        'duckduckgo',
        'searxng',
      ]);
    });

    it('setMaxTokensPerFetch 更新单网页提取 Token 上限', () => {
      const store = useSearchSettingsStore.getState();
      store.setMaxTokensPerFetch(2000);
      expect(useSearchSettingsStore.getState().maxTokensPerFetch).toBe(2000);
    });

    it('resetToDefaults 复位至初始默认配置', () => {
      const store = useSearchSettingsStore.getState();
      store.setEnabled(false);
      store.setSelectedByokProvider('exa');
      store.setMaxTokensPerFetch(8000);
      store.setThreadOverride('t1', true);

      store.resetToDefaults();
      expect(useSearchSettingsStore.getState()).toEqual(
        expect.objectContaining(defaultSearchSettingsState())
      );
    });
  });

  describe('会话 override 优先级测试 (isSearchEnabledForThread)', () => {
    it('未设置 override 时，会话跟随全局 enabled 状态', () => {
      const store = useSearchSettingsStore.getState();

      store.setEnabled(true);
      expect(store.isSearchEnabledForThread('thread-1')).toBe(true);
      expect(store.isSearchEnabledForThread()).toBe(true);
      expect(store.isSearchEnabledForThread(null)).toBe(true);

      store.setEnabled(false);
      expect(store.isSearchEnabledForThread('thread-1')).toBe(false);
      expect(store.isSearchEnabledForThread()).toBe(false);
      expect(store.isSearchEnabledForThread(null)).toBe(false);
    });

    it('全局为 true 时，会话 override 为 false 具有更高优先级（覆盖全局）', () => {
      const store = useSearchSettingsStore.getState();
      store.setEnabled(true);

      store.setThreadOverride('thread-off', false);

      // thread-off 被禁用
      expect(store.isSearchEnabledForThread('thread-off')).toBe(false);
      // 未设置 override 的其他线程依然生效
      expect(store.isSearchEnabledForThread('thread-default')).toBe(true);
    });

    it('全局为 false 时，会话 override 为 true 具有更高优先级（覆盖全局）', () => {
      const store = useSearchSettingsStore.getState();
      store.setEnabled(false);

      store.setThreadOverride('thread-on', true);

      // thread-on 强制开启
      expect(store.isSearchEnabledForThread('thread-on')).toBe(true);
      // 其他线程依然处于关闭状态
      expect(store.isSearchEnabledForThread('thread-default')).toBe(false);
    });

    it('移除 override (设为 null 或 undefined) 时，会话恢复继承全局状态', () => {
      const store = useSearchSettingsStore.getState();
      store.setEnabled(false);

      store.setThreadOverride('thread-temp', true);
      expect(store.isSearchEnabledForThread('thread-temp')).toBe(true);

      // 设为 null 移除 override
      store.setThreadOverride('thread-temp', null);
      expect(store.isSearchEnabledForThread('thread-temp')).toBe(false);

      // 设为 undefined 同样移除 override
      store.setThreadOverride('thread-temp-2', false);
      store.setThreadOverride('thread-temp-2', undefined);
      expect(
        useSearchSettingsStore.getState().threadOverrides['thread-temp-2']
      ).toBeUndefined();
    });
  });

  describe('KV 持久化与水合 (Hydration)', () => {
    it('状态变更自动触发异步持久化写入', async () => {
      const store = useSearchSettingsStore.getState();
      store.setSelectedByokProvider('jina');
      store.setMaxTokensPerFetch(6000);

      // 等待微任务完成持久化异步写
      await Promise.resolve();

      const savedJson = await fakePersist.get(SEARCH_SETTINGS_KV_KEY);
      expect(savedJson).not.toBeNull();
      const parsed = JSON.parse(savedJson!);
      expect(parsed.selectedByokProvider).toBe('jina');
      expect(parsed.maxTokensPerFetch).toBe(6000);
      expect(parsed.enabled).toBe(true);
    });

    it('水合 (hydrate) 成功从持久化恢复全部配置状态', async () => {
      const customizedState = {
        enabled: false,
        modelToolsPreferred: false,
        selectedByokProvider: 'bocha',
        enabledFreeEngines: ['baidu'],
        maxTokensPerFetch: 1500,
        threadOverrides: { 'saved-thread-1': true },
      };
      await fakePersist.set(
        SEARCH_SETTINGS_KV_KEY,
        JSON.stringify(customizedState)
      );

      // 执行水合
      await useSearchSettingsStore.getState().hydrate();

      const hydrated = useSearchSettingsStore.getState();
      expect(hydrated.enabled).toBe(false);
      expect(hydrated.modelToolsPreferred).toBe(false);
      expect(hydrated.selectedByokProvider).toBe('bocha');
      expect(hydrated.enabledFreeEngines).toEqual(['baidu']);
      expect(hydrated.maxTokensPerFetch).toBe(1500);
      expect(hydrated.threadOverrides).toEqual({ 'saved-thread-1': true });
      expect(hydrated.isSearchEnabledForThread('saved-thread-1')).toBe(true);
      expect(hydrated.isSearchEnabledForThread('other-thread')).toBe(false);
    });

    it('decodeSearchSettingsState 纯函数健壮容错（脏数据降级回退）', () => {
      // 空值或非 JSON
      expect(decodeSearchSettingsState(null)).toEqual(
        defaultSearchSettingsState()
      );
      expect(decodeSearchSettingsState('invalid-json')).toEqual(
        defaultSearchSettingsState()
      );

      // 部分字段缺失或类型错误
      const corrupted = JSON.stringify({
        enabled: 'not-a-boolean',
        maxTokensPerFetch: -100,
        enabledFreeEngines: 'not-an-array',
        selectedByokProvider: '',
        threadOverrides: null,
      });
      const decoded = decodeSearchSettingsState(corrupted);
      expect(decoded.enabled).toBe(true);
      expect(decoded.maxTokensPerFetch).toBe(4000);
      expect(decoded.enabledFreeEngines).toEqual([
        'wikipedia',
        'duckduckgo',
        'baidu',
      ]);
      expect(decoded.selectedByokProvider).toBe('tavily');
      expect(decoded.threadOverrides).toEqual({});
    });
  });
});
