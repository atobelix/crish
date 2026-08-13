# AU5 R2 多维度全面审计（R2 移动端 crish-mobile）

> 文档编号：AU5-R2-multidim
> 类型：R2 阶段收口多维度全面审计（只读分析 + 本报告）
> 日期：2026-08-13
> 锚点：Z0 §9.4（R2-01~~R2-16 任务包表）、Z0 §9.9（验收锚点 R2 行）、Z0 §3.4（AU2 落地缺口 G-1~~G-10）、D4/M5/F2~F6、R2-01/R2-15/R2-16 文档、apps/crish-mobile 代码、git log
> 编码：UTF-8 无 BOM，中文
> 纪律：本任务只读 + 本报告产出；未修改任何源文件（`git status` 复核：仅并行 Agent 在途改动，本任务零改动）

---

## 0. 结论速览

| 项                  | 结论                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R2 完成度总判定** | **约 88%**（代码与单测面约 95%；验收/真机面拖累：R2-16 未执行、真机 dev client 未做、三处占位页、安全三缺口）                                              |
| **R2UX 条款落地数** | **10/28 已落地、11/28 部分、7/28 未落地**（含 1 条真机验证类条款）                                                                                         |
| 测试面              | 已提交基线 1561 用例 / 97 套件全绿（3686bb8f）；实测 1574/1575 绿，唯一红测 = 并行 Agent 在途通知中心（notificationMeta.test.ts:135 深链 scheme 校验缺口） |
| 覆盖率              | 94.49/85.66/96.73/94.49 ≥ 60/75/70/60（R2-15 实测，阈值为全局强制）                                                                                        |
| R2-16 真机联调      | 执行方案（R2-16-e2e-plan）+ 裁决 R-1/R-2 已归档；**执行记录文档未产出**，E2E-1~6 未执行；配对 UI 硬前置已于 3686bb8f 解除                                  |
| 排期建议            | 见 §10：真机联调收尾 5 项前置（npm install 真实驱动接线 / 通知中心红测修复 / 桌面 manifest 8 条登记）+ R3 推送 4 项依赖                                    |

---

## 1. 维度一：正确性（验收锚点逐项核对）

### 1.1 R2-01 ~ R2-16 核对表（Z0 §9.9 R2 行 × 实现现状）

| 包    | 锚点（Z0 §9.9）                                                   | 判定                                 | 证据（代码/测试/提交/文档）                                                                                                                                                                                                                                                                                                        | 风险 |
| ----- | ----------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| R2-01 | 真机 dev client 冷启动达标；typecheck/lint/单测绿；CI job 上线    | **部分**                             | 模拟器侧全过（R2-01-acceptance-emulator.md：2615ms 热 bundle 冷启动、13 套件 197 用例、CI job ci.yml:126-137）；**真机 dev client（expo run:android）未做**（文档 §10-2 明言留待 R2-16）                                                                                                                                           | 中   |
| R2-02 | 配对→断网→重连→追平全链路真机通过；相位投影全映射表单测           | **部分**                             | 连接层全实现：16f2f55f（WsGateway 103-kind 白名单 + HMAC-SHA256 RFC4231 向量 + 退避/心跳/相位投影，84 测，network 覆盖 96%）；ReconnectingWsClient.ts:173-280 projectReconnect 全映射表 + ReconnectingWsClient.test.ts；**真机链路未过**                                                                                           | 中   |
| R2-03 | 配对状态机单测 + 令牌生命周期（刷新/吊销）真机验证                | **部分（约 85%）**                   | 状态机+UI 全链：af6e3355（pairMachine/pairProtocol/CXN 码，64 测）、3686bb8f（R2-03c 配对 UI 接线：manual/welcome/scan 占位 + ensurePairingWiringForApp 水合，40 测）；**令牌刷新未实现**（无 auth.refresh 发送方）、**吊销真机验证未做**、**证书固定未实现**（见 §2）                                                             | 高   |
| R2-04 | 离线决策送达 P95 达标；重复事件幂等测试绿；双阶段确认 UI 语义测试 | **部分（约 80%）**                   | 数据面/UI 全链：6214ab8c（approvalStore/outbox 三态幂等 197 测）+ 646451b3（approvalWiring 两阶段确认/对账/退避 22 测）+ 98f3918b（B2 五命令 56 对拍测）；幂等测试绿；**L2 滑动确认未实现**（ApprovalActionBar.tsx:4 注释明言）、**P95 无真机实测**、通知中心在途（见 §4.3）                                                       | 中   |
| R2-05 | 100 条/秒追加不掉帧；L2/L3 run 控制真机验证                       | **部分（约 75%）**                   | 观测面数据层+页面：18584bac（eventStore/sessionStore + dashboard 数据层）、2fa04fed（会话详情 follow 暂停 + 终端只读页 ANSI 白名单/5000 环形/固定行高）；run 控制命令构造齐（sessionCommands.ts:108-109 runControl）；**首页仪表盘仍为占位**（app/(tabs)/index.tsx）、**run 详情占位**（app/run/[runId].tsx）、100 条/秒无帧率断言 | 中   |
| R2-06 | 目录树 1 万项级性能达标；移除本机全流程（吊销+清凭据+保留缓存）   | **部分（约 80%）**                   | 文件浏览全链（18584bac F4 八命令对拍 + 646451b3 树态/缓存 LRU 128/1MB/64MB）、设置页完整（ae726486 47 测含移除本机双确认）；**1 万项性能无实测**、诊断/用量/后台任务三页占位                                                                                                                                                       | 中   |
| R2-07 | B1 监控 10 条 T-M6 锚点绿                                         | **完成**                             | 2fa04fed：10 命令 82 对拍测（monitorCommands.test.ts，注册表直读）；7 桌面差异 D-01~D-07 全部注册表权威判定 + da196c13 归档                                                                                                                                                                                                        | —    |
| R2-08 | B2 审批 5 条 T-M6 锚点绿                                          | **完成**                             | 98f3918b：56 对拍测；D-15/16 差异登记；409 mismatch 不可重试收敛（approvalCommands.ts:18-23）                                                                                                                                                                                                                                      | —    |
| R2-09 | B3 文件 8 条                                                      | **完成**                             | 18584bac：filesCommands.ts 8 命令构造对拍（listDir/readFile/writeFile/listWorkspaces/switchWorkspace/searchFiles/assetUrl/fileStat）                                                                                                                                                                                               | —    |
| R2-10 | B4 会话 4 条                                                      | **完成**                             | b4e04ebd：46 测（runTask/runControl/cancelRun/searchSessions）                                                                                                                                                                                                                                                                     | —    |
| R2-11 | B5 设置 5 条                                                      | **完成**                             | b4e04ebd：51 测（getSettings/setSettings/settingsConfirm/pauseAutomation + queryPresence）                                                                                                                                                                                                                                         | —    |
| R2-12 | B6 设备域 + mobile_* 8 条新增（含 manifest 登记）                 | **完成（移动端面）/ 跨端缺口已登记** | b4e04ebd（B6 5 命令 50 测，D-08~12）+ ae726486 + mobileCommands.test.ts：mobile_* 8/8 已由既有批次实现（反过度设计不建空壳），**桌面 manifest 8 条全部未登记（缺口清单 590 行断言锁定）** → R2-12c 承载面 = 桌面接线轮                                                                                                             | 中   |
| R2-13 | 迁移幂等测试；secure-store 密钥位验证                             | **完成**                             | 646451b3：8 表 schema + migrations + DAO + secureStore（68 测）；migrations.test.ts 幂等 + secureStore.test.ts 4+2 位断言                                                                                                                                                                                                          | —    |
| R2-14 | 8 store 三波落地 + selector 契约无拉扯                            | **完成**                             | auth+connection（b4e04ebd）→ approval+event+session（6214ab8c/18584bac）→ terminal+settings+notification（ae726486 三波）；stores 全部 reducer/selector 三件套 + useAppStore useShallow 统一绑定                                                                                                                                   | —    |
| R2-15 | jest 全量 ≥100；覆盖率 60/75/70/60 关键面                         | **完成（超达标）**                   | R2-15-coverage-report.md：90 套件 1521 用例全绿；94.49/85.66/96.73/94.49；实测已提交基线 1561/97 套件（3686bb8f）；本审计实测 1575 用例（+1 红测在途非本基线）                                                                                                                                                                     | —    |
| R2-16 | D4 M0-M4 出口 + F2 验收 1-7 + 双端同会话并发用例全过              | **未执行（方案+裁决已就绪）**        | R2-16-e2e-plan.md（E2E-1~~6 场景清单 + 前置检查 14 项 + 风险 R-1~~R-6）；主控裁决归档（e3e22951：R-1 明文 ws 联调豁免、R-2 载体 B harness 注入）；**R2-16-acceptance-execution.md 未产出**；配对 UI 接线（3686bb8f）已解除原硬前置 R-2                                                                                             | 高   |

