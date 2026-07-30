import { createId } from '@crish/agent-context';
import { BoundedMap, clone, deepFreeze } from '@crish/shared-utils';
import type { JsonObject, JsonValue, ToolArtifact } from '@crish/shared-types';

export type PreviewStatus = 'pending' | 'applied' | 'discarded' | 'expired';
export type PreviewResolutionStatus = 'applied' | 'discarded';

export interface PreviewQueueOptions {
  defaultTtlMs?: number;
  idFactory?: () => string;
  now?: () => Date | number;
}

export interface PreviewArtifactInput {
  kind?: ToolArtifact['kind'];
  title?: string;
  uri?: string;
  text?: string;
  metadata?: JsonObject;
}

export interface CreatePreviewRequest<TPayload extends JsonValue = JsonObject> {
  id?: string;
  action: string;
  title: string;
  payload: TPayload;
  artifact?: PreviewArtifactInput;
  metadata?: JsonObject;
  ttlMs?: number;
}

export interface PreviewTransitionUpdate<
  TResult extends JsonValue = JsonValue,
> {
  result?: TResult;
  metadata?: JsonObject;
  artifact?: PreviewArtifactInput;
}

export interface PreviewApplyOptions<
  TPayload extends JsonValue = JsonObject,
  TResult extends JsonValue = JsonValue,
> extends PreviewTransitionUpdate<TResult> {
  effect?: (
    preview: PendingPreview<TPayload>
  ) =>
    | Promise<PreviewTransitionUpdate<TResult> | void>
    | PreviewTransitionUpdate<TResult>
    | void;
}

export interface PreviewDiscardOptions<
  TPayload extends JsonValue = JsonObject,
  TResult extends JsonValue = JsonValue,
> extends PreviewTransitionUpdate<TResult> {
  reason?: string;
  effect?: (
    preview: PendingPreview<TPayload>
  ) =>
    | Promise<PreviewTransitionUpdate<TResult> | void>
    | PreviewTransitionUpdate<TResult>
    | void;
}

export type PreviewResolution<
  TPayload extends JsonValue = JsonObject,
  TResult extends JsonValue = JsonValue,
> =
  | ({ status: 'applied' } & PreviewApplyOptions<TPayload, TResult>)
  | ({ status: 'discarded' } & PreviewDiscardOptions<TPayload, TResult>);

interface PreviewBase<TPayload extends JsonValue> {
  id: string;
  action: string;
  title: string;
  payload: TPayload;
  status: PreviewStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ttlMs: number;
  artifact: ToolArtifact;
  metadata: JsonObject;
}

export interface PendingPreview<
  TPayload extends JsonValue = JsonObject,
> extends PreviewBase<TPayload> {
  status: 'pending';
}

export interface AppliedPreview<
  TPayload extends JsonValue = JsonObject,
> extends PreviewBase<TPayload> {
  status: 'applied';
  resolvedAt: string;
  appliedAt: string;
  result?: JsonValue;
}

export interface DiscardedPreview<
  TPayload extends JsonValue = JsonObject,
> extends PreviewBase<TPayload> {
  status: 'discarded';
  resolvedAt: string;
  discardedAt: string;
  reason?: string;
  result?: JsonValue;
}

export interface ExpiredPreview<
  TPayload extends JsonValue = JsonObject,
> extends PreviewBase<TPayload> {
  status: 'expired';
  expiredAt: string;
}

export type ResolvedPreview<TPayload extends JsonValue = JsonObject> =
  AppliedPreview<TPayload> | DiscardedPreview<TPayload>;
export type Preview<TPayload extends JsonValue = JsonObject> =
  | PendingPreview<TPayload>
  | AppliedPreview<TPayload>
  | DiscardedPreview<TPayload>
  | ExpiredPreview<TPayload>;

export interface PreviewListOptions {
  status?: PreviewStatus | PreviewStatus[];
}

const DEFAULT_PREVIEW_TTL_MS = 30 * 60 * 1000;
/** 预览队列上限：防止长期运行时累积过期预览导致内存泄漏。 */
const MAX_PREVIEWS = 200;

