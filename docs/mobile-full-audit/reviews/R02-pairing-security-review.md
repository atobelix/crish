# R02 多端配对与网络安全对抗复核报告

> **席位**：第二轮战役 · R02 多端配对与网络安全对抗复核席  
> **复核对象**：`docs/mobile-full-audit/audits/02-pairing-security-and-pinning-audit.md`（第一轮 02 席位报告）  
> **复核范围**：`apps/crish-mobile/src/pairing/`、`src/network/`、`src/adapters/wiring/`、`plugins/`、`android/` 以及桌面端 `apps/agent-workbench/src-tauri/`、`crates/` 配对与 TLS 模块  
> **执行依据**：`docs/mobile-full-audit/prompts/00-共同约束前言.md`、仓库根目录 `AGENTS.md`  

---

## 0 结论摘要

1. **核心定性**：原报告对「Android 全局明文流量放行」、「连接状态机缺少连接超时看门狗及死锁」等维度的洞察属实；但在**核心业务断路（DEF-02 离线审批 Outbox 恢复）上出现重大误判（断言与事实完全相反）**，且存在**捏造代码片段（DEF-04、DEF-06）**与**将正常单测负向测试用例误判为测试桩污染（DEF-01）**的违规行为。
2. **离线审批 Outbox 未断路（DEF-02 🚫 不成立）**：原报告称“重连后没有模块调用 `bridge.flush()`，离线审批永远卡死”。经追溯完整调用链，重连触发 `feedBridge.handlePhaseChange('open')` 发送 `events.subscribe`，桌面端响应 `events.subscribe.ok` 后立即触发 `approvalWiring.ts:278` 的 `onSyncReady()`，执行 `flushOnce()` 批量重放 SQLite 积压决策并对账。离线审批自愈链路完全闭环。
3. **全局明文放行确实存在（DEF-03 ✅ 成立）**：`withUserCaTrust.js:13` 将 `<base-config cleartextTrafficPermitted="true">` 写入生产 `network_security_config.xml`，且 `AndroidManifest.xml` 无条件引用，导致 Release 包明文保护失效。
4. **证书钉扎与 SAN 真实情况（DEF-01 ⚠️ 部分成立 / DEF-04 ❌ 夸大）**：桌面端简化配对链确实未下发指纹，移动端缺口放行；但项目早在方案期已将口径降级为“系统 CA 信任 + 配对期应用层指纹一致性比对”，并非传输层 Pinning。桌面自签证书 SAN 确实未覆盖局域网物理 IP（`main.rs` 未组装 `tls_extra_sans`），但原报告引用的 `tls.rs:88-120` 代码片段系凭空捏造。
5. **原报告可信度评语**：**该报告指出部分真实网络配置隐患，但业务调用链审计不穿透、凭空捏造代码、严重夸大安全威胁，整体可信度为「中等偏低，以本复核报告为准」。**

---

## 1 现状还原（跨端全链路拓扑与代码事实）

### 1.1 桌面端配对、TLS 证书与 SAN 现状
1. **简化配对链（跳过 challenge）**：
   桌面端在 `apps/agent-workbench/src-tauri/src/server/pair_endpoint.rs:18-24, 211-217` 实现了 REST 与 WebSocket 的简化配对链。成功载荷 `pair_ok_body` 仅包含 `desktopId`、`ttl` 和明文 `token`，未下发自签证书指纹 `tlsFingerprint`：
   ```rust
   // apps/agent-workbench/src-tauri/src/server/pair_endpoint.rs:211-217
   pub fn pair_ok_body(desktop_id: &str, token: &str) -> serde_json::Value {
       serde_json::json!({
           "desktopId": desktop_id,
           "ttl": PAIR_TTL_SECONDS,
           "token": token,
       })
   }
   ```
2. **二维码协议载荷**：
   `apps/agent-workbench/src-tauri/src/server/pairing.rs:169` 生成的二维码为 `crish-pair://<code>@<host>:<port>`，同样未包含指纹参数。
3. **自签证书与 SAN 装配断层**：
   `apps/agent-workbench/src-tauri/src/multi_device/tls.rs:542-547` 的默认 SAN 仅包含回环：`["crish-remote", "localhost", "127.0.0.1", "::1"]`。虽然 `server/mod.rs:189-201` 具备通过 `config.tls_extra_sans` 触发 `material.reissue_leaf(&sans)` 的重签能力，但在应用主装配入口 `apps/agent-workbench/src-tauri/src/main.rs:710, 738-745` 中，`ServerConfig` 仅使用默认空列表，重绑 LAN 模式时**从未将局域网物理网卡 IP 注入 `tls_extra_sans`**。真实局域网直连存在 TLS 主机名验证失败风险。

