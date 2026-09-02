# Conex / Crish 客户端 15 项真实缺陷白盒闭环复审验收报告
## White-box Verification & Closure Audit Manifest

> **报告文件**：`docs/sidebar-session-drag-refactor/11-audit-closure-verification.md`  
> **复审对象**：《极度苛刻白盒审计报告》（`docs/sidebar-session-drag-refactor/10-harsh-audit-report.md`）揪出的全部 15 项真实缺陷  
> **审计官角色**：最高级别白盒复审审计官（Chief Verification & Closure Auditor）  
> **审计纪律**：零容忍、不讲客套、逐行核对 `文件路径:行号`、以自动化门禁与真实代码物理表现为唯一依据。  
> **复审日期**：2026-09-02  

---

# 一、 复审裁决摘要（Executive Verdict）

本次端到端白盒复审对 15 项缺陷逐行检索源码、运行全套类型检查及针对性单元测试：

- **完全闭环根治项**：**12 项**（核心逻辑断裂、样式泄漏、类型漏洞、内存泄漏已彻底根除）
- **部分闭环 / 伴生瑕疵项**：**3 项**（业务逻辑已修，但单测断言未同步更新或假状态死代码未清退）
- **门禁合规性（CI 阻断）**：`npm run typecheck` 全绿通过；但 `check:line-counts` 中 `useSessionListDrag.ts` 超标（524 行，上限 500 行），且存在 2 处未同步更新导致红灯的单元测试。

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                               15 项缺陷闭环验收全景矩阵                                     │
├─────────────────────┬───────────────────────────────────────────┬──────────────┬────────────┤
│ 缺陷编号            │ 核心问题概括                              │ 实际代码落地 │ 闭环状态   │
├─────────────────────┼───────────────────────────────────────────┼──────────────┼────────────┤
│ BUG-M01             │ 0-token 失败撤回导致重试神隐或篡改历史   │ 已接 retryCtx│ ✅ 闭环通过│
│ BUG-M02             │ 水合写入“（上次回复未完成）”伪文本       │ 已改成空串   │ ⚠️ 伴生单测│
│ BUG-M03             │ Coordinator 会话删除 ephemeralStore 泄漏  │ 已级联 clear │ ✅ 闭环通过│
│ BUG-M04             │ useSlashSend 动态 await import 延迟异味   │ 已改静态引入 │ ✅ 闭环通过│
│ BUG-M05             │ streamCallbacksEvents 的 as any 与死参数  │ 消除 any/死参│ ✅ 闭环通过│
│ §1.1                │ types.ts 的 errorDetail 标注 @deprecated  │ 已加 @see    │ ✅ 闭环通过│
│ §1.2                │ MessageContent / useChatStream 9 项单测   │ 21/21 passed │ ✅ 闭环通过│
├─────────────────────┼───────────────────────────────────────────┼──────────────┼────────────┤
│ BUG-S01             │ 项目文件夹折叠导致 listOffsetTop 突变跳变 │ 新增 MO 监听 │ ✅ 闭环通过│
│ BUG-S02             │ .accordionInner 残留 overflow/GPU 合成层  │ 已彻底清空   │ ✅ 闭环通过│
│ §1.3                │ useSessionListDrag 中 dragOverPinned 驱动 │ set 已接通   │ ⚠️ 遗留死态│
├─────────────────────┼───────────────────────────────────────────┼──────────────┼────────────┤
│ BUG-D01             │ 跨 Leaf 拖拽到 TabStrip 搬移 Tab 假动作   │ moveTab 物理 │ ⚠️ 伴生契约│
│ BUG-D02             │ 侧栏未打开会话分屏 Tab 标题退化 ID 乱码   │ 真实注入标题 │ ✅ 闭环通过│
│ BUG-D03             │ 跨项目拖拽未调 canonicalSessionFolder 误锁│ 统一规范化   │ ✅ 闭环通过│
│ BUG-D04             │ TabStrip 让位离开样式泄漏 (clearAllShifts)│ 5 处时序清退 │ ✅ 闭环通过│
│ BUG-D05             │ useSessionListDrag.ts 裸 any 消除         │ 联合字面量   │ ✅ 闭环通过│
├─────────────────────┼───────────────────────────────────────────┼──────────────┼────────────┤
│ BUG-Q01             │ workspace-shell/types.ts @deprecated @see │ 已补全并过检 │ ✅ 闭环通过│
│ 死代码/unused import│ ProjectsSection / useSessionGrouping 等   │ 静态检查通过 │ ✅ 闭环通过│
└─────────────────────┴───────────────────────────────────────────┴──────────────┴────────────┘
```

---

# 二、 逐项白盒代码核查明细

## 维度 1：主对话界面消息流纯洁性与瞬态错误态

### 1. 【BUG-M01】0-token 失败撤回导致重试按钮神隐或篡改历史消息
- **核查位置**：
  - `apps/crish-desktop/src/store/ephemeralChatStore.ts:31-34`
  - `apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts:326-362`
  - `apps/crish-desktop/src/components/chat-message-list/EphemeralStatusSlot.tsx:25-30`
  - `apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx:306-315`
- **代码实证与物理机制核验**：
  - 在 `ephemeralChatStore.ts` 中结构化增加了 `retryContext?: { userMsgId?: string; promptText?: string; }`；
  - 发生 0-token 报错撤回（`withdrawMessage`）时，`streamCallbacksEvents.ts:358-361` 正确提取了当前轮次用户的真实提问文本与 ID：
    ```typescript
    retryContext: {
      userMsgId: refs.streamManager?.get(sid)?.userMsgId || lastUserMsg?.id,
      promptText: lastUserMsg?.text,
    }
    ```
  - 视图层 `EphemeralStatusSlot.tsx:29` 点击重试时将 `ctx?.promptText` 传递给 `onRetry`；
  - `MessageVirtualizer.tsx:308-314` 中，`onRetry` 优先消费 `promptText && onSendFollowUp(promptText)`，首轮对话失败重试按钮正常渲染并重新发送；后续轮次对话失败绝不调用 `handleRegenerateRow(lastAssistantId)`，彻底根除了篡改上一轮 AI 回复的严重逻辑 Bug。
- **复审判定**：**【已闭环根治】**。

---

### 2. 【BUG-M02】sessionHydrationMessages.ts 水合写入“（上次回复未完成）”伪文本
- **核查位置**：
  - `apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts:168-175`
  - `apps/crish-desktop/src/api/sessionPersistence.test.ts:296`
- **代码实证与物理机制核验**：
  - `sessionHydrationMessages.ts:169` 现已将旧式的 `m.sender === 'assistant' ? '（上次回复未完成）' : undefined` 完全删除，收敛为纯净空文本处理：
    ```typescript
    if (m.status === 'processing') {
      const sanitizedText = m.text && m.text.trim() ? m.text : '';
      next = {
        ...next,
        status: 'completed',
        text: sanitizedText,
      };
    }
    ```
  - **缺陷指正（未竟之处）**：
    虽然业务层代码已彻底消灭伪回复，但测试套件 `sessionPersistence.test.ts:296` 未同步更新断言：
    ```typescript
    // apps/crish-desktop/src/api/sessionPersistence.test.ts:296
    expect(out![0]!.text).toBe('（上次回复未完成）'); // 依然期待旧伪回复！
    ```
    运行 `npx vitest run apps/crish-desktop/src/api/sessionPersistence.test.ts` 导致 **1 个测试失败报错**（`AssertionError: expected '' to be '（上次回复未完成）'`）。必须将该断言同步纠正为 `expect(out![0]!.text).toBe('')`。
- **复审判定**：**【业务逻辑闭环，单测断言脱节致红灯】**。

---

### 3. 【BUG-M03】SessionCoordinator 会话删除时 ephemeralChatStore 内存泄漏
- **核查位置**：`apps/crish-desktop/src/store/SessionCoordinator.ts:16, 44-45`
- **代码实证与物理机制核验**：
  - 第 16 行顶层静态引入：`import { useEphemeralChatStore } from './ephemeralChatStore';`
  - 第 44-45 行在 `deleteSessionCascade` 方法的原子级联链路中，增加了第 5 步清理：
    ```typescript
    // 5. 清理 ephemeralChatStore 中的内存瞬态状态，杜绝内存泄漏
    useEphemeralChatStore.getState().clearEphemeralStatus(id);
    ```
  - 删除会话时，`statusBySession` 中的孤儿条目得到彻底释放。
- **复审判定**：**【已闭环根治】**。

---

### 4. 【BUG-M04】useSlashSend.ts 动态 await import 异味
- **核查位置**：`apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts:31, 110`
- **代码实证与物理机制核验**：
  - 动态 `await import('../../store/ephemeralChatStore')` 已被彻底消除；
  - 第 31 行采用顶层静态模块引用：`import { useEphemeralChatStore } from '../../store/ephemeralChatStore';`
  - 第 110 行同步执行 `useEphemeralChatStore.getState().clearEphemeralStatus(sessionId);`，彻底消除了微任务延迟。
- **复审判定**：**【已闭环根治】**。

---

### 5. 【BUG-M05】streamCallbacksEvents.ts 的 as any 强转与死参数
- **核查位置**：`apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts:286-297, 331-343`
- **代码实证与物理机制核验**：
  - 解构出的 `pushRunNotice` 在 289, 292, 296 行全部按表面（`persistent` / `banner-toast` / `banner`）参与真实通知分发，死参数已被盘活；
  - 错误类型强转已收敛为安全的字面量联合：
    ```typescript
    const validKinds = [
      'network', 'rate_limit', 'auth', 'quota', 'context_length', 'server_error', 'stream_abort',
    ] as const;
    const resolvedKind =
      kind && (validKinds as readonly string[]).includes(kind)
        ? (kind as (typeof validKinds)[number])
        : 'generic';
    ```
  - `streamCallbacksEvents.ts` 全文 `as any` 出现次数为 **0**。
- **复审判定**：**【已闭环根治】**。

---

### 6. 【§1.1】types.ts 的 errorDetail 标注 @deprecated
- **核查位置**：`apps/crish-desktop/src/store/types.ts:444-455`
- **代码实证与物理机制核验**：
  ```typescript
  /**
   * 运行错误诊断详情。
   * @deprecated 历史持久化/向后兼容字段；新流式会话错误已收敛至 ephemeralChatStore 瞬态进行时状态。
   * @see useEphemeralChatStore
   */
  errorDetail?: ...
  ```
  已规范标注并附带合法 `@see` 指向。
- **复审判定**：**【已闭环根治】**。

---

### 7. 【§1.2】MessageContent.test.tsx 与 useChatStream.test.ts 单测修复
- **核查位置**：
  - `apps/crish-desktop/src/components/chat-message/MessageContent.test.tsx`
  - `apps/crish-desktop/src/hooks/chat-stream/useChatStream.test.ts`
- **验证命令输出**：
  ```
  npx vitest run apps/crish-desktop/src/components/chat-message/MessageContent.test.tsx apps/crish-desktop/src/hooks/chat-stream/useChatStream.test.ts
  ✓ apps/crish-desktop/src/components/chat-message/MessageContent.test.tsx (6 tests)
  ✓ apps/crish-desktop/src/hooks/chat-stream/useChatStream.test.ts (15 tests)
  Test Files  2 passed (2)
  Tests  21 passed (21)
  ```
  此前崩溃的 9 项核心测试已完全按照“纯 AI 气泡、错误由底槽承接”的新契约通过回归断言。
- **复审判定**：**【已闭环根治】**。

---

## 维度 2：侧栏所见即所得与滚动几何

### 8. 【BUG-S01】项目文件夹折叠/展开导致 listOffsetTop 测量失效与千像素跳变
- **核查位置**：`apps/crish-desktop/src/components/sidebar/session-list/useSessionListWindow.ts:89-109`
- **代码实证与物理机制核验**：
  - 为克服 W3C 规范中 `ResizeObserver` 无法捕获父容器中元素 `offsetTop` 偏移突变的固有缺陷，代码不仅监听了 `listEl.parentElement`，还引入了专门的 DOM 结构与属性变动监视：
    ```typescript
    const mo =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            update();
          })
        : null;
    mo?.observe(scrollEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-expanded', 'data-expanded', 'hidden'],
    });
    ```
  - 当项目文件夹展开或折叠导致常规会话列表在文档流中被推移时，`mo` 即时触发并重新调用 `measureListOffsetTop(scrollEl, listEl)`，更新虚拟滚动切片，彻底消除了千像素跳跃。
- **复审判定**：**【已闭环根治】**。

---

### 9. 【BUG-S02】.accordionInner 中 overflow: hidden、contain: layout paint、transform: translateZ(0) 残留
- **核查位置**：`apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css:31-37`
- **代码实证与物理机制核验**：
  - 原本强制开启 GPU 合成层和视口裁切的属性均已被彻底移除：
    ```css
    .accordionInner {
      min-height: 0;
    }
    .accordionWrapper[data-expanded='true'] .accordionInner {
      display: block;
    }
    ```
  - 自然流排版完全恢复，无任何不当的裁剪层与渲染层隔离。
- **复审判定**：**【已闭环根治】**。

---

### 10. 【§1.3】useSessionListDrag.ts 中 dragOverPinned 真实响应式驱动、死假状态清退
- **核查位置**：`apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts:189-191, 374`
- **代码实证与物理机制核验**：
  - `dragOverPinned` 已经接入真实的 `useState`，并在第 284, 289, 374, 489, 563 行由 `setDragOverPinned(isPinnedTarget)` 驱动，置顶高亮能够实时呈现；
  - **缺陷指正（未竟之处）**：
    第 190-191 行中：
    ```typescript
    const [dropIndicator] = useState<DropIndicator | null>(null);
    const [dragPreview] = useState<SessionDragPreview | null>(null);
    ```
    这两个状态依然未提供任何 setter，值永远为 `null`。在下游 `useSessionGrouping.ts:80-122` 和 `useSidebarSessionList.tsx:156-162` 中，围绕 `dragPreview` 的三处预览重排计算分支全部因 `!dragPreview` 恒为真而被跳过，沦为假状态与死代码！
- **复审判定**：**【部分闭环：dragOverPinned 已通，但 dropIndicator / dragPreview 假状态死逻辑未清退】**。

---

## 维度 3：拖拽与跨域分屏/TabStrip 插排

### 11. 【BUG-D01】跨 Leaf 拖拽到 TabStrip 搬移 Tab 假动作（openSessionOp 与 moveTab 连通）
- **核查位置**：
  - `apps/crish-desktop/src/store/layout-tree/layoutTreeTransform.ts:205-231`
  - `apps/crish-desktop/src/store/workspace-shell/treeSessionCommands.ts:150-167`
  - `apps/crish-desktop/src/components/shell/sessionTabDropCommit.test.ts:87`
- **代码实证与物理机制核验**：
  - 核心逻辑 `openSession` 纯函数中，彻底根除了“发现已有 Tab 就直接就地激活、无视目标 Leaf 与下标”的恶性逻辑：
    ```typescript
    if (existing) {
      const isDifferentLeaf = opts.activeLeafId && existing.leaf.id !== opts.activeLeafId;
      const isDifferentIndex =
        opts.insertIdx !== undefined &&
        existing.leaf.tabs.findIndex((t) => t.tabId === existing.tab.tabId) !== opts.insertIdx;

      if (isDifferentLeaf || isDifferentIndex) {
        const targetLeafId = opts.activeLeafId || existing.leaf.id;
        const targetTabs =
          collectLeaves(tree.root).find((l) => l.id === targetLeafId)?.tabs.length ?? 0;
        const finalInsertIdx = opts.insertIdx !== undefined ? opts.insertIdx : targetTabs;

        const movedTree = moveTab(
          tree,
          existing.leaf.id,
          existing.tab.tabId,
          targetLeafId,
          finalInsertIdx
        );
        return {
          tree: movedTree,
          leafId: targetLeafId,
          tabId: existing.tab.tabId,
          created: false,
        };
      }
      ...
    }
    ```
  - 此时跨 Leaf 拖拽到 TabStrip 真正触发了 `moveTab` 物理搬迁，不再是假动作。
  - **伴生缺陷指正**：
    由于将 `commitSidebarSessionDrop` 直接追加在 `apps/crish-desktop/src/components/shell/sessionTabDropCommit.ts:58-85` 中并引入了 `shell.openOrFocusSession`，击穿了既有的轻量契约测试 `sessionTabDropCommit.test.ts:87`（`expect(COMMIT_SRC).not.toMatch(/openOrFocusSession/)`），导致该测试报错！
- **复审判定**：**【业务逻辑闭环，伴生架构单测源码正则断裂】**。

---

### 12. 【BUG-D02】侧栏全新未打开会话分屏 Tab 标题退化为十六进制 ID 乱码
- **核查位置**：
  - `apps/crish-desktop/src/store/layout-tree/layoutTreeInsert.ts:310-315`
  - `apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts:172-176`
- **代码实证与物理机制核验**：
  - `workspaceShellStore.ts:173-176` 从持久化 session 实体中提取真实标题与项目目录：
    ```typescript
    const session = useSessionStore.getState().sessionsById[sid];
    treeStore.splitSessionFromSidebar(sid, dstLeafId, region, undefined, {
      title: session?.title,
      workspaceKey: session?.folder,
    });
    ```
  - `layoutTreeInsert.ts:310-315` 在创建全新 Tab 时注入了 `title: opts?.title` 与 `workspaceKey: opts?.workspaceKey`，顶栏 Tab 标题不再退化为 Raw SessionId。
- **复审判定**：**【已闭环根治】**。

---

### 13. 【BUG-D03】跨项目拖拽未调用 canonicalSessionFolder 误锁常规会话
- **核查位置**：`apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts:205, 378`
- **代码实证与物理机制核验**：
  - 规范化接入：
    ```typescript
    const originFolder = canonicalSessionFolder(folderName);
    const isProjectSession = originFolder !== GENERAL_FOLDER;
    ...
    const targetFolderName = isPinnedTarget
      ? originFolder
      : canonicalSessionFolder(rawTargetFolder);
    ```
  - 历史数据库中标记为 `'常规会话'` 或 `'会话'` 的会话被统一归一化为 `GENERAL_FOLDER`，不会被误当做项目专有会话，常规列表内部拖拽排序与置顶拖拽完全恢复。
- **复审判定**：**【已闭环根治】**。

---

### 14. 【BUG-D04】TabStrip 让位离开时样式泄漏（clearAllShifts）
- **核查位置**：`apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts:240-246, 285, 361, 382, 490, 560`
- **代码实证与物理机制核验**：
  - 实现了专有清理函数：
    ```typescript
    const clearAllShifts = () => {
      for (const el of shiftedElements) {
        el.style.transform = '';
        el.style.transition = '';
      }
      shiftedElements = [];
    };
    ```
  - 在以下 5 大时序点全量调用：
    1. 切入叶面分屏（285 行）；
    2. 光标移回侧栏（361 行）；
    3. 越界守门拦截（382 行）；
    4. 未命中目标的游离态（490 行）；
    5. 松手释放、ESC 键取消、指针失效的终态 `cleanup()`（560 行）。
  - 顶栏 Tab 的 `translateX` 残留错位现象已被彻底根除。
- **复审判定**：**【已闭环根治】**。

---

### 15. 【BUG-D05】useSessionListDrag.ts 裸 any 消除
- **核查位置**：`apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts:254-257`
- **代码实证与物理机制核验**：
  ```typescript
  const showPaneIndicator = (
    rect: { left: number; top: number; width: number; height: number },
    region: 'left' | 'right' | 'top' | 'bottom' | 'center'
  ) => ...
  ```
  裸 `any` 已替换为与 `PaneDropRegion` 对齐的严格联合字面量类型。全文无任何 `: any` 或 `as any`。
- **复审判定**：**【已闭环根治】**。

---

## 维度 4：代码质量与门禁

### 16. 【BUG-Q01】workspace-shell/types.ts 中 @deprecated 注释缺少 @see
- **核查位置**：`apps/crish-desktop/src/store/workspace-shell/types.ts:8`
- **代码实证与物理机制核验**：
  - 已补全为 `/** @deprecated 树上只有 chat 叶，维 07 删除。@see SessionTab */`；
  - 执行 `npx eslint apps/crish-desktop/src/store/workspace-shell/types.ts`，**0 errors, 0 warnings** 纯净通过。
- **复审判定**：**【已闭环根治】**。

---

### 17. 死代码与未使用 import 清退（ProjectsSection 等）
- **核查位置**：
  - `apps/crish-desktop/src/components/sidebar/session-list/ProjectsSection.tsx`
  - `apps/crish-desktop/src/components/sidebar/session-list/useSessionGrouping.ts`
  - `apps/crish-desktop/src/components/sidebar/useSidebarContextMenu.ts`
  - `apps/crish-desktop/src/hooks/chat-stream/streamCallbacksInternals.ts`
- **代码实证与物理机制核验**：
  - 运行 `npx eslint` 扫描上述 4 个文件，未报告任何未使用变量或无效 import 错误。
- **复审判定**：**【已闭环根治】**。

---

# 三、 额外审查发现的遗留隐患与门禁阻断项

作为最高级别复审审计官，秉承绝对零容忍与不放过任何瑕疵的纪律，本次复审立体验证中还抓出了以下 **3 处尚未彻底收敛的问题**：

### 隐患 1：`sessionPersistence.test.ts:296` 单测失败
- **位置**：`apps/crish-desktop/src/api/sessionPersistence.test.ts:296`
- **根因**：BUG-M02 已将水合伪回复改为空串 `""`，但此处的既有测试仍断言等于 `'（上次回复未完成）'`。
- **修复方案**：将 `expect(out![0]!.text).toBe('（上次回复未完成）')` 修改为 `expect(out![0]!.text).toBe('')`。

### 隐患 2：`sessionTabDropCommit.test.ts:87` 架构契约单测失败
- **位置**：`apps/crish-desktop/src/components/shell/sessionTabDropCommit.test.ts:87`
- **根因**：原单测要求 `sessionTabDropCommit.ts` 纯粹处理树操作，严禁引入 `openOrFocusSession`；但侧栏拖拽提交函数 `commitSidebarSessionDrop` 被写在该文件中并调用了 `openOrFocusSession`，导致源码正则校验失败。
- **修复方案**：将 `commitSidebarSessionDrop` 拆分至独立文件 `sidebarSessionDropCommit.ts`，或更新契约测试允许该侧栏分发入口。

### 隐患 3：`useSessionListDrag.ts` 违反行数门禁（BUG-Q02 仍存）
- **位置**：`apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts`
- **根因**：该 Hook 包含 524 行有效代码，触发了 `check-line-counts` 的 `[VIOLATION]`（上限 500 行）。且其内部仍保留了 `dropIndicator` 与 `dragPreview` 两个无 setter 的 `useState(null)` 假状态。

---

# 四、 最终复审验收结论

1. **核心业务逻辑与功能闭环**：
   原《极度苛刻白盒审计报告》指出的 15 项功能性 Bug 中，**全部 15 项的实际业务代码均已完成实质性重构与修复**，未发现任何在核心运行路径上欺骗、造假、伪兼容的恶劣行径。
2. **测试与门禁资产收尾要求**：
   尚余 2 处测试断言滞后（`sessionPersistence.test.ts`、`sessionTabDropCommit.test.ts`）与 1 处文件行数门禁超标（`useSessionListDrag.ts`）。主 Agent 只需完成上述 3 处纯测试/门禁与假状态的最终收口，即可宣称整个侧栏拖拽与跨域分屏体系实现**绝对净收敛交付**！
