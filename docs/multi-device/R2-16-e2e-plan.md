# R2-16 真机联调执行方案（模拟器 + 桌面服务）与前置检查

> 文档编号：R2-16-e2e-plan
> 角色：R2-16 验收准备（方案 + 只读检查；产出执行计划文档）
> 日期：2026-08-13
> 定位：R2 移动端真机联调（**Android 模拟器替代真机**：`10.0.2.2` 访问宿主）执行方案
> 与前置检查结果表。场景口径来自 Z0 §12.9（L4 清单 5/6/7 联合验收交叉点）+
> R1-11 §7（真机联调前置条件 12 项：扫码配对/审批闭环/断线续传/撤销即时性/
> AP 隔离手动 IP）。服务面已 PASS（R1-11 执行记录：L4 1-9 + 红线 1-7）。
> 编码：UTF-8 无 BOM，中文。
> 纪律：本任务只读 + 文档产出；未修改任何源文件/测试文件（`git status` 复核）。

---

## 1. 任务范围与结论速览

| 项           | 结论                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前置检查     | 14 项已执行（真实命令），9 项就绪 / 5 项注记（详见 §2）                                                                                                                                 |
| 联调场景     | E2E-1~6 全清单可执行（依赖标注见 §4 每场景「依赖」）                                                                                                                                    |
| **关键阻塞** | **① 配对 UI 未接线**（manual.tsx 仅本地校验，不发起网络）；② **wss 自签证书在 RN WebSocket 无信任选项**（联调豁免需主控裁决）；③ expo-secure-store/expo-sqlite 未安装（真实驱动未启用） |
| 主控裁决项   | R2-16-裁决-1：联调明文 ws 豁免（harness `tls_enabled=false`，生产保持 wss）；R2-16-裁决-2：E2E-3 审批闭环的执行载体（见 §4-3）                                                          |

**一句话**：联调环境就绪度 = 桌面服务可编译（cargo check 绿）+ 模拟器可启动（已 boot）+
移动端 jest 1277/1278 绿；但**配对主链路 UI 未接线**（pairingWiring 871 行已实现待装配），
E2E-1/2/3/4/5/6 全部场景均以「配对成功」为前置——**先完成配对 UI 接线（R2 收尾轮）再执行**。

---

## 2. 前置检查结果表（2026-08-13 真实执行）

> 执行环境：Windows 本机（C:\Software\conex 工作区），PowerShell 7；adb 不在 PATH，
> 用完整路径 `C:\Users\orange\AppData\Local\Android\Sdk\platform-tools\adb.exe`。

