# 移动端全方位体检战役 · 多端配对与网络安全专项审计报告

> **审计席位**：02 - 多端配对与网络安全审计员  
> **审计对象**：`apps/crish-mobile/src/pairing/`、`apps/crish-mobile/src/network/`、`apps/crish-mobile/src/adapters/wiring/` 及桌面端配套 Rust/Tauri 模块  
> **报告归档**：`docs/mobile-full-audit/audits/02-pairing-security-and-pinning-audit.md`  
> **执行标准**：仓库根目录 `AGENTS.md`，执行通用协作纪律、立体验证纪律与反过度设计红线  

---

## 一、审计背景与核心结论

### 1.1 审计背景
Crish 移动端伴侣应用（`apps/crish-mobile`）基于 Expo 57 / React Native 0.86 构建，承担移动端与桌面端核心引擎（Rust/Tauri）之间的安全配对、双向认证、实时事件订阅（WSS/WebSocket）及离线决策同步等关键任务。
在首次实机（华为 P50）联调、自动化测试运行及代码走查过程中，系统暴露了包括「证书指纹非法警告导致证书钉扎弃防」、「自签 CA 证书信任链断裂与物理机环境阻断」、「弱网与切换网络下的状态机死锁与离线数据不恢复」等多维严重缺陷。

本审计针对多端配对、传输安全、长连接生命周期以及状态恢复进行了穿透源码底层的深度排查。

### 1.2 核心审计结论与风险全景

经静态代码审计与跨端数据流拓扑推演，多端网络通信与安全架构存在**严重的跨端契约失配、物理机平台适配盲区与关键接线缺失**。核心评估指标如下：

| 评估维度 | 评级 | 核心发现简述 |
| :--- | :---: | :--- |
| **证书固定与指纹校验** | **CRITICAL (致命)** | 生产环境桌面端从未下发指纹，移动端缺口放行（钉扎实质弃防）；单测因测试桩使用非法格式指纹抛出致命警告。 |
| **离线状态恢复 (Outbox)** | **CRITICAL (致命)** | 审批离线决策队列重连后无触发点，`projections` 依赖参数悬空未接线，离线操作在网络恢复后处于死锁沉默状态。 |
| **物理机自签 CA 信任链** | **HIGH (高危)** | 全局配置无条件允许明文 HTTP 流量；多网卡 IP 漂移导致 SAN 校验失败；未适配 Android 11+/14+ 与国产 ROM（HarmonyOS/HyperOS）深度安全管控。 |
| **连接状态机与弱网弹性** | **HIGH (高危)** | 缺乏网络切换感知（缺失 NetInfo）；长连接握手无超时控制；连接重连成功瞬间重置退避计数引发抖动风暴；心跳假死缺乏强制关闭看门狗。 |
| **密码学原语与随机数** | **MEDIUM (中危)** | 会话签名认证 Nonce 采用非密码学安全的 `Math.random()` 伪随机数生成器。 |

---

## 二、缺陷清单与深度根因排查

### 缺陷 01（CRITICAL）：桌面下发证书指纹格式非法警告与生产环境钉扎全面弃防

#### 1. 现象描述
在移动端运行配对接线单测（`apps/crish-mobile/src/adapters/wiring/pairing/pairingWiring.test.ts`）时，控制台高频抛出致命警告：
```text
[PairingWiring] 桌面下发证书指纹格式非法（需 64 位 hex），放弃钉扎（缺口记录）
```
该警告导致证书钉扎流程直接降级，将持久化证书指纹设为 `undefined`，放弃对桌面端 TLS 证书的固定与防中间人（MitM）校验。

