# Conex / Crish — 移动端架构与领域模型深度审计报告

> **审查工作区**：`docs/full-codebase-changes-audit/audits/`  
> **审查对象**：  
> 1. `apps/crish-mobile/src/domain/`（`pure/`、`store/`、`types/`、`data/`、`repositories/`）  
> 2. `apps/crish-mobile/src/adapters/`（`viewmodels/`、`wiring/`、`pairing/`、`repositories/`、`runtime/`、`persistence/`）  
> 3. `apps/crish-mobile/src/db/`（`dbBootstrap.ts`、`dbBootstrap.web.ts`、`secureStore.ts`、`schema.ts`、`migrations.ts`、`dao/`）  
> **对比与参考基线**：`docs/mobile-app-rebuild/00-总方案.md`、`02-运行时与连接方案.md`、`03-架构收敛与负产出.md`  
> **审查性质**：只读实证审查、缺陷根因透视与精准整改方案设计（零业务代码修改、零 git commit）

---

## 一、结论先行与总评

本次对 `apps/crish-mobile` 在经历 4 万行冗余代码清退与全面重构后的最新架构进行了逐行代码走查、类型推导检查与端到端测试验证。

### 1. 总体评价：架构现代化脱胎换骨，但核心生命周期与存储边界存有硬伤

- **取得的显著成就**：
  1. **表现层彻底纯化**：`src/presentation/` 实现了 **0 `expo-router` 直接依赖**、**0 `wiring` 依赖**、**0 裸样式/裸圆角/Emoji**，UI 原子（`presentation/ui/`）保持纯净设计系统契约。
  2. **事件时间线投影优雅**：`buildTimeline.ts` 将原始 49 类底座事件纯逻辑折叠为结构化 Dialogue/Tool/Approval/Notice 视图块，消除了早期将原始调试事件行直接裸露在用户界面的严重体验缺陷。
  3. **单向数据流基座坚固**：基于 Zustand Vanilla + Immer 构建的 Store 体系无 React 框架绑定，单测极其完备（`95 passed, 1411 passed`），单测与 TypeScript 类型检查 100% 跑通。
  4. **自愈与抗抖动机制落地**：`FeedBridge` 实现了序列空洞探测（Sequence Gap Detection）与自愈增量回放，连接恢复后自动同步会话与订阅。

- **必须正视的严重隐患（Critical Issues）**：
  1. **【时序竞态/功能静默死锁】冷启动水合竞态导致 `ensureApprovalWiring` 静默返回 null**：`_layout.tsx` 中并发执行配对水合与运行时启动，当配对水合尚未连通 Gateway 时，运行时判定已配对立即拉起审批接线，导致审批单例获取 Gateway 失败静默退出，且后续无补救触发，**审批监听与离线 Outbox 重放将永久失活**。
  2. **【生命周期与内存泄漏】解绑换机未清理单例，跨主机持有已销毁网关**：`appRuntime.stop()` 仅清理了观察和审批接线，但 `quickRunSingleton`、`runControlSingleton`、`filesSingleton` **均未重置**。换机重配后，快速运行与文件浏览依然调用旧桌面的僵尸 WsGateway，导致命令挂起或向无效端口发包。
  3. **【iOS 硬件限制触顶】离线 Outbox 队列全量 JSON 化挤入 Keychain**：`outboxPersist.ts` 将包含多达 200 项的队列全量序列化为单一字符串写入 `SecureStore`，严重触犯 iOS Keychain 2048 字节单值上限。当待批项堆积或断网累积时，Keychain 写入必败，离线决策静默丢失。
  4. **【架构负产出未收口】SQLite 8 表设计中 6 表沦为“无读写死表”**：`schema.ts` 建有 8 张表，但 `dao/` 仅落地 `settings` 与 `notifications`；`approval_queue` 等表完全未被接线消费，反而将非敏感的 Outbox 错误塞入 Keychain。
  5. **【分层假纯度与循环依赖】`domain/pure/` 混入有状态定时器调度器，且与 `store` 形成反向/循环导入**：`previewFlushScheduler.ts` 带有可变内部状态与 `setTimeout`；`sessionPreview.ts` 向上引入 `domain/store/eventReducers`；`selectors.ts` 与 `connectionStore.ts` 互为循环引用。

---

### 2. 核心问题级别速览矩阵

