export type WorkbenchMode = "plan" | "execute" | "review" | "discuss";

export type WorkbenchRunState =
  | "idle"
  | "planning"
  | "running"
  | "waiting"
  | "blocked"
  | "done";

export type WorkbenchPlanState = "todo" | "doing" | "done" | "blocked";
export type WorkbenchEvidenceKind = "file" | "command" | "check" | "decision";
export type WorkbenchConfirmationKind = "write" | "danger" | "outside-project" | "credential" | "network";
export type WorkbenchBackgroundTaskKind = "command" | "service" | "check" | "scheduled";
export type WorkbenchBackgroundTaskState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed-out";
export type WorkbenchOutputReferenceKind = "image" | "markdown" | "text" | "code" | "directory" | "file" | "link" | "unknown";
export type WorkbenchOutputReferenceRender = "inline" | "sidebar" | "open";
export type WorkbenchOutputReferenceSource =
  | "markdown-image"
  | "markdown-link"
  | "workbench-tag"
  | "tool-artifact"
  | "final-summary";
export type WorkbenchDisclosureIssueKind =
  | "relative-path"
  | "missing-local-file"
  | "image-preview-failed"
  | "mojibake"
  | "command-failed"
  | "command-not-found"
  | "empty-output";
export type WorkbenchDisclosureIssueSeverity = "info" | "warning" | "error";

export interface WorkbenchProject {
  id: string;
  name: string;
  path: string;
  updatedAt: number;
}

export interface WorkbenchPlanItem {
  id: string;
  title: string;
  state: WorkbenchPlanState;
  note?: string;
  evidenceIds?: string[];
}

export interface WorkbenchAcceptanceItem {
  id: string;
  title: string;
  required: boolean;
  passed: boolean;
  evidenceIds: string[];
}

