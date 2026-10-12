# 定时任务全流程修复与能力升级战役（Scheduled Tasks Revamp）

# 阶段 5 独立方案：前端 UI 交互、表单能力与状态同步

> **文档定位**：独立方案文档（Subagent 4: IPC State & Frontend Integration Architect）
> **关联阶段**：阶段 5 (Phase 5) · 前端 UI 交互、表单能力与状态同步
> **关联上游**：阶段 3（目标会话绑定）、阶段 4（Tauri IPC 命令面与元数据双向一致性）
> **核心规范**：`AGENTS.md`（§12 Tooltip、§13 输入框焦点与无重阴影、§14 现代 CSS 色彩）、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`
> **目标文件**：
>
> - `apps/crish-desktop/src/components/settings/WorkflowForm.tsx`
> - `apps/crish-desktop/src/components/settings/WorkflowList.tsx`
> - `apps/crish-desktop/src/components/settings/ScheduledTasksPanel.tsx`
> - `apps/crish-desktop/src/components/settings/SettingsScheduleTab.tsx`
> - `apps/crish-desktop/src/components/settings/useWorkflowsState.ts`
> - `apps/crish-desktop/src/components/settings/workflowsSharedLib.ts`
> - `apps/crish-desktop/src/api/workflow-api/workflowDraft.ts`
> - `apps/crish-desktop/src/api/workflow-api/workflowScheduler.ts`

---

## 一、阶段定位与核心攻坚目标

前端定时任务交互界面是用户直接感知 Conex / Crish 自动化能力的第一窗口。当前系统在侧边栏面板（`ScheduledTasksPanel`）和设置页 Tab（`SettingsScheduleTab`）双入口下，由于共享逻辑层中残留的历史遗留缺陷，导致用户在日常使用中遭遇以下严重阻碍：

1. **编辑已有间隔任务时，分钟数变成空白**（键名不对称导致数据丢失）；
2. **高级任务或 Agent 创建的 Cron 任务一旦被编辑，自动退化为手动任务**（缺少 Cron 草稿与表单分支）；
3. **编辑或创建时工作区路径被强行注入覆盖**（过度侵入的副作用导致用户无法创建无工作区绑定的全局任务）；
4. **启停开关响应迟钝、整面板假死，且存在并发竞态冲刷**（全局 busy 禁用所有组件，无乐观更新，多重刷新互抢）。

本方案的目标是：**彻底根除上述 4 大 Bug，全面补齐 5 字段 Cron 表达式编辑与目标会话选择能力，建立毫秒级响应的乐观更新与防竞态状态机，并严格对齐 `AGENTS.md` 的视觉与交互规范**。

---

## 二、现状痛点与真实根因深度分析

经过对前端相关源码的逐行排查，确认了导致体验缺陷的真实代码级根因：

### 2.1 `minutes` vs `intervalMinutes` 键名 Bug（编辑表单空白根因）

- **代码位置**：`apps/crish-desktop/src/components/settings/workflowsSharedLib.ts:93-95`

```typescript
// workflowsSharedLib.ts:93
} else if (sch.type === 'intervalMinutes') {
  d.scheduleType = 'intervalMinutes';
  d.intervalMinutes = String(sch.minutes ?? ''); // <--- 致命错误！
}
```

- **真实根因**：
  在 Rust 后端 `apps/agent-workbench/src-tauri/src/workflow_commands.rs:90-93` 中：
  ```rust
  IntervalMinutes {
      interval_minutes: u64,
  }
  ```
  因为 Rust 结构体声明了 `#[serde(rename_all = "camelCase")]`，序列化到前端的 JSON 键名为 **`intervalMinutes`**（如 `{ type: "intervalMinutes", intervalMinutes: 30 }`）。
  而前端 `workflowsSharedLib.ts` 的草稿回填函数 `draftFromWorkflow` 却去读取 `sch.minutes`！
  在 JavaScript 运行时中，`sch.minutes` 恒为 `undefined`，导致 `d.intervalMinutes` 被赋值为空字符串 `""`。
  用户在点击“编辑”已有间隔任务时，看到的“间隔（分钟）”输入框永远是空的；若直接点击保存，还会触发“请填写间隔分钟”校验失败，造成极其糟糕的挫败感。

### 2.2 Cron 降级为 manual Bug（高级调度抹除根因）

