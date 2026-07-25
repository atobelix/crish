# Conex 深度 Gap 诊断报告 —— Agent 6：桌面 / UI / 唤醒域与应用运行时

> **审计基准标杆**：`C:\Software\conex\analysis\reference_patch_audits\` 下 6 份标杆补丁报告（重点对比 `patch_analysis_05_desktop_agent_runtimes.md`）  
> **受审 Conex 模块**：`apps/agent-workbench/src-tauri` (Tauri 2 桌面主进程), `apps/crish-desktop` (React / Vite 渲染进程 UI), `crates/conex-stream` (流式解析器), `packages/agent-runtime` (LLM 客户端与 Reasoning 协议)  
> **报告保存路径**：`C:\Software\conex\analysis\conex_gap_audits\conex_gap_06_desktop_ui_runtimes.md`  
> **诊断时间**：2026-07-24  

---

## 1. 诊断总览与桌面运行时差距矩阵 (Executive Summary & Gap Matrix)

基于对 Conex 源码树（`apps/agent-workbench/src-tauri`、`apps/crish-desktop`、`crates/conex-stream`、`packages/agent-runtime`）与标杆项目（Hermes Agent、DEEIX-Chat、Cherry Studio）18 个核心 Patch Commit 的对比审计，Conex 在桌面端 OS 交互、思考链流式中断持久化、UI 视口边界钳制以及跨平台 API Key 物理加密等领域存在 4 大致命工程差距。

```
+-----------------------------------------------------------------------------------+
|                  Conex Desktop / UI / Runtime Gap Architecture                    |
+-----------------------------------------------------------------------------------+
|  [ Tauri 2 Rust Main Host ] (apps/agent-workbench/src-tauri)                      |
|   ├── ❌ Missing System Keep-Awake / PowerSaveBlocker (OS Sleeps during long runs)|
|   └── ⚠️ Partial DPAPI (Windows only; macOS Keychain & Linux SecretService missing)|
+-----------------------------------------------------------------------------------+
                                         │  (Tauri IPC / Daemon RPC)
                                         ▼
+-----------------------------------------------------------------------------------+
|  [ Core Runtime & Stream Parser ] (packages/agent-runtime, crates/conex-stream)   |
|   ├── ❌ Stream Abort Wipes `reasoning_content` (DeepSeek-R1 CoT lost on Stop)    |
|   └── ❌ Interrupted Usage Token Billing set to 0 (No heuristic recovery)        |
+-----------------------------------------------------------------------------------+
                                         │  (React State & DOM Events)
                                         ▼