### 1.2 移动端配对与指纹比对现状
1. **应用层校验与缺口记录**：
   移动端在 `apps/crish-mobile/src/pairing/pairProtocol.ts:15-18` 明确注释记录了该缺口：
   ```typescript
   // apps/crish-mobile/src/pairing/pairProtocol.ts:15-18
   // 缺口记录：当前桌面 pair_endpoint.rs 简化链（hello → ok 直接完成）不发送 pair.challenge，
   // 指纹实际未下发——移动端 host_fingerprint 位暂空（AU5 S-1 修复的诚实边界）；
   ```
2. **放行逻辑判定**：
   在 `apps/crish-mobile/src/adapters/wiring/pairing/PairingWiring.ts:632-646`，由于 `ok.tlsFingerprint` 与 `pendingHostFingerprint` 均为 `undefined`，`verifyStoredFingerprint` 执行 `checkHostFingerprint(stored, undefined)`，返回 `{ ok: true, defense: 'no-delivered' }` 或 `{ ok: true, defense: 'no-stored' }`，允许配对完成，但 `SecureStore` 中不会保存任何指纹。
3. **架构既定安全模型**：
   `docs/mobile-app-rebuild/00-总方案.md:186` 明确声明：“当前信任模式 = 系统 CA 信任 + 应用层指纹一致性校验；不是传输层 pinning”。React Native 原生 WebSocket 并未暴露证书固定注入接口，原生 TLS 握手完全依赖 Android 系统的 TrustManager 与 CA 信任库。

### 1.3 Android 原生网络配置与全局明文现状
1. **Config Plugin 写入全局明文**：
   `apps/crish-mobile/plugins/withUserCaTrust.js:11-20` 将 `NETWORK_SECURITY_CONFIG` 写入 `apps/crish-mobile/android/app/src/main/res/xml/network_security_config.xml`：
   ```xml
   <!-- apps/crish-mobile/android/app/src/main/res/xml/network_security_config.xml:3-8 -->
   <network-security-config>
       <base-config cleartextTrafficPermitted="true">
           <trust-anchors>
               <certificates src="system" />
               <certificates src="user" />
           </trust-anchors>
       </base-config>
   </network-security-config>
   ```
2. **生效范围穿透 Release**：
   `apps/crish-mobile/android/app/src/main/AndroidManifest.xml:18` 将该配置声明在 `<application>` 根级。经核实 `apps/crish-mobile/app.json`，无任何构建插件或覆盖规则对 Release 进行隔离，导致全局允许明文 HTTP 传输穿透至正式安装包。

### 1.4 WebSocket 状态机与订阅驱动重放链路
1. **审批 Outbox 真实重放链路**：
   - 握手重连成功进入 `open`：`ReconnectingWsClient.ts:426` 触发 `opts.onPhaseChange('open')`。
   - 驱动会话订阅：`feedBridge.ts:186-191` 在 `phase === 'open'` 时触发 `void this.onOpen()`，调用 `syncSubscriptions()` 向桌面端网关发送 `events.subscribe` 帧（`feedBridge.ts:253`）。
   - 订阅成功回执触发重放：桌面端回复 `events.subscribe.ok`，`apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:278` 监听此帧并调用 `this.onSyncReady()`：
   ```typescript
   // apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:339-343
   private onSyncReady(): void {
     void this.flushOnce();
     void this.reconcile();
   }
   ```
   - 批处理提交：`flushOnce()` 立即从 SQLite `approval_queue` 查询未决决策并逐条重发。
2. **连接超时与退避复位**：
   - `ReconnectingWsClient.ts:421` 在 `handleOpen()` 瞬间执行 `this.retryCountValue = 0`。
   - `openSocket()`（L406-417）未设置单次握手超时看门狗，握手挂起依赖操作系统 TCP 超时。
   - `package.json` 未引入 NetInfo，在网络从 Wi-Fi 切换至蜂窝导致 5 次重试耗尽（L468 `this.retryCountValue > this.maxRetries`）进入 `dead` 后，缺乏自愈驱动源。
## 2 问题清单

