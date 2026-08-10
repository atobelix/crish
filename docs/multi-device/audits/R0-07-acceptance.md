# R0-07 验收报告——R0 出口验收三件套

> 文档编号：R0-07-acceptance
> 角色：多端互通 R0 实施轮子代理 R0-07（出口验收三件套）
> 日期：2026-08-10
> 定位：R0 任务包 R0-07 的**验收证据载体**——三件套结果表（断言项/结果/证据命令）、
>       R0 出口闸四项核对（C-1~7 落 ADR / 对拍门禁绿 / mock daemon v0 可连 / 入库完整性）、
>       遗留登记。验收锚点来源：`Z0-master-plan.md` §9.2 R0-07 行、§9.9 验收锚点表
>       R0-07 行、§12.5 P0 ①/②/③、§12.6 T-D3-04/T-D3-06。
> 输入：mock daemon v0（R0-06）+ 对拍样例集（R0-05）+ 生成解析器（R0-03）
> 编码：UTF-8 无 BOM，中文。

---

## 1. 验收范围与口径

R0-07 任务书要求「D1 P0 验收三件套」在测试面落地（验收锚点：**事件信封逐字节断言、
远程 approve 恢复 run、关网关 GUI 照常三项全过**）：

| 件 | 验收锚点 | 落地方式 |
|----|----------|----------|
| 1 | 事件信封逐字节断言（Z0 §12.5 P0 ① / T-D3-04） | mock daemon 实际推送的 events.push 信封逐字段断言（真实 WS 传输路径端到端） |
| 2 | 远程 approve 恢复 run（Z0 §12.5 P0 ② / T-D3-06） | approval 夹具场景：run 挂起 → remote.approve → run 恢复 → 完整序列断言 |
| 3 | 关网关 GUI 照常（Z0 §12.5 P0 ③） | 当前无真实桌面服务端（R1 未做），按任务书指定口径用 mock daemon 模拟「网关断开」验证客户端重连韧性 |

三件套在**验收级**与既有覆盖的分工：双侧对拍（Rust 序列化 vs 样例 / TS parser vs 样例）
由 R0-05 承担，本批测试不再重复解析样例文件本身，而是把 **mock daemon 实际推送的帧**
作为断言对象——真实传输路径上的端到端验收。

## 2. 三件套结果表

### 2.1 件 1：事件信封逐字节断言 —— ✅ 通过

| 断言项 | 结果 | 证据命令 |
|--------|------|----------|
| 外层信封逐字段：v/kind/msgId/ts/from/to/auth/body 八字段齐全合法，字段集合与样例 `08-events-push.json` 完全一致 | ✅ | `npm test`（`01-envelope-byte-parity.test.ts`「首帧逐字段」） |
| auth 四字段（deviceId/ts/nonce/sig）+ ts 时间窗（±5s） | ✅ | 同上 |
| event 骨架逐字段（type/runId/sequence/schemaVersion/sessionId/timestamp，样例 08 基准） | ✅ | 同上 |
| event 通过生成解析器 `parseEngineEvent` 全量解析（41 变体注册表内）；整帧通过 `parseDeviceFrame` | ✅ | 同上 |
| **wire 透传无损**：客户端收到的 event 与服务端会话存储逐条 canonical 逐字节一致（run 场景全生命周期） | ✅ | `01-envelope-byte-parity.test.ts`「逐字节断言」 |
| sequence 单调递增、无重复无空洞（与样例 08 整数 sequence 语义一致） | ✅ | 同上 |
| preview 帧（样例 09 基准）：preview=true、sequence 省略语义、不推进游标不落库 | ✅ | 「preview 帧」用例 |
| 入站信封逐字段：客户端完整信封服务器逐字段解析并正常回执 | ✅ | 「入站信封」用例 |
| 订阅面信封（auth.hello.ok / events.subscribe.ok 逐字段，样例 07 基准） | ✅ | 「订阅回执信封」用例 |

