import {
  calculateCompletion,
  type WorkbenchAcceptanceItem,
  type WorkbenchEvidenceItem,
  type WorkbenchPlanItem,
  type WorkbenchTaskSnapshot
} from "./workbench-contract";

export type RuntimeEvidenceSignal = "scope" | "inspect" | "execute" | "check" | "review" | "change-tracked" | "no-change";

export interface RuntimeEvidenceInferenceInput {
  signals: RuntimeEvidenceSignal[];
  evidence?: WorkbenchEvidenceItem;
  evidenceIds?: string[];
}

export function applyRuntimeEvidenceInference(
  snapshot: WorkbenchTaskSnapshot,
  input: RuntimeEvidenceInferenceInput
): WorkbenchTaskSnapshot {
  if (input.signals.length === 0 && !input.evidence) return snapshot;

  const signalSet = new Set(input.signals);
  const withEvidence = input.evidence ? ensureEvidence(snapshot, input.evidence) : snapshot;
  const evidenceIds = [...new Set([...(input.evidenceIds ?? []), ...(input.evidence ? [input.evidence.id] : [])])];
  const acceptance = withEvidence.acceptance.map((item) =>
    updateAcceptanceItem(item, signalSet, evidenceIds, withEvidence.acceptance)
  );
  const accepted = (id: string): boolean => acceptance.some((item) => item.id === id && item.passed);
  const plan = withEvidence.plan.map((item) => updatePlanItem(item, signalSet, accepted));

  return {
    ...withEvidence,
    plan,
    acceptance,
    completionPercent: calculateCompletion({ plan, acceptance })
  };
}

export function applyRunEndEvidenceInference(snapshot: WorkbenchTaskSnapshot): WorkbenchTaskSnapshot {
  if (snapshot.changes.length > 0 || acceptancePassed(snapshot.acceptance, "changes-tracked")) return snapshot;
  return applyRuntimeEvidenceInference(snapshot, {
    signals: ["no-change"],
    evidence: {
      id: "evidence-no-file-changes",
      kind: "decision",
      title: "本轮没有产生文件变更",
      detail: "当前轮次没有记录需要回退的文件修改",
      createdAt: new Date().toISOString()
    }
  });
}

export function isCompletionReady(snapshot: WorkbenchTaskSnapshot): boolean {
  const evidenceIds = new Set(snapshot.evidence.map((item) => item.id));
  const requiredAcceptanceReady = snapshot.acceptance
    .filter((item) => item.required)
    .every((item) => item.passed && item.evidenceIds.some((evidenceId) => evidenceIds.has(evidenceId)));
  return (
    snapshot.plan.every((item) => item.state === "done") &&
    requiredAcceptanceReady &&
    snapshot.confirmations.length === 0 &&
    !snapshot.backgroundTasks.some((item) => item.state === "queued" || item.state === "running")
  );
}

export function isReadOnlyInspectionTask(snapshot: Pick<WorkbenchTaskSnapshot, "mode" | "userGoal" | "changes">): boolean {
  if (snapshot.changes.length > 0) return false;
  const normalized = snapshot.userGoal.trim().toLowerCase();
  if (!normalized) return snapshot.mode === "review" || snapshot.mode === "discuss";
  if (READ_ONLY_EXPLICIT_ALLOWLIST.some((pattern) => pattern.test(normalized))) return true;
  if (READ_ONLY_BLOCKLIST.some((pattern) => pattern.test(normalized))) return false;
  if (snapshot.mode === "review" || snapshot.mode === "discuss") return true;
  return READ_ONLY_ALLOWLIST.some((pattern) => pattern.test(normalized));
}

