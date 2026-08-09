# M8 推送与发布整合方案：三平台推送矩阵 + 应用商店发布

> 文档编号：M8-push-release
> 系列：crish 多端互通工作流（multi-device）
> 日期：2026-08-09
> 状态：草案（待主控评审与用户裁决）
> 作者：子代理 M8（推送与发布整合）
> 前置输入：D7 推送通知体系设计（三路线评估、13 场景、厂商矩阵）、AC 账号中心评估（push_tokens/relay_credentials 新增模块）、D8 工程整合与发布（EAS/版本三轨）、D4 移动端技术方案（Expo SDK 57 + 厂商 config plugin）、`crates/conex-types/src/events.rs`（41 变体事件契约）
> 产出一句话结论：**推送架构裁决为「桌面端策略引擎 + 双轨发送（在线 WS 直推优先、离线厂商通道兜底），一期发送器留在桌面端直连厂商 API（桌面在线前提，M3 升级为中继服务代发解决桌面离线场景）」；三平台矩阵为「iOS=APNs 直连（弃 Expo Push Service 国内路径）、Android=WS+HMS+小米+vivo+OPPO+荣耀逐厂商直连、HarmonyOS NEXT=华为推送服务 Push Kit（RNOH 自研原生模块桥接）」；商店矩阵为「App Store（中国区）+ 华为应用市场（含 NEXT）+ 国内安卓五市场 + Google Play 可选」，工信部 APP 备案为所有国内上架硬前置（2024-04 起未备案不可上架）。**

---

## 文档导航（读者索引）

| 章节 | 内容 | 关联输入 |
| --- | --- | --- |
| 第 0 章 | 结论摘要与决策清单 | 全篇收口 |
| 第 1 章 | 任务背景与输入盘点 | D7 / AC / D8 / D4 / events.rs |
| 第 2 章 | 三平台推送通道矩阵（核心交付 1） | D7 §5、网络查证 |
| 第 3 章 | 推送服务架构（核心交付 2） | D7 §4、AC §6.3、D1 §3.3 |
| 第 4 章 | 推送客户端（核心交付 3） | D7 §7、D4 §8 |
| 第 5 章 | 应用商店发布（核心交付 4） | D8 第 7 章 |
| 第 6 章 | 合规（核心交付 5） | D7 §11.3 |
| 第 7 章 | 测试矩阵（核心交付 6） | D7 §10 |
| 第 8 章 | 工作量与阶段（核心交付 7） | D7 §12、D8 第 11 章 |
| 第 9 章 | 风险与开放问题 | D7 §11、AC §9 |
| 附录 A | 网络查证记录 | webfetch/firecrawl |
| 附录 B | 参考资料与代码索引 | 仓库内证据 |
| 附录 C | 变更记录 | — |

---

## 第 0 章 结论摘要与决策清单

### 0.1 一句话结论

见文档头。本方案是 D7（推送）与 AC（账号）两条线的**整合裁决**，并把「推送能力」与「商店发布」绑定成一条可交付的工程闭环：**没有推送矩阵就没有上架资格，没有商店发布就没有推送注册入口**——两者互为前提，必须一体化设计。

### 0.2 关键决策清单（结论先行，详细论证见对应章节）

| # | 决策点 | 结论 | 章节 |
| --- | --- | --- | --- |
| D1 | 推送发送器位置 | **桌面端直连厂商 API**（发送器留在桌面 push-core，凭据只存桌面端）；【裁决修正】P2-4 命名：中继服务（**M2 中继**）代发列为 R4 演进 | 3.3 |
| D2 | 桌面离线兜底 | M1-M2 接受「桌面关机则无推送」；【裁决修正】M2 中继服务代发（R4 可选）+ 账号中心 push_tokens 注册表解决 | 3.3、3.5 |
| D3 | iOS 推送通道 | **APNs 直连（自建发送器，HTTP/2 + .p8 AuthKey）**；Expo Push Service（exp.host）仅海外版可选备胎 | 2.2 |
| D4 | Android 推送通道 | **逐厂商直连**（HMS/小米/vivo/OPPO/荣耀 5 家 REST API），FCM 国内不可用确认，不依赖 Expo Push Service | 2.3 |
| D5 | Android 移动端厂商 SDK 集成 | **prebuild + 自研 Expo config plugin** 注入厂商 SDK（华为用官方 `@hmscore/react-native-hms-push`；小米/vivo/OPPO/荣耀无官方 RN 封装 → 自研原生模块，Expo Module API） | 2.3 |
| D6 | HarmonyOS NEXT 路线 | **独立于 Expo 生态**（Expo 不支持鸿蒙）；RNOH（React Native OpenHarmony 社区）+ 自研推送原生模块桥接华为推送服务 Push Kit；M3 阶段评估 | 2.4 |
| D7 | 推送注册表归属 | **账号中心（AC）push_tokens 表**为云注册表真源；桌面端 device registry 为本地配对注册表；两表职责分离、双向同步 | 3.1 |
| D8 | 推送触发链 | 事件桥旁路（PushAwareEmitter）→ push-core 决策（筛选/去重/合并/静默/节流）→ 双轨分发（WS 直推 + 厂商通道） | 3.2 |
| D9 | 防打扰工程化 | 【裁决修正 4】本方案 S1-S12 场景表（18 行：P0×9/P1×7/P2×2）即**推送场景级别唯一真源**（原「D7 13 场景 P0×6/P1×4/P2×3」为旧口径，D7/M6 已同步）+ 去重键 + 合并窗口 + 静默时段（默认 22:30-07:30）+ 节流护栏，全部落地为纯函数与 SQLite 表 | 3.4 |
| D10 | 商店矩阵 | 国内必需：华为应用市场（Android APK + HarmonyOS NEXT 双形态）、小米、OPPO、vivo、应用宝；iOS 必需：App Store 中国区；Google Play 可选（海外版） | 5.1-5.3 |
| D11 | 上架硬前置 | 工信部 APP 备案（主体 ICP + APP 备案号）是**所有国内商店（含华为 NEXT 与安卓市场）上架的必要条件**，2024-04 起未备案不可上架 | 6.1 |
| D12 | 审核风险面 | App Review 对远程控制类应用的重点审查（隐私清单、用途声明、多任务 entitlement）；国内商店对「设备状态/通知权限」声明要求 | 5.1.4、6.3 |
| D13 | 版本策略 | 三轨：应用版本（每端独立 semver）/ 协议版本（schemaVersion 派生，单调递增）/ 兼容窗口（minProtocolVersion 握手协商）；移动端 EAS 渠道灰度 + TestFlight + 厂商分阶段发布 | 5.4 |
| D14 | 测试矩阵 | 三平台 × 五状态（锁屏/后台/清杀/省电/分类开关）真机矩阵 + mock 厂商网关集成测试 + 门禁分层 | 第 7 章 |

### 0.3 与既有方案的边界

| 母方案 | 本方案的承接与边界 |
| --- | --- |
| D7 推送方案 | 全量承接（场景清单/架构/厂商矩阵/防打扰）；本方案在其上新增：① 与 AC 账号中心 push_tokens 的整合细化（3.1）；② 桌面直推 vs 中继代发的最终裁决（3.3）；③ HarmonyOS NEXT 通道（D7 未覆盖，2.4）；④ 商店发布与合规（第 5-6 章）；⑤ 三平台测试矩阵与阶段（第 7-8 章） |
| AC 账号中心评估 | 承接「push_tokens 注册表 + relay_credentials」模块设计（§6.3/§6.4）；本方案细化：token 生命周期/过期刷新/发送方查询接口（3.1.4-3.1.6）；裁决「发送器一期桌面直连、二期经中继代理」开放问题（AC §9 风险 8） |
| D8 工程发布 | 承接 EAS 构建/版本三轨/门禁扩展；本方案补：各商店上架材料清单（第 5 章）、工信部备案流程（6.1）、版本灰度落地细节（5.4） |
| D4 移动技术 | 承接 Expo SDK 57 + 自研 config plugin 技术栈；本方案把 D4 §8.5「厂商推送 config plugin」从建议扩展为可执行的插件设计（2.3.3）与鸿蒙分支裁决（2.4） |
| D1 总体架构 | 承接「局域网直连优先 + 云中继兜底」拓扑；推送是移动端 P2 能力（D1 §1.5），本方案给出落地顺序（M1→M3） |
| events.rs 41 变体 | 推送场景源（D7 §3.2 全量筛选表已覆盖 41 变体）；本方案不再重复筛选，直接引用其结果并给出实现落点 |

### 0.4 阅读约定

- 代码位置统一 `文件路径:行号`（仓库内相对路径）；对外交付路径用 Windows 绝对路径。
- 「桌面直推」「中继代发」「厂商通道」三个术语在全篇稳定使用：桌面直推 = 桌面 WS 局域网直推（在线通道，复用协议面 events.push，裁决 2）；中继代发 = 云服务代发厂商 API（离线兜底，【裁决修正】P2-4 命名对齐：中继服务 = **M2 中继**，全篇「M3 中继」表述一律以 M2 为准）；厂商通道 = 各厂商推送服务（离线兜底，M1-M2 由桌面端直连）。
- 标注「待核实」的内容表示官方口径随版本演进，实现前需复核。

---

## 第 1 章 任务背景与输入盘点

### 1.1 本任务要回答的问题

D7 交付了推送体系设计（场景/架构/矩阵），AC 交付了账号中心评估（push_tokens 表），但两条线之间存在**整合断层**，本任务补上：

1. **通道矩阵未三平台化**：D7 只覆盖 iOS + 国内安卓，**未处理 HarmonyOS NEXT**（鸿蒙 NEXT 是华为 2024 起主推的独立生态，与 Android 完全不兼容，华为应用市场已双轨上架 APK 与 HAP/HAR 包）；
2. **发送器位置悬而未决**：AC §9 风险 8 把「桌面直连厂商 vs 经账号中心代理」列为开放问题——本任务必须裁决（3.3）；
3. **推送注册表只有骨架**：AC §6.3 给了 push_tokens 表结构与 4 个端点，但 token 过期刷新、与桌面 device registry 的同步、发送方查询接口未细化（3.1）；
4. **发布面完全空白**：41 事件筛选出的 P0 场景（审批必达）只有「手机上架」才有意义——商店发布矩阵、备案、审核、版本策略均未成文（第 5-6 章）；
5. **测试只有安卓真机矩阵**：D7 §10.5 的矩阵缺 iOS 推送细节、缺鸿蒙分支、缺商店侧验收（第 7 章）。

### 1.2 输入盘点（本方案直接消费的既有交付）

#### 1.2.1 D7 推送方案（`C:\Software\conex\docs\multi-device\plans\D7-push-notifications.md`）

| D7 交付 | 要点 | 本方案承接方式 |
| --- | --- | --- |
| 场景清单（§3） | 41 变体全量筛选 → 13 场景（P0×6/P1×4/P2×3），逐场景触发/文案/去重/合并/静默/跳转 | 【裁决修正 4】以本方案 S1-S12 表（18 行 P0×9/P1×7/P2×2）为唯一真源；D7 旧口径已标注 |
| 三路线评估（§4.1） | A 直连 WS / B 厂商通道 / C 自建中继 | 3.3 综合 D1/AC 裁决 |
| 分层架构（§4.2-4.5a） | 在线 WS 直推优先 + 离线厂商兜底；WS 中继协议 v1（配对/心跳/push/ack） | 【裁决修正 1/2】D7 §4.5a 独立 WS 中继协议已作废（裁决 2 方案甲）：在线直推并入协议面 `events.push`（M6 DeviceEnvelope）；配对码/端口按裁决 1/6 对齐；此处「直接承接」表述随之更新 |
| 厂商矩阵（§5） | HMS/小米/vivo/OPPO/荣耀逐家详评 + 聚合商对比 + Expo Push Service 不可用结论 | 2.3 扩展 RN 集成方案细化 |
| 推送消息 schema v1（§6.2） | PushMessage 全字段 + 厂商适配映射 | 直接承接；3.1.3 并入 token 生命周期 |
| 敏感度分级（§6.3） | 厂商通道只走摘要级 + data 白名单 | 直接承接；6.2 并入隐私政策 |
| 配置与密钥（§8） | 凭据矩阵/存储/环境隔离 | 承接；5.4 并入版本与渠道 |
| 测试（§10） | 单测/集成/mock 厂商网关/真机矩阵 | 第 7 章扩展三平台 |
| 里程碑（§12） | M0 在线直推 → M1 HMS+APNs → M2 全矩阵 → M3 自建中继 | 第 8 章与发布面合并排期 |

#### 1.2.2 AC 账号中心评估（`C:\Software\conex\docs\multi-device\plans\AC-account-center-evaluation.md`）

| AC 交付 | 要点 | 本方案承接方式 |
| --- | --- | --- |
| 裁决 | 「需调整」：核心账号复用，新增 push_tokens + relay_credentials 两模块 | 3.1 细化 push_tokens；3.5 承接 relay_credentials 与中继 |
| push_tokens 表（§6.3） | 表结构 + 4 端点 + 安全要点 | 3.1.2-3.1.6 细化（过期/刷新/同步/查询） |
| relay_credentials（§6.4） | 中继连接凭据 + Rust 中继服务选型 | 3.5 承接（M3 落地） |
| 开放问题（§9 风险 8） | 发送器：桌面直连 vs 账号中心代理 | **本方案裁决**（3.3） |
| 集成面（§7.2-7.3） | 桌面/手机接入流程表 | 3.1.7 落地为 token 生命周期流程 |

#### 1.2.3 D8 工程发布（`C:\Software\conex\docs\multi-device\plans\D8-engineering-release.md`）

| D8 交付 | 要点 | 本方案承接方式 |
| --- | --- | --- |
| 移动端入仓（§3） | apps/crish-mobile 独立 Expo app；turbo 收窄 | 直接承接 |
| 协议包（§3.4） | packages/protocol-core + generate-protocol-bindings.mjs | 推送 schema 作为协议注册表首批消息面（3.2.2） |
| 版本三轨（§7.3-7.4） | 应用版本/协议版本/兼容窗口 | 5.4 与商店灰度合并 |
| EAS 构建（§7.2） | 三 profile（development/preview/production） | 5.1-5.2 落地为各商店渠道 |
| 门禁扩展（§5） | 快层移动端静态检查/中层 jest + 协议对拍 | 7.3 并入推送测试门禁 |

#### 1.2.4 D4 移动技术（`C:\Software\conex\docs\multi-device\plans\D4-mobile-tech.md`）

| D4 交付 | 要点 | 本方案承接方式 |
| --- | --- | --- |
| 技术栈（§3） | Expo SDK 57 / RN 0.86 / expo-notifications + 厂商 config plugin | 2.3.3 落地为插件设计 |
| 推送章节（§8） | 国际版 Expo Push Service / 国内版厂商聚合，二选一推荐直连厂商 | **本方案与 D7 对齐裁决**：国内版逐厂商直连（2.3） |
| 目录结构（§4.3） | app/ 路由即深链命名空间 | 4.1 跳转映射直接承接 |

#### 1.2.5 事件契约（`crates/conex-types/src/events.rs`，41 变体）

