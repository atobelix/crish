# R2B 移动端旧代码技术面审查（apps/crish-mobile 去留评估）

> 文档编号：R2B-legacy-mobile-tech
> 系列：移动端旧代码去留评估（multi-device）
> 版本：v1.0
> 日期：2026-08-09
> 角色：技术面审查子代理 R2B（只读分析）
> 审查对象：`apps/crish-mobile/`（Expo 57 实验性原型，未入库）
> 技术基准：`docs/multi-device/plans/D4-mobile-tech.md`（v1.0 正式技术方案）
> 关联文档：`docs/feature-gap-analysis/audits/MOBILE-01-architecture.md`、`MOBILE-02-security.md`、`MOBILE-03-features-stack.md`

---

## 0. 结论摘要（先行）

| 审查维度 | 结论 |
| --- | --- |
| 依赖评估 | 6 项契合 D4（expo/react/react-native/expo-sqlite/expo-notifications/zustand），4 项直接是坑（firebase×2、hwpush、lucide 缺 react-native-svg），6 项被 D4 弃用（react-navigation 系×5、masked-view），2 项版本面存疑（gesture-handler 等手装非 expo install、typescript 6.0） |
| 代码质量 | 47 个源码文件中 3 个可用（思路）、6 个需重构、38 个废弃；P0 缺陷 2 项（DB 首启必崩、链路整体是空壳）与已有审计一致 |
| 可复用工程资产 | 仅 3 类：主题 token 组织、repo 分层思路、组件契约风格——均以"思路"形式复用，不搬代码 |
| 删除风险 | **零连带损失**：git 跟踪 0 文件；全仓代码零引用；文档引用均为「未跟踪/不触碰」操作约定，删除后语义仍成立；AGENTS.md/CLAUDE.md 无指导价值 |
| 去留裁定 | **整体删除**（保留目录位给 D4 M0 清空重建）；经验教训沉淀到本文档与既有审计文档 |
| 对新方案警示 | 8 条：固定 PIN/假装加密→安全设计、骨架模拟→验收门禁、缺依赖起不来→CI 冒烟、DB 首启崩→迁移+错误边界、死代码→能力一致性门禁、自造协议→契约复用、重连三错→代际令牌、未入库→白名单修正 |

**一句话**：`apps/crish-mobile` 是"UI 完整、链路占位"的原型，与 D4 方案零代码兼容面；删除零代价，其教训（安全占位、依赖失控、无门禁）反而比代码更有保存价值。

---

## 1. 审查范围与方法

### 1.1 审查对象

- 目录全景：`apps/crish-mobile/` 共 14 个顶层条目（.claude/、.gitignore、AGENTS.md、app.json、App.tsx、CLAUDE.md、LICENSE、assets/、index.ts、node_modules/、package-lock.json、package.json、src/、tsconfig.json）。
- `src/` 共 47 个 TS/TSX 源码文件（9 个子目录：components 5、db 7、navigation 3、screens 17、services 11、store 1、theme 1、transport 1、types 1）。
- 工程文件：package.json、app.json、tsconfig.json、.gitignore、AGENTS.md、CLAUDE.md、index.ts、App.tsx。

### 1.2 审查方法

- 逐文件通读全部源码（47 个文件全覆盖，未抽样）。
- `git ls-files apps/crish-mobile` 实测跟踪状态（结果：0 个已跟踪文件）。
- 全仓库 grep `crish-mobile`（含 md 文档）核实跨模块引用面。
- 依赖逐项对照 D4 选型表（D4 §3.1 总览表、§12.1 依赖清单）与 SDK 57 生态事实。
- 已有审计交叉引用：MOBILE-01（架构）、MOBILE-02（安全）、MOBILE-03（功能选型）与本审查同向，本文不重复其全部细节，只做技术面独立复核并给出去留裁定。

### 1.3 已知事实背景（任务书给定）

纯实验性原型（几小时搭建、无 git、固定 PIN、明文 WS、骨架功能、DB 首启必崩、缺 react-native-svg 无法启动）。本审查已逐项在源码中复核属实（证据见 §4、§6）。**本原型不作为任何决策依据**，去留由评估定夺。

---

## 2. 依赖审查（package.json 逐项评估）

旧 `package.json` 依赖 14 项、devDependencies 2 项。对照 D4 选型（Expo 57 / expo-router / expo-sqlite / expo-secure-store / expo-notifications / zustand+immer / RN 内建 WebSocket / jest-expo），逐项裁定：

### 2.1 与 D4 契合（可复用版本方向）

| 依赖 | 旧版本 | D4 要求 | 裁定 |
| --- | --- | --- | --- |
| `expo` | ~57.0.11 | 精确锁定 57.0.0 系 | **契合**。SDK 57 方向与 D4 完全一致，且实测版本 ~57.0.11 落在 D4 的 57.x 窗口内 |
| `react` | 19.2.3 | 精确锁定 19.2.3 | **契合**。与 D4 一字不差 |
| `react-native` | 0.86.2 | 精确锁定 0.86.x | **契合**。与 D4 的 RN 0.86 目标完全一致 |
| `expo-sqlite` | ~57.0.1 | SDK 57 配套版 | **契合（库）**。D4 §7 用同一包，但用法必须换：旧代码走同步 API（`openDatabaseSync`/`getAllSync`/`runSync`，`db/index.ts:9`），D4 要求 SDK 57 异步 API（`openDatabaseAsync`/`runAsync`）+ `SQLiteProvider` + `PRAGMA user_version` 迁移。同步 API 在 JS 线程执行，是 MOBILE-01 §6 已指出的性能面问题 |
| `expo-notifications` | ~57.0.9 | SDK 57 配套版 | **契合（库）**。D4 §8 的推送主通道。注意旧 `app.json:24-28` 的 plugins 数组**没有** expo-notifications 项（MOBILE-01 §8.3 已指），库装了但 config 未接线——新工程必须同步注册 plugin |
| `zustand` | ^5.0.14 | v5.x | **契合（版本）**。但 D4 要求 immer 中间件（`zustand/middleware/immer`）+ `withDevtools` + `useShallow` selector 范式，旧代码单 store 无中间件（`store/index.ts:58-103`），`immer` 依赖需新增 |