### 1.2 R2-16 真机联调执行状态核对

- **执行文档**：`docs/multi-device/R2-16-acceptance-execution.md` **不存在**（glob + Test-Path 双确认）——验收执行轮尚未发生。
- **方案就绪度**：R2-16-e2e-plan.md §4 六场景（E2E-1 配对 / E2E-2 事件流 / E2E-3 审批闭环 / E2E-4 断线续传 / E2E-5 撤销 / E2E-6 移除本机）依赖矩阵齐备；主控裁决 R-1（联调 harness 明文 ws，生产 wss 强制不动，main.rs:1057）+ R-2（载体 B harness 注入 approval-requested 先行）已归档（e3e22951，2026-08-11）。
- **方案产出时的阻塞项现状**（逐一复核）：
  | e2e-plan 阻塞（2026-08-13 方案日）                    | 现状（本审计复核）                                                                                                                                                                                                                                                                  |
  | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | ① 配对 UI 未接线（R-2，关键）                         | ✅ **已解除**：3686bb8f 接线 complete（manual.tsx→PairManualScreen.beginPairing；pair/_layout.tsx 装配 + 水合）                                                                                                                                                                     |
  | ② wss 自签证书 × RN WebSocket 无信任选项（R-1，关键） | ⚠️ 裁决已归档（明文豁免）；**证书固定仍为架构性缺口**（见 §2.2，真机生产形态未闭环）                                                                                                                                                                                                |
  | ③ expo-secure-store/expo-sqlite 未安装（R-3，高）     | ⚠️ package.json 已声明（~57.0.1），但 `Test-Path node_modules/expo-secure-store` = **False**（未安装）；真实驱动接线点（secureStore.ts:184-200 注释 + pairingBootstrap.ts:44-51 configurePairingDriver）**未启用**——E2E-4 冷启动恢复 / E2E-6 清凭据将走 InMemory 回退，不可作为验收 |
  | ④ mobileCommands.test.ts:362 单测失败（R-6，低）      | ✅ 已清零（本审计全量实测仅通知中心 1 红测，与该命名差异无关）                                                                                                                                                                                                                      |

---

## 2. 维度二：安全

### 2.1 核对表

| 项                                                              | 判定                                 | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 风险             |
| --------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| secure-store 4 密钥位（token_key/refresh_key/keypair priv/pub） | ✅ 已实现                            | secureStore.ts:14-42（KEYS + CORE_KEY_SLOTS=4 位 + ALL_KEY_SLOTS=6 位含指纹/中间态）；savePairingCredential/loadPairingCredential（缺一返回 null 不部分恢复）;secureStore.test.ts:37-49                                                                                                                                                                                                                                                              | —                |
| 密钥材料不落 SQLite                                             | ✅                                   | authStore.ts:5-7 明文只经注入持久化流转；SQLite device_info 仅存 cert_fingerprint_tail 等非敏感字段（schema.ts:128-136）；M5 §6.1 划分原则对齐                                                                                                                                                                                                                                                                                                       | —                |
| 配对密码学推导不落库，只落派生结果                              | ✅                                   | keyAgreement.ts（psk→ecdh→master→token/enc/refresh 三段链）；finalizePairing 仅持久化派生值（pairingWiring.ts:725-794）                                                                                                                                                                                                                                                                                                                              | —                |
| **证书固定（fingerprint 注入）**                                | ❌ **未实现（R2-03b 未覆盖项确认）** | HOST_FINGERPRINT 槽位存在但**无任何写/读消费点**（grep 全仓：仅 secureStore 定义 + device_info.cert_fingerprint_tail 列 + 测试）；ReconnectingWsClient.ts:284-287 默认工厂 `new WebSocket(url)` **无信任注入面**（文件头注释「RN WebSocket 不支持自定义 header」）；pairingWiring 收口不写 hostFingerprint（cred 构造 740-745 无该字段）                                                                                                             | **高**           |
| 令牌生命周期 / 8h 会话密钥                                      | ❌ **未实现**                        | D5 §3.5 要求「每连接 HKDF 派生 8h 会话密钥」；移动端**无 auth.hello/auth_success 流程**：会话直接以 tokenKey（简化链=明文 token 回退）建连签名（pairingWiring.ts:738-739、buildSessionGateway 233-243）；refreshKey 落库但**无 auth.refresh 发送方**（kinds 注册表有 auth.refresh 条目，移动端零引用）；authStore.markTokenExpired() **无任何触发点**（grep 确认）；D5 §9.4 锚点 `auth_success_derives_session_key`/`session_ttl_eight_hours` 未落地 | **高**           |
| 敏感数据打码（事件流 sk- 形态，T-09 移动端侧）                  | ❌ **未实现**                        | 全仓 grep `sk-                                                                                                                                                                                                                                                                                                                                                                                                                                       | redact           | 打码`：移动端仅 terminalScreen 的 task-output 渲染注释相关，**无任何事件流/tool 输出打码实现**（桌面端 redact 面未移植到移动端数据链路） | 中  |
| 移除本机清理完整性                                              | ✅                                   | unpair()（pairingWiring.ts:526-551）：device.unlink best-effort → authStore.onUnpaired（clearPairing 6 键全清）→ 接线元数据 3 键删除 → 断连；**SQLite 缓存保留**（D4 §5.2 语义）；设置页双确认触发（settings.tsx onConfirmRemove）                                                                                                                                                                                                                   | —                |
| 桌面撤销自动解除                                                | ✅                                   | attachRevokedHandler（pairingWiring.ts:806-817）：device.revoked 匹配本机 deviceId → unpair；authStore.onUnpaired 被动复位                                                                                                                                                                                                                                                                                                                           | —                |
| 联调明文 ws 豁免的生产语义                                      | ✅                                   | R2-16-裁决-1 已归档：仅 harness `tls_enabled=false`（R1-11 先例），生产装配 main.rs:1057 强制 wss 不动；EndpointResolver.ts:20-26 缺省 tls=true                                                                                                                                                                                                                                                                                                      | —                |
| **深链 scheme 校验（新发现，在途文件）**                        | ❌ **红测中**                        | notificationMeta.ts:99-101：`pathPart.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')` **剥离任意 scheme**——`ftp://approval/tc-1` 被剥成 `approval/tc-1` 通过白名单；红测 notificationMeta.test.ts:135（本审计实测 1/1575 唯一失败）；应仅放行 `crish://`/`conex://`/无 scheme 相对路径                                                                                                                                                                      | 高（在途修复中） |

### 2.2 安全面问题清单（并入 §7 总清单）

S-1【高】证书固定未实现（R2-03b 缺口）：指纹槽位/表列齐备但零消费；RN WebSocket 无信任注入面；真机 wss 自签证书握手必失败（R2-16-e2e-plan §3.1 已论证）。修复路径：模拟器轮可 adb root 装系统 CA（保真备选）；产品面需在配对期把指纹写入 secure-store + 在 WS 握手层（原生模块或受控 WebView 装载点）做固定校验——建议作为 R3 安全补强项排期（见 §10）。
S-2【高】8h 会话密钥 / 令牌刷新未实现：当前会话令牌静态持久化，一旦泄漏无 8h 收敛；refreshKey 无消费方。修复：R3 前补 auth.refresh 重连流 + 会话密钥派生（对齐 D5 §3.5 / M7 T1 令牌分治），真机验证令牌吊销即时性。
S-3【中】T-09 移动端打码缺位：事件流/tool 输出中 sk- 形态密钥在移动端原样渲染。修复：ingestRouter 或渲染层加统一 redact（复用桌面端 redact 语义，移植为共享纯函数）。
S-4【高】通知中心深链 scheme 校验缺口（在途红测）：见 §4.3；修复=白名单 scheme 校验（仅 crish://、conex://、无 scheme 相对路径），红测恢复绿后再提交。
S-5【低】app.json scheme="crish" 与 F2 §6.2 深链形态示例 "conex://" 不一致（文档口径漂移，需主控定夺单一 scheme 名）。