- 41 变体全量清单：`events.rs:810-852`（engine_event_type_names 宏展开）；
- 背压分级：`events.rs:867-893`（event_backpressure，Critical/Soft/Delta）；
- 信封：`events.rs:921-993`（AgentEventEnvelope：runId/sequence/schemaVersion 扁平 JSON）；
- 推送相关事件载荷事实（本方案第 2 章/第 3 章实现依据）：
  - `approval-requested`（events.rs:479-484）携带 `PermissionRequest`（events.rs:194-218，含 toolCallId/toolName/parameters/summary/cwd/requester_run_id/reason）——审批通知可免查库渲染；
  - `run-terminal`（events.rs:511-519）携带 terminal/error——P0/P1 分级输入；
  - `subagent-ended`（events.rs:615-626）携带 status/summary——P0/P1；
  - `task-*` 七事件（events.rs:635-728）——P0/P1/P2；
  - `timer-fired`/`cron-fired`（events.rs:737-781）携带 prompt——P1 正文直接复用；
  - `security-audit`（events.rs:559-577）携带 operation/decision/impact——P0 子集。

### 1.3 术语表（本方案新增/强化）

| 术语 | 含义 |
| --- | --- |
| 桌面直推 | 桌面端（Tauri 进程内 WS 服务）在移动端在线时直推全量 PushMessage（【裁决修正 2】在线直推复用协议面 `events.push`（M6 DeviceEnvelope）；D7 §4.5a 独立 WS 中继帧协议作废） |
| 中继代发 | 【裁决修正】P2-4 命名对齐：中继代发 = **M2 中继**（Rust 中继服务，非 M3）+ 厂商发送器，在桌面离线时代发厂商通道（D1 §3.3 + AC §6.4；M2 §2.1 已标注一期不做，本项为 R4 演进） |
| 厂商通道 | 各厂商推送服务（HMS Push / 小米推送 / vivo / OPPO / 荣耀 / APNs / 华为 NEXT Push Kit），系统级投递 |
| push_tokens | AC 新增的推送令牌注册表（表 + 4 端点，AC §6.3）——云侧真源 |
| device registry | 桌面端 SQLite 设备注册表（D7 §8.2）——本地配对真源 |
| 双真源同步 | push_tokens（云）与 device registry（本地）的 token 双向同步机制（3.1.5） |
| APNs 直连 | 自建发送器用 HTTP/2 + .p8 AuthKey 直调 APNs（不经过 exp.host） |
| RNOH | React Native OpenHarmony 社区适配（react-native-oh-library / @react-native-oh-tpl），鸿蒙 NEXT 上跑 RN 的社区方案 |
| HAP/HAR | 鸿蒙应用包（HAP = HarmonyOS Ability Package；HAR = HarmonyOS Archive 静态共享包） |
| APP 备案号 | 工信部 APP 备案后分配的备案编号（格式 豫ICP 备XXXXXXXX号-XXA 之类），国内上架硬前置 |

### 1.4 本方案新增事实（网络查证，2026-08）

查证细节见附录 A。三条关键新事实（D7 未覆盖）：

1. **Expo 官方不支持 HarmonyOS**：Expo SDK 参考页（docs.expo.dev/versions/latest）的兼容矩阵只有 iOS/Android/Web/TV，无鸿蒙分支——**鸿蒙 NEXT 无法复用 Expo 移动端，必须独立技术路线**（2.4）。
2. **RNOH 社区活跃但推送适配空白**：react-native-oh-library 组织（299 个三方库适配仓库，含 gesture-handler/reanimated/WatermelonDB 等）正在成建制适配 RN 三方生态，但**未发现华为推送（HMS Push）的 RNOH 适配包**——鸿蒙推送需自研原生模块桥接（2.4.3）。
3. **华为官方 RN 推送插件仅限 Android**：`@hmscore/react-native-hms-push` 最新 6.13.0-301（npm，2026-06 发布），面向 Android（HMS Core）——验证了 D7 的结论，且说明 NEXT 推送必须另辟蹊径。

---

## 第 2 章 三平台推送通道矩阵（核心交付 1）

### 2.1 平台总览

| 维度 | iOS | Android（国内） | Android（海外） | HarmonyOS NEXT |
| --- | --- | --- | --- | --- |
| 操作系统体系 | Apple 私有 | Google AOSP + 厂商 ROM | Google AOSP + GMS | 华为自研（非 Android） |
| 系统级推送通道 | APNs | 无 GMS → 厂商通道（HMS/小米/vivo/OPPO/荣耀） | FCM | 华为推送服务（Push Kit） |
| 通道可用性（国内） | 可用（APNs 国内可达） | FCM 被墙不可用；厂商通道系统级可达 | FCM 可用 | 系统级可达（华为系唯一） |
| Expo 支持 | ✅ SDK 57 一等公民 | ✅ | ✅ | ❌（Expo 不支持鸿蒙） |
| 应用包形态 | .ipa | .apk | .aab | .hap（NEXT 生态） |
| 应用商店 | App Store 中国区 | 华为/小米/OPPO/vivo/应用宝等 | Google Play | 华为应用市场（NEXT 专区） |
| 推送服务端发送 | APNs HTTP/2 API | 各厂商 REST API | FCM v1 API | Push Kit REST API |
| 本项目通道角色 | 离线兜底主通道 | 离线兜底主通道（多厂商并行） | 海外版可选（M2 后） | M3 阶段（与 NEXT 上架绑定） |
| 真机测试成本 | 1 台 iPhone（或 EAS 云测） | 5 厂商机型 × 各 1-2 台 | 模拟器/海外真机 | 1-2 台华为 NEXT 机型 |

### 2.2 iOS：APNs 直连 vs Expo Push Service（重点核实项）

#### 2.2.1 结论先行

**国内发行版：APNs 直连（自建发送器），不依赖 Expo Push Service。** Expo Push Service（exp.host）仅作为海外版的可选备胎。

#### 2.2.2 核实过程与事实

| 事实 | 依据 | 对本方案的结论 |
| --- | --- | --- |
| APNs 在国内网络可达（系统级连接，不经大陆墙内 DNS 污染面） | 长期事实：中国大陆 iPhone 用户能收到正常 App 推送 | iOS 端必须走 APNs，通道本身无「国内不可用」问题 |
| exp.host 服务器托管于美国 GCP，官方文档要求「服务器须与美国 GCP 连通」，无 SLA | D7 §5.9 查证（Expo 官方文档） | exp.host 国内网络抖动 → 不可作为生产依赖 |
| exp.host 对 iOS 只做「APNs 代理」——token 仍是设备 APNs token | Expo 文档（push token = 设备 APNs token，服务端转发） | 自建直连 APNs 不改变移动端 token 语义，**移动端零改动**，只换发送端 |
| expo-notifications 的 `getDevicePushTokenAsync()` 返回原生 APNs token（区别于 getExpoPushTokenAsync） | Expo SDK 57 文档 | 移动端取 token 用原生路径，兼容两种发送端 |
| 自建直连需要：开发者账号 + APNs AuthKey(.p8) + KeyID + TeamID | Apple Developer 文档 | 凭据矩阵（D7 §8.1）已有此条，直接可用 |

#### 2.2.3 APNs 直连实现要点（发送器 Rust 侧）

1. **通道形态**：HTTP/2（h2）POST 到 `https://api.push.apple.com/3/device/{device_token}`；沙箱用 `api.sandbox.push.apple.com`。
2. **认证**：Token-based（Apple 推荐）——`APNs AuthKey`（.p8，ES256）签发 JWT（header: `alg=ES256, kid=<KeyID>`；claims: `iss=<TeamID>, iat=<now>`），**每连接一个 token，有效期 1 小时**；凭据含 `.p8` 文件 + KeyID + TeamID 三件套（D7 §8.1 已有）。
3. **载荷**（PushMessage → APNs 映射）：

```json
{
  "aps": {
    "alert": { "title": "Crish 需要你的批准", "body": "bash：执行部署脚本" },
    "sound": "default",
    "badge": 1,
    "thread-id": "session:s-7",
    "category": "CRISH_APPROVAL",
    "interruption-level": "active"
  },
  "crish": {
    "schemaVersion": 1, "eventType": "approval-requested",
    "dedupeKey": "approval-requested:tc-9f3a",
    "target": { "screen": "approval", "sessionId": "s-7", "params": { "toolCallId": "tc-9f3a" } }
  }
}
```

映射规则：
- `alert.title/body` ← PushMessage.title/body；
- `thread-id` ← collapseKey（iOS 分组堆叠）；
- `interruption-level`：P0 → `active`（或 `time-sensitive` 需申请 entitlement，默认不申请）；P1 → `active`；P2 → `passive`；
- `category` ← channelId（需在 App 侧注册 UNNotificationCategory）；
- `crish.*` ← 自定义 payload 键（跳转所需最小集，**不携带工具参数全文**，对齐 D7 §6.3 敏感度白名单）；
- `aps.alert` 在锁屏隐藏正文场景由移动端本地决定（推送到达时 `shouldShowBanner` 逻辑，4.2）。

4. **重试与错误处理**：
   - HTTP 状态 200 → 成功；400 参数错（不重试，审计）；403 无效 token（凭据轮换）；410 `Unregistered` → **DeviceNotRegistered 语义**：移除 device registry 中该设备（对齐 Expo 对 DeviceNotRegistered 的处理）；
   - 429 限流 → 退避重试（对齐 D7 §6.6 的指数退避）；
   - 5xx → 退避重试（2/4/8/16/32 秒封顶）；
   - 每条推送 TTL（对齐 F2 §6 的 60s 审批 TTL 语义——审批通知超过 TTL 未送达即可丢弃，由桌面端对账兜底）。

5. **连接池**：tokio + h2 复用长连接（APNs 建议保持连接减少握手），每 App 一个连接池、JWT 每小时轮换。

#### 2.2.4 海外版路径（可选保留）

- 海外发行若沿用 expo-notifications + exp.host：移动端 `getExpoPushTokenAsync` 换 token 上报——**发送器不变**（仍是 PushMessage schema），只是「厂商通道适配器」换成 exp.host API 客户端；
- 建议默认关闭：同一 PushMessage schema 下，发送器在构建期选择「APNs 直连」或「exp.host」，环境隔离（D7 §8.3 的 dev/prod 双通道机制复用）；
- 结论：**国内版 = APNs 直连；海外版 = exp.host 可选**，两个适配器实现 `VendorPushChannel` trait（D7 §9.2），上层无感知。

#### 2.2.5 iOS 通道决策小结

| 项 | 结论 |
| --- | --- |
| 通道 | APNs（直连，HTTP/2 + .p8） |
| 服务商 | 无（自建发送器，凭据自持） |
| 移动端 | expo-notifications `getDevicePushTokenAsync` 取原生 token；前台 handler/点击跳转/渠道全复用 |
| 风险 | .p8 凭据保管（OS 凭据库）；沙箱/生产环境切换（构建期）；审核侧「远程控制」用途声明（5.1.4） |

### 2.3 Android：FCM 不可用确认 + 厂商通道逐家（RN 集成方案）

#### 2.3.1 FCM 国内不可用（确认）

- **无 GMS**：国内销售的 Android 设备（除部分外贸机/刷机用户）无 Google Play Services，FCM token 无法获取；
- **网络不可达**：即便拿到 token，FCM 长连接到 Google 服务器在国内被墙（长期事实）；
- **Expo Push Service 连带不可用**：Android 侧 `getExpoPushTokenAsync` 依赖 FCM（D7 §5.9 核实），国内安卓走 exp.host 死路；
- **结论**：国内 Android 的离线兜底**只有厂商通道**这一条路，没有备胎。这是本方案 Android 侧全部设计的地基。

#### 2.3.2 厂商通道总览（服务端 REST 面）

| 通道 | 覆盖机型 | 服务端发送 API | 关键凭据 | 消息分类（保送达关键） | 配额/频控 | 真机验证状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 华为 HMS Push | 华为/荣耀（预装 HMS） | `POST /push/v1/{appId}/messages:send`（OAuth2 AT 换发） | App ID + App Secret | IM/服务提醒/营销（审批应走「服务提醒」高优） | 免费；营销频控 | D7 §10.5 必测 |
| 小米推送 | 小米/红米 | `POST https://api.xmpush.xiaomi.com/v3/message/regid`（Xiaomi 认证头） | AppId + AppSecret | 私信/订阅/提醒/兴趣/运营（审批走「私信/提醒」） | 免费；限流 | D7 §10.5 必测 |
| vivo 推送 | vivo/iQOO | `POST https://api-push.vivo.com.cn/message/send`（authToken 换发） | AppId + AppKey + AppSecret | 系统消息/运营消息（**系统消息需申请**） | 测试环境配额；正式需审核 | D7 §10.5 必测 |
| OPPO 推送 | OPPO/一加/realme | `POST https://api.push.oppo.com/server/v1/message/notification_unicast` | AppKey + MasterSecret | 私信/订阅/提醒/资讯/运营（审批走「私信」） | 正式环境单日配额（按应用等级） | D7 §10.5 必测 |
| 荣耀推送 | 荣耀（无 HMS 或验证失败） | 荣耀开放平台 REST（M2 验证项） | AppId + AppSecret | 同华为分类体系 | 免费 | D7 §10.5 验证项 |

> 注：各厂商 API 域名与路径以开发者平台最新文档为准（厂商接口演进频繁，落地时以各平台 2026 年文档复核；本表为 2026-08 共识事实）。

#### 2.3.3 RN 集成方案（移动端厂商 SDK）

**总原则**：Expo 生态对国产厂商通道**无官方支持**（D7 §5.2 核实），统一走「prebuild 出原生工程 + 自研 config plugin 注入 + Expo Module API 自研原生模块」路径；`expo-notifications` 只承担本地通知渲染/前台 handler/点击跳转（它不感知厂商通道）。

**逐家现状与方案**：

| 厂商 | RN 封装现状 | 本方案集成方式 | 工作量评估 |
| --- | --- | --- | --- |
| 华为 HMS | ✅ 官方 `@hmscore/react-native-hms-push`（npm 6.13.0-301，Apache-2.0，2026-06 活跃） | npm 安装 + 自写 withHmsPush config plugin（注入 agconnect-services.json + Gradle 依赖 + AndroidManifest Service 声明）；token 经 `HmsPushInstanceId.getToken()` | 低（官方插件 + 插件壳） |
| 小米 | ❌ 无官方 RN 封装（mipush SDK 为 Android 原生） | 自研 `withXiaomiPush` config plugin + 原生模块（Expo Module API：`XiaomiPushModule.getRegId()`/`onTokenReceived` 事件桥） | 中（原生模块 ~200 行 Kotlin） |
| OPPO | ❌ 同上 | 自研 `withOppoPush` + 原生模块（HePush SDK 集成） | 中 |
| vivo | ❌ 同上 | 自研 `withVivoPush` + 原生模块 | 中 |
| 荣耀 | ❌（华为插件仅限 HMS） | M2 验证 HMS 覆盖后决定；必要时自研 `withHonorPush`（SDK 与 HMS 同源） | 低-中 |
| 聚合商备选 | ✅ 个推 `@getui/react-native-getui`、极光 `jpush-react-native`（官方 RN 封装） | M1 提速备选（长尾厂商覆盖） | 低（但凭据/数据过第三方） |

**config plugin 设计（D4 §8.5 的落地细化）**——`apps/crish-mobile/plugins/withVendorPush.ts`：

```ts
// 伪代码：config plugin 职责（prebuild 时执行）
withVendorPush((config) => {
  // 1. 注入 Gradle 依赖（按构建渠道选择厂商）
  config = withDependency(config, { android: {
    'com.huawei.agconnect:agconnect-core': 'x.y.z',
    // 小米/OPPO/vivo 同理（com.xiaomi.push / com.heytap.msp / com.vivo.push）
  }});
  // 2. 复制厂商配置文件（华为 agconnect-services.json；小米无配置文件但需 gradle 插件）
  config = withCopyFile(config, { src: 'credentials/agconnect-services.json', dest: 'android/app/' });
  // 3. AndroidManifest 声明（各厂商 Service/Receiver + 权限）
  config = withAndroidManifest(config, (manifest) => {
    // 华为：com.huawei.hms.push.service.HmsMessageService + PROCESS_PUSH_MSG
    // 小米：com.xiaomi.mipush.sdk.PushMessageReceiver + PROCESS_MIPUSH_RECEIVER
    // OPPO/vivo 同构
    manifest.manifest.application.service?.push({...});
  });
  // 4. Application 早期初始化（华为要求：Application.onCreate 调 HmsInstanceId）
  config = withAppDelegate(config, { android: { kotlin: initSnippet } });
  return config;
});
```

