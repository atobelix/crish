# Wave 4–6 性能与中控 — 事实纪要（D0-8）

> 对应门禁：`docs/plans/2026-07-system-architecture-control-master-plan.md` **D0-8** `perf-report`  
> 进度真源：`docs/plans/progress/system-control-ledger.md`  
> 早期 R1–R3 方案：`docs/perf/MULTI_AGENT_PERF_PLAN.md`  
> 日期：2026-07-29

本文只记已落地事实，不写规划愿望。

---

## 1. 流式写路径

| 内容 | 落点 | 备注 |
|------|------|------|
| 助手正文 / thinking（流式中） | `streamingStore` | 无 immer；热路径旁路 session 全量 patch |
| **工具 intermediate**（running 增量） | `streamingStore` tools 行 | **W5-1** lite store；不写 durable session 行 |
| **工具 terminal**（终态 success/error/…） | session 消息 | durable；merge 时 intermediate 不得覆盖 terminal |
| 终端多行输出 | session（batch API） | R1 `addTerminalLines` 路径；与 tool lite 分离 |

验证入口：`apps/crish-desktop/src/store/streamingStore.ts` + `streamingStore.test.ts`。

---

## 2. Shell / 布局热路径

| 项 | 状态 | 波次 | 事实 |
|----|------|------|------|
| `UnitSessionTabStrip` 窄订阅 | done | W4-3 / S4.1 | 不订整棵 openTabs/root；`openTabsStripRelevantEqual` / unit 投影；subscribe 测绿 |
| sash memo | done | W4-3 / D0-7 | resize 拖中 memo，避免无关 leaf 重渲 |
| live resize DOM map | **partial** | W6-7 / S4.3 | 部分落地；「仅 paint 受影响子树」仍 residual（见 shell plan） |
| strip a11y / toolColumn lock | done | W6-7 | roving + overflow；非 FPS 主项但减无效重渲路径 |

相关测：`UnitSessionTabStrip.subscribe.test.tsx`（见 `wave4-smoke-results.md`）。

---

## 3. 可观测 / 健康

| 项 | 状态 | 波次 |
|----|------|------|
| control / empty-shell metrics 扩展 | done | W4-8 |
| health hook pack | done | W5-5 |
| **dev health overlay** | done | W5-6 |
| silent complete alert | done | W5-3 |
| OTel / traceId e2e / 正式 health UI | residual | — |

---

## 4. PTY

| 项 | 状态 | 波次 |
|----|------|------|
| exit → **`kill_all`** | done | W4-4（Rust `RunEvent::Exit` + FE composition `pty.killAll`） |
| **Windows Job Object**（PTY 自有） | done | W6-2 |
| 跨平台 / 残余孤儿策略 | residual | 可挂 shell plan |

---

## 5. Run 控制队列（force / steer / followUp）

| 环 | 语义 | 波次 |
|----|------|------|
| **force** | 可 mid-stream；L3 硬停路径 | W6-1 + 既有 ControlBus |
| **steer** | 安全点注入（tool 批后 / provider 空闲）；可续 turn | W6-1 |
| **followUp** | 仅 run 将 idle 时 promote；勿当 force | W6-1 |

优先级：`force_cancel (L3) > cooperative_stop (L2) > L1 inject（steer / followUp 分环）`。  
协议与产品语义：`docs/architecture/run-control.md`。

---

## 6. 与 R1–R3 backlog 的关系

- R3 的 **#10 正文旁路** 与 Wave 的 **tool lite store** 共用 `streamingStore`（无 immer），但职责分开：text/thinking vs tools intermediate。  
- 正文 `buffer.onFrame → session` 是否 100% 旁路，以 `MULTI_AGENT_PERF_PLAN.md` §10 为准；本纪要不重开该债。  
- D0 其它 residual（md Rust SoT、fixture parity、conex-stream）**不**因本 D0-8 关闭。

---

## 7. 建议回归面（文档/手测）

1. 工具 running 增量：Profiler 上 session 不应每 token 因 tool intermediate 全量 set。  
2. 多 unit strip：改无关 unit 的 tabs 时本 strip 不重渲。  
3. sash 拖中：跟手；松手再进 store。  
4. 关窗 / PTY exit：子进程被 kill_all / Job Object 收口（Windows）。  
5. 运行中 steer vs followUp：注入时机符合 `run-control.md` §1.1。  
6. Dev：health overlay + control metrics 可见（非正式产品 UI）。

---

## 8. S4.4 流式双订阅合并（shell residual / OPT-7）

> 日期：2026-07-29 · 范围：chat 行热路径，**不**改 virtualizer

### 代码读 profile（合并前）

| 组件 | session / props | streamingStore | 问题 |
|------|-----------------|----------------|------|
| `ChatAssistantMessageRow` | durable `msg` props | **streamText** + **streamThinking**（2） | streamText 与 content 重复 |
| `MessageContent` | durable `msg` props | **streamText** + **streamTools**（2） | 双 hook；text 与 row 重复 |
| `useChatMessageState` | pins 再订 `sessionsById[sid].messages` | — | **OPT-D8 已修**：父透传 `allMessages`；只订 `pinnedMessageIds` |

Live 行热路径合计 **4** 个 streamingStore 选择器，其中 `streamText` 父子各订一次。

### 已修

| 改动 | 落点 |
|------|------|
| 行只订 **thinking**；复制用 `getStreamText` 命令式读 | `ChatAssistantMessageRow.tsx` |
| content **单** `useShallow({ text, tools })`；非 live 恒 `EMPTY_STREAM_BODY` | `MessageContent.tsx` |
| 静态锁：row/content 各 1× `useStreamingStore`；row 无 `?.text` | `messageRenderIdentity.test.ts` |

效果：live 行 **2** 订阅（thinking | body），字段隔离——token 只打 content，thinking tick 不经 body 的 shallow 切片；历史行仍恒 undefined / EMPTY，不跟 byKey 重渲。

### Residual

- **session 全量 messages / pin 双订（OPT-D8，2026-07-29）**：~~`useChatMessageState` 再订 `sessionAllMessages`~~ **done** — ChatCard 透传 `allMessages={state.messages}`；list pin 只订 `pinnedMessageIds`；`buildPinnedItems` + `pinnedItemsEqual` 稳 pin 身份；`jumpToPinned` 用 refs 不跟 token 换 callback。
- **useChatCardState 多字段散订**（title / agents / cursor…）：可 `useShallow` 聚合，非 stream 行主项。
- **S4.3** live resize「仅 paint 受影响子树」仍 open。
- 正文 `buffer.onFrame → session` 是否 100% 旁路：仍见 `MULTI_AGENT_PERF_PLAN.md` §10 / 上文 §6。
