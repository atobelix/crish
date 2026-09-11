# 移动端全面复兴实施详案终审报告 · 负产出硬度、死代码根除与立体化验收 (Agent 2)
## —— 深入解剖 7 份可执行详案与总计划框架：删除面穿透审查、反过度设计核验与验收可判定性审计

> **战役目录**：`docs/mobile-revival-audit/`
> **报告文件**：`docs/mobile-revival-audit/plan-reviews/05-final-review-dead-code-and-verification.md`
> **终审责任人**：【详案终审 Agent 2（负产出硬度、死代码根除与立体化验收）】
> **审查对象全集**：
> - 总计划框架：[`docs/mobile-revival-audit/02-master-revival-plan.md`](../02-master-revival-plan.md)
> - 7 份可执行详案：[`plans/01-plan-dim-01-dead-code.md`](../plans/01-plan-dim-01-dead-code.md) 至 [`07-plan-dim-07-packaging.md`](../plans/07-plan-dim-07-packaging.md)
> - 前序对撞评审：[`plan-reviews/01-contract-and-overlap-review.md`](./01-contract-and-overlap-review.md) 至 [`03-feasibility-and-closure-review.md`](./03-feasibility-and-closure-review.md)
> **审计基准法则**：《主 Agent 全流程调度提示词 v3》第二阶段第 5 步规范、根目录《AGENTS.md》（§7 严禁补丁与作弊、§7.1 立体验证纪律、§8 反过度设计红线、§9 测试资产保护铁律、§12 Tooltip、§13 输入框与焦点态、§14 现代色彩空间）、反退避全文（`LOGIC_PLAN_NO_RETREAT.md`）、反过度设计红线指南（`ANTI_OVERENGINEERING_GUARDRAILS.md`）。
> **核心铁律**：**严禁修改任何业务代码**；**严禁出现任何波次/批次编号**；杜绝任何空壳套话与“整体良好”的敷衍，必须具体到文件路径、行号、符号名与可执行断言；完全不涉及笔记功能。

---

## 目录

