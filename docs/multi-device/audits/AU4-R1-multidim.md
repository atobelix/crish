# AU4：R1 阶段多维度全面审计报告（桌面多端互通服务端）

> 文档编号：AU4-R1-multidim
> 角色：R1 多维度全面审计（只读分析 + 审计报告）
> 日期：2026-08-12
> 范围：R1-01~~R1-11 全部任务包（Z0 §9.3 表 + §9.9 验收锚点行）；D2 §13.1 L4 清单 1-9；D5 §10.3 红线 1-7 + §9 T-01~~T-14
> 方法：全部证据取自 2026-08-12 工作区代码与提交链实况（只读，未修改任何源文件）
> 编码：UTF-8 无 BOM，中文

---

## 0. 审计基线（提交链与测试规模）

### 0.1 R1 相关提交链（2026-08-11 ~ 08-12）

| 提交       | 日期       | 内容                                                                                                                                                                                                                    |
| ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `8479204c` | 2026-08-11 | R1 wave1：服务骨架（server/ 8 模块 + /v1/info + pairing.json 哈希存储 + 优雅关停，40 测试）+ TLS 模块（tls.rs，10 测试）——R1-01/02/06                                                                                   |
| `e15094f8` | 2026-08-11 | R1 wave2：FanOutEmitter（订阅过滤/丢帧分级/端级背压）+ REST 只读 10 端点 + WS /v1/events 全量（subscribe/resume/心跳/踢出/上限，35 测试）——R1-01/03/05                                                                  |
| `7eb983da` | 2026-08-11 | R1 wave3a：REST 写面 8 端点 + CoreStateBackend 19 方法（18 测试，714 绿）——R1-04                                                                                                                                        |
| `4990d870` | 2026-08-11 | R1-07 配对模式（PairingCoordinator：CXN/Lan 重绑钩子/二维码+防火墙/撤销全链，manifest 95→99，6 测试）                                                                                                                   |
| `a0300e97` | 2026-08-11 | R1-08 配对 UI + 设备管理页（manifest 98→100 双端，7 组件测试）                                                                                                                                                          |
| `328a170c` | 2026-08-11 | R1-10 收口（8 子代理落地：system_power/网络环境/T-01~~14 套件/limiter/gateway/redact/TLS-01~~10，registry 90→99，裁决 D-1~D-5 归档）                                                                                    |
| `f3c140a2` | 2026-08-11 | R1-10 安全测试面：T-01 伪造令牌计数/T-05 销毁/T-10 审批伪造/T-11 撤销令牌/T-02 踢旧/T-07 密钥面 403/T-08 降级/T-14 双轨纯函数 + redact 三件套（66 新测试，753 绿）                                                      |
| `b867fc28` | 2026-08-12 | **R1-11 closeout**：G-4 cancel_pairing 撤销全部令牌+踢 WS（D2 §5.4，12 pairing 测试）+ G-5 远程白名单 32 条注册表（M6 C01-C32）+ 403 CmdDenied 映射 + config_secret 远程 Forbidden e2e + 红线 2 降级审计断言（14 测试） |
| `84658217` | 2026-08-12 | G-4b 关闭配对确认弹窗（danger ConfirmDialog + 撤销全部语义文案 + confirm/cancel 路径，16 测试）                                                                                                                         |
| `16f2f55f` | 2026-08-12 | R2-02a 移动端连接层 + server_integration.rs 资产入库                                                                                                                                                                    |
| `bed1924f` | 2026-08-12 | G-7 server_integration.rs 编译修复 + **11/11 全绿**（E0308 Arc 双层修复；revoke-401 根因：协调器与路由层共享 TokenStore Arc；≤1s 壁钟踢出断言）——D2 L2 契约全过                                                         |

### 0.2 R1 面测试规模（当前代码实况）

| 面                                             | 数量                                                                                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server/ 模块单测                               | 209（router.rs 65 / ws.rs 41 / fanout.rs 16 / core_backend.rs 13 / auth.rs 13 / pairing.rs 12 / pair.rs 11 / mod.rs 10 / limiter.rs 8 / remote_whitelist.rs 6 / config.rs 5 / gateway.rs 5 / error.rs 4） |
| tests/server_integration.rs（L2 集成）         | 11                                                                                                                                                                                                        |
| multi_device/tls.rs                            | 11（TLS-01~10 清单 + 1）                                                                                                                                                                                  |
| main.rs（装配面）                              | 8（注册面一致/开关状态机/wss 强制/重绑）                                                                                                                                                                  |
| conex-telemetry redact.rs + redact_log_scan.rs | 16 + 3                                                                                                                                                                                                    |
| 前端 SettingsDevicesTab 组件测试               | 16（a0300e97 7 + 84658217 16，含确认弹窗路径）                                                                                                                                                            |
| 合计（R1 面，不含全仓回归）                    | ≈274                                                                                                                                                                                                      |

---

## 1. 维度一：正确性（Z0 §9.9 验收锚点逐项核对）

> 判定口径：✅ 锚点已实现且有测试/证据 / ⚠️ 部分实现（注明缺口）/ ❌ 缺失。括号内为证据（文件:行号/测试名/提交号）。