- **代码位置**：`apps/crish-desktop/src/components/settings/workflowsSharedLib.ts:87-101`、`apps/crish-desktop/src/api/workflow-api/workflowDraft.ts:18-29`

```typescript
// workflowsSharedLib.ts:87
const s = w.schedule;
if (s && typeof s === 'object') {
  const sch = s as { type?: string; time?: string; minutes?: number };
  if (sch.type === 'daily') {
    d.scheduleType = 'daily';
    d.dailyTime = sch.time || '';
  } else if (sch.type === 'intervalMinutes') {
    d.scheduleType = 'intervalMinutes';
    d.intervalMinutes = String(sch.minutes ?? '');
  } else {
    d.scheduleType = 'manual'; // <--- type === 'cron' 直接跌入 manual！
  }
}
```

```typescript
// workflowDraft.ts:18
export const WORKFLOW_SCHEDULE_TYPES = [
  { value: 'manual' as const, label: '手动', hint: '仅手动触发，不自动运行' },
  { value: 'daily' as const, label: '每天', hint: '每日固定时刻（本机时区）' },
  {
    value: 'intervalMinutes' as const,
    label: '间隔（分钟）',
    hint: '按分钟周期轮询执行',
  },
  // <--- 缺少 cron 类型！
];
```

- **真实根因**：
  在底层和 IPC 契约中，`WorkflowScheduleWire::Cron { expression }` 已经完备支持 5 字段 Cron 表达式（`parse_cron`），AI 助手的 `create_workflow` 工具也允许注册 Cron 任务。
  但是前端表单契约层（`workflowDraft.ts`）和回填层（`workflowsSharedLib.ts`）完全没有将 `cron` 纳入受支持的表单类型：
  1. `draftFromWorkflow` 遇到 `type: 'cron'`，直接强行降级为 `manual`；
  2. `WorkflowScheduleDraft` 缺少 `cronExpression` 字段；
  3. `validateWorkflowDraft` 没有 `cron` 校验分支；
  4. `buildScheduleFromDraft` 无法把表单草稿组装为 `{ type: 'cron', expression }`；
  5. `workflowsSharedLib.ts:75` 的 `matchesFilter` 中，`timed` 筛选条件只包含 `daily` 和 `intervalMinutes`，Cron 任务在按时间筛选时直接被过滤消失。

### 2.3 `cwd` 自动覆盖 Bug（强制绑定工作区）

- **代码位置**：`apps/crish-desktop/src/components/settings/WorkflowForm.tsx:267-274`

```typescript
React.useEffect(() => {
  if (!draft.cwd && projectOptions.length > 0) {
    const defaultPath = workspacePath || projectOptions[0]?.id || '';
    if (defaultPath) {
      onDraftChange({ ...draft, cwd: defaultPath });
    }
  }
}, [draft.cwd, projectOptions, workspacePath]);
```

- **真实根因**：
  在表单挂载或更新时，只要检测到 `!draft.cwd`，该 `useEffect` 就会主动触发一次 `onDraftChange`，强行把当前项目的物理绝对路径覆盖进去。
  这引发了双重缺陷：
  1. 用户如果希望创建或保存一个不依赖特定本地仓库的通用系统级任务（`cwd = undefined`），会被组件暴力覆盖；
  2. 编辑存量未指定 cwd 的任务时，表单自动把当前工作区写入草稿，导致原本设计为全局的任务在一次无意编辑后被锁死在当前项目中。

### 2.4 全局 `busy`、乐观更新缺失与双重刷新竞态

- **代码位置**：`apps/crish-desktop/src/components/settings/useWorkflowsState.ts:94`、`315-338`

```typescript
const [busy, setBusy] = useState(false);
// ...
const handleToggle = async (w: WorkflowDefinition) => {
  setBusy(true); // <--- 全局粗粒度锁
  setError('');
  const enabling = w.enabled === false;
  try {
    const res = await updateWorkflow(w.id, { enabled: enabling });
    // ...
    setOk(workflowEnabledLabel(enabling));
    await refresh(); // <--- 自身调用 refresh
  } catch (e) {
    // ...
  } finally {
    setBusy(false);
  }
};
```

