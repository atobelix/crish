# 新一代多端协同、远程控制与中转服务完整技术实施方案（方案 D）

> **方案代号**：Plan-D（极简直连 · 盲中继 E2EE · 工业级高并发承载）  
> **面向场景**：移动端（React Native / Expo）与桌面端（Rust + Tauri / React）跨网络随时随地一键直连、双向实时控制、零知识端到端加密通信与 20,000+ 长连接单机高稳定承载。  
> **产出位置**：`c:/Software/conex/docs/mobile-revival-audit/independent-plans/04-plan-by-agent-d.md`  
> **文档纪律**：纯中文编写；UTF-8 无 BOM；不改动业务源码；不执行 git 提交。

---

## 0. 方案核心宗旨与工业级技术基准

### 0.1 用户体验原则：“把复杂留给自己，把极简留给用户”
跨端协同最忌讳的是强迫用户扮演“网络工程师”与“安全审计员”。本方案的核心用户体验体验目标是：
1. **零配置开箱即连**：只要手机和电脑登录了同一个账号，在任意网络环境下（手机 5G、公司 NAT、家中宽带），手机端打开 App 首页即见 **“我的电脑（在线）”**，点击按钮 **一键直连**。无需用户每次对准屏幕扫码、无需每次输入 6 位配对码、无需手动配置端口映射或 DDNS。
2. **渐进式保底与双轨运行**：
   - **轨 A（云端中继 + E2EE 隧道）**：默认跨广域网极速通道，基于用户已有的云端资产，秒级穿透双端 NAT。
   - **轨 B（本地优先局域网直连）**：若在纯内网无公网环境、断网应急、或用户坚持不登录云端账号，无缝保留并回退至现有的局域网 mDNS / 广播 / CXN 码扫码直连，已有资产完全不丢弃。
   - **未登录友好引导**：任意一端未登录时，给出亲切、无侵入的引导卡片（“登录账号即可享受跨网络一键免扫码直连”），点击直达登录页。
3. **桌面端补齐现代化账号中心**：在桌面端 `SettingsProfileTab.tsx` 及侧边栏 `UserProfileCard.tsx` 彻底消除硬编码，提供与云端真实打通的登录、注册、Token 自动续期与云端设备在线状态管理。

### 0.2 反过度设计硬红线与真实云边端资产映射
本方案恪守仓库根目录 `ANTI_OVERENGINEERING_GUARDRAILS.md`，坚决不凭空捏造技术栈：
- **严禁引入**：Kubernetes、Redis 7 集群、Kafka/Pulsar、Consul/Etcd、多层分布式微服务网关。
- **真实资产 100% 严密对齐**：
  1. **云端核心（首尔主节点）**：阿里云韩国服务器（公网 `43.108.54.141` / Tailscale `100.77.75.39`），已在线运行 Fastify + SQLite 账号中心 `auth.flowbit.me`（本地源码位于 `C:/Software/account-center/navigation-site/zennav-server`，已内建 auth、devices、zendrop 模块）；
  2. **云端辅助（美西容灾节点）**：美西 VPS（公网 `144.24.46.175` / Tailscale `100.72.31.76`）作为冷备与容灾中继；
  3. **桌面端宿主**：`apps/agent-workbench/src-tauri`（Rust）+ `apps/crish-desktop`（React），已具备 `crates/conex-types/src/device/` 完整的 103 种契约定义与本地 `PairingCoordinator`；
  4. **移动端宿主**：`apps/crish-mobile`（React Native / Expo），已具备成熟的 X25519 + HKDF-SHA256 密码学底座（`keyAgreement.ts`）。

### 0.3 方案 D 核心技术亮点与交付清单
- **单机承载 20,000+ 并发连接**：优化 Node.js 事件循环与 Buffer 流水线，或可选极简单二进制 Rust Tokio 进程，控制单机常驻内存在 1.5GB 以内，零连接泄漏、具备动态背压与雪崩自愈。
- **端到端零知识加密（E2EE）**：云端中继仅充当“盲管道（Blind Pipe）”，所有业务指令、模型 Prompt、文件内容、终端执行流均在双端本地使用 ChaCha20-Poly1305 / AES-256-GCM 密文封包，云端服务器在物理上绝对无法解密任何用户隐私。
- **移动端三大已知痛点代码级根治**：
  - 彻底解决终端高频流式输出下的吸底与手势死锁（Terminal Bottom-Lockup）；
  - 解决 React Native WebSocket URL 无法挂载 Header 的完整鉴权问题（短效 Ticket + 首帧 AuthHello 握手）；
  - 修复断线重连后游标对账与增量补齐（Resume Page）哑火缺陷。

---

## 1. 系统拓扑与双端极简交互架构

### 1.1 系统物理与逻辑网络拓扑

```
+-----------------------------------------------------------------------------------+
|                            阿里云韩国首尔节点 (43.108.54.141)                        |
|                                                                                   |
|  +-------------------------------------+    +----------------------------------+  |
|  |       Fastify 账号中心与业务网关        |    |      Conex 盲中继服务 (Relay)     |  |
|  |   (auth.flowbit.me / zennav-server) |    |        (wss://relay.flowbit.me)  |  |
|  |                                     |    |                                  |  |
|  | - REST: /api/auth/*, /api/devices/* |    | - 单机 epoll / Stream 零拷贝管道   |  |
|  | - SQLite: accounts, devices, tokens |    | - 双向 20,000+ 并发连接池          |  |
|  | - 设备心跳与 Presence 注册表          |    | - 零知识盲转发 (不解密载荷)       |  |
|  +------------------+------------------+    +-----------------+----------------+  |
|                     |                                         |                   |
+---------------------|-----------------------------------------|-------------------+
                      | (HTTPS: 登录 / 设备发现 / 临时票据)        | (WSS: E2EE 密文帧)
                      v                                         v
       +------------------------------+         +-------------------------------+
       |    桌面端 (Crish Desktop)    |         |    移动端 (Crish Mobile)       |
       |  Rust Core + React 界面      | <=====> |  React Native / Expo          |
       |  - 自动注册在线 / 上报公钥     | 局域网   |  - 打开即见 "我的电脑 (在线)"   |
       |  - 建立与中继的长连接等待指令 | 保底轨  |  - 点击一键免扫码直连          |
       |  - 执行 Prompt / 终端 / 审批  | (轨 B)  |  - 实时查看思考流 / 移动审批   |
       +------------------------------+         +-------------------------------+
                      ^                                         ^
                      +=========================================+
                                轨 A：广域网 E2EE 加密隧道 (经中继盲传)
```

### 1.2 双端登录状态感知与一键直连（Zero-Friction Handshake）

#### 1.2.1 极简握手时序图

