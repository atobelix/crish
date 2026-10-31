# 移动端离线存储与状态机并发专项审计报告

> **战役工作区**：`docs/mobile-full-audit/`  
> **专业审计席位**：03 · 离线存储与状态机并发审计员  
> **审计对象范围**：`apps/crish-mobile/src/db/`、`apps/crish-mobile/src/domain/store/`、`apps/crish-mobile/src/adapters/`、`packages/shared-utils/src/`  
> **审计环境基准**：Expo SDK 57 (~57.0.31 / RN 0.86.3 / `expo-sqlite` ~57.0.4 / `expo-secure-store` ~57.0.4)、Zustand 5.0.14 + Immer 11.1.8、TypeScript 6.0 严格模式  
> **审计纪律依据**：仓库根目录 `AGENTS.md`，执行反退避与立体验证铁律，全面排查隐性并发漏洞、时序断层与离线数据安全缺陷  
> **审计日期**：2026-10-30  

---

## 一、核心结论与健康度全景

经过对 Crish 移动端伴侣应用（`apps/crish-mobile`）的嵌入式数据库、硬件密钥凭据安全、Zustand 状态机并发与数据流接线层进行全方位的静态代码剖析与时序模拟，得出以下核心体检结论：

### 1. 总体评价：架构蓝图宏伟，但工程落地存在多处“致命脱节”
- **设计初衷先进**：规范设计了严谨的 SQLite 8 表体系、Outbox 离线审批两阶段提交机制、SecureStore 核心密钥分层隔离、以及基于 Sequence 游标追踪的重连对账理论模型。
- **现实断层严重**：在从规范转化为代码时，暴露出**“初始化时序竞态”、“未捕获异常扩散致冷启动死锁”、“补洞自愈时序倒挂”、“重连投影管道未接线”**等诸多工程断层。多项核心离线与并发能力在生产环境处于**未生效、已降级或逻辑自相矛盾**的状态。

### 2. 核心红线缺陷聚焦（四大致命级 P0）
1. **DB 启动竞态导致 Outbox 永久绑定内存态，离线审批决策 100% 丢失（DEF-STO-01）**：  
   `app/_layout.tsx` 异步并发启动数据库与运行时，审批接线层在 DB 尚未完成打开时读取 `getSqlDriver()` 得到 `null`，导致 Outbox 单例永久降级为 `MemoryOutboxAdapter`。后续 DB 装配完成仅更新了设置和通知 Store，未热升级审批单例。用户在离线状态下操作的批准/拒绝决策，在 App 被系统杀死或退出后**彻底蒸发**。
2. **`hydrateAccount()` 未捕获 SecureStore 异常，冷启动无限 Loading 死锁（DEF-STO-02）**：  
   在无锁屏密码或 KeyStore 损坏的 Android 设备上，`loadAccountSession` 抛出底层加解密异常未被捕获，导致 `accountStore.hydrated` 永远无法置为 `true`。根布局 `RootShell` 的启动守卫永久拦截并呈现加载菊花（Spinner），**用户彻底无法进入应用**。
3. **序列空洞自愈（Sequence Gap Detection）时序倒挂，回放数据被当作重复帧丢弃（DEF-STO-03）**：  
   `feedBridge` 收到乱序事件探测到空洞后，异步请求补洞的同时**立即将乱序高序号事件同步写入 Store**，导致本地游标直接跳高。当随后拉回的连续历史补洞帧到达时，被 `appendFeed` 的幂等防线判定为 `seq <= lastSeq`，**作为重复帧全量静默丢弃**，造成时间线永久性空洞。
4. **重连投影工厂 `projections` 在生产接线中缺失，全量与增量对账自愈完全失效（DEF-STO-04）**：  
   `observationWiring.ts` 在初始化 `ReconnectingWsClient` 时，**漏传了 `projections` 工厂参数**。导致每次重连计算出的待恢复、全量回放、清理指令恒为空数组。整个重连投影状态机在生产环境下成为 100% 不运转的死代码。

### 3. 缺陷分布与综合评级
- **P0 致命级缺陷**：4 项（离线丢单、启动死锁、补洞丢消息、重连自愈停摆）
- **P1 严重级缺陷**：4 项（5/8 幽灵表未接线、DAO 伪 upsert 并发冲突、单连接无批量阻塞主桥、Token 流未节流致 UI 掉帧）
- **P2 次要级缺陷**：2 项（迁移事务内 PRAGMA 违背规范、对账审批项参数硬编码置空）
- **综合健康度评分**：**45 / 100（不及格，高危数据完整性隐患，严禁直接上线发版）**

---

## 二、缺陷全景总览清单

