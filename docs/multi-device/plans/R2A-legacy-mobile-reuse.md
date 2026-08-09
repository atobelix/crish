# R2A 移动端旧代码去留评估（借鉴价值评估）

- 文档编号：R2A
- 角色：移动端旧代码去留评估子代理
- 日期：2026-08-09
- 审查对象：`C:\Software\conex\apps\crish-mobile`（纯实验性原型，无 git、无测试）
- 设计基准：`docs/multi-device/plans/F1-monitor-panels.md` ～ `F6-settings-account.md`（完整通读）
- 桌面端可复用面对照：`apps/crish-desktop/src/`（组件/纯函数，见 F1-F6 各域盘点章节）
- 方法：只读分析；逐文件审查 → 对照 F1-F6 → 分类（A 直接可借鉴 / B 思路可借鉴 / C 无用）→ DB schema 评估 → 去留结论 → 借鉴参考条目

---

## 0 结论速览

1. **A 类（直接可借鉴）：1 项** —— `components/EmptyState.tsx`（三要素空态组件，与 F1 §4.7 空态规范完全契合，约 30 行，可直接照抄）。
2. **B 类（思路可借鉴）：10 项** —— 推送多平台适配器体系、网络多端点健康计数通道管理、硬件感知行为调节、应用内通知中心、底部弹层交互、ANSI 转义渲染思路、设置分组行式骨架、SQLite 版本迁移 + repository 模式、审批历史表雏形、审批决策交互链。**全部以本文档「借鉴参考」条目形式保留，不复制代码。**
3. **C 类（无用）：其余约 30 项** —— 全部假加密/安全实现（KeyManager/AuthService/PIN/明文 WS）、全部 mock 数据屏幕、宏功能、审计本地库、旧版重复屏幕等。
4. **去留结论：建议整个 `apps/crish-mobile/` 目录删除（不保留任何文件进入新项目）。** 理由：无 A 级成品、安全实现全部作废、F1-F6 已全覆盖旧功能且有更优方案、无 git 无测试不满足工程准入、保留 = 维护负担 + 误导风险。
5. **最有价值的借鉴点（新设计启发）**：
   - **多端点健康计数 + 策略过滤的通道管理器**（`NetworkStrategyEngine.ts`）——F6 §7.1「自动/仅局域网/仅云中继」与 F1 §5.4 重连状态机的落地细节补充；
   - **电量/网络质量感知的行为调节层**（`LocalHardwareService.ts`）——F1 轮询策略与 F3 省电层的候选补充（电池档位降级）；
   - **多推送平台适配器接口（含 HarmonyOS HMS）**——F1/F2/F3/D7 均未定义客户端推送层结构，旧代码的 IPushAdapter 模式是现成骨架；
   - **「预设工作流一键执行」（Macro）是 F1-F6 的功能盲区**——可作为 P3 候选（建立在 F5 P2 委托执行之上），旧实现不可复用。

---

## 1 评估范围与方法

### 1.1 审查对象

`apps/crish-mobile/` 共 48 个源码文件（src 下 44 + App.tsx/index.ts 等）。git 状态：**整个目录未被跟踪**（`git status` 显示 `?? apps/crish-mobile/`），与任务定性一致（几小时搭建、无 git、无测试资产）。

### 1.2 技术栈（package.json）

Expo 57 + React Native 0.86 + expo-sqlite + zustand + @react-navigation（stack/drawer）+ lucide-react-native + @react-native-firebase/messaging + expo-notifications + @hmscore/react-native-hwpush。

与 D4 移动端技术选型的交集：expo-sqlite（F 方案已定）、zustand（F3/F6 均引用 zustand 风格 store）、react-navigation（F1 §4.1 底部 Tab 导航仍需）。技术选型层面旧代码**零误导**，无弃用项。

### 1.3 审查口径

- 分类标准：A=实现质量好、与新设计契合、可直接复制或近乎复制；B=实现有缺陷但设计思路值得参考（记录「借鉴参考」条目）；C=与新设计无关/质量太差/已被 F1-F6 更好方案覆盖。
- 对照基准：新功能设计 F1-F6 的功能清单、信息架构、状态机、安全边界；桌面端已冻结契约（F1 §2 命令/事件盘点）为新移动端的数据真源，旧代码的本地数据模型一律以「与桌面契约对照」判定。
- 安全基线（docs/rust-rewrite/31-security-baseline.md）：移动端是低信任终端；假加密、硬编码凭据、明文传输一律按安全缺陷处理（C 或 B 且必须重写）。

---

## 2 旧代码全景盘点

