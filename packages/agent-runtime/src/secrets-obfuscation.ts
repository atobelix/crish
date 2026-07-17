import type { AgentMessage, AgentMessageBlock, JsonObject, JsonValue, ToolOutput } from "@crish/shared-types";

export type SecretKind = "secret" | "env" | "token" | "api-key" | "pattern";

export interface SecretRegistration {
  id: string;
  kind: SecretKind;
  label: string;
  source?: string;
  valueLength: number;
}

export interface SecretPatternRegistration {
  id: string;
  kind: SecretKind;
  label: string;
  source?: string;
  pattern: RegExp;
  group: number;
  minLength: number;
}

export interface SecretRegistryOptions {
  minSecretLength?: number;
  sensitiveNamePattern?: RegExp;
}

export interface RegisterSecretOptions {
  id?: string;
  kind?: SecretKind;
  label?: string;
  source?: string;
  minLength?: number;
}

export interface RegisterEnvOptions {
  names?: string[];
  namePattern?: RegExp;
  excludeNames?: string[];
  minLength?: number;
}

export interface RegisterPatternOptions {
  id?: string;
  kind?: SecretKind;
  label?: string;
  source?: string;
  group?: number;
  minLength?: number;
}

export interface SecretRedactorOptions {
  placeholderPrefix?: string;
  restoreMap?: SecretRestoreMap;
  displayMap?: SecretDisplayMap;
  redactSensitiveJsonKeys?: boolean;
}

export interface SecretRedactionEntry {
  placeholder: string;
  kind: SecretKind;
  label: string;
  source?: string;
  valueLength: number;
}

export type SecretRestoreMap = Record<string, string>;
export type SecretDisplayMap = Record<string, string>;

export interface SecretRedactionState {
  entries: SecretRedactionEntry[];
  displayMap: SecretDisplayMap;
  restoreMap: SecretRestoreMap;
  resumeRestoreMap: SecretRestoreMap;
}

export interface SecretRedactionResult<T> extends SecretRedactionState {
  value: T;
  redacted: boolean;
}

interface RegisteredSecret {
  id: string;
  value: string;
  kind: SecretKind;
  label: string;
  source?: string;
  minLength: number;
}

interface RegisteredPattern {
  id: string;
  kind: SecretKind;
  label: string;
  source?: string;
  pattern: RegExp;
  group: number;
  minLength: number;
}

interface CandidateSpan {
  start: number;
  end: number;
  value: string;
  kind: SecretKind;
  label: string;
  source?: string;
  priority: number;
}

interface PlaceholderRecord {
  placeholder: string;
  value: string;
  kind: SecretKind;
  label: string;
  source?: string;
}

const DEFAULT_MIN_SECRET_LENGTH = 8;
const DEFAULT_PATTERN_MIN_SECRET_LENGTH = 16;
const DEFAULT_PLACEHOLDER_PREFIX = "SECRET";
const DEFAULT_SENSITIVE_NAME_PATTERN =
  /(?:api[_\-.]?key|access[_\-.]?token|refresh[_\-.]?token|id[_\-.]?token|(?:^|[_\-.])(?:token|secret|password|credential|auth)(?:$|[_\-.]))/i;
const LOW_SIGNAL_VALUES = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "none",
  "empty",
  "password",
  "secret",
  "token",
  "changeme",
  "localhost",
  "127.0.0.1"
]);

export class SecretRegistry {
  private readonly explicitSecrets: RegisteredSecret[] = [];
  private readonly registeredPatterns: RegisteredPattern[] = [];
  private nextSecretId = 1;
  private nextPatternId = 1;
  private readonly minSecretLength: number;
  private readonly sensitiveNamePattern: RegExp;

  constructor(options: SecretRegistryOptions = {}) {
    this.minSecretLength = Math.max(1, Math.floor(options.minSecretLength ?? DEFAULT_MIN_SECRET_LENGTH));
    this.sensitiveNamePattern = cloneRegExp(options.sensitiveNamePattern ?? DEFAULT_SENSITIVE_NAME_PATTERN);
  }

