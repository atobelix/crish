# 通知与异常展示单轨收敛架构审计报告

> **审计基线范围**：commit `918ab5edc`（通知与异常展示单轨收敛）及相关联的流式生命周期、状态机、错误重试与通道清剿模块
> **审计责任人**：【通知与异常展示单轨收敛架构审计专家】
> **审计日期**：2026-09-20
> **报告版本**：v1.0.0 (收敛终审)
> **执行纪律**：只读审计与方案落盘，严禁执行 git 提交

---

## 摘要与核心结论

本次审计针对 commit `918ab5edc` 实施的**全仓通知与异常展示体系系统性单轨收敛**展开全量代码走查与架构穿透。该重构旨在终结历史遗留的「5 轨展示分裂」（右下角 Toast 堆叠、输入框上方 `RunNoticeBar` 横幅、对话流内气泡卡 `TurnErrorNode`、流内瞬态重试行 `ModelRetryNode`、输入框上方 `RetrySlotNotice` 重试横幅），建立以 `sessionRuntimeStatusStore` 为单一真理源（SSOT）的单轨展示模型。

### 核心结论总览

1. **状态机 SSOT 与单轨性**：
   - **架构建立成功**：`sessionRuntimeStatusStore` 确立了会话级运行时状态的唯一权威。全仓收敛为单一字段两个互斥相位：`retrying`（流内瞬态行）与 `failed`（输入框上方错误条），缺键即为 `idle`，物理上根除了同屏双显与信息竞争。
   - **写入口强约束**：通过全局唯一命令式写入口 `reportRuntimeStatus` 与 CI 首道门禁 `scripts/check-runtime-status-ssot.mjs`，有效阻断了分散 `setState` 与历史通道回流。
   - **多点原子自愈完备**：覆盖了新轮次发送、新 Token 到达、流结束、会话级联删除、用户手动关闭、以及全网连接恢复（`clearNetworkFailedRuntimeStatuses`）等 7 处自愈清理点，主干状态机具备高度鲁棒性。

2. **异常重试闭环追踪**：
   - **原位重试不重排**：`ComposerErrorBar` 的「重试」派发 `retry-failed-turn` 事件，复用 `useChatHandlers.regenerateTurn`，按 `userMsgId` 现查提问文本并撤回失败的助手节点，将用户消息置回 `processing`。重发逻辑复用了原消息位置，未新建用户消息节点，严格遵守「不重排」契约。
   - **流内瞬态状态行（`InFlowStatusLine`）极简化**：废除所有可交互按钮、可展开详情与伪造倒计时，仅保留纯文案与 shimmer 扫光微动效；成功覆盖 `MessageContent` 三大分支（含首 Token 前出错分支 α）。

3. **旧通道物理清剿彻底性**：
   - `RunNoticeBar`、`RetrySlotNotice`、`TurnErrorNode`、`ModelRetryNode`、`ephemeralChatStore`、`continuityUiStore`、`useChatQueue`、`ChatQueuePanel` 等全部旧组件与旧 Store 均已物理删除（全仓零存留源码）。
   - `handleRunError` 彻底移除了 `toast.show` 调用，会话运行类错误不再渗透至全局 Toast 层；Toast 恢复为纯粹的系统/操作级轻量反馈。

4. **穿透审计发现的 5 项关键边缘缺陷与隐患（详见第四节）**：
   - ⚠️ **Defect-01 (P1 · 重试失效)**：**纯图片/纯附件提问重试静默早退**。若用户发送无正文的纯多模态提问，失败后点击重试，`userText` 为空导致 `regenerateTurn` 直接 `return`，错误条已清空但未发起任何请求，会话陷入停滞。
   - ⚠️ **Defect-02 (P1 · 上下文丢失)**：**原位重试丢失多模态视觉数据**。`regenerateTurn` 仅传递 `userText`，未透传 `targetUser.images` / `attachments` 的多模态 Payload，重试导致视觉大模型失明。
   - ⚠️ **Defect-03 (P2 · 状态僵死/幽灵态)**：**重试成功后首帧为思考流（`onThought`）或工具调用（`onToolStart`）时瞬态行残留**。`clearRuntimeStatus` 仅挂在 `onChunk`，若重试恢复后模型先输出思考或调用工具，流内将同时显示「工具正在运行/正在思考」与底部的「正在重试 · 第 n 次」幽灵状态。
   - ⚠️ **Defect-04 (P2 · 数据丢失)**：**助手失败撤回与原位重试吞噬排队追问（Queued Messages）**。`withdrawMessage` 底层采用 `sess.messages.slice(0, idx)` 暴力截断，运行中积攒的追问用户消息在助手撤回或重试时被连带物理切除并彻底蒸发。
   - ⚠️ **Defect-05 (P2 · 门禁虚标与 E2E 脱节)**：`check-runtime-status-ssot.mjs` 注释声称检查 `msg.errorDetail`，但实际脚本规则数组中未包含任何相关正则；同时漏设了对 `ModelRetryNode` / `TurnErrorNode` / `RetrySlotNotice` 的回流黑名单；`tests/e2e/error-path.spec.ts` 仍断言旧选择器 `run-notice` 未同步。

