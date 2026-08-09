# D4 移动端（手机伴侣端）正式技术方案

> 文档编号：D4-mobile-tech
> 系列：crish 多端互通技术方案（multi-device）
> 版本：v1.0（草案评审稿）
> 日期：2026-08-09
> 状态：待主控评审
> 目标读者：主控调度者、D 系列其他子方案、实现阶段（PE 系列）任务书作者

---

## 0. 文档信息与决策摘要

### 0.1 一句话结论

移动端采用 **Expo SDK 57（RN 0.86 / React 19.2.3）+ TypeScript strict + zustand（含 immer 中间件）+ expo-router（文件路由）+ expo-sqlite（事件/审批/会话缓存）+ expo-secure-store（令牌）+ RN 内建 WebSocket（自研重连与离线队列层）+ expo-notifications（APNs/FCM 推送）** 的托管（managed）+ 少量自研 config plugin 技术栈，定位为「远程伴侣」：在桌面主机的 Rust daemon 上新增 WS 网关，移动端复用 `@crish/shared-types` 的引擎命令面与事件契约，实现审批、事件流/终端流查看、文件浏览、状态监控与推送通知五类核心能力。

### 0.2 关键决策清单（结论先行）

| 决策点 | 结论 | 一句话理由 |
| --- | --- | --- |
| 框架 | Expo（维持，弃 bare RN / Flutter / KMP） | 托管工作流 + EAS 构建 + 官方包覆盖需求面；TS 类型面与桌面同构，事件契约零双源 |
| Expo SDK | **57.0.0**（2026-08 最新稳定） | 对应 RN 0.86 / React 19.2.3；compileSdk/targetSdk 36 直接满足 2026 上架要求 |
| 语言 | TypeScript strict（`"strict": true`） | 与 `packages/shared-types`、桌面端类型体系同构，跨端复用零成本 |
| 状态管理 | zustand v5 + immer 中间件 | 与桌面 `permissionStore.ts:54-120` 同一范式；selector 用 `useShallow`（复用桌面 `useShallowSelector.ts`） |
| 导航 | expo-router（Stack + Tabs） | 文件路由 + 深链天然支持推送点击跳转，typed routes 可增量开启 |
| 本地存储 | expo-sqlite（WAL + user_version 迁移） | 官方异步 API；`expo-sqlite/kv-store` 提供 AsyncStorage 兼容层；不引入 ORM |
| 敏感数据 | expo-secure-store | iOS Keychain / Android Keystore，存配对令牌与设备密钥 |
| WS 客户端 | RN 内建 `WebSocket` + 自研 `ReconnectingWsClient` | 无需原生模块；重连/心跳/背压自研可控，参照桌面 `ConnectionManager` 相位投影思想 |
| HTTP 客户端 | 内建 `fetch` + AbortController 薄封装 | 移动端 HTTP 面极小，不值得 axios 依赖与拦截器复杂度 |
| 推送 | expo-notifications（APNs / FCM）；国内安卓厂商推送自研 config plugin | Expo Push Service 官方路径 + 华为 HMS/厂商通道定制插件 |
| 与桌面连接 | 桌面 daemon 新增 WS 网关（engine 命令面透传） | 复用 `commandManifest.ts` 中 `surface='engine'` 的命令名，不发明新协议 |
| 测试 | jest-expo preset + @testing-library/react-native | Expo 官方测试基建；跨端契约由 `@crish/shared-types` 解析器单测保证 |
| CI | GitHub Actions：typecheck + lint + jest-expo + 契约漂移检测 | 与主仓前端门禁同构 |

### 0.3 与既有资产的关系

- 现有 `apps/crish-mobile` 为实验性 Expo 原型，**本方案为全新设计**，不继承其内部实现；仅保留目录位作为正式工程落点（实施时清空重建，见 11 章里程碑）。
- 类型面复用 `packages/shared-types`（`src/events.ts`、`src/permissions.ts`、`src/orchestration.ts`、`src/run-control.ts`、`src/errors/*`、`src/stored-event.ts` 等）与生成面 `src/generated/engine/*`（引擎事件解析器 `parseEngineEvent`）。
- 桌面端参照范式：`apps/crish-desktop/src/store/permissionStore.ts`（zustand+immer）、`api/approvalFlowMachine.ts`（审批状态机）、`api/chat-bridge/handlers/eventParser.ts`（事件信封解析）、`api/transport/commandManifest.ts`（命令面）、`services/ConnectionManager.ts`（连接相位投影）、`api/runControlClient.ts`（L0-L3 run 控制）。

---

## 1. 背景与产品定位

### 1.1 场景定义：远程伴侣

crish 桌面端（Tauri + React + Rust 内核）承载完整工作区体验。移动端不是桌面的缩小版，而是「远程伴侣」：桌面在用户不在场时继续运转（长任务、后台 cron、子代理、审批等待），用户用手机在碎片时间完成五件事：

| 能力域 | 移动端职责 | 桌面端职责边界 |
| --- | --- | --- |
| 审批 | 查看待批请求、批准/拒绝/附注、高危项二次确认、超时展示 | 完整权限规则编辑、plan 模式、白名单维护 |
| 事件/终端流 | 订阅并回放 run 事件、只读终端输出流、消息增量视图 | 全量会话管理、双向 PTY、消息编辑 |
| 文件浏览 | 只读目录树、文本预览、大小/修改时间元信息 | 编辑、diff、git 操作、删除接管 |
| 状态监控 | 会话/run 状态、连接状态、活跃 run 仪表盘 | 完整状态面板、缓存统计、安全审计 |
| 推送通知 | 审批到达、run 结束、任务失败等事件推送 + 点击深链 | 桌面内进程级事件订阅 |

### 1.2 拓扑：手机 ↔ 桌面主机

```
┌─────────────┐  WSS (LAN)      ┌──────────────────┐        ┌──────────────────┐
│   手机端     │ ◄──────────────► │  桌面主机 daemon   │◄──────►│   Rust 引擎内核   │
│ crish-mobile │  WS 网关 / 配对  │  (新增 WS 网关层)  │ invoke  │  (core 命令面)    │
└─────────────┘                  └──────────────────┘        └──────────────────┘
      │                                                              │
      └── expo-notifications（APNs / FCM / 厂商推送）◄── 推送网关 ◄───┘
```

- **在线通道**：手机与桌面主机同一局域网（或经 Tailscale/端口转发）时，走 WSS 直连 daemon 的 WS 网关，全量事件订阅 + 命令调用。
- **离线通道**：手机不在线或后台受限时，由推送网关（部署于公网，见 8 章）根据引擎事件触发厂商推送；手机点击推送后经深链拉起对应屏幕，必要时引导重连。
- **桌面角色**：桌面 GUI 只是引擎的客户端之一；移动端 WS 网关在 daemon 进程内新增，命令面与事件面与桌面共用 Rust 侧契约（`commandManifest` 的 engine surface 命令名）。

### 1.3 非目标（v1 明确不做）

- 不做移动端发起/编辑任务正文的完整聊天（只读消息流 + 轻量「继续/停止/取消」控制）。
- 不做移动端双向 PTY 终端（只读回放）。
- 不做多主机会话、云账号体系、跨设备同步层（v1 单主机配对）。
- 不做文件上传/下载（仅浏览与文本预览）。
- 不做 iOS/Android 之外的平台（桌面 Web 由 crish-desktop 承担，不在本方案）。

---

## 2. 设计目标与约束

### 2.1 设计目标（排序即优先级）

1. **协议复用**：移动端不发明任何新业务协议；事件面复用引擎事件信封（`type/sequence/schemaVersion/runId` 注入面，见 `crates/conex-types/src/events.rs:10-12` 与 `eventParser.ts`），命令面复用 engine surface 命令名（`core_approve_tool`、`core_run_control` 等）。
2. **审批可达性**：审批是移动端第一功能；断线、杀进程、无网都要能「看见待批并最终送达决策」（离线 outbox + 幂等键）。
3. **低电量/低流量**：WS 心跳间隔、事件批量化、分页回放；iOS 后台不可长连，推送优先于常驻连接。
4. **安全默认**：配对即互认证（一次性配对码 + 令牌轮换）；令牌存 Keychain/Keystore；WSS 强制；审批决策防重放（toolCallId 幂等键）。
5. **与桌面体验同构**：状态机范式（审批流、连接相位）、错误码体系（`CrishErrorCode`）直接复用，减少双端心智差异。

### 2.2 硬约束

- 类型与事件契约不得双源漂移：移动端 import `@crish/shared-types`，禁止复制粘贴事件类型（对齐 `packages/shared-types/src/errors/codes.ts:1-7` 的权威定义纪律）。
- 编码规范：中文注释、UTF-8 无 BOM（对齐仓库铁律，含 AGENTS.md 事故教训）。
- 门禁：类型检查（`tsc --noEmit`）、单元测试、lint 全绿才可合并；禁止 `--no-verify` 类绕过。
- 不读 `reference/**`、不读旧原型 `apps/crish-mobile` 内部（本方案独立设计，实施时清理重建）。
- 国内安卓商店上架约束：需厂商推送适配 + 隐私合规（推送令牌采集声明）。

### 2.3 兼容面（来自 Expo SDK 57 官方矩阵，2026-08-09 webfetch 查证）

| 项 | 版本/要求 | 备注 |
| --- | --- | --- |
| Expo SDK | 57.0.0 | 最新稳定（release-statuses 无 beta/alpha 标记） |
| React Native | 0.86 | SDK 57 固定目标版本（reactnative.dev 确认最新稳定 0.86） |
| React | 19.2.3 | SDK 57 固定 |
| React Native Web | 0.21.0 | 移动端不启用 web，仅记录 |
| Node.js | ≥ 22.13.x | 构建/CI 侧要求 |
| Android | 7.0+（API 24）；compileSdk/targetSdk 36 | 实际发布建议 minSdk 26+ |
| iOS | 16.4+；Xcode 26.4+ | APNs entitlement 由 EAS 托管 |

---

## 3. 技术栈最终选型

### 3.1 总览表

| 领域 | 选型 | 版本基线 | 替代候选 | 决策 |
| --- | --- | --- | --- | --- |
| 应用框架 | Expo（managed + CNG） | SDK 57.0.0 | bare RN CLI / Flutter / KMP | 维持 Expo |
| UI 运行时 | React Native | 0.86（New Architecture 默认开启） | — | 随 SDK 锁定 |
| 语言 | TypeScript | 5.9（随 SDK 模板） | Flow | TypeScript |
| 状态管理 | zustand + immer | v5.x | Redux Toolkit / Jotai | zustand（与桌面同构） |
| 导航 | expo-router | v6（SDK 57 配套） | React Navigation 手配 | expo-router |
| SQLite | expo-sqlite | SDK 57 配套版 | WatermelonDB / Realm / drizzle | expo-sqlite |
| 安全存储 | expo-secure-store | SDK 57 配套版 | react-native-keychain | expo-secure-store |
| 网络 | RN 内建 WebSocket + fetch | 内建 | react-native-websocket / axios | 内建 + 自研薄层 |
| 推送 | expo-notifications | SDK 57 配套版 | 纯原生推送 / 极光 / 个推 | expo-notifications + 厂商插件 |
| 深链 | expo-router typed routes | v6 | react-navigation linking | expo-router |
| 测试 | jest-expo + @testing-library/react-native | jest-expo@~57 | vitest（RN 支持弱） | jest-expo |
| 构建分发 | EAS Build + EAS Update | 最新 | 本地 prebuild + 手签 | EAS |

### 3.2 Expo / RN 版本选型（webfetch 查证依据）

#### 3.2.1 官方兼容矩阵（docs.expo.dev/versions/latest，2026-08-09 抓取）

| Expo SDK 版本 | RN 版本 | React 版本 | RN Web | 最低 Node | Android | compileSdk/targetSdk | iOS | Xcode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **57.0.0** | **0.86** | **19.2.3** | 0.21.0 | 22.13.x | 7+ | 36 / 36 | 16.4+ | 26.4+ |
| 56.0.0 | 0.85 | 19.2.3 | 0.21.0 | 20.19.x | 7+ | 36 / 36 | 16.4+ | 26.4+ |
| 55.0.0 | 0.83 | 19.2.0 | 0.21.0 | 20.19.x | 7+ | 36 / 36 | 15.1+ | 26.2+ |
| 54.0.0 | 0.81 | 19.1.0 | 0.21.0 | 20.19.x | 7+ | 36 / 36 | 15.1+ | 16.1+ |

React Native 官方发布页（reactnative.dev/versions）确认：最新稳定 0.86，其后 0.85/0.84/0.83… 依次递降；Expo 官方策略是「每个 SDK 版本固定唯一目标 RN 版本，通常为发布时的最新稳定」。

#### 3.2.2 为什么选 SDK 57 而非 56/55

