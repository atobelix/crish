# R03 离线存储与状态机并发对抗复核报告

> **复核席位**：第二轮战役 · R03 离线存储与状态机并发对抗复核席  
> **被复核对象**：`docs/mobile-full-audit/audits/03-storage-sqlite-and-state-audit.md`  
> **审计代码范围**：`apps/crish-mobile/src/db/`、`apps/crish-mobile/src/domain/store/`、`apps/crish-mobile/src/adapters/`、`packages/shared-utils/src/`  
> **复核准则**：`docs/mobile-full-audit/prompts/00-共同约束前言.md`、`docs/mobile-full-audit/prompts/R03-复核存储与状态机.md`、反过度设计红线与立体验证铁律  
> **复核日期**：2026-10-30  

---

## 0 结论摘要

1. **核心定性结论**：被复核报告对**逻辑时序漏洞（序列空洞倒挂 DEF-STO-03、重连投影缺失 DEF-STO-04、未捕获异常导致启动死锁 DEF-STO-02）**的定性分析完全成立且极为精准，属于必须立即根治的高危数据隐患；但对**严重度量化（如“100% 丢失”、“150 次跨桥调用”、“掉帧至 10~15 fps”）**与“45/100 严禁上线”的评级存在显著夸大与脱水放大。
2. **逐条判定全貌**：被复核报告共 10 项缺陷，经逐行代码与调用链验证，**✅ 成立 5 项**（DEF-STO-02, 03, 04, 06, 10），**⚠️ 部分成立 2 项**（DEF-STO-01, 05），**❌ 夸大 3 项**（DEF-STO-07, 08, 09/健康度评分），**🚫 不成立 0 项**，**❓ 无法验证 0 项**。
3. **架构纠偏**：原报告对 DEF-STO-05（5/8 幽灵表）给出的“补全 5 张表 DAO 并落地离线事件镜像”建议严重违背了项目伴侣定位、用户规则 U2/U3 及反过度设计红线；正确方案应为**彻底清理死 schema**而非过度建设。
4. **遗漏扫描新发现 3 项隐患**：① 解绑注销时未清理 SQLite `approval_queue` 导致残留离线决策跨会话越权泄漏（OMIT-01）；② `clearSessionData()` 漏复位 `connectionStore` 与 `notificationStore`（OMIT-02）；③ `observationWiring` 的 `openListeners` 未随 `dispose` 清理导致生命周期回调悬挂泄漏（OMIT-03）。
5. **综合评语**：**该报告是一份高质量的逻辑漏洞深度诊断书，但在量化影响与评分上存在对抗性夸大，其架构修复建议需纠偏反过度设计**。

---

## 1 现状还原（带 路径:行号 的确凿证据）

### 1.1 DEF-STO-01：DB 启动异步竞态与 Outbox 持久化绑定断层
- **现场位置**：`apps/crish-mobile/app/_layout.tsx:60-66`、`apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:533-551`、`apps/crish-mobile/src/adapters/persistence/persistBootstrap.ts:69-79`、`apps/crish-mobile/src/db/dbBootstrap.ts:50-74`
- **代码切片**：
  ```ts
  // apps/crish-mobile/app/_layout.tsx:60-66
  useEffect(() => {
    startAppRuntime(); // 内部 authStore.subscribe 同步触发 handleAuthChange() -> ensureApprovalWiring()
  }, []);
  useEffect(() => {
    void ensureDatabaseForApp(); // 异步执行 openDatabaseAsync + 迁移
  }, []);
  ```
  ```ts
  // apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:544-550
  singleton = startApprovalWiring({
    persistAdapter: createDefaultOutboxPersist(getSqlDriver()), // 此时 DB 正在打开，getSqlDriver() 返回 null！
    ...opts,
    gateway,
  });
  ```
  ```ts
  // apps/crish-mobile/src/adapters/persistence/persistBootstrap.ts:69-79
  export function configureSqlitePersistence(driver: SqlDriver | null): void {
    currentDriver = driver;
    configureSettingsPersistence(driver === null ? null : (new SqlSettingsDao(driver) as SettingsPersist));
    configureNotificationsPersistence(driver === null ? null : new DaoNotificationsPersist(new SqlNotificationsDao(driver)));
    // 缺失：完全没有通知 approvalWiring 或升级其 persistAdapter 的逻辑！
  }
  ```
- **调用链还原**：在已配对设备冷启动时，`_layout.tsx` 同时触发 `startAppRuntime()`、`ensurePairingWiringForApp()` 与 `ensureDatabaseForApp()`。若 SecureStore 水合早于 SQLite 文件打开及 DDL 迁移完成，`ensureApprovalWiring()` 读取 `getSqlDriver()` 为 `null`， Outbox 永久绑定至 `MemoryOutboxAdapter`。全局 grep 证实整仓零 `upgrade` 或 `setPersist` 接口，单例创建后永久不升级。

### 1.2 DEF-STO-02：`hydrateAccount()` 未捕获 SecureStore 异常导致无限转圈死锁
- **现场位置**：`apps/crish-mobile/src/adapters/account/accountService.ts:159-212`、`apps/crish-mobile/src/adapters/runtime/accountRuntime.ts:81-86`、`apps/crish-mobile/app/_layout.tsx:88-100`、`node_modules/expo-secure-store/android/src/main/java/expo/modules/securestore/SecureStoreModule.kt:169-170`
- **代码切片**：
  ```ts
  // apps/crish-mobile/src/adapters/account/accountService.ts:159-170
  export async function hydrateAccount(): Promise<void> {
    const state = accountStore.getState();
    if (state.hydrated) return;
    const session = await loadAccountSession(driver); // 致命行：第 162 行，位于 try 块之外！
    if (!session) {
      accountStore.getState().setHydrated(true);
      accountStore.getState().setStatus('loggedOut');
      return;
    }
    const deviceId = session.deviceId || (await accountDeviceId());
    accountStore.getState().setAccessToken(session.accessToken);
    try { // try 块直到第 170 行才开始！
  ...
    } finally {
      accountStore.getState().setHydrated(true); // 仅保护第 170 行之后的代码！
    }
  }
  ```
  ```ts
  // apps/crish-mobile/app/_layout.tsx:88-90
  if (!hydrated || !accountHydrated) {
    return (
      <View style={[styles.splash, ...]}>
        <BrandMark size={64} /><Spinner />
      </View>
    );
  }
  ```
- **调用链还原**：`loadAccountSession` 在第 162 行未被 `try` 包裹。底层驱动 `expoSecureStoreDriver.getItem` 直接透传 `SecureStore.getItemAsync`，Android 原生层遇 `GeneralSecurityException` 时抛出 `DecryptException`。一旦抛错，Promise 拒绝中断执行，第 164 行及 `finally` 均无法执行，`accountStore.hydrated` 永久为 `false`。`_layout.tsx:88` 的启动守卫永远拦截并渲染开屏菊花，应用永久无法进入交互态。