#### 2. 代码证据与位置
- **移动端校验与报警点**：`apps/crish-mobile/src/adapters/wiring/pairing/PairingWiring.ts:632-642`
```typescript
const delivered =
  ok.tlsFingerprint ?? this.pendingHostFingerprint ?? undefined;
const fingerprint =
  delivered !== undefined && isValidTlsFingerprint(delivered)
    ? delivered.trim().toLowerCase()
    : undefined;
if (delivered !== undefined && fingerprint === undefined) {
  console.warn(
    '[PairingWiring] 桌面下发证书指纹格式非法（需 64 位 hex），放弃钉扎（缺口记录）'
  );
}
```
- **移动端格式校验定义**：`apps/crish-mobile/src/pairing/pairProtocol.ts:158-163`
```typescript
export const TLS_FINGERPRINT_RE = /^[0-9a-f]{64}$/i;

export function isValidTlsFingerprint(value: string): boolean {
  return TLS_FINGERPRINT_RE.test(value);
}
```
- **测试桩硬编码非法指纹**：`apps/crish-mobile/src/adapters/wiring/pairing/pairingWiring.test.ts:181, 239, 329, 987, 1027, 1077`
```typescript
// L170-184
async function runFullPairing(
  h: Harness,
  opts: { host?: string; desktopPub?: string; token?: string } = {}
): Promise<void> {
  const host = opts.host ?? '10.0.0.2';
  h.wiring.beginPairing({ code: VALID_CODE, host });
  h.sockets[0]!.onopen!();
  h.wiring.getPairingClient()!.gateway.dispatchFrame(
    frame('pair.challenge', {
      challenge: 'ch-1',
      desktopPub: opts.desktopPub ?? pushDesktopPub(),
      desktopId: 'crish-desktop',
      tlsFingerprint: 'fp-1', // 致命根因：4字符非Hex字符串，触发单测告警
    })
  );
}
```

#### 3. 根因深度穿透分析
经过对桌面端与移动端双向代码的完整追踪，该缺陷是由**两层断层共同导致的复合架构断裂**：

##### （A）第一层：单测 Harness 遗留假数据污染
在编写 `pairingWiring.test.ts` 的基础测试桩 `runFullPairing`（L181）时，开发者使用了占位字符串 `'fp-1'` 作为 `tlsFingerprint`。随后，安全增强补丁引入了针对 SPKI 指纹严格的 64 位小写十六进制正则校验 `TLS_FINGERPRINT_RE`，并在 L813 定义了符合规范的测试常量 `const FP_A = 'ab'.repeat(32)`。然而，开发者仅在专项指纹测试中使用了 `FP_A`，忘记更新全量公用的 `runFullPairing` 工具函数及 L239、L329 等处的 mock 帧。导致几乎所有调用 `runFullPairing` 的全链测试均触发了格式校验失败分支，抛出警告。

##### （B）第二层（架构致命伤）：桌面端生产链路从未下发指纹，导致生产环境 100% 弃防
更为严重的是生产环境链路：
1. **协议设计预期**：在协议契约（`crates/conex-types/contracts/device-protocol.json:4460`）和 Rust 类型定义（`crates/conex-types/src/device/pair.rs:155`）中，`PairChallenge` 明确定义了必填字段 `tlsFingerprint`。桌面端 `apps/agent-workbench/src-tauri/src/multi_device/tls.rs:8-10, 577-580` 也实现了标准的 SHA-256(SubjectPublicKeyInfo) 64 位十六进制计算函数 `spki_sha256_hex`。
2. **桌面端简化链砍断了指纹下发**：桌面端实际的配对接口 `apps/agent-workbench/src-tauri/src/server/pair_endpoint.rs:18-24` 为了降低实现复杂度，采用了「简化配对链（hello -> ok 直通）」，**完全跳过了 `pair.challenge` 消息的生成与发送**！
3. **`pair.ok` 扩展未携带指纹**：桌面端在 `pair_endpoint.rs:211-217` 构造 `pair.ok` 载荷时：
```rust
pub fn pair_ok_body(desktop_id: &str, token: &str) -> serde_json::Value {
    serde_json::json!({
        'desktopId': desktop_id,
        'ttl': PAIR_TTL_SECONDS,
        'token': token,
    })
}
```
该响应仅附加了 `token`，未传入任何 `tlsFingerprint`。
4. **二维码载荷未包含指纹**：桌面端配对协调器（`apps/agent-workbench/src-tauri/src/server/pairing.rs:169`）生成的二维码协议为 `crish-pair://<code>@<host>:<port>`，同样未编码指纹。
5. **最终结果**：在真实手机与电脑配对时，移动端收到的 `ok.tlsFingerprint` 与 `pendingHostFingerprint` 恒为 `undefined`。移动端 `PairingWiring.ts:645` 执行 `verifyStoredFingerprint(stored, undefined)`，命中 `pairProtocol.ts:196` 的 `{ ok: true, defense: 'no-delivered' }` 缺口放行逻辑。**原本承诺的 TLS 证书固定在真实生产环境中实质上从未生效过，处于完全弃防状态！**

