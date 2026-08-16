# 详案 · T4 单一投影 store（T4-desktop 双 store 合并 / T4-mobile 投影原语下沉）

> 战役：统一输入流收敛 · 方案生成阶段第 4 步
> 维度：**T4 单一投影 store**（02-总计划框架 §1 T4 行 · R5 批次）
> 依赖：**T3（store 类型单源）**；与 **V1 同批 R5**（共享 MessageContent/streamingStore 文件域，防 worktree 争写）
> 依据：00-核心逻辑模型草案（§3 前端原则、不变量 3/6）、analysis/12（上帝 store/消息双份/queueMicrotask 时序闭环）、analysis/16（sessionStore facade 修正、streamingStore 热缓冲是设计内必需桥）、analysis/19（mobile eventStore.windows 近理想、投影原语）、independent-plans/05（T4+V1 同批）、02-总计划框架（决策 5：T4/V1 同批不硬拆）。
> 纪律：本详案为唯一产出文档；只读核实代码；禁止 git 提交；区分「源码形状」与「真跑验证」。
> 目标形态一句话：**以事件流为唯一写入源，收敛出单一「时间线投影 store」——热缓冲（streamingStore 中间态）与持久投影（layoutStore/session.messages 终态）语义合并但桥语义（queueMicrotask clearStream 时序闭环）完整保留；storeAccess 三份归一为一份统一读面；mobile/desktop 共用 transport 无关的共享投影原语。**

---

## 0. 任务标识

- 维度：T4（T4-desktop 双 store 合并 / T4-mobile 投影原语下沉）
- 前置依赖：**T3**（store 消息类型已从 generated 派生后，合并的才是同一类型）；无其它前序阻塞
- 同批关系：**V1**（R5 同批，决策 5「同批不硬拆」）——共享 `components/chat-message/MessageContent.tsx` 与 `store/streamingStore.ts` 文件域
- 相关审计：analysis/12（§④.2/3/§⑤）、analysis/13（G3/G4 撕裂与分域）、analysis/16（§⑥ 单链、streamingStore 热缓冲必需）、analysis/19（§5.1 投影原语）、independent-plans/05（T4/V1 §3.3/§3.4）
- 本详案只读核实的关键源码：
  - `apps/crish-desktop/src/store/streamingStore.ts`（414 行，byKey 热缓冲）
  - `apps/crish-desktop/src/hooks/chat-stream/helpers.ts`（415 行，commitStreamToSession + queueMicrotask clearStream）
  - `apps/crish-desktop/src/components/chat-message/MessageContent.tsx`（412 行，渲染期 merge view model）
  - `apps/crish-desktop/src/store/storeAccess.ts`（188 行，store 侧读面，仅四新域+chrome）
  - `apps/crish-desktop/src/api/storeAccess.ts`（162 行，编排层）
  - `apps/crish-desktop/src/api/store-access/componentAccess.ts`（116 行，**全树约 90 处引用**）
  - `apps/crish-desktop/src/api/store-access/sessionAccess.ts`（300 行，编排层会话/消息写）
  - `apps/crish-mobile/src/domain/store/eventReducers.ts`（262 行，环形缓冲/去重/游标/过滤纯函数）
  - `apps/crish-mobile/src/domain/store/eventMappers.ts`（271 行，type→store 路由，transport 无关）
  - `apps/crish-mobile/src/adapters/wiring/feedBridge.ts`（253 行，接线层，mapDeviceFrame 消费方）
  - `apps/crish-mobile/src/domain/store/eventStore.ts`（106 行，vanilla store 一行转发）
  - `scripts/check-store-facade.mjs` / `scripts/check-no-raw-setstate.mjs`（门禁）
  - `packages/shared-utils/src/index.ts`（191 行，共享包 barrel）

---

## 1. 做什么（新增/改造清单）

### 1.0 概念边界（先定合并的「双域语义」，防误删热缓冲）

依据 analysis/16 §① 订正 + 00 核心模型不变量 6：**`streamingStore.byKey` 与 `layoutStore.messages`（sessionStore facade 同一实例）不是冗余双存储，而是「设计内必需桥」**：

