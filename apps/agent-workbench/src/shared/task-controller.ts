import {
  calculateCompletion,
  type WorkbenchAcceptanceItem,
  type WorkbenchBackgroundTask,
  type WorkbenchContinuationDecision,
  type WorkbenchEvidenceItem,
  type WorkbenchHealth,
  type WorkbenchPlanItem,
  type WorkbenchTaskSnapshot
} from "./workbench-contract";

export interface WorkbenchTaskAssessment {
  completionPercent: number;
  canContinue: boolean;
  shouldPause: boolean;
  isComplete: boolean;
  auditIssues: string[];
  blockers: string[];
  missingAcceptance: WorkbenchAcceptanceItem[];
  acceptedWithoutEvidence: WorkbenchAcceptanceItem[];
  activePlanItems: WorkbenchPlanItem[];
  runningBackgroundTasks: WorkbenchBackgroundTask[];
  evidence: WorkbenchEvidenceItem[];
}

export interface WorkbenchHeartbeatInput {
  now: number | undefined;
  lastEventAt: string | undefined;
  memoryMb: number | undefined;
  cpuPercent: number | undefined;
}

export interface WorkbenchContinuationOptions {
  now?: number;
  reason?: string;
}

export function assessTask(snapshot: WorkbenchTaskSnapshot): WorkbenchTaskAssessment {
  const missingAcceptance = snapshot.acceptance.filter((item) => item.required && !item.passed);
  const evidenceIds = new Set(snapshot.evidence.map((item) => item.id));
  const acceptedWithoutEvidence = snapshot.acceptance.filter(
    (item) => item.required && item.passed && !item.evidenceIds.some((evidenceId) => evidenceIds.has(evidenceId))
  );
  const activePlanItems = snapshot.plan.filter((item) => item.state !== "done");
  const runningBackgroundTasks = snapshot.backgroundTasks.filter((item) => item.state === "queued" || item.state === "running");
  const blockedPlanItems = snapshot.plan.filter((item) => item.state === "blocked");
  const blockers = [
    ...snapshot.plan.filter((item) => item.state === "blocked").map((item) => item.title),
    ...runningBackgroundTasks.map((item) => `等待处理完成：${item.title}`),
    ...snapshot.confirmations.map((item) => item.title)
  ];
  const auditIssues = [
    ...missingAcceptance.map((item) => `未完成验收：${item.title}`),
    ...acceptedWithoutEvidence.map((item) => `缺少证据：${item.title}`),
    ...activePlanItems.map((item) => `计划未完成：${item.title}`),
    ...blockers.map((item) => `存在阻塞：${item}`)
  ];
  const isComplete = snapshot.state === "done" && auditIssues.length === 0;
  const shouldPause =
    snapshot.state === "waiting" ||
    blockedPlanItems.length > 0 ||
    snapshot.confirmations.length > 0 ||
    runningBackgroundTasks.length > 0;

  return {
    completionPercent: calculateCompletion(snapshot),
    canContinue: !isComplete && !shouldPause,
    shouldPause,
    isComplete,
    auditIssues,
    blockers,
    missingAcceptance,
    acceptedWithoutEvidence,
    activePlanItems,
    runningBackgroundTasks,
    evidence: snapshot.evidence
  };
}

export function updateTaskHealth(snapshot: WorkbenchTaskSnapshot, input: WorkbenchHeartbeatInput): WorkbenchTaskSnapshot {
  const now = input.now ?? Date.now();
  const lastEventAt = input.lastEventAt ?? snapshot.health.lastEventAt;
  const stalledForMs = lastEventAt ? Math.max(0, now - Date.parse(lastEventAt)) : snapshot.health.stalledForMs;
  const maxSilentMs = snapshot.longRun.maxSilentMinutes * 60_000;
  const overloaded =
    (input.memoryMb !== undefined && input.memoryMb >= 3_000) ||
    (input.cpuPercent !== undefined && input.cpuPercent >= 90);
  const stalled = stalledForMs !== undefined && stalledForMs >= maxSilentMs;

  const health: WorkbenchHealth = {
    state: overloaded || stalled ? "degraded" : snapshot.state === "running" || snapshot.state === "planning" ? "busy" : "good",
    summary: healthSummary({ overloaded, stalled, running: snapshot.state === "running" || snapshot.state === "planning" }),
    memoryMb: input.memoryMb ?? snapshot.health.memoryMb,
    cpuPercent: input.cpuPercent ?? snapshot.health.cpuPercent,
    lastEventAt,
    stalledForMs
  } as WorkbenchHealth;

  return {
    ...snapshot,
    health
  };
}

export function createContinuationDecision(
  snapshot: WorkbenchTaskSnapshot,
  options: WorkbenchContinuationOptions = {}
): WorkbenchContinuationDecision {
  const assessment = assessTask(snapshot);
  if (assessment.isComplete) {
    return {
      action: "complete",
      reason: "必需验收项已经完成，且没有等待确认或阻塞项。"
    };
  }

  if (assessment.shouldPause) {
    return {
      action: "pause",
      reason: assessment.blockers.length > 0 ? `需要先处理：${assessment.blockers.join("、")}` : "当前需要用户判断后才能继续。"
    };
  }

  return {
    action: "continue",
    reason: options.reason ?? "仍有未完成的计划或验收项。",
    prompt: buildContinuationPrompt(snapshot, assessment)
  };
}

export function buildContinuationPrompt(
  snapshot: WorkbenchTaskSnapshot,
  assessment: WorkbenchTaskAssessment = assessTask(snapshot)
): string {
  return [
    snapshot.longRun.continuationPrompt,
    "",
    "当前目标：",
    snapshot.userGoal,
    "",
    "当前完成度：",
    `${assessment.completionPercent}%`,
    "",
    "未完成验收项：",
    ...listOrFallback(assessment.missingAcceptance.map((item) => `- ${item.title}`), "- 没有未完成的必需验收项"),
    "",
    "审计问题：",
    ...listOrFallback(assessment.auditIssues.map((item) => `- ${item}`), "- 暂无审计问题"),
    "",
    "未完成计划：",
    ...listOrFallback(
      assessment.activePlanItems.map((item) => `- ${item.title}${item.note ? `：${item.note}` : ""}`),
      "- 没有未完成计划"
    ),
    "",
    "最近证据：",
    ...listOrFallback(
      assessment.evidence.slice(-6).map((item) => `- ${item.title}${item.detail ? `：${item.detail}` : ""}`),
      "- 暂无证据"
    ),
    "",
    "继续要求：",
    "- 先检查未完成验收项，再选择下一步。",
    "- 不要扩大任务范围。",
    "- 如果缺少证据，优先运行检查或读取相关文件。",
    "- 如果需要用户判断，暂停并说明原因。"
  ].join("\n");
}

function healthSummary(input: { overloaded: boolean; stalled: boolean; running: boolean }): string {
  if (input.overloaded && input.stalled) return "资源占用偏高，且长时间没有新进展";
  if (input.overloaded) return "资源占用偏高";
  if (input.stalled) return "长时间没有新进展";
  if (input.running) return "正在处理";
  return "底座空闲";
}

function listOrFallback(items: string[], fallback: string): string[] {
  return items.length > 0 ? items : [fallback];
}
