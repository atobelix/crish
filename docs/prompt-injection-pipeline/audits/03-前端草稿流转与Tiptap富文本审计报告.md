# 前端草稿流转与 Tiptap 富文本深度审计报告

> **审计位**：前端草稿流转与 Tiptap 富文本专属审计位（对齐 `AGENTS.md` §17 / 主控提示词 §4.4）  
> **审计范围**：
> - `apps/crish-desktop/src/api/draft/sessionDraftManager.ts` 与单测  
> - `apps/crish-desktop/src/components/chat-card/useChatInput.ts`, `useChatComposerProps.ts`  
> - `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx`, `TiptapComposerField.tsx`, `TiptapEditorField.tsx`, `composerTypes.ts`  
> - `apps/crish-desktop/src/components/chat-composer/tiptapInjectionUtils.ts`  
> - `apps/crish-desktop/src/components/chat-composer/DraftUndoToast.tsx`, `DraftUndoToast.module.css`  
> - `apps/crish-desktop/src/components/chat-composer/serialization/markdownDeserializer.ts` 与单测  
> - 已删除的 `apps/crish-desktop/src/api/composerSeed.ts` 残留扫描  
>
> **对照基准**：
> - `00-总方案-统一提示词与上下文注入通道架构规划.md`（§三 契约统一裁决 / §四 执行顺序）  
> - `detailed-plans/03-会话隔离草稿流转与调度收敛详案.md`（不变量一至四 / 断言矩阵）  
> - `plan-reviews/02-路径收敛与删除面评审.md`  
> - `AGENTS.md` §7（严禁补丁、绕过与作弊）、§7.1（立体验证纪律）、§13（UI 边框与焦点态）  
>
> **审计时间**：2026-09-02  
> **审计评级**：🟡 **有条件通过（发现 1 处严重逻辑断层 + 2 处时序盲区，需立即修复）**

---

## 一、审计结论总览与健康度矩阵

| 审计维度 / 要点 | 核心断言 | 源码证据位置 | 评级 | 核心发现摘要 |
| :--- | :--- | :--- | :---: | :--- |
| **1. 物理删除收敛性** | `composerSeed.ts` 彻底移除，全系统 0 死代码残留 | `apps/crish-desktop/src/api/composerSeed.ts` (已删除) | 🟢 绿灯 | `git log 3e10d05f` 物理删除；全局搜索 `crish_composer_seed_v1` / `takeComposerSeed` 全仓源码 0 命中；5 处外部触发源全部显式携带 `targetSessionId` 并接入 `SessionDraftManager`。 |
| **2. 三级草稿流转与 Barrier** | L1 $\rightarrow$ L2 $\rightarrow$ L3 因果保护，切换与 React 18 StrictMode 零竞态 | `sessionDraftManager.ts:80-246`<br/>`useChatInput.ts:48-89` | 🟡 黄灯 | **基本盘完好**：React 18 双挂载非破坏性水合；`safeViewDom` 守卫 Tiptap v3 Proxy 异常。<br/>**盲区披露**：`SessionDraftManager.scheduleStorePersist` 采用**单句柄标量** `pendingTimer` 与 `pendingSave`，多会话并发异步写入时存在持久化覆盖；L1 Tiptap 150ms 防抖与快速切会话存在末帧字符差漏。 |
| **3. 占位符聚焦与 Meta 抑制** | `locateFirstPlaceholder` 扫描 AST，PM Meta 抑制 Slash 建议 | `tiptapInjectionUtils.ts:37-90`<br/>`SlashExtension.ts:298-318` | 🔴 **红灯 (严重)** | **致命 Bug 确诊**：`locateFirstPlaceholder` 中的 `if (!node.isText) return false` 导致 ProseMirror `descendants` 在顶层 `paragraph` 节点直接剪枝，**恒等返回 `null`**，占位符选中全链路失效！<br/>**Meta 虚设**：`INJECTION_TRANSACTION_META` 未被 `SlashExtension` 的 `@tiptap/suggestion` 读取，属于无效声明。 |
| **4. GFM 反序列化与 cron 星号** | cron 表达式（如 `0 9 * * *`）裸星号不误判斜体、星号零丢失 | `markdownDeserializer.ts:145-165, 331-356` | 🟢 绿灯 | CommonMark 左侧翼规则（`(?=\S)`）成功拦截裸星号序列，`0 9 * * *` 与 `[例如：0 9 * * *]` 100% 保真解析为字面文本；列表项降维保留 `bulletMark` 规避星号丢失；排查出跨星号贪婪匹配边界风险。 |
| **5. 撤销栈内存与撤销保真度** | 栈深限制 20，模板覆盖 100% 原位无损恢复 | `sessionDraftManager.ts:145-185`<br/>`DraftUndoToast.tsx:23-74` | 🟡 黄灯 | **内存可控但有软泄露**：深度 20 有效兜底，但 Manager 缺少会话删除清理钩子；<br/>**保真度与交互断层**：原计划的 `Ctrl+Z` 未接线；`DraftUndoToast` 在 6 秒后自动淡出（`autoDismissMs=6000`），超时后用户彻底丧失触发入口。 |

