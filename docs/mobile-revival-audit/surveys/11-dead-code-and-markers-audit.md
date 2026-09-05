# 移动端重复实现、死层与标记专项审计报告 (11-dead-code-and-markers-audit)

> **战役工作区**：`docs/mobile-revival-audit/`  
> **调查维度**：11 - 重复实现、死层与标记专项审计（Dead Code, Duplicates & Markers Audit）  
> **审计对象**：`apps/crish-mobile`（全域源码、测试集、配置文件与根目录临时资产）  
> **审计属性**：只读调研（严禁修改或删除任何生产代码）  
> **生成时间**：2026-09-04  

---

## 摘要与核心发现

本次专项审计针对 `apps/crish-mobile` 进行了全仓穷举扫描，深入代码静态依赖拓扑、符号导出引用交叉分析、注释与标记文本检索、以及运行时配置分析。主要审计发现如下：

1. **临时资产与打包破坏性 Hack 未清理**：根目录下残留明文注明“运行后删除不入库”的 `r2-16-crypto-polyfill.js` 以及 CLI 错误日志 `lint-out.txt`。同时在 `metro.config.js` 中硬编码了 Windows 本地绝对路径 `C:/Software/conex/node_modules/metro/src`，并劫持 Metro customSerializer 强行注入 polyfill；此外因将 8 个单测文件直接放置在 `app/` 路由目录下，导致 Expo Router 打包识别为页面引发崩溃，迫使引入 Metro `blockList` 补丁。
2. **多处基础概念存在“同一概念、多条路径”手写重复**：
   - 相对时间格式化在 `src/domain/pure/time.ts` 与 `src/presentation/components/files/fileMeta.ts` 重复实现且行为发生漂移（未来时间处理、超过 7 天格式分叉）；
   - 时钟格式化 `formatFeedTime`（EventRow）与 `formatHistoryTime`（ApprovalListScreen）代码逐字一致却各自手写；
   - 运行状态与颜色映射在 `runDetailMeta.ts` 与 `terminalScreen.tsx` 发生严重语义漂移（`running` 在一处为 `info` 蓝色，另一处为 `colorSuccess` 绿色，与 `completed` 混淆）；
   - 密码学 Base64 编码、Hex 转换在 `keyAgreement.ts` 与 `signer.ts` 重复实现；`signer.ts` 更是从零自研了 150 行 FIPS 180-4 SHA-256 与 RFC 2104 HMAC 算法，而全仓已引入 `@noble/hashes`。
3. **架构断层：SQLite 存储层存在大面积“未接线死层”**：
   - 8 个 DAO 中有 6 个（`SqlEventsDao`、`SqlSessionSummariesDao`、`SqlApprovalHistoryDao`、`SqlApprovalQueueDao`、`SqlPushTokensDao`、`SqlDeviceInfoDao`）完全未被任何生产 Store 或接线层调用；
   - `src/db/cachePolicy.ts`（280 行复杂 LRU 与 SQL 清理执行器）在生产中零调用；
   - 上述死层被 800+ 行自动化单测严密保护，形成了“死代码被死测试保护”的形式主义闭环。
4. **僵尸骨架目录残留**：`src/hooks/index.ts`、`src/domain/db/index.ts`、`src/domain/services/index.ts` 均为仅含 `export {};` 的空文件骨架，占位完成但未清退。
5. **降级逻辑均无删除日期契约**：梳理出全仓 15 处降级/回落分支，其中除无障碍 reduce-motion 与局域网非 TLS 属合理长期契约外，其余 13 处（包括 Expo Go 模块惰性降级、终端双轨回落、SQLite 降级纯内存态、输入流撤回逻辑截断等）均无明确的下线时间表或退场契约。

---

## 一、重复概念与合并建议

在 `apps/crish-mobile` 中，排查出 7 组典型的“同一概念多条路径”重复手写实现与语义漂移现象：

### 1.1 相对时间格式化双头路径（`formatRelativeTime`）

| 路径 | 函数定义 | 核心逻辑差异 | 消费方 |
| :--- | :--- | :--- | :--- |
| `src/domain/pure/time.ts:2-15` | `formatRelativeTime(timestampMs, nowMs = Date.now())` | 1. 容忍未来时间戳（`< 60s` 均计为“刚刚”）；<br>2. 超过 24 小时恒返回 `${day} 天前`（无上限）。 | `NotificationRow.tsx`、`SessionRow.tsx` |
| `src/presentation/components/files/fileMeta.ts:144-158` | `formatRelativeTime(modifiedMs, nowMs)` | 1. 未来时间戳（`diffMs < 0`）直接返回空串 `''`；<br>2. 满 1 天返回“昨天”，2-6 天返回 `${day} 天前`，≥7 天格式化为 `YYYY/MM/DD`。 | `FileRow.tsx` |