### DEF-01：桌面未下发指纹致应用层比对未激活与测试桩警告
- **编号**：DEF-01
- **位置**：
  - 桌面服务端：`apps/agent-workbench/src-tauri/src/server/pair_endpoint.rs:211-217`
  - 移动端接线：`apps/crish-mobile/src/adapters/wiring/pairing/PairingWiring.ts:632-646`
  - 单测测试桩：`apps/crish-mobile/src/adapters/wiring/pairing/pairingWiring.test.ts:181, 239, 329, 1027, 1077`
- **现象**：
  1. 移动端运行 `pairingWiring.test.ts` 时控制台多次打印警告 `[PairingWiring] 桌面下发证书指纹格式非法（需 64 位 hex），放弃钉扎（缺口记录）`。
  2. 真实生产环境配对时，移动端未捕获到任何桌面端证书指纹，安全存储中不保存指纹。
- **直接原因**：
  1. 测试套件中公用工具函数 `runFullPairing`（L181）及多处 mock 帧使用了 4 字符占位字面量 `'fp-1'`，未能匹配 64 位小写 Hex 正则 `TLS_FINGERPRINT_RE`。
  2. 桌面端采用简化配对链跳过了 `pair.challenge`，且 `pair_ok_body` 与二维码未扩展 `tlsFingerprint` 字段。
- **根因**：
  跨端协议演进不同步。规范文档 D3 设计了完备的 ECDH 密钥交换与带外挑战指纹传递，但工程实现阶段桌面端为了快速收敛先采用了简化直通模式，移动端相应添加了 `no-delivered` 缺口放行代码，导致该层防御一直处于未启用状态。
- **影响**：
  局域网防中间人（MitM）在应用层失去第二道防护线，完全依赖 Android 系统凭据库对用户自签 CA 证书的单向信任。
- **置信度**：`已验证`

---

### DEF-02：离线审批队列重连自愈机制真实状态复核（非原报告断路结论）
- **编号**：DEF-02
- **位置**：
  - 观察接线：`apps/crish-mobile/src/adapters/wiring/observationWiring.ts:88-105`
  - 状态机投影：`apps/crish-mobile/src/network/ReconnectingWsClient.ts:540-552`
  - 审批生命周期：`apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:277-282, 339-343`
  - 订阅驱动：`apps/crish-mobile/src/adapters/wiring/feedBridge.ts:186-191, 244-261`
- **现象**：
  原报告断言：“重连后离线审批队列永久沉默不自愈，形成致命漏洞”。
- **直接原因（真实情况）**：
  `observationWiring.ts` 确实未向 `ReconnectingWsClient` 注入 `projections` 回调，导致 `driveProjection()` 内部的 `outboxPending` 恒为 `false`，由 `ReconnectProjection` 计算的 `outboxFlush` 为 `false`。
- **根因（原报告误判根因）**：
  原报告审计仅追溯到 `openListeners` 和 `ReconnectingWsClient.driveProjection` 浅层，**完全忽略了业务领域真实使用的事件驱动发布-订阅链路**。在实际运行时，`feedBridge` 会在长连接进入 `open` 后发起 `events.subscribe`，收到 `events.subscribe.ok` 后立即触发 `approvalWiring.ts` 的 `onSyncReady()`，进而调用 `flushOnce()` 完成重放。
- **影响**：
  核心业务链路并未阻断，离线审批可在重连后正常上报。但 `ReconnectingWsClient` 内部的 `ReconnectProjection` 机制在当前架构中沦为冗余逻辑，代码存在两套重放设计的认知分歧。
- **置信度**：`已验证`

---

### DEF-03：Android 全局允许明文 HTTP 流量安全基线穿透
- **编号**：DEF-03
- **位置**：
  - Expo 插件：`apps/crish-mobile/plugins/withUserCaTrust.js:11-20`
  - 原生配置：`apps/crish-mobile/android/app/src/main/res/xml/network_security_config.xml:3`
  - 应用清单：`apps/crish-mobile/android/app/src/main/AndroidManifest.xml:18`
- **现象**：
  打包生成的 Android Release APK 中，全局 `<base-config>` 设置了 `cleartextTrafficPermitted="true"`。
- **直接原因**：
  `withUserCaTrust.js` 插件直接将硬编码的 XML 模板覆盖写入 `main/res/xml/network_security_config.xml`，且未区分 Debug 与 Release 模式。
