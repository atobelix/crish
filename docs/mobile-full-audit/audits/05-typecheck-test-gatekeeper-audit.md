# 移动端质量门禁、测试套件与类型系统健全度专项审计报告

> **审计席位**：席位 05 · 质量门禁与类型系统健全度审计员  
> **审计对象**：`apps/crish-mobile/`（Crish 移动端伴侣应用）  
> **报告落盘路径**：`docs/mobile-full-audit/audits/05-typecheck-test-gatekeeper-audit.md`  
> **审计基准**：Expo SDK 57 / React Native 0.86.3 / React 19.2.3 / TypeScript ~6.0.3 / Jest 29.7.0 / @testing-library/react-native 14.0.1  
> **协作与纪律**：只读审计、零源码侵入、穿透表象直击架构断层、所有缺陷锚定至具体代码行与证据链。

---

## 一、审计摘要与核心结论

本次专项审计针对 `apps/crish-mobile/` 的 TypeScript 类型健全度、自动化测试套件有效性、React 19 运行时兼容性以及 Monorepo CI 门禁体系进行了全面、静态且严谨的多维度专项审计。

### 核心结论速览

1. **类型门禁实测存在 9 处刚性断裂（均在测试与 ViewModel 接入层）**：
   - 经执行 `npm --prefix apps/crish-mobile run typecheck`（`tsc --noEmit -p tsconfig.json`），系统精准捕获 9 处强类型编译拦截：
     - **TS6133（未使用变量）× 3**：`src/adapters/runtime/appRuntime.test.ts`
     - **TS2554（构造实参缺失）× 3**：`src/adapters/viewmodels/useFilePreviewVm.hook.test.tsx`（2处）+ `src/adapters/viewmodels/useFilesVm.test.ts`（1处）
     - **TS2345（枚举字面量不匹配）× 1**：`src/adapters/viewmodels/useFilesVm.test.ts`
     - **TS2322 / TS2820（状态机联合类型不匹配）× 2**：`src/adapters/viewmodels/useSessionsVm.test.tsx`
   - **断裂性质深度定性**：这 9 处编译拦截**全部位于单测代码中，生产代码本身未见语法断裂**。然而，这些断裂直接映射出三个深层次的工程管理与架构缺陷：
     - **接口重构后测试未跟进**（`FilesCommandError` 增加必填参数 `retryable`，未设默认值向后兼容）；
     - **测试编写者猜测性编码**（凭主观假想传入 `'date'`，违背领域层已确立的 `'mtime-desc'` 规范）；
     - **分层状态机概念穿透混淆**（将底层网络 Socket 的 `WsPhase` 状态字直接注入面向 UI 的 `ConnectionPhase` 领域 Store 中）。
2. **测试体系存在「全绿假象（Fake Green）」与 React 19 深度兼容性摩擦**：
   - **Babel 掩盖类型断裂**：Jest 单测实测结果表面为 `126 passed, 1718 passed`（通过率 100%）。但由于 `jest-expo` 使用 Babel 转换代码，仅做语法降级和类型擦除（Type-stripping），**不进行任何类型校验**，导致 9 处 TS 编译错误在本地单测运行时被完全隐蔽。
   - **React 19 `overlapping act()` 警告泛滥**：实测捕获到 12 处由 React 19 内部 `actScopeDepth` 嵌套深度检测引发的控制台严重告警（涉及 5 个测试文件）。根因在于单测中广泛存在**未加 `await` 的异步 `fireEvent` 调用**。
   - **资源悬挂与 Worker 强退**：测试套件运行完毕后抛出 `A worker process has failed to exit gracefully and has been force exited`，底层存在未 `.unref()` 的 10s 重连超时定时器与 RelaySocket 轮询；在 `--detectOpenHandles` 或高负载下，`screens.test.tsx` 耗时飙升至 17s 并触发 5000ms 超时崩溃。
3. **存在性断言充斥，核心业务链路存在明显覆盖盲区**：
   - 众多 UI 测试仅断言 `toBeTruthy()` 或特定文案存在，未断言任何状态机流转、发件箱 Payload 校验与失败重试逻辑。
   - 配对（Pairing）、审批（Approval）、时间线渲染（Timeline Rendering）三大业务链路，在**完整扫码握手闭环、断网乐观回滚、动态过期倒计时、高频 Delta 流式吸底**等关键场景下存在明显用例空白。
4. **CI 门禁与本地 Git 钩子存在严重结构性漏水**：
   - 根目录 `package.json` 中的 `typecheck` 脚本包含了 11 个子项目，**唯独遗漏了 `apps/crish-mobile`**；
   - 本地 `pre-commit`（Husky + lint-staged）仅跑 ESLint 与 Prettier，未做类型把关；
   - CI 虽然有 `mobile-check` 任务，但执行的是 `npm test` 而非 `npm test:coverage`，使 `jest.config.js` 中严苛声明的 60/75/70/60 覆盖率红线在 CI 中彻底沦为空架子。

