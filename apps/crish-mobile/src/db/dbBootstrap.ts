// DB 启动装配（R2-13 部分 2：R-3 未覆盖项——app 层 DB 初始化链的最终调用点）
// - 装配链：openDatabaseAsync（expo-sqlite）→ 连接级 PRAGMA（WAL + 外键）→
//   migrateIfNeeded（v0 → 最新）→ configureSqlitePersistence（settings/notification
//   持久化注入）→ 两个 store hydrate 回填（注入完成后读库，缺省值深合并）；
// - 失败降级（不阻塞 app 启动）：DB 打开/迁移任一失败 → configureSqlitePersistence(null)
//   复位默认注入（设置/通知回退纯内存态）+ store hydrate 置位（默认值可展示）+
//   console.warn 注记「持久化不可用」（诚实化：不静默吞错，也不让启动挂起）；
// - 装配点语义：本函数不参与 SplashGate——app/_layout.tsx 只等 auth hydrate 渲染首屏
//   骨架，DB 装配 fire-and-forget 并行执行；settings/notification 的 hydrated 置位
//   由其 store 内部完成，组件按 hydrated 之前显示默认值即可（与 store 契约一致）；
// - 与配对接线的装配顺序（任务书注记）：DB（expo-sqlite）与配对（expo-secure-store）
//   是两条独立初始化链、无共享依赖——pair/_layout 的 ensurePairingWiringForApp 恢复
//   配对态不需要本装配完成，本装配也不依赖配对结果；并行启动无竞态（互不触达对方
//   存储面，authStore 水合亦不受影响）。
// - 可重入（StrictMode 双挂载 / 热重载安全）：链上各步幂等（migrate 按 user_version
//   跳过、configure 重复注入同构 DAO、hydrate 重复回填同值），无需一次性守卫。
// - 本文件不加入 src/db/index.ts 汇总出口：它依赖领域层 store（向上依赖），只作为
//   app 层启动装配的专属入口被 _layout 直接引用（保持 db 桶纯存储层）。
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { expoSqlDriver, migrateIfNeeded } from './db';
import { configureSqlitePersistence } from '@/domain/store/persistBootstrap';
import { settingsStore } from '@/domain/store/settingsStore';
import { notificationStore } from '@/domain/store/notificationStore';

/** 移动端本地数据库文件名（expo-sqlite 打开名） */
export const MOBILE_DB_NAME = 'crish-mobile.db';

/** 装配选项（测试注入面：open 可替换为 MemorySqlDriver 适配的假 SQLiteDatabase） */
export interface DbBootstrapOptions {
  /** 打开数据库的可注入实现（缺省 expo-sqlite openDatabaseAsync） */
  open?: (name: string) => Promise<SQLiteDatabase>;
}

/** 装配结果（失败携带原因注记，供日志/诊断） */
export interface DbBootstrapResult {
  /** 打开 + 迁移 + 持久化注入全部成功 */
  ok: boolean;
  /** 迁移后版本号（成功 = 最新版本；失败 = 0） */
  version: number;
  /** 失败原因（仅失败时存在；含「持久化不可用」标注） */
  reason?: string;
}

/**
 * DB 启动装配（R2-13 部分 2 最终调用点，app/_layout.tsx 挂载时 fire-and-forget 调用）：
 * openDatabaseAsync → PRAGMA（WAL/外键）→ migrateIfNeeded → configureSqlitePersistence
 * → settings/notification hydrate。任一环节失败不抛错：降级内存态 + 日志注记，
 * 保证 app 启动不被 DB 故障阻塞（首个失败即退出装配，后续环节不再执行）。
 */
export async function ensureDatabaseForApp(
  options?: DbBootstrapOptions
): Promise<DbBootstrapResult> {
  try {
    const open = options?.open ?? openDatabaseAsync;
    const db = await open(MOBILE_DB_NAME);
    // 连接级 PRAGMA 直接走 SQLiteDatabase（db.ts 接线注释形态：不经过 driver）
    await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const driver = expoSqlDriver(db);
    const version = await migrateIfNeeded(driver);
    configureSqlitePersistence(driver);
    await hydrateStores();
    return { ok: true, version };
  } catch (err) {
    // 降级内存态：复位默认持久化注入 → 设置/通知纯内存运行（写入静默不落库）
    configureSqlitePersistence(null);
    // hydrate 无注入仅置位 hydrated（默认值可展示，不阻塞启动）
    await hydrateStores();
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[dbBootstrap] DB 打开/迁移失败，降级内存态（持久化不可用）：${message}`
    );
    return { ok: false, version: 0, reason: message };
  }
}

/** 持久化注入完成后的 store hydrate 回填（两 store 读取失败各自静默置位） */
async function hydrateStores(): Promise<void> {
  await Promise.all([
    settingsStore.getState().hydrate(),
    notificationStore.getState().hydrate(),
  ]);
}
