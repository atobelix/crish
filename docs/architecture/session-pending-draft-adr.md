# ADR: Pending Draft Session（会话生命周期）

**状态**: Accepted  
**日期**: 2026-07  
**关联**: 空壳复用 / 侧栏幽灵会话 / folder 过早绑定

---

## 1. 背景

当前路径为：

```
点击「新对话」→ createSession() → sessions[] 增加空壳 → 侧栏出现条目
→ 用户可能换项目 / 再点新建 → 空壳复用、剪枝、shouldList=true 等补丁链
```

已确认问题（B-01…B-10）：工作区与 folder 绑定过早；约 150 行复用/剪枝是对错误生命周期的补救；`shouldListSessionInSidebar` 被迫对空壳返回 true。

## 2. 决策

引入 **Pending Draft** 虚拟活动态：

| 项                     | 约定                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| 哨兵 ID                | `PENDING_DRAFT_SESSION_ID = '__pending_draft__'`                                  |
| `activeSessionId` 类型 | 保持 `string`（不用 null，避免全链路 nullable）                                   |
| 草稿期间 `sessions[]`  | **不增加任何条目**                                                                |
| 侧栏                   | 天然无条目（草稿不在列表中）                                                      |
| 绑定 folder 的时刻     | **首条消息提交（commit）瞬间** 的 `draftFolder`                                   |
| 真实 session 创建      | 仅 `commitDraftIfNeeded` / 系统占位 `createSession({ activate:false })` / 显式 id |

### 状态机

```
历史会话 activeSessionId = 'sess-…'
        │  enterDraftMode(folder?)
        ▼
草稿态 activeSessionId = '__pending_draft__'
        draftFolder = 当前项目（可随项目切换更新）
        sessions 无新条目
        │  commitDraftIfNeeded()  // 发送首条 / 需持久化写
        ▼
真实会话 mint + 写入 sessions + 侧栏出现
```

### 硬接口（禁止再补丁）

1. `sessions[]` 只含可持久化会话（历史脏空壳由 hydrate 净化）。
2. 用户「新对话」**禁止**直接 `createSession`；只允许 `enterDraftMode`。
3. `createSession` 语义：`mint | attach explicitId | activate:false 系统占位`，**禁止** reuse empty shell。
4. 需真实 sid 的路径必须先 `commitDraftIfNeeded`。
5. folder 绑定点 = commit 时的 `draftFolder`，不是 enter 后的活动真会话 folder。

## 3. 备选方案

| 方案                              | 未采纳原因                      |
| --------------------------------- | ------------------------------- |
| `activeSessionId: string \| null` | 触面过大                        |
| 独立 draftStore                   | 双 store 同步 Composer/流成本高 |
| 继续空壳+复用+剪枝                | 已证伪                          |

## 4. 后果

- 删除 `findReusableEmptyShell` 及 create 内复用分支（**禁止 reuse 空壳当新建**）。
- **保留** `pruneEmptyShellSessions` / `shellPruneKeepIds` / `prepareSessionsForUi`：**仅 hydrate / list GC** 历史脏空壳（inventory #9 心智模型：draft ≠ empty-shell create）。
- `shouldListSessionInSidebar` 空壳返回 false（隐藏 ≠ 复用）。
- 测试契约从「复用空壳」改为「草稿不进列表、发送才 mint；空壳仅 GC」。

## 5. 执行

见 `multi_agent_session_lifecycle_guide.md`（Round 0–8）。
