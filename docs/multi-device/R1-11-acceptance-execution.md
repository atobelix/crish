# R1-11 验收执行记录（服务面手测）

> 文档编号：R1-11-acceptance-execution
> 角色：R1-11 验收执行（服务面手测）
> 日期：2026-08-13
> 定位：R1-11 验收核对文档（`R1-11-acceptance-check.md` v1.3）**执行侧**——L4 清单 1-9 +
> 红线 1-7 的自动化可测部分真实执行记录。真机局域网联调（手机扫码）留 R2 移动端联调。
> 方法：真实服务 harness（`ServerInstance::bind` + `build_router` + `serve`，TLS 开启）+
> 真实网络客户端（curl -k / node ws 不校验证书）逐项执行；每项附命令输出摘录。
> 编码：UTF-8 无 BOM，中文。

---

## 1. 环境记录

| 项       | 值                                                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 执行机器 | 本机 Windows（C:\Software\conex 工作区）                                                                                                                                                                                         |
| 引擎代码 | 当前工作区 + 提交链（`8479204c`…`b867fc28`/`16f2f55f`/`bed1924f`），R1 服务面代码 100% 已入库                                                                                                                                    |
| harness  | 一次性 bin（不入库，`Temp\opencode\r1-11-harness\`）：ServerConfig{enabled=true, tls_enabled=true} + `ServerInstance::bind` + 手动装配（共享 TokenStore Arc + PairingCoordinator + WsRegistry，对齐 server_integration.rs 先例） |
| 客户端   | curl 8.21.0（Schannel，`-k` 忽略自签证书）、node v24.11.0 + ws（`rejectUnauthorized:false`）、netstat                                                                                                                            |
| 服务端口 | 8765（主）/ 8766（L4-9 探测兜底）/ 8770（WS pair.hello 链）                                                                                                                                                                      |
| 证书     | TLS 自签（`tls.rs` 生成，harness 临时目录 `multi-device/`），wss-only                                                                                                                                                            |
| 测试批次 | 20260813-run4（L4-1/2/3/3b/4/5/6/7/9 + 红线 1/4/5/7）、20260813-run5（L4-3c/8 + 红线 6）；自动化门禁单独执行                                                                                                                     |

> 说明：run4 中 L4-3c（platform 枚举值非法 → 客户端载荷问题）与 L4-8（驱动脚本
> `Start-Process -Wait` 阻塞导致触发文件晚写）两处 FAIL 均为**驱动脚本缺陷**，非服务
> 缺陷；run5 修正后两项均 PASS（见 §2 证据）。红色线 6 在 run5 有独立真实墙钟证据。

---

## 2. L4 清单 1-9 执行核对表

| #   | 验收项                                                  | 结果     | 证据（真实输出摘录）                                                                                                                                                                                                                   | 备注                                                                                                                                            |
| --- | ------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 本机 `curl -k https://127.0.0.1:8765/v1/info` 有响应    | **PASS** | `L4-1 body: {"service":"crish-agent-workbench","version":"0.1.0","protocolVersion":1,...,"port":8765,"bindMode":"loopback","pairingActive":false,...,"capabilities":{...17 键...}}`；断言 service/port/bindMode/capabilities 17 键全过 | 服务开启即 wss-only；`-k` 忽略自签证书                                                                                                          |
| 2   | 未带令牌 / 坏令牌访问 /v1/status → 401                  | **PASS** | `L4-2 no-token=401 body={"code":"auth.bad_signature","message":"缺少 Authorization: Bearer <token>","retryable":false}`；`bad-token=401`；`info=200`（免鉴权面不受影响）                                                               | 401 带 ErrorBody                                                                                                                                |
| 3   | 开启配对 → POST /v1/pair 拿令牌（64 hex，立即可用）     | **PASS** | `L4-3 pair resp: {"token":"9ba9a4ee16be7dd9aafe52c1c80165b38d8fa12afbf5917599afe88724ae3e51","label":"acceptance-phone"} HTTP:200`；`token immediately usable /v1/status -> 200`                                                       | 请求体经 `--data-binary @file`（规避 5.1 引号 bug）                                                                                             |
| 3b  | 错码 → 401；配对码单次使用（复用 → 401）                | **PASS** | `wrong-code: {"code":"pair.invalid_code",...} HTTP:401`；`reuse: {"code":"pair.used",...} HTTP:401`                                                                                                                                    |                                                                                                                                                 |
| 3c  | WS pair.hello 链（无令牌升级 → pair.ok + device.ready） | **PASS** | `PAIR_OK {"desktopId":"crish-desktop","token":"a329b8c6...","ttl":86400}` + `DEVICE_READY {"deviceId":"node-device-0002"}` + `{"pass":true,"token64hex":true,...}`                                                                     | run5；独立实例（配对码单次使用）                                                                                                                |
| 4   | 令牌连 /v1/events 订阅 → 推送到达（events.push）        | **PASS** | `SUBSCRIBE_OK {"sessions":[{"nextSequence":37,...}]}`；`{"pass":true,"got":1,"want":1,"pushes":[{"sessionId":"s-1","type":"agent-start","sequence":37}]}`；harness `manual publish seq=36` → push seq=37 到达                          | harness 注入 fanout（引擎事件模拟）；序列号实时衔接                                                                                             |
| 5   | 审批场景 approve / deny 端点                            | **PASS** | `approve: {"ok":true,"toolCallId":"tc-harness-1","decision":"approved"} HTTP:200`；`deny: {...} HTTP:200`                                                                                                                              | **mock 后端**：harness 无引擎，审批决策由 stub ApiBackend 返回；端到端审批（run 触发挂起→批准→恢复）依赖引擎，由集成/协议测试覆盖（R0-07 件 2） |
| 6   | 断线续传（resume 从 last+1 起）                         | **PASS** | `{"pass":true,"after":20,"pages":[{"count":17,"first":21,"last":37}],"done":{"resumedTo":37,...},"expectedFirstSeq":21}`                                                                                                               | 订阅 20 后断开重连 → resume 从 21 起                                                                                                            |
| 7   | 桌面重启 → 旧令牌仍有效，续传无缝                       | **PASS** | 重启（同配置目录）后：`status=200 hello=200`；`resume: {"pass":true,...,"pages":[{"count":10,"first":21,...}],"done":{"resumedTo":30,...}}`                                                                                            | pairing.json 持久化；令牌 SHA-256 落盘后重载                                                                                                    |
| 8   | 撤销设备 → 全部连接被踢（token-revoked）+ 重连 401      | **PASS** | `REVOKED_FRAME {"code":"auth.device_revoked","message":"...token-revoked...","retryable":false}`；`{"pass":true,"elapsedMs":6,"reconnectStatus":401,...}`；撤销后 `/v1/status -> 401`                                                  | run5；harness `revoke_all`（= cancel_pairing 语义）                                                                                             |
| 9   | 8765 被占用 → 服务落 8766，/v1/info 反映实际端口        | **PASS** | `8765 occupied by: TCP 127.0.0.1:8765 ... LISTENING`；`probe bound: 8766`；`L4-9 info: {"service":"crish-agent-workbench",...,"port":8766,...}`                                                                                        | 真实 harness 实例占位 8765（netstat 可见）                                                                                                      |

