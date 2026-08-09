# MOBILE-01 移动端架构评审（apps/crish-mobile）

- 评审角色：M1（移动端应用架构，只读）
- 评审日期：2026-08-09
- 评审对象：`apps/crish-mobile`（Expo SDK 57 / React Native 0.86.2 / React 19.2.3 / zustand 5 / expo-sqlite），共 41 个源码文件
- 方法：全部 `src/` 源码通读 + package.json/app.json/tsconfig.json + 与桌面端（crates/conex-db、agent-workbench）交叉核对 + git 状态核对
- 关联文档：安全面详见 `MOBILE-02-security.md`（本文档不重复安全细节，仅在涉及架构处交叉引用）
- 结论先行：**该应用是"UI 完整、链路占位"的交互原型——配对、事件流、命令下发、推送、failover 的全部传输面均无真实对端与真实实现；本地数据层存在首次启动即崩溃的逻辑缺陷；多个服务层是未被任何代码引用的死代码；整个目录尚未入库。架构骨架（导航/zustand/repo 分层）方向合理，但离"可运行的移动伴侣"还差一条真实的链路与一次工程收口。**

---

## 1. 应用骨架与导航

### 1.1 导航结构

- 三层导航：`App.tsx` → `RootNavigator`（原生 Stack：Boot / Login / AppDrawer，`src/navigation/RootNavigator.tsx:14-18`）→ `DrawerNavigator`（11 个 Drawer 屏，`src/navigation/DrawerNavigator.tsx:22-110`）。
- `DrawerNavigator.tsx:3` 导入 `NavigationContainer` 但**未使用**（RootNavigator 已提供容器）；`DrawerNavigator.tsx:23` 顶层 `Drawer.Navigator` 未设置 `initialRouteName` 以外的深层状态——无任何深层链接/初始路由还原逻辑。
- 6 个屏通过 `drawerItemStyle: { display: 'none' }` 隐藏于抽屉列表（GlobalSearch/DevicePairing/AgentChat/MacroBuilder/AuditLogs，`DrawerNavigator.tsx:86-109`），仅靠 `navigation.navigate()` 跳转。
- **未注册的死屏**：`src/screens/Dashboard.tsx`、`Settings.tsx`、`ChatStream.tsx`、`ApprovalCenter.tsx` 四个旧版屏未被任何导航器引用（grep 验证），风格与主题 tokens 完全脱节（硬编码 hex 色，如 `Dashboard.tsx:57` `#f9fafb`），是遗留死代码。

### 1.2 状态管理（zustand）

- 单 store：`src/store/index.ts:58-103`，`ConexState`（连接态/任务/审批/日志/偏好）+ `ConexActions`。**无 persist 中间件**——登录态、serverAddress、偏好全部进程内，重启即失（可接受原型定位，但"记住上次端点"是配对场景的基本需求）。
- 生命周期：
  - `logout()`（`store/index.ts:62`）只复位内存态，**不拆除 WebSocket 传输、不清理 SQLite、不清 tasks**；且调用处（`CustomDrawerContent.tsx:96-99`）只 `closeDrawer()` 不跳回 Login——登出后仍停留在受保护界面，事件继续流入 store（详见 §4.2）。
  - `addLog` 截断 100 条（`store/index.ts:99`）防内存膨胀，方向正确。
- 数据模型双份：store 的 `AgentTask`（`store/index.ts:5-11`）与 DB 的 `DBTask`（`db/schema.ts:86-95`）字段几乎重复但无映射层，未来必然漂移（现已有漂移先例，见 §4.3）。

### 1.3 Boot 流程

- `App.tsx:12-15`：`useEffect` 里同步调 `initDatabase()`，**无 try/catch、无错误边界**——DB 初始化抛错即白屏（而首次启动必然抛错，见 §3.1，P0）。
- `BootScreen.tsx:22-28`：固定 1500ms setTimeout 后按 `isAuthenticated` 分流，模拟启动动画；`isAuthenticated` 变化会重跑 effect 重开定时器，无实际校验逻辑。

---

## 2. 与桌面端的数据链路（重点还原）

### 2.1 配对流程还原（DevicePairingScreen）

`src/screens/DevicePairingScreen.tsx:17-51` 的"手动配对"实际执行：

