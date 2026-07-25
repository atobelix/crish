/**
 * 会话磁盘镜像类型与常量契约
 */

import type { SessionMessage, SessionState } from '../../store/layoutStore';
import type { SessionIndexEntry } from '../session-persistence/sessionPersistenceTypes';

/** localStorage 元数据键 */
export const MIRROR_META_STORAGE_KEY = 'crish_session_disk_mirror_v1';

/** 磁盘 index.json 契约版本 */
export const MIRROR_INDEX_VERSION = 1 as const;

/** 镜像目录内索引文件名 */
export const MIRROR_INDEX_FILENAME = 'index.json';

/** 会话正文扩展名 */
export const MIRROR_BODY_EXT = '.jsonl';

/** 会话 id 作文件名时最大长度（留余量给扩展名） */
export const MIRROR_SESSION_ID_MAX_LEN = 128;

export type SessionDiskMirrorMeta = {
  lastPath?: string;
  lastAt?: number;
  sessionCount?: number;
  mode?: 'tauri' | 'localStorage-only' | 'unavailable' | undefined;
};

/** 磁盘 index.json 根形状（写读对称契约） */
export type MirrorIndexDocument = {
  version: number;
  activeSessionId: string;
  folderOrder: string[];
  sessions: SessionIndexEntry[];
  writtenAt: string;
};

export type MirrorRestoreResult = {
  sessions: SessionState[];
  activeSessionId: string;
  folderOrder: string[];
};
