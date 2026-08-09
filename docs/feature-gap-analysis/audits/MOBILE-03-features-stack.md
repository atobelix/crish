# MOBILE-03 移动端功能完整度与技术选型评审

> 日期：2026-08-09 ｜ 评审对象：`apps/crish-mobile`（Expo 57 / RN 0.86 / React 19.2）｜ 角色：移动端功能与选型评审子代理 M3
> 方法：逐文件通读 `apps/crish-mobile/src/`（30 个 TS/TSX 源文件），对照桌面端 `apps/crish-desktop/src` 功能面；运行 `npx tsc -p tsconfig.json` 实测类型门禁；`npm ls react-native-svg` 验证依赖树；全仓库 grep 验证服务端协议与 Firecrawl 集成是否存在。
> 关键结论先行：**这是一个"UI 原型 + 模拟逻辑"工程，不是可运行产品**——App 无法启动（缺 `react-native-svg`）、无法连接任何真实服务端（WS 协议无服务端实现）、全部关键交互为假数据；推送/审批/网络策略等差异化能力是死代码。技术栈本身（Expo 57）没有硬伤，但工程姿态必须从"演示原型"切换到"真产品"。

---

## 一、功能清单与完成度

### 1.1 总览表

| Screen | 完成度 | 真实可用？ | 关键证据 |
|---|---|---|---|
| BootScreen | 完整（纯动画） | 是（无逻辑） | `screens/BootScreen.tsx:22-28` 仅 1.5s 延时跳转 |
| LoginScreen | 骨架 | 否——PIN 硬编码 `'0000'`，生物识别为模拟通过 | `LoginScreen.tsx:31`；`AuthService.ts:28-34`（setTimeout 后无脑 `resolve(true)`） |
| AgentChatScreen | 骨架 | 否——发送走 WS 但回复是 1.5s 后本地模拟 | `AgentChatScreen.tsx:56` 发 `agent_chat_input`；`:59-71` "Simulate Agent Response"；复制/删除是空壳（`:74-77` 注释 "in real app"） |
| ApprovalCenter | 骨架 | 否——**未注册进导航，是死屏幕**；决策只发 WS+本地移除，不写审计日志 | `DrawerNavigator.tsx:41-109` 全部注册表无 ApprovalCenter；`ApprovalCenter.tsx:10-13`；对比 `EventStreamScreen.tsx:35-44` 才写 SQLite 审计，两处行为不一致 |
| AuditLogsScreen | 骨架 | 部分（读本地 SQLite 真实可用） | `AuditLogsScreen.tsx:22` 硬编码 `'ws_default_1'`；数据只来自本机审批决策，无服务端同步 |
| Dashboard.tsx（旧） | 占位 | 否——未注册进导航 | 与 `DashboardScreen.tsx` 并存，DrawerNavigator 只注册后者 |
| DashboardScreen | 骨架 | 否——图表数据是**假种子** | `DashboardScreen.tsx:16-29` "for demo purposes since WS isn't sending it yet"，`Math.random()` 生成 20 条假指标；"Kernel Healthy" 是写死文案（`:79`） |
| DevicePairingScreen | 占位 | 否——QR 扫码是 Alert 占位；握手是 1.5s 假延时；密钥是假 RSA | `DevicePairingScreen.tsx:73` "Camera scanner would open here."；`:34` "we simulate the cryptographic handshake"；`KeyManager.ts:22-24` mock 密钥字符串 |
| EventStreamScreen | 骨架 | 部分（审批 UI 流程完整，但消息无服务端来源） | `EventStreamScreen.tsx:27-48` 审批决策发 WS + 写本地审计（真逻辑）；`:50-55` 命令发 `dispatch_command`；logs 仅来自本地 store 的 `addLog` |
| FileManagerScreen | 占位 | 否——**目录树是模拟的**，任何文件操作都只是"发送成功"假提示 | `FileManagerScreen.tsx:12-13` "Dummy type for file tree since backend isn't ready"；`:29-37` 按路径深度生成假文件；`:71` "Command Dispatched" 后无任何真实结果；搜索按钮无操作（`:87-89`） |
| GlobalSearchScreen | 骨架 | 部分（本地 SQLite 搜索真实可用） | 见第二节 |
| MacroScreen / MacroBuilderScreen | 骨架 | 部分（增删改查本地真实可用；执行是模拟） | `MacroScreen.tsx:20-48` 空库时自动播种 2 个假宏；`TaskRunnerService.ts:74-80` "Simulate remote kernel executing" 1.5s 后假 ack |
| SettingsScreen / Settings.tsx | 骨架 | 否——关键开关是写死的 | `SettingsScreen.tsx:117` Tailscale 开关 `value={true}` 无 onValueChange 逻辑；`:125` 假遥测 Alert "Total Tasks: 12 / Avg Latency: 12ms / DB Size: 24KB"；`Settings.tsx` 是未注册的旧版 |
| ChatStream.tsx | 占位 | 否——未注册进导航，与 EventStreamScreen 重复 | `DrawerNavigator.tsx` 注册表无 ChatStream |
| TerminalView（组件） | 骨架 | 部分（纯展示，无输入） | `components/TerminalView.tsx:24-63` ANSI 解析仅支持单段 `\x1b[` 序列；**没有任何 screen 引用它**（全项目仅定义处出现） |
| TaskHubScreen | 骨架 | 部分（本地 workspace/task 查询真实） | `TaskHubScreen.tsx:21-31` initDatabase + 读 SQLite；任务列表无详情页、无状态更新入口 |