1. `KeyManager.generateAndStoreKeyPair()`（`DevicePairingScreen.tsx:27`）——生成 **Math.random() 拼接的 mock PEM 字符串**（`KeyManager.ts:19-43`），800ms 定时器后明文写入 SQLite `key_value_store`（`KeyManager.ts:29-37`）；
2. 用户输入的 6 位 OTP **从未被使用**——`pairingToken` 只是 UI 态，`handleManualPair` 里既不发服务端也不做任何校验（`DevicePairingScreen.tsx:18-19, 30-34`）；
3. `setTimeout(1500)` 模拟"密码学握手"（`DevicePairingScreen.tsx:34`）；
4. 直接 `wsTransport.connect('ws://' + ip + ':8080')`（`DevicePairingScreen.tsx:30, 38`），然后弹窗宣称"cryptographically bound to the desktop kernel"（`:43`）。

QR 入口是 Alert 占位（`DevicePairingScreen.tsx:73`）。`KeyManager.encryptPayload / decryptPayload / signData`（`KeyManager.ts:49-94`）是"前缀字符串 + encodeURIComponent"级别的占位，且全部无调用点。

### 2.2 事件来源（EventStreamScreen）

- 事件来源为 **WebSocket**：`src/transport/ws.ts:12` `new WebSocket(url)`；`onmessage` 只处理三种消息 `task_update` / `new_approval` / `log`（`ws.ts:45-57`），未知类型仅 `console.warn`。
- 下发面：`dispatch_command`（`EventStreamScreen.tsx:52`、`TaskRunnerService.ts:61`）、`gate_decision`（`EventStreamScreen.tsx:29`）、`fs_mutation`（`FileManagerScreen.tsx:69`）、`agent_chat_input`（`AgentChatScreen.tsx:56`）——统一 `{action, payload}` 信封，无消息级鉴权（详见 MOBILE-02 §4）。
- `sendAction` 在 socket 未就绪时**静默丢弃**（`ws.ts:60-66`），错误只进 console。

### 2.3 完整链路结论：移动端实际上连不上 crish 桌面端

关键事实（全仓 grep 验证）：

- **桌面端不存在任何 WebSocket/HTTP 服务端**：`apps/agent-workbench/src-tauri` 与全部 `crates/` 中无 `TcpListener` 服务端监听（仅测试代码里的 127.0.0.1 mock）、无 8080 监听、无移动配对/中继相关代码；`docs/rust-rewrite/` 亦无移动端任务书。
- `NetworkStrategyEngine` 声称的 LAN/Tailscale/Cloud 三端点（`NetworkStrategyEngine.ts:28-32`，含 `wss://relay.conex.app/ws` 占位域名）**从未被任何代码引用**（grep：`networkEngine` 仅自引用）；`startActivePing`（`:118-134`）也无人调用，`ws.ts` 的 `handleMessage` 没有 `pong` 分支——即使引擎被接线，ping 响应也会落进"Unknown message type"。
- 推送链（FCM/APNs/HMS 适配器）同样是死代码：`pushManager` 无任何导入点；且缺 `google-services.json` 时 `@react-native-firebase/app` 在 prebuild/构建期即失败（MOBILE-02 §6）。

**还原结论**：移动端与桌面端之间**当前不存在任何可工作的数据链路**。UI 上"Kernel Connected"（`CustomDrawerContent.tsx:29`）、配对成功、事件流、命令下发全部是前端模拟；一旦未来桌面端真开 `ws://IP:8080`，移动端协议（消息类型 `task_update/new_approval/log`、action 信封）也是自造的，与桌面端 `conex-types` 事件体系（`tool-update`、`approval-requested` 等 wire kind，`crates/conex-types/events.rs`）零对齐——**没有协议契约文档，也没有服务端实现来对齐**。

---

## 3. 数据库设计

### 3.1 Schema 与初始化（含 P0 缺陷）

- `src/db/schema.ts:5-63` 五张表：`workspaces` / `tasks` / `audit_logs` / `key_value_store` / `metrics`。外键仅有 `workspaceId → workspaces ON DELETE CASCADE`；**除主键外无任何索引**（`audit_logs.createdAt`、`tasks.workspaceId` 等查询列无索引，数据量上来即全表扫描）。
- **P0：首次启动必然抛错**。`initDatabase()`（`src/db/index.ts:14-53`）在事务内**先**执行 `SELECT value FROM key_value_store WHERE key='schema_version'`（`:21-23`），**后**才创建各表（`:30-32`）。全新数据库上 `key_value_store` 尚不存在 → SQLite 抛 `no such table` → 事务回滚 → `catch` 后 `throw`（`:50-53`）→ `App.tsx:14` 未捕获 → 首次安装即白屏。建表语句全部是 `CREATE TABLE IF NOT EXISTS`，即使正常路径下版本判断也形同虚设。
- 迁移机制：`SCHEMA_VERSION = 1`（`schema.ts:3`），升级策略是"版本不足就重跑全部 CREATE IF NOT EXISTS + 更新版本号"（`db/index.ts:27-47`）——**没有 ALTER/DROP/数据迁移框架**，未来加列只能靠手工补丁；版本号写入与建表同事务，方向正确但框架缺失。

