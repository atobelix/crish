# Crish 性能/架构收尾 — Round 7–9 多 Agent 执行纲要

**文档版本**: v1.0
**前置**: Round 1–6 已完成（UI 性能、测试修复、Vite MCP、settings eco、STREAM_PAUSE pause-buffer）
**项目根**: `c:\Software\conex`
**分支**: `refactor/architecture`

---

## 已完成（禁止重写）

| 范围                                                                                       | 状态                                            |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| R1–4 UI 性能（useDaemonState / CardPanel / stableWidth / drop / eco backdrop / perf tier） | DONE                                            |
| R5 13 测试 + Vite MCP 解耦                                                                 | DONE（1751 desktop tests green, vite build OK） |
| R6 settings eco + Daemon STREAM_PAUSE pause-buffer                                         | DONE（registry 级 pause/buffer/wait）           |

**禁止**：假忙碌重写已绿模块；跨轮污染；魔法 TODO。

---

## 剩余瓶颈（本纲要目标）

1. **协议半正式**：`stream-pause` / `stream-resume` 仅 server 旁路，未进 `DAEMON_INBOUND_MESSAGE_TYPES` / validators / schema-groups
2. **缺集成测**：pause/resume 有 unit，但缺 binary+JSON → RunHandler 的端到端测
3. **构建体积**：`vendor-lucide` ~555KB、`App` ~736KB；大量 `import * as Lucide` 阻止 tree-shake
4. **文档/契约**：`streaming-transport-contract.md` 未记录 client STREAM_PAUSE 语义

---

## 总体轮次

```
Round 7（协议正式化 + 背压集成测）
  ├── Agent 7A：stream-pause/resume 写入 protocol registry + types + handlers
  ├── Agent 7B：STREAM_PAUSE 集成测试（binary + JSON）
  └── Agent 7-AUDIT：daemon protocol tests + agent-daemon vitest 全绿

Round 8（构建体积 / 首屏分块）
  ├── Agent 8A：lucide 命名导入 + tree-shake（缩小 vendor-lucide）
  ├── Agent 8B：App 主包拆分 / lazy 边界收紧
  └── Agent 8-AUDIT：vite build 对比 chunk 体积

Round 9（全量回归 + 契约文档）
  ├── Agent 9A：更新 streaming-transport-contract 背压章节
  └── Agent 9-FINAL：tsc + vitest(desktop+daemon) + vite build 终极表
```

---

## Round 7

### Agent 7A — 协议正式化

**目标**：`stream-pause` / `stream-resume` 成为一等公民 inbound 消息。

**文件（预期）**：

- `packages/agent-daemon/src/types.ts` — 类型 + union
- `packages/agent-daemon/src/protocol/registry.ts` — `DAEMON_INBOUND_MESSAGE_TYPES`
- `packages/agent-daemon/src/protocol/schema-groups.ts` — 归入 `event-stream` 或 `run`
- `packages/agent-daemon/src/protocol/validators/common.ts`（及 base 若重复导出）— FIELDS
- `packages/agent-daemon/src/protocol/validators/run.ts` — validate 函数
- `packages/agent-daemon/src/protocol/protocol.ts` — switch cases + re-export
- `packages/agent-daemon/src/server-handlers.ts` — switch 调用 pause/resume
- `packages/agent-daemon/src/server.ts` — 旁路可保留作防御，但主路径应走 validate → handleInboundMessage

**消息形状**（与前端一致）：

```typescript
{ type: "stream-pause"; runId: string; correlationId?: string; requestId?: string }
{ type: "stream-resume"; runId: string; correlationId?: string; requestId?: string }
```

**出站 ACK**：可继续用 binary STREAM_ACK 或轻量 `{ type: "pong" }` / 新增 `stream-control-ack`（**优先不扩 outbound**，用 correlateResponse pong 或 silent apply）。

**验收**：

- `registry.test.ts` 仍全绿（types 集合一致）
- `validateInboundMessage({ type:'stream-pause', runId:'r1' })` ok
- JSON 路径不再依赖「仅旁路」才能工作

### Agent 7B — 集成测试

