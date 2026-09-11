# 移动端长连接网关与游标对账深入审计报告

> **审计维度**：04 - 长连接网关与游标对账（Network Gateway & Cursor Reconcile）
> **审计对象**：
> - `apps/crish-mobile/src/network/` 全域模块（`ReconnectingWsClient.ts`、`WsGateway.ts`、`WsEnvelope.ts`、`signer.ts`、`EndpointResolver.ts`、`protocolVersion.ts`、`HttpClient.ts`）
> - `apps/crish-mobile/src/adapters/wiring/observationWiring.ts`
> - `apps/crish-mobile/src/adapters/wiring/feedBridge.ts`
> - `apps/crish-mobile/src/adapters/wiring/pairing/sessionSigning.ts`
> - 桌面端对应契约与服务端（`crates/conex-types/`、`apps/agent-workbench/src-tauri/src/server/`）
>
> **审计性质**：只读调研与架构隐患穿透（严禁修改源码，不涉及笔记功能）

---

## 总体审计摘要

本专项针对移动端（`crish-mobile`）的网络通信基础底座、WebSocket 长连接生命周期状态机、帧编解码信封、消息级 HMAC 签名、5 类游标对账逻辑及与业务观测面适配层（`FeedBridge`/`observationWiring`）的接线实态进行了全面深度的源码级审计。

**核心审计结论**：
1. **纯逻辑层质量极高，但与接线层存在严重断层**：`ReconnectingWsClient` 的退避算法、心跳与假死检测、`classifyReconcile` 5 类对账语义、`signer.ts` 的 RFC 4231 HMAC 纯算法实现均具备完整的单元测试且逻辑严密；
2. **发现 4 处阻断级 P0 致命缺陷**：
   - **端点 URL 路径丢失**：`EndpointResolver.resolveWsUrl` 产出 `wss://host:8765`，未挂载桌面服务强制要求的 `/v1/events` 路由且未附带 `?token=`，真实通信在 HTTP 握手阶段即被 404/401 拦截；
   - **订阅握手缺失**：全局未发送 `events.subscribe` 订阅帧，导致桌面 FanOut 过滤器为空，`events.subscribe.ok` 从未返回，审批同步对账（`approvalWiring.onSyncReady`）与实时推流处于死锁状态；
   - **全量重放丢弃 Bug**：`FeedBridge.handleProjection` 处理 `fullReplay` 时未重置本地事件窗口的 `lastSeq`，导致后端重放的 sequence 全部触发 `seq <= window.lastSeq` 而被作为 `duplicate` 丢弃；
   - **连接打开事件时序竞态**：`ReconnectingWsClient.handleOpen` 在调用 `this.gateway.attachSend` **之前** 就调用了 `this.setPhase('open')`，导致观察面在相位回调中发起的 `remote.listDevices` 等请求因 `sendFn == null` 必然失败；
3. **存在多处死层与骨架残留**：`ReconnectingWsClient.setupRoutes` 内有 3 处空监听；`opts.projections` 占位但从未传入；`HttpClient.ts` 为无用空壳。

---

## 一、连接生命周期状态机审计

### 1.1 状态机模型与相位流转（M5 §4.3.1）

`ReconnectingWsClient` 定义了 5 种连接相位：`WsPhase = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'dead'`。状态转移严格遵循单向环路与守卫约束：

```
                   ┌───────────────── connect() ─────────────────┐
                   │                                             │
                   ▼                                             │
               ┌────────┐     ws.onopen      ┌──────┐            │
 [Initial] ──► │  idle  ├──────────────────► │ open ├──────┐     │
               └────┬───┘                    └──┬───┘      │     │
                    │                           │          │     │
                 connect()                  ws.onclose  disconnect()
                    │                      (意外断开)       │     │
                    ▼                           │          │     │
              ┌────────────┐                    ▼          │     │
              │ connecting │ ◄───────── ┌──────────────┐   │     │
              └─────┬──────┘  退避定时器  │ reconnecting│   │     │
                    │         到期      └───────┬──────┘   │     │
                 ws.onclose                     │          │     │
                 /onerror                       │          │     │
                    │                           │          │     │
                    ▼                  重试超限(>5) / offline │
              ┌────────────┐                    │          │     │
              │    dead    │ ◄──────────────────┴──────────┘     │
              └─────┬──────┘                                     │
                    │                                            │
                    └───────────────── connect() ────────────────┘
```

