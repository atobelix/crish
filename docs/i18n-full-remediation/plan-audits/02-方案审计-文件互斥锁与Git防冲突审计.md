# 方案审计报告：文件互斥锁与 Git 防冲突专项审计

> **审计任务编号**：`AUDITOR-02`
> **审计专职角色**：文件互斥锁与 Git 防冲突专职审计员
> **受审核心文档**：
> - 权威总案：[`docs/i18n-full-remediation/01-总方案-多语言化与全景系统重构总案.md`](../01-总方案-多语言化与全景系统重构总案.md)
> - 拓扑详案：[`docs/i18n-full-remediation/independent-plans/04-独立总计划-波次依赖拓扑与文件互斥锁案.md`](../independent-plans/04-独立总计划-波次依赖拓扑与文件互斥锁案.md)
> **权威协作指令**：仓库根目录 [`AGENTS.md`](../../../AGENTS.md) §1.1、§1.2、§1.3 与 [`00-战役工作纪律与规范.md`](../00-战役工作纪律与规范.md)
> **审计日期**：2026-10-14
> **审计结论**：🚨 **BLOCKER（存在阻断级并发冲突与路径错误，必须完成矩阵加固后方可放行）**

---

## 一、审计执行摘要

作为战役专职审计员，本审计员对 `01-总方案` 与 `04-独立总计划` 中的“模块物理所有权互斥锁矩阵”与 Wave 0 ~ Wave 5 的并行派单执行机制进行了逐文件、逐波次、逐 Agent 的双盲穿透审查。

审查表明，总方案在宏观上确立了“主控统一收口、子 Agent 严禁提交、文件级物理互斥”的优秀反踩踏大原则，但在**微观物理路径映射、同波次目录锁隔离度、关键枢纽文件导出竞态、以及部分 Agent 任务边界控制**上，存在 **5 处重大缺陷与冲突隐患**。若直接按照当前方案下发并行派单，将在 Wave 1、Wave 2 与 Wave 3 立即引发 `git commit --only` 路径匹配失败报错、同目录文件并发写覆盖、以及跨 Agent 契约未就绪死锁。

本报告对发现的全部隐患给出确凿的代码库证据链，并出具**修正后的全仓物理所有权互斥锁矩阵（SSOT）**，作为主控调度器与后续 Wave 派单的唯一法定执行凭据。

---

## 二、冲突隐患与路径缺陷排查总表