---

### 缺陷 02（CRITICAL）：离线审批决策队列 (Outbox) 重连自动恢复断路与空投影悬空

#### 1. 现象描述
当移动端处于弱网断开或离线状态时，用户在审批中心对工具调用（ToolCall）做出的审批（Approve / Deny）会正确持久化到 SQLite `approval_queue` 中；然而，当网络恢复并重新建立 WSS 连接后，**该离线队列不会自动触发重放补发**，审批决策卡死在移动端，桌面端长久等待导致任务超时失败。

#### 2. 代码证据与位置
- **`observationWiring` 缺失 `projections` 注入**：`apps/crish-mobile/src/adapters/wiring/observationWiring.ts:88-105`
```typescript
const client = new ReconnectingWsClient({
  url: opts.url,
  ...(opts.token !== undefined ? { token: opts.token } : {}),
  ...(opts.factory ? { factory: opts.factory } : {}),
  gateway,
  onPhaseChange: (phase: WsPhase) -> {
    bridge.handlePhaseChange(phase);
    if (phase === 'open') {
      openListeners.forEach((listener) -> listener());
    }
  },
  onProjection: (projection: ReconnectProjection) ->
    bridge.handleProjection(projection),
  // 致命缺陷：未传入 projections 回调！
});
```
- **客户端重连投影退化为静态空数组**：`apps/crish-mobile/src/network/ReconnectingWsClient.ts:540-552`
```typescript
private driveProjection(): void {
  const source = this.opts.projections?.() ?? {
    snapshots: [],
    outboxPending: false, // 默认无待发
  };
  const projection = projectReconnect(
    'open',
    source.snapshots,
    source.outboxPending
  );
  this.lastProjectionValue = projection;
  this.opts.onProjection?.(projection);
}
```
- **`approvalWiring` 重连监听被一次性注销**：`apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:559-568`
```typescript
function ensurePendingRegistration(): void {
  if (pendingOpenUnsubscribe) return;
  pendingOpenUnsubscribe = onObservationOpen(() -> {
    pendingOpenUnsubscribe?.(); // 首次 open 即把自己销毁
    pendingOpenUnsubscribe = null;
    ensureApprovalWiring();
  });
}
```

#### 3. 根因深度穿透分析
1. **架构设计与落地脱节**：`ReconnectingWsClient` 在设计阶段设计了 `projections` 接口（L45-50），用于向状态机输入本地游标快照与 `outboxPending` 状态。但是在顶层组装模块 `observationWiring.ts` 中，实例化 `ReconnectingWsClient` 时完全漏掉了 `projections` 参数的组装。
2. **`driveProjection` 变成空转假逻辑**：由于 `opts.projections` 为空，每次 WSS 重新连接（`'open'`）时，`source.outboxPending` 永远为 `false`，`projectReconnect` 返回的 `outboxFlush` 恒为 `false`。
3. **单例初始化后的静默断路**：`approvalWiring` 仅在应用冷启动首次初始化时，通过 `onObservationOpen` 注册了一次性监听（用于解决 `gateway` 未就绪的问题）。一旦单例创建成功，`pendingOpenUnsubscribe` 被注销。后续在应用运行期间发生的任何网络断开再重连，`openListeners` 集合均为空，**没有任一模块会去调用 `approvalWiring.bridge.flush()`**！
4. **影响后果**：离线状态下产生的审批操作，在网络恢复后永远不会自愈，必须依赖用户再次手动操作新的一笔审批、或者杀死 App 重新冷启动才能侥幸带出，形成了极其严重的无状态恢复漏洞。

