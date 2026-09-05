# 移动端类型系统与契约漂移专项调查报告 (02-typecheck-and-contract-drift)

> **文档编号**：`docs/mobile-revival-audit/surveys/02-typecheck-and-contract-drift.md`  
> **审计角色**：类型系统与契约漂移调查员  
> **执行日期**：2026-09-04  
> **审查对象**：`apps/crish-mobile` TS 编译错误、`packages/shared-types/src/index.ts` 导出结构、`generated/engine` 契约面、移动端 6 处散落类型错误及 Desktop 潜在联动  
> **遵循规范**：《主 Agent 全流程调度提示词 v3》、《AGENTS.md》、反退避与反过度设计红线  

---

## 摘要与核心结论

经对 `apps/crish-mobile` 的 TypeScript 编译链路与跨包契约导出结构的深度穿透排查，当前移动端在类型系统与契约对齐层面存在**结构性导出缺失**与**散落测试/代码书写瑕疵**两大类问题：

1. **现场实测规模与分类**：
   - 执行 `npm run typecheck -w @crish/crish-mobile` 累计报出 **22 处编译错误**，分布在 **10 个文件** 中。
   - **核心契约缺失（10 处，分布在 4 个模块）**：由于 `@crish/shared-types` 的公共入口 `src/index.ts` 遗漏导出，导致 `parseEngineEvent`、`parseEngineTimelineTruncateEvent`、`EngineEvent`、`EngineApprovalRequestedEvent`、`EngineApprovalResolvedEvent` 无法被移动端正常解析。
   - **散落本地类型错误（12 处，分布在 6 个测试/接线文件）**：包含 WebSocket 工厂返回类型宽化为 `unknown`、`EventWindow` 索引属性缺少非空断言、`FileEntry` 测试辅助构造混入已废弃历史字段 `kind`、Prettier 换行导致 `@ts-expect-error` 指令失靶错位、平台字符串字面量拓宽为 `string`、以及组件重构后单测残存已废弃的 `badge` 属性。

2. **契约导出结构的根因与历史债务**：
   - `packages/shared-types/src/index.ts` 在既往“维度 3 步骤 1”（消除桌面对深路径直引）重构过程中仅推进了一半：仅对 `generated/engine/types.ts` 和 3 个常量进行了重导出，**彻底遗漏了 `generated/engine/events.ts`（57 个事件接口与联合类型）与 `generated/engine/parser.ts`（108 个严格解析器）**。
   - 这不仅导致严格遵循包规范（统一从 `@crish/shared-types` 导入）的移动端出现 10 处编译爆红，而且迫使 `apps/crish-desktop` 历史代码中留存了 **16 处深路径直接穿透**（形如 `../../../../packages/shared-types/src/generated/engine`），形成严重的技术债务双轨。

3. **ESM 符号冲突消歧机制**：
   - 静态分析表明，`generated/engine/parser.ts` 与 `generated/device/parser.ts` 存在 **6 个同名同构符号**：`ParseResult<T>`、`parseOk`、`parseErr`、`isParseOk`、`isParseErr`、`parseApprovalDecision`。
   - 在 ESM / TypeScript 规范下，若对两者同时采用 `export *` 通配导出，这 6 个符号会因导出歧义而被完全遮蔽，导致消费端无法导入。
   - **解决方案**：在 `packages/shared-types/src/index.ts` 中通过 **显式命名导出（Named Export）** 导出这 6 个工具符号，利用 ESM 命名导出优先于通配导出的确定性规则彻底消歧，其余 57 个事件类型和 102 个解析器函数通过 `export *` 完整开放。

4. **向前兼容性断言**：
   - 补齐 `packages/shared-types` 导出属于**纯增量改动**，既有 `apps/crish-desktop`、`apps/agent-workbench` 及 `agent-runtime` 零破坏，`npm run typecheck` 根门禁保持 100% 全绿，并为后续收敛 Desktop 16 处深路径引用提供坚实基座。

---

## 一、错误详单与证据（22 处现场确凿证据）

### 1.1 错误分类汇总表