---

## 二、实测捕获的 9 处 TypeScript 类型断裂排查与根因穿透

经在 `apps/crish-mobile/` 根目录执行 `tsc --noEmit -p tsconfig.json`，实测捕获的具体编译报错如下：

```text
src/adapters/runtime/appRuntime.test.ts(7,1): error TS6133: 'connectionStore' is declared but its value is never read.
src/adapters/runtime/appRuntime.test.ts(10,1): error TS6133: 'approvalStore' is declared but its value is never read.
src/adapters/runtime/appRuntime.test.ts(11,1): error TS6133: 'filesStore' is declared but its value is never read.
src/adapters/viewmodels/useFilePreviewVm.hook.test.tsx(150,15): error TS2554: Expected 3 arguments, but got 2.
src/adapters/viewmodels/useFilePreviewVm.hook.test.tsx(163,15): error TS2554: Expected 3 arguments, but got 2.
src/adapters/viewmodels/useFilesVm.test.ts(31,24): error TS2554: Expected 3 arguments, but got 2.
src/adapters/viewmodels/useFilesVm.test.ts(105,39): error TS2345: Argument of type '"date"' is not assignable to parameter of type 'DirSortMode'.
src/adapters/viewmodels/useSessionsVm.test.tsx(47,30): error TS2322: Type '"idle"' is not assignable to type 'ConnectionPhase | undefined'.
src/adapters/viewmodels/useSessionsVm.test.tsx(70,32): error TS2820: Type '"reconnecting"' is not assignable to type 'ConnectionPhase | undefined'. Did you mean '"connecting"'?
```

以下按文件与错误特征深度剖析：

---

### 1. `appRuntime.test.ts`：TS6133 未使用变量声明（3 处）

#### 代码缺陷位置
- **文件**：`apps/crish-mobile/src/adapters/runtime/appRuntime.test.ts`
- **行号**：第 7 行、第 10 行、第 11 行
- **代码片段**：
  ```ts
  // apps/crish-mobile/src/adapters/runtime/appRuntime.test.ts:5-12
  import { authStore } from '@/domain/store/authStore';
  import { accountStore } from '@/domain/store/accountStore';
  import { connectionStore } from '@/domain/store/connectionStore'; // TS6133: 未消费
  import { eventStore } from '@/domain/store/eventStore';
  import { sessionStore } from '@/domain/store/sessionStore';
  import { approvalStore } from '@/domain/store/approvalStore';     // TS6133: 未消费
  import { filesStore } from '@/domain/store/filesStore';           // TS6133: 未消费
  ```

#### 根因深度剖析（测试用例编写不彻底 vs 根配置严格检查）
1. **编译器规则继承**：移动端 `tsconfig.json` 通过 `"extends": "../../tsconfig.base.json"` 继承了全局严格编译选项 `"noUnusedLocals": true`。任何局部声明未在文件中消费即视为编译阻断。
2. **测试用例断言残缺**：
   在被测生产文件 `apps/crish-mobile/src/adapters/runtime/appRuntime.ts:28-34` 中，定义了注销清理函数：
   ```ts
   function clearSessionData(): void {
     eventStore.getState().reset();
     sessionStore.getState().reset();
     approvalStore.getState().reset();
     terminalStore.getState().clearAll();
     filesStore.getState().resetWorkspace(null);
   }
   ```
   而在对应的测试用例（`appRuntime.test.ts:89-98`）中：
   ```ts
   it('停止后清空会话数据（换机/登出不残留）', () => {
     startAppRuntime();
     sessionStore.setState({ sessions: [{ id: 's-1' }] as never });
     eventStore.setState({ windows: { 's-1': {} } as never });

     stopAppRuntime();

     expect(sessionStore.getState().sessions).toEqual([]);
     expect(eventStore.getState().windows).toEqual({});
   });
   ```
   **断裂成因**：测试编写者导入了 `approvalStore` 和 `filesStore`，原本意图验证 `clearSessionData()` 是否完整重置了各领域 Store，但随后仅写了 `sessionStore` 和 `eventStore` 的断言，漏掉了 `approvalStore` 和 `filesStore` 的复位检查；而 `connectionStore` 则是从 `appRuntime.ts` 的全局诊断面（`globalThis.__CRISH_CONNECTION_STORE__`）照搬复制过来的无用引用。

#### 精准修复建议
1. 补齐重置断言：在 `停止后清空会话数据` 测试中，补上 `approvalStore.getState().pending` 和 `filesStore.getState().dirs` 为空的断言，彻底验证领域重置；
2. 清除冗余引用：直接移除未使用的 `connectionStore` 导入。

---

### 2. `useFilePreviewVm.hook.test.tsx` 与 `useFilesVm.test.ts`：TS2554 构造实参缺失（3 处）

