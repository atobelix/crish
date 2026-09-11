# Crish Desktop 性能重构 — 多 Agent 多轮执行总提示词

**文档版本**: v1.0
**适用对象**: 任何执行此重构的 AI Agent（Claude / GPT / Gemini 均可）
**项目根目录**: `c:\Software\conex`
**前端目录**: `c:\Software\conex\apps\crish-desktop\src`

---

## 关键背景（必读，禁止跳过）

### 已经正确实现、禁止重写的部分

以下内容**经过逐行源码核查已完成**，任何 Agent 都不得重写或「优化」：

| 模块                                  | 文件                                                                  | 状态                                         |
| ------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| Store 归一                            | `store/sessionStore.ts:27`、`workspaceStore.ts:20`                    | `useSessionStore = useLayoutStore`，同一实例 |
| bootstrapStores 去镜像                | `store/bootstrapStores.ts`                                            | 无任何 subscribe→setState，纯 no-op          |
| StreamRenderBuffer 流式不解析 HTML    | `api/StreamRenderBuffer.ts:228`                                       | `html: ''` 硬编码，终态由 Worker 写          |
| VirtualScrollManager messageId+suffix | `api/VirtualScrollManager.ts`                                         | 三步链路完整，二分查找                       |
| Binary Frame 协议                     | `api/binaryFrame.ts` + `api/daemonClient.ts:621,643,664`              | 三条路径均真正使用                           |
| SQLite WAL + pool                     | `crates/conex-db/src/pool.rs:31-35`                                   | with_init 完整，有单元测试                   |
| spawn_blocking 保护                   | search/diff/db/compact 7 处                                           | 全部已包裹                                   |
| 进程异步销毁                          | `packages/agent-runtime/src/process-lifecycle/process-executor.ts:14` | execFileAsync，无 spawnSync                  |
| Gatekeeper OnceLock                   | `crates/conex-sandbox/src/gatekeeper.rs:18`                           | 静态单例                                     |

**违规提示**：如果 Agent 在这些文件上创建大量改动，说明其在「假忙碌」，立即终止并重启该 Agent。

---

## 反偷懒守则（所有 Agent 必须遵守）

1. **改动必须精确到行**：提交前必须列出「改了哪个文件的第几行，改前内容是什么，改后是什么」
2. **禁止魔法注释**：不得写 `// TODO: implement later`、`// placeholder`
3. **禁止删除再重建**：不得删除一个已有文件再用新名重建（= 变相重写）
4. **代码验证优先**：每项改动后运行对应的测试或 lint，输出结果，不得省略
5. **自我核查**：每个 Agent 完成后必须输出「改动清单 + 逐项验证结果」，不得仅说「已完成」
6. **禁止跨轮污染**：每轮 Agent 只做本轮规定的事，不得「顺手」改其他轮的内容

---

## 总体轮次架构

```
Round 1（P0 崩溃/卡死根治）
  ├── Agent 1A：useDaemonState 单例化
  ├── Agent 1B：CardPanel 惰性挂载
  └── Agent 1-AUDIT：Round 1 后审查

Round 2（拖拽跟手 / 弹簧去除）
  ├── Agent 2A：列宽/侧栏 spring 消除 + 拖拽期冻结
  ├── Agent 2B：侧栏 resize 事件降频 + inline 清理
  └── Agent 2-AUDIT：Round 2 后审查

Round 3（三栏算力极致 / Pretext / RO 节流）
  ├── Agent 3A：ChatMessageList stableWidth + RO resize 节流
  ├── Agent 3B：drop 区 accent 颜色 + card ghost 修正
  └── Agent 3-AUDIT：Round 3 后审查

Round 4（CSS 降级 / 性能阈值 / 最终审查）
  ├── Agent 4A：backdrop-filter eco/balanced 分级 + performanceEngine 阈值
  ├── Agent 4B：dropPreviewEquals 补字段 + 全局 CSS 变量清理
  └── Agent 4-FINAL：全量回归审查 + 构建验证
```

---

## Round 1：P0 崩溃与卡死根治

### Agent 1A — `useDaemonState` 单例化

**目标**：消除 OverviewCard + RuntimePanel 各自独立的 4s 轮询实例，改为模块级单例 + refcount 生命周期管理。同时删除 `setScheduledTasks([])` 无意义调用（P0 崩溃根源）。

**文件**: `apps/crish-desktop/src/hooks/useDaemonState.ts`

**现状核查**（执行前必须确认）：

```bash
# 在项目根目录执行，确认两处调用点
grep -n "useDaemonState" apps/crish-desktop/src/components/OverviewCard.tsx
grep -n "useDaemonState" apps/crish-desktop/src/components/RuntimePanel.tsx
grep -n "setScheduledTasks" apps/crish-desktop/src/hooks/useDaemonState.ts
```

期望输出：OverviewCard.tsx:152 和 RuntimePanel.tsx:128 各有一处调用；useDaemonState.ts:88 有 `setScheduledTasks([])` 调用。

**修改方案**：将整个 `useDaemonState.ts` 重写为模块级单例 + refcount 模式：