### 2.2 直接是坑（必须弃用）

| 依赖 | 旧版本 | 坑点 | D4 替代 |
| --- | --- | --- | --- |
| `@react-native-firebase/app` ^26.1.0 | 原生模块，破坏 Expo Go 兼容（需 prebuild/dev build）；缺 `google-services.json` 时 Android 构建必失败（MOBILE-02 §6 验证）；华为等国内设备无 GMS，FCM 通道不可用 | expo-notifications（D4 §8.2）+ 自研厂商推送 config plugin（D4 §8.5） |
| `@react-native-firebase/messaging` ^26.1.0 | 同上；`app.json:26-27` 两个 firebase 插件零配置注册，直接拉高构建失败面 | 同上 |
| `@hmscore/react-native-hwpush` ^4.0.4 | 老封装，仅 2 个 API 面；`src/types/hwpush.d.ts:1-8` 手写声明只覆盖 `getToken`/`onRemoteMessageReceived`，接口面不可信；`PushNotificationManager.selectAdapter` 用 `Platform.OS === 'harmony'`（`PushNotificationManager.ts:32`）区分华为设备是**错误前提**——华为手机跑 Android（Platform.OS='android'），HarmonyOS NEXT 是另一套生态；华为设备场景下会走 FCM 分支而非 HMS | D4 §8.5 P1 自研 config plugin + Expo Module API 读 HMS 令牌 |
| `lucide-react-native` ^1.30.0 | **peer 依赖 react-native-svg 未安装**——这是"缺 react-native-svg 无法启动"的直接根因（MOBILE-03 已 `npm ls` 实测）。图标库选了 lucide 但漏装其底层，暴露依赖面无人管理 | D4 §12.1 未列图标库；实施时若用 lucide 必须 `npx expo install react-native-svg` 一并对齐 |

### 2.3 被 D4 弃用（选型冲突）

| 依赖 | 旧版本 | D4 决策 | 说明 |
| --- | --- | --- | --- |
| `@react-navigation/native` ^7.3.16 | 弃（expo-router v6，D4 §3.4） | 深链即路由是移动端核心（推送点击直达），react-navigation 手配需写 linking 配置，expo-router 收敛为目录约定 |
| `@react-navigation/stack` ^7.10.22 | 弃 | 同上 |
| `@react-navigation/drawer` ^7.13.8 | 弃 | 同上；且 Drawer 导航不适合"伴侣端"5 屏 Tabs 结构 |
| `@react-native-masked-view/masked-view` ^0.3.2 | 弃 | react-navigation 依赖链产物，随其弃用 |

### 2.4 版本面存疑（方向对、装法错）

| 依赖 | 旧版本 | 问题 |
| --- | --- | --- |
| `react-native-gesture-handler` ^3.1.0 | D4 §12.1 保留（expo-router 依赖链） | 版本带 `^` 且是**手装**（非 `npx expo install`），SDK 57 配套版本未被验证对齐；expo-router 实际依赖链会强制正确版本，但手装版本有与 SDK 57 不匹配的漂移风险 |
| `react-native-reanimated` ^4.5.3 | D4 §12.1 保留 | 同上；reanimated 是版本敏感度最高的依赖之一，必须 expo install 对齐 |
| `react-native-screens` ^4.27.0 | 随 expo-router 依赖链 | 同上 |
| `react-native-safe-area-context` ^5.8.1 | 随 expo-router 依赖链 | 同上 |
| `typescript` ~6.0.3（dev） | D4 说 TS 5.9 随 SDK 模板 | TS 6.0 超前于 SDK 57 模板基线，`expo/tsconfig.base` 与 TS 6.0 的兼容性未验证；新工程用模板默认版本并验证 typecheck |
| `@types/react` ~19.2.2（dev） | 与 react 19.2.3 配套 | 无问题，但建议随模板 |

### 2.5 旧 package.json 缺失项（D4 必备但旧工程没有）

- `expo-router`（导航/深链，D4 核心）
- `expo-secure-store`（令牌/指纹，D4 §7.4——旧工程把私钥明文存 SQLite，见 §4.4）
- `immer`（zustand 中间件）
- `expo-task-manager`、`expo-device`、`expo-constants`、`@react-native-community/netinfo`（D4 §12.1）
- `jest-expo`、`@testing-library/react-native`（测试基建——旧工程零测试零脚本）
- 测试/门禁脚本：`package.json:30-35` 只有 start/android/ios/web，无 typecheck/lint/test（MOBILE-01 §7-P1-8 同）

**依赖审查小结**：契合面（expo/react/RN/expo-sqlite/expo-notifications/zustand 的版本方向）说明原型的"选型直觉"与 D4 高度一致，这是原型唯一可肯定之处；但坑面（firebase×2 + hwpush + lucide 缺 svg）恰好覆盖了"启动失败"与"推送不可用"两大致死点，且 6 项 react-navigation 系被 D4 弃用——**依赖层净可复用面为零，全部要重装**。

---

## 3. 代码质量审查（按文件评级）

评级口径：**可用**（可改造直接搬入新工程）/ **需重构**（思路有价值、实现不可用）/ **废弃**（死代码或与 D4 冲突）。D4 §2.2 硬约束"不读旧原型内部、实施时清理重建"——故"可用"级不构成搬迁依据，仅表示编写思路值得参考。

### 3.1 传输层（src/transport/）