| 包       | 验收锚点（Z0 §9.9 原文口径）                                                 | 判定                        | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-01    | FanOutEmitter 单测（双发射器收同一 payload；单发射器失败不影响其余）         | ✅                          | fanout.rs:816-858 `dual_emitters_receive_same_payload` + 发射器失败隔离用例（:842）；`8479204c`/`e15094f8`                                                                                                                                                                                                                                                                                                                                                                    |
| R1-02    | /v1/info 可达；无令牌 401；配对状态机全路径单测绿                            | ✅                          | mod.rs:403 `serve_info_endpoint_then_graceful_shutdown`（真实监听+HTTP 往返）；router.rs:135-159 protected 鉴权组；auth.rs 13 测试；pair.rs 11 测试（生成→等待→成功/TTL 过期/失败锁定/重复拒绝）                                                                                                                                                                                                                                                                              |
| R1-03/04 | server_integration 全绿（L2 集成：路由/鉴权/游标/踢出契约类不 ignore）       | ✅                          | tests/server_integration.rs **11/11 全绿**（`bed1924f`）：:412 pair-over-REST 签发可用令牌、:453 订阅广播推送、:477 重放先实时后、:530 断线续传 lastSeq+1、:592 Delta 洪泛 message-end 必达、:657 心跳、:679 心跳超时踢半开、:709 第 9 连接拒绝、:744 撤销 ≤1s 壁钟、:787 撤销令牌重连 401、:813 撤销全部踢所有连接——D2 §13.1 L2 六类 WS 用例全数覆盖                                                                                                                         |
| R1-05    | WS 集成测试：重放先实时后、断线续传从 lastSeq+1、Delta 丢帧 message-end 必达 | ✅                          | 上表 :477/:530/:592（三个锚点逐一对应）；ws.rs 41 测试（subscribe/subscribeAll/resume/heartbeat/kick/上限/踢旧）                                                                                                                                                                                                                                                                                                                                                              |
| R1-06    | TLS 检查清单 TLS-01~10 逐项过（仅 AEAD 套件、禁 ws 降级、指纹校验）          | ✅                          | multi_device/tls.rs 11 测试（ECDSA P-256/0600 权限/仅 AEAD 套件/SPKI 指纹/CA 轮换）；mod.rs:1044 `tls_server_rejects_plaintext_ws_handshake`、:1100 `wss_upgrade_succeeds_with_pinned_ca_and_wrong_ca_fails`、:1141 `tls_serves_rest_info_over_https_only`                                                                                                                                                                                                                    |
| R1-07    | manifest 95→99 同步；配对码/撤销/重放攻击单测绿                              | ✅                          | `4990d870`（manifest 95→99 双端）；pair.rs:368 失败计数+锁定+销毁（重放/暴力路径）；pairing.rs:244/276 撤销全链；manifest 现 104 条（`b867fc28`/`328a170c` 追加）                                                                                                                                                                                                                                                                                                             |
| R1-08    | 桌面 UI：配对模式开关 → 二维码出现 → 设备列表/撤销操作闭环                   | ✅                          | SettingsDevicesTab.tsx:105-131（配对开关→pairStart/pairCancel）、:376-425（QR/CXN 码/复制/关闭配对）、:427-509（设备列表/改名/撤销）、:511-532（撤销确认 + 关闭配对确认弹窗）；a0300e97（7 测试）+ 84658217（16 测试）                                                                                                                                                                                                                                                        |
| R1-09    | 睡眠唤醒重绑端口测试；第二实例提示；公用网络引导文案                         | ✅                          | system_power.rs:260-333（lan 态 rebind(true)+kick、loopback 不恢复、踢出原因非 revoked 契约）；main.rs:506 single_instance 插件（第二实例退出+前置提示）；pairing.rs:443 firewall_hint + multi_device_network.rs（公用/专用/域四态 + usable_ips + AP 隔离引导文案，UI 卡片 SettingsDevicesTab.tsx:317-374）；**G-9 审批超时权威语义**已入库（session-loop approval.rs:156 决策记为 approval-resolved(expired) + tool_events.rs:10 文档头，git status 无 approval 相关未提交） |
| R1-10    | 安全测试面 T-01~T-14 场景自动化部分全绿；红线与降级语义进快层                | ✅                          | `f3c140a2`（66 新测试，753 绿：T-01/T-02/T-05/T-07/T-08/T-10/T-11/T-14 自动化）+ `b867fc28`（14 测试：G-4/G-5 语义）+ redact_log_scan.rs（T-06/T-09）+ server_integration（T-11/T-12 集成级）；详见维度二 T 表                                                                                                                                                                                                                                                                |
| R1-11    | L4 清单 1-9 手测全过 + D5 红线 1-7 + Windows 真实局域网真机联调记录          | ⚠️ 代码面就绪、手测面未执行 | 代码面九项 L4 全部就绪（见维度二 §2 表）；**剩余**：① `/v1/pair` IP 限速（D2:1126 10 次/分钟）未实现（唯一确认的代码缺口）；② 真机局域网联调未执行（手测项，依赖验收人）；③ 验收记录文档未产出                                                                                                                                                                                                                                                                                |

### 1.1 正确性结论

R1-01~~R1-10 的验收锚点**全部有对应实现与测试**，无缺失锚点。R1-11 的代码面缺口仅剩 `/v1/pair` 限速一项；其余为执行类（真机手测）与文档类（验收记录）滞后。**R1-11-acceptance-check.md 中 §1.3 事实 1-4、§2 L4-3~~8、§3 红线 1/5/7 等「阻塞/未实现」判定均已过时**——详见维度六滞后清单。

---

## 2. 维度二：安全（D5 红线 1-7 + T-01~T-14）

### 2.1 红线 1-7 现状核对（D5 §10.3，:1316-1324）

