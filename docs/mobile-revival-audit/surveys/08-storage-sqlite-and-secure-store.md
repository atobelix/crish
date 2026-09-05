# 专项审计报告 08：本地存储与 SQLite 迁移调查 (storage-sqlite-and-secure-store)

> **审计基准**：`apps/crish-mobile`（Expo SDK 57 / RN 0.86 / React 19.2.3）  
> **调查员**：本地存储与 SQLite 迁移调查员  
> **产出时间**：2026-09-04  
> **审计范围**：
> - `apps/crish-mobile/src/db/` (`db.ts`, `dbBootstrap.ts`, `schema.ts`, `migrations.ts`, `secureStore.ts`, `driver.ts`, `cachePolicy.ts`, `dao/*`)
> - `apps/crish-mobile/src/domain/store/persistBootstrap.ts`
> - `apps/crish-mobile/src/domain/store/settingsStore.ts`, `notificationStore.ts`, `authStore.ts`
> - `apps/crish-mobile/src/adapters/wiring/pairing/` (`PairingWiring.ts`, `pairingPersistence.ts`, `pairingAssembly.ts`)
> - `apps/crish-mobile/src/presentation/pair/pairingBootstrap.ts`
> - `apps/crish-mobile/app/_layout.tsx`, `app/pair/_layout.tsx`, `app/(tabs)/_layout.tsx`

---

## 模块架构全景

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                应用入口层 (app)                                  │
│  app/_layout.tsx: authStore.hydrate() [空参未接线!] ⚠️                           │
│                   ensureDatabaseForApp() [fire-and-forget]                      │
│  app/pair/_layout.tsx: ensurePairingWiringForApp() -> 读 SecureStore -> 回弹Tabs │
└───────────────────────┬─────────────────────────────────┬───────────────────────┘
                        │                                 │
           ┌────────────┴───────────┐        ┌────────────┴───────────┐
           ▼                        ▼        ▼                        ▼
┌──────────────────────┐ ┌──────────────────────┐ ┌───────────────────────────────┐
│    expo-sqlite       │ │  expo-secure-store   │ │        Zustand Stores         │
│  crish-mobile.db     │ │ Keychain / Keystore  │ │ - settingsStore (双向接线)    │
│  - WAL 模式          │ │ - 4 核心密钥位       │ │ - notificationStore (单向读) ⚠️│
│  - PRAGMA foreign_key│ │ - 2 辅助凭证位       │ │ - authStore (内存代理)        │
│  - schema v1 (8 表)  │ │ - 3 越权元数据键 ⚠️   │ │ - event/approval/session... │
└──────────┬───────────┘ └──────────┬───────────┘ │   (全内存，未落库) ⚠️          │
           │                        │             └───────────────┬───────────────┘
           ▼                        ▼                             ▼
┌──────────────────────┐ ┌──────────────────────┐ ┌───────────────────────────────┐
│   expoSqlDriver      │ │ expoSecureStoreDriver│ │      persistBootstrap.ts      │
│  - execAsync (无参)  │ │ - getItemAsync       │ │ - configureSqlitePersistence  │
│  - prepareAsync (带参)│ │ - setItemAsync       │ │ - SqlSettingsDao -> 设置表    │
│  - withTransaction   │ │ - deleteItemAsync    │ │ - DaoNotificationsPersist     │
└──────────┬───────────┘ └──────────┬───────────┘ └───────────────┬───────────────┘
           │                        │                             │
           ▼                        ▼                             ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      存储与状态割裂现状 (8 表实存率分析)                           │
│  [settings]           -> 真实读写回填（活跃）                                     │
│  [notifications]      -> 仅启动冷读（空读），运行期从未落库写入（半死层） ⚠️          │
│  [device_info]        -> DAO 完整，但被 SecureStore pairing.meta.* 越权架空（死层）⚠️ │
│  [events]             -> DAO 完整，未与 eventStore 接线（死层）⚠️                 │
│  [approval_queue]     -> DAO 完整，未与 outbox 接线（死层）⚠️                     │
│  [approval_history]   -> DAO 完整，未与 approvalStore 接线（死层）⚠️              │
│  [session_summaries]  -> DAO 完整，未与 sessionStore 接线（死层）⚠️               │
│  [push_tokens]        -> DAO 完整，未与 推送注册接线（死层）⚠️                     │
│  [cachePolicy.ts]     -> 280 行双上限清理算法，无任何运行时调用点（死层） ⚠️         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 一、【SQLite 迁移机制严密性】