### 3.2 Repositories 层

- 五个静态类 repo（`AuditLogRepo` / `TaskRepo` / `WorkspaceRepo` / `MacroRepo` / `MetricsRepo`），全部走 expo-sqlite 同步 API（`getAllSync` / `runSync`），模式统一、SQL 参数化无注入问题。
- 覆盖问题：`TaskRepo`（`TaskRepo.ts:4-28`）**没有任何调用点**——任务只存在于 zustand 内存（见 §4.3）；`audit_logs` 的写入仅来自 `EventStreamScreen.tsx:35-44`（审批决策），命令下发/宏执行/文件操作均不落审计。

### 3.3 与桌面端 conex-db 的对应关系

**零对应**。桌面端 `crates/conex-db/src/schema.rs:8-250` 的表是 `sessions` / `events` / `runs` / `session_messages` / `session_agents` / `session_agent_messages` / `session_meta` / `pending_inputs` / `session_sequence` / `metadata`；移动端五张表（workspaces/tasks/audit_logs/metrics/macros/key_value_store）是**为原型自造的领域模型**，与桌面端会话事件体系、数据仓库没有任何字段或语义映射。若未来做真链路，移动端本地库应当是桌面端事件库的投影/缓存，而非平行发明一套。

---

## 4. 状态一致性

### 4.1 事件流 → store → UI 链路

链路为单程直通：`ws.onmessage → handleMessage → store action → 组件订阅重渲`（`ws.ts:21-28` + `EventStreamScreen.tsx:84-112`）。问题：

- **无重连同步协议**：断线期间（固定 5s 重连，`ws.ts:35`）事件直接丢失，重连后**没有快照/重放/序列号恢复**——对"Live Stream"定位这是功能缺陷（审批在断线窗口到达则永远看不到）。
- 所有状态只进内存 store，事件流**从不持久化**到 `events` 类表（本地库没有对应表），离线即无痕。

### 4.2 断线/重连/登出

- `ws.ts:30-36`：`onclose` 无条件 5s 后重连，**无退避、无上限**；更严重的是 `disconnect()`（`ws.ts:68-74`）清定时器后 `close()`，但旧 socket 的 `onclose` 回调**异步触发**时会重新 `setTimeout(() => this.connect(url), 5000)`（`:35` 捕获的是旧 url）——**用户手动断开后 5 秒必定重连**，`Settings.tsx:15-17` 的"Disconnect"按钮形同虚设。
- **切换端点会产生双连接**：`connect()` 先 `close()` 旧连接再建新连接（`ws.ts:7-12`）；旧连接的 `onclose` 随后把 `this.ws = null`（`:33`）——**新连接的引用被旧连接回调清掉**，后续 `sendAction` 全部因 `this.ws === null` 静默丢弃，且 5s 后还会复活一条到旧地址的连接。设置里改端点（`SettingsScreen.tsx:21-24`）是必现路径。
- 登出不拆传输（见 §1.2）：登出后 WS 保持，`task_update`/`new_approval` 继续写 store，与"Sign Out & Lock"（`CustomDrawerContent.tsx:102`）的宣传完全矛盾。
- failover 引擎（`NetworkStrategyEngine`）整体未接线（§2.3），`recordFailure`/`recordLatency` 无调用点，"Auto-Failover enabled"（`SettingsScreen.tsx:77`）是文案。

### 4.3 数据双源发散

- 任务：WS `task_update` 只写 zustand 内存（`ws.ts:47`），`TaskHubScreen` 只读 DB（`TaskRepo.getTasksForWorkspace`，`TaskHubScreen.tsx:33-38`）——**两条任务源永不收敛**；`TaskRepo` 无写入方（§3.2）。审批：`EventStreamScreen` 决定后乐观删除本地审批（`EventStreamScreen.tsx:32`）且无服务端 ack 机制，`sendAction` 静默丢包时**决策永久丢失**（`ws.ts:61-66`）。

---

## 5. 组件质量