| 红线                                                                | 判定                                                | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `multi_device.enabled=false` 时无任何端口监听                    | ✅ 已实现                                           | config.rs:61 `multi_device_enabled`（默认 false，:88）；main.rs:990 restart_server 门控（false → 不 bind 直接返回）；main.rs:1239-1262 开关状态机测试（enabled=false 无监听 / true 绑定）；pair 入口路由层镜像 503（pair_endpoint.rs:57-63）                                                                                                                                                                                                                                                                                                |
| 2. 远程 run 无法获得 full-access（装配断言 + 审计断言）             | ✅ 服务端面已实现                                   | core_backend.rs:105-114 `apply_remote_mode`（FullAccess → Ask + 降级标记）；core_backend.rs:179-187 `emit_remote_mode_downgrade_audit`（SecurityAuditOperation::RemoteModeDowngrade 事件发射）；测试 core_backend.rs:757 `t08_apply_remote_mode_clamps_full_access_to_ask` + b867fc28「redline-2 downgrade audit assert」；端到端远程 run 面属 R2                                                                                                                                                                                           |
| 3. 红线命令经远程通道一律 Deny（复用现有红线单测矩阵跑远程变体）    | ✅ 矩阵已实现                                       | permission.rs:428 `RemoteChannel`（remote_source 类型）；permission.rs:475 `redline_remote_source_denied_in_all_modes_without_approval`、:503 `decide_command_remote_source_redline_denied_in_all_modes`、:536 `remote_source_non_redline_follows_mode_matrix`（f3c140a2）；端到端远程执行链属 R2（无远程 run 装配）                                                                                                                                                                                                                        |
| 4. 日志扫描测试（T-06）零明文命中                                   | ⚠️ 存储与测试面已固化，运行期接线不全               | redact.rs（redact_token/redact_pair_code/redact_provider_key/redact_text/scan_sensitive，16 测试）+ redact_log_scan.rs（3 测试：T-06 日志扫描 + T-09 事件流快照 sk- 扫描）**已入库**；auth.rs:410 `persisted_file_never_contains_raw_token`（pairing.json 只存 SHA-256）；**运行期接线仅 ws.rs:568 一处（标签兜底）**，审计面/配对面日志未全量接 redact_text                                                                                                                                                                                |
| 5. `config_secret_*` 远程来源 100% Forbidden（白名单 + 命令级双层） | ⚠️ 第一、三层已实现，第二层缺                       | **第一层（白名单）✅**：remote_whitelist.rs:63-101（M6 C01-C32 冻结 32 条）+ router.rs:120-133 `ensure_command_execution_allowed`（runTask/runControl/cancelRun 守卫）+ router.rs:96-106 `SECRET_COMMAND_SURFACE` + :581-589 `handle_not_found` 403 兜底 + b867fc28「config_secret forbidden e2e」；**第三层（审计）✅**：core_backend.rs:227-255 remote-source-attempt 事件发射；**第二层（命令级 remote_source 判定）❌**：config/credentials.rs 无 remote_source 来源判定（无白名单第二层兜底）                                          |
| 6. 撤销设备 ≤1s 内断开全部活动连接（集成测试断言）                  | ✅ 已实现                                           | pairing.rs:249-284 revoke_device/revoke_all → ws.rs:348 `kick_by_token_hash`；server_integration.rs:744 `integration_revoke_device_kicks_within_1s_wall_clock`（**≤1s 壁钟断言**，bed1924f 11/11 绿）+ :813 revoke-all 全踢                                                                                                                                                                                                                                                                                                                 |
| 7. 全部远程动作产生 `remote-*` 审计且打码                           | ⚠️ 事件面与注册表已同步，运行期发射面与前端标签待补 | **事件变体 ✅**：events.rs:83-98 SecurityAuditOperation 新增 remote-source-attempt / remote-mode-downgrade / remote-only 三变体；**注册表同步 ✅**：engine-events.json:3269-3271 三值登记 + registry_drift.rs:496 `check_enum!(…, 9)` + events_schema_version.rs:466-468 + shared-types generated/types.ts:62 同步；**打码 ✅**：redact 入库。**缺**：① 运行期 remote-* 审计发射面仅 core_backend/router 两处（远程 run/审批端到端属 R2）；② 前端 securityAuditStore.ts:72-79 OPERATION_LABELS 无 remote-* 中文标签（原样显示英文 wire 名） |

### 2.2 T-01~T-14 场景核对（Z0 §9.3 R1-10 出口 / D5 §9）

| 编号 | 场景                              | 判定                         | 证据 / 缺口                                                                                                                                                                                                                                                                                                     |
| ---- | --------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-01 | 伪造端：无令牌直连                | ⚠️ 部分                      | auth.rs:86/179-187 auth_failures 计数 + middleware（f3c140a2）；「IP 锁定 15 分钟」按 D-4 裁决归 limiter（未装配，见 §3）                                                                                                                                                                                       |
| T-02 | 令牌重放/同令牌并发               | ⚠️ 部分                      | ws.rs:2247 `duplicate_connection_kicks_old`、:2428 `registry_duplicate_token_kicks_old`（P0-3 踢旧语义）；「会话密钥 8h 过期」属 R2 会话层未实现                                                                                                                                                                |
| T-03 | 中间人：ARP+伪造证书（pinning）   | ✅ 服务端面                  | mod.rs:1100 正确 CA 成功/错误 CA 拒绝（指纹断言）；真机 pinning 消费属 R2 客户端侧                                                                                                                                                                                                                              |
| T-04 | 强制降级 ws://                    | ✅ 已实现                    | main.rs:1008 服务开启即 `tls_enabled=true`（wss-only）；mod.rs:1044 明文握手拒绝 + :1141 https-only                                                                                                                                                                                                             |
| T-05 | 配对码暴力（5 次锁定）            | ✅ 已实现                    | pair.rs:368 `verify_wrong_code_counts_attempts_and_locks` + f3c140a2 Destroyed 语义（达上限销毁会话，冷却后正确码也拒）                                                                                                                                                                                         |
| T-06 | 令牌窃取：日志泄露（grep 扫描）   | ⚠️ 部分                      | redact_log_scan.rs 已入库（T-06 断言零明文）；运行期接线不全（红线 4 同缺口）                                                                                                                                                                                                                                   |
| T-07 | 远程调 config_secret_reveal       | ⚠️ 大部分已实现              | 403 e2e（b867fc28）+ SECRET_COMMAND_SURFACE 兜底（router.rs:96-106/581-589）+ remote-source-attempt 审计；第二层命令级 remote_source 缺失（红线 5 同缺口）                                                                                                                                                      |
| T-08 | 远程指定 full-access              | ✅ 已实现                    | apply_remote_mode 截断（core_backend.rs:109）+ 降级审计断言（b867fc28）                                                                                                                                                                                                                                         |
| T-09 | 密钥不出桌面（事件流无 sk- 形态） | ✅ 已实现                    | redact_log_scan.rs:93-119 事件流 JSON 快照 sk-/CXN-/令牌形态扫描断言（scan_sensitive）                                                                                                                                                                                                                          |
| T-10 | 审批伪造（不存在 tool_call_id）   | ✅ 已实现                    | approve_tool_impl resolve NotFound（core_run_commands.rs:230-245）；R0-07 件 2 断言                                                                                                                                                                                                                             |
| T-11 | 撤销即时性（撤销后旧令牌重连）    | ✅ 已实现                    | ws.rs:2298 `kick_by_token_hash_revokes_connection` + auth.rs Revoked→401 + server_integration.rs:787 `integration_revoked_token_rejected_on_reconnect`                                                                                                                                                          |
| T-12 | DoS 连接洪水（超限拒绝+审计）     | ⚠️ 部分                      | 总量 8：ws.rs:75 `MAX_WS_CONNECTIONS=8` + :2269 单测 + server_integration.rs:709 集成；**每设备 2 未接线**（D-1 裁决：维持 P0-3 踢旧，limiter 每设备参数保留待 R2 装配，limiter.rs:8-26）；限流器审计计数未接 events 面                                                                                         |
| T-13 | 慢速/超长帧                       | ⚠️ 部分                      | 帧 1 MiB：gateway.rs:40 `validate_frame_size`（ws.rs:871 消费单一事实源）+ ws.rs:2349 `frame_too_large_closes_connection`；读超时：gateway.rs:53 `read_timeout_exceeded`（ws.rs:797 以 HEARTBEAT_TIMEOUT_MS 90s 消费）——**10s 空闲读超时按 D-2 裁决不接断链**（与 30s Ping 节奏冲突，保留纯函数待 R4 P2P 链路） |
| T-14 | 双轨确认（桌面在场+移动端批准）   | ⚠️ 纯函数已实现，端到端属 R2 | core_backend.rs:202-218 `RemoteApprovalRoute`（Dual/RemoteOnly）+ `route_remote_approval` 纯函数 + :785-798 测试 + :949 `t14_remote_only_emits_security_audit_event`（remote-only 标记事件）；R2 移动端审批中心才承接双端确认（Z0 C-3 裁决）                                                                    |

