import {
  calculateCompletion,
  type WorkbenchAcceptanceItem,
  type WorkbenchBackgroundTask,
  type WorkbenchContinuationDecision,
  type WorkbenchEvidenceItem,
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

function listOrFallback(items: string[], fallback: string): string[] {
  return items.length > 0 ? items : [fallback];
}