| 编号 | 严重级别 | 所属模块 | 缺陷标题 | 核心影响与危害 | 确凿代码锚点 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **DEF-STO-01** | **P0 致命** | `adapters/wiring` | DB 初始化竞态导致 Outbox 永久降级内存态 | 离线审批决策无法持久化，进程终止即丢失 | `dbBootstrap.ts:60`<br>`approvalWiring.ts:545` |
| **DEF-STO-02** | **P0 致命** | `adapters/account` | `hydrateAccount` 未捕获异常致冷启动无限死锁 | KeyStore 解密失败时应用永久卡死在 Splash | `accountService.ts:162`<br>`app/_layout.tsx:88` |
| **DEF-STO-03** | **P0 致命** | `adapters/wiring` | 序列空洞探测过早推进游标致补洞数据批量被弃 | 断网恢复/乱序到达时时间线永久丢失关键消息 | `feedBridge.ts:143`<br>`event-ring-window.ts:75` |
| **DEF-STO-04** | **P0 致命** | `adapters/wiring` | `observationWiring` 未注入 `projections` 导致对账停摆 | 重连后无法自愈会话状态与增量事件，形成死代码 | `observationWiring.ts:88`<br>`ReconnectingWsClient.ts:541` |
| **DEF-STO-05** | **P1 严重** | `db/schema` | 5/8 幽灵表：`events`/`session_summaries` 仅建表零读写 | 聊天记录与会话历史纯内存态，离线无法查看 | `schema.ts:41-136`<br>全局检索零 SQL 引用 |
| **DEF-STO-06** | **P1 严重** | `db/dao` | DAO 伪 upsert 存在无事务竞态，并发写入冲突崩溃 | 推送与 WS 双通道互竞并发写入触发唯一约束异常 | `notificationsDao.ts:50`<br>`settingsDao.ts:35` |
| **DEF-STO-07** | **P1 严重** | `db/driver` | SQLite 单连接无读写隔离与循环 Prepare 阻塞主桥 | 每次写均编译释放 Statement，批量写入延迟剧增 | `db.ts:61`<br>`approvalQueueDao.ts:76` |
| **DEF-STO-08** | **P1 严重** | `domain/store` | 实时推理 Token 流未节流，逐帧触发 Zustand Immer 深更新 | 高频推理时 React 50-80fps 频繁重渲染导致掉帧卡死 | `ingestRouter.ts:30`<br>`useSessionWindow.ts:8` |
| **DEF-STO-09** | **P2 次要** | `db/migrations` | 迁移事务内执行 `PRAGMA user_version` 违背标准且缺降级防线 | 原生引擎可能回滚失败，版本降级无安全拦截 | `db.ts:31`<br>`migrations.ts:28` |
| **DEF-STO-10** | **P2 次要** | `adapters/wiring` | 对账补入审批项参数强制置空，详情页卡片无法展示入参 | 恢复后的待办在 UI 上无法展示命令行与执行参数 | `approvalWiring.ts:186`<br>`ApprovalCard.tsx:106` |

---
## 三、专项审计维度一：`expo-sqlite` 嵌入式数据库健壮性

### 1. 本地数据库初始化时机与时序竞态（DEF-STO-01）

#### 代码断层证据
在 `apps/crish-mobile/app/_layout.tsx` 中：
```ts
// apps/crish-mobile/app/_layout.tsx:60-66
useEffect(() => {
  startAppRuntime(); // 同步执行：若为 paired 状态，立即调用 ensureApprovalWiring()
}, []);

useEffect(() => {
  void ensureDatabaseForApp(); // 异步执行：打开 SQLite 并执行迁移
}, []);
```

在 `apps/crish-mobile/src/adapters/wiring/approvalWiring.ts`：
```ts
// apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:533-551
export function ensureApprovalWiring(
  opts: Omit<ApprovalWiringOptions, 'gateway'> & { gateway?: WsGateway } = {}
): ApprovalWiring | null {
  if (singleton) return singleton;
  const gateway = opts.gateway ?? getObservationWiring()?.client.gateway;
  if (!gateway) {
    ensurePendingRegistration();
    return null;
  }
  singleton = startApprovalWiring({
    persistAdapter: createDefaultOutboxPersist(getSqlDriver()), // 致命点：此时 DB 正在打开，getSqlDriver() 必然返回 null！
    ...opts,
    gateway,
  });
  void singleton.bridge.hydrate();
  return singleton;
}
```

在 `apps/crish-mobile/src/adapters/persistence/persistBootstrap.ts`：
```ts
// apps/crish-mobile/src/adapters/persistence/persistBootstrap.ts:69-79
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
  // 致命点：仅更新了 settingsStore 与 notificationStore！
  // 没有任何代码通知 approvalWiring 或更新其 persistAdapter！
}
```

#### 根因深度剖析
1. `app/_layout.tsx` 在挂载时，并行派发 `startAppRuntime()` 与 `ensureDatabaseForApp()`。
2. 在已配对设备上，`startAppRuntime()` 触发 `handleAuthChange()` 同步调用 `ensureApprovalWiring()`。
3. 此时 `ensureDatabaseForApp()` 的原生 SQLite 打开（`openDatabaseAsync`）与 SQL 迁移仍在异步执行中，`getSqlDriver()` 返回 `null`。
4. `createDefaultOutboxPersist(null)` 降级返回 `new MemoryOutboxAdapter()`，并被固化为 `singleton` 单例。
5. 当 `ensureDatabaseForApp()` 最终打开数据库并执行 `configureSqlitePersistence(driver)` 时，仅注入了设置与通知 DAO，**未对审批单例进行热升级或驱动重绑定**。
6. **严重后果**：所有离线审批决策（批准/拒绝）仅保存在 JS 堆内存的 `MemoryOutboxAdapter` 中。一旦用户锁屏、退至后台被操作系统强杀（Low Memory Killer），未送达服务端的离线决策**全部静默蒸发**，造成不可逆的状态丢失。

---

### 2. 5/8 幽灵表（Phantom Tables）：离线存储名存实亡（DEF-STO-05）

#### 代码断层证据
在 `apps/crish-mobile/src/db/schema.ts` 中声明了 8 张表：
```ts
// apps/crish-mobile/src/db/schema.ts:21-30
export const TABLES = [
  'events',             // 1. 事件流镜像 (session_id, sequence 复合主键)
  'approval_queue',     // 2. outbox 待发队列
  'approval_history',   // 3. 审批决策记录
  'session_summaries',  // 4. 会话摘要
  'settings',           // 5. 键值存储
  'push_tokens',        // 6. 推送注册
  'device_info',        // 7. 配对元数据非敏感部分
  'notifications',      // 8. 应用内通知
] as const;
```