- **根因**：
  开发期为了兼容 Expo 8081 Metro 调试服务的明文 HTTP 访问，粗暴地将全局基础配置放开，违背了生产环境最小权限安全基线（Android 9.0+ 默认强制 TLS）。
- **影响**：
  移动端若引入第三方明文请求、无加密 WebView 或统计 SDK，其流量无法被系统强制升级或拦截，存在局域网明文劫持风险。
- **置信度**：`已验证`

---

### DEF-04：桌面自签证书 SAN 未覆盖物理局域网网卡 IP
- **编号**：DEF-04
- **位置**：
  - 桌面装配主入口：`apps/agent-workbench/src-tauri/src/main.rs:710, 738-755`
  - 证书重签逻辑：`apps/agent-workbench/src-tauri/src/server/mod.rs:189-201`
  - 默认 SAN 列表：`apps/agent-workbench/src-tauri/src/multi_device/tls.rs:542-547`
- **现象**：
  移动端通过实际物理 Wi-Fi 局域网 IP（如 `192.168.1.100`）发起 TLS 握手时，若系统 OkHttp 严格校验主机名与 SAN，将抛出 `SSLPeerUnverifiedException`。
- **直接原因**：
  桌面端生产启动代码 `main.rs` 在执行 `restart_server` 与重绑 LAN 模式时，直接 clone 了默认的 `ServerConfig`，未将本机实际局域网 IP（`local_ip_list()`）注入 `config.tls_extra_sans`。
- **根因**：
  SAN 动态重签机制（`TlsMaterial::reissue_leaf`）已在底层完成，但顶层主进程接线遗漏了参数传递。原报告引用的 `tls.rs:88-120` 系凭空捏造。
- **影响**：
  真机在严格 TLS 握手模式下无法通过局域网 IP 成功握手，阻断端到端安全连接。
- **置信度**：`已验证`

---

### DEF-05：WebSocket 状态机弱网抖动风暴与网络切换假死
- **编号**：DEF-05
- **位置**：
  - 退避清零：`apps/crish-mobile/src/network/ReconnectingWsClient.ts:420-421`
  - 假死判定窗口：`apps/crish-mobile/src/network/ReconnectingWsClient.ts:86-87`
  - 握手看门狗缺失：`apps/crish-mobile/src/network/ReconnectingWsClient.ts:406-417`
  - 依赖缺失：`apps/crish-mobile/package.json:23-55`
- **现象**：
  1. 频繁断开的弱网 Wi-Fi 下，客户端退避时间停留在 1~2 秒，未按指数递增退避。
  2. 网络从 Wi-Fi 切换到移动蜂窝后，5 次重试迅速耗尽进入 `dead` 状态；回到 Wi-Fi 后客户端持续假死，无法自动恢复。
- **直接原因**：
  1. `handleOpen()` 在连接刚就绪瞬间直接执行 `this.retryCountValue = 0`，尚未通过心跳验证连接稳定性即清零退避计数。
  2. `openSocket()` 缺少握手定时器；`package.json` 未引入物理网络状态监听，且 UI 侧刷新与生命周期事件未接线唤醒。
- **根因**：
  长连接状态机仅实现了基本退避计算纯函数，未将连接“试运行稳定态”与原生系统生命周期及网络状态机打通。
- **影响**：
  极端弱网环境下增加手机发热耗电；日常通勤网络切换时导致 App 假死，必须强杀重启。
- **置信度**：`已验证`

---

### DEF-06：会话请求签名 Nonce 采用非密码学伪随机数
- **编号**：DEF-06
- **位置**：
  - Nonce 生成器：`apps/crish-mobile/src/adapters/wiring/pairing/sessionSigning.ts:20-26`
- **现象**：
  出站签名请求帧中的 `nonce` 默认由 `Math.random()` 驱动生成。
- **直接原因**：
  `randomNonce(rand: () => number = Math.random)` 在未注入自定义生成器时直接回退到全局 `Math.random`。
- **根因**：
  开发初期为规避早年 React Native / Hermes 缺少标准 `crypto.getRandomValues` 的兼容性问题，采用了简易伪随机方案。
- **影响**：
  `Math.random()` 属于 PRNG（伪随机数），不可用于高强度安全场景。但由于请求载荷整体由双方共享的 `token_key` 进行 HMAC-SHA256 签名，且服务端对 Nonce 仅做 5 分钟滑动窗口重放与幂等拦截，攻击者即使预测出下一个 Nonce，在没有 `token_key` 的前提下无法伪造请求。原报告“攻击者可伪造签名负载”的结论夸大。
