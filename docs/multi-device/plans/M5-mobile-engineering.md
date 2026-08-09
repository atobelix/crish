# M5 移动端工程实现方案细化

> 文档编号：M5-mobile-engineering
> 系列：多端互通功能与工程方案（multi-device）
> 版本：v1.0（细化稿）
> 日期：2026-08-09
> 状态：待主控评审
> 上游输入：D4（移动技术选型）、D3（跨端协议）、F1（监控面板）、F2（审批中心）、F3（事件流与终端）、F5（会话消息）、F6（设置与账户）、D8（工程发布）、`crates/conex-types/src/events.rs`（事件契约）、`packages/shared-types`（跨端类型）、`scripts/generate-engine-bindings.mjs`（生成器机制）
> 目标读者：移动端实现任务书（PE-M 系列）作者、桌面端网关实现组、CI 维护者

---

## 0. 文档信息与决策摘要

### 0.1 一句话结论

本方案把 D4 的技术选型与 D3 的协议真源落成**移动端可执行的工程蓝图**：Expo SDK 57 单仓目录 `apps/crish-mobile`，按「UI → 状态 → 数据 → 网络/存储」单向分层；8 个 zustand store（含 immer 与持久化中间件）；自研 `ReconnectingWsClient`（D3 帧 + 指数退避 + HMAC 签名 + 请求-响应关联 + 游标追平）；SQLite 12 张表 + secure-store 4 个密钥位；审批离线 outbox 与推送深链是两条保命路径。全部契约复用 `@crish/shared-types` 与生成器产物，零协议自造。

### 0.2 与上游方案的关系（本方案的立场）

| 上游文档 | 本方案承接方式 |
| --- | --- |
| D4（技术选型） | 技术栈、分层、存储选型、性能预算全部采纳；目录结构在其 4.3 基础上**按工程实现细化**（新增 store 拆分、网络层文件、测试目录等） |
| D3（协议） | **协议真源以 D3 为准**：信封用 `DeviceEnvelope`（v/kind/msgId/ts/from/to/auth/body），鉴权用消息级 HMAC（token_key），配对走 `pair.*` WS 消息序列；D4 第 12.5 节的 WsEnvelope 帧表在 4.2 节中做了等价映射，供实现对照。【裁决修正 2/5】帧格式唯一真源 = **M6 DeviceEnvelope**（WS 帧与 M3 轻量可靠 UDP 帧统一由 M6 §10 定义）；跨端命令 kind 统一 `remote.*`；D4 §12.5 的 WsEnvelope 第三套帧已作废，本节仅为 TS 实现文件名 |
| F1/F2/F3/F5/F6 | 各功能域的状态模型、事件消费规则、UI 交互全部落入对应 store/repository/组件；冲突与离线语义以 F2 第 11 章为准 |
| D8 | 门禁分层、本地开发流、共享包策略直接采用；本方案第 11 章给出移动端 job 的落地 yaml 与脚本 |
| events.rs + 生成器 | 事件解析一律走 `packages/shared-types/src/generated/engine/` 的 `parseEngineEvent`；不复制任何事件类型 |

### 0.3 关键工程决策清单

| # | 决策点 | 结论 | 依据 |
| --- | --- | --- | --- |
| E-01 | 网络信封 | 采用 D3 `DeviceEnvelope`（消息级 HMAC 签名），不用裸 token 长连接 | D3 5.1-5.3；防重放 + 完整性一次解决 |
| E-02 | 令牌形态 | secure-store 存 `token_key`/`refresh_key` 派生值（32B base64），无 JWT | D3 4.4；撤销即删 |
| E-03 | 事件订阅 | 会话级 `events.subscribe` + 全局 `events.subscribeAll` 双订阅，复用同一 WS | D3 7.3；F3 3.2.2 |
| E-04 | 审批离线 | outbox 表 + `reqMsgId` 幂等重发 + `cmd.approval_mismatch` 冲突收敛 | D3 8.5 + F2 第 8/11 章 |
| E-05 | 事件落库 | 先落 SQLite 再推 store，`sequence` 幂等覆盖；Delta 级事件不落库 | D4 4.4.4 + F3 2.12 + D3 7.5-5 |
| E-06 | 渲染 | FlashList 虚拟化 + `useShallow` selector + 行组件 memo + 50ms 批合并 | D4 6.7 + F3 3.0 |
| E-07 | 设置持久化 | 本机偏好走 kv-store（persist 中间件），镜像数据不持久化 | F6 4.2 |
| E-08 | 推送 | 前台事件驱动不弹系统通知；后台/被杀走系统通知 + 深链 | D4 8.6 + F2 6.2 |
| E-09 | 测试 | jest-expo + 内存 SQLite + mock WsGateway；覆盖率 60/75/70/60 | D8 5.2 |
| E-10 | CI | 快层 lint/typecheck/关键单测 + 契约漂移；中层全量 + expo export 冒烟 | D8 5.5 |

### 0.4 文档结构

```
第 1 章 工程总览与分层架构
第 2 章 项目结构与模块划分
第 3 章 状态架构（store 拆分 / immer / selector / view-model）
第 4 章 网络层（WS / HTTP / outbox / 订阅管理）
第 5 章 本地存储 schema（表设计 / 迁移 / 缓存上限）
第 6 章 安全存储（secure-store 划分与密钥生命周期）
第 7 章 启动流程（启动状态机 / 冷热启动 / 深链恢复）
第 8 章 推送处理（客户端侧）
第 9 章 性能预算与测量
第 10 章 测试策略
第 11 章 CI 集成与本地开发流
第 12 章 风险与开放问题
第 13 章 附录
```

---

## 1. 工程总览与分层架构

### 1.1 部署拓扑（实现视角）

```
┌──────────────────────────────┐          ┌──────────────────────────────┐
│  crish-mobile（本方案）        │   WSS    │  桌面主机 agent-workbench      │
│                              │ ◄──────► │  Device Relay Service（D3）   │
│  UI / Store / Data / Network │          │  └ Command Adapter + 白名单   │
│  SQLite + SecureStore        │          │  └ DeviceEmitter（事件扇出）    │
└──────────────────────────────┘          └──────────┬───────────────────┘
                                                      │ Emitter 同源
                                             ┌────────▼─────────┐
                                             │ Rust 引擎事件桥   │
                                             └──────────────────┘
```

- 移动端只与「Device Relay Service」（桌面 daemon 内新增的 WS/HTTP 面）通信，不直接接触 Rust 引擎。
- 事件面：Relay 把引擎 emit 层的同一份序列化字节扇出给桌面 UI 与移动端（D3 7.6），移动端消费的是 `AgentEventEnvelope` 扁平 JSON。
- 命令面：`cmd.*` 消息经 Relay 的 Command Adapter 映射为 Tauri 命令（D3 8.4），移动端白名单由 Device Registry 的 `allowedCommands` 强制（D3 8.3）。

### 1.2 分层架构与依赖规则

```
┌────────────────────────────────────────────────────────────────┐
│  UI 层  app/（expo-router 路由）+ src/components/                 │
│  屏幕组件、列表行、审批卡、横幅、深链路由；禁止直接 import 网络/DB   │
├────────────────────────────────────────────────────────────────┤
│  状态层  src/store/                                             │
│  8 个 zustand store + selectors.ts + middleware/                │
│  只持有领域模型（shared-types 类型），不持有 wire 原始对象          │
├────────────────────────────────────────────────────────────────┤
│  数据层  src/data/ + src/repositories/                          │
│  repository：网络编排（网络优先 + 缓存回退 + 离线入队）             │
│  事件接线：解析 → 先落 SQLite → 再推 store（防杀进程丢数据）         │
├────────────────────────────────────────────────────────────────┤
│  网络层  src/network/                                           │
│  ReconnectingWsClient / WsGateway / WsEnvelope / HttpClient      │
│  / EndpointResolver / signer（HMAC 签名）                        │
├────────────────────────────────────────────────────────────────┤
│  存储层  src/db/（SQLite schema/DAO + secureStore 封装）          │
└────────────────────────────────────────────────────────────────┘
         ▲ 全部层只依赖 @crish/shared-types（类型/解析器/错误码）
         │ 与生成产物 packages/shared-types/src/generated/engine/**
```

**依赖规则（强制，单向）**：

1. UI → 状态 → 数据 → 网络/存储；反向引用一律禁止（lint 规则 + review 双闸）。
2. 网络层与存储层互不可见：网络层不得 import `src/db/**`，存储层不得 import `src/network/**`。
3. 状态层不 import 网络层与存储层：store 的动作只声明「意图」，实际 IO 由数据层 repository 编排后回调 store（与桌面 `approvalHandlers.ts` 的「事件 → 状态机 → store」纪律同源）。
4. 组件不得直接消费原始事件信封；事件到达链：`WsGateway.on` → 解析器 → repository（落库）→ store 动作。
5. 跨层调用只允许 import 类型（`import type`），运行时依赖保持单向。

**为何这样分层**：

- 可测试性：网络层与数据层全部接口注入（DI），jest 中替换为 fake；纯逻辑（解析/状态机/投影）无 React 依赖可直接在 Node 侧跑。
- 离线一致性：事件「先落库再推 store」，杀进程重启后事件流从 SQLite 恢复（D4 4.4.4）。
- 与桌面心智同构：桌面 `EventRouter → handler → store → 组件` 链路在移动端压缩为 `WsGateway → repository → store → 组件`，命名与职责可对照。

### 1.3 领域模型分层（wire 对象 vs 领域对象）

| 层 | 对象示例 | 定义位置 | 说明 |
| --- | --- | --- | --- |
| wire 层 | `DeviceEnvelope`、`events.push` body | `src/network/WsEnvelope.ts`（协议类型） | 帧编解码产物，仅网络层可见 |
| 契约层 | `AgentEventEnvelope`、`PermissionRequest`、`RunStatus` | `@crish/shared-types`（含生成面） | 跨端契约，全层可读 |
| 领域层 | `ApprovalItem`（`PermissionRequest & {本地附加}`）、`FeedEntry`、`SessionSummary` | `src/types/domain.ts` 或 store 内定义 | 组合而非重写（D4 9.3） |
| 展示层 | 组件 props、formatter 输出 | 组件局部 | 不落 store |

**组合纪律**：领域类型一律用「契约类型 & 本地附加字段」的组合形式，禁止复制契约字段定义（对齐 D4 9.3「领域模型零拷贝」）。契约类型变化时，组合类型自动继承，编译期暴露不匹配。

### 1.4 事件消费总入口（数据层接线图）

```
ReconnectingWsClient.onEnvelope（帧）
   └→ WsGateway.dispatch（按 kind 分发）
        ├─ events.push  → parseEngineEvent（严格解析）→ 分类器（S/N/I 表，F3 2.12）
        │     ├─ 幂等去重（buildEventDedupeKey：type:messageId:sequence）
        │     ├─ Delta 级 → 仅内存暂存/节流合并，不落库
        │     ├─ Critical/Soft → repository.ingest(event)
        │     │     ├─ 先写 SQLite（sequence 幂等 upsert）
        │     │     └─ 再推 store 动作（批处理，React 自动批处理）
        │     └─ 解析失败 → dead_letters 表登记，不阻塞流
        ├─ result.*   → 请求-响应匹配器（resolve pending promise）
        ├─ auth.*     → authStore 联动（rotate 换 nonce、expired 触发刷新）
        ├─ device.*   → deviceStore/settings 联动（revoked 清凭据）
        ├─ stream.*   → 大载荷分块组装器
        └─ error      → 统一错误归一化 → 用户可读文案
```

- 订阅（`events.subscribe` / `events.subscribeAll`）在网关启动时建立，页面级组件只向 store/repository 注册「视图回调」，不直接持有订阅句柄（多页面共享连接，见 4.7）。
- 全部事件解析器复用生成面：`parseEngineEvent` 严格契约；移动端不写第二套宽容归一（D4 6.1.4，历史别名不复刻）。

---

## 2. 项目结构与模块划分

### 2.1 完整目录树（工程实现级）

> 【裁决修正 7】导航以 **M4 五 Tab 为准**（首页/会话/审批/文件/设置）：本树
> `(tabs)/` 增加 `files.tsx`，原根级 `files.tsx`（Stack 页形态）并入 Tab；
> `usage/diagnostics/tasks` 仍为 Stack 二级页（M4 §2.3 归置）。