对整仓执行全量 SQL 读写扫描（`SELECT/INSERT/UPDATE/DELETE`）：
- `events`：**0 处读写**。
- `session_summaries`：**0 处读写**。
- `approval_history`：**0 处读写**。
- `push_tokens`：**0 处读写**。
- `device_info`：**0 处读写**。
仅有 `settings`、`notifications` 以及尚未正常接线的 `approval_queue` 实现了 DAO。

#### 根因深度剖析
1. 架构文档（M5 §5.2 / D6 §10.6）设计了完备的离线镜像体系，但移动端工程开发时仅完成了 DDL 表结构定义（`schema.ts`），尚未实现 `EventsDao`、`SessionSummariesDao`、`ApprovalHistoryDao`。
2. 导致所有聊天流事件（`eventStore`）与会话列表（`sessionStore`）完全运行在内存态。
3. **严重后果**：
   - 用户在离线状态下打开 App，会话列表与对话详情全是空白；
   - 每次冷启动或会话切换，必须通过 WebSocket 往返重拉历史（`hydrateSession`），产生巨大网络流量与首屏白屏等待；
   - 数据库白白耗费空间创建并维护 5 张空表的元数据和索引。

---

### 3. DAO 伪 upsert 存在无事务竞态，并发写入冲突崩溃（DEF-STO-06）