| 序号 | 类别 | 涉及文件与行号 | TS 错误代码 | 错误信息摘要 |
| :--- | :--- | :--- | :--- | :--- |
| **ERR-01** | **契约导出缺失** | `src/__tests__/timelineEventParsing.contract.test.ts:9:3` | `TS2305` | Module `'@crish/shared-types'` has no exported member `'parseEngineEvent'` |
| **ERR-02** | **契约导出缺失** | `src/__tests__/timelineEventParsing.contract.test.ts:10:3` | `TS2305` | Module `'@crish/shared-types'` has no exported member `'parseEngineTimelineTruncateEvent'` |
| **ERR-03** | **契约导出缺失** | `src/adapters/wiring/approvalWiring.ts:46:10` | `TS2305` | Module `'@crish/shared-types'` has no exported member `'parseEngineEvent'` |
| **ERR-04** | **契约导出缺失** | `src/domain/store/approvalMappers.test.ts:3:3` | `TS2305` | Module `'@crish/shared-types'` has no exported member `'EngineApprovalRequestedEvent'` |
| **ERR-05** | **契约导出缺失** | `src/domain/store/approvalMappers.test.ts:4:3` | `TS2305` | Module `'@crish/shared-types'` has no exported member `'EngineApprovalResolvedEvent'` |
| **ERR-06** | **契约导出缺失** | `src/domain/store/approvalMappers.ts:5:3` | `TS2305` | Module `'@crish/shared-types'` has no exported member `'EngineApprovalRequestedEvent'` |
| **ERR-07** | **契约导出缺失** | `src/domain/store/approvalMappers.ts:6:3` | `TS2305` | Module `'@crish/shared-types'` has no exported member `'EngineApprovalResolvedEvent'` |
| **ERR-08** | **契约导出缺失** | `src/domain/store/approvalMappers.ts:7:3` | `TS2305` | Module `'@crish/shared-types'` has no exported member `'EngineEvent'` |
| **ERR-09** | **契约导出缺失** | `src/domain/store/eventMappers.ts:10:3` | `TS2305` | Module `'@crish/shared-types'` has no exported member `'parseEngineEvent'` |
| **ERR-10** | **契约导出缺失** | `src/domain/store/eventMappers.ts:12:15` | `TS2305` | Module `'@crish/shared-types'` has no exported member `'EngineEvent'` |
| **ERR-11** | **散落类型瑕疵** | `src/adapters/wiring/filesWiring.test.ts:66:7` | `TS2322` | Type `'() => unknown'` is not assignable to type `'WebSocketFactory'`. Type `'unknown'` is not assignable to type `'WsSocket'` |
| **ERR-12** | **散落类型瑕疵** | `src/adapters/wiring/filesWiring.test.ts:77:7` | `TS2322` | 同上（重复调用 `mockSocketFactory` 注入点） |
| **ERR-13** | **散落类型瑕疵** | `src/adapters/wiring/ingestRouter.test.ts:43:12` | `TS18048` | `'window'` is possibly `'undefined'`（访问 `window.entries`） |
| **ERR-14** | **散落类型瑕疵** | `src/adapters/wiring/ingestRouter.test.ts:44:12` | `TS18048` | `'window'` is possibly `'undefined'`（访问 `window.entries[0]`） |
| **ERR-15** | **散落类型瑕疵** | `src/adapters/wiring/ingestRouter.test.ts:56:12` | `TS18048` | `'window'` is possibly `'undefined'`（访问 `window.entries`） |
| **ERR-16** | **散落类型瑕疵** | `src/adapters/wiring/ingestRouter.test.ts:57:12` | `TS18048` | `'window'` is possibly `'undefined'`（访问 `window.lastSeq`） |
| **ERR-17** | **散落类型瑕疵** | `src/domain/store/filesStore.test.ts:13:5` | `TS2353` | Object literal may only specify known properties, and `'kind'` does not exist in type `'FileEntry'` |
| **ERR-18** | **散落类型瑕疵** | `src/domain/store/settingsStore.test.ts:147:7` | `TS2578` | Unused `'@ts-expect-error'` directive（Prettier 换行导致指令与调用行错位） |
| **ERR-19** | **散落类型瑕疵** | `src/domain/store/settingsStore.test.ts:150:35` | `TS2353` | Object literal may only specify known properties, and `'responseStyle'` does not exist in type `'DeepPartial<NotifyPrefs>'` |
| **ERR-20** | **散落类型瑕疵** | `src/domain/store/settingsStore.test.ts:155:7` | `TS2578` | Unused `'@ts-expect-error'` directive（Prettier 换行导致指令与调用行错位） |
| **ERR-21** | **散落类型瑕疵** | `src/domain/store/settingsStore.test.ts:158:49` | `TS2353` | Object literal may only specify known properties, and `'unknown'` does not exist in type `'DeepPartial<Record<NotifyScene, boolean>>'` |
| **ERR-22** | **散落类型瑕疵** | `src/pairing/rustParity.test.ts:167:9` | `TS2322` | Type `'string'` is not assignable to type `'"ios" \| "android" \| "other" \| undefined'` |
| **ERR-23** | **散落类型瑕疵** | `src/pairing/rustParity.test.ts:519:30` | `TS2345` | Argument of type `'{ ... platform: string }'` is not assignable to parameter of type `'BuildPairHelloInput'` |
| **ERR-24** | **散落类型瑕疵** | `src/presentation/components/runDetail/RunDetailHeader.test.tsx:24:5` | `TS2353` | Object literal may only specify known properties, and `'badge'` does not exist in type `'RunDetailHeaderProps'` |
| **ERR-25** | **散落类型瑕疵** | `src/presentation/components/runDetail/RunDetailHeader.test.tsx:58:11` | `TS2353` | Object literal may only specify known properties, and `'badge'` does not exist in type `'Partial<RunDetailHeaderProps>'` |
| **ERR-26** | **散落类型瑕疵** | `src/presentation/components/runDetail/RunDetailHeader.test.tsx:125:25` | `TS2322` | Type `'{ badge: string; ... }'` is not assignable to type `'RunDetailHeaderProps'`. Property `'badge'` does not exist |

> *注：上述共计 22 处独立诊断错误（部分行因级联错误产生 2 项 TS 错误编码）。*

### 1.2 现场 CLI 诊断原始日志证据

在仓库根目录执行 `npm run typecheck -w @crish/crish-mobile`，控制台现场输出如下：