```
apps/crish-mobile/
├── app.json                          # Expo 配置 + config plugins（sqlite/notifications/secure-store）
├── app.config.ts                     # 动态配置（EAS projectId、环境变量注入）
├── package.json                      # name: @crish/crish-mobile
├── tsconfig.json                     # extends ../../tsconfig.base.json + "strict": true
├── babel.config.js                   # babel-preset-expo
├── metro.config.js                   # monorepo 解析（watchFolders 指向 packages/）
├── jest.config.js                    # preset: jest-expo（D8 5.2.2 目标形态）
├── jest.setup.ts                     # 全局 mock（expo-secure-store / expo-notifications / netinfo）
├── .eslintrc.js                      # eslint-config-expo + 仓库规则
├── .env.example                      # EXPO_PUBLIC_ENGINE_URL 示例（.env 不入库）
├── index.ts                          # 注册根（TaskManager 后台任务在模块作用域注册）
├── app/                              # expo-router 文件路由（= 深链命名空间）
│   ├── _layout.tsx                   # 根布局：SQLiteProvider + AuthGuard + NotificationObserver
│   ├── index.tsx                     # 路由守卫：按 auth 状态重定向
│   ├── pair/
│   │   ├── _layout.tsx
│   │   ├── welcome.tsx               # 首次启动引导（配对 / 访客模式，F6 12.2）
│   │   ├── scan.tsx                  # 扫码（P2；v1 隐藏入口）
│   │   └── manual.tsx                # 手动输入配对码（CXN-XXXX-XXXX-XXXX）
│   ├── (tabs)/
│   │   ├── _layout.tsx               # 底部 Tab：首页/会话/审批/文件/设置（M4 §0.2 五 Tab）
│   │   ├── dashboard.tsx             # 仪表盘（F1 首页：连接条/核心卡/活动任务）
│   │   ├── sessions.tsx              # 会话列表（F5 2.1）
│   │   ├── approvals.tsx             # 审批中心（F2 待办列表）
│   │   ├── files.tsx                 # 文件浏览（F4；裁决修正 7：文件进 Tab）
│   │   └── settings.tsx              # 设置（F6 信息架构）
│   ├── session/[sessionId].tsx       # 会话详情（事件流 feed，F3 主形态）
│   ├── approval/[toolCallId].tsx     # 审批详情（推送深链目标，F2 5.1）
│   ├── run/[runId].tsx               # run 详情（状态条 + 事件时间线 + 用量卡，F1 4.3）
│   ├── terminal/[runId].tsx          # 终端流回放（只读，F3 第 4 章）
│   ├── usage.tsx                     # 用量与缓存页（F1 4.5）
│   ├── usage.tsx                     # 用量与缓存页（F1 4.5）
│   ├── diagnostics.tsx               # 诊断页（F1 4.6）
│   ├── tasks.tsx                     # 后台任务页（F1 F09）
│   ├── history.tsx                   # 审批历史（F2 第 7 章）
│   └── settings-extra/               # 设置二级页（连接/通知/数据隐私/关于）
│       ├── connection.tsx
│       ├── notifications.tsx
│       ├── privacy.tsx
│       ├── devices.tsx               # 已配对设备列表（F6 6.2）
│       └── about.tsx
├── src/
│   ├── components/
│   │   ├── ui/                       # 基础组件（Button/Card/Badge/EmptyState/LoadingRow）
│   │   │   ├── Button.tsx
│   │   │   ├── Card.tsx
│   │   │   ├── Badge.tsx
│   │   │   ├── EmptyState.tsx
│   │   │   ├── LoadingRow.tsx
│   │   │   ├── Banner.tsx            # 断线/过期横幅
│   │   │   ├── Chip.tsx
│   │   │   └── SlideToConfirm.tsx    # L2 滑动确认（F2 5.3）
│   │   ├── ConnectionBanner.tsx      # 连接相位横幅（L0 连接层）
│   │   ├── ApprovalCard.tsx          # 审批待办卡（F2 4.2）
│   │   ├── ApprovalActionBar.tsx     # 允许/拒绝/附注/二次确认（F2 5.2）
│   │   ├── SessionRow.tsx            # 会话行（F5 2.1）
│   │   ├── RunStatusChip.tsx         # RunStatus 十态 → 五色分组（F1 5.1）
│   │   ├── ActiveTaskRow.tsx         # 活动任务行（F1 4.2）
│   │   ├── EventRow.tsx              # 事件行（类型图标 + 摘要，F3 feed 条目渲染器）
│   │   ├── ToolCard.tsx              # 工具卡片（tool-start/update/end 状态机，F3 2.3）
│   │   ├── MessageBubble.tsx         # 消息气泡 + 思考折叠（F5 2.2）
│   │   ├── Markdown.tsx              # 轻量 markdown 渲染（自研子集，F5 3.1）
│   │   ├── TerminalView.tsx          # 只读终端视图（行缓冲 + ANSI 白名单，F3 4.x）
│   │   ├── FileTreeRow.tsx
│   │   ├── CountdownBar.tsx          # 审批剩余时间进度条（F2 4.2）
│   │   ├── RiskBanner.tsx            # 风险横幅（F2 5.1）
│   │   ├── UsageCard.tsx             # 用量卡（F1 4.3）
│   │   └── Markdown.tsx
│   ├── store/
│   │   ├── index.ts                  # createStores 组合 + devtools 装配
│   │   ├── middleware/
│   │   │   ├── withDevtools.ts       # 对齐桌面（仅 dev 生效）
│   │   │   └── withLogger.ts         # dev 生效 + 采样
│   │   ├── useShallowSelector.ts     # re-export zustand/react/shallow
│   │   ├── selectors.ts              # 派生选择器（纯函数，可单测）
│   │   ├── authStore.ts
│   │   ├── connectionStore.ts
│   │   ├── approvalStore.ts
│   │   ├── sessionStore.ts
│   │   ├── eventStore.ts
│   │   ├── terminalStore.ts
│   │   ├── settingsStore.ts
│   │   └── notificationStore.ts      # 通知/角标状态（新增，相对 D4 4.3 扩一域）
│   ├── network/
│   │   ├── WsGateway.ts              # kind 分发 + 请求-响应匹配 + 订阅管理
│   │   ├── ReconnectingWsClient.ts   # 连接生命周期/重连退避/心跳
│   │   ├── WsEnvelope.ts             # DeviceEnvelope 编解码（D3 5.3）
│   │   ├── signer.ts                 # HMAC 签名（token_key）与 nonce 管理
│   │   ├── HttpClient.ts             # fetch 封装（超时/重试/错误归一）
│   │   ├── EndpointResolver.ts       # URL 构造（wss/https 映射、平台默认）
│   │   └── protocolVersion.ts        # 版本协商常量（D3 10.2）
│   ├── data/
│   │   ├── repositories/
│   │   │   ├── approvalRepository.ts
│   │   │   ├── sessionRepository.ts
│   │   │   ├── eventRepository.ts
│   │   │   ├── fileRepository.ts
│   │   │   ├── runRepository.ts
│   │   │   └── deviceRepository.ts
│   │   ├── outbox.ts                 # 离线决策队列（重放/冲突处理）
│   │   ├── ingest.ts                 # 事件入栈（分类 → 落库 → 推 store）
│   │   └── dedupe.ts                 # 事件幂等去重键（buildEventDedupeKey 移植）
│   ├── db/
│   │   ├── schema.ts                 # 建表 SQL（PRAGMA user_version = 1）
│   │   ├── migrations.ts             # 迁移数组 [v1, v2, …]
│   │   ├── db.ts                     # openDatabaseAsync 单例 + SQLiteProvider
│   │   ├── dao/
│   │   │   ├── sessionsDao.ts
│   │   │   ├── runsDao.ts
│   │   │   ├── eventsDao.ts
│   │   │   ├── approvalsDao.ts
│   │   │   ├── outboxDao.ts
│   │   │   ├── fileCacheDao.ts
│   │   │   ├── deadLettersDao.ts
│   │   │   ├── kvDao.ts
│   │   │   ├── subscriptionsDao.ts
│   │   │   └── notificationsDao.ts
│   │   └── secureStore.ts            # 令牌/密钥封装（Keychain/Keystore）
│   ├── notifications/
│   │   ├── pushRegistration.ts       # 令牌获取/上报/刷新监听
│   │   ├── notificationHandler.ts    # setNotificationHandler + 前台策略
│   │   ├── deepLink.ts               # 推送 data.url → 路由目标（白名单校验）
│   │   └── channels.ts               # Android 通知通道定义（F2 6.2/D4 8.4）
│   ├── pairing/
│   │   ├── pairMachine.ts            # 配对状态机（纯逻辑，可单测）
│   │   ├── pairProtocol.ts           # pair.* 消息收发（D3 4.8 序列）
│   │   ├── qrPayload.ts              # conex-pair:// 载荷解析（D3 4.1）
│   │   └── crypto.ts                 # X25519 + HKDF（expo-crypto 封装）
│   ├── hooks/
│   │   ├── useAppState.ts            # AppState 联动（前台/后台）
│   │   ├── useNetInfo.ts             # 网络状态订阅
│   │   ├── useDashboardRefresh.ts    # 首页轮询 + 事件触发刷新（seq 守卫）
│   │   └── useFollow.ts              # feed 自动滚底/上翻暂停
│   ├── utils/
│   │   ├── ansi.ts                   # ANSI 白名单转纯文本
│   │   ├── time.ts                   # 相对时间格式化
│   │   ├── id.ts                     # msgId/requestId 生成
│   │   ├── format.ts                 # tokens 千分位/金额 4 位小数（F1 7.1）
│   │   ├── markdown.ts               # 轻量 markdown 子集解析器（纯函数）
│   │   ├── logger.ts                 # 滚动内存日志（诊断导出用）
│   │   └── clock.ts                  # 时钟偏移校准（D3 9.3）
│   ├── types/
│   │   ├── domain.ts                 # 领域组合类型
│   │   ├── env.ts                    # EXPO_PUBLIC_* 环境变量类型
│   │   └── nav.ts                    # 路由参数类型（typed routes 增量）
│   └── services/
│       ├── eventBus.ts               # 30 行轻量 EventBus（useSyncExternalStore）
│       └── loggerService.ts
├── plugins/
│   └── withVendorPush.ts             # 国内厂商推送 config plugin（P1，D4 8.5）
├── assets/                           # 图标/启动图/推送图标（96x96 白色透明）
├── __tests__/                        # 跨域集成测试
│   ├── pairFlow.test.ts
│   ├── outboxFlush.test.ts
│   ├── deepLinkRouting.test.ts
│   └── reconnectCatchup.test.ts
└── scripts/
    └── check-chinese.ts              # 中文注释编码自检（复用仓库脚本思路）
```

### 2.2 模块职责边界（feature-first 对应表）

| 模块目录 | 职责 | 桌面端参照 | 禁止事项 |
| --- | --- | --- | --- |
| `src/network` | 帧编解码、签名、连接生命周期、请求-响应、订阅 | `services/ConnectionManager` + `api/transport` | 不得读写 SQLite；不得 import store |
| `src/data` | 网络编排、落库、store 联动、离线队列 | `api/chat-bridge/handlers/*` | 不得 import 组件；不得持 UI 状态 |
| `src/store` | 领域状态、动作、持久化 | `store/permissionStore.ts` 等 | 不得 import 网络/DB 实现 |
| `src/db` | schema/DAO/迁移/安全存储 | `crates/conex-db` 的形态 | 不得 import 网络层 |
| `src/pairing` | 配对密码学与状态机（纯逻辑优先） | 无桌面对应（新增） | 不得 import expo-router |
| `src/notifications` | 推送注册/处理/深链 | 无桌面对应（新增） | 深链目标页由路由层决定 |
| `src/components/ui` | 基础组件 | `apps/crish-desktop/src/components/ui` | 不得含业务逻辑 |

### 2.3 分层依赖的强制手段

1. **ESLint 规则**（`.eslintrc.js` 内新增，实施时实现）：
   - `no-restricted-imports`：`src/network` 与 `src/db` 互相禁止；`src/store` 禁止 import `src/network/**`、`src/db/**`；组件禁止 import `src/db/**`、`src/network/**`。
   - `src/data` 禁止 import `app/**`、`src/components/**`。
2. **review 检查单**：PR 模板内置「分层合规」勾选；目录导入违规为硬失败。
3. **架构测试**：`__tests__/architecture.test.ts` 用正则扫描 import 语句断言上述规则（静态扫描，防止 lint 配置漏配）。

### 2.4 与 D4 4.3 目录的差异说明（演进登记）

| D4 4.3 原目录 | 本方案调整 | 理由 |
| --- | --- | --- |
| `src/data/approvalRepository.ts` 等平铺 | 收敛为 `src/data/repositories/` 子目录 | 仓库数量增长到 6 个，平铺可读性下降 |
| `src/store` 7 个 store | 8 个（新增 `notificationStore`） | 通知/角标状态独立（F1 4.8/F2 6），避免塞进 settingsStore |
| `src/pairing/pairProtocol.ts` | 新增 `crypto.ts`（X25519/HKDF 封装） | D3 配对含密码学操作，需要独立纯函数模块 |
| `app/(tabs)/events.tsx` | 改为 `session/[sessionId].tsx` + `run/[runId].tsx` 两级 | F3 主形态是会话级 feed，F1 需要 run 详情钻取，路由粒度修正 |
| 无 `src/hooks/` | 新增 | 轮询/AppState/滚底跟随等复合逻辑抽离（对齐桌面 hooks 文化） |
| `__tests__/` 3 个文件 | 4 个（新增 `reconnectCatchup.test.ts`） | 断线续传是网络层最高风险路径，必须集成级覆盖 |

---

## 3. 状态架构

### 3.1 store 拆分清单（8 个 store 全量明细）

> 【裁决修正 8】store 分层（主控裁决 8）：**领域层 createStore + 表现层 vanilla
> 绑定**。本节 src/store/ 的 8 个 store 是领域层抽象（zustand vanilla `createStore`
> 范式，M4 §2.5）；下文的 `create`（React 绑定）写法收敛为表现层导出形态——组件
> 经适配层 `useStore(store, selector)` 订阅（M4 §2.5 的 useAppStore 模式），
> 领域层保持零 React 依赖（M4 门禁 G2）。AU1 P1-7 冲突按此分层关闭。

统一创建范式（对齐桌面 `permissionStore.ts:54-120`）：

```ts
// src/store/approvalStore.ts（完整实现示意，其余 store 同构）
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import type { PermissionRequest } from '@crish/shared-types';
import { upsertPending, markDecisionLocal } from './reducers/approvalReducers';

export interface ApprovalItem {
  // 组合：契约类型 + 本地附加字段（D4 9.3 纪律）
  request: PermissionRequest;
  runId: string | null;
  requesterRunId?: string;
  reason?: string;
  arbiter: 'user' | 'main-agent';
  dangerLevel: 1 | 2;
  riskMeta?: { revertArea?: object; deleteImpact?: object; command?: string };
  requestedAt: number;
  expiresAt: number;
  status: 'pending' | 'deciding' | 'queued' | 'approved' | 'denied' | 'expired' | 'conflict';
  decision?: 'approved' | 'denied';
}

interface ApprovalStore {
  pending: ApprovalItem[];                     // 待批队列（排序：剩余时间升序）
  decisionBusy: Record<string, boolean>;       // toolCallId → 提交中（F2 9.3 防双点）
  outboxCount: number;                         // outbox 待发送数（角标）
  lastReconcileAt: number | null;              // 上次对账时间（F2 4.1）
  addPending: (item: ApprovalItem) => void;    // 幂等：同 toolCallId 覆盖（F2 11.2 事件重复）
  removePending: (toolCallId: string) => void;
  markDecision: (toolCallId: string, decision: 'approved' | 'denied') => void;
  markExpired: (toolCallId: string) => void;   // 本地倒计时到期（F2 8.3）
  markConflict: (toolCallId: string) => void;  // NotFound 冲突（F2 11.2）
  setQueued: (toolCallId: string) => void;     // 决策入 outbox
  setDeciding: (toolCallId: string, busy: boolean) => void;
  setOutboxCount: (n: number) => void;
}

export const useApprovalStore = create<ApprovalStore>()(
  withDevtools(
    withLogger(
      immer((set) => ({
        pending: [],
        decisionBusy: {},
        outboxCount: 0,
        lastReconcileAt: null,
        addPending: (item) => set((s) => { s.pending = upsertPending(s.pending, item); }),
        removePending: (toolCallId) => set((s) => {
          s.pending = s.pending.filter((p) => p.request.toolCallId !== toolCallId);
          delete s.decisionBusy[toolCallId];
        }),
        markDecision: (toolCallId, decision) => set((s) => {
          const p = s.pending.find((x) => x.request.toolCallId === toolCallId);
          if (p) { p.status = decision === 'approved' ? 'approved' : 'denied'; p.decision = decision; }
        }),
        markExpired: (toolCallId) => set((s) => {
          const p = s.pending.find((x) => x.request.toolCallId === toolCallId);
          if (p && (p.status === 'pending' || p.status === 'deciding')) p.status = 'expired';
        }),
        markConflict: (toolCallId) => set((s) => {
          const p = s.pending.find((x) => x.request.toolCallId === toolCallId);
          if (p) p.status = 'conflict';
        }),
        setQueued: (toolCallId) => set((s) => {
          const p = s.pending.find((x) => x.request.toolCallId === toolCallId);
          if (p) p.status = 'queued';
        }),
        setDeciding: (toolCallId, busy) => set((s) => { s.decisionBusy[toolCallId] = busy; }),
        setOutboxCount: (n) => set((s) => { s.outboxCount = n; }),
      }))
    ),
    'ApprovalStore'
  )
);
```