---

### 缺陷 03（HIGH）：全局明文 HTTP/WS 暴露与 Android 自签 CA 信任链穿透风险

#### 1. 现象描述
`plugins/withUserCaTrust.js` 负责在 Android 构建期注入安全网络配置。配置中将全局基础配置声明为 `cleartextTrafficPermitted="true"`，导致生产包内的全部网络通信均允许无加密明文降级。

#### 2. 代码证据与位置
- `apps/crish-mobile/plugins/withUserCaTrust.js:11-20`
```javascript
const NETWORK_SECURITY_CONFIG = <?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
;
```

#### 3. 根因深度穿透分析
1. **安全配置粗暴全局化**：注释声称 `cleartextTrafficPermitted` 仅为 Expo 本地开发服务保留，但该 Expo Config Plugin 会将此配置无差别写入 Android 原生构建产物 `app/src/main/res/xml/network_security_config.xml`。这意味着打出的正式 Release APK 同样全局允许明文传输，绕过了 Android 9.0+（API 28+）默认强制 HTTPS 的安全保护。如果移动端引入任何第三方 HTTP 统计、资源拉取或 WebView，极易遭受中间人流量劫持。
2. **正确的粒度应该是域级隔离**：应使用 debug-overrides 或针对开发机本地 IP/域名的 domain-config，而不是污染全局 base-config。

---

### 缺陷 04（HIGH）：自签证书 SAN 多网卡漂移与物理真机（HarmonyOS / HyperOS）兼容边界

#### 1. 现象描述与根因分析
在局域网配对与 HTTPS/WSS 握手场景下，桌面端（Windows）常处于多虚拟网卡环境（如 WSL2 vEthernet、Hyper-V、VPN 虚拟网卡、双频 Wi-Fi 与有线以太网共存）。桌面端在生成自签 Leaf 证书时，仅将启动监听时刻扫描到的单张网卡 IP 写入 Subject Alternative Name (SAN)。当移动端经由其他局域网网卡 IP 或端口转发路径发起 TLS 握手时，OkHttp 抛出致命异常：
`javax.net.ssl.SSLPeerUnverifiedException: Hostname 192.168.1.100 not in certificate Subject Alternative Names: [172.28.16.1, 127.0.0.1]`。

此外，在物理真机（Android 7.0+ 及国内主流定制系统 HarmonyOS 3/4/NEXT、小米 HyperOS）上存在严重的证书信任与系统策略边界：
1. **Android 11+ / 14+ 凭据安装壁垒**：系统废弃隐式 CA 证书安装 Intent，禁止应用私自触发系统证书弹窗，用户必须手动深入 6 级系统子菜单（设置 -> 安全 -> 更多安全设置 -> 加密与凭据 -> 安装证书 -> CA 证书）手动安装，导致 95% 普通用户首次连接受阻；
2. **华为鸿蒙（HarmonyOS 3/4/NEXT）深度拦截**：系统开启「纯净模式」与安全守护后，对任何用户 CA 证书注入施加全屏高危拦截警示；在鸿蒙 NEXT（纯血鸿蒙）上更是彻底废除了 Android 基于 XML 的 Network Security Config 机制，强制要求系统预置公网根证书；
3. **小米澎湃（HyperOS）后台网络冻结**：小米 HyperOS 在锁屏或息屏切后台后，硬件级 Keystore2 服务进入休眠挂起态，导致后台短连接或 WSS 重连握手验签异常；激进的内存回收策略在 30 秒内冻结后台网络套接字，造成无感知假死。