- **置信度**：`已验证`
## 3 逐条判定表与遗漏扫描

### 3.1 被复核报告逐条判定表

| 序号 | 被复核项与位置 | 行号与代码复核 | 调用链与事实判定 | 判定 | 修订后准确表述 |
| :--- | :--- | :--- | :--- | :---: | :--- |
| **DEF-01** | **证书指纹非法警告与钉扎弃防**<br>`pairingWiring.ts:632-642`<br>`pair_endpoint.rs:211-217`<br>`pairingWiring.test.ts:181` 等 | **部分吻合**。<br>`pairingWiring.ts`、`pair_endpoint.rs` 行号完全一致；单测 L181、L239、L329、L1027、L1077 确实使用 `'fp-1'`/`'fp'`。但 **L987 是故意的负向测试用例**（明确测试非法指纹不阻断配对），原报告误判为测试桩污染。 | **现象存在，叙事偏大**。<br>桌面端生产确实未下发指纹，移动端放行；但规范文档早已将安全模型降级为“系统 CA 信任 + 应用层一致性”，并非传输层 Pinning。 | ⚠️<br>**部分成立** | 桌面端简化配对链未下发证书指纹，导致移动端应用层一致性比对处于未启用状态；单测通用工具函数硬编码 4 字符占位符产生误报日志，但其中 L987 为合法负向测试用例。 |
| **DEF-02** | **离线 Outbox 重连断路与空投影**<br>`observationWiring.ts:88-105`<br>`ReconnectingWsClient.ts:540`<br>`approvalWiring.ts:559-568` | **行号吻合，但断章取义**。<br>`observationWiring` 确实未传 `projections`，`driveProjection` 确实输出 `outboxFlush=false`。但 `approvalWiring.ts:559` 仅是冷启动监听，原报告遗漏了 L278 和 L339。 | **调用链完全推翻**。<br>重连后通过 `feedBridge.ts:253` 发送 `events.subscribe`，收到 `events.subscribe.ok` 时通过 `approvalWiring.ts:278` 触发 `onSyncReady()` -> `flushOnce()`。离线审批自动重发完全闭环。 | 🚫<br>**不成立** | `ReconnectingWsClient` 的重连投影参数确实未被装配，但离线审批决策重发走独立的 `events.subscribe.ok` 事件驱动机制，重连后可正常自动重放，核心业务未断路。 |
| **DEF-03** | **全局明文 HTTP/WS 暴露**<br>`withUserCaTrust.js:11-20`<br>`res/xml/network_security_config.xml:3`<br>`AndroidManifest.xml:18` | **完全吻合**。<br>配置插件无条件向 Android 原生工程的 `res/xml/network_security_config.xml` 写入 `<base-config cleartextTrafficPermitted="true">`，且 `app.json` 无构建模式过滤。 | **链条完全闭环**。<br>Android 9.0+ 全局强制 HTTPS 安全基线被直接穿透，Release 安装包同样受到污染。 | ✅<br>**成立** | Android 网络安全配置插件在 `main` 源码集无条件声明全局明文传输许可，穿透至生产 Release APK，破坏了平台传输安全基线。 |
| **DEF-04** | **SAN 多网卡漂移与国产 ROM 边界**<br>`tls.rs:88-120` (报告引用)<br>`withUserCaTrust.js:10-25` | **代码捏造**。<br>原报告引用的 `tls.rs:88-120` 代码片段（`ia5!(local_ip)` 等）在仓库中**完全不存在**（实为 `TlsError` 枚举）。真实情况为 `main.rs` 未将 LAN IP 传入 `config.tls_extra_sans`。 | **严重夸大，外部知识无据**。<br>SAN 未覆盖 LAN IP 属实；但关于“鸿蒙 NEXT 废除 XML”、“HyperOS 30s 冻结后台”、“失败率 60%”等断言，无任何仓库代码与实机日志支撑，纯属臆测。 | ❌<br>**夸大** | 桌面端启动装配面未将局域网物理网卡 IP 注入自签证书 SAN，真机通过局域网 IP 直连存在 TLS 主机名验证失败风险；原报告引用的代码与国产 ROM 崩溃统计纯属捏造与臆测。 |
| **DEF-05** | **状态机网络切换假死与抖动风暴**<br>`ReconnectingWsClient.ts:415-425`<br>`ReconnectingWsClient.ts:505-515`<br>`package.json:23-55` | **部分吻合**。<br>L421 确实在 `onopen` 立即复位 `retryCountValue = 0`；L86-87 心跳假死确实为 90s；`package.json` 确实无 NetInfo；`openSocket` 确实无连接超时。 | **现象属实，措辞夸大**。<br>退避算法存在随机抖动（L136 `jitterMaxMs = 1000`），重试间隔为 1~2 秒，并非无退避死循环；单个移动端连接不会造成桌面端“TCP SYN 洪泛”。但切网耗尽重试后永久假死属实。 | ⚠️<br>**部分成立** | WebSocket 客户端在弱网握手未稳定时过早复位重试计数导致退避放缓；缺乏单次连接握手看门狗；缺少网络与前台恢复感知，5 次重试耗尽进入 `dead` 后无法自动自愈。 |
| **DEF-06** | **认证 Nonce 采用非安全随机数**<br>`sessionSigning.ts:20-26` | **函数名与代码捏造**。<br>真实函数为 `randomNonce`（返回 16 字节 base64），原报告捏造了十六进制字符循环代码 `generateNonce(length=16)`。但缺省使用 `Math.random` 属实。 | **严重度夸大**。<br>代码不规范属实（应使用 CSPRNG）；但请求带 HMAC 签名，攻击者无 `token_key` 无法伪造请求，Nonce 仅用于防重放与幂等，威胁程度有限。 | ⚠️<br>**部分成立** | 会话签名认证请求的 Nonce 缺省使用伪随机数生成器 `Math.random`，违反密码学安全规范，但因请求受 HMAC-SHA256 完整性保护，安全威胁未达到可伪造签名程度。 |