### 1.3 DEF-STO-03：序列空洞探测过早推进游标致补洞数据批量被弃
- **现场位置**：`apps/crish-mobile/src/adapters/wiring/feedBridge.ts:132-155`、`packages/shared-utils/src/event-ring-window.ts:75-82`、`packages/shared-utils/src/event-ring-window.ts:126-138`
- **代码切片**：
  ```ts
  // apps/crish-mobile/src/adapters/wiring/feedBridge.ts:141-149
  const currentSeq = lastSeqOf(sessionId);
  if (currentSeq > 0 && seq > currentSeq + 1) {
    this.resumeSession(sessionId, currentSeq); // 异步触发补洞
  }
  const actions = mapDeviceFrame({ kind: frame.kind, body: frame.body });
  this.applyActions(actions); // 致命断层：紧接着直接将乱序高帧同步分发入库！
  ```
  ```ts
  // packages/shared-utils/src/event-ring-window.ts:75-82
  if (seq <= window.lastSeq) {
    return 'duplicate'; // 致命丢弃点：由于 105 已入库，lastSeq 已达 105，补洞帧 101~104 全部命中此处！
  }
  window.entries.push(entry);
  if (!preview) {
    window.lastSeq = seq; // 帧 105 直接将 lastSeq 推进到 105
  }
  ```
- **推演链还原**：本地游标为 100，收到乱序帧 105。代码未将 105 挂起，而是直接通过 `appendFeed` 写入并推进 `lastSeq = 105`。随后服务端下发补洞帧 101~104，`hydrateFeed` 逐条调用 `appendFeed`，均因 `seq <= 105` 命中重复防线被全量静默丢弃，导致时间线永久性残缺。
### 1.4 DEF-STO-04：`observationWiring` 漏传 `projections` 致重连对账停摆
- **现场位置**：`apps/crish-mobile/src/adapters/wiring/observationWiring.ts:88-105`、`apps/crish-mobile/src/network/ReconnectingWsClient.ts:540-552`、`apps/crish-mobile/src/network/ReconnectingWsClient.ts:213-240`
- **代码切片**：
  ```ts
  // apps/crish-mobile/src/adapters/wiring/observationWiring.ts:88-105
  const client = new ReconnectingWsClient({
    url: opts.url,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    gateway,
    onPhaseChange: ...,
    onProjection: (projection: ReconnectProjection) =>
      bridge.handleProjection(projection),
    // 致命漏传：没有传 projections 工厂函数！
  });
  ```
  ```ts
  // apps/crish-mobile/src/network/ReconnectingWsClient.ts:541-544
  const source = this.opts.projections?.() ?? {
    snapshots: [],
    outboxPending: false,
  };
  const projection = projectReconnect('open', source.snapshots, source.outboxPending);
  ```
- **调用链还原**：`observationWiring` 实例化 `ReconnectingWsClient` 时漏传 `projections` 配置，使得重连成功触发 `driveProjection()` 时 `source` 恒为 `{ snapshots: [], outboxPending: false }`。纯函数 `projectReconnect` 对空输入产出的 `resume`、`fullReplay`、`cleanup` 等重连指令恒为空数组。上层 `FeedBridge.handleProjection` 接收到的动作永远为空，生产环境重连对账自愈状态机完全处于未激活的死代码状态。

### 1.5 DEF-STO-05：5/8 幽灵表零读写与离线镜像设计断层
- **现场位置**：`apps/crish-mobile/src/db/schema.ts:21-30`、`apps/crish-mobile/src/db/schema.ts:41-136`、`apps/crish-mobile/src/db/dao/`
- **代码切片**：
  ```ts
  // apps/crish-mobile/src/db/schema.ts:21-30
  export const TABLES = [
    'events',            // 0 处读写，无 DAO
    'approval_queue',    // SqlApprovalQueueDao 实现
    'approval_history',  // 0 处读写，无 DAO
    'session_summaries', // 0 处读写，无 DAO
    'settings',          // SqlSettingsDao 实现
    'push_tokens',       // 0 处读写，无 DAO
    'device_info',       // 0 处读写，无 DAO
    'notifications',     // SqlNotificationsDao 实现
  ] as const;
  ```
- **调用链还原**：全仓代码检索证实，`events`、`approval_history`、`session_summaries`、`push_tokens`、`device_info` 仅在 `schema.ts` 的 DDL 声明与 `dbBootstrap.test.ts` 的表名断言中出现，整仓业务逻辑中无任何 SQL 读写或 DAO 类。但对比架构规划文档 `docs/mobile-app-rebuild/02-运行时与连接方案.md`，移动端伴侣应用被明确定义为“基于 WebSocket 的内存流投影订阅模型”（事件由 `eventStore.windows` 内存维护，按需通过 `readSessionEvents` 回填，解绑即清空内存），从未规划在移动端 SQLite 落地全量历史聊天镜像。

### 1.6 DEF-STO-06：DAO 伪 upsert 存在无事务 Check-Then-Act 并发冲突
- **现场位置**：`apps/crish-mobile/src/db/dao/notificationsDao.ts:49-75`、`apps/crish-mobile/src/db/dao/settingsDao.ts:34-50`
- **代码切片**：
  ```ts
  // apps/crish-mobile/src/db/dao/notificationsDao.ts:50-75
  async upsert(row: NotificationRow): Promise<'inserted' | 'updated'> {
    const existing = await this.driver.getFirst<{ id: string }>(
      'SELECT id FROM notifications WHERE id = ?',
      [row.id]
    );
    if (existing !== null) {
      await this.driver.exec(`UPDATE notifications SET ... WHERE id = ?`, [...]);
      return 'updated';
    }
    await this.driver.exec(`INSERT INTO notifications (...) VALUES (...)`, [...]);
    return 'inserted';
  }
  ```
- **调用链还原**：在 WebSocket 实时事件（`events.push`）与系统远程推送（Expo Push Notification）双通道并发到达同一通知时，由于 `upsert` 未包裹在事务中且未使用 SQLite 原生的 `INSERT ... ON CONFLICT DO UPDATE`，两个异步任务在 `await getFirst` 处均返回 `null`，随后同时执行 `INSERT`，后执行者直接抛出 `UNIQUE constraint failed: notifications.id` 原生致命异常，中断通知摄入流程。