| #   | 检查项                    | 就绪             | 证据（真实命令/输出摘录）                                                                                                                                                                                      | 阻塞/注记                                                                                                                                                                         |
| --- | ------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | adb 可用                  | ✅               | `adb.exe devices -l` → `emulator-5554 device product:sdk_gphone64_x86_64`                                                                                                                                      | adb 不在 PATH，联调脚本须用完整路径                                                                                                                                               |
| 2   | 模拟器 AVD 存在           | ✅               | `emulator.exe -list-avds` → `crish-pixel`；`~/.android/avd/crish-pixel.avd` + `.ini` 存在                                                                                                                      | —                                                                                                                                                                                 |
| 3   | 模拟器运行状态            | ✅（本任务启动） | 检查时**未运行**（adb devices 空）→ 本任务启动 `emulator.exe -avd crish-pixel -no-snapshot-save` → `getprop sys.boot_completed` = `1`，`emulator-5554 device`                                                  | 执行联调前须确认已在运行（§5 准备步骤含启动命令）                                                                                                                                 |
| 4   | 桌面服务可编译            | ✅               | `cargo check -p crish-agent-workbench --bin crish-agent-workbench` → `Finished dev profile ... in 1.29s`（24 warnings 为既有，无 error）                                                                       | 并行阵营在途改动（git status 含 Cargo.toml/crates 修改）未阻塞编译；`crish-agent-workbench.exe` 最近构建 2026-08-13 10:59                                                         |
| 5   | R1-11 手测 harness 先例   | ✅               | `Temp\opencode\r1-11-harness\`（src/main.rs + Cargo.toml path 依赖 crish-agent-workbench/conex-types；`r1-11-harness.exe` 2026-08-13 01:30）                                                                   | 联调 harness 模板复用（§5 步骤 1）                                                                                                                                                |
| 6   | crish-mobile 单测         | ⚠️ 1277/1278     | `npx jest --ci` → `Test Suites: 1 failed, 62 passed / Tests: 1 failed, 1277 passed`                                                                                                                            | 唯一失败 `mobileCommands.test.ts:362`：期望 `mobile_get_workspace_state` vs 对照锚点 `workbench_list_workspaces`（R2-12 部分 2 已知命名差异，并行阵营在途，非本任务域；回归记录） |
| 7   | crish-mobile node_modules | ⚠️ 部分缺失      | 根 node_modules 有 expo/react-native/zustand/expo-router（hoisted）；`npm ls expo-secure-store expo-sqlite` → **两包未安装**                                                                                   | secureStore.ts/db.ts 为注入模式（jest 用 InMemory，测试不受影响）；**真实环境驱动接线点未启用**（注释「依赖安装后启用」）→ 配对持久化/本地库需先 `npm install` 补装               |
| 8   | 配对 UI 接线              | ❌ **未完成**    | `app/pair/manual.tsx:14-29` onSubmit 仅 `buildPairHello` 本地校验，注释明言「网络发送属接线层未覆盖项，暂不发起请求」；`app/` 全目录 grep 无 `ensurePairingWiring/startPairingWiring` 调用                     | pairingWiring（871 行 + 19 测试）已实现**但未装配到 app 入口**（`_layout.tsx:17-19` 只调 `authStore.hydrate()` 无参骨架）→ **E2E-1 前置阻塞**                                     |
| 9   | 审批 UI 接线              | ✅ 已实现        | `app/(tabs)/approvals.tsx` → `ApprovalListScreen`（approvalListScreen.tsx + 测试）；`useApprovalListVm.ts:65` 条件 `ensureApprovalWiring()`；approvalWiring（526 行 + 测试）含 outbox 两阶段确认/对账/退避重试 | 依赖会话连接（`getObservationWiring()?.client.gateway`，approvalWiring.ts:479）→ 依赖配对成功                                                                                     |
| 10  | 事件流观察面              | ⚠️ 部分          | 会话页已接线：`app/(tabs)/sessions.tsx` → `SessionsScreen`（R2 round7 完整形态）；**首页仪表盘仍为占位**（`app/(tabs)/index.tsx` → PlaceholderScreen「R2-05 落地」）                                           | E2E-2 事件流实时观察点建议用会话页/审批页或接首页仪表盘后执行                                                                                                                     |
| 11  | 文件页                    | ✅ 已实现        | `app/(tabs)/files.tsx` → `useFilesVm`（工作区切换/目录树/预览完整接线）                                                                                                                                        | —                                                                                                                                                                                 |
| 12  | 设置页（移除本机入口）    | ❌ 占位          | `app/(tabs)/settings.tsx` → PlaceholderScreen「R2-06 落地」                                                                                                                                                    | **E2E-6「移除本机」UI 入口未接线**（unpair 逻辑已实现，无 UI 调用）→ 待设置页落地                                                                                                 |
| 13  | TLS 语义                  | ✅ 双面确认      | 生产装配强制 wss-only：`main.rs:1057` `config.tls_enabled = true`（D5 D-02a）；`ServerConfig` 结构默认 `tls_enabled=false`（config.rs:91）                                                                     | **harness 可明文 ws**（不触碰生产装配）——联调豁免路径成立（§3 风险）                                                                                                              |
| 14  | RN WebSocket 证书信任     | ❌ 无选项        | `ReconnectingWsClient.ts:284-286` 默认工厂 `new WebSocket(url)`；文件头注释「RN WebSocket 不支持自定义 header」；无 trust manager 注入面                                                                       | **wss 自签证书在 RN 端大概率握手失败**（关键风险 §3）                                                                                                                             |

**结论**：桌面侧全部就绪（编译绿 + harness 先例在）；移动侧「引擎全绿但 UI 装配未完成」——
配对 UI、设置页占位；expo-secure-store/expo-sqlite 未装。联调执行前须补齐三项（§4 依赖标注
逐场景给出「待 X 完成后执行」）。

---

## 3. 关键风险与裁决建议

### 3.1 风险 R-1（关键）：wss 自签证书 vs RN WebSocket 信任

**事实链**（实读代码/文档）：

- 生产装配：服务开启即 wss-only（`main.rs:1057` 强制 `tls_enabled=true`），自签证书（tls.rs
  生成，`config_dir()/multi-device/`）；R1-11 服务面手测客户端均以 `-k` / `rejectUnauthorized:false`
  忽略校验——**这些客户端全部有忽略开关**；
- 移动端：`ReconnectingWsClient.ts` 默认工厂 = RN 全局 `WebSocket`（:286）；RN 的 WebSocket
  走系统网络栈，**不暴露证书信任配置**（无自定义 trustManager/ignoreTLS 选项）；
- Android 模拟器：google_apis 镜像（非 playstore），系统信任库**不含**桌面自签 CA；
- 结论：**模拟器上 `wss://10.0.2.2:8765` 连接自签证书服务，RN WebSocket 握手将失败**
  （`javax.net.ssl.SSLHandshakeException: CertPathValidatorException` 类错误），
  配对/会话连接均不可达。**该风险在真机上同样存在**（真机信任库同样不含自签 CA），
  只是模拟器可经 `adb root` 做系统证书注入（b 方案可行性更高）。

