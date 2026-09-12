# 04 · 纪律 · 执行拓扑与 Agent 派发契约

> **上游**：`00-总方案-Token消费面统一与分裂收敛.md` §三/§四 · `01-分维-防御脚本断言阶梯.md`
> **约束来源**：`AGENTS.md` §1（反退避）· §2（子 Agent 调度）· §3（多 Agent Git 提交纪律）· §4（协作文档产出约定）· §7（严禁补丁/绕过/作弊）· §9（测试资产保护铁律）

---

## 一、派发总则

| 项 | 规则 |
|---|---|
| 派发权 | **仅主 Agent 可派发**；子 Agent 深度 1，无派发能力（工具面剔除 `run_subagent`） |
| 每轮数量 | 5–12 个；任意时刻未终态 ≤16；**收尾轮允许 <5**（否则无法收尾），收尾前尽量 ≥5 |
| 模型 | 子 Agent **继承主 Agent 当前模型**（不指定 `model`，用默认继承） |
| 执行环境 | 统一 **pwsh7（PowerShell 7+）**；写文件 UTF-8 **无 BOM** |
| 等待纪律 | 长命令用**完成推送通知**（Reactive Wakeup）等待，不轮询；定时器最短 100s |
| 提交权 | **仅主 Agent**；子 Agent 一律不 `commit` / 不 `reset --hard` / 不 `checkout .` / 不 `restore` |
| 收口方式 | 主 Agent 用 `git commit --only <paths...>` 限定路径，避免误收并行 Agent 文件 |
| 空返回处理 | 1–3 次 → `task_id` 接续；4–6 次 → 拆分或换新 Agent；**6 次以上** → 主 Agent 接管实现 |
| 探索类配额 | 探索类子 Agent **最多写 1 份文档**，且必须由主 Agent 明确分配写作任务 |

---

## 二、写路径互斥（本战役的硬约束）

`tokens.css` 是**唯一被多单元共享的高冲突文件**。规则：

1. **同一批次内，`styles/tokens.css` 只允许一个单元写入**。其余单元若需改动 token，必须**提出需求并等待**该批次结束。
2. 其余文件按「文件域」分配，**任一回合内两个 Agent 的文件域不得相交**。
3. 子 Agent 若发现任务书未覆盖但必须改的共享文件 → **上报主 Agent 裁决**，不得自行扩大写域。
4. 引擎强制面（I4-M3 写路径互斥）会拒绝同一文件并发写，但**不得依赖引擎兜底**——派发前须人工保证互斥。

### 本战役文件域划分

| 单元 | 独占文件域 | 共享文件（需串行） |
|---|---|---|
| T1 | `scripts/`（新建脚本）、`docs/token-consumption-unification/基线记录/` | — |
| T2 | `styles/z-index.css`、`ui/Tooltip/Tooltip.module.css`、`chat-message-list/ChatMessageList.module.css`、`chat-message-list/ChatScrollFloorSlot.module.css` | **`styles/tokens.css`** |
| T3 | 全部 `*.module.css`（除 T2 四个 + `tokens.css`） | — |
| T4 | `chat-message-row/ChatMessageRow.module.css`、`chat-composer/ChatComposer.module.css` | — |
| T5 | `api/settings/minimalConfig.ts`、`api/settings/settingsAccess.ts`、`api/localStorageApi.ts`、`api/themeStore.ts` | — |
| T6 | `scripts/token-registry.json`、`scripts/check-token-ssot.mjs` | **`styles/tokens.css`** |
| T7 | `api/themePersonalization.ts`、`api/oklchColorGuard.ts`、`api/fontStore.ts`、`api/codeBlockIndent.ts`、`services/visualThemeController.ts`、`app/AppBootstrap.ts`、`main.tsx` | **`styles/tokens.css`** |
| T8 | `styles/markdown-typography.css`、`ui/Button`、`ui/Dialog`、`ui/Tabs`、`ui/SegmentedControl`、`diff/DiffCard`、`workspace/PreviewCard`、`sidebar/SidebarNav`、5 个 dialog 文件 | **`styles/tokens.css`** |
| T9 | 11 个孤岛组件 `*.module.css` + `scripts/token-registry.json` | — |
| T10 | 热点榜 10 个文件（与 T4 重叠者**必须串行**） | — |
| T11 | `styles/tokens.css`（选择器）、`styles/layout-contract.test.ts` | **`styles/tokens.css`** |
| T12 | `api/localStorageApi.ts`、`api/themeStore.ts`、`api/fontStore.ts`、`api/clientApiSettings.ts`、`store/`、`api/settings/`（与 T5 重叠者**必须串行**） | — |
| T13 | `apps/agent-workbench/src-tauri/src/**`、`api/transport/command-contract-drift.test.ts` | — |
| T14 | `scripts/`、`package.json`、`.husky/`、`.github/workflows/` | — |

