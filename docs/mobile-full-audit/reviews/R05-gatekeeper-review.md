# 第二轮战役 · R05 质量门禁与类型系统对抗复核报告

> **复核席位**：席位 R05 · 质量门禁与类型系统对抗复核席  
> **被复核报告**：`docs/mobile-full-audit/audits/05-typecheck-test-gatekeeper-audit.md`（席位 05）  
> **复核对象**：`apps/crish-mobile/` 质量门禁、单测套件、类型契约、CI/Git 钩子  
> **复核基准**：Expo SDK 57 / React Native 0.86.3 / React 19.2.3 / TypeScript 6.0.3 / Jest 29.7.0 / RNTL 14.0.1  
> **复核原则**：只读对抗复核、真实命令复现、穿透表象直击架构断层、严禁补丁思维、证据链闭环。

---

## 0 结论摘要（先给结论）

1. **原报告整体可信度高，但存在关键归因误判、补丁式建议与局部夸大**：原报告对 9 处 TypeScript 编译断裂与 12 处 React 19 `overlapping act()` 告警的排查精准，现场已通过命令 **100% 独立复现**。
2. **反补丁纠偏（坚守用户铁律 U5）**：原报告建议将 `FilesCommandError` 构造函数赋予 `retryable = false` 默认值以“向后兼容”，属于典型的**为迁就过时测试而破坏生产契约的补丁式妥协**。正确方案必须是**保持类构造函数 3 参数严格契约，彻底修改 3 处过时单测**。
3. **测试桩噪音与反向误读纠偏**：原报告将 `pairingWiring.test.ts:181` 中测试桩模拟的 `'fp-1'` 脏数据误读为“UI 缺乏拦截测试”；将 `feedBridge.test.ts:262` 专门测试容错防御的对抗用例警告反向误读为“缺乏对抗用例”，系典型的**把测试桩噪音当生产缺陷**。
4. **覆盖盲区断言校准**：原报告断言 `TimelineView.tsx` “核心组件单测全无”系**夸大**（`components.test.tsx:323-339` 已挂载并断言组件交互），真正盲区在于滑动吸底（`FOLLOW_THRESHOLD = 40`）等动态手势与事件。
5. **重大遗漏补齐**：发现 Expo Router 核心页面路由层 `apps/crish-mobile/app/`（30+ 路由文件、认证与抽屉守卫）被 `jest.config.js` 的 `collectCoverageFrom` **全量遗漏**；核心倒计时 Hook `useCountdownTick.ts` 为 **0 单测**；`typedRoutes` 未开启导致路由跳转弱类型。

---

## 1 现状还原（带 路径:行号 的证据）

### 1.1 TypeScript 门禁 9 处断裂现场还原

在 `apps/crish-mobile` 根目录下执行 `npx tsc --noEmit -p tsconfig.json`，严格捕获 9 处阻断性编译错误，与原报告完全吻合：

| 错误序号 | 文件路径与行号 | 错误码 | 现场代码与错误特征 |
| :--- | :--- | :--- | :--- |
| **TS-01** | `apps/crish-mobile/src/adapters/runtime/appRuntime.test.ts:7:1` | TS6133 | `import { connectionStore } from '@/domain/store/connectionStore';` 未读取 |
| **TS-02** | `apps/crish-mobile/src/adapters/runtime/appRuntime.test.ts:10:1` | TS6133 | `import { approvalStore } from '@/domain/store/approvalStore';` 未读取 |
| **TS-03** | `apps/crish-mobile/src/adapters/runtime/appRuntime.test.ts:11:1` | TS6133 | `import { filesStore } from '@/domain/store/filesStore';` 未读取 |
| **TS-04** | `apps/crish-mobile/src/adapters/viewmodels/useFilePreviewVm.hook.test.tsx:150:15` | TS2554 | `new FilesCommandError('file.too_large', 'too big')` 期望 3 个实参，实传 2 个 |
| **TS-05** | `apps/crish-mobile/src/adapters/viewmodels/useFilePreviewVm.hook.test.tsx:163:15` | TS2554 | `new FilesCommandError('file.binary', 'binary')` 期望 3 个实参，实传 2 个 |
| **TS-06** | `apps/crish-mobile/src/adapters/viewmodels/useFilesVm.test.ts:31:24` | TS2554 | `new FilesCommandError('not_found', 'x')` 期望 3 个实参，实传 2 个 |
| **TS-07** | `apps/crish-mobile/src/adapters/viewmodels/useFilesVm.test.ts:105:39` | TS2345 | `filesStore.getState().setSortMode('date')` 类型 '"date"' 不能赋给 'DirSortMode' |
| **TS-08** | `apps/crish-mobile/src/adapters/viewmodels/useSessionsVm.test.tsx:47:30` | TS2322 | `connectionStore.setState({ phase: 'idle' ... })` 类型 '"idle"' 不能赋给 'ConnectionPhase' |
| **TS-09** | `apps/crish-mobile/src/adapters/viewmodels/useSessionsVm.test.tsx:70:32` | TS2820 | `connectionStore.setState({ phase: 'reconnecting' })` 类型 '"reconnecting"' 不能赋给 'ConnectionPhase' |