**候选方案**（按复杂度与保真度排序）：

| 方案                      | 做法                                                                                                                                                                           | 保真度                        | 成本                                            | 结论                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| a) 联调豁免：明文 ws      | 桌面侧用 harness `ServerConfig{tls_enabled=false}`（R1-11 先例，**不改产品代码**）+ 移动端 `EXPO_PUBLIC_ENGINE_URL=ws://10.0.2.2:8765`（observationWiring.ts:71 env 优先级 1） | 低（跳过 TLS 层）             | 低（零代码改动）                                | **推荐**：本机联调窗口内使用，生产装配不受影响（`restart_server` 强制 wss 的代码不动）；仅联调脚本/harness 明文 |
| b) 装 CA 到模拟器系统证书 | `adb root`（google_apis 可 root）+ 推送自签 CA 到 `/system/etc/security/cacerts/`（或 `adb shell setprop debug.network.ssl...` 类技巧）                                        | 高（完整 wss + 指纹语义保留） | 中高（system 分区读写、证书格式转换、需重挂载） | 备选：联调验收要求「wss 真机验证」时启用；R2-16 轮若时间允许可做                                                |
| c) 移动端忽略证书         | 需要原生模块/补丁（RN 无内置选项）                                                                                                                                             | —                             | 超范围                                          | **否决**（超本任务范围，且违背安全基线）                                                                        |

**裁决建议（提交主控）**：

- **R2-16-裁决-1**：本联调窗口（模拟器 + 本机局域网）桌面服务以 harness `tls_enabled=false`
  明文 ws 运行，移动端经 `EXPO_PUBLIC_ENGINE_URL` 指向 `ws://10.0.2.2:8765`；生产装配
  wss-only 语义不变（零产品代码改动）。**联调窗口结束后恢复 wss 复测**（或补 b 方案）。
- 若主控要求联调即 wss：执行 b 方案（模拟器系统证书注入），并在场景 E2E-1 加
  「证书安装」前置步骤。