### 2.2 件 2：远程 approve 恢复 run —— ✅ 通过

| 断言项 | 结果 | 证据命令 |
|--------|------|----------|
| 挂起断言：approval-requested 到达后 run 处于 awaiting-approval，待审批 1 项（listPendingApprovals / getRunSnapshot） | ✅ | `npm test`（`02-approval-resume-run.test.ts`「挂起断言」） |
| 移动端 remote.approve → result.approve（decision=approved、toolCallId 回显、reqMsgId 关联） | ✅ | 「移动端 remote.approve」 |
| **run 恢复继续**：approval-resolved 广播 → 续接消息 → tool-start/update/end（工具执行）→ message-end → turn-end → agent-end → run-terminal 完整序列 | ✅ | 「run 恢复继续」 |
| 序列相对顺序：决策广播 → 工具执行 → 收口（run-terminal 为最后一帧） | ✅ | 同上 |
| run 状态机迁移完成：approve 后 getRunSnapshot → completed；审批历史入账（decision=approved、channel=mobile） | ✅ | 「run 状态机迁移」 |
| deny 变体：拒绝路径同样收口；重复决策 → cmd.approval_mismatch（I-02 防伪造） | ✅ | 「deny 变体」补充 describe |

### 2.3 件 3：关网关 GUI 照常 —— ✅ 通过（mock 模拟网关断开，重连韧性）

| 断言项 | 结果 | 证据命令 |
|--------|------|----------|
| 网关完整关闭（server.close）→ 客户端感知 close（不崩）、本地已收事件完好（本地投影照常） | ✅ | `npm test`（`03-gateway-down-resilience.test.ts`「网关断开」） |
| 网关同端口重启 → 客户端重连（同 deviceId）→ resume 追平（resume.done）→ 实时推流恢复 | ✅ | 「网关同端口重启」 |
| 重连全程无 error 帧；重连后可正常发命令（heartbeat.ok） | ✅ | 同上 |
| 断线窗口事件不丢：客户端断开期间网关继续运行 → 重连追平（无重复无丢失、顺序正确）→ 实时衔接（sequence 无缝续接） | ✅ | 「断线窗口事件不丢」 |

> 口径说明：真实桌面服务端未实现（R1），「关网关 GUI 照常」的桌面 GUI 侧语义无法在本轮
> 实测，已按任务书指定口径以 mock daemon 模拟「网关断开」验证客户端重连韧性；真实语义
> 留待 R1-11 真机联调（L4 清单 4/6/7）复验，见 §5 遗留登记。

## 3. 新增验收测试资产清单

落点 `scripts/mock-daemon/tests/acceptance/`（14 个新用例，随 mock-daemon `npm test` 全量执行）：

| 文件 | 用例数 | 覆盖 |
|------|--------|------|
| `helpers.ts` | — | 验收级客户端（保留完整 DeviceEnvelope）+ canonical 工具 + 信封逐字段断言工具 |
| `01-envelope-byte-parity.test.ts` | 5 | 件 1：信封逐字段 + wire 透传无损 + preview 帧 + 订阅面信封 |
| `02-approval-resume-run.test.ts` | 6 | 件 2：挂起 → approve 恢复 → 完整序列 → 状态机迁移 + deny 变体 |
| `03-gateway-down-resilience.test.ts` | 3 | 件 3：网关关闭/重启重连 + 断线窗口追平 |

## 4. R0 出口闸核对

R0 出口闸四项（Z0 §9.2「R0 出口闸」）：**C-1~7 落 ADR；对拍门禁绿；mock daemon v0 可连；
入库完整性验证过**——本轮核对结论如下：