export function isVerificationCommandText(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return VERIFICATION_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

function updateAcceptanceItem(
  item: WorkbenchAcceptanceItem,
  signals: ReadonlySet<RuntimeEvidenceSignal>,
  evidenceIds: string[],
  currentAcceptance: WorkbenchAcceptanceItem[]
): WorkbenchAcceptanceItem {
  if (item.id === "scope-clear" && signals.has("scope")) {
    return passAcceptance(item, evidenceIds);
  }
  if (item.id === "changes-tracked" && (signals.has("change-tracked") || signals.has("no-change"))) {
    return passAcceptance(item, evidenceIds);
  }
  if (item.id === "checks-run" && signals.has("check")) {
    return passAcceptance(item, evidenceIds);
  }
  if (item.id === "result-reviewed" && signals.has("review") && (acceptancePassed(currentAcceptance, "checks-run") || signals.has("check"))) {
    return passAcceptance(item, evidenceIds);
  }
  return item;
}

function updatePlanItem(
  item: WorkbenchPlanItem,
  signals: ReadonlySet<RuntimeEvidenceSignal>,
  accepted: (id: string) => boolean
): WorkbenchPlanItem {
  if (item.id === "understand" && signals.has("scope")) {
    return markPlanDone(item, "系统已收到用户目标和项目路径");
  }
  if (item.id === "inspect" && signals.has("inspect")) {
    return markPlanDone(item, "已读取或检索项目内容");
  }
  if (item.id === "execute" && (signals.has("execute") || signals.has("change-tracked"))) {
    return markPlanDone(item, "已有执行证据");
  }
  if (item.id === "execute" && accepted("checks-run") && accepted("result-reviewed")) {
    return markPlanDone(item, "\u5df2\u6709\u5b8c\u6210\u8bc1\u636e");
  }
  if (item.id === "verify" && accepted("checks-run") && accepted("result-reviewed")) {
    return markPlanDone(item, "已有检查和最终说明证据");
  }
  return item;
}

function passAcceptance(item: WorkbenchAcceptanceItem, evidenceIds: string[]): WorkbenchAcceptanceItem {
  const nextEvidenceIds = [...new Set([...item.evidenceIds, ...evidenceIds])];
  if (item.passed && nextEvidenceIds.length === item.evidenceIds.length) return item;
  return {
    ...item,
    passed: item.passed || nextEvidenceIds.length > 0,
    evidenceIds: nextEvidenceIds
  };
}

function markPlanDone(item: WorkbenchPlanItem, note: string): WorkbenchPlanItem {
  if (item.state === "done" && item.note === note) return item;
  return {
    ...item,
    state: "done",
    note
  };
}

function ensureEvidence(snapshot: WorkbenchTaskSnapshot, evidence: WorkbenchEvidenceItem): WorkbenchTaskSnapshot {
  if (snapshot.evidence.some((item) => item.id === evidence.id)) return snapshot;
  return {
    ...snapshot,
    evidence: [...snapshot.evidence, evidence].slice(-80)
  };
}

function acceptancePassed(items: WorkbenchAcceptanceItem[], id: string): boolean {
  return items.some((item) => item.id === id && item.passed);
}

const VERIFICATION_COMMAND_PATTERNS = [
  /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|lint|typecheck|type-check|build|check))\b/,
  /\bnpx\s+(?:tsc|vitest|jest|eslint|playwright)\b/,
  /\b(?:vitest|jest|pytest|ruff|eslint|tsc)\b/,
  /\bpython(?:3)?\s+-m\s+(?:pytest|py_compile|ruff|mypy)\b/,
  /\bcargo\s+(?:test|check|clippy|build)\b/,
  /\bgo\s+test\b/,
  /\b(?:dotnet\s+test|mvn\s+test|gradle\s+test)\b/,
  /\bnode\s+--check\b/
];

const READ_ONLY_ALLOWLIST = [
  /查看/,
  /读取/,
  /检查/,
  /分析/,
  /审查/,
  /评审/,
  /梳理/,
  /状态/,
  /\bread[\s-]?only\b/,
  /\bdo not (?:modify|write|change|edit)\b/,
  /\binspect\b/,
  /\banaly[sz]e\b/,
  /\breview\b/,
  /\bstatus\b/
];

const READ_ONLY_EXPLICIT_ALLOWLIST = [
  /不修改/,
  /不写入/,
  /不改变/,
  /只读/,
  /仅查看/,
  /仅检查/,
  /\bread[\s-]?only\b/,
  /\bdo not (?:modify|write|change|edit)\b/
];

const READ_ONLY_BLOCKLIST = [
  /修改/,
  /修复/,
  /实现/,
  /新增/,
  /添加/,
  /删除/,
  /写入/,
  /编辑/,
  /改造/,
  /迁移/,
  /生成/,
  /创建/,
  /落地/,
  /\bfix\b/,
  /\bchange\b/,
  /\bmodify\b/,
  /\bwrite\b/,
  /\bedit\b/,
  /\bimplement\b/,
  /\bcreate\b/,
  /\badd\b/,
  /\bdelete\b/,
  /\bremove\b/,
  /\bgenerate\b/
];