### 3.2 风险 R-2：配对 UI 未接线（E2E-1 硬前置）

pairingWiring 全链已实现且测试绿（pair→keys→persist→connect→hydrate，19 测试），但
`app/pair/manual.tsx` 的「连接」按钮只做本地校验。**联调前需完成接线**（R2 收尾轮任务）：
manual.tsx onSubmit → `ensurePairingWiring({driver: expoSecureStoreDriver()}).beginPairing({host, code})`

- `_layout.tsx` 装配点（`ensurePairingWiring` 幂等单例，配对成功自动走
  `defaultConnectSession` → `ensureObservationWiring` 会话连接）。接线未完成前，
  **E2E-1 起所有场景不可执行**（本方案已逐场景标注「待配对 UI 接线完成后执行」）。

### 3.3 风险 R-3：expo-secure-store / expo-sqlite 未安装

注入模式让 jest 全绿（InMemorySecureStore/MemorySqlDriver），但真机配对持久化与
数据层需要真实驱动。联调前置：`npm install`（workspace 根执行）补装
`expo-secure-store@~57.0.1`、`expo-sqlite@~57.0.1`；配对凭据持久化才可验证
（E2E-4 断线重连、冷启动恢复依赖）。

### 3.4 风险 R-4：模拟器替代真机的语义边界

- `10.0.2.2` = 模拟器对宿主的回环别名（虚拟 NAT）——**不是真实局域网路径**；
- AP 隔离场景在模拟器不可真实模拟（无路由器）；本方案以「手动输入 IP（10.0.2.2）」
  覆盖「AP 隔离手动输 IP 路径」的**等价交互**（跳过发现、直接输入），真机项留
  R2-16 后续真机轮（Z0 §12.7-2 Windows 真实局域网验收口径保留）；
- 配对码在模拟器上手动输入（扫码属 P2，D4 §12.4-3 隐藏入口，scan.tsx 占位）。

### 3.5 风险 R-5：审批闭环的引擎依赖（E2E-3 载体裁决）

R1-11 服务面 L4-5 的 approve/deny 端点 PASS 为 **mock 后端**（harness 无引擎 run）；
「run 触发 dangerous 工具 → 挂起 → 审批 → approval-resolved」需真实引擎。载体二选一：

- 载体 A：`npm run dev:workbench` 完整应用（真实引擎 run）+ 模拟器 wss 连接
  （需 b 方案证书或等 wss 豁免裁决落地后仍有 TLS 冲突）；
- 载体 B：明文 harness + 注入 approval-requested 事件（fanout 注入先例：R1-11 L4-4
  harness manual publish）+ 移动端批准 → REST/WS 决策 → 断言 approval-resolved 广播。
  **推荐**：R2-16 轮用载体 B 打通移动端决策链；真实引擎闭环并入「配对 UI 接线完成 +
  完整应用」的下一轮验收（E2E-3 标注「载体 B 先行，载体 A 待接线轮」）。

---

## 4. 联调场景清单（E2E-1 ~ E2E-6）