#### 现场代码证据锚点
1. **TS6133 根源**：`apps/crish-mobile/tsconfig.json:10` 继承了根 `tsconfig.base.json:20` 的 `"noUnusedLocals": true`。在 `appRuntime.test.ts:89-103` 中，测试用例只对 `sessionStore` 和 `eventStore` 做了重置断言，漏掉了 `approvalStore` 和 `filesStore`，而 `connectionStore` 则是无用导入。
2. **TS2554 根源**：查阅 `apps/crish-mobile/src/adapters/wiring/filesRepository.ts:41-50`：
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
   生产代码配合网关命令统一执行链（`gatewayCommand.ts:15-19` 的 `CommandErrorWrapper`）将 `retryable` 设计为必填字段。生产环境唯一调用点 `GatewayFilesRepository.invoke`（`filesRepository.ts:104-106`）完全合规传入 3 参数，唯独上述三处测试桩在模拟异常时少传了第三个参数。
3. **TS2345 根源**：查阅 `apps/crish-mobile/src/domain/store/filesReducers.ts:20-21`：
   ```ts
   /** 排序模式（F4 §2.2 默认目录优先+名称序；F4-F13 P1 两种扩展） */
   export type DirSortMode = 'name' | 'mtime-desc' | 'size-desc';
   ```
   领域层 SSOT 唯一定义为 `'name' | 'mtime-desc' | 'size-desc'`。测试人员臆造字面量 `'date'` 违背契约。
4. **TS2322 / TS2820 根源**：查阅 `apps/crish-mobile/src/network/ReconnectingWsClient.ts:26` 与 `apps/crish-mobile/src/domain/store/connectionStore.ts:20-21`：
   - 网络层传输状态机：`export type WsPhase = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'dead';`
   - 领域层 UI 状态机：`export type ConnectionPhase = 'disconnected' | 'connecting' | 'ready' | 'recovering' | 'offline';`
   - 转换纯函数：`domain/pure/selectors.ts` 中 `mapWsPhase` 负责将 `'idle' -> 'disconnected'`, `'reconnecting' -> 'recovering'`。测试人员在 `useSessionsVm.test.tsx` 中直接将底层 `WsPhase` 灌入领域层 Store，造成跨层类型穿透。

---

### 1.2 React 19 `overlapping act()` 12 处告警现场与机理还原

对原报告点名的 5 个测试文件分别执行 `npx jest <文件> --runInBand`，实测统计控制台告警次数与原报告**完全一致**（累计 12 次）：

1. `src/__tests__/useSafeBack.test.tsx`：**2 次告警**（第 70、71 行连续触发点击未 await）
2. `src/presentation/ui/uiLayout.test.tsx`：**2 次告警**（第 50、51 行返回与滚动按钮连续点击未 await）
3. `src/adapters/viewmodels/useFilePreviewVm.hook.test.tsx`：**2 次告警**（第 202 行点击未 await 与第 203 行 `flush()` 内部 `act` 重叠）
4. `src/presentation/screens/screens.test.tsx`：**2 次告警**（审批流与导航按钮连击未 await）
5. `src/presentation/ui/uiPrimitives.test.tsx`：**4 次告警**（第 66-68 行按钮连击、第 129-132 行输入框交互未 await）

#### 深度运行机制锚点
- **React 19 调度器源码**：`node_modules/react/cjs/react.development.js:556-557`：
  ```js
  prevActScopeDepth !== actScopeDepth - 1 &&
    console.error(
      "You seem to have overlapping act() calls, this is not supported. Be sure to await previous act() calls before making a new one. "
    );
  ```
- **RNTL 14 类型与运行时源码**：
  查阅 `node_modules/@testing-library/react-native/dist/fire-event.d.ts:8-13`：
  ```ts
  declare function fireEvent(instance: TestInstance, eventName: EventName, ...data: unknown[]): Promise<undefined>;
  declare namespace fireEvent {
      var changeText: (instance: TestInstance, text: string) => Promise<undefined>;
      var press: (instance: TestInstance, eventProps?: EventProps) => Promise<void>;
      var scroll: (instance: TestInstance, eventProps?: EventProps) => Promise<void>;
  }
  ```
  查阅 `node_modules/@testing-library/react-native/dist/fire-event.js:82-95`：
  ```js
  async function fireEvent(instance, eventName, ...data) {
    ...
    await (0, _act.act)(() => {
      returnValue = handler(...data);
    });
    return returnValue;
  }
  ```
  在 `@testing-library/react-native@14.0.1` 中，所有 `fireEvent` 及其扩展方法**已原生改为 async 函数且内部包装了 await act(...)**。单测中若不加 `await` 连续调用，直接破坏了 React 19 严格的 `actScopeDepth` 嵌套栈深度对称性，进而泛滥报出警告。
---

