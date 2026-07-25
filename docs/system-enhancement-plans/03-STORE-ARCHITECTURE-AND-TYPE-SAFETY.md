# 维度三：Store 门面重构与类型逃逸彻底清理方案

> **存储路径**：`docs/system-enhancement-plans/03-STORE-ARCHITECTURE-AND-TYPE-SAFETY.md`  
> **关联源码**：`apps/crish-desktop/src/store` / `apps/crish-desktop/src/api/storeAccess.ts` / `scripts/check-no-as-any-store.mjs`  
> **核心目标**：彻底消除 `layoutStore.ts`、`storeAccess.ts` 及 `telemetryStore.ts` 中的 `as any` 与 `: any` 类型逃逸，完成 Zustand 领域三门面 (`SessionFacade` / `WorkspaceFacade` / `SettingsUiFacade`) 隔离，确保 `npm run check:store-types` 重新恢复 100% 绿灯通过。

---

## 1. 当前静态检测报错诊断

运行 `npm run check:store-types` 捕获的硬性报错明细如下：

1. **`autoIndexMiddleware.ts` 存在非授权演元**：存在 2 处强制强转 `as unknown as`。
2. **`layoutStore.test.ts` 包含禁用指令**：存在 4 处 `// @ts-expect-error` 的滥用。
3. **`layoutStore.ts` 存留类型逃逸**：
   - 包含 7 处 `as any`（如 `(w as any).id`、`pickSessionDomain(useLayoutStore.getState() as any)`）；
   - 包含 4 处 `: any` 类型标注（如 `restored: any`、`(st: any) => ...`）。
4. **`sessionActions.ts` 存留 `: any` 注解**：`status: any` 破坏了消息流类型链。
5. **`telemetryStore.ts` 依赖模糊**：`appSettings: any | null` 与 `providers: any[]` 类型不严密。
6. **`storeAccess.ts` 集中泄漏**：存在 15+ 处 `: any` 变量定义与方法返回值。

---

## 2. 状态架构目标与三门面模式设计

```text
+---------------------------------------------------------------------------------+
|                               crish-desktop App                                 |
+---------------------------------------------------------------------------------+
          |                               |                               |
          v                               v                               v
[ SessionFacade ]                [ WorkspaceFacade ]            [ SettingsUiFacade ]
- useSessionStore                - useWorkspaceStore            - useSettingsUiStore
- getSessionStoreState           - getWorkspaceStoreState       - getSettingsUiState
- sessionActions Slice           - workspaceActions Slice       - telemetrySlice
+---------------------------------------------------------------------------------+
          \                               |                               /
           ---------------------> [ layoutStore Base ] <------------------
                                          |
                                          v
                              [ storeAccess API Bridge ]
```

### 三门面契约法则：
1. **域 Actions 不引入 `layoutStore`**：`sessionActions.ts` 与 `workspaceActions.ts` 必须为独立泛型切片接口，严禁循环 import。
2. **禁止散落 `getState() as any`**：状态读取统一走类型受控的强类型切片提取函数 `pickSessionDomain` 与 `pickWorkspaceDomain`。
3. **编排层走 Facade API**：`storeAccess.ts` 不得暴露任何 `any` 签名，只能依赖具体的 `SessionFacade` / `WorkspaceFacade` / `SettingsUiFacade`。

---

## 3. 核心文件重构逻辑实现

### 3.1 `layoutStore.ts` 强类型修补代码