> 通用前置：桌面 harness 明文 ws 监听 `0.0.0.0:8765`（配对模式重绑，main.rs:783-810
> rebind 钩子先例；harness 装配对齐 server_integration.rs `spawn_server`）+ 模拟器
> `emulator-5554` 已 boot + Expo Go 已装（R2-01 先例自动安装）+ 移动端
> `EXPO_PUBLIC_ENGINE_URL=ws://10.0.2.2:8765`（豁免生效后）。
> 日志位置：桌面 = harness 控制台 + `%APPDATA%\Crish\AgentWorkbench\logs\`（服务面装配）；
> 移动端 = `adb logcat -s ReactNativeJS:*`（**jest 无运行时日志**——联调排查以 logcat
>
> - 桌面 tracing 为准，移动端运行期 console 经 Metro 转发）。

### E2E-1 配对：手动输入（10.0.2.2 + CXN 码）→ 配对成功 → 进入应用

| 项       | 内容                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 依赖     | **待配对 UI 接线完成**（manual.tsx → beginPairing，R-2）；expo-secure-store 已装（R-3）；wss 豁免裁决落地（R-1）                                                                                                                                                                                                                                                                           |
| 前置条件 | ① 桌面 harness 运行且配对模式开启（CXN 码有效期内 10 分钟）；② 模拟器 boot + Expo Go；③ 移动端冷启动未配对态（欢迎页）                                                                                                                                                                                                                                                                     |
| 操作步骤 | 1. 桌面：harness 开启配对 → 获取 CXN 码（控制台打印/配对文件）；`curl -k https://127.0.0.1:8765/v1/info`（明文豁免时 `http://`）确认 `pairingActive=true`；2. 模拟器：`npx expo start`（Metro :8081）→ Expo Go 打开 `exp://10.0.2.2:8081`；3. 移动端欢迎页 → 「手动输入配对信息」→ 输入 `10.0.2.2` + CXN 码 → 「连接」；4. 断言配对成功进入 tab 页（守卫 `(tabs)/_layout.tsx:13-15` 放行） |
| 期望断言 | 桌面 pairing.json 写入 SHA-256 令牌（`auth.rs:438` 只存哈希）；移动端 `pairState='paired'` + secure-store 4 密钥位齐备；`adb logcat -s ReactNativeJS:*` 出现 hello→ok 收口无 error；桌面 WS 注册表出现该 deviceId（`device.ready` 已收）                                                                                                                                                   |
| 失败排查 | ① 握手失败/无响应 → 检查豁免是否生效（ws 而非 wss，logcat SSLHandshake 即未豁免）；② 配对码错误 → 桌面 pairing.json 失败计数 + logcat `pair.invalid_code`；③ UI 无网络动作 → R-2 接线未完成（按钮仅校验）；④ CXN 超时 → 重新开启配对（10 分钟 TTL，D3 §4.1）                                                                                                                               |

### E2E-2 事件流：桌面发起 run → 移动端实时收到

| 项       | 内容                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖     | E2E-1 配对成功（会话连接 `ensureObservationWiring` 已建立）；观察面 UI 建议会话页/审批页（首页仪表盘占位，R-2 注记）                                                                                                              |
| 前置条件 | 移动端会话连接相位 `ready/live`（connectionStore 投影）；桌面可发起 run（harness 注入 fanout 或引擎）                                                                                                                             |
| 操作步骤 | 1. 记录移动端当前会话/事件窗口基线；2. 桌面发起 run（harness `fanout.publish` 注入 agent-start 等事件，对齐 R1-11 L4-4 先例：注入 seq N→N+1）；3. 断言移动端收到 `events.push`                                                    |
| 期望断言 | 会话页/日志出现新 run 事件；`adb logcat` 无 parse 错误（`parseEngineEvent` 容错）；序列号衔接（push 逐条、无跳号）                                                                                                                |
| 失败排查 | ① 无事件 → 检查订阅（`events.subscribe` 是否发出，logcat/桌面 WS 日志）；② 解析失败 → 共享类型解析器版本对齐（`packages/shared-types/src/generated/engine/parser`）；③ 连接断开 → 先查相位投影（connectionStore.phase）与退避日志 |

### E2E-3 审批闭环：run 触发审批 → 移动端允许/拒绝 → 桌面 approval-resolved

