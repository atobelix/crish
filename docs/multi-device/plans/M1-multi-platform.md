# M1 多系统适配总方案（iOS / Android / HarmonyOS 三平台）

> 文档编号：M1-multi-platform
> 系列：crish 多端互通技术方案（multi-device）
> 版本：v1.0（草案评审稿）
> 日期：2026-08-09
> 角色：多系统适配总方案子代理（M1）
> 上游依赖：D1（总体架构母方案）、D4（移动端技术方案：Expo 57 / RN 0.86）、D7（推送体系）、D8（工程与发布）、AC（账号中心评估）、R2A/R2B（旧移动端评估）、F1-F6（移动端功能设计）
> 产出路径：`C:\Software\conex\docs\multi-device\plans\M1-multi-platform.md`
> 读者：主控调度者、D/F 系列其他子方案、M 系列后续子方案（M2-M9）、实现阶段（PE 系列）任务书作者
> 查证声明：本文档涉及的外部事实（RNOH 状态、HarmonyOS 版本线、Flutter/uni-app/Taro 鸿蒙支持、npm 生态）均于 2026-08-09 经 webfetch 实查并标注证据来源与查证日期；华为商店上架政策、推送通道细节等易变条目标注"以官方最新政策为准"并留待 M8 细化。

---

## 目录