| 模块 | 文件 | 行数 | 一句话现状 | 分类 |
|------|------|------|-----------|------|
| 根 | App.tsx | 31 | DB 初始化 + RootNavigator + 全局 Toast | C |
| db | schema.ts | 106 | 6 张表（workspaces/tasks/audit_logs/key_value_store/metrics/macros） | C（个别思路 B，见 §5） |
| db | index.ts | 54 | expo-sqlite 单例 + key_value_store 版本迁移 + 默认工作区种子 | B（迁移/种子思路） |
| db | repositories/ ×5 | ~130 | 静态类 CRUD 薄封装 | B（repository 模式思路） |
| store | index.ts | 103 | 单例 zustand store（tasks/approvals/logs/preferences） | C |
| transport | ws.ts | 77 | 原生 WebSocket + 固定 5s 重连 + 消息类型分派 | C |
| services | KeyManager.ts | 95 | 假 RSA（mock 密钥存 SQLite）+ 「ENCRYPTED::」伪加密 | C（安全作废） |
| services | AuthService.ts | 58 | 假生物识别（恒 true）+ 假签名 | C（安全作废） |
| services | NetworkStrategyEngine.ts | 150 | 多端点健康计数 + 策略过滤 + 延迟排序 + 主动 ping 框架 | B（启发点 #1） |
| services | NotificationService.ts | 75 | 应用内通知中心 + 监听者 + toast 触发 | B |
| services | LocalHardwareService.ts | 79 | 电池/网络质量 → 低功耗模式/块大小调节 | B（启发点 #2） |
| services | TaskRunnerService.ts | 99 | 宏步骤执行（超时/中止），模拟回执 | C |
| services/push | IPushAdapter.ts + FCM/APNs/Harmony 三适配器 + Manager | ~113 | 多平台推送统一接口 + 前台/后台分叉 | B（启发点 #3） |
| components | BottomSheet.tsx | 98 | Animated 底部弹层（backdrop/handle/heightRatio） | B |
| components | Header.tsx | 64 | 抽屉/返回双模式头部 + 右侧动作 | C |
| components | EmptyState.tsx | 50 | 三要素空态（icon/title/description） | **A** |
| components | TerminalView.tsx | 149 | 终端外观 + 基础 ANSI 颜色解析（正则分段 → Text span） | B |
| components | Toast.tsx | 85 | 全局 toast（滑动 + 自动隐藏 + 监听通知中心） | B（并入通知中心条目） |
| navigation | RootNavigator/DrawerNavigator/CustomDrawerContent | ~350 | Boot → Login → 抽屉导航；登录门禁 + 抽屉内容自定义 | C |
| screens | EventStreamScreen.tsx | 226 | 日志流 + 审批胶囊 + 弹层决策 + 命令输入 + 写本地审计 | B（审批决策链思路） |
| screens | ApprovalCenter.tsx | 93 | 待审批列表 + 决策按钮 + 空态 | C |
| screens | DashboardScreen.tsx | 156 | 假遥测数据种子 + 柱状图 | C |
| screens | Dashboard.tsx（旧版） | 72 | store tasks 进度条 | C |
| screens | ChatStream.tsx | 48 | 日志气泡流 | C |
| screens | TaskHubScreen.tsx | 152 | 本地 workspace/tasks 列表 + 下拉 + FAB | C |
| screens | FileManagerScreen.tsx | 212 | mock 目录树 + 面包屑 + 操作弹层（含删除/重命名） | C |
| screens | DevicePairingScreen.tsx | 181 | 扫码入口（占位）+ IP/6 位码手动配对 | C（双通道交互与 F6 巧合一致） |
| screens | LoginScreen.tsx | 101 | 4 位 PIN 键盘，**硬编码 0000** | C（安全作废） |
| screens | BootScreen.tsx | 49 | 启动动画 + 登录门禁跳转 | C |
| screens | GlobalSearchScreen.tsx | 213 | 跨表 LIKE 搜索（防抖 300ms）+ 快捷动作 | C |
| screens | AuditLogsScreen.tsx | 172 | 本地审计列表 + 详情弹层 + **一键清空** | C（反面教材） |
| screens | MacroScreen / MacroBuilderScreen | ~430 | 宏 CRUD + 步骤编辑器 + 执行 | C（功能盲区观察，见启发点 #4） |
| screens | SettingsScreen.tsx | 241 | 分组行式设置（连接/安全开关/偏好） | B（布局骨架思路） |
| screens | Settings.tsx（旧重复版） | 81 | SettingsScreen 的简化重复 | C（重复代码） |
| theme | tokens.ts | 73 | 设计 token（colors/typography/shadows） | C（结构可参考，色板作废） |
| types | hwpush.d.ts | 252 | HMS 类型声明 | C |

---

## 3 逐文件审查详述

### 3.1 db 层（schema.ts / index.ts / repositories/ ×5）

**现状**：`initDatabase()` 用 `withTransactionSync` 原子执行建表，版本存 `key_value_store` 表，低版本时重放 `INIT_QUERIES`（全部 `CREATE TABLE IF NOT EXISTS`）+ 写入版本号 + 种子默认工作区。5 个 repository 均为静态类 + 参数化 SQL。

**技术债**：
- schema 与桌面/新设计的数据真源完全错位：tasks 表存本地任务（新设计活动任务 = `core_get_status.activeRuns` 派生，F1 §5.2「派生量，不做独立存储」）；metrics 表存 CPU/RAM 遥测（F1 §4.5「手机端不做本机历史持久化，只消费网关缓存」——旧表是直接反例）；workspaces 表本地实体化（F4：工作区列表 = `workbench_list_workspaces` 命令缓存，根授权只在桌面端）。
- `App.tsx` 未 await 初始化（fire-and-forget），页面里又各自调用 `initDatabase()`（TaskHubScreen:23），初始化入口混乱。
- 无迁移脚本框架（只有「低版本重放全部建表」），无索引策略、无清理策略（MetricsRepo.cleanupOldMetrics 存在但无人调用）。

**可借鉴思路**（B）：① `key_value_store` 存 schema_version + 事务内迁移循环——新移动端 expo-sqlite 本地缓存层（F5 会话缓存 + 未读游标 + F2 历史表 + F6 本机偏好）必然需要同款版本管理，此模式可直接照搬；② 静态 repository 薄封装模式（每表一个 repo，参数化 SQL）对新本地缓存层仍是正确分层；③ audit_logs 表形状见 §5.2。

### 3.2 transport/ws.ts + store/index.ts

**现状**：单例 WebSocket，onopen/onmessage/onclose/onerror 全挂载；`handleMessage` 按 `data.type` 字符串分派到 zustand；固定 5s 重连；`sendAction` 带 readyState 守卫。store 是单例扁平 store（tasks Record / pendingApprovals 数组 / logs 环形 100 / 三个偏好布尔）。

**问题**：无鉴权、无心跳、无序列号/幂等（重复消息会重复入队）、无背压分级、重连无退避、`logout()` 硬编码回 `ws://192.168.1.100:8080`；store 单例无法支撑多域（F6 §4.2 要求 mobileSettingsStore 分片：session/pairing/connection/notify/appearance/privacy/mirror；F3 §3.0 要求 feedStore 独立状态机）。

