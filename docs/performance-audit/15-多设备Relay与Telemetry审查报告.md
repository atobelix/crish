# 15-多设备 / Relay / 协作通道审查报告

> **战役**：全面性能审查（performance-audit）
> **方向**：15 —— 多设备 / Relay / 协作通道（connex-relay、multi_device、push 旁路、conex-telemetry）
> **创建**：2026-09-13
> **状态**：静态审查完成（运行时 V 项待回填）
> **方法约定**：静态代码走读 + 关键链路证据（`文件路径:行号`）+ 严重度分级 + 修复建议；未实测项明确标注「静态分析结论，待运行时验证」。
> **总纲**：`docs/performance-audit/00-性能审查总纲.md`

---

## 一、审计范围与架构快照

### 1.1 范围内对象

| # | 对象 | 路径 | 角色 |
| - | ---- | ---- | ---- |
| 1 | 盲中继服务 | `crates/conex-relay/` | 独立二进制：E2EE 零知识 WS 中继（远程穿透） |
| 2 | 多端 TLS / 网络 | `apps/agent-workbench/src-tauri/src/multi_device/`、`multi_device_commands.rs`、`multi_device_network.rs` | 桌面侧：证书生命周期 + 配对命令 + 网络环境检测 |
| 3 | 本地服务 WS / fanout | `src-tauri/src/server/{ws,fanout,gateway,mod}.rs` | 局域网协作通道：长连接、订阅、事件扇出 |
| 4 | 推送决策与分发 | `src-tauri/src/push/` + `push_wiring.rs` + `main.rs` 装配 | 引擎事件旁路 → 决策管线 → WS 直推 / 离线 pending / 厂商通道 |
| 5 | Telemetry | `crates/conex-telemetry/` | 结构化日志文件层、panic hook、脱敏纯函数（**本地层，无远程上传**） |

### 1.2 数据流（装配后）

```text
引擎 emit(payload: String)                          ← core_event_bridge 汇聚点
  ├─ PushAwareEmitter::emit                         ← main.rs:876-886 恒挂（多端开关无关）
  │    ├─ inner.emit（TauriEmitter → webview）
  │    └─ on_event：全量 parse AgentEvent → decide → dispatch
  │         ├─ 在线设备 → WsPushChannel → WsRegistry::send_push_frame
  │         └─ 离线设备 → mark_pending（内存 VecDeque，可选 SQLite）
  └─ FanOutEmitter（attach_fanout，服务装配时）     ← main.rs:1087-1088
       └─ WsBroadcast::publish → 元信息 parse → 订阅过滤 → 每连接 512 队列
            └─ ws.rs drain_loop → events.push

独立进程：conex-relay（公网/穿透路径，与桌面 LAN server 分离）
  Ticket 校验 → SessionRegistry 房间 → 64 深 mpsc + 500ms send_timeout
```

### 1.3 范围外声明

- 移动端（`apps/crish-mobile`）只在交叉引用处提及，不展开。
- `server/{auth,pairing,router,core_backend}.rs` 的业务正确性不在本方向展开；仅取与长连接/心跳/队列相关的接缝。
- 前端消费面（订阅 UI、推送设置页）不在本方向。

### 1.4 关键常量速查

| 常量 | 值 | 位置 | 语义 |
| ---- | -- | ---- | ---- |
| `CHANNEL_BUFFER_CAPACITY` | 64 | `conex-relay/src/session.rs:15` | 中继每 peer 出站 mpsc 深度 |
| `HEARTBEAT_TIMEOUT`（relay） | 90s | `session.rs:16` | GC 判定窗口 |
| `MAX_WS_CONNECTIONS` | 8 | `ws.rs:79` | 桌面 WS 全局上限 |
| `HEARTBEAT_INTERVAL_MS` | 30s | `ws.rs:81` | 服务端 Ping 周期 |
| `HEARTBEAT_TIMEOUT_MS`（ws） | 90s | `ws.rs:83` | 3× Ping 踢出 |
| `CONN_QUEUE_CAPACITY` / `CONN_BUFFER_CAPACITY` | 512 | `fanout.rs:42`、`ws.rs:88` | 扇出队列 / 出站缓冲 |
| `RESUME_PENDING_CAPACITY` | 256 | `ws.rs:85` | 重放期实时事件缓冲 |
| `PRESENCE_TIMEOUT_MS` | 30s | `online.rs:32` | 推送在线判定窗口 |
| `MAX_FRAME_BYTES` | 1 MiB | `conex-types/.../version.rs:227` | 桌面 WS 帧上限（中继未对齐，见 RLY02） |
| `JSON_BODY_LIMIT` | 2 MiB | `server/router.rs:670` | REST body 上限 |
| `MAX_LOG_LINE_BYTES` | 8 KiB | `telemetry/file.rs:33` | 单行截断 |
| `MAX_SINGLE_FILE_BYTES` | 10 MiB | `file.rs:36` | 日志分片 |
| `LogRetention` 默认 | 7d / 50MB / crash 3 | `file.rs:330-337` | 保留策略（**未接线**） |
| `RETRY_LADDER_DELAYS` | 15m+1h×4 | `push/vendor/mod.rs:272` | 审批重推阶梯 |
| `S10A_SUPPRESS_MS` | 30min | `push/engine.rs:44` | run-failed 抑制 runtime-error |

### 1.5 与桌面 LAN server 的关系

`crates/conex-relay` 是**独立公网中继进程**，不嵌入 Tauri 壳；桌面协作主路径是 `src-tauri/src/server` 的 axum HTTP+WS（默认 Loopback/Lan 绑定，服务开关默认关）。两者共享「心跳 / 有界队列 / 令牌」概念，但**代码零共享**——relay 的缺陷不会被桌面测试覆盖，反之亦然。性能修复需双侧各自落地。

---

## 二、结论摘要

**一句话**：协作通道的**背压与限流骨架**（fanout 分级丢帧、WS 1 MiB 帧上限、推送节流/合并/去重、relay 64 深通道）设计完整且多处有测试锁定；但 **push 旁路挂在每条引擎事件的同步 emit 上且做全量 JSON 反解析**，**离线 pending 队列无上限且厂商消费生产未接线**，**relay 的 `last_active` 永不刷新导致 90s GC 会误杀活跃对端**，**telemetry 保留策略 `cleanup_logs` 壳层从未调用**——多端开启后这是结构性放大项，与 03 方向 token 逐条 emit（R1）叠乘。