1. [结论摘要（TL;DR）](#1-结论摘要tldr)
2. [背景与任务范围](#2-背景与任务范围)
3. [平台技术路线裁决](#3-平台技术路线裁决)
4. [共享代码策略与共享边界](#4-共享代码策略与共享边界)
5. [能力差异矩阵](#5-能力差异矩阵)
6. [推送矩阵（高层）](#6-推送矩阵高层)
7. [构建与发布矩阵](#7-构建与发布矩阵)
8. [真机测试矩阵](#8-真机测试矩阵)
9. [风险与回退](#9-风险与回退)
10. [结论：三平台适配总策略与工作量估算](#10-结论三平台适配总策略与工作量估算)
11. [附录：查证记录与证据索引](#11-附录查证记录与证据索引)

---

## 1. 结论摘要（TL;DR）

### 1.1 一句话结论

移动端三平台采用 **"iOS/Android 双端 Expo 57 原生工程 + HarmonyOS 独立 RNOH 工程"** 的双轨架构：iOS 与 Android 共享一个 Expo SDK 57（RN 0.86）工程（D4 既定结论，无争议）；鸿蒙端**不追逐 Expo**，采用 **RNOH（React Native OpenHarmony）独立 bare RN 工程**（锁 RNOH 0.82 稳定线），通过 monorepo 共享包（`@crish/shared-types` / `protocol-core` / 纯逻辑层 / React 组件树 / zustand 状态层）实现三层代码复用，平台差异收敛到"原生适配层 + compat wrapper"。

### 1.2 关键决策清单（结论先行）

| 决策点 | 结论 | 一句话理由 |
| --- | --- | --- |
| iOS 路线 | Expo SDK 57 原生支持（无争议） | 官方一等公民；EAS/TestFlight/App Store 全链路成熟（§3.1） |
| Android 路线 | Expo SDK 57 原生支持（无争议） | 官方一等公民；差异只在国内分发与厂商推送（§3.2） |
| **HarmonyOS 路线** | **RNOH（React Native OpenHarmony）独立工程**，不选 ArkUI 全原生、不选 uni-app/Taro/Flutter、不选壳+WebView | RNOH 是唯一能复用 React 栈/TS 类型面/状态机的路线；生态活跃（0.82 线 2026-07 仍在月更）；ArkUI 双份代码成本不可接受（§3.3） |
| 鸿蒙 × Expo 冲突 | 鸿蒙端不兼容 Expo SDK 57（RN 0.86 超出 RNOH 支持线）；**鸿蒙独立 bare RN 工程 + 共享包复用**，Expo 特有 API 走 compat wrapper | 已查证 RNOH 稳定线 0.82、RC 0.84，Expo 57 需 RN 0.86；社区 expo-harmony-cli 仅支持 SDK 52（§3.3.5、§4.3） |
| 共享边界 | **三层共享 + 一层差异**：协议层 / 状态层 / UI 层共享；平台差异层（原生适配器、权限、推送注册、深链、生物认证）各端独立 | 共享面不触碰任何 Expo/Harmony 特有 API；共享纪律 = "平台无关纯逻辑"（§4） |
| 推送通道 | iOS=APNs；Android 海外=FCM（Expo Push Service），国内=厂商通道（HMS/小米/OPPO/vivo/荣耀）聚合；鸿蒙 NEXT=华为 Push Kit（@kit.PushKit）；统一由推送网关按设备注册表路由 | 细节归 M8（§6） |
| 构建发布 | iOS/Android=EAS Build + 商店；鸿蒙=DevEco Studio + hvigor + AGC 签名 + HAP 打包 + 华为应用市场（NEXT 专区）；三端版本号独立 semver + 协议版本兼容矩阵 | EAS 不支持鸿蒙（已确认事实面，§7） |
| 分阶段 | **P1 先 iOS+Android 上线**（HarmonyOS 4.x 存量设备由 Android APK 兼容覆盖）；**P2 鸿蒙 NEXT 原生**（RNOH 工程 MVP：审批+事件流+推送）；P3 鸿蒙功能完备 | 鸿蒙生态不确定性要求"国际+安卓先行、鸿蒙后置"的演进策略（§9.3） |
| 工作量 | iOS=1.0 基准；Android≈1.2；鸿蒙 NEXT（RNOH）≈0.6（相对 iOS 增量） | 共享三层后鸿蒙端只写原生壳+适配层（§10.3） |

### 1.3 阅读指南

- 第 3 章是**技术路线裁决**（核心交付），其中 §3.3 为鸿蒙深挖（候选对比 + 裁决 + 冲突解法）；第 4-8 章分别是共享边界、能力差异、推送、构建发布、真机测试五大矩阵；第 9 章是风险与分阶段；第 10 章是总策略与工作量。
- 所有外部事实标注查证日期（2026-08-09）与来源；易变条目（商店政策、推送配额）标注"以官方最新政策为准"。
- 与既有文档的衔接：D4 是 iOS/Android 双端的技术基线（本文不再重复其选型论证，只引用结论）；D7 是推送场景与架构（本文只做三平台通道矩阵高层视图）；D8 是工程与发布（本文的构建发布矩阵是其跨端延伸）；M8 将承接本文推送矩阵做通道级细化。

---

## 2. 背景与任务范围

### 2.1 背景回顾（对齐既有方案）

- **D1 母方案**：桌面主端 = 权威中枢（Hub），移动端 = 伴侣（Companion），严格主从；局域网直连（WS）优先 + 云中继兜底；身份 = 用户 × 设备 × 会话三元模型。
- **D4 移动端技术方案（已冻结）**：Expo SDK 57（RN 0.86 / React 19.2.3）+ TypeScript strict + zustand/immer + expo-router + expo-sqlite + expo-secure-store + RN 内建 WebSocket + expo-notifications；桌面 daemon 新增 WS 网关透传引擎命令面与事件信封。
- **D7 推送体系**：13 个值得推送的事件场景（P0 必达 6 类）；分层推送架构（在线 WS 直推优先 + 离线厂商通道兜底）；国内安卓无 GMS 需逐厂商接入。
- **D8 工程与发布**：`apps/crish-mobile` 作为独立 Expo app 进入 npm workspaces；协议包 `packages/protocol-core` 从 shared-types 派生；生成器双轨；版本三轨制（应用版本/协议版本/兼容窗口）。
- **AC 账号中心评估**：navigation-site（flowbit-auth）核心可用，需补齐推送令牌绑定与中继连接鉴权两个模块；中继转发服务独立新写。
- **R2A/R2B 旧移动端评估**：`apps/crish-mobile` 旧原型整体删除（零连带损失）；有价值的借鉴点包括"多平台推送适配器接口（IPushAdapter，含 Harmony 适配器）"——本文 §4.4 与 §6 采纳该思路。

### 2.2 任务范围（M1 职责边界）

M1 回答三个总体问题 + 五个矩阵：

1. **平台技术路线裁决**：iOS / Android 简述确认；HarmonyOS 深挖（RNOH vs ArkUI vs uni-app/Taro/Flutter vs 壳+WebView 四候选对比 + 裁决 + 与 Expo 的冲突解法）；
2. **共享代码策略**：三平台共享什么、不共享什么、共享边界图；
3. **能力差异矩阵**：推送/后台任务/文件/生物认证/深链/权限/通知/存储/网络九域 × 三平台行为 + 统一抽象建议；
4. **推送矩阵**（高层，通道级细节归 M8）；
5. **构建与发布矩阵**（EAS 对鸿蒙不支持的事实确认、DevEco/hvigor/AGC 签名、商店上架差异、版本同步策略）；
6. **真机测试矩阵**（设备/系统版本覆盖清单、国内定制 ROM 后台限制风险）；
7. **风险与回退**（鸿蒙生态不确定性 → 分阶段 P1/P2）；
8. **结论**（总策略 + 相对工作量估算）。

**不做**：推送通道级实现（M8）、鸿蒙工程脚手架细节（PE 系列）、桌面侧 WS 网关设计（D2/D3 已覆盖）。

### 2.3 核心问题的重述：为什么鸿蒙是一个"路线级"问题

React Native 官方支持矩阵只包含 iOS / Android / macOS / Windows / Web（reactnative.dev/versions 与 RN 官方平台文档为证），**不包含 HarmonyOS**。HarmonyOS 5.0（NEXT）起是剔除 AOSP 的纯鸿蒙系统（2026-08-09 维基百科版本表确认：NEXT 不能原生运行 Android 应用，华为应用市场纯血时代只分发鸿蒙原生应用），因此：

- 在 **HarmonyOS 4.x（含 4.2/4.3，AOSP 时代）** 设备上，crish 的 **Android APK 可直接运行**（经华为应用市场或侧载），这是"零成本鸿蒙覆盖"；
- 在 **HarmonyOS 5.0+（NEXT 纯血）** 设备上，Android APK 无法运行，**必须原生鸿蒙应用（HAP）**才能上架华为应用市场、才能被 NEXT 用户使用。

所以"要不要做鸿蒙、用什么技术做"是移动端方案的最大分叉点，也是本方案的核心裁决。

---

## 3. 平台技术路线裁决

### 3.1 iOS 路线（无争议，简述确认）

#### 3.1.1 结论

**iOS = Expo SDK 57 原生工程，官方一等支持，无技术分叉。** D4 已冻结技术栈（Expo 57 / RN 0.86 / React 19.2.3），iOS 侧不再做任何二次裁决。

#### 3.1.2 关键事实与工程要点

| 项 | 事实/做法 | 说明 |
| --- | --- | --- |
| 支持面 | Expo 官方矩阵：iOS 16.4+，Xcode 26.4+，APNs entitlement 由 EAS 托管 | D4 §2.3 查证（2026-08-09） |
| 构建 | EAS Build（managed workflow + CNG）；`eas build -p ios` 生成 ipa；本地可 `npx expo run:ios` | 与 D4 §3.1 一致 |
| 签名 | Apple Developer Program 账号 + App ID + Push Notifications capability + Signing & Capabilities（EAS 托管证书或本地证书） | 推送证书（APNs Auth Key .p8）由推送网关持有，移动端不接触 |
| 分发 | TestFlight 内测（build 上传后 1-2 日生效）→ App Store Connect 审核（App Review，平均 1-3 日） | 2026 年 iOS 26 时代审核政策以官方为准 |
| 深链 | Universal Links（关联域）或 `crish://` 自定义 scheme（expo-router linking）；推送点击经 notification response → router.push | D4 §8.6 接线范式 |
| 后台限制 | iOS 后台 30s 后挂起网络；VOIP/音频类 entitlement 与 crish 场景不符，**不申请**；后台靠推送兜底 | D4 R7 风险项，本文 §5.2 能力矩阵展开 |
| 国内上架 | App Store 中国区无特殊 SDK 报备要求（无 360 加固/推送 SDK 登记类强制项）；需 ICP 备案（2023-09 起 App 备案制度，中国区上架必须） | 备案属于开发者主体合规，非技术项 |

#### 3.1.3 风险（iOS 特有，低）

- 审核对"远程控制/审批"类功能的隐私描述要求（App Privacy 标签：远程设备标识、网络数据）——隐私政策与 App Privacy 声明需在提交前备齐；
- TestFlight 外测人数上限（2026 年约 1 万人/内测 100 人，以官方为准）——内测用 EAS Update + TestFlight 内测组即可覆盖。

#### 3.1.4 iOS 中国区上架材料与流程清单

> 与 Android 国内渠道不同，iOS 只有"App Store 中国区"一个入口，但合规面（备案）与材料面一次备齐即可多区复用。

| 项 | 内容 | 时机 |
| --- | --- | --- |
| App 备案 | 工信部 App 备案（2023-09 起强制；中国区上架前必须完成，审核查备案号） | 与 Android 备案同主体一次办理，双端共用备案号（App 备案按应用维度，iOS/Android 可同号） |
| Apple Developer 账号 | 公司主体需 D-U-N-S；$99/年；Team 角色管理（推送/分发权限分离） | P1 启动即办 |
| 隐私政策 URL | App Store 审核必填；内容覆盖推送令牌采集（与国内渠道同一份政策，按渠道补充） | 提交前备齐 |
| App Privacy 声明 | App Store Connect 填"数据收集/用途"表单（网络数据、设备标识、粗略位置等如实声明） | 提交前备齐 |
| 截图与元数据 | 6.7"/6.5" 两套截图 + 文案（中英）；类目选择（工具/效率） | 提交前备齐 |
| TestFlight 内测 | 内部测试（100 人，无需审核）+ 外部测试（Beta 审核）；与 EAS Update 灰度通道配合 | P1 联调期即启用 |
| 审核时间线 | 提交后 1-3 日；被拒典型原因：隐私声明不符、深链能力未声明、后台能力误声明 | 预留 1 周缓冲 |
| APNs 检查 | App ID 开启 Push Notifications；APNs Auth Key（.p8）交给推送网关（§6.2），App 内由 expo-notifications 读取 deviceToken | 构建前配置 |

### 3.2 Android 路线（无争议，简述确认 + 国内分发差异）

#### 3.2.1 结论

**Android = 同一 Expo SDK 57 工程（与 iOS 同仓同代码），官方一等支持。** 差异集中在**国内分发渠道**与**厂商推送**两件事，其余（构建/签名/调试）无分叉。

#### 3.2.2 构建与签名事实

| 项 | 事实/做法 | 说明 |
| --- | --- | --- |
| 支持面 | Expo 官方矩阵：Android 7.0+（API 24），compileSdk/targetSdk 36（2026 上架达标） | D4 §2.3 |
| 构建 | EAS Build 生成 AAB（Google Play 要求）与 APK（国内渠道部分要求）；国内商店 2026 年普遍已接受 AAB，个别渠道仍要求 APK | 分渠道产物策略见 §7.2 |
| 签名 | EAS 托管 keystore；国内渠道要求**同一签名**（渠道多包名可不同，签名建议统一，避免换签无法覆盖更新） | 包名策略：`com.crish.mobile`（海外）+ 渠道专用包名按需 |
| targetSdk | targetSdk 36（Android 16）；2026 年 8 月起 Google Play 强制 targetSdk 36；国内主流商店要求 33+（逐年上浮） | D4 §3.2.2 已论证 |

#### 3.2.3 国内分发渠道差异（应用宝 / 小米 / 华为 / OPPO / vivo）

| 渠道 | 包体要求 | 签名/加固 | 推送 | 合规要点 | 审核周期 |
| --- | --- | --- | --- | --- | --- |
| 腾讯应用宝 | APK（≤2GB 宽松）；部分类目收 AAB | 建议腾讯乐固加固（可选） | 应用宝无独立厂商通道（设备走各厂商通道） | 需软著（游戏类强制，工具类视类目）+ ICP 备案号 | 1-3 日 |
| 小米应用商店 | APK/AAB | 小米加固（可选）；**推送必须接小米推送 SDK 否则上架审查受限** | 小米推送（MiPush） | 隐私政策 + 权限声明逐项 | 1-3 日 |
| 华为应用市场（Android 版） | APK（4.x 设备侧） | **华为对"使用华为推送的 App"有对接检查**（应用内需集成 HMS Push 才能过审，2023 年后政策） | HMS Push（华为 4.x 设备） | 隐私政策 + 权限 + 软著（视类目）；**账号体系若用华为账号登录需 OAuth 审核**（crish 无此需求） | 1-5 日 |
| OPPO 软件商店 | APK/AAB | OPPO 加固（可选）；推送需接 OPPO Push | OPPO Push | 隐私政策 + 权限 | 1-3 日 |
| vivo 应用商店 | APK/AAB | vivo 加固（可选）；推送需接 vivo Push（vivo 对未接推送的 IM/消息类 App 有上架限制） | vivo Push | 隐私政策 + 权限 + 软著（视类目） | 1-3 日 |
| 荣耀应用市场 | APK/AAB | 推送需接荣耀推送（2024 年独立运营后） | 荣耀 Push | 隐私政策 + 权限 | 1-3 日 |

**共同强制项**（2023 年 9 月《关于开展移动互联网应用程序备案工作的通知》后）：
1. **ICP 备案**：App 必须在工信部备案（以开发者主体备案，Android 全渠道通用）；
2. **隐私政策**：必须在 App 内可查、声明推送令牌/设备信息采集用途（D7 §8.5 已列为合规项）；
3. **软著**：多数渠道工具类 App 需提供软件著作权证书（或受理证明）方可过审；
4. **隐私合规检测**：各渠道均跑自动化隐私检测（权限调用频次、SDK 收集行为），厂商推送 SDK 必须在隐私政策中声明。

#### 3.2.4 国内 ROM 生态对 crish 的影响（预告 §8.4）

国内 Android 的碎片化不仅指厂商推送，还包括**厂商省电策略对 WS 长连接的系统性杀进程**（MIUI/HyperOS、ColorOS、OriginOS、MagicOS 的自启动管理/后台冻结/省电模式）。这不是 crish 能"修"的问题，只能"绕"：推送兜底 + 引导用户加白名单 + 前台服务策略（§5.2、§8.4）。

#### 3.2.5 国内渠道包体与加固决策

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 包体预算 | 国内 AAB ≤ 80MB、国际 ≤ 60MB（沿用 D4 §9.5 性能预算） | 渠道对包体无硬性统一上限（应用宝等 ≤2GB），但包体影响转化；Hermes + 资源裁剪即可达标，不需要渠道特供包 |
| 加固 | **P1 不接入任何第三方加固**（乐固/360 加固等） | crish 客户端无核心机密（令牌在 Keychain/Keystore，引擎在桌面）；加固引入的兼容风险（厂商推送 SDK 与加固冲突是真实坑）大于收益；各渠道加固均为"可选"非"强制" |
| 签名 | 全渠道同一 keystore | 换签导致老用户无法覆盖更新；keystore 备份走团队 Secret 管理（丢失 = 灾难，写入工程纪律） |
| 渠道标识 | 渠道号（channel）写入 BuildConfig/Manifest metadata，上报推送网关与统计 | 推送网关按渠道路由（§6.2 设备注册表）；统计区分各商店来源；实现 = EAS 构建环境变量注入，无需多 flavor |
| 产物形态 | Google Play = AAB；国内五渠道 = 同 AAB 或 APK（按各渠道 2026 年实际要求，多数已收 AAB） | 一套代码、一套签名、多产物打包脚本（CI 内生成） |
| 隐私合规包 | 隐私政策（含推送 token/设备信息声明）+ 权限清单（仅通知/网络，§5.6）+ 各渠道隐私检测报告导出 | 一次性材料，五渠道复用；华为/小米对推送 SDK 的对接检查以"已在应用内集成其推送 SDK"为满足（P1 厂商推送即覆盖） |

### 3.3 HarmonyOS 路线（重点深挖）

#### 3.3.1 事实盘点（2026-08-09 查证）

**3.3.1.1 系统版本与生态现状（zh.wikipedia.org/wiki/HarmonyOS，2026-08-09 查证）**

| 版本 | 性质 | AOSP 兼容 | 对应 API（OpenHarmony 口径） | 备注 |
| --- | --- | --- | --- | --- |
| HarmonyOS 1.0-4.3 | AOSP 时代 | ✅ 可跑 Android APK | API 9（4.x 时代上限） | 华为应用市场同时分发 APK 与 HAP；4.3（2024-11）与 NEXT 先锋版双轨销售（Mate 70 时代） |
| **HarmonyOS 5.0（NEXT）** | **纯血鸿蒙** | ❌ 不能原生跑 APK | API 12-15（5.0.0=12，5.0.1=13） | 2024-10-22 发布、2025-03-20 正式推送；华为应用市场只上架鸿蒙原生应用 |
| HarmonyOS 5.1 | 纯血 | ❌ | API 18 | 2025-03 发布 |
| HarmonyOS 5.2 | 纯血 | ❌ | API 19 | 2025 年内发布 |
| **HarmonyOS 6.0** | 纯血 | ❌ | API 20 | 2025-10-22 正式发布 |
| **HarmonyOS 6.1** | 纯血 | ❌ | API 24 | 2026-04-20 发布 |
| **HarmonyOS 7.0** | 纯血 | ❌ | API 26 | 2026-06-12 开发者版本（54 天前，当前最新开发线） |

生态数字（同来源）：2024 Q1 鸿蒙中国市场份额 17%，首次超过 iOS 成为中国第二大移动平台；截至 2024-06 活跃设备 9 亿；2025-10 HarmonyOS 6.0 发布，2026 年 6 月 7.0 开发者版本推出。

> 版本-API 对应口径说明：上表"对应 API"列 5.0→15、6.0→20、6.1→24、7.0→26 来自维基百科版本表；5.0.1=API 13 来自 RNOH 官方环境搭建文档（compile SDK 5.0.1(13)）；5.1/5.2 的 API 编号（18/19）为社区普遍认知口径，**以华为官方 SDK 版本说明为准**（RNOH 0.82 线的实际编译基线为 5.0.1/API 13，本文工程决策不受 5.1/5.2 API 编号精确值影响）。

**推论（对 crish 的意义）**：
1. **HarmonyOS 4.x 存量设备**（Mate 60 系列等大量在役设备）：crish Android APK 可直接覆盖，零额外开发——但 4.x 设备会随时间自然衰减（华为持续推进 NEXT 升级）；
2. **NEXT（5.0-7.0）设备**：必须原生鸿蒙应用。2026-08 时间点，NEXT 已经是华为新机默认系统，**不做鸿蒙原生 = 放弃华为新机用户**；
3. 华为应用市场（NEXT 专区）只收鸿蒙原生应用 → 上架门槛是"必须是 HAP"。

**3.3.1.2 RNOH 现状（React Native OpenHarmony，2026-08-09 实查 npm registry + GitCode）**

| 事实项 | 证据 | 结论 |
| --- | --- | --- |
| 核心仓库 | `gitcode.com/CPF-RN/ohos_react_native`（原 `openharmony-sig/ohos_react_native`，OpenHarmony React Native SIG 维护；381 stars / 480 forks / 5.69K commits / 131 tags / 43 members，README 称"基于 React Native 生态的 OpenHarmony 适配项目"，MIT） | **组织化维护、非个人玩具项目**；仓库已从 Gitee 迁至 GitCode（国内可访问，CI 友好） |
| npm 包 | `@react-native-oh/react-native-harmony`（dist-tags 实查：`latest=0.82.30`、`0.82-stable=0.82.30`、`0.77-stable=0.77.71`、`0.72-stable=0.72.140`、`0.61=0.61.16`、`0.84-rc=0.84.2`；月下载约 9.5K）；ohpm 侧为 `@rnoh/react-native-openharmony`（前端包与原生包版本号对齐） | **多版本线并行**（0.61/0.72/0.77/0.82/0.84），0.82 为当前稳定线、0.84 为 RC 线 |
| 发布节奏 | 0.82 线 release notes：0.82.18（2026-03-12）→ 0.82.30（2026-04-23）→ 0.82.31（2026-05-07）→ 0.82.32（2026-06-11）→ 0.82.33（2026-07-23）；0.84 线 v0.84.3（2026-07-23） | **月级发布节奏，2026-07 仍活跃**（距查证日 17 天） |
| 版本对应 | RNOH 版本线命名对齐上游 RN 次版本（0.82 线 ↔ RN 0.82）；**RN 最新稳定 0.86（Expo 57）超出 RNOH 支持线约 4 个 minor**；0.84 为 RC 未达 stable | **RNOH 滞后上游 2-4 个 minor 是常态**（社区实践文档亦确认"RN/RNOH 版本基线不匹配"是鸿蒙适配头号问题） |
| 能力面 | Fabric 架构支持、TurboModule、CAPI（C-API 架构，`RNOH_C_API_ARCH=1`）、NDK 文本测算、Hermes 并发 GC、Metro 热加载（8888 端口 + hdc 端口转发）、release 双包（.har 源码版 / release2.har 字节码版）；稳定性修复汇总按 0.72/0.77/0.82 各线维护 | **工程化程度高**：与上游 RN 新架构对齐，有正式 release 产物与稳定性治理 |
| 编译基线 | 官方环境搭建文档：DevEco Studio 5.x + hdc；示例工程 compatibleSdkVersion `5.0.1(13)`（HarmonyOS 5.0.1 / API 13） | 基线 = HarmonyOS 5.0.1+，兼容 NEXT 全系（5.x/6.x/7.x 向下兼容） |
| 三方库生态 | GitCode `usage-docs` 仓（三方库适配文档镜像，137 stars）；npm 上可见 `@react-native-ohos/*` 系列（vision-camera 等）、`@ohmi/*`（奥米：pager-view、datetimepicker 等）、`@bingtang-rn/*`（notification-sounds、simple-biometrics 等，2026-07-30 仍发布）、`@tuya-oh/*`（涂鸦定制 fork）；老 `react-native-oh-library` GitHub 组织下 299 个仓中大量三方库 port 已 archive | **生态活跃但碎片化**：多家公司各自维护 fork 与 port，无统一 npm 官方源；老组织存档不代表死掉（核心已迁 GitCode），但三方库选型需审计 |
| 生产案例 | 涂鸦（Tuya 定制 fork `@tuya-oh/react-native-harmony`）、奥米（OHMI 系列包）、bingtang-rn（多库持续发布）、Eclipse Oniro（`eclipse-oniro4openharmony/app-rnoh-example`，RNOH 用于 Oniro/OpenHarmony 发行版） | **有真实生产使用**（以物联网/智能家居厂商为主）；社区 AI 语料（Gemini/DeepSeek/GLM）已收录 RNOH 排查经验（官方 README 明示） |
| Expo 兼容 | **RNOH 官方文档无 Expo 支持**（环境搭建文档演示的是 `react-native init` 裸工程 + harmony 宿主工程流程）；社区两条桥：① `expo-harmony-cli`（npm，2026-08-05 仍更新，v0.2.5，**基线 Expo SDK 52**，`prebuild --platform harmony` 生成 harmony/ 原生工程）；② `TomWq/react-native-harmony-adapter-skill`（2026-03，真实 Expo Router 项目迁移经验沉淀：expo-router/expo-linking/expo-font/图标字体/TurboModule 桥接等） | **Expo 与鸿蒙的桥是社区维护、基线落后**（SDK 52 vs 我们 SDK 57）；官方不承诺 |

**3.3.1.3 其他候选路线现状（2026-08-09 查证）**

| 候选 | 现状事实 | 证据 |
| --- | --- | --- |
| ArkUI 原生 | HarmonyOS 官方一等开发范式（ArkTS + ArkUI 声明式 UI + DevEco Studio 5.x/6.x）；NEXT 上架必须 HAP；系统能力（推送/后台/卡片/元服务）原生直达 | 华为官方开发者文档（developer.huawei.com），JS 渲染站点，本文标注"以官方文档为准" |
| uni-app / uni-app x | **官方已支持纯血鸿蒙**："一套代码可发布到 iOS、Android、鸿蒙 Next、Web、各小程序"；uni-app x 另有 UTS 语言（Vue 3 语法）；扫码 demo 需鸿蒙 NEXT 手机 | uniapp.dcloud.net.cn（2026-08-09 查证，"uni-app 已支持纯血鸿蒙开发"） |
| Taro | Taro 4.x 提供 `@tarojs/plugin-platform-harmony`（鸿蒙端插件），React 语法可编译到鸿蒙 | taro-docs.jd.com（页面 JS 渲染，正文以社区文档为准） |
| Flutter | **Google 官方明确无 OpenHarmony/HarmonyOS 支持计划**（flutter/flutter#178206 2025-11 以 not_planned 关闭："flutter itself has not plans for this"）；社区 OpenHarmony SIG `flutter_flutter`/`third_party_flutter`（openharmony/third_party_flutter 2026-08-05 仍在推送，OpenHarmony-TPC 组织 2026-05 新建 flutter_flutter/flutter_engine/flutter_packages 镜像） | GitHub issues + repo 实查 |
| 壳 + WebView | HarmonyOS NEXT 的 WebView（@kit.ArkWeb）可承载 Web 页面；但：无法在 NEXT 上运行 RN/Expo（无 JSC/Hermes 宿主支持）——"壳"只能是**纯 Web 应用**（H5 + 原生壳） | 系统能力事实 |

#### 3.3.2 候选路线对比（四候选 × 九判据）

| 判据 | ① RNOH | ② ArkUI 原生 | ③ uni-app/Taro | ④ Flutter(社区) | ⑤ 壳+WebView |
| --- | --- | --- | --- | --- | --- |
| React 栈代码复用 | **★★★★★**（同一 RN 生态） | ✗（ArkTS，双份代码） | ★★（Taro 支持 React 语法但 DSL 受限；uni-app 是 Vue） | ✗（Dart，双份代码） | ★★★（复用 Web 前端，但 crish 没有 Web 端） |
| TS 类型面复用（shared-types 契约铁律） | **★★★★★**（同一 TS 编译产物） | ✗（需双源或生成 ArkTS，违背"禁止双源漂移"） | ★★（Taro 可引 npm 包但编译链兼容性存疑） | ✗（Dart 无法消费 TS 类型） | ★★★★（Web 侧可复用 JS/TS） |
| 状态机/网络层/协议层复用 | **★★★★★** | ✗ | ★★★ | ✗ | ★★★★ |
| 平台能力直达（推送/后台/深链/生物认证） | ★★★（TurboModule 桥接，部分官方 port 缺失需自建） | **★★★★★**（原生一等） | ★★★（官方适配层，深度能力受限） | ★★★（SIG 维护，平台插件滞后） | ★★★★（原生壳可补） |
| 维护活跃度 | ★★★★（月更，SIG 组织化） | ★★★★★（华为官方） | ★★★★★（DCloud/京东官方） | ★★（SIG 非官方，滞后） | ★★★（自研壳） |
| 版本跟进（RN 0.86/Expo 57） | ★★（滞后 2-4 minor，Expo 不支持） | —（无版本概念） | ★★★（跟随各自生态） | ★★（滞后） | ★★★★ |
| 发布渠道（华为应用市场 NEXT） | ★★★★（HAP 可上架，与原生无差别） | ★★★★★ | ★★★★ | ★★★★ | ★★★★ |
| 团队能力匹配（React 栈） | **★★★★★** | ✗（需 ArkTS 技能，团队零积累） | ★★（Taro 可，uni-app 不可） | ✗ | ★★★（Web 技能） |
| 长期架构风险 | ★★★（生态碎片化、上游非官方） | ★★★★（官方但绑定华为） | ★★★（DSL 层抽象，能力天花板） | ★★ | ★★（体验降级） |
| **总分（加权：复用 40% / 能力 25% / 风险 20% / 团队 15%）** | **≈4.4（最高）** | ≈2.3 | ≈2.8 | ≈2.0 | ≈3.2 |

#### 3.3.3 候选逐一裁决论证

**候选 ① RNOH —— 采用（主路线）。**
- **代码复用是压倒性优势**：crish 的移动端核心价值是"远程伴侣"（审批/事件流/文件浏览/推送），其 80% 以上的工作量在协议层、状态层与 UI 层——这些全部是平台无关的 RN/TS 代码（D4 §4.1 的分层保证：UI → 状态 → 数据 → 网络/存储单向依赖，且网络层只用 RN 内建 WebSocket/fetch，不碰 Expo 特有 API）。鸿蒙端复用它意味着**一套 UI、一套状态机、一套协议**，与"ArkUI 双份代码"在维护成本上差一个数量级。
- **生态活跃度可支撑生产**：0.82 稳定线月级发布（最近 0.82.33 于 2026-07-23）、0.84 RC 线在途、官方 release 包（含字节码版）与稳定性治理齐备；涂鸦/奥米等公司有生产 fork；Eclipse Oniro 将 RNOH 用于发行版。
- **风险被识别并有对策**：版本滞后（→ 鸿蒙端独立版本线，见 §3.3.5）、三方库碎片化（→ 依赖面收窄纪律，见 §4.3）、ArkTS 缺口（→ 自研 TurboModule 桥 + compat wrapper，工作量可控且被社区验证）。

**候选 ② ArkUI 原生 —— 否决为"唯一路线"，采纳为"局部增强选项"。**
- 否决理由：与 React 栈零复用，协议/状态/UI 三层的 TypeScript 契约（`@crish/shared-types` 生成面、zustand 状态机、事件解析器）在 ArkTS 侧无法直接消费——要么双源维护（违反 D4 §2.2"禁止双源漂移"铁律），要么做代码生成器把 TS 契约生成 ArkTS（新增一条生成链，成本不亚于 RNOH 工程本身）。对 crish 这种"UI 是列表 + 表单"的伴侣应用，ArkUI 的性能优势无感，双份代码的维护成本是实打实的。
- 保留价值：① 鸿蒙端**元服务**（服务卡片/原子服务）可作为"审批快捷卡片"类 P3 增强，用 ArkUI 写一个 50 行的卡片页，收益/成本比高；② 若 RNOH 在某个版本线遭遇阻塞性缺陷，ArkUI 只重建"配对 + 审批"两个核心页作为应急回退（§9.4 回退预案）。

**候选 ③ uni-app / Taro —— 否决。**
- uni-app：Vue 栈，与 React 栈断裂；`@crish/shared-types` 的 TS 类型与解析器无法被 Vue 侧消费；团队 React 心智零迁移收益。且 uni-app 的鸿蒙端是"编译到 ArkTS 的 DSL"，深度系统能力（后台保活、推送 token、WebSocket 保活细节）受框架抽象层限制。
- Taro：虽支持 React 语法，但其本质是"小程序编译框架"，鸿蒙端插件（plugin-platform-harmony）的组件/API 覆盖度针对小程序语义（页面栈、小程序生命周期），对 crish 需要的原生长连接、推送点击深链、本地 SQLite、后台任务等能力需大量 escape hatch；编译链（Taro DSL → ArkTS）多一层抽象，排障成本高。**结论：为鸿蒙引入一套全新框架层，收益（React 语法）小于直接上 RNOH（本来就是 React Native 生态）**。

**候选 ④ Flutter（社区）—— 否决。**
- Google 官方明确无计划（flutter/flutter#178206，2025-11，not_planned）；OpenHarmony SIG 分支滞后上游、无官方保障；Dart 与 TS 类型面断裂（同 ArkUI 问题）；对 crish 无任何既有资产可复用。除非团队未来整体迁移 Flutter，否则无入场理由。

**候选 ⑤ 壳 + WebView —— 否决（作为产品形态），但保留"降级通道"价值。**
- crish 无 Web 前端（桌面是 Tauri WebView，但不是可独立运行的 Web 产品）；为鸿蒙造一个 H5 伴侣页 = 全新产品面，且 H5 无法做到 WS 保活、无法在后台收推送（仍需原生壳 + Push Kit），等于"原生壳 + H5 双份 UI"，比 RNOH 更差。
- 降级通道价值：若鸿蒙端 RNOH 工程短期无法交付，**"原生壳 + 最小 Web 审批页（推送深链直达审批操作）"可作为 P2 的应急最小集**（只覆盖审批一个场景，UI 复用未来的 Web 面板资产——P3 本来就有 Web 面板计划，D1 §2.2.3）。

#### 3.3.4 HarmonyOS 路线裁决（正式）

```
┌─────────────────────────────────────────────────────────────┐
│  HarmonyOS 技术路线裁决（M1 结论）                             │
│                                                             │
│  主路线：RNOH（React Native OpenHarmony）独立 bare RN 工程    │
│    - RN 版本线：锁定 RNOH 0.82 稳定线（@react-native-oh/     │
│      react-native-harmony@0.82-stable + ohpm 对齐包）         │
│    - 工程形态：JS 侧 bare RN 工程（复用 monorepo 共享包）      │
│      + harmony/ 宿主工程（DevEco Studio，Stage 模型，         │
│      RNAbility/RNApp，CAPI 架构，Hermes bundle）             │
│    - 共享面：协议层 / 状态层 / UI 层 三层全共享（§4）          │
│    - 差异面：compat wrapper + 自研 TurboModule（§4.3 映射表） │
│                                                             │
│  局部增强（P3）：元服务/服务卡片（ArkUI 50 行级小页）           │
│  —— 审批到达卡片、run 状态卡片（可选）                        │
│                                                             │
│  应急回退（P2 阻塞时）：原生壳 + 最小 Web 审批页（§9.4）        │
└─────────────────────────────────────────────────────────────┘
```

裁决依据（决策矩阵加权得分最高 4.4/5，九判据中复用面五维满分）：

1. **复用率第一原则**：crish 移动端是"轻客户端"（无引擎、无本地业务写），代码重心天然在可复用层；RNOH 把鸿蒙的边际成本压到"原生壳 + 适配层"（估 0.5-0.7×iOS，§10.3），而 ArkUI/Flutter 的边际成本是"全套重写"（1.5-2.0×iOS）；
2. **团队能力**：React 栈（桌面前端 + Expo 移动端 + shared-types 生成面），RNOH 是唯一能保留全部心智与工具链的路线；
3. **契约铁律**：D4/D8 的"单一真源 + 禁止双源漂移"只有 RNOH（TS 消费同一契约）能无损满足；
4. **生态现实**：RNOH 组织化维护 + 月更 + 生产案例，风险可控；Expo 不支持鸿蒙是结构性事实，绕不开也不值得绕（见下节）。

#### 3.3.5 RNOH × Expo 冲突的解法（鸿蒙独立工程 + 共享代码层）

**冲突本质**：
- Expo SDK 57 锁定 RN 0.86；RNOH 稳定线 0.82、RC 线 0.84 —— **RN 0.86 不在 RNOH 任何支持线上**；
- Expo 生态（expo-* 模块、config plugins、EAS）只面向 iOS/Android；社区 expo-harmony-cli 的基线是 Expo SDK 52（比我们低 5 个 SDK 大版本），不可作为生产基线；
- 结论：**"同一个 Expo 工程跑三平台"不存在**。必须鸿蒙独立工程。

**解法（双工程 + 三层共享）**：

```
apps/crish-mobile/          ← Expo SDK 57 工程（iOS + Android，D4 既定）
  ├── app/                  （expo-router 文件路由）
  ├── src/                  （业务代码：store/data/network/db/notifications…）
  └── plugins/              （厂商推送 config plugin 等）

apps/crish-mobile-harmony/  ← bare RN 工程（RN 0.82 + RNOH，鸿蒙专属）★新增
  ├── src/                  （业务代码：与 apps/crish-mobile/src 共享大部分文件）
  ├── harmony/              （DevEco Studio 宿主工程：RNAbility/RNApp/PackageProvider）
  └── compat/               （Expo API → 鸿蒙实现 的 compat wrapper，§4.3）

packages/                   ← 共享包（三端共同消费，不新增双源）
  ├── shared-types/         （协议/事件/错误码类型 + 生成面解析器）
  └── protocol-core/        （D8 规划的跨端协议 schema + 纯函数）
```

**两条工程纪律（实现硬约束）**：

1. **共享代码零 Expo 依赖**：`apps/crish-mobile/src/` 中任何 import 了 `expo-*` 的文件，不得被鸿蒙工程直接引用——要么移到共享包（纯逻辑），要么在鸿蒙侧提供 compat wrapper 同名导出（§4.3 映射表）。用 ESLint 规则（`import/no-restricted-imports` 或自定义 rule）强制：鸿蒙工程 import 解析时禁止命中 `expo-*`（除白名单 wrapper）。
2. **鸿蒙版本线独立演进**：鸿蒙工程锁 RNOH 0.82 线，**不与 Expo SDK 同步升级**；共享包（shared-types/protocol-core）保持"RN 版本无关"（纯 TS，无 RN import），三端可以各自锁定不同的 RN minor。RNOH 0.84/0.86 线成熟后再评估鸿蒙端升级（不阻塞 iOS/Android 升级节奏）。

**版本滞后对共享层的影响评估**：RN 0.82 vs 0.86 的差异集中在 New Architecture 内部（Fabric/Codegen）、原生模块 API 面；**纯 JS 业务代码（zustand/网络/组件树）在 0.82-0.86 间基本可移植**（React 19.2.3 在 RN 0.82 线为 React 18.2/19 兼容态——RNOH 0.72 文档演示用 React 18.2.0，0.82 线已跟进 React 19 生态，实施时以 RNOH 官方模板为准）。这是双工程可行的技术前提。

**深链/推送/后台差异在鸿蒙侧的落地**（预告 §5-6）：推送 = 华为 Push Kit（TurboModule 桥接或社区 port）；深链 = HarmonyOS App Linking/深链 linkTag（RNAbility 的 onNewWant 接收）；后台 = NEXT 的后台任务策略（推送兜底为主）。

#### 3.3.6 RNOH 工程形态与集成路径（实施级概览）

以下为 RNOH 0.82 官方环境搭建文档（2026-08-09 实查）归纳的工程要素与集成步骤，供 PE 系列任务书直接引用；精确版本以实施时 `npm view @react-native-oh/react-native-harmony dist-tags` 实时查询为准（官方版本说明明确"稳定版随迭代前移，不在文档写死"）。

**工程五要素**：

| 要素 | 说明 | 证据来源 |
| --- | --- | --- |
| JS 侧 RN 工程 | `npx react-native@<线> init` 生成的 bare RN 工程；示例文档用 0.72.5 演示，0.82 线用 `0.82-stable` 对齐 | RNOH 环境搭建文档"创建 React Native 工程" |
| 鸿蒙化 npm 依赖 | `npm i @react-native-oh/react-native-harmony@0.82-stable`；metro.config.js 合并 `createHarmonyMetroConfig` | 同左"安装鸿蒙依赖包" |
| harmony/ 宿主工程 | DevEco Studio 创建 Empty Ability 工程（Stage 模型，compile SDK 选 API 13 起）；`ohpm i @rnoh/react-native-openharmony@<同号>`；改造 `EntryAbility` 继承 `RNAbility`、页面挂 `RNApp`、新增 `RNPackagesFactory.ets`、C++ 侧 `CMakeLists.txt` + `PackageProvider.cpp`（so 命名 `rnoh_app`） | 同左"创建鸿蒙工程/在原生工程中集成RNOH" |
| 环境变量 | `RNOH_C_API_ARCH=1`（CAPI 架构）、hdc 工具链 path、`HDC_SERVER_PORT`；npm 镜像建议华为云（`repo.huaweicloud.com/repository/npm/`） | 同左"环境搭建" |
| bundle 与加载 | `react-native bundle-harmony --dev` 生成 `bundle.harmony.js` + assets 到 rawfile；或 Metro 热加载（8888 端口 + `hdc rport tcp:8888 tcp:8888`）；`AnyJSBundleProvider` 支持 Metro/文件/资源三来源 | 同左"加载bundle包" |

**集成步骤（顺序执行）**：

```
1. 初始化 JS 工程（bare RN，RN 版本 = RNOH 目标线，如 0.82 线）
2. npm i @react-native-oh/react-native-harmony@<线>-stable
3. metro.config.js 合并 createHarmonyMetroConfig（指定 harmony 包名）
4. DevEco 创建 harmony/ 宿主工程（Empty Ability，compile SDK API 13+）
5. ohpm i @rnoh/react-native-openharmony@<与 npm 包同号>
6. 改造宿主：EntryAbility → RNAbility；Index.ets → RNApp（appKey 必须与
   AppRegistry.registerComponent 名称一致，否则白屏）
7. C++ 接线：CMakeLists（rnoh_app so + RNOH_CPP_DIR）+ PackageProvider.cpp
8. 注册三方/自研 TurboModule：RNPackagesFactory.ets + PackageProvider 双登记
9. 签名（AGC 自动签名）→ 真机运行；debug 走 Metro、release 走本地 bundle
10. release 打包：选择 .har（源码版）或 release2.har（字节码版，官方主推）
    —— 字节码版需 build-profile.json5 开 useNormalizedOHMUrl
```

**CAPI 架构说明**：RNOH 0.82 线主推 C-API 架构（`enableCAPIArchitecture: true`），是 RNOH 对 ArkTS 原生桥的性能路径（NDK 直通，替代早期 napi 桥）；`enableNDKTextMeasuring: true` 必须开（NDK 文本测算）。自研桥（§4.3）应优先按 CAPI 路径实现，这与 Expo Module API 的 New Architecture（Nitro）思路同构，桥接代码的架构心智可迁移。

**版本对齐纪律（升级时）**：npm 侧按 dist-tag 取线内最新稳定版；ohpm 侧无 dist-tag，必须用具体版本号且**与 npm 包同号**（官方"前端包与原生包版本号对齐"规则）；升级先看对应版本线的 `RN升级需要开发者适配整理.md` 与 `上游社区不兼容变更.md`（官方文档维护了升级适配清单）。

#### 3.3.7 RNOH 社区生产实践与坑位清单（源自真实迁移经验）

> 来源：`TomWq/react-native-harmony-adapter-skill`（2026-03 创建，README 描述其沉淀自真实 Expo Router 业务项目迁移）+ RNOH 官方 FAQ/稳定性文档（2026-08-09 实查）。以下坑位是"Expo/RN 业务项目迁鸿蒙"的高频共性问题，P2 任务书应逐条设置冒烟用例。

| # | 坑位 | 现象 | 对策（写进 P2 验收） |
| --- | --- | --- | --- |
| K1 | RN/RNOH 版本基线不匹配 | 编译失败/运行期异常（Codegen 产物与宿主版本不一致） | 锁 RNOH 线内版本；升级走官方"版本升级指导"；CI 加版本对齐断言（npm dist-tag vs package.json） |
| K2 | Expo 运行时假设与鸿蒙宿主能力不一致 | Expo 模块直接 import 报错/白屏 | 零 Expo 依赖纪律 + compat wrapper（§4.3）；ESLint restricted-imports 强制 |
| K3 | 三方库"装了没接线" | 原生模块 undefined（TurboModule 未在 RNPackagesFactory/PackageProvider 注册） | 鸿蒙工程默认零三方原生库（§4.3）；确需引入时双登记（ArkTS + C++）清单化 |
| K4 | 导航依赖集合漂移 | expo-router/react-navigation 依赖链在鸿蒙侧解析混乱 | 鸿蒙侧路由方案独立锁定（§4.3 建议 react-navigation 或自研轻路由），不跟随 Expo 依赖链 |
| K5 | 图标字体/启动资源 | 白框图标、字体加载失败 | expo-font 字体文件随 bundle 资源加载，路径处理按社区迁移经验（TomWq skill 专项）；启动图用宿主资源 |
| K6 | Metro 连不上真机 | 真机白屏（开发期） | Metro 8888 端口 + `hdc rport` 端口转发；真机需填局域网 IP（`HARMONY_METRO_HOST` 环境变量可显式指定，expo-harmony-cli 先例）；production 用本地 bundle 规避 |
| K7 | 启动白屏（appKey 不匹配） | RNApp 的 appKey 与 AppRegistry 注册名不一致 | 启动冒烟用例固定；appKey 常量集中管理（共享包导出） |
| K8 | 自定义模块未桥接 | JS 调原生方法报 "not implemented" | 自研桥统一走 CAPI + PackageProvider 双登记；桥接 API 面冻结为 §4.3 五个接口 |

**生产案例信号汇总**（评估 RNOH 生产可用性的证据链）：涂鸦智能维护定制 fork（`@tuya-oh/react-native-harmony`，0.72 线持续发布）；奥米（OHMI）发布多款鸿蒙 port（pager-view/datetimepicker 等）；bingtang-rn 组织 2026-07-30 仍发布适配包（notification-sounds/simple-biometrics 等）；Eclipse Oniro 发行版内置 RNOH（`eclipse-oniro4openharmony/app-rnoh-example`）；RNOH 官方 README 明示其语料已进入 Gemini/DeepSeek/GLM（社区排障生态存在）。**结论：RNOH 已达到"可生产、有纪律地使用"的状态，但必须配合本文的依赖收窄与冒烟清单纪律，不可裸奔。**

### 3.4 统一技术矩阵（三平台）

| 维度 | iOS | Android | HarmonyOS（NEXT） |
| --- | --- | --- | --- |
| 工程 | `apps/crish-mobile`（Expo 57） | 同左（同工程） | `apps/crish-mobile-harmony`（bare RN 0.82 + RNOH） |
| UI 运行时 | RN 0.86（Fabric） | RN 0.86（Fabric） | RN 0.82（RNOH Fabric/CAPI） |
| 语言 | TypeScript strict | TypeScript strict | TypeScript（JS 侧）+ ArkTS（宿主壳侧） |
| 状态管理 | zustand v5 + immer（共享） | 同左 | 同左（共享） |
| 导航 | expo-router v6 | expo-router v6 | react-navigation（或轻量自研路由，compat 层定） |
| 本地存储 | expo-sqlite | expo-sqlite | 鸿蒙 relationalStore/SQLite（compat wrapper） |
| 安全存储 | expo-secure-store（Keychain） | expo-secure-store（Keystore） | 鸿蒙 KeyStore（CAPI 桥） |
| 网络 | RN 内建 WebSocket/fetch | 同左 | 同左（RNOH 提供 WebSocket 支持，实施期验证） |
| 推送 | APNs（expo-notifications） | FCM/厂商（expo-notifications + 厂商插件） | Push Kit（自研桥） |
| 深链 | Universal Links/scheme | App Links/scheme | App Linking/linkTag |
| 生物认证 | Face ID/Touch ID | Biometric（指纹/人脸） | 鸿蒙 userIAM（指纹/3D 人脸） |
| 构建 | EAS Build | EAS Build（分渠道产物） | DevEco Studio + hvigor |
| 签名 | Apple 证书 + APNs key | 统一 keystore（渠道复用） | AGC 自动签名 |
| 商店 | App Store（中国区备案） | Google Play + 国内五渠道 | 华为应用市场（NEXT 专区） |
| 热更新 | EAS Update | EAS Update（国内受限，自托管 P2） | 无（走商店发版；bundle 随 HAP） |
| 版本线 | SDK 57（RN 0.86） | SDK 57（RN 0.86） | RNOH 0.82 线（独立演进） |
| 测试 | jest-expo + 真机 | jest-expo + 真机矩阵（§8） | jest（RN 通用）+ DevEco 真机（§8.3） |
| 阶段 | P1 | P1 | P2（NEXT 原生）；4.x 设备 P1 由 Android APK 覆盖 |

---

## 4. 共享代码策略与共享边界

### 4.1 共享原则（继承 D8 §0.2）

1. **共享的是纯逻辑与平台无关代码**：无 DOM、无 Tauri、无 Expo 特有 API、无 ArkTS API——共享包被依赖链强约束（depcruise 禁止 packages 依赖 apps、禁止 apps/mobile-harmony 依赖 expo-*）；
2. **单一真源**：协议 schema 真源在 Rust 注册表 JSON → 生成器 → TS 生成面（`scripts/generate-engine-bindings.mjs` 与 D8 规划的 `generate-protocol-bindings.mjs`），三端消费同一生成产物，禁止手写双份；
3. **共享不等于同构**：三端各自持有平台差异层（原生适配器/权限/推送注册/深链），共享层只定义接口（`PushAdapter`、`SecureStoreAdapter`、`DatabaseAdapter` 等抽象），平台层实现。

### 4.2 共享边界图

```
┌────────────────────────────────────────────────────────────────┐
│                      平台差异层（不共享）                          │
│                                                                │
│   iOS 端（Expo）        Android 端（Expo）     鸿蒙端（RNOH）      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ 原生模块/配置   │    │ 原生模块/配置   │    │ harmony/ 宿主工程   │  │
│  │ APNs 注册     │    │ FCM/厂商注册   │    │ Push Kit 桥       │  │
│  │ 深链表        │    │ 深链表        │    │ App Linking 桥    │  │
│  │ 通知权限      │    │ 通知通道/权限  │    │ 通知 slot/权限     │  │
│  │ Keychain     │    │ Keystore     │    │ KeyStore 桥       │  │
│  │ SQLite(原生)  │    │ SQLite(原生)  │    │ relationalStore 桥│  │
│  │ 生物认证      │    │ 生物认证      │    │ userIAM 桥        │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
└──────────┬──────────────────┬──────────────────────┬───────────┘
           ▼                  ▼                      ▼
┌────────────────────────────────────────────────────────────────┐
│               UI 层（三端共享的 React 组件树）                      │
│   屏幕/列表/审批卡/事件行/连接横幅/设置页（D4 §4.2 模块面）           │
│   约束：组件只消费 zustand store 与共享类型，不 import expo-*       │
├────────────────────────────────────────────────────────────────┤
│               状态层（三端共享的 zustand stores）                  │
│   authStore/connectionStore/approvalStore/sessionStore/          │
│   eventStore/terminalStore/settingsStore（D4 §4.4 七个域）        │
├────────────────────────────────────────────────────────────────┤
│               数据/网络层（三端共享）                               │
│   WsGateway/ReconnectingWsClient/WsEnvelope/HttpClient/          │
│   repositories/outbox（离线队列）/游标追平（D4 §6）                 │
│   约束：网络层只用 RN 内建 WebSocket + fetch（RNOH 已支持）          │
├────────────────────────────────────────────────────────────────┤
│               协议层（三端共享，跨端契约真源）                       │
│   @crish/shared-types（events/permissions/orchestration/        │
│   run-control/errors/stored-event…）+ generated/engine 解析器     │
│   @crish/protocol-core（D8：跨端协议 schema + 纯函数）             │
│   —— Rust 注册表 JSON → 生成器 → 三端消费                          │
└────────────────────────────────────────────────────────────────┘
                ▲ 全部层只依赖共享包与平台无关代码
                └────── 唯一例外：compat wrapper 层（§4.3）
```

### 4.3 Expo 特有 API → 鸿蒙侧映射表（compat wrapper 清单）

鸿蒙工程引用 `apps/crish-mobile/src` 中的业务代码时，凡命中 Expo 特有 API 的模块，按以下映射处理（**实施时在鸿蒙工程内建立 `compat/` 目录，同名导出以替换 import 解析**；ESLint restricted-imports 强制）：

| 业务代码中的 Expo 依赖（D4 选型） | 鸿蒙侧方案 | 类型 | 说明 |
| --- | --- | --- | --- |
| `expo-router`（路由/深链） | react-navigation（RNOH 社区有 port 记录）或轻量自研 Stack/Tabs（场景仅 5 Tab + 3 详情页，自研 300 行内可行） | compat 替换 | 深链接收在宿主侧（RNAbility onNewWant → 事件 → 路由跳转） |
| `expo-sqlite`（事件/审批/会话缓存） | 鸿蒙 relationalStore（ArkTS）经自研 TurboModule 桥，暴露与 expo-sqlite 同形 API（`openDatabaseAsync/runAsync/getAllAsync` 子集） | 自研桥 | 业务层 DAO 只依赖薄接口，桥内实现差异 |
| `expo-secure-store`（令牌/指纹/设备密钥） | 鸿蒙 KeyStore（CAPI/ArkTS）自研桥，暴露 `getItemAsync/setItemAsync` 同形 API | 自研桥 | 安全存储语义对齐（不可迁移、系统加密） |
| `expo-notifications`（推送/本地通知） | Push Kit（@kit.PushKit）自研桥 + 本地通知能力 | 自研桥 | 见 §6 推送矩阵；桥暴露 `getPushToken/setNotificationHandler` 同形 API |
| `expo-local-authentication`（本机解锁 P2） | 鸿蒙 userIAM（生物认证）自研桥 | 自研桥 | P2 功能，P1 可不接 |
| `expo-camera`（扫码配对 P2） | 鸿蒙扫码能力（scanKit 或相机 + 解码）或 P1 维持手动输入（D4 已定 v1 手动输入先行） | 自研桥/延后 | 配对 P1 是手动 IP+PIN，扫码 P2 再定 |
| `@react-native-community/netinfo` | 鸿蒙 connectivity 监听自研桥（或轮询降级） | 自研桥 | 仅用于"网络恢复触发重连"，降级可接受 |
| `expo-task-manager`（后台通知任务） | NEXT 后台任务受系统限制，**推送优先**；P1 不做 headless 任务 | 不做（降级） | 与 iOS 行为对齐（iOS 也不做） |
| `expo-constants/device`（设备信息） | 宿主注入（RNAbility context）或静态常量 | 注入 | 信息面小，不做桥 |
| `expo-font`（图标字体） | 字体文件随 bundle 资源加载（RNOH 支持资源加载；社区迁移经验：图标字体需处理 Harmony 资源路径差异） | compat 处理 | TomWq 迁移 skill 有专项经验可参考 |
| `zustand` / `immer` / `@crish/shared-types` / `@crish/protocol-core` | **直接共享**（纯 JS/TS，无平台 API） | 共享 | 无需任何 wrapper |

**依赖面收窄纪律（鸿蒙端）**：RNOH 三方库生态碎片化（§3.3.1.2），鸿蒙工程**默认零第三方原生库**，凡社区 port 不成熟的库一律自研桥或降级功能；新增鸿蒙原生依赖须过"适配审计"（版本线对应、维护记录、真机冒烟），写入鸿蒙工程的 `dependencies.md`。

### 4.4 平台差异层接口定义（共享层只认接口）

| 抽象接口 | 定义位置（共享包或 apps 共享代码） | iOS 实现 | Android 实现 | 鸿蒙实现 |
| --- | --- | --- | --- | --- |
| `PushAdapter`（R2A 借鉴点：IPushAdapter 思路） | 共享（`pushRegistration.ts` 之上） | APNs via expo-notifications | FCM/厂商 via expo-notifications + 厂商插件 | Push Kit 自研桥 |
| `SecureStore` | 共享 | expo-secure-store | expo-secure-store | KeyStore 桥 |
| `Database`（DAO 接口） | 共享 | expo-sqlite | expo-sqlite | relationalStore 桥 |
| `BiometricAuth` | 共享 | expo-local-authentication | expo-local-authentication | userIAM 桥 |
| `DeepLinkHandler` | 共享 | expo-router linking | expo-router linking | RNAbility want 分发 |
| `AppState/NetInfo` | 共享 | expo + RN | expo + RN | RNOH 内建 + 桥 |

接口只定义"业务层需要的语义"（如 `getToken(): Promise<string>`、`upsertEvent(ev)`），实现差异（通道、权限、生命周期）完全隔离在平台层——这是三端共享代码能够成立的**结构性保证**。

### 4.5 共享代码目录级映射（实施落地）

> 目标：`apps/crish-mobile/src` 的业务代码与鸿蒙工程 `src` 尽量同构；实施时以"目录级复用清单"驱动，而非逐文件搬运。以下为 D4 §4.3 目录树（移动端）在鸿蒙工程的映射裁决。

| 目录（D4 §4.3） | 内容 | 鸿蒙工程处理 | 说明 |
| --- | --- | --- | --- |
| `src/store/`（7 个 zustand store + selectors） | 纯逻辑 | **整目录复用** | 零平台 API；鸿蒙工程经 monorepo 引用或文件同步（见 §4.6） |
| `src/network/`（WsGateway/ReconnectingWsClient/WsEnvelope/HttpClient/EndpointResolver） | 纯逻辑 + RN 内建 WebSocket/fetch | **整目录复用** | RNOH 需真机验证 WS 支持面（§5.8 风险项；若缺口则桥接） |
| `src/data/`（repositories/outbox） | 纯逻辑 + DAO 接口 | **整目录复用** | DAO 依赖 `src/db` 的接口而非 expo-sqlite 实现 |
| `src/pairing/`（pairMachine/qrPayload/pairProtocol） | 纯逻辑 | **整目录复用** | 扫码 P2 时相机模块走桥 |
| `src/utils/`（ansi/time/id） | 纯逻辑 | **整目录复用** | — |
| `src/db/`（schema/migrations/dao/secureStore） | expo-sqlite / expo-secure-store | **半复用**：schema/migrations/DAO 复用；`secureStore.ts` 与 SQLite 打开逻辑替换为 compat 桥（§4.3 同形 API） | 迁移数组（`migrations.ts`）三端共用，数据模型不漂移 |
| `src/notifications/`（pushRegistration/notificationHandler/deepLink） | expo-notifications | **不直接复用**：重写为 `PushAdapter` 语义 + 平台注册（iOS/Android 实现保留在 Expo 工程；鸿蒙实现走 Push Kit 桥） | 业务通知策略（D7 场景映射、静默时段、折叠）抽成纯函数入共享包 |
| `src/components/`（ui 与业务组件） | React 组件 | **整目录复用** | 依赖 expo-router 的导航组件（Header/跳转）经"路由适配层"替换（§4.3） |
| `app/`（expo-router 文件路由） | 路由与页面 | **不复用**：鸿蒙侧用 react-navigation/轻量路由重建同构路由表 | 路由表常量（`crish://approval/<id>` 等深链格式）入共享包，两端共用同一深链解析器 |
| `src/types/`（env 等） | Expo 环境变量 | 鸿蒙侧改为宿主注入 | — |

**鸿蒙工程建议结构**（PE 任务书可裁剪）：

```
apps/crish-mobile-harmony/
├── package.json / tsconfig.json / metro.config.js     # 独立 npm 工程（§4.6）
├── index.js                                           # AppRegistry 注册（appKey 与宿主 RNApp 对齐）
├── harmony/                                           # DevEco 宿主工程（git 托管，不入 node_modules）
│   ├── entry/src/main/ets/                            # RNAbility/RNApp/RNPackagesFactory
│   ├── entry/src/main/cpp/                            # CMakeLists + PackageProvider
│   └── build-profile.json5 / oh-package.json5
├── src/                                               # 与 apps/crish-mobile/src 共享的代码（§4.6 引用方式）
├── compat/                                            # 平台差异层：SQLite/KeyStore/PushKit/DeepLink/NetInfo 桥 + 路由适配
├── app/                                               # 路由重建（路由表引用共享常量）
└── __tests__/                                         # jest（RN 通用 preset）
```

### 4.6 双工程 monorepo 接线要点（npm workspaces 与 RN 双版本冲突）

**核心冲突**：Expo 工程锁 RN 0.86，鸿蒙工程锁 RN 0.82——**react-native 双版本不能同时 hoist 到根 node_modules**（D8 §3.1 的 npm workspaces 方案只描述了单一移动端工程的情形）。裁决与对策：

| 方案 | 描述 | 裁决 |
| --- | --- | --- |
| A. 鸿蒙工程进入根 workspaces | 根 node_modules 出现 RN 双版本 hoisting 冲突（npm 按依赖图决定，无法可靠共存 0.86/0.82） | **否决**（除非实施时验证 npm overrides 可稳定收敛，作为 B 的备选） |
| B. **鸿蒙工程独立 npm 项目**（不进根 workspaces 列表） | `apps/crish-mobile-harmony` 自持 package.json + lockfile + node_modules；共享包（`@crish/shared-types`、`@crish/protocol-core`）经 `workspace:` 协议或 `file:` 引用其**预构建产物**（dist + 类型声明） | **采用**。共享包在根 workspaces 中构建（`npm run build -w @crish/shared-types`），鸿蒙工程消费 dist；依赖方向单向（鸿蒙工程 → 共享包 dist，共享包不得依赖鸿蒙工程） |
| C. 共享代码文件级复制 | 把 `src/store|network|data|pairing|utils|components` 复制进鸿蒙工程 | **否决**（双源漂移，违反 D8 单一真源纪律；测试/类型漂移不可控） |

**B 方案的三个落地细节**：

1. **共享包消费形态**：`@crish/shared-types` 已是 TS 源码包（桌面/移动端经根 workspaces 直接消费）；鸿蒙工程独立 node_modules 无法解析 workspace 协议源码。解决：共享包增加"构建面"（`tsc` 产出 dist + `exports` 字段指向 dist），根 workspaces 与鸿蒙工程各自消费（根走源码、鸿蒙走 dist——**用"构建产物 + 契约漂移检查"防双源**：鸿蒙工程 CI 在共享包变更后重构建 + `git diff --exit-code`，与 D8 §5.3 协议一致性门禁同一机制）；
2. **纯逻辑抽取**：凡鸿蒙工程需要的共享逻辑（store/network/data/pairing/utils 中不含 RN import 的部分）逐步下沉到 `packages/protocol-core` 或新增 `packages/mobile-core`（纯 TS，无 RN 依赖），让鸿蒙工程的 dist 引用面更干净——**长期演进方向：移动端共享逻辑持续向共享包迁移，两个 app 壳只留 UI 与平台接线**；
3. **CI 接线**：根 CI 不动（D8 §9.4 快/中层）；新增鸿蒙独立 CI job：`(根: build shared-types) → (鸿蒙工程: npm ci + typecheck + lint + jest) → (契约漂移检查)`；鸿蒙 job 不跑 EAS（EAS 不支持鸿蒙，§7.1）。

**双工程开发流**：共享逻辑改在根 workspaces 开发（桌面 + Expo 双端消费即保证正确性）；鸿蒙工程只在其"平台差异面"（compat/、app/、harmony/）开发；`npm run dev:harmony`（Metro 8888 + hdc 转发）与 `npm run dev:mobile`（Expo）并存于根脚本（D8 §6.3 脚本组织扩展）。

---

## 5. 能力差异矩阵

> 每项：iOS 行为 / Android 行为 / HarmonyOS 行为 / 统一抽象建议。标注"P1 范围"或"降级"的项为三端均可接受的最小集。

### 5.1 推送通道

| 维度 | iOS | Android | HarmonyOS NEXT | 统一抽象建议 |
| --- | --- | --- | --- | --- |
| 系统通道 | APNs（Apple Push Notification service） | 海外：FCM；国内：华为 HMS Push / 小米 / OPPO / vivo / 荣耀（无 GMS） | 华为 Push Kit（@kit.PushKit，系统级推送服务） | `PushAdapter.getToken()` + 推送网关按 `(platform, channel, token)` 路由（§6） |
| 令牌获取 | APNs deviceToken（EAS 托管） | FCM token 或厂商 token（国内无 GMS 时厂商 SDK 取） | Push Kit token（AGC 开通推送服务后获取） | 统一 `PushToken { platform, channel, token, appVersion }` 上报推送网关 |
| 令牌轮换 | 系统滚动（APNs token 变化） | FCM 定期轮换；厂商 token 有效期各异 | Push Kit token 有效期（以官方为准） | `addPushTokenListener` 统一监听（D4 §8.2-6） |
| 权限 | 首次弹窗（系统级，一次性） | Android 13+ 运行时通知权限（需先建通知通道） | NEXT 通知权限（系统弹窗） | 引导时机统一（配对成功后提示），文案三端一致 |
| 前台展示 | 前台 handler 自绘横幅 | 同左（通道重要性控制） | 同左（slot 控制） | D4 §8.7 前台 handler 语义三端一致 |
| 后台展示 | 系统通知（通知中心） | 系统通知（通道） | 系统通知（slot） | 审批类高优先级 + 声音（D7 P0 语义） |
| 静默推送 | 后台静默（限制严格） | 数据消息（厂商差异大） | 受限（NEXT 以通知消息为主） | **不依赖静默推送**，一律走通知消息 + 点击深链 |

### 5.2 后台任务与长连接保活（crish 场景核心差异）

crish 场景：桌面 run 在跑、手机要能收到审批推送；手机与桌面之间的 WS 长连接（在线直推）只在前台有意义。

| 维度 | iOS | Android | HarmonyOS NEXT | 统一抽象建议 |
| --- | --- | --- | --- | --- |
| 前台长连接 | WS 保持，无限制 | WS 保持，无限制（但 Doze 浅眠期可能延迟） | RNOH 前台 WS（社区已有多端 WS 使用记录；实施期验证 NEXT 前台网络策略） | 前台 `ReconnectingWsClient` 三端同一实现 |
| 切后台（30s 内） | 允许短暂运行 | 允许（前台服务可延长） | NEXT 对后台任务有系统管控（应用切后台后任务冻结策略，以官方文档为准） | 统一语义：**后台不保活 WS**，切后台即进入"推送兜底"态（D4 §8.7 既定） |
| 长期后台 | 30s 后挂起，无例外（无 VOIP 等 entitlement） | Doze + 厂商省电（杀进程概率高，ROM 差异大） | NEXT 后台管控（与 iOS 类似的收紧策略 + 华为"自启动管理"） | **三端一致：不依赖后台长连接**；审批送达 = 厂商推送；决策送达 = outbox + 前台重连重放 |
| 用户主动"锁后台"引导 | 无此概念（系统托管） | MIUI/ColorOS/OriginOS/MagicOS 需引导：自启动 + 省电白名单 + 锁定最近任务 | 鸿蒙自启动管理（设置页引导） | 三端设置页统一"后台保活指引"入口（Android/鸿蒙差异化文案） |
| 前台服务（延长运行） | 不适用 | 可申请（通知常驻），crish 无音频/定位场景，**不申请** | NEXT 前台任务类型受限（音视频/定位等），crish 不适用 | 不引入前台服务 |
| 定时唤醒 | 不适用（系统托管） | WorkManager（受 Doze 延迟） | 受限（后台任务系统管控） | 不做定时同步；数据新鲜度靠"打开 App 全量刷新"（D4 仪表盘 30s 轮询仅前台） |
| 杀进程后冷启动 | 系统可能杀，冷启动深链（getLastNotificationResponse） | 厂商杀后台，冷启动深链（notification response） | NEXT 杀后台，冷启动深链（want 接收） | D4 §8.6 三形态（前台/后台/冷启动）深链语义三端统一 |

**结论**：crish 的在线/离线模型（D1 §3.4、D4 §6.5）在三个平台都能成立，**不需要任何平台的后台长连接特权**——这是本方案刻意设计的"平台中立后台策略"：在线体验靠前台 WS，离线送达靠推送，决策不丢靠 outbox。

### 5.3 文件访问

| 维度 | iOS | Android | HarmonyOS NEXT | 统一抽象建议 |
| --- | --- | --- | --- | --- |
| 应用沙箱 | 严格沙箱（app container） | 应用私有目录 + 共享存储（需权限） | NEXT 应用沙箱（与 OHOS 沙箱规则一致） | 移动端只做"浏览桌面文件"（远程能力），本地文件面极小（SQLite/缓存），无需系统级文件权限 |
| 桌面文件浏览 | 不适用（远程） | 不适用（远程） | 不适用（远程） | 全部走 WS 网关 `workbench_list_directory/read_file_content`（D4 §5.7），三端无本地文件权限需求 |
| 本地附件/分享 | 不涉及（v1 无上传下载） | 不涉及 | 不涉及 | v1 范围外（D4 §1.3 非目标） |

### 5.4 生物认证

| 维度 | iOS | Android | HarmonyOS NEXT | 统一抽象建议 |
| --- | --- | --- | --- | --- |
| 系统能力 | Face ID / Touch ID | 指纹/人脸/屏下指纹（BiometricPrompt） | 鸿蒙 userIAM（指纹/3D 人脸，能力依赖设备） | `BiometricAuth` 接口：`isAvailable()` / `authenticate(reason)` |
| 应用场景 | 本机解锁（P2，D4 §5.8"安全-本机解锁"） | 同左 | 同左 | P1 不做；P2 三端同一 `BiometricAuth` 抽象 |
| 失败策略 | 系统兜底（密码） | 系统兜底 | 系统兜底 | 统一：认证失败回退系统解锁，不本地存储密钥明文 |

### 5.5 深链

| 维度 | iOS | Android | HarmonyOS NEXT | 统一抽象建议 |
| --- | --- | --- | --- | --- |
| 协议 | Universal Links（https 关联域）+ 自定义 scheme | App Links + scheme | 华为 App Linking（深链）+ linkTag 自定义 scheme | 深链统一格式 `crish://approval/<toolCallId>`（D4 §8.3 data.url）；三端注册各自的 scheme/链接入口 |
| 冷启动恢复 | `getLastNotificationResponse()` | notification response intent | 宿主 onNewWant + 启动参数解析 | `DeepLinkHandler.resolve(initialLink)` 三端同形 |
| 白名单 | 路由白名单校验（D4 §8.6） | 同左 | 同左 | 三端同一路由白名单实现（共享纯函数） |
| 桌面配对二维码 | `crish://pair?inv=…`（D1 §3.5） | 同左 | 同左 | 同一载荷格式；扫码 P2（鸿蒙侧 scanKit 或延后手动输入） |

### 5.6 权限模型

| 权限域 | iOS | Android | HarmonyOS NEXT | 统一抽象建议 |
| --- | --- | --- | --- | --- |
| 通知 | 单一系统开关（一次性请求） | Android 13+ 运行时权限 + 通道级控制 | NEXT 通知权限（系统开关） | 统一"配对成功后引导开启通知"流程（D4 §5.1）；通道/slot 细分（approval/run/security/general，D4 §8.4）在 Android 与鸿蒙侧映射 |
| 网络（局域网） | 无需权限（访问局域网需本地网络权限 iOS 14+，App 声明即可） | 需 `ACCESS_NETWORK_STATE`/`INTERNET`（普通权限，自动授予） | NEXT 网络权限（普通权限自动授予；局域网发现能力以官方为准） | 三端普通权限清单固定，无运行时弹窗 |
| 相机（扫码 P2） | NSCameraUsageDescription | CAMERA 运行时权限 | 相机权限（ACL） | P2 统一处理；P1 手动输入无权限需求 |
| 生物认证 | 无额外权限（系统） | USE_BIOMETRIC | userIAM（普通权限） | 随 P2 生物认证功能统一处理 |
| 存储 | 沙箱无需 | 无需（v1 无本地文件权限需求） | 沙箱无需 | 三端零存储权限（v1） |

**统一结论**：crish v1 的运行时权限面 = **仅通知**（+ P2 相机/生物认证）。权限模型复杂度低是三端共享的一个隐藏红利。

### 5.7 本地存储与数据库

| 维度 | iOS | Android | HarmonyOS NEXT | 统一抽象建议 |
| --- | --- | --- | --- | --- |
| 业务库 | SQLite（expo-sqlite，WAL） | 同左 | 鸿蒙 relationalStore（ArkTS 原生 SQL 能力） | `Database` 接口 + DAO 层共享；鸿蒙桥暴露同形 API（§4.3） |
| 安全存储 | Keychain（expo-secure-store） | Keystore-backed EncryptedSharedPreferences | 鸿蒙 KeyStore | `SecureStore` 接口共享；密钥不可导出语义三端一致 |
| KV 设置 | expo-sqlite/kv-store | 同左 | 同左（经桥） | 三端同一 kv 接口 |
| 清理策略 | D4 §12.7 容量策略 | 同左 | 同左 | 共享纯函数（`pruneOldEvents(seq)` 等），三端定时器各自触发 |

### 5.8 网络与协议

| 维度 | iOS | Android | HarmonyOS NEXT | 统一抽象建议 |
| --- | --- | --- | --- | --- |
| WebSocket | RN 内建（原生实现） | 同左 | RNOH（基于鸿蒙网络栈的 WS 支持；实施期以 RNOH 官方能力表验证，必要时自研桥） | `ReconnectingWsClient` 三端同一实现；若 RNOH WS 有缺口，桥接鸿蒙 socket 能力 |
| TLS/证书固定 | 系统 CA + 自签 pinning（D4 §6.1.5） | 同左 | NEXT TLS 栈 + pinning（以官方文档为准） | 指纹固定逻辑共享（pair.host_fingerprint 语义一致） |
| 网络状态感知 | NetInfo | NetInfo | 桥/降级轮询 | 仅用于重连触发，降级可接受 |
| 心跳/重连/退避 | 共享实现 | 共享实现 | 共享实现 | 纯逻辑共享（D4 §6.2.4 指数退避 + 抖动） |

### 5.9 通知呈现（本地通知补充面）

| 维度 | iOS | Android | HarmonyOS NEXT | 统一抽象建议 |
| --- | --- | --- | --- | --- |
| 本地通知（审批超时重复提醒等） | UNNotification（expo-notifications 本地通知） | 同左 | NEXT 本地通知（notificationManager） | 经 `PushAdapter.localNotify()` 统一；鸿蒙桥内实现 |
| 通知点击去重/撤销 | dismissNotificationAsync | 同左 | 同左（桥内实现） | 审批已处理 → 撤销对应通知（D4 §8.7），三端统一语义 |
| 徽标 badge | 系统徽标 | 桌面徽标（启动器） | 应用角标（NEXT 支持） | 可选项，P2 评估 |

### 5.10 安全与合规横切差异

| 维度 | iOS | Android | HarmonyOS NEXT | 统一抽象建议 |
| --- | --- | --- | --- | --- |
| 数据加密存储 | Keychain（硬件级） | Keystore-backed（TEE） | 鸿蒙 KeyStore（硬件级） | 令牌/密钥三端同语义（不可导出、系统托管、随解锁可用）——`SecureStore` 接口即安全契约 |
| 备份策略 | iOS 备份/迁移可能带 Keychain（用户切换设备场景需评估令牌失效） | `allowBackup=false` 或加密备份；Keystore 密钥不入备份 | NEXT 备份策略（以官方为准） | 令牌绑定 deviceId + 服务器端吊销（D4 §5.2 令牌生命周期）——备份侧问题由"重新配对"收敛 |
| App 加固 | 无第三方加固概念（系统级防护） | 各渠道可选的加固服务（§3.2.5 决策：P1 不接） | AGC 安全检测/加固能力（以官方为准） | P1 不做主动加固；依赖平台默认防护 + 最小权限面 |
| 反调试/完整性 | 无内置；不引入 | 同左 | 同左 | 明确非目标（crish 客户端无核心机密，D5 安全模型已论证密钥在桌面） |
| 隐私法规 | 中国区：App 备案 + App Privacy；海外：GDPR/CCPA（若出海） | 中国区：备案 + 隐私检测 + SDK 清单；海外：同左 | 华为合规要求（权限最小化、隐私政策、合规 SDK 清单——华为对 NEXT 应用有专项合规审查） | 一份隐私政策模板按渠道出变体（§3.2.5 合规包）；推送 token 采集声明三端同文案 |
| 审计 | 引擎侧 security-audit 事件（D5 §0.1 D-09）三端同源 | 同左 | 同左 | 审计在桌面（权威侧），移动端只读投影——平台差异为零 |
| 网络传输 | WSS + 证书固定（D4 §6.1.5） | 同左 | WSS + pinning（NEXT TLS 栈，实施期验证） | 指纹固定逻辑共享；pinning 实现随平台 TLS 栈 |

### 5.11 电池与性能策略横切差异

| 维度 | iOS | Android | HarmonyOS NEXT | 统一抽象建议 |
| --- | --- | --- | --- | --- |
| 后台耗电 | 系统严格托管（后台 30s 挂起） | Doze + 厂商省电（§8.4） | NEXT 后台管控 | 统一：切后台即断 WS（省电即安全），回前台重连 |
| 低电量模式 | 系统级低电量模式（App 可检测） | Battery Saver | NEXT 省电策略 | P2 评估：检测低电量 → 降低轮询/心跳频率（R2A 旧代码 LocalHardwareService 思路，B 类借鉴点） |
| 渲染性能 | RN 0.86 Fabric | 同左 | RNOH Fabric/CAPI | 列表用 FlashList（RNOH 官方性能文档也推荐 FlashList 替代 FlatList）；事件流 100 条/秒预算（D4 §9.5）三端同标 |
| 包体 | ≤60MB（国际） | ≤80MB（国内）/≤60MB（国际） | HAP 体积（以 AGC 上架要求为准；RNOH 含 RN 运行时与 ArkTS 宿主，预计与 Android 相当量级，实施期实测） | 资源裁剪共享（Hermes + 资源压缩）；鸿蒙侧不重复开发 |

---

## 6. 推送矩阵（高层）

> 场景清单（13 个事件、P0 必达 6 类）与统一载荷（PushMessage：title/body/data{kind,url,seq,…}/priority）由 D7 定义；本矩阵只做**三平台通道层的高层方案**；通道级细节（SDK 版本、配额、后台任务、合规文案）归 **M8 推送通道细化**。

### 6.1 通道全景

```
                   桌面 daemon（引擎事件源）
                           │ 推送意图判定器（D7 §6）
                           ▼
                    推送网关（公网轻量服务）
        （设备注册表：platform + channel + token；D7 §4）
          │                │                │               │
          ▼                ▼                ▼               ▼
        APNs            FCM           厂商通道（聚合或直连）    Push Kit
     （iOS 海外+国内）  （Android 海外） （Android 国内：华为    （HarmonyOS
                                     HMS/小米/OPPO/vivo/     NEXT 原生）
                                     荣耀）
```

### 6.2 三平台通道方案概览

| 平台 | 通道 | 接入形态 | token 来源 | 服务端发送 | 备注 |
| --- | --- | --- | --- | --- | --- |
| iOS | APNs | expo-notifications（EAS 托管 APNs key）；国际与国内同一通道 | `getDevicePushTokenAsync`（APNs token） | 推送网关直连 APNs HTTP/2（或用 Expo Push Service 简化，P1 可选） | 无分叉；中国区 APNs 可达 |
| Android（海外） | FCM | expo-notifications（FCM v1 配置）+ Expo Push Service | FCM token | Expo Push Service API（简化）或网关直连 FCM v1 API | Google Play 渠道；D7 §8.5 P0 |
| Android（国内） | 厂商通道：HMS Push（华为 4.x 设备）/ 小米 / OPPO / vivo / 荣耀 | **自研 config plugin**（D4 §8.5）注入厂商 SDK；Expo Module API 读厂商 token | 各厂商 token | 网关直连各厂商开放 API（`push.cloud.huawei.com` 等）**或聚合通道（个推/极光）**——P1 推荐直连厂商 API（少一层依赖与合规面） | FCM 国内不可用（D7 结论）；UMS 无统一服务器（D7 §1.3 查证） |
| HarmonyOS 4.x 设备 | 与 Android 国内一致（**华为 HMS Push**） | 随 Android APK（HarmonyOS 4.x 兼容层跑 APK 时 HMS Push 可用） | HMS token | 同 Android 国内 | 4.x 用户 = Android 用户，无需额外通道 |
| HarmonyOS NEXT | **华为 Push Kit（@kit.PushKit）** | 自研 TurboModule 桥（AGC 开通推送服务；获取 push token；接收通知消息；本地通知） | Push Kit token（平台标识 harmony） | 网关走华为推送开放接口（Push Kit 服务端 API） | NEXT 上无 HMS Core 概念（HMS Core 服务面向 Android 侧）；Push Kit 是 NEXT 原生推送服务——实施时以华为 AGC 最新文档为准（M8 细化） |

### 6.3 统一抽象（跨四通道）

1. **设备注册表**（推送网关）：`deviceId → { platform: ios|android|harmony, channel: apns|fcm|hms|mi|oppo|vivo|honor|pushkit, token, appVersion, lastSeen }`；支持多 token（同一设备 FCM + 厂商并存时按上报选择）；
2. **统一载荷**：D7 §6.2 PushMessage 原样跨通道透传（厂商通道的 data 字段与 APNs payload 字段名统一映射）；`data.url` 是唯一路由真源（D4 §8.3）；
3. **统一降级**：任何通道失败（token 过期/配额/网络）→ 该设备降级为"打开 App 拉取"（WS 追平 + outbox 兜底），**推送永远只是加速器，不是正确性依赖**；
4. **审批专用语义**：审批类 P0 必达（D7 §3.2 S1-S4），三端通道均配置 high 优先级 + 声音 + 不折叠；同一 toolCallId 的多条推送去重（D7 §3.4.1）。

### 6.4 鸿蒙推送要点（NEXT，预告 M8）

- AGC 侧：华为开发者账号开通"推送服务（Push Kit）"，获取 App 的推送配置（client id/证书/签名相关）；
- 客户端：Push Kit 的 ArkTS 接口（`@kit.PushKit` 的 pushService）经自研桥暴露为 `PushAdapter`；NEXT 通知用 notificationManager（对应 Android 通知通道概念 = 鸿蒙通知 slot）；
- 服务端：推送网关对接华为推送开放接口（与 HMS Push 服务端 API 体系同源，NEXT 为统一推送服务接口）；
- 合规：推送令牌采集声明入隐私政策（同 Android 国内渠道要求）。

### 6.5 各通道接入步骤概览（高层，细节归 M8）

> 每通道给出"开通 → 客户端 → 服务端 → 验证"四步概览；精确 SDK 版本、配额与 API 细节由 M8 输出。

**① APNs（iOS，P1）**

```
1. 开通：Apple Developer 创建 App ID + 开启 Push Notifications + 生成 APNs Auth Key（.p8）
2. 配置：EAS 托管（credentials 上传 .p8）；expo-notifications config plugin 注册
3. 客户端：getDevicePushTokenAsync() → PushAdapter.getToken() 上报推送网关
4. 验证：TestFlight 构建 → 桌面触发审批 → 前台横幅/后台通知/冷启动深链三形态
```

**② FCM（Android 海外，P1）**

```
1. 开通：Firebase 项目 + Android App + google-services.json + FCM v1 Service Account
2. 配置：expo-notifications（FCM v1 凭据由 EAS/环境注入）
3. 客户端：getDevicePushTokenAsync()（返回 FCM token）→ 上报
4. 验证：Google Play 内测轨道 → 三形态 + Doze 行为
```

**③ 国内厂商通道（华为 HMS / 小米 / OPPO / vivo / 荣耀，P1）**

```
1. 开通：各厂商开放平台注册应用 + 申请推送服务（各需独立 App 标识/密钥）
2. 配置：自研 config plugin（D4 §8.5 withVendorPush.ts）注入各厂商 SDK 与
   manifest 声明（Service/Receiver）；华为另需 agconnect-services.json
3. 客户端：Expo Module API 自研原生模块读取各厂商 token；无 GMS 设备（华为等）
   上 FCM token 为空时走厂商 token
4. 服务端：推送网关按设备注册表路由 → 直连各厂商开放 API（推荐）或聚合通道
5. 验证：各厂商真机（§8.2 设备清单）→ 三形态 + 杀进程后送达
```

**④ Push Kit（HarmonyOS NEXT，P2）**

```
1. 开通：AGC 项目 + 应用 + 开通推送服务（Push Kit）→ 获取推送配置
2. 客户端：自研 TurboModule 桥（@kit.PushKit 的 pushService：获取 token、
   接收通知消息）+ notificationManager（本地通知/slot）
3. 服务端：推送网关对接华为推送开放接口（服务端 API）
4. 验证：NEXT 真机（Mate 70 等）→ 三形态 + 冷启动深链 + 杀进程送达
```

**统一验证基准（三端共用的推送验收用例）**：

| 用例 | 通过标准 |
| --- | --- |
| 前台推送 | 审批事件前台横幅展示（不打扰时吞掉） |
| 后台推送 | 系统通知到达（审批高优先级 + 声音） |
| 杀进程推送 | 任务管理器划掉后仍可达（厂商通道系统常驻） |
| 点击深链 | 冷启动/后台/前台三态均跳转审批卡 |
| 决策送达 | 深链页内决策 → outbox → 桌面确认 → 通知撤销 |
| 令牌轮换 | 重装/换机后新 token 上报、旧 token 网关清理 |

### 6.6 token 生命周期与轮换对比

| 通道 | 失效/变化场景 | 客户端处理 | 网关处理 |
| --- | --- | --- | --- |
| APNs | 设备恢复备份/重装/新设备 | `addPushTokenListener` 捕获变化（D4 §8.2-6） | 按 deviceId 更新 token；旧 token 标记失效 |
| FCM | 定期轮换（~6-12 个月）；App 卸载重装 | 同左 | 同左 |
| 厂商通道 | 各厂商规则不一（卸载重装/系统更新/关闭通知） | 同左 + 启动时主动核对 token 有效性 | 同左 + 发送失败回执（无效 token 自动清理） |
| Push Kit | 以华为官方规则为准（M8 查证） | 同左（桥内监听） | 同左 + 华为发送回执处理 |

**统一纪律**：token 是"可失效资产"，任何通道的发送失败/回执都必须进入网关的 token 生命周期管理（D7 §4 设备注册表的一部分）；客户端启动与配对完成两个时机强制刷新 token 上报。

---

## 7. 构建与发布矩阵

### 7.1 构建系统三平台事实

| 维度 | iOS | Android | HarmonyOS NEXT |
| --- | --- | --- | --- |
| 构建工具 | EAS Build（云）/ 本地 Xcode | EAS Build（云）/ 本地 Gradle | **DevEco Studio + hvigor**（鸿蒙官方构建工具链，无 EAS 支持） |
| EAS 支持 | ✅ 官方一等 | ✅ 官方一等 | ❌ **不支持**（EAS Build 仅 iOS/Android；EAS Update 仅 iOS/Android——已确认的官方事实面） |
| 构建产物 | .ipa | .aab / .apk（分渠道） | .hap → .app（App Pack，含 pack.info） |
| 构建配置 | eas.json profile（development/preview/production） | 同左 + 渠道 flavor | hvigorfile + build-profile.json5（products/targets/signingConfig） |
| CI 集成 | GitHub Actions 触发 EAS | 同左 | 本地/自建 runner 跑 hvigor（DevEco 命令行工具链；官方提供命令行 hvigorw，可进 CI） |
| 热更新 | EAS Update | EAS Update（国内网络不稳定，自托管 P2，D4 R10） | 无官方热更；bundle 随 HAP 发版（可自研"拉取远端 bundle"热更通道，P3 评估——RNOH 支持 FileJSBundleProvider/Metro 加载，具备技术前提） |

**裁决**：构建系统不统一（也无需统一）——iOS/Android 全走 EAS（D4 既定），鸿蒙走 DevEco/hvigor 独立管线，**三端构建互不阻塞**（D8 §0.2 原则：移动端发布独立于桌面端，同理鸿蒙发布独立于 iOS/Android）。

### 7.2 签名与密钥

| 维度 | iOS | Android | HarmonyOS |
| --- | --- | --- | --- |
| 签名体系 | Apple 开发者证书（Distribution）+ Provisioning Profile + APNs Auth Key（.p8，推送网关持有） | 统一 keystore（.jks）签名所有渠道包 | **AGC 自动签名**（DevEco Studio 登录华为账号，Signing Configs 自动生成/管理签名）或手动签名（.p12 + profile） |
| 推送凭据 | APNs key（App 级） | FCM Server Key / 各厂商 AppSecret 等（推送网关持有） | AGC 推送服务凭据（推送网关持有） |
| 密钥存储 | 开发者环境（EAS 加密存储 / 团队 Secret） | 同左 | 同左（DevEco 工程内 .certs 目录，不入库） |
| 轮换 | 证书到期前轮换（EAS 提醒） | keystore 永续（丢失即无法覆盖更新——keystore 备份纪律） | AGC 签名轮换（官方后台管理） |

### 7.3 商店上架流程对比

| 步骤 | iOS（App Store） | Android 海外（Google Play） | Android 国内（五渠道） | 鸿蒙（华为应用市场 NEXT 专区） |
| --- | --- | --- | --- | --- |
| 开发者账号 | Apple Developer（$99/年，公司主体需 D-U-N-S） | Play Console（$25 一次性） | 各渠道开发者账号（实名认证） | 华为开发者联盟（实名认证 + 企业认证按需） |
| 备案 | App 备案（中国区上架必须，工信部） | 不适用 | **App 备案（ICP，全渠道强制）** | App 备案（NEXT 上架同样适用） |
| 材料 | App 元数据 + 截图 + 隐私政策 + App Privacy | 同左 + 数据安全表单 | 软著/受理证明（类目相关）+ 隐私政策 + 权限声明 + 隐私检测报告 | 应用元数据 + 隐私政策 + 权限声明 + **鸿蒙应用审核（含"纯鸿蒙适配度"检查）** |
| 构建产物 | .ipa | .aab | .apk/.aab | .app（HAP 打包） |
| 审核重点 | 功能完整性、隐私、**后台能力声明**（BGTask/推送） | 政策合规、targetSdk | 隐私合规 SDK 扫描、**推送 SDK 对接检查**（华为/小米等） | 鸿蒙原生适配、隐私、权限最小化、**系统能力使用合规** |
| 上架速度 | 1-3 日（审核） | 数小时-2 日 | 1-5 日/渠道 | 1-7 日（NEXT 审核，含适配度检测） |
| 特殊项 | TestFlight 先内测 | 开放测试轨道 | 各渠道有"抢先体验"类目可选 | 华为应用市场对 NEXT 应用有"鸿蒙原生应用认证"推荐位激励（政策以官方为准） |

**统一版本同步策略**（对齐 D8 §7.3-7.4 三轨制）：
- **应用版本**：三端各自 semver + buildNumber；iOS/Android 由 EAS 管理，鸿蒙由 hvigor 管理；**功能对齐版本**（feature parity version）在 CI 中核对（三端 `appVersion` 语义一致，仅 build 号不同）；
- **协议版本**：唯一真源（注册表 schemaVersion 派生），三端握手协商 `contractVersion`（D4 §6.4）；**协议变更触发兼容矩阵门禁**而非连锁发布（D8 §7.4）；
- **兼容窗口**：移动端声明 `minProtocolVersion`；旧端连新桌面/新端连旧桌面按 D3 §10 版本化规则处理（拒绝并提示升级，D4 §10.3）；
- **发布节奏**：P1 期 iOS/Android 同版同发；P2 期鸿蒙滞后 iOS/Android ≤1 个功能版本（鸿蒙先保"审批+事件流"主链路，再追平）。

### 7.4 发布流水线（高层）

```
主仓 CI（门禁）        EAS Build（iOS/Android）    DevEco 管线（鸿蒙）
  typecheck/lint/test ──► profile: preview (内测)    hvigorw assembleHap
  expo-doctor          ├─► profile: production       → .app 打包
  协议漂移检查          │    ├─ App Store Connect     → AGC 上传
  (D8 §5.3)            │    │   (TestFlight 内测)     → 应用市场审核
                       │    └─ Google Play Console
                       └─► 国内渠道分发包
                            （应用宝/小米/华为/OPPO/vivo
                              + 隐私合规包）
```

### 7.5 灰度发布与回滚策略（三端）

| 平台 | 灰度手段 | 回滚手段 | 说明 |
| --- | --- | --- | --- |
| iOS | App Store 分阶段发布（7 天/12 小时档） | 提交修复版（App Store 无一键回滚）；新版本上架即旧版失效 | 严重缺陷的止损窗口 = 审核周期，靠内测充分性兜底 |
| Android 海外 | Google Play staged rollout（5%→100% 可调） | 同左（更新版本） | 平台能力最完整 |
| Android 国内 | 无官方灰度；用 EAS Update 灰度通道（按 update channel 分流量） | EAS Update 一键回滚（指向旧版本 bundle）；商店版本走新版本更新 | EAS Update 国内可达性（D4 R10）为 P1 风险项；若不可达，退化为"全量商店发布 + 快速修复版" |
| 鸿蒙 NEXT | 华为应用市场的灰度发布能力（以官方最新政策为准） | 商店版本机制（新版本更新；无 bundle 级热更） | P2 时点由 M8/PE 查证华为灰度细则 |

**版本同步纪律（跨三端）**：
- **功能对齐**：三端 `appVersion`（如 0.3.0）语义一致，`buildNumber` 各自独立（iOS=递增、Android=versionCode、鸿蒙=versionCode 语义）；
- **协议兼容**：任何一端版本发布前，CI 跑"协议版本兼容矩阵"（min/max 支持的 contractVersion，D8 §7.4）；不兼容组合在握手时拒绝并提示升级（D4 §6.4），**禁止静默降级**；
- **鸿蒙滞后窗口**：P2 期鸿蒙允许滞后 iOS/Android ≤1 个功能版本（§7.3 既定）；滞后 >1 个版本时触发"鸿蒙端发布计划重排"评审，防止永久性落后（§9.3 决策门）。

---

## 8. 真机测试矩阵

### 8.1 系统版本覆盖清单（2026-08 时点）

> 任务书原清单"iOS 17/18、Android 10-15、HarmonyOS NEXT 4.x/5.x"存在两处需修正的时点偏差：① iOS 19 已于 2025-09 发布（2026 年主流机型为 18/19）；② **HarmonyOS 4.x 不是 NEXT**（4.x 是 AOSP 兼容版，NEXT 从 5.0 起算），且 2026-08 时点 NEXT 已到 6.1（API 24）稳定线、7.0 开发者线（API 26，§3.3.1.1 查证）。以下为修正后清单。

| 平台 | 覆盖版本 | 说明 |
| --- | --- | --- |
| iOS | **17 / 18 / 19**（覆盖近三年系统；Expo 57 最低支持 16.4，测试面收缩到 17+） | 主流在役：18.x、19.x（新机默认 19）；17 作为"存量验证下限" |
| Android | **10 / 11 / 12 / 13 / 14 / 15 / 16**（task 书要求 10-15，2026 年 Android 16 已发布、targetSdk 36 对应之，需纳入） | 低版本（10-12）验证降级行为；13+ 验证运行时权限；16 验证 targetSdk 36 合规 |
| HarmonyOS | **4.2 / 4.3**（AOSP 兼容，跑 Android APK，仅回归"APK 兼容 + HMS 推送"）与 **NEXT 5.0 / 5.1 / 5.2 / 6.0 / 6.1**（原生 HAP 真机覆盖；7.0 开发者版按需抽样） | 4.x 由 Android 测试面覆盖；NEXT 5.0 作为最低 API 基线（RNOH 0.82 编译基线 5.0.1/API 13）；6.x 为主力覆盖线 |

### 8.2 真机设备清单（建议基线）

| 平台 | 机型（代表性） | 覆盖点 |
| --- | --- | --- |
| iOS | iPhone 15 / 16 / 17 系列（+ 1 台 SE 或老机型验证 iOS 17） | 系统 17/18/19、刘海/灵动岛 UI、APNs 三形态、后台挂起 |
| Android 海外 | Pixel 8/9（原生 Android 15/16） | FCM、Doze、深链、后台行为基准 |
| Android 国内 | 小米 15（HyperOS 2）、华为 Mate 60/70（HarmonyOS 4.2/4.3，APK + HMS）、OPPO Find X8（ColorOS）、vivo X200（OriginOS）、荣耀 Magic 7（MagicOS） | 厂商推送四通道、**厂商省电杀进程矩阵（§8.4）**、国内商店包验证 |
| HarmonyOS NEXT | 华为 Mate 70 / Pura 80 / Mate X6 等 NEXT 5.0-6.1 机型（2-3 台，覆盖 5.0 基线 + 6.x 主力） | RNOH 工程真机跑通、Push Kit、深链、后台策略、HAP 上架包验证 |
| 模拟器 | iOS Simulator / Android Emulator / DevEco 模拟器（x86_64 需 abiFilters 配置，RNOH 文档有先例） | CI 冒烟 + 开发期快速验证（真机为准） |

### 8.3 鸿蒙真机测试要点（RNOH 特有）

1. **hdc 链路**：真机调试用 hdc（OpenHarmony 调试工具，DevEco SDK toolchains）；Metro 热加载经 `hdc rport tcp:8888 tcp:8888` 端口转发（RNOH 官方环境文档流程）；
2. **签名**：真机运行需 AGC 签名（DevEco Signing Configs 自动签名，勾选 Support HarmonyOS）；
3. **bundle 三形态**：Metro（开发）/ 本地 bundle（rawfile，验证发布路径）/ 沙箱 bundle（hdc file send，调试专项）；
4. **release 验证**：字节码版 release 包（release2.har）路径必须真机验证（与源码版行为有差异面，官方文档明确两种包用法不同）；
5. **专项冒烟**：WS 长连接真机保活（前台）、推送点击冷启动深链、前台通知横幅、SQLite 桥写入、secure-store 桥令牌持久化（重启不丢）、RNOH 已知崩溃面（Modal/长列表，官方 FAQ 有清单）回归。

### 8.4 国内定制 ROM 后台限制风险（WS 长连接杀进程专项）

**问题本质**：crish 的在线体验依赖前台 WS；一旦切后台，Android 各厂商省电策略会以不同强度冻结/杀死进程。**在 crish 场景下，杀进程的直接后果不是丢数据（outbox + 游标追平兜底），而是"推送之外无感知、回前台需重连"——体验降级，不是功能损坏。** 但推送本身也依赖进程存活（厂商通道由系统侧常驻服务承载，App 被杀不影响推送送达——这是厂商推送存在的意义），因此风险等级为"中等，可管理"。

| ROM | 主要后台限制机制 | 对 crish 的影响 | 缓解动作 |
| --- | --- | --- | --- |
| MIUI / HyperOS（小米） | 自启动管理（默认禁止第三方自启）、省电策略（后台冻结）、最近任务锁定（加锁防清） | 切后台后 WS 快速断开；回前台重连 | 设置页引导：开启自启动 + 省电无限制 + 最近任务加锁（提供检测脚本/说明文案） |
| ColorOS（OPPO） | 智能后台管理（默认禁止自启 + 休眠冻结） | 同左 | 同左（应用管理 → 自启动/后台运行允许） |
| OriginOS（vivo） | 后台耗电管理（默认限制） | 同左 | 同左 |
| MagicOS（荣耀） | 自启动管理 + 后台清理 | 同左 | 同左 |
| HarmonyOS 4.x（华为） | 自启动管理（应用市场 App 上架后默认不自启） | 同左 | 同左（华为 4.x 引导走"应用启动管理"） |
| HarmonyOS NEXT | 系统级后台管控（应用切换后台后的任务策略，官方文档为准） | 同左（NEXT 管控更接近 iOS，无"厂商自启动"用户侧开关语义，以官方引导为准） | 同左（设置页引导文案按 NEXT 实际设置项生成） |
| 原生 Android | Doze/App Standby（系统托管，无厂商额外开关） | 温和；回前台即时重连 | 无需引导 |

**统一对策（跨 ROM）**：
1. **架构层**：在线模型不依赖后台存活（§5.2 结论）——后台即"推送兜底态"，回前台重连 + 游标追平 + outbox 重放（D4 §6.5 三层防御）；
2. **引导层**：设置页"后台保活指引"（一键检测：自启动权限/电池优化白名单/最近任务锁，输出检测结果 + 跳转设置项）；Android 上可用 `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 引导白名单（需权限声明，评估合规性后决定是否 P1 启用）；
3. **验收层**：真机矩阵包含"杀进程 → 推送到达 → 冷启动深链 → outbox 送达"全链路用例（三平台 × 主要 ROM，§8.2 设备清单覆盖）。

### 8.5 关键场景测试用例矩阵（场景 × 三平台）

> 以下 15 个关键场景为三端发布出口的**必测清单**（P1 覆盖 iOS/Android；P2 起鸿蒙同表执行）。每场景给出通过标准；"平台差异点"列明三端行为不一致处。

| # | 场景 | 通过标准 | 平台差异点 |
| --- | --- | --- | --- |
| T01 | 手动配对（IP + PIN） | 输入 → 校验 → 令牌持久化 → 进入主界面；重启免配对 | 无（鸿蒙宿主想定 P2 验证） |
| T02 | 配对码过期/错误 | 可读错误提示，可重试，无锁死误报 | 无 |
| T03 | 审批在线接收 | 桌面发起 → 前台秒见审批卡 → 允许/拒绝 → 卡片消失 | 无 |
| T04 | 审批离线决策 | 断网点允许 → outbox 入队 → 重连自动送达 → 桌面执行 | 无（outbox 三端同一实现） |
| T05 | 审批并发（桌面先处理） | 移动端收到"已处理"提示，不重复决策 | 无 |
| T06 | 审批超时 | 卡片置灰"已过期"；本地提醒通知（如启用） | 本地提醒实现随平台（§5.9） |
| T07 | 推送三形态 | 前台横幅 / 后台系统通知 / 杀进程冷启动深链直达审批卡 | iOS 前台需前台 handler；Android 13+ 需通道先行；NEXT 需 slot（§6.5 统一验证基准） |
| T08 | 事件流追平 | 断线期间事件 → 重连后按 sequence 补齐，无重复行 | 无 |
| T09 | 文件浏览 | 目录树/文本预览只读；无越权写入口 | 无 |
| T10 | run 控制（L2/L3） | 停止/强制取消生效，二次确认生效 | 无 |
| T11 | 权限弹窗链路 | 配对成功后通知权限引导；拒绝后设置页可重开 | iOS 一次性弹窗 vs Android 13+ 通道先行 vs NEXT 系统弹窗（§5.6） |
| T12 | 杀进程重启 | 冷启动 → 深链 or 主界面 → SQLite 缓存可读 → 重连追平 | 深链入口差异（§5.5） |
| T13 | 移除本机 | 令牌吊销 → 回配对页；SQLite 缓存保留 | 无 |
| T14 | 国内推送四通道 | 华为/小米/OPPO/vivo 真机各验三形态 + 杀进程送达 | 各厂商行为差异（§8.4） |
| T15 | 鸿蒙 NEXT 专项 | RNOH 工程冷启动、WS 前台保活、五桥冒烟、release2.har 包行为 | 仅鸿蒙（§8.3 清单） |

**测试数据纪律**：T03-T10 与桌面侧联合调试走 D4 §10.2 的标准联调矩阵（S1-S4：本机 LAN / Tailscale 远程 / 推送 / 回归联动）；每台真机建立"设备档案"（系统版本、ROM、厂商推送 token 有效性、杀进程行为记录），作为 §8.4 ROM 风险矩阵的实证数据源。

### 8.6 测试环境搭建差异

| 维度 | iOS | Android | HarmonyOS |
| --- | --- | --- | --- |
| 模拟器 | Xcode Simulator（iOS 17/18/19 系统镜像） | Android Emulator（API 26-36 镜像） | DevEco 模拟器（x86_64 需在 build-profile.json5 `abiFilters` 加 x86_64，RNOH 官方文档先例） |
| 真机调试 | Xcode + 数据线/WiFi | adb | hdc（DevEco SDK toolchains，需配 `HDC_SERVER_PORT`）+ AGC 签名 |
| 热加载 | Metro（Expo dev client） | Metro | Metro 8888 + `hdc rport tcp:8888 tcp:8888` 端口转发 |
| 日志 | Xcode Console / 系统日志 | logcat | hdc hilog + DevEco Profiler |
| 崩溃分析 | Xcode Crash / EAS Crash 报告 | Play 控制台 / 厂商崩溃通道 | DevEco tombstone + RNOH 稳定性分析流程（官方文档：重点看 libRNOH.so/libreact_nativemodule.so 符号） |
| CI 冒烟 | 无真机（jest-expo + 模拟器可选） | 无真机（同左） | 无真机（同左）；鸿蒙编译冒烟可进 CI（hvigorw 命令行，§7.1） |
| 网络联调 | 局域网直连桌面（D4 §10.2 S1-S4 矩阵） | 同左 | 同左（NEXT 真机连局域网；配对/审批/推送全链路） |
| 设备管理 | Apple 开发者设备注册（真机调试上限 100 台/年） | adb 无限制 | hdc 无限制（需华为账号签名） |

---

## 9. 风险与回退

### 9.1 风险清单（按影响 × 概率排序）

| # | 风险 | 影响 | 概率 | 缓解 |
| --- | --- | --- | --- | --- |
| H1 | **鸿蒙生态与市场策略不确定性**：NEXT 装机增速、华为应用市场政策（上架门槛/认证/推荐位）、未来版本 API 变更 | 鸿蒙端投入回报不确定 | 高（不可控） | **分阶段投资**（§9.3）：P1 不投入鸿蒙原生，4.x 由 Android 覆盖；P2 以"MVP + 快速验证"起步，用户/市场信号为正再追加投入 |
| H2 | **RNOH 版本滞后**（0.82 稳定 vs RN 0.86/Expo 57）：鸿蒙端长期落后 iOS/Android 2-4 个 minor；RNOH 升级时 Codegen/TurboModule 断裂 | 鸿蒙端功能面滞后；升级成本 | 高（结构性） | 鸿蒙版本线独立演进（§3.3.5）；共享层"零 Expo 依赖"纪律保证共享代码不因 RN minor 差异爆炸；RNOH 0.84/0.86 线成熟后按"评估-试点-升级"节奏跟进 |
| H3 | **RNOH 三方库碎片化/存档**：社区 port 质量参差、老 GitHub 组织大量 archive | 依赖不可用、排障困难 | 中 | 鸿蒙端默认零三方原生库（§4.3 纪律）；自研桥 + 官方能力面优先；每库过"适配审计" |
| H4 | **ArkTS 桥接缺口**：SQLite/KeyStore/Push Kit 自研桥的开发与排障工作量被低估 | 鸿蒙端工期超支 | 中 | 桥接面收窄到 5 个接口（§4.3 映射表）；桥接是社区已验证路径（TomWq skill / expo-harmony-cli 先例）；M8 先行出桥接工作量评估 |
| H5 | **国内上架合规变数**：备案/软著/隐私检测/厂商推送对接检查逐年收紧 | 国内渠道延期 | 中 | 合规清单前置（§3.2.3）；隐私政策模板与厂商声明 P1 就备齐；华为/小米推送对接随 P1 厂商推送一起做（4.x 设备 HMS Push 本身就是华为对接的证明） |
| H6 | **厂商省电杀进程**（§8.4） | 在线体验降级、用户困惑"为什么没通知" | 中 | 架构层不依赖后台；引导层一键检测；推送兜底保证"通知永远可达" |
| H7 | **华为对非纯鸿蒙应用的收紧**：NEXT 设备上 APK 兼容仅限 4.x 存量，新机全 NEXT；若华为加快 4.x 设备升级节奏，Android 覆盖窗口缩短 | P1 期鸿蒙用户覆盖比预期小 | 中 | P2 鸿蒙 MVP 前置到"Android 发布后 1-2 个版本窗口"内交付；P1 期即启动 RNOH 技术预研（工程骨架 + 冒烟） |
| H8 | **双工程维护成本**：共享代码 + 两套构建/测试/发布 | 团队负担翻倍于单工程 | 中 | 共享面纪律（§4）把差异压到最小；鸿蒙工程 CI 与 iOS/Android 独立；共享代码的任何改动自动触发三端 CI（monorepo 依赖图天然覆盖，D8 §9.4） |

### 9.2 回退预案（H1-H4 触发时的降级路径）

| 触发条件 | 回退动作 | 代价 |
| --- | --- | --- |
| RNOH 某版本线阻塞性缺陷（H2/H3） | 鸿蒙端锁旧版本线（0.72 线也仍在维护）或回退到"Android APK + 4.x" | 功能面冻结于旧线；可接受 |
| 鸿蒙原生投入回报信号为负（H1，如 NEXT 装机不及预期） | **鸿蒙 P2 降级为"观察态"**：停 RNOH 工程投入，维持 Android 覆盖；保留技术预研文档 | 已投入的 P2 预研成本沉没（预估 2-4 人周，可控） |
| 华为应用市场上架受阻（H5，如政策突变） | 鸿蒙端走"侧载 + 自有渠道"或等待政策；不影响 iOS/Android | 鸿蒙分发面收窄 |
| RNOH 桥接缺口导致核心功能（审批）无法在 NEXT 实现 | **ArkUI 应急最小集**：ArkTS 重写"配对 + 审批 + 推送"三屏（§3.3.3 候选②保留价值）；放弃事件流/文件浏览等富功能 | 双份代码 15-20%（仅核心屏），可接受且可长期共存（核心屏走原生、其余 RNOH） |
| 推送网关/厂商通道问题 | 降级为"打开 App 拉取"（§6.3 统一降级） | 体验降级，功能不损 |

### 9.3 分阶段建议（鸿蒙生态不确定性的投资纪律）

```
P1（iOS + Android 首发）                    P2（鸿蒙 NEXT MVP）                P3（鸿蒙完备 + 增强）
┌─────────────────────────┐   ┌──────────────────────────┐   ┌─────────────────────────┐
│ Expo 57 双端工程         │   │ RNOH 0.82 工程 MVP：        │   │ 功能追平 iOS/Android：    │
│  - 审批/事件流/文件/推送   │   │  - 审批 + 事件流 + 推送     │   │  - 文件浏览/终端流/设置   │
│  - 国内厂商推送 + 四渠道   │──►│  - 配对 + 深链            │──►│  - 元服务/服务卡片(ArkUI) │
│  - 真机矩阵 + 商店上架     │   │  - 5 桥（§4.3）+ 上架      │   │  - 角标/本地通知增强      │
│ 鸿蒙：0 原生投入           │   │  - NEXT 5.0+ 真机覆盖     │   │  - 热更评估(bundle拉取)   │
│  (4.x 设备由 Android 覆盖) │   │  出口：审批链路全通 + 上架 │   │  - 7.0 API 跟进           │
└─────────────────────────┘   └──────────────────────────┘   └─────────────────────────┘
 决策门：P1 验收（用户/市场信号）        决策门：NEXT 装机与用户留存信号
```

**阶段建议（正式）**：
1. **P1 不投鸿蒙原生**——iOS/Android 双端为唯一交付物；鸿蒙 4.x 存量设备由 Android APK 覆盖（覆盖华为当前在役 Mate 60 系等机型）；**但 P1 期间并行开展"RNOH 技术预研"**（2-4 人周：工程骨架 + 5 桥冒烟 + 真机跑通"审批链路"），把 P2 的最大技术风险提前暴露；
2. **P2 投鸿蒙 MVP**——P1 验收通过后启动；交付物 = RNOH 工程（审批 + 事件流 + 推送 + 配对深链）+ 华为应用市场 NEXT 上架；出口标准 = "NEXT 真机审批全链路 + 推送三形态 + 商店过审"；
3. **P3 追平与增强**——功能面追平 iOS/Android；评估元服务卡片与热更通道；
4. **任何阶段，iOS/Android 双端不受鸿蒙节奏阻塞**（H1 的纪律化保障）。

### 9.4 降级与回滚汇总表

| 场景 | 预案 |
| --- | --- |
| Expo 57 / RN 0.86 阻塞 | 降级 SDK 56（RN 0.85）（D4 §10.3 既定） |
| RNOH 0.82 阻塞 | 锁 0.72 稳定线（仍在维护）或 ArkUI 核心屏应急 |
| 厂商推送 SDK 问题 | 退化为 FCM/轮询兜底（D4 §10.3） |
| 鸿蒙市场信号转负 | 鸿蒙 P2/P3 暂停，维持 Android 覆盖（§9.2） |
| 协议版本漂移 | 拒绝连接并提示升级（D4 §6.4），三端同规则 |

### 9.5 阶段决策门定义（P1 → P2 → P3）

> 鸿蒙生态不确定性的投资纪律（§9.3）需要**可度量的决策门**。每个门的通过/不通过以数据说话，不凭感觉追加或砍投入。

**Gate A：P1 双端发布 → 启动鸿蒙 P2 预研放量**

| 指标 | 通过线 | 数据来源 |
| --- | --- | --- |
| iOS/Android 上架 | 双端商店过审、线上无 P0 缺陷 | 商店审核结果 + 崩溃监控 |
| 国内四通道推送 | 华为/小米/OPPO/vivo 真机送达率 ≥ 95%（P95 ≤ 30s） | §6.5 统一验证基准 + 推送网关统计 |
| 审批核心链路 | 移动端审批决策送达 P95 ≤ 3s（在线）；离线 outbox 送达率 ≥ 99% | 网关审计 + 埋点（D4 §9.5 预算） |
| 用户信号 | 双端留存/审批使用频次达到预设基线（数值由产品定） | 埋点 |
| RNOH 预研报告 | 工程骨架 + 五桥冒烟 + NEXT 真机"审批链路"跑通，产出 P2 任务书输入 | P1 预研交付物 |
| **不通过时的处置** | 鸿蒙 P2 推迟一个版本窗口，iOS/Android 继续迭代；预研结论更新后重审 | — |

**Gate B：鸿蒙 P2 MVP → P3 追平**

| 指标 | 通过线 | 数据来源 |
| --- | --- | --- |
| NEXT 上架 | 华为应用市场过审（含鸿蒙原生适配度检测） | AGC |
| 审批 + 推送全链路 | NEXT 真机 T03/T04/T07/T15 全绿（§8.5） | 真机测试记录 |
| NEXT 用户信号 | 鸿蒙用户日活/审批使用达预设基线；华为用户占比与市场大盘匹配度 | 埋点 |
| 版本滞后窗口 | 鸿蒙功能面滞后 ≤ 1 个 iOS/Android 版本（§7.5 纪律） | 版本对照表 |
| **不通过时的处置** | 维持 MVP 状态不追平；或按 §9.2 回退（ArkUI 核心屏 / 观察态） | — |

**Gate C（年度复审）**：RNOH 0.84/0.86 跟进窗口、华为 NEXT 政策变化、Flutter/uni-app 生态变化——每年 HDC 后复审一次技术路线（§11.4 开放问题 3 的机制化）。

---

## 10. 结论：三平台适配总策略与工作量估算

### 10.1 总策略（一句话 + 四支柱）

**总策略：iOS/Android 以 Expo 57 双端工程快速上线（P1），鸿蒙以 RNOH 独立工程后置跟进（P2），三层共享（协议/状态/UI）+ 一层差异（平台适配）把三平台维护成本压到接近"1.5 个工程"。**

| 支柱 | 内容 |
| --- | --- |
| 技术支柱 | iOS/Android = Expo 57（D4 冻结）；鸿蒙 = RNOH 0.82 线独立 bare RN 工程；ArkUI 仅作元服务增强与应急备胎 |
| 代码支柱 | 共享边界图（§4.2）+ compat wrapper 映射表（§4.3）+ 零 Expo 依赖纪律；契约单源（生成器三端消费） |
| 渠道支柱 | 推送 = 四通道统一抽象（§6）；分发 = 国际（App Store/Google Play）+ 国内五渠道 + 华为 NEXT 专区（§7）；后台 = 平台中立（§5.2） |
| 投资支柱 | 分阶段（§9.3）：P1 双端 + 鸿蒙预研 → P2 鸿蒙 MVP → P3 追平；每阶段有决策门与回退预案 |

### 10.2 三平台适配工作量（相对比例，iOS = 1.0 基准）

> 口径：功能 = D4 的 P1 能力集（审批/事件流/终端流只读/文件浏览/状态/推送/配对）；估算为**相对新增工作量**（共享代码按一次开发计，平台侧只计差异工作）。

| 工作域 | iOS | Android | 鸿蒙 NEXT（RNOH，P2 起） | 说明 |
| --- | --- | --- | --- | --- |
| 共享三层（协议/状态/UI/数据/网络） | 1.00 | 0.00 | 0.00 | 一次开发，三端复用（这是选 RNOH 的根本收益） |
| 平台差异层（导航/存储桥/权限/深链/生物/设备） | 计入 iOS 基准 | +0.05 | +0.15 | 鸿蒙的 5 桥 + 宿主壳接线是主要增量 |
| 推送接入 | 计入 iOS 基准 | +0.15（厂商四通道 + 合规） | +0.10（Push Kit 桥 + AGC） | 国内厂商推送工作量已在 D4/D7 预估内 |
| 构建/发布/CI | 计入 iOS 基准 | +0.05（分渠道产物 + 备案材料） | +0.10（hvigor 管线 + AGC 上架） | 鸿蒙构建管线独立搭建 |
| 真机测试矩阵 | 计入 iOS 基准 | +0.08（ROM 矩阵 + 杀进程专项） | +0.10（NEXT 设备 + RNOH 专项冒烟） | 鸿蒙设备稀缺是实际约束 |
| 联调/排障 | 计入 iOS 基准 | +0.02 | +0.15（RNOH 生态排障 + 桥接调试） | 生态碎片化风险溢价 |
| 合规（备案/软著/隐私） | 计入 iOS 基准 | +0.05 | +0.02 | 一次性材料，多渠道复用 |
| **单端合计（相对 iOS）** | **1.00** | **≈1.20** | **≈0.62** | 鸿蒙 = iOS 的六成（因为共享层零重复） |
| **三端总投入（相对）** | | | | **≈ 2.8-3.2**（iOS 1.0 + Android 1.2 + 鸿蒙 0.6）|

**口径补充**：
- 若鸿蒙走 ArkUI 双份代码路线：鸿蒙单端 ≈ 1.5-2.0（共享层全部重写 + ArkTS 技能），三端总投入 ≈ 3.7-4.2——**RNOH 路线相对 ArkUI 路线的三端总节省约 25-30%**，且省的是最贵的 UI/协议层；
- P1 期间的 RNOH 技术预研（2-4 人周）计入鸿蒙列的"风险对冲"科目，无论 P2 是否启动都不浪费（产出的工程骨架与冒烟结论是 P2 的直接输入）；
- 以上为相对比例，绝对工期由主控在 PE 计划中排期。

### 10.3 交付顺序建议（供主控排期参考）

```
M0-M7（D4 §11.1 既有里程碑）→ P1 双端上线
        │
        └── 并行：RNOH 技术预研（2-4 人周）
                 ├─ 鸿蒙工程骨架（bare RN 0.82 + harmony/ 宿主）
                 ├─ 5 桥冒烟（SQLite/KeyStore/PushKit/深链/NetInfo）
                 └─ NEXT 真机"审批链路"冒烟 → 预研报告（P2 任务书输入）
        │
P2（决策门通过后启动）
        ├─ RNOH 工程 MVP（审批/事件流/推送/配对）…… 6-10 周（1-2 人）
        ├─ 华为应用市场 NEXT 上架 …… 2-3 周（含审核周期）
        └─ 验收：NEXT 真机全链路 + 商店过审
P3：功能追平 + 元服务卡片 + 热更评估
```

### 10.4 团队技能矩阵与人力建议

| 技能域 | 现状（仓库既有团队） | 三端需求 | 缺口与建议 |
| --- | --- | --- | --- |
| React / TypeScript / zustand | ✅ 成熟（桌面端 + D4 方案） | 三端共享层全部需要 | 无缺口；**共享层由现有移动端团队维护**（改动触发三端 CI，§4.6） |
| Expo / EAS / expo-* 生态 | ✅ 成熟（D4 冻结） | iOS/Android 工程 | 无缺口 |
| 原生桥接（iOS/Android 原生模块） | ✅ 具备（厂商推送 config plugin 计划内） | iOS/Android 平台层 | 无缺口 |
| **ArkTS / DevEco / hvigor** | ❌ 零积累 | 鸿蒙宿主工程 + 五桥 | **培训 1 名工程师**（华为官方 ArkTS 认证课程 + RNOH 官方文档，2-4 周入门）；P2 启动前完成 |
| **C++ / CAPI 桥（NDK 层）** | 🔶 有 Rust/C++ 背景（内核团队） | 五桥的 CAPI 路径 | 复用内核团队的 C/C++ 能力；RNOH CAPI 桥的接口面小（§3.3.6），1 人可承担 |
| 华为生态合规（AGC/推送/上架） | 🔶 有国内安卓上架经验 | 鸿蒙 AGC + 国内渠道 | 由国内安卓发布负责人兼任（同一合规知识域） |
| 测试（真机矩阵/ROM 专项） | ✅ 有前端测试基建 | §8 矩阵执行 | 设备采购（§8.2 清单：NEXT 真机 2-3 台为关键前置） |

**人力建议**：
- P1：现有移动端团队（规模由主控定），零新增人力（鸿蒙预研 2-4 人周可由 1 名 RN 工程师 + 1 名 C++ 背景工程师兼职）；
- P2：**固定 1-2 人**（1 名 ArkTS/DevEco 工程师 + 1 名 RN 工程师），6-10 周 MVP；不建议 >2 人（鸿蒙工程面小，人多了是沟通成本）；
- 共享层纪律（§4）的长期收益：三端功能迭代时，**需求变更只改一次共享代码**——这是比"开发工作量"更重要的长期维护杠杆（§10.2 估算的隐含前提）。

---

## 11. 附录：查证记录与证据索引

### 11.1 网络查证记录（2026-08-09 实查）

| 查证项 | 来源 | 结论（关键事实） |
| --- | --- | --- |
| RNOH 核心仓现状 | gitcode.com/CPF-RN/ohos_react_native（README + 环境搭建 + 版本说明文档，2026-08-09 抓取） | OpenHarmony React Native SIG 维护；381 stars / 480 forks / 5.69K commits / 131 tags / 43 members；月级发布（0.82 线 2026-07-23 出 0.82.33）；工程形态 = bare RN + harmony/ 宿主（RNAbility/RNApp/CAPI/NDK 文本测算/Hermes/字节码 release 包）；编译基线 compatibleSdkVersion 5.0.1(13) |
| RNOH npm 版本线 | registry.npmjs.org/@react-native-oh/react-native-harmony（dist-tags，2026-08-09 实查） | latest=0.82.30；0.82-stable=0.82.30；0.77-stable=0.77.71；0.72-stable=0.72.140；0.61=0.61.16；0.84-rc=0.84.2 |
| RNOH 三方库生态 | github.com/react-native-oh-library（org 页）+ npm search "rnoh"（2026-08-09） | 老 GitHub 组织大量 port 已 archive；活跃 port 分散在 @react-native-ohos/*、@ohmi/*、@bingtang-rn/*、@tuya-oh/*（涂鸦 fork）等 |
| Expo × 鸿蒙社区桥 | npm expo-harmony-cli v0.2.5 README（2026-08-05 更新） | 社区 CLI 基线 = **Expo SDK 52**；`prebuild --platform harmony` + Metro 8888 + DevEco |
| 真实迁移经验 | github.com/TomWq/react-native-harmony-adapter-skill（2026-03 创建，README） | 真实 Expo Router 项目鸿蒙迁移经验：RN/RNOH 版本基线不匹配、expo-router/expo-linking/expo-font 稳定化、图标字体、TurboModule 桥接、启动白屏 |
| Flutter 鸿蒙官方立场 | github.com/flutter/flutter#178206（2025-11，not_planned 关闭） | **Google 官方无 OpenHarmony/HarmonyOS 支持计划**；社区 OpenHarmony SIG flutter_flutter |
| uni-app 鸿蒙支持 | uniapp.dcloud.net.cn（2026-08-09 抓取） | uni-app / uni-app x 已支持纯血鸿蒙；Vue 栈 |
| HarmonyOS 版本线 | zh.wikipedia.org/wiki/HarmonyOS（2026-08-09 抓取） | 1.0-4.3 AOSP 兼容（可跑 APK）；5.0 NEXT 起纯血（2024-10 发布/2025-03 推送）；6.0（2025-10-22 发布）；6.1（2026-04-20）；7.0 开发者版（2026-06-12）；4.x→NEXT 分界；应用市场纯血时代只分发鸿蒙原生应用；2024 Q1 中国份额 17% 超 iOS；9 亿设备（2024-06） |
| 推送通道事实 | D7 §1.3 既有查证（Expo Push Service 国内不可用 / UMS 无统一服务器 / HMS RN 插件） | 本文 §6 直接引用 D7 结论 |
| 华为应用市场政策 | 华为 AGC/开发者文档（JS 渲染站点，正文无法全文抓取） | **标注"以官方最新政策为准"**；NEXT 上架需 HAP、AGC 签名、鸿蒙原生适配度审核 |

### 11.2 仓库内文档依赖索引

| 文档 | 与本文关系 | 引用点 |
| --- | --- | --- |
| `C:\Software\conex\docs\multi-device\plans\D1-overall-architecture.md` | 端模型/通信拓扑母方案 | §1.2、§2.1、§5.2（后台策略对齐 §3.4 离线矩阵） |
| `C:\Software\conex\docs\multi-device\plans\D4-mobile-tech.md` | iOS/Android 技术基线（本文不重复其论证） | §3.1/§3.2（引用冻结结论）、§4（分层与依赖纪律）、§6.5（三层防御）、§8（推送接线） |
| `C:\Software\conex\docs\multi-device\plans\D7-push-notifications.md` | 推送场景/架构 | §6 引用其场景清单、PushMessage 载荷、厂商通道矩阵 |
| `C:\Software\conex\docs\multi-device\plans\D8-engineering-release.md` | 工程/发布/版本三轨制 | §3.3.5（共享纪律）、§7.3（版本同步） |
| `C:\Software\conex\docs\multi-device\plans\R2A-legacy-mobile-reuse.md` | 旧代码借鉴点 | §4.4（PushAdapter 思路）、§2.1 |
| `C:\Software\conex\docs\multi-device\plans\AC-account-center-evaluation.md` | 账号/中继 | §2.1（背景引用） |

### 11.3 术语表

| 术语 | 含义 |
| --- | --- |
| RNOH | React Native for OpenHarmony（React Native OpenHarmony）：RN 的 OpenHarmony/HarmonyOS 平台实现，OpenHarmony React Native SIG 维护 |
| HarmonyOS NEXT | 华为纯血鸿蒙（HarmonyOS 5.0 起）：剔除 AOSP、只能运行鸿蒙原生应用（HAP） |
| HAP / APP | 鸿蒙应用包：HAP（Ability Package）为部署单元，多个 HAP + pack.info 组成 APP（应用市场分发格式） |
| AGC | 华为 AppGallery Connect（开发者后台：签名、推送、上架） |
| hvigor | 鸿蒙构建工具（对应 Android Gradle / iOS Xcode） |
| hdc | HarmonyOS 调试命令行工具（对应 adb） |
| Push Kit | 华为 HarmonyOS NEXT 原生推送服务（@kit.PushKit） |
| HMS Push | 华为移动服务推送（面向 Android/4.x 设备） |
| CAPI 架构 | RNOH 的 C-API 架构（RNOH_C_API_ARCH=1，NDK 直通，替代 napi 桥的现代路径） |
| compat wrapper | 兼容封装层：把 Expo 特有 API 语义映射到鸿蒙实现（§4.3） |
| 厂商通道 | 华为/小米/OPPO/vivo/荣耀各自自营的系统级推送通道（无 GMS 设备唯一离线兜底） |

### 11.4 开放问题（交主控/后续子方案）

1. **M8 推送通道细化**：Push Kit 服务端接口细节、token 生命周期、配额与合规文案（本文 §6.4 只给了框架）；
2. **鸿蒙桥接工作量确认**：5 桥（SQLite/KeyStore/PushKit/深链/NetInfo）的精确工期建议由 PE 系列任务书在 P2 启动时核定（P1 预研会产出实测数据）；
3. **RNOH 0.84/0.86 跟进策略**：0.84 RC 转 stable 的时间点与鸿蒙端升级窗口由主控在 2026 Q4 前后复审；
4. **鸿蒙端 WebSocket 能力验证**：RNOH 0.82 的 WS 支持面（RN 内建 WebSocket 在 RNOH 的实现状态）须在 P1 预研期真机实测，若有缺口则启动 socket 桥（§5.8）；
5. **元服务（服务卡片）**是否进入 P3，取决于 P2 后产品决策（华为对消息类元服务的政策以官方为准）。

---

## 总结

**三平台适配总策略**：iOS/Android 用同一 Expo SDK 57 工程（P1 交付），鸿蒙用 RNOH 独立工程（P2 交付）；协议层/状态层/UI 层三层共享、平台差异收敛到原生适配层；推送四通道统一抽象；构建发布三管线独立；后台策略平台中立（不依赖任何平台的后台长连接特权）。**鸿蒙路线裁决**：RNOH（0.82 稳定线）为主路线（复用率压倒性 + 生态活跃 + 有生产案例），ArkUI 仅作元服务增强与应急备胎，uni-app/Taro/Flutter/壳+WebView 均否决；Expo 与鸿蒙的冲突以"鸿蒙独立 bare RN 工程 + 共享包 + compat wrapper + 零 Expo 依赖纪律"化解。**分阶段**：P1 双端上线（鸿蒙 4.x 由 Android APK 覆盖，并行 RNOH 技术预研）→ P2 鸿蒙 NEXT MVP（审批+事件流+推送+上架）→ P3 功能追平；每阶段有决策门与回退预案，iOS/Android 永不被鸿蒙节奏阻塞。三端总工作量相对 iOS 基准 ≈ 2.8-3.2（鸿蒙单端 ≈ 0.6，比 ArkUI 双份代码路线省 25-30%）。