#### 代码缺陷位置
- **文件 1**：`apps/crish-mobile/src/adapters/viewmodels/useFilePreviewVm.hook.test.tsx:150, 163`
- **文件 2**：`apps/crish-mobile/src/adapters/viewmodels/useFilesVm.test.ts:31`
- **代码片段**：
  ```ts
  // useFilePreviewVm.hook.test.tsx:148-152
  contextRef.value = makeContext({
    readFile: jest.fn(async () => {
      throw new FilesCommandError('file.too_large', 'too big'); // TS2554: 期望 3 个实参，实传 2 个
    }),
  });

  // useFilePreviewVm.hook.test.tsx:161-165
  contextRef.value = makeContext({
    readFile: jest.fn(async () => {
      throw new FilesCommandError('file.binary', 'binary');     // TS2554: 期望 3 个实参，实传 2 个
    }),
  });

  // useFilesVm.test.ts:30-33
  it('errorCodeOf 提取 FilesCommandError code', () => {
    expect(errorCodeOf(new FilesCommandError('not_found', 'x'))).toBe( // TS2554: 期望 3 个实参，实传 2 个
      'not_found'
    );
  });
  ```

#### 根因深度剖析（底层接口重构下沉，未提供向后兼容默认参数）
1. **统一网关执行链重构**：
   在历史 R4 批次 6 重构中，为了消除 `filesRepository`、`quickRunWiring` 等处的重复异常转换代码，引入了统一执行链 `src/adapters/wiring/gatewayCommand.ts`：
   ```ts
   // apps/crish-mobile/src/adapters/wiring/gatewayCommand.ts:15-19
   export type CommandErrorWrapper<E extends Error> = (
     code: string,
     message: string,
     retryable: boolean
   ) => E;
   ```
2. **错误类构造函数强约束**：
   在 `src/adapters/wiring/filesRepository.ts:41-50` 中，`FilesCommandError` 被设计为：
   ```ts
   export class FilesCommandError extends Error {
     readonly code: string;
     readonly retryable: boolean;
     constructor(code: string, message: string, retryable: boolean) {
       super(message);
       this.name = 'FilesCommandError';
       this.code = code;
       this.retryable = retryable;
     }
   }
   ```
   **断裂成因**：构造函数声明了 3 个必填参数，而**未将 `retryable` 设置为可选默认值（如 `retryable: boolean = false`）**。重构者调整了错误类定义以配合 `CommandErrorWrapper`，但原有用例中以 2 参数形式直接 `new FilesCommandError(code, message)` 模拟抛错的代码未被统一全局检索和跟进，导致 3 处 TS2554 编译阻断。

#### 精准修复建议
1. **架构级防御（推荐，向后兼容）**：在 `filesRepository.ts:44` 中将构造函数改为带默认值形式：
   ```ts
   constructor(code: string, message: string, retryable: boolean = false) { ... }
   ```
   此举完全兼容 `CommandErrorWrapper`（可接收 3 个实参），同时为单测与手动抛错提供优雅的人机工效；
2. **用例级补全**：若维持类定义必填，则需在上述三处 `new FilesCommandError` 的末尾显式补上 `, false`。

---

### 3. `useFilesVm.test.ts`：TS2345 排序模式字面量未对齐领域 SSOT（1 处）

#### 代码缺陷位置
- **文件**：`apps/crish-mobile/src/adapters/viewmodels/useFilesVm.test.ts`
- **行号**：第 105 行
- **代码片段**：
  ```ts
  // apps/crish-mobile/src/adapters/viewmodels/useFilesVm.test.ts:104-107
  it('setSortMode 写入 store', () => {
    filesStore.getState().setSortMode('date'); // TS2345: Argument of type '"date"' is not assignable to parameter of type 'DirSortMode'
    expect(filesStore.getState().sortMode).toBe('date');
  });
  ```

#### 根因深度剖析（测试编写者主观臆造 vs 领域层强类型联合）
1. **领域层单一真源（SSOT）**：
   查阅 `apps/crish-mobile/src/domain/store/filesReducers.ts:20-21`：
   ```ts
   /** 排序模式（F4 §2.2 默认目录优先+名称序；F4-F13 P1 两种扩展） */
   export type DirSortMode = 'name' | 'mtime-desc' | 'size-desc';
   ```
   系统严格遵循 POSIX 与桌面端标准，按修改时间倒序的模式字面量为 `'mtime-desc'`。
2. **断裂成因**：测试编写者未查阅领域类型定义，凭直觉猜测了一个伪字面量 `'date'` 传入 `setSortMode`，立即被 TypeScript 的严格联合类型拦截。

#### 精准修复建议
将用例中的 `'date'` 修正为合法枚举值 `'mtime-desc'`：
```ts
filesStore.getState().setSortMode('mtime-desc');
expect(filesStore.getState().sortMode).toBe('mtime-desc');
```

---

### 4. `useSessionsVm.test.tsx`：TS2322 & TS2820 跨分层状态机概念穿透（2 处）