| 维度 | 判定 |
| ---- | ---- |
| 背压/丢帧哲学 | ✅ 健康（fanout/ws/relay 三层均有界或超时策略） |
| 长连接心跳 | ⚠️ 桌面 WS 健康；**relay last_active 死字段** |
| 离线队列 | ❌ 内存无界 + 消费未接线 |
| 旁路解析成本 | ❌ 每事件 ×2~3 次全量 AgentEvent 反解析 |
| Telemetry 体积 | ❌ 保留策略未接线；双通道同步写 |
| 异步/阻塞纪律 | ✅ 网络枚举 spawn_blocking；日志写在 emit 路径上（中危） |
| 锁纪律 | ✅ 多为 std Mutex 短临界区；fanout publish 持锁遍历（中） |

**发现计数**：29 项（8 高 / 12 中 / 9 低）+ 10 正面。

**TOP3 高危**：

1. **PSHP01+PSHP02**：离线 pending 无界 + `send_pending_batch` 生产未接线 → 只进不出的内存队列。
2. **PSHP03+FAN01+XOV01**：push/fanout 每事件全量反解析（emit 同步路径），与 03-R1 token 逐条 emit 叠乘。
3. **RLY01**：relay `last_active` 仅 join 写入 → 活跃房间 90s GC 误清，功能与性能双杀。

---

## 三、正面发现（已验证防线，禁止回潮）

| # | 设计 | 证据 |
| - | ---- | ---- |
| G1 | 推送合并桶 drain 为 **Notify + next_expiry_ms 事件驱动**（无桶最长 60s 挂起，入桶即唤醒），取代旧 500ms 盲 sleep | `main.rs:1020-1039`、`pusher.rs:313-348` |
| G2 | Fanout 每订阅者 **512 有界队列** + Critical 必达 / Soft·Delta 丢旧 + `dropped_total` 全局可观测 | `fanout.rs:39-42, 295-346` |
| G3 | 厂商重推阶梯 **5 次封顶**（15min→1h×4）+ 审批 pending SQLite 幂等（同 approval_id 不重复计数） | `vendor/mod.rs:272-285`、`pending.rs:143-171, 173-270` |
| G4 | 多端网络枚举走 **`spawn_blocking`**，不堵 Tauri 命令线程 / IPC 循环 | `multi_device_commands.rs:95-104` |
| G5 | Telemetry **常驻文件句柄**（ACT-103：零 open/stat per line）+ 单行 8KB 截断 + 单文件 10MB 分片 | `file.rs:14-17, 33-36, 153-162` |
| G6 | 桌面 WS **帧 1 MiB 硬上限** + 30s Ping / 90s 踢出 + 全局连接上限 8 | `gateway.rs:40-48`、`ws.rs:78-88` |
| G7 | Relay **64 深背压通道 + 500ms send_timeout + 30s GC 时间轮**（设计意图正确，实现有 RLY01 缺陷） | `session.rs:15-16, 166-177`、`server.rs:42-53` |
| G8 | 在线判定纯函数 **30s 窗口**；presence / 直推 / 配对 / 踢链共用**同一 WsRegistry 实例** | `online.rs:31-40`、`push_wiring.rs:26-29`、`main.rs:871-874` |
| G9 | 节流窗口 **prune 完整**（分钟 deque / session 10min retain / 日桶只留昨今） | `throttle.rs:109-128` |
| G10 | 网络类别判定 **Fail-Closed**（任一 Public → Public）+ 失败降级 `unknown`，无 panic | `multi_device_network.rs:74-94` |

### 3.1 正面防线补充（扫描面）

- **推送意图登记表**：`intent.rs` 对 49 变体 AgentEvent 做白名单筛选，过程类（token delta / tool 流式）返回 `None`——决策层**已**阻止高频增量推送；问题在于**筛选发生在全量 parse 之后**（PSHP03）。
- **合并不依赖固定 sleep**：`PushAwareEmitter::wake_notify` + `next_expiry_ms`（`pusher.rs:338-348`）与 timer/cron drain 同款事件驱动模式（04/07 已肯定的架构风格）。
- **Relay ticket 自校验**：HMAC-SHA256 + 常量时间比较 + 60s 有效期（`ticket.rs`）——零 DB 查询，高并发下无存储放大；性能模型正确。
- **多端 TLS 指纹固定与轮换阈值**（30 天重签叶子）：避免每次握手重建 CA；冷路径成本一次。
- **`remote_whitelist` 使用 `redact_text`**：远程命令审计路径做敏感物打码，避免日志面二次敏感落盘（`remote_whitelist.rs:118`）。
- **WS resume 有界**：重放期间实时事件进 256/会话 pending，超限丢 Delta（`ws.rs:317-345`）——防「重放期 + 实时洪峰」内存放大。

---

## 四、问题清单（八要素）

### 4.1 盲中继域（RLY）

---

#### RLY01.【高】`last_active` 仅在 join 时写入，转发与心跳不刷新——90s GC 误杀活跃对端

- **位置**：`crates/conex-relay/src/session.rs:31, 91, 166-177, 186-199`；GC 触发 `server.rs:42-53`
- **现场**：

```rust
// session.rs:88-91 —— 仅 join 写入
let peer_handle = PeerHandle {
    device_id: device_id.to_string(),
    tx,
    last_active: Instant::now(),
};

// session.rs:167-177 —— forward_frame 成功也不更新 last_active
match tx.send_timeout(frame, Duration::from_millis(500)).await {
    Ok(()) => {
        self.total_forwarded_frames.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
    // ...
}

// session.rs:186-199 —— GC 按 last_active > 90s 清 host/client
let host_stale = room.host.as_ref().map_or(false, |h| {
    now.duration_since(h.last_active) > HEARTBEAT_TIMEOUT
});
```

