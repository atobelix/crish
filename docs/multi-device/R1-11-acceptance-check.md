# R1-11 验收核对文档（R1 验收准备）

> 文档编号：R1-11-acceptance-check
> 角色：R1-11 验收准备（只读分析 + 核对文档）
> 日期：2026-08-11
> 定位：R1 桌面服务端验收**核对表与操作手册**——验收人照表操作即可；每项判定附
>      代码/测试/提交证据。不修改任何源文件。
> 验收口径来源：`Z0-master-plan.md` §9.3 R1-11 行（:1367）、§12.9（:1812-1824）、
>      `D2-desktop-serverification.md` §13.1 L4 清单 1-9（:1212-1223）、
>      `D5-security.md` §10.3 红线 1-7（:1316-1324）、§9 安全测试 T-01~T-14（:1159-1174）、
>      AU3 §6.4 缺口 2 追加「Windows 真实局域网真机联调」（Z0 :1154）。
> 编码：UTF-8 无 BOM，中文。

---

## 1. 现状总览（核对基线）

### 1.1 已入库交付（提交链）

| 提交 | 内容 | 对应任务 |
|------|------|----------|
| `8479204c` | 桌面服务骨架（server/ 8 模块 + /v1/info + pairing.json 哈希存储 + 优雅关停，40 测试）+ TLS 模块（tls.rs，10 测试） | R1-01/02/06（wave1） |
| `e15094f8` | FanOutEmitter（订阅过滤/背压分级）+ REST 只读 10 端点 + WS /v1/events 全量（subscribe/subscribeAll/resume/心跳/踢出/上限，35 测试） | R1-01/03/05（wave2） |
| `7eb983da` | REST 写面 8 端点（run/control/cancel/approve/deny/pending/history/settings fail-closed）+ CoreStateBackend 19 方法（18 测试，714 绿） | R1-04（wave3a） |
| `4990d870` | 配对模式（PairingCoordinator：CXN/Lan 重绑钩子/二维码+防火墙数据/撤销全链 WS 踢出+REST 401，GUI 命令四件套，manifest 95→99，6 测试） | R1-07 |
| `a0300e97` | 桌面配对 UI + 设备管理页（设置-设备：QR/CXN 码/列表/撤销/改名，manifest 98→100 双端，7 组件测试） | R1-08 |

### 1.2 工作区未提交的 R1-09/R1-10 部分（验收基线须先固化）

以下内容存在于工作区但**未入库**（`git status` 可见；AGENTS.md「测试是资产」铁律要求立即提交）：

| 文件/变更 | 内容 | 状态 |
|-----------|------|------|
| `src/main.rs`（M） | G-1 服务生命周期槽 + rebind 钩子（配对模式 0.0.0.0 重绑真实装配）+ system_power 唤醒恢复接线 + `multi_device_network_info` 命令注册 | 未提交 |
| `src/multi_device_commands.rs`（M）+ `src/multi_device_network.rs`（??） | G-4 网络环境检测命令面（NetworkEnvInfo） | 未提交 |
| `src/system_power.rs`（??） | G-1 睡眠/唤醒监视（PowerRegisterSuspendResumeNotification + run_resume_recovery + kick_all_ws） | 未提交 |
| `src/server/limiter.rs`（??） | R1-10 连接限流器（每设备 2 / 总量 8 + 审计计数，T-12）——**register 接线待裁决**（每设备 2 vs P0-3 踢旧语义冲突） | 未提交 |
| `src/server/gateway.rs`（??） | R1-10 帧网关（1 MiB 帧限 + 10s 读超时纯判定，T-13）；ws.rs 已切换消费 | 未提交 |
| `crates/conex-telemetry/src/redact.rs`（??）+ `tests/redact_log_scan.rs`（??） | D5 §6.3 M-REDACT 打码库（redact_token/pair_code/provider_key + scan_sensitive）+ T-06 日志扫描测试 | 未提交 |
| `crates/session-loop/src/*`（M，4 文件） | G-9 审批超时权威语义：approval-resolved(expired) 事件落库（tool_exec/approval/executing_tools/tool_events） | 未提交 |

> **验收前置结论 1**：R1-09/R1-10 的以上内容未入库即无法作为验收基线引用提交号；验收前必须先提交固化（主控提交轮处理）。

### 1.3 装配面关键事实（已提交基线 main.rs:501-538）