---

## 3. 红线 1-7 执行核对表

| #   | 红线                                         | 结果               | 证据（真实输出摘录 / 测试输出）                                                                                                                                                                                                                                                                                                                                                           | 备注                                                                                              |
| --- | -------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | `multi_device.enabled=false` 无任何端口监听  | **PASS**           | 服务全部停止后：`netstat 876[5-9]+877[0-5] empty`（无监听）；自动化：`cargo test -p crish-agent-workbench --bin crish-agent-workbench disabled_service_never_binds` → `test tests::disabled_service_never_binds_any_port ... ok`（1 passed）                                                                                                                                              | harness 恒 enabled=true；enabled=false 精确语义由装配面测试断言（main.rs:1159）                   |
| 2   | 远程 run 无法获得 full-access（截断 + 审计） | **PASS（自动化）** | `cargo test ... t08_apply_remote_mode` → `t08_apply_remote_mode_clamps_full_access_to_ask ... ok`；`t08_remote_mode_downgrade_*` 3 测试 ok（marker shape / event wire shape / emits security audit event）                                                                                                                                                                                | 服务面手测 **NOT-EXECUTABLE**：需真实引擎 run（远程申报 → 截断）；自动化面全覆盖                  |
| 3   | 红线命令经远程通道一律 Deny                  | **PASS（自动化）** | `cargo test -p agent-tools -- redline_remote_source_denied` → `permission::tests::redline_remote_source_denied_in_all_modes_without_approval ... ok`；`decide_command_remote_source_redline_denied_in_all_modes ... ok`；`remote_source_non_redline_follows_mode_matrix ... ok`；`redline_remote_source_precedes_revert_gate ... ok`（各 1 passed）                                       | 服务面手测 **NOT-EXECUTABLE**：需真实引擎 run（权限矩阵判定）；自动化面全覆盖（G-9 远程变体矩阵） |
| 4   | 日志扫描测试（T-06）零明文命中               | **PASS**           | 真实运行后扫描 harness 日志目录 + pairing.json：`red4: pairing.json: rawTokenHits=0 sha256HashPresent=true ... RED4_CLEAN`（日志零命中 + pairing.json 只存 SHA-256 哈希）；自动化：`cargo test -p conex-telemetry redact_log_scan` → `redact_log_scan_e2e ... ok`、`redact_log_scan_file_persisted ... ok`（2 passed）                                                                    | 扫描含：原始令牌（64 hex）/ CXN- 配对码 / sk- 密钥形态                                            |
| 5   | `config_secret_*` 远程来源 100% Forbidden    | **PASS**           | `config_secret_reveal ... HTTP:403 {"code":"cmd.denied","message":"命令不在远程白名单：config_secret_reveal","retryable":false}`；`config_secret_get ... HTTP:403`（同型）；自动化：`t07_config_secret_forbidden_end_to_end_with_audit_event ... ok`                                                                                                                                      | 带有效 Bearer 令牌远程调用；白名单排除 + 命令级守卫双层                                           |
| 6   | 撤销设备 ≤1s 内断开全部活动连接              | **PASS**           | run5 真实墙钟：`REVOKED_FRAME ... {"pass":true,"elapsedMs":6,"reconnectStatus":401,...}`（6ms ≤ 1000ms）；自动化：`cargo test -p crish-agent-workbench --test server_integration` → 11/11 全绿，含 `integration_revoke_device_kicks_within_1s_wall_clock ... ok`、`integration_revoke_all_kicks_every_active_connection ... ok`、`integration_revoked_token_rejected_on_reconnect ... ok` | 双重证据：真机墙钟 + 集成测试断言                                                                 |
| 7   | 全部远程动作产生 `remote-*` 审计且打码       | **PASS**           | 服务面触发 config_secret 403 后：`red7 audit lines: 2`，`security.audit ... operation="remote-source-attempt" command=config_secret_reveal decision="blocked"`（×2，command 已打码形态）；自动化：t08_remote_mode_downgrade_* 3 测试 + t07 端到端审计事件断言 ok                                                                                                                          | 服务面为结构化日志通道（harness 未接事件桥，双写降级路径）；事件级由 core_backend/router 测试断言 |