+-----------------------------------------------------------------------------------+
|  [ Desktop UI & Components ] (apps/crish-desktop/src/components)                  |
|   ├── ❌ Popovers Overflow Viewport (Missing max-h-[calc(100dvh-3rem)] clamping)  |
|   └── ⚠️ Plaintext localStorage Fallback (API Key leakage risk in Web/Demo Mode)  |
+-----------------------------------------------------------------------------------+
```

### 4 大诊断域差距对比表

| 诊断维度 | Conex 现状源码路径与实现 | 标杆项目（Hermes / DEEIX-Chat / Cherry Studio）标准 | 风险等级 |
| :--- | :--- | :--- | :--- |
| **1. 系统 Keep-Awake 保持唤醒** | `apps/agent-workbench/src-tauri/src/main.rs`<br>`sidecar/run_stream.rs`<br>**无任何唤醒锁逻辑** | Hermes Commit `3ef5249558`<br>主进程持久化 `keep-awake.json`<br>`app.whenReady()` 自动唤醒 OS 阻止睡眠 | **P0 严重** |
| **2. Reasoning 思考链中断保存** | `apps/crish-desktop/src/api/directFetchBridge.ts:290`<br>`useStreamCallbacks.ts:479`<br>**Abort 直接 return 并清空思考缓存** | DEEIX-Chat Commit `5c224aa` & Hermes `c363db81e0`<br>`persistInterruptedMessageGenerationInput`<br>保存 `AssistantReasoningText` + Token 估算 | **P0 严重** |
| **3. UI 视口高度钳制与事件拦截** | `ModelPicker.module.css:7` (`max-h: 52vh`)<br>`ComposePlusMenu.module.css` (**无 max-h/overflow**)<br>`ProjectPickerMenu.tsx` (动态 `Function` import) | DEEIX-Chat Commit `303816a` & Hermes `470c7e2a60`<br>`max-h-[calc(100dvh-3rem)]` + 动态 Viewport 碰撞计算<br>`1ch` 容器固定数字防闪烁 | **P1 高危** |
| **4. API Key 物理加密保存** | `src-tauri/src/config/credentials.rs` (仅 Windows DPAPI)<br>`providerProfiles.ts:66` (明文 LS)<br>`clientApi.demo.ts` (明文 LS) | Hermes Commit `c8882c141c` & Keychain/SecretService<br>跨平台 Keychain/SecretService + Keyring Sidecar<br>沙盒 Mount Guard 防凭据越界窃取 | **P1 高危** |

---

## 2. 诊断重点 1：Tauri 主进程系统级 Keep-Awake 唤醒锁缺位审计

### 2.1 源码真实缺陷位置与现象

在 Conex 的桌面宿主模块 `apps/agent-workbench/src-tauri/src/main.rs` 及 Sidecar 管理模块 `apps/agent-workbench/src-tauri/src/sidecar/` 中，系统完全缺乏 OS 级别的电源管理与阻止睡眠机制。

- **源码文件**：[apps/agent-workbench/src-tauri/src/main.rs](file:///C:/Software/conex/apps/agent-workbench/src-tauri/src/main.rs#L19-L99)
- **源码文件**：[apps/agent-workbench/src-tauri/src/sidecar/run_stream.rs](file:///C:/Software/conex/apps/agent-workbench/src-tauri/src/sidecar/run_stream.rs#L310-L330)

在 `main.rs` 注册的 70+ 个 Tauri Command 列表中（从 `sidecar::workbench_run_task_stream` 到 `sidecar::workbench_run_goal_stream`），未发现任何电源阻塞或 Wake-Lock 相关的 IPC Handler 或 Native API 绑定。

```rust
// apps/agent-workbench/src-tauri/src/main.rs (缺失 Keep-Awake 注册)
tauri::generate_handler![
    sidecar::workbench_run_task_stream,
    sidecar::workbench_run_goal_stream,
    // ❌ 缺失 keep_awake / prevent_sleep 相关 command
]
```

### 2.2 真实缺陷隐患分析

1. **长时间 Task / Goal 运行中断**：当 Agent 执行耗时较长（例如 10 分钟到数小时）的代码重构、多步 Tool Call、全库索引构建或后台 Compaction 任务时，若用户未进行键盘鼠标操作，宿主 OS（Windows / macOS / Linux）会自动进入睡眠或 Power Nap 状态。
2. **WebSocket & TCP 套接字硬断开**：OS 进入睡眠后，Tauri 主进程与 Node `agent-daemon` 之间的 IPC 通道以及 Daemon 与远程 API Provider（如 OpenAI / DeepSeek / Claude）的 HTTP/2 / SSE 套接字被强制冻结与关闭。
3. **任务挂起与死锁**：OS 恢复唤醒后，前台 UI 界面停留在 "Processing..." 状态，但后台 WebSocket 已断线，导致任务永久假死，用户不得不手动强行重启应用。

### 2.3 标杆对比与系统加固方案

对照标杆报告 `patch_analysis_05_desktop_agent_runtimes.md` 中 Hermes Agent 的修补补丁（Commit `3ef5249558`）：
Hermes 将唤醒控制权下沉至主进程，在应用启动 `app.whenReady()` 阶段读取 `keep-awake.json`，并调用 Electron `powerSaveBlocker.start('prevent-app-suspension')`。

#### Conex 架构补丁设计 (Tauri 2 Native Keep-Awake)

在 `apps/agent-workbench/src-tauri/src/` 中新增 `power.rs` 模块，通过 Win32 API / macOS IOKit / Linux DBus 实现跨平台 OS 唤醒锁：

```rust
// apps/agent-workbench/src-tauri/src/power.rs
use std::sync::atomic::{AtomicBool, Ordering};

static KEEP_AWAKE_ENABLED: AtomicBool = AtomicBool::new(false);

pub struct KeepAwakeGuard;

impl KeepAwakeGuard {
    pub fn set_enabled(enabled: bool) {
        KEEP_AWAKE_ENABLED.store(enabled, Ordering::SeqCst);
        #[cfg(target_os = "windows")]
        unsafe {
            use windows_sys::Win32::System::Power::*;
            if enabled {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED);
            } else {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
        }
        #[cfg(target_os = "macos")]
        {
            // macOS IOPMAssertionCreateWithName 实现...
        }
    }
}