**判定**：C。消息类型分派 + store 联动本身是正确形态，但 F3 §3.0「消费面纯函数化 + 存储面折叠 + 渲染面解耦」四层模型与 F1 §5.4 连接状态机已给出更完整设计，旧代码无增量价值。zustand 选型本身与新设计一致（F3/F6 均引用），属「碰巧对路」不构成借鉴项。

### 3.3 安全相关（KeyManager / AuthService / LoginScreen / DevicePairingScreen / ws 明文）

**现状**：全部为假安全：
- KeyManager：mock RSA 字符串（含 `[REDACTED_MOCK_PRIVATE_KEY]` 字样）明文存 SQLite `key_value_store`；「加密」= `ENCRYPTED::` + encodeURIComponent；「签名」= 随机串。
- AuthService：生物识别恒返回 true；fallback PIN 恒 true；签名随机串。
- LoginScreen：4 位 PIN 键盘，**硬编码 `'0000'` 即放行**（LoginScreen.tsx:31）。
- DevicePairingScreen：`ws://${ip}:8080` 明文 WS 直连，握手为 1.5s 假延时。
- 全部注释均自认「In a real app, would use…」（模拟实现）。

**判定**：C，且为安全基线的直接违反项（假加密比不加密更危险——制造「已加密」错觉）。F6 §5.2 明确：令牌存 Keystore/Keychain 绝不落明文（对齐桌面 DPAPI 精神 credentials.rs:3-6）；D5 安全域定义认证/令牌/加密/会话失效。**新移动端一律不得引用此三文件任何代码**（含注释中的「思路」，因全部是占位）。

### 3.4 NetworkStrategyEngine.ts（B，启发点 #1）

**现状**：单例引擎维护端点注册表 `[{url, type: lan|tailscale|cloud, priority, lastLatencyMs, failures}]`；`getValidEndpoints()` 按策略过滤（auto 模式剔除 ≥3 连败端点并按延迟排序）；`recordFailure/recordLatency` 健康计数；10s 主动 ping 框架；`resetHealthCounters` 手动重置。

**问题**：端点是硬编码（`ws://192.168.1.100:8080`、`wss://relay.conex.app/ws` 等）；ping 是模拟；无指数退避时序；无配对/认证联动。

**借鉴价值**（思路层面高）：F6 §7.1 定义了连接方式三态（自动/仅局域网/仅云中继）与切换规则，F1 §5.4 定义了 disconnected→connecting→connected⇄reconnecting 状态机，但**都没定义「通道管理器」内部如何维护多端点的健康状态**。旧代码的「每端点失败计数 + 阈值剔除 + 延迟优先排序 + 策略过滤」是一套可直接借鉴的启发式：新连接的通道管理器可按此实现（端点来源改为配对注册表 + 中继地址下发，替换硬编码；健康判定用真实心跳；剔除阈值与 F1 指数退避 1/5/15/30s 合并）。详见 §7 借鉴条目 J2。

### 3.5 LocalHardwareService.ts（B，启发点 #2）

**现状**：60s 电池检查（<20% 且未充电 → 低功耗模式）+ 网络质量评估（ping → excellent/good/poor）+ `shouldThrottleAnimations()`（低功耗或 Android <28 节流动画）+ `getOptimalChunkSize()`（按质量给 2MB/512KB/64KB 分块）。

**问题**：电池/网络全部模拟值；仅提供建议无实际接线。

**借鉴价值**：F3 §7.3 省电三方面（渲染节能/网络节能/生命周期节能）与 F1 §3.3 轮询节流（visibility 判据）均未引入「设备硬件状态档位」。旧代码提供了一个 F-docs 未覆盖的维度：**电量档位驱动行为降级**（低电量 → 轮询降频/禁动画/合并写入更激进）。可作为 F1 轮询策略（T43 弱网降级 4s→15s 之外再补电池档）与 F3 渲染节能层的候选输入。新实现用 expo-battery/expo-network 真值。详见 §7 借鉴条目 J3。

### 3.6 NotificationService + Toast + push 适配器体系（B，启发点 #3）

**现状**：
- `NotificationService`：内存队列 + 监听者注册 + pushNotification（type: info/warning/critical）+ 同时写进全局 logs + 触发 toast。
- `GlobalToast`：监听通知中心 → 顶部滑入 toast → 4s 自动隐藏。
- push/ 目录：`IPushAdapter` 接口（requestPermission/getToken/onMessageReceived/setBackgroundMessageHandler 四个方法）+ FCM 适配器（@react-native-firebase/messaging 模块化 API）+ APNs 适配器（expo-notifications 原生 token）+ **HarmonyOS 适配器（@hmscore/react-native-hwpush，HMS Push Kit）** + `PushNotificationManager`（按 Platform.OS 选适配器，前台 → 应用内 toast，后台 → 系统通知）。

**问题**：无事件序列号去重（F2 §6.3 要求 toolCallId 为通知键、sequence 幂等）；无深链路由（F1 §7.6 / F2 §6.2 conex:// 深链）；无场景级开关（F6 §10）；APNs 后台 handler 未真正接线；前台/后台分叉只到 toast 层。

**借鉴价值**（思路层面高）：F1-F6 与 D7 均只定义了推送的服务端语义与触发点清单，**客户端多平台适配层结构完全未定义**。旧代码的「统一 IPushAdapter 接口 + 按平台选适配器 + 前台应用内/后台系统通知分叉」正是新移动端推送层该有的骨架，且含大多数 RN 项目缺失的 **HarmonyOS/HMS 分支**（D7 未提及 Harmony，若产品面向国产机此分支有价值）。新实现须补：sequence/toolCallId 幂等键、深链路由表、F2 §6.3 通知 tag/合并、F6 §10.1 场景级开关与静默时段。详见 §7 借鉴条目 J1。

### 3.7 通用组件（BottomSheet / Header / EmptyState / TerminalView）