| 文件 | 评级 | 证据与问题 |
| --- | --- | --- |
| `ws.ts`（77 行） | 废弃 | **重连三连错**：①`disconnect()`（`:68-74`）清定时器后 close，但旧 socket 的 `onclose` 异步触发时重新 `setTimeout(connect, 5000)`（`:35`）——手动断开 5 秒后必重连；②切换端点时旧 `onclose` 把 `this.ws = null`（`:33`）清掉新连接引用，后续 `sendAction` 全部静默丢弃（`:60-66`）且 5s 后复活旧地址连接；③固定 5s 重连无退避无上限。**协议自造**：消息类型 `task_update/new_approval/log`（`:45-57`）与引擎事件体系零对齐。**明文**：`ws://`（`Settings.tsx:9`、`NetworkStrategyEngine.ts:29-31`） |

### 3.2 状态层（src/store/）

| 文件 | 评级 | 证据与问题 |
| --- | --- | --- |
| `index.ts`（103 行） | 废弃 | 单 store 无 persist、无中间件、无 selector 粒度；`logout()`（`:62`）不拆 WS 不清 DB，登出后事件继续流入（MOBILE-01 §4.2）；`AgentTask`（`:5-11`）与 DB `DBTask`（`schema.ts:86-95`）双模型漂移；`GateApproval.payload: any`（`:18`）无类型面。D4 要求 7 store 域 + immer + `useShallow`，范式完全不同 |

### 3.3 数据层（src/db/）

| 文件 | 评级 | 证据与问题 |
| --- | --- | --- |
| `index.ts`（54 行） | 废弃 | **P0 首启必崩**：事务内先 `SELECT ... FROM key_value_store`（`:21-23`）后建表（`:30-32`），全新库抛 `no such table` → `App.tsx:14` 无捕获 → 新装白屏。迁移机制是"版本不足重跑 CREATE IF NOT EXISTS"（`:27-47`），无 ALTER/迁移框架。模块级单例 `getDB`（`:6-12`）思路可取（D4 要求单写连接） |
| `schema.ts`（106 行） | 废弃 | 5 张表（workspaces/tasks/audit_logs/key_value_store/metrics/macros）为原型自造领域模型，与桌面端 conex-db（sessions/events/runs…）**零对应**（MOBILE-01 §3.3）；除主键外无索引。D4 §7.2 的 8 张表（sessions/runs/events/approvals/outbox/file_cache/dead_letters/kv）与桌面端对齐，旧 schema 无一复用 |
| `repositories/*`（5 文件，共 134 行） | 需重构 | 模式统一、SQL 参数化无注入（`AuditLogRepo.ts:7-9` 等），静态类 repo 是 D4 DAO 的雏形思路；但：静态类无 DI（D4 §9.2 要求接口注入可 mock）、同步 API、`TaskRepo` 无任何调用点（死代码）、`GlobalSearchScreen.tsx:52` 查询不存在的 `workspaces.path` 列（运行期报错）。**思路可参考，实现全部重写** |

### 3.4 服务层（src/services/）

| 文件 | 评级 | 证据与问题 |
| --- | --- | --- |
| `AuthService.ts`（58 行） | 废弃 | **固定 PIN**：`LoginScreen.tsx:31` 硬编码 `newPin === '0000'`；生物识别是 800ms setTimeout 模拟（`:28-34`）；`signPayload` 返回 `sig_${random}` 假签名（`:42-48`）——"假装加密"典型 |
| `KeyManager.ts`（95 行） | 废弃 | **私钥明文存 SQLite**（`:29-37` 写入 `key_value_store`），注释自称"simulating secure Enclave storage"；mock PEM 是 `Math.random()` 拼接（`:23-24`）；`encryptPayload`/`decryptPayload`/`signData`（`:49-94`）是前缀字符串 + encodeURIComponent 占位且全部无调用点。D4 §7.4 要求 expo-secure-store，方向完全相反 |
| `NetworkStrategyEngine.ts`（150 行） | 废弃 | 整体未接线（MOBILE-01 §2.3：`networkEngine` 仅自引用）；三端点含占位域名 `wss://relay.conex.app/ws`（`:31`）；failover 逻辑（`:76-81`）设计上"同步执行"无实际价值。D4 的连接相位投影是纯函数映射，另起炉灶 |
| `NotificationService.ts`（75 行） | 需重构 | 应用内通知队列 + listener 模式（`:31-37`）思路正确，是 D4 前台 handler 的雏形；但 id 用 `Math.random().toString(36)`（`:44`）、无持久化、`getRecentNotifications` 原地排序（`:66-68`）污染队列顺序。小重构可用 |
| `LocalHardwareService.ts`（79 行） | 废弃 | 全部模拟（电量写死 0.8，`:32-33`；ping 用 `Math.random()`，`:50`）；无调用点（死代码） |
| `TaskRunnerService.ts`（99 行） | 废弃 | 执行逻辑是固定 1500ms setTimeout 模拟 ack（`:74-80`）；`isRunning` 单例锁无并发保护；"宏执行"不在 D4 v1 范围 |
| `push/`（5 文件，共 291 行） | 废弃 | IPushAdapter 抽象面（`IPushAdapter.ts:9-28`）思路可取（D4 双通道/厂商通道分层），但：FCM/APNs/HMS 三适配器由 firebase+hwpush 支撑（§2.2 已判坑）；`HarmonyPushAdapter` 基于错误平台前提（§2.2）；`PushNotificationManager` 无任何导入点（死代码，MOBILE-01 §2.3）；D4 走 expo-notifications 单 API + 厂商 config plugin，适配器体系全部重写 |

### 3.5 组件层（src/components/）