#### 关键流转逻辑审查：
1. **连接防重入守卫**（`ReconnectingWsClient.ts:349-363`）：
   ```typescript
   connect(): void {
     if (this.phaseValue === 'connecting' || this.phaseValue === 'open') return;
     this.cancelReconnectTimer();
     this.retryCountValue = 0;
     this.manualClose = false;
     if (this.ws) {
       const stale = this.ws;
       this.ws = null;
       this.detachSocketHandlers(stale);
       stale.close();
     }
     this.setPhase('connecting');
     this.openSocket();
   }
   ```
   - **优点**：在创建新 socket 前，显式解绑并关闭旧 `ws` 实例，杜绝了 `onerror` 之后未触发 `onclose` 时的双连接泄漏风险；退避计时器被即时取消，重置重试计数。
   - **盲区**：若处于 `connecting` 阶段但网络由于 TCP SYN 丢包挂起，由于无连接建立超时机制（Connect Timeout Timer），客户端将无限期卡在 `connecting`，`connect()` 也会因守卫直接 return。

2. **三层相位映射（Selectors 投影）**：
   - 客户端内部物理态：`WsPhase`（`idle`, `connecting`, `open`, `reconnecting`, `dead`）
   - 事件流域网络态（`eventStore.network`，F3 §3.2.1）：
     - `open` → `live`
     - `reconnecting` → `reconnecting`
     - 其余（`idle`, `connecting`, `dead`）→ `offline`
   - UI 展示连接态（`connectionStore.phase`，`mapWsPhase`）：
     - `idle` → `disconnected`
     - `connecting` → `connecting`
     - `open` → `connected`
     - `reconnecting` → `reconnecting`
     - `dead` → `error`

---

### 1.2 心跳机制与假死检测（D3 §9.3）

协议常量锁定源自 `crates/conex-types/src/device/version.rs`：
- `HEARTBEAT_INTERVAL_MS = 30_000`（30 秒发送节拍）
- `HEARTBEAT_TIMEOUT_FACTOR = 3`（3 倍判定因子）
- `HEARTBEAT_DEAD_MS = 90_000`（90 秒判定假死）

#### 心跳检测闭环（`ReconnectingWsClient.ts:468-505`）：
1. **节拍发送**：仅在 `phaseValue === 'open'` 时由 `setInterval`（每 30s）触发 `heartbeatTick()`。当 `now - lastTxMs >= 30_000` 时，调用 `this.gateway.send('heartbeat', { ts: now, deviceTimeMs: now })`。
2. **假死判定**：在同一个 tick 周期检查 `isHeartbeatDead(this.lastRxMs, now, factor)`。若距上次收包超过 90s，执行 `this.ws?.close()` 主动掐断连接，利用底层 `onclose` 推进重连。
3. **包到达感知**：在 `handleMessage` 中第一行调用 `this.markRx()`。因此，**对端发送的任何合法文本帧（包括业务推送 `events.push`、`heartbeat.ok`、RPC 回执等）都会刷新 `lastRxMs`**，避免因业务繁忙而误发冗余保活检测。
4. **时钟校准留点**：`this.gateway.on('heartbeat.ok')` 提取服务端的 `ts` 与 `serverTime` 暂存于 `this.lastHeartbeatOkValue`，为后续时钟偏差校准预留输入。

---

### 1.3 指数退避与抖动算法（D4 §6.2.4）

退避公式：
$$\text{delay} = \min\left(\text{baseMs} \times \text{multiplier}^{\text{retryCount}}, \text{capMs}\right) + \text{random}[0, \text{jitterMaxMs})$$
- 默认参数：`baseMs = 1,000`，`multiplier = 2`，`capMs = 30,000`，`jitterMaxMs = 1,000`。
- 理论序列（去抖动）：1s → 2s → 4s → 8s → 16s → 30s（封顶）。
- 抖动引入：离散全开区间 `[delay, delay + 1000ms)`，有效避免集群重连惊群效应。

#### 退避重连执行机制（`ReconnectingWsClient.ts:441-457`）：
```typescript
private scheduleReconnect(): void {
  this.retryCountValue += 1;
  if (this.opts.offline?.() || this.retryCountValue > this.maxRetries) {
    this.setPhase('dead');
    return;
  }
  this.setPhase('reconnecting');
  const delay = nextRetryDelayMs(this.retryCountValue - 1, {
    capMs: this.opts.maxRetryMs,
    jitterMaxMs: this.opts.jitterMaxMs,
  });
  this.reconnectTimer = setTimeout(() => {
    this.reconnectTimer = null;
    this.setPhase('connecting');
    this.openSocket();
  }, delay);
}
```
- **重试上限**：默认 `maxRetries = 5`。当第 6 次失败（`retryCountValue = 6 > 5`）时，立即切换为 `'dead'` 终态，并停止设置定时器。
- **离线守卫**：若注入的 `offline()` 返回 `true`，立即判死为 `'dead'`，不再发起任何无意义重试。