| 域                   | 位置                                                       | 语义                                                          | 生命周期                                                                       |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 热缓冲（中间态）     | `streamingStore.byKey`（纯内存，无 immer）                 | 每 token 流式增量帧（text/thinking/tools/images），Delta 可丢 | 流式期间存在；`commitStreamToSession` 收口后 `queueMicrotask clearStream` 清空 |
| 持久投影（终态落点） | `layoutStore`/`sessionStore.messages`（同一 zustand 实例） | run 收口/工具快照终态正文与 toolCalls，Critical 落 persit     | 常驻；run 收口后才写                                                           |

**合并边界（本详案的裁决，回应任务书 1）**：合并是指**消除「流式期间正文/tool 在两个 store 各一份」的重复投影**，**不是**把热缓冲并掉。热缓冲是时序闭环 `queueMicrotask clearStream`（helpers.ts:226-233 注释：「严禁同步 clearStream()，必须推迟微任务，杜绝组件切换瞬间白屏闪烁」）的**依赖前提，禁止删除**（任务书禁止项 6）。合并的正确落点是**让「流式渲染 view model」成为投影链的唯一产出，持久投影在收口时一次性落账**，热缓冲保持独立中间态。

### 1.1 T4-desktop · 双 store 消息部分合并

**新增/改造项 A1 —— 流式渲染 view model 归一（投影链单源）**

- 概念目标：当前 `MessageContent.tsx:138-166` 内嵌的「`useStreamingStore` selector + `applyStreamTextToMessage`/`applyStreamToolsToMessage` 渲染期 merge」上移到**页面壳层**，复合层只收「已合并的 view model」（对齐独立方案 05 T4 §3 建议 1、analysis/11 §⑥ S5、analysis/12 §⑤.1）。
- 关键文件域：`components/chat-message/MessageContent.tsx`、`components/chat-message-row/ChatAssistantMessageRow.tsx`、`components/chat-message/streamMessageViewModel.ts`
- 改动性质：重构（把渲染期 merge 从组件内联上移到壳层 view model 装配点；恢复至 `applyStream*` 纯函数 + 一次合并）
- 边界约束：**不删 `streamingStore` 的 byKey 中间帧**；`commitStreamToSession` 的 `queueMicrotask clearStream` 时序闭环（helpers.ts:226-233）**原样保留**。合并只收敛「渲染读取路径」，不触碰「热缓冲写入/清理路径」。

**新增/改造项 A2 —— `sessionStore` 消息持久投影定位固化**

- 概念目标：按 analysis/16 §① 与 12 §⑤ 修正，把 `sessions[].messages` 明确定位为「事件流的持久投影缓存（终态落点）」，**不新增第三个 store**（任务书禁止项 6）。`SessionMessage` 类型由 T3 降为 generated 派生；本纬不重复定义类型（依赖 T3 提供）。
- 关键文件域：`store/layoutStore.ts`、`store/sessionMessageActions.ts`（调用方侧迁移）
- 改动性质：定位修正 + 注释固化（`storeOwnership.ts` SESSION_OWNERSHIP 只写主背书）

**新增/改造项 A3 —— 消息写入通道归一（`api/storeAccess` 编排单点）**

- 概念目标：把散落在 `helpers.ts` 的 `updateMessageText`/`updateMessageThinking`（经 `sessionAccess.ts` → `getSessionStoreState().updateMessageText`）与 `layoutStore` 的 `addMessageToolCall`/`updateMessageToolCall` 收敛为**单一编排写入口**。默认即 `api/store-access/sessionAccess.ts`（300 行，已是标准化写门面），确保 `commitStreamToSession` 走这一单通道（对齐 check:store-writes 门禁的「单一写入通道」语义）。
- 关键文件域：`hooks/chat-stream/helpers.ts`（调用侧）、`api/store-access/sessionAccess.ts`（既有编排，保持）
- 改动性质：接线整理（把 helpers.ts 中对 layoutStore 直写的调用改为统一走 sessionAccess）

### 1.2 storeAccess 三份归一

**现状核实（重要，与审计乐观假设的差异）**：

