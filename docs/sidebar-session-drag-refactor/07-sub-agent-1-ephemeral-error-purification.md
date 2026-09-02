# 主对话界面非 AI 伪回复彻底清退与瞬态进行时错误态（Volatile Ephemeral Status）独立深度架构方案

> **文档定位**：`docs/sidebar-session-drag-refactor/07-sub-agent-1-ephemeral-error-purification.md`  
> **所属战役**：`docs/sidebar-session-drag-refactor/` 侧栏会话列表拖拽重构与消息流纯洁性体系  
> **架构契约**：严格遵循 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §1（逻辑规划与反退避）、§7（严禁补丁/作弊）、§7.1（立体验证纪律）、§8（反过度设计硬性红线）、§13（输入框与焦点态规范）、§14（色彩空间与现代 CSS 规范）。  
> **核心领域**：会话消息流纯洁性（Pure AI Conversation Stream）、流式生命周期事件系统（`chat-stream` / [`BridgeErrorPolicy`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/BridgeErrorPolicy.ts) / [`diagnosticHandlers`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/diagnosticHandlers.ts)）、非持久瞬态错误状态机（`ephemeralChatStore`）、消息列表底部进行时渲染插槽（[`ChatMessageList`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/ChatMessageList.tsx) / [`MessageVirtualizer`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx) / `EphemeralStatusSlot`）。

---

# 目录索引

