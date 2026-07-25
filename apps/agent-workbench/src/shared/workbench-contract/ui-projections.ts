import { isWorkbenchRecord, firstStringValue } from "./guards";
import type {
  WorkbenchMode,
  WorkbenchRunState,
  WorkbenchRunLifecycleStatus,
  WorkbenchPlanItem,
  WorkbenchAcceptanceItem,
  WorkbenchTaskSnapshot,
  WorkbenchLongRunPolicy,
  WorkbenchRuntimeCapability,
} from "./workbench-ui";

function projectNameFromPath(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "当前项目";
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

export function workbenchRunLifecycleStatusFromDaemon(value: unknown): WorkbenchRunLifecycleStatus | null {
  const record = isWorkbenchRecord(value) ? value : undefined;
  const payload = isWorkbenchRecord(record?.payload) ? record.payload : undefined;
  const run = isWorkbenchRecord(record?.run)
    ? record.run
    : isWorkbenchRecord(payload?.run)
      ? payload.run
      : undefined;
  const eventType = firstStringValue(record?.type, payload?.type);
  const status = firstStringValue(record?.status, payload?.status, run?.status);
  const outcome = firstStringValue(record?.outcome, payload?.outcome, run?.outcome);
  const reason = firstStringValue(record?.reason, payload?.reason, run?.reason);

  if (eventType === "run-cancelled" || status === "cancelled" || outcome === "cancelled" || isCancelledReason(reason)) {
    return "cancelled";
  }
  if (eventType === "run-failed" || status === "failed" || outcome === "failed" || outcome === "blocked" || isFailedReason(reason)) {
    return "failed";
  }
  if (eventType === "run-completed" || status === "completed" || outcome === "completed" || isCompletedReason(reason)) {
    return "completed";
  }
  if (isActiveDaemonStatus(status)) {
    return "running";
  }
  return null;
}

function isActiveDaemonStatus(status: string | undefined): boolean {
  return status === "queued" || status === "running" || status === "awaiting-approval" || status === "cancelling";
}

function isCompletedReason(reason: string | undefined): boolean {
  return reason === "completed" || reason === "goal-completed";
}

function isCancelledReason(reason: string | undefined): boolean {
  return reason === "cancelled" || reason === "aborted";
}

function isFailedReason(reason: string | undefined): boolean {
  return (
    reason === "goal-blocked" ||
    reason === "goal-max-rounds" ||
    reason === "goal-stalled" ||
    reason === "max-turns" ||
    reason === "agent-error" ||
    reason === "provider-error" ||
    reason === "runtime-error" ||
    reason === "intervention-required" ||
    reason === "run-engine-error"
  );
}