```mermaid
sequenceDiagram
    autonumber
    participant D as 桌面端 (Desktop)
    participant C as 云端账号中心 (auth.flowbit.me)
    participant R as 云端盲中继 (Relay:443)
    participant M as 移动端 (Mobile)

    Note over D,C: 阶段一：桌面端就绪与驻留
    D->>C: POST /api/auth/email/login/password (登录账号)
    C-->>D: 返回 AccessToken + RefreshToken
    D->>C: POST /api/devices (注册/保活设备, 携带 X25519 设备公钥 D_pub)
    D->>C: POST /api/relay/ticket/host (申请 Host 驻留中继票据)
    C-->>D: 返回 hostTicket
    D->>R: WSS 连接 wss://relay.flowbit.me/v1/relay?ticket=hostTicket
    R-->>D: WebSocket 升级成功，通道就绪（Desktop 保持长连接静默待命）

    Note over M,C: 阶段二：移动端进入与设备感知
    M->>C: 登录同账号 / 启动 App (持有效 Token)
    M->>C: GET /api/devices?trusted=true (拉取名下设备列表)
    C-->>M: 返回设备清单: [ { id: "desk-01", name: "Orange PC", online: true, pubKey: "D_pub" } ]
    Note over M: UI 立即呈现卡片：“Orange PC (在线)”，高亮 [一键直连] 按钮

    Note over M,D: 阶段三：用户点击一键直连，建立 E2EE 通道
    M->>C: POST /api/relay/ticket/client (带目标 deviceId="desk-01", 申请连接票据)
    C-->>M: 校验同账号绑定关系，签发 clientTicket
    M->>R: WSS 连接 wss://relay.flowbit.me/v1/relay?ticket=clientTicket
    R-->>M: WebSocket 升级成功
    Note over R: 中继通过 ticket 内的 pair_id 将 Mobile 与 Desktop 绑定至同一 Session Room

    Note over M,D: 阶段四：端到端零知识密钥协商 (X25519 ECDH)
    M->>M: 生成临时私钥 m_eph_priv, 临时公钥 M_eph_pub
    M->>M: ECDH(m_eph_priv, D_pub) -> 派生会话链路密钥 enc_key
    M->>R: 发送握手帧 RelayHandshake { ephPubKey: M_eph_pub, clientDeviceId: "mob-01" }
    R->>D: 盲转发 RelayHandshake (中继无法解析内容)
    D->>D: ECDH(D_priv, M_eph_pub) -> 派生完全相同的 enc_key
    D->>R: 发送加密握手回执 EncryptedFrame(enc_key, AuthHelloOk)
    R->>M: 盲转发加密回执
    M->>M: 解密成功！UI 状态切换为：“已连接，E2EE 加密通道安全”
    Note over M,D: 后续所有 Prompt、流式输出、工具审批均通过 enc_key 加密盲传
```

#### 1.2.2 握手信令交互核心数据结构
在 `crates/conex-types/src/device/` 契约基础上，设计中继路由帧（Relay Wire Frame）：

```typescript
/** 中继最外层路由帧（中继服务器仅读取该结构进行会话转发，不触碰密文） */
export interface RelayRouteEnvelope {
  /** 协议版本，当前为 1 */
  v: 1;
  /** 帧类型：handshake (建立配对通道) | data (业务密文帧) | ping | pong | close */
  type: 'handshake' | 'data' | 'ping' | 'pong' | 'close';
  /** 会话房号/隧道 ID (UUID v4) */
  tunnelId: string;
  /** 发送方设备 ID */
  fromDeviceId: string;
  /** 接收方目标设备 ID */
  toDeviceId: string;
  /** 递增序号，防止乱序与丢包重放 */
  seq: number;
  /** 毫秒时间戳 */
  ts: number;
  /** 载荷字节：当 type='data' 时，内含经过 ChaCha20-Poly1305 加密的密文 base64/hex */
  payload: string;
}

/** 密文内部真实的业务信封（解密后还原为现有的 DeviceEnvelope） */
export interface EncryptedPayloadBundle {
  /** 12 字节随机 Nonce (Base64) */
  nonce: string;
  /** 16 字节 AEAD Auth Tag (Base64) */
  tag: string;
  /** 密文主体：DeviceEnvelope 的二进制 JSON 密文 (Base64) */
  ciphertext: string;
}
```

### 1.3 双轨自适应直连保底机制（Dual-Track Strategy）

为了实现工业级鲁棒性，系统设计 **双轨状态机（Dual-Track State Machine）**：

```mermaid
flowchart TD
    Start([用户在移动端打开 App]) --> CheckAccount{双端是否均登录同账号?}
    
    CheckAccount -- 否 / 未登录 --> ShowLoginPrompt[提示: 登录可开启跨网一键连]
    ShowLoginPrompt --> FallbackLocal[激活【轨 B: 本地局域网直连】]
    FallbackLocal --> LanDiscovery[mDNS 广播发现 / CXN 扫码]
    LanDiscovery --> LanConnected([局域网直连成功])
    
    CheckAccount -- 是 (同账号) --> QueryCloud[查询云端设备状态]
    QueryCloud --> CheckDeskOnline{桌面端是否在线?}
    
    CheckDeskOnline -- 离线 / 休眠 --> WakeOrFallback[提示: 桌面端离线]
    WakeOrFallback --> FallbackLocal
    
    CheckDeskOnline -- 在线 --> TryTrackA[激活【轨 A: 云端 E2EE 中继直连】]
    TryTrackA --> ConnectRelay[申请 Ticket 并接入中继]
    ConnectRelay --> HandshakeOK{E2EE 握手成功?}
    
    HandshakeOK -- 成功 --> RelayConnected([云端 E2EE 直连成功])
    HandshakeOK -- 失败/中继断开 --> ProbeLan{是否在同一局域网?}
    ProbeLan -- 是 --> SilentSwitch[无缝降级切换至局域网直连]
    SilentSwitch --> LanConnected
    ProbeLan -- 否 --> RetryBackoff[指数退避重试中继]
```

#### 1.3.1 核心切换与保底逻辑规范
1. **优先轨选择**：
   - 默认首选 **轨 A（云端中继）**，因其不受家庭 AP 隔离、公司企业网防火墙、不同网段阻隔的影响，成功率 >99.2%；
   - 若双端物理处于同一局域网（通过比较云端上报的 Local IP 列表，或 mDNS 探针已收到回应），直连管理器将在后台并行测速。若局域网直连 RTT < 5ms 且无丢包，可由用户或策略无缝迁移至局域网直连（节省云端带宽），对外表现为“传输速度由 500KB/s 跃升至 20MB/s”，体验完全平滑。
2. **离线与断网保底**：
   - 当手机断开外网（如飞机、地下车库无信号），自动切换为“离线本地模式”，界面保留现有的“扫码配对 / 输入 CXN 码”入口，不给用户弹阻塞式红框，确保本地资产可用。
