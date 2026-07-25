import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { WorkbenchRunEvent, WorkbenchTaskSnapshot } from "../shared/workbench-contract";

export type WorkbenchRunRecordStatus = "running" | "complete" | "paused" | "blocked" | "error" | "stalled" | "max-rounds";

export interface WorkbenchRunRecord {
  id: string;
  branchId: string;
  parentRunId: string | undefined;
  parentBranchId: string | undefined;
  command: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: WorkbenchRunRecordStatus;
  providerId: string | undefined;
  modelId: string | undefined;
  sessionPath: string | undefined;
  eventLogPath: string | undefined;
  promptFile: string | undefined;
  configPath: string | undefined;
  outputRoot: string | undefined;
  userGoalPreview: string | undefined;
  snapshotId: string | undefined;
  completionPercent: number | undefined;
  lastEventAt: string | undefined;
  lastEventType: string | undefined;
  lastMessage: string | undefined;
  stoppedReason: string | undefined;
}

export interface WorkbenchRunRegistry {
  version: 1;
  updatedAt: string;
  records: WorkbenchRunRecord[];
}

export interface StartRunRecordInput {
  id: string | undefined;
  branchId: string | undefined;
  parentRunId: string | undefined;
  parentBranchId: string | undefined;
  command: string;
  cwd: string;
  providerId: string | undefined;
  modelId: string | undefined;
  sessionPath: string | undefined;
  eventLogPath: string | undefined;
  promptFile: string | undefined;
  configPath: string | undefined;
  outputRoot: string | undefined;
  userGoal: string | undefined;
}

export type UpdateRunRecordInput = Partial<
  Pick<
    WorkbenchRunRecord,
    | "status"
    | "sessionPath"
    | "eventLogPath"
    | "promptFile"
    | "configPath"
    | "outputRoot"
    | "snapshotId"
    | "completionPercent"
    | "lastEventAt"
    | "lastEventType"
    | "lastMessage"
    | "stoppedReason"
  >
>;

export interface LatestRunFilter {
  cwd: string | undefined;
  status: WorkbenchRunRecordStatus | undefined;
  branchId: string | undefined;
}

const REGISTRY_VERSION = 1;
const MAX_RECORDS = 200;

export function defaultRunRegistryPath(cwd: string): string {
  return resolve(cwd, ".codex", "agent-runs", "registry.json");
}

export function createRunId(prefix = "run"): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

export function createBranchId(runId: string): string {
  return `branch_${runId.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80)}`;
}

export async function readRunRegistry(path: string): Promise<WorkbenchRunRegistry> {
  const text = await readFile(path, "utf8").catch((cause) => {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === "ENOENT") return undefined;
    throw cause;
  });
  if (!text?.trim()) return emptyRegistry();
  const parsed = JSON.parse(text) as Partial<WorkbenchRunRegistry>;
  return {
    version: REGISTRY_VERSION,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    records: Array.isArray(parsed.records) ? parsed.records.filter(isRunRecord).slice(-MAX_RECORDS) : []
  };
}

export async function startRunRecord(path: string, input: StartRunRecordInput): Promise<WorkbenchRunRecord> {
  const registry = await readRunRegistry(path);
  const now = new Date().toISOString();
  const id = input.id?.trim() || createRunId();
  const existing = registry.records.find((record) => record.id === id);
  const existingRecord = existing as WorkbenchRunRecord | undefined;
  const record: WorkbenchRunRecord = {
    id,
    branchId: input.branchId?.trim() || existingRecord?.branchId || createBranchId(id),
    parentRunId: input.parentRunId?.trim() || existingRecord?.parentRunId,
    parentBranchId: input.parentBranchId?.trim() || existingRecord?.parentBranchId,
    command: input.command,
    cwd: resolve(input.cwd),
    createdAt: existingRecord?.createdAt ?? now,
    updatedAt: now,
    status: "running" as const,
    providerId: input.providerId ?? existingRecord?.providerId,
    modelId: input.modelId ?? existingRecord?.modelId,
    sessionPath: input.sessionPath ?? existingRecord?.sessionPath,
    eventLogPath: input.eventLogPath ?? existingRecord?.eventLogPath,
    promptFile: input.promptFile ?? existingRecord?.promptFile,
    configPath: input.configPath ?? existingRecord?.configPath,
    outputRoot: input.outputRoot ?? existingRecord?.outputRoot,
    snapshotId: existingRecord?.snapshotId,
    completionPercent: existingRecord?.completionPercent,
    lastEventAt: existingRecord?.lastEventAt,
    lastEventType: existingRecord?.lastEventType,
    lastMessage: existingRecord?.lastMessage,
    stoppedReason: existingRecord?.stoppedReason,
    userGoalPreview: preview(input.userGoal) ?? existingRecord?.userGoalPreview
  };
  await writeRunRegistry(path, upsert(registry, record));
  return record;
}