#### 代码缺陷位置
- **文件**：`apps/crish-mobile/src/adapters/viewmodels/useSessionsVm.test.tsx`
- **行号**：第 47 行、第 70 行
- **代码片段**：
  ```ts
  // apps/crish-mobile/src/adapters/viewmodels/useSessionsVm.test.tsx:44-50
  beforeEach(() => {
    latest = null;
    jest.clearAllMocks();
    connectionStore.setState({ phase: 'idle', lastError: null }); // TS2322: Type '"idle"' is not assignable to type 'ConnectionPhase | undefined'
    sessionStore.setState({ sessions: [] });
    eventStore.setState({ windows: {} });
  });

  // apps/crish-mobile/src/adapters/viewmodels/useSessionsVm.test.tsx:69-73
  it('phase=reconnecting 时 connected 为假', async () => {
    connectionStore.setState({ phase: 'reconnecting' });         // TS2820: Type '"reconnecting"' is not assignable to type 'ConnectionPhase | undefined'
    await render(<Probe />);
    expect(latest?.connected).toBe(false);
  });
  ```

#### 根因深度剖析（网络传输层 WsPhase 与领域层 ConnectionPhase 概念混淆）
这是本次审计中最具架构典型性的**分层概念穿透缺陷**：
1. **传输层状态机（`ReconnectingWsClient.ts`）**：
   定义底层 WebSocket 连接生命周期，所有权在 `network`：
   ```ts
   export type WsPhase = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'dead';
   ```
2. **领域层/UI 状态机（`connectionStore.ts:20-21`）**：
   定义暴露给整个前端界面的五态连接相位，所有权在 `domain/store`：
   ```ts
   export type ConnectionPhase = 'disconnected' | 'connecting' | 'ready' | 'recovering' | 'offline';
   ```
3. **分层投影映射（`domain/pure/selectors.ts:17-34`）**：
   由纯函数 `mapWsPhase` 负责传输层向领域层的无损单向投影：
   - `'idle'` $\longrightarrow$ `'disconnected'`
   - `'connecting'` $\longrightarrow$ `'connecting'`
   - `'open'` $\longrightarrow$ `'ready'`
   - `'reconnecting'` $\longrightarrow$ `'recovering'`
   - `'dead'` $\longrightarrow$ `'offline'`
4. **断裂成因**：
   测试编写者未能理解这两套状态机的架构职责划分，直接把底层网络层专用的 `'idle'` 和 `'reconnecting'` 字面量直接硬赋给了领域层的 `connectionStore`，不仅破坏了类型系统约束，也暴露出编写单测时的架构分层认知模糊。

#### 精准修复建议
严格遵从领域层 `ConnectionPhase` 的类型契约：
1. 第 47 行：将 `phase: 'idle'` 修正为初始离线态 `phase: 'disconnected'`；
2. 第 70 行：将 `phase: 'reconnecting'` 修正为领域重连态 `phase: 'recovering'`。
---

## 三、测试套件告警与 React 19 兼容性排查

### 1. React 19 `overlapping act()` 警告专项排查

在全量测试日志与单独组件用例回放中，控制台反复出现高频告警：
```text
console.error
  You seem to have overlapping act() calls, this is not supported. Be sure to await previous act() calls before making a new one.
    at popActScope (../../node_modules/react/cjs/react.development.js:556:17)
    at ../../node_modules/react/cjs/react.development.js:844:17
```

#### 涉及文件与出现频次清单
通过对输出日志的正则抽取与单套件验证，精确定位至以下 5 个测试文件（累计 12 次告警）：
1. `src/__tests__/useSafeBack.test.tsx`（2 次）
2. `src/presentation/ui/uiLayout.test.tsx`（2 次）
3. `src/adapters/viewmodels/useFilePreviewVm.hook.test.tsx`（2 次）
4. `src/presentation/screens/screens.test.tsx`（2 次）
5. `src/presentation/ui/uiPrimitives.test.tsx`（4 次）

#### React 19 调度器机理与断裂根因
查阅 `node_modules/react/cjs/react.development.js:554-560`：
```js
function popActScope(prevActQueue, prevActScopeDepth) {
  prevActScopeDepth !== actScopeDepth - 1 &&
    console.error(
      "You seem to have overlapping act() calls, this is not supported. Be sure to await previous act() calls before making a new one. "
    );
  actScopeDepth = prevActScopeDepth;
}
```
在 React 19 中，`act` 的并发安全模型进行了强校验。每次进入 `act` 时递增 `actScopeDepth`，退出时强制核对深度回退对称性。

而在 `@testing-library/react-native@14.0.1` 中，`fireEvent.press`、`fireEvent.changeText` 以及通用 `fireEvent(element, event)` **全都是异步函数（返回 Promise）**，其内部均包装了 `await act(...)`：
```js
// node_modules/@testing-library/react-native/dist/fire-event.js:82-95
async function fireEvent(instance, eventName, ...data) {
  ...
  await (0, _act.act)(() => {
    returnValue = handler(...data);
  });
  return returnValue;
}
fireEvent.press = async (instance, eventProps) => { ... await fireEvent(instance, 'press', event); };
```