---

## 二、要点一：物理删除 `composerSeed.ts` 后的收敛彻底性

### 2.1 物理删除事实与 Git 提交证据
- **文件物理存在性核查**：经执行宿主系统 `Test-Path apps/crish-desktop/src/api/composerSeed.ts`，返回 `False`，文件已彻底自磁盘物理移除。
- **Git 提交轨迹**：
  ```
  commit 3e10d05f68b3d68efcdfa049e623ec81fc3ef5c0
  Author: Main Agent
  Date:   2026-09-02
      feat(draft): 会话隔离三级草稿管道 + composerSeed 全局单键清退（维度三）
  ```
  在该提交中，`apps/crish-desktop/src/api/composerSeed.ts` 被正式物理删除，不再参与前端构建打包（无 dist 渗漏）。

### 2.2 全仓死代码与标识符归零扫描（Zero-Match Audit）
在仓库全域（包括源码、配置文件与脚本）执行严格的正向与反向 Grep 扫描：

| 历史单键 / 函数名 / 事件名 | 扫描范围 | 命中数 | 命中详情与说明 |
| :--- | :--- | :---: | :--- |
| `crish_composer_seed_v1` | `apps/crish-desktop/src/` | **0** | 彻底归零（仅在已归档设计文档与详案复盘中有记录）。 |
| `takeComposerSeed` | `apps/crish-desktop/src/` | **0** | 彻底归零。 |
| `setComposerSeed` | `apps/crish-desktop/src/` | **0** | 彻底归零。 |
| `COMPOSER_SEED_EVENT` | `apps/crish-desktop/src/` | **0** | 彻底归零（自定义 DOM 事件广播彻底清退）。 |
| `composerSeed` 关键字 | `apps/crish-desktop/src/` | **1** | 仅保留于 [`apps/crish-desktop/src/components/chat-card/useChatInput.ts:5`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/useChatInput.ts#L5) 头部注释：「* - 移除 350ms 本地防抖与 composerSeed sessionStorage 通道，持久化由 sessionDraftManager 统一承接」，代码域无任何引用。 |

### 2.3 外部播种触发源全面收敛审计
旧系统中依赖 `setComposerSeed(text)` 的 5 处外部触发源，已全部完成架构重构，100% 显式携带 `targetSessionId` 接入 `SessionDraftManager.injectSeed`，严格遵循**不变量一（定向寻址铁律）**：

1. **定时任务设置面板（`ScheduledTasksPanel.tsx:117-140`）**：
   - 源码证据：[`apps/crish-desktop/src/components/settings/ScheduledTasksPanel.tsx:120-131`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/ScheduledTasksPanel.tsx#L120-L131)
   - 审计结论：调用 `navigateToNewDraft()` 后，直接从 `useSessionStore.getState().activeSessionId` 获取真实目标会话 ID；若获取失败立即通过 `console.warn` 拦截并安全返回，**彻底杜绝了旧系统 `'draft'` 幽灵会话 ID 字面量兜底**。
2. **设置页定时任务 Tab（`SettingsScheduleTab.tsx:107-120`）**：
   - 源码证据：[`apps/crish-desktop/src/components/settings/SettingsScheduleTab.tsx:109-120`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsScheduleTab.tsx#L109-L120)
   - 审计结论：严格以 `targetSid = useSessionStore.getState().activeSessionId` 寻址，非空时才调用 `sessionDraftManager.injectSeed`。
3. **斜杠预检拦截器（`slashSendPreflight.ts:146-172`）**：
   - 源码证据：[`apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts:155-165`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L155-L165)
   - 审计结论：无参 `/schedule` 触发时创建新会话并取其 ID，向其注入 `WORKFLOW_CREATE_TEMPLATE`，`status: 'handled'` 留在对话流，绝不跳转设置页。
4. **技能编辑器（`useSkillEditor.ts:67-83`）**：
   - 源码证据：[`apps/crish-desktop/src/components/settings-skills/useSkillEditor.ts:69-80`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/useSkillEditor.ts#L69-L80)
   - 审计结论：显式判空 `targetSid`，安全拒绝无会话注入。
5. **工作流确认卡片修改按钮（`WorkflowConfirmCard.tsx:75-87`）**：
   - 源码证据：[`apps/crish-desktop/src/components/chat-injection/WorkflowConfirmCard.tsx:76-86`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/WorkflowConfirmCard.tsx#L76-L86)
   - 审计结论：显式获取 `activeSessionId`，原位注入调整模板。

---

## 三、要点二：SessionDraftManager 三级草稿流转与竞态防范

### 3.1 三级草稿架构流动模型与因果关系
系统严格落地了详案 03 定义的**三级因果草稿缓冲架构**：
```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    Level 1: 视口临时态 (Viewport Ephemeral Tier)                  │
│                     • 载体：Tiptap ProseMirror Viewport State                   │
│                     • 特性：实时选区 / CJK 合成态 / 150ms 局部序列化防抖            │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │ onChange (Markdown)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│              Level 2: 会话隔离活跃草稿池 (Session Draft Active Pool)             │
│               • 载体：SessionDraftManager (Map<SessionId, DraftRecord>)         │
│               • 特性：内存优先、历史撤销栈 (Limit 20)、subscribe 订阅式分发       │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │ 300ms 防抖 / immediate 原子 Barrier 强刷
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    Level 3: 全局持久化存储 (Store & DB Tier)                      │
│                     • 载体：useSessionStore.composerDrafts                      │
│                     • 特性：落地 SQLite / session_meta，页面重载安全水合         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 多会话切换微任务原子 Barrier 审计
在 [`apps/crish-desktop/src/components/chat-card/useChatInput.ts:48-68`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/useChatInput.ts#L48-L68) 中，`useEffect([activeSessionId])` 构建了明确的因果 Barrier：
```typescript
// 源码位置：useChatInput.ts:48-68
useEffect(() => {
  const prevSid = activeSessionIdRef.current;
  if (prevSid && prevSid !== activeSessionId) {
    // Barrier 阶段 1：强刷旧会话草稿至 Level 2/3（同步 immediate=true，作废挂起防抖）
    sessionDraftManager.setDraft(prevSid, latestTextRef.current, true);
  }
  activeSessionIdRef.current = activeSessionId;

  if (!activeSessionId) {
    setChatInputState('');
    latestTextRef.current = '';
    setHasUndo(false);
    return;
  }

  // Barrier 阶段 2：从 SessionDraftManager 精确恢复新会话草稿
  const restored = sessionDraftManager.getDraft(activeSessionId);
  setChatInputState(restored);
  latestTextRef.current = restored;
  setHasUndo(sessionDraftManager.hasUndo(activeSessionId));
}, [activeSessionId]);
```

- **Barrier 强刷保证**：`setDraft(prevSid, ..., immediate=true)` 会立即触发 `flushSession(prevSid)`（[`sessionDraftManager.ts:188-201`](file:///c:/Software/conex/apps/crish-desktop/src/api/draft/sessionDraftManager.ts#L188-L201)）。若有旧会话的 300ms 计时器挂起，立刻 `window.clearTimeout` 并同步调用 `useSessionStore.getState().setComposerDraft(sessionId, record.content)`，杜绝了旧会话防抖计时器在切换后乱序覆盖新会话的经典竞态。
- **订阅隔离**：[`useChatInput.ts:106-115`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/useChatInput.ts#L106-L115) 订阅了 `sessionDraftManager`。只有当 `sessionId === activeSessionIdRef.current` 时才执行 DOM 与内部状态变更，后台会话定向注入对前台视口 0 干扰。

### 3.3 React 18 StrictMode 双挂载生命周期审计
- **非破坏性消费（Non-Destructive Read）**：
  旧代码 `takeComposerSeed` 采用 `getItem` + `removeItem` 破坏性读取，在 StrictMode（Mount $\rightarrow$ Unmount $\rightarrow$ Mount）下第二次挂载必读到 `null` 导致草稿丢失。
  现实现 `sessionDraftManager.getDraft(sessionId)` 为纯读取函数（[`sessionDraftManager.ts:81-86`](file:///c:/Software/conex/apps/crish-desktop/src/api/draft/sessionDraftManager.ts#L81-L86)），无论挂载多少次，内存数据稳定留存，彻底通过 React 18 StrictMode 验收。
- **页面销毁与重挂载守卫**：
  [`useChatInput.ts:71-89`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/useChatInput.ts#L71-L89) 注册了 `beforeunload` 与 `visibilitychange`。在 StrictMode 模拟卸载时，cleanup 触发 `onFlush()`，将当前 `latestTextRef.current` 强刷入 Manager；随后重挂载时又被无损取回。
- **Tiptap v3 Proxy 异常拦截**：
  [`apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx:52-62`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx#L52-L62) 部署了 `safeViewDom` 守卫，使用 try-catch 包裹 `(editor.view as any)?.dom`，有效规避了 StrictMode 下 EditorView 卸载但 Proxy 存活时访问属性抛出的 `"The editor view is not available"` 致命崩溃。

### 3.4 深入穿透：2 处在途竞态盲区披露

#### 盲区 1：Level 1 (Tiptap) 150ms 防抖与切换会话的时间差漏洞
- **代码位置**：[`apps/crish-desktop/src/components/chat-composer/TiptapEditorExtensions.ts:139-148`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapEditorExtensions.ts#L139-L148)
- **时序断层剖析**：
  1. 用户在会话 A 的 Tiptap 输入框中快速输入文本，Tiptap 内部启动了 150ms 的 `debounceTimerRef` 用于序列化 Markdown；
  2. 若用户在输入最后字符的 50ms 内（小于 150ms）点击侧边栏切换到会话 B；
  3. `useChatInput.ts:52` 触发 Barrier，调用 `sessionDraftManager.setDraft(prevSid, latestTextRef.current, true)`；
  4. **致命问题**：此时 `latestTextRef.current` 仍是 150ms 之前的内容！最后 50ms 内键入的字符还躺在 Tiptap 编辑器的 ProseMirror AST 内部，尚未执行 `onMarkdownChange`！
  5. 切换到会话 B 后，`TiptapEditorField.tsx:298` 的 `editor.commands.setContent(doc)` 强行加载会话 B 的内容，Tiptap 触发新的 `onUpdate` 并清除了旧计时器。**会话 A 最后 150ms 内的击键内容发生不可逆丢失**。
- **架构改进建议**：会话切换时，Barrier 应向富文本层索取最新的同步快照（类似 `sendApiRef.flushAndSend` 的机制），或者在 `useChatInput` 卸载/切换前强制调用一次同步序列化。

#### 盲区 2：`SessionDraftManager.scheduleStorePersist` 单句柄单标量缺陷
- **代码位置**：[`apps/crish-desktop/src/api/draft/sessionDraftManager.ts:65-66, 230-246`](file:///c:/Software/conex/apps/crish-desktop/src/api/draft/sessionDraftManager.ts#L65-L66)
- **时序断层剖析**：
  ```typescript
  // sessionDraftManager.ts:65-66
  private pendingTimer: number | null = null;
  private pendingSave: { sessionId: string; content: string } | null = null;
  ```
  `SessionDraftManager` 是全系统全局单例。然而其用于 300ms 防抖写 Level 3 Store 的句柄 `pendingTimer` 与载荷 `pendingSave` **仅仅是单个标量，而非 `Map<string, ...>`**！
  若在 300ms 窗口内：
  1. 外部或 API 为会话 A 调用了 `setDraft('sess-a', 'text-a', false)`，启动 300ms 计时器；
  2. 50ms 后，另一处异步逻辑为会话 B 调用了 `setDraft('sess-b', 'text-b', false)`；
  3. `scheduleStorePersist`（L233-L235）执行了 `window.clearTimeout(this.pendingTimer)`，并将 `this.pendingSave` 直接覆写为 `{ sessionId: 'sess-b', content: 'text-b' }`！
  4. **结果**：会话 A 在 Level 2 内存中有最新数据，但在 Level 3 Store 的写入被**无声吞并（永久取消）**！若此时应用非正常退出或热重载，会话 A 的持久化草稿将缺失这部分更新。

---

## 四、要点三：Tiptap 占位符聚焦算法与事务 Meta 抑制表现（重大缺陷披露）

### 4.1 占位符扫描算法 `locateFirstPlaceholder` 致命剪枝 Bug 确诊

在审计 [`apps/crish-desktop/src/components/chat-composer/tiptapInjectionUtils.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/tiptapInjectionUtils.ts) 时，发现了一处**导致整个占位符自动聚焦机制彻底瘫痪的严重代码逻辑 Bug**：

```typescript
// 源码位置：tiptapInjectionUtils.ts:37-57
export function locateFirstPlaceholder(
  doc: ProseMirrorNode
): PlaceholderRange | null {
  let result: PlaceholderRange | null = null;

  doc.descendants((node, pos) => {
    // 💥 致命错误行：ProseMirror 的 descendants 遍历语义中，返回 false 代表剪枝（不进入子节点）！
    if (result || !node.isText || !node.text) return false;
    const match = PLACEHOLDER_REGEX.exec(node.text);
    if (match) {
      result = {
        from: pos + match.index,
        to: pos + match.index + match[0].length,
        text: match[0],
      };
      return false; // 命中即终止扫描
    }
    return true;
  });

  return result;
}
```

#### 4.1.1 根因深度剖析（ProseMirror 核心语义冲突）
- **ProseMirror 规范定义**：`Node.descendants(fn)` 遍历文档树中的每一个后代节点。当回调函数 `fn` 返回 `false` 时，ProseMirror 的遍历器会将当前节点判定为「已处理且无需深入」，**完全跳过该节点的所有子节点（Prune Children）**！
- **执行断层现场**：
  1. 任何富文本 Markdown 文档（包括 `/schedule` 模板），其根节点 `doc` 的直接子节点都是**块级节点**（通常是 `paragraph`）；
  2. `doc.descendants` 访问的第一个后代节点就是这个 `paragraph` 节点；
  3. 此时 `node.isText === false`，因此 `!node.isText` 为 `true`；
  4. 回调函数触发执行：`return false;`！
  5. ProseMirror 收到 `false`，立即停止递归进入该 `paragraph` 的内部；
  6. **结果：该函数永远遍历不到任何 `text` 节点！`locateFirstPlaceholder(doc)` 对任何正常文档均 100% 恒等返回 `null`！**

#### 4.1.2 运行时现场实测证据（Node + ProseMirror 真实执行验证）
使用 `@tiptap/pm/model` 构造标准 ProseMirror 节点执行实测：
```bash
# 模拟当前生产代码逻辑：
doc.descendants((node, pos) => {
  if (result || !node.isText || !node.text) return false;
  ...
});
# 执行输出：
Visiting: paragraph isText: false
Result: null   <--- 致命断裂！

# 修复剪枝后的正确逻辑：
doc.descendants((node, pos) => {
  if (result) return false;
  if (!node.isText || !node.text) return true; // 允许深入子节点
  ...
});
# 执行输出：
Visiting: paragraph isText: false
Visiting: text isText: true
Result: { pos: 1, match: '{{placeholder}}' }  <--- 成功识别！
```

#### 4.1.3 连带灾难与死代码雪崩
由于 `locateFirstPlaceholder` 恒等返回 `null`，导致上层调用链全线溃退：
1. [`tiptapInjectionUtils.ts:68`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/tiptapInjectionUtils.ts#L68) 中 `const match = locateFirstPlaceholder(doc)` 恒为 `null`；
2. `if (match)` 分支（第 70~86 行）**在生产环境中从不执行**；
3. 函数恒定落入 fallback：`editor.commands.focus('end'); return false;`；
4. **占位符自动选中功能 100% 失效**：用户注入 `/schedule` 模板后，光标永远定位在文本最后，无法高亮首个占位符（如 `[描述希望定时执行的任务...]`）；
5. 为什么现存测试未发现？查阅全仓，`tiptapInjectionUtils.ts` 从未编写过任何单元测试，缺乏立体验证保护。

---

### 4.2 `INJECTION_TRANSACTION_META` 虚设与斜杠建议层抑制

#### 4.2.1 Meta 虚设事实
- 在 [`tiptapInjectionUtils.ts:22`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/tiptapInjectionUtils.ts#L22) 中定义了：
  ```typescript
  export const INJECTION_TRANSACTION_META = 'CRISH_PROMPT_INJECTION_META';
  ```
  并在 L73 声明 `tr.setMeta(INJECTION_TRANSACTION_META, true)`。
- **审计事实**：全局检索 `SlashExtension.ts`、`MentionSuggestionExtension` 以及 `@tiptap/suggestion` 的注册逻辑，**没有任何一处代码调用 `tr.getMeta(INJECTION_TRANSACTION_META)`**！
- `@tiptap/suggestion` 是第三方库，其插件内部只监听字符键入与光标变化，除非在 `Suggestion({...})` 中通过 `allow: ({ state, range }) => boolean` 显式校验事务 Meta，否则第三方插件对自定义 Meta 毫无感知。该 Meta 在当前架构中属于**空转的虚设代码**。

#### 4.2.2 `exitSuggestion` 被连带阻断
开发者在意识到了仅设置 Meta 无法关闭建议弹窗后，在 [`tiptapInjectionUtils.ts:79-84`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/tiptapInjectionUtils.ts#L79-L84) 补充了命令式关闭：
```typescript
try {
  exitSuggestion(editor.view, slashSuggestionKey);
  exitSuggestion(editor.view, mentionSuggestionKey);
} catch { /* ... */ }
```
**然而**，正如 §4.1 所述，该代码块包裹在 `if (match)` 内部！因为 `locateFirstPlaceholder` 恒返回 `null`，这段命令式关闭代码**根本没有机会被调用**！若模板以 `/schedule` 开头，建议弹层在注入后仍存在误弹出的时序隐患。

---

## 五、要点四：GFM 行内反序列化器（markdownDeserializer）对 cron 表达式中裸星号序列的解析准确性

### 5.1 CommonMark 左侧翼规则（Left-Flanking）实现与实测

详案 03 §6 与 01 执行审计指出，cron 表达式如 `0 9 * * *` 在旧版解析器中曾发生过裸星号被误判为 Markdown 斜体（Italic）而丢失的严重事故。本次重构在 [`markdownDeserializer.ts:145-165`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/serialization/markdownDeserializer.ts#L145-L165) 实施了针对性改进：

```typescript
// 源码位置：markdownDeserializer.ts:148
const italicMatch = remaining.match(/^\*(?=\S)(\S(?:[\s\S]*?\S)?)\*/);
```

#### 5.1.1 准确性判定原理
1. **开标记左侧翼预查 `(?=\S)`**：要求星号 `*` 之后**紧跟非空白字符**。在 cron 表达式 `0 9 * * *` 中，前导有数字，而每一个独立星号均形如 `* `（后跟空格）或处于行尾。因此 `(?=\S)` 立即失败，星号被正确判定为字面量文本，不会作为斜体起始标记。
2. **闭标记右侧翼约束 `(\S(?:[\s\S]*?\S)?)`**：要求内文必须以非空白字符结尾，防止行内空格串扰。
3. **现场实测数据矩阵（Node 环境逐一验证）**：

| 测试输入用例 | 目标场景 | 反序列化结果 | 是否丢失星号 | 是否误判斜体 |
| :--- | :--- | :--- | :---: | :---: |
| `0 9 * * *` | 典型每日定时 | `[{"type":"text","text":"0 9 "},{"type":"text","text":"* "},{"type":"text","text":"* "},{"type":"text","text":"*"}]` | 否（0 丢失） | 否（纯文本） |
| `[例如：0 9 * * *]` | 模板中括号占位 | `[{"type":"text","text":"[例如：0 9 "},{"type":"text","text":"* "},{"type":"text","text":"* "},{"type":"text","text":"*]"}]` | 否 | 否 |
| `* * * * *` | 每分钟全星号 | `[{"type":"text","text":"* "},{"type":"text","text":"* "},{"type":"text","text":"* "},{"type":"text","text":"* "},{"type":"text","text":"*"}]` | 否 | 否 |
| `*/5 * * * *` | 步进斜杠星号 | `[{"type":"text","text":"*/5 "},{"type":"text","text":"* "},{"type":"text","text":"* "},{"type":"text","text":"* "},{"type":"text","text":"*"}]` | 否 | 否 |
| `*task* at 0 9 * * *` | 斜体词与 cron 混排 | `[{"text":"task", marks:[italic]}, {"text":" at 0 9 "}, {"text":"* "}, ...]` | 否 | 准确识别 `task`，cron 保持字面 |

### 5.2 列表项降维保真机制
若 cron 表达式单独成行并以星号开头（如 `* * * * *`），在块级解析时会命中 [`markdownDeserializer.ts:331`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/serialization/markdownDeserializer.ts#L331) 的 `BULLET_ITEM_RE = /^\s*[-*+]\s+(.*)$/`。
- **审计结论**：由于 composer 编辑器 schema 彻底禁用了 `bulletList` 节点，代码在此处执行降维策略：将行首星号保留在 `{ type: 'text', text: bulletMark }` 中，后续文本继续递归解析为段落内的 inline text。
- **保真度验证**：输入 `* * * * *`，反序列化输出仍然是包含全部 5 个星号的 `paragraph`，**往返双向无丢失**。

### 5.3 隐蔽边界与过度贪婪风险披露
在对斜体正则深度审查时，发现一处**贪婪跨度风险**：
- 正则中使用了 `(?:\S(?:[\s\S]*?\S)?)`，由于外层的 `?` 是**贪婪量词**，当一行中出现多个星号且两端附着字符时，例如：
  `*0 9 * * 5*`
- 正则会从首个 `*` 直接跨越中间所有空格和星号，一路匹配至最后的 `*`，导致整个表达式被错误格式化为单段斜体。
- 虽然在规范的 cron 表达式（两端均有空格或括号）下不会触发此风险，但针对极端用户输入，斜体正则应收紧为排除换行与星号嵌套的非贪婪形式。

---

## 六、要点五：DraftUndoToast 撤销栈的内存占用与撤销保真度

### 6.1 内存占用与生命周期审计

#### 6.1.1 栈深限制与触发门禁
- **栈深上限**：[`sessionDraftManager.ts:53`](file:///c:/Software/conex/apps/crish-desktop/src/api/draft/sessionDraftManager.ts#L53) 定义了刚性不变量 `DRAFT_HISTORY_LIMIT = 20`。当栈满时调用 `shift()` 按 FIFO 淘汰最老快照，防止无限膨胀。
- **触发门禁收敛**（[`sessionDraftManager.ts:145-155`](file:///c:/Software/conex/apps/crish-desktop/src/api/draft/sessionDraftManager.ts#L145-L155)）：
  1. 用户常规高频键入（`setDraft`）**绝不压入撤销栈**；
  2. 模式为 `append` 时**不压栈**；
  3. 当前内容为空串或与新内容相同时**不压栈**；
  4. 只有在 `replace` 或 `safe_seed` 且即将破坏性覆盖用户既有非空草稿时，才压入原草稿快照。
- **内存量级测算**：
  单条草稿文本受编辑器防爆阈值 `COMPOSER_MAX_LENGTH = 100,000` 字符钳制（约 100KB），常规草稿通常为 0.1KB ~ 2KB。即便极端情况下一个会话连续触发 20 次满额模板覆盖，单个会话历史栈最大占用仅约 2MB。在常规场景下，单会话内存占用通常小于 10KB。

#### 6.1.2 软内存泄露风险（Soft Memory Leak）
- **审计发现**：`SessionDraftManager` 是单例模式，内部维护 `drafts = new Map<string, DraftRecord>()`。
- **生命周期断层**：检索整个项目，**`SessionDraftManager` 没有任何 `deleteDraft(sessionId)` 或 `clearSession(sessionId)` 方法**，且在 `sessionStore` 删除会话时也没有反向通知管理器。
- **影响评估**：在长期运行的桌面应用中，用户关闭或删除了大量临时会话后，`SessionDraftManager` 内部的 `Map` 键值及其历史快照依然驻留内存，直到整个客户端重启。虽然不会导致 OOM 崩溃，但属于违反单一真理源生命周期约定的软性内存滞留。

---

### 6.2 撤销保真度与交互链路深度审计

#### 6.2.1 内容保真度（100% 原始文本还原）
- 当用户触发 `undoDraft(sessionId)` 时，Manager 从 `historyStack` 弹出上一版本纯文本字符串，通过 `notify` 通知订阅者；
- `useChatInput` 更新状态，Tiptap 通过 `parseFromMarkdown` 重新将 Markdown 水合为 ProseMirror 文档树；
- 原始草稿中的加粗、行内代码、换行等结构 100% 无损重构。

#### 6.2.2 选区与光标保真度丢失
- **断层**：`historyStack` 的类型定义为 `string[]`，仅保存了文本快照，**未记录当时的选区状态（Selection / Cursor Position）**。
- **表现**：用户撤销后，由于前述 §4.1 的占位符 Bug，光标被强制置于文档末尾（`focus('end')`），无法恢复到覆盖前用户正在编辑的精确位置。

#### 6.2.3 交互与生命周期严重脱节（无法通过键盘触发）
1. **`Ctrl+Z` 虚标问题**：
   详案 03 §1.3 不变量三明确声明：「用户按 `Ctrl+Z` 或点击撤销时，原输入内容 100% 原位无损恢复」。
   **审计事实**：`handleUndoDraft`（[`useChatInput.ts:118`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/useChatInput.ts#L118)）仅被传递给了 `DraftUndoToast` 的按钮点击事件；[`TiptapKeymap.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapKeymap.ts) 与 ProseMirror 插件**完全没有监听 `Ctrl+Z` 并将其映射到 `undoDraft`**！用户在输入框按 `Ctrl+Z` 时，仅触发 ProseMirror 内部的 History 插件，而模板注入是通过 `setContent` 执行的硬重置，ProseMirror 内部历史栈为空，因此键盘 `Ctrl+Z` 毫无反应！
2. **6 秒后撤销入口永久消失**：
   [`apps/crish-desktop/src/components/chat-composer/DraftUndoToast.tsx:27-39`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/DraftUndoToast.tsx#L27-L39)：
   ```typescript
   export const DraftUndoToast: React.FC<DraftUndoToastProps> = ({
     show,
     onUndo,
     message = '已应用模板并保留原草稿快照',
     autoDismissMs = 6000,
   }) => {
     const [visible, setVisible] = useState(false);
     useEffect(() => {
       if (show) {
         setVisible(true);
         const timer = window.setTimeout(() => setVisible(false), autoDismissMs);
         return () => window.clearTimeout(timer);
       }
       setVisible(false);
     }, [show, autoDismissMs]);
   ```
   浮条在展示 6 秒后自动 `setVisible(false)` 销毁。由于没有 `Ctrl+Z` 兜底，用户如果阅读模板超过 6 秒，**将彻底失去撤销恢复原草稿的唯一 UI 途径**，即使 `SessionDraftManager` 中仍然忠实保留着历史栈！

---

## 七、整改行动项与代码修复建议

根据 `AGENTS.md` §7（追求架构优雅，杜绝打补丁）与反过度设计红线，提出以下高优先级精准整改方案：

### 7.1 【P0 级严重】修复 `locateFirstPlaceholder` 遍历剪枝 Bug
- **目标文件**：`apps/crish-desktop/src/components/chat-composer/tiptapInjectionUtils.ts:42-55`
- **修复方案**：区分块级容器节点与内联文本节点，当节点非文本时允许继续遍历子节点；命中占位符后才返回 `false` 剪枝：
  ```typescript
  export function locateFirstPlaceholder(
    doc: ProseMirrorNode
  ): PlaceholderRange | null {
    let result: PlaceholderRange | null = null;

    doc.descendants((node, pos) => {
      if (result) return false; // 已命中，立即终止全局遍历
      if (!node.isText || !node.text) return true; // 非文本节点（如 paragraph），必须深入遍历其子节点！

      const match = PLACEHOLDER_REGEX.exec(node.text);
      if (match) {
        result = {
          from: pos + match.index,
          to: pos + match.index + match[0].length,
          text: match[0],
        };
        return false; // 命中当前占位符，终止本分支深入
      }
      return true;
    });

    return result;
  }
  ```

### 7.2 【P1 级重要】完善 `SessionDraftManager` 并发持久化与生命周期清理
- **目标文件**：`apps/crish-desktop/src/api/draft/sessionDraftManager.ts`
- **修复方案**：
  1. 将 `pendingTimer` 与 `pendingSave` 升级为 `Map<string, { timer: number; content: string }>`，按会话物理隔离防抖持久化，彻底杜绝会话间持久化写冲刷；
  2. 暴露 `deleteDraft(sessionId: string): void` 方法，并在 `useSessionStore` 的会话删除动作中接线调用，消除软内存滞留。

### 7.3 【P1 级重要】补齐 `Ctrl+Z` 快捷键撤销桥接与 Toast 悬停保持
- **目标文件**：`apps/crish-desktop/src/components/chat-composer/DraftUndoToast.tsx` 与 `TiptapComposerField.tsx`
- **修复方案**：
  1. 在 `TiptapComposerField` 注册 `Mod-z` 拦截：当 `hasUndo` 为 `true` 且光标在初始状态时，优先触发 `handleUndoDraft()`；
  2. `DraftUndoToast` 增加鼠标悬停保持计时（`onMouseEnter` 清理 timer，`onMouseLeave` 重启），防止用户思考时浮条意外淡出。

---

## 八、审计总结

本次审计对重构后前端草稿管道及 Tiptap 模块进行了逐行代码级穿透：
1. **物理删除彻底性达成**：`composerSeed.ts` 及 `crish_composer_seed_v1` 全局单键彻底拔除，外部触发源 100% 切换至携带 `targetSessionId` 的定向注入，满足负产出零残留断言。
2. **核心逻辑发现关键暗病**：在 ProseMirror AST 遍历算法中，因误将非文本节点返回 `false` 触发了剪枝机制，导致全系统占位符自动聚焦与高亮功能完全处于假死状态。必须立即按照 §7.1 提供的原生逻辑修正。
3. **GFM 解析保真度过硬**：针对定时任务中至关重要的 cron 表达式，CommonMark 左侧翼约束与段落降维成功保护了 `0 9 * * *` 裸星号文本，未发生强调误判。
4. **撤销体系需补齐交互闭环**：撤销栈数据结构本身健壮，但上层 UI 展现时间过短（6 秒）且缺乏 `Ctrl+Z` 键盘通道，导致撤销能力无法稳定触达用户。

整改建议已全部列出，修复代码具备高内聚、零过度设计、符合 TypeScript 静态规范等特征，建议主控 Agent 在下一执行波立即收口落实。