| 项       | 内容                                                                                                                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖     | E2E-1 配对成功；approvalWiring 已接线（approvals.tsx 全链 ✅）；**执行载体待裁决**（R-5：载体 B 明文 harness 注入 approval-requested 先行；载体 A 真实引擎 run 待接线轮）                                                                                             |
| 前置条件 | 移动端审批 tab 可达；桌面审批挂起状态可注入                                                                                                                                                                                                                           |
| 操作步骤 | 1. 桌面注入 `approval-requested`（载体 B：harness 注入；载体 A：ask 模式 run 触发 dangerous 工具）；2. 移动端审批 tab → 审批卡出现（upsert）；3. 点击「允许」（或「拒绝」）→ outbox 入队 → 命令发送；4. 断言桌面收 approval-resolved（approved/denied）+ run 恢复语义 |
| 期望断言 | 移动端两阶段确认收敛（命令回执 ok → markDecisionSent；resolved 事件到达 → outbox 出队，approvalWiring.ts:380）；桌面 approval-resolved 广播 + 审计（remote-only 标记，core_backend.rs:209-282）；端到端 <2s（局域网，Z0 §1.1 红线）                                   |
| 失败排查 | ① 决策未发送 → outbox 状态（pending/failed）+ 退避日志（1s→4s→16s→60s）；② 409/冲突 → `cmd.approval_mismatch`（不可重试收敛，PERMANENT_DECISION_ERROR_CODES）；③ 无审批卡 → 事件面未到达（logcat）+ 对账命令（`mobile_list_pending_approvals` 宽容跳过留痕）          |

### E2E-4 断线续传：断连接 → 重连 → resume 追平

| 项       | 内容                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖     | E2E-1 配对成功；ReconnectingWsClient 退避/重连（1277 测试含）+ resume 协议（FeedBridge 对账驱动，observationWiring.ts:4）已实现                                                                                                                                                                                                                            |
| 前置条件 | 移动端在线（live）；桌面连续产生事件                                                                                                                                                                                                                                                                                                                       |
| 操作步骤 | 1. 记录移动端当前 lastSequence（逐会话游标）；2. 断连：`adb shell svc wifi disable`（或 `adb shell am force-stop host.exp.exponent`，R2 会话管理后选）；3. 等待 >30s（退避窗口）；4. 重连（`svc wifi enable` 或重开 app）→ 断言 resume 追平；5. 冷启动恢复变体：force-stop → 重开 → hydrate 直接连接（pairingWiring.ts:400-441 已实现，依赖 R-3 真实驱动） |
| 期望断言 | resume 从 last+1 起逐页补齐（`events.resume.page → resume.done`，R1-11 L4-6 服务面口径 resumedTo 语义）；追平完成转 live；期间桌面产生的事件无丢失（Critical 必达语义，D3 §4.4）                                                                                                                                                                           |
| 失败排查 | ① 重连失败 → 退避上限/相位 dead（logcat + connectionStore）；② 追平缺段 → 游标只升不降（D6 §4.6）+ 空洞容忍（delta 占号不补拉）；③ 冷启动未恢复 → R-3 未装（无持久化凭据可恢复）                                                                                                                                                                           |

### E2E-5 撤销即时性：桌面撤销设备 → 移动端 ≤1s 断开 + 令牌失效提示

| 项       | 内容                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖     | E2E-1 配对成功；pairingWiring `attachRevokedHandler`（device.revoked → 自动 unpair，pairingWiring.ts:806-817）已实现；**「令牌失效提示」UI 依赖配对 UI/相位投影接线**（R-2 注记，接线后可断言横幅/引导文案）                                                                          |
| 前置条件 | 移动端在线；桌面设备列表可见该 deviceId                                                                                                                                                                                                                                               |
| 操作步骤 | 1. 移动端保持连接活跃；2. 桌面撤销设备（`device_revoke` 命令面/设置-设备页，R1-08 UI 已实现）；3. 秒表断言：移动端 ≤1s 收到断开（服务面红线 6 墙钟先例：真实 6ms ≤1s）；4. 断言：移动端收到 `device.revoked`/token-revoked → 状态复位 unpaired（自动 unpair 链）→ 重连尝试被拒（401） |
| 期望断言 | 撤销后移动端不再重连（unauthorized 终止态，Z0 §2.9）；secure-store 已清空（unpair 全清，M5 §6.2）；桌面审计 remote-* 打码（红线 7）                                                                                                                                                   |
| 失败排查 | ① 未断开 → WS 心跳/踢出链（ws.rs kick_by_token_hash 先例）；② 重连 401 但本地未清 → attachRevokedHandler 事件面未达（logcat）或 unpair 异常；③ 撤销后仍能连 → 令牌轮换时序（auth.rs Revoked→401 先例）                                                                                |