#### 缺陷触发代码证据
当单测中**连续调用事件却未显式 `await`**，或者**未等待异步事件完成便立即调用另一个 `act`** 时，便会产生嵌套作用域交织：

1. **证据 A：未等待连续触发（`uiPrimitives.test.tsx:66-68` 与 `129-132`）**：
   ```tsx
   // apps/crish-mobile/src/presentation/ui/uiPrimitives.test.tsx:66-68
   fireEvent.press(view.getByText('连接')); // 未 await，异步 act 启动
   fireEvent.press(view.getByText('加载')); // 立即启动第二个 act，与前一个重叠！
   fireEvent.press(view.getByText('禁用')); // 再次重叠！
   ```
2. **证据 B：事件与后续 `flush` 竞态（`useFilePreviewVm.hook.test.tsx:202-203`）**：
   ```tsx
   // apps/crish-mobile/src/adapters/viewmodels/useFilePreviewVm.hook.test.tsx:202-203
   fireEvent.press(view.getByTestId('loadMore')); // 未 await
   await flush(); // flush() 内部包含 await act(...)，导致两个 act 作用域严重交叉！
   ```
3. **证据 C：快速连击幂等性未 `await`（`useSafeBack.test.tsx:70-71`）**：
   ```tsx
   // apps/crish-mobile/src/__tests__/useSafeBack.test.tsx:70-71
   fireEvent.press(screen.getByTestId('probe-back')); // 未 await
   fireEvent.press(screen.getByTestId('probe-back')); // 未 await
   ```

#### 精准修复方案
将上述 5 个测试文件中所有裸露的 `fireEvent.*(...)` 一律前置 `await`（用例函数必须为 `async`）：
```tsx
await fireEvent.press(view.getByText('连接'));
await fireEvent.press(view.getByText('加载'));
await fireEvent.press(view.getByText('禁用'));
```
可彻底消除全量 `overlapping act() calls` 告警。

---

### 2. 测试进程无法退出与 Worker 强杀缺陷

实测执行全量单测时，Jest 进程退出前抛出：
```text
A worker process has failed to exit gracefully and has been force exited.
This is likely caused by tests leaking due to improper teardown.
Try running with --detectOpenHandles to find leaks.
Active timers can also cause this, ensure that .unref() was called on them.
```
在追加 `--detectOpenHandles` 参数实测排查后，发现两个根因：
1. **`screens.test.tsx` 执行耗时过长与超时**：
   在单进程/内存受限环境下，`screens.test.tsx` 串行执行 8 个大屏幕组件装配，累计耗时达 17.3s，在 `SessionDetailScreen › 渲染消息 / 工具与 composer` 用例上突破了 Jest 默认的 5000ms 阈值（`Exceeded timeout of 5000 ms for a test`）；
2. **连接接线后台定时器未解绑**：
   在 `pairingController.test.ts` 与 `appRuntime.test.ts` 中，虽然 `afterEach` 清理了部分实例，但 `observationWiring` 单例内部的底层重连定时器（10s）与心跳轮询未调用 `.unref()`，阻止了 Node 事件循环自然终止。

---

## 四、假绿测试（Fake Green Tests）专项审计

「假绿测试」是指断言颗粒度过粗，测试代码仅做存在性断言（如组件未 Crash、某行文字在屏幕上出现），而**对业务状态流转、核心参数校验、离线入队内容以及异常回滚完全视而不见**的测试用例。

### 1. `ApprovalDetailScreen`：审批确认缺乏状态流与数据帧断言
- **位置**：`src/presentation/screens/screens.test.tsx:241-257`
- **代码表现**：
  ```tsx
  const view = await renderScreen(
    <ApprovalDetailScreen toolCallId="tc-1" onBack={jest.fn()} />
  );
  expect(view.getByText('审批')).toBeTruthy();
  fireEvent.press(view.getByTestId('approval-allow'));
  await waitFor(() =>
    expect(approvalStore.getState().outboxCount).toBeGreaterThan(0)
  );
  ```
- **假绿特征剖析**：
  - 点击“允许”后，测试仅验证了 `outboxCount > 0`；
  - **漏检状态**：未断言当前待审批项是否标记为 `status: 'approved'`，未断言 `decisionStatus` 是否进入暂态；
  - **漏检数据**：未断言压入离线发件箱（`outbox`）中的消息帧是否包含正确的 `toolCallId: 'tc-1'` 与决议载荷；
  - **漏检 UI 状态**：未断言按钮是否在点击后立即进入 `disabled` 或加载中，存在双击甚至多击风险。