export interface WorkbenchEvidenceItem {
  id: string;
  kind: WorkbenchEvidenceKind;
  title: string;
  detail?: string;
  createdAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WorkbenchChangeItem {
  path: string;
  additions: number;
  deletions: number;
  state: "draft" | "checked" | "needs-review";
  checkpointId?: string;
}

export interface WorkbenchConfirmationRequest {
  id: string;
  kind: WorkbenchConfirmationKind;
  title: string;
  detail: string;
  primaryAction: string;
  secondaryAction: string;
}

export interface WorkbenchHealth {
  state: "good" | "busy" | "degraded";
  summary: string;
  memoryMb?: number;
  cpuPercent?: number;
  lastEventAt?: string;
  stalledForMs?: number;
}

export interface WorkbenchTokenBudgetSnapshot {
  enabled: boolean;
  difficulty: string;
  maxTotalTokens: number;
  usedTotalTokens: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requestCount: number;
  missingUsageMessages: number;
  warned: boolean;
  reached: boolean;
  updatedAt: string;
}

export interface WorkbenchLongRunPolicy {
  enabled: boolean;
  targetMinutes: number;
  reviewEveryMinutes: number;
  maxSilentMinutes: number;
  continuationPrompt: string;
}

export interface WorkbenchBackgroundTask {
  id: string;
  kind: WorkbenchBackgroundTaskKind;
  title: string;
  state: WorkbenchBackgroundTaskState;
  cwd?: string;
  command?: string;
  detail?: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  heartbeatAt?: string;
  heartbeatCount: number;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  summary?: string;
  outputPreview?: string;
  continuationPrompt?: string;
  evidenceIds?: string[];
}

export interface WorkbenchOutputReference {
  id: string;
  label: string;
  kind: WorkbenchOutputReferenceKind;
  render: WorkbenchOutputReferenceRender;
  source: WorkbenchOutputReferenceSource;
  path?: string;
  url?: string;
  mimeType?: string;
  previewable: boolean;
  editable: boolean;
  absolute: boolean;
  issues: string[];
  createdAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WorkbenchDisclosureIssue {
  id: string;
  kind: WorkbenchDisclosureIssueKind;
  severity: WorkbenchDisclosureIssueSeverity;
  title: string;
  detail: string;
  suggestion: string;
  targetId?: string;
  createdAt: string;
}

export interface WorkbenchDisclosureSuggestion {
  shouldInject: boolean;
  message: string;
  issues: WorkbenchDisclosureIssue[];
  createdAt: string;
}

export interface WorkbenchTaskSnapshot {
  id: string;
  project: WorkbenchProject;
  mode: WorkbenchMode;
  state: WorkbenchRunState;
  title: string;
  userGoal: string;
  progressLabel: string;
  completionPercent: number;
  plan: WorkbenchPlanItem[];
  acceptance: WorkbenchAcceptanceItem[];
  evidence: WorkbenchEvidenceItem[];
  changes: WorkbenchChangeItem[];
  confirmations: WorkbenchConfirmationRequest[];
  backgroundTasks: WorkbenchBackgroundTask[];
  outputReferences: WorkbenchOutputReference[];
  disclosureIssues: WorkbenchDisclosureIssue[];
  tokenBudget?: WorkbenchTokenBudgetSnapshot;
  nextActions: string[];
  health: WorkbenchHealth;
  longRun: WorkbenchLongRunPolicy;
}

export interface WorkbenchRuntimeStatus {
  ok: boolean;
  shell: "cli" | "tauri";
  cwd: string;
  message: string;
  capabilities: WorkbenchRuntimeCapability[];
}

export interface WorkbenchRuntimeCapability {
  id: string;
  title: string;
  ready: boolean;
}

export interface WorkbenchStartRequest {
  cwd: string;
  prompt: string;
  mode?: WorkbenchMode;
}

export interface WorkbenchContinuationDecision {
  action: "continue" | "pause" | "complete";
  reason: string;
  prompt?: string;
}

export type WorkbenchRunEventType =
  | "run-start"
  | "message-update"
  | "tool-update"
  | "plan-update"
  | "progress-update"
  | "change-update"
  | "approval-required"
  | "health-update"
  | "checkpoint-created"
  | "disclosure-suggestion"
  | "background-task-start"
  | "background-task-heartbeat"
  | "background-task-end"
  | "resume-requested"
  | "run-end"
  | "run-error";

export interface WorkbenchRunEvent {
  runId?: string;
  type: WorkbenchRunEventType;
  message: string;
  timestamp: string;
  payload?: unknown;
}

export function buildInitialTaskSnapshot(cwd: string, now = Date.now()): WorkbenchTaskSnapshot {
  const projectName = projectNameFromPath(cwd);
  return {
    id: "local-session",
    project: {
      id: "local-project",
      name: projectName,
      path: cwd,
      updatedAt: now
    },
    mode: "plan",
    state: "idle",
    title: "准备开始",
    userGoal: "选择项目后描述你要完成的目标。",
    progressLabel: "等待指令",
    completionPercent: 0,
    plan: createDefaultPlan(),
    acceptance: createDefaultAcceptance(),
    evidence: [],
    changes: [],
    confirmations: [],
    backgroundTasks: [],
    outputReferences: [],
    disclosureIssues: [],
    nextActions: ["输入目标", "选择项目", "进入计划模式"],
    health: {
      state: "good",
      summary: "底座空闲"
    },
    longRun: createDefaultLongRunPolicy()
  };
}

export function applyUserGoal(snapshot: WorkbenchTaskSnapshot, prompt: string): WorkbenchTaskSnapshot {
  const now = Date.now();
  return {
    ...snapshot,
    state: "planning",
    title: "正在整理计划",
    userGoal: prompt,
    progressLabel: "已收到目标，下一步会先确认范围和验收方式",
    completionPercent: Math.max(snapshot.completionPercent, 5),
    project: {
      ...snapshot.project,
      updatedAt: now
    },
    plan: snapshot.plan.map((item, index) =>
      index === 0
        ? {
            ...item,
            state: "doing",
            note: "正在确认目标、路径和风险"
          }
        : item
    ),
    nextActions: ["确认执行计划", "补充约束", "切换到执行模式"],
    health: {
      ...snapshot.health,
      state: "busy",
      summary: "正在规划"
    }
  };
}

export function calculateCompletion(snapshot: Pick<WorkbenchTaskSnapshot, "plan" | "acceptance">): number {
  const planScore =
    snapshot.plan.length === 0
      ? 0
      : snapshot.plan.filter((item) => item.state === "done").length / snapshot.plan.length;
  const requiredAcceptance = snapshot.acceptance.filter((item) => item.required);
  const acceptanceScore =
    requiredAcceptance.length === 0
      ? 0
      : requiredAcceptance.filter((item) => item.passed).length / requiredAcceptance.length;
  return Math.round((planScore * 0.45 + acceptanceScore * 0.55) * 100);
}

export function summarizeState(state: WorkbenchRunState): string {
  switch (state) {
    case "planning":
      return "正在规划";
    case "running":
      return "正在处理";
    case "waiting":
      return "等待确认";
    case "blocked":
      return "遇到阻碍";
    case "done":
      return "已完成";
    case "idle":
    default:
      return "空闲";
  }
}

export function summarizeMode(mode: WorkbenchMode): string {
  switch (mode) {
    case "execute":
      return "执行模式";
    case "review":
      return "审查模式";
    case "discuss":
      return "讨论模式";
    case "plan":
    default:
      return "计划模式";
  }
}

export function createRuntimeCapabilities(): WorkbenchRuntimeCapability[] {
  return [
    { id: "command", title: "命令执行", ready: true },
    { id: "filesystem", title: "文件读写", ready: true },
    { id: "checkpoint", title: "变更回退", ready: true },
    { id: "planning", title: "计划进度", ready: true },
    { id: "longrun", title: "长程续跑", ready: true },
    { id: "provider", title: "模型调用", ready: false }
  ];
}

export function createDefaultLongRunPolicy(): WorkbenchLongRunPolicy {
  return {
    enabled: true,
    targetMinutes: 15,
    reviewEveryMinutes: 5,
    maxSilentMinutes: 3,
    continuationPrompt: [
      "检查当前目标、已完成内容、未完成验收项和最近证据。",
      "如果目标尚未完成，先给出更细的下一步计划，再继续执行。",
      "不要扩大任务范围；需要用户判断时暂停并说明原因。"
    ].join("\n")
  };
}

function createDefaultPlan(): WorkbenchPlanItem[] {
  return [
    {
      id: "understand",
      title: "理解目标和项目边界",
      state: "todo"
    },
    {
      id: "inspect",
      title: "检查相关文件和现有实现",
      state: "todo"
    },
    {
      id: "execute",
      title: "按计划执行并持续更新进度",
      state: "todo"
    },
    {
      id: "verify",
      title: "运行检查并汇总结论",
      state: "todo"
    }
  ];
}

function createDefaultAcceptance(): WorkbenchAcceptanceItem[] {
  return [
    {
      id: "scope-clear",
      title: "目标范围已经确认",
      required: true,
      passed: false,
      evidenceIds: []
    },
    {
      id: "changes-tracked",
      title: "重要变更有记录并可回退",
      required: true,
      passed: false,
      evidenceIds: []
    },
    {
      id: "checks-run",
      title: "必要检查已经运行",
      required: true,
      passed: false,
      evidenceIds: []
    },
    {
      id: "result-reviewed",
      title: "结果经过最终审查",
      required: true,
      passed: false,
      evidenceIds: []
    }
  ];
}

function projectNameFromPath(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "当前项目";
}