export async function updateRunRecord(path: string, id: string, input: UpdateRunRecordInput): Promise<WorkbenchRunRecord | undefined> {
  const registry = await readRunRegistry(path);
  const existing = registry.records.find((record) => record.id === id);
  if (!existing) return undefined;
  const record: WorkbenchRunRecord = {
    ...existing,
    ...withoutUndefined(input),
    updatedAt: new Date().toISOString()
  };
  await writeRunRegistry(path, upsert(registry, record));
  return record;
}

export async function recordRunEvent(path: string, id: string, event: WorkbenchRunEvent, snapshot?: WorkbenchTaskSnapshot): Promise<void> {
  await updateRunRecord(path, id, {
    status: statusFromRunEvent(event),
    lastEventAt: event.timestamp,
    lastEventType: event.type,
    lastMessage: preview(event.message),
    ...snapshotSummary(snapshot)
  });
}

export async function finishRunRecord(
  path: string,
  id: string,
  status: WorkbenchRunRecordStatus,
  snapshot?: WorkbenchTaskSnapshot,
  stoppedReason?: string
): Promise<void> {
  await updateRunRecord(path, id, {
    status,
    stoppedReason,
    ...snapshotSummary(snapshot)
  });
}

export function findLatestRun(registry: WorkbenchRunRegistry, filter: LatestRunFilter = { cwd: undefined, status: undefined, branchId: undefined }): WorkbenchRunRecord | undefined {
  const cwd = filter.cwd ? resolve(filter.cwd) : undefined;
  return [...registry.records]
    .reverse()
    .find((record) => (!cwd || resolve(record.cwd) === cwd) && (!filter.status || record.status === filter.status) && (!filter.branchId || record.branchId === filter.branchId));
}

function emptyRegistry(): WorkbenchRunRegistry {
  return {
    version: REGISTRY_VERSION,
    updatedAt: new Date().toISOString(),
    records: []
  };
}

async function writeRunRegistry(path: string, registry: WorkbenchRunRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...registry, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

function upsert(registry: WorkbenchRunRegistry, record: WorkbenchRunRecord): WorkbenchRunRegistry {
  const records = registry.records.filter((item) => item.id !== record.id);
  records.push(record);
  return {
    version: REGISTRY_VERSION,
    updatedAt: new Date().toISOString(),
    records: records.slice(-MAX_RECORDS)
  };
}

function snapshotSummary(snapshot?: WorkbenchTaskSnapshot): Pick<WorkbenchRunRecord, "snapshotId" | "completionPercent"> {
  if (!snapshot) return { snapshotId: undefined, completionPercent: undefined };
  return {
    snapshotId: snapshot.id,
    completionPercent: snapshot.completionPercent
  };
}

function preview(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (looksLikeGatewayChallenge(normalized)) {
    return `[gateway-challenge] Cloudflare managed challenge HTML omitted (${normalized.length} chars).`;
  }
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}

function looksLikeGatewayChallenge(text: string): boolean {
  return /cloudflare|just a moment|cf_chl|challenge-platform|enable javascript and cookies/i.test(text);
}

function statusFromRunEvent(event: WorkbenchRunEvent): WorkbenchRunRecordStatus {
  if (event.type !== "run-error") return "running";
  return isTransientProviderRunError(event) ? "running" : "error";
}

function isTransientProviderRunError(event: WorkbenchRunEvent): boolean {
  const text = `${event.message ?? ""}\n${payloadText(event.payload)}`;
  if (looksLikeGatewayChallenge(text)) return true;
  if (/429\b|too many requests|rate[_ -]?limit/i.test(text)) return true;
  if (/tls handshake eof|fetch failed|connection reset|econnreset|etimedout|socket hang up|network\s+error/i.test(text)) return true;
  if (/rust reqwest fallback failed|rust reqwest transport exited/i.test(text) && /http request failed|connect|connection|tls/i.test(text)) return true;
  return false;
}

function payloadText(payload: unknown): string {
  if (payload === undefined || payload === null) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function withoutUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function isRunRecord(value: unknown): value is WorkbenchRunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.branchId === "string" &&
    typeof record.command === "string" &&
    typeof record.cwd === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    typeof record.status === "string"
  );
}
