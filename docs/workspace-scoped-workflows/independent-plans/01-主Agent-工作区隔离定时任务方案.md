# 01-主Agent-工作区隔离定时任务与去全局化方案

> **战役主题**：定时任务（Workflow / CronJob）去全局化、工作区目录（CWD）强制绑定与按工作区严格隔离展示。  
> **权威裁决**：“定时任务没有全局这一说，只能在工作区目录里面选择，所以其他项目在未绑定定时任务的情况下，是没有东西显示的。”

---

## 一、现状缺陷与根因定位

### 1. 缺陷表象
1. 在右侧抽屉面板中，无论当前切到哪个项目，点击“计划任务”均固定显示全系统的所有定时任务（例如 `计划任务 2`）；
2. 即使在新创建的空项目、未绑定任何定时任务的工作区中，依然被其它项目的定时任务污染，无法呈现纯净空态；
3. 用户在创建/编辑定时任务时，表单默认选项居然包含了“默认工作区（全局）”（`{ id: '', label: '默认工作区（全局）' }`）。

### 2. 代码级根因定位
1. **UI 选项硬编码“全局”伪概念**：
   * [`apps/crish-desktop/src/components/settings/WorkflowForm.tsx:254`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/WorkflowForm.tsx#L254)：
     ```ts
     const projectOptions = [
       { id: '', label: '默认工作区（全局）' },
       ...projects.map((p) => ({ id: p.path, label: p.name, hint: p.path })),
     ];
     ```
     赋予了 `draft.cwd = ''` 的合法性，从源头制造了“无工作区归属的幽灵全局任务”。
2. **右侧抽屉面板数据源未进行工作区过滤**：
   * [`apps/crish-desktop/src/components/overview/OverviewCard.tsx:43-46`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.tsx#L43-L46)：
     ```tsx
     const cronJobs = useSettingsField(selectScheduledTasks);
     const ds = useEngineState();
     // ...
     <ScheduleSection workflows={ds.workflows} cronJobs={cronJobs} />
     ```
     `OverviewCard` 将全局引擎的 `ds.workflows`（全部工作流）以及 `cronJobs`（全局 settingsStore 计划任务）一股脑传给 `ScheduleSection`，未传入当前工作区路径，亦未做任何工作区归属过滤。
3. **`ScheduleSection` 无过滤逻辑**：
   * [`apps/crish-desktop/src/components/overview/ScheduleSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/ScheduleSection.tsx)：直接以 `workflows.length + cronJobs.length` 计数并全量循环渲染，导致任何项目都能看到所有任务。

---

## 二、架构重构设计

### 1. 领域模型规则（强制去全局化）
1. **消除全局概念**：
   * 彻底删除“默认工作区（全局）”选项；
   * 定时任务必须绑定明确的工作区物理根路径（`cwd: string`）；
   * 创建定时任务时，`cwd` 必填。如果在特定对话内创建，默认取当前会话绑定的项目路径；如果在设置面板创建，必须从已有项目列表中选定具体项目。
2. **跨平台路径归一化规范（Path Normalization）**：
   * Windows 路径在比较前统一使用项目标准 `normalizeFsPath`（正斜杠归一、大小写无关 Windows 兼容、尾部斜杠清理）；
   * 比较逻辑：`normalizePath(task.cwd) === normalizePath(currentWorkspacePath)`。

### 2. 前端展示层过滤体系（SSOT）
1. **抽屉面板与当前工作区绑定**：
   * `OverviewCard` / `useOverviewState` 获取当前激活的工作区路径：
     - 优先取当前会话 `session.folder` 映射的项目物理路径；
     - 若会话无 folder，则取当前激活项目的路径 `activeProject.path`。
2. **纯函数选择器 `filterWorkflowsByWorkspace`**：
   * 输入：`workflows: WorkflowDefinition[]`, `cronJobs: CronJob[]`, `workspacePath: string | null | undefined`
   * 过滤规则：
     - 仅保留 `task.cwd` 且 `normalizePath(task.cwd) === normalizePath(workspacePath)` 的条目；
     - 若 `workspacePath` 未知或当前工作区未配置定时任务，返回 `[]`；
3. **纯净空态呈现**：
   * 当过滤后数量为 0 时：
     - 头部不显示数字 badge（对齐 `计划任务` 无任务状态）；
     - 展开后展示柔和的空态文案：“无定时任务”（并附带“在当前项目创建”的轻量快捷动作）。

---

## 三、负产出与删除面清单

1. **删除 `WorkflowForm.tsx` 中的全局项**：
   - 物理删除 `{ id: '', label: '默认工作区（全局）' }`；
   - 校验逻辑中增加 `if (!draft.cwd) return '请选择所属工作区项目'`。
2. **删除全局透传逻辑**：
   - 废除 `OverviewCard` 直接消费未过滤 `ds.workflows` 的直通管道。

---

## 四、验收断言

1. **项目隔离断言**：在工作区 A 创建的定时任务，切换至工作区 B 后，右侧抽屉计划任务中绝对不出现，计数为 0，展示“无”；
2. **空态断言**：未配置定时任务的工作区，首次打开侧边栏计划任务绝对不展示任何其它项目的任务；
3. **自动化门禁**：类型检查通过，全量单测通过，行数门禁 0 违规。