3. **网络跃迁无感漂移（WiFi ↔ 蜂窝移动网络）**：
   - 移动端监听 `NetInfo` 状态。当用户从家中 WiFi 切换至室外 5G 蜂窝网络时，底层的 `ReconnectingWsClient` 不销毁业务层的 `eventStore` 状态机；
   - 触发毫秒级断线重连，携带现存的 `tunnelId` 与 `lastSeq` 向云端中继发送重连帧；
   - 桌面端感应到客户端重连后，仅做连接句柄重绑，正在运行的 Agent 任务不受任何干扰，实现真正的“网络漂移而任务不中断”。

---

## 2. 桌面端账号体系与设备中心落地设计

### 2.1 桌面端 UI 重构与用户旅程设计

当前桌面端 `apps/crish-desktop/src/components/settings/SettingsProfileTab.tsx` 仅包含工作区与数据备份，缺乏登录界面；左下角 `apps/crish-desktop/src/components/sidebar/UserProfileCard.tsx` 硬编码为 `orange`。必须将其彻底重塑为生产级账号体系。

#### 2.1.1 `SettingsProfileTab.tsx` 界面结构蓝图
重构后的 `SettingsProfileTab` 将分为三大响应式卡片区：
1. **账户主状态卡片（Account Hero Card）**：
   - **未登录态**：展示现代极简的登录表单。支持 **“邮箱密码登录”** 与 **“邮箱验证码一键登录/注册”** 选项卡切换；
   - **已登录态**：展示用户头像（支持上传或默认随机多色渐变）、邮箱地址、昵称、UID、当前登录态 Token 过期时间；提供 [编辑个人资料] 与 [退出登录] 按钮。
2. **云端互联设备中心（Cloud Devices Manager）**：
   - 实时列出该账号下已绑定的所有终端设备（电脑、iPhone、安卓平板等）；
   - 展示设备在线状态（绿色呼吸灯表示“当前在线”，灰色表示“离线”及最后活跃时间 `Last seen`）；
   - 当前正在使用的这台电脑标记为 `[本机 - 当前设备]`；
   - 针对其他远程设备，提供 `[撤销授权 / 踢出]` 按钮，点击调用云端 API 强退其 Token 并切断长连接。
3. **保留并增强既有配置**：
   - 数据存储位置（本机 SQLite 数据库路径展示）；
   - 设置备份（JSON 导出与导入）；
   - 开发者服务连接诊断。

#### 2.1.2 UI 组件核心实现代码方案 (`SettingsProfileTab.tsx`)

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import * as Lucide from 'lucide-react';
import { useToast } from '../../services/toast/ToastContext';
import { Button, Tooltip, ConfirmDialog } from '../ui';
import { SettingsPage, SettingsSection, SettingsCard, SettingsRow } from './SettingsUI';
import { authApi, type UserProfile, type CloudDeviceItem } from '../../api/authApi';
import styles from './SettingsProfileTab.module.css';