### E2E-6 移除本机：移动端移除本机 → 桌面设备消失 + 令牌失效

| 项       | 内容                                                                                                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖     | E2E-1 配对成功；unpair 全链已实现（pairingWiring.ts:526-551：`device.unlink` best-effort → 本地全清 → 断会话）；**设置页「移除本机」UI 占位**（R-2）→ 待设置页落地后执行（或临时经诊断入口触发）                                   |
| 前置条件 | 移动端在线（已配对态）；桌面设备列表可见                                                                                                                                                                                           |
| 操作步骤 | 1. 移动端触发移除本机（unpair：`device.unlink` → 本地清除 → 断连）；2. 断言移动端回欢迎页（pairState=unpaired）；3. 桌面刷新设备列表 → 断言设备消失（或状态 revoked）；4. 旧令牌重连 → 401（令牌已失效）                           |
| 期望断言 | 桌面 device_registry 记录状态变化（撤销 = 状态标记，Z0 §2.10 只增改不删除）；移动端 secure-store 全键清空（`clearPairing` 4+2 位）；重连被拒（`auth.device_revoked`）                                                              |
| 失败排查 | ① 桌面设备未消失 → device.unlink 未达（best-effort 容错：无论桌面成败本地已清，M5 §6.2）→ 核对桌面日志；② 移动端未复位 → unpair 异常分支（persist 清除失败不阻断状态复位）；③ 旧令牌仍可用 → 撤销传播时序（revoke → 401 先例断言） |

---

## 5. 执行准备清单（命令级）

```powershell
# ── 1. 桌面服务（联调 harness，明文 ws 豁免；复用 R1-11 harness 模板）──
#    Temp\opencode\r1-11-harness\（ServerConfig{multi_device_enabled=true,
#    tls_enabled=false, port=8765} + ServerInstance::bind + ServerState 装配 +
#    build_router + serve；对齐 server_integration.rs spawn_server 先例）
cargo run --manifest-path C:\Users\orange\AppData\Local\Temp\opencode\r1-11-harness\Cargo.toml
#    配对码获取：harness 开启配对后读取 CXN 码（控制台/配对文件，10 分钟 TTL）
curl.exe http://127.0.0.1:8765/v1/info        # 明文豁免确认（port=8765, pairingActive）

# ── 2. 模拟器（crish-pixel）──
& "C:\Users\orange\AppData\Local\Android\Sdk\emulator\emulator.exe" -avd crish-pixel -no-snapshot-save
& "C:\Users\orange\AppData\Local\Android\Sdk\platform-tools\adb.exe" wait-for-device
& "C:\Users\orange\AppData\Local\Android\Sdk\platform-tools\adb.exe" shell getprop sys.boot_completed   # 期望 1

# ── 3. 移动端（crish-mobile）──
npm install                                   # 补装 expo-secure-store/expo-sqlite（R-3）
$env:EXPO_PUBLIC_ENGINE_URL = "ws://10.0.2.2:8765"   # 豁免端点（observationWiring.ts:71 优先级 1）
npm --workspace @crish/crish-mobile run start # Metro :8081
# Expo Go 打开 exp://10.0.2.2:8081（R2-01 记录：模拟器宿主别名，稳定路径）

# ── 4. 日志/诊断 ──
& "...\adb.exe" logcat -s ReactNativeJS:*     # 移动端运行期日志（jest 无运行时日志，以此为证）
# 桌面日志：%APPDATA%\Crish\AgentWorkbench\logs\（服务面装配）+ harness 控制台

# ── 5. 执行顺序建议 ──
# 前置（接线轮）→ E2E-1 → E2E-2 → E2E-3（载体 B）→ E2E-4 → E2E-5 → E2E-6
# 全部完成后：关闭 harness → 桌面恢复 wss 装配 → 复测 E2E-1（wss + 证书方案按裁决）
```