export class PreviewQueue<TPayload extends JsonValue = JsonObject> {
  private readonly defaultTtlMs: number;
  private readonly idFactory: () => string;
  private readonly now: () => Date | number;
  private readonly previews = new BoundedMap<string, Preview<TPayload>>(
    MAX_PREVIEWS,
    undefined
  );
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: PreviewQueueOptions = {}) {
    this.defaultTtlMs = normalizeTtlMs(
      options.defaultTtlMs ?? DEFAULT_PREVIEW_TTL_MS,
      'defaultTtlMs'
    );
    this.idFactory = options.idFactory ?? (() => createId('preview'));
    this.now = options.now ?? (() => Date.now());
  }

  async createPreview(
    request: CreatePreviewRequest<TPayload>
  ): Promise<PendingPreview<TPayload>> {
    return this.enqueue(() => {
      const nowMs = this.nowMs();
      this.expireDuePreviews(nowMs);

      const id = requireNonEmptyString(
        request.id ?? this.idFactory(),
        'preview id'
      );
      if (this.previews.has(id)) {
        throw new Error(`Preview already exists: ${id}`);
      }

      const ttlMs = normalizeTtlMs(request.ttlMs ?? this.defaultTtlMs, 'ttlMs');
      const timestamp = toIso(nowMs);
      const preview: PendingPreview<TPayload> = {
        id,
        action: requireNonEmptyString(request.action, 'action'),
        title: requireNonEmptyString(request.title, 'title'),
        payload: cloneJsonValue(request.payload),
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: toIso(nowMs + ttlMs),
        ttlMs,
        artifact: {
          kind: request.artifact?.kind ?? 'log',
          title: request.artifact?.title ?? request.title,
        },
        metadata: cloneJsonObject(request.metadata),
      };
      preview.artifact = this.buildArtifact(preview, request.artifact);
      const frozen = deepFreeze(preview);
      this.previews.set(id, frozen);
      return frozen;
    });
  }

  async get(id: string): Promise<Preview<TPayload> | undefined> {
    return this.enqueue(() => {
      this.expireDuePreviews(this.nowMs());
      const preview = this.previews.get(id);
      return preview;
    });
  }

  async list(
    options: PreviewListOptions = {}
  ): Promise<Array<Preview<TPayload>>> {
    return this.enqueue(() => {
      this.expireDuePreviews(this.nowMs());
      const statuses = statusFilter(options.status);
      return [...this.previews.values()].filter(
        (preview) => !statuses || statuses.has(preview.status)
      );
    });
  }

  async resolve<TResult extends JsonValue = JsonValue>(
    id: string,
    resolution: PreviewResolution<TPayload, TResult>
  ): Promise<ResolvedPreview<TPayload>> {
    return resolution.status === 'applied'
      ? this.apply(id, resolution)
      : this.discard(id, resolution);
  }

  async apply<TResult extends JsonValue = JsonValue>(
    id: string,
    options: PreviewApplyOptions<TPayload, TResult> = {}
  ): Promise<AppliedPreview<TPayload>> {
    return this.enqueue(async () => {
      const preview = this.requirePendingPreview(id, 'apply');
      const transition = await this.runTransitionEffect(preview, options);
      const now = toIso(this.nowMs());
      const applied: AppliedPreview<TPayload> = {
        ...preview,
        status: 'applied',
        updatedAt: now,
        resolvedAt: now,
        appliedAt: now,
        metadata: mergeJsonObjects(preview.metadata, transition.metadata),
      };
      if (transition.result !== undefined) {
        applied.result = cloneJsonValue(transition.result);
      }
      applied.artifact = this.buildArtifact(
        applied,
        mergeArtifactInputs(preview.artifact, transition.artifact)
      );
      const frozenApplied = deepFreeze(applied);
      this.previews.set(id, frozenApplied);
      return frozenApplied;
    });
  }

  async discard<TResult extends JsonValue = JsonValue>(
    id: string,
    options: PreviewDiscardOptions<TPayload, TResult> = {}
  ): Promise<DiscardedPreview<TPayload>> {
    return this.enqueue(async () => {
      const preview = this.requirePendingPreview(id, 'discard');
      const transition = await this.runTransitionEffect(preview, options);
      const now = toIso(this.nowMs());
      const discarded: DiscardedPreview<TPayload> = {
        ...preview,
        status: 'discarded',
        updatedAt: now,
        resolvedAt: now,
        discardedAt: now,
        metadata: mergeJsonObjects(preview.metadata, transition.metadata),
      };
      if (options.reason !== undefined) {
        discarded.reason = options.reason;
      }
      if (transition.result !== undefined) {
        discarded.result = cloneJsonValue(transition.result);
      }
      discarded.artifact = this.buildArtifact(
        discarded,
        mergeArtifactInputs(preview.artifact, transition.artifact)
      );
      const frozenDiscarded = deepFreeze(discarded);
      this.previews.set(id, frozenDiscarded);
      return frozenDiscarded;
    });
  }

  private requirePendingPreview(
    id: string,
    operation: string
  ): PendingPreview<TPayload> {
    this.expireDuePreviews(this.nowMs());
    const preview = this.previews.get(id);
    if (!preview) {
      throw new Error(`Preview not found: ${id}`);
    }
    if (preview.status !== 'pending') {
      throw new Error(
        `Cannot ${operation} preview ${id} from ${preview.status} status`
      );
    }
    return preview;
  }

  private async runTransitionEffect<TResult extends JsonValue>(
    preview: PendingPreview<TPayload>,
    options:
      | PreviewApplyOptions<TPayload, TResult>
      | PreviewDiscardOptions<TPayload, TResult>
  ): Promise<PreviewTransitionUpdate<TResult>> {
    const effectUpdate = (await options.effect?.(preview)) ?? {};
    const result =
      effectUpdate.result !== undefined ? effectUpdate.result : options.result;
    const artifact = mergeArtifactInputs(
      options.artifact,
      effectUpdate.artifact
    );
    return {
      ...(result !== undefined ? { result } : {}),
      metadata: mergeJsonObjects(options.metadata, effectUpdate.metadata),
      ...(artifact !== undefined ? { artifact } : {}),
    };
  }

  private buildArtifact(
    preview: Preview<TPayload>,
    input?: PreviewArtifactInput
  ): ToolArtifact {
    const artifactMetadata = cloneJsonObject(input?.metadata);
    const previewMetadata = cloneJsonObject(preview.metadata);
    const artifact: ToolArtifact = {
      kind: input?.kind ?? 'log',
      title: input?.title ?? preview.title,
      metadata: {
        ...artifactMetadata,
        ...previewMetadata,
        artifactKind:
          artifactMetadata.artifactKind ??
          previewMetadata.artifactKind ??
          'runtime-preview',
        previewKind: 'runtime-preview',
        previewId: preview.id,
        previewAction: preview.action,
        previewStatus: preview.status,
        previewCreatedAt: preview.createdAt,
        previewUpdatedAt: preview.updatedAt,
        previewExpiresAt: preview.expiresAt,
        previewTtlMs: preview.ttlMs,
      },
    };
    if (input?.uri !== undefined) {
      artifact.uri = input.uri;
    }
    if (input?.text !== undefined) {
      artifact.text = input.text;
    }
    if (preview.status === 'applied') {
      artifact.metadata!.previewResolvedAt = preview.resolvedAt;
      artifact.metadata!.previewAppliedAt = preview.appliedAt;
    }
    if (preview.status === 'discarded') {
      artifact.metadata!.previewResolvedAt = preview.resolvedAt;
      artifact.metadata!.previewDiscardedAt = preview.discardedAt;
      if (preview.reason !== undefined) {
        artifact.metadata!.previewDiscardReason = preview.reason;
      }
    }
    if (preview.status === 'expired') {
      artifact.metadata!.previewExpiredAt = preview.expiredAt;
    }
    return artifact;
  }

  private expireDuePreviews(nowMs: number): void {
    const now = toIso(nowMs);
    for (const preview of this.previews.values()) {
      if (
        preview.status !== 'pending' ||
        Date.parse(preview.expiresAt) > nowMs
      ) {
        continue;
      }
      const expired: ExpiredPreview<TPayload> = {
        ...preview,
        status: 'expired',
        updatedAt: now,
        expiredAt: now,
      };
      expired.artifact = this.buildArtifact(expired, preview.artifact);
      this.previews.set(preview.id, deepFreeze(expired));
    }
  }

  private nowMs(): number {
    const value = this.now();
    const timestamp = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(timestamp)) {
      throw new Error('PreviewQueue clock returned an invalid timestamp');
    }
    return timestamp;
  }

  private async enqueue<TResult>(
    operation: () => Promise<TResult> | TResult
  ): Promise<TResult> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