| # | 出口闸项 | 结果 | 证据 |
|---|----------|------|------|
| 1 | C-1~7 落 ADR | ✅ 通过 | `docs/multi-device/adr/ADR-01-protocol-decisions.md` 存在，7 条裁决（ADR-01~07）全部「已裁决」，覆盖 C-1/C-2/C-3 + A-1~A-7（R0-04 产物，已入库） |
| 2 | 对拍门禁绿 | ✅ 通过（本地） | Rust：`cargo test -p conex-types --test device_parity` → 3/3 绿；TS：`npx vitest run packages/shared-types/src/generated/device/parity.test.ts` → 22/22 绿 |
| 3 | mock daemon v0 可连 | ✅ 通过 | `npm run start`（127.0.0.1:8765，ADR-05 裁决端口）+ `npm run smoke -- --no-pair --port 8765` → **EXIT=0**（hello → subscribe → 事件推送 → approve 回执 → approval-resolved → heartbeat 全链路） |
| 4 | 入库完整性验证过 | ⚠️ **未过（阻塞项）** | 见 §5 遗留 1：对拍样例 22 个 JSON 被根 .gitignore `*.json` 规则忽略，从未入库 |

本批验收测试自身门禁：`npm test`（scripts/mock-daemon）→ **49/49 全绿（9 文件，含新增 14 用例）**；
`npm run typecheck` → 通过；新增文件均 UTF-8 无 BOM。

## 5. 遗留登记

| # | 遗留项 | 级别 | 处置 |
|---|--------|------|------|
| 1 | **对拍样例 22 个 JSON 未入库（入库完整性缺口）**：`tests/fixtures/device-protocol/valid/*.json`（16）+ `invalid/*.json`（6）被根 `.gitignore` 第 360 行 `*.json` 忽略；`git ls-files` 仅见 `README.md`，`git log --all -- tests/fixtures/device-protocol/valid` 无历史。Rust `device_parity.rs` 以 `CARGO_MANIFEST_DIR/../../tests/fixtures/device-protocol` 硬路径读取、无缺失兜底——**CI checkout 后对拍门禁必红**（本地因文件仍在工作区而绿，掩盖了该缺陷） | 高（阻塞 R0 出口） | 提交轮处理（R0-01 文件域）：`.gitignore` 补白名单 `!tests/fixtures/device-protocol/**/*.json` 并 `git add -f` 提交 22 个样例；随后 CI 复跑对拍门禁复核（对齐 R0-01 出口判定「`git check-ignore -v` 逐文件验证」口径，样例集本身即 R0-01 验收对象之一） |
| 2 | **真实桌面服务端语义待 R1 复验**：「关网关 GUI 照常」本轮以 mock daemon 模拟网关断开验证客户端重连韧性（任务书指定口径）；真实语义（桌面网关关闭 → 桌面 GUI 事件流照常）需 R1-11 按 L4 清单 4/6/7 真机联调复验 | 中 | R1-11 验收（Z0 §9.3 R1-11 / §12.9） |
| 3 | **preview 帧 sequence 形态注记**：样例 `09-events-push-preview.json` 显式 `sequence: null`；mock 出站省略该字段（引擎序列化纪律 `events.rs:955-957` 仅在 `Some` 时注入）。两种形态消费语义等价（不推进游标），生成解析器均接受——本轮验收按 mock 出站形态断言（省略），样例 09 的 null 形态由 R0-05 对拍锁定 | 低（注记） | 无需处理；R2 移动端解析器按「可选 sequence」实现 |
| 4 | **验收测试待入库**：`scripts/mock-daemon/tests/acceptance/` 4 个新文件本轮未提交（R0-07 禁止 git 操作），AGENTS.md 铁律「测试是资产」要求立即入库 | 中 | 提交轮处理：随本报告一并 `git add` 提交 |

## 6. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-08-10 | 初稿：三件套结果表 + R0 出口闸核对（4 项中 3 过 1 阻）+ 遗留登记 4 项 |

---

*文档结束。R0-07 验收报告由多端互通 R0 实施轮子代理 R0-07 产出，2026-08-10；
三件套全过（14 个验收用例全绿），出口闸 3/4 通过，1 项阻塞（对拍样例入库缺口，提交轮修复）。*