- **真实根因**：
  1. **响应迟钝与全局禁用**：`busy` 是整个 hook 的单一全局状态。当用户点击某一行的 Switch 时，整个面板的所有按钮、输入框、其他任务的开关全部变成 `disabled`，用户无法连续操作，且视觉上产生 300–800ms 的明显假死感；
  2. **缺少乐观更新**：开关在点击后不会立刻翻转，必须等待网络 IPC 返回后再刷新更新，导致用户怀疑点击未生效而重复点击；
  3. **双重刷新竞态（Dual-Refresh Race）**：
     - 后端在 `update_workflow` 成功后会广播 `workflow:updated` 事件；
     - 前端 `listenWorkflowEvents` 监听到事件后会触发一次 `refresh()`；
     - 与此同时，`handleToggle` 在 `try` 块结尾也调用了 `await refresh()`；
     - 两个并发的 `listWorkflows()` IPC 在后台并发运行，若由于网络调度原因，旧的查询在新的查询之后到达，就会反向把旧状态涂抹到页面上，产生“明明点了暂停，开关闪了一下又弹回启用”的严重灵异现象！

---

## 三、架构设计与 UI/UX 规范深度对齐

本方案在前端重构中，严格对齐仓库根目录 `AGENTS.md` 的 UI/UX 与设计系统规范：

### 3.1 交互规范对齐清单（严格遵守 `AGENTS.md`）

| 规范章节          | 规范条款要求                                                                                                                                                                     | 现状排查与落地整改方案                                                                                                                                                                                                               |
| :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AGENTS.md §12** | **Tooltip / 悬停提示**：始终使用项目自定义 `<Tooltip>` 组件，**严禁使用原生 HTML `title` 作为主悬停提示**；保持圆角胶囊与柔和阴影。                                              | 全面审查 `WorkflowForm.tsx`、`WorkflowList.tsx` 及相关子组件，彻底清退所有原生 `title="..."` 属性，统一包裹 `<Tooltip content={...}>`，内容溢出时优雅提示。                                                                          |
| **AGENTS.md §13** | **输入框与焦点态**：**默认不要重阴影**（禁止厚重 `box-shadow`）；激活与聚焦时**禁止粗、深、实心黑边**；相对基线，灰色加深混入文本色**不超过约 10%**（优先 3%–6% 混入保持柔软）。 | 检查 `ScheduledTasksPanel.module.css` 和 `SettingsScheduleTab.module.css` 中的输入框焦点样式。确保 `.schedFieldInput:focus` 采用 `color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%)`，禁止实心黑外环与硬过渡动画。 |
| **AGENTS.md §14** | **色彩空间与现代 CSS**：避免散落旧式 `rgba(...)`，优先使用 `hsl(h s l / a)` 或 `hsla(...)` 斜杠语法；色彩对比度与暗色模式平滑适配。                                              | 规范所有动态边框与背景色，统一使用 Design Token 变量（如 `var(--border-subtle)`, `var(--text-tertiary)`, `var(--accent-orange)`），移除硬编码 rgb。                                                                                  |

### 3.2 状态流与防竞态架构（Optimistic & Deduplicated State Machine）

```
 [用户点击启停 Switch]
          │
          ▼
   1. 乐观更新 (Optimistic Mutation)
      - 立即就地更新 workflows 中目标条目的 enabled 状态 (0ms UI 响应)
      - 将该条目 ID 记录至 togglingIds 集合 (仅锁定单项，不阻塞全屏)
          │
          ├─────────────────────────────────────────┐
          ▼                                         ▼
   2. 发起 IPC updateWorkflow             3. 后端广播 workflow:updated
          │                                         │
     (异步执行中...)                           (全局事件接收)
          │                                         │
   ┌──────┴────────────────┐                        │
   ▼                       ▼                        ▼
[成功]                   [失败]            4. 防竞态刷新协调器 (Coordinator)
   │                       │                - 若本地处于乐观事务中，
更新返回最新实体         回滚 enabled 状态     使用后端返回的实体就地校准，
从 togglingIds 移除      Toast 报错           跳过全量 listWorkflows 刷新；
从 togglingIds 移除                           - 过滤过期请求序号，杜绝反向覆盖。
```

---

## 四、前端组件与表单改造蓝图

### 4.1 草稿契约层重构（`workflowDraft.ts`）

扩展调度类型定义，加入标准 5 字段 Cron 支持与目标会话选择：

