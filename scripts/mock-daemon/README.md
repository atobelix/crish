# mock daemon v0（R0-06）——多端互通联调夹具服务器

> 定位：多端互通 R0 阶段产物，**纯测试基建，不进生产代码**。按
> `crates/conex-types/contracts/device-protocol.json`（协议注册表唯一真源）生成的
> WebSocket 夹具服务器 + 夹具事件集，供移动端（R2）连接层联调使用。
> 协议契约：`docs/multi-device/Z0-master-plan.md` §9.2 R0-06 / §12 验收门禁；
> `docs/multi-device/plans/M5-mobile-engineering.md`（连接层）、`M6-protocol-messages.md`（消息定义）。

## 一句话

mock 启动后，移动端/任意 ws 客户端可完成 **配对 → 握手 → 订阅 → 收到夹具事件 → 发 approve/deny 收回执 → 断线重连续传** 的全链路联调，而无需等待真实桌面网关（R1）就绪。

## 快速开始

```bash
cd scripts/mock-daemon
npm install                       # 首次
npm run start -- --pair --scenario approval --port 8765
```

另开终端跑验收冒烟（全链路自动走一遍并打印步骤）：

```bash
npm run smoke -- --port 8765
# 或跳过配对：npm run smoke -- --no-pair --port 8765
```

自测（连接/握手/推送/回执/续传共 33 用例）：

```bash
npm test
npm run typecheck                 # tsc --noEmit（strict + exactOptionalPropertyTypes）
```

## 启动参数（CLI）

| 参数                      | 默认                 | 说明                                                                 |
| ------------------------- | -------------------- | -------------------------------------------------------------------- |
| `--host <addr>`           | `127.0.0.1`          | 监听地址；真机联调（手机连同一局域网）用 `0.0.0.0`                   |
| `--port <n>`              | `8765`               | 监听端口（对齐网关端口裁决 P-1）                                     |
| `--pair` / `--no-pair`    | `--pair`             | 配对模式开关。开：必须先走 pair.* 流程；关：跳过配对直接握手         |
| `--pair-code <码>`        | `CXN-7K4P-Q2MB-9XRT` | 配对码（格式 CXN-XXXX-XXXX-XXXX；`pair.hello` 校验）                 |
| `--scenario <id>`         | `idle`               | 夹具场景：`idle` / `approval` / `run` / `cache`（`--list` 查看说明） |
| `--loop`                  | 关                   | 场景循环播放（仅 `run` / `cache` 可循环；交互式 `approval` 不循环）  |
| `--scenario-speed <倍率>` | `1`                  | 时间线速度倍率（≤1 加速，`0` = 立即发射；测试用）                    |
| `-v` / `--verbose`        | 关                   | 调试日志                                                             |
| `-q` / `--quiet`          | 关                   | 只输出错误                                                           |
| `--list` / `-h`           | —                    | 列出场景 / 帮助                                                      |

示例：

```bash
# 真机联调：局域网 + 审批场景
npm run start -- --host 0.0.0.0 --port 8765 --pair --scenario approval
# 纯订阅推送观察：run 生命周期循环
npm run start -- --no-pair --scenario run --loop
```

## 支持的消息范围（v0）

### 入站（客户端 → mock）