---

## 3. 维度三：性能

### 3.1 核对表（M5 §9.1/§9.3 预算 × 代码面评估）

| 面                   | 预算（M5 §9.3 / R2UX-05 §5.1）       | 实现现状                                                                                                                                                                                                     | 判定                 | 风险 |
| -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ---- |
| terminalStore 行缓冲 | 5000 行/run 环形                     | ✅ terminalLineBuffer.ts:14 TERMINAL_RING_MAX=5000 + 单行 5000 字符截断；端到端裁剪测试（terminalScreen.test.tsx:94-127「5500 行→丢最旧 500 + 已截断标记」）                                                 | 达标                 | —    |
| feed 环形            | 500 条/session                       | ✅ eventReducers.ts:33 FEED_RING_MAX=500 + truncatedCount 计数 + 去重/回退 seq 丢弃                                                                                                                          | 达标                 | —    |
| eventStore 内存窗口  | 5000 条/会话 × ≤4 活跃窗口，切换卸载 | ✅ unloadWindow 存在（eventStore.ts:41）；窗口内存上限/4 窗口活跃策略需接线层编排（注释标注）                                                                                                                | 部分                 | 低   |
| Hermes 总堆          | ≤60MB 常驻                           | ❌ 无 Hermes 堆快照测量（M5 §9.4 周检未开展，无联调轮）                                                                                                                                                      | 未验证               | 中   |
| 冷启动到可用         | ≤2.5s（真机 dev client）             | 模拟器 2615ms（R2-01 §5 热 bundle 冷启动；首次全量 6.97s）；**真机未测**                                                                                                                                     | 部分                 | 中   |
| 事件流追加           | 100 条/秒不掉帧                      | FlatList + 行 memo + useShallow 齐备；**无帧率预算断言测试**（M5 §9.4 预算断言未落地）                                                                                                                       | 部分                 | 中   |
| 审批列表 100 条滚动  | 60fps                                | ⚠️ approvalListScreen.tsx:133-176 用 **ScrollView + rows.map**（非虚拟化）——100 条级可接受，但 R2UX §5.3 要求 FlashList+memo                                                                                 | 部分                 | 中   |
| 文件浏览万项         | 60fps / 1 万项                       | FlatList + 固定行高（FileRow height）+ 密度三档 44/48/56（useFilesVm.ts:40）；LRU 128 层目录缓存（filesCache.ts:23）；**万项实测未做**                                                                       | 部分                 | 中   |
| SQLite 打开+迁移     | ≤300ms                               | 迁移幂等测试绿；**真机计时未测**（真实驱动未接线，见 §1.2）                                                                                                                                                  | 未验证               | 低   |
| 轮询节流             | 前台 4s/弱网 15s/后台零轮询          | 数据面为事件推流（WS 订阅），无轮询实现；**无节流面**                                                                                                                                                        | 不适用（架构符合）   | —    |
| FlashList 虚拟化     | 会话 feed/审批/会话列表              | ❌ **全仓未引入 @shopify/flash-list**（package.json 无）；EventFeed.tsx:2 与 FileBrowser.tsx:2 注释「FlashList 未引入（D4 依赖清单无），用 RN 内置 FlatList」——FlatList 自带窗口化，属合理降级但未做性能验证 | 偏差（合理但需验证） | 中   |

### 3.2 性能面问题清单（并入 §7）

P-1【中】FlashList 缺席 + 审批列表 ScrollView.map：千级以下可接受；R2UX-05-01/06-01 条款的 60fps/万项断言无预算测试兜底。建议：真机联调轮补帧率实测（M5 §9.4 fps.ts），数据证明 FlatList 达标则冻结条款偏差；不达标再引 FlashList（D4 依赖清单更新需主控裁决）。
P-2【中】性能预算断言机制（M5 §9.4「关键路径在 CI 冒烟 job 跑预算断言」）未落地：启动/feed 追加/审批送达均无 CI 断言。建议 R3 收尾补最小埋点（Performance.mark + 决策送达时间戳对）。
P-3【低】eventStore 窗口上限与活跃窗口数无运行时断言（仅注释），防窗口数失控。建议补 store 单测（≤4 活跃窗口不变量）。
P-4【低】首次全量冷启动 6.97s（Metro bundle 12.9s 属 dev 面），release 面未测；建议 dev client 构建后补一次 release 冷启动基线。

---

## 4. 维度四：体验（R2-ux-best-practice 落地核对 + 专项）

### 4.1 专项核对

| 体验面                        | 判定        | 证据                                                                                                                                                                                                                                                                     | 风险 |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 配对流（welcome→manual→连接） | ✅          | pairWelcomeScreen/pairManualScreen 完整（3686bb8f）：实时 CXN 格式化+校验、A4 返回放弃确认（Dialog）、busy 防双点（submittingRef）、错误码→人话文案映射（PAIR_ERROR_TEXT 16 条）、锁定冷却提示、连接相位标签                                                             | —    |
| 审批 3 秒决策路径（数据面）   | ✅          | 决策区固定底部（ApprovalActionBar 固定 bar）；首屏见决策区；倒计时 15s 变红（ApprovalCard.tsx:115-189）；本地过期兜底（useApprovalListVm.ts:70-79）；**性能验证（≤3s/点按≤3 次）未实测**                                                                                 | 低   |
| 通知中心（R2-04e）            | ⚠️ **在途** | 并行 Agent 正在实现（未提交）：NotificationBadge/NotificationRow/notificationMeta/notificationCenterScreen + 首页铃铛入口（index.tsx 工作区改动）；**当前 1 红测**（notificationMeta.test.ts:135 ftp:// scheme 通过白名单）；notificationStore 数据面已提交（R2 round8） | 高   |
| 设置页                        | ✅          | settings.tsx→useSettingsVm：主题三选、通知偏好、文件缩略图、关于、移除本机双保险（SettingsRemoveLocalZone）；未连接禁用态                                                                                                                                                | —    |
| 文件浏览                      | ✅          | FileBrowser（面包屑/排序/四态/下拉刷新/工作区切换/密度三档）+ FilePreview（1MB 上限占位）+ 预览缓存 LRU                                                                                                                                                                  | —    |
| 首页仪表盘                    | ❌ **占位** | app/(tabs)/index.tsx 仍为 PlaceholderScreen「R2-05 落地」（含并行 Agent 通知入口改动，主体仍占位）；useDashboardVm 已实现且有 11 测（100% 覆盖）但**未接线**                                                                                                             | 中   |
| run 详情/后台任务/诊断/用量   | ❌ **占位** | run/[runId].tsx、tasks.tsx、diagnostics.tsx、usage.tsx 均为 ProtectedPlaceholder                                                                                                                                                                                         | 中   |

### 4.2 R2UX 条款逐条落地核对表（28 条，R2-ux-best-practice.md §7.2/7.3/7.4）