---

## 4. 未执行项清单（说明原因）

| 项                                                                      | 原因                                                                                        | 覆盖口径                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 红线 2 服务面端到端（远程 run 申报 full-access → 截断 ask + 审计）      | harness 无真实引擎 run 装配（CoreRunState 未接线），无法造「远程 run 申报 full-access」场景 | 自动化全覆盖：t08_apply_remote_mode_clamps_full_access_to_ask + t08_remote_mode_downgrade_* 3 测试（R1-10 f3c140a2） |
| 红线 3 服务面端到端（远程 run 内触发红线命令 → Deny）                   | harness 无真实引擎 run（权限矩阵判定在 agent-tools 契约体）                                 | 自动化全覆盖：agent-tools 远程变体矩阵 4 测试（G-9）                                                                 |
| L4-5 端到端审批闭环（桌面 run 挂起 → 手机 approve → approval-resolved） | 需真实引擎 run + 待审批工具调用                                                             | mock 后端端点 200 通过 + R0-07 件 2 协议序列测试；真机闭环属 R2 移动端联调                                           |
| L4-4「桌面发起 run」事件源                                              | 以 harness fanout 注入（engine-like 事件发布）替代                                          | 载荷与 EventBridge 输出同构；真实 run 事件流由引擎集成测试覆盖                                                       |
| 真机局域网扫码配对（二维码 / 0.0.0.0 重绑 / 防火墙）                    | 明确留 R2 移动端联调（任务书口径）                                                          | —                                                                                                                    |