- **EmptyState（A）**：props = {icon, title?, description}，居中布局。与 F1 §4.7 空态规范（插画 + 主文案 + 副文案）逐项对应，且 F-docs 规定的空态文案（「当前无活动任务」「暂无用量数据」「还没有会话…」等）正是此组件的语义。代码干净（50 行、无副作用、无外部依赖除 tokens）。**新移动端可直接照抄此组件**（或按新色板微调）。唯一注意：F1 要求空态随主题切换插画，可在原组件上扩展。
- **BottomSheet（B）**：RN Modal + Animated（nativeDriver）实现 backdrop（点击关闭）+ handle 条 + 关闭按钮 + heightRatio + ScrollView 内容。F2 理由面板/批量确认层、F4 长按上下文菜单、F6 底部半屏弹层均需要同款交互。新实现建议用 reanimated + gesture-handler（D4 技术栈）重写并加「滑动关闭」手势（旧实现不支持拖动关闭，属缺口）。见 §7 借鉴条目 J4。
- **Header（C）**：抽屉/返回双模式。F1 §4.1 已定义顶部导航规范（连接状态条恒在状态栏下方 + 「← 返回」+「刷新」），且底部 Tab 导航取代抽屉，旧 Header 语义（drawer 模式）作废。
- **TerminalView（B）**：以正则 `/\x1b\[(\d+)m(.*?)\x1b\[0m/g` 分段 ANSI 颜色 → RN Text span 嵌套渲染。F3 §4.0 TerminalLineBuffer 规格明确「ANSI 转义码剥离后渲染（SGR/光标/清屏三类，手写 30 行内），色彩由主题统一表达」——旧实现是「ANSI 颜色直映」而非剥离，与 F3 主路径相反。但作为**降级方案/终端样式参考**（深色底、等宽、行渲染结构）有参考价值：若 F3 实现发现主题色无法覆盖某些输出（如进度条着色），旧代码的正则分段渲染思路可直接升级为 F3 的剥离器（把「识别颜色段」改为「识别并丢弃转义段」）。见 §7 借鉴条目 J5。

### 3.8 导航（RootNavigator / DrawerNavigator / CustomDrawerContent）

**现状**：Boot（1.5s 动画 + 登录门禁）→ Login → AppDrawer（抽屉导航，11 个屏，多数隐藏抽屉项 + 自定义抽屉内容：连接状态卡 + 分组 + 登出）。

**判定**：C。与 F1 §4.1 冲突面明确——新设计是**底部固定 Tab（首页 | 会话 | 用量 | 诊断）+ 栈导航**，审批走深链不进 Tab；抽屉式导航被否决。登录门禁形态被 F6 §5.1 否决（登录不是硬门槛，访客模式可局域网直连）。BootScreen 的「启动 → 引导」形态可映射到 F6 §12.2 首次使用配对向导，但 F6 已给出完整向导设计，旧代码无增量。

### 3.9 屏幕逐项

- **EventStreamScreen（B，审批决策链思路）**：日志流（scrollToEnd 自动跟随）+ 审批胶囊行（icon + description + 点击开弹层）+ 弹层决策（Reject/Approve）+ 决策后写本地审计 + 移除待办 + 底部命令输入。**审批决策链「条目 → 详情弹层 → 决策 → 落历史 → 移除」与 F2 的流程形状一致**（F2 §4 待办列表 → §5 详情决策 → §7 历史），且「决策后立即写历史」正是 F2 要求的本地历史落库动作——这是旧代码与 F2 设计最契合的一条交互链，可作 F2 实现时的流程验证参考。日志流部分是 C（纯字符串数组，F3 feed 完全取代）。见 §7 借鉴条目 J6。
- **ApprovalCenter（C）**：F2 审批中心全面取代（无倒计时、无危险级别、无冲突处理、无历史、无 arbiter 区分）。空态文案「Your agents are running autonomously」与 F2 §4.3 空态语气近似，属巧合。
- **DashboardScreen / Dashboard / ChatStream（C）**：假遥测种子数据（DashboardScreen:16-29 主动向 SQLite 灌随机数据）——与 F1 诚实化原则（无数据不显示 0% 误导、不伪造数据）直接冲突，是**反面教材**；F02 核心状态卡 + F07 用量摘要取代。
- **TaskHubScreen（C）**：本地 tasks 表 + 工作区下拉 + FAB。F03 活动任务（activeRuns 派生）+ F4 工作区列表（命令缓存）取代。工作区下拉交互（顶部选择器 + 下拉菜单）与 F4 §6.1 工作区列表页交互略似，但 F4 设计已定（卡片列表 + 长按菜单），无增量。
- **FileManagerScreen（C）**：mock 目录树（`getSimulatedDirectoryContent` 伪造 `config_${depth}.json`、`.env.local` 等）+ 面包屑 push 导航 + 操作弹层（**含删除/重命名/编辑**，经假签名发 `fs_mutation`）。F4 全面取代（真实 `list_directory/read_file_content` 命令桥 + relPath 校验 + 敏感文件规则 + 写操作四闸门）；且旧代码开放的删除/重命名正是 F4 §4.3「明确不开放（V1）」的反例。面包屑 + push 导航交互与 F4 §6.2 巧合一致，但 F4 已完整设计，无借鉴价值。
- **DevicePairingScreen（C）**：扫码入口（Alert 占位）+ IP/6 位码手动表单 + 假握手。**「扫码入口 + 手动输码兜底」的双通道结构与 F6 §6.1（局域网扫码优先 + 云中继配对码）巧合一致**，可视为 F6 设计的直觉验证；实现（假握手、明文 WS、密钥假生成）全部作废。
- **LoginScreen（C）**：见 §3.3，硬编码 PIN，安全作废。F6 §5 账户体系（登录非门槛、设备码登录、会话过期降级访客）取代。
- **GlobalSearchScreen（C）**：跨本地表 LIKE 搜索（防抖 300ms）+ 快捷动作。新设计搜索能力 = F5 §2.6（标题本地过滤 + 会话内已加载消息匹配 + P2 服务端搜索）+ F6 §12.5（设置搜索一级交互，防抖 150ms）。旧代码搜索的**数据源（本地 SQLite 表）在新设计中不存在**（任务/审计/工作区都不是本地实体），故整体作废；「防抖 + 空态 + 快捷动作」交互属 RN 常识。
- **AuditLogsScreen（C，反面教材）**：本地审计列表 + 详情弹层 + **一键清空审计日志**（clearAllLogs）。新设计 F15 审计列表（P2）数据源 = `security-audit` 事件（网关缓存），只读展示；审计可被用户一键清除是**安全反模式**（审计的意义在于不可篡改可溯源），新移动端禁止出现该入口。
- **MacroScreen / MacroBuilderScreen（C，功能盲区观察）**：宏 CRUD + 步骤编辑器（命令 + 超时）+ 执行（TaskRunnerService）。F1-F6 **没有任何宏/预设工作流功能**（F14 定时概览是只读 P2）。这是一个真实的功能盲区观察：若产品后续需要「手机一键执行预设命令序列」，应建立在 F5 P2 委托执行之上（网关转发 run + 审批路由），旧实现（无鉴权、模拟回执、本地存储）不可复用。见 §4 启发点 #4。
- **SettingsScreen（B，布局骨架）**：分组卡片式设置（sectionTitle + 分组卡 + 行 = icon + title + sub + Switch/Chevron）+ 身份卡 + 行内编辑网络端点 + 清除缓存（二次确认）。**行结构与 F6 §12.6 设置首页规范逐项吻合**（图标 + 标题 + 当前值摘要 + 右侧箭头/开关；单页滚动 ≤2 屏；行内当前值摘要减少进二级页次数）。可作新设置页的视觉骨架母本。但**内容项全部违反 F6 归属矩阵**：autoApprove/strictMode 开关（F6 §8：权限模式只读镜像，禁止远程改——旧代码把权限相关做成手机端开关是反例）；Tailscale 开关硬编码 true（SettingsScreen:117）。见 §7 借鉴条目 J7。
- **Settings.tsx（C）**：SettingsScreen 的简化重复（同一工程两份设置屏，暴露原型无治理的事实）。