```typescript
/**
 * 合并 OverviewCard / RuntimePanel 共享的 daemon 状态逻辑。
 *
 * 实现为模块级单例 + refcount：
 * - 首个消费者 mount 时启动轮询和订阅
 * - 最后一个消费者 unmount 时停止全部后台活动
 * - document.visibilityState === 'hidden' 时跳过 tick
 * - 禁止在 mount 时写入无关全局状态（已删除 setScheduledTasks([])）
 */
import { useState, useEffect, useRef } from 'react';
import { getDesktopDaemonClient } from '../api/daemonClient';
import {
  fetchEngineLiveStatus,
  type ActiveRunInfo,
  type PendingApprovalInfo,
} from '../api/engineStatus';
import { listWorkflows, type WorkflowDefinition } from '../api/workflowApi';
import {
  listBackgroundTasks,
  type BackgroundTaskInfo,
} from '../api/backgroundTasksApi';

export interface WorkflowRunInfo {
  id: string;
  workflowId: string;
  status: string;
  startedAt: number;
}

export interface DaemonState {
  engineOnline: boolean;
  activeRuns: ActiveRunInfo[];
  pendingApprovals: PendingApprovalInfo[];
  bgTasks: BackgroundTaskInfo[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRunInfo[];
  loading: boolean;
}

// ─── 模块级单例 ────────────────────────────────────────────────

let _refCount = 0;
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _unsubState: (() => void) | null = null;
let _workflowsLoaded = false;

type Listener = () => void;
const _listeners = new Set<Listener>();

let _state: DaemonState = {
  engineOnline: false,
  activeRuns: [],
  pendingApprovals: [],
  bgTasks: [],
  workflows: [],
  workflowRuns: [],
  loading: true,
};

function _notify(): void {
  for (const l of _listeners) l();
}

function _setState(patch: Partial<DaemonState>): void {
  _state = { ..._state, ...patch };
  _notify();
}

async function _tick(): Promise<void> {
  // 后台标签页跳过，避免浪费网络和 CPU
  if (
    typeof document !== 'undefined' &&
    document.visibilityState === 'hidden'
  ) {
    return;
  }
  try {
    const [live, bgs] = await Promise.all([
      fetchEngineLiveStatus(),
      listBackgroundTasks().catch(() => [] as BackgroundTaskInfo[]),
    ]);
    _setState({
      engineOnline: live.connected,
      activeRuns: live.activeRuns,
      pendingApprovals: live.pendingApprovals,
      bgTasks: bgs,
    });
  } catch {
    // 网络错误保留上次状态，不重置为空
  }
}

async function _loadWorkflows(): Promise<void> {
  if (_workflowsLoaded) return;
  _workflowsLoaded = true;
  try {
    const wfs = await listWorkflows();
    // 注意：不调用 setScheduledTasks([])
    // scheduledTasks 是独立状态域，由 daemon 事件驱动，不在组件 mount 时重置
    _setState({ workflows: wfs, loading: false });
  } catch {
    _setState({ loading: false });
  }
}

function _startSingleton(): void {
  const client = getDesktopDaemonClient();
  _setState({ engineOnline: client.isConnected() });
  _unsubState = client.onState((s) =>
    _setState({ engineOnline: s === 'connected' })
  );
  void _tick();
  void _loadWorkflows();
  _intervalId = setInterval(() => void _tick(), 4000);
}

function _stopSingleton(): void {
  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  if (_unsubState !== null) {
    _unsubState();
    _unsubState = null;
  }
  // 重置，下次首个 consumer 可重新启动
  _workflowsLoaded = false;
  _state = { ..._state, loading: true };
}

// ─── React hook（签名与原版完全兼容）──────────────────────────

export function useDaemonState(): DaemonState {
  const [, bump] = useState(0);
  // useRef 避免 listener 每次渲染重新创建
  const listenerRef = useRef<Listener>(() => bump((n) => n + 1));

  useEffect(() => {
    const listener = listenerRef.current;
    _refCount++;
    if (_refCount === 1) {
      _startSingleton();
    }
    _listeners.add(listener);
    // 立即同步一次当前状态（refCount > 1 时新消费者需要最新值）
    bump((n) => n + 1);

    return () => {
      _listeners.delete(listener);
      _refCount = Math.max(0, _refCount - 1);
      if (_refCount === 0) {
        _stopSingleton();
      }
    };
  }, []);

  return _state;
}
```

**验证步骤**（Agent 必须执行并报告结果）：

```bash
# 1. TypeScript 编译检查
cd apps/crish-desktop && npx tsc --noEmit 2>&1 | head -50

# 2. 确认原调用点无需修改（签名兼容）
grep -n "useDaemonState()" apps/crish-desktop/src/components/OverviewCard.tsx
grep -n "useDaemonState()" apps/crish-desktop/src/components/RuntimePanel.tsx

# 3. 确认 setScheduledTasks 已从 hook 中消失
grep -n "setScheduledTasks" apps/crish-desktop/src/hooks/useDaemonState.ts
# 期望输出：No results found

# 4. 确认 import 已删除
grep -n "setScheduledTasks" apps/crish-desktop/src/hooks/useDaemonState.ts
# 期望：无结果（import 行也应删除）
```

**完成标准**：

- [ ] TypeScript 无新增 error
- [ ] 原调用点（OverviewCard、RuntimePanel）无需任何修改
- [ ] `setScheduledTasks` 在 useDaemonState.ts 中完全消失（含 import）
- [ ] `_refCount` 逻辑：两个组件同时 mount 时 refCount=2，只有一套 setInterval

---

### Agent 1B — `CardPanel.tsx` 惰性挂载

**目标**：将 CardPanel 内的工具面板从「全量挂载 + hidden 隐藏」改为「首次激活才挂载，之后保活」。Terminal 始终挂载（PTY 连接不得中断）。

**文件**: `apps/crish-desktop/src/components/CardPanel.tsx`

**现状核查**（执行前确认）：

```bash
# 确认当前 map 结构，查看 hidden 属性和全量 mount
grep -n "hidden={!active}" apps/crish-desktop/src/components/CardPanel.tsx
# 应显示约 L825 附近
grep -n "hasMounted" apps/crish-desktop/src/components/CardPanel.tsx
# 期望：No results（尚未实现）
```

**修改步骤**：

**步骤一**：在组件函数体内（`if (!ws || !col || !group) return null;` 的 **前一行**，约 L412-413）添加：

```typescript
// 惰性挂载追踪：记录哪些 panel id 已经被激活过
// 注意：使用 ref 而非 state，避免触发额外的 re-render
const hasMountedRef = React.useRef<Record<string, boolean>>({});
```

**步骤二**：找到 `L812-865` 的 `.map((c: CardState) => {` 代码块，将其内部渲染逻辑替换为以下结构：