### 2.2 安全结论

D5 红线 1-7 中 **红线 1/2/3/6 已实现**；红线 4/5/7 为核心已落地、边缘未全量（运行期打码接线面、第二层命令级判定、前端标签）。T-01~T-14 中 **T-03/04/05/08/09/10/11 已实现**，T-01/02/06/12/13/14 部分（缺口均有明确归属：R2 会话层 / D-1/D-2/D-4 裁决 / 运行期接线）。**新增确认缺口：`/v1/pair` IP 限速（D2:1126）全链路无实现**（见问题 #1）。

---

## 3. 维度三：性能（关键路径代码面评估）

| 路径             | 现状                                                                                                                                                                                                                               | 评估                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 事件扇出（emit） | fanout.rs:136-173 每连接缓冲队列容量 `CONN_QUEUE_CAPACITY`（默认 512）；:273-330 按背压分级入队（Critical 必达/Soft 尽力/Delta 可丢）+ 驱逐最旧可丢帧 + 无可腾位时 Critical 防御性超限接收；`dropped_total` 全局可观测（:220-224） | ✅ 架构良好：分级丢帧 + 端级背压 + 丢帧可观测（S-8 哲学），与 buffer.rs 先例同构 |
| WS 推送          | ws.rs:42 每连接 drain task + watch 通道切换；:81 `RESUME_PENDING_CAPACITY=256` 重放期间 pending 上限（超限丢 Delta 保 Critical）；resume 期间实时事件入 pending、resume.done 后 flush（ws.rs:277-320）                             | ✅ 重放与实时互不阻塞；pending 有界                                              |
| 游标分页         | router.rs:619 `max_events.clamp(1, PAGE_SIZE_MAX)`（与 core_query_commands::normalize_max_events 同语义）；EVENT_WINDOW/PAGE_SIZE_DEFAULT/PAGE_SIZE_MAX 来自 conex-types device 常量                                               | ✅ 越界夹紧，O(1) 语义，无全表扫描风险                                           |
| 限流             | WS 总量 8（MAX_WS_CONNECTIONS）；limiter 每设备 2 未接线（D-1）；**`/v1/pair` 无限速**                                                                                                                                             | ⚠️ 唯一性能/安全实质缺口（见下）                                                 |
| 心跳             | 30s Ping / 90s 超时（D2 §10.2 契约）；read_timeout 纯函数（gateway.rs:53）                                                                                                                                                         | ✅ 节奏合理，半开检测有界                                                        |

### 3.1 性能风险点（按严重度）

1. **`/v1/pair` 免鉴权端点无任何请求限速**（pair_endpoint.rs 全文件无速率状态）——D2:1126 明确要求「按连接源 IP 限速（10 次/分钟）」。现实影响：配对码 60bit + 单码 5 次锁定 + TLS 缓解了暴力面，但该端点在局域网/公网暴露时可被无限次请求（CPU/日志/锁定状态机抖动），且 5 次失败即销毁码意味着攻击者可借无限制失败快速销毁配对会话（DoS 面）。**建议：pair_endpoint.rs 增加按来源 IP 的滑动窗口计数（10 次/分钟），复用 limiter 或独立小状态机；R1-11 验收前补齐。**
2. fanout emit 对每个订阅者做信封 JSON 扁平化解析（O(订阅者)）——上限 8 连接下开销可忽略；R2 若放开连接数需评估批量序列化。
3. pair.hello 处理在 WS 消息循环内同步执行 complete_pairing（pairing.json 原子写 IO）——低频单次，当前可忽略；R2 多设备并发配对时建议 spawn_blocking。
4. kick_all_ws（唤醒恢复）为 O(n) 信号广播——n ≤ 8，可忽略。

---

## 4. 维度四：体验（桌面端配对/设备管理操作流）

### 4.1 SettingsDevicesTab 闭环核对（服务开关→配对→二维码→设备管理→撤销→关闭配对确认）

| 步骤                         | 实现                                                                                                           | 证据                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| ① 服务开关（默认关闭）       | 服务关闭态展示引导卡 + 「开启服务」按钮；开启后展示配对开关与「关闭服务」按钮                                  | SettingsDevicesTab.tsx:235-314；multi_device_set_enabled → main.rs restart_server 门控（红线 1）              |
| ② 配对开关 → pairStart       | 开启配对生成 CXN 码 + QR + 防火墙提示；服务未开启时 Rust 侧 fail-closed 拒绝（multi_device_commands.rs:27-32） | :105-131；multiDevice.ts:49-57 三态封装不抛异常                                                               |
| ③ 二维码/CXN 码展示          | QRCodeSVG 渲染 + 码文本 + 剩余时间/失败次数 + 复制按钮 + 关闭配对按钮 + 防火墙提示                             | :376-425                                                                                                      |
| ④ 网络环境卡片（配对开启时） | 网络配置文件四态 + 公用网络切专用提示 + 可直连 IP 列表 + AP 隔离手动输 IP 引导                                 | :317-374；multi_device_network.rs                                                                             |
| ⑤ 设备列表/改名/撤销         | 列表展示（标签/哈希截断/签发时间/已撤销标记）+ 改名行内编辑 + 撤销按钮                                         | :427-509                                                                                                      |
| ⑥ 撤销确认                   | ConfirmDialog（danger）：「撤销后该设备将立即断开，令牌失效」                                                  | :511-519                                                                                                      |
| ⑦ 关闭配对确认               | ConfirmDialog（danger）：「撤销全部已配对设备并断开连接（令牌全部失效）」——G-4b 语义（84658217，16 测试）      | :521-532 → handleToggle(false) → multi_device_pair_cancel → cancel_pairing → revoke_all（pairing.rs:240-241） |

### 4.2 断点/不一致发现