- `store/storeAccess.ts`（188 行）覆盖 **terminal/worker/permission/settings 四新域 + 布局 chrome**（store 侧读面）。
- `api/storeAccess.ts`（162 行）= 编排层（跨域写门面），经 `store-access/{sessionAccess,settingsAccess,storeAccessCore,telemetryAccess,helperAccess}`（`api/store-access/` 目录）。
- `api/store-access/componentAccess.ts`（116 行）= rule-B 豁免体，components 读 store 的过渡门面，**实际被全树约 90 处引用**（`grep componentAccess apps/crish-desktop/src` 实测 91 命中，覆盖 binary-tree/agent-card/chat-message/chat-card/sidebar/workspace/settings/card-panel/overview/shell/chat-message-row/diff/files 等全组件的读面）。**它覆盖了 store 侧 storeAccess 未覆盖的 sessions/layout-tree/workspace-shell/streaming/draft**——这是「补齐后删」成立的前提，现实是**这 ~90 处依赖组件读面，删除成本远高于审计假设的自证补删**。

**新增/改造项 A4 —— 统一读面（storeAccess）收敛**

- 概念目标：三份（store/storeAccess 读面 + api/storeAccess 编排 + componentAccess 过渡面）归一为**一份统一读面**。
- 关键文件域：`store/storeAccess.ts`（读面，扩容覆盖 sessions/layout-tree/workspace-shell/streaming/draft）、`api/storeAccess.ts`（编排层保持独立）、`api/store-access/componentAccess.ts`（迁移后删）
- 改动性质：重构 + 迁移
- **收敛策略（两份，含成本提示）**：
  - **策略 α（推荐，净收益最大但改面大）**：把 `componentAccess.ts` 的会话/layout-tree/workspace-shell/streaming/draft 读面**并入 `store/storeAccess.ts`**（扩读面到全 store 域），然后把 `componentAccess.ts` 的所有 import 重写为 `store/storeAccess.ts`（`check:store-facade` 白名单本就含 `store/storeAccess.ts`，读面仍命中白名单、不新增违规）。删 `componentAccess.ts`。**成本**：约 90 处 import 重写（机械可脚本化），store/storeAccess 扩容覆盖约 6~8 个域 → 行数从 188 增长到约 300+（在业务线 400 行内，超限走拆分登记）。**收益**：读面入口唯一，彻底消除三份。
  - **策略 β（最小割，保留 componentAccess 但改为 re-export 转发）**：若 store 域冻结约束（T11 曾冻结 store 域不补）不可放宽，则**保留** `componentAccess.ts` 作为「全域读面，转发自 store 侧 + 编排侧」的唯二入口之一，`store/storeAccess.ts` 与 `componentAccess.ts` 合并为一份（`componentAccess` 收编进 `store/storeAccess` 或反向）。**只消解「读面分两处」**，不追求删到零文件。**适合**：评审认为扩 storeAccess 越过「store 域冻结」红线的场景。**但本详案默认走策略 α**（方案层优先效果完整度，见反退避纪律）。
- 验收口径见 §5。

### 1.3 T4-mobile · 投影原语下沉（共享）

**新增/改造项 A5 —— 共享投影原语（packages/shared-utils）**