#[tauri::command]
pub fn workbench_set_keep_awake(enabled: bool) -> Result<(), String> {
    KeepAwakeGuard::set_enabled(enabled);
    // 持久化状态至 keep-awake.json
    Ok(())
}
```

---

## 4. 诊断重点 2：Reasoning 模型 `reasoning_content` 中断丢弃与流保存缺陷

### 4.1 源码真实缺陷位置与现象

在 Conex 的前端流式桥接模块 `apps/crish-desktop/src/api/directFetchBridge.ts` 与消息流 Hook `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` 中，存在 DeepSeek-R1 / Qwen 等 Reasoning 模型思考链（`reasoning_content`）在中途 Abort / 异常断开时被清空和抹除的严重点。

- **源码文件**：[apps/crish-desktop/src/api/directFetchBridge.ts](file:///C:/Software/conex/apps/crish-desktop/src/api/directFetchBridge.ts#L258-L305)
- **源码文件**：[apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts](file:///C:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts#L476-L515)

#### 缺陷 1：`directFetchBridge.ts` 在 Signal Abort 时无条件丢弃思考文本

```typescript
// apps/crish-desktop/src/api/directFetchBridge.ts (L289-L305)
    } catch (err: unknown) {
      if (controller.signal.aborted) return; // ❌ 致命缺陷：用户点击 Stop 触发 abort 后，立刻 return！
      const msg = err instanceof Error ? err.message : String(err);
      if (callbacks.onRunError) callbacks.onRunError(msg, 'network');
      else callbacks.onChunk(`\n⚠️ ${msg}`);
      finished = true;
      callbacks.onComplete(); // ❌ aborted 时完全跳过了 onComplete()，导致已收到的 assistantThought 被抹除
    }
```

#### 缺陷 2：`useStreamCallbacks.ts` 在完成与异常时直接清空 Thinking Buffer 且 Usage 计费置 0

```typescript
// apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts (L479-L483, L508)
    const th = latest?.thinking || '';
    if (th === '正在处理…' || th === '正在思考中...') {
      thinkingBatcherRef.current?.drop(streamBatchKey(sid, assistantMsgId)); // ❌ 丢弃批处理缓存
      st.updateMessageThinking(sid, assistantMsgId, '');
    }
    // ...
    // ❌ fetchRunSnapshotUsage(runId) 仅在 onComplete 触发；若流被 abort，Usage 算费直接记录为 0！
```

### 4.2 真实缺陷隐患分析

1. **思维链 (CoT) 完全丢失**：使用 DeepSeek-R1 或 R1-Distill 模型时，模型生成长达 2000 字的 `reasoning_content`（思考过程）。若用户在模型开始输出正式 Content 之前或中途点击 "Stop"（停止生成），`directFetchBridge.ts` 捕获到 `aborted` 信号后直接静默 return，未向 UI 和数据库持久化已接收到的思考过程，导致思考 Bubble 在界面上瞬间清空。
2. **Token 计费与 telemetry 统计失效**：由于中断流未触发完整 Settlement，`fetchRunSnapshotUsage(runId)` 被跳过，系统在 telemetry 与 `pricingStore` 中将本次中断请求的 Prompt Tokens 和 Reasoning Tokens 统计为 0。
3. **会话重载与 Retry 消息重复 (Message Duplication)**：由于数据库未妥善记录中断节点的 `reasoning_content` 和阶段性状态，当用户重新载入会话或点击 Retry 时，因为 Lack of Ancestor Display Lineage Filtering，界面会出现前 N 条消息重复拼接的 Bug（完全对应 Hermes Commit `3133af8215` 描述的缺陷）。

### 4.3 标杆对比与系统加固方案

对照 DEEIX-Chat Commit `5c224aa`（`fix: preserve interrupted reasoning and improve usage settlement`）：
DEEIX-Chat 在后端引入 `persistInterruptedMessageGenerationInput`，包含 `AssistantReasoningText` 入参，并实现 `resolveInterruptedOutputUsage` 启发式估算 Token。

#### Conex 架构补丁设计 (Interrupted Reasoning & Usage Recovery)

1. **在 `directFetchBridge.ts` 中补全 Abort 时的思考链封存**：

```typescript
// apps/crish-desktop/src/api/directFetchBridge.ts
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        // 即使 abort，也必须强制触发 onThought 刷新与阶段性 onComplete
        if (assistantThought) {
          callbacks.onThought(assistantThought);
        }
        callbacks.onComplete();
        return;
      }
      // ...