**原生模块统一接口**（Expo Module API，`VendorPushModule.ts`）——三平台统一抽象的 Android 侧实现：

```ts
// 移动端统一推送接口（Android 厂商面，iOS 由 expo-notifications 承担）
export interface VendorPushModule {
  getToken(): Promise<string>;                       // 当前厂商 token（华为/小米/OPPO/vivo）
  onTokenReceived(cb: (token: string) => void): void; // token 轮换监听（厂商 SDK 事件桥）
  onMessageReceived(cb: (msg: VendorMessage) => void): void; // 透传消息监听（data-only）
  notifyForegroundHandled(): void;                   // 前台处理完成标记（防双显示）
}
```

**前台/后台双模式（D7 §7.3 的落地）**：
- 移动端在线（WS presence=active）时，服务端发**透传消息（data-only）**→ 原生模块 `onMessageReceived` → 应用内渲染（expo-notifications 本地通知路径，统一走前台 handler）；
- 移动端离线/后台 → 服务端发**通知消息（显示型）**→ 厂商系统直接展示；
- 服务端如何判定？——WS presence（D7 §4.5 状态机）；断连即按后台处理。

#### 2.3.4 厂商通道发送适配层（Rust 侧，`push/vendor/`）

每厂商实现 `VendorPushChannel` trait（D7 §9.2 定义），本方案给出接口冻结：

```rust
/// 厂商推送通道抽象（D7 §9.2 + M8 冻结）
#[async_trait]
pub trait VendorPushChannel: Send + Sync {
    /// 通道标识（hms/xiaomi/vivo/oppo/honor/apns）
    fn vendor_id(&self) -> &'static str;
    /// 发送单条推送（PushMessage → 厂商载荷映射在实现内完成）
    async fn send(&self, device: &PushDevice, msg: &PushMessage) -> Result<VendorSendResult, VendorError>;
    /// 批量发送（合并/节流由 dispatcher 层做，通道层只负责协议）
    async fn send_batch(&self, devices: &[PushDevice], msg: &PushMessage) -> Vec<VendorSendResult>;
}

/// 发送结果语义（统一各厂商返回）
pub enum VendorSendResult {
    Accepted,               // 已受理（厂商异步投递）
    DeviceNotRegistered,    // token 失效 → 注册表清理（D7 §6.4-3）
    RateLimited { retry_after: Option<Duration> }, // 限流
    Rejected { code: String, message: String },    // 参数/权限问题（审计不重试）
}
```

各厂商映射表（PushMessage → 厂商字段，D7 §6.2 扩展为可执行规范）：

| PushMessage 字段 | HMS | 小米 | vivo | OPPO |
| --- | --- | --- | --- | --- |
| title/body | `notification.title/body` | `title/description` | `title/content` | `title/content` |
| dedupeKey | `notification.tag`（替换式通知） | `extra.KEY_NOTIFY_ID` + tag 语义 | `notifyId`（同 id 替换） | `notifyId` |
| collapseKey | `notification.tag` | `extra.KEY_DESC` 或 channel 分组 | `groupID`（Android 7 分组） | `category` 分组 |
| severity/category | `notification.default_show_mode` + 分类（IM/服务提醒） | 消息分类（私信/提醒） | 消息类型（系统/运营） | `channel_id`（系统渠道） |
| data（白名单） | `data` 字段（4KiB 内） | `extra.KEY_CONTENT` JSON | `client_customized_content` | `notification.extra` JSON |

#### 2.3.5 Android 通道决策小结

| 项 | 结论 |
| --- | --- |
| 通道 | WS 直推（在线）+ 5 厂商通道（离线，HMS/小米/vivo/OPPO/荣耀） |
| 服务商 | 各厂商直连（自建发送器）；聚合商仅 M1 提速备选 |
| 移动端 | prebuild + 自研 config plugin + Expo Module API 原生模块；expo-notifications 承担呈现/跳转 |
| 保活 | **不依赖应用保活**——厂商通道是系统级投递，应用被杀仍可达（4.3 详述） |

### 2.4 HarmonyOS NEXT：华为推送服务 + RNOH 集成（D7 未覆盖面）

#### 2.4.1 现状事实（2026-08 网络查证 + 公开共识）

1. **鸿蒙 NEXT 是独立生态**：HarmonyOS NEXT（5.0 起，2024-10 商用）不再兼容 Android APK；应用以 HAP 包形态在华为应用市场分发；国内华为新机默认 NEXT。
2. **Expo 不支持鸿蒙**：Expo SDK 兼容矩阵仅 iOS/Android/Web/TV（1.4 查证 1）——**本项目的 Expo 移动端无法直接跑在 NEXT 上**。
3. **RNOH 社区方案存在**：React Native OpenHarmony（react-native-oh-library 组织，299 个适配仓库，1.4 查证 2）提供「RN 内核跑在鸿蒙」的社区维护实现（对应 RN 0.72-0.77 线，**未对齐 RN 0.86/Expo SDK 57**），鸿蒙版 App 需用 RNOH 工具链单独构建。
4. **华为推送服务覆盖 NEXT**：华为推送服务（Push Kit）对 NEXT 应用提供系统级推送（推送通知常驻通知中心，应用被杀仍可达），NEXT 应用通过 AppGallery Connect（AGC）开通，token 由 `pushService.getToken()`（ArkTS @kit.PushKit）获取，服务端发送走与 HMS Push 同域但独立的 REST API（OAuth2 AT + messages:send）。
5. **推送适配空白**：RNOH 生态未发现华为推送的现成适配包（1.4 查证 2）——需要自研 ArkTS 原生模块桥接。

#### 2.4.2 NEXT 推送通道定位（本方案裁决）

| 决策点 | 结论 |
| --- | --- |
| 是否纳入 M1-M2 | **否**——Expo 技术栈不可复用，需独立工程（RNOH 工具链 + ArkTS 原生模块），成本与 iOS/Android 量级相当 |
| 纳入阶段 | **M3**（与「中继服务代发」同期评估）：当华为 NEXT 用户占比达到产品阈值（建议 ≥15% 或用户明确要求）时立项 |
| 推送能力形态 | NEXT App（RNOH 或纯 ArkTS）内集成 Push Kit：token 注册进 push_tokens（platform=hms-next）；服务端复用同一 PushMessage schema + 同一发送适配层（新增 hms_next 通道实现） |
| 上架形态 | 华为应用市场 NEXT 专区（HAP 包 + AGC 签名 + 备案号）；**与 Android APK 版是两个应用实例**（包名/bundleId 不同） |

#### 2.4.3 RNOH 集成推送的方案设计（M3 落地时的蓝图）

```
鸿蒙 NEXT App（RNOH 工程）
  ├── RN 层（JS）：复用 protocol-core 推送 schema / 场景映射 / 跳转逻辑（纯 JS 面）
  ├── RNOH 桥层：RNOH 的 TurboModule 机制（community TurboModule 与 RN 0.72+ 同构）
  └── ArkTS 原生层（自研模块 com.crish.push）：
        ├── PushKitModule.ets   — 封装 @kit.PushKit：
        │     · init(context)                 // 初始化（AGC 配置）
        │     · getToken(): string            // pushService.getToken()
        │     · onTokenChange(cb)             // pushService.on('tokenChange')
        │     · onMessageArrive(cb)           // 透传/通知消息回调
        │     · requestPermission()           // 通知权限（NEXT 运行时权限）
        └── NotificationRenderer.ets — 本地通知渲染（NEXT 通知接口，渠道/重要性映射）
```

关键点：
1. **token 语义**：NEXT 的 push token 与 Android HMS token **不互通**（不同平台注册实例），push_tokens 表需按 `platform='hms-next'` 与 `platform='hms'` 区分（AC §6.3 的 platform 枚举扩展）；
2. **服务端发送**：新增 `hms_next` 通道实现（Rust），API 域与 HMS Push 相近但端点/鉴权以 NEXT 推送文档为准（落地时核实）；
3. **防双显示**：与 Android 同构——前台走透传 + 应用内渲染，后台走通知消息（2.3.3 双模式复用）；
4. **RNOH 版本线**：RNOH 对齐的 RN 版本落后于 Expo SDK 57（RN 0.86），鸿蒙工程是**独立分支**，不能与 Expo 工程共享原生层——共享面只限于 protocol-core 纯 JS 包（D8 §3.4 的协议包设计天然支持）；
5. **工作量估算**：RNOH 工程搭建 + 推送模块 + 深链路由 ≈ 4-6 周（单端）。

#### 2.4.4 NEXT 决策小结

| 项 | 结论 |
| --- | --- |
| 通道 | 华为推送服务 Push Kit（系统级，应用被杀可达） |
| 技术路线 | RNOH（RN 0.72-0.77 线）或纯 ArkTS；本方案建议 RNOH 复用 JS 面，原生推送模块自研 |
| 服务端 | 复用 PushMessage schema + vendor 适配层新增 hms_next |
| 阶段 | M3（与中继代发同期）【裁决修正 9：M3 阶段 → R5 鸿蒙；中继代发 → R4】 |
| 上架 | 华为应用市场 NEXT 专区（HAP + AGC 签名 + 备案号 + 隐私声明） |

### 2.5 三平台通道选型决策矩阵（汇总）

| 通道 | 平台 | 阶段 | 覆盖场景 | 发送方 | 移动端集成 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| WS 直推 | 全部 | M1 | 在线全量 | 桌面（局域网） | RN 内建 WS + 自研客户端 | 唯一全量通道 |
| APNs 直连 | iOS | M1 | iPhone 离线兜底 | 桌面（直连） | expo-notifications 原生 token | 不依赖 exp.host |
| exp.host | iOS（海外） | 可选 | 海外发行 | 桌面（exp.host 客户端） | 同上 | 仅海外版 |
| HMS Push | Android（华为系） | M1 | 华为/荣耀离线 | 桌面（直连） | 官方 RN 插件 + config plugin | 第一大厂商份额 |
| 小米推送 | Android（小米系） | M2 | 小米/红米离线 | 桌面（直连） | 自研原生模块 | 第二大份额 |
| vivo 推送 | Android（vivo 系） | M2 | vivo/iQOO 离线 | 桌面（直连） | 自研原生模块 | 需申请系统消息分类 |
| OPPO 推送 | Android（OPPO 系） | M2 | OPPO/一加/realme 离线 | 桌面（直连） | 自研原生模块 | 注意正式环境配额 |
| 荣耀推送 | Android（荣耀） | M2 验证 | 无 HMS 荣耀机型 | 桌面（直连） | 自研原生模块（或复用 HMS） | 先验证 HMS 覆盖 |
| 个推/极光 | Android 长尾 | M1 备选 | 三星/魅族/中兴等 | 第三方 | 官方 RN 封装 | 提速备选，M2 停用 |
| 华为 Push Kit（NEXT） | HarmonyOS | M3 | 华为 NEXT 设备 | 中继/桌面 | RNOH 自研原生模块 | 独立生态 |
| FCM | Android（海外） | 海外版 | 海外安卓 | 桌面（直连） | expo-notifications | 国内不可用 |

---

## 第 3 章 推送服务架构（核心交付 2）

### 3.1 推送注册：token 上报账号中心 push_tokens（AC 模块细化）

#### 3.1.1 双注册表职责分离（裁决）

| 注册表 | 位置 | 真源 | 职责 | 生命周期 |
| --- | --- | --- | --- | --- |
| device registry | 桌面端 SQLite（D7 §8.2） | 本地配对真源 | 配对关系、WS 在线状态、发送目标寻址（M1-M2 唯一发送依据） | 与配对绑定 |
| push_tokens | 账号中心（AC §6.3 新增表） | 云注册真源 | 跨设备 token 登记、设备管理 UI、M3 中继代发的发送依据 | 与账号会话绑定 |

**关系**：M1-M2 桌面直连发送时，发送器读**本地 device registry**（低延迟、无网络依赖）；M3 中继代发时，中继经账号中心查询 push_tokens。**双表字段同构**（platform/vendor_token/status），同步机制见 3.1.5——保证「桌面直连」与「中继代发」两条发送路径可随时切换而不丢注册状态。

#### 3.1.2 push_tokens 表结构（AC §6.3 的最终化版本）

AC 已给出表结构（account_id/device_id/platform/vendor_token/token_hash/bundle_id/app/status/last_registered_at/created_at/updated_at + 唯一约束 + 两索引）。本方案在 AC 版本上**追加两个字段**（标记 ★）：

```sql
-- AC §6.3 基础 + M8 追加（标记 ★ 的为追加字段）
CREATE TABLE IF NOT EXISTS push_tokens (
  id                  TEXT PRIMARY KEY,               -- pt_<uuid>
  account_id          TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  platform            TEXT NOT NULL,                  -- apns | hms | xiaomi | vivo | oppo | honor | fcm | hms-next ★
  vendor_token        TEXT NOT NULL,                  -- 厂商侧 device token（加密存储）
  token_hash          TEXT NOT NULL UNIQUE,           -- HMAC(vendor_token) 幂等键
  bundle_id           TEXT NOT NULL DEFAULT '',       -- 移动端应用标识（多 app 隔离）
  app                 TEXT NOT NULL DEFAULT 'crish',
  status              TEXT NOT NULL DEFAULT 'active', -- active | unregistered | expired
  last_registered_at  INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  expires_at          INTEGER,                        -- ★ token 过期时间（NULL=未知）
  last_seen_at        INTEGER,                        -- ★ 最后活跃（设备管理 UI 展示）
  UNIQUE(account_id, device_id, platform, bundle_id)
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_account ON push_tokens(account_id, status);
CREATE INDEX IF NOT EXISTS idx_push_tokens_device ON push_tokens(device_id, status);
CREATE INDEX IF NOT EXISTS idx_push_tokens_expiry ON push_tokens(status, expires_at); -- ★ 过期扫描
```

追加字段动机：
- `expires_at`：华为/小米等厂商 token 有轮换窗口（不保证永续），记录已知过期时间供主动刷新（3.1.4）；
- `last_seen_at`：设备管理 UI 的「最近活跃」列（对齐 AC A9「会话列表附推送状态」），也是 M3 节流输入。

#### 3.1.3 push_tokens 端点（AC 4 端点 + M8 追加 2 端点）

| 方法 | 路径 | 鉴权 | 语义 | 来源 |
| --- | --- | --- | --- | --- |
| POST | /api/push/tokens | Bearer | 注册/更新（幂等：token_hash 冲突则更新 status=active + last_registered_at） | AC 既有 |
| DELETE | /api/push/tokens/:id | Bearer | 解绑（登出/卸载；接受 vendorToken 反查） | AC 既有 |
| GET | /api/push/tokens | Bearer | 列出本账号全部注册（设备管理 UI） | AC 既有 |
| POST | /api/push/tokens/:id/unregister | Bearer | 标记 unregistered（DeviceNotRegistered 回报） | AC 既有 |
| POST | /api/push/tokens/refresh | Bearer | **★ token 过期刷新**：厂商 token 轮换时上报新 token，幂等更新 | **M8 追加** |
| GET | /api/push/tokens/lookup | AUTH_SERVICE_TOKEN | **★ 发送方查询**：M3 中继代发时按 accountId/app/platform 批量查有效 token（服务间调用） | **M8 追加** |