- **架构断层与问题**：
  同一函数名在同一前端项目中并存，两者对“时钟漂移/未来时间”和“长期历史时间”的格式化逻辑完全不同，违反单一真理源（SSOT）。
- **合并建议**：
  将格式化逻辑全量统一至领域纯逻辑层 `src/domain/pure/time.ts`。扩展配置参数 `formatRelativeTime(timestampMs, nowMs?, options?: { showYesterday?: boolean; absoluteAfterDays?: number })`，彻底删除 `fileMeta.ts` 中的重复函数。

---

### 1.2 时钟时间格式化逐字克隆（`formatClockTime`）

| 路径 | 函数名 | 实现代码 | 消费方 |
| :--- | :--- | :--- | :--- |
| `src/presentation/components/blocks/EventRow.tsx:196-200` | `formatFeedTime(ms)` | `const d = new Date(ms);`<br>`const pad = (n: number) => String(n).padStart(2, '0');`<br>`return \`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}\`;` | `EventRow.tsx`、`RunDetailHeader.tsx` |
| `src/presentation/screens/approvalListScreen.tsx:32-36` | `formatHistoryTime(ms)` | `const d = new Date(ms);`<br>`const pad = (n: number) => String(n).padStart(2, '0');`<br>`return \`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}\`;` | `approvalListScreen.tsx` |

- **架构断层与问题**：
  两处函数实现一模一样，各自在 UI 表现层私自手写，并导致 `RunDetailHeader.tsx` 还需要通过 props `formatClock: (ms: number) => string` 注入外部函数，破坏了组件自洽性。
- **合并建议**：
  在 `src/domain/pure/time.ts` 中新增导出 `formatClockTime(ms: number): string`（或 `formatHms(ms: number)`），清退两处手写实现。

---

### 1.3 运行状态文案与色调映射双规漂移（严重视觉毒点）

| 状态值 (`RunStatusView['state']`) | `runDetailMeta.ts` (`runBadgeLabel` + `runBadgeTone`) | `terminalScreen.tsx` (`runStatusLabel` + `statusDotColor`) | 漂移与冲突 |
| :--- | :--- | :--- | :--- |
| `running` | 文案：“运行中”<br>色调：`info`（主题蓝） | 文案：“运行中”<br>颜色：`theme.colorSuccess`（**绿色**） | **严重冲突**：终端页将运行中显示为绿色，用户误以为已成功完成；详情页则为蓝色。 |
| `completed` | 文案：“已完成”<br>色调：`success`（绿色） | 文案：“已完成”<br>颜色：`theme.colorSuccess`（绿色） | 文案一致，但底层取色逻辑脱节。 |
| `cancelled` | 文案：“已取消”<br>色调：`muted`（淡灰） | 文案：“已取消”<br>颜色：`theme.textTertiary`（灰色） | 色值映射路径不同。 |
| `failed` | 文案：“失败”<br>色调：`error`（红色） | 文案：“失败”<br>颜色：`theme.colorError`（红色） | 一致。 |
| `unknown` | 文案：“状态未知”<br>色调：`muted` | 文案：“未知”<br>颜色：`theme.textTertiary` | 文案不一致（“状态未知” vs “未知”）。 |

- **架构断层与问题**：
  `terminalScreen.tsx` 绕过了 `runDetailMeta.ts` 的成熟状态机与 `RunDetailHeaderView` 统一规范，直接在页面文件顶层手写 `runStatusLabel` 和 `statusDotColor`，导致界面多处状态指示灯颜色含义冲突。
- **合并建议**：
  将 `runStatusLabel`、`runBadgeTone`、`toneColorOf` 统一收敛至 `src/presentation/components/runDetail/runDetailMeta.ts`，`terminalScreen.tsx` 直接复用该逻辑，修正 `running` 色调为统一的 `colorInfo`。

---

### 1.4 连接相位状态机与选择器双规冗余

