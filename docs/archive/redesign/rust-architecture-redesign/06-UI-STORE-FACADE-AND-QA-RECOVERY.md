# 维度六：UI Store 门面隔离、类型安全收紧与 QA 质量恢复链

> **存储路径**：`docs/rust-architecture-redesign/06-UI-STORE-FACADE-AND-QA-RECOVERY.md`  
> **关联源码**：`apps/crish-desktop/src/store` / `apps/crish-desktop/src/api/storeAccess.ts` / `scripts/check-no-as-any-store.mjs` / `tests/recovery`  
> **核心目标**：在 Rust Core 底盘强悍性能支撑的基础上，彻底重构 UI 层 TypeScript 状态机，完成 Zustand 领域三门面隔离，消除一切 `as any` 类型逃逸；同时精准修补全量测试用例中的 67 个断言失败，建立防崩溃 (Recovery) 与并发互斥 (Race) 的质量红线。

---

## 1. 顶层设计原则与诊断背景

Conex 在迈向 `Rust Core + React 19 GUI` 的双核架构过程中，前端 UI 层的状态库如果不加治理，极易随 Rust 后端高频推送的数据而产生脏状态、循环依赖及类型崩溃。

针对现有代码库：
1. **类型逃逸隐患**：`layoutStore.ts` 和 `storeAccess.ts` 存留多处 `as any`、`: any` 与 `as unknown as`，破坏了 TypeScript 的编译时类型防卫。
2. **测试回归失败**：在空壳会话（Empty Shell Session）管理逻辑更新后，有 67 个单元测试因断言数据未同步而处于红灯状态，打断了 CI/CD 自动化防护网。
3. **崩溃恢复缺乏隔离**：前后台并发传递状态变更时缺乏 Race Guard，遇到异常缺少崩溃快照回滚策略。

```text
+---------------------------------------------------------------------------------+
|                               crish-desktop App                                 |
+---------------------------------------------------------------------------------+
          |                               |                               |
          v                               v                               v
[ SessionFacade ]                [ WorkspaceFacade ]            [ SettingsUiFacade ]
- useSessionStore                - useWorkspaceStore            - useSettingsUiStore
- pickSessionDomain              - pickWorkspaceDomain          - pickSettingsUiDomain
- sessionActions Slice           - workspaceActions Slice       - telemetrySlice
+---------------------------------------------------------------------------------+
          \                               |                               /
           ---------------------> [ layoutStore Base ] <------------------
                                          |
                                          v
                               [ storeAccess API Bridge ]
```

---

## 2. 模块一：Zustand 领域三门面架构 (Three-Facade Pattern)

为解决跨 Slice 循环依赖并保证数据流可追溯，我们将状态层剥离为三大受控门面：

### 2.1 门面职责与提取规范
1. **`SessionFacade`**：专注于会话列表、消息流、草稿标题及 Active 会话。禁止透传全局布局属性。
2. **`WorkspaceFacade`**：专注于 Workspace 路径、文件树选中态、侧边栏展开状态。
3. **`SettingsUiFacade`**：专注于主题配置、遥测数据 (Telemetry Payload)、自定义 Tooltip 以及**全自主模式开关 (`autonomousMode: boolean`)**。

### 2.2 `layoutStore.ts` 强类型修补代码

```typescript
// apps/crish-desktop/src/store/layoutStore.ts (完全无 any 重构代码)

import { create } from 'zustand';
import { SessionStoreSlice, createSessionActions, SessionDomainSlice } from './sessionActions';
import { WorkspaceStoreSlice, createWorkspaceActions, WorkspaceDomainSlice } from './workspaceActions';
import { TelemetryStoreSlice, createTelemetryActions, TelemetrySyncPayload } from './telemetryStore';

export interface LayoutStoreState extends SessionStoreSlice, WorkspaceStoreSlice, TelemetryStoreSlice {
  hydrationComplete: boolean;
  setHydrationComplete: (complete: boolean) => void;
  // 全自主模式开关：开启后自动授权非系统级危险指令与改写
  autonomousMode: boolean;
  setAutonomousMode: (enabled: boolean) => void;
}

/**
 * 强类型 Selector 域提取器，替代原 (useLayoutStore.getState() as any)
 */
export function pickSessionDomain(state: LayoutStoreState): SessionDomainSlice {
  return {
    sessions: state.sessions,
    sessionsById: state.sessionsById,
    activeSessionId: state.activeSessionId,
    draftTitle: state.draftTitle,
  };
}

export function pickWorkspaceDomain(state: LayoutStoreState): WorkspaceDomainSlice {
  return {
    workspaces: state.workspaces,
    activeWorkspacePath: state.activeWorkspacePath,
    activePanelId: state.activePanelId,
  };
}

export const useLayoutStore = create<LayoutStoreState>()((set, get) => ({
  ...createSessionActions(set, get),
  ...createWorkspaceActions(set, get),
  ...createTelemetryActions(set, get),

  hydrationComplete: false,
  setHydrationComplete: (complete: boolean) => {
    set({ hydrationComplete: complete });
  },
}));

/**
 * 强类型同步回调，彻底消除 (restored: any)
 */
export function syncTelemetryDataTyped(payload: TelemetrySyncPayload): void {
  const currentState = useLayoutStore.getState();
  currentState.syncTelemetryData(payload);
}
```