#### 3.1.4 token 过期与刷新策略

| 场景 | 触发 | 处理 | 责任方 |
| --- | --- | --- | --- |
| 厂商 token 主动轮换（HMS/小米在 token 失效前推送新 token） | 移动端 `onTokenReceived` 事件 | 移动端立即 POST /api/push/tokens/refresh（幂等）；同时更新桌面 device registry（若在配对状态） | 移动端 |
| 设备长期未启动导致 token 失效 | 发送时收到 DeviceNotRegistered | 发送器标记 unregistered（AC 端点）；桌面 registry 移除；下次移动端启动重新注册时恢复 active | 发送器（桌面/中继） |
| token 未知过期（expires_at 无值） | 每周体检 | 服务端对「active 且 expires_at 距今 > 90 天或为 NULL」的设备发静默推送（P3「token 体检」），无响应则标记疑似失效 | 账号中心定时任务 |
| 用户撤销设备 | 设备管理 UI 删除设备 | AC A3 联动：撤销会话 + unregister 推送 + 吊销中继凭据（AC §6.2 A3） | 账号中心 |

**幂等铁律**：refresh 用 token_hash 幂等（同 token 并发上报只更新一次）；unregister 用 device_id 反查（卸载重装竞态由 UNIQUE 约束 + upsert 语义消化）。

#### 3.1.5 双注册表同步（桌面 device registry ↔ 云 push_tokens）

| 同步方向 | 触发 | 机制 |
| --- | --- | --- |
| 桌面 → 云 | 配对成功 / token 轮换 | 桌面在有云账号时上报 POST /api/push/tokens（设备名/平台/厂商 token 三件套）；无账号时跳过（本地直连模式不需要云注册） |
| 云 → 桌面 | 登录后首次 / 每 24h | 桌面拉取 GET /api/push/tokens 与本地 registry 对账：云端有而本地无 → 本地补登记；本地有而云端无 → 补上报 |
| 撤销联动 | 任一侧撤销 | 两侧同时更新（本地删 registry 行，云端 DELETE token）——**不要求强一致**：发送侧以本地为准（M1-M2），云侧状态允许滞后（M3 前无发送路径消费它） |

**结论**：同步是「尽力而为 + 幂等」模型，不引入分布式事务；消费侧（发送器）在任何时刻只依赖一端。

#### 3.1.6 发送方查询接口（【裁决修正】P2-4：M2 中继代发消费面）

```
GET /api/push/tokens/lookup?accountId=acc-1&app=crish&platform=hms
  → 200 { "tokens": [ { "deviceId": "dev-9", "platform": "hms", "vendorToken": "enc:...", "bundleId": "com.crish.mobile" } ] }
```

- 服务间调用（AUTH_SERVICE_TOKEN，AC §6.4 同款机制）；
- **只返回 status=active 且未过期**的 token；分页（100/页）；
- vendorToken 返回密文，中继发送前解密（与账号中心加密存储配套，AC §6.3 安全要点）；
- 该接口是「中继代发」与「桌面直连」的**切换阀门**：桌面直连时发送器不查云（本地 registry 足够）；桌面离线 → 中继接管时按此接口取注册。

#### 3.1.7 移动端 token 注册生命周期（完整时序）

```
移动端启动
  → 厂商 SDK 初始化（config plugin 注入的 Application 早期初始化）
  → getToken() 取厂商 token
  → expo-notifications getDevicePushTokenAsync 取 APNs token（iOS）
  → 组装 { deviceId(本地生成), platform, vendorToken, bundleId }
  → 本地存 token（expo-secure-store，Keychain/Keystore）
  → 若有云账号：POST /api/push/tokens（幂等 upsert）
  → 若在配对状态：WS pair-request 携带 pushToken 上报桌面（D7 §4.5a 阶段一）
  → 注册 onTokenReceived 监听（token 轮换 → 重复上述上报）
  → 注册 onMessageReceived 监听（透传消息）
```

### 3.2 推送触发链路（事件 → 决策引擎 → 双轨分发）

#### 3.2.1 链路总览

```
引擎 41 事件（events.rs:306-782）
  │  emit（core_event_bridge.rs:51-145，workbench-run-event）
  ▼
PushAwareEmitter（D7 §9.2 方案 a：Emitter trait 装饰器）
  │  ── 转发原通道（行为不变）
  ▼
push-core 决策引擎（apps/agent-workbench/src-tauri/src/push/core.rs）
  ├─ 1. push_intent(event) → Option<PushIntent>   （D7 §3.2 全量筛选表）
  ├─ 2. coalesce(pending) → Vec<PushIntent>       （D7 §3.4.2 合并规则）
  ├─ 3. quiet_hours_filter(intent, tz) → Policy   （D7 §3.4.3 静默时段）
  ├─ 4. throttle(device, intent) → 放行/折叠       （D7 §3.4.4 节流）
  ├─ 5. render_copy(intent) → {title, body}       （D7 §6.5 push/copy.rs）
  ▼
PushMessage 组装（schema v1，D7 §6.2）
  ▼
分发决策（presence 表，D7 §6.4）
  ├─ connected+active      → 仅 WS 直推
  ├─ connected+background  → WS 直推
  ├─ offline               → 厂商通道（摘要级）
  └─ 审批类例外             → 双发（WS + 厂商，展示层去重）
  ▼
双轨发送
  ├─ WS 直推（复用协议面 events.push，M6 DeviceEnvelope【裁决修正 2：原「WS 中继 relay.rs，D7 §4.5a 协议」作废】）
  └─ VendorPushDispatcher（vendor trait 实现 × N 厂商，并发 4/退避重试）
```

#### 3.2.2 推送协议进 protocol-core（D8 衔接）

D8 §3.4 规划了 `packages/protocol-core`（协议注册表 `contracts/mobile-protocol.json` + 生成器 `generate-protocol-bindings.mjs`）。本方案把 **PushMessage schema 纳入协议注册表首批消息面**：

| 注册表条目 | 内容 | 消费者 |
| --- | --- | --- |
| PushMessage | schema v1 全字段（D7 §6.2 表） | 桌面 Rust（对拍测试）、移动端 TS（zod + parser 生成） |
| PushTarget | screen 枚举（approval/session/subagent/task/timer/audit/home）+ params | 移动端深链路由（4.1） |
| PushAck | id + dedupeKey（WS ack 载荷） | 桌面 relay、移动端 WS 客户端 |
| NightSummary | 夜间摘要合成消息 | 桌面 push-core、移动端展示 |

- 生成器输出 TS 类型 + zod schema + parser（D8 §4.3 模式）；
- Rust 侧不手写双份：`push/schema.rs` 用同一注册表 JSON 生成的夹具做对拍测试（D8 §5.3 协议对拍门禁）；
- **版本演进**：PushMessage 字段变更走协议版本规则（D8 §7.3：schemaVersion 单调递增 + minProtocolVersion 握手协商），与商店版本解耦。

#### 3.2.3 事件 → 推送意图的实现落点（41 变体 → 18 场景）

> 【裁决修正 4】本节 S1-S12 表（18 行）为推送场景级别唯一真源；标题中「13 场景」
> 为旧口径（D7/M6 已同步为 18）。

| 场景 | 事件变体（events.rs 行号） | push_intent 返回 | 落点模块 |
| --- | --- | --- | --- |
| S1 审批请求 | approval-requested（:479-484） | P0 + approval 登记 | push/core.rs + push/approve.rs |
| S2 审批过期 | approval-resolved（:487-495）decision=Expired | P0 补推 + 停止重推 | push/approve.rs |
| S3 run 完成 | run-terminal（:511-519）Completed | P1 | push/core.rs |
| S4 run 失败 | run-terminal Failed + error | P0 | push/core.rs |
| S5 run 取消 | run-terminal Cancelled | P1 | push/core.rs |
| S6 子代理完成 | subagent-ended（:615-626）Completed | P1 | push/core.rs |
| S7 子代理失败 | subagent-ended Failed | P0 | push/core.rs |
| S8a 任务启动 | task-started（:635-648）is_daemon | P2 | push/core.rs |
| S8b 任务完成 | task-completed（:690-701） | P1 | push/core.rs |
| S8c 任务卡死 | task-suspicious（:677-687） | P0 | push/core.rs |
| S8d 任务失败 | task-failed（:703-715） | P0（tail 截断入正文） | push/core.rs |
| S8e 任务终止 | task-killed（:718-728）非用户主动 | P1 | push/core.rs |
| S9a 定时器 | timer-fired（:737-746） | P1（prompt 为正文） | push/core.rs |
| S9b cron | cron-fired（:768-781） | P1 | push/core.rs |
| S10a 运行异常 | runtime-error（:453-460） | P0（run-failed 先行提示，30min 去重窗） | push/core.rs |
| S10b 需介入 | runtime-intervention-required（:470-477） | P0（choices 摘要） | push/core.rs |
| S11 安全拦截 | security-audit（:559-577）decision∈{blocked,purged} | P0 | push/core.rs |
| S12 缓存告警 | cache-waste-alert（:532-543） | P2 | push/core.rs |
| 其余 23 类 | （对照 D7 §3.2 全量表） | P3 不推 | — |

#### 3.2.4 推送队列与持久化（与事件背压对齐）

| 队列 | 语义 | 丢/存策略 |
| --- | --- | --- |
| tokio mpsc 推送队列 | push-core → dispatcher/relay | 满时 P0 不可丢（阻塞或落 SQLite 待发表），P1/P2 可丢（记计数） |
| push_pending_approvals（SQLite） | 审批待发表 + 重推阶梯（D7 §9.3） | 持久化，桌面重启后恢复扫描 |
| push_events_dedupe（SQLite） | 去重表 24h TTL | 审批键持久化，其余内存可丢 |
| push_night_summary（SQLite） | 夜间摘要折叠表（D7 §3.4.3） | 持久化（次日 07:30 生成后清理） |

### 3.3 桌面直推 vs 中继服务代发（裁决：核心架构决策）

#### 3.3.1 问题的本质

D7 §4.1 的三路线中，路线 B（厂商通道）存在一个**发送方位置二选一**的问题：厂商 REST API 由谁调用？
- **方案 ① 桌面直连**：桌面进程内 vendor dispatcher 直调各厂商 API（D7 默认设计）；
- **方案 ② 中继代发**：桌面事件 → HTTPS → 云中继 → 中继调厂商 API（D1 §3.3 中继 + AC §9 风险 8 的开放项）。

#### 3.3.2 评估矩阵

| 维度 | 方案 ① 桌面直连 | 方案 ② 中继代发 |
| --- | --- | --- |
| 桌面在线依赖 | **依赖**——桌面关机/睡眠/断网 = 推送断源 | **不依赖**——事件先到云，云负责发送（桌面离线也能推） |
| 实现成本 | 低——在既有 push-core 内加 vendor dispatcher | 高——云服务（中继 + 发送器 + token 注册表 + 鉴权），AC 评估账号侧 15-20 人日 + 中继 6 人日 |
| 凭据安全 | 厂商 AppId/Secret 存桌面端（OS 凭据库） | 凭据存云（攻击面转移，需更严的密钥管理） |
| 隐私 | 事件摘要不出局域网（厂商通道本就要过厂商服务器，但**不经过自己控制的第三方云**） | 事件摘要过自建云（可控，但多一跳） |
| 延迟 | 秒级（桌面 → 厂商 API 直连） | 秒级 + 云一跳（略增） |
| 失败面 | 桌面单点（崩溃/重启丢推送——审批已用持久化兜底） | 云服务可用性 SLA（依赖账号中心/中继运维） |
| 与账号体系关系 | 无（本地配对即可工作） | **必须云账号**（中继要区分用户） |
| 多桌面/多设备演进 | 单桌面 N 设备（D7 §4.6） | 多桌面多账号（未来） |
| 与 D1 架构契合 | 一期（P1-P2 无云账号铁律：D1 §4.5） | M3（云中继兜底） |
| 运维成本 | 0 | 服务器/域名/备案/监控 |

#### 3.3.3 裁决（综合 D1/AC/D7 三份输入）

**裁决：一期（M1-M2）桌面直连；M3 中继代发作为演进，两者接口隔离、可无缝切换。**

理由（三条硬依据）：

1. **D1 铁律**：D1 §4.5「P1-P2 不依赖云账号」+ AC §5.4「桌面功能不依赖账号中心」——中继代发强依赖账号中心，违反一期「云账号可选」的边界；
2. **成本结构**：桌面直连把「厂商通道」做成纯客户端能力（零服务器、零备案、零运维）；中继代发需要账号侧 15-20 人日 + 中继 6 人日 + 运维——这笔成本应花在「桌面离线」这个更高价值场景上（M3），而不是一期就背上；
3. **接口隔离已铺好**：D7 的 `VendorPushChannel` trait + PushMessage schema 与发送方位置无关；AC 的 push_tokens 表为云侧发送预留了查询接口（3.1.6）——M3 时把「桌面事件 → 云」接上即完成切换，**桌面直连代码零废弃**（保留为「中继不可用时的降级路径」）。

**M3 切换形态**：

```
桌面离线场景（M3 起）：
  桌面（在线时）→ 事件摘要 HTTPS → 中继服务（缓冲待发）
  → 移动端离线判定（中继维护 presence）
  → 中继经 push_tokens 查询 → vendor 适配层（复用同一 trait）→ 厂商 API → 手机
桌面在线时（M3 仍走直连）：presence 判定后仍由桌面直推（省云一跳、省配额）
```

**双模式共存规则**：同一事件在「桌面在线」与「桌面离线」两态切换的竞态，由**发送幂等**消化（PushMessage.id 全局唯一 + 移动端 dedupeKey 展示层去重，D7 §6.4-2）。

#### 3.3.4 裁决的影响面

| 章节 | 影响 |
| --- | --- |
| 3.1 推送注册 | M1-M2 只维护本地 device registry + 云 push_tokens 尽力同步；M3 起云侧成为发送依据 |
| 4.3 进程保活 | 厂商通道兜底能力与发送方位置无关（系统级投递），本裁决不影响移动端 |
| 第 5 章 商店发布 | 无影响（发送器位置不改变商店要求） |
| 第 8 章 阶段 | M3 内容 = 中继服务 + 账号集成 + 鸿蒙 NEXT，三者打包评估 |

### 3.4 去重/合并/静默时段工程化（D7 场景清单落地）

D7 §3.4 已给出去重键设计/合并规则表/静默时段/节流护栏。本方案给出**工程化实现规范**（供实现任务书直接取用）：

#### 3.4.1 去重（dedupe）实现规范

```rust
/// 去重键构造（D7 §3.4.1：{eventType}:{业务键}）
/// 落点：push/core.rs，与 push_events_dedupe 表配套
pub fn dedupe_key(event_type: &str, biz_key: &str) -> String {
    format!("{event_type}:{biz_key}")
}
// 业务键规则：
// approval-requested:{toolCallId}   ← PermissionRequest.tool_call_id（events.rs:198）
// approval-resolved:{toolCallId}    ← 同上（expired 子集）
// run-terminal:{runId}[:failed]    ← RunTerminal.run_id（events.rs:513）
// subagent-ended:{subagentId}       ← SubagentEnded.subagent_id（events.rs:586）
// task-failed:{taskId} / task-suspicious:{taskId} / task-completed:{taskId}
// timer-fired:{timerId} / cron-fired:{cronId}
// security-audit:{toolCallId 或事件序号}
// cache-waste-alert:{runId}
// night-summary:{YYYY-MM-DD}
```

