# Wave 1 - Task W1-C：历史消息映射与因果自愈审计与交付报告

> **任务代号**：`W1-C`  
> **所属战役**：`stream-jitter-and-order-repair`（流式渲染卡顿跳动与时序重排系统性治理）  
> **审查对象**：
>
> - [`apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts)
> - [`apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.test.ts)
> - [`apps/crish-desktop/src/store/messageOrderKey.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/messageOrderKey.ts)
>   **对齐基准**：
> - `docs/stream-jitter-and-order-repair/01-规范-执行波通用.md`
> - `docs/stream-jitter-and-order-repair/plan-reviews/00-主控最终决断书.md`（重点对齐裁决 1【四级因果全序】、裁决 2【水合主路径单轨收敛】、裁决 6【全战役物理级硬性删除与行数拆分】）
> - 根目录 `AGENTS.md`（通用纪律与立体验收标准）  
>   **产出报告**：`docs/stream-jitter-and-order-repair/execution/W1-C-历史消息映射与因果自愈报告.md`

---

## 一、完成度总结

| 审查与交付检查项                                |     状态     | 核心审计结论与证据                                                                                                                                        |
| :---------------------------------------------- | :----------: | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 主控决断书裁决 1 & 2 合规性**              | ✅ 100% 达标 | 彻底切除裸字典序回退与魔术序列号，以引擎序列号与自然因果序构建四级严格弱序；历史会话水合单轨收敛于 `sanitizeMessagesForHydrate`。                         |
| **2. 物理删除清册与死代码清理**                 | ✅ 100% 达标 | 物理删除 `parseSessionMessage` 中旧版重复解析 `thinkingTurns` 的双重冗余块；抽取 `parseTimelineBlocks` 消除上帝函数长代码内联；切除冗余立即执行函数包装。 |
| **3. `parseSessionMessage` 规范提取**           | ✅ 100% 达标 | 增加严格的非负有限整数守卫 `asNonNegativeInt`，全面兼容提取 `engineSequence ?? seq ?? sequence`，并注入 `msg.engineSequence`。                            |
| **4. 历史脏数据因果自愈（sess-1791764675736）** | ✅ 100% 达标 | 落地 `healMessagesCausalOrder` 算法：针对同毫秒碰撞/时间戳倒挂/角色逆序，按自然因果交替重组并赋予单调自增 `engineSequence`，配合 `roleRank` 刚性守门。    |
| **5. 未完成流式状态与工具调用终态收尾**         | ✅ 100% 达标 | `processing` 消息自动收尾为 `completed`；`running`/`pending_approval` 工具调用转为 `error` 并补充说明；清理历史 `'已结束。'` 脏标记；时间线对齐。         |
| **6. 行数预算与架构门禁验证**                   | ✅ 100% 达标 | `check-line-counts.mjs` 实测 **311/400 lines**（业务逻辑类），无 warnings，无 violations，零存量基线依赖，远低于 350 行硬基线。                           |
| **7. 单元测试与边界回归**                       | ✅ 100% 绿灯 | `sessionHydrationMessages.test.ts`（3 tests）+ `messageOrderKey.test.ts`（25 tests）合计 **28 项测试 100% PASS**。                                        |

---

## 二、架构背景与历史倒序根因分析（Deep Dive）

在真实用户环境与基线事故排查中（典型如会话 `sess-1791764675736`），发现了严重的**消息时序错乱、AI 回复浮顶、用户提问沉底**故障。深入源码与数据库现场后的根因分析如下：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              历史会话时序错乱与倒挂根因链路 (Root Cause Chain)                           │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. 存量引擎未写入序号：早期版本或存量 SQLite 会话中，部分历史消息缺失 `engineSequence` / `seq` 字段。     │
│                                                   ▼                                                    │
│ 2. 毫秒级时间戳并发碰撞：多条消息（User 提问与 Assistant 回复）在快速生成或导入时具有完全相同的 `timestamp`。│
│                                                   ▼                                                    │
│ 3. 旧排序器退化为裸 ID 字典序：旧版 `messageOrderKey.ts` 在缺序号且时间戳相同时，直接回退 `a.id < b.id`。     │
│                                                   ▼                                                    │
│ 4. 字符串前缀字典序反转：ID 命名规则为 `assistant-msg-*` 与 `user-msg-*`，在 ASCII 码中 `'a' < 'u'`，      │
│    导致 Assistant 消息在字典序中恒小于 User 消息，排序后 **AI 回复被前置浮顶，用户提问沉底倒挂**！         │
│                                                   ▼                                                    │
│ 5. 多轮对话交叉破裂：在同毫秒多轮场景下，所有 Assistant 回复先排，所有 User 提问后排，因果对话完全失序。  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

为了从架构层面彻底杜绝此类倒挂，必须在**历史水合恢复（Hydration）**与**时间线排序（Sorting）**两端构筑双重防线：

1. **排序端（SSOT）**：`messageOrderKey.ts` 确立四级严格弱序 `seq -> ts -> roleRank -> naturalNumericId`，在同一时间戳下刚性保证 `System (0) < User (1) < Assistant (2) < Other (3)`；
2. **水合端（Self-Healing）**：`sessionHydrationMessages.ts` 在水合时执行因果自愈，识别历史碰撞与逆序，重建连续单调的 `engineSequence`，并将持久化存储顺序还原为因果正序。

---

## 三、代码改动点与架构设计详述

### 3.1 兼容提取并保留 `engineSequence`（`parseSessionMessage`）

在 [`sessionHydrationMessages.ts:120-177`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts#L120-L177) 中，重构消息形状守卫，严密校验并提取引擎序列号：

```typescript
function asNonNegativeInt(v: unknown): number | null {
  const n = asFiniteNumber(v);
  return n != null &&
    Number.isInteger(n) &&
    n >= 0 &&
    n < Number.MAX_SAFE_INTEGER
    ? n
    : null;
}

// 在 parseSessionMessage 中：
const seq =
  asNonNegativeInt(o.engineSequence) ??
  asNonNegativeInt(o.seq) ??
  asNonNegativeInt(o.sequence);
if (seq != null) msg.engineSequence = seq;
```

**设计要点**：

- **严格数学守卫**：通过 `asNonNegativeInt` 过滤 `NaN`、`Infinity`、负数、浮点数以及非数字对象，仅放行合法的非负安全整数；
- **多版本平滑兼容**：按优先级降级捕获 `engineSequence`（当前标准规范）、`seq`（历史简写）与 `sequence`（底层引擎原始字段），使无论来自 SQLite 结构化行、历史 JSONL 还是 IPC 原始事件的消息均能无损提取；
- **类型契约对齐**：透传至 `SessionMessage.engineSequence`，直接为下游四级比较器提供第一排序键。

---

### 3.2 历史脏数据因果自愈算法逻辑（`healMessagesCausalOrder`）

在 [`sessionHydrationMessages.ts:190-324`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts#L190-L324) 中，实现了高鲁棒性的因果保序自愈流水线：

```
                    ┌──────────────────────────────────────────────┐
                    │       输入历史消息列表 (messages)            │
                    └──────────────────────┬───────────────────────┘
                                           │
                        全量拥有唯一序号且无因果角色倒挂？
                                  ├── 是 ──> 按 compareMessageOrder 校验排序，补齐单调 ts ──> 交付
                                  │
                                  └── 否
                                           │
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │ 1. 检查是否存在时间戳倒挂 (hasTsInversion)   │
                    │    若存在倒挂，先按有效时间戳升序预对齐      │
                    └──────────────────────┬───────────────────────┘
                                           │
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │ 2. 按相同时间戳 (有效 ts) 划分为微段 (run)   │
                    └──────────────────────┬───────────────────────┘
                                           │
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │ 3. 群组因果损坏探测 (isCausalGroupCorrupted) │
                    │    - 探测 Assistant 是否先于 User 出现       │
                    │    - 探测 Assistant 数量是否早于提问数量超前 │
                    │    - 探测同一角色内部是否存在自然 ID 倒挂    │
                    └──────────────────────┬───────────────────────┘
                                           │
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │ 4. 因果群组交织重排 (healCausalGroup)        │
                    │    Users 与 Assistants 各自按自然序排列，    │
                    │    交替组装：User[i] -> Assistant[i]         │
                    └──────────────────────┬───────────────────────┘
                                           │
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │ 5. 赋予连续单调 engineSequence 与单调递增 ts │
                    │    nextSeq = assignedSeq + 1; safeTs >= lastTs│
                    └──────────────────────┬───────────────────────┘
                                           │
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │       输出因果自愈消息列表 (healed)          │
                    └──────────────────────────────────────────────┘
```

**算法核心保障**：

1. **角色交织保障（Interleaving）**：通过 `healCausalGroup` 将同一个同毫秒时间戳群组内的用户提问与助手回复解构，按自然因果关系逐轮交替重织，彻底消灭 `assistant-*` 聚集在前、`user-*` 沉底在后的历史倒挂。
2. **时间戳与序号双单调化**：自愈后为每条消息生成严格递增的 `engineSequence: 0, 1, 2, ...`，并将 `timestamp` 规范化为非降序（`safeTs >= lastTs`），消除时间旅行现象。
3. **与四级弱序比较器的协同**：在下游渲染和插入时，`compareMessageOrder` 依据 `roleRank (User=1 < Assistant=2)` 守门，即使用户在运行期注入无序号消息，亦绝不会颠倒问答次序。

---

### 3.3 未完成流式状态与工具调用终态收尾（`sanitizeMessagesForHydrate`）

在 [`sessionHydrationMessages.ts:329-355`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts#L329-L355) 中，完成水合期的状态机终态收尾：

1. **未完成消息状态收口**：若某条消息处于 `status === 'processing'`（例如用户强退应用或崩溃前正在推流），水合时将其原子置为 `completed`，并确保 `text` 字段非空规范化，防止重开后消息卡片永久处于骨架动画或旋转加载态；
2. **中断工具调用标记为 `error`**：遍历所有 `toolCalls`，将状态仍为 `running` 或 `pending_approval` 的工具调用强转为 `'error'`，并补充默认说明 `'上次会话中断，工具未完成'`，杜绝工具卡片无限期等待审批或等待输出；
3. **清除客户端脏标记文本**：移除旧版客户端曾意外注入的 `'已结束。'` 虚假 Assistant 正文，避免误导后续大模型续聊上下文；
4. **时间线标准化**：调用 `normalizeAssistantTimeline(next)` 对齐 `blocks` 与 `toolCalls`，确保思考过程块与工具时间线能在重载后正确还原折叠面板。

---

## 四、物理删除清单（负产出红线验证）

依据《主控最终技术决断书》裁决 6 与执行波规范，本次重构切实履行了物理删除与代码精简：

| 文件路径与代码位置                                                                                                                                      | 物理删除内容                                                                                                                    | 删除理由与架构收益                                                                                                                                                                           |
| :------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`sessionHydrationMessages.ts:155-175`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts#L155-L175) | 物理删除旧版在 `parseSessionMessage` 顶层和末尾**重复解析 `thinkingTurns` 的双重冗余块**。                                      | 旧代码既在处理原始 `o.thinkingTurns` 时解析了一次，又在下方缺少防御性互斥的情况下再次做复杂检查；现合并为规范的 `if (o.thinkingTurns) ... else if (msg.blocks) ...` 互斥派生，削减重复逻辑。 |
| [`sessionHydrationMessages.ts:76-114`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts#L76-L114)   | 物理切除 `parseSessionMessage` 中内联展开的 60 余行长 `blocks` 解析，独立抽取为纯函数 `parseTimelineBlocks`。                   | 消除上帝函数长代码内联与嵌套回调，使 `parseSessionMessage` 专注于消息元信息与时序校验。                                                                                                      |
| [`sessionHydrationMessages.ts:42-51`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts#L42-L51)     | 物理切除 `parseToolCall` 中冗余嵌套的立即执行匿名函数 `(() => { try { return JSON.stringify(...) } catch { return ''; } })()`。 | 替换为轻量扁平的直接赋值与紧凑 `try/catch`，减少不必要的闭包分配并精简代码行。                                                                                                               |

---

## 五、行数预算自检与架构收敛数据

执行全仓行数门禁检查命令：

```powershell
node scripts/check-line-counts.mjs apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts
```

门禁执行实测输出证据：

```text
[check-line-counts] Starting RL-03 Line Budget Verification...
[check-line-counts] Target paths: apps\crish-desktop\src\api\session-persistence\sessionHydrationMessages.ts
[check-line-counts] Baseline: docs/multi-agent-repair/基线记录/frontend-line-counts-baseline.md（--update 显式维护）
  ✅ [PASS] apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts (Business Logic: 311/400 lines)

[check-line-counts] Summary:
  Scanned: 1 files
  Warnings: 0
  Violations: 0
  Hard blocks: 0
  Baselined (存量登记): 0

[check-line-counts] ✅ All scanned files passed RL-03 line budget checks!
```

### 行数预算对比表

| 目标文件                                                                                                                              |  门禁文件类别  | 有效代码行 | 门禁基线上限 |  状态   |                          架构安全裕度                           |
| :------------------------------------------------------------------------------------------------------------------------------------ | :------------: | :--------: | :----------: | :-----: | :-------------------------------------------------------------: |
| [`sessionHydrationMessages.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.ts) | Business Logic |  **311**   |     400      | ✅ PASS | 剩余 89 行（$\le 320$ 目标线已完全满足，远离 350 行基线硬门禁） |