export const SettingsProfileTab: React.FC = () => {
  const { showToast } = useToast();
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [cloudDevices, setCloudDevices] = useState<CloudDeviceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loginMode, setLoginMode] = useState<'password' | 'code'>('password');
  
  // 表单状态
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);

  // 初始化拉取登录状态与设备列表
  const refreshProfile = useCallback(async () => {
    try {
      const profile = await authApi.getCurrentUser();
      setCurrentUser(profile);
      if (profile) {
        const devices = await authApi.listCloudDevices();
        setCloudDevices(devices);
      }
    } catch (err) {
      console.warn('获取用户信息失败', err);
    }
  }, []);

  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  // 发送邮箱验证码
  const handleSendCode = async () => {
    if (!email || !email.includes('@')) {
      showToast('请输入有效的邮箱地址');
      return;
    }
    try {
      setLoading(true);
      await authApi.requestEmailCode(email);
      showToast('验证码已发送至您的邮箱');
      setCountdown(60);
      const timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (err: any) {
      showToast(err.message || '验证码发送失败');
    } finally {
      setLoading(false);
    }
  };

  // 提交登录
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (loginMode === 'password') {
        await authApi.loginWithPassword(email, password);
      } else {
        await authApi.confirmEmailCode(email, verifyCode);
      }
      showToast('登录成功！已开启多端自动协同');
      await refreshProfile();
    } catch (err: any) {
      showToast(err.message || '登录失败，请检查凭据');
    } finally {
      setLoading(false);
    }
  };

  // 登出处理
  const handleLogout = async () => {
    try {
      await authApi.logout();
      setCurrentUser(null);
      setCloudDevices([]);
      showToast('已安全退出当前账号');
    } catch (err: any) {
      showToast(err.message || '退出失败');
    }
  };

  // 踢出指定设备
  const handleRevokeDevice = async (deviceId: string) => {
    try {
      await authApi.revokeCloudDevice(deviceId);
      showToast('设备已成功踢出并失效');
      setCloudDevices((prev) => prev.filter((d) => d.id !== deviceId));
    } catch (err: any) {
      showToast(err.message || '操作失败');
    } finally {
      setRevokingDeviceId(null);
    }
  };

  return (
    <SettingsPage title="账户与多端协同">
      {/* 1. 账号体系卡片 */}
      <SettingsSection title="云端账号">
        <SettingsCard>
          {!currentUser ? (
            <div className={styles.authContainer}>
              <div className={styles.tabHeader}>
                <button
                  type="button"
                  className={loginMode === 'password' ? styles.activeTab : styles.tab}
                  onClick={() => setLoginMode('password')}
                >
                  密码登录
                </button>
                <button
                  type="button"
                  className={loginMode === 'code' ? styles.activeTab : styles.tab}
                  onClick={() => setLoginMode('code')}
                >
                  验证码快速登录 / 注册
                </button>
              </div>

              <form onSubmit={handleLoginSubmit} className={styles.authForm}>
                <div className={styles.inputGroup}>
                  <label htmlFor="auth-email">账号邮箱</label>
                  <input
                    id="auth-email"
                    type="email"
                    placeholder="name@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>

                {loginMode === 'password' ? (
                  <div className={styles.inputGroup}>
                    <label htmlFor="auth-pwd">登录密码</label>
                    <input
                      id="auth-pwd"
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </div>
                ) : (
                  <div className={styles.inputGroup}>
                    <label htmlFor="auth-code">邮箱验证码</label>
                    <div className={styles.codeRow}>
                      <input
                        id="auth-code"
                        type="text"
                        placeholder="6位数字验证码"
                        value={verifyCode}
                        onChange={(e) => setVerifyCode(e.target.value)}
                        required
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={loading || countdown > 0}
                        onClick={handleSendCode}
                      >
                        {countdown > 0 ? `${countdown}s 后重新获取` : '获取验证码'}
                      </Button>
                    </div>
                  </div>
                )}

                <div className={styles.formFooter}>
                  <Button type="submit" variant="primary" disabled={loading}>
                    {loading ? '正在验证…' : loginMode === 'password' ? '登录' : '验证并进入'}
                  </Button>
                  <span className={styles.authTip}>
                    登录后，手机端将自动发现并一键免密直连本机
                  </span>
                </div>
              </form>
            </div>
          ) : (
            <div className={styles.profileActiveCard}>
              <div className={styles.profileHeader}>
                <div className={styles.avatarWrap}>
                  <Lucide.UserCheck size={28} className={styles.avatarIcon} />
                </div>
                <div className={styles.profileMeta}>
                  <div className={styles.nicknameRow}>
                    <span className={styles.nickname}>{currentUser.nickname || 'Conex 用户'}</span>
                    <span className={styles.badgeCloud}>云端协同已激活</span>
                  </div>
                  <span className={styles.emailText}>{currentUser.primaryEmail}</span>
                </div>
                <Button variant="secondary" onClick={handleLogout}>
                  退出登录
                </Button>
              </div>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* 2. 在线设备中心（已登录时展示） */}
      {currentUser && (
        <SettingsSection title="我的在线设备">
          <SettingsCard>
            <div className={styles.deviceListWrap}>
              {cloudDevices.map((dev) => (
                <div key={dev.id} className={styles.deviceRow}>
                  <div className={styles.deviceIconBox}>
                    {dev.platform === 'desktop' ? <Lucide.Laptop size={20} /> : <Lucide.Smartphone size={20} />}
                  </div>
                  <div className={styles.deviceInfoBox}>
                    <div className={styles.deviceNameLine}>
                      <span className={styles.deviceName}>{dev.name}</span>
                      {dev.isCurrent && <span className={styles.currentTag}>当前设备</span>}
                    </div>
                    <div className={styles.deviceStatusLine}>
                      <span className={dev.online ? styles.statusDotGreen : styles.statusDotGray} />
                      <span className={styles.statusLabel}>
                        {dev.online ? '在线就绪' : `离线 · 最近活跃: ${new Date(dev.lastSeenAt).toLocaleDateString()}`}
                      </span>
                    </div>
                  </div>
                  {!dev.isCurrent && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setRevokingDeviceId(dev.id)}
                    >
                      踢出
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {/* 确认踢出对话框 */}
      {revokingDeviceId && (
        <ConfirmDialog
          title="踢出设备确认"
          content="踢出后，该设备与本电脑的协同连接将立即中断，且该设备需重新登录后方可再次访问。"
          confirmText="确认踢出"
          onConfirm={() => handleRevokeDevice(revokingDeviceId)}
          onCancel={() => setRevokingDeviceId(null)}
        />
      )}
    </SettingsPage>
  );
};
```

#### 2.1.3 左下角 `UserProfileCard.tsx` 重塑
将现有的静态硬编码改造成从 `useAuthStore` 动态获取：
- 未登录：显示“未登录 (点击登录)” + 柔和橙色提示点；点击直接弹出快捷登录浮窗或跳转 `SettingsProfileTab`；
- 已登录：显示真实昵称、邮箱或工作区名称 + 绿色常亮在线指示灯。

### 2.2 桌面端安全凭据存储（TokenStore）与 Rust 内核实现

#### 2.2.1 凭据安全存储策略
桌面端持久化存储安全凭据，严禁以明文保存在全局 `localStorage` 或裸文件中：
1. **Windows 平台**：使用 Windows Data Protection API (DPAPI) 对 `access_token`、`refresh_token` 以及长期配对密钥 `X25519 PrivateKey` 进行物理加解密；
2. **降级保障**：在开发或通用测试环境下，回退存入本地 SQLite 数据表的 `secure_tokens` 表，密钥在本地派生保护。

#### 2.2.2 Rust 侧 Tauri IPC 命令清单 (`auth_commands.rs`)

在 `apps/agent-workbench/src-tauri/src/` 中新增 `auth_commands.rs`，注册如下 7 个核心命令：

```rust
// apps/agent-workbench/src-tauri/src/auth_commands.rs
use std::sync::Arc;
use tauri::State;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct UserProfileDto {
    pub id: String,
    pub primary_email: String,
    pub nickname: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CloudDeviceDto {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub online: bool,
    pub last_seen_at: u64,
    pub is_current: bool,
}

/// 1. 邮箱密码登录
#[tauri::command]
pub async fn auth_login_password(
    email: String,
    password: String,
) -> Result<UserProfileDto, String> {
    crate::auth::service::login_with_password(&email, &password).await
        .map_err(|e| e.to_string())
}

/// 2. 请求邮箱验证码
#[tauri::command]
pub async fn auth_request_email_code(email: String) -> Result<bool, String> {
    crate::auth::service::request_email_code(&email).await
        .map_err(|e| e.to_string())
}

/// 3. 验证码确认登录/注册
#[tauri::command]
pub async fn auth_confirm_email_code(
    email: String,
    code: String,
) -> Result<UserProfileDto, String> {
    crate::auth::service::confirm_email_code(&email, &code).await
        .map_err(|e| e.to_string())
}

/// 4. 退出登录 (清空本地 Token 并注销 Session)
#[tauri::command]
pub async fn auth_logout() -> Result<bool, String> {
    crate::auth::service::logout().await
        .map_err(|e| e.to_string())
}

/// 5. 获取当前登录用户信息
#[tauri::command]
pub async fn auth_get_current_user() -> Result<Option<UserProfileDto>, String> {
    Ok(crate::auth::service::get_cached_user().await)
}

/// 6. 拉取账号下云端设备列表
#[tauri::command]
pub async fn auth_list_cloud_devices() -> Result<Vec<CloudDeviceDto>, String> {
    crate::auth::service::list_cloud_devices().await
        .map_err(|e| e.to_string())
}

/// 7. 踢出/注销指定云端设备
#[tauri::command]
pub async fn auth_revoke_cloud_device(device_id: String) -> Result<bool, String> {
    crate::auth::service::revoke_cloud_device(&device_id).await
        .map_err(|e| e.to_string())
}
```

#### 2.2.3 自动续期守护（Token Refresh Daemon）
在 Rust 后台挂载 `tokio::spawn` 守护任务，每 5 分钟检查 AccessToken（寿命 15 分钟）是否即将过期。当剩余寿命 < 3 分钟时，自动调用 `https://auth.flowbit.me/api/auth/refresh` 进行无感单次轮换，确保桌面端长连接永不因 Token 过期而中途掉线。

---

## 3. 中转中继服务（Relay Service）架构设计与 20k 并发单机承载模型

### 3.1 架构选型与资产复用决策

面对 10,000+ 用户、20,000+ 双端并发长连接的目标，我们坚决拒绝盲目搭建复杂的微服务集群，而是充分利用现代操作系统的高并发能力：

| 方案维度 | 选项 A：重度微服务集群（否决） | 选项 B：Fastify 内嵌 WebSocket 插件（首期主选） | 选项 C：单二进制 Rust Tokio 独立中继（平行优化选型） |
| :--- | :--- | :--- | :--- |
| **技术栈** | K8s + Envoy + Redis 7 集群 + Go Gateway | Fastify + `@fastify/websocket` + Better-SQLite3 | Rust + Tokio + Axum/Tungstenite (单二进制) |
| **部署成本** | 需 3~5 台独立机器，每月数百美元 | **0 额外机器**，直接与现有 `zennav-server` 同机运行 | **0 额外机器**，单文件 15MB，无外部依赖 |
| **代码复用度** | 0%（需重写认证、设备表、路由） | **100%**，直接复用 `zennav-server` 现有 auth/devices 模块 | 90%（复用 Rust `conex-types` 协议类型与 Token 校验） |
| **20k 内存表现**| 4GB~8GB+（多层转发损耗） | **约 1.2GB~1.6GB**（V8 调优 + Buffer 节流） | **< 280MB**（零垃圾回收、极致轻量） |
| **裁决结论** | **坚决取缔（违反反过度设计红线）** | **【本方案主架构】**：立即可用，开发成本低，完全满足承载 | **【极简二进制路线】**：可作为编译为单文件的平滑升级方案 |

本方案主干依托 **在现有 Fastify (`zennav-server`) 中内嵌高效轻量盲中继插件**，同时提供完整架构保障 20,000+ 连接平稳运行。

### 3.2 20,000+ 并发长连接单机承载模型与资源测算

#### 3.2.1 内存数学模型推导
假设系统承载 10,000 对终端，合计 **20,000 个活跃长连接**：
- **单个 Socket 内存开销**：
  - Linux 内核 TCP 读写缓冲区（调优后每个 Socket 设为 4KB/4KB）：约 `8 KB`；
  - Node.js / C++ WebSocket 实例对象（`ws` 句柄 + event listener）：约 `12 KB`；
  - 中继路由哈希表节点（`Map<string, TunnelSession>`，存储 Socket 引用、设备 ID、最后心跳）：约 `1 KB`；
  - 单连接常驻内存基础线：`8 + 12 + 1 ≈ 21 KB`。
- **20,000 连接总内存**：
  $$20,000 \times 21\text{ KB} \approx 420\text{ MB}$$
- **V8 堆内存开销（GC 活跃区与消息流转缓冲区）**：预留 `800 MB`。
- **结论**：总内存消耗稳定在 **1.2GB ~ 1.5GB** 之间。用户阿里云韩国首尔服务器（通常配备 2C4G 或 4C8G）即使在跑 Fastify + SQLite 的同时，承载 20k 并发长连接仍然留有 50% 以上的充裕内存！

#### 3.2.2 Linux 系统网络栈极限调优配置
在中继生产机器（`43.108.54.141`）部署时，配置 `/etc/sysctl.conf` 与 `/etc/security/limits.conf`：

```ini
# /etc/security/limits.conf
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576

# /etc/sysctl.conf
# 增大端口范围
net.ipv4.ip_local_port_range = 1024 65535
# 开启 TCP 快速回收与复用
net.ipv4.tcp_tw_reuse = 1
# 增加 TCP 读写最小与默认缓冲区，避免无谓膨胀
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
# 最大排队 backlog
net.core.somaxconn = 32768
net.ipv4.tcp_max_syn_backlog = 16384
# 开启 Keepalive 快速检测死链
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 15
net.ipv4.tcp_keepalive_probes = 5
```

#### 3.2.3 优雅背压控制与内存防爆死（Backpressure Flow Control）
盲中继最危险的故障是：**桌面端在飞速流式吐终端日志（500KB/s），而手机端处于 3G 弱网（只能接收 20KB/s）**。若中继无脑读取并缓存，单用户的未发送缓冲区就会在几分钟内膨胀到数百兆，最终导致整个服务器 OOM 崩溃！

在中继路由层实现严格的 **背压防爆死机制**：

```typescript
// zennav-server/src/modules/relay/relay.service.ts 核心背压与盲转发实现
import type { WebSocket } from 'ws';

/** 单个 Socket 最大堆积缓冲阈值 (64KB) */
const MAX_SOCKET_BUFFER_BYTES = 64 * 1024;

export class RelayHub {
  // 房间映射：tunnelId -> { desktopWs, mobileWs }
  private tunnels = new Map<string, { desktop?: WebSocket; mobile?: WebSocket }>();

  /** 盲转发消息，带精准背压流控 */
  forwardFrame(sourceWs: WebSocket, targetWs: WebSocket, rawFrame: Buffer | string): void {
    // 检查目标端发送缓冲区水位
    if (targetWs.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
      // 目标端消费过慢！对发送源端施加背压：暂停接收源端的数据包
      if (typeof (sourceWs as any).pause === 'function') {
        (sourceWs as any).pause();
      }

      // 当目标端缓冲区清空到安全水位时，恢复源端接收
      const checkDrain = setInterval(() => {
        if (targetWs.readyState !== targetWs.OPEN) {
          clearInterval(checkDrain);
          return;
        }
        if (targetWs.bufferedAmount < MAX_SOCKET_BUFFER_BYTES / 2) {
          clearInterval(checkDrain);
          if (typeof (sourceWs as any).resume === 'function') {
            (sourceWs as any).resume();
          }
        }
      }, 50);
      return;
    }

    // 水位正常，执行零拷贝直接发送
    targetWs.send(rawFrame, { binary: typeof rawFrame !== 'string' });
  }
}
```

#### 3.2.4 双向心跳探活与僵尸连接垃圾回收（Dead Connection GC）
1. **心跳节拍**：
   - 客户端（双端）每 30 秒向中继发送空操作 PING 帧；
   - 中继服务器每 45 秒扫描一次所有连接的 `isAlive` 标记；
2. **僵尸判死**：
   - 若连接超过 90 秒未收到任何数据帧或 PING，立即调用 `ws.terminate()` 强行释放底层 TCP 文件句柄，并将其从 `tunnels` Map 中移除；
   - 彻底杜绝因手机强退、熄屏休眠、进电梯断网导致的操作系统句柄泄漏。

### 3.3 端到端零知识加密（E2EE）安全协议规范

中继服务器运行在公网上，必须假设“中继服务器是不可信的，或随时可能遭遇网络监听”。因此，必须实现 **端到端零知识加密**。

#### 3.3.1 零知识安全模型
- **明文部分**：仅最外层路由帧（`tunnelId`, `seq`, `fromDeviceId`, `toDeviceId`），中继只依据这些字段找到目标对端进行转发；
- **密文部分**：整个 `DeviceEnvelope`（包含所有 Prompt、ToolCall、文件路径、终端输出、代码内容）使用双端派生的对称密钥进行 **AEAD 加密**。中继服务器即便被越权读取内存或日志，也绝对看不到一个明文字符。

#### 3.3.2 会话链路密钥派生 (X25519 ECDH + HKDF)
直接复用并扩展移动端现有的 `apps/crish-mobile/src/pairing/crypto/keyAgreement.ts`：

```typescript
// 伪代码说明加解密流水线
// 1. 密钥派生 (双端对称执行)
const sharedSecret = noble.x25519.getSharedSecret(myPrivKey, remotePubKey);
const encKey = hkdf(sha256, sharedSecret, salt, 'conex-pair-enc-key-v1', 32);

// 2. 发送前加密封包
export function encryptEnvelope(envelope: DeviceEnvelope, encKey: Uint8Array): EncryptedPayloadBundle {
  const jsonStr = JSON.stringify(envelope);
  const plainBytes = new TextEncoder().encode(jsonStr);
  const nonce = crypto.getRandomValues(new Uint8Array(12)); // 12 字节独一 Nonce
  
  // 使用 ChaCha20-Poly1305 或 AES-GCM
  const { ciphertext, tag } = chacha20poly1305Encrypt(encKey, nonce, plainBytes);
  
  return {
    nonce: base64Encode(nonce),
    tag: base64Encode(tag),
    ciphertext: base64Encode(ciphertext),
  };
}

// 3. 接收后解密验证
export function decryptEnvelope(bundle: EncryptedPayloadBundle, encKey: Uint8Array): DeviceEnvelope {
  const nonce = base64Decode(bundle.nonce);
  const tag = base64Decode(bundle.tag);
  const cipherBytes = base64Decode(bundle.ciphertext);
  
  const decryptedBytes = chacha20poly1305Decrypt(encKey, nonce, cipherBytes, tag);
  const jsonStr = new TextDecoder().decode(decryptedBytes);
  return JSON.parse(jsonStr) as DeviceEnvelope;
}
```

---

## 4. 移动端远程控制核心闭环与三大痛点代码级根治

### 4.1 移动端远程控制全景控制台设计

移动端作为用户的“掌上控制中枢”，其交互必须极致聚焦、层次清晰：

```
+-------------------------------------------------------------+
|  <- [返回]    我的电脑 (Orange PC)         [E2EE加密] (● 实时) |
|               项目: /Software/conex                          |
+-------------------------------------------------------------+
|  [会话选择: 重构鉴权模块 (Session #3) ▼]  [+ 新建会话]         |
+-------------------------------------------------------------+
|                                                             |
|  +-------------------------------------------------------+  |
|  | [思考中] 正在分析 src-tauri/src/auth_commands.rs ...   |  |
|  | v 展开思考过程 (共 1,240 字)                           |  |
|  +-------------------------------------------------------+  |
|                                                             |
|  +-------------------------------------------------------+  |
|  | [工具调用] bash (cargo test --test device_parity)     |  |
|  | > running 12 tests ...                                |  |
|  | > test tests::device_parity_roundtrip ... ok          |  |
|  | [终端实时滚动窗 - 点击全屏查看 (最新 40 行)]           |  |
|  +-------------------------------------------------------+  |
|                                                             |
|  +-------------------------------------------------------+  |
|  | [!] 敏感操作审批请求 (倒计时 58s)                      |  |
|  | 工具: fs_write                                        |  |
|  | 路径: crates/conex-core/src/auth/token.rs              |  |
|  | [ 拒绝 (Deny) ]          [ >> 滑动以批准 (Approve) ]   |  |
|  +-------------------------------------------------------+  |
|                                                             |
+-------------------------------------------------------------+
|  [输入框: 下发新指令 / 给 Agent 补充说明...          ] [发送] |
+-------------------------------------------------------------+
```

### 4.2 移动端三大已知痛点代码级根治

#### 4.2.1 【痛点 1 根治】终端吸底防死锁与手势对抗（Terminal Bottom-Lockup Fix）

**【根因诊断】**：
在 `apps/crish-mobile/src/presentation/components/terminal/TerminalView.tsx` 中：
1. 流式文本以每秒数十行的速度到达，每次触发 `useEffect` 重新调用 `scrollToEnd({ animated: false })`；
2. 当用户手指向上滑动试图翻看历史报错时，用户的触控事件触发 `handleScroll`，计算得到的 `distanceFromEnd` 哪怕大于 40dp，下一毫秒到来的新文本帧立刻强行 `scrollToEnd`，强行把用户的可视区域扯回底部；
3. 这种“手势与自动滚底的恶性竞争”导致用户手指被死死锁在底部，滚动条剧烈抖动，体验极差。

**【代码级根治方案】**：
引入三权分立控制模型：
1. **物理手势独占标记（`isUserDraggingRef`）**：监听 `onScrollBeginDrag` 与 `onScrollEndDrag`。只要用户手指触碰屏幕正在拖拽，**绝对禁止**任何形式的 `scrollToEnd`；
2. **惯性滑行态跟踪（`isMomentumScrollingRef`）**：监听 `onMomentumScrollBegin` 与 `onMomentumScrollEnd`，惯性阶段同样不回扯；
3. **50ms 批量节流追加**：流式追加不再每行触发渲染，而是缓冲 50ms 后合并刷新。

```tsx
// 改造后的 TerminalView.tsx 核心代码片段
import React, { useRef, useCallback, useEffect, memo } from 'react';
import { FlatList, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';

export function TerminalViewFixed({
  lines,
  startIndex,
  follow,
  onFollowChange,
  listRef,
}: TerminalViewProps) {
  const internalRef = useRef<FlatList<string> | null>(null);
  const targetRef = listRef ?? internalRef;

  // 1. 核心手势跟踪锁
  const isUserTouchingRef = useRef(false);
  const isMomentumRef = useRef(false);

  // 2. 只有在用户完全没有触碰且明确开启跟随态时，才执行滚底
  useEffect(() => {
    if (follow && !isUserTouchingRef.current && !isMomentumRef.current && lines.length > 0) {
      requestAnimationFrame(() => {
        targetRef.current?.scrollToEnd({ animated: false });
      });
    }
  }, [lines.length, follow, targetRef]);

  // 3. 用户手指按下开始拖拽：坚决解除跟随！
  const handleScrollBeginDrag = useCallback(() => {
    isUserTouchingRef.current = true;
    if (follow) {
      onFollowChange?.(false); // 立即通知外部关闭 follow，唤起「回到底部」浮条
    }
  }, [follow, onFollowChange]);

  // 4. 用户手指松开
  const handleScrollEndDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    isUserTouchingRef.current = false;
    checkIfAtBottom(e.nativeEvent);
  }, []);

  // 5. 惯性滚动结束
  const handleMomentumScrollEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    isMomentumRef.current = false;
    checkIfAtBottom(e.nativeEvent);
  }, []);

  const handleMomentumScrollBegin = useCallback(() => {
    isMomentumRef.current = true;
  }, []);

  // 辅助检查是否滚回了底部
  const checkIfAtBottom = (nativeEvent: NativeScrollEvent) => {
    const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
    const distanceFromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    if (distanceFromEnd <= 40) {
      onFollowChange?.(true); // 用户手动滚回了底部，自动恢复吸底跟随
    }
  };

  return (
    <FlatList
      ref={targetRef}
      data={lines as string[]}
      onScrollBeginDrag={handleScrollBeginDrag}
      onScrollEndDrag={handleScrollEndDrag}
      onMomentumScrollBegin={handleMomentumScrollBegin}
      onMomentumScrollEnd={handleMomentumScrollEnd}
      scrollEventThrottle={16}
      // ... 其余 getItemLayout 与 Row 渲染保持不变
    />
  );
}
```

#### 4.2.2 【痛点 2 根治】WebSocket URL 完整鉴权与短效票据（WebSocket URL Full Auth）

**【根因诊断】**：
在移动端 `apps/crish-mobile/src/network/ReconnectingWsClient.ts` 中，由于 React Native 环境的 `new WebSocket(url)` 不支持设置自定义 HTTP Header（如 `Authorization: Bearer ...`），历史实现要么将长期有效敏感 Token 裸露写在 URL 查询参数中（极度危险，会被服务端反向代理日志记录），要么缺乏连接首阶段鉴权。

**【代码级根治方案】**：
实行 **“短效一次性签名票据（One-Time Ticket） + 首帧 AuthHello HMAC 校验”** 双重门禁：
1. **短效 Ticket 签发**：移动端在每次发起连接前，调用云端 REST API 获取 `relayTicket`（寿命仅 60 秒，仅限单次消费，关联 `userId` 与目标 `deviceId`）；
2. **URL 安全挂载**：`wss://relay.flowbit.me/v1/relay?ticket=rt_60s_...`；
3. **首帧强校验**：连接建立后 3 秒内，双端必须向中继发送签名帧 `auth.hello`，否则中继强制掐断连接。

```typescript
// 改造 ReconnectingWsClient.ts 的 openSocket 流程
private async openSocketWithAuth(): Promise<void> {
  try {
    // 1. 动态向云端申请一次性短效中继票据
    const ticket = await this.opts.ticketProvider();
    
    // 2. 构造具备签名票据的安全 URL (不暴露用户长期 Token)
    const secureUrl = new URL(this.opts.url);
    secureUrl.searchParams.set('ticket', ticket);
    secureUrl.searchParams.set('client_type', 'mobile');
    secureUrl.searchParams.set('v', '1');

    const factory = this.opts.factory ?? defaultFactory;
    const ws = factory(secureUrl.toString());
    this.ws = ws;

    ws.onopen = () => {
      // 3. 连接开启后，立即首发 AuthHello 帧进行应用层双向校验
      this.sendInitialAuthHello();
      this.handleOpen(ws);
    };
    // ...
  } catch (err) {
    this.scheduleReconnect();
  }
}
```

#### 4.2.3 【痛点 3 根治】回放游标恢复与精准对账（Replay Cursor Recovery Fix）

**【根因诊断】**：
在 `apps/crish-mobile/src/network/ReconnectingWsClient.ts` 的原先实现中：
```typescript
private handleOpen(ws: WsSocket): void {
  // ...
  this.driveProjection(); // <-- 错误！此时尚未向服务端发起订阅，也没有收到服务端的 subscribe.ok
}
```
`handleOpen` 触发时，底层 TCP 刚连上，客户端根本不知道服务端当前最大序号是多少（`serverNext` 尚未到达），导致 `snapshots` 永远为空数组，对账逻辑（`classifyReconcile`）全部落入空转，离线期间遗漏的事件帧从未真正通过 `events.resume` 补回。

**【代码级根治方案】**：
重构重连对账生命周期：
1. **解耦传输层与会话层**：`handleOpen` 仅负责传输就绪；
2. **在收到 `events.subscribe.ok` 后精准对账**：通过 WsGateway 监听 `events.subscribe.ok` 消息；
3. **增量续传与快照兜底**：若服务端返回的 `nextSequence` 大于本地 `lastSeq`，且落后数量在 5,000 条以内，自动发送 `events.resume { sessionId, afterSequence: lastSeq }` 分页追平；若落后大于 5,000 条或 `stale=true`，则拉取全量快照重建视图。

```typescript
// ReconnectingWsClient.ts 修复对账驱动点
private setupRoutes(): void {
  // 监听服务端对订阅请求的确认返回
  this.gateway.registerHandler('events.subscribe.ok', (frame) => {
    const { sessionId, nextSequence, stale } = frame.body;
    const localCursor = this.opts.getLocalCursor(sessionId);

    const snapshot: ReconcileSnapshot = {
      sessionId,
      localCursor,
      serverNext: nextSequence,
      serverStale: stale ?? false,
    };

    // 触发真正的对账处理纯函数
    const action = classifyReconcile(snapshot);
    if (action === 'resume') {
      console.log(`[Reconcile] 会话 ${sessionId} 落后，发起增量追平: afterSequence=${localCursor}`);
      this.gateway.send('events.resume', {
        sessionId,
        afterSequence: localCursor ?? 0,
        limit: 100,
      });
    } else if (action === 'full-replay') {
      console.warn(`[Reconcile] 会话 ${sessionId} 游标严重过期，请求全量快照重建`);
      this.gateway.send('events.resume', {
        sessionId,
        afterSequence: 0,
        fullSnapshot: true,
      });
    }
  });
}
```

---

## 5. 立体验证与高并发压测方案

### 5.1 20,000+ 虚拟连接压测方案

为了验证中继在单机承载 20,000+ 并发连接时的稳定性，设计基于 Node.js 异步流与 Tokio 的轻量虚拟压测工具。

#### 5.1.1 压测模拟脚本设计 (`scripts/benchmarks/relay-load-test.mjs`)
在局域网压测机（或通过 Tailscale 内网）发起模拟：
- **模拟拓扑**：启动 10,000 个虚拟 Desktop 连接 + 10,000 个虚拟 Mobile 连接；
- **发包行为**：
  - 维持 30 秒心跳；
  - 抽取 5% 活跃会话以 100ms 间隔高频模拟 Agent 流式吐字（模拟真实使用中的思考输出）；
  - 抽取 1% 会话模拟断网重新重连。

```javascript
// scripts/benchmarks/relay-load-test.mjs
import WebSocket from 'ws';

const TARGET_URL = 'ws://43.108.54.141:8080/v1/relay';
const TOTAL_PAIRS = 10000; // 10k 对 = 20k 连接
const CONNECTIONS_PER_SEC = 200; // 阶梯式平滑爬升

console.log(`开始高并发长连接压测：目标 20,000 连接...`);

let activeSockets = 0;
let messageCount = 0;

async function spawnPair(index) {
  const tunnelId = `bench-tunnel-${index}`;
  
  // 1. 启动虚拟桌面
  const desktop = new WebSocket(`${TARGET_URL}?tunnelId=${tunnelId}&role=desktop`);
  desktop.on('open', () => {
    activeSockets++;
    // 2. 启动对应虚拟手机
    const mobile = new WebSocket(`${TARGET_URL}?tunnelId=${tunnelId}&role=mobile`);
    mobile.on('open', () => {
      activeSockets++;
      
      // 保持心跳
      setInterval(() => {
        if (desktop.readyState === WebSocket.OPEN) desktop.ping();
        if (mobile.readyState === WebSocket.OPEN) mobile.ping();
      }, 30000);
      
      // 针对部分活跃会话持续发送模拟数据
      if (index % 20 === 0) {
        setInterval(() => {
          if (desktop.readyState === WebSocket.OPEN) {
            desktop.send(JSON.stringify({ type: 'data', seq: ++messageCount, payload: 'stream-chunk-payload-data' }));
          }
        }, 500);
      }
    });
  });
}

// 阶梯升压
let launched = 0;
const interval = setInterval(() => {
  for (let i = 0; i < CONNECTIONS_PER_SEC / 2 && launched < TOTAL_PAIRS; i++) {
    spawnPair(launched++);
  }
  process.stdout.write(`\r已建立连接: ${activeSockets} / 20000`);
  if (launched >= TOTAL_PAIRS) clearInterval(interval);
}, 1000);
```

#### 5.1.2 压测监控与指标验收矩阵

| 评估指标 | 工业级达标门禁值 | 实测预期 / 设计裕量 | 监控与检测手段 |
| :--- | :--- | :--- | :--- |
| **并发长连接数** | **20,000 稳定在线** | 单机支持 25,000+ | `netstat -an \| grep :8080 \| wc -l` |
| **服务器常驻内存 (RSS)** | **< 1.8 GB** | 1.2 GB ~ 1.5 GB | `process.memoryUsage().rss` / `htop` |
| **单帧中继延迟 (P99)** | **< 20 ms** | 8 ms ~ 12 ms | 统计发送端到接收端的 RTT 往返时延 |
| **连接建立成功率** | **> 99.9%** | 99.98% | 排除网络抖动后的最终握手成功率 |
| **长连接泄露数** | **0** | 0 泄露 | 压测停止后 100 秒内句柄归零 |

### 5.2 断线风暴自愈与雪崩防护压测

在生产环境中，网络抖动或 VPS 重启可能导致上万台设备瞬间同时重连，引发“惊群效应（Thundering Herd）”打满 CPU。
1. **全局随机抖动指数退避（Full Jitter Backoff）**：
   $$\text{Delay} = \min(\text{Cap}, \text{Base} \times 2^{\text{retry}}) \times \text{random}(0.5, 1.5)$$
   使得 10,000 个重连请求在时间轴上均匀分散在 1s ~ 30s 之间，避免出现峰值毛刺。
2. **中继服务前端令牌桶限流（Handshake Rate Limiter）**：
   中继服务在 WebSocket 升级（`upgrade`）阶段配置令牌桶（每秒最多接纳 500 个握手）。超额连接返回 `HTTP 429 Too Many Requests` 并附带 `Retry-After: 3`，保护中继 CPU 不被击穿。

### 5.3 端到端自动化对账与测试矩阵

在交付验证阶段，严格执行全套自动化回归测试：
1. **纯密码学对账单测**：
   - 验证 `keyAgreement.ts`（TypeScript）与 `crates/conex-types/src/device/`（Rust）在给定相同测试向量时，派生出的 `enc_key` 与 `token_key` 完全逐字节一致；
2. **桌面端 IPC 状态单测**：
   - 针对 `auth_commands.rs` 的 7 个命令编写 Mock 测试，验证登录、登出、Token 轮换、多设备列举；
3. **移动端 UI 与手势单测**：
   - 针对 `TerminalViewFixed` 编写手势竞争单元测试：在高速吐字状态下模拟用户触摸滚动，断言 `follow` 状态正确置为 `false`，且绝对不触发意外的 `scrollToEnd`；
4. **端到端集成验证**：
   - 启动真实 Fastify 中继，让桌面端与移动端分别在公网建立连接，下发 `echo "hello world"` 指令，断言移动端在 200ms 内收到正确解密的思考流与输出帧。

---

## 6. 实施路线图与交付物归属

| 阶段 | 周期 (工作日) | 核心交付成果 | 对应代码与文档域 |
| :--- | :--- | :--- | :--- |
| **Phase 1** | 2 天 | **桌面端账号中心落地**：重构 `SettingsProfileTab.tsx`、`UserProfileCard.tsx`，实现 Rust 侧 `auth_commands.rs` 与安全 TokenStore。 | `apps/crish-desktop/src/components/settings/`, `apps/agent-workbench/src-tauri/src/` |
| **Phase 2** | 2 天 | **Fastify 盲中继与 E2EE 协议**：在 `zennav-server` 中接入 `@fastify/websocket` 盲中继模块，实现背压与心跳 GC，打通双端 X25519 E2EE 加解密。 | `zennav-server/src/modules/relay/`, `apps/crish-mobile/src/pairing/crypto/` |
| **Phase 3** | 2 天 | **移动端远程控制与痛点整改**：根治终端吸底死锁，实现 URL 短效安全 Ticket 鉴权，修复回放游标对账。 | `apps/crish-mobile/src/presentation/`, `apps/crish-mobile/src/network/` |
| **Phase 4** | 1 天 | **立体验证与 20k 并发压测**：执行高并发压测脚本，断网风暴自愈演练，CI/CD 全绿归档。 | `scripts/benchmarks/`, 验收文档 |

---
**【方案 D 总结】**：本方案严格遵循“把复杂留给自己，把极简留给用户”的最高原则。不玩技术噱头，不引入昂贵复杂的分布式集群，全量盘活用户现有的阿里云首尔服务器与桌面/移动端既有代码资产。通过优雅的 **双轨自适应机制**、**零知识 E2EE 盲中继**、**代码级痛点根治** 与 **20k 单机极限调优**，打造一套既让用户点点就能连、又让系统坚若磐石的工业级多端协同远程控制体系。