| 组件 | 证据 | 问题 |
|---|---|---|
| BottomSheet | `BottomSheet.tsx:50` | 访问 `Animated.Value._value` 私有字段判断隐藏态，属内部 API 依赖，版本升级易碎 |
| | `BottomSheet.tsx:55` | `Modal visible={visible}`——`visible=false` 时 Modal 立即不渲染，**退出动画实际不可见**（`:35-46` 是死动画）；关闭即"瞬移消失" |
| | `BottomSheet.tsx:6,52` | `Dimensions.get('window')` 模块加载期取值 + `heightRatio` 不扣安全区/键盘，横屏/分屏/键盘弹出时布局错位 |
| Toast | `Toast.tsx:23-25` | 自动隐藏 `setTimeout` 不清理、无队列：4 秒内第二条通知到达，先到的隐藏回调会把新 toast 一并清掉（显示 1~2 条即消失的竞态） |
| TerminalView | `TerminalView.tsx:27` | ANSI 正则只匹配成对 `\x1b[m ... \x1b[0m`；未闭合/连续多个 SGR 码时原文泄漏转义字符或颜色错乱；`parseAnsi` 每次渲染全量重解析、**无 memo**（`:1` 的 `useMemo` 导入未用）；组件本身无任何调用点（死代码） |
| EmptyState / Header | `EmptyState.tsx:12-21`、`Header.tsx:15-47` | 契约清晰、空态齐全，质量 OK；`Header.tsx:16` 导航类型写死 `DrawerNavigationProp<any>`，在 Stack 屏里语义错误 |

`EventStreamScreen.tsx:14` 用 `useConexStore()` 整体订阅 + `ScrollView`（`:79-113`）渲染日志——100 条上限内可接受，但无"吸底"逻辑：用户上翻读历史时每来一条日志就被 `scrollToEnd`（`:23-25`）拽回底部。

---

## 6. 并发与性能

- **zustand 订阅粒度**：`EventStreamScreen.tsx:14`、`CustomDrawerContent.tsx:9`、`SettingsScreen.tsx:12-16`、`Dashboard.tsx:7` 均为**无 selector 的整体订阅**（zustand v5 下任意字段变化即全量重渲）；`BootScreen.tsx:10` 是唯一使用 selector 的屏。事件流高频 `addLog` 时这些组件全部随流重渲——当前规模无感，但这是本应用最高频的更新路径，应改 selector。
- **长列表**：全应用无一处 `FlatList`（日志/文件/任务/审计全用 `ScrollView`+`map`）。日志有 100 条截断（`store/index.ts:99`）尚可，`TaskRepo` 查询（`TaskRepo.ts:8`）与审计查询（`AuditLogRepo.ts:8`）**无 LIMIT 之外的分页**，`audit_logs` 无索引（§3.1），数据累积后首个渲染即卡顿。
- **同步 DB 在 JS 线程**：全库 `*Sync` API 主线程执行；`DashboardScreen.tsx:41` 每 5 秒同步轮询全量读。20 行规模没问题，但若事件流真接入后沿用此模式（每条消息 `runSync` 落库）会在 JS 线程形成队列阻塞动画。
- `DashboardScreen.tsx:14-29`：空表时**向 metrics 表注入 20 条 Math.random() 假数据**——污染本地库，图表展示的"真实遥测"是编造的，原型注释明说了"WS isn't sending it yet"。

---

## 7. 问题清单

### P0（致命 / 数据安全）

1. **首次启动 DB 初始化必抛错**：`db/index.ts:21-25` 在 `key_value_store` 建表前就 SELECT 它，全新库抛 `no such table`，`App.tsx:14` 无捕获 → 新装即白屏（`db/index.ts:50-53`）。
2. **整条数据链路无对端**：桌面端不存在任何 WS 服务端/配对端（全仓 grep 验证），移动端所有"已连接/已配对/事件流"均为 UI 模拟；协议（`task_update/new_approval/log`）与桌面端 `conex-types` 事件体系零对齐，无契约文档——"移动伴侣"当前不可成立。

### P1（架构缺陷）