```tsx
{
  !isEmptyGroup &&
    group.cards
      .filter((c: CardState) => c.id !== 'chat')
      .map((c: CardState) => {
        const id = c.id;
        const active = id === activeCardId;
        const isTerminal = id === 'terminal';

        // 首次激活时永久记录（保活逻辑）
        if (active) {
          hasMountedRef.current[id] = true;
        }
        // Terminal 始终挂载（PTY 生命周期管理）；其他面板首次激活后保活
        const shouldMount = isTerminal || !!hasMountedRef.current[id];

        const known = KNOWN_BODY_IDS.has(id);
        return (
          <div
            key={id}
            className={`${styles.pane} card-body-pane`}
            data-panel-id={id}
            data-active={active ? '1' : '0'}
            hidden={!active}
            aria-hidden={!active}
          >
            {shouldMount ? (
              <>
                {id === 'preview' ? (
                  <PreviewCard wsId={wsId} onShowToast={onShowToast} />
                ) : null}
                {id === 'overview' ? (
                  <OverviewCard
                    wsId={wsId}
                    onOpenPanel={handleGlobalTabClick}
                    onShowToast={onShowToast}
                  />
                ) : null}
                {id === 'files' ? (
                  <FilesCard onShowToast={onShowToast} />
                ) : null}
                {id === 'diff' ? <DiffCard onShowToast={onShowToast} /> : null}
                {id === 'tasks' ? <PlanLegacyRedirect wsId={wsId} /> : null}
                {id === 'terminal' ? <TerminalCard /> : null}
                {id === 'settings' ? <SettingsLegacyRedirect /> : null}
                {id === 'runtime' ? (
                  <RuntimePanel wsId={wsId} onShowToast={onShowToast} />
                ) : null}
                {id === 'agent' ? (
                  <div className="agent-panel-shell">
                    <AgentCard
                      onClose={() => {
                        closeToolTab('agent', resolveFocusAfterClose('agent'));
                      }}
                    />
                  </div>
                ) : null}
                {id === 'plan' ? <PlanLegacyRedirect wsId={wsId} /> : null}
                {!known && active ? (
                  <PanelBodyEmpty
                    title={`无法显示「${getPanelTitle(id)}」`}
                    hint="从标签栏关闭后重新添加"
                    onOpenOverview={() => handleGlobalTabClick('overview')}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        );
      });
}
```

**同时删除**原有的孤立 fallback 块（`L866-875`）：

```tsx
// 删除这段（它在 map 之后，处理 activeCardId 不在 cards 中的情况）
{!isEmptyGroup &&
  activeCardId !== 'chat' &&
  !group.cards.some((c: CardState) => c.id === activeCardId) &&
  !hasKnownBody && (
  <PanelBodyEmpty ... />
)}
// 说明：新的 shouldMount 逻辑已在 map 内部正确处理 !known && active 的情况
```

**验证步骤**：

```bash
# 1. TypeScript 编译检查
cd apps/crish-desktop && npx tsc --noEmit 2>&1 | head -50

# 2. 确认 hasMountedRef 已正确添加
grep -n "hasMountedRef" apps/crish-desktop/src/components/CardPanel.tsx
# 期望：至少 3 处（定义、if(active)写入、shouldMount使用）

# 3. 确认 shouldMount 逻辑存在
grep -n "shouldMount" apps/crish-desktop/src/components/CardPanel.tsx

# 4. 确认 Terminal 特殊处理
grep -n "isTerminal" apps/crish-desktop/src/components/CardPanel.tsx

# 5. 运行单元测试（如有）
cd apps/crish-desktop && npx vitest run --reporter=verbose 2>&1 | tail -30
```

**完成标准**：

- [ ] TypeScript 无新增 error
- [ ] `hasMountedRef.current[id]` 在 active 时才写 true
- [ ] Terminal 的 `shouldMount` 恒为 true
- [ ] 其他面板首次激活前 `shouldMount = false`（DOM 为空 `null`）
- [ ] 现有单元测试全部通过

---

### Agent 1-AUDIT — Round 1 后审查

**职责**：对 Agent 1A 和 1B 的所有改动进行独立复核。

**核查清单**：

```bash
# 1. 全量 TypeScript 编译
cd apps/crish-desktop && npx tsc --noEmit
# 期望：0 errors

# 2. 确认 setScheduledTasks 不再从 useDaemonState 调用
grep -rn "setScheduledTasks" apps/crish-desktop/src/hooks/
# 期望：hooks 目录内无结果

# 3. 确认 useDaemonState 是纯 hook 接口
grep -n "setInterval" apps/crish-desktop/src/hooks/useDaemonState.ts
# 期望：_intervalId = setInterval 在模块级函数内，不在 useEffect 内

# 4. 确认 CardPanel 无任何 group.cards.map 内的直接全量挂载
grep -A5 "filter.*chat" apps/crish-desktop/src/components/CardPanel.tsx | grep -v "shouldMount\|isTerminal\|hasMounted"
# 期望：map 内无直接 <OverviewCard/> 等不经 shouldMount 守卫的挂载

# 5. 运行全量测试
cd apps/crish-desktop && npx vitest run 2>&1 | tail -20
```

**如发现问题**：报告具体问题并要求对应 Agent 修复，不得自行修复（审查与执行分离）。

---

## Round 2：拖拽跟手 / 弹簧消除

### Agent 2A — 列宽/侧栏 spring 在非拖拽场景的处理 + tab ghost 修正

**目标**：

1. 确认拖拽期间 spring 已被 `.resizing-active` 覆盖（已有，勿重复添加）
2. 修正侧栏折叠/展开的 spring 时长（220ms 是可接受的轻量视觉，但要确认没有更长的 spring 遗漏）
3. Tab ghost（card 全屏拖拽预览）去除 `width/height transition`，改用 `translate3d` 推动位置

**文件**:

- `apps/crish-desktop/src/hooks/useTabDrag.ts`
- `apps/crish-desktop/src/styles/tokens.css`（只读确认，不修改）

**现状核查**：

```bash
# 1. 确认现有 resizing 覆盖已完整
grep -n "resizing-active\|is-resizing\|window-resizing" apps/crish-desktop/src/components/Workspace.module.css
grep -n "resizing-active\|is-resizing\|window-resizing" apps/crish-desktop/src/components/Sidebar.module.css
# 期望：两个文件均有三类 class 的 transition: none !important 覆盖

# 2. 找到 card ghost 的 transition 行
grep -n "transition.*cubic\|transition.*width\|transition.*height" apps/crish-desktop/src/hooks/useTabDrag.ts
# 期望：约 L1084 有 transition: width 0.18s cubic-bezier(...)
```