- **调用链**：`handle_connection` → `join_room`（写 last_active）→ 业务帧 `forward_frame`（**不写**）→ 30s GC tick → `clean_stale_sessions` 将仍存活连接的 PeerHandle 置 None
- **根因**：活性时间戳语义缺失——把「加入时刻」当成了「最近活动时刻」，转发路径无 touch 钩子。
- **影响量化**（静态分析，待 V4）：任何建立后活跃超过 90s 的房间，host/client 槽被清空 → 后续 `forward_frame` 返回 `PeerNotConnected`，中继静默断流；客户端因 WebSocket 仍连着而无明确错误。等于 **>90s 的中继会话功能性失效**。
- **修复方案**：① `forward_frame` / PING 处理成功后更新对应 sender 的 `last_active`（需从 read guard 内 mut 访问，或改 `AtomicU64` monotonic ms）；② 或改为连接级 task 内周期 touch（对齐桌面 WS `registry.touch`）。建议 AtomicU64 以避免在 read 路径升级 write。
- **回归锚点**：单测——join 后 sleep 模拟/注入时钟，转发一帧后 `clean_stale_sessions` 不应清 peer；join 后无活动 91s 应清。

---

#### RLY02.【高】帧 PayloadLen 无上限（u32 全宽），decode 整段拷贝可 OOM / 内存放大

- **位置**：`crates/conex-relay/src/protocol.rs:105-119`；消费点 `server.rs:161-163`
- **现场**：

```rust
let payload_len = u32::from_be_bytes(...) as usize;
if bytes.len() < HEADER_LEN + payload_len {
    bail!("Payload incomplete: ...");
}
let payload = bytes[HEADER_LEN..HEADER_LEN + payload_len].to_vec();
```

- **调用链**：WS Binary 消息 → `RelayFrame::decode` → 无 MAX 常量校验 → `to_vec` 分配
- **根因**：只校验「缓冲区是否够长」，不校验「协议允许的最大载荷」；桌面侧有 `MAX_FRAME_BYTES = 1 MiB`（`conex-types/src/device/version.rs:227`），中继侧未对齐。
- **影响量化**：恶意/异常客户端可声明 payload_len≈数 MB～GB 并发送对应字节流；每帧一次全量堆分配。对照桌面 1 MiB 上限，中继是**开放的内存放大面**。静态分析，待 V4 外的压力测试确认实际 RSS。
- **修复方案**：引入 `MAX_RELAY_PAYLOAD_BYTES`（建议与桌面一致 1 MiB 或独立常量并写入协议文档）；decode 超限直接 bail；`encode` 侧 debug_assert。可选：拒绝时发 Error 帧。
- **回归锚点**：decode 超限单测；RFC 式 roundtrip 保持（现有 `test_encode_decode_roundtrip` 保留）。

---

#### RLY03.【中】每连接克隆 secret + 房间表全局 RwLock 写路径串行

- **位置**：`server.rs:64-65`；`session.rs:79, 120`
- **现场**：accept 循环每连接 `let secret = self.secret.clone()`；`join_room`/`leave_room` 对全量 `HashMap` 持 **write** 锁。
- **调用链**：`listener.accept` → clone secret → `handle_connection` → ticket verify → `join_room`（write）；关闭 → `leave_room`（write）
- **根因**：中继房间规模通常小（P0-3 语义近似每 host 一房），全局锁可接受；但写锁覆盖整个 HashMap 操作 + room 内 peer 通知。
- **影响量化**：房间数数百级时 join/leave 抖动会串行化；secret clone 为 32+ 字节 String，亚微秒，**可忽略**。主要成本在 write 锁竞争（多 host 同时建房场景）。静态分析。
- **修复方案**：secret 改 `Arc<str>`；房间表可保持 RwLock（规模未到前不拆 sharded map）；`PeerJoined` 通知移出 write 临界区（先 clone tx 再 drop 锁）。
- **回归锚点**：现有转发单测不变；可选并发 join bench。

---

#### RLY04.【中】无全局连接数 / 房间数上限

- **位置**：`server.rs:55-72`；对照桌面 `ws.rs:78-79` `MAX_WS_CONNECTIONS = 8`
- **现场**：accept 循环对每个 TCP 无条件 `tokio::spawn(handle_connection)`。
- **调用链**：无连接准入层。
- **根因**：公网中继需更高上限，但完全无上限则单机可被连接洪水打满 fd/任务。
- **影响量化**：极端场景任务数与内存随连接线性涨；GC 只回收「空房/超时 peer」，**半开连接在 90s 前一直占槽**（且受 RLY01 语义扭曲）。静态分析。
- **修复方案**：`RELAY_MAX_CONNS` 环境变量 + 默认（如 4096）；超限拒绝 WS 升级或先关旧 peer。
- **回归锚点**：超限拒绝测试（可 mock）。

---

#### RLY05.【低】`join_room` 丢弃真实 receiver，另造 `mpsc::channel(1)` 空壳

- **位置**：`session.rs:114-115`；调用方 `server.rs:138-141`
- **现场**：`server.rs` 自建 `(tx_to_peer, rx_from_peer)`，`join_room` 内部又 `return (mpsc::channel(1).1, session_token)`——返回的 Receiver 无用，真实数据走调用方 rx。
- **根因**：接口演化残留，API 误导阅读者以为 receiver 在 registry 内创建。
- **影响量化**：每 join 多 1 个容量 1 的 channel 分配（微不足道）；**可读性/维护成本高**，易在后续改动中接错线。
- **修复方案**：`join_room` 签名改为只返回 `session_token`（Receiver 由调用方持有——已是事实）。
- **回归锚点**：调整现有测试解构方式。

---

#### RLY06.【低】应用层 PING 经 `forward_frame` 发给对端而非回源端

- **位置**：`server.rs:164-168`；`protocol.rs:25-28`
- **现场**：收到 Ping 后构造 Pong，调用 `forward_frame(&room_id, &role, pong)`——与数据帧同路径，**Pong 被转发给「对端」而不是发回发送方**。
- **根因**：心跳语义与盲转发语义混用；若客户端期待 Pong 回环，协议行为错误（功能缺陷）；若设计为「对端代答」则注释不足。
- **影响量化**：若客户端实现等待 Pong 刷新本地超时，将误判断线并触发重连——**重连风暴放大**。静态分析（需对照移动端实现确认，本方向未展开 mobile）。
- **修复方案**：Pong 应写回**发送方**连接的 `tx_to_peer`（join 时把本连接 tx 与 role 绑定后，PING 分支直接 `tx.send(Pong)`）；或删除应用层 Ping 依赖 WS 控制帧。
- **回归锚点**：单测——client 发 Ping，**同一 client** 的 rx 收到 Pong。