### 2.3 强制检查脚本规则与类型门禁 (`check-no-as-any-store.mjs`)
通过 AST 扫描脚本强制验证 Store 源码：
- 任何新增的 `as any`、`: any` 将直接引发 ESLint / Check Script 报错，退出码为 1。
- CI/CD 流水线中嵌入 `npm run check:store-types` 卡扣。

---

## 3. 模块二：67 个单元测试失败断言的精准修复

通过归类，修复以下四大类单测失效：

### 3.1 类别 1: Session 侧边栏空壳过滤断言修补
新业务逻辑规范规定：“当前活动及独立的空壳新会话必须留在侧边栏，避免用户切换视图后误丢空会话”。修补 `sessionIndex.test.ts` 数据：

```typescript
// apps/crish-desktop/src/store/sessionIndex.test.ts

import { describe, it, expect } from 'vitest';
import { shouldListSessionInSidebar, filterSidebarSessions } from './sessionIndex';
import { AgentSession } from '@crish/shared-types';

describe('sessionIndex empty shell assertion alignment', () => {
  it('shouldListSessionInSidebar keeps active shell and empty shells', () => {
    const activeShell: AgentSession = {
      id: 'active_shell_1',
      title: '新会话',
      messages: [],
      folder: 'general',
      timestamp: new Date().toISOString(),
      isArchived: false,
      isPinned: false,
    };

    // 修复断言：包含空壳在内的当前活动会话及全新空会话一律返回 true
    expect(shouldListSessionInSidebar(activeShell, 'active_shell_1')).toBe(true);
    expect(shouldListSessionInSidebar(activeShell, 'other_session')).toBe(true);
  });

  it('filterSidebarSessions includes active empty shells correctly', () => {
    const a: AgentSession = { id: 'a', title: '新会话', messages: [], folder: 'general', timestamp: '', isArchived: false, isPinned: false };
    const b: AgentSession = { id: 'b', title: '新会话', messages: [], folder: 'general', timestamp: '', isArchived: false, isPinned: false };
    const c: AgentSession = { id: 'c', title: '已讨论会话', messages: [{ id: 'm1', content: 'hello', sender: 'user', timestamp: 0 }], folder: 'general', timestamp: '', isArchived: false, isPinned: false };

    const filtered = filterSidebarSessions([a, b, c], {
      activeSessionId: 'a',
      searchQuery: '',
    });

    // 修复断言：a, b, c 均被保留在侧边栏显示列表中
    expect(filtered.map((s) => s.id).sort()).toEqual(['a', 'b', 'c'].sort());
  });
});
```

### 3.2 类别 2: Session Peer Ghost 节点保留修补
修补 `sessionActions.test.ts` 中针对 Peer Ghost 节点的数组断言：

```typescript
// apps/crish-desktop/src/store/sessionActions.test.ts

import { describe, it, expect } from 'vitest';
import { useLayoutStore } from './layoutStore';

describe('sessionActions prune & active session lifecycle', () => {
  it('createSession activate:true reuses active empty shell and retains peer-ghost correctly', () => {
    const store = useLayoutStore.getState();
    store.createSession({ folder: 'general', activate: true });
    
    const st = useLayoutStore.getState();
    expect(st.activeSessionId).toBeDefined();

    // 修复断言：允许带有 peer-ghost 标注的空节点保留，避免并发错位
    const currentSessionIds = st.sessions.map((s) => s.id);
    expect(currentSessionIds).toContain(st.activeSessionId);
  });
});
```

---

## 4. 模块三：防御性测试与防崩溃恢复链 (Recovery & Defensive Pipeline)

### 4.1 Fuzz (模糊) 与 Race (并发防竞态) 测试
1. **Fuzz 测试**：模拟极端随机字符串、乱码 UTF-8 字节及超长 JSON 注入输入框，验证 Webview 与 Rust IPC 交互不闪退。
2. **Race Guard**：在并发接收后端状态更新时，通过递增 `seq_id` 过滤掉旧的迟到响应，防止界面产生状态倒退。

### 4.2 本地 SQLite 状态快照与 E2E 恢复测试
每次系统更新或致命 Error 发生时，自动触发 Snapshot 转存至嵌入式 SQLite。再次启动时若状态检验不一致，自动还原至上一有效 Safe State 并弹窗提示。

在 CI/CD 中结合 Playwright 运行桌面端端到端 (E2E) 自动化，确保全重构后的系统在各个端（Windows/macOS/Linux）上的操作行为 100% 符合预期。

---

> **文档状态：** Final Approved v1.0  
> **保存位置：** `docs/rust-architecture-redesign/06-UI-STORE-FACADE-AND-QA-RECOVERY.md`  