**`tokens.css` 串行序（依赖拓扑决定）**：`T2 → T6 → T7 → T8 → T11`。

---

## 三、任务书模板（派发时必填，缺项不派发）

```
【单元】T<n> <名称>
【上游】<依赖单元的产出路径>
【目标】<一句话，必须可判定>
【输入文档】<绝对路径清单>
【文件域】允许修改：<路径清单>；只读参考：<路径清单>
【禁止触碰】<共享文件 / 他人文件域>
【验收断言】<可机械判定的条目，逐条编号>
【物证要求】触发端 / 传输端 / 介质端 / 消费端 / 负向断言（按需，见 00 §七）
【自测命令】<可直接复制的 pwsh 命令>
【红线】AGENTS.md §7 严禁补丁/绕过/作弊；禁止 --no-verify；禁止注释掉旧代码保留
```

---

## 四、批次拓扑（与 T 单元依赖一致）

### 批次 1 · 冻结与清零（地基，无相互冲突）

| Agent | 单元 | 文件域 | 并行安全性 |
|---|---|---|---|
| A1 | **T1** 门禁哨兵与基线冻结 | `scripts/`、`基线记录/` | 与其余无交集 ✓ |
| A2 | **T2** 消费面一致性红项清零 | `tokens.css` + 4 个 CSS | **独占 `tokens.css`** ✓ |
| A3 | **T3** 矛盾兜底清零（动效族） | 全部 `*.module.css` 除 T2 四个 | 与 A2 域不相交 ✓ |
| A4 | **T4** 裸 Hex 清除第一批 | `ChatMessageRow` + `ChatComposer` | 与 A3 **重叠于 `ChatComposer`** ⚠ → A3 排除这两个文件 |
| A5 | **T5** 存储幽灵读与零调用桩清退 | 4 个 `api/` 文件 | 与其余无交集 ✓ |

**批次 1 的互斥裁决**：A3 明确排除 `ChatMessageRow.module.css` 与 `ChatComposer.module.css`（归 A4）。

### 批次 2 · 分类与真源（依赖批次 1 全绿）

T6（分类 + 登记表，独占 `tokens.css`）→ 后续 A/B 类相关单元。

### 批次 3 · 结构性修复（T7 独占 `tokens.css`，串行）

T7 → T3b（兜底与最终 token 名对齐）→ T8 → T9 → T10 → T11。

### 批次 4 · 存储与跨层（与批次 3 可并行，域不重叠）

T12（前端存储）‖ T13（Rust 跨层）。

### 批次 5 · 收尾

T14（接线）→ T15（全链路物证）。

---

## 五、子 Agent 完成自查（提交前必须自证，否则主 Agent 拒收）

1. **范围自查**：`git status --porcelain` 输出 ⊆ 任务书【文件域】。
2. **断言自查**：任务书【验收断言】逐条跑过，附**命令 + 原始输出**。
3. **反向自查**：为每条新增门禁写**负向用例**并证明其会 FAIL（防「门禁恒绿」）。
4. **负向断言自查**：若删除了旧代码/旧 key/旧 token，必须有断言证明其**已不存在**（`not.toContain` / 零引用检索）。
5. **反补丁自查**：确认无「魔术数字补偿」「临时兼容分支」「注释保留的旧实现」。
6. **未提基线自查**：`git diff` 中无任何基线被抬高。
7. **门禁不绕过自查**：未使用 `--no-verify`；lint/typecheck 原生通过。

---

## 六、主 Agent 收口检查（提交前）

1. `git status` 全量核对，逐文件确认归属；对**非本战役**的既有改动（工作区存在大量其他 Agent 的历史改动）**一律不动**。
2. 逐单元跑其【自测命令】+ 全量 token 门禁；**任一红 → 不提交**。
3. **验证而非采信**：子 Agent 的汇报只描述意图，必须核对实际 diff。
4. `git commit --only <本批次路径>`，提交信息遵循仓库风格：
   `feat|fix|refactor|test|docs(desktop/token-ssot): <摘要> [BATCH-TOKEN-SSOT-<n>]`
5. 被吞并（已被他方提交）→ **只验证内容完整性**，完整则不管归属，缺失则追加；**禁止回退重做**。
6. `.husky/pre-commit` 的 `git diff --check` 扫全工作区——他人文件的 trailing whitespace 会阻塞提交，做**最小 whitespace 修复**解除阻塞（不碰内容）。
