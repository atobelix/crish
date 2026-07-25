# Cross-02: 冻结桥审计

## 1. 当前实现状态

### 1.1 WindowResizeBridge（主入口）

**文件**: `apps/crish-desktop/src/services/WindowResizeBridge.ts` (114 行)

- ✅ 已创建，单例模式（`getInstance()` / 私有 constructor）
- ✅ `connect()` → `connectTauri()` + `connectWebFallback()` 双通路
- ✅ `disconnect()` → `runCleanup()` + `cancelTimers()` + `frozen = false`
- ✅ `handleWindowChange()` 是核心 pulse 方法：`frozen` 锁 → `beginLayoutInteraction('window-resizing')` → 200ms debounce + 5s watchdog

**Tauri 通路**:
- `getCurrentWindow().onResize()` → `handleWindowChange()`
- `getCurrentWindow().onMoved()` → `handleWindowChange()`; 若不可用则降级为 rAF polling (screenX/screenY)

**Web 降级**:
- `window.addEventListener('resize', handler)` 被动监听

**Watchdog (5s)**:
- `WATCHDOG_MS = 5000` (行 14)
- 超时 → `console.warn('[WindowResizeBridge] watchdog fired — forced thaw')` → `endLayoutInteraction('window-resizing')` + `frozen = false`
- 防止 debounce 回调因异常未执行时永久 frozen

### 1.2 layoutAnimationStore

**文件**: `apps/crish-desktop/src/store/layoutAnimationStore.ts` (356 行)

- ✅ `'window-resizing'` 类型在 `LayoutAnimationType` 中定义（行 9）
- ✅ `TYPE_BODY_CLASSES` 包含 `'window-resizing': ['window-resizing', 'is-resizing']`（行 37）
- ✅ `STORE_MANAGED_BODY_CLASSES` 包含 `'window-resizing'`（行 50）
- ✅ `deriveFlags()` 包含 `isWindowResizing` derived flag（行 177）
- ✅ `startAnimation()` / `endAnimation()` 护 Set 引用计数隔离
- ✅ Store 级 watchdog: `MAX_FREEZE_MS = 30_000`（行 58），per-type 独立计时
- ✅ `syncBodyFromActive()` 统一管理 body class 写入（行 148-170）
- ✅ `beginLayoutInteraction()` / `endLayoutInteraction()` 全局 helper（行 333-351）
- ✅ `isLayoutFrozenNow()` 状态查询（行 354-355）

### 1.3 App.tsx 连接

**文件**: `apps/crish-desktop/src/App.tsx`

- ✅ `import { WindowResizeBridge } from './services/WindowResizeBridge'`（行 43）
- ✅ `useEffect(() => { ... bridge.connect(); return () => bridge.disconnect(); }, [])`（行 465-469）
- 注释标注: `"单一 WindowResizeBridge（store + window-resizing class）"`（行 464）

### 1.4 useResizeFreeze（订阅层）

**文件**: `apps/crish-desktop/src/hooks/useResizeFreeze.ts` (8 行)

- ✅ 已重构为直接 `useLayoutAnimationStore(SELECTOR)` 订阅 `isLayoutFrozen`
- ✅ 参数 `_debounceMs` 保留签名但已弃用（行 5）
- ✅ 被 `ChatMessageList.tsx` 使用（行 49, 554）

### 1.5 useWindowControls

**文件**: `apps/crish-desktop/src/hooks/useWindowControls.ts` (24 行)

- ✅ 不再监听 resize 事件
- ✅ 注释明确标注: "不再监听 resize 或直写 `window-resizing` class"（行 5-6）
- ✅ 仅提供 `winCtl` 函数（minimize / toggleMaximize / close）

### 1.6 useSuspendedResizeObserver

**文件**: `apps/crish-desktop/src/hooks/useSuspendedResizeObserver.ts` (67 行)