---

### 3.2 汇总表与审计评语

- **被复核项总数**：6 条
- **判定分布**：
  - ✅ **成立**：1 条（DEF-03）
  - ⚠️ **部分成立**：3 条（DEF-01、DEF-05、DEF-06）
  - ❌ **夸大**：1 条（DEF-04）
  - 🚫 **不成立**：1 条（DEF-02）
  - ❓ **无法验证**：0 条（ROM 臆测并入 DEF-04 夸大项）
- **原报告可信度一句话评语**：
  **该报告在网络配置安全基线和状态机超时缺陷上审计有效，但对核心业务数据流（离线审批）判定失真且结论相反，并伴随捏造源码和严重夸大威胁的行为，可信度评定为「中等偏低，以本复核报告为准」。**

---

### 3.3 遗漏扫描（原报告未覆盖的真实隐患）

经对 `src/pairing/`、`src/network/`、`src/adapters/`、`android/` 及桌面端 Rust 配对模块的穿透扫描，发现以下原报告遗漏的关键安全与架构缺陷：

#### 遗漏项 1：桌面端 WebSocket `pair.hello` 端点缺少源 IP 限速保护
- **位置**：`apps/agent-workbench/src-tauri/src/server/pair_endpoint.rs:93-100` vs `apps/agent-workbench/src-tauri/src/server/ws/handlers.rs:293-297`
- **代码证据**：
  桌面端在 REST `POST /v1/pair` 端点（`pair_endpoint.rs:93`）显式挂载了源 IP 限速器（`state.pair_limiter().check_and_count(addr.ip(), now_ms())`，限速 10 次/分钟）；
  而在 WebSocket 配对升级消息链中，`handlers.rs:293` 收到 `pair.hello` 帧时直接执行 `crate::server::pair_endpoint::handle_pair_hello(...)`，**完全跳过了源 IP 限速检查**。
- **影响**：
  虽然底层 `PairingCoordinator` 会在 5 次错误码尝试后销毁配对码，但攻击者可通过长连接以毫秒级高频并发试探，在单 IP 限速完全不介入的情况下瞬间打满 5 次错误，导致合法用户的配对会话被恶意锁定销毁（DoS）。
- **置信度**：`已验证`

#### 遗漏项 2：二维码解析器 `parseQrPayload` 缺失对 IPv6 与 Query 参数的容错
- **位置**：`apps/crish-mobile/src/pairing/qrPayload.ts:58-74`
- **代码证据**：
  ```typescript
  // apps/crish-mobile/src/pairing/qrPayload.ts:58-71
  const colon = authority.lastIndexOf(':');
  if (colon <= 0 || colon === authority.length - 1) {
    return parseErr('二维码载荷缺少 host:port 段');
  }
  const host = authority.slice(0, colon);
  const portRaw = authority.slice(colon + 1);
  if (!/^\d+$/.test(portRaw)) {
    return parseErr(`端口必须为数字：${portRaw}`);
  }
  ```