### 1.3 门禁脱保与执行链现场还原

1. **根工程 `typecheck` 遗漏**：
   查阅根目录 `package.json:57`：
   ```json
   "typecheck": "tsc --noEmit -p apps/crish-desktop/tsconfig.app.json && tsc --noEmit -p apps/crish-desktop/tsconfig.node.json && tsc --noEmit -p apps/agent-workbench/tsconfig.json && tsc --noEmit -p packages/shared-types && tsc --noEmit -p packages/shared-utils && tsc --noEmit -p packages/block-paper-contract && tsc --noEmit -p packages/editor-kit && tsc --noEmit -p packages/block-paper && tsc --noEmit -p packages/conversation-flow && tsc --noEmit -p packages/plugin-import-claude-codex && tsc --noEmit -p packages/test-utils"
   ```
   根配置罗列了 11 个子项目，**独漏 `apps/crish-mobile`**！此外全仓 `npm run check:all`（`package.json:121`）与 `npm run check:desktop` 亦完全不涉及移动端。
2. **Git pre-commit 钩子失守**：
   查阅 `.husky/pre-commit:1-24` 与 `.lintstagedrc.json:1-5`：
   提交前门禁仅对暂存文件执行 `eslint --fix` 与 `prettier --write`，不跑任何 `tsc`。由于 9 处断裂均为 TypeScript 类型层面，ESLint 检查全部通过（实测 `npx eslint apps/crish-mobile` 为 0 错误），致使 broken 类型畅通无阻进入代码库。
3. **CI 覆盖率门槛脱保与关键事实纠偏**：
   查阅 `.github/workflows/ci.yml:182-184`：
   ```yaml
   - run: npm run typecheck -w @crish/crish-mobile
   - run: npm test -w @crish/crish-mobile -- --ci
   ```
   - **事实纠偏**：CI 流水线中**确实包含了 `npm run typecheck -w @crish/crish-mobile`**！若当前分支推送到远端，CI 将立即失败报错。9 处错误之所以在本地存活，是因为开发者/Agent 本地仅跑 `npm run check:all` 或依赖 pre-commit，未触及 CI。
   - **门禁漏洞确认**：CI 跑的是 `npm test` 而非 `npm run test:coverage`（`apps/crish-mobile/package.json:19` 中为 `jest --coverage`）。导致 `jest.config.js:32-39` 中设置的 `statements: 60, branches: 75, functions: 70, lines: 60` 覆盖率门槛在 CI 中从不触发拦截。
4. **架构分层巡检（depcruise）脱保**：
   查阅 `.dependency-cruiser.cjs:44-48`：
   ```js
   const LAYERS = {
     0: 'packages/(shared-types|shared-utils)',
     1: 'packages/(logger|telemetry)',
     2: 'apps/crish-desktop',
   };
   ```
   `apps/crish-mobile` 完全未被登记入 `LAYERS` 依赖分层规则，缺乏反向依赖守卫。

---

### 1.4 假绿测试与测试桩现场还原

1. **`ApprovalDetailScreen` 假绿**：
   查阅 `apps/crish-mobile/src/presentation/screens/screens.test.tsx:241-257`：
   ```tsx
   expect(view.getByText('审批')).toBeTruthy();
   fireEvent.press(view.getByTestId('approval-allow'));
   await waitFor(() =>
     expect(approvalStore.getState().outboxCount).toBeGreaterThan(0)
   );
   ```
   仅仅验证 `outboxCount > 0`。对 `toolCallId` 载荷合法性、`status` 状态流转、UI 按钮 `disabled` 防重防双击均无断言。
2. **`FilesScreen` 假绿**：
   查阅 `apps/crish-mobile/src/presentation/screens/screens.test.tsx:300-304`：
   ```tsx
   it('文件页未连接态', async () => {
     const view = await renderScreen(<FilesScreen />);
     expect(view.getByText('文件')).toBeTruthy();
     expect(view.getByText('未连接')).toBeTruthy();
   });
   ```
   纯静态文案断言，无工作区列表与目录条目渲染覆盖。
3. **`approvalHistoryScreen.test.ts` 假页面单测**：
   查阅 `apps/crish-mobile/src/presentation/screens/approvalHistoryScreen.test.ts:1-42`：
   全文件共 42 行，仅测试了行外的一个纯函数 `groupHistoryByDay`。真正的 `ApprovalHistoryScreen` 页面组件测试覆盖率为 **0%**。
4. **测试桩脏数据导致指纹警告还原**：
   查阅 `apps/crish-mobile/src/adapters/wiring/pairing/pairingWiring.test.ts:180-182`：
   ```ts
   desktopId: 'crish-desktop',
   tlsFingerprint: 'fp-1',
   ```
   测试桩注入了非 64 位十六进制字符串 `'fp-1'`，触发了 `PairingWiring.ts:639-642` 的合法防御日志：
   `console.warn('[PairingWiring] 桌面下发证书指纹格式非法（需 64 位 hex），放弃钉扎（缺口记录）')`。
   **原报告误判**：原报告误以为这是 UI 层缺乏指纹校验测试的表现，实则是单测 Mock 数据不合规污染了测试控制台。