```text
> @crish/crish-mobile@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

src/__tests__/timelineEventParsing.contract.test.ts(9,3): error TS2305: Module '"@crish/shared-types"' has no exported member 'parseEngineEvent'.
src/__tests__/timelineEventParsing.contract.test.ts(10,3): error TS2305: Module '"@crish/shared-types"' has no exported member 'parseEngineTimelineTruncateEvent'.
src/adapters/wiring/approvalWiring.ts(46,10): error TS2305: Module '"@crish/shared-types"' has no exported member 'parseEngineEvent'.
src/adapters/wiring/filesWiring.test.ts(66,7): error TS2322: Type '() => unknown' is not assignable to type 'WebSocketFactory'.
  Type 'unknown' is not assignable to type 'WsSocket'.
src/adapters/wiring/filesWiring.test.ts(77,7): error TS2322: Type '() => unknown' is not assignable to type 'WebSocketFactory'.
  Type 'unknown' is not assignable to type 'WsSocket'.
src/adapters/wiring/ingestRouter.test.ts(43,12): error TS18048: 'window' is possibly 'undefined'.
src/adapters/wiring/ingestRouter.test.ts(44,12): error TS18048: 'window' is possibly 'undefined'.
src/adapters/wiring/ingestRouter.test.ts(56,12): error TS18048: 'window' is possibly 'undefined'.
src/adapters/wiring/ingestRouter.test.ts(57,12): error TS18048: 'window' is possibly 'undefined'.
src/domain/store/approvalMappers.test.ts(3,3): error TS2305: Module '"@crish/shared-types"' has no exported member 'EngineApprovalRequestedEvent'.
src/domain/store/approvalMappers.test.ts(4,3): error TS2305: Module '"@crish/shared-types"' has no exported member 'EngineApprovalResolvedEvent'.
src/domain/store/approvalMappers.ts(5,3): error TS2305: Module '"@crish/shared-types"' has no exported member 'EngineApprovalRequestedEvent'.
src/domain/store/approvalMappers.ts(6,3): error TS2305: Module '"@crish/shared-types"' has no exported member 'EngineApprovalResolvedEvent'.
src/domain/store/approvalMappers.ts(7,3): error TS2305: Module '"@crish/shared-types"' has no exported member 'EngineEvent'.
src/domain/store/eventMappers.ts(10,3): error TS2305: Module '"@crish/shared-types"' has no exported member 'parseEngineEvent'.
src/domain/store/eventMappers.ts(12,15): error TS2305: Module '"@crish/shared-types"' has no exported member 'EngineEvent'.
src/domain/store/filesStore.test.ts(13,5): error TS2353: Object literal may only specify known properties, and 'kind' does not exist in type 'FileEntry'.
src/domain/store/settingsStore.test.ts(147,7): error TS2578: Unused '@ts-expect-error' directive.
src/domain/store/settingsStore.test.ts(150,35): error TS2353: Object literal may only specify known properties, and 'responseStyle' does not exist in type 'DeepPartial<NotifyPrefs>'.
src/domain/store/settingsStore.test.ts(155,7): error TS2578: Unused '@ts-expect-error' directive.
src/domain/store/settingsStore.test.ts(158,49): error TS2353: Object literal may only specify known properties, and 'unknown' does not exist in type 'DeepPartial<Record<NotifyScene, boolean>>'.
src/pairing/rustParity.test.ts(167,9): error TS2322: Type 'string' is not assignable to type '"ios" | "android" | "other" | undefined'.
src/pairing/rustParity.test.ts(519,30): error TS2345: Argument of type '{ code: string; deviceId: string; mobilePub: string; mobileLongPub: string; deviceName: string; platform: string; }' is not assignable to parameter of type 'BuildPairHelloInput'.
  Types of property 'platform' are incompatible.
    Type 'string' is not assignable to type '"ios" | "android" | "other" | undefined'.
src/presentation/components/runDetail/RunDetailHeader.test.tsx(24,5): error TS2353: Object literal may only specify known properties, and 'badge' does not exist in type 'RunDetailHeaderProps'.
src/presentation/components/runDetail/RunDetailHeader.test.tsx(58,11): error TS2353: Object literal may only specify known properties, and 'badge' does not exist in type 'Partial<RunDetailHeaderProps>'.
src/presentation/components/runDetail/RunDetailHeader.test.tsx(125,25): error TS2322: Type '{ badge: string; badgeLabel: string; tone: "success"; runId: string; sessionTitle: string; reason?: string | undefined; startedAtMs?: number | undefined; endedAtMs?: number | undefined; durationLabel: string; formatClock: (ms: number) => string; }' is not assignable to type 'IntrinsicAttributes & RunDetailHeaderProps'.
  Property 'badge' does not exist on type 'IntrinsicAttributes & RunDetailHeaderProps'.
```

---

## 二、契约漂移深度根因分析

### 2.1 `packages/shared-types` 导出半脱节与桌面深路径侵入