- 概念目标：把 mobile `eventReducers.ts`（环形缓冲/去重/游标/过滤，262 行）与 `eventMappers.ts`（type→store 路由，transport 无关，271 行）中**transport 无关的纯函数部分**抽入 `packages/shared-utils`，两端共用「事件→投影」的纯逻辑（对齐 19 §5.1 收敛动作 2、00 核心模型 §3.3「共享投影原语」）。
- 关键文件域：`packages/shared-utils/src/`（新增投影原语模块 + index barrel 导出 + 单测）
- 改动性质：新增共享模块 + mobile 消费迁移 + desktop 投影端对齐
- **边界**：共享的必须是「纯逻辑 + 契约」，**不共享 transport**（desktop 本地 broadcast vs mobile 远程 WS 分属不同接线层，见 19 §5.1「不共享 transport」）。mobile 的 `FeedBridge`（接线层、依赖 WsGateway）**不**下沉，保持 mobile 本地。共享的原语清单：
  1. **事件信封宽容解析**：`readRecord/readString/readNumber/readBool`（eventReducers.ts:51-78）—— 两端事件体契约一致（generated），transport 无关。
  2. **环形缓冲 + 去重 + 游标升降**：`appendFeed/createWindow/hydrateFeed/advanceCursor/stableSortBySeq/trimWindow`（eventReducers.ts:92-190）—— 纯状态机，两端共用（desktop 事件消费逻辑的 seq 幂等/去重同理）。
  3. **过滤原语**：`filterErrors/filterByRunId/filterByTypes/filterFeed + deriveErrorLevel`（eventReducers.ts:207-262）—— 仅 feed 展示派生。
  4. **type→route 路由表**：`EVENT_ROUTES/KNOWN_EVENT_TYPES/routeEventType + mapIngestFrame/mapDeviceFrame 的纯分派`（eventMappers.ts，去 transport 依赖）—— 但注意其 `ENGINE_EVENT_TYPES` 深引用 `packages/shared-types/src/generated/engine/events`（eventMappers.ts:5），下沉为 shared-utils 后改为从 `@crish/shared-types` 引即可（同包内相对引用转包引用）。
- **主控要裁决的取舍**：`eventMappers.ts` 的 `StoreIngestAction`（eventMappers.ts:17-37）是 **mobile store 动作字面量**（feed-append/run-active/approval-delta…），下沉共享需与 desktop 的事件消费映射动作对齐。若两端 store 动作语义不完全一致（desktop `chat-bridge` 走 `env.callbacks` 而非 `StoreIngestAction`），则**只共享 A5-1~A5-3（纯状态机原语），`eventMappers` 的 store 路由表作为「共享的类型→路由声明」供两端各自翻译**，不强行统一动作字面量（避免为对齐而造抽象，对齐抽象纪律「接口两实现法则」与 anti-overengineering）。

- **mobile 依赖注入**：mobile 当前**不依赖 `@crish/shared-utils`**（仅 `@crish/shared-types`）。策略 α-α：为 mobile `package.json` 增加 `@crish/shared-utils` 依赖（文件引用 `file:../../packages/shared-utils`），并确认共享原语模块不打进需要 React peer 的 bundle（`packages/shared-utils` 有 `react >=18` peer dep 与 node/browser 双 build；投影原语是纯函数无 React，**建议放入 `browser` 入口或独立 subpath export**，避免引入 React peer 约束到 mobile）。**执行期需确认 esbuild bundle 与 RN 兼容**（原语是纯 TS，无 DOM，预期兼容，但需真跑验证 mobile 消费）。

---

## 2. 删什么（删除/合并清单）★ 必填

| #   | 待删项                                                                                      | 类型                                 | 证据（文件:行 / grep 实测）                                                                                                                      | 删除方式                                                                                                                                                 | 风险与回滚                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `api/store-access/componentAccess.ts`                                                       | 重复路径/过渡门面（rule-B 豁免读面） | `componentAccess.ts:13-14`「待 store/storeAccess 补齐后移除」；**全树 ~90 处引用**（grep `componentAccess` apps/crish-desktop/src 实测 91 命中） | 策略 α：把其导出并入 `store/storeAccess.ts` → 全 import 重写 → 删文件；`check:store-facade` 白名单已含 `store/storeAccess.ts` 不新增违规                 | **高**：90 处 import 迁移面大；漏迁一处即 typecheck 红。回滚 = 保留文件、import 回退。**必须机械化**（codemod 或逐文件 sed 后 typecheck 兜底） |
| 2   | 双 store 消息正文/工具**持久投影的重复副本**（收口后 layoutStore 里与热缓冲重复的中间态行） | 重复路径                             | 12 §④.3；`helpers.ts:197-235 commitStreamToSession` 收口后再无热缓冲中间态残留 → layoutStore 只留终态                                            | 合并 A1（view model 单源）后，layoutStore.messages 不再存流式中边帧；`commitStreamToSession` 只在收口写终态                                              | 中：若合并时序有误，可能丢流式尾部。**真跑 vitest 流式测试守护**                                                                               |
| 3   | `streamingStore` 作为**持久投影副本**的性质（非删文件）                                     | 降级                                 | 12 §⑤ 删除面；16 §① 修正为设计内必需桥                                                                                                           | **不删文件**，只把其「第二真相源」语义降级为「同一投影链的热缓冲中间帧」——保留 byKey、保留 queueMicrotask clearStream（禁止项 6）                        | 低（不删代码，只改定位/注释）                                                                                                                  |
| 4   | mobile `eventReducers.ts` / `eventMappers.ts` 中**下沉到 shared-utils 的重复代码**          | 重复路径（双端平行实现）             | 19 §④「事件信封解析 + 事件→store 映射在 desktop 与 mobile 各有一份」；`eventReducers.ts`/`eventMappers.ts` 为 mobile 本地实现                    | 从 `packages/shared-utils` 引回共享原语，mobile 本地文件删除下沉部分、保留 mobile 接线发                                                                 | 中：下沉后 mobile 本地文件行数降、契约单源；确保两端消费同一原语不漂移                                                                         |
| 5   | storeAccess 三份中的两份合并后**残留**（re-export 重复/死导出）                             | 重复路径                             | 12 §④.2 三份 storeAccess。合并后 `componentAccess` 被删；`store/storeAccess`+`api/storeAccess` 各自职责唯一（读面 vs 编排）                      | 删 `componentAccess` 后，确保 `store/storeAccess` 与 `api/storeAccess` 不重复 re-export 同一读面（读面只放 store/storeAccess，编排只放 api/storeAccess） | 低                                                                                                                                             |