- [一、 核心命题与架构愿景](#一-核心命题与架构愿景)
- [二、 全链路代码病理深度调查（5 大伪回复发源点与多轨撕裂）](#二-全链路代码病理深度调查5-大伪回复发源点与多轨撕裂)
  - [2.1 伪回复病理现场 1：`/learn` 命令强行伪造落盘 Assistant 消息](#21-伪回复病理现场-1learn-命令强行伪造落盘-assistant-消息)
  - [2.2 伪回复病理现场 2：流式预置占位残留与零 Token 崩溃悬空](#22-伪回复病理现场-2流式预置占位残留与零-token-崩溃悬空)
  - [2.3 伪回复病理现场 3：`ErrorMessageBanner` 侵入气泡并随 `errorDetail` 持久化](#23-伪回复病理现场-3errormessagebanner-侵入气泡并随-errordetail-持久化)
  - [2.4 伪回复病理现场 4：错误降级分支将网络错误作为 Token 流入 Assistant 正文](#24-伪回复病理现场-4错误降级分支将网络错误作为-token-流入-assistant-正文)
  - [2.5 伪回复病理现场 5：多轨分发撕裂（Banner vs Toast vs Dock vs 气泡）](#25-伪回复病理现场-5多轨分发撕裂banner-vs-toast-vs-dock-vs-气泡)
- [三、 瞬态进行时错误态（Volatile Ephemeral Status）架构设计](#三-瞬态进行时错误态volatile-ephemeral-status架构设计)
  - [3.1 核心状态契约：`ephemeralChatStore` 独立状态机](#31-核心状态契约ephemeralchatstore-独立状态机)
  - [3.2 零持久化绝对隔离原则（Zero-Persistence Guarantees）](#32-零持久化绝对隔离原则zero-persistence-guarantees)
  - [3.3 底部流式插槽（`EphemeralStatusSlot`）视觉与交互规范](#33-底部流式插槽ephemeralstatusslot视觉与交互规范)
- [四、 自愈机制、去重状态机与生命周期时序](#四-自愈机制去重状态机与生命周期时序)
  - [4.1 四大原子自愈场景（Self-Healing Triggers）](#41-四大原子自愈场景self-healing-triggers)
  - [4.2 单例去重与窗口抑制算法（Deduplication Invariant）](#42-单例去重与窗口抑制算法deduplication-invariant)
  - [4.3 零 Token 失败干净撤回 vs 部分 Token 中断保留真迹](#43-零-token-失败干净撤回-vs-部分-token-中断保留真迹)
- [五、 全链路代码改造详细实施蓝图](#五-全链路代码改造详细实施蓝图)
  - [5.1 新建 `ephemeralChatStore.ts`](#51-新建-ephemeralchatstorets)
  - [5.2 新建 `EphemeralStatusSlot.tsx` 与 `.module.css`](#52-新建-ephemeralstatusslottsx-与-modulecss)
  - [5.3 改造 `MessageContent.tsx`：彻底物理拔除 `ErrorMessageBanner`](#53-改造-messagecontenttsx彻底物理拔除-errormessagebanner)
  - [5.4 改造 `slashSendPreflight.ts`：清退 `/learn` 伪造回复](#54-改造-slashsendpreflightts清退-learn-伪造回复)
  - [5.5 改造 `streamCallbacksEvents.ts`：错误分发统一路由至瞬态 Store](#55-改造-streamcallbackseventsts错误分发统一路由至瞬态-store)
  - [5.6 改造 `useSlashSend.ts` 与 `useChatHandlers.ts`：注入自愈钩子](#56-改造-useslashsendts-与-usechathandlersts注入自愈钩子)
  - [5.7 改造 `ChatMessageList.tsx` / `MessageVirtualizer.tsx`：装配流式底部插槽](#57-改造-chatmessagelisttsx--messagevirtualizertsx装配流式底部插槽)
  - [5.8 清理 `types.ts` 与数据持久化层：移出 `errorDetail`](#58-清理-typests-与数据持久化层移出-errordetail)
- [六、 五层立体验证模型与测试用例矩阵](#六-五层立体验证模型与测试用例矩阵)

---

# 一、 核心命题与架构愿景

在 AI 对话客户端设计中，**会话消息流的真实性与纯洁性（Conversation Stream Purity）** 是决定用户信任度的最高宪法级原则。针对当前系统中非 AI 伪回复污染消息历史、错误提示多轨撕裂、以及错误状态堆叠的问题，本方案制定三大不可动摇的架构断言：

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                           【 会话流纯洁性三大架构断言 (Three Invariants) 】                    │
├─────────────────────┬───────────────────────────────────────────────────────────────────────────┤
│ 1. 真实 AI 回答铁律 │ 主对话历史（Session Messages）只允许持久化两种内容：                      │
│    (Pure AI Only)   │ ① 用户的真实输入与指令；                                                 │
│                     │ ② 模型真实输出的 Token 流、思考链（Thought）与工具调用（Tool Calls）。    │
│                     │ 坚决拔除任何由本地前端、中间件或错误处理器构造并推入 `messages` 的伪回复！│
├─────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ 2. 瞬态进行时错误态 │ 发生网络离线、模型报错、限流拦截或异常中断时，界面在消息流最底部呈现一个  │
│    (Volatile Status)│ **临时的、进行时的灰色状态插槽（Ephemeral Status Slot）**。               │
│                     │ 视觉与工作中/思考中状态自然交融，使用 `var(--text-tertiary)` 灰色字体，   │
│                     │ 具备轻量重试能力，完全脱离持久化存储，内存独占。                          │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ 3. 单例去重与自愈性 │ 状态机具备极简自愈力：                                                    │
│    (Self-Healing &  │ ① 用户点击重试或发送新对话，瞬态错误提示立即原子清空消失；                │
│     Single Dedupe)  │ ② 连续或重复错误在会话内严格单例覆盖，绝不允许向下堆叠多条重复卡片。      │
└─────────────────────┴───────────────────────────────────────────────────────────────────────────┘
```

---

# 二、 全链路代码病理深度调查（5 大伪回复发源点与多轨撕裂）

通过对前端全链路（包括发送前置、流式处理、消息 Store、持久化层、组件渲染层）的全面排查，定位到以下 5 大造成伪回复生成与持久化的根因病灶：

```
                                  【 全链路病理机制全景图 】

      [用户发送 / 命令触发]
               │
      ┌────────┴───────────────────────────┐
      │                                    │
      ▼                                    ▼
[slashSendPreflight.ts]         [useRunStreamingAssistant.ts]
 (现场 1: /learn 伪造消息)      (现场 2: 预置空占位 assistant 消息)
  addMessage('已记录偏好')                 │
  ──► 写入 SQLite 永久落盘                  ▼
                                [streamSession.ts / bridge]
                                           │
                                ┌──────────┴──────────┐
                                │ 异常/断网           │ 正常流式
                                ▼                     ▼
                    [streamCallbacksEvents.ts]    [真实 Token 累积]
                     (现场 3: handleRunError)
                      st.setSessionMessageStatus(
                        'error', { errorDetail }
                      )
                                │
                                ▼
                    [MessageContent.tsx: 313]
                     (渲染 ErrorMessageBanner)
                     ──► 气泡内嵌红色/黄色错误块
                     ──► 随 SessionMessage 永久落盘
```

---

## 2.1 伪回复病理现场 1：`/learn` 命令强行伪造落盘 Assistant 消息

- **文件定位**：[`apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts:211-224`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L211-L224)
- **代码病理**：
  ```typescript
  // ❌ 错误代码：本地拦截后，强行伪造一个 assistant 消息塞入 sessionStore
  addMessage(wsId, learnSid, {
    id: generateMessageId('user'),
    sender: 'user',
    text: `/learn ${ruleText}`,
    timestamp: Date.now(),
    status: 'completed',
  });
  addMessage(wsId, learnSid, {
    id: generateMessageId('assistant'),
    sender: 'assistant',
    text: `已记录用户偏好：${ruleText}`, // 伪造的 AI 回复！
    timestamp: Date.now() + 1,
    status: 'completed',
  });
  ```
- **后果**：这条根本不是由模型生成的文本，被当成正式的助手回答持久化到了 SQLite `messages` 表中，污染了上下文与历史回放。

---

## 2.2 伪回复病理现场 2：流式预置占位残留与零 Token 崩溃悬空

- **文件定位**：[`apps/crish-desktop/src/hooks/chat-stream/useRunStreamingAssistant.ts:110-118`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/useRunStreamingAssistant.ts#L110-L118)
- **代码病理**：
  ```typescript
  // 启动流式前，提前在 store 中插入一条空 assistant 消息
  store.addMessage(wsId, sid, {
    id: assistantMsgId,
    sender: 'assistant',
    text: '',
    thinking: '正在处理…',
    timestamp: startTime,
    status: 'processing',
    toolCalls: [],
  });
  ```
- **后果**：当网络在 TCP 握手前直接抛错、或者 Provider 鉴权失败（401）时，如果回调中的 `withdrawMessage` 因为竞争条件未被执行，或者用户立刻切换了会话，导致这条带有 `thinking: '正在处理…'` 的空消息被永久留在会话中，成为幽灵消息。

---

## 2.3 伪回复病理现场 3：`ErrorMessageBanner` 侵入气泡并随 `errorDetail` 持久化

- **文件定位**：
  - 写入端：[`apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts:308-320`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts#L308-L320)
  - 渲染端：[`apps/crish-desktop/src/components/chat-message/MessageContent.tsx:43-57, 313-318, 380-383`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L43-L57)
- **代码病理**：
  ```tsx
  // MessageContent.tsx 中的渲染逻辑：
  const ErrorMessageBanner: React.FC<{ errorDetail?: SessionMessage['errorDetail'] }> = ({ errorDetail }) => (
    <div className={styles.errorBannerWrapper}>
      <div className={styles.errorBanner}>
        <AlertCircle size={13} className={styles.errorBannerIcon} />
        <span className={styles.errorBannerText}>
          {errorDetail?.message || '服务暂时不可用，请检查网络或后端配置'}
        </span>
      </div>
    </div>
  );
  // 在消息渲染末尾强行拼装错误横幅：
  {msg.status === 'error' && (
    <ErrorMessageBanner errorDetail={msg.errorDetail} />
  )}
  ```
- **后果**：
  1. 将系统级错误直接绘制在 Assistant 的消息气泡内部，破坏了助手气泡的纯洁性；
  2. `errorDetail` 字段被序列化进 `SessionMessage`，导致重新打开会话时历史气泡依然带着刺眼的红框错误。

---

## 2.4 伪回复病理现场 4：错误降级分支将网络错误作为 Token 流入 Assistant 正文

- **文件定位**：[`apps/crish-desktop/src/api/chat-bridge/streamSession.ts:240-244`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/streamSession.ts#L240-L244)
- **代码病理**：
  ```typescript
  logInternalError('stream-start', e);
  const msg = networkUserMessage(e);
  if (callbacks.onRunError) callbacks.onRunError(msg, 'network');
  else callbacks.onChunk(msg); // ❌ 极其危险的降级：直接把错误文本作为 chunk 喂给助手正文！
  finish();
  ```
- **后果**：一旦外部调用方未传 `onRunError`，错误文案就会被作为 AI 生成的内容逐字打在屏幕上并入库。

---

## 2.5 伪回复病理现场 5：多轨分发撕裂（Banner vs Toast vs Dock vs 气泡）

在当前代码库中，一个网络或模型错误到达前端后，会经历以下碎片化、互不协调的分发逻辑：

```
                                  【 现状多轨分发撕裂现状 】

  Engine Error
       │
       ▼
 [handleRunError]
       │
       ├──► 1. pushRunNotice(notice) ────────► [RunNoticeBar.tsx] (悬浮在 Composer 上沿)
       ├──► 2. toast.show(message) ──────────► [ToastStack.tsx] (屏幕右上角弹窗)
       ├──► 3. applyRetryNotice(...) ────────► [RetrySlotNotice.tsx] (老虎机滚动条)
       └──► 4. setSessionMessageStatus(error)► [ErrorMessageBanner.tsx] (消息气泡内红框)
```

- **痛点**：四轨并行导致同一错误在屏幕上四处开花，用户既被右上角 Toast 轰炸，又在输入框上方看到黄色横幅，还在消息气泡底部看到红色警告框。
- **裁决**：**彻底废弃多轨机制，全面收敛为消息流尾部的单一灰色进行时状态（Volatile Ephemeral Status）！**

---

# 三、 瞬态进行时错误态（Volatile Ephemeral Status）架构设计

为贯彻用户“主对话只留真实 AI 回答、错误仅作为临时进行时状态呈现、重试或发送新对话自动消失”的裁决，设计全新的**瞬态进行时状态架构**。

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        【 瞬态进行时错误态架构设计 (Pure Ephemeral Architecture) 】             │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                 │
│  [ChatMessageList / MessageVirtualizer]                                                        │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ 👤 User Message: "分析一下这个项目的架构缺陷"                                             │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ 🤖 Assistant Message: (纯净真实的 AI 输出，不包含任何红框、系统报错或伪造文本)             │  │
│  │    "我已经检查了当前项目的核心架构..."                                                    │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                                 │
│  ───────────────────────────────── 消息流底部边界 ───────────────────────────────────────────  │
│                                                                                                 │
│  【 EphemeralStatusSlot 】 (内存瞬态插槽 · 灰色进行时形态)                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │  ◉ 网络连接中断，请检查网络后重试 · 14:32:01                      [ ↻ 重试 ]    [ ✕ 关闭 ] │  │
│  │  └─ 柔和灰色字体 var(--text-tertiary) · 微妙呼吸灯动效 · 绝不落盘 · 发送新消息/重试自愈    │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                                 │
│  [ChatComposer] (输入区保持干净扁平，上方不再堆积乱七八糟的黄色横幅)                           │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ 发送新消息后，上方 EphemeralStatusSlot 立即原子清空消失...                                │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3.1 核心状态契约：`ephemeralChatStore` 独立状态机

创建专职的内存级 Zustand Store，统一管理所有会话的瞬态进行时状态：

```typescript
// apps/crish-desktop/src/store/ephemeralChatStore.ts
import { create } from 'zustand';

export type EphemeralErrorKind =
  | 'network'       // 网络中断 / DNS 解析失败 / 连接重置
  | 'rate_limit'    // 429 请求频率超限
  | 'auth'          // 401 / API Key 无效
  | 'quota'         // 额度耗尽
  | 'context_length'// 上下文超限
  | 'server_error'  // 5xx 服务端故障
  | 'stream_abort'  // 异常非正常中断
  | 'generic';      // 通用运行错误

export interface EphemeralChatStatus {
  id: string;                      // 错误指纹或唯一事件 ID
  sessionId: string;               // 绑定的会话 ID
  kind: EphemeralErrorKind;        // 错误语义分类
  message: string;                 // 用户可读的简洁提示文案
  technicalDetail?: string;        // 详细技术信息（供折叠或 Tooltip 查看）
  retryable: boolean;              // 是否可直接重试
  timestamp: number;               // 发生时刻（epoch ms）
  // 重试所需上下文（无需二次读取 DOM，原子发起重试）
  retryContext?: {
    userMsgId?: string;
    promptText?: string;
  };
}

interface EphemeralChatState {
  /** sessionId -> 当前会话的唯一瞬态状态（null 表示干净态） */
  statusBySession: Record<string, EphemeralChatStatus | null>;

  /** 设置/覆盖指定会话的瞬态状态（严格单例，新错误直接覆盖旧错误） */
  setEphemeralStatus: (sessionId: string, status: Omit<EphemeralChatStatus, 'sessionId'>) => void;

  /** 清空指定会话的瞬态状态（自愈动作） */
  clearEphemeralStatus: (sessionId: string) => void;

  /** 清空所有会话（应用重置或测试） */
  clearAll: () => void;
}

export const useEphemeralChatStore = create<EphemeralChatState>()((set) => ({
  statusBySession: {},

  setEphemeralStatus: (sessionId, status) => {
    if (!sessionId) return;
    set((state) => ({
      statusBySession: {
        ...state.statusBySession,
        [sessionId]: {
          ...status,
          sessionId,
        },
      },
    }));
  },

  clearEphemeralStatus: (sessionId) => {
    if (!sessionId) return;
    set((state) => {
      if (!state.statusBySession[sessionId]) return state;
      const next = { ...state.statusBySession };
      delete next[sessionId];
      return { statusBySession: next };
    });
  },

  clearAll: () => set({ statusBySession: {} }),
}));
```

---

## 3.2 零持久化绝对隔离原则（Zero-Persistence Guarantees）

为从根源上杜绝伪回复与错误状态落盘，必须在数据层建立 4 重零持久化安全铁律：

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                           【 零持久化 4 重刚性安全铁律 】                                       │
├────────────────────┬────────────────────────────────────────────────────────────────────────────┤
│ 1. 结构体物理拔除  │ 从 `SessionMessage` 中彻底废弃 `errorDetail` 字段；                         │
│                    │ 消息状态仅允许 `processing` -> `completed`（正常）或从 store 中撤回。      │
├────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ 2. SQLite 写入隔离 │ [`sessionRustDbWire.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionRustDbWire.ts) 与 [`sessionRustDbWriteGuard.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionRustDbWriteGuard.ts) 严禁包含任何错误字段序列化；     │
│                    │ `ephemeralChatStore` 属于纯内存 Store，绝不进入 Rust SQLite 写入队列。     │
├────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ 3. 会话导出纯洁性  │ [`sessionExport.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionExport.ts) 与 [`sessionExportSanitize.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionExportSanitize.ts) 在导出 JSON/Markdown 时，   │
│                    │ 仅导出纯净的对话历史，绝不夹带任何非 AI 伪状态。                           │
├────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ 4. 会话快照回滚    │ [`MessageSnapshots.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/MessageSnapshots.ts) 的历史版本栈中只记录真实消息变更，避免撤销重做   │
│                    │ 时把瞬态错误再次还原出来。                                                 │
└────────────────────┴────────────────────────────────────────────────────────────────────────────┘
```

---

## 3.3 底部流式插槽（`EphemeralStatusSlot`）视觉与交互规范

遵循 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13（输入框与焦点态）与 §14（色彩空间与现代 CSS）：

1. **排版与色彩**：
   - 字体：`var(--font-size-sm, 13px)`，颜色严格使用克制的 `var(--text-tertiary)`；
   - 背景：完全扁平透明，或仅使用极浅的 `color-mix(in srgb, var(--text-primary) 3%, transparent)`，严禁大面积深色背景或重阴影（`box-shadow: none`）；
   - 边框：无边框或柔软的发丝边框（`var(--hairline-width, 1px) solid var(--border-subtle)`）；
2. **进行时动效（Progressive Pulse）**：
   - 左侧配备直径 `5px` 的柔和呼吸指示点（对齐 [`TimelineThoughtSection.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css) 中的 `thoughtLiveDot` 规范）；
   - 网络异常时使用柔和琥珀灰/中性灰，不使用高饱和刺眼大红；
3. **按钮与交互控制**：
   - [重试] 按钮：采用 Ghost 按钮，高 `22px`，内边距 `0 8px`，圆角 `var(--radius-md, 6px)`，悬停时使用 `var(--tint-hover)`；
   - 焦点态：焦点轮廓对比度严格限制在 10% 以内，绝不出现深黑粗边框。

---

# 四、 自愈机制、去重状态机与生命周期时序

## 4.1 四大原子自愈场景（Self-Healing Triggers）

瞬态错误状态必须像云雾一样具备自动消散能力，在以下 4 类用户操作或系统事件中，必须**原子化触发 `clearEphemeralStatus`**：

```
                                  【 四大自愈事件流拓扑 】

  1. 用户在 Composer 发送新消息 ────────┐
                                        │
  2. 用户点击 [重试] 按钮 ───────────────┼──► [ clearEphemeralStatus(sessionId) ]
                                        │     └─► 底部插槽瞬间卸载，恢复纯净流
  3. 新的流式 Token / Thought 到达 ─────┤
                                        │
  4. 底层网络 Transport 恢复 connected ─┘
```

1. **场景 1：发送新对话**：
   - 触发点：[`useSlashSend.ts`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts) 中的 `handleSendChat` 与 `enqueueFollowUpMessage`；
   - 动作：在构建并提交 User Message 的同一同步微任务中，执行 `useEphemeralChatStore.getState().clearEphemeralStatus(sessionId)`；
2. **场景 2：点击重试**：
   - 触发点：`EphemeralStatusSlot` 的“重试”按钮或 [`useChatHandlers.ts:135`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/useChatHandlers.ts#L135) 的 `handleRegenerate`；
   - 动作：清空瞬态状态，并以 `retryContext` 中的参数无缝拉起 `runStreamingAssistant`；
3. **场景 3：流式数据到达**：
   - 触发点：[`streamCallbacksEvents.ts`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts) 收到第一个 `onChunk` 或 `onThought`；
   - 动作：自动调用 `clearEphemeralStatus(sessionId)`，确保生成过程中无冗余提示；
4. **场景 4：传输层重连成功**：
   - 触发点：`getTransport().onStatus('connected')`；
   - 动作：自动清空由于离线导致的 `kind === 'network'` 瞬态错误。

---

## 4.2 单例去重与窗口抑制算法（Deduplication Invariant）

为防止在网络抖动或密集重试时产生多个错误卡片堆叠：

```typescript
// 单例更新断言：
// 1. 同一 sessionId 在 store 中仅占有一个键槽位；
// 2. 新错误到达时，通过指纹对比决定是仅刷新时间戳还是替换文案；
// 3. 绝不使用数组或列表存储错误。

function deriveErrorFingerprint(raw: unknown, kind: string): string {
  const text = normalizeErrorText(raw).trim();
  return `${kind}:${text || 'unknown'}`;
}

export function dispatchEphemeralError(sessionId: string, raw: unknown, kind: EphemeralErrorKind) {
  const message = formatUserFriendlyErrorMessage(raw, kind);
  const fingerprint = deriveErrorFingerprint(raw, kind);
  
  useEphemeralChatStore.getState().setEphemeralStatus(sessionId, {
    id: fingerprint,
    kind,
    message,
    technicalDetail: extractTechnicalDetail(raw),
    retryable: isErrorRetryable(kind),
    timestamp: Date.now(),
  });
}
```

---

## 4.3 零 Token 失败干净撤回 vs 部分 Token 中断保留真迹

当流式会话发生中断或报错时，严格按照“**真实性原则**”进行分流处理：

```
                    【 流式中断 / 报错真实性分流判定 】

                              发生流式错误 / 中断
                                      │
                         是否有真实 AI Token / 工具产出？
                                      │
                      ┌───────────────┴───────────────┐
                      │ 否                            │ 是
                      ▼                               ▼
            【 零 Token 失败 】              【 部分 Token 中断 】
  1. 调用 `withdrawMessage` 移除占位；   1. 保留已输出的真实正文/工具；
  2. 会话历史中不留任何空白 Assistant 块； 2. 状态标记为 `completed`；
  3. 错误仅呈现于底部 Ephemeral 插槽。   3. 气泡内绝不添加任何错误标语；
                                         4. 错误仅呈现于底部 Ephemeral 插槽。
```

1. **零 Token 失败（Zero Token Failure）**：
   - 如果模型在输出任何实质 Token 前就已报错（例如鉴权失败、配置错误、网络立刻中断）；
   - 执行 `st.withdrawMessage(wsId, sid, assistantMsgId)` 与 `clearStream(sid, assistantMsgId)`；
   - **结果**：会话消息列表中只有用户的提问，下面紧接着底部的灰色进行时提示，绝无空白气泡；
2. **部分 Token 中断（Partial Stream Interruption）**：
   - 如果模型已经生成了 300 字内容或执行了 2 个工具，随后由于网络波动断开；
   - 调用 `commitStreamToSession` 将这 300 字真实内容以 `status: 'completed'` 固化入库（因为这是 AI 真实说出的话，是宝贵的交互资产）；
   - **绝对禁止**在气泡末尾追加“`[网络错误]`”或渲染 `ErrorMessageBanner`；
   - 在消息流最下方挂载 `EphemeralStatusSlot`（“生成已中断，网络连接超时 · [重试]”）。

---

# 五、 全链路代码改造详细实施蓝图

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               【 全链路改造模块映射矩阵 】                                      │
├───────────────────────────────┬─────────────────────────────────────────────────────────────────┤
│ 模块路径                      │ 改造职责                                                        │
├───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ `store/ephemeralChatStore.ts` │ [新增] 瞬态进行时状态管理，支持自愈、单例去重、非持久化         │
├───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ `components/chat-message-list/`│ [新增] 灰色进行时状态组件及其 CSS 模块，遵循现代设计 Token      │
│ `EphemeralStatusSlot.tsx`     │                                                                 │
├───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ `components/chat-message/`    │ [重构] 彻底物理删除 `ErrorMessageBanner` 及其关联引用           │
│ `MessageContent.tsx`          │                                                                 │
├───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ `hooks/chat-stream/`          │ [重构] 清退 `/learn` 的 fake assistant message，改为 Toast 提示 │
│ `slashSendPreflight.ts`       │                                                                 │
├───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ `hooks/chat-stream/`          │ [重构] 改造 `handleRunError`，错误只派发给 `ephemeralChatStore` │
│ `streamCallbacksEvents.ts`    │                                                                 │
├───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ `hooks/chat-stream/`          │ [重构] 发送消息、重试时原子执行 `clearEphemeralStatus`          │
│ `useSlashSend.ts`             │                                                                 │
├───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ `components/chat-message-list/`│ [重构] 在消息列表末尾装配 `EphemeralStatusSlot`                 │
│ `MessageVirtualizer.tsx`      │                                                                 │
├───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ `store/types.ts`              │ [清理] 废弃 `SessionMessage.errorDetail`，净化数据契约           │
└───────────────────────────────┴─────────────────────────────────────────────────────────────────┘
```

---

## 5.1 新建 `ephemeralChatStore.ts`

在 `apps/crish-desktop/src/store/ephemeralChatStore.ts` 中实现独立瞬态状态机（详见 3.1 节完整契约实现）。

---

## 5.2 新建 `EphemeralStatusSlot.tsx` 与 `.module.css`

### 组件实现
```tsx
// apps/crish-desktop/src/components/chat-message-list/EphemeralStatusSlot.tsx
import React, { useCallback } from 'react';
import styles from './EphemeralStatusSlot.module.css';
import { useEphemeralChatStore } from '../../store/ephemeralChatStore';
import { Button } from '../ui';
import * as Lucide from 'lucide-react';

export interface EphemeralStatusSlotProps {
  sessionId: string;
  onRetry?: (promptText?: string, userMsgId?: string) => void;
}

export const EphemeralStatusSlot: React.FC<EphemeralStatusSlotProps> = React.memo(
  ({ sessionId, onRetry }) => {
    const status = useEphemeralChatStore((s) => s.statusBySession[sessionId]);
    const clearStatus = useEphemeralChatStore((s) => s.clearEphemeralStatus);

    const handleDismiss = useCallback(() => {
      clearStatus(sessionId);
    }, [clearStatus, sessionId]);

    const handleRetryClick = useCallback(() => {
      if (!status) return;
      const ctx = status.retryContext;
      clearStatus(sessionId);
      onRetry?.(ctx?.promptText, ctx?.userMsgId);
    }, [clearStatus, onRetry, sessionId, status]);

    if (!status) return null;

    return (
      <div
        className={styles.ephemeralSlot}
        data-testid="ephemeral-status-slot"
        data-kind={status.kind}
        role="status"
        aria-live="polite"
      >
        <div className={styles.statusContent}>
          <span className={styles.liveDot} aria-hidden />
          <span className={styles.statusText}>{status.message}</span>
        </div>

        <div className={styles.actions}>
          {status.retryable && onRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.retryButton}
              onClick={handleRetryClick}
              icon={<Lucide.RotateCw size={12} aria-hidden />}
            >
              重试
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.dismissButton}
            onClick={handleDismiss}
            aria-label="关闭提示"
            icon={<Lucide.X size={12} aria-hidden />}
          />
        </div>
      </div>
    );
  }
);

EphemeralStatusSlot.displayName = 'EphemeralStatusSlot';
```

### 样式实现
```css
/* apps/crish-desktop/src/components/chat-message-list/EphemeralStatusSlot.module.css */

.ephemeralSlot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
  width: 100%;
  max-width: min(var(--chat-col-max, 760px), 100%);
  margin: var(--space-2, 8px) auto var(--space-4, 16px);
  padding: 6px 12px;
  box-sizing: border-box;
  background: color-mix(in srgb, var(--text-primary) 3.5%, transparent);
  border-radius: var(--radius-md, 8px);
  border: var(--hairline-width, 1px) solid var(--border-subtle, var(--border-color));
  box-shadow: none;
  font-family: inherit;
  animation: ephemeral-slot-fadein 180ms ease-out forwards;
}

@keyframes ephemeral-slot-fadein {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.statusContent {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}

.liveDot {
  width: 5px;
  height: 5px;
  min-width: 5px;
  min-height: 5px;
  border-radius: 50%;
  background: var(--text-tertiary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--text-tertiary) 20%, transparent);
  animation: ephemeral-dot-pulse 1.6s ease-in-out infinite;
  display: inline-block;
  flex-shrink: 0;
}

@keyframes ephemeral-dot-pulse {
  0%, 100% {
    transform: scale(0.9);
    opacity: 0.6;
  }
  50% {
    transform: scale(1.15);
    opacity: 1;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--text-tertiary) 30%, transparent);
  }
}

.statusText {
  font-size: var(--font-size-sm, 13px);
  line-height: 1.4;
  color: var(--text-tertiary);
  word-break: break-word;
  white-space: pre-wrap;
  user-select: text;
}

.actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.retryButton {
  height: 22px;
  padding: 0 8px;
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  border: none;
  transition: all var(--transition-fast, 120ms ease);
}

.retryButton:hover {
  color: var(--text-primary);
  background: var(--tint-hover);
}

.dismissButton {
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--text-tertiary);
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  border: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.dismissButton:hover {
  color: var(--text-primary);
  background: var(--tint-hover);
}
```

---

## 5.3 改造 `MessageContent.tsx`：彻底物理拔除 `ErrorMessageBanner`

- **文件定位**：[`apps/crish-desktop/src/components/chat-message/MessageContent.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx)
- **改造内容**：
  1. 彻底删除 `ErrorMessageBanner` 组件定义（第 43-57 行）；
  2. 删除 `TimelineBody` 与 `MessageContent` 主体内所有针对 `msg.status === 'error'` 挂载 `ErrorMessageBanner` 的逻辑；
  3. Assistant 消息仅渲染真实文本、思考块与工具调用，无论消息状态如何，正文气泡永远保持绝对纯洁！

---

## 5.4 改造 `slashSendPreflight.ts`：清退 `/learn` 伪造回复

- **文件定位**：[`apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts:211-224`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L211-L224)
- **改造内容**：
  ```typescript
  // 改造后：清退伪造的 addMessage(assistant)，通过轻量系统 Toast 提供即时反馈
  if (slash.kind === 'learn') {
    setChatInput('');
    setSlashMenuOpen(false);
    const ruleText = slash.rule;
    if (!ruleText) {
      showToast('用法：/learn <要记住的规则>');
      return { status: 'handled' };
    }
    try {
      const cwd = getWorkspacePath() || '__global__';
      const sets = await clientApi.getSettingsEx(cwd);
      const prev = Array.isArray(sets.customRules) ? sets.customRules : [];
      if (prev.includes(ruleText)) {
        showToast('该规则已存在');
        return { status: 'handled' };
      }
      const next = [...prev, ruleText];
      await clientApi.saveSettingsEx(cwd, 'global', { customRules: next });
      const { rulesLinesToText, syncRulesToDaemon } = await import('../../api/rulesApi');
      void syncRulesToDaemon({
        globalText: rulesLinesToText(next, '# 全局规则'),
      });
      // ✅ 仅弹出轻量 Toast 确认已记住，绝不在对话历史中伪造 AI 消息
      showToast(`已成功记住规则：${ruleText}`);
    } catch (e) {
      showToast(`记住规则失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return { status: 'handled' };
  }
  ```

---

## 5.5 改造 `streamCallbacksEvents.ts`：错误分发统一路由至瞬态 Store

- **文件定位**：[`apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts:226-332`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts#L226-L332)
- **改造内容**：
  ```typescript
  export function handleRunError(opts: HandleRunErrorOptions): { hadNetworkError: boolean } {
    const { sid, assistantMsgId, runId, message, kind, detail } = opts;
    
    // 1. 记录可观测性诊断日志
    recordStreamDiag({
      sessionId: sid,
      runId: runId || undefined,
      scope: kind || 'run-error',
      kind: kind || 'error',
      message,
      raw: detail || message,
    });

    const asstErr = buildMessageIndex(getSessionById(sid)).get(assistantMsgId);
    const hadRealText = Boolean((asstErr?.text || '').trim());
    const st = getCompositionRoot().session.getState();

    // 2. 真实性分流处理
    if (!hadRealText) {
      // 零 Token 失败：彻底撤回预置的空白 assistant 消息，不留幽灵占位
      st.withdrawMessage(opts.wsId, sid, assistantMsgId);
      clearStream(sid, assistantMsgId);
    } else {
      // 部分 Token 中断：保留真实生成的片段，标记完成，绝不附加 errorDetail
      st.setSessionMessageStatus(sid, assistantMsgId, 'completed');
    }

    // 3. 错误统一收敛为底部瞬态错误状态
    useEphemeralChatStore.getState().setEphemeralStatus(sid, {
      id: `${kind || 'error'}:${message}`,
      kind: mapKindToEphemeral(kind),
      message: message || '服务暂时不可用，请检查网络或模型配置',
      technicalDetail: typeof detail === 'string' ? detail : undefined,
      retryable: true,
      timestamp: Date.now(),
      retryContext: {
        userMsgId: opts.refs.streamManager?.get(sid)?.userMsgId,
      },
    });

    opts.flushStreamBatchers();
    opts.refs.renderBuffer?.flush(false);
    return { hadNetworkError: kind === 'network' };
  }
  ```

---

## 5.6 改造 `useSlashSend.ts` 与 `useChatHandlers.ts`：注入自愈钩子

在发送新消息与发起重试的关键动作中，直接注入原子清理逻辑：

1. **`useSlashSend.ts`**：
   ```typescript
   // 发送前清空瞬态错误
   useEphemeralChatStore.getState().clearEphemeralStatus(sessionId);
   ```
2. **`useChatHandlers.ts` (`handleRegenerate`)**：
   ```typescript
   // 重试前清空瞬态错误
   useEphemeralChatStore.getState().clearEphemeralStatus(activeSessionId);
   ```

---

## 5.7 改造 `ChatMessageList.tsx` / `MessageVirtualizer.tsx`：装配流式底部插槽

在 [`MessageVirtualizer.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx) 的 `.listInner` 底部（虚拟列表 items 与底部占位之后），挂载 `EphemeralStatusSlot`：

```tsx
// MessageVirtualizer.tsx
<div className={styles.listInner}>
  {/* 1. 顶部 Pinned 消息 */}
  {pinnedItems.length > 0 ? ( ... ) : null}

  {/* 2. 虚拟滚动消息列表 */}
  {messages.slice(startIndex, endIndex).map((msg, i) => ( ... ))}

  {/* 3. 底部填充占位 */}
  <div style={{ height: Math.max(0, estimatedTotalHeight - endOffset), flexShrink: 0 }} aria-hidden />

  {/* 4. 底部瞬态进行时错误插槽 (纯净流式接入) */}
  <EphemeralStatusSlot
    sessionId={activeSessionId}
    onRetry={(prompt, userMsgId) => {
      if (lastAssistantId && lastUserId) {
        handleRegenerateRow(prompt || '', lastAssistantId);
      }
    }}
  />
</div>
```

---

## 5.8 清理 `types.ts` 与数据持久化层：移出 `errorDetail`

- **`types.ts`**：废弃 `SessionMessage.errorDetail` 字段；
- **`sessionRustDbWire.ts`**：确保 Rust 传输管道只承载纯净消息；
- **`sessionHydration.ts`**：反序列化时过滤存量历史脏数据中的 `errorDetail`。

---

# 六、 五层立体验证模型与测试用例矩阵

遵循 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §7.1 立体验证纪律，构建 5 层全覆盖验证闭环：

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               【 五层立体验证模型与断言矩阵 】                                  │
├────────────────────┬────────────────────────────────────────────────────────────────────────────┤
│ 验证层次           │ 具体验收标准与刚性断言                                                     │
├────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ 第 1 层            │ 执行 `npm run typecheck` 与 `npm run build`，                              │
│ 静态类型与编译底线 │ 全仓 TypeScript 零编译报错，无隐式 `any`，无未捕获类型断裂。               │
├────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ 第 2 层            │ 编写专用单测 `ephemeralChatStore.test.ts` 与 `EphemeralStatusSlot.test.tsx`│
│ 核心纯逻辑与状态机 │ ① 验证单例覆盖：连续 push 3 次不同错误，Store 仅保留最后 1 个状态；        │
│                    │ ② 验证自愈性：触发 `clearEphemeralStatus` 后状态瞬间为 `null`；            │
│                    │ ③ 验证零持久化：写入状态后读取 `sessionStore` 与快照，无任何污染。         │
├────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ 第 3 层            │ 检查 SQLite 与 LocalStorage 持久化生成的 JSON/SQL 数据：                   │
│ 数据架构纯洁性守门 │ ① 数据库 `messages` 表中 100% 不含任何 `errorDetail` 或伪造文本；          │
│                    │ ② `/learn` 规则只写入配置，绝不产生伪造 Assistant 记录。                   │
├────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ 第 4 层            │ CSS 与 Design Token 合规性验证：                                           │
│ 视觉与交互规范合规 │ ① 字体颜色严格为 `var(--text-tertiary)`，字号 `13px`；                     │
│                    │ ② 无重阴影（`box-shadow: none`），焦点对比度严格 <10%；                    │
│                    │ ③ 呼吸灯动效平滑，零布局抖动（Zero Jitter）。                              │
├────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ 第 5 层            │ 在真实桌面 Tauri 环境下进行实机操作验收：                                  │
│ 真实环境现场验收   │ ① 断网发送：消息底部出现灰色进行时提示，气泡无红框；                       │
│                    │ ② 点击重试：错误提示立即消失，重新发起请求；                               │
│                    │ ③ 输入新问题并发送：错误提示自动瞬间清空，无任何历史残留。                 │
└────────────────────┴────────────────────────────────────────────────────────────────────────────┘
```