### 1.2 关键交互逐项判定

- **审批通过/拒绝**：UI 流程完整（EventStreamScreen 胶囊 → BottomSheet → 决策 → 写本地审计），但 `gate_decision` 动作在**全仓库无任何服务端实现**（见 P0-2），实际决策永远无人接收。ApprovalCenter 的决策连审计日志都不写。
- **终端输入**：EventStreamScreen 的"命令"只是往本地 store 塞一条日志（`EventStreamScreen.tsx:53`），`dispatch_command` 无服务端；TerminalView 组件无输入能力且无人使用。
- **文件操作**：目录树是假数据，`fs_mutation` 无服务端；`signPayload` 签名是随机字符串（`AuthService.ts:47`），strictMode 生物认证是模拟通过。
- **配对**：无二维码扫描（依赖 expo-camera/AV 未装）、无真实密钥交换、无 token 校验。`KeyManager.generateAndStoreKeyPair` 生成后公钥即被丢弃（`DevicePairingScreen.tsx:27` 结果未用于任何握手）。

---

## 二、GlobalSearch 与 Firecrawl

**结论：移动端 GlobalSearch 完全未集成 Firecrawl，与桌面端代理搜索也无任何关系。**

- 搜索实现：`GlobalSearchScreen.tsx:44-77` 的 `executeCrossTableSearch` 只查**本地 SQLite** 三张表（workspaces/macros/audit_logs），`LIKE '%term%'`，300ms debounce（`:35`）。无任何网络请求。
- 全仓库验证：`rg -i firecrawl` 在 `apps/`（排除 node_modules）零匹配；仅命中根 `eslint.config.js` 与 `docs/analysis` 等文档/配置文件的过时提及，无任何真实集成。桌面端同样没有 Firecrawl 代码。
- 接口缺陷：`SearchResult` 声明了 `'task'` 类型（`GlobalSearchScreen.tsx:11`），但查询逻辑从未搜索 tasks 表；点结果跳转不携带 ID（`:92` 注释 "Ideally would pass ID to filter"），搜索-导航是断链的。
- 若产品规划中的"搜索"含网页/知识库检索（Firecrawl 抓取），移动端当前没有任何接入路径；若只是本地检索，现状可用但应补 tasks 表。

---

## 三、宏系统

**结论：移动端宏 = 本地 SQLite 存储的 bash 命令序列（"快捷指令"概念），执行结果完全模拟，与桌面端无任何对应关系。**

- 数据模型：`schema.ts:54-62` macros 表，`steps` 字段为 JSON 数组 `{command, timeoutMs}`。
- 执行链路：`MacroScreen.tsx:56-66` 解析 steps → `TaskRunnerService.executeMacro`（`TaskRunnerService.ts:31-56`）→ 每步发 `dispatch_command`（`:61`）→ **1.5s 后假 ack 强行 resolve**（`:74-80`，注释自认 "we simulate the acknowledgment hook"）。超时/失败/abort 逻辑存在但无真实输入可触发。
- 与桌面对应：桌面端没有"宏"概念，其自动化是 session/agent 工作流（`apps/crish-desktop/src/api/approvalFlowMachine.ts`、`components/agent-card/`）。宏数据只存在手机本地，**无任何同步机制**——两台手机、手机与桌面之间互不可见。
- 结论：这是移动端自创的快捷指令概念，方向可用（类似桌面端命令宏的产品价值），但当前"执行"是假的，且与桌面端自动化体系无桥接。