### 2. `FilesScreen`：纯静态标签存在性断言
- **位置**：`src/presentation/screens/screens.test.tsx:300-304`
- **代码表现**：
  ```tsx
  it('文件页未连接态', async () => {
    const view = await renderScreen(<FilesScreen />);
    expect(view.getByText('文件')).toBeTruthy();
    expect(view.getByText('未连接')).toBeTruthy();
  });
  ```
- **假绿特征剖析**：
  仅断言了屏幕上挂载了“文件”和“未连接”两个词汇。组件在网络恢复连接（`phase: 'ready'`）后是否会自动拉取工作区列表、是否会渲染目录树条目，测试全无覆盖。

### 3. `approvalHistoryScreen.test.ts`：挂羊头卖狗肉的假页面单测
- **位置**：`src/presentation/screens/approvalHistoryScreen.test.ts`
- **假绿特征剖析**：
  测试套件命名为 `approvalHistoryScreen.test.ts`，但全文件仅测试了行外的一个纯函数 `groupHistoryByDay`。真正的 `ApprovalHistoryScreen` 页面组件（包括空态、SectionList 渲染、历史记录清理、返回事件等）**测试覆盖率为 0%**。

---

## 五、三大核心业务链路测试用例覆盖盲区

```mermaid
flowchart TD
    subgraph 配对链路 (Pairing)
        P1[扫码/手动输入] --> P2[ECDH 密钥协商与证书指纹钉扎]
        P2 --> P3[WsGateway 发送 pair.request]
        P3 --> P4[SecureStore 持久化凭据]
        P4 --> P5[AuthStore 切换至 paired]
        style P2 fill:#ffebee,stroke:#c62828
        style P5 fill:#ffebee,stroke:#c62828
    end

    subgraph 审批链路 (Approval)
        A1[收到 approval.requested] --> A2[渲染审批卡片/列表]
        A2 --> A3[用户滑动/点按同意]
        A3 --> A4[乐观更新 + Outbox 压栈]
        A4 --> A5[WsGateway 网络提交/离线暂存]
        style A4 fill:#ffebee,stroke:#c62828
        style A5 fill:#ffebee,stroke:#c62828
    end

    subgraph 时间线链路 (Timeline)
        T1[高频 message-delta 流] --> T2[buildSessionTimeline 聚合]
        T2 --> T3[groupToolRuns 折叠工具组]
        T3 --> T4[TimelineView 渲染]
        T4 --> T5[自动吸底与视口跟随]
        style T4 fill:#ffebee,stroke:#c62828
        style T5 fill:#ffebee,stroke:#c62828
    end
```

> 图注：标红节点为测试覆盖严重薄弱或存在盲区的环节。

### 1. 配对链路（Pairing）覆盖盲区
1. **端到端 UI 状态机驱动断言空白**：
   在 `screens.test.tsx` 中测试 `PairManualScreen` 时，传入的是一个返回静态对象 `{ ok: true }` 的假控制器。真实配对状态机 `pairMachine`（从 `idle` $\rightarrow$ `exchanging-keys` $\rightarrow$ `waiting-desktop` $\rightarrow$ `paired`）从未在页面层跑过一次真实驱动；
2. **证书指纹不合法拦截盲区**：
   实测运行中出现控制台警告：`[PairingWiring] 桌面下发证书指纹格式非法（需 64 位 hex），放弃钉扎（缺口记录）`。当桌面证书指纹异常时，移动端究竟是告警拦截还是静默降级？在 UI 层没有任何测试验证指纹校验失败后的错误提示阻断；
3. **相机授权拒绝与降级分支**：
   扫码配对页 `pairScanScreen` 对相机权限受限（`status !== 'granted'`）后的降级跳转逻辑未编写自动化测试。

### 2. 审批链路（Approval）覆盖盲区
1. **网络中断下乐观更新的失败与回滚未覆盖**：
   移动端审批操作采用乐观更新模式。一旦网络离线或网关返回不可重试错误，当前审批项如何从发件箱回滚、UI 是否提示操作失败，没有任何网络故障注入测试；
2. **动态超时（Expiration）倒计时失效**：
   审批项带有 `expiresAt` 时间戳。当页面打开期间时间越过过期点时，UI 是否会实时将按钮置灰或显示“已过期”，未通过 Jest 假时钟推进测试过；
3. **多端状态竞争（桌面已审批，手机仍在看）**：
   用户在移动端打开审批详情时，桌面端先行审批，移动端通过 WebSocket 收到 `approval.resolved` 入站事件。详情页是否能平滑响应并关闭，测试覆盖空白；
4. **高危危险级（DangerLevel 3）与滑块解锁集成缺失**：
   `SlideToConfirm` 滑块虽有状态机测试，但其与 `ApprovalDetailScreen` 的组合分支（高危强制滑动、低危允许直接点击）未在集成用例中验证。