  registerSecret(value: string | undefined | null, options: RegisterSecretOptions = {}): SecretRegistration | undefined {
    const normalized = normalizeSecretValue(value);
    const minLength = Math.max(1, Math.floor(options.minLength ?? this.minSecretLength));
    if (!normalized || !isSecretCandidate(normalized, minLength)) return undefined;

    const existing = this.explicitSecrets.find((entry) => entry.value === normalized);
    if (existing) return toSecretRegistration(existing);

    const entry: RegisteredSecret = {
      id: options.id ?? `secret_${this.nextSecretId++}`,
      value: normalized,
      kind: options.kind ?? "secret",
      label: options.label ?? options.source ?? "secret",
      source: options.source,
      minLength
    };
    this.explicitSecrets.push(entry);
    return toSecretRegistration(entry);
  }

  registerEnv(env: Record<string, string | undefined>, options: RegisterEnvOptions = {}): SecretRegistration[] {
    const names = options.names ? new Set(options.names) : undefined;
    const excluded = new Set(options.excludeNames ?? []);
    const namePattern = options.namePattern ?? this.sensitiveNamePattern;
    const registrations: SecretRegistration[] = [];

    for (const [name, value] of Object.entries(env)) {
      if (excluded.has(name)) continue;
      resetRegExp(namePattern);
      const nameMatches = namePattern.test(name);
      resetRegExp(namePattern);
      if (names ? !names.has(name) : !nameMatches) continue;
      const registration = this.registerSecret(value, {
        kind: "env",
        label: `env:${name}`,
        source: name,
        minLength: options.minLength
      });
      if (registration) registrations.push(registration);
    }

    return registrations;
  }

  registerEnvVar(name: string, value: string | undefined | null, options: Omit<RegisterSecretOptions, "kind" | "label" | "source"> = {}): SecretRegistration | undefined {
    return this.registerSecret(value, {
      ...options,
      kind: "env",
      label: `env:${name}`,
      source: name
    });
  }

  registerPattern(pattern: RegExp, options: RegisterPatternOptions = {}): SecretPatternRegistration {
    const entry: RegisteredPattern = {
      id: options.id ?? `pattern_${this.nextPatternId++}`,
      kind: options.kind ?? "pattern",
      label: options.label ?? options.source ?? "pattern",
      source: options.source,
      pattern: cloneGlobalRegExp(pattern),
      group: Math.max(0, Math.floor(options.group ?? 0)),
      minLength: Math.max(1, Math.floor(options.minLength ?? DEFAULT_PATTERN_MIN_SECRET_LENGTH))
    };
    this.registeredPatterns.push(entry);
    return toPatternRegistration(entry);
  }

  registerTokenPattern(pattern: RegExp, options: Omit<RegisterPatternOptions, "kind"> = {}): SecretPatternRegistration {
    return this.registerPattern(pattern, {
      ...options,
      kind: "token",
      label: options.label ?? "token",
      group: options.group ?? 1
    });
  }

  registerApiKeyPattern(pattern: RegExp, options: Omit<RegisterPatternOptions, "kind"> = {}): SecretPatternRegistration {
    return this.registerPattern(pattern, {
      ...options,
      kind: "api-key",
      label: options.label ?? "api-key",
      group: options.group ?? 1
    });
  }

  registerTokenPatterns(): this {
    this.registerTokenPattern(/\bBearer\s+([A-Za-z0-9._~+/=-]{16,})\b/gi, {
      id: "bearer-token",
      label: "bearer-token"
    });
    this.registerTokenPattern(/\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token)\b\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{16,})["']?/gi, {
      id: "token-assignment",
      label: "token-assignment"
    });
    return this;
  }

  registerApiKeyPatterns(): this {
    this.registerApiKeyPattern(/\b(sk-[A-Za-z0-9][A-Za-z0-9_-]{16,})\b/g, {
      id: "openai-style-api-key",
      label: "openai-style-api-key"
    });
    this.registerApiKeyPattern(/\b(sk-ant-[A-Za-z0-9][A-Za-z0-9_-]{16,})\b/g, {
      id: "anthropic-style-api-key",
      label: "anthropic-style-api-key"
    });
    this.registerApiKeyPattern(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, {
      id: "github-token",
      label: "github-token"
    });
    this.registerApiKeyPattern(/\b(AIza[0-9A-Za-z_-]{20,})\b/g, {
      id: "google-api-key",
      label: "google-api-key"
    });
    this.registerApiKeyPattern(/\b(?:api[_-]?key|x-api-key|key)\b\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{16,})["']?/gi, {
      id: "api-key-assignment",
      label: "api-key-assignment"
    });
    return this;
  }

  registerDefaultPatterns(): this {
    return this.registerTokenPatterns().registerApiKeyPatterns();
  }

  secrets(): SecretRegistration[] {
    return this.explicitSecrets.map(toSecretRegistration);
  }

  patterns(): SecretPatternRegistration[] {
    return this.registeredPatterns.map(toPatternRegistration);
  }

  isSensitiveName(name: string): boolean {
    resetRegExp(this.sensitiveNamePattern);
    const matches = this.sensitiveNamePattern.test(name) || this.sensitiveNamePattern.test(separatorCaseName(name));
    resetRegExp(this.sensitiveNamePattern);
    return matches;
  }

  entriesForRedaction(): readonly RegisteredSecret[] {
    return this.explicitSecrets;
  }

  patternsForRedaction(): readonly RegisteredPattern[] {
    return this.registeredPatterns;
  }
}