**reducers 目录**（`src/store/reducers/`）：所有涉及集合更新的纯函数放此处（`upsertPending`、`markDecisionLocal`、`mergeStreams` 等），store 动作只做一行转发；reducers 无 zustand 依赖，jest 直测。

#### 3.1.1 全量 store 清单

| store | 关键状态 | 动作（示意清单） | 持久化 | 跨 store 引用 |
| --- | --- | --- | --- | --- |
| `authStore` | `pairState: 'unpaired'\|'pairing'\|'paired'\|'token_expired'`、`hydrated: boolean`、`deviceId`、`desktopId`、`host`、`serverTimeOffsetMs` | `hydrate()`、`setPaired(meta)`、`markTokenExpired()`、`revokeLocal()`、`setClockOffset()` | secure-store（密钥材料）+ kv-store（host/设备名/desktopId） | 读 `connectionStore.phase` 决定刷新策略 |
| `connectionStore` | `phase: 'disconnected'\|'connecting'\|'ready'\|'recovering'\|'offline'`、`lastError`、`retryCount`、`lastSyncAt`、`heartbeatRtts: number[]` | `project(wsPhase, netInfo)`（纯投影）、`setPhase()`、`recordHeartbeatRtt()` | 否 | 被 `settingsStore`（诊断）与 `approvalStore`（决策前检查）读取 |
| `approvalStore` | 见上 | 见上 | SQLite（approvals/outbox 表由 repository 管，store 只持内存态 + 计数） | 读 `connectionStore.phase` 决定发送/入队 |
| `sessionStore` | `sessions: SessionSummary[]`、`activeRuns: RunSummary[]`、`selectedSessionId`、`pendingApprovalCount` | `upsertSession()`、`removeSession()`、`upsertRun()`、`removeRun()`、`setSelected()`、`reconcile(list)` | SQLite（sessions/runs 表）+ 内存镜像 | 写 `notificationStore`（角标重算） |
| `eventStore` | `streams: Record<sessionId, EventWindow>`、`cursorMap: Record<sessionId, number>`、`truncatedCount`、`network: 'live'\|'reconnecting'\|'offline'` | `append(sessionId, entries)`、`hydrate(sessionId, page)`、`setCursor()`、`unloadWindow(sessionId)` | SQLite（events 表，窗口外卸载） | 无 |
| `terminalStore` | `lines: Record<runId, TerminalLine[]>`、`follow: Record<runId, boolean>` | `appendText()`、`replaceAll()`、`clear()`、`setFollow()` | SQLite（events 表子集，只读） | 无 |
| `settingsStore` | `notify: NotifyPrefs`、`appearance: {theme, fontScale, listDensity}`、`connection: {mode, serverUrl}`、`privacy: {preview, notifyHidden, lockHidden}`、`mirror: {...}` | `setNotify()`、`setAppearance()`、`setServerUrl()`、`applyMirror()` | persist 到 kv-store；`mirror` 分片排除 | 写 `notificationStore`（通知开关） |
| `notificationStore` | `badge: {approval: number; failures: number}`、`lastResponse: NotificationResponse\|null`、`pendingRoute: string\|null`、`channelStatus` | `incrementApproval()`、`incrementFailure()`、`resetBadge()`、`setPendingRoute()`、`consumePendingRoute()` | kv-store（badge 断点，重启恢复） | 读 `approvalStore`/`sessionStore` 数据源 |

#### 3.1.2 store 拆分原则（与 D4 4.4.1 的差异说明）

1. 桌面端 `sessionIndex`/`sessionMessageActions`/`terminalStore` 在移动端合并为 `sessionStore` + `eventStore` + `terminalStore` 三个：事件流按会话分组的窗口模型（F3 3.1.1）是移动端独有，独立成域避免 sessionStore 膨胀。
2. `notificationStore` 是移动端独有新增域（桌面无推送），负责通知与角标联动（F1 4.8），避免角标逻辑散落。
3. `authStore` 的 `hydrated` 标志是**启动时序的关键闸门**：secure-store 读取完成前不跳转路由（D4 5.0 SplashGate），防止令牌未读出时闪跳到配对页。

### 3.2 immer 使用约定

| 约定 | 说明 |
| --- | --- |
| 中间件位置 | `immer` 必须包在 `withDevtools`/`withLogger` 内层（`withDevtools(withLogger(immer(...)))`），与桌面同序 |
| 写法 | 一律 `set((s) => { s.xxx = ...; })` 直接改 draft；禁止 `set({...})` 手写不可变更新的对象字面量 |
| 只读消费 | 组件读取时经 selector 返回稳定引用（`useShallow`），immer 产生的引用变化由 zustand 按 Object.is 比较 |
| 深层嵌套 | 审批卡内嵌 riskMeta、事件流按 sessionId 分组追加——immer draft 直接改嵌套结构，禁止展开复制 |
| 大集合 | 事件窗口（5000 条/session）追加走 reducers 纯函数 + immer 生产式更新；**绝不在 reducer 内做 `map` 全量拷贝**（用「原地替换数组引用」的 append 语义：`s.streams[sid] = { entries: [...prev, ...newBatch], cursor }`，批插入而非逐条） |
| 禁止点 | reducer 内不得有副作用（定时器/IO）；immer 冻结默认开启（`autoFreeze`），防外部误改 |

### 3.3 selector 模式与防重渲染

**核心规则**：

1. **列表组件**：`useShallow` 选取原始数组引用 + 派生值分离。例如活动任务列表：

```tsx
// 正确：useShallow 保证返回稳定引用，仅当元素引用/长度变化才重渲染
const activeRuns = useSessionStore(useShallow((s) => s.activeRuns));
const pendingCount = useApprovalStore((s) => s.pending.length);
```

2. **单值派生**：`store/selectors.ts` 纯函数，组合多 store 时用 `getState()` 而非 hook（避免跨 store 订阅）：

```ts
// src/store/selectors.ts
export function selectApprovalBadgeValue(): number {
  const pending = useApprovalStore.getState().pending.length;
  const failures = useNotificationStore.getState().badge.failures;
  return Math.min(pending + failures, 99);   // F1 4.8：角标上限 99+
}

export function selectDashboardFreshness(): 'fresh' | 'stale' {
  const phase = useConnectionStore.getState().phase;
  const lastSyncAt = useConnectionStore.getState().lastSyncAt;
  if (phase !== 'ready') return 'stale';
  return Date.now() - lastSyncAt < 60_000 ? 'fresh' : 'stale';  // F1 5.4 口径
}
```

3. **防重渲染清单**（对齐桌面 `useShallowSelector.ts` 用法）：

| 场景 | 做法 |
| --- | --- |
| 事件流 feed（高频追加） | 行组件 `React.memo` + 稳定 props；feed 容器只订阅 `streams[sid].cursor` 与「窗口版本号」，条目数据经 FlatList `getItem` 惰性读取 |
| 审批列表（低频） | 直接 `useShallow(s => s.pending)`；行内倒计时用组件本地 `useState` + interval，不写回 store（F2 4.2 倒计时环不驱动全局重渲染） |
| 连接横幅（全局） | 单组件订阅 `phase`；其余页面通过 `getState()` 读取，不订阅 |
| 角标（顶栏） | `notificationStore.badge` 订阅 + 事件驱动更新；不做轮询重算 |
| 时钟/时长显示 | 组件本地 1s interval 派生（如活动任务时长），绝不进 store |

4. **selectors 可单测**：`selectors.ts` 与 `reducers/` 同属纯函数层，jest 覆盖（第 10 章）。

### 3.4 store 与页面 view-model 的关系

```
页面组件（如 session/[sessionId].tsx）
   │  useFeedViewModel(sessionId)          ← hooks/ 层 view-model
   ▼
useFeedViewModel 内部：
   1. useEventStore(useShallow(...)) 取该会话窗口条目
   2. 订阅 sessionStore 的会话元信息（标题/状态）
   3. 暴露给组件的派生形状：{ entries, truncated, network, autoScroll,
      loadOlder, follow, setFollow }
   4. 副作用归口：useEffect 挂载时调用 eventRepository.subscribe(sessionId)
      与 loadInitial()；卸载时退订（repository 层引用计数，见 4.7）
```

**view-model 约定**：

| 约定 | 说明 |
| --- | --- |
| 位置 | `src/hooks/useXxxViewModel.ts`（与 D4 目录中的 hooks 合并目录） |
| 职责 | 组合多个 store 的派生数据 + 编排数据层调用；**不持有业务状态**（状态全在 store） |
| 生命周期 | 页面级 view-model 在组件挂载/卸载时管理订阅与副作用；store 是应用级单例，不随页面销毁 |
| 测试 | view-model 用 `renderHook` 单测（jest + @testing-library/react-native 的 renderHook），mock repository |
| 命名 | `use<页面>ViewModel`，一个页面一个 view-model，页面组件只做渲染 |

### 3.5 跨 store 联动：轻量 EventBus

- `src/services/eventBus.ts`：`useSyncExternalStore` 实现的 ~30 行 EventBus（订阅/发布/退订）。
- 使用场景：
  1. 审批决策送达 → `approvalRepository` 发布 `approval-resolved` → `notificationStore` 减角标 + 撤销本地通知（F2 6.3）；
  2. run 终态 → `sessionStore` 更新 → 发布 `run-terminal` → 推送触发点判断；
  3. 配对成功 → 发布 `paired` → 通知引导（F6 12.2 Step 3）；
  4. 连接恢复 → 发布 `connection-restored` → outbox 重放启动（F2 8.2）。
- 纪律：EventBus 只做「通知」，不传大数据（事件载荷一律经 store）；消费方幂等（重复发布不产生双副作用）。

### 3.6 持久化策略明细

| store | 持久化介质 | persist 配置要点 |
| --- | --- | --- |
| authStore | kv-store（host/desktopId/deviceName）+ secure-store（密钥） | 只持久化非敏感元数据；`hydrated` 在 hydrate() 完成后置 true |
| settingsStore | kv-store | `partialize: (s) => ({notify, appearance, connection, privacy})`；`mirror` 分片排除（F6 4.2） |
| notificationStore | kv-store | 只存 badge 断点与 pendingRoute |
| approvalStore | 不直接持久化（approvals/outbox 表由 repository 管） | 冷启动时 repository.hydrateApprovals() 回填 store |
| sessionStore | 不直接持久化 | 冷启动时 sessionsDao 查询回填 |
| eventStore | 不直接持久化 | 冷启动时按 selectedSessionId 加载最近窗口 |

持久化中间件 storage 适配器：`zustand/middleware/persist` 的 `storage` 参数用 `expo-sqlite/kv-store`（AsyncStorage 兼容 API，D4 3.5），保证与 settings 表同库同事务（避免 AsyncStorage 与 SQLite 双份存储的不一致面）。

---

## 4. 网络层

### 4.1 网络层组件总览

| 组件 | 文件 | 职责 | 依赖 |
| --- | --- | --- | --- |
| `ReconnectingWsClient` | `src/network/ReconnectingWsClient.ts` | WS 连接生命周期：建立/断开/重连退避/心跳/AppState 联动 | 无（纯传输） |
| `WsEnvelope` | `src/network/WsEnvelope.ts` | `DeviceEnvelope` 编解码 + 类型守卫（D3 5.3） | `@crish/shared-types` 类型 |
| `signer` | `src/network/signer.ts` | HMAC-SHA256 签名、nonce 生成、时间窗预判 | `expo-crypto` |
| `WsGateway` | `src/network/WsGateway.ts` | 应用层分发：invoke（`remote.*` 命令）/ 事件订阅 / result 匹配 / 错误归一 | `ReconnectingWsClient` + `WsEnvelope` |
| `HttpClient` | `src/network/HttpClient.ts` | fetch 封装（超时/重试/错误归一） | `AbortController` |
| `EndpointResolver` | `src/network/EndpointResolver.ts` | URL 构造（wss/https 映射、平台默认、env 覆盖） | — |

依赖关系：`WsGateway → ReconnectingWsClient`（单向）；`WsGateway` 持有 `signer`（签名上下文）；网络层整体不依赖 store（通过回调注入），store 由数据层回调更新。

### 4.2 WsEnvelope：DeviceEnvelope 编解码（D3 5.3 落地）

**统一帧结构**（协议真源 D3，禁止另行发明）：

```ts
// src/network/WsEnvelope.ts（类型 + 守卫）
export interface DeviceEnvelope {
  v: 1;
  kind: EnvelopeKind;                     // pair.* / auth.* / device.* / events.* / cmd.* / result.* / stream.* / heartbeat / error
  msgId: string;                          // 发送方唯一（utils/id.ts：uuid v4 或 计数+随机）
  ts: number;                             // epoch ms
  from: 'mobile' | 'desktop';
  to: 'mobile' | 'desktop';
  auth?: AuthHeader;                      // 会话期必填；配对期可选（D3 5.2）
  body: unknown;
}

export interface AuthHeader {
  deviceId: string;
  ts: number;
  nonce: string;                          // 随机 16B base64
  sig: string;                            // HMAC-SHA256(token_key, canon(header) + bodyJson)
}
```

**帧类型与 D4 12.5 帧表的映射**（实现对照表）：

| D4 12.5 帧类型 | D3 kind 落地 | 说明 |
| --- | --- | --- |
| `hello` / `hello-ok` / `hello-error` | `auth.hello` / `auth.helloOk` / `error {code: auth.*}` | D3 10.2 版本协商 + 5.2 鉴权校验合一 |
| `ping` / `pong` | `heartbeat` / `heartbeat.ok`（D3 9.3） | 30s 应用心跳 + 时钟偏移校准 |
| `invoke` / `invoke-result` | `cmd.<name>` / `result.<name>`（D3 8.2） | 命令名即 kind 后缀；响应带 `reqMsgId` |
| `event` | `events.push`（D3 7.3） | 每帧一个事件信封；`msgId` 与 `sequence` 双键去重 |
| `auth-revoked` | `auth.revoked`（D3 4.7） | 桌面吊销 → 移动端清凭据回配对页 |
| `ratelimit` | `error {code: rate.limited, retryAfterMs}` | 配额触发退避 |

**编解码要点**：

1. 发送：`signer.sign(envelope)` 在 JSON.stringify 之前计算 `sig = HMAC-SHA256(token_key, canon(header) ∥ bodyJson)`，canon 输入 = `deviceId ∥ ts ∥ nonce ∥ msgId ∥ kind ∥ v`（D3 5.1，定长字段拼接防重排）。
2. 接收：**先验签后解析**——对原始字节 JSON.parse 前先按 received 字节重算 HMAC（`crypto.subtle` HMAC 接口，异步但必须完成再分发）；验签失败 → 记日志 + 丢弃（不抛到业务层）。
3. 重放防护：`signer` 维护本地发送 nonce 计数；接收侧时间窗校验由桌面负责，移动端只做「发送时钟偏移校准」（`utils/clock.ts`，用 `heartbeat.ok` 的 serverTime 计算 offset，供 auth.ts 时间戳预判与 UI 显示）。
4. 大小上限：单帧 ≤ 1 MiB（D3 5.5）；接收超限 → 断链重连（与桌面一致防内存放大）。大载荷走 `stream.*` 分块（9.2 节）。

