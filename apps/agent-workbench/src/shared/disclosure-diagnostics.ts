import type {
  WorkbenchDisclosureIssue,
  WorkbenchDisclosureIssueKind,
  WorkbenchDisclosureIssueSeverity,
  WorkbenchDisclosureSuggestion,
  WorkbenchOutputReference,
  WorkbenchTaskSnapshot
} from "./workbench-contract";
import { extractOutputReferencesFromMarkdown } from "./output-references";

export interface WorkbenchCommandDiagnosticInput {
  id?: string;
  command: string;
  exitCode?: number | null;
  output?: string;
  error?: string;
}

export interface WorkbenchRenderedReferenceStatus {
  referenceId: string;
  ok: boolean;
  reason?: string;
}

export interface WorkbenchDisclosureAnalysisInput {
  references?: WorkbenchOutputReference[];
  commandResults?: WorkbenchCommandDiagnosticInput[];
  renderedReferences?: WorkbenchRenderedReferenceStatus[];
  fileExists?: ((path: string) => Promise<boolean> | boolean);
  now?: string;
  maxIssues?: number;
}

export async function analyzeDisclosureIssues(
  input: WorkbenchDisclosureAnalysisInput
): Promise<WorkbenchDisclosureSuggestion> {
  const now = input.now ?? new Date().toISOString();
  const issues: WorkbenchDisclosureIssue[] = [];

  for (const reference of input.references ?? []) {
    issues.push(...(await diagnoseReference(reference, input, now)));
  }
  for (const command of input.commandResults ?? []) {
    issues.push(...diagnoseCommand(command, now));
  }
  for (const rendered of input.renderedReferences ?? []) {
    if (!rendered.ok) {
      const reference = input.references?.find((item) => item.id === rendered.referenceId);
      issues.push(
        createIssue({
          kind: "image-preview-failed",
          severity: "warning",
          title: "图片预览没有正常显示",
          detail: rendered.reason ?? "界面没有成功渲染这个资源。",
          suggestion: reference?.path
            ? "请确认图片文件真实存在，并在回复里使用可访问的绝对路径。"
            : "请确认图片链接可访问，或者改用本地绝对路径引用图片。",
          targetId: rendered.referenceId,
          now
        })
      );
    }
  }

  const deduped = dedupeIssues(issues).slice(0, input.maxIssues ?? 6);
  return {
    shouldInject: deduped.length > 0,
    message: buildDisclosureMessage(deduped),
    issues: deduped,
    createdAt: now
  };
}

export interface WorkbenchDisclosureSnapshotInput extends WorkbenchDisclosureAnalysisInput {
  assistantMarkdown?: string;
}

export interface WorkbenchDisclosureSnapshotResult {
  snapshot: WorkbenchTaskSnapshot;
  suggestion: WorkbenchDisclosureSuggestion;
}

export async function applyDisclosureDiagnosticsToSnapshot(
  snapshot: WorkbenchTaskSnapshot,
  input: WorkbenchDisclosureSnapshotInput
): Promise<WorkbenchDisclosureSnapshotResult> {
  const now = input.now ?? new Date().toISOString();
  const parsedReferences = input.assistantMarkdown
    ? extractOutputReferencesFromMarkdown(input.assistantMarkdown, { now })
    : [];
  const references = mergeOutputReferences(snapshot.outputReferences, input.references ?? [], parsedReferences);
  const suggestion = await analyzeDisclosureIssues({
    ...input,
    references,
    now
  });

  return {
    snapshot: {
      ...snapshot,
      outputReferences: references,
      disclosureIssues: mergeDisclosureIssues(snapshot.disclosureIssues, suggestion.issues)
    },
    suggestion
  };
}

function buildDisclosureMessage(issues: WorkbenchDisclosureIssue[]): string {
  if (issues.length === 0) return "";
  return [
    "运行时发现一些可修正的问题，请先按这些提示调整后再继续：",
    ...issues.map((issue) => `- ${issue.suggestion}`)
  ].join("\n");
}

async function diagnoseReference(
  reference: WorkbenchOutputReference,
  input: WorkbenchDisclosureAnalysisInput,
  now: string
): Promise<WorkbenchDisclosureIssue[]> {
  const issues: WorkbenchDisclosureIssue[] = [];
  if (!reference.absolute && reference.kind !== "link") {
    issues.push(
      createIssue({
        kind: "relative-path",
        severity: reference.kind === "image" ? "warning" : "info",
        title: "引用路径不是绝对路径",
        detail: `${reference.label} 使用了相对路径，桌面端可能无法定位。`,
        suggestion: `请把 ${reference.label} 改成可访问的绝对路径。`,
        targetId: reference.id,
        now
      })
    );
  }

  if (reference.path && reference.absolute && input.fileExists) {
    const exists = await input.fileExists(reference.path);
    if (!exists) {
      issues.push(
        createIssue({
          kind: "missing-local-file",
          severity: reference.kind === "image" ? "error" : "warning",
          title: "引用文件不存在",
          detail: `${reference.label} 指向的文件不存在：${reference.path}`,
          suggestion:
            reference.kind === "image"
              ? "请先生成图片文件，再用真实存在的绝对路径引用它。"
              : "请确认文件已经创建成功，再把真实存在的绝对路径返回给用户。",
          targetId: reference.id,
          now
        })
      );
    }
  }

  if (looksLikeMojibake(reference.label)) {
    issues.push(
      createIssue({
        kind: "mojibake",
        severity: "warning",
        title: "引用标题疑似乱码",
        detail: `${reference.label} 看起来像编码错误后的文本。`,
        suggestion: "请重新读取原始文件或命令输出，确认中文编码后再继续。",
        targetId: reference.id,
        now
      })
    );
  }

  return issues;
}