| 条款       | 规范要点                                                   | 判定       | 证据                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2UX-04-01 | 3 秒决策路径：点按≤3、首屏见决策区、预渲染摘要             | 部分       | 决策区固定底部 ✓；首屏即见 ✓；推送预渲染/性能实测 ✗（推送属 R3，无埋点）                                                                                                                          |
| R2UX-04-02 | L2 双阶段滑动确认（70% 阈值/回弹/reduce-motion 两段式）    | **未落地** | ApprovalActionBar.tsx:4 明言「L2 滑动确认不在本任务范围」；无 SlideToConfirm 组件（全仓 grep 无）                                                                                                 |
| R2UX-04-03 | busy 防双点：300ms 防抖 + decisionBusy 状态位驱动          | ✅ 已落地  | approvalReducers.ts:10 DECISION_BUSY_MS=300；decisionBusy store 位（approvalStore.ts:62）；组件禁用+loading（ApprovalActionBar.tsx:66-84）；单测（approvalStore.test.ts 18 例）                   |
| R2UX-04-04 | 决策后状态反馈：乐观更新/✓徽标/回滚/冲突/过期文案          | 部分       | 四路径状态机全实现（approvalReducers pending/deciding/conflict/expired + 回滚保留理由）；**✓ 徽标 150ms 淡入/500ms 返回动效未实现**（无动画层）                                                   |
| R2UX-04-05 | 离线 outbox 进度：「待发送」徽标 + 计数角标 + 重试人工提示 | ✅ 已落地  | outbox.ts 三态+退避 1s→4s→16s→60s+OUTBOX_MAX_ATTEMPTS=5；approvalListScreen.tsx:94-106 outbox「N 待发送」徽标；角标与 outbox 同源（store outboxCount）                                            |
| R2UX-04-06 | 倒计时：120s 进度条、最后 15s 变红+「即将过期」            | ✅ 已落地  | ApprovalCard.tsx:115-116 COUNTDOWN_WARNING_MS=15000 + 变红（urgent）+「即将过期」文案；useCountdownTick 本地 interval 不进 store（M5 §3.3）                                                       |
| R2UX-04-07 | 按钮布局：允许右/拒绝左、间距≥48dp、高 44/48               | ✅ 已落地  | ApprovalActionBar.tsx:113-115 gap:48；拒绝左（secondary）允许右（primary）；minTouch 44（Button 组件）                                                                                            |
| R2UX-04-08 | 批量模式：默认勾选 L1 且>30s、确认层、汇总 toast           | **未落地** | 无批量选择 UI（全仓无 multi-select 审批组件）                                                                                                                                                     |
| R2UX-04-09 | 角标：待批数 99+ 上限、查询失败「未知」诚实化              | 部分       | 审批 Tab 角标=待办数（(tabs)/_layout.tsx:25-26）；通知角标 99+ 收敛（notificationMeta.ts:36-41）；「查询失败显示未知」无实现（数据源为同步 store 无失败态）                                       |
| R2UX-04-10 | 无障碍：审批卡 label「类型+摘要」、读屏等价路径            | 部分       | accessibilityLabel 广泛（ApprovalActionBar.tsx:54-55/72/82、审批卡行）；**读屏走查未做**（无真机）                                                                                                |
| R2UX-05-01 | 事件流 100 条/秒不掉帧：FlashList+memo+批合并              | 部分       | FlatList（非 FlashList）+ 行 memo（EventFeed.tsx:14/189）+ useShallow；批合并 48ms 窗口 ✗（feedBridge 逐帧入 store）；无帧率断言                                                                  |
| R2UX-05-02 | 流式文本：48ms 合并/L1 纯文本/静态光标/200ms 批渲染        | **未落地** | 无流式文本渲染管线（会话详情为事件列表；消息流页不在 R2 范围）                                                                                                                                    |
| R2UX-05-03 | 自动滚底：40dp 上翻暂停 +「回到底部」悬浮条                | ✅ 已落地  | sessionDetailScreen.tsx:67-142：follow 参数化 + 上翻暂停 + 悬浮条 scrollToEnd（2fa04fed）                                                                                                         |
| R2UX-05-04 | 骨架屏三模板：呼吸 1.5s、缓存命中不出现                    | **未落地** | 无骨架组件（PlaceholderScreen 为占位页非骨架）；无 SkeletonPage 模板                                                                                                                              |
| R2UX-05-05 | 四态闭环（加载/骨架/错误/空+离线）每屏可达                 | 部分       | 审批列表四态 ✓（approvalListScreen loading/error/empty/data）；文件浏览四态 ✓（useFilesVm status）；**首页/run 详情占位无四态**；离线态 ConnectionBanner ✗（全仓无，仅会话详情局部 network 标签） |
| R2UX-05-06 | 智能聚合：人话摘要/过滤条/通知合并                         | 部分       | feed 过滤条 ✓（EventFeed FilterChip 三维过滤：错误/工具/当前 run）；toolHumanLabel 人话摘要移植 ✗；通知 5 分钟合并 ✗（通知中心在途，无合并逻辑）                                                  |
| R2UX-05-07 | 终端只读：5000 环形 + ANSI 白名单 + 固定行高               | ✅ 已落地  | ansi.ts 白名单（SGR/光标/清屏分类+剥离计数）；terminalLineBuffer 5000 环形 + 固定行高 24（terminalScreen）；终端页+测试（2fa04fed）                                                               |
| R2UX-05-08 | run 详情/时间线：游标分页 200/页 + 状态条                  | **未落地** | app/run/[runId].tsx 为占位                                                                                                                                                                        |
| R2UX-05-09 | 内存预算：feed 500 环形/窗口卸载/Hermes ≤60MB              | 部分       | feed 500 ✓（FEED_RING_MAX）；unloadWindow ✓；**Hermes 堆快照未测**（无联调轮）                                                                                                                    |
| R2UX-05-10 | 首页首帧：骨架三块+缓存优先+网关聚合≤500ms                 | **未落地** | 首页占位（无骨架/聚合实现）；useDashboardVm 已就绪未接线                                                                                                                                          |
| R2UX-06-01 | 目录万项 60fps：FlashList+固定行高+LRU 128                 | 部分       | FlatList（非 FlashList）+ 固定行高 44/48/56 ✓ + LRU 128 ✓（filesCache.ts:23）；**万项实测无**                                                                                                     |
| R2UX-06-02 | 文件预览按需加载：进入详情才请求、1MB 上限、失败占位       | ✅ 已落地  | FilePreview 进入详情才请求（useFilePreviewVm）；1MB 超限占位（FilePreview.tsx:117/210）+ 敏感文件不缓存（filesCache.ts:11）；file_too_large/binary_file 占位（useFilePreviewVm.ts:7）             |
| R2UX-06-03 | 缩略图 ≤128px 视口懒加载 + 缓存 24h/128MB                  | 部分       | 预览缓存预算 64MB LRU ✓（filesCache.ts:28-32）+ TTL 30s 目录缓存；**≤128px 缩略图规格/视口懒加载未实现**（列表无缩略图）                                                                          |
| R2UX-06-04 | 动态字体不破版：1.0-2.0× 真机走查                          | **未落地** | allowFontScaling 默认（未显式关）；**真机最大字号走查未做**（无真机轮）                                                                                                                           |
| R2UX-06-05 | 深色模式三选 + token 完整性/对比度单测                     | ✅ 已落地  | SettingsThemeSelector 三选（跟随/浅/深）+ themeProjection 投影；设置页即时生效                                                                                                                    |
| R2UX-06-06 | 移除本机双保险：Dialog（标题+后果+danger 主按钮+取消）     | ✅ 已落地  | SettingsRemoveLocalZone.tsx：标题/后果说明/danger 主按钮；取消在前（焦点不落危险按钮，注释明言）；removing busy 防双点；46-47 测                                                                  |
| R2UX-06-07 | 四态：目录空态/二进制占位/错误横幅可重试                   | ✅ 已落地  | 文件浏览四态（useFilesVm status + 错误码映射 errorCodeOf）；空态/占位/错误横幅+重试入口（FileBrowser）                                                                                            |
| R2UX-06-08 | 无障碍：Switch label、行 44 热区、对比度                   | 部分       | SettingsSwitchRow 带 label（组件内 accessibility）；触控 44 基线 ✓；**TalkBack/VoiceOver 走查未做**；对比度单测未做（token 级）                                                                   |

**R2UX 汇总（按 §4.2 表逐条统计）：已落地 10 条 / 部分 11 条 / 未落地 7 条 = 28 条**

---

## 5. 维度五：结构干净

### 5.1 核对表