---

### 4.2 多端 TLS / 网络命令域（MDC）

---

#### MDC01.【中】TLS `load_or_generate` 在服务开启路径做同步证书生成与磁盘 IO

- **位置**：`multi_device/tls.rs:157-200`（及文件锁 `lock_dir`）；消费于 server 启动 wss
- **现场**：`create_dir_all` + 文件锁 + 读 PEM + 条件 `rcgen` 生成 CA/叶子 + 原子 rename。
- **调用链**：`multi_device_set_enabled(true)` / 配对重绑 → server 启动 → `tls::load_or_generate`
- **根因**：首次生成/轮换是冷路径，但若在 UI 线程或 setup 关键路径同步执行会卡启动体验。
- **影响量化**：常态（证书未到期）主要是读文件 + rustls 装配，毫秒～几十毫秒；**首次生成 / CA 轮换** 可达数百毫秒（rcgen + 多次 fsync）。静态分析，待 V5 启动 trace。
- **修复方案**：在 `set_enabled` / rebind 异步任务内 await（若当前为 sync）；证书路径已有文件锁，保持。可选：预热缓存 `OnceLock<Arc<ServerConfig>>`。
- **回归锚点**：现有 TLS 单测；可选「已有有效证书时不调 rcgen」计数断言。

---

#### MDC02.【低】`network_env_info` 无结果缓存——低频 UI 命令，可接受

- **位置**：`multi_device_network.rs:52-71`；`multi_device_commands.rs:96-104`
- **现场**：每次命令全量 COM/注册表/网卡枚举。
- **影响量化**：spawn_blocking 已卸载；用户手动刷新频率低。**非热点**。
- **修复方案**：可选 30s 结果缓存；非必须。
- **回归锚点**：无。

---

### 4.3 服务 WS / Fanout 域（SRV / FAN）

---

#### FAN01.【高】`parse_event_meta` 全量 `Value` 反序列化 + `from_value(clone)`（03-P9 再确认，且与 push 叠乘）

- **位置**：`server/fanout.rs:281-293`
- **现场**：

```rust
let value: serde_json::Value = serde_json::from_str(payload)?;
let event: AgentEvent = serde_json::from_value(value.clone())?;
```

- **调用链**：`FanOutEmitter::emit` → `publish`（有订阅者时）→ `parse_event_meta`
- **根因**：需要 type/sessionId/sequence/backpressure 四元组，却整包解析 AgentEvent；`value.clone()` 深拷贝。
- **影响量化**：对 500B delta 为 µs 级；对 200KB tool-end 为 ms 级。**仅在有 WS 订阅者时发生**（`subscribers.is_empty()` 早退，`fanout.rs:228-230`）。多端关闭时零成本——设计正确。开启后与 03-R1（token 逐条）叠乘：N 条 delta × 2 侧解析。
- **修复方案**：① 轻量字段解析（手写/`serde` 部分 struct 只取信封元字段 + `event_backpressure` 需要的最小 type 字符串）；② 背压级别改为信封字段（引擎注入），彻底免解析；③ 消除 `value.clone()`（先取字段再 `from_value`）。
- **回归锚点**：现有 fanout 测试保持行为；可加「元信息解析不构造完整 AgentEvent」的结构断言或 bench。

---

#### SRV01.【中】WS 出站 Critical 满缓冲时 `await send`，可能拖慢该连接 drain（自限，非引擎路径）

- **位置**：`server/ws.rs:947-956`
- **现场**：`try_send` Full 且非 Delta 时 `out_tx.send(full).await`——drain task 挂起直到 sender 消费。
- **调用链**：fanout `recv` → drain_loop → out_tx
- **根因**：Critical 必达语义的合理代价；引擎 emit 不因此阻塞（fanout publish 非阻塞入队）。
- **影响量化**：慢消费者只拖垮**自己的** drain；订阅侧 fanout 队列 512 仍会丢 Delta 保 Critical。**可接受的自限**；若 Soft 也走 await，需确认是否应丢帧。
- **修复方案**：保持；可选对 Soft 也丢帧对齐 fanout 分级。
- **回归锚点**：现有缓冲满测试（`ws_channel_buffer_full_*` 在 push_wiring）。

---

#### SRV02.【中】每次 push 分发 `device_activities` 全量克隆注册表快照

- **位置**：`ws.rs:464-476`；`push_wiring.rs:72-79`；调用 `pusher.rs:166`
- **现场**：`connected_devices()` 每次克隆全部 (token_hash, label, last_frame) 元组。
- **调用链**：`PushDispatcher::dispatch` → `presence.connected_devices()` → 遍历
- **根因**：presence 以快照 trait 表达，简单正确。
- **影响量化**：连接上限 8，每次决策 8 次 String clone（token_hash 64 hex + label）。在 deliver=true 的事件上发生；对高频 delta 若 decision.deliver=false 则 0 次（`pusher.rs:160-164` 早退）。**中低频路径，量级可控**。
- **修复方案**：dispatch 接受注入的轻量设备表或 `Arc` 快照缓存（TTL 1s）；非紧急。
- **回归锚点**：presence 适配测试保持。

---

#### SRV03.【中】`WsBroadcast::publish` 持有 subscribers Mutex 遍历全部订阅者并入队

- **位置**：`fanout.rs:223-257`
- **现场**：`let subscribers = self.subscribers.lock()` 后 for 循环 `enqueue`（每 entry 再锁 queue）。
- **根因**：注册表读锁覆盖业务遍历。
- **影响量化**：≤8 订阅者时锁持有极短；与 register/unregister 竞争在连接建立瞬间。**规模未到瓶颈**。
- **修复方案**：锁内克隆 `Vec<Arc<SubscriberEntry>>` 再 drop 锁后遍历；成本一次 Arc clone。
- **回归锚点**：并发 register/publish 测试可选。

---

#### SRV04.【中】Critical 超限「必达」时队列可突破 capacity 无上界