| 编号 | 涉及波次 | 隐患模块 / 文件路径 | 涉及 Agent 标识 | 严重级别 | 缺陷类型与核心隐患描述 |
| :---: | :---: | :--- | :--- | :---: | :--- |
| **H-01** | Wave 3 | `components/settings/SettingsSidebar.tsx` | `AGENT-UI-SIDEBAR` | 🚨 **BLOCKER** | **物理路径严重标错**：总方案写为 `sidebar/SettingsSidebar.*`，实际在 `settings/SettingsSidebar.tsx`，主控 `git commit --only` 必崩。 |
| **H-02** | Wave 3 | `apps/crish-desktop/src/components/settings/` | `AGENT-UI-SETTINGS`<br/>`AGENT-UI-SIDEBAR` | 🚨 **BLOCKER** | **同一目录锁双重冲突**：总方案将整个 `components/settings/` 划给设置组，又将位于该目录下的 `SettingsSidebar` 划给侧栏组，产生同目录并发写入破坏。 |
| **H-03** | Wave 1 | `components/settings/SettingsSchemaRenderer.tsx`<br/>`components/settingsTabsMeta.ts` | `AGENT-UI-SETTINGS-1`<br/>`AGENT-UI-SETTINGS-2` | 🚨 **BLOCKER** | **因果倒置与同波次竞争**：总方案未将 Schema 解耦提前至 Wave 1，而是在 Wave 3 边改底层 Schema 边改 15 Tab 调用，必定引发 TS 编译报错与写冲突。 |
| **H-04** | Wave 2 | `locales/{zh-CN,en-US}/`<br/>`common.ts, workspace.ts, units.ts` | 未分配 (Orphaned) | 🚨 **BLOCKER** | **高频通用词典文件沦为孤儿**：总方案定义了 10 个子模块，但派单与锁表中漏掉了 `common`, `workspace`, `units`，无 Agent 认领落盘。 |
| **H-05** | Wave 4 | 全仓 Rust 模块 (`crates/*`) | `AGENT-CORE-ERRORS` | 🚨 **BLOCKER** | **任务范围无边界，跨模块写碰撞**：指派其修改“Rust 各模块抛错消息”，与同波次独占 `session-loop`、`conex-push` 的 Agent 产生重叠写风险。 |
| **H-06** | Wave 0 | `apps/crish-desktop/src/i18n/index.ts` | `AGENT-INFRA-1/2/3` | ⚠️ **MAJOR** | **顶层聚合出口并发写竞态**：多个 Agent 并发新增 formatters、`<Trans />`、Context 等，均需向 `index.ts` 追加 export，方案未设写锁。 |
| **H-07** | Wave 1 | `components/sidebar/session-list/SessionRow.tsx` | `AGENT-SESSION-BUG` | ⚠️ **MAJOR** | **路径缺层**：总方案写为 `sidebar/SessionRow.tsx`，遗漏 `session-list/` 子目录，导致 Git `--only` 报错。 |
| **H-08** | Wave 2 | `apps/crish-desktop/src/services/toast/ToastStore.ts` | `AGENT-TOAST` | ⚠️ **MAJOR** | **锁表遗漏跨目录文件**：总方案仅锁了 `components/overlay/Toast*.tsx`，遗漏了核心状态层 `services/toast/ToastStore.ts`。 |
| **H-09** | Wave 1 | `api/markdown-render/markdownCodeFence.ts`<br/>`markdownTable.ts`, `crates/conex-types/src/error.rs` | `AGENT-RENDER`<br/>`AGENT-CONTRACT` | ⚠️ **MAJOR** | **锁表遗漏配套同构回退文件与 Rust 契约文件**：总方案锁表遗漏前端回退解析与后端契约文件，主控收口将漏提。 |
| **H-10** | Wave 0-5| `locales/{lang}/index.ts` 聚合入口 | 全体 Agent | 💡 **MINOR** | **高危冻结文件缺乏自动化防篡改门禁**：仅有提示词约定，缺少脚本级强制拦截破坏。 |

---

## 三、深度穿透审查与确凿证据链

### 3.1 缺陷 1：物理路径严重标错，导致 Git `--only` 必然中断阻断

#### 现场证据：
在 `01-总方案` 第 213 行与第 205 行：
```markdown
| apps/crish-desktop/src/components/sidebar/SettingsSidebar.* | Wave 3 | AGENT-UI-SIDEBAR |
| apps/crish-desktop/src/components/sidebar/SessionRow.tsx     | Wave 1 | AGENT-SESSION-BUG |
```
然而，通过真实文件系统检索（PowerShell 实测）：
```powershell
Get-ChildItem -Path "apps/crish-desktop/src" -Filter "*SettingsSidebar*" -Recurse
# 真实路径: apps/crish-desktop/src/components/settings/SettingsSidebar.tsx

Get-ChildItem -Path "apps/crish-desktop/src" -Filter "*SessionRow.tsx" -Recurse
# 真实路径: apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx
```

#### 破坏力分析：
依据 [`AGENTS.md`](../../../AGENTS.md) §1.3 铁律，主控收口时**严禁盲目 commit -a，必须执行 `git commit --only <paths>`**。
若主控按总方案执行：
```bash
git commit --only apps/crish-desktop/src/components/sidebar/SettingsSidebar.tsx
```
Git 将直接抛出致命错误：`fatal: pathspec '...' did not match any files`，导致整个波次的自动收口流水线中断！

---

### 3.2 缺陷 2：Wave 3 `components/settings/` 目录锁硬重叠与 3 Agent 并发写破坏