5. **对抗测试日志误读还原**：
   查阅 `apps/crish-mobile/src/adapters/wiring/feedBridge.test.ts:262-275`：
   ```ts
   it('resume.page 缺 sessionId → 宽容跳过（mapDeviceFrame ignore，不崩溃）', async () => {
     ...
     gateway.dispatchFrame(frame('events.resume.page', { events: [...], nextAfterSequence: 1 }));
     ...
   });
   ```
   该用例正是为了验证容错跳过逻辑，因而主动触发了 `[wiring] 忽略入站动作：events.resume.page 缺 sessionId/nextAfterSequence`。原报告将其断言为“缺乏对抗用例”，系典型的反向误读。

---

## 2 问题清单

| 编号 | 位置 | 现象 | 直接原因 | 根因 | 影响 | 置信度 |
| :--- | :--- | :--- | :--- | :--- | :--- | :---: |
| **Q-01** | `src/adapters/runtime/appRuntime.test.ts:7,10,11` | TS6133 编译拦截 | 导入未在文件中消费 | 断言漏写与复制无用引用 | 阻断类型检查 | 已验证 |
| **Q-02** | `src/adapters/viewmodels/useFilePreviewVm.hook.test.tsx:150,163`、`useFilesVm.test.ts:31` | TS2554 编译拦截 | 构造入参缺失 `retryable` | 接口重构后单测未同步升级实参 | 阻断类型检查 | 已验证 |
| **Q-03** | `src/adapters/viewmodels/useFilesVm.test.ts:105` | TS2345 编译拦截 | 传入非法枚举字面量 `'date'` | 测试编写者凭臆造编码 | 阻断类型检查 | 已验证 |
| **Q-04** | `src/adapters/viewmodels/useSessionsVm.test.tsx:47,70` | TS2322/2820 编译拦截 | 跨层状态机混淆（将 `WsPhase` 写入 `connectionStore`） | 架构认知模糊，绕过领域投影纯函数 | 阻断类型检查 | 已验证 |
| **Q-05** | 5 个测试文件（12 处） | 控制台泛滥 React 19 `overlapping act()` 严重告警 | 未 `await` 异步的 `fireEvent` 调用 | RNTL 14 全面异步化与 React 19 严格栈深核对冲突 | 污染日志、掩盖真实异步时序风险 | 已验证 |
| **Q-06** | 根 `package.json:57` | 本地 `npm run typecheck` 漏掉移动端 | 脚本未配置 `apps/crish-mobile` | Monorepo 多工程门禁同步脱节 | 开发者本地检查无法发现移动端编译错误 | 已验证 |
| **Q-07** | `.husky/pre-commit` & `.lintstagedrc.json` | 提交前不校验类型 | 钩子仅配置 ESLint 与 Prettier | 缺少增量或全量类型校验守卫 | broken 类型长驱直入主干仓库 | 已验证 |
| **Q-08** | `.github/workflows/ci.yml:183` | 覆盖率阈值 60/75/70/60 形同虚设 | CI 执行 `npm test` 而非 `test:coverage` | CI 脚本未传递 `--coverage` 参数 | 无法阻断覆盖率衰退 | 已验证 |
| **Q-09** | `.dependency-cruiser.cjs:44-48` | 移动端依赖关系脱保 | `LAYERS` 映射字典未纳入移动端 | Monorepo 依赖拓扑治理遗漏 | 无法防范底层逆向引用上层 | 已验证 |
| **Q-10** | `screens.test.tsx:241-257`、`:300-304` | 假绿存在性断言 | 仅断言文本节点存在或数量大于 0 | 追求表面通过率，缺乏行为断言 | 核心业务流逻辑断裂无法被捕获 | 已验证 |
| **Q-11** | `approvalHistoryScreen.test.ts:1-42` | 假页面单测 | 文件只测 `groupHistoryByDay` 纯函数 | 页面组件本身零覆盖 | 页面崩溃隐患无法提前拦截 | 已验证 |
| **Q-12** | `src/presentation/timeline/TimelineView.tsx` | 自动吸底与手势跟随缺乏用例保障 | 无针对滚动事件与吸底状态的断言 | 列表复杂手势行为未列入测试范围 | 实时流式吸底体验易发生回归 | 已验证 |
| **Q-13** | `pairingWiring.test.ts:181` | 控制台频繁输出证书指纹格式非法警告 | 测试桩传入 `'fp-1'` 违背 64 字节 hex 契约 | 测试桩造假数据不严谨 | 干扰单测诊断与调试 | 已验证 |
| **Q-14** | `apps/crish-mobile/jest.config.js:26-31` | Expo Router 页面路由层完全脱保 | `collectCoverageFrom` 仅包含 `src/**` | 路由入口在 `app/` 目录下未被纳入统计 | 覆盖率虚高，30+ 路由文件质量失守 | 已验证 |
| **Q-15** | `src/adapters/hooks/useCountdownTick.ts` | 核心时间推进 Hook 零测试 | 全仓无针对该 Hook 的测试文件 | 基础工具 Hook 编写后未补充用例 | 倒计时推进失效无法被拦截 | 已验证 |
| **Q-16** | `apps/crish-mobile/tsconfig.json:8-9` | 页面路由路径无静态类型保障 | `typedRoutes` 被显式禁用 | 未启用 Expo Router 类型生成 | 拼写错误导致的深链与路由失效只能运行时暴露 | 已验证 |
---