| 维度 | 路径 A (`connectionStore`) | 路径 B (`eventStore`) |
| :--- | :--- | :--- |
| **状态载体** | `src/domain/store/connectionStore.ts` | `src/domain/store/eventStore.ts` |
| **类型定义** | `ConnectionPhase = 'disconnected' \| 'connecting' \| 'ready' \| 'recovering' \| 'offline'` | `FeedNetwork = 'live' \| 'reconnecting' \| 'offline'` |
| **文案映射** | `src/domain/pure/selectors.ts:5`: `CONNECTION_PHASE_TEXT`<br>“未连接”、“连接中…”、“已连接”、“重连中…”、“离线” | `src/presentation/screens/sessionDetailScreen.tsx:30`: `networkLabel`<br>“实时”、“重连中”、“离线” |
| **状态同步** | `feedBridge.ts:141`: `connectionStore.getState().setPhase(mapWsPhase(phase, false))` | `feedBridge.ts:140`: `eventStore.getState().setNetwork(feedNetworkOf(phase))` |

- **架构断层与问题**：
  底层同一个 WebSocket 连接状态，在应用层被拆分成两个 Store 的两个状态属性（`ConnectionPhase` 与 `FeedNetwork`），每当网络相位变化，`feedBridge.ts` 必须同时调用两处变更；展示层又分别手写不同的中文文案。
- **合并建议**：
  以 `connectionStore` 的 `ConnectionPhase` 作为全局连接状态的单一真理源；`eventStore` 移除独立的 `network` 状态，或将其声明为只读衍生派生，统一使用 `selectors.ts` 的文案映射。

---

### 1.5 密码学 Base64 编码多处重复手写

- **重复证据**：
  1. `src/pairing/crypto/keyAgreement.ts:81-95`:
     ```ts
     /** base64 编码（与 signer.ts base64Encode 同算法；本域自备防跨域引用） */
     export function base64Encode(bytes: Uint8Array): string { ... }
     ```
  2. `src/network/signer.ts:189-202`:
     ```ts
     /** base64 编码（无依赖纯实现；兼容 RN 无 atob 的环境） */
     export function base64Encode(bytes: Uint8Array): string { ... }
     ```
  3. `src/network/__tests__/signer.test.ts:45-56`:
     ```ts
     function base64Of(bytes: Uint8Array): string { ... }
     ```
- **架构断层与问题**：
  `keyAgreement.ts` 的注释明确记录了故意手写重复的原因——“本域自备防跨域引用”。为了规避架构分层审查，开发者选择直接复制粘贴底层算法，造成 3 处 100% 逐字符重合的位运算编码循环。
- **合并建议**：
  提取至通用的纯工具包（或复用 `@noble/hashes/utils.js` 中的标准转换方法），彻底消除副本。

---

### 1.6 密码学 SHA-256 与 HMAC-SHA256 重复造轮子

- **重复证据**：
  - `src/network/signer.ts:41-186`：从零手写了 145 行纯 TypeScript 的 SHA-256（含 64 个轮常量 `SHA256_K`、8 个初始哈希 `SHA256_INIT`、`rotr` 循环移位、`sha256Pad` 填充、`sha256Compress` 压缩函数）以及 RFC 2104 HMAC 字节级异或。
  - `src/pairing/crypto/noblePrimitives.ts:48-52`：已经引入了现代密码学标准库：
    ```ts
    import { hkdf, expand } from '@noble/hashes/hkdf.js';
    import { sha256 } from '@noble/hashes/sha2.js';
    ```
- **架构断层与问题**：
  `signer.ts` 注释表明，手写密码学是在早期“R2-03 配对域未就绪”时的临时脚手架。当 R2-03 引入 `@noble/hashes` 落地后，`signer.ts` 中的 150 行底层算法未被重构替换，留下了极大的安全隐患与维护死重。
- **合并建议**：
  使用 `@noble/hashes/sha2.js` 的 `sha256` 和 `@noble/hashes/hmac.js` 的 `hmac` 替换 `signer.ts` 内部手写的 SHA-256 与 HMAC 实现，删除 150 行手写密码学代码。

---

### 1.7 密码学 Hex 编解码重复手写

- **重复证据**：
  - `src/pairing/crypto/noblePrimitives.test.ts:22`：
    `import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';`
  - `src/pairing/crypto/keyAgreement.test.ts:34-50`：
    手写 `function hexToBytes(hex: string): Uint8Array` 与 `function bytesToHex(bytes: Uint8Array): string`。
- **合并建议**：
  测试代码统一引入 `@noble/hashes/utils.js`，清理手写实现。

---

## 二、死层清理清单

经过全量跨文件引用交叉比对（排除自测文件与同名测试用例），梳理出以下死层模块与无生产引用的残留代码：

### 2.1 僵尸空目录与占位文件

