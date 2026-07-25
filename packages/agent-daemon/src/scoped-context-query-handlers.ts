import type {
  DeleteScopedContextMessage,
  GetScopedContextMessage,
  ResolveScopedContextMessage,
  ScopedContextDeletedMessage,
  ScopedContextResolvedMessage,
  ScopedContextResponseMessage,
  ScopedContextUpsertedMessage,
  UpsertScopedContextMessage,
} from "./types.js";
import type { ScopedContextStore } from "./scoped-context-store.js";
import type { ScopedContextRuntimeConfig } from "./types/entities.js";
import { resolveDaemonScopedContext } from "./scoped-context-runtime.js";

export async function createGetScopedContextResponse(
  store: ScopedContextStore,
  msg: GetScopedContextMessage
): Promise<ScopedContextResponseMessage> {
  const result = await store.list({
    ...(msg.scope !== undefined ? { scope: msg.scope } : {}),
    ...(msg.kind !== undefined ? { kind: msg.kind } : {}),
  });
  return {
    type: "scoped-context-response",
    ...result,
  };
}

export async function createUpsertScopedContextResponse(
  store: ScopedContextStore,
  msg: UpsertScopedContextMessage
): Promise<ScopedContextUpsertedMessage> {
  const result = await store.upsert(msg.record);
  return {
    type: "scoped-context-upserted",
    status: result.status,
    record: result.record,
    persisted: result.persisted,
    ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
  };
}

export async function createDeleteScopedContextResponse(
  store: ScopedContextStore,
  msg: DeleteScopedContextMessage
): Promise<ScopedContextDeletedMessage> {
  const result = await store.delete(msg.recordId);
  return {
    type: "scoped-context-deleted",
    status: result.status,
    recordId: result.recordId,
    deleted: result.deleted,
    ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
  };
}

export async function createResolveScopedContextResponse(
  store: ScopedContextStore,
  msg: ResolveScopedContextMessage
): Promise<ScopedContextResolvedMessage> {
  const result = await resolveDaemonScopedContext(store, {
    cwd: msg.cwd,
    ...(msg.workspaceRoot !== undefined ? { workspaceRoot: msg.workspaceRoot } : {}),
    ...(msg.projectRoot !== undefined ? { projectRoot: msg.projectRoot } : {}),
    ...(msg.projectMarkers !== undefined ? { projectMarkers: msg.projectMarkers } : {}),
    ...(msg.projectFiles !== undefined ? { projectFiles: msg.projectFiles } : {}),
    ...(msg.projectTags !== undefined ? { projectTags: msg.projectTags } : {}),
    ...(msg.packageNames !== undefined ? { packageNames: msg.packageNames } : {}),
    scopedContextConfig: {
      ...(msg.scopedContextConfig ?? {}),
      ...(msg.userEnabledIds !== undefined ? { userEnabledIds: msg.userEnabledIds } : {}),
      ...(msg.userDisabledIds !== undefined ? { userDisabledIds: msg.userDisabledIds } : {}),
    } as ScopedContextRuntimeConfig,
  });
  const resolution = result.resolution;

  return {
    type: "scoped-context-resolved",
    status: result.status,
    stableContext: resolution.stableContext,
    recommended: resolution.recommended,
    items: resolution.items,
    diagnostics: resolution.diagnostics,
    stableContextHash: resolution.stableContextHash,
    storeRecordCount: result.storeRecordCount,
    resourceRecordCount: result.resourceRecordCount,
    resourceDiagnostics: result.resourceDiagnostics,
    ...(result.storeDiagnostic ? { storeDiagnostic: result.storeDiagnostic } : {}),
  };
}