- ✅ 冻结感知型 ResizeObserver: `isLayoutFrozen` 时挂起，将终态测量注册至 catchup 队列
- ✅ 解冻后 `flushCatchupTasks()` 单次刷新
- ✅ 组件卸载时 `unregisterCatchupTask(taskKey)` 清理

### 1.7 各 beginLayoutInteraction 调用点审计

| 组件/文件 | 类型 | begin 位置 | end 位置 | finally/守卫 |
|---|---|---|---|---|
| Sidebar.tsx | `sidebar-transition` | 行 366 | 行 379 (正常) / 行 388 (cleanup) | ✅ `!settled` 守卫 |
| Sidebar.tsx | `workspace-resizing` | 行 660 | 行 726 (finally 内双 rAF) | ✅ `try/finally`（行 709-730） |
| useColumnResize.ts | `workspace-resizing` | 行 42, 121 | 行 81/87, 160/166 | ✅ try/catch + finally 模式 |
| WindowResizeBridge.ts | `window-resizing` | 行 85 | 行 89 (watchdog) / 行 96 (debounce) | ✅ 双路（watchdog + debounce） |
| useTabDrag.ts | `tab-dragging` | 行 1368 | 行 1290/1613 (`finishPointer`) | ✅ `finished` 守卫 + 三路事件绑定 |

---

## 2. 已修复项确认

### [R3-01] ✅ WindowResizeBridge 创建并接入 App.tsx
- `WindowResizeBridge` 已就位，通过 `useEffect` 在 App 层 connect/disconnect

### [R3-02] ✅ layoutAnimationStore 新增 `window-resizing` 类型
- 在 `LayoutAnimationType` union 中定义
- `TYPE_BODY_CLASSES` 映射包含 `['window-resizing', 'is-resizing']`
- `deriveFlags` 输出 `isWindowResizing` 布尔

### [R3-03] ✅ TYPE_BODY_CLASSES 包含 window-resizing
- 行 37: `'window-resizing': ['window-resizing', 'is-resizing']`

### [R3-04] ✅ 旧 useWindowLayoutFreeze 已无人调用
- `useWindowLayoutFreeze` hook 未被任何组件 import
- 仅文件自身、测试文件、以及 3 处注释引用
- 原始功能已被 `WindowResizeBridge` 取代

### [R3-05] ✅ useResizeFreeze 已重构为直接订阅 store
- 8 行精简实现，`useLayoutAnimationStore(SELECTOR)` 订阅 `isLayoutFrozen`
- 参数保留仅用于 API 兼容

### [R3-06] ✅ 所有 beginLayoutInteraction 有对称 end 路径
- 见 §1.7 表格，所有调用点均有对应 end
- 全部使用 `finally`、`!settled` 守卫或 `finished` 守卫确保对称

### [R3-07] ✅ 双重 watchdog 防御
- **WindowResizeBridge**: 5s（行 14），强制 thaw + log warn
- **layoutAnimationStore**: 30s（行 58），per-type 独立计时 + console.warn + force endAnimation
- 5s 桥级看门狗通常先触发；30s store 级是兜底

### [R3-08] ✅ useWindowControls 不再监听 resize
- 确认无 `window.addEventListener('resize', ...)` 调用
- 仅保留窗口控制函数

---

## 3. 剩余问题

### [P1] 死代码: `useWindowLayoutFreeze.ts` 未被引用

- **文件**: `src/hooks/useWindowLayoutFreeze.ts` (127 行)
- `useWindowLayoutFreeze` hook 目前 **零外部引用**
- 仅 `useWindowLayoutFreeze.test.ts` 引用其中的 `createWindowLayoutFreezeController` / `WINDOW_LAYOUT_FREEZE_END_MS` / `WINDOW_LAYOUT_FREEZE_TYPE`
- `layoutAnimationStore.ts` 注释（行 29）提及 `useWindowLayoutFreeze`，但实际功能已全部由 `WindowResizeBridge` 承担
- `useWindowControls.ts` 注释（行 5）同为旧引用

