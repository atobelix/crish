# 会话消息流纯洁性与侧栏所见即所得流式布局方案 (Main Agent Stage 5 Plan)

> **文档位置**：`docs/sidebar-session-drag-refactor/09-main-agent-stage5-plan.md`  
> **战役阶段**：Stage 5 (Message Purity & WYSIWYG Sidebar Flow Layout)  
> **设计基准**：严格遵守 `AGENTS.md` §1（反退避）、§7（严禁补丁/作弊）、§7.1（立体验证纪律）、§8（反过度设计硬性红线）。

---

# 目录索引

- [一、 核心命题与架构愿景](#一-核心命题与架构愿景)
- [二、 痛点一：主对话界面非 AI 伪回复清退与临时进行时状态（Volatile Ephemeral Status）](#二-痛点一主对话界面非-ai-伪回复清退与临时进行时状态volatile-ephemeral-status)
  - [2.1 伪回复病理机制剖析](#21-伪回复病理机制剖析)
  - [2.2 临时进行时错误态（Volatile Ephemeral Status）设计](#22-临时进行时错误态volatile-ephemeral-status设计)
  - [2.3 自愈与去重协议（Auto-Clear & Dedup Invariants）](#23-自愈与去重协议auto-clear--dedup-invariants)
- [三、 痛点二：侧栏所见即所得流式布局（WYSIWYG Flow Layout）与重叠 Bug 根除](#三-痛点二侧栏所见即所得流式布局wysiwyg-flow-layout与重叠-bug-根除)
  - [3.1 截图文字重叠（“运行 git status” 与 “查看全部”）根因剖析](#31-截图文字重叠运行-git-status-与-查看全部根因剖析)
  - [3.2 彻底清退局部折叠与“查看全部”多轨逻辑](#32-彻底清退局部折叠与查看全部多轨逻辑)
  - [3.3 置顶与分组自然伸长与整体下推流式规范](#33-置顶与分组自然伸长与整体下推流式规范)
- [四、 详细代码级改造清单](#四-详细代码级改造清单)
- [五、 五层立体验证模型](#五-五层立体验证模型)

---

## 一、 核心命题与架构愿景

1. **主对话流纯洁性（Pure AI Stream）**：
   - 主对话界面只渲染真实 AI 的回答，坚决不允许将系统错误、提示或离线提示作为永久的 `assistant` 消息写入持久化历史；
   - 错误与异常统一呈现为**临时的、灰色的进行时状态卡片**（类似工作中状态与离线重试提示），位于流的最底部；
   - 用户点击重试或发送新对话后自动消失，重复提示严格去重，绝不污染历史；
2. **侧栏所见即所得自然流（WYSIWYG Natural Flow）**：
   - 彻底清退置顶列表和分组列表的局部截断、折叠手风琴与“查看全部 (N)”多轨机制；
   - 根除截图中的文字重叠 Bug，所有列表项自然撑开容器，下方的项目文件夹与常规区自然下推，统一由外层单一滚动条承载。

---

## 二、 痛点一：主对话界面非 AI 伪回复清退与临时进行时状态

### 2.1 伪回复病理机制剖析
- 历史代码在处理网络异常、超时或未连网时，偶尔会构造一个 `{ role: 'assistant', content: '...' }` 并推入 `sessionStore.messages`；
- 这导致非 AI 生成的伪回复被永久序列化落盘，并在后续加载时混淆用户认知。

### 2.2 临时进行时错误态（Volatile Ephemeral Status）设计
- 会话状态中维护一个**仅在内存中存在、不持久化到磁盘**的瞬态字段：
  ```typescript
  export interface EphemeralChatStatus {
    id: string;
    kind: 'error' | 'offline' | 'working';
    text: string;
    retryable?: boolean;
    timestamp: number;
  }
  ```
- 渲染位置：位于 `ChatMessageList` 的消息流尾部（在进行中指示器旁）；
- 视觉呈现：采用柔和浅灰色字体（`var(--text-tertiary)`），配合轻量重试按钮，与工作中进行时动效浑然一体。

### 2.3 自愈与去重协议
1. **自动消失**：当触发 `handleSendChat` 或 `handleRetry` 时，立即原子清空 `ephemeralStatus = null`；
2. **单一去重**：新的错误或提示直接覆盖旧提示，保证界面上同一时刻最多仅展示 1 个当前状态，绝不向下无限堆叠。

---

## 三、 痛点二：侧栏所见即所得流式布局与重叠 Bug 根除

### 3.1 截图文字重叠根因剖析
- 在 `GeneralSection.tsx` 与 `ProjectsSection.tsx` 中，存在 `slice(0, 6)` / `slice(0, 10)` 的截断，并在外部包裹了 `accordionWrapper` 手风琴；
- 由于手风琴的 `display: none` / `overflow: hidden` 与虚拟滚动的容器尺寸计算发生竞争，导致下方的“查看全部 (24)”按钮在计算偏移量时直接盖在了上一个可见的 `li`（“运行 git status”）上方，产生了严重的双层文字重叠！

### 3.2 彻底清退局部折叠与“查看全部”多轨逻辑
- 移除 `accordionWrapper`, `accordionInner`, `onToggleShowAllGeneralSessions`, `onToggleExpandedProjectFolder` 等所有多轨折叠逻辑；
- 列表组件直接渲染完整的会话列表：
  ```tsx
  <ul className={styles.folderSessions}>
    {sessions.map((s) => renderSessionItem(s))}
  </ul>
  ```

### 3.3 置顶与分组自然伸长与整体下推流式规范
- 置顶列表（`pinnedList`）：不再限制最大显示高度，有多少项就渲染多少项；
- 项目文件夹（`ProjectsSection`）：展开时有多少项就自然撑开，自然下推常规会话列表；
- 整个侧栏统一由最外层的 `.sidebarScroll` 负责滚动，实现真正的“所见即所得”。

---

## 四、 详细代码级改造清单

| 文件路径 | 改造内容 |
| :--- | :--- |
| `apps/crish-desktop/src/components/sidebar/session-list/GeneralSection.tsx` | 移除 `slice(10)` 与手风琴“查看全部”，全量自然渲染 |
| `apps/crish-desktop/src/components/sidebar/session-list/ProjectsSection.tsx` | 移除 `slice(6)` 与手风琴“查看全部”，全量自然渲染 |
| `apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css` | 移除多余的手风琴样式，保持自然流式间距 |
| `apps/crish-desktop/src/components/chat-message-list/ChatMessageList.tsx` | 装配 `EphemeralChatStatus` 临时状态呈现，灰色字体 |
| `apps/crish-desktop/src/store/sessionStore.ts` | 增加瞬态错误状态管理，确保不落盘，发新消息/重试自愈 |

---

## 五、 五层立体验证模型

- **第 1 层**：`npm run typecheck` 100% 零编译报错；
- **第 2 层**：全量单元测试与无重叠断言测试全部通过；
- **第 3 层**：规范守门与无硬编码；
- **第 4 层**：真实桌面环境中：
  - 侧栏文字重叠彻底消失，列表自然展开下推；
  - 错误提示呈现为灰色临时状态，发送新对话后自动消失。