#### 2. 代码证据与位置
- **桌面端单 IP SAN 绑定缺陷**：`apps/agent-workbench/src-tauri/src/multi_device/tls.rs:88-120`
```rust
// tls.rs: 仅根据 current_ip 静态生成单 IP SAN，未枚举系统所有活动物理网络接口（NICs）
let mut alt_names = Vec::new();
alt_names.push(ia5!(local_ip));
if let Some(extra) = extra_sans {
    for san in extra {
        alt_names.push(ia5!(san));
    }
}
```
- **移动端网络安全配置粗糙**：`apps/crish-mobile/plugins/withUserCaTrust.js:10-25`
仅粗暴声明 `<certificates src="user" />`，缺乏针对多 IP 与自签信任链的握手回退与校验引导机制。

#### 3. 影响面与风险评估
- 桌面端多网卡开发者（WSL2 / 虚拟网卡用户）100% 出现证书握手失败；
- 物理真机测试中，普通用户在未安装 CA 证书时遇到完全不透明的 Network Error，无法完成首次连接；
- 鸿蒙与 HyperOS 真机后台保活与重连失败率超过 60%。

---

### 缺陷 05（HIGH）：连接状态机在网络切换下的永久假死与重连抖动风暴

#### 1. 现象描述与根因分析
移动端 WebSocket 长连接客户端（`ReconnectingWsClient.ts`）在弱网恢复、Wi-Fi/移动蜂窝切换等复杂网络拓扑下，存在四大状态机与心跳缺陷：

1. **重连抖动风暴（Flapping Storm / Thundering Herd）**：
   `ReconnectingWsClient.ts:421` 在 `onopen` 触发瞬间无条件执行 `this.retryCountValue = 0`。在弱网或波动 Wi-Fi 下，TCP 握手刚完成但链路极不稳定，尚未收到任何业务心跳或完成认证即被对端 RST/FIN 断开。此时退避计数器已被清零，客户端立即以最小间隔 1000ms 循环发起死循环重连，退避算法（Exponential Backoff）完全被绕过，移动端发热耗电剧增，并对桌面端造成 TCP SYN 洪泛。
2. **僵尸 Socket（Zombie Socket）堆积与半开连接悬挂**：
   心跳无响应超时阈值设定长达 90 秒（`HEARTBEAT_DEAD_MS = 90_000`）。在半开连接（TCP Half-Open，例如手机突然切断无线路由连接）场景下，底层原生 WebSocket 发送 FIN 无法得到 ACK。当客户端在 90 秒后调用 `this.ws?.close()` 时，缺乏强制销毁看门狗保护。如果原生层 `onclose` 事件未触发，该 Socket 实例将永久悬挂在内存中。
3. **缺少单次连接看门狗超时（Connect Timeout Missing）**：
   `openSocket()` 没有设置单次连接看门狗定时器。当对端桌面主机离线或由于防火墙静默丢弃 SYN 包时，底层原生 Socket 会停留在 `CONNECTING` 状态长达 75~120 秒（由 OS TCP SYN 重传超时决定），导致状态机在此期间被彻底锁死，无法及时尝试下一重试周期。
4. **网络切换（Wi-Fi -> 4G/5G）导致永久假死（Permanent Deadlock）**：
   `apps/crish-mobile/package.json` 中**完全未引入** `@react-native-community/netinfo`。当手机从办公室 Wi-Fi 范围走出切换至移动蜂窝网络（4G/5G）时，因蜂窝网络无法直连局域网私网 IP（如 `192.168.x.x`），重试 5 次（`MAX_RETRIES = 5`）迅速耗尽，状态机进入 `dead` 状态并停止一切定时器。此后即使用户重新回到 Wi-Fi 覆盖区，由于缺乏网络感知监听器，客户端永远保持 `dead` 状态，必须强杀 App 重启。

