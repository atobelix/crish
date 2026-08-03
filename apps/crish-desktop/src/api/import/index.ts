/**
 * External conversation import (Claude Code + Codex CLI) — 宿主编排入口。
 * 解析/映射/探测纯函数来自官方插件 @crish/plugin-import-claude-codex（E3 抽包）；
 * 本入口只导出宿主侧消费面（scan / importFsHost / importRootSettings / importSessions 编排）。
 * @see docs/architecture/external-session-import-adr.md
 */

export type {
  DetectedExternalSession,
  ExternalImportRoots,
  ExternalSessionSource,
} from './types';

export {
  externalSourceLabel,
  resolveDefaultImportRoots,
} from '@crish/plugin-import-claude-codex';

export {
  resolveHostImportEnv,
} from './importFsHost';

export {
  scanClaudeCodeSessions,
  scanCodexSessions,
} from './scan';

export {
  getPersistedImportRoots,
  hasCustomImportRoot,
  setPersistedClaudeImportRoot,
  setPersistedCodexImportRoot,
} from './importRootSettings';

export {
  importDetectedSessions,
} from './importSessions';