## 3 逐条判定表、汇总表、遗漏项与复现摘要

### 3.1 被复核报告逐条判定表

| 编号 | 涉及位置与行号 | 被复核报告断言 | 行号核对 | 判定 | 复核分析与修订后的准确表述 | 建议修复方案评估（反补丁审查） |
| :--- | :--- | :--- | :--- | :---: | :--- | :--- |
| **TS-01** | `appRuntime.test.ts:7,10,11` | 未使用变量引发 3 处 TS6133 阻断 | 无漂移，完全吻合 | ✅ 成立 | 吻合。测试用例漏写 `approvalStore` 和 `filesStore` 重置断言，且存在无用导入。 | 合理。删除无用导入并补齐断言，完全符合反补丁与规范要求。 |
| **TS-02** | `useFilePreviewVm.hook.test.tsx:150,163`、`useFilesVm.test.ts:31` | `FilesCommandError` 构造必填 `retryable`，导致 3 处 TS2554 阻断 | 无漂移，完全吻合 | ⚠️ 部分成立 | 编译阻断现象吻合，但原报告归因为“重构未设默认值向后兼容”属于**思维偏差**。类签名的严格性是防腐手段，并非缺陷。 | ❌ **不合理（违反 U5 反补丁）**。原报告建议“在构造器加 `retryable = false` 默认值以向后兼容”，属于典型的为过时单测打补丁。**正确方案：保持生产类签名不变，修改 3 处单测显式传入 `, false`**。 |
| **TS-03** | `useFilesVm.test.ts:105` | 错误传入 `'date'`，违背 `DirSortMode` 导致 TS2345 阻断 | 无漂移，完全吻合 | ✅ 成立 | 吻合。`filesReducers.ts:21` 规定 SSOT 为 `'name' \| 'mtime-desc' \| 'size-desc'`。 | 合理。将单测实参修正为 `'mtime-desc'`，符合 SSOT 规范。 |
| **TS-04** | `useSessionsVm.test.tsx:47,70` | 状态机跨层穿透，将 `WsPhase` 写入 `ConnectionPhase` 引发 TS2322/2820 | 无漂移，完全吻合 | ✅ 成立 | 吻合。网络层 `WsPhase` 与领域层 `ConnectionPhase` 职责分离，必须通过 `mapWsPhase` 投影。 | 合理。修正单测中的赋值为合法领域态 `'disconnected'` 与 `'recovering'`。 |
| **ACT-01~05** | 5 个测试文件（见 1.2 节） | 连续调用 `fireEvent` 未 `await` 引发 12 处 `overlapping act()` 警告 | 无漂移，实测完全吻合 | ✅ 成立 | 吻合。RNTL 14 内部已全面采用异步 `await act(...)` 封装，连续裸调用破坏 React 19 `actScopeDepth`。 | 合理。全面在 `fireEvent.*` 前追加 `await`，原生态解决时序交叉，无黑魔法。 |
| **LEAK-01** | 全量单测退出时 | Worker 强退与句柄悬挂，`screens.test.tsx` 耗时超 5s 崩溃 | 现象经近期提交缓解，但隐患存在 | ⚠️ 部分成立 | 近期提交（`8c79bb440`/`fd68ccc8d`）在 `jest.setup.ts:139-146` 中增加了 `stopAccountRuntime()` 全局注销，`screens.test.tsx` 实测耗时约 7.8s 已可通过；但 RelaySocket 后台长定时器未 `.unref()` 仍需收口。 | 部分合理。需在各网络单例 teardown 中显式清理未解绑句柄。 |
| **FAKE-01** | `screens.test.tsx:241-257` | `ApprovalDetailScreen` 仅断言 `outboxCount > 0`，系假绿 | 无漂移，完全吻合 | ✅ 成立 | 吻合。测试未核实压入发件箱的数据帧 payload、未校验条目状态流转与防双击 disabled 态。 | 合理。应强化对 outbox 消息结构及 UI 禁用态的断言。 |
| **FAKE-02** | `screens.test.tsx:300-304` | `FilesScreen` 仅断言“文件”与“未连接”文案，无状态机与列表渲染 | 无漂移，完全吻合 | ✅ 成立 | 吻合。只断言了屏幕挂载的纯静态文案，对目录树渲染、工作区切换完全空白。 | 合理。需补充网络就绪后目录加载与错误重试用例。 |
| **FAKE-03** | `approvalHistoryScreen.test.ts:1-42` | 文件只测试纯函数 `groupHistoryByDay`，页面组件测试为 0% | 无漂移，完全吻合 | ✅ 成立 | 吻合。测试文件与页面同名但完全未引入 `ApprovalHistoryScreen` 组件，组件渲染与返回逻辑脱保。 | 合理。需编写组件级测试覆盖空态、SectionList 渲染及回退。 |
| **BLIND-01** | 配对业务链路 | 证书指纹非法警告频发，相机权限拒绝分支与真实状态机驱动缺失 | 引用行存在，但归因有误 | ⚠️ 部分成立 | 准确表述：相机权限拒绝未测试、页面层缺乏真实状态机驱动**成立**；但控制台指纹警告是由于 `pairingWiring.test.ts:181` **测试桩传入非法 `'fp-1'` 所致**，非生产未捕获缺陷。 | 部分合理。修正测试桩 Mock 数据，同时补齐相机受限分支。 |
| **BLIND-02** | 审批业务链路 | 断网乐观回滚、动态倒计时超期置灰、多端并发裁决测试空白 | 代码查证无相关用例 | ✅ 成立 | 吻合。审批核心交互属于高风险资产，在离线与超时边界上缺乏防回归断言。 | 合理。引入假时钟推进测试过期态，模拟网络中断验证发件箱回滚。 |
| **BLIND-03** | 时间线业务链路 | `TimelineView.tsx` 单测全无，且消息回填协议缺乏对抗测试 | 事实存在偏差 | ❌ 夸大 / 🚫 错误归因 | **夸大**：`components.test.tsx:323-339` 已引入 `<TimelineView>` 并测试了正文渲染、折叠工具组点击与状态行，非“单测全无”；**错误归因**：`events.resume.page` 警告是由对抗用例 `feedBridge.test.ts:262` 主动触发的，非缺陷。真正的盲区仅在于吸底阈值（`FOLLOW_THRESHOLD = 40`）等滚动交互。 | 修正方向：在已有 `components.test.tsx` 基础上补充滚动吸底专项用例，无需全量推翻。 |
| **GATE-01** | 根 `package.json:57` | 根目录 `typecheck` 罗列 11 个工程，唯独遗漏移动端 | 无漂移，完全吻合 | ✅ 成立 | 吻合。导致本地开发环境与 CI 全局门禁脱钩。 | 合理。在根 `typecheck` 脚本追加移动端路径。 |
| **GATE-02** | `.husky/pre-commit` | 提交前钩子仅跑 ESLint，不校验类型，broken 代码长驱直入 | 无漂移，完全吻合 | ✅ 成立 | 吻合。ESLint 不负责类型解析，导致本地提交时类型断裂逃逸。 | 合理。应在提交前引入类型把关（可纳入 `npm run check:desktop` 对等流程）。 |
| **GATE-03** | `.github/workflows/ci.yml:183` | CI 执行 `npm test` 无 `--coverage`，覆盖率阈值沦为摆设 | 无漂移，完全吻合 | ✅ 成立 | 吻合。由于缺少参数，`jest.config.js` 的 60/75/70/60 阈值从未被 CI 校验。 | 合理。将 CI 命令替换为 `npm test:coverage -w @crish/crish-mobile`。 |
| **GATE-04** | `.dependency-cruiser.cjs:44-48` | 移动端完全脱离 Monorepo 依赖拓扑分层监管 | 无漂移，完全吻合 | ✅ 成立 | 吻合。`LAYERS` 映射表中缺少移动端定义，无法拦截跨层逆向依赖。 | 合理。将 `apps/crish-mobile` 正式纳入 Layer 2 展现层规则。 |
---