### 1.7 DEF-STO-07：SQLite 单连接循环 Prepare 与批量接口缺失
- **现场位置**：`apps/crish-mobile/src/db/db.ts:54-67`、`apps/crish-mobile/src/db/dao/approvalQueueDao.ts:74-95`
- **代码切片**：
  ```ts
  // apps/crish-mobile/src/db/db.ts:60-64
  const statement = await db.prepareAsync(sql);
  try {
    await statement.executeAsync(params as SQLiteBindParams);
  } finally {
    await statement.finalizeAsync(); // 每次执行均重新 prepare 并立即 finalize
  }
  ```
  ```ts
  // apps/crish-mobile/src/db/dao/approvalQueueDao.ts:76-88
  for (const item of items) {
    await this.driver.exec(INSERT_SQL, [...]); // 事务循环逐条 exec
  }
  ```
- **调用链还原**：`SqlApprovalQueueDao.replaceAll` 在事务循环中逐条调用 `driver.exec`，导致每次插入均经历原生 Statement 的编译、绑定执行与销毁。但需指出：Expo SDK 57 (RN 0.86 新架构) 中 `expo-sqlite` 采用 C++ JSI 宿主对象与本地线程池通信，并非旧版 JSON Bridge 跨桥；且正常使用场景下移动端审批队列条目通常 ≤3 项，原报告所述“50 条产生 150 次跨桥调用阻塞主桥”在技术机理上混淆了 JSI 与 Bridge，且量化场景脱离实际。

### 1.8 DEF-STO-08：实时推理 Token 流高频触发 Zustand Immer 更新
- **现场位置**：`apps/crish-mobile/src/adapters/wiring/ingestRouter.ts:27-34`、`apps/crish-mobile/src/domain/store/eventStore.ts:67-70`、`apps/crish-mobile/src/presentation/timeline/useSessionWindow.ts:7-9`、`apps/crish-mobile/src/presentation/screens/sessionDetailScreen.tsx:87-99`
- **代码切片**：
  ```ts
  // apps/crish-mobile/src/presentation/screens/sessionDetailScreen.tsx:63, 87-89
  const window = useSessionWindow(sessionId); // 订阅 windows[sessionId] 引用
  const blocks = useMemo(() => {
    const base = buildSessionTimeline(window.entries); // 每帧遍历并重建时间线数据块
    ...
  }, [window.entries, localPrompts]);
  ```
- **调用链还原**：模型推理流式输出时，增量事件帧经由 `feedBridge` -> `ingestRouter` -> `eventStore.ingest` 逐帧调用 Immer 更新，使 `window.entries` 引用频繁刷新，触发 `SessionDetailScreen` 反复执行 `buildSessionTimeline` 计算。然而全仓基准测试 `performanceBudgets.test.ts:5` 明确记录“渲染帧率需真机工具，不在本文件断言”，全仓零“10~15 fps”掉帧的实测日志或代码证据。

### 1.9 DEF-STO-09：迁移脚本事务内执行 PRAGMA user_version 与降级防御缺失
- **现场位置**：`apps/crish-mobile/src/db/db.ts:25-35`
- **代码切片**：
  ```ts
  // apps/crish-mobile/src/db/db.ts:27-33
  await db.withTransaction(async () => {
    for (const sql of migration.sql) {
      await db.exec(sql);
    }
    await db.exec(`PRAGMA user_version = ${v + 1}`); // 事务内执行 PRAGMA user_version
  });
  return Math.max(current, migrations.length); // 降级无拦截与告警
  ```
- **调用链还原**：SQLite 官方规范明确强调修改元数据模式的 PRAGMA（如 `user_version`）不可在活动事务块中执行，在部分环境可能引发提交后版本落盘失败或死锁。此外，当本地已存在高版本库而安装旧版 APK 时，`Math.max` 静默放行且无任何版本回退防御拦截。

### 1.10 DEF-STO-10：对账补入审批项参数强制置空致界面参数盲区
- **现场位置**：`apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:182-195`、`apps/crish-mobile/src/presentation/components/blocks/ApprovalCard.tsx:104-106, 167-184`
- **代码切片**：
  ```ts
  // apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:186-194
  const request: PermissionRequest = {
    ...
    parameters: {}, // 强制赋予空对象
    summary: pa.summary ?? pa.toolName,
  };
  ```
  ```ts
  // apps/crish-mobile/src/presentation/components/blocks/ApprovalCard.tsx:104-106, 167
  const summary = item.riskMeta?.command
    ? `$ ${maskCommandSecrets(item.riskMeta.command)}`
    : summarizeParameters(item.request.parameters); // 忽略 request.summary！
  {summary ? ( <View style={styles.summaryBox}>...</View> ) : null} // summary 为空直接隐去！
  ```
- **调用链还原**：重连对账通过 `remote.listPendingApprovals` 补入审批项时，虽然服务端下发了 `pa.summary`，但接线层将 `parameters` 硬编码为空对象 `{}`；而 UI 组件 `ApprovalCard` 在无 `riskMeta.command` 时直接提取 `summarizeParameters(parameters)`，由于参数为空得到空字符串，导致整个参数详情框被隐藏，用户被迫在看不到任何参数与意图的情况下进行盲批。

### 1.11 新增遗漏项现场还原（原报告未覆盖的重大隐患）
- **OMIT-01：解绑与换机未清理 SQLite `approval_queue` 导致历史决策越权泄漏**
  - **位置**：`apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:583-589`、`apps/crish-mobile/src/db/dao/approvalQueueDao.ts:51-53`
  - **代码切片**：
    ```ts
    // apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:583-589
    export function disposeApprovalWiring(): void {
      singleton?.bridge.detach();
      singleton = null;
      clearPendingOpenRegistration();
      outboxState = createOutboxState(); // 致命疏漏：仅重置内存态，从未调用 approvalQueueDao.clear()！
    }
    ```
  - **影响**：用户解绑当前桌面后，SQLite 中的待发离线决策依旧落盘残留。若该手机随后配对至另一台桌面电脑，冷启动时 `singleton.bridge.hydrate()` 将旧桌面的审批决策回填并发送给新桌面，导致跨环境越权执行。
- **OMIT-02：`clearSessionData()` 漏复位 `connectionStore` 与 `notificationStore`**
  - **位置**：`apps/crish-mobile/src/adapters/runtime/appRuntime.ts:28-34`
  - **代码切片**：
    ```ts
    // apps/crish-mobile/src/adapters/runtime/appRuntime.ts:28-34
    function clearSessionData(): void {
      eventStore.getState().reset();
      sessionStore.getState().reset();
      approvalStore.getState().reset();
      terminalStore.getState().clearAll();
      filesStore.getState().resetWorkspace(null);
      // 致命遗漏：漏掉了 connectionStore.getState().reset() 与 notificationStore 清理！
    }
    ```
  - **影响**：解绑后 `connectionStore` 仍保留上一次连接的 endpoint、最后同步时间与错误信息，导致未配对状态下显示错误的连接诊断信息。