### 3. 时间线渲染链路（Timeline Rendering）覆盖盲区
1. **`TimelineView.tsx` 核心组件单测全无**：
   作为主界面最核心的展示容器，`TimelineView.tsx` 竟然没有任何专属单测。内部的 `FOLLOW_THRESHOLD = 40` 距离计算、用户手动滑动取消自动吸底（`onFollowChange`）、以及针对尾部新消息到达时的自动吸底（`scrollToEnd`），没有任何逻辑保障；
2. **高频 Delta 流水式压力缺失**：
   AI 实时回复时每秒可能有上百个 `message-delta` 推入。现有用例仅测试了 2-3 个事件的静态数据块，对高频更新下的 React 批量更新（Batching）、列表项闪烁防抖以及吸底稳定性未做防回归测试；
3. **历史回填与非标帧丢弃**：
   测试中捕获到：`[wiring] 忽略入站动作：events.resume.page 缺 sessionId/nextAfterSequence`。表明对历史消息分页回填协议的处理缺乏对抗性用例，容易在回填乱序时丢失消息。
---

## 六、CI 门禁与质量防腐体系漏洞审计

### 1. 根目录 `package.json` 遗漏移动端工程（最大门禁漏洞）

检查根目录 `package.json:57`：
```json
"typecheck": "tsc --noEmit -p apps/crish-desktop/tsconfig.app.json && tsc --noEmit -p apps/crish-desktop/tsconfig.node.json && tsc --noEmit -p apps/agent-workbench/tsconfig.json && tsc --noEmit -p packages/shared-types && tsc --noEmit -p packages/shared-utils && tsc --noEmit -p packages/block-paper-contract && tsc --noEmit -p packages/editor-kit && tsc --noEmit -p packages/block-paper && tsc --noEmit -p packages/conversation-flow && tsc --noEmit -p packages/plugin-import-claude-codex && tsc --noEmit -p packages/test-utils"
```
**事实确认**：根目录的统一 `typecheck` 命令罗列了 11 个子项目，**独独没有配置 `apps/crish-mobile`**！
同时，全仓常用的 `npm run check:desktop`、`npm run check:all` 也完全不涵盖移动端。导致本地无论是开发者还是 AI Agent，在提交前执行根目录校验时，移动端的 9 处严重编译错误根本无法被感知。

### 2. Git 提交前钩子（Husky / lint-staged）失守

检查 `.husky/pre-commit` 与 `.lintstagedrc.json`：
```json
{
  "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
  "*.{json,yml,yaml,css}": ["prettier --write"]
}
```
**事实确认**：提交前门禁只对暂存文件跑 ESLint 规则与 Prettier 格式化，完全没有包含 `tsc`。由于这 9 处断裂均为 TypeScript 类型层面，ESLint 检查全部通过（实测 `npx eslint apps/crish-mobile` 为 0 error），导致 broken 类型长驱直入主干分支。

### 3. CI 远端流水线未激活覆盖率拦截

检查 `.github/workflows/ci.yml:172-184`：
```yaml
mobile-check:
  runs-on: ubuntu-24.04
  timeout-minutes: 20
  steps:
    - uses: actions/checkout@...
    - uses: actions/setup-node@...
    - run: npm install -g npm@11.6.2 && npm ci
    - run: npm run typecheck -w @crish/crish-mobile
    - run: npm test -w @crish/crish-mobile -- --ci
```
**事实确认**：
1. 流水线执行的是 `npm test -w @crish/crish-mobile -- --ci`，**并非带覆盖率的 `npm run test:coverage`**；
2. 虽然在 `apps/crish-mobile/jest.config.js:32-39` 中白纸黑字配置了覆盖率拦截门槛（`statements: 60, branches: 75, functions: 70, lines: 60`），但因为 CI 没带 `--coverage`，该门槛在持续集成中从未真正发挥过门禁拦截作用。

### 4. 依赖架构巡检（depcruise）脱保

检查 `.dependency-cruiser.cjs:44-48`：
```js
const LAYERS = {
  0: 'packages/(shared-types|shared-utils)',
  1: 'packages/(logger|telemetry)',
  2: 'apps/crish-desktop',
};
```
**事实确认**：`apps/crish-mobile` 完全未被纳入 Monorepo 的依赖分层巡检（Layer 2）规则中，无法拦截底层包向移动端反向依赖或跨层深路径私有调用。

---

## 七、精准修复方案与分级整改路线图

针对上述全部审计发现，给出不留死角、按优先级递进的精准工程整改路线：

### 阶段一：P0 级——立即可执行的代码级修复（消除 9 处断裂与 act 告警）