| 文件路径 | 物理行数 | 文件现状与留存原因 | 清理方案 |
| :--- | :--- | :--- | :--- |
| `src/hooks/index.ts` | 3 行 | 仅包含 `// 通用 hooks 占位... export {};`。整个 `src/hooks/` 目录下仅有此文件。 | 清理该文件并移除 `src/hooks/` 空目录。 |
| `src/domain/db/index.ts` | 4 行 | 仅包含 `// 存储层占位... export {};`。真实 SQLite 实现已在 `src/db/`。 | 清理该文件并移除 `src/domain/db/` 空目录。 |
| `src/domain/services/index.ts` | 4 行 | 仅包含 `// 服务层占位... export {};`。整个 `src/domain/services/` 目录下仅有此文件。 | 清理该文件并移除 `src/domain/services/` 空目录。 |

---

### 2.2 完全未引用的生产死类与死接口

| 符号名称 | 所在文件 | 现状描述 |
| :--- | :--- | :--- |
| `HttpClient` | `src/network/HttpClient.ts:9-23` | 仅有构造函数和两个配置 getter（`base`、`options`），没有 `get`、`post` 或 `fetch` 的实际实现。全仓生产代码零调用，仅被其单测 `HttpClient.test.ts` 引用。 |
| `HttpClientOptions` | `src/network/HttpClient.ts:4-7` | 伴随 `HttpClient` 的空配置接口，同上。 |
| `AppEnv` | `src/domain/types/env.ts:2-5` | 环境变量类型接口，代码直接使用了 `process.env.EXPO_PUBLIC_ENGINE_URL`，此类型未被任何模块引入。 |

---

### 2.3 SQLite 存储层断层死层（6 个未接线 DAO 与缓存清理器）

当前移动端通过 `src/domain/store/persistBootstrap.ts` 装配持久化，**仅注入了 `settingsStore` 与 `notificationStore`**。其余 DAO 完全断层：

```mermaid
graph TD
    DB[src/db/dbBootstrap.ts] --> M[migrateIfNeeded]
    M --> Schema[schema.ts: 8 张数据表]
    
    subgraph 有效接线层
        Schema --> T1[settings 表] --> DAO1[SqlSettingsDao] --> PB[persistBootstrap.ts] --> S1[settingsStore]
        Schema --> T2[notifications 表] --> DAO2[SqlNotificationsDao] --> PB --> S2[notificationStore]
    end
    
    subgraph 架构断层死层 (未接线)
        Schema -.-> T3[events 表] -.-> D3[SqlEventsDao] -.-> NO1[无任何 Store 消费 / eventStore 纯内存]
        Schema -.-> T4[session_summaries 表] -.-> D4[SqlSessionSummariesDao] -.-> NO2[无任何 Store 消费 / sessionStore 纯内存]
        Schema -.-> T5[approval_history 表] -.-> D5[SqlApprovalHistoryDao] -.-> NO3[无任何 Store 消费]
        Schema -.-> T6[approval_queue 表] -.-> D6[SqlApprovalQueueDao] -.-> NO4[approvalWiring 内存态占位]
        Schema -.-> T7[push_tokens 表] -.-> D7[SqlPushTokensDao] -.-> NO5[无接线]
        Schema -.-> T8[device_info 表] -.-> D8[SqlDeviceInfoDao] -.-> NO6[无接线]
        D3 & D4 & D5 & D6 -.-> CP[cachePolicy.ts: 280行清理逻辑] -.-> NO7[无任何定时器/启动链调用]
    end
```

| 模块 / 符号 | 文件路径 | 代码行数 | 现状与断层原因 |
| :--- | :--- | :--- | :--- |
| `SqlEventsDao` | `src/db/dao/eventsDao.ts` | 230 行 | `eventStore` 纯内存运行，未接入持久化。 |
| `SqlSessionSummariesDao` | `src/db/dao/sessionSummariesDao.ts` | 150 行 | `sessionStore` 纯内存运行，未接入持久化。 |
| `SqlApprovalHistoryDao` | `src/db/dao/approvalHistoryDao.ts` | 130 行 | 历史审批未写入 SQLite，审批列表全靠实时拉取。 |
| `SqlApprovalQueueDao` | `src/db/dao/approvalQueueDao.ts` | 160 行 | `approvalWiring.ts:23` 注释承认“本层为内存态占位”，未落库。 |
| `SqlPushTokensDao` | `src/db/dao/pushTokensDao.ts` | 80 行 | 离线推送 Token 未接线。 |
| `SqlDeviceInfoDao` | `src/db/dao/deviceInfoDao.ts` | 90 行 | 设备非敏感元数据未接线。 |
| `cachePolicy.ts` (`runCleanup`, `computeEventsCleanup`, `buildTimeWindowCleanup` 等) | `src/db/cachePolicy.ts` | 280 行 | 设计用于全库 8 表的 LRU 与时间窗口淘汰，但没有任何生命周期或后台任务驱动它。 |
| `saveExchangeNonce` / `loadExchangeNonce` / `clearExchangeNonce` | `src/db/secureStore.ts:163-182` | 20 行 | 配对过程实际完全在内存完成，SecureStore 中的 `pair.exchange_nonce` 接口从未被配对状态机调用。 |