| 项                       | 判定         | 证据                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模块边界（五层单向依赖） | ✅           | 8 store 全为 vanilla createStore + immer + reducers/mappers 三件套（M5 §3.1 纪律）；authStore.ts:60 类型-only 导入（状态层不 import 存储实现）；db 层不 import 网络层（schema.ts:2）；useShallow 绑定统一收敛在 useAppStore/useFilesStore/settingsLocalStore/themeProjection                                                        |
| 多个 store 模式一致性    | ✅           | auth/connection/approval/event/session/terminal/settings/notification 8 个 store 同构（createStore + immer + 纯 reducer 直测 + 一行转发）；持久化注入模式一致（configureXxxPersistence）                                                                                                                                            |
| dead code                | ⚠️ 少量      | **useDashboardVm（已实现 11 测 100% 覆盖）未接线**（首页占位）——唯一明显悬空资产；mobileCommands.ts 不存在属正确反过度设计（测试文件 mobileCommands.test.ts 为跨域对拍，非死代码）；R2-02 的 setupRoutes 空骨架 handler（ReconnectingWsClient.ts:537-545 events.subscribe.ok 等空回调）——已由 feedBridge 实际消费，注释滞后（见下） |
| 注释与实现一致性         | ⚠️ 滞后 3 处 | ① observationWiring.ts:21「会话令牌（当前无持久化 token，接线占位）」——**已过时**（配对已注入 token）；② ReconnectingWsClient.ts:61-62 token「当前为接线占位」——过时；③ EventFeed.tsx:2 / FileBrowser.tsx:2 FlashList 注释与 R2UX 条款期望的偏差未在文档层登记（建议补裁决/豁免登记）                                               |
| 「严禁打补丁」违例       | ✅ 未发现    | 无坐标魔术补偿/无遍历猜测/无 setTimeout 硬延时 hack；PairingGateway onSendReady（pairingWiring.ts:283-300）以一等信号解决 attachSend 时序，属 O(1) 原生方案；A4 返回放弃确认经 BackHandler 显式事件                                                                                                                                 |
| 行数门禁/圈复杂度        | ✅           | 无 HARD 超限登记（line-counts 基线）；pairingWiring 871 行/approvalWiring 526 行属接线层合理规模（分支覆盖 72-85%）                                                                                                                                                                                                                 |
| 测试资产纪律             | ✅           | 测试全部入库（jest 97+ 套件已提交）；R2-15 报告 §7 记录并行域边界不触碰                                                                                                                                                                                                                                                             |

### 5.2 结构面问题清单（并入 §7）

C-1【低】useDashboardVm 悬空：要么首页接线（R2 收尾轮），要么登记「R3 待接线」避免维护漂移。
C-2【低】注释滞后 3 处（observationWiring token / ReconnectingWsClient token / FlashList 偏差未登记）：建议收口轮一次性修订，避免后续误导。
C-3【低】EventFeed/FileBrowser 的 FlatList 决策应在 docs（R2-ux-best-practice 或 D8）登记豁免/替代决策，防止 R2UX 条款与实现的「已裁决但未登记」状态。

---

## 6. 维度六：契约一致

### 6.1 核对表

| 项                                               | 判定                           | 证据                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 命令构造 vs device-protocol.json（对拍覆盖清单） | ✅ 全覆盖                      | 注册表直读为单一真源（各命令测试运行时 JSON.parse device-protocol.json）；B1 10 条 82 测（2fa04fed）/ B2 5 条 56 测 / B4 4 条 46 测 / B5 5 条 51 测 / B6 5 条 50 测（b4e04ebd）/ mobile_* 8 条（mobileCommands.test.ts：kind==注册表、tauriCommand 真值、params 键集==注册表字段集、必填透传、resultType 对拍 + 缺省拒绝） |
| 双端 kind 一致性（移动端 ↔ 桌面分发）            | ✅                             | 生成解析器 parseDeviceMessage（WsGateway.ts:200）为唯一校验面，不手写第二套；kind 白名单来自生成 kinds（WsGateway.ts:26）；签名 canon 对拍锚点（signer.ts:228-229 与 Rust envelope.rs 同字节）                                                                                                                             |
| R2-12c 承载面核实                                | ⚠️ 已核实 = **桌面接线轮待办** | mobileCommands.test.ts §3：8 条 mobile_* **桌面 command_manifest.rs 全部未登记**（590 行断言 `not.toContain` 锁定）；对照锚点 core_search_files/multi_device_pair_status 已登记证明是缺口而非机制缺失；「登记先行」机制在位（workbench_open_workspace 未接线先例）→ 桌面面实现+登记为 R2-12c 后续轮范围                    |
| 生成包引用纪律（无手抄字段）                     | ✅                             | 全部命令构造/解析经 @crish/shared-types 生成面（types/parser/kinds）；领域附加字段用「契约类型 & 本地附加」组合（pairProtocol.ts:15-17 注释纪律）；对拍测试断言「键集==注册表字段名集」防手抄漂移                                                                                                                          |
| 桌面差异处置（D-01~D-12/D-15/16）                | ✅                             | 全部以注册表为权威判定 + 归档（R2-07 文档 §3 + da196c13 + mobileCommands/deviceCommands 测试内登记）；语义降级（D-04 backward、D-05 includeLastMessage）已记录不依赖                                                                                                                                                       |

### 6.2 契约面问题清单（并入 §7）

K-1【中】R2-12c 桌面承载缺口：8 条 mobile_* 桌面实现+登记未做（审批对账 mobile_list_pending_approvals 等依赖桌面面）——真机联调 E2E-3/E2E-6 会暴露。建议并入真机联调前置轮（桌面接线子任务）。
K-2【低】F2 深链 scheme 文档口径（conex://）与 app.json scheme="crish" 不一致（见 S-5），契约文档需对齐。

---

## 7. 问题清单（按严重度排序，Top 12）

| #   | 严重度 | 问题                                                                                                                                     | 位置                                                                                                      | 修复建议                                                                                                       |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | 高     | 证书固定未实现（R2-03b 缺口）：指纹槽位零消费，RN WebSocket 无信任注入面；真机 wss 生产形态不可达                                        | secureStore.ts（槽位）/ ReconnectingWsClient.ts:284-287（工厂）/ pairingWiring.ts:725-794（收口不写指纹） | 模拟器轮 adb root 装 CA（保真备选）；产品面补指纹注入 + WS 握手固定（原生模块），随 R3 安全补强                |
| 2   | 高     | 8h 会话密钥/令牌刷新未实现：会话密钥静态持久化无 8h 收敛；refreshKey 无消费方；markTokenExpired 无触发点                                 | 全移动端无 auth.refresh/auth.hello 流程（signer 直用 tokenKey）                                           | R3 前补 auth.refresh 重连流 + D5 §3.5 会话密钥派生；真机验证吊销即时性                                         |
| 3   | 高     | R2-16 验收执行未发生（执行文档不存在）；真实驱动未接线（expo-secure-store/expo-sqlite 未安装，InMemory 回退）→ 冷启动恢复/清凭据不可验收 | node_modules 缺失；pairingBootstrap.ts:54-60 InMemory 回退                                                | 真机联调轮前置：npm install + configurePairingDriver(expoSecureStoreDriver()) 接线 + db 驱动接线后执行 E2E-1~6 |
| 4   | 高     | 通知中心在途红测：深链 scheme 校验缺失（ftp:// 通过白名单）                                                                              | notificationMeta.ts:99-101 + notificationMeta.test.ts:135                                                 | 白名单 scheme（crish://、conex://、无 scheme 相对路径）；修复后同 PR 提交（并行 Agent 收口）                   |
| 5   | 中     | 首页仪表盘占位（R2-05 出口项）                                                                                                           | app/(tabs)/index.tsx + useDashboardVm 悬空                                                                | R2 收尾轮接线 useDashboardVm（已有 11 测 100% 覆盖，纯接线成本）                                               |
| 6   | 中     | L2 滑动确认未实现（R2UX-04-02，F2 §15-4 安全条款「L2 必须滑动确认」）                                                                    | 无 SlideToConfirm 组件；ApprovalActionBar.tsx:4                                                           | R3 审批补强：reanimated 滑轨（手势互斥 12dp 阈值）+ reduce-motion 两段式；真机连点 20 次验证                   |
| 7   | 中     | 性能预算断言机制未落地（100 条/秒、首拉 500ms、审批 P95 无 CI 断言）                                                                     | M5 §9.4 空转                                                                                              | 真机轮补最小埋点（Performance.mark + 决策送达时间戳对）+ CI 冒烟预算断言                                       |
| 8   | 中     | 桌面 mobile_* 8 条未登记/未实现（R2-12c 承载面）                                                                                         | command_manifest.rs 无 mobile_* 条目（mobileCommands.test.ts:535 断言）                                   | 桌面接线子任务：8 条登记 + 实现（先登记先行，再接线）                                                          |
| 9   | 中     | T-09 敏感数据打码移动端缺位（事件流 sk- 形态原样展示）                                                                                   | 全移动端无 redact                                                                                         | redact 纯函数移植（复用桌面语义），ingestRouter 统一打码                                                       |
| 10  | 中     | 真机性能四项未测（真机冷启动/终端 5000 行滚动/万项目录/堆快照）                                                                          | R2-01 §10-2 遗留 + M5 §9.4 未开展                                                                         | 并入真机联调轮性能清单                                                                                         |
| 11  | 低     | 注释滞后 3 处 + FlashList 决策未登记豁免                                                                                                 | observationWiring.ts:21、ReconnectingWsClient.ts:61、EventFeed.tsx:2                                      | 收口轮修订注释 + 文档登记 FlatList 替代决策                                                                    |
| 12  | 低     | 深链 scheme 文档口径漂移（app.json scheme=crish vs F2 conex://）                                                                         | app.json / F2 §6.2                                                                                        | 主控定夺单一 scheme 名并同步文档                                                                               |