- **OMIT-03：`observationWiring` 的 `openListeners` 未随 `dispose` 清除造成回调悬挂**
  - **位置**：`apps/crish-mobile/src/adapters/wiring/observationWiring.ts:134-142, 193-200`
  - **代码切片**：
    ```ts
    // apps/crish-mobile/src/adapters/wiring/observationWiring.ts:134, 193-200
    const openListeners = new Set<() => void>(); // 模块级持久 Set
    export function disposeObservationWiring(): void {
      ...
      singleton = null;
      // 致命遗漏：openListeners.clear() 从未被调用！
    }
    ```
  - **影响**：在网络频繁重连或重新配对重构单例时，`openListeners` 集合内的闭包持续累积悬挂，引发内存泄漏与旧会话回调误触发。
## 2 问题清单

| 编号 | 位置 | 现象 | 直接原因 | 根因 | 影响 | 置信度 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **DEF-STO-01** | `approvalWiring.ts:545`<br>`persistBootstrap.ts:69` | 已配对冷启动若 DB 打开慢，审批 Outbox 单例降级为内存态 | `getSqlDriver()` 在启动瞬间返回 `null`，初始化后单例零更新机制 | 异步任务缺少显式依赖排序，领域持久化与审批单例生命周期解耦不彻底 | 若离线操作且在网络恢复前进程被系统强杀，审批决策丢失 | **已验证**（部分成立，时序前提已复核） |
| **DEF-STO-02** | `accountService.ts:162`<br>`app/_layout.tsx:88` | Android 遇到 Keystore 损坏或权限异常时冷启动永久卡死在开屏菊花 | `loadAccountSession(driver)` 位于 `try` 块外，抛错导致 `setHydrated(true)` 跳过 | 账号水合逻辑错误地将存储读取放在错误捕获范围外，首屏守卫严格阻断 | 用户完全无法进入应用，无法退出或重置，应用彻底瘫痪 | **已验证**（完全成立） |
| **DEF-STO-03** | `feedBridge.ts:143`<br>`event-ring-window.ts:75` | 收到乱序推送事件后，后续补洞历史帧被全部静默丢弃 | 乱序高帧立即同步分发推进 `lastSeq`，补洞帧命中 `seq <= lastSeq` 判定 | 空洞探测未设置暂存缓冲区（Stash Buffer），自愈算法存在时序倒挂缺陷 | 弱网断网恢复后会话时间线永久缺失关键内容（如工具输出、代码块） | **已验证**（完全成立） |
| **DEF-STO-04** | `observationWiring.ts:88`<br>`ReconnectingWsClient.ts:541` | 重连对账投影计算恒为空数组，对账状态机完全停摆 | 构造 `ReconnectingWsClient` 时漏传 `projections` 工厂参数 | 接线装配层参数缺失，未遵循立体验证闭环自查 | 重连后无法自动回放或自愈失步的会话增量事件，重连状态机形同虚设 | **已验证**（完全成立） |
| **DEF-STO-05** | `schema.ts:21-30`<br>`schema.ts:41-136` | 数据库白白创建维护 5 张幽灵表，业务零读写 | 仅有 DDL 定义，无任何 DAO 实现与 SQL 调用 | 早期过度规划残留的死 schema，与现行内存流投影伴侣架构脱节 | 浪费存储和冷启动 DDL 迁移耗时；原报告建议补写 DAO 属于过度设计 | **已验证**（部分成立，定性纠偏） |
| **DEF-STO-06** | `notificationsDao.ts:50`<br>`settingsDao.ts:35` | 推送与 WS 双通道并发通知写入时触发唯一约束冲突异常崩溃 | `upsert` 使用 Check-Then-Act 且无事务保护，并发下同时查空并同时执行 INSERT | 未使用 SQLite 原生 `ON CONFLICT` 原子语句，单测 MemoryDriver 倒逼业务妥协 | 通知通道管道异常中断，控制台冒泡严重未捕获异常 | **已验证**（完全成立） |
| **DEF-STO-07** | `db.ts:61`<br>`approvalQueueDao.ts:76` | 批量保存审批队列时逐条 Statement 编译、执行与释放 | 每次带参执行均创建单次 `prepareAsync`，无语句复用与批处理接口 | 驱动层设计简陋，缺少批量与预编译缓存接口 | 批量写入存在性能开销；但原报告称“150次跨桥阻塞主桥”与 JSI 原理不符 | **已验证**（缺陷存在，严重度夸大） |
| **DEF-STO-08** | `ingestRouter.ts:30`<br>`sessionDetailScreen.tsx:88` | 高频推理增量帧涌入时触发频繁 Zustand 更新与时间线重构计算 | 逐帧触发 `eventStore.ingest`，`useSessionWindow` 引用刷新致组件密集 re-render | 缺少基于微任务或 RAF 的帧缓冲合并防抖调度器 | JS 线程计算密集可能导致交互迟滞；但原报告“掉帧至 10~15 fps”缺乏证据 | **已验证**（缺陷存在，数据夸大） |
| **DEF-STO-09** | `db.ts:31`<br>`db.ts:34` | 迁移在活动事务内执行 `PRAGMA user_version` 且无版本降级防御 | 事务内写入元数据配置 PRAGMA，`Math.max` 对高版本库静默放行 | 违背 SQLite 官方事务内 PRAGMA 规范，缺版本回退安全守卫 | 在特定平台可能导致版本未持久化或死锁；降级安装可能导致结构不匹配 | **已验证**（完全成立） |
| **DEF-STO-10** | `approvalWiring.ts:192`<br>`ApprovalCard.tsx:106` | 对账补入的待批卡片在 UI 上完全隐藏命令行和参数细节 | `mapReconcileApprovalItem` 参数置空 `{}`，且 `ApprovalCard` 仅查参数忽略 summary | 接线层丢弃参数，UI 组件未做 `request.summary` 兜底展示 | 重连对账后的审批项呈现为参数盲区，用户无法确认执行意图，存在盲批风险 | **已验证**（完全成立） |
| **OMIT-01** | `approvalWiring.ts:587`<br>`approvalQueueDao.ts:51` | 解绑换机后残留离线审批决策被新配对桌面回填并执行 | `disposeApprovalWiring` 仅重置内存 `outboxState`，从未调用 `approvalQueueDao.clear()` | 跨会话数据隔离考虑不周，存储清理未穿透落盘真源 | 严重安全漏洞，手机解绑后重新配对新电脑会误发旧电脑的审批决策 | **已验证**（新增遗漏项，P0 高危） |
| **OMIT-02** | `appRuntime.ts:28-34` | 解绑后 `connectionStore` 仍保留旧主机的连接状态与同步时间 | `clearSessionData()` 漏掉了 `connectionStore.getState().reset()` 与通知复位 | 状态机复位范围未做完整覆盖审计，模块各管一段 | 解绑进入配对页后，连接状态机诊断数据残留假阳性 | **已验证**（新增遗漏项，P2 次要） |
| **OMIT-03** | `observationWiring.ts:134, 193` | 多次重连或单例重建时监听回调在 Set 中持续悬挂累积 | `disposeObservationWiring` 未调用 `openListeners.clear()` | 全局事件监听器生命周期与单例生命周期未绑定释放 | 造成内存泄漏，且可能在新会话触发旧连接已注销的回调 | **已验证**（新增遗漏项，P2 次要） |
## 3 逐条判定表与遗漏扫描

