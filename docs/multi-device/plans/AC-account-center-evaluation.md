# AC-账号中心评估：navigation-site 作为 crish 多端账号体系的适配性评估

> 文档状态：评估报告（只读分析产出）
> 产出路径：`C:\Software\conex\docs\multi-device\plans\AC-account-center-evaluation.md`
> 评估对象：`C:\Software\account-center\navigation-site`（zennav-web + zennav-server）及 `C:\Software\account-center` 根目录其余子项目
> 评估子代理：AC（账号体系评估）
> 日期：2026-08-09
> 定位：本报告回答"navigation-site 是否适合作为 crish 多端互通的云端账号服务"，给出「可用 / 需调整 / 重做」裁决与调整方案。上游母方案为 `D1-overall-architecture.md`（多端互通总体架构），推送维度对齐 `D7-push-notifications.md`。

---

## 目录

1. [结论摘要（TL;DR）](#1-结论摘要tldr)
2. [评估对象与事实来源](#2-评估对象与事实来源)
3. [项目定性](#3-项目定性)
4. [与 crish 多端场景的适配评估（差距表）](#4-与-crish-多端场景的适配评估差距表)
5. [结论：需调整（非重做）](#5-结论需调整非重做)
6. [调整方案](#6-调整方案)
7. [与 crish 的集成面](#7-与-crish-的集成面)
8. [里程碑与工作量](#8-里程碑与工作量)
9. [风险与开放问题](#9-风险与开放问题)
10. [附录：证据索引](#10-附录证据索引)

---

## 1. 结论摘要（TL;DR）

**裁决：需调整（核心可用，补齐差距），不需要重做。**

- **navigation-site 不是一个"导航站空壳"，而是一个已生产运行的单体账号中心**（线上代号 flowbit-auth，公开入口 `https://auth.flowbit.me/api`，源码即 `zennav-server`）。账号体系核心（注册/登录/令牌/会话/设备/桌面授权/审计）完成度高、有线上验证、有多应用 SSO 先例（chat-website 已接入）。
- 与 crish 需求的差距集中在**两个新增模块 + 一个白名单 + 若干安全强化**：① 推送令牌绑定（现无任何 push token 表/端点）；② 中继连接鉴权（现只有短 TTL Bearer + service token，无长连接凭据签发）；③ desktop-auth 应用白名单扩展（现仅允许 `chat_sync_desktop`）；④ 登录/验证码限流、设备信任审批、CORS 收敛等安全加固。
- **中继转发服务本身**（WebSocket 长连接转发）zennav-server 不具备，且与账号体系应解耦——建议独立新写轻量 Rust 中继（axum + tokio-tungstenite），账号中心只做"身份/凭据签发与校验"。
- crish 侧保持"云账号可选"原则（对齐 D1 §4.5）：局域网配对为主，云账号只在中继/跨网/推送场景启用，桌面功能在任何情况下不依赖账号中心。

---

## 2. 评估对象与事实来源

### 2.1 评估范围

| 对象 | 路径 | 说明 |
|------|------|------|
| 主评估对象 | `C:\Software\account-center\navigation-site\` | zennav-web（前端）+ zennav-server（后端）+ 部署脚本/产物 |
| 环境上下文 | `C:\Software\account-center\` 根目录 | cdk-website / chat-website / modules（ccNexus、codex-manager、litellm、NewAPI-Gateway 等）/ mail / plan / deploy_tmp / runtimes |
| crish 侧输入 | `C:\Software\conex\docs\multi-device\plans\` | D1 母方案、D3 协议、D7 推送（需求基准） |

### 2.2 关键事实来源（可复核证据）

- 后端入口与路由注册面：`C:\Software\account-center\navigation-site\zennav-server\src\index.ts`（22 个功能模块全量注册，行 120-183）
- 账号服务实现：`...\zennav-server\src\modules\auth\auth.routes.ts`（616 行，17 组端点）+ `auth.service.ts`（2224 行）
- 数据模型：`...\zennav-server\src\db\schema.ts`（769 行，40+ 张表）
- 设备注册表：`...\zennav-server\src\modules\devices\device.service.ts`（platform 枚举含 desktop/mobile）
- 同步引擎：`...\zennav-server\src\modules\sync\sync.service.ts`（LWW + rev + mutation 幂等）
- 前端会话存储：`...\zennav-web\src\stores\auth-store.ts`（localStorage 落盘 access/refresh token）
- 生产部署事实：`C:\Software\account-center\ACCOUNT.txt`（flowbit-auth 容器、auth.flowbit.me、韩国服务器 100.77.75.39 / 43.108.54.141、chat.flowbit.me 前端已接入 auth.flowbit.me 作 SSO）

> 说明：以下正文为控制行宽，对高频引用使用缩写：`SVR = C:\Software\account-center\navigation-site\zennav-server`，`WEB = C:\Software\account-center\navigation-site\zennav-web`，`ROOT = C:\Software\account-center`。首次出现均给出完整绝对路径。

---

## 3. 项目定性

### 3.1 它是什么：不只是导航站，是"导航站 + 账号中心（SSO）"的一体化产品

navigation-site 产品名"跃览导航（ZenNav / zennav）"，实际承载两个角色：

1. **导航站**（zennav-web 的 HomePage/导航面板，浏览器导航 + 书签 + 日程/任务/备忘录等个人效率工具）；
2. **FlowBit 账号中心**（zennav-server 的 auth/account/billing 模块 + zennav-web 的 /account 设置区），已被 chat-website 作为外部 SSO 与计费源使用（`ROOT\chat-website\.env.production` 的 `VITE_AUTH_BASE=https://auth.flowbit.me/api`、`VITE_ACCOUNT_API_BASE=https://auth.flowbit.me/api`；`ROOT\chat-website\server\.env.example` 的 `ACCOUNT_API_BASE=https://auth.flowbit.me/api`）。

也就是说：**账号能力不是该项目的占位规划，而是已经上线、被第二个独立应用消费的成熟服务**。这是本次评估最重要的定性结论。

### 3.2 技术栈

| 层 | 技术 | 证据 |
|----|------|------|
| 后端运行时 | Node.js + TypeScript（CommonJS），Fastify 5 | `SVR\package.json`（fastify ^5.8.4；type=commonjs；tsx dev / tsc build） |
| 后端存储 | SQLite 单文件（better-sqlite3 同步 API），单库 40+ 表 | `SVR\src\db\client.ts` / `schema.ts` |
| 后端测试 | Node 内置 test runner（tsx --test）+ Python 冒烟脚本 | `SVR\package.json`（smoke:auth、test） |
| 前端 | React 18 + Vite 8 + Tailwind 4 + Zustand + Dexie（IndexedDB） | `SVR\..\zennav-web\package.json`；`WEB\src\stores\*`（zustand）、`WEB\src\hooks\use-dexie-hydrate.ts` |
| 前端路由 | 无路由库，pathname 分发（/account、/account/access、/account/desktop-auth） | `WEB\src\App.tsx:42-48,361-363` |
| 部署 | Docker（node:22-bookworm-slim），端口 8787，数据卷 /app/data | `SVR\Dockerfile` |
| 邮件 | nodemailer + SMTP（Gmail / Mailu），非生产环境返回 devCode | `SVR\.env.example:20-27`；`SVR\src\modules\auth\auth.service.ts:936-938` |

### 3.3 后端功能清单（22 个路由模块，全部注册于 `SVR\src\index.ts:120-183`）

| 模块 | 路由前缀 | 功能 | 完成度 |
|------|----------|------|--------|
| auth | /api/auth | 邮箱密码登录、邮箱验证码登录、注册（验证码+密码）、改密、刷新、登出、会话列表/撤销、设备会话撤销、/me、资料/头像、绑定邮箱、合并账户、绑定票据（微信扫码）、handoff 交接、desktop-auth 桌面授权 | **生产级（详见 §3.5）** |
| account | /api/account | 偏好设置（cloud_sync_enabled 等 9 项）、账户上下文聚合 | 生产级 |
| devices | /api/devices | 设备注册/更新/心跳/删除（platform 含 desktop/mobile/web/browser_extension/api） | 生产级 |
| sync | /api/sync | push/pull，LWW + rev + mutation 幂等 + patch ops | 生产级 |
| billing / usage / product-entitlement / payment / external-order-bridge | /api/billing 等 | 计费账本、权益、订单桥、支付（Zhupay） | 生产级（flowbit 商业闭环） |
| ai（conversation/ledger/gateway/catalog/provider-credential/pricing-view + openai-compatible /v1） | /api/ai、/v1 | AI 网关、模型目录、供应商凭据、OpenAI 兼容出口（对接 Sub2API/NewAPI） | 生产级 |
| admin（review/observability/legal-hold） | /api/admin | 内容审查、可观测、合规留证 | 生产级 |
| assets / shares / clipboard / workspace / zendrop | /api/assets 等 | 文件资产、分享链接、剪贴板同步、工作区、跨设备传输 | 生产级 |
| projects / reminders / resources / icon / wallpaper / privacy | 对应前缀 | 项目管理、提醒、资源链接、图标缓存、壁纸、隐私（数据保留/主体请求） | 生产级 |
| wechat | /wechat | 微信公众号绑定回调 | 生产级 |
| health | /health | 健康检查 | 生产级 |

### 3.4 前端功能清单（`WEB\src\features\`，10 个 feature）

auth（AuthModal 登录弹窗 + DesktopAuthPage 桌面授权页）、navigation（导航面板）、home（首页/HomePage/FloatBar/AddModal）、drops（ZenDrop 跨设备面板）、memo、tasks、timer、timeline、search、settings（/account 账户中心：overview/profile/plan/billing/usage/appearance/bookmarks/search/behaviors/security/developer/data 共 12 个 tab，见 `WEB\src\App.tsx:27-40`）。

### 3.5 完成度评估：账号体系是生产级，不是空壳

判定依据（逐条可复核）：

1. **线上事实**：`ROOT\ACCOUNT.txt:660-708` 记录 flowbit-auth 容器（韩国 43.108.54.141:8787）与 chat.flowbit.me 前后端的发布/回滚/验证记录；`ROOT\ACCOUNT.txt:664` 记录账号中心 → 新加坡 Sub2API 的服务间链路与计费 E2E 验证结果（web/api 双渠道扣款、余额同步）。
2. **第二消费方**：chat-website 已在生产使用 auth.flowbit.me 做 SSO 与 AI 计费（§3.1 证据），说明账号中心的令牌体系不是自娱自乐，跨应用契约已成立。
3. **代码成熟度**：auth 模块 2224 行 + 17 组端点覆盖完整生命周期；有审计（`auth.service.ts:2034-2049`）、票据过期回收（`auth.service.ts:2051-2109`）、合并账户（`auth.service.ts:1063-1105`）、设备级会话撤销（`auth.service.ts:501-525`）等"生产才需要"的细节。
4. **遗留痕迹**（完成度反证）：`schema.ts:27-33` 的 `users` 表是微信 openid 时代的旧表，现已被 `accounts` + `account_identities` 取代——说明体系经历过演进而非一次性玩具；`schema.ts:315-580` 的计费/AI 表属于 flowbit 商业域，对 crish 无用但可忽略。
5. **占位成分**：未发现认证/会话相关的 TODO/桩实现；桌面授权页（`WEB\src\App.tsx:51-153`）是完整 UI。未逐一核验 settings 各 tab 的视觉完成度（不影响账号服务结论）。

### 3.6 数据存储

- **后端**：SQLite 单库（`SVR\.env.example:3` DB_PATH=./data/zennav.sqlite）。账号域表：accounts、account_identities、sessions、bind_tickets、app_links、handoff_tickets、desktop_auth_requests、email_verification_tickets、email_auth_tickets、merge_candidates、audit_logs、account_files、account_preferences（`SVR\src\db\schema.ts:2-149,352-364`）。设备记录不在独立表，而是作为 CRDT 实体存入 `user_data`（entity='devices'，`SVR\src\modules\devices\device.service.ts:61-63,209-241`）——这是 sync 体系的一部分。
- **前端**：Dexie（IndexedDB）本地缓存 + localStorage 持久化会话（`WEB\src\stores\auth-store.ts:26-29` 的 `zennav.auth.session` 存 user/accessToken/refreshToken，`zennav.auth.device_id` 存设备 id）。
- **无 Redis/消息队列**；无独立推送服务；无 WebSocket/SSE 通道（全仓库 grep 未发现 push/websocket/fcm/apns 模块，命中均为 "asset" 子串噪音）。

### 3.7 部署形态与运营

- Docker 单容器（node:22-bookworm-slim），8787 端口，SQLite 挂数据卷（`SVR\Dockerfile`）；前端独立构建部署（`ROOT\ACCOUNT.txt:691-699` 的 Nginx SPA + /api 反代）。
- 线上域名体系：auth.flowbit.me（账号中心）、chat.flowbit.me（chat 前端）、api.flowbit.me（Sub2API）、relay-sg-7q4.flowbit.me（新加坡 AI 中继）等，走 Cloudflare DNS + Let's Encrypt。
- 存在完整的回滚点/备份惯例（容器镜像 tag、SQLite 备份文件、Nginx 配置备份，`ROOT\ACCOUNT.txt:660-717`）。

---

## 4. 与 crish 多端场景的适配评估（差距表）

### 4.1 crish 需求基准（来自 D1/D7 母方案）

crish 多端互通的云端账号体系需求（任务书所列 + 母方案裁决）：

1. 用户注册登录（跨端统一身份）；
2. 令牌签发与刷新；
3. 设备注册与撤销（含设备管理 UI）；
4. 推送令牌绑定（厂商通道 token 注册，D7 §3/§4 路线 C）；
5. 中继连接鉴权（跨网长连接身份，D1 §3.3/§4.5）；
6. 多端会话管理（列出/撤销/按设备撤销）；
7. （任务书附加）多端同步凭据。

另注意 D1 的架构裁决：**P1-P2 不依赖云账号**（§4.5："中继服务若要区分用户，需可选账号"），云账号是**中继的可选增强**；D7 一期自建云中继列为 M3 可选演进。因此评估基准是"云账号=可选项"，而非"必须项"。

### 4.2 能力差距总表

| # | 需要的能力 | 项目现状 | 差距等级 | 结论 |
|---|-----------|----------|----------|------|
| 1 | 用户注册登录 | ✅ 邮箱+密码 / 邮箱验证码 / 微信扫码绑定（`SVR\src\modules\auth\auth.routes.ts:119-177`）；昵称/头像/资料 | 无 | **直接可用** |
| 2 | 令牌签发与刷新 | ✅ access token（`zn1.{payload}.HMAC-SHA256`，状态化：校验 sessions 行，15 分钟 TTL）+ refresh token（30 天、单次轮换、旧 token 自动失效）（`auth.service.ts:356-393,2111-2147`） | 无 | **直接可用** |
| 3 | 设备注册与撤销 | ✅ /api/devices 全套（platform 枚举含 desktop/mobile、trusted 标记、lastSeenAt 心跳、软删除）（`SVR\src\modules\devices\device.routes.ts:23-82`）+ 会话级设备撤销（`auth.service.ts:501-525`） | ⚠️ 小 | **需调整**（见 6.2） |
| 4 | 推送令牌绑定 | ❌ 无 push token 表、无注册/撤销端点、无厂商通道抽象 | **缺失** | **新增模块**（6.3） |
| 5 | 中继连接鉴权 | ⚠️ 半有：Bearer access（短 TTL）+ AUTH_SERVICE_TOKEN（`auth.service.ts:2171-2183`）；无"长连接凭据"签发/校验端点；无在线状态 | ⚠️ 中 | **需调整**（6.4） |
| 6 | 多端会话管理 | ✅ sessions 列表/撤销/按设备撤销/登出全量（`auth.routes.ts:203-278`） | 无 | **直接可用** |
| 7 | 多端同步凭据/数据 | ✅ sync push/pull（LWW+rev+幂等 mutation，`sync.service.ts:147-403`）+ workspace 隔离 | 无（超需） | 可选能力（6.9） |
| 8 | 桌面端授权登录（扫码/授权流） | ✅ desktop-auth（deviceId + 32B clientSecret + 浏览器授权 + exchange 换 token）（`auth.service.ts:1138-1292`）+ handoff 交接（`auth.service.ts:1294-1359`） | ⚠️ 小 | **直接可用，白名单待扩**（6.2） |
| 9 | 安全基线（哈希/限流/审计） | ✅ scrypt 密码哈希（`auth.service.ts:2206-2219`）、timingSafeEqual、审计日志、票据过期 | ⚠️ 中 | **需强化**（6.5） |

### 4.3 关键模块深评

#### 4.3.1 令牌体系（可直接复用，优于常见 JWT 方案）

- access token 为自签状态化令牌：payload `{sid, uid, exp}` + HMAC-SHA256 签名（`auth.service.ts:2115-2147`）；校验时**回查 sessions 行**（`auth.service.ts:1629-1651`）——撤销会话立即令 token 失效，这是无状态 JWT 不具备的吊销能力，与 crish 的"设备撤销必须即时生效"需求吻合。
- refresh token 轮换：每次刷新生成新 token 并覆盖 sessions 行（`auth.service.ts:356-393`），旧 refresh token 因查不到行而失效（防重放的基本形态；未实现"重用检测告警"，见 6.5）。
- TTL 可配：ACCESS_TOKEN_TTL_SECONDS=900 / REFRESH_TOKEN_TTL_DAYS=30（`SVR\.env.example:17-18`）。

#### 4.3.2 桌面授权流（与 crish"手机授权桌面登录"场景几乎同构）

`createDesktopAuthRequest`（无鉴权，提交 deviceId+app）→ 用户在已登录的 Web 端 `inspect` + `authorize`（Bearer）→ 设备端 `exchange`（凭 clientSecret）换 access+refresh（`auth.routes.ts:517-592`；`auth.service.ts:1138-1292`）。安全设计：clientSecret 32 字节随机、服务端只存 HMAC（`auth.service.ts:1150-1151,2197-2200`）、票据 5 分钟过期、单次消费。

对 crish 的意义：手机端"授权桌面端登录"或"桌面端扫码确认手机端登录"都可复用此机制；也可反过来用（桌面生成请求、手机浏览器确认，见 §7.3）。**唯一限制：`DESKTOP_AUTH_APPS` 白名单目前只有 `chat_sync_desktop`（`auth.service.ts:244`），crish 需登记 app 名。**

#### 4.3.3 设备注册表（有，但语义需对齐）

devices 模块满足"注册/心跳/删除"骨架，且 platform 枚举已含 desktop/mobile（`device.service.ts:4-6`）。三个对齐点：

1. 设备记录是 sync CRDT 实体（存 user_data），而 sessions.device_id 是独立字符串体系——两者**无外键关系**；crish 若想"撤销设备 = 撤销其全部会话 + 撤销推送 + 断中继"，需要打通（6.2）；
2. `trusted` 默认 true（`device.service.ts:274`），无"新设备需审批"流程；
3. 无"设备凭据"（设备侧私钥/secret）概念——desktop-auth 的 clientSecret 是单次交换用的，不是设备长期凭据。crish D1 的设备 Ed25519 密钥对体系（§4.2）是**本地配对体系**，与账号中心设备表是两套并行的东西，需要明确映射（§7）。

#### 4.3.4 推送（完全缺失——最大差距项）

全后端无 push/ws/sse/fcm/apns 模块；前端无推送客户端。D7 一期裁决是"桌面 WS 直推优先 + 厂商通道兜底"，账号中心在 M3 路线 C 的角色是"设备注册表 + token 管理 + 厂商通道代理"。**这块必须新增**（§6.3），且建议以"注册表在账号中心、发送器在 crish 桌面/中继"的形态落地，与 D7 的 push-core 在桌面端的裁决保持一致。

#### 4.3.5 中继鉴权（半有，需专门化）

现有可用原语：Bearer access（15 分钟，不适合长连接常驻）、refresh（30 天，轮换语义与长连接不匹配）、AUTH_SERVICE_TOKEN（静态共享密钥，适合服务间，不适合按用户/设备签发）。crish 中继场景需要"设备可持有的、短 TTL、可撤销、可绑定 account+device"的连接凭据——**需要新增 relay credential 机制**（§6.4），并注意与 D3 协议"设备签名 + refresh_key"体系的分工：账号中心凭据只用于"连中继"，端间消息鉴权仍走 D3 的设备级 HMAC。

#### 4.3.6 同步引擎（超需但可作可选能力）

sync 的 LWW + rev + mutation 幂等 + patch ops（`sync.service.ts:88-132,147-403`）是导航站数据（书签/设置）的跨设备同步基础。crish 桌面是单真相源（D1 §5.1），**不需要**数据 CRDT 同步；但"用户偏好/设置"这类低冲突数据若要跨端，可复用该引擎或至少其 mutation 幂等模型（6.7 列为可选，不推荐一期做）。

### 4.4 可用资产映射表（现成机制 → crish 场景，复用索引）

| 账号中心现成机制 | 位置 | crish 复用场景 | 直接复用 | 需适配 |
|------------------|------|----------------|----------|--------|
| email 密码登录 + 验证码登录 | `auth.routes.ts:119-153` | 桌面/手机云登录 | ✅ | 仅限流（A5） |
| email 注册（验证码确认） | `auth.routes.ts:155-177` | 云账号注册 | ✅ | 仅限流 |
| 密码重置 | `auth.routes.ts:179-201` | 忘记密码 | ✅ | 仅限流 |
| refresh 轮换 | `auth.service.ts:356-393` | 令牌刷新 | ✅ | 重用检测（A6） |
| 会话列表/撤销/设备撤销 | `auth.routes.ts:203-278` | 设备管理 UI、远程登出 | ✅ | A9 附加推送/中继状态 |
| bind-ticket（6 位码 + 二维码） | `auth.service.ts:285-354` | 桌面-手机扫码互绑（微信场景，crish 可选） | ✅ | 无微信则仅用 code 路径 |
| desktop-auth（deviceId + clientSecret + 授权 + 交换） | `auth.service.ts:1138-1292` | 桌面↔手机授权登录（核心资产） | ✅ | 白名单扩展（A1/A2） |
| handoff（跨应用交接） | `auth.service.ts:1294-1359` | 从 Web 面板跳 crish 客户端免登录 | ✅ | service token 配置 |
| 设备注册表（platform/trusted/心跳/软删） | `device.service.ts:97-170` | 设备清单、在线心跳 | ✅ | 信任审批（A4）、联动（A3） |
| 审计日志 | `auth.service.ts:2034-2049` | 安全审计、异常登录告警 | ✅ | 无 |
| 邮箱绑定/合并账户 | `auth.service.ts:856-1105` | 多邮箱归一、历史账号合并 | ✅ | 无 |
| 账户偏好（cloud_sync_enabled 等） | `schema.ts:352-364` | crish 云端偏好存储 | ✅ | 加 crish 专属键 |
| sync 引擎 | `sync.service.ts:147-403` | （可选）设置/书签类低冲突数据跨端 | ⚠️ 超需 | 不推荐一期（6.9） |
| workspace / 成员 | `schema.ts:151-181` | （远期）多桌面共享工作区 | ⚠️ 超需 | 不推荐一期 |
| OpenAI 兼容 /v1 + 计费 | `index.ts:177-183` | **不适用**（crish 自带 provider 体系） | ✗ | 忽略 |
| zendrop/clipboard/shares | `index.ts:155-175` | **不适用**（crish 局域网直连传输） | ✗ | 忽略 |

### 4.5 安全评估（现状 vs 缺口）

| 项 | 现状 | 评级 |
|----|------|------|
| 密码哈希 | scrypt（Node 默认参数 N=16384,r=8,p=1），格式 `scrypt:salt:derived`（`auth.service.ts:2206-2219`） | ✅ 合格（可考虑上调参数） |
| 令牌签名 | HMAC-SHA256 + timingSafeEqual；状态化吊销 | ✅ 合格 |
| 票据机密性 | clientSecret 只存 HMAC；bind 码 6 位随机、5 分钟过期 | ✅ 合格 |
| 邮件验证码 | 非生产返回 devCode（`auth.service.ts:936-938`）；**无发送频率限制** | ⚠️ 需强化（限流） |
| 登录防爆破 | **无 rate limit、无账号锁定、无失败计数**（全仓库未见） | ❌ 需强化 |
| CORS | 生产默认 `*` + credentials:true（`SVR\src\index.ts:62-67`；`.env.example:4`） | ⚠️ 需收敛 |
| 设备信任 | trusted 默认 true，无审批 | ⚠️ 需强化 |
| 审计 | audit_logs（auth 全动作）+ audit_events/security_logs（部分模块） | ✅ 合格 |
| refresh 重用检测 | 轮换后旧 token 失效，但无"检测到旧 token 重放→撤销整个会话"逻辑 | ⚠️ 建议补 |
| 会话并发 | 同 user+device 新会话自动吊销旧会话（`auth.service.ts:1601-1624`） | ✅ 合格（符合"一设备一会话"） |
| SQL | 全参数化（better-sqlite3 prepared statements） | ✅ 合格 |

---

## 5. 结论：需调整（非重做）

### 5.1 裁决

**「需调整」**——具体为：**核心（注册/登录/令牌/会话/设备/审计）直接复用，新增推送注册与中继凭据两个模块，扩展应用白名单，补齐安全强化，中继转发服务独立新写。**

### 5.2 为什么不是"可用（小调整）"

差距项 #4（推送令牌绑定）和 #5（中继连接鉴权）是**结构性的新模块**（新表 + 新端点 + 新逻辑），不是配置级小调整；设备注册表还需语义打通。因此"小调整"不成立。

### 5.3 为什么不是"重做"（三条硬理由）

1. **账号核心已被生产验证并被第二应用消费**：auth.flowbit.me 承载 chat-website 的 SSO 与计费（§3.1/§3.5），重做 = 丢弃线上验证过的认证/会话/审计体系，换成未经验证的实现，安全风险不降反升。
2. **需求重合度高，差距可枚举**：crish 需要的 9 项能力中 6 项直接可用、1 项小调整、2 项新增，重做成本与收益不成比例。
3. **技术栈差异不构成重做理由**：zennav-server 是 TS/Fastify，crish 是 Rust——但账号服务是**独立部署的进程**（本就在 Node 生态），不是 crish 进程内组件；语言统一只对"crish 进程内"组件有意义。真正与 crish 栈强相关的**中继转发服务**反而应该在 Rust 侧新写（§6.4），与账号服务解耦——这恰好避开"整个账号体系重写成 Rust"的高成本路径。

### 5.4 边界声明（重要）

- 评估对象是**账号体系**；导航站业务、计费/AI 模块与 crish 无关，不在调整范围（只要求"共存不冲突"）。
- flowbit 账号中心是**第三方生产系统**（外部依赖），crish 必须保持"无云账号可全功能运行"（对齐 D1 铁律"桌面功能不依赖多端互通"，延伸为"不依赖账号中心"）。此边界贯穿全部方案（§9 风险）。

---

## 6. 调整方案

### 6.1 总体架构（调整后的形态）

```
┌─────────────────────────────────────────────────────────────────────┐
│ crish 桌面（Hub，Rust/Tauri）        crish 手机（Companion）          │
│  · 本地配对体系（D3：Ed25519 设备密钥，不依赖云）                     │
│  · 可选云账号：登录/绑定（令牌存 OS 凭据库）                         │
│  · 推送策略引擎 push-core（D7，事件→推送意图）                       │
└───────────────┬──────────────────────────┬───────────────────────────┘
                │ wss（RelayLink，带中继凭据）│ wss（RelayLink，带中继凭据）
                ▼                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 中继服务（新写，Rust：axum + tokio-tungstenite）——只转发不解密        │
│  · 连接鉴权：校验凭据（调账号中心 /api/relay/verify 或本地缓存）      │
│  · 在线状态/推送节流（可选）                                         │
└───────────────┬─────────────────────────────────────────────────────┘
                │ HTTPS（服务间，带 AUTH_SERVICE_TOKEN）
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 账号中心（复用 zennav-server = flowbit-auth，@ auth.flowbit.me）      │
│  · 现有：注册/登录/令牌/会话/设备/审计                                │
│  · 新增：push_tokens 注册表、relay_credentials、限流、白名单扩展      │
│  · 推送发送：crish 桌面经账号中心代理厂商通道（可选）或直连厂商       │
└─────────────────────────────────────────────────────────────────────┘
```

角色分工一句话：**账号中心管"人、设备、令牌、推送注册、中继凭据"；中继服务管"转发与在线状态"；crish 桌面管"事件、推送意图、本地配对"**。三者解耦，任一可独立演进。

### 6.2 调整点清单（文件级，账号服务侧）

| # | 改动点 | 位置（`SVR\` = `C:\Software\account-center\navigation-site\zennav-server\`） | 内容 |
|---|--------|---------|------|
| A1 | 扩展 desktop-auth 应用白名单 | `src\modules\auth\auth.service.ts:244`（`DESKTOP_AUTH_APPS = new Set(['chat_sync_desktop'])`） | 增加 `crish_desktop`、`crish_mobile`；建议改为 env 配置（`AUTH_DESKTOP_APPS`），避免改代码发版 |
| A2 | app 名规范化扩展 | `auth.service.ts:2165-2169`（`normalizeApp`） | 增加 `crish`/`crish_desktop`/`crish_mobile` 归一化映射（现在 `navigation/zennav → nav`） |
| A3 | 设备 ↔ 会话打通（撤销联动） | `src\modules\devices\device.service.ts`（removeDevice 目前只软删 device 记录） | removeDevice 时联动：撤销该 (account,deviceId) 全部会话（复用 `auth.service.ts:501-525` 的 revokeDeviceSessions 语义）+ 撤销该设备推送注册 + 吊销中继凭据；在 routes 层编排（`device.routes.ts:71-82`） |
| A4 | 设备信任流程 | `device.service.ts:97-123,274` | trusted 默认值改为可选（`TRUST_DEVICE_ON_FIRST_SEEN` env）；新设备标记 pending，支持 `/api/devices/:id/trust`（Bearer + 已有设备或账号密码二次验证）——一期可仅支持"列表展示 + 手动标记"，UI 在 crish 端设置页 |
| A5 | 登录/验证码限流 | `src\index.ts`（全局注册）+ `src\modules\auth\auth.routes.ts` | 引入 `@fastify/rate-limit`：登录/注册/验证码端点按 IP+email 限流（如 5 次/15 分钟）；access token 校验失败计数 + 慢日志 |
| A6 | refresh 重用检测 | `src\modules\auth\auth.service.ts:356-393` | refreshToken 轮换时若收到已被替换的旧 token（查不到行但 hash 命中历史），判定疑似重放 → 撤销该会话全部令牌并写 security_logs |
| A7 | CORS 收敛 | `src\index.ts:62-67` + `.env.example:4` | 生产 `CORS_ORIGIN` 从 `*` 收敛为显式列表（chat.flowbit.me、zennav 域名、crish 相关域名）；服务端对 `Origin` 白名单校验 |
| A8 | 密码哈希参数 | `auth.service.ts:2206-2219` | scrypt 参数上调（N=2^17 量级）并保持向后兼容（校验时按格式头分支） |
| A9 | 会话列表 API 增加推送/中继状态 | `auth.routes.ts:226-242`（GET /sessions） | sessions 响应中附加该设备 push token 数、中继凭据状态（join 新表），供设备管理 UI 一屏管理 |
| A10 | env 配置化 | `src\config\env.ts` | 新增 AUTH_DESKTOP_APPS、PUSH_*、RELAY_* 配置项 |

### 6.3 新增模块 ①：推送令牌注册表（push_tokens）

**动机**：D7 §4 路线 C 需要"设备注册表 + token 管理"；账号中心是天然落点（account+device 已有）。

**数据模型**（追加到 `src\db\schema.ts`）：

```sql
CREATE TABLE IF NOT EXISTS push_tokens (
  id                  TEXT PRIMARY KEY,               -- pt_<uuid>
  account_id          TEXT NOT NULL,
  device_id           TEXT NOT NULL,                  -- 与 sessions.device_id 同一体系
  platform            TEXT NOT NULL,                  -- apns | hms | xiaomi | vivo | oppo | honor | fcm
  vendor_token        TEXT NOT NULL,                  -- 厂商侧 device token（原样存储/加密可选）
  token_hash          TEXT NOT NULL UNIQUE,           -- HMAC(vendor_token) 用于幂等与反查
  bundle_id           TEXT NOT NULL DEFAULT '',       -- 移动端应用标识（多 app 隔离）
  app                TEXT NOT NULL DEFAULT 'crish',   -- 绑定到哪个应用（对齐 app_links 语义）
  status              TEXT NOT NULL DEFAULT 'active', -- active | unregistered | expired
  last_registered_at  INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(account_id, device_id, platform, bundle_id)
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_account ON push_tokens(account_id, status);
CREATE INDEX IF NOT EXISTS idx_push_tokens_device ON push_tokens(device_id, status);
```

**端点**（新模块 `src\modules\push\push.routes.ts` + `push.service.ts`，注册前缀 `/api/push`）：

| 方法 | 路径 | 鉴权 | 语义 |
|------|------|------|------|
| POST | /api/push/tokens | Bearer | 注册/更新推送令牌（body: deviceId/platform/vendorToken/bundleId）；相同 token 幂等（token_hash 冲突则更新） |
| DELETE | /api/push/tokens/:id | Bearer | 解绑（设备登出/App 卸载调用）；也接受 vendorToken 反查删除 |
| GET | /api/push/tokens | Bearer | 列出本账号全部推送注册（设备管理 UI） |
| POST | /api/push/tokens/:id/unregister | Bearer | 标记 unregistered（厂商回报 DeviceNotRegistered 时由发送方调用） |

**安全要点**：vendor_token 属敏感标识（可用于定向推送），DB 存储建议加密（复用 AI_CREDENTIAL_SECRET 同款机制或独立 secret）；查询一律按 account_id 过滤；注册时校验 deviceId 属于该账号（与 sessions/device 记录一致）。

**发送方职责（不在账号中心）**：按 D7 裁决，推送发送器（厂商 REST 调用、失败重推、DeviceNotRegistered 处理）放 crish 桌面 push-core 或中继侧；账号中心只做注册表。接口为发送方提供：`GET /api/push/tokens?accountId=&app=`（服务间调用，带 AUTH_SERVICE_TOKEN，按需提供）。

### 6.4 新增模块 ②：中继连接凭据（relay_credentials）+ 中继服务选型

**动机**：中继（D1 §3.3）需要"设备可持有的长连接身份"。现有 Bearer 太短、refresh 轮换语义不符、service token 是静态共享密钥——都不适合"每设备每连接"。

**数据模型**（追加到 `src\db\schema.ts`）：

```sql
CREATE TABLE IF NOT EXISTS relay_credentials (
  id              TEXT PRIMARY KEY,               -- rc_<uuid>
  account_id      TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  app            TEXT NOT NULL DEFAULT 'crish',
  credential_hash TEXT NOT NULL UNIQUE,           -- HMAC(credential, AUTH_TOKEN_SECRET)，明文不落库
  status          TEXT NOT NULL DEFAULT 'active', -- active | revoked | expired
  expires_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_creds_account ON relay_credentials(account_id, status);
```

**端点**（新模块 `src\modules\relay\relay.routes.ts` + `relay.service.ts`，前缀 `/api/relay`）：

| 方法 | 路径 | 鉴权 | 语义 |
|------|------|------|------|
| POST | /api/relay/credentials | Bearer（或 refresh token 交换） | 签发中继凭据：返回明文凭据一次（随机 32B），服务端只存 HMAC；TTL 建议 30 天可刷新 |
| DELETE | /api/relay/credentials/:id | Bearer | 撤销（设备撤销联动 A3 会调用） |
| GET | /api/relay/verify | AUTH_SERVICE_TOKEN | 中继服务内部调用：`{credential, nonce}` → `{accountId, deviceId, app, status}`；一次校验（HMAC 常量时间比较），供中继连接握手使用 |
| POST | /api/relay/credentials/refresh | Bearer | 凭据轮换（旧凭据立即失效，防重放） |

**中继服务选型：Rust（axum + tokio-tungstenite），独立部署，与账号中心解耦**。理由：

| 维度 | Rust（推荐） | Node/Fastify（zennav-server 扩展） |
|------|---------------|-----------------------------------|
| 与 crish 栈一致性 | ✅ 同一生态（tokio 已在 Tauri 壳使用，D1 §3.1.1 提到 axum/tokio-tungstenite 先例） | ✗ 引入第二语言运行时 |
| 连接数/内存 | ✅ 单进程万级连接轻松 | ⚠️ 可行但 GC 内存开销大 |
| 部署 | ✅ 单二进制 + TLS 静态 | ⚠️ 需 Node 运行时 + 依赖 |
| 与账号中心耦合 | 天然解耦（HTTPS 调 verify） | ✗ 容易长进同一代码库 |
| 复用现有代码 | 需自写（转发逻辑简单，~500 行） | 可复用 auth 中间件，但 zennav-server 无 WS 能力（Fastify ws 需引 @fastify/websocket） |

**中继职责边界（严格）**：只做 ①TLS WS 收发 ②握手时凭据校验（调 /api/relay/verify，可本地缓存失效期 ≤ 5 分钟）③按 (accountId, deviceId) 路由转发 ④在线状态上报（可选）⑤不做任何业务存储、不解密业务载荷（D1 §3.3"中继只转发"）。业务载荷端到端加密由 D3 协议的设备级 AEAD 承担，中继仅见密文。

**连接生命周期**：桌面/手机启动 → 用 relay credential 连 wss://relay → hello（D3 信封，含设备签名）→ 中继 verify 凭据 → 建立会话。凭据过期 → 403 → 端侧调 POST /api/relay/credentials 刷新。

### 6.5 安全强化清单（合并 6.2 的 A5-A8）

按优先级：

1. **登录/注册/验证码限流**（A5）——最低成本、最大收益；
2. **CORS 收敛**（A7）；
3. **refresh 重用检测**（A6）；
4. **scrypt 参数上调**（A8）；
5. **设备信任流程**（A4，一期最小化）；
6. （后续）安全日志检索 API 对 crish 开放（现有 security_logs 表已存在）。

### 6.6 API 面总览（调整后，crish 视角）

**直接复用（已有）**：`POST /api/auth/email/login/password`、`POST /api/auth/email/login/code/request|confirm`、`POST /api/auth/email/register/request|confirm`、`POST /api/auth/refresh`、`POST /api/auth/logout`、`GET /api/auth/me`、`GET /api/auth/sessions`、`DELETE /api/auth/sessions/:id`、`DELETE /api/auth/devices/:deviceId/sessions`、`POST /api/auth/desktop-auth/request|authorize|exchange`、`POST /api/auth/handoff/:app|exchange`、`GET/POST/PATCH/DELETE /api/devices`、`POST /api/devices/:id/seen`。

**新增（本方案）**：`POST/DELETE/GET /api/push/tokens`、`POST/DELETE /api/relay/credentials`、`GET /api/relay/verify`、`POST /api/devices/:id/trust`（A4）。

### 6.7 测试与验收清单（调整项门禁）

账号中心侧沿用现有门禁：`npm run typecheck`（tsc --noEmit）+ `npm test`（tsx --test `src/**/*.spec.ts`）+ `npm run smoke:auth`（`SVR\package.json:10-13`，Python 冒烟脚本覆盖认证全流程）。新增模块按同模式补测试：

| 模块 | 必测用例（新增） | 门禁 |
|------|------------------|------|
| push_tokens | 注册幂等（同 token 二次注册返回同一记录）；跨账号隔离（A 账号 token 不能被 B 查询/删除）；deviceId 校验（未注册设备拒绝）；unregister 后厂商返回不再命中 | tsx --test 单测 + 冒烟扩展 |
| relay_credentials | 签发只返回一次明文（服务端无明文可查）；HMAC 常量时间校验；过期/撤销后 verify 拒绝；轮换后旧凭据立即失效；verify 带 service token 才可调用 | tsx --test 单测 |
| 限流（A5） | 连续失败登录第 N 次后 429；验证码端点同 IP 频率限制；限流状态不泄漏账号存在性（统一 429 文案） | tsx --test |
| 联动撤销（A3） | removeDevice → 该设备全部会话 revoked=1、push token 状态 unregistered、relay credential 撤销；批量撤销计数正确 | 集成测试（同一库） |
| refresh 重用检测（A6） | 旧 refresh 第二次使用 → 该会话全部令牌吊销 + security_logs 落一条 | tsx --test |
| CORS 收敛（A7） | 非白名单 Origin 请求被拒；预检 OPTIONS 通过白名单 | 冒烟 |
| scrypt 升级（A8） | 旧格式 `scrypt:salt:derived` 仍可验证（向后兼容）；新注册用新参数 | tsx --test |

中继服务（Rust）门禁：`cargo test`（握手鉴权/转发/路由/背压单测）+ 与账号中心联调的端到端脚本（起账号中心测试实例 → 签发凭据 → 中继握手 → 双端转发回环）。验收标准：**调整后账号中心原有 22 模块零回归**（现有测试全绿 + 生产冒烟 `smoke:auth` 通过 + chat-website SSO 联调回归通过），新模块按上表全绿。

### 6.8 与 flowbit 生态的关系建议（决策要点）

1. **优先复用生产实例**：crish 一期直接对接 auth.flowbit.me（已有 chat-website 集成先例），省运维、免同步；crish 是 flowbit 生态新 app（app_links 天然支持多 app 隔离，`schema.ts:58-67`）。
2. **保留独立副本选项**：若 crish 需要数据主权/上线节奏自主，在独立服务器部署同一源码副本（§6.10 部署形态），API 契约不变，crish 侧适配层只需换 base URL。
3. **不进 flowbit 商业闭环**：不接入 billing/AI 网关模块（与 crish 自身 provider 体系无关）；账号中心对 crish 只暴露 §6.6 端点集合。
4. **app 命名登记**：crish 的 app 名（`crish_desktop`/`crish_mobile`）需在账号中心 normalizeApp/白名单登记（A1/A2），避免与现有 `nav`/`chat_sync` 冲突。

### 6.9 数据模型新增汇总

| 表 | 用途 | 关联 |
|----|------|------|
| push_tokens | 推送令牌注册表（§6.3） | account_id / device_id → sessions |
| relay_credentials | 中继连接凭据（§6.4） | account_id / device_id |
| （可选）device_trust_events | 设备信任审批留痕（A4） | device_id |

现有表无需改动（sessions/accounts/account_identities/audit_logs 全部复用）；`user_data` 中的设备 CRDT 实体保持兼容。

### 6.10 部署形态

- **账号中心**：维持现有 Docker 单容器部署（flowbit-auth 惯例，`SVR\Dockerfile`）；新增模块照常进同一镜像。若 crish 与 flowbit 生产环境隔离（推荐），在独立 VPS/容器部署同一源码副本，域名 `auth.crish.example` 或子路径——**SQLite 单库即可支撑账号中心规模（个人/小团队）**，无需引入 Postgres；规模再大再迁移（better-sqlite3 数据可导出）。
- **中继服务**：Rust 单二进制容器（scratch/distroless + TLS），`wss://relay.crish.example`；无状态，可多副本（如需粘性不需要，转发无状态）。
- **域名/TLS**：跟随现有 Cloudflare + Let's Encrypt 惯例（`ROOT\ACCOUNT.txt:438` TLS SANs 先例）。
- **备份**：沿用 SQLite 定时备份惯例（`ROOT\ACCOUNT.txt:673` 有备份文件先例）。

---

## 7. 与 crish 的集成面

### 7.1 总体原则

- **本地配对优先，云账号可选**（D1 §4.5）：局域网内设备对设备配对（D3 协议，Ed25519），不经过账号中心；账号中心只服务"跨网中继、推送注册、云登录"三个场景。
- **桌面不存云端明文凭据**：access/refresh 令牌与中继凭据存入 OS 凭据库（Windows Credential Manager / macOS Keychain，Tauri safe storage 或 keyring crate），内存中持有；磁盘不落明文（对比 zennav-web 的 localStorage 实践 `WEB\src\stores\auth-store.ts:26-29`——Web 环境受限，crish 原生端不应照搬）。
- **手机端**：令牌存 Keychain/Keystore（secure-store），推送厂商 token 由移动端注册到账号中心 push_tokens。

### 7.2 桌面端接入（Hub）

| 场景 | 流程 | 复用的账号中心机制 |
|------|------|-------------------|
| 首次云登录 | 设置页"登录 FlowBit 账号" → 打开浏览器（授权码流或 desktop-auth 反向流）→ 桌面收 token → 存凭据库 → 注册设备（POST /api/devices, platform=desktop） | `desktop-auth/request + exchange`（或直接 email/password 在桌面内输入，desktop-auth 更安全） |
| 桌面授权手机（反向） | 桌面生成 desktop-auth request → 手机浏览器/APP 已登录态 authorize → 桌面 exchange 换新会话 | `auth.routes.ts:517-592` |
| 中继注册 | 登录后调 POST /api/relay/credentials 拿连接凭据 → 存凭据库 → 出站连中继 | 新增 |
| 推送发送 | 桌面 push-core（D7）按事件生成 PushMessage → 直连厂商通道 或 经账号中心/中继代理 | push_tokens 查询接口 |
| 设备管理 | 设置页设备列表 = GET /api/devices + GET /api/auth/sessions 合并展示；撤销 = DELETE device/session + 联动（A3） | 现有 + 新增 |
| 登出 | 撤销中继凭据 + 推送解绑 + logout（撤销会话） | 现有 + 新增 |

### 7.3 手机端接入（Companion）

| 场景 | 流程 | 机制 |
|------|------|------|
| 云登录 | 手机 APP 内登录（邮箱+密码 / 验证码）→ token 存 secure-store → 注册设备（platform=mobile）→ 注册推送 token（POST /api/push/tokens） | 现有 + 新增 |
| 扫码登录（可选） | 桌面二维码 → 手机确认 → 桌面完成 | bind-ticket 或 desktop-auth 均可复用 |
| 中继连接 | 持 relay credential 连中继（凭据与桌面同账号不同设备） | 新增 |
| 接收推送 | 厂商通道 → APP 处理 → 本地通知（D7） | push_tokens |

### 7.4 与 D 系列方案的衔接点

| 母方案条款 | 本方案落地 |
|-----------|-----------|
| D1 §3.3 云中继 | 中继服务（§6.4）为 RelayLink 的服务端；账号中心提供连接凭据 |
| D1 §4.5 云账号=中继可选增强 | 账号中心角色定位即此；不进入业务会话命名空间 |
| D1 §4.4 设备撤销 | 账号中心设备/会话撤销与本地配对撤销**并行存在**：本地配对撤销管"局域网直连"，账号中心撤销管"中继/推送"；UI 合并 |
| D3 协议认证 | 端间消息鉴权仍走 D3 设备级 HMAC；账号中心凭据只负责"连中继"，两层不混 |
| D7 路线 C 自建推送 | 账号中心 push_tokens = 路线 C 的设备注册表；发送器留在桌面 push-core |
| D5 安全基线 | §6.5 强化项与 D5 的威胁模型对齐（限流/重放/凭据轮换） |

### 7.5 凭据存储决策表

| 凭据 | 桌面端 | 手机端 | 中继服务 |
|------|--------|--------|----------|
| 账号 access token | 内存 + OS 凭据库 | Keychain/Keystore | 无 |
| 账号 refresh token | OS 凭据库（不落盘明文） | Keychain/Keystore | 无 |
| 中继凭据 | OS 凭据库 | Keychain/Keystore | 只存 HMAC 校验态（调账号中心） |
| 设备 Ed25519 私钥（D3 本地配对） | app_dir()/identity | 安全存储 | 无 |
| 厂商推送凭据 | 桌面侧发送器持厂商 AppId/密钥（OS 凭据库） | 不持（token 由系统 SDK 管理） | 可选代理时持有 |

---

## 8. 里程碑与工作量

> 【裁决修正 9】阶段映射（统一 R0-R5）：M0 白名单 env 化 → R0 并行（P-0.3）；
> M1 限流/安全 → R0/R1；M2 push_tokens → **R3 推送**（前置）；M3
> relay_credentials → **R4 中继+P2P**（前置）；M4 中继服务 → R4；
> M5 联动 → R3/R4；M6 集成 → R3/R4 收尾。任务书引用一律使用 R 阶段号
> （AU3 阶段命名裁决）。

| 阶段 | 内容 | 工作量（人日，估算） | 依赖 |
|------|------|----------------------|------|
| M0（1-2 天） | 应用白名单 env 化（A1/A2/A10）、CORS 收敛（A7） | 1 | 无 |
| M1（3-5 天） | 限流 + refresh 重用检测 + scrypt 参数（A5/A6/A8） | 3 | M0 |
| M2（4-6 天） | push_tokens 模块（表 + 3 端点 + 测试） | 4 | M1 |
| M3（4-6 天） | relay_credentials 模块 + verify 端点（表 + 4 端点 + 测试） | 4 | M1 |
| M4（5-8 天） | Rust 中继服务（握手校验 + 转发 + TLS + 在线状态） | 6 | M3 |
| M5（3-5 天） | 设备 ↔ 会话 ↔ 推送 ↔ 中继联动（A3/A4） | 4 | M2/M3 |
| M6（集成） | 桌面端登录/凭据存储/中继客户端 + 手机端登录/推送注册 | 10+（涉及 crish 侧） | M2-M5 |

账号中心侧合计约 **15-20 人日**；中继服务约 6 人日；两端集成另计。测试门禁：账号中心 `npm test`（tsx --test）+ 冒烟脚本 `smoke:auth`；中继 Rust `cargo test` + 集成脚本。

---

## 9. 风险与开放问题

| # | 风险/问题 | 等级 | 缓解 |
|---|-----------|------|------|
| 1 | **外部依赖**：账号中心是 flowbit 商业生产系统，crish 依赖其可用性与数据主权 | 高 | 铁律：crish 全功能无账号可用；账号中心可选启用；若需隔离可部署独立副本（§6.10） |
| 2 | 账号中心代码库是 flowbit 商业项目，版本演进不受 crish 控制（git 历史显示活跃开发） | 中 | 以 API 契约为边界（§6.6 端点清单）；crish 侧做 API 适配层 |
| 3 | 推送厂商通道（国内安卓无 GMS）复杂度高（D7 §5 已详评） | 中 | 一期只做注册表 + 发送接口；厂商 SDK 接入按 D7 分期 |
| 4 | 中继服务与账号中心 verify 的可用性耦合（凭据校验依赖账号中心） | 中 | 中继本地缓存校验结果（≤5 分钟）；账号中心短时不可用不影响已建立连接 |
| 5 | desktop-auth 依赖"用户在浏览器已登录"场景；crish 用户若从未登录 Web 端则流程需回退为直接密码登录 | 低 | 提供双路径（§7.2） |
| 6 | 设备体系双轨（本地配对设备 vs 账号中心设备）语义混淆 | 中 | §7.4 明确分工；UI 层合并展示并标注来源 |
| 7 | 凭据轮换/撤销风暴：批量撤销（账号被盗等）需要级联效率 | 低 | 撤销走批量 SQL + 中继凭据 HMAC 检查天然支持单点失效 |
| 8 | 开放问题：推送发送器是否经账号中心代理厂商通道（D7 路线 C 形态）还是桌面直连厂商 | 开放 | 建议一期桌面直连，二期再评估代理（降低账号中心复杂度） |
| 9 | 开放问题：账号中心与 crish 的账号是否共用 flowbit 用户池（同邮箱=同一人）还是独立用户池 | 开放 | 倾向独立用户池（crish 数据主权），desktop-auth/handoff 契约天然支持多 app 隔离（app_links） |

---

## 10. 附录：证据索引

### 10.1 后端（`C:\Software\account-center\navigation-site\zennav-server\`）

| 事实 | 位置 |
|------|------|
| Fastify 5 + better-sqlite3 + nodemailer 技术栈 | `src\..\package.json` |
| 22 个路由模块注册面 | `src\index.ts:120-183` |
| CORS 配置（* + credentials） | `src\index.ts:62-67` |
| 账号域建表（accounts/identities/sessions/各类票据/审计） | `src\db\schema.ts:2-149` |
| 设备记录存 user_data（CRDT 实体） | `src\modules\devices\device.service.ts:61-63,209-241` |
| 设备 platform 枚举含 desktop/mobile | `src\modules\devices\device.service.ts:4-6` |
| trusted 默认 true | `src\modules\devices\device.service.ts:274` |
| 登录（密码/验证码）/注册/改密端点 | `src\modules\auth\auth.routes.ts:119-201` |
| 会话管理端点（列表/撤销/设备撤销） | `src\modules\auth\auth.routes.ts:203-278` |
| desktop-auth 端点（request/inspect/authorize/exchange） | `src\modules\auth\auth.routes.ts:517-592` |
| handoff 端点 | `src\modules\auth\auth.routes.ts:458-475,594-615` |
| access token 构造（zn1 + HMAC-SHA256） | `src\modules\auth\auth.service.ts:2115-2147` |
| refresh 轮换 | `src\modules\auth\auth.service.ts:356-393` |
| 会话创建时同设备旧会话吊销 | `src\modules\auth\auth.service.ts:1601-1624` |
| 密码 scrypt | `src\modules\auth\auth.service.ts:2206-2219` |
| service token 校验（x-auth-service-token） | `src\modules\auth\auth.service.ts:2171-2183,594-615` |
| DESKTOP_AUTH_APPS 白名单（仅 chat_sync_desktop） | `src\modules\auth\auth.service.ts:244` |
| 非生产返回 devCode | `src\modules\auth\auth.service.ts:936-938` |
| sync push/pull（LWW+rev+mutation 幂等） | `src\modules\sync\sync.service.ts:147-403` |
| Docker 部署形态 | `Dockerfile` |
| env 配置项 | `src\config\env.ts:4-63` |

### 10.2 前端（`C:\Software\account-center\navigation-site\zennav-web\`）

| 事实 | 位置 |
|------|------|
| React 18 + Vite + Tailwind + Zustand + Dexie | `package.json`；`src\stores\*` |
| 无路由库，pathname 分发 | `src\App.tsx:42-48,361-363` |
| 桌面授权页完整 UI | `src\App.tsx:51-153` |
| 会话存 localStorage（zennav.auth.session） | `src\stores\auth-store.ts:26-29,131-137` |
| /account 12 个 tab | `src\App.tsx:27-40` |

### 10.3 环境与生产事实（`C:\Software\account-center\`）

| 事实 | 位置 |
|------|------|
| flowbit-auth 容器（8787）+ auth.flowbit.me 公开 API | `ACCOUNT.txt:660-663` |
| chat.flowbit.me 前端接入 auth.flowbit.me 作 SSO/计费 | `chat-website\.env.production:2-3`；`chat-website\vite.config.ts:12` |
| 账号中心 → Sub2API 服务链路与 E2E 计费验证 | `ACCOUNT.txt:664-681` |
| 发布/回滚/备份惯例 | `ACCOUNT.txt:670-708` |
| TLS/域名惯例（Cloudflare + Let's Encrypt SANs） | `ACCOUNT.txt:406-438` |

### 10.4 crish 侧基准（`C:\Software\conex\docs\multi-device\plans\`）

| 事实 | 位置 |
|------|------|
| 中继角色定义（只转发不解密） | `D1-overall-architecture.md` §3.3 |
| 云账号=中继可选增强 | `D1-overall-architecture.md` §4.5 |
| 设备 Ed25519 密钥对体系 | `D1-overall-architecture.md` §4.1-4.3 |
| 中继凭据/连接鉴权协议 | `D3-protocol.md` §5（auth.* 域） |
| 推送路线 C（设备注册表+厂商代理） | `D7-push-notifications.md` §4 |
| 桌面为推送生成源（push-core） | `D7-push-notifications.md` §4.1-4.2 |

---

（完）