export class SecretRedactor {
  private readonly valueToRecord = new Map<string, PlaceholderRecord>();
  private readonly placeholderToRecord = new Map<string, PlaceholderRecord>();
  private nextPlaceholder = 1;
  private readonly placeholderPrefix: string;
  private readonly redactSensitiveJsonKeys: boolean;

  constructor(private readonly registry: SecretRegistry = new SecretRegistry(), options: SecretRedactorOptions = {}) {
    this.placeholderPrefix = sanitizePlaceholderPrefix(options.placeholderPrefix ?? DEFAULT_PLACEHOLDER_PREFIX);
    this.redactSensitiveJsonKeys = options.redactSensitiveJsonKeys ?? true;
    if (options.restoreMap) {
      this.importRestoreMap(options.restoreMap, options.displayMap);
    }
  }

  redactText(text: string): SecretRedactionResult<string> {
    const spans = this.collectTextSpans(text);
    if (spans.length === 0) return this.result(text, false);

    const selected = selectNonOverlappingSpans(spans);
    if (selected.length === 0) return this.result(text, false);

    let redacted = "";
    let cursor = 0;
    for (const span of selected) {
      redacted += text.slice(cursor, span.start);
      redacted += this.placeholderFor(span.value, span);
      cursor = span.end;
    }
    redacted += text.slice(cursor);
    return this.result(redacted, redacted !== text);
  }

  redactJson<T extends JsonValue>(value: T): SecretRedactionResult<T> {
    const state = { redacted: false };
    const redacted = this.redactJsonValue(value, undefined, state) as T;
    return this.result(redacted, state.redacted);
  }

  redactToolOutput(output: ToolOutput): SecretRedactionResult<ToolOutput> {
    const state = { redacted: false };
    let next = output;

    if (typeof output.text === "string") {
      const text = this.redactText(output.text);
      if (text.redacted) {
        next = { ...next, text: text.value };
        state.redacted = true;
      }
    }

    if (output.json !== undefined) {
      const json = this.redactJson(output.json);
      if (json.redacted) {
        next = { ...next, json: json.value };
        state.redacted = true;
      }
    }

    if (output.artifacts?.length) {
      const artifacts = output.artifacts.map((artifact) => {
        let changed = false;
        const title = this.redactText(artifact.title);
        const uri = typeof artifact.uri === "string" ? this.redactText(artifact.uri) : undefined;
        const text = typeof artifact.text === "string" ? this.redactText(artifact.text) : undefined;
        const metadata = artifact.metadata ? this.redactJson(artifact.metadata) : undefined;
        changed = title.redacted || !!uri?.redacted || !!text?.redacted || !!metadata?.redacted;
        if (!changed) return artifact;
        state.redacted = true;
        return {
          ...artifact,
          title: title.value,
          ...(uri ? { uri: uri.value } : {}),
          ...(text ? { text: text.value } : {}),
          ...(metadata ? { metadata: metadata.value as JsonObject } : {})
        };
      });
      if (state.redacted) next = { ...next, artifacts };
    }

    return this.result(next, state.redacted);
  }