1. **服务开关无查询命令（轻微）**：Rust 侧 `pair_status` 不含 enabled 字段，UI 以本地状态跟踪（SettingsDevicesTab.tsx:75-78 注释自述）。会话内若服务侧异常（bind 失败/重绑失败/诊断降级），UI 无法如实反映；应用重启后恒显示关闭（与服务默认关闭语义一致，无错）。**建议 R2-12 设备域补 `multi_device_get_enabled` 或 pair_status 增 enabled 字段。**
2. 关闭服务后配对码/QR 清空、配对态开关隐藏——与「服务关闭即零监听」语义一致，无断点。
3. busy 防抖覆盖全部按钮；API 层三态封装（multiDevice.ts:46-152 全部 catch 返回 null/false）——UI 无未处理拒绝路径。
4. 关闭配对 vs 关闭服务语义区分清晰：关闭配对=撤销全部令牌（重开需重新配对）；关闭服务=保留令牌（重开可直接重连）——文案均已明示（:290/:525），无双关歧义。

### 4.3 体验结论

操作闭环**无断点、无不一致**。唯一建议项是 enabled 状态查询命令（R2），不阻塞 R1 验收。

---

## 5. 维度五：结构干净（模块边界/重复/死代码/注释一致性/打补丁检查）

### 5.1 模块边界

- server/ 15 模块职责单一（config/auth/pair/pairing/pair_endpoint/backend/core_backend/error/fanout/gateway/limiter/remote_whitelist/router/ws/mod）；mod.rs:26-29 自述「除 fanout 外零 crate:: 内部引用」——router 测试经 tower oneshot 驱动，无 Tauri 依赖，测试性架构达标。
- main.rs 装配面与 server 模块解耦：MultiDeviceService 生命周期槽（main.rs:887-919）统一管理重绑/开关/退出三路径，单一重建路径 restart_server（:973-1055）——设计干净。

### 5.2 重复代码

- pair_endpoint.rs:205-210 自有 error_response 与 server/error.rs 风格近似——因配对入口需 401/409 映射、与既有 403 语义不同，模块头已文档化（pair_endpoint.rs:8-10, 203-204）。可接受，但建议后续合并为参数化工厂，降低两处口径漂移风险。

### 5.3 死代码与注释-实现一致性

| 项                                                      | 状态                                             | 说明                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| limiter.rs 生产路径                                     | ⚠️ 全 `#[cfg_attr(not(test), allow(dead_code))]` | D-1 裁决「每设备参数保留不接线，R2 装配」——**裁决已下，代码注释仍写「接线待主 Agent 裁决」（limiter.rs:23-26, 39-40），注释滞后于裁决**，阅读者会误以为未决                          |
| gateway.rs READ_TIMEOUT_MS / idle_read_timeout_exceeded | ⚠️ dead_code（注释标 R4 P2P 复用）               | 同 D-2 裁决（保持 D2 契约 30s/90s）；注释明确未来归属，可接受                                                                                                                        |
| mod.rs ServerHandle::config / ServerState.conn_limiter  | ⚠️ 生产无消费者                                  | conn_limiter 仅构造+访问器（mod.rs:373/402/496-497），ws.rs 未消费——与 D-1 裁决一致，但建议在 mod.rs 加「R2 装配预留」注释                                                           |
| f3c140a2 提交信息                                       | ⚠️ 与现状不符                                    | 提交信息称「gateway/limiter wiring in ws.rs」——实际 gateway 已接线、**limiter 未接线**（ws.rs 无 conn_limiter 消费）。误导性陈述，建议在文档（验收文档或本报告）澄清，不回改提交历史 |

### 5.4 「严禁打补丁」违例检查

- 未发现坐标魔法/遍历猜测/临时兼容代码。实例：`0.0.0.0` 过滤（pairing.rs:345 链路本地/回环过滤、f3c140a2 pick_recommended_ip 0.0.0.0 修复）为正确性修复；`set_port` 注入保证二维码内嵌端口与实际监听同源（main.rs:1020 + main.rs:1201-1210 测试断言）——原生注入路径，O(1) 精确，无魔术补偿。
- 唯一「待办沉淀」模式：limiter/gateway 以 allow(dead_code) 保留 + 注释自述归属——属于**裁决驱动的显式预留**而非遗留垃圾，符合「效果完整度优先 + 诚实标注」纪律；仅注释文本需随裁决同步（见 §5.3）。

### 5.5 结构结论

整体干净，无违例补丁。**两类结构性小债**：① 裁决 D-1/D-2 已下但 limiter.rs/gateway.rs 注释未同步（文档-代码一致性）；② pair_endpoint 错误响应工厂与 error.rs 有合并空间（低优先）。

---

## 6. 维度六：契约一致（manifest/命令注册/事件注册表/验收文档）

### 6.1 manifest 双端 + 命令注册面

| 面            | 证据                                                                                                                     | 判定 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ---- |
| Rust manifest | command_manifest.rs:100-110：8 条 multi_device_* 全部 `registered=true`（含 multi_device_set_enabled 追加注释 :251-252） | ✅   |
| Rust 注册面   | main.rs:189-199 invoke handler 8 条 = manifest；main.rs:1066 `registration_surface_matches_manifest` 测试守卫            | ✅   |
| 前端 manifest | commandManifest.ts:89-97（multi_device_pair_cancel/network_info/set_enabled 等）                                         | ✅   |
| 前端 API 面   | api/multiDevice.ts 8 函数全封装（三态路由）                                                                              | ✅   |
| 契约漂移门禁  | command-contract-drift.test.ts / commandManifest.test.ts:134-136（isRegisteredCommand 断言 network_info/set_enabled）    | ✅   |

### 6.2 device-protocol / engine-events 注册表 vs 代码

| 项                          | 证据                                                                                                                                                                                                                                                                              | 判定                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| SecurityAuditOperation 变体 | events.rs:66-99 9 变体（含 remote-source-attempt/remote-mode-downgrade/remote-only）== engine-events.json:3269-3271 == registry_drift.rs:496 `check_enum!(…,9)` == events_schema_version.rs:466-468 == shared-types generated types.ts:62（SECURITY_AUDIT_OPERATION_VALUES 9 值） | ✅ 全链同步                                                                 |
| PairHello 消息              | device-protocol.json:845-877（pair.hello 字段 code/deviceId/mobilePub/mobileLongPub/deviceName/platform）== conex-types device/pair.rs PairHello 结构 == pair_endpoint.rs 消费（:157-172）                                                                                        | ✅                                                                          |
| pair.ok token 扩展字段      | device-protocol.json PairOk 未登记 token 字段（pair_endpoint.rs:19-22 自述：Rust/TS 解析器对未知字段宽松，不破坏 R0-05 对拍）                                                                                                                                                     | ⚠️ 已文档化的协议扩展，建议 R2 正式登记（防对拍工具严格化时漂移）           |
| pair 消息链（简化链）       | WS pair.hello → pair.ok + device.ready（ws.rs:951-1002）；D3 §4.8 的 challenge/verify 密钥交换链未实现（pair_endpoint.rs:11-17 自述：X25519+HKDF 属 R1-07 未实现范围，mock 亦不验签）                                                                                             | ⚠️ 契约收敛决策已文档化；R2 移动端联调前需确认简化链是否可接受（见问题 #9） |