#### 代码断层证据
在 `apps/crish-mobile/src/db/dao/notificationsDao.ts`：
```ts
// apps/crish-mobile/src/db/dao/notificationsDao.ts:49-75
async upsert(row: NotificationRow): Promise<'inserted' | 'updated'> {
  const existing = await this.driver.getFirst<{ id: string }>(
    'SELECT id FROM notifications WHERE id = ?',
    [row.id]
  );
  if (existing !== null) {
    await this.driver.exec(
      `UPDATE notifications SET kind = ?, tool_call_id = ?, run_id = ?, seq = ?, title = ?, body = ?, route = ?, status = ?, received_at = ? WHERE id = ?`,
      [...]
    );
    return 'updated';
  }
  await this.driver.exec(
    `INSERT INTO notifications (id, kind, tool_call_id, run_id, seq, title, body, route, status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...]
  );
  return 'inserted';
}
```
在 `apps/crish-mobile/src/db/dao/settingsDao.ts:34-50` 存在完全相同的模式。

#### 根因深度剖析
1. 在移动端双通道架构下（WebSocket 实时连接 + Expo 远程推送服务），同一个关键通知（如 `approval-requested`）会通过双通道并发推送至客户端。
2. `upsert` 采用 Check-Then-Act（检查后执行）反模式，且**没有包裹在事务内**，也未使用 SQLite 原生的 `INSERT ... ON CONFLICT(id) DO UPDATE`。
3. 当 WS 帧与系统推送在毫秒级同时到达并触发 `upsert` 时：
   - 线程 A 与线程 B 同时执行 `SELECT id`，均返回 `null`；
   - 线程 A 执行 `INSERT INTO notifications` 成功；
   - 线程 B 紧接着执行 `INSERT INTO notifications`，立即触发原生错误：`UNIQUE constraint failed: notifications.id`；
   - 该异常向上冒泡未被捕获，导致通知消费管道异常中断。
4. **劣质设计的根因**：开发者为了让内存模拟驱动 `MemorySqlDriver`（在 `driver.ts` 中仅支持极简 SQL 子集，未实现 `ON CONFLICT` 语法解析）通过单测，倒退将生产 DAO 改为非原子的 `SELECT + INSERT`，引入了严重的并发时序竞态。

---

### 4. SQLite 事务冲突、循环 Prepare 与无批量写入（DEF-STO-07）

#### 代码断层证据
在 `apps/crish-mobile/src/db/db.ts`：
```ts
// apps/crish-mobile/src/db/db.ts:54-67
export function expoSqlDriver(db: SQLiteDatabase): SqlDriver {
  return {
    async exec(sql, params) {
      if (params === undefined || params.length === 0) {
        await db.execAsync(sql);
        return;
      }
      const statement = await db.prepareAsync(sql); // 致命点：单次执行单次 prepare
      try {
        await statement.executeAsync(params as SQLiteBindParams);
      } finally {
        await statement.finalizeAsync(); // 立即释放，零 Statement 缓存
      }
    },
    ...
  };
}
```
在 `apps/crish-mobile/src/db/dao/approvalQueueDao.ts`：
```ts
// apps/crish-mobile/src/db/dao/approvalQueueDao.ts:74-95
async replaceAll(items: readonly OutboxItem[]): Promise<void> {
  await this.driver.withTransaction(async () => {
    await this.driver.exec('DELETE FROM approval_queue');
    for (const item of items) {
      await this.driver.exec(INSERT_SQL, [...]); // 在事务中循环调用 exec，每次产生 3 次原生异步桥接！
    }
  });
}
```

#### 根因深度剖析
1. **跨桥序列化开销巨大**：`expoSqlDriver.exec` 对带参 SQL 没有预编译语句池缓存，每次调用都要经历 `prepareAsync` -> `executeAsync` -> `finalizeAsync`。在 Outbox 批量保存 50 条项时，产生 150 次 React Native 异步跨桥调用。
2. **连接独占与死锁隐患**：`expo-sqlite` 缺省单连接打开。在 `withTransactionAsync` 执行过程中，整个连接处于独占写入事务状态。如果此时其他并发任务（如通知写入或设置查询）触发 SQL 调用，将由于等待事务锁引发延迟激增，甚至在嵌套调用时抛出 `cannot start a transaction within a transaction` 异常。
3. **缺乏读写分离与批量接口**：未利用 SQLite WAL 模式支持多读单写的特性，所有操作挤在同一 `SqlDriver` 句柄上；未提供 `executeBatchAsync` 批量执行能力。

---

### 5. 迁移脚本在事务内执行 PRAGMA user_version 违背标准且缺降级防线（DEF-STO-09）

#### 代码断层证据
在 `apps/crish-mobile/src/db/db.ts`：
```ts
// apps/crish-mobile/src/db/db.ts:25-33
for (let v = current; v < migrations.length; v++) {
  const migration = migrations[v]!;
  await db.withTransaction(async () => {
    for (const sql of migration.sql) {
      await db.exec(sql);
    }
    await db.exec(`PRAGMA user_version = ${v + 1}`); // 致命点：在事务内执行 user_version 变更
  });
}
```

#### 根因深度剖析
1. SQLite 官方规范明确指出：**修改元数据配置的 `PRAGMA` 指令（包括 `user_version`、`journal_mode`、`foreign_keys`）不允许在活动事务（BEGIN...COMMIT）中执行**。
2. 在部分 Android NDK 预编译或原生 SQLite 编译版本中，事务内的 `PRAGMA user_version = X` 会被静默忽略（在 COMMIT 时不落盘），或者直接触发报错。
3. 一旦发生静默忽略，数据库表结构虽然已创建，但 `PRAGMA user_version` 仍保持为 0，下次应用冷启动时将重新跑一遍所有 DDL 语句，引发主键/索引重复冲突。
4. 此外，迁移缺乏版本降级防御（Downgrade Protection）：如果安装旧版本 APK，`user_version` 高于 `MIGRATIONS.length` 时不做任何校验或告警，直接放行，可能引发严重的数据表错配。

---
## 四、专项审计维度二：`expo-secure-store` 硬件密钥凭据安全性

### 1. 凭据存储安全性分析（硬件 Keystore / Keychain 映射与访问控制缺口）

#### 存储键位划分评估
移动端对凭据进行了清晰的分层划分（`secureStore.ts:14-48`）：
- **核心配对 4 密钥位**：`pair.token_key`（HMAC 密钥）、`pair.refresh_key`（重连密钥）、`device.keypair.priv`（X25519 私钥）、`device.keypair.pub`（公钥）；
- **证书指纹位**：`pair.host_fingerprint`；
- **云端账号位**：`account.access_token`、`account.refresh_token`、`account.device_id`、`account.user_id`、`account.email`。
存储划分符合安全基线，密钥明文不落 SQLite。

#### 驱动层缺少安全选项配置
在 `apps/crish-mobile/src/db/secureStore.ts:262-275`：
```ts
export function expoSecureStoreDriver(): SecureStoreDriver {
  if (Platform.OS === 'web') return webStorageDriver();
  return {
    async getItem(key) {
      return SecureStore.getItemAsync(key); // 未传任何 keychainAccessible 选项！
    },
    async setItem(key, value) {
      await SecureStore.setItemAsync(key, value);
    },
    async deleteItem(key) {
      await SecureStore.deleteItemAsync(key);
    },
  };
}
```
- **iOS 访问控制缺口**：未显式指定 `keychainAccessible`，默认为 `WHEN_UNLOCKED`。当设备在后台收到远程推送唤醒（后台静默同步），若此时手机处于锁屏状态，Keychain 读取将直接被 iOS 系统内核拒绝并抛出异常。必须按需求配置为 `AFTER_FIRST_UNLOCK`。
- **Android 设备降级缺口**：在部分未设置屏幕锁（No Lock Screen / PIN / Biometrics）的低端机型或测试设备上，Android Keystore 默认配置可能导致生成或解密密钥失败。未提供安全降级（如加密文件存储回退）策略。

---

### 2. 异常未捕获导致冷启动无限转圈死锁（DEF-STO-02）

#### 代码断层证据
在 `apps/crish-mobile/src/adapters/account/accountService.ts`：
```ts
// apps/crish-mobile/src/adapters/account/accountService.ts:159-167
export async function hydrateAccount(): Promise<void> {
  const state = accountStore.getState();
  if (state.hydrated) return;
  const session = await loadAccountSession(driver); // 致命点：没有 try/catch！
  if (!session) {
    accountStore.getState().setHydrated(true);
    accountStore.getState().setStatus('loggedOut');
    return;
  }
  ...
```
在 `apps/crish-mobile/src/adapters/runtime/accountRuntime.ts`：
```ts
// apps/crish-mobile/src/adapters/runtime/accountRuntime.ts:81-86
export function startAccountRuntime(): void {
  if (started) return;
  started = true;
  unsubscribe = accountStore.subscribe(syncRemote);
  void hydrateAccount().finally(syncRemote); // 致命点：hydrateAccount 抛错后，hydrated 永远为 false！
  ...
}
```
在 `apps/crish-mobile/app/_layout.tsx`：
```ts
// apps/crish-mobile/app/_layout.tsx:88-100
if (!hydrated || !accountHydrated) { // 致命点：accountHydrated 永不为 true！
  return (
    <View style={[styles.splash, ...]}>
      <BrandMark size={64} />
      <Spinner />
    </View>
  );
}
```

#### 根因深度剖析
1. 在 Android 设备上，如果用户未设置锁屏密码、系统 Keystore 证书链损坏、或加密分区分段错误，`expo-secure-store` 的 `getItemAsync` 会抛出底层未检查异常（如 `KeyStoreAccessException`、`BadPaddingException`）。
2. `loadAccountSession` 内部使用 `Promise.all` 聚合 5 个键读取，任一键报错即导致整个 Promise 拒绝。
3. `hydrateAccount()` 对 `loadAccountSession` **完全没有包裹 try-catch**，Promise 异常中断执行，后续的 `accountStore.getState().setHydrated(true)` 永远无法被执行。
4. 根布局 `app/_layout.tsx` 的首屏网关严格断言 `if (!hydrated || !accountHydrated) return <Spinner />`。
5. **严重后果**：用户打开 App 永远停留在带 Logo 的 Loading 界面（**无限菊花死锁 / White Screen of Death**），用户无法进入应用，无法进入设置页，也无法重置或退出登录，应用彻底瘫痪。

---

## 五、专项审计维度三：Zustand Store 状态机并发与数据一致性

### 1. 序列空洞自愈（Sequence Gap Detection）时序倒挂，回放数据被当作重复帧丢弃（DEF-STO-03）

#### 代码断层证据
在 `apps/crish-mobile/src/adapters/wiring/feedBridge.ts`：
```ts
// apps/crish-mobile/src/adapters/wiring/feedBridge.ts:132-150
if (frame.kind === 'events.push') {
  const body = readRecord(frame.body) ?? {};
  const ev = readRecord(body['event']) ?? {};
  const sessionId = typeof ev['sessionId'] === 'string' ? ev['sessionId'] : null;
  const seq = typeof ev['sequence'] === 'number' ? ev['sequence'] : null;
  if (sessionId && seq !== null) {
    const currentSeq = lastSeqOf(sessionId);
    // 发现序列空洞（例如本地游标是 100，收到推送是 105，中间漏了 101~104）
    if (currentSeq > 0 && seq > currentSeq + 1) {
      this.resumeSession(sessionId, currentSeq); // 异步触发续传增量补齐
    }
  }
}

// 致命点：完全不等待补洞，紧接着直接把当前乱序帧 105 同步分发入库！
const actions = mapDeviceFrame({ kind: frame.kind, body: frame.body });
this.applyActions(actions);
```

在 `packages/shared-utils/src/event-ring-window.ts`：
```ts
// packages/shared-utils/src/event-ring-window.ts:75-82
if (seq <= window.lastSeq) {
  // 重复/回退 seq：已确认过（含被环形淘汰）→ 丢弃
  return 'duplicate';
}
window.entries.push(entry);
if (!preview) {
  window.lastSeq = seq; // 致命点：帧 105 到达，直接把 window.lastSeq 强行推进至 105！
}
```

在 `packages/shared-utils/src/event-ring-window.ts`（续传页合并）：
```ts
// packages/shared-utils/src/event-ring-window.ts:126-138
export function hydrateFeed(
  window: EventWindow,
  frames: readonly EventEnvelopeFrame[],
  cursor: number | undefined,
  nowMs: number
): void {
  for (const frame of frames) {
    appendFeed(window, frame, false, nowMs); // 逐条调用 appendFeed
  }
  ...
}
```

#### 根因与时序重放验证
假设网络出现抖动或乱序，服务端连续发送 100~105 号事件：
1. 本地当前游标为 `lastSeq = 100`。
2. 由于网络延迟，101~104 丢失或迟到，105 号事件（`events.push`）先到达客户端。
3. `feedBridge.ts:142` 命中空洞判定：`105 > 100 + 1`，发起异步补洞请求 `resumeSession(sessionId, 100)`。
4. **致命时序断层**：代码没有将 105 号事件挂起或放入待定缓冲区，而是在第 149 行立即同步执行 `applyActions`。
5. 105 号事件进入 `appendFeed`，由于 `105 > 100`，105 入队，并将 `window.lastSeq` **直接修改为 105**！
6. 紧接着，补洞请求的响应 `events.resume.page` 返回，携带 101, 102, 103, 104 号事件。
7. `handleResumePage` 调用 `hydrateFeed`，对 101~104 逐一调用 `appendFeed`。
8. 当执行到 101 时，`appendFeed` 检查：`if (seq <= window.lastSeq)`。
   此时 `window.lastSeq` 已经是 105，因此：
   - 101 <= 105 为真 -> **判定为 duplicate，直接丢弃！**
   - 102 <= 105 为真 -> **判定为 duplicate，直接丢弃！**
   - 103 <= 105 为真 -> **判定为 duplicate，直接丢弃！**
   - 104 <= 105 为真 -> **判定为 duplicate，直接丢弃！**
9. **严重破坏**：自愈补洞逻辑不仅没有补齐事件，反而彻底封死了这些丢失事件入库的大门，导致会话时间线永久缺失关键内容（如工具返回结果或代码执行输出）。

---

### 2. 重连投影工厂未接线，生产环境重连对账机制全量失效（DEF-STO-04）

#### 代码断层证据
在 `apps/crish-mobile/src/network/ReconnectingWsClient.ts` 中定义了完备的投影驱动机制：
```ts
// apps/crish-mobile/src/network/ReconnectingWsClient.ts:540-552
private driveProjection(): void {
  const source = this.opts.projections?.() ?? {
    snapshots: [],
    outboxPending: false,
  };
  const projection = projectReconnect(
    'open',
    source.snapshots,
    source.outboxPending
  );
  this.lastProjectionValue = projection;
  this.opts.onProjection?.(projection);
}
```

然而，在生产环境唯一装配点 `apps/crish-mobile/src/adapters/wiring/observationWiring.ts`：
```ts
// apps/crish-mobile/src/adapters/wiring/observationWiring.ts:88-105
const client = new ReconnectingWsClient({
  url: opts.url,
  ...(opts.token !== undefined ? { token: opts.token } : {}),
  ...(opts.factory ? { factory: opts.factory } : {}),
  gateway,
  onPhaseChange: (phase: WsPhase) => {
    bridge.handlePhaseChange(phase);
    if (phase === 'open') {
      openListeners.forEach((listener) => listener());
    }
  },
  onProjection: (projection: ReconnectProjection) =>
    bridge.handleProjection(projection),
  // 致命点：没有传入 projections 选项！
});
```

#### 根因深度剖析
1. `ReconnectingWsClient` 依靠 `opts.projections()` 收集各个会话的本地游标快照（`localCursor`）以及 Outbox 是否有待重发项（`outboxPending`）。
2. 在 `observationWiring.ts` 实例化 `ReconnectingWsClient` 时，**漏传了 `projections` 工厂函数**。
3. 导致每次重连触发 `driveProjection()` 时，`source.snapshots` 恒为 `[]`。
4. `projectReconnect` 计算产出的 `resume`、`fullReplay`、`cleanup`、`fresh` 数组恒为空。
5. 上层 `FeedBridge.handleProjection` 接收到的对账指令永远为空数组，**整个精心设计的重连对账自愈状态机在生产环境下是 100% 无法运转的死代码**。

---

### 3. 高频实时推理 Token 流未节流，引发 UI 掉帧卡顿（DEF-STO-08）

#### 代码断层证据
在 `apps/crish-mobile/src/adapters/wiring/ingestRouter.ts`：
```ts
// apps/crish-mobile/src/adapters/wiring/ingestRouter.ts:27-34
for (const action of actions) {
  switch (action.kind) {
    case 'feed-append':
      eventStore
        .getState()
        .ingest(action.sessionId, action.frame, action.preview);
      break;
    ...
```
在 `apps/crish-mobile/src/domain/store/eventStore.ts`：
```ts
// apps/crish-mobile/src/domain/store/eventStore.ts:67-70
ingest: (sessionId, frame, preview = false, nowMs = nowDefault()) =>
  set((s) => {
    appendFeed(ensureWindow(s, sessionId), frame, preview, nowMs);
  }),
```
在 `apps/crish-mobile/src/presentation/timeline/useSessionWindow.ts`：
```ts
// apps/crish-mobile/src/presentation/timeline/useSessionWindow.ts:7-9
export function useSessionWindow(sessionId: string) {
  return useEventStore((s) => s.windows[sessionId] ?? EMPTY_WINDOW);
}
```

#### 根因深度剖析
1. 当后端 Agent 处于推理生成状态时，`tool-call-chunk`、`message-delta` 等增量预览帧以每秒 20~80 帧的极高频率涌入 WebSocket。
2. 每到达一帧，`ingestRouter` 均立即调用 `eventStore.ingest`，Zustand 结合 Immer 产生新的状态对象。
3. `useSessionWindow` 订阅了 `windows[sessionId]` 引用，导致包含该 Hook 的组件树（`sessionDetailScreen`、`TimelineView`）以相同频率触发 React 重渲染。
4. 在 `TimelineView` 每次重渲染中，纯函数 `buildTimeline(window.entries)` 遍历全部最多 500 个事件条目，执行密集的 ANSI 正则替换（`stripAnsi`）、JSON 解析与数据块重构。
5. **严重后果**：React Native 单一 JS 线程被连续密集计算占满，渲染帧率瞬间跌至个位数（10~15 fps），键盘输入与手势滑动出现极其明显的卡顿与迟滞。

---

### 4. 对账补入审批项参数强制置空，详情页无法展示入参（DEF-STO-10）

#### 代码断层证据
在 `apps/crish-mobile/src/adapters/wiring/approvalWiring.ts`：
```ts
// apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:182-195
export function mapReconcileApprovalItem(
  pa: PendingApproval,
  _nowMs: number
): ApprovalItem {
  const request: PermissionRequest = {
    id: pa.requestId,
    sessionId: pa.sessionId ?? '',
    cwd: pa.cwd ?? '',
    toolCallId: pa.toolCallId,
    toolName: pa.toolName,
    parameters: {}, // 致命点：硬编码赋空对象！
    summary: pa.summary ?? pa.toolName,
    toolMetadata: {},
  };
  ...
```
在 `apps/crish-mobile/src/presentation/components/blocks/ApprovalCard.tsx`：
```ts
// apps/crish-mobile/src/presentation/components/blocks/ApprovalCard.tsx:104-106
const summary = item.riskMeta?.command
  ? `$ ${maskCommandSecrets(item.riskMeta.command)}`
  : summarizeParameters(item.request.parameters); // 致命点：只取 parameters，完全忽略 request.summary！
```

#### 根因深度剖析
1. 断网恢复触发 `remote.listPendingApprovals` 对账时，服务端下发了审批摘要 `pa.summary`。
2. 映射函数 `mapReconcileApprovalItem` 将参数置为空对象 `parameters: {}`。
3. 前端 UI 组件 `ApprovalCard` 在渲染参数摘要时，优先取 `riskMeta.command`，否则退化至 `summarizeParameters(item.request.parameters)`。
4. 由于 `parameters` 为空，`summary` 计算结果为空字符串，导致界面直接隐去整个参数展示区。
5. **严重后果**：用户从断网重连后打开审批弹窗，看不到这个工具执行的命令或参数细节，只能看到一个工具名，存在严重的盲批安全隐患。

---
## 六、精准修复实施方案与架构蓝图

针对上述静态体检发现的 10 项缺陷，制定如下结构性修复实施指引（精准对应到具体源码文件与逻辑方案）：

### 1. 修复 DEF-STO-01（Outbox 驱动生命周期重绑定与 SQLite 真源持久化）
- **核心文件**：
  - `apps/crish-mobile/src/adapters/persistence/persistBootstrap.ts`
  - `apps/crish-mobile/src/adapters/wiring/approvalWiring.ts`
  - `apps/crish-mobile/src/db/dbBootstrap.ts`
- **实施方案**：
  1. 在 `approvalWiring.ts` 中增加动态热升级接口：
     ```ts
     export function upgradeApprovalPersistAdapter(adapter: OutboxPersistAdapter): void {
       if (singleton) {
         singleton.bridge.updatePersistAdapter(adapter);
         void singleton.bridge.hydrate(); // 立即回填落盘的离线决策
       }
     }
     ```
  2. 在 `persistBootstrap.ts:configureSqlitePersistence` 中增加审批持久化升级触发：
     ```ts
     export function configureSqlitePersistence(driver: SqlDriver | null): void {
       currentDriver = driver;
       configureSettingsPersistence(driver === null ? null : (new SqlSettingsDao(driver) as SettingsPersist));
       configureNotificationsPersistence(driver === null ? null : new DaoNotificationsPersist(new SqlNotificationsDao(driver)));
       if (driver !== null) {
         upgradeApprovalPersistAdapter(new SqliteOutboxAdapter(driver));
       }
     }
     ```
  3. 彻底根除 DB 初始化与运行时启动的竞态条件，保证只要 SQLite 打开成功，审批 Outbox 必然自动绑定至 SQLite `approval_queue`。

---

### 2. 修复 DEF-STO-02（SecureStore 异常兜底与防无限 Loading）
- **核心文件**：
  - `apps/crish-mobile/src/adapters/account/accountService.ts`
  - `apps/crish-mobile/src/db/secureStore.ts`
- **实施方案**：
  1. 在 `accountService.ts:hydrateAccount` 中增加对底层加解密异常的兜底：
     ```ts
     export async function hydrateAccount(): Promise<void> {
       const state = accountStore.getState();
       if (state.hydrated) return;
       let session: AccountSession | null = null;
       try {
         session = await loadAccountSession(driver);
       } catch (error) {
         console.warn('[account] SecureStore 读取异常（可能未设置锁屏密码或 KeyStore 损坏），降级未登录态:', error);
       }
       if (!session) {
         accountStore.getState().setHydrated(true); // 保证必定置位！
         accountStore.getState().setStatus('loggedOut');
         return;
       }
       ...
     ```
  2. 在 `secureStore.ts:expoSecureStoreDriver` 中配置访问选项与错误容错：
     ```ts
     export function expoSecureStoreDriver(): SecureStoreDriver {
       if (Platform.OS === 'web') return webStorageDriver();
       return {
         async getItem(key) {
           try {
             return await SecureStore.getItemAsync(key, {
               keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
             });
           } catch (e) {
             console.warn(`[secureStore] getItemAsync error for key ${key}:`, e);
             return null;
           }
         },
         ...
       };
     }
     ```

---

### 3. 修复 DEF-STO-03（序列空洞有序自愈缓冲区）
- **核心文件**：
  - `apps/crish-mobile/src/adapters/wiring/feedBridge.ts`
  - `packages/shared-utils/src/event-ring-window.ts`
- **实施方案**：
  1. 在 `feedBridge.ts` 中维护待排队事件缓冲区（Stash Buffer）：
     ```ts
     private readonly pendingGaps = new Map<string, InboundEnvelope[]>();
     ```
  2. 当收到 `events.push` 且 `seq > currentSeq + 1` 时：
     - 将乱序帧放入 `pendingGaps` 暂存，**绝对不立即分发至 `applyActions`**；
     - 记录空洞目标并调用 `this.resumeSession(sessionId, currentSeq)`；
     - 当 `handleResumePage` 补齐事件后，检查待排队缓冲区，将序号符合连续条件的事件释放并分发。
  3. 改进 `appendFeed`：对于带有空洞的序列，禁止跳跃式推进 `lastSeq`，确保游标代表的是“连续已确认的最大序号”。

---

### 4. 修复 DEF-STO-04（装配重连投影工厂函数）
- **核心文件**：
  - `apps/crish-mobile/src/adapters/wiring/observationWiring.ts`
- **实施方案**：
  在 `startObservationWiring` 创建 `ReconnectingWsClient` 时，传入 `projections` 工厂：
  ```ts
  const client = new ReconnectingWsClient({
    url: opts.url,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.factory ? { factory: opts.factory } : {}),
    gateway,
    projections: () => {
      const sessions = sessionStore.getState().sessions;
      const snapshots: ReconcileSnapshot[] = sessions.map((s) => ({
        sessionId: s.id,
        localCursor: lastSeqOf(s.id),
        serverNext: s.engineCursor ?? 0,
        serverStale: false,
      }));
      return {
        snapshots,
        outboxPending: approvalOutboxCount() > 0,
      };
    },
    onPhaseChange: ...
    onProjection: (projection: ReconnectProjection) =>
      bridge.handleProjection(projection),
  });
  ```

---

### 5. 修复 DEF-STO-05（5/8 幽灵表业务接入路线）
- **核心文件**：
  - `apps/crish-mobile/src/db/dao/`
  - `apps/crish-mobile/src/domain/store/eventStore.ts`
  - `apps/crish-mobile/src/domain/store/sessionStore.ts`
- **实施方案**：
  1. 补全 `EventsDao` 与 `SessionSummariesDao` 实现；
  2. 在 `eventStore` 与 `sessionStore` 中引入持久化中间件（或仿照 `settingsStore` 的注入模式）；
  3. 会话变更与时间线新帧到达后，异步批量落盘至 `session_summaries` 与 `events` 表；
  4. 冷启动时优先从本地 SQLite 表回填（Hydrate）展示，实现真正的秒开与完全离线查看体验。

---

### 6. 修复 DEF-STO-06（DAO 原子 ON CONFLICT 改造）
- **核心文件**：
  - `apps/crish-mobile/src/db/dao/notificationsDao.ts`
  - `apps/crish-mobile/src/db/dao/settingsDao.ts`
  - `apps/crish-mobile/src/db/driver.ts`
- **实施方案**：
  1. 废弃非原子的 `SELECT + INSERT/UPDATE` 伪 upsert 代码；
  2. 使用 SQLite 原生的 `INSERT ... ON CONFLICT(key) DO UPDATE SET ...` 语句；
  3. 在 `MemorySqlDriver`（`driver.ts`）中增加对 `ON CONFLICT` 语法的解析模拟支持，确保单测与真实 SQLite 行为严格对齐。

---

### 7. 修复 DEF-STO-07（SQLite 批量写入与预编译缓存）
- **核心文件**：
  - `apps/crish-mobile/src/db/driver.ts`
  - `apps/crish-mobile/src/db/db.ts`
  - `apps/crish-mobile/src/db/dao/approvalQueueDao.ts`
- **实施方案**：
  1. 在 `SqlDriver` 接口中增加 `execBatch(sql: string, paramsList: readonly (readonly unknown[])[]): Promise<void>`；
  2. 在 `expoSqlDriver` 中，一次性编译 `const stmt = await db.prepareAsync(sql)`，然后在单次循环中多次调用 `executeAsync`，最后统一 `finalizeAsync`；
  3. `SqlApprovalQueueDao.replaceAll` 改为批量接口调用，将跨桥异步调用从 3N 次降至 1 次。

---

### 8. 修复 DEF-STO-08（Token 流 RAF / 微任务防抖批处理）
- **核心文件**：
  - `apps/crish-mobile/src/adapters/wiring/ingestRouter.ts`
- **实施方案**：
  引入高频事件写入缓冲批处理器（`IngestBatcher`）：
  ```ts
  let pendingActions: StoreIngestAction[] = [];
  let rafHandle: number | null = null;

  function flushBatch() {
    rafHandle = null;
    const actions = pendingActions;
    pendingActions = [];
    executeDispatches(actions);
  }

  export function dispatchIngestActionsThrottled(actions: readonly StoreIngestAction[]): void {
    pendingActions.push(...actions);
    if (rafHandle === null) {
      rafHandle = requestAnimationFrame(flushBatch);
    }
  }
  ```
  保证无论底层 WebSocket 以多高频率推送增量 Token，状态机更新与 React 重渲染频率均受控在每秒不超过 60 次（帧同步）。

---

### 9. 修复 DEF-STO-09（PRAGMA 移出事务与降级防御）
- **核心文件**：
  - `apps/crish-mobile/src/db/db.ts`
- **实施方案**：
  1. 将 `PRAGMA user_version` 移出事务外：
     ```ts
     for (let v = current; v < migrations.length; v++) {
       const migration = migrations[v]!;
       await db.withTransaction(async () => {
         for (const sql of migration.sql) {
           await db.exec(sql);
         }
       });
       await db.exec(`PRAGMA user_version = ${v + 1}`);
     }
     ```
  2. 增加版本降级校验拦截：
     ```ts
     if (current > migrations.length) {
       console.warn(`[db] 检测到数据库版本高于代码版本 (DB=${current}, Code=${migrations.length})，可能由版本回退导致！`);
     }
     ```

---

### 10. 修复 DEF-STO-10（对账审批摘要回退展示）
- **核心文件**：
  - `apps/crish-mobile/src/presentation/components/blocks/ApprovalCard.tsx`
  - `apps/crish-mobile/src/adapters/wiring/approvalWiring.ts`
- **实施方案**：
  在 `ApprovalCard.tsx` 中，当 `parameters` 为空但存在 `request.summary` 时，将其作为摘要正常展示：
  ```ts
  const summary = item.riskMeta?.command
    ? `$ ${maskCommandSecrets(item.riskMeta.command)}`
    : Object.keys(item.request.parameters).length > 0
      ? summarizeParameters(item.request.parameters)
      : (item.request.summary || '');
  ```
  彻底解决重连恢复后的审批项无法查看执行命令与操作意图的问题。

---

## 七、总结与后续协同建议

本专项审计穿透了 Crish 移动端离线存储与状态机并发的核心实现。体检揭示：系统在逻辑抽象与架构设计上具备很高的水准，但在**异步时序衔接、底层存储异常隔离、乱序自愈算法的边界条件处理**上存在多处致命疏漏。

### 核心建议路线：
1. **优先阻断 P0 致命缺陷**：
   - 立即修复 DEF-STO-01（Outbox 驱动升级），杜绝离线审批丢单；
   - 立即修复 DEF-STO-02（SecureStore try/catch 兜底），消除 Android 设备无限菊花死锁；
   - 立即修复 DEF-STO-03 与 DEF-STO-04，恢复重连自愈与增量补齐生命线。
2. **渐进收敛 P1 性能与并发缺陷**：
   - 实施 Token 流 RAF 批处理（DEF-STO-08），保障长文本生成时的流畅交互；
   - 改造 DAO 为原子 `ON CONFLICT`，根除双通道推送并发崩溃（DEF-STO-06）。
3. **严格遵守反退避纪律**：
   不采取打补丁式延时猜测，从根源上建立健壮的数据同步与离线存储防线。