```typescript
// apps/crish-desktop/src/api/workflow-api/workflowDraft.ts

export const WORKFLOW_SCHEDULE_TYPES = [
  { value: 'manual' as const, label: '手动', hint: '仅手动触发，不自动运行' },
  { value: 'daily' as const, label: '每天', hint: '每日固定时刻（本机时区）' },
  {
    value: 'intervalMinutes' as const,
    label: '间隔（分钟）',
    hint: '按分钟周期轮询执行',
  },
  {
    value: 'cron' as const,
    label: 'Cron 表达式',
    hint: '标准 5 字段 cron（分 时 日 月 周）',
  },
] as const;

export type WorkflowScheduleType =
  (typeof WORKFLOW_SCHEDULE_TYPES)[number]['value'];

/** 执行目标选择：当前对话 vs 独立新会话 */
export type WorkflowExecutionTarget = 'current_session' | 'isolated_session';

export type WorkflowScheduleDraft = {
  name: string;
  prompt: string;
  scheduleType: WorkflowScheduleType;
  dailyTime: string;
  intervalMinutes: string;
  cronExpression: string; // 新增：5 字段 cron 表达式
  cwd?: string;
  targetSessionId?: string; // 新增：目标绑定会话 ID
  executionTarget: WorkflowExecutionTarget; // 新增：执行目标模式
};

export function emptyWorkflowDraft(defaultCwd?: string): WorkflowScheduleDraft {
  return {
    name: '',
    prompt: '',
    scheduleType: 'manual',
    dailyTime: DEFAULT_DAILY_TIME,
    intervalMinutes: String(DEFAULT_INTERVAL_MINUTES),
    cronExpression: '0 9 * * *',
    cwd: defaultCwd ? defaultCwd.trim() : '',
    targetSessionId: undefined,
    executionTarget: 'isolated_session',
  };
}
```

### 4.2 校验与转换逻辑完善（`workflowDraft.ts`）

```typescript
export function validateWorkflowDraft(
  draft: WorkflowScheduleDraft | null | undefined
): string | null {
  if (!draft || typeof draft !== 'object') {
    return '请填写名称与提示词';
  }
  const name = String(draft.name ?? '').trim();
  const prompt = String(draft.prompt ?? '').trim();
  if (!name && !prompt) return '请填写名称与提示词';
  if (!name) return '请填写名称';
  if (!prompt) return '请填写提示词';

  const st = draft.scheduleType;
  if (st === 'daily') {
    const t = String(draft.dailyTime ?? '').trim();
    if (t && !tryNormalizeDailyTime(t)) {
      return '每日时刻须为 HH:mm（00:00–23:59）';
    }
    return null;
  }
  if (st === 'intervalMinutes') {
    const raw = String(draft.intervalMinutes ?? '').trim();
    if (!raw) return '请填写间隔分钟';
    if (parseIntervalMinutes(raw) == null) {
      return `间隔分钟须为 ${WORKFLOW_INTERVAL_MINUTES_MIN}–${WORKFLOW_INTERVAL_MINUTES_MAX} 的整数`;
    }
    return null;
  }
  if (st === 'cron') {
    const expr = String(draft.cronExpression ?? '').trim();
    if (!expr) return '请填写 cron 表达式';
    const validation = validateCronExpression(expr);
    if (!validation.ok) {
      return validation.error;
    }
    return null;
  }
  if (st === 'manual') return null;
  return '不支持的调度类型';
}

export function buildScheduleFromDraft(
  draft: WorkflowScheduleDraft
): WorkflowSchedule {
  if (!draft || typeof draft !== 'object') {
    return { type: 'manual' };
  }
  if (draft.scheduleType === 'daily') {
    return {
      type: 'daily',
      time: normalizeDailyTime(draft.dailyTime, DEFAULT_DAILY_TIME),
      timezone: defaultTimezone(),
    };
  }
  if (draft.scheduleType === 'intervalMinutes') {
    const n =
      parseIntervalMinutes(draft.intervalMinutes) ?? DEFAULT_INTERVAL_MINUTES;
    return { type: 'intervalMinutes', intervalMinutes: n };
  }
  if (draft.scheduleType === 'cron') {
    const expr = String(draft.cronExpression ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    return { type: 'cron', expression: expr || '0 9 * * *' };
  }
  return { type: 'manual' };
}
```

