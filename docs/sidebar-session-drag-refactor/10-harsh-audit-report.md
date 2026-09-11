# Conex / Crish 客户端近期落地改动端到端白盒苛刻审计报告
## Ruthless Chief Auditor Code Review & Defect Manifest

> **报告位置**：`docs/sidebar-session-drag-refactor/10-harsh-audit-report.md`
> **审计范围**：主对话非 AI 伪回复清退与瞬态错误态、侧栏所见即所得流式布局与重叠根治、拖拽消抖与跨域分屏/TabStrip 插排、Zero-Click 焦点转移与作用域隔离。
> **审计纪律**：零容忍、严禁客套与吹捧、只说缺陷与隐患、逐项提供代码位置 `文件路径:行号` 与物理逻辑证明。
> **审计日期**：2026-09-02

---

# 目录索引

- [一、 方案落实情况白盒全面盘点（方案承诺 vs 代码现实）](#一-方案落实情况白盒全面盘点方案承诺-vs-代码现实)
  - [1.1 欺骗性方案声明：数据层与持久化 `errorDetail` 清退完全未动](#11-欺骗性方案声明数据层与持久化-errordetail-清退完全未动)
  - [1.2 粗暴砍断错误分发表面，直接炸毁 9 项既有核心回归测试套件](#12-粗暴砍断错误分发表面直接炸毁-9-项既有核心回归测试套件)
  - [1.3 表面声明彻底清退多轨，实际遗留大量假状态与死代码（阳奉阴违）](#13-表面声明彻底清退多轨实际遗留大量假状态与死代码阳奉阴违)
- [二、 维度 1：主对话界面消息流纯洁性与瞬态错误态缺陷清单](#二-维度-1主对话界面消息流纯洁性与瞬态错误态缺陷清单)
  - [【BUG-M01】零 Token 失败导致重试按钮神隐或篡改历史消息（致命时序断裂）](#bug-m01零-token-失败导致重试按钮神隐或篡改历史消息致命时序断裂)
  - [【BUG-M02】存量数据库水合仍暗中篡改注入 Fake Assistant 消息（伪回复未根除）](#bug-m02存量数据库水合仍暗中篡改注入-fake-assistant-消息伪回复未根除)
  - [【BUG-M03】`ephemeralChatStore` 会话销毁时未脱钩，造成跨会话内存泄漏](#bug-m03ephemeralchatstore-会话销毁时未脱钩造成跨会话内存泄漏)
  - [【BUG-M04】`useSlashSend.ts` 主路径使用动态 `await import` 引入不必要的异步延迟](#bug-m04useslashsendts-主路径使用动态-await-import-引入不必要的异步延迟)
  - [【BUG-M05】`streamCallbacksEvents.ts` 强转 `as any` 破坏类型防线与死参数残留](#bug-m05streamcallbackseventsts-强转-as-any-破坏类型防线与死参数残留)
- [三、 维度 2：侧栏所见即所得流式布局与重叠几何缺陷清单](#三-维度-2侧栏所见即所得流式布局与重叠几何缺陷清单)
  - [【BUG-S01】项目文件夹展开/折叠导致 `listOffsetTop` 测量失效与滚动千像素剧烈跳变](#bug-s01项目文件夹展开折叠导致-listoffsettop-测量失效与滚动千像素剧烈跳变)
  - [【BUG-S02】`.accordionInner` 仍保留 `overflow: hidden` 与 GPU 合成图层（未彻底清退）](#bug-s02accordioninner-仍保留-overflow-hidden-与-gpu-合成图层未彻底清退)
  - [【BUG-S03】窗口化虚拟滚动极端速度下的白屏闪烁与切片脱水隐患](#bug-s03窗口化虚拟滚动极端速度下的白屏闪烁与切片脱水隐患)
- [四、 维度 3：拖拽与跨域分屏 / TabStrip 插排缺陷清单](#四-维度-3拖拽与跨域分屏--tabstrip-插排缺陷清单)
  - [【BUG-D01】跨 Leaf 拖拽到 TabStrip 无法搬移 Tab，落点提交沦为假动作（核心功能断裂）](#bug-d01跨-leaf-拖拽到-tabstrip-无法搬移-tab落点提交沦为假动作核心功能断裂)
  - [【BUG-D02】侧栏全新未打开会话分屏时 Tab 标题丢失，退化为 Raw SessionId 乱码](#bug-d02侧栏全新未打开会话分屏时-tab-标题丢失退化为-raw-sessionid-乱码)
  - [【BUG-D03】跨项目拖拽守门绕过 `canonicalSessionFolder`，导致历史常规会话被误锁死](#bug-d03跨项目拖拽守门绕过-canonicalsessionfolder导致历史常规会话被误锁死)
  - [【BUG-D04】TabStrip 水平让位离开时残余样式泄漏，导致顶栏 Tab 永久错位重叠](#bug-d04tabstrip-水平让位离开时残余样式泄漏导致顶栏-tab-永久错位重叠)
  - [【BUG-D05】`useSessionListDrag.ts` 存在裸 `any` 强转，违背类型安全铁律](#bug-d05usesessionlistdragts-存在裸-any-强转违背类型安全铁律)
- [五、 维度 4：代码质量、门禁合规与反过度设计审查](#五-维度-4代码质量门禁合规与反过度设计审查)
  - [【BUG-Q01】ESLint 门禁被直接击穿：`@deprecated` 缺少合法注释指令](#bug-q01eslint-门禁被直接击穿deprecated-缺少合法注释指令)
  - [【BUG-Q02】626 行上帝 Hook `useSessionListDrag` 违反职责单一化规范](#bug-q02626-行上帝-hook-usesessionlistdrag-违反职责单一化规范)
- [六、 修复决议与收敛路线图](#六-修复决议与收敛路线图)

---

# 一、 方案落实情况白盒全面盘点（方案承诺 vs 代码现实）

### 1.1 欺骗性方案声明：数据层与持久化 `errorDetail` 清退完全未动
- **方案承诺**（详案 `07-sub-agent-1-ephemeral-error-purification.md` §5.8）：
  > “5.8 清理 `types.ts` 与数据持久化层：移出 `errorDetail`：
  > - `types.ts`：废弃 `SessionMessage.errorDetail` 字段；
  > - `sessionRustDbWire.ts`：确保 Rust 传输管道只承载纯净消息；
  > - `sessionHydration.ts`：反序列化时过滤存量历史脏数据中的 `errorDetail`。”
- **实际代码现状**：
  - `apps/crish-desktop/src/store/types.ts:445`：
    ```typescript
    errorDetail?: {
      message: string;
      kind: string;
      technical?: string;
    };
    ```
    字段完全保留，**一行未删，也未加 `@deprecated`**！
  - `apps/crish-desktop/src/store/sessionMessageActionsTools.ts:155-156`：
    ```typescript
    if (opts?.errorDetail) {
      hit.message.errorDetail = opts.errorDetail;
    }
    ```
    仍然在将 `errorDetail` 写入消息实体！
  - 方案中声称修改的 `sessionRustDbWire.ts` 与 `sessionHydration.ts` 甚至在仓库中**根本不存在**（实际持久化文件名为 `sessionRustDbHydrate.ts` 与 `sessionHydrationMessages.ts`），说明该条目在方案编写和实施时完全凭空捏造，数据持久化层和水合层对 `errorDetail` 的清洗工作**完成度为 0%**！

---

### 1.2 粗暴砍断错误分发表面，直接炸毁 9 项既有核心回归测试套件
- **方案承诺与实现动作**：
  在 commit `abb2a8d0` 中，提交为了推行“瞬态错误态收敛”，直接把 `apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts:280-305` 中的多表面错误派发机制（`pushRunNotice` 横幅、`toast.show` 等）整体强行删除。
- **严重恶果（严重违反 AGENTS.md §1、§7、§9）**：
  运行 `npm test`，直接引发 **9 个关键回归测试报错暴毙**！
  1. `apps/crish-desktop/src/components/chat-message/MessageContent.test.tsx`（4 个测试全崩）：
     - `当 msg.status === "error" 且 timeline 为空时渲染错误提示卡片` ❌
     - `当 msg.status === "error" 且 timeline.length > 0（包含思考链）时，依然渲染错误卡片，严禁吞噬错误` ❌
     - `当 msg.status === "error" 且 timeline 为空但存在前置 partial 正文时，同时展示正文与错误卡片` ❌
     - `当 msg.status === "error" 且 errorDetail 缺省时，展示默认兜底文案，绝不白屏吞噬` ❌
  2. `apps/crish-desktop/src/hooks/chat-stream/useChatStream.test.ts`（5 个端到端测试全崩）：
     - `network 且无正文：仅持久条，不弹 toast，withdraw 占位` ❌
     - `network 有正文：不写气泡错误卡、不 withdraw（保留正文）` ❌
     - `有正文失败（非 network 非可行动）：仅气泡错误卡，不弹横幅、不弹 toast` ❌
     - `无正文失败（非 network 非可行动）：仅横幅，无 toast，withdraw 占位` ❌
     - `可行动错误（blocked）：横幅 + 一次性 toast` ❌
- **审计裁决**：
  前序 Agent 在未跑通单元测试门禁的情况下强行推入代码，将上层既有守卫性契约撕裂，严重破坏了测试资产完整性。

---

### 1.3 表面声明彻底清退多轨，实际遗留大量假状态与死代码（阳奉阴违）
- **代码位置**：`apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts:189-191`
- **代码实证**：
  ```typescript
  const [activeDragItem, setActiveDragItem] = useState<SidebarDragItem | null>(null);
  const [dragOverPinned] = useState(false);
  const [dropIndicator] = useState<DropIndicator | null>(null);
  const [dragPreview] = useState<SessionDragPreview | null>(null);
  ```
- **病理分析**：
  - `dragOverPinned` 永远是 `false`，根本没有 `setDragOverPinned`；
  - `dropIndicator` 永远是 `null`，根本没有 `setDropIndicator`；
  - `dragPreview` 永远是 `null`，根本没有 `setDragPreview`；
  - 这些假状态依然被作为 hook 返回值暴露给外部组件（`useSidebarSessionList.tsx:64`），导致：
    - `PinnedSection.tsx:71` 的 `${dragOverPinned ? styles.dragOver : ''}` 高亮永远无法触发；
    - `useSidebarSessionList.tsx:290` 计算的 `dropIndicatorPlace` 永远为 `null`，侧栏行间的拖拽蓝线/占位指示器完全失去功能；
    - 外部的 `dragPreview` 预览渲染分支彻底沦为死代码。

---

# 二、 维度 1：主对话界面消息流纯洁性与瞬态错误态缺陷清单

### 【BUG-M01】零 Token 失败导致重试按钮神隐或篡改历史消息（致命时序断裂）
- **影响等级**：CRITICAL（严重阻断核心功能）
- **确凿代码位置**：
  - `apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts:286-291`
  - `apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx:308-314`
  - `apps/crish-desktop/src/components/chat-message-list/useChatMessageState.ts:217-238`
- **物理与时序证明**：
  1. 用户发送消息后，因断网或后端未配置导致 0-token 报错（`hadText === false`）；
  2. `streamCallbacksEvents.ts:288` 执行：
     ```typescript
     st.withdrawMessage(wsId, sid, assistantMsgId);
     clearStream(sid, assistantMsgId);
     ```
     当前轮生成的 assistant 占位消息被**彻底从会话消息列表中撤销删除**；
  3. `streamCallbacksEvents.ts:297` 向 `ephemeralChatStore` 写入了 `retryable: true` 的瞬态错误态；
  4. 随后视图层 `MessageVirtualizer.tsx:308` 尝试装配 `EphemeralStatusSlot` 的 `onRetry` 属性：
     ```tsx
     <EphemeralStatusSlot
       sessionId={activeSessionId}
       onRetry={
         lastAssistantId
           ? () => { handleRegenerateRow(lastAssistantId); }
           : undefined
       }
     />
     ```
  5. **致命裂痕**：
     - **分支 A（新会话第 1 轮失败）**：此时会话中只有一条用户消息，`lastAssistantId` 为 `undefined`。导致 `onRetry` 为 `undefined`！在 `EphemeralStatusSlot.tsx:48` 中，`{status.retryable && onRetry && ...}` 由于 `onRetry` 为空，**根本不渲染“重试”按钮！用户完全无法重试！**
     - **分支 B（第 2 轮或后续轮次失败）**：由于当前轮的 assistant 消息已被 withdraw，`messages` 中最新的一条 assistant 消息是**上一轮历史正常对话的 assistant 消息**！
     - 此时用户在流底部点击“重试”本轮错误，`handleRegenerateRow(lastAssistantId)` 传入的是**上一轮**的 assistantId！`handleRegenerateRow` 往上寻找上一轮的 user 消息，**居然重新生成并覆盖了上一轮的历史对话！本轮提问彻底被跳过并摧毁！**

---

### 【BUG-M02】存量数据库水合仍暗中篡改注入 Fake Assistant 消息（伪回复未根除）
- **影响等级**：HIGH（违反会话流纯洁性架构铁律）
- **确凿代码位置**：`apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts:168-174`
- **代码实证**：
  ```typescript
  if (m.status === 'processing') {
    const sanitizedText = m.text && m.text.trim()
      ? m.text
      : m.sender === 'assistant'
        ? '（上次回复未完成）'
        : undefined;
    next = {
      ...next,
      status: 'completed',
      ...(sanitizedText !== undefined ? { text: sanitizedText } : {}),
    };
  }
  ```
- **物理机制证明**：
  - 当客户端在生成过程中遭遇崩溃、强制关闭或系统断电，重启加载历史会话时，水合层发现上一轮状态为 `processing` 且无文本；
  - **水合层竟然硬编码将 `text` 赋值为 `'（上次回复未完成）'`，并标记为 `status: 'completed'` 永久存回数据库！**
  - 用户打开会话时，气泡中清晰出现非 AI 生成的伪回复。该处死角在本次改动中完全被忽视，并未纳入 `ephemeralChatStore` 体系。

---

### 【BUG-M03】`ephemeralChatStore` 会话销毁时未脱钩，造成跨会话内存泄漏
- **影响等级**：MEDIUM
- **确凿代码位置**：`apps/crish-desktop/src/store/SessionCoordinator.ts:24-45`
- **物理机制证明**：
  - `SessionCoordinator.deleteSessionCascade` 是负责整个生命周期会话清理的总线，它依次清理了 `sessionStore`、`streamingStore`、`messageSnapshots`、`terminalStore`；
  - **唯独没有调用 `useEphemeralChatStore.getState().clearEphemeralStatus(id)`**！
  - 当用户在侧栏删除某个含有报错状态的会话后，该会话在 `useEphemeralChatStore.statusBySession` 中的条目永久无法释放；在长时间运行或频繁创建/删除临时会话时，产生内存孤儿条目。

---

### 【BUG-M04】`useSlashSend.ts` 主路径使用动态 `await import` 引入不必要的异步延迟
- **影响等级**：LOW（代码异味与时序破绽）
- **确凿代码位置**：`apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts:109-110`
- **代码实证**：
  ```typescript
  // 原子清空该会话的瞬态错误进行时提示（发送新对话自动自愈）
  const { useEphemeralChatStore } = await import('../../store/ephemeralChatStore');
  useEphemeralChatStore.getState().clearEphemeralStatus(sessionId);
  ```
- **物理机制证明**：
  - `ephemeralChatStore` 仅是一个极轻量的 Zustand 内存 store，没有任何循环依赖，全仓均使用静态 `import`；
  - 在用户敲击回车的高频实时通信关键路径上插入动态 `await import`，强行引入了一次微任务事件循环延迟（Microtask tick），且若前置 preflight 中断，此清理逻辑根本不会被执行。

---

### 【BUG-M05】`streamCallbacksEvents.ts` 强转 `as any` 破坏类型防线与死参数残留
- **影响等级**：LOW
- **确凿代码位置**：
  - `apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts:256`
  - `apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts:301`
- **代码实证**：
  ```typescript
  // 第 256 行：pushRunNotice 被解构但全函数体内未被任何一行代码使用
  const { ..., pushRunNotice, ... } = opts;

  // 第 301 行：将泛 string 强转为 any，逃避与 EphemeralErrorKind 的类型对齐
  kind: (kind as any) || 'generic',
  ```
- **物理机制证明**：
  违反 `AGENTS.md` §7 严禁绕过类型检查与代码洁净度规范，`pushRunNotice` 沦为未使用的死变量。

---

# 三、 维度 2：侧栏所见即所得流式布局与重叠几何缺陷清单

### 【BUG-S01】项目文件夹展开/折叠导致 `listOffsetTop` 测量失效与滚动千像素剧烈跳变
- **影响等级**：HIGH（严重的布局与滚动几何 Bug）
- **确凿代码位置**：
  - `apps/crish-desktop/src/components/sidebar/session-list/useSessionListWindow.ts:58-88`
  - `apps/crish-desktop/src/api/sessionListWindow.ts:429-439`
- **物理机制证明**：
  1. `useSessionListWindow` 使用 `ResizeObserver` 分别观察 `scrollEl` 和 `generalListRef`（即常规列表 `<ul>`）；
  2. 当用户在侧栏中点击展开或折叠某个包含数十条会话的项目文件夹时，`ProjectsSection` 瞬间撑开或坍缩几百像素；
  3. 位于 `ProjectsSection` 下方的 `GeneralSection`（常规列表）在文档流中被物理向下或向上推移了几百像素；
  4. **根据 W3C 规范，`ResizeObserver` 只监听元素的 `contentRect` / `borderBox` 大小变化，元素在父容器中的偏移位置（`offsetTop`）改变绝对不会触发 `ResizeObserver` 回调！**
  5. 此时 `useSessionListWindow` 内部记录的 `listOffsetTop` 依然停留在**折叠前的陈旧数值**；
  6. 当用户开始滚动常规列表时，`computeSessionListWindow` 传入了过期的 `listOffsetTop`，根据公式 `relativeScroll = Math.max(0, scrollTop - listOffsetTop)`，计算出的相对滚动量发生数百像素的巨大偏差，直接导致切片 `start / end` 发生跨度错乱，页面中的 `topPad` 突然剧烈伸缩，**侧栏列表发生剧烈上下抖动与像素跳跃（Jitter & Jump）**！

---

### 【BUG-S02】`.accordionInner` 仍保留 `overflow: hidden` 与 GPU 合成图层（未彻底清退）
- **影响等级**：MEDIUM（违背 WYSIWYG 零裁剪核心宪法）
- **确凿代码位置**：`apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css:31-37`
- **代码实证**：
  ```css
  .accordionInner {
    overflow: hidden;
    min-height: 0;
    contain: layout paint;
    transform: translateZ(0);
    -webkit-transform: translateZ(0);
  }
  ```
- **物理机制证明**：
  - 详案《08-sub-agent-2-sidebar-layout-expansion.md》§2.2 明确分析了 `overflow: hidden` 与 `contain: layout paint` 强制开启独立 GPU 渲染层所导致的几何重排与文字重叠问题；
  - 然而在落地的 CSS 代码中，该规则依然被保留在 `.accordionInner` 上，并非真正的自然文档流。当有子元素渲染阴影或超出边框时，依然会被强制裁剪。

---

### 【BUG-S03】窗口化虚拟滚动极端速度下的白屏闪烁与切片脱水隐患
- **影响等级**：MEDIUM
- **确凿代码位置**：`apps/crish-desktop/src/components/sidebar/session-list/WindowedSessionUl.tsx:57-71`
- **物理机制证明**：
  - `WindowedSessionUl` 依赖单一的 `safe.topPad` 和 `safe.bottomPad`（空的 `<li>` 标签）维持滚动高度；
  - 在 Windows 平台的 WebView2 容器内，当用户以极快速度用鼠标直接拖拽滚动条滑块（Thumb）时，合成器滚动已到底部，但 React `setRange` 事件由于主线程任务排队无法在当帧执行（可能有 1–2 帧延迟）；
  - 视口内挂载的 DOM 节点依然是旧切片，在新的滚动位置下完全处于视口之外，用户会看到连续多帧的**完全空白与白屏闪烁**。

---

# 四、 维度 3：拖拽与跨域分屏 / TabStrip 插排缺陷清单

### 【BUG-D01】跨 Leaf 拖拽到 TabStrip 无法搬移 Tab，落点提交沦为假动作（核心功能断裂）
- **影响等级**：CRITICAL（跨域 TabStrip 插排核心功能瘫痪）
- **确凿代码位置**：
  - `apps/crish-desktop/src/components/shell/sessionTabDropCommit.ts:67-73`
  - `apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts:153-165`
  - `apps/crish-desktop/src/store/workspace-shell/treeSessionCommands.ts:147-155`
- **物理机制证明**：
  1. 场景：用户开启了左右双分屏（左侧 Leaf 1，右侧 Leaf 2）。会话 S 已经在 Leaf 1 打开；
  2. 用户从侧栏拖拽会话 S 到右侧 Leaf 2 的 TabStrip，TabStrip 触发水平让位动画，为它让出了第 0 个位置；
  3. 用户在 Leaf 2 的 TabStrip 释放鼠标；
  4. `commitSidebarSessionDrop` 执行：
     ```typescript
     shell.openOrFocusSession(sessionId, {
       activeLeafId: target.targetLeafId, // Leaf 2
       insertIdx: target.insertIdx, // 0
     });
     ```
  5. 内部进入 `treeSessionCommands.ts:147-155`：
     ```typescript
     const existing = treeFindTabBySessionId(sessionId);
     if (existing) {
       treeActivateTab(existing.leafId, existing.tab.tabId);
       return { leafId: existing.leafId, tabId: existing.tab.tabId, created: false };
     }
     ```
  6. **惊天逻辑缺陷**：
     - 代码发现会话 S 在左侧 Leaf 1 已经存在，**竟然直接调用 `treeActivateTab(existing.leafId)` 把左侧 Leaf 1 的 Tab 激活了**！
     - 传过去的 `target.targetLeafId`（Leaf 2）和 `target.insertIdx`（位置 0）**被直接丢进垃圾桶，彻底无视**！
     - **右侧分屏的 TabStrip 根本没有添加该 Tab！它没有被搬移，也没有被插入！**
     - 用户眼睁睁看着右侧顶栏腾出空位，松开鼠标后右侧却什么都没有发生，焦点反而跑回了左侧窗口！这是一个完全未接通的“假闭环”！

---

### 【BUG-D02】侧栏全新未打开会话分屏时 Tab 标题丢失，退化为 Raw SessionId 乱码
- **影响等级**：HIGH（严重的用户体验与数据降级）
- **确凿代码位置**：`apps/crish-desktop/src/store/layout-tree/layoutTreeInsert.ts:309-321`
- **代码实证**：
  ```typescript
  // layoutTreeInsert.ts: 309
  const newTab = createSessionTab({
    tabId: generateNodeId('tab'),
    sessionId,
  });
  ```
- **物理机制证明**：
  - 当侧栏中一个之前从未在树上打开过的会话（如“分析性能瓶颈”）被直接拖拽到屏幕边缘进行分屏时；
  - `splitSessionFromSidebar` 调用 `createSessionTab` 时**只传了 `{ tabId, sessionId }`，根本没有传入 `title` 和 `workspaceKey`**；
  - 查看 `sessionTabModel.ts:150`：
    ```typescript
    const title = titleRaw || (isDraftSessionId(sessionId) ? '新对话' : raw) || '新对话';
    ```
  - 因为 `titleRaw` 为空，它直接退化为 `raw`（即 `sessionId`，例如 `'sess_mtjolzlb-aa2f2fe0'`）；
  - 同时 `workspaceKey` 退化为全局默认值 `'对话'`；
  - **用户拖拽分屏成功后，新建的分屏窗口顶栏 Tab 标题显示的不是会话名字，而是一串毫无意义的十六进制 Session ID 乱码！**

---

### 【BUG-D03】跨项目拖拽守门绕过 `canonicalSessionFolder`，导致历史常规会话被误锁死
- **影响等级**：HIGH
- **确凿代码位置**：`apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts:205-206, 367, 593`
- **代码实证**：
  ```typescript
  // useSessionListDrag.ts: 205-206
  const originFolder = (folderName && folderName.trim()) || GENERAL_FOLDER;
  const isProjectSession = originFolder !== GENERAL_FOLDER && originFolder !== '';

  // useSessionListDrag.ts: 367
  if (isProjectSession && !isPinnedTarget && targetFolderName !== originFolder) {
    clearAllShifts();
    if (ghostEl) ghostEl.style.opacity = '0.35';
    currentInsertSessionId = null;
    return;
  }
  ```
- **物理机制证明**：
  - 在 Conex 系统的权威规范中，常规会话的 folder 可能历史兼容 `'会话'`、`'常规会话'` 或 `'general'`（见 `projectStore.ts:301` `canonicalSessionFolder`）；
  - `useSessionListDrag.ts` 闭门造车，**没有调用 `canonicalSessionFolder`**；
  - 当用户拖拽历史常规会话（其 folder 为 `'常规会话'`）时，第 206 行判定：`'常规会话' !== GENERAL_FOLDER`，得出 `isProjectSession = true`！
  - 系统竟然把用户的常规对话当成了项目专有对话！
  - 当用户在常规对话列表内部重新排序或拖拽时，`targetFolderName` 是 `GENERAL_FOLDER`，第 367 行判定 `targetFolderName !== originFolder`，**直接将拖拽动作判定为非法并硬性阻断**！用户完全无法重新排序历史常规会话！

---

### 【BUG-D04】TabStrip 水平让位离开时残余样式泄漏，导致顶栏 Tab 永久错位重叠
- **影响等级**：MEDIUM
- **确凿代码位置**：`apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts:352-378`
- **物理机制证明**：
  1. 用户将侧栏会话拖入顶栏 TabStrip，`target.domain === 'tab-strip'` 触发，所有 Tab 被注入了 inline style `transform: translateX(120px)`；
  2. 随后用户将光标向左下移回侧栏，但鼠标停留在侧栏顶部的空白区域（即 `activeContainer === null`）；
  3. 代码执行第 352 行 `else if (target.domain === 'sidebar')`，但因为未命中任何 container，直接跳过了 shift 清理逻辑；
  4. 如果此时用户按下 Escape 键取消拖拽或直接将鼠标移出窗口释放，**TabStrip 中所有标签的 `translateX(120px)` 依然残留在 DOM 上**，顶栏所有 Tab 保持着被推开的异常间距，造成严重的界面错位残留！

---

### 【BUG-D05】`useSessionListDrag.ts` 存在裸 `any` 强转，违背类型安全铁律
- **影响等级**：LOW
- **确凿代码位置**：`apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts:254`
- **代码实证**：
  ```typescript
  const showPaneIndicator = (rect: { left: number; top: number; width: number; height: number }, region: any) => {
  ```
- **物理机制证明**：
  `region: any` 隐式绕过了 `PaneDropRegion` 联合类型检查，违背了 `AGENTS.md` §1“无隐式 any，无未捕获类型断裂”的强制红线。

---

# 五、 维度 4：代码质量、门禁合规与反过度设计审查

### 【BUG-Q01】ESLint 门禁被直接击穿：`@deprecated` 缺少合法注释指令
- **影响等级**：MEDIUM（阻断 CI 流水线）
- **确凿代码位置**：`apps/crish-desktop/src/store/workspace-shell/types.ts:8:1`
- **代码实证**：
  ```typescript
  /** @deprecated 树上只有 chat 叶；维 07 删除 */
  export type TabKind = 'conversation' | 'tool';
  ```
- **物理机制证明**：
  运行 `npm run lint`，报告致命错误：
  `error: @deprecated 注释必须包含 @see 或 @removeWhen 以指明替代路径或删除条件 local/deprecated-requires-reference`。
  违反仓库强约束门禁。

---

### 【BUG-Q02】626 行上帝 Hook `useSessionListDrag` 违反职责单一化规范
- **影响等级**：LOW
- **确凿代码位置**：`apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts`（全长 626 行）
- **物理机制证明**：
  违反 `AGENTS.md` §11“CI 治理与解耦断言：业务逻辑限约 400 行”的规定。该文件在单次重构中堆积了大量低级 DOM 操作、Ghost 创建、Indicator 管理、1D 几何投影、事件监听等，内聚严重失衡，已成为潜在的维护债务黑洞。

---

# 六、 修复决议与收敛路线图

针对上述揪出的所有缺陷，必须按以下严密时序进行架构修正与收敛：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   【 缺陷修复与收敛路线图 】                                     │
├─────────────────────┬────────────────────────────────────────────────────────────────────────────┤
│ 1. 主对话与重试修复 │ ① 修复 MessageVirtualizer: onRetry 不能仅依赖 lastAssistantId，必须从       │
│    (Priority 1)     │    ephemeralChatStore.retryContext.userMsgId 读取失败的用户提问并重新触发；  │
│                     │ ② 清理 sessionHydrationMessages.ts: 删除强制写入'（上次回复未完成）'的伪文本；│
│                     │ ③ 修复 SessionCoordinator: 级联删除会话时同步清除 ephemeralChatStore 条目；   │
│                     │ ④ 修复 useChatStream.test.ts 与 MessageContent.test.tsx 9 项断裂单测。    │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ 2. 拖拽与分屏闭环   │ ① 修复 commitSidebarSessionDrop: 当会话已存在时，正确调用 tree.moveTab 将  │
│    (Priority 2)     │    Tab 物理搬迁到 targetLeafId 的 insertIdx 位置，杜绝假动作；            │
│                     │ ② 修复 splitSessionFromSidebar: 创建 newTab 时完整注入 realTitle 与 wkKey；│
│                     │ ③ 修复 useSessionListDrag: 接入 canonicalSessionFolder，消灭历史会话误锁；│
│                     │ ④ 彻底移除 useSessionListDrag 中的 dragOverPinned 等死 useState 假状态。   │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ 3. 侧栏流式与滚动   │ ① 修复 useSessionListWindow: 增加对 ProjectsSection 折叠/展开状态的监听， │
│    (Priority 3)     │    在容器尺寸改变时强制同步测量 listOffsetTop，根除滚动千像素跳跃；       │
│                     │ ② 清理 .accordionInner 中残留的 overflow: hidden 与 contain: layout paint。│
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ 4. 门禁与代码洁净度 │ ① 修复 types.ts 中的 @deprecated 注释格式，跑通 npm run lint；             │
│    (Priority 4)     │ ② 消除 useSessionListDrag.ts 中的 region: any 强转。                      │
└─────────────────────┴────────────────────────────────────────────────────────────────────────────┘
```