---

## 四、与桌面端功能对齐

### 4.1 桌面端有、移动端缺失的入口

| 桌面端能力 | 桌面端证据 | 移动端现状 |
|---|---|---|
| 模型选择/配置 | `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx` | 仅 TaskHub 列表显示 `modelUsed` 文本（`TaskHubScreen.tsx:109-110`），无任何模型管理入口 |
| 用量/成本指标 | `apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx:338-360`（tokens/成本图表） | 移动端"Agent Telemetry"是写死数字的 Alert（`SettingsScreen.tsx:125`） |
| 缓存指标 | 桌面端 cache-metrics e2e 专项（tests/e2e/cache-metrics.spec.ts） | 移动端无任何缓存指标展示 |
| 多 agent | 桌面端 agent-card/agentProfiles 体系 | 移动端无 agent 列表/切换概念，store 只有单一 `tasks` 记录（`store/index.ts:28`） |
| 审批流状态机 | `approvalFlowMachine.ts`（pending/inflight/deferred 全状态机） | 移动端只有 `pendingApprovals` 数组（`store/index.ts:31`），无 inflight/超时/重连语义 |

### 4.2 移动端独有优势（桌面端做不到的）

- **推送通知审批**：设想正确（手机不在桌前时审批/告警），但**整条链路是死代码**——`pushManager`（`PushNotificationManager.ts:83`）从未被 import/初始化；无 google-services.json / agconnect-services.json / eas.json；`App.tsx` 只初始化了数据库（`:12-15`）。
- **审批中心**：本应是最强差异化功能，实际是未注册进导航的死屏幕（见 1.1）。
- 结论：移动端独有优势目前全部停留在"UI 演示"，没有一条真实可用。

---

## 五、体验细节

| 维度 | 现状 | 证据 |
|---|---|---|
| 空态 | 多数页面有（EmptyState 组件 + 各页内联空态） | `components/EmptyState.tsx`；MacroScreen/AuditLogs/GlobalSearch 均引用 |
| 加载态 | 缺失/简陋——仅 GlobalSearch 有 "Searching database..." 文本（`:135`）；列表页全部一次性加载无 loading | `AuditLogsScreen.tsx:16-23`、`TaskHubScreen.tsx:21-31` |
| 错误态 | 基本缺失——网络失败仅 console.error（`transport/ws.ts:39-40`），用户无感知；配对失败有 Alert（`DevicePairingScreen.tsx:46-48`）是少数例外 | `ws.ts:38-40` |
| 深色模式 | **完全没有**——`app.json` `userInterfaceStyle: "light"`；`theme/tokens.ts` 全浅色 token；0 处 `useColorScheme` | `app.json`；grep 实测 |
| 无障碍 | **为零**——全 src 0 个 `accessibilityLabel`/`accessibilityRole`/`testID` | grep 实测 |
| 手势 | BottomSheet 无拖拽关闭（`BottomSheet.tsx:50-82` 只有点背板关闭）；MacroBuilder 的 GripVertical 是纯装饰，步骤无法拖拽排序（`MacroBuilderScreen.tsx:118-121`）；安装了 reanimated+gesture-handler 但全项目只用 RN 自带 `Animated` | grep 实测 |
| 键盘处理 | AgentChat/GlobalSearch 有 KeyboardAvoidingView；但所有输入框缺 `returnKeyType` 等精细处理 | `AgentChatScreen.tsx:115` |
| 安全区 | **硬编码 `paddingTop: 56` 遍布所有 screen**（如 `AgentChatScreen.tsx:192`、`DevicePairingScreen.tsx:157`），装了 safe-area-context（`package.json:22`）却无一处使用 `useSafeAreaInsets`——真机刘海屏/胶囊屏错位 | grep 实测 |
| 数据刷新 | Dashboard 5s interval（`DashboardScreen.tsx:41`）但读的是假数据；其余页面无 pull-to-refresh | — |
| 文案硬编码 | "Last 24h: 12 events"（`CustomDrawerContent.tsx:86`）、"Total Tasks: 12"（`SettingsScreen.tsx:125`）等假数据混入 UI 文案 | — |

---

## 六、技术选型评估