### 3.10 theme/tokens.ts

**判定**：C。设计 token 分层（colors/typography/shadows 三件套）是 RN 标准实践，新项目照例（不构成借鉴项）；色板本身（浅色 #FAFAFC 系）与 F1 §4.7 深色优先规范（背景 #0F1115 / 卡片 #1A1D24 / 分隔线 #262A33 + 深浅两套）冲突，作废。

---

## 4 对比 F1-F6：启发点清单（旧代码有、新设计未覆盖或可补充的）

按价值排序：

| # | 启发点 | 来源文件 | F1-F6 对应缺口 | 处置建议 |
|---|--------|----------|----------------|----------|
| 1 | **多端点健康计数 + 阈值剔除 + 延迟排序的通道管理器** | NetworkStrategyEngine.ts | F6 §7.1 连接方式三态与切换规则已定，但未定义通道管理器内部的多端点健康维护机制 | 移交 D6/D7（或 F6 连接设置实现组）参考：端点来源 = 配对注册表 + 中继地址，健康判定 = 真实心跳，剔除阈值 3 连败可保留，与 F1 指数退避合并 |
| 2 | **电量/硬件状态感知的行为降级层** | LocalHardwareService.ts | F1 §3.3 轮询节流只有 visibility 判据；F3 §7.3 省电无电池档位 | 建议 F1 实现组评估「低电量 → 轮询 4s→15s、动画禁用、合并窗口放大」档位；T43 弱网降级可扩展为「弱网或低电量」双触发 |
| 3 | **推送客户端多平台适配层（含 HarmonyOS HMS 分支）** | services/push/ | D7 定义服务端语义与触发点；F1-F6 均未定义客户端推送层结构 | 新移动端推送层按 IPushAdapter 接口结构实现；补 sequence/toolCallId 幂等（F2 §6.3）、深链路由（F1 §7.6）、场景级开关（F6 §10.1）；Harmony 分支是否保留由 D7/产品定 |
| 4 | **预设工作流一键执行（宏）是 F1-F6 功能盲区** | MacroScreen/MacroBuilder/TaskRunnerService | F1-F6 无「预设命令序列一键执行」功能；F14 定时概览只读 | 观察项：若产品需要，作为 P3 候选（基于 F5 P2 委托执行 + 网关转发 run + 审批路由实现）；旧实现不可复用（无鉴权、模拟回执） |
| 5 | **审批决策后立即写本地历史的动作顺序** | EventStreamScreen.tsx:27-48 | F2 §7.1 历史来源第 1 条（approval-resolved 实时入历史）已有，但「决策动作内联落历史」的 UI 顺序（决策 → 落库 → 移除 → 反馈）可作 F2 实现参考 | 作为 F2 实现时的流程验证（E2E-1 断言链） |
| 6 | **在 feed 内联审批胶囊的呈现方式** | EventStreamScreen.tsx:94-112 | F3 §2.5 已把 approval 态设计为「feed 工具卡置 pending_approval 态」——旧代码的胶囊式内联与此语义一致 | 验证 F3 设计直觉，无新增 |
| 7 | **设置页「行内当前值摘要」** | SettingsScreen.tsx | F6 §12.6 已有规范（行内显示当前值摘要减少进二级页） | 验证 F6 设计直觉，无新增 |

反例警示（旧代码违背新设计原则之处，新实现须回避）：① 审计日志一键清空（AuditLogsScreen）——审计不可清除；② 假数据灌库（DashboardScreen 种子）——诚实化原则禁止；③ 权限/安全开关裸露在手机设置页（autoApprove/strictMode）——F6 §8 只读镜像；④ 本地实体化桌面状态（tasks/metrics/workspaces 表）——新设计一律「查询/事件派生 + 网关缓存」，本地只存缓存与游标；⑤ 硬编码端点与凭据（ws://192.168.1.100:8080、PIN 0000、mock 密钥）。