| kind                                                                                                                               | 说明                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pair.hello` → `pair.verify`                                                                                                       | 配对流程（校验配对码——PairCode::normalize 容错前缀/分隔符/大小写，与 Rust pair.rs 对齐（对拍裁决 2026-08-11）；挑战/签名不验签，仅要求非空） |
| `auth.hello`                                                                                                                       | 握手（版本协商：必须包含协议版本 1；配对模式下要求已配对）                                                                                   |
| `auth.refresh`                                                                                                                     | 重连刷新（不验签；成功静默，失败回 `error auth.expired`）                                                                                    |
| `events.subscribe`                                                                                                                 | 会话订阅（≤32 会话；回 `events.subscribe.ok`，携带逐会话 nextSequence/stale）                                                                |
| `events.subscribeAll`                                                                                                              | 全局轻订阅（协议无 ack，静默登记）                                                                                                           |
| `events.resume`                                                                                                                    | 断线续传（开区间分页，复用 EventPage 契约；末页后补发 `events.resume.done`）                                                                 |
| `remote.approve` / `remote.deny`                                                                                                   | 审批决策（I-02 冲突语义 + msgId 幂等回显；成功后广播 `approval-resolved`）                                                                   |
| `remote.listPendingApprovals` / `remote.approvalHistory`                                                                           | 待办对账 / 决策历史                                                                                                                          |
| `remote.getStatus` / `getRunSnapshot` / `readSessionEvents` / `readRunEvents` / `listSessions` / `listCommands` / `getSearchIndex` | 监控/查询面夹具                                                                                                                              |
| `remote.checkCommand` / `runControl` / `cancelRun`                                                                                 | 审批预览 / run 控制（仅记录，不改状态）                                                                                                      |
| `remote.getSettings` / `queryPresence` / `listDevices` / `getPairState` / `renameDevice` / `writeFile`                             | 设置/设备/文件面夹具（writeFile 幂等回显，不落盘）                                                                                           |
| 其余 `remote.*`（runTask/searchSessions/文件只读面等）                                                                             | 回 `error {code: cmd.unknown, retryable: false}`（诚实未实现）                                                                               |
| `heartbeat`                                                                                                                        | 回 `heartbeat.ok`（serverTime 时钟校准）                                                                                                     |
| `device.unlink`                                                                                                                    | 解除配对（静默，README 约定无 ack）                                                                                                          |
| `error`                                                                                                                            | 记录日志（联调观察用）                                                                                                                       |

### 出站（mock → 客户端）

`pair.challenge` / `pair.ok`（desktopId + ttl + token 明文扩展，与 Rust pair_ok_body
对齐，对拍裁决 2026-08-11）/ `device.ready` / `auth.hello.ok`（含 manifest）/ `events.subscribe.ok` /
`events.push`（一帧一事件，载荷 = AgentEventEnvelope 扁平 JSON）/ `events.resume.page` /
`events.resume.done` / `result.<name>`（reqMsgId 关联）/ `heartbeat.ok` / `error`。

### 明确不实现（v0 边界）

- **不验签**：HMAC 签名（D3 §5.1）由真实桌面网关实现；mock 出站帧 `auth.sig` 为固定占位串，
  收到任意非空 sig 都放行。移动端联调时签名层可先接空实现。
- **不做 TLS**：真实网关是 wss + 证书指纹固定（C-2 裁决）；mock 是明文 ws，仅联调用。
- **不落盘**：会话事件/设备/审批全部内存态，进程退出即清零（纯测试基建）。
- `events.subscribeAll` 无 ack；`device.unlink` / `auth.refresh` 成功无 ack（协议未定义）。

## 夹具事件集（场景）

事件载荷与引擎事件信封逐字段同构（`crates/conex-types/src/events.rs` 序列化形态），
出站前经 generated/device 解析器自检，测试中对 `parseEngineEvent` 断言——移动端解析不炸。

| 场景       | 会话 id           | 内容                                                                                                                                              | 交互                       |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `idle`     | （任意）          | 不自动发射事件，仅回应用户消息                                                                                                                    | 否                         |
| `approval` | `s-mock-approval` | run 启动 → 消息流 → **approval-requested（闸门，等待决策）** → 客户端 approve/deny → `approval-resolved` 广播 → 工具执行 → run 收口               | **是**（决策后继续时间线） |
| `run`      | `s-mock-run`      | run 生命周期：agent-start → turn-start → 流式 message-delta → message-end → 两轮工具调用（shell:read/write）→ turn-end → agent-end → run-terminal | 否（可 `--loop`）          |
| `cache`    | `s-mock-cache`    | 缓存指标事件：cold-cache-warning（run 启动）→ 消息流 → cache-waste-alert（命中引擎阈值语义）→ run 收口 + cache-stats-updated                      | 否（可 `--loop`）          |

**触发方式**：场景在**首个客户端订阅其会话**时自动启动（`idle` 除外）；`approval` 场景的
待审批项在决策前一直挂起，`listPendingApprovals` / `getStatus` 均反映该待办。

## 与 R2 移动端联调说明

1. **连接 URL**：`ws://<桌面 IP>:8765`（桌面启动参数 `--host 0.0.0.0`；手机与桌面同一局域网）。
2. **配对码**：默认 `CXN-7K4P-Q2MB-9XRT`（`--pair-code` 可改）；配对失败错误码
   `pair.invalid_code` / `pair.challenge_mismatch` / `pair.no_challenge`。
   输入容错（前缀/分隔符/大小写/空白）与 Rust `PairCode::normalize` 一致
   （对拍裁决 2026-08-11）：wire 形态（12 位无前缀）与展示形态均可配对。