function diagnoseCommand(command: WorkbenchCommandDiagnosticInput, now: string): WorkbenchDisclosureIssue[] {
  const text = [command.output, command.error].filter(Boolean).join("\n");
  const issues: WorkbenchDisclosureIssue[] = [];
  if (command.exitCode !== undefined && command.exitCode !== null && command.exitCode !== 0) {
    const notFound = isCommandNotFound(text);
    issues.push(
      createIssue({
        kind: notFound ? "command-not-found" : "command-failed",
        severity: notFound ? "warning" : "error",
        title: notFound ? "命令没有找到" : "命令执行失败",
        detail: `${command.command} 返回退出码 ${command.exitCode}。`,
        suggestion: notFound
          ? `请检查命令是否拼写正确，或先确认当前环境是否已经安装：${firstCommandWord(command.command)}。`
          : "请先阅读错误输出，调整参数或执行路径后再继续，不要重复同一个失败命令。",
        ...(command.id !== undefined ? { targetId: command.id } : {}),
        now
      })
    );
  }

  if (looksLikeMojibake(text)) {
    issues.push(
      createIssue({
        kind: "mojibake",
        severity: "warning",
        title: "命令输出疑似乱码",
        detail: "命令输出里出现了常见乱码特征。",
        suggestion: "请使用 UTF-8 输出设置重新运行或用安全读取工具确认原始字节，不要直接依据乱码内容判断结果。",
        ...(command.id !== undefined ? { targetId: command.id } : {}),
        now
      })
    );
  }

  if ((command.exitCode === 0 || command.exitCode === undefined) && text.trim().length === 0) {
    issues.push(
      createIssue({
        kind: "empty-output",
        severity: "info",
        title: "命令没有可见输出",
        detail: `${command.command} 没有产生可见输出。`,
        suggestion: "如果这个命令本应生成文件，请再检查目标文件是否真实存在。",
        ...(command.id !== undefined ? { targetId: command.id } : {}),
        now
      })
    );
  }

  return issues;
}

function createIssue(input: {
  kind: WorkbenchDisclosureIssueKind;
  severity: WorkbenchDisclosureIssueSeverity;
  title: string;
  detail: string;
  suggestion: string;
  targetId?: string;
  now: string;
}): WorkbenchDisclosureIssue {
  return {
    id: createIssueId(input.kind, input.targetId ?? input.detail),
    kind: input.kind,
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    suggestion: input.suggestion,
    ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
    createdAt: input.now
  };
}

function dedupeIssues(issues: WorkbenchDisclosureIssue[]): WorkbenchDisclosureIssue[] {
  const map = new Map<string, WorkbenchDisclosureIssue>();
  for (const issue of issues) {
    const key = `${issue.kind}:${issue.targetId ?? issue.detail}`;
    if (!map.has(key)) map.set(key, issue);
  }
  return [...map.values()];
}

function mergeOutputReferences(
  ...groups: WorkbenchOutputReference[][]
): WorkbenchOutputReference[] {
  const map = new Map<string, WorkbenchOutputReference>();
  for (const reference of groups.flat()) {
    const key = `${reference.path ?? reference.url ?? reference.id}:${reference.kind}`;
    const existing = map.get(key);
    if (!existing || reference.source === "workbench-tag" || (existing.render !== "inline" && reference.render === "inline")) {
      map.set(key, reference);
    }
  }
  return [...map.values()];
}

function mergeDisclosureIssues(
  existing: WorkbenchDisclosureIssue[],
  incoming: WorkbenchDisclosureIssue[]
): WorkbenchDisclosureIssue[] {
  const map = new Map<string, WorkbenchDisclosureIssue>();
  for (const issue of [...existing, ...incoming]) {
    map.set(issue.id, issue);
  }
  return [...map.values()].slice(-20);
}

function isCommandNotFound(text: string): boolean {
  return /not recognized|command not found|not found|无法将|不是内部或外部命令|找不到命令|未找到命令/i.test(text);
}

function looksLikeMojibake(text: string): boolean {
  if (!text) return false;
  return MOJIBAKE_PATTERN.test(text);
}

const MOJIBAKE_PATTERN = new RegExp(
  [
    "\\u00C3.",
    "\\u00C2.",
    "\\u00E2\\u20AC",
    "\\u00E2\\u20AC\\u2122",
    "\\u951B",
    "\\u6D93",
    "\\u93C2",
    "\\u7ECB",
    "\\u7039",
    "\\uFFFD{2,}"
  ].join("|")
);

function firstCommandWord(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? command;
}

function createIssueId(kind: string, seed: string): string {
  const normalized = seed.replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `issue-${kind}-${normalized || "item"}`;
}