---

## 5 数据库 schema 评估

### 5.1 旧 schema 与新设计逐表对照

| 旧表 | 新设计对应 | 结论 |
|------|-----------|------|
| workspaces | F4：工作区列表 = `workbench_list_workspaces` 命令缓存（60s）；授权根只在桌面端 | **C 反例**：本地实体化「云/局域网/本地」工作区类型是发明平行模型；仅 lastAccessed 排序与 F4 工作区「最近打开」语义巧合一致 |
| tasks | F1 F03：活动任务 = activeRuns 派生，**不落库**（F1 §5.2） | **C 反例**：把引擎状态实体化到本地，必然漂移 |
| audit_logs | F2 §7：本地历史表（toolCallId 幂等键 + decision + channel + reason）；F15 审计列表 = security-audit 事件 | **B 雏形**：actionType/description/payload(JSON)/decision/createdAt 形状与 F2 历史条目字段相似，但缺幂等键与过期/来源语义；须重设计（见 §5.2） |
| key_value_store | 新本地缓存层（F5 未读游标、F6 本机偏好、schema 版本）都需要 KV | **B 思路**：schema_version 存储 + KV 泛型表可沿用 |
| metrics | F1 §4.5：手机端不做本机历史持久化，只消费网关缓存 | **C 反例**：桌面遥测落本地库，必然陈旧且无价值 |
| macros | 无对应功能（启发点 #4） | **C** |

### 5.2 对新移动端本地存储设计的参考

新移动端（F 方案已定 expo-sqlite）需要的本地存储 = **缓存 + 游标 + 用户自己的数据**，不是桌面状态的镜像：

1. **F5 会话缓存**：`sessions` 索引缓存表（id/title/updatedAt/messageCount/runStatus 派生）+ `(sessionId → lastSequence)` 游标 + 已拉取消息缓存（F5 §2.4/§5.2）；旧 schema 没有会话表，无借鉴。
2. **F2 审批历史表**（P0 F2-06，本地保留最近 500 条）：建议主键 = `toolCallId`（幂等键，F2 §1.4/§11.2），字段 = runId/sessionId/toolName/summary/parameters(JSON)/cwd/dangerLevel/requestedAt/expiresAt/decision(approved|denied|expired)/channel(本机|桌面端|自动过期)/reason/sequence（事件序列号，F2 §11.1 历史以 sequence 为水位）。**旧 audit_logs 表是这一设计的雏形**（决策枚举 + payload JSON + createdAt），但必须补幂等键与过期语义。
3. **F6 本机偏好**：notify/appearance/privacy 分片落本地（F6 §4.2）；旧 store 的布尔偏好（haptics/autoApprove/strictMode）形态可参考但内容按 F6 归属矩阵重设。
4. **F1/F3 事件与用量**：**不落库**（F3 §7.3「手机端不落盘事件流，杜绝 SQLite/WAL 写放大」；F1 §4.5 用量只消费网关缓存）——旧 metrics/tasks 表是这两条铁律的反例。
5. **schema 管理**：沿用旧 `key_value_store + withTransactionSync 迁移` 模式（§3.1 借鉴项）；建议新工程补真正的逐版本迁移数组（v1→v2 显式迁移函数，而非重放建表）。

### 5.3 结论

旧 schema 无任何表可直接复用；可借鉴的是**三个模式**：KV 版本表 + 事务迁移、静态 repository 分层、审批历史表的形状雏形。表结构本身全部重设计（按 F1/F2/F5/F6 契约）。

---

## 6 去留结论

**建议：删除整个 `C:\Software\conex\apps\crish-mobile\` 目录**（或按主控流程归档到非活跃位置），**不复制任何文件进入新移动端工程**。理由：

1. **无 A 级成品**：唯一 A 类项（EmptyState）约 30 行，重写成本趋近于零；其余文件均带 mock 数据、假安全或与 F1-F6 冲突的实现。
2. **安全面必须整体作废**：假加密（KeyManager）、恒真生物识别（AuthService）、硬编码 PIN（LoginScreen）、明文 WS（DevicePairingScreen/ws.ts）——按安全基线（31-security-baseline.md）与 D5 设计，这些是「从零重写」而非「修补」的对象；保留任何片段都有被误引的风险。
3. **F1-F6 已全覆盖**：旧 17 个屏幕的功能域（监控/审批/事件流/文件/会话/设置/审计/任务/搜索）在新设计中均有更完整方案（含状态机、安全边界、测试点）；旧代码无增量能力（除 §4 启发点，均已文档化）。
4. **工程准入不满足**：无 git（未跟踪）、零测试、重复屏幕（Settings.tsx vs SettingsScreen.tsx）、初始化入口混乱——保留即负债。
5. **借鉴价值的载体是本文档**：§7 的 11 条借鉴参考条目已把值得带走的思路完整记录（含新实现要点），不需要保留源码本体。

**删除时的注意事项**（若执行）：
- 该目录未被 git 跟踪，删除不会产生 git 变更；如主控要求留痕，可先 `git add` 提交一次再删（走正常提交流程），避免留下「删除即消失、无据可查」的历史。
- `reference/markdown-editor` 测试资产铁律不受影响（apps/crish-mobile 与 reference/ 无交集）。
- 删除前确认 `.claude/`、`AGENTS.md`、`CLAUDE.md` 等目录内文件无需要归档的决策记录（本次审查未见）。

---

## 7 借鉴参考条目（A/B 类明细）

### J1（B）推送多平台适配器体系 —— 保留方式：参考文档

- **位置**：`src/services/push/IPushAdapter.ts`、`FCMPushAdapter.ts`、`APNsPushAdapter.ts`、`HarmonyPushAdapter.ts`、`PushNotificationManager.ts`
- **可借鉴点**：① 统一 `IPushAdapter` 接口（requestPermission / getToken / onMessageReceived / setBackgroundMessageHandler）隔离三平台差异；② `PushNotificationManager` 按 `Platform.OS` 选择适配器 + 前台消息走应用内通知、后台消息走系统通知的分叉；③ 包含 HarmonyOS/HMS 分支（多数 RN 工程缺失）。
- **新实现建议**：接口结构照搬；补齐 F2 §6.3 幂等（通知键 = toolCallId，Android tag / iOS 合并策略）与 sequence 去重；补深链路由（F1 §7.6 `crish://` schema，通知 data 携带 route + 载荷摘要 ≤4096B）；补 F6 §10.1 场景级开关 + 静默时段（仅放行审批）；payload 规范化对齐 `CrishNotification`（id/title/body/data/isForeground）但 id 改用事件序列号；Harmony 分支保留与否由 D7/产品域裁决。

