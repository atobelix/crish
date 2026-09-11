# 主 Agent 方案：会话级改动感知体系与 UI 组件库收敛全方案

> **文档版本**：v1.0.0
> **所属战役**：`docs/session-changes-refactor/`
> **对应需求**：右侧抽屉面板改动默认收敛为「当前对话的改动（Session-Scoped Changes）」，彻底解除全局 Git 改动强制绑定，落实前端全面组件化与反硬编码铁律。

---

## 一、问题背景与现状架构缺陷深度剖析

### 1. 现场事故与表象
在桌面端新建对话或浏览任意历史对话时，右侧抽屉面板（OverviewCard）中的“改动”卡片，赫然展示为：
$$\text{改动 51 (refactor/architecture)}$$
其中罗列了工作区内多达 51 个尚未提交的文件修改（如 `workflow_commands.rs`, `openAgentPanel.ts` 等）。用户明确指出：
> “**这个改动默认是当前对话的改动，而不是 git 改动。**”
> “**后面前端相关的东西一律组件化，不允许硬编码在文件内部。所以我们是顺手做了一个 ui 组件库的。后面只要是修改代码的过程中发现硬编码了，立刻向我汇报后，你再继续工作。**”

### 2. 代码级根因定位与硬编码清单

#### 缺陷 1：数据源硬编码倒置（核心病灶）
在 [`apps/crish-desktop/src/components/overview/ChangesSection.tsx:68-70`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/ChangesSection.tsx#L68-L70)：
```typescript
// 典型伪实现与优先级颠倒：
const activeFiles =
  treeGitFiles.length > 0 ? treeGitFiles : normalizedConvoFiles;
```
- **危害**：代码硬编码将 Git 仓库改动放在第一优先级。只要开发者本地工作区有未提交文件（`treeGitFiles.length > 0` 恒成立），当前对话自身的改动 `normalizedConvoFiles` 就被彻底抹杀、永久无视！当前会话哪怕是全新的空白草稿，也会被强行塞入 51 个外部 Git 文件。

#### 缺陷 2：Git 分支信息硬编码挂载在会话改动标题
在 [`ChangesSection.tsx:116-118`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/ChangesSection.tsx#L116-L118)：
```tsx
<span>改动</span>
{fileCount > 0 ? <span className={styles.pill}>{fileCount}</span> : null}
{branch ? <span className={styles.branchLabel}>({branch})</span> : null}
```
- **危害**：Git 分支（如 `refactor/architecture`）是仓库级概念，会话则是业务交互单元。在会话改动卡片上强行挂载全局分支名，造成严重的上下文错位与误导。

#### 缺陷 3：空态语义粗暴面向 Git，完全缺失会话语义
在 [`ChangesSection.tsx:215-218`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/ChangesSection.tsx#L215-L218)：
```tsx
: !gitHelp && !gitLoading ? (
  <p className={`${styles.empty} ${styles.emptyQuiet}`} role="status">
    {git?.found && git.clean ? '干净' : '无改动'}
  </p>
) : ...
```
- **危害**：不仅硬编码了二元三元判断，文案也只表达“Git 干净 / 无改动”，完全没有表达“当前对话是否有文件产出”这一一等公民概念。

#### 缺陷 4：单向内存泄漏风险与会话改动真理源未接通
在 [`OverviewCard.tsx:96-104`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.tsx#L96-L104)，`convoFiles` 仅取自全局内存 Store `terminalStore.diffFiles`。页面刷新后内存清空，导致历史会话修改过的文件直接“蒸发”。而代码库中早已写好的纯逻辑算法 [`selectSessionDiffFiles(session.messages)`](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionDiffDerivation.ts) 却被闲置，未接通到 UI 呈现层。

#### 缺陷 5：上帝文件与违反 UI 组件化规范
`ChangesSection.tsx`（241 行）堆砌了 Git 诊断逻辑、会话文件归一化、折叠动画、文件点击跳转、重试下载逻辑等，且原生 DOM 按钮（如 `button className={styles.secH}`、`span className={styles.pill}`）到处散落，未使用 `apps/crish-desktop/src/components/ui/` 中的标准组件（如 `Badge`, `Button`, `SegmentedControl`）。

---

## 二、领域模型与数据流架构设计

### 1. 概念模型严格解耦（SSOT）

```mermaid
graph TD
  A[用户交互与总览卡片 OverviewCard] --> B{改动视图作用域 Scope}

  subgraph SessionScope[会话作用域: 默认且首要]
    B -->|默认模式 mode='session'| C[SessionChangesView]
    D[当前会话 SessionState] -->|messages.toolCalls| E[selectSessionDiffFiles 纯函数]
    F[terminalStore 运行时缓冲区] -->|实时编辑 diffFiles| G[会话改动聚合器]
    E --> G
    G -->|标准 FileDiff[]| C
  end

  subgraph WorkspaceScope[工作区作用域: 按需次级]
    B -->|显式切换 mode='git'| H[WorkspaceGitChangesView]
    I[useOverviewState / gitApi] -->|git status| J[GitStatusResult]
    J --> H
  end
```

### 2. 会话改动聚合算法（Session Diff Aggregator）

当前对话改动必须保证：**历史水合不丢、实时编辑秒显、草稿空态纯净**。
计算公式定义为纯函数：
$$\text{EffectiveSessionDiffs} = \text{Merge}(\text{selectSessionDiffFiles}(session.messages), \text{terminalStore.diffFiles})$$

* **纯度保证**：
  1. `selectSessionDiffFiles` 严格遍历 `session.messages`，仅提取状态为成功（排除 `error`, `cancelled`, `rejected` 等脏调用）的文件修改工具（`write_to_file`, `replace_file_content`, `multi_replace_file_content`, `apply_diff` 等）；
  2. 运行时 `terminalStore.diffFiles` 补充当前最新生成但尚未持久化到历史消息的 Diff 产物；
  3. 当会话为空或未触发写文件工具时，聚合结果**严格保证为 `[]`**，对应改动计数为 `0`。

---

## 三、前端 UI 组件化拆分与反硬编码方案

按照“前端相关一律组件化，不允许硬编码在文件内部，全面接入 `@/components/ui` 设计系统”的铁律，我们将原 `ChangesSection.tsx` 拆分为**单一职责组件群**，建立子目录：
`apps/crish-desktop/src/components/overview/changes/`

```
apps/crish-desktop/src/components/overview/changes/
├── ChangesSection.tsx             # 容器协调器（≤ 120 行）：管理 open 与 scopeMode 状态
├── ChangesHeader.tsx              # 单一职责：折叠行、标题、Badge 徽标、刷新按钮
├── ChangesScopeSwitcher.tsx       # 单一职责：接入 UI 库 SegmentedControl，提供模式切换
├── SessionChangesView.tsx         # 单一职责：当前对话改动列表，无改动时渲染规范 EmptyState
├── WorkspaceGitChangesView.tsx    # 单一职责：工作区 Git 改动列表与 Git 诊断/引导
├── ChangesEmptyState.tsx          # 单一职责：规范的空状态组件（统一图标、描述文案）
└── types.ts                       # 强类型定义（ChangesScopeMode = 'session' | 'git'）
```

### 1. 组件职责矩阵与 UI 组件接入

| 组件名 | 单一职责 | 消费的 UI 库基元 (`@/components/ui`) | 杜绝的硬编码 |
| :--- | :--- | :--- | :--- |
| `ChangesHeader` | 折叠控制、标题与计数展示 | `Badge` (替代原生 `.pill`), `IconButton` (替代原生刷新按钮), `Tooltip` | 移除非法挂载的 `({branch})`；Badge 仅当 count > 0 时渲染 |
| `ChangesScopeSwitcher` | 会话改动 vs 工作区 Git 改动切换 | `SegmentedControl` 或胶囊微型切换器 | 杜绝随意在文案中写死超链接；选项为纯数据驱动 `[ { label: '当前对话', value: 'session' }, { label: '工作区 Git', value: 'git' } ]` |
| `SessionChangesView` | 渲染当前对话产生的 FileDiff 列表 | `Button` (查看全部/对比), `OverviewChangesList` | 杜绝假数据与全局 git 渗透；空态时渲染 `ChangesEmptyState` |
| `WorkspaceGitChangesView` | 渲染 Git 仓库改动与诊断 | `Button` (下载 Git / 初始化 / 重试), `Tooltip` | 将分支标签 `({branch})` 隔离在此视图内，不外溢 |
| `ChangesEmptyState` | 统一规范的改动面板空态 | 优雅的灰阶排版，无背景色/无描边违规 | 杜绝散落在多个 `<p className={styles.empty}>` 的随意字符串 |

### 2. 视觉与交互状态机

1. **默认状态（新建对话或普通对话）**：
   - 卡片展开或折叠由用户记忆维持；
   - 模式锁死为 `session`（当前对话改动）；
   - 标题显示：`改动`（无分支名），如果当前会话有 2 个文件修改，显示 `<Badge tone="neutral">2</Badge>`；若无改动，**不显示任何数字徽标**；
   - 内容区：若有会话改动，渲染文件列表；若无改动，展示 `ChangesEmptyState`（“当前对话暂无文件改动”），下方附带次级链接按钮：`查看工作区 Git 改动 (51)`。
2. **次级切换状态（用户主动查看 Git 改动）**：
   - 用户点击切换器切到 `git` 模式；
   - 内容区展示工作区未暂存的 51 个文件与分支名；
   - 随时可点击一键切回当前会话改动。

---

## 四、负产出与删除面清单（Dead Layer Pruning）

按照反过度设计与净收敛要求，必须落实**负产出**，物理抹除所有旧歧义代码：

1. **物理删除歧义代码**：
   - 彻底删除 `ChangesSection.tsx` 中 `const activeFiles = treeGitFiles.length > 0 ? treeGitFiles : normalizedConvoFiles;` 这一倒置行；
   - 彻底删除 `ChangesSection.tsx` 标题行中的 `{branch ? (<span className={styles.branchLabel}>({branch})</span>) : null}`；
   - 彻底删除原生硬编码的 `.pill` 样式类，统一采用 `<Badge>`；
2. **重构瘦身**：
   - 原 `ChangesSection.tsx`（241 行）重构为纯胶水容器组件（约 80-100 行），各子视图行数均控制在 80 行以内，严格满足前端 CI 行数预算。

---

## 五、极端边界条件与防御机制

1. **新建草稿态（Draft Mode）**：
   - 草稿会话尚未持久化，`messages` 为空数组，`selectSessionDiffFiles` 返回 `[]`；
   - 运行时 `diffFiles` 亦为空；
   - 页面 100% 确定性呈现“当前对话暂无文件改动”，绝对不会发生 Git 仓库 51 个文件的倒灌。
2. **子 Agent（Subagent）产生文件修改**：
   - 若主会话派发的子 Agent 成功写入了文件，`session.agents[].messages` 同样包含修改工具调用；
   - 聚合函数支持深度扫描 `agent.messages`，确保多 Agent 协同产出的文件改动一并清晰归入当前对话成果，不错漏。
3. **撤销与回滚操作**：
   - 当用户在聊天界面执行“撤销改动 / 回滚”后，`toolCalls` 状态变为更新，聚合函数即时响应，改动列表自动同步剔除。
4. **Git 环境缺失（未安装 Git 或非 Git 目录）**：
   - 即使外部没有 Git 环境，当前对话的文件改动由于基于会话 ToolCall 派生，依然能 100% 正常查看与对比，完全解除了对本地系统 Git 进程的强绑定脆弱依赖！

---

## 六、验收标准与自动化测试规划

### 1. 自动化单元测试（Vitest）
* 测试文件：`src/components/overview/__tests__/ChangesSection.scoped.test.tsx`
  - **用例 1**：当会话无消息且 Git 仓库有 51 个修改时，默认模式必须为 `session`，改动列表必须为空，不得展示任何 Git 文件；
  - **用例 2**：当会话产生 `write_to_file` 工具调用时，改动列表必须精准呈现该文件，改动 Badge 必须显示对应文件数；
  - **用例 3**：切换到 `git` 模式时，才展示 Git 仓库未提交文件，并正确展示分支名；
  - **用例 4**：标题中绝不包含 Git 分支名（Session 模式下隔离）。

### 2. 真实桌面端实测（Tauri MCP）
* 截图取证：新建 `conex` 对话后打开右侧面板，改动区域必须呈现为当前对话改动（0 个改动，干净空态），不再显示 51 个 Git 改动。