### 3.2 判定汇总表与报告可信度评语

| 判定类别 | 统计数量 | 对应编号清单 |
| :--- | :---: | :--- |
| **✅ 成立** | **11 项** | TS-01, TS-03, TS-04, ACT-01~05, FAKE-01, FAKE-02, FAKE-03, BLIND-02, GATE-01, GATE-02, GATE-03, GATE-04 |
| **⚠️ 部分成立** | **3 项** | TS-02（归因与建议带补丁思维）, LEAK-01（近期有缓解，长句柄待收口）, BLIND-01（指纹告警系测试桩 Mock 所致） |
| **❌ 夸大** | **1 项** | BLIND-03（`TimelineView` 宣称“单测全无”系夸大，已有组件挂载测试） |
| **🚫 不成立 / 错误归因** | **1 项** | BLIND-03 伴生断言（将容错对抗测试主动触发的警告误判为“缺乏对抗测试”） |
| **❓ 无法验证** | **0 项** | 全部结论均可在本地静态代码与离线命令中完全闭环查证 |

> **被复核报告可信度综合评语**：  
> **该报告实测数据扎实、抓取问题敏锐度极高（尤其是精准抓获 9 处编译断裂与 12 处 act 告警），但在“生产缺陷与测试桩噪音的边界甄别”上存在浮躁误读，且在架构修复建议上潜伏妥协单测的补丁式思维。经本次复核纠偏后，可作为高价值质量整改依据。**