**去重存储两级**：
- 内存 Map（TTL 24h）：P1/P2 级（重启丢失可接受）；
- SQLite `push_events_dedupe` 表（D7 §8.2）：审批键（P0）必须持久化——审批重推阶梯与去重表互斥（重推不走去重键，走 approval_id 幂等）。

#### 3.4.2 合并（coalesce）实现规范

合并规则表（D7 §3.4.2）实现为 `coalesce(pending: Vec<PushIntent>) -> Vec<PushIntent>` 纯函数，窗口用注入时钟（可测）：

| 合并窗口 | 规则 | 产出 |
| --- | --- | --- |
| 60s | run-terminal + 前 60s subagent-ended(Completed) | 「run 完成，含 N 个子代理」 |
| 60s | 同 batch 多条 approval-requested（同一 batch_id） | 「N 项操作待批准」 |
| 10min | 同 session 多条 task-failed | 「N 个后台任务失败」 |
| 10min | 同 cron_id 多次 cron-fired | 「cron 已触发 N 次」 |
| 10min | task-suspicious 后 task-failed | 只推 failed（卡死已失败） |

**厂商通道侧系统级合并叠加**（D7 §3.4.2）：Android `tag = dedupeKey`（替换展示，避免刷屏）；iOS `threadId = collapseKey`（分组堆叠）。

#### 3.4.3 静默时段实现规范

| 项 | 规范 |
| --- | --- |
| 默认窗口 | 22:30-07:30（用户可配，分钟级粒度，支持按工作日/周末分别配置） |
| 时区 | 移动端注册时上报 timezoneOffsetMinutes（D7 §4.5a pair-request 已带）→ 桌面按该时区判定；移动端展示层本地二次判定「响不响」（D7 §4.3-4 双层职责） |
| P0 | 静默时段仍发（可选静音：移动端本地按 channel 音量策略决定） |
| P1 | 静默时段不立即发 → 折叠进夜间摘要表（push_night_summary，按 day 分桶） |
| P2 | 静默时段不推 |
| 夜间摘要 | 次日 07:30（用户配置的静默结束时间）生成一条 night-summary 推送（dedupeKey=night-summary:{date}） |

#### 3.4.4 节流实现规范

| 护栏 | 规则 | 超限行为 |
| --- | --- | --- |
| 厂商通道频控 | 同 device 每分钟 ≤ 2 条、同 session 每 10 分钟 ≤ 3 条 | 超出合并为摘要 |
| 每日总量 | 单 device 每日 ≤ 50 条 | 超出折叠为日报 |
| 审批重推 | 15min → 60min → 每小时 ×5 最多 5 次（D7 §3.3 S1） | 审批过期后停止 + 补推「已过期」 |
| 发送器并发 | 每厂商 1 worker、全局 4 并发（D7 §6.6） | 队列背压（P0 持久化不丢） |

### 3.5 中继服务代发的演进蓝图（M3 承接 AC §6.4）

#### 3.5.1 组件与角色（AC §6.1 架构图的推送细化）

```
┌─────────────────────────────────────────────────────────────┐
│ 账号中心（flowbit-auth / zennav-server）                      │
│  · push_tokens 注册表（3.1.2）                                 │
│  · relay_credentials 签发/校验（AC §6.4）                     │
└───────────────┬─────────────────────────────┬───────────────┘
                │ HTTPS（AUTH_SERVICE_TOKEN）  │ HTTPS（Bearer）
                ▼                             ▼
┌──────────────────────────────────────────┐  ┌───────────────────────────┐
│ 中继服务（Rust：axum + tokio-tungstenite） │  │ 桌面端（直连模式，M1-M2）    │
│  · RelayLink 转发（D1 §3.3 只转发不解密）   │  │  · push-core + vendor     │
│  · 推送代发：事件摘要缓冲 → push_tokens    │  │  · vendor dispatcher 直连  │
│    查询 → vendor trait 发送（复用同实现）   │  └───────────────────────────┘
│  · presence 维护（移动端在线状态）          │
└──────────────────────────────────────────┘
```

#### 3.5.2 M3 推送代发的消息流

```
桌面（在线时）
  → 事件 → push-core → 生成 PushMessage
  → 摘要级副本 HTTPS → 中继（persist 待发队列，dedupeKey 幂等）
  → 桌面直连发送（若移动端在线）——本地路径优先
移动端离线时：
  → 中继 presence 判定 offline
  → 查询 push_tokens（3.1.6 lookup 接口）
  → vendor trait 发送（HMS/小米/vivo/OPPO/荣耀/APNs/NEXT）
  → DeviceNotRegistered → 回写 unregister（AC 端点）
桌面离线时（关机/断网）：
  → 中继在桌面心跳超时（30s）后接管：对缓冲的 P0 消息补发
  → P1/P2 在静默策略内按正常规则（中继复用同一套 quiet_hours 纯函数）
```

#### 3.5.3 中继的推送职责边界（严格）

| 中继做 | 中继不做 |
| --- | --- |
| 事件摘要缓冲（推送是摘要级，不缓冲对话全文） | 解密业务载荷（D1 §3.3：端到端加密，中继只见密文/摘要） |
| presence 维护（在线/离线判定，对齐 D7 §4.5 状态机语义） | 事件筛选（push_intent 在桌面 push-core 做；中继只消费已生成的 PushMessage） |
| 静默时段/节流复用（同一纯函数库） | 文案生成（push/copy.rs 在桌面做） |
| DeviceNotRegistered 回写 | 审批重推阶梯（仍由桌面 push/approve.rs 扫描——桌面在线时）；**桌面长期离线时中继降级为「只发一轮」**（开放问题 9.3） |

---

## 第 4 章 推送客户端（核心交付 3）

### 4.1 三平台统一抽象：notification 到达 → 解析 → 场景映射 → 跳转

#### 4.1.1 统一抽象层（移动端 `src/notifications/`）

```
src/notifications/
  ├── types.ts            # PushMessage / PushTarget（protocol-core 生成产物 re-export）
  ├── registry.ts         # 通知来源注册（WS 直推 / 厂商通道 / APNs）
  ├── router.ts           # target.screen → 深链路由映射（纯函数，可单测）
  ├── presenter.ts        # 通知呈现决策（前台/后台/静默时段/渠道音量）
  └── index.ts            # 初始化入口（监听注册 + 冷启动处理）
```

三平台统一处理链路（**同一套 JS 逻辑**，平台差异收敛在薄适配层）：

```
通知到达（三来源之一）
  │
  ▼ normalize() —— 归一化为 PushMessage 形态
  │   · WS 直推：完整 PushMessage（JSON 已解析）
  │   · 厂商通道：NotificationResponse.data（厂商 payload 反序列化 → PushMessage 子集）
  │   · APNs：NotificationResponse.data.crish（同上）
  ▼ parse() —— protocol-core parser 校验（zod，非法载荷降级为通用提示）
  ▼ map() —— target.screen → 路由（router.ts，纯函数）
  │   approval → /approval/[toolCallId]
  │   session  → /session/[sessionId]
  │   subagent → /subagent/[subagentId]
  │   task     → /task/[taskId]
  │   timer    → /timer/[timerId]
  │   audit    → /audit
  │   home     → /（首页/通知中心）
  ▼ present() —— 呈现决策（presenter.ts）
  │   · 前台 + 用户在目标页 → 静默更新（不弹横幅）
  │   · 前台 + 其他页 → P0 横幅（assertive）/ P1 横幅（polite 可选）/ P2 角标
  │   · 后台/被杀 → 交给系统通知中心（已展示）→ 点击后走冷启动路径
  ▼ respond() —— 点击 → 深链路由（expo-router）
  │   · 冷启动：useLastNotificationResponse 取回 → 路由直达
  │   · 热启动：addNotificationResponseReceivedListener → 路由
  ▼ hydrate() —— 若需全量数据：WS 拉取（在线）或摘要展示（离线，D7 §7.4 契约）
```

#### 4.1.2 深链协议（与 D4 §3.4 expo-router 对齐）

```
深链格式：crish://<screen>/<id>?<params>
示例：
  crish://approval/tc-9f3a
  crish://session/s-7?runId=run-42
  crish://task/t-11
```

- **跳转参数只依赖 data.target**（不解析 title/body 文案——文案可变、参数稳定，D7 §7.4 契约）；
- expo-router typed routes：`app/approval/[toolCallId].tsx` 等路径天然成为深链目标（D4 §3.4）；
- 未知 screen / 参数缺失 → 兜底跳首页 + 通知中心角标（不崩溃）。

#### 4.1.3 场景映射表（target.screen 全枚举，D7 §7.4 的 TS 化）

```ts
// protocol-core 生成（contracts/mobile-protocol.json → generated/）
export const SCREEN_ROUTES = {
  approval: '/approval/[toolCallId]',   // 需 params.toolCallId
  session:  '/session/[sessionId]',      // 需 params.sessionId；可选 params.runId
  subagent: '/subagent/[subagentId]',
  task:     '/task/[taskId]',
  timer:    '/timer/[timerId]',
  audit:    '/audit',
  home:     '/',
} as const;
export type PushScreen = keyof typeof SCREEN_ROUTES;
```

### 4.2 通知权限引导流程

#### 4.2.1 三平台权限模型

| 平台 | 权限名 | 触发方式 | 特殊约束 |
| --- | --- | --- | --- |
| iOS | 通知（alert/badge/sound） | `requestPermissionsAsync`（expo-notifications） | `ios.status` 五态判定（NOT_DETERMINED/DENIED/AUTHORIZED/PROVISIONAL/EPHEMERAL，D7 §7.5）；支持 PROVISIONAL（静默授权，横幅可绕过弹窗） |
| Android 13+ | POST_NOTIFICATIONS | 系统弹窗（`requestPermissionsAsync`） | **必须先创建至少一个通知渠道**（D7 §7.5 铁律）；Android 8+ 渠道级开关是最后一层防打扰 |
| HarmonyOS NEXT | 通知权限（运行时） | 系统弹窗（PushKit.requestPermission） | NEXT 通知权限模型与 Android 类似；厂商消息分类开关 |

#### 4.2.2 引导时机与文案（对齐 D7 §7.5）

| 时机 | 文案要点 |
| --- | --- |
| 配对完成后 | 「允许 Crish 发送通知？审批请求不会漏」——**首次审批请求是天然引导点**（配对后第一次 approval-requested 到达前） |
| 首次 P0 推送前 | 若权限未授权，展示应用内引导卡（说明推送价值：审批/任务失败/安全拦截） |
| 用户拒绝后 | 引导到系统设置（iOS：UIApplication.openSettingsURLString；Android：expo-notifications 的 openNotificationSettingsAsync；厂商 ROM 另有应用详情页） |
| 设置页 | 「通知偏好」入口：渠道级开关镜像（approval/run/subagent/task/timer/security/summary 七渠道，D7 §7.7） |

#### 4.2.3 引导前置条件（顺序铁律）

```
1. 创建通知渠道（应用启动即建，七渠道，D7 §7.7 表）
2. 请求权限（渠道存在后系统弹窗才会出现）
3. 获取 token（权限后获取——iOS 上 APNs token 依赖授权）
4. 注册 token（3.1.7 生命周期）
```

### 4.3 Android 厂商通道的进程保活问题（WS 长连接被杀 → 推送兜底的意义）

#### 4.3.1 问题陈述

国内 ROM 对应用后台进程的清杀策略激进（MIUI/ColorOS/OriginOS 省电策略 + 用户手动清杀），**WS 长连接必然被杀**：
- 前台：WS 在线（全量数据面）；
- 后台 5-10 分钟：多数 ROM 冻结/杀死进程 → WS 断开 → 在线通道失效；
- 用户手动清杀：进程消失 → 唯一可靠通道只剩**厂商系统级推送**。

#### 4.3.2 架构结论（推送兜底的意义）

**不追求应用保活，接受 WS 被杀的常态，把「离线」作为默认状态设计**：

| 层面 | 设计 |
| --- | --- |
| 在线判定 | WS presence 超时（30s 心跳）即判 offline（D7 §4.5）——**不依赖系统保活回调** |
| 离线兜底 | 厂商通道系统级投递（应用被杀仍可达）——这是「审批不能漏」的物理保障 |
| 不做 | 不做前台 Service 常驻、不做厂商「自启动」引导（**反合规反体验**：国内商店 2024 起严查应用保活行为，华为/小米商店拒绝「后台常驻 + 自启动」类应用上架） |
| 可做（可选） | 引导用户开启「应用忽略电池优化」/「允许后台活动」——仅作为高级设置项，默认不引导（防商店审核风险） |
| 兜底边界 | 厂商通道只带摘要 + 跳转参数（D7 §6.3）——被杀的进程重启后（冷启动）经深链直达目标页 |

#### 4.3.3 被杀死态的处理链路（与 D7 §7.3 对齐）

```
厂商推送到达（应用被杀）
  → 系统通知中心展示（摘要级）
  → 用户点击 → 冷启动 → useLastNotificationResponse 取回 notification
  → 解析 data.target → 路由直达（4.1）
  → 若需全量数据：WS 重连拉取（桌面在线时）或显示摘要（离线时）
```

#### 4.3.4 厂商通道进程语义（不依赖应用进程的原因）

| 厂商 | 投递进程 | 应用被杀是否可达 | 说明 |
| --- | --- | --- | --- |
| 华为 HMS | HMS Core 系统服务 | ✅ | 通知消息由 HMS Core 常驻进程展示，不依赖 App 进程 |
| 小米 | 小米推送服务 | ✅ | 系统级 |
| vivo/OPPO | 厂商推送服务 | ✅ | 系统级 |
| 荣耀 | 荣耀推送服务 | ✅ | 系统级 |
| iOS APNs | SpringBoard/通知中心 | ✅ | 系统级 |

**结论**：厂商通道是「应用进程被杀仍可达」的唯一保障，这也是为什么「离线兜底」必须是架构一等公民（3.3 裁决的地基）。

### 4.4 iOS / 鸿蒙差异（D7 §7.6 的扩展）

| 维度 | iOS | Android（国内） | HarmonyOS NEXT |
| --- | --- | --- | --- |
| 系统通道 | APNs（国内可用） | 厂商通道（5 家） | 华为推送服务 Push Kit |
| 推送服务 | 自建直连 APNs（2.2） | 自建逐厂商 REST（2.3） | 自建 hms_next 适配（2.4） |
| 前台通知 | `setNotificationHandler` 全可控 | 厂商通知消息由系统直接展示（透传双模式，2.3.3） | 同 Android（透传双模式） |
| 通知渠道 | 无 channel，`threadId` 分组 | Android 8+ channel（D7 §7.7 七渠道） | 通知渠道（API 类似 Android） |
| 静默推送 | contentAvailable + 后台任务（节流严格） | 厂商透传消息 | 厂商透传消息 |
| 权限 | 系统设置 + PROVISIONAL 可选 | Android 13+ 运行时弹窗 + 渠道开关 | 运行时弹窗 + 分类开关 |
| 角标 | badge 完整 | 部分 launcher 支持 | 支持 |
| 点击恢复 | `useLastNotificationResponse` | 同左（Expo 统一 API） | RNOH 自研桥接 |
| 锁屏正文隐藏 | iOS 设置 | 各厂商 ROM 设置（引导） | 系统设置 |

---

## 第 5 章 应用商店发布（核心交付 4）

### 5.0 商店矩阵总览