---

## 6. 依赖汇总表

| 场景           | pairingWiring 接线  | expo-secure-store/sqlite 安装 |     会话连接     |  审批 UI  |     设置页 UI     | wss 豁免裁决  |
| -------------- | :-----------------: | :---------------------------: | :--------------: | :-------: | :---------------: | :-----------: |
| E2E-1 配对     | ❌ 待接线（硬前置） |       ✅ 待 npm install       | ✅（接线后自动） |     —     |         —         |   ✅ 需裁决   |
| E2E-2 事件流   |   ❌（同 E2E-1）    |              ✅               |        ✅        |     —     |         —         |      ✅       |
| E2E-3 审批     |   ❌（同 E2E-1）    |              ✅               |        ✅        | ✅ 已接线 |         —         | ✅ + 载体裁决 |
| E2E-4 断线续传 |   ❌（同 E2E-1）    |     ✅（冷启动恢复依赖）      |        ✅        |     —     |         —         |      ✅       |
| E2E-5 撤销     |   ❌（同 E2E-1）    |              ✅               |        ✅        |     —     |         —         |      ✅       |
| E2E-6 移除本机 |   ❌（同 E2E-1）    |              ✅               |        ✅        |     —     | ❌ 待接线（占位） |      ✅       |

> ✅ = 已就绪/接线中可随 E2E-1 就绪；❌ = 未完成需前置轮补齐。

---

## 7. 风险登记与裁决请求汇总

| #   | 风险                                                    | 等级     | 处置                                                                                          | 裁决请求                                                              |
| --- | ------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| R-1 | wss 自签证书 vs RN WebSocket 无信任选项（握手失败）     | **关键** | 方案 a：harness 明文豁免（零产品代码改动，生产 wss 不变）；方案 b：模拟器系统证书注入（保真） | **R2-16-裁决-1**：联调窗口明文 ws 豁免（推荐 a），窗口后恢复 wss 复测 |
| R-2 | 配对 UI 未接线（manual.tsx 仅校验）                     | **关键** | R2 收尾轮接线（manual → beginPairing + _layout 装配）                                         | 派单接线轮（本任务只读未改）                                          |
| R-3 | expo-secure-store/expo-sqlite 未安装（真实驱动未启用）  | 高       | `npm install` 补装（workspace 根）                                                            | 执行前置                                                              |
| R-4 | 模拟器非真实局域网（AP 隔离不可真模拟）                 | 中       | 手动输 IP 等价覆盖；真机项保留（Z0 §12.7-2）                                                  | 真机轮另行排期                                                        |
| R-5 | 审批闭环需真实引擎（服务面为 mock 后端）                | 中       | 载体 B（harness 注入）先行；载体 A（真实引擎）接线轮                                          | **R2-16-裁决-2**：E2E-3 执行载体                                      |
| R-6 | mobileCommands.test.ts:362 单测失败（并行阵营命名差异） | 低       | 非本任务域，回归记录；并行阵营收口时清零                                                      | 记录即可                                                              |

---

## 8. 变更记录

| 版本 | 日期       | 变更                                                                                                                                     |
| ---- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| v1.0 | 2026-08-13 | 初稿：前置检查 14 项真实执行结果表 + E2E-1~~6 场景清单（依赖标注/命令级步骤/断言/排查）+ 关键风险 R-1~~R-6 与裁决建议 + 执行准备命令清单 |

_文档结束。本方案为 R2-16 验收准备（部分）产出：只读 + 文档，未修改任何源文件/测试文件；
执行前需主控确认 R2-16-裁决-1/2 与接线轮派单。_
