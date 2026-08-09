# P0-04 鸿蒙 RNOH 技术预研报告（5 桥冒烟清单 + 版本线验证 + Gate A/B 评估）

> 文档编号：P0-04-harmony-preflight
> 系列：多端互通技术方案（multi-device）
> 版本：v1.0（预研报告）
> 日期：2026-08-10
> 角色：多端互通 P-0 组子代理 P0-04（鸿蒙 RNOH 技术预研）
> 任务书：`docs/multi-device/Z0-master-plan.md` §9.1 P0-04（M 工作量：2-4 人周，文件域 docs 预研报告）
> 上游依赖：M1 §3.3/§9.3（RNOH 深挖 + Gate A/B）、M8 §2.4（HarmonyOS NEXT 推送路线）、D4（移动端技术基线）、D8（工程与发布）
> 产出路径：`C:\Software\conex\docs\multi-device\plans\P0-04-harmony-preflight.md`
> 读者：主控调度者、M 系列后续子方案、R5（鸿蒙）任务书作者（R5-01~R5-05）、PE 系列任务书作者
> 查证声明：本文全部外部事实于 2026-08-10 经 webfetch/npm registry/GitCode API 实查，逐条标注证据来源与查证日期；本文档为**只读预研报告**，未修改任何代码、未执行 git 操作。
> 编码：UTF-8 无 BOM，中文。

---

## 目录