| 文件 | 评级 | 证据与问题 |
| --- | --- | --- |
| `EmptyState.tsx`（50 行） | 可用（思路） | 契约清晰、空态齐全、样式走 token（`:4` 引入 tokens）。D4 目录结构里 `ui/` 组件族需要同款 EmptyState，可参考其接口（icon/title/description） |
| `Header.tsx`（64 行） | 可用（思路） | 抽屉/返回双模式（`:20-28`）+ rightElement 插槽 + 默认动作开关，接口设计干净；瑕疵：导航类型写死 `DrawerNavigationProp<any>`（`:16`），在 Stack 屏语义错误。新工程用 expo-router 时此组件不复存在，但"插槽式 header"思路可迁移 |
| `BottomSheet.tsx`（98 行） | 废弃 | 访问 `Animated.Value._value` 私有字段（`:50`）；`Modal visible={visible}` 使退出动画不可见（`:55`，`:35-46` 是死动画）；`Dimensions.get('window')` 模块期固化（`:6`）；不扣安全区/键盘。D4 未列 BottomSheet，若需要应换 expo 官方或有维护的库 |
| `Toast.tsx`（85 行） | 废弃 | 自动隐藏 `setTimeout` 不清理、无队列（`:23-25`）：4 秒内第二条通知到达会被先到的隐藏回调一并清掉 |
| `TerminalView.tsx`（149 行） | 废弃 | ANSI 正则只匹配成对 `\x1b[m…\x1b[0m`（`:27`），未闭合/连续 SGR 码时转义字符泄漏；`parseAnsi` 每次渲染全量重解析（`useMemo` 导入未用，`:1`）；无调用点（死代码）。D4 终端流用桌面 `parseAnsi` 思想 + 行缓冲，不需要它 |

### 3.6 导航层（src/navigation/）

| 文件 | 评级 | 证据与问题 |
| --- | --- | --- |
| `RootNavigator.tsx`（21 行） | 废弃 | Boot→Login→AppDrawer 三层 Stack，`BootScreen.tsx:22-28` 固定 1500ms 模拟分流；`isAuthenticated` 变化重开定时器（`:29` effect 依赖）。D4 §5.0 的 AuthGuard 是"hydrated 判定 + 重定向"，语义不同 |
| `DrawerNavigator.tsx`（112 行） | 废弃 | 11 屏 Drawer 手配；`NavigationContainer` 未使用导入（`:3`）；6 屏 `drawerItemStyle: {display:'none'}` 隐藏（`:86-109`）。D4 用 expo-router Tabs+Stack（`(tabs)` 5 屏），组织模式不同 |
| `CustomDrawerContent.tsx`（190 行） | 废弃 | 依赖 Drawer 生态；`serverAddress.includes('192')` 类字符串判断（`SettingsScreen.tsx:87` 同款）脆 |

### 3.7 屏幕层（src/screens/，17 个文件）

| 文件 | 评级 | 证据与问题 |
| --- | --- | --- |
| `BootScreen.tsx` | 废弃 | 固定 1500ms 模拟启动（`:22-28`），无实际校验 |
| `LoginScreen.tsx` | 废弃 | **固定 PIN 0000**（`:31`）；生物识别假实现（`AuthService` 模拟） |
| `DevicePairingScreen.tsx` | 废弃 | 用户输入 6 位 OTP **从未使用**（`:18-19,30-34`）；1.5s 模拟"密码学握手"（`:34`）；QR 入口是 Alert 占位（`:73`）；配对成功文案宣称"cryptographically bound"（`:43`）与实际零加密矛盾。D4 §5.1 配对状态机（pairMachine）需全新实现 |
| `Dashboard.tsx` | 废弃 | 未注册死屏（MOBILE-01 §1.1），硬编码 hex 色（`:57` 等），与 token 脱节 |
| `DashboardScreen.tsx` | 废弃 | 空表时向 metrics 表注入 20 条 `Math.random()` 假数据（`:14-29`）——污染本地库，图表展示"编造遥测"；5s 同步轮询（`:41`）JS 线程阻塞模式 |
| `Settings.tsx` | 废弃 | 未注册死屏；Disconnect 按钮形同虚设（§3.1 重连三错） |
| `SettingsScreen.tsx` | 废弃 | "Auto-Failover enabled"是文案（`:77`，failover 未接线）；`Switch value={true}` 硬编码（`:117`）；`serverAddress.includes('192')` 字符串判断（`:87`） |
| `TaskHubScreen.tsx` | 废弃 | 任务双源发散：WS 写 zustand 内存、此屏读 DB（`:33-38`），`TaskRepo` 无写入方永不收敛（MOBILE-01 §4.3）；二次 `initDatabase()`（`:23`）；标题关键词猜图标（`:40-45`） |
| `ApprovalCenter.tsx` | 废弃 | 未注册死屏；决策乐观删除无服务端 ack（`:10-13`），`sendAction` 静默丢包时决策永久丢失 |
| `ChatStream.tsx` | 废弃 | 未注册死屏；`logs` 纯文本流无类型 |
| `EventStreamScreen.tsx` | 废弃 | 审批决策后**立即从 store 移除**（`:32`）无 ack；审计日志 id 用 `Math.random()`（`:36`）碰撞风险；`ScrollView` 全量渲染日志（`:84-112`）且 `scrollToEnd`（`:23-25`）无"吸底"判断，用户上翻被拽回；无 selector 整体订阅（`:14`） |
| `FileManagerScreen.tsx` | 废弃 | 文件树是模拟数据（`:29-37` `getSimulatedDirectoryContent`）；含**删除/编辑/重命名**操作面（`:58-72`），与 D4 权限矩阵（只读浏览，§5.7）直接冲突——D4 明确 v1 无编辑/删除 |
| `AgentChatScreen.tsx` | 废弃 | 聊天记录为写死 mock（`:30-34`）；agent 回复是 1.5s setTimeout 模板文案（`:59-71`）；D4 v1 明确不做移动端发起完整聊天（§1.3），此屏功能面出局 |
| `GlobalSearchScreen.tsx` | 废弃 | 查询不存在的 `workspaces.path` 列（`:52`，schema 无此列）；跨表搜索思路可借鉴（D4 未列全局搜索，v1 无此需求） |
| `MacroScreen.tsx` | 废弃 | 空表自动**种子假数据**（`:21-48`，含 `rm -rf node_modules` 宏）；多处裸 `JSON.parse` 无 try/catch（`:58,144,146`）；宏执行不在 D4 v1 范围 |
| `MacroBuilderScreen.tsx` | 废弃 | 同上，D4 v1 无宏能力 |