---

## 8. R2 完成度总判定

**约 88%**（代码与测试面约 95%，验收/真机面拖累）。

| 维度                         | 完成度 | 说明                                                                                                                |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| 代码实现面（命令/数据层/UI） | ~95%   | 16 包中 11 包完全交付（R2-02/07~~15），R2-03~~06 主体完成；占位页 4 处（首页/run 详情/诊断/用量/后台任务=5 处路由） |
| 测试面                       | ~100%  | 1561 用例/97 套件已提交基线全绿；覆盖率 94.49% 远超 60/75/70/60；唯一红测为在途并行工作                             |
| 安全面                       | ~70%   | 密钥位/清理链完整；证书固定、8h 会话密钥、T-09 打码三缺口                                                           |
| 验收面                       | ~30%   | R2-16 执行未做（方案+裁决就绪）；真机 dev client、真机令牌生命周期、性能预算均未验证                                |
| 契约面                       | ~95%   | 命令对拍全覆盖；桌面 mobile_* 8 条登记为唯一跨端缺口（已登记清单）                                                  |

**判定口径**：代码交付质量高（测试纪律、注册表真源、反过度设计均达标），但 R2 的**出口判定（R2-16 验收）未达成**——R2 阶段「基本完成（代码面）」+「验收未闭环」；建议以「真机联调收尾轮」作为 R2 正式收口（见 §10）。

---

## 9. R2UX 落地核对表汇总（28 条）

| 判定      | 条款                                                                        | 小计   |
| --------- | --------------------------------------------------------------------------- | ------ |
| ✅ 已落地 | 04-03、04-05、04-06、04-07、05-03、05-07、06-02、06-05、06-06、06-07        | **10** |
| ⚠️ 部分   | 04-01、04-04、04-09、04-10、05-01、05-05、05-06、05-09、06-01、06-03、06-08 | **11** |
| ❌ 未落地 | 04-02、04-08、05-02、05-04、05-08、05-10、06-04                             | **7**  |

> 逐条证据见 §4.2 表。已落地条款集中在「审批数据面/防误触/终端/文件预览/主题/移除本机」；未落地集中在「手势层（L2 滑轨）、批量、流式渲染管线、骨架屏、run 时间线、首页首帧、动态字体真机验证」——均与「R3 推送 + 真机轮」范围重叠，可自然顺延。

---

## 10. 排期建议（R3 推送 + 真机联调收尾）

### 10.1 真机联调收尾轮（R2 正式收口，建议 5-8 人日）

| #   | 任务                                                                                                                                       | 依赖            | 说明                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------ |
| T1  | `npm install` 补装 expo-secure-store/expo-sqlite（workspace 根）→ 接线 `configurePairingDriver(expoSecureStoreDriver())` + db 真实驱动装配 | 无              | e2e-plan R-3；不接线则 E2E-4/E2E-6 无验收意义                      |
| T2  | 通知中心收口：修复深链 scheme 白名单红测（notificationMeta.ts:99-101）→ 同 PR 提交 → 全量 jest 绿                                          | 并行 Agent 在途 | 修复前保持 1 红测，不得提交                                        |
| T3  | 桌面接线子任务：command_manifest.rs 登记 + 实现 mobile_* 8 条（先登记先行后接线）                                                          | T1              | R2-12c 承载面 + E2E-3 对账依赖；对齐 Z0 X-5 登记路径               |
| T4  | 首页仪表盘接线（useDashboardVm 已有 11 测，纯装配）                                                                                        | 无              | R2-05 出口项；可选最小化（状态卡+待批概览）                        |
| T5  | 执行 R2-16 E2E-1~6（harness 明文 ws 豁免已裁决；E2E-3 载体 B 先行）→ 产出 R2-16-acceptance-execution.md                                    | T1-T3           | 六场景按 e2e-plan §4 依赖矩阵顺序；F2 验收 1-7 + D4 M0-M4 逐项勾销 |
| T6  | 真机性能清单：真机 dev client 冷启动、终端 5000 行滚动帧率、万项目录滚动、Hermes 堆快照（≤60MB 周检口径）                                  | T5              | M5 §9.4 预算断言最小化落地（feed 追加/审批送达埋点）               |
| T7  | 收口轮文档修订：注释滞后 3 处 + FlashList 替代决策登记 + 深链 scheme 单一口径裁决                                                          | T2-T6           | 结构维度 C-2/C-3/S-5                                               |

### 10.2 R3 推送（依赖 R2 收尾，建议顺序）

| #     | 任务                                                                 | 前置                           | 说明                                                |
| ----- | -------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------- |
| R3-01 | push-core 决策引擎（13 场景矩阵单测）                                | R0 事件表冻结                  | 无移动端依赖，可**与 T1-T7 并行**启动               |
| R3-02 | WS 直推通道 + PushAwareEmitter                                       | R3-01 + R1 WS 面               | 在线直推应用内通知 ≤1s；与 T2 通知中心数据面衔接    |
| R3-03 | APNs/HMS 发送器                                                      | R3-01                          | 与 R3-02 并行                                       |
| R3-04 | 移动端通知层（权限/Android 四通道/深链白名单/前台 handler）          | R3-02 + **T2（通知中心收口）** | 深链白名单复用 T2 修复后的 scheme 校验；D7 §12 验收 |
| R3-05 | 安全补强（可并入 R3 各批或独立）：证书固定 + 8h 会话密钥 + T-09 打码 | R3-04 后                       | S-1/S-2/S-3 三项；真机 wss 生产形态验收             |
| R3-06 | 审批交互补强：L2 滑动确认 + 批量模式                                 | 移动端审批面稳定               | R2UX-04-02/04-08；F2 §15-4 安全条款                 |
| R3-07 | 桌面常驻/商店 SOP/旧桌面兼容引导                                     | —                              | G-5/G-6/G-8 落地                                    |

### 10.3 风险提示

- **顺序强依赖**：T5（E2E-1 配对）硬依赖 T1（真实驱动接线）——InMemory 回退下配对持久化不可验证；T2 红测不修会持续污染全量 jest 基线。
- **生产安全语义红线**：明文 ws 豁免仅限 harness 联调窗口，窗口结束后须按 e3e22951 归档恢复 wss 复测（E2E-1 加证书方案验证），并落实 S-1 证书固定后方可宣称生产形态安全闭环。
- **R3-04 与 T2 重叠**：通知中心 UI（在途）是 R3-04 的前台 handler 的宿主，建议 T2 收口时把通知数据面（notificationStore/notificationsDao）与 UI 的接线一并稳定，避免 R3 返工。

---

## 附录 A · 审计方法与被读证据

- 文档：Z0-master-plan.md（§3.4/§9.4/§9.9）、R2-01-acceptance-emulator.md、R2-15-coverage-report.md、R2-16-e2e-plan.md、R2-07-command-mapping.md、D4-mobile-tech.md（§9.5/§11.1）、M5-mobile-engineering.md（§6/§9）、R2-ux-best-practice.md（§7.2-7.4）、D5-security.md（§3.5/§9.4）、F2-approval-center.md（§13.2/§15）、F4-files-assets.md
- 代码：apps/crish-mobile/src（network/pairing/domain/db/adapters/presentation）、app/ 全路由、package.json、app.json
- 运行证据：`npm test -w @crish/crish-mobile -- --ci` 实测 = 97 通过 + 1 失败（通知中心在途）/ 1575 总用例；`git status`（并行 Agent 在途面）、`git log --oneline`（R2 提交链 16f2f55f→3686bb8f）
- 未执行：无（只读任务）