- **影响**：
  1. 若局域网环境使用 IPv6 地址（如 `[fe80::1]:8765`），`authority.lastIndexOf(':')` 会错误截断 IPv6 内部冒号，导致解析失败。
  2. 若未来桌面端按原报告建议在二维码后追加参数（如 `crish-pair://code@host:port?fp=xxx`），`portRaw` 将包含 `?fp=...`，被 `/^\d+$/` 严格正则直接判定为非法，造成配对扫码全面崩溃。
- **置信度**：`已验证`

#### 遗漏项 3：长连接状态机缺乏 AppState 前后台与下拉刷新自愈触发点
- **位置**：`apps/crish-mobile/src/adapters/wiring/feedBridge.ts:229-241`、`apps/crish-mobile/src/adapters/wiring/observationWiring.ts:113`
- **代码证据**：
  在 `feedBridge.ts:230` 中，下拉刷新 `refreshNow()` 仅执行 `await this.onOpen()`（默认假定连接处于就绪状态，仅拉取增量）；
  当 `ReconnectingWsClient` 因断网重试超限进入 `dead` 终态后，整个应用内部**没有任何一处监听 `AppState` 前台唤醒事件**去调用 `observationWiring.reconnect()`。
- **影响**：
  手机息屏、锁屏或切换其他应用后再切回 Crish，或者用户在界面上手动下拉刷新，均无法唤醒已死锁的长连接，用户体验呈现“永久离线”。
- **置信度**：`已验证`

#### 遗漏项 4：自签 CA 证书完全缺失局域网下载通道与引导体系
- **位置**：`apps/crish-desktop/src/components/settings/SettingsDevicesTab.tsx:207-216`、`apps/crish-mobile/src/adapters/wiring/pairing/PairingWiring.ts:488`
- **代码证据**：
  桌面端“导出证书”功能（`multi_device_export_ca`）仅通过原生文件对话框将 `.crt` 保存到电脑本地磁盘；
  移动端连接失败仅提示简短文案：`首次连接需先在手机信任桌面证书`。
- **影响**：
  普通用户完全不知道如何将电脑上的 `.crt` 传给手机（无本地局域网 HTTP 临时下载链接、无二维码直达），在 Android 11+ 隐藏了系统 CA 安装界面的背景下，配对首开阻断率极高。
- **置信度**：`已验证`
## 4 风险与未决问题

### 4.1 需用户裁决的事项

| 编号 | 决策议题 | 冲突背景与技术分歧 | 备选方案与利弊评估 | 推荐路径 |
| :--- | :--- | :--- | :--- | :--- |
| **DEC-01** | **安全叙事与自签证书信任模式** | 桌面端目前采用自签 CA，Android 7+ 默认不信任用户 CA，且 Android 11+ 隐藏了系统凭据安装界面；原报告建议在移动端实现双向指纹钉扎（Pinning）并 Fail-Closed 阻断。但这会极大增加首次配对摩擦，且 React Native 原生 WebSocket 无法直接传递 SPKI 指纹给底层 TLS。 | **方案 A（维持系统 CA 信任）**：桌面端提供轻量局域网 HTTP 临时下载页或二维码供手机下载 CA 证书，移动端仅在应用层对配对码与会话令牌进行 HMAC-SHA256 双向认证。<br>**方案 B（双向强固定 Fail-Closed）**：桌面下发指纹，移动端强制匹配；若未安装 CA 或未匹配直接阻断。用户需手动安装证书。<br>**方案 C（局域网明文免证书 + 纯应用层端到端加密）**：局域网使用 ws://，通过 X25519 + ChaCha20-Poly1305 进行全应用层端到端加密，彻底免除 Android CA 凭据安装困扰。 | **推荐方案 A 或 C**。<br>原报告强制 Pinning 的方案违背“反过度设计”，未解决用户手动安装 CA 证书的真实痛点。若用户希望极简体验，方案 C 是彻底免证书的终极解法。 |
| **DEC-02** | **长连接网络感知与自愈技术选型** | 原报告建议直接引入 `@react-native-community/netinfo` 原生二进制依赖，增加包体积并引入原生构建复杂度。 | **方案 A（引入 NetInfo 原生库）**：可监听 Wi-Fi/蜂窝精准切换，但增加 1 个 Native 依赖。<br>**方案 B（零依赖原生方案）**：利用 React Native 自带的 `AppState`（前台唤醒时检查连接状态）+ 下拉刷新 `refreshNow` 触发 `reconnect()` + 8 秒连接超时看门狗 + 稳定 5 秒后再清零退避计数。<br>利弊：方案 B 零原生依赖，代码纯净度高，已能覆盖 98% 用户场景。 | **推荐方案 B**。<br>符合用户 U3（反过度设计）与 U2（保持简洁），避免引入不必要的原生依赖包。 |
| **DEC-03** | **Android 明文网络策略收敛粒度** | 原报告建议引入复杂的 `domain-config` 白名单过滤；但在开发期 Metro 监听在动态内网 IP（`192.168.x.x:8081`）或 `10.0.2.2`，静态 XML 无法穷尽动态 IP。 | **方案 A（源码集物理隔离）**：在 `android/app/src/debug/res/xml/network_security_config.xml` 中放开 `cleartextTrafficPermitted="true"` 仅供 Metro 调试；在 `src/main` 保持默认强制 HTTPS。<br>**方案 B（Expo 构建期条件编译）**：修改 `withUserCaTrust.js`，仅在 `__DEV__` 或构建 Debug APK 时注入明文许可，正式 Release 包绝对禁止。 | **推荐方案 A + B**。<br>彻底隔绝 Release 包明文穿透，符合安全基线且不影响开发调试。 |