---

### 1.4 主动断开与异常清理语义（R2B §4 / M5 §4.3.2）

代码在主动断开与被动断开的处理上具备清晰的对称性与状态隔离：

| 特性 | 主动断开 `disconnect()` | 异常关闭 `handleClose()` |
| :--- | :--- | :--- |
| **触发场景** | 用户退出、App 进入后台深度冻结、切换配对 | 网络掉线、对端关闭、假死判定超时强制 close |
| **manualClose 标记** | 设为 `true` | 读取到 `true` 时直接退出；否则处理异常断开 |
| **定时器清理** | `cancelReconnectTimer()` + `stopHeartbeat()` | `stopHeartbeat()`（重连定时器后续由 scheduleReconnect 设置） |
| **挂起请求处理** | `abortAllPending(new GatewayError('cmd.cancelled', '连接已主动断开', false))` | `abortAllPending(new GatewayError('transport.closed', '连接被对端关闭', true))` |
| **错误可重试性** | `retryable: false`（指令已撤销，禁止重试） | `retryable: true`（传输层中断，允许 outbox 幂等重发） |
| **后续相位** | 直接切为 `'idle'`，**不进入重连** | 推进至 `'reconnecting'` 或 `'dead'` |
| **Socket 卸载** | `detachSocketHandlers(ws)` 后 `ws.close()`，不触发 `onclose` | `this.ws = null`，等待重连开启新 socket |

---

## 二、网关信封编解码与请求响应路由审计

### 2.1 帧尺寸与限制（`MAX_FRAME_BYTES` = 1MB）

- 常量定义：`MAX_FRAME_BYTES = 1_048_576`（1 MiB，对齐 D3 §5.5 与 Rust `version.rs`）。
- **出站编码校验（`WsGateway.ts:68-77`）**：
  ```typescript
  export function encodeFrame(frame: OutgoingEnvelope): string {
    const raw = JSON.stringify(frame);
    if (raw.length > MAX_FRAME_BYTES) {
      throw new FrameEncodeError(
        'frame_too_large',
        `帧超上限（${raw.length} > ${MAX_FRAME_BYTES} 字节）：${frame.kind}`
      );
    }
    return raw;
  }
  ```
- **入站解码校验（`WsGateway.ts:80`）**：
  - **严重缺陷**：`decodeFrame(raw: string)` 中**完全没有校验帧大小**！注释第 14 行标称 `超 MAX_FRAME_BYTES → frame_too_large（D3 §5.5 超限断链语义）`，但函数体内第一行直接执行 `JSON.parse(raw)`，未对 `raw.length` 做任何门禁截断，存在超大帧解析导致 JS 引擎内存溢出风险。
- **字符串长度 vs UTF-8 字节数失配**：
  - `raw.length` 检测的是 JavaScript UTF-16 Code Unit 数量，并非网络传输的 UTF-8 字节数！
  - 若 payload 包含大量中文（如日志、代码 diff、多 Agent 汇报），每个中文字符占 3 字节，但 `raw.length` 仅计 1。例如 40 万字的中文字符串，`raw.length` 为 400,000（< 1MB），但实际 UTF-8 字节数为 1.2MB。此帧发往桌面端时，桌面 Rust `ws.rs` 检查 `bytes.len() > MAX_FRAME_BYTES`，会直接判定超限切断连接！

---

### 2.2 编解码流水线与宽容丢弃（D3 §10.2 / §10.3）

入站帧解码 `decodeFrame` 实现了极其严密的 5 层守卫，符合健壮性原则（Robustness Principle）：

```
[原始字符串 raw]
       │
       ├─► 1. JSON 解析 ─────── 失败 ──► { ok: false, error: { code: 'cmd.invalid', drop: true } }
       │
       ├─► 2. 版本校验 (v === 1) ─ 不匹配 ──► { ok: false, error: { code: 'version_mismatch', drop: true } }
       │
       ├─► 3. kind 白名单检测 ── 未注册 ──► { ok: false, error: { code: 'cmd.unknown', drop: true } }
       │     (DEVICE_KINDS 103种)             (【关键】：宽容丢弃，记日志，不回发错误帧，不打断连接)
       │
       ├─► 4. 基础信封字段校验 ─ 非法 ──► { ok: false, error: { code: 'cmd.invalid', drop: true } }
       │     (msgId 非空 / ts 非负整数 / from、to 枚举)
       │
       ├─► 5. 载荷结构校验 ───── 失败 ──► { ok: false, error: { code: 'cmd.invalid', drop: true } }
       │     (生成器 parseDeviceMessage)
       ▼
[合法 InboundEnvelope]
```