| 商店 | 平台形态 | 上架要求（概要） | 国内必需？ | 对应章节 |
| --- | --- | --- | --- | --- |
| App Store（中国区） | iOS .ipa | 开发者账号 99$/年、签名、审核（远程控制类重点审查） | **必需**（iOS 唯一分发渠道） | 5.1 |
| Google Play | Android .aab | 25$ 一次性、Data Safety、targetSdk 36 | 可选（海外版） | 5.2.1 |
| 华为应用市场 | Android .apk + HarmonyOS NEXT .hap | AGC 账号、实名认证、备案号、软著/版号（按类目）、隐私声明 | **必需** | 5.2.2、5.3 |
| 小米应用商店 | Android .apk | 开发者认证、备案号、隐私声明、权限声明 | **必需** | 5.2.3 |
| OPPO 软件商店 | Android .apk | 同上 + 部分类目审核 | **必需** | 5.2.3 |
| vivo 应用商店 | Android .apk | 同上 | **必需** | 5.2.3 |
| 应用宝（腾讯） | Android .apk | 同上 + 需要软著（部分类目） | **必需** | 5.2.3 |
| 荣耀应用市场 | Android .apk | 同华为系 | M2 后（覆盖荣耀机型） | 5.2.3 |

> 注：上架要求以各商店开发者平台现行规则为准（商店政策频繁调整，本表为 2026-08 共识；关键硬性项——备案号、实名认证、隐私政策、权限声明——已在 6.1-6.3 展开）。

### 5.1 iOS：App Store（中国区）

#### 5.1.1 开发者账号与签名

| 项 | 要求 | 备注 |
| --- | --- | --- |
| 开发者账号 | Apple Developer Program（个人或公司），99 美元/年 | 中国区开发者需实名（营业执照/身份证） |
| 证书 | Development + Distribution 证书；APNs AuthKey（.p8，2.2.3 用） | EAS 云构建代管（D8 §7.2） |
| Profile | Ad Hoc（真机测试）/ App Store（发布） | EAS 管理 |
| Bundle ID | `com.crish.mobile`（与 Android 包名不同，推送按 bundle 隔离） | push_tokens.bundle_id 字段（3.1.2） |

#### 5.1.2 TestFlight 灰度路径

| 阶段 | 人数 | 有效期 | 用途 |
| --- | --- | --- | --- |
| 内部测试（Internal） | ≤ 100 人（团队账号） | 30 天/构建 | 开发与 QA |
| 外部测试（External） | ≤ 10,000 人 | 90 天/构建 | 公测与灰度（Beta App Review 一次通过后免审 90 天） |

- 版本灰度：TestFlight 外部测试分组（按比例/按名单）→ 观察推送到达率/崩溃率 → 再提审 App Store；
- **推送联调**：TestFlight 构建的 APNs 环境是生产环境（沙箱测试用 Development profile 的 Ad Hoc 构建）——测试矩阵（7.1）需注明环境。

#### 5.1.3 提审材料与注意

| 材料 | 内容 |
| --- | --- |
| 元数据 | 名称/副标题/截图（6.5"/6.7" 各尺寸）/描述/关键词/隐私政策 URL |
| 隐私 | App 隐私详情（App Privacy）：推送 token/设备信息收集声明（6.2）；隐私清单（Privacy Manifest，2024-05 起要求第三方 SDK 也需声明） |
| 审核备注 | **远程控制类应用说明**（5.1.4） |
| 合规 | 中国区上架需 ICP 备案信息（App Store 中国区 2023 年起要求提供备案号） |

#### 5.1.4 App Review 对远程控制类应用的审核风险（重点）

crish 移动端本质是「远程伴生/控制」类应用（审批远程决策、事件查看、run 控制），App Review 重点审查项与对策：

| 审查点 | 苹果关注 | 对策 |
| --- | --- | --- |
| 5.1.1/5.1.2 数据收集与使用 | 远程访问类 App 是否在收集用户未同意的数据；推送内容是否含敏感信息 | 隐私政策明确「推送只含事件摘要与跳转参数，不含对话全文」；锁屏正文隐藏开关（6.2） |
| 5.1.2 数据用途声明 | 远程控制能力用于什么 | 审核备注写清楚：**「本 App 用于远程查看与审批用户自己的 AI 工作流（桌面端 Agent），不提供对第三方设备的远程桌面控制，不采集键盘输入」**——这是与「TeamViewer 类」划清界限的关键表述 |
| 2.5.4 多任务/后台行为 | 是否滥用后台运行 | 明确「推送使用系统级 APNs，不做后台常驻」；不需要后台 mode entitlement（推送属于 PushKit/APNs 范畴，不申请 UIBackgroundModes 的 audio/location） |
| 3.1.1/4.x 功能完整性 | 功能是否与描述一致 | 截图与描述聚焦「审批中心/事件流/监控」，避免展示可能触发「远程桌面」联想的功能名 |
| 隐私清单 | 2024-05 起强制：App 与第三方 SDK 的收集行为声明 | expo-notifications/RN 生态 SDK 的隐私清单核对；APNs 使用声明（推送通知） |
| 儿童隐私（若适用） | 无年龄分级内容 | 常规 |

**风险等级评估**：中。crish 不是通用远程桌面工具（不控制第三方设备、不录制屏幕、不访问麦克风/相机/定位），属于「个人设备工作流伴生」类，合规表述到位即可通过；但若描述或截图暗示「远程控制他人电脑」，则直接触碰 2.5.4/5.2.5 红线被拒。**结论：审核备注必须主动声明用途边界（对策表第 2 行）**。

#### 5.1.5 iOS 发布流程（与 EAS 联动）

```
npm run release:ios（GitHub Actions 触发）
  → EAS Build（production profile，云构建，macOS 不可用绕开：D8 §7.2.1）
  → 上传 App Store Connect（EAS Submit）
  → TestFlight 内部组 → 外部组灰度（3-7 天观察）
  → 提交审核（审核备注含远程控制用途声明）
  → 通过后按「分阶段发布」控制放量（5.4）
```

### 5.2 Android：Google Play（可选）+ 国内五市场

#### 5.2.1 Google Play（海外版，可选）

| 项 | 要求 | 备注 |
| --- | --- | --- |
| 账号 | Play Console 开发者账号（25 美元一次性） | 需公司/个人实名 |
| 包 | AAB（Android App Bundle） | EAS Build 产出 aab |
| 签名 | Play App Signing（Google 托管 + 上传密钥） | 与国内市场签名**不同**（国内用传统 apk 签名，海外用 aab 签名——**两套签名共存**，推送 SDK 配置按渠道区分） |
| Data Safety | 数据安全表单（收集数据类型声明） | 推送 token/设备信息属「应用功能必需」 |
| 审核 | 自动审核为主（新应用人工抽审） | 远程控制类需在 Data Safety 与目标受众中说明 |
| targetSdk | 36（2026 年上架要求，Expo SDK 57 已满足） | — |
| 国内用户 | 海外版经 Google Play 分发不面向国内（无 FCM 的国内设备无法收推送） | 海外版 = expo-notifications + FCM（2.3.1 的海外分支） |

**结论**：Google Play 仅当海外发行立项时做；国内版不依赖。

#### 5.2.2 华为应用市场（Android 形态）