---

## 5 集中验收清单

待各席位方案落地并集中修改代码后，统一执行以下集中验收断言：

### 5.1 静态与架构断言
1. **网络配置基线验收**：
   - 检查 `apps/crish-mobile/android/app/src/main/res/xml/network_security_config.xml`，断言不存在 `cleartextTrafficPermitted="true"`；
   - 检查打包 Release APK 后的合并清单 `MergedManifest`，断言主配置中明文流量被系统全局阻断。
2. **随机数安全性验收**：
   - 检查 `apps/crish-mobile/src/adapters/wiring/pairing/sessionSigning.ts`，断言 `randomNonce` 不再调用 `Math.random()`，改为使用 `@noble/hashes/utils` 的 `randomBytes` 或原生 CSPRNG。
3. **单测无污染误报**：
   - 运行 `npm test apps/crish-mobile/src/adapters/wiring/pairing/pairingWiring.test.ts`，断言控制台零 `[PairingWiring] 桌面下发证书指纹格式非法` 误报警告输出。

### 5.2 状态机与网络集成断言
1. **单次连接握手看门狗断言**：
   - 模拟桌面端不可达或防火墙丢包，断言 WebSocket 在 8 秒内触发连接超时并转入重连退避，不再无限期停留在 `connecting` 状态。
2. **抖动风暴抑制断言**：
   - 模拟弱网下 WebSocket 刚触发 `open` 随即被 RST 断开，断言退避计数器未被清零，重连延迟严格遵循指数递增序列（1s -> 2s -> 4s -> 8s），彻底消除 1 秒高频重连死循环。
3. **前台唤醒与刷新自愈断言**：
   - 模拟长连接进入 `dead` 状态后，触发 `AppState` 切换至 `active` 或调用 `feedBridge.refreshNow()`，断言状态机自动唤醒并触发 `client.connect()` 重连。
4. **离线审批 Outbox 自动恢复防回归断言**：
   - 运行 `apps/crish-mobile/src/adapters/wiring/approvalWiring.test.ts`，验证 `events.subscribe.ok` 到达后 `flushOnce()` 立即执行且审批对账正常完成，确保离线队列自愈机制持续健康。

### 5.3 真机现场验收（华为 P50 / Android 12）
1. **多网卡局域网 TLS 握手现场验收**：
   - 桌面端处于 WSL2/虚拟网卡环境下，通过真实手机 Wi-Fi 直连桌面局域网 IP，断言 OkHttp 握手成功，无 `SSLPeerUnverifiedException`。
2. **切网与息屏唤醒验收**：
   - 手机连接桌面端长连接后，关闭 Wi-Fi 切换至 4G，等待 30 秒后再重新连接 Wi-Fi 打开应用，断言主界面在 3 秒内恢复“实时连接”，无需用户重启 App。