### 4.3 ReconnectingWsClient 详细设计

#### 4.3.1 连接状态机（内部相位 → 对外投影）

```
        connect()                           WS onclose/onerror
 idle ────────────► connecting ◄───────────────────┬────────────────┐
  ▲                    │  onopen                    │                │
  │                    ▼                            │ 重连退避        │
  │                 open ◄───────────── reconnecting│（指数+抖动）    │
  │                    │  close/error               │                │
  │                    └────────────────────────────┘                │
  │                          │ 重连失败超过 maxRetry（默认 5 次）或断网
  │                          ▼
  └─────────────── idle（回到起点，等待 connect() 再触发）────────────────
```

- 内部相位：`idle | connecting | open | reconnecting`（`WsPhase`）。
- 对外投影（纯函数 `mapWsPhase(wsPhase, netInfo)` → `connectionStore.phase`，映射表）：

| WsPhase | netInfo | connectionStore.phase | UI |
| --- | --- | --- | --- |
| idle | — | disconnected | 横幅「未连接」 |
| connecting | — | connecting | 加载指示 |
| open | — | ready | 正常 |
| reconnecting | — | recovering | 「重连中…第 N 次」 |
| reconnecting 且重试 > 封顶 或无网络 | — | offline | 「离线，审批动作将排队」 |

#### 4.3.2 重连退避（指数 + 抖动）

```ts
// src/network/ReconnectingWsClient.ts 核心算法
function nextRetryDelayMs(retryCount: number): number {
  // 失败序列：1s → 2s → 4s → 8s → 16s → 30s(封顶)，+0~1s 抖动
  const base = Math.min(1000 * 2 ** Math.min(retryCount, 5), 30_000);
  return base + Math.floor(Math.random() * 1000);
}
```

| 触发点 | 行为 |
| --- | --- |
| WS onerror/onclose（非主动断开） | 进入 reconnecting，调度 nextRetryDelayMs(++retryCount) |
| AppState 前台恢复 | **立即取消退避计时**并尝试重连一次（不等当前退避到期） |
| NetInfo 变化（wifi→cellular、离线→在线） | 同上，即时重连 |
| iOS 后台 | AppState → background：主动 `disconnect()` 进入 idle（30s 后系统挂起网络，D4 6.2.4），回前台重连 |
| Android 后台 | 保持连接但降心跳间隔（60s 心跳），Doze 由系统处理；断线走退避 |
| 重连成功 | 重置 retryCount = 0 → 触发追平（4.8）→ 重放 outbox（4.6）→ 全量刷新订阅状态 |

#### 4.3.3 心跳与保活

- 客户端每 30s 发 `heartbeat {ts, deviceTimeMs}`；60s 内未收 `heartbeat.ok` → 判定假死 → 主动 close → 重连（D3 9.3：双方 3×间隔未收到判定断线；客户端以 60s 为本地判定线）。
- `heartbeat.ok` 返回 `serverTime` → `utils/clock.ts` 计算 `clockOffset = serverTime - clientTime`，供 auth 时间窗预判（发送前自检：本机时间与桌面偏差 > 5 分钟 → 弹「时钟不同步」提示，D3 5.1 时间窗 ±5min）。
- 心跳与业务帧共用同一连接，不额外开销；心跳 RTT 最近 5 次采样入 `connectionStore.heartbeatRtts`（诊断面板，D4 6.6）。

#### 4.3.4 请求-响应关联与超时

```ts
// src/network/WsGateway.ts 请求匹配器（实现要点）
interface PendingRequest {
  resolve: (res: ResultEnvelope) => void;
  reject: (err: CrishError) => void;
  timer: ReturnType<typeof setTimeout>;
  msgId: string;
  retried: boolean;
}

class WsGateway {
  private pending = new Map<string, PendingRequest>();  // msgId → 挂起

  invoke<T>(kind: CmdKind, body: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    const msgId = nextMsgId();
    const envelope = this.sign(kind, body, msgId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.handleTimeout(msgId, reject), opts?.timeoutMs ?? 30_000);
      this.pending.set(msgId, { resolve, reject, timer, msgId, retried: false });
      this.client.send(envelope);
    });
  }

  // 关键：超时后不残留 pending；同 msgId 重发幂等（D3 8.5）
  private handleTimeout(msgId: string, reject) {
    const req = this.pending.get(msgId);
    if (!req) return;
    this.pending.delete(msgId);
    if (req.retried) { reject(normalizeTimeout()); return; }
    // 第一次超时：同 msgId 重发一次（桌面按 reqMsgId 去重，已处理回显缓存结果）
    req.retried = true;
    this.client.send(this.resend(msgId));
  }
}
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `timeoutMs` | 30_000 | D3 5.4 默认；配对握手/大分页可调大 |
| 重试策略 | 超时重发 1 次（同 msgId） | 业务错误不自动重发（D3 8.5：防双执行）；`auth.*` 错误后自动 refresh 重认证再重发 |
| 响应匹配 | `result.<kind>` 或 `error` 带 `reqMsgId` | 响应侧回显 msgId；无 reqMsgId 的推送类消息不参与匹配 |

**错误归一**：`error {reqMsgId, code, message, retryable}` → `@crish/shared-types` 的 `normalize` 面 → 用户可读文案（错误码域见 D3 6.2 全表）。移动端错误映射表（对齐 D4 5.1/12.3）：

| 服务端 code | 移动端行为 | 用户文案 |
| --- | --- | --- |
| `auth.bad_signature` / `auth.stale` | 重签名重发（nonce 重试） | 无（静默） |
| `auth.device_revoked` / `auth.unknown_desktop` | 清凭据 → 配对页 | 「配对已失效，请重新配对」 |
| `auth.expired` | refresh 重认证（4.3.5） | 无（静默） |
| `cmd.approval_mismatch` | 审批冲突分支（F2 11.2） | 「该请求已被其他设备处理或已过期」 |
| `cmd.denied` | 记录审计 + 提示 | 「该操作不受移动端支持」 |
| `stream.cursor_stale` | 全量回放（4.8） | 无（静默） |
| `error.frame_too_large` | 断链重连 | 「连接异常，正在重连」 |

#### 4.3.5 认证失败 → 刷新流程（与 authStore 联动）

```
收到 error {code: auth.expired | auth.bad_signature}
   │
   ├─ 有 refresh_key 且上次刷新 > 60s
   │    → 构造 auth.refresh 消息（一次性 token = HMAC(refresh_key, desktopId∥ts∥nonce)）
   │    → 成功后继续原请求重发
   │    → 失败（auth.expired 重复 / 网络）→ pairState = 'token_expired' → 引导重新配对
   └─ 无 refresh_key
        → pairState = 'token_expired' → 引导重新配对（保留 SQLite 缓存数据，D4 5.2）
```

### 4.4 事件订阅管理（多页面共享连接）

**原则：一条 WS 连接、两级订阅、引用计数**。

| 层级 | 订阅消息 | 内容 | 生命周期 |
| --- | --- | --- | --- |
| 全局轻订阅 | `events.subscribeAll {events: [type 白名单]}` | security-audit、device.*、timer/cron、新会话通知（D3 7.3） | 网关启动时建立，随连接生命周期 |
| 会话级订阅 | `events.subscribe {sessions: [...], lastSequences: {...}}` | 指定会话全量事件 | repository 引用计数：页面 view-model 挂载 +1，卸载 -1，归零时 `events.unsubscribe` |

**订阅管理实现（repository 层）**：

```ts
// src/data/subscriptionManager.ts（事件订阅引用计数，单例）
class SubscriptionManager {
  private refs = new Map<string, number>();           // sessionId → 引用计数
  private lastSequences = new Map<string, number>();  // sessionId → 本地游标

  acquire(sessionId: string) {
    const n = (this.refs.get(sessionId) ?? 0) + 1;
    this.refs.set(sessionId, n);
    if (n === 1) this.gateway.send('events.subscribe', {
      sessions: [sessionId],
      lastSequences: { [sessionId]: this.lastSequences.get(sessionId) ?? 0 },
    });
  }

  release(sessionId: string) {
    const n = (this.refs.get(sessionId) ?? 1) - 1;
    if (n <= 0) { this.refs.delete(sessionId); this.gateway.send('events.unsubscribe', { sessions: [sessionId] }); }
    else this.refs.set(sessionId, n);
  }

  onReconnect() {  // 重连成功：恢复全部活跃订阅
    for (const [sid, n] of this.refs) {
      if (n > 0) this.gateway.send('events.subscribe', {
        sessions: [sid], lastSequences: { [sid]: this.lastSequences.get(sid) ?? 0 },
      });
    }
  }
}
```

**订阅上限**：32 会话/设备（D3 7.3 `MAX_SUBSCRIPTIONS`）；超限 → 按最近活跃释放最旧订阅 + 提示。

**前台/后台策略**（省电，F1 6.2 + F3 3.2.2）：

| App 状态 | 订阅行为 | 事件处理 |
| --- | --- | --- |
| 前台 | 全速消费；Delta 级节流合并（48ms 文本/60ms 任务输出窗口，F3 3.0） | 实时渲染 + 落库 |
| 后台（30s 内） | 降速：不渲染，只写「脏标记」不触发重渲染（F3 3.0 存储面） | 关键事件（Critical）落库；Delta 丢弃 |
| 后台（超过 30s / iOS 挂起） | 连接主动断开（4.3.2） | 推送通道接管（第 8 章） |
| 回前台 | 即时重连 + 追平 + 快照重建 feed 骨架（F3 3.2） | 续接增量 |

### 4.5 断线续传（游标追平，D3 7.5 落地）

```
重连成功
   │
   ├─ 1. auth.hello（refresh 重认证，携带本地 deviceId + desktopId + lastSequences）
   ├─ 2. events.subscribe（恢复全部活跃订阅，携带 lastSequences）
   ├─ 3. 对每个订阅会话：
   │     lastSeq+1 ≤ 桌面窗口内 → events.resume 拉历史（复用 core_read_session_events
   │                             EventPage 契约：afterSequence 分页，200/页）
   │     lastSeq 落后 > 窗口(4096) → 全量回放（同一分页契约，循环拉取）
   ├─ 4. 续传完成（events.resume.done）→ 恢复实时推流
   └─ 5. Delta 事件不在续传范围：以 message-end / task 终态重建增量态（D3 7.5-5）
```

**本地游标记账规则**（`kvDao` 持久化）：

| 键 | 值 | 更新时机 |
| --- | --- | --- |
| `cursor.<sessionId>` | lastSequence | 仅「已持久化」的帧推进（preview 帧不推进，D3 7.4） |
| `cursor.subscribeAll` | 全局轻订阅水位 | 同规则 |

**防重放**：`events.push` 以 `(msgId, sequence)` 双键去重（D3 7.3）；`buildEventDedupeKey` 移植（`src/data/dedupe.ts`，对齐桌面 `EventRouter.ts:166-189`：`type:messageId:sequence`）。

### 4.6 离线 outbox（审批决策送达保证，F2 第 8 章 + D3 8.5 落地）

#### 4.6.1 入队与投递全流程

```
用户点「允许/拒绝」（approvalStore.setDeciding）
   │
   ├─ 立即写 outbox 表（status='queued'，入队即持久化，不管网络）
   ├─ 若 connectionStore.phase === 'ready' → 尝试即时投递
   │     ├─ 成功 → status='sent' → 出队 → 等待 approval-resolved 收口
   │     └─ 失败 → 保持 queued（待重放）
   └─ 若 offline → 保持 queued，卡片标「待发送」（F2 4.2）
         │
   连接恢复（connection-restored 事件）
         │
         ▼
   outbox.replay()：FIFO 顺序重放（单飞，禁止并发重放同一批）
         ├─ 每单超时 10s，最多 5 次；仍失败 → 保持 queued + 「审批可能超时」提醒（F2 8.2）
         ├─ 引擎回执 ok → status='sent' → 出队入历史
         └─ 收到 cmd.approval_mismatch（NotFound 语义）→ status='superseded' → 出队 + 冲突态（F2 11.2）
```

#### 4.6.2 outbox 数据结构与幂等

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 本地动作 id（uuid） |
| `tool_call_id` | TEXT | 幂等键（引擎侧 I-02 校验，D3 8.2） |
| `action` | TEXT | 'approve' \| 'deny'（deny 带 reason） |
| `payload` | TEXT | 完整 cmd 参数 JSON |
| `msg_id` | TEXT | 命令消息 msgId（同 msgId 重发幂等，D3 8.5） |
| `status` | TEXT | queued \| sending \| sent \| failed \| superseded |
| `attempts` | INTEGER | 重试计数 |
| `created_at` / `updated_at` | INTEGER | 时间戳 |

**冲突收敛规则**（F2 11.2 全量实现）：

| 场景 | 处理 |
| --- | --- |
| 桌面先处理，移动端后发 | `cmd.approval_mismatch` → 冲突态 + 对账拉取真实结果 |
| `approval-resolved` 事件先到 | 同 toolCallId 的 outbox 条目置 superseded（本地清理） |
| 用户撤销 | 删除条目 + 本地标记拒绝（F2 8.2 语义） |
| 审批已过期（本地倒计时到期） | 发送仍可（必然 mismatch）；提示「已过期，决策未生效」（F2 8.3） |
| 网络失败（非 mismatch） | 回滚 deciding → pending + 入重试队列（指数退避 1s→4s→16s→60s 封顶，以 D6 §6.3 / M6 §9.2 为准——【裁决修正】AU1 P2-7：原 2/4/8/30 序列与 F2 §8.1 一并收敛到 D6/M6 口径；连续 5 次失败转人工提示但保留队列元素，无硬上限靠 TTL 兜底） |

**重放触发点**：`connection-restored` 事件、`heartbeat.ok` 首个回执、App 回前台、手动「立即重连」按钮。

### 4.7 HTTP 客户端（HttpClient）

| 能力 | 实现 |
| --- | --- |
| 超时 | `AbortController` + `setTimeout`（默认 10s；配对握手 15s） |
| 重试 | 幂等请求（GET / healthz / 令牌查询）自动重试 2 次（指数退避）；写类请求不自动重试 |
| 错误归一 | 网络错误 → `network.unreachable`；HTTP 状态 → `codeFromHttpStatus` 映射（复用 `@crish/shared-types/errors/serialize`） |
| Base URL | `EndpointResolver`：`https://host:8765`（WSS 同端口协议映射；【裁决修正 6】端口统一 8765，原 7821 作废）；env 覆盖（`EXPO_PUBLIC_ENGINE_URL`） |

**移动端 HTTP 面职责边界（v1）**：

| 端点 | 用途 | 阶段 |
| --- | --- | --- |
| `GET /healthz` | 配对前的连通性探测 + hostMeta（桌面名/版本） | v1 |
| `GET /v1/pair/qr` | 桌面侧展示配对二维码的参考端点（实际由桌面 UI 渲染 QR，移动端仅解析） | v1 只读 |
| `POST /v1/push/token` | 推送令牌上报（Expo push token / 厂商 token） | v1（推送注册） |
| `POST /v1/pair/revoke` | 移除本机时吊销设备（D4 5.8） | v1 |