**目标**：证明 pause 真缓冲、resume flush。

**文件**：`packages/agent-daemon/src/stream-backpressure.test.ts` 已有 unit；新增：

- `packages/agent-daemon/src/handlers/run-handlers.stream-pause.test.ts` 或扩展 server.test

**用例**：

1. `pauseStream` 后 `tryBuffer` 生效；`resumeStream` flush 到 mock transport
2. `waitIfPaused` 在 resume 前不 resolve
   3.（可选）binary frame decode → server handler 调 pauseStream（mock RunHandler）

**验收**：agent-daemon vitest 相关文件 0 fail。

---

## Round 8

### Agent 8A — lucide tree-shake

**问题**：~53 文件 `import * as Lucide from 'lucide-react'` → 整库进 `vendor-lucide` ~555KB。

**策略**：

1. 高频组件改为命名导入：`import { ChevronDown, X } from 'lucide-react'`
2. 若组件用 `Lucide[dynamicName]` 动态查表，保留 namespace import 但隔离到 `icons/lucideMap.ts` 单点
3. 验证 `npx vite build` 后 `vendor-lucide-*.js` 体积下降（目标 < 300KB 或无单独 vendor 且总 JS 下降）

**禁止**：删除图标导致 UI 空白；大范围视觉改版。

### Agent 8B — App chunk 拆分

**问题**：`App-*.js` ~736KB。

**策略（只做安全拆分）**：

1. 确认重型面板（Settings 已 lazy）静态 import 链
2. 将仅设置/冷路径依赖改为 `React.lazy`
3. 勿破坏主路径 Workspace/Chat 启动
4. 记录 build 前后 chunk 表

**验收**：`vite build` 成功；App 主包下降或合理 split；功能不回归（tsc + 相关 test）。

---

## Round 9

### Agent 9A — 契约文档

更新 `docs/architecture/streaming-transport-contract.md` Backpressure 节：

- 前端 64KB/16KB 水位 → STREAM_PAUSE/RESUME
- Daemon pause-buffer + for-await wait
- binary 0x21/0x22 + JSON types

### Agent 9-FINAL

| 检查     | 命令                                              | 期望     |
| -------- | ------------------------------------------------- | -------- |
| TS       | `npx tsc --noEmit -p apps/crish-desktop`          | 0 errors |
| Tests    | `vitest apps/crish-desktop packages/agent-daemon` | 0 failed |
| Build    | `cd apps/crish-desktop && npx vite build`         | success  |
| Protocol | grep stream-pause in registry                     | 存在     |
| Lucide   | dist vendor-lucide 或总 JS 改善                   | 记录数字 |

---

## 反偷懒守则

1. 改动精确到行/文件
2. 每 Agent 输出验证命令结果
3. 禁止跨轮改无关模块
4. 审查与实现可分离；调度方做 FINAL

---

## 执行结果摘要（调度方 2026-07-22）

| Round   | 状态 | 要点                                                                   |
| ------- | ---- | ---------------------------------------------------------------------- |
| 7A      | DONE | stream-pause/resume 进 registry/types/validators/handlers；JSON 去旁路 |
| 7B      | DONE | run-handlers.stream-pause.test.ts 7 用例；daemon 226 tests             |
| 8A      | DONE | lucide 命名导入；vendor-lucide **555→27 KB**                           |
| 8B      | DONE | CardPanel 冷面板 React.lazy；主包约 −214 KB                            |
| 9A      | DONE | streaming-transport-contract 背压章节更新                              |
| 9-FINAL | DONE | 修 clamp 回归；tsc/vitest/build 验收                                   |

### Chunk 最终参考（vite build）

| 文件                                      | KB          |
| ----------------------------------------- | ----------- |
| index-*.js                                | ~1084       |
| vendor-workers                            | ~125        |
| vendor-lucide                             | **~27**     |
| DiffCard / FilesCard / purify / AgentCard | 按需 ~10–34 |

### 并行注意

Round 8 双 Agent 曾竞争 `components/`；调度方在 R9 复核 CardPanel lazy + lucide named 并存，并修复被冲掉的 `SidebarContextMenus` clamp 测试。