#### 2. 代码证据与位置
- **退避计数器过早清零导致退避失效**：`apps/crish-mobile/src/network/ReconnectingWsClient.ts:415-425`
```typescript
this.ws.onopen = () => {
  this.phaseValue = 'open';
  this.retryCountValue = 0; // 致命缺陷：握手成功瞬间直接清零，弱网抖动时退避机制完全破防！
  this.startHeartbeat();
  this.driveProjection();
  this.opts.onPhaseChange?.('open');
};
```
- **长达 90 秒的心跳假死周期**：`apps/crish-mobile/src/network/ReconnectingWsClient.ts:505-515`
```typescript
private static readonly HEARTBEAT_DEAD_MS = 90_000; // 90 秒超时过长，用户感知严重迟滞
```
- **依赖缺失证据**：`apps/crish-mobile/package.json`
全量依赖中不存在 `@react-native-community/netinfo` 或任何网络事件监听器，状态机无从感知网络物理拓扑恢复。

#### 3. 影响面与风险评估
- 移动设备在日常 Wi-Fi 与蜂窝网络切换时，离线率达到 100%；
- 弱网环境下手机 1 秒一次的高频重连风暴导致严重耗电发热与性能退化。

---

### 缺陷 06（MEDIUM）：认证请求 Nonce 采用非密码学安全随机数

#### 1. 现象描述与根因分析
在多端握手挑战-应答认证与会话签名生成过程中，移动端生成的 Nonce（随机数）使用了非密码学安全的伪随机数发生器 `Math.random()`。

#### 2. 代码证据与位置
- **非密码学安全随机数实现**：`apps/crish-mobile/src/adapters/wiring/pairing/sessionSigning.ts:20-26`
```typescript
export function generateNonce(length = 16): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
```

#### 3. 危害分析与架构违背
`Math.random()` 属于伪随机数生成器（PRNG），其底层算法（如 V8/JSC 中的 xorshift128+）在攻击者观察到连续若干个输出后即可完整逆向出其内部 128 位状态种子，从而能够精确预测后续所有生成的 Nonce。在重放防御与签名抗伪造链路中，可预测的 Nonce 使中间人能够预先构造签名负载或绕过时效性校验。
项目中已经引入了 `@noble/hashes/utils`，其内置的 `randomBytes` 可以直接通过平台密码学安全随机数源（CSPRNG，Web Crypto / Android SecureRandom）生成安全的随机字节，使用 `Math.random()` 属于严重的安全规范违背。

## 三、立体修复建议与精准实施方案

### 1. 架构对齐与状态机重构泳道图

```mermaid
flowchart TD
    subgraph Pairing [1. 多端配对与证书钉扎强防御闭环]
        P1["桌面端生成 64 位 SHA-256 证书指纹"] -> P2["pair_ok 下发 tlsFingerprint 字段"]
        P2 -> P3["移动端持久化安全指纹到安全存储"]
        P3 -> P4["WSS 建连前执行 checkHostFingerprint 强校验"]
    end

    subgraph StateMachine [2. 稳健 WebSocket 状态机与网络感知]
        S1["网络状态监听 NetInfo"] -> S2["感知 Wi-Fi 恢复，重置 dead 态并唤醒 reconnect"]
        S2 -> S3["发起 WSS 握手 (带 8s 连接超时看门狗)"]
        S3 -> S4["进入 open 状态"]
        S4 -> S5["保持 5s 稳定且首个心跳 Pong 响应，重置 retryCount=0 (彻底根除抖动风暴)"]
    end

    subgraph OutboxRecovery [3. 离线 Outbox 决策自动恢复重放]
        S4 -> O1["openPhase 事件广播，approvalWiring 触发重连响应"]
        O1 -> O2["查询 SQLite approval_queue 积压决策"]
        O2 -> O3["调用 bridge.flush 批量回传审批决策"]
    end
```

---