> 说明：配对主流程（pair.hello/challenge/verify）走 WS 消息（D3 4.8 时序），HTTP 只承担探测与辅助端点，避免双协议状态机。

### 4.8 背压与节流实现清单

| 面 | 策略 | 落点 |
| --- | --- | --- |
| 事件入栈 | 50ms 批量窗口落库（`ingest.ts` 批处理器），避免逐条 `runAsync` 写放大 | `ingest.ts` |
| Delta 合并 | message-delta 48ms / task-output 60ms 节流合并（F3 3.0） | `ingest.ts` + `StreamValueBatcher` 移植 |
| 渲染 | 事件窗口上限 5000 条/session（超限卸载 SQLite）；FlashList 虚拟化 + 行 memo | `eventStore` |
| 发送侧 | 命令天然低频；`remote.sendInput` 节流 ≥100ms/次（D3 9.4，超频返回 `cmd.invalid`） | `WsGateway` |
| 窗口溢出 | Critical 暂停推流（桌面反压）；移动端本地以游标续拉兜底 | 网络层被动 |
| 心跳频率 | 前台 30s；后台（Android）60s；iOS 后台断开 | `ReconnectingWsClient` |

### 4.9 网络诊断数据面（D4 6.6 落点）

设置页「诊断」面板数据源：

| 诊断项 | 数据源 |
| --- | --- |
| 连接状态快照 | `connectionStore`（phase/retryCount/heartbeatRtts/lastError） |
| 网关握手信息 | `auth.helloOk` 载荷缓存（kvDao：serverVersion/contractVersion/desktopId） |
| 事件流健康 | `eventStore` 游标落后量 + `deadLettersDao` 计数 |
| 推送状态 | `pushRegistration` 记录（token 脱敏尾 4 位、最近收到时间） |
| 证书/配对 | secure-store 元数据（指纹尾 8 位、deviceId、配对时间） |
| 日志导出 | `utils/logger.ts` 滚动 200 条 → 文本分享 |

---

## 5. 本地存储 schema

### 5.1 存储分层

| 层 | 技术 | 内容 | 安全等级 |
| --- | --- | --- | --- |
| 敏感层 | expo-secure-store（Keychain/Keystore） | token_key/refresh_key/设备私钥/主机指纹 | 最高（系统加密） |
| 结构化层 | expo-sqlite（`crish-mobile.db`，WAL） | 事件/审批/会话/run/outbox/文件缓存/订阅游标 | 中（应用沙箱） |
| 设置层 | expo-sqlite/kv-store | 主题/通知偏好/主机地址（非敏感） | 中 |
| 键值兜底 | 无（不用 AsyncStorage 存业务，D4 3.5） | — | — |

### 5.2 表设计全量（schema v1）

```sql
-- schema v1（PRAGMA user_version = 1）
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 会话摘要（对应共享类型 OrchestratorSessionEventSummary / list_sessions 返回）
CREATE TABLE sessions (
  session_id    TEXT PRIMARY KEY,       -- 引擎会话 id
  title         TEXT,                   -- 桌面推导标题（sessionTitle.ts 同规则，F5 2.1）
  cwd           TEXT,
  status        TEXT NOT NULL,          -- open | closed | archived
  is_pinned     INTEGER DEFAULT 0,
  is_archived   INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  engine_cursor INTEGER DEFAULT 0,      -- 引擎事件游标（hydratedFromEngine 对齐）
  engine_last_run_id TEXT,
  updated_at    INTEGER,                -- 毫秒时间戳（排序键）
  last_message_preview TEXT,
  metadata_json TEXT                    -- 元数据兜底
);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);

-- run 摘要（对应共享类型 OrchestratorRunRecord）
CREATE TABLE runs (
  run_id      TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  status      TEXT NOT NULL,            -- RunStatus 十态字面量（透传保真）
  outcome     TEXT,
  reason      TEXT,
  error       TEXT,
  kind        TEXT,                     -- task | goal
  created_at  INTEGER,
  started_at  INTEGER,
  finished_at INTEGER,
  usage_json  TEXT,                     -- RunUsage 快照（cache 指标）
  metadata_json TEXT
);
CREATE INDEX idx_runs_session ON runs(session_id, created_at DESC);

-- 事件流（引擎事件信封本地镜像；sequence 为会话级单调游标）
CREATE TABLE events (
  sequence      INTEGER,                -- 会话级单调 sequence（D3 7.4 唯一游标依据）
  event_id      TEXT NOT NULL,          -- 事件体 id（如 messageId / toolCallId）
  type          TEXT NOT NULL,          -- wire type（kebab-case）
  session_id    TEXT,
  run_id        TEXT,
  timestamp     INTEGER,                -- 事件时间戳（毫秒）
  payload_json  TEXT NOT NULL,          -- 完整事件体（宽容存储，解析在数据层）
  schema_version INTEGER DEFAULT 1,
  ingested_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, sequence)    -- 会话级复合主键：游标唯一性
);
CREATE INDEX idx_events_run ON events(run_id, sequence DESC);

-- 审批请求（本地待批队列 + 历史；payload 为 PermissionRequest JSON）
CREATE TABLE approvals (
  tool_call_id    TEXT PRIMARY KEY,     -- 幂等键（引擎 toolCallId）
  run_id          TEXT,
  session_id      TEXT,
  request_json    TEXT NOT NULL,        -- 完整 PermissionRequest（宽容存储）
  risk_meta_json  TEXT,                 -- 本地推导 riskMeta（F2 3.3）
  arbiter         TEXT NOT NULL DEFAULT 'user',  -- user | main-agent
  danger_level    INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL,        -- pending|deciding|queued|approved|denied|expired|superseded|conflict
  decision        TEXT,                 -- approved | denied
  decided_at      INTEGER,
  received_at     INTEGER NOT NULL,
  expires_at      INTEGER               -- 本地倒计时时刻（received_at + 120s，F2 8.3）
);
CREATE INDEX idx_approvals_status ON approvals(status, received_at DESC);

-- 离线 outbox（见 4.6）
CREATE TABLE outbox (
  id           TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL,
  action       TEXT NOT NULL,           -- approve | deny
  payload      TEXT NOT NULL,           -- 完整命令参数 JSON
  msg_id       TEXT NOT NULL,           -- 幂等重发键（D3 8.5）
  status       TEXT NOT NULL,           -- queued|sending|sent|failed|superseded
  attempts     INTEGER DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_outbox_status ON outbox(status, created_at);

-- 文件浏览缓存（60s TTL）
CREATE TABLE file_cache (
  path          TEXT PRIMARY KEY,
  parent_path   TEXT,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- dir | file | symlink | unknown
  size          INTEGER,
  modified_at   INTEGER,
  children_json TEXT,                   -- 目录列表快照（懒加载粒度）
  fetched_at    INTEGER NOT NULL
);
CREATE INDEX idx_file_cache_parent ON file_cache(parent_path);

-- 未知事件（宽容登记，不阻塞流）
CREATE TABLE dead_letters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_json    TEXT NOT NULL,
  parse_error TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- 订阅游标与运行态元数据
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 设备与配对元数据（非敏感部分；敏感密钥在 secure-store）
CREATE TABLE device_meta (
  device_id      TEXT PRIMARY KEY,
  desktop_id     TEXT NOT NULL,
  device_name    TEXT,
  paired_at      INTEGER NOT NULL,
  host_url       TEXT,                  -- wss://host:8765（裁决修正 6：原 7821 作废）
  cert_fingerprint TEXT,                -- 指纹尾 8 位（诊断展示用；完整指纹在 secure-store）
  contract_version TEXT                -- 握手时记录的契约版本
);

-- 通知与角标状态（推送去重/角标断点）
CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,        -- 通知去重键（sequence | toolCallId）
  kind         TEXT NOT NULL,           -- approval | run-ended | task-failed | ...
  tool_call_id TEXT,
  run_id       TEXT,
  seq          INTEGER,
  title        TEXT,
  body         TEXT,
  route        TEXT,                    -- 深链
  status       TEXT NOT NULL,           -- shown | dismissed | resolved
  received_at  INTEGER NOT NULL
);
CREATE INDEX idx_notifications_status ON notifications(status, received_at DESC);
```

> 注：`events` 表主键从 D4 7.2 的「sequence 全局主键」调整为「(session_id, sequence) 复合主键」，与 D3 7.4 的会话级 sequence 语义对齐（跨 run 不重置、并发 run 唯一）。全局游标语义由网关 `events.resume` 处理，本地不假设全局单调。

### 5.3 与桌面 conex-db 的字段对应

| 移动端表 | 桌面端对应 | 对应关系 |
| --- | --- | --- |
| `sessions` | conex-db sessions 索引（`SessionIndexEntry`） | 字段级对齐：id/title/folder/updatedAt/messageCount/engineCursor/engineLastRunId/hydratedFromEngine（共享类型 `OrchestratorSessionEventSummary` 同源） |
| `runs` | conex-db runs 表（`runs.rs:21-35` RunStatus） | status 字面量透传；usage 快照对齐 `RunUsage`（core_query_commands.rs:346-375） |
| `events` | conex-db events 表（conex-db/src/events.rs） | payload_json = 引擎序列化字节（逐字节不变，D3 7.6 同一份字节）；sequence 语义对齐 |
| `approvals` | 引擎 pending 集合（内存态）+ events 表事件历史 | 移动端是远端副本 + 本地决策态；以 toolCallId 对齐 |
| `outbox` | 无（桌面无离线概念） | 移动端独有 |
| `file_cache` | 桌面无缓存（实时查询） | 移动端独有（60s TTL 缓存） |
| `device_meta` | `device_registry`（D3 4.5） | 镜像桌面登记的本设备条目（非敏感子集） |

### 5.4 迁移机制

```ts
// src/db/migrations.ts（形态）
export interface Migration { name: string; sql: string[]; }
export const migrations: Migration[] = [
  { name: 'v1-initial', sql: [ /* schema v1 全部 CREATE TABLE */ ] },
  // 未来：{ name: 'v2-xxx', sql: [...] } 追加，禁止修改历史迁移
];

// src/db/db.ts（迁移执行，SQLiteProvider onInit）
export async function migrateIfNeeded(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let v = current; v < migrations.length; v++) {
    await db.withTransactionAsync(async () => {
      for (const sql of migrations[v].sql) await db.execAsync(sql);
      await db.execAsync(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
```

| 迁移纪律 | 说明 |
| --- | --- |
| 只追加不改写 | 已发布迁移 SQL 禁止修改（新需求走 v2+） |
| 幂等测试 | 测试覆盖「从 v0 逐级升到最新」与「重复执行不报错」（第 10 章） |
| 业务数据保留 | 迁移不删表不清库；「移除本机」也保留 SQLite（D4 5.8） |
| 重装 | 事件/审批/会话在重装后不保留（v1 无云备份，D4 7.3） |

### 5.5 缓存上限与清理（LRU 化）

| 表 | 保留策略 | 清理触发器 | 清理 SQL 形态 |
| --- | --- | --- | --- |
| `events` | 每 session 最近 5000 条；全局 5 万条 | 启动时 + 每 6 小时 | `DELETE FROM events WHERE (session_id, sequence) NOT IN (每个 session 最近 5000)`（按 session 窗口） |
| `approvals` | 已决/过期条目保留 30 天；pending 恒保留 | 日级（App 启动 + 回前台触发） | `DELETE FROM approvals WHERE status IN ('approved','denied','expired','superseded') AND decided_at < now-30d` |
| `runs` | 随会话级联（外键 CASCADE） | 会话清理时 | `ON DELETE CASCADE` |
| `sessions` | 保留最近 200 会话 | 日级 | `DELETE FROM sessions WHERE session_id NOT IN (SELECT session_id FROM sessions ORDER BY updated_at DESC LIMIT 200)` |
| `outbox` | `sent/superseded` 保留 7 天；queued 恒保留 | 日级 | 按 updated_at 窗口 |
| `file_cache` | 60s TTL 失效 + 全局 2000 项 | 访问时惰性失效 + 定期 prune | 按 fetched_at 窗口 |
| `dead_letters` | 1000 条 | 超限删最旧 | `DELETE FROM dead_letters WHERE id <= max_id - 1000` |
| `notifications` | resolved 保留 7 天 | 日级 | 按 received_at 窗口 |

**LRU 语义实现**：`events` 按「session 窗口」而非全局 LRU（会话活跃度不同，全局 LRU 会误删活跃会话的近期事件）；会话级「最近更新时间」即 LRU 近似（`sessions.updated_at` 排序 + 数量上限）。`file_cache` 用 `fetched_at` 排序 + 上限 2000 为真 LRU。

**磁盘占用预估**（D4 12.7 复核）：30 会话 × 2000 事件 ≈ 15-30MB；WAL 自动 checkpoint；诊断页展示当前占用（`db.getDatabaseSize` 类 API 或 info 查询），设置页「清理缓存」按钮执行上述全部清理（F6 11.3）。

---

## 6. 安全存储

### 6.1 什么存 secure-store、什么存 sqlite（划分依据）

| 存储位 | 键名（常量 `KEYS.*`） | 内容 | 理由 |
| --- | --- | --- | --- |
| secure-store | `device.keypair.priv` | 设备长期 X25519 私钥 `Mpriv`（base64） | 私钥永不落 SQLite（系统级加密保护） |
| secure-store | `device.keypair.pub` | 对应公钥 `Mpub`（配对上报用） | 与私钥同生命周期 |
| secure-store | `pair.token_key` | 会话令牌 HMAC 密钥材料（32B base64，D3 4.4 派生） | 消息签名凭据 = 会话身份 |
| secure-store | `pair.refresh_key` | 重连令牌签名密钥（32B base64） | 刷新会话用 |
| secure-store | `pair.host_fingerprint` | 桌面自签证书指纹（SHA-256，完整值） | 证书固定（D3 4.6） |
| secure-store | `pair.exchange_nonce` | 配对中间态（短期，配对完成后删除） | 一次性交换凭据 |
| SQLite | `device_meta` | deviceId/desktopId/deviceName/host_url/指纹尾 8 位/pairedAt | 非敏感元数据，需要查询 |
| SQLite | `kv`（部分键） | 订阅游标、诊断快照、通知偏好 | 运行态 |
| SQLite | 业务表 | 事件/审批/会话/outbox/文件缓存 | 结构化缓存 |

**划分原则**：凡是「泄漏即等于身份/会话失守」的密钥材料 → secure-store；凡是「泄漏仅损失隐私/体验」的数据 → SQLite。配对的密码学推导（psk/master/token_key）**不落任何存储**，只在配对过程中内存计算，只落派生结果（D3 4.4：桌面侧同策略）。

### 6.2 密钥生命周期