/**
 * TTL 上限：Date 支持的范围是 ±8.64e15 ms（±100,000,000 天）。
 * 超过此值的 ttlMs 会导致 new Date(nowMs + ttlMs).toISOString() 抛 RangeError。
 * 8.64e15 ms ≈ 274,000 年，远超任何合理 TTL 需求。
 */
const MAX_SAFE_TTL_MS = 8.64e15;

function normalizeTtlMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  if (value > MAX_SAFE_TTL_MS) {
    throw new Error(`${label} is too large (max ${MAX_SAFE_TTL_MS} ms)`);
  }
  return value;
}

function requireNonEmptyString(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function statusFilter(
  status: PreviewListOptions['status']
): Set<PreviewStatus> | null {
  if (!status) {
    return null;
  }
  return new Set(Array.isArray(status) ? status : [status]);
}

function mergeJsonObjects(left?: JsonObject, right?: JsonObject): JsonObject {
  return {
    ...cloneJsonObject(left),
    ...cloneJsonObject(right),
  };
}

function mergeArtifactInputs(
  left?: PreviewArtifactInput,
  right?: PreviewArtifactInput
): PreviewArtifactInput | undefined {
  if (!left && !right) {
    return undefined;
  }
  const kind = right?.kind ?? left?.kind;
  const title = right?.title ?? left?.title;
  const uri = right?.uri ?? left?.uri;
  const text = right?.text ?? left?.text;
  const metadata = mergeJsonObjects(left?.metadata, right?.metadata);
  const hasMetadata = Object.keys(metadata).length > 0;
  if (
    kind === undefined &&
    title === undefined &&
    uri === undefined &&
    text === undefined &&
    !hasMetadata
  ) {
    return undefined;
  }
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(uri !== undefined ? { uri } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(hasMetadata ? { metadata } : {}),
  };
}

function cloneJsonObject(value?: JsonObject): JsonObject {
  return value ? (cloneJsonValue(value) as JsonObject) : {};
}

function cloneJsonValue<TValue extends JsonValue>(value: TValue): TValue {
  // 使用 shared-utils 的 clone()：structuredClone 失败时降级为 JSON roundtrip，
  // 静默剥离函数/Symbol/undefined 等非 JSON 安全属性，避免 DataCloneError 崩溃。
  return clone(value);
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