---

## 六、测试执行结果与防御性验证

### 6.1 单元测试执行结果

执行专项 Vitest 单元测试：

```powershell
npx vitest run apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.test.ts apps/crish-desktop/src/store/messageOrderKey.test.ts
```

运行输出实录：

```text
 RUN  v3.2.7 C:/Software/conex

 ✓  unit  apps/crish-desktop/src/api/session-persistence/sessionHydrationMessages.test.ts (3 tests) 7ms
 ✓  unit  apps/crish-desktop/src/store/messageOrderKey.test.ts (25 tests) 22ms

 Test Files  2 passed (2)
      Tests  28 passed (28)
   Start at  23:08:12
   Duration  14.38s (transform 17.59s, setup 1.59s, collect 17.95s, tests 29ms, environment 1ms, prepare 545ms)
```

### 6.2 关键测试用例针对性分析

1. **存量脏会话（`sess-1791764675736`）因果自愈断言**：
   - 测试用例：`heals causal order for dirty legacy session (sess-1791764675736) where timestamps collided and IDs were inverted`
   - 输入数据：模拟该事故会话中包含 2 条 User 提问与 2 条 Assistant 回复，所有消息的时间戳均完全相同（`1791764675000`），无 `engineSequence`，且按旧字典序排列时 `assistant-msg-*` 在 `user-msg-*` 之前；
   - 验证断言：经 `sanitizeMessagesForHydrate` 净化后，消息严格恢复为 `['user', 'assistant', 'user', 'assistant']` 交替时序；对应的文本内容严格恢复为提问在前、回答在后；自动赋予递增序列号 `0, 1, 2, 3`。
2. **流式与工具中断收尾断言**：
   - 测试用例：`sanitizes processing messages and unfinished tool calls on hydration`
   - 验证断言：`status === 'processing'` 成功收尾为 `'completed'`；`status === 'running'` 的工具调用被转为 `'error'`，输出提示包含 `'上次会话中断'`。
3. **四级全序严格弱序与对称性断言**：
   - 测试用例：`messageOrderKey.test.ts` 中 25 项全量用例，覆盖非自反性、反对称性、传递性、不可比性传递性，以及自然数值 ID（`hyd-user-2 < hyd-user-10`）排序断言，全部 100% 绿灯。

---

## 七、审查结论与交付裁定

1. **符合性评定**：`sessionHydrationMessages.ts` 与 `sessionHydrationMessages.test.ts` 的实现完全遵循主控决断书裁决 1、2 与 6，彻底根除了存量历史会话倒挂的物理根因，未引入任何魔术数字或硬编码延迟；
2. **工作区状态**：所有修改已稳固保存在工作区，严格遵守不执行 `git commit` 的纪律，无任何未跟踪脏文件污染；
3. **交付裁定**：**【审查通过，准予交付】**。Task W1-C 顺利收口，支持 Wave 1 进入全量合并与对账阶段。