```

2. **在 `useStreamCallbacks.ts` 中实现中断 Usage 启发式估算兜底**：

```typescript
// apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts
export function resolveInterruptedTokens(text: string, thought: string): { outputTokens: number; reasoningTokens: number } {
  // 按 1.3 chars/token 进行启发式估算，防止中断请求计费为 0
  const outputTokens = Math.ceil((text || '').length / 3.5);
  const reasoningTokens = Math.ceil((thought || '').length / 3.5);
  return { outputTokens, reasoningTokens };
}
```

---

## 5. 诊断重点 3：桌面 UI 视口高度钳制、遮罩与事件拦截审计

### 5.1 源码真实缺陷位置与现象

在 Conex 的桌面 UI 菜单与选择器组件中（如 `ModelPicker`、`ComposePlusMenu`、`ProjectPickerMenu`），存在视口高度未钳制（Viewport Boundary Overflow）、缺少动态 `dvh` 单位以及底层 DOM 动态 `Function` 导入反模式等缺陷。

- **源码文件**：[apps/crish-desktop/src/components/ModelPicker.module.css](file:///C:/Software/conex/apps/crish-desktop/src/components/ModelPicker.module.css#L7-L26)
- **源码文件**：[apps/crish-desktop/src/components/ComposePlusMenu.module.css](file:///C:/Software/conex/apps/crish-desktop/src/components/ComposePlusMenu.module.css#L14-L26)
- **源码文件**：[apps/crish-desktop/src/components/ProjectPickerMenu.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/ProjectPickerMenu.tsx#L34-L59)

#### 缺陷 1：`ModelPicker.module.css` 使用静态 `vh`，缺失视口边界碰撞计算

```css
/* apps/crish-desktop/src/components/ModelPicker.module.css */
.mpick {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  width: min(260px, 90vw);
  max-height: min(360px, 52vh); /* ❌ 使用旧 52vh，未用 100dvh 弹性钳制 */
  /* ... */
}
```

#### 缺陷 2：`ComposePlusMenu.module.css` 容器完全缺失 `max-height` 与 `overflow` 约束

```css
/* apps/crish-desktop/src/components/ComposePlusMenu.module.css */
.main {
  width: 220px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-2xl);
  /* ❌ 致命缺陷：完全缺失 max-height 和 overflow-y: auto！ */
  /* 当子项或技能列表增加时，菜单将向上穿透 0px Viewport 顶边出屏 */
}
```

#### 缺陷 3：`ProjectPickerMenu.tsx` 存在动态 `Function` 字符串 import 反模式

```typescript
// apps/crish-desktop/src/components/ProjectPickerMenu.tsx (L36-L42)
  const mod = (await (
    Function('return import("@tauri-apps/plugin-dialog")')() // ❌ 违反 CSP 规范与静态分析
  ).catch(() => null));
