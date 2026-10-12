# 战役总方案与独立详案评审报告：效果锁与意图守护审计

> **评审编号**：`REVIEW-01`  
> **战役名称**：`stream-jitter-and-order-repair`（流式渲染卡顿跳动与时序重排系统性治理）  
> **评审角色**：效果锁与意图守护评审专家  
> **评审标的**：
>
> 1. 主控总方案：[`docs/stream-jitter-and-order-repair/00-总方案.md`](file:///c:/Software/conex/docs/stream-jitter-and-order-repair/00-%E6%80%BB%E6%96%B9%E6%A1%88.md)
> 2. 独立详案库：[`docs/stream-jitter-and-order-repair/independent-plans/`](file:///c:/Software/conex/docs/stream-jitter-and-order-repair/independent-plans/)（01 至 09 详案全量）  
>    **权威基线**：对齐 [`docs/agent-roles/general_task/三原则.md`](file:///c:/Software/conex/docs/agent-roles/general_task/%E4%B8%89%E5%8E%9F%E5%88%99.md)、根目录 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md)、[`.agents/LOGIC_PLAN_NO_RETREAT.md`](file:///c:/Software/conex/.agents/LOGIC_PLAN_NO_RETREAT.md) 与 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)  
>    **审计结论**：**原则性通过（Conditional Pass）**。四大用户痛点均已穿透到微观时序根因并给出原生解法，无退避砍功能或降级 MVP 行为；但在“方案横向契约协同”、“存量脏数据自愈”以及“多标签分屏水合闭环”上存在必须整改的矛盾与缺口。

---

## 一、四大用户核心痛点 100% 意图守门审查

本节严格对照用户现场提出的四大高破坏性核心痛点，穿透至生产代码，对总方案与 01~09 详案的解决有效性、因果链完整度与防御深度进行穷尽式审查。

### 1.1 痛点审查矩阵总览

|  痛点编号  | 现场缺陷表象与关联用例                                                                              | 根本诱因（Root Cause）代码依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 对应主责方案                              |       覆盖度评级       | 核心防护有效性判定                                                                                                                                                                                   |
| :--------: | :-------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------- | :--------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **痛点 1** | **重启后历史会话 AI 消息浮顶、用户消息沉底**<br>（典型用例：`sess-1791764675736` 重载后时序全倒置） | 1. 懒水合旁路本地 SQLite 直通远程事件；<br>2. [`sessionEventProjection.ts:38-44`](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionEventProjection.ts#L38-L44) 忽略 `msg.createdAt` 盲目回退 `Date.now()` 同一毫秒；<br>3. [`messageOrderKey.ts:42-51`](file:///c:/Software/conex/apps/crish-desktop/src/store/messageOrderKey.ts#L42-L51) 退化为 ID 字典序，`assistant-*` < `user-*` 导致 AI 消息天然冒顶。                                                                                                                     | **01 方案**<br>**07 方案**<br>**09 方案** | **100%**<br>(完全覆盖) | **彻底穿透**。SQLite SSOT 第一真源 + 四级全序（`seq -> ts -> roleRank -> naturalId`）从代数层面消除字典序陷阱。需补充存量脏数据冷启动自愈（见第四节）。                                              |
| **痛点 2** | **段落封口瞬间 0px 塌陷导致的整段白屏闪烁与疑似重复渲染**                                           | 1. `unitsRef` 模式跳过 `setHtml` 导致 `liveHtml` 恒空串；<br>2. [`MarkdownBlockItem.tsx:78-86`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx#L78-L86) Render 阶段暴力置空快照；<br>3. 封口瞬间 `isActiveTail=false` 切断增量单元，`renderedHtml` 算为 `""`；<br>4. [`ReconciledMarkdownHtml.tsx:119-123`](file:///c:/Software/conex/apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx#L119-L123) 执行 `removeChild` 清空整树，高度震荡 $H \to 0\text{px} \to H$。 | **02 方案**<br>**08 方案**                | **100%**<br>(完全覆盖) | **彻底穿透**。四态状态机（`ACTIVE -> SEALING_PENDING -> SEALED_STABLE`）+ 双缓冲锁存器 + 协调器零坍塌硬防御盾，断言 $N_{\text{void}} \equiv 0$。与 03 方案存在 `session.toHtml()` 冲突（见第四节）。 |
| **痛点 3** | **流式解析 N 个微任务级联重渲染导致的打字卡顿（Stuttering）**                                       | 1. `session.advance` 切出 $N$ 个词法分片，并发派发异步解析；<br>2. [`markdownRenderAsync.ts:96`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.ts#L96) 每个分片 resolve 各自触发 `setRenderVersion`，单帧引发 $1+N$ 次 React 重渲染与 DOM Diff；<br>3. Event Loop 被微任务垄断，掉帧产生严重顿挫感。                                                                                                                                                                                                             | **03 方案**<br>**06 方案**                | **100%**<br>(完全覆盖) | **彻底穿透**。原生 `Promise.all` 原子批决议 + `advanceBatchIdRef` 递增世代令牌，将重渲染比刚性压至 $\le 1.0$；一元化物理帧时钟（StreamRenderBuffer 6ms 预算）。                                      |
| **痛点 4** | **程序吸底触发 100ms 手势冻结并反向续期导致的滚动条上下暴跳**                                       | 1. `container.scrollTop = maxScroll` 吸底触发原生 `scroll` 事件；<br>2. [`useVirtualScroll.ts:256-263`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts#L256-L263) `onScroll` 盲目调用 `bumpGestureEpoch` 激活 100ms 手势冻结；<br>3. [`useVirtualScroll.ts:297-309`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts#L297-L309) `setActual` 测高回调再次调用 `bumpGestureEpoch` 反向续命，形成死锁；<br>4. 吐字停顿后积压高度一次性刷入，视口下跳数百像素。                          | **04 方案**<br>**05 方案**                | **100%**<br>(完全覆盖) | **彻底穿透**。双轨代际令牌 `performProgrammaticScroll` 静默豁免 + 切除 `setActual` 延寿死循环 + 吸底跟随态树状数组每帧 (rAF) 即时平滑提交。与 05 方案实现需统一（见第四节）。                        |

---

### 1.2 逐项痛点代码级闭环审查

#### 1.2.1 痛点 1 审查：时序倒置（`sess-1791764675736` 典型现场）

- **根因确认**：01 方案与 07 方案准确抓取了五环事故链。底层 SQLite `session_messages` 表（[`crates/conex-db/src/messages.rs:14-49`](file:///c:/Software/conex/crates/conex-db/src/messages.rs#L14-L49)）中以 `PRIMARY KEY (session_id, seq)` 为主键，数据天然完全保序；故障完全发生在前端 ACT-502 懒水合跳过 SQLite 直通远程引擎事件，随后在 [`sessionEventProjection.ts:38-44`](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionEventProjection.ts#L38-L44) 中因未读取 `msg.createdAt` 导致全量回退至 `Date.now()` 同一毫秒，最终在 [`messageOrderKey.ts:86-90`](file:///c:/Software/conex/apps/crish-desktop/src/store/messageOrderKey.ts#L86-L90) 中退化为 ID 字典序（`'assistant'` < `'user'`）。
- **解法完备性**：
  1. `sessionEventProjection.ts` 中新增 `extractMessageTimestamp`，优先顺序：`msg.createdAt > msg.timestamp > inner.timestamp > ev.timestamp`；
  2. 显式透传 `evSequence` 绑定至 `SessionMessage.engineSequence`；
  3. `compareMessageOrder` 升级为四级全序模型：
     $$\text{engineSequence (seq)} \;\to\; \text{timestamp (ts)} \;\to\; \text{roleRank (System=0, User=1, Assistant=2)} \;\to\; \text{naturalNumericId}$$
     引入因果角色权（Role Rank）作为平局决胜定理，确保在同毫秒、无 seq 时用户消息恒先于助手消息；
  4. 07 方案给出了严格弱序（Strict Weak Ordering）代数证明，并通过形式化数学不变量 S1~~S4、E1~~E3、F1~F3 固化了跨层对账。
- **守门判定**：**通过**。根因锁定 100% 精确，解法基于代数公理与单一真理源，彻底消除字典序陷阱。

#### 1.2.2 痛点 2 审查：封口 0px 塌陷白屏与闪烁

- **根因确认**：02 方案穿透到了四重时序断裂：
  1. `useStreamingMarkdownHtml` 在 `unitsRef` 路径下直接跳过 `setHtml`，导致 `liveHtml` 恒为 `""`，`lastSafeHtmlRef` 彻底穿孔；
  2. `MarkdownBlockItem.tsx` 在 Render 阶段自毁式将 `streamingUnitsRef.current = null`；
  3. 尾块封口瞬间 `isActiveTail` 立即变为 `false`，`incrementalUnits` 被截断为 `undefined`，而 Worker 异步尚未返回，`renderedHtml` 瞬间沦为空串；
  4. 底层协调器 [`ReconciledMarkdownHtml.tsx:119-123`](file:///c:/Software/conex/apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx#L119-L123) 在收到空数组后将已有 DOM 子树执行 `removeChild` 彻底清空，高度在 1 帧内发生 $H \to 0\text{px} \to H$ 剧烈跳变。
- **解法完备性**：
  1. 引入四态生命周期状态机：`ACTIVE -> SEALING_PENDING -> SEALED_STABLE / COLD_SEALED`；
  2. 在 `MarkdownBlockItem.tsx` 中建立双缓冲快照锁存器（`lockedUnitsRef` + `lockedHtmlRef`），在 `SEALING_PENDING` 过渡期强行锁定上一帧高保真单元树，**严禁下发空串**；
  3. 底层 `ReconciledMarkdownHtml.tsx` 增加零坍塌硬防御盾（Zero-Collapse Guard）：当容器内已有非空 DOM，且传入 `html === ""` 且无 `incrementalUnits` 时，拦截一切 `removeChild` 清空操作，冻结物理盒模型高度；
  4. 08 方案定义了量化指标 $I_{\text{SHO}} \le 2\%$ 且 $N_{\text{void}} \equiv 0$。
- **守门判定**：**通过**。双轨防御（上层状态机锁存 + 底层协调器硬防御）构筑了双保险，彻底封死 0px 塌陷路径。

#### 1.2.3 痛点 3 审查：微任务级联风暴与打字卡顿（Stuttering）

- **根因确认**：03 方案与 06 方案准确揭示了打字顿挫的性能病灶：
  1. 增量切词切出 $N$ 个 `textParts`；
  2. 针对每个分片派发异步解析，各分片 resolve 独立触发 `setRenderVersion((v) => v + 1)`；
  3. 导致单次文本推进在短短几毫秒内密集触发 $1 + N$ 次 React Fiber 协调与 DOM Diff，Event Loop 被微任务垄断，阻断浏览器 Paint，产生刺眼的节奏顿挫。
- **解法完备性**：
  1. 原生 `Promise.all` 原子批决议：将单次 advance 产生的所有异步分片作为不可分割批次统一结算，未全量决议前绝不派发中间状态，决议完成后严格仅触发至多 1 次状态更新；
  2. 单调自增的 `advanceBatchIdRef` 世代令牌，决议完成时严格比对令牌，丢弃陈旧微任务，防御乱序与跨帧状态撕裂；
  3. 时钟源一元化：明确以 `StreamRenderBuffer`（Level 1 物理帧，单帧 6ms 预算）为主聊天流式唯一权威时钟源，形成严密的 $1:1$ 物理帧节奏。
- **守门判定**：**通过**。React 重渲染比从 $1+N$ 骤降至 $\le 1.0$（降幅达 66%~90%），且零第三方调度库依赖。

#### 1.2.4 痛点 4 审查：程序吸底手势冻结死循环与视口暴跳

- **根因确认**：04 方案与 05 方案精确锁定了虚拟滚动的恶性死循环链条：
  1. `container.scrollTop = maxScroll` 程序吸底触发原生 `scroll` 事件；
  2. `useVirtualScroll.ts` 的 `onScroll` 无条件调用 `bumpGestureEpoch()` 激活 100ms 手势冻结期；
  3. 流式吐字持续触发 `setActual`，其内部竟然再次调用 `bumpGestureEpoch()` 反向续约 100ms 定时器；
  4. 只要模型持续吐字（间隔 $<100\text{ms}$），定时器永远无法到期，实测高度全部积压在 `pendingActualRef` 内存中，树状数组（BIT）总高度停滞；
  5. 吐字停顿后，积压的数十个高度一次性刷入，Fenwick 树瞬间暴涨 300px~800px，引发剧烈视口弹跳。
- **解法完备性**：
  1. 双轨代际令牌 `performProgrammaticScroll`：程序吸底时签发代际序列号与目标坐标，`onScroll` 匹配时静默同步，**绝不调用 `bumpGestureEpoch()`**；
  2. 硬件物理输入绝对排他：`wheel`、`touchstart`、滑块 `pointerdown` 在 Capture 阶段立即注销程序豁免，物理手势无缝接管；
  3. 彻底拔除 `setActual` 中对 `bumpGestureEpoch()` 的延寿死循环调用；
  4. 吸底跟随态放行树状数组每帧 (rAF) 即时提交（更新复杂度 $O(\log N) < 0.01\text{ms}$），彻底消除阶跃突跳。
- **守门判定**：**通过**。死锁链条被物理级切断，滚动条跟随恢复 60fps/120fps 平滑贴地。

---

## 二、反退避审查（Anti-Retreat & Logic Plan Integrity）

依据 `.agents/LOGIC_PLAN_NO_RETREAT.md` 与根目录 `AGENTS.md`，对方案是否存在“偷懒退避、降低效果要求、用简化版/MVP砍功能、或把不确定性推脱给业界做法”进行严格排查。

### 2.1 退避风险排查清单

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          反退避审查红线排查清单                              │
├──────────────────┬──────────────────────────────────────────┬───────────────┤
│ 审查维度         │ 现场方案表现                             │ 判定结论      │
├──────────────────┼──────────────────────────────────────────┼───────────────┤
│ 1. 效果锁降级    │ 是否把 60FPS 流式帧率降级为节流低频？   │ ❌ 零退避     │
│                  │ 是否把零塌陷放宽为“允许 1 帧空白”？      │ 坚守完整效果  │
├──────────────────┼──────────────────────────────────────────┼───────────────┤
│ 2. 临时补丁行为  │ 是否出现 setTimeout 盲目延迟补丁？       │ ❌ 零容忍     │
│                  │ 是否出现基于 DOM 坐标测距的魔术数字补偿？│ 全面拔除补丁  │
├──────────────────┼──────────────────────────────────────────┼───────────────┤
│ 3. 责任推脱借口  │ 是否出现“业界一般不管闪烁”、“太难做”？    │ ❌ 零借口     │
│                  │ 是否将 Chromium 事件特性推脱为不可解决？ │ 正面穿透解决  │
├──────────────────┼──────────────────────────────────────────┼───────────────┤
│ 4. MVP 砍项行为  │ 是否砍掉了多标签页懒水合支持？           │ ❌ 零砍项     │
│                  │ 是否砍掉了 LaTeX/代码块边界支持？        │ 穷举极限边界  │
└──────────────────┴──────────────────────────────────────────┴───────────────┘
```

### 2.2 审查详细判定

1. **绝对拒绝“降频保平安”的偷懒做法**：
   在处理微任务重渲染卡顿时，业界常见退避做法是粗暴地将节流阀拉大（如 100ms 或 200ms 更新一次视图）。03 方案坚决拒绝该退避路径，依托 `StreamRenderBuffer`（单帧 6ms 预算）与 `Promise.all` 原子批收口，正面实现了 60Hz/120Hz 下的逐帧丝滑下延，帧率指标锁定在 $\ge 58\text{FPS}$。
2. **彻底清退魔术数字与盲目延时**：
   在虚拟滚动吸底治理中，04 方案与 05 方案未采用任何类似 `setTimeout(..., 100)` 或 `container.scrollTop += 296` 的脏补丁，而是穿透到浏览器原生事件队列调度与树状数组单点更新机制，以双轨令牌状态机实现数学自洽。
3. **拒绝将瞬态塌陷归咎于“异步编译必然代价”**：
   02 方案正面迎击 Worker 编译与 Rust IPC 的 20ms~60ms 异步延迟，设计了 `SEALING_PENDING` 锁存过渡状态机与底层的 `ReconciledMarkdownHtml` 防御盾，以高保真快照无缝填补了时间真空，将段落瞬间高度振荡断言锁定为 $I_{\text{SHO}} \le 2\%$ 且 $N_{\text{void}} \equiv 0$。
4. **反过度设计红线守门严密**：
   06 方案对照 `ANTI_OVERENGINEERING_GUARDRAILS.md`，刚性否决了“Fenwick 树移至 Web Worker”（引入跨线程通信延迟反而导致白屏）、“设计 6 阶段全局洋葱拦截管道”（破坏 SSOT）等过度设计方案，保持了架构净收敛。

---

## 三、全景极限边界完整度深度审计

针对长文本、代码块/公式、用户手势中途打断、多标签页快速切换等复杂边界，审查各方案的效果闭环。

### 3.1 极限边界场景覆盖度

| 边界场景                   | 极端特征与威胁载荷                                                                    |    关联应对详案    | 效果闭环与防御断言                                                                                                                                                     |
| :------------------------- | :------------------------------------------------------------------------------------ | :----------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **50K+ 超长文本流式输出**  | 52,000 字符、单条消息、包含深度嵌套列表与数十个段落，引发内存爆炸与 AST 重复解析。    | 03 方案<br>08 方案 | **闭环完整**。`useStreamingBlocks` 增量切块使已封口块 memo 冻结，尾块负载恒定为 $O(1)$；`StreamRenderBuffer` 单帧 1024 字符预算切分；LRU 缓存容量严格有界（500项）。   |
| **大型多语言代码块与公式** | 未闭合代码围栏（持续 1000 字符无 ` ``` `）、LaTeX 复杂矩阵公式，封口时 DOM 结构突变。 | 02 方案<br>05 方案 | **闭环完整**。流式期保留高保真未闭合结构，权威 HTML 到达后通过 `reconcileUnits` 原位 patch 属性与子节点，保留包裹容器；公式容器增加 `contain: layout` 隔离重排。       |
| **用户中途滚轮上滑打断**   | 流式输出进行中，用户突然猛烈向上滚动滚轮查看历史上下文（`deltaY < 0`）。              | 04 方案<br>05 方案 | **闭环完整**。容器在 Capture 阶段捕获物理硬件事件，瞬间注销程序吸底豁免，`isAtBottom` 置为 `false`；流式文本在底部继续生长，但视口保持绝对悬停静止，绝不强行吸底拉回。 |
| **多标签页连续快速切换**   | 100ms 内在多个 Workspace 标签页或侧栏历史会话间高频切换（$A \to B \to C \to A$）。    | 01 方案<br>09 方案 | **闭环完整**。双层 Generation Token 拦截迟滞异步响应；多标签感知三级保活软驱逐体系（P0 主视口 / P1 打开标签与分屏 / P2 LRU 驱逐），杜绝分屏会话白屏。                  |
| **同毫秒高并发事件碰撞**   | 用户提问与 AI 回复在同一毫秒产生（`ts` 相同），且历史事件 `seq` 缺省。                | 01 方案<br>07 方案 | **闭环完整**。因果角色权重（Role Rank：System=0, User=1, Assistant=2）断言在同毫秒下 User 恒优先于 Assistant，破除字典序分流。                                         |

---

## 四、分维方案横向协同与契约打架穿透审计

在对 01 至 09 详案进行横向交叉比对中，发现存在 **两处核心模块接口冲突** 与 **一处关键链路缺口**，必须在主控统筹时强行协调并纠偏：

### 4.1 核心冲突一：02 方案与 03 方案关于 `useStreamingMarkdownHtml` 快照生成的性能与契约冲突（必须改）

- **冲突事实依据**：
  - **02 方案（第 225-226 行）**：为了在 `unitsRef` 路径下填充 `lockedHtmlRef`，要求在每次单元刷新时均调用 `setHtml(session.toHtml())`，同步对外输出全量高保真 HTML 字符串作为第二安全轨。
  - **03 方案（第 52-59 行、第 147-152 行）**：明确指出在 `unitsRef` 路径下，全量调用 `session.toHtml()` 会遍历所有结构单元进行字符串大拼接，在长文本打字流下会造成严重的内存 GC 震荡与性能损耗，因而严格要求跳过 `setHtml` 与 `toHtml()`。
- **危害分析**：
  若按 02 方案实现，流式输出每到达一个 token 就全量执行一次 `toHtml()` 字符串拼接，直接抵消了 03 方案在打字吞吐上的优化收益，甚至会在 50K 长文流式下引发微观掉帧！
- **审计裁决与整改规范**：
  1. **确立增量单元树（`lockedUnitsRef`）为封口过渡第一真理源**：在 `unitsRef` 模式下，`MarkdownBlockItem.tsx` 封口过渡期向下游 `ReconciledMarkdownHtml` 下发的应该是 `effectiveIncrementalUnits = lockedUnitsRef.current`！
  2. 下游 `ReconciledMarkdownHtml` 收到非空的 `lockedUnitsRef.current` 时，天然依靠单元快照树维持已有 DOM 节点与高度完全稳定，**根本不需要依赖 `lockedHtmlRef` 字符串**！
  3. 02 方案中的 `lockedHtmlRef` 与 `session.toHtml()` 仅在**无 `unitsRef` 路径（如纯文本思考块、单块预览）**或**最终封口异步解析失败时的保底容灾**阶段按需生成一次，坚决禁止在流式逐字循环中高频全量生成。

---

### 4.2 核心冲突二：04 方案与 05 方案关于 `performProgrammaticScroll` 实现范式的冲突（必须改）

- **冲突事实依据**：
  - **04 方案（第 227-254 行）**：在 `useVirtualScroll.ts` 中基于 React 组件实例维护 `programmaticStateRef`，使用单调自增代际令牌 `token` + 目标滚动高度 `targetScrollTop` 亚像素比对，并在 `requestAnimationFrame` 中延后释放豁免。
  - **05 方案（第 196-209 行）**：在模块顶层定义了文件级全局变量 `let isProgrammaticScrolling = false`，并在 `queueMicrotask` 中同步释放。
- **危害分析**：
  1. **多实例串扰隐患**：Conex / Crish 桌面端支持多标签页与多窗口分屏（`TreeLeafPanel`）。若使用 05 方案的模块全局变量 `let isProgrammaticScrolling`，左侧分屏的吸底滚动会直接修改全局变量，导致右侧分屏的手势判定被意外豁免或干扰！
  2. **时序过早穿透隐患**：在 Blink / Chromium 内核中，原生 `scroll` 事件经常在宏任务或下一帧 rAF 之前的事件分发阶段派发。05 方案在 `queueMicrotask` 释放标志位，会导致标志位过早失效，原生 `scroll` 事件到达时仍会被 `onScroll` 误判为物理手势！
- **审计裁决与整改规范**：
  1. **坚决废除 05 方案中的模块全局变量与微任务释放范式**；
  2. **统一采纳 04 方案基于 React Hook 实例的 `programmaticStateRef` 双轨代际令牌与 rAF 释放契约**，确保多分屏完全状态隔离，且 100% 覆盖 Chromium 异步派发的滚动事件。

---

### 4.3 关键缺口一：00 总方案实施路线未闭环纳入 09 方案的多标签分屏保活（必须改）

- **缺口事实依据**：
  - 00 总方案的四波实施路线（Wave 1~4）中，Wave 1 仅列出 `sessionEventProjection.ts`、`messageOrderKey.ts` 与 `triggerSessionMessageHydrateIfNeeded`，未纳入 09 方案指出的**多标签页与分屏保活（Tabs & Splits Eviction Protection）**。
  - 09 方案在深入排查中揭示了一个极具破坏性的存量 Bug：现有软驱逐逻辑（`sessionCrudActions.ts:168-182`）硬编码保护单一个 `activeSessionId`，传入的 `streamingSessionIds = new Set()` 为空集。当会话数量达到上限时，**用户正在分屏右侧查看的会话正文以及后台正在推流的会话正文会被直接清空蒸发**！
- **审计裁决与整改规范**：
  主控必须在 Wave 1 的水合收敛阶段，将 09 方案提出的 `WorkspaceShellStore.openTabs` 感知与三级保活驱逐机制（P0 视口 / P1 标签与推流 / P2 LRU 驱逐）作为关键任务项显式纳入，阻断多标签分屏场景下的白屏爆雷。

---

### 4.4 关键缺口二：存量脏历史会话（如现场 `sess-1791764675736`）的冷启动因果自愈（必须改）

- **缺口事实依据**：
  - 01 方案与 07 方案完美保证了“未来写入的 SQLite 数据 seq 连续正确”、“新拉取的事件 createdAt 精准提取”。
  - 但对于用户此前已经受损的历史会话（例如现场事故用例 `sess-1791764675736`），如果该会话在旧版本中因反复投影，导致本地数据库中已落盘的记录 `timestamp` 碰撞为同一毫秒，且旧数据中的 `seq` 未被正确赋予：
- **审计裁决与整改规范**：
  必须在 `sessionRustDbHydrate.ts` 或 `messageOrderKey.ts` 中植入**存量数据因果自愈（Healing）兜底逻辑**：
  当从本地存储恢复消息时，若检测到连续多条消息时间戳完全相同且 `seq` 缺省：
  1. 依据底层的自增 rowid 或原始物理存储顺序为消息补齐递增的伪序列号（`syntheticSeq = index`）；
  2. 结合 `roleRank` 强制约束；
     确保用户无需清空数据库即可使既有损坏会话在初次重启加载时 100% 自动修复为正确的人机交替序。

---

## 五、整理给主控的终审整改清单

将全方案审查结果严格归纳为三类明确行动项，供主控 Agent 直接协调落地。

### 5.1 【必须改】（Blocker 级冲突与缺口，不改必生系统性隐患）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          必须改清单 (Mandatory Actions)                     │
├────┬─────────────────────────────┬──────────────────────────────────────────┤
│ 1  │ 契约冲突消除                │ 消除 02 方案与 03 方案的冲突：在 unitsRef 模式│
│    │ (02 方案 vs 03 方案)         │ 封口时，以 lockedUnitsRef 增量单元树为第一真源│
│    │                             │ 维持 DOM 稳定，严禁在流式打字中全量调用 toHtml│
├────┼─────────────────────────────┼──────────────────────────────────────────┤
│ 2  │ 架构范式收敛                │ 消除 04 方案与 05 方案的冲突：坚决否决 05 方案│
│    │ (04 方案 vs 05 方案)         │ 的模块全局变量，统一采用 04 方案的双轨代际令牌│
│    │                             │ programmaticStateRef + rAF 释放契约      │
├────┼─────────────────────────────┼──────────────────────────────────────────┤
│ 3  │ 多标签分屏水合保活接入      │ 00 总方案 Wave 1 必须显式纳入 09 方案的标签感知│
│    │ (00 总方案 Wave 1 补全)      │ 三级保活机制，防止分屏邻叶会话正文被误驱逐白屏│
├────┼─────────────────────────────┼──────────────────────────────────────────┤
│ 4  │ 存量脏历史因果自愈          │ 在 sessionRustDbHydrate.ts 中植入自愈兜底，确保│
│    │ (sess-1791764675736 现场)   │ 现场已存在时间戳碰撞的历史会话在冷启动加载时自愈│
└────┴─────────────────────────────┴──────────────────────────────────────────┘
```

1. **【必须改 1】消除 02 方案与 03 方案在 `useStreamingMarkdownHtml` 快照与全量 HTML 序列化上的契约冲突**：
   - 裁决：以 `lockedUnitsRef` 增量单元树为封口过渡第一真理源。
   - 文件：`apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx` 与 `apps/crish-desktop/src/api/markdownRenderAsync.ts`。
   - 动作：在 `unitsRef` 路径下，`effectiveIncrementalUnits = isSealingTransition ? lockedUnitsRef.current : undefined`；封口过渡期间直接依靠单元树无缝锁定 DOM，禁止在流式单字循环中调用全量 `session.toHtml()`。
2. **【必须改 2】统一 04 方案与 05 方案对 `performProgrammaticScroll` 的实现规范**：
   - 裁决：坚决废除 05 方案的模块全局变量 `let isProgrammaticScrolling`。
   - 文件：`apps/crish-desktop/src/hooks/useVirtualScroll.ts`。
   - 动作：统一使用 04 方案基于 React Hook 实例的 `programmaticStateRef`（代际令牌 + rAF 释放 + 亚像素目标比对），彻底杜绝多分屏串扰与 Chromium 异步事件过早解锁。
3. **【必须改 3】00 总方案实施路线补充多标签分屏水合保活闭环**：
   - 裁决：将 09 方案的标签感知与五态离散状态机纳入 Wave 1。
   - 文件：`docs/stream-jitter-and-order-repair/00-总方案.md`。
   - 动作：在 Wave 1 路线中增加 `sessionMessageEviction.ts` 多标签页与分屏保活（`keepIds` 包含所有打开标签与活跃推流 ID），消除多标签切换时的会话正文误杀。
4. **【必须改 4】实现历史存量会话冷启动因果自愈机制**：
   - 裁决：防御已有历史数据缺失 `seq` 与时间戳碰撞的最坏边界。
   - 文件：`apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts` 与 `apps/crish-desktop/src/store/messageOrderKey.ts`。
   - 动作：水合读取记录时若发生连续同毫秒且无 seq，依存储物理读取顺序赋予递增相对位移，确保现场故障会话 `sess-1791764675736` 重启即自愈。

---

### 5.2 【建议改】（Enhancement 级建议，提高系统工程纯度与健壮性）

1. **【建议改 1】在 `resolveRoleRank` 中显式固化 Tool 消息因果位阶**：
   - 01 方案中仅枚举了 `system=0, user=1, assistant=2, other=3`。
   - 建议：将独立的 ToolCall / ToolResult 角色在枚举中显式定义（例如 `tool=2.5` 或作为 assistant 内部结构约束），避免未来出现独立 Tool 气泡时因落入 `other=3` 产生边缘排序分歧。
2. **【建议改 2】为 03 方案的 Promise.all 原子批决议引入单批次超时熔断守卫**：
   - 建议在 `Promise.all(partPromises)` 外层封装 `Promise.race([batchPromise, timeout(50ms)])`。若某个分片的跨进程 Rust IPC 因极端异常挂起超过 50ms，自动以未解析文本安全降级上屏，杜绝单分片卡死阻滞整帧流式输出。
3. **【建议改 3】规范思考块从展开到折叠的过渡动画与 DOM 卸载节奏**：
   - 建议在 `ReasoningRow.module.css` 中固化 `120ms` 的 `transition: max-height ease-out`，并在折叠过渡期间挂载 `data-collapsing="true"` 阻断测高向上渗透，动画结束后单次原子提交 24px 实测高度。

---

### 5.3 【可接受风险】（Acceptable Risks，已具备充分防御或影响极低）

1. **【可接受风险 1】极短单字回复（如“好的”）首轮即封口的瞬态感知**：
   - 对于单字回复，模型在 1 帧内即完成输出与封口。由于 02 方案的双缓冲锁存器即便只维持 1 帧（16.6ms）也能完全封死 0px 塌陷，且该场景下初始高度本身极小，视觉风险为零。
2. **【可接受风险 2】极端超长单段（50K 连续字符无任何标点与换行）的切块负载**：
   - 若模型输出数万字完全不换行，`useStreamingBlocks` 无法切出多个 Markdown 块。但在大语言模型实际交互中，输出必然包含自然标点、代码块与段落换行；且 `StreamRenderBuffer` 单帧 1024 字符预算强行进行了物理帧分流，主线程不会被巨型 payload 击穿。
3. **【可接受风险 3】Windows 高 DPI 亚像素字体微震**：
   - 05 方案设定了 $\ge 1.0\text{px}$ 的 `SUBPIXEL_JITTER_EPSILON` 过滤门槛，对于 $<1.0\text{px}$ 的亚像素微震不触发 VSM 重算，这在物理视觉上是完全无法辨识的，属于合理容差。

---

## 六、总结与审计判定结论

本次战役的总方案及 9 份独立详案展现了极高的架构专业度与对现场缺陷的深度穿透力：

- **意图守护 100% 达标**：四大现场痛点全部在底层时序和数据流机制上找到了确凿依据并给出了根治解法；
- **反退避纪律坚决履行**：坚决拒绝了降低刷新率、延时补丁、坐标魔术数字等退避手法，坚守 60FPS 丝滑流式体验与零塌陷零白屏红线；
- **极限边界闭环严密**：通过数学不变量、全景魔鬼用例与 Playwright/Tauri E2E 探针构筑了立体化防线。

只要主控 Agent 严格落实本报告第五节提出的 **4 项【必须改】（消除 02 与 03 的 toHtml 冲突、统一 04 的双轨令牌规范、纳入 09 的多标签分屏保活、植入历史会话因果自愈）**，本次战役将能够从根本上彻底根除长期困扰客户端的流式卡顿、闪烁跳动与时序颠倒顽疾，实现高水准的架构净收敛。