**影响**: 死代码混淆审计路径；编辑器可能提示"defined but never used"

**建议**: 
1. 若控制器测试有保留价值 → 迁至 `WindowResizeBridge.test.ts` 旁
2. 若否 → 整个文件 + 测试文件删除
3. `layoutAnimationStore.ts` 行 29 注释更新为引用 `WindowResizeBridge`

### [P2] WindowResizeBridge frozen 标志位 desync 风险

- **风险**: `handleWindowChange()` 在 `beginLayoutInteraction()` 后设置 `this.frozen = true`
- 若 `beginLayoutInteraction()` 成功但后续 `cancelTimers()` 或 `setTimeout()` 抛出异常（可能性极低），`frozen` 不会被重置
- 后果: 所有后续 resize 事件被静默丢弃（`if (this.frozen) return;`）
- Store 级 30s watchdog 会清理 body class，但 Bridge 永续阻塞

**现状风险**: 低（代码路径无同步抛出点），但缺少防御

**建议**: `handleWindowChange()` 内包裹 `try/finally`，异常时重置 `frozen = false`

### [P3] Tauri 模式下双重事件注册

- `connect()` 无条件调用 `connectWebFallback()`（行 27）
- 在 Tauri 环境中，`onResize` 和 `window.resize` 同时注册
- `frozen` 标志位阻止重入，但 debounce 周期结束后两个通路都有可能触发新周期

**影响**: 极小。仅增加短暂解冻-重新冻结的脉冲频率（<1ms 窗口），不影响功能

**建议**: `connectWebFallback()` 改为仅在 Tauri 通路不可用时注册（但非必须，由于 frozen 锁已隔离）

### [P4] WindowResizeBridge 缺少单元测试

- **文件**: 无 `WindowResizeBridge.test.ts`
- 旧 `useWindowLayoutFreeze.test.ts` 仅测 controller 逻辑，未覆盖 Bridge 的 Tauri 通路 / Web fallback / timing 组合

**建议**: 基于 `createWindowLayoutFreezeController` 的测试模式，为 `WindowResizeBridge` 补充:
  - connect/disconnect 生命周期
  - debounce timing 验证
  - watchdog 5s 超时 thaw
  - Tauri API 抛出时 Web fallback 接管

### [P5] Sidebar 拖宽的 finally 路径使用双 rAF 延迟 end

- `Sidebar.tsx` 行 724-728: `finally { requestAnimationFrame(() => { requestAnimationFrame(() => { endLayoutInteraction('workspace-resizing'); }); }); }`
- `useColumnResize.ts` 行 79-84 / 158-163: 同样的双 rAF 模式
- 理论上双 rAF 后 end 会延迟 2 frame（~32ms@60fps）

**影响**: 拖拽结束后短时过渡期内布局仍被冻结，但通常不可感知

**建议**: 可评估单 rAF 是否足够。双 rAF 原文意图是等待 CSS 过渡/布局稳定后再解除冻结。保持现状可接受。

### [P6] useResizeFreeze 的 `_debounceMs` 参数被忽略

- `useResizeFreeze(150)` 在 `ChatMessageList.tsx`（行 554）调用
- 但 `_debounceMs` 形参（行 5）已被标注为未使用

**建议**: 移除形参（breaking change，需同时修改所有调用点），或标注 `@deprecated` 并保留。当前行为不会导致 bug。

---

## 4. 修复方案

### 4.1 清理死代码（P1）

```
删除:
- src/hooks/useWindowLayoutFreeze.ts
- src/hooks/useWindowLayoutFreeze.test.ts

可选: 若测试仍有保留价值，
  将 createWindowLayoutFreezeController 测试迁至
  src/services/WindowResizeBridge.test.ts

更新注释:
- src/store/layoutAnimationStore.ts:29  "useWindowLayoutFreeze" → "WindowResizeBridge"
- src/hooks/useWindowControls.ts:5      "useWindowLayoutFreeze" → "WindowResizeBridge"
```