**不删（明确保留）**：

- `streamingStore.ts` 热缓冲文件、`byKey`、`queueMicrotask clearStream` 时序闭环（任务书禁止项 6，analysis/13 确认设计内必需桥）。
- `layoutStore.messages`/`sessionStore` 持久投影（终态落点，不新造第三个 store）。
- 中间态（流式过程中 text/thinking/tools 任一帧）不得在合并中丢失（任务书禁止项 6）。
- 投影纯函数层 `streamMessageViewModel`、`timelineNormalizer`、`tool-presentation/*`（轨 A）—— 这些是渲染真身，**归 V1 处理，T4 不删**（避免与 V1 边界重叠）。

---

## 3. 依赖与逻辑顺序

### 3.1 内部步骤序列（先删后建、删除先于新增依赖）

1. **S1（前置，依赖 T3）**：确认 `store` 消息类型已由 T3 收敛为 generated 派生（`SessionMessage` 为投影缓存派生）。**未达 T3 验收前不启动 A1**（否则合并用的是手写类型）。
2. **S2（A5 共享投影原语，可并行前置）**：在 `packages/shared-utils` 新增投影原语模块（eventReducers/mappers 纯函数）→ 原生单测（mobile+desktop 共用）→ mobile 迁移消费 → 桌面投影对齐。**可与 T4-desktop 并行**（独立文件域）。
3. **S3（A1+A2+A3 T4-desktop 双 store 合并）**：view model 上移壳层 → 持久投影定位固化 → 写入通道归一。**保留热缓冲时序闭环**。
4. **S4（A4 storeAccess 归一）**：`store/storeAccess` 扩容 → componentAccess 90 处 import 迁移 → 删 componentAccess → 门禁验证。
5. **S5（收口）**：typecheck + vitest（流式测试真跑）+ `check:store-facade` / `check:store-writes` + `check:desktop`；合并度量回填。

### 3.2 与其它维度的接缝

| 维度              | 关系                     | 接缝契约                                                               |
| ----------------- | ------------------------ | ---------------------------------------------------------------------- |
| **T3**            | 前序依赖                 | store 消息类型从 generated 派生前置；本纬不重复定义类型                |
| **V1**（同批 R5） | **同批不硬拆**（决策 5） | 共享 `MessageContent.tsx` + `streamingStore.ts`；**文件级分工见 §3.3** |
| T2（持久化轨）    | 独立                     | T4 消费 `layoutStore.messages` 持久投影，不生产持久化轨                |
| R1/R2             | 承载依赖                 | T4/V1 收敛单一投影链后，R 维前端部分复用其投影刷新                     |