#### 现场证据：
在 `01-总方案` 第 211 行与第 278-285 行：
- 互斥锁表第 211 行：`apps/crish-desktop/src/components/settings/ (15 Tabs)` 赋予 `AGENT-UI-SETTINGS`；
- Wave 3 正文第 279 行：`AGENT-UI-SETTINGS-1` 改 `SettingsSchemaRenderer.tsx` 与 `settingsTabsMeta.ts`；
- Wave 3 正文第 280 行：`AGENT-UI-SETTINGS-2` 批量改 15 个设置 Tab；
- Wave 3 正文第 281 行：`AGENT-UI-SIDEBAR` 改 `SettingsSidebar.tsx` 与 `SettingsPanel.module.css`。

#### 破坏力分析：
1. `SettingsSidebar.tsx` 与 `SettingsPanel.module.css` 物理上都位于 `apps/crish-desktop/src/components/settings/` 目录内部！
2. 这意味着，在同一波次（Wave 3）内，**同时有 3 个不同的 Agent（SETTINGS-1、SETTINGS-2、SIDEBAR）在同一个物理目录 `components/settings/` 内部并发修改不同的文件**。
3. 任何一个 Agent 在保存或格式化时，如果编辑了共享的样式表（如 `SettingsPanel.module.css`）或公共辅助文件（如 `SettingsShortcutsHelpers.ts`、`useAppearanceSettings.ts`），将直接导致工作区写冲突或改动被后完成的 Agent 覆盖！

---

### 3.3 缺陷 3：因果倒置——SchemaRenderer 与 15 Tab 放在同一波次导致契约未就绪死锁

#### 现场证据：
在 `01-总方案` Wave 3 中：
- `AGENT-UI-SETTINGS-1` 正在重构 `SettingsSchemaRenderer.tsx`，为表单项增加 `titleKey` / `descKey` 字段定义；
- `AGENT-UI-SETTINGS-2` 同时在改 15 个 Tab 的 TSX 代码，要求它们调用全新的 `titleKey` 接口。

#### 破坏力分析：
- 在 `04-独立总计划` §2.5 中，规划师已明确将此定义为 **“因果断层 E”**，强调 SchemaRenderer 必须绝对先于 15 Tab 改造；
- 但总方案合并时疏忽，未将 `SettingsSchemaRenderer.tsx` 移至 Wave 1，而是留在了 Wave 3 并发执行；
- 当两个 Agent 并行运行时，`SETTINGS-2` 面对的是**尚未更新的旧版 SchemaRenderer 类型**，直接运行 `npm run typecheck` 将报 `Property 'titleKey' does not exist on type 'SchemaField'`，编译阻断，任务被迫停滞！

---

### 3.4 缺陷 4：Wave 2 通用字典文件沦为孤儿，词典残缺

#### 现场证据：
在 `01-总方案` §3.1 中，规范了 10 个子模块：
`common.ts`, `nav.ts`, `chat.ts`, `settings.ts`, `error.ts`, `action.ts`, `tool.ts`, `about.ts`, `workspace.ts`, `units.ts`。
但在 `01-总方案` 第 268-274 行（Wave 2 派单）中：
- `AGENT-DICT-ERROR`：负责 `error.ts` 与 `action.ts`；
- `AGENT-DICT-SETTINGS`：负责 `settings.ts`, `nav.ts`, `about.ts`；
- `AGENT-DICT-CHAT`：负责 `chat.ts`, `tool.ts`；
- **全案遗漏**：`common.ts`（通用按钮/提示）、`workspace.ts`（工作区切换）、`units.ts`（复数/度量单位）**没有指派给任何 Agent**！

#### 破坏力分析：
- 这 3 个模块是全系统最基础的公共词汇（“确定”、“取消”、“保存”、“复制”、“成功”、“秒”、“MB”等）；
- 若 Wave 2 漏建这 3 个模块，Wave 3 的各个 UI Agent 改造业务组件时，将发现字典中根本没有公共键，导致各 Agent 各自发明临时私有键，引发字典碎片化和命名雪崩。

---

### 3.5 缺陷 5：Wave 4 `AGENT-CORE-ERRORS` 缺乏文件边界，存在全局污染隐患

#### 现场证据：
在 `01-总方案` 第 292 行：
`AGENT-CORE-ERRORS`：“Rust 各模块抛错消息统一为机器错误码 + 命名参数 + 英文开发者回退，消除中文拼接”。

