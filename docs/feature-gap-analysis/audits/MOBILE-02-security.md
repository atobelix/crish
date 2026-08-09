# MOBILE-02 移动端安全评审（apps/crish-mobile）

- 评审对象：`apps/crish-mobile`（Expo SDK 57 / React Native 0.86.2 / TypeScript）
- 评审方式：只读源码 + 配置文件 + node_modules 版本核对
- 评审日期：2026-08-09
- 结论先行：**当前应用的安全面为"原型占位"水平——生物认证、配对握手、加解密、签名全部为模拟实现；登录 PIN 为硬编码固定值；远程命令/文件删除经明文 ws:// 传输且无消息级鉴权；敏感材料明文存 SQLite。任何一项能力若按宣传口径工作，均可被低成本利用。**

---

## 1. 硬编码密钥 / 凭据扫描

| 类型 | 位置 | 说明 |
|---|---|---|
| 硬编码固定 PIN（登录口令） | `src/screens/LoginScreen.tsx:31` | 4 位数字 PIN 与源码内固定值比对，无失败次数限制、无锁定、无延时。**值未在本文披露** |
| 伪造密钥材料（私钥/公钥） | `src/services/KeyManager.ts:23-24` | 以 `BEGIN PRIVATE KEY` 前缀 + `Math.random()` 拼接的 mock 密钥串，非真实密码学密钥，落入明文 SQLite |
| 伪会话令牌 | `src/services/AuthService.ts:51` | `session_` + `Date.now()` + `Math.random()`，非密码学安全随机 |
| 伪签名 | `src/services/AuthService.ts:47` | `sig_` + `Math.random()`，任何人可仿造 |
| 设备推送令牌泄露到日志 | `src/services/push/PushNotificationManager.ts:48` | FCM/APNs 设备令牌被 `console.log` 输出 |

- **app.json 的 firebase 配置形态**：`app.json:26-27` 仅声明了 `@react-native-firebase/app` 与 `@react-native-firebase/messaging` 两个插件，**无任何 firebase 配置字段**（无 `android.googleServicesFile`、无 `ios.googleServicesFile`）；仓库内亦不存在 `google-services.json` / `agconnect-services.json` / `GoogleService-Info.plist`（已用 glob 与 git ls-files 双重确认）。
- 结论：**当前无真实 API key/secret 硬编码于源码**；真正的密钥风险点是「固定 PIN 口令」与「伪加密材料」。若未来补入 google-services.json，其含的 Firebase 客户端 API key 属"公开可滥用"类型（客户端 key 按设计公开，须靠安全规则约束，不是泄露事故，但不可当作机密）。

## 2. 登录认证

- **机制**：纯本地。生物指纹按钮走 `AuthService.authenticateUser`，而该实现是 `setTimeout(800ms)` 后**无条件 `resolve(true)`**（`src/services/AuthService.ts:28-34`）——按任何指纹、任何人按一下即"认证成功"。
- **PIN**：源码内固定值比对（`src/screens/LoginScreen.tsx:31`），4 位数字暴力空间仅 1 万，且**无失败次数限制、无退避、无锁定**（`LoginScreen.tsx:25-40`），可直接被穷举或静态分析提取。
- **令牌存储**：`AuthService.sessionToken` 只是内存静态变量（`AuthService.ts:8`），**从未持久化、从未被调用产生**（全仓 grep 无调用点）；无 expo-secure-store / expo-local-authentication 依赖（`package.json:5-25` 确认缺失）。登录态仅存 zustand 内存 store（`src/store/index.ts:60`）。
- **会话过期**：无。`logout`（`store/index.ts:62`）只清内存状态并复位 serverAddress，不吊销任何令牌、不清理 SQLite。
- 兜底 PIN 分支（`AuthService.ts:37-40`）直接 `return true`。

## 3. 设备配对协议安全

`src/screens/DevicePairingScreen.tsx:17-51` 流程为：

1. `KeyManager.generateAndStoreKeyPair()` 生成的是 **Math.random() mock 密钥**（`KeyManager.ts:19-43`），存入 SQLite 明文 `key_value_store`；
2. 用户输入的 6 位配对 OTP **从未被发送到服务器、从未被校验**——`DevicePairingScreen.tsx:32-34` 直接 `setTimeout(1500)` 模拟握手；
3. 然后连 `ws://${ipAddress}:8080`（`DevicePairingScreen.tsx:30`）并宣称"cryptographically bound to the desktop kernel"（`:43`）——**纯宣传**。