_审计完成：六维度（正确性/安全/性能/体验/结构/契约）+ R2UX 28 条 + 完成度约 88% + R3 与真机联调排期建议；未修改任何源文件。_

---

## 11. R2UX 落地核对更新（2026-08-11 后）

> 更新性质：§4.2 R2UX 落地核对表（AU5 时 10/28 已落地）的刷新——只读核对 + 本节追加；**未修改 R2-ux-best-practice.md 方案文档**。
> 核对基线：git log 提交链（0740bbf5 AU5 → d8308a22 round9 → c3fd5dd0 R2-15b → 7d4cedd7 R2-05g → 7a9a74ee R2-04f → a29fadaa R2-13b）+ apps/crish-mobile 代码现状 + 本更新实跑 jest（14 套件 195 例全绿，见 §11.4）。
> **新结论：已落地 12/28、部分 12/28、未落地 4/28**（AU5：10/28、11/28、7/28）。

### 11.1 更新后的 28 条状态表（▲=新落地 / ◆=证据强化 / ◐=判定变化；无标记=与 AU5 一致）

| 条款       | 规范要点                                                   | 判定（更新后）  | 证据（更新）                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2UX-04-01 | 3 秒决策路径：点按≤3、首屏见决策区、预渲染摘要             | 部分            | 决策区固定底部 ✓（approvalDetailScreen.tsx:84-92 底部 bar）+ 首屏即见 ✓；推送预渲染/性能实测 ✗（推送属 R3，真机未测）——不变                                                                                                                                                                                                                                                                                                                                               |
| R2UX-04-02 | L2 双阶段滑动确认（70% 阈值/回弹/reduce-motion 两段式）    | ✅ **已落地 ▲** | **7a9a74ee（R2-04f）**：slideConfirmMachine.ts（SLIDE_TRIGGER_THRESHOLD=0.7、slideEnd 仅 armed 抬起触发、回弹 spring 200ms、shouldClaimSlidePan 12dp×1.2 水平仲裁）+ SlideToConfirm.tsx（PanResponder 薄层、busy 锁定、AccessibilityInfo 探测 reduce-motion 降级两段式、读屏 onAccessibilityTap 等价路径）+ ApprovalActionBar dangerLevel-2 gating（approvalDetailScreen.tsx:90 由 item.dangerLevel 接线）；3 套件 60 例实跑全绿；E2E-3 真机 50%/75% 滑轨验证留真机联调轮 |
| R2UX-04-03 | busy 防双点：300ms 防抖 + decisionBusy 状态位驱动          | ✅ 已落地       | 不变；L2 滑轨 busy 期间手势锁定 + 确认弹窗强制关闭（SlideToConfirm.tsx:204-212）为原判定外的补强                                                                                                                                                                                                                                                                                                                                                                          |
| R2UX-04-04 | 决策后状态反馈：乐观更新/✓徽标/回滚/冲突/过期文案          | 部分            | 四路径状态机 ✓；✓ 徽标 150ms 淡入/500ms 返回动效仍未实现（无动画层）——不变                                                                                                                                                                                                                                                                                                                                                                                                |
| R2UX-04-05 | 离线 outbox 进度：「待发送」徽标 + 计数角标 + 重试人工提示 | ✅ 已落地       | 不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R2UX-04-06 | 倒计时：120s 进度条、最后 15s 变红 +「即将过期」           | ✅ 已落地       | 不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R2UX-04-07 | 按钮布局：允许右/拒绝左、间距≥48dp、高 44/48               | ✅ 已落地       | 不变（L1 行 gap 48 保留；L2 行内滑轨为 barL2 垂直排布，F2 §5.1 线框形态）                                                                                                                                                                                                                                                                                                                                                                                                 |
| R2UX-04-08 | 批量模式：默认勾选 L1 且>30s、确认层、汇总 toast           | ❌ 未落地       | 无多选 UI——不变；排期：R3-06（AU5 §10.2，L2 滑动确认已落地后批量成为该任务剩余项）                                                                                                                                                                                                                                                                                                                                                                                        |
| R2UX-04-09 | 角标：待批数 99+ 上限、查询失败「未知」诚实化              | 部分 ◆          | 通知中心已提交（0740bbf5）：**深链 scheme 白名单红测闭环（S-4）**——notificationMeta.ts:70-74 白名单 {crish,conex} + notificationMeta.test.ts:133-135 ftp:// 断言 null 拒绝（实跑全绿）；通知角标 99+ 收敛（notificationBadgeLabel，notificationMeta.ts:38-43）；审批 Tab 角标=待办原值无 99+ 上限（(tabs)/_layout.tsx:25-26）；「查询失败显示未知」仍无（同步 store 无失败态）                                                                                            |
| R2UX-04-10 | 无障碍：审批卡 label「类型+摘要」、读屏等价路径            | 部分            | L2 滑轨读屏等价路径新增 ✓（SlideToConfirm accessibilityValue 进度播报 + onAccessibilityTap 两段式）；读屏走查仍无（真机）                                                                                                                                                                                                                                                                                                                                                 |
| R2UX-05-01 | 事件流 100 条/秒不掉帧：FlashList+memo+批合并              | 部分 ◆          | **R2-15b（c3fd5dd0）数据面预算断言落地**：feed hydrate 1000 条 ≤500ms / append 1000 条 ≤450ms / dedup 1000 条 ≤350ms（performanceBudgets.test.ts:69-117，9 例实跑绿）；仍缺：FlashList（FlatList 降级）、48ms 批合并（feedBridge.ts:73-84 逐帧入 store）、渲染 JS 帧率断言（留真机）                                                                                                                                                                                      |
| R2UX-05-02 | 流式文本：48ms 合并/L1 纯文本/静态光标/200ms 批渲染        | ❌ 未落地       | 消息流页不在 R2 范围（F3/F5 后续）——不变                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R2UX-05-03 | 自动滚底：40dp 上翻暂停 +「回到底部」悬浮条                | ✅ 已落地       | 不变；run 详情复用同语义（runDetailScreen.tsx:168-183 scrollToEnd + follow 切换）                                                                                                                                                                                                                                                                                                                                                                                         |
| R2UX-05-04 | 骨架屏三模板：呼吸 1.5s、缓存命中不出现                    | ❌ 未落地       | **R2-05h 未完成**：全仓 grep 骨架/skeleton/shimmer 仅注释提及（PlaceholderScreen.tsx:8 等），无任何 SkeletonPage/骨架组件；同时是 R2UX-05-10 首帧骨架的前置                                                                                                                                                                                                                                                                                                               |
| R2UX-05-05 | 四态闭环（加载/骨架/错误/空+离线）每屏可达                 | 部分            | run 详情空态 ✓（runDetailScreen.tsx:157-166）；首页仪表盘主体仍占位；ConnectionBanner 全局实例仍无——不变                                                                                                                                                                                                                                                                                                                                                                  |
| R2UX-05-06 | 智能聚合：人话摘要/过滤条/通知合并                         | 部分            | feed 过滤条 ✓（EventFeed FilterChip 三维）；人话摘要=本地简单映射（EventRow.tsx:105，toolHumanLabel 共享包未迁移）；timer/cron 聚合 ✗；通知 5 分钟合并 ✗（notificationStore 无合并逻辑，仅冷启动回填合并）——不变                                                                                                                                                                                                                                                          |
| R2UX-05-07 | 终端只读：5000 环形 + ANSI 白名单 + 固定行高               | ✅ 已落地 ◆     | 2fa04fed 实现不变；**R2-15b 补终端预算断言**：5000 行写入 ≤50ms / 满环再灌 1000 行 ≤100ms / replaceAll 5000 行 ≤50ms（performanceBudgets.test.ts:119-151，实跑绿）                                                                                                                                                                                                                                                                                                        |
| R2UX-05-08 | run 详情/时间线：游标分页 200/页 + 状态条不参与重渲染      | ✅ **已落地 ▲** | **7d4cedd7（R2-05g）**：runDetailScreen + runDetailMeta（deriveRunBadge 四态徽标、paginateRunEntries 200/页游标分页、runControlActionsOf L2/L3 编排）+ RunDetailTimeline（200/页 +「加载更早」+ 环形淘汰提示「已收起 N 条」）+ RunControlBar（暂停/恢复/取消二次确认）+ RunDetailHeader（memo 隔离，滚动不重渲染）+ 终端入口；5 套件 82 例实跑全绿；滚动帧率断言留真机轮                                                                                                  |
| R2UX-05-09 | 内存预算：feed 500 环形/窗口卸载/Hermes ≤60MB              | 部分            | feed 500 ✓/unloadWindow ✓（≤4 活跃窗口）；Hermes 堆快照仍无——不变                                                                                                                                                                                                                                                                                                                                                                                                         |
| R2UX-05-10 | 首页首帧：骨架三块+缓存优先+网关聚合≤500ms；stale 诚实化   | 部分 ◐          | 快速操作已接线（d8308a22 QuickRunPanel + useQuickRunVm 40 测，index.tsx:48：prompt→runTask + 最近会话 chips + 三态反馈 +「查看详情」跳 run 详情）；lastSyncAt stale 数据面就绪（connectionStore.ts:13-14 setPhase('ready') 打点）；骨架三块/网关聚合/useDashboardVm 接线仍缺（useDashboardVm 仅 viewmodels/index.ts 导出，页面零引用）——首页由纯占位变为「通知入口 + 快速操作 + 占位仪表盘」                                                                              |
| R2UX-06-01 | 目录万项 60fps：FlashList+固定行高+LRU 128                 | 部分 ◆          | **R2-15b 补 LRU128 预算断言**：预填 128 层 + 混合 get/set 20 万次 ≤50ms（performanceBudgets.test.ts:189-204，实跑绿）；FlatList 非 FlashList + 万项实测无——其余不变                                                                                                                                                                                                                                                                                                       |
| R2UX-06-02 | 文件预览按需加载：进入详情才请求、1MB 上限、失败占位       | ✅ 已落地       | 不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R2UX-06-03 | 缩略图 ≤128px 视口懒加载 + 缓存 24h/128MB                  | 部分            | 预览缓存预算 64MB LRU + TTL 30s 目录缓存 ✓；≤128px 缩略图/视口懒加载仍无——不变                                                                                                                                                                                                                                                                                                                                                                                            |
| R2UX-06-04 | 动态字体不破版：1.0-2.0× 真机走查                          | ❌ 未落地       | 真机最大字号走查依赖真机联调轮——不变                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R2UX-06-05 | 深色模式三选 + token 完整性/对比度单测                     | ✅ 已落地       | 不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R2UX-06-06 | 移除本机双保险：Dialog（标题+后果+danger 主按钮+取消）     | ✅ 已落地       | 不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R2UX-06-07 | 四态：目录空态/二进制占位/错误横幅可重试                   | ✅ 已落地       | 不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R2UX-06-08 | 无障碍：Switch label、行 44 热区、对比度                   | 部分            | Switch label ✓/44 热区 ✓；TalkBack/VoiceOver 走查 + 对比度单测仍无——不变                                                                                                                                                                                                                                                                                                                                                                                                  |