### 3.8 主题层（src/theme/）

| 文件 | 评级 | 证据与问题 |
| --- | --- | --- |
| `tokens.ts`（73 行） | **可用（最高分）** | 颜色/字体/阴影三段式 token 组织（`:1-28` 色板含 soft 变体、`:30-49` 字阶、`:51-72` 阴影三档），命名规范（textPrimary/textSecondary/textMuted、successSoft/dangerSoft），全仓约 80% 屏幕引用它而非硬编码。是原型里唯一"工程级"质量的资产 |

### 3.9 TypeScript 严格度总体评估

- `tsconfig.json`：`extends expo/tsconfig.base` + `"strict": true`（`:1-5`）——**开了 strict，方向对**。
- 但无 `noUncheckedIndexedAccess`、无 `exactOptionalPropertyTypes`，且**未接仓库基座**（D4 §9.3 要求 `extends ../../tsconfig.base.json`）。
- 实际代码面 strict 约束大量被绕过：`useNavigation<any>`（至少 6 屏）、`props: any`（`CustomDrawerContent.tsx:8`）、`payload: any`（`store/index.ts:18`）、`data: any`（`ws.ts:23,43,60`）、`handleMessage(data: any)`（`ws.ts:43`）、`event: any`（`HarmonyPushAdapter.ts:29,49`）。
- **评级：严格度"宣言达标、执行落空"**——tsc 不报错只是因为 `any` 把检查点全部打通。D4 的 `never` 穷尽、typed routes、领域模型零拷贝纪律在旧代码中完全不存在。

### 3.10 代码质量小结

- 47 个文件中：可用（思路）3 个（tokens、EmptyState、Header）、需重构 6 个（4 个 repo + NotificationService + IPushAdapter）、废弃 38 个（含 4 个未注册死屏、5 个无调用点服务/组件、3 个模拟占位服务）。
- P0/P1 缺陷与 MOBILE-01/02/03 完全同向，本审查独立复核无新增发现（三份审计已足够详实，本文 §4 起聚焦"去留"裁定）。

### 3.11 全文件评级汇总表（41 个源码文件，供主控速查）

| 目录 | 文件 | 评级 |
| --- | --- | --- |
| transport | ws.ts | 废弃 |
| store | index.ts | 废弃 |
| db | index.ts | 废弃（单例思想可参考） |
| db | schema.ts | 废弃 |
| db/repositories | AuditLogRepo.ts | 需重构（模式参考） |
| db/repositories | MacroRepo.ts | 需重构（模式参考） |
| db/repositories | MetricsRepo.ts | 需重构（模式参考） |
| db/repositories | TaskRepo.ts | 废弃（无调用点） |
| db/repositories | WorkspaceRepo.ts | 需重构（模式参考） |
| services | AuthService.ts | 废弃（假签名/假生物识别） |
| services | KeyManager.ts | 废弃（密钥明文存库） |
| services | NetworkStrategyEngine.ts | 废弃（未接线） |
| services | NotificationService.ts | 需重构 |
| services | LocalHardwareService.ts | 废弃（全模拟、无调用点） |
| services | TaskRunnerService.ts | 废弃（模拟 ack） |
| services/push | IPushAdapter.ts | 需重构（抽象面思路） |
| services/push | APNsPushAdapter.ts | 废弃（依赖体系更换） |
| services/push | FCMPushAdapter.ts | 废弃（firebase 弃用） |
| services/push | HarmonyPushAdapter.ts | 废弃（平台前提错误） |
| services/push | PushNotificationManager.ts | 废弃（无调用点） |
| components | BottomSheet.tsx | 废弃（私有 API/死动画） |
| components | EmptyState.tsx | 可用（思路） |
| components | Header.tsx | 可用（思路） |
| components | TerminalView.tsx | 废弃（死代码/ANSI 残缺） |
| components | Toast.tsx | 废弃（定时器竞态） |
| navigation | RootNavigator.tsx | 废弃 |
| navigation | DrawerNavigator.tsx | 废弃 |
| navigation | CustomDrawerContent.tsx | 废弃 |
| screens | BootScreen.tsx | 废弃（固定 1500ms） |
| screens | LoginScreen.tsx | 废弃（固定 PIN） |
| screens | DevicePairingScreen.tsx | 废弃（OTP 未用/模拟握手） |
| screens | Dashboard.tsx | 废弃（死屏） |
| screens | DashboardScreen.tsx | 废弃（假数据注入） |
| screens | Settings.tsx | 废弃（死屏） |
| screens | SettingsScreen.tsx | 废弃（文案宣称未接线） |
| screens | TaskHubScreen.tsx | 废弃（双源发散） |
| screens | ApprovalCenter.tsx | 废弃（死屏） |
| screens | ChatStream.tsx | 废弃（死屏） |
| screens | EventStreamScreen.tsx | 废弃（无 ack 决策/随机 id） |
| screens | FileManagerScreen.tsx | 废弃（模拟树/越权操作面） |
| screens | AgentChatScreen.tsx | 废弃（mock 聊天） |
| screens | GlobalSearchScreen.tsx | 废弃（查询不存在列） |
| screens | MacroScreen.tsx | 废弃（种子假数据） |
| screens | MacroBuilderScreen.tsx | 废弃（不在 v1 范围） |
| theme | tokens.ts | 可用（最高分） |
| types | hwpush.d.ts | 废弃（手写声明不可信） |

统计口径：src/ 共 47 个文件（components 5 + db 7 + navigation 3 + screens 17 + services 11 + store 1 + theme 1 + transport 1 + types 1），其中可用（思路）3、需重构 6、废弃 38。**无任何"改造复用"级文件**——评级最高的 tokens 也只是"新建时照思路重写"。

---

## 4. 可复用工程资产盘点（跨功能复用面）

不受功能设计影响、可被 D4 新工程借鉴的通用工程资产——**全部以"思路/模式"形式复用，不搬迁代码**（D4 §2.2 明确不读旧原型内部，实施时清理重建；此处仅供 M0 阶段设计参考）：