- 无共享密钥、无服务端确认、无二维码真实现（`DevicePairingScreen.tsx:73` 是 Alert 占位）。
- 配对后通信为明文 WebSocket，**无中间人防护**：无证书校验、无证书 pinning、无服务器身份证明；局域网内任意主机可伪装桌面内核与手机握手并下发命令。

## 4. 网络传输

- **端点矩阵**（`src/services/NetworkStrategyEngine.ts:28-32`）：
  - LAN：`ws://192.168.1.100:8080`（明文）
  - Tailscale：`ws://100.x.x.x:8080`（明文，占位 IP）
  - Cloud：`wss://relay.conex.app/ws`（TLS，但域名疑似占位，无任何部署/配置佐证）
- **默认值**：`src/store/index.ts:66`、`src/screens/Settings.tsx:9`、`src/screens/SettingsScreen.tsx:98` 全部是明文 `ws://192.168.1.100:8080`。
- **传输层**：`ws.ts:12` 直接 `new WebSocket(url)`——无强制 wss、无证书校验、无连接鉴权（无 token header/首次消息鉴权）；`sendAction`（`ws.ts:60-66`）发出的 `{action, payload}` **不携带任何令牌或签名**。
- **明文风险面**：命令下发（`EventStreamScreen.tsx:52`、`TaskRunnerService.ts:61`）、审批决定（`EventStreamScreen.tsx:29`、`ApprovalCenter.tsx:11`）、远程文件删除（`FileManagerScreen.tsx:69`）、Agent 对话（`AgentChatScreen.tsx:56`）全部明文。自动重连（`ws.ts:35`）固定 5 秒、无退避上限，会无条件重连任何已配置 URL。
- `NetworkStrategyEngine` 默认优先明文 LAN 端点，且 failover 逻辑把 TLS 的 cloud 端点排最后。

## 5. 本地存储

- 单一 SQLite 库 `conex_kernel_v1.db`（`src/db/index.ts:9`），**无 SQLCipher/任何加密**（未启用 expo-sqlite 加密，依赖清单中亦无 op-sqlite 等）。
- `key_value_store` 表（`src/db/schema.ts:39-42`）明文存放：mock 私钥（`KeyManager.ts:29-37`）、schema 版本（`db/index.ts:34-37`）；未来会话令牌若照此实现也会明文落库。
- `audit_logs`（`schema.ts:27-37`）明文存审批记录与 payload JSON（含命令文本、文件路径；写入点在 `EventStreamScreen.tsx:35-44`）。
- `macros`（`schema.ts:54-62`）明文存 bash 命令序列（含危险命令，见 §7）。
- 审批记录、命令历史、远程执行内容均无加密，Android 侧无数据库加密配置。

## 6. Firebase / HMS 推送

- `app.json:26-27` 声明 RNFirebase 插件但**零配置**：prebuild 时 `@react-native-firebase/app` 要求存在 `google-services.json`（Android），当前缺失 → **推送链在构建期即失败**；`FCMPushAdapter.ts` 的代码路径实际不可达。
- **依赖形态**：`@react-native-firebase/app/messaging ^26.1.0`（node_modules 实装 26.1.0）会强制拉入 firebase JS SDK 12.17.0 全套传递依赖（node_modules/@firebase 下 auth/firestore/database/storage/app-check/analytics/remote-config… 全部实装）——原生模块混装 web SDK 全套，体积与攻击面膨胀，且与 Expo SDK 57 需走 dev build（Expo Go 不支持 RNFirebase）。
- **推送 payload 安全**：无任何加密/签名校验；后台消息处理为空实现（`PushNotificationManager.ts:73-76`）；无推送令牌与设备绑定校验；设备令牌被 `console.log`（`:48`）。HMS 适配器 `HarmonyPushAdapter.ts:20` 以空 appId 取 token（手写 d.ts：`src/types/hwpush.d.ts`），维护状态存疑。
- 当前无 google-services.json 故**尚无公开可滥用的 Firebase key 入库**；但需预先约定：将来补配置时客户端 API key 属公开形态，必须配合最小化安全规则，且服务端不得使用任何 Firebase 管理密钥。