---

### 2.4 零生产引用的孤儿导出清单

以下符号在业务生产代码中均未被引用（部分仅有单元测试在调用）：

1. **`src/network/signer.ts`**：
   - `SignInput`（类型，无引用）
   - `sha256Bytes`（函数，无引用）
   - `hmacSha256Bytes`（函数，无引用）
   - `hmacSha256BytesOf`（仅自身测试引用）
   - `canonicalJsonStringify`（仅自身测试引用）
2. **`src/pairing/crypto/keyAgreement.ts`**：
   - `CONEX_PAIR_IKM_PREFIX`、`CONEX_PAIR_MASTER_SALT_SUFFIX`、`CONEX_PAIR_TOKEN_KEY_INFO`、`CONEX_PAIR_ENC_KEY_INFO`、`CONEX_PAIR_REFRESH_KEY_INFO`、`DERIVED_KEY_BYTES`（6 个常量无引用）
   - `derivePsk`、`deriveMaster`、`deriveTokenKey`（仅自身测试引用，实际由外部组合调用）
3. **`src/pairing/pairProtocol.ts`**：
   - `DEVICE_NAME_MAX_LENGTH`、`DEVICE_NAME_FALLBACK`、`DEVICE_ID_MIN_LENGTH`、`DEVICE_ID_MAX_LENGTH`、`TLS_FINGERPRINT_RE`、`BuildPairHelloInput`（无引用）
4. **`src/pairing/qrPayload.ts`**：
   - `QrPayload`、`QrPayloadInput`（无引用）
   - `formatQrPayload`（仅自身测试与 parity 测试引用，移动端无生成配对二维码需求，移动端是扫码方）
5. **`src/notifications/prefsGate.ts`**：
   - `NotificationSwitchGate`（类型无引用）
   - `shouldShowSystemNotification`、`shouldShowSystemNotificationForPush`、`notifySwitchGate`、`requestPermissionOnEnable`（仅自身测试引用）
6. **`src/presentation/components/dashboard/DashboardSkeleton.tsx`**：
   - `SKELETON_OPACITY_LOW`、`SKELETON_OPACITY_HIGH`、`SKELETON_PULSE_HALF_MS`（常量无外部引用）
7. **`src/presentation/components/terminal/terminalLineBuffer.ts`**：
   - `TERMINAL_MAX_LINE_CHARS`、`TerminalLineSnapshot`（无引用）
8. **`src/presentation/screens/sessionDetailScreen.tsx`**：
   - `sessionStatusLabel`、`networkLabel`、`latestRunIdOf`（仅内部定义且未被其他组件消费）
9. **`src/presentation/screens/terminalScreen.tsx`**：
   - `runStatusLabel`、`statusDotColor`（仅内部定义且未被其他组件消费）

---

## 三、未接线标记清单

全仓扫描包含 `TODO`、`FIXME`、`HACK`、`临时`、`待接线`、`未接线`、`遗留`、`占位` 的具体位置与隐患分析：

### 3.1 根目录残留文件与构建破坏 Hack

| 文件与行号 | 标记内容 / 代码 | 隐患与危害分析 |
| :--- | :--- | :--- |
| `apps/crish-mobile/r2-16-crypto-polyfill.js:1` | `// R2-16 联调临时 polyfill（不入库，运行后删除；见 R2-16-acceptance-execution.md 遗留清单）` | 联调时违规提交的临时补丁，本应在验证后清理，却长期入库遗留。 |
| `apps/crish-mobile/lint-out.txt:1-5` | `(node:5724) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///C:/Software/conex/eslint.config.js...` | 历史执行输出的垃圾文本文件，污染代码仓库根目录。 |
| `apps/crish-mobile/metro.config.js:1` | `// R2-16 联调临时配置（本地执行用，不入库；R2-16-acceptance-execution.md 遗留清单登记）` | 联调临时配置被入库，导致构建配置变形。 |
| `apps/crish-mobile/metro.config.js:11` | `const METRO_ROOT = 'C:/Software/conex/node_modules/metro/src';` | **硬编码本地绝对路径**！在任何非 `C:/Software/conex` 机器（CI、Linux、macOS、其他协作者机器）上构建必报 `Cannot find module` 致命错误。 |
| `apps/crish-mobile/metro.config.js:24-46` | `fs.readFileSync(path.join(__dirname, 'r2-16-crypto-polyfill.js'), 'utf8')` + `customSerializer` | 劫持 Metro 自定义序列化器强行拼接 polyfill，且与 `noblePrimitives.ts` 现有的 JSI 原生模块探测逻辑脱节。 |
| `apps/crish-mobile/metro.config.js:17-22` | `config.resolver.blockList = [ /\.test\.[tj]sx?$/, ... ]` | 因测试文件污染了 `app/` 目录，不得不使用 blockList 掩盖问题。 |