---

## 5. 汇总判定

| 域             | 结果                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| L4 1-9         | 9/9 PASS（含 3c/3b 子项；服务面真实网络执行）                                                                               |
| 红线 1/4/5/6/7 | 5/5 PASS（手测或自动化；红线 6 双证据）                                                                                     |
| 红线 2/3       | 自动化 PASS（服务面 NOT-EXECUTABLE，见 §4）                                                                                 |
| 自动化门禁复核 | server_integration 11/11、redact_log_scan 2/2、agent-tools 远程变体 4/4、disabled_service_never_binds 1/1、t07/t08 5/5 全绿 |

**结论**：R1-11 服务面（L4 1-9 + 红线 1-7 自动化可测部分）验收通过；未发现 FAIL。
真机局域网联调（扫码配对/审批闭环/断线续传/撤销即时性/AP 隔离）留 R2 移动端联调执行。

---

## 6. 执行方法备忘（可复核）

- 服务 harness：一次性 Rust bin（`Temp\opencode\r1-11-harness\`，不入库），
  `ServerConfig{multi_device_enabled=true, tls_enabled=true, tls_cert_dir=临时目录}` +
  `ServerInstance::bind` + 手动装配 `ServerState`（`with_pairing` 共享 TokenStore Arc +
  WsRegistry，对齐 `tests/server_integration.rs::spawn_server`）+ `build_router` + `serve`；
  控制文件（shutdown / trigger-revoke-all / trigger-publish）驱动场景。
- 客户端：`curl.exe -k`（TLS 忽略校验）、node ws（`rejectUnauthorized:false`）、
  netstat；请求体一律 `--data-binary @file`（规避 cmdline 引号 bug）。
- 证据目录：`Temp\opencode\r1-11-logs\20260813-run4\`、`20260813-run5\`
  （results.txt / serve-*.out.log / l4-8-revoke.out 等），可复核。
- 已知执行侧瑕疵（非产品缺陷）：run4 的 L4-3c 平台枚举值非法与 L4-8 驱动
  `Start-Process -Wait` 阻塞为脚本问题，run5 修正后 PASS。

---

## 7. 变更记录

| 版本 | 日期       | 变更                                                                                                                    |
| ---- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| v1.0 | 2026-08-13 | 初稿：L4 1-9 + 红线 1-7 服务面手测执行记录（run4/run5 真实证据 + 自动化门禁复核），9/9 + 5/5 PASS，红线 2/3 自动化 PASS |

_文档结束。验收执行由 R1-11 验收执行子代理产出（仅新建本验收记录文档，未修改任何源文件/测试文件）。_
