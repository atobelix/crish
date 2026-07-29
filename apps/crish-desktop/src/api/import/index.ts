/**
 * External conversation import (Claude Code + Codex CLI).
 * @see docs/architecture/external-session-import-adr.md
 */

export type {
  DetectedExternalSession,
  DetectExternalSessionsOptions,
  DetectExternalSessionsResult,
  ExternalImportRoots,
  ExternalSessionMeta,
  ExternalSessionSource,
  ImportedCrishSession,
  ImportDirEntry,
  ImportDuplicatePolicy,
  ImportFs,
  ImportPathEnv,
  ImportSessionsResult,
  MapToCrishSessionOptions,
  MappedImportSession,
  NormalizedImportTurn,
  ParsedExternalConversation,
} from './types';

export {
  canonicalExternalSource,
  externalSourceLabel,
  makeExternalImportKey,
  metaToDetected,
  toMappedImportSession,
} from './types';

export {
  detectExternalSessions,
  estimateLineCount,
  extractClaudeTitlePreview,
  extractCodexTitlePreview,
  extractJsonStringField,
  extractLastJsonStringField,
  joinImportPath,
  mungeProjectPath,
  resolveDefaultImportRoots,
  truncatePreview,
} from './detectExternalSessions';

export { parseClaudeCodeJsonl } from './parseClaudeCodeJsonl';
export type { ParseClaudeCodeOptions } from './parseClaudeCodeJsonl';

export { parseCodexRolloutJsonl } from './parseCodexRolloutJsonl';
export type { ParseCodexRolloutOptions } from './parseCodexRolloutJsonl';

export {
  folderFromCwd,
  mapToCrishSession,
  pickTitle,
} from './mapToCrishSession';

export {
  allowRootFromSessionPath,
  createMemoryImportFs,
  createTauriImportFs,
  resolveHostImportEnv,
} from './importFsHost';

export {
  getDefaultScanRoots,
  getHostScanRoots,
  scanClaudeCodeSessions,
  scanCodexSessions,
  scanExternalSessions,
} from './scan';
export type { ScanExternalOptions } from './scan';

export {
  getPersistedImportRoots,
  hasCustomImportRoot,
  mergeImportPathEnv,
  setPersistedClaudeImportRoot,
  setPersistedCodexImportRoot,
} from './importRootSettings';
export type { PersistedImportRoots } from './importRootSettings';

export {
  allowRootFor,
  mapExternalRoleToSender,
  mapExternalSession,
  mapExternalSessions,
} from './map';
export type { MapExternalOptions } from './map';

export {
  buildImportMeta,
  collectExistingImportKeys,
  importDetectedSessions,
  writeMappedSession,
} from './importSessions';
export type { ImportSessionsDeps } from './importSessions';

import { mapToCrishSession } from './mapToCrishSession';
import { parseClaudeCodeJsonl } from './parseClaudeCodeJsonl';
import { parseCodexRolloutJsonl } from './parseCodexRolloutJsonl';
import type { ImportedCrishSession, MapToCrishSessionOptions } from './types';

/** Parse Claude Code JSONL → Crish import payload. */
export function importClaudeCodeSession(
  content: string,
  options: MapToCrishSessionOptions & { sourceSessionId?: string },
): ImportedCrishSession {
  const parsed = parseClaudeCodeJsonl(content, {
    sourceSessionId: options.sourceSessionId,
  });
  return mapToCrishSession(parsed, options);
}

/** Parse Codex rollout JSONL → Crish import payload. */
export function importCodexSession(
  content: string,
  options: MapToCrishSessionOptions & { sourceSessionId?: string },
): ImportedCrishSession {
  const parsed = parseCodexRolloutJsonl(content, {
    sourceSessionId: options.sourceSessionId,
  });
  return mapToCrishSession(parsed, options);
}