```

### 5.2 真实缺陷隐患分析

1. **弹出框超出屏幕视口（Viewport Clipping）**：在低分辨率笔记本（如 1366x768 或 1280x800）或小窗口模式下打开 `ComposePlusMenu` 或 `ModelPicker` 时，由于缺乏 `max-h-[calc(100dvh-3rem)]` 的动态钳制，菜单头部或顶部选项向上超出屏幕顶部（`top < 0px`），导致部分菜单项无法被用户看到和点击。
2. **滚轮事件穿透 (Scroll Event Bleed-Through)**：在 Popover / Dropdown 上滚动鼠标滚轮时，由于缺少 `onWheel={(e) => e.stopPropagation()}` 事件阻断，滚轮事件透传给底层聊天消息列表 (`ChatMessageList`)，导致菜单未滚动、背景页面却在飞速上下滑动。
3. **计时器与数字跳动引起的视口抖动**：StatusBar 计时器或 Tool Call 运行时间（如 `00:01` 到 `00:02`）在比例字体下导致外包围盒宽度变化，引发 UI Flex 容器频繁重排（Reflow 抖动）。

### 5.3 标杆对比与系统加固方案

对照 DEEIX-Chat Commit `303816a`（`fix: clamp desktop model menu height`）与 Hermes Commit `470c7e2a60`（`fix: prevent timers from shifting as they count`）：

#### Conex 架构补丁设计

1. **为所有 Popover 注入 `100dvh` 视口高度钳制**：

```css
/* 统一 Popover Viewport 弹性钳制范式 */
.popoverClamped {
  max-height: min(380px, calc(100dvh - 3.5rem));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.popoverScrollArea {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain; /* 阻止滚轮穿透 */
}
```

2. **消除动态 `Function` import，使用标准动态 import**：

```typescript
// 修正 ProjectPickerMenu.tsx 中的 Dynamic Import
async function pickFolderNative(title?: string): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false, title });
    if (typeof selected === 'string') return selected;
  } catch { /* browser fallback */ }
  return null;
}
```

3. **引入 `StableText` 防字体宽度跳动**：

```tsx
// apps/crish-desktop/src/components/chat/StableText.tsx
export const StableText: React.FC<{ text: string }> = ({ text }) => (
  <span className="inline-flex items-center">
    {text.split('').map((char, i) => (
      <span key={i} className="inline-block text-center" style={{ width: '1ch' }}>
        {char}
      </span>
    ))}
  </span>
);
```

---

## 6. 诊断重点 4：API Key 保存物理加密 (DPAPI/Keyring) 与凭据隔离审计

### 6.1 源码真实缺陷位置与现象

在 Conex 的凭据安全与 Key 保存机制中，虽然 Rust 侧针对 Windows 构筑了 DPAPI 加密，但存在**非 Windows 平台硬抛错降级**以及**前端 `localStorage` 敏感密钥明文泄漏**的双重缺陷。

- **源码文件**：[apps/agent-workbench/src-tauri/src/config/credentials.rs](file:///C:/Software/conex/apps/agent-workbench/src-tauri/src/config/credentials.rs#L166-L210)
- **源码文件**：[apps/crish-desktop/src/api/providerProfiles.ts](file:///C:/Software/conex/apps/crish-desktop/src/api/providerProfiles.ts#L66-L68)
- **源码文件**：[TECH_DEBT.md](file:///C:/Software/conex/TECH_DEBT.md#L23) (`TD-061: frontend localStorage 明文存储 API keys 未加密`)

#### 缺陷 1：Rust 侧非 Windows 平台（macOS / Linux）加密实现为空

```rust
// apps/agent-workbench/src-tauri/src/config/credentials.rs (L171-L174, L187-L190)
#[cfg(not(windows))]
fn os_secret_store_available(_path: &Path) -> Result<(), String> {
    Err("OS credential storage is not implemented for this platform".to_string())
}
/* ❌ 致命缺陷：macOS (Keychain) 与 Linux (SecretService) 未实现！
   在 macOS / Linux 宿主上，CredentialStore 强制降级为 MemoryOnly 或报错 */
```

#### 缺陷 2：前端 `providerProfiles.ts` 将 Provider 凭据明文持久化在 `localStorage`

```typescript
// apps/crish-desktop/src/api/providerProfiles.ts (L66-L68)
const PROFILES_KEY = 'crish_provider_profiles_v1';
/* ❌ 在 Web 模式、Demo 模式或跨进程同步时，ProviderProfile 结构体中的 apiKey 
   被直接 JSON.stringify 存入浏览器 localStorage，完全脱离了 Physical Guard */
```

### 6.2 真实缺陷隐患分析

1. **XSS 与恶意 Skill 密钥窃取**：如果第三方 Skill / Tool 运行在渲染进程中，或者渲染进程遭受到 Dom/Script 注入攻击，攻击者可以通过 `localStorage.getItem('crish_provider_profiles_v1')` 一键脱库所有保存的 OpenAI / DeepSeek / Claude API Keys。
2. **跨平台兼容性破裂**：在 macOS 和 Linux 桌面客户端上，因为 Rust 侧 `credentials.rs` 对 `#[cfg(not(windows))]` 直接返回 Error，系统无法将 Key 存储在系统 Keychain 或 Keyring 中，用户每次重启 Desktop 应用都必须重新输入 API Key。
3. **沙盒越界读取凭据文件 (Sandbox Escape)**：正如 Hermes Commit `c8882c141c` 揭示的漏洞，若沙盒仅校验路径包含关系而不拦截 `.env` 或凭据文件，恶意的 Agent Skill 可以通过声明挂载 `.env` 偷取宿主 Master Credential Stores。

### 6.3 标杆对比与系统加固方案

对照 Hermes Commit `c8882c141c` (`fix(credentials): never mount master credential stores into skill sandboxes`) 与系统的 Keyring 隔离设计：

#### Conex 架构补丁设计

1. **在 Rust 侧扩展 macOS (Security Framework) 与 Linux (SecretService) Keyring 支持**：