| 阶段 | 行为 |
| --- | --- |
| 配对 | `crypto.ts` 生成一次性 X25519 对 + 长期对 → pair.hello/verify 交换 → HKDF 派生 master → token_key/refresh_key → 写 secure-store（配对完成前不落库） |
| 使用中 | 会话签名只用内存中的 token_key（启动时从 secure-store 读入内存，`signer` 持有）；刷新用 refresh_key（一次性使用，D3 5.1） |
| 轮换 | 每 24h 桌面广播 `auth.rotate`（换 nonce 基数，token_key 不变）→ signer 更新签名上下文 |
| 移除本机 | `POST /v1/pair/revoke`（尽力）→ **无论成败**清空全部 `pair.*` 与 `device.keypair.*` 键 → pairState='unpaired' → 保留 SQLite（D4 5.8） |
| 桌面撤销 | 收到 `auth.revoked` → 清凭据 → 配对页（带原因文案） |
| 桌面重装 | 收到 `auth.unknown_desktop` → 清凭据 → 提示重新配对（D3 4.7） |

### 6.3 secureStore 封装 API

```ts
// src/db/secureStore.ts（封装面）
export const KEYS = {
  DEVICE_KEYPAIR_PRIV: 'device.keypair.priv',
  DEVICE_KEYPAIR_PUB: 'device.keypair.pub',
  PAIR_TOKEN_KEY: 'pair.token_key',
  PAIR_REFRESH_KEY: 'pair.refresh_key',
  HOST_FINGERPRINT: 'pair.host_fingerprint',
  EXCHANGE_NONCE: 'pair.exchange_nonce',
} as const;

export async function savePairingCredential(cred: PairingCredential): Promise<void>;  // 批量写
export async function loadPairingCredential(): Promise<PairingCredential | null>;      // 读 + 完整性校验
export async function clearPairing(): Promise<void>;                                   // 移除本机/吊销时全清
export async function hasPairing(): Promise<boolean>;                                  // 启动判定
```

**注意**（expo-secure-store 官方约束，D4 7.4 复核）：

1. iOS 单值上限 2048 字节：token_key/refresh_key/私钥均 ≤ 64B base64，无超限风险；若未来存大值（如备份密钥）需换 Keychain 大值方案。
2. Android：确认 `allowBackup=false`（防系统备份把密钥带出）；SecureStore 默认走 Keystore-backed EncryptedSharedPreferences。
3. 开发构建与生产构建 Keychain 访问组一致（EAS 配置，D8 7.2）。
4. `loadPairingCredential` 返回 null 或字段缺失 → 一律视为未配对（不部分恢复），启动走配对引导。

---

## 7. 启动流程

### 7.1 App 启动状态机

```
App 冷启动
   │
   ├─ 1. 基础设施初始化（串行，阻塞 UI 骨架）：
   │     · SQLiteProvider.openDatabaseAsync + migrateIfNeeded（<300ms 目标）
   │     · expo-notifications 通道创建（幂等，Android 13+ 必须在取令牌前，D4 8.2）
   │     · secure-store 读取（loadPairingCredential）
   │     · settingsStore.hydrate（kv-store persist 恢复）
   │
   ├─ 2. authStore.hydrate()：根据 secure-store 结果 → pairState
   │     · 有完整凭据 → 'paired'
   │     · 无凭据 → 'unpaired'
   │     · 有凭据但 desktopId 与 device_meta 不一致 → 'unpaired'（脏数据兜底）
   │     · hydrate 完成 → hydrated = true（触发路由守卫，D4 5.0 SplashGate）
   │
   ├─ 3. 路由判定（app/index.tsx AuthGuard）：
   │     · unpaired → /pair/welcome（首启引导）或 /pair/manual（有历史：重新配对）
   │     · paired → (tabs)/dashboard
   │
   ├─ 4. 后台任务启动（paired 才执行）：
   │     · EndpointResolver 构造连接 URL → ReconnectingWsClient.connect()
   │     · pushRegistration.ensureRegistered()（令牌获取/上报，失败不阻塞）
   │     · subscriptionManager 恢复全局轻订阅
   │     · dashboard 数据预取（list_sessions + core_get_status，缓存优先）
   │     · outbox.replay() 尝试（若立即连上）
   │     · 未决深链恢复（7.3）
   │
   └─ 5. UI 就绪（首帧渲染 → dashboard 骨架屏 → 数据到达）
```

**启动门禁与超时**：

| 阶段 | 目标耗时 | 超时策略 |
| --- | --- | --- |
| SQLite 打开 + 迁移 | ≤ 300ms | 失败 → 重试 1 次 → 降级「仅内存模式」提示重装 |
| secure-store 读取 | ≤ 100ms | 失败 → 视为未配对 |
| 首次 WS connect | ≤ 3s | 失败走退避，UI 先以缓存呈现（不阻塞首屏） |
| 首屏数据 | ≤ 1.5s（缓存优先） | 网络数据到达后刷新 |

### 7.2 冷启动 / 热启动路径

| 路径 | 场景 | 与冷启动差异 |
| --- | --- | --- |
| 冷启动 | 进程被杀后启动 | 完整走 7.1；SQLite 恢复事件流窗口（feed 重建骨架，F3 3.2：run 状态卡 + 已落库终态），再增量续接 |
| 热启动（回前台） | App 在后台 30s 内 | 不重走基础设施；仅触发 `connectionStore` 重连检查 + 页面级刷新（useDashboardRefresh seq 守卫，F1 8.2 T05） |
| 热启动（后台超时） | iOS 挂起 / Android Doze 后恢复 | 按冷启动路径的 4-5 步执行（连接重建 + 追平 + 快照刷新），基础设施复用 |
| 深链冷启动 | 点击推送被杀 | 7.1 步骤 1-3 正常执行 → 步骤 4 的「未决深链恢复」把 `lastNotificationResponse` 翻译为路由（8.2）→ 配对页等待（未配对时保留 pendingRoute，配对成功后补跳，D4 8.6） |
| 深链热启动 | 点击推送后台 | `useNotificationObserver` 直接 router.push（白名单校验，8.2） |

### 7.3 未决深链恢复（冷启动深链的时序处理）

```
冷启动 + lastNotificationResponse 存在
   │
   ├─ 已配对：等 dashboard 挂载后 router.push(route)
   │         （顺序：基础设施 → 路由守卫放行 → 深链跳转；不等 WS 连接成功，
   │          深链页以缓存呈现 + 「重连中」横幅）
   └─ 未配对：notificationStore.pendingRoute = route
             → 配对成功事件 → consumePendingRoute() → 跳转
             → 用户取消配对 → 丢弃 pendingRoute
```

**深链白名单**（安全强制，D4 8.6）：

```ts
// src/notifications/deepLink.ts
const ALLOWED_PREFIXES = [
  'crish://approval/',     // approval/[toolCallId]
  'crish://session/',      // session/[sessionId]
  'crish://run/',          // run/[runId]
  'crish://terminal/',     // terminal/[runId]
  'crish://tasks',
  'crish://usage',
  'crish://diagnostics',
  'crish://settings',      // 设置引导（F6 12.1 桌面引导二维码同前缀）
] as const;

function isAllowedRoute(url: string): boolean {
  return ALLOWED_PREFIXES.some((p) => url.startsWith(p));
}
```

---

## 8. 推送处理（客户端侧）

### 8.1 接收策略：前台 / 后台 / 被杀

| 场景 | 行为 | 实现 |
| --- | --- | --- |
| 前台（WS 在线） | **不弹系统通知**：事件流已实时渲染；审批类经前台 handler 展示**应用内横幅**（可点入详情），事件类直接吞（F2 6.2） | `setNotificationHandler` 的 `shouldShowBanner` 分支 |
| 前台（WS 离线） | 弹系统通知（在线双通道去重：本地 `notifications` 表按 `(kind, toolCallId/seq)` 幂等） | `setNotificationHandler` + `notificationsDao` 去重 |
| 后台（进程活） | 系统通知 + 可选后台静默更新（iOS 限制多，v1 仅 Android 启用 `registerTaskAsync`，D4 8.7 P2） | expo-task-manager |
| 被杀 | 系统通知展示（notification 消息由系统处理，data 由应用冷启动处理）→ 深链（7.3） | FCM/APNs 标准语义 |

**双路径原则落实**（D4 8.1）：在线走 WS 直推 + 本地决定展示；离线走厂商推送；两者在 `notifications` 表以幂等键合并（同一 toolCallId 的 approval 无论哪条路径到达，只产生一条通知/角标）。

### 8.2 点击跳转（深链映射）

| 推送 data.kind | data.url | 目标路由 | 落地页处理 |
| --- | --- | --- | --- |
| `approval` | `crish://approval/<toolCallId>` | approval/[toolCallId] | 详情页对账：本地有 → 渲染；已过期/已处理 → 冲突/过期状态页（F2 8.3）；本地无 → 拉取 `mobile_list_pending_approvals` 类对账命令兜底 |
| `run-ended` | `crish://run/<runId>` | run/[runId] | 快照 + 事件时间线（F1 4.3） |
| `task-failed` | `crish://tasks` | tasks | 任务页定位失败任务（F1 F09） |
| `task-suspicious` | `crish://tasks` | tasks | 同上 |
| `security-audit` | `crish://session/<sessionId>` | session/[sessionId] | 审计卡定位（F3 2.7，P2 页面） |
| `event`（通用） | `crish://session/<sessionId>` | session/[sessionId] | feed 定位 |

**落地页通用规则**（F1 7.6）：

1. 目标数据不存在（run 已归档/会话已删）→ 对应空态 + 返回首页，不崩溃。
2. 返回键回首页（不堆叠中间页）。
3. 跨域跳转（监控 → 审批）返回后回到发起页并刷新（角标收敛）。

### 8.3 通知权限引导

| 阶段 | 行为 |
| --- | --- |
| 配对成功 | 弹引导卡（非系统权限弹窗）：「开启通知，审批请求将第一时间送达」（F6 12.2 Step 3） |
| Android 13+ | 必须先 `setNotificationChannelAsync` 建通道（approval/run/security/general，D4 8.4）再 `getExpoPushTokenAsync`——通道创建在启动流程第 1 步完成（幂等） |
| iOS | APNs 权限由系统弹窗；拒绝后设置页「通知」总开关置灰 + 引导「前往系统设置」（F6 10.3） |
| 权限被拒 | 功能降级：审批仍可用（在线时）但无推送；设置页场景级开关不可单独开（防「开了但收不到」幻觉，F6 10.3） |
| 令牌轮换 | `addPushTokenListener` 监听滚动 → 重新上报推送网关（D4 8.2-6） |

### 8.4 场景去重与幂等（与 M8 推送域衔接）

推送域（M8）负责**服务端触发与路由**；本方案负责**客户端消费侧的幂等**：

| 幂等面 | 键 | 客户端行为 |
| --- | --- | --- |
| 通知展示去重 | `(kind, toolCallId)` 或 `(kind, seq)` | `notifications` 表 upsert：重复投递更新原通知不叠加（F1 4.8） |
| 双通道合并 | WS 事件与推送到达同一 toolCallId | WS 先到 → 前台横幅 + 标记通知已消费；推送后到 → 本地查表已存在 → 吞掉 |
| 决策后撤销 | toolCallId | 收到 approval-resolved → `dismissNotificationAsync` 撤销挂起通知 + 标记 resolved（F2 6.3；FCM 无法主动收回，data 消息到达后本地清除） |
| 角标计数 | 审批 +1/-1 事件驱动 | `notificationStore.badge`；打开 App 全量重算（查询兜底，F1 5.3） |
| 免打扰时段 | 21:00-08:00（可配） | 只放行 approval-requested；其余静默积压为应用内列表（F1 7.5） |

**推送载荷解析**（`notificationHandler.ts`）：`content.data` 字段（kind/url/sessionId/runId/toolCallId/seq/ts，D4 8.3）→ 校验 `isAllowedRoute` → 路由跳转；**渲染一律以落地后的实时数据为准**（推送 data 只做路由参数，不做数据源，防载荷与真实状态漂移，D4 8.3）。

### 8.5 通知通道规划（Android，幂等创建）

| 通道 id | 名称 | 重要性 | 用途 |
| --- | --- | --- | --- |
| `approval` | 审批请求 | HIGH + 声音 | 待批审批（不聚合不静默，F6 10.2） |
| `run` | 运行状态 | DEFAULT | run 完成/失败/取消 |
| `security` | 安全检查 | HIGH + 声音 | 安全检查结果、高危审计（F3 2.7） |
| `general` | 一般事件 | DEFAULT 静音 | 其他事件摘要（新消息聚合 10s 合并，F6 10.2） |

通道创建封装：`src/notifications/channels.ts` 的 `ensureChannels()`，启动流程第 1 步调用；设置页通知开关映射到对应通道（系统级联动，F6 10.3）。

### 8.6 国内安卓厂商推送（P1 预留接口面）

本方案定义**客户端侧接口面**（实现归 M8/P1 推送网关域）：

```ts
// src/notifications/pushRegistration.ts（接口面）
export interface PushProvider {
  readonly kind: 'expo' | 'vendor';          // Expo Push Service / 厂商通道
  getToken(): Promise<string | null>;        // getExpoPushTokenAsync 或厂商 token
  onTokenRefresh(cb: (token: string) => void): () => void;
}

export function resolvePushProvider(): PushProvider {
  // 国内机型（华为无 GMS）→ vendor 实现（P1 config plugin 注入的原生模块）
  // 其余 → expo 实现
  // 判定依据：expo-device 平台 + 厂商系统属性探测
}
```

config plugin（`plugins/withVendorPush.ts`，P1）注入厂商 SDK 与 Service/Receiver 声明；统一载荷的 data 字段与 8.2 表一致（D4 8.5-4），客户端解析无分支。

---

## 9. 性能预算

### 9.1 指标预算表（v1 基线，对齐 D4 9.5 并细化）

| 指标 | 预算 | 测量方式 | 兜底机制 |
| --- | --- | --- | --- |
| 冷启动到可用（已配对） | ≤ 2.5s（中端 Android） | EAS dev client + 启动 trace（第 9.4） | 首屏骨架 + 缓存优先 |
| 首屏数据（dashboard） | 网关聚合 ≤ 500ms（三次独立调用 ≤ 1s，F1 8.11 T60） | 网络层计时埋点 | 骨架屏 |
| 事件流追加渲染 | 100 条/秒不掉帧 | FlashList onScroll + JS 帧统计 | 50ms 批合并 + useShallow |
| 审批列表 100 条滚动 | 60fps | 同上 | 虚拟化 |
| WS 内存常驻 | ≤ 60MB（事件窗口 5000 条/session） | Hermes 堆快照（9.4） | 窗口卸载 SQLite |
| 包体 | 国内 AAB ≤ 80MB；国际 ≤ 60MB | EAS 构建产物 | 资源裁剪 + Hermes |
| 审批决策送达 P95 | 在线 ≤ 3s；离线 ≤ 重连恢复 + 2s | 埋点（决策 → resolved 事件） | outbox |
| 推送到达 → 通知展示 | ≤ 1s（高优先级通道，F2 13.4） | 真机验证 | 厂商通道 |
| 通知点击 → 详情首屏 | ≤ 1.5s（F2 13.4） | 深链页埋点 | 推送 data 预渲染摘要 |
| SQLite 打开 + 迁移 | ≤ 300ms | 启动 trace | 重试 + 降级 |
| 轮询节流 | 前台 4s；弱网降 15s；后台/熄屏零轮询 | 埋点计数（F1 8.11 T61/T64） | — |

