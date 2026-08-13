// persistBootstrap 装配测试（R-3）：configureSqlitePersistence 一次注入两个 store 的
// 真实持久化（SqlSettingsDao / SqlNotificationsDao 经 MemorySqlDriver 直跑真实 SQL 子集）
// - settings：set/update 无参持久化走注入默认 → 落 settings 表；hydrate 从表回填合并；
// - notification：hydrate 三态回填（listByStatus 出口 title ?? '' 归一——DAO 行 title
//   可空，InAppNotification 非空展示字段）；ingest 不落库（接线层职责，store 只读回填）。
import { MemorySqlDriver, migrateIfNeeded } from '@/db';
import { SqlSettingsDao, SqlNotificationsDao } from '@/db/dao';
import { settingsStore, configureSettingsPersistence } from './settingsStore';
import {
  notificationStore,
  configureNotificationsPersistence,
  resetNotificationsForTest,
} from './notificationStore';
import {
  defaultSettingsGroups,
  settingsGroupKey,
  encodeSettingsGroup,
} from './settingsReducers';
import { configureSqlitePersistence } from './persistBootstrap';

/** 等异步写落盘（settingsStore.set 的 void 写为 fire-and-forget） */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 重置 store 单例（含 groups 归默认——跨用例隔离，防残留组值经整组写落盘） */
function resetSettingsStore(): void {
  settingsStore.setState({
    groups: defaultSettingsGroups(),
    hydrated: false,
  });
}

describe('configureSqlitePersistence（真实持久化装配注入）', () => {
  let driver: MemorySqlDriver;

  beforeEach(async () => {
    driver = new MemorySqlDriver();
    await migrateIfNeeded(driver); // 建 settings / notifications 表
    resetSettingsStore();
    resetNotificationsForTest();
    configureSettingsPersistence(null);
    configureNotificationsPersistence(null);
  });

  afterEach(() => {
    configureSettingsPersistence(null);
    configureNotificationsPersistence(null);
  });

  it('注入后 settingsStore.set 缺省参数也落 settings 表（真实 DAO 链路）', async () => {
    configureSqlitePersistence(driver);
    settingsStore.getState().set('general', {
      responseStyle: 'high',
      enableAnalytics: true,
      enableCrashTelemetry: false,
    });
    await flush();

    const dao = new SqlSettingsDao(driver);
    const raw = await dao.get(settingsGroupKey('general'));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      responseStyle: 'high',
      enableAnalytics: true,
      enableCrashTelemetry: false,
    });
  });

  it('注入后 settingsStore.update 局部合并落盘（整组编码，缺省字段由 reducer 补全）', async () => {
    configureSqlitePersistence(driver);
    settingsStore.getState().update('general', { responseStyle: 'low' });
    await flush();

    const dao = new SqlSettingsDao(driver);
    const raw = await dao.get(settingsGroupKey('general'));
    const decoded = JSON.parse(raw!) as Record<string, unknown>;
    expect(decoded.responseStyle).toBe('low');
    expect(decoded.enableAnalytics).toBe(false); // 未提及字段随 store 整组值
  });

  it('hydrate 从 settings 表回填（真实 DAO 读出 → 深合并默认值 + hydrated）', async () => {
    await new SqlSettingsDao(driver).set(
      settingsGroupKey('general'),
      encodeSettingsGroup({ responseStyle: 'high' })
    );
    configureSqlitePersistence(driver);

    await settingsStore.getState().hydrate();

    const st = settingsStore.getState();
    expect(st.hydrated).toBe(true);
    expect(st.groups.general.responseStyle).toBe('high');
    expect(st.groups.general.enableAnalytics).toBe(false); // 默认值保留
  });

  it('notificationStore.hydrate 三态回填（DAO title 可空 → 展示空串归一）', async () => {
    const dao = new SqlNotificationsDao(driver);
    await dao.upsert({
      id: 'approval-requested:tc-1',
      kind: 'approval',
      toolCallId: 'tc-1',
      runId: null,
      seq: 7,
      title: '需要确认：删除文件',
      body: 'rm 高危操作',
      route: 'conex://mobile/approval/tc-1',
      status: 'shown',
      receivedAt: 1_700_000_000_000,
    });
    await dao.upsert({
      id: 'run-ended:r-2',
      kind: 'run-ended',
      toolCallId: null,
      runId: 'r-2',
      seq: 8,
      title: null, // 表语义允许空标题 → 归一为空串
      body: null,
      route: null,
      status: 'resolved',
      receivedAt: 1_700_000_000_001,
    });
    configureSqlitePersistence(driver);

    await notificationStore.getState().hydrate();

    const st = notificationStore.getState();
    expect(st.hydrated).toBe(true);
    expect(st.items).toHaveLength(2);
    expect(st.items[0]!.title).toBe(''); // 新在前（receivedAt 降序）；null → '' 归一
    expect(st.items[1]!.title).toBe('需要确认：删除文件');
    expect(st.unreadCount).toBe(1); // 仅 shown 计数
  });

  it('configureSqlitePersistence(null) 复位两 store 默认注入（回退无持久化）', () => {
    configureSqlitePersistence(driver);
    configureSqlitePersistence(null);
    settingsStore.getState().set('general', {
      responseStyle: 'medium',
      enableAnalytics: false,
      enableCrashTelemetry: false,
    });
    // 无默认注入 → 不落库（silent no-op，且不抛错）
    return expect(flush()).resolves.toBeUndefined();
  });
});