- **位置**：`fanout.rs:314-332`
- **现场**：队列满且无 Soft/Delta 可驱逐时，Critical **超限接受**（注释明确「防御性，不丢帧」）。
- **根因**：必达语义优先于内存上界。
- **影响量化**：极端——慢消费者 + 持续 Critical 洪峰 → 单连接队列 ≫512。桌面侧同类哲学在 buffer.rs；对照 03-P9 记为正面。此处风险是**无第二上限**（如 2048 硬顶后断连）。
- **修复方案**：增加 `CRITICAL_HARD_CAP`（如 4096），触顶踢连接（必达语义改为「在连接存活期间必达」）。
- **回归锚点**：小容量 + 纯 Critical 洪峰测试。

---

### 4.4 推送决策 / 分发 / 离线队列域（PSHP）

---

#### PSHP01.【高】内存 pending 无容量上限；生产装配未注入 `PendingApprovalStore`

- **位置**：`push/pusher.rs:118, 258-278`；装配 `main.rs:871-875`
- **现场**：

```rust
// main.rs —— 未调用 with_pending_store / with_dedupe_backend(Sqlite…)
let push_dispatcher = Arc::new(crish_agent_workbench::push::PushDispatcher::new(
    Arc::clone(&ws_registry) as ...,
    Arc::new(push_wiring::WsPushChannel::new(...)),
));
```

`mark_pending` → 无 store 时 `queue.push_back` 无限增长（`VecDeque`）。
- **调用链**：离线设备或直推失败 → `mark_pending` → 内存队列；仅当注入 store 才落库。
- **根因**：R3 装配半成品：库层能力齐，**bin 侧未接**。模块头亦写「周期 drain 装配仍待装配轮」。
- **影响量化**：多端开启 + 设备离线 + 高频 deliver 场景，pending 与 `PushMessage`（含文案）在堆上单调涨；无 `pending_len` 水位告警接线。静态分析，待 V2。
- **修复方案**：① 启动时 `PendingApprovalStore::new(conn)` + `with_pending_store`；② 内存队列加 `MAX_MEMORY_PENDING`（如 256）超限丢最旧非审批条目；③ 指标暴露 `pending_len`。
- **回归锚点**：装配测试——offline 设备 → pending 落库；超限丢弃测试。

---

#### PSHP02.【高】`send_pending_batch` 生产未接线 → 离线队列只进不出

- **位置**：`push/vendor/consumer.rs:192-279`；`main.rs:1020-1039`（drain loop 只调 `flush`）
- **现场**：`flush` 仅处理合并桶；`take_pending`/`send_pending_batch` 仅测试与文档提及。`push/mod.rs:106` 自注「仍待装配轮：周期 drain 挂点」。
- **调用链**：pending 入队后**无人消费**（无厂商凭据时即便消费也 requeue）。
- **根因**：功能完成度问题，表现为性能上的**无界堆积**。
- **影响量化**：与 PSHP01 同源；审批推送「重启不丢」的 SQLite 路径同样依赖 take_due 周期，**生产 never tick** → 审批重推阶梯永不推进。静态分析。
- **修复方案**：在 push drain loop 内 select 定时（如 30–60s）调用 `send_pending_batch`（需 resolver + channels 装配）；凭据未配置时跳过而非空转 requeue。
- **回归锚点**：装配级集成测试——enqueue → tick → 模拟厂商 delivered → 队列清空。

---

#### PSHP03.【高】`PushAwareEmitter::on_event` 每事件全量 AgentEvent 反解析（emit 同步旁路）

- **位置**：`push/pusher.rs:397-420, 365-388`；装配恒挂 `main.rs:876-886`
- **现场**：

```rust
fn emit(&self, channel: &str, payload: &str) {
    self.inner.emit(channel, payload);      // ① 原通道
    self.on_event(payload);                 // ② 旁路：再 parse 一次
}
fn parse_event_payload(...) {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let event: AgentEvent = serde_json::from_value(value.clone()).ok()?; // 深拷贝
    ...
}
```

- **调用链**：引擎任意 `EventBridge::emit` → PushAware → **同步** decide + dispatch（在线直推 `try_send`）。
- **根因**：D7 方案 a 装饰器设计；解析成本落在每条工作台事件上，与决策是否 deliver 无关（先 parse 再 intent 过滤）。
- **影响量化**：
  - 事件量：03-R1 已证 token 逐条 emit 时每 run 数百～数千条；
  - 每条额外：1× `from_str(Value)` + 1× `from_value(clone)` + AgentEvent 构造；
  - 大 payload（message-end / tool-end 数百 KB）上为 **毫秒级 × 与 fanout 叠乘**；
  - 与 fanout 不同：**无订阅者早退**——push 侧**无**「无在线设备则跳过 parse」的廉价短路（intent 过滤在 parse 之后）。
  - 静态分析，待 V1 CPU profile / V5 对比 emit 延迟。
- **修复方案**（按侵入性递增）：
  1. 先做**廉价预筛**：信封 `type` 字段字符串匹配 push 白名单（18 场景 wire 名），非白名单零 parse；
  2. 消除 `value.clone()`：先抽 runId/sequence，再 `serde_json::from_str::<AgentEvent>`；
  3. 引擎在信封注入 `backpressure`/`pushSceneHint` 元字段（契约变更，需评审）；
  4. 与 03-R1 合并修复：事件合并后条数下降，本项成本同比下降。
- **回归锚点**：现有 pusher 单测全保留；新增「非推送事件不触发 AgentEvent 反序列化」的计数 mock。

---

#### PSHP04.【中】`task_owner_run` / `run_term_source` 无淘汰，进程级单调增长

- **位置**：`push/engine.rs:115-118, 166-177`
- **现场**：每次 `TaskStarted` / `RunTerminal` 向 HashMap insert；**无 retain/prune**（对比 `run_failed_at` 有 `prune_run_failed`）。
- **影响量化**：长期运行桌面 + 大量后台任务/run，每条 entry 数十字节～数百字节；万级条目 ≈ MB 级。慢性泄漏型。静态分析。
- **修复方案**：与 `run_failed_at` 同策略——按时间或条数上限 retain（如保留最近 256 个 task / 128 个 run）；`flush`/decide 惰性 prune。
- **回归锚点**：插入 N 条后 prune 断言 len 上界。