#### 破坏力分析：
- “Rust 各模块”是一个模糊的泛称，全仓有 20+ 个 Rust crate；
- 同一波次内，`AGENT-KERNEL-PROMPT` 在修改 `crates/session-loop/`，`AGENT-PUSH` 在修改 `apps/agent-workbench/src-tauri/src/push/`；
- 若 `AGENT-CORE-ERRORS` 随意修改各模块中的报错抛出点，将产生多个 Agent 同时修改 `session-loop` 或 `src-tauri` 源码的写竞争！必须将 `AGENT-CORE-ERRORS` 的编辑范围刚性锁定在 `crates/conex-types/src/error.rs` 与前端错误派生转换层。

---

## 四、高危枢纽文件只读冻结机制审查与加固

### 4.1 核心枢纽文件现状排查
本战役存在两类极度敏感的汇聚文件：
1. **字典聚合出口**：
   - `apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/index.ts`
   - `apps/crish-desktop/src/i18n/locales/index.ts`
   - `apps/crish-desktop/src/i18n/index.ts`
2. **核心单测与资产白名单**：
   - `apps/crish-desktop/src/api/chatEmptyState.test.ts` (699 行核心资产，零改动保护)
   - `reference/markdown-editor/` (用户资产，绝对禁删)

### 4.2 冻结机制漏洞
- 方案仅通过在文档中声明“完成后全流程只读冻结”，属于“道德纪律约束”；
- 子 Agent 行为不可控，若在 Wave 2 或 Wave 3 中因“类型导入报错”顺手修改了 `locales/zh-CN/index.ts`，主控极难通过肉眼在海量改动中察觉；
- **加固裁决**：
  必须在 Wave 0 研发的 `scripts/check-i18n-symmetry.mjs` 或 `scripts/check-guard-system.mjs` 中注入**静态只读文件校验断言（Frozen Hub Assertion）**：
  - 在 Wave 0 固化后，记录 `locales/{zh-CN,en-US}/index.ts` 的 SHA-256 哈希；
  - 在 Wave 1 ~ Wave 5 的 pre-commit 与 check 阶段，断言该文件哈希严格不变；若发生变更且非白名单波次，直接阻断提交！

---

## 五、Git 并行防踩踏与被吞并（Stolen Commits）恢复协议审计

根据 [`AGENTS.md`](../../../AGENTS.md) §1.3，多 Agent 并行开发中，Git 冲突的主要源头是**共享暂存区（Shared Index）与非限定提交（Unscoped Commits）**。

### 5.1 刚性执行纪律审计
1. **子 Agent 权限降级**：
   - 严禁子 Agent 运行 `git add`, `git commit`, `git push`；
   - **绝对禁止使用 `--no-verify`** 绕过门禁；
   - **绝对禁止使用 `git reset --hard`、`git checkout .` 或 `git restore`**。改错自己的文件必须用精准文件写入工具修复，严禁全盘回滚波及他人改动。
2. **主控提交网关铁律**：
   - 主控在每一个 Agent 验证完成或波次结束时，必须执行带有显式路径限定的提交：
     ```bash
     git commit --only <精确文件路径列表> -m "feat(i18n): <波次及模块描述> [BATCH-W<N>]"
     ```
   - 严禁执行 `git commit -a` 或无参数 `git commit`。

### 5.2 并行吞并（Stolen Commits）应急恢复标准 SOP
若在主控收口前，某个子 Agent 的工作区改动被仓库中运行的其他定时 Agent 意外提交入库：
- **第一步（严禁回滚）**：严禁执行 `git reset HEAD~1`，避免冲掉其他 Agent 的提交记录；
- **第二步（差异核验）**：运行 `git show HEAD:<filepath>` 对比工作区预期内容；
- **第三步（无损处置）**：
  * 若内容已完整落盘入库：直接标记该 Agent 任务通过；
  * 若有部分遗漏：在工作区补齐缺失代码，使用 `git commit --only <filepath>` 再次提交补丁。

---