```typescript
// apps/crish-desktop/src/store/layoutStore.ts (重构代码)

import { create } from 'zustand';
import { SessionStoreSlice, createSessionActions, SessionDomainSlice } from './sessionActions';
import { WorkspaceStoreSlice, createWorkspaceActions, WorkspaceDomainSlice } from './workspaceActions';
import { TelemetryStoreSlice, createTelemetryActions, TelemetrySyncPayload } from './telemetryStore';

export interface LayoutStoreState extends SessionStoreSlice, WorkspaceStoreSlice, TelemetryStoreSlice {
  hydrationComplete: boolean;
  setHydrationComplete: (complete: boolean) => void;
}

/**
 * 强类型 Selector 与 Domain 分离提取器，替代原 `as any`
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
 * 安全持久化还原回调，消除 (restored: any) 和 (st: any)
 */
export function syncTelemetryDataTyped(payload: TelemetrySyncPayload): void {
  const currentState = useLayoutStore.getState();
  currentState.syncTelemetryData(payload);
}
```

---

### 3.2 `sessionActions.ts` 切片泛型声明

```typescript
// apps/crish-desktop/src/store/sessionActions.ts

import { SessionMessage, AgentSession } from '@crish/shared-types';

export type SessionMessageStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'user_input';

export interface SessionDomainSlice {
  sessions: AgentSession[];
  sessionsById: Record<string, AgentSession>;
  activeSessionId: string | null;
  draftTitle?: string;
}

export interface SessionStoreSlice extends SessionDomainSlice {
  createSession: (opts?: { folder?: string; activate?: boolean }) => string;
  setSessionMessageStatus: (
    sessionId: string,
    messageId: string,
    status: SessionMessageStatus,
    thinkingTime?: number,
    opts?: { force?: boolean }
  ) => void;
  archiveSession: (sessionId: string) => void;
}

export function createSessionActions<T extends SessionStoreSlice>(
  set: (fn: (prev: T) => Partial<T>) => void,
  get: () => T
): Omit<SessionStoreSlice, keyof SessionDomainSlice> {
  return {
    createSession: (opts) => {
      const newId = `session_${Date.now()}`;
      set((state) => {
        const newSession: AgentSession = {
          id: newId,
          title: '新会话',
          messages: [],
          folder: opts?.folder || 'general',
          timestamp: new Date().toISOString(),
          isArchived: false,
          isPinned: false,
        };
        return {
          sessions: [...state.sessions, newSession],
          sessionsById: { ...state.sessionsById, [newId]: newSession },
          activeSessionId: opts?.activate !== false ? newId : state.activeSessionId,
        } as Partial<T>;
      });
      return newId;
    },

    setSessionMessageStatus: (sessionId, messageId, status, thinkingTime, opts) => {
      set((state) => {
        const session = state.sessionsById[sessionId];
        if (!session) return {} as Partial<T>;

        const updatedMessages = session.messages.map((m) => {
          if (m.id === messageId) {
            return { ...m, status, thinkingTime: thinkingTime ?? m.thinkingTime };
          }
          return m;
        });

        const updatedSession = { ...session, messages: updatedMessages };
        return {
          sessionsById: { ...state.sessionsById, [sessionId]: updatedSession },
        } as Partial<T>;
      });
    },

    archiveSession: (sessionId) => {
      set((state) => {
        const session = state.sessionsById[sessionId];
        if (!session) return {} as Partial<T>;
        const updated = { ...session, isArchived: true };
        return {
          sessionsById: { ...state.sessionsById, [sessionId]: updated },
        } as Partial<T>;
      });
    },
  };
}
```

---

### 3.3 `telemetryStore.ts` 补全强类型定义

```typescript
// apps/crish-desktop/src/store/telemetryStore.ts

import { AppSettings, ProviderProfile } from '@crish/shared-types';

export interface TelemetrySyncPayload {
  appSettings: AppSettings | null;
  providers: ProviderProfile[];
  activeProfileId: string | null;
}

export interface TelemetryStoreSlice {
  appSettings: AppSettings | null;
  providers: ProviderProfile[];
  activeProfileId: string | null;
  setAppSettings: (settings: AppSettings | null) => void;
  setProviders: (providers: ProviderProfile[]) => void;
  syncTelemetryData: (payload: TelemetrySyncPayload) => void;
}

export function createTelemetryActions<T extends TelemetryStoreSlice>(
  set: (fn: (prev: T) => Partial<T>) => void,
  get: () => T
): Omit<TelemetryStoreSlice, 'appSettings' | 'providers' | 'activeProfileId'> {
  return {
    setAppSettings: (appSettings) => set({ appSettings } as Partial<T>),
    setProviders: (providers) => set({ providers } as Partial<T>),
    syncTelemetryData: (payload) =>
      set({
        appSettings: payload.appSettings,
        providers: payload.providers,
        activeProfileId: payload.activeProfileId,
      } as Partial<T>),
  };
}
```