## 7. 远程控制面（攻击面严重性评估）

- 实际远程执行入口（TerminalView.tsx 仅是日志渲染组件，无终端输入，风险在下方通道）：
  - 任意命令：`EventStreamScreen.tsx:50-55`（`dispatch_command`）
  - 宏批量执行（含种子数据 `rm -rf node_modules`）：`MacroScreen.tsx:40-44`、`TaskRunnerService.ts:31-82`（`TaskRunnerService.ts:61` 逐条下发）
  - 远程文件删除/编辑/重命名：`FileManagerScreen.tsx:58-72`（`fs_mutation`）
  - Agent 指令：`AgentChatScreen.tsx:56`（`agent_chat_input`）
- **授权**：strictMode 下仅文件操作走"生物认证"（`FileManagerScreen.tsx:59-65`），而该认证恒真（§2）；命令下发（`EventStreamScreen.tsx:50`）与宏执行（`MacroScreen.tsx:56-66`）**无任何二次认证**；`autoApprove` 开关（`store/index.ts:71`）可让审批流空转。
- **签名**：`AuthService.signPayload` 返回 `sig_` + Math.random()（`AuthService.ts:42-48`），`fs_mutation` 载荷未加密、未签名、无令牌（`FileManagerScreen.tsx:68-69`）。
- **审计**：本地审计由 `AuditLogRepo` 落库（`EventStreamScreen.tsx:35-44`），但 `AuditLogsScreen.tsx:25-37` 提供**一键清空全部审计记录**的入口（无二次确认之外的任何限制）——审计可被本地篡改，且无服务端审计副本。
- **综合定级**：若该通道真实连通桌面内核，攻击者（局域网内冒充服务器、或持有手机的任何人）可取得等价于「无口令远程 shell + 远程文件删除」的能力。当前因服务端未实现，属"未上膛"，但代码面已完整存在。

## 8. 依赖风险