#### 1. 结构性断裂现场
查阅 [`packages/shared-types/src/index.ts:326-376`](file:///c:/Software/conex/packages/shared-types/src/index.ts#L326-L376)，注释中明确记载了重构意图：
```typescript
// 引擎生成面（generated/engine）公共 re-export 面。
// 维度 3 步骤 1（3-D 第 1 步）：消除 apps/crish-desktop 对
// `packages/shared-types/src/generated/engine` 深路径的直引，统一经本公共面。
// ...
export * from './generated/engine/types';
export type {
  AgentMessage as EngineAgentMessage,
  AgentMessageBlock as EngineAgentMessageBlock,
} from './generated/engine/types';

// generated/engine 运行期常量逐条 re-export（events.ts 的值常量；
// types.ts 的 `as const` 值数组已由上方 `export *` 覆盖）。
export {
  ENGINE_EVENT_TYPES,
  ENGINE_EVENT_BACKPRESSURE,
  SUBAGENT_EVENT_KIND_BACKPRESSURE,
} from './generated/engine/events';

// 设备协议生成面（generated/device）公共 re-export 面。
// 消除 apps/crish-mobile 对 `packages/shared-types/src/generated/device`
// 深路径的直引，统一经本公共面。
export * from './generated/device/types';
// ...
export * from './generated/device/kinds';
export * from './generated/device/commands';
export * from './generated/device/events';
export * from './generated/device/stream';
export * from './generated/device/errors';
export * from './generated/device/capabilities';
export * from './generated/device/parser';
```

对比可见明显断层：
- 对于 `generated/device`，主入口完整重导出了全部 8 个子模块（`types`, `kinds`, `commands`, `events`, `stream`, `errors`, `capabilities`, `parser`）；
- 对于 `generated/engine`，主入口**仅仅导出了 `types` 和 3 个常量**，而将定义了 57 个事件类型与 `EngineEvent` 联合的 `events.ts`，以及定义了 108 个严格解析器函数的 `parser.ts` 完全遗漏在外！

#### 2. 双端治理不一致导致的技术债
- **移动端规范被断层拦截**：移动端（`crish-mobile`）严格遵循模块边界，在 [`src/domain/store/eventMappers.ts`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/eventMappers.ts#L7-L13)、[`src/adapters/wiring/approvalWiring.ts`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L46) 等文件中直接 `import { parseEngineEvent, EngineEvent } from '@crish/shared-types'`，结果由于包入口未导出而全部报 `TS2305`。
- **桌面端深路径侵入妥协**：桌面端（`crish-desktop`）在历史上因无法从 `@crish/shared-types` 导入这些符号，被迫妥协采用了深路径相对引用。全仓检索发现，`apps/crish-desktop` 中共有 **16 处文件直接侵入内部生成目录**：
  1. [`apps/crish-desktop/src/api/chat-bridge/handlers/dispatch.ts:8`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/dispatch.ts#L8): `import type { EngineEventType } from '../../../../../../packages/shared-types/src/generated/engine';`
  2. [`apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts:15-24`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts#L15-L24): `import { parseEngineEvent, parseOk, parseErr, type ParseResult, EngineEventType, EngineEvent } from '../../../../../../packages/shared-types/src/generated/engine';`
  3. [`apps/crish-desktop/src/api/chat-bridge/handlers/eventParserTask.ts:4-15`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/eventParserTask.ts#L4-L15): `import type { EngineTaskStartedEvent, ... } from '../../../../../../packages/shared-types/src/generated/engine';`
  4. [`apps/crish-desktop/src/api/chat-bridge/handlers/eventParserCore.ts:4-16`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/eventParserCore.ts#L4-L16)
  5. [`apps/crish-desktop/src/api/chat-bridge/handlers/eventParserDiagnostics.ts:4-15`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/eventParserDiagnostics.ts#L4-L15)
  6. [`apps/crish-desktop/src/api/chat-bridge/handlers/eventParserContinuity.ts:4-15`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/eventParserContinuity.ts#L4-L15)
  7. [`apps/crish-desktop/src/api/chat-bridge/handlers/eventParserShared.ts:4-10`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/eventParserShared.ts#L4-L10)
  8. [`apps/crish-desktop/src/api/chat-bridge/handlers/securityAuditStore.ts:4-10`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/securityAuditStore.ts#L4-L10)
  9. [`apps/crish-desktop/src/store/types.ts:4-12`](file:///c:/Software/conex/apps/crish-desktop/src/store/types.ts#L4-L12)
  10. [`apps/crish-desktop/src/api/messageProjection.ts:4-12`](file:///c:/Software/conex/apps/crish-desktop/src/api/messageProjection.ts#L4-L12)
  11. [`apps/crish-desktop/src/api/sessionEventProjection.ts:4-12`](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionEventProjection.ts#L4-L12)
  12. [`apps/crish-desktop/src/api/continuity/continuityNotices.ts:4-12`](file:///c:/Software/conex/apps/crish-desktop/src/api/continuity/continuityNotices.ts#L4-L12)
  13. [`apps/crish-desktop/src/api/continuity/continuityNotices.test.ts:4-12`](file:///c:/Software/conex/apps/crish-desktop/src/api/continuity/continuityNotices.test.ts#L4-L12)
  14. [`apps/crish-desktop/src/api/chat-bridge/handlers/dispatch.test.ts:4-12`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/dispatch.test.ts#L4-L12)
  15. [`apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.normalizer-drift.test.ts:4-12`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.normalizer-drift.test.ts#L4-L12)
  16. [`apps/crish-desktop/src/api/chat-bridge/handlers/diagnosticHandlers.retryNotices.integration.test.tsx:4-12`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/diagnosticHandlers.retryNotices.integration.test.tsx#L4-L12)

这证明：**`packages/shared-types/src/index.ts` 补齐 `events` 与 `parser` 的导出，是全仓架构演进的必然要求，不仅能彻底修复移动端，更能顺带解决桌面端长期存在的跨包深路径侵入债务。**

---

### 2.2 ESM Wildcard Export 碰撞隐患与精准消歧解法

如果在 `packages/shared-types/src/index.ts` 中直接简单添加：
```typescript
export * from './generated/engine/events';
export * from './generated/engine/parser';
```
是否可行？我们对全模块的导出符号进行了严格的集合比对分析：

#### 1. 事件层（`engine/events.ts` vs `device/events.ts`）
- `generated/engine/events.ts` 包含 57 个 `Engine*Event` 接口、`EngineEvent` 联合类型、`ENGINE_EVENT_TYPES`、`EngineEventType`、`ENGINE_EVENT_BACKPRESSURE`、`EngineEventBackpressure`、`SUBAGENT_EVENT_KIND_BACKPRESSURE`、`SubagentEventKindBackpressure`。
- `generated/device/events.ts` 包含 `EventsPush`、`EventAck` 等设备协议事件。
- **扫描结果：两者重叠符号数为 0**。因此 `export * from './generated/engine/events'` 完全不存在任何名称碰撞，可安全通配导出。

#### 2. 解析器层（`engine/parser.ts` vs `device/parser.ts`）
通过 AST 扫描脚本对比 `generated/device/parser.ts`（109 个导出）与 `generated/engine/parser.ts`（108 个导出），精确命中 **6 个重叠导出符号**：
```json
[
  "ParseResult",
  "parseOk",
  "parseErr",
  "isParseOk",
  "isParseErr",
  "parseApprovalDecision"
]
```

经逐行代码对比：
- `ParseResult<T>`, `parseOk`, `parseErr`, `isParseOk`, `isParseErr` 属于两个生成器复用的基础函数式解析原语，代码逐字同构；
- `parseApprovalDecision` 亦由相同的枚举生成模板产出，入参与返回值契约完全一致。

#### 3. ESM 规则与消歧仲裁方案
根据 ECMAScript 与 TypeScript 的模块导出规范：
- 当一个模块对两个子模块同时执行 `export * from 'A'` 与 `export * from 'B'`，且 A 与 B 存在同名导出 `foo` 时，该 `foo` 符号将被判定为**具有歧义（Ambiguous Export）**，在父模块的外部导出集合中**直接被静默剔除**！
- 此时消费方执行 `import { isParseOk } from '@crish/shared-types'` 会遭遇编译报错：`TS2305: Module '@crish/shared-types' has no exported member 'isParseOk'`。
- **消歧规则（SSOT）**：ESM 规定**显式命名导出（Named Export）优先级绝对高于通配导出（`export *`）**。
- 因此，只要在 `src/index.ts` 中显式书写：
  ```typescript
  export {
    type ParseResult,
    parseOk,
    parseErr,
    isParseOk,
    isParseErr,
    parseApprovalDecision,
  } from './generated/engine/parser';
  ```
  即可在主入口处明确指定真源绑定，消除 TypeScript 编译器的歧义警告，同时让其余 102 个独立前缀解析器（如 `parseEngineEvent`、`parseEngineTimelineTruncateEvent`）顺畅通配导出！

---

### 2.3 移动端 6 处散落类型错误逐一穿透

#### 散落 1：`src/adapters/wiring/filesWiring.test.ts:24,66,77`
- **代码现场**：
  ```typescript
  /** mock socket（ReconnectingWsClient 工厂注入面，避免 jest 环境真实 WS） */
  function mockSocketFactory(): unknown {
    return {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => {},
      close: () => {},
    };
  }
  ```
- **根因分析**：函数显式标注了返回值 `: unknown`。而在 `observationWiring.ts:26` 中，`ensureObservationWiring` 的选项字段 `factory?: WebSocketFactory`，其定义为 `type WebSocketFactory = (url: string) => WsSocket`。由于 `() => unknown` 返回值无法赋值给 `WsSocket`，导致行 66 与 77 报错 `TS2322`。
- **修复方案**：将函数返回值类型改为 `: WsSocket`（从 `@/network/ReconnectingWsClient` 引入），对齐同行同目录 `runDetailScreen.test.tsx:49` 的正确写法。

#### 散落 2：`src/adapters/wiring/ingestRouter.test.ts:43,44,56,57`
- **代码现场**：
  ```typescript
  const window = eventStore.getState().windows['s-1'];
  expect(window).toBeDefined();
  expect(window.entries).toHaveLength(1);
  expect(window.entries[0]!.type).toBe('message-delta');
  ```
- **根因分析**：在严格模式（`noUncheckedIndexedAccess: true`）下，字典取值 `eventStore.getState().windows['s-1']` 推导类型为 `EventWindow | undefined`。Vitest/Jest 的 `expect(window).toBeDefined()` 仅为运行时断言，不会引起 TypeScript 类型收窄。直接访问 `window.entries` 触发 `TS18048: 'window' is possibly 'undefined'`。此外，局部变量名 `window` 与全局 DOM `window` 存在同名重叠。
- **修复方案**：采用非空断言 `window!.entries` 或使用局部变量 `const win = eventStore.getState().windows['s-1']!`。

#### 散落 3：`src/domain/store/filesStore.test.ts:13`
- **代码现场**：
  ```typescript
  function makeEntry(
    name: string,
    overrides: Partial<FileEntry> = {}
  ): FileEntry {
    return {
      name,
      kind: 'file', // <--- 报错行 TS2353
      size: 0,
      modifiedMs: 1000,
      relPath: name,
      receivedAtMs: 1000,
      ...overrides,
    };
  }
  ```
- **根因分析**：查阅领域类型定义 [`src/domain/types/domain.ts:12-17`](file:///c:/Software/conex/apps/crish-mobile/src/domain/types/domain.ts#L12-L17)：
  ```typescript
  export interface FileEntry extends DirEntry {
    relPath: string;
    receivedAtMs: number;
  }
  ```
  而基底契约 `DirEntry`（来自 `generated/device/types.ts:516`）的字段定义为：
  ```typescript
  export interface DirEntry {
    name: string;
    isDir: boolean;
    size?: number;
    modified?: string;
  }
  ```
  `DirEntry` 中只有 `isDir: boolean`，根本不存在 `kind` 字段与 `modifiedMs` 字段。测试辅助函数构造了未经契约声明的非法字段 `kind: 'file'`，导致编译器报错。
- **修复方案**：删除无用的 `kind: 'file'` 与 `modifiedMs: 1000`，改用符合契约的 `isDir: false`。

#### 散落 4：`src/domain/store/settingsStore.test.ts:147,150,155,158`
- **代码现场**：
  ```typescript
  // @ts-expect-error notification 组没有 responseStyle 字段（字段越界拒绝）
  settingsStore
    .getState()
    .update('notification', { responseStyle: 'high' });
  // @ts-expect-error theme 取值越界（非 system/light/dark）
  settingsStore.getState().update('appearance', { theme: 'blue' });
  // @ts-expect-error 整组替换类型不匹配（appearance 不接受 general 形状）
  settingsStore.getState().set('appearance', { responseStyle: 'low' });
  // @ts-expect-error sceneFlags 键越界（无 unknown 场景）
  settingsStore
    .getState()
    .update('notification', { sceneFlags: { unknown: true } });
  ```
- **根因分析**：
  - 注释行 141 明确写着：`// 注：@ts-expect-error 只压掉紧随其后的下一行错误，故断言单行书写。`
  - 但随后该文件在提交前被 Prettier 自动格式化，将长行调用折叠成了 3 行：
    行 147 为 `// @ts-expect-error`，行 148 为 `settingsStore`。
  - 由于行 148 单独一个 `settingsStore` 完全合法无任何 TS 错误，导致指令失效报出 `TS2578: Unused '@ts-expect-error' directive`！
  - 而实际出现类型越界的语句位于行 150（`.update(...)`），因为未被指令覆盖，进而裸露出 `TS2353`！行 155 与 158 同理。
- **修复方案**：通过 `// prettier-ignore` 保护该断言保持单行书写，使指令精确覆盖在触发类型错误的语句正上方。

#### 散落 5：`src/pairing/rustParity.test.ts:167,519`
- **代码现场**：
  ```typescript
  // 现场 1（行 163-168）：
  for (const p of ['ios', 'android', 'other']) {
    const r = buildPairHello({
      code: 'CXN-7K4P-Q2MB-9XRT',
      deviceName: 'd',
      platform: p, // <--- p 被推断为 string，报 TS2322
    });
  }

  // 现场 2（行 511-519）：
  const mockHello = {
    code: 'CXN-7K4P-Q2MB-9XRT',
    deviceId: 'dev-test-0001',
    mobilePub: 'mock-mobile-pub',
    mobileLongPub: 'mock-mobile-long-pub',
    deviceName: '测试手机',
    platform: 'android', // <--- 被拓宽为 string，报 TS2345
  };
  const r = buildPairHello(mockHello);
  ```
- **根因分析**：
  - `buildPairHello` 接收的入参契约 `BuildPairHelloInput.platform` 类型为 `Platform | undefined`（其中 `Platform = "ios" | "android" | "other"`）。
  - 在 TS 中，未带 `as const` 的字面量数组 `['ios', 'android', 'other']` 会被自动拓宽（widen）为 `string[]`，循环变量 `p` 成为 `string`；未标注类型的字面量对象 `mockHello` 中，`platform: 'android'` 亦被自动拓宽为 `string`。
- **修复方案**：
  - 现场 1：添加常量断言 `for (const p of ['ios', 'android', 'other'] as const)`；
  - 现场 2：为 fixture 对象显式添加类型标注 `const mockHello: BuildPairHelloInput = { ... }`。

#### 散落 6：`src/presentation/components/runDetail/RunDetailHeader.test.tsx:24,58,125`
- **代码现场**：
  ```typescript
  // 行 21-32（makeProps）：
  return {
    runId: 'r-1',
    sessionTitle: '会话A',
    badge: 'running', // <--- TS2353
    badgeLabel: '运行中',
    tone: 'info',
    ...
  };

  // 行 58：overrides 传入 badge: 'error'（TS2353）
  // 行 125：<Probe {...props} badge="terminal" ... />（TS2322）
  ```
- **根因分析**：
  - 查阅组件实现 [`src/presentation/components/runDetail/RunDetailHeader.tsx:14-32`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/runDetail/RunDetailHeader.tsx#L14-L32)：
    ```typescript
    export interface RunDetailHeaderProps {
      runId: string;
      sessionTitle: string;
      badgeLabel: string;
      tone: RunBadgeTone;
      reason?: string;
      startedAtMs?: number;
      endedAtMs?: number;
      durationLabel: string;
      formatClock: (ms: number) => string;
    }
    ```
  - 在前期架构演进中，组件已被精简为纯展示组件，状态派生收敛至 `runDetailMeta.ts`，组件 Props 只接收 `badgeLabel: string` 与 `tone: RunBadgeTone`，移除了内部的 `badge` 原始状态字符串。
  - 但测试文件中的 `makeProps` 及两处测试用例仍残存着历史重构遗留的 `badge` 属性传递，导致类型检查失败。
- **修复方案**：彻底清理测试文件中残存的 `badge` 传递。

---

## 三、精确修复方案（实施阶段落地清单）

> **注**：本轮为只读调研阶段，严禁直接修改代码。以下为供后续实施阶段执行的精确落地改动步骤。

### 3.1 步骤一：彻底恢复 `packages/shared-types` 导出完整性

在 [`packages/shared-types/src/index.ts`](file:///c:/Software/conex/packages/shared-types/src/index.ts) 的第 326-376 行区域执行替换，补齐 `generated/engine` 的事件与解析器导出，并通过命名导出消歧：

```diff
--- a/packages/shared-types/src/index.ts
+++ b/packages/shared-types/src/index.ts
@@ -326,29 +326,45 @@ export type {
 // 引擎生成面（generated/engine）公共 re-export 面。
-// 维度 3 步骤 1（3-D 第 1 步）：消除 apps/crish-desktop 对
-// `packages/shared-types/src/generated/engine` 深路径的直引，统一经本公共面。
+// 消除 apps/crish-desktop 与 apps/crish-mobile 对
+// `packages/shared-types/src/generated/engine` 深路径的直引，统一经本公共面。
 //
 // 命名冲突处理：
-// generated 的 `AgentMessage` / `AgentMessageBlock` 与上方
-// `./message` 的同名导出**字段不对齐**（generated.metadata 为 JsonValue、
-// 含 content?: string；message.metadata 为 JsonObject、无 content）。
-// ESM 规则：显式命名导出优先于 `export *` 通配，故裸 `AgentMessage`/
-// `AgentMessageBlock` 绑定到 `./message` 版本；generated 版需经显式 alias
-// （`EngineAgentMessage`/`EngineAgentMessageBlock`）才可达——消费方按需取用
-// （如 store/types.ts 取 `EngineAgentMessage as AgentMessage` 本地别名），
-// 避免静默拿到错误版本。其它与 ./tool 等冲突的生成名（ToolOutput 等）同理
-// 由既有显式导出覆盖，generated 版被遮蔽（不破坏既有消费方）。
+// 1. generated 的 `AgentMessage` / `AgentMessageBlock` 与上方 `./message` 冲突：
+//    显式命名导出优先于 `export *`，裸名绑定到 `./message`；generated 版经 alias
+//    （`EngineAgentMessage`/`EngineAgentMessageBlock`）导出。
+// 2. generated/engine/parser 与 generated/device/parser 重叠标识符（同义同构工具函数）：
+//    ParseResult, parseOk, parseErr, isParseOk, isParseErr, parseApprovalDecision
+//    经显式 named re-export 导出，消除两份 wildcard export * 的 ESM 导出歧义。
 export * from './generated/engine/types';
 export type {
   AgentMessage as EngineAgentMessage,
   AgentMessageBlock as EngineAgentMessageBlock,
 } from './generated/engine/types';
 
-// generated/engine 运行期常量逐条 re-export（events.ts 的值常量；
-// types.ts 的 `as const` 值数组已由上方 `export *` 覆盖）。
-export {
-  ENGINE_EVENT_TYPES,
-  ENGINE_EVENT_BACKPRESSURE,
-  SUBAGENT_EVENT_KIND_BACKPRESSURE,
-} from './generated/engine/events';
+// generated/engine 事件全集（57 个事件类型与 EngineEvent 联合）
+export * from './generated/engine/events';
+
+// generated/engine 解析器全集（含 57 个 parseEngine*Event 解析函数）
+export * from './generated/engine/parser';
+
+// 消除 engine/parser 与 device/parser 重合的 6 个基础工具标识符歧义
+export {
+  type ParseResult,
+  parseOk,
+  parseErr,
+  isParseOk,
+  isParseErr,
+  parseApprovalDecision,
+} from './generated/engine/parser';
```

### 3.2 步骤二：修复移动端 6 处散落类型错误

#### 1. `apps/crish-mobile/src/adapters/wiring/filesWiring.test.ts`
```diff
--- a/apps/crish-mobile/src/adapters/wiring/filesWiring.test.ts
+++ b/apps/crish-mobile/src/adapters/wiring/filesWiring.test.ts
@@ -5,2 +5,3 @@
 import { WsGateway } from '@/network/WsGateway';
+import type { WsSocket } from '@/network/ReconnectingWsClient';
 import { authStore } from '@/domain/store/authStore';
@@ -23,3 +24,3 @@ function makeGateway(): WsGateway {
 /** mock socket（ReconnectingWsClient 工厂注入面，避免 jest 环境真实 WS） */
-function mockSocketFactory(): unknown {
+function mockSocketFactory(): WsSocket {
   return {
```

#### 2. `apps/crish-mobile/src/adapters/wiring/ingestRouter.test.ts`
```diff
--- a/apps/crish-mobile/src/adapters/wiring/ingestRouter.test.ts
+++ b/apps/crish-mobile/src/adapters/wiring/ingestRouter.test.ts
@@ -42,3 +42,3 @@ describe('dispatchIngestActions feed 面路由', () => {
     expect(window).toBeDefined();
-    expect(window.entries).toHaveLength(1);
-    expect(window.entries[0]!.type).toBe('message-delta');
+    expect(window!.entries).toHaveLength(1);
+    expect(window!.entries[0]!.type).toBe('message-delta');
   });
@@ -55,3 +55,3 @@ describe('dispatchIngestActions feed 面路由', () => {
     const window = eventStore.getState().windows['s-1'];
-    expect(window.entries).toHaveLength(2);
-    expect(window.lastSeq).toBe(2);
+    expect(window!.entries).toHaveLength(2);
+    expect(window!.lastSeq).toBe(2);
   });
```

#### 3. `apps/crish-mobile/src/domain/store/filesStore.test.ts`
```diff
--- a/apps/crish-mobile/src/domain/store/filesStore.test.ts
+++ b/apps/crish-mobile/src/domain/store/filesStore.test.ts
@@ -12,4 +12,3 @@ function makeEntry(
     name,
-    kind: 'file',
+    isDir: false,
     size: 0,
-    modifiedMs: 1000,
     relPath: name,
```

#### 4. `apps/crish-mobile/src/domain/store/settingsStore.test.ts`
```diff
--- a/apps/crish-mobile/src/domain/store/settingsStore.test.ts
+++ b/apps/crish-mobile/src/domain/store/settingsStore.test.ts
@@ -147,4 +147,3 @@ describe('类型安全（编译期断言：分组名 / 字段越界拒绝）', () => {
-      // @ts-expect-error notification 组没有 responseStyle 字段（字段越界拒绝）
-      settingsStore
-        .getState()
-        .update('notification', { responseStyle: 'high' });
+      // prettier-ignore
+      // @ts-expect-error notification 组没有 responseStyle 字段（字段越界拒绝）
+      settingsStore.getState().update('notification', { responseStyle: 'high' });
@@ -155,4 +154,3 @@ describe('类型安全（编译期断言：分组名 / 字段越界拒绝）', () => {
-      // @ts-expect-error sceneFlags 键越界（无 unknown 场景）
-      settingsStore
-        .getState()
-        .update('notification', { sceneFlags: { unknown: true } });
+      // prettier-ignore
+      // @ts-expect-error sceneFlags 键越界（无 unknown 场景）
+      settingsStore.getState().update('notification', { sceneFlags: { unknown: true } });
```

#### 5. `apps/crish-mobile/src/pairing/rustParity.test.ts`
```diff
--- a/apps/crish-mobile/src/pairing/rustParity.test.ts
+++ b/apps/crish-mobile/src/pairing/rustParity.test.ts
@@ -16,2 +16,3 @@ import {
   buildPairHello,
+  type BuildPairHelloInput,
   generateDeviceId,
@@ -163,3 +164,3 @@ describe('buildPairHello 纯函数（D3 §4.8 step 1 移动端构造）', () => {
   it('platform 值域与 Rust serde lowercase 一致（pair.rs:112-122；types.ts PLATFORM_VALUES）', () => {
-    for (const p of ['ios', 'android', 'other']) {
+    for (const p of ['ios', 'android', 'other'] as const) {
       const r = buildPairHello({
@@ -511,3 +512,3 @@ describe('mock-daemon 发送形状对拍（scripts/mock-daemon 参考面）', () => {
   it('pair.hello 发送 fixture 可被 buildPairHello 承载（字段名/形状一致）', () => {
-    const mockHello = {
+    const mockHello: BuildPairHelloInput = {
       code: 'CXN-7K4P-Q2MB-9XRT',
```

#### 6. `apps/crish-mobile/src/presentation/components/runDetail/RunDetailHeader.test.tsx`
```diff
--- a/apps/crish-mobile/src/presentation/components/runDetail/RunDetailHeader.test.tsx
+++ b/apps/crish-mobile/src/presentation/components/runDetail/RunDetailHeader.test.tsx
@@ -23,3 +23,2 @@ function makeProps(
     sessionTitle: '会话A',
-    badge: 'running',
     badgeLabel: '运行中',
@@ -57,3 +56,2 @@ describe('RunDetailHeader 渲染', () => {
         {...makeProps({
-          badge: 'error',
           badgeLabel: '失败',
@@ -124,3 +122,3 @@ describe('memo 隔离（R2UX-05-08：状态条不参与重渲染）', () => {
     await rerender(
-      <Probe {...props} badge="terminal" badgeLabel="已完成" tone="success" />
+      <Probe {...props} badgeLabel="已完成" tone="success" />
     );
```

---

## 四、删除面（无用类型/废弃指令/历史债务）

在实施修复与后续演进中，应彻底清退以下无效代码与历史包袱：

1. **废弃属性删除（`RunDetailHeader.test.tsx`）**：
   - 彻底删除 `badge: 'running'`、`badge: 'error'`、`badge="terminal"` 3 处已被组件架构淘汰的假属性传递。
2. **废弃字段删除（`filesStore.test.ts`）**：
   - 彻底删除 `makeEntry` 中的 `kind: 'file'` 与 `modifiedMs: 1000` 字段，杜绝与协议真源 `DirEntry` 发生认知漂移。
3. **失效指令规范化（`settingsStore.test.ts`）**：
   - 清理错位的 `@ts-expect-error` 指令，通过 `// prettier-ignore` 锁定单行格式，避免未来代码格式化再次破坏类型守卫。
4. **Desktop 深路径债务清退清单（供后续战役统一收口）**：
   - 将 `apps/crish-desktop` 中 16 处深路径 `../../../../packages/shared-types/src/generated/engine` 全部登记为待清退项，在下一步统一替换为标准的 `from '@crish/shared-types'`。

---

## 五、验证断言与门禁检查套件

实施完成后，须按顺序执行以下验证套件以确保全仓契约与类型系统严丝合缝：

1. **移动端类型检查（目标全绿，0 错误）**：
   ```powershell
   npm run typecheck -w @crish/crish-mobile
   ```
   *预期断言：退出码 0，控制台零诊断输出。*

2. **根工作区类型检查（确保 Desktop / Workbench / Packages 零破坏）**：
   ```powershell
   npm run typecheck
   ```
   *预期断言：桌面端与基础包全部绿灯，无任何导出破坏。*

3. **`shared-types` 契约包全量单测**：
   ```powershell
   npx vitest run packages/shared-types
   ```
   *预期断言：9 个测试套件、100 个测试用例全部 Pass（特别是 `type-drift.test.ts` 与 `parity.test.ts`）。*

4. **移动端单元测试验证**：
   ```powershell
   npm --workspace @crish/crish-mobile run test
   ```
   *预期断言：修复后的 6 个移动端测试文件全部执行通过，断言无回退。*