---

### 3.2 业务与协议层“待接线 / 占位”核心标记

| 所在文件与行号 | 标记原文 | 架构隐患 |
| :--- | :--- | :--- |
| `src/domain/repositories/settingsCommands.ts:14` | `C30/C31/C32 无对应端点（registered=false 待接线）` | 移动端设置确认、暂停自动化、状态查询在协议上尚未连通。 |
| `src/domain/repositories/approvalCommands.ts:29` | `afterSequence 增量水位 R1-04 未实现 → 全量对账` | 审批增量同步未实现，始终走低效的全量同步。 |
| `src/network/EndpointResolver.ts:17, 38` | `中继端口占位（中继服务本期不实现，D3 §3.1 仅协议留位）` | 中继穿透功能仅为存根占位，无法进行公网直连。 |
| `src/network/ReconnectingWsClient.ts:61` | `会话令牌（R2-03 配对派生后替换注入源：secure-store 读取；当前为接线占位）` | 重连客户端的 token 来源仍为外部占位注入，未完全闭环。 |
| `src/adapters/wiring/approvalWiring.ts:23` | `持久化（D6 §6.6 硬底线）属 db 域后续轮次，本层为内存态占位` | 审批 Outbox 未持久化，App 进程崩溃或划卡后离线决策有丢失风险。 |
| `src/adapters/viewmodels/useFilePreviewVm.ts:137` | `if (!ctx) return; // 未接线：保持 loading（连接恢复后重试）` | 接线上下文缺失时 UI 永久处于 loading 转圈状态。 |
| `src/adapters/viewmodels/useFilesVm.ts:153` | `if (!ctx) return; // 未接线：保持现状` | 上下文缺失时静默吞并操作。 |
| `src/adapters/viewmodels/useSettingsVm.ts:181` | `if (!ctx) return; // 未接线：保持现状` | 同上。 |
| `src/presentation/pair/pairScanScreen.tsx:1-4` | `扫码配对占位（P2 / G-10 注记：扫码功能即将推出，v1 手动输入先行）` | 扫码配对页面纯为静态文字占位，未接入相机扫描。 |

---

### 3.3 路由占位模板页面（`ProtectedPlaceholder`）

在 `app/` 路由目录中，有 4 个二级页面仍然完全是由占位模板组件构成的假页面：
1. `app/tasks.tsx`：`<ProtectedPlaceholder title="后台任务" description="定时 / 后台任务列表（R2-06 落地）" />`
2. `app/usage.tsx`：`<ProtectedPlaceholder title="用量与缓存" description="token 用量 / 本地缓存统计（R2-06 落地）" />`
3. `app/diagnostics.tsx`：`<ProtectedPlaceholder title="诊断" description="连接快照 / 网关信息 / 推送状态（R2-06 落地）" />`
4. `app/approval-history.tsx`：`<ProtectedPlaceholder title="审批历史" description="已决 / 过期 / 冲突条目（R2-04 落地）" />`

---

## 四、无用测试与破坏性测试清单

### 4.1 保护死代码的单测套件（生产已死，测试常绿）

以下单元测试所断言的目标对象在生产环境中从未被调用，测试的存在虚增了覆盖率，并增加了重构阻力：