### 6.3 R1-11-acceptance-check.md 与代码现状的一致性（文档质量维度）

**主发现：验收文档 v1.2（2026-08-11）滞后于 2026-08-12 的 closeout 提交链**。§1.3 事实 1-4、§2 L4 表、§3 红线表、§4 T 表、§5 缺口清单、§9 汇总共约 **22 处判定过时**（详见维度七滞后项清单）。这是当前 R1 验收的最大流程风险：验收人照表操作会把已解决项判为阻塞。

---

## 7. R1-11-acceptance-check.md 滞后项清单（逐条：文档位置 → 代码现状 → 应改为）

> 本清单供 R1-11 验收文档 v1.3 修订直接使用；**本审计不改动该文档**。

| #   | 文档位置（v1.2）                  | 文档当前判定                                                    | 代码现状（2026-08-12）                                                                                                                                                              | 应改为                                                                                                                              |
| --- | --------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §1.1 提交链表                     | 止于 a0300e97                                                   | 08-11 晚至 08-12 追加 6 个 R1 提交：328a170c / f3c140a2 / b867fc28 / 84658217 / 16f2f55f / bed1924f                                                                                 | 追加 6 行（内容见 §0.1）                                                                                                            |
| 2   | §1.2 工作区未提交清单（七组文件） | 全部「未提交」                                                  | 全部已入库：main.rs 装配、multi_device_commands/network、system_power、limiter、gateway、redact+redact_log_scan、session-loop G-9（approval.rs/tool_events.rs 等已提交）            | 改为「已全部提交（b867fc28/f3c140a2 等）」；工作区残留 session-loop 3 文件为**并行 summarizer 域**（E2 F1 L1 摘要压缩），与 R1 无关 |
| 3   | §1.3 事实 1                       | router(None)——后端未注入，运行期 500                            | main.rs:750-754 CoreStateBackend 注入；mod.rs:244-261 router(backend, fanout, audit_bridge, pairing) 四参签名；main.rs:1025-1032 生产装配传真实后端                                 | 改为「已注入：/v1/status 等后端端点运行期 200」                                                                                     |
| 4   | §1.3 事实 2                       | FanOutEmitter 未装配，event_stream=None                         | main.rs:755-756 attach_fanout + mod.rs:253 set_event_stream 注入                                                                                                                    | 改为「已装配：引擎事件自动双通道（webview + WS 广播）」                                                                             |
| 5   | §1.3 事实 3                       | 配对模式重绑未装配（已提交基线）                                | main.rs:783-810 rebind_hook 构造 + pairing.set_rebind_hook + :1020 set_port 注入（二维码内嵌端口同源）                                                                              | 改为「已装配：配对开启 0.0.0.0 重绑 + 实际端口注入」                                                                                |
| 6   | §1.3 事实 4                       | 服务恒启动，无开关                                              | config.rs:61 multi_device_enabled（默认 false）+ main.rs:990 restart_server 门控 + 红线 1 测试 main.rs:1239-1262                                                                    | 改为「已解决：默认关闭零监听；开关命令 multi_device_set_enabled」                                                                   |
| 7   | §2 L4-3                           | ⚠️ 部分（缺 POST /v1/pair 路由、WS 消息链、0.0.0.0 重绑、限速） | router.rs:178 免鉴权挂载 POST /v1/pair + ws.rs:951-1002 pair.hello→pair.ok+device.ready 全链 + 重绑已装配 + 测试（router.rs:2923/2952、ws.rs:2702-2806、server_integration.rs:413） | 改为「✅ 代码面已实现」；**保留缺口标注：/v1/pair IP 限速（D2:1126）未实现**                                                        |
| 8   | §2 L4-4                           | ⚠️ 部分（fanout 未装配/后端未注入）                             | 装配全部落地（L4-3 同证据）+ server_integration.rs:453 订阅广播集成测试                                                                                                             | 改为「✅ 代码面已实现；需真机手测验证推送链路」                                                                                     |
| 9   | §2 L4-5                           | ⚠️ 部分（后端未注入运行期 500）                                 | main.rs:750 后端注入；approve/deny 路由 core_backend.rs（I-02 pending 校验）                                                                                                        | 改为「✅ 代码面已实现；手机端 approve 需替代客户端/真机（R2）」                                                                     |
| 10  | §2 L4-6/7                         | ⚠️ 部分（装配缺）                                               | resume 契约集成测试全绿（server_integration.rs:477/530）+ 装配完成 + 令牌持久化（auth.rs:462）                                                                                      | 改为「✅ 代码面已实现；真机断网重连续传手测项」                                                                                     |
| 11  | §2 L4-8                           | ⚠️ 部分（关闭配对不清令牌不踢连接）                             | pairing.rs:240-241 cancel_pairing → revoke_all（清全部令牌+踢 WS）+ UI 确认弹窗（84658217）+ server_integration.rs:813 集成断言                                                     | 改为「✅ 已实现（D2 §5.4 关闭动作语义）」，缺口 G-4 移除                                                                            |
| 12  | §3 红线 1                         | ❌ 未实现（无开关）                                             | 见滞后 #6                                                                                                                                                                           | 改为「✅ 已实现（enabled=false 零监听，netstat 断言可执行）」                                                                       |
| 13  | §3 红线 2                         | ⚠️ 部分（无 min(mode,ask) 截断与降级审计）                      | core_backend.rs:105-114 apply_remote_mode + :179-187 降级审计 + 断言测试（b867fc28）                                                                                                | 改为「✅ 服务端面已实现；端到端远程 run 属 R2」                                                                                     |
| 14  | §3 红线 3                         | ⚠️ 部分（远程变体矩阵缺失）                                     | permission.rs:475/503/536 RemoteChannel 远程变体三测试                                                                                                                              | 改为「✅ 远程变体矩阵已实现」                                                                                                       |
| 15  | §3 红线 4                         | ⚠️ 部分（redact 未入库、接线不全）                              | redact.rs + redact_log_scan.rs 已入库；运行期接线仅 ws.rs:568 一处不变                                                                                                              | 改为「✅ 存储+测试面已固化；⚠️ 运行期接线不全保留」                                                                                 |
| 16  | §3 红线 5                         | ❌ 未实现（无白名单/remote_source 双层）                        | 白名单 32 条 + SECRET_COMMAND_SURFACE 403 + remote-source-attempt 审计已实现；**命令级 remote_source 第二层仍缺**                                                                   | 改为「⚠️ 第一、三层已实现（403 e2e 绿）；第二层命令级判定缺（R2 补）」                                                              |
| 17  | §3 红线 6                         | ⚠️ 部分（无 ≤1s 集成测试）                                      | server_integration.rs:744 ≤1s 壁钟断言（bed1924f 11/11 绿）                                                                                                                         | 改为「✅ 已实现（集成测试断言）」                                                                                                   |
| 18  | §3 红线 7                         | ❌ 未实现（无 remote-* 变体、无网关审计）                       | events.rs:83-98 三变体 + 注册表全链同步 + 打码入库；运行期发射面仅 core_backend/router 两处                                                                                         | 改为「⚠️ 事件面+注册表已实现；运行期发射面与前端标签待补（R2）」                                                                    |
| 19  | §4 T-01                           | ❌ 未实现                                                       | auth_failures 计数 + middleware（f3c140a2）                                                                                                                                         | 改为「⚠️ 部分（计数已实现；IP 锁定按 D-4 归 limiter 未装配）」                                                                      |
| 20  | §4 T-07                           | ❌ 未实现                                                       | 403 e2e + 审计发射（b867fc28）                                                                                                                                                      | 改为「⚠️ 大部分已实现（第二层命令级 remote_source 缺）」                                                                            |
| 21  | §4 T-08                           | ❌ 未实现                                                       | clamp + 降级审计断言（b867fc28）                                                                                                                                                    | 改为「✅ 已实现」                                                                                                                   |
| 22  | §4 T-09                           | ❌ 未实现                                                       | redact_log_scan.rs:93-119 sk- 快照扫描测试                                                                                                                                          | 改为「✅ 已实现」                                                                                                                   |
| 23  | §4 T-14                           | ❌ 未实现                                                       | core_backend.rs:202-218 双轨纯函数 + 测试（:785-798/:949）                                                                                                                          | 改为「⚠️ 纯函数已实现；端到端双端确认属 R2」                                                                                        |
| 24  | §4 T-12/T-13 备注                 | 「register 接线待裁决」「10s 冲突未决」                         | 裁决 D-1/D-2 已下（§10 表已记录）且代码注释未同步（§5.3）                                                                                                                           | 备注更新为「已裁决：D-1 每设备参数不接线待 R2；D-2 保持 30s/90s 契约」                                                              |
| 25  | §5 缺口表 G-1/G-2/G-4/G-6/G-7/G-8 | 阻塞/高/中（未解决）                                            | G-1/G-2/G-4/G-6/G-7 已解决；G-8 已提交；G-5 部分解决；G-9 已实现                                                                                                                    | 缺口表大幅收敛：仅剩 ① /v1/pair 限速（新缺口）、② 红线 5 第二层、③ 真机手测执行项；G-3 维持已解决                                   |
| 26  | §9 判定汇总表                     | L4-3~8 ⚠️ / 红线 1/5/7 ❌ / T-07/08/09/14 ❌                    | 见 #7-23                                                                                                                                                                            | 逐项同步为最新判定（同表）                                                                                                          |
| 27  | §8 验收执行顺序                   | 步骤 3「缺口修复」列 G-1/G-2/G-4/G-6                            | 均已落地                                                                                                                                                                            | 顺序调整为：① 补 /v1/pair 限速（唯一代码缺口）② 自动化门禁 ③ 真机联调 ④ 验收记录                                                    |