- **协议兼容性体现**：对于旧版本移动端收到桌面端新增的未来 `kind`，或因中间件注入的未知帧，系统返回 `drop: true`。`ReconnectingWsClient.handleMessage` 捕获后仅打印 warning 并安全丢弃，不向对端发送 `error` 帧，绝不切断长连接。

---

### 2.3 请求-响应关联与生命周期（M6 §3.3 / D3 §5.4）

1. **`msgId` 生成规则（`WsGateway.ts:297-301`）**：
   - 格式：`m-${prefix}-${seq}-${suffix}`，如 `m-mob-0042-8f9x2a`。
   - `seq` 取自内部自增计数器（模 1,000,000，4 位补零），`suffix` 为 6 位随机 base36 串。全局唯一，且出站保持稳定。
2. **`invoke<T>` 请求挂起模型（`WsGateway.ts:362-405`）**：
   - 生成唯一 `msgId`，存入 `this.pending` Map。
   - 设置超时定时器（默认 10s，`DEFAULT_INVOKE_TIMEOUT_MS`）。超时触发时从 Map 剔除并 reject `cmd.timeout`（`retryable: true`）。
   - 将发送委托给绑定的 `this.sendFn`。若 `sendFn` 抛错，立即清理 timer 并 reject。
3. **响应帧匹配与路由（`WsGateway.ts:455-479`）**：
   - 监听所有入站帧：当 `frame.kind === 'error' || frame.kind.startsWith('result.')` 时触发响应匹配。
   - 提取 `frame.body.reqMsgId`。若命中 `pending`：
     - 取出对应 `PendingRequest` 并清除超时定时器；
     - 若帧为 `'error'`：归一化为 `GatewayError` 并 reject；
     - 若帧为 `'result.*'`：检查 `body.ok === true`，成功则 resolve，失败则以 `body.error` reject；
     - 从 `pending` 彻底移除该请求。
   - **未匹配响应处理**：
     - 未匹配 pending 的 `result.*`：直接丢弃（不进入事件总线）；
     - 未匹配 pending 的 `error` 帧：视为服务端全局异步错误广播，广播给订阅了 `'error'` 或 `'*'` 的订阅者。
4. **其余普通事件**：
   - 广播给对应精确 `kind` 订阅者与通配符 `'*'` 订阅者。订阅快照执行防重入：`for (const h of [...exact]) h(frame)`。

---

### 2.4 会话鉴权与 HMAC 签名（signer.ts 与 sessionSigning.ts）

#### 规范化签名串生成（Canonical Signing Payload）：
协议真源与 Rust `crates/conex-types/src/device/envelope.rs` 逐字节对齐：
$$\text{payload} = \text{deviceId} \parallel \text{ts} \parallel \text{nonce} \parallel \text{msgId} \parallel \text{kind} \parallel v \parallel \text{canonicalJsonStringify(body)}$$
- **排序纪律**：`canonicalJsonStringify` 对 JSON 对象进行递归键字典排序（`Object.keys(body).sort()`），消除 JavaScript 对象无序性与 Rust `serde_json::Map`（BTreeMap）输出的字节差异。
- **排除字段**：`from` 与 `to` 不参与签名输入，解决了 M6 规范初稿与 D3/Rust 实现的漂移。

#### 加密实现与安全性：
- **纯 JS 算法实现**：`signer.ts` 内置了完整的 FIPS 180-4 SHA-256 和 RFC 2104 HMAC 实现，通过了 RFC 4231 标准测试向量。不依赖 Node 原生 `crypto` 或特定平台模块，确保在 Hermes 引擎与 React Native 各端表现一致。
- **恒定时间防侧信道**（`constantTimeEqual`，`signer.ts:241-247`）：
  ```typescript
  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
  ```
  校验签名时使用 XOR 累加比对，防御时序侧信道攻击。

---

## 三、对账机制严密性分析

### 3.1 对账分类语义（`classifyReconcile`）

对账快照输入结构：
```typescript
export interface ReconcileSnapshot {
  sessionId: string;
  localCursor?: number; // 本地游标（undefined 表示本地无投影）
  serverNext: number;   // 服务端当前 max sequence（-1 表示服务端已无此会话）
  serverStale: boolean; // 服务端判定本地游标已过期失效
}
```