| 项 | 要求 | 备注 |
| --- | --- | --- |
| 开发者 | 华为开发者联盟实名认证（个人/企业） | 需营业执照或身份证 + 人脸核验 |
| 应用创建 | AGC 控制台创建应用，包名 `com.crish.mobile` | 与 agconnect-services.json 匹配 |
| 签名 | 华为证书（AGC 生成 .cer/.p12） | 上传签名证书；**后续更新必须同一证书** |
| 推送 | 开通 Push Kit（申请消息分类） | 审批类走「服务提醒/IM」分类（2.3.2） |
| 上架材料 | 应用名称/图标/截图/描述/隐私政策 URL/**APP 备案号** | 备案号必填（6.1） |
| 审核 | 应用审核（1-5 个工作日）；部分类目需软著/资质 | 工具类一般无需版号 |

#### 5.2.3 小米 / OPPO / vivo / 应用宝 / 荣耀

| 商店 | 关键差异点 | 推送联动 |
| --- | --- | --- |
| 小米应用商店 | 需小米开发者认证；**应用详情需声明推送用途**；MIUI 对推送权限的展示 | 小米推送通道开通（AppId/AppSecret） |
| OPPO 软件商店 | 需企业认证（部分类目个人不可上架）；隐私合规检查严格 | OPPO 推送通道（MasterSecret 签名） |
| vivo 应用商店 | 需实名 + 应用审核；**系统消息分类需申请**（推送分类直接绑定上架审核） | vivo 推送通道（2.3.2） |
| 应用宝（腾讯） | 需软著（部分类目强制）；隐私政策/权限声明模板严格；**2024 起强制备案号** | 无腾讯自有通道（长尾机型靠厂商通道） |
| 荣耀应用市场 | 与华为系类似 | 荣耀推送（M2 验证） |

**国内安卓五市场通用硬性要求（2026 现状）**：

1. **APP 备案号**（6.1）——所有国内商店强制；
2. 隐私政策（URL 形式，应用内可达）；
3. 权限声明（6.3：网络、通知权限、设备信息——**不需要定位权限**）；
4. 开发者实名认证（个人开发者可上架但部分商店功能受限）；
5. 签名一致（APK 签名在各市场分发时须与开发者上传一致——EAS 构建需为国内渠道用**同一把 release 签名**打包，区别于 Google Play 的 aab 签名）；
6. 国内商店对「保活/自启动」零容忍（4.3.2 的「不做保活」设计正是合规前提）。

#### 5.2.4 Android 发布流程（与 EAS 联动）

```
npm run release:android（GitHub Actions 触发）
  → EAS Build（production profile；国内渠道 = apk + release 签名；海外 = aab + Play 签名）
  → 渠道产物分发：
      国内：华为/小米/OPPO/vivo/应用宝 各市场后台上传
      海外：EAS Submit → Play Console
  → 各市场「分阶段发布/灰度」（5.4）
  → 各市场审核（1-5 工作日不等，需在排期预留）
```

### 5.3 HarmonyOS NEXT：华为应用市场（NEXT 上架流程）

#### 5.3.1 NEXT 应用上架（与 Android 形态的差异）

| 项 | Android（华为市场） | HarmonyOS NEXT |
| --- | --- | --- |
| 包形态 | .apk | .hap（HAR 为静态共享库形态） |
| 工程 | Expo/Gradle | DevEco Studio 工程（ArkTS/RNOH） |
| 签名 | AGC 证书（.cer/.p12） | AGC 自动签名或手动签名（Profile + 证书） |
| 应用标识 | 包名（com.crish.mobile） | **bundleName（不同名，如 com.crish.next）**——与 Android 是**两个独立应用实例**（2.4.2） |
| 备案 | APP 备案号（同一主体可多应用） | 同左（6.1） |
| 审核 | 应用审核 | 应用审核 + **元服务/应用能力审核（NEXT 生态审核更严）** |
| 推送 | Push Kit（Android HMS） | Push Kit（NEXT）——推送服务开通在 AGC 同一项目下，但 token/发送独立 |

#### 5.3.2 NEXT 上架流程（M3 落地时执行）

```
1. 华为开发者联盟实名（与 Android 版同一主体）
2. AGC 创建 NEXT 应用（bundleName=com.crish.next，app type=HarmonyOS）
3. 开通推送服务（Push Kit NEXT）
4. RNOH 工程构建 HAP（DevEco 命令行构建，或 CI 集成）
5. 签名（AGC 自动签名或手动 Profile）
6. 提交上架材料：名称/图标/截图/描述/隐私政策/**备案号**
7. 审核（应用 + 推送服务能力）
8. 分阶段发布（华为市场支持灰度发布）
```

**注意**：NEXT 版与 Android 版是独立应用，**推送注册、商店评价、版本节奏均独立**——M3 阶段（2.4.2）决策中已包含这一事实。

### 5.4 版本策略：三平台版本同步 / 灰度

#### 5.4.1 三轨版本模型（承接 D8 §7.3）

| 轨 | 定义 | 节奏 | 举例 |
| --- | --- | --- | --- |
| 应用版本（appVersion） | 每端独立 semver（iOS/Android/鸿蒙各自 package.json 版本） | 功能发布时递增 | iOS 1.2.0 / Android 1.2.1（仅修 Android bug） |
| 协议版本（protocolVersion） | 由 protocol-core 注册表 schemaVersion 派生，单调递增 | 协议变更时递增 | v1 → v2（PushMessage 字段新增） |
| 兼容窗口（minProtocolVersion） | 移动端声明支持的最小协议版本，握手协商（D8 §7.4） | 随 App 发布 | 移动端 1.5.0 声明 minProtocolVersion=1 |

**同步原则**：
- **功能同步**：同一功能（如审批远程决策）在 iOS/Android 同版本窗口发布（发布排期对齐，不要求版本号相同）；
- **补丁独立**：单端 hotfix 不阻塞另一端（如 Android 厂商 SDK 修复）；
- **协议先行**：协议版本变更先于应用发布（先发桌面端支持新协议 → 移动端灰度升级，保证旧移动端连新桌面端不崩——D8 §7.4 兼容窗口机制）。

#### 5.4.2 三平台灰度矩阵

| 平台 | 灰度通道 | 放量节奏 | 观察指标 |
| --- | --- | --- | --- |
| iOS | TestFlight 外部组（1% → 10% → 全量）→ App Store 分阶段发布（7 天窗口） | 1-2 周 | 崩溃率、推送到达率、审批响应延迟 |
| Android 国内 | 各市场分阶段发布/灰度发布（华为/小米/OPPO/vivo 均支持；应用宝按 10%/30%/100% 手动切换） | 1-2 周 | 同上 + 各厂商通道到达率（7.1） |
| Android 海外 | Play 内部测试轨道 → 生产分阶段（20%/50%/100%） | 1 周 | 同上 |
| HarmonyOS NEXT | 华为市场灰度发布 | 1-2 周 | 同上（NEXT 专属） |

#### 5.4.3 版本与推送的关系（关键耦合点）

| 耦合点 | 规则 |
| --- | --- |
| 推送 schema 版本 vs App 版本 | PushMessage.schemaVersion（D7 §6.2 字段）与 App 兼容：旧 App 收到新 schema 字段 → parser 宽容（未知字段忽略）；**不兼容变更必须 bump schemaVersion + minProtocolVersion 协商** |
| 推送 target 深链 vs App 路由 | 新 screen 枚举先于 App 发布生效会失效（移动端兜底跳首页，4.1.2）——**协议注册表变更与 App 发布顺序约束**：先发 App（支持新 screen），后启用新 screen 的推送 |
| 厂商 token vs 应用版本升级 | 应用升级后 token 一般不变（厂商 SDK 持久化）；若厂商要求重新注册 → 升级后首次启动触发 3.1.7 全流程 |
| 桌面端版本 vs 移动端版本 | 桌面推送发送器与移动端 App 解耦（schema 协商）；桌面旧版本 + 移动端新版本 → 新字段缺失走默认值 |

---

## 第 6 章 合规（核心交付 5）

### 6.1 工信部 APP 备案（国内上架硬前置）

#### 6.1.1 政策事实（2023-2024 强制执行，2026 现行）

- 依据：《工业和信息化部关于开展移动互联网应用程序备案工作的通知》（工信部信管〔2023〕105 号）；
- 时间线：2023-09-01 施行；存量 APP 于 2024-03-31 前补备案；**2024-04-01 起未备案 APP 不得在应用商店上架**；
- 适用范围：中国大陆内提供服务的所有 App（含 Android/iOS/鸿蒙各形态）——**crish 三平台国内发行均需备案**；
- 备案主体：与 ICP 备案主体绑定（单位或个人）；一个主体可备案多个 App。

#### 6.1.2 crish 备案清单

| 项 | 内容 | 责任方 |
| --- | --- | --- |
| 主办者 | 单位：营业执照信息（名称/统一社会信用代码）；个人：身份证 | 产品/法务 |
| App 基本信息 | 名称、包名（bundleName）、版本号、语言、平台、功能描述、前置审批情况 | 工程 |
| 前置审批 | 本类目（工具/效率类）一般无前置审批；若涉及新闻/金融等需专项许可 | 法务 |
| 办理入口 | 通过接入商（服务器托管商/云厂商）或应用商店平台提交（商店可代办通道） | 运维 |
| 审核周期 | 约 1-20 个工作日（平均 1-2 周） | — |
| 备案号 | 格式如「豫ICP备XXXXXXXX号-XA」（A 后缀表示 App） | — |
| 展示义务 | 应用内展示备案号（设置页「关于」）；商店后台填写 | 工程 |

#### 6.1.3 对发布排期的影响

- **备案是长周期前置**：从提交到拿到备案号约 1-3 周 → 必须进入 M1 的**最早关键路径**（与开发者账号申请并行）；
- 三平台可共用一个主体备案（同一 App 多平台在同一个备案记录下登记，包名不同分支）；
- 海外版（Google Play/海外 App Store）不受工信部备案约束（但 App Store 中国区上架需要备案号——苹果中国区 2023-08 起要求）。

#### 6.1.4 推送相关合规（备案之外的专项）

| 合规点 | 要求 | 落地 |
| --- | --- | --- |
| 《个人信息保护法》 | 推送 token/设备信息属个人信息，需告知 + 同意 + 最小化 | 隐私政策（6.2）+ 配对时明示 + 解绑即删（D7 §8.4） |
| 厂商通道合规 | 各厂商推送服务有内容合规要求（营销类限流/审核） | 消息分类映射（2.3.2）+ 摘要级载荷（D7 §6.3） |
| 商店推送声明 | 华为/小米/OPPO/vivo 商店要求应用声明推送用途与权限 | 5.2.3 各商店备注 |

### 6.2 隐私政策（推送 token / 设备信息）

#### 6.2.1 隐私政策条款清单（推送专项）

| 条款 | 内容 | 对应设计 |
| --- | --- | --- |
| 推送令牌收集 | 说明收集各厂商 device token/APNs token 的目的（「用于向您的设备发送通知」） | push_tokens 表（3.1.2） |
| 设备信息 | 设备型号、系统版本、时区（通知判定用）、应用版本 | device registry（D7 §8.2） |
| 推送内容说明 | 明示推送内容为事件摘要（审批/任务/定时器等），**不含对话全文与工具参数** | 敏感度分级（D7 §6.3） |
| 第三方共享 | 推送经华为/小米/OPPO/vivo/苹果等厂商通道传输，需列明第三方名单 | 2.3 厂商矩阵 |
| 存储与期限 | token 存储位置（桌面端/账号中心）、解绑即删 | 3.1.4 生命周期 |
| 用户权利 | 关闭推送（渠道级开关）、撤销通知权限、删除设备 | 4.2、设备管理 UI |
| 锁屏正文 | 「锁屏不显示正文」开关的说明 | 4.2 本地决策 |

#### 6.2.2 隐私政策的三个落点

1. **应用内可达**：设置页「隐私政策」入口（链接 + 应用内 WebView 兜底）；
2. **商店后台**：各商店上架材料中填隐私政策 URL；
3. **配对时告知**：首次配对弹窗（「Crish 将收集推送令牌与设备信息用于通知，详见隐私政策」）。

### 6.3 权限声明（网络 / 通知 / 定位——定位不需要）

#### 6.3.1 权限清单（最小化原则）

| 权限 | 必需？ | 用途 | 声明要点 |
| --- | --- | --- | --- |
| 网络访问（INTERNET） | ✅ | WS 直连/厂商通道 | 基础权限 |
| 通知（POST_NOTIFICATIONS / iOS alert/badge/sound） | ✅ | 推送展示 | Android 13+ 运行时弹窗；iOS 权限弹窗 |
| 定位 | **❌ 不需要** | — | 明确不申请（D7 任务书问询点：本方案确认不申请，避免商店审核「权限越界」风险） |
| 后台运行 | ❌ 不申请 | — | 厂商通道系统级投递，无需后台权限（4.3.2） |
| 麦克风/相机/存储 | ❌ 不需要 | — | v1 不做文件上传/扫码（D4 §1.3 非目标） |
| 振动/角标 | ✅（可选） | 通知体验 | 随通知权限附带 |

#### 6.3.2 商店权限声明口径

| 商店 | 声明口径 |
| --- | --- |
| 华为/小米/OPPO/vivo/应用宝 | 权限列表逐项说明用途；通知权限标注「用于推送审批与任务通知」；**不得出现未声明的敏感权限** |
| App Store | App Privacy 详情：推送 token 归属「Identifiers」，用途「App Functionality」 |
| 厂商推送服务开通 | 华为推送消息分类申请（IM/服务提醒）与权限声明联动 |

---

## 第 7 章 测试矩阵（核心交付 6）

### 7.0 测试分层总览（承接 D7 §10.1 + D8 §5 门禁）

| 层 | 对象 | 工具 | 门禁归属 |
| --- | --- | --- | --- |
| 单元 | push/core（筛选/合并/静默/节流）、copy（文案）、schema（序列化）、registry（SQLite）、approve（重推阶梯） | Rust cargo test | 快层（并入现有 cargo test 基线） |
| 单元 | 移动端 notifications/router/presenter（深链映射/呈现决策） | jest-expo | 中层（D8 §5.2 移动端 jest job） |
| 集成 | vendor dispatcher（mock 厂商网关）、relay（WS 配对/直推/Ack）、双通道去重 | tokio test + mock HTTP 网关 | 中层 |
| 对拍 | PushMessage schema（Rust ↔ TS 同一注册表） | 生成器 + git diff（D8 §5.3） | 快层 engine-bindings-drift 同款 |
| 端到端 | 三平台真机矩阵（7.1） | 手动 + 脚本化检查清单 | 发版前 |
| 商店侧 | 各市场审核材料与灰度发布（7.3） | 商店后台操作清单 | 发版流程 |

### 7.1 三平台推送真机测试矩阵

#### 7.1.1 机型 × 状态矩阵（D7 §10.5 扩展为三平台）

| 状态 \ 平台 | iOS（iPhone 14/15/16 至少 1 台 + EAS 云测补充） | Android 华为系（Mate/P 系列） | Android 小米/红米 | Android vivo/iQOO | Android OPPO/一加/realme | Android 荣耀（可选） | HarmonyOS NEXT（M3） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 前台（活跃） | 必测 | 必测 | 必测 | 必测 | 必测 | 可选 | 必测（M3） |
| 锁屏（亮屏通知） | 必测 | 必测 | 必测 | 必测 | 必测 | 可选 | 必测 |
| 后台 10min（进程存活） | 必测 | 必测 | 必测 | 必测 | 必测 | 可选 | 必测 |
| 后台清杀（划掉/force quit） | 必测（模拟 force quit） | 必测 | 必测 | 必测 | 必测 | 可选 | 必测 |
| 省电/深眠模式 | 低电量模式 | 必测 | 必测 | 必测 | 必测 | 可选 | 必测 |
| 厂商通知分类开关 | —（iOS 通知设置） | 必测（系统通知分类） | 必测（私信/提醒分类） | 必测（系统消息） | 必测（IM/系统） | 可选 | 必测（分类开关） |
| 断网重连（WS 恢复） | 必测 | 必测 | 必测 | 必测 | 必测 | 可选 | 必测 |

#### 7.1.2 每状态验证点（对齐 D7 §10.5 六项 + 三平台扩展）

| # | 验证点 | iOS 判定 | Android 判定 | NEXT 判定 |
| --- | --- | --- | --- | --- |
| 1 | 审批请求必达（锁屏横幅 + 声音可选） | APNs 到达 ≤ 5s | 厂商通道到达 ≤ 10s（高优先级） | Push Kit 到达 ≤ 10s |
| 2 | run 完成（P1）锁屏可达；静默时段不发（或夜间摘要） | 同左 | 同左 | 同左 |
| 3 | 点击跳转冷启动直达目标页（全 screen 各一遍） | 深链直达 | 深链直达 | 深链直达（RNOH 路由） |
| 4 | 前台双显示问题（透传 vs 通知消息模式切换） | 无此问题（前台 handler 全可控） | HMS 双模式切换正确（2.3.3） | 同 Android |
| 5 | 设备 token 轮换 → 重注册（onTokenReceived） | APNs token 变更重注册 | 厂商 token 轮换重注册 | NEXT token 轮换 |
| 6 | 卸载重装 → 旧 token 失效 → DeviceNotRegistered 清理 | APNs Unregistered（410） | 厂商 Unregistered | NEXT 同 |
| 7 | 双通道去重（WS 直推 + 厂商通道竞态双达） | 展示层 dedupeKey 去重 | 同左 | 同左 |
| 8 | 夜间摘要（静默时段折叠产物） | 07:30 后到达 | 同左 | 同左 |
| 9 | 权限引导流（拒绝 → 设置引导 → 重新授权） | ios.status 五态 | 渠道先建 + 弹窗 | NEXT 权限流 |

### 7.2 厂商通道后台测试（专项）

#### 7.2.1 mock 厂商网关（集成测试，D7 §10.3 扩展）

| 测试面 | 用例 |
| --- | --- |
| HMS | OAuth2 AT 换发成功/失败/过期刷新；messages:send 200/4xx/5xx/429（退避重试）；4KiB 载荷上限断言 |
| 小米/vivo/OPPO/荣耀/APNs | 同构用例（各厂商鉴权头/签名正确性） |
| DeviceNotRegistered | 响应后断言 registry 设备清理、不再发（3.1.4） |
| 并发与背压 | 4 worker 并发、队列满时 P0 持久化不丢、P1 可丢计数 |
| 时区与静默 | 注入时钟断言 22:30-07:30 的 defer/summary 行为 |

#### 7.2.2 厂商通道后台真机测试（专项场景）

| 场景 | 步骤 | 通过标准 |
| --- | --- | --- |
| 杀进程后审批必达 | 清杀应用 → 桌面发起审批 → 观察通知 | 锁屏横幅 ≤ 10s；点击直达审批卡 |
| 杀进程后任务失败通知 | 同上（task-failed） | 通知到达，点击直达任务详情（摘要 + 跳转） |
| 省电模式 + 锁屏 | 开启省电 → 息屏 10min → 触发 P0 | 到达（可能静默，横幅或角标） |
| 厂商分类开关关闭 | 关闭某渠道通知 → 触发该渠道 | 不展示（用户意志生效） |
| 双卡/飞行模式边界 | 断网 → 触发 → 恢复网络 | 断网期间不丢（待发队列），恢复后尽力补发 |
| token 轮换 | 清除应用数据 → 重新注册 | 新 token 生效，旧 token 不再收 |

### 7.3 商店发布测试（发版流程验证）

| 面 | 验证项 |
| --- | --- |
| TestFlight | 内部组全量回归（推送/深链/权限）；外部组灰度观察崩溃率与推送到达 |
| 国内商店 | 各市场审核材料预检（备案号/隐私政策/权限声明）；灰度放量后观察各渠道崩溃率与推送到达率 |
| 版本兼容 | 旧移动端 App（minProtocolVersion=1）+ 新桌面端 → 握手降级不崩；新移动端 + 旧桌面端 → 字段缺省不崩 |
| 签名 | 国内渠道 apk 签名一致（升级安装不失败）；海外 aab 签名独立 |
| 合规 | 备案号在应用内可见；隐私政策可达；权限声明与代码实际权限一致（权限扫描工具核对） |

### 7.4 测试门禁接线（与 D8 门禁体系合并）

```
快层（ci.yml）：+ mobile typecheck（tsc --noEmit）+ mobile lint + 协议对拍（生成器 git diff）
中层（ci-mid.yml）：+ mobile jest（jest-expo，覆盖率对齐 D8 §9 口径）+ Rust push 单测（并入 rust-test）
发版前：三平台真机矩阵（7.1 清单）+ 商店材料清单（7.3）
```

---

## 第 8 章 工作量与阶段（核心交付 7）

### 8.0 阶段总览（D7 §12 里程碑 × 发布面的合并排期）

> 【裁决修正 9】阶段映射（统一 R0-R5）：M1 基础推送 + 首发 → **R3 推送**（前半）；
> M2 厂商全矩阵 → R3（后半）；M3 鸿蒙 + 中继 → **R5 鸿蒙**（鸿蒙部分，O5 裁决
> 立项后）+ **R4 中继+P2P**（中继部分）。任务书引用一律使用 R 阶段号。

| 阶段 | 范围 | 推送面 | 发布面 | 依赖 |
| --- | --- | --- | --- | --- |
| M1 基础推送 + 首发 | iOS APNs + Android WS + HMS + 移动端基础 | 在线直推 + 华为系离线 + iPhone 离线；审批必达闭环 | 账号/备案/签名准备；TestFlight 内测；国内商店首发（HMS 通道先行） | 开发者账号（Apple/华为）、备案提交 |
| M2 厂商全矩阵 | 小米/vivo/OPPO/荣耀 + 防打扰完整 | 国内安卓全覆盖；静默/夜间摘要/合并优化 | 国内五市场全量上架 + 灰度；Google Play（可选） | 各厂商账号与审核 |
| M3 鸿蒙 + 中继（可选） | 鸿蒙 NEXT + 中继服务代发 + 账号集成 | NEXT 推送通道；桌面离线代发 | 华为应用市场 NEXT 专区上架 | 账号中心模块（AC M2-M4）、中继服务（AC M4） |

### 8.1 M1：iOS + Android 基础推送（首发 MVP）

**目标**：手机能收到「审批必达 + 核心结果通知」，iOS/华为系离线可达，三平台首发材料齐备。

| 工作项 | 内容 | 工作量（人日） |
| --- | --- | --- |
| 推送注册与桌面发送器 | push-core 事件筛选（13 场景）/copy/registry；vendor trait + APNs 直连 + HMS 直连；审批重推阶梯 | 10-14 |
| WS 中继（在线直推） | relay.rs 配对/presence/push/ack + 移动端 WS 客户端 | 6-8 |
| 移动端通知层 | notifications 统一抽象（4.1）、权限引导（4.2）、深链路由、透传双模式 | 5-7 |
| 厂商 SDK 集成（移动端） | withHmsPush config plugin + 官方 RN 插件；HMS token/透传 | 3-4 |
| 测试 | Rust 单测/集成（mock 网关）、jest 移动端、iOS+华为真机矩阵 | 5-6 |
| 发布准备 | 开发者账号（Apple/华为）、APP 备案提交、隐私政策、TestFlight 内测、华为市场首发（HMS 验证） | 3-5（并行） |
| **M1 合计** | | **32-44 人日（约 6-9 周单人）** |

**M1 验收**：
- 手机息屏/清杀 → 审批请求 10 秒内到达华为系通知中心（厂商通道）；
- iPhone 后台 force quit → 审批 5 秒内到达通知中心（APNs）；
- 移动端在线 → 桌面 1 秒内收到应用内通知并可跳转审批；
- 桌面端杀进程重启 → 未决审批 15 分钟后仍重推；
- TestFlight 内测全绿；华为应用市场首发成功（备案号齐备）。

### 8.2 M2：厂商全矩阵 + 防打扰完整

**目标**：国内安卓全覆盖；静默/夜间摘要/合并落地；国内五市场上架完成。

| 工作项 | 内容 | 工作量（人日） |
| --- | --- | --- |
| 小米/vivo/OPPO 通道 | 服务端适配器 ×3 + 移动端原生模块 ×3 + config plugin ×3 | 10-14 |
| 荣耀验证 | 真机验证 HMS 覆盖；必要时加接荣耀 | 2-3 |
| 防打扰完整 | 静默时段/夜间摘要/合并优化/节流护栏（3.4） | 4-6 |
| push_tokens 云注册 | 账号中心 push_tokens 模块落地（AC M2）+ 双表同步（3.1.5） | 4-6（账号侧） |
| 测试 | 全矩阵真机（7.1）+ 厂商后台专项（7.2） | 6-8 |
| 发布 | 五市场全量上架 + 灰度 + 各商店推送声明 | 3-5 |
| **M2 合计** | | **29-42 人日（约 6-9 周）** |

**M2 验收**：
- 小米/vivo/OPPO 真机矩阵全绿（7.1 全状态）；
- 静默时段只收夜间摘要；同 session 高频任务不刷屏；
- 国内五市场上架完成、灰度通过；各渠道推送到达率 ≥ 90%（P0）。

### 8.3 M3：鸿蒙 NEXT + 中继代发（可选，与账号集成打包）

**目标**：桌面离线也能推（中继代发）；华为 NEXT 用户可收推送。

| 工作项 | 内容 | 工作量（人日） |
| --- | --- | --- |
| 账号中心模块 | push_tokens（若 M2 未做）+ relay_credentials + 限流/白名单（AC M0-M3 全部） | 10-15（账号侧） |
| Rust 中继服务 | 握手鉴权 + 转发 + 推送代发（3.5）+ 在线状态 | 6-10 |
| 桌面端集成 | 登录/凭据存储/中继客户端/事件摘要上报 | 8-12（涉及 crish 侧） |
| 鸿蒙 NEXT 工程 | RNOH 工程搭建 + Push Kit 原生模块 + 深链 + 通知层（2.4.3） | 20-30 |
| NEXT 上架 | 华为市场 NEXT 专区（5.3） | 3-5 |
| **M3 合计** | | **47-72 人日（约 10-15 周）** |

**M3 验收**：
- 桌面关机后 P0 事件仍能推送（中继代发，≤ 60s）；
- NEXT 真机（2 台）推送全状态通过；NEXT 专区上架成功；
- 账号中心原有 22 模块零回归（AC §6.7 门禁）。

### 8.4 关键路径与并行（发布排期）

```
里程碑时间轴（示意，按 M1 排期）：
W1-W2   备案提交 + 开发者账号申请（Apple/华为）+ 移动端工程骨架（与推送无关面先行）
W3-W5   push-core + WS 中继 + APNs + HMS 发送器（桌面侧）
W4-W6   移动端通知层 + 厂商 SDK 集成 + TestFlight 内测准备
W6-W8   真机矩阵（iOS + 华为）+ 商店材料 + 首发
W8+     华为市场首发（HMS 验证）→ M2 启动（小米/vivo/OPPO 账号申请并行）
```

**并行建议**：厂商账号/备案/商店材料是「外部等待型」工作，与开发并行启动（M1 的发布准备工作项即此意图）；厂商 SDK 集成与发送器开发可并行（两端契约先行：PushMessage schema 冻结）。

---

## 第 9 章 风险与开放问题

### 9.1 风险清单（D7 §11 + AC §9 合并扩展）

| # | 风险 | 概率 | 影响 | 缓解 | 责任方 |
| --- | --- | --- | --- | --- | --- |
| R1 | 厂商审核周期（各商店 + 各推送服务开通） | 高 | 中 | 尽早申请（M1 发布准备即启动）；申请清单文档化（附录 B 可扩展）；推送服务开通与商店上架解耦（先开通推送、后上架） | 工程 + 运营 |
| R2 | 消息分类管控致送达率低（营销类限流） | 中 | 高 | 审批/任务类映射「IM/系统/私信」分类；控制台预申请高优；真机矩阵（7.2） | 工程 |
| R3 | 配额限制（OPPO 日配额、vivo 测试配额、小米频控） | 中 | 中 | 节流护栏（3.4.4）；超配降级为合并摘要；配额告警（诊断面板） | 桌面端 |
| R4 | ROM 碎片化（通知展示/渠道开关/省电差异） | 高 | 中 | 真机矩阵（7.1）；vendor 适配层隔离 | 工程 |
| R5 | 桌面关机 = 推送断源（M1-M2 架构属性） | 高 | 中 | 诚实呈现「Hub 离线」；审批已持久化兜底；M3 中继代发解决 | 产品 |
| R6 | App Review 拒绝/下架（远程控制类审查） | 中 | 高 | 审核备注主动声明用途边界（5.1.4）；权限最小化（6.3）；不做保活（4.3.2） | 产品 + 法务 |
| R7 | 备案延迟卡住首发 | 中 | 高 | 备案进 M1 最早关键路径（8.1）；与开发者账号并行 | 运营 |
| R8 | 厂商 token 轮换/失效导致推送断裂 | 中 | 中 | onTokenReceived 重注册（3.1.4）；DeviceNotRegistered 清理；token 体检 | 工程 |
| R9 | 账号中心可用性依赖（M3 起） | 中 | 中 | crish 全功能无账号可用（AC §5.4）；中继本地缓存校验（≤5min） | 运维 |
| R10 | 鸿蒙 NEXT 生态变动（RNOH 版本线落后/推送 API 演进） | 中 | 高 | M3 立项时再评估；RNOH 版本线锁定；JS 面（protocol-core）与原生面隔离 | 工程 |
| R11 | Expo SDK 升级破坏厂商 config plugin | 中 | 中 | config plugin 单测（prebuild 后构建断言）；升级走 D4 §3.2.3 的 SDK 升级纪律 | 工程 |
| R12 | 隐私合规（token/设备信息） | 中 | 高 | 摘要白名单（D7 §6.3）；隐私政策（6.2）；解绑即删 | 产品 + 工程 |
| R13 | 双显示（WS 直推与厂商通道竞态双通知） | 低 | 中 | 展示层 dedupeKey 去重（4.1）；presence 判定 + 审批例外双发规则（3.2.1） | 工程 |
| R14 | 长尾厂商（三星/魅族/中兴）无覆盖 | 中 | 低 | M1 聚合商备选（个推/极光）；明确放弃并文档化 | 产品 |
| R15 | 各商店对「应用保活/自启动」的零容忍 | 中 | 高 | 架构不保活（4.3.2）；权限声明最小化（6.3） | 工程 |

### 9.2 风险缓解责任矩阵（新增面）

| 缓解项 | 执行人 | 时机 |
| --- | --- | --- |
| 备案 + 开发者账号 + 各厂商账号申请清单 | 运营/主控 | M1 第 1-2 周（关键路径） |
| 审核备注模板（远程控制用途声明） | 产品 | M1 提审前 |
| 隐私政策（含推送专项条款） | 法务/产品 | M1 第 2 周 |
| 各厂商消息分类申请（系统消息/私信/IM） | 工程 | 各通道开通时 |
| 真机矩阵执行 | 工程 | M1/M2 发版前 |

### 9.3 开放问题（需主控/用户裁决）

| # | 开放问题 | 本方案默认 | 备选 |
| --- | --- | --- | --- |
| O1 | M1 是否先用聚合商（个推/极光）提速覆盖长尾？ | 否（HMS 自建先行，D7 §13.2-1 同默认） | 是（M1 加聚合商，M2 转自建） |
| O2 | 审批能否在移动端直接批准/拒绝？（涉及桌面安全模型，D7 §13.2-2） | 【裁决修正 12】**已裁决：审批中心 = P0 功能，R2 首批交付**——移动端远程审批（approve/deny）随 R2 审批中心一并开放（D1 P1 验收红线，F2 全链路无技术阻塞）；本方案的「一期只收通知」默认作废，R3 推送只负责通知 + 深链直达审批卡 | 二期做移动端远程审批（已否决） |
| O3 | 静默时段默认值 22:30-07:30 是否合理？ | 保持 | 22:00-08:00 或按用户画像 |
| O4 | 夜间摘要默认开关？ | 默认开（P1 折叠） | 默认关 |
| O5 | 【裁决修正】P2-4：中继代发（**M2 中继**，非「M3 中继」）立项与否？（与鸿蒙 NEXT 打包评估） | 用户决定：中继代发是可选项（R4，M2 §2.1 已标注演进项） | — |
| O6 | 桌面长期离线时中继的审批重推是否升级？ | 中继只发一轮（3.5.3） | 中继实现完整重推阶梯（复杂度↑） |
| O7 | Google Play 海外版是否立项？ | 否（M1-M2 仅国内） | 是（FCM 通道 + 海外商店材料） |
| O8 | 鸿蒙 NEXT 版本是否必须与 iOS/Android 功能对齐？ | 否（M3 单独立项，功能子集先行：审批 + 通知） | 全量对齐（成本 ↑↑） |
| O9 | 推送 token 是否上报「用户可撤销的营销通知」类别？ | 全部推送为「服务/功能通知」，无营销类别（合规最简） | 未来若做运营推送需单独类别与同意 |

---

## 附录 A 网络查证记录（2026-08）

| # | 查证项 | 来源 | 结论 | 对本方案影响 |
| --- | --- | --- | --- | --- |
| A1 | Expo SDK 57 官方兼容矩阵 | docs.expo.dev/versions/latest（webfetch 成功，含 SDK 57.0.0 / RN 0.86 / React 19.2.3 / compileSdk 36 / iOS 16.4+ 表） | Expo 只支持 iOS/Android/Web/TV，**无 HarmonyOS**；SDK 57 满足 2026 上架要求 | 2.4 裁决：鸿蒙独立路线；5.1/5.2 targetSdk 依据 |
| A2 | Expo SDK 参考页（AI 友好 llms.txt 索引） | docs.expo.dev/versions/latest（webfetch） | SDK 包清单确认 expo-notifications 存在且为「Notifications」页 | 4.1/4.2 移动端实现依据 |
| A3 | @hmscore/react-native-hms-push npm 现状 | npmjs.com/search（webfetch） | 官方 RN 推送插件存在且活跃（6.13.0-301，Apache-2.0，2026-06 发布） | 2.3.3 华为移动端集成路径确认 |
| A4 | RNOH 社区生态 | github.com/orgs/react-native-oh-library/repositories（webfetch） | 组织 299 个适配仓库（gesture-handler/reanimated/WatermelonDB 等），**未发现推送类适配包** | 2.4.3 鸿蒙推送需自研原生模块 |
| A5 | 华为开发者文档（Push Kit 页面） | developer.huawei.com（webfetch 失败/SPA，firecrawl 1 次 404） | 华为文档站为 SPA，无法抓取正文 | 华为侧接口细节标注「落地时核实」（2.3.2/2.4.1） |
| A6 | 工信部备案 | beian.miit.gov.cn（521）、gov.cn 政策页（firecrawl 未命中目标页） | 未能直接抓取原文 | 6.1 依据公开共识事实（2023-2024 强制执行，2026 现行）撰写，标注政策文号 |
| A7 | 华为推送服务对 NEXT 的现状 | 公开共识 + AGC 推送文档（间接） | NEXT 应用经 Push Kit（@kit.PushKit）接入，token 独立于 Android HMS | 2.4 方案设计依据 |

**查证限制声明**：华为文档站（SPA 渲染）与工信部站点在本会话不可直接抓取，相关接口细节与政策原文以「公开共识 + 落地前复核」处理，涉及实现的关键配置（厂商 REST 端点、NEXT SDK API）标注「待核实」。

---

## 附录 B 参考资料与代码索引

### B.1 仓库内证据（本方案引用）

| 事实 | 位置 |
| --- | --- |
| AgentEvent 41 变体全量 | crates/conex-types/src/events.rs:306-782 |
| 事件 type 名清单（41 项） | crates/conex-types/src/events.rs:810-852 |
| 背压分级（Critical/Soft/Delta） | crates/conex-types/src/events.rs:867-893 |
| 事件信封（runId/sequence/schemaVersion） | crates/conex-types/src/events.rs:921-993 |
| PermissionRequest 载荷（toolCallId 等） | crates/conex-types/src/events.rs:194-218 |
| 事件桥 Emitter trait / TauriEmitter | apps/agent-workbench/src-tauri/src/core_event_bridge.rs:51-81 |
| EventBridge 装配点 | apps/agent-workbench/src-tauri/src/main.rs:344-348 |
| 唤醒摘要（文案资产） | apps/agent-workbench/src-tauri/src/wakeup_summary.rs:63-135 |
| 前端 toast 防打扰语义 | apps/crish-desktop/src/hooks/useToastQueue.ts:55-58、75-180、258-260 |
| D7 推送方案（场景/架构/厂商矩阵/测试） | docs/multi-device/plans/D7-push-notifications.md 全篇 |
| AC 账号中心评估（push_tokens/relay_credentials） | docs/multi-device/plans/AC-account-center-evaluation.md §6.3-6.4 |
| D8 工程发布（EAS/版本三轨/门禁） | docs/multi-device/plans/D8-engineering-release.md 第 5/7/9/11 章 |
| D4 移动技术（Expo SDK 57/厂商插件） | docs/multi-device/plans/D4-mobile-tech.md §3、§8 |
| D1 总体架构（局域网直连 + 云中继兜底） | docs/multi-device/plans/D1-overall-architecture.md §3-4 |
| D3 协议（设备配对/中继留位） | docs/multi-device/plans/D3-protocol.md §4-5 |
| D6 同步一致性（通道 C 推送） | docs/multi-device/plans/D6-sync-consistency.md §5 |

### B.2 外部参考资料（网络查证摘要）

1. Expo SDK reference（v57）— docs.expo.dev/versions/latest（SDK 版本矩阵、expo-notifications 条目）；
2. Expo push notifications 文档族 — exp.host 服务器位置/无 SLA、Android 必须 FCM v1、DeviceNotRegistered 语义（D7 已引用，本方案复用）；
3. @hmscore/react-native-hms-push — npm（官方 RN 推送插件，Android）；
4. react-native-oh-library — GitHub 组织（RNOH 社区适配生态，299 仓库）；
5. 工信部 APP 备案通知（工信部信管〔2023〕105 号）— 2023-09 施行、2024-04 未备案禁上架（公开共识事实，原文站点本会话不可达，标注待复核）；
6. 苹果 App Store 审核指南 — Guideline 5.1.1/5.1.2/2.5.4（远程控制类审查关注点，基于公开共识）；
7. 华为 AppGallery Connect / Push Kit — 开发者联盟（SPA 不可抓取，接口细节标注待核实）。

### B.3 待核实清单（实现前必须复核）

| # | 项 | 原因 |
| --- | --- | --- |
| 1 | 华为 Push Kit REST API 端点与鉴权细节（Android 与 NEXT 两套） | 华为文档站本会话不可抓取；API 演进频繁 |
| 2 | 小米/vivo/OPPO 推送 REST API 最新域名与签名算法 | 厂商接口演进频繁（本表为 2026-08 共识） |
| 3 | 工信部备案审核时长与材料清单原文 | 官网 521；以接入商指引为准 |
| 4 | App Review 对远程控制类的最新审查口径 | 审核政策动态调整；以提交时指南为准 |
| 5 | RNOH 当前支持的 RN 版本线 | 社区持续演进（0.72-0.77 线为 2026 共识，M3 立项时复核） |
| 6 | 华为应用市场 NEXT 上架的推送服务开通流程 | 华为文档站不可抓取 |

---

## 附录 C 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-08-09 | 初稿（M8 交付物）：三平台推送矩阵（iOS APNs 直连核实 / Android 厂商逐家 RN 集成 / 鸿蒙 NEXT 独立路线）、推送架构裁决（桌面直连 vs 中继代发）、push_tokens 细化、商店发布矩阵（App Store/国内五市场/NEXT）、工信部备案与隐私合规、三平台测试矩阵、M1-M3 分阶段排期 |

---

（完）