1. [终审宗旨与审计方法论](#一终审宗旨与审计方法论)
2. [【负产出硬度与删除面审查】（逐案穿透核验）](#二负产出硬度与删除面审查逐案穿透核验)
   - 2.1 DIM-01 负产出基座：22 个死文件磁盘核验与遗漏连带暴露
   - 2.2 8 个路由单测移出真实度与测试资产 100% 保护核验
   - 2.3 SQLite 6 个空心 DAO 与 687 行单测物理核销核查
   - 2.4 7 组重复手写算法收敛真实性与潜在断层
   - 2.5 DIM-02 至 DIM-07 各维度刚性删除面横向交叉核验
3. [【反过度设计与防新死层审查】（严格对照 13 项硬性红线）](#三反过度设计与防新死层审查严格对照-13-项硬性红线)
   - 3.1 跨端审批 Outbox 机制与单机持久化架构审查（防分布式 2PC 概念异化）
   - 3.2 终端流式折叠与缓冲算法审查（对齐禁令 12/13）
   - 3.3 状态机超时与熔断机制审查（对齐禁令 9）
   - 3.4 全案 Fallback / 降级路径清算（杜绝无退场日期的隐蔽双轨）
4. [【验收标准的可判定性与防假完成审查】（杜绝脱水 Mock 与不可执行假命令）](#四验收标准的可判定性与防假完成审查杜绝脱水-mock-与不可执行假命令)
   - 4.1 致命命令缺陷暴露：DIM-02 与 DIM-03 误写 `npx vitest run apps/crish-mobile/...` 现场实证
   - 4.2 CLI 命令可执行性与退出码断言审计
   - 4.3 物理现场、状态码与端到端闭环断言审查
5. [【终审裁决与主控决议书】（Blocker / Suggestion / Risk）](#五终审裁决与主控决议书blocker--suggestion--risk)
   - 5.1 必须改（Blocker，阻断执行的三大硬伤）
   - 5.2 建议改（Suggestion，完善工程质感的三项优化）
   - 5.3 可接受风险（Risk，运行期监控点）

---

## 一、终审宗旨与审计方法论

在 Conex / Crish 项目的工程治理原则中，**“代码是负债，删除才是净资产”**不是一句修辞，而是压倒一切的工程纪律。当前移动端（`apps/crish-mobile`）遭遇的打包器 100% 崩溃、26 处 TypeScript 编译报错、路由树被单测深度污染、长连接握手 404/401 拒连、终端满 5000 行滚底死锁等危象，全部源于**历史临时补丁、过度设计死层、未接线空心 DAO、未收口的重复算法以及形式主义单测**。

本终审 Agent 2 承担战役第二阶段收官审查职责，以最严厉、最冷酷的技术标准，对总纲《02-master-revival-plan.md》与 7 份可执行详案展开**穿透磁盘、穿透 AST、穿透运行时命令的立体化审计**。任何虚报删除、漏删连带、借重构销毁测试、虚假命令或违背《ANTI_OVERENGINEERING_GUARDRAILS.md》的行为，均在此被无情捕获并直接判定阻断。

---

## 二、【负产出硬度与删除面审查】（逐案穿透核验）

### 2.1 DIM-01 负产出基座：22 个死文件磁盘核验与遗漏连带暴露

#### 1. 22 个死文件真实磁盘核对（100% 物理存在确证）
通过在 Windows 宿主环境执行物理探针核查，DIM-01 第 3.1 节所列出的 22 个文件/目录，**当前真实 100% 滞留在磁盘中，属于确凿的代码负债**：

```
[磁盘物理实测状态]
apps/crish-mobile/r2-16-crypto-polyfill.js             : 存在 (24 行，劫持 Metro)
apps/crish-mobile/lint-out.txt                         : 存在 (5 行，垃圾日志)
apps/crish-mobile/src/db/cachePolicy.ts                : 存在 (280 行，未接线 LRU 淘汰)
apps/crish-mobile/src/db/cachePolicy.test.ts           : 存在 (401 行，保护死代码的单测)
apps/crish-mobile/src/network/HttpClient.ts            : 存在 (24 行，空骨架类)
apps/crish-mobile/src/network/HttpClient.test.ts       : 存在 (28 行，保护空骨架的单测)
apps/crish-mobile/src/hooks/index.ts                   : 存在 (3 行，空目录)
apps/crish-mobile/src/domain/db/index.ts               : 存在 (4 行，空目录)
apps/crish-mobile/src/domain/services/index.ts         : 存在 (4 行，空目录)
apps/crish-mobile/app/diagnostics.tsx                  : 存在 (12 行，伪路由)
apps/crish-mobile/app/tasks.tsx                        : 存在 (12 行，伪路由)
apps/crish-mobile/app/usage.tsx                        : 存在 (12 行，伪路由)
apps/crish-mobile/app/approval-history.tsx             : 存在 (12 行，伪路由)
apps/crish-mobile/src/presentation/components/templates/PlaceholderScreen.tsx        : 存在 (42 行)
apps/crish-mobile/src/presentation/components/templates/PlaceholderScreen.test.tsx   : 存在 (32 行)
apps/crish-mobile/src/presentation/components/templates/ProtectedPlaceholder.tsx    : 存在 (21 行)
apps/crish-mobile/src/presentation/components/templates/ProtectedPlaceholder.test.tsx : 存在 (45 行)
apps/crish-mobile/src/presentation/pair/pairScanScreen.tsx       : 存在 (53 行，假扫码页)
apps/crish-mobile/src/presentation/pair/pairScanScreen.test.tsx  : 存在 (23 行，假扫码单测)
apps/crish-mobile/src/domain/repositories/mobileCommands.test.ts : 存在 (589 行，虚构单测)
apps/crish-mobile/src/adapters/settings/themeProjection.ts        : 存在 (21 行，双轨别名)
apps/crish-mobile/src/domain/types/env.ts                        : 存在 (6 行，未引用类型)
```

#### 2. 致命遗漏暴露：`src/db/index.ts` 漏删 `cachePolicy` 导出（必须改 Blocker 2A）
- **现场证据**：审阅 `apps/crish-mobile/src/db/index.ts` 第 10 行：
  ```typescript
  // apps/crish-mobile/src/db/index.ts:10
  export * from './cachePolicy';
  ```
- **断层剖析**：DIM-01 详案第 3.1 节计划物理删除 `src/db/cachePolicy.ts`，但在第 5.1 节【唯一写文件域】中，仅列出了 `src/db/dao/index.ts`，**完全遗漏了 `src/db/index.ts`**！
- **破坏性后果**：一旦物理删除 `cachePolicy.ts`，而未修改 `src/db/index.ts`，整个移动端在执行 `typecheck` 或任何打包命令时，将因 `src/db/index.ts:10` 找不到 `./cachePolicy` 模块而**直接引发编译崩溃**！
- **裁决整改要求**：DIM-01 必须将 `apps/crish-mobile/src/db/index.ts` 纳入写文件清单，在删除 `cachePolicy.ts` 的同时，立即拔除第 10 行的 `export * from './cachePolicy';`。

---

### 2.2 8 个路由单测移出真实度与测试资产 100% 保护核验

#### 1. 8 个测试文件的物理定位真实性核验
经对 `apps/crish-mobile/app/` 目录进行递归扫描，真实污染 Expo Router 动态扫描树的测试文件**不多不少严格为 8 个**：
1. `apps/crish-mobile/app/(tabs)/files.test.tsx`（66 行）
2. `apps/crish-mobile/app/(tabs)/index.test.tsx`（135 行）
3. `apps/crish-mobile/app/(tabs)/settings.test.tsx`（75 行）
4. `apps/crish-mobile/app/_layout.test.tsx`（142 行）
5. `apps/crish-mobile/app/notifications.test.tsx`（79 行）
6. `apps/crish-mobile/app/pair/manual.test.tsx`（41 行）
7. `apps/crish-mobile/app/pair/scan.test.tsx`（29 行）
8. `apps/crish-mobile/app/pair/welcome.test.tsx`（50 行）

前期独立方案 4 与方案 6 中捏造的 `sessions.test.tsx`、`approvals.test.tsx`、`terminal.test.tsx` 在 DIM-01 详案中已被彻底肃清。DIM-01 详案对这 8 个测试的迁移目标路径规划（统一落入 `src/presentation/__tests__/routes/*Route.test.tsx`）是真实可信的。

#### 2. DIM-01 与 DIM-06 在 `app/pair/scan.tsx` 上的冲突暴露（必须改 Blocker 3）
- **冲突现场**：
  - **DIM-01 规划**（第 2.1.2 节第 7 项与第 5.1 节第 17 项）：
    明确要求保护 `app/pair/scan.test.tsx`（29 行测试资产），迁移为 `src/presentation/__tests__/routes/pairScanRoute.test.tsx`，并指出“由于假占位组件 `pairScanScreen.tsx` 将被清退，本测试重构为断言进入扫码路由时优雅返回或重定向至手动输入，保持测试用例常绿”，且在 5.1 节将 `app/pair/scan.tsx` 纳入修改域；
  - **DIM-06 规划**（第 3.4 节与第 4 节图示）：
    赫然写着**“清理 apps/crish-mobile/app/pair/scan.tsx 死路由”**，试图直接将 `app/pair/scan.tsx` 物理删除！
- **破坏性后果**：
  若 DIM-06 将 `app/pair/scan.tsx` 物理销毁，则 DIM-01 迁移保留的 `pairScanRoute.test.tsx` 将因无法 `import PairScanRoute from '@/../app/pair/scan'` 发生 `Cannot find module` 致命编译错误！同时，若有任何外部 Scheme 或历史链接跳转 `crish://pair/scan`，应用将直接抛出 Unhandled Route 404 崩溃。
- **终审裁决**：
  **绝对禁止物理删除 `apps/crish-mobile/app/pair/scan.tsx`！**
  该路由必须保留为**无 UI 纯重定向契约**：
  ```tsx
  // apps/crish-mobile/app/pair/scan.tsx
  // 扫码路由重定向守卫：v1 扫码占位清退，访问该路由优雅重定向至手动输入
  import { Redirect } from 'expo-router';

  export default function PairScanRoute() {
    return <Redirect href="/pair/manual" />;
  }
  ```
  这样既彻底拔除了 `pairScanScreen.tsx` 假 UI 代码，又保证了 Expo Router 路由表的平滑稳固，使 `pairScanRoute.test.tsx` 能够断言 `<Redirect href="/pair/manual" />`，100% 兑现《AGENTS.md》§9 测试资产保护铁律。

---

### 2.3 SQLite 6 个空心 DAO 与 687 行单测物理核销核查

#### 1. 6 个 DAO 的“空心与死层”属性物理复核
审阅 `apps/crish-mobile/src/db/dbBootstrap.ts` 与 `src/domain/store/persistBootstrap.ts`：
- `dbBootstrap.ts` 中仅调用 `configureSqlitePersistence(driver)`；
- `persistBootstrap.ts` 中仅且只实例化了两个 DAO：
  ```typescript
  // persistBootstrap.ts:56-62
  configureSettingsPersistence(new SqlSettingsDao(driver));
  configureNotificationsPersistence(new DaoNotificationsPersist(new SqlNotificationsDao(driver)));
  ```
- 其余 6 个 DAO（`eventsDao.ts` 176行、`sessionSummariesDao.ts` 120行、`approvalHistoryDao.ts` 144行、`approvalQueueDao.ts` 174行、`pushTokensDao.ts` 73行、`deviceInfoDao.ts` 81行，共计 768 行代码），在全仓生产业务与接线层中**调用量严格为 0**！
- DIM-01 规划物理删除这 6 个 DAO，并同步清退专门为这 6 个死 DAO 编写的 4 个完整死单测（`eventsDao.test.ts` 105行、`approvalDao.test.ts` 189行、`approvalQueueDao.test.ts` 178行、`approvalHistoryDao.test.ts` 115行）并裁剪 `metaDao.test.ts`（约 100 行），**属于最高硬度的负产出净资产收敛，判定完全合规且彻底**。

---

### 2.4 7 组重复手写算法收敛真实性与潜在断层

#### 1. 7 组收敛真实性逐项核定
- **组 1（相对时间）**：`time.ts:formatRelativeTime` 吸收 `fileMeta.ts` 的昨天与日期逻辑。
  - **严重遗漏暴露（必须改 Blocker 2B）**：
    物理检查发现 `apps/crish-mobile/src/presentation/components/files/index.ts` 第 18 行：
    ```typescript
    // apps/crish-mobile/src/presentation/components/files/index.ts:18
    export { ... formatRelativeTime ... } from './fileMeta';
    ```
    同时 `apps/crish-mobile/src/presentation/components/files/fileMeta.test.ts:7, 125-153` 包含专门针对 `fileMeta.ts:formatRelativeTime` 的 28 行独立单测！
    DIM-01 计划直接删除 `fileMeta.ts:144-158` 的函数，但在唯一文件域中**遗漏了 `components/files/index.ts` 与 `fileMeta.test.ts`**！若不修改这两个文件，删除后 TypeScript 立即报错。必须将 `components/files/index.ts`（改为从 `@/domain/pure/time` 重导出或移除）与 `fileMeta.test.ts`（清理或重定向测试）纳入写操作域！
- **组 2（时钟时间）**：删除 `EventRow.tsx:196-200`（`formatFeedTime`）与 `approvalListScreen.tsx:32-36`（`formatHistoryTime`），收敛至 `time.ts:formatClockTime`。经核查无外部引用泄漏，判定彻底。
- **组 3（运行状态色调重大 Bug 修复）**：
  物理核查 `apps/crish-mobile/src/presentation/screens/terminalScreen.tsx:175-177`：
  ```typescript
  case 'running':
  case 'completed':
    return theme.colorSuccess; // 将 running 错误判为绿色！
  ```
  DIM-01 与 DIM-05 联合将其拔除，统一收敛至 `runDetailMeta.ts` 的 `runBadgeTone`（`running -> theme.colorInfo` 蓝色），根除了长久以来的重大认知混淆 Bug，判定彻底。
- **组 4（连接状态双轨）**：收敛 `eventStore.network`，确立 `connectionStore.phase` 单一真理源，判定彻底。
- **组 5、6、7（Base64 / SHA-256 / Hex）**：物理核查 `apps/crish-mobile/src/network/signer.ts:41-186` 确系 145 行手写 SHA-256 与 HMAC 轮常量。全面接入 `@noble/hashes` 统一标准库并删除手写轮子，判定彻底。

---

### 2.5 DIM-02 至 DIM-07 各维度刚性删除面横向交叉核验

| 详案编号 | 详案所声明的刚性删除面 | 真实代码行号 / 物理证据 | 终审核验结论 |
| :--- | :--- | :--- | :---: |
| **DIM-02** | 1. 清理 `RunDetailHeader.test.tsx` 残留的 3 处 `badge` 属性；<br>2. 清理 `filesStore.test.ts` 捏造的 `kind: 'file'` 等死字段；<br>3. 消除 Desktop 16 处深路径穿透。 | `RunDetailHeader.test.tsx:24, 58, 125`<br>`filesStore.test.ts:13`<br>`apps/crish-desktop/src/api/**` | **真实彻底**<br>静态匹配 100% 吻合 |
| **DIM-03** | 1. 清除 `ReconnectingWsClient.ts` 3 处空监听存根；<br>2. 清除 `EndpointResolver.ts` 中继死代码；<br>3. 清除 `secureStore.ts` 未引用的 Nonce 读写接口与测试。 | `ReconnectingWsClient.ts:538-546`<br>`EndpointResolver.ts:18, 39-45`<br>`secureStore.ts:163-182` | **真实彻底**<br>无业务引用 |
| **DIM-04** | 1. 清除 `approvalWiring.ts` 内存态占位注释与重复命令构造；<br>2. 移除 `outboxState.replaying` 死状态与函数；<br>3. 清除 `approvalReducers.ts` 残留 Mock 助手；<br>4. 收敛双轨 `decisionBusy`；<br>5. 清除 `useApprovalDetailVm.ts` 违规重导出垫片。 | `approvalWiring.ts:72, 97-141`<br>`outbox.ts:43, 178-183`<br>`approvalStore.ts:175-183`<br>`useApprovalDetailVm.ts:18-25` | **真实彻底**<br>彻底消除双轨 |
| **DIM-05** | 1. 彻底删除 `terminalScreen.tsx` 双真理 fallback 与 $O(N)$ 遍历；<br>2. 全仓核销死契约 `tool-update`（5 处残留）；<br>3. 物理核销死函数 `replaceAllTerminalText` 与 `stripAnsiDetailed`；<br>4. 拔除 chunk 边界提前裁剪最旧行的脆弱逻辑。 | `terminalScreen.tsx:68-87`<br>`EventRow.tsx:36, 62, 124`<br>`terminalLineBuffer.ts:83-94`<br>`terminalLineBuffer.ts:74-80` | **真实彻底**<br>架构净收益高 |
| **DIM-06** | 1. 物理删除 7 处页面手写返回键 JSX 与 styles；<br>2. 删除 `fileMeta.ts` 5 处硬编码 Hex 色值；<br>3. 拔除 `WorkspaceSwitcher.tsx` 对 RN 原生 `Modal` 的引用；<br>4. 清理 `themeProjection.ts` 双轨别名。 | 7 大页面组件<br>`fileMeta.ts:118-126`<br>`WorkspaceSwitcher.tsx:17`<br>8 个消费文件 | **真实彻底**<br>（但须阻止误删 scan.tsx） |
| **DIM-07** | 1. 强制清理 `.expo/`、`dist/`、`android/`、`ios/` 脏缓存；<br>2. 消除代码中隐式依赖 Expo Go 容器的原生假定；<br>3. 清除 package.json 未对齐依赖。 | `package.json`<br>`app.json` | **真实彻底**<br>工程底座干净 |

---

## 三、【反过度设计与防新死层审查】（严格对照 13 项硬性红线）

对照仓库根目录 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md) 进行全维度逐条审验：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ANTI_OVERENGINEERING_GUARDRAILS 审验矩阵                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ 禁令 1: 严禁跨平台 OS 内核级沙盒 (Seatbelt/Seccomp)      │ ✅ 100% 合规 (零涉及)     │
│ 禁令 2: 严禁 Rust 无锁环形缓冲区 (sab_ring_buffer)       │ ✅ 100% 合规 (零引入)     │
│ 禁令 3: 严禁单机桌面引入分布式共识与 2PC                │ ⚠️ 需纠偏术语 (见 3.1)    │
│ 禁令 4: 严禁后台自动切换模型 (DynamicModelRouter)        │ ✅ 100% 合规 (零涉及)     │
│ 禁令 5: 严禁出站请求前发起 DNS A/AAAA 解析               │ ✅ 100% 合规 (仅 URL 拼装)│
│ 禁令 6: 严禁黑盒 Prompt 意图重写与拦截链                 │ ✅ 100% 合规 (指令透传)   │
│ 禁令 7: 上下文全链路可审计与单一真理源 (SSOT)            │ ✅ 100% 坚守并拔除双轨   │
│ 禁令 8: 多 Provider 凭据零残留与安全隔离                 │ ✅ 100% 合规 (SecureStore)│
│ 禁令 9: 严禁全系统滑动窗口断路器 (CircuitBreaker)        │ ⚠️ 需纠偏术语 (见 3.3)    │
│ 禁令 10: 严禁 Tool 执行 6 阶段洋葱 Hook 链              │ ✅ 100% 合规 (仅前后双锚点)│
│ 禁令 11: 严禁同进程微服务套娃与 IPC 嵌套路由            │ ✅ 100% 合规 (直调 Backend)│
│ 禁令 12: 严禁高频流式穿透全局 Store 与盲目 React.memo    │ ✅ 100% 坚守增量就地折叠 │
│ 禁令 13: 严禁移动端全量 CRDT 状态向量与无界同步          │ ✅ 100% 坚守有界轻量 Frame│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 跨端审批 Outbox 机制与单机持久化架构审查（防分布式 2PC 概念异化）
- **审查事实**：
  在 DIM-04 详案中，详案作者使用了“双阶段确认机制（阶段一：发送确认 Transport ACK；阶段二：事实确认 Event Confirmation）”的概念来设计 Outbox 队列的流转状态机。
- **过度设计审查判定**：
  1. **架构本质是纯净的**：DIM-04 坚决驳回了部分评审员“在移动端重造 SQLite 审批表与复杂事务回滚”的沉重建议，仅仅采用基于 `SecureStoreDriver` 的轻量 KV 存储（`<60` 行代码），且只有 `load` / `save` / `clear` 三个原子操作；
  2. **绝对不是分布式 2PC**：这只是标准的客户端 Outbox 队列与事件源（Event Sourcing）状态对账，完全没有协调者全局锁、没有 Prepare 投票，没有跨网络阻塞；
  3. **术语合规纠偏（建议改 Suggestion 1）**：为严格避免触碰禁令 3（“严禁在单机桌面端引入分布式共识协议与两阶段提交 2PC”），详案在文本与注释中必须**彻底禁止使用“2PC”这一缩写**，统一规范命名为**「传输确认与事件决议两段式出队（Two-Step Dequeue: Transport-ACK then Domain-Resolved）」**。

### 3.2 终端流式折叠与缓冲算法审查（对齐禁令 12/13）
- **审查事实**：
  DIM-05 在 `packages/shared-utils/src/event-ring-window.ts` 中引入了流式 `message-delta` 动态折叠方案。
- **过度设计审查判定**：
  该设计**不仅没有过度设计，反而是对禁令 12 与禁令 13 的杰出践行**！
  - 原代码将每个 `message-delta` 作为独立 entry 插入数组，导致 300 token 的回复瞬间产生 300 条条目，打爆 500 条环形缓冲，严重穿透 Zustand Store 触发频繁重渲染；
  - DIM-05 在 `event-ring-window.ts` 纯逻辑函数中，识别连续相同 `messageId` 的 delta，直接在当前末尾 entry 执行字符串拼接原地折叠（返回 `'replaced'`），将 300 次 entry 消耗骤降为 1 次，零额外微服务、零外部依赖、零性能损耗。

### 3.3 状态机超时与熔断机制审查（对齐禁令 9）
- **审查事实**：
  DIM-03 第 1.7 节小标题写着“增加应用层 15s 配对超时熔断机制”。
- **过度设计审查判定**：
  - 核查具体代码实现发现：这仅仅是在发起 `pair.hello` 阶段挂载了一个单一的 `setTimeout`（15 秒），若超时未回包则调用 `dispatch({ type: 'onPairError', code: 'pairing.timeout' })` 并关闭 socket；
  - 这绝非跨请求的滑动窗口统计熔断器（`CircuitBreaker`），没有状态计数器，没有 Half-Open 状态转换；
  - **术语纠偏要求（建议改 Suggestion 3）**：严禁将单次操作超时命名为“熔断（CircuitBreaker）”，纠正其标题与注释为**「单次配对 15 秒超时守护（Pairing Request 15s Timeout）」**，避免引火烧身。

### 3.4 全案 Fallback / 降级路径清算（杜绝无退场日期的隐蔽双轨）
全面审查 7 份详案中涉及的所有 Fallback：
1. **`terminalScreen.tsx` 的 fallbackLines 分支**：DIM-05 与 DIM-01 已规划**100% 物理删除**，只保留 `terminalStore.liveView` 单一真理源，彻底杜绝双轨计算；
2. **`themeProjection.ts` 双轨别名**：DIM-06 与 DIM-01 已规划**100% 物理删除**，全仓收口至 `@/adapters/platform/theme` 的 `useTheme`；
3. **桌面端深路径引用**：DIM-02 已规划**100% 物理替换**为 `@crish/shared-types`，零深路径残留；
4. **全案未发现任何带有“临时兼容、后续再删、无退场日期”的软弱 Fallback 路径**，架构具备高度收敛性。

---

## 四、【验收标准的可判定性与防假完成审查】（杜绝脱水 Mock 与不可执行假命令）

根据《AGENTS.md》§7.1「立体验证纪律」，交付必须具备绝对判定力。本审查员对 7 份详案给出的每一条 CLI 验证命令与断言进行了现场模拟与语法穿透：

### 4.1 致命命令缺陷暴露：DIM-02 与 DIM-03 误写 `npx vitest run apps/crish-mobile/...` 现场实证（必须改 Blocker 1）

#### 1. 致命缺陷现场证据
审阅 DIM-02 第 6.1 节第 4 项与 DIM-03 第 5.3 节：
- **DIM-02 第 408 行**：
  ```powershell
  npx vitest run apps/crish-mobile/src/adapters/wiring/filesWiring.test.ts apps/crish-mobile/src/adapters/wiring/ingestRouter.test.ts apps/crish-mobile/src/domain/store/filesStore.test.ts apps/crish-mobile/src/domain/store/settingsStore.test.ts apps/crish-mobile/src/pairing/rustParity.test.ts apps/crish-mobile/src/presentation/components/runDetail/RunDetailHeader.test.tsx
  ```
- **DIM-03 第 453-456 行**：
  ```powershell
  npx vitest run apps/crish-mobile/src/network/
  npx vitest run apps/crish-mobile/src/adapters/wiring/
  npx vitest run apps/crish-mobile/src/pairing/
  npx vitest run apps/crish-mobile/src/db/secureStore.test.ts
  ```

#### 2. 本地真实执行报错现场（物理铁证）
在根目录下直接执行 DIM-03 的验证命令，系统控制台立即报出致命错误：
```
PS C:\Software\conex> npx vitest run apps/crish-mobile/src/db/secureStore.test.ts

 RUN  v3.2.7 C:/Software/conex

No test files found, exiting with code 1

filter: apps/crish-mobile/src/db/secureStore.test.ts
 unit: include packages/*/src/**/*.test.{ts,tsx}, apps/crish-desktop/src/**/*.test.{ts,tsx}...
 integration: include tests/stress/**/*.test.ts, apps/crish-desktop/tests/integration/**/*.test.ts...
 native-smoke: include tests/e2e/tauri-native-smoke.spec.ts
```
**退出码：1（FAILED）！错误原因：`No test files found`！**

#### 3. 根因分析与破坏性定性
- **根因**：根目录 [`vitest.config.ts`](file:///c:/Software/conex/vitest.config.ts) 第 33-36 行与各 project 配置，仅包含了 `apps/crish-desktop` 与 `packages/*`，**根本没有将 `apps/crish-mobile` 纳入 Vitest 托管**！
- 移动端从创建伊始，就是基于 **`jest`（`jest-expo` preset）** 进行测试驱动的（见 `apps/crish-mobile/package.json` 中的 `"test": "jest"` 与 `jest.config.js`），移动端测试包含大量 React Native 与 Expo 专有 mock，必须通过 Jest 运行；
- 当测试人员或执行 Agent 依照 DIM-02 与 DIM-03 详案执行上述验收命令时，**命令行 100% 抛出退出码 1 崩溃，导致无法履行任何验收**！这是典型的“编写方案时未在终端真实跑过、凭空脑补工具链”的假验收命令！

#### 4. 真实合规执行命令现场复测
改用 Jest 官方工作区命令进行现场实测：
```powershell
PS C:\Software\conex> npm --workspace @crish/crish-mobile run test -- src/db/secureStore.test.ts

> @crish/crish-mobile@0.1.0 test
> jest src/db/secureStore.test.ts

PASS src/db/secureStore.test.ts
  InMemorySecureStore
    √ getItem/setItem/deleteItem 往返 (2 ms)
    ...
Test Suites: 1 passed, 1 total
Tests:       10 passed, 10 total
Time:        1.053 s
```
**结果：100% PASS，耗时仅 1.053 秒，退出码为 0！**

#### 5. 必须改裁决
DIM-02 与 DIM-03 详案必须立即全面修正其验证命令：
- 将所有 `npx vitest run apps/crish-mobile/...` 彻底替换为：
  `npm --workspace @crish/crish-mobile run test -- <测试文件模式>` 或 `npx jest apps/crish-mobile/<路径>`！

---

### 4.2 CLI 命令可执行性与退出码断言审计

除上述 DIM-02 / DIM-03 命令问题外，审查其他维度的验收命令：
1. **DIM-01**：
   - 使用 PowerShell 脚本断言 `$testInApp.Count -ne 0` 抛错；使用 `$deadFiles` 循环 `Test-Path` 断言抛错；
   - 使用 `npm --workspace @crish/crish-mobile run test` 与 `npx jest apps/crish-mobile/src/presentation/__tests__/routes/ --runInBand`；
   - **判定**：命令精准合法，断言具备退出码感知。
2. **DIM-04**：
   - 使用 `npm run typecheck -w @crish/crish-mobile`；
   - 使用 `cargo check --package conex-agent-workbench`；
   - 使用 `npm --workspace @crish/crish-mobile run test -- src/domain/store/approvalReducers.test.ts`；
   - **判定**：命令完全合规，无跨工具链混淆。
3. **DIM-05**：
   - 跨包层正确使用 `npx vitest run packages/shared-utils`；移动端层正确使用 `npm --workspace @crish/crish-mobile run test -- ...`；
   - **判定**：精准分清了 Monorepo 中不同子包的测试运行器边界。
4. **DIM-06**：
   - 全部使用 `npm --workspace @crish/crish-mobile run test -- ...`；
   - **判定**：完全合规。
5. **DIM-07**：
   - `npx expo config --type prebuild`、`npx expo export --platform android`、`npx expo prebuild --platform android --clean`、`.\gradlew.bat assembleDebug`；
   - **判定**：工业级打包命令闭环，包含 Windows 环境适配（`gradlew.bat`）。

---

### 4.3 物理现场、状态码与端到端闭环断言审查

审验各详案是否存在“脱水 Mock 假装完成”的倾向：
1. **网络握手状态码**：
   - DIM-03 明确要求在真实/集成环境下验证 WebSocket Upgrade **HTTP 101 Switching Protocols**；无 token 请求在非配对期断言 **HTTP 401 Unauthorized**；根路径请求断言 **HTTP 404 Not Found**；杜绝纯 Fake Socket 伪造；
2. **桌面端 Remote 响应时延**：
   - DIM-04 明确要求在集成联调中，移动端发出 `remote.approve` 到收到 `result.approve`，桌面端 `ws.rs` 直调内核并在日志打印 `handling remote.approve`，端到端延迟断言 **$< 100\text{ms}$**，彻底告别 10s 黑洞；
3. **抗杀进程真实水合**：
   - DIM-04 明确设计了“离线入队 -> 强制杀进程（Kill Process） -> 冷启动 -> 检验 SecureStore 物理水合 -> 恢复网络单飞重放”的五步真实场景验收断言，杜绝纯内存 Mock 自嗨；
4. **流式超限物理吸底与零跳动**：
   - DIM-05 明确设计了 10,000 行高吞吐推流压测，在超过 5000 行后断言 `totalLineCursor` 递增与持续触发 `scrollToEnd`，并断言 `truncatedCount > 0` 时 `getItemLayout.offset` 精确增加 24dp，视觉零跳动；
5. **独立原生真机运行**：
   - DIM-07 明确要求将生成的 `app-debug.apk` 物理安装到 Android 真机，验证 `globalThis.expo.modules.ExpoCrypto` 真实硬件 JSI 绑定，彻底脱离 Expo Go 宿主。

---

## 五、【终审裁决与主控决议书】（Blocker / Suggestion / Risk）

根据上述详尽审查，终审 Agent 2 正式向主控出具最终裁决结论：

```
╔═════════════════════════════════════════════════════════════════════════════╗
║                      详案终审 Agent 2 最终裁决判定汇总                      ║
╠═════════════════════════════════════════════════════════════════════════════╣
║  🔴 必须改（Blocker）: 3 项 (命令不可执行/连带编译断裂/路由测试冲突)        ║
║  🟡 建议改（Suggestion）: 3 项 (术语脱敏/云构建解耦/单次超时规范)             ║
║  🟢 可接受风险（Risk）: 2 项 (桌面并发锁时延/低端机流式渲染波动)             ║
╚═════════════════════════════════════════════════════════════════════════════╝
```

### 5.1 必须改（Blocker，阻断执行的三大硬伤）

#### 🔴 Blocker 1：DIM-02 与 DIM-03 验收命令严重误写为 `npx vitest run apps/crish-mobile/...`，导致执行 100% 失败
- **责任详案**：[`02-plan-dim-02-type-contract.md`](../plans/02-plan-dim-02-type-contract.md)（行 408）与 [`03-plan-dim-03-pairing-gateway.md`](../plans/03-plan-dim-03-pairing-gateway.md)（行 453-456）
- **现场实证**：实测退出码 1，报错 `No test files found`。`vitest.config.ts` 从未收录移动端项目，移动端测试必须走 Jest。
- **整改要求**：
  必须将上述两份详案中的移动端测试命令全面改为：
  ```powershell
  # DIM-02 修正为:
  npm --workspace @crish/crish-mobile run test -- src/adapters/wiring/filesWiring.test.ts src/adapters/wiring/ingestRouter.test.ts src/domain/store/filesStore.test.ts src/domain/store/settingsStore.test.ts src/pairing/rustParity.test.ts src/presentation/components/runDetail/RunDetailHeader.test.tsx

  # DIM-03 修正为:
  npm --workspace @crish/crish-mobile run test -- src/network/
  npm --workspace @crish/crish-mobile run test -- src/adapters/wiring/
  npm --workspace @crish/crish-mobile run test -- src/pairing/
  npm --workspace @crish/crish-mobile run test -- src/db/secureStore.test.ts
  ```

#### 🔴 Blocker 2：DIM-01 负产出清理遗漏 `src/db/index.ts` 与文件域连带出口，导致物理删除后编译立即崩溃
- **责任详案**：[`01-plan-dim-01-dead-code.md`](../plans/01-plan-dim-01-dead-code.md)（第 3 节与第 5.1 节）
- **断层实证**：
  1. `apps/crish-mobile/src/db/index.ts:10` 导出了 `export * from './cachePolicy';`。若仅删除 `cachePolicy.ts` 而不改 `src/db/index.ts`，TypeScript 直接报找不到模块错误；
  2. `apps/crish-mobile/src/presentation/components/files/index.ts:18` 导出了 `formatRelativeTime`，且 `fileMeta.test.ts` 包含专门针对它的单测。若仅在 `fileMeta.ts` 移除该函数而不改 `index.ts` 与 `test.ts`，编译同样崩溃。
- **整改要求**：
  DIM-01 的【唯一写文件域】必须扩充收录以下文件：
  - `apps/crish-mobile/src/db/index.ts`（拔除第 10 行 `export * from './cachePolicy';`）；
  - `apps/crish-mobile/src/presentation/components/files/index.ts`（拔除或重定向 `formatRelativeTime`）；
  - `apps/crish-mobile/src/presentation/components/files/fileMeta.test.ts`（收敛已迁移至 `time.test.ts` 的重复用例）。

#### 🔴 Blocker 3：DIM-01（移出路由测试）与 DIM-06（清理死路由）在 `app/pair/scan.tsx` 上存在冲突
- **责任详案**：[`01-plan-dim-01-dead-code.md`](../plans/01-plan-dim-01-dead-code.md) vs [`06-plan-dim-06-ui-ux.md`](../plans/06-plan-dim-06-ui-ux.md)（行 687）
- **断层实证**：DIM-01 将 `app/pair/scan.test.tsx` 移出为 `src/presentation/__tests__/routes/pairScanRoute.test.tsx` 并作为重定向断言保留；而 DIM-06 声明直接删除 `app/pair/scan.tsx` 文件。若删除文件，测试将因缺少被测模块崩溃，路由树出现 404 漏洞。
- **整改要求**：
  裁决 DIM-06 撤回“清理 `app/pair/scan.tsx` 路由”的表述。两维度达成共识：**保留 `apps/crish-mobile/app/pair/scan.tsx` 并将其重写为纯声明式 `<Redirect href="/pair/manual" />` 守卫**，既消灭占位假 UI，又保护测试与路由契约。

---

### 5.2 建议改（Suggestion，完善工程质感的三项优化）

#### 🟡 Suggestion 1：DIM-04 文本全面脱敏“两阶段提交 / 2PC”术语，规范为“两段式确认出队”
- 详案中的机制本质是标准的客户端 Outbox 状态流转（发送回执确认 + 领域事件确认），并非分布式事务 2PC。为避免与《ANTI_OVERENGINEERING_GUARDRAILS.md》禁令 3 产生认知歧义，建议全案统一行文为**「传输确认与事件决议两段式出队（Two-Step Dequeue）」**。

#### 🟡 Suggestion 2：DIM-07 明确以本地离线 Gradle 编译与 GitHub Actions 为第一基准，EAS Cloud 为辅助可选
- 确保没有 Expo 云端付费/登录账号的开发人员或离线内网 CI，依然能够无障碍执行 `npx expo export` 与 `.\gradlew.bat assembleDebug`，守住工程自给自足底线。

#### 🟡 Suggestion 3：DIM-03 将 15 秒配对超时明确命名为“单次配对超时守护”，避免使用“熔断（CircuitBreaker）”字眼
- 该逻辑只是为单次连接挂载的定时器，非全局滑动窗口熔断器，更名以对齐禁令 9。

---

### 5.3 可接受风险（Risk，运行期监控点）

#### 🟢 Risk 1：桌面端 `ws.rs` 直调 `backend.approve` 的瞬时等待
- 移动端发出 `remote.approve` 并在 $< 100\text{ms}$ 内期望收到回执。若桌面端 Rust 内核恰好在执行重度 SQLite WAL checkpoint，可能会产生数十毫秒抖动。因移动端网关具备 10 秒底线容错，此项延迟在可接受范围内。

#### 🟢 Risk 2：极限流式输出下低端 Android 设备的绘制掉帧
- 在 10,000 行超限流式压测中，若设备 CPU 较弱，大量 Text 行虚拟化挂载可能会引发短暂帧率波动（40~55fps）。因 DIM-05 已彻底修复 5000 行吸底死锁并实现了绝对游标与增量折叠，系统具备自愈性，不导致冻结崩溃，属于可接受风险。

---

## 六、终审总结致主控

本次终审由 Agent 2 亲自核验了 22 个死文件的真实磁盘落盘、8 个路由单测的行号分布、SQLite 6 个 DAO 的未接线事实、145 行手写 SHA-256 的代码细节，并通过物理命令行测出了 DIM-02/03 中致命的 `npx vitest run` 假命令漏洞与 DIM-01 的连带导出遗漏。

**总计划框架与 7 份执行详案架构方向高度正确、负产出态度坚决、反过度设计意图清晰**。只要在进入具体实施前，由主控统一将上述 **3 项 Blocker 纠正落盘**，本套方案即可成为 Conex / Crish 移动端技术攻坚史上最坚硬、最彻底、无懈可击的生产级实施总纲！

*(终审报告编制完成，已落盘于 `docs/mobile-revival-audit/plan-reviews/05-final-review-dead-code-and-verification.md`)*