3. **重连逻辑三连错**（`ws.ts:30-36, 7-12, 68-74`）：手动 `disconnect()` 后 5s 必重连；切换端点时旧连接 `onclose` 置空新连接引用 → 发送全部静默丢弃 + 复活旧地址双连接。控制类应用里属高危（一旦真链路接通即为 P0）。
4. **登出不闭环**：`logout`（`store/index.ts:62`）不拆 WS、不清 DB，`CustomDrawerContent.tsx:96-99` 不跳转 Login——登出后仍在受保护界面且事件持续流入。
5. **断线恢复无协议**：无快照/重放/序列号；重连后窗口期事件永久丢失；审批决策乐观删除无服务端 ack（`EventStreamScreen.tsx:27-48` + `ws.ts:60-66`）。
6. **任务数据双源发散**：WS 写内存（`ws.ts:47`）/ TaskHub 读 DB（`TaskHubScreen.tsx:35`），`TaskRepo` 无写入方，永不收敛。
7. **死代码体量失控**：`NetworkStrategyEngine`（150 行）、`PushNotificationManager`+三适配器（263 行）、`TerminalView`、`LocalHardwareService`、四个未注册旧屏（Dashboard/Settings/ChatStream/ApprovalCenter）全部无引用——其中"failover 引擎"与"推送管理器"是文档/UI 宣称的能力，实际未接线，误导后续开发。
8. **工程门禁缺失**：`package.json:30-35` 无 typecheck/lint/test 脚本；无任何测试文件；`app.json` 无 `ios.bundleIdentifier`/`android.package`（EAS 构建缺标识符）；整个目录未入库且 `app.json` 被根 `.gitignore:358` 的 `*.json` 吞掉（详见 MOBILE-02 P0-4）。

### P2（整洁度）

9. `DrawerNavigator.tsx:3` 未使用导入 `NavigationContainer`。
10. `BottomSheet.tsx:50` 私有属性 `_value` 依赖 + 退出动画死代码（`BottomSheet.tsx:55`）+ 窗口尺寸模块期固化（`:6`）。
11. `Toast.tsx:23-25` 自动隐藏定时器竞态，新通知可被旧定时器提前清掉。
12. `DashboardScreen.tsx:14-29` 假数据注入 metrics 表；`GlobalSearchScreen.tsx:52` 查询不存在的 `workspaces.path` 列（运行期报错，`schema.ts:6-13` 无此列）。
13. `EventStreamScreen.tsx:36` 用 `Math.random().toString(36).substring(7)` 生成审计日志 id，碰撞概率在批量场景不可忽略。
14. 全应用 `useNavigation<any>`（EventStreamScreen/DevicePairingScreen/AgentChatScreen 等），导航无类型契约。
15. `TaskHubScreen.tsx:23` 二次 `initDatabase()` 与 `App.tsx:14` 重复；`store` 的 `AgentTask` 与 DB `DBTask` 双模型漂移。
16. `MacroScreen.tsx:58,144,146` 多处裸 `JSON.parse(macro.steps)` 无 try/catch（仅 `handleRunMacro` 有）。

---

## 8. 技术选型评估

### 8.1 Expo SDK 57 / RN 0.86 对这个场景是否合适

场景是"配对 + 事件流 + 终端展示 + 文件管理"的远程控制伴侣：**需要的能力都是 RN 生态成熟面**（WebSocket、列表渲染、expo-sqlite、通知），无深度原生诉求（无后台保活 agent、无硬件直通）。Expo 托管工作流（含 dev build）可以支撑，且 SDK 57 的 expo-sqlite 同步 API + zustand 的组合对这个体量是合理的。**方向选型没问题**。

但落地形态有三个具体问题：

1. **版本线过新且激进**：Expo ~57.0.11 / RN 0.86.2 / React 19.2.3 / zustand ^5（`package.json:13-24`）——SDK 57 是 2026 年新主线，配套 `react-native-reanimated ^4.5.3`、`react-native-screens ^4.27.0` 等均跟随大版本；无 expo-dev-client、无 `eas.json`、无 CI 验证，构建可行性从未被证明。
2. **原生模块混装破坏 Expo Go 兼容**：`@react-native-firebase/messaging ^26.1.0` + `@hmscore/react-native-hwpush ^4.0.4` 需要 prebuild/dev build，**Expo Go 直接跑不了**；且缺 `google-services.json` 时 Android 构建必失败（MOBILE-02 §6）——当前仓库状态下 `npm start` 无法完成任何真机验证。两个推送库 + 三平台适配器对"先验证配对+事件流"的原型目标是过度设计；若只做通知，`expo-notifications` 单通道足够。
3. **与仓库工程文化的断层**：主仓库有全量门禁（typecheck/vitest/ci.yml），此目录零脚本零测试零 CI（§7-P1-8），且未入库——与 AGENTS.md"测试资产保护铁律"同类风险。