### J2（B）多端点健康计数通道管理器 —— 保留方式：参考文档（启发点 #1）

- **位置**：`src/services/NetworkStrategyEngine.ts`
- **可借鉴点**：端点注册表 + 每端点失败计数（≥3 连败剔除）+ 延迟数据优先排序 + 策略过滤（auto/lan_only/tailscale_only/cloud_only）+ 手动重置健康计数。
- **新实现建议**：端点来源改为「配对注册表（F6 设备列表）+ 中继地址下发」，删除硬编码；健康判定用真实心跳（WS ping/pong 或协议层心跳，对齐 F1 §5.4 双通道独立判定）；剔除阈值与 F1 指数退避（1/5/15/30s）合并为「第 N 次重连尝试第 N 端点」；策略过滤与 F6 §7.1 三态（自动/仅局域网/仅云中继）+ 3 秒确认窗对齐；接入 D5 认证（通道建立 = 配对凭据握手，非裸连）。

### J3（B）硬件感知行为降级层 —— 保留方式：参考文档（启发点 #2）

- **位置**：`src/services/LocalHardwareService.ts`
- **可借鉴点**：设备电池（<20% 未充电 → 低功耗）+ 网络质量档位（excellent/good/poor）→ 行为调节（动画节流 / 传输块大小）的分层。
- **新实现建议**：用 expo-battery/expo-network 真值；行为挂接点建议：F1 轮询节流（低电量 → 4s→15s，与 T43 弱网降级合并为「弱网或低电量」双触发）、F3 合并窗口（低电量 → 48ms→100ms）、F3 §7.3 后台脏标记（低电量 → 更激进停消费）；块大小调节在新协议（D3 分帧）下可能不再适用，以轮询/渲染降级为主。

### J4（B）底部弹层组件 —— 保留方式：参考文档

- **位置**：`src/components/BottomSheet.tsx`
- **可借鉴点**：props 契约（visible/onClose/children/title/heightRatio）+ 交互三要素（backdrop 点击关闭、顶部 handle 条、内容 ScrollView）；Animated 双驱动（slide + fade，nativeDriver）。
- **新实现建议**：F2 理由面板/批量确认层、F4 长按上下文菜单、F6 配对码弹层/面包屑弹层均复用同款；用 reanimated + gesture-handler（D4 技术栈）重写并补「拖动关闭」（旧实现无手势关闭）、内容区域与滚动冲突处理；heightRatio 语义保留。

### J5（B）ANSI 转义分段渲染 —— 保留方式：参考文档

- **位置**：`src/components/TerminalView.tsx`
- **可借鉴点**：正则分段（`\x1b[<code>m...\x1b[0m`）→ RN Text span 嵌套（颜色/粗体）渲染；终端深色底 + 等宽 + 行渲染结构。
- **新实现建议**：F3 §4.0 主路径是「SGR/光标/清屏三类转义**剥离**后统一主题色渲染」（手写 30 行内）——旧实现是「颜色直映」，方向相反；建议新实现先按 F3 剥离器走，若后续需要保留部分色彩（进度条/警告），把旧的正则分段逻辑改造为「识别并丢弃转义段 + 白名单颜色透传」作为降级方案；行缓冲（200 行环形）、`\r` 覆盖、单行截断按 F3 §4.0 规格实现，旧代码无对应物。

### J6（B）审批决策交互链 —— 保留方式：参考文档

- **位置**：`src/screens/EventStreamScreen.tsx:27-48`、`94-112`、`133-171`
- **可借鉴点**：审批胶囊行（图标 + 摘要 + 点开弹层）→ 弹层展示 payload（等宽 JSON）→ 决策（Reject/Approve）→ 立即写本地历史 → 移除待办 → 反馈日志；feed 内联胶囊呈现（与 F3 approval 态工具卡语义一致）。
- **新实现建议**：F2 实现时按此顺序验证 E2E-1（决策 → approval-resolved 匹配 → 待办移除 + 历史新增）；弹层内容按 F2 §5.1 详情页规范升级（风险横幅/参数渲染/cwd/倒计时/二次确认），旧弹层仅作流程形状参考。

### J7（B）设置页分组行式骨架 —— 保留方式：参考文档

- **位置**：`src/screens/SettingsScreen.tsx`
- **可借鉴点**：sectionTitle 分组 + 分组卡 + 行（icon 底 + 标题 + 副文案 + Switch/ChevronRight）+ 身份卡 + 行内编辑 + 清除缓存二次确认；行内当前值摘要（F6 §12.6 最大交互差异点）已在此实现。
- **新实现建议**：视觉骨架照此布局；内容项按 F6 归属矩阵重设（权限模式只读镜像 + 「在桌面端更改设置」深链、通知三级开关、数据与隐私、连接三态 + 3 秒确认窗、配对入口快捷卡片）；**禁止**把权限/审批类做成手机端开关。

### J8（B）SQLite 版本迁移 + repository 分层 —— 保留方式：参考文档