1. [结论摘要（TL;DR）](#1-结论摘要tldr)
2. [任务范围与方法](#2-任务范围与方法)
3. [RNOH 现状核实（2026-08-10 实查）](#3-rnoh-现状核实2026-08-10-实查)
4. [五桥冒烟清单](#4-五桥冒烟清单)
5. [版本线验证](#5-版本线验证)
6. [Gate A/B 评估与建议裁决](#6-gate-ab-评估与建议裁决)
7. [风险清单与缓解](#7-风险清单与缓解)
8. [P1 并行预研建议与 P2 启动条件](#8-p1-并行预研建议与-p2-启动条件)
9. [附录：查证记录与证据索引](#9-附录查证记录与证据索引)

---

## 1. 结论摘要（TL;DR）

### 1.1 一句话结论

**RNOH 0.82 稳定线可支撑 crish 鸿蒙 P2 立项（Gate A 条件通过、Gate B 条件 GO），五桥中"网络 WS / 深链 / 文件（含 SQLite）"具备官方或生态现成路径，"安全存储 / 推送（Push Kit）"无现成桥需自研 TurboModule（工作量可控），最大未知量集中在"NEXT 真机冒烟清单"（wss+证书固定、Linking 映射、Push Kit 桥、release 字节码包、WS 前台保活）——这正是 P1 期并行预研（2-4 人周）的交付物。**

### 1.2 关键结论清单（结论先行）

| 结论点 | 结论 | 一句话理由 |
| --- | --- | --- |
| 版本线结论 | **RNOH 0.82 稳定线继续成立**（npm `0.82-stable`=0.82.30，基 RN 0.82.1 / React ^19.1.1，19.2.3 兼容，min API 17 / target API 21 / DevEco 6.0.1+）；**0.84 线已成为官方文档主推线**（RN 0.84.1 / React 19.2.3 / min API 17，2026-07-23 出 0.84.3）但 npm 尚无 `0.84-stable` 标签 | 0.82-main 分支 2026-08-08 仍在合入代码（活跃维护）；0.84 线发布节奏快（5 月底→7 月底三连发），转 stable 后重选基线（§5.4） |
| 活跃度结论 | 月级发布节奏确认：0.82 线 2026-01~07 至少 10 个版本（0.82.3→0.82.33），main 分支 2026-08-08 仍有提交（距查证日 2 天） | CHANGELOG + GitCode 分支提交时间实查（§3.2） |
| 生产案例结论 | 有真实生产使用：涂鸦定制 fork（`@tuya-oh/react-native-harmony`，当前 0.72 线 0.72.58-rc1.0.18）、Eclipse Oniro 发行版内置 RNOH、@react-native-ohos 三方 port 生态（openharmony-sig rntpc_* 组织，按版本线出分支 br_rnoh0.82/0.77） | npm 实查 + usage-docs 官方三方库清单（§3.4） |
| Expo 不兼容结论 | **确认**：RNOH 官方文档只演示 bare RN 流程；社区 expo-harmony-cli 最新仍为 v0.2.5（Expo SDK 52 基线，2026-08-05 更新） | 与 M1 §3.3.1.2 结论一致，无需修改 M1 的双工程裁决（§3.5） |
| 五桥可用性结论 | 网络 WS ✅ 官方核心支持（含心跳控制、http patch、证书验证回调口子）；深链 ✅ 宿主 want 分发（Linking JS 映射需真机冒烟）；文件 ✅ 生态现成（react-native-fs / sqlite-storage / op-sqlite / blob-util 等 @react-native-ohos port）+ 远程浏览走 WS 命令无需本地文件权限；安全存储 ⚠️ 无现成桥 → 自研 KeyStore TurboModule；推送 ⚠️ 无现成 Push Kit 桥 → 自研 @kit.PushKit TurboModule | 每条证据见 §4 清单 |
| 共享层兼容结论 | `@crish/shared-types` / `shared-utils` 为纯 TS（依赖仅 zod，零 react-native/expo import），且 shared-types 已具备 dist 构建面（exports 指向 dist）——鸿蒙工程经"预构建产物 + 契约漂移检查"消费无障碍（M1 §4.6 方案 B 成立） | 本地代码实读（§5.3） |
| Gate A 裁决 | **条件通过（CONDITIONAL GO）**：技术可行性成立（5 桥全有路径 + 构建出包链官方文档齐备），剩余未知全部收敛到"NEXT 真机冒烟清单"，作为 P1 预研交付物 | §6.1 |
| Gate B 裁决 | **条件 GO**：P2 启动 = Gate A 冒烟全绿 + P1 双端上线 + 鸿蒙用户信号达基线 + 版本线复核（0.84 转 stable 则重选基线）；沉没成本可控（预研 2-4 人周） | §6.2 |
| P1 并行预研 | 建议**立即并行**：工程骨架（bare RN 0.82 + harmony/ 宿主）+ 五桥冒烟 + NEXT 真机"审批链路"冒烟，产出 P2 任务书输入（对齐 M1 §10.3 与 Z0 P0-04 验收锚点） | §8 |

### 1.3 阅读指南

- 第 3 章是现状核实（任务 1 交付物），第 4 章是五桥清单（任务 2），第 5 章是版本线验证（任务 3），第 6 章是 Gate A/B 评估（任务 4），第 7-8 章是风险与建议（含 P1 并行预研、P2 启动条件）；
- 所有外部事实标注查证日期（2026-08-10）与来源；版本号、dist-tag 为查证时点快照，实施时以 `npm view @react-native-oh/react-native-harmony dist-tags` 实时查询为准（RNOH 官方文档同样要求实时查询，不写死版本号）；
- 与既有文档的衔接：M1 已裁决"鸿蒙 = RNOH 0.82 独立 bare RN 工程 + 三层共享 + compat wrapper"，本报告**不重做路线裁决**，只做技术预研验证；M8 §2.4 已定"鸿蒙推送 = Push Kit 自研桥"，本报告补充五桥层面的横向核对。

---

## 2. 任务范围与方法

### 2.1 任务书口径（Z0 §9.1 P0-04）

| 项 | 内容 |
| --- | --- |
| 包名 | P0-04 鸿蒙 RNOH 技术预研 |
| 内容 | 5 桥冒烟 + 版本线验证 + Gate A/B 报告 |
| 工作量 | M（2-4 人周） |
| 依赖 | 无（外部并行，可立即启动） |
| 文件域 | docs（预研报告） |
| 验收锚点（Z0 §9.9） | Gate A/B 预研报告产出（RNOH 版本线验证、5 桥冒烟结果、可行性结论） |

### 2.2 五桥口径说明（任务书与 M1 的差异及并集）

任务书定义五桥为：**网络 WS / 安全存储 / 推送 / 深链 / 文件**；M1 §10.3 的五桥为：**SQLite / KeyStore / PushKit / 深链 / NetInfo**。两者并不冲突，是同一桥接面（compat wrapper 层，M1 §4.3）的不同切分视角。本报告按**并集**覆盖 7 项能力，并逐项标注口径归属：

| 能力 | 任务书五桥 | M1 五桥 | 本报告章节 |
| --- | --- | --- | --- |
| 网络 WS（RN 内建 WebSocket + TLS） | ✅ | —（§5.8 风险项） | §4.1 |
| 安全存储（KeyStore） | ✅ | ✅ | §4.2 |
| 推送（Push Kit） | ✅ | ✅ | §4.3 |
| 深链（Linking/want） | ✅ | ✅ | §4.4 |
| 文件（远程浏览 + 本地 SQLite/缓存） | ✅ | ✅（SQLite） | §4.5 |
| NetInfo（网络状态感知） | —（网络 WS 的辅助） | ✅ | §4.6 |
| AsyncStorage（KV 设置） | —（存储辅助） | —（§5.7 KV 设置） | §4.7 |

### 2.3 方法与证据链

1. **网络调研**：webfetch GitHub / GitCode / GitCode API / npm registry（含 dist-tags、单版本元数据、搜索 API），全部 2026-08-10 实查；
2. **本地验证**：实读 `packages/shared-types`（package.json、src 依赖面）、`packages/shared-utils` 依赖面，grep react-native/expo import；
3. **真机冒烟**：本报告为纯文档预研（无真机），"五桥冒烟"指**可用性路径核查 + 冒烟用例清单**（冒烟执行留给 P1 预研期真机阶段，§8.2）。

---

## 3. RNOH 现状核实（2026-08-10 实查）

### 3.1 核心仓库现状

| 事实项 | 实查结果（2026-08-10） | 来源 |
| --- | --- | --- |
| 核心仓库 | `gitcode.com/CPF-RN/ohos_react_native`（原 openharmony-sig/ohos_react_native，OpenHarmony React Native SIG 维护） | GitCode 仓库页 |
| 规模信号 | 381 stars / 480 forks / 5.69K commits / 131 tags / 43 members；license MIT | GitCode 仓库页 |
| 分支结构 | `main`（版本演进分支，非稳定性分支）、`0.82-main`（0.82 主干）、`0.77-main`、`0.72-main`、`0.82-stable`、`0.77-stable`、`0.72-stable`、各 hotfix 分支 | GitCode branches API |
| **活跃度实证** | `main` 分支最近提交 2026-08-08（"!3289 merge main-b into main"）；`0.82-main` 最近提交 2026-08-08（"!3273 merge 82_trim into 0.82-main"）；`0.77-main` 2026-08-08；`0.72-main` 2026-08-06 | GitCode branches API（提交人 openharmony_ci） |
| 结论 | **组织化维护、多版本线并行、日更级活跃**（main 距查证日仅 2 天）；0.82 线并非"冻结线"，0.82-main 仍持续合入修复 | — |

### 3.2 版本线与发布节奏（npm registry 实查）

**npm dist-tags 快照（2026-08-10 `registry.npmjs.org/@react-native-oh/react-native-harmony`）：**

| dist-tag | 指向版本 | 发布到 npm 时间 | 说明 |
| --- | --- | --- | --- |
| `latest` | 0.82.30 | 2026-05-21 | 不带 tag 安装默认解析至此 |
| `0.82-stable` | 0.82.30 | 2026-05-21 | **0.82 线稳定标签**（M1 裁决锁定线） |
| `0.82-rc` | 0.82.32 | 2026-07-16 | 0.82 线候选版（0.82.31/0.82.32 已发 npm） |
| `0.84-rc` | 0.84.2 | 2026-07-09 | 0.84 线候选版 |
| `0.77-stable` | 0.77.71 | 2026-05-21 | 0.77 线稳定 |
| `0.72-stable` | 0.72.140 | 2026-05-21 | 0.72 线稳定（M1 §9.4 回退线） |
| `beta` | 0.82.7 | — | beta 标签 |

**0.82 线发布节奏（0.82-main 分支 CHANGELOG，2026-08-10 实查）：**

| 版本 | 日期 | 关键内容（与 crish 相关） |
| --- | --- | --- |
| 0.82.33 | 2026-07-23 | **Networking：支持关闭 WebSocket 的心跳检测**；Fabric 并行渲染；Hilog 生命周期日志；Image 内存缓存优化（注：内部流转版本，**未发布到 npm**） |
| 0.82.32 | 2026-07-04 | http patch 请求；Image 内存缓存；120 帧动画；**enableBackgroundModeOnInvisible 后台模式能力**；TurboModule Promise.reject 支持 Error 对象；Hap 内框架版本静态分析 |
| 0.82.31 | 2026-06-01 | Hermes 调试符号分离 / heap watermark / appfreeze JS 栈捕获；内存快照导出；axios 上传 >1MB headers 修复 |
| 0.82.30 | 2026-05-07 | release（npm 稳定版）；RefreshControl / RNInstance crash 修复 |
| 0.82.29 | 2026-04-24 | JS 崩溃堆栈上报；1500+ View 性能修复；低 API 版本崩溃修复 |
| 0.82.23 | 2026-04-08 | TextInput/ScrollView 修复；Attachment isClipped |
| 0.82.21 | 2026-03-26 | API < 18 崩溃修复；Autolinking 远程依赖；JSVM 多线程崩溃修复 |
| 0.82.18 | 2026-03-10 | Fabric Create 重排修复；Text maxWidth |
| 0.82.17 | 2026-03-03 | HttpClient 自定义协议支持；ScrollView 滑动崩溃 |
| 0.82.8 | 2026-01-27 | share.js / TextInput 光标回退 / Image base64 |
| 0.82.5 | 2026-01-09 | **Socket 置 undefined 前 close 崩溃修复**（WebSocket 支持实证） |
| 0.82.3 | 2026-01-08 | TurboModule 内存泄漏修复；0.77→0.82 迁移 |

**0.84 线发布节奏（main 分支 CHANGELOG / release notes，2026-08-10 实查）：**

| 版本 | 日期 | 关键内容 |
| --- | --- | --- |
| 0.84.1 | 2026-05-30/06-01 | **升级适配 RN 0.84.1**；Hermes V1 引擎；DevTools Network 面板；配套 DevEco Studio 6.1.0 Release、HarmonyOS 6.1.0 SDK、target API 23、min API 17（compat 17-23） |
| 0.84.2 | 2026-07-04 | http patch；120 帧动画；Image 内存缓存；RTL 布局翻转；Codegen --generate-type |
| 0.84.3 | 2026-07-23 | **Networking：支持关闭 WebSocket 心跳检测**（与 0.82.33 同步）；Fabric 并行渲染；配套 DevEco Studio 26.0.0 Beta1、target API 26、min API 17（compat 17-26） |

**发布节奏结论**：0.82 线 2026-01~07 约 10+ 个版本（月级，2026-03 起双发）；0.84 线 3 个月 3 发。**月更活跃度与 M1 判断一致，且更强**（main 分支 8 月仍在日更）。

**一个重要细节（npm 标签滞后）**：0.82 线 changelog 已到 0.82.33（2026-07-23），但 npm 的 `0.82-stable` 标签仍停在 0.82.30（2026-05-21 发布），0.82.33 明确标注"内部流转版本，暂未发布到 npm"。即：**发布节奏（仓库层）快于 npm 分发（registry 层）**。对 crish 的工程含义：锁 `0.82-stable` 标签 = 锁 0.82.30，线内小版本升级需主动关注 npm 发布；`0.82-rc`（0.82.32）可按需选用但非稳定标签。实施纪律见 §5.4。

### 3.3 环境要求与编译基线（release notes 实查）

| 版本线 | RN 基线 | React 要求 | DevEco Studio | min API | target API | 兼容范围 |
| --- | --- | --- | --- | --- | --- | --- |
| **0.82-stable（0.82.30）** | RN 0.82.1（npm peerDeps 实查） | React ^19.1.1（RN 0.82.1 peerDeps 实查，**19.2.3 兼容**） | 6.0.1 Release | API 17 | API 21 | API 17-21 |
| 0.82.33（未发 npm） | RN 0.82.1 | 同上 | 26.0.0 Beta1 | API 17 | API 26 | API 17-26 |
| 0.84.1（0.84-rc 基线） | RN 0.84.1 | React 19.2.3（官方模板） | 6.1.0 Release | API 17 | API 23 | API 17-23 |
| 0.84.3 | RN 0.84.1 | React 19.2.3 | 26.0.0 Beta1 | API 17 | API 26 | API 17-26 |

> 注：M1 §3.3.1.2 记录的"编译基线 5.0.1(13)"来自旧版环境搭建文档快照；2026-08-10 官方 release notes 已明确 0.82.30 的 min API 17 / target API 21。**以 release notes 为准**：0.82 线的最低系统基线为 API 17（约 HarmonyOS 5.x 中期线，具体系统版本对应以华为官方 API 映射为准），覆盖 NEXT 全系（5.x/6.x/7.x 向下兼容）。M1 §8.1 真机矩阵"5.0 作为最低 API 基线"需按此微调（详见 §5.4）。

### 3.4 生产案例与生态现状

| 事实项 | 实查结果（2026-08-10） | 来源 |
| --- | --- | --- |
| 涂鸦定制 fork | `@tuya-oh/react-native-harmony` npm 实查：latest = **0.72.58-rc1.0.18**（0.72 线持续发布） | npm registry |
| Eclipse Oniro | `eclipse-oniro4openharmony/app-rnoh-example`（RNOH 用于 Oniro/OpenHarmony 发行版） | M1 既有查证 + README 引用 |
| 三方 port 生态（官方适配） | GitCode `CPF-RN/usage-docs`（三方库适配文档合集，2026-08-10 实查，收录 50+ 库：netinfo / async-storage / gesture-handler / reanimated / safe-area-context / react-navigation（native/stack/elements）/ flash-list / svg / webview / vector-icons / fs / push-notification-ios 等） | usage-docs `_sidebar.md` |
| 三方 port 生态（npm 分发） | `@react-native-ohos/*` 系列（openharmony-sig rntpc_* 仓库维护，2026-03~07 持续发布，**按版本线出分支 br_rnoh0.82 / br_rnoh0.77**）：sqlite-storage v6.1.2-beta.3（2026-07-09）、netinfo v11.5.0-beta.1（2026-06-11）、async-storage v2.2.2-beta.1（2026-06-11）、react-native-fs v2.20.2-beta.2（2026-07-14）、blob-util v0.22.3-beta.1（2026-06-11）、ssl-pinning v1.7.0-beta.2（2026-07-11，br_rnoh0.82）等 | npm search API |
| 老 GitHub 组织 | `github.com/react-native-oh-library` 各仓（slider/progress-view/picker/webview/netinfo 等）**archived: true**（2026-01 前后归档）——印证 M1"老组织大量 archive"判断，**核心与 port 均已迁往 GitCode**（openharmony-sig / OpenHarmony-RN / CPF-RN），npm 包面仍可分发 | GitHub API 实查 |
| 其他活跃 port 方 | 奥米（@ohmi/*）、bingtang-rn（@bingtang-rn/*，2026-07-30 仍发布） | M1 既有查证（本报告未重复实查） |
| 结论 | **生态活跃但碎片化判断不变**：官方 usage-docs 收录面（白名单）< npm 可搜索面（灰名单）；**凡引入三方 port 必须过"适配审计"**（M1 §4.3 纪律），优先 usage-docs 收录库；自研桥仍是兜底纪律 | — |

### 3.5 已知限制（Expo 不兼容确认 + 框架面限制）

| # | 限制 | 证据 | 对 crish 的影响 |
| --- | --- | --- | --- |
| L1 | **Expo 不兼容确认**：RNOH 官方文档（环境搭建 / RN 应用鸿蒙化开发指南）只有 bare RN（`@react-native-community/cli init --version`）+ harmony/ 宿主流程，无 Expo 支持 | 官方文档实查（2026-08-10） | M1 双工程裁决不变：鸿蒙独立 bare RN 工程 |
| L2 | 社区 expo 桥 `expo-harmony-cli` 最新 v0.2.5（2026-08-05 更新），基线仍为 **Expo SDK 52**（我们 SDK 57，低 5 个大版本） | npm registry | 不可作生产基线（M1 结论维持） |
| L3 | **不支持 NativeModule，仅支持 TurboModule** | 官方"功能开发.md"原文（2026-08-10 实查） | 自研桥统一走 TurboModule 路径（M1 已按此设计） |
| L4 | RN 版本滞后上游：RNOH 0.82/0.84 线 vs RN 最新 0.86（Expo 57 基线） | reactnative.dev/versions（0.86 最新；0.82 仍在文档化版本区，0.76 及以下进 archive） | 鸿蒙独立版本线演进（M1 §3.3.5）；0.82 仍在上游维护窗口内 |
| L5 | Fabric 下 UIManager.measure 不支持 / setNativeProps 仅生效一次 | 官方规格类 FAQ | 移动端 UI 代码避免依赖这些 API（桌面端无此问题） |
| L6 | StatusBar 页面级控制与 HarmonyOS 系统级模型不一致，官方建议用系统默认策略 | 官方规格类 FAQ | crish 移动端不依赖页面级状态栏微操，影响低 |
| L7 | RNSurface 宽度自适应不支持（高度自适应可经 AppRegistry.setRootViewStyleProvider，RN 0.75+） | 官方规格类 FAQ | crish 是整屏应用（5 Tab + Stack），无宽度自适应需求 |

---

## 4. 五桥冒烟清单

> 逐桥给出：**官方支持 / 生态 port / 自研桥 / 不可用（替代方案）**四态判定 + 证据 + 冒烟用例（P1 预研期真机执行，冒烟通过标准写入 P2 任务书）。

### 4.1 桥 1：网络 WS（WebSocket 长连接 + TLS 证书固定）

**结论：✅ 官方核心支持（RN 内建 WebSocket 在 RNOH 可用），证书固定面有原生口子但需真机冒烟。**

| 维度 | 事实 | 证据 |
| --- | --- | --- |
| WebSocket 支持 | RN 内建 WebSocket（Libraries/Network）在 RNOH 有实现并被持续维护：0.82.33/0.84.3 新增"**支持关闭 WebSocket 的心跳检测**"（说明框架自带 WS 心跳机制）；0.82.5 修复 Socket close 前置 undefined 崩溃；DevTools Network 面板（0.84.1） | CHANGELOG 0.82-main / main（2026-08-10） |
| HTTP 面 | RN fetch/XMLHttpRequest 经 RNOH HttpClient（系统 http 客户端）实现；0.82.17 支持自定义协议；0.82.31 修复 axios >1MB 上传 headers；0.84.2 新增 http patch | CHANGELOG 同上 |
| TLS / 证书固定 | RNInstanceOptions 提供 `caPathProvider`（自定义 CA 证书路径规则）与 `remoteValidation`（HTTPS 证书验证模式：'system' / 'skip' / 自定义 ValidationCallback，API >= 26 可用）——**自签证书 + 指纹固定有原生口子**；另有社区 port `@react-native-ohos/react-native-ssl-pinning` v1.7.0-beta.2（2026-07-11，br_rnoh0.82 分支）可作备选 | 官方 API 接口说明.md（2026-08-10）+ npm |
| 判定 | **官方支持**（WS + fetch 内建可用）；crish 的"wss + 自签证书 + 指纹固定"（D3 §4.6 tlsFingerprint / D5 TLS-01~10）需真机验证 RNOH WS 层对自定义 CA/固定证书的支持面；若 WS 层缺口，则走自研 socket 桥（M1 §5.8 预案） | — |

**冒烟用例（真机，P1 预研期）**：

| # | 用例 | 通过标准 |
| --- | --- | --- |
| N1 | 前台 WS 连桌面网关（ws:// 局域网，明文降级仅调试） | 连上、事件推送、30s 心跳正常 |
| N2 | wss + 自签证书 + 指纹固定（配 caPathProvider/remoteValidation） | 握手成功；错指纹拒绝；无降级明文连接 |
| N3 | WS 断线重连（桌面端重启网关） | ReconnectingWsClient 指数退避重连成功（共享代码原样跑） |
| N4 | 100 条/秒事件流（局域网） | 无丢帧、无卡顿（对齐 D4 §9.5 预算） |
| N5 | 后台 30s → 前台 | WS 断开重连符合 AppState 语义（对齐 §5.2 三端统一后台策略） |

### 4.2 桥 2：安全存储（KeyStore）

**结论：⚠️ 无现成桥 → 自研 TurboModule（鸿蒙 KeyStore / 安全资产能力），工作量可控。**

| 维度 | 事实 | 证据 |
| --- | --- | --- |
| 现成 port | npm 搜索 keychain / secure-store / secure storage × ohos：**无对应包**；`@react-native-ohos/async-storage`（v2.2.2-beta.1）是普通 KV 存储（非加密，对应 @react-native-async-storage），usage-docs 收录 | npm search API + usage-docs（2026-08-10） |
| 鸿蒙原生能力 | HarmonyOS NEXT 提供 KeyStore / 安全资产（@kit.UniversalKeystoreKit，硬件级、密钥不可导出），语义与 Keychain/Keystore 对齐 | 华为官方文档（M1 §5.7/§5.10 既有查证） |
| 自研路径 | 自研 TurboModule 暴露 `getItemAsync(key)/setItemAsync(key, value)` 同形 API（对齐 M1 §4.3 映射表：expo-secure-store → 鸿蒙 KeyStore 桥）；CAPI 架构下走 NDK/C++ 或 ArkTS 桥（官方 TurboModule.md + C-API 文档有完整教程） | M1 §4.3 + 官方文档 |
| 判定 | **自研桥**（M1 已裁决）；桥接面小（读写两个方法 + 删除），是五桥中工作量最小的桥之一 | — |

**冒烟用例**：

| # | 用例 | 通过标准 |
| --- | --- | --- |
| S1 | set/get 4 个密钥位（T1 配对令牌、T2 账号 token、设备私钥、hub 指纹，D4 §5.2） | 写入读出一致（共享 secureStore 层原样跑） |
| S2 | App 重启后读回 | 持久化（重启不丢） |
| S3 | 错误密钥访问 / 超长值 | 可读错误，不崩溃 |

### 4.3 桥 3：推送（Push Kit）

**结论：⚠️ 无现成 Push Kit 桥 → 自研 TurboModule（@kit.PushKit），与 M8 §2.4 路线一致。**

| 维度 | 事实 | 证据 |
| --- | --- | --- |
| 现成 port | 官方 usage-docs 只有 `@react-native-community/push-notification-ios` 的 port（iOS 推送 API 语义，与 Push Kit 无关）；npm 无 Push Kit / pushService 桥 | usage-docs + npm search（2026-08-10） |
| 鸿蒙原生能力 | Push Kit（@kit.PushKit pushService）：AGC 开通推送服务后取 token、收通知消息；notificationManager 本地通知 / slot | M8 §2.4 既有查证 |
| 自研路径 | 自研 TurboModule 暴露 `getPushToken()/setNotificationHandler(...)` 同形 API（对齐 M1 §4.3：expo-notifications → Push Kit 桥）；服务端对接华为推送开放接口（推送网关职责，M8） | M8 §2.4.3 + M1 §6.4 |
| 判定 | **自研桥**（M1/M8 已裁决）；是五桥中**合规面最重**的桥（AGC 开通、token 生命周期、隐私声明），但接口面小 | — |

**冒烟用例**（依赖 P0-02 华为开发者账号 + AGC 推送开通）：

| # | 用例 | 通过标准 |
| --- | --- | --- |
| P1 | AGC 开通推送服务 → 客户端取 Push Kit token 并上报推送网关（push_tokens 表，platform=harmony） | token 获取 + 上报成功 |
| P2 | 桌面 push-core 触发审批事件 → 网关走华为推送开放接口 → NEXT 真机通知到达 | 后台/杀进程两态送达（对齐 M1 §6.5 统一验证基准） |
| P3 | 点击通知 → 冷启动深链直达审批卡（与桥 4 联动） | 三形态深链（前台/后台/冷启动） |
| P4 | 前台横幅（应用内通知） | 前台 handler 自绘横幅（对齐 D4 §8.7） |
| P5 | 令牌轮换/卸载重装 | 新 token 上报、旧 token 网关清理（对齐 D4 §8.2-6） |

### 4.4 桥 4：深链（Linking / want 分发）

**结论：✅ 宿主级支持（RNAbility want 分发），JS 侧 Linking 映射需真机冒烟；路由层生态现成。**

| 维度 | 事实 | 证据 |
| --- | --- | --- |
| 宿主入口 | `RNAbility.onCreate(want)` 接收启动参数；`RNInstancesCoordinator` 配置含 `launchURI: want.uri`；`RNOHCoreContext.launchUri: string | undefined`（应用自己的 uri）——**深链入口在宿主侧一等支持** | 官方 API 接口说明.md（2026-08-10） |
| scheme 注册 | HarmonyOS 应用深链：module.json5 注册 linkTag / 自定义 scheme + 系统 want 分发（华为 App Linking 可选），冷启动与热启动都走 onNewWant 语义 | M1 §5.5（既有）+ 华为文档口径 |
| JS 侧映射 | RN 内建 Linking 模块（getInitialURL / onOpenURL）在 RNOH 的映射**无官方文档明示**（使用类 FAQ 仅 2 处提及 Linking，无专项说明）→ **P1 冒烟必须验证**；备选：宿主侧拿到 launchUri 后经 TurboModule/事件注入 JS | 官方 FAQ grep（2026-08-10） |
| 路由层 | react-navigation 全系已在 usage-docs 收录（@react-navigation/native / stack / native-stack / elements，npm @react-native-ohos 对应包 2026-03~05 持续发布）——M1 §4.3"鸿蒙侧 react-navigation 或轻量自研路由"有现成实现可选 | usage-docs + npm |
| 判定 | **官方支持（宿主级）+ 生态现成（路由层）**；唯一待验证项 = RN 内建 Linking 的 JS 映射（深链三形态） | — |

**冒烟用例**：

| # | 用例 | 通过标准 |
| --- | --- | --- |
| D1 | 冷启动深链：点击推送 → 应用冷启动 → 直达 `crish://approval/<toolCallId>` 审批卡 | 路由白名单校验（共享纯函数）→ 跳转正确（对齐 M1 §5.5） |
| D2 | 后台深链：应用在后台 → 点击通知 → 回前台直达 | 同上 |
| D3 | 前台深链：应用前台收到 push 事件 → 应用内跳转 | 同上 |
| D4 | 配对二维码深链（P2 扫码，`conex-pair://`） | P2 评估（P1 手动输入，无依赖） |

### 4.5 桥 5：文件（远程浏览 + 本地 SQLite/缓存）

**结论：✅ 远程浏览零本地权限需求（走 WS 命令）；本地存储（SQLite/缓存）有生态 port + 自研备选，双路径可行。**

| 维度 | 事实 | 证据 |
| --- | --- | --- |
| 远程文件浏览 | crish 的"文件"能力 = 浏览**桌面**文件（M1 §5.3 结论：移动端零本地文件权限需求，全部走 WS 网关 `workbench_list_directory/read_file_content` 等命令）——**该桥的"文件"面不依赖任何本地原生能力**，随桥 1（WS）成立即成立 | M1 §5.3 + D2 命令面 |
| 本地 SQLite | 生态 port：`@react-native-ohos/react-native-sqlite-storage` v6.1.2-beta.3（2026-07-09）、`@react-native-ohos/op-sqlite` v14.0.1（2026-03-27）、`@react-native-ohos/realm` v12.13.2（2026-05-12）——**均不在官方 usage-docs 收录面**（灰名单，需适配审计）；备选：鸿蒙 relationalStore 自研桥（M1 §4.3 主案，暴露 openDatabaseAsync/runAsync/getAllAsync 子集） | npm search + usage-docs |
| 本地文件读写 | `@react-native-ohos/react-native-fs` v2.20.2-beta.2（2026-07-14）、`react-native-blob-util` v0.22.3-beta.1（2026-06-11）——crish 本地文件面极小（SQLite + 缓存），此两项为缓存清理的备选 | npm search |
| 判定 | **远程面：随 WS 成立**；**本地 SQLite 面：优先自研 relationalStore 桥（M1 主案，可控、无灰名单依赖），或对 sqlite-storage port 过适配审计后采用**；二选一在 P1 冒烟期定案 | — |

**冒烟用例**：

| # | 用例 | 通过标准 |
| --- | --- | --- |
| F1 | 目录树浏览（1 万项级） | 真机性能达标（对齐 D4 预算） |
| F2 | 文本预览（read_file_content 只读） | 内容正确、无越权写入口 |
| F3 | SQLite 桥：12 张表 schema + user_version 迁移（D4 §7） | 迁移幂等（v0 逐级升最新）、DAO 全绿（共享 DAO 层原样跑） |
| F4 | SQLite 桥：WAL + 事件流高频写入（100 条/秒） | 无锁死、性能达标 |
| F5 | 缓存清理策略（pruneOldEvents） | 共享纯函数原样跑 |

### 4.6 补充桥：NetInfo（网络状态感知，M1 五桥之一）

**结论：✅ 官方 usage-docs 收录 + npm 有 port。**

- `@react-native-community/netinfo` 在官方 usage-docs 有适配文档（2026-08-10 实查 `_sidebar.md` 收录）；npm `@react-native-ohos/netinfo` v11.5.0-beta.1（2026-06-11，openharmony-sig rntpc_react-native-netinfo）。
- 用途仅"网络恢复触发重连"（M1 §5.8：降级可接受）：即使 port 有缺陷，可降级为轮询/重连触发（ReconnectingWsClient 自身的心跳重连兜底）。
- 冒烟用例：断 WiFi → 重连触发语义正确（N 系列用例附带验证）。

### 4.7 补充桥：AsyncStorage（KV 设置，M1 §5.7）

**结论：✅ 官方 usage-docs 收录 + npm 有 port（`@react-native-ohos/async-storage` v2.2.2-beta.1，2026-06-11）。** 设置偏好类 KV 走此桥；M1 §5.7 的"KV 设置三端同一 kv 接口"成立。

### 4.8 五桥冒烟总结表

| 桥 | 任务书归属 | 判定 | 形态 | 风险 | P1 冒烟必做 |
| --- | --- | --- | --- | --- | --- |
| 网络 WS | ✅ | **官方支持** | RN 内建（+证书固定口子） | 中：wss+pinning 待真机验证 | N1-N5 |
| 安全存储 | ✅ | **自研桥** | KeyStore TurboModule | 低-中：接口面小 | S1-S3 |
| 推送 | ✅ | **自研桥** | Push Kit TurboModule | 中：合规面重 | P1-P5 |
| 深链 | ✅ | **官方（宿主）+ 待验证 JS 映射** | want 分发 + react-navigation | 中：Linking 映射待验证 | D1-D4 |
| 文件 | ✅ | **远程随 WS + 本地 SQLite 桥** | relationalStore 自研桥（主案）或 sqlite port（备选） | 低-中 | F1-F5 |
| NetInfo | M1 侧 | **生态 port** | @react-native-ohos/netinfo | 低：可降级 | N 系列附带 |
| AsyncStorage | M1 侧 | **生态 port** | @react-native-ohos/async-storage | 低 | 设置页冒烟附带 |

**五桥总体结论：5/5 有可行路径（2 官方支持、2 自研桥、1 官方宿主 + 待验证），无"不可用"项；自研桥总量 2 个（KeyStore + PushKit，SQLite 视审计结果可减为 1 个），与 M1 §4.3 映射表一致。**

---

## 5. 版本线验证

### 5.1 兼容矩阵（RNOH 0.82 线 × RN × React × DevEco × 鸿蒙 API）

| 组件 | 版本 | 兼容性 | 证据 |
| --- | --- | --- | --- |
| @react-native-oh/react-native-harmony | **0.82.30**（0.82-stable，2026-05-21 发 npm） | 采用基线 | npm dist-tags（2026-08-10） |
| @rnoh/react-native-openharmony（ohpm 原生包） | **0.82.30**（与 npm 包同号） | 必须同号（官方规则：前端包与原生包版本号对齐） | 官方版本说明.md |
| react-native | **0.82.1** | RNOH 0.82 线的适配基线（peerDependencies 精确声明） | npm 包元数据（2026-08-10） |
| react | **^19.1.1 → 19.2.3** | RN 0.82.1 peerDeps `react ^19.1.1`；RNOH 0.84 官方模板用 19.2.3（同为 19.x）→ **crish 共享层 React 19.2.3 心智在 0.82 线兼容** | npm 包元数据 + 官方环境搭建文档 |
| @types/react | ^19.x | 随 react | 官方模板 |
| @react-native/babel-preset 等 | 0.82.x | 用 RN 0.82 配套版（不要混 0.86） | 官方环境搭建文档 |
| @react-native-community/cli | 20.x | 官方模板指定 20.1.0 | 官方环境搭建文档 |
| DevEco Studio | **6.0.1 Release**（0.82.30 配套；0.82.33 需 26.0.0 Beta1） | 按所用 RNOH 小版本配套 | 0.82.30/0.82.33 release notes |
| HarmonyOS SDK / min API | **min API 17**（target API 21） | 0.82.30 官方声明兼容 API 17-21；覆盖 NEXT 全系（5.x 中期线起） | 0.82.30 release notes |
| Hermes / JSVM | 双引擎（Hermes 字节码 hermes_bundle.hbc + JSVM bundle.harmony.js） | 官方环境搭建文档 | 官方文档 |
| Node.js | >= 20（模板 >= 22.11.0） | 官方模板 | 官方文档 |

### 5.2 与 Expo 57（iOS/Android 基线）的关系核对

| 维度 | iOS/Android（D4 冻结） | 鸿蒙（RNOH 0.82 线） | 兼容性结论 |
| --- | --- | --- | --- |
| RN | 0.86 | 0.82.1 | 鸿蒙独立版本线（M1 §3.3.5），无同步要求 |
| React | 19.2.3 | ^19.1.1（可用 19.2.3） | **React 19.x 同代，hooks/组件树兼容** |
| New Architecture | Fabric（0.86） | Fabric + CAPI（0.82） | 架构同源（Fabric），API 心智可迁移 |
| zustand v5 / immer | ✅ | ✅（纯 JS） | 无差异 |
| 共享包（shared-types/protocol-core） | 消费源码（workspaces） | 消费 dist 预构建产物 | M1 §4.6 方案 B（§5.3 本地验证） |
| Expo 特有 API | expo-* 全量 | 无（compat wrapper 替换） | M1 §4.3 映射表（本报告五桥即映射表的落实面） |

**结论：双工程共享面（React 19.x + zustand + 纯 TS 包）在 0.82 vs 0.86 间无版本断裂；唯一需要纪律约束的是"零 Expo 依赖"（M1 §4.6 纪律 1，ESLint restricted-imports 强制）。**

### 5.3 共享层兼容性本地验证（task 3 的本地部分）

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| `packages/shared-types/package.json` 依赖面 | 仅 `zod ^3.25.76`，**零 react/react-native/expo** | 本地实读（2026-08-10） |
| `packages/shared-types/src` 的 import 面 | grep `from 'react-native'|from "expo` **零命中** | 本地 grep |
| `packages/shared-utils` 依赖面 | 同上零命中 | 本地 grep |
| shared-types 的 dist 构建面 | 已有 `build` 脚本（tsc 声明 + esbuild JS）与 `exports` 字段（development→src / 默认→dist），`files: ["dist"]` | 本地实读 package.json |
| 生成器产物（generated/engine） | `dist/generated/engine/*` 已在构建产物内（events/types/parser） | 本地实读 dist 目录 |

**结论：M1 §4.6 方案 B（鸿蒙工程消费共享包 dist 预构建产物 + 契约漂移检查）所需的前置条件（共享包构建面）已存在；纯 TS 无 RN 依赖 → 领域层共享无障碍（任务书第 3 问确认）。** 实施补强点：共享包增加 CI 契约漂移检查（R5-01 验收锚点已含"git diff --exit-code"）。

### 5.4 版本线建议（0.82 vs 0.84 决策窗口）

| 事实 | 结论 |
| --- | --- |
| 0.82 线当前状态 | npm `0.82-stable`=0.82.30（2026-05-21 发布，稳定）；0.82-main 分支 2026-08-08 仍在合入 → **维护活跃，非日落线** |
| 0.84 线当前状态 | 官方文档主推线（环境搭建/鸿蒙化开发指南均以 RN 0.84.1 为例）；0.84.1→0.84.3 三个月三发；但 npm 无 `0.84-stable` 标签（仅 `0.84-rc`=0.84.2）→ **官方尚未宣布 0.84 转 stable** |
| 官方口径 | "稳定版以 0.XX-stable dist-tag 标注…当前实际在线的版本线及其 stable tag 以 npm 实时查询为准，不在此枚举" | — |
| M1 裁决的复核 | M1 锁"0.82 稳定线"仍成立（stable 标签在 0.82、线在维护）；**但需登记一个决策点**：若 P2 启动（预计 2026 Q4-2027 Q1）时 0.84 已转 stable，**优先采用 0.84 线**（RN 0.84.1 / React 19.2.3 / 官方文档主推 / min API 17 相同） | 本报告建议（交主控） |
| 对 M1 真机矩阵的微调 | M1 §8.1"5.0 作为最低 API 基线（RNOH 0.82 编译基线 5.0.1/13）"→ 按 2026-08-10 release notes 修正为 **min API 17**（0.82.30 声明）；NEXT 5.0（API 12/13）设备理论上低于 0.82 线官方下限，真机矩阵以 6.x 为主力、5.x 后期线为下限（详见风险 R3） | 本报告修正建议 |

### 5.5 版本线验证结论（task 3 汇总）

1. **RNOH 0.82 + RN 0.82.1 + React 19.2.3 兼容矩阵成立**（React ^19.1.1 覆盖 19.2.3）；RN 0.82 仍在上游文档化维护窗口；
2. **共享层（协议类型生成产物 TS）兼容无障碍**：纯 TS 零 RN 依赖 + dist 构建面已具备（本地验证）；
3. **0.82 线维护活跃**（0.82-main 2026-08-08 合入），非死线；npm 标签滞后于 changelog（0.82.33 未发 npm）是工程纪律提醒项而非风险；
4. **0.84 线为上升期观察线**：P2 启动时重审，转 stable 则升级基线（决策点登记）。

---

## 6. Gate A/B 评估与建议裁决

### 6.1 Gate A：技术可行性（5 桥都能通 + 构建出包）

**建议裁决：条件通过（CONDITIONAL GO）。**

| 判据 | 评估 | 证据 |
| --- | --- | --- |
| 五桥可用性 | 5/5 有路径：网络 WS 官方支持、深链官方宿主 + 生态路由、文件远程随 WS / 本地 SQLite 双路径、安全存储自研桥、推送自研桥（§4.8） | 第 4 章全表 |
| 自研桥工作量 | 2 个必需（KeyStore + PushKit）+ 1 个待定（SQLite：自研 relationalStore 或审计后采用 port）；接口面均小（各 2-5 方法），CAPI 桥接有官方完整教程；团队有 C++/Rust 背景（M1 §10.4） | M1 §4.3 + 官方 TurboModule.md |
| 构建出包 | 全链路官方文档齐备：`@react-native-community/cli init` + `bundle-harmony`（npm run dev）→ rawfile bundle → DevEco 宿主（RNAbility/RNApp/CAPI/NDK 文本测算）→ hvigor 编译 → release 双包（.har 源码版 / release2.har 字节码版）→ .app 打包 → AGC 上架 | 官方环境搭建.md / 鸿蒙化开发指南.md（2026-08-10 实查） |
| 工具链 | DevEco Studio 6.0.1+ / hdc / HDC_SERVER_PORT / RNOH_C_API_ARCH=1 / 华为云 npm 镜像——全部文档化 | 官方环境搭建.md |
| 剩余未知（收敛项） | 全部集中在**真机冒烟**：wss+证书固定（N2）、Linking JS 映射（D1-D3）、Push Kit 桥（P1-P5）、SQLite 桥（F3-F4）、release2.har 字节码包行为、WS 前台保活（N5） | §4 冒烟清单 |
| 真机前置 | 需 NEXT 真机 2-3 台（Mate 70/Pura 80 等，M1 §8.2）+ 华为开发者账号/AGC 签名（P0-02 并行办理） | M1 §8.2 + Z0 P0-02 |

**Gate A 通过线（写入 P1 预研验收）**：§4 冒烟清单 N/S/P/D/F 五组全绿（或对未过项给出明确替代路径）+ NEXT 真机"审批链路"（配对 → WS 连接 → 审批卡 → 决策送达）跑通 + 五桥中自研桥（KeyStore/PushKit）在真机完成最小可用验证。

**不通过时的处置**：按 M1 §9.4 回退链——WS 缺口 → socket 自研桥；Push Kit 缺口 → "打开 App 拉取"降级（推送永远只是加速器，M1 §6.3）；最坏 → 锁 0.72 线或 ArkUI 核心屏应急（M1 §9.2）。

### 6.2 Gate B：投入产出（用户规模 / 维护成本 vs 市场收益）

**建议裁决：条件 GO（P2 立项条件四件套，见 §8.3）。**

| 维度 | 评估 | 说明 |
| --- | --- | --- |
| 市场信号（宏观） | HarmonyOS 5.0（NEXT）2025-03 正式推送、6.0 2025-10 发布、7.0 开发者版 2026-06；NEXT 已是华为新机默认系统；2024 Q1 鸿蒙中国份额 17% 超 iOS | M1 §3.3.1.1 既有查证（2026-08-09），本报告未重复实查，引用之 |
| 用户规模（微观） | **暂无数据**：crish 尚未上线，鸿蒙用户占比未知 → 需 P1 双端上线后埋点（M1 Gate A 表"用户信号"项） | M1 §9.5 |
| 维护成本 | 鸿蒙端 ≈ 0.62×iOS（共享三层后只写原生壳 + 适配层）；P2 MVP 6-10 周（1-2 人）；预研 2-4 人周沉没成本可控 | M1 §10.2/§10.3 |
| 市场收益 | 不做鸿蒙原生 = 放弃华为新机（NEXT）用户；4.x 存量由 Android APK 覆盖（P1 零成本） | M1 §2.3 |
| 竞争替代 | Flutter 无官方鸿蒙计划（M1 已查证）；uni-app/Taro 与 React 栈断裂（M1 已裁决否决）——RNOH 是 React 栈唯一选项 | M1 §3.3 |
| 生态风险对冲 | 分阶段投资纪律（M1 §9.3）：P2 MVP + 决策门；信号为负 → 观察态（沉没 2-4 人周） | M1 §9.2/§9.5 |

**Gate B 建议**：**不预设 GO/NO-GO，落为"条件 GO"**——P2 立项依赖 §8.3 四条件；预研报告本身（本文件）即 Z0 §9.9 P0-04 验收锚点。

### 6.3 建议裁决汇总

| Gate | 裁决 | 条件 |
| --- | --- | --- |
| Gate A（技术可行性） | **CONDITIONAL GO** | 五桥冒烟全绿（§4 清单）+ NEXT 真机审批链路 + 自研桥最小可用；不通过 → M1 §9.4 回退链 |
| Gate B（投入产出） | **CONDITIONAL GO** | P1 双端上线 + 用户信号达基线 + Gate A 数据 + 版本线复核（§8.3） |

---

## 7. 风险清单与缓解

| # | 风险 | 影响 | 概率 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | **0.84 转 stable 后 0.82 线维护优先级下降**（官方文档主推线已切 0.84，0.82-stable 标签停滞在 0.82.30） | 鸿蒙端若锁死 0.82，安全/功能修复跟进变慢 | 中（结构性，时间问题） | ① P2 启动时重审版本线（§5.4 决策点）；② 0.82-main 2026-08-08 仍在合入（现状活跃，持续监控）；③ 锁 stable 标签 + 版本升级指导（官方 版本升级指导.md 维护升级适配清单） |
| R2 | **npm 标签滞后于 changelog**（0.82.33 未发 npm；0.82-stable 停 0.82.30） | 误以为线内无新版本；升级误用 rc 版 | 中 | 以 `npm view ... dist-tags` 为唯一真源；changelog 只作趋势参考；CI 版本对齐断言（M1 K1） |
| R3 | **min API 基线抬升**：0.82.30 官方 min API 17（M1 旧文档口径 5.0.1/API 13） | NEXT 5.0 初代机型（API 12/13）可能低于官方下限 | 中 | 真机矩阵以 6.x 主力 + 5.x 后期线验证；华为 5.0 存量占比以 P2 时点实查为准；低版本机型降级为"打开 App 拉取"体验 |
| R4 | **自研桥（PushKit/KeyStore）排障工作量被低估** | 工期超支 | 中 | 桥接面收窄（各 2-5 方法）；CAPI 官方教程 + C++ 团队背景（M1 §10.4）；P1 预研期先做最小可用验证（§8.2） |
| R5 | **三方 port 碎片化**：sqlite/netinfo 等 port 均带 beta 后缀且不在 usage-docs 收录面 | 依赖不可用、排障困难 | 中 | M1 §4.3"默认零三方原生库"纪律：SQLite 优先自研 relationalStore 桥；port 引入必须过适配审计（版本线对应 + 维护记录 + 真机冒烟） |
| R6 | **wss + 自签证书固定面未验证**（RNOH WS 层的自定义 CA/指纹支持） | 安全基线（D5 TLS-01~10）在鸿蒙端打折 | 中 | N2 冒烟前置；caPathProvider/remoteValidation 原生口子（API 接口说明.md）；备选 ssl-pinning port；最坏自研 socket 桥（M1 §5.8） |
| R7 | **鸿蒙市场信号不确定**（宏观） | 投入回报不确定 | 高（不可控） | M1 §9.3 分阶段投资纪律；本报告 Gate B 条件化（§6.2） |
| R8 | **真机稀缺 + AGC 账号前置**（NEXT 真机 2-3 台、华为账号/签名/推送开通） | 冒烟无法执行 | 中 | P0-02 并行办理（Z0 §9.1）；设备采购列入 P1 预研前置清单（M1 §10.4） |
| R9 | **构建链工具链差异**（DevEco/hvigor 与 EAS 完全不同） | 团队学习成本 | 低-中 | 官方文档 + 培训 1 名 ArkTS 工程师（M1 §10.4）；CI 用 hvigorw 命令行（M1 §7.1） |

---

## 8. P1 并行预研建议与 P2 启动条件

### 8.1 P1 并行预研（建议立即启动，2-4 人周）

对齐 M1 §10.3 与 Z0 §9.1（P0-04 与 R2 并行不占人力），预研交付物 = P2 任务书（R5-01~R5-05）直接输入：

| 预研项 | 内容 | 对应章节 |
| --- | --- | --- |
| 1. 工程骨架 | bare RN 0.82.1 工程 + @react-native-oh/react-native-harmony@0.82-stable + harmony/ 宿主（RNAbility/RNApp/CAPI/NDK 文本测算）+ bundle-harmony 出包 | §5.1、M1 §3.3.6 |
| 2. 五桥冒烟 | §4 冒烟清单 N/S/P/D/F 五组（真机） | 第 4 章 |
| 3. 审批链路冒烟 | NEXT 真机：配对 → WS 连接 → 审批卡 → 决策送达（T03/T04 场景） | M1 §8.5 |
| 4. 共享层接线验证 | 共享包 dist 引用 + 契约漂移检查（git diff --exit-code）+ 零 Expo 依赖 ESLint 规则试点 | §5.3、M1 §4.6 |
| 5. 版本线复核点 | P2 启动时复查 `npm view ... dist-tags`：0.84 是否转 stable | §5.4 |
| 6. 报告更新 | 预研实测数据回填本文（冒烟结果 / 自研桥工作量实测） | 本文件 |

**P1 预研期角色建议**（M1 §10.4）：1 名 RN 工程师 + 1 名 C++ 背景工程师兼职（无需专职 ArkTS 工程师；ArkTS 培训在 P2 启动前完成）。

### 8.2 P1 预研的真机与账号前置（与预研并行办理）

| 前置项 | 归属 | 说明 |
| --- | --- | --- |
| NEXT 真机 2-3 台（Mate 70 / Pura 80 等，覆盖 6.x 主力 + 5.x 后期线） | 设备采购 | M1 §8.2 清单 |
| 华为开发者账号 + DevEco 签名（Support HarmonyOS 自动签名） | P0-02 | 真机运行必需 |
| AGC 推送服务开通（Push Kit） | P0-02 | 推送桥冒烟（P1-P5）前置 |

### 8.3 P2 启动条件（Gate B 落地的四件套）

| # | 条件 | 判定数据来源 | 对齐 |
| --- | --- | --- | --- |
| 1 | **Gate A 冒烟全绿**：§4 清单 N/S/P/D/F 全绿（或未过项有明确替代路径）+ NEXT 真机审批链路 + 自研桥最小可用 | P1 预研交付物（§8.1） | M1 §9.5 Gate A 表"RNOH 预研报告"行 |
| 2 | **P1 双端上线**：iOS/Android 商店过审、线上无 P0 缺陷 | 商店审核 + 崩溃监控 | M1 §9.5 Gate A 表 |
| 3 | **用户信号达基线**：双端留存/审批使用频次达预设基线 + 华为新机/鸿蒙用户占比信号 | 埋点 | M1 §9.5 Gate A 表"用户信号"行 |
| 4 | **版本线复核**：0.84 是否转 stable → 重选 RNOH 基线（0.82 维持或 0.84 升级） | npm dist-tags 实时查询 | §5.4 决策点 |

**P2 启动即检查项**（任务书继承）：R5-01~R5-05 依赖 R0/R2 共享层冻结（Z0 §9.7）；P2 排期 6-10 周（1-2 人）；NEXT 上架材料与 AGC 合规随 R5-05。

### 8.4 P3 追平条件（引用 M1，不展开）

M1 §9.5 Gate B 表：NEXT 上架 + 审批/推送全链路真机全绿 + 鸿蒙用户信号 + 版本滞后 ≤1 个功能版本。

---

## 9. 附录：查证记录与证据索引

### 9.1 网络查证记录（2026-08-10 实查）

| # | 查证项 | 来源 | 结论（关键事实） |
| --- | --- | --- | --- |
| 1 | RNOH npm 版本线 | registry.npmjs.org/@react-native-oh/react-native-harmony（dist-tags + 版本元数据） | latest=0.82.30、0.82-stable=0.82.30（2026-05-21 发）、0.82-rc=0.82.32（2026-07-16）、0.84-rc=0.84.2、0.77-stable=0.77.71、0.72-stable=0.72.140、beta=0.82.7 |
| 2 | RNOH 包依赖声明 | 同上（0.82.30/0.82.32/0.84.2/0.72.140 各版本元数据） | peerDependencies：0.82 线 react-native 0.82.1；0.84 线 0.84.1；0.72 线 0.72.5 |
| 3 | RN 0.82 的 React 要求 | registry.npmjs.org/react-native/0.82.1 | peerDependencies react ^19.1.1、@types/react ^19.1.1；engines node >= 20.19.4 |
| 4 | RN 官方版本线 | reactnative.dev/versions | 最新 0.86；0.82 仍在文档化维护窗口（0.76 及以下进 archive） |
| 5 | RNOH 核心仓现状 | gitcode.com/CPF-RN/ohos_react_native + branches API + CHANGELOG.md（main 与 0.82-main） | 381 stars / 480 forks / 5.69K commits / 131 tags / 43 members；main 2026-08-08、0.82-main 2026-08-08、0.77-main 2026-08-08、0.72-main 2026-08-06 均有提交；0.82 线 changelog 0.82.3→0.82.33（2026-01-08→07-23）；0.84 线 0.84.1→0.84.3（2026-06-01→07-23） |
| 6 | 0.82 线 release notes | 0.82-main 分支 docs/zh-cn/release-notes/react-native-harmony-v0.82.30.md / v0.82.33.md | 0.82.30：release、RN 0.82.1、DevEco 6.0.1 Release、target API 21、min API 17、compat 17-21；0.82.33：内部流转版本未发 npm、DevEco 26.0.0 Beta1、target API 26、min API 17 |
| 7 | 0.84 线 release notes | main 分支 docs/zh-cn/05-运维/release-notes/v0.84.1.md / v0.84.3.md + 环境搭建.md | 0.84.1：RN 0.84.1、react 19.2.3、DevEco 6.1.0 Release、target API 23、min API 17；0.84.3：target API 26；官方文档主推 0.84.1（环境搭建 / 鸿蒙化开发指南） |
| 8 | 官方 API 能力面 | docs/zh-cn/01-设计/API接口说明.md、功能开发.md、规格类FAQ.md、RN应用鸿蒙化开发指南.md | RNAbility want/launchURI；RNOHCoreContext.launchUri；RNInstanceOptions caPathProvider/remoteValidation（API>=26 自定义验证回调）；仅 TurboModule 不支持 NativeModule；深链宿主口子；Linking 无专项文档 |
| 9 | 官方三方库适配面 | gitcode.com/CPF-RN/usage-docs（_sidebar.md） | 50+ 库收录：netinfo/async-storage/gesture-handler/reanimated/safe-area-context/react-navigation 三件套/flash-list/svg/webview/vector-icons/fs/push-notification-ios 等；无 keychain/secure-store/pushkit/sqlite 收录 |
| 10 | @react-native-ohos 生态 | npm search API（@react-native-ohos 100 条 + 专项搜索） | sqlite-storage v6.1.2-beta.3（07-09）、op-sqlite v14.0.1、realm v12.13.2、netinfo v11.5.0-beta.1（06-11）、async-storage v2.2.2-beta.1（06-11）、react-native-fs v2.20.2-beta.2（07-14）、blob-util v0.22.3-beta.1、ssl-pinning v1.7.0-beta.2（07-11，br_rnoh0.82）等；无 keychain/secure-store/PushKit 对应物 |
| 11 | 老 GitHub 组织 | api.github.com/orgs/react-native-oh-library/repos | 抽查 slider/progress-view/picker/webview/netinfo 等均 archived: true |
| 12 | 涂鸦 fork | registry.npmjs.org/@tuya-oh/react-native-harmony | latest=0.72.58-rc1.0.18（0.72 线） |
| 13 | expo 社区桥 | registry.npmjs.org/expo-harmony-cli | latest=0.2.5（Expo SDK 52 基线，2026-08-05 更新） |
| 14 | 0.82.33 npm 状态 | registry.npmjs.org/@react-native-oh/react-native-harmony/0.82.33 | 404（未发布 npm，与官方 release note"内部流转版本"一致） |

### 9.2 本地验证记录（2026-08-10）

| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | packages/shared-types/package.json | 依赖仅 zod；main/types 指向 dist；exports 双通道（development→src / 默认→dist）；build 脚本齐备 |
| 2 | packages/shared-types/src 与 shared-utils | grep `from 'react-native'` / `from "expo` 零命中（纯 TS） |

### 9.3 仓库内文档依赖索引

| 文档 | 与本文关系 | 引用点 |
| --- | --- | --- |
| `docs/multi-device/plans/M1-multi-platform.md` | 鸿蒙路线裁决母文（本文不重做裁决，只验证） | §3.3（RNOH 深挖）、§3.3.6（工程要素）、§4.3（compat 映射表）、§5（能力矩阵）、§9.3/§9.5（Gate A/B）、§10（工作量） |
| `docs/multi-device/plans/M8-push-release.md` | 推送通道细化（Push Kit 路线） | §2.4（HarmonyOS NEXT 推送 + RNOH 自研桥） |
| `docs/multi-device/plans/D4-mobile-tech.md` | iOS/Android 技术基线 | 五层架构、expo-* 选型、网络层纪律 |
| `docs/multi-device/plans/D8-engineering-release.md` | 工程与发布 | 共享包构建面、契约漂移检查 |
| `docs/multi-device/Z0-master-plan.md` | 任务书与验收锚点 | §9.1（P0-04）、§9.9（验收锚点）、§9.7（R5 任务包） |
| `docs/multi-device/plans/D5-security.md` | 安全基线 | TLS-01~10（R6 风险引用） |

### 9.4 开放问题（交主控/后续任务书）

1. **0.84 转 stable 时间窗口**：P2 启动时复查 npm dist-tags，若 `0.84-stable` 已存在则评估直接采用 0.84 线（官方文档已主推）——本报告建议设为主控 Q4 复审项（M1 §11.4 开放问题 3 的机制化延续）；
2. **RNOH WS 层对 wss + 自签证书 + 指纹固定的支持面**：文档无明示，P1 冒烟 N2 为决定性验证；若缺口，评估 ssl-pinning port 或自研 socket 桥工作量；
3. **Linking JS API 在 RNOH 的映射行为**：官方文档无专项说明，P1 冒烟 D1-D3 验证；备选宿主 launchUri 注入方案；
4. **SQLite 桥选型**：自研 relationalStore 桥 vs 审计后采用 sqlite-storage port，P1 冒烟期定案（F3-F4）；
5. **Push Kit 服务端 API 细节与配额**：归 M8 细化（M1 §11.4 开放问题 1），本报告只确认客户端桥路径；
6. **0.82.30 min API 17 对 NEXT 5.0（API 12/13）初代机型的兼容口径**：以华为官方 SDK 版本说明为准，P2 真机矩阵定案。

---

## 总结

**RNOH 0.82 稳定线可支撑 crish 鸿蒙 P2 立项：版本线验证成立（RN 0.82.1 / React ^19.1.1-19.2.3 / min API 17 / DevEco 6.0.1+，0.82-main 2026-08-08 仍活跃维护；0.84 线为上升期观察线，转 stable 后重选基线）；共享层（纯 TS 协议包）本地验证零 RN 依赖、dist 构建面已具备；五桥 5/5 有可行路径（网络 WS 官方支持、深链官方宿主 + 生态路由、文件远程随 WS + 本地 SQLite 双路径、安全存储与推送为自研 TurboModule，无不可用项）；Gate A 条件通过（剩余未知收敛到 P1 真机冒烟清单）、Gate B 条件 GO（P2 启动 = Gate A 冒烟全绿 + P1 双端上线 + 用户信号 + 版本线复核四件套）；建议 P1 期并行开展 RNOH 技术预研（工程骨架 + 五桥冒烟 + NEXT 真机审批链路），预研成果即为 R5 任务书输入。**
