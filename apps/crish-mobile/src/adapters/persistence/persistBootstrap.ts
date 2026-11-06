// 领域层持久化装配引导（R-3 落地）：settings / notification store 的真实持久化注入点
// - 背景：settingsStore / notificationStore 的 configure* 注入面（R2-14 第三波）已备，
//   wiring 层尚未接线 → 本文件提供基于 SqlDriver 的最小装配：一次调用完成两个
//   store 的真实持久化注入（SqlSettingsDao / SqlNotificationsDao，R2-13 交付）；
// - 接线形态：app 启动装配处（SQLiteProvider onInit / 启动 bootstrap）先
//   openDatabaseAsync + migrateIfNeeded 得到 SqlDriver，再调 configureSqlitePersistence；
//   jest 环境用 MemorySqlDriver + migrateIfNeeded 后调用（测试注入面与真实环境同构）；
// - 类型适配：SqlSettingsDao 结构上满足 SettingsPersist（get/set/getAll 同形）；
//   SqlNotificationsDao 的 NotificationRow.title 为可空（表语义），而
//   InAppNotification.title 为非空展示字段（reducers 注释「title 展示缺省空串」）→
//   DaoNotificationsPersist 在 listByStatus 出口做 title ?? '' 归一（去重/排序语义不变）。
import {
  SqlSettingsDao,
  SqlNotificationsDao,
  SqlLocalThreadsDao,
  SqlRemoteEventDao,
  SqlRemoteSessionDao,
  SqlRemoteSyncDao,
} from '@/db/dao';
import type { NotificationsDao } from '@/db/dao';
import type { SqlDriver } from '@/db/driver';
import {
  RemoteSyncEngine,
  setRemoteSyncEngine,
} from '@/domain/store/remoteSyncEngine';
import {
  configureSettingsPersistence,
  type SettingsPersist,
} from '@/domain/store/settingsStore';
import {
  configureNotificationsPersistence,
  type NotificationsPersist,
} from '@/domain/store/notificationStore';
import {
  configureLocalChatPersistence,
  configureLocalChatSecure,
} from '@/domain/store/localChatStore';
import { configureScrollAnchorPersistence } from '@/domain/store/scrollAnchorStore';
import { configureComposerDraftPersistence } from '@/domain/store/composerDraftStore';
import { configureSendQueuePersistence } from '@/domain/store/sendQueueStore';
import { configureToolExecutionBreadcrumbPersistence } from '@/domain/store/toolExecutionBreadcrumbs';
import { configureLocalChatSessionPersistence } from '@/domain/store/localChatSessionStore';
import { expoSecureStoreDriver } from '@/db/secureStore';
import type { InAppNotification } from '@/domain/store/notificationReducers';

/** notifications DAO → NotificationsPersist 适配（title 可空归一为展示空串） */
export class DaoNotificationsPersist implements NotificationsPersist {
  constructor(private readonly dao: NotificationsDao) {}

  async upsert(row: InAppNotification): Promise<void> {
    await this.dao.upsert(row);
  }

  async updateStatus(
    id: string,
    status: InAppNotification['status']
  ): Promise<void> {
    await this.dao.updateStatus(id, status);
  }

  async deleteResolvedOlderThan(beforeMs: number): Promise<void> {
    await this.dao.deleteResolvedOlderThan(beforeMs);
  }

  async listByStatus(
    status: InAppNotification['status']
  ): Promise<InAppNotification[]> {
    const rows = await this.dao.listByStatus(status);
    return rows.map((row) => ({ ...row, title: row.title ?? '' }));
  }
}

/**
 * 当前生效的 SqlDriver（供 outbox 等后续装配点复用同一连接）。
 *
 * 单一装配入口：driver 只在 configureSqlitePersistence 处确立，其余模块经
 * getSqlDriver() 读取，不再各自打开数据库。
 */
let currentDriver: SqlDriver | null = null;

/** 读取当前 SqlDriver（DB 降级内存态时为 null） */
export function getSqlDriver(): SqlDriver | null {
  return currentDriver;
}

/**
 * 真实持久化装配：基于 SqlDriver 一次注入 settings + notification 两个 store 的
 * 默认持久化（真实环境 SqlSettingsDao/SqlNotificationsDao；传 null 复位默认注入）。
 */
export function configureSqlitePersistence(driver: SqlDriver | null): void {
  currentDriver = driver;
  configureSettingsPersistence(
    driver === null ? null : (new SqlSettingsDao(driver) as SettingsPersist)
  );
  configureNotificationsPersistence(
    driver === null
      ? null
      : new DaoNotificationsPersist(new SqlNotificationsDao(driver))
  );
  // 本地对话（localChatStore）：非敏感配置共用 SqlSettingsDao（kv 键
  // localchat.config）；API Key 走 SecureStore 驱动——与 SQL 可用性无关，
  // DB 降级时密钥面独立成立。
  configureLocalChatPersistence(
    driver === null ? null : (new SqlSettingsDao(driver) as SettingsPersist)
  );
  configureLocalChatSecure(expoSecureStoreDriver());
  // 本地对话线程历史（CON-4/L2）：SQLite local_threads/local_messages；
  // DB 降级时传 null → 纯内存形态（与配置面降级口径一致）。
  configureLocalChatSessionPersistence(
    driver === null ? null : new SqlLocalThreadsDao(driver)
  );
  // 阅读锚点（批 B ⑱）：与 settings 共用 kv 表（键 chat.scroll_anchor.*，
  // SqlSettingsDao 的 get/set/delete 结构满足 ScrollAnchorPersist）；
  // DB 降级时传 null → 进程内内存形态。
  configureScrollAnchorPersistence(
    driver === null ? null : new SqlSettingsDao(driver)
  );
  // 会话草稿键控 + 生成中发送队列（批 C ②）：同 kv 表共用装配
  // （键 chat.draft.* / chat.send_queue.*，按会话键逐个 get/set，
  // 不经 getAll 全量面）；DB 降级时传 null → 进程内内存形态。
  configureComposerDraftPersistence(
    driver === null ? null : new SqlSettingsDao(driver)
  );
  configureSendQueuePersistence(
    driver === null ? null : new SqlSettingsDao(driver)
  );
  // 工具执行面包屑（波 1 要点 3）：同 kv 表（键
  // tools.execution_breadcrumbs，整环单值落盘）；DB 降级时传
  // null → 仅进程内内存环，跨启动证据降级（与队列口径一致）。
  configureToolExecutionBreadcrumbPersistence(
    driver === null ? null : new SqlSettingsDao(driver)
  );

  // 远程会话持久化与增量同步引擎（v7 架构）
  if (driver === null) {
    setRemoteSyncEngine(null);
  } else {
    setRemoteSyncEngine(
      new RemoteSyncEngine({
        eventDao: new SqlRemoteEventDao(driver),
        sessionDao: new SqlRemoteSessionDao(driver),
        syncDao: new SqlRemoteSyncDao(driver),
      })
    );
  }
}