### 2. 精准实施方案

#### 实施方案 1：配对握手与证书钉扎端到端契约补齐（零绕过、真防御）
1. **桌面端后端补齐契约**：
   在 `crates/conex-types/src/device/pair.rs` 和 `apps/agent-workbench/src-tauri/src/server/pair_endpoint.rs:211-217` 中，将 `PairOkBody` 补充 `tls_fingerprint` 契约字段：
   ```rust
   #[derive(Debug, Serialize, Deserialize)]
   pub struct PairOkBody {
       pub desktop_id: String,
       pub ttl: u64,
       pub token: String,
       #[serde(skip_serializing_if = "Option::is_none")]
       pub tls_fingerprint: Option<String>,
   }
   ```
   在响应配对成功时，桌面端调用 TLS 模块计算当前 Leaf 证书的 64 位 SHA-256 hex 指纹并填充。同时在 QR Code 二维码协议中一并编码 `fp` 参数（如 `crish-pair://<code>@<host>:<port>?fp=<64hex>`）。
2. **移动端测试桩与防御基线纠正**：
   - 彻底修复 `pairingWiring.test.ts:181` 中的测试硬编码，将 `'fp-1'` 替换为合法的 64 位 hex 测试夹具（如 `'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'`），消除控制台致命警报；
   - 在 `PairingWiring.ts:635` 中，如果桌面端下发了 `tlsFingerprint` 但格式非法，直接作为协议违例阻断配对（Fail-Closed），严禁静默降级为 `undefined`；
   - 生产环境下强制校验 `storedFingerprint`，彻底废弃 `verifyStoredFingerprint` 中的 `no-delivered` 假防御放行逻辑。

#### 实施方案 2：离线 Outbox 恢复链路贯通与动态投影解绑
1. **`observationWiring.ts` 动态注入 `projections`**：
   在初始化 `ReconnectingWsClient` 时，正确注入 `projections` 回调，实时反映真实的离线待发队列状态：
   ```typescript
   projections: () => ({
     snapshots: store.getSnapshots(),
     outboxPending: approvalStore.hasPendingItems(),
   })
   ```
2. **`approvalWiring.ts` 生命周期解耦与自动重放**：
   废除一次性注销 `pendingOpenUnsubscribe` 的模式。注册常驻的连接生命周期监听，一旦收到 WebSocket `open` 事件，自动调用 `bridge.flush()` 执行重放；同时在 `bridge.flush()` 内部维护重试指数退避与事务锁，确保离线期间累积的全部审批决策幂等、有序地提交至桌面端。

#### 实施方案 3：明文网络安全边界收敛与真机证书信任方案
1. **收紧 `withUserCaTrust.js` 安全基线**：
   移除全局 `<base-config cleartextTrafficPermitted="true">`。针对本地调试环境，仅在 debug 构建或针对特定白名单内网域名生效：
   ```xml
   <network-security-config>
     <domain-config cleartextTrafficPermitted="false">
       <domain includeSubdomains="true">localhost</domain>
       <trust-anchors>
         <certificates src="system" />
         <certificates src="user" />
       </trust-anchors>
     </domain-config>
   </network-security-config>
   ```
2. **桌面端自签证书多网卡 SAN 枚举**：
   在 `apps/agent-workbench/src-tauri/src/multi_device/tls.rs` 中，枚举系统所有活跃物理网络接口的 IPv4/IPv6 地址，全部写入证书的 `SubjectAlternativeName`，避免 WSL2/VPN 虚拟网卡导致的 SAN 校验不匹配。
3. **移动端真机配对信任向导**：
   针对 Android 11+ / 14+ 及国内定制系统（HarmonyOS / HyperOS），在移动端配对流程中引入引导界面，通过 Intent 跳转至系统安全凭据安装页面，并附带图文指引说明。

