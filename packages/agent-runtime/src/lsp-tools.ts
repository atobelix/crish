import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineTool } from "./tools";
import { CrishError, type JsonObject, type JsonValue, type ToolExecutionContext, type ToolOutput } from "@crish/shared-types";
import type { AgentTool } from "./types";

export type LspDiagnosticSeverity = "error" | "warning" | "information" | "hint";
export type LspDiagnosticTag = "unnecessary" | "deprecated";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  path: string;
  uri?: string;
  range: LspRange;
  selectionRange?: LspRange;
}

export interface LspDiagnosticRelatedInformation {
  location: LspLocation;
  message: string;
}

export interface LspDiagnostic {
  path: string;
  uri?: string;
  range: LspRange;
  severity: LspDiagnosticSeverity;
  message: string;
  source?: string;
  code?: string | number;
  tags?: LspDiagnosticTag[];
  relatedInformation?: LspDiagnosticRelatedInformation[];
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspFileTextEdits {
  path: string;
  uri?: string;
  edits: LspTextEdit[];
}

export interface LspWorkspaceEdit {
  changes: LspFileTextEdits[];
}

export interface LspDocumentRequest {
  path: string;
  absolutePath: string;
  uri: string;
}

export interface LspPositionRequest extends LspDocumentRequest {
  position: LspPosition;
}

export interface LspReferencesRequest extends LspPositionRequest {
  includeDeclaration: boolean;
}

export interface LspRenameRequest extends LspPositionRequest {
  newName: string;
}

export interface LspClientRequestContext {
  workspaceRoot: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface LspDiagnosticsResult {
  diagnostics: LspDiagnostic[];
  metadata?: JsonObject;
}

export interface LspDefinitionResult {
  definitions: LspLocation[];
  metadata?: JsonObject;
}

export interface LspReferencesResult {
  references: LspLocation[];
  metadata?: JsonObject;
}

export interface LspRenameResult {
  workspaceEdit: LspWorkspaceEdit;
  metadata?: JsonObject;
}

export interface LanguageServerClient {
  getDiagnostics(request: LspDocumentRequest, context: LspClientRequestContext): MaybePromise<LspDiagnosticsResult>;
  getDefinition(request: LspPositionRequest, context: LspClientRequestContext): MaybePromise<LspDefinitionResult>;
  getReferences(request: LspReferencesRequest, context: LspClientRequestContext): MaybePromise<LspReferencesResult>;
  rename(request: LspRenameRequest, context: LspClientRequestContext): MaybePromise<LspRenameResult>;
}

export interface LspToolOptions {
  workspaceRoot: string;
  client: LanguageServerClient;
  name?: string;
  defaultTimeoutMs?: number;
}

type MaybePromise<T> = T | Promise<T>;

const DEFAULT_TIMEOUT_MS = 10_000;

export function createLspDiagnosticsTool(options: LspToolOptions): AgentTool {
  return defineTool({
    name: options.name ?? "lsp_diagnostics",
    label: "LSP diagnostics",
    description: "Request language server diagnostics for a workspace file.",
    category: "filesystem",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace file path." },
        timeoutMs: { type: "integer", description: "Optional request timeout in milliseconds." }
      },
      required: ["path"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    summarize(input) {
      return `lsp diagnostics ${stringField(input, "path") ?? "<missing path>"}`;
    },
    async execute(input, context) {
      const request = documentRequest(options.workspaceRoot, input);
      const timeoutMs = timeoutMsField(input, options.defaultTimeoutMs);
      const result = await executeLspRequest(options, context, timeoutMs, (clientContext) =>
        options.client.getDiagnostics(request, clientContext)
      );
      const diagnostics = result.diagnostics.map((diagnostic, index) =>
        normalizeDiagnostic(options.workspaceRoot, request, diagnostic, `diagnostics[${index}]`)
      );
      return {
        text: diagnostics.length > 0 ? diagnostics.map(formatDiagnosticLine).join("\n") : `No diagnostics for ${request.path}.`,
        json: {
          path: request.path,
          uri: request.uri,
          count: diagnostics.length,
          diagnostics: diagnostics as unknown as JsonValue,
          metadata: result.metadata ?? null
        }
      };
    }
  });
}

export function createLspDefinitionTool(options: LspToolOptions): AgentTool {
  return defineTool({
    name: options.name ?? "lsp_definition",
    label: "LSP definition",
    description: "Find definition locations for a symbol position in a workspace file.",
    category: "filesystem",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace file path." },
        position: positionSchema(),
        timeoutMs: { type: "integer", description: "Optional request timeout in milliseconds." }
      },
      required: ["path", "position"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    summarize(input) {
      return `lsp definition ${stringField(input, "path") ?? "<missing path>"}${formatInputPosition(input)}`;
    },
    async execute(input, context) {
      const request = positionRequest(options.workspaceRoot, input);
      const timeoutMs = timeoutMsField(input, options.defaultTimeoutMs);
      const result = await executeLspRequest(options, context, timeoutMs, (clientContext) =>
        options.client.getDefinition(request, clientContext)
      );
      const definitions = result.definitions.map((location, index) =>
        normalizeLocation(options.workspaceRoot, location, `definitions[${index}]`)
      );
      return renderLocationsOutput({
        title: "definitions",
        emptyText: `No definitions for ${request.path}:${request.position.line + 1}:${request.position.character + 1}.`,
        request,
        locations: definitions,
        ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
      });
    }
  });
}

export function createLspReferencesTool(options: LspToolOptions): AgentTool {
  return defineTool({
    name: options.name ?? "lsp_references",
    label: "LSP references",
    description: "Find reference locations for a symbol position in a workspace file.",
    category: "filesystem",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace file path." },
        position: positionSchema(),
        includeDeclaration: { type: "boolean", description: "Whether to include the declaration location." },
        timeoutMs: { type: "integer", description: "Optional request timeout in milliseconds." }
      },
      required: ["path", "position"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    summarize(input) {
      return `lsp references ${stringField(input, "path") ?? "<missing path>"}${formatInputPosition(input)}`;
    },
    async execute(input, context) {
      const request: LspReferencesRequest = {
        ...positionRequest(options.workspaceRoot, input),
        includeDeclaration: booleanField(input, "includeDeclaration") ?? false
      };
      const timeoutMs = timeoutMsField(input, options.defaultTimeoutMs);
      const result = await executeLspRequest(options, context, timeoutMs, (clientContext) =>
        options.client.getReferences(request, clientContext)
      );
      const references = result.references.map((location, index) =>
        normalizeLocation(options.workspaceRoot, location, `references[${index}]`)
      );
      const output = renderLocationsOutput({
        title: "references",
        emptyText: `No references for ${request.path}:${request.position.line + 1}:${request.position.character + 1}.`,
        request,
        locations: references,
        ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
      });
      output.json = {
        ...(output.json as JsonObject),
        includeDeclaration: request.includeDeclaration
      };
      return output;
    }
  });
}

export function createLspRenameTool(options: LspToolOptions): AgentTool {
  return defineTool({
    name: options.name ?? "lsp_rename",
    label: "LSP rename",
    description: "Ask the language server for workspace edits that would rename a symbol.",
    category: "filesystem",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace file path." },
        position: positionSchema(),
        newName: { type: "string", description: "New symbol name." },
        timeoutMs: { type: "integer", description: "Optional request timeout in milliseconds." }
      },
      required: ["path", "position", "newName"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    summarize(input) {
      return `lsp rename ${stringField(input, "path") ?? "<missing path>"}${formatInputPosition(input)} to ${
        stringField(input, "newName") ?? "<missing name>"
      }`;
    },
    async execute(input, context) {
      const request: LspRenameRequest = {
        ...positionRequest(options.workspaceRoot, input),
        newName: requireNonEmptyString(input, "newName")
      };
      const timeoutMs = timeoutMsField(input, options.defaultTimeoutMs);
      const result = await executeLspRequest(options, context, timeoutMs, (clientContext) => options.client.rename(request, clientContext));
      const workspaceEdit = normalizeWorkspaceEdit(options.workspaceRoot, result.workspaceEdit);
      const fileCount = workspaceEdit.changes.length;
      const editCount = workspaceEdit.changes.reduce((count, change) => count + change.edits.length, 0);
      return {
        text:
          editCount > 0
            ? workspaceEdit.changes.map(formatFileEditSummary).join("\n")
            : `No rename edits for ${request.path}:${request.position.line + 1}:${request.position.character + 1}.`,
        json: {
          path: request.path,
          uri: request.uri,
          position: request.position as unknown as JsonValue,
          newName: request.newName,
          fileCount,
          editCount,
          workspaceEdit: workspaceEdit as unknown as JsonValue,
          metadata: result.metadata ?? null
        }
      };
    }
  });
}

async function executeLspRequest<T>(
  options: LspToolOptions,
  context: ToolExecutionContext,
  timeoutMs: number,
  invoke: (context: LspClientRequestContext) => MaybePromise<T>
): Promise<T> {
  const abort = createAbortRelay(context.signal, timeoutMs);
  try {
    return await Promise.race([
      Promise.resolve(
        invoke({
          workspaceRoot: resolve(options.workspaceRoot),
          signal: abort.signal,
          timeoutMs
        })
      ),
      waitForAbort(abort.signal)
    ]);
  } finally {
    abort.dispose();
  }
}

function createAbortRelay(parentSignal: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(abortReason(parentSignal) ?? new Error("LSP request aborted."));
  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`LSP request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", abortFromParent);
    }
  };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(abortReason(signal) ?? new Error("LSP request aborted."));
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(abortReason(signal) ?? new Error("LSP request aborted."));
      },
      { once: true }
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? signal.reason : undefined;
}

function documentRequest(workspaceRoot: string, input: JsonObject): LspDocumentRequest {
  const absolutePath = resolveWorkspacePath(workspaceRoot, requireNonEmptyString(input, "path"));
  return {
    path: displayPath(workspaceRoot, absolutePath),
    absolutePath,
    uri: pathToFileURL(absolutePath).href
  };
}

function positionRequest(workspaceRoot: string, input: JsonObject): LspPositionRequest {
  return {
    ...documentRequest(workspaceRoot, input),
    position: requirePosition(input)
  };
}

function requirePosition(input: JsonObject): LspPosition {
  const position = input.position;
  if (!isPlainObject(position)) {
    throw new CrishError("position must be an object with line and character.", "TOOL_ERROR", "permanent", false);
  }
  return normalizePosition(
    {
      line: position.line,
      character: position.character
    },
    "position"
  );
}

function normalizeDiagnostic(
  workspaceRoot: string,
  request: LspDocumentRequest,
  diagnostic: LspDiagnostic,
  label: string
): LspDiagnostic {
  const location = normalizePathFields(workspaceRoot, diagnostic.path ?? request.path, diagnostic.uri, label);
  const normalized: LspDiagnostic = {
    path: location.path,
    uri: location.uri,
    range: normalizeRange(diagnostic.range, `${label}.range`),
    severity: normalizeSeverity(diagnostic.severity, `${label}.severity`),
    message: requireStringValue(diagnostic.message, `${label}.message`)
  };
  if (diagnostic.source !== undefined) normalized.source = requireStringValue(diagnostic.source, `${label}.source`);
  if (diagnostic.code !== undefined) normalized.code = normalizeCode(diagnostic.code, `${label}.code`);
  if (diagnostic.tags !== undefined) normalized.tags = diagnostic.tags.map((tag, index) => normalizeTag(tag, `${label}.tags[${index}]`));
  if (diagnostic.relatedInformation !== undefined) {
    normalized.relatedInformation = diagnostic.relatedInformation.map((related, index) => ({
      location: normalizeLocation(workspaceRoot, related.location, `${label}.relatedInformation[${index}].location`),
      message: requireStringValue(related.message, `${label}.relatedInformation[${index}].message`)
    }));
  }
  return normalized;
}

function normalizeLocation(workspaceRoot: string, location: LspLocation, label: string): LspLocation {
  const normalizedPath = normalizePathFields(workspaceRoot, location.path, location.uri, label);
  const normalized: LspLocation = {
    path: normalizedPath.path,
    uri: normalizedPath.uri,
    range: normalizeRange(location.range, `${label}.range`)
  };
  if (location.selectionRange !== undefined) {
    normalized.selectionRange = normalizeRange(location.selectionRange, `${label}.selectionRange`);
  }
  return normalized;
}

function normalizeWorkspaceEdit(workspaceRoot: string, workspaceEdit: LspWorkspaceEdit): LspWorkspaceEdit {
  if (!isPlainObject(workspaceEdit) || !Array.isArray(workspaceEdit.changes)) {
    throw new CrishError("workspaceEdit.changes must be an array.", "TOOL_ERROR", "permanent", false);
  }
  return {
    changes: workspaceEdit.changes.map((change, changeIndex): LspFileTextEdits => {
      const location = normalizePathFields(workspaceRoot, change.path, change.uri, `workspaceEdit.changes[${changeIndex}]`);
      if (!Array.isArray(change.edits)) {
        throw new CrishError(`workspaceEdit.changes[${changeIndex}].edits must be an array.`, "TOOL_ERROR", "permanent", false);
      }
      return {
        path: location.path,
        uri: location.uri,
        edits: change.edits.map((edit, editIndex) => ({
          range: normalizeRange(edit.range, `workspaceEdit.changes[${changeIndex}].edits[${editIndex}].range`),
          newText: requireStringValue(edit.newText, `workspaceEdit.changes[${changeIndex}].edits[${editIndex}].newText`)
        }))
      };
    })
  };
}

function normalizePathFields(workspaceRoot: string, path: string, uri: string | undefined, label: string): { path: string; uri: string } {
  const inputPath = requireStringValue(path, `${label}.path`);
  const absolutePath = uri ? absolutePathFromUriOrPath(workspaceRoot, uri, label) : resolveWorkspacePath(workspaceRoot, inputPath);
  const pathFromField = resolveWorkspacePath(workspaceRoot, inputPath);
  if (normalizeForCompare(absolutePath) !== normalizeForCompare(pathFromField)) {
    throw new CrishError(`${label}.path and ${label}.uri must refer to the same workspace path.`, "TOOL_ERROR", "permanent", false);
  }
  return {
    path: displayPath(workspaceRoot, absolutePath),
    uri: pathToFileURL(absolutePath).href
  };
}

function absolutePathFromUriOrPath(workspaceRoot: string, uri: string, label: string): string {
  const value = requireStringValue(uri, `${label}.uri`);
  if (!value.startsWith("file://")) {
    throw new CrishError(`${label}.uri must be a file URI.`, "TOOL_ERROR", "permanent", false);
  }
  return resolveWorkspacePath(workspaceRoot, fileURLToPath(value));
}

function normalizeRange(range: LspRange, label: string): LspRange {
  if (!isPlainObject(range)) throw new CrishError(`${label} must be an object.`, "TOOL_ERROR", "permanent", false);
  const normalized = {
    start: normalizePosition(range.start, `${label}.start`),
    end: normalizePosition(range.end, `${label}.end`)
  };
  if (comparePosition(normalized.end, normalized.start) < 0) {
    throw new CrishError(`${label}.end must not be before ${label}.start.`, "TOOL_ERROR", "permanent", false);
  }
  return normalized;
}

function normalizePosition(position: unknown, label: string): LspPosition {
  if (!isPlainObject(position)) throw new CrishError(`${label} must be an object.`, "TOOL_ERROR", "permanent", false);
  return {
    line: requireNonNegativeInteger(position.line, `${label}.line`),
    character: requireNonNegativeInteger(position.character, `${label}.character`)
  };
}

function comparePosition(left: LspPosition, right: LspPosition): number {
  return left.line === right.line ? left.character - right.character : left.line - right.line;
}

function normalizeSeverity(severity: LspDiagnosticSeverity, label: string): LspDiagnosticSeverity {
  if (severity === "error" || severity === "warning" || severity === "information" || severity === "hint") return severity;
  throw new CrishError(`${label} must be error, warning, information, or hint.`, "TOOL_ERROR", "permanent", false);
}

function normalizeTag(tag: LspDiagnosticTag, label: string): LspDiagnosticTag {
  if (tag === "unnecessary" || tag === "deprecated") return tag;
  throw new CrishError(`${label} must be unnecessary or deprecated.`, "TOOL_ERROR", "permanent", false);
}

function normalizeCode(code: string | number, label: string): string | number {
  if (typeof code === "string" || (typeof code === "number" && Number.isFinite(code))) return code;
  throw new CrishError(`${label} must be a string or finite number.`, "TOOL_ERROR", "permanent", false);
}

function renderLocationsOutput(input: {
  title: "definitions" | "references";
  emptyText: string;
  request: LspPositionRequest;
  locations: LspLocation[];
  metadata?: JsonObject;
}): ToolOutput {
  return {
    text: input.locations.length > 0 ? input.locations.map(formatLocationLine).join("\n") : input.emptyText,
    json: {
      path: input.request.path,
      uri: input.request.uri,
      position: input.request.position as unknown as JsonValue,
      count: input.locations.length,
      [input.title]: input.locations as unknown as JsonValue,
      metadata: input.metadata ?? null
    }
  };
}

function formatDiagnosticLine(diagnostic: LspDiagnostic): string {
  const position = humanPosition(diagnostic.range.start);
  const source = diagnostic.source ? ` ${diagnostic.source}` : "";
  const code = diagnostic.code !== undefined ? ` ${diagnostic.code}` : "";
  return `${diagnostic.path}:${position}: ${diagnostic.severity}${source}${code}: ${diagnostic.message}`;
}

function formatLocationLine(location: LspLocation): string {
  return `${location.path}:${humanPosition(location.range.start)}-${humanPosition(location.range.end)}`;
}

function formatFileEditSummary(change: LspFileTextEdits): string {
  return `${change.path}: ${change.edits.length} edit${change.edits.length === 1 ? "" : "s"}`;
}

function humanPosition(position: LspPosition): string {
  return `${position.line + 1}:${position.character + 1}`;
}

function formatInputPosition(input: JsonObject): string {
  if (!isPlainObject(input.position)) return "";
  const line = input.position.line;
  const character = input.position.character;
  return typeof line === "number" && typeof character === "number" ? `:${line + 1}:${character + 1}` : "";
}

function positionSchema(): JsonObject {
  return {
    type: "object",
    properties: {
      line: { type: "integer", description: "Zero-based line number." },
      character: { type: "integer", description: "Zero-based UTF-16 character offset." }
    },
    required: ["line", "character"],
    additionalProperties: false
  };
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, inputPath);
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new CrishError(`Path escapes workspace: ${inputPath}`, "TOOL_ERROR", "permanent", false);
  }
  return candidate;
}

function displayPath(workspaceRoot: string, filePath: string): string {
  const rel = relative(resolve(workspaceRoot), filePath);
  return rel || basename(filePath);
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function timeoutMsField(input: JsonObject, defaultTimeoutMs: number | undefined): number {
  const value = input.timeoutMs;
  if (value === undefined) return Math.max(1, defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  return requirePositiveInteger(value, "timeoutMs");
}

function booleanField(input: JsonObject, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireNonEmptyString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CrishError(`${key} must be a non-empty string.`, "TOOL_ERROR", "permanent", false);
  }
  return value;
}

function requireStringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CrishError(`${label} must be a non-empty string.`, "TOOL_ERROR", "permanent", false);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CrishError(`${label} must be a non-negative integer.`, "TOOL_ERROR", "permanent", false);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CrishError(`${label} must be a positive integer.`, "TOOL_ERROR", "permanent", false);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