### 3.3 T4/V1 同批内文件级分工（防 worktree 争写）★ 必填

> 决策 5「同批不硬拆」+ independent-plans/05 §3.3「T4 把两个 store 合掉、V1 把渲染主路径定成单一投影，在同一个文件改动里同时完成才是净删除最大」。但**同一批内两 Agent 不可争写同一文件**，故按「文件维度切分」而非「轮次切分」：

| 文件                                                                         | T4 归属                                                                          | V1 归属                                                      | 并行安排                                                                                                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store/streamingStore.ts`                                                    | **T4**（热缓冲定位固化、byKey 导出归一；不删）                                   | —                                                            | T4 独占                                                                                                                                                   |
| `store/streamingStore.ts` 的 barrel/读面导出（`applyStream*` re-export）     | 与 V1 协商                                                                       | —                                                            | 该三行 re-export（streamingStore.ts:411-413）与 V1 的渲染主路径相关，**统一由 T4 处理**（V1 不碰此 re-export）                                            |
| `components/chat-message/MessageContent.tsx`                                 | **T4**（view model merge 上移壳层：`:138-166` 内联 selector/merge 移到页面壳层） | **V1**（折叠/分组裁决下沉投影层、timeline 渲染主路径单一化） | **同一文件，必须串行或由同一实现者执行（T4 先做 view model 上移，V1 再做渲染主路径）**；本详案把「MessageContent.tsx 上移壳层」划给 T4，V1 详案引此处契约 |
| `components/chat-message-row/ChatAssistantMessageRow.tsx`                    | **T4**（`useStreamingStore` 直连上移壳层，analysis/11 §⑤）                       | V1（工具折叠行渲染）                                         | T4 先（读面上移），V1 后                                                                                                                                  |
| `hooks/chat-stream/helpers.ts`                                               | **T4**（commitStreamToSession 单通道归一、queueMicrotask clearStream 保留）      | —                                                            | T4 独占                                                                                                                                                   |
| `components/chat-message/streamMessageViewModel.ts`                          | **T4**（view model 归一）                                                        | V1（与 normalizeAssistantTimeline 对齐合并）                 | _*T4 保留 applyStream* 纯函数；V1 处理与 timelineNormalizer 的 block 对齐重叠_*；不争写同一段则两 Agent 并行，争写则 T4 优先                              |
| `components/chat-message-list/useChatMessageState.ts` / `chat-message-row/*` | T4（storeAccess 归一迁移）                                                       | V1（折叠/分组）                                              | 按符号域拆分；useChatMessageState 归 T4                                                                                                                   |
| `packages/shared-utils/src/`（投影原语）                                     | **T4**（新增，mobile/desktop 共享）                                              | —                                                            | T4 独占                                                                                                                                                   |
| `api/tool-presentation/timelineNormalizer.ts`                                | —                                                                                | **V1**（投影主路径单一化）                                   | V1 独占                                                                                                                                                   |

**串行契约**：`MessageContent.tsx` 与 `ChatAssistantMessageRow.tsx` **两文件 T4/V1 重叠**，本详案裁决为 **T4 先执行（view model/读面上移），V1 在同一 worktree 串行跟进（渲染主路径）**；若批次调度允许多实现者，则这两个文件**只允许一个实现者（T4）同时持有写权，V1 待 T4 交付后在其产物上作业**。其余文件按上表各归其主，并行不争写。

---

## 4. 文件域（精确）

> Agent 不得越界；与 V1 的 `MessageContent.tsx`/`ChatAssistantMessageRow.tsx` 重叠按 §3.3 串行契约执行。

**T4-desktop 只写文件域**：

- `apps/crish-desktop/src/store/streamingStore.ts`（热缓冲定位固化、byKey 导出归一；**保留**，不删）
- `apps/crish-desktop/src/store/storeAccess.ts`（读面扩容覆盖 sessions/layout-tree/workspace-shell/streaming/draft）
- `apps/crish-desktop/src/store/sessionStore.ts`（消息持久投影定位固化/注释，不删）
- `apps/crish-desktop/src/store/storeOwnership.ts`（SESSION_OWNERSHIP 定位表述更新）
- `apps/crish-desktop/src/hooks/chat-stream/helpers.ts`（commitStreamToSession 单通道归一；queueMicrotask clearStream 原样保留）
- `apps/crish-desktop/src/api/store-access/sessionAccess.ts`（写入编排单点，保持 + helpers 调用收敛）
- `apps/crish-desktop/src/api/store-access/**`（componentAccess 迁移的接收侧；**删 componentAccess.ts**）
- `apps/crish-desktop/src/api/storeAccess.ts`（编排层保持，去除与 store/storeAccess 重复的读面 re-export）
- `apps/crish-desktop/src/components/chat-message/MessageContent.tsx`（**与 V1 分工**：仅 T4 的 view model 上移壳层段，渲染主路径留给 V1）
- `apps/crish-desktop/src/components/chat-message-row/ChatAssistantMessageRow.tsx`（**与 V1 分工**：仅读面上移壳层段）
- `apps/crish-desktop/src/components/chat-message/streamMessageViewModel.ts`（view model 归一，applyStream* 保留）
- `apps/crish-desktop/src/components/**`（**~90 处 componentAccess import 迁移目标**，逐文件改 import 到 store/storeAccess；只有 import 行改动，不在这些组件加业务逻辑）

**T4-mobile / 共享包文件域**：

- `packages/shared-utils/src/`（投影原语模块新增：`event-ring-window.ts`（环形缓冲/去重/游标）、`event-filter.ts`（feed 过滤）、`event-envelope.ts`（宽容解析）、`event-types.ts`（type→route 声明））+ `index.ts` barrel 导出入 + 单测）
- `apps/crish-mobile/src/domain/store/eventReducers.ts`（下沉原语后，本地保留接线发；删除下沉重复部分）
- `apps/crish-mobile/src/domain/store/eventMappers.ts`（同上）
- `apps/crish-mobile/src/domain/store/eventStore.ts`（消费共享原语，一行转发语义保持）
- `apps/crish-mobile/src/adapters/wiring/feedBridge.ts`（映射调用改为引共享原语；**接线层不下沉**）
- `apps/crish-mobile/package.json`（添加 `@crish/shared-utils` 依赖，文件引用）

**不涉（越界即退回）**：

- `api/tool-presentation/*`、`api/messageUserProjection.ts`（UserView 旁路）、`components/settings/UserViewDebugPanel.tsx` —— 规 V1 / 其它纬，T4 不碰。
- `packages/shared-types`（generated）—— 只读消费，不新增。
- Rust 侧 crates —— 全部不涉。

---

## 5. 验收标准

### 5.1 可执行断言

| #   | 断言                                  | 命令/方式                                                                                                                                       | 口径                                                                                                                             |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `check:store-facade` 绿               | `node scripts/check-store-facade.mjs`                                                                                                           | components 无 store/ 直引违规（白名单 store/index、store/storeAccess、store/types 放行）；**componentAccess 删除后读面仍白名单** |
| 2   | `check:store-writes` 绿               | `node scripts/check-no-raw-setstate.mjs`                                                                                                        | 生产代码 `*Store.setState` 白名单外零残留；`bootstrapStores.ts` 含 `bindMessageSnapshotsOps` 防线在案                            |
| 3   | 「componentAccess 零引用」            | `grep -rn "componentAccess" apps/crish-desktop/src`                                                                                             | **输出为空**（含 components、api、store、测试；文件本身已删）；若保留策略 β 则改为「仅作为统一唯一读面」assert                   |
| 4   | 消息正文存储副本 = 1（热缓冲除外）    | `MessageContent.tsx` 无渲染期直读 `useStreamingStore` 内联 merge；`layoutStore.messages` 无流式中间态副本；`commitStreamToSession` 只收口写终态 | view 层只收「已合并 view model」；热缓冲 byKey 除外                                                                              |
| 5   | 投影原语单测绿（mobile+desktop 共用） | `npm run test:desktop-helpers` + mobile 对应测试；或共享包专项 vitest                                                                           | `packages/shared-utils` 新增原语模块测试全绿；desktop/mobile 两端各 ≥1 真实消费（满足抽象纪律「接口两实现法则」）                |
| 6   | 未新增标记 = 0                        | `rg "(未接线                                                                                                                                    | 待接线                                                                                                                           | TODO | 临时 | FIXME)"` 于本纬改动文件 | 无新增未接线/占位标记 |
| 7   | 不新造第三个 store                    | 代码审查                                                                                                                                        | `streamingStore` / `layoutStore` 之外无新 zustand create 于本纬                                                                  |

### 5.2 负产出验收

- 删除 `componentAccess.ts`（116 行）+ mobile eventReducers/eventMappers 下沉部分（估 ~250 行）+ storeAccess 死 re-export → 净删除行数 ≥ 100。
- 路径收敛：storeAccess 三份 → 二面（读面/编排正确拆分）；双端事件映射平行实现 → 共享原语单源。

### 5.3 门禁

- `npm run typecheck` 绿；`npm run test:desktop-helpers`（含 `/store` + `/api`）绿；流式专项测试（真跑）绿。
- `npm run check:desktop` 绿（含 check:line-counts —— **扩容后的 store/storeAccess 若 >400 业务行，须拆分或 `--update` 基线登记**，见 AGENTS §11）。

---

## 6. 完成后自检（Agent 交回时）

- [ ] 我改的文件里无新增 TODO/未接线/临时标记（`rg` 复核）。
- [ ] **热缓冲未删**：`streamingStore.ts` byKey + `queueMicrotask clearStream`（helpers.ts:226-233）原样在案。
- [ ] **时序闭环真跑验证**：真跑 vitest 流式测试（desktop 流式 + run 收口用例），确认高频流式 + 收口时 UI 无 text 空窗/跳变（对 analysis/13 G3 丢帧窗口）。
- [ ] componentAccess 删除声明附 grep 零命中证据（或策略 β 的「唯一读面」复核）。
- [ ] 双 store 归一并验证时序闭环：`MessageContent` view model 上移壳层后，流式渲染 + queueMicrotask 清理路径正常。
- [ ] 未留下第二条路径：消息正文/工具存储副本在热缓冲外 = 1；概念路径数已核实。
- [ ] 与 V1 的 `MessageContent.tsx`/`ChatAssistantMessageRow.tsx` 串行契约已遵守（T4 读面上移先行，V1 渲染主路径后随）。

---

## 7. 禁止项（重申）

1. **不删热缓冲**：`streamingStore.byKey` 与 `queueMicrotask clearStream` 时序闭环（helpers.ts:226-233）依赖，绝对禁止删（analysis/13 设计内必需桥）。
2. **不在合并中丢失中间态**：流式过程中任一帧（text/thinking/tools/images）不得因合并丢失。
3. **不新造第三个 store**：只保留 streamingStore（热缓冲）+ layoutStore/sessionStore（持久投影）两域，合并语义，不 create 新 store。

---

## 8. 风险与需真跑验证点

1. **componentAccess 90 处迁移**（本纬最大操作风险）：策略 α 的 import 重写须机械化 + typecheck 兜底；漏迁一处红。建议 codemod 后立即 `npm run typecheck` 校验。
2. **T4/V1 共享文件争写**：`MessageContent.tsx` / `ChatAssistantMessageRow.tsx` 必须遵守 §3.3 串行契约（T4 先上移读面，V1 后归一渲染主路径）。
3. **mobile 消费共享原语的 bundle 兼容**：`packages/shared-utils` 有 React peer 与 node/browser 双 build；投影原语纯函数须走 browser/独立 export 避免引 React peer 约束；RN/expo 消费需【真跑】验证。
4. **时序闭环回归**：合并后流式 + 收口须【真跑 vitest 流式测试】确无空窗/跳变（analysis/13 G3）。若真跑发现丢帧窗口，属 V1 的 diff 恢复路径问题，回 T4/V1 协调位。
5. **store/storeAccess 行数超限**：扩容后若 >400 业务行进 line-counts 基线豁免流程（AGENTS §11），以 `--update` 登记而非放宽阈值。

---

_详案完成 · T4 单一投影 store · 只读核实代码 · 唯一产出文档本文件 · UTF-8 无 BOM · 未提交 git。_