5 类对账语义分类（`ReconnectingWsClient.ts:173-184`）：
```typescript
export function classifyReconcile(
  snap: ReconcileSnapshot,
  rebuildThreshold = RECONCILE_REBUILD_THRESHOLD
): ReconcileAction {
  if (snap.localCursor === undefined) return 'fresh';
  if (snap.serverNext < 0) return 'cleanup';
  if (snap.serverStale) return 'full-replay';
  if (snap.serverNext - snap.localCursor > rebuildThreshold)
    return 'full-replay';
  if (snap.serverNext > snap.localCursor) return 'resume';
  return 'noop';
}
```

#### 语义评估与边界测试结果：
| 分类 | 触发条件 | 业务含义 | 评估与潜在问题 |
| :--- | :--- | :--- | :--- |
| **`fresh`** | `localCursor === undefined` | 权威存在但本地无投影，写入投影并从 0 开始拉取 | **条件优先度缺陷**：若本地无游标且 `serverNext < 0`（服务端已删除），首条命中会返回 `fresh`，试图拉取一个服务端不存在的会话。 |
| **`cleanup`** | `serverNext < 0` | 服务端已彻底删除此会话，清理本地投影、游标与队列 | 正确。触发本地 `sessionStore.remove` 与 `eventStore.unloadWindow`。 |
| **`full-replay`** | `serverStale === true` 或落后超 5000 | 游标过期或落后严重，放弃增量补齐，走快照/全量重建 | **存在接线层实现 Bug**（见下文 3.3 节）。 |
| **`resume`** | `serverNext > localCursor` 且未超阈值 | 增量补齐，按 `afterSequence = localCursor` 分页拉取 | 严密。契合 `afterSequence` 增量分页。 |
| **`noop`** | 游标一致（`serverNext === localCursor`） | 本地数据与权威完全一致，无需任何网络动作 | **异常状态回退盲区**：若 `localCursor > serverNext`（本地超前于服务端），此处也会返回 `noop`，掩盖了数据分歧。 |

---

### 3.2 重连投影纯函数（`projectReconnect`）

`projectReconnect` 接收连接相位、快照列表和 Outbox 挂起状态：
- **相位守卫**：若 `phase !== 'open'`，强制返回全空投影（`actions: []`, `outboxFlush: false` 等），保证只有在重连并握手完毕后才准许对账。
- **动作聚合**：将各会话 ID 按操作分类分别装入 `resume`、`fullReplay`、`cleanup`、`fresh` 数组。
- **队列对账**：若 `outboxPending === true`，标记 `outboxFlush = true`，驱动离线暂存的审批决策等命令以原 `msgId` 幂等重发。
- **全面留痕**：所有非 `noop` 分歧均记录详细的中文日志（`log`），严禁静默吞没状态差异。

---

### 3.3 接线实态与纯逻辑断层深度剖析（Wiring Reality Gap）

虽然纯函数（`classifyReconcile` 和 `projectReconnect`）逻辑与单测完备，但在深入审计其与 `observationWiring.ts`、`feedBridge.ts` 的装配接线时，发现了令人震惊的 **4 重架构断裂**：

#### 断裂 1：投影数据源永久饥饿（Projections 闭环未装配）
- 在 `ReconnectingWsClient.ts:515-527` 中：
  ```typescript
  private driveProjection(): void {
    const source = this.opts.projections?.() ?? {
      snapshots: [],
      outboxPending: false,
    };
    const projection = projectReconnect('open', source.snapshots, source.outboxPending);
    this.lastProjectionValue = projection;
    this.opts.onProjection?.(projection);
  }
  ```
- 查看 `observationWiring.ts:60-68` 中客户端的实例化：
  ```typescript
  const client = new ReconnectingWsClient({
    url: opts.url,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.factory ? { factory: opts.factory } : {}),
    gateway,
    onPhaseChange: (phase: WsPhase) => bridge.handlePhaseChange(phase),
    onProjection: (projection: ReconnectProjection) =>
      bridge.handleProjection(projection),
  });
  ```
- **现场实态**：`opts.projections` **根本没有传**！
- **后果**：每次连接建立时，`source` 永远退化为 `{ snapshots: [], outboxPending: false }`。`projectReconnect` 产出的 `resume`、`fullReplay`、`fresh`、`cleanup` 永远是空数组！`FeedBridge.handleProjection` 拿到的永远是空载荷！