### 1. 数据库打开与连接级 PRAGMA 配置

- **代码位置**：[`apps/crish-mobile/src/db/dbBootstrap.ts:53-62`](file:///c:/Software/conex/apps/crish-mobile/src/db/dbBootstrap.ts#L53-L62)
- **实现细节**：
  ```typescript
  const open = options?.open ?? openDatabaseAsync;
  const db = await open(MOBILE_DB_NAME); // 'crish-mobile.db'
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const driver = expoSqlDriver(db);
  const version = await migrateIfNeeded(driver);
  ```
- **机制审查与严密性评价**：
  1. **WAL (Write-Ahead Logging) 模式与并发性能**：
     通过直接在原生连接上执行 `PRAGMA journal_mode = WAL;`，为 SQLite 启用了并发读写能力（读写互不阻塞，读操作不持有排他锁）。移动端应用常有前台 UI 渲染（读）与后台数据流同步（写）交替，WAL 模式是防止数据库锁竞争（`SQLITE_BUSY`）的核心保障。
  2. **外键约束强制开启**：
     SQLite 默认关闭外键约束检查，显式注入 `PRAGMA foreign_keys = ON;` 保证了表级外键完整性（尽管 schema v1 目前均采用扁平主键设计，为后续表间级联删除奠定基线）。
  3. **驱动封装层对 SDK 57 的适配严密性**：
     代码在 [`apps/crish-mobile/src/db/db.ts:54-82`](file:///c:/Software/conex/apps/crish-mobile/src/db/db.ts#L54-L82) 针对 Expo SDK 57 (`expo-sqlite ~57.0.1`) 做了精细的参数分支：
     - **无参数语句**：直接执行 `db.execAsync(sql)`，用于执行多语句批量 DDL（如建表脚本）。
     - **带参数语句**：通过 `await db.prepareAsync(sql)` 创建预编译语句对象，在 `try...finally` 块中执行 `statement.executeAsync(params)` 并无条件触发 `statement.finalizeAsync()`，彻底杜绝了原生游标与语句句柄泄漏。
     - **事务映射**：`db.withTransactionAsync` 原生事务透传，异常自动回滚。

### 2. 版本迁移状态机 (`migrateIfNeeded`) 严密性

- **代码位置**：[`apps/crish-mobile/src/db/db.ts:17-35`](file:///c:/Software/conex/apps/crish-mobile/src/db/db.ts#L17-L35) 与 [`migrations.ts:20-35`](file:///c:/Software/conex/apps/crish-mobile/src/db/migrations.ts#L20-L35)
- **迁移算法核心**：
  ```typescript
  export async function migrateIfNeeded(
    db: SqlDriver,
    migrations: readonly Migration[] = MIGRATIONS
  ): Promise<number> {
    const row = await db.getFirst<{ user_version: number }>('PRAGMA user_version');
    const current = row?.user_version ?? 0;
    for (let v = current; v < migrations.length; v++) {
      const migration = migrations[v]!;
      await db.withTransaction(async () => {
        for (const sql of migration.sql) {
          await db.exec(sql);
        }
        await db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
    return Math.max(current, migrations.length);
  }
  ```
- **严密性优势**：
  - **逐级独立事务**：循环遍历 `for (let v = current; v < migrations.length; v++)`，每个迁移版本包裹在独立的 `withTransaction` 内。若第 $k$ 级迁移失败，事务回滚，`PRAGMA user_version` 停留在 $k-1$，已完成的前序迁移安全保留，下一次启动可断点重试。
  - **幂等性与零损耗跳过**：已升级到最新版本的数据库，`current === migrations.length`，循环不执行，直接返回版本号，无建表消耗，无业务数据改写。
  - **静态断言护栏**：[`migrations.ts:31-35`](file:///c:/Software/conex/apps/crish-mobile/src/db/migrations.ts#L31-L35) 配置模块级断言：
    ```typescript
    if (LATEST_VERSION !== SCHEMA_VERSION) {
      throw new Error(`迁移版本与 schema 版本不一致：MIGRATIONS=${LATEST_VERSION} SCHEMA_VERSION=${SCHEMA_VERSION}`);
    }
    ```
    强制开发人员修改 `SCHEMA_VERSION` 时必须同步在 `MIGRATIONS` 数组追加迁移单元，杜绝了 schema 漂移。

### 3. 潜在隐患与边缘缺陷

- **隐患 1：版本降级未设防**
  若用户从较新的测试版本（`user_version = 2`）覆盖安装旧版正式包（代码仅支持 `v1`），`current = 2 > migrations.length (1)`。当前逻辑直接跳过循环并返回 `Math.max(2, 1) = 2`。虽然不会崩，但如果未来旧代码对已演进的表结构执行不兼容查询，可能发生运行时不可预期的 SQL 异常。建议对 `current > migrations.length` 进行日志警告或告警留痕。
- **隐患 2：`MemorySqlDriver` 与真实 SQLite 事务语义漂移**
  在 [`apps/crish-mobile/src/db/driver.ts:79-88`](file:///c:/Software/conex/apps/crish-mobile/src/db/driver.ts#L79-L88) 中，用于单元测试的 `MemorySqlDriver` 的 `withTransaction` 仅维护了 `txnDepth` 深度计数，**没有实现真正的数据快照回滚**。单测中 [`migrations.test.ts:90-111`](file:///c:/Software/conex/apps/crish-mobile/src/db/migrations.test.ts#L90-L111) 能断言通过是因为 `PRAGMA user_version` 是最后一步写入；如果中间 SQL 报错，测试驱动的内存状态并未回滚前面已写入的内存表结构。这属于测试驱动与原生驱动之间的语义偏差。

---

## 二、【启动降级保护有效性】

### 1. `ensureDatabaseForApp` 降级闭环分析

- **代码位置**：[`apps/crish-mobile/src/db/dbBootstrap.ts:50-74`](file:///c:/Software/conex/apps/crish-mobile/src/db/dbBootstrap.ts#L50-L74)
- **降级机制设计**：
  ```typescript
  export async function ensureDatabaseForApp(
    options?: DbBootstrapOptions
  ): Promise<DbBootstrapResult> {
    try {
      const open = options?.open ?? openDatabaseAsync;
      const db = await open(MOBILE_DB_NAME);
      await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      const driver = expoSqlDriver(db);
      const version = await migrateIfNeeded(driver);
      configureSqlitePersistence(driver);
      await hydrateStores();
      return { ok: true, version };
    } catch (err) {
      // 降级内存态：复位默认持久化注入 -> 设置/通知纯内存运行（写入静默不落库）
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
  ```
- **有效性评价**：
  1. **零崩溃启动防护**：整个数据库初始化流程被完整的 `try...catch` 兜底。无论底层遇到移动端沙盒文件权限被拒、磁盘空间耗尽、SQLite 库文件损坏、或是迁移脚本执行错误，**绝不向外抛出未处理异常**。
  2. **状态解耦与置位**：在 catch 分支中显式调用 `configureSqlitePersistence(null)`，切断 `settingsStore` 与 `notificationStore` 的持久化写入通道；随后调用 `hydrateStores()`，触发两 store 的 `hydrated = true`，使 UI 渲染层（如设置页、通知中心）顺利离开 loading 骨架态，展示内存默认值。
  3. **启动路径不阻塞**：[`app/_layout.tsx:30-32`](file:///c:/Software/conex/apps/crish-mobile/app/_layout.tsx#L30-L32) 以 `useEffect(() => { void ensureDatabaseForApp(); }, [])` 无阻塞发起，不阻断 `SplashGate`。

### 2. 降级保护的严重盲区与隐患

- **致命盲区 1：数据库损坏永久卡死在内存态，无自愈恢复策略**
  - **现场分析**：如果因断电或系统故障导致 `crish-mobile.db` 出现 `SQLITE_CORRUPT`，每次启动 `openDatabaseAsync` 或 `migrateIfNeeded` 都会抛错。
  - **后果**：当前代码仅打出 `console.warn`，用户端静默降级到内存态；应用关闭后用户更改的任何设置丢失；下一次启动再次静默降级。用户将**永久处于数据无法持久化的异常状态**，除非卸载重装！
  - **建议防御**：在重试/捕获已知损坏错误时，应支持或提供自愈重置选项（例如利用 `deleteDatabaseAsync(MOBILE_DB_NAME)` 清理坏库重建）。
- **时序缺陷 2：启动并发与状态覆盖竞态 (Race Condition)**
  - `ensureDatabaseForApp` 为 fire-and-forget 异步任务。如果用户在进入 App 后的微秒级别（或在自动化测试中）触发了设置修改（如切换主题），由于此时 `configureSqlitePersistence` 尚未完成，写入被丢弃；紧接着 `ensureDatabaseForApp` 的 `hydrateStores()` 晚一步完成并读取数据库，将用户刚改的内存状态强行覆盖为库中的历史旧值。

---

## 三、【SecureStore 安全性】

### 1. 密钥分级与存储边界划分

- **代码位置**：[`apps/crish-mobile/src/db/secureStore.ts:8-44`](file:///c:/Software/conex/apps/crish-mobile/src/db/secureStore.ts#L8-L44)
- **密钥槽位划分**：
  | 槽位分类 | 键名常量 | 存储介质 | 泄露风险与防护哲学 |
  | :--- | :--- | :--- | :--- |
  | **核心密钥位** | `pair.token_key` | SecureStore | 会话令牌 HMAC 密钥；泄露等于会话失守 |
  | **核心密钥位** | `pair.refresh_key` | SecureStore | 重连令牌签名密钥；泄露等于可冒名刷新 |
  | **核心密钥位** | `device.keypair.priv` | SecureStore | 设备长期 X25519 私钥；泄露等于设备身份失守 |
  | **核心密钥位** | `device.keypair.pub` | SecureStore | 设备长期 X25519 公钥；与私钥成对校验 |
  | **凭证位** | `pair.host_fingerprint` | SecureStore | 桌面自签证书 SHA-256 指纹（证书固定用） |
  | **中间态位** | `pair.exchange_nonce` | SecureStore | 配对握手期一次性凭据；配对成功或失败即销毁 |
- **单值体积与物理约束**：
  iOS Keychain 对单个 GenericPassword 存储有最佳实践限制（建议 $< 2\text{KB}$）。本设计中，密钥均采用 32 字节 Base64 编码（约 44 字符），指纹为 64 字符十六进制，远低于系统上限，物理安全性良好。

### 2. “全有或全无”校验与防部分恢复

- **代码位置**：[`apps/crish-mobile/src/db/secureStore.ts:124-147`](file:///c:/Software/conex/apps/crish-mobile/src/db/secureStore.ts#L124-L147)
- **关键逻辑**：
  ```typescript
  export async function loadPairingCredential(
    driver: SecureStoreDriver
  ): Promise<PairingCredential | null> {
    const values = await Promise.all(
      CORE_KEY_SLOTS.map((key) => driver.getItem(key))
    );
    const [tokenKey, refreshKey, deviceKeypairPriv, deviceKeypairPub] = values;
    if (
      tokenKey == null ||
      refreshKey == null ||
      deviceKeypairPriv == null ||
      deviceKeypairPub == null
    ) {
      return null;
    }
    const hostFingerprint = await driver.getItem(KEYS.HOST_FINGERPRINT);
    return { tokenKey, refreshKey, deviceKeypairPriv, deviceKeypairPub, ...(hostFingerprint !== null ? { hostFingerprint } : {}) };
  }
  ```
- **安全性评估**：
  严密遵循“不部分恢复”（M5 §6.3 注意 4）。只要 4 个核心密钥槽位中任意一个丢失或损坏，一律返回 `null`，判定为未配对状态，强行阻断持有单边私钥或残缺 Token 发起非法伪造请求。

### 3. SecureStore 严重漏洞与异常处理缺失

- **重大安全隐患 1：Android 自动备份导致 Keystore 密钥失效崩溃**
  - **标准规范**：在 `secureStore.ts:190` 注释中明确注明了 `Android 需确认 allowBackup=false`。
  - **实际排查**：在 [`apps/crish-mobile/app.json`](file:///c:/Software/conex/apps/crish-mobile/app.json#L13-L21) 中，`android` 配置项下**完全缺失 `allowBackup: false` 配置**！
  - **攻击/故障场景**：在 Android 设备上，系统默认开启云端备份。当用户换机或重装通过 Google Backup 恢复数据时，SharedPreferences 中的加密密文会被恢复，但硬件 Keystore 中的解密主密钥无法跨机迁移。应用启动读取 SecureStore 时将直接抛出底层原生异常（如 `AEADBadTagException` / `DecryptionException`），导致启动雪崩。
- **异常泄露隐患 2：未捕获的 Promise Rejection**
  - **排查路径**：
    1. [`apps/crish-mobile/src/adapters/wiring/pairing/PairingWiring.ts:246-277`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/pairing/PairingWiring.ts#L246-L277) 中 `doHydrate()` 没有包裹 `try...catch`。
    2. [`apps/crish-mobile/src/adapters/wiring/pairing/pairingAssembly.ts:18-24`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/pairing/pairingAssembly.ts#L18-L24)：
       ```typescript
       export function ensurePairingWiring(opts: PairingWiringOptions): PairingWiring {
         if (singleton) return singleton;
         singleton = startPairingWiring(opts);
         singleton.configure();
         void singleton.hydrate(); // ⚠️ 此处无 catch 保护！
         return singleton;
       }
       ```
    3. 若 SecureStore 底层由于 Keychain 锁死或权限问题抛错，`void singleton.hydrate()` 将在 React Native 运行时产生 **Unhandled Promise Rejection**。
- **孤儿元数据隐患 3：`clearPairing` 遗留元数据**
  - [`secureStore.ts:153-155`](file:///c:/Software/conex/apps/crish-mobile/src/db/secureStore.ts#L153-L155) 的 `clearPairing` 仅清理 `ALL_KEY_SLOTS`。
  - 而 `pairingPersistence.ts` 定义的三个元数据键：
    - `pairing.meta.device_id`
    - `pairing.meta.desktop_id`
    - `pairing.meta.host`
    如果通过非 `PairingWiring.unpair()` 的途径触发凭据清空，这三个键将永久残留于 SecureStore 中，成为不可回收的孤儿垃圾数据。

---

## 四、【重复与死层】

本章节对全量存储资产进行深度穿透审计，发现当前仓库存在极为严重的**概念重复、设计冗余与代码死层**。

### 1. SQLite 8 表体系的“空心化”实存审计表

在 `schema.ts` 中定义了 8 张业务表，并为每张表编写了完整的 DAO 实现与单元测试，但实际接线情况如下：

| 表名 | 声明定位 (M5 §5.2) | DAO 实现类 | 运行时写入点 | 运行时读取点 | 实际运行状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`settings`** | 本地键值/用户偏好 | `SqlSettingsDao` | `settingsStore.set/update` | `settingsStore.hydrate` | 🟢 **全通活跃**（唯一完全落地的表） |
| **`notifications`** | 应用内通知与角标 | `SqlNotificationsDao` | **无任何写入调用** ⚠️ | `notificationStore.hydrate` | 🟡 **半死层单向线**（启动读空，从不写入） |
| **`device_info`** | 配对元数据非敏感部分 | `SqlDeviceInfoDao` | **无调用** ⚠️ | **无调用** ⚠️ | 🔴 **完全死层 / 概念被 SecureStore 顶替** |
| **`events`** | 引擎事件流本地镜像 | `SqlEventsDao` | **无调用** ⚠️ | **无调用** ⚠️ | 🔴 **完全死层**（`eventStore` 全内存态） |
| **`approval_queue`** | Outbox 待发队列 | `SqlApprovalQueueDao` | **无调用** ⚠️ | **无调用** ⚠️ | 🔴 **完全死层**（队列仅在内存流转） |
| **`approval_history`** | 审批已决历史 | `SqlApprovalHistoryDao` | **无调用** ⚠️ | **无调用** ⚠️ | 🔴 **完全死层**（`approvalStore` 全内存态） |
| **`session_summaries`**| 会话列表与摘要 | `SqlSessionSummariesDao`| **无调用** ⚠️ | **无调用** ⚠️ | 🔴 **完全死层**（`sessionStore` 全内存态） |
| **`push_tokens`** | 移动端设备 Token 上报 | `SqlPushTokensDao` | **无调用** ⚠️ | **无调用** ⚠️ | 🔴 **完全死层** |

### 2. 典型重复与架构错位剖析

#### 错位 A：`device_info` 表与 SecureStore `pairing.meta.*` 的双重概念冲突

- **架构设计原型（M5 §5.2 / D4 §7.4）**：
  明确规定：敏感密钥（私钥、HMAC Token）进 SecureStore；非敏感设备元数据（`deviceId`, `desktopId`, `deviceName`, `hostUrl`, `certFingerprintTail`）存入 SQLite 的 `device_info` 表。
- **现实代码漂移**：
  [`src/adapters/wiring/pairing/pairingPersistence.ts:13-19`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/pairing/pairingPersistence.ts#L13-L19) 直接将本该存入 SQLite 的元数据在 SecureStore 中另起炉灶：
  ```typescript
  export const PAIRING_META_DEVICE_ID_KEY = 'pairing.meta.device_id';
  export const PAIRING_META_DESKTOP_ID_KEY = 'pairing.meta.desktop_id';
  export const PAIRING_META_HOST_KEY = 'pairing.meta.host';
  ```
  在 `PairingWiring.ts` 中直接通过 `driver.setItem` 读写 SecureStore。
- **后果**：
  精心编写的 `device_info` 表及其 `SqlDeviceInfoDao` 沦为 100% 死代码；SecureStore 被滥用为普通键值存储。

#### 错位 B：`notificationStore` 虚假持久化与角标重启重置

- **代码断层现状**：
  1. [`apps/crish-mobile/src/domain/store/persistBootstrap.ts:56-65`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/persistBootstrap.ts#L56-L65) 将 `SqlNotificationsDao` 包装为 `DaoNotificationsPersist` 注入给 `notificationStore`。
  2. [`apps/crish-mobile/src/domain/store/notificationStore.ts:123-146`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/notificationStore.ts#L123-L146) 中，`ingest`、`markRead`、`markAllRead`、`clearResolved` 的方法实现**仅仅调用了内存 reducer，完全没有调用 `persist`**！
  3. 全局搜索 `SqlNotificationsDao.upsert` 和 `updateStatus`，除了单测文件外，**业务运行期没有任何地方调用写表操作**！
- **后果**：
  - SQLite `notifications` 表永远是一张空表。
  - 所谓的 `hydrate()` 每次启动只是读了一次空表。
  - 用户在前台收到的所有通知与“已读”标记，在应用被杀进程重启后**彻底清空或未读角标无法断点恢复**，设计中的“7 天持久化清理”沦为空谈。

#### 错位 C：`cachePolicy.ts` 280 行死代码

- **代码位置**：[`apps/crish-mobile/src/db/cachePolicy.ts`](file:///c:/Software/conex/apps/crish-mobile/src/db/cachePolicy.ts)
- **代码分析**：
  包含 `computeEventsCleanup`、`buildTimeWindowCleanup`、`runCleanup` 等多套高阶清理纯函数与执行器，支持双上限 LRU 淘汰与时间窗口计算。
- **排查结果**：
  全局搜索 `runCleanup`，发现**除 `cachePolicy.test.ts` 之外没有任何运行时入口**。没有接进定时器，没有接进 App 退火/启动，也没有后台任务。由于被清理的表（`events`, `approval_*`, `session_*`）本来就没有任何数据写入，整个 `cachePolicy.ts` 是一座完全脱节的孤岛。

#### 错位 D：`app/_layout.tsx` 启动时序断裂导致的“路由跳跃回弹 Bug”

- **触发链条剖析**：
  1. [`app/_layout.tsx:23-25`](file:///c:/Software/conex/apps/crish-mobile/app/_layout.tsx#L23-L25)：
     ```typescript
     useEffect(() => {
       void authStore.getState().hydrate();
     }, []);
     ```
     在根布局挂载时，直接无参调用 `authStore.hydrate()`。
  2. 但此时应用刚启动，[`pairingBootstrap.ts`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/pair/pairingBootstrap.ts) 尚未执行，`configureAuthPersistence` **未被注入**，`defaultPersist === null`！
  3. `authStore.hydrate()` 发现无 persist，直接将状态置为 `hydrated = true`，但 `pairState` 保留为默认的 `'unpaired'`！
  4. 根布局 SplashGate 判定 `hydrated === true`，放行渲染导航树。
  5. 导航树加载默认路由 `(tabs)/_layout.tsx`。
  6. [`app/(tabs)/_layout.tsx:13-15`](file:///c:/Software/conex/apps/crish-mobile/app/%28tabs%29/_layout.tsx#L13-L15) 守卫判定：
     ```typescript
     if (pairState !== 'paired') {
       return <Redirect href="/pair/welcome" />;
     }
     ```
     由于 `pairState === 'unpaired'`，**(tabs) 立即将用户重定向到 `/pair/welcome`**！
  7. 路由进入 `app/pair/_layout.tsx`，该布局的 `useEffect` 调用了 [`ensurePairingWiringForApp()`](file:///c:/Software/conex/apps/crish-mobile/app/pair/_layout.tsx#L19)。
  8. `ensurePairingWiringForApp` 终于初始化了 `PairingWiring`，并调用 `singleton.configure()` 注入了 SecureStore 驱动，随后读取真实凭据，发现设备**早已配对**！
  9. `authStore` 的 `pairState` 被异步更新为 `'paired'`。
  10. `app/pair/_layout.tsx:39-41` 检测到 `pairState === 'paired'`，再次触发重定向：
      ```typescript
      if (pairState === 'paired') {
        return <Redirect href="/(tabs)" />;
      }
      ```
- **Bug 实质**：
  由于存储接线初始化与水合时序倒置，**已配对用户在每次冷启动时，都会从 Tabs 被踢到 Pair 页面，再从 Pair 页面被弹回 Tabs**！造成肉眼可见的闪烁、双重重定向与网络请求混乱。

---

## 五、问题清单与整改收敛建议

### 1. 核心问题汇总表

| 序号 | 问题性质 | 缺陷描述 | 关联模块 | 风险等级 |
| :--- | :--- | :--- | :--- | :--- |
| **ISS-08-01** | 架构时序缺陷 | 根布局水合在持久化注入前触发，导致冷启动路由跳跃回弹 | `app/_layout.tsx`<br/>`pairingBootstrap.ts` | 🔴 **严重** (阻断体验) |
| **ISS-08-02** | 平台安全漏洞 | Android 配置缺少 `allowBackup: false`，备份恢复会导致 Keystore 崩溃 | `app.json`<br/>`secureStore.ts` | 🔴 **严重** (崩溃风险) |
| **ISS-08-03** | 异步未捕获异常 | `ensurePairingWiring` 内部 `void singleton.hydrate()` 缺失 catch | `pairingAssembly.ts` | 🟠 **高** (运行时告警) |
| **ISS-08-04** | 虚假持久化 | `notificationStore` 写入操作未接线 DAO，通知已读状态重启丢失 | `notificationStore.ts`<br/>`persistBootstrap.ts` | 🟠 **高** (功能缺失) |
| **ISS-08-05** | 概念冗余与死层 | `device_info` 表被废弃，非敏感元数据散落在 SecureStore 中 | `schema.ts`<br/>`pairingPersistence.ts` | 🟡 **中** (架构不洁) |
| **ISS-08-06** | 大量未接线死代码 | 8 表中 5 表及 `cachePolicy.ts`（280行）完全无业务调用 | `src/db/dao/*`<br/>`cachePolicy.ts` | 🟡 **中** (死代码沉淀) |
| **ISS-08-07** | 容灾自愈缺失 | SQLite 损坏时仅降级内存态，无坏库自愈/重置手段，永久无法保存 | `dbBootstrap.ts` | 🟡 **中** (边界异常) |

### 2. 整改与收敛建议 (Phase 2 / Phase 3 输入)

1. **修正根布局水合生命周期（消除路由跳跃）**：
   将 `ensurePairingController()` 或 `ensurePairingWiringForApp()` 提前至 `app/_layout.tsx` 的 SplashGate 等待队列中，确保在放行导航树之前完成 SecureStore 读取。未配对直进 `/pair`，已配对直进 `(tabs)`，根绝弹跳。
2. **修补 Android 备份配置**：
   在 `apps/crish-mobile/app.json` 中配置 `android.allowBackup = false`，避免 Android 自动云备份恢复后 Keystore 解密抛错。
3. **修复 `notificationStore` 持久化闭环**：
   在 `notificationStore.ts` 的 `ingest`、`markRead`、`markAllRead`、`clearResolved` 中补齐对 `persist` 接口的异步调用，使通知与已读状态真正落入 SQLite `notifications` 表。
4. **清理或按需激活死层 DAO**：
   - 评估 `events`, `approval_*`, `session_*` 表在移动端的定位。若当前移动端策略采用纯内存订阅模式（以桌面端为唯一真理源），应在文档中明确标记这些 DAO 为保留扩展位，或对其进行裁剪瘦身。
   - 将 `pairing.meta.*` 统一收敛至 SQLite `device_info` 表，让 SecureStore 回归其纯粹的“敏感私钥存储”定位。
5. **增加 SQLite 损坏自愈机制**：
   在 `ensureDatabaseForApp` 中识别 `SQLITE_CORRUPT` 或特定文件异常，增加坏库重置选项（删除旧文件重建），保障应用自愈能力。