---

#### PSHP05.【中】夜间摘要 `folded` 无上限，且 `take_night_summary` 生产未调用

- **位置**：`engine.rs:231-237, 335-355`；main drain loop 未调用 take
- **现场**：静默时段 P1 `folded.push`；出桶函数存在但装配未接周期任务。
- **影响量化**：整夜高频 P1 事件 → 向量无限长；次日若仍不 take 则跨日继续涨。与 PSHP02 同类「能力有、接线无」。
- **修复方案**：drain loop 或独立 1h 定时 `take_night_summary` + 发送通道；`folded` 加 `MAX_FOLDED`（如 500）丢最旧。
- **回归锚点**：超限丢弃 + 定时 take 装配测试。

---

#### PSHP06.【中】厂商通道未装配时 `requeue_pending` 无限重试零进展

- **位置**：`vendor/consumer.rs:212-221, 275-277`
- **现场**：resolve 失败 / 通道未装配 / RateLimited / Err → 全部 `kept` → `requeue_pending`。
- **影响量化**：即使接上周期消费，**无凭据时 pending 永不下降**且每周期全量取出再入队（CPU + 锁抖动）。与 PSHP01/02 叠加为死循环堆积。
- **修复方案**：① 无任何 vendor 通道装配时**跳过** take_pending；② 对「通道未装配」条目退避（指数/阶梯）而非固定下轮全量；③ 永久无法投递（设备未登记超 N 天）丢弃并记审计。
- **回归锚点**：无通道列表时 take 不导致 requeue 风暴的测试。

---

#### PSHP07.【中】每次 dispatch 对全部已连接设备克隆并渲染完整 PushMessage

- **位置**：`pusher.rs:172-197`；文案 `copy.rs` 经 `message_with_copy`
- **现场**：`for device in devices { format!("push-..."); message_with_copy(...); channel.send }`。
- **影响量化**：deliver 决策 × 设备数（≤8）次文案渲染 + String 分配；对 run-terminal 等低频事件可接受；若未来放宽 throttle 到高频事件则放大。
- **修复方案**：同一 decision 的 message **渲染一次**后对各 device 改写 id/seq（或共享 title/body Arc）。
- **回归锚点**：多设备 dispatch 单测。

---

#### PSHP08.【低】决策引擎 Mutex 在每次 emit 持锁 decide

- **位置**：`pusher.rs:374-386`
- **影响量化**：短临界区（无 IO）；锁损坏时 skip 事件（fail-open 丢推送而非崩溃）。与 03-P10 锁纪律一致。**可接受**。
- **修复方案**：无需；可选将 engine 拆为 thread-local + 周期合并，非必要。

---

### 4.5 Telemetry 域（TEL）

---

#### TEL01.【高】`cleanup_logs` 壳层从未调用——日志目录只增不减

- **位置**：`crates/conex-telemetry/src/file.rs:355`；壳层 `main.rs:665-684` 仅 `init_default` + panic hook
- **现场**：库实现与单测完备（7 天 / 50MB / crash 保留 3）；`apps/agent-workbench/src-tauri` **无 `cleanup_logs` 调用方**（rg 实证；稳定性文档 `docs/stability-closure/10-analysis/02-runtime-health-observability.md:15` 同判）。
- **调用链**：设计意图「启动时执行一次」——**断链**。
- **影响量化**：当前单日体量小则无感；长期（尤其 debug 级日志 + 崩溃文件）目录单调涨，磁盘占用无上界。对照 50MB 策略形同虚设。静态分析，待 V3。
- **修复方案**：`main.rs` 在 `init_default` 后 `spawn_blocking` 调一次 `cleanup_logs(&log_dir, &LogRetention::default())`；或接入已有稳定性 H9 方案。
- **回归锚点**：启动后目录策略单测（库层已有）；壳层 smoke 断言调用次数。

---

#### TEL02.【中】双通道 `file.and(stderr)` 每行同步写文件+stderr，挂在 tracing 调用线程

- **位置**：`subscriber.rs:88-93`；写路径 `file.rs:230-269`
- **现场**：`with_writer(writer.and(std::io::stderr))`——每条日志：状态锁 → try_clone → `write_all` 文件 → stderr。
- **调用链**：任意 `tracing::*` → subscriber → 阻塞调用线程。
- **根因**：无异步 appender；与 PE-04 双通道设计一致，但**未把写挪出热路径**。
- **影响量化**：正常 info 体量下 µs～ms；若引擎热路径（token delta）打 debug 日志且 `CRISH_LOG_LEVEL=debug`（`main.rs:651-658` debug 默认），**每 delta 可能多两次同步写**——与 03-R1 叠乘。Windows stderr 在无 console 时可能极慢。静态分析，待 V1。
- **修复方案**：① 热路径日志降为 `trace` 或采样；② 文件层改 ring buffer + 后台 flush 线程；③ release 默认 info 已正确，确认 debug 构建诊断文档。
- **回归锚点**：写路径 open 计数测试已有（`resident_handle_reuse_limits_opens`）；可加「emit 热路径零 file write」的 span 配置检查。

---

#### TEL03.【中】每条日志 `std::Mutex` + `try_clone` 文件句柄

- **位置**：`file.rs:137-162, 286-291`
- **影响量化**：锁竞争在多线程高频日志时串行化；`try_clone` 为 OS 句柄复制，相对 write 便宜。当前量级可接受，**高 QPS 日志场景**需改 per-thread sink。
- **修复方案**：批量缓冲或分片锁；非紧急。
- **回归锚点**：现有 ACT-103 测试。

---

#### TEL04.【低】非 UTF-8 截断可能切断多字节字符

- **位置**：`file.rs:251-258`
- **影响量化**：仅脏字节输入；UTF-8 正常路径走 `truncate_string`。**日志可读性**问题，非性能。
- **修复方案**：截断时向字符边界回退 1–3 字节。

---

#### TEL05.【低】panic hook 同步写 crash 文件 + tracing（崩溃路径）

- **位置**：`panic_hook.rs:111-178`
- **影响量化**：崩溃一次性成本，正确性优先。**可接受**。

---