#### 断裂 2：时序倒置与缺少订阅响应输入
- 对账快照中的 `serverNext` 和 `serverStale` 必须从服务端的 `events.subscribe.ok` 回执帧中读取。
- 但 `ReconnectingWsClient` 在 `handleOpen`（WebSocket 刚建连成功的瞬间）就同步调用了 `driveProjection()`。此时客户端连 `events.subscribe` 都不曾发送，更不可能收到服务端的序列号，根本无法构造出真实的 `ReconcileSnapshot`！

#### 断裂 3：`events.subscribe` 全局从未发送
- 桌面端服务（`apps/agent-workbench/src-tauri/src/server/ws.rs:1226`）要求客户端连接后发送 `events.subscribe` 建立会话过滤器并返回 `events.subscribe.ok`。
- 检索移动端全仓代码，**没有任何一处代码调用 `gateway.send('events.subscribe', ...)` 或 `invoke('events.subscribe', ...)`**！
- 导致连锁反应：
  1. 服务端未收到订阅请求，内部 FanOut 过滤器为空，**桌面端的实时事件永远不会向移动端推送**；
  2. 服务端不会主动发送 `events.subscribe.ok`；
  3. `approvalWiring.ts:242` 注册的 `this.gateway.on('events.subscribe.ok', () => this.onSyncReady())` **永远无法被触发**，导致审批离线决策队列重连补发机制彻底瘫痪（单测之所以能过是因为单测手工 dispatch 了伪造的 `events.subscribe.ok` 帧）。

#### 断裂 4：全量重放（Full-Replay）帧被前端环形缓冲全部丢弃 Bug
- 当会话落入 `fullReplay` 时，`FeedBridge.ts:164-166` 执行：
  ```typescript
  for (const sessionId of projection.fullReplay) {
    this.resumeSession(sessionId, RESUME_FROM_ZERO); // afterSequence = 0
  }
  ```
- 服务端开始从 1 发送续传帧 `events.resume.page`。
- 帧流经 `feedBridge` -> `ingestRouter` -> `eventStore.hydrate` -> `event-ring-window.ts:hydrateFeed`。
- `hydrateFeed` 遍历每一帧调用 `appendFeed`（`packages/shared-utils/src/event-ring-window.ts:75-78`）：
  ```typescript
  if (seq <= window.lastSeq) {
    // 重复/回退 seq：已确认过（含被环形淘汰）→ 丢弃
    return 'duplicate';
  }
  ```
- **致命问题**：`FeedBridge` 在触发 `fullReplay` 时，**没有清空本地对应会话的 `window.entries` 和 `window.lastSeq`**！
  若本地游标原本为 6000，重放过来的 1~6000 号帧全部满足 `seq <= window.lastSeq`，**全部被当做 duplicate 丢弃**！快照重建实质完全失效。

---

## 四、重复与死层清单

在对 `apps/crish-mobile/src/network/` 和相关 wiring 进行穷尽审计时，识别出以下死代码、空存根与重复逻辑：

```
[network & wiring 代码库]
 ├── 1. 空监听存根 (ReconnectingWsClient.ts:538-546)
 │    ├── events.subscribe.ok ──── 空回调（被动留白）
 │    ├── events.resume.page ───── 空回调（真正消费在 FeedBridge）
 │    └── events.resume.done ───── 空回调（真正消费在 FeedBridge）
 │
 ├── 2. 未接线选项与死接口
 │    ├── ReconnectingWsClientOptions.token ── 传入后仅赋给 getter，从未参与 WS URL 构造或 Header
 │    ├── ReconnectingWsClientOptions.projections ── 声明了回调签名，但上层从未注入
 │    ├── ListSessionsRepository ── 会话索引全量拉取，ensureObservationWiring 从未注入，生产静默跳过
 │    └── EndpointResolver.ts ── DEFAULT_RELAY_PORT / resolveRelayUrl 中继逻辑完全未启用
 │
 ├── 3. 骨架空模块
 │    └── HttpClient.ts / HttpClient.test.ts ── 仅包含 baseUrl 和 opts getter，整个工程零引用
 │
 └── 4. 重复与冗余定义
      └── WsEnvelope.ts ── 对 @crish/shared-types 的 ContractEnvelope 重新包装为 OutgoingEnvelope，存在类型二次包裹
```