1. **`instance.router(None)`**（main.rs:519）——CoreStateBackend 未注入 ServerState：
   全部依赖后端的数据端点（/v1/status、/v1/approval/*、/v1/runs 等）运行期返回
   500「服务命令后端未接线」；401 鉴权不受影响。
2. **FanOutEmitter 未装配**——main.rs 无 `attach_fanout` 调用（全仓仅测试调用，
   core_event_bridge.rs:144/308、fanout.rs:865）→ `ServerState.event_stream=None` →
   WS 实时推送不可用（订阅/续传/心跳仍可用）。
3. **配对模式重绑未装配（已提交版本）**——main.rs:372-382 创建 PairingCoordinator
   后未调用 `set_rebind_hook`/`set_port` → 配对开启后服务仍监听 127.0.0.1；
   该缺口在工作区 R1-09 变更中已补（rebind 钩子装配），但未提交。
4. **服务恒启动**——无 `multi_device.enabled` 开关，任何情况下监听 8765-8775。
5. **TLS 未接线**——tls.rs 仅挂载声明（multi_device/mod.rs），axum serve 为明文
   HTTP/WS（mod.rs:222）；D5 要求 wss（TLS 1.3）。

---

## 2. L4 清单 1-9 验收核对表（D2 §13.1 / Z0 §12.9）

| # | 验收项（原文口径） | 判定 | 证据（代码/测试/提交） | 验收操作步骤（真机） | 负责人 | 状态 |
|---|--------------------|------|------------------------|------------------------|--------|------|
| 1 | `npm run tauri dev` 启动 → 本机 `curl http://127.0.0.1:8765/v1/info` 有响应 | ✅ 已实现 | router.rs:169 `handle_info`（免鉴权）；mod.rs:267 `server_info`（port 实际值/bindMode/pairingActive/能力位 17 全表）；测试 mod.rs:403 `serve_info_endpoint_then_graceful_shutdown`（真实监听+HTTP 往返）；提交 `8479204c` | ① `npm run tauri dev` ② `curl http://127.0.0.1:8765/v1/info` ③ 断言 JSON：`service=crish-agent-workbench`、`port=8765`、`bindMode=loopback`、`pairingActive=false`、`capabilities` 17 键 | 待定 | |
| 2 | 未带令牌访问 /v1/status → 401 | ✅ 已实现 | auth.rs:308 `require_bearer_token`（缺失→401、Revoked→401、Invalid→401，ErrorBody 出网）；router.rs:135-159 protected 鉴权组（10 只读+8 写面全挂）；测试 router.rs（无令牌 401 用例）+ ws.rs:1573 `upgrade_rejects_missing_and_invalid_token`、:1588 `upgrade_rejects_revoked_token`；提交 `e15094f8` | ① `curl -i http://127.0.0.1:8765/v1/status` → HTTP 401 + ErrorBody ② `curl -i -H "Authorization: Bearer 假令牌" http://127.0.0.1:8765/v1/status` → 401 ③ `curl -i http://127.0.0.1:8765/v1/info` → 200（免鉴权面不受影响） | 待定 | |
| 3 | 开启配对 → 二维码出现 → 任意 WS 客户端完成 pair 握手 → 拿令牌 | ⚠️ 部分实现 | **已有**：pair.rs 状态机（CXN-12 字符/TTL 10min/5 次锁定/一次性，10 测试：pair.rs:299-442）；pairing.rs:145 `start_pairing`（码+二维码+防火墙提示+网络检测）；pairing.rs:201 `complete_pairing`（校验通过签 32B 令牌）；GUI 命令 multi_device_commands.rs:13-67；前端 SettingsDevicesTab.tsx（QR 渲染/轮询，7 组件测试）；提交 `4990d870`/`a0300e97`。**缺**：① POST /v1/pair 路由未注册（D2 §8.2 路由表 D2:572 要求 `POST /v1/pair {code}→{token}`；router.rs 仅注释「归 R1-07」:125）；② WS pair.hello/challenge/verify/ok 密钥交换消息链未实现（D3 §4.8；ws.rs:842 对范围外 kind 一律忽略）；③ 已提交基线无 0.0.0.0 重绑装配（工作区已补，未提交）；④ /v1/pair 限速（D2:1126 10 次/分钟）缺失 | ① 设置-设备 → 开启配对 → 断言二维码出现且含 `crish-pair://CXN-xxx@<IP>:8765` ② `wscat -c ws://127.0.0.1:8765/v1/events` 发 `pair.hello`（修复后）→ 完成握手 → 断言收到 64 hex 令牌 **（当前缺路由与消息链，此项需先修缺口 G-2 方可执行）** | 待定 | |
| 4 | 令牌连 /v1/events 订阅 → 桌面发起 run → 手机端看到完整事件流 | ⚠️ 部分实现 | **已有**：ws.rs:462 `handle_ws_upgrade`（Bearer/?token= 双通道 + Origin 双保险）；ws.rs:856-1081 subscribe/subscribeAll/resume/heartbeat 全消息处理；fanout.rs:62-97 SubscriptionFilter（会话级/全局白名单，fail-closed）+ 16 测试；ws.rs 35 测试（:1730 `push_filtered_by_subscription`、:1754 preview、:1774 subscribeAll 白名单）；提交 `e15094f8`。**缺**：① 生产装配——main.rs 未 `attach_fanout` → 实时推送断链（§1.3-2）；② 后端未注入（§1.3-1）→ 订阅游标查询/续传数据源不可用；③ 无 TLS（ws://） | **（需先修装配缺口）**：① 桌面发起任意 run ② `wscat -c "ws://<host>:8765/v1/events?token=$TOKEN"` ③ 发 `events.subscribe`（sessionId 列表）→ 断言 `events.subscribe.ok`（逐会话 nextSequence）④ 桌面 run 产生新事件 → 断言 `events.push` 逐事件到达且载荷与桌面事件通道一致 | 待定 | |
| 5 | 审批场景：run 触发工具审批 → 手机端 approve → 桌面端即时收到 approval-resolved | ⚠️ 部分实现 | **已有**：router.rs:372 `handle_approve` / :387 `handle_deny`（toolCallId 路径真键，I-02 pending 校验）；core_backend.rs:403 `approve`（直调 approve_tool_impl）；协议级已由 R0-07 件 2 验证（`scripts/mock-daemon/tests/acceptance/02-approval-resume-run.test.ts`：挂起→approve→run 恢复→approval-resolved 完整序列）；提交 `7eb983da`。**缺**：main.rs 后端未注入（§1.3-1）→ 运行期 500；移动端客户端属 R2 不存在（真机侧需通用客户端替代） | **（需先修装配缺口）**：① 桌面 ask 模式 run 触发 dangerous 工具 → 挂起 ② `curl -X POST http://127.0.0.1:8765/v1/approval/{toolCallId}/approve -H "Authorization: Bearer $TOKEN" -d '{}'` → 断言 `{ok:true}` ③ 桌面断言 approval-resolved（approved）广播与 run 恢复执行 | 待定 | |
| 6 | 手机断 Wi-Fi → 重连 → 事件从断点续传 | ⚠️ 部分实现 | **已有**：ws.rs:980 `handle_resume`（未订阅拒绝 stream.not_subscribed → 逐页 resume.page → resume.done → flush 重放期 pending）；游标语义与 REST 同契约；测试 ws.rs:1841 `resume_continues_from_last_sequence`、:1901 `realtime_during_resume_queued_after_done`（先重放后实时）；R0-07 件 3 mock 网关重连韧性（03-gateway-down-resilience.test.ts）；提交 `e15094f8`。**缺**：生产装配（§1.3-1/2）；真机侧依赖 R2 客户端（wscat 可替代） | **（需先修装配缺口）**：① 订阅+记录 lastSequence ② 断 Wi-Fi（或杀连接）≥30s ③ 重连同令牌 → 发 `events.resume{afterSequence:last}` ④ 断言 resume.page 从 last+1 起、resume.done 收口、实时衔接 | 待定 | |
| 7 | 桌面退出 → 重开 → 手机 token 仍有效，续传无缝 | ⚠️ 部分实现 | **已有**：令牌持久化 auth.rs:96 `load`/218 `save`（pairing.json 原子写 tmp+rename）；测试 auth.rs:462 `persistence_roundtrip_across_reload`（重启后令牌仍 Valid）；提交 `8479204c`。**缺**：续传依赖 backend/fanout 装配（§1.3）；真机验证缺 | **（需先修装配缺口）**：① 配对拿 token ② 完全退出应用 ③ 重启 → `curl -H "Authorization: Bearer $TOKEN" /v1/hello` → 200 ④ 旧 token 连 /v1/events → 101 升级 + subscribe/resume 正常 | 待定 | |
| 8 | 关闭配对 → 手机全部连接被踢、令牌失效 | ⚠️ 部分实现 | **已有**：撤销全链 pairing.rs:244 `revoke_device` / :276 `revoke_all` → ws.rs:344 `kick_by_token_hash`（token-revoked）→ sender task 发 kicked 帧+close（ws.rs:685-694）；测试 ws.rs:2147 `kick_by_token_hash_revokes_connection`；REST 侧撤销令牌自然 401（auth.rs:329）。**缺**：① GUI「关闭配对」命令 multi_device_pair_cancel → pairing.rs:231 `cancel_pairing` **只重置状态机，不清令牌不踢连接**——与 D2 §5.4 关闭动作「清空全部已签发令牌」不符（D2:380）；② 无 revoke_all 命令面（manifest 仅逐设备 revoke_device） | **（当前仅逐设备撤销路径可验）**：① 手机 WS 连 /v1/events 保持活跃 ② 桌面设置-设备 → 撤销该设备 → 断言手机 ≤1s 收到 `error` 帧（auth.device_revoked/token-revoked）且连接关闭 ③ 重连同令牌 → 401 ④ 补充路径：验证「关闭配对」语义（当前缺，见缺口 G-4） | 待定 | |
| 9 | 8765 被占用（netstat 占位）→ 启动后服务落在 8766，/v1/info 反映实际端口 | ✅ 已实现 | mod.rs:158 `bind`（8765..8775 顺序探测，全失败返回错误不阻断应用）；config.rs:20 `PORT_PROBE_COUNT=11`；测试 mod.rs:349 `port_probe_falls_back_to_next_port_when_occupied`（真实占用 8765 → 断言 8766）；/v1/info.port = 实际监听端口（mod.rs:273）；提交 `8479204c` | ① `netstat -ano \| findstr :8765` 确认无占用 ② 用 `netstat` 占位（或起任意进程绑 8765）③ 启动应用 ④ `curl http://127.0.0.1:8766/v1/info` → 断言 `port: 8766` ⑤ 8765 释放后重启 → 回落到 8765 | 待定 | |

---

## 3. D5 §10.3 红线 1-7 验收核对表

| # | 红线（原文口径） | 判定 | 证据（代码/测试/提交） | 验收操作步骤 | 负责人 | 状态 |
|---|------------------|------|------------------------|--------------|--------|------|
| 1 | `multi_device.enabled=false` 时无任何端口监听（netstat 断言） | ❌ 未实现 | 全仓无 `multi_device.enabled` 配置项（config.rs ServerConfig 仅 port/bind_mode/pairing_enabled/pairing_file_path）；main.rs:507 无条件启动服务并恒监听 loopback 8765（提交基线）；服务关闭仅限退出钩子（main.rs:560） | **（需先实现开关 G-7）**：① 关闭多端开关 ② `netstat -ano \| findstr "876[5-9]"` → 断言无监听 ③ 开启后监听恢复 | 待定 | |
| 2 | 远程 run 无法获得 full-access（装配断言 + 审计断言） | ⚠️ 部分实现 | **协议面排除**：core_backend.rs:324-331 注释「full-access 移动端不可改——协议面不提供该选项」（M6 C24 wire 语义）。**缺**：① wire 映射仍将 `PermissionMode::FullAccess → "full-access"` 原样传入（core_backend.rs:330，无 `min(mode, ask)` 截断）；② D5 §4.6.1 `assemble_remote_run` 降级逻辑（D5:731-753）未实现；③ 无 `remote-mode-downgrade` 审计；④ 无装配断言测试 | **（需先实现远程网关 G-5）**：① 远程申报 full-access 发起 run → 断言生效模式为 ask ② 断言审计含 remote-mode-downgrade ③ 远程 run 内危险工具仍产生审批（NeedsApproval） | 待定 | |
| 3 | 红线命令经远程通道一律 Deny（复用现有红线单测矩阵跑远程变体） | ⚠️ 部分实现 | **基础语义已存在**：crates/agent-tools/src/permission.rs:96 `decide_with_redline`（红线→一律 Deny，任何模式不可豁免）；测试 permission.rs:278 `redline_denied_in_full_access`、:298 `redline_denied_in_all_modes_without_approval`。**缺**：① 远程变体矩阵测试（D5 明确要求「复用现有红线单测矩阵跑远程变体」）；② 远程执行链不存在（远程网关未实现），端到端不可验 | ① `cargo test -p agent-tools`（红线矩阵基线绿）② （修后）远程 run 内触发红线命令（如 `rm -rf /` 语义）→ 断言 Deny 且无审批路径 | 待定 | |
| 4 | 日志扫描测试（T-06）零明文命中 | ⚠️ 部分实现 | **存储面零明文已固化**：auth.rs:410 `persisted_file_never_contains_raw_token`（pairing.json 只存 SHA-256，断言不含明文）；配对码不落盘（pair.rs 仅内存）。**打码库已在工作区（未提交）**：crates/conex-telemetry/src/redact.rs（redact_token/pair_code/provider_key + scan_sensitive + redact_text）+ tests/redact_log_scan.rs（T-06 日志扫描断言）；ws.rs:516 标签兜底已切 redact_token。**缺**：redact 未入库；运行期日志接线仅 ws 标签一处，审计面/配对面未全量接入 | ① `cargo test -p conex-telemetry`（含 redact_log_scan，提交后）② 跑典型场景（配对+连接+撤销）③ 扫描日志目录（`%APPDATA%\Crish\AgentWorkbench\logs`）：令牌 43 字符形态 / `CXN-` 配对码 / `sk-` 密钥形态 → 断言零命中 | 待定 | |
| 5 | `config_secret_*` 远程来源 100% Forbidden（白名单 + 命令级双层） | ❌ 未实现 | **无第一层**：远程命令白名单（D5 §4.5，D5:700-719）未实现——全仓无 whitelist/remote 白名单代码。**无第二层**：`remote_source` 命令级拒绝分支（D5 §8.2）未实现——credentials.rs:237-341（config_secret_set/get/clear/reveal/has）无远程来源判定。**无第三层**：`remote-source-attempt` 审计不存在（§红线 7）。config_secret_* 以 engine 命令注册于 manifest（command_manifest.rs:109-114） | **（需先实现远程网关 G-5）**：① 带令牌远程调 config_secret_reveal → 断言 403/Forbidden ② 断言审计 remote-source-attempt ③ 白名单复核：config_secret_* 五条均不在远程白名单 | 待定 | |
| 6 | 撤销设备 ≤1s 内断开全部活动连接（集成测试断言） | ⚠️ 部分实现 | **踢出链已实现**：pairing.rs:244/276 → ws.rs:344 `kick_by_token_hash` → sender task 发 kicked 帧+close（ws.rs:685-694）；测试 ws.rs:2147 `kick_by_token_hash_revokes_connection`（注册表级）。**缺**：① D2 §13.1 L2 规划的 `tests/server_integration.rs`（真实 WS 集成：重放/续传/踢出/心跳契约类）**未落地**——tests/ 目录仅 config_command_names_contract.rs 与 event_bridge_contract.rs；② 无「≤1s」时延断言 | ① `cargo test -p crish-agent-workbench`（kick 单测绿）② 真机：手机 WS 活跃 → 桌面撤销 → 秒表断言 ≤1s 收到 kicked 且断开 ③ （补 server_integration.rs 后）集成测试断言时延 | 待定 | |
| 7 | 全部远程动作产生 `remote-*` 审计且打码（审计完整性抽查） | ❌ 未实现 | **无 remote-* 操作变体**：crates/conex-types/src/events.rs:66-83 `SecurityAuditOperation` 仅 6 类（delete/trash-restore/trash-purge/git-revert/command-exec/undeclared-write），无 remote-pair/remote-auth/remote-session/remote-device-* 族（D5 §2 设计，D5:79-80）；crates/agent-tools/src/audit.rs 无 remote 字样。**无远程网关审计**：T-01 `remote-auth` denied 审计、T-07 `remote-source-attempt`、T-08 `remote-mode-downgrade` 均不存在 | **（需先实现远程网关+审计变体 G-5/G-6）**：① 执行任意远程动作（配对/连接/命令）② 断言 security-audit 事件 operation 前缀 `remote-*` ③ 断言载荷无令牌/配对码明文（redact 打码） | 待定 | |

---

## 4. 安全测试面 T-01~T-14 核对表（Z0 §9.3 R1-10 出口 / D5 §9.1）

| 编号 | 场景 | 判定 | 证据/缺口 |
|------|------|------|-----------|
| T-01 | 伪造端：无令牌直连 | ❌ 未实现 | 无 `remote-auth` denied 审计（ws.rs 401 响应存在但无审计事件） |
| T-02 | 令牌重放/同令牌并发 | ⚠️ 部分 | ws.rs:2277 `registry_duplicate_token_kicks_old`、:2096 `duplicate_connection_kicks_old`（踢旧语义）；「会话密钥 8h 过期」未实现；无告警审计 |
| T-03 | 中间人：ARP+伪造证书（pinning） | ❌ 未实现 | tls.rs 模块完成（自签 CA/指纹固定，10 测试，提交 `8479204c`）但**服务未启用 rustls**（mod.rs:222 明文 serve）；无测试客户端错误指纹断言 |
| T-04 | 强制降级 ws:// | ❌ 未实现 | 服务端当前就是 ws://（无 TLS 路径）；无 403 拒绝逻辑（D5 §4.1「服务端不回应 ws:// 握手」设计未落地） |
| T-05 | 配对码暴力（5 次锁定） | ✅ 已实现 | pair.rs:368 `verify_wrong_code_counts_attempts_and_locks`（5 次→冷却 5min，锁定期正确码也拒）；pair.rs:108 `record_failure`；「IP 锁定 15 分钟」未实现（配对走 GUI 无 IP 面） |
| T-06 | 令牌窃取：日志泄露（grep 扫描） | ⚠️ 部分 | 测试已在工作区（crates/conex-telemetry/tests/redact_log_scan.rs，**未提交**）；redact 库未入库；运行期接线不全（见红线 4） |
| T-07 | 远程调 config_secret_reveal | ❌ 未实现 | 依赖远程网关+命令级 remote_source（红线 5 同缺口） |
| T-08 | 远程指定 full-access | ❌ 未实现 | 无 min(mode,ask) 截断与 remote-mode-downgrade 审计（红线 2 同缺口） |
| T-09 | 密钥不出桌面（事件流无 sk- 形态） | ❌ 未实现 | 无远程事件流快照扫描测试；redact.rs scan_sensitive 有 ProviderKey 形态可复用（未接线） |
| T-10 | 审批伪造（不存在 tool_call_id） | ✅ 已实现 | approve_tool_impl resolve NotFound（core_run_commands.rs:230-245，I-02）；R0-07 件 2 deny 变体断言 cmd.approval_mismatch |
| T-11 | 撤销即时性（撤销后旧令牌重连） | ⚠️ 部分 | ws.rs:2147 kick + auth.rs:329 Revoked→401；缺集成级（server_integration.rs 未落地） |
| T-12 | DoS 连接洪水（超限拒绝+审计） | ⚠️ 部分 | ws.rs:75 `MAX_WS_CONNECTIONS=8`、:2118 `connection_limit_rejects_ninth`；limiter.rs（每设备 2/总 8 + audit_rejected_* 计数，工作区未提交）**register 接线待裁决**（每设备 2 vs P0-3 踢旧冲突，limiter.rs:23-26 自述）；审计事件未接 events 面 |
| T-13 | 慢速/超长帧 | ⚠️ 部分 | ws.rs:2198 `frame_too_large_closes_connection`（1 MiB）；gateway.rs（工作区未提交）读超时 10s 纯判定已接入心跳判定（ws.rs:720）；**10s 空闲读超时与 30s Ping 节奏冲突未决**（gateway.rs:19 自述） |
| T-14 | 双轨确认（桌面在场+移动端批准） | ❌ 未实现 | 无 Remote 裁决路由（D5 §4.4 双轨纯函数）；`remote-only` 审计标记不存在；R2 移动端审批中心才承接双端确认（Z0 C-3 裁决：移动端远程审批 R2 开放） |

---

## 5. 已知缺口清单（按验收阻塞度排序）

| # | 缺口 | 影响（L4/红线/T） | 级别 | 处置建议 |
|---|------|-------------------|------|----------|
| G-1 | **main.rs 生产装配缺失**：`router(None)` 未注入 CoreStateBackend + 未 attach FanOutEmitter（§1.3-1/2） | L4-4/5/6/7、红线 2 端到端不可验 | 阻塞 | main.rs 装配面：构造 CoreStateBackend 注入 ServerState + EventBridge::attach_fanout 后 set_event_stream |
| G-2 | **移动端配对入口缺失**：POST /v1/pair 路由 + WS pair.hello/challenge/verify/ok 消息链未实现（router.rs:125 注释「归 R1-07」但 R1-07 未落地） | L4-3 无法远程拿令牌 | 阻塞 | 按 D2 §8.2（POST /v1/pair {code}→{token}）或 D3 §4.8（WS 密钥交换链）实现；含 /v1/pair 限速（D2:1126） |
| G-3 | **TLS 未接线**：tls.rs 完成但服务为明文 ws://（mod.rs:222） | T-03/T-04、红线 2 前置（D5 要求 wss）、真机联调安全面 | 阻塞（D5 口径）/可裁决 | axum 换 rustls 装配（rustls TLS 1.3 + CA 指纹随配对载荷带外传递 D3 §4.6）；或主控裁决 R1 内部联调豁免 wss |
| G-4 | **「关闭配对」语义不符**：multi_device_pair_cancel → cancel_pairing 不清令牌不踢连接（D2 §5.4 要求清空全部令牌）；无 revoke_all 命令面 | L4-8 | 高 | cancel_pairing 增加撤销全部令牌+WS 踢出；或新增 multi_device_revoke_all 命令+UI 按钮 |
| G-5 | **远程安全面整体缺失**：远程命令白名单、能力分级（observe/approve/operate）、min(mode,ask) 截断、remote-source-attempt/remote-mode-downgrade/remote-* 审计变体 | 红线 2/3/5/7、T-01/T-02/T-07/T-08/T-14 | 高（D5 M0 出口） | 按 D5 §4.5/§4.6/§8 实现远程网关 + SecurityAuditOperation 扩展 remote-* 变体（events.rs:66，需事件注册表同步） |
| G-6 | **红线 1 无开关**：multi_device.enabled 配置不存在，服务恒监听 | 红线 1 | 高 | 设置项（default true/false 按 D2 语义）+ main.rs 条件启动；netstat 断言前必须先有开关 |
| G-7 | **server_integration.rs 未落地**（D2 §13.1 L2 规划：真实 WS 集成+撤销 ≤1s 时延断言+重放/续传/踢出契约类） | 红线 6（≤1s 集成断言）、L4 自动化支撑 | 中 | 按 D2:1183-1203 补 tests/server_integration.rs（tokio-tungstenite 已在 Cargo.toml:113） |
| G-8 | **R1-09/R1-10 工作区未提交**（§1.2 七组文件） | 验收基线不明确 | 中（流程） | 主控提交轮先固化（含 limiter register 接线裁决、10s 读超时 vs 30s Ping 冲突裁决） |
| G-9 | **红线/降级语义远程变体测试缺失**（D5 §10.3-3 明确要求） | 红线 3 | 中 | 在 permission.rs 既有矩阵（permission.rs:278-330）外补远程来源变体 |
| G-10 | **真机侧客户端不存在**：R2 移动端 app 未开始（Z0 §9.4 R2-01），「手机」角色在 R1-11 需替代客户端 | L4-3~8 手测执行面 | 中（执行口径） | 主控裁决：wscat/websocat + 手工 DeviceEnvelope 帧（mock-daemon 先例 scripts/mock-daemon），或开发一次性脚本客户端（测试资产须入库） |

---

## 6. 验收操作步骤汇总（命令速查）

```powershell
# 环境准备（开发模式）
npm run tauri dev

# L4-1：服务自报
curl http://127.0.0.1:8765/v1/info

# L4-2：401（无令牌 / 坏令牌）
curl -i http://127.0.0.1:8765/v1/status
curl -i -H "Authorization: Bearer deadbeef" http://127.0.0.1:8765/v1/status

# L4-3：配对拿令牌（G-2 修复后；令牌 64 hex）
#   wscat -c "ws://127.0.0.1:8765/v1/events"   # 发 pair 握手帧

# L4-4：事件流订阅（$TOKEN = 配对令牌）
#   wscat -c "ws://127.0.0.1:8765/v1/events?token=$TOKEN"
#   发 {"v":1,"kind":"events.subscribe","msgId":"t1","body":{"sessions":["<sessionId>"]}}
#   桌面发起 run → 断言 events.push

# L4-5：手机 approve（$TID = 待审批 tool_call_id）
curl -X POST http://127.0.0.1:8765/v1/approval/$TID/approve -H "Authorization: Bearer $TOKEN" -d "{}"

# L4-6/L4-7：断线续传 / 重启续传
#   记录 lastSequence → 断连/重启 → 重连 → 发 events.resume{afterSequence}

# L4-8：撤销踢出（设备管理页撤销；≤1s 断言）
#   WS 侧断言 error 帧（auth.device_revoked）+ 连接关闭；重连 → 401

# L4-9：端口探测兜底
netstat -ano | findstr ":8765"          # 确认占用
# （起任意进程绑 8765 后）启动应用 → curl http://127.0.0.1:8766/v1/info

# 红线 1（G-6 修复后）：无监听断言
netstat -ano | findstr "876[5-9]"

# 红线 4：日志扫描（手工）
#   %APPDATA%\Crish\AgentWorkbench\logs\ 下扫描：43 字符令牌形态 / CXN- / sk- 前缀
#   自动化：cargo test -p conex-telemetry（redact_log_scan，提交后）

# 自动化门禁（验收前置，全绿基线）
cargo test --workspace
cargo test -p crish-agent-workbench        # server 模块 100+ 测试
npm run typecheck                          # 前端门禁
```

---

## 7. 真机联调前置条件清单（Z0 §12.9 追加验收：Windows 真实局域网）

> 追加验收口径（AU3 §6.4 缺口 2 / Z0 :1154）：家用路由器扫码配对 + 审批闭环 +
> AP 隔离手动输 IP 路径；非虚拟网卡。

| # | 前置条件 | 操作/说明 | 状态 |
|---|----------|-----------|------|
| 1 | **缺口修复前置**：G-1（装配）/G-2（pair 入口）/G-3（TLS 裁决）必须先落地或主控裁决豁免，否则 L4-3~7 无法真机执行 | 见 §5 缺口表 | 待主控 |
| 2 | Windows 防火墙放行 | 首次配对 0.0.0.0 监听触发弹窗 → 勾选「专用网络」允许；未弹窗则：控制面板 → Windows Defender 防火墙 → 高级设置 → 入站规则 → 新建规则放行 TCP 8765-8775（或 crish 应用） | 待定 |
| 3 | 网络配置文件切「专用」 | 设置 → 网络和 Internet → 当前 Wi-Fi → 网络配置文件类型 = 专用（公用网络默认拦截入站） | 待定 |
| 4 | 手机/电脑同一路由器（真实局域网） | 同一家用路由器/交换机网段；禁用虚拟网卡干扰（Hyper-V/WSL 虚拟适配器可能被 local_ips 枚举误报，pairing.rs:345 已过滤链路本地/回环） | 待定 |
| 5 | 电脑 IP 确认 | 设置-设备页展示 recommendedIp（与二维码内嵌同源，pairing.rs:160/335）；`ipconfig` 对照 | 待定 |
| 6 | AP 隔离场景路径 | 路由器开启 AP/客户端隔离时手机无法发现电脑 → 走手动输 IP 路径（二维码内 IP 优先；支持 local_ips 备选） | 待定 |
| 7 | TLS 裁决 | 当前服务为 ws:// 明文——真机联调若在 wss 接线前进行，属 D5 红线豁免事项，**需主控书面裁决**（建议：先补 G-3 再联调） | 待主控 |
| 8 | 手机侧替代客户端（G-10 裁决） | R2 app 不存在：wscat/websocat + 手工 DeviceEnvelope 帧；或一次性脚本客户端（对齐 scripts/mock-daemon 先例，测试资产入库铁律） | 待主控 |
| 9 | 工具就绪 | curl（Win10+ 自带）、netstat、wscat（`npm i -g wscat` 或 websocat）、秒表（撤销 ≤1s） | 待定 |
| 10 | 日志与配置目录 | 日志：`%APPDATA%\Crish\AgentWorkbench\logs`；令牌库：`%APPDATA%\Crish\AgentWorkbench\pairing.json`（只存哈希）；TLS 证书：`%APPDATA%\Crish\AgentWorkbench\multi-device\` | 待定 |
| 11 | 自动化前置基线 | `cargo test --workspace`（73 套件基线不得因验收变红）、R1 模块测试全绿（§6 命令）、`npm run typecheck` | 待定 |
| 12 | R1-09/R1-10 未提交内容先入库（G-8） | 主控提交轮固化后再跑验收，避免验收对象漂移 | 待主控 |

---

## 8. 验收执行顺序建议

1. **提交轮固化**（G-8）：R1-09/R1-10 工作区内容入库（含 limiter register 接线与 10s 读超时两个待裁决项）。
2. **自动化门禁**：`cargo test --workspace` + `cargo test -p crish-agent-workbench` + `npm run typecheck` 全绿。
3. **缺口修复（主控排期）**：G-1 装配 → G-2 pair 入口 → G-3 TLS（或裁决）→ G-4 关闭配对语义 → G-6 enabled 开关 → G-5 远程网关（红线 2/3/5/7 依赖）→ G-7 server_integration.rs。
4. **L4 手测九项**（§2 操作步骤；1/2/9 当前即可执行，3-8 依赖修复）。
5. **红线 1-7 验证**（§3 操作步骤；4 的部分与 6 当前可执行，其余依赖 G-5/G-6）。
6. **Windows 真实局域网真机联调**（§7 前置条件全过）：扫码配对 → 审批闭环 → 断线续传 → 撤销即时性 → AP 隔离手动 IP。
7. **验收记录**（R1-11 出口判定，Z0 §9.9）：产出验收记录文档，勾销上表状态列。

---

## 9. 判定汇总表（汇报用）

| 域 | 项 | 判定 |
|----|----|------|
| L4 | 1 /v1/info | ✅ 已实现 |
| L4 | 2 无令牌 401 | ✅ 已实现 |
| L4 | 3 配对拿令牌 | ⚠️ 部分（GUI+状态机✅；HTTP/WS 配对入口缺失，0.0.0.0 重绑未提交） |
| L4 | 4 事件流订阅 | ⚠️ 部分（WS 面+35 测试✅；生产装配缺 fanout/backend） |
| L4 | 5 手机 approve | ⚠️ 部分（REST+CoreStateBackend✅；main.rs 后端未注入，运行期 500） |
| L4 | 6 断线续传 | ⚠️ 部分（resume+测试✅；装配缺，真机依赖替代客户端） |
| L4 | 7 桌面重启续传 | ⚠️ 部分（令牌持久化✅；续传依赖装配） |
| L4 | 8 关闭配对踢出 | ⚠️ 部分（撤销全链✅；「关闭配对」命令不清令牌不踢连接） |
| L4 | 9 端口冲突 8766 | ✅ 已实现 |
| 红线 | 1 enabled=false 无监听 | ❌ 未实现（无开关，服务恒监听） |
| 红线 | 2 远程无 full-access | ⚠️ 部分（协议面排除；无 min(mode,ask) 截断与降级审计） |
| 红线 | 3 红线命令远程 Deny | ⚠️ 部分（decide_with_redline 语义✅；远程变体矩阵缺失） |
| 红线 | 4 日志零明文 | ⚠️ 部分（存储面哈希✅；redact 库+扫描测试已写未提交，接线不全） |
| 红线 | 5 config_secret 远程 Forbidden | ❌ 未实现（无白名单/remote_source 双层） |
| 红线 | 6 撤销 ≤1s 断连 | ⚠️ 部分（踢出链✅；无 ≤1s 集成测试，server_integration.rs 缺失） |
| 红线 | 7 remote-* 审计打码 | ❌ 未实现（无 remote-* 事件变体、无网关审计） |
| T 面 | T-05/T-10/T-11/T-13 | ✅ 基础已实现 |
| T 面 | T-02/T-06/T-12 | ⚠️ 部分（踢旧✅/测试未提交/接线待裁决） |
| T 面 | T-01/T-03/T-04/T-07/T-08/T-09/T-14 | ❌ 未实现（依赖远程网关/TLS 接线） |

### 主要缺口（前 5）

1. **G-1 main.rs 生产装配缺失**：CoreStateBackend 未注入（router(None)）+ FanOutEmitter 未 attach → L4-4/5/6/7 运行期不可用（最优先）。
2. **G-2 移动端配对入口缺失**：POST /v1/pair 与 WS pair 消息链未实现 → L4-3 无远程拿令牌路径。
3. **G-5 远程安全面整体缺失**（白名单/能力分级/模式截断/remote-* 审计/双层 Forbidden）→ 红线 2/3/5/7 与 T-01/07/08 端到端不可验（D5 M0 出口项）。
4. **G-6 红线 1 无开关**：multi_device.enabled 配置不存在 → netstat 断言必挂。
5. **G-3 TLS 未接线**：服务为明文 ws:// → T-03/T-04 与 D5 wss 要求不符，真机联调安全面需主控裁决。

---

## 10. R1-10 收口裁决（主控 2026-08-11，子代理上报协调点归档）

R1-10 安全测试面执行中暴露的规格冲突/未接线点，主控裁决如下（供 R1-11 验收与 R2 引用）：

| # | 冲突点 | 裁决 | 依据 |
|---|--------|------|------|
| D-1 | T-12「每设备 2 连接」 vs P0-3「同令牌踢旧」（每设备恒 ≤1） | **维持 P0-3 踢旧**；`server/limiter.rs` 每设备参数保留（默认 2，可配置）不接线，待 R2 移动端多连接场景装配时启用；总量 8 与 ws.rs MAX_WS_CONNECTIONS 一致，沿用 | P0-3 既有裁决优先；D5 §7.2 冲突已标注 |
| D-2 | T-13「读超时 10s 断连」 vs D2 §10.2「30s Ping/90s 踢出」 | **保持 D2 契约**（30s/90s）；`gateway::read_timeout_exceeded` 10s 纯函数保留（供 R4 P2P 链路复用），不接 ws 断链（会误杀健康连接并破坏既有心跳测试） | D2 §10.2 已锁定 |
| D-3 | T-04「ws:// 降级拒绝」自动化 | **列手工/评审项**（与 T-03/T-07/T-14 同）；自动化随 wss 监听接线落地（tls_acceptor 消费 = R1-11 装配面任务）后补 | D5 §9.3「网络依赖用例不进自动门禁」 |
| D-4 | T-01「IP 锁定 15 分钟」 | 归 `server/limiter.rs`（每源 IP 限流，已实现待装配）；会话级冷却 5min（PAIR_LOCK_COOLDOWN_MS）为既有口径不变 | D5 §7.3/§7.4 |
| D-5 | T-07/T-08「remote-* 事件级审计」 | SecurityAuditOperation 无 remote-* 变体——R1-10 落结构化审计日志（target `security.audit`）+ 标记载荷；事件面扩展（D5 §8.5）排 R2 | D5 §8.5 最小方案 |

另：`router.rs` 404 兜底回显由完整 URI 改为 `uri.path()`（去除 `?token=` 等查询串回显，T-06 邻域安全项，R1-10 收口顺手修复）。

---

## 11. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-08-11 | 初稿：L4 1-9 + 红线 1-7 + T-01~14 核对表、缺口清单（10 项）、真机联调前置条件（12 项）、验收操作手册 |
| v1.1 | 2026-08-11 | R1-10 收口：新增 §10 主控裁决（D-1~D-5，限流/T-04/IP 锁定/审计 5 项协调点） |

---

*文档结束。R1-11 验收核对由 R1-11 验收准备子代理产出（只读分析，未修改任何源文件）；判定证据均为 2026-08-11 工作区+提交链实况。*