### 9.2 渲染性能工程措施

| 措施 | 落点 | 预期收益 |
| --- | --- | --- |
| FlashList 虚拟化 | 会话 feed / 审批列表 / 会话列表 | 可视区渲染，长列表 60fps |
| 行组件 memo + 稳定 props | 全部列表行 | 事件追加只重渲染受影响行 |
| `useShallow` selector | 全部 store 订阅 | 引用稳定，防全列表重渲染 |
| 事件批合并（48/60ms） | `ingest.ts` | 高频 delta 合并为批渲染 |
| 滚动暂停跟随 | `useFollow` | 用户上翻时停止自动滚底（F3 3.1） |
| markdown 流式纯文本 | `utils/markdown.ts` | 流式期零解析；完成态一次性解析 |
| 长正文窗口渲染 | 消息 > 50KB 只渲染可视窗口（F5 3.3） | 防整段渲染卡顿 |
| ANSI 白名单 | `utils/ansi.ts` | 终端行只做白名单转义收敛 |

### 9.3 内存预算明细

| 面 | 预算 | 管理策略 |
| --- | --- | --- |
| eventStore 内存窗口 | 5000 条/session × 活跃会话数（上限 4 个窗口 ≈ 2 万条） | 窗口切换时卸载非活跃窗口（`unloadWindow` → SQLite）；FeedEntry 条均 ~200B → ~4MB |
| terminalStore 行缓冲 | 5000 行/run（环形，F3 4.x） | 超出丢弃最旧 |
| feed 环形 | 500 条/session（F3 3.0） | 顶部截断计数展示 |
| outbox 内存态 | 仅计数 + 最近 50 条引用 | 全量在 SQLite |
| 图片/缩略图 | 不缓存原图（F4 只读预览，≤1MB 文本） | 无持久图片缓存 |
| Hermes 总堆 | ≤ 60MB 常驻 | 上述全部 + 日志滚动缓冲 200 条 |

### 9.4 性能测量方案

| 手段 | 工具 | 采集内容 | 频率 |
| --- | --- | --- | --- |
| 启动 trace | `expo-tracing` / `expo-start` 内建 + `Performance.mark` 埋点 | 各启动阶段耗时（7.1 表逐项） | 每次 dev 构建 + release 抽样 |
| 帧率统计 | `InteractionManager` + JS 帧回调（自研 `utils/fps.ts`，仅 dev 启用） | 列表滚动帧率、卡顿次数 | dev |
| Hermes 堆快照 | dev client 的 `HermesInternal` 内存报告 | JS 堆大小（验证 ≤ 60MB） | 每周联调 |
| 网络埋点 | `WsGateway` 统一计时（invoke 耗时、事件到达间隔、心跳 RTT） | P95/P99 面板（诊断页） | 常驻（低开销采样） |
| 决策送达埋点 | `approvalRepository` 决策时间戳 → resolved 事件时间戳 | P95 送达时长 | 常驻 |
| SQLite 慢查询 | expo-sqlite 的 statement 耗时统计（dev 开启） | 慢 DAO 定位 | dev |
| 弱网模拟 | 模拟器 Network Link Conditioner / Android 弱网选项 | 降级路径表现（F1 T43） | 联调阶段 |

**性能回归门禁**（并入测试策略，第 10 章）：关键路径（启动/feed 追加/审批送达）埋点测试在 CI 中以「预算断言」形式运行（dev 构建冒烟 job 内，超出预算标记 warning 不阻塞）。

---

## 10. 测试策略

### 10.1 测试分层与工具（对齐 D8 5.2.3 的 M1-M4 分层）

| 层 | 内容 | 工具 | 门禁归属 |
| --- | --- | --- | --- |
| M1 纯函数/协议 | 状态机（配对/审批流/连接相位投影）、WsEnvelope 编解码、signer 签名、事件分类器、reducers、selectors、markdown/ANSI/time 纯函数、游标追平逻辑 | jest（jest-expo preset，纯 Node 环境） | 快层 mobile-test-fast |
| M2 组件 | 审批卡（风险徽标/二次确认/超时）、事件行、连接横幅、列表空态、SlideToConfirm | jest + @testing-library/react-native | 中层 mobile-test |
| M3 集成 | store + repository + mock WsGateway 全链路：配对流程、离线决策入队 → 重连重放、深链路由、订阅引用计数、通知去重 | jest + 内存 SQLite（`:memory:`） | 中层 mobile-test |
| M4 e2e | 真机/模拟器冒烟：启动 → 配对 → 会话可见 → 审批往返（Maestro 或 Detox） | Maestro（轻量优先）/ Detox 备选 | 慢层 nightly mobile-e2e |

### 10.2 每层关键测试清单

**M1 纯函数（快层，无覆盖率门禁但必跑）**：

| 测试 | 断言要点 | 依据 |
| --- | --- | --- |
| `pairMachine.test.ts` | 配对状态机全转换表（D3 4.2 移动端状态机） | 每行状态迁移覆盖 |
| `approvalFlow.test.ts` | 审批本地状态机（pending/deciding/queued/expired/conflict 全迁移） | F2 3.3 + 11.3 |
| `phaseProjection.test.ts` | 连接相位投影全映射表（WsPhase × netInfo → ConnectionPhase 每一行） | 4.3.1 表 |
| `wsEnvelope.test.ts` | DeviceEnvelope 编解码往返、canon 规范化、字段重排防护 | D3 5.1 |
| `signer.test.ts` | HMAC 签名/验签、nonce 唯一性、时钟偏移预判 | D3 5.1 |
| `dedupe.test.ts` | buildEventDedupeKey 键稳定性、双发幂等 | F2 11.2 + F3 3.2 |
| `ingestClassifier.test.ts` | 41 变体 → S/N/I 分类映射表（T1 护栏，F3 2.12） | 注册表漂移锁定 |
| `retryBackoff.test.ts` | 指数退避序列 1/2/4/8/16/30s 封顶 + 抖动边界 | 4.3.2 |
| `catchupCursor.test.ts` | 游标推进规则：preview 不推进、已持久化才推进、乱序缓冲 | D3 7.4 |
| `markdown.test.ts` | 轻量 markdown 子集解析（段落/列表/代码块/行内），HTML 剥离安全 | F5 3.1 |
| `ansi.test.ts` | ANSI 白名单转纯文本、注入防护 | F3 4.x |
| `outboxOrdering.test.ts` | FIFO 重放、单飞禁止并发、msgId 幂等重发 | 4.6 + D3 8.5 |
| `cachePrune.test.ts` | 各表清理 SQL 的窗口语义（LRU 近似） | 5.5 |

**M2 组件（中层）**：

| 测试 | 断言要点 |
| --- | --- |
| `ApprovalCard.test.tsx` | 风险徽标（L2 红/ L1 灰）、倒计时条、超时置灰、arbiter=main-agent 只读 |
| `ApprovalActionBar.test.tsx` | L1 单击决策、L2 滑动确认（50% 回弹/75% 触发）、防双点 busy |
| `SlideToConfirm.test.tsx` | 滑动阈值行为（F2 5.3） |
| `ConnectionBanner.test.tsx` | 五相位文案 + 重连按钮 |
| `EventRow.test.tsx` | 事件类型 → 图标/摘要映射、未知类型兜底 |
| `RunStatusChip.test.tsx` | 十态 → 五色分组全映射（F1 5.1） |
| `CountdownBar.test.tsx` | 剩余时间渲染、最后 15s 变红 |
| `EmptyState.test.tsx` | 各空态文案（F1 4.7） |

**M3 集成（中层）**：

| 测试 | 场景 | 断言 |
| --- | --- | --- |
| `pairFlow.test.ts` | mock WsGateway：pair.hello → challenge → verify → ok → 凭据落 secure-store（mock）→ 路由跳主界面 | 全链路状态迁移 |
| `outboxFlush.test.ts` | 断线决策入队 → 重连 → FIFO 重放 → 回执 ok → 出队入历史 | F2 8.2 全流程 |
| `deepLinkRouting.test.ts` | 冷启动深链、热启动深链、未配对 pendingRoute、白名单外 URL 拒绝 | D4 8.6 + 7.3 |
| `reconnectCatchup.test.ts` | 断线期间事件遗漏 → 重连 → events.resume 拉历史 → 无重复无遗漏 | D3 7.5 |
| `subscriptionRefcount.test.ts` | 多页面挂载/卸载 → 订阅引用计数 → 归零退订 | 4.4 |
| `notificationDedupe.test.ts` | WS 与推送双通道同 toolCallId → 仅一条通知/角标 | 8.4 |
| `approvalConflict.test.ts` | 桌面先处理 → 移动端后决策 → mismatch → 冲突态 → 对账收敛 | F2 11.2 |
| `migration.test.ts` | v0 逐级升到最新 + 幂等重复执行 + 业务数据保留 | 5.4 |
| `architecture.test.ts` | import 语句静态扫描：分层规则违规即失败 | 2.3 |

### 10.3 覆盖率目标

| 面 | 目标 | 口径 |
| --- | --- | --- |
| 全局（jest 全量） | statements 60 / branches 75 / functions 70 / lines 60 | D8 5.2.2 阈值，`collectCoverageFrom: src/**`，排除 types/generated |
| 协议与网络层 | **全覆盖要求**（branches ≥ 85） | 本层是门禁核心，专项收紧 |
| 数据层 | branches ≥ 80 | repository/outbox 路径 |
| UI 层 | 首期豁免，随阶段收口 | `!src/components/ui/**` 暂不入 collect 面（D8 5.2.2-3） |

### 10.4 测试基建要点

1. **jest-expo preset**：`preset: 'jest-expo'`，`transformIgnorePatterns` 按 D8 5.2.2 模板。
2. **moduleNameMapper**：`^@crish/shared-types$` → `<rootDir>/../../packages/shared-types/src/index.ts`（src 直出，不映射 dist，D8 5.2.2-1）。
3. **内存 SQLite**：`expo-sqlite` 测试用 `:memory:`（或 `SQLiteProvider` 的 test 目录）；每测试新建实例防跨用例污染（D4 9.2）。
4. **网络层 DI**：`WsGateway`/`ReconnectingWsClient` 接口注入，测试用 fake 实现（D4 9.2 mock 纪律）。
5. **secure-store mock**：`jest.setup.ts` 全局 mock `expo-secure-store`（内存 Map 实现，支持清空）。
6. **notifications/netinfo mock**：同上，全局 mock `expo-notifications` 与 `@react-native-community/netinfo`。
7. **关键路径门禁必测**（D4 9.2 清单 + 本方案 10.2）：
   - 审批「断线 → 决策入队 → 重连 → 重放送达 → 卡片消失」全链路；
   - 重复 approval-requested 幂等；
   - 事件解析 parseErr → dead_letter 不阻塞流；
   - 连接相位投影全映射表；
   - 订阅引用计数归零退订；
   - 深链白名单外拒绝。

### 10.5 跨端契约测试（双保险）

| 门禁 | 内容 |
| --- | --- |
| 生成器漂移 | CI 重跑 `generate-engine-bindings.mjs` → `git diff --exit-code`（D8 5.3.2 模式，已有 engine-bindings-drift 扩展） |
| 订阅事件子集清单 | 移动端维护「订阅事件白名单」（S/N/I 分类表）→ 测试断言：清单 ⊆ 注册表 `ALL_TYPE_NAMES`；注册表新增事件时该测试红（强制评审新事件在移动端的分支） |
| 契约回归 | `npm test -w @crish/shared-types`（生成解析器既有测试）在移动端 CI 同步跑 |

---

## 11. CI 集成与本地开发流

### 11.1 门禁分层（对齐 D8 5.5 门禁矩阵）

| 门禁 job | 层 | 触发 | 内容 | 预算 |
| --- | --- | --- | --- | --- |
| `mobile-lint` | 快 | PR 全量路径 | eslint（expo 规则 + no-restricted-imports 分层规则）+ prettier 检查 | 3 min |
| `mobile-typecheck` | 快 | PR 全量路径 | `tsc --noEmit`（strict） | 3 min |
| `mobile-test-fast` | 快 | PR 全量路径 | jest 关键套件（M1 纯函数全集，`--testPathPattern` 指向 `src/**/__test__|src/**/*.test` 的纯逻辑子集） | 5 min |
| `protocol-drift` | 快 | PR 全量（注册表/生成器变更必触发） | 重跑生成器 → diff | 2 min |
| `mobile-test` | 中 | 合并前 | jest 全量 + 覆盖率 60/75/70/60 | 10 min |
| `mobile-build-smoke` | 中 | 合并前 | `expo export --platform android`（JS bundle 冒烟，验证 Metro/解析） | 5 min |
| `workspace-single-instance` | 中 | 合并前 | `npm ls @crish/shared-types` 单实例断言（D8 5.3.4） | 1 min |
| `mobile-e2e` | 慢 | nightly | Maestro 冒烟（启动 → 配对 → 会话 → 审批往返） | 15 min |

### 11.2 workflow 结构（`.github/workflows/mobile-ci.yml`）

```yaml
name: mobile-ci
on:
  pull_request:
    paths:
      - 'apps/crish-mobile/**'
      - 'packages/shared-types/**'
      - 'crates/conex-types/contracts/**'
      - 'scripts/generate-engine-bindings.mjs'
      - '.github/workflows/mobile-ci.yml'
jobs:
  mobile-gate-fast:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck -w @crish/crish-mobile
      - run: npm run lint -w @crish/crish-mobile
      - run: npm run test:fast -w @crish/crish-mobile -- --ci
      - run: npx expo-doctor apps/crish-mobile        # SDK 依赖对齐（D4 9.4）
      - run: node scripts/generate-engine-bindings.mjs && git diff --exit-code -- packages/shared-types/src/generated
      - run: npm test -w @crish/shared-types           # 契约回归（同源复测，D8 5.1-3）
  mobile-gate-mid:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: mobile-gate-fast
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run test -w @crish/crish-mobile -- --ci   # 全量 + 覆盖率
      - run: npx expo export --platform android --output-dir dist-smoke   # 构建冒烟
      - run: node scripts/check-workspace-single-instance.mjs
  mobile-e2e-nightly:
    runs-on: ubuntu-latest
    if: github.event_name == 'schedule'
    needs: []
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx expo prebuild --platform android --no-install   # CNG 生成原生工程
      - run: npx maestro test .maestro/smoke.yaml                # 冒烟（模拟器环境）
```

**路径过滤决策**（D8 5.4-4 采纳）：移动端与共享包/注册表同仓，**不做 UI 层 paths-ignore**，全量跑快层（移动端测试量小，成本可接受）。

### 11.3 根 package.json 脚本（对齐 D8 6.3）