### 4.1 空实现存根与虚占位（Empty Stubs）
- **`ReconnectingWsClient.ts:538-546`**：
  ```typescript
  private setupRoutes(): void {
    this.gateway.on('events.subscribe.ok', () => {
      // R2-05：① 订阅对账——逐会话 nextSequence/stale 驱动 resume/full-replay 分类
    });
    this.gateway.on('events.resume.page', () => {
      // R2-05：续传分页应用（EventPage 契约；游标推进，(sessionId, sequence) 去重）
    });
    this.gateway.on('events.resume.done', () => {
      // R2-05：续传完成（resumedTo 水位；桌面恢复实时推流）
    });
    ...
  }
  ```
  这 3 个事件监听是完全无任何动作的空函数。而 `events.resume.page` 和 `events.resume.done` 已经在 `FeedBridge.ts` 中单独注册并由 `mapDeviceFrame` 处理。此类空监听徒增网关事件分发的遍历开销。

### 4.2 未接通的死接口与孤岛字段（Unwired Interfaces）
1. **`ReconnectingWsClientOptions.token`**：定义了 `token?: string`，但内部 `openSocket` 仅执行 `new WebSocket(this.opts.url)`，在未带 token 的情况下建立连接，此参数成为摆设。
2. **`ReconnectingWsClientOptions.projections`**：定义了对账数据源输入函数类型，但装配入口 `observationWiring.ts` 从未传入该参数。
3. **`ListSessionsRepository`**：`observationWiring.ts` 和 `feedBridge.ts` 声明了此接口用于全量会话同步，但无论在 `ensureObservationWiring` 还是其他业务入口，该参数均为空，导致 `FeedBridge.refreshSessions()` 永久 early-return。
4. **`EndpointResolver.ts:18`、`39-45`**：声明了 `DEFAULT_RELAY_PORT = 8765` 和 `resolveRelayUrl`。中继服务属于未来规划，当前代码纯属死层。

### 4.3 骨架模块残留（Dead Skeleton）
- **`HttpClient.ts`（24 行）与 `HttpClient.test.ts`（28 行）**：
  只声明了一个包含 `baseUrl` 与 `options` 的类，不具备实际发起网络请求的能力，且在 `apps/crish-mobile` 源码中除自身的单测外没有任何模块导入它。

---

## 五、潜在风险清单

按对端到端可用性与数据完整性的破坏程度分级呈现：

| 风险编号 | 严重级别 | 风险名称 | 涉及代码位置 | 现场证据与根因剖析 | 潜在后果 |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **R-01** | **P0** | **WS 目标端点缺失 `/v1/events` 与鉴权参数** | `EndpointResolver.ts:21-27`<br>`observationWiring.ts:85-89` | `resolveWsUrl` 产出 `wss://host:8765`。桌面端 axum 仅在 `/v1/events` 挂载了 WebSocket Upgrade。根路径 `/` 无 WS 路由。且无 `?token=` 参数。 | **真实环境下长连接 100% 连不上**（被桌面端返回 HTTP 404 或 401 拦截）。 |
| **R-02** | **P0** | **全局缺少 `events.subscribe` 发送调用** | `feedBridge.ts`<br>`approvalWiring.ts:242` | 全仓搜索不到任何发送 `events.subscribe` 的代码。桌面端无法建立推送过滤器，永远不发 `events.subscribe.ok`。 | **移动端收不到任何实时推流，审批同步队列重连补发永远不触发**。 |
| **R-03** | **P0** | **全量重放未重置游标导致数据静默丢弃** | `feedBridge.ts:164-166`<br>`packages/shared-utils/src/event-ring-window.ts:75-78` | `handleProjection` 处理 `fullReplay` 直接 `resumeSession(id, 0)`，但 `eventStore.windows[id].lastSeq` 保持原值。`appendFeed` 将所有重放数据判为 `seq <= lastSeq` 丢弃。 | **快照重建彻底失效，界面数据处于永久残缺或白屏态**。 |
| **R-04** | **P0** | **连接建立与出站管道绑定的时序竞态** | `ReconnectingWsClient.ts:397-401`<br>`feedBridge.ts:142-145` | `handleOpen` 执行顺序：`setPhase('open')`（触发 `onPhaseChange`）早于 `gateway.attachSend(...)`。`FeedBridge.handlePhaseChange` 立即调用 `queryDevicePresence`，此时 `sendFn == null` 直接抛错。 | **每次建连成功瞬间必然爆发 `transport.closed: 连接未就绪` 异常**。 |
| **R-05** | **P1** | **单帧 1MB 限制以 UTF-16 代码单元误判** | `WsGateway.ts:68-75` | `raw.length > MAX_FRAME_BYTES`。遇多字节 UTF-8 字符（如中文、特殊符号），字符数小于 100 万但实际字节数超 1MB。 | 客户端误认为合规并发出，被桌面端强制掐断连接。 |
| **R-06** | **P1** | **入站解码未做帧体积限制校验** | `WsGateway.ts:80` | `decodeFrame` 首行直接 `JSON.parse(raw)`，未按注释要求检查帧大小。 | 遇异常恶意大帧时容易造成移动端内存雪崩（OOM）。 |
| **R-07** | **P1** | **冷启动单例网关未注入会话签名** | `observationWiring.ts:81-92`<br>`pairing/sessionSigning.ts:87-98` | 首页加载直接调用 `ensureObservationWiring()` 时，创建的是裸 `WsGateway`（无签名）。仅在配对回调中才经由 `defaultConnectSession` 注入签名网关。 | **冷启动恢复登录后，出站帧因无 `auth` 签名被桌面端校验拦截**。 |
| **R-08** | **P1** | **重试 5 次（约 31 秒）后永久判死无自愈** | `ReconnectingWsClient.ts:443`<br>`observationWiring.ts:60-68` | `maxRetries` 默认为 5。未接入 React Native `NetInfo` 监听。在地下车库或弱网环境中，连续失败 5 次即进入 `dead` 终态。 | **网络恢复后客户端不会自动发起重连，必须强杀 App 重启**。 |
| **R-09** | **P2** | **时钟偏移校准捕获后未应用于出站帧** | `ReconnectingWsClient.ts:547-561`<br>`WsGateway.ts:371` | `heartbeat.ok` 解析了 `serverTime - ts`，但 `WsGateway.invoke` 发送请求时仍硬调用 `this.nowFn()`（即手机本地时间）。 | 手机本地时钟若快/慢超 5 分钟，出站签名将被桌面端以 `auth.timestamp_skewed` 拒绝。 |
| **R-10** | **P2** | **续传在途互斥锁断线未清** | `feedBridge.ts:62, 178-194` | `inflightResume` 记录正在续传的 `sessionId`。若在续传过程中 WS 意外断开，该 Set 未被清空。重连后触发续传会被 `has(sessionId)` 阻挡，直到 10 秒超时。 | 重连初期短暂阻塞增量续传。 |
| **R-11** | **P2** | **前端环形缓冲容量与对账重建阈值量级失配** | `feedBridge.ts:28-33`<br>`packages/shared-utils/src/event-ring-window.ts:21` | 前端窗口容量上限为 500 条（`FEED_RING_MAX`），对账重建阈值为 5000 条。当落后 1500 条时触发增量 `resume`，前端拉取后前面 1000 条立即被环形缓冲剔除。 | 浪费移动端流量与处理算力，拉取的历史事件大部分立即被丢弃。 |