| # | 资产 | 来源 | 复用方式 |
| --- | --- | --- | --- |
| 1 | **主题 token 组织** | `theme/tokens.ts` | D4 未指定主题体系；建议新工程照此模式建 `ui/` token（色板含 soft 变体对状态色友好；字阶/阴影分档）。色值本身可保留（极简中性风），但需对齐桌面端 design tokens 做一次统一 |
| 2 | **repo 分层模式** | `db/repositories/*` | 静态类 repo + 参数化 SQL 的"每表一个 DAO"雏形与 D4 §4.4.1 DAO 结构同构；新工程改为：异步 API + 接口注入（可 mock）+ 事务边界 |
| 3 | **组件契约风格** | `EmptyState.tsx`/`Header.tsx` | 小组件"props 契约 + 空态 + token 化样式"的编写标准；D4 `components/ui/` 族可沿用此风格规范 |
| 4 | **通知观察者模式** | `NotificationService.ts` | listener 队列 + 应用内提示的轻量事件面，是 D4 前台 handler / EventBus（§3.3.2）的雏形；需补清理逻辑与持久化 |
| 5 | **目录分层习惯** | `src/` 九目录 | components/db/navigation/screens/services/store/theme/transport/types 的分层直觉正确，但 D4 采用 feature-first（§4.2），仅作对照参考 |
| 6 | **模块级单例 DB** | `db/index.ts:6-12` | 单写连接思想与 D4 §10.1 R8（单写连接）一致 |

**明确不可复用清单**（避免新工程误拾）：所有 setTimeout 模拟（6 处以上）、假数据注入（DashboardScreen/MacroScreen 2 处）、mock 密钥/签名（KeyManager/AuthService）、自造 WS 协议（ws.ts）、固定 PIN（LoginScreen）、明文 ws:// 端点（Settings/NetworkStrategyEngine）、任何 `.claude/` 与 AGENTS.md 配置（见 §5.4）。

---

## 5. 删除风险评估（连带损失核查）

### 5.1 git 跟踪面：零负担

- `git ls-files apps/crish-mobile` 实测：**0 个已跟踪文件**，整个目录 untracked。
- 根 `.gitignore` 的 `*.json` 规则还吞掉 `app.json`/`package.json`/`tsconfig.json`（MOBILE-02 §4 指出 `.gitignore:358`）——该目录**想入库都入不了**，删除不需要任何 git 操作。
- 删除执行：直接 `Remove-Item -Recurse` 目录即可（含 node_modules 一并清掉，释放体积），不产生 git 脏状态。

### 5.2 代码引用面：零依赖

- 全仓库 grep `crish-mobile`：**无任何 TS/TSX/JS/Rust 代码引用**该目录（grep 命中均为文档与目录自身）。
- 桌面端（crish-desktop/agent-workbench）、`packages/`、`crates/` 对该目录零 import——不构成删除连带损失。
- D1 §6.7 表格中"移动端应用 | Companion UI | `apps/crish-mobile/`（现有目录）| Transport/EventRouter/handlers 复用"——注意其"复用"指复用**桌面端**的 `Transport`/`EventRouter`/handlers 纯 TS 模块（D1 §6.6.2 明示），`apps/crish-mobile` 仅作目录落点；删除内部实现不影响该计划。

### 5.3 文档引用面：语义可维持

| 文档 | 引用方式 | 删除后影响 |
| --- | --- | --- |
| `docs/frontend-audit/40-final-plan/10-details/01-functional-repair-detail.md:17,231` | 把 crish-mobile 列为"并行域/未跟踪，不触碰" | 操作约定，删除后该域消失，约定不再适用，无冲突 |
| `docs/frontend-audit/30-reviews/03-code-fit-execution-review.md:224` | 同上 | 同上 |
| `docs/multi-device/plans/D4-mobile-tech.md:38,98,1411` | "仅保留目录位，实施时清空重建" | **一致**：删除内部实现正是"清空"的提前执行；M0 时 `create-expo-app` 重建目录即可 |
| `docs/multi-device/plans/D1/D2/D3/D5/D7/D8` | 引用目录名/落点 | 全部为"未来工程落点"语义，删除后由 M0 重建满足 |
| `docs/feature-gap-analysis/audits/MOBILE-01/02/03` | 三份审计记录原型问题 | **不受影响**（在 audit/ 目录，不在 crish-mobile/ 内）；且是删除决定的依据存档，建议保留 |

**结论：删除 `apps/crish-mobile` 目录后，唯一需要同步的文字面是 `D4-mobile-tech.md:38` 的"现有 apps/crish-mobile 为实验性 Expo 原型"表述可改为"已按 R2B 裁定整体删除，M0 重建"（低优先，不阻塞）。**

### 5.4 AGENTS.md / CLAUDE.md 指导价值评估

- `AGENTS.md` 全文 3 行："# Expo HAS CHANGED / Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code."——仅一条指向官方文档的提醒，无仓库特有规则，**无保留价值**（且该提醒的正确载体是 D4 的版本锁定纪律 §3.2.3）。
- `CLAUDE.md` 全文 1 行 `@AGENTS.md`——空引用。
- `.claude/settings.json` 71 字节（权限配置类），随目录删除，无价值。
- **裁定：全部随目录删除，无需抽取内容。**

### 5.5 删除风险评估汇总

| 面 | 结果 |
| --- | --- |
| git 操作 | 0 跟踪文件，直接删目录，无 git 状态变化 |
| 代码引用 | 0 处（全仓无 import） |
| 文档语义 | 与 D4"清空重建"一致；审计文档独立保存 |
| 指导文档 | AGENTS.md/CLAUDE.md 无内容可抢救 |
| 连带损失 | **零** |

---

## 6. 结论：删除 vs 保留

### 6.1 裁定：整体删除（保留目录位）

**删除**，理由链：