```json
{
  "scripts": {
    "dev:mobile": "npm --workspace @crish/crish-mobile run start",
    "dev:mobile:android": "npm --workspace @crish/crish-mobile run dev:android",
    "dev:mobile:ios": "npm --workspace @crish/crish-mobile run dev:ios",
    "dev:joint": "node scripts/dev-joint.mjs",
    "dev:joint:mobile": "node scripts/dev-joint.mjs --mobile",
    "typecheck:mobile": "npm --workspace @crish/crish-mobile run typecheck",
    "test:mobile": "npm --workspace @crish/crish-mobile run test",
    "test:mobile:coverage": "npm --workspace @crish/crish-mobile run test:coverage",
    "check:protocol": "node scripts/generate-engine-bindings.mjs"
  }
}
```

**apps/crish-mobile/package.json 脚本**：

```json
{
  "scripts": {
    "start": "expo start",
    "dev:android": "expo run:android",
    "dev:ios": "expo run:ios",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src app __tests__",
    "test": "jest --ci",
    "test:fast": "jest --ci --testPathPattern=\"src/(pairing|network|data|store/reducers|utils|store/selectors|db/migrations)\"",
    "test:coverage": "jest --ci --coverage",
    "prebuild": "expo prebuild",
    "check:encoding": "node scripts/check-chinese.ts"
  }
}
```

### 11.4 本地开发流（联合调试，D8 6.2-6.3 落地）

**拓扑一：模拟器（本机回环）**：

```
引擎（agent-workbench dev，监听回环端口）
  └─ WS ── crish-mobile（Android 模拟器用 10.0.2.2 映射宿主机回环 / iOS 模拟器 127.0.0.1）
```

**拓扑二：真机（局域网）**：

```
引擎（--listen 0.0.0.0:8765，防火墙放行；【裁决修正 6】端口统一 8765，原 7821 作废）
  └─ WSS ── crish-mobile（真机，同一 Wi-Fi，填局域网 IP）
```

**连接地址解析优先级**（D8 6.2）：

1. `EXPO_PUBLIC_ENGINE_URL`（`.env`，不入库；仓库只放 `.env.example`）；
2. 平台默认：Android 模拟器 `ws://10.0.2.2:8765`、iOS 模拟器 `ws://127.0.0.1:8765`（裁决修正 6）；
3. 设置页运行时覆盖（存 kv-store，免改 env 重打包）。

**开发期证书**（D4 10.2 S1）：dev build 用开发自签 CA + 指纹固定放宽（`__DEV__` 分支豁免）；production 强制 pinning。

**dev-joint.mjs**（零依赖 Node 脚本）：并行拉起引擎（`dev:workbench`）+ 移动端（`expo start`），打印各端 URL；Windows 回收用 `taskkill /T`（D8 6.3 要求）。

**常见坑对策**（D8 6.4 采纳 + 移动端补充）：

| 坑 | 对策 |
| --- | --- |
| Metro 缓存滞后 | `npx expo start --clear`；依赖变更重启 Metro |
| Android 9+ cleartext | dev 构建自带豁免；生产强制 wss:// |
| 引擎只监听回环 | `--listen 0.0.0.0` + Windows 防火墙放行 8765 |
| 连接串写死 | 全部走 env/运行时设置，代码零硬编码 |
| 双端协议漂移 | `check:protocol` + CI protocol-drift 兜底 |
| 真机连不上 | 先 `GET /healthz` 探测（HttpClient 诊断工具） |

---

## 12. 风险与开放问题

### 12.1 工程实现风险

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R-01 | expo-sqlite 与推送后台任务（headless）并发写库锁冲突 | 数据损坏/写失败 | WAL 模式 + 模块级单例 db + `withExclusiveTransactionAsync` 批写；后台任务只做「追加」类写（D4 10.1 R8） |
| R-02 | RN 内建 WebSocket 在弱网/断连下的 onerror 语义各平台不一致 | 重连状态机误判 | 状态机以「心跳超时」为权威判死信号（不依赖 onerror 时序）；平台差异用 NetInfo 佐证（4.3.1） |
| R-03 | expo-secure-store 在 Android 某些 ROM（厂商定制）上的异常 | 密钥读不出 → 误判未配对 | `loadPairingCredential` 失败降级为「未配对」+ 诊断记录；不尝试部分恢复（6.3-4） |
| R-04 | 事件高频期 SQLite 写放大 | 掉帧/卡顿 | 50ms 批窗口（4.8）+ 单写连接；压力测试语料：100 条/秒持续 5 分钟 |
| R-05 | 深链路由与 expo-router 升级破坏兼容 | 推送点击无响应 | 深链白名单集中维护（8.2）+ typed routes 增量开启 + 升级回归（deepLinkRouting.test） |
| R-06 | 订阅引用计数泄漏（页面卸载未退订） | 事件丢失/连接资源泄漏 | view-model 卸载强制 release；subscriptionRefcount.test 覆盖；泄漏检测：诊断页显示活跃订阅数 |
| R-07 | 审批双端并发决策竞态 | 用户困惑 | `cmd.approval_mismatch` 冲突态 + 对账收敛（F2 11.2 全表实现）；「先到者胜」文案（F2 9.3-6） |
| R-08 | 时钟偏移导致 auth 时间窗误判 | 随机断线 | heartbeat.ok 校准 + 发送前预判 + 「时钟不同步」提示（4.3.3） |
| R-09 | iOS 后台 30s 限制导致的频繁重连 | 电量/体验 | 产品语义「iOS 后台靠推送」（D4 10.1 R7）；回前台即时重连 + 追平 |
| R-10 | 国内厂商推送与 Expo 双通道令牌混乱 | 推送失效 | `resolvePushProvider` 单点决策（8.6）；推送网关按设备注册表路由（M8） |

### 12.2 开放问题（需主控/其他子代理裁决）

| # | 问题 | 涉及域 | 建议 |
| --- | --- | --- | --- |
| O-01 | 桌面 `core_get_status` 等轮询命令在移动端的高频调用是否需要在网关侧聚合（`companion_overview` 端点） | F1/D2 | 首期三次独立调用（预算 1s）；若延迟不达标加聚合端点（F1 10-1） |
| O-02 | 推送网关部署形态（自建轻服务 vs 三方聚合） | M8/D7 | v1 建议 Expo Push Service 简化（D4 12.4-2） |
| O-03 | 超时（120s）是否补发 `approval-resolved(expired)` 事件 | F2/引擎 | 未落地前移动端本地倒计时兜底（F2 14 R1，本方案已按此设计） |
| O-04 | 扫码配对（P2）是否进入 v1 范围 | F6 | 首期手动输入配对码（本方案已含 manual.tsx） |
| O-05 | `events.subscribe` 的会话级订阅与桌面事件桥的接线（DeviceEmitter 扇出）实现归属 | D3/Rust 侧 | 桌面端任务书（E 系列）承接；本方案已定义移动端全部契约面 |
| O-06 | 文件浏览命令面归属（`workbench_list_directory` 等 surface 判定） | F4/D3 | 实施时按权限矩阵定（D4 6.1.2） |
| O-07 | 双因素「桌面在场」信号源（心跳）引擎侧未实现 | F2/安全域 | 本方案只定义消费面（device_presence_query）；未实现前功能置灰（F2 14 R4） |

---

## 13. 附录

### 13.1 依赖清单（v1，D4 12.1 复核）

| 依赖 | 用途 | 版本策略 |
| --- | --- | --- |
| `expo` | 运行时 | 精确 57.0.0 |
| `react-native` | 运行时 | 精确 0.86.x |
| `react` / `react-dom` | 运行时 | 精确 19.2.3 |
| `expo-router` | 导航/深链 | SDK 57 配套 |
| `expo-sqlite` | 本地库 | SDK 57 配套 |
| `expo-secure-store` | 安全存储 | SDK 57 配套 |
| `expo-notifications` | 推送 | SDK 57 配套 |
| `expo-task-manager` | 后台通知任务 | SDK 57 配套 |
| `expo-crypto` | HMAC/X25519/HKDF | SDK 57 配套（**新增，本方案依赖**） |
| `expo-device` / `expo-constants` | 设备信息/projectId | SDK 57 配套 |
| `expo-local-authentication` | 本机解锁（P2） | SDK 57 配套 |
| `expo-camera` | 扫码（P2） | SDK 57 配套 |
| `zustand` + `immer` | 状态管理 | v5.x |
| `@crish/shared-types` | 跨端契约 | workspace 引用（src 直出） |
| `@react-native-community/netinfo` | 网络状态 | SDK 配套 |
| `react-native-gesture-handler` / `react-native-reanimated` | 手势/动画 | SDK 配套 |
| `jest-expo` / `@testing-library/react-native` | 测试 | SDK 配套 |
| `@shopify/flash-list` | 虚拟列表 | 社区包（新架构兼容检查后引入，D4 10.1 R2） |

> 新增依赖纪律：全部经 `npx expo install` 对齐；新增三方库需过「新架构兼容检查」（expo-doctor + 真机冒烟）并维护 `dependencies.md`（D4 10.1 R2）。

### 13.2 命令面速查（移动端使用子集，D3 8.2 映射）

> 【裁决修正 5】跨端命令 kind 统一 `remote.*`（`cmd.*` 仅桌面内部）。

| remote.<name>（命令 kind） | 对应 Tauri 命令 | 移动端角色 | 参数要点 |
| --- | --- | --- | --- |
| `remote.approve` / `remote.deny` | core_approve_tool / core_deny_tool | 审批核心 | toolCallId + scope/reason |
| `remote.runControl` | core_run_control | L0/L1/L2 | level + runId + sessionId |
| `remote.cancelRun` | core_cancel_run | L3 | runId + reason |
| `remote.runTask` | core_run_task | P2 委托执行 | clientMessageId 幂等 |
| `remote.readFile` / `remote.listDir` | workbench_read_file_content / workbench_list_directory | 文件浏览（只读） | path + workspaceRoot |
| `remote.getRunSnapshot` | core_get_run_snapshot | run 详情 | runId |
| `remote.readSessionEvents` | core_read_session_events | 事件回放/续传 | afterSequence 分页 |
| `remote.listTasks` / `remote.getTaskOutput` | workbench_list_background_tasks / workbench_get_background_task_output | 任务页 | — |
| `remote.getStatus` | core_get_status | 仪表盘轮询 | — |
| `remote.listSessions` | list_sessions | 会话列表 | — |

### 13.3 实施分期（对齐 D4 11.1 里程碑的工程任务切片）

> 【裁决修正 9】阶段映射：M0 骨架 → R2（移动端基础）；M1 连接与配对 → R2；
> M2 审批中心 → **R2 首批交付（裁决 12：审批中心 = P0 功能）**；M3 观测面、
> M4 文件/设置 → R2；M5 推送完备 → R3；M6 国内通道 → R3；M7 发布 → R3 收尾。
> 任务书引用一律使用 R 阶段号。

| 阶段 | 工程内容 | 本方案章节落点 | 出口标准 |
| --- | --- | --- | --- |
| M0 骨架 | 清空重建目录；SDK 57 + monorepo 接入 + jest-expo 全绿 + CI job；路由骨架 + AuthGuard | 2.1 / 11.2 | typecheck/lint/单测绿；真机冷启动达标 |
| M1 连接与配对 | ReconnectingWsClient + WsEnvelope + signer + pairProtocol + 令牌生命周期 + 连接相位 + 追平 | 4.2-4.5 / 6 / 7 | 配对 → 断网 → 重连 → 追平全链路真机通过 |
| M2 审批中心 | approvalStore + ApprovalCard/ActionBar + outbox + 审批冲突 + 推送审批通道 | 3.1 / 4.6 / 8 | outboxFlush 集成测试绿；离线决策送达 P95 达标 |
| M3 观测面 | 仪表盘 + 会话 feed + run 详情 + 终端只读 + 订阅管理 | 3.3 / 4.4 / 9 | 100 条/秒追加不掉帧；订阅引用计数测试绿 |
| M4 文件与设置 | 文件浏览 + 设置页 + 移除本机 + 通知偏好 + 诊断面板 | 5.2 / 6.2 / 8.5 | 目录树 1 万项级性能达标 |
| M5 推送完备 | 全通道规划 + 深链 + 徽标 + 前台/后台策略 | 8.1-8.5 | 三形态真机全通过 |
| M6 国内通道 | 厂商推送 config plugin（P1） | 8.6 | 华为/小米真机验证 |
| M7 发布 | EAS 正式构建 + 商店材料 | 11 / D8 7.2 | 商店审核通过 |

### 13.4 术语表

| 术语 | 含义 |
| --- | --- |
| DeviceEnvelope | D3 定义的统一消息信封（v/kind/msgId/ts/from/to/auth/body） |
| token_key / refresh_key | 配对派生的会话签名密钥与重连令牌密钥（secure-store 存储） |
| 游标追平 | 重连后按会话级 sequence 补齐断线期间遗漏事件（events.resume） |
| outbox | 本地持久化的待发决策队列，重连后 FIFO 重放 |
| 订阅引用计数 | 多页面共享 WS 连接时按引用计数管理会话级订阅生命周期 |
| preview 帧 | 实时预览事件帧（sequence=None），不落库不推进游标 |
| view-model | hooks/ 层的页面数据聚合器，组合 store 派生数据与数据层调用 |

### 13.5 参考代码索引（本方案依据，均为允许读取范围）

- 协议：`docs/multi-device/plans/D3-protocol.md`（§4 配对 / §5 信封与鉴权 / §7 事件 / §8 命令 / §9 流 / §10 版本）
- 选型：`docs/multi-device/plans/D4-mobile-tech.md`（§4 架构 / §6 网络 / §7 存储 / §8 推送 / §9 测试与性能）
- 功能域：`F1-monitor-panels.md`、`F2-approval-center.md`、`F3-event-stream-terminal.md`、`F5-session-messages.md`、`F6-settings-account.md`
- 工程：`docs/multi-device/plans/D8-engineering-release.md`（§5 门禁 / §6 本地开发流 / §7 构建发布）
- 代码：`crates/conex-types/src/events.rs`（信封序列化 events.rs:905-1013；背压分级 events.rs:867-893）、`packages/shared-types/src/index.ts`、`scripts/generate-engine-bindings.mjs`（生成器机制：注册表 engine-events.json → generated/engine 四文件，幂等确定性输出）

---

## 总结

移动端工程实现方案落成：**目录结构**为 `apps/crish-mobile` 五层单向分层（app 路由 / src 下 components-store-data-network-db），8 个 zustand store（auth/connection/approval/session/event/terminal/settings/notification，immer + persist + useShallow selector）；**网络层**以 D3 DeviceEnvelope 为唯一协议真源（消息级 HMAC 签名），自研 ReconnectingWsClient（指数+抖动退避、30s 心跳、msgId 请求-响应匹配、超时同键重发幂等），事件订阅走「会话级 + 全局轻订阅 + 引用计数共享连接」，审批离线 outbox 以 toolCallId + msgId 双幂等重放；**存储** 12 张 SQLite 表（会话级 sequence 复合主键）+ secure-store 6 个密钥位 + kv-store 设置；启动状态机、推送三形态深链、性能预算（冷启 2.5s/100 条每秒不掉帧/60MB 堆）、jest 四层测试与 CI 快中慢三门禁矩阵全部落地为可执行规格。