### 6.1 Expo 57 + RN 0.86 + React 19.2 —— 合理，版本内部一致

- 实测 node_modules：expo **57.0.11**、react-native **0.86.2**、react **19.2.3**、typescript ~6.0.3，与 `package.json:13-28` 声明一致，模板原生配套版本（SDK 57 官方组合），无版本错配风险。
- 稳定性判断：Expo SDK 57 自 2025 年底发布，截至 2026-08 已迭代多个 patch（57.0.11），处于成熟期；"刚发布不稳定"的担忧不成立。选用**非 latest SDK**（最新应为 58/59 时代）反而更稳。
- 结论：**维持**。

### 6.2 expo-sqlite 57 —— 新版同步 API，选择正确

- `db/index.ts:9` 使用 `openDatabaseSync`，全部查询走 `execSync/runSync/getAllSync/withTransactionSync`——这是 SDK 51+ 引入的**新版同步 API**（旧版 `openDatabase` + promise 回调已废弃）。形态正确。
- 风险提示：同步 API 在主线程执行，metrics 表无清理策略（`MetricsRepo.cleanupOldMetrics` 定义了但从未调用），长期运行表增长会卡 UI——P2。

### 6.3 推送：FCM + APNs + HMS 三套并存 —— 架构性混乱，国内适配是死路

- 现状：`PushNotificationManager.selectAdapter`（`push/PushNotificationManager.ts:24-38`）按 `Platform.OS` 选适配器；iOS→expo-notifications，android→RNFirebase FCM，`'harmony'`→HMS hwpush。
- **国内安卓无 GMS 适配问题**：`Platform.OS === 'harmony'` 分支在标准 RN 构建中**永远不可达**——国产安卓（含 HarmonyOS NEXT 上跑 RN Android 包）的 `Platform.OS` 恒为 `'android'`，会走 FCM 分支；而无 GMS 的手机 FCM 收不到消息。所谓"HMS push 已加"是架构性死代码，`HarmonyPushAdapter.ts` 从未被选中执行。
- 正确方案：用 hms-push 系列插件（`@hmscore/react-native-hms-push`，按**设备是否存在 HMS Core** 在 Android 分支内做渠道判断），或走厂商通道聚合（个推/极光）做国内分发。
- 附带问题：iOS 同时依赖 `expo-notifications`（APNsPushAdapter）与 `@react-native-firebase/messaging`，两者都会注册 APNs delegate，存在冲突风险；且 RNFirebase 需要原生 google-services.json（项目里没有），**Expo Go 下 RNFirebase 不可用**（原生模块不在 Expo Go 内置清单）——当前依赖搭配下推送在 Expo Go 中根本无法验证。

### 6.4 zustand —— 完全合理

- `store/index.ts:58` `create<ConexState & ConexActions>` 纯函数式 store，无 provider 包袱，天然适合 RN；桌面端同用 zustand 生态。**维持，无替代必要。**

### 6.5 导航 / UI 框架 —— 维持 react-navigation，不引入 Expo Router/Tamagui

- react-navigation v7（stack+drawer，`DrawerNavigator.tsx`、`RootNavigator.tsx`）对这个规模的应用完全够用；Expo Router 的文件路由收益（深链/universal link）当前无需求，迁移成本不划算——**客观建议：不换**。
- Tamagui/gluestack/NativeWind 等 UI 框架：项目已有自制 token 体系（`theme/tokens.ts` 颜色/字号/阴影）且各 screen 风格统一，**引入 UI 框架是过度设计**；当前最大问题不是样式产出效率而是业务真实化。维持手写 StyleSheet。

---

## 七、测试与工程质量