### 4.3 纯函数共享库修复（`workflowsSharedLib.ts`）

彻底修复键名 Bug、Cron 降级 Bug 和筛选 Bug：

```typescript
// apps/crish-desktop/src/components/settings/workflowsSharedLib.ts

export function matchesFilter(
  w: WorkflowDefinition,
  filter: ScheduleFilter
): boolean {
  const enabled = w.enabled !== false;
  const st = scheduleTypeOf(w);
  switch (filter) {
    case 'enabled':
      return enabled;
    case 'paused':
      return !enabled;
    case 'manual':
      return st === 'manual';
    case 'timed':
      // 修复：必须涵盖 cron！
      return st === 'daily' || st === 'intervalMinutes' || st === 'cron';
    default:
      return true;
  }
}

export function draftFromWorkflow(
  w: WorkflowDefinition
): WorkflowScheduleDraft {
  const d = emptyWorkflowDraft();
  d.name = w.name;
  d.prompt = w.prompt || '';
  d.cwd = w.cwd || '';
  d.targetSessionId = w.targetSessionId as string | undefined;
  d.executionTarget = d.targetSessionId
    ? 'current_session'
    : 'isolated_session';

  const s = w.schedule;
  if (s && typeof s === 'object') {
    const sch = s as {
      type?: string;
      time?: string;
      minutes?: number;
      intervalMinutes?: number;
      expression?: string;
    };
    if (sch.type === 'daily') {
      d.scheduleType = 'daily';
      d.dailyTime = sch.time || '';
    } else if (sch.type === 'intervalMinutes') {
      d.scheduleType = 'intervalMinutes';
      // 修复：优先取 intervalMinutes，兼顾旧版 minutes 回退
      const mins = sch.intervalMinutes ?? sch.minutes;
      d.intervalMinutes = mins !== undefined ? String(mins) : '';
    } else if (sch.type === 'cron') {
      // 修复：支持 cron 回填，杜绝被降级为 manual！
      d.scheduleType = 'cron';
      d.cronExpression = sch.expression || '';
    } else {
      d.scheduleType = 'manual';
    }
  } else {
    d.scheduleType = 'manual';
  }
  return d;
}
```

### 4.4 表单组件全面重构（`WorkflowForm.tsx`）

重点改造点：

1. **删除自动覆盖 cwd 的副作用**：移除盲目赋值的 `useEffect`，项目下拉框增加“全局（不限项目）”选项；
2. **新增 5 字段 Cron 表达式输入区域**：
   - 带有字段占位说明（`分 时 日 月 周`）；
   - 行内调用 `cronExpressionLabel(draft.cronExpression)` 实时显示人类可读转义标签；
3. **新增“执行目标”分段选择器**：
   - 选项 A：**独立新会话**（推荐，触发时生成独立对话卡片，不污染当前对话）；
   - 选项 B：**当前活跃对话**（自动绑定 `activeSessionId`，触发时将输出直接推入当前对话）；
4. **严格对齐 AGENTS.md 规范**：无重阴影，输入框柔和激活态。

```tsx
// apps/crish-desktop/src/components/settings/WorkflowForm.tsx 核心改造片段

// 1. Cron 输入区域组件
const cronField =
  draft.scheduleType === 'cron' ? (
    <div
      className={settingsVariant ? scheduleStyles.cronRow : styles.schedCronRow}
    >
      <label className={styles.schedField}>
        <span className={styles.schedFieldLabel}>
          Cron 表达式（分 时 日 月 周）
        </span>
        <Input
          size="sm"
          placeholder="例如：0 9 * * 1-5"
          value={draft.cronExpression}
          disabled={busy}
          onChange={(e) =>
            onDraftChange({ ...draft, cronExpression: e.target.value })
          }
          aria-label="Cron 表达式"
          autoComplete="off"
        />
      </label>
      <div
        className={styles.cronReadableBadge}
        role="status"
        aria-live="polite"
      >
        <span className={styles.cronReadablePrefix}>执行时机：</span>
        <span className={styles.cronReadableText}>
          {cronExpressionLabel(draft.cronExpression)}
        </span>
      </div>
    </div>
  ) : null;

// 2. 执行目标选择器
const executionTargetSelect = (
  <label className={styles.schedField}>
    <span className={styles.schedFieldLabel}>执行输出位置</span>
    <Select
      value={draft.executionTarget}
      disabled={busy}
      options={[
        {
          id: 'isolated_session',
          label: '独立新会话（推荐）',
          hint: '触发时自动创建专用会话',
        },
        {
          id: 'current_session',
          label: '当前活跃对话',
          hint: '输出直接追加至当前会话中',
        },
      ]}
      onChange={(v) => {
        const target = v as WorkflowExecutionTarget;
        onDraftChange({
          ...draft,
          executionTarget: target,
          targetSessionId:
            target === 'current_session' ? currentActiveSessionId : undefined,
        });
      }}
    />
  </label>
);

// 3. 项目选择器安全处理（包含全局选项，绝无静默自动覆盖）
const projectOptionsWithGlobal = React.useMemo(
  () => [
    { id: '', label: '全局 / 不限项目', hint: '在任何工作区均可执行' },
    ...projects.map((p) => ({ id: p.path, label: p.name, hint: p.path })),
  ],
  [projects]
);
```