#### TEL06.【低 / 架构事实】conex-telemetry **无远程上传 / 批处理 / 上报频率**

- **位置**：`crates/conex-telemetry/src/lib.rs:1-36` 及全 crate 无 `reqwest`/HTTP 依赖
- **结论**：本 crate 是**本地结构化日志 + panic** 层。「上传频率 / 批处理体积」在当前代码**不存在**；性能问题收敛为**本地写路径与保留策略**（TEL01–03）。若未来引入远程上报，需单独立项设计批处理与采样。
- **交叉**：方向 16（可观测性）若规划 OTLP/上报，回看本结论。

---

### 4.6 交叉项（XOV）

---

#### XOV01.【高】多端开启时每引擎事件 ≥3 次全量 JSON 解析（webview 序列化 + fanout parse + push parse）

- **位置**：装配链 `main.rs:876-886`（push 恒挂）+ `main.rs:1087-1088`（fanout attach）+ 引擎 emit
- **现场**：同一 `payload: &str` 在 EventBridge 汇聚后：
  1. TauriEmitter 序列化投递（webview）；
  2. FanOutEmitter（有订阅者）→ `parse_event_meta`；
  3. PushAwareEmitter → `parse_event_payload`。
- **与 03 的关系**：
  - 03-R1：token 逐条 emit → 事件数 N 被放大；
  - 03-P9：正面对 fanout/push 背压记正面；
  - 本方向补充：**解析成本是结构性的**，且 push 侧无「无设备短路」。
- **影响量化**：N_events × (2× AgentEvent 构造 + 2× Value clone) + 序列化。对活跃多端会话，IPC 之外的**引擎线程 CPU** 显著。静态分析，待 V1/V5。
- **修复方案批次**：见 §五 批次 W/X/Y；与 03 批次 K/N 联动。
- **回归锚点**：多端开/关 emit 耗时对比 bench（V5）。

---

## 五、修复路线图（逻辑依赖，不谈工期）

> 批次按「效果完整度 → 正确性 → 可验证性」排序；问题同权，批次字母仅为锚点。

### 批次 W —— 正确性止血（功能缺陷即性能缺陷）

| 项 | 内容 | 锚点 |
| -- | ---- | ---- |
| W1 | relay `last_active` 刷新（forward/PING touch） | RLY01 |
| W2 | relay 帧长上限常量 + decode 拒绝 | RLY02 |
| W3 | relay Pong 回源端语义修正 | RLY06 |
| W4 | push 周期 `send_pending_batch` 装配 + 无通道跳过 | PSHP02, PSHP06 |
| W5 | `PendingApprovalStore` 装配 + 内存 pending 上限 | PSHP01 |
| W6 | `cleanup_logs` 启动接线 | TEL01 |

### 批次 X —— 热路径减负（不改契约）

| 项 | 内容 | 锚点 |
| -- | ---- | ---- |
| X1 | push 侧 type 白名单预筛（非场景事件零 parse） | PSHP03 |
| X2 | fanout/push 消除 `value.clone()`；元信息轻量解析 | FAN01, PSHP03 |
| X3 | dispatch 同 decision 共享文案渲染 | PSHP07 |
| X4 | `device_activities` 快照缓存（可选） | SRV02 |
| X5 | fanout publish 锁外遍历（可选） | SRV03 |

### 批次 Y —— 内存与慢性增长

| 项 | 内容 | 锚点 |
| -- | ---- | ---- |
| Y1 | `task_owner_run` / `run_term_source` prune | PSHP04 |
| Y2 | `folded` 上限 + 定时 `take_night_summary` | PSHP05 |
| Y3 | Critical 硬顶 + 触顶踢连接 | SRV04 |
| Y4 | relay `RELAY_MAX_CONNS` | RLY04 |

### 批次 Z —— 可观测性与契约增强（需评审）

| 项 | 内容 | 锚点 |
| -- | ---- | ---- |
| Z1 | 信封注入 backpressure/push hint 字段 | FAN01/PSHP03 |
| Z2 | `pending_len` / `dropped_total` / fanout 队列水位 → status_diagnostics | PSHP01, G2 |
| Z3 | Telemetry 热路径写异步化设计评审 | TEL02/03 |

**性价比最高批次**：**W**（正确性，多处为「接线/补 touch」而非架构重写）+ **X1/X2**（解析减半，不动契约）。

---

## 六、运行时验证建议（V 项，待回填）

| V# | 项 | 方法 | 关联发现 |
| -- | -- | ---- | -------- |
| V1 | 多端开启活跃 run 的 CPU profile | Tauri MCP / 采样：push/fanout 解析占比 | PSHP03, FAN01, TEL02, XOV01 |
| V2 | 离线设备 + 高频事件 pending_len 曲线 | 日志或诊断字段观测 1h | PSHP01/02 |
| V3 | 日志目录 7 天增长 vs 50MB | 复现 cleanup 未接线下的磁盘占用 | TEL01 |
| V4 | Relay 活跃转发 10min 是否被 GC | 双客户端持续互发 + GC 日志 | RLY01 |
| V5 | 8 设备连接下 emit P50/P99（多端开 vs 关） | 微基准 / 临时计时 | XOV01, PSHP03 |
| V6 | 首次 TLS 生成 / CA 轮换耗时 | enable 服务计时 | MDC01 |
| V7 | 厂商凭据缺失时空转 CPU（若接上 W4） | 无通道列表 tick | PSHP06 |

**标注纪律**：本报告全部影响量化在 V 回填前均为**静态分析结论**。

---

## 七、交叉引用

| 来源 | 关系 |
| ---- | ---- |
| `03-IPC通道性能审查报告.md` R1/R2/P9 | R1 放大本方向解析次数；P9 正面背压与本文 SRV/G2 一致；P9 旁路全量反解析与 FAN01/PSHP03 同根 |
| `07-启动链路性能审查报告.md` | TLS 生成不在 entry 主路径，在服务 enable/rebind（MDC01） |
| `docs/stability-closure/10-analysis/02-runtime-health-observability.md` | cleanup_logs 未接线与 TEL01 同判 |
| 方向 16 可观测性 | Z2 指标面；TEL 本地层定位（TEL06） |
| `docs/multi-device/plans/D7-push-notifications.md` | 推送规格真源；装配缺口是实现进度问题 |
| 移动端 `EndpointResolver` | `DEFAULT_RELAY_PORT` 死常量，与 `crates/conex-relay` 部署态分离（性能无关，防误接） |