**修改 1**：`useTabDrag.ts` — card ghost transition 修正（约 L1072-1085）

将 `dragOverlay.style.cssText` 中：

```typescript
// 删除：
transition: width 0.18s cubic-bezier(0.2, 0.8, 0.2, 1), height 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);

// 改为：
transition: opacity 0.12s ease-out;
will-change: transform;
```

完整替换后的 cssText：

```typescript
dragOverlay.style.cssText = `
  position: fixed;
  width: ${startWidth}px;
  height: ${startHeight}px;
  overflow: hidden;
  box-shadow: 0 0 16px rgba(0,0,0,0.12);
  border-radius: 0;
  border: 1.5px solid color-mix(in srgb, var(--accent-color, #1a73e8) 35%, var(--border-color));
  background: var(--bg-card, var(--bg-primary));
  opacity: 0.92;
  pointer-events: none;
  z-index: 10000;
  transition: opacity 0.12s ease-out;
  will-change: transform;
`;
```

**修改 2**：同文件 `L1206-1207` — 禁止 overlay 动画期间的宽高更新引发布局

```typescript
// 当前（约 L1195-1207）：
const size = computeDragOverlayTargetSize({...});
dragOverlay.style.width = `${size.width}px`;   // 这两行在 move 期间每帧执行
dragOverlay.style.height = `${size.height}px`;

// 修改：在 transition:none 的情况下宽高直接赋值 OK，但去掉不必要的目标尺寸更新
// （drag 期间 overlay 应保持初始尺寸，只有 animateOverlayAway 时才变形）
// 如果 computeDragOverlayTargetSize 仅用于此两行，则整段删除
// 如果还有其他用途，保留计算但删除 style 赋值：
// dragOverlay.style.width = `${size.width}px`;  // 删除
// dragOverlay.style.height = `${size.height}px`; // 删除
```

**验证步骤**：

```bash
# 1. 确认 width/height transition 已消失
grep -n "transition.*width\|transition.*height" apps/crish-desktop/src/hooks/useTabDrag.ts
# 期望：无结果（或只有 animateOverlayAway 中的松手动画，那个保留）

# 2. 确认 will-change: transform 已添加
grep -n "will-change" apps/crish-desktop/src/hooks/useTabDrag.ts

# 3. TypeScript 编译
cd apps/crish-desktop && npx tsc --noEmit 2>&1 | head -30
```

**完成标准**：

- [ ] card ghost 的 `style.cssText` 中无 `transition: width` 或 `transition: height`
- [ ] `will-change: transform` 已添加（hint 给 GPU 提前准备 compositor layer）
- [ ] `animateOverlayAway`（松手吸附动画）的 transition 保持不变（视觉体验）
- [ ] TypeScript 无新增 error

---

### Agent 2B — 侧栏 resize 事件降频 + 列 resize 松手清 inline

**目标**：

1. 检查侧栏 resize 拖拽是否每帧 `setState` 导致整树重渲，若是则改为 rAF 合写 CSS 变量
2. 确认列 resize 松手时是否先清 inline style 再 commit store（双源宽度问题）
3. `window-resizing` 的 100ms debounce 是否足够（验证，不一定需要修改）

**文件**:

- `apps/crish-desktop/src/components/Sidebar.tsx`（或 `hooks/useSidebarResize.ts`）
- `apps/crish-desktop/src/components/Workspace.tsx`

**现状核查**：

```bash
# 1. 找侧栏 resize 实现
grep -rn "sidebar.*resize\|useSidebarResize\|sidebar-width" apps/crish-desktop/src/ --include="*.ts" --include="*.tsx" | head -20

# 2. 找列 resize 松手处理
grep -n "endResize\|onPointerUp\|pointerup" apps/crish-desktop/src/components/Workspace.tsx | head -20

# 3. 检查是否有 inline style 残留
grep -n "style\.width\|style\[.width.\]" apps/crish-desktop/src/components/Workspace.tsx | head -20
```

**如果侧栏 resize 每帧调用 setState**（通过 grep 确认），执行以下修改：

```typescript
// 找到侧栏 pointermove 回调，当前可能类似：
const handlePointerMove = (e: PointerEvent) => {
  const newWidth = /* 计算 */;
  setSidebarWidth(newWidth); // ← 每帧 setState 导致重渲
};

// 改为 rAF 合批：
let rafId: number | null = null;
const handlePointerMove = (e: PointerEvent) => {
  const newWidth = /* 计算 */;
  // 只改 CSS 变量，不 setState
  document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
  // rAF 内合写（如果需要同步 ref 值）
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    sidebarWidthRef.current = newWidth;
    rafId = null;
  });
};

// 松手时一次性 commit：
const handlePointerUp = () => {
  if (sidebarWidthRef.current !== null) {
    setSidebarWidth(sidebarWidthRef.current); // 仅 pointerup 时 setState
    // 清理内联 CSS 变量（让 store 值通过 tokens 接管）
    document.documentElement.style.removeProperty('--sidebar-width');
  }
};
```

**如果侧栏 resize 已经是低频写法**（通过 grep 确认），则跳过此修改并在审查报告中说明。

**验证步骤**：

```bash
# 1. 确认侧栏 move 处理中无裸 setState
grep -A10 "handlePointerMove\|onPointermove" apps/crish-desktop/src/components/Sidebar.tsx | grep "setState\|setWidth\|set[A-Z]"
# 期望：无 setState 在 move 处理内

# 2. TypeScript 编译
cd apps/crish-desktop && npx tsc --noEmit 2>&1 | head -30

# 3. ESLint
cd apps/crish-desktop && npx eslint src/components/Sidebar.tsx src/components/Workspace.tsx 2>&1
```

**完成标准**：

- [ ] 侧栏 move 期间无裸 `setState` 调用（使用 CSS 变量或 ref）
- [ ] 侧栏 pointerup 一次 commit store
- [ ] 列 resize 松手时 inline style 已清理
- [ ] TypeScript + ESLint 无新增 error

---

### Agent 2-AUDIT — Round 2 后审查

```bash
# 1. 搜索 useTabDrag 中所有 transition
grep -n "transition" apps/crish-desktop/src/hooks/useTabDrag.ts
# 检查：move 期间的 cssText 内不含 width/height transition
# 检查：animateOverlayAway 的 transition 合理保留（松手吸附）

# 2. 确认列宽 resizing 时 transition 已覆盖
grep -n "transition: none" apps/crish-desktop/src/components/Workspace.module.css
# 应存在 .is-resizing/.resizing-active/.window-resizing 的覆盖

# 3. 全量编译
cd apps/crish-desktop && npx tsc --noEmit

# 4. 搜索任何新增的几何 spring transition（在 move 相关代码中）
grep -rn "cubic-bezier" apps/crish-desktop/src/hooks/useTabDrag.ts
# 期望：只在 animateOverlayAway（松手吸附），不在 handlePointerMove
```

---

## Round 3：Pretext 防抖 / RO 节流 / 颜色修正

### Agent 3A — `ChatMessageList.tsx` stableWidth 防抖 + RO resize 节流

**目标**：

1. 为 `containerWidth` 添加 200ms 稳定防抖（`stableWidth`），Pretext effect 只消费稳定值
2. 在 `body.resizing-active` 期间 ResizeObserver 跳过行高写入，避免 layout thrashing

**文件**: `apps/crish-desktop/src/components/ChatMessageList.tsx`

**现状核查**：

```bash
# 1. 确认 containerWidth 的定义位置和 deps 中的位置
grep -n "containerWidth" apps/crish-desktop/src/components/ChatMessageList.tsx

# 2. 确认 Pretext effect 的 deps 列表
grep -n "stableWidth\|pretextFont.*containerWidth\|visibleMessages.*pretextFont" apps/crish-desktop/src/components/ChatMessageList.tsx
# 期望：stableWidth 不存在（待添加）；containerWidth 在 deps 中（约 L661）

# 3. 确认 RO 的位置
grep -n "ResizeObserver\|roRef" apps/crish-desktop/src/components/ChatMessageList.tsx | head -20
```

**修改 1**：在 `const [containerWidth, setContainerWidth] = useState(680);`（约 L570）后添加：

```typescript
// 防抖后的稳定宽度：面板动画期间不触发 Pretext 重算
const [stableWidth, setStableWidth] = useState(680);

useEffect(() => {
  // 200ms 防抖：等宽度稳定后才进入 Pretext 估算 effect
  const t = window.setTimeout(() => setStableWidth(containerWidth), 200);
  return () => window.clearTimeout(t);
}, [containerWidth]);
```

**修改 2**：在 Pretext effect（约 L587-661）中，将所有 `containerWidth` 替换为 `stableWidth`：

```typescript
// L588 原：if (!pretextFont || containerWidth <= 0) return;
// 改为：
if (!pretextFont || stableWidth <= 0) return;

// L601 原：const availWidth = Math.max(1, containerWidth - 32);
// 改为：
const availWidth = Math.max(1, stableWidth - 32);

// L661 原：}, [visibleMessages, pretextFont, containerWidth, manager, setEstimated]);
// 改为：
}, [visibleMessages, pretextFont, stableWidth, manager, setEstimated]);
```

**修改 3**：找到行高 ResizeObserver 的回调（约 L670-680），添加 resizing 期间跳过：

```typescript
roRef.current = new ResizeObserver((entries) => {
  // resize 期间跳过实际高度写入，避免 layout thrashing
  // resizing-active 由列 resize 处理器维护；window-resizing 由 useWindowControls 维护
  const isResizing =
    document.body.classList.contains('resizing-active') ||
    document.body.classList.contains('window-resizing');

  for (const entry of entries) {
    const el = entry.target as HTMLElement;
    const msgId = el.dataset.msgid;
    if (msgId && entry.contentRect.height > 0 && !isResizing) {
      setActual(msgId, entry.contentRect.height);
    }
  }
});
```

**验证步骤**：

```bash
# 1. 确认 stableWidth 存在且在 effect deps 中
grep -n "stableWidth" apps/crish-desktop/src/components/ChatMessageList.tsx
# 期望：定义、useEffect 防抖、Pretext effect 内使用（3处以上）

# 2. 确认 containerWidth 已从 Pretext effect deps 中移除
grep -n "containerWidth" apps/crish-desktop/src/components/ChatMessageList.tsx | grep "\]$"
# 期望：deps 数组行不再包含 containerWidth

# 3. 确认 resizing 守卫
grep -n "isResizing\|resizing-active" apps/crish-desktop/src/components/ChatMessageList.tsx

# 4. TypeScript 编译
cd apps/crish-desktop && npx tsc --noEmit 2>&1 | head -30

# 5. 运行 ChatMessageList 相关测试（如有）
cd apps/crish-desktop && npx vitest run --testPathPattern="ChatMessage" 2>&1
```

**完成标准**：

- [ ] `stableWidth` state 和 200ms 防抖 effect 已添加
- [ ] Pretext effect deps 为 `[visibleMessages, pretextFont, stableWidth, manager, setEstimated]`
- [ ] RO 回调有 `isResizing` 守卫
- [ ] TypeScript 无新增 error

---

### Agent 3B — Drop 区 accent 颜色 + dropPreviewEquals 补字段

**目标**：

1. `Workspace.module.css` drop 区域颜色改为 accent 主题色
2. `useTabDrag.ts` 的 `dropPreviewEquals` 补充对比字段，防止同区域不同 tab 时不更新

**文件**:

- `apps/crish-desktop/src/components/Workspace.module.css`
- `apps/crish-desktop/src/hooks/useTabDrag.ts`
- `apps/crish-desktop/src/store/types.ts`（可能需要扩展 DropPreviewState）

**现状核查**：

```bash
# 1. 确认 drop 区颜色
grep -n "333333\|rgba(55, 65\|placeholderCardGroup" apps/crish-desktop/src/components/Workspace.module.css

# 2. 确认 dropPreviewEquals 当前字段
grep -A15 "function dropPreviewEquals" apps/crish-desktop/src/hooks/useTabDrag.ts

# 3. 查看 DropPreviewState 类型定义
grep -n "DropPreviewState" apps/crish-desktop/src/store/types.ts
```

**修改 1**：`Workspace.module.css` — `.placeholderCardGroup` 颜色（找到该 class 定义，修改两行）：

```css
/* 将 border 行改为（原：1.5px dashed var(--accent-color, #333333) 或类似） */
border: 1.5px dashed
  color-mix(in srgb, var(--accent-color, #1a73e8) 45%, transparent);

/* 将 background 行改为（原：rgba(55, 65, 81, 0.03) 或类似） */
background: color-mix(in srgb, var(--accent-color, #1a73e8) 5%, transparent);
```

**修改 2**：`useTabDrag.ts` — `dropPreviewEquals` 补充字段

首先查看 `DropPreviewState` 类型是否包含足够字段：

```bash
grep -B2 -A10 "DropPreviewState" apps/crish-desktop/src/store/types.ts
```

若 `DropPreviewState` 已有 `cardId` 或类似标识字段，在 `dropPreviewEquals` 中添加比较：

```typescript
export function dropPreviewEquals(
  a: DropPreviewState | null | undefined,
  b: DropPreviewState | null | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.colIdx === b.colIdx &&
    a.groupIdx === b.groupIdx &&
    a.direction === b.direction
    // 若 DropPreviewState 有 sourceCardId 字段则补充：
    // && a.sourceCardId === b.sourceCardId
  );
}
```

> **若 DropPreviewState 无此字段**：不强行添加（维持类型稳定）；在审查报告中记录「此项待后续版本添加类型字段后实施」。

**验证步骤**：

```bash
# 1. 确认 #333333 已消失
grep -n "333333" apps/crish-desktop/src/components/Workspace.module.css
# 期望：无结果

# 2. 确认 color-mix 已引入
grep -n "color-mix.*accent" apps/crish-desktop/src/components/Workspace.module.css

# 3. 确认 dropPreviewEquals 有测试
grep -n "dropPreviewEquals" apps/crish-desktop/src/hooks/useTabDrag.test.ts
# 确认现有测试仍通过

# 4. 运行 useTabDrag 测试
cd apps/crish-desktop && npx vitest run --testPathPattern="useTabDrag" 2>&1 | tail -20

# 5. TypeScript 编译
cd apps/crish-desktop && npx tsc --noEmit 2>&1 | head -30
```

**完成标准**：

- [ ] `.placeholderCardGroup` 的 border 和 background 均使用 `var(--accent-color)` via `color-mix`
- [ ] 硬编码颜色（`#333333`、`rgba(55, 65, 81, ...)`）已消除
- [ ] `useTabDrag` 所有现有测试通过
- [ ] TypeScript 无新增 error

---

### Agent 3-AUDIT — Round 3 后审查

```bash
# 1. 搜索所有硬编码颜色（非 var() 的十六进制或 rgba 带固定值）
grep -n "#[0-9a-fA-F]\{3,6\}\|rgba([0-9 ,\.]*)" apps/crish-desktop/src/components/Workspace.module.css | grep -v "var("
# 检查：是否有遗漏的硬编码颜色

# 2. 确认 stableWidth 防抖已正确工作
grep -n "setTimeout.*200\|setTimeout.*stableWidth\|setStableWidth" apps/crish-desktop/src/components/ChatMessageList.tsx

# 3. 全量编译
cd apps/crish-desktop && npx tsc --noEmit

# 4. 全量单元测试
cd apps/crish-desktop && npx vitest run 2>&1 | tail -30
```

---

## Round 4：CSS 降级 / 阈值修正 / 全量收尾

### Agent 4A — backdrop-filter 分级降级 + performanceEngine 阈值

**目标**：

1. 4 个 CSS 文件追加 eco tier 关闭 `backdrop-filter` 的规则（balanced 保留轻量视觉，eco 关闭）
2. `performanceEngine.ts` 修正 eco 判定阈值（4GB 机不应被判为 eco）

**文件**:

- `apps/crish-desktop/src/components/ChatMessageList.module.css`
- `apps/crish-desktop/src/components/ToastStack.module.css`
- `apps/crish-desktop/src/components/CheatsheetModal.module.css`
- `apps/crish-desktop/src/components/FirstRunWizard.module.css`
- `apps/crish-desktop/src/api/performanceEngine.ts`

**现状核查**：

```bash
# 1. 找所有 backdrop-filter 位置（非 none 的）
grep -rn "backdrop-filter: blur" apps/crish-desktop/src/components/ --include="*.css"
# 确认：ChatMessageList.module.css:28, ToastStack.module.css:44, CheatsheetModal.module.css:5, FirstRunWizard.module.css:9

# 2. 确认各 CSS Modules 文件的实际类名
grep -n "backdrop-filter: blur" apps/crish-desktop/src/components/ChatMessageList.module.css
grep -B5 "backdrop-filter" apps/crish-desktop/src/components/ToastStack.module.css | grep "\."
grep -B5 "backdrop-filter" apps/crish-desktop/src/components/CheatsheetModal.module.css | grep "\."
grep -B5 "backdrop-filter" apps/crish-desktop/src/components/FirstRunWizard.module.css | grep "\."

# 3. 确认 performanceEngine 当前阈值
grep -n "memoryGigs\|cores\|fps" apps/crish-desktop/src/api/performanceEngine.ts
```

**修改 1**：各 CSS Modules 文件末尾追加降级规则

> **注意**：CSS Modules 中引用外部 HTML attribute 必须用 `:global()` 包裹

```css
/* ChatMessageList.module.css — 末尾追加 */
/* eco tier 关闭毛玻璃（性能优先），保留纯色背景 */
:global([data-perf-tier='eco']) .pinnedBar {
  backdrop-filter: none;
  background: color-mix(in srgb, var(--bg-primary) 97%, transparent);
}
/* balanced 保留轻量 blur（用户说 balanced 应保留视觉效果）*/
```

```css
/* ToastStack.module.css — 末尾追加（类名需根据 grep 结果填入）*/
:global([data-perf-tier='eco']) .<ACTUAL_CLASS_NAME > {
  backdrop-filter: none;
}
```

```css
/* CheatsheetModal.module.css — 末尾追加 */
:global([data-perf-tier='eco']) .<ACTUAL_CLASS_NAME > {
  backdrop-filter: none;
  background: color-mix(in srgb, var(--bg-overlay, #000) 65%, transparent);
}
```

```css
/* FirstRunWizard.module.css — 末尾追加 */
:global([data-perf-tier='eco']) .<ACTUAL_CLASS_NAME > {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  background: color-mix(in srgb, var(--bg-overlay, #000) 72%, transparent);
}
```

**修改 2**：`performanceEngine.ts`（L17-27）修正阈值：

```typescript
// 删除旧的：
if (cores < 4 || memoryGigs < 4 || fps < 45) {
  return 'eco';
}
if (cores >= 8 && fps >= 75) {
  return 'high';
}

// 改为：
// eco：真正低端设备（2GB 以下，或仅 2 核，或 FPS 根本不稳定 < 30）
if (cores <= 2 || memoryGigs <= 2 || fps < 30) {
  return 'eco';
}
// high：高性能工作站（8核+ 且 8GB+ 且高刷新率）
if (cores >= 8 && memoryGigs >= 8 && fps >= 75) {
  return 'high';
}
// balanced：覆盖 4-8GB 4-8核主流办公机（含 4GB 机器）
return 'balanced';
```

**验证步骤**：

```bash
# 1. 确认 eco 降级规则存在
grep -n "data-perf-tier.*eco" apps/crish-desktop/src/components/ChatMessageList.module.css
grep -n "data-perf-tier.*eco" apps/crish-desktop/src/components/ToastStack.module.css
grep -n "data-perf-tier.*eco" apps/crish-desktop/src/components/CheatsheetModal.module.css
grep -n "data-perf-tier.*eco" apps/crish-desktop/src/components/FirstRunWizard.module.css
# 期望：4 个文件均有结果

# 2. 确认 balanced 不在降级名单（保留轻量 blur）
grep -n "data-perf-tier.*balanced" apps/crish-desktop/src/components/ChatMessageList.module.css
# 期望：无结果（balanced 不关 blur）

# 3. 确认 performanceEngine 阈值
grep -n "cores\|memoryGigs\|fps" apps/crish-desktop/src/api/performanceEngine.ts
# 期望：eco 判定用 <= 2，high 判定用 >= 8 && >= 8 && >= 75

# 4. TypeScript 编译
cd apps/crish-desktop && npx tsc --noEmit 2>&1 | head -30

# 5. 确认 eco tier 在 tokens.css 中已有全量动画清零（无需修改，只验证）
grep -n "data-perf-tier.*eco" apps/crish-desktop/src/styles/tokens.css | head -5
```

**完成标准**：

- [ ] 4 个 CSS 文件均有 `[data-perf-tier="eco"]` 的 `backdrop-filter: none` 覆盖
- [ ] balanced 不在覆盖列表（保留轻量毛玻璃）
- [ ] `eco` 判定改为 `cores <= 2 || memoryGigs <= 2 || fps < 30`
- [ ] `high` 判定改为 `cores >= 8 && memoryGigs >= 8 && fps >= 75`
- [ ] TypeScript 无新增 error

---

### Agent 4B — 全局 CSS 变量清理 + 遗漏硬编码扫描

**目标**：

1. 扫描所有 CSS 文件中的硬编码颜色，找出应该使用 CSS 变量的位置
2. 确认 `var(--backdrop-blur)` token 已在 eco tier 中设为 `blur(0px)`
3. 确认所有主题相关颜色使用 `var(--accent-color)` 而非固定蓝色

**文件**: 只读扫描，不大范围修改

```bash
# 1. 扫描 useTabDrag 中的硬编码颜色
grep -n "rgba([0-9 ,\.]*)\|#[0-9a-fA-F]\{3,6\}" apps/crish-desktop/src/hooks/useTabDrag.ts | head -20
# 检查：只应有 tab ghost 的 box-shadow（rgba(0,0,0,0.12)，中性色可接受）

# 2. 确认 --backdrop-blur 变量在 eco 中已设
grep -n "backdrop-blur" apps/crish-desktop/src/styles/tokens.css
# 期望：eco tier 有 --backdrop-blur: blur(0px)

# 3. 扫描所有 CSS 文件中的 #333 类深灰硬编码
grep -rn "#333\|#3[0-9a-fA-F][0-9a-fA-F]\b" apps/crish-desktop/src/components/ --include="*.css"
# 期望：Workspace.module.css 中已消除（Round 3 完成）

# 4. 如发现遗漏的硬编码颜色，逐一替换为对应 CSS 变量
# 报告：列出所有发现的位置和是否处理

# 5. 验证 tokens.css 结构完整性
grep -c "var(--" apps/crish-desktop/src/styles/tokens.css
# 记录数量（与修改前对比）
```

**如发现问题**：对每个问题单独修复，并在报告中列出「问题 → 修复 → 验证」三元组。

---

### Agent 4-FINAL — 全量回归审查 + 构建验证

**这是最后一个 Agent，必须最严格**

**职责**：

1. 全量 TypeScript 编译
2. 全量单元测试
3. 前端构建验证
4. 反偷懒检查（核查所有 Round 的 Agent 是否真正执行）

```bash
# ── Step 1: 全量 TypeScript 编译 ──
cd c:\Software\conex\apps\crish-desktop
npx tsc --noEmit
# 期望：0 errors。有 error 必须报告并拒绝通过。

# ── Step 2: 全量单元测试 ──
npx vitest run --reporter=verbose 2>&1
# 期望：全部 PASS，无 FAIL。记录测试总数和通过数。

# ── Step 3: ESLint 检查 ──
npx eslint src/ 2>&1 | tail -30
# 记录 warning/error 数量变化

# ── Step 4: 构建验证（仅 Vite build，不打包 Tauri）──
npx vite build 2>&1 | tail -20
# 期望：Build succeeded，无 chunk 大小警告超过 500KB

# ── Step 5: 反偷懒核查 ──

# 5A: useDaemonState 单例验证
echo "=== useDaemonState 单例检查 ==="
grep -n "_refCount\|_listeners\|_state" apps/crish-desktop/src/hooks/useDaemonState.ts | head -10
# 期望：存在模块级变量

# 5B: setScheduledTasks 删除验证
echo "=== setScheduledTasks 删除检查 ==="
grep -n "setScheduledTasks" apps/crish-desktop/src/hooks/useDaemonState.ts
# 期望：No results

# 5C: hasMountedRef 验证
echo "=== CardPanel hasMountedRef 检查 ==="
grep -n "hasMountedRef\|shouldMount" apps/crish-desktop/src/components/CardPanel.tsx
# 期望：3+ 处

# 5D: stableWidth 防抖验证
echo "=== stableWidth 防抖检查 ==="
grep -n "stableWidth" apps/crish-desktop/src/components/ChatMessageList.tsx
# 期望：4+ 处

# 5E: isResizing RO 守卫验证
echo "=== ResizeObserver isResizing 守卫 ==="
grep -n "isResizing\|resizing-active" apps/crish-desktop/src/components/ChatMessageList.tsx
# 期望：存在守卫

# 5F: drop 区颜色验证
echo "=== Drop 区 accent 颜色 ==="
grep -n "333333\|rgba(55, 65" apps/crish-desktop/src/components/Workspace.module.css
# 期望：No results

# 5G: eco 降级规则验证
echo "=== eco backdrop-filter 降级 ==="
grep -rn "data-perf-tier.*eco" apps/crish-desktop/src/components/ --include="*.css" | grep "backdrop"
# 期望：至少 4 个文件有结果

# 5H: performanceEngine 阈值验证
echo "=== performanceEngine 阈值 ==="
grep -n "memoryGigs <= 2\|cores <= 2\|fps < 30" apps/crish-desktop/src/api/performanceEngine.ts
# 期望：存在

# 5I: card ghost transition 验证
echo "=== card ghost 无 width/height transition ==="
grep -n "transition.*width\|transition.*height" apps/crish-desktop/src/hooks/useTabDrag.ts
# 期望：只有 animateOverlayAway 中的松手动画，handlePointerMove 内无
```

**最终报告格式**（Agent 4-FINAL 必须输出）：

```markdown
## Round 1-4 综合验收报告

### TypeScript 编译

- 状态: PASS / FAIL
- Error 数: 0 / N（列出所有 error）

### 单元测试

- 总数: X
- 通过: Y
- 失败: Z（列出失败用例）

### 反偷懒核查

| 检查项                       | 期望           | 实际     | 状态      |
| ---------------------------- | -------------- | -------- | --------- |
| useDaemonState 单例          | _refCount 存在 | [结果]   | PASS/FAIL |
| setScheduledTasks 删除       | 无结果         | [结果]   | PASS/FAIL |
| hasMountedRef                | 3+处           | [行数]   | PASS/FAIL |
| stableWidth 防抖             | 4+处           | [行数]   | PASS/FAIL |
| isResizing RO 守卫           | 存在           | [结果]   | PASS/FAIL |
| drop 区硬编码颜色删除        | 无结果         | [结果]   | PASS/FAIL |
| eco 降级规则                 | 4文件          | [文件数] | PASS/FAIL |
| performanceEngine 阈值       | cores<=2       | [结果]   | PASS/FAIL |
| card ghost 无几何 transition | 无             | [结果]   | PASS/FAIL |

### 构建产物

- 状态: SUCCESS / FAILED
- 最大 chunk: XX KB

### 结论

全部通过 / 有 N 项未通过（列出待处理项）
```

---

## 附录：动画保留政策（所有 Agent 必须遵守）

| 场景                                     | 策略                                                    | 理由                                         |
| ---------------------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| 侧栏折叠/展开 `width spring 220ms`       | ✅ **保留**                                             | 低频操作，220ms 弹性展开有设计感，不影响性能 |
| 列宽 resize 拖拽期间                     | ✅ **已有覆盖** `.resizing-active` → `transition: none` | 勿重复添加                                   |
| Tab 切换 `opacity` fade                  | ✅ **保留**                                             | compositor-only，零 layout 代价              |
| Toast 进入/退出 `transform + opacity`    | ✅ **保留**                                             | compositor-only                              |
| Modal/popover 进场                       | ✅ **保留**（eco 下由 tokens.css 归零）                 | 不常用但加分                                 |
| Accordion `grid 0fr/1fr`                 | ✅ **保留**                                             | 已是最优展开动画方案                         |
| Card ghost `width/height transition`     | ❌ **移除**                                             | 拖拽期间几何动画抢 compositor                |
| Drop overlay 颜色变化 transition         | ✅ **保留轻量** `opacity 0.1s`                          | 低开销，反馈感                               |
| `backdrop-filter: blur` on eco tier      | ❌ **关闭**                                             | eco 设备无 GPU 余量                          |
| `backdrop-filter: blur` on balanced tier | ✅ **保留**                                             | 用户明确：balanced 保留视觉效果              |

---

## 附录：禁止事项清单

**任何 Agent 违反以下任一条，应立即终止并重启：**

1. ❌ 重写 `store/sessionStore.ts`、`workspaceStore.ts`（已正确）
2. ❌ 修改 `api/StreamRenderBuffer.ts`（已正确）
3. ❌ 修改 `api/VirtualScrollManager.ts`（已正确）
4. ❌ 修改 `api/binaryFrame.ts`（已正确）
5. ❌ 修改 `crates/conex-db/src/pool.rs`（已正确）
6. ❌ 向 `useDaemonState.ts` 新增 `setInterval` 在 `useEffect` 内部（应在模块级）
7. ❌ 在 `handlePointerMove` 内增加任何 `setState` 调用
8. ❌ 向 `ChatMessageList.tsx` 的 Pretext effect deps 中加回 `containerWidth`
9. ❌ 在 `eco` tier 以外（如 `balanced`）关闭 backdrop-filter
10. ❌ 向 card ghost 的 `cssText` 中添加 `transition: width` 或 `transition: height`