### 4.5 共享状态 Hook 改造（`useWorkflowsState.ts`）

由粗粒度全局 `busy` 升级为**细粒度行级锁定 + 乐观更新（Optimistic Updates）**：

```typescript
// apps/crish-desktop/src/components/settings/useWorkflowsState.ts

// 单项操作锁替代全局阻塞
const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
const [isSaving, setIsSaving] = useState(false);
const [isDeleting, setIsDeleting] = useState(false);

const handleToggle = async (w: WorkflowDefinition) => {
  const targetId = w.id;
  if (togglingIds.has(targetId)) return; // 防重复连击

  const previousEnabled = w.enabled !== false;
  const nextEnabled = !previousEnabled;

  // 1. 立即乐观更新本地状态（0ms 交互延迟）
  setWorkflows((prev) =>
    prev.map((item) =>
      item.id === targetId ? { ...item, enabled: nextEnabled } : item
    )
  );
  setTogglingIds((prev) => new Set(prev).add(targetId));
  setError('');

  try {
    const res = await updateWorkflow(targetId, { enabled: nextEnabled });
    if (!res.ok) {
      // 2. 失败回滚
      setWorkflows((prev) =>
        prev.map((item) =>
          item.id === targetId ? { ...item, enabled: previousEnabled } : item
        )
      );
      fail(workflowActionErrorMessage(res.error, '更新状态失败'));
      return;
    }

    // 3. 成功后直接以服务端最新数据就地校准，不全量重刷造成闪烁
    if (res.workflow) {
      const updated = res.workflow;
      setWorkflows((prev) =>
        prev.map((item) => (item.id === targetId ? updated : item))
      );
      saveWorkflowsCache(workflows);
    }
    setOk(workflowEnabledLabel(nextEnabled));
  } catch (e) {
    // 网络异常回滚
    setWorkflows((prev) =>
      prev.map((item) =>
        item.id === targetId ? { ...item, enabled: previousEnabled } : item
      )
    );
    fail(networkUserMessage(e) || '更新状态失败');
  } finally {
    setTogglingIds((prev) => {
      const next = new Set(prev);
      next.delete(targetId);
      return next;
    });
  }
};
```

---

## 五、样式与设计系统微调蓝图

针对 `ScheduledTasksPanel.module.css` 和 `SettingsScheduleTab.module.css` 进行符合 `AGENTS.md` 的规范收敛：

1. **Cron 表达及可读徽标样式**：

```css
.schedCronRow {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.cronReadableBadge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background-color: var(--bg-secondary);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.cronReadableText {
  color: var(--text-primary);
  font-weight: var(--font-weight-medium);
}
```

2. **输入框焦点克制对比度守卫（严格落实 §13）**：

```css
.schedFieldInput:focus,
.schedFieldTextarea:focus {
  outline: none;
  /* 严格禁止实心纯黑厚边框，混合加深上限不超过 10% */
  border-color: color-mix(
    in srgb,
    var(--border-color) 92%,
    var(--text-primary) 8%
  );
  /* 严格禁止重 box-shadow */
  box-shadow: none;
}
```

---

## 六、测试用例设计与 Vitest 覆盖矩阵

本阶段需在 `apps/crish-desktop/` 下新增/更新以下自动化测试套件：