| 项 | 现状 | 证据 |
|---|---|---|
| 单元测试 | **零**——全目录 0 个 `*.test.*`/`*.spec.*` 文件（排除 node_modules） | 实测 |
| 测试框架 | 无 jest-expo/vitest 配置，`package.json:30-35` scripts 只有 expo start 系列 | 实测 |
| 类型门禁 | **不通过**——`npx tsc -p tsconfig.json` 实测 **248 个错误**，全部为 lucide 图标 `color` 属性报错（根因见下）；tsconfig 本身是 `strict: true`（tsconfig.json:4） | 实测 |
| 根因 | `lucide-react-native@1.30.0`（`package.json:17`）的 peer 依赖 **`react-native-svg` 未安装**（`npm ls react-native-svg` 为空）——其 `LucideProps extends SvgProps`（`node_modules/lucide-react-native/dist/types/lucide-react-native.d.ts:12`）解析失效 | 实测 |
| 运行时后果 | lucide 模块顶层 `import Svg from 'react-native-svg'`，Metro 打包必失败——**App 根本无法启动**（不只是类型错） | — |
| lint | 无 eslint 配置、不进根 `eslint.config.js` | 根 package.json 实测 |
| 代码资产状态 | **`apps/crish-mobile/` 全目录未入库**（`git status` = `?? apps/crish-mobile/`），且不在根 npm workspaces（根 `package.json` workspaces 列表无 crish-mobile），根 typecheck/lint/test 全部覆盖不到 | 实测 |
| 死代码 | pushManager / networkEngine / LocalHardwareService / TerminalView / ApprovalCenter / Settings.tsx / ChatStream.tsx / Dashboard.tsx 均为导出或被注册但从未使用/不可达 | grep 实测 |

---

## 八、问题清单

### P0（阻断发布，App 不可用或核心承诺为假）

- **P0-1 应用无法构建/启动**：缺 `react-native-svg`（lucide-react-native 的 peer 依赖未安装），tsc 248 错误。修复：`npx expo install react-native-svg`，再全量 tsc 清零。
- **P0-2 无服务端：移动端 WS 协议没有对端**。全仓库无任何 WebSocket server（crates/ 无 server 代码，桌面端走 Tauri IPC `apps/crish-desktop/src/api/transport/tauriTransport.ts`）；`agent_chat_input/dispatch_command/gate_decision/fs_mutation` 四个动作仅存在于移动端自身。App 宣称"连接桌面内核"实际无物可连。修复路径：在桌面端/Rust 侧增加 WS 网关（tauri 常驻 ws server 或 relay 服务），定义并实现协议。
- **P0-3 核心交互全为模拟数据**：聊天回复（AgentChatScreen.tsx:59-71）、密钥/加密（KeyManager.ts:22-41，明文存 SQLite `key_value_store` 且注释自认 simulation）、生物认证（AuthService.ts:28-34 恒 true）、PIN（'0000'）、遥测（DashboardScreen.tsx:16-29）、文件树（FileManagerScreen.tsx:29-37）、宏执行（TaskRunnerService.ts:74-80）。任何对外宣称的功能都不成立。
- **P0-4 推送审批链路是死代码 + 国内适配方向错误**：pushManager 从未初始化、无任何推送配置文件；`'harmony'` 分支不可达，无 GMS 国产机收不到 FCM。差异化价值（远程审批）实际为 0。
- **P0-5 资产未入库且游离于工程体系**：`apps/crish-mobile/` 整体 untracked、不进根 workspaces/lint/typecheck——与 AGENTS.md 铁律（2026-08-07 f772eb99 事故教训）直接冲突，存在整目录丢失风险。修复：纳入根 workspaces + 立即 git add 提交（含后续全部测试资产）。

### P1（严重，影响可用性/安全/可信度）

- P1-1 零测试 + 零 lint + tsc 248 错，无任何门禁可言（见第七节）。
- P1-2 安全幻觉：私钥明文入库（KeyManager.ts:28-38），无 expo-secure-store/Keychain；签名是随机串（AuthService.ts:47）；公钥生成即弃（DevicePairingScreen.tsx:27）；配对无 token 校验。以"端到端加密绑定"对外宣称不可信。
- P1-3 审批链路双实现不一致：ApprovalCenter 决策不写审计日志（ApprovalCenter.tsx:10-13），EventStreamScreen 写（EventStreamScreen.tsx:35-44）。
- P1-4 安全区硬编码 `paddingTop: 56` 遍布全 app，真机错位（safe-area-context 已装未用）。
- P1-5 无障碍为零：无任何 accessibilityLabel/Role；无 testID，无法上自动化 UI 测试。
- P1-6 SettingsScreen 存在假数据冒充真功能（写死 Switch、假遥测 Alert）。
- P1-7 深色模式完全没有（app.json light-only），对比桌面端完整主题体系。

### P2（改进项）