---

## 8. 问题清单（按严重度排序，含位置与修复建议）

| #   | 严重度     | 问题                                                                                                                                                               | 位置                                                               | 修复建议                                                                                                                |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | **高**     | `/v1/pair` IP 限速缺失（D2:1126「10 次/分钟」全链路无实现）——免鉴权端点在 LAN 暴露时可无限请求，5 次失败销毁码 + 无请求限速 = 可被攻击者快速销毁配对会话（DoS 面） | pair_endpoint.rs（全文件无速率状态）；router.rs:178 挂载点         | 按来源 IP 加滑动窗口限速（10 次/分钟，超限 429 + 可选审计）；可复用 limiter.rs 状态机模式或独立小实现；R1-11 验收前补齐 |
| 2   | 高（流程） | R1-11-acceptance-check.md v1.2 全面滞后（22+ 处判定过时）——验收人照表操作会把已解决项判阻塞，验收基线失真                                                          | docs/multi-device/R1-11-acceptance-check.md §1.3/§2/§3/§4/§5/§8/§9 | 按 §7 滞后清单发布 v1.3（本审计不改动该文档，由主控安排修订轮）                                                         |
| 3   | 中         | 红线 5 第二层（命令级 remote_source 判定）缺失——纵深防御少一层；当前仅白名单第一层 + 审计第三层                                                                    | config/credentials.rs（无 remote_source 来源判定）                 | R2-07/08 M6 命令批装配时，在 config_secret_* 命令入口增加 remote_source 来源判定（与 D5 §8.2 对齐）                     |
| 4   | 中         | 前端 remote-* 审计操作无中文标签——remote-source-attempt / remote-mode-downgrade / remote-only 事件原样显示英文 wire 名                                             | securityAuditStore.ts:72-79 OPERATION_LABELS                       | 补三个中文标签（如「远程来源触达被禁面」「远程模式降级」「远程单一确认」），约几分钟工作量                              |
| 5   | 低         | limiter.rs / gateway.rs 注释「接线待裁决」过期——裁决 D-1/D-2 已下（R1-11-acceptance-check.md §10），代码注释未同步                                                 | limiter.rs:23-26/39-40；gateway.rs:24-26                           | 注释改为「裁决 D-1/D-2：当前不接线，R2/R4 装配时启用」，随下次 R1 收尾提交                                              |
| 6   | 低         | 服务开关无查询命令——UI 本地跟踪 enabled 状态，服务侧异常/降级无法反映                                                                                              | SettingsDevicesTab.tsx:75-78（自述）；pair_status 无 enabled 字段  | R2-12 设备域补 multi_device_get_enabled 或 pair_status 增 enabled 字段                                                  |
| 7   | 低         | pair_endpoint.rs 无模块内测试（0 test）——错误映射矩阵（503/401/409/请求体非法）仅经 router.rs/ws.rs 间接覆盖                                                       | pair_endpoint.rs（test 模块缺失）                                  | 为 handle_rest_pair 补独立单测（错误映射 503/401/409 + label 截断 + 令牌立即可用）                                      |
| 8   | 低         | f3c140a2 提交信息「gateway/limiter wiring in ws.rs」与现状不符——limiter 实际未接线                                                                                 | 提交信息（不回改历史）                                             | 在验收文档 v1.3 或本报告中澄清：gateway 已接线、limiter 按 D-1 未接线                                                   |
| 9   | 低（契约） | WS 配对简化链（hello 直接完成）替代 D3 §4.8 challenge/verify 密钥交换链——已文档化但未入注册表/ADR 评审                                                             | pair_endpoint.rs:11-17；pair_ok_body token 扩展字段（:180-186）    | R2-03 移动端配对流程开工前，主控评审简化链与 token 扩展字段的正式登记（device-protocol.json PairOk）                    |