1. **与 D4 零兼容**：D4 是全新设计（expo-router/异步 sqlite/secure-store/7 store 域/WS 网关协议），旧代码是 react-navigation 手配 + 同步 sqlite + 自造协议 + 明文安全——任何"改造复用"的成本 ≥ 重写（D4 §0.3、§2.2 已定调"不继承内部实现"）。
2. **删除零代价**（§5：git/代码/文档三面无连带损失）。
3. **保留有成本**：目录内 node_modules 数 GB 级 + 未入库资产持续违反 AGENTS.md 资产保护铁律（MOBILE-03 P0-5 同向），存在"哪天被顺手提交进来"的污染风险。
4. **教训价值高于代码价值**：其暴露的 8 类问题（§7）已被三份审计 + 本文记录，删除不损失知识。

### 6.2 保留什么、放哪

| 保留物 | 位置 | 说明 |
| --- | --- | --- |
| 目录位 `apps/crish-mobile/` | 保留（空/或由 M0 `create-expo-app` 重建） | D4 §11.1 M0 的落点；D8 §5.1 有创建与白名单修正细则 |
| MOBILE-01/02/03 审计文档 | `docs/feature-gap-analysis/audits/` 原位 | 删除决定的依据存档 + 新工程对照清单 |
| 本文 R2B | `docs/multi-device/plans/` | 去留裁定 + 依赖逐项评估 + 警示清单 |
| 主题色板值（若采纳） | 由 M0 设计时从 R2B §4-1 引用 | 不搬代码，新工程重建 tokens |
| `LICENSE` | 随目录删除 | 项目根已有授权体系，无需保留 |

### 6.3 删除执行建议（给主控，非本 Agent 执行）

1. 确认工作区无进行中改动引用该目录（§5.2 已证无代码引用）。
2. `Remove-Item -LiteralPath "C:\Software\conex\apps\crish-mobile" -Recurse -Force`（untracked，无 git 操作；如谨慎可先删 `node_modules` 再删源码，规避深路径/长文件名问题）。
3. 删除后 `git status` 复核：应无任何变化（目录本就未跟踪）。
4. 低优先文字面：`D4-mobile-tech.md:38` 的"现有 apps/crish-mobile 为实验性 Expo 原型"可顺手更新为已删除状态。
5. M0 里程碑时按 D8 §5.1 重建（注意根 `.gitignore` 白名单修正：`!apps/crish-mobile/app.json` 等，防止新工程再次被 `*.json` 规则吞掉）。

---

## 7. 对新方案（D4 实施）的警示清单

从旧代码暴露的问题提炼，按"教训 → 旧代码证据 → D4 对应防线 → 缺口补充建议"组织：

### 7.1 安全占位教训（固定 PIN / 假装加密）

- 旧证据：`LoginScreen.tsx:31` PIN 硬编码 `'0000'`；`KeyManager.ts:23-24` mock PEM、`:49-76` 前缀字符串"加密"；`DevicePairingScreen.tsx:34` setTimeout 模拟握手后宣称"cryptographically bound"（`:43`）。
- D4 防线：配对一次性码 + 令牌轮换 + 证书固定（§6.1.5）、secure-store（§7.4）、seq 防重放（§6.1.5）。
- **补充建议**：验收清单增加"禁止 setTimeout 模拟安全原语"的代码审查规则；安全功能的评审以「能否经受抓包/重放攻击测试」为过门标准，而非"代码里有加密字样"。

### 7.2 骨架功能教训（模拟代替实现）

- 旧证据：agent 回复 1.5s 模板（`AgentChatScreen.tsx:59-71`）、任务 ack 1.5s（`TaskRunnerService.ts:74-80`）、遥测假数据（`DashboardScreen.tsx:14-29`）、宏种子数据（`MacroScreen.tsx:21-48`）。
- D4 防线：里程碑出口标准全部为真机全链路（§11.1）、关键路径门禁必测清单（§9.2）。
- **补充建议**：M0 起建立"模拟实现不得出现在已声明完成的模块"纪律；CI 中可加简单的"代码中禁止 `setTimeout` 伪装异步成功"的静态检查（或 review checklist），防止原型式占位回潮。

### 7.3 缺依赖起不来教训（react-native-svg）

- 旧证据：lucide 装而未装 peer `react-native-svg` → 启动崩（MOBILE-03 实测）；firebase 双包缺 `google-services.json` 构建必败；`app.json` plugins 未注册 expo-notifications。
- D4 防线：全部依赖 `npx expo install` 对齐（§3.2.3）、`expo-doctor` 强制（§9.4）、R1/R2 冒烟清单。
- **补充建议**：把「Expo Go / dev client 冷启动成功 + 首页渲染」纳入 CI 冒烟（哪怕只在 PR 的 dev build job 手动触发）；`app.json` plugins 与 dependencies 的一致性核对脚本（插件引了包、包就要在依赖里，反之亦然）。

### 7.4 DB 首启必崩教训

- 旧证据：`db/index.ts:21-25` 建表前读表 → 新装白屏，且无错误边界（`App.tsx:14`）。
- D4 防线：`PRAGMA user_version` 迁移范式（§7.3）、迁移幂等测试（§9.1）。
- **补充建议**：单测必须覆盖「从 v0 全新库逐级升到最新」路径（D4 §7.3 已有）；根布局必须有启动错误边界（SQLiteProvider 失败 → 可恢复提示而非白屏）。

### 7.5 死代码失控教训（UI 宣称 ≠ 实际能力）

- 旧证据：failover 引擎 150 行无接线（`NetworkStrategyEngine.ts`）、推送管理器 291 行无导入（`push/`）、4 个未注册死屏、"Auto-Failover enabled"是文案（`SettingsScreen.tsx:77`）。
- D4 防线：模块清单即目录结构（§4.3，无孤儿文件位）。
- **补充建议**：PR 门禁加"未引用文件检测"（如 eslint unused 或 CI 脚本扫描 `src/` 下无 import 的模块）；设置页/UI 文案的能力声明必须对应已接线模块（评审 checklist）。