**R2UX 汇总（更新后）：已落地 12 条 / 部分 12 条 / 未落地 4 条 = 28 条**（AU5：10/11/7）

### 11.2 新增落地清单（自 AU5 以来，条款 → 提交/证据）

| #   | 条款/项                                                   | 提交（证据）                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **R2UX-04-02 L2 滑动确认**（▲ 新落地）                    | 7a9a74ee（R2-04f）：slideConfirmMachine/SlideToConfirm/ApprovalActionBar dangerLevel-2 gating + approvalDetailScreen 接线；3 套件 60 例实跑全绿；E2E-3 真机留联调轮                                                          |
| 2   | **R2UX-05-08 run 详情/时间线**（▲ 新落地）                | 7d4cedd7（R2-05g）：runDetailScreen + runDetailMeta + RunDetailHeader/RunControlBar/RunDetailTimeline；游标分页 200/页、状态条 memo 隔离、L2/L3 控制二次确认、终端入口；5 套件 82 例实跑全绿                                 |
| 3   | **R2UX-05-01/05-07/06-01 性能预算断言**（R2-15b，◆ 强化） | c3fd5dd0：performanceBudgets.test.ts 9 例（feed 100 条/秒语义 ingest、终端 5000 行环形、49 类事件映射、LRU128；阈值=实测基线 ×3~16 宽松，粗筛数量级回归）——AU5 P-2「预算断言机制未落地」数据面部分闭环，渲染帧率类留真机     |
| 4   | **R2UX-05-10 首页快速操作**（R2-05f，◐ 未落地→部分）      | d8308a22（R2 round9，**AU5 前已提交但核对表未记**）：QuickRunPanel + useQuickRunVm（40 测）接线 index.tsx:48；首页由纯占位变为可用入口面（通知 + 快速操作）；connectionStore lastSyncAt 打点（stale 灰字数据面，R2UX-05-10） |
| 5   | **R2UX-04-09 通知中心收口**（R2-04e，◆ 强化）             | 0740bbf5：通知中心（铃铛入口/未读角标/已读标记）+ **深链 scheme 白名单修复——AU5 S-4 红测闭环**（notificationMeta.test.ts:133-135 ftp:// 断言拒绝，实跑全绿）+ 通知角标 99+ 收敛                                              |
| 6   | R2UX §6.3 审批排序次键（补记）                            | approvalReducers.ts:52-70：主键剩余时间升序（F2 §4.2 契约）+ 次键 2 L2 优先 + 次键 1 同 run 聚合相邻——实现已核对存在（AU5 未单列条款）                                                                                       |

### 11.3 仍未落地项（4 条，含原因与排期建议）

| 条款       | 现状/原因                                                                                    | 排期建议                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| R2UX-04-08 | 批量模式：无多选 UI；F2 §5.4 安全约束（默认勾选 L1 且>30s、L2/临期跳过、确认层）需确认层设计 | R3-06（AU5 §10.2；L2 滑动确认已落地，批量成为该任务剩余项）                                                                       |
| R2UX-05-02 | 流式文本渲染管线：消息流页（F3/F5）不在 R2 范围                                              | 随消息流页实现轮（48ms 合并/L1 纯文本/静态光标/200ms 批渲染）                                                                     |
| R2UX-05-04 | 骨架屏三模板：**R2-05h 未完成**（全仓无 Skeleton 组件，仅注释提及）                          | 与 R2UX-05-10 首页接线同轮：SkeletonPage.{list,dashboard,detail} 三模板 + useDashboardVm 装配（已有 11 测 100% 覆盖，纯接线成本） |
| R2UX-06-04 | 动态字体真机走查：依赖真机（最大字号逐屏截图对照）                                           | 真机联调轮（AU5 §10.1 T6 走查清单）                                                                                               |

**真机验证类整体归属不变**：E2E-3（L2 滑轨 50%/75% 真机）、滚动帧率断言、读屏走查（VoiceOver/TalkBack）、每屏五态截图、万项目录/终端 5000 行真机帧率——均依赖 R2-16 真机联调轮（AU5 §10.1）；本更新的「已落地」判定以代码 + 组件/纯函数测试为据（与 AU5 判定口径一致）。

### 11.4 本更新实跑测试证据（2026-08-13，apps/crish-mobile）

- slideConfirmMachine / SlideToConfirm / ApprovalActionBar：**3 套件 / 60 例 PASS**（R2UX-04-02/04-03/04-07/04-10 面）
- runDetail 5 套件（runDetailScreen/RunDetailHeader/RunControlBar/RunDetailTimeline/runDetailMeta）+ QuickRunPanel + performanceBudgets + notificationMeta：**8 套件 / 97 例 PASS**（R2UX-05-08/05-10/05-01/05-07/06-01/04-09 面）
- useQuickRunVm / useRunControlVm / useDashboardVm：**3 套件 / 38 例 PASS**
- 合计 **14 套件 / 195 例全绿**（仅覆盖本更新涉及套件；全量以 CI 为准，并行 Agent 在途改动未纳入）

_更新完成：R2UX 28 条刷新为 12/28 已落地、12/28 部分、4/28 未落地；新增落地 2 条（04-02/05-08）+ 强化 3 面（05-01/05-07/06-01 预算断言）+ 首页快速操作接线（05-10）+ 通知中心 S-4 闭环（04-09）；R2-05h 骨架屏核对为未完成；未修改任何代码与方案文档。_