| 测试文件 | 目标模块 | 测试代码行数 | 保护的死逻辑 |
| :--- | :--- | :--- | :--- |
| `src/network/HttpClient.test.ts` | `HttpClient.ts` | 32 行 | 测试从未使用的空骨架类 `HttpClient` 的构造参数与 getter。 |
| `src/db/cachePolicy.test.ts` | `cachePolicy.ts` | 401 行 | 401 行深度测试，断言从未被生产调用的 8 表 LRU 淘汰与时间窗口计算。 |
| `src/db/dao/eventsDao.test.ts` | `SqlEventsDao` | 205 行 | 测试从未接线的 `events` 表 SQLite 写入与游标重放。 |
| `src/db/dao/approvalDao.test.ts` | `SqlApprovalQueueDao` / `SqlApprovalHistoryDao` | 132 行 | 测试从未接线的审批队列和历史 DAO。 |
| `src/db/dao/approvalQueueDao.test.ts` | `SqlApprovalQueueDao` | 185 行 | 同上。 |
| `src/db/dao/approvalHistoryDao.test.ts` | `SqlApprovalHistoryDao` | 150 行 | 同上。 |
| `src/db/dao/metaDao.test.ts` (部分用例) | `SqlPushTokensDao` / `SqlDeviceInfoDao` / `SqlSessionSummariesDao` | ~100 行 | 测试从未接线的 3 个元数据 DAO。 |
| `src/presentation/components/templates/PlaceholderScreen.test.tsx` | `PlaceholderScreen.tsx` | 32 行 | 测试骨架期占位文字是否渲染。 |
| `src/presentation/components/templates/ProtectedPlaceholder.test.tsx` | `ProtectedPlaceholder.tsx` | 45 行 | 测试未配对重定向和占位文字。 |
| `src/presentation/pair/pairScanScreen.test.tsx` | `pairScanScreen.tsx` | 35 行 | 测试扫码占位文案“扫码功能即将推出”。 |
| `src/domain/repositories/mobileCommands.test.ts` | (虚构概念) | 589 行 | 589 行大型测试，断言 `device-protocol.json` 中的 8 条 `mobile_*` 命令已由其他文件实现（没有对应的生产源文件）。 |

---

### 4.2 路由树污染测试（导致打包器损坏的根因）

Expo Router 依据 `app/` 目录结构自动构建路由栈。以下 8 个测试文件直接存放在 `app/` 下，严重污染了路由树，是导致 Expo 原生打包把 `@testing-library/react-native` 等 devDependencies 一并打入 bundle 并引发 RedBox 的元凶：

1. `app/(tabs)/files.test.tsx`
2. `app/(tabs)/index.test.tsx`
3. `app/(tabs)/settings.test.tsx`
4. `app/_layout.test.tsx`
5. `app/notifications.test.tsx`
6. `app/pair/manual.test.tsx`
7. `app/pair/scan.test.tsx`
8. `app/pair/welcome.test.tsx`

- **治理方案**：
  将所有位于 `app/` 下的 `*.test.tsx` 移出路由目录，迁移至 `src/presentation/screens/__tests__/` 或与对应被测屏幕组件同级目录，彻底解除 `metro.config.js` 中的 blockList 补丁。

---

## 五、降级路径清单

全面排查全仓 15 处 Fallback / 降级逻辑，核查其契约与是否存在删除/退场时间表：