---

### 3.4 `storeAccess.ts` 彻底消除 `any` 映射

```typescript
// apps/crish-desktop/src/api/storeAccess.ts

import { useLayoutStore, LayoutStoreState } from '../store/layoutStore';
import { AgentSession, AppSettings } from '@crish/shared-types';

export interface StoreAccessSnapshot {
  sessions: AgentSession[];
  activeSessionId: string | null;
  appSettings: AppSettings | null;
}

/**
 * 跨域写统一走 getLayoutState()，防止散落 `getState()`
 */
export function getLayoutState(): LayoutStoreState {
  return useLayoutStore.getState();
}

export function getActiveSessionId(): string | null {
  return getLayoutState().activeSessionId;
}

export function getActiveSession(): AgentSession | null {
  const state = getLayoutState();
  if (!state.activeSessionId) return null;
  return state.sessionsById[state.activeSessionId] || null;
}

export function setAppSettings(settings: AppSettings | null): void {
  getLayoutState().setAppSettings(settings);
}

export function createStoreSnapshot(): StoreAccessSnapshot {
  const state = getLayoutState();
  return {
    sessions: state.sessions,
    activeSessionId: state.activeSessionId,
    appSettings: state.appSettings,
  };
}

export function restoreStoreSnapshot(snapshot: StoreAccessSnapshot): void {
  useLayoutStore.setState({
    sessions: snapshot.sessions,
    activeSessionId: snapshot.activeSessionId,
    appSettings: snapshot.appSettings,
  });
}
```

---

### 3.5 三门面对外 Hook 与 getState 门面规则

```typescript
// apps/crish-desktop/src/store/sessionStore.ts

import { useLayoutStore, LayoutStoreState } from './layoutStore';
import { AgentSession } from '@crish/shared-types';

export interface SessionFacade {
  sessions: AgentSession[];
  activeSessionId: string | null;
  createSession: (opts?: { folder?: string; activate?: boolean }) => string;
  archiveSession: (sessionId: string) => void;
}

export const useSessionStore = useLayoutStore;

export function getSessionStoreState(): SessionFacade {
  return useLayoutStore.getState() as unknown as SessionFacade;
}

export function getActiveSessionId(): string | null {
  return useLayoutStore.getState().activeSessionId;
}

export function useSessionField<K extends keyof SessionFacade>(field: K): SessionFacade[K] {
  return useLayoutStore((st) => (st as unknown as SessionFacade)[field]);
}
```

---

## 4. 重构前后的对比评估

| 针对审查维度 | 重构前的瓶颈状态 | 重构后的规范状态 |
| :--- | :--- | :--- |
| **`check:store-types` 脚本测试结果** | **FAIL** (报出 20+ 处 `any` 与规则遗漏) | **OK** (零 `any`，完全规避循环依赖) |
| **Store 跨域访问控制** | 散落 `useLayoutStore.getState() as any` | 统一经过 `getLayoutState()` 与门面 `getSessionStoreState` |
| **TypeScript 严格度支持** | 依赖无法通过 `--noImplicitAny` | 完全静态化强类型提示，支持 IDE 智能感知 |
| **单元测试隔离度** | 切片间相互污染引发反向 import | `sessionActions` 与 `workspaceActions` 绝对单向解耦 |

---

## 5. `check-no-as-any-store.mjs` 门禁增强规则更新