| 依赖 | 版本 | 风险 |
|---|---|---|
| @react-native-firebase/app, messaging | ^26.1.0（实装 26.1.0） | 与 Expo SDK 57 不兼容 Expo Go，需 dev build；缺 google-services.json 构建必挂；强制携带 firebase JS SDK 全套 |
| firebase（JS SDK，传递） | 12.17.0 | 全套 @firebase/* 被原生模块拉入 RN 包，含 web 专用包（webchannel-wrapper 等），体积/攻击面膨胀 |
| @hmscore/react-native-hwpush | ^4.0.4 | 旧封装、手写 d.ts（`src/types/hwpush.d.ts`），维护状态存疑 |
| expo / react-native / react | ~57.0.11 / 0.86.2 / 19.2.3 | 版本线内正常 |
| **缺失**：expo-secure-store / expo-local-authentication / keychain | — | 敏感材料无处安放，是上述多项问题的根因之一 |
| **缺失**：SQLCipher 类加密存储 | — | SQLite 全明文 |

- 仓库对 `apps/crish-mobile` **未运行过任何依赖审计门禁**（无 npm audit 脚本、无 CI job 覆盖此目录）。

## 9. 问题清单

### P0（可直接被利用 / 数据泄露）
1. 固定 PIN 登录 + 无失败锁定，任何持有设备者可进入远程控制台——`src/screens/LoginScreen.tsx:31`
2. 生物认证恒真（800ms 后无条件成功）——`src/services/AuthService.ts:28-34`；"加密/签名/配对"全部为模拟实现（`KeyManager.ts:23-53`、`AuthService.ts:42-48`、`DevicePairingScreen.tsx:32-34`），安全宣传与实际能力脱节
3. 远程命令/文件删除/审批决定经明文 `ws://` 传输且无消息级鉴权（无令牌、无签名），局域网可窃听、可注入——`src/transport/ws.ts:12,60-66`、`src/screens/DevicePairingScreen.tsx:30`、`src/services/NetworkStrategyEngine.ts:29-30`
4. 整个 `apps/crish-mobile` **未入库**（git status 显示整体 untracked；且根 `.gitignore:358` 的 `*.json` 规则吞掉 `app.json`/`package.json`/`tsconfig.json`）——资产保护风险，与仓库"测试资产保护铁律"冲突

### P1（需加固）
5. 私钥材料明文落 SQLite `key_value_store`——`KeyManager.ts:29-37`、`src/db/schema.ts:39-42`
6. 会话令牌无持久化、无过期时间、`Math.random()` 生成且从未启用——`AuthService.ts:8,50-53`
7. FCM 配置缺失 → 构建失败；将来补 google-services.json 需最小化公开 key 权限——`app.json:26-27`
8. 审计日志可被一键清空，无服务端审计——`AuditLogsScreen.tsx:25-37`
9. 设备推送令牌 console.log 泄露——`PushNotificationManager.ts:48`
10. 无证书校验/pinning；cloud relay 域名（`NetworkStrategyEngine.ts:31`）无部署佐证；自动重连无退避上限（`ws.ts:35`）
11. 推送后台处理空实现，payload 无认证校验——`PushNotificationManager.ts:73-76`

### P2（最佳实践）
12. `GlobalSearchScreen.tsx:52` 查询 `workspaces.path` 列，而 schema（`src/db/schema.ts:6-13`）无此列（功能 bug，运行期会报错）
13. 种子宏含 `rm -rf node_modules` 危险命令——`MacroScreen.tsx:40-44`
14. Tailscale 端点占位 `ws://100.x.x.x:8080` 硬编码——`NetworkStrategyEngine.ts:30`
15. 生物识别 fallback 直接返回 true——`AuthService.ts:37-40`
16. 审批决定（`gate_decision`）无签名、无来源校验——`EventStreamScreen.tsx:29`

## 10. 安全加固建议（按优先级）

1. **认证真实化（P0）**：引入 expo-local-authentication 真生物认证 + expo-secure-store；删除固定 PIN，改为本地随机派生密钥 + 失败锁定（5 次/分钟）与退避延时。
2. **配对协议真实化（P0）**：桌面端生成一次性配对码（短时有效），手机端用公钥注册 + 服务端确认 + 交换会话令牌；配对码仅用于初始注册。
3. **传输加密（P0）**：全链路 `wss://` 强制（LAN 走 Tailscale 或 mTLS）；启用证书 pinning；所有 action 消息携带服务端可验证的签名（HMAC/Ed25519，密钥存 SecureStore），服务端拒绝无签名消息。
4. **存储加密（P1）**：私钥/令牌/会话迁入 expo-secure-store/Keychain；SQLite 启用 SQLCipher（如 op-sqlite）或至少对敏感列加密；审计日志服务端持久化、本地只读展示。
5. **推送链路（P1）**：设备令牌通过 HTTPS API 注册到自建代理（不裸传、不入日志）；补齐或移除 RNFirebase 配置，评估单走 expo-notifications 减少依赖面；google-services.json 只含公开 client key 并配合最小化安全规则。
6. **远程控制授权（P1）**：文件删除/命令执行必须服务端复核 + 前端二次确认（长按/输入确认词）；审计防篡改。
7. **资产入库（P1）**：把 `apps/crish-mobile` 全部纳入版本控制，根 `.gitignore` 显式放行该目录的 `app.json`/`package.json`/`tsconfig.json`。
8. **工程化（P2）**：修复 workspaces.path 查询 bug；替换危险种子宏；去掉占位端点；清理设备令牌日志；为推送后台消息实现最小处理并校验来源。

---

## 最严重 5 项

1. **固定 PIN 登录且无失败锁定**——持有设备的任何人可进入远程控制台（`src/screens/LoginScreen.tsx:31`）
2. **全部"加密/签名/生物认证"为模拟实现**——签名仅为 `sig_`+随机串，配对宣称的"密码学绑定"不存在（`AuthService.ts:42-48`、`KeyManager.ts:23-53`）
3. **远程命令与文件删除经明文 ws:// 传输且无消息级鉴权**——局域网内可窃听/注入任意命令（`ws.ts:12`、`DevicePairingScreen.tsx:30`）
4. **私钥与敏感数据明文存 SQLite**——无任何加密（`KeyManager.ts:29-37`、`db/index.ts:9`）
5. **整个 crish-mobile 未入库且 app.json/package.json 被根 .gitignore 的 `*.json` 规则吞掉**——资产保护缺口（`.gitignore:358`）