---

## 9. R1 完成度总判定

**R1（桌面多端互通服务端）代码完成度约 95%，可进入 R1-11 验收执行阶段。**

- **R1-01~R1-09**：✅ 全部完成——九个包的验收锚点均有实现+测试证据（§1 核对表）。
- **R1-10**：✅ 自动化面完成——T-01~T-14 场景均有纯函数/单测/集成覆盖（f3c140a2 66 测试 + b867fc28 14 测试 + redact 19 测试 + 集成 11）；剩余项均归属明确（D-1/D-2/D-4 裁决预留、R2 会话层、运行期接线）。
- **R1-11**：⚠️ 待执行——代码面九项 L4 全部就绪；唯一代码缺口为 `/v1/pair` IP 限速（D2:1126）；真机局域网联调与验收记录为执行类待办。
- **流程风险**：验收文档 v1.2 滞后于 closeout 提交链（22+ 处判定过时），须先修订再执行验收（§7 清单直接可用）。

---

## 10. 给 R2 的排期建议

| 优先级                | 项                                                                        | 归属    | 建议                                                                                    |
| --------------------- | ------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| P0（R1-11 验收前）    | `/v1/pair` IP 限速 10 次/分钟                                             | R1 收尾 | 补滑动窗口限速（问题 #1），验收红线 1/3 面一并复验                                      |
| P0（验收前）          | R1-11-acceptance-check.md v1.3 修订                                       | 文档轮  | 按 §7 清单 27 条逐项修订（含 §1.1 提交链、§1.2 未提交清单、L4/红线/T 判定、缺口表收敛） |
| P1（R2-03 前）        | WS 配对简化链 + pair.ok token 扩展字段正式登记评审                        | 协议面  | 移动端配对流程开工前，主控裁决简化链是否可接受；登记 device-protocol.json PairOk.token  |
| P1（R2-07/08 命令批） | 红线 5 第二层命令级 remote_source                                         | 安全面  | config_secret_* 命令入口加 remote_source 判定（D5 §8.2 对齐）                           |
| P1（R2-12 设备域）    | multi_device_get_enabled（或 pair_status.enabled）查询命令                | 体验面  | 消除 UI 本地状态漂移；同步前端轮询消费                                                  |
| P2                    | limiter 每设备 2 装配（D-1 裁决预留）                                     | 安全面  | R2 移动端多连接场景落地时启用（同时解决 T-01 IP 锁定 15min 的 D-4 归属）                |
| P2                    | 前端 remote-* 审计中文标签                                                | 体验面  | 3 条标签，随 R2-16 验收准备顺手补                                                       |
| P2                    | pair_endpoint 独立单测 + error_response 工厂合并                          | 质量面  | 低优先，随 R1 收尾或 R2 空闲轮                                                          |
| P2                    | server_integration 扩展：配对 5 次锁定集成路径 + T-13 慢速帧集成          | 测试面  | R2-02 前补，覆盖集成级锁定与超长帧契约                                                  |
| 执行类                | Windows 真实局域网真机联调（扫码配对/审批闭环/断线续传/撤销 ≤1s/AP 隔离） | R1-11   | 与 R2-03 配对流程联调并行；验收记录文档随 v1.3 一起产出                                 |

---

## 11. 六维度判定汇总表（汇报用）

| 维度       | 总判定                                                 | 关键结论                                                      |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| 1 正确性   | ✅（R1-01~10 全过；R1-11 代码面就绪）                  | 锚点逐项有实现+测试；唯一代码缺口：/v1/pair IP 限速           |
| 2 安全     | ✅ 核心全过（红线 1/2/3/6 + T-03/04/05/08/09/10/11）   | 边缘缺口：红线 4/5/7 运行期接线与第二层、前端标签             |
| 3 性能     | ✅ 架构良好（分级丢帧/端级背压/有界 pending/游标夹紧） | 风险点：/v1/pair 无限速（并入问题 #1）；其余可忽略            |
| 4 体验     | ✅ 闭环无断点                                          | 唯一建议：enabled 查询命令（R2-12）                           |
| 5 结构干净 | ✅ 无违例补丁                                          | 小债：limiter/gateway 注释滞后于裁决；error_response 可合并   |
| 6 契约一致 | ✅ 代码链全同步（manifest/事件注册表/device-protocol） | **验收文档滞后 22+ 处**（流程主风险）；pair.ok 扩展字段未登记 |

**Top 问题（前 8）**：① /v1/pair 限速缺失（高）② 验收文档 v1.2 全面滞后（高/流程）③ 红线 5 第二层缺失（中）④ 前端 remote-* 审计无中文标签（中）⑤ limiter/gateway 注释过期（低）⑥ 服务开关无查询命令（低）⑦ pair_endpoint 无模块内测试（低）⑧ f3c140a2 提交信息与现状不符（低）。

**滞后项清单条数**：27 条（§7 表，直接用于 R1-11-acceptance-check.md v1.3 修订）。

---

_文档结束。本审计为只读分析（未修改任何源文件，含 R1-11-acceptance-check.md）；证据均取自 2026-08-12 工作区实况与提交链。_
