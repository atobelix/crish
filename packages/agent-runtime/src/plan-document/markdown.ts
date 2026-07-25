import type {
  PlanDocument,
  PlanAssumption,
  PlanQuestion,
  PlanStep,
  PlanAcceptanceCriterion,
  PlanRisk,
  PlanDocumentSource,
} from "./types";

export function planDocumentToMarkdown(document: PlanDocument): string {
  const lines: string[] = [
    `# ${document.title}`,
    "",
    `Status: ${document.status}`,
    `Version: ${document.version}`,
    `Updated: ${document.updatedAt}`,
    "",
    "## Goal",
    "",
    document.goal,
    "",
    "## Assumptions"
  ];

  appendAssumptionsMarkdown(lines, document.assumptions);
  lines.push("", "## Questions");
  appendQuestionsMarkdown(lines, document.questions);
  lines.push("", "## Steps");
  appendStepsMarkdown(lines, document.steps);
  lines.push("", "## Acceptance");
  appendAcceptanceMarkdown(lines, document.acceptance);
  lines.push("", "## Risks");
  appendRisksMarkdown(lines, document.risks);

  return `${lines.join("\n").trimEnd()}\n`;
}

function appendAssumptionsMarkdown(lines: string[], assumptions: PlanAssumption[]): void {
  if (assumptions.length === 0) {
    lines.push("", "None.");
    return;
  }
  for (const assumption of assumptions) {
    lines.push(`- [${assumption.status}] ${assumption.text} (${assumption.id})`);
    appendAnswerAndSource(lines, assumption.answer, assumption.source);
  }
}

function appendQuestionsMarkdown(lines: string[], questions: PlanQuestion[]): void {
  if (questions.length === 0) {
    lines.push("", "None.");
    return;
  }
  for (const question of questions) {
    lines.push(`- [${question.status}] ${question.question} (${question.id})`);
    appendAnswerAndSource(lines, question.answer, question.source);
  }
}

function appendStepsMarkdown(lines: string[], steps: PlanStep[]): void {
  if (steps.length === 0) {
    lines.push("", "None.");
    return;
  }
  steps.forEach((step, index) => {
    lines.push(`${index + 1}. [${step.status}] ${step.title} (${step.id})`);
    if (step.detail) lines.push(`   ${step.detail}`);
    if (step.dependencies.length > 0) lines.push(`   Dependencies: ${step.dependencies.join(", ")}`);
    if (step.evidenceIds.length > 0) lines.push(`   Evidence: ${step.evidenceIds.join(", ")}`);
    if (step.toolHints.length > 0) lines.push(`   Tool hints: ${step.toolHints.join(", ")}`);
  });
}

function appendAcceptanceMarkdown(lines: string[], acceptance: PlanAcceptanceCriterion[]): void {
  if (acceptance.length === 0) {
    lines.push("", "None.");
    return;
  }
  for (const criterion of acceptance) {
    lines.push(`- [${criterion.status}] ${criterion.text} (${criterion.id})`);
    if (criterion.evidenceIds.length > 0) lines.push(`  Evidence: ${criterion.evidenceIds.join(", ")}`);
    if (criterion.source) lines.push(`  Source: ${formatSource(criterion.source)}`);
  }
}

function appendRisksMarkdown(lines: string[], risks: PlanRisk[]): void {
  if (risks.length === 0) {
    lines.push("", "None.");
    return;
  }
  for (const risk of risks) {
    lines.push(`- [${risk.status}/${risk.severity}] ${risk.title} (${risk.id})`);
    if (risk.detail) lines.push(`  Detail: ${risk.detail}`);
    if (risk.mitigation) lines.push(`  Mitigation: ${risk.mitigation}`);
    if (risk.source) lines.push(`  Source: ${formatSource(risk.source)}`);
  }
}

function appendAnswerAndSource(lines: string[], answer: string | undefined, source: PlanDocumentSource | undefined): void {
  if (answer) lines.push(`  Answer: ${answer}`);
  if (source) lines.push(`  Source: ${formatSource(source)}`);
}

function formatSource(source: PlanDocumentSource): string {
  const details = [source.id, source.label, source.uri].filter((value): value is string => typeof value === "string" && value.length > 0);
  return details.length > 0 ? `${source.kind}:${details.join(":")}` : source.kind;
}