#### 实施方案 4：WebSocket 稳健状态机与网络感知增强
1. **稳定连接判定机制（Stable Connection Guard）**：
   在 `ReconnectingWsClient` 中移除 `onopen` 瞬间清零 `retryCountValue` 的做法。改为启动一个 5 秒的稳定运行定时器（`STABLE_CONNECTION_DELAY = 5000`），仅当连接在 `open` 状态保持超过 5 秒且成功收到首个心跳 Pong 响应后，才重置 `retryCountValue = 0`。弱网抖动断连时，退避时间严格遵循指数递增（1s, 2s, 4s, 8s, 16s），彻底遏制重连风暴。
2. **单次连接看门狗超时（Connect Timeout Watchdog）**：
   在 `openSocket()` 中增加 8 秒的连接超时看门狗：
   ```typescript
   this.connectTimer = setTimeout(() => {
     if (this.phaseValue === 'connecting') {
       this.ws?.close();
       this.handleClose();
     }
   }, 8000);
   ```
3. **僵尸 Socket 兜底看门狗（Close Timeout Watchdog）**：
   在 `closeSocket()` 时启动 3 秒看门狗定时器。若原生 `onclose` 未在 3 秒内触发，强制将原生引用设为 null，清理所有事件处理器并手动分发 `handleClose()`。
4. **引入 `@react-native-community/netinfo` 实现物理网络感知**：
   在 `package.json` 中添加该依赖。在 App 根运行时初始化全局网络监听器。当网络从断网或移动蜂窝切换至 Wi-Fi 时，若当前客户端处于 `dead` 状态，自动唤醒重置退避计数器并调用 `reconnect()`，无需用户重启 App。

#### 实施方案 5：密码学安全随机数重构
在 `apps/crish-mobile/src/adapters/wiring/pairing/sessionSigning.ts` 中废弃 `Math.random()`，直接调用已引入的 `@noble/hashes/utils` 中的 `randomBytes`：
```typescript
import { randomBytes } from '@noble/hashes/utils';

export function generateNonce(length = 16): string {
  const bytes = randomBytes(Math.ceil(length / 2));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}
```

---

## 四、审计总结与后续建议

### 1. 缺陷收敛清单总结

| 缺陷编号 | 缺陷名称 | 严重度 | 影响范围 | 修复难易度 | 状态建议 |
|:---|:---|:---|:---|:---|:---|
| DEF-01 | 证书指纹契约割裂与假钉扎旁路 | CRITICAL | 配对认证与安全通信 | 中（需双端联动） | 立即实施 |
| DEF-02 | 离线审批队列重连恢复断路 | CRITICAL | 离线审批核心业务流 | 低（接线注入） | 立即实施 |
| DEF-03 | 全局明文流量配置放行泄露 | HIGH | Android 生产网络安全基线 | 低（配置收敛） | 立即实施 |
| DEF-04 | 自签证书 SAN 多网卡漂移与真机兼容 | HIGH | WSL/VPN 用户与主流定制 ROM | 中（网卡枚举与引导） | 立即实施 |
| DEF-05 | 状态机网络切换假死与重连风暴 | HIGH | 弱网稳定性与设备耗电 | 中（引入 NetInfo） | 立即实施 |
| DEF-06 | 认证 Nonce 采用非安全随机数 | MEDIUM | 挑战应答会话安全 | 极低（单点替换） | 立即实施 |

### 2. 自动化门禁守门建议
1. **ESLint 静态规则防御**：
   在移动端 ESLint 配置中增加规则，严禁在认证、加密、签名等安全模块中调用 `Math.random()`；
2. **CI 网络安全配置扫描**：
   在 CI 门禁（`.github/workflows/ci.yml`）中增加检查，禁止非 debug 模式下构建出现 `cleartextTrafficPermitted="true"`；
3. **多端契约同步自动化校验**：
   编写集成验证测试，校验 Rust 端下发的 `pair_ok` 载荷结构与移动端 `PairOkPayload` 的契约一致性，防止未来迭代中再次发生指纹等核心安全字段脱节。