### 3.1 被复核报告逐条判定表

#### DEF-STO-01：DB 初始化竞态导致 Outbox 永久降级内存态，离线审批决策 100% 丢失
- **判定结果**：⚠️ **部分成立**（缺陷本身与竞态成立，但“100% 丢失”与“全路径发生”严重夸大）。
- **被引用位置与行号复核**：`dbBootstrap.ts:60`（当前工作区 58-60 行）、`approvalWiring.ts:545`（完全吻合）、`_layout.tsx:60-66`（完全吻合），行号无漂移。
- **调用链核查结果**：
  1. 竞态成立的前提条件：设备处于**已配对状态冷启动**，且 `ensurePairingWiringForApp()` 恢复配对态的速度**快于** `ensureDatabaseForApp()` 打开并迁移 SQLite 的速度。
  2. 若设备处于未配对状态冷启动，`authStore.pairState` 初始为 `unpaired`，不会调用 `ensureApprovalWiring()`；用户随后手动扫码配对时，DB 早在数秒甚至数分钟前已完成初始化，`getSqlDriver()` 必然非空，Outbox 会正常绑定 SQLite。
  3. “100% 丢失”夸大了损失场景：即便降级为内存态，只要在手机锁屏或进程被强杀前重新连上桌面，内存 Outbox 依然会将决策正常发往桌面；唯有在“离线决策 -> 未连上 -> 遭遇 LMK 杀进程”这一特定组合路径下才会丢失。
- **修订后的准确表述**：在已配对设备冷启动路径上，由于数据库初始化与审批接线缺乏显式异步时序依赖，当配对接线早于 DB 就绪时，审批 Outbox 永久降级至内存态。若在此期间离线批复且进程被强杀，该批离线决策将永久丢失。
- **修复方案评价**：原报告建议在 `approvalWiring.ts` 增设动态热升级接口并在 `persistBootstrap.ts` 触发，属于典型的打补丁与跨模块反向耦合（违反 U5“反补丁式改进”）。**更优方案**：在根布局或运行时入口通过 Promise 依赖，将 DB 驱动显式作为运行时启动的前置依赖，或使 `ensureApprovalWiring` 在驱动未就绪时挂起等待，从根本上杜绝降级分支。

#### DEF-STO-02：`hydrateAccount()` 未捕获 SecureStore 异常致冷启动无限死锁
- **判定结果**：✅ **成立**（逻辑链路确凿，危害严重且致命）。
- **被引用位置与行号复核**：`accountService.ts:162`（第 162 行，完全吻合）、`app/_layout.tsx:88`（完全吻合）。原报告在引用 `accountRuntime.ts` 行号时存在标注笔误（引用了 81-86 行，但在正文中写作 322 行，不影响本质调用点）。
- **调用链核查结果**：
  1. `accountService.ts:162` 的 `const session = await loadAccountSession(driver);` 明确位于 `try` 块（第 170 行）之前。
  2. 第 209-211 行的 `finally { accountStore.getState().setHydrated(true); }` 仅能捕获第 170 行以后的执行。第 162 行若抛出异常，整个函数直接返回 Rejected Promise。
  3. 调用点 `accountRuntime.ts:84` 为 `void hydrateAccount().finally(syncRemote);`，未捕获异常。`accountStore.hydrated` 永久为 `false`。
  4. 根布局 `app/_layout.tsx:88` 严格断言 `if (!hydrated || !accountHydrated) return <Spinner />;`，导致应用永久停留在 Splash 页面。
  5. 触发前提核实：虽“所有未设密码的 Android 手机必抛异常”表述过宽（取决于厂商 Keystore 行为），但只要发生任何底层加解密错误（如系统签名变动、Keystore 损坏、备份恢复），死锁 100% 触发。
- **修订后的准确表述**：`hydrateAccount()` 在执行底层 SecureStore 读取时未将其包裹在 `try` 块内，底层加解密或硬件 Keystore 发生任何未捕获异常均会导致 `accountStore.hydrated` 无法置位，触发首屏无限 Loading 死锁。
- **修复方案评价**：原报告建议将 `loadAccountSession` 移入 `try` 块并确保在 `catch` 后兜底置位 `setHydrated(true)`，方案合理合规，符合 U6 彻底根治原则。

#### DEF-STO-03：序列空洞探测过早推进游标致补洞数据批量被弃
- **判定结果**：✅ **成立**（时序推演与代码逻辑 100% 闭环，定性极精准）。
- **被引用位置与行号复核**：`feedBridge.ts:141-149`（完全吻合）、`event-ring-window.ts:75-82`（完全吻合）、`event-ring-window.ts:126-138`（完全吻合）。
- **调用链核查结果**：
  1. 游标为 100，收到帧 105。`feedBridge.ts:143` 触发异步补洞 `resumeSession(sessionId, 100)`。
  2. 第 149 行未拦截 105，立即调用 `applyActions` 将 105 喂给 `eventStore.ingest` -> `appendFeed`。
  3. `appendFeed` 将 105 写入，并将 `window.lastSeq` 强行改写为 105。
  4. 补洞分页帧 101~104 返回，走 `handleResumePage` -> `hydrateFeed` -> 逐条调用 `appendFeed`。
  5. 补洞帧在 `appendFeed` 处遇到 `if (seq <= window.lastSeq)`（101 <= 105），全部作为 `duplicate` 静默丢弃，补洞数据 100% 丢失。
- **修订后的准确表述**：与原报告表述一致。
- **修复方案评价**：原报告提出的待排队缓冲区（Stash Buffer）方案合理，当检测到序号空洞时，应将高序号乱序帧暂存，等待连续帧补齐后再按序提交推进游标。

#### DEF-STO-04：`observationWiring` 漏传 `projections` 导致对账停摆
- **判定结果**：✅ **成立**（确凿无误，与 R02 互相印证）。
- **被引用位置与行号复核**：`observationWiring.ts:88-105`（完全吻合）、`ReconnectingWsClient.ts:540-552`（完全吻合）。
- **调用链核查结果**：`observationWiring.ts` 在创建 `ReconnectingWsClient` 时确实漏传了 `projections` 工厂参数。导致重连时 `driveProjection()` 内部的 `this.opts.projections?.()` 缺省返回空快照，`projectReconnect` 产出的增量与全量对账动作恒为空数组，整个重连投影状态机在生产环境下成为零运转的死代码。
- **修订后的准确表述**：与原报告表述一致。
- **修复方案评价**：原报告给出装配 `projections` 工厂函数的代码完全正确，属于架构设计完整但组装接线遗漏的典型低级失误，一处补齐即可根治。