1. **发行窗口**：SDK 57 ↔ RN 0.86 均为 2026 年年中稳定版，发行窗口已超过 2 个月，新架构边角、Hermes 回归等社区修复已开始沉淀。
2. **单版本策略**：Expo「目标 RN 版本唯一」意味着 SDK 57 拿到 RN 0.86 的全部新修复；SDK 56 停在 0.85。
3. **Android targetSdk 36**：Google Play 逐年收紧 targetSdk 要求，SDK 57 的 compileSdk 36 直接满足 2026 上架，免去升级风暴。
4. **风险对冲**：若 SDK 57 在实施期暴露严重问题，可整体降级 SDK 56（RN 0.85），差异面仅原生版本号与少数 API 签名，架构层零影响——这是「跟随最新稳定」而非「追 canary/beta」的纪律。

#### 3.2.3 版本锁定纪律

- 全部 Expo 系依赖用 `npx expo install` 安装（自动对齐 SDK 版本）。
- `expo`、`react-native`、`react` 三个核心锁精确版本（无 `^`），其余依赖锁 major。
- Expo 官方节奏为每年 3 次 SDK 大版本；跟随策略：SDK 58 发布 1-2 个月内评估升级，不追逐 canary/beta（docs.expo.dev 明确：预发布仅建议愿意承担风险者使用）。

### 3.3 状态管理选型：zustand v5 + immer

#### 3.3.1 理由

1. **与桌面端同构**：桌面 `store/permissionStore.ts:54-120` 即为 `create<Store>()(withDevtools(withLogger(immer(...))))` 复合中间件范式；移动端照搬，团队心智零迁移。
2. **selector 粒度**：zustand selector + `useShallow`（桌面 `store/useShallowSelector.ts` 即 re-export `zustand/react/shallow`）天然解决 RN 列表高频渲染的重渲染问题，与 FlatList/FlashList 配合成熟。
3. **体积与无样板**：审批队列、事件缓存这类「单实体集合 + 命令式动作」用 zustand 写比 Redux Toolkit（createSlice/createEntityAdapter）直白得多。
4. **持久化中间件**：`zustand/middleware/persist` 可挂 `expo-sqlite/kv-store` 作为 storage 适配器（AsyncStorage 兼容 API），设置类 store 直接落盘。
5. **immer 收益**：审批队列、事件流的嵌套更新（按 sessionId 分组插入、run 内追加）用 immer draft 语义避免手写不可变更新错误。

#### 3.3.2 与桌面差异（移动端裁剪）

| 桌面模式 | 移动端处置 |
| --- | --- |
| `withDevtools` | 保留（dev client 的 React Native DevTools 面板） |
| `withLogger` | 裁剪为仅 dev 生效且采样（避免生产日志刷屏与包体） |
| 多 store 域（layout/session/terminal…） | 精简为 7 个 store 域（见 4.4） |
| 进程内 EventBus | 保留轻量版（`useSyncExternalStore` 实现的 30 行 EventBus），用于 store 间联动与推送触发 |

### 3.4 导航选型：expo-router

- SDK 57 模板默认 expo-router v6；文件路由 + `typedRoutes`（beta 状态）可按需开启。
- **深链即路由**：`app/(tabs)/approvals.tsx` 等路径天然成为推送深链目标（`crish://approval/<toolCallId>`），配合 expo-notifications 的 `data.url` 字段完成「点击推送 → 定位审批卡」（官方文档有 expo-router + notifications 的标准接线示例）。
- 底部 Tabs（仪表盘/审批/事件流/文件/设置）用 expo-router Tabs 布局；审批详情、会话详情、配对页用 Stack push。
- 备选 React Navigation 手配的差距：需手写 linking 配置（推送深链、初始路由、守卫逻辑）；expo-router 把这些收敛为目录约定，减少样板与配置漂移。

### 3.5 存储选型：expo-sqlite + expo-secure-store

详见第 7 章。选型要点：

- `expo-sqlite` 官方包（SDK 57 异步 API：`openDatabaseAsync`/`runAsync`/`getAllAsync`/`prepareAsync`，配套 `SQLiteProvider` + `useSQLiteContext`，支持 WAL、`PRAGMA user_version` 迁移范式、FTS5 默认开启、可选 SQLCipher、`expo-sqlite/kv-store` AsyncStorage 兼容层）。
- **不引入 ORM**：schema 规模有限（8 张表，见 7.2），直接 SQL + 类型化 DAO 函数更可控；drizzle 列为后续演进项（官方已有 expo-new 集成指南）。
- **不用 AsyncStorage 存业务数据**：事件/审批缓存需要查询、去重、分页，SQLite 是唯一合理选择；KV 只存设置类。
- **令牌类**一律 expo-secure-store（iOS Keychain / Android Keystore-backed EncryptedSharedPreferences）。

### 3.6 网络选型：RN 内建 WebSocket + fetch（自研薄层）

- RN 自带 WebSocket 实现（原生实现，无新增原生模块）；`ws` npm 包在 RN 上是纯 JS 桥接，多一层网络栈且背压语义弱；`react-native-websocket` 是老牌库但维护节奏慢于 RN 内建实现。
- **结论：RN 内建 WebSocket + 自研 `ReconnectingWsClient`**（心跳、指数退避、重连状态投影、请求-响应关联）。重连逻辑参照桌面 `ConnectionManager` 的「被动投影」哲学：只做「传输事件 → 相位」的纯投影，不重复发明状态机（见 6.2）。
- HTTP 用内建 `fetch` + `AbortController` 超时包装；错误归一化复用 `@crish/shared-types` 的 `errors/serialize`（桌面 `daemonClient.ts:66-77` 的 `normalizeCoreError` 同一思路）。
- 不选 axios：移动端 HTTP 面极小（配对握手、令牌刷新、文件元信息），不值得 60KB+ 依赖与拦截器复杂度。

### 3.7 替代候选对比（为何维持 Expo）

#### 3.7.1 bare React Native（弃）

| 维度 | bare RN | Expo（本方案） |
| --- | --- | --- |
| 原生模块管理 | 手管 Gradle/Xcode 工程，升级 RN 需处理 breaking | CNG（prebuild 生成原生工程），SDK 版本原子升级 |
| 推送 | 手接 FCM/APNs/厂商 SDK + 通知通道生命周期 | expo-notifications 封装 + config plugin；厂商推送仍可在 Expo 内自研插件 |
| 更新分发 | 自建热更新/走商店 | EAS Update（类 CodePush）按通道灰度 |
| 风险 | 国内安卓碎片化（华为无 GMS）的适配工作量与 Expo 相同，但其余基础设施收益全无 | 碎片化适配可落在 config plugin 层面复用 |

#### 3.7.2 Flutter（弃）

- **类型体系断裂**：Dart 无法复用 `@crish/shared-types` 的 TS 类型与 zod 解析器，引擎事件契约（生成面 `generated/engine/*`）需双份实现，违反「禁止双源漂移」铁律（`packages/shared-types/src/events.ts:12-14` 的收敛纪律）。
- 桌面端是 React 生态，团队心智与复用面（zustand 范式、事件解析器、错误码）全部丢失。
- 移动端功能面（审批卡、列表、表单）React Native 完全胜任，Flutter 的渲染性能优势在此场景无感。

#### 3.7.3 Kotlin Multiplatform（弃）

- KMP 的收益（原生 UI + 共享逻辑）需要与桌面端共享 Rust 内核——而 Rust 侧已由 crish-desktop 承担，移动端只是远程客户端，不存在「共享核心逻辑」问题。
- 与 Flutter 同理：TS 类型面断裂；双端交互范式（zustand store、审批状态机）无法复用。
- 结论：**除非未来出现「移动端独立承载完整引擎」的需求，否则 KMP 无入场理由**。

---

## 4. 应用架构

### 4.1 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  UI 层（app/ + src/components/）                              │
│  屏幕组件、列表行、审批卡、横幅、深链路由                           │
├─────────────────────────────────────────────────────────────┤
│  状态层（src/store/）                                         │
│  7 个 zustand store（auth/connection/approval/session/       │
│  event/terminal/settings）+ 纯函数 selectors                  │
├─────────────────────────────────────────────────────────────┤
│  数据层（src/data/）                                          │
│  审批/会话/事件/文件/推送注册仓库 + 离线 outbox                  │
│  职责：缓存读写 + 网络编排 + 离线入队（网络优先、缓存回退）            │
├─────────────────────────────────────────────────────────────┤
│  网络层（src/network/）                                       │
│  WsGateway（命令/事件分发）、ReconnectingWsClient、            │
│  WsEnvelope（信封编解码）、HttpClient、EndpointResolver         │
├─────────────────────────────────────────────────────────────┤
│  存储层（src/db/）                                            │
│  SQLite schema/migrations/DAO + secure-store 封装            │
└─────────────────────────────────────────────────────────────┘
           │ 全部层只依赖 @crish/shared-types（类型/解析器/错误码）
           │ 与引擎契约（generated/engine）
```

**依赖规则（单向）**：UI → 状态 → 数据 → 网络/存储。网络层与存储层互不可见；数据层统一编排「网络优先 + 缓存回退 + 离线入队」。状态层只持有领域模型（shared-types 类型），不持有 wire 原始对象（信封在数据层解析后进入 store）。该规则与桌面端「事件必须经桥层归一化」的纪律同源（`apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts:1-14`）。

### 4.2 模块划分（feature-first）

| 模块 | 职责 | 对应桌面参照 |
| --- | --- | --- |
| `auth`（配对与令牌） | 配对状态机、令牌获取/刷新/吊销、设备身份 | `store/permissionStore` 的持久化 + `api/oauthTokenManager` 思想 |
| `connection`（连接管理） | WS 网关生命周期、相位投影、在线/离线切换 | `services/ConnectionManager`（`ConnectionPhase` 四态） |
| `approval`（审批中心） | 待批队列、审批流状态机、离线 outbox | `api/approvalFlowMachine` + `api/chat-bridge/handlers/approvalHandlers` |
| `session`（会话） | 会话列表、run 摘要、状态映射 | `store/sessionIndex` + `orchestration.ts` 类型 |
| `event`（事件流） | 事件信封解析、按 session 分组的流缓存、回放分页 | `api/chat-bridge/handlers/eventParser` + `store/sessionMessageActions` |
| `terminal`（终端流） | 只读输出流、ANSI 轻处理（纯文本阶段）、行缓冲 | `api/parseAnsi` + `store/terminalStore` 只读子集 |
| `files`（文件浏览） | 目录树、文件预览、元信息 | `api/workspaceFsApi` 只读子集 |
| `settings`（设置） | 主机地址、通知偏好、主题、关于 | `store/settingsStore` 子集 |
| `notifications`（推送） | 推送令牌注册、通知处理、深链翻译 | 桌面无对应（新增域） |

### 4.3 目录结构（完整 tree）

```
apps/crish-mobile/
├── app.json                       # Expo 配置 + config plugins（sqlite/notifications/secure-store）
├── app.config.ts                  # 动态配置（环境变量、EAS projectId）
├── package.json                   # @crish/mobile
├── tsconfig.json                  # extends ../../tsconfig.base.json + strict 覆盖
├── babel.config.js                # babel-preset-expo
├── metro.config.js                # monorepo 解析配置（workspace 支持，watchFolders）
├── jest.config.js                 # preset: jest-expo
├── .eslintrc.js                   # eslint-config-expo + 仓库规则
├── index.ts                       # 注册根（TaskManager 后台任务在模块作用域注册）
├── app/                           # expo-router 文件路由（= 深链命名空间）
│   ├── _layout.tsx                # 根 Stack：SQLiteProvider/SecureStoreProvider/AuthGuard
│   ├── index.tsx                  # 路由守卫：按 auth 状态重定向（配对/主界面）
│   ├── pair/
│   │   ├── _layout.tsx
│   │   ├── scan.tsx               # 二维码扫描（expo-camera 前置调研，v1 支持手动输入）
│   │   └── manual.tsx             # 手动输入 IP + PIN
│   ├── (tabs)/
│   │   ├── _layout.tsx            # 底部 Tab（仪表盘/审批/事件流/文件/设置）
│   │   ├── dashboard.tsx          # 仪表盘
│   │   ├── approvals.tsx          # 审批中心
│   │   ├── events.tsx             # 事件流（会话选择器 + 流列表）
│   │   ├── files.tsx              # 文件浏览
│   │   └── settings.tsx           # 设置
│   ├── session/[sessionId].tsx    # 会话详情（事件流聚合视图）
│   ├── approval/[toolCallId].tsx  # 审批卡详情（推送深链目标）
│   └── terminal/[runId].tsx       # 终端流回放（推送深链目标）
├── src/
│   ├── components/                # 跨屏组件
│   │   ├── ui/                    # Button/Card/Badge/EmptyState/LoadingRow（对齐桌面 components/ui）
│   │   ├── ApprovalCard.tsx       # 审批卡（对标桌面 ApprovalAskCard 的移动版）
│   │   ├── ApprovalActionBar.tsx  # 允许/拒绝/附注/二次确认
│   │   ├── SessionRow.tsx
│   │   ├── RunStatusChip.tsx      # RunStatus → 中文标签（复用 orchestration.RunStatus）
│   │   ├── EventRow.tsx           # 事件流行（类型图标 + 摘要）
│   │   ├── FileTreeRow.tsx
│   │   └── ConnectionBanner.tsx   # 断线横幅 + 重连按钮
│   ├── store/
│   │   ├── index.ts               # createStores 组合 + devtools 装配
│   │   ├── useShallowSelector.ts  # re-export zustand/react/shallow（对齐桌面）
│   │   ├── selectors.ts           # 派生选择器（纯函数，可单测）
│   │   ├── authStore.ts           # 配对状态/令牌生命周期
│   │   ├── connectionStore.ts     # WS 相位投影（disconnected/connecting/ready/recovering/offline）
│   │   ├── approvalStore.ts       # 待批队列 + 决策 outbox 状态
│   │   ├── sessionStore.ts        # 会话列表/活跃 run 摘要
│   │   ├── eventStore.ts          # 事件流缓存（内存窗口 + SQLite 持久化桥）
│   │   ├── terminalStore.ts       # 终端流行缓冲
│   │   └── settingsStore.ts       # persist 到 expo-sqlite/kv-store
│   ├── network/
│   │   ├── WsGateway.ts           # 命令/事件分发（移动端版 EventRouter）
│   │   ├── ReconnectingWsClient.ts# 心跳/重连/退避/背压
│   │   ├── WsEnvelope.ts          # 信封编解码（请求 id / 命令 / 事件 / 错误）
│   │   ├── HttpClient.ts          # fetch 封装（超时/重试/错误归一化）
│   │   └── EndpointResolver.ts    # 主机发现（mDNS 预留）与 URL 构造
│   ├── data/
│   │   ├── approvalRepository.ts
│   │   ├── sessionRepository.ts
│   │   ├── eventRepository.ts     # 回放分页 + 增量落库
│   │   ├── fileRepository.ts
│   │   └── outbox.ts              # 离线决策队列（幂等重放）
│   ├── db/
│   │   ├── schema.ts              # 建表 SQL（PRAGMA user_version 迁移）
│   │   ├── migrations.ts          # 迁移数组（v1 → v2 → …）
│   │   ├── dao/                   # 每表 DAO（类型化读写）
│   │   │   ├── sessionsDao.ts
│   │   │   ├── eventsDao.ts
│   │   │   ├── approvalsDao.ts
│   │   │   ├── runsDao.ts
│   │   │   └── outboxDao.ts
│   │   └── secureStore.ts         # 令牌/密钥封装（keychain/keystore）
│   ├── notifications/
│   │   ├── pushRegistration.ts    # 令牌获取/上报/刷新监听
│   │   ├── notificationHandler.ts # setNotificationHandler + 后台任务
│   │   └── deepLink.ts            # 推送 data.url → 路由目标
│   ├── pairing/
│   │   ├── pairMachine.ts         # 配对状态机（纯逻辑，可单测）
│   │   ├── qrPayload.ts           # 二维码载荷编解码（一次性配对码）
│   │   └── pairProtocol.ts        # 配对握手消息定义
│   ├── utils/
│   │   ├── ansi.ts                # ANSI 转义轻处理（复用桌面 parseAnsi 思想，纯文本阶段）
│   │   ├── time.ts                # 相对时间格式化（复用桌面 sessionTime 口径）
│   │   └── id.ts                  # 客户端幂等 id 生成
│   └── types/
│       └── env.ts                 # 环境变量类型（EXPO_PUBLIC_*）
├── assets/                        # 图标/启动图/推送图标（96x96 白色透明）
├── __tests__/                     # 跨域集成测试（配对/离线队列/深链）
│   ├── pairFlow.test.ts
│   ├── outboxFlush.test.ts
│   └── deepLinkRouting.test.ts
└── scripts/
    └── check-chinese.ts           # 中文注释编码自检（复用仓库脚本思路）