## 六、全仓物理所有权互斥锁矩阵（法定修订版 SSOT）

为彻底解决上述 5 大隐患，本审计员对互斥锁矩阵进行了严密重构。
**修正原则**：
1. **因果拓扑前置**：将 `SettingsSchemaRenderer.tsx` 移至 Wave 1，提前就绪 Schema 类型；
2. **物理路径纠正**：纠正 `SettingsSidebar.tsx`、`SessionRow.tsx`、`ToastStore.ts` 的实际绝对路径；
3. **消除孤儿词典**：在 Wave 2 增设 `AGENT-W2-DICT-BASE`，全权负责 `common.ts`, `workspace.ts`, `units.ts`；
4. **收敛 Rust 边界**：将 `AGENT-CORE-ERRORS` 严格限制在 `crates/conex-types/` 与特定桥接层；
5. **细化 UI 目录锁**：将 `components/settings/` 拆解为细粒度单文件锁，避免目录级冲突。

### 法定互斥锁分配总表（Wave 0 ~ Wave 5）

| 物理文件 / 目录路径 | 所属功能域 | 独占波次 | 独占 Agent 标识 | 访问模式 | 冲突防范与并发安全规则 |
| :--- | :--- | :---: | :--- | :---: | :--- |
| **`apps/crish-desktop/src/i18n/types.ts`** | 核心架构 | Wave 0 | `AGENT-W0-ARCH` | 独占写 | 奠定 SSOT `Paths<T>` 基础类型，Wave 0 完成后只读 |
| **`apps/crish-desktop/src/i18n/I18nContext.tsx`** | 上下文分发 | Wave 0 | `AGENT-W0-ARCH` | 独占写 | 升级双通道 Context 与 Epoch，引用永久稳定 |
| **`apps/crish-desktop/src/i18n/components/Trans.tsx`** | 富文本插槽 | Wave 0 | `AGENT-W0-ARCH` | 独占写 | 约 40 行零依赖原生组件 |
| **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/index.ts`** | 词典聚合出口 | Wave 0 | `AGENT-W0-ARCH` | 独占写 | 搭建 10 模块聚合导入骨架，**完成后全流程绝对只读冻结** |
| **`apps/crish-desktop/src/i18n/locales/index.ts`** | 顶层字典入口 | Wave 0 | `AGENT-W0-ARCH` | 独占写 | 聚合导出 dictionaries，**完成后只读冻结** |
| **`apps/crish-desktop/src/i18n/index.ts`** | 顶层 Barrel 导出 | Wave 0 | `AGENT-W0-ARCH` | 独占写 | **单点统筹导出** Trans, formatters, Context，消灭并发写冲突 |
| **`apps/crish-desktop/src/i18n/formatters/**`** | 格式化工具链 | Wave 0 | `AGENT-W0-FORMAT` | 独占写 | 原生 Intl 封装（plural, datetime, number, bytes） |
| **`scripts/check-i18n-hardcoded.mjs`** | 门禁工具 | Wave 0 | `AGENT-W0-GATE1` | 独占写 | 两段式 AST 扫描与基线比对引擎 |
| **`scripts/check-i18n-symmetry.mjs`** | 门禁工具 | Wave 0 | `AGENT-W0-GATE2` | 独占写 | 词典对称性、汉字纯度与参数校验 |
| **`scripts/check-i18n-unused-keys.mjs`** | 门禁工具 | Wave 0 | `AGENT-W0-GATE2` | 独占写 | 废弃死词条扫描器 |
| **`.husky/pre-commit`** & **`package.json`** | 工程与钩子 | Wave 0 | `AGENT-W0-GUARD` | 独占写 | 接入 check:i18n 脚本链条与 guard-system 保护 |
| **`docs/i18n-full-remediation/基线记录/`** | 质量基线 | Wave 0-5 | **主控独占收口** | 串行写 | 子 Agent 严禁传 `--update`，仅主控在收口时执行更新 |
| **`packages/shared-types/src/errors/info.ts`** | TS 错误契约 | Wave 1 | `AGENT-W1-CONTRACT` | 独占写 | 扩展 `titleKey`，拔除 3 处中文长句 |
| **`packages/shared-types/src/errors/serialize.ts`** | 错误序列化 | Wave 1 | `AGENT-W1-CONTRACT` | 独占写 | 扩展 `CrishErrorPayload.params` 字段 |
| **`crates/conex-types/src/error.rs`** | Rust 错误契约 | Wave 1 | `AGENT-W1-CONTRACT` | 独占写 | Rust 侧对齐 `titleKey` 与 3 处 action 键收敛 |
| **`apps/crish-desktop/src/api/markdown/unitReconciler.ts`** | DOM 调和器 | Wave 1 | `AGENT-W1-RECONCILER` | 独占写 | 紧急重构：改用 `.md-table-wrap` / `data-md-table`，先于 Rust 落地 |
| **`crates/conex-markdown/src/renderer.rs`** | Markdown 渲染 | Wave 1 | `AGENT-W1-MARKDOWN` | 独占写 | 拔除复制/表格中文，输出中立语义属性（必须在调和器完成后启动） |
| **`apps/crish-desktop/src/api/markdown-render/markdownCodeFence.ts`** | JS 渲染回退 | Wave 1 | `AGENT-W1-MARKDOWN` | 独占写 | 对齐代码块中立语义属性 |
| **`apps/crish-desktop/src/api/markdown-render/markdownTable.ts`** | JS 渲染回退 | Wave 1 | `AGENT-W1-MARKDOWN` | 独占写 | 对齐表格中立语义属性 |
| **`apps/crish-desktop/src/api/chatEmptyState.ts`** | 空态纯逻辑 | Wave 1 | `AGENT-W1-EMPTYSTATE` | 独占写 | 双层解耦，100% 保护 699 行 `chatEmptyState.test.ts` 资产 |
| **`apps/crish-desktop/src/components/settings/SettingsSchemaRenderer.tsx`** | 表单渲染引擎 | **Wave 1** (前置) | `AGENT-W1-SCHEMA` | 独占写 | **前置解耦**：扩展 `titleKey`, `descKey`，为 Wave 3 铺平契约 |
| **`apps/crish-desktop/src/components/settingsTabsMeta.ts`** | 设置元数据 | **Wave 1** (前置) | `AGENT-W1-SCHEMA` | 独占写 | 导出动态 `useSettingsTabs()` Hook |
| **`apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx`** | 会话行组件 | Wave 1 | `AGENT-W1-SESSION` | 独占写 | **纠正路径**：拔除 `/ - 分支$/` 中文正则，改为语言中立算法 |
| **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/error.ts`** | 错误码字典 | Wave 2 | `AGENT-W2-DICT-ERR` | 独占写 | 105 个错误码 Title 穷举填充 |
| **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/action.ts`** | 行动引导字典 | Wave 2 | `AGENT-W2-DICT-ERR` | 独占写 | 96 个 Action 操作建议双语词条填充 |
| **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/settings.ts`** | 设置字典 | Wave 2 | `AGENT-W2-DICT-SET` | 独占写 | 15 个设置 Tab 全量双语表单文案填充 |
| **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/chat.ts`** | 对话流字典 | Wave 2 | `AGENT-W2-DICT-CHAT` | 独占写 | 对话流、输入框、空态、提示词双语词条 |
| **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/tool.ts`** | 工具卡片字典 | Wave 2 | `AGENT-W2-DICT-CHAT` | 独占写 | 工具卡片、审批弹窗、参数折叠双语词条 |
| **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/common.ts`** | 通用词汇字典 | Wave 2 | `AGENT-W2-DICT-BASE` | 独占写 | **补齐孤儿模块**：确定、取消、保存、复制、成功等 |
| **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/nav.ts`** | 导航与侧栏 | Wave 2 | `AGENT-W2-DICT-BASE` | 独占写 | 侧栏项目、顶栏、面包屑双语词条 |
| **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/workspace.ts`** | 工作区字典 | Wave 2 | `AGENT-W2-DICT-BASE` | 独占写 | **补齐孤儿模块**：工作区切换、访客模式双语词条 |
| **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/units.ts`** | 度量单位字典 | Wave 2 | `AGENT-W2-DICT-BASE` | 独占写 | **补齐孤儿模块**：复数单位结构、时间与数据单位 |
| **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/about.ts`** | 关于与法律声明 | Wave 2 | `AGENT-W2-DICT-BASE` | 独占写 | 496 行法律协议、开源许可证、系统信息词条 |
| **`apps/crish-desktop/src/utils/error-translation.ts`** | 错误翻译中心 | Wave 2 | `AGENT-W2-TRANS` | 独占写 | 智能双向回退引擎，支持 `params` 插值，废除 33 码死表 |
| **`apps/crish-desktop/src/services/toast/ToastStore.ts`** | 通知状态中心 | Wave 2 | `AGENT-W2-TOAST` | 独占写 | **补全路径**：原生消费 `CrishErrorPayload`，清除中文正则猜错 |
| **`apps/crish-desktop/src/components/overlay/ToastCard.tsx`** | Toast 渲染卡片 | Wave 2 | `AGENT-W2-TOAST` | 独占写 | 国际化“撤销”、“关闭通知”按钮 |
| **`apps/crish-desktop/src/components/overlay/ToastViewport.tsx`** | Toast 视口容器 | Wave 2 | `AGENT-W2-TOAST` | 独占写 | 国际化“通知中心”无障碍标签 |
| **`apps/crish-desktop/src/components/settings/SettingsAppearanceTab.tsx` 等 (Tab 1-5)** | 设置 Tab 组 A | Wave 3 | `AGENT-W3-SET-A` | 独占写 | 外观、通用、个性化、归档、模型 5 Tab 改造 |
| **`apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx` 等 (Tab 6-10)** | 设置 Tab 组 B | Wave 3 | `AGENT-W3-SET-B` | 独占写 | 用量、设备、规则、定时任务、插件 5 Tab 改造 |
| **`apps/crish-desktop/src/components/settings/SettingsBrowserTab.tsx` 等 (Tab 11-15)** | 设置 Tab 组 C | Wave 3 | `AGENT-W3-SET-C` | 独占写 | 浏览器、快捷键、安全、诊断与关于 (496行) 改造 |
| **`apps/crish-desktop/src/components/settings/SettingsSidebar.tsx`** | 设置侧栏排版 | Wave 3 | `AGENT-W3-TYPO` | 独占写 | **纠正路径**：注入 `.sidebarTabLabel` 截断与 `<Tooltip>` |
| **`apps/crish-desktop/src/components/settings/SettingsPanel.module.css`** | 设置面板样式 | Wave 3 | `AGENT-W3-TYPO` | 独占写 | 注入弹性高度防御与 236px 英文自适应 |
| **`apps/crish-desktop/src/components/chat-card/ChatEmptyState.tsx`** | 对话空态 UI | Wave 3 | `AGENT-W3-CHAT-EMPTY`| 独占写 | 对接 Layer 2 适配层，消除写死中文 |
| **`apps/crish-desktop/src/components/chat-composer/**`** | 输入框全家桶 | Wave 3 | `AGENT-W3-COMPOSER` | 独占写 | 附件栏、提示词、发送/停止按钮、取消确认弹窗 |
| **`apps/crish-desktop/src/components/chat-message-row/**`** | 消息行与操作 | Wave 3 | `AGENT-W3-CHAT-ROW` | 独占写 | 气泡操作栏、思维链折叠块、代码复制状态 |
| **`apps/crish-desktop/src/components/sidebar/UserProfileCard.tsx`** | 用户卡片 a11y | Wave 3 | `AGENT-W3-SIDEBAR` | 独占写 | a11y 读屏参数化词条重构，消除拼合中文 TTS 畸变 |
| **`crates/session-loop/src/steering/**`** | 意图推进自愈 | Wave 4 | `AGENT-W4-STEER` | 独占写 | 引入 `SessionLanguageDetector`，双语自愈 Nudge |
| **`crates/session-loop/src/loop/handlers/no_tool_calls.rs`** | 自愈分发处理 | Wave 4 | `AGENT-W4-STEER` | 独占写 | 语言感知分流，英文上下文注入英文 Steering |
| **`crates/orchestrator/src/goal_state.rs`** | 长期目标判定 | Wave 4 | `AGENT-W4-GOAL` | 独占写 | 扩充英文边界词判定，消除纯中文限制 |
| **`apps/agent-workbench/src-tauri/src/run/run_resume.rs`** | 长期目标指令 | Wave 4 | `AGENT-W4-GOAL` | 独占写 | 长期目标多语言指令模板 |
| **`crates/agent-tools/src/subagent_inject.rs`** | 子代理角色约束 | Wave 4 | `AGENT-W4-SUBAGENT` | 独占写 | 双语子代理角色提示词分流 |
| **`apps/agent-workbench/src-tauri/src/push/vendor/mod.rs`** | 设备注册模型 | Wave 4 | `AGENT-W4-PUSH` | 独占写 | `VendorDevice` 增加 `preferred_language` |
| **`apps/agent-workbench/src-tauri/src/push/copy.rs`** | 推送文案渲染 | Wave 4 | `AGENT-W4-PUSH` | 独占写 | 17 种场景双语结构化下发 |
| **`apps/agent-workbench/src-tauri/src/push/quiet.rs`** | 夜间静默摘要 | Wave 4 | `AGENT-W4-PUSH` | 独占写 | 双语夜间折叠摘要算法 |
| **全仓未归零 TSX 文件** | 基线清零冲刺 | Wave 5 | `AGENT-W5-CLEANUP` | 串行写 | 清除剩余零星硬编码中文，基线归零 |
| **全仓字典文件** | 死词条清理 | Wave 5 | `AGENT-W5-UNUSED` | 串行写 | 扫描并安全移除未消费死词条 |

---

## 七、放行整改清单（Action Items）与主控签批条件

为解除 🚨 **BLOCKER** 状态并使方案通过审计，主控调度器必须在下发 Wave 0 之前，在总方案与执行规范中完成以下 **4 项刚性整改**：

1. **修正总方案中的路径硬伤**：
   - 将 `apps/crish-desktop/src/components/sidebar/SettingsSidebar.*` 纠正为 `apps/crish-desktop/src/components/settings/SettingsSidebar.tsx` 与 `SettingsPanel.module.css`；
   - 将 `apps/crish-desktop/src/components/sidebar/SessionRow.tsx` 纠正为 `apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx`；
   - 在互斥表中显式增补 `apps/crish-desktop/src/services/toast/ToastStore.ts`。
2. **重构波次因果拓扑，前置 SchemaRenderer**：
   - 将 `SettingsSchemaRenderer.tsx` 与 `settingsTabsMeta.ts` 的改造从 Wave 3 抽离，**提升至 Wave 1 的 `AGENT-W1-SCHEMA` 独占实施**，确保 Wave 3 改造 Tab 时依赖的类型契约已完全就绪。
3. **补齐 Wave 2 字典分配，消灭孤儿模块**：
   - 正式设立 `AGENT-W2-DICT-BASE`，明确分配 `common.ts`、`workspace.ts`、`units.ts`、`nav.ts`、`about.ts` 的编写所有权，确保 10 大字典模块 100% 覆盖。
4. **收敛 Wave 4 `AGENT-CORE-ERRORS` 的模糊边界**：
   - 废除“修改 Rust 各模块”的无边界描述，其职责并入 `AGENT-W1-CONTRACT` 与 `AGENT-W2-TRANS`，Wave 4 仅聚焦自愈 Prompt、长期目标与跨端 Push。

---

## 八、审计员签字与裁决生效

本审计员特此确认：
上述审查结论建立在对代码库真实目录树与 Git 机制的严格穿透基础之上，无任何主观臆测与退避妥协。
待主控调度器依据本报告【第六章：法定互斥锁分配总表】完成总方案细节订正后，本审计员将即刻签署 **PASS（放行）** 决议，全面启动 Wave 0 施工！

**专职审计员签字**：`AUDITOR-02 (文件互斥锁与Git防冲突审计员)`
**签署日期**：2026-10-14