#### DEF-STO-05：5/8 幽灵表零读写与离线镜像设计断层
- **判定结果**：⚠️ **部分成立**（幽灵表零读写事实成立，但原报告定性与修复方案违背反过度设计原则）。
- **被引用位置与行号复核**：`schema.ts:21-30`（完全吻合）、`schema.ts:41-136`（完全吻合）。
- **调用链核查结果**：全仓无任何 `EventsDao`、`SessionSummariesDao`、`ApprovalHistoryDao`，也无任何对这些表的 SQL 语句。但查阅设计方案 `docs/mobile-app-rebuild/02-运行时与连接方案.md`，Crish 移动端伴侣应用被定义为轻量级远程投影视图，聊天流与会话列表设计为通过 WebSocket 订阅动态加载至内存（`eventStore.windows`），解绑即清空内存。
- **修订后的准确表述**：数据库中定义的 8 张表中，有 5 张表（`events`、`session_summaries`、`approval_history`、`push_tokens`、`device_info`）在业务代码中完全没有读写，属于早期方案遗留的死 DDL。
- **修复方案评价**：**严重纠偏原报告建议**！原报告要求“补全 5 张表的 DAO，将聊天记录和会话落盘”属于典型的过度设计（违反 U3 与根目录 `ANTI_OVERENGINEERING_GUARDRAILS.md`），不仅增加大量死代码和维护成本，更拖慢启动速度并违背轻量伴侣定位。**正确治理动作应为彻底删除这 5 张无用表及相关索引**，仅保留实际生效的 `approval_queue`、`settings`、`notifications` 3 张表。
#### DEF-STO-06：DAO 伪 upsert 存在无事务竞态，并发写入冲突崩溃
- **判定结果**：✅ **成立**（确凿无误，架构反模式）。
- **被引用位置与行号复核**：`notificationsDao.ts:50-75`（完全吻合）、`settingsDao.ts:35-50`（完全吻合）。
- **调用链核查结果**：`upsert` 采用 Check-Then-Act 模式，无事务保护。在系统推送与 WebSocket 实时帧并发到达时，两个异步调用同时查空并同时发起 `INSERT`，触发 `UNIQUE constraint failed: notifications.id` 异常。根因是开发者为了照顾不支持 `ON CONFLICT` 的测试假驱动 `MemorySqlDriver` 而在生产代码中开了退避口子。
- **修订后的准确表述**：与原报告表述一致。
- **修复方案评价**：原报告建议采用 SQLite 原生的 `INSERT ... ON CONFLICT(id) DO UPDATE SET ...` 语句，并在假驱动中予以适配，方案正本清源，符合规范。

#### DEF-STO-07：SQLite 单连接循环 Prepare 阻塞主桥
- **判定结果**：❌ **夸大**（设计缺乏批量优化成立，但“150 次跨桥阻塞主桥”严重夸大且原理定性有误）。
- **被引用位置与行号复核**：`db.ts:60-64`（完全吻合）、`approvalQueueDao.ts:76-88`（完全吻合）。
- **调用链核查结果**：
  1. `SqlApprovalQueueDao.replaceAll` 在循环中反复调用 `prepareAsync` -> `executeAsync` -> `finalizeAsync`，确实产生 3N 次原生调用，缺乏语句预编译缓存与批量接口。
  2. 但在 Expo SDK 57 / React Native 0.86 新架构下，`expo-sqlite` 采用 C++ JSI（JavaScript Interface）直接调用，在本地线程池中异步调度，**并不走传统的异步 JSON 跨桥序列化通信（Bridge）**，原报告所谓“150 次跨桥阻塞主桥”属于对现代 React Native 架构机理的误判。
  3. 此外，正常移动伴侣使用中 Outbox 待发决策通常只有 0~3 条，50 条为脱水臆造场景，实际性能损耗微乎其微。
- **修订后的准确表述**：`SqlDriver` 缺乏预编译语句缓存与批量执行接口，导致 `SqlApprovalQueueDao.replaceAll` 在事务循环内逐条编译并销毁 Statement，存在不必要的性能损耗。
- **修复方案评价**：引入 `execBatch` 接口与单次预编译多次绑定执行属于合理的局部性能优化。

#### DEF-STO-08：实时推理 Token 流未节流，逐帧触发 Zustand Immer 深更新
- **判定结果**：❌ **夸大**（高频触发重渲染架构事实成立，但“掉帧至 10~15 fps”属于无证据的主观量化夸大）。
- **被引用位置与行号复核**：`ingestRouter.ts:30`、`eventStore.ts:67`、`useSessionWindow.ts:8`、`sessionDetailScreen.tsx:88`，完全吻合。
- **调用链核查结果**：增量预览帧确未做防抖节流，每次调用 `eventStore.ingest` 均触发 Immer 生成新的 `windows[sessionId]` 引用，进而驱动 `sessionDetailScreen.tsx` 的 `useMemo` 重新运行 `buildSessionTimeline`。但全仓没有任何实测数据支持“掉帧至个位数 10~15 fps”的量化结论，基准测试文件 `performanceBudgets.test.ts:5` 明确声明“渲染帧率需真机测量工具，不在本文件断言”。
- **修订后的准确表述**：增量预览帧缺乏微任务或帧级防抖批处理机制，高频推理时逐帧触发 Immer 状态更新与组件时间线重构计算，存在 JS 线程密集计算卡顿风险。
- **修复方案评价**：原报告建议的微任务或 RAF 防抖批处理器（`IngestBatcher`）方向正确，但需注意防抖不得延迟关键决策事件。

#### DEF-STO-09：迁移脚本事务内执行 PRAGMA user_version 与降级防御缺失
- **判定结果**：✅ **成立**（确凿无误，违背 SQLite 规范）。
- **被引用位置与行号复核**：`db.ts:25-33`（完全吻合）。
- **调用链核查结果**：在 `db.withTransaction` 内部直接调用 `PRAGMA user_version = ${v + 1}`，SQLite 官方明确指出修改元数据配置的 PRAGMA 不保证在事务内原子回滚，且部分 SQLite 运行时在事务内执行 PRAGMA 会被静默忽略。此外，`Math.max` 对版本回退直接放行，缺少安全防护。
- **修订后的准确表述**：与原报告表述一致。
- **修复方案评价**：将 `PRAGMA user_version` 移至事务提交之后执行，并在检测到高版本数据库时发出告警，方案完全合理。

