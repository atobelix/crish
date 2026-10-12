# 架构净收敛与删除面评审报告

> **文档标识**：`docs/stream-jitter-and-order-repair/plan-reviews/review-02-structural-convergence-and-deletion.md`  
> **所属战役**：`stream-jitter-and-order-repair`（流式渲染卡顿跳动与时序重排系统性治理）  
> **评审角色**：架构收敛与删除面评审专家（Reviewer 02）  
> **权威基线**：`AGENTS.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`docs/agent-roles/general_task/三原则.md`、`docs/agent-roles/prompts/方案-计划审计.md`  
> **审查对象**：`docs/stream-jitter-and-order-repair/00-总方案.md` 及一级详案库 `independent-plans/` 01 至 09 详案  
> **评审核心使命**：严格对照反过度设计硬性红线与单向真理源（SSOT）原则，审查方案是否做到“一个概念只有一条主路径”、彻底清理系统历史死层；纠治多套调度器并存、虚假补丁、魔术数字与删除面缺失问题。

---

## 一、评审全景与总体审计结论（Executive Verdict）

### 1.1 总体审计判定：【有条件批准，需就地整改收敛（Conditional Pass with Mandatory Convergence）】

整体 00 总方案与 01~09 详案具备极高的现场根因穿透力，精确捕获了导致流式卡顿顿挫、段落封口白屏塌陷、程序吸底百像素突跳以及重启后 AI 置顶用户沉底时序倒置四大核心病灶。方案的技术方向（SQLite 本地优先、RoleRank 因果全序、Promise.all 原子微任务批合并、程序吸底令牌脱敏）完全符合正确性与不变量要求。

**然而，在架构净收敛（Clean Convergence）与删除面审计（Deletion Surface）维度，评审发现 5 大严重架构断层与 1 项全战役通用缺陷**：

1. **水合主路径双头真理源分裂**：Plan 01 就地改造 `sessionActivateHydrate.ts` 的 `triggerSessionMessageHydrateIfNeeded`，而 Plan 09 新建 `sessionHydrationCoordinator.ts` 的 `coordinateSessionHydration`，二者职责严重重叠打架，若不裁决必将导致代码库出现两套并行水合调度器。
2. **全战役详案普遍缺失“物理级硬性删除清单”**：01 至 07 及 09 详案几乎把全部篇幅放在“新增代码、新增状态、新增类”上，**没有一份详案提供详细的《代码/模块/标记删除清单》**！如果实施波（Wave 1~3）按此执行，旧的废弃分支、有缺陷的字段、死属性和垃圾调用将大量残留，演变成典型的“打补丁式并存”。
3. **Plan 07 比较器数学模型脱节，遗漏 RoleRank 四级全序**：Plan 07（时序对账详案）的形式化推导仍停留在旧的三元组 `K(m) = <seq, ts, id>`，公理化测试中仍使用旧的字典序 tiebreaker，未能吸收 Plan 01 的 `RoleRank` 因果全序，留下了同毫秒无 seq 时依然退化为字典序的严重漏洞。
4. **Plan 06 引入魔术序列号 `syntheticSequence = 1000000 + eventIndex`**：该提议属于典型的魔术数字补丁，严重违背反过度设计与反退避铁律，必须坚决取缔。
5. **Plan 02 倒退引入高频全量 HTML 序列化**：Plan 02 试图在 `useStreamingMarkdownHtml` 每次单元更新时调用 `setHtml(session.toHtml())`，直接破坏了增量 DOM 协调的初衷，违背反过度设计禁令 12，且与 Plan 03 的微任务批合并直接冲突。
6. **Plan 05 清退私有 ResizeObserver 时遗漏周边死代码链条**：Plan 05 虽正确提出了切除 `MessageToolCallsSection` 的私有 RO，但遗漏了对其上游 `virtualScrollManager` prop、`handleToggle` 中残留的 `invalidateActual` 以及调用方透传的连带清除。

---

## 二、架构净收敛审查（"一个概念只有一条主路径"）

### 2.1 会话水合主路径分裂：Plan 01 vs Plan 09 双头真理源审计

| 维度             | Plan 01（消息因果时序与水合单轨）                                | Plan 09（会话切换与标签页懒水合状态机）                               | 冲突与重叠定性       |
| :--------------- | :--------------------------------------------------------------- | :-------------------------------------------------------------------- | :------------------- |
| **承载文件**     | `apps/crish-desktop/src/store/sessionActivateHydrate.ts`         | `apps/crish-desktop/src/store/sessionHydrationCoordinator.ts`（新增） | **文件级双源分裂**   |
| **核心函数**     | `triggerSessionMessageHydrateIfNeeded`                           | `coordinateSessionHydration`                                          | **函数名与入口分叉** |
| **水合状态管理** | 依赖既有 `messagesHydrated: boolean` + `bumpHydrateGeneration()` | 引入 5 态枚举 `SessionHydrationStatus` + 双层 Token                   | **状态模型不一致**   |
| **调用方挂载**   | `useChatMessages.ts` 与 `sessionCrudActions.ts:193`              | 提议在 `sessionCrudActions.ts:setActiveSessionId` 替换调用            | **调用点归属冲突**   |

#### 评审裁决与净收敛要求：

- **坚决禁止双头调度器**！一个系统不能同时存在 `triggerSessionMessageHydrateIfNeeded` 与 `coordinateSessionHydration`。
- **唯一真理路径锁定**：
  1. 废弃新建独立文件的念头，统一在 `apps/crish-desktop/src/store/sessionActivateHydrate.ts` 中就地升级；
  2. 统一函数名为 `triggerSessionMessageHydrateIfNeeded`（保持对所有上游调用的无破坏重构）；
  3. 函数内部完整吸收 Plan 09 的两级瀑布流策略（Phase 1: SQLite `ensureSessionBodyHydrated` -> Phase 2: Engine `hydrateSessionMessagesFromEngine`）、双层 Generation Token 守卫与飞行中 Promise 合并；
  4. 状态字段统一步调：在 `SessionState` 中引入显式 `hydrationStatus: SessionHydrationStatus`，原有 `messagesHydrated: boolean` 保留为派生 getter 或在本次战役中作为过渡字段同步赋值，但禁止维护两套平行的水合触发管道。

---

### 2.2 流式 Markdown 解析冲突：Plan 02 全量 HTML 状态 vs Plan 03 增量批合并

在 `apps/crish-desktop/src/api/markdownRenderAsync.ts` 的 `useStreamingMarkdownHtml` 改造上，Plan 02 与 Plan 03 出现了严重的架构冲突：

- **Plan 02 §4.1 的提案代码**：
  ```typescript
  // Plan 02: 试图在 unitsRef 模式下也强行执行 setHtml(session.toHtml())
  const advance = session.advance(markdown, true);
  if (unitsRef) unitsRef.current = session.getUnitSnapshots();
  setHtml(session.toHtml()); // <-- 架构毒点！
  ```
- **Plan 03 §5.1 的分析与实现**：
  - 明确指出现存瓶颈在于“$1 + N$ 次微任务引发多次 React 重渲染与全量字符串大拼接”。
  - Plan 03 方案：在 `unitsRef` 模式下，仅维护 `unitsRef.current = session.getUnitSnapshots()` 与 `setRenderVersion((v) => v + 1)`，仅触发 1 次原子协调，**绝不调用全量 `session.toHtml()`**。

#### 评审裁决与禁令对照：

- **违反条款**：《反过度设计硬性红线指南》**🚫 禁令 12**：
  > “严禁高频流式状态穿透全局 Store 与大模型逐字流式文本输出统一采用原生增量 TextNode 追加，规避虚拟 DOM Diff”。
- **危害穿透**：如果采纳 Plan 02 的代码，每次打字机推流（每秒 50~100 次），React 都会在组件 state 里更新一个数万字符的完整 HTML 字符串，并触发庞大的虚拟 DOM 比对和垃圾回收，使 Plan 03 的帧率优化直接化为泡影！
- **净收敛方案**：
  1. 彻底否决 Plan 02 中在 `unitsRef` 路径调用 `setHtml(session.toHtml())` 的提议；
  2. 封口过渡期（`SEALING_PENDING`）的零塌陷保障，**纯粹通过 `lockedUnitsRef.current = streamingUnitsRef.current` 在 Ref 层面稳定向下游传递**，下游 `ReconciledMarkdownHtml` 继续以增量单元树（incrementalUnits）形式运行，根本不需要 `html` 字符串介入！
  3. `useStreamingMarkdownHtml` 严格遵循 Plan 03 的 `Promise.all` 原子批决议与单一世代令牌 `advanceBatchIdRef`。

---

### 2.3 时钟源一元化：StreamRenderBuffer 对 48ms Timer 的清退

在现有系统中，`useRunStreamingAssistant.ts` 存在双时钟源遗留：

1. `renderBufferRef`：`StreamRenderBuffer`（基于 `requestAnimationFrame`，单帧 6ms 预算，16.6ms 物理脉冲）；
2. `textBatcherRef`：`StreamTextBatcher`（基于 `setInterval(48ms)` 定时器）。

#### 评审核验：

- Plan 03 §3.2 明确裁决将 `StreamRenderBuffer` 锁定为主聊天单一权威时钟源，彻底禁止双时钟在流式正文中混用。
- **进一步收敛要求**：
  在 `useRunStreamingAssistant.ts` 中，`textBatcherRef` 分支在桌面端主对话中已属于多余的辅助缓存与双轨分流。主控在实施波中必须将运行时分支收口为纯 `StreamRenderBuffer` 单轨，废除不必要的备用定时器通道。

---

### 2.4 反过度设计 13 项硬性红线对照合规表

| 禁令条款                                | 审查标的与关注点                                       | 详案合规情况                                                     | 审计判定与收敛要求        |
| :-------------------------------------- | :----------------------------------------------------- | :--------------------------------------------------------------- | :------------------------ |
| **禁令 1**（内核级沙盒）                | 是否引入跨平台 OS 沙盒或 C 绑定                        | 全方案均未引入                                                   | ✅ **合规**               |
| **禁令 2**（无锁环形缓冲区）            | 是否在 Rust/前端自制 SharedArrayBuffer 环形缓冲        | 方案均采用标准 Channel 与 JS 原生引用                            | ✅ **合规**               |
| **禁令 3**（分布式共识与 2PC）          | 本地存储是否引入 Paxos/Raft 或两阶段提交               | SQLite 采用 CAS 版本号与事务，无分布式协议                       | ✅ **合规**               |
| **禁令 4**（动态切模与路由链）          | 流式解析失败时是否自动切换模型                         | 严格单模型本地降级，不跨模型切换                                 | ✅ **合规**               |
| **禁令 5**（请求前 DNS 解析）           | 是否引入异步 DNS A/AAAA 解析器                         | 零外部 DNS 探测                                                  | ✅ **合规**               |
| **禁令 6**（黑盒 Prompt 篡改）          | 是否在流式管道中插入意图重写拦截器                     | 用户指令与流式块如实传递，零隐式注入                             | ✅ **合规**               |
| **禁令 7**（全链路可审计与 SSOT）       | 状态流是否唯一？是否维护多套平行状态树                 | 纠正水合双头真理源后，全面收敛至 SQLite 与 VSM 树状数组          | ⚠️ **需按 §2.1 强制收敛** |
| **禁令 8**（凭据安全隔离）              | 是否存在凭据泄露风险                                   | 不涉及凭据改动                                                   | ✅ **合规**               |
| **禁令 9**（滑动窗口断路器）            | 是否引入全局滑动窗口 CircuitBreaker                    | 均采用局部 try/catch 与 safeHtml 兜底，无全局熔断器              | ✅ **合规**               |
| **禁令 10**（6 阶段洋葱中间件）         | 是否设计过长生命周期 Hook 链                           | 否决了洋葱拦截链提议（Plan 06 §3 明确记录），采用原生原子回调    | ✅ **合规**               |
| **禁令 11**（同进程微服务与 IPC 嵌套）  | 是否在同进程内套多层 JSON 路由或多层 Facade            | 否决将 Fenwick 树移至 Web Worker，保持主线程直调                 | ✅ **合规**               |
| **禁令 12**（流式状态击穿与 memo 滥用） | 逐字 Token 是否击穿到全局 Store；是否每帧更新巨大 HTML | 纠正 Plan 02 的 `setHtml(toHtml)` 违规提案，保持 Leaf 级增量协调 | ⚠️ **需按 §2.2 强制收敛** |
| **禁令 13**（移动端全量 CRDT 状态下沉） | 是否下沉重型协同引擎                                   | 采用轻量状态机与 Frame 协议，不涉及 CRDT 下沉                    | ✅ **合规**               |

---

## 三、全战役物理级硬性删除面清单审计（Hard Deletion Checklist）

针对详案中普遍缺失明确删除清单的严重缺陷，本评审专家穿透源码，正式制定**全战役统一的《代码/模块/标记物理级硬性删除清册》**。主控 Agent 在派发与收口实施任务（Wave 1~3）时，必须严格对照本清单进行逐项核验，未彻底物理删除的代码严禁通过验收！

### 3.1 核心删除项 1：`useVirtualScroll.ts` 中 `setActual` 对 `bumpGestureEpoch` 的错误续期调用

- **文件定位**：[`apps/crish-desktop/src/hooks/useVirtualScroll.ts:301-308`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts#L301-L308)
- **待删除死代码现场**：
  ```typescript
  // 必须彻底删除的代码块：
  if (gestureActiveRef.current) {
    bumpGestureEpoch(); // <-- 【硬性删除项 1.1】恶性续期死循环源头！
    return;
  }
  ```
- **删除后纯净逻辑**：
  ```typescript
  const setActual = useCallback(
    (id: string, height: number) => {
      const cur = manager.getActualHeight(id);
      if (cur !== null && cur === height) return;
      pendingActualRef.current.set(id, height);
      // 手势进行中仅在非吸底态暂存 pending，绝不调用 bumpGestureEpoch！
      if (gestureActiveRef.current && !isNearBottomRef.current) {
        return;
      }
      scheduleActualFlush();
    },
    [manager, scheduleActualFlush] // <-- 【硬性删除项 1.2】依赖数组中剔除 bumpGestureEpoch
  );
  ```

---

### 3.2 核心删除项 2：`MessageToolCallsSection.tsx` 私有 `ResizeObserver` 及周边死代码链条

- **文件定位**：[`apps/crish-desktop/src/components/chat-message-row/MessageToolCallsSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/MessageToolCallsSection.tsx)
- **待删除死代码清单（共 4 处）**：
  1. **【硬性删除项 2.1】私有 ResizeObserver 监听与注销逻辑（第 120-132 行整段切除）**：
     ```typescript
     // 物理级整段删除：
     useLayoutEffect(() => {
       const el = sectionRef.current;
       if (!el) return;
       const roManager = ResizeObserverManager.getInstance();
       const onResize = (entry: ResizeObserverEntry) => {
         if (entry.contentRect.height > 0) {
           virtualScrollManager?.invalidateActual(msgId);
         }
       };
       roManager.observe(el, onResize);
       return () => roManager.unobserve(el, onResize);
     }, [msgId, virtualScrollManager]);
     ```
  2. **【硬性删除项 2.2】展开/收起回调中的 `invalidateActual` 污染（第 109 行与第 116 行）**：
     ```typescript
     // handleToggleTool 中删除：virtualScrollManager?.invalidateActual(msgId);
     // handleToggleThinking 中整段删除：virtualScrollManager?.invalidateActual(msgId);
     ```
  3. **【硬性删除项 2.3】接口与参数中的死属性 `virtualScrollManager`**：
     - 从 `MessageToolCallsSectionProps`（第 55 行）中删除 `virtualScrollManager?: VirtualScrollManager | null | undefined;`；
     - 从组件入参结构解构（第 64 行）中删除 `virtualScrollManager`。
  4. **【硬性删除项 2.4】上游调用方的无用参数透传**：
     - 在 [`ProcessItemRenderer.tsx:157-160`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/ProcessItemRenderer.tsx#L157-L160) 中删除 `virtualScrollManager={...}` 透传。

---

### 3.3 核心删除项 3：`messageOrderKey.ts` 旧三级比较器与字典序回退彻底收敛

- **文件定位**：[`apps/crish-desktop/src/store/messageOrderKey.ts:9-51`](file:///c:/Software/conex/apps/crish-desktop/src/store/messageOrderKey.ts#L9-L51)
- **待删除死代码清单**：
  1. **【硬性删除项 3.1】旧版三元组排序键类型声明（第 10 行）**：
     ```typescript
     // 删除旧类型：
     export type MessageOrderKey = { seq: number; ts: number; id: string };
     ```
     _替换为四元组_：`export type MessageOrderKey = { seq: number; ts: number; roleRank: MessageRoleRank; id: string };`
  2. **【硬性删除项 3.2】旧版三级比较实现与裸字典序回退（第 42-51 行）**：
     ```typescript
     // 物理级整段删除：
     export function compareMessageOrder(
       a: MessageOrderKey,
       b: MessageOrderKey
     ): number {
       if (a.seq !== b.seq) {
         return a.seq < b.seq ? -1 : 1;
       }
       if (a.ts !== b.ts) {
         return a.ts < b.ts ? -1 : 1;
       }
       return a.id.localeCompare(b.id); // <-- 致命的裸字典序比较，必须物理删除！
     }
     ```
     _替换为四级全序代数_：`seq 优先 -> ts 次之 -> roleRank 因果平局决胜 -> naturalNumericId 终极稳定兜底`。

---

### 3.4 核心删除项 4：`sessionEventProjection.ts` 中盲目 `Date.now()` 全量覆写分支

- **文件定位**：[`apps/crish-desktop/src/api/sessionEventProjection.ts:38-44`](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionEventProjection.ts#L38-L44)
- **待删除死逻辑**：
  ```typescript
  // 【硬性删除项 4.1】必须删除忽略 message.createdAt 的盲目回退函数：
  function eventTimestamp(inner: AnyRec | null): number {
    if (!inner) return Date.now();
    const rawTs = inner.timestamp;
    if (typeof rawTs === 'string') return Date.parse(rawTs) || Date.now();
    if (typeof rawTs === 'number') return rawTs;
    return Date.now(); // <-- 必须切除！
  }
  ```
  _替换为_：`extractMessageTimestamp(msg, inner, outerEv)` 多层精准提取器，无时间戳时返回 `undefined` 并由因果链分配相对单调递增时戳，严禁使用单一瞬间 `Date.now()` 冲刷全量历史消息。

---

### 3.5 核心删除项 5：`markdownRenderAsync.ts` 中级联微任务多点重渲染循环

- **文件定位**：[`apps/crish-desktop/src/api/markdownRenderAsync.ts:198-228`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.ts#L198-L228)
- **待删除死循环结构**：
  ```typescript
  // 【硬性删除项 5.1】必须删除逐个分片独立 resolve 并各自调用 setRenderVersion 的散装循环：
  for (const part of advance.textParts) {
    void parseMarkdownFragmentToHtmlAsync(part.source, priority, part.kind)
      .then((fragment) => {
        if (
          mountedRef.current &&
          session.getRevision() === advance.revision && // <-- 【硬性删除项 5.2】恒真的死守卫
          session.resolveTextPart(part.id, fragment)
        ) {
          if (unitsRef) {
            unitsRef.current = session.getUnitSnapshots();
            setRenderVersion((version) => version + 1); // <-- 致命的级联重渲染源头！
          } else {
            setHtml(session.toHtml());
          }
        }
      })
      .catch(...);
  }
  ```
  _替换为_：`Promise.all` 原子批决议 + `advanceBatchIdRef` 世代令牌（严格至多 1 次 React 状态触发）。

---

### 3.6 核心删除项 6：Plan 03 中未使用的死类 `FrameCoalescingScheduler`

- **方案位置**：`docs/stream-jitter-and-order-repair/independent-plans/03-流式解析微任务批合并与帧调度方案.md` §3.3（第 294-318 行）
- **定性**：在方案正文提出了包含 `queueMicrotask` 与 `cancelAnimationFrame` 的 `FrameCoalescingScheduler` 类，但在随后的完整实现代码（§5.1）中根本没有被导入或使用，属于典型的方案设计期未收敛死代码草案。
- **要求**：在总案收拢与代码落地中**绝对不得将此类编入代码库**，直接使用原生的 `Promise.all` 批收口即可，保持架构轻量纯粹。

---

## 四、杜绝临时补丁与魔术数字深度审计

### 4.1 严厉拦截 Plan 06 中的魔术序列号 `syntheticSequence = 1000000 + eventIndex`

- **方案现场**：Plan 06 §2.1（第 123-125 行）：
  > “若历史旧会话确实缺少 `engineSequence`，在从数据库或事件流装配时，按原始事件拓扑追加索引生成伪序列号（例如 `syntheticSequence = 1000000 + eventIndex`），坚决防止退化至无序状态。”
- **深度风险穿透**：
  1. **魔术数字污染**：`1000000` 是完全主观臆断的数字。当真实引擎长时间运行、事件序列号自然超过 1,000,000 时，伪序列号将与真实序列号发生严重重叠碰撞！
  2. **严重破坏单调不变量**：如果会话中新旧消息混杂，加了 `1000000` 的旧消息在排序器中会被反向排到真实 sequence 为 `10` 的新消息之后，再次酿成倒置！
- **审计结论与修正**：
  **严厉否决此魔术数字提案！**  
  无 sequence 的历史消息严格保持 `seq = MAX_SAFE_INTEGER`，其因果序由真实解析的 `createdAt` 物理时间戳裁决；当时间戳重叠时，由代数公理级因果权重 `RoleRank`（`system=0, user=1, assistant=2`）和数组稳定序号裁决，绝不允许在内存中无中生有地加魔术偏移量。

---

### 4.2 视口坐标亚像素容差与常量集中收敛规范

- **方案现场**：
  - Plan 04 使用了 `SCROLL_FLOOR_EPSILON = 2.0px` 与 `SCROLL_BOTTOM_THRESHOLD = 80px`；
  - Plan 05 使用了 `SUBPIXEL_JITTER_EPSILON = 1.0px`。
- **合法性定性**：
  经审查，在 Chromium（WebView2）排版引擎中，高 DPI 缩放（125%、150% 等）会导致 `scrollHeight - clientHeight - scrollTop` 产生 `0.3333px` 或 `0.6667px` 的亚像素非零微差。采用 `2.0px` 容差判定吸底、采用 `1.0px` 过滤微震属于合法的排版几何容差，**不属于针对特定组件坐标的硬编码魔术数字补偿**。
- **收敛要求**：
  严禁将这些容差以数字字面量形式散落在各个 Hook 和组件内；必须统一收口至 `apps/crish-desktop/src/components/chat-message-list/virtualScrollConstants.ts` 集中命名导出，并配齐物理语义注释。

---

### 4.3 彻底杜绝盲目延时 `setTimeout` 补丁

审查 01~09 详案中的时间控制：

- Plan 02 坚决否决了 `setTimeout(() => setSealed(true), 50)`，代之以状态机双轨锁存；
- Plan 04 切除了 `setActual` 中无休止重置 100ms 定时器的行为，代之以 rAF 帧级即时提交；
- Plan 09 废除了无守卫的异步等待，代之以双层 Generation Token；
- **需要警惕的边界**：在 Plan 05 §2.1.2 中提到“思考块折叠完成 (transitionend / 150ms)”。主控在落地时必须确保：此 150ms 仅能作为浏览器可能丢失 `transitionend` 事件时的**安全超时保底降级**，严禁作为业务逻辑的主时钟源！

---

## 五、主控 Agent 决策清单（必须改 / 建议改 / 可接受风险）

### 5.1 必须改（Must Fix）— 阻断实施的 7 大架构缺陷

1. **统一双源水合调度入口，消灭 Plan 01 与 Plan 09 的“双头真理源”**：
   - 裁决废除新建 `sessionHydrationCoordinator.ts`，统一在 `apps/crish-desktop/src/store/sessionActivateHydrate.ts` 就地重构升级；统一函数为 `triggerSessionMessageHydrateIfNeeded`，合并两级瀑布流策略与双层 Generation Token。
2. **所有详案实施必须严格执行本报告第三节整理的《物理级硬性删除清册》**：
   - 将《代码/模块/标记物理级硬性删除清册》正式列为战役各 Wave 的验收门禁，确保旧分支、死代码、死属性无残留。
3. **彻底切除 `MessageToolCallsSection` 及其周边所有死代码链条**：
   - 物理删除私有 `ResizeObserver`；同步物理删除 `virtualScrollManager` prop、`handleToggle` 中的 `invalidateActual` 调用，以及 `ProcessItemRenderer` 的透传。
4. **统一 Plan 07 的比较器代数模型至 Plan 01 的 RoleRank 四级全序**：
   - 强令 Plan 07 废弃旧三元组模型，升级为四元组 `MessageOrderKey = { seq, ts, roleRank, id }`，在所有形式化证明与公理化测试中将 `roleRank` 设为第三级强制因果守卫。
5. **坚决否决 Plan 06 中的魔术序列号 `syntheticSequence = 1000000 + eventIndex`**：
   - 严禁通过魔术数字伪造序列号；无 seq 历史消息完全依托真实 `createdAt` 与 `RoleRank` 达成全序。
6. **彻底否决 Plan 02 中在 `unitsRef` 模式下每帧调用 `setHtml(session.toHtml())` 的提案**：
   - 严守反过度设计禁令 12，`unitsRef` 模式下仅调度增量快照和版本计数；封口过渡通过 `lockedUnitsRef` 引用锁存实现零塌陷，杜绝每帧生成巨型 HTML 字符串。
7. **删除 Plan 03 中未使用的死类草案 `FrameCoalescingScheduler`**：
   - 严禁向代码库提交无调用的过度设计辅助类，纯粹使用 `Promise.all` + 世代令牌推进。

---

### 5.2 建议改（Recommended）— 2 项健壮性增强

1. **几何容差常量全局收口**：
   - 将 `SCROLL_FLOOR_EPSILON`（2.0px）、`SUBPIXEL_JITTER_EPSILON`（1.0px）集中到 `virtualScrollConstants.ts`，杜绝散落字面量。
2. **`naturalIdCompare` 性能微调**：
   - 在高频排序中，预先实例化共享的 `Intl.Collator` 实例（`new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`），避免在排序循环中反复解析语言选项对象。

---

### 5.3 可接受风险（Acceptable Risks）— 2 项已知工程权衡

1. **`Promise.all` 等待慢分片的极微小延迟（< 15ms）**：
   - 当单次 advance 产生 3 个分片时，`Promise.all` 会等待最慢的分片解析完成才触发 1 次状态更新。在极端偶发情况下，最慢分片耗时约 10~~15ms（相当于 1 帧）。相比重构前 1+N 次重渲染导致的主线程长时间锁死（30~~70ms），这一微小延迟是实现单帧原子性与渲染纯净度的最优工程权衡。
2. **极古老损坏数据无时间戳时的降级因果序**：
   - 若某些极其古老的外部损坏会话既无 sequence 也无合法时间戳（全为 0），系统将依托 `RoleRank` 保证所有 User 消息排在 Assistant 消息之前。在极限损坏数据下，人机交互不发生颠倒即达到了可接受的最强因果保底。

---

## 六、评审专家签署与主控推进建议

本评审专家对战役总方案及 01 至 09 详案进行了严格的架构净收敛审查与代码级删除面穿透。  
**结论**：方案主体扎实，技术路线准确。请主控 Agent 立即采纳上述 **“必须改”清单中的 7 项决议**，并在派发实施任务前锁定《全战役物理级硬性删除清册》，坚决杜绝打补丁与死层并存，确保系统在 Wave 1~3 推进中实现真正的高质量净收敛！