  redactMessage(message: AgentMessage): SecretRedactionResult<AgentMessage> {
    const blocks = message.blocks.map((block) => this.redactBlock(block));
    const metadata = message.metadata ? this.redactJson(message.metadata) : undefined;
    const changed = blocks.some((block, index) => block !== message.blocks[index]) || !!metadata?.redacted;
    return this.result(
      changed
        ? {
            ...message,
            blocks,
            ...(metadata ? { metadata: metadata.value as JsonObject } : {})
          }
        : message,
      changed
    );
  }

  redactMessages(messages: AgentMessage[]): SecretRedactionResult<AgentMessage[]> {
    const redactedMessages = messages.map((message) => this.redactMessage(message).value);
    const changed = redactedMessages.some((message, index) => message !== messages[index]);
    return this.result(changed ? redactedMessages : messages, changed);
  }

  restoreText(text: string, restoreMap: SecretRestoreMap = this.restoreMap()): string {
    let restored = text;
    const placeholders = Object.keys(restoreMap).sort((left, right) => right.length - left.length);
    for (const placeholder of placeholders) {
      restored = replaceAllLiteral(restored, placeholder, restoreMap[placeholder]!);
    }
    return restored;
  }

  restoreJson<T extends JsonValue>(value: T, restoreMap: SecretRestoreMap = this.restoreMap()): T {
    return restoreJsonValue(value, restoreMap, this) as T;
  }

  restoreToolOutput(output: ToolOutput, restoreMap: SecretRestoreMap = this.restoreMap()): ToolOutput {
    return {
      ...output,
      ...(typeof output.text === "string" ? { text: this.restoreText(output.text, restoreMap) } : {}),
      ...(output.json !== undefined ? { json: this.restoreJson(output.json, restoreMap) } : {}),
      ...(output.artifacts
        ? {
            artifacts: output.artifacts.map((artifact) => ({
              ...artifact,
              title: this.restoreText(artifact.title, restoreMap),
              ...(typeof artifact.uri === "string" ? { uri: this.restoreText(artifact.uri, restoreMap) } : {}),
              ...(typeof artifact.text === "string" ? { text: this.restoreText(artifact.text, restoreMap) } : {}),
              ...(artifact.metadata ? { metadata: this.restoreJson(artifact.metadata, restoreMap) as JsonObject } : {})
            }))
          }
        : {})
    };
  }

  importRestoreMap(restoreMap: SecretRestoreMap, displayMap: SecretDisplayMap = {}): void {
    for (const [placeholder, value] of Object.entries(restoreMap)) {
      const normalized = normalizeSecretValue(value);
      if (!normalized) continue;
      const label = displayMap[placeholder] ?? "restored-secret";
      const record: PlaceholderRecord = {
        placeholder,
        value: normalized,
        kind: "secret",
        label
      };
      this.valueToRecord.set(normalized, record);
      this.placeholderToRecord.set(placeholder, record);
      this.nextPlaceholder = Math.max(this.nextPlaceholder, placeholderSequence(placeholder) + 1);
    }
  }

  displayMap(): SecretDisplayMap {
    return Object.fromEntries([...this.placeholderToRecord.values()].map((entry) => [entry.placeholder, entry.label]));
  }

  restoreMap(): SecretRestoreMap {
    return Object.fromEntries([...this.placeholderToRecord.values()].map((entry) => [entry.placeholder, entry.value]));
  }

  state(): SecretRedactionState {
    const entries = [...this.placeholderToRecord.values()].map((entry): SecretRedactionEntry => {
      const result: SecretRedactionEntry = {
        placeholder: entry.placeholder,
        kind: entry.kind,
        label: entry.label,
        valueLength: entry.value.length
      };
      if (entry.source !== undefined) result.source = entry.source;
      return result;
    });
    const restoreMap = this.restoreMap();
    return {
      entries,
      displayMap: this.displayMap(),
      restoreMap,
      resumeRestoreMap: { ...restoreMap }
    };
  }

  private redactBlock(block: AgentMessageBlock): AgentMessageBlock {
    if (block.type === "text" || block.type === "thought") {
      const text = this.redactText(block.text);
      return text.redacted ? { ...block, text: text.value } : block;
    }
    if (block.type === "tool-call") {
      const input = this.redactJson(block.input);
      return input.redacted ? { ...block, input: input.value as JsonObject } : block;
    }
    const output = this.redactToolOutput(block.output);
    return output.redacted ? { ...block, output: output.value } : block;
  }