### 4.2 WindowResizeBridge frozen 防御（P2）

```typescript
// handleWindowChange 增加 try/finally
private handleWindowChange(): void {
  if (this.frozen) return;
  this.frozen = true;
  try {
    beginLayoutInteraction('window-resizing');
    this.cancelTimers();
    this.watchdogTimer = setTimeout(() => { ... }, this.WATCHDOG_MS);
    this.debounceTimer = setTimeout(() => { ... }, this.DEBOUNCE_MS);
  } catch (e) {
    this.frozen = false;
    console.error('[WindowResizeBridge] handleWindowChange error', e);
  }
}
```

### 4.3 补充 WindowResizeBridge 测试（P4）

```typescript
// src/services/WindowResizeBridge.test.ts
// 验证:
// - 单例模式
// - connect() 后 Tauri onResize 注册
// - Web fallback listener 注册
// - handleWindowChange → beginLayoutInteraction + debounce
// - 5s watchdog force-end
// - disconnect() 完全清理
// - duplicate resize events 被 frozen 过滤
```

---

## 5. 注意事项

### 5.1 type isolation 契约

`'window-resizing'` 和 `'workspace-resizing'` 通过 Set 引用计数隔离。结束任一类型不会误清另一类型的 body class。已在 `layoutAnimationStore.test.ts` 行 107-127 验证。

### 5.2 body class 同步顺序

`syncBodyFromActive()` 在 `startAnimation()` 和 `endAnimation()` 内均被调用（含幂等路径：重复 begin/end 时仍同步）。这是有意的设计——防止外部误清 class 后永久失步。

### 5.3 double rAF 语义

WindowResizeBridge debounce 回调（行 93-98）和 Sidebar/ColumnResize end 回调都使用双 rAF。这是为等待:
1. 第一帧: 浏览器完成当前帧渲染
2. 第二帧: CSS 过渡和布局稳定后

在 `endLayoutInteraction` 前确保布局已收敛，避免 frozen class 被移除后触发多余的 re-layout。

### 5.4 5s vs 30s 双 watchdog

| 层级 | 超时 | 机制 | 触发条件 |
|---|---|---|---|
| WindowResizeBridge | 5s | 桥内定时器 → `endLayoutInteraction` + `frozen=false` | debounce 回调未清（异常/死锁） |
| layoutAnimationStore | 30s | per-type setTimeout → `force endAnimation` + console.warn | `endAnimation` 未调（callback 丢失） |

5s 是业务层保险；30s 是平台层兜底。5s 总是先触发。

### 5.5 useWindowLayoutFreeze.test.ts 现状

该测试仍通过 CI，因为它测试的是 `createWindowLayoutFreezeController`，一个与 React 无关的纯逻辑控制器。虽然该控制器未被任何生产代码使用，但测试本身有效。若要删除源文件，必须同时迁移或删除测试。

---

## 6. 优先级建议

| 优先级 | 问题 | 影响 | 工作量 |
|---|---|---|---|
| **P1** | 死代码 `useWindowLayoutFreeze.ts` | 审计/维护噪音 | 小（删 2 文件 + 更新 2 注释） |
| **P2** | frozen 标志位 desync 风险 | 罕见但后果严重（永久 blocking） | 极小（3 行 try/finally） |
| **P3** | Tauri 双重事件 | 无功能影响 | 可忽略 |
| **P4** | 缺少 WindowResizeBridge 测试 | 回归风险 | 中（需 mock Tauri API） |
| **P5** | 双 rAF 延迟 end | ~32ms 额外冻结 | 可评审 |
| **P6** | useResizeFreeze 未用参数 | 仅 lint 提示 | 小（移除或 deprecate） |

**推荐 R4 迭代处理**: P1 + P2 → P4 → P5 → P3/P6

---

*审计日期: 2026-07-22 | 审计范围: WindowResizeBridge + layoutAnimationStore 冻结桥全覆盖 | 审计人: Cross-validate Agent*