#### DEF-STO-10：对账补入审批项参数强制置空致界面参数盲区
- **判定结果**：✅ **成立**（确凿无误，前端呈现严重盲批安全隐患）。
- **被引用位置与行号复核**：`approvalWiring.ts:186-194`（完全吻合）、`ApprovalCard.tsx:104-106, 167-184`（完全吻合）。
- **调用链核查结果**：`mapReconcileApprovalItem` 强制将 `parameters` 赋值为空对象 `{}`，而前端 `ApprovalCard.tsx` 只读取 `parameters` 与 `riskMeta.command`，忽略了服务端传回的 `pa.summary`，导致界面计算出的 `summary` 为空串并隐藏参数展示框，用户重连后打开待办只能看到工具名而看不到命令行或入参。
- **修订后的准确表述**：与原报告表述一致。
- **修复方案评价**：在 `ApprovalCard.tsx` 中增加对 `request.summary` 的兜底展示，方案合规优雅，能彻底消除盲批隐患。

#### 综合健康度评分（45/100 与“严禁上线”）复核
- **判定结果**：❌ **夸大**（主观臆断，缺乏客观计算模型与复算口径）。
- **核查证据**：原报告全文未提供任何评分扣分明细与复算模型。所列 4 个 P0 缺陷中，DEF-STO-01 仅在特定极短冷启动时序下发生，DEF-STO-04 属简单参数漏传，DEF-STO-02 属于漏加 try-catch。原报告将其定性为“45 分严禁直接上线发版”，带有明显的主观夸大成分，脱离了移动端伴侣应用的实际使用场景。

---

### 3.2 判定汇总表与可信度总评

| 类别 | 数量 | 缺陷编号清单 |
| :--- | :--- | :--- |
| **✅ 成立** | **5** | DEF-STO-02, DEF-STO-03, DEF-STO-04, DEF-STO-06, DEF-STO-10 |
| **⚠️ 部分成立** | **2** | DEF-STO-01（时序前提存在，但非全路径 100% 丢失）, DEF-STO-05（幽灵表现象属实，但定性与修复方案违背反过度设计） |
| **❌ 夸大** | **3** | DEF-STO-07（150次跨桥与机理误判）, DEF-STO-08（10~15fps 无证据）, 综合评分（45/100 缺乏复算口径） |
| **🚫 不成立** | **0** | 无（所有缺陷现象代码现场均存在） |
| **❓ 无法验证** | **0** | 无（全部通过源码与调用链静态穷举验证） |

> **可信度一句话总评**：  
> **该报告逻辑穿透力极强，准确锁定了 3 处致命级并发时序断层（自愈倒挂、死锁、投影漏接），具备极高的技术参考价值；但在影响面量化与评级定调上存在对抗性夸大，其幽灵表补齐建议严重违背反过度设计红线，必须予以纠偏。**
### 3.3 遗漏扫描与新发现问题

#### 1. 扫描范围与被复核报告覆盖情况清单

| 模块目录 | 核心文件清单 | 被复核报告覆盖情况 | 复核补充说明 |
| :--- | :--- | :--- | :--- |
| `src/db/` | `schema.ts`, `db.ts`, `dbBootstrap.ts`, `secureStore.ts`, `driver.ts`, `migrations.ts` | 已覆盖 `schema`, `db.ts`, `dbBootstrap.ts`, `secureStore.ts` | 覆盖较完整，但漏查了解绑时 SQLite 表清理断层 |
| `src/db/dao/` | `approvalQueueDao.ts`, `notificationsDao.ts`, `settingsDao.ts` | 全部覆盖 | 正确指出 Check-Then-Act 与缺乏预编译 |
| `src/domain/store/` | `accountStore.ts`, `approvalStore.ts`, `authStore.ts`, `connectionStore.ts`, `eventStore.ts`, `filesStore.ts`, `notificationStore.ts`, `sessionStore.ts`, `settingsStore.ts`, `terminalStore.ts` | 覆盖了 `accountStore`, `approvalStore`, `eventStore`, `notificationStore`, `settingsStore` | **遗漏覆盖** `connectionStore` 与 `terminalStore` 的生命周期复位完整性 |
| `src/adapters/wiring/` | `approvalWiring.ts`, `feedBridge.ts`, `ingestRouter.ts`, `observationWiring.ts`, `pairing/*` | 覆盖了 `approvalWiring`, `feedBridge`, `ingestRouter`, `observationWiring` | **遗漏覆盖** `observationWiring.openListeners` 闭包悬挂泄漏 |
| `src/adapters/repositories/` | `monitorRepository.ts` | 零覆盖 | 作为事件拉取底层，未做并发调用保护审计 |
| `src/adapters/account/` | `accountService.ts`, `accountApi.ts`, `accountFlow.ts` | 仅覆盖 `hydrateAccount` | 漏查 `logoutAccount` 与本地数据清空隔离性 |
| `packages/shared-utils/` | `event-ring-window.ts` | 深度覆盖 | 准确挖掘出 `lastSeq` 倒挂丢包逻辑 |

#### 2. 新增遗漏项深度审计（同等质量证据）

##### OMIT-01：解绑换机未清理 SQLite `approval_queue` 导致历史决策越权泄漏（P0 高危安全漏洞）
- **代码断层位置**：`apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:583-589`
- **代码切片**：
  ```ts
  // apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:582-589
  /** 解绑 / 换机：销毁审批接线单例 */
  export function disposeApprovalWiring(): void {
    singleton?.bridge.detach();
    singleton = null;
    clearPendingOpenRegistration();
    outboxState = createOutboxState(); // 仅清空了内存数组！
    // 缺失：从未调用 approvalQueueDao.clear()！
  }
  ```
- **危害剖析**：
  1. `SqlApprovalQueueDao` 提供了标准的 `clear(): Promise<void>` 接口用于整表清空。
  2. 但在解绑或换机时，`disposeApprovalWiring()` 仅仅复位了 JS 堆内存中的 `outboxState`。
  3. SQLite 数据表 `approval_queue` 中的未决或离线待发条目**原封不动残留在本地数据库中**。
  4. 当用户将这台手机重新配对至新的桌面端（或同事的电脑）后，冷启动 `ensureApprovalWiring()` 会执行 `singleton.bridge.hydrate()`，将前一台电脑的离线决策从 SQLite 读出，并在新连接就绪后自动打包发送给新桌面端！
  5. 造成极其严重的跨主机越权审批与指令误执行安全事故。

##### OMIT-02：`clearSessionData()` 漏复位 `connectionStore` 与 `notificationStore`（P2 次要）
- **代码断层位置**：`apps/crish-mobile/src/adapters/runtime/appRuntime.ts:28-35`
- **代码切片**：
  ```ts
  // apps/crish-mobile/src/adapters/runtime/appRuntime.ts:28-35
  function clearSessionData(): void {
    eventStore.getState().reset();
    sessionStore.getState().reset();
    approvalStore.getState().reset();
    terminalStore.getState().clearAll();
    filesStore.getState().resetWorkspace(null);
    // 遗漏：connectionStore.getState().reset() 与 notificationStore 清理
  }
  ```