---

## 八、附录

### 8.1 发现索引（机器可读）

见 `docs/performance-audit/materials/15-发现索引.md`。

### 8.2 严重度判定理由（本方向）

| 级 | 判定 |
| -- | ---- |
| 高 | 无界增长 / 生产断链 / 每事件结构性放大 / 功能性 GC 误杀 |
| 中 | 有界但可优化的锁/克隆/超限策略、冷路径同步 IO、慢性 Map 泄漏 |
| 低 | 美学/可读性/崩溃路径/低频命令 |

### 8.3 与 AGENTS / 门禁

- 未执行 `git commit`（遵从任务与仓库 §3 提交纪律）。
- 本方向未改生产代码；仅新增审查文档。
- 全量检查命令清单见 `FULL_CHECK_COMMANDS.md`；代码变更后由主控统一跑。

### 8.4 锁与队列拓扑速查

| 结构 | 锁类型 | 容量 | 持有方 | 跨 await？ |
| ---- | ------ | ---- | ------ | ----------- |
| relay `SessionRegistry.rooms` | `tokio::RwLock` | 无界 HashMap | 全局 | write 路径短 |
| relay peer `mpsc` | 无 | 64 | 每连接 | send_timeout 500ms |
| `WsRegistry.inner` | `std::Mutex` | ≤8 conn | 全局 | 否 |
| fanout `subscribers` | `std::Mutex` | ≤8 | 全局 | 否 |
| fanout 每连接 queue | `std::Mutex` | 512（Critical 可破） | 每连接 | 否 |
| ws out_tx | `mpsc` | 512 | 每连接 | drain 对 Critical `send().await` |
| push `pending` | `std::Mutex<VecDeque>` | **无界** | 全局 dispatcher | 否 |
| push engine | `std::Mutex<PushDecisionEngine>` | — | 全局 | 否 |
| telemetry file state | `std::Mutex<DailyState>` | — | 全局 writer | 否（同步 write） |

**纪律结论**：协作通道侧**无 std Mutex 跨 await**；relay 使用 tokio RwLock + send_timeout 正确。风险集中在 **无界 pending** 与 **同步日志写在 emit 线程**。

### 8.5 push 决策管线阶段成本表

| 阶段 | 文件 | 每事件成本 | 生产接线 |
| ---- | ---- | ---------- | -------- |
| parse 信封 + AgentEvent | `pusher.rs:411-419` | 2× serde + clone | ✅ 恒开 |
| intent 登记表匹配 | `intent.rs` | O(场景数) 纯函数 | ✅ |
| S10a 抑制查表 | `engine.rs:205-216` | O(1) | ✅ |
| quiet / dedupe / coalesce / throttle | `engine.rs` | O(1)～O(桶) | ✅ |
| flush 合并桶 | `main.rs:1037` | 事件驱动 | ✅ |
| `take_pending` → 厂商 | `consumer.rs` | 批量 | ❌ **未接** |
| SQLite pending 恢复 | `pending.rs:181` | 批量 SQL | ❌ **未注入** |
| 审批 SQLite 去重 | `dedupe.rs` SqliteDedupe | 按键路由 | ❌ **默认 Memory** |
| 夜间摘要 take | `engine.rs:335` | 定时 | ❌ **未接** |

### 8.6 telemetry 写路径微结构

```text
tracing::info!(...)
  → Subscriber (EnvFilter)
  → MakeWriter::make_writer  (file.rs:286)
       → DailyState Mutex lock
       → 轮转判定（day_key / written_bytes）
       → try_clone(File)  或  open 新分片
  → FileSink::write_all
       → 可选 8KB 截断
       → fs::File::write_all   ← 同步阻塞调用线程
  → stderr write               ← 双通道第二写
```

**正面对照**：常驻句柄消灭了 per-line open/stat（ACT-103）；**缺口**是同步写 + 双通道 + 保留策略未接线。

### 8.7 审计执行说明

- 执行：方向 15 静态走读（2026-09-13）。
- 覆盖文件（逐一打开走读）：
  - `crates/conex-relay/src/{lib,main,protocol,server,session,ticket}.rs`
  - `crates/conex-telemetry/src/{lib,subscriber,file,redact,panic_hook,crash}.rs`
  - `apps/agent-workbench/src-tauri/src/multi_device/{mod,tls}.rs`
  - `multi_device_commands.rs`、`multi_device_network.rs`、`push_wiring.rs`
  - `push/{mod,pusher,engine,intent,coalesce,dedupe,throttle,online,pending,vendor/*}.rs`
  - `server/{ws,fanout,gateway}.rs` 关键段
  - `main.rs` 装配面 650–1130
- 未覆盖：apns/hms HTTP 细节性能（协议层正确性已有测试面）、移动端重连策略实现细节、core_backend REST 轮询（属 03/16 边界）、`server/pairing.rs` 热路径（配对为冷路径）。
- 工具：静态 rg + 人工走读；无运行时采样（见 V1–V7）。

### 8.8 严重度分布与 TOP3 复核

| 严重度 | 数量 | 编号 |
| ------ | ---- | ---- |
| 高 | 8 | RLY01, RLY02, FAN01, PSHP01, PSHP02, PSHP03, TEL01, XOV01 |
| 中 | 12 | RLY03/04, MDC01, SRV01–04, PSHP04–07, TEL02/03 |
| 低 | 9 | RLY05/06, MDC02, PSHP08/09, TEL04–06 |

**TOP3 复核（与 §二一致）**：

1. PSHP01+PSHP02（离线队列无界 + 消费未接线）
2. PSHP03+FAN01+XOV01（每事件全量反解析叠乘）
3. RLY01（relay GC 误杀）

**与材料索引口径**：`materials/15-发现索引.md` 将 XOV01 计入交叉项、TEL06 计低，高危列表与主报告 TOP3 对齐。

---

_方向 15 完成。下一方向建议由总纲调度：16（可观测性与既有 perf 资产）或回填 08/09/11/12 中任一。_