```

### 4.4 状态管理设计

#### 4.4.1 store 拆分原则

桌面端将 store 拆为域独立实例（`permissionStore`/`sessionStore`/`terminalStore`…），移动端沿用同一原则，按移动端数据量裁剪为 7 个：

| store | 关键状态 | 持久化 | 数据来源 |
| --- | --- | --- | --- |
| `authStore` | `pairState: 'unpaired'|'pairing'|'paired'|'token_expired'`、`deviceId`、`host` | secure-store（令牌）+ kv-store（host/设备名） | 配对握手、令牌刷新 |
| `connectionStore` | `phase: 'disconnected'|'connecting'|'ready'|'recovering'|'offline'`、`lastError`、`retryCount` | 否 | `ReconnectingWsClient` 事件投影 |
| `approvalStore` | `pending: ApprovalItem[]`、`flow: ApprovalFlowSnapshot`、`outbox: OutboxEntry[]` | SQLite（approvals/outbox 表） | 事件 `approval-requested/resolved`、用户决策动作 |
| `sessionStore` | `sessions: SessionSummary[]`、`activeRuns: RunSummary[]`、`selectedSessionId` | SQLite（sessions/runs 表） | `core_get_status`/`list_sessions`/事件流聚合 |
| `eventStore` | `streams: Record<sessionId, EventWindow>`、`cursorMap` | SQLite（events 表，窗口外卸载） | WS 事件订阅、`core_read_session_events` 回放 |
| `terminalStore` | `lines: Record<runId, TerminalLine[]>`、`follow: boolean` | SQLite（events 表子集，行视图只读） | `tool-output`/`message-delta` 事件 |
| `settingsStore` | 通知偏好、主题、列表密度、主机地址 | kv-store（persist 中间件） | 用户设置 |

#### 4.4.2 store 编写范式（对齐桌面 permissionStore）

```ts
// src/store/approvalStore.ts（示意）
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';   // 与桌面同构中间件
import { withLogger } from './middleware/withLogger';
import type { ApprovalItem } from '../types/domain';

interface ApprovalStore {
  pending: ApprovalItem[];
  decisionBusy: Record<string, boolean>;   // toolCallId → 提交中
  addPending: (item: ApprovalItem) => void; // 幂等：同 toolCallId 覆盖
  removePending: (toolCallId: string) => void;
  markDecision: (toolCallId: string, outcome: 'approved' | 'denied') => void;
}

export const useApprovalStore = create<ApprovalStore>()(
  withDevtools(
    withLogger(
      immer((set) => ({
        pending: [],
        decisionBusy: {},
        addPending: (item) =>
          set((s) => {
            s.pending = upsertPending(s.pending, item);
          }),
        removePending: (toolCallId) =>
          set((s) => {
            s.pending = s.pending.filter((p) => p.toolCallId !== toolCallId);
            delete s.decisionBusy[toolCallId];
          }),
        markDecision: (toolCallId, outcome) =>
          set((s) => {
            // 幂等：approval-resolved 事件回来时不再重复落库
            s.pending = s.pending.map((p) =>
              p.toolCallId === toolCallId ? { ...p, decision: outcome } : p
            );
          }),
      }))
    ),
    'ApprovalStore'
  )
);
```

#### 4.4.3 selector 模式

- 列表组件一律 `useShallow` 选取原始数组 + 稳定引用，避免事件流高频追加导致全列表重渲染（复用桌面 `useShallowSelector.ts` 同一 import）。
- 派生数据（如「待批数 + 断线状态 → 顶栏红点」）用 zustand 外的纯函数提取，放 `store/selectors.ts`，可单测。

```ts
// src/store/selectors.ts（示意）
import { useApprovalStore } from './approvalStore';
import { useConnectionStore } from './connectionStore';

export const selectApprovalBadge = () =>
  useApprovalStore((s) => s.pending.length) +
  (useConnectionStore.getState().phase === 'offline' ? 1 : 0);