- **位置**：`src/db/index.ts`、`src/db/repositories/*`
- **可借鉴点**：`key_value_store` KV 表存 schema_version + `withTransactionSync` 原子迁移 + `CREATE TABLE IF NOT EXISTS` 幂等重放；每表一个静态 repository（参数化 SQL、无 ORM）。
- **新实现建议**：新移动端 expo-sqlite 缓存层沿用「KV 版本表 + 事务迁移」骨架，但升级为**逐版本显式迁移函数数组**（旧实现只有重放，无 v1→v2 变更脚本，是技术债）；repository 静态类模式保留；表按 F5（会话缓存 + 游标）/F2（审批历史）/F6（本机偏好）重设计。

### J9（B）审批历史表形状雏形 —— 保留方式：参考文档

- **位置**：`src/db/schema.ts` 的 `audit_logs` 表 + `AuditLogRepo`
- **可借鉴点**：actionType（决策对象类型）/description/payload(JSON 字符串)/decision(approved|rejected)/createdAt 的形状思路。
- **新实现建议**：F2 §7 本地历史表按此思路重设计：主键 = `toolCallId`（幂等）、补 runId/sessionId/toolName/summary/dangerLevel/requestedAt/expiresAt/decision（含 expired）/channel/reason/sequence；保留 500 条上限 + 会话/决策类型筛选（F2 §7.1）；**删除**旧实现的一键清空能力（审计不可清除，§3.9）。

### J10（A）三要素空态组件 —— 保留方式：直接复制（唯一 A 类）

- **位置**：`src/components/EmptyState.tsx`
- **可借鉴点**：props = {icon, title?, description}，居中布局，风格与 F1 §4.7 空态规范（插画 + 主文案 + 副文案）逐项对应。
- **新实现建议**：直接照抄进新工程（约 30 行）；按 F1 §4.7 深色规范换色板；扩展「空态插画随主题切换」；F1 规定的各空态文案（「当前无活动任务」「暂无用量数据」「还没有会话，去桌面端开始第一个对话」「该 run 暂无事件」等）直接作为各组件的 description 传入。

### J11（B）应用内通知中心 —— 保留方式：参考文档

- **位置**：`src/services/NotificationService.ts` + `src/components/Toast.tsx`
- **可借鉴点**：内存通知队列 + 监听者注册/注销 + 前台 toast 呈现（滑动 + 4s 自动隐藏）+ 类型三档（info/warning/critical）——「应用内通知」与系统推送解耦的形态。
- **新实现建议**：对应 F1 §4.8（通知与角标界面：前台事件并入 feed/横幅，不弹系统通知）与 F3 §7.4（前台态合并进 feed 高亮）；新实现以 feed store/全局横幅组件承载，旧队列可作「应用内静默积压列表」（F1 §7.5 免打扰时段静默积压为应用内列表）的参考；toast 改用 reanimated。

---

## 8 C 类清单与理由（速查）

| 文件 | 理由 |
|------|------|
| KeyManager.ts / AuthService.ts / LoginScreen.tsx | 假加密/恒真生物识别/硬编码 PIN 0000，安全基线作废 |
| transport/ws.ts | 明文无鉴权无幂等，F1 §5.4 + D3/D6 取代 |
| store/index.ts | 单例扁平 store 违反 F6 §4.2 分片与 F3 §3.0 四层模型 |
| TaskRunnerService.ts | 宏执行（无鉴权模拟回执），功能盲区见启发点 #4，实现不可复用 |
| App.tsx / navigation/* | 登录门禁 + 抽屉导航被 F6 §5.1 / F1 §4.1 否决；DB 初始化未 await |
| DashboardScreen / Dashboard / ChatStream | 假遥测种子（诚实化反例）、tasks 进度条、日志气泡，F1/F3 取代 |
| ApprovalCenter / TaskHubScreen | F2 / F1 F03+F4 全面取代 |
| FileManagerScreen | mock 树 + 删除/重命名（F4 明令 V1 不开放），F4 取代 |
| DevicePairingScreen | 假握手 + 明文 WS；F6 §6 配对状态机取代（双通道交互巧合一致但无增量） |
| BootScreen | F6 §12.2 向导取代 |
| GlobalSearchScreen | 搜索数据源（本地表）在新设计中不存在；F5 §2.6 + F6 §12.5 取代 |
| AuditLogsScreen | 审计一键清空 = 安全反模式；F15 事件驱动只读取代 |
| MacroScreen / MacroBuilderScreen | F1-F6 无宏功能；若需要按启发点 #4 重建 |
| SettingsScreen 内容项 / Settings.tsx | 权限开关违反 F6 §8；重复屏；布局骨架已入 J7 |
| theme/tokens.ts 色板 | 浅色系与 F1 §4.7 深色规范冲突（token 分层结构属 RN 常识） |
| types/hwpush.d.ts | 平台细节，D7 定推送方案后按需重写 |
| db 的 workspaces/tasks/metrics/macros 表 | 本地实体化引擎/桌面状态，违反 F1 §5.2 / F4 / F1 §4.5；宏表无对应功能 |
| Header.tsx | 抽屉语义作废；F1 §4.1 顶部导航规范取代 |

---

## 9 验收对照（任务书逐项）

- [x] 逐文件/逐组件审查：§3（含现状/质量/技术债/安全缺陷），分类 A=1 / B=10 / C=其余（§2 总表 + §8 速查）
- [x] 对比 F1-F6：§4 启发点清单（7 条，含 2 条新设计盲区/补充：#1 通道管理器、#2 电量感知、#3 推送客户端层、#4 宏功能盲区）
- [x] 数据库 schema 评估：§5（旧表逐表对照 + 新本地存储设计参考 + 结论）
- [x] 去留结论：§6（删除整个目录；每个 A/B 项的保留位置在 §7 借鉴条目中明确为「直接复制 / 参考文档」）
- [x] 借鉴参考文档：§7（J1-J11，每条含位置/可借鉴点/新实现建议）
- [x] 产出格式：本文档，中文，UTF-8 无 BOM，约 470 行（300-600 行区间）

（本文档结束）