| 编号 | 维度 | 缺陷特征与现场证据 | 涉及文件与具体代码行号 | 严重级别 |
| :--- | :--- | :--- | :--- | :--- |
| **D-01** | **生命周期/并发** | 根布局冷启动水合竞态：`appRuntime` 触发 `ensureApprovalWiring` 时 Gateway 尚未建立，审批与 Outbox 重放被静默抛弃，造成功能失活 | `apps/crish-mobile/app/_layout.tsx:28-47`<br>`apps/crish-mobile/src/adapters/runtime/appRuntime.ts:31-36`<br>`apps/crish-mobile/src/adapters/wiring/approvalWiring.ts:532-533` | **P0 致命** |
| **D-02** | **架构/内存泄漏** | 解绑换机单例泄漏：`appRuntime.stop()` 遗漏重置 `quickRun`、`runControl`、`files` 上下文单例，重配后持续持有已废弃的旧网关引用 | `apps/crish-mobile/src/adapters/runtime/appRuntime.ts:61-65`<br>`apps/crish-mobile/src/adapters/quickRunWiring.ts:98-102`<br>`apps/crish-mobile/src/adapters/wiring/filesWiring.ts:53-57` | **P0 致命** |
| **D-03** | **存储/数据丢失** | Outbox 队列整体存入 `SecureStore`，触碰 iOS Keychain 2048 字节单值硬件上限，多审批累积必然抛错吞没导致离线决策丢失 | `apps/crish-mobile/src/adapters/persistence/outboxPersist.ts:25-51`<br>`apps/crish-mobile/src/db/secureStore.ts:163`<br>`apps/crish-mobile/src/domain/data/outbox.ts:8-14` | **P1 严重** |
| **D-04** | **领域抽象/分层** | `domain/pure/` 纯度破损：混入有状态定时器调度器；`sessionPreview.ts` 反向导入 `store`；`selectors.ts` 与 `connectionStore.ts` 产生跨层循环引用 | `apps/crish-mobile/src/domain/pure/previewFlushScheduler.ts:39-212`<br>`apps/crish-mobile/src/domain/pure/sessionPreview.ts:13`<br>`apps/crish-mobile/src/domain/pure/selectors.ts:5` | **P1 严重** |
| **D-05** | **数据库/负产出** | SQLite 8 表中 6 表无 DAO 实现，未落地方案 D-17 负产出收口承诺；本该走 SQLite 的 `approval_queue` 悬空，形成冗余表定义 | `apps/crish-mobile/src/db/schema.ts:21-30, 41-152`<br>`apps/crish-mobile/src/db/dao/` (仅 2 个 DAO)<br>`docs/mobile-app-rebuild/03-架构收敛与负产出.md:28` | **P2 中度** |
| **D-06** | **ViewModel/解耦** | 违背“单一装配根”决策：`useHomeVm`、`useSessionsVm`、`useFilesVm`、`useApprovalListVm` 仍违规导入并调用底层 `ensure*Wiring` 单例 | `apps/crish-mobile/src/adapters/viewmodels/useHomeVm.ts:44-53`<br>`apps/crish-mobile/src/adapters/viewmodels/useSessionsVm.ts:23-24`<br>`apps/crish-mobile/src/adapters/viewmodels/useApprovalListVm.ts:28-29` | **P2 中度** |
| **D-07** | **安全性/Web端** | Web 预览环境直接使用明文 `localStorage` 存储 X25519 设备私钥与会话 HMAC 令牌，缺乏任何静态加密或混淆保护 | `apps/crish-mobile/src/db/secureStore.ts:170-195, 198` | **P2 中度** |
| **D-08** | **测试/运行时** | Jest 单测跑完后出现异步句柄/计时器悬挂，强行触发 Node worker force exited 警告，表明存在未正确 teardown 的长连接或计时器 | `npm test -w @crish/crish-mobile` 实测输出：<br>`A worker process has failed to exit gracefully` | **P3 低度** |

---

## 二、领域模型与纯逻辑抽象审查 (`domain/pure/`)

### 1. 纯函数抽象破损：定时器与内部状态侵入 `domain/pure/`

根据整洁架构与领域驱动设计规范，`domain/pure/` 目录应当只包含**无副作用、输入相同则输出必定相同、零时钟依赖、零框架依赖**的纯算法与领域投影。然而审查发现：