```

#### 4.4.4 事件 → store 的接线（数据层职责）

WS 事件到达顺序：`WsGateway` → 事件解析器（复用 `@crish/shared-types` 生成解析器 + 宽容归一，见 6.1.4）→ 数据层 repository（**先落 SQLite，再通知 store**）。禁止组件直接消费原始事件，保证「杀进程重启后事件流从 SQLite 恢复」的离线一致性。桌面端同纪律见 `approvalHandlers.ts:25-114`（事件 → 状态机 → store 回调，组件不碰原始载荷）。

### 4.5 跨端类型复用面（@crish/shared-types）

移动端 import 清单（全部为 shared-types 现有导出，禁止复制粘贴）：

| 模块 | 复用内容 | 用途 |
| --- | --- | --- |
| `events.ts` | `AgentEvent` 联合类型 | 事件流渲染的类型开关（`never` 穷尽检查） |
| `generated/engine` | `parseEngineEvent`、`EngineEvent`、信封类型 | 事件解析（与桌面 `eventParser.ts` 同一解析器） |
| `permissions.ts` | `PermissionRequest`、`PermissionBehavior` | 审批卡数据模型 |
| `orchestration.ts` | `RunStatus`、`RunOutcome`、`OrchestratorRunRecord`、`PendingInputRecord` | 会话/run 状态渲染与 L0-L3 控制 |
| `run-control.ts` | `RunControlLevel`、`RUN_CONTROL_LEVEL`、`createRunControlIntent` | 停止/取消/注入控制消息构造 |
| `message.ts` | `AgentMessage`、`AgentMessageBlock` | 消息增量视图（message-delta） |
| `errors/*` | `CrishErrorCode`、`normalize`、`serialize`、`Result` 工具 | 错误归一化与用户可读翻译 |
| `stored-event.ts` | `StoredEvent`、`OrchestratorSessionEventSummary` | 本地缓存的事件日志结构对齐 |
| `session-identity.ts` | `SessionIdentityKind`、`PENDING_DRAFT_SESSION_ID` | 会话身份阶段（桌面一致性） |

跨端漂移防线：移动端任何「看起来像事件/命令」的类型定义必须先到 `packages/shared-types` 查找；确需新增类型时提交 shared-types 变更 + 生成面同步（对齐 `crates/conex-types/src/events.rs:6-8` 的注册表纪律）。

---

## 5. 核心屏幕设计

### 5.0 导航总图与路由守卫

```
启动 ─► 根布局(_layout.tsx)
         ├─ SQLiteProvider(openDatabaseAsync + migrateIfNeeded)   ─┐
         ├─ SecureStore 就绪                                        │ 基础设施
         └─ AuthGuard 判定路由：                                     │
              pairState === 'paired'    → 重定向 (tabs)/dashboard
              pairState === 'unpaired'  → 重定向 /pair/manual
              token 过期（校验失败）      → 重定向 /pair/manual（保留会话数据）
  底部 Tabs：dashboard | approvals | events | files | settings
  Stack push：session/[sessionId] → terminal/[runId]
  Stack push：approval/[toolCallId]（推送深链直达）
```

> 【裁决修正 7】Tab 结构已被 **M4 §0.2 裁决**（首页/会话/审批/文件/设置 五 Tab；
> 事件流并入会话详情，`(tabs)/events.tsx` 取消）：本节「events Tab」形态是
> 旧建议，实施以 M4 §2.3 目录为准（AU1 P1-4 关闭）。

路由守卫实现要点（`app/_layout.tsx`）：

```tsx
// 伪代码：路由守卫
function AuthGuard({ children }: PropsWithChildren) {
  const pairState = useAuthStore((s) => s.pairState);
  const hydrated = useAuthStore((s) => s.hydrated);   // secure-store 读取完成
  if (!hydrated) return <SplashGate />;                // 防闪烁：令牌未读出前不跳转
  if (pairState !== 'paired') return <Redirect href="/pair/manual" />;
  return children;
}
```

### 5.1 配对页（/pair/scan 与 /pair/manual）

**功能规格**：

| 项 | 说明 |
| --- | --- |
| 输入 | ① 扫码：摄像头读取桌面「配对二维码」；② 手动：输入主机 IP/主机名 + CXN 配对码【裁决修正 1：配对码以 D3 §4.1 为准（CXN-XXXX-XXXX-XXXX 12 字符 base32、10 分钟、5 次失败上限）；原「6 位 PIN」作废】 |
| 输出 | 配对成功 → 存入 secure-store（长时令牌 + 主机指纹）→ 进入主界面 |
| 安全 | 配对码一次性（D3 §4.1：10 分钟过期 + 单码 5 次失败上限；X25519+HKDF 密码学链见 D3 §4.4）【裁决修正 1】；令牌绑定 deviceId + 平台指纹 |
| 重试 | 失败给出可读错误（错误码：`common.invalid_input` / `network.unreachable` / 401 → 配对码过期） |
| 附加 | 配对成功后提示开启推送（引导权限弹窗，Android 13+ 与 iOS 首次时机不同） |

**配对状态机（`pairMachine.ts` 纯逻辑，可单测）**：

```
状态：idle → scanning → requesting → exchanged → done
                      ↘ error（可重试：重新扫码/输入）
事件：SCAN_RECEIVED(码) / PIN_ENTERED / EXCHANGE_OK(令牌) / EXCHANGE_FAIL(reason) / RETRY

状态转换表：
  idle        --PIN_ENTERED|SCAN_RECEIVED--> requesting
  requesting  --EXCHANGE_OK--> exchanged
  requesting  --EXCHANGE_FAIL--> error
  error       --RETRY--> requesting
  exchanged   --TOKEN_STORED--> done（持久化完成后进入主界面）
```

**配对握手流程伪代码**：

```ts
// src/pairing/pairProtocol.ts（示意）
async function pairWithHost(endpoint: Endpoint, pin: string): Promise<PairResult> {
  // 第 1 步：请求一次性配对码校验（HTTP POST /v1/pair/verify）
  const verify = await http.post('/v1/pair/verify', {
    pin, deviceId, platform: 'android' | 'ios',
    deviceName: Device.getDeviceName(),
  }, { timeout: 10_000 });
  // 第 2 步：校验通过，服务端返回短期交换凭据（60 秒有效）
  const { exchangeToken, expiresIn } = verify.body;
  // 第 3 步：换取长时访问令牌 + 刷新令牌（绑定 deviceId）
  const token = await http.post('/v1/pair/token', {
    exchangeToken, deviceId, publicKey: deviceKey.publicKey,
  });
  // 第 4 步：本地持久化（secure-store）
  await SecureStore.setItemAsync(KEYS.ACCESS_TOKEN, token.accessToken);
  await SecureStore.setItemAsync(KEYS.REFRESH_TOKEN, token.refreshToken);
  await SecureStore.setItemAsync(KEYS.HOST_FINGERPRINT, token.hostFingerprint);
  return { ok: true, host: verify.body.hostMeta };
}
```

**关键交互流**（手动配对）：输入 IP → 输入 PIN → 点「连接」→ 请求校验（loading 态，10s 超时）→ 成功：跳主界面 + 引导推送；失败：横幅显示错误码翻译（复用 `errors/info.ts` 的中文文案面）。

### 5.2 登录态与令牌生命周期（authStore）

移动端无「账号密码登录」——登录态由配对令牌维持。令牌生命周期：

```
pairing 成功 ─► accessToken(有效) ─► 400/401(令牌过期/吊销)
                    │                     │
                    │                ┌────┴────┐
                    │                ▼         ▼
                    │           refreshToken    → 刷新失败（吊销/网络）
                    │           刷新成功         → pairState = 'token_expired'
                    └───────────────────────────► 引导重新配对（保留 SQLite 缓存数据）
```

- 访问令牌有效期建议 24h；刷新令牌 30 天，设备主动解绑（设置页「移除本机」）即吊销。
- `authStore` 只信任 secure-store 的持久化结果；内存态一律以持久化为准（防 kill 后闪跳）。
- 令牌刷新用 HTTP（独立于 WS），WS 认证失败码 `auth.invalid_token` 触发刷新流程而非直接解除配对。

### 5.3 仪表盘（(tabs)/dashboard）

**功能规格**：

| 区块 | 内容 | 数据源 |
| --- | --- | --- |
| 连接状态卡 | WS 相位、主机名/地址、最后在线时间 | `connectionStore` |
| 活跃 run 列表 | 进行中/等待审批的 run（状态 chip、会话名、启动时间、进度线索） | `core_get_status` + 事件增量 |
| 待批概览 | 待批数（进入审批中心的入口，红点徽标） | `approvalStore` |
| 会话摘要 | 最近会话（标题/更新时间/run 状态） | SQLite sessions 表 + `list_sessions` 增量 |
| 快速动作 | 「刷新」「重连」「进入审批」 | 命令调用 |

**交互流伪代码**：

```ts
// 仪表盘挂载：全量快照 + 增量订阅
useEffect(() => {
  // 1. 拉全量快照（断线时走 SQLite 缓存，带 stale 标记）
  refreshDashboard();
  // 2. 订阅 WS 事件（网关单例已启动；此处只注册回调）
  const unsub = wsGateway.on('engine', handleEngineEvent);
  return unsub;
}, []);

function handleEngineEvent(envelope: EngineEnvelope) {
  switch (envelope.type) {
    case 'run-started': case 'run-completed': case 'run-failed':
      sessionRepository.applyRunEvent(envelope.event);   // 落库
      break;
    case 'approval-requested':
      approvalRepository.ingest(envelope.event);          // 落库 + 推送通知
      break;
    default:
      eventRepository.append(envelope);                   // 事件流落库
  }
}
```

**状态图（仪表盘数据新鲜度）**：

```
ready(在线) ──core_get_status 每 30s 轮询 + 事件驱动刷新──► fresh
    │                                                       │
    ▼                                                        │
recovering ──重连成功──► fresh（重连后立即全量刷新）              │
    ▼                                                        │
offline ──显示 SQLite 缓存 + 「数据可能过期」横幅────────────────┘
```

### 5.4 审批中心（(tabs)/approvals + approval/[toolCallId]）

**功能规格**（对齐桌面 `ApprovalAskCard` 与 `ApprovalFlowMachine`）：

| 项 | 说明 |
| --- | --- |
| 列表 | 待批请求按时间倒序；每项显示工具名、会话、摘要、风险等级徽标（后端 metadata 驱动，不按工具名猜——对齐桌面 `ApprovalAskCard.tsx:2-4` 注释纪律） |
| 审批卡 | 工具参数只读展示（截断 + 展开）、cwd、风险事实 chips、信任域提示 |
| 动作 | 「允许」（可选附注）、「拒绝」（必填原因可留空）、高危项二次确认（`requiresDoubleConfirm`） |
| 离线 | 断线时动作入 outbox（见 6.5），卡片显示「待发送」标记 |
| 幂等 | toolCallId 为唯一键：重复 `approval-requested` 覆盖；决策已送达后卡片消失 |
| 超时 | 展示剩余时间（桌面 `remainingMs` 同款进度条）；超时后卡片置灰「已过期」 |

**审批流状态机（移动版，参照桌面 `approvalFlowMachine.ts` 语义裁剪）**：

```
事件：approval_requested(toolCallId) / approval_resolved(toolCallId, denied?)
      user_allow(toolCallId, note) / user_deny(toolCallId, reason)
      send_ok(toolCallId) / send_failed(toolCallId) / connection_lost / connection_restored

状态：
  absent ──approval_requested──► pending
  pending ──user_allow/deny──► submitting
  submitting ──send_ok──► resolved(本地移除)
  submitting ──send_failed──► queued（入 outbox，标「待发送」）
  queued ──connection_restored──► replaying ──send_ok──► resolved
  queued ──user_cancel──► cancelled（从 outbox 移除，标记拒绝）
  pending ──approval_resolved──► resolved（桌面已处理，本地同步移除）
  pending ──approval_timeout──► expired（只读态）
```

**审批动作发送伪代码**：

```ts
// src/data/approvalRepository.ts（示意）
async function decide(toolCallId: string, decision: 'allow' | 'deny', note?: string) {
  const flow = getApprovalFlow();
  const outcome = flow.dispatch({ type: 'user_allow', toolCallId, note });
  if (outcome.changed && outcome.snapshot.status === 'submitting') {
    const ok = await trySendDecision(toolCallId, decision, note);  // 见下
    flow.dispatch(ok ? { type: 'send_ok', toolCallId }
                     : { type: 'send_failed', toolCallId });
  }
}

async function trySendDecision(toolCallId: string, decision: 'allow' | 'deny', note?: string) {
  if (connectionStore.getState().phase !== 'ready') return false;  // 直接入队
  try {
    // 与桌面 approvalHandlers.ts:78-79 同一命令面：core_approve_tool { toolCallId, scope }
    await wsGateway.send(decision === 'allow' ? 'core_approve_tool' : 'core_deny_tool', {
      toolCallId,
      scope: 'project',
      ...(note ? { reason: note } : {}),
    });
    return true;
  } catch {
    return false;   // 网络失败 → outbox
  }
}
```

### 5.5 事件流（(tabs)/events + session/[sessionId]）

**功能规格**：

| 项 | 说明 |
| --- | --- |
| 会话选择器 | 顶部横向 chips 或下拉：切换 sessionId（数据源：sessions 表） |
| 流列表 | 事件按 `sequence` 排序；行类型：消息增量、工具调用/结果、run 状态、审批、子代理 |
| 渲染 | 文本/代码块用轻量 Markdown 渲染（白名单子集，无 HTML 风险面）；ANSI 转纯文本 |
| 回放分页 | 向上滚动加载更早事件（`core_read_session_events` + 本地 SQLite 分页，100 条/页） |
| 实时 | WS 事件到达 → 追加（`follow` 模式自动滚底，用户上翻时暂停） |

**分页策略伪代码**：

```ts
// src/data/eventRepository.ts（示意）
async function loadOlder(sessionId: string, beforeSequence: number, limit = 100) {
  // 1. 先查本地 SQLite（events 表按 sessionId+sequence 索引）
  const local = await eventsDao.listBefore(sessionId, beforeSequence, limit);
  if (local.length >= limit) return { events: local, fromCache: true };
  // 2. 本地不足 → 走 WS 命令拉远端（断线时返回缓存并标记 fromCache=false）
  if (connectionStore.getState().phase === 'ready') {
    const remote = await wsGateway.invoke('core_read_session_events', {
      sessionId, beforeSequence, limit,
    });
    await eventsDao.upsertMany(sessionId, remote);   // 回填缓存
    return { events: remote, fromCache: false };
  }
  return { events: local, fromCache: true };
}
```

**事件行渲染映射**（`EventRow.tsx`）：事件类型 → 图标 + 中文摘要；未知类型走 `never` 穷尽分支，宽容兜底显示「事件」+ 原始 type 字段（对齐桌面 `eventParser.ts` 的 unknown-case 显式登记纪律）。

### 5.6 终端流（terminal/[runId]，只读）

**功能规格**：

| 项 | 说明 |
| --- | --- |
| 输入 | runId（会话详情页或推送深链进入） |
| 内容 | run 的终端输出：`tool-output`/`message-delta` 的文本块按行缓冲渲染 |
| 控制 | 顶部工具条：自动跟随开关、清屏（本地）、复制全部、停止（L2 cooperative_stop）/强制取消（L3 force_cancel，长按二次确认） |
| 只读边界 | 不实现输入法注入（无 PTY 写通道）；命令输入走「软注入」（L1 soft_inject，见 5.7） |
| 性能 | 行缓冲上限 5000 行；超出丢弃最旧（环形缓冲）；ANSI 转义做白名单处理（颜色/光标移动收敛为纯文本，防注入） |

**控制动作发送**（复用桌面 `runControlClient.ts` 的语义）：

```ts
// src/data/runControl.ts（示意）
import { RUN_CONTROL_LEVEL } from '@crish/shared-types';

async function stopRun(runId: string, level: 'cooperative' | 'force') {
  await wsGateway.send('core_run_control', {
    level: level === 'cooperative' ? RUN_CONTROL_LEVEL.L2 : RUN_CONTROL_LEVEL.L3,
    runId,
  });
  // 桌面双线保留在桌面侧；移动端只走 canonical 单线（run-control）
}
```

### 5.7 文件浏览（(tabs)/files）

**功能规格**：

| 项 | 说明 |
| --- | --- |
| 目录树 | 懒加载：进入目录才请求子项；`workbench_list_directory` 只读调用（engine 面新增只读命令或复用 gui 面，实施时按权限矩阵定，见 6.1.3） |
| 文件预览 | 文本文件（≤ 1MB）读取内容预览；图片显示缩略图元信息（不下载原图） |
| 元信息 | 名称/大小/修改时间/类型图标 |
| 能力边界 | 无编辑/删除/上传；无 git 操作 |
| 缓存 | 目录列表缓存 60s TTL；断线时显示缓存 + stale 标记 |
| 深链 | 不支持文件级深链（v1），仅浏览 |

**交互流**：`FileTreeRow` 点击目录 → 展开（首次进入拉取 `list_directory`，children 落 SQLite file_cache 表）→ 点击文件 → `read_file_content`（limit 1MB）→ 预览页。预览页带加载/失败/超限三态。

### 5.8 设置（(tabs)/settings）

| 分区 | 内容 |
| --- | --- |
| 连接 | 主机地址（改地址触发重新配对）、重连间隔偏好、TLS 开关（v1 默认强制 WSS，内网自签证书场景留开关） |
| 通知 | 推送开关、频道细分（审批/run 完成/任务失败/安全检查，Android 通知通道映射见 8.4）、免打扰时段 |
| 安全 | 本机解锁（expo-local-authentication 可选，v1 列为 P2）、移除本机（吊销令牌 + 清缓存，走 trash 语义不可恢复则二次确认） |
| 关于 | 版本、EAS 构建号、SDK 版本、日志导出（诊断用） |

**移除本机交互流**（安全敏感操作）：点击「移除本机」→ 二次确认弹窗（说明：将无法再接收审批推送）→ 调用 `POST /v1/pair/revoke`（吊销令牌）→ 无论成败清空 secure-store 令牌 → pairState = 'unpaired' → 重定向配对页 → **不清除** SQLite 缓存（保留离线可看的数据，重新配对后恢复增量）→ Toast「已移除本机」。

---

## 6. 网络层

### 6.1 连接架构：WS 网关（桌面 daemon 新增面）

#### 6.1.1 为什么需要网关

桌面端传输是 Tauri IPC（进程内 invoke），移动端必须走网络。Rust daemon 侧新增一个 WS 网关层（Rust 实现，或由 crish-desktop 进程内起一个 WS 服务），把 `commandManifest` 的 **engine surface** 命令映射为 WS 请求-响应（`invoke` 语义），并把引擎事件流经 WS 推给已认证的移动端会话。

#### 6.1.2 网关职责

| 职责 | 说明 |
| --- | --- |
| 连接管理 | 监听端口（默认 **8765**【裁决修正 6：原 7821 作废】，可配置）；WSS 首选（自签证书 + 移动端指纹固定，见 6.1.5） |
| 认证 | 移动端连接时携带访问令牌 → 校验 deviceId 绑定 → 建立会话 |
| 命令透传 | WS 消息 `{ type: 'invoke', id, command, params }` → Rust 命令处理（复用引擎命令注册面）→ `{ type: 'invoke-result', id, ok, data \| error }` |
| 事件推送 | 引擎事件信封原样转发（带 `seq` 游标，供移动端断线追平，见 6.5.3） |
| 配额与限流 | 每设备命令速率限制；只读命令白名单（移动端默认无写权限，除审批/控制类） |
| 会话绑定 | 同一设备仅一个活跃 WS 会话（新连接踢旧连接，防双设备竞态审批） |

**命令面权限矩阵（移动端角色）**：

| 命令（engine surface） | 移动端 | 说明 |
| --- | --- | --- |
| `core_get_status` | 允许 | 状态快照 |
| `core_get_run_snapshot` / `core_read_run_events` / `core_read_session_events` | 允许 | 回放 |
| `list_sessions` / `load_session_body` | 允许 | 会话列表/详情 |
| `core_approve_tool` / `core_deny_tool` | 允许 | 审批（核心场景） |
| `core_run_control` / `core_cancel_run` | 允许（L1/L2/L3） | 停止/取消/软注入 |
| `workbench_list_directory` / `workbench_read_file_content` | 允许（只读子集） | 文件浏览（实施时评估是否需要新增 engine 面只读命令） |
| `core_run_task` / `save_session_body` / `delete_session` / 配置写命令 | 禁止（v1） | 防止移动端越权写 |

#### 6.1.3 移动端命令调用封装

```ts
// src/network/WsGateway.ts（示意）
type InvokeParams = Record<string, unknown>;

async function invoke<T>(command: string, params: InvokeParams, timeoutMs = 15_000): Promise<T> {
  const id = nextRequestId();
  const response = await wsClient.request(id, { type: 'invoke', id, command, params }, timeoutMs);
  if (!response.ok) {
    // 错误面复用 shared-types：{ kind, detail } 归一为 CrishErrorCode 可读面
    throw normalizeWsError(response.error);
  }
  return response.data as T;
}

// 订阅：网关单例向数据层广播解析后的信封
function on(event: 'engine' | 'legacy', cb: (envelope: BridgeEventEnvelope) => void): () => void;
```

#### 6.1.4 事件解析（复用桌面单一入口纪律）

- 主解析器：`@crish/shared-types` 生成面 `parseEngineEvent`（严格契约，直接产出具体信封类型）。
- 宽容归一：桌面 `eventParser.ts` 的宽容形态（历史别名 `text-delta`/`run-completed` 等、数据面 task/timer/cron/security-audit 漂移）在移动端 **不复刻**——v1 只订阅严格契约事件，未知事件走 `unknown-case` 显式登记（日志 + 计数，不静默吞）。
- 信封校验失败（`parseErr`）→ 事件进本地 `dead_letter` 表（调试可查），不阻塞流。

#### 6.1.5 传输安全

- v1 强制 WSS：网关默认生成自签证书；配对时把主机证书指纹写入移动端（`HOST_FINGERPRINT`，secure-store），连接时做 **证书固定（pinning）**，防中间人。
- 移动端不做「信任所有证书」选项（v1 无该开关，安全默认）。
- 令牌防重放：每个 WS 消息带单调递增 `seq`；网关对低于会话基线 seq 的 `invoke` 拒绝（防重放审批决策）。

### 6.2 WS 客户端：ReconnectingWsClient

#### 6.2.1 选型确认

RN 内建 `WebSocket`（原生实现，iOS/Android 均可用，支持二进制与文本帧）。`ws` npm 包、`react-native-websocket` 均为多余依赖面。重连、心跳、背压全部自研——这也是本方案可控性最强的部分。

#### 6.2.2 类结构与职责

```ts
// src/network/ReconnectingWsClient.ts（示意）
export type WsPhase = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'dead';

export class ReconnectingWsClient {
  private ws: WebSocket | null = null;
  private phase: WsPhase = 'idle';
  private retryCount = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<number, { resolve; reject; timer }>();  // 请求 id → 挂起
  private listeners: Set<(envelope: RawEnvelope) => void> = new Set();

  constructor(private opts: { url; tokenProvider; heartbeatMs?; maxRetryMs? }) {}

  // 连接生命周期（AppState 联动：前台 open、后台 close 或保持 idle 挂起）
  async connect(): Promise<void>;
  disconnect(): void;

  // 请求-响应（带超时；超时即 reject，不残留 pending）
  async request(id: number, msg: unknown, timeoutMs: number): Promise<WsResponse>;

  // 事件推送回调注册
  onEnvelope(cb: (env: RawEnvelope) => void): () => void;
}
```

#### 6.2.3 心跳与保活

- 客户端每 30s 发送 `{ type: 'ping' }`；网关回 `{ type: 'pong' }`；60s 无 pong → 判定连接假死 → 主动关闭重连。
- 服务器侧（网关）每 90s 无任何客户端帧 → 判定失联 → 断开并通知引擎「移动端离线」（影响：审批事件经推送兜底）。
- 心跳与业务帧共用同一连接，不额外开销。

#### 6.2.4 重连策略（指数退避 + 抖动）

```
失败序列：1s → 2s → 4s → 8s → 16s → 30s(封顶) [+ 0~1s 抖动]
到达封顶后每 30s 重试一次；前台恢复（AppState active）立即重试一次。
重连成功 → 立即执行「追平」（见 6.5.3）→ 重放 outbox（见 6.5.2）。
```

- `AppState` 监听：iOS 后台 30s 后系统挂起网络 → 主动断开进入 `offline`；回到前台触发重连。Android 后台由系统 Doze 管，同样走离线态。
- 网络切换（NetInfo）：`wifi → cellular` 或恢复联网 → 触发即时重连。

#### 6.2.5 连接相位投影（对齐桌面 ConnectionManager）

```
WsClient 内部状态      connectionStore.phase       UI 表现
─────────────────────────────────────────────────────────
idle                 disconnected              横幅「未连接」
connecting           connecting                loading 指示
open                 ready                     正常
reconnecting         recovering                横幅「重连中…第 N 次」
重连失败超限/无网络    offline                   「离线，审批动作将排队」横幅 + 推送兜底
```

相位投影是纯函数（`mapWsPhase(wsState, netInfo): ConnectionPhase`），单测覆盖。

### 6.3 HTTP 客户端（HttpClient）

| 能力 | 实现 |
| --- | --- |
| 超时 | `AbortController` + `setTimeout`（默认 10s，配对握手 15s） |
| 重试 | 幂等请求（GET/令牌刷新）自动重试 2 次（指数退避）；POST 决策类不自动重试（走 outbox） |
| 错误归一化 | 复用 `@crish/shared-types` 的 `errors/` 工具：网络层错误 → `network.unreachable`；HTTP 状态 → 对应码映射表（401 → `provider.reauth_required` 语义 → 触发令牌刷新） |
| Base URL | `EndpointResolver`：`wss://host:8765` ↔ `https://host:8765` 同端口协议映射【裁决修正 6：原 7821 作废】 |

### 6.4 配对流程客户端实现（详见 5.1，此处补协议细节）

```
手机                                                      桌面 daemon（网关）
 │  1. GET  /v1/pair/qr（桌面展示二维码，含主机指纹+pinHash）
 │ ◄──────────────────────────────────────────────────────────────│
 │  2. POST /v1/pair/verify { pin, deviceId, deviceName }          │
 │ ──────────────────────────────────────────────────────────────► │
 │  3. ← 200 { exchangeToken(60s), hostMeta }                      │
 │  4. POST /v1/pair/token { exchangeToken, deviceId, pubKey }     │
 │ ──────────────────────────────────────────────────────────────► │
 │  5. ← 200 { accessToken(24h), refreshToken(30d), hostFingerprint }│
 │  6. 存 secure-store；断开 HTTP，建立 WSS（证书固定 + 令牌）      │
 │ ─────────────────── WSS connect（7）──────────────────────────► │
 │  8. ← 200 { hello, serverVersion, contractVersion }（版本校验）  │
```

**版本校验**：`contractVersion` 对齐 `commandManifest.ts:18` 的契约版本；不匹配 → 弹「桌面端版本过旧/过新」提示并阻止配对（防协议漂移误操作）。

### 6.5 断线重连与离线队列

#### 6.5.1 三层防御模型

| 层 | 机制 | 场景 |
| --- | --- | --- |
| L1 快速重连 | 指数退避自动重连 | 瞬时网络抖动 |
| L2 追平 | 断线期间的事件游标 `seq` 追平 | 重连后补齐漏掉的事件 |
| L3 离线 outbox | 决策类动作落 SQLite，重连后重放 | 长时间离线/后台被杀 |

#### 6.5.2 离线 outbox（审批决策的送达保证）

```
outbox 表（SQLite）：
  id TEXT PRIMARY KEY,            -- 本地动作 id（uuid）
  toolCallId TEXT NOT NULL,       -- 幂等键（引擎侧以此去重）
  action TEXT NOT NULL,           -- 'approve' | 'deny'（拒绝带 reason）
  payload TEXT NOT NULL,          -- 完整命令参数（JSON）
  status TEXT NOT NULL,           -- 'queued' | 'sending' | 'sent' | 'failed' | 'superseded'
  attempts INTEGER DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL

投递规则：
  1. 入队即写库（用户点「允许」的瞬间，不管网络状态）。
  2. 重连成功 / WS open → 顺序重放（FIFO，单飞，禁止并发重放同一批）。
  3. 每单超时 10s 重试，最多 5 次；仍失败 → 保持 queued，进入「审批可能超时」提醒。
  4. 引擎返回 success → status='sent'；返回「决策已处理/未知 toolCallId」→ status='superseded'（本地清理）。
  5. 用户撤销 → 删除条目 + 本地标记拒绝（对齐桌面 approval_cancelled 语义）。
  6. 桌面侧先处理了同一 toolCallId → approval-resolved 事件到达 → outbox 同键条目置 superseded。
```

#### 6.5.3 事件游标追平

- 网关为每个移动端会话维护 `lastSeq`；断线后重连，客户端上报本地最大 `seq`，网关从 `seq+1` 重放未投递事件（有界：最多 10 万条/1 小时，超限走全量快照命令）。
- 事件信封 `sequence` 字段为单调递增全局游标（对齐 `crates/conex-types/src/events.rs:10-12` 的注入面语义）。

#### 6.5.4 离线期间的用户体验

| 场景 | 表现 |
| --- | --- |
| 审批卡离线决策 | 立即入队 + 卡片「待发送」徽标 + Toast「网络恢复后自动发送」 |
| 事件流 | 只读本地缓存；顶部 stale 标记；「重试」按钮 |
| 仪表盘 | 缓存快照 + 「数据可能过期于 HH:mm」 |
| 推送 | 若推送可用，审批事件仍经厂商通道到达（决策在推送深链页内也可发起，同样走 outbox） |

---

### 6.6 网络诊断与联调辅助（设置页「诊断」入口）

移动端作为远程伴侣，最常见的问题面就是「连不上/推送不到」。设置页提供诊断面板，避免把问题逐层上报给用户：

| 诊断项 | 内容 | 数据源 |
| --- | --- | --- |
| 连接状态快照 | 相位、重连次数、最后错误码、心跳 RTT（最近 5 次采样） | `connectionStore` + `ReconnectingWsClient` 指标 |
| 网关握手信息 | 服务器版本、契约版本、baseSeq、token 有效期 | `hello-ok` 帧缓存 |
| 事件流健康 | 最近事件时间、解析失败数（dead_letters 计数）、游标落后量 | `eventStore` + `kv` 表 |
| 推送状态 | 推送令牌（脱敏尾 4 位）、通道注册结果、最近收到时间 | `pushRegistration` 记录 |
| 证书/配对 | 指纹尾 8 位、设备 id、配对时间 | secure-store 元数据 |
| 导出日志 | 一键打包最近 200 条日志（应用内滚动缓冲）为文本分享 | `LoggerService` 移动版 |

诊断面板只读展示 + 复制按钮，不提供「修改」入口（避免用户改坏连接配置）；日志导出格式与桌面诊断报告（`doctorReport` 思想）字段对齐，便于双端问题单互认。

### 6.7 节流与背压

| 面 | 策略 |
| --- | --- |
| 事件入栈 | 数据层按 50ms 窗口批量落库（`kv` 表游标批量推进），避免逐条 `runAsync` 写放大 |
| 渲染 | `eventStore` 内存窗口上限（每 session 5000 条），超限卸载到 SQLite；`FlashList` 虚拟化 + 行组件 `memo` |
| 心跳与重连 | 心跳 30s；重连退避封顶 30s；前台恢复才允许「立即重试」（防后台耗电） |
| 大载荷 | `invoke-result` 超过 512KB 的分页接口走游标式分批（`core_read_session_events` 的 `limit` 参数），WS 单帧硬上限 1MB，超限走 HTTP 补充通道（P2） |

---

## 7. 本地存储

### 7.1 存储分层

| 层 | 技术 | 内容 |
| --- | --- | --- |
| 敏感层 | expo-secure-store（Keychain/Keystore） | accessToken / refreshToken / hostFingerprint / deviceKey 私钥 |
| 结构化层 | expo-sqlite（`crish-mobile.db`，WAL） | 事件/审批/会话/run/outbox/文件缓存 |
| 设置层 | expo-sqlite/kv-store | 主题、通知偏好、主机地址（非敏感） |
| 键值兜底 | 无（不用 AsyncStorage 存业务） | — |

### 7.2 expo-sqlite schema（与桌面 conex-db 对应）

> 表设计原则：**与桌面端事件日志结构对齐**（`stored-event.ts` 的 `StoredEvent` 形状：id/sequence/type/sessionId/runId/timestamp/payload），移动端是「引擎事件流的远端副本 + 用户动作」。

```sql
-- schema v1（PRAGMA user_version = 1）
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 会话摘要（对应 OrchestratorSessionEventSummary / list_sessions 返回）
CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,      -- 引擎会话 id
  title        TEXT,
  cwd          TEXT,
  status       TEXT NOT NULL,         -- open | closed | archived
  last_updated INTEGER,               -- 毫秒时间戳
  event_count  INTEGER DEFAULT 0,
  run_count    INTEGER DEFAULT 0,
  active_run_count INTEGER DEFAULT 0,
  pending_approval_count INTEGER DEFAULT 0,
  last_message_preview TEXT,
  pinned       INTEGER DEFAULT 0,
  archived     INTEGER DEFAULT 0,
  deleted      INTEGER DEFAULT 0,
  metadata_json TEXT                  -- 元数据兜底（JsonObject 序列化）
);
CREATE INDEX idx_sessions_updated ON sessions(last_updated DESC);

-- run 摘要（对应 OrchestratorRunRecord）
CREATE TABLE runs (
  run_id       TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  status       TEXT NOT NULL,         -- RunStatus（string 兜底，原样显示）
  outcome      TEXT,
  reason       TEXT,
  created_at   INTEGER,
  started_at   INTEGER,
  finished_at  INTEGER,
  error        TEXT,
  kind         TEXT,                  -- task | goal
  goal_json    TEXT,
  metadata_json TEXT
);
CREATE INDEX idx_runs_session ON runs(session_id, created_at DESC);

-- 事件流（引擎事件信封的本地镜像；sequence 为全局游标）
CREATE TABLE events (
  sequence    INTEGER PRIMARY KEY,    -- 引擎注入的全局 sequence（见 events.rs 注入面）
  event_id    TEXT NOT NULL,          -- 事件体 id（如 messageId）
  type        TEXT NOT NULL,          -- wire type（approval-requested 等）
  session_id  TEXT,
  run_id      TEXT,
  timestamp   INTEGER,                -- 事件时间戳（毫秒）
  payload_json TEXT NOT NULL,         -- 完整事件体（宽容存储，解析在数据层）
  schema_version INTEGER DEFAULT 1,
  ingested_at INTEGER NOT NULL
);
CREATE INDEX idx_events_session ON events(session_id, sequence DESC);
CREATE INDEX idx_events_run ON events(run_id, sequence DESC);

-- 审批请求（本地待批队列 + 历史；payload 为 PermissionRequest JSON）
CREATE TABLE approvals (
  tool_call_id TEXT PRIMARY KEY,      -- 幂等键（对齐引擎 toolCallId）
  request_id   TEXT,
  session_id   TEXT,
  cwd          TEXT,
  tool_name    TEXT NOT NULL,
  summary      TEXT,
  parameters_json TEXT,               -- JsonObject
  tool_metadata_json TEXT,
  risk_meta_json TEXT,                -- 风险事实（桌面 approvalMeta 同源）
  status       TEXT NOT NULL,         -- pending | submitting | queued | resolved | expired | superseded
  decision     TEXT,                  -- approved | denied
  decided_at   INTEGER,
  received_at  INTEGER NOT NULL,
  expires_at   INTEGER                -- 引擎侧超时时刻（nullable）
);
CREATE INDEX idx_approvals_status ON approvals(status, received_at DESC);

-- 离线 outbox（见 6.5.2）
CREATE TABLE outbox (
  id          TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL,
  action      TEXT NOT NULL,          -- approve | deny
  payload     TEXT NOT NULL,          -- 完整命令参数（JSON）
  status      TEXT NOT NULL,          -- queued | sending | sent | failed | superseded
  attempts    INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_outbox_status ON outbox(status, created_at);

-- 文件浏览缓存（60s TTL）
CREATE TABLE file_cache (
  path         TEXT PRIMARY KEY,      -- 绝对路径
  parent_path  TEXT,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,         -- dir | file | symlink | unknown
  size         INTEGER,
  modified_at  INTEGER,
  children_json TEXT,                 -- 目录列表快照（懒加载粒度）
  fetched_at   INTEGER NOT NULL
);
CREATE INDEX idx_file_cache_parent ON file_cache(parent_path);

-- 未知事件（宽容登记，不阻塞流）
CREATE TABLE dead_letters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_json    TEXT NOT NULL,
  parse_error TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- kv 元数据（游标、TTL 等运行态）
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### 7.3 迁移策略

- 迁移驱动：`PRAGMA user_version`（官方推荐范式，`SQLiteProvider` 的 `onInit` 里执行）。
- `migrations.ts` 导出有序数组 `[v1, v2, …]`，每项为「迁移名 + SQL 列表」；测试覆盖「从 v0 逐级升到最新」与「幂等重复执行」。
- 业务数据（事件/审批/会话）在重装 App 后不保留（不做云备份，v1 范围外）；「移除本机」保留 SQLite 数据（见 5.8），重新配对后按 seq 增量补齐。

### 7.4 安全存储（expo-secure-store）

| 键 | 内容 | 备注 |
| --- | --- | --- |
| `token.access` | 访问令牌（24h） | 优先用 `requireAuthentication` 或系统级可用时开启 |
| `token.refresh` | 刷新令牌（30d） | 吊销后删除 |
| `pair.host_fingerprint` | 主机证书指纹 | 证书固定用 |
| `device.keypair` | 设备密钥（Ed25519，配对时生成） | 用于未来消息签名（v1 生成并保存，签名启用列为 P2） |

注意事项（expo-secure-store 官方约束）：iOS 值上限 2048 字节（超限换 Keychain 大值方案，v1 不会超过）；Android 备份默认排除（需确认 `allowBackup=false` 或 SecureStore 默认加密）；开发构建与生产构建的 Keychain 访问组一致（EAS 配置）。

### 7.5 缓存一致性

- 事件落库采用「append 优先」：`sequence` 冲突即幂等覆盖（重连追平可能重复投递）。
- 审批表以 `tool_call_id` 为主键，`approval-resolved` 到达即更新状态（`superseded`），pending 列表只查 `status='pending'`。
- 会话摘要由事件聚合刷新（`run-started`/`run-completed` 等增量），全量刷新由 `core_get_status` 轮询兜底（30s）。

---

## 8. 推送集成

### 8.1 推送定位与总体路径

推送解决「手机不在线/后台挂起时，审批与关键事件仍能触达」的问题。**推送不是事件流的替代，而是补丁**：在线时走 WS 全量流；离线时推送只带「发生了什么 + 去哪里看」，点击后由深链拉起、必要时引导重连。

```
桌面 daemon（引擎事件） ──► 推送网关（公网，轻量服务）
                                  │ 按设备注册表路由
        ┌─────────────┬──────────┴──────────┬─────────────┐
        ▼             ▼                     ▼             ▼
   Expo Push Service  华为 HMS Push         小米/OPPO/vivo   苹果 APNs
   （FCM 透传 / iOS）  （国内华为无 GMS）      厂商通道         （iOS）
        └─────────────┴──────────┬──────────┴─────────────┘
                                 ▼
                        移动端 expo-notifications
                        （前台 handler / 后台通知 / 深链）
```

**双路径原则**：

| 路径 | 触发 | 说明 |
| --- | --- | --- |
| 在线直推 | WS 在线时 | 事件经 WS 到达，本地决定是否弹「应用内通知」（前台 handler） |
| 厂商推送 | WS 离线 / App 后台 / 被杀 | 推送网关根据引擎事件（审批到达、run 完成/失败、安全检查）发出系统通知 |

### 8.2 expo-notifications 接入（SDK 57 事实面）

webfetch 查证的关键事实（docs.expo.dev/versions/latest/sdk/notifications）：

1. **Expo Go 限制**：SDK 53 起，Android 上远程推送在 Expo Go 中不可用，**必须使用 development build**（EAS Build 或本地 prebuild）——本项目从一开始就走 dev client，无 Expo Go 依赖。
2. **双令牌 API**：`getDevicePushTokenAsync()`（原生 FCM/APNs 令牌，可接任意推送服务）与 `getExpoPushTokenAsync({ projectId })`（Expo Push Service 令牌）。**选型：v1 用 Expo Push Service 简化后端**（桌面推送网关只需 HTTP 调 Expo API），原生令牌路径保留为厂商推送演进项。
3. **Android 13+ 权限**：必须先 `setNotificationChannelAsync` 创建至少一个通知通道，系统权限弹窗才会出现；取令牌前必须完成建通道。
4. **后台处理**：后台/被杀时处理推送需要 `expo-task-manager` + `registerTaskAsync`（headless background notification）。
5. **config plugin 配置项**：`icon`（96x96 白色透明 PNG）、`color`、`defaultChannel`、`sounds`、`enableBackgroundRemoteNotifications`（iOS UIBackgroundModes）。
6. **令牌轮换监听**：`addPushTokenListener` 处理服务端令牌滚动（滚动后旧令牌失效）。

### 8.3 推送消息格式（统一载荷）

```json
{
  "title": "crish：等待审批",
  "body": "工具 `delete_file` 请求删除 3 个文件（会话：重构清理）",
  "data": {
    "kind": "approval",                // approval | run-ended | task-failed | security-audit | event
    "url": "crish://approval/tool_call_abc123",
    "sessionId": "sess_01",
    "runId": "run_02",
    "toolCallId": "tool_call_abc123",
    "seq": 12345,                      // 事件游标（点击后追平用）
    "ts": 1754700000000
  },
  "priority": "high"                   // 审批类用 high，其余 normal
}
```

**格式规范**：

- `data.url` 是唯一路由真源（对齐 expo-router 深链，见 5.0 与 8.6）；其余字段仅为路由参数，渲染一律以落地后的实时数据为准（防推送载荷与真实状态漂移）。
- 审批类通知带 `priority: high`（Android 8+ 对应通道重要性；iOS 对应 interruption-level）。
- 事件类通知默认静默（无声音），审批/失败类带声音。
- `seq` 用于点击后追平事件流。

### 8.4 Android 通知通道规划

| 通道 id | 名称 | 重要性 | 用途 |
| --- | --- | --- | --- |
| `approval` | 审批请求 | HIGH（+声音） | 待批审批 |
| `run` | 运行状态 | DEFAULT | run 完成/失败/取消 |
| `security` | 安全检查 | HIGH（+声音） | 安全检查结果、撤销确认 |
| `general` | 一般事件 | DEFAULT（静音） | 其他事件摘要 |

创建时机：App 启动即建（幂等），令牌获取前必须完成（Android 13+ 硬性要求，见 8.2-3）。

### 8.5 国内安卓（HMS/厂商推送）适配路径

**问题本质**：华为等设备无 GMS，FCM 通道不可用；国内商店对「纯 FCM」应用上架受限；且 Expo Push Service 在国内网络的可用性不稳定。

**v1 策略（分阶段）**：

| 阶段 | 方案 | 范围 |
| --- | --- | --- |
| P0（国际版先行） | Expo Push Service + FCM（Google Play 渠道） | 上架 Google Play；海外用户 |
| P1（国内版） | 厂商推送聚合：华为 HMS Push / 小米 / OPPO / vivo 通道，通过自研 config plugin 接入 | 国内商店分发 |

**P1 实现要点**（config plugin 方案）：

1. **自研 config plugin**（`apps/crish-mobile/plugins/withVendorPush.ts`）：`npx expo prebuild` 时向 Android 工程注入厂商 SDK 依赖（Gradle）、`AndroidManifest` 的 Service/Receiver 声明与 `google-services.json` 同级配置（华为 `agconnect-services.json`）。
2. **双令牌上报**：`getDevicePushTokenAsync` 在华为设备上返回 FCM 空值时，经自研原生模块（Expo Module API）读取 HMS 令牌；推送网关按设备注册表选择通道（厂商类型 + token）。
3. **网关侧路由**：推送网关维护「设备 → 通道」映射：国际版走 Expo Push Service；国内版按厂商 API 直发（华为开放接口 `push.cloud.huawei.com` 等），或经第三方聚合（个推/极光）——**实施时二选一，推荐先直连厂商 API**（少一层依赖与合规面）。
4. **统一载荷**：厂商推送的 `data` 字段与 8.3 保持一致（字段名统一，客户端解析无分支）。

**合规**：国内上架需在隐私政策声明「推送令牌与设备信息采集用途」；厂商 SDK 初始化时机遵循各厂商要求（华为 HMS 需在 Application 早期初始化——config plugin 注入）。

### 8.6 点击行为与深链

```
用户点击系统通知
   │
   ▼
expo-notifications 的 response（addNotificationResponseReceivedListener / useLastNotificationResponse）
   │
   ├─ 应用在前台：直接 router.push(data.url)（校验 kind 后跳转）
   ├─ 应用在后台：拉起后由根布局的 useNotificationObserver 处理（官方接线范式）→ router.push
   └─ 应用被杀：冷启动时 getLastNotificationResponse() → 等待 AuthGuard 判定
         ├─ 已配对 → 直接深链跳转
         └─ 未配对 → 跳配对页（保留 pendingRoute，配对成功后补跳）
```

```tsx
// src/notifications/deepLink.ts（示意，对齐 expo-router 官方接线）
function useNotificationObserver() {
  useEffect(() => {
    function redirect(response: NotificationResponse) {
      const url = response.notification.request.content.data?.url;
      if (typeof url === 'string' && isAllowedRoute(url)) {
        router.push(url);              // 白名单校验：只允许 crish:// 应用内路由
      }
    }
    const last = Notifications.getLastNotificationResponse();
    if (last) redirect(last);
    const sub = Notifications.addNotificationResponseReceivedListener(redirect);
    return () => sub.remove();
  }, []);
}
```

**安全**：`data.url` 必须做白名单（只接受应用内路由前缀），防止恶意推送引导到外部地址；深链参数（sessionId/toolCallId）在落地页面二次校验存在性。

### 8.7 推送 ↔ 在线状态协作

- 在线时收到推送：前台 handler（`setNotificationHandler`）决定是否展示——审批类展示横幅（`shouldShowBanner`），事件类直接吞（WS 已实时渲染）。
- 后台时收到推送：系统通知 + `registerTaskAsync` 后台任务（可选：后台静默更新 SQLite 事件缓存——iOS 限制较多，v1 仅 Android 启用，列为 P2）。
- 审批决策送达后：本地调度 `dismissNotificationAsync` 撤销对应通知（防「已处理还挂着通知」）。

---

## 9. 测试与质量

### 9.1 测试分层与工具

| 层 | 工具 | 覆盖 |
| --- | --- | --- |
| 纯逻辑单测 | jest（jest-expo preset） | 状态机（配对/审批流/连接相位投影）、信封解析、outbox 投递、选择器、ANSI 处理、时间格式化 |
| 组件测试 | @testing-library/react-native | 审批卡（风险徽标/二次确认/超时）、事件行渲染、连接横幅、列表空态 |
| 数据层测试 | jest + 内存 SQLite（expo-sqlite 支持 `:memory:` 或测试目录） | DAO CRUD、迁移幂等、游标追平逻辑 |
| 集成测试 | jest（mock WsGateway） | 配对流程、离线决策入队 → 重连重放、深链路由（pairFlow/outboxFlush/deepLinkRouting，`__tests__/`） |
| 跨端契约 | 复用 shared-types 自身测试 | `npm test --workspaces` 已覆盖 `generated/engine` 解析器；移动端新增「订阅事件子集与契约清单一致」漂移测试 |
| 真机验证 | EAS Build dev client + Expo DevTools | 推送全链路（APNs/FCM）、后台行为、通知点击深链、局域网连真机 |

### 9.2 测试基建要点（Expo 官方事实面）

- **jest-expo preset**：官方推荐的 RN 测试 preset（SDK 57 配套版本），处理 Babel/RN 模块 mock（内置 `react-native`、`expo-*` 模块 mock 面）。
- `@testing-library/react-native`：事件驱动断言（`fireEvent`/`waitFor`），对齐桌面 `@testing-library/react` 的用法心智。
- mock 纪律：网络层一律接口注入（`WsGateway` 用 DI），测试里替换为 fake；SQLite 用内存库实例（每测试新建，避免跨用例污染）。
- 关键路径门禁必测清单：
  - 审批「断线 → 决策入队 → 重连 → 重放送达 → 卡片消失」全链路
  - 重复 `approval-requested` 幂等（桌面 `approvalFlowMachine` 同款测试语料）
  - 事件解析 `parseErr` → dead_letter 不阻塞流
  - 连接相位投影全映射表（单测覆盖每一行）

### 9.3 类型策略

- `tsconfig.json`：`extends ../../tsconfig.base.json`（仓库基座），显式 `"strict": true`、`"noUncheckedIndexedAccess": true`、`"exactOptionalPropertyTypes"` 按仓库基座为准。
- `expo-router` 的 `typedRoutes`（experimental）开启后路由字符串走类型校验，防深链拼写漂移（beta 风险可接受，降级开关保留）。
- 领域模型零拷贝：store 与组件直接消费 shared-types 类型；`approval` 域的 `ApprovalItem` 定义为 `PermissionRequest & { 本地附加字段 }`（组合而非重写）。
- `never` 穷尽检查纪律：事件类型 switch 必须带 `default: const _exhaustive: never = ev`（桌面 `approvalFlowMachine.ts:343-348` 同款），新增事件类型时编译期强制处理。

### 9.4 CI 设计

```yaml
# .github/workflows/mobile-ci.yml（示意）
name: mobile-ci
on: [pull_request]
jobs:
  mobile-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck -w @crish/mobile          # tsc --noEmit
      - run: npm run lint -w @crish/mobile
      - run: npm test -w @crish/mobile -- --ci           # jest-expo 全量
      - run: npx expo-doctor                            # SDK 依赖对齐检查
      - run: npm test -w @crish/shared-types            # 跨端契约回归
```

- 快层（typecheck/lint/单测）PR 必过；真机推送链路走手动/EAS 触发 job（不阻塞 PR）。
- `expo-doctor` 强制：SDK 依赖对齐是 Expo 体系最常见的漂移源。
- 契约漂移防线：shared-types 变更触发移动端 typecheck（monorepo 依赖图天然覆盖）；移动端「订阅事件子集清单」测试在 shared-types 事件注册表变更时红。

### 9.5 性能预算（v1 基线）

| 指标 | 预算 |
| --- | --- |
| 冷启动到可用（已配对） | ≤ 2.5s（中端 Android） |
| 事件流追加渲染 | 100 条/秒 不掉帧（列表虚拟化 + useShallow selector） |
| WS 内存常驻 | ≤ 60MB（事件窗口 5000 条/session，超限落库卸载） |
| 包体 | 国内渠道 AAB ≤ 80MB（国际版 ≤ 60MB，Hermes + 资源裁剪） |
| 审批决策送达 P95 | ≤ 3s（在线路径）；离线路径 ≤ 重连恢复 + 2s |

---

## 10. 风险与缓解

### 10.1 风险清单（按影响排序）

| # | 风险 | 影响 | 概率 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | **Expo 57 新版本稳定性**：SDK 57 发行窗口尚短，新架构（Fabric/Nitro）边角未完全沉淀 | 原生崩溃、模块兼容问题 | 中 | 锁定 SDK 57 + 精确版本；实施期前两周做「冒烟清单」（推送/通知/深链/SQLite/WSS 全链路）再铺开功能开发；预留 SDK 56 降级通道（差异面仅原生层）；用 dev client 而非 Expo Go 做一切真机验证 |
| R2 | **RN 0.8x 兼容面**：New Architecture 默认开启后，三方库未适配会导致编译/运行失败 | 依赖锁死、升级困难 | 中 | 依赖面刻意收窄（官方包优先，全部经 `npx expo install` 对齐）；新增三方库需过「新架构兼容检查」（expo-doctor + 真机冒烟）；维护 `dependencies.md` 记录每库适配状态 |
| R3 | **国内安卓生态适配**：华为无 GMS、厂商推送碎片化、商店合规 | 国内用户无推送/无法上架 | 高（国内分发） | P1 阶段自研厂商推送 config plugin（8.5）；推送网关按设备注册表路由；隐私合规随 P1 一起过审；若 P1 资源不足，国内版先以「国际版 + 轮询兜底」过渡（降级体验可接受） |
| R4 | **WS 网关是新增后端面**：Rust daemon 侧新增监听端口/认证/配额，引入攻击面 | 安全风险、桌面稳定性风险 | 中 | 网关与引擎命令注册面共用（不新写命令）；证书固定 + 令牌绑定 deviceId + seq 防重放（6.1.5）；网关失败不拖垮引擎（独立任务 + 熔断）；桌面 crash 报告覆盖网关路径 |
| R5 | **与桌面端联合调试流程**：双端协议漂移、真机连 LAN 环境差异 | 返工、联调成本 | 中 | 契约版本校验（6.4）；共享 `commandManifest` 快照测试（桌面已有 `commandManifest.test.ts`，移动端加镜像断言）；建立标准联调矩阵（见 10.2） |
| R6 | **推送送达不确定性**：厂商通道延迟、Doze、用户关闭通知 | 审批错过 → 用户信任受损 | 中 | 审批通道 high 优先级 + 声音；推送仅作「触发」，决策页始终可离线发起（outbox）；设置页提供「审批超时重复提醒」（本地调度 1 次兜底通知） |
| R7 | **iOS 后台限制**：后台 30s 后无法保持 WS | 断线重连频繁、电量焦虑 | 低 | 明确「iOS 后台靠推送」的产品语义（8.7）；前台恢复即时重连 + 追平；通知图标徽标（badge）兜底状态呈现 |
| R8 | **SQLite 与推送后台任务并发**：headless 任务写库与主进程冲突 | 锁冲突、数据损坏 | 低 | WAL 模式；单写连接（模块级单例 db）；`withExclusiveTransactionAsync` 用于批写；后台任务只做「追加」类写 |
| R9 | **expo-notifications 已知问题**：Android dev build 启动闪屏（官方 known issue，仅 debug 构建） | 开发体验 | 低 | 官方已知 issue 记录在案，release 构建不受影响；联调用 release 变体验证启动路径 |
| R10 | **国内网络下 EAS 服务可达性** | 构建/更新通道不稳定 | 中 | EAS 构建在国内可用（VPN/代理规避为工程配置问题）；EAS Update 提供自托管 fallback（列为 P2）；原生升级仍可本地 prebuild + 手签 |

### 10.2 与桌面端联合调试流程（标准矩阵）

```
场景矩阵：真机类型（iOS 模拟器 / 安卓模拟器 / 真机）× 桌面环境（本机 / LAN 远程 / Tailscale）

S1 本机联调：桌面起 daemon（网关端口 8765【裁决修正 6】）→ 手机连同一 Wi-Fi → 手动输入
   桌面局域网 IP + PIN → 验证配对/审批/事件流/终端流全链路。
   证书：开发期用「开发自签 CA」，手机导入 CA 描述文件（iOS）或信任用户证书（Android）；
   指纹固定开关在 dev build 自动放宽（production 强制）。
S2 远程联调：桌面通过 Tailscale 组网（或端口转发）→ 手机填 Tailscale IP →
   走 S1 同一流程（网络延迟/丢包面多覆盖重连与追平用例）。
S3 推送联调：EAS dev client 安装 → 桌面发测试推送（推送网关 mock 或真网关）→
   验证前台横幅 / 后台系统通知 / 杀进程冷启动深链三种形态。
S4 回归联动：每次 shared-types 或命令清单变更 → 双端 CI 同步跑契约测试；
   桌面 `commandManifest.test.ts` 条数断言 + 移动端镜像断言双保险。
```

### 10.3 降级与回滚预案

| 场景 | 预案 |
| --- | --- |
| SDK 57 阻塞缺陷 | 降级 SDK 56（RN 0.85）：改动面 = 版本号 + 少数 API 签名；`migrations.ts` 不受影响 |
| WS 网关问题 | 桌面侧热开关关闭网关端口；移动端进入「推送 + 轮询兜底」降级模式（P1 实现） |
| 厂商推送 SDK 问题 | 退化为「FCM + 轮询兜底」；不影响审批核心（outbox 保证送达） |
| 版本不一致（contractVersion） | 拒绝连接并提示升级（6.4），不尝试兼容旧协议 |

---

## 11. 里程碑与验收

### 11.1 里程碑

> 【裁决修正 9】阶段映射（统一 R0-R5）：M0 骨架 → **R2 移动端基础**；M1 连接与
> 配对 → R2；M2 审批中心 → **R2 首批交付（裁决 12：审批中心 = P0 功能）**；
> M3 观测面 → R2；M4 文件与设置 → R2；M5 推送完备 → **R3 推送**；M6 国内通道 →
> R3；M7 发布 → R3 收尾。任务书引用一律使用 R 阶段号。

| 阶段 | 内容 | 出口标准 |
| --- | --- | --- |
| M0 骨架（2 周） | 清空重建 `apps/crish-mobile`；SDK 57 工程 + monorepo 接入 + jest-expo 全绿 + CI job 上线；路由骨架（tabs/守卫） | 真机 dev client 冷启动达标；typecheck/lint/单测绿 |
| M1 连接与配对（3 周） | WS 网关（Rust 侧，含认证/配额/证书固定）+ 配对流程（扫码 P2 手动先行）+ 令牌生命周期 + 连接相位 + 重连/追平 | 配对 → 断网 → 重连 → 追平全链路真机通过 |
| M2 审批中心（3 周） | 审批卡 UI + 审批流状态机 + 决策发送 + outbox 离线队列 + 推送（审批通道） | 离线决策送达 P95 达标；重复事件幂等测试绿 |
| M3 观测面（3 周） | 仪表盘 + 事件流 + 终端流（只读）+ run 控制（L2/L3） | 100 条/秒追加不掉帧；L2/L3 真机验证 |
| M4 文件与设置（2 周） | 文件浏览 + 设置 + 移除本机 + 通知偏好 | 目录树 1 万项级性能达标 |
| M5 推送完备（2 周） | 全通道规划 + 点击深链 + 徽标 + 后台任务（Android P2） | 三形态（前台/后台/冷启动）全通过；iOS+Android 真机 |
| M6 国内通道（4 周，P1） | 厂商推送 config plugin + 网关路由 + 合规文案 | 华为/小米真机推送送达验证 |
| M7 发布（2 周） | EAS 正式构建 + 商店材料 + 灰度（EAS Update 通道） | 商店审核通过；线上冒烟 |

### 11.2 验收清单（对应用户故事）

1. 用户在手机扫码/输入 PIN 配对成功后，重启 App 无需重新配对（令牌持久化）。
2. 桌面引擎发起审批时，手机（前台）秒见审批卡；（后台/被杀）收到系统通知，点击直达审批卡，离线也能决策，网络恢复后送达，桌面侧工具继续执行。
3. 断网时查看的事件/会话为最近缓存，重连后自动补齐且无重复行。
4. 用户可从手机停止运行中的 run（L2）与强制取消（L3，二次确认）。
5. 文件浏览可看目录与文本预览，不可编辑（权限矩阵生效）。
6. 移除本机后令牌失效，桌面侧设备列表同步移除，重新配对可恢复（SQLite 缓存保留）。
7. 全部门禁（typecheck/lint/单测/expo-doctor）绿；契约漂移测试在 shared-types 变更时拦截。

---

## 12. 附录

### 12.1 移动端依赖清单（v1 完整）

| 依赖 | 用途 | 版本策略 |
| --- | --- | --- |
| `expo` | 运行时 | 精确锁定 57.0.0 |
| `react-native` | 运行时 | 精确锁定 0.86.x |
| `react` / `react-dom` | 运行时 | 精确锁定 19.2.3 |
| `expo-router` | 导航/深链 | SDK 57 配套 |
| `expo-sqlite` | 本地库 | SDK 57 配套 |
| `expo-secure-store` | 安全存储 | SDK 57 配套 |
| `expo-notifications` | 推送 | SDK 57 配套 |
| `expo-task-manager` | 后台通知任务 | SDK 57 配套 |
| `expo-device` / `expo-constants` | 设备信息/projectId | SDK 57 配套 |
| `expo-local-authentication` | 本机解锁（P2） | SDK 57 配套 |
| `expo-camera` | 扫码（P2，v1 手动输入） | SDK 57 配套 |
| `zustand` + `immer` | 状态管理 | v5.x |
| `@crish/shared-types` | 跨端契约 | workspace 引用 |
| `@react-native-community/netinfo` | 网络状态 | SDK 配套 |
| `react-native-gesture-handler` / `react-native-reanimated` | 手势/动画（expo-router 依赖链） | SDK 配套 |
| `jest-expo` / `@testing-library/react-native` | 测试 | SDK 配套 |

### 12.2 引擎命令面速查（移动端会用到的子集）

| 命令 | 用途 | 移动端角色 |
| --- | --- | --- |
| `core_get_status` | 引擎/会话状态快照 | 仪表盘轮询 |
| `core_read_run_events` / `core_read_session_events` | 事件回放 | 分页加载 |
| `list_sessions` / `load_session_body` | 会话列表/详情 | 会话选择器 |
| `core_approve_tool` / `core_deny_tool` | 审批决策 | 审批核心（参数：`toolCallId` + `scope: 'project'`） |
| `core_run_control` / `core_cancel_run` | run 控制 | L1/L2/L3（参数：`level` + `runId`，见 `run-control.ts`） |
| `workbench_list_directory` / `workbench_read_file_content` | 文件浏览 | 只读（实施时定命令面归属） |

### 12.3 参考文献（webfetch 查证记录）

- Expo SDK 参考与兼容矩阵：docs.expo.dev/versions/latest（2026-08-09 抓取；SDK 57 ↔ RN 0.86 ↔ React 19.2.3）
- Expo Release statuses：docs.expo.dev/more/release-statuses（SDK 57 无 alpha/beta 标记）
- React Native Versions：reactnative.dev/versions（最新稳定 0.86）
- expo-notifications：docs.expo.dev/versions/latest/sdk/notifications（Expo Go 限制 / 双令牌 API / Android 13 通道先行 / config plugin / headless 任务）
- expo-sqlite：docs.expo.dev/versions/latest/sdk/sqlite（异步 API / SQLiteProvider / user_version 迁移 / WAL / SQLCipher / kv-store / FTS5）
- 代码面（仓库内）：`packages/shared-types/src/**`、`crates/conex-types/src/events.rs`、`apps/crish-desktop/src/{store,api,services}/**` 关键文件（文中已逐处标注路径:行号）

### 12.4 本文档的决策复核点（供主控评审）

1. **网关面**：WS 网关作为桌面 daemon 新增面，是否需要独立服务（daemon 内嵌 vs 单独进程）——本方案默认内嵌（复用命令注册面），请主控与 Rust 侧任务书（E 系列）对齐。
2. **推送网关**：公网推送网关是 v1 必备基础设施（M5），部署形态（自建轻服务 vs 三方聚合）需产品/运维确认。
3. **扫码 P2**：v1 仅手动输入配对，扫码列为 P2——若产品要求扫码首发，需提前引入 expo-camera 与二维码解码库评估。
4. **国内厂商推送 P1**：资源投入 4 周，是否进入 v1 范围由主控裁决；不影响国际版先行。

### 12.5 WS 网关帧格式规范（WsEnvelope）

> 【裁决修正 2/10】**本节作废**：WsEnvelope 是 D3 冻结前的早期草案第三套帧格式
> （AU3 C-1 已裁决作废；M5 §4.2 已声明信封并入 D3 体系）。帧格式唯一真源 =
> **M6 DeviceEnvelope**（v/kind/msgId/ts/from/to/auth/body，M6 §10.1），
> 认证 = 消息级 HMAC（token_key，M7 四类令牌分治）；本节内容仅作为历史对照保留。

统一帧：`{ "v": 1, "type": <帧类型>, "seq": <单调递增>, "payload": {…} }`。

| 帧类型 | 方向 | payload 结构 | 说明 |
| --- | --- | --- | --- |
| `hello` | C→S | `{ deviceId, accessToken, contractVersion, lastSeq }` | 连接建立后首帧；服务端校验令牌与契约版本 |
| `hello-ok` | S→C | `{ serverVersion, contractVersion, baseSeq }` | 认证通过；`baseSeq` 为断线追平起点 |
| `hello-error` | S→C | `{ code, detail }` | `auth.invalid_token` 触发刷新；`protocol.version_mismatch` 触发升级提示 |
| `ping` / `pong` | 双向 | `{}` | 心跳（30s 间隔，60s 无响应判假死） |
| `invoke` | C→S | `{ id, command, params }` | 命令调用（引擎命令名 + 参数） |
| `invoke-result` | S→C | `{ id, ok, data \| error }` | 与 `invoke.id` 关联；`error` 为 `{ kind, detail }`（对齐 `normalizeCoreError`） |
| `event` | S→C | `{ seq, envelope }` | 引擎事件信封（`type/sequence/schemaVersion/runId` 注入面原样转发） |
| `auth-revoked` | S→C | `{ reason }` | 服务端吊销（用户桌面解绑本机）→ 客户端清令牌回配对页 |
| `ratelimit` | S→C | `{ retryAfterMs }` | 配额触发：客户端暂停发送并按提示退避 |

示例（审批事件推送）：

```json
{ "v": 1, "type": "event", "seq": 12345, "payload": {
  "envelope": {
    "type": "approval-requested",
    "sequence": 12345,
    "schemaVersion": 1,
    "runId": "run_02",
    "sessionId": "sess_01",
    "timestamp": "2026-08-09T10:00:00Z",
    "request": {
      "id": "req_1", "sessionId": "sess_01", "cwd": "/workspace",
      "toolCallId": "tool_call_abc123", "toolName": "delete_file",
      "parameters": { "paths": ["a.txt", "b.txt"] },
      "summary": "请求删除 2 个文件", "toolMetadata": { "category": "fs" }
    }
  }
}}
```

### 12.6 审批卡字段规范（与桌面 `ApprovalAskCard` 对齐）

| 字段 | 来源 | 桌面对照 | 移动端渲染 |
| --- | --- | --- | --- |
| 工具名 | `request.toolName` | ApprovalAskCard 头部 | 大标题 + 类型图标 |
| 摘要 | `request.summary`（兜底 `reason/message/toolName`） | `plainApprovalQuestion` | 副标题（2 行截断 + 展开） |
| 参数 | `request.parameters`（JsonObject） | 参数只读展示 | 折叠卡（默认收起，敏感参数 `password` 等掩码） |
| cwd | `request.cwd` | 路径展示 | 小字路径（`shortPath` 同款截断） |
| 风险事实 | 引擎 `metadata`（`approvalMeta` 同源解析） | `ApprovalRiskMeta` chips | 中文 chips（信任域/风险种类/等级） |
| 二次确认 | `requiresDoubleConfirm` | 桌面二次确认相位 | 允许按钮先「确认」再「放行」两段式 |
| 超时 | `expires_at`（引擎侧） | `remainingMs` 进度条 | 同款进度条 + 过期置灰 |
| 附注 | 决策时可选 | `onAllow(note)` | 输入框（可选） |
| 白名单提示 | 移动端不维护白名单 | `onAllowRemember` | 不提供「记住」按钮（桌面专属能力） |

### 12.7 本地缓存容量与清理策略

| 表 | 保留策略 | 清理触发器 |
| --- | --- | --- |
| `events` | 每 session 最近 5000 条；全局 5 万条 | 启动时 + 每 6 小时（`DELETE … WHERE sequence < 游标-窗口`） |
| `approvals` | 已决/过期条目保留 30 天 | 日级定时清理（依赖 App 启动触发，Android 可用后台任务 P2） |
| `runs` / `sessions` | 保留最近 200 会话；run 随会话级联 | 会话清理时级联（外键 CASCADE） |
| `outbox` | `sent/superseded` 条目保留 7 天 | 日级清理 |
| `file_cache` | 60s TTL 失效 + 全局 2000 项 | 访问时惰性失效 + 定期 prune |
| `dead_letters` | 保留 1000 条 | 超限删最旧 |

预估磁盘占用：典型使用（30 会话 × 2000 事件）约 15-30MB，中端机型可接受；WAL 文件由 SQLite 自动 checkpoint。

### 12.8 术语表

| 术语 | 含义 |
| --- | --- |
| 伴侣端（companion） | 本方案移动端的产品定位：远程查看与控制，不承载完整工作区 |
| WS 网关 | 桌面 daemon 新增的 WebSocket 服务面：命令透传 + 事件推送 + 设备认证 |
| 配对 | 手机与桌面主机建立信任：一次性 PIN/二维码 + 令牌交换 + 证书固定 |
| outbox | 本地持久化的待发动作队列（审批决策等），重连后按序重放 |
| 追平（catch-up） | 重连后按事件游标 `seq` 补齐断线期间缺失的事件 |
| 相位投影 | 把传输层状态映射为 UI 连接相位的纯函数（对齐桌面 `ConnectionManager`） |
| 深链 | `crish://` 应用内路由：推送点击与页面导航的统一入口 |
| 厂商推送 | 华为/小米/OPPO/vivo 等系统级推送通道（区别于 FCM/APNs 通用通道） |
| CNG | Expo Continuous Native Generation：由 config plugin 在构建时生成原生工程 |

---

## 总结

移动端「远程伴侣」正式方案结论：**Expo SDK 57（RN 0.86 / React 19.2.3）+ TS strict + zustand/immer（桌面同构）+ expo-router + expo-sqlite + expo-secure-store + RN 内建 WebSocket 自研重连层 + expo-notifications 推送**。架构上移动端不发明协议：桌面 daemon 新增 WS 网关透传引擎命令面（`core_approve_tool`/`core_run_control` 等）与事件信封，类型与解析器全部复用 `@crish/shared-types`；审批为核心场景，配离线 outbox + 事件游标追平保证送达；推送走 Expo Push Service 国际版先行、国内厂商推送 config plugin 跟进。最大风险：Expo 57 / RN 0.86 新版本稳定性与国内安卓厂商推送生态适配，均已给出降级与分阶段预案。