- **危害剖析**：在解绑或换机后，`connectionStore` 依然保留原桌面的 `selectedEndpoint`、`lastError` 与 `lastSyncAt` 状态，`notificationStore` 依然保留历史应用内通知。退回配对引导页后，UI 连接诊断仍呈现前一会话的脏数据。

##### OMIT-03：`observationWiring` 的 `openListeners` 未随 `dispose` 销毁造成悬挂泄漏（P2 次要）
- **代码断层位置**：`apps/crish-mobile/src/adapters/wiring/observationWiring.ts:134, 193-200`
- **代码切片**：
  ```ts
  // apps/crish-mobile/src/adapters/wiring/observationWiring.ts:134, 193-200
  const openListeners = new Set<() => void>();
  export function disposeObservationWiring(): void {
    singleton?.client.disconnect();
    singleton?.bridge.detach();
    singleton?.terminal.detach();
    singleton?.push.detach();
    singleton?.dispose();
    singleton = null;
    // 遗漏：openListeners.clear()
  }
  ```
- **危害剖析**：模块级持久变量 `openListeners` 在每次 `ensureApprovalWiring` 挂起时都会通过 `onObservationOpen` 注册。当单例被销毁重建时，旧的匿名回调未被清理，随运行时间推移形成内存泄漏与幽灵回调触发。
## 4 风险与未决问题（需用户裁决事项）

以下问题涉及架构定位、规范取舍与性能平衡，需由主 Agent 报请用户明确裁决：

| 裁决项编号 | 决策议题 | 方案选项 A（推荐） | 方案选项 B（备选） | 依据与影响权衡 |
| :--- | :--- | :--- | :--- | :--- |
| **DEC-01** | **5 张幽灵表的治理路线** | **彻底删除 5 张无用表**（`events`, `session_summaries`, `approval_history`, `push_tokens`, `device_info`）及索引，仅保留 3 张生效表。 | 按照被复核报告建议，为 5 张表全部补写 DAO，在移动端实现全量事件与会话落盘镜像。 | **推荐 A**。符合用户规则 U2（该删就删）与 U3（反过度设计），移动伴侣应用定位为实时轻量流投影，建全量本地镜像增加存储、增加 DDL 耗时且违背现状架构。 |
| **DEC-02** | **DB 与运行时冷启动时序架构** | **顶层显式依赖门禁**：在 `app/_layout.tsx` 中将数据库初始化作为前置异步门禁，确保 DB 就绪后再挂载运行时。 | **运行时内部热升级**：保持并行启动，在 `approvalWiring` 中实现 `upgradePersistAdapter` 热替换接口。 | **推荐 A**。彻底根除初始化竞态（符合 U5 反补丁原则），消除单例降级分支，避免跨模块回调补丁；DB 打开通常 ≤50ms，不影响首屏体验。 |
| **DEC-03** | **高频 Token 推理流节流层级** | **接线数据面 RAF 帧合并**：在 `ingestRouter` 引入 `IngestBatcher`，将预览帧合并在单一 `requestAnimationFrame`（≤60fps）分发。 | **UI 表现面防抖重构**：保持数据面逐帧更新，在 `sessionDetailScreen` 使用 React 19 `useDeferredValue` 或节流 `buildSessionTimeline`。 | **推荐 A**。从源头减少 Zustand Immer 深拷贝开销，降低 JS 线程负载；同时设置白名单，对 `approval-requested` 等关键非预览帧实时放行。 |

---

## 5 集中验收清单（改完代码后统一执行的断言）

本清单遵循用户规则 U7（集中验收原则），在后续代码方案落地后统一执行，严禁打补丁式单点测试：

### 5.1 自动化测试断言集（集中运行）
1. **DB 竞态与 Outbox 持久化真源验证**：
   - 编写并发时序单测：模拟已配对冷启动，断言 `ensureApprovalWiring()` 在任何时序下均成功绑定 `SqliteOutboxAdapter`，决不降级为 `MemoryOutboxAdapter`。
   - 模拟离线审批入队，断言 SQLite `approval_queue` 物理表中存在该记录。
2. **SecureStore 异常兜底与防死锁断言**：
   - Mock `SecureStore.getItemAsync` 抛出 `DecryptException` 或原生加解密异常，调用 `hydrateAccount()`；
   - 断言函数不抛出未捕获异常，`accountStore.hydrated` 必定为 `true`，`accountStore.status` 正确置为 `loggedOut`。
3. **序列空洞有序自愈断言**：
   - 构造乱序用例：当前游标 100，灌入事件 105；
   - 断言 105 帧暂存于待排队缓冲区，`eventStore.windows.lastSeq` 保持 100 不跳高；
   - 灌入补洞分页 101~104，断言 101~104 与 105 按严格升序入库，无任何帧被判定为 `duplicate`。
4. **重连投影工厂注入断言**：
   - 验证 `observationWiring.ts` 中的 `ReconnectingWsClient` 配置包含了 `projections` 函数，当模拟重连 `open` 相位时，上抛的 `ReconnectProjection` 正确包含各会话游标与 `resume` 动作。
5. **DAO 原子 ON CONFLICT 验证**：
   - 模拟两个并发 Promise 同时对相同 id 调用 `SqlNotificationsDao.upsert`；
   - 断言并发执行零抛错，最终数据成功更新，无 `UNIQUE constraint failed` 异常。
6. **对账审批参数展示兜底断言**：
   - 传入 `parameters: {}` 但 `summary: "npm test"` 的审批项；
   - 断言 `ApprovalCard` 正确渲染该 summary 文案，参数展示区域不折叠隐去。
7. **解绑清理穿透落盘真源断言**：
   - 模拟解绑流程，断言 `approval_queue` 物理表被清空，`connectionStore` 与 `notificationStore` 均完成复位。

### 5.2 华为 P50（Android 12）真机现场验收项
1. **冷启动与白屏防线**：在真机上清除应用凭据或故意模拟未授权状态，冷启动 App，断言绝对不发生无限 Loading 菊花死锁，正常进入配对或登录引导页。
2. **断网离线审批决策抗强杀**：
   - 真机开启飞行模式，在审批卡片点击“允许”；
   - 执行 `am force-stop com.crish.mobile` 强杀进程；
   - 重新打开应用，关闭飞行模式，断言应用连接桌面后自动补发离线审批，桌面端正常收到决策。
3. **高频推理长文本跟手性**：
   - 触发桌面 Agent 生成长文本或密集工具调用；
   - 在手机详情页滑动列表并弹出键盘，肉眼观察界面无明显掉帧与手势迟滞，输入框响应跟手。