---

## 六、修复演进与收敛路线建议

针对上述审计发现，建议主控在后续收敛阶段按如下逻辑顺序推进：

1. **修正端点与握手通道（根除 R-01）**：
   - 调整 `EndpointResolver.resolveWsUrl` 或在 `observationWiring` 中拼接规范的 `/v1/events` 路径；
   - 将 `authStore.token` 携带在 URL 查询参数 `?token=${encodeURIComponent(token)}` 中，打通与桌面端 `ws.rs` 的双通道握手。
2. **时序与出站绑定解耦（根除 R-04）**：
   - 在 `ReconnectingWsClient.handleOpen` 中，**必须先执行** `this.gateway.attachSend(...)`，**然后再执行** `this.setPhase('open')`；
   - 消除建连瞬间业务调用 `invoke` 失败的竞态条件。
3. **闭环会话订阅与对账数据流（根除 R-02、R-03）**：
   - 在连接 `open` 且 `attachSend` 就绪后，由 `FeedBridge` 发送 `events.subscribe` 帧（携带当前活跃会话列表与对应游标）；
   - 在收到 `events.subscribe.ok` 回执时，提取各会话权威序列号组装 `ReconcileSnapshot`，触发 `driveProjection`；
   - 在 `FeedBridge.handleProjection` 收到 `fullReplay` 动作时，**必须先调用 `eventStore.getState().unloadWindow(sessionId)` 清空本地游标与条目**，再发起 `afterSequence = 0` 的全量拉取。
4. **健全会话签名与持久化恢复（根除 R-07）**：
   - 在 `ensureObservationWiring` 启动时，检测本地 `secureStore` 是否已配对；若已配对，直接通过 `buildSessionGateway(deviceId, tokenKey)` 创建签名网关并注入，防止冷启动出站帧无签名。
5. **清理死代码与多余存根**：
   - 移除 `ReconnectingWsClient.setupRoutes` 中的 3 处空监听；
   - 彻底删除孤岛模块 `HttpClient.ts`。

---

*报告生成完成。请主控查阅本报告作为后续综合治理详案的核心输入。*