3. **推荐场景**：审批中心联调用 `--scenario approval`；会话/事件流联调用 `--scenario run`；
   缓存指标卡联调用 `--scenario cache`。
4. **断线续传**：重连 = 新连接 + 同 deviceId → `auth.hello` → `events.subscribe`
   （携带 `lastSequences`）→ `events.resume`（afterSequence 开区间分页）→
   `events.resume.done`（resumedTo 后恢复实时推流）。mock 的会话事件存储按 deviceId 无关地
   保留，重连不丢事件。预览帧（`preview: true`）不推进游标、不进续传。
5. **命令回执**：`remote.approve` 成功 → `result.approve`（decision=approved）+ 广播
   `approval-resolved`；重复决策 → `error cmd.approval_mismatch`（I-02 语义）；
   同 msgId 重发 → 幂等回显首次结果（TTL 5 分钟）。移动端 outbox 重放可据此验证。
6. **时钟**：`heartbeat.ok.serverTime` 用于客户端时钟偏移校准；mock 时间即本机时间。
7. **限制提醒**：mock 不验签、明文 ws，**严禁**用真机连公网暴露端口做安全相关验证；
   仅限本地/局域网开发联调。

## 目录结构

```
scripts/mock-daemon/
├── package.json / tsconfig.json / vitest.config.ts
├── README.md                     # 本文档
├── src/
│   ├── index.ts / cli.ts         # 入口与 CLI 参数装配
│   ├── server.ts                 # MockDaemonServer（WS 服务 + 场景驱动 + 事件广播）
│   ├── connection.ts             # 单连接会话（配对/握手/订阅/续传/命令路由）
│   ├── commands.ts               # remote.* 命令处理器（approve/deny/查询面夹具）
│   ├── state.ts                  # 会话事件存储/设备表/审批态/幂等缓存
│   ├── envelope.ts               # 信封构造 + 出站自检 + 入站解析（复用生成 parser）
│   ├── util.ts                   # msgId/日志/延时
│   └── fixtures/                 # 夹具事件工厂 + 三个场景时间线
│       ├── events.ts             # AgentEventEnvelope 扁平 JSON 工厂
│       ├── approval.ts / run.ts / cache.ts
│       └── index.ts              # 场景注册表
├── examples/
│   └── smoke-client.ts           # 验收冒烟客户端（npm run smoke）
└── tests/                        # vitest 自测（配对/握手/订阅推送/命令回执/续传）
    ├── helpers.ts
    ├── pairing.test.ts
    ├── handshake.test.ts
    ├── subscribe-push.test.ts
    ├── commands.test.ts
    └── resume-reconnect.test.ts
```

## 验收口径（对齐 Z0 §9.9 R0-06）

- [x] mock 启动后（node 脚本）可用 ws 客户端连上
- [x] hello → subscribe → 收到事件 → 发 approve 收回执（`npm run smoke` 全链路退出码 0）
- [x] 自测全绿（`npm test`：33 用例）
- [x] 断线重连续传（resume 分页 + resume.done；预览帧语义）
- [x] 中文注释、UTF-8 无 BOM