  private redactJsonValue(value: JsonValue, parentKey: string | undefined, state: { redacted: boolean }): JsonValue {
    if (typeof value === "string") {
      const redacted = this.redactText(value);
      if (redacted.redacted) {
        state.redacted = true;
        return redacted.value;
      }
      if (parentKey && this.redactSensitiveJsonKeys && this.registry.isSensitiveName(parentKey) && isSecretCandidate(value, DEFAULT_PATTERN_MIN_SECRET_LENGTH)) {
        state.redacted = true;
        return this.placeholderFor(value, {
          kind: secretKindForName(parentKey),
          label: `json:${parentKey}`,
          source: parentKey
        });
      }
      return value;
    }

    if (Array.isArray(value)) {
      let changed = false;
      const items = value.map((item) => {
        const before = state.redacted;
        const next = this.redactJsonValue(item, parentKey, state);
        if (next !== item || state.redacted !== before) changed = true;
        return next;
      });
      return changed ? items : value;
    }

    if (value && typeof value === "object") {
      let changed = false;
      const entries = Object.entries(value).map(([key, item]) => {
        const keyResult = this.redactText(key);
        const before = state.redacted;
        const nextValue = this.redactJsonValue(item, key, state);
        if (keyResult.redacted || nextValue !== item || state.redacted !== before) changed = true;
        if (keyResult.redacted) state.redacted = true;
        return [keyResult.value, nextValue] as const;
      });
      return changed ? (Object.fromEntries(entries) as JsonObject) : value;
    }

    return value;
  }

  private collectTextSpans(text: string): CandidateSpan[] {
    if (!text) return [];
    return [...this.collectRegisteredSecretSpans(text), ...this.collectKnownSecretSpans(text), ...this.collectPatternSpans(text)];
  }

  private collectRegisteredSecretSpans(text: string): CandidateSpan[] {
    const spans: CandidateSpan[] = [];
    const secrets = [...this.registry.entriesForRedaction()].sort((left, right) => right.value.length - left.value.length);

    for (const secret of secrets) {
      let index = text.indexOf(secret.value);
      while (index !== -1) {
        spans.push({
          start: index,
          end: index + secret.value.length,
          value: secret.value,
          kind: secret.kind,
          label: secret.label,
          source: secret.source,
          priority: 0
        });
        index = text.indexOf(secret.value, index + secret.value.length);
      }
    }

    return spans;
  }

  private collectKnownSecretSpans(text: string): CandidateSpan[] {
    const spans: CandidateSpan[] = [];
    const known = [...this.placeholderToRecord.values()].sort((left, right) => right.value.length - left.value.length);

    for (const secret of known) {
      let index = text.indexOf(secret.value);
      while (index !== -1) {
        spans.push({
          start: index,
          end: index + secret.value.length,
          value: secret.value,
          kind: secret.kind,
          label: secret.label,
          source: secret.source,
          priority: 0
        });
        index = text.indexOf(secret.value, index + secret.value.length);
      }
    }

    return spans;
  }

  private collectPatternSpans(text: string): CandidateSpan[] {
    const spans: CandidateSpan[] = [];

    for (const pattern of this.registry.patternsForRedaction()) {
      resetRegExp(pattern.pattern);
      let match: RegExpExecArray | null;
      while ((match = pattern.pattern.exec(text))) {
        if (match[0].length === 0) {
          pattern.pattern.lastIndex += 1;
          continue;
        }

        const candidate = candidateFromMatch(match, pattern.group);
        if (!candidate || !isSecretCandidate(candidate.value, pattern.minLength)) continue;
        spans.push({
          start: candidate.start,
          end: candidate.end,
          value: candidate.value,
          kind: pattern.kind,
          label: pattern.label,
          source: pattern.source,
          priority: 1
        });
      }
      resetRegExp(pattern.pattern);
    }

    return spans;
  }