---

### 3.3 遗漏扫描范围与遗漏项清单

通过对 `apps/crish-mobile` 全局配置、Jest 规则、路由架构与 Hook 层的对抗性扫描，发现原报告遗漏了以下 4 项重大质量隐患：

#### 遗漏项 1：`apps/crish-mobile/app/`（Expo Router 路由层）被覆盖率配置全量脱漏
- **代码位置**：`apps/crish-mobile/jest.config.js:26-31`
- **代码现场**：
  ```js
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/__tests__/**',
    '!**/generated/**',
  ],
  ```
- **事实与影响**：Crish 移动端采用 Expo Router，所有入口页面与路由分发逻辑（包括 `app/(main)/session/[sessionId].tsx`、`app/account/*.tsx`、`app/approval/[toolCallId].tsx`、`app/_layout.tsx` 以及路由守卫 `Protected.tsx`、`RequireAccount.tsx`）共计 **30+ 个关键文件全部存放在 `app/` 目录下**。
  `collectCoverageFrom` 仅圈定了 `src/**/*.{ts,tsx}`，导致整个路由接入层、参数解构层和认证拦截层**在覆盖率报告中彻底隐形**，既无任何组件测试，也不计入覆盖率分母，构成了巨大的质量防腐漏洞！

#### 遗漏项 2：核心时间驱动 Hook `useCountdownTick.ts` 零单测
- **代码位置**：`apps/crish-mobile/src/adapters/hooks/useCountdownTick.ts:1-20`
- **事实与影响**：该 Hook 负责在前端驱动所有审批超期倒计时与时钟刷新（`useApprovalDetailVm.ts:55`、`useApprovalListVm.ts:25` 深度消费）。然而经全仓正则搜索，全仓**没有任何针对该 Hook 的测试文件**。其 `intervalMs` 步进、组件卸载时的 `clearInterval` 清理、以及 `active=false` 时的节能冻结逻辑，均处于脱保状态。

#### 遗漏项 3：Expo Router `typedRoutes` 未启用导致页面跳转弱类型
- **代码位置**：`apps/crish-mobile/tsconfig.json:8-9`、`app.json:1-30`
- **事实与影响**：配置中注释说明“`typedRoutes` 骨架期关闭”。当前移动端页面跳转（如 `router.push('/session/...')`、`router.replace('/welcome')`）完全依赖裸字符串传参。一旦路由路径重构或参数命名漂移，TypeScript 编译阶段无法提供任何静态拦截，极易引发真机 404 转场白屏。

#### 遗漏项 4：`exactOptionalPropertyTypes` 在移动端降级关闭
- **代码位置**：`apps/crish-mobile/tsconfig.json:18`
- **事实与影响**：根基座 `tsconfig.base.json:19` 严格开启了 `"exactOptionalPropertyTypes": true`，但移动端将其显式覆写为 `false`。这意味着在移动端允许将 `undefined` 赋给未显式声明包含 `undefined` 的可选字段（如 `foo?: string`），导致移动端与桌面端、共享包之间的类型严格度出现双标漂移，破坏了 Monorepo 的类型纯度。

---

### 3.4 复现命令与实际输出摘要

#### 1. TypeScript 门禁复现（执行命令：`npx tsc --noEmit -p tsconfig.json`）
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

#### 2. React 19 `overlapping act()` 告警分套件独立复现
- **`useSafeBack.test.tsx`**：捕获 2 次 `You seem to have overlapping act() calls`
- **`uiLayout.test.tsx`**：捕获 2 次 `You seem to have overlapping act() calls`
- **`useFilePreviewVm.hook.test.tsx`**：捕获 2 次 `You seem to have overlapping act() calls`
- **`screens.test.tsx`**：捕获 2 次 `You seem to have overlapping act() calls`
- **`uiPrimitives.test.tsx`**：捕获 4 次 `You seem to have overlapping act() calls`
- **复现结论**：累计捕获 12 次告警，所有用例表面均 PASS，证明警告并不阻断断言执行，但严重破坏调度纯度。
---

## 4 风险与未决问题（需用户裁决事项）

以下问题涉及系统设计哲理、覆盖率治理节奏与重构成本，特单列供用户裁决：