- P2-1 双版本屏幕混乱：Dashboard.tsx/Settings.tsx/ChatStream.tsx 未注册遗留件应删除，ApprovalCenter 应接入导航。
- P2-2 硬编码 workspace `'ws_default_1'`（AuditLogsScreen.tsx:22、DashboardScreen.tsx:16、EventStreamScreen.tsx:37）。
- P2-3 `useNavigation<any>` 全导航无类型化（AgentChatScreen.tsx:18 等），route params 无类型（GlobalSearchScreen.tsx:92）。
- P2-4 GlobalSearch 不搜 tasks 表、跳转不传 ID。
- P2-5 metrics 表无清理策略，同步 API 主线程查询随表增长卡顿。
- P2-6 FileManager 搜索按钮无行为；CustomDrawerContent "Last 24h: 12 events" 假文案。
- P2-7 BottomSheet 无拖拽手势；MacroBuilder 步骤无法排序（GripVertical 装饰）。
- P2-8 加载/错误态覆盖不全（大部分页面无 loading/error 呈现）。
- P2-9 已安装 reanimated 4.5.3 + gesture-handler 3.1 但全项目未使用（除 App.tsx:1 import），要么用起来要么移除依赖。

---

## 九、换方案建议

**技术栈无硬伤，不换；工程方向必须调整。**

维持的理由：
- Expo 57 / RN 0.86 / React 19.2 是当前官方成熟组合，内部版本一致；
- expo-sqlite 新版同步 API、zustand、react-navigation v7 均为 RN 主流正确选择；
- 换 Tauri mobile / Flutter / Kotlin 原生都解决不了"移动端无服务端协议"这一根本问题，只会重写一遍 UI 再踩同样的坑；换 Expo Router/Tamagui 属于无价值折腾。

调整清单（按优先级）：
1. **先接服务端**：桌面端（Tauri）或 Rust 内核侧实现 WS 网关（或 relay），落地 P0-2 的协议——这是所有功能的唯一真源。协议动作可参考移动端已定义的 action 名（agent_chat_input / gate_decision / dispatch_command / fs_mutation），服务端实现后移动端只需保留。
2. **补依赖修门禁**：`npx expo install react-native-svg expo-secure-store expo-local-authentication expo-camera expo-battery expo-network`（按需），tsc 清零。
3. **推送渠道重做**：Android 用 FCM（海外）+ hms-push（国内按 HMS Core 存在性判断）双渠道聚合，去掉不可达的 `'harmony'` 分支；iOS 二选一（expo-notifications 或 RNFirebase），避免双 delegate。
4. **真实化安全**：密钥进 SecureStore/Keychain，配对协议真正实现（token + 公钥握手 + 签名验证），生物识别接 expo-local-authentication。
5. **入库与工程化**：纳入根 workspaces、补 jest-expo 测试、提交全部资产（P0-5）。
6. 删除未注册遗留屏幕与死代码（TerminalView 若产品需要再按真需求实现输入终端）。

---

## 最严重 5 项

1. **P0-1 缺 react-native-svg → tsc 248 错 → App 无法构建启动**（最直接，一票否决当前"可运行"宣称）。
2. **P0-2 移动端 WS 协议全仓库无服务端对端**——所有远程控制承诺（审批/命令/文件/聊天）结构性落空，App 与产品本体完全脱节。
3. **P0-3 核心交互全部模拟**（密钥、生物识别、PIN、遥测、文件树、宏执行、聊天回复）——"功能"只是 UI 表演。
4. **P0-5 移动端资产整体未入库 + 不在根工程体系**——与 AGENTS.md 铁律冲突，存在整目录丢失风险。
5. **P0-4 推送审批（移动端最大差异化价值）是死代码，且国内无 GMS 适配方向错误**（'harmony' 分支不可达）。

---

## 技术栈结论

**维持（Expo 57 + RN 0.86 + React 19.2 + zustand + expo-sqlite + react-navigation 不更换）**，但要求两个前提性调整：① 立即补齐 `react-native-svg` 等缺失依赖并修复推送渠道架构（FCM + HMS 按设备双渠道，删除不可达分支）；② 工程姿势从"演示原型"切换为"真产品"——先实现服务端 WS 网关打通真实链路，再谈功能完整度。若后续产品形态是"纯远程遥控桌面内核"，现有栈完全胜任；唯一需要警惕的换栈理由是"无 GMS 国产分发 + 实时音视频/后台保活"等高原生需求场景，届时可评估在保留 JS 层的前提下以原生模块（Kotlin 厂商通道、Headless JS）扩展，而不是整体换栈。当前**不存在必须更换技术栈的硬伤**。