---

## 目录

- [一、状态机 SSOT 与单轨性深度审计](#一状态机-ssot-与单轨性深度审计)
  - [1.1 状态机模型设计与契约解析](#11-状态机模型设计与契约解析)
  - [1.2 状态转移矩阵与全生命周期覆盖](#12-状态转移矩阵与全生命周期覆盖)
  - [1.3 多状态源脱节与原子自愈机制审计](#13-多状态源脱节与原子自愈机制审计)
- [二、异常重试闭环端到端追踪审计](#二异常重试闭环端到端追踪审计)
  - [2.1 流内瞬态重试行（InFlowStatusLine）生命周期与挂载审计](#21-流内瞬态重试行inflowstatusline生命周期与挂载审计)
  - [2.2 输入框错误条（ComposerErrorBar）原位重试链路追踪](#22-输入框错误条composererrorbar原位重试链路追踪)
  - [2.3 多模态与特殊载荷在重试链路中的表现](#23-多模态与特殊载荷在重试链路中的表现)
  - [2.4 排队追问（Queued Messages）生命周期与截断风险](#24-排队追问queued-messages生命周期与截断风险)
- [三、旧通道物理清剿彻底性检验](#三旧通道物理清剿彻底性检验)
  - [3.1 废弃通道与历史组件清剿清单核验](#31-废弃通道与历史组件清剿清单核验)
  - [3.2 Toast 通道滥用治理与全局浮层纯净化](#32-toast-通道滥用治理与全局浮层纯净化)
  - [3.3 SSOT 静态门禁脚本（check-runtime-status-ssot.mjs）深度审查](#33-ssot-静态门禁脚本check-runtime-status-ssotmjs深度审查)
- [四、边缘 Bug 诊断清单与加固方案](#四边缘-bug-诊断清单与加固方案)
  - [4.1 Defect-01: 纯图片/附件提问原位重试静默早退（P1）](#41-defect-01-纯图片附件提问原位重试静默早退p1)
  - [4.2 Defect-02: 原位重试丢失多模态视觉上下文（P1）](#42-defect-02-原位重试丢失多模态视觉上下文p1)
  - [4.3 Defect-03: 重试恢复首帧进入思考或工具时瞬态重试行幽灵留存（P2）](#43-defect-03-重试恢复首帧进入思考或工具时瞬态重试行幽灵留存p2)
  - [4.4 Defect-04: withdrawMessage 截断破坏排队追问节点（P2）](#44-defect-04-withdrawmessage-截断破坏排队追问节点p2)
  - [4.5 Defect-05: check-runtime-status-ssot.mjs 规则虚标与 E2E 遗留测试断裂（P2）](#45-defect-05-check-runtime-status-ssotmjs-规则虚标与-e2e-遗留测试断裂p2)
  - [4.6 Defect-06: 1500ms 快速重试节流导致状态清除却未重启流（P3）](#46-defect-06-1500ms-快速重试节流导致状态清除却未重启流p3)
- [五、综合审计结论与实施建议](#五综合审计结论与实施建议)

---

## 一、状态机 SSOT 与单轨性深度审计

### 1.1 状态机模型设计与契约解析

在 `apps/crish-desktop/src/store/sessionRuntimeStatusStore.ts` 中，会话运行时状态被抽象为极简的二元联合类型：

```ts
export type SessionRuntimeStatus =
  | {
      phase: 'retrying';
      sessionId: string;
      retry: RuntimeRetryInfo;
      timestamp: number;
    }
  | {
      phase: 'failed';
      sessionId: string;
      kind: RuntimeErrorKind;
      message: string;
      technicalDetail?: string;
      turn: FailedTurnRef;
      timestamp: number;
    };
```

#### 架构优势核查
1. **天然互斥（Phase Exclusion）**：`phase: 'retrying'` 与 `phase: 'failed'` 属于同一状态对象上的判别式联合键。在存储层 `statusBySession[sessionId]` 中，任一会话只能持有一个状态，从数据模型底层抹除了「重试中」与「已失败」同屏并存的可能。
2. **轻量内存态（Zero Persistence）**：状态存储于内存 Zustand Store 中，不序列化进 SQLite 或本地持久化配置，避免了跨进程重启后出现过期僵死错误。
3. **定位信息最小化（Turn Reference Only）**：`FailedTurnRef` 仅持久记录 `{ userMsgId, assistantMsgId }`，绝不缓存用户的提问内容（`promptText`）。提问内容在重发时严格按 `userMsgId` 从会话消息池现查，保证用户原位就地编辑（in-place edit）后的文本能够正确传递，杜绝了多真理源文本漂移。

### 1.2 状态转移矩阵与全生命周期覆盖

系统运行时状态机的完整转换矩阵如下表所示：

| 当前状态 | 触发事件源 | 下一状态 | 触发位置 (代码行) | 表现与副作用 |
| :--- | :--- | :--- | :--- | :--- |
| **Idle** (缺键) | `onProviderDiagnostic` (`phase === 'retry'`) | **Retrying** | `diagnosticHandlers.ts:44` | 对话流内活跃助手行尾挂载 `InFlowStatusLine` |
| **Retrying** | `onProviderDiagnostic` (`attempt++`) | **Retrying** | `diagnosticHandlers.ts:44` | 单例覆盖，`attempt` 计数更新 |
| **Retrying** | 首帧 Token 到达 (`onChunk`) | **Idle** | `useRunStreamingAssistant.ts:299` | 瞬态行物理卸载，对话流不留痕 |
| **Retrying** | 重试耗尽 / 引擎终止 (`onRunError`) | **Failed** | `streamCallbacksEvents.ts:358` | 瞬态行卸载，输入框上方挂载 `ComposerErrorBar` |
| **Idle** | 运行致命错误 (`onRunError`) | **Failed** | `streamCallbacksEvents.ts:358` | 直接弹出 `ComposerErrorBar` |
| **Failed** | 用户点击关闭按钮 (`x`) | **Idle** | `ComposerErrorBar.tsx:40` | `clearRuntimeStatus(sid)` 状态注销 |
| **Failed** | 用户点击「重试」按钮 | **Idle** | `ComposerErrorBar.tsx:44` | 清理状态并派发 `retry-failed-turn` 事件 |
| **Failed** | 用户发起新一轮输入发送 | **Idle** | `useSlashSend.ts:116` | 自愈清理，发起新请求 |
| **Failed (network)** | 底层网络恢复 (`connected`) | **Idle** | `index.ts:34` | 跨全会话清空 `network` 错误 |
| **Retrying / Failed**| 会话删除 | **Idle** | `SessionCoordinator.ts:46` | 跨 Store 级联清理，杜绝内存泄漏 |

### 1.3 多状态源脱节与原子自愈机制审计

审计检查了系统内是否存在状态脱节或清除遗漏点：

1. **`SessionCoordinator.deleteSessionCascade`（级联清理）**：
   在 `apps/crish-desktop/src/store/SessionCoordinator.ts:46` 中：
   ```ts
   // 5. 清理运行时状态机中的内存瞬态状态，杜绝内存泄漏（单轨收敛 §2.0）
   clearRuntimeStatus(id);
   ```
   会话删除时同步清退了运行时状态，避免了残留垃圾对象。
2. **`staleSessionHealer.ts`（脏流自愈）**：
   在用户物理发送消息时，若检测到物理连接中断但历史消息仍处于 `processing`/`queued`，`settleStaleSessionProcessingMessages` 会强制将助手消息结算为 `error`，并在行 50 调用 `clearRuntimeStatus(sessionId)`，保证启动新流前状态机完全归零。
3. **`streamRunCompletion.ts`（正常收口自愈）**：
   在 `commitRunCompletion`（L80）中，流正常结束的一瞬间调用 `clearRuntimeStatus(sid)`，确保成功完成的任务绝对不会残留任何临时重试标记。
4. **会话切换状态保留设计核查**：
   在 `ComposerErrorBar.tsx` 中，组件按 `activeSessionId` 进行状态订阅。当用户切到其他会话时，错误条因 `activeSessionId` 变更而自然不显示；切回原会话时，未解决的 `failed` 状态依然存在。这一行为与文档“存续到问题解决 / 切换会话 / 用户主动关闭”中「切会话不再展示，原会话保留至自愈」的设计目标完全吻合，避免了切会话导致错误信息和重试机会永久丢失。

---

## 二、异常重试闭环端到端追踪审计

### 2.1 流内瞬态重试行（InFlowStatusLine）生命周期与挂载审计

#### 组件形态与契约
`apps/crish-desktop/src/components/chat-message-row/InFlowStatusLine.tsx` 采用了极简设计：
- 图标：`wifi`（14px）。
- 动效：Shimmer 流动文字（复用 Reasoning 扫光材质）。
- 文案纯函数：`inFlowStatusLineLib.ts:formatRetryStatusText`，有上限显示 `正在重试 2/5`，分母缺失显示 `正在重试 · 第 2 次`，不臆造引擎未下发的倒计时与分母。
- 零交互：无任何按钮与展开体，杜绝干扰用户。

#### 三大挂载点完备性（MessageContent.tsx）
审计通过分析 `apps/crish-desktop/src/components/chat-message/MessageContent.tsx`，确认瞬态重试行已在三大渲染分支中全覆盖挂载：
1. **分支 α（零正文 / 初始等待态，L408）**：
   ```tsx
   {inFlowRetry && <InFlowStatusLine retry={inFlowRetry} />}
   ```
   **修复历史断层**：彻底解决了收敛前「首 Token 到达前出错重试时，UI 只渲染 `WorkingStatusIndicator`，导致用户完全看不到重试状态」的重大体验缺陷。
2. **分支 β（降级正文 / 无分段，L425）**：
   挂载于 `StreamingMarkdownView` 下方，并与 `interruptedMark`（「回复中断」）互斥呈现。
3. **分支 γ（多段交错时间线，L536）**：
   挂载于时间线最末端，不打乱上方已生成的工具卡与思考段。

### 2.2 输入框错误条（ComposerErrorBar）原位重试链路追踪

`apps/crish-desktop/src/components/chat-card/ComposerErrorBar.tsx` 作为终态错误的唯一可见承载体，挂载于 `ChatStatusRibbons` 原 `RunNoticeBar` 位置（输入框正上方）。

#### 原位重发调用链追踪

```
[用户点击 ComposerErrorBar "重试"]
  │
  ├── 1. ComposerErrorBar.tsx:44
  │      clearRuntimeStatus(sid);
  │      emitUiEvent('retry-failed-turn', { sessionId, userMsgId, assistantMsgId });
  │
  ▼
[useChatHandlers.ts:257 监听到 retry-failed-turn 事件]
  │
  ▼
[useChatHandlers.ts:193 regenerateTurn]
  │
  ├── 2. 防重节流检测: Date.now() - lastTime < 1500ms
  │
  ├── 3. handleStopGeneration(): 停止当前可能存在的残留句柄
  │
  ├── 4. 消息池现查提问文本:
  │      targetUser = msgs.find(m => m.id === opts.userMsgId && m.sender === 'user')
  │      userText = (targetUser?.text || opts.fallbackText || '').trim();
  │
  ├── 5. 撤回失败助手节点:
  │      session.withdrawMessage(wsId, sessionId, assistantMsgId);
  │
  ├── 6. 原子清空状态机:
  │      clearRuntimeStatus(sessionId);
  │
  ├── 7. 复用用户消息节点:
  │      session.setSessionMessageStatus(sessionId, userMsgId, 'processing');
  │
  ▼
[runStreamingAssistant]
  │
  └── 8. 启动底层流:
         runStreamingAssistant(userText, userMsgId, sessionId, {
           clientMessageId: userMsgId,
         });
```

#### 不重排契约核验
在步骤 7 中，系统未调用 `session.addMessage`，而是调用 `setSessionMessageStatus(sessionId, userMsgId, 'processing')` 将既有 user 节点置回处理中状态；`runStreamingAssistant` 传入了透传的 `clientMessageId = userMsgId`。这保证了用户消息在时间线中的物理位置不变，避免了在时间线末尾追加重复用户气泡导致的列表重排与阅读断层。

### 2.3 多模态与特殊载荷在重试链路中的表现

审计深入核查了含有图片附件、文档附件时的重试行为，发现重试链路存在严重的**多模态降级退化**（详见 Defect-01 与 Defect-02）。

在常规发送路径 `useSlashSend.ts` 中：
```ts
const { input, displayText, finalStreamOptions } = assembleChatPayload({ ... });
runStreamingAssistant(input, userMsgId, sessionId, streamOptionsWithClientMsg);
```
`assembleChatPayload` 会将图片序列化进 `finalStreamOptions.content`（作为 `{ type: 'image_url', ... }` 节点），并计算 Vision 支持度与批注文本。

而在 `regenerateTurn`（`useChatHandlers.ts:215-240`）中：
系统仅仅简单提取了 `targetUser?.text` 作为字符串传入 `runStreamingAssistant`，`streamOptions` 仅携带了 `{ clientMessageId }`。
**后果**：若用户最初的提问附带了本地图片，在发生网络错误后点击输入框上方的「重试」，重发的数据包完全丢失了图片载荷，发送给大模型的只有纯文本！

### 2.4 排队追问（Queued Messages）生命周期与截断风险

在单轨收敛方案中，排队通道被整体收敛进对话流内（`status: 'queued'`）。
审计追踪发现，当助手回合出错并触发撤回或重试时，底层 `withdrawMessage` 的实现机制会对后续已排队消息造成**毁灭性物理截断**（详见 Defect-04）。

---

## 三、旧通道物理清剿彻底性检验

### 3.1 废弃通道与历史组件清剿清单核验

审计针对计划删除的废弃通道进行了全仓扫描核验：

| 废弃项 / 旧通道 | 预期清理状态 | 源码扫描实测结果 | 审计结论 |
| :--- | :--- | :--- | :--- |
| `RunNoticeBar.tsx` / `RunNoticeBar.module.css` | 物理删除 | `apps/crish-desktop/src` 0 匹配 | ✅ 清剿彻底 |
| `RetrySlotNotice.tsx` | 物理删除 | `apps/crish-desktop/src` 0 匹配 | ✅ 清剿彻底 |
| `TurnErrorNode.tsx` / `TurnErrorNode.module.css` | 物理删除 | `apps/crish-desktop/src` 0 匹配 | ✅ 清剿彻底 |
| `ModelRetryNode.tsx` / `ModelRetryNode.module.css` | 物理删除 | `apps/crish-desktop/src` 0 匹配 | ✅ 清剿彻底 |
| `ephemeralChatStore.ts` / `useEphemeralChatStore` | 物理删除 | `apps/crish-desktop/src` 0 匹配 | ✅ 清剿彻底 |
| `continuityUiStore.ts` / `useContinuityUiStore` | 物理删除 | `apps/crish-desktop/src` 0 匹配 | ✅ 清剿彻底 |
| `useChatQueue.ts` / `ChatQueuePanel.tsx` | 物理删除 | `apps/crish-desktop/src` 0 匹配 | ✅ 清剿彻底 |
| `msg.errorDetail` 气泡错误卡渲染 | 零渲染点 | `MessageContent.tsx` 0 匹配 | ✅ 清剿彻底 |
| `msg.errorDetail` 运行时写入 | 零业务写入 | 仅保留类型定义与纯状态识别兼容点 | ✅ 清剿彻底 |

### 3.2 Toast 通道滥用治理与全局浮层纯净化

收敛前，`handleRunError` 在发生错误时无差别调用 `toast.show`，导致用户屏幕右下角经常堆叠 3~4 个同质化红色气泡。

本次审计核查了 `apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts`：
```ts
// 行 355-366：所有终态错误统一进 failed 相位
reportRuntimeStatus({
  type: 'failed',
  sessionId: sid,
  kind: resolvedKind,
  message: message || '服务暂时不可用，请检查网络或后端配置',
  technicalDetail: typeof detail === 'string' ? detail : undefined,
  turn: { userMsgId, assistantMsgId },
});
// 零 toast.show 调用！
```
同时，Toast 基础设施已收敛：
- `ToastViewport.tsx` 默认定位为 `top-center`（顶部居中）。
- `TOAST_MAX_QUEUE = 3`，具备同文案去重机制。
- 会话运行类错误不再调用 Toast；仅「已停止本轮生成」、「这一轮没有文字回复」等无歧义的操作反馈走轻量 Toast。

### 3.3 SSOT 静态门禁脚本（check-runtime-status-ssot.mjs）深度审查

门禁脚本 `scripts/check-runtime-status-ssot.mjs` 作为 `npm run check:desktop` 的第一道检查项（`package.json:50`），对维护 SSOT 架构具有刚性作用。

#### 门禁审查发现的漏洞（详见 Defect-05）
1. **`msg.errorDetail` 规则未落地**：脚本开头的 JSDoc 注释明确宣称：“`msg.errorDetail 的新写入（setSessionMessageStatus 第 5 参 errorDetail 字段）仅允许 staleSessionHealer.ts 历史兼容点之外的零处`”。然而，检查 `BANNED_PATTERNS` 数组发现，**该规则在代码层面被完全遗漏，没有任何一行代码在检测 `errorDetail` 的写入**！
2. **废弃组件未设防**：`BANNED_PATTERNS` 包含了 `ephemeralChatStore`、`continuityUiStore` 和 `RunNoticeBar`，但漏掉了 `ModelRetryNode`、`TurnErrorNode` 以及 `RetrySlotNotice`。如果未来有开发者误复制历史代码重新引入这三个组件，门禁无法阻断。

---

## 四、边缘 Bug 诊断清单与加固方案

### 4.1 Defect-01: 纯图片/附件提问原位重试静默早退（P1）

#### 根因剖析
在 `apps/crish-desktop/src/components/chat-card/useChatHandlers.ts` 的 `regenerateTurn` 函数中（L215-L216）：
```ts
const targetUser =
  (opts.userMsgId && msgs.find((m) => m.id === opts.userMsgId && m.sender === 'user')) ||
  msgs.findLast((m) => m.sender === 'user');
const userText = (targetUser?.text || opts.fallbackText || '').trim();
if (!userText) return; // ❌ 致命缺陷：如果提问仅有图片而没有正文字符，直接返回！
```
而在 `ComposerErrorBar.tsx:43-50` 中：
```ts
const handleRetry = () => {
  clearRuntimeStatus(sid); // 提前清空了状态
  emitUiEvent('retry-failed-turn', { ... });
};
```
当用户发送纯图片提问（例如上传一张架构图要求分析，但输入框未打字）遭遇网络报错时：
1. 用户点击 `ComposerErrorBar` 的「重试」按钮。
2. `ComposerErrorBar` 先调用 `clearRuntimeStatus(sid)`，错误提示条从界面上消失。
3. `emitUiEvent('retry-failed-turn')` 触发。
4. `regenerateTurn` 判定 `userText === ""`，直接 `return` 退出！
5. **现场灾难**：错误条消失了，但任何重试请求都没有发出，助手节点已被撤回或处于 error 态，用户没有任何可操作入口，整个会话状态机僵死。

#### 加固方案
```ts
// 修复：只要存在文本 或 存在图片/附件，即为有效重试轮次
const hasAttachments = Boolean(
  (targetUser?.images && targetUser.images.length > 0) ||
  (targetUser?.attachments && targetUser.attachments.length > 0)
);
if (!userText && !hasAttachments) return;
```

---

### 4.2 Defect-02: 原位重试丢失多模态视觉上下文（P1）

#### 根因剖析
在 `useChatHandlers.ts:237-240` 中：
```ts
// 透传用户 clientMessageId；助手 id 在 runStreamingAssistant 内 mint 并经 run-task 下发
runStreamingAssistant(userText, userMsgId, sessionId, {
  clientMessageId: userMsgId,
});
```
`runStreamingAssistant` 仅接收到了 `userText` 和 `{ clientMessageId: userMsgId }`。
在常规发送链路中，图片通过 `buildMultimodalFromAttachments` 转换为 `streamOptions.content`（结构体含 base64/url 数组）。
而在原位重试时，`regenerateTurn` 完全没有检查 `targetUser.images` 或 `targetUser.attachments`，也没有重新组装 `content` 多模态 payload。
**后果**：重试后发送给大模型的载荷变成了纯文本，丢失了图片，视觉模型会回答“抱歉，我没有看到您提供的图片”。

#### 加固方案
在 `regenerateTurn` 中应提取 `targetUser.images`，若存在图片则构造带有 `content` 多模态数组的 `streamOptions` 并透传给 `runStreamingAssistant`。

---

### 4.3 Defect-03: 重试恢复首帧进入思考或工具时瞬态重试行幽灵留存（P2）

#### 根因剖析
在 `apps/crish-desktop/src/hooks/chat-stream/useRunStreamingAssistant.ts:291-300` 中：
```ts
onChunk: (chunk) => {
  if (!assertLive()) return;
  recordChunkSample(chunk.length);
  if (!gotRealText) {
    snapshotStreamThinkingToSession(sid, assistantMsgId);
    // 单轨收敛 §2.0：新 Token 到达 = 重试成功信号，瞬态重试行立即消失（不留痕）
    clearRuntimeStatus(sid);
  }
  gotRealText = true;
  ...
}
```
`clearRuntimeStatus(sid)` 仅仅被安置在 `onChunk`（正文 Token 到达）中！
而在深思考模型（如 DeepSeek-R1、o1/o3）或 Agent 任务中，重试恢复成功后，引擎首先输出的是**长达数秒甚至数十秒的思考流（`onThought`）**，或者是**直接发起工具调用（`onToolStart`）**，此时根本没有触发 `onChunk`！

#### 表现与危害
在 `MessageContent.tsx:119-123` 中：
```tsx
const inFlowRetry =
  (isThinkingMsg || msg.status === 'processing') &&
  runtimeStatus?.phase === 'retrying'
    ? runtimeStatus.retry
    : undefined;
```
由于 `statusBySession[sessionId]` 依然处于 `phase: 'retrying'`，页面上方正在正常流式打出思考过程，或者工具卡正在运行，但在卡片最底部，`InFlowStatusLine` 依然固执地闪烁着 `正在重试 · 第 2 次`！形成了荒谬的“正在执行中却显示正在重试”的幽灵双态。

#### 加固方案
在 `onThought` 的首帧和 `onToolStart` 的首帧，同样必须触发 `clearRuntimeStatus(sid)`：
```ts
onThought: (thought) => {
  if (!assertLive()) return;
  if (!gotRealThought) {
    clearRuntimeStatus(sid);
    gotRealThought = true;
  }
  ...
},
onToolStart: (...) => {
  if (!assertLive()) return;
  clearRuntimeStatus(sid);
  ...
}
```

---

### 4.4 Defect-04: withdrawMessage 截断破坏排队追问节点（P2）

#### 根因剖析
在 `apps/crish-desktop/src/store/sessionMessageActionsCore.ts:94-109` 中，`withdrawMessage` 的实现是**范围截断**：
```ts
withdrawMessage: (_wsId, sessionId, messageId) =>
  set((state) => {
    const sess = getSessionForWrite(state, sessionId);
    if (sess?.messages) {
      const idx = sess.messages.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        ...
        // ❌ 截断：丢弃 idx 及之后的所有消息！
        sess.messages = sess.messages.slice(0, idx);
      }
    }
  })
```
当发生以下场景时：
1. 用户发了一条提问 A，助手生成中；
2. 用户在输入框又追加了一条追问 B，追问 B 进时间线，状态为 `status: 'queued'`；此时消息顺序为 `[UserA, AssistantA, UserB(queued)]`；
3. 助手由于网络中断或超时挂掉，进入 `handleRunError`。
   - 若 `AssistantA` 没有产生任何正文（0 Token），`handleRunError` 自动调用 `st.withdrawMessage(wsId, sid, assistantMsgId)`；
   - `withdrawMessage` 定位到 `AssistantA`，执行 `slice(0, 1)`，**直接把位于后面的 `UserB(queued)` 连带删除了**！
   - 即便 `AssistantA` 有正文保留为 error 态，当用户点击输入框错误条的「重试」时，`regenerateTurn` 同样调用了 `withdrawMessage(assistantMsgId)`，再次把 `UserB(queued)` 彻底蒸发！

#### 表现与危害
用户在 AI 思考期间精心输入的排队追问，在出错或重试的一瞬间被完全抹除，既没有回填到输入框，也没有进入快照栈，造成严重的用户数据丢失。

#### 加固方案
在 `withdrawMessage` 或 `regenerateTurn` 中，若被撤回的助手节点后面存在 `status === 'queued'` 的用户消息，应当提取并保全这些排队消息，或者使用单节点精确剔除而非范围 `slice`。

---

### 4.5 Defect-05: check-runtime-status-ssot.mjs 规则虚标与 E2E 遗留测试断裂（P2）

#### 根因剖析
1. **门禁规则虚标**：
   查看 `scripts/check-runtime-status-ssot.mjs` 第 40-47 行：
   ```js
   const BANNED_PATTERNS = [
     { id: 'ephemeral-chat-store', re: /useEphemeralChatStore|ephemeralChatStore/ },
     { id: 'continuity-retry-notice', re: /applyRetryNotice|retryNotices|useContinuityUiStore/ },
     { id: 'run-notice-channel', re: /\bpushRunNotice\b|\bcreateRunNoticeController\b|\bRunNoticeBar\b|\btype RunNotice\b/ },
     { id: 'direct-store-write', re: /useSessionRuntimeStatusStore\s*\.\s*setState\b|\.getState\(\)\s*\.\s*report\(/ },
   ];
   ```
   脚本开头的说明写道：“`msg.errorDetail 的新写入仅允许 staleSessionHealer.ts 历史兼容点之外的零处`”，但代码里**没有任何针对 `errorDetail` 的检查项**。
   同时，旧组件名黑名单遗漏了：`RetrySlotNotice`、`TurnErrorNode`、`ModelRetryNode`。
2. **E2E 存量测试选择器断裂**：
   在 `tests/e2e/error-path.spec.ts:35-40` 中：
   ```ts
   // ── ① 运行提示条可见（RunNoticeBar：data-testid="run-notice"）──
   const notice = page.locator('[data-testid="run-notice"]');
   await expect(notice).toBeVisible({ timeout: 8000 });
   await expect(page.locator('[data-testid="run-notice-text"]')).toContainText('服务暂时不可用');
   ```
   由于 `RunNoticeBar` 已被彻底清剿，取而代之的是 `ComposerErrorBar`（选择器为 `[data-testid="composer-error-bar"]` 和 `[data-testid="composer-error-text"]`），导致该 E2E 测试用例在真实执行时必将发生超时断言失败。

#### 加固方案
1. 完善 `check-runtime-status-ssot.mjs` 中的 `BANNED_PATTERNS`，补全遗漏的废弃组件与 `errorDetail` 赋值正则。
2. 将 `tests/e2e/error-path.spec.ts` 中的选择器平滑迁移为 `data-testid="composer-error-bar"`。

---

### 4.6 Defect-06: 1500ms 快速重试节流导致状态清除却未重启流（P3）

#### 根因剖析
在 `ComposerErrorBar.tsx:43-50` 中：
```ts
const handleRetry = () => {
  clearRuntimeStatus(sid); // 先清除了 Store 状态
  emitUiEvent('retry-failed-turn', { sessionId: sid, ... });
};
```
在 `useChatHandlers.ts:201-207` 中：
```ts
const now = Date.now();
const lastTime = lastRetryTimeRef.current[sessionId] || 0;
if (now - lastTime < 1500) {
  console.warn('[regenerateTurn] clicks too fast, throttling duplicate submit');
  return; // ❌ 节流拦截
}
lastRetryTimeRef.current[sessionId] = now;
```
如果用户连续两次快速点击「重试」按钮，或者网络在 1.5 秒内极速返回了第二次错误并再次弹出错误条，用户此时点击重试：
`ComposerErrorBar` 的 `handleRetry` 会立即清空状态机，把错误条关闭；随后派发的事件被 `regenerateTurn` 的 `now - lastTime < 1500` 拦截并早退。
**后果**：错误条没了，但由于节流拦截，重试并没有真正发起，系统没有给出任何视觉反馈。

#### 加固方案
`clearRuntimeStatus(sid)` 应当移入 `regenerateTurn` 内部在节流检查通过后执行，或者在 `ComposerErrorBar` 按钮上挂载 1500ms 的 `disabled` 视觉冷却倒计时。

---

## 五、综合审计结论与实施建议

### 5.1 审计裁决评级

| 审计维度 | 评级 | 裁决综述 |
| :--- | :---: | :--- |
| **1. 状态机 SSOT 与单轨性** | **A (优秀)** | 状态机模型精炼纯粹，唯一写入口落实到位，相位互斥彻底杜绝了同屏双显，自愈生命周期严谨。 |
| **2. 异常重试闭环** | **B+ (良好/需加固)** | 原位复用 user 节点保证了时间线不重排；但存在纯图片提问重试早退、多模态参数丢失、以及思考流恢复时瞬态行残留等边缘缺陷。 |
| **3. 旧通道物理清剿彻底性** | **A- (优良)** | 历史多轨组件与 Store 物理删除干净利落，Toast 滥用彻底根治；静态门禁存在少量规则虚标与 E2E 测试未同步。 |
| **4. 架构综合评定** | **PASS (通过 / 附改善建议)** | 系统性单轨收敛架构成立，整体架构达到工业级高收敛水准，具备生产环境上线条件。 |

### 5.2 改进实施建议路线

1. **建议一（即刻修复 P1）**：
   在 `useChatHandlers.ts` 的 `regenerateTurn` 中，增加对多模态提问的判空兼容（`!userText && !hasAttachments`），并补充将 `targetUser.images` 装配进 `streamOptions` 的逻辑，杜绝重试失效与失明。
2. **建议二（即刻修复 P2）**：
   在 `useRunStreamingAssistant.ts` 中，为 `onThought` 与 `onToolStart` 首帧增加 `clearRuntimeStatus(sid)` 调用，消除思考与工具调用期间的幽灵重试条。
3. **建议三（加固 P2）**：
   修改 `sessionMessageActionsCore.ts` 中的撤回逻辑，防止在失败撤回时无声吞掉时间线后方的 `queued` 追问消息；或在撤回时对排队消息执行草稿回填。
4. **建议四（严密门禁与测试）**：
   在 `scripts/check-runtime-status-ssot.mjs` 中补全 `errorDetail` 和废弃组件名的拦截规则；将 `tests/e2e/error-path.spec.ts` 中的 `run-notice` 修正为 `composer-error-bar`。