| 裁决事项编号 | 决策议题 | 方案 A（反补丁与严格防腐，R05 强烈推荐） | 方案 B（宽松兼容与平滑过渡） | 架构影响与风险对比 |
| :--- | :--- | :--- | :--- | :--- |
| **DEC-01** | **`FilesCommandError` 构造签名设计** | **坚守反补丁铁律**：类构造函数保持必填 `retryable: boolean`。修改 3 处单测代码补齐实参 `, false`。 | **原报告建议的妥协方案**：在构造器给默认值 `retryable: boolean = false`。单测保持传 2 参不变。 | 方案 A 保持领域契约纯正，逼迫测试编写者必须明确错误是否可重试；方案 B 属于典型的测试反向侵入生产代码打补丁（违背 U5）。 |
| **DEC-02** | **CI 覆盖率拦截门槛激活节奏** | **分步激活**：第一步在 CI 接入 `npm run test:coverage` 输出真实数据；第二步待方案席（N01~N05）补齐盲区测试后，再行卡死 `60/75/70/60`。 | **立即刚性拦截**：在本次整改中直接修改 `ci.yml` 强制要求达到 `60/75/70/60`，不达标直接红 CI。 | 当前单测存在盲区，若未补充资产即强制开启拦截，CI 快层可能立刻报红，阻塞正常交付流水线。 |
| **DEC-03** | **`apps/crish-mobile/app/` 路由层覆盖率纳管** | **立即纳管**：在 `jest.config.js` 的 `collectCoverageFrom` 中追加 `'app/**/*.{ts,tsx}'`，同步规划路由集成测试。 | **维持现状**：路由层继续排除在覆盖率统计外，仅要求各 Screen 组件在 `src/` 内维持高覆盖。 | 方案 A 真实反映项目代码全貌，但短期内会拉低整体覆盖率百分比；方案 B 维持报表好看，但存在 30+ 路由文件事实脱保风险。 |
| **DEC-04** | **Expo Router `typedRoutes` 启用时机** | **立即开启**：在 `app.json` 中打开 `experiments.typedRoutes: true`，并在本地生成类型定义，淘汰裸字符串路由跳转。 | **暂缓至下一架构波次**：维持当前静态弱类型，避免生成物对 CI 产生额外干扰。 | 方案 A 彻底根治页面跳转拼写风险，适应未来长期演进（U3）；方案 B 成本低但留下隐患。 |

---

## 5 集中验收清单（统一执行断言）

本清单用于在一大批代码重构完成后统一执行验收，杜绝“改一点测一点”的碎片化验证：

### 5.1 静态与类型系统集中验收（编译层）
- [ ] **断言 T1（TS 编译 0 阻断）**：在 `apps/crish-mobile` 目录下执行 `npx tsc --noEmit -p tsconfig.json`，退出码为 0，捕获错误数精准为 0。
- [ ] **断言 T2（根目录全局联动）**：在仓库根目录下执行 `npm run typecheck`，命令顺利执行包含 `apps/crish-mobile` 的校验链，全仓退出码为 0。
- [ ] **断言 T3（依赖拓扑规范）**：在仓库根目录执行 `npm run lint:depcruise`，移动端作为合规 Layer 2 展现层被分析，0 架构循环依赖、0 底层反向依赖。

### 5.2 自动化测试套件与控制台纯净度集中验收（运行时层）
- [ ] **断言 U1（单测全绿）**：在 `apps/crish-mobile` 下执行 `npm test`，所有单测套件全部通过（`100% passed`）。
- [ ] **断言 U2（React 19 act 调度纯净）**：在运行测试套件期间，控制台**彻底消除全部 12 处 `overlapping act()` 红色告警**。
- [ ] **断言 U3（测试进程无残留退出）**：执行测试时不抛出 `A worker process has failed to exit gracefully`，无悬挂定时器导致的 Jest 强退。
- [ ] **断言 U4（覆盖率门槛刚性生效）**：执行 `npm run test:coverage`，全局覆盖率满足且不低于 `statements: 60%, branches: 75%, functions: 70%, lines: 60%`。

### 5.3 核心业务链路资产防腐集中验收（业务契约层）
- [ ] **断言 B1（TimelineView 滚动交互覆盖）**：存在针对 `TimelineView` 的自动化测试，断言 `distance <= 40` 吸底激活与 `> 40` 释放跟随逻辑。
- [ ] **断言 B2（ApprovalHistory 页面完整渲染）**：存在 `ApprovalHistoryScreen` 组件级单测，覆盖空态文案、按日分组条目渲染与回退导航。
- [ ] **断言 B3（倒计时推进与卸载安全）**：存在针对 `useCountdownTick` 的专属单测，覆盖时间推移状态变更与 `clearInterval` 卸载释放。
- [ ] **断言 B4（证书指纹合法性严格校验）**：配对测试桩中使用 64 字节合规 hex 指纹，消除 `[PairingWiring]` 非法格式脏日志；针对非法指纹有明确的 UI 拦截提示断言。

### 5.4 Android 真机物理验收（华为 P50 现场）
- [ ] **断言 M1（零开发红黄框）**：华为 P50（Android 12）连接调试运行期间，打开应用、进入各 Tab 及会话详情页，界面无任何 React 19 / Reanimated 黄色 LogBox 警告或红色报错弹窗。
- [ ] **断言 M2（开屏与转场流畅）**：打开软件在 1 秒内完成加载并进入可交互主界面；进入各子页面无生硬卡顿或布局闪烁跳变。
- [ ] **断言 M3（视觉纯净无描边）**：真机界面完全剔除聚焦环、外发光、渐变描边等一切伪描边元素（坚决遵从 U8）。