| 序号 | 降级代码位置 | 降级契约与逻辑 | 是否有删除日期 | 性质与治理建议 |
| :---: | :--- | :--- | :---: | :--- |
| **1** | `apps/crish-mobile/r2-16-crypto-polyfill.js:21` | ExpoCrypto 原生 JSI 宿主对象获取失败时静默降级。 | **无**（仅注记“运行后删除”） | **临时违规残留**。`noblePrimitives.ts` 已内置梯子算法，应彻底删除该文件。 |
| **2** | `src/notifications/expoNotificationsFacade.ts:10-102` | `expo-notifications` 动态加载失败（如 Expo Go 环境）时，系统通知面整体降级为“仅应用内通知”，所有系统通知 API 返回 null/noop。 | **无** | **长期合理契约**（Expo Go 兼容防线），但应明确在打通 EAS / 原生打包后的行为规范。 |
| **3** | `src/notifications/channels.ts:109-125` | 系统通知面不可用时跳过 Android 渠道创建，警告留痕不抛错。 | **无** | 配合 Expo Go 降级，合理防御性代码。 |
| **4** | `src/notifications/permissions.ts:65, 77` | 系统通知面不可用时，通知权限回退为“未查询/未决定”态。 | **无** | 配合 Expo Go 降级，合理防御性代码。 |
| **5** | `src/notifications/notificationBootstrap.ts:39` | 通知层装配抛错时捕获异常并返回降级句柄，保证应用正常启动。 | **无** | 启动链安全韧性防线，合理。 |
| **6** | `src/db/dbBootstrap.ts:5-70` | SQLite 打开或迁移任一失败时，调用 `configureSqlitePersistence(null)` 降级为纯内存运行态，不阻断 App 启动。 | **无** | 启动韧性防线，合理，但需有用户可见的警告注记。 |
| **7** | `src/presentation/components/blocks/SlideToConfirm.tsx:12, 270` | 用户开启系统 `reduce-motion`（减弱动态效果）无障碍设置时，滑轨确认自动降级为“点按允许 → 二次弹窗确认”。 | **无** | **永久无障碍规范要求**（WCAG / HIG 强制），完全合规。 |
| **8** | `src/presentation/components/dashboard/DashboardSkeleton.tsx:127` | `reduce-motion` 启用时，骨架屏停止循环脉冲呼吸动画，保持静态可见度。 | **无** | **永久无障碍规范要求**，完全合规。 |
| **9** | `src/domain/repositories/sessionCommands.ts:24-25, 89` | 移动端发起的 `full-access` 权限请求在桌面端会被无条件降级为 `ask` 模式（`apply_remote_mode`）。 | **无** | **远程安全基线强制契约**（防远程提权），完全合规。 |
| **10** | `src/network/EndpointResolver.ts:20` | WS 地址构造在显式端口时允许非 TLS（仅限可信局域网联调）。 | **无** | 局域网开发便利性降级，合规。 |
| **11** | `src/presentation/screens/terminalScreen.tsx:60-86` | 终端页面优先从 `terminalStore` 实时镜像获取文本；若无镜像（如历史 run），回落到遍历 `eventStore.windows` 事件流重建行缓冲。 | **无** | **双轨回落架构**。目前缺乏缓存命中指标与淘汰机制，两套逻辑长期并存。 |
| **12** | `src/db/dao/eventsDao.ts:152-158` | 事件持久化中撤回被标为“逻辑截断”，注释明确写道“本轮仅登记降级语义，不实现重放”。 | **无** | **历史未收敛债务**（统一输入流战役 R1 遗留），需在重构中明确是否实现重放还是彻底废弃。 |
| **13** | `src/db/cachePolicy.ts:212-224` | 缓存淘汰按“逻辑截断”降级，同上注记“本轮仅登记降级语义”。 | **无** | **历史未收敛债务**，同上。 |
| **14** | `src/domain/store/filesCache.ts:64` | 内存容量预算配置 `<= 0` 时，退化为永不存储的直通模式。 | **无** | 极限资源降级防线，合理。 |
| **15** | `src/pairing/crypto/noblePrimitives.ts:142` | 随机源探测链（Web Crypto → ExpoCrypto → 抛错），前序不可用时静默降级至候选。 | **无** | 环境自适应降级，合理。 |

---

## 六、收敛与整改执行建议（供阶段二详案参考）

根据本次审计事实，建议主控在阶段二汇总详案中按以下节奏推进收敛：

1. **第一优先级（零风险物理清理，解除打包阻断）**：
   - 立即删除 `apps/crish-mobile/r2-16-crypto-polyfill.js` 与 `apps/crish-mobile/lint-out.txt`；
   - 将 `app/` 路由目录下的 8 个 `*.test.tsx` 移至 `src/` 内部对应测试目录；
   - 移除 `metro.config.js` 中的硬编码 `METRO_ROOT = 'C:/Software/conex/node_modules/metro/src'`、`r2-16-crypto-polyfill.js` 读取注入逻辑、以及 `blockList` 补丁，将其还原为标准的 Expo Metro 配置；
   - 删除 `src/hooks/index.ts`、`src/domain/db/index.ts`、`src/domain/services/index.ts` 僵尸占位文件及对应空目录。
2. **第二优先级（消除重复手写与视觉漂移）**：
   - 将 `formatRelativeTime` 与 `formatFeedTime` / `formatHistoryTime` 统一合并到 `src/domain/pure/time.ts`；
   - 统一 `runDetailMeta.ts` 与 `terminalScreen.tsx` 的运行状态与指示灯映射，纠正 `running` 误标绿色的严重视觉 Bug；
   - 用 `@noble/hashes` 统一替换 `signer.ts` 中的 150 行手写 SHA-256 与 HMAC 密码学算法，删除 `keyAgreement.ts` 中的重复 `base64Encode`。
3. **第三优先级（存储层与死层收敛决断）**：
   - 评估当前移动端定位：若移动端定位为纯轻量实时观测中心，且会话与事件由桌面端权威持有，则应坚决清退 `SqlEventsDao`、`SqlSessionSummariesDao`、`SqlApprovalHistoryDao`、`SqlApprovalQueueDao` 及 `cachePolicy.ts` 等约 1200 行虚假持久化死代码及其配套的 800 行单测；若需要离线能力，则必须补齐接线，杜绝“写了 DAO 却在内存运行”的形式主义。
   - 清理 `HttpClient.ts` 空骨架类及 `HttpClient.test.ts`。