  private placeholderFor(value: string, span: Pick<CandidateSpan, "kind" | "label" | "source">): string {
    const normalized = normalizeSecretValue(value);
    if (!normalized) return value;
    const existing = this.valueToRecord.get(normalized);
    if (existing) return existing.placeholder;

    const placeholder = `[${this.placeholderPrefix}_${this.nextPlaceholder++}]`;
    const record: PlaceholderRecord = {
      placeholder,
      value: normalized,
      kind: span.kind,
      label: span.label,
      source: span.source
    };
    this.valueToRecord.set(normalized, record);
    this.placeholderToRecord.set(placeholder, record);
    return placeholder;
  }

  private result<T>(value: T, redacted: boolean): SecretRedactionResult<T> {
    return {
      value,
      redacted,
      ...this.state()
    };
  }
}

export function createSecretRedactorFromEnv(
  env: Record<string, string | undefined>,
  options: SecretRegistryOptions & RegisterEnvOptions & SecretRedactorOptions = {}
): SecretRedactor {
  const registry = new SecretRegistry(options);
  registry.registerEnv(env, options);
  registry.registerDefaultPatterns();
  return new SecretRedactor(registry, options);
}

function toSecretRegistration(entry: RegisteredSecret): SecretRegistration {
  const result: SecretRegistration = {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    valueLength: entry.value.length
  };
  if (entry.source !== undefined) result.source = entry.source;
  return result;
}

function toPatternRegistration(entry: RegisteredPattern): SecretPatternRegistration {
  const result: SecretPatternRegistration = {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    pattern: entry.pattern,
    group: entry.group,
    minLength: entry.minLength
  };
  if (entry.source !== undefined) result.source = entry.source;
  return result;
}

function normalizeSecretValue(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isSecretCandidate(value: string, minLength: number): boolean {
  const normalized = normalizeSecretValue(value);
  if (!normalized || normalized.length < minLength) return false;
  if (LOW_SIGNAL_VALUES.has(normalized.toLowerCase())) return false;
  if (/^\*+$/.test(normalized)) return false;
  if (/^[0-9]+$/.test(normalized) && normalized.length < Math.max(16, minLength)) return false;
  if (new Set(normalized).size < 4) return false;
  return true;
}

function cloneRegExp(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

function cloneGlobalRegExp(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function resetRegExp(pattern: RegExp): void {
  pattern.lastIndex = 0;
}

function candidateFromMatch(match: RegExpExecArray, group: number): { value: string; start: number; end: number } | undefined {
  const value = match[group];
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (group === 0) {
    return {
      value,
      start: match.index,
      end: match.index + value.length
    };
  }

  const fullMatch = match[0];
  const offset = fullMatch.indexOf(value);
  if (offset === -1) return undefined;
  const start = match.index + offset;
  return {
    value,
    start,
    end: start + value.length
  };
}

function selectNonOverlappingSpans(spans: CandidateSpan[]): CandidateSpan[] {
  const sorted = [...spans].sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    if (left.priority !== right.priority) return left.priority - right.priority;
    return right.end - right.start - (left.end - left.start);
  });
  const selected: CandidateSpan[] = [];
  let cursor = 0;

  for (const span of sorted) {
    if (span.start < cursor) continue;
    selected.push(span);
    cursor = span.end;
  }

  return selected;
}

function replaceAllLiteral(input: string, search: string, replacement: string): string {
  if (!search) return input;
  return input.split(search).join(replacement);
}

function restoreJsonValue(value: JsonValue, restoreMap: SecretRestoreMap, redactor: SecretRedactor): JsonValue {
  if (typeof value === "string") return redactor.restoreText(value, restoreMap);
  if (Array.isArray(value)) return value.map((item) => restoreJsonValue(item, restoreMap, redactor));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redactor.restoreText(key, restoreMap), restoreJsonValue(item, restoreMap, redactor)])
    ) as JsonObject;
  }
  return value;
}

function sanitizePlaceholderPrefix(prefix: string): string {
  const normalized = prefix.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || DEFAULT_PLACEHOLDER_PREFIX;
}

function placeholderSequence(placeholder: string): number {
  const match = placeholder.match(/_(\d+)\]$/);
  return match ? Number(match[1]) : 0;
}

function separatorCaseName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
}

function secretKindForName(name: string): SecretKind {
  const normalized = separatorCaseName(name).toLowerCase();
  if (/api[_\-.]?key|key/.test(normalized)) return "api-key";
  if (/token/.test(normalized)) return "token";
  return "secret";
}
