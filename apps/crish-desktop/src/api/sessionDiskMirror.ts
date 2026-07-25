/**
 * 会话磁盘镜像（H3门面层）
 *
 * - 主路径仍是 localStorage（sessionPersistence）
 * - 有 Tauri 时尽力写入应用数据目录，防配额炸
 * - 浏览器环境仅写 localStorage，不报错
 *
 * 纯函数层：索引形状守卫、损坏恢复、空列表、路径安全、写读对称。
 * 空会话：恢复时不发明远程壳；无有效条目 → null。
 */

export {
  MIRROR_BODY_EXT,
  MIRROR_INDEX_FILENAME,
  MIRROR_INDEX_VERSION,
  MIRROR_META_STORAGE_KEY,
  MIRROR_SESSION_ID_MAX_LEN,
  type MirrorIndexDocument,
  type MirrorRestoreResult,
  type SessionDiskMirrorMeta,
} from './sessionDiskMirror/mirrorTypes';

export {
  assembleSessionsFromMirrorEntries,
  buildMirrorIndexDocument,
  buildMirrorMeta,
  finalizeMirrorRestore,
  isSafeMirrorSessionId,
  mirrorEntryToSessionShell,
  mirrorIndexFilePath,
  mirrorIndexRoundTrip,
  mirrorSessionBodyFilePath,
  normalizeMirrorBaseDir,
  normalizeMirrorIndexDocument,
  normalizeMirrorIndexEntries,
  normalizeMirrorIndexEntry,
  normalizeMirrorMeta,
  parseMirrorIndexJson,
  parseMirrorMetaJson,
  resolveMirrorActiveSessionId,
  resolveMirrorFolderOrder,
  sanitizeMirrorSessionId,
  serializeMirrorIndexDocument,
} from './sessionDiskMirror/mirrorSanitizer';

export {
  loadMirrorMeta,
  mirrorSessionsToDisk,
  restoreSessionsFromDiskMirror,
} from './sessionDiskMirror/mirrorStorage';