```rust
// apps/agent-workbench/src-tauri/src/config/credentials.rs
#[cfg(target_os = "macos")]
fn os_secret_store_available(_path: &Path) -> Result<(), String> {
    // 调用 macOS Security Framework (SecItemAdd / SecItemCopyMatching)
    Ok(())
}

#[cfg(target_os = "linux")]
fn os_secret_store_available(_path: &Path) -> Result<(), String> {
    // 调用 Linux libsecret / DBus SecretService API
    Ok(())
}
```

2. **前端严格剥离 `localStorage` 中的明文 `apiKey`**：

```typescript
// apps/crish-desktop/src/api/providerProfiles.ts
export function serializeProfileForLocalStorage(p: ProviderProfile): Omit<ProviderProfile, 'apiKey'> {
  const copy = { ...p };
  delete copy.apiKey; // 严格剥离 apiKey，只保留 hasKey 布尔标记
  delete copy.oauthToken; // 剥离 OAuth Tokens
  return copy;
}
```

3. **引入 Skill 沙盒凭据 Mount Guard (Fail-Closed 原则)**：

```rust
// 挂载 Skill 沙盒前强行阻断主凭据目录
pub fn validate_skill_sandbox_mount(requested_path: &Path) -> Result<(), String> {
    let forbidden_names = [".env", "auth.json", "keep-awake.json", "credentials.dat"];
    if let Some(file_name) = requested_path.file_name() {
        if forbidden_names.iter().any(|&f| f == file_name.to_string_lossy()) {
            return Err("Refusing to mount protected credential store into sandbox".into());
        }
    }
    Ok(())
}
```

---

## 7. 终极整改计划与 Task 拆解 (Actionable Roadmap)

为彻底弥合上述 4 大 Gap，现提出 Agent 6 桌面/UI/唤醒域整改路线图，划分为 3 个 P0 阶段：

```
+-----------------------------------------------------------------------------------+
|                        Desktop & UI Refactoring Execution Plan                    |
+-----------------------------------------------------------------------------------+
|  [ Phase A: OS Power & Core Stream Hardening ] (P0)                               |
|   ├── Task A1: Implement Tauri Native Keep-Awake Guard in `src-tauri/src/power.rs` |
|   └── Task A2: Fix Interrupted `reasoning_content` preservation in stream bridge  |
+-----------------------------------------------------------------------------------+
                                         │
                                         ▼
|  [ Phase B: UI Viewport & Font Layout Clamping ] (P1)                             |
|   ├── Task B1: Inject `100dvh` clamping & scroll event interception on popovers   |
|   └── Task B2: Replace Dynamic Function import with standard ESM in picker menus  |
+-----------------------------------------------------------------------------------+
                                         │
                                         ▼
|  [ Phase C: Cross-Platform Keyring Security ] (P1)                                |
|   ├── Task C1: Add macOS Keychain & Linux SecretService bindings to `credentials.rs` |
|   └── Task C2: Purge plaintext `apiKey` from `localStorage` & add Sandbox Mount Guard|
+-----------------------------------------------------------------------------------+
```

### Task 拆解与责任分配

1. **Task 6.1 (P0)**：在 `apps/agent-workbench/src-tauri` 中新增 `power.rs` 唤醒锁，支持系统级阻止睡眠，持久化开关至 `keep-awake.json`。
2. **Task 6.2 (P0)**：改造 `apps/crish-desktop/src/api/directFetchBridge.ts` 与 `useStreamCallbacks.ts`，在中途 Abort 信号触发时强制封存 `assistantThought` (`reasoning_content`) 并实施 Token 估算结算。
3. **Task 6.3 (P1)**：重构 `ModelPicker.module.css` 与 `ComposePlusMenu.module.css`，全量应用 `max-h-[calc(100dvh-3rem)]` 视口限制与 `overscroll-behavior: contain` 滚轮拦截。
4. **Task 6.4 (P1)**：升级 `apps/agent-workbench/src-tauri/src/config/credentials.rs`，补全 macOS Keychain 与 Linux SecretService 支持，彻底从 `localStorage` 中擦除明文 `apiKey`。

---

> **诊断结论**：Conex 桌面端架构基础良好，但在 OS 级睡眠唤醒保护、DeepSeek-R1 思考链流中断封存、UI 视口边界钳制以及跨平台物理密钥隔离上存在严重安全与体验短板。依照本报告设计的补丁代码与架构规约进行重构，将大幅提升桌面 Agent OS 的稳定度与工业级品质。