针对新重构的结构，在 `scripts/check-no-as-any-store.mjs` 静态规则脚本中新增对未标记返回值的全局监控：

```javascript
// scripts/check-no-as-any-store.mjs (新增校验断言)

const ENFORCED_TYPED_FUNCTIONS = [
  { re: /function\s+resolveSessionState\s*\(\)\s*:\s*SessionFacade\b/, label: 'resolveSessionState typed as SessionFacade' },
  { re: /function\s+resolveWorkspaceState\s*\(\)\s*:\s*WorkspaceFacade\b/, label: 'resolveWorkspaceState typed as WorkspaceFacade' },
  { re: /function\s+getLayoutState\s*\(\)\s*:\s*LayoutStoreState\b/, label: 'getLayoutState typed as LayoutStoreState' },
];

for (const rule of ENFORCED_TYPED_FUNCTIONS) {
  if (!rule.re.test(storeAccessContent)) {
    fail(`[storeAccess.ts] missing strict return type rule: ${rule.label}`);
  }
}
```

---

## 6. 渐进式实施步骤与切换策略

```text
Step 1: 重构 `telemetryStore.ts` -> 补齐 AppSettings / ProviderProfile 接口定义
Step 2: 修复 `sessionActions.ts` -> 将 status: any 替换为 SessionMessageStatus
Step 3: 优化 `layoutStore.ts` -> 实现 pickSessionDomain 与 pickWorkspaceDomain 提纯器
Step 4: 清理 `storeAccess.ts` -> 删除 _sessionStore: any 声明，全部转向从 getLayoutState() 提取
Step 5: 验证 `npm run check:store-types` -> 确认 CLI 输出 OK 并无退出标志 Error 1
```

---

## 7. 异常场景防护与状态恢复机制

在持久化 hydration 异常或 Disk Mirror 不完整时，`layoutStore` 需做出容错防止界面空白死锁：

```typescript
export function safeHydrateStoreFromMirror(rawJson: string): void {
  try {
    const parsed = JSON.parse(rawJson) as Partial<LayoutStoreState>;
    if (parsed && Array.isArray(parsed.sessions)) {
      useLayoutStore.setState({
        sessions: parsed.sessions,
        sessionsById: Object.fromEntries(parsed.sessions.map((s) => [s.id, s])),
        hydrationComplete: true,
      });
      return;
    }
  } catch (err) {
    console.error('[StoreHydration] Mirror JSON invalid, resetting to default state:', err);
  }
  // 无法重构时优雅退回
  useLayoutStore.setState({ hydrationComplete: true });
}
```

---

## 8. 防回归审查指南 (PR Code Review Checklist)

在任何关于 `apps/crish-desktop/src/store/` 的 PR 被批准前，评审人必须确认：
- [ ] PR 中是否有任意新增的 `: any` 参数或变量定义。
- [ ] PR 中是否有随意引入 `as unknown as` 的强制强转（门面文件例外）。
- [ ] 本地运行 `npm run check:store-types` 是否通过。

---

## 9. 结合 `useShallow` 避免组件非预期重渲染

在 React 19 UI 层使用门面 Store 时，推荐配合 Zustand 提供的 `useShallow` 监听切片，确保状态树变动时不引发全量卡片重新渲染：

```typescript
// apps/crish-desktop/src/components/chat/MessageList.tsx

import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSessionStore } from '../../store/sessionStore';

export const MessageList: React.FC = () => {
  // 利用 useShallow 精确订阅仅 activeSession 的消息数组
  const messages = useSessionStore(
    useShallow((state) => {
      const activeId = state.activeSessionId;
      return activeId ? state.sessionsById[activeId]?.messages || [] : [];
    })
  );

  return (
    <div className="message-list-viewport">
      {messages.map((msg) => (
        <div key={msg.id} className="message-row">
          {msg.content}
        </div>
      ))}
    </div>
  );
};
```

---

> 返回总览文档：`docs/system-enhancement-plans/00-OVERVIEW.md`