### 6.1 纯函数与草稿解析测试（`workflowsSharedLib.test.ts` & `workflowDraft.test.ts`）

| 用例编号     | 测试目标                                        | 关键断言                                                                                                                                               |
| :----------- | :---------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TC-UI-01** | `draftFromWorkflow` 修复 `intervalMinutes` 回填 | 传入 `{ schedule: { type: 'intervalMinutes', intervalMinutes: 45 } }`，断言 `draft.intervalMinutes === '45'`，绝对不是 `""`。                          |
| **TC-UI-02** | `draftFromWorkflow` 修复 `cron` 回填            | 传入 `{ schedule: { type: 'cron', expression: '*/15 * * * *' } }`，断言 `draft.scheduleType === 'cron'` 且 `draft.cronExpression === '*/15 * * * *'`。 |
| **TC-UI-03** | `matchesFilter` 修复 `timed` 筛选               | 对 `type: 'cron'` 的任务执行 `matchesFilter(w, 'timed')`，断言返回 `true`。                                                                            |
| **TC-UI-04** | `validateWorkflowDraft` 校验 5 字段 Cron        | 校验非法 6 字段（含秒）、非法越界数字返回中文错误；校验合法 `0 9 * * 1-5` 返回 `null`。                                                                |
| **TC-UI-05** | `buildScheduleFromDraft` 产出标准 Cron 载荷     | 草稿为 cron 时，输出标准 `{ type: 'cron', expression: '...' }`。                                                                                       |

### 6.2 组件渲染与用户交互测试（`WorkflowForm.test.tsx`）

| 用例编号     | 测试目标                                       | 关键断言                                                                                                     |
| :----------- | :--------------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| **TC-UI-06** | 切换到 Cron 调度时显示 Cron 输入与人类可读标签 | 选择下拉框中的“Cron 表达式”，渲染出 Cron 表达式输入框；填入 `0 9 * * *`，DOM 中渲染“每天 9 点 · 0 9 * * *”。 |
| **TC-UI-07** | 项目下拉框支持全局选项且不静默覆写             | 表单挂载时，若 `draft.cwd` 为空，DOM 渲染为“全局 / 不限项目”，且不会触发 `onDraftChange` 强行写入路径。      |
| **TC-UI-08** | 执行目标选择器切换联动                         | 选择“当前活跃对话”时，表单正确记录 `executionTarget: 'current_session'`。                                    |

### 6.3 状态管理与乐观更新测试（`useWorkflowsState.test.ts`）

| 用例编号     | 测试目标              | 关键断言                                                                                                            |
| :----------- | :-------------------- | :------------------------------------------------------------------------------------------------------------------ |
| **TC-UI-09** | 启停开关 0ms 乐观更新 | 调用 `handleToggle` 后，在 IPC 请求尚未 resolve 前，`workflows[0].enabled` 已立即翻转。                             |
| **TC-UI-10** | 启停失败状态自动回滚  | mock `updateWorkflow` 抛出错误或返回 `ok: false`，断言 `workflows[0].enabled` 恢复为原状态，并调用 Toast 提示错误。 |
| **TC-UI-11** | 防并发重复点击开关    | 对同一任务快速连续触发多次 `handleToggle`，断言仅发出一次 `updateWorkflow` IPC 调用。                               |

---

## 七、实施路线图与验收检查单

1. **Step 1：契约与共享库修补**
   - 修复 `workflowsSharedLib.ts`（`intervalMinutes` 键名、`cron` 分支、`timed` 筛选）；
   - 扩展 `workflowDraft.ts`（`cron` 类型与校验、目标会话字段）。
2. **Step 2：表单组件能力升级**
   - 升级 `WorkflowForm.tsx`，加入 Cron 输入框、可读翻译标签与执行目标选择；
   - 消除 `WorkflowForm.tsx` 中的 cwd 自动覆盖副作用；
   - 全面清理原生 `title`，对齐自定义 `<Tooltip>`。
3. **Step 3：共享状态 hook 乐观更新重构**
   - 改造 `useWorkflowsState.ts`，引入单条目锁定与即时乐观翻转；
   - 协调全局事件与本地状态，消除双重刷新竞争。
4. **Step 4：自动化门禁验证**
   - 运行前端单元测试：`npm test` 与 `npm run check:desktop` 确保全部绿灯通过。