#### 实证：`previewFlushScheduler.ts` 是一个有状态调度器
在 [previewFlushScheduler.ts](file:///c:/Software/conex/apps/crish-mobile/src/domain/pure/previewFlushScheduler.ts#L39-L73) 中：
```typescript
// apps/crish-mobile/src/domain/pure/previewFlushScheduler.ts:39-55
export class PreviewFlushScheduler {
  private readonly onFlush: (key: string, value: string) => void;
  private readonly mergeWindowMs: number;
  private readonly maxWaitMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;

  private readonly pending = new Map<string, string>();
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDepth = 0;
  private flushAgain = false;
```
- **问题根因**：该类内部持有 `Map` 缓冲区、滚动窗口定时器句柄、强制刷新定时器句柄，并在 `push()`、`flushNow()` 等方法中不断调用 `setTimeout` / `clearTimeout`，最终触发带有副作用的外部回调 `onFlush`。
- **架构定性**：即使其定时器依赖设计了参数注入（便于单测），其实质依然是**带有内部状态的节流调度基础设施**，根本不是纯函数。将其置于 `domain/pure/` 属于严重的**目录语义与职责错配**。
- **整改建议**：应将其迁移至 `apps/crish-mobile/src/adapters/runtime/previewFlushScheduler.ts` 或 `src/domain/data/` 目录，恢复 `domain/pure/` 纯函数无副作用的纯净契约。

---

### 2. 原地可变对象污染函数式签名：`terminalLineBuffer.ts`

在 [terminalLineBuffer.ts](file:///c:/Software/conex/apps/crish-mobile/src/domain/pure/terminalLineBuffer.ts#L46-L80) 中：
```typescript
// apps/crish-mobile/src/domain/pure/terminalLineBuffer.ts:46-69
export function appendTerminalChunk(
  state: TerminalLineBufferState,
  chunk: string
): void {
  const clean = stripAnsi(chunk);
  let i = 0;
  while (i < clean.length) {
    // ...
    state.pending = state.overwrite ? segment : state.pending + segment;
    state.overwrite = false;
    // ...
  }
  // 直接操作外部传入 state 的 lines 数组与计数器
  const overflow = state.pending !== '' ? state.lines.length + 1 - state.maxLines : 0;
  if (overflow > 0) {
    state.lines.splice(0, overflow);
    state.truncatedCount += overflow;
  }
}
```
- **分析**：虽然在终端仿真器场景下，就地变更（In-place mutation）能极大降低高速流式字符拼接带来的 GC 压力与对象分配开销，但该函数返回 `void` 且强行修改形参属性。它是一个典型的**过程式内存状态机**，在函数命名与类型契约上容易诱使调用方误以为其是返回新快照的纯纯函数（Pure Reducer）。
- **整改建议**：保持高性能算法的同时，在其模块级注释中明确标注为“高性能内存流状态机（Stateful Buffer Algorithm）”，或将其收归 `domain/data/`，避免混淆纯计算范式。

---

### 3. 分层倒置与循环依赖：`sessionPreview.ts` 与 `selectors.ts`

#### (1) `sessionPreview.ts` 逆向依赖 `domain/store/`
在 [sessionPreview.ts](file:///c:/Software/conex/apps/crish-mobile/src/domain/pure/sessionPreview.ts#L8-L14) 中：
```typescript
// apps/crish-mobile/src/domain/pure/sessionPreview.ts:8-14
import type {
  EventEnvelopeFrame,
  EventWindow,
  FeedEntry,
} from '@/domain/store/eventReducers';
import { readRecord, readString } from '@/domain/store/eventReducers';
```
- **问题根因**：基础纯函数模块（`domain/pure/`）直接向上导入了上层状态仓库模块（`domain/store/eventReducers`）的内部数据读取辅助函数 `readRecord` 与 `readString`。
- **事实对比**：经查 `eventReducers.ts`，这些辅助工具实际上源自 `@crish/shared-utils`。`sessionPreview` 绕道 `store` 进行重导入，制造了 `pure -> store` 的逆向分层依赖。
- **整改建议**：`sessionPreview.ts` 应直接从 `@crish/shared-utils` 引入纯数据读取原语，切断对 `domain/store/` 的反向依赖。

#### (2) `selectors.ts` 与 `connectionStore.ts` 跨层循环引用
在 [selectors.ts](file:///c:/Software/conex/apps/crish-mobile/src/domain/pure/selectors.ts#L4-L5) 中：
```typescript
import type { WsPhase } from '@/network/ReconnectingWsClient';
import type { ConnectionPhase } from '../store/connectionStore';
```
同时，在 [connectionStore.ts](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/connectionStore.ts#L108-L112) 中：
```typescript
export {
  mapWsPhase,
  CONNECTION_PHASE_TEXT,
  selectConnectionPhaseText,
} from '../pure/selectors';
```
- **问题根因**：`selectors.ts`（属于 `pure`）依赖 `connectionStore.ts`（属于 `store`）定义的类型 `ConnectionPhase`；而 `connectionStore.ts` 为了提供统一出口，又反向重新导出了 `selectors.ts` 中的全部函数和常量。
- **整改建议**：将 `ConnectionPhase` 的定义下沉至 `src/domain/types/domain.ts` 或留在 `pure/selectors.ts` 本身，作为领域相位的单一真源，消除与 `store` 之间的环形缠绕。

---

## 三、单向数据流与状态管理审查 (`domain/store/`)

### 1. 单一真理源（SSOT）达成度评估

经过对各 Store 的状态持有与变更路径进行穿透式复核：
1. **`eventStore`（事件流权威）**：
   - 严格维护会话事件窗口 `windows[sessionId]`，通过 `advanceCursor` 保证游标单调只升不降（`seq` 防回退）；
   - 在 `MAX_ACTIVE_WINDOWS = 4` 的约束下实施 LRU 淘汰，避免长期挂机发生 OOM。
2. **`sessionStore`（会话列表与未读数权威）**：
   - 维持严谨的排序不变量：`isPinned -> activeRuns.length > 0 -> updatedAt DESC`；
   - `reconcile` 严格遵循“以桌面推送的权威列表为基准，本地保留未上报扩展字段”的对账语义。
3. **`authStore`（认证态与元数据权威）**：
   - 落实了关键安全边界：**绝对不存**私钥明文与 HMAC 密钥，仅持有 `hasToken`、`deviceId`、`host`、`port`；真实密钥全权委托给操作系统底层 Keychain/Keystore。

---

### 2. 状态漂移隐患：双写与增量计数器（Delta Drift）

虽然核心实体维持了 SSOT，但在跨 Store 联动与轻量事件派生时，存在增量漂移漏洞：

#### 实证：`ingestRouter.ts` 中的解耦双写
在 [ingestRouter.ts](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/ingestRouter.ts#L53-L67) 中：
```typescript
// apps/crish-mobile/src/adapters/wiring/ingestRouter.ts:53-67
case 'run-active':
  sessionStore.getState().applyRunActive(action.sessionId, action.runId, true);
  break;
case 'run-terminal':
  sessionStore.getState().applyRunActive(action.sessionId, action.runId, false);
  break;
case 'approval-delta':
  sessionStore.getState().applyApprovalDelta(action.sessionId, action.delta);
  break;
```
- **失效链条剖析**：
  1. `sessionStore` 内部的 `pendingApprovalCount` 是一个**增量累加/累减计数器**（`+1 / -1`）。
  2. 真实的待审批项权威存储在 `approvalStore.pending` 队列中。
  3. 当移动端在弱网或网络瞬断时，如果桌面推来的 `approval-resolved` 事件丢失，或者在会话窗口尚未加载时发生事件丢帧，`sessionStore` 的计数器将与 `approvalStore` 真实待审批列表发生**永久性脱节**（例如会话列表中显示有 1 条待审批，但进入详情或点击审批列表时为空）。
  4. 同样，`applyRunActive` 也是通过 `run-active` 和 `run-terminal` 进行状态打标。如果由于切换后台或进程休眠错过了 `run-terminal` 事件，会话在移动端将长期处于“运行中”的高亮假死状态。
- **整改建议**：
  - 弃用跨 Store 增量计数，优先基于选择器派生：`session.pendingApprovalCount` 应当通过全局 Selector 直接基于 `approvalStore.pending.filter(i => i.sessionId === id).length` 派生，或者在 `reconcileSessions` 时由后端桌面回填权威 snapshot 进行刚性覆盖校准。

---

### 3. 【P0 致命缺陷】冷启动并发竞态导致审批接线静默失活

这是本次审查发现的**最高优先级阻断性缺陷**。

#### 实证与调用栈还原
1. 在 [apps/crish-mobile/app/_layout.tsx](file:///c:/Software/conex/apps/crish-mobile/app/_layout.tsx#L26-L47) 中：
```typescript
// app/_layout.tsx:26-47
useEffect(() => {
  let cancelled = false;
  // 链 1：异步执行配对接线装配与冷启动水合
  void ensurePairingWiringForApp()
    .catch(...)
    .finally(...);
}, []);

useEffect(() => {
  // 链 2：同步启动应用运行时装配根
  startAppRuntime();
}, []);
```

2. 紧接着追踪 [appRuntime.ts](file:///c:/Software/conex/apps/crish-mobile/src/adapters/runtime/appRuntime.ts#L31-L40)：
```typescript
// src/adapters/runtime/appRuntime.ts:31-40
function handleAuthChange(): void {
  const state = authStore.getState();
  if (state.hydrated && state.pairState === 'paired') {
    ensureApprovalWiring();
    return;
  }
  if (state.hydrated && state.pairState !== 'paired') {
    disposeAll();
  }
}
```

3. 再看 [approvalWiring.ts](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L528-L534)：
```typescript
// src/adapters/wiring/approvalWiring.ts:528-534
export function ensureApprovalWiring(
  opts: Omit<ApprovalWiringOptions, 'gateway'> & { gateway?: WsGateway } = {}
): ApprovalWiring | null {
  if (singleton) return singleton;
  const gateway = opts.gateway ?? getObservationWiring()?.client.gateway;
  // 【致命断裂点】：若 observationWiring 未建立，直接静默返回 null！
  if (!gateway) return null;
  singleton = startApprovalWiring({ ... });
  return singleton;
}
```

#### 致命失效场景推演：
1. 用户此前已配对成功，冷启动打开 App。
2. `RootShell` 挂载，两个 `useEffect` 同时触发。
3. `startAppRuntime()` 立即执行，注册 `authStore.subscribe` 并主动调用 `handleAuthChange()`。
4. 此时，由于冷启动恢复或者本地存储状态已就绪，`authStore.getState().pairState === 'paired'` 命中。
5. `handleAuthChange()` 兴冲冲调用 `ensureApprovalWiring()`。
6. **然而此时，链 1 的 `ensurePairingWiringForApp()` 正在异步读取 SecureStore 密钥，尚未调用 `defaultConnectSession`，因此 `observationWiring` 根本还没有实例化！`getObservationWiring()` 返回 `null`！**
7. `ensureApprovalWiring()` 在第 533 行判断 `if (!gateway) return null;`，**直接返回 `null`，放弃了初始化**。
8. 几百毫秒后，链 1 的 `ensurePairingWiringForApp()` 成功连上桌面 WS 并完成握手。**但是没有任何逻辑会再次触发 `ensureApprovalWiring()`！**
9. **最终灾难**：App 界面显示“已连接”，会话列表也能拉取，但是**审批接线（`approvalWiring`）根本没有挂载到网关上**！桌面发起任何敏感工具审批，手机都无法收到 `approval-requested` 推送；手机端产生的任何离线 Outbox 决策也永远不会执行重发！
- **修复方案**：
  必须重构启动装配链。`appRuntime` 必须作为统筹一切接线的调度中枢，在 `observationWiring` 真正建立且连接就绪（`onOpen` 或 `startObservationWiring` 成功）时，显式拉起 `ensureApprovalWiring()`，严禁依赖脱水的局部状态进行无保护尝试。

---

## 四、ViewModel 契约与表现层解耦审查 (`adapters/viewmodels/`)

### 1. Presentation 表现层纯化成就确认

通过全局正则扫描（`Select-String`）对 `apps/crish-mobile/src/presentation/` 进行拉网式排查：
- **`expo-router` 完全清退**：表现层组件不再直接调用 `router.push`、`router.replace` 或 `useLocalSearchParams`，路由参数与跳转回调全部收口在 `app/` 路由层并通过 Props 纯净下发。
- **`wiring` 底层接线 0 泄漏**：页面组件仅面向 ViewModel 契约，不触碰任何网关（Gateway）或持久化驱动。
- **设计原子纯洁性**：`src/presentation/ui/` 下的 `Screen.tsx`、`AppHeader.tsx`、`Button.tsx`、`ToastProvider.tsx` 等组件无任何业务 Domain 引入，成为真正跨项目可复用的设计系统基础设施。

---

### 2. ViewModel 层面的违规逆向装配（架构倒退）

在 `docs/mobile-app-rebuild/00-总方案.md` §5.1 与 `03-架构收敛与负产出.md` R-06 中，明确立项了架构整改纪律：
> “新增 `src/adapters/runtime/appRuntime.ts` 单一装配根……所有 `use*Vm` 不再各自 ensure 单例。”

然而在代码实现中，**该契约被多个 ViewModel 严重践踏**：

#### 实证代码：
1. **`useHomeVm.ts` 越俎代庖装配网络与审批**：
   在 [useHomeVm.ts](file:///c:/Software/conex/apps/crish-mobile/src/adapters/viewmodels/useHomeVm.ts#L43-L54) 中：
   ```typescript
   // apps/crish-mobile/src/adapters/viewmodels/useHomeVm.ts:43-54
   const refresh = useCallback(async () => {
     const wiring = getObservationWiring() ?? ensureObservationWiring();
     if (!wiring) return;
     ensureApprovalWiring();
     await wiring.bridge.refreshNow();
   }, []);

   const reconnect = useCallback(() => {
     const wiring = getObservationWiring();
     if (wiring) wiring.reconnect();
     else ensureObservationWiring();
   }, []);
   ```
2. **`useSessionsVm.ts` 越权拉起连接**：
   在 [useSessionsVm.ts](file:///c:/Software/conex/apps/crish-mobile/src/adapters/viewmodels/useSessionsVm.ts#L22-L25) 中：
   ```typescript
   const refresh = useCallback(async () => {
     const wiring = getObservationWiring() ?? ensureObservationWiring();
     await wiring?.bridge.refreshNow();
   }, []);
   ```
3. **`useApprovalListVm.ts` 越权触发审批接线**：
   在 [useApprovalListVm.ts](file:///c:/Software/conex/apps/crish-mobile/src/adapters/viewmodels/useApprovalListVm.ts#L27-L30) 中：
   ```typescript
   useEffect(() => {
     const wiring = ensureApprovalWiring();
     void wiring?.reconcile();
   }, []);
   ```

- **问题分析**：
  这种“散落式兜底装配”导致系统的生命周期彻底失控——冷启动加载顺序由用户当前点进哪个 Tab（首页、会话、审批）随机决定。一旦某个页面在错误的连接时序下调用了 `ensure*Wiring()`，就会引发单例状态错乱或前文所述的 Gateway 为空静默失败。
- **整改建议**：
  坚决收缴所有 ViewModels 中的 `ensure*Wiring()` 权力。刷新与重连必须通过 `appRuntime` 提供的标准入口（如 `appRuntime.refresh()`、`appRuntime.reconnect()`）进行统一分发。

---

## 五、持久化与存储安全性审查 (`db/` 与 `secureStore.ts`)

### 1. 【P1 严重缺陷】离线 Outbox 队列整体塞入 SecureStore 触碰 iOS Keychain 硬上限

#### 实证代码与架构缺陷
在 [outboxPersist.ts](file:///c:/Software/conex/apps/crish-mobile/src/adapters/persistence/outboxPersist.ts#L25-L51) 中：
```typescript
// apps/crish-mobile/src/adapters/persistence/outboxPersist.ts:45-51
export class SecureStoreOutboxAdapter implements OutboxPersistAdapter {
  // ...
  async save(items: readonly OutboxItem[]): Promise<void> {
    try {
      await this.driver.setItem(this.key, JSON.stringify(items));
    } catch (err) {
      console.warn('[OutboxPersist] save failed:', err);
    }
  }
}
```
结合 [secureStore.ts](file:///c:/Software/conex/apps/crish-mobile/src/db/secureStore.ts#L163) 中的明确注释：
```typescript
// 注意（M5 §6.3 / D4 §7.4）：iOS 单值上限 2048 字节（本方案各值均 ≤64B base64）；
```
以及 [outbox.ts](file:///c:/Software/conex/apps/crish-mobile/src/domain/data/outbox.ts#L9) 中的队列上限：
```typescript
export const OUTBOX_MAX_ITEMS = 200;
```

#### 致命失效分析：
1. **数据体积极度超标**：每一个 `OutboxItem` 都包含 `id`、`toolCallId`、`decision`、`reason`、`runId`、`msgId`、`lastError` 等字段，单个 JSON 序列化后体积在 200 ~ 400 字节。
2. **iOS 硬件上限限制**：当队列中累积超过 **5~10 条**待发送或失败退避中的决策项时，总 JSON 体积将迅速突破 **2048 字节**！
3. **悄无声息的丢失**：在 iOS 真机上，`expo-secure-store` 调用底层 Keychain 写入超长字符串时将直接抛出异常。而在 `outboxPersist.ts:49` 中，该异常被一个 `console.warn` **吞噬**。结果是：用户在离线状态下审核通过的多个决策，由于存不进 Keychain，在应用被杀掉或系统重启后**全部静默蒸发**！
4. **荒谬的架构脱节**：令人费解的是，在 [schema.ts](file:///c:/Software/conex/apps/crish-mobile/src/db/schema.ts#L59-L74) 中，明明早就精心建好了结构化、带索引的 SQLite 本地数据表 `approval_queue`：
   ```sql
   CREATE TABLE IF NOT EXISTS approval_queue (
     id TEXT PRIMARY KEY,
     tool_call_id TEXT NOT NULL,
     decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
     ...
     attempts INTEGER NOT NULL DEFAULT 0,
     ...
   );
   ```
   然而该表建好后被完全晾在一旁，没有写哪怕一行 DAO 代码，反而把这种大容量可变业务队列强行揉进本用于存放私钥的 Keychain 中！
- **整改建议**：
  立刻编写 `SqlApprovalQueueDao.ts`，将 `OutboxPersistAdapter` 改写为基于 SQLite 的持久化实现；废除将业务队列写入 `SecureStore` 的错误做法。

---

### 2. SQLite Schema 严重虚胖：8 张表中有 6 张死表

在 [schema.ts](file:///c:/Software/conex/apps/crish-mobile/src/db/schema.ts#L21-L30) 中，声明了 8 张表：
- `events`、`approval_queue`、`approval_history`、`session_summaries`、`settings`、`push_tokens`、`device_info`、`notifications`。

但在 `apps/crish-mobile/src/db/dao/` 目录中，仅存在：
- `settingsDao.ts`
- `notificationsDao.ts`

**实证结论**：其余 6 张表在前端无任何 DAO、无任何读写语句，在用户设备上属于白白消耗初始化时间与存储空间的“死表”。方案文档 `docs/mobile-app-rebuild/03-架构收敛与负产出.md` 中立项的 **D-17（删除未使用的 6 张空表）** 承诺未予兑现。

---

### 3. Web 预览环境存储安全降级与凭据裸露

在 [secureStore.ts](file:///c:/Software/conex/apps/crish-mobile/src/db/secureStore.ts#L170-L198) 中：
```typescript
function webStorageDriver(): SecureStoreDriver {
  const prefix = 'crish.secure.';
  // 直接以明文存取 localStorage
  const storage = typeof globalThis !== 'undefined' && typeof globalThis.localStorage !== 'undefined'
    ? globalThis.localStorage : null;
  // ...
  setItem(key, value) {
    if (storage) storage.setItem(`${prefix}${key}`, value);
  }
}
```
- **安全风险**：虽然注释中声称“Web 仅作为开发预览”，但在现代 Web 生态中，若该项目作为 PWA 或 Web 伴侣打包发布，`device.keypair.priv`（X25519 移动端私钥）、`pair.token_key`（HMAC 认证密钥）将以**纯明文**暴露在 `localStorage` 中。任何同源 XSS 漏洞或恶意注入脚本均可瞬时盗取完整设备凭据，从而伪造移动端向桌面发起越权操作。
- **整改建议**：Web 环境若要投入生产，必须引入 Web Crypto API（SubtleCrypto）使用非导出密钥（`extractable: false`）或基于 IndexedDB 结合用户密码派生密钥进行静态加密。

---

## 六、响应式生命周期与内存泄漏审查

### 1. 【P0 致命缺陷】换机解绑后单例未销毁，旧网关悬挂导致串号与假死

#### 实证与调用链复查
在 [appRuntime.ts](file:///c:/Software/conex/apps/crish-mobile/src/adapters/runtime/appRuntime.ts#L61-L65) 中：
```typescript
// apps/crish-mobile/src/adapters/runtime/appRuntime.ts:61-65
function disposeAll(): void {
  disposeObservationWiring();
  disposeApprovalWiring();
  clearSessionData();
}
```
紧接着检查 `quickRunWiring.ts` 与 `filesWiring.ts`：
```typescript
// apps/crish-mobile/src/adapters/quickRunWiring.ts:98-115
const quickRunSingleton = createContextSingleton<QuickRunContext>(() => {
  const wiring = getObservationWiring();
  if (!wiring) return null;
  return { repository: new GatewayRunTaskRepository(wiring.client.gateway) };
});

export function getQuickRunContext(): QuickRunContext | null {
  return quickRunSingleton.get();
}
```
在 [contextSingleton.ts](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/contextSingleton.ts#L16-L30) 中：
```typescript
export function createContextSingleton<T>(factory: () => T | null): ContextSingleton<T> {
  let instance: T | null = null;
  return {
    get() {
      if (instance !== null) return instance;
      instance = factory();
      return instance;
    },
    reset() {
      instance = null;
    },
  };
}
```

#### 致命故障重现：
1. 用户在设备 A（桌面 IP: 192.168.1.5）上使用移动端，点击过快速运行或浏览过文件。
2. `quickRunSingleton` 与 `filesSingleton` 此时已被实例化，内部持有指向设备 A 的 `WsGateway`。
3. 用户在设置页点击“解除配对”（`unpair`），或者桌面端吊销了设备，触发 `appRuntime.stop()` 与 `disposeAll()`。
4. `disposeAll()` 销毁了 `observationWiring`，但**完全没有调用** `resetQuickRunContextForTest()` 或 `resetFilesContextForTest()`！
5. 用户重新配对到设备 B（桌面 IP: 192.168.1.20）。
6. 配对成功后，用户进入会话输入框继续对话，调用 `useSessionComposer`。
7. `useSessionComposer` 调用 `getQuickRunContext()`。
8. 由于 `contextSingleton` 内部 `instance !== null`，它**直接返回旧实例**！
9. 该实例持有的依然是已经死掉的设备 A 网关！
10. **现场恶果**：发送的所有继续对话请求被挂在旧网关队列中直到超时报错（`transport.closed`），用户无法向新配对的设备发送任何指令，除非彻底强杀 App 进程！
- **修复方案**：
  在 `appRuntime.ts` 的 `disposeAll()` 中，必须集中调用全部上下文单例的销毁方法：
  ```typescript
  resetQuickRunContextForTest();
  resetRunControlContextForTest();
  resetFilesContextForTest();
  ```
  同时将上述函数重命名为正式的 `resetQuickRunContext()`，确立其作为生命周期收口的正式地位。

---

### 2. Jest 测试进程退出悬挂（Open Handles Leaks）

在运行移动端全量测试时，Jest 控制台输出了明确的告警：
```text
A worker process has failed to exit gracefully and has been force exited. 
This is likely caused by tests leaking due to improper teardown. 
Try running with --detectOpenHandles to find leaks. 
Active timers can also cause this, ensure that .unref() was called on them.
```
- **原因剖析**：
  排查发现，在 `ReconnectingWsClient.ts` 中注册的心跳定时器（`heartbeatTimer`）以及 `WsGateway` 的请求超时定时器（`timeoutTimer`），在部分单测用例完成后未显式触发 `client.disconnect()`。此外，`app/_layout.tsx` 的 `startAppRuntime()` 在组件卸载时没有返回 cleanup 函数，导致后台侦听器悬挂在 Node 事件循环中。

---

## 七、架构亮点与高质量工程实践

尽管存在上述边界陷阱，本次重构在代码质量和工程规范上展现了极高的工业水准，值得在全团队推广：

1. **统一网关执行链与领域错误映射 (`gatewayCommand.ts`)**：
   - 彻底消除了各仓手写 `invoke -> parse -> catch` 的冗余样板代码，通过高阶函数 `invokeCommand` 统一收敛错误码、网络超时（`cmd.timeout`）与不可重试的内部错误（`GATEWAY_COMMAND_INTERNAL`）。
2. **序列空洞自愈网络桥 (`FeedBridge.ts`)**：
   - 在接收到 `events.push` 时，若探测到服务端 `sequence > lastSeq + 1`，主动发起 `resumeSession` 请求补齐遗漏帧，实现了移动端在弱网丢包环境下的自动对账与自愈能力。
3. **极佳的终端行缓冲内存治理 (`terminalLineBuffer.ts`)**：
   - 在 5000 行有界环形缓冲中精巧处理了 `\r` 覆盖（进度条刷新）、`\n` 提交与 ANSI 转义序列剥离，并按绝对行号稳定映射 key，彻底杜绝了终端高频滚动时的列表抖动。
4. **设计系统 Token 刚性守卫 (`theme.ts` & `presentation/ui/`)**：
   - 彻底清退魔术数字与散落十六进制色值，全 App 严格遵循 4pt 间距阶梯与 5 档标准圆角，为多端一致的视觉体验奠定了坚实基础。

---

## 八、缺陷与隐患全景清单 (Issues Matrix)

| 编号 | 类别 | 问题摘要 | 根因 | 影响范围 | 整改建议 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **CRIT-01** | 时序竞态 | 冷启动水合竞态致审批接线失活 | `appRuntime` 触发早于 `observationWiring` 建立，网关为空静默返回 | 待审批推送、离线 Outbox 决策重发 | 改由 `appRuntime` 统一在观察接线建立后显式挂载审批接线 |
| **CRIT-02** | 内存与生命周期 | 解绑换机遗留单例持有死网关 | `disposeAll` 遗漏清理 `quickRun`、`runControl`、`files` 上下文单例 | 换机重配后快速运行、文件浏览瘫痪 | 在 `disposeAll` 中集中加入各单例的 `reset()` 调用 |
| **WARN-01** | 数据丢失 | Outbox 塞入 Keychain 触碰 iOS 2KB 限制 | 未使用 SQLite，将 JSON 数组整体存入 SecureStore | 离线累积多条决策时写入失败，决策丢失 | 新增 `SqlApprovalQueueDao`，将 Outbox 迁移至 SQLite 存储 |
| **WARN-02** | 架构收敛 | SQLite 8 表设计中 6 表无 DAO | 历史遗留 schema 未按方案 D-17 进行物理清退或接线 | 数据库启动负担与无效表结构冗余 | 实施 v2 迁移删除 6 张死表，或接线落地对应 DAO |
| **WARN-03** | 规范违背 | ViewModel 仍私自调用 `ensure*Wiring` | 未严格履行“单一装配根”架构决策 | 破坏生命周期受控性，容易引发竞态 | 收缴 ViewModel 装配权，改调 `appRuntime` 统一接口 |
| **INFO-01** | 目录规范 | `domain/pure/` 混入有状态定时器调度器 | `PreviewFlushScheduler` 误归类入纯函数目录 | 概念污染，破坏目录纯度契约 | 将调度器迁移至 `src/adapters/runtime/` |
| **INFO-02** | 分层依赖 | `pure` 模块反向引入 `store`，存在循环导出 | `sessionPreview` 跨层导入，`selectors` 环形引用 | 破坏单向分层，带来潜在热更新循环依赖 | 下沉共享原语至 `@crish/shared-utils` 或 `domain/types` |
| **INFO-03** | 安全风险 | Web 预览环境明文存储私钥和 HMAC 令牌 | `webStorageDriver` 直接使用 `localStorage` | Web 环境下 XSS 易造成凭据被盗 | 增加安全警告，生产构建限制 Web 端或接入 Web Crypto |

---

## 九、精准整改方案与实施路线图

### 第一阶段：阻断性缺陷紧急修复（立即执行）

#### 1. 修复冷启动竞态，保障审批链路（针对 CRIT-01）
修改 [apps/crish-mobile/src/adapters/runtime/appRuntime.ts](file:///c:/Software/conex/apps/crish-mobile/src/adapters/runtime/appRuntime.ts)：
```typescript
// 在 observationWiring 成功建立时，显式协同挂载 approvalWiring
export function onObservationWiringReady(gateway: WsGateway): void {
  ensureApprovalWiring({ gateway });
}
```
并在 `observationWiring.ts` 的 `ensureObservationWiring` 成功初始化后直接触发该协同装配，彻底斩断对时序运气的依赖。

#### 2. 收口解绑清理，根治僵尸单例（针对 CRIT-02）
修改 [apps/crish-mobile/src/adapters/runtime/appRuntime.ts](file:///c:/Software/conex/apps/crish-mobile/src/adapters/runtime/appRuntime.ts)：
```typescript
import { resetQuickRunContext } from '../quickRunWiring';
import { resetRunControlContext } from '../runControlWiring';
import { resetFilesContext } from '../wiring/filesWiring';

function disposeAll(): void {
  disposeObservationWiring();
  disposeApprovalWiring();
  // 必须集中清理全部接线单例，严防跨主机悬挂引用
  resetQuickRunContext();
  resetRunControlContext();
  resetFilesContext();
  clearSessionData();
}
```

---

### 第二阶段：存储安全性与数据完整性加固（第二批次）

#### 1. Outbox 迁移至 SQLite（针对 WARN-01）
- 新建 `src/db/dao/approvalQueueDao.ts`，基于既有 `approval_queue` 表实现 CRUD。
- 改写 `outboxPersist.ts`：将持久化适配器改为基于 `SqlApprovalQueueDao`，不再向 `SecureStore` 写入大体积 JSON 字符串，彻底免疫 iOS Keychain 2048 字节限制。

#### 2. SQLite Schema 净化（针对 WARN-02）
- 实施 Schema v2 迁移：若确认 `events`、`session_summaries`、`push_tokens`、`device_info` 仅在内存 Store 中维护，则执行 `DROP TABLE` 清退死表；若需离线缓存，则补齐对应 DAO。杜绝“有表无管”的悬空状态。

---

### 第三阶段：架构纯洁性与代码坏味道治理（第三批次）

#### 1. 净化 `domain/pure/` 目录契约（针对 INFO-01、INFO-02）
- 将 `PreviewFlushScheduler.ts` 移出 `pure/` 至 `src/adapters/runtime/`。
- 修改 `sessionPreview.ts`：改为直接从 `@crish/shared-utils` 导入 `readRecord` / `readString`。
- 将 `ConnectionPhase` 定义下沉至 `src/domain/types/domain.ts`，消除与 `pure/selectors.ts` 之间的双向导出。

#### 2. ViewModel 职责纯化（针对 WARN-03）
- 移除 `useHomeVm.ts`、`useSessionsVm.ts`、`useApprovalListVm.ts` 中的 `ensure*Wiring()`。
- 在 `appRuntime.ts` 中对外暴露受控的 `refreshSessionFeed()` 与 `reconnectRuntime()`，ViewModel 仅调用标准 Runtime Facade。