### 7.6 自造协议教训

- 旧证据：`ws.ts:45-57` 消息类型 `task_update/new_approval/log` 与引擎事件体系零对齐；action 信封 `{action, payload}`（`ws.ts:60-66`）自造。
- D4 防线：命令面/事件面复用 shared-types + commandManifest（§2.1-1）、WsEnvelope 帧规范（§12.5）、契约漂移测试（§9.4）。
- **补充建议**：无需新增，D4 已覆盖；实施时坚持"先有 shared-types 类型，后有移动端消费"的次序。

### 7.7 重连三连错教训

- 旧证据：`ws.ts:7-12,30-36,68-74`（断开必重连、双连接互踩、无退避）。
- D4 防线：`ReconnectingWsClient` 代际管理 + 指数退避 + 相位投影（§6.2）。
- **补充建议**：把「手动断开不得自动重连」「切换端点不得产生双连接」写进 ReconnectingWsClient 的单测（D4 §9.2 相位映射表之外，补这两条生命周期用例）。

### 7.8 未入库教训（资产保护）

- 旧证据：整个目录 untracked（MOBILE-03 P0-5）；根 `.gitignore:358` 的 `*.json` 规则吞掉 app.json/package.json/tsconfig.json，**想入库都入不了**。
- D4/D8 防线：D8 §5.1 白名单修正清单（`!apps/crish-mobile/app.json`、`!apps/crish-mobile/**/tsconfig*.json` 等）。
- **补充建议**：M0 验收项增加"`git check-ignore -v apps/crish-mobile/package.json` 必须返回空（未被忽略）"，从第一天杜绝新原型重蹈覆辙；根 .gitignore 的 `*.json` 全局规则本身建议重构为精确路径规则。

### 7.9 附带提醒（超出上述分类）

- **双源发散**（store/DB 任务模型漂移，MOBILE-01 §4.3）：D4 以"数据层先落 SQLite 再通知 store"的纪律规避（§4.4.4），实施时严格遵守"单一数据源"。
- **同步 API 主线程阻塞**（MOBILE-01 §6）：D4 全部异步 API + 批量落库（§6.7），实施时禁止 `*Sync` 出现在数据热路径。
- **`any` 泛滥**（§3.9）：D4 的 strict + `never` 穷尽 + typed routes（§9.3）是旧代码的对症药，实施时把 typecheck 门禁从 M0 开始启用（旧代码有 strict 但没门禁脚本，等于没有）。

---

## 8. 证据附录

### 8.1 关键文件:行号索引（本审查引用）

| 主题 | 位置 |
| --- | --- |
| 依赖清单 | `apps/crish-mobile/package.json:5-29` |
| app.json 插件（firebase 双插件无配置、缺 notifications） | `apps/crish-mobile/app.json:24-28` |
| tsconfig（strict 但未接仓库基座） | `apps/crish-mobile/tsconfig.json:1-5` |
| DB 首启必崩 | `apps/crish-mobile/src/db/index.ts:21-25,50-53`；`App.tsx:12-15` |
| DB 迁移机制缺失 | `apps/crish-mobile/src/db/index.ts:27-47` |
| 自造 schema（与桌面端零对应） | `apps/crish-mobile/src/db/schema.ts:5-63` |
| 重连三连错 | `apps/crish-mobile/src/transport/ws.ts:7-12,30-36,60-74` |
| 自造协议消息类型 | `apps/crish-mobile/src/transport/ws.ts:45-57` |
| 固定 PIN 0000 | `apps/crish-mobile/src/screens/LoginScreen.tsx:31` |
| OTP 未使用 + 模拟握手 | `apps/crish-mobile/src/screens/DevicePairingScreen.tsx:18-19,30-38` |
| mock 密钥存 SQLite | `apps/crish-mobile/src/services/KeyManager.ts:19-43` |
| 假签名/假生物识别 | `apps/crish-mobile/src/services/AuthService.ts:28-34,42-48` |
| 假数据注入遥测 | `apps/crish-mobile/src/screens/DashboardScreen.tsx:14-29` |
| 死屏清单 | `src/screens/{Dashboard,Settings,ChatStream,ApprovalCenter}.tsx` |
| 无调用点服务 | `NetworkStrategyEngine.ts`、`push/PushNotificationManager.ts`、`TerminalView.tsx`、`LocalHardwareService.ts`、`TaskRunnerService.ts`（部分） |
| 主题 token（唯一高分资产） | `apps/crish-mobile/src/theme/tokens.ts:1-73` |
| repo 模式雏形 | `apps/crish-mobile/src/db/repositories/{AuditLogRepo,TaskRepo,WorkspaceRepo,MacroRepo,MetricsRepo}.ts` |
| git 跟踪状态 | `git ls-files apps/crish-mobile` = 空 |
| 根 .gitignore `*.json` 吞文件 | 根 `.gitignore:358`（MOBILE-02 §4 指出） |

### 8.2 已有审计对照

- `docs/feature-gap-analysis/audits/MOBILE-01-architecture.md`：架构级缺陷全量（P0 两项：DB 首启崩、链路空壳）。
- `docs/feature-gap-analysis/audits/MOBILE-02-security.md`：安全面（固定 PIN、明文 WS、密钥明文存库、无依赖审计、未入库）。
- `docs/feature-gap-analysis/audits/MOBILE-03-features-stack.md`：功能/选型面（react-native-svg 缺失实测、未入库 P0-5）。
- 本审查与之结论全同向，无冲突；差异仅在本审查补充了"去留裁定 + 依赖逐项对照 D4 + 删除风险评估 + 警示清单"。

### 8.3 审查边界声明

- 只读：未修改任何仓库文件；唯一写产物为本文档。
- 未执行 git 写操作、未安装/删除依赖、未运行构建。
- 本审查基于静态代码阅读 + git 状态 + 已有审计交叉验证；未在真机/模拟器运行原型（任务书背景已定性其无法启动，无需复验）。