| 缺陷编号 | 涉及文件与行号 | 精准修改方案 | 预期修复效果 |
| :--- | :--- | :--- | :--- |
| **TS-01** | `src/adapters/runtime/appRuntime.test.ts:7,10,11` | 删除未使用的 `connectionStore` 引用；在清理测试中断言 `approvalStore.getState().pending` 与 `filesStore.getState().dirs` 均已重置清空 | 消除 3 处 TS6133 警告，补全生命周期单测断言 |
| **TS-02** | `src/adapters/wiring/filesRepository.ts:44` | 修改构造函数赋予默认参数：`constructor(code: string, message: string, retryable: boolean = false)` | 从架构底层根治 3 处 TS2554，完美向后兼容 |
| **TS-03** | `src/adapters/viewmodels/useFilesVm.test.ts:105` | 将 `'date'` 修正为合法排序模式字面量 `'mtime-desc'` | 消除 1 处 TS2345 编译错误 |
| **TS-04** | `src/adapters/viewmodels/useSessionsVm.test.tsx:47,70` | 将第 47 行 `phase: 'idle'` 修正为 `'disconnected'`；将第 70 行 `phase: 'reconnecting'` 修正为 `'recovering'` | 消除 TS2322 与 TS2820，理顺分层状态机契约 |
| **ACT-01** | `src/__tests__/useSafeBack.test.tsx` | 为所有 `fireEvent.press` 调用补齐 `await` | 消除 2 处 React 19 `overlapping act()` 调度告警 |
| **ACT-02** | `src/presentation/ui/uiPrimitives.test.tsx` | 为连续调用的 `fireEvent.press`、`fireEvent(..., 'focus')` 全部加上 `await` | 消除 4 处 React 19 `overlapping act()` 调度告警 |
| **ACT-03** | `src/presentation/ui/uiLayout.test.tsx` | 为第 50、51 行连续的返回与滚动按钮点击补齐 `await` | 消除 2 处 React 19 `overlapping act()` 调度告警 |
| **ACT-04** | `src/adapters/viewmodels/useFilePreviewVm.hook.test.tsx` | 为第 202 行的 `fireEvent.press` 补齐 `await`，避免与后续 `flush()` 重叠 | 消除 2 处 React 19 `overlapping act()` 调度告警 |
| **ACT-05** | `src/presentation/screens/screens.test.tsx` | 为屏幕用例中的全部 `fireEvent.*` 补齐 `await`，增加超时预算 | 消除 2 处 React 19 `overlapping act()` 告警并平抑耗时 |

---

### 阶段二：P1 级——质量门禁防腐加固（堵塞本地与 CI 漏洞）

1. **统一根目录类型门禁**：
   在根目录 `package.json` 的 `"typecheck"` 脚本末尾追加移动端：
   ```json
   "typecheck": "... && tsc --noEmit -p apps/crish-mobile/tsconfig.json"
   ```
   并在 `npm run check:all` 中包含移动端校验，防止漏网。
2. **CI 流水线启用覆盖率硬性卡点**：
   修改 `.github/workflows/ci.yml:183`：
   ```yaml
   - run: npm test:coverage -w @crish/crish-mobile -- --ci
   ```
   使 `jest.config.js` 中的 60/75/70/60 阈值成为刚性拦截门禁。
3. **架构分层巡检（depcruise）纳管**：
   在 `.dependency-cruiser.cjs` 中将 `apps/crish-mobile` 登记为合法的移动展现层，防范反向依赖与越权穿透。

---

### 阶段三：P2 级——核心链路测试资产补齐（消除假绿与盲区）

1. **新建 `TimelineView.test.tsx` 容器测试**：
   - 重点验证自动跟随阈值（`distance <= 40` 时吸底，`> 40` 时释放跟随）；
   - 验证工具调用折叠组点击事件与回调传参。
2. **补齐真正的 `ApprovalHistoryScreen.test.tsx` 页面测试**：
   - 测试完整组件渲染、条目按日分组展示、清空历史与返回动作。
3. **全面升级存在性假绿断言**：
   - 在审批用例中增加对入队 `outbox` 消息帧的结构断言；
   - 引入假时钟模拟超时，验证审批超期置灰与自动注销逻辑；
   - 模拟证书指纹校验失败场景，验证红色高危拦截提示而非静默忽略。

---

## 八、审计师终审评级与签章

| 审计维度 | 评级 | 核心研判依据 |
| :--- | :---: | :--- |
| **TypeScript 类型系统** | **及格（存在即时断裂）** | 生产代码类型设计严谨，但测试代码存在 9 处严重编译阻断，需立即收口。 |
| **自动化测试有效性** | **及格（存在全绿假象）** | 表面通过率 100%，但受 Babel 抹除类型庇护，伴生 12 处 React 19 act 调度严重告警。 |
| **核心业务链路覆盖度** | **良好（基础全、端到端缺）** | 底层纯状态机单测扎实，但在端到端 UI 交互、断网回滚与动态倒计时上覆盖薄弱。 |
| **CI 质量防腐门禁** | **高危（存在结构性漏洞）** | 根构建与 Git 钩子完全脱漏移动端，CI 缺乏覆盖率强卡点，防线存在严重漏洞。 |

**审计员**：质量门禁与类型系统健全度审计员  
**审计报告落盘时间**：2026-10-30  