### 8.2 expo-sqlite vs 其他

- 当前用量（5 表、百行级、同步 API）在 expo-sqlite 能力圈内，选择合理；`openDatabaseSync`（`db/index.ts:9`）对原型体量没有性能问题。
- 局限：**无 SQLCipher/加密选项**——本应用存密钥/审批/命令历史，安全上需要 expo-secure-store 存密钥材料、SQLite 只存非敏感数据（MOBILE-02 §5 同向结论）；事件流高频写入应改用异步 API（`runAsync`）或批量事务，避免 JS 线程阻塞（§6）。
- 若未来做离线事件缓存与桌面端对齐，更优形态是把移动端本地库做成桌面端事件库的投影（同步 `events` 表），而不是现在这套自造领域模型（§3.3）。

### 8.3 选型风险汇总

| 风险 | 级别 | 说明 |
|---|---|---|
| SDK 57 过新，无构建验证 | P1 | dev build/EAS 从未跑通；无 bundleIdentifier/package（`app.json:9-20`） |
| RNFirebase 破坏 Expo Go + 缺配置必挂 | P1 | `app.json:26-27` 插件零配置；MOBILE-02 §6 |
| hwpush 老封装 + 手写 d.ts | P2 | `src/types/hwpush.d.ts:1-8` 仅声明两个 API，接口面不可信 |
| expo-notifications 未进 plugins | P2 | `app.json:24-28` 无 expo-notifications 插件项，APNs 适配器（`APNsPushAdapter.ts:2`）行为不受 config 管理 |
| 桌面端协议契约缺失 | P0 | 移动端消息信封为自造，与 `conex-types` 事件体系零对齐（§2.3） |

---

## 9. 架构建议（优先级排序）

1. **定义协议契约并立对端**（P0）：在 `docs/rust-rewrite/` 或 feature-gap 新增移动端链路方案——桌面端 WS 服务端（端口/鉴权/消息类型对齐 `conex-types` 事件体系）、配对握手（一次性配对码 + 公钥注册 + 会话令牌）、重连同步（快照/序列号）。
2. **修 DB 首启缺陷**（P0）：`db/index.ts:21-23` 的版本读取改为"表不存在即视 v0"（先 `CREATE TABLE IF NOT EXISTS key_value_store` 或查 `sqlite_master`）。
3. **重写传输层**（P1）：连接代际令牌（generation id）防止旧 onclose 干扰新连接；`disconnect()` 置 `shouldReconnect=false`；指数退避；重连后拉快照。
4. **登出闭环**（P1）：logout 拆 WS + 清会话 + `navigation.replace('Login')`。
5. **收敛死代码**（P1）：删除或接线 NetworkStrategyEngine/推送管理器/未注册屏/未用服务；明确"连接策略"当前只支持单端点直连。
6. **工程收口**（P1）：补 typecheck/lint/测试脚本与基础测试（DB 初始化/重连逻辑是最高价值用例）；`app.json` 补 bundleIdentifier/package、expo-notifications 插件；资产入库（放行 app.json/tsconfig.json，参见 MOBILE-02 建议 7）。
7. **性能治理**（P2）：zustand selector 化；列表改 FlatList；DB 高频路径异步化；删除假数据注入。

---

## 最严重 5 项

1. **首次启动即崩溃**：`db/index.ts:21-25` 在 `key_value_store` 建表前读取版本号，全新数据库抛 `no such table`，`App.tsx:14` 未捕获——应用在干净设备上无法启动。
2. **数据链路整体是空壳**：桌面端无 WS 服务端、无配对端，移动端协议为自造且与 `conex-types` 零对齐（§2.3）——"移动伴侣"能力当前不可成立，属于架构级欠账而非细节 bug。
3. **传输层重连逻辑三连错**：`disconnect()` 后 5s 必重连；切换端点产生双连接且新连接引用被旧 `onclose` 清空导致发送全灭（`ws.ts:7-12, 30-36, 68-74`）——真链路一旦接通即为数据面高危。
4. **登出不闭环**：不拆 WS、不跳 Login、事件持续流入（`store/index.ts:62` + `CustomDrawerContent.tsx:96-99`），"Sign Out & Lock"名不副实。
5. **死代码 + 工程门禁缺失**：failover 引擎/推送管理器/四个旧屏全无引用却承载了 UI 宣称的能力；目录零测试零脚本未入库（`package.json:30-35`），与主仓库门禁文化断